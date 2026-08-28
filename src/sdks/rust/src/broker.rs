use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::child_process::reap_child_process;
use crate::config::{EngineMode, NativeBrokerConfig, OpenConfig};
use crate::engine::{EngineCancel, EngineSession, NativeRuntime, ProtocolStreamOutcome};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::ipc::{RequestFrame, ResponseFrame, read_response, write_request};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::DatabaseStorage;

const ENV_BROKER: &str = "OLIPHAUNT_BROKER";
const ENV_BROKER_ASSET_DIR: &str = "OLIPHAUNT_BROKER_ASSET_DIR";
const ENV_BROKER_TRANSPORT: &str = "OLIPHAUNT_BROKER_TRANSPORT";
const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";
const READY_PREFIX: &str = "OLIPHAUNT_BROKER_READY ";
const ERROR_PREFIX: &str = "OLIPHAUNT_BROKER_ERROR ";
const BROKER_RELEASE_VERSION: &str = "0.1.1";
const BROKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const BROKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

trait BrokerTransport: Read + Write + Send {}

impl<T> BrokerTransport for T where T: Read + Write + Send {}

/// Broker runtime backed by a local helper process.
///
/// Broker mode is intentionally separate from direct mode. The helper process
/// owns the native database instance and the direct PostgreSQL backend; the Rust SDK client
/// talks to it over a small length-prefixed local IPC protocol.
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
        let executable = self
            .executable
            .clone()
            .or_else(|| config.broker.executable.clone())
            .or_else(resolve_broker_executable)
            .ok_or_else(|| Error::Engine("native broker executable is unavailable".to_owned()))?;
        let (root_path, temporary_root) = materialize_broker_root(&config.storage)?;
        let mut open_guard = BrokerOpenGuard {
            child: None,
            temporary_root,
            ipc_cleanup: None,
        };
        let endpoint = BrokerEndpoint::allocate()?;
        open_guard.ipc_cleanup = endpoint.cleanup_path();
        let extensions = config.resolved_extensions()?;
        let auth_token = BrokerAuthToken::generate()?;
        let launch_plan = BrokerLaunchPlan {
            executable,
            config,
            root_path,
            extensions,
            endpoint,
            auth_token,
        };
        let launch = launch_plan.launch(&mut open_guard)?;
        let cancel = Arc::new(BrokerCancel::new(
            launch.cancel_endpoint,
            launch_plan.auth_token.as_str().to_owned(),
        ));
        let (child, temporary_root, ipc_cleanup) = open_guard.into_session_parts();

        Ok(Box::new(NativeBrokerSession {
            child: Some(child),
            transport: Some(launch.transport),
            cancel,
            temporary_root,
            ipc_cleanup,
            failure: None,
            closed: false,
        }))
    }
}

struct NativeBrokerSession {
    child: Option<Child>,
    transport: Option<Box<dyn BrokerTransport>>,
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
                "broker returned a stream chunk for buffered protocol execution".to_owned(),
            )),
            ResponseFrame::StreamCallbackAborted(message) => Err(unexpected_stream_abort(
                "buffered protocol execution",
                message,
            )),
        }
    }

    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        {
            let transport = match self.ensure_transport() {
                Ok(transport) => transport,
                Err(error) => return ProtocolStreamOutcome::SessionStateUnknown(error),
            };
            if let Err(error) = write_request(
                transport,
                RequestFrame::ExecProtocolStream(request.as_bytes().to_vec()),
            ) {
                self.mark_broker_failed(error.clone());
                return ProtocolStreamOutcome::SessionStateUnknown(error);
            }
        }

        let mut callback_error = None;
        loop {
            let response = {
                let transport = match self.ensure_transport() {
                    Ok(transport) => transport,
                    Err(error) => return ProtocolStreamOutcome::SessionStateUnknown(error),
                };
                read_response(transport)
            };
            let response = match self.read_response_or_mark_failed(response) {
                Ok(response) => response,
                Err(error) => return ProtocolStreamOutcome::SessionStateUnknown(error),
            };
            match response {
                ResponseFrame::Chunk(bytes) => {
                    if callback_error.is_none()
                        && let Err(error) = on_chunk(&bytes)
                    {
                        callback_error = Some(error);
                    }
                }
                terminal => return classify_stream_completion(terminal, callback_error),
            }
        }
    }

    #[cfg(feature = "__internal-broker-helper")]
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
            ResponseFrame::StreamCallbackAborted(message) => {
                Err(unexpected_stream_abort("simple-query execution", message))
            }
        }
    }

    fn backup(&mut self) -> Result<Vec<u8>> {
        let response = {
            let transport = self.ensure_transport()?;
            write_request(transport, RequestFrame::Backup).and_then(|()| read_response(transport))
        };
        match self.read_response_or_mark_failed(response)? {
            ResponseFrame::Ok(bytes) => Ok(bytes),
            ResponseFrame::Error(message) => Err(Error::Engine(message)),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "broker returned a stream chunk for backup".to_owned(),
            )),
            ResponseFrame::StreamCallbackAborted(message) => {
                Err(unexpected_stream_abort("backup", message))
            }
        }
    }

    fn close(&mut self) -> Result<()> {
        self.close_broker()
    }
}

struct BrokerLaunchPlan {
    executable: PathBuf,
    config: OpenConfig,
    root_path: PathBuf,
    extensions: Vec<Extension>,
    endpoint: BrokerEndpoint,
    auth_token: BrokerAuthToken,
}

struct BrokerLaunch {
    transport: Box<dyn BrokerTransport>,
    cancel_endpoint: String,
}

impl BrokerLaunchPlan {
    fn launch(&self, guard: &mut BrokerOpenGuard) -> Result<BrokerLaunch> {
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
        )?;
        let mut transport = self.endpoint.connect_primary(&ready)?;
        authenticate_broker(&mut transport, &self.auth_token)?;
        Ok(BrokerLaunch {
            transport,
            cancel_endpoint: ready.cancel,
        })
    }
}

struct BrokerCancel {
    endpoint: String,
    auth_token: String,
}

impl BrokerCancel {
    fn new(endpoint: String, auth_token: String) -> Self {
        Self {
            endpoint,
            auth_token,
        }
    }
}

impl EngineCancel for BrokerCancel {
    fn cancel(&self) -> Result<()> {
        let mut transport = connect_ready_endpoint(&self.endpoint)?;
        let token = BrokerAuthToken(self.auth_token.clone());
        authenticate_broker(&mut transport, &token)?;
        write_request(&mut transport, RequestFrame::Cancel)?;
        match read_response(&mut transport)? {
            ResponseFrame::Ok(_) => Ok(()),
            ResponseFrame::Error(message) => Err(Error::Engine(format!(
                "native broker cancel failed: {message}"
            ))),
            ResponseFrame::Chunk(_) => Err(Error::Engine(
                "native broker cancel endpoint returned a stream chunk".to_owned(),
            )),
            ResponseFrame::StreamCallbackAborted(message) => {
                Err(unexpected_stream_abort("cancellation", message))
            }
        }
    }
}

impl NativeBrokerSession {
    fn ensure_transport(&mut self) -> Result<&mut Box<dyn BrokerTransport>> {
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
        if let Some(mut child) = self.child.take() {
            let outcome = reap_child_process(
                &mut child,
                Duration::ZERO,
                BROKER_SHUTDOWN_TIMEOUT,
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
        if first_attempt {
            if let Some(transport) = self.transport.as_mut() {
                let _ = write_request(transport, RequestFrame::Close);
                let _ = read_response(transport);
            }
            self.transport = None;
        }
        let mut cleanup_failures = Vec::new();
        if let Some(child) = self.child.as_mut() {
            let outcome = reap_child_process(
                child,
                BROKER_SHUTDOWN_TIMEOUT,
                BROKER_SHUTDOWN_TIMEOUT,
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
                BROKER_SHUTDOWN_TIMEOUT,
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
            "native broker authentication returned a stream chunk".to_owned(),
        )),
        ResponseFrame::StreamCallbackAborted(message) => {
            Err(unexpected_stream_abort("authentication", message))
        }
    }
}

fn unexpected_stream_abort(operation: &str, message: String) -> Error {
    Error::Engine(format!(
        "native broker returned a stream callback-aborted completion for {operation}: {message}"
    ))
}

fn classify_stream_completion(
    response: ResponseFrame,
    callback_error: Option<Error>,
) -> ProtocolStreamOutcome {
    match response {
        ResponseFrame::Ok(_) => {
            ProtocolStreamOutcome::ReadyForQuery(callback_error.map_or(Ok(()), Err))
        }
        ResponseFrame::StreamCallbackAborted(message) => ProtocolStreamOutcome::ReadyForQuery(
            callback_error.map_or_else(|| Err(Error::Engine(message)), Err),
        ),
        ResponseFrame::Error(message) => {
            ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(message))
        }
        ResponseFrame::Chunk(_) => unreachable!("stream chunks are consumed before completion"),
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
    use super::*;
    use std::io::Cursor;

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
            child: Some(child),
            transport: Some(Box::new(Cursor::new(Vec::<u8>::new()))),
            cancel: Arc::new(BrokerCancel::new(
                "tcp:127.0.0.1:1".to_owned(),
                "fixture-token".to_owned(),
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
    fn broker_stream_recovery_proof_controls_callback_error_precedence() {
        let callback = Error::Engine("consumer stopped".to_owned());
        match classify_stream_completion(
            ResponseFrame::StreamCallbackAborted("helper callback stopped".to_owned()),
            Some(callback.clone()),
        ) {
            ProtocolStreamOutcome::ReadyForQuery(Err(error)) => {
                assert_eq!(error.kind(), callback.kind());
                assert_eq!(error.to_string(), callback.to_string());
            }
            _ => panic!("typed callback abort must retain ReadyForQuery proof"),
        }

        let recovery = Error::Engine("broker transport failed before ReadyForQuery".to_owned());
        match classify_stream_completion(ResponseFrame::Error(recovery.to_string()), Some(callback))
        {
            ProtocolStreamOutcome::SessionStateUnknown(error) => {
                assert_eq!(error.kind(), recovery.kind());
                assert_eq!(error.to_string(), recovery.to_string());
            }
            _ => panic!("independent broker failure must override the callback error"),
        }
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
