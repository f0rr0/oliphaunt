use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use tempfile::TempDir;

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
use crate::oliphaunt::query::{
    CommandResult, QueryParam, QueryResult, extended_query, parse_command_response,
    parse_query_response,
};
use crate::oliphaunt::storage::PgDataStorage;
#[cfg(all(feature = "extensions", test))]
use crate::oliphaunt::storage::StorageRoot;

/// Direct, single-session Oliphaunt WASIX database.
pub struct Oliphaunt {
    backend: BackendSession,
    _workspace: Option<TempDir>,
    _directory_lock: Option<DirectoryLock>,
    in_transaction: bool,
    transaction_outcome_unknown: bool,
    closing: bool,
    closed: bool,
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
            closing: false,
            closed: false,
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
        let start = self.query_inner(
            "SELECT pg_walfile_name(pg_backup_start(label => 'oliphaunt physical backup', fast => true)), pg_size_bytes(current_setting('wal_segment_size'))::text",
        )?;
        ensure!(
            start.rows().len() == 1 && start.rows()[0].values().len() == 2,
            "pg_backup_start returned an unexpected result"
        );
        let start_wal = start.rows()[0]
            .text_inner(0)?
            .context("pg_backup_start returned no WAL filename")?
            .to_owned();
        let wal_segment_size = start.rows()[0]
            .text_inner(1)?
            .context("pg_backup_start returned no WAL segment size")?
            .parse::<u64>()
            .context("pg_backup_start returned an invalid WAL segment size")?;

        let storage = self.backend.pgdata_storage().clone();
        let before_stop = match materialize_storage(&storage).and_then(|snapshot| {
            refresh_materialized_pg_control(&storage, snapshot.path())?;
            Ok(snapshot)
        }) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return match self.stop_backup() {
                    Ok(_) => Err(error),
                    Err(stop_error) => Err(error.context(format!(
                        "physical backup failed and PostgreSQL could not leave backup mode: {stop_error:#}"
                    ))),
                };
            }
        };
        let (stop_wal, backup_label, tablespace_map) = match self.stop_backup() {
            Ok(result) => result,
            Err(primary) => {
                let _ = self.stop_backup();
                return Err(primary);
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

    fn stop_backup(&mut self) -> Result<(String, String, Option<String>)> {
        let result = self.query_inner(
            "SELECT pg_walfile_name(lsn), labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)",
        )?;
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
        Ok(())
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
