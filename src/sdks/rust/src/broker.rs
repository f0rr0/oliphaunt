use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::backup::annotate_physical_archive_backup;
use crate::config::{EngineMode, NativeBrokerConfig, OpenConfig};
use crate::engine::{
    EngineCancel, EngineCapabilities, EngineSession, NativeRuntime, SessionConcurrency,
};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::ipc::{RequestFrame, ResponseFrame, read_response, write_request};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{
    BackupArtifact, BackupFormat, BackupRequest, BootstrapStrategy, DatabaseRoot,
};

const ENV_BROKER: &str = "OLIPHAUNT_BROKER";
const ENV_BROKER_ASSET_DIR: &str = "OLIPHAUNT_BROKER_ASSET_DIR";
const ENV_BROKER_TRANSPORT: &str = "OLIPHAUNT_BROKER_TRANSPORT";
const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";
const READY_PREFIX: &str = "OLIPHAUNT_BROKER_READY ";
const ERROR_PREFIX: &str = "OLIPHAUNT_BROKER_ERROR ";
const BROKER_RELEASE_VERSION: &str = "0.1.0";
const BROKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const BROKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

trait BrokerTransport: Read + Write + Send {}

impl<T> BrokerTransport for T where T: Read + Write + Send {}

/// Broker runtime backed by a local helper process.
///
/// Broker mode is intentionally separate from direct mode. The helper process
/// owns the native root and the direct PostgreSQL backend; the Rust SDK client
/// talks to it over a small length-prefixed local IPC protocol.
#[derive(Debug, Clone)]
pub struct NativeBrokerRuntime {
    executable: Option<PathBuf>,
    supervisor: Arc<BrokerSupervisor>,
}

impl NativeBrokerRuntime {
    /// Create a broker runtime that resolves the broker executable from package
    /// assets.
    pub fn from_package() -> Self {
        Self {
            executable: None,
            supervisor: Arc::new(BrokerSupervisor::new(1)),
        }
    }

    /// Create a broker runtime from builder/broker configuration.
    pub fn from_config(config: &NativeBrokerConfig) -> Self {
        Self {
            executable: config.executable.clone(),
            supervisor: Arc::new(BrokerSupervisor::new(config.max_roots)),
        }
    }

    /// Create a broker runtime with an explicit helper executable.
    pub fn from_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
            supervisor: Arc::new(BrokerSupervisor::new(1)),
        }
    }

    /// Set the maximum number of active database roots this runtime
    /// supervises.
    ///
    /// Broker mode uses one helper process per root while the native direct
    /// backend remains process-global. This limit therefore controls the
    /// number of concurrently supervised helper processes, not the number of
    /// sessions within a root.
    pub fn with_max_roots(mut self, max_roots: usize) -> Self {
        self.supervisor = Arc::new(BrokerSupervisor::new(max_roots));
        self
    }

    /// Return the configured helper executable, if any.
    pub fn executable(&self) -> Option<&PathBuf> {
        self.executable.as_ref()
    }

    /// Return the maximum number of active roots this runtime admits.
    pub fn max_roots(&self) -> usize {
        self.supervisor.max_roots()
    }
}

impl Default for NativeBrokerRuntime {
    fn default() -> Self {
        Self::from_package()
    }
}

impl NativeRuntime for NativeBrokerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeBroker {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "NativeBrokerRuntime only serves native-broker mode".to_owned(),
            });
        }
        config.validate()?;
        let executable = self
            .executable
            .clone()
            .or_else(|| config.broker.executable.clone())
            .or_else(resolve_broker_executable)
            .ok_or(Error::RuntimeUnavailable {
                mode: EngineMode::NativeBroker,
            })?;
        let (root_path, temporary_root) = materialize_broker_root(&config.storage.root)?;
        let root_lease = self.supervisor.acquire_root(&root_path)?;
        let mut open_guard = BrokerOpenGuard {
            child: None,
            temporary_root,
            ipc_cleanup: None,
            root_lease: Some(root_lease),
        };
        let endpoint = BrokerEndpoint::allocate()?;
        open_guard.ipc_cleanup = endpoint.cleanup_path();
        let extensions = config.resolved_extensions()?;
        let auth_token = BrokerAuthToken::generate()?;
        let launch_plan = BrokerLaunchPlan {
            executable,
            config: config.clone(),
            root_path,
            extensions,
            endpoint,
            auth_token,
        };
        let launch = launch_plan.launch()?;
        open_guard.child = Some(launch.child);
        let cancel = Arc::new(BrokerCancel::new(
            launch.cancel_endpoint,
            launch_plan.auth_token.as_str().to_owned(),
        ));
        let (child, temporary_root, ipc_cleanup, root_lease) = open_guard.into_session_parts();

        Ok(Box::new(NativeBrokerSession {
            child: Some(child),
            transport: Some(launch.transport),
            cancel,
            launch_plan,
            temporary_root,
            ipc_cleanup,
            root_lease: Some(root_lease),
            max_roots: self.supervisor.max_roots(),
            closed: false,
        }))
    }
}

struct NativeBrokerSession {
    child: Option<Child>,
    transport: Option<Box<dyn BrokerTransport>>,
    cancel: Arc<BrokerCancel>,
    launch_plan: BrokerLaunchPlan,
    temporary_root: Option<PathBuf>,
    ipc_cleanup: Option<PathBuf>,
    root_lease: Option<BrokerRootLease>,
    max_roots: usize,
    closed: bool,
}

impl EngineSession for NativeBrokerSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            mode: EngineMode::NativeBroker,
            session_concurrency: SessionConcurrency::SerializedSingleSession,
            process_isolated: true,
            multi_root: self.max_roots > 1,
            reopenable: true,
            same_root_logical_reopen: false,
            root_switchable: true,
            crash_restartable: true,
            max_client_sessions: 1,
            protocol_raw: true,
            protocol_stream: true,
            query_cancel: true,
            backup_restore: true,
            backup_formats: vec![BackupFormat::PhysicalArchive],
            restore_formats: vec![BackupFormat::PhysicalArchive],
            simple_query: true,
            extensions: true,
            connection_strings: false,
            connection_string: None,
        }
    }

    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let response = {
            let transport = self.ensure_transport()?;
            write_request(
                transport,
                RequestFrame::ExecProtocol(request.as_bytes().to_vec()),
            )
            .and_then(|()| read_response(transport))
        };
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(bytes) => Ok(ProtocolResponse::new(bytes)),
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for raw protocol execution".to_owned(),
            )),
        }
    }

    fn exec_simple_query(&mut self, sql: &str) -> Result<ProtocolResponse> {
        let response = {
            let transport = self.ensure_transport()?;
            write_request(transport, RequestFrame::ExecSimpleQuery(sql.to_owned()))
                .and_then(|()| read_response(transport))
        };
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(bytes) => Ok(ProtocolResponse::new(bytes)),
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for simple-query execution".to_owned(),
            )),
        }
    }

    fn checkpoint(&mut self) -> Result<()> {
        let response = {
            let transport = self.ensure_transport()?;
            write_request(transport, RequestFrame::Checkpoint)
                .and_then(|()| read_response(transport))
        };
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(_) => Ok(()),
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for checkpoint".to_owned(),
            )),
        }
    }

    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        {
            let transport = self.ensure_transport()?;
            if let Err(error) = write_request(
                transport,
                RequestFrame::ExecProtocolStream(request.as_bytes().to_vec()),
            ) {
                self.mark_broker_failed();
                return Err(error);
            }
        }

        let mut callback_error = None;
        loop {
            let response = {
                let transport = self.ensure_transport()?;
                read_response(transport)
            };
            match self.read_response_or_mark_failed(response)? {
                ResponseFrame::Chunk(bytes) => {
                    if callback_error.is_none()
                        && let Err(error) = on_chunk(&bytes)
                    {
                        callback_error = Some(error);
                    }
                }
                ResponseFrame::Ok(_) => return callback_error.map_or(Ok(()), Err),
                ResponseFrame::Error(message) => {
                    return callback_error.map_or(Err(Error::Engine(message)), Err);
                }
            }
        }
    }

    fn backup(&mut self, request: BackupRequest) -> Result<BackupArtifact> {
        let response = {
            let transport = self.ensure_transport()?;
            write_request(transport, RequestFrame::Backup(request.format))
                .and_then(|()| read_response(transport))
        };
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(bytes) => {
                let artifact = BackupArtifact {
                    format: request.format,
                    bytes,
                };
                if request.format != BackupFormat::PhysicalArchive {
                    return Ok(artifact);
                }
                let pgdata = self.launch_plan.root_path.join("pgdata");
                let selected_extensions = self.launch_plan.extensions.clone();
                annotate_physical_archive_backup(
                    artifact,
                    &pgdata,
                    &selected_extensions,
                    |request| self.exec_protocol_raw(request),
                )
            }
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for backup".to_owned(),
            )),
        }
    }

    fn close(&mut self) -> Result<()> {
        self.close_broker()
    }
}

#[derive(Clone)]
struct BrokerLaunchPlan {
    executable: PathBuf,
    config: OpenConfig,
    root_path: PathBuf,
    extensions: Vec<Extension>,
    endpoint: BrokerEndpoint,
    auth_token: BrokerAuthToken,
}

struct BrokerLaunch {
    child: Child,
    transport: Box<dyn BrokerTransport>,
    cancel_endpoint: String,
}

impl BrokerLaunchPlan {
    fn launch(&self) -> Result<BrokerLaunch> {
        let child = spawn_broker(
            &self.executable,
            &self.config,
            &self.root_path,
            &self.extensions,
            &self.endpoint,
            &self.auth_token,
        )?;
        let mut guard = BrokerChildLaunchGuard { child: Some(child) };
        let stdout = guard
            .child
            .as_mut()
            .expect("broker launch guard owns child until session handoff")
            .stdout
            .take()
            .ok_or_else(|| Error::Engine("broker child stdout was not captured".to_owned()))?;
        let ready = read_ready_line_from_child(
            guard
                .child
                .as_mut()
                .expect("broker launch guard owns child while waiting for ready line"),
            stdout,
        )?;
        let mut transport = self.endpoint.connect_primary(&ready)?;
        authenticate_broker(&mut transport, &self.auth_token)?;
        Ok(BrokerLaunch {
            child: guard
                .child
                .take()
                .expect("broker child exists after successful launch"),
            transport,
            cancel_endpoint: ready.cancel,
        })
    }
}

struct BrokerChildLaunchGuard {
    child: Option<Child>,
}

impl Drop for BrokerChildLaunchGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct BrokerCancel {
    endpoint: Mutex<String>,
    auth_token: String,
}

impl BrokerCancel {
    fn new(endpoint: String, auth_token: String) -> Self {
        Self {
            endpoint: Mutex::new(endpoint),
            auth_token,
        }
    }

    fn set_endpoint(&self, endpoint: String) -> Result<()> {
        *self.endpoint.lock().map_err(|_| {
            Error::Engine("native broker cancel endpoint lock poisoned".to_owned())
        })? = endpoint;
        Ok(())
    }
}

impl EngineCancel for BrokerCancel {
    fn cancel(&self) -> Result<()> {
        let endpoint = self
            .endpoint
            .lock()
            .map_err(|_| Error::Engine("native broker cancel endpoint lock poisoned".to_owned()))?
            .clone();
        let mut transport = connect_ready_endpoint(&endpoint)?;
        let token = BrokerAuthToken(self.auth_token.clone());
        authenticate_broker(&mut transport, &token)?;
        write_request(&mut transport, RequestFrame::Cancel)?;
        match read_response(&mut transport)? {
            ResponseFrame::Ok(_) => Ok(()),
            ResponseFrame::Error(message) => Err(Error::Engine(format!(
                "native broker cancel failed: {message}"
            ))),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for cancellation".to_owned(),
            )),
        }
    }
}

impl NativeBrokerSession {
    fn ensure_transport(&mut self) -> Result<&mut Box<dyn BrokerTransport>> {
        if self.closed {
            return Err(Error::EngineStopped);
        }
        if self.reap_exited_child()?.is_some() {
            self.transport = None;
        }
        if self.transport.is_none() {
            self.restart_broker()?;
        }
        self.transport.as_mut().ok_or(Error::EngineStopped)
    }

    fn read_response_or_mark_failed(
        &mut self,
        response: Result<ResponseFrame>,
    ) -> Result<ResponseFrame> {
        match response {
            Ok(frame) => Ok(frame),
            Err(error) => {
                self.mark_broker_failed();
                Err(error)
            }
        }
    }

    fn restart_broker(&mut self) -> Result<()> {
        if self.closed {
            return Err(Error::EngineStopped);
        }
        let launch = self.launch_plan.launch()?;
        self.cancel.set_endpoint(launch.cancel_endpoint)?;
        self.child = Some(launch.child);
        self.transport = Some(launch.transport);
        Ok(())
    }

    fn reap_exited_child(&mut self) -> Result<Option<ExitStatus>> {
        let status = match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|err| Error::Engine(format!("poll native broker helper: {err}")))?,
            None => None,
        };
        if status.is_some() {
            self.child = None;
            self.transport = None;
        }
        Ok(status)
    }

    fn mark_broker_failed(&mut self) {
        self.transport = None;
        if let Some(mut child) = self.child.take() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }

    fn close_broker(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        if let Some(transport) = self.transport.as_mut() {
            let _ = write_request(transport, RequestFrame::Close);
            let _ = read_response(transport);
        }
        self.transport = None;
        if let Some(mut child) = self.child.take() {
            match wait_for_child_exit(&mut child, BROKER_SHUTDOWN_TIMEOUT) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Err(err) => return Err(Error::Engine(format!("wait for native broker: {err}"))),
            }
        }
        if let Some(root) = self.temporary_root.take() {
            let _ = fs::remove_dir_all(root);
        }
        if let Some(path) = self.ipc_cleanup.take() {
            let _ = fs::remove_dir_all(path);
        }
        drop(self.root_lease.take());
        Ok(())
    }
}

impl Drop for NativeBrokerSession {
    fn drop(&mut self) {
        let _ = self.close_broker();
    }
}

struct BrokerOpenGuard {
    child: Option<Child>,
    temporary_root: Option<PathBuf>,
    ipc_cleanup: Option<PathBuf>,
    root_lease: Option<BrokerRootLease>,
}

impl BrokerOpenGuard {
    fn into_session_parts(mut self) -> (Child, Option<PathBuf>, Option<PathBuf>, BrokerRootLease) {
        (
            self.child
                .take()
                .expect("broker child exists after successful startup"),
            self.temporary_root.take(),
            self.ipc_cleanup.take(),
            self.root_lease
                .take()
                .expect("broker root lease exists after successful startup"),
        )
    }
}

impl Drop for BrokerOpenGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(root) = self.temporary_root.take() {
            let _ = fs::remove_dir_all(root);
        }
        if let Some(path) = self.ipc_cleanup.take() {
            let _ = fs::remove_dir_all(path);
        }
        drop(self.root_lease.take());
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

fn materialize_broker_root(root: &DatabaseRoot) -> Result<(PathBuf, Option<PathBuf>)> {
    match root {
        DatabaseRoot::Path(path) => Ok((path.clone(), None)),
        DatabaseRoot::Temporary => {
            let path = create_temporary_root()?;
            Ok((path.clone(), Some(path)))
        }
    }
}

fn create_temporary_root() -> Result<PathBuf> {
    let parent = env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))?
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("oliphaunt-broker-{pid}-{nanos}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(Error::Engine(format!(
                    "create temporary broker root {}: {err}",
                    path.display()
                )));
            }
        }
    }
    Err(Error::Engine(
        "failed to allocate a unique temporary broker root".to_owned(),
    ))
}

#[derive(Debug)]
struct BrokerSupervisor {
    max_roots: usize,
    roots: Mutex<HashSet<PathBuf>>,
}

impl BrokerSupervisor {
    fn new(max_roots: usize) -> Self {
        Self {
            max_roots,
            roots: Mutex::new(HashSet::new()),
        }
    }

    fn max_roots(&self) -> usize {
        self.max_roots
    }

    fn acquire_root(self: &Arc<Self>, root: &Path) -> Result<BrokerRootLease> {
        if self.max_roots == 0 {
            return Err(Error::InvalidConfig(
                "native broker max_roots must be greater than zero".to_owned(),
            ));
        }
        let key = broker_root_key(root)?;
        let mut roots = self
            .roots
            .lock()
            .map_err(|_| Error::Engine("native broker root registry was poisoned".to_owned()))?;
        if roots.contains(&key) {
            return Err(Error::Engine(format!(
                "native broker root {} is already open in this broker runtime",
                key.display()
            )));
        }
        if roots.len() >= self.max_roots {
            return Err(Error::Engine(format!(
                "native broker runtime already owns {} root(s), at configured capacity {}",
                roots.len(),
                self.max_roots
            )));
        }
        roots.insert(key.clone());
        Ok(BrokerRootLease {
            supervisor: Arc::clone(self),
            key: Some(key),
        })
    }

    fn release_root(&self, key: &Path) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.remove(key);
        }
    }
}

#[derive(Debug)]
struct BrokerRootLease {
    supervisor: Arc<BrokerSupervisor>,
    key: Option<PathBuf>,
}

impl Drop for BrokerRootLease {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.supervisor.release_root(&key);
        }
    }
}

fn broker_root_key(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|err| Error::Engine(format!("resolve broker root current directory: {err}")))?
            .join(path)
    };
    if let Ok(canonical) = absolute.canonicalize() {
        return Ok(canonical);
    }

    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    while let Some(name) = cursor.file_name() {
        missing.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        if let Ok(canonical_parent) = parent.canonicalize() {
            let mut key = canonical_parent;
            for component in missing.iter().rev() {
                key.push(component);
            }
            return Ok(normalize_path(&key));
        }
        cursor = parent;
    }

    Ok(normalize_path(&absolute))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn spawn_broker(
    executable: &Path,
    config: &OpenConfig,
    root: &Path,
    extensions: &[Extension],
    endpoint: &BrokerEndpoint,
    auth_token: &BrokerAuthToken,
) -> Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(broker_spawn_args(config, root, extensions, endpoint))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env(ENV_BROKER_AUTH_TOKEN, auth_token.as_str());
    if let BootstrapStrategy::InitdbToolingOnly { initdb } = &config.storage.bootstrap {
        command.env("OLIPHAUNT_INITDB", initdb);
    }
    command.spawn().map_err(|err| {
        Error::Engine(format!(
            "spawn native broker {}: {err}",
            executable.display()
        ))
    })
}

fn broker_spawn_args(
    config: &OpenConfig,
    root: &Path,
    extensions: &[Extension],
    endpoint: &BrokerEndpoint,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--root"),
        root.as_os_str().to_os_string(),
        OsString::from("--bootstrap"),
        OsString::from(match &config.storage.bootstrap {
            BootstrapStrategy::PackagedTemplate => "packaged-template",
            BootstrapStrategy::ExistingOnly => "existing-only",
            BootstrapStrategy::InitdbToolingOnly { .. } => "initdb-tooling-only",
        }),
        OsString::from("--durability"),
        OsString::from(match config.durability {
            crate::DurabilityProfile::Safe => "safe",
            crate::DurabilityProfile::Balanced => "balanced",
            crate::DurabilityProfile::FastDev => "fast-dev",
        }),
        OsString::from("--runtime-footprint"),
        OsString::from(match config.runtime_footprint {
            crate::RuntimeFootprintProfile::Throughput => "throughput",
            crate::RuntimeFootprintProfile::BalancedMobile => "balanced-mobile",
            crate::RuntimeFootprintProfile::SmallMobile => "small-mobile",
        }),
    ];
    if let BootstrapStrategy::InitdbToolingOnly { initdb } = &config.storage.bootstrap {
        args.push(OsString::from("--initdb"));
        args.push(initdb.as_os_str().to_os_string());
    }
    args.push(OsString::from("--username"));
    args.push(OsString::from(&config.username));
    args.push(OsString::from("--database"));
    args.push(OsString::from(&config.database));
    endpoint.add_args_to(&mut args);
    for extension in extensions {
        args.push(OsString::from("--extension"));
        args.push(OsString::from(extension.sql_name()));
    }
    for guc in &config.startup_gucs {
        args.push(OsString::from("--startup-guc"));
        args.push(OsString::from(format!("{}={}", guc.name, guc.value)));
    }
    args
}

fn authenticate_broker(
    transport: &mut Box<dyn BrokerTransport>,
    auth_token: &BrokerAuthToken,
) -> Result<()> {
    write_request(
        transport,
        RequestFrame::Authenticate(auth_token.as_str().to_owned()),
    )?;
    match read_response(transport)? {
        ResponseFrame::Ok(_) => Ok(()),
        ResponseFrame::Error(message) => Err(Error::Engine(format!(
            "native broker authentication failed: {message}"
        ))),
        ResponseFrame::Chunk(_) => Err(Error::Engine(
            "broker returned a stream chunk during authentication".to_owned(),
        )),
    }
}

#[derive(Clone)]
struct BrokerAuthToken(String);

impl BrokerAuthToken {
    fn generate() -> Result<Self> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|err| Error::Engine(format!("generate native broker auth token: {err}")))?;
        Ok(Self(hex_encode(&bytes)))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

struct BrokerReadyEndpoints {
    primary: String,
    cancel: String,
}

fn read_ready_line(stdout: &mut impl BufRead) -> Result<BrokerReadyEndpoints> {
    let mut line = String::new();
    stdout
        .read_line(&mut line)
        .map_err(|err| Error::Engine(format!("read native broker startup line: {err}")))?;
    if let Some(endpoints) = line.trim().strip_prefix(READY_PREFIX) {
        let mut parts = endpoints.split_whitespace();
        let primary = parts.next().ok_or_else(|| {
            Error::Engine("native broker ready line did not include a primary endpoint".to_owned())
        })?;
        let cancel = parts
            .next()
            .and_then(|part| part.strip_prefix("cancel="))
            .ok_or_else(|| {
                Error::Engine(
                    "native broker ready line did not include a cancel endpoint".to_owned(),
                )
            })?;
        return Ok(BrokerReadyEndpoints {
            primary: primary.to_owned(),
            cancel: cancel.to_owned(),
        });
    }
    if let Some(message) = line.trim().strip_prefix(ERROR_PREFIX) {
        return Err(Error::Engine(format!(
            "native broker failed to start: {message}"
        )));
    }
    Err(Error::Engine(format!(
        "native broker did not print a ready line: {}",
        line.trim()
    )))
}

fn read_ready_line_from_child(
    child: &mut Child,
    stdout: impl Read + Send + 'static,
) -> Result<BrokerReadyEndpoints> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("oliphaunt-broker-ready-reader".to_owned())
        .spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let _ = ready_tx.send(read_ready_line(&mut stdout));
        })
        .map_err(|err| Error::Engine(format!("spawn native broker ready reader: {err}")))?;

    let deadline = Instant::now() + BROKER_STARTUP_TIMEOUT;
    loop {
        match ready_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|err| Error::Engine(format!("poll native broker startup: {err}")))?
                {
                    return Err(Error::Engine(format!(
                        "native broker exited before printing a ready line: {status}"
                    )));
                }
                if Instant::now() >= deadline {
                    return Err(Error::Engine(format!(
                        "native broker did not print a ready line within {:?}",
                        BROKER_STARTUP_TIMEOUT
                    )));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.try_wait().map_err(|err| {
                    Error::Engine(format!("poll native broker after ready reader exit: {err}"))
                })?;
                let status = status
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "still running".to_owned());
                return Err(Error::Engine(format!(
                    "native broker ready reader exited without a startup line; child is {status}"
                )));
            }
        }
    }
}

fn resolve_broker_executable() -> Option<PathBuf> {
    if let Some(path) = env::var_os(ENV_BROKER).map(PathBuf::from) {
        return Some(path);
    }
    if let Some(path) = resolve_broker_executable_next_to_current_exe() {
        return Some(path);
    }
    resolve_broker_executable_from_asset_dir()
}

fn resolve_broker_executable_next_to_current_exe() -> Option<PathBuf> {
    let current = env::current_exe().ok()?;
    let dir = current.parent()?;
    for name in [
        "oliphaunt-broker",
        "oliphaunt-broker.exe",
        "oliphaunt_broker",
        "oliphaunt_broker.exe",
    ] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_broker_executable_from_asset_dir() -> Option<PathBuf> {
    let root = env::var_os(ENV_BROKER_ASSET_DIR).map(PathBuf::from)?;
    let target = current_broker_release_target()?;
    target
        .unpacked_executable_candidates(&root)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BrokerReleaseTarget {
    target: &'static str,
    asset_template: &'static str,
    executable_relative_path: &'static str,
}

impl BrokerReleaseTarget {
    fn asset_name(self) -> String {
        self.asset_template
            .replace("{version}", BROKER_RELEASE_VERSION)
    }

    fn archive_stem(self) -> String {
        self.asset_name()
            .trim_end_matches(".tar.gz")
            .trim_end_matches(".zip")
            .to_owned()
    }

    fn unpacked_executable_candidates(self, root: &Path) -> Vec<PathBuf> {
        let executable = Path::new(self.executable_relative_path);
        vec![
            root.join(executable),
            root.join(self.target).join(executable),
            root.join(self.archive_stem()).join(executable),
        ]
    }
}

fn current_broker_release_target() -> Option<BrokerReleaseTarget> {
    broker_release_target(env::consts::OS, env::consts::ARCH)
}

fn broker_release_target(os: &str, arch: &str) -> Option<BrokerReleaseTarget> {
    match (os, arch) {
        ("macos", "aarch64" | "arm64") => Some(BrokerReleaseTarget {
            target: "macos-arm64",
            asset_template: "oliphaunt-broker-{version}-macos-arm64.tar.gz",
            executable_relative_path: "bin/oliphaunt-broker",
        }),
        ("linux", "x86_64" | "x64" | "amd64") => Some(BrokerReleaseTarget {
            target: "linux-x64-gnu",
            asset_template: "oliphaunt-broker-{version}-linux-x64-gnu.tar.gz",
            executable_relative_path: "bin/oliphaunt-broker",
        }),
        ("linux", "aarch64" | "arm64") => Some(BrokerReleaseTarget {
            target: "linux-arm64-gnu",
            asset_template: "oliphaunt-broker-{version}-linux-arm64-gnu.tar.gz",
            executable_relative_path: "bin/oliphaunt-broker",
        }),
        ("windows", "x86_64" | "x64" | "amd64") => Some(BrokerReleaseTarget {
            target: "windows-x64-msvc",
            asset_template: "oliphaunt-broker-{version}-windows-x64-msvc.zip",
            executable_relative_path: "bin/oliphaunt-broker.exe",
        }),
        _ => None,
    }
}

enum BrokerEndpoint {
    #[cfg(unix)]
    Unix {
        dir: PathBuf,
        socket: PathBuf,
        cancel_socket: PathBuf,
    },
    Tcp {
        listen: String,
        cancel_listen: String,
    },
}

impl Clone for BrokerEndpoint {
    fn clone(&self) -> Self {
        match self {
            #[cfg(unix)]
            Self::Unix {
                dir,
                socket,
                cancel_socket,
            } => Self::Unix {
                dir: dir.clone(),
                socket: socket.clone(),
                cancel_socket: cancel_socket.clone(),
            },
            Self::Tcp {
                listen,
                cancel_listen,
            } => Self::Tcp {
                listen: listen.clone(),
                cancel_listen: cancel_listen.clone(),
            },
        }
    }
}

impl BrokerEndpoint {
    fn allocate() -> Result<Self> {
        if env::var(ENV_BROKER_TRANSPORT).ok().as_deref() == Some("tcp") {
            Ok(Self::Tcp {
                listen: "127.0.0.1:0".to_owned(),
                cancel_listen: "127.0.0.1:0".to_owned(),
            })
        } else {
            #[cfg(unix)]
            {
                let dir = create_temporary_ipc_dir()?;
                let socket = dir.join("s");
                let cancel_socket = dir.join("c");
                Ok(Self::Unix {
                    dir,
                    socket,
                    cancel_socket,
                })
            }

            #[cfg(not(unix))]
            {
                Ok(Self::Tcp {
                    listen: "127.0.0.1:0".to_owned(),
                    cancel_listen: "127.0.0.1:0".to_owned(),
                })
            }
        }
    }

    fn add_args_to(&self, args: &mut Vec<OsString>) {
        match self {
            #[cfg(unix)]
            Self::Unix {
                socket,
                cancel_socket,
                ..
            } => {
                args.push(OsString::from("--socket"));
                args.push(socket.as_os_str().to_os_string());
                args.push(OsString::from("--cancel-socket"));
                args.push(cancel_socket.as_os_str().to_os_string());
            }
            Self::Tcp {
                listen,
                cancel_listen,
            } => {
                args.push(OsString::from("--listen"));
                args.push(OsString::from(listen));
                args.push(OsString::from("--cancel-listen"));
                args.push(OsString::from(cancel_listen));
            }
        }
    }

    fn connect_primary(&self, ready: &BrokerReadyEndpoints) -> Result<Box<dyn BrokerTransport>> {
        match self {
            #[cfg(unix)]
            Self::Unix { socket, .. } => {
                let ready_socket = ready
                    .primary
                    .strip_prefix("unix:")
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        Error::Engine(format!(
                            "native broker printed unexpected Unix ready endpoint '{}'",
                            ready.primary
                        ))
                    })?;
                if ready_socket != *socket {
                    return Err(Error::Engine(format!(
                        "native broker ready socket {} did not match requested socket {}",
                        ready_socket.display(),
                        socket.display()
                    )));
                }
                connect_ready_endpoint(&ready.primary)
            }
            Self::Tcp { .. } => connect_ready_endpoint(&ready.primary),
        }
    }

    fn cleanup_path(&self) -> Option<PathBuf> {
        match self {
            #[cfg(unix)]
            Self::Unix { dir, .. } => Some(dir.clone()),
            Self::Tcp { .. } => None,
        }
    }
}

fn connect_ready_endpoint(ready_endpoint: &str) -> Result<Box<dyn BrokerTransport>> {
    if let Some(path) = ready_endpoint.strip_prefix("unix:") {
        #[cfg(unix)]
        {
            let path = PathBuf::from(path);
            return UnixStream::connect(&path)
                .map(|stream| Box::new(stream) as Box<dyn BrokerTransport>)
                .map_err(|err| {
                    Error::Engine(format!(
                        "connect to native broker Unix socket {}: {err}",
                        path.display()
                    ))
                });
        }

        #[cfg(not(unix))]
        {
            let _ = path;
            return Err(Error::Engine(
                "native broker returned a Unix socket endpoint on a non-Unix platform".to_owned(),
            ));
        }
    }

    let addr = ready_endpoint
        .strip_prefix("tcp:")
        .unwrap_or(ready_endpoint);
    let stream = TcpStream::connect(addr)
        .map_err(|err| Error::Engine(format!("connect to native broker {addr}: {err}")))?;
    stream
        .set_nodelay(true)
        .map_err(|err| Error::Engine(format!("set TCP_NODELAY for broker IPC: {err}")))?;
    Ok(Box::new(stream))
}

#[cfg(unix)]
fn create_temporary_ipc_dir() -> Result<PathBuf> {
    let parent = PathBuf::from("/tmp");
    let parent = if parent.is_dir() {
        parent
    } else {
        env::temp_dir()
    };
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))?
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("lpgo-{pid}-{nanos:x}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(Error::Engine(format!(
                    "create native broker IPC directory {}: {err}",
                    path.display()
                )));
            }
        }
    }
    Err(Error::Engine(
        "failed to allocate a unique native broker IPC directory".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn supervisor_admits_distinct_roots_until_capacity() {
        let supervisor = Arc::new(BrokerSupervisor::new(2));
        let first = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-root-a"))
            .unwrap();
        let second = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-root-b"))
            .unwrap();

        let error = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-root-c"))
            .unwrap_err();
        assert!(
            error.to_string().contains("configured capacity 2"),
            "unexpected capacity error: {error}"
        );

        drop(first);
        let reopened = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-root-c"))
            .unwrap();
        drop(reopened);
        drop(second);
    }

    #[test]
    fn supervisor_rejects_duplicate_open_roots() {
        let supervisor = Arc::new(BrokerSupervisor::new(2));
        let root =
            Path::new("target/liboliphaunt-broker-duplicate/../liboliphaunt-broker-duplicate");
        let _lease = supervisor.acquire_root(root).unwrap();

        let error = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-duplicate"))
            .unwrap_err();
        assert!(
            error.to_string().contains("already open"),
            "unexpected duplicate-root error: {error}"
        );
    }

    #[test]
    fn supervisor_rejects_zero_capacity() {
        let supervisor = Arc::new(BrokerSupervisor::new(0));
        let error = supervisor
            .acquire_root(Path::new("target/liboliphaunt-broker-root"))
            .unwrap_err();
        assert_eq!(
            error,
            Error::InvalidConfig("native broker max_roots must be greater than zero".to_owned())
        );
    }

    #[test]
    fn broker_spawn_args_forward_preload_required_extensions_to_helper_before_startup() {
        let mut config = OpenConfig::native_direct("target/liboliphaunt-broker-preload");
        config.mode = EngineMode::NativeBroker;
        config.username = "app_user".to_owned();
        config.database = "app_db".to_owned();
        config.extensions = vec![Extension::PgSearch, Extension::PgSearch];
        let extensions = config.resolved_extensions().unwrap();
        let endpoint = BrokerEndpoint::Tcp {
            listen: "127.0.0.1:0".to_owned(),
            cancel_listen: "127.0.0.1:0".to_owned(),
        };
        let args = broker_spawn_args(
            &config,
            &PathBuf::from("/tmp/oliphaunt-broker-preload-root"),
            &extensions,
            &endpoint,
        );
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_arg_pair(&args, "--username", "app_user");
        assert_arg_pair(&args, "--database", "app_db");
        assert_arg_pair(&args, "--extension", "pg_search");
        assert_eq!(
            args.windows(2)
                .filter(|window| window[0] == "--extension" && window[1] == "pg_search")
                .count(),
            1,
            "broker must forward deduplicated resolved extensions to the helper"
        );
    }

    fn expected_broker_asset(target: &str, suffix: &str) -> String {
        format!("oliphaunt-broker-{BROKER_RELEASE_VERSION}-{target}.{suffix}")
    }

    fn expected_broker_unpack_dir(target: &str) -> String {
        format!("oliphaunt-broker-{BROKER_RELEASE_VERSION}-{target}")
    }

    #[test]
    fn broker_release_targets_match_published_artifact_layout() {
        let cases = [
            (
                "macos",
                "aarch64",
                "macos-arm64",
                expected_broker_asset("macos-arm64", "tar.gz"),
                "bin/oliphaunt-broker",
            ),
            (
                "linux",
                "x86_64",
                "linux-x64-gnu",
                expected_broker_asset("linux-x64-gnu", "tar.gz"),
                "bin/oliphaunt-broker",
            ),
            (
                "linux",
                "aarch64",
                "linux-arm64-gnu",
                expected_broker_asset("linux-arm64-gnu", "tar.gz"),
                "bin/oliphaunt-broker",
            ),
            (
                "windows",
                "x86_64",
                "windows-x64-msvc",
                expected_broker_asset("windows-x64-msvc", "zip"),
                "bin/oliphaunt-broker.exe",
            ),
        ];

        for (os, arch, target_id, asset, executable) in cases {
            let target = broker_release_target(os, arch).expect("published broker target");
            assert_eq!(target.target, target_id);
            assert_eq!(target.asset_name(), asset.as_str());
            assert_eq!(target.executable_relative_path, executable);
        }
        assert!(broker_release_target("freebsd", "x86_64").is_none());
    }

    #[test]
    fn broker_release_asset_dir_candidates_cover_package_shapes() {
        let target = broker_release_target("windows", "x86_64").unwrap();
        let candidates = target.unpacked_executable_candidates(Path::new("/cache/broker"));
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/cache/broker/bin/oliphaunt-broker.exe"),
                PathBuf::from("/cache/broker/windows-x64-msvc/bin/oliphaunt-broker.exe"),
                PathBuf::from("/cache/broker")
                    .join(expected_broker_unpack_dir("windows-x64-msvc"))
                    .join("bin/oliphaunt-broker.exe"),
            ]
        );
    }

    fn assert_arg_pair(args: &[String], flag: &str, value: &str) {
        assert!(
            args.windows(2)
                .any(|window| window[0] == flag && window[1] == value),
            "missing broker helper argument pair {flag} {value} in {args:?}"
        );
    }
}
