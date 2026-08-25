use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail, ensure};
use tempfile::TempDir;
#[cfg(feature = "tools")]
use tokio::io::AsyncWriteExt;
#[cfg(feature = "tools")]
use tokio::runtime::Runtime;
#[cfg(feature = "tools")]
use wasmer_wasix::virtual_net::tcp_pair::TcpSocketHalfRx;
#[cfg(feature = "tools")]
use wasmer_wasix::virtual_net::tcp_pair::TcpSocketHalfTx;

use crate::oliphaunt::backend::BackendSession;
use crate::oliphaunt::base::{DirectoryLock, InstallOutcome};
use crate::oliphaunt::builder::OliphauntBuilder;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
use crate::oliphaunt::data_dir::{
    finish_online_physical_archive, materialize_pgdata, materialize_virtual_pgdata_view,
    refresh_materialized_pg_control, restore_physical_archive,
};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::postgres_mod::{ProtocolPumpOutcome, ProtocolStream};
use crate::oliphaunt::query::{
    CommandResult, QueryParam, QueryResult, extended_query, parse_command_response,
    parse_query_response,
};
use crate::oliphaunt::storage::PgDataStorage;
#[cfg(all(feature = "extensions", test))]
use crate::oliphaunt::storage::StorageRoot;
#[cfg(feature = "tools")]
use crate::oliphaunt::tools::{
    DirectToolSocket, PgDumpOptions, PsqlOptions, is_direct_tool_outcome_unknown,
    run_direct_pg_dump, run_direct_psql,
};
#[cfg(feature = "tools")]
use crate::oliphaunt::wire::{FrontendFrameKind, FrontendFrameReader, classify_frontend_message};

const PROTOCOL_CALLBACK_CHUNK_BYTES: usize = 64 * 1024;
#[cfg(feature = "tools")]
const DIRECT_TOOL_READ_BUFFER_BYTES: usize = 64 * 1024;

/// Direct, single-session Oliphaunt WASIX database.
pub struct Oliphaunt {
    backend: BackendSession,
    _workspace: Option<TempDir>,
    _directory_lock: Option<DirectoryLock>,
    in_transaction: bool,
    transaction_outcome_unknown: bool,
    backup_mode_exit_unconfirmed: bool,
    closing: bool,
    closed: bool,
    protocol_stream: Arc<Mutex<CallbackProtocolState>>,
    protocol_stream_attached: bool,
}

type ProtocolCallback = Box<dyn FnMut(&[u8]) -> crate::Result<()> + Send>;

#[derive(Default)]
struct CallbackProtocolState {
    callback: Option<ProtocolCallback>,
    error: Option<crate::Error>,
    #[cfg(feature = "tools")]
    tool_io: Option<DirectToolProtocolIo>,
}

struct CallbackProtocolStream {
    state: Arc<Mutex<CallbackProtocolState>>,
}

impl Read for CallbackProtocolStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        #[cfg(feature = "tools")]
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| io::Error::other("WASIX protocol callback lock poisoned"))?;
            if let Some(tool_io) = state.tool_io.as_mut() {
                return tool_io.read(buffer);
            }
        }
        let _ = buffer;
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    }
}

impl Write for CallbackProtocolStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("WASIX protocol callback lock poisoned"))?;
        #[cfg(feature = "tools")]
        if let Some(tool_io) = state.tool_io.as_mut() {
            return tool_io.write(buffer);
        }
        let callback = state.callback.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "WASIX protocol callback is not active",
            )
        })?;
        for chunk in buffer.chunks(PROTOCOL_CALLBACK_CHUNK_BYTES) {
            if let Err(error) = callback(chunk) {
                state.error = Some(error);
                return Err(io::Error::other("WASIX protocol callback failed"));
            }
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        #[cfg(feature = "tools")]
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| io::Error::other("WASIX protocol callback lock poisoned"))?;
            if let Some(tool_io) = state.tool_io.as_mut() {
                return tool_io.flush();
            }
        }
        Ok(())
    }
}

impl ProtocolStream for CallbackProtocolStream {
    fn read_ready(&mut self) -> io::Result<bool> {
        #[cfg(feature = "tools")]
        {
            let state = self
                .state
                .lock()
                .map_err(|_| io::Error::other("WASIX protocol callback lock poisoned"))?;
            if state.tool_io.is_some() {
                // The protocol pump exclusively owns the tool connection while COPY
                // is active. As with the Unix socket proxy, reads may block until the
                // frontend supplies its next protocol frame.
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl Oliphaunt {
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
    }

    pub fn open() -> crate::Result<Self> {
        Self::builder().open()
    }

    #[cfg(not(feature = "extensions"))]
    pub(crate) fn new_prepared_with_config(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        Self::new_prepared_with_config_inner(outcome, postgres_config, startup_config)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn new_prepared_with_config_and_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        let backend = if extensions.is_empty() {
            BackendSession::open(outcome, postgres_config, startup_config.clone())?
        } else {
            BackendSession::open_with_extension_preload(
                outcome,
                postgres_config,
                startup_config.clone(),
                extensions,
            )?
        };
        Self::finish_open(backend, startup_config)
    }

    #[cfg(not(feature = "extensions"))]
    fn new_prepared_with_config_inner(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        let backend = BackendSession::open(outcome, postgres_config, startup_config.clone())?;
        Self::finish_open(backend, startup_config)
    }

    fn finish_open(backend: BackendSession, startup_config: StartupConfig) -> Result<Self> {
        let mut instance = Self {
            backend,
            _workspace: None,
            _directory_lock: None,
            in_transaction: false,
            transaction_outcome_unknown: false,
            backup_mode_exit_unconfirmed: false,
            closing: false,
            closed: false,
            protocol_stream: Arc::new(Mutex::new(CallbackProtocolState::default())),
            protocol_stream_attached: false,
        };
        if startup_config.username != "postgres" {
            let sql = format!(
                "SET ROLE {}",
                crate::oliphaunt::sql::quote_identifier(&startup_config.username)
            );
            instance.execute_inner(&sql)?;
        }
        Ok(instance)
    }

    /// Restore a validated physical backup into an absent or empty managed directory root.
    pub fn restore(destination: impl Into<PathBuf>, backup: impl AsRef<[u8]>) -> crate::Result<()> {
        crate::error::public_result(restore_physical_archive(
            &destination.into(),
            backup.as_ref(),
        ))
    }

    /// Execute a PostgreSQL command. Row-producing SQL must use [`Self::query`].
    pub fn execute(&mut self, sql: &str) -> crate::Result<CommandResult> {
        crate::error::public_result(self.execute_inner(sql))
    }

    fn execute_inner(&mut self, sql: &str) -> Result<CommandResult> {
        self.execute_with_params_inner(sql, std::iter::empty::<QueryParam>())
    }

    /// Execute a PostgreSQL command with positional parameters.
    pub fn execute_with_params<I, P>(
        &mut self,
        sql: &str,
        params: I,
    ) -> crate::Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        crate::error::public_result(self.execute_with_params_inner(sql, params))
    }

    fn execute_with_params_inner<I, P>(&mut self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let response = self.run_query(sql, params)?;
        parse_command_response(&response)
    }

    /// Execute SQL and parse its single row-producing result set.
    pub fn query(&mut self, sql: &str) -> crate::Result<QueryResult> {
        crate::error::public_result(self.query_inner(sql))
    }

    fn query_inner(&mut self, sql: &str) -> Result<QueryResult> {
        self.query_with_params_inner(sql, std::iter::empty::<QueryParam>())
    }

    /// Execute row-producing SQL with positional parameters.
    pub fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> crate::Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        crate::error::public_result(self.query_with_params_inner(sql, params))
    }

    fn query_with_params_inner<I, P>(&mut self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let response = self.run_query(sql, params)?;
        parse_query_response(&response)
    }

    fn run_query<I, P>(&mut self, sql: &str, params: I) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        self.check_ready()?;
        let params = params.into_iter().map(Into::into).collect::<Vec<_>>();
        let request = extended_query(sql, &params)?;
        self.backend.send_buffered(&request)
    }

    /// Execute raw PostgreSQL frontend-protocol bytes.
    pub fn exec_protocol_raw(&mut self, request: impl AsRef<[u8]>) -> crate::Result<Vec<u8>> {
        crate::error::public_result(self.exec_protocol_raw_inner(request.as_ref()))
    }

    fn exec_protocol_raw_inner(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        self.check_ready()?;
        self.backend.send_buffered(request)
    }

    /// Execute raw PostgreSQL protocol bytes and deliver response chunks as they arrive.
    pub fn exec_protocol_stream<F>(
        &mut self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> crate::Result<()>
    where
        F: FnMut(&[u8]) -> crate::Result<()> + Send + 'static,
    {
        crate::error::public_result(self.exec_protocol_stream_inner(request.as_ref(), on_chunk))
    }

    fn exec_protocol_stream_inner<F>(&mut self, request: &[u8], on_chunk: F) -> Result<()>
    where
        F: FnMut(&[u8]) -> crate::Result<()> + Send + 'static,
    {
        self.check_ready()?;
        self.ensure_protocol_stream_attached()?;
        {
            let mut state = self
                .protocol_stream
                .lock()
                .map_err(|_| anyhow::anyhow!("WASIX protocol callback lock poisoned"))?;
            ensure!(
                state.callback.is_none(),
                "WASIX protocol callback is already active"
            );
            state.callback = Some(Box::new(on_chunk));
            state.error = None;
        }
        let outcome = self.backend.send_with_protocol_pump(request);
        let (callback_error, callback) = {
            let mut state = self
                .protocol_stream
                .lock()
                .map_err(|_| anyhow::anyhow!("WASIX protocol callback lock poisoned"))?;
            (state.error.take(), state.callback.take())
        };
        if let Some(error) = callback_error {
            return Err(anyhow::Error::new(error));
        }
        let mut callback = callback.context("WASIX protocol callback disappeared")?;
        match outcome? {
            ProtocolPumpOutcome::Buffered(response) => {
                for chunk in response.chunks(PROTOCOL_CALLBACK_CHUNK_BYTES) {
                    callback(chunk).map_err(anyhow::Error::new)?;
                }
            }
            ProtocolPumpOutcome::Streamed => {}
        }
        Ok(())
    }

    fn ensure_protocol_stream_attached(&mut self) -> Result<()> {
        if !self.protocol_stream_attached {
            self.backend
                .attach_protocol_stream(CallbackProtocolStream {
                    state: Arc::clone(&self.protocol_stream),
                })?;
            self.protocol_stream_attached = true;
        }
        Ok(())
    }

    #[cfg(feature = "tools")]
    pub(crate) fn run_pg_dump_tool(&mut self, options: PgDumpOptions) -> Result<String> {
        options.validate()?;
        self.prepare_tool_session()?;
        let startup = self.backend.startup_config().clone();
        let result = run_direct_pg_dump(&startup.username, &startup.database, &options, |socket| {
            self.serve_direct_tool_protocol(socket)
        });
        self.finish_tool_session(result)
    }

    #[cfg(feature = "tools")]
    pub(crate) fn run_psql_tool(&mut self, options: PsqlOptions) -> Result<String> {
        options.validate()?;
        self.prepare_tool_session()?;
        let startup = self.backend.startup_config().clone();
        let result = run_direct_psql(&startup.username, &startup.database, &options, |socket| {
            self.serve_direct_tool_protocol(socket)
        });
        self.finish_tool_session(result)
    }

    #[cfg(feature = "tools")]
    fn prepare_tool_session(&mut self) -> Result<()> {
        self.check_ready()?;
        ensure!(
            !self.in_transaction,
            "WASIX tools cannot run while a callback transaction is active"
        );
        self.reset_tool_session()
            .context("prepare embedded session for WASIX tool")
    }

    #[cfg(feature = "tools")]
    fn finish_tool_session(&mut self, result: Result<String>) -> Result<String> {
        let outcome_unknown = result
            .as_ref()
            .err()
            .is_some_and(is_direct_tool_outcome_unknown);
        let cleanup = self.reset_tool_session();
        match (result, cleanup) {
            (Ok(output), Ok(())) => Ok(output),
            (Err(error), Ok(())) => {
                self.transaction_outcome_unknown |= outcome_unknown;
                Err(error)
            }
            (Ok(_), Err(error)) => {
                self.transaction_outcome_unknown = true;
                Err(error.context("reset embedded session after WASIX tool"))
            }
            (Err(error), Err(cleanup)) => {
                self.transaction_outcome_unknown = true;
                Err(error.context(format!(
                    "embedded session cleanup also failed after WASIX tool: {cleanup:#}"
                )))
            }
        }
    }

    #[cfg(feature = "tools")]
    fn reset_tool_session(&mut self) -> Result<()> {
        self.execute_inner("ROLLBACK")
            .context("roll back embedded session")?;
        self.execute_inner("DISCARD ALL")
            .context("discard embedded session state")?;
        let username = self.backend.startup_config().username.clone();
        if username != "postgres" {
            self.execute_inner(&format!(
                "SET ROLE {}",
                crate::oliphaunt::sql::quote_identifier(&username)
            ))
            .context("restore embedded session role")?;
        }
        Ok(())
    }

    #[cfg(feature = "tools")]
    fn serve_direct_tool_protocol(&mut self, socket: DirectToolSocket) -> Result<()> {
        self.ensure_protocol_stream_attached()?;
        {
            let mut state = self
                .protocol_stream
                .lock()
                .map_err(|_| anyhow::anyhow!("WASIX protocol callback lock poisoned"))?;
            ensure!(
                state.callback.is_none(),
                "WASIX protocol callback is active"
            );
            ensure!(
                state.tool_io.is_none(),
                "WASIX tool protocol is already active"
            );
            state.tool_io = Some(DirectToolProtocolIo::new(socket)?);
        }
        let result = self.serve_direct_tool_protocol_inner();
        let cleanup = self
            .protocol_stream
            .lock()
            .map_err(|_| anyhow::anyhow!("WASIX protocol callback lock poisoned"))
            .map(|mut state| {
                state.tool_io.take();
            });
        result.and(cleanup)
    }

    #[cfg(feature = "tools")]
    fn serve_direct_tool_protocol_inner(&mut self) -> Result<()> {
        let mut reader = FrontendFrameReader::default();
        let mut buffer = [0u8; DIRECT_TOOL_READ_BUFFER_BYTES];
        loop {
            let read = self.with_direct_tool_io(|tool_io| tool_io.read(&mut buffer))?;
            if read == 0 {
                return finish_direct_tool_frontend(&reader);
            }
            reader.append(&buffer[..read]);
            while let Some(message) = reader.next_frame()? {
                match classify_frontend_message(&message)? {
                    FrontendFrameKind::SslOrGssRequest => {
                        self.write_direct_tool_protocol(b"N")?;
                    }
                    FrontendFrameKind::CancelRequest | FrontendFrameKind::Terminate => {
                        return Ok(());
                    }
                    FrontendFrameKind::Startup => {
                        let response =
                            self.backend.existing_startup_response().ok_or_else(|| {
                                anyhow::anyhow!(
                                    "embedded WASIX protocol startup response is unavailable"
                                )
                            })?;
                        self.write_direct_tool_protocol(&response)?;
                    }
                    FrontendFrameKind::Protocol => {
                        match self.backend.send_with_protocol_pump(&message)? {
                            ProtocolPumpOutcome::Buffered(response) => {
                                self.write_direct_tool_protocol(&response)?;
                            }
                            ProtocolPumpOutcome::Streamed => {}
                        }
                    }
                }
            }
            self.with_direct_tool_io(Write::flush)?;
        }
    }

    #[cfg(feature = "tools")]
    fn write_direct_tool_protocol(&self, bytes: &[u8]) -> Result<()> {
        self.with_direct_tool_io(|tool_io| tool_io.write_all(bytes))
    }

    #[cfg(feature = "tools")]
    fn with_direct_tool_io<T>(
        &self,
        operation: impl FnOnce(&mut DirectToolProtocolIo) -> io::Result<T>,
    ) -> Result<T> {
        let mut state = self
            .protocol_stream
            .lock()
            .map_err(|_| anyhow::anyhow!("WASIX protocol callback lock poisoned"))?;
        operation(
            state
                .tool_io
                .as_mut()
                .context("WASIX tool protocol is not active")?,
        )
        .context("access direct WASIX tool protocol socket")
    }

    /// Force a PostgreSQL checkpoint.
    pub fn checkpoint(&mut self) -> crate::Result<()> {
        crate::error::public_result(self.execute_inner("CHECKPOINT").map(|_| ()))
    }

    /// Create a session-preserving PostgreSQL online physical backup.
    pub fn backup(&mut self) -> crate::Result<Vec<u8>> {
        crate::error::public_result(self.backup_inner())
    }

    fn backup_inner(&mut self) -> Result<Vec<u8>> {
        self.check_ready()?;
        ensure!(
            !self.in_transaction,
            "physical backup cannot run while a transaction is active"
        );
        let start_attempt = self.start_backup();
        let (start_wal, wal_segment_size) =
            resolve_start_backup_attempt(start_attempt, |error| self.cleanup_failed_backup(error))?;

        let storage = self.backend.pgdata_storage().clone();
        let before_stop = match materialize_storage(&storage).and_then(|snapshot| {
            refresh_materialized_pg_control(&storage, snapshot.path())?;
            Ok(snapshot)
        }) {
            Ok(snapshot) => snapshot,
            Err(error) => return Err(self.cleanup_failed_backup(error)),
        };
        let (stop_wal, backup_label, tablespace_map) = match self.stop_backup() {
            StopBackupAttempt::Exited(Ok(files)) => files,
            StopBackupAttempt::Exited(Err(error)) => return Err(error),
            StopBackupAttempt::ExitUnconfirmed(primary) => {
                return Err(self.cleanup_failed_backup(primary));
            }
        };
        finish_online_physical_archive(
            before_stop,
            &storage,
            &start_wal,
            &stop_wal,
            wal_segment_size,
            &backup_label,
            tablespace_map.as_deref(),
        )
    }

    fn start_backup(&mut self) -> StartBackupAttempt {
        let response = match self.run_query(
            "SELECT pg_walfile_name(pg_backup_start(label => 'oliphaunt physical backup', fast => true)), pg_size_bytes(current_setting('wal_segment_size'))::text",
            std::iter::empty::<QueryParam>(),
        ) {
            Ok(response) => response,
            Err(error) => return StartBackupAttempt::ExitUnconfirmed(error),
        };
        parse_start_backup_response(&response)
    }

    fn stop_backup(&mut self) -> StopBackupAttempt {
        let response = match self.run_query(
            "SELECT pg_walfile_name(lsn), labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)",
            std::iter::empty::<QueryParam>(),
        ) {
            Ok(response) => response,
            Err(error) => return StopBackupAttempt::ExitUnconfirmed(error),
        };
        parse_stop_backup_response(&response)
    }

    fn cleanup_failed_backup(&mut self, primary: anyhow::Error) -> anyhow::Error {
        let (error, exit_unconfirmed) = resolve_backup_cleanup(primary, self.stop_backup());
        if exit_unconfirmed {
            self.backup_mode_exit_unconfirmed = true;
        }
        error
    }

    /// Run a callback inside a transaction pinned to this direct session.
    pub fn transaction<F, T>(&mut self, callback: F) -> crate::Result<T>
    where
        F: FnOnce(&mut Transaction<'_>) -> crate::Result<T>,
    {
        crate::error::public_result(self.check_ready())?;
        if self.in_transaction {
            return Err(crate::Error::message("a transaction is already active"));
        }
        let begin = match self.execute("BEGIN") {
            Ok(begin) => begin,
            Err(error) => {
                if error.postgres_error().is_none() {
                    self.transaction_outcome_unknown = true;
                }
                return Err(error);
            }
        };
        match begin.command_tag() {
            Some("BEGIN") => {}
            Some("ROLLBACK") => {
                return Err(crate::Error::message(
                    "PostgreSQL rolled back instead of beginning the transaction",
                ));
            }
            command_tag => {
                self.transaction_outcome_unknown = true;
                return Err(crate::Error::message(format!(
                    "transaction begin returned PostgreSQL command tag {command_tag:?}"
                )));
            }
        }
        self.in_transaction = true;
        let mut transaction = Transaction {
            client: self,
            closed: false,
        };
        let result = callback(&mut transaction)
            .and_then(|value| transaction.commit_internal().map(|()| value));
        let result = match result {
            Ok(value) => Ok(value),
            Err(error) if transaction.closed => Err(error),
            Err(error) => match transaction.rollback_internal() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "transaction rollback also failed: {rollback_error:#}"
                ))),
            },
        };
        self.in_transaction = false;
        result
    }

    pub fn close(&mut self) -> crate::Result<()> {
        crate::error::public_result(self.close_inner())
    }

    fn close_inner(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        ensure!(!self.closing, "Oliphaunt is closing");
        ensure!(
            !self.in_transaction,
            "cannot close while a transaction is active"
        );
        self.closing = true;
        let result = self.backend.shutdown();
        self.closing = false;
        if result.is_ok() {
            self.closed = true;
            self._directory_lock = None;
            self._workspace = None;
        }
        result
    }

    pub(crate) fn attach_workspace(&mut self, workspace: TempDir) {
        self._workspace = Some(workspace);
    }

    pub(crate) fn attach_directory_lock(&mut self, directory_lock: DirectoryLock) {
        self._directory_lock = Some(directory_lock);
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn enable_startup_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        self.backend.enable_extensions(extensions)
    }

    #[cfg(all(feature = "extensions", test))]
    pub(crate) fn runtime_storage(&self) -> &StorageRoot {
        self.backend.runtime_storage()
    }

    fn check_ready(&self) -> Result<()> {
        if self.closing {
            bail!("Oliphaunt is closing");
        }
        if self.closed {
            bail!("Oliphaunt is closed");
        }
        if self.transaction_outcome_unknown {
            bail!("Oliphaunt transaction outcome is unknown; close and reopen it");
        }
        if self.backup_mode_exit_unconfirmed {
            bail!("Oliphaunt backup-mode exit is unconfirmed; close and reopen it");
        }
        Ok(())
    }
}

#[cfg(feature = "tools")]
fn finish_direct_tool_frontend(reader: &FrontendFrameReader) -> Result<()> {
    ensure!(
        reader.pending().is_empty(),
        "direct WASIX tool protocol connection ended inside a frontend message"
    );
    Ok(())
}

enum StartBackupAttempt {
    NotEntered(anyhow::Error),
    Entered(Result<(String, u64)>),
    ExitUnconfirmed(anyhow::Error),
}

enum StopBackupAttempt {
    Exited(Result<(String, String, Option<String>)>),
    ExitUnconfirmed(anyhow::Error),
}

fn resolve_start_backup_attempt(
    attempt: StartBackupAttempt,
    cleanup: impl FnOnce(anyhow::Error) -> anyhow::Error,
) -> Result<(String, u64)> {
    match attempt {
        StartBackupAttempt::NotEntered(error) => Err(error),
        StartBackupAttempt::Entered(Ok(start)) => Ok(start),
        StartBackupAttempt::Entered(Err(error)) => Err(cleanup(error)),
        StartBackupAttempt::ExitUnconfirmed(error) => {
            let message = format!(
                "pg_backup_start outcome is unconfirmed; attempting emergency pg_backup_stop: {error:#}"
            );
            Err(cleanup(error.context(message)))
        }
    }
}

fn parse_start_backup_response(response: &[u8]) -> StartBackupAttempt {
    let result = match parse_query_response(response) {
        Ok(result) => result,
        Err(error) if error.downcast_ref::<crate::PostgresError>().is_some() => {
            return StartBackupAttempt::NotEntered(error);
        }
        Err(error) => return StartBackupAttempt::Entered(Err(error)),
    };
    StartBackupAttempt::Entered(parse_start_backup_result(&result))
}

fn parse_start_backup_result(result: &QueryResult) -> Result<(String, u64)> {
    ensure!(
        result.command_tag() == Some("SELECT 1"),
        "pg_backup_start did not return a successful PostgreSQL command tag"
    );
    ensure!(
        result.rows().len() == 1 && result.rows()[0].values().len() == 2,
        "pg_backup_start returned an unexpected result"
    );
    let start_wal = result.rows()[0]
        .text_inner(0)?
        .context("pg_backup_start returned no WAL filename")?
        .to_owned();
    let wal_segment_size = result.rows()[0]
        .text_inner(1)?
        .context("pg_backup_start returned no WAL segment size")?
        .parse::<u64>()
        .context("pg_backup_start returned an invalid WAL segment size")?;
    Ok((start_wal, wal_segment_size))
}

fn parse_stop_backup_response(response: &[u8]) -> StopBackupAttempt {
    let exit_confirmed = response_confirms_command_completion(response);
    let result = match parse_query_response(response) {
        Ok(result) => result,
        Err(error) if exit_confirmed && error.downcast_ref::<crate::PostgresError>().is_none() => {
            return StopBackupAttempt::Exited(Err(error));
        }
        Err(error) => return StopBackupAttempt::ExitUnconfirmed(error),
    };
    if !exit_confirmed {
        return StopBackupAttempt::ExitUnconfirmed(anyhow::anyhow!(
            "pg_backup_stop did not return a successful PostgreSQL command completion"
        ));
    }
    StopBackupAttempt::Exited(parse_stop_backup_result(&result))
}

fn response_confirms_command_completion(response: &[u8]) -> bool {
    let mut offset = 0;
    let mut saw_command_complete = false;
    while offset < response.len() {
        let Some(header) = response.get(offset..offset.saturating_add(5)) else {
            return false;
        };
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let Some(frame_length) = length.checked_add(1) else {
            return false;
        };
        let Some(next) = offset.checked_add(frame_length) else {
            return false;
        };
        if length < 4 || next > response.len() || header[0] == b'E' {
            return false;
        }
        if header[0] == b'C' {
            saw_command_complete = true;
        }
        if header[0] == b'Z' {
            return saw_command_complete
                && length == 5
                && next == response.len()
                && matches!(response.get(offset + 5), Some(b'I' | b'T' | b'E'));
        }
        offset = next;
    }
    false
}

fn parse_stop_backup_result(result: &QueryResult) -> Result<(String, String, Option<String>)> {
    ensure!(
        result.command_tag() == Some("SELECT 1"),
        "pg_backup_stop returned an unexpected PostgreSQL command tag"
    );
    ensure!(
        result.rows().len() == 1 && result.rows()[0].values().len() == 3,
        "pg_backup_stop returned an unexpected result"
    );
    let row = &result.rows()[0];
    let stop_wal = row
        .text_inner(0)?
        .context("pg_backup_stop returned no WAL filename")?
        .to_owned();
    let label = row
        .text_inner(1)?
        .filter(|value| !value.is_empty())
        .context("pg_backup_stop returned an empty backup label")?
        .to_owned();
    let tablespace_map = row.text_inner(2)?.map(str::to_owned);
    Ok((stop_wal, label, tablespace_map))
}

fn resolve_backup_cleanup(
    primary: anyhow::Error,
    cleanup: StopBackupAttempt,
) -> (anyhow::Error, bool) {
    match cleanup {
        StopBackupAttempt::Exited(Ok(_)) => (primary, false),
        StopBackupAttempt::Exited(Err(cleanup)) => (
            combine_backup_failures(
                primary,
                "PostgreSQL left backup mode but cleanup validation also failed",
                cleanup,
            ),
            false,
        ),
        StopBackupAttempt::ExitUnconfirmed(cleanup) => (
            combine_backup_failures(
                primary,
                "PostgreSQL could not confirm leaving backup mode cleanly",
                cleanup,
            ),
            true,
        ),
    }
}

fn combine_backup_failures(
    primary: anyhow::Error,
    cleanup_label: &str,
    cleanup: anyhow::Error,
) -> anyhow::Error {
    primary.context(format!("{cleanup_label}: {cleanup:#}"))
}

#[cfg(feature = "tools")]
struct DirectToolProtocolIo {
    runtime: Runtime,
    writer: TcpSocketHalfTx,
    reader: TcpSocketHalfRx,
}

#[cfg(feature = "tools")]
impl DirectToolProtocolIo {
    fn new(socket: DirectToolSocket) -> Result<Self> {
        let (writer, reader) = socket.split();
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .context("create direct WASIX tool socket runtime")?,
            writer,
            reader,
        })
    }
}

#[cfg(feature = "tools")]
impl Read for DirectToolProtocolIo {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.runtime.block_on(async {
            std::future::poll_fn(|context| {
                let read = match self.reader.poll_fill_buf(context) {
                    std::task::Poll::Ready(Ok(available)) => {
                        let read = available.len().min(buffer.len());
                        buffer[..read].copy_from_slice(&available[..read]);
                        read
                    }
                    std::task::Poll::Ready(Err(error)) => {
                        return std::task::Poll::Ready(Err(error));
                    }
                    std::task::Poll::Pending => return std::task::Poll::Pending,
                };
                self.reader.consume(read);
                std::task::Poll::Ready(Ok(read))
            })
            .await
        })
    }
}

#[cfg(feature = "tools")]
impl Write for DirectToolProtocolIo {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.runtime.block_on(self.writer.write_all(bytes))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.runtime.block_on(self.writer.flush())
    }
}

impl Drop for Oliphaunt {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.backend.shutdown();
            self.closed = true;
        }
    }
}

/// Callback-scoped transaction on the direct PostgreSQL session.
pub struct Transaction<'a> {
    client: &'a mut Oliphaunt,
    closed: bool,
}

impl Transaction<'_> {
    pub fn execute(&mut self, sql: &str) -> crate::Result<CommandResult> {
        crate::error::public_result(self.ensure_open())?;
        self.client.execute(sql)
    }

    pub fn execute_with_params<I, P>(
        &mut self,
        sql: &str,
        params: I,
    ) -> crate::Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        crate::error::public_result(self.ensure_open())?;
        self.client.execute_with_params(sql, params)
    }

    pub fn query(&mut self, sql: &str) -> crate::Result<QueryResult> {
        crate::error::public_result(self.ensure_open())?;
        self.client.query(sql)
    }

    pub fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> crate::Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        crate::error::public_result(self.ensure_open())?;
        self.client.query_with_params(sql, params)
    }

    pub fn exec_protocol_raw(&mut self, request: impl AsRef<[u8]>) -> crate::Result<Vec<u8>> {
        crate::error::public_result(self.ensure_open())?;
        self.client.exec_protocol_raw(request)
    }

    pub fn exec_protocol_stream<F>(
        &mut self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> crate::Result<()>
    where
        F: FnMut(&[u8]) -> crate::Result<()> + Send + 'static,
    {
        crate::error::public_result(self.ensure_open())?;
        self.client.exec_protocol_stream(request, on_chunk)
    }

    fn commit_internal(&mut self) -> crate::Result<()> {
        crate::error::public_result(self.ensure_open())?;
        // Once COMMIT is sent, retrying with ROLLBACK can neither undo a
        // completed commit nor clarify a lost response. Seal the handle first.
        self.closed = true;
        let result = match self.client.execute("COMMIT") {
            Ok(result) => result,
            Err(error) => {
                if error.postgres_error().is_none() {
                    self.client.transaction_outcome_unknown = true;
                }
                return Err(error);
            }
        };
        match result.command_tag() {
            Some("COMMIT") => Ok(()),
            Some("ROLLBACK") => Err(crate::Error::message(
                "PostgreSQL rolled back the transaction instead of committing",
            )),
            command_tag => {
                self.client.transaction_outcome_unknown = true;
                Err(crate::Error::message(format!(
                    "transaction commit returned PostgreSQL command tag {command_tag:?}"
                )))
            }
        }
    }

    fn rollback_internal(&mut self) -> crate::Result<()> {
        crate::error::public_result(self.ensure_open())?;
        let result = match self.client.execute("ROLLBACK") {
            Ok(result) => result,
            Err(error) => {
                self.client.transaction_outcome_unknown = true;
                return Err(error);
            }
        };
        if result.command_tag() != Some("ROLLBACK") {
            self.client.transaction_outcome_unknown = true;
            return Err(crate::Error::message(format!(
                "transaction rollback returned PostgreSQL command tag {:?}",
                result.command_tag()
            )));
        }
        self.closed = true;
        Ok(())
    }

    fn ensure_open(&self) -> Result<()> {
        ensure!(!self.closed, "transaction is no longer active");
        Ok(())
    }
}

fn materialize_storage(storage: &PgDataStorage) -> Result<tempfile::TempDir> {
    match storage {
        PgDataStorage::HostDirectory(pgdata) => materialize_pgdata(pgdata),
        PgDataStorage::Memory(filesystem) => materialize_virtual_pgdata_view(filesystem.as_ref()),
    }
}

#[cfg(all(test, feature = "tools"))]
mod direct_tool_protocol_tests {
    use super::*;

    #[test]
    fn eof_rejects_incomplete_frontend_message() {
        let mut reader = FrontendFrameReader::default();
        assert!(finish_direct_tool_frontend(&reader).is_ok());

        reader.append(b"Q\0\0");
        let error = finish_direct_tool_frontend(&reader)
            .expect_err("EOF inside a frontend message must fail the protocol connection");
        assert!(
            error
                .to_string()
                .contains("ended inside a frontend message")
        );
    }
}

#[cfg(test)]
mod backup_state_tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn start_sql_failure_never_enters_backup_mode() {
        match parse_start_backup_response(&query_error("55000", "backup unavailable")) {
            StartBackupAttempt::NotEntered(error) => {
                let postgres = error
                    .downcast_ref::<crate::PostgresError>()
                    .expect("PostgreSQL error identity");
                assert_eq!(postgres.sqlstate.as_deref(), Some("55000"));
            }
            _ => panic!("PostgreSQL start failure must not enter backup mode"),
        }
    }

    #[test]
    fn start_metadata_failure_requires_cleanup() {
        match parse_start_backup_response(&query_response(&[Some("wal-only")])) {
            StartBackupAttempt::Entered(Err(error)) => {
                assert!(error.to_string().contains("unexpected result"));
            }
            _ => panic!("local start validation failure must require cleanup"),
        }
    }

    #[test]
    fn start_without_command_completion_requires_cleanup() {
        match parse_start_backup_response(&without_command_complete(query_response(&[
            Some("wal"),
            Some("1048576"),
        ]))) {
            StartBackupAttempt::Entered(Err(error)) => {
                assert!(
                    error
                        .to_string()
                        .contains("successful PostgreSQL command tag")
                );
            }
            _ => panic!("unconfirmed start completion must require cleanup"),
        }
    }

    #[test]
    fn unconfirmed_start_exchange_runs_emergency_stop_before_poisoning() {
        let cleanup_calls = Cell::new(0);
        let exit_unconfirmed = Cell::new(true);
        let error = resolve_start_backup_attempt(
            StartBackupAttempt::ExitUnconfirmed(anyhow::anyhow!("start transport failed")),
            |primary| {
                cleanup_calls.set(cleanup_calls.get() + 1);
                let (error, poison) = resolve_backup_cleanup(
                    primary,
                    StopBackupAttempt::Exited(Ok(("wal".into(), "label".into(), None))),
                );
                exit_unconfirmed.set(poison);
                error
            },
        )
        .expect_err("unconfirmed start exchange must fail the backup");
        assert_eq!(cleanup_calls.get(), 1);
        assert!(format!("{error:#}").contains("start transport failed"));
        assert!(
            !exit_unconfirmed.get(),
            "confirmed emergency stop must keep the session reusable"
        );
    }

    #[test]
    fn stop_metadata_failure_still_confirms_exit() {
        match parse_stop_backup_response(&query_response(&[Some("wal-only")])) {
            StopBackupAttempt::Exited(Err(error)) => {
                assert!(error.to_string().contains("unexpected result"));
            }
            _ => panic!("successful stop SQL must confirm exit before local validation"),
        }
    }

    #[test]
    fn malformed_stop_metadata_after_ready_still_confirms_exit() {
        let mut response = query_response(&[Some("wal"), Some("label"), None]);
        let mut offset = 0;
        while offset < response.len() {
            let length = u32::from_be_bytes(
                response[offset + 1..offset + 5]
                    .try_into()
                    .expect("message length"),
            ) as usize;
            if response[offset] == b'D' {
                response[offset + 5..offset + 7].copy_from_slice(&2_i16.to_be_bytes());
                break;
            }
            offset += length + 1;
        }
        match parse_stop_backup_response(&response) {
            StopBackupAttempt::Exited(Err(error)) => {
                assert!(error.to_string().contains("DataRow"));
            }
            _ => panic!("completed stop response must confirm exit before metadata parsing"),
        }
    }

    #[test]
    fn unexpected_stop_command_tag_still_confirms_exit() {
        match parse_stop_backup_response(&query_response_with_tag(
            &[Some("wal"), Some("label"), None],
            "SELECT 0",
        )) {
            StopBackupAttempt::Exited(Err(error)) => {
                assert!(
                    error
                        .to_string()
                        .contains("unexpected PostgreSQL command tag")
                );
            }
            _ => panic!("completed stop command must confirm exit before tag validation"),
        }
    }

    #[test]
    fn stop_without_command_completion_does_not_confirm_exit() {
        match parse_stop_backup_response(&without_command_complete(query_response(&[
            Some("wal"),
            Some("label"),
            None,
        ]))) {
            StopBackupAttempt::ExitUnconfirmed(error) => {
                assert!(
                    error
                        .to_string()
                        .contains("successful PostgreSQL command completion")
                );
            }
            _ => panic!("missing stop command completion must remain unconfirmed"),
        }
    }

    #[test]
    fn confirmed_cleanup_preserves_primary_failure_without_poisoning() {
        let (error, exit_unconfirmed) = resolve_backup_cleanup(
            anyhow::anyhow!("archive failed"),
            StopBackupAttempt::Exited(Ok(("wal".into(), "label".into(), None))),
        );
        assert_eq!(error.to_string(), "archive failed");
        assert!(
            !exit_unconfirmed,
            "confirmed cleanup must keep the handle reusable"
        );

        let (error, exit_unconfirmed) = resolve_backup_cleanup(
            anyhow::anyhow!("first stop failed"),
            StopBackupAttempt::Exited(Ok(("wal".into(), "label".into(), None))),
        );
        assert_eq!(error.to_string(), "first stop failed");
        assert!(
            !exit_unconfirmed,
            "successful emergency stop must keep the handle reusable"
        );
    }

    #[test]
    fn cleanup_validation_reports_both_failures_without_poisoning() {
        let (error, exit_unconfirmed) = resolve_backup_cleanup(
            anyhow::anyhow!("archive failed"),
            StopBackupAttempt::Exited(Err(anyhow::anyhow!("stop metadata invalid"))),
        );
        let message = format!("{error:#}");
        assert!(message.contains("archive failed"));
        assert!(message.contains("stop metadata invalid"));
        assert!(!exit_unconfirmed);
    }

    #[test]
    fn unconfirmed_cleanup_reports_both_failures_and_poisons() {
        let (error, exit_unconfirmed) = resolve_backup_cleanup(
            anyhow::anyhow!("first stop failed"),
            StopBackupAttempt::ExitUnconfirmed(anyhow::anyhow!("emergency stop failed")),
        );
        let message = format!("{error:#}");
        assert!(message.contains("first stop failed"));
        assert!(message.contains("emergency stop failed"));
        assert!(exit_unconfirmed, "unconfirmed exit must poison the handle");
    }

    #[test]
    fn combined_cleanup_failure_preserves_primary_postgres_identity() {
        let primary = parse_query_response(&query_error("55000", "first stop failed"))
            .expect_err("PostgreSQL error response");
        let (error, _) = resolve_backup_cleanup(
            primary,
            StopBackupAttempt::ExitUnconfirmed(anyhow::anyhow!("emergency stop failed")),
        );
        assert_eq!(
            error
                .downcast_ref::<crate::PostgresError>()
                .and_then(|error| error.sqlstate.as_deref()),
            Some("55000")
        );
        assert_eq!(format!("{error:#}").matches("first stop failed").count(), 1);
    }

    fn query_response(values: &[Option<&str>]) -> Vec<u8> {
        query_response_with_tag(values, "SELECT 1")
    }

    fn query_response_with_tag(values: &[Option<&str>], command_tag: &str) -> Vec<u8> {
        let mut description = Vec::new();
        description.extend_from_slice(&(values.len() as i16).to_be_bytes());
        for _ in values {
            description.push(0);
            description.extend_from_slice(&0_u32.to_be_bytes());
            description.extend_from_slice(&0_i16.to_be_bytes());
            description.extend_from_slice(&25_u32.to_be_bytes());
            description.extend_from_slice(&(-1_i16).to_be_bytes());
            description.extend_from_slice(&(-1_i32).to_be_bytes());
            description.extend_from_slice(&0_i16.to_be_bytes());
        }

        let mut row = Vec::new();
        row.extend_from_slice(&(values.len() as i16).to_be_bytes());
        for value in values {
            match value {
                Some(value) => {
                    row.extend_from_slice(&(value.len() as i32).to_be_bytes());
                    row.extend_from_slice(value.as_bytes());
                }
                None => row.extend_from_slice(&(-1_i32).to_be_bytes()),
            }
        }

        let mut response = backend_message(b'T', &description);
        response.extend(backend_message(b'D', &row));
        let mut command = command_tag.as_bytes().to_vec();
        command.push(0);
        response.extend(backend_message(b'C', &command));
        response.extend(backend_message(b'Z', b"I"));
        response
    }

    fn query_error(sqlstate: &str, message: &str) -> Vec<u8> {
        let mut body = Vec::new();
        for (code, value) in [(b'S', "ERROR"), (b'C', sqlstate), (b'M', message)] {
            body.push(code);
            body.extend_from_slice(value.as_bytes());
            body.push(0);
        }
        body.push(0);
        let mut response = backend_message(b'E', &body);
        response.extend(backend_message(b'Z', b"I"));
        response
    }

    fn backend_message(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut message = Vec::with_capacity(body.len() + 5);
        message.push(tag);
        message.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
        message.extend_from_slice(body);
        message
    }

    fn without_command_complete(response: Vec<u8>) -> Vec<u8> {
        let mut filtered = Vec::new();
        let mut offset = 0;
        while offset < response.len() {
            let length = u32::from_be_bytes(
                response[offset + 1..offset + 5]
                    .try_into()
                    .expect("message length"),
            ) as usize;
            let next = offset + length + 1;
            if response[offset] != b'C' {
                filtered.extend_from_slice(&response[offset..next]);
            }
            offset = next;
        }
        filtered
    }
}
