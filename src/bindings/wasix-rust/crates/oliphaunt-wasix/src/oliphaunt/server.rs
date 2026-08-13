use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
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

use crate::oliphaunt::base::{DatabasePlan, DirectoryLock, PreparedDatabase, prepare_database};
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::{
    Extension, postgres_config_with_extension_startup, resolve_extension_set,
};
use crate::oliphaunt::interface::DebugLevel;
#[cfg(feature = "tools")]
use crate::oliphaunt::pg_dump::{
    PgDumpOptions, PsqlOptions, dump_server_sql, preflight_wasix_tools, run_server_psql,
};
use crate::oliphaunt::proxy::OliphauntProxy;
use crate::oliphaunt::storage::{DatabaseInitialization, DatabaseStorage};
use crate::oliphaunt::timing;

/// A supervised local PostgreSQL socket backed by one embedded Oliphaunt runtime.
///
/// Use this entry point for code that expects a PostgreSQL URI, such as
/// `tokio-postgres`, SQLx, or tools that speak the wire protocol. The
/// server owns one embedded backend, so downstream pools should use a single
/// connection.
#[derive(Debug)]
pub struct OliphauntServer {
    _workspace: Option<TempDir>,
    _directory_lock: Option<DirectoryLock>,
    endpoint: ServerEndpoint,
    startup_config: StartupConfig,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<Result<()>>>,
    #[cfg(unix)]
    owned_unix_socket: Option<OwnedUnixSocket>,
}

#[derive(Debug, Clone)]
enum ServerEndpoint {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(UnixSocketEndpoint),
}

#[cfg(unix)]
#[derive(Debug, Clone)]
struct UnixSocketEndpoint {
    path: PathBuf,
    port: u16,
}

#[cfg(unix)]
#[derive(Debug)]
struct OwnedUnixSocket {
    path: PathBuf,
    identity: Option<(u64, u64)>,
}

impl OliphauntServer {
    /// Build a local Oliphaunt server. The default is an in-memory database
    /// served on `127.0.0.1:0`.
    pub fn builder() -> OliphauntServerBuilder {
        OliphauntServerBuilder::new()
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
            ServerEndpoint::Unix(endpoint) => Some(&endpoint.path),
        }
    }

    /// Return a PostgreSQL connection URI for the local server.
    pub fn connection_uri(&self) -> String {
        match &self.endpoint {
            ServerEndpoint::Tcp(addr) => tcp_connection_uri(*addr, &self.startup_config),
            #[cfg(unix)]
            ServerEndpoint::Unix(endpoint) => unix_connection_uri(endpoint, &self.startup_config),
        }
    }

    /// Run the bundled WASIX `pg_dump` against this server and return SQL text.
    #[cfg(feature = "tools")]
    pub fn dump_sql(&self, options: PgDumpOptions) -> Result<String> {
        let addr = self
            .tcp_addr()
            .context("pg_dump currently requires a TCP OliphauntServer endpoint")?;
        dump_server_sql(addr, &options)
    }

    /// Validate that split WASIX `pg_dump` and `psql` artifacts are installed
    /// and loadable for this server before invoking either tool.
    #[cfg(feature = "tools")]
    pub fn preflight_tools(&self) -> Result<()> {
        self.tcp_addr()
            .context("WASIX pg_dump and psql currently require a TCP OliphauntServer endpoint")?;
        preflight_wasix_tools()
    }

    /// Run the bundled WASIX `pg_dump` and return UTF-8 SQL bytes.
    #[cfg(feature = "tools")]
    pub fn dump_bytes(&self, options: PgDumpOptions) -> Result<Vec<u8>> {
        Ok(self.dump_sql(options)?.into_bytes())
    }

    /// Run the bundled WASIX `psql` against this server and return stdout text.
    #[cfg(feature = "tools")]
    pub fn psql(&self, options: PsqlOptions) -> Result<String> {
        let addr = self
            .tcp_addr()
            .context("psql currently requires a TCP OliphauntServer endpoint")?;
        run_server_psql(addr, &options)
    }

    /// Run the bundled WASIX `psql` and return stdout bytes.
    #[cfg(feature = "tools")]
    pub fn psql_bytes(&self, options: PsqlOptions) -> Result<Vec<u8>> {
        Ok(self.psql(options)?.into_bytes())
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
        let worker_result = if let Some(handle) = self.handle.take() {
            let _phase = timing::phase("server.thread_join");
            match handle.join() {
                Ok(result) => result,
                Err(_) => Err(anyhow!("oliphaunt server thread panicked")),
            }
        } else {
            Ok(())
        };
        #[cfg(unix)]
        let socket_result = if let Some(mut socket) = self.owned_unix_socket.take() {
            socket.cleanup()
        } else {
            Ok(())
        };
        #[cfg(not(unix))]
        let socket_result = Ok::<(), anyhow::Error>(());

        match (worker_result, socket_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(worker), Err(socket)) => Err(anyhow!(
                "Oliphaunt server worker failed: {worker:#}; Unix socket cleanup also failed: {socket:#}"
            )),
        }
    }
}

impl Drop for OliphauntServer {
    fn drop(&mut self) {
        if let Err(err) = self.stop() {
            tracing::warn!("oliphaunt server shutdown during drop failed: {err:#}");
        }
    }
}

/// Builder for [`OliphauntServer`].
#[derive(Debug, Clone)]
pub struct OliphauntServerBuilder {
    storage: DatabaseStorage,
    initialization: DatabaseInitialization,
    endpoint: ServerEndpointConfig,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone)]
enum ServerEndpointConfig {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

impl Default for OliphauntServerBuilder {
    fn default() -> Self {
        Self {
            storage: DatabaseStorage::Memory,
            initialization: DatabaseInitialization::PackagedTemplate,
            endpoint: ServerEndpointConfig::Tcp(SocketAddr::from(([127, 0, 0, 1], 0))),
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl OliphauntServerBuilder {
    /// Create a builder. Defaults to a memory database on `127.0.0.1:0`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select where PostgreSQL stores its mutable database files.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.storage = storage;
        self
    }

    /// Select how an empty storage allocation is initialized.
    pub fn initialization(mut self, initialization: DatabaseInitialization) -> Self {
        self.initialization = initialization;
        self
    }

    /// Bind the server to a TCP address.
    pub fn tcp(mut self, addr: SocketAddr) -> Self {
        self.endpoint = ServerEndpointConfig::Tcp(addr);
        self
    }

    /// Bind the server to a PostgreSQL Unix-domain socket path.
    ///
    /// The filename must use PostgreSQL's `.s.PGSQL.<port>` convention so
    /// [`OliphauntServer::connection_uri`] can address the bound socket. A
    /// relative path is resolved against the current working directory.
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

    /// Default user encoded in [`OliphauntServer::connection_uri`].
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.startup_config.username = username.into();
        self
    }

    /// Default database encoded in [`OliphauntServer::connection_uri`].
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

    /// Append an advanced PostgreSQL startup option for server backends.
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
    pub fn start(self) -> Result<OliphauntServer> {
        #[cfg(unix)]
        let unix_endpoint = match &self.endpoint {
            ServerEndpointConfig::Unix(path) => Some(resolve_unix_socket_endpoint(path)?),
            ServerEndpointConfig::Tcp(_) => None,
        };

        #[cfg(feature = "extensions")]
        let (extensions, postgres_config) = self.resolved_extension_startup()?;
        #[cfg(not(feature = "extensions"))]
        let postgres_config = self.postgres_config.clone();
        postgres_config.validate()?;
        self.startup_config.validate()?;
        let startup_config = self.startup_config.clone();

        let prepared_database = {
            let _phase = timing::phase("server.storage_prepare");
            let plan = DatabasePlan::new(self.storage.clone(), self.initialization.clone());
            #[cfg(feature = "extensions")]
            let plan = plan.with_extensions(extensions.clone(), postgres_config.clone());
            run_blocking("oliphaunt-storage-prepare", move || prepare_database(plan))?
        };
        let PreparedDatabase {
            workspace,
            directory_lock,
            outcome,
        } = prepared_database;

        let shutdown = Arc::new(AtomicBool::new(false));
        let proxy = {
            let _phase = timing::phase("server.proxy_create");
            OliphauntProxy::from_prepared_database(outcome)
        };
        let proxy = proxy
            .with_postgres_config(postgres_config)
            .with_startup_config(startup_config.clone());
        #[cfg(feature = "extensions")]
        let proxy = proxy.with_extensions(extensions);

        #[cfg(unix)]
        let (endpoint, handle, owned_unix_socket) = match self.endpoint {
            ServerEndpointConfig::Tcp(addr) => {
                let (endpoint, handle) = start_tcp(proxy, addr, shutdown.clone())?;
                (endpoint, handle, None)
            }
            ServerEndpointConfig::Unix(_) => {
                let (endpoint, handle, socket) = start_unix(
                    proxy,
                    unix_endpoint.expect("Unix endpoint was resolved before database preparation"),
                    shutdown.clone(),
                )?;
                (endpoint, handle, Some(socket))
            }
        };
        #[cfg(not(unix))]
        let (endpoint, handle) = match self.endpoint {
            ServerEndpointConfig::Tcp(addr) => start_tcp(proxy, addr, shutdown.clone())?,
        };

        Ok(OliphauntServer {
            _workspace: workspace,
            _directory_lock: directory_lock,
            endpoint,
            startup_config,
            shutdown,
            handle: Some(handle),
            #[cfg(unix)]
            owned_unix_socket,
        })
    }

    #[cfg(feature = "extensions")]
    fn resolved_extension_startup(&self) -> Result<(Vec<Extension>, PostgresConfig)> {
        let extensions = resolve_extension_set(&self.extensions)?;
        let postgres_config =
            postgres_config_with_extension_startup(self.postgres_config.clone(), &extensions)?;
        Ok((extensions, postgres_config))
    }
}

fn start_tcp(
    proxy: OliphauntProxy,
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>)> {
    let listener = {
        let _phase = timing::phase("server.tcp_bind");
        TcpListener::bind(addr).context("bind Oliphaunt TCP server")?
    };
    let addr = {
        let _phase = timing::phase("server.tcp_local_addr");
        listener
            .local_addr()
            .context("read Oliphaunt TCP address")?
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
    let username = percent_encode_uri_component(&startup.username);
    let database = percent_encode_uri_component(&startup.database);
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
fn unix_connection_uri(endpoint: &UnixSocketEndpoint, startup: &StartupConfig) -> String {
    let host = endpoint
        .path
        .parent()
        .expect("resolved Unix socket path is absolute");
    format!(
        "postgresql://{}@/{}?host={}&port={}&sslmode=disable",
        percent_encode_uri_component(&startup.username),
        percent_encode_uri_component(&startup.database),
        percent_encode_bytes(host.as_os_str().as_bytes(), true),
        endpoint.port
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
    proxy: OliphauntProxy,
    endpoint: UnixSocketEndpoint,
    shutdown: Arc<AtomicBool>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>, OwnedUnixSocket)> {
    let path = endpoint.path.clone();
    {
        let _phase = timing::phase("server.unix_prepare_path");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create socket directory {}", parent.display()))?;
        }
        ensure_unix_socket_path_available(&path)?;
    }

    let listener = {
        let _phase = timing::phase("server.unix_bind");
        UnixListener::bind(&path)
            .with_context(|| format!("bind Oliphaunt Unix socket {}", path.display()))?
    };
    let mut owned_socket = match OwnedUnixSocket::capture(&path) {
        Ok(socket) => socket,
        Err(error) => {
            cleanup_new_unix_socket(&path);
            return Err(error);
        }
    };
    let server_endpoint = ServerEndpoint::Unix(endpoint);
    let (ready_tx, ready_rx) = sync_channel(1);
    let recorder = timing::current_recorder();
    let worker_shutdown = shutdown.clone();
    let handle = {
        let _phase = timing::phase("server.thread_spawn");
        thread::spawn(move || {
            timing::with_recorder(recorder, || {
                proxy.serve_unix_listener_until_ready(listener, worker_shutdown, Some(ready_tx))
            })
        })
    };
    let ready_result = {
        let _phase = timing::phase("server.wait_ready");
        wait_until_ready(&ready_rx)
    };
    if let Err(error) = ready_result {
        shutdown.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&path);
        let worker_result = handle
            .join()
            .map_err(|_| anyhow!("oliphaunt Unix server thread panicked during startup"))?;
        owned_socket.cleanup()?;
        worker_result?;
        return Err(error);
    }
    Ok((server_endpoint, handle, owned_socket))
}

#[cfg(unix)]
impl OwnedUnixSocket {
    fn capture(path: &Path) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("inspect bound Unix socket {}", path.display()))?;
        if !metadata.file_type().is_socket() {
            return Err(anyhow!(
                "bound Unix endpoint {} is not a socket",
                path.display()
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
            identity: Some((metadata.dev(), metadata.ino())),
        })
    }

    fn cleanup(&mut self) -> Result<()> {
        let Some(expected) = self.identity else {
            return Ok(());
        };
        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.identity = None;
                return Ok(());
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect owned Unix socket {}", self.path.display()));
            }
        };
        let actual = (metadata.dev(), metadata.ino());
        if !metadata.file_type().is_socket() || actual != expected {
            self.identity = None;
            return Err(anyhow!(
                "refusing to remove replaced Unix endpoint {}",
                self.path.display()
            ));
        }
        std::fs::remove_file(&self.path)
            .with_context(|| format!("remove owned Unix socket {}", self.path.display()))?;
        self.identity = None;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for OwnedUnixSocket {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            tracing::warn!("Oliphaunt Unix socket cleanup during drop failed: {error:#}");
        }
    }
}

#[cfg(unix)]
fn cleanup_new_unix_socket(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            "Oliphaunt Unix socket cleanup after startup failure failed for {}: {error:#}",
            path.display()
        ),
    }
}

#[cfg(unix)]
fn ensure_unix_socket_path_available(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect Unix socket {}", path.display()));
        }
    };
    let kind = if metadata.file_type().is_socket() {
        "socket"
    } else {
        "non-socket endpoint"
    };
    Err(anyhow!(
        "refusing to replace existing Unix {kind} {}; remove it explicitly if it is stale",
        path.display()
    ))
}

fn wait_until_ready(ready_rx: &Receiver<Result<()>>) -> Result<()> {
    ready_rx
        .recv()
        .context("Oliphaunt server thread exited before reporting readiness")?
}

fn wake_listener(endpoint: &ServerEndpoint) {
    match endpoint {
        ServerEndpoint::Tcp(addr) => {
            let _ = TcpStream::connect(addr);
        }
        #[cfg(unix)]
        ServerEndpoint::Unix(endpoint) => {
            let _ = UnixStream::connect(&endpoint.path);
        }
    }
}

#[cfg(unix)]
fn resolve_unix_socket_endpoint(path: &Path) -> Result<UnixSocketEndpoint> {
    let port = parse_unix_socket_port(path).with_context(|| {
        format!(
            "Unix socket path {} must end with .s.PGSQL.<port>",
            path.display()
        )
    })?;
    if port == 0 {
        return Err(anyhow!("Unix socket port must be in the range 1..=65535"));
    }
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("resolve current directory for Unix socket")?
            .join(path)
    };
    Ok(UnixSocketEndpoint { path, port })
}

#[cfg(unix)]
fn parse_unix_socket_port(path: &Path) -> Option<u16> {
    let name = path.file_name()?.to_str()?;
    let suffix = name.strip_prefix(".s.PGSQL.")?;
    let port = suffix.parse::<u16>().ok()?;
    (suffix == port.to_string()).then_some(port)
}

fn percent_encode_uri_component(value: &str) -> String {
    percent_encode_bytes(value.as_bytes(), false)
}

fn percent_encode_bytes(value: &[u8], preserve_slashes: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for &byte in value {
        if matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
        ) || (preserve_slashes && byte == b'/')
        {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[usize::from(byte >> 4)] as char);
            encoded.push(HEX[usize::from(byte & 0x0f)] as char);
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "extensions")]
    use crate::oliphaunt::extensions::PG_TEXTSEARCH;

    #[cfg(unix)]
    #[test]
    fn unix_socket_uri_host_is_query_encoded() {
        assert_eq!(
            percent_encode_bytes(b"/tmp/Application Support/oliphaunt", true),
            "/tmp/Application%20Support/oliphaunt"
        );
    }

    #[test]
    fn tcp_connection_uri_encodes_username_and_database_components() {
        let startup = StartupConfig {
            username: "role@example:admin".to_string(),
            database: "tenant/a?mode=#100%".to_string(),
            ..StartupConfig::default()
        };

        assert_eq!(
            tcp_connection_uri(SocketAddr::from(([127, 0, 0, 1], 6543)), &startup),
            "postgresql://role%40example%3Aadmin@127.0.0.1:6543/tenant%2Fa%3Fmode%3D%23100%25?sslmode=disable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_connection_uri_encodes_every_caller_controlled_component() {
        let startup = StartupConfig {
            username: "role name".to_string(),
            database: "tenant/db#1".to_string(),
            ..StartupConfig::default()
        };

        let endpoint = resolve_unix_socket_endpoint(Path::new(
            "/tmp/Application Support/db?slot/.s.PGSQL.6543",
        ))
        .unwrap();
        assert_eq!(
            unix_connection_uri(&endpoint, &startup),
            "postgresql://role%20name@/tenant%2Fdb%231?host=/tmp/Application%20Support/db%3Fslot&port=6543&sslmode=disable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_connection_uri_preserves_non_utf8_path_bytes() {
        use std::ffi::OsStr;

        let temp = tempfile::TempDir::new().unwrap();
        let directory = temp.path().join(OsStr::from_bytes(b"db-\xFF"));
        let endpoint = resolve_unix_socket_endpoint(&directory.join(".s.PGSQL.6543")).unwrap();

        assert!(unix_connection_uri(&endpoint, &StartupConfig::default()).contains("db-%FF"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_rejects_non_postgresql_names() {
        let error = resolve_unix_socket_endpoint(Path::new("/tmp/oliphaunt.sock")).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unix socket path /tmp/oliphaunt.sock must end with .s.PGSQL.<port>"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_rejects_noncanonical_ports() {
        for path in ["/tmp/.s.PGSQL.0001", "/tmp/.s.PGSQL.+1"] {
            let error = resolve_unix_socket_endpoint(Path::new(path)).unwrap_err();
            assert!(
                error.to_string().contains("must end with .s.PGSQL.<port>"),
                "unexpected error for {path}: {error:#}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_resolves_relative_paths() -> Result<()> {
        let endpoint = resolve_unix_socket_endpoint(Path::new("run/.s.PGSQL.6543"))?;
        assert_eq!(
            endpoint.path,
            std::env::current_dir()?.join("run/.s.PGSQL.6543")
        );
        assert_eq!(endpoint.port, 6543);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_preparation_rejects_regular_files_and_symlinks() -> Result<()> {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new()?;
        let regular = temp.path().join("regular");
        std::fs::write(&regular, b"keep")?;
        let error = ensure_unix_socket_path_available(&regular).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to replace existing Unix non-socket")
        );
        assert_eq!(std::fs::read(&regular)?, b"keep");

        let link = temp.path().join("link");
        symlink(&regular, &link)?;
        let error = ensure_unix_socket_path_available(&link).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to replace existing Unix non-socket")
        );
        assert!(link.symlink_metadata()?.file_type().is_symlink());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_preparation_rejects_active_and_stale_sockets() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let socket = temp.path().join(".s.PGSQL.6543");
        let listener = UnixListener::bind(&socket)?;

        let error = ensure_unix_socket_path_available(&socket).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to replace existing Unix socket")
        );
        assert!(socket.exists());

        drop(listener);
        let error = ensure_unix_socket_path_available(&socket).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("remove it explicitly if it is stale")
        );
        assert!(socket.exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_cleanup_removes_only_the_owned_inode() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let socket = temp.path().join(".s.PGSQL.6543");
        let listener = UnixListener::bind(&socket)?;
        let mut owned = OwnedUnixSocket::capture(&socket)?;

        std::fs::remove_file(&socket)?;
        std::fs::write(&socket, b"replacement")?;
        let error = owned.cleanup().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to remove replaced Unix endpoint")
        );
        assert_eq!(std::fs::read(&socket)?, b"replacement");
        drop(listener);
        Ok(())
    }

    #[test]
    fn default_server_builder_selects_memory_and_packaged_template() {
        let builder = OliphauntServerBuilder::default();
        assert_eq!(builder.storage, DatabaseStorage::Memory);
        assert_eq!(
            builder.initialization,
            DatabaseInitialization::PackagedTemplate
        );
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn server_path_merges_pg_textsearch_preload_once_before_start() {
        let builder = OliphauntServerBuilder::new()
            .postgres_config("shared_preload_libraries", "auto_explain,pg_textsearch")
            .extensions([PG_TEXTSEARCH, PG_TEXTSEARCH]);

        let (_, postgres_config) = builder.resolved_extension_startup().unwrap();

        assert_eq!(
            postgres_config.get("shared_preload_libraries"),
            Some("auto_explain,pg_textsearch")
        );
        assert_eq!(
            postgres_config
                .get("shared_preload_libraries")
                .unwrap()
                .split(',')
                .filter(|library| *library == "pg_textsearch")
                .count(),
            1
        );
    }
}
