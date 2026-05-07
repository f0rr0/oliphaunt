use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
#[cfg(feature = "extensions")]
use tokio::io::{AsyncWrite, AsyncWriteExt};
#[cfg(feature = "extensions")]
use tokio::runtime::Runtime;
#[cfg(feature = "extensions")]
use wasmer_wasix::virtual_net::VirtualTcpSocket;
#[cfg(feature = "extensions")]
use wasmer_wasix::virtual_net::tcp_pair::TcpSocketHalfRx;

use crate::pglite::aot;
#[cfg(feature = "extensions")]
use crate::pglite::assets;
use crate::pglite::backend::{BackendOpenKind, BackendSession};
#[cfg(feature = "extensions")]
use crate::pglite::base::install_bundled_extension_bytes;
use crate::pglite::base::{InstallOutcome, PglitePaths, RootLock};
use crate::pglite::builder::PgliteBuilder;
use crate::pglite::config::{PostgresConfig, StartupConfig};
use crate::pglite::data_dir::{DataDirArchiveFormat, dump_pgdata_archive};
use crate::pglite::errors::PgliteError;
#[cfg(feature = "extensions")]
use crate::pglite::extensions::{
    Extension, by_sql_name, extension_session_setup_sql, extension_setup_sql, resolve_extension_set,
};
use crate::pglite::interface::{
    DataTransferContainer, DescribeQueryParam, DescribeQueryResult, DescribeResultField,
    ExecProtocolOptions, ExecProtocolResult, ParserMap, QueryOptions, Results, SerializerMap,
};
use crate::pglite::parse::{parse_describe_statement_results, parse_results};
#[cfg(feature = "extensions")]
use crate::pglite::pg_dump::{PgDumpOptions, PgDumpVirtualSocket, dump_direct_sql};
#[cfg(feature = "extensions")]
use crate::pglite::postgres_mod::PostgresMod;
use crate::pglite::timing;
use crate::pglite::types::{
    ArrayTypeInfo, DEFAULT_PARSERS, DEFAULT_SERIALIZERS, TEXT, register_array_type,
};
#[cfg(feature = "extensions")]
use crate::pglite::wire::{FrontendFrameKind, FrontendFrameReader, classify_frontend_message};
use crate::protocol::messages::{BackendMessage, DatabaseError};
use crate::protocol::parser::Parser as ProtocolParser;
use crate::protocol::serializer::{BindConfig, BindValue, PortalTarget, Serialize};

type ChannelCallback = Arc<dyn Fn(&str) + Send + Sync + 'static>;
type GlobalCallback = Arc<dyn Fn(&str, &str) + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ListenerHandle {
    channel: String,
    normalized_channel: String,
    id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GlobalListenerHandle {
    id: u64,
}

impl ListenerHandle {
    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn id(&self) -> u64 {
        self.id
    }
}

impl GlobalListenerHandle {
    pub fn id(&self) -> u64 {
        self.id
    }
}

struct ChannelListener {
    id: u64,
    callback: ChannelCallback,
}

struct GlobalListener {
    id: u64,
    callback: GlobalCallback,
}

/// Primary entry point for interacting with the embedded Postgres runtime.
pub struct Pglite {
    backend: BackendSession,
    _temp_dir: Option<TempDir>,
    _root_lock: Option<RootLock>,
    parser: ProtocolParser,
    serializers: SerializerMap,
    parsers: ParserMap,
    array_type_lookup_misses: HashSet<i32>,
    in_transaction: bool,
    ready: bool,
    closing: bool,
    closed: bool,
    blob_input_provided: bool,
    notify_listeners: HashMap<String, Vec<ChannelListener>>,
    global_notify_listeners: Vec<GlobalListener>,
    next_listener_id: u64,
    next_global_listener_id: u64,
}

impl Pglite {
    /// Create a builder for opening persistent or temporary PGlite databases.
    pub fn builder() -> PgliteBuilder {
        PgliteBuilder::new()
    }

    /// Open a persistent PGlite database rooted at `root`, installing and initializing it if needed.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        Self::builder().path(root.as_ref().to_path_buf()).open()
    }

    /// Open a persistent PGlite database under the platform data directory for `app_id`.
    pub fn open_app(app_id: (&str, &str, &str)) -> Result<Self> {
        Self::builder().app_id(app_id).open()
    }

    /// Create an ephemeral PGlite database whose files are removed when the instance is dropped.
    pub fn temporary() -> Result<Self> {
        Self::builder().temporary().open()
    }

    /// Warm the runtime module and bundled AOT artifact cache without opening a database.
    pub fn preload() -> Result<()> {
        let (temp_dir, paths) = {
            let _phase = timing::phase("preload.tempdir");
            PglitePaths::with_temp_dir()?
        };
        {
            let _phase = timing::phase("preload.runtime_module");
            crate::pglite::base::preload_runtime_module(&paths)?;
        }
        {
            let _phase = timing::phase("preload.aot_runtime");
            aot::preload_runtime_artifact()?;
        }
        drop(temp_dir);
        Ok(())
    }

    /// Warm bundled extension artifacts without permanently opening a database.
    #[cfg(feature = "extensions")]
    pub fn preload_extensions(extensions: impl IntoIterator<Item = Extension>) -> Result<()> {
        Self::preload()?;
        let extensions = extensions.into_iter().collect::<Vec<_>>();
        for extension in resolve_extension_set(&extensions)? {
            let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
                anyhow!(
                    "extension asset '{}' is not bundled in this pglite-oxide build",
                    extension.sql_name()
                )
            })?;
            let (temp_dir, paths) = {
                let _phase = timing::phase("preload.extension_tempdir");
                PglitePaths::with_temp_dir()?
            };
            {
                let _phase = timing::phase("preload.extension_runtime_module");
                crate::pglite::base::preload_runtime_module(&paths)?;
            }
            {
                let _phase = timing::phase("preload.extension_archive_install");
                install_bundled_extension_bytes(&paths, extension.sql_name(), bytes)?;
            }
            {
                let _phase = timing::phase("preload.extension_side_module");
                PostgresMod::preload_extension_module_from_paths(&paths, extension)?;
            }
            {
                let _phase = timing::phase("preload.extension_aot");
                aot::preload_extension_artifact(extension)?;
            }
            drop(temp_dir);
        }
        Ok(())
    }

    /// Create a new Pglite instance backed by the provided runtime paths.
    #[doc(hidden)]
    pub fn new(paths: PglitePaths) -> Result<Self> {
        let outcome = crate::pglite::base::prepare_database_root(
            paths,
            crate::pglite::base::RootPrepareOptions::template(),
        )?;
        Self::new_prepared(outcome)
    }

    pub(crate) fn new_prepared(outcome: InstallOutcome) -> Result<Self> {
        Self::new_prepared_with_config(outcome, PostgresConfig::default(), StartupConfig::default())
    }

    pub(crate) fn new_prepared_with_config(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        let _phase = timing::phase("pglite.open");
        let session_startup_config = startup_config.clone();
        let backend = BackendSession::open(
            outcome,
            postgres_config,
            startup_config,
            BackendOpenKind::Direct,
        )?;

        let mut instance = {
            let _phase = timing::phase("pglite.client_struct_init");
            Self {
                backend,
                _temp_dir: None,
                _root_lock: None,
                parser: ProtocolParser::new(),
                serializers: DEFAULT_SERIALIZERS.clone(),
                parsers: DEFAULT_PARSERS.clone(),
                array_type_lookup_misses: HashSet::new(),
                in_transaction: false,
                ready: true,
                closing: false,
                closed: false,
                blob_input_provided: false,
                notify_listeners: HashMap::new(),
                global_notify_listeners: Vec::new(),
                next_listener_id: 1,
                next_global_listener_id: 1,
            }
        };

        if session_startup_config.username != "postgres" {
            let sql = format!(
                "SET ROLE {}",
                crate::pglite::templating::quote_identifier(&session_startup_config.username)
            );
            instance
                .exec(&sql, None)
                .with_context(|| format!("set startup role {}", session_startup_config.username))?;
        }

        Ok(instance)
    }

    /// Install and enable a bundled Postgres extension.
    #[cfg(feature = "extensions")]
    pub fn enable_extension(&mut self, extension: Extension) -> Result<()> {
        let _phase = timing::phase("extension.enable");
        let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
            anyhow!(
                "extension asset '{}' is not bundled in this pglite-oxide build",
                extension.sql_name()
            )
        })?;
        install_bundled_extension_bytes(self.paths(), extension.sql_name(), bytes)?;
        self.backend.preload_extension_module(extension)?;
        for sql in extension_setup_sql(extension) {
            self.exec(&sql, None)?;
        }
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn enable_preinstalled_extension(&mut self, extension: Extension) -> Result<()> {
        let _phase = timing::phase("extension.enable_preinstalled");
        self.backend.preload_installed_extension(extension)?;
        for sql in extension_session_setup_sql(extension) {
            self.exec(&sql, None)?;
        }
        Ok(())
    }

    /// Refresh direct API array parser and serializer registrations.
    ///
    /// This mirrors upstream PGlite's `refreshArrayTypes()` escape hatch. Most
    /// applications should not need it because built-in arrays are registered
    /// statically and runtime custom arrays are discovered lazily when possible.
    pub fn refresh_array_types(&mut self) -> Result<()> {
        self.check_ready()?;
        self.refresh_array_types_internal()
    }

    /// Execute a SQL query using the extended protocol.
    pub fn query(
        &mut self,
        sql: &str,
        params: &[Value],
        options: Option<&QueryOptions>,
    ) -> Result<Results> {
        self.check_ready()?;

        self.query_internal(sql, params, options)
    }

    fn query_internal(
        &mut self,
        sql: &str,
        params: &[Value],
        options: Option<&QueryOptions>,
    ) -> Result<Results> {
        let default_options = QueryOptions::default();
        let query_opts = options.unwrap_or(&default_options);

        self.handle_blob_input(query_opts.blob.as_ref())?;

        let params_snapshot: Vec<Value> = params.to_vec();
        let options_snapshot = options.cloned();
        let mut collected_messages: Vec<BackendMessage> = Vec::new();

        let mut exec_opts = ExecProtocolOptions::no_sync();
        exec_opts.on_notice = query_opts.on_notice.clone();
        exec_opts.data_transfer_container = query_opts.data_transfer_container;

        let result: Result<()> = (|| {
            let param_types = if query_opts.param_types.is_empty() {
                &[] as &[i32]
            } else {
                &query_opts.param_types
            };

            let mut messages = {
                let _phase = timing::phase("client.query.parse_describe");
                self.parse_and_describe(sql, param_types, exec_opts.clone())?
            };
            let mut data_type_ids = parse_describe_statement_results(&messages);
            if self.ensure_array_types_for_bind_values(params, &data_type_ids, query_opts)? {
                messages = {
                    let _phase = timing::phase("client.query.parse_describe_after_array_register");
                    self.parse_and_describe(sql, param_types, exec_opts.clone())?
                };
                data_type_ids = parse_describe_statement_results(&messages);
            }
            collected_messages.extend(messages);
            let bind_values = {
                let _phase = timing::phase("client.query.prepare_bind_values");
                self.prepare_bind_values(params, &data_type_ids, query_opts)?
            };
            let bind_config = BindConfig {
                values: bind_values,
                ..Default::default()
            };
            let execute_batch = {
                let _phase = timing::phase("client.query.serialize_execute");
                let mut execute_batch = Vec::new();
                execute_batch.extend(Serialize::bind(&bind_config));
                execute_batch.extend(Serialize::describe(&PortalTarget::new('P', None)));
                execute_batch.extend(Serialize::execute(None));
                execute_batch.extend(Serialize::sync());
                execute_batch
            };
            let ExecProtocolResult { messages, .. } = {
                let _phase = timing::phase("client.query.execute_roundtrip");
                self.exec_protocol(&execute_batch, exec_opts.clone())?
            };
            collected_messages.extend(messages);

            Ok(())
        })();

        if let Err(err) = result {
            match err.downcast::<DatabaseError>() {
                Ok(db_err) => {
                    let enriched = PgliteError::new(db_err, sql, params_snapshot, options_snapshot);
                    return Err(enriched.into());
                }
                Err(err) => {
                    return Err(err.context(format!("failed to execute extended query: {sql}")));
                }
            }
        }

        {
            let _phase = timing::phase("client.query.finish");
            self.finish_query(collected_messages, options)
        }
    }

    /// Return `true` if the instance is ready for new work.
    pub fn is_ready(&self) -> bool {
        self.ready && !self.closing && !self.closed
    }

    /// Return the host-side runtime and data-directory paths backing this instance.
    #[doc(hidden)]
    pub fn paths(&self) -> &PglitePaths {
        self.backend.paths()
    }

    /// Return debug-build bridge allocation/free counters for ownership tests.
    #[doc(hidden)]
    #[cfg(debug_assertions)]
    pub fn guest_bridge_allocation_counts(&self) -> (u64, u64) {
        self.backend.guest_bridge_allocation_counts()
    }

    /// Dump the physical PGDATA directory to a gzipped tar archive.
    ///
    /// The archive is intended to be loaded back into pglite-oxide/PGlite with
    /// the same PostgreSQL/PGlite version. Use [`dump_sql`](Self::dump_sql) for
    /// logical backups across versions.
    pub fn dump_data_dir(&mut self) -> Result<Vec<u8>> {
        self.dump_data_dir_with_format(DataDirArchiveFormat::TarGz)
    }

    /// Dump the physical PGDATA directory with the selected archive format.
    pub fn dump_data_dir_with_format(&mut self, format: DataDirArchiveFormat) -> Result<Vec<u8>> {
        self.check_ready()?;
        self.archive_quiesced_pgdata("dump PGDATA archive", format)
    }

    /// Clone this database into a new temporary [`Pglite`] instance.
    pub fn try_clone(&mut self) -> Result<Self> {
        #[cfg(feature = "extensions")]
        let extensions = self.bundled_extensions_in_database()?;
        let archive = self.dump_data_dir_with_format(DataDirArchiveFormat::Tar)?;
        let builder = Self::builder().temporary().load_data_dir_archive(archive);
        #[cfg(feature = "extensions")]
        let builder = builder.extensions(extensions);
        builder.open()
    }

    /// Run the bundled WASIX `pg_dump` against this database and return SQL text.
    #[cfg(feature = "extensions")]
    pub fn dump_sql(&mut self, options: PgDumpOptions) -> Result<String> {
        self.check_ready()?;
        options.validate()?;
        self.checkpoint_backend_for_physical_snapshot("direct pg_dump")?;
        self.dump_sql_via_direct_protocol(&options)
    }

    /// Run the bundled WASIX `pg_dump` and return UTF-8 SQL bytes.
    #[cfg(feature = "extensions")]
    pub fn dump_bytes(&mut self, options: PgDumpOptions) -> Result<Vec<u8>> {
        Ok(self.dump_sql(options)?.into_bytes())
    }

    fn checkpoint_backend_for_physical_snapshot(&mut self, operation: &'static str) -> Result<()> {
        if self.in_transaction {
            bail!("{operation} cannot run while a direct transaction is active");
        }
        self.exec("CHECKPOINT", None)
            .with_context(|| format!("checkpoint before {operation}"))?;
        Ok(())
    }

    fn archive_quiesced_pgdata(
        &mut self,
        operation: &'static str,
        format: DataDirArchiveFormat,
    ) -> Result<Vec<u8>> {
        self.checkpoint_backend_for_physical_snapshot(operation)?;
        self.backend
            .shutdown()
            .with_context(|| format!("quiesce backend before {operation}"))?;

        let archive = dump_pgdata_archive(
            &self.backend.paths().pgdata,
            self.backend.pgdata_template_root(),
            format,
        )
        .with_context(|| format!("materialize physical PGDATA archive for {operation}"));
        let restart = self
            .backend
            .restart()
            .and_then(|_| self.restore_session_state_after_backend_restart())
            .with_context(|| format!("restart backend after {operation}"));

        match (archive, restart) {
            (Ok(archive), Ok(())) => Ok(archive),
            (Err(err), Ok(())) => Err(err),
            (Ok(_), Err(err)) => {
                self.ready = false;
                self.closed = true;
                Err(err)
            }
            (Err(err), Err(restart_err)) => {
                self.ready = false;
                self.closed = true;
                Err(err.context(format!(
                    "backend restart after failed {operation} also failed: {restart_err:#}"
                )))
            }
        }
    }

    fn restore_session_state_after_backend_restart(&mut self) -> Result<()> {
        let username = self.backend.startup_config().username.clone();
        if username != "postgres" {
            let sql = format!(
                "SET ROLE {}",
                crate::pglite::templating::quote_identifier(&username)
            );
            self.exec(&sql, None).with_context(|| {
                format!("restore startup role {username} after backend restart")
            })?;
        }

        let channels = self
            .notify_listeners
            .iter()
            .filter(|(_, listeners)| !listeners.is_empty())
            .map(|(channel, _)| channel.clone())
            .collect::<Vec<_>>();
        for channel in channels {
            let quoted_channel = crate::pglite::templating::quote_identifier(&channel);
            self.exec_internal(&format!("LISTEN {quoted_channel}"), None)
                .with_context(|| format!("restore LISTEN {channel} after backend restart"))?;
        }
        Ok(())
    }

    #[cfg(feature = "extensions")]
    fn dump_sql_via_direct_protocol(&mut self, options: &PgDumpOptions) -> Result<String> {
        ensure_direct_pg_dump_options_match_session(self.backend.startup_config(), options)?;
        let result = dump_direct_sql(options, |socket| self.serve_direct_pg_dump_protocol(socket));
        let cleanup_result = self.cleanup_after_direct_pg_dump_session();

        match (result, cleanup_result) {
            (Ok(sql), Ok(())) => Ok(sql),
            (Err(err), Ok(())) => Err(err),
            (Ok(_), Err(err)) => Err(err),
            (Err(err), Err(cleanup_err)) => Err(err.context(format!(
                "direct pg_dump cleanup also failed: {cleanup_err:#}"
            ))),
        }
    }

    #[cfg(feature = "extensions")]
    fn cleanup_after_direct_pg_dump_session(&mut self) -> Result<()> {
        self.exec("DEALLOCATE ALL; SET search_path TO DEFAULT;", None)
            .context("reset direct pg_dump session state")?;
        Ok(())
    }

    #[cfg(feature = "extensions")]
    fn serve_direct_pg_dump_protocol(&mut self, mut socket: PgDumpVirtualSocket) -> Result<()> {
        let _ = socket.set_nodelay(true);
        let (mut socket_tx, mut socket_rx) = socket.split();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create direct pg_dump virtual socket runtime")?;
        let mut reader = FrontendFrameReader::default();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = read_direct_pg_dump_socket(&runtime, &mut socket_rx, &mut buffer)
                .context("read direct pg_dump protocol socket")?;
            if read == 0 {
                return Ok(());
            }
            for message in reader.push(&buffer[..read])? {
                match classify_frontend_message(&message)? {
                    FrontendFrameKind::SslOrGssRequest => {
                        write_direct_pg_dump_socket(&runtime, &mut socket_tx, b"N")
                            .context("write direct pg_dump SSL refusal")?;
                    }
                    FrontendFrameKind::CancelRequest | FrontendFrameKind::Terminate => {
                        return Ok(());
                    }
                    FrontendFrameKind::Startup => {
                        if let Some(response) = self.backend.existing_startup_response() {
                            write_direct_pg_dump_socket(&runtime, &mut socket_tx, &response)
                                .context("write direct pg_dump existing startup response")?;
                        } else {
                            let response = self.backend.startup_with_packet(&message)?;
                            write_direct_pg_dump_socket(&runtime, &mut socket_tx, &response.output)
                                .context("write direct pg_dump startup response")?;
                            if !response.accepted {
                                return Ok(());
                            }
                        }
                    }
                    FrontendFrameKind::Protocol => {
                        self.exec_protocol_raw_stream(
                            &message,
                            ExecProtocolOptions::no_sync(),
                            |chunk| {
                                write_direct_pg_dump_socket(&runtime, &mut socket_tx, chunk)
                                    .context("write direct pg_dump backend protocol chunk")?;
                                Ok(())
                            },
                        )?;
                    }
                }
            }
            flush_direct_pg_dump_socket(&runtime, &mut socket_tx)
                .context("flush direct pg_dump socket")?;
        }
    }

    #[cfg(feature = "extensions")]
    fn bundled_extensions_in_database(&mut self) -> Result<Vec<Extension>> {
        let results = self.query(
            "SELECT extname FROM pg_catalog.pg_extension ORDER BY extname",
            &[],
            None,
        )?;
        let extensions = results
            .rows
            .iter()
            .filter_map(|row| row.get("extname"))
            .filter_map(|value| value.as_str())
            .filter_map(by_sql_name)
            .collect();
        Ok(extensions)
    }

    pub(crate) fn attach_temp_dir(&mut self, temp_dir: TempDir) {
        self._temp_dir = Some(temp_dir);
    }

    pub(crate) fn attach_root_lock(&mut self, root_lock: RootLock) {
        self._root_lock = Some(root_lock);
    }

    /// Return `true` if the instance has already been closed.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Shut down the embedded Postgres runtime.
    pub fn close(&mut self) -> Result<()> {
        self.close_backend()
    }

    fn close_backend(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        if self.closing {
            bail!("Pglite is closing");
        }

        self.closing = true;
        let result = (|| {
            self.backend.shutdown()?;
            self.sync_to_fs()
        })();

        self.closing = false;
        if result.is_ok() {
            self.closed = true;
            self.ready = false;
            self.notify_listeners.clear();
            self.global_notify_listeners.clear();
            self._root_lock = None;
        }
        result
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn close_for_template_cache(&mut self) -> Result<()> {
        self.close_backend()
    }

    /// Execute a simple SQL statement that may contain multiple commands.
    pub fn exec(&mut self, sql: &str, options: Option<&QueryOptions>) -> Result<Vec<Results>> {
        self.check_ready()?;

        self.exec_internal(sql, options)
    }

    fn exec_internal(&mut self, sql: &str, options: Option<&QueryOptions>) -> Result<Vec<Results>> {
        let options_snapshot = options.cloned();
        let default_options = QueryOptions::default();
        let exec_opts_ref = options.unwrap_or(&default_options);
        let mut exec_opts = ExecProtocolOptions::no_sync();
        exec_opts.on_notice = exec_opts_ref.on_notice.clone();
        exec_opts.data_transfer_container = exec_opts_ref.data_transfer_container;

        self.handle_blob_input(exec_opts_ref.blob.as_ref())?;

        let mut collected_messages: Vec<BackendMessage> = Vec::new();

        let message = Serialize::query(sql);
        let ExecProtocolResult { messages, .. } = match self.exec_protocol(&message, exec_opts) {
            Ok(result) => result,
            Err(err) => match err.downcast::<DatabaseError>() {
                Ok(db_err) => {
                    let enriched = PgliteError::new(db_err, sql, Vec::new(), options_snapshot);
                    return Err(enriched.into());
                }
                Err(err) => {
                    return Err(err.context(format!("failed to execute simple query: {sql}")));
                }
            },
        };
        collected_messages.extend(messages);

        self.finish_exec(collected_messages, options)
    }

    /// Register a listener for `LISTEN channel`. Returns a handle that can be used to unlisten.
    pub fn listen<F>(&mut self, channel: &str, callback: F) -> Result<ListenerHandle>
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        self.check_ready()?;

        let quoted_channel = crate::pglite::templating::quote_identifier(channel);
        let normalized = channel.to_string();
        let should_listen = match self.notify_listeners.get(&normalized) {
            Some(existing) => existing.is_empty(),
            None => true,
        };

        if should_listen {
            self.exec_internal(&format!("LISTEN {quoted_channel}"), None)?;
        }

        let callback: ChannelCallback = Arc::new(callback);
        let entry = self.notify_listeners.entry(normalized.clone()).or_default();
        let id = self.next_listener_id;
        self.next_listener_id = self.next_listener_id.wrapping_add(1);
        entry.push(ChannelListener { id, callback });

        Ok(ListenerHandle {
            channel: channel.to_string(),
            normalized_channel: normalized,
            id,
        })
    }

    /// Remove a listener corresponding to the provided handle.
    pub fn unlisten(&mut self, handle: ListenerHandle) -> Result<()> {
        if let Some(listeners) = self.notify_listeners.get_mut(&handle.normalized_channel) {
            listeners.retain(|listener| listener.id != handle.id);
            if listeners.is_empty() {
                self.notify_listeners.remove(&handle.normalized_channel);
                let quoted_channel = crate::pglite::templating::quote_identifier(&handle.channel);
                self.exec_internal(&format!("UNLISTEN {quoted_channel}"), None)?;
            }
        }
        Ok(())
    }

    /// Remove all listeners for the specified channel.
    pub fn unlisten_channel(&mut self, channel: &str) -> Result<()> {
        let quoted_channel = crate::pglite::templating::quote_identifier(channel);
        let normalized = channel.to_string();
        if self.notify_listeners.remove(&normalized).is_some() {
            self.exec_internal(&format!("UNLISTEN {quoted_channel}"), None)?;
        }
        Ok(())
    }

    /// Register a global notification callback.
    pub fn on_notification<F>(&mut self, callback: F) -> GlobalListenerHandle
    where
        F: Fn(&str, &str) + Send + Sync + 'static,
    {
        let id = self.next_global_listener_id;
        self.next_global_listener_id = self.next_global_listener_id.wrapping_add(1);
        let callback: GlobalCallback = Arc::new(callback);
        self.global_notify_listeners
            .push(GlobalListener { id, callback });
        GlobalListenerHandle { id }
    }

    /// Deregister a previously registered global notification callback.
    pub fn off_notification(&mut self, handle: GlobalListenerHandle) {
        self.global_notify_listeners
            .retain(|listener| listener.id != handle.id);
    }

    /// Describe the parameter and result metadata for a SQL query.
    pub fn describe_query(
        &mut self,
        sql: &str,
        options: Option<&QueryOptions>,
    ) -> Result<DescribeQueryResult> {
        self.check_ready()?;

        let default_options = QueryOptions::default();
        let query_opts = options.unwrap_or(&default_options);

        let options_snapshot = options.cloned();
        let mut exec_opts = ExecProtocolOptions::no_sync();
        exec_opts.on_notice = query_opts.on_notice.clone();
        exec_opts.data_transfer_container = query_opts.data_transfer_container;

        let mut describe_messages: Vec<BackendMessage> = Vec::new();

        let result: Result<()> = (|| {
            let param_types = if query_opts.param_types.is_empty() {
                &[] as &[i32]
            } else {
                &query_opts.param_types
            };

            let mut describe_batch = Vec::new();
            describe_batch.extend(Serialize::parse(None, sql, param_types));
            describe_batch.extend(Serialize::describe(&PortalTarget::new('S', None)));
            describe_batch.extend(Serialize::sync());
            let ExecProtocolResult { messages, .. } =
                self.exec_protocol(&describe_batch, exec_opts.clone())?;
            if !messages
                .iter()
                .any(|message| matches!(message, BackendMessage::ParseComplete { .. }))
            {
                bail!("extended query parse did not complete");
            }
            describe_messages.extend(messages);

            Ok(())
        })();

        if let Err(err) = result {
            match err.downcast::<DatabaseError>() {
                Ok(db_err) => {
                    let enriched = PgliteError::new(db_err, sql, Vec::new(), options_snapshot);
                    return Err(enriched.into());
                }
                Err(err) => {
                    return Err(err.context(format!("failed to describe query: {sql}")));
                }
            }
        }

        let param_type_ids = parse_describe_statement_results(&describe_messages);
        self.ensure_array_types_for_oids(param_type_ids.iter().copied(), Some(query_opts))?;
        let result_type_ids = describe_messages
            .iter()
            .filter_map(|msg| match msg {
                BackendMessage::RowDescription(desc) => Some(desc),
                _ => None,
            })
            .flat_map(|desc| desc.fields.iter().map(|field| field.data_type_id))
            .collect::<Vec<_>>();
        self.ensure_array_types_for_oids(result_type_ids.iter().copied(), Some(query_opts))?;

        let query_params = param_type_ids
            .into_iter()
            .map(|oid| DescribeQueryParam {
                data_type_id: oid,
                serializer: self.serializers.get(&oid).cloned(),
            })
            .collect();

        let result_fields = describe_messages
            .iter()
            .find_map(|msg| match msg {
                BackendMessage::RowDescription(desc) => Some(
                    desc.fields
                        .iter()
                        .map(|field| DescribeResultField {
                            name: field.name.clone(),
                            data_type_id: field.data_type_id,
                            parser: self.parsers.get(&field.data_type_id).cloned(),
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .unwrap_or_default();

        Ok(DescribeQueryResult {
            query_params,
            result_fields,
        })
    }

    /// Run a closure within an SQL transaction (`BEGIN .. COMMIT/ROLLBACK`).
    pub fn transaction<F, T>(&mut self, mut callback: F) -> Result<T>
    where
        F: FnMut(&mut Transaction<'_>) -> Result<T>,
    {
        self.check_ready()?;

        // Begin transaction
        self.run_exec_command("BEGIN")?;
        self.in_transaction = true;

        let mut tx = Transaction::new(self);
        let callback_result = callback(&mut tx);

        let txn_result = match callback_result {
            Ok(value) => {
                if !tx.closed {
                    tx.commit_internal()?;
                }
                Ok(value)
            }
            Err(err) => {
                if !tx.closed {
                    tx.rollback_internal()?;
                }
                Err(err)
            }
        };

        self.in_transaction = false;
        txn_result
    }

    /// Flush runtime writes to the underlying filesystem.
    ///
    /// The WASIX backend uses host-mounted files and PostgreSQL's own fsync/WAL
    /// behavior for durability. Adding an unconditional host directory
    /// `sync_all` after every direct query is both expensive and weaker than the
    /// database's file-level fsyncs, so the Rust-level hook remains a no-op.
    pub fn sync_to_fs(&mut self) -> Result<()> {
        Ok(())
    }

    fn prepare_bind_values(
        &self,
        params: &[Value],
        data_type_ids: &[i32],
        options: &QueryOptions,
    ) -> Result<Vec<BindValue>> {
        if params.is_empty() {
            return Ok(Vec::new());
        }

        let mut values = Vec::with_capacity(params.len());
        let overrides = if options.serializers.is_empty() {
            None
        } else {
            Some(&options.serializers)
        };

        for (idx, value) in params.iter().enumerate() {
            if value.is_null() {
                values.push(BindValue::Null);
                continue;
            }

            let oid = data_type_ids.get(idx).copied().unwrap_or(TEXT);
            let serializer = overrides
                .and_then(|map| map.get(&oid))
                .or_else(|| self.serializers.get(&oid));

            let serialized = match serializer {
                Some(func) => func(value).with_context(|| {
                    format!("failed to serialize parameter {idx} using OID {oid}")
                })?,
                None => self.default_serialize_value(value),
            };

            values.push(BindValue::Text(serialized));
        }

        Ok(values)
    }

    fn parse_and_describe(
        &mut self,
        sql: &str,
        param_types: &[i32],
        exec_opts: ExecProtocolOptions,
    ) -> Result<Vec<BackendMessage>> {
        let mut prepare_batch = Vec::new();
        prepare_batch.extend(Serialize::parse(None, sql, param_types));
        prepare_batch.extend(Serialize::describe(&PortalTarget::new('S', None)));
        prepare_batch.extend(Serialize::sync());
        let ExecProtocolResult { messages, .. } = self.exec_protocol(&prepare_batch, exec_opts)?;
        if !messages
            .iter()
            .any(|message| matches!(message, BackendMessage::ParseComplete { .. }))
        {
            bail!("extended query parse did not complete");
        }
        Ok(messages)
    }

    fn default_serialize_value(&self, value: &Value) -> String {
        Self::default_serialize_value_static(value)
    }

    pub(crate) fn default_serialize_value_static(value: &Value) -> String {
        match value {
            Value::String(s) => s.clone(),
            Value::Number(num) => num.to_string(),
            Value::Bool(flag) => {
                if *flag {
                    "t".to_string()
                } else {
                    "f".to_string()
                }
            }
            _ => value.to_string(),
        }
    }

    fn finish_query(
        &mut self,
        messages: Vec<BackendMessage>,
        options: Option<&QueryOptions>,
    ) -> Result<Results> {
        let blob = {
            let _phase = timing::phase("client.finish.blob_read");
            self.get_written_blob()?
        };
        {
            let _phase = timing::phase("client.finish.blob_cleanup");
            self.cleanup_blob()?;
        }
        if !self.in_transaction {
            let _phase = timing::phase("client.finish.sync_to_fs");
            self.sync_to_fs()?;
        }
        {
            let _phase = timing::phase("client.finish.ensure_array_types");
            self.ensure_array_types_for_result_messages(&messages, options)?;
        }
        let parsed = {
            let _phase = timing::phase("client.finish.parse_results");
            parse_results(&messages, &self.parsers, options, blob)
        };
        parsed
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("query returned no result sets"))
    }

    fn finish_exec(
        &mut self,
        messages: Vec<BackendMessage>,
        options: Option<&QueryOptions>,
    ) -> Result<Vec<Results>> {
        let blob = {
            let _phase = timing::phase("client.finish.blob_read");
            self.get_written_blob()?
        };
        {
            let _phase = timing::phase("client.finish.blob_cleanup");
            self.cleanup_blob()?;
        }
        if !self.in_transaction {
            let _phase = timing::phase("client.finish.sync_to_fs");
            self.sync_to_fs()?;
        }
        {
            let _phase = timing::phase("client.finish.ensure_array_types");
            self.ensure_array_types_for_result_messages(&messages, options)?;
        }
        let parsed = {
            let _phase = timing::phase("client.finish.parse_results");
            parse_results(&messages, &self.parsers, options, blob)
        };
        Ok(parsed)
    }

    /// Execute raw PostgreSQL frontend protocol bytes and parse backend
    /// protocol messages.
    pub fn exec_protocol(
        &mut self,
        message: &[u8],
        options: ExecProtocolOptions,
    ) -> Result<ExecProtocolResult> {
        let ExecProtocolOptions {
            sync_to_fs,
            throw_on_error,
            on_notice,
            data_transfer_container,
        } = options;

        let data = {
            let _phase = timing::phase("client.protocol_roundtrip");
            self.exec_protocol_raw_inner(message, sync_to_fs, data_transfer_container)?
        };

        let mut messages = Vec::new();
        let on_notice_cb = on_notice.clone();
        let parse_result = {
            let _phase = timing::phase("client.protocol_parse");
            self.parser.parse(&data, |msg| {
                if let BackendMessage::Error(db_err) = &msg
                    && throw_on_error
                {
                    return Err(anyhow!(db_err.clone()));
                }
                if let Some(callback) = on_notice_cb.as_ref()
                    && let BackendMessage::Notice(notice) = &msg
                {
                    callback(notice);
                }
                messages.push(msg);
                Ok(())
            })
        };
        if let Err(err) = parse_result {
            match err.downcast::<DatabaseError>() {
                Ok(db_err) => {
                    self.parser = ProtocolParser::new();
                    return Err(anyhow!(db_err));
                }
                Err(err) => return Err(err),
            }
        }

        for message in &messages {
            if let BackendMessage::Notification(note) = message {
                if let Some(listeners) = self.notify_listeners.get(&note.channel) {
                    for listener in listeners {
                        (listener.callback)(&note.payload);
                    }
                }
                for listener in &self.global_notify_listeners {
                    (listener.callback)(&note.channel, &note.payload);
                }
            }
        }

        Ok(ExecProtocolResult { data, messages })
    }

    /// Execute raw PostgreSQL frontend protocol bytes and return raw backend
    /// protocol bytes.
    pub fn exec_protocol_raw(
        &mut self,
        message: &[u8],
        options: ExecProtocolOptions,
    ) -> Result<Vec<u8>> {
        self.exec_protocol_raw_inner(message, options.sync_to_fs, options.data_transfer_container)
    }

    /// Execute raw protocol bytes and pass the returned backend bytes to
    /// `on_data`.
    pub fn exec_protocol_raw_stream<F>(
        &mut self,
        message: &[u8],
        options: ExecProtocolOptions,
        mut on_data: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        self.backend.send_framed_raw_stream(
            message,
            options.data_transfer_container,
            &mut on_data,
        )?;
        if options.sync_to_fs {
            let _phase = timing::phase("client.protocol_stream_sync_to_fs");
            self.sync_to_fs()?;
        }
        Ok(())
    }

    fn exec_protocol_raw_inner(
        &mut self,
        message: &[u8],
        sync_to_fs: bool,
        data_transfer_container: Option<DataTransferContainer>,
    ) -> Result<Vec<u8>> {
        let data = {
            let _phase = timing::phase("client.protocol_transport_send");
            self.backend
                .send_buffered(message, data_transfer_container)?
        };
        if sync_to_fs {
            let _phase = timing::phase("client.protocol_sync_to_fs");
            self.sync_to_fs()?;
        }
        Ok(data)
    }

    fn ensure_array_types_for_bind_values(
        &mut self,
        params: &[Value],
        data_type_ids: &[i32],
        options: &QueryOptions,
    ) -> Result<bool> {
        let mut registered = false;
        for (idx, value) in params.iter().enumerate() {
            if !value.is_array() {
                continue;
            }
            let oid = data_type_ids.get(idx).copied().unwrap_or(TEXT);
            if options.serializers.contains_key(&oid) || self.serializers.contains_key(&oid) {
                continue;
            }
            registered |= self.try_register_array_type_by_array_oid(oid)?;
        }
        Ok(registered)
    }

    fn ensure_array_types_for_result_messages(
        &mut self,
        messages: &[BackendMessage],
        options: Option<&QueryOptions>,
    ) -> Result<()> {
        let oids = messages
            .iter()
            .filter_map(|msg| match msg {
                BackendMessage::RowDescription(desc) => Some(desc),
                _ => None,
            })
            .flat_map(|desc| desc.fields.iter().map(|field| field.data_type_id))
            .collect::<Vec<_>>();
        self.ensure_array_types_for_oids(oids, options)
    }

    fn ensure_array_types_for_oids(
        &mut self,
        oids: impl IntoIterator<Item = i32>,
        options: Option<&QueryOptions>,
    ) -> Result<()> {
        for oid in oids {
            if oid <= 0 || self.parsers.contains_key(&oid) {
                continue;
            }
            if options.is_some_and(|options| options.parsers.contains_key(&oid)) {
                continue;
            }
            self.try_register_array_type_by_array_oid(oid)?;
        }
        Ok(())
    }

    fn refresh_array_types_internal(&mut self) -> Result<()> {
        let sql = "
            SELECT e.oid, a.oid AS typarray, e.typdelim::text AS typdelim
            FROM pg_catalog.pg_type a
            JOIN pg_catalog.pg_type e ON e.oid = a.typelem
            WHERE a.typcategory = 'A'
              AND a.typelem <> 0
            ORDER BY e.oid
        ";
        let results = {
            let _phase = timing::phase("pglite.array_type_catalog_query");
            self.exec_internal(sql, None)?
        };
        let result_set = results
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("array type discovery returned no results"))?;

        {
            let _phase = timing::phase("pglite.array_type_register");
            for row in result_set.rows {
                if let Some(info) = array_type_info_from_row(&row) {
                    self.register_array_type(info);
                }
            }
        }
        Ok(())
    }

    fn try_register_array_type_by_array_oid(&mut self, array_oid: i32) -> Result<bool> {
        if array_oid <= 0
            || self.parsers.contains_key(&array_oid)
            || self.array_type_lookup_misses.contains(&array_oid)
        {
            return Ok(false);
        }

        let sql = format!(
            "SELECT e.oid, a.oid AS typarray, e.typdelim::text AS typdelim \
             FROM pg_catalog.pg_type a \
             JOIN pg_catalog.pg_type e ON e.oid = a.typelem \
             WHERE a.oid = {array_oid}::oid \
               AND a.typcategory = 'A' \
               AND a.typelem <> 0"
        );
        let results = {
            let _phase = timing::phase("pglite.array_type_targeted_lookup");
            self.exec_internal(&sql, None)?
        };
        let Some(result_set) = results.into_iter().next() else {
            self.array_type_lookup_misses.insert(array_oid);
            return Ok(false);
        };
        let Some(row) = result_set.rows.into_iter().next() else {
            self.array_type_lookup_misses.insert(array_oid);
            return Ok(false);
        };
        let Some(info) = array_type_info_from_row(&row) else {
            self.array_type_lookup_misses.insert(array_oid);
            return Ok(false);
        };

        self.register_array_type(info);
        Ok(true)
    }

    fn register_array_type(&mut self, info: ArrayTypeInfo) {
        register_array_type(&mut self.parsers, &mut self.serializers, info);
        self.array_type_lookup_misses.remove(&info.array_oid);
    }

    fn run_exec_command(&mut self, sql: &str) -> Result<()> {
        self.exec_internal(sql, None).map(|_| ())
    }

    fn handle_blob_input(&mut self, blob: Option<&Vec<u8>>) -> Result<()> {
        let path = self.dev_blob_path();
        if let Some(bytes) = blob {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create blob directory {}", parent.display())
                })?;
            }
            fs::write(&path, bytes)
                .with_context(|| format!("write blob input to {}", path.display()))?;
            self.blob_input_provided = true;
        } else {
            self.blob_input_provided = false;
            let _ = fs::remove_file(&path);
        }
        Ok(())
    }

    fn dev_blob_path(&self) -> PathBuf {
        self.backend.paths().runtime_root().join("dev/blob")
    }

    fn cleanup_blob(&mut self) -> Result<()> {
        Ok(())
    }

    fn get_written_blob(&mut self) -> Result<Option<Vec<u8>>> {
        let path = self.dev_blob_path();

        if self.blob_input_provided {
            self.blob_input_provided = false;
            let _ = fs::remove_file(&path);
            return Ok(None);
        }

        match fs::read(&path) {
            Ok(data) => {
                self.blob_input_provided = false;
                let _ = fs::remove_file(&path);
                if data.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(data))
                }
            }
            Err(err) => {
                if err.kind() == io::ErrorKind::NotFound {
                    self.blob_input_provided = false;
                    Ok(None)
                } else {
                    Err(err).with_context(|| format!("read blob output from {}", path.display()))
                }
            }
        }
    }

    fn check_ready(&self) -> Result<()> {
        if self.closing {
            bail!("Pglite instance is closing");
        }
        if self.closed {
            bail!("Pglite instance is closed");
        }
        if !self.ready {
            bail!("Pglite instance is not ready");
        }
        Ok(())
    }
}

impl Drop for Pglite {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.close();
        }
    }
}

#[cfg(feature = "extensions")]
fn ensure_direct_pg_dump_options_match_session(
    startup_config: &StartupConfig,
    options: &PgDumpOptions,
) -> Result<()> {
    if options.database_ref() != startup_config.database {
        bail!(
            "direct pg_dump runs against the already-open embedded backend database '{}'; requested database '{}' would require a separate server connection",
            startup_config.database,
            options.database_ref()
        );
    }
    if options.username_ref() != startup_config.username {
        bail!(
            "direct pg_dump runs through the already-open embedded backend user '{}'; requested user '{}' would require a separate server connection",
            startup_config.username,
            options.username_ref()
        );
    }
    Ok(())
}

#[cfg(feature = "extensions")]
fn read_direct_pg_dump_socket(
    runtime: &Runtime,
    reader: &mut TcpSocketHalfRx,
    buffer: &mut [u8],
) -> Result<usize> {
    runtime
        .block_on(async {
            std::future::poll_fn(|cx| {
                let read = match reader.poll_fill_buf(cx) {
                    std::task::Poll::Ready(Ok(available)) => {
                        let read = available.len().min(buffer.len());
                        buffer[..read].copy_from_slice(&available[..read]);
                        read
                    }
                    std::task::Poll::Ready(Err(err)) => return std::task::Poll::Ready(Err(err)),
                    std::task::Poll::Pending => return std::task::Poll::Pending,
                };
                reader.consume(read);
                std::task::Poll::Ready(Ok(read))
            })
            .await
        })
        .context("read direct pg_dump virtual socket")
}

#[cfg(feature = "extensions")]
fn write_direct_pg_dump_socket(
    runtime: &Runtime,
    writer: &mut (impl AsyncWrite + Unpin),
    bytes: &[u8],
) -> Result<()> {
    runtime
        .block_on(writer.write_all(bytes))
        .context("write direct pg_dump virtual socket")
}

#[cfg(feature = "extensions")]
fn flush_direct_pg_dump_socket(
    runtime: &Runtime,
    writer: &mut (impl AsyncWrite + Unpin),
) -> Result<()> {
    runtime
        .block_on(writer.flush())
        .context("flush direct pg_dump virtual socket")
}

fn value_to_i32(value: Option<&Value>) -> Option<i32> {
    match value? {
        Value::Number(number) => number.as_i64().map(|value| value as i32),
        Value::String(string) => string.parse::<i32>().ok(),
        _ => None,
    }
}

fn value_to_char(value: Option<&Value>) -> Option<char> {
    match value? {
        Value::String(string) => string.chars().next(),
        _ => None,
    }
}

fn array_type_info_from_row(row: &Value) -> Option<ArrayTypeInfo> {
    let Value::Object(map) = row else {
        return None;
    };
    let element_oid = value_to_i32(map.get("oid"))?;
    let array_oid = value_to_i32(map.get("typarray"))?;
    if element_oid == 0 || array_oid == 0 {
        return None;
    }
    let delimiter = value_to_char(map.get("typdelim")).unwrap_or(',');
    Some(ArrayTypeInfo::new(element_oid, array_oid, delimiter))
}

/// Transaction handle used within [`Pglite::transaction`].
pub struct Transaction<'a> {
    client: &'a mut Pglite,
    closed: bool,
}

impl<'a> Transaction<'a> {
    fn new(client: &'a mut Pglite) -> Self {
        Self {
            client,
            closed: false,
        }
    }

    fn commit_internal(&mut self) -> Result<()> {
        self.ensure_open()?;
        self.client.exec_internal("COMMIT", None)?;
        self.closed = true;
        Ok(())
    }

    fn rollback_internal(&mut self) -> Result<()> {
        self.ensure_open()?;
        self.client.exec_internal("ROLLBACK", None)?;
        self.closed = true;
        Ok(())
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closed {
            bail!("transaction is already closed");
        }
        Ok(())
    }

    pub fn query(
        &mut self,
        sql: &str,
        params: &[Value],
        options: Option<&QueryOptions>,
    ) -> Result<Results> {
        self.ensure_open()?;
        self.client.query_internal(sql, params, options)
    }

    pub fn exec(&mut self, sql: &str, options: Option<&QueryOptions>) -> Result<Vec<Results>> {
        self.ensure_open()?;
        self.client.exec_internal(sql, options)
    }

    pub fn refresh_array_types(&mut self) -> Result<()> {
        self.ensure_open()?;
        self.client.refresh_array_types_internal()
    }

    pub fn commit(&mut self) -> Result<()> {
        self.commit_internal()
    }

    pub fn rollback(&mut self) -> Result<()> {
        self.rollback_internal()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn closed(&self) -> bool {
        self.closed
    }
}
