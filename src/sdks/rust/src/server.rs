use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{EngineMode, NativeServerConfig, OpenConfig, ServerListen};
use crate::engine::{EngineCancel, EngineSession, NativeRuntime};
use crate::error::{Error, Result};
use crate::extension::{
    Extension, extension_runtime_environment, required_shared_preload_libraries,
};
use crate::liboliphaunt::{PreparedNativeRoot, configure_native_tool_env};
use crate::pgwire::{PostgresCancelToken, PostgresEndpoint, PostgresWireClient};
use crate::protocol::{ProtocolRequest, ProtocolResponse};

const SERVER_HOST: &str = "127.0.0.1";
#[cfg(unix)]
const ENV_SERVER_SDK_TRANSPORT: &str = "OLIPHAUNT_SERVER_SDK_TRANSPORT";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(250);
const AUTO_PORT_START_ATTEMPTS: usize = 16;

/// Native PostgreSQL server runtime.
///
/// Server mode starts and owns a real local PostgreSQL-compatible server
/// process. It is the mode to use for independent client connections, external
/// PostgreSQL clients, pools, and ORMs.
#[derive(Debug, Clone, Default)]
pub(crate) struct NativeServerRuntime {
    executable: Option<PathBuf>,
    listen: ServerListen,
}

impl NativeServerRuntime {
    /// Create a server runtime from builder/server configuration.
    pub fn from_config(config: &NativeServerConfig) -> Self {
        Self {
            executable: config.executable.clone(),
            listen: config.listen.clone(),
        }
    }
}

impl NativeRuntime for NativeServerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        debug_assert_eq!(config.mode, EngineMode::Server);
        config.validate()?;
        let extensions = config.resolved_extensions()?;
        let root = PreparedNativeRoot::prepare_for_server(&config, &extensions)?;
        let executable = self
            .executable
            .clone()
            .or_else(|| config.server.executable.clone())
            .unwrap_or_else(|| root.tool_path("postgres"));
        let listen = self.listen.clone();
        let fixed_port = match &listen {
            ServerListen::Tcp { port } => *port,
            #[cfg(unix)]
            ServerListen::Unix { port, .. } => Some(*port),
        };
        let attempts = if fixed_port.is_some() {
            1
        } else {
            AUTO_PORT_START_ATTEMPTS
        };
        let mut last_error = None;
        for attempt in 0..attempts {
            let port = match fixed_port {
                Some(port) => port,
                None => pick_port()?,
            };
            let (process_listen, sdk_endpoint, connection_string, owned_socket_dir) =
                prepare_server_listen(&listen, &config, port)?;
            let mut child =
                start_postgres(&root, &executable, &config, &extensions, &process_listen)?;
            match wait_for_server(sdk_endpoint, &mut child, &config) {
                Ok(connection) => {
                    let cancel = Arc::new(NativeServerCancel {
                        token: connection.cancel_token(),
                    });
                    return Ok(Box::new(NativeServerSession {
                        root,
                        child: Some(child),
                        connection: Some(connection),
                        cancel,
                        connection_string,
                        owned_socket_dir,
                        closed: false,
                    }));
                }
                Err(error)
                    if fixed_port.is_none()
                        && attempt + 1 < attempts
                        && is_auto_port_bind_conflict(&error) =>
                {
                    cleanup_failed_start(child);
                    cleanup_socket_dir(owned_socket_dir.as_deref());
                    last_error = Some(error);
                }
                Err(error) => {
                    cleanup_failed_start(child);
                    cleanup_socket_dir(owned_socket_dir.as_deref());
                    return Err(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| {
            Error::Engine(format!(
                "native server failed to allocate a free localhost port after {attempts} attempts"
            ))
        }))
    }
}

struct NativeServerSession {
    root: PreparedNativeRoot,
    child: Option<Child>,
    connection: Option<PostgresWireClient>,
    cancel: Arc<NativeServerCancel>,
    connection_string: String,
    owned_socket_dir: Option<PathBuf>,
    closed: bool,
}

impl EngineSession for NativeServerSession {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
        Some(cancel)
    }

    fn connection_string(&self) -> Option<String> {
        Some(self.connection_string.clone())
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        self.connection
            .as_mut()
            .ok_or(Error::EngineStopped)?
            .exec_protocol_raw(request)
    }

    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        self.connection
            .as_mut()
            .ok_or(Error::EngineStopped)?
            .exec_protocol_stream(request, on_chunk)
    }

    fn close(&mut self) -> Result<()> {
        self.close_server()
    }
}

struct NativeServerCancel {
    token: PostgresCancelToken,
}

impl EngineCancel for NativeServerCancel {
    fn cancel(&self) -> Result<()> {
        self.token
            .cancel(CONNECT_ATTEMPT_TIMEOUT, STARTUP_TIMEOUT)
            .map_err(|err| Error::Engine(format!("native server cancel failed: {err}")))
    }
}

impl NativeServerSession {
    fn close_server(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        if let Some(connection) = self.connection.as_mut() {
            let _ = connection.terminate();
        }
        self.connection = None;

        let mut stop_error = None;
        let pg_ctl = self.root.tool_path("pg_ctl");
        if pg_ctl.is_file() {
            let mut command = Command::new(&pg_ctl);
            configure_native_tool_env(&mut command, &self.root.runtime_dir);
            let stop = command
                .arg("-D")
                .arg(&self.root.pgdata)
                .arg("-m")
                .arg("fast")
                .arg("-w")
                .arg("stop")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match stop {
                Ok(mut child) => match wait_for_child_exit(&mut child, SHUTDOWN_TIMEOUT) {
                    Ok(Some(status)) if status.success() => {}
                    Ok(Some(status)) => {
                        stop_error = Some(format!("pg_ctl stop exited with {status}"));
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        stop_error = Some(format!(
                            "pg_ctl stop did not finish within {} seconds",
                            SHUTDOWN_TIMEOUT.as_secs()
                        ));
                    }
                    Err(err) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        stop_error = Some(format!("wait for pg_ctl stop: {err}"));
                    }
                },
                Err(err) => stop_error = Some(format!("run pg_ctl stop: {err}")),
            }
        } else {
            stop_error = Some(format!(
                "native server shutdown requires pg_ctl at {}",
                pg_ctl.display()
            ));
        }

        if let Some(mut child) = self.child.take() {
            match wait_for_child_exit(&mut child, SHUTDOWN_TIMEOUT) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if child.kill().is_err() && stop_error.is_none() {
                        stop_error =
                            Some("terminate native server process after timeout".to_owned());
                    }
                    if let Err(err) = child.wait()
                        && stop_error.is_none()
                    {
                        stop_error = Some(format!("reap native server process: {err}"));
                    }
                    if stop_error.is_none() {
                        stop_error = Some(format!(
                            "native server did not stop within {} seconds",
                            SHUTDOWN_TIMEOUT.as_secs()
                        ));
                    }
                }
                Err(err) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    if stop_error.is_none() {
                        stop_error = Some(format!("wait for native server process: {err}"));
                    }
                }
            }
        }

        cleanup_socket_dir(self.owned_socket_dir.as_deref());
        self.owned_socket_dir = None;
        if let Some(error) = stop_error {
            return Err(Error::Engine(error));
        }
        Ok(())
    }
}

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for NativeServerSession {
    fn drop(&mut self) {
        let _ = self.close_server();
    }
}

fn pick_port() -> Result<u16> {
    let listener = TcpListener::bind((SERVER_HOST, 0))
        .map_err(|err| Error::Engine(format!("allocate native server port: {err}")))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| Error::Engine(format!("read native server port: {err}")))
}

fn start_postgres(
    root: &PreparedNativeRoot,
    executable: &Path,
    config: &OpenConfig,
    extensions: &[Extension],
    listen: &PostgresProcessListen,
) -> Result<Child> {
    if !executable.is_file() {
        return Err(Error::Engine(format!(
            "native server executable is missing at {}",
            executable.display()
        )));
    }
    let mut command = Command::new(executable);
    command.env("PGDATA", &root.pgdata);
    configure_native_runtime_env(&mut command, &root.runtime_dir, extensions);
    command
        .args(postgres_startup_args(
            &root.pgdata,
            config,
            extensions,
            listen,
        )?)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
        .spawn()
        .map_err(|err| Error::Engine(format!("start native server postgres: {err}")))
}

fn configure_native_runtime_env(
    command: &mut Command,
    runtime_dir: &Path,
    extensions: &[Extension],
) {
    configure_native_tool_env(command, runtime_dir);
    configure_icu_data_env(command, runtime_dir);
    configure_extension_runtime_env(command, runtime_dir, extensions);
}

fn configure_icu_data_env(command: &mut Command, runtime_dir: &Path) {
    command.env_remove("ICU_DATA");
    let icu_data = runtime_dir.join("share/icu");
    if icu_data.is_dir() {
        command.env("ICU_DATA", icu_data);
    }
}

fn configure_extension_runtime_env(
    command: &mut Command,
    runtime_dir: &Path,
    extensions: &[Extension],
) {
    for extension in extensions {
        for entry in extension_runtime_environment(*extension) {
            let value = runtime_dir.join(entry.relative_path);
            if value.join(entry.required_file).is_file() {
                command.env(entry.name, value);
            }
        }
    }
}

fn postgres_startup_args(
    pgdata: &Path,
    config: &OpenConfig,
    extensions: &[Extension],
    listen: &PostgresProcessListen,
) -> Result<Vec<OsString>> {
    let (host, port, socket_dir) = match listen {
        PostgresProcessListen::Tcp {
            port,
            private_socket_dir,
        } => (SERVER_HOST, *port, private_socket_dir.as_deref()),
        #[cfg(unix)]
        PostgresProcessListen::Unix { directory, port } => ("", *port, Some(directory.as_path())),
    };
    let mut args = vec![
        OsString::from("-D"),
        pgdata.as_os_str().to_os_string(),
        OsString::from("-h"),
        OsString::from(host),
        OsString::from("-p"),
        OsString::from(port.to_string()),
        OsString::from("-c"),
        OsString::from("logging_collector=off"),
        OsString::from("-c"),
        OsString::from(if host.is_empty() {
            "listen_addresses="
        } else {
            "listen_addresses=127.0.0.1"
        }),
    ];
    #[cfg(unix)]
    {
        args.push(OsString::from("-c"));
        let socket_dir = socket_dir.ok_or_else(|| {
            Error::Engine("native server socket directory was not allocated".to_owned())
        })?;
        args.push(OsString::from(format!(
            "unix_socket_directories={}",
            socket_dir.display()
        )));
    }
    #[cfg(not(unix))]
    {
        let _ = socket_dir;
        args.push(OsString::from("-c"));
        args.push(OsString::from("unix_socket_directories="));
    }

    for assignment in config.postgres_startup_assignments() {
        args.push(OsString::from("-c"));
        args.push(OsString::from(assignment));
    }
    let preload_libraries = required_shared_preload_libraries(extensions);
    if !preload_libraries.is_empty() {
        args.push(OsString::from("-c"));
        args.push(OsString::from(format!(
            "shared_preload_libraries={}",
            preload_libraries.join(",")
        )));
    }
    Ok(args)
}

fn wait_for_server(
    endpoint: PostgresEndpoint,
    child: &mut Child,
    config: &OpenConfig,
) -> Result<PostgresWireClient> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut last_error = None;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| Error::Engine(format!("poll native server startup: {err}")))?
        {
            let stderr = child_stderr(child);
            return Err(Error::Engine(format!(
                "native server exited before accepting connections: {status}{stderr}"
            )));
        }
        match PostgresWireClient::connect_endpoint(
            endpoint.clone(),
            &config.username,
            &config.database,
            CONNECT_ATTEMPT_TIMEOUT,
            STARTUP_TIMEOUT,
        ) {
            Ok(connection) => return Ok(connection),
            Err(err) => last_error = Some(err),
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(last_error.unwrap_or_else(|| {
        Error::Engine(format!(
            "native server did not accept SDK connections on {:?} within {:?}",
            endpoint, STARTUP_TIMEOUT
        ))
    }))
}

fn tcp_connection_string(config: &OpenConfig, port: u16) -> String {
    format!(
        "postgresql://{}@{}:{}/{}?sslmode=disable",
        percent_encode_connection_component(&config.username),
        SERVER_HOST,
        port,
        percent_encode_connection_component(&config.database)
    )
}

#[cfg(unix)]
fn unix_connection_string(config: &OpenConfig, directory: &Path, port: u16) -> Result<String> {
    let directory = directory.to_str().ok_or_else(|| {
        Error::InvalidConfig("native server Unix socket directory must be valid UTF-8".to_owned())
    })?;
    Ok(format!(
        "postgresql:///{database}?host={host}&port={port}&user={user}&sslmode=disable",
        database = percent_encode_connection_component(&config.database),
        host = percent_encode_connection_component(directory),
        user = percent_encode_connection_component(&config.username),
    ))
}

fn percent_encode_connection_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(nibble_hex(byte >> 4));
            encoded.push(nibble_hex(byte & 0x0f));
        }
    }
    encoded
}

fn nibble_hex(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("hex nibble is out of range"),
    }
}

fn server_sdk_endpoint(addr: SocketAddr, port: u16, socket_dir: Option<&Path>) -> PostgresEndpoint {
    #[cfg(unix)]
    {
        if std::env::var(ENV_SERVER_SDK_TRANSPORT)
            .map(|value| value.eq_ignore_ascii_case("tcp"))
            .unwrap_or(false)
        {
            return PostgresEndpoint::Tcp(addr);
        }
        let socket_dir =
            socket_dir.expect("Unix native server socket directory is allocated before endpoint");
        PostgresEndpoint::Unix(socket_dir.join(format!(".s.PGSQL.{port}")))
    }
    #[cfg(not(unix))]
    {
        let _ = port;
        let _ = socket_dir;
        PostgresEndpoint::Tcp(addr)
    }
}

#[derive(Debug)]
enum PostgresProcessListen {
    Tcp {
        port: u16,
        private_socket_dir: Option<PathBuf>,
    },
    #[cfg(unix)]
    Unix { directory: PathBuf, port: u16 },
}

fn prepare_server_listen(
    listen: &ServerListen,
    config: &OpenConfig,
    resolved_port: u16,
) -> Result<(
    PostgresProcessListen,
    PostgresEndpoint,
    String,
    Option<PathBuf>,
)> {
    match listen {
        ServerListen::Tcp { .. } => {
            let addr = SocketAddr::from(([127, 0, 0, 1], resolved_port));
            let socket_dir = create_server_socket_dir(resolved_port)?;
            let endpoint = server_sdk_endpoint(addr, resolved_port, socket_dir.as_deref());
            Ok((
                PostgresProcessListen::Tcp {
                    port: resolved_port,
                    private_socket_dir: socket_dir.clone(),
                },
                endpoint,
                tcp_connection_string(config, resolved_port),
                socket_dir,
            ))
        }
        #[cfg(unix)]
        ServerListen::Unix { directory, port } => {
            let directory = if directory.is_absolute() {
                directory.clone()
            } else {
                std::env::current_dir()
                    .map_err(|error| {
                        Error::Engine(format!(
                            "resolve current directory for native server Unix socket: {error}"
                        ))
                    })?
                    .join(directory)
            };
            prepare_public_socket_directory(&directory, *port)?;
            let socket = directory.join(format!(".s.PGSQL.{port}"));
            Ok((
                PostgresProcessListen::Unix {
                    directory: directory.clone(),
                    port: *port,
                },
                PostgresEndpoint::Unix(socket),
                unix_connection_string(config, &directory, *port)?,
                None,
            ))
        }
    }
}

#[cfg(unix)]
fn prepare_public_socket_directory(directory: &Path, port: u16) -> Result<()> {
    if directory.exists() {
        let metadata = fs::symlink_metadata(directory).map_err(|err| {
            Error::Engine(format!(
                "inspect native server Unix socket directory {}: {err}",
                directory.display()
            ))
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::InvalidConfig(format!(
                "native server Unix socket directory must be a real directory: {}",
                directory.display()
            )));
        }
    } else {
        fs::create_dir_all(directory).map_err(|err| {
            Error::Engine(format!(
                "create native server Unix socket directory {}: {err}",
                directory.display()
            ))
        })?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|err| {
            Error::Engine(format!(
                "set native server Unix socket directory permissions {}: {err}",
                directory.display()
            ))
        })?;
    }
    let socket = directory.join(format!(".s.PGSQL.{port}"));
    if socket.as_os_str().len() >= 100 {
        return Err(Error::InvalidConfig(format!(
            "native server Unix socket path is too long: {}",
            socket.display()
        )));
    }
    ensure_public_socket_path_available(&socket)?;
    ensure_public_socket_path_available(&PathBuf::from(format!("{}.lock", socket.display())))?;
    Ok(())
}

#[cfg(unix)]
fn ensure_public_socket_path_available(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(Error::InvalidConfig(format!(
            "native server refuses to replace existing Unix endpoint {}; remove it explicitly if it is stale",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::Engine(format!(
            "inspect native server Unix endpoint {}: {error}",
            path.display()
        ))),
    }
}

#[cfg(unix)]
fn create_server_socket_dir(port: u16) -> Result<Option<PathBuf>> {
    let base = Path::new("/tmp");
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))?
        .as_nanos();
    for attempt in 0..100_u32 {
        let socket_dir = base.join(format!("lpo-s-{pid}-{port}-{nanos}-{attempt}"));
        match fs::create_dir(&socket_dir) {
            Ok(()) => {
                fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700)).map_err(
                    |err| {
                        Error::Engine(format!(
                            "set native server socket dir permissions {}: {err}",
                            socket_dir.display()
                        ))
                    },
                )?;
                return Ok(Some(socket_dir));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(Error::Engine(format!(
                    "create native server socket dir {}: {err}",
                    socket_dir.display()
                )));
            }
        }
    }
    Err(Error::Engine(
        "failed to allocate a unique native server socket directory".to_owned(),
    ))
}

#[cfg(not(unix))]
fn create_server_socket_dir(_port: u16) -> Result<Option<PathBuf>> {
    Ok(None)
}

fn cleanup_socket_dir(socket_dir: Option<&Path>) {
    if let Some(socket_dir) = socket_dir {
        let _ = fs::remove_dir_all(socket_dir);
    }
}

fn cleanup_failed_start(mut child: Child) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(_) => {}
    }
}

fn is_auto_port_bind_conflict(error: &Error) -> bool {
    let message = error.to_string();
    message.contains("Address already in use")
        || message.contains("could not bind IPv4 address")
        || message.contains("could not create any TCP/IP sockets")
}

fn child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    match stderr.read_to_string(&mut output) {
        Ok(_) if !output.trim().is_empty() => format!(": {}", output.trim()),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_port_retry_classifies_postgres_bind_conflicts() {
        let error = Error::Engine(
            "native server exited before accepting connections: exit status: 1: \
             LOG: could not bind IPv4 address \"127.0.0.1\": Address already in use\n\
             FATAL: could not create any TCP/IP sockets"
                .to_owned(),
        );
        assert!(is_auto_port_bind_conflict(&error));
    }

    #[test]
    fn auto_port_retry_does_not_mask_unrelated_startup_errors() {
        let error = Error::Engine(
            "native server exited before accepting connections: exit status: 1: \
             FATAL: data directory has invalid permissions"
                .to_owned(),
        );
        assert!(!is_auto_port_bind_conflict(&error));
    }

    #[test]
    fn server_startup_args_include_required_preload_libraries_before_spawn() {
        let mut config = OpenConfig::direct("target/test-roots/native-server-preload");
        config.mode = EngineMode::Server;
        let args = postgres_startup_args(
            Path::new("/tmp/oliphaunt-preload/pgdata"),
            &config,
            &[Extension::PgTextsearch, Extension::PgTextsearch],
            &PostgresProcessListen::Tcp {
                port: 15432,
                private_socket_dir: Some(PathBuf::from("/tmp/oliphaunt-preload-socket")),
            },
        )
        .unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(&args, "shared_preload_libraries=pg_textsearch");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "shared_preload_libraries=pg_textsearch")
                .count(),
            1,
            "preload libraries must be deduplicated in server startup args"
        );
    }

    #[test]
    fn extension_runtime_env_is_set_only_when_required_file_is_materialized() {
        let runtime_dir = std::env::temp_dir().join(format!(
            "oliphaunt-extension-runtime-env-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        let _cleanup = RuntimeDirCleanup(runtime_dir.clone());
        let mut missing = Command::new("postgres");
        configure_extension_runtime_env(&mut missing, &runtime_dir, &[Extension::Postgis]);
        assert_eq!(
            missing
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PROJ_DATA")),
            None
        );

        let proj_data = runtime_dir.join("share/postgresql/proj");
        std::fs::create_dir_all(&proj_data).expect("create proj data dir");
        std::fs::write(proj_data.join("proj.db"), b"fixture").expect("write proj.db");

        let mut present = Command::new("postgres");
        configure_extension_runtime_env(&mut present, &runtime_dir, &[Extension::Postgis]);
        assert_eq!(
            present
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PROJ_DATA"))
                .and_then(|(_, value)| value)
                .map(PathBuf::from),
            Some(proj_data)
        );

        let mut unselected = Command::new("postgres");
        configure_extension_runtime_env(&mut unselected, &runtime_dir, &[]);
        assert_eq!(
            unselected
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PROJ_DATA")),
            None
        );
    }

    #[test]
    fn native_runtime_env_sets_icu_data_when_materialized() {
        let runtime_dir = std::env::temp_dir().join(format!(
            "oliphaunt-icu-runtime-env-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        let _cleanup = RuntimeDirCleanup(runtime_dir.clone());

        let mut missing = Command::new("postgres");
        for key in [
            "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
            "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
            "OLIPHAUNT_INTERNAL_ICU_READY",
            "ICU_DATA",
        ] {
            missing.env(key, "ambient");
        }
        configure_native_runtime_env(&mut missing, &runtime_dir, &[]);
        assert_eq!(
            missing
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("ICU_DATA"))
                .and_then(|(_, value)| value),
            None
        );
        for key in [
            "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
            "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
            "OLIPHAUNT_INTERNAL_ICU_READY",
        ] {
            assert_eq!(
                missing
                    .get_envs()
                    .find(|(candidate, _)| *candidate == std::ffi::OsStr::new(key))
                    .and_then(|(_, value)| value),
                None
            );
        }

        let icu_data = runtime_dir.join("share/icu");
        std::fs::create_dir_all(&icu_data).expect("create ICU data dir");
        let mut present = Command::new("postgres");
        configure_native_runtime_env(&mut present, &runtime_dir, &[]);
        assert_eq!(
            present
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("ICU_DATA"))
                .and_then(|(_, value)| value)
                .map(PathBuf::from),
            Some(icu_data)
        );
    }

    struct RuntimeDirCleanup(PathBuf);

    impl Drop for RuntimeDirCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn server_connection_string_uses_configured_identity() {
        let mut config = OpenConfig::direct("target/test-roots/native-server-identity");
        config.mode = EngineMode::Server;
        config.username = "app user".to_owned();
        config.database = "app/db".to_owned();

        assert_eq!(
            tcp_connection_string(&config, 15432),
            "postgresql://app%20user@127.0.0.1:15432/app%2Fdb?sslmode=disable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_connection_string_uses_postgresql_socket_directory_and_port() {
        let mut config = OpenConfig::direct("target/test-roots/native-server-unix-uri");
        config.mode = EngineMode::Server;
        config.username = "app user".to_owned();
        config.database = "app/db".to_owned();

        assert_eq!(
            unix_connection_string(&config, Path::new("/tmp/app sockets"), 15432).unwrap(),
            "postgresql:///app%2Fdb?host=%2Ftmp%2Fapp%20sockets&port=15432&user=app%20user&sslmode=disable"
        );
    }

    fn assert_startup_config_arg(args: &[String], expected: &str) {
        let Some(index) = args.iter().position(|arg| arg == expected) else {
            panic!("missing server startup argument {expected:?} in {args:?}");
        };
        assert_eq!(
            args.get(index.saturating_sub(1)).map(String::as_str),
            Some("-c"),
            "server startup argument {expected:?} must be passed through postgres -c"
        );
    }
}
