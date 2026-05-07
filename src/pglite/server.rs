use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, sync_channel},
};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow};
use tempfile::TempDir;

use crate::pglite::base::{PreparedRoot, RootLock, RootPlan, RootSource, RootTarget, prepare_root};
use crate::pglite::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::pglite::extensions::{Extension, resolve_extension_set};
use crate::pglite::interface::DebugLevel;
#[cfg(feature = "extensions")]
use crate::pglite::pg_dump::{PgDumpOptions, dump_server_sql};
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
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<Result<()>>>,
}

#[derive(Debug, Clone)]
enum ServerEndpoint {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
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

    /// Return a PostgreSQL connection URI for the local server.
    pub fn connection_uri(&self) -> String {
        match &self.endpoint {
            ServerEndpoint::Tcp(addr) => tcp_connection_uri(*addr, &self.startup_config),
            #[cfg(unix)]
            ServerEndpoint::Unix(path) => {
                let host = path.parent().unwrap_or_else(|| Path::new("/tmp"));
                let port = parse_unix_socket_port(path).unwrap_or(5432);
                format!(
                    "postgresql://{}@/{}?host={}&port={}&sslmode=disable",
                    self.startup_config.username,
                    self.startup_config.database,
                    percent_encode_query_value(&host.display().to_string()),
                    port
                )
            }
        }
    }

    /// Alias for [`connection_uri`](Self::connection_uri).
    pub fn database_url(&self) -> String {
        self.connection_uri()
    }

    /// Run the bundled WASIX `pg_dump` against this server and return SQL text.
    #[cfg(feature = "extensions")]
    pub fn dump_sql(&self, options: PgDumpOptions) -> Result<String> {
        let addr = self
            .tcp_addr()
            .context("pg_dump currently requires a TCP PgliteServer endpoint")?;
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
    endpoint: ServerEndpointConfig,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone)]
enum ServerRoot {
    Temporary { template_cache: bool },
    Path(PathBuf),
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
            root: ServerRoot::Temporary {
                template_cache: true,
            },
            endpoint: ServerEndpointConfig::Tcp(SocketAddr::from(([127, 0, 0, 1], 0))),
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
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

    /// Serve a temporary database cloned from the process-local template cache.
    pub fn temporary(mut self) -> Self {
        self.root = ServerRoot::Temporary {
            template_cache: true,
        };
        self
    }

    /// Serve a temporary database initialized without the template cache.
    ///
    /// This is a compatibility alias for the pre-template-cache public API.
    /// Fresh initdb uses the bundled split WASIX `initdb` module; cached
    /// temporary databases remain the production fast path.
    pub fn fresh_temporary(mut self) -> Self {
        self.root = ServerRoot::Temporary {
            template_cache: false,
        };
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
        #[cfg(feature = "extensions")]
        let extensions = resolve_extension_set(&self.extensions)?;
        let postgres_config = self.postgres_config.clone();
        let startup_config = self.startup_config.clone();

        let prepared_root = {
            let _phase = timing::phase("server.root_prepare");
            match self.root {
                ServerRoot::Path(root) => {
                    let _phase = timing::phase("server.root_prepare.path");
                    let plan = RootPlan::new(RootTarget::Path(root), RootSource::Template);
                    #[cfg(feature = "extensions")]
                    let plan = plan.with_extensions(extensions.clone(), postgres_config.clone());
                    prepare_root(plan)?
                }
                ServerRoot::Temporary { template_cache } => {
                    let source = if template_cache {
                        RootSource::Template
                    } else {
                        RootSource::FreshInitdb
                    };
                    let phase = if template_cache {
                        "server.root_prepare.temporary_cached"
                    } else {
                        "server.root_prepare.temporary_fresh"
                    };
                    let _phase = timing::phase(phase);
                    let plan = RootPlan::new(RootTarget::Temporary, source);
                    #[cfg(feature = "extensions")]
                    let plan = plan.with_extensions(extensions.clone(), postgres_config.clone());
                    run_blocking("pglite-template-cache", move || prepare_root(plan))?
                }
            }
        };
        let PreparedRoot {
            root,
            temp_dir,
            root_lock,
            outcome,
        } = prepared_root;

        let shutdown = Arc::new(AtomicBool::new(false));
        let proxy = {
            let _phase = timing::phase("server.proxy_create");
            PgliteProxy::new(root.clone()).with_prepared_root(outcome)
        };
        let proxy = proxy
            .with_postgres_config(postgres_config)
            .with_startup_config(startup_config.clone());
        #[cfg(feature = "extensions")]
        let proxy = proxy.with_extensions(extensions);

        let (endpoint, handle) = match self.endpoint {
            ServerEndpointConfig::Tcp(addr) => start_tcp(proxy, addr, shutdown.clone())?,
            #[cfg(unix)]
            ServerEndpointConfig::Unix(path) => start_unix(proxy, path, shutdown.clone())?,
        };

        Ok(PgliteServer {
            root,
            _temp_dir: temp_dir,
            _root_lock: root_lock,
            endpoint,
            startup_config,
            shutdown,
            handle: Some(handle),
        })
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

fn tcp_connection_uri(addr: SocketAddr, startup: &StartupConfig) -> String {
    match addr {
        SocketAddr::V4(addr) => {
            format!(
                "postgresql://{}@{}:{}/{}?sslmode=disable",
                startup.username,
                addr.ip(),
                addr.port(),
                startup.database
            )
        }
        SocketAddr::V6(addr) => {
            format!(
                "postgresql://{}@[{}]:{}/{}?sslmode=disable",
                startup.username,
                addr.ip(),
                addr.port(),
                startup.database
            )
        }
    }
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

#[cfg(unix)]
fn percent_encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/'
        ) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(all(test, unix))]
mod tests {
    use super::percent_encode_query_value;

    #[test]
    fn unix_socket_uri_host_is_query_encoded() {
        assert_eq!(
            percent_encode_query_value("/tmp/Application Support/pglite"),
            "/tmp/Application%20Support/pglite"
        );
    }
}
