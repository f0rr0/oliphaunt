use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, sync_channel},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use tempfile::TempDir;

use crate::pglite::assets;
use crate::pglite::base::{
    InstallOutcome, PreparedRoot, RootLock, RootPlan, RootSource, RootTarget, prepare_root,
    prepare_server_core_root,
};
use crate::pglite::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::pglite::extensions::{Extension, resolve_extension_set};
use crate::pglite::interface::DebugLevel;
#[cfg(feature = "extensions")]
use crate::pglite::pg_dump::{PgDumpOptions, dump_server_core_sql, dump_server_sql};
use crate::pglite::proxy::PgliteProxy;
use crate::pglite::timing;

/// A supervised local PostgreSQL socket backed by one embedded PGlite runtime.
///
/// This is the compatibility entry point for code that expects a PostgreSQL URL,
/// such as `tokio-postgres`, SQLx, or tools that speak the wire protocol. The
/// server owns one embedded backend, so downstream pools should use a single
/// connection.
#[derive(Debug)]
pub struct PgliteServer {
    root: PathBuf,
    _temp_dir: Option<TempDir>,
    _root_lock: Option<RootLock>,
    endpoint: ServerEndpoint,
    startup_config: StartupConfig,
    runtime_config: PgliteServerRuntimeConfig,
    runtime_module_root: PathBuf,
    server_process_id: Option<u32>,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<Result<()>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerEndpoint {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

/// Dependency-light connection metadata for a running [`PgliteServer`].
///
/// Use this when a client library accepts structured host, port, user, and
/// database fields. Use [`uri`](Self::uri) or [`database_url`](Self::database_url)
/// when a client expects a PostgreSQL URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgliteServerConnectionInfo {
    endpoint: ServerEndpoint,
    username: String,
    database: String,
}

impl PgliteServerConnectionInfo {
    /// Return the startup user encoded in generated URLs.
    pub fn username(&self) -> &str {
        &self.username
    }

    /// Return the startup database encoded in generated URLs.
    pub fn database(&self) -> &str {
        &self.database
    }

    /// Return the TCP address, if the server is using TCP.
    pub fn tcp_addr(&self) -> Option<SocketAddr> {
        match self.endpoint {
            ServerEndpoint::Tcp(addr) => Some(addr),
            #[cfg(unix)]
            ServerEndpoint::Unix(_) => None,
        }
    }

    /// Return the Unix-domain socket path, if the server is using UDS.
    #[cfg(unix)]
    pub fn socket_path(&self) -> Option<&Path> {
        match &self.endpoint {
            ServerEndpoint::Tcp(_) => None,
            ServerEndpoint::Unix(path) => Some(path),
        }
    }

    /// Return the Unix-domain socket directory, if the server is using UDS.
    #[cfg(unix)]
    pub fn socket_dir(&self) -> Option<&Path> {
        self.socket_path()
            .map(|path| path.parent().unwrap_or_else(|| Path::new("/tmp")))
    }

    /// Return a PostgreSQL connection URI.
    pub fn uri(&self) -> String {
        connection_uri_for(&self.endpoint, &self.username, &self.database)
    }

    /// Alias for [`uri`](Self::uri).
    pub fn database_url(&self) -> String {
        self.uri()
    }
}

/// External Wasmer compiler used by the PostgreSQL 18 WASIX server-core path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmerCompiler {
    /// Use Wasmer's LLVM backend. This is the default production path.
    Llvm,
    /// Use Wasmer's Cranelift backend.
    Cranelift,
    /// Use Wasmer's Singlepass backend.
    Singlepass,
}

impl WasmerCompiler {
    /// Return the stable config string for this compiler.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Llvm => "llvm",
            Self::Cranelift => "cranelift",
            Self::Singlepass => "singlepass",
        }
    }

    pub(crate) fn flag(self) -> &'static str {
        match self {
            Self::Llvm => "--llvm",
            Self::Cranelift => "--cranelift",
            Self::Singlepass => "--singlepass",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "llvm" | "LLVM" => Ok(Self::Llvm),
            "cranelift" | "clif" | "Cranelift" => Ok(Self::Cranelift),
            "singlepass" | "single-pass" | "Singlepass" => Ok(Self::Singlepass),
            other => anyhow::bail!(
                "unknown Wasmer compiler {other:?}; expected llvm, cranelift, or singlepass"
            ),
        }
    }
}

impl fmt::Display for WasmerCompiler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for WasmerCompiler {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

/// PostgreSQL 18 WASIX btree bottom-up deletion mode.
///
/// PostgreSQL's upstream bottom-up deletion pass is correct but currently
/// expensive under WASIX for high-churn indexed updates. The server-core
/// runtime defaults to [`Off`](Self::Off) for lower p90 latency while keeping
/// [`PostgresDefault`](Self::PostgresDefault) available for exact upstream
/// behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasixBtreeBottomupDeleteMode {
    /// Use upstream PostgreSQL behavior.
    PostgresDefault,
    /// Skip all btree bottom-up deletion passes.
    Off,
    /// Skip bottom-up deletion when the index columns were unchanged.
    IndexUnchangedOff,
    /// Skip bottom-up deletion for unique-duplicate cleanup only.
    UniqueDuplicateOff,
}

impl WasixBtreeBottomupDeleteMode {
    /// Return the stable guest environment value for this mode.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PostgresDefault => "default",
            Self::Off => "off",
            Self::IndexUnchangedOff => "index-unchanged-off",
            Self::UniqueDuplicateOff => "unique-dup-off",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "0" | "on" | "default" | "postgres-default" | "upstream" => Ok(Self::PostgresDefault),
            "off" | "all-off" | "disable" | "disabled" => Ok(Self::Off),
            "index-unchanged-off" | "index-unchanged" | "unchanged" => Ok(Self::IndexUnchangedOff),
            "unique-dup-off" | "unique-dup" | "uniquedup" => Ok(Self::UniqueDuplicateOff),
            other => anyhow::bail!(
                "unknown PostgreSQL 18 WASIX btree bottom-up deletion mode {other:?}; expected default, off, index-unchanged-off, or unique-dup-off"
            ),
        }
    }
}

impl fmt::Display for WasixBtreeBottomupDeleteMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for WasixBtreeBottomupDeleteMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

/// Runtime controls for the PostgreSQL 18 WASIX server-core path.
///
/// PostgreSQL 18 server-core runs enable Wasmer LLVM native-CPU codegen, the
/// guarded LLVM indirect-call cache, and the WASIX bottom-up-delete latency
/// mode by default when supported. Set `PGLITE_OXIDE_WASMER_LLVM_NATIVE_CPU=0`,
/// `PGLITE_OXIDE_WASMER_LLVM_INDIRECT_CALL_CACHE=0`,
/// `PGLITE_OXIDE_WASIX_BTREE_BOTTOMUP_DELETE=default`, or use the
/// corresponding [`PgliteServerRuntimeConfig`] setters to disable a default.
///
/// Runtime controls also honor:
/// `PGLITE_OXIDE_WASMER_BIN`/`WASMER_BIN`,
/// `PGLITE_OXIDE_WASMER_DIR`/`WASMER_DIR`,
/// `PGLITE_OXIDE_WASMER_CACHE_DIR`/`WASMER_CACHE_DIR`,
/// `PGLITE_OXIDE_WASMER_COMPILER`, and
/// `PGLITE_OXIDE_SERVER_READY_TIMEOUT_MS`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PgliteServerRuntimeConfig {
    pub(crate) wasmer_bin: Option<PathBuf>,
    pub(crate) wasmer_home_dir: Option<PathBuf>,
    pub(crate) wasmer_cache_dir: Option<PathBuf>,
    pub(crate) wasmer_compiler: Option<WasmerCompiler>,
    pub(crate) wasmer_llvm_opt_level: Option<String>,
    pub(crate) wasmer_llvm_native_cpu: Option<bool>,
    pub(crate) wasmer_llvm_full_o3_pipeline: Option<bool>,
    pub(crate) wasmer_llvm_indirect_call_cache: Option<bool>,
    pub(crate) wasmer_profiler: Option<String>,
    pub(crate) wasmer_compiler_threads: Option<usize>,
    pub(crate) wasmer_enable_async_threads: Option<bool>,
    pub(crate) wasmer_no_tty: Option<bool>,
    pub(crate) wasix_btree_bottomup_delete: Option<WasixBtreeBottomupDeleteMode>,
    pub(crate) server_ready_timeout: Option<Duration>,
}

const DEFAULT_WASMER_LLVM_NATIVE_CPU: bool = true;
const DEFAULT_WASMER_LLVM_INDIRECT_CALL_CACHE: bool = true;
const DEFAULT_WASIX_BTREE_BOTTOMUP_DELETE: WasixBtreeBottomupDeleteMode =
    WasixBtreeBottomupDeleteMode::Off;
const WASIX_SERVER_GUEST_ENV_PASSTHROUGH: &[&str] =
    &["PGLITE_OXIDE_WASIX_DISABLE_BTREE_BOTTOMUP_DELETE"];

impl PgliteServerRuntimeConfig {
    /// Create an empty config that uses pglite-oxide defaults and env fallbacks.
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a specific Wasmer executable for PostgreSQL 18 server-core commands.
    pub fn wasmer_bin(mut self, path: impl Into<PathBuf>) -> Self {
        self.wasmer_bin = Some(path.into());
        self
    }

    /// Use a specific Wasmer home directory.
    pub fn wasmer_home_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.wasmer_home_dir = Some(path.into());
        self
    }

    /// Use a specific Wasmer compilation cache directory.
    pub fn wasmer_cache_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.wasmer_cache_dir = Some(path.into());
        self
    }

    /// Select the external Wasmer compiler.
    pub fn wasmer_compiler(mut self, compiler: WasmerCompiler) -> Self {
        self.wasmer_compiler = Some(compiler);
        self
    }

    /// Set the LLVM optimization level passed to Wasmer when LLVM is selected.
    pub fn wasmer_llvm_opt_level(mut self, level: impl Into<String>) -> Self {
        self.wasmer_llvm_opt_level = Some(level.into());
        self
    }

    /// Use LLVM's native host CPU target when compiling WASIX modules.
    pub fn wasmer_llvm_native_cpu(mut self, enabled: bool) -> Self {
        self.wasmer_llvm_native_cpu = Some(enabled);
        self
    }

    /// Use LLVM's full default O3 pass pipeline when supported by Wasmer.
    pub fn wasmer_llvm_full_o3_pipeline(mut self, enabled: bool) -> Self {
        self.wasmer_llvm_full_o3_pipeline = Some(enabled);
        self
    }

    /// Use Wasmer's guarded LLVM indirect-call cache when supported.
    pub fn wasmer_llvm_indirect_call_cache(mut self, enabled: bool) -> Self {
        self.wasmer_llvm_indirect_call_cache = Some(enabled);
        self
    }

    /// Set Wasmer's profiler, for example `perfmap` for JIT symbol maps.
    pub fn wasmer_profiler(mut self, profiler: impl Into<String>) -> Self {
        self.wasmer_profiler = Some(profiler.into());
        self
    }

    /// Set Wasmer compiler worker threads when supported by the CLI.
    pub fn wasmer_compiler_threads(mut self, threads: usize) -> Self {
        self.wasmer_compiler_threads = Some(threads);
        self
    }

    /// Control Wasmer's async-thread scheduler when supported by the CLI.
    pub fn wasmer_enable_async_threads(mut self, enabled: bool) -> Self {
        self.wasmer_enable_async_threads = Some(enabled);
        self
    }

    /// Disable Wasmer TTY handling when supported by the CLI.
    pub fn wasmer_no_tty(mut self, enabled: bool) -> Self {
        self.wasmer_no_tty = Some(enabled);
        self
    }

    /// Set the PostgreSQL 18 WASIX btree bottom-up deletion mode.
    pub fn wasix_btree_bottomup_delete(mut self, mode: WasixBtreeBottomupDeleteMode) -> Self {
        self.wasix_btree_bottomup_delete = Some(mode);
        self
    }

    /// Set how long to wait for PostgreSQL 18 server-core readiness.
    pub fn server_ready_timeout(mut self, timeout: Duration) -> Self {
        self.server_ready_timeout = Some(timeout);
        self
    }

    fn validate(&self) -> Result<()> {
        if let Some(threads) = self.wasmer_compiler_threads {
            anyhow::ensure!(
                threads > 0,
                "Wasmer compiler threads must be greater than zero"
            );
        }
        if let Some(timeout) = self.server_ready_timeout {
            anyhow::ensure!(
                !timeout.is_zero(),
                "PostgreSQL server readiness timeout must be greater than zero"
            );
        }
        if let Some(level) = &self.wasmer_llvm_opt_level {
            anyhow::ensure!(
                !level.is_empty() && !level.contains('\0'),
                "Wasmer LLVM optimization level must not be empty or contain NUL bytes"
            );
        }
        if let Some(profiler) = &self.wasmer_profiler {
            anyhow::ensure!(
                !profiler.is_empty() && !profiler.contains('\0'),
                "Wasmer profiler must not be empty or contain NUL bytes"
            );
        }
        Ok(())
    }
}

impl PgliteServer {
    /// Build a local PGlite server. The default is a cached temporary database
    /// served on `127.0.0.1:0`.
    pub fn builder() -> PgliteServerBuilder {
        PgliteServerBuilder::new()
    }

    /// Start a cached temporary database on a random local TCP port.
    pub fn temporary_tcp() -> Result<Self> {
        Self::builder().temporary().start()
    }

    /// Return the root directory used for runtime files and cluster data.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Return the bound TCP address, if this server is using TCP.
    pub fn tcp_addr(&self) -> Option<SocketAddr> {
        match self.endpoint {
            ServerEndpoint::Tcp(addr) => Some(addr),
            #[cfg(unix)]
            ServerEndpoint::Unix(_) => None,
        }
    }

    /// Return the Unix-domain socket path, if this server is using UDS.
    #[cfg(unix)]
    pub fn socket_path(&self) -> Option<&Path> {
        match &self.endpoint {
            ServerEndpoint::Tcp(_) => None,
            ServerEndpoint::Unix(path) => Some(path),
        }
    }

    /// Return dependency-light connection metadata for this server.
    pub fn connection_info(&self) -> PgliteServerConnectionInfo {
        PgliteServerConnectionInfo {
            endpoint: self.endpoint.clone(),
            username: self.startup_config.username.clone(),
            database: self.startup_config.database.clone(),
        }
    }

    /// Return a PostgreSQL connection URI for the local server.
    pub fn connection_uri(&self) -> String {
        self.connection_info().uri()
    }

    /// Alias for [`connection_uri`](Self::connection_uri).
    pub fn database_url(&self) -> String {
        self.connection_uri()
    }

    /// Return the operating-system process id for runtimes that run an
    /// external server process.
    ///
    /// The PostgreSQL 18 WASIX server-core runtime currently runs through an
    /// external Wasmer process and returns `Some(pid)`. Legacy in-process
    /// proxy mode returns `None`.
    pub fn server_process_id(&self) -> Option<u32> {
        self.server_process_id
    }

    /// Run the bundled WASIX `pg_dump` against this server and return SQL text.
    #[cfg(feature = "extensions")]
    pub fn dump_sql(&self, options: PgDumpOptions) -> Result<String> {
        let addr = self
            .tcp_addr()
            .context("pg_dump currently requires a TCP PgliteServer endpoint")?;
        if matches!(
            assets::runtime_kind()?.as_deref(),
            Some("wasix-postgres-server")
        ) {
            return dump_server_core_sql(
                self.root(),
                &self.runtime_module_root,
                addr,
                &options,
                &self.runtime_config,
            );
        }
        dump_server_sql(addr, &options)
    }

    /// Run the bundled WASIX `pg_dump` and return UTF-8 SQL bytes.
    #[cfg(feature = "extensions")]
    pub fn dump_bytes(&self, options: PgDumpOptions) -> Result<Vec<u8>> {
        Ok(self.dump_sql(options)?.into_bytes())
    }

    /// Request shutdown and wait for the listener thread to exit.
    ///
    /// Close database clients before calling this method. The current proxy owns
    /// one blocking backend connection at a time, so an open client can keep the
    /// worker thread busy until it disconnects.
    pub fn shutdown(mut self) -> Result<()> {
        self.stop()
    }

    fn stop(&mut self) -> Result<()> {
        self.shutdown.store(true, Ordering::SeqCst);
        {
            let _phase = timing::phase("server.shutdown_wake");
            wake_listener(&self.endpoint);
        }
        if let Some(handle) = self.handle.take() {
            let _phase = timing::phase("server.thread_join");
            handle
                .join()
                .map_err(|_| anyhow!("pglite server thread panicked"))??;
        }
        Ok(())
    }
}

impl Drop for PgliteServer {
    fn drop(&mut self) {
        if let Err(err) = self.stop() {
            tracing::warn!("pglite server shutdown during drop failed: {err:#}");
        }
    }
}

/// Builder for [`PgliteServer`].
#[derive(Debug, Clone)]
pub struct PgliteServerBuilder {
    root: ServerRoot,
    template_cache: bool,
    endpoint: ServerEndpointConfig,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    runtime_config: PgliteServerRuntimeConfig,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone)]
enum ServerRoot {
    Temporary,
    Path(PathBuf),
    AppId {
        qualifier: String,
        organization: String,
        application: String,
    },
}

#[derive(Debug, Clone)]
enum ServerEndpointConfig {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

impl Default for PgliteServerBuilder {
    fn default() -> Self {
        Self {
            root: ServerRoot::Temporary,
            template_cache: true,
            endpoint: ServerEndpointConfig::Tcp(SocketAddr::from(([127, 0, 0, 1], 0))),
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
            runtime_config: PgliteServerRuntimeConfig::default(),
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl PgliteServerBuilder {
    /// Create a builder. Defaults to a cached temporary database on
    /// `127.0.0.1:0`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Serve a persistent database rooted at `root`.
    pub fn path(mut self, root: impl Into<PathBuf>) -> Self {
        self.root = ServerRoot::Path(root.into());
        self
    }

    /// Serve a persistent database under the platform data directory.
    pub fn app(
        mut self,
        qualifier: impl Into<String>,
        organization: impl Into<String>,
        application: impl Into<String>,
    ) -> Self {
        self.root = ServerRoot::AppId {
            qualifier: qualifier.into(),
            organization: organization.into(),
            application: application.into(),
        };
        self
    }

    /// Serve a persistent database under the platform data directory.
    pub fn app_id(self, app_id: (&str, &str, &str)) -> Self {
        self.app(app_id.0, app_id.1, app_id.2)
    }

    /// Serve a temporary database cloned from the process-local template cache.
    pub fn temporary(mut self) -> Self {
        self.root = ServerRoot::Temporary;
        self
    }

    /// Serve a temporary database initialized without the template cache.
    ///
    /// This is a compatibility alias for the pre-template-cache public API.
    /// Fresh initdb uses the bundled split WASIX `initdb` module; cached
    /// temporary databases remain the production fast path.
    pub fn fresh_temporary(self) -> Self {
        self.temporary().template_cache(false)
    }

    /// Control whether new databases are cloned from the embedded PGDATA
    /// template cache.
    pub fn template_cache(mut self, enabled: bool) -> Self {
        self.template_cache = enabled;
        self
    }

    /// Bind the server to a TCP address.
    pub fn tcp(mut self, addr: SocketAddr) -> Self {
        self.endpoint = ServerEndpointConfig::Tcp(addr);
        self
    }

    /// Bind the server to a Unix-domain socket path.
    #[cfg(unix)]
    pub fn unix(mut self, path: impl Into<PathBuf>) -> Self {
        self.endpoint = ServerEndpointConfig::Unix(path.into());
        self
    }

    /// Set a PostgreSQL startup GUC for the embedded backend used by this
    /// server.
    pub fn postgres_config(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.postgres_config.insert(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs for the embedded backend used by
    /// this server.
    pub fn postgres_configs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        for (name, value) in settings {
            self.postgres_config.insert(name, value);
        }
        self
    }

    /// Default user encoded in [`PgliteServer::database_url`].
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.startup_config.username = username.into();
        self
    }

    /// Default database encoded in [`PgliteServer::database_url`].
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.startup_config.database = database.into();
        self
    }

    /// Enable PostgreSQL debug logging level `0..=5` for server backends.
    pub fn debug_level(mut self, level: DebugLevel) -> Self {
        self.startup_config.debug_level = Some(level);
        self
    }

    /// Use lower durability settings for ephemeral or cacheable local
    /// workloads.
    pub fn relaxed_durability(mut self, enabled: bool) -> Self {
        self.startup_config.relaxed_durability = enabled;
        self
    }

    /// Append an advanced PostgreSQL startup argument for server backends.
    pub fn startup_arg(mut self, arg: impl Into<String>) -> Self {
        self.startup_config.extra_args.push(arg.into());
        self
    }

    /// Append advanced PostgreSQL startup arguments for server backends.
    pub fn startup_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.startup_config
            .extra_args
            .extend(args.into_iter().map(Into::into));
        self
    }

    /// Replace the PostgreSQL 18 WASIX server-core runtime config.
    pub fn runtime_config(mut self, config: PgliteServerRuntimeConfig) -> Self {
        self.runtime_config = config;
        self
    }

    /// Use a specific Wasmer executable for PostgreSQL 18 server-core commands.
    pub fn wasmer_bin(mut self, path: impl Into<PathBuf>) -> Self {
        self.runtime_config = self.runtime_config.wasmer_bin(path);
        self
    }

    /// Use a specific Wasmer home directory for PostgreSQL 18 server-core.
    pub fn wasmer_home_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.runtime_config = self.runtime_config.wasmer_home_dir(path);
        self
    }

    /// Use a specific Wasmer compilation cache directory for PostgreSQL 18
    /// server-core.
    pub fn wasmer_cache_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.runtime_config = self.runtime_config.wasmer_cache_dir(path);
        self
    }

    /// Select the external Wasmer compiler for PostgreSQL 18 server-core.
    pub fn wasmer_compiler(mut self, compiler: WasmerCompiler) -> Self {
        self.runtime_config = self.runtime_config.wasmer_compiler(compiler);
        self
    }

    /// Set the LLVM optimization level passed to Wasmer when LLVM is selected.
    pub fn wasmer_llvm_opt_level(mut self, level: impl Into<String>) -> Self {
        self.runtime_config = self.runtime_config.wasmer_llvm_opt_level(level);
        self
    }

    /// Use LLVM's native host CPU target for PostgreSQL 18 server-core.
    pub fn wasmer_llvm_native_cpu(mut self, enabled: bool) -> Self {
        self.runtime_config = self.runtime_config.wasmer_llvm_native_cpu(enabled);
        self
    }

    /// Use LLVM's full default O3 pass pipeline for PostgreSQL 18 server-core.
    pub fn wasmer_llvm_full_o3_pipeline(mut self, enabled: bool) -> Self {
        self.runtime_config = self.runtime_config.wasmer_llvm_full_o3_pipeline(enabled);
        self
    }

    /// Use Wasmer's guarded LLVM indirect-call cache for PostgreSQL 18
    /// server-core.
    pub fn wasmer_llvm_indirect_call_cache(mut self, enabled: bool) -> Self {
        self.runtime_config = self.runtime_config.wasmer_llvm_indirect_call_cache(enabled);
        self
    }

    /// Set Wasmer's profiler for PostgreSQL 18 server-core.
    pub fn wasmer_profiler(mut self, profiler: impl Into<String>) -> Self {
        self.runtime_config = self.runtime_config.wasmer_profiler(profiler);
        self
    }

    /// Set Wasmer compiler worker threads when supported by the CLI.
    pub fn wasmer_compiler_threads(mut self, threads: usize) -> Self {
        self.runtime_config = self.runtime_config.wasmer_compiler_threads(threads);
        self
    }

    /// Control Wasmer's async-thread scheduler when supported by the CLI.
    pub fn wasmer_enable_async_threads(mut self, enabled: bool) -> Self {
        self.runtime_config = self.runtime_config.wasmer_enable_async_threads(enabled);
        self
    }

    /// Disable Wasmer TTY handling when supported by the CLI.
    pub fn wasmer_no_tty(mut self, enabled: bool) -> Self {
        self.runtime_config = self.runtime_config.wasmer_no_tty(enabled);
        self
    }

    /// Set the PostgreSQL 18 WASIX btree bottom-up deletion mode.
    pub fn wasix_btree_bottomup_delete(mut self, mode: WasixBtreeBottomupDeleteMode) -> Self {
        self.runtime_config = self.runtime_config.wasix_btree_bottomup_delete(mode);
        self
    }

    /// Set how long to wait for PostgreSQL 18 server-core readiness.
    pub fn server_ready_timeout(mut self, timeout: Duration) -> Self {
        self.runtime_config = self.runtime_config.server_ready_timeout(timeout);
        self
    }

    /// Enable a bundled Postgres extension before serving connections.
    #[cfg(feature = "extensions")]
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Enable bundled Postgres extensions before serving connections.
    #[cfg(feature = "extensions")]
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Install the runtime if needed, initialize the cluster, and start serving.
    pub fn start(self) -> Result<PgliteServer> {
        self.postgres_config.validate()?;
        self.startup_config.validate()?;
        self.runtime_config.validate()?;
        let use_server_core = matches!(
            assets::runtime_kind()?.as_deref(),
            Some("wasix-postgres-server")
        );
        #[cfg(feature = "extensions")]
        let extensions = resolve_extension_set(&self.extensions)?;
        #[cfg(feature = "extensions")]
        if use_server_core && !extensions.is_empty() {
            anyhow::bail!(
                "bundled extension preinstall is not available for the PostgreSQL 18 WASIX server-core runtime yet"
            );
        }
        let postgres_config = self.postgres_config.clone();
        let startup_config = self.startup_config.clone();
        let runtime_config = self.runtime_config.clone();
        let template_cache = self.template_cache;

        let prepared_root = {
            let _phase = timing::phase("server.root_prepare");
            match self.root {
                ServerRoot::Path(root) => {
                    let _phase = timing::phase("server.root_prepare.path");
                    let plan =
                        RootPlan::new(RootTarget::Path(root), server_root_source(template_cache));
                    #[cfg(feature = "extensions")]
                    let plan = plan
                        .with_startup_config(startup_config.clone())
                        .with_extensions(extensions.clone(), postgres_config.clone());
                    prepare_root_for_runtime(plan, use_server_core)?
                }
                ServerRoot::AppId {
                    qualifier,
                    organization,
                    application,
                } => {
                    let _phase = timing::phase("server.root_prepare.app_id");
                    let plan = RootPlan::new(
                        RootTarget::AppId {
                            qualifier,
                            organization,
                            application,
                        },
                        server_root_source(template_cache),
                    );
                    #[cfg(feature = "extensions")]
                    let plan = plan
                        .with_startup_config(startup_config.clone())
                        .with_extensions(extensions.clone(), postgres_config.clone());
                    prepare_root_for_runtime(plan, use_server_core)?
                }
                ServerRoot::Temporary => {
                    let source = server_root_source(template_cache);
                    let phase = if template_cache {
                        "server.root_prepare.temporary_cached"
                    } else {
                        "server.root_prepare.temporary_fresh"
                    };
                    let _phase = timing::phase(phase);
                    let plan = RootPlan::new(RootTarget::Temporary, source);
                    #[cfg(feature = "extensions")]
                    let plan = plan
                        .with_startup_config(startup_config.clone())
                        .with_extensions(extensions.clone(), postgres_config.clone());
                    run_blocking("pglite-template-cache", move || {
                        prepare_root_for_runtime(plan, use_server_core)
                    })?
                }
            }
        };
        let PreparedRoot {
            root,
            temp_dir,
            root_lock,
            outcome,
        } = prepared_root;
        let runtime_module_root = outcome.runtime_layout.module_root.clone();

        let shutdown = Arc::new(AtomicBool::new(false));
        let (endpoint, handle, server_process_id) = if use_server_core {
            start_server_core(
                outcome,
                self.endpoint,
                postgres_config,
                startup_config.clone(),
                runtime_config.clone(),
                shutdown.clone(),
            )?
        } else {
            let proxy = {
                let _phase = timing::phase("server.proxy_create");
                PgliteProxy::new(root.clone()).with_prepared_root(outcome)
            };
            let proxy = proxy
                .with_postgres_config(postgres_config)
                .with_startup_config(startup_config.clone());
            #[cfg(feature = "extensions")]
            let proxy = proxy.with_extensions(extensions);

            match self.endpoint {
                ServerEndpointConfig::Tcp(addr) => {
                    let (endpoint, handle) = start_tcp(proxy, addr, shutdown.clone())?;
                    (endpoint, handle, None)
                }
                #[cfg(unix)]
                ServerEndpointConfig::Unix(path) => {
                    let (endpoint, handle) = start_unix(proxy, path, shutdown.clone())?;
                    (endpoint, handle, None)
                }
            }
        };

        Ok(PgliteServer {
            root,
            _temp_dir: temp_dir,
            _root_lock: root_lock,
            endpoint,
            startup_config,
            runtime_config,
            runtime_module_root,
            server_process_id,
            shutdown,
            handle: Some(handle),
        })
    }
}

fn prepare_root_for_runtime(plan: RootPlan, use_server_core: bool) -> Result<PreparedRoot> {
    if use_server_core {
        prepare_server_core_root(plan)
    } else {
        prepare_root(plan)
    }
}

fn server_root_source(template_cache: bool) -> RootSource {
    if template_cache {
        RootSource::Template
    } else {
        RootSource::FreshInitdb
    }
}

fn start_server_core(
    outcome: InstallOutcome,
    endpoint: ServerEndpointConfig,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    runtime_config: PgliteServerRuntimeConfig,
    shutdown: Arc<AtomicBool>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>, Option<u32>)> {
    let endpoint = match endpoint {
        ServerEndpointConfig::Tcp(addr) => {
            let addr = reserve_tcp_addr(addr)?;
            ensure_server_core_cluster(&outcome, &startup_config, &runtime_config)?;
            cleanup_server_core_dev_shm(&outcome)?;
            let mut child = spawn_server_core_postgres(
                &outcome,
                addr,
                &postgres_config,
                &startup_config,
                &runtime_config,
            )?;
            let log_path = server_core_log_path(&outcome, "postgres.log")?;
            {
                let _phase = timing::phase("server.pg18_wait_ready");
                wait_for_server_core_ready(
                    addr,
                    &startup_config,
                    &runtime_config,
                    &mut child,
                    &log_path,
                )?;
            }
            let process_id = child.id();
            let handle =
                spawn_server_core_supervisor(child, shutdown, server_core_dev_shm_dir(&outcome))?;
            (ServerEndpoint::Tcp(addr), handle, Some(process_id))
        }
        #[cfg(unix)]
        ServerEndpointConfig::Unix(_) => {
            anyhow::bail!(
                "Unix socket endpoints are not enabled for the PostgreSQL 18 WASIX server-core runtime yet; use PgliteServerBuilder::tcp"
            );
        }
    };
    Ok(endpoint)
}

fn reserve_tcp_addr(addr: SocketAddr) -> Result<SocketAddr> {
    if addr.port() != 0 {
        return Ok(addr);
    }
    let listener = TcpListener::bind(addr).context("reserve PostgreSQL server TCP port")?;
    listener
        .local_addr()
        .context("read reserved PostgreSQL server TCP port")
}

fn ensure_server_core_cluster(
    outcome: &InstallOutcome,
    startup_config: &StartupConfig,
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<()> {
    if outcome.paths.is_cluster_initialized() {
        return Ok(());
    }

    let _phase = timing::phase("server.pg18_initdb");
    let log_path = server_core_log_path(outcome, "initdb.log")?;
    let mut command = server_core_wasmer_command(
        outcome,
        &outcome.runtime_layout.module_root.join("bin/initdb"),
        startup_config,
        runtime_config,
    )?;
    command
        .arg("-D")
        .arg(&outcome.paths.pgdata)
        .arg("-A")
        .arg("trust")
        .arg("--no-locale")
        .arg("--encoding=UTF8")
        .arg("--no-instructions")
        .arg("--username")
        .arg(&startup_config.username);

    run_logged_command(command, &log_path, "WASIX PostgreSQL initdb")?;
    anyhow::ensure!(
        outcome.paths.is_cluster_initialized(),
        "WASIX PostgreSQL initdb finished but did not create a complete PGDATA cluster at {}",
        outcome.paths.pgdata.display()
    );
    Ok(())
}

fn spawn_server_core_postgres(
    outcome: &InstallOutcome,
    addr: SocketAddr,
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<Child> {
    let _phase = timing::phase("server.pg18_spawn");
    let log_path = server_core_log_path(outcome, "postgres.log")?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("open PostgreSQL WASIX server log {}", log_path.display()))?;
    let mut command = server_core_wasmer_command(
        outcome,
        &outcome.runtime_layout.postgres_server_path(),
        startup_config,
        runtime_config,
    )?;
    command
        .arg("-D")
        .arg(&outcome.paths.pgdata)
        .arg("-h")
        .arg(addr.ip().to_string())
        .arg("-p")
        .arg(addr.port().to_string())
        .arg("-c")
        .arg("unix_socket_directories=");

    apply_server_core_startup_args(&mut command, postgres_config, startup_config);
    command
        .stdout(Stdio::from(
            log.try_clone()
                .with_context(|| format!("clone {}", log_path.display()))?,
        ))
        .stderr(Stdio::from(log));
    command.spawn().with_context(|| {
        format!(
            "spawn PostgreSQL 18 WASIX server; log={}",
            log_path.display()
        )
    })
}

fn apply_server_core_startup_args(
    command: &mut Command,
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
) {
    for (name, value) in SERVER_CORE_DEFAULT_STARTUP_GUCS {
        if !postgres_config_contains(postgres_config, name) {
            command.arg("-c").arg(format!("{name}={value}"));
        }
    }

    if startup_config.relaxed_durability {
        for (name, value) in [
            ("fsync", "off"),
            ("synchronous_commit", "off"),
            ("full_page_writes", "off"),
        ] {
            if !postgres_config_contains(postgres_config, name) {
                command.arg("-c").arg(format!("{name}={value}"));
            }
        }
    }

    if let Some(level) = startup_config.debug_level {
        command.arg("-d").arg(level.to_string());
    }

    for (name, value) in postgres_config.iter() {
        command.arg("-c").arg(format!("{name}={value}"));
    }
    for arg in &startup_config.extra_args {
        command.arg(arg);
    }
}

const SERVER_CORE_DEFAULT_STARTUP_GUCS: &[(&str, &str)] = &[
    ("search_path", "public"),
    ("exit_on_error", "false"),
    ("fsync", "off"),
    ("log_checkpoints", "false"),
    ("max_worker_processes", "0"),
    ("max_parallel_workers", "0"),
    ("max_parallel_workers_per_gather", "0"),
    ("autovacuum", "off"),
    ("wal_buffers", "4MB"),
    ("min_wal_size", "80MB"),
    ("shared_buffers", "128MB"),
    ("log_timezone", "UTC"),
    ("TimeZone", "UTC"),
];

fn postgres_config_contains(postgres_config: &PostgresConfig, name: &str) -> bool {
    postgres_config
        .iter()
        .any(|(configured, _)| configured == name)
}

fn spawn_server_core_supervisor(
    mut child: Child,
    shutdown: Arc<AtomicBool>,
    dev_shm: PathBuf,
) -> Result<JoinHandle<Result<()>>> {
    let recorder = timing::current_recorder();
    thread::Builder::new()
        .name("pglite-pg18-server".to_owned())
        .spawn(move || {
            timing::with_recorder(recorder, || {
                let cleanup = || {
                    if let Err(err) = cleanup_server_core_dev_shm_dir(&dev_shm) {
                        tracing::warn!("failed to clean PostgreSQL WASIX shared memory: {err:#}");
                    }
                };
                loop {
                    if shutdown.load(Ordering::SeqCst) {
                        match child.try_wait().context("poll PostgreSQL WASIX server")? {
                            Some(status) => {
                                cleanup();
                                if status.success() {
                                    return Ok(());
                                }
                                return Err(anyhow!(
                                    "PostgreSQL WASIX server exited during shutdown with {status}"
                                ));
                            }
                            None => {
                                let _ = child.kill();
                                let status =
                                    child.wait().context("wait for PostgreSQL WASIX server")?;
                                cleanup();
                                if status.success() {
                                    return Ok(());
                                }
                                return Ok(());
                            }
                        }
                    }
                    if let Some(status) =
                        child.try_wait().context("poll PostgreSQL WASIX server")?
                    {
                        cleanup();
                        if status.success() {
                            return Ok(());
                        }
                        return Err(anyhow!("PostgreSQL WASIX server exited with {status}"));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            })
        })
        .context("spawn PostgreSQL WASIX server supervisor")
}

fn server_core_wasmer_command(
    outcome: &InstallOutcome,
    module: &Path,
    startup_config: &StartupConfig,
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<Command> {
    anyhow::ensure!(
        module.is_file(),
        "missing PostgreSQL WASIX module {}",
        module.display()
    );
    let wasmer = locate_wasmer_bin(runtime_config)?;
    let root = outcome.paths.install_root();
    let runtime_root = &outcome.runtime_layout.module_root;
    let dev_shm = server_core_dev_shm_dir(outcome);
    let wasmer_home = runtime_config.wasmer_home_dir.clone().unwrap_or_else(|| {
        env_path_or_default(
            "PGLITE_OXIDE_WASMER_DIR",
            "WASMER_DIR",
            default_server_core_wasmer_dir("home"),
        )
    });
    let wasmer_cache = runtime_config.wasmer_cache_dir.clone().unwrap_or_else(|| {
        env_path_or_default(
            "PGLITE_OXIDE_WASMER_CACHE_DIR",
            "WASMER_CACHE_DIR",
            default_server_core_wasmer_dir("cache"),
        )
    });
    let home = root.join("home").join(&startup_config.username);
    for dir in [&dev_shm, &wasmer_home, &wasmer_cache, &home] {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }

    let mut command = Command::new(&wasmer);
    apply_wasmer_native_cpu_env(&mut command, runtime_config);
    command
        .env("WASMER_DIR", &wasmer_home)
        .env("WASMER_CACHE_DIR", &wasmer_cache)
        .env("USER", &startup_config.username)
        .env("LOGNAME", &startup_config.username)
        .env("HOME", &home)
        .env("PGCLIENTENCODING", "UTF8")
        .env("TZ", "UTC")
        .env("PGTZ", "UTC")
        .env("PG_COLOR", "never")
        .arg("run");
    if wasmer_cli_has_option(&wasmer, "run", "--quiet") {
        command.arg("--quiet");
    }
    append_optional_wasmer_flag(
        &wasmer,
        &mut command,
        runtime_config.wasmer_no_tty,
        ["PGLITE_OXIDE_WASMER_NO_TTY", "WASMER_NO_TTY"],
        "--no-tty",
    )?;
    append_wasmer_compiler_args(&wasmer, &mut command, runtime_config)?;
    append_required_wasmer_run_arg(&wasmer, &mut command, "--stack-size", Some("33554432"))?;
    append_required_wasmer_run_arg(&wasmer, &mut command, "--enable-exceptions", None)?;
    append_required_wasmer_run_arg(&wasmer, &mut command, "--enable-threads", None)?;
    append_required_wasmer_run_arg(&wasmer, &mut command, "--net", None)?;
    append_required_wasmer_volume(&wasmer, &mut command, root, root)?;
    if !runtime_root.starts_with(root) {
        append_required_wasmer_volume(&wasmer, &mut command, runtime_root, runtime_root)?;
    }
    append_required_wasmer_volume(
        &wasmer,
        &mut command,
        &runtime_root.join("lib"),
        Path::new("/lib"),
    )?;
    append_required_wasmer_volume(&wasmer, &mut command, &dev_shm, Path::new("/dev/shm"))?;
    for (name, value) in [
        ("USER", startup_config.username.as_str()),
        ("LOGNAME", startup_config.username.as_str()),
        ("HOME", &home.display().to_string()),
        ("PGCLIENTENCODING", "UTF8"),
        ("TZ", "UTC"),
        ("PGTZ", "UTC"),
        ("PG_COLOR", "never"),
    ] {
        append_required_wasmer_guest_env(&wasmer, &mut command, name, value)?;
    }
    append_default_wasix_guest_envs(&wasmer, &mut command, runtime_config)?;
    append_optional_wasmer_guest_env_from_host(&wasmer, &mut command)?;
    command.arg(module).arg("--");
    Ok(command)
}

fn server_core_dev_shm_dir(outcome: &InstallOutcome) -> PathBuf {
    outcome.paths.install_root().join("dev-shm")
}

fn cleanup_server_core_dev_shm(outcome: &InstallOutcome) -> Result<()> {
    cleanup_server_core_dev_shm_dir(&server_core_dev_shm_dir(outcome))
}

fn cleanup_server_core_dev_shm_dir(dev_shm: &Path) -> Result<()> {
    match fs::read_dir(dev_shm) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.with_context(|| format!("read {}", dev_shm.display()))?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("postgresql-wasix-") {
                    continue;
                }
                let path = entry.path();
                let file_type = entry
                    .file_type()
                    .with_context(|| format!("stat {}", path.display()))?;
                if file_type.is_dir() {
                    fs::remove_dir_all(&path)
                        .with_context(|| format!("remove stale {}", path.display()))?;
                } else {
                    fs::remove_file(&path)
                        .with_context(|| format!("remove stale {}", path.display()))?;
                }
            }
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("read {}", dev_shm.display())),
    }
}

fn env_path_or_default(primary: &str, fallback: &str, default: PathBuf) -> PathBuf {
    env::var_os(primary)
        .or_else(|| env::var_os(fallback))
        .map(PathBuf::from)
        .unwrap_or(default)
}

fn default_server_core_wasmer_dir(kind: &str) -> PathBuf {
    ProjectDirs::from("dev", "pglite-oxide", "pglite-oxide")
        .map(|dirs| dirs.cache_dir().join("pg18-wasmer").join(kind))
        .unwrap_or_else(|| {
            env::temp_dir()
                .join("pglite-oxide")
                .join("pg18-wasmer")
                .join(kind)
        })
}

fn append_required_wasmer_run_arg(
    wasmer: &Path,
    command: &mut Command,
    option: &str,
    value: Option<&str>,
) -> Result<()> {
    anyhow::ensure!(
        wasmer_cli_has_option(wasmer, "run", option),
        "Wasmer CLI {} does not support required `wasmer run {option}` for the PostgreSQL 18 WASIX server runtime",
        wasmer.display()
    );
    command.arg(option);
    if let Some(value) = value {
        command.arg(value);
    }
    Ok(())
}

fn append_required_wasmer_volume(
    wasmer: &Path,
    command: &mut Command,
    host: &Path,
    guest: &Path,
) -> Result<()> {
    anyhow::ensure!(
        wasmer_cli_has_option(wasmer, "run", "--volume"),
        "Wasmer CLI {} does not support required `wasmer run --volume` for the PostgreSQL 18 WASIX server runtime",
        wasmer.display()
    );
    command
        .arg("--volume")
        .arg(format!("{}:{}", host.display(), guest.display()));
    Ok(())
}

fn append_required_wasmer_guest_env(
    wasmer: &Path,
    command: &mut Command,
    name: &str,
    value: &str,
) -> Result<()> {
    anyhow::ensure!(
        wasmer_cli_has_option(wasmer, "run", "--env"),
        "Wasmer CLI {} does not support required `wasmer run --env` for the PostgreSQL 18 WASIX server runtime",
        wasmer.display()
    );
    command.arg("--env").arg(format!("{name}={value}"));
    Ok(())
}

fn append_optional_wasmer_guest_env_from_host(wasmer: &Path, command: &mut Command) -> Result<()> {
    for name in WASIX_SERVER_GUEST_ENV_PASSTHROUGH {
        let Some(value) = env::var_os(name) else {
            continue;
        };
        let value = value
            .into_string()
            .map_err(|_| anyhow!("{name} must be valid UTF-8"))?;
        append_required_wasmer_guest_env(wasmer, command, name, &value)?;
    }
    Ok(())
}

fn append_default_wasix_guest_envs(
    wasmer: &Path,
    command: &mut Command,
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<()> {
    let bottomup_mode = wasix_btree_bottomup_delete_mode(runtime_config)?;
    append_required_wasmer_guest_env(
        wasmer,
        command,
        "PGLITE_OXIDE_WASIX_BTREE_BOTTOMUP_DELETE",
        bottomup_mode.as_str(),
    )?;
    Ok(())
}

fn wasix_btree_bottomup_delete_mode(
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<WasixBtreeBottomupDeleteMode> {
    if let Some(mode) = runtime_config.wasix_btree_bottomup_delete {
        return Ok(mode);
    }
    let Some(value) = env::var_os("PGLITE_OXIDE_WASIX_BTREE_BOTTOMUP_DELETE") else {
        return Ok(DEFAULT_WASIX_BTREE_BOTTOMUP_DELETE);
    };
    let value = value
        .into_string()
        .map_err(|_| anyhow!("PGLITE_OXIDE_WASIX_BTREE_BOTTOMUP_DELETE must be valid UTF-8"))?;
    if value.trim().is_empty() {
        return Ok(DEFAULT_WASIX_BTREE_BOTTOMUP_DELETE);
    }
    WasixBtreeBottomupDeleteMode::parse(value.trim())
}

fn append_wasmer_compiler_args(
    wasmer: &Path,
    command: &mut Command,
    runtime_config: &PgliteServerRuntimeConfig,
) -> Result<()> {
    let explicit_compiler = env::var_os("PGLITE_OXIDE_WASMER_COMPILER")
        .or_else(|| env::var_os("WASMER_COMPILER"))
        .or_else(|| env::var_os("WASMER_BACKEND"));
    let (requested, explicit) = if let Some(compiler) = runtime_config.wasmer_compiler {
        (compiler, true)
    } else if let Some(value) = explicit_compiler.as_deref().and_then(OsStr::to_str) {
        (WasmerCompiler::parse(value)?, true)
    } else {
        (WasmerCompiler::Llvm, false)
    };
    let compiler_flag = requested.flag();

    if wasmer_cli_has_option(wasmer, "run", compiler_flag) {
        command.arg(compiler_flag);
        if requested == WasmerCompiler::Llvm
            && wasmer_cli_has_option(wasmer, "run", "--llvm-opt-level")
        {
            let opt_level = runtime_config
                .wasmer_llvm_opt_level
                .clone()
                .or_else(|| env::var("PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL").ok())
                .or_else(|| env::var("WASMER_LLVM_OPT_LEVEL").ok())
                .unwrap_or_else(|| "aggressive".to_owned());
            command.arg("--llvm-opt-level").arg(opt_level);
            append_optional_wasmer_flag(
                wasmer,
                command,
                runtime_config.wasmer_llvm_full_o3_pipeline,
                [
                    "PGLITE_OXIDE_WASMER_LLVM_FULL_O3_PIPELINE",
                    "WASMER_LLVM_FULL_O3_PIPELINE",
                ],
                "--llvm-full-o3-pipeline",
            )?;
            append_defaultable_wasmer_llvm_flag(
                wasmer,
                command,
                runtime_config.wasmer_llvm_indirect_call_cache,
                [
                    "PGLITE_OXIDE_WASMER_LLVM_INDIRECT_CALL_CACHE",
                    "WASMER_LLVM_INDIRECT_CALL_CACHE",
                ],
                "--llvm-indirect-call-cache",
                DEFAULT_WASMER_LLVM_INDIRECT_CALL_CACHE,
            )?;
        }
    } else if explicit {
        anyhow::bail!(
            "requested Wasmer compiler {requested:?}, but {} does not expose `wasmer run {compiler_flag}`",
            wasmer.display()
        );
    } else {
        tracing::warn!(
            "Wasmer CLI {} does not expose `wasmer run {compiler_flag}`; using its default compiler",
            wasmer.display()
        );
    }

    if let Some(profiler) = runtime_config
        .wasmer_profiler
        .clone()
        .or_else(|| env::var("PGLITE_OXIDE_WASMER_PROFILER").ok())
        .or_else(|| env::var("WASMER_PROFILER").ok())
    {
        anyhow::ensure!(
            wasmer_cli_has_option(wasmer, "run", "--profiler"),
            "Wasmer CLI {} does not support requested `wasmer run --profiler {profiler}`",
            wasmer.display()
        );
        command.arg("--profiler").arg(profiler);
    }

    append_optional_wasmer_bool_value_arg(
        wasmer,
        command,
        runtime_config.wasmer_enable_async_threads,
        [
            "PGLITE_OXIDE_WASMER_ENABLE_ASYNC_THREADS",
            "WASMER_ENABLE_ASYNC_THREADS",
        ],
        "--enable-async-threads",
    )?;

    if wasmer_cli_has_option(wasmer, "run", "--compiler-threads") {
        let threads = runtime_config
            .wasmer_compiler_threads
            .or_else(|| {
                env::var("PGLITE_OXIDE_WASMER_COMPILER_THREADS")
                    .or_else(|_| env::var("WASMER_COMPILER_THREADS"))
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
            })
            .unwrap_or_else(|| {
                thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(4)
            });
        command.arg("--compiler-threads").arg(threads.to_string());
    }
    Ok(())
}

fn append_optional_wasmer_flag(
    wasmer: &Path,
    command: &mut Command,
    configured: Option<bool>,
    env_names: [&str; 2],
    option: &str,
) -> Result<()> {
    if !runtime_bool_or_env(configured, env_names) {
        return Ok(());
    }
    anyhow::ensure!(
        wasmer_cli_has_option(wasmer, "run", option),
        "Wasmer CLI {} does not support requested `wasmer run {option}`",
        wasmer.display()
    );
    command.arg(option);
    Ok(())
}

fn append_defaultable_wasmer_llvm_flag(
    wasmer: &Path,
    command: &mut Command,
    configured: Option<bool>,
    env_names: [&str; 2],
    option: &str,
    default_enabled: bool,
) -> Result<()> {
    let explicit = runtime_bool_value(configured, env_names);
    let enabled = explicit.unwrap_or(default_enabled);
    if !enabled {
        return Ok(());
    }
    if wasmer_cli_has_option(wasmer, "run", option) {
        command.arg(option);
        return Ok(());
    }
    anyhow::ensure!(
        explicit != Some(true),
        "Wasmer CLI {} does not support requested `wasmer run {option}`",
        wasmer.display()
    );
    tracing::warn!(
        "Wasmer CLI {} does not expose `wasmer run {option}`; continuing without the default LLVM flag",
        wasmer.display()
    );
    Ok(())
}

fn append_optional_wasmer_bool_value_arg(
    wasmer: &Path,
    command: &mut Command,
    configured: Option<bool>,
    env_names: [&str; 2],
    option: &str,
) -> Result<()> {
    let Some(enabled) = runtime_bool_value(configured, env_names) else {
        return Ok(());
    };
    anyhow::ensure!(
        wasmer_cli_has_option(wasmer, "run", option),
        "Wasmer CLI {} does not support requested `wasmer run {option}`",
        wasmer.display()
    );
    command.arg(format!("{option}={enabled}"));
    Ok(())
}

fn apply_wasmer_native_cpu_env(command: &mut Command, runtime_config: &PgliteServerRuntimeConfig) {
    let enabled = runtime_bool_value(
        runtime_config.wasmer_llvm_native_cpu,
        [
            "PGLITE_OXIDE_WASMER_LLVM_NATIVE_CPU",
            "WASMER_LLVM_NATIVE_CPU",
        ],
    )
    .unwrap_or(DEFAULT_WASMER_LLVM_NATIVE_CPU);
    command.env("WASMER_LLVM_NATIVE_CPU", if enabled { "1" } else { "0" });
}

fn runtime_bool_or_env(configured: Option<bool>, env_names: [&str; 2]) -> bool {
    runtime_bool_value(configured, env_names).unwrap_or(false)
}

fn runtime_bool_value(configured: Option<bool>, env_names: [&str; 2]) -> Option<bool> {
    configured.or_else(|| env_names.into_iter().find_map(env_bool_value))
}

fn env_bool_value(name: &str) -> Option<bool> {
    env::var(name).ok().map(|value| {
        let value = value.trim();
        !value.is_empty()
            && !matches!(
                value.to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
    })
}

fn locate_wasmer_bin(runtime_config: &PgliteServerRuntimeConfig) -> Result<PathBuf> {
    if let Some(path) = &runtime_config.wasmer_bin {
        return resolve_program(path.as_os_str()).with_context(|| {
            format!(
                "configured Wasmer binary {} is not executable",
                path.display()
            )
        });
    }
    for name in ["PGLITE_OXIDE_WASMER_BIN", "WASMER_BIN"] {
        if let Some(value) = env::var_os(name) {
            return resolve_program(&value)
                .with_context(|| format!("{name} is set but does not resolve to an executable"));
        }
    }
    if let Some(path) = source_checkout_wasmer_bin() {
        return Ok(path);
    }
    resolve_program(OsStr::new("wasmer")).context(
        "Wasmer CLI is required for the PostgreSQL 18 WASIX server runtime; set PGLITE_OXIDE_WASMER_BIN, build the repo-local Wasmer checkout, or install wasmer on PATH",
    )
}

fn source_checkout_wasmer_bin() -> Option<PathBuf> {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/wasix-build/work/upstream/wasmer/target/release/wasmer");
    candidate.is_file().then_some(candidate)
}

fn resolve_program(value: &OsStr) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.components().count() > 1 {
        if path.is_file() {
            return Ok(path);
        }
        anyhow::bail!("{} is not an executable file", path.display());
    }

    let paths = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&paths) {
        let candidate = dir.join(&path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("program {:?} was not found on PATH", value);
}

static WASMER_CLI_HELP_CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), Option<String>>>> =
    OnceLock::new();

fn wasmer_cli_has_option(wasmer: &Path, subcommand: &str, option: &str) -> bool {
    wasmer_cli_help(wasmer, subcommand)
        .as_deref()
        .is_some_and(|help| help.contains(option))
}

fn wasmer_cli_help(wasmer: &Path, subcommand: &str) -> Option<String> {
    let key = (wasmer.to_path_buf(), subcommand.to_owned());
    let cache = WASMER_CLI_HELP_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(help) = cache
        .lock()
        .expect("Wasmer CLI help cache poisoned")
        .get(&key)
        .cloned()
    {
        return help;
    }

    let help = load_wasmer_cli_help(wasmer, subcommand);
    cache
        .lock()
        .expect("Wasmer CLI help cache poisoned")
        .entry(key)
        .or_insert_with(|| help.clone())
        .clone()
}

fn load_wasmer_cli_help(wasmer: &Path, subcommand: &str) -> Option<String> {
    let Ok(output) = Command::new(wasmer).arg(subcommand).arg("--help").output() else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    let mut help = String::from_utf8_lossy(&output.stdout).into_owned();
    help.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(help)
}

fn run_logged_command(mut command: Command, log_path: &Path, label: &str) -> Result<()> {
    let output = command
        .output()
        .with_context(|| format!("run {label}; log={}", log_path.display()))?;
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut log = Vec::new();
    log.extend_from_slice(&output.stdout);
    log.extend_from_slice(&output.stderr);
    fs::write(log_path, &log).with_context(|| format!("write {}", log_path.display()))?;
    anyhow::ensure!(
        output.status.success(),
        "{label} failed with {}; log tail:\n{}",
        output.status,
        String::from_utf8_lossy(&tail_bytes(&log, 16 * 1024))
    );
    Ok(())
}

fn wait_for_server_core_ready(
    addr: SocketAddr,
    startup_config: &StartupConfig,
    runtime_config: &PgliteServerRuntimeConfig,
    child: &mut Child,
    log_path: &Path,
) -> Result<()> {
    let timeout = server_core_ready_timeout(runtime_config);
    let started = Instant::now();
    let deadline = started + timeout;
    let mut last_error: Option<anyhow::Error> = None;
    let mut poll_total = Duration::ZERO;
    let mut log_total = Duration::ZERO;
    let mut probe_total = Duration::ZERO;
    let mut sleep_total = Duration::ZERO;
    while Instant::now() < deadline {
        let poll_started = Instant::now();
        let child_status = child.try_wait().context("poll PostgreSQL WASIX server")?;
        poll_total += poll_started.elapsed();
        if let Some(status) = child_status {
            record_server_core_ready_subtotals(poll_total, log_total, probe_total, sleep_total);
            anyhow::bail!(
                "PostgreSQL WASIX server exited before readiness with {status}; log tail:\n{}",
                read_log_tail(log_path)
            );
        }
        let log_started = Instant::now();
        let log_ready = match server_core_log_reports_ready(log_path) {
            Ok(ready) => ready,
            Err(err) => {
                last_error = Some(err);
                false
            }
        };
        let log_elapsed = log_started.elapsed();
        log_total += log_elapsed;
        let probe_started = Instant::now();
        let elapsed = started.elapsed();
        if !log_ready && elapsed < server_core_ready_probe_fallback_delay() {
            let sleep_interval = server_core_ready_sleep_interval(elapsed, log_elapsed);
            if !sleep_interval.is_zero() {
                let sleep_started = Instant::now();
                thread::sleep(sleep_interval);
                sleep_total += sleep_started.elapsed();
            }
            continue;
        }
        let probe = probe_postgres_startup(
            addr,
            startup_config,
            server_core_ready_probe_io_timeout(elapsed),
        );
        let probe_elapsed = probe_started.elapsed();
        probe_total += probe_elapsed;
        match probe {
            Ok(()) => {
                record_server_core_ready_subtotals(poll_total, log_total, probe_total, sleep_total);
                return Ok(());
            }
            Err(err) => last_error = Some(err),
        }
        let sleep_interval =
            server_core_ready_sleep_interval(started.elapsed(), log_elapsed + probe_elapsed);
        if !sleep_interval.is_zero() {
            let sleep_started = Instant::now();
            thread::sleep(sleep_interval);
            sleep_total += sleep_started.elapsed();
        }
    }

    record_server_core_ready_subtotals(poll_total, log_total, probe_total, sleep_total);
    let _ = child.kill();
    let _ = child.wait();
    let detail = last_error
        .map(|err| format!("{err:#}"))
        .unwrap_or_else(|| "no readiness probe was attempted".to_owned());
    anyhow::bail!(
        "PostgreSQL WASIX server did not become ready within {:?}: {detail}; log tail:\n{}",
        timeout,
        read_log_tail(log_path)
    )
}

fn record_server_core_ready_subtotals(
    poll_total: Duration,
    log_total: Duration,
    probe_total: Duration,
    sleep_total: Duration,
) {
    timing::record_phase_timing("server.pg18_wait_ready.poll_total", poll_total);
    timing::record_phase_timing("server.pg18_wait_ready.log_total", log_total);
    timing::record_phase_timing("server.pg18_wait_ready.probe_total", probe_total);
    timing::record_phase_timing("server.pg18_wait_ready.sleep_total", sleep_total);
}

fn server_core_ready_poll_interval(elapsed: Duration) -> Duration {
    if elapsed < Duration::from_secs(2) {
        Duration::from_millis(25)
    } else {
        Duration::from_millis(100)
    }
}

fn server_core_ready_sleep_interval(elapsed: Duration, probe_elapsed: Duration) -> Duration {
    server_core_ready_poll_interval(elapsed)
        .checked_sub(probe_elapsed)
        .unwrap_or(Duration::ZERO)
}

fn server_core_ready_probe_io_timeout(elapsed: Duration) -> Duration {
    if elapsed < Duration::from_secs(10) {
        Duration::from_millis(250)
    } else {
        Duration::from_secs(2)
    }
}

fn server_core_ready_probe_fallback_delay() -> Duration {
    Duration::from_secs(2)
}

fn server_core_ready_timeout(runtime_config: &PgliteServerRuntimeConfig) -> Duration {
    runtime_config.server_ready_timeout.unwrap_or_else(|| {
        env::var("PGLITE_OXIDE_SERVER_READY_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(180))
    })
}

fn server_core_log_reports_ready(path: &Path) -> Result<bool> {
    const READY_MARKER: &[u8] = b"database system is ready to accept connections";

    match fs::read(path) {
        Ok(bytes) => Ok(bytes
            .windows(READY_MARKER.len())
            .any(|window| window == READY_MARKER)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
    }
}

fn probe_postgres_startup(
    addr: SocketAddr,
    startup_config: &StartupConfig,
    io_timeout: Duration,
) -> Result<()> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))
        .with_context(|| format!("connect PostgreSQL startup probe to {addr}"))?;
    stream
        .set_read_timeout(Some(io_timeout))
        .context("set PostgreSQL startup probe read timeout")?;
    stream
        .set_write_timeout(Some(io_timeout))
        .context("set PostgreSQL startup probe write timeout")?;
    stream
        .write_all(&startup_message(startup_config)?)
        .context("write PostgreSQL startup probe")?;
    loop {
        let mut header = [0_u8; 5];
        stream
            .read_exact(&mut header)
            .context("read PostgreSQL startup response header")?;
        let tag = header[0];
        let len = i32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        anyhow::ensure!(len >= 4, "invalid PostgreSQL response length {len}");
        let mut payload = vec![0_u8; (len - 4) as usize];
        stream
            .read_exact(&mut payload)
            .context("read PostgreSQL startup response payload")?;
        match tag {
            b'R' => {
                let auth = payload
                    .get(0..4)
                    .map(|bytes| i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                    .unwrap_or(-1);
                anyhow::ensure!(
                    auth == 0,
                    "PostgreSQL startup probe requires unsupported authentication code {auth}"
                );
            }
            b'E' => anyhow::bail!(
                "PostgreSQL startup probe failed: {}",
                postgres_error_message(&payload)
            ),
            b'Z' => {
                let _ = stream.write_all(&[b'X', 0, 0, 0, 4]);
                return Ok(());
            }
            _ => {}
        }
    }
}

fn startup_message(startup_config: &StartupConfig) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    body.extend_from_slice(&196608_i32.to_be_bytes());
    for (name, value) in [
        ("user", startup_config.username.as_str()),
        ("database", startup_config.database.as_str()),
        ("client_encoding", "UTF8"),
    ] {
        anyhow::ensure!(
            !name.contains('\0') && !value.contains('\0'),
            "PostgreSQL startup parameter contains a NUL byte"
        );
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let len = i32::try_from(body.len() + 4).context("PostgreSQL startup message too large")?;
    let mut message = Vec::with_capacity(body.len() + 4);
    message.extend_from_slice(&len.to_be_bytes());
    message.extend_from_slice(&body);
    Ok(message)
}

fn postgres_error_message(payload: &[u8]) -> String {
    let mut message = None;
    let mut fields = payload.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let (kind, value) = field.split_at(1);
        if kind == b"M" {
            message = Some(String::from_utf8_lossy(value).into_owned());
            break;
        }
    }
    message.unwrap_or_else(|| String::from_utf8_lossy(payload).into_owned())
}

fn server_core_log_path(outcome: &InstallOutcome, name: &str) -> Result<PathBuf> {
    let dir = outcome.paths.install_root().join("logs");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join(name))
}

fn read_log_tail(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&tail_bytes(&bytes, 16 * 1024)).into_owned(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => "<log not created>".to_owned(),
        Err(err) => format!("<failed to read {}: {err}>", path.display()),
    }
}

fn tail_bytes(bytes: &[u8], max: usize) -> Vec<u8> {
    if bytes.len() <= max {
        bytes.to_vec()
    } else {
        bytes[bytes.len() - max..].to_vec()
    }
}

fn start_tcp(
    proxy: PgliteProxy,
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>)> {
    let listener = {
        let _phase = timing::phase("server.tcp_bind");
        TcpListener::bind(addr).context("bind PGlite TCP server")?
    };
    let addr = {
        let _phase = timing::phase("server.tcp_local_addr");
        listener.local_addr().context("read PGlite TCP address")?
    };
    let (ready_tx, ready_rx) = sync_channel(1);
    let recorder = timing::current_recorder();
    let handle = {
        let _phase = timing::phase("server.thread_spawn");
        thread::spawn(move || {
            timing::with_recorder(recorder, || {
                proxy.serve_tcp_listener_until_ready(listener, shutdown, Some(ready_tx))
            })
        })
    };
    {
        let _phase = timing::phase("server.wait_ready");
        wait_until_ready(&ready_rx)?;
    }
    Ok((ServerEndpoint::Tcp(addr), handle))
}

fn connection_uri_for(endpoint: &ServerEndpoint, username: &str, database: &str) -> String {
    match endpoint {
        ServerEndpoint::Tcp(addr) => tcp_connection_uri(*addr, username, database),
        #[cfg(unix)]
        ServerEndpoint::Unix(path) => unix_connection_uri(path, username, database),
    }
}

fn tcp_connection_uri(addr: SocketAddr, username: &str, database: &str) -> String {
    let username = percent_encode_uri_component(username, false);
    let database = percent_encode_uri_component(database, false);
    match addr {
        SocketAddr::V4(addr) => {
            format!(
                "postgresql://{}@{}:{}/{}?sslmode=disable",
                username,
                addr.ip(),
                addr.port(),
                database
            )
        }
        SocketAddr::V6(addr) => {
            format!(
                "postgresql://{}@[{}]:{}/{}?sslmode=disable",
                username,
                addr.ip(),
                addr.port(),
                database
            )
        }
    }
}

#[cfg(unix)]
fn unix_connection_uri(path: &Path, username: &str, database: &str) -> String {
    let username = percent_encode_uri_component(username, false);
    let database = percent_encode_uri_component(database, false);
    let host = path.parent().unwrap_or_else(|| Path::new("/tmp"));
    let port = parse_unix_socket_port(path).unwrap_or(5432);
    format!(
        "postgresql://{}@/{}?host={}&port={}&sslmode=disable",
        username,
        database,
        percent_encode_query_value(&host.display().to_string()),
        port
    )
}

fn run_blocking<T, F>(name: &'static str, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let recorder = timing::current_recorder();
    thread::Builder::new()
        .name(name.to_string())
        .spawn(move || timing::with_recorder(recorder, f))
        .with_context(|| format!("spawn {name} worker"))?
        .join()
        .map_err(|_| anyhow!("{name} worker panicked"))?
}

#[cfg(unix)]
fn start_unix(
    proxy: PgliteProxy,
    path: PathBuf,
    shutdown: Arc<AtomicBool>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>)> {
    {
        let _phase = timing::phase("server.unix_prepare_path");
        if path.exists() {
            std::fs::remove_file(&path)
                .with_context(|| format!("remove stale socket {}", path.display()))?;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create socket directory {}", parent.display()))?;
        }
    }

    let listener = {
        let _phase = timing::phase("server.unix_bind");
        UnixListener::bind(&path)
            .with_context(|| format!("bind PGlite Unix socket {}", path.display()))?
    };
    let endpoint = ServerEndpoint::Unix(path);
    let (ready_tx, ready_rx) = sync_channel(1);
    let recorder = timing::current_recorder();
    let handle = {
        let _phase = timing::phase("server.thread_spawn");
        thread::spawn(move || {
            timing::with_recorder(recorder, || {
                proxy.serve_unix_listener_until_ready(listener, shutdown, Some(ready_tx))
            })
        })
    };
    {
        let _phase = timing::phase("server.wait_ready");
        wait_until_ready(&ready_rx)?;
    }
    Ok((endpoint, handle))
}

fn wait_until_ready(ready_rx: &Receiver<Result<()>>) -> Result<()> {
    ready_rx
        .recv()
        .context("PGlite server thread exited before reporting readiness")?
}

fn wake_listener(endpoint: &ServerEndpoint) {
    match endpoint {
        ServerEndpoint::Tcp(addr) => {
            let _ = TcpStream::connect(addr);
        }
        #[cfg(unix)]
        ServerEndpoint::Unix(path) => {
            let _ = UnixStream::connect(path);
        }
    }
}

#[cfg(unix)]
fn parse_unix_socket_port(path: &Path) -> Option<u16> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix(".s.PGSQL.")?.parse().ok()
}

fn percent_encode_query_value(value: &str) -> String {
    percent_encode_uri_component(value, true)
}

fn percent_encode_uri_component(value: &str, allow_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
        ) || (allow_slash && byte == b'/');
        if keep {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::{
        ServerEndpoint, connection_uri_for, percent_encode_query_value, tcp_connection_uri,
    };

    #[test]
    fn tcp_connection_uri_percent_encodes_user_and_database() {
        let addr = SocketAddr::from(([127, 0, 0, 1], 5432));

        assert_eq!(
            tcp_connection_uri(addr, "user name@example.com", "db/name?x=1"),
            "postgresql://user%20name%40example.com@127.0.0.1:5432/db%2Fname%3Fx%3D1?sslmode=disable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_connection_uri_percent_encodes_identity_and_host_query() {
        let endpoint = ServerEndpoint::Unix("/tmp/Application Support/.s.PGSQL.6543".into());

        assert_eq!(
            connection_uri_for(&endpoint, "user name@example.com", "db/name?x=1"),
            "postgresql://user%20name%40example.com@/db%2Fname%3Fx%3D1?host=/tmp/Application%20Support&port=6543&sslmode=disable"
        );
    }

    #[test]
    fn unix_socket_uri_host_is_query_encoded() {
        assert_eq!(
            percent_encode_query_value("/tmp/Application Support/pglite"),
            "/tmp/Application%20Support/pglite"
        );
    }
}

#[cfg(test)]
mod runtime_config_tests {
    use std::{fs, time::Duration};

    use tempfile::NamedTempFile;

    use super::{
        PgliteServer, PgliteServerRuntimeConfig, ServerRoot, WasixBtreeBottomupDeleteMode,
        WasmerCompiler, server_core_ready_timeout,
    };

    #[test]
    fn runtime_config_rejects_invalid_explicit_values() {
        let err = PgliteServerRuntimeConfig::new()
            .wasmer_compiler_threads(0)
            .validate()
            .expect_err("zero compiler threads should be rejected");
        assert!(err.to_string().contains("greater than zero"));

        let err = PgliteServerRuntimeConfig::new()
            .server_ready_timeout(Duration::ZERO)
            .validate()
            .expect_err("zero readiness timeout should be rejected");
        assert!(err.to_string().contains("greater than zero"));
    }

    #[test]
    fn server_core_ready_poll_interval_starts_fast_then_backs_off() {
        assert_eq!(
            super::server_core_ready_poll_interval(Duration::from_millis(0)),
            Duration::from_millis(25)
        );
        assert_eq!(
            super::server_core_ready_poll_interval(Duration::from_millis(1999)),
            Duration::from_millis(25)
        );
        assert_eq!(
            super::server_core_ready_poll_interval(Duration::from_secs(2)),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn server_core_ready_sleep_interval_counts_probe_time_toward_cadence() {
        assert_eq!(
            super::server_core_ready_sleep_interval(
                Duration::from_millis(100),
                Duration::from_millis(5)
            ),
            Duration::from_millis(20)
        );
        assert_eq!(
            super::server_core_ready_sleep_interval(
                Duration::from_millis(100),
                Duration::from_millis(25)
            ),
            Duration::ZERO
        );
        assert_eq!(
            super::server_core_ready_sleep_interval(
                Duration::from_secs(2),
                Duration::from_millis(30)
            ),
            Duration::from_millis(70)
        );
    }

    #[test]
    fn server_core_ready_probe_io_timeout_starts_short_then_relaxes() {
        assert_eq!(
            super::server_core_ready_probe_io_timeout(Duration::from_millis(0)),
            Duration::from_millis(250)
        );
        assert_eq!(
            super::server_core_ready_probe_io_timeout(Duration::from_millis(9999)),
            Duration::from_millis(250)
        );
        assert_eq!(
            super::server_core_ready_probe_io_timeout(Duration::from_secs(10)),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn server_core_log_reports_ready_marker() -> anyhow::Result<()> {
        let log = NamedTempFile::new()?;
        assert!(!super::server_core_log_reports_ready(log.path())?);

        fs::write(
            log.path(),
            "2026-05-15 10:00:00 UTC LOG:  database system is ready to accept connections\n",
        )?;
        assert!(super::server_core_log_reports_ready(log.path())?);
        assert!(!super::server_core_log_reports_ready(
            &log.path().with_extension("missing")
        )?);
        Ok(())
    }

    #[test]
    fn server_builder_exposes_pg18_runtime_controls() {
        let timeout = Duration::from_millis(250);
        let builder = PgliteServer::builder()
            .wasmer_bin("/opt/wasmer/bin/wasmer")
            .wasmer_home_dir("/tmp/pglite-wasmer-home")
            .wasmer_cache_dir("/tmp/pglite-wasmer-cache")
            .wasmer_compiler(WasmerCompiler::Cranelift)
            .wasmer_llvm_opt_level("aggressive")
            .wasmer_llvm_native_cpu(true)
            .wasmer_llvm_full_o3_pipeline(true)
            .wasmer_llvm_indirect_call_cache(true)
            .wasmer_profiler("perfmap")
            .wasmer_compiler_threads(2)
            .wasmer_enable_async_threads(false)
            .wasmer_no_tty(true)
            .wasix_btree_bottomup_delete(WasixBtreeBottomupDeleteMode::Off)
            .server_ready_timeout(timeout);

        assert_eq!(
            builder.runtime_config.wasmer_bin.as_deref(),
            Some(std::path::Path::new("/opt/wasmer/bin/wasmer"))
        );
        assert_eq!(
            builder.runtime_config.wasmer_compiler,
            Some(WasmerCompiler::Cranelift)
        );
        assert_eq!(
            builder.runtime_config.wasmer_llvm_opt_level.as_deref(),
            Some("aggressive")
        );
        assert_eq!(builder.runtime_config.wasmer_llvm_native_cpu, Some(true));
        assert_eq!(
            builder.runtime_config.wasmer_llvm_full_o3_pipeline,
            Some(true)
        );
        assert_eq!(
            builder.runtime_config.wasmer_llvm_indirect_call_cache,
            Some(true)
        );
        assert_eq!(
            builder.runtime_config.wasmer_profiler.as_deref(),
            Some("perfmap")
        );
        assert_eq!(builder.runtime_config.wasmer_compiler_threads, Some(2));
        assert_eq!(
            builder.runtime_config.wasmer_enable_async_threads,
            Some(false)
        );
        assert_eq!(builder.runtime_config.wasmer_no_tty, Some(true));
        assert_eq!(
            builder.runtime_config.wasix_btree_bottomup_delete,
            Some(WasixBtreeBottomupDeleteMode::Off)
        );
        assert_eq!(server_core_ready_timeout(&builder.runtime_config), timeout);
    }

    #[test]
    fn server_builder_exposes_persistent_app_roots_and_template_control() {
        let builder = PgliteServer::builder()
            .app("dev", "oxide-tests", "pg18")
            .template_cache(false);

        match &builder.root {
            ServerRoot::AppId {
                qualifier,
                organization,
                application,
            } => {
                assert_eq!(qualifier, "dev");
                assert_eq!(organization, "oxide-tests");
                assert_eq!(application, "pg18");
            }
            other => panic!("expected app root, got {other:?}"),
        }
        assert!(!builder.template_cache);

        let builder = builder.app_id(("dev", "oxide-tests", "pg18-again"));
        match &builder.root {
            ServerRoot::AppId { application, .. } => {
                assert_eq!(application, "pg18-again");
            }
            other => panic!("expected app root, got {other:?}"),
        }
    }

    #[test]
    fn wasmer_compiler_accepts_env_compatible_names() {
        assert_eq!(
            WasmerCompiler::parse("single-pass").unwrap(),
            WasmerCompiler::Singlepass
        );
        assert_eq!(
            "cranelift".parse::<WasmerCompiler>().unwrap(),
            WasmerCompiler::Cranelift
        );
        assert_eq!(WasmerCompiler::Llvm.to_string(), "llvm");
        assert_eq!(WasmerCompiler::Cranelift.flag(), "--cranelift");
    }

    #[test]
    fn wasix_btree_bottomup_delete_mode_accepts_guest_env_values() {
        assert_eq!(
            WasixBtreeBottomupDeleteMode::parse("default").unwrap(),
            WasixBtreeBottomupDeleteMode::PostgresDefault
        );
        assert_eq!(
            WasixBtreeBottomupDeleteMode::parse("off").unwrap(),
            WasixBtreeBottomupDeleteMode::Off
        );
        assert_eq!(
            WasixBtreeBottomupDeleteMode::parse("index-unchanged-off").unwrap(),
            WasixBtreeBottomupDeleteMode::IndexUnchangedOff
        );
        assert_eq!(
            WasixBtreeBottomupDeleteMode::parse("unique-dup-off").unwrap(),
            WasixBtreeBottomupDeleteMode::UniqueDuplicateOff
        );
    }
}
