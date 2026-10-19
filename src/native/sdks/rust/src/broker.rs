use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::child_process::reap_child_process;
use crate::config::{
    CONTROL_TIMEOUT_ENV, DEFAULT_CONTROL_TIMEOUT, DEFAULT_STARTUP_TIMEOUT, EngineMode,
    NativeBrokerConfig, OpenConfig, lifecycle_timeout,
};
use crate::engine::{EngineCancel, EngineSession, NativeRuntime, ProtocolStreamOutcome};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::ipc::{RequestFrame, ResponseFrame, read_response, write_request};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::socket::LocalSocket;
use crate::storage::DatabaseStorage;
use oliphaunt_broker::pgwire;

const ENV_BROKER: &str = "OLIPHAUNT_BROKER";
const ENV_BROKER_ASSET_DIR: &str = "OLIPHAUNT_BROKER_ASSET_DIR";
const ENV_BROKER_TRANSPORT: &str = "OLIPHAUNT_BROKER_TRANSPORT";
const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";
const READY_PREFIX: &str = "OLIPHAUNT_BROKER_READY ";
const ERROR_PREFIX: &str = "OLIPHAUNT_BROKER_ERROR ";
const BROKER_RELEASE_VERSION: &str = "0.3.1";
const BROKER_STARTUP_TIMEOUT_ENV: &str = "OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS";

/// Broker runtime backed by a local helper process.
///
/// Broker mode is intentionally separate from direct mode. The helper process
/// owns the native database instance and the direct PostgreSQL backend; the Rust SDK client
/// uses PostgreSQL wire messages for SQL and a separate local management channel.
#[derive(Debug, Clone)]
pub(crate) struct NativeBrokerRuntime {
    executable: Option<PathBuf>,
}

impl NativeBrokerRuntime {
    /// Create a broker runtime that resolves the broker executable from package
    /// assets.
    pub(crate) fn from_package() -> Self {
        Self { executable: None }
    }

    /// Create a broker runtime from builder/broker configuration.
    pub(crate) fn from_config(config: &NativeBrokerConfig) -> Self {
        Self {
            executable: config.executable.clone(),
        }
    }
}

impl Default for NativeBrokerRuntime {
    fn default() -> Self {
        Self::from_package()
    }
}

impl NativeRuntime for NativeBrokerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        debug_assert_eq!(config.mode, EngineMode::Broker);
        config.validate()?;
        let startup_timeout =
            lifecycle_timeout(BROKER_STARTUP_TIMEOUT_ENV, DEFAULT_STARTUP_TIMEOUT)?;
        let control_timeout = lifecycle_timeout(CONTROL_TIMEOUT_ENV, DEFAULT_CONTROL_TIMEOUT)?;
        let executable = self
            .executable
            .clone()
            .or_else(|| config.broker.executable.clone())
            .or_else(resolve_broker_executable)
            .ok_or_else(|| Error::Engine("native broker executable is unavailable".to_owned()))?;
        let (root_path, temporary_root) = materialize_broker_root(&config.storage)?;
        let mut open_guard = BrokerOpenGuard {
            control_timeout,
            child: None,
            temporary_root,
            ipc_cleanup: None,
        };
        let endpoint = BrokerEndpoint::allocate()?;
        open_guard.ipc_cleanup = endpoint.cleanup_path();
        let extensions = config.resolved_extensions()?;
        if config.seed.is_some() {
            // Seed bytes stay in this process. Prepare the root using the same
            // guarded initialization as direct mode, then let the broker own it.
            let mut native = config.native_config();
            native.storage = DatabaseStorage::Directory(root_path.clone());
            drop(liboliphaunt_native_bindings::PreparedNativeRoot::prepare(
                &native,
                &extensions,
            )?);
        }
        let auth_token = BrokerAuthToken::generate()?;
        let launch_plan = BrokerLaunchPlan {
            startup_timeout,
            executable,
            config,
            root_path,
            extensions,
            endpoint,
            auth_token,
        };
        let launch = launch_plan.launch(&mut open_guard)?;
        let cancel = Arc::new(BrokerCancel::new(
            launch.sql_endpoint,
            launch.cancel_key,
            control_timeout,
        ));
        let (child, temporary_root, ipc_cleanup) = open_guard.into_session_parts();

        Ok(Box::new(NativeBrokerSession {
            control_timeout,
            child: Some(child),
            transport: Some(launch.transport),
            control: Some(launch.control),
            cancel,
            temporary_root,
            ipc_cleanup,
            failure: None,
            closed: false,
        }))
    }
}

struct NativeBrokerSession {
    control_timeout: Duration,
    child: Option<Child>,
    transport: Option<LocalSocket>,
    control: Option<LocalSocket>,
    cancel: Arc<BrokerCancel>,
    temporary_root: Option<PathBuf>,
    ipc_cleanup: Option<PathBuf>,
    failure: Option<Error>,
    closed: bool,
}

impl EngineSession for NativeBrokerSession {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let mut bytes = Vec::new();
        match self.exec_protocol_raw_stream(request, &mut |chunk| {
            if bytes.len().saturating_add(chunk.len()) > oliphaunt_query::wire::MAX_FRONTEND_MESSAGE
            {
                return Err(Error::Engine(
                    "broker buffered response exceeds size limit".to_owned(),
                ));
            }
            bytes.extend_from_slice(chunk);
            Ok(())
        }) {
            ProtocolStreamOutcome::ReadyForQuery(Ok(())) => Ok(ProtocolResponse::new(bytes)),
            ProtocolStreamOutcome::ReadyForQuery(Err(error))
            | ProtocolStreamOutcome::SessionStateUnknown(error) => Err(error),
        }
    }

    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        if let Err(error) = pgwire::completion_count(request.as_bytes()) {
            return ProtocolStreamOutcome::ReadyForQuery(Err(Error::Engine(error.to_string())));
        }
        let transport = match self.ensure_transport() {
            Ok(transport) => transport,
            Err(error) => return ProtocolStreamOutcome::SessionStateUnknown(error),
        };
        match pgwire::exchange(transport, request.as_bytes(), &mut |chunk| on_chunk(chunk)) {
            Ok(Some(error)) => ProtocolStreamOutcome::ReadyForQuery(Err(error)),
            Ok(None) => ProtocolStreamOutcome::ReadyForQuery(Ok(())),
            Err(error) => ProtocolStreamOutcome::SessionStateUnknown(
                self.mark_broker_failed(Error::Engine(error.to_string())),
            ),
        }
    }

    fn backup(&mut self) -> Result<Vec<u8>> {
        self.ensure_transport()?;
        let control = self.control.as_mut().ok_or(Error::EngineStopped)?;
        let response =
            write_request(control, RequestFrame::Backup).and_then(|()| read_response(control));
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(bytes) => Ok(bytes),
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
        }
    }

    fn close(&mut self) -> Result<()> {
        self.close_broker()
    }
}

struct BrokerLaunchPlan {
    startup_timeout: Duration,
    executable: PathBuf,
    config: OpenConfig,
    root_path: PathBuf,
    extensions: Vec<Extension>,
    endpoint: BrokerEndpoint,
    auth_token: BrokerAuthToken,
}

struct BrokerLaunch {
    transport: LocalSocket,
    control: LocalSocket,
    sql_endpoint: String,
    cancel_key: [u8; 8],
}

impl BrokerLaunchPlan {
    fn launch(&self, guard: &mut BrokerOpenGuard) -> Result<BrokerLaunch> {
        let deadline = Instant::now() + self.startup_timeout;
        guard.child = Some(spawn_broker(
            &self.executable,
            &self.config,
            &self.root_path,
            &self.extensions,
            &self.endpoint,
            &self.auth_token,
        )?);
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
            deadline,
        )?;
        let mut control = connect_ready_endpoint(&ready.control, deadline)?;
        authenticate_broker(&mut control, &self.auth_token)?;
        let mut transport = self.endpoint.connect_primary(&ready, deadline)?;
        let cancel_key = pgwire::authenticate(
            &mut transport,
            &self.config.username,
            &self.config.database,
            self.auth_token.as_str(),
        )
        .map_err(|error| Error::Engine(error.to_string()))?;
        transport
            .set_deadline(None)
            .map_err(|error| Error::Engine(error.to_string()))?;
        control
            .set_deadline(None)
            .map_err(|error| Error::Engine(error.to_string()))?;
        Ok(BrokerLaunch {
            transport,
            control,
            sql_endpoint: ready.primary,
            cancel_key,
        })
    }
}

struct BrokerCancel {
    control_timeout: Duration,
    endpoint: String,
    key: [u8; 8],
}

impl BrokerCancel {
    fn new(endpoint: String, key: [u8; 8], control_timeout: Duration) -> Self {
        Self {
            endpoint,
            key,
            control_timeout,
        }
    }
}

impl EngineCancel for BrokerCancel {
    fn cancel(&self) -> Result<()> {
        let mut transport =
            connect_ready_endpoint(&self.endpoint, Instant::now() + self.control_timeout)?;
        pgwire::cancel(&mut transport, &self.key).map_err(|error| Error::Engine(error.to_string()))
    }
}

impl NativeBrokerSession {
    fn ensure_transport(&mut self) -> Result<&mut LocalSocket> {
        if self.closed {
            return Err(Error::EngineStopped);
        }
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }

        let exited = match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    let error = Error::Engine(format!(
                        "poll native broker helper: {error}; close and reopen the database"
                    ));
                    return Err(self.mark_broker_failed(error));
                }
            },
            None => {
                let error = Error::Engine(
                    "native broker helper is unavailable; close and reopen the database".to_owned(),
                );
                return Err(self.mark_broker_failed(error));
            }
        };
        if let Some(status) = exited {
            self.child = None;
            self.transport = None;
            let error = Error::Engine(format!(
                "native broker helper exited unexpectedly ({status}); close and reopen the database"
            ));
            self.failure = Some(error.clone());
            return Err(error);
        }
        if self.transport.is_none() {
            let error = Error::Engine(
                "native broker transport is unavailable; close and reopen the database".to_owned(),
            );
            return Err(self.mark_broker_failed(error));
        }
        Ok(self
            .transport
            .as_mut()
            .expect("native broker transport was checked above"))
    }

    fn read_response_or_mark_failed(
        &mut self,
        response: Result<ResponseFrame>,
    ) -> Result<ResponseFrame> {
        match response {
            Ok(frame) => Ok(frame),
            Err(error) => {
                self.mark_broker_failed(error.clone());
                Err(error)
            }
        }
    }

    fn mark_broker_failed(&mut self, error: Error) -> Error {
        let first_error = self.failure.get_or_insert(error).clone();
        self.transport = None;
        self.control = None;
        if let Some(mut child) = self.child.take() {
            let outcome = reap_child_process(
                &mut child,
                Duration::ZERO,
                self.control_timeout,
                "failed native broker",
            );
            if !outcome.reaped {
                // Keep the process handle so explicit close can retry reaping
                // it without weakening the terminal session failure.
                self.child = Some(child);
            }
        }
        first_error
    }

    fn close_broker(&mut self) -> Result<()> {
        let first_attempt = !self.closed;
        self.closed = true;
        let mut cleanup_failures = Vec::new();
        if first_attempt {
            let deadline = Instant::now() + self.control_timeout;
            if let Some(mut transport) = self.transport.take() {
                let result = transport
                    .set_deadline(Some(deadline))
                    .and_then(|()| transport.write_all(&[b'X', 0, 0, 0, 4]));
                if let Err(error) = result {
                    cleanup_failures
                        .push(format!("terminate native broker SQL connection: {error}"));
                }
            }
            if let Some(mut control) = self.control.take() {
                let response = control
                    .set_deadline(Some(deadline))
                    .map_err(|error| Error::Engine(error.to_string()))
                    .and_then(|()| write_request(&mut control, RequestFrame::Close))
                    .and_then(|()| read_response(&mut control));
                match response {
                    Ok(ResponseFrame::Ok(_)) => {}
                    Ok(ResponseFrame::Error(message)) => {
                        cleanup_failures.push(format!("native broker close failed: {message}"))
                    }
                    Err(error) => cleanup_failures
                        .push(format!("native broker close acknowledgement: {error}")),
                }
            }
        }
        if let Some(child) = self.child.as_mut() {
            let outcome = reap_child_process(
                child,
                self.control_timeout,
                self.control_timeout,
                "native broker",
            );
            cleanup_failures.extend(outcome.failures);
            if outcome.reaped {
                self.child = None;
            }
        }
        // Never delete PGDATA or the IPC tree underneath a process whose reap
        // remains unconfirmed. A package-internal retry can remove the exact
        // retained paths after it conclusively reaps the child.
        if self.child.is_none() {
            if let Some(root) = self.temporary_root.as_ref() {
                match fs::remove_dir_all(root) {
                    Ok(()) => self.temporary_root = None,
                    Err(error) => cleanup_failures.push(format!(
                        "remove temporary broker root {}: {error}",
                        root.display()
                    )),
                }
            }
            if let Some(path) = self.ipc_cleanup.as_ref() {
                match fs::remove_dir_all(path) {
                    Ok(()) => self.ipc_cleanup = None,
                    Err(error) => cleanup_failures.push(format!(
                        "remove native broker IPC directory {}: {error}",
                        path.display()
                    )),
                }
            }
        }
        if !cleanup_failures.is_empty() {
            return Err(Error::Engine(format!(
                "native broker cleanup failed: {}",
                cleanup_failures.join("; ")
            )));
        }
        Ok(())
    }
}

impl Drop for NativeBrokerSession {
    fn drop(&mut self) {
        if self.close_broker().is_err() {
            // A terminal destructor has no later retry owner. Retain an
            // unreaped child handle for process lifetime; dropping PathBuf
            // values has no filesystem cleanup behavior.
            if let Some(child) = self.child.take() {
                std::mem::forget(child);
            }
        }
    }
}

struct BrokerOpenGuard {
    control_timeout: Duration,
    child: Option<Child>,
    temporary_root: Option<PathBuf>,
    ipc_cleanup: Option<PathBuf>,
}

impl BrokerOpenGuard {
    fn into_session_parts(mut self) -> (Child, Option<PathBuf>, Option<PathBuf>) {
        (
            self.child
                .take()
                .expect("broker child exists after successful startup"),
            self.temporary_root.take(),
            self.ipc_cleanup.take(),
        )
    }
}

impl Drop for BrokerOpenGuard {
    fn drop(&mut self) {
        let reaped = if let Some(mut child) = self.child.take() {
            let outcome = reap_child_process(
                &mut child,
                Duration::ZERO,
                self.control_timeout,
                "failed broker open",
            );
            if !outcome.reaped {
                std::mem::forget(child);
            }
            outcome.reaped
        } else {
            true
        };
        if !reaped {
            // The helper may still own both trees. PathBuf has no cleanup
            // destructor, so retaining means deliberately skipping deletion.
            return;
        }
        if let Some(root) = self.temporary_root.take() {
            let _ = fs::remove_dir_all(root);
        }
        if let Some(path) = self.ipc_cleanup.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn materialize_broker_root(storage: &DatabaseStorage) -> Result<(PathBuf, Option<PathBuf>)> {
    match storage {
        DatabaseStorage::Directory(path) => Ok((path.clone(), None)),
        DatabaseStorage::TemporaryDirectory => {
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

fn spawn_broker(
    executable: &Path,
    config: &OpenConfig,
    root: &Path,
    extensions: &[Extension],
    endpoint: &BrokerEndpoint,
    auth_token: &BrokerAuthToken,
) -> Result<Child> {
    let mut command = Command::new(executable);
    if let Some(resources) =
        liboliphaunt_native_bindings::extension::materialize_extension_resources(extensions)?
    {
        command.env("OLIPHAUNT_EXTENSION_RESOURCES_DIR", resources);
    } else {
        command.env_remove("OLIPHAUNT_EXTENSION_RESOURCES_DIR");
    }
    if let Some(resources) = liboliphaunt_native_bindings::resources_dir_candidates().first() {
        command.env("OLIPHAUNT_RESOURCES_DIR", resources);
    }
    command
        .args(broker_spawn_args(config, root, extensions, endpoint))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env(ENV_BROKER_AUTH_TOKEN, auth_token.as_str());
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
    let mut args = vec![OsString::from("--root"), root.as_os_str().to_os_string()];
    args.push(OsString::from("--username"));
    args.push(OsString::from(&config.username));
    args.push(OsString::from("--database"));
    args.push(OsString::from(&config.database));
    endpoint.add_args_to(&mut args);
    if let Some(data) = &config.icu_data {
        args.push(OsString::from("--icu-data-directory"));
        args.push(data.directory.as_os_str().to_os_string());
        args.push(OsString::from("--icu-data-manifest"));
        args.push(data.manifest.as_os_str().to_os_string());
    }
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

fn authenticate_broker(transport: &mut LocalSocket, auth_token: &BrokerAuthToken) -> Result<()> {
    write_request(
        transport,
        RequestFrame::Authenticate(auth_token.as_str().to_owned()),
    )?;
    match read_response(transport)? {
        ResponseFrame::Ok(_) => Ok(()),
        ResponseFrame::Error(message) => Err(Error::Engine(format!(
            "native broker authentication failed: {message}"
        ))),
    }
}

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
    control: String,
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
        let control = parts
            .next()
            .and_then(|part| part.strip_prefix("control="))
            .ok_or_else(|| {
                Error::Engine(
                    "native broker ready line did not include a management endpoint".to_owned(),
                )
            })?;
        return Ok(BrokerReadyEndpoints {
            primary: primary.to_owned(),
            control: control.to_owned(),
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
    deadline: Instant,
) -> Result<BrokerReadyEndpoints> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("oliphaunt-broker-ready-reader".to_owned())
        .spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let _ = ready_tx.send(read_ready_line(&mut stdout));
        })
        .map_err(|err| Error::Engine(format!("spawn native broker ready reader: {err}")))?;

    loop {
        match ready_rx.recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(50)),
        ) {
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
                    return Err(Error::Engine(
                        "native broker did not print a ready line before the startup deadline"
                            .to_owned(),
                    ));
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
    if let Some(target) = current_broker_release_target() {
        for root in liboliphaunt_native_bindings::resources_dir_candidates() {
            let candidate = root
                .join("broker-helper/oliphaunt-broker")
                .join(target.executable_relative_path);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
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
        control_socket: PathBuf,
    },
    Tcp {
        listen: String,
        control_listen: String,
    },
}

impl BrokerEndpoint {
    fn allocate() -> Result<Self> {
        if env::var(ENV_BROKER_TRANSPORT).ok().as_deref() == Some("tcp") {
            Ok(Self::Tcp {
                listen: "127.0.0.1:0".to_owned(),
                control_listen: "127.0.0.1:0".to_owned(),
            })
        } else {
            #[cfg(unix)]
            {
                let dir = create_temporary_ipc_dir()?;
                let socket = dir.join("s");
                let control_socket = dir.join("c");
                Ok(Self::Unix {
                    dir,
                    socket,
                    control_socket,
                })
            }

            #[cfg(not(unix))]
            {
                Ok(Self::Tcp {
                    listen: "127.0.0.1:0".to_owned(),
                    control_listen: "127.0.0.1:0".to_owned(),
                })
            }
        }
    }

    fn add_args_to(&self, args: &mut Vec<OsString>) {
        match self {
            #[cfg(unix)]
            Self::Unix {
                socket,
                control_socket,
                ..
            } => {
                args.push(OsString::from("--socket"));
                args.push(socket.as_os_str().to_os_string());
                args.push(OsString::from("--control-socket"));
                args.push(control_socket.as_os_str().to_os_string());
            }
            Self::Tcp {
                listen,
                control_listen,
            } => {
                args.push(OsString::from("--listen"));
                args.push(OsString::from(listen));
                args.push(OsString::from("--control-listen"));
                args.push(OsString::from(control_listen));
            }
        }
    }

    fn connect_primary(
        &self,
        ready: &BrokerReadyEndpoints,
        deadline: Instant,
    ) -> Result<LocalSocket> {
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
                connect_ready_endpoint(&ready.primary, deadline)
            }
            Self::Tcp { .. } => connect_ready_endpoint(&ready.primary, deadline),
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

fn connect_ready_endpoint(ready_endpoint: &str, deadline: Instant) -> Result<LocalSocket> {
    let result = if let Some(path) = ready_endpoint.strip_prefix("unix:") {
        #[cfg(unix)]
        {
            LocalSocket::unix(Path::new(path), deadline)
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            return Err(Error::Engine(
                "Unix sockets are unavailable on this target".to_owned(),
            ));
        }
    } else {
        let address = ready_endpoint
            .strip_prefix("tcp:")
            .unwrap_or(ready_endpoint)
            .parse()
            .map_err(|err| {
                Error::Engine(format!(
                    "invalid native broker endpoint {ready_endpoint}: {err}"
                ))
            })?;
        LocalSocket::tcp(address, deadline)
    };
    result.map_err(|err| Error::Engine(format!("connect to native broker {ready_endpoint}: {err}")))
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
    use super::*;

    #[test]
    fn close_bounds_a_silent_control_peer_with_the_configured_budget() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let control = LocalSocket::tcp(
            listener.local_addr().unwrap(),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let (_peer, _) = listener.accept().unwrap();
        let control_timeout = Duration::from_millis(30);
        let temporary_root = create_temporary_root().unwrap();
        let mut session = NativeBrokerSession {
            control_timeout,
            child: None,
            transport: None,
            control: Some(control),
            cancel: Arc::new(BrokerCancel::new(
                "tcp:127.0.0.1:1".to_owned(),
                [0; 8],
                control_timeout,
            )),
            temporary_root: Some(temporary_root.clone()),
            ipc_cleanup: None,
            failure: None,
            closed: false,
        };
        let start = Instant::now();
        let error = session.close_broker().unwrap_err();
        assert!(error.to_string().contains("close acknowledgement"));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(session.closed);
        assert!(!temporary_root.exists());
    }

    #[test]
    fn close_preserves_native_control_error_and_still_releases_paths() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let control = LocalSocket::tcp(
            listener.local_addr().unwrap(),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        let reply = std::thread::spawn(move || {
            assert!(matches!(
                oliphaunt_broker::ipc::read_request(&mut peer).unwrap(),
                RequestFrame::Close
            ));
            oliphaunt_broker::ipc::write_response(
                &mut peer,
                ResponseFrame::Error("reset failed".to_owned()),
            )
            .unwrap();
        });
        let temporary_root = create_temporary_root().unwrap();
        let mut session = NativeBrokerSession {
            control_timeout: DEFAULT_CONTROL_TIMEOUT,
            child: None,
            transport: None,
            control: Some(control),
            cancel: Arc::new(BrokerCancel::new(
                "tcp:127.0.0.1:1".to_owned(),
                [0; 8],
                DEFAULT_CONTROL_TIMEOUT,
            )),
            temporary_root: Some(temporary_root.clone()),
            ipc_cleanup: None,
            failure: None,
            closed: false,
        };
        let error = session.close_broker().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("native broker close failed: reset failed")
        );
        assert!(session.closed);
        assert!(!temporary_root.exists());
        reply.join().unwrap();
    }

    #[test]
    fn exited_broker_is_terminal_for_the_existing_session_and_close_still_cleans_up() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "23"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 23"]);
            command
        };
        let mut child = command.spawn().expect("spawn exited broker fixture");
        let exit = child.wait().expect("wait for exited broker fixture");
        let temporary_root = create_temporary_root().expect("temporary broker root");
        let ipc_cleanup = create_temporary_root().expect("temporary broker IPC root");
        let mut session = NativeBrokerSession {
            control_timeout: DEFAULT_CONTROL_TIMEOUT,
            child: Some(child),
            transport: None,
            control: None,
            cancel: Arc::new(BrokerCancel::new(
                "tcp:127.0.0.1:1".to_owned(),
                [0; 8],
                DEFAULT_CONTROL_TIMEOUT,
            )),
            temporary_root: Some(temporary_root.clone()),
            ipc_cleanup: Some(ipc_cleanup.clone()),
            failure: None,
            closed: false,
        };

        let first = match session.ensure_transport() {
            Ok(_) => panic!("an exited broker must never be replaced under the same session"),
            Err(error) => error,
        };
        assert!(
            first
                .to_string()
                .contains(&format!("exited unexpectedly ({exit})")),
            "the first failure must identify the observed helper exit: {first}"
        );
        assert!(first.to_string().contains("close and reopen"));
        assert!(session.child.is_none());
        assert!(session.transport.is_none());

        let second = match session.ensure_transport() {
            Ok(_) => panic!("a failed broker session must stay failed"),
            Err(error) => error,
        };
        assert_eq!(
            second.kind(),
            first.kind(),
            "later calls must retain the first failure category"
        );
        assert_eq!(
            second.to_string(),
            first.to_string(),
            "later calls must retain the first failure diagnostics"
        );

        session.close_broker().expect("failed broker close");
        session
            .close_broker()
            .expect("idempotent failed broker close");
        assert!(!temporary_root.exists());
        assert!(!ipc_cleanup.exists());
    }

    #[test]
    fn broker_spawn_args_forward_preload_required_extensions_to_helper_before_startup() {
        let mut config = OpenConfig::direct("target/liboliphaunt-broker-preload");
        config.mode = EngineMode::Broker;
        config.username = "app_user".to_owned();
        config.database = "app_db".to_owned();
        config.extensions = vec![Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH];
        let extensions = config.resolved_extensions().unwrap();
        let endpoint = BrokerEndpoint::Tcp {
            listen: "127.0.0.1:0".to_owned(),
            control_listen: "127.0.0.1:0".to_owned(),
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
        assert_arg_pair(&args, "--extension", "pg_textsearch");
        assert_eq!(
            args.windows(2)
                .filter(|window| window[0] == "--extension" && window[1] == "pg_textsearch")
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
