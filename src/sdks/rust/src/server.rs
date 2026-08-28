use std::ffi::OsString;
use std::fs;
use std::net::{SocketAddr, TcpListener};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::time::{SystemTime, UNIX_EPOCH};

use crate::child_process::reap_child_process;
#[cfg(unix)]
use crate::config::server_unix_socket_directory_str;
use crate::config::{EngineMode, NativeServerConfig, OpenConfig, ServerListen};
use crate::engine::{EngineSession, NativeRuntime};
use crate::error::{Error, Result};
use crate::extension::{Extension, extension_runtime_environment};
use crate::liboliphaunt::{PreparedNativeRoot, configure_native_tool_env};
use crate::pgwire::{PostgresEndpoint, PostgresWireClient};
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
        let explicit_executable = self
            .executable
            .clone()
            .or_else(|| config.server.executable.clone());
        if let Some(executable) = explicit_executable.as_ref()
            && !executable.is_file()
        {
            return Err(Error::InvalidConfig(format!(
                "native server executable must be an existing file: {}",
                executable.display()
            )));
        }
        let root = PreparedNativeRoot::prepare_for_server(&config, &extensions)?;
        let executable = explicit_executable.unwrap_or_else(|| root.tool_path("postgres"));
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
            let (process_listen, sdk_endpoint, connection_string, mut owned_socket_dir) =
                prepare_server_listen(&listen, &config, port)?;
            let mut child =
                match start_postgres(&root, &executable, &config, &extensions, &process_listen) {
                    Ok(child) => child,
                    Err(error) => {
                        let mut cleanup_failures = Vec::new();
                        remove_owned_socket_dir(&mut owned_socket_dir, &mut cleanup_failures);
                        return Err(failed_start_error(error, cleanup_failures));
                    }
                };
            match wait_for_server(sdk_endpoint, &mut child, &config) {
                Ok(()) => {
                    return Ok(Box::new(NativeServerSession {
                        root: Some(root),
                        child: Some(child),
                        connection_string,
                        owned_socket_dir,
                        retain_root_on_drop: false,
                        closed: false,
                    }));
                }
                Err(error) => {
                    let (reaped, cleanup_failures) =
                        cleanup_failed_start(&mut child, &mut owned_socket_dir);
                    if !reaped {
                        // The process may still be using PGDATA and its socket.
                        // Retain resources with ownership-bearing destructors
                        // rather than unlock PGDATA beneath a live backend.
                        // Dropping the socket PathBuf does not delete it.
                        std::mem::forget(child);
                        std::mem::forget(root);
                        return Err(failed_start_error(error, cleanup_failures));
                    }
                    if !cleanup_failures.is_empty() {
                        return Err(failed_start_error(error, cleanup_failures));
                    }
                    let retry_auto_port = fixed_port.is_none()
                        && attempt + 1 < attempts
                        && tcp_port_is_occupied(port);
                    if retry_auto_port {
                        last_error = Some(error);
                    } else {
                        return Err(error);
                    }
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
    root: Option<PreparedNativeRoot>,
    child: Option<Child>,
    connection_string: String,
    owned_socket_dir: Option<PathBuf>,
    retain_root_on_drop: bool,
    closed: bool,
}

impl EngineSession for NativeServerSession {
    fn connection_string(&self) -> Option<String> {
        Some(self.connection_string.clone())
    }

    fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
        Err(Error::Engine(
            "native server lifecycle handles do not expose an SDK query connection; connect an ordinary PostgreSQL client to connection_string()"
                .to_owned(),
        ))
    }

    fn close(&mut self) -> Result<()> {
        self.close_server()
    }
}

impl NativeServerSession {
    fn close_server(&mut self) -> Result<()> {
        let first_attempt = !self.closed;
        self.closed = true;
        let mut cleanup_failures = Vec::new();
        if first_attempt {
            let root = self
                .root
                .as_ref()
                .expect("native server session retains its prepared root");
            let pg_ctl = root.tool_path("pg_ctl");
            if pg_ctl.is_file() {
                let mut command = Command::new(&pg_ctl);
                configure_native_tool_env(&mut command, &root.runtime_dir);
                let stop = command
                    .arg("-D")
                    .arg(&root.pgdata)
                    .arg("-m")
                    .arg("fast")
                    .arg("-w")
                    .arg("stop")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                match stop {
                    Ok(mut child) => {
                        let outcome = reap_child_process(
                            &mut child,
                            SHUTDOWN_TIMEOUT,
                            SHUTDOWN_TIMEOUT,
                            "pg_ctl stop",
                        );
                        cleanup_failures.extend(outcome.failures);
                        if outcome.reaped {
                            if outcome.exit_success == Some(false) {
                                cleanup_failures
                                    .push("pg_ctl stop exited unsuccessfully".to_owned());
                            }
                        } else {
                            // No enclosing owner can safely retry an unconfirmed
                            // pg_ctl child after this terminal close attempt.
                            self.retain_root_on_drop = true;
                            std::mem::forget(child);
                        }
                    }
                    Err(err) => cleanup_failures.push(format!("run pg_ctl stop: {err}")),
                }
            } else {
                cleanup_failures.push(format!(
                    "native server shutdown requires pg_ctl at {}",
                    pg_ctl.display()
                ));
            }
        }

        if let Some(child) = self.child.as_mut() {
            let outcome = reap_child_process(
                child,
                SHUTDOWN_TIMEOUT,
                SHUTDOWN_TIMEOUT,
                "native server process",
            );
            cleanup_failures.extend(outcome.failures);
            if outcome.reaped {
                self.child = None;
            }
        }

        if self.child.is_none()
            && let Some(socket_dir) = self.owned_socket_dir.as_ref()
        {
            match fs::remove_dir_all(socket_dir) {
                Ok(()) => self.owned_socket_dir = None,
                Err(error) => cleanup_failures.push(format!(
                    "remove native server socket directory {}: {error}",
                    socket_dir.display()
                )),
            }
        }
        if !cleanup_failures.is_empty() {
            return Err(Error::Engine(format!(
                "native server cleanup failed: {}",
                cleanup_failures.join("; ")
            )));
        }
        Ok(())
    }
}

impl Drop for NativeServerSession {
    fn drop(&mut self) {
        let close_failed = self.close_server().is_err();
        let retain_root = self.retain_root_on_drop || self.child.is_some();
        if close_failed {
            // Drop is the last package-internal cleanup opportunity. Preserve
            // every unresolved exact owner process-lifetime; in particular,
            // never let PreparedNativeRoot unlock or delete PGDATA beneath an
            // unconfirmed PostgreSQL/pg_ctl process.
            if let Some(child) = self.child.take() {
                std::mem::forget(child);
            }
        }
        if retain_root && let Some(root) = self.root.take() {
            std::mem::forget(root);
        }
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
        .stderr(Stdio::inherit());
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
        args.push(postgres_unix_socket_assignment(socket_dir)?);
    }
    #[cfg(not(unix))]
    {
        let _ = socket_dir;
        args.push(OsString::from("-c"));
        args.push(OsString::from("unix_socket_directories="));
    }

    for assignment in config.postgres_startup_assignments(extensions) {
        args.push(OsString::from("-c"));
        args.push(OsString::from(assignment));
    }
    Ok(args)
}

fn wait_for_server(
    endpoint: PostgresEndpoint,
    child: &mut Child,
    config: &OpenConfig,
) -> Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut last_error = None;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| Error::Engine(format!("poll native server startup: {err}")))?
        {
            return Err(Error::Engine(format!(
                "native server exited before accepting connections: {status}; PostgreSQL diagnostics were written to the parent process stderr"
            )));
        }
        match PostgresWireClient::connect_endpoint(
            endpoint.clone(),
            &config.username,
            &config.database,
            CONNECT_ATTEMPT_TIMEOUT,
            STARTUP_TIMEOUT,
        ) {
            Ok(mut connection) => {
                connection.terminate()?;
                return Ok(());
            }
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
fn postgres_unix_socket_assignment(directory: &Path) -> Result<OsString> {
    let directory = server_unix_socket_directory_str(directory)?;
    let mut assignment =
        String::with_capacity(directory.len() + "unix_socket_directories=\"\"".len());
    assignment.push_str("unix_socket_directories=\"");
    for character in directory.chars() {
        if character == '"' {
            assignment.push('"');
        }
        assignment.push(character);
    }
    assignment.push('"');
    Ok(assignment.into())
}

#[cfg(unix)]
fn unix_connection_string(config: &OpenConfig, directory: &Path, port: u16) -> Result<String> {
    let directory = server_unix_socket_directory_str(directory)?;
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
            let connection_string = unix_connection_string(config, &directory, *port)?;
            prepare_public_socket_directory(&directory, *port)?;
            let socket = directory.join(format!(".s.PGSQL.{port}"));
            Ok((
                PostgresProcessListen::Unix {
                    directory: directory.clone(),
                    port: *port,
                },
                PostgresEndpoint::Unix(socket),
                connection_string,
                None,
            ))
        }
    }
}

#[cfg(unix)]
fn prepare_public_socket_directory(directory: &Path, port: u16) -> Result<()> {
    let socket = directory.join(format!(".s.PGSQL.{port}"));
    if socket.as_os_str().len() >= 100 {
        return Err(Error::InvalidConfig(format!(
            "native server Unix socket path is too long: {}",
            socket.display()
        )));
    }
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
    ensure_public_socket_path_available(&socket)?;
    let mut lock = socket.as_os_str().to_os_string();
    lock.push(".lock");
    ensure_public_socket_path_available(Path::new(&lock))?;
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

fn cleanup_failed_start(
    child: &mut Child,
    owned_socket_dir: &mut Option<PathBuf>,
) -> (bool, Vec<String>) {
    let outcome = reap_child_process(
        child,
        Duration::ZERO,
        SHUTDOWN_TIMEOUT,
        "failed native server startup",
    );
    let mut failures = outcome.failures;
    if outcome.reaped {
        remove_owned_socket_dir(owned_socket_dir, &mut failures);
    }
    (outcome.reaped, failures)
}

fn remove_owned_socket_dir(socket_dir: &mut Option<PathBuf>, failures: &mut Vec<String>) {
    if let Some(path) = socket_dir.as_ref() {
        match fs::remove_dir_all(path) {
            Ok(()) => *socket_dir = None,
            Err(error) => failures.push(format!(
                "remove failed native server startup socket directory {}: {error}",
                path.display()
            )),
        }
    }
}

fn failed_start_error(error: Error, cleanup_failures: Vec<String>) -> Error {
    if cleanup_failures.is_empty() {
        return error;
    }
    Error::Engine(format!(
        "{error}; native server failed-start cleanup failed: {}",
        cleanup_failures.join("; ")
    ))
}

fn tcp_port_is_occupied(port: u16) -> bool {
    TcpListener::bind((SERVER_HOST, port))
        .is_err_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_explicit_server_executable_is_rejected_before_persistent_root_mutation() {
        let test_root = std::env::temp_dir().join(format!(
            "oliphaunt-native-server-executable-preflight-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        let _cleanup = RuntimeDirCleanup(test_root.clone());
        std::fs::create_dir_all(&test_root).expect("create server preflight test root");
        let storage = test_root.join("database");
        let missing_executable = test_root.join("missing-postgres");
        let mut config = OpenConfig::direct(storage.clone());
        config.mode = EngineMode::Server;
        config.server.executable = Some(missing_executable.clone());
        let runtime = NativeServerRuntime::from_config(&config.server);

        let error = match runtime.open(config) {
            Ok(_) => panic!("missing explicit server executable unexpectedly started"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("must be an existing file"));
        assert!(!missing_executable.exists());
        assert!(
            !storage.exists(),
            "deterministic executable validation must run before PGDATA preparation"
        );
    }

    #[test]
    fn auto_port_retry_only_classifies_a_current_loopback_owner() {
        let listener = TcpListener::bind((SERVER_HOST, 0)).expect("bind loopback fixture");
        let port = listener.local_addr().expect("read fixture address").port();
        assert!(tcp_port_is_occupied(port));
        drop(listener);
        assert!(!tcp_port_is_occupied(port));
    }

    #[test]
    fn server_startup_args_include_required_preload_libraries_before_spawn() {
        let mut config = OpenConfig::direct("target/test-roots/native-server-preload");
        config.mode = EngineMode::Server;
        config.startup_gucs = vec![crate::config::PostgresStartupGuc::new(
            "shared_preload_libraries",
            "auto_explain, pg_textsearch",
        )];
        let args = postgres_startup_args(
            Path::new("/tmp/oliphaunt-preload/pgdata"),
            &config,
            &[Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH],
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

        assert_startup_config_arg(&args, "shared_preload_libraries=auto_explain,pg_textsearch");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("shared_preload_libraries="))
                .count(),
            1,
            "caller and extension preload libraries must be merged once in server startup args"
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
        configure_extension_runtime_env(&mut missing, &runtime_dir, &[Extension::POSTGIS]);
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
        configure_extension_runtime_env(&mut present, &runtime_dir, &[Extension::POSTGIS]);
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

    #[cfg(unix)]
    #[test]
    fn unix_socket_directory_is_one_quoted_postgres_guc_list_item() {
        let mut config = OpenConfig::direct("target/test-roots/native-server-unix-guc-list");
        config.mode = EngineMode::Server;
        let directory = PathBuf::from("/tmp/ application,\"primary\" ");
        let args = postgres_startup_args(
            Path::new("/tmp/pgdata"),
            &config,
            &[],
            &PostgresProcessListen::Unix {
                directory,
                port: 15432,
            },
        )
        .expect("a quoted PostgreSQL list item accepts path punctuation");
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(
            &args,
            "unix_socket_directories=\"/tmp/ application,\"\"primary\"\" \"",
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
