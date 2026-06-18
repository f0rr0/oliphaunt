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

use crate::backup::{
    annotate_physical_archive_backup, physical_archive_backup, sql_backup_with_pg_dump,
};
use crate::config::{EngineMode, NativeServerConfig, OpenConfig};
use crate::engine::{
    EngineCancel, EngineCapabilities, EngineSession, NativeRuntime, SessionConcurrency,
};
use crate::error::{Error, Result};
use crate::extension::{
    Extension, extension_runtime_environment, required_shared_preload_libraries,
};
use crate::liboliphaunt::PreparedNativeRoot;
use crate::pgwire::{PostgresCancelToken, PostgresEndpoint, PostgresWireClient};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{BackupArtifact, BackupFormat, BackupRequest, BootstrapStrategy};

const SERVER_HOST: &str = "127.0.0.1";
const ENV_SERVER_SDK_TRANSPORT: &str = "OLIPHAUNT_SERVER_SDK_TRANSPORT";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(250);
const AUTO_PORT_START_ATTEMPTS: usize = 16;

/// Native PostgreSQL server runtime.
///
/// Server mode starts and owns a real local PostgreSQL-compatible server
/// process. It is the mode to use for independent client connections, pools,
/// `psql`, `pg_dump`, and ORMs.
#[derive(Debug, Clone, Default)]
pub struct NativeServerRuntime {
    executable: Option<PathBuf>,
    port: Option<u16>,
}

impl NativeServerRuntime {
    /// Create a server runtime that resolves the server executable from package
    /// assets.
    pub fn from_package() -> Self {
        Self {
            executable: None,
            port: None,
        }
    }

    /// Create a server runtime from builder/server configuration.
    pub fn from_config(config: &NativeServerConfig) -> Self {
        Self {
            executable: config.executable.clone(),
            port: config.port,
        }
    }

    /// Create a server runtime with an explicit executable.
    pub fn from_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
            port: None,
        }
    }

    /// Return the configured executable, if any.
    pub fn executable(&self) -> Option<&PathBuf> {
        self.executable.as_ref()
    }

    /// Use a fixed localhost port.
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }
}

impl NativeRuntime for NativeServerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeServer {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "NativeServerRuntime only serves native-server mode".to_owned(),
            });
        }
        config.validate()?;
        let extensions = config.resolved_extensions()?;
        let root = PreparedNativeRoot::prepare(&config, &extensions)?;
        initdb_if_needed(&root, &config)?;
        let executable = self
            .executable
            .clone()
            .or_else(|| config.server.executable.clone())
            .unwrap_or_else(|| root.tool_path("postgres"));
        let fixed_port = self.port.or(config.server.port);
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
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            let socket_dir = create_server_socket_dir(port)?;
            let sdk_endpoint = server_sdk_endpoint(addr, port, socket_dir.as_deref());
            let mut child = start_postgres(
                &root,
                &executable,
                port,
                &config,
                &extensions,
                socket_dir.as_deref(),
            )?;
            match wait_for_server(sdk_endpoint, &mut child, &config) {
                Ok(connection) => {
                    let cancel = Arc::new(NativeServerCancel {
                        token: connection.cancel_token(),
                    });
                    let connection_string = server_connection_string(&config, port);
                    return Ok(Box::new(NativeServerSession {
                        root,
                        child: Some(child),
                        connection: Some(connection),
                        cancel,
                        connection_string,
                        max_client_sessions: config.server.max_client_sessions,
                        socket_dir,
                        closed: false,
                        selected_extensions: extensions.clone(),
                    }));
                }
                Err(error)
                    if fixed_port.is_none()
                        && attempt + 1 < attempts
                        && is_auto_port_bind_conflict(&error) =>
                {
                    cleanup_failed_start(child);
                    cleanup_socket_dir(socket_dir.as_deref());
                    last_error = Some(error);
                }
                Err(error) => {
                    cleanup_failed_start(child);
                    cleanup_socket_dir(socket_dir.as_deref());
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
    max_client_sessions: usize,
    socket_dir: Option<PathBuf>,
    closed: bool,
    selected_extensions: Vec<Extension>,
}

impl EngineSession for NativeServerSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            mode: EngineMode::NativeServer,
            session_concurrency: SessionConcurrency::IndependentSessions,
            process_isolated: true,
            multi_root: false,
            reopenable: true,
            same_root_logical_reopen: false,
            root_switchable: true,
            crash_restartable: false,
            max_client_sessions: self.max_client_sessions,
            protocol_raw: true,
            protocol_stream: true,
            query_cancel: true,
            backup_restore: true,
            backup_formats: vec![BackupFormat::Sql, BackupFormat::PhysicalArchive],
            restore_formats: vec![BackupFormat::PhysicalArchive],
            simple_query: true,
            extensions: true,
            connection_strings: true,
            connection_string: Some(self.connection_string.clone()),
        }
    }

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

    fn checkpoint(&mut self) -> Result<()> {
        self.exec_protocol_raw(ProtocolRequest::simple_query("CHECKPOINT")?)
            .map(|_| ())
    }

    fn backup(&mut self, request: BackupRequest) -> Result<BackupArtifact> {
        match request.format {
            BackupFormat::Sql => {
                sql_backup_with_pg_dump(&self.root.tool_path("pg_dump"), &self.connection_string)
            }
            BackupFormat::PhysicalArchive => {
                let pgdata = self.root.pgdata.clone();
                let artifact =
                    physical_archive_backup(&pgdata, |request| self.exec_protocol_raw(request))?;
                let selected_extensions = self.selected_extensions.clone();
                annotate_physical_archive_backup(
                    artifact,
                    &pgdata,
                    &selected_extensions,
                    |request| self.exec_protocol_raw(request),
                )
            }
            BackupFormat::OliphauntArchive => Err(Error::Engine(
                "OliphauntArchive has no stable on-disk format yet; request PhysicalArchive for same-version clones or Sql for portable logical dumps".to_owned(),
            )),
        }
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
            let status = Command::new(&pg_ctl)
                .arg("-D")
                .arg(&self.root.pgdata)
                .arg("-m")
                .arg("fast")
                .arg("-w")
                .arg("stop")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            match status {
                Ok(status) if status.success() => {}
                Ok(status) => stop_error = Some(format!("pg_ctl stop exited with {status}")),
                Err(err) => stop_error = Some(format!("run pg_ctl stop: {err}")),
            }
        }

        if let Some(mut child) = self.child.take() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if stop_error.is_some() {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                }
                Err(err) => {
                    stop_error = Some(format!("wait for native server process: {err}"));
                }
            }
        }

        if let Some(error) = stop_error {
            return Err(Error::Engine(error));
        }
        cleanup_socket_dir(self.socket_dir.as_deref());
        self.socket_dir = None;
        Ok(())
    }
}

impl Drop for NativeServerSession {
    fn drop(&mut self) {
        let _ = self.close_server();
    }
}

fn initdb_if_needed(root: &PreparedNativeRoot, config: &OpenConfig) -> Result<()> {
    if root.pgdata.join("PG_VERSION").is_file() {
        return root.refresh_manifest();
    }
    let initdb = match &config.storage.bootstrap {
        BootstrapStrategy::InitdbToolingOnly { initdb } => initdb.clone(),
        BootstrapStrategy::PackagedTemplate | BootstrapStrategy::ExistingOnly => {
            root.tool_path("initdb")
        }
    };
    if !initdb.is_file() {
        return Err(Error::Engine(format!(
            "native server bootstrap requires initdb at {}",
            initdb.display()
        )));
    }
    let status = Command::new(&initdb)
        .arg("-D")
        .arg(&root.pgdata)
        .arg("-U")
        .arg(&config.username)
        .arg("--auth=trust")
        .arg("--no-sync")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|err| Error::Engine(format!("run native server initdb: {err}")))?;
    if status.success() {
        root.refresh_manifest()
    } else {
        Err(Error::Engine(format!(
            "native server initdb failed with status {status}"
        )))
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
    port: u16,
    config: &OpenConfig,
    extensions: &[Extension],
    socket_dir: Option<&Path>,
) -> Result<Child> {
    if !executable.is_file() {
        return Err(Error::Engine(format!(
            "native server executable is missing at {}",
            executable.display()
        )));
    }
    let mut command = Command::new(executable);
    command.env("PGDATA", &root.pgdata);
    configure_extension_runtime_env(&mut command, &root.runtime_dir, extensions);
    command
        .args(postgres_startup_args(
            &root.pgdata,
            port,
            config,
            extensions,
            socket_dir,
        )?)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
        .spawn()
        .map_err(|err| Error::Engine(format!("start native server postgres: {err}")))
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
    port: u16,
    config: &OpenConfig,
    extensions: &[Extension],
    socket_dir: Option<&Path>,
) -> Result<Vec<OsString>> {
    let mut args = vec![
        OsString::from("-D"),
        pgdata.as_os_str().to_os_string(),
        OsString::from("-h"),
        OsString::from(SERVER_HOST),
        OsString::from("-p"),
        OsString::from(port.to_string()),
        OsString::from("-c"),
        OsString::from("logging_collector=off"),
        OsString::from("-c"),
        OsString::from("listen_addresses=127.0.0.1"),
    ];
    #[cfg(unix)]
    {
        let socket_dir = socket_dir.ok_or_else(|| {
            Error::Engine("native server socket directory was not allocated".to_owned())
        })?;
        args.push(OsString::from("-c"));
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
    args.push(OsString::from("-c"));
    args.push(OsString::from(format!(
        "max_connections={}",
        config.server.max_client_sessions
    )));
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

fn server_connection_string(config: &OpenConfig, port: u16) -> String {
    format!(
        "postgres://{}@{}:{}/{}",
        percent_encode_connection_component(&config.username),
        SERVER_HOST,
        port,
        percent_encode_connection_component(&config.database)
    )
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
        let mut config = OpenConfig::native_direct("target/test-roots/native-server-preload");
        config.mode = EngineMode::NativeServer;
        let args = postgres_startup_args(
            Path::new("/tmp/oliphaunt-preload/pgdata"),
            15432,
            &config,
            &[Extension::PgSearch, Extension::PgSearch],
            Some(Path::new("/tmp/oliphaunt-preload-socket")),
        )
        .unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(&args, "shared_preload_libraries=pg_search");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "shared_preload_libraries=pg_search")
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

    struct RuntimeDirCleanup(PathBuf);

    impl Drop for RuntimeDirCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn server_connection_string_uses_configured_identity() {
        let mut config = OpenConfig::native_direct("target/test-roots/native-server-identity");
        config.mode = EngineMode::NativeServer;
        config.username = "app user".to_owned();
        config.database = "app/db".to_owned();

        assert_eq!(
            server_connection_string(&config, 15432),
            "postgres://app%20user@127.0.0.1:15432/app%2Fdb"
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
