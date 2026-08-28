use std::cell::Cell;
use std::marker::PhantomData;
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
use crate::oliphaunt::lifecycle::{TeardownOwnership, TerminalCloseResult, teardown_result};
use crate::oliphaunt::proxy::{ActiveConnection, OliphauntProxy};
use crate::oliphaunt::storage::DatabaseStorage;
#[cfg(unix)]
use crate::oliphaunt::storage::validate_host_path;

/// A supervised local PostgreSQL socket backed by one embedded Oliphaunt runtime.
///
/// Use this entry point for code that expects a PostgreSQL URI, such as
/// `tokio-postgres`, SQLx, or tools that speak the wire protocol. The
/// server owns one embedded backend, so downstream pools should use a single
/// connection.
#[derive(Debug)]
pub struct OliphauntServer {
    // The listener is owned and stopped by one blocking caller. Moving that
    // ownership to another thread is safe; sharing references concurrently is
    // deliberately unsupported. AsyncOliphauntServer provides a Sync handle.
    _not_sync: PhantomData<Cell<()>>,
    _workspace: TeardownOwnership<Option<TempDir>>,
    _directory_lock: TeardownOwnership<Option<DirectoryLock>>,
    endpoint: ServerEndpoint,
    connection_string: String,
    shutdown: Arc<AtomicBool>,
    active_connection: Arc<ActiveConnection>,
    handle: Option<JoinHandle<Result<()>>>,
    close_result: Option<TerminalCloseResult>,
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
    /// served on IPv4 loopback with an automatically assigned port.
    pub fn builder() -> OliphauntServerBuilder {
        OliphauntServerBuilder::new()
    }

    /// Return a PostgreSQL connection URI for the local server.
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }

    /// Whether this direct server is permanently retired.
    ///
    /// The value becomes true when shutdown begins, including when terminal
    /// cleanup later reports an error. Repeated [`Self::close`] calls replay
    /// that first terminal result.
    ///
    /// This is lifecycle state, not a health check. `false` does not poll the
    /// proxy listener or prove that the published endpoint is reachable.
    pub fn is_closed(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst) || self.close_result.is_some()
    }

    /// Request shutdown and wait for the listener thread to exit.
    ///
    /// Any active client connection is closed before the listener thread is
    /// joined. Once stop begins, the server is terminal even when cleanup
    /// reports an error. Successful teardown releases managed-root ownership;
    /// failed teardown retains it until process exit.
    pub fn close(&mut self) -> crate::Result<()> {
        self.owner_close()
    }

    /// Terminal close boundary used by the asynchronous owner thread.
    ///
    /// Once stop begins, later calls replay its exact success or failure.
    pub(crate) fn owner_close(&mut self) -> crate::Result<()> {
        if let Some(result) = &self.close_result {
            return result.clone();
        }
        let result = teardown_result("WASIX server", || self.stop());
        self.close_result = Some(result.clone());
        result
    }

    fn stop(&mut self) -> Result<()> {
        self.shutdown.store(true, Ordering::SeqCst);
        self.active_connection.shutdown();
        {
            wake_listener(&self.endpoint);
        }
        let worker_result = if let Some(handle) = self.handle.take() {
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

        let result = match (worker_result, socket_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(worker), Err(socket)) => Err(anyhow!(
                "Oliphaunt server worker failed: {worker:#}; Unix socket cleanup also failed: {socket:#}"
            )),
        };
        if result.is_ok() {
            // Keep the managed-root lock until every other owned resource has
            // been destroyed. `owner_close` contains a destructor panic and
            // caches it as a terminal failure without a second cleanup.
            self._workspace.release();
            self._directory_lock.release();
        }
        result
    }
}

impl Drop for OliphauntServer {
    fn drop(&mut self) {
        if self.close_result.is_none()
            && let Err(err) = self.owner_close()
        {
            tracing::warn!("oliphaunt server shutdown during drop failed: {err:#}");
        }
    }
}

#[cfg(test)]
pub(crate) fn server_with_worker_result_for_test(
    result: Result<()>,
    directory_lock: Option<DirectoryLock>,
) -> OliphauntServer {
    OliphauntServer {
        _not_sync: PhantomData,
        _workspace: TeardownOwnership::new(None),
        _directory_lock: TeardownOwnership::new(directory_lock),
        endpoint: ServerEndpoint::Tcp(SocketAddr::from(([127, 0, 0, 1], 0))),
        connection_string: tcp_connection_string(
            SocketAddr::from(([127, 0, 0, 1], 0)),
            &StartupConfig::default(),
        ),
        shutdown: Arc::new(AtomicBool::new(false)),
        active_connection: Arc::new(ActiveConnection::default()),
        handle: Some(thread::spawn(move || result)),
        close_result: None,
        #[cfg(unix)]
        owned_unix_socket: None,
    }
}

/// Builder for [`OliphauntServer`].
#[derive(Debug, Clone)]
pub struct OliphauntServerBuilder {
    storage: DatabaseStorage,
    listen: ServerListen,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerListen {
    /// Listen on IPv4 loopback on any supported host. An omitted port asks the
    /// operating system for one.
    Tcp { port: Option<u16> },
    #[cfg(unix)]
    /// Listen on a Unix host in a directory using PostgreSQL's
    /// `.s.PGSQL.<port>` filename. The directory path must be nonempty and
    /// valid UTF-8, and contain no NUL bytes. UTF-8 keeps the published
    /// connection string lossless across Rust drivers and ORMs.
    Unix { directory: PathBuf, port: u16 },
}

impl ServerListen {
    /// Listen on IPv4 loopback on any supported host and let the operating
    /// system choose the port.
    pub const fn tcp() -> Self {
        Self::Tcp { port: None }
    }

    /// Listen on IPv4 loopback on any supported host at an explicit port.
    pub const fn tcp_port(port: u16) -> Self {
        Self::Tcp { port: Some(port) }
    }

    /// Listen on a Unix host in a UTF-8 Unix-domain socket directory using
    /// PostgreSQL port 5432.
    #[cfg(unix)]
    pub fn unix(directory: impl Into<PathBuf>) -> Self {
        Self::Unix {
            directory: directory.into(),
            port: 5432,
        }
    }

    /// Listen on a Unix host in a UTF-8 Unix-domain socket directory using an
    /// explicit PostgreSQL port.
    #[cfg(unix)]
    pub fn unix_port(directory: impl Into<PathBuf>, port: u16) -> Self {
        Self::Unix {
            directory: directory.into(),
            port,
        }
    }
}

impl Default for ServerListen {
    fn default() -> Self {
        Self::tcp()
    }
}

impl Default for OliphauntServerBuilder {
    fn default() -> Self {
        Self {
            storage: DatabaseStorage::Memory,
            listen: ServerListen::tcp(),
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl OliphauntServerBuilder {
    /// Create a builder. Defaults to a memory database on IPv4 loopback with
    /// an automatically assigned port.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select where PostgreSQL stores its mutable database files.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.storage = storage;
        self
    }

    /// Select a loopback TCP listener on any supported host or a PostgreSQL
    /// Unix-domain listener on a Unix host.
    pub fn listen(mut self, listen: ServerListen) -> Self {
        self.listen = listen;
        self
    }

    /// Set a PostgreSQL startup GUC for the embedded backend used by this
    /// server.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.postgres_config.insert(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs for the embedded backend used by
    /// this server.
    pub fn startup_gucs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        for (name, value) in settings {
            self.postgres_config.insert(name, value);
        }
        self
    }

    /// Default user encoded in [`OliphauntServer::connection_string`].
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.startup_config.username = username.into();
        self
    }

    /// Default database encoded in [`OliphauntServer::connection_string`].
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.startup_config.database = database.into();
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to clients.
    /// Database-local installation remains the application's migration concern.
    #[cfg(feature = "extensions")]
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to clients.
    /// Database-local installation remains the application's migration concern.
    #[cfg(feature = "extensions")]
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Install the runtime if needed, initialize the cluster, and start serving.
    pub fn start(self) -> crate::Result<OliphauntServer> {
        crate::error::public_result(self.start_inner())
    }

    fn start_inner(self) -> Result<OliphauntServer> {
        if matches!(self.listen, ServerListen::Tcp { port: Some(0) }) {
            return Err(crate::error::invalid_configuration(
                "TCP port must be in the range 1..=65535; omit it to allocate one",
            ));
        }
        #[cfg(unix)]
        let unix_endpoint = match &self.listen {
            ServerListen::Unix { directory, port } => {
                Some(resolve_unix_socket_endpoint(directory, *port)?)
            }
            ServerListen::Tcp { .. } => None,
        };

        #[cfg(feature = "extensions")]
        let (extensions, postgres_config) = self.resolved_extension_startup()?;
        #[cfg(not(feature = "extensions"))]
        let postgres_config = self.postgres_config.clone();
        postgres_config.validate()?;
        self.storage.validate()?;
        self.startup_config.validate()?;
        let startup_config = self.startup_config.clone();

        let prepared_database = {
            let plan = DatabasePlan::new(self.storage.clone());
            prepare_database(plan, &startup_config.username)?
        };
        let PreparedDatabase {
            workspace,
            directory_lock,
            outcome,
        } = prepared_database;

        let shutdown = Arc::new(AtomicBool::new(false));
        let active_connection = Arc::new(ActiveConnection::default());
        let proxy = { OliphauntProxy::from_prepared_database(outcome) };
        let proxy = proxy
            .with_postgres_config(postgres_config)
            .with_startup_config(startup_config.clone());
        #[cfg(feature = "extensions")]
        let proxy = proxy.with_extensions(extensions);

        #[cfg(unix)]
        let (endpoint, handle, owned_unix_socket) = match self.listen {
            ServerListen::Tcp { port } => {
                let addr = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)));
                let (endpoint, handle) =
                    start_tcp(proxy, addr, shutdown.clone(), active_connection.clone())?;
                (endpoint, handle, None)
            }
            ServerListen::Unix { .. } => {
                let (endpoint, handle, socket) = start_unix(
                    proxy,
                    unix_endpoint.expect("Unix endpoint was resolved before database preparation"),
                    shutdown.clone(),
                    active_connection.clone(),
                )?;
                (endpoint, handle, Some(socket))
            }
        };
        #[cfg(not(unix))]
        let (endpoint, handle) = match self.listen {
            ServerListen::Tcp { port } => {
                let addr = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)));
                start_tcp(proxy, addr, shutdown.clone(), active_connection.clone())?
            }
        };
        let connection_string = match &endpoint {
            ServerEndpoint::Tcp(addr) => tcp_connection_string(*addr, &startup_config),
            #[cfg(unix)]
            ServerEndpoint::Unix(endpoint) => unix_connection_string(endpoint, &startup_config),
        };

        Ok(OliphauntServer {
            _not_sync: PhantomData,
            _workspace: TeardownOwnership::new(workspace),
            _directory_lock: TeardownOwnership::new(directory_lock),
            endpoint,
            connection_string,
            shutdown,
            active_connection,
            handle: Some(handle),
            close_result: None,
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
    active_connection: Arc<ActiveConnection>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>)> {
    let listener = TcpListener::bind(addr).context("bind Oliphaunt TCP server")?;
    let addr = {
        listener
            .local_addr()
            .context("read Oliphaunt TCP address")?
    };
    let (ready_tx, ready_rx) = sync_channel(1);
    let handle = thread::spawn(move || {
        proxy.serve_tcp_listener_until_ready(listener, shutdown, active_connection, Some(ready_tx))
    });
    {
        wait_until_ready(&ready_rx)?;
    }
    Ok((ServerEndpoint::Tcp(addr), handle))
}

fn tcp_connection_string(addr: SocketAddr, startup: &StartupConfig) -> String {
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
fn unix_connection_string(endpoint: &UnixSocketEndpoint, startup: &StartupConfig) -> String {
    let host = endpoint
        .path
        .parent()
        .expect("resolved Unix socket path is absolute");
    let host = host
        .to_str()
        .expect("resolved Unix socket directory was validated as UTF-8");
    format!(
        "postgresql:///{database}?host={host}&port={port}&user={user}&sslmode=disable",
        database = percent_encode_uri_component(&startup.database),
        host = percent_encode_uri_component(host),
        port = endpoint.port,
        user = percent_encode_uri_component(&startup.username),
    )
}

#[cfg(unix)]
fn start_unix(
    proxy: OliphauntProxy,
    endpoint: UnixSocketEndpoint,
    shutdown: Arc<AtomicBool>,
    active_connection: Arc<ActiveConnection>,
) -> Result<(ServerEndpoint, JoinHandle<Result<()>>, OwnedUnixSocket)> {
    let path = endpoint.path.clone();
    prepare_unix_socket_directory(&path)?;
    ensure_unix_socket_path_available(&path)?;

    let listener = {
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
    let worker_shutdown = shutdown.clone();
    let handle = thread::spawn(move || {
        proxy.serve_unix_listener_until_ready(
            listener,
            worker_shutdown,
            active_connection,
            Some(ready_tx),
        )
    });
    let ready_result = { wait_until_ready(&ready_rx) };
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

#[cfg(unix)]
fn prepare_unix_socket_directory(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        crate::error::invalid_configuration(format!(
            "Unix socket path has no parent: {}",
            path.display()
        ))
    })?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create socket directory {}", parent.display()))?;
    let metadata = std::fs::symlink_metadata(parent)
        .with_context(|| format!("inspect socket directory {}", parent.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(crate::error::invalid_configuration(format!(
            "Unix socket directory must be a real directory, not a symlink: {}",
            parent.display()
        )));
    }
    if path.as_os_str().as_bytes().len() >= 100 {
        return Err(crate::error::invalid_configuration(format!(
            "Unix socket path is too long: {}",
            path.display()
        )));
    }
    Ok(())
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
fn resolve_unix_socket_endpoint(directory: &Path, port: u16) -> Result<UnixSocketEndpoint> {
    let current_directory = if directory.is_absolute() {
        None
    } else {
        Some(
            std::env::current_dir()
                .context("resolve current directory for Unix socket directory")?,
        )
    };
    resolve_unix_socket_endpoint_at(directory, port, current_directory.as_deref())
}

#[cfg(unix)]
fn resolve_unix_socket_endpoint_at(
    directory: &Path,
    port: u16,
    current_directory: Option<&Path>,
) -> Result<UnixSocketEndpoint> {
    validate_host_path("Unix socket directory", directory)?;
    if port == 0 {
        return Err(crate::error::invalid_configuration(
            "Unix socket port must be in the range 1..=65535",
        ));
    }
    let directory = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        current_directory
            .expect("relative Unix socket directory resolution provides a current directory")
            .join(directory)
    };
    if directory.to_str().is_none() {
        return Err(crate::error::invalid_configuration(
            "Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path",
        ));
    }
    let path = directory.join(format!(".s.PGSQL.{port}"));
    if path.as_os_str().as_bytes().len() >= 100 {
        return Err(crate::error::invalid_configuration(format!(
            "Unix socket path is too long: {}",
            path.display()
        )));
    }
    Ok(UnixSocketEndpoint { path, port })
}

fn percent_encode_uri_component(value: &str) -> String {
    percent_encode_bytes(value.as_bytes())
}

fn percent_encode_bytes(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for &byte in value {
        if matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
        ) {
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
    #[cfg(feature = "extension-pg-textsearch")]
    use crate::oliphaunt::extensions::Extension;

    #[cfg(unix)]
    #[test]
    fn unix_socket_uri_host_is_query_encoded() {
        assert_eq!(
            percent_encode_bytes(b"/tmp/Application Support/oliphaunt"),
            "%2Ftmp%2FApplication%20Support%2Foliphaunt"
        );
    }

    #[test]
    fn tcp_connection_string_encodes_username_and_database_components() {
        let startup = StartupConfig {
            username: "role@example:admin".to_string(),
            database: "tenant/a?mode=#100%".to_string(),
        };

        assert_eq!(
            tcp_connection_string(SocketAddr::from(([127, 0, 0, 1], 6543)), &startup),
            "postgresql://role%40example%3Aadmin@127.0.0.1:6543/tenant%2Fa%3Fmode%3D%23100%25?sslmode=disable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_connection_string_encodes_every_caller_controlled_component() {
        use std::str::FromStr;

        let startup = StartupConfig {
            username: "role name".to_string(),
            database: "tenant/db#1".to_string(),
        };

        let endpoint =
            resolve_unix_socket_endpoint(Path::new("/tmp/Application Support/db?slot"), 6543)
                .unwrap();
        let connection_string = unix_connection_string(&endpoint, &startup);
        assert_eq!(
            connection_string,
            "postgresql:///tenant%2Fdb%231?host=%2Ftmp%2FApplication%20Support%2Fdb%3Fslot&port=6543&user=role%20name&sslmode=disable"
        );

        let options = sqlx::postgres::PgConnectOptions::from_str(&connection_string)
            .expect("the published URI must retain its exact SQLx connection shape");
        assert_eq!(
            options.get_socket().map(|path| path.as_path()),
            Some(Path::new("/tmp/Application Support/db?slot"))
        );
        assert_eq!(options.get_port(), 6543);
        assert_eq!(options.get_username(), "role name");
        assert_eq!(options.get_database(), Some("tenant/db#1"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_rejects_non_utf8_directory_without_mutation() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let temp = tempfile::TempDir::new().unwrap();
        let directory = temp.path().join(OsStr::from_bytes(b"db-\xFF"));
        assert!(!directory.exists());

        let error = resolve_unix_socket_endpoint(&directory, 6543)
            .expect_err("a String connection URI cannot preserve a non-UTF-8 socket path");

        assert!(error.to_string().contains("must be valid UTF-8"));
        assert!(!directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_rejects_zero_port() {
        let error = resolve_unix_socket_endpoint(Path::new("/tmp"), 0).unwrap_err();
        assert!(error.to_string().contains("range 1..=65535"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_rejects_too_long_path_without_mutation() {
        let directory = std::env::temp_dir().join(format!(
            "oliphaunt-wasix-socket-{}-{}",
            std::process::id(),
            "x".repeat(120)
        ));
        assert!(!directory.exists());

        let error = resolve_unix_socket_endpoint(&directory, 6543).expect_err(
            "Unix socket sockaddr length must be validated before database preparation",
        );

        assert!(error.to_string().contains("socket path is too long"));
        assert!(!directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_endpoint_resolves_relative_paths() -> Result<()> {
        let current_directory = Path::new("/tmp/oliphaunt-relative-base");
        let endpoint =
            resolve_unix_socket_endpoint_at(Path::new("run"), 6543, Some(current_directory))?;
        assert_eq!(endpoint.path, current_directory.join("run/.s.PGSQL.6543"));
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
    fn default_server_builder_selects_memory() {
        let builder = OliphauntServerBuilder::default();
        assert_eq!(builder.storage, DatabaseStorage::Memory);
    }

    #[test]
    fn direct_server_close_keeps_observable_terminal_state_and_replays_failure() {
        let mut server =
            server_with_worker_result_for_test(Err(anyhow!("injected server stop failure")), None);
        assert!(!server.is_closed());

        let first = server.close().unwrap_err().to_string();
        assert!(server.is_closed());
        let second = server.close().unwrap_err().to_string();

        assert_eq!(first, second);
        assert!(first.contains("injected server stop failure"));
    }

    #[test]
    fn failed_direct_server_close_quarantines_managed_root_ownership() -> Result<()> {
        let parent = TempDir::new()?;
        let root = parent.path().join("failed-server-root");
        let lock = DirectoryLock::acquire(&root)?;
        let mut server = server_with_worker_result_for_test(
            Err(anyhow!("injected server stop failure")),
            Some(lock),
        );

        server.close().expect_err("server teardown fails");
        assert!(!server._directory_lock.is_released());
        drop(server);

        let reopen = DirectoryLock::acquire(&root)
            .expect_err("failed teardown must retain the managed root until process exit");
        assert!(format!("{reopen:#}").contains("database root is already in use"));
        Ok(())
    }

    #[test]
    fn successful_direct_server_close_releases_managed_root_ownership() -> Result<()> {
        let parent = TempDir::new()?;
        let root = parent.path().join("successful-server-root");
        let lock = DirectoryLock::acquire(&root)?;
        let mut server = server_with_worker_result_for_test(Ok(()), Some(lock));

        server.close()?;
        assert!(server._directory_lock.is_released());
        drop(server);

        let reopened = DirectoryLock::acquire(&root)?;
        drop(reopened);
        Ok(())
    }

    #[test]
    fn server_listen_contract_cannot_express_a_remote_tcp_bind() {
        let fixture: serde_json::Value =
            serde_json::from_str(&crate::oliphaunt::test_fixtures::text(
                "postgres/server-listen.json",
                "postgres-server-listen.json",
            ))
            .unwrap();
        assert_eq!(fixture["tcp"]["host"], "127.0.0.1");
        assert_eq!(fixture["unix"]["defaultPort"], 5432);
        assert_eq!(fixture["unix"]["filePrefix"], ".s.PGSQL.");
        assert_eq!(ServerListen::tcp(), ServerListen::Tcp { port: None });
        assert_eq!(
            ServerListen::tcp_port(15432),
            ServerListen::Tcp { port: Some(15432) }
        );
    }

    #[test]
    fn explicit_zero_tcp_port_is_rejected_before_runtime_work() {
        let error = OliphauntServer::builder()
            .listen(ServerListen::tcp_port(0))
            .start()
            .unwrap_err();
        assert_eq!(error.kind(), crate::ErrorKind::InvalidConfiguration);
        assert!(error.to_string().contains("omit it to allocate one"));
    }

    #[cfg(feature = "extension-pg-textsearch")]
    #[test]
    fn server_path_merges_pg_textsearch_preload_once_before_start() {
        let builder = OliphauntServerBuilder::new()
            .startup_guc("shared_preload_libraries", "auto_explain,pg_textsearch")
            .extensions([Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH]);

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
