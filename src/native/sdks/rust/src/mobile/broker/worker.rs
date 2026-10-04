use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use liboliphaunt_native_bindings::{NativeOpenOptions, NativeSession};
use oliphaunt_broker::mobile::{self as wire, Kind};

use super::watchdog::{Expiry, SETTLEMENT, Watchdog};
use super::{Completion, Epoch, Execution, Reason, block_on, failure};
use crate::engine::{EngineCancel, EngineSession, ProtocolStreamOutcome};
use crate::executor::{EngineExecutor, run_off_thread};
use crate::mobile::Request;
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::{AsyncOliphaunt, Error, Result};

static WORKER_CLAIMED: AtomicBool = AtomicBool::new(false);

/// Installed only by the platform's verified, dedicated worker entry point.
/// The host client never has access to process termination through this trait.
pub trait Retirement: Send + Sync + 'static {
    fn retire(&self);
}

pub struct Ready {
    pub epoch: Epoch,
    pub abi: u32,
    pub runtime_version: String,
}

#[derive(Default)]
struct State {
    completed: u64,
    active: Option<(u64, Arc<Request>)>,
    early_cancel: Option<u64>,
    ready: bool,
    restoring: bool,
    closing: bool,
}

pub struct Worker {
    epoch: Epoch,
    socket: Mutex<Option<UnixStream>>,
    shutdown: UnixStream,
    retirement: Arc<dyn Retirement>,
    retired: AtomicBool,
    state: Mutex<State>,
    database: OnceLock<AsyncOliphaunt>,
    watchdog: OnceLock<Watchdog>,
}

impl Worker {
    /// Call before preparing resources. Every process can own only one worker
    /// generation, even if the OS reattaches an old service/extension instance.
    pub fn new(
        socket: UnixStream,
        retirement: Arc<dyn Retirement>,
        startup_timeout: Duration,
    ) -> Result<Arc<Self>> {
        if WORKER_CLAIMED.swap(true, Ordering::AcqRel) {
            return Err(failure(
                Reason::WorkerInterrupted,
                Execution::NotStarted,
                true,
                "worker process is already owned or retired",
            ));
        }
        let epoch = wire::new_epoch().map_err(|e| Error::Engine(e.to_string()))?;
        let shutdown = socket
            .try_clone()
            .map_err(|e| Error::Engine(e.to_string()))?;
        let worker = Arc::new(Self {
            epoch,
            socket: Mutex::new(Some(socket)),
            shutdown,
            retirement,
            retired: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            database: OnceLock::new(),
            watchdog: OnceLock::new(),
        });
        let weak = Arc::downgrade(&worker);
        let watchdog = Watchdog::new(move |request, action| {
            if let Some(worker) = weak.upgrade() {
                worker.expired(request, action);
            }
        })?;
        worker
            .watchdog
            .set(watchdog)
            .ok()
            .expect("watchdog installed once");
        worker
            .watchdog
            .get()
            .unwrap()
            .arm(0, startup_timeout, Expiry::Retire);
        Ok(worker)
    }

    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    pub async fn open(&self, options: NativeOpenOptions) -> Result<Ready> {
        let (executor, (abi, runtime_version)) =
            EngineExecutor::open("oliphaunt-broker-worker", move || {
                let session = NativeSession::open_prepared_inputs(options)?;
                let metadata = (session.abi_version(), session.runtime_version()?);
                Ok((Box::new(WorkerSession(session)), metadata))
            })
            .await?;
        let database = AsyncOliphaunt::from_executor(executor);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing || self.retired.load(Ordering::Acquire) {
            return Err(failure(
                Reason::Cancelled,
                Execution::NotStarted,
                true,
                "broker open was cancelled",
            ));
        }
        self.database
            .set(database)
            .map_err(|_| Error::Engine("worker initialized twice".into()))?;
        state.ready = true;
        self.watchdog.get().unwrap().clear(0);
        Ok(Ready {
            epoch: self.epoch,
            abi,
            runtime_version,
        })
    }

    pub fn cancel(&self, epoch: Epoch, request: u64) {
        if epoch != self.epoch || request == 0 {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing || request <= state.completed {
            return;
        }
        if state.restoring && request == 1 {
            let _ = self.shutdown.shutdown(Shutdown::Read);
        } else if let Some((id, operation)) = &state.active {
            if *id != request || operation.was_cancelled() {
                return;
            }
            let _ = operation.cancel();
        } else if state.completed.checked_add(1) == Some(request) {
            if state.early_cancel == Some(request) {
                return;
            }
            state.early_cancel = Some(request);
        } else {
            return;
        }
        self.watchdog
            .get()
            .unwrap()
            .arm(request, SETTLEMENT, Expiry::Retire);
    }

    pub fn close(&self, epoch: Epoch) {
        if epoch != self.epoch {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing {
            return;
        }
        state.closing = true;
        if let Some((_, request)) = &state.active {
            let _ = request.cancel();
        }
        self.watchdog
            .get()
            .unwrap()
            .arm(0, SETTLEMENT, Expiry::Retire);
        // Wake an idle/upload reader; keep the output half for terminal results.
        let _ = self.shutdown.shutdown(Shutdown::Read);
    }

    fn expired(&self, request: u64, action: Expiry) {
        match action {
            Expiry::Cancel => self.cancel(self.epoch, request),
            Expiry::Retire => {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let current = (request == 0 && (!state.ready || state.closing))
                    || state.active.as_ref().is_some_and(|(id, _)| *id == request)
                    || state.early_cancel == Some(request)
                    || (state.restoring && request == 1);
                drop(state);
                if current {
                    self.retire();
                }
            }
        }
    }

    pub fn retire(&self) {
        if !self.retired.swap(true, Ordering::AcqRel) {
            self.watchdog.get().unwrap().stop();
            let _ = self.shutdown.shutdown(Shutdown::Both);
            self.retirement.retire();
        }
    }

    /// A restore owns a fresh worker and never opens a PostgreSQL session.
    /// Publication and destination checks remain in the native archive owner.
    pub async fn restore(
        self: Arc<Self>,
        library: Option<PathBuf>,
        destination: PathBuf,
    ) -> Result<()> {
        run_off_thread("oliphaunt-broker-restore", move || {
            let mut socket = self
                .socket
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .ok_or_else(|| Error::Engine("worker transport already started".into()))?;
            let result = (|| -> Result<()> {
                let begin =
                    wire::read_frame(&mut socket).map_err(|e| Error::Engine(e.to_string()))?;
                if begin.epoch != self.epoch || begin.request != 1 || begin.kind != Kind::Restore {
                    return Err(Error::Engine("invalid restore operation".into()));
                }
                let timeout = u64::from_be_bytes(begin.payload[8..].try_into().unwrap());
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    if state.closing || state.early_cancel == Some(1) {
                        return Err(failure(
                            Reason::Cancelled,
                            Execution::NotStarted,
                            false,
                            "restore cancelled before dispatch",
                        ));
                    }
                    state.restoring = true;
                    state.ready = true;
                    self.watchdog.get().unwrap().clear(0);
                    if timeout != 0 {
                        self.watchdog.get().unwrap().arm(
                            1,
                            Duration::from_millis(timeout),
                            Expiry::Cancel,
                        );
                    }
                }
                let mut reader = BulkReader {
                    socket: &mut socket,
                    epoch: self.epoch,
                    request: 1,
                    remaining: u64::from_be_bytes(begin.payload[..8].try_into().unwrap()),
                    chunk: io::Cursor::new(Vec::new()),
                    ended: false,
                };
                match library {
                    Some(path) => {
                        NativeSession::restore_reader_from_library(&path, &destination, &mut reader)
                    }
                    None => NativeSession::restore_reader_from_current_process(
                        &destination,
                        &mut reader,
                    ),
                }
                .map_err(Into::into)
            })();
            let completion = match &result {
                Ok(()) => Completion::success(),
                Err(error) => error.broker_failure().cloned().unwrap_or(Completion {
                    reason: Reason::Database,
                    execution: Execution::Unknown,
                    requires_reopen: true,
                    detail: error.to_string(),
                }),
            };
            let _ = self.shutdown.shutdown(Shutdown::Read);
            let _ = wire::write_frame(
                &mut socket,
                Kind::Terminal,
                self.epoch,
                1,
                &completion.encode(),
            );
            self.retire();
            result
        })
        .await
    }

    pub async fn serve(self: Arc<Self>) -> Result<()> {
        run_off_thread("oliphaunt-broker-transport", move || self.serve_blocking()).await
    }

    fn serve_blocking(self: &Arc<Self>) -> Result<()> {
        let mut socket = self
            .socket
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| Error::Engine("worker transport already started".into()))?;
        let database = self
            .database
            .get()
            .ok_or_else(|| Error::Engine("worker is not ready".into()))?;
        let result = (|| -> io::Result<()> {
            loop {
                if self.state.lock().unwrap_or_else(|e| e.into_inner()).closing {
                    break;
                }
                let begin = wire::read_frame(&mut socket)?;
                if begin.epoch != self.epoch || !matches!(begin.kind, Kind::Query | Kind::Backup) {
                    return Err(wire::invalid("invalid worker operation"));
                }
                let length = u64::from_be_bytes(begin.payload[..8].try_into().unwrap());
                let timeout = u64::from_be_bytes(begin.payload[8..].try_into().unwrap());
                if length > wire::INPUT_BYTES as u64 || (begin.kind == Kind::Backup && length != 0)
                {
                    return Err(wire::invalid("invalid worker input length"));
                }
                let request = Arc::new(Request::new(database));
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    if state.completed.checked_add(1) != Some(begin.request)
                        || state.active.is_some()
                        || state.closing
                    {
                        return Err(wire::invalid("out-of-order worker request"));
                    }
                    if state.early_cancel.take() == Some(begin.request) {
                        let _ = request.cancel();
                    } else if timeout != 0 {
                        self.watchdog.get().unwrap().arm(
                            begin.request,
                            Duration::from_millis(timeout),
                            Expiry::Cancel,
                        );
                    }
                    state.active = Some((begin.request, request.clone()));
                }
                let mut input = Vec::with_capacity(length as usize);
                loop {
                    let frame = wire::read_frame(&mut socket)?;
                    if frame.epoch != self.epoch || frame.request != begin.request {
                        return Err(wire::invalid("stale worker input"));
                    }
                    match frame.kind {
                        Kind::Data if frame.payload.len() <= length as usize - input.len() => {
                            input.extend_from_slice(&frame.payload)
                        }
                        Kind::End if input.len() == length as usize => break,
                        _ => return Err(wire::invalid("incomplete or oversized worker input")),
                    }
                }
                let output = BulkWriter {
                    socket: socket.try_clone()?,
                    epoch: self.epoch,
                    request: begin.request,
                };
                let completion = if begin.kind == Kind::Query {
                    match wire::validate_request(&input) {
                        Err(error) => Completion {
                            reason: Reason::InvalidRequest,
                            execution: Execution::NotStarted,
                            requires_reopen: false,
                            detail: error.to_string(),
                        },
                        Ok(()) => {
                            let mut output = output;
                            let mut frames = OutputFrames::default();
                            match block_on(request.stream(input, move |bytes| {
                                if frames.has_copy_input(bytes)? {
                                    // Native callback recovery sends CopyFail and recovery Sync.
                                    // Cancelling here races with it and can leave input queued.
                                    return Err(failure(Reason::InvalidRequest, Execution::Completed, false,
                                        "interactive COPY input is not supported by broker operations"));
                                }
                                output
                                    .write_all(bytes)
                                    .map_err(|e| Error::Engine(e.to_string()))
                            })) {
                                Ok(()) => Completion::success(),
                                Err(crate::RawStreamError::Callback(error)) => error.broker_failure().cloned()
                                    .unwrap_or_else(|| request_failure(&request, error.to_string())),
                                Err(error) => request_failure(&request, error.to_string()),
                            }
                        }
                    }
                } else {
                    match block_on(request.backup_to(output)) {
                        Ok(()) => Completion::success(),
                        Err(error) => request_failure(&request, error.to_string()),
                    }
                };
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.completed = begin.request;
                    state.active = None;
                }
                wire::write_frame(
                    &mut socket,
                    Kind::Terminal,
                    self.epoch,
                    begin.request,
                    &completion.encode(),
                )?;
                self.watchdog.get().unwrap().clear(begin.request);
                if completion.requires_reopen {
                    break;
                }
            }
            Ok(())
        })();
        let requested_close = self.state.lock().unwrap_or_else(|e| e.into_inner()).closing;
        self.close(self.epoch);
        let closed = block_on(database.close());
        let completion = match &closed {
            Ok(()) => Completion::success(),
            Err(error) => Completion {
                reason: Reason::Database,
                execution: Execution::Unknown,
                requires_reopen: true,
                detail: error.to_string(),
            },
        };
        let _ = wire::write_frame(
            &mut socket,
            Kind::Terminal,
            self.epoch,
            0,
            &completion.encode(),
        );
        self.retire();
        closed?;
        if requested_close {
            Ok(())
        } else {
            result.map_err(|e| Error::Engine(e.to_string()))
        }
    }
}

fn request_failure(request: &Request, detail: String) -> Completion {
    let submitted = request.was_submitted();
    Completion {
        reason: if request.was_cancelled() && !submitted {
            Reason::Cancelled
        } else {
            Reason::Database
        },
        execution: if submitted {
            Execution::Unknown
        } else {
            Execution::NotStarted
        },
        requires_reopen: submitted,
        detail,
    }
}

// Archive size is not a SQL input limit. Only one bounded frame is resident.
struct BulkReader<'a> {
    socket: &'a mut UnixStream,
    epoch: Epoch,
    request: u64,
    remaining: u64,
    chunk: io::Cursor<Vec<u8>>,
    ended: bool,
}
impl Read for BulkReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let count = self.chunk.read(output)?;
            if count != 0 {
                return Ok(count);
            }
            if self.ended {
                return Ok(0);
            }
            let frame = wire::read_frame(self.socket)?;
            if frame.epoch != self.epoch || frame.request != self.request {
                return Err(wire::invalid("stale archive input"));
            }
            match frame.kind {
                Kind::Data if frame.payload.len() as u64 <= self.remaining => {
                    self.remaining -= frame.payload.len() as u64;
                    self.chunk = io::Cursor::new(frame.payload);
                }
                Kind::End if self.remaining == 0 => self.ended = true,
                _ => return Err(wire::invalid("incomplete or oversized archive input")),
            }
        }
    }
}

struct BulkWriter {
    socket: UnixStream,
    epoch: Epoch,
    request: u64,
}
impl Write for BulkWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for chunk in bytes.chunks(wire::CHUNK_BYTES) {
            wire::write_frame(
                &mut self.socket,
                Kind::Data,
                self.epoch,
                self.request,
                chunk,
            )?;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Inspect only PostgreSQL frame headers; large rows are never buffered here.
#[derive(Default)]
struct OutputFrames {
    header: [u8; 5],
    header_bytes: usize,
    remaining: usize,
}
impl OutputFrames {
    fn has_copy_input(&mut self, mut bytes: &[u8]) -> Result<bool> {
        while !bytes.is_empty() {
            if self.remaining != 0 {
                let count = self.remaining.min(bytes.len());
                self.remaining -= count;
                bytes = &bytes[count..];
                continue;
            }
            let count = (5 - self.header_bytes).min(bytes.len());
            self.header[self.header_bytes..self.header_bytes + count]
                .copy_from_slice(&bytes[..count]);
            self.header_bytes += count;
            bytes = &bytes[count..];
            if self.header_bytes == 5 {
                let length = u32::from_be_bytes(self.header[1..].try_into().unwrap());
                if length < 4 {
                    return Err(Error::Engine("invalid PostgreSQL response frame".into()));
                }
                self.header_bytes = 0;
                self.remaining = length as usize - 4;
                if self.header[0] == b'G' || self.header[0] == b'W' {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

struct WorkerSession(NativeSession);
impl EngineSession for WorkerSession {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        Some(Arc::new(self.0.cancel_handle()))
    }
    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        EngineSession::exec_protocol_raw(&mut self.0, request)
    }
    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        sink: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        EngineSession::exec_protocol_raw_stream(&mut self.0, request, sink)
    }
    fn backup(&mut self) -> Result<Vec<u8>> {
        self.0.backup().map_err(Into::into)
    }
    fn backup_to(&mut self, writer: &mut dyn Write) -> Result<()> {
        self.0.backup_to(writer).map_err(Into::into)
    }
    fn close(&mut self) -> Result<()> {
        self.0.close_terminal().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Retire(AtomicUsize);
    impl Retirement for Retire {
        fn retire(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    struct Engine(Arc<AtomicUsize>);
    impl EngineSession for Engine {
        fn exec_protocol_raw(&mut self, _: ProtocolRequest) -> Result<ProtocolResponse> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ProtocolResponse::new(b"Z\0\0\0\x05I"))
        }
    }

    fn send(socket: &mut UnixStream, epoch: Epoch, id: u64, bytes: &[u8]) {
        let mut begin = [0; 16];
        begin[..8].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
        wire::write_frame(socket, Kind::Query, epoch, id, &begin).unwrap();
        wire::write_frame(socket, Kind::Data, epoch, id, bytes).unwrap();
        wire::write_frame(socket, Kind::End, epoch, id, &[]).unwrap();
    }

    #[test]
    fn watchdog_and_transport_retire_worker_process() {
        const MODE: &str = "OLIPHAUNT_WORKER_RETIREMENT_TEST";
        const RETIRED: i32 = 23;
        struct Exit;
        impl Retirement for Exit {
            fn retire(&self) {
                std::process::exit(RETIRED);
            }
        }
        struct HungEngine(std::sync::mpsc::Sender<()>);
        impl EngineSession for HungEngine {
            fn exec_protocol_raw(&mut self, _: ProtocolRequest) -> Result<ProtocolResponse> {
                // No cancellation handle: simulate native execution that never settles.
                self.0.send(()).unwrap();
                loop {
                    std::thread::park();
                }
            }
        }
        if let Ok(mode) = std::env::var(MODE) {
            let (mut host, socket) = UnixStream::pair().unwrap();
            let worker = Worker::new(
                socket,
                Arc::new(Exit),
                if mode == "startup" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(10)
                },
            )
            .unwrap();
            if mode != "startup" {
                let (entered, running) = std::sync::mpsc::channel();
                worker
                    .database
                    .set(AsyncOliphaunt::from_executor(EngineExecutor::spawn(
                        Box::new(HungEngine(entered)),
                    )))
                    .ok()
                    .unwrap();
                worker.state.lock().unwrap().ready = true;
                worker.watchdog.get().unwrap().clear(0);
                let server = worker.clone();
                std::thread::spawn(move || block_on(server.serve()));
                if mode == "transport" {
                    drop(host); // No external kill: the live worker must retire itself.
                } else {
                    let query = b"Q\0\0\0\rSELECT 1\0";
                    let mut begin = [0; 16];
                    begin[..8].copy_from_slice(&(query.len() as u64).to_be_bytes());
                    wire::write_frame(&mut host, Kind::Query, worker.epoch, 1, &begin).unwrap();
                    wire::write_frame(&mut host, Kind::Data, worker.epoch, 1, query).unwrap();
                    wire::write_frame(&mut host, Kind::End, worker.epoch, 1, &[]).unwrap();
                    running.recv_timeout(Duration::from_secs(5)).unwrap();
                    worker.cancel(worker.epoch, 1);
                    // Keep the host endpoint alive while unresponsive execution
                    // exhausts the cancellation grace and triggers retirement.
                    let _ = wire::read_frame(&mut host);
                }
            }
            std::thread::sleep(Duration::from_secs(10));
            panic!("worker did not retire for {mode}");
        }
        // Each process owns exactly one worker; a stuck engine cannot stall the test runner.
        for mode in ["startup", "hung-query", "transport"] {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "mobile::broker::worker::tests::watchdog_and_transport_retire_worker_process",
                    "--nocapture",
                ])
                .env(MODE, mode)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if child.try_wait().unwrap().is_none() {
                child.kill().unwrap();
            }
            let output = child.wait_with_output().unwrap();
            assert_eq!(
                output.status.code(),
                Some(RETIRED),
                "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn early_cancel_rejection_next_request_and_close_share_one_owner() {
        let (mut host, socket) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let retirement = Arc::new(Retire(AtomicUsize::new(0)));
        let worker = Worker::new(socket, retirement.clone(), Duration::from_secs(10)).unwrap();
        let executions = Arc::new(AtomicUsize::new(0));
        worker
            .database
            .set(AsyncOliphaunt::from_executor(EngineExecutor::spawn(
                Box::new(Engine(executions.clone())),
            )))
            .ok()
            .unwrap();
        worker.state.lock().unwrap().ready = true;
        worker.watchdog.get().unwrap().clear(0);
        let server = worker.clone();
        let thread = std::thread::spawn(move || block_on(server.serve()));
        let query = b"Q\0\0\0\rSELECT 1\0";

        worker.cancel(worker.epoch, 1); // Native control overtakes bulk registration.
        send(&mut host, worker.epoch, 1, query);
        let terminal = wire::read_frame(&mut host).unwrap();
        let outcome = Completion::decode(&terminal.payload).unwrap();
        assert_eq!(outcome.execution, Execution::NotStarted);
        assert!(!outcome.requires_reopen);
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        send(
            &mut host,
            worker.epoch,
            2,
            &[query.as_slice(), query.as_slice()].concat(),
        );
        let outcome = Completion::decode(&wire::read_frame(&mut host).unwrap().payload).unwrap();
        assert_eq!(outcome.reason, Reason::InvalidRequest);
        assert!(!outcome.requires_reopen);
        worker.cancel(worker.epoch, 1); // A completed ID has no authority over 3.
        send(&mut host, worker.epoch, 3, query);
        assert_eq!(wire::read_frame(&mut host).unwrap().kind, Kind::Data);
        assert_eq!(
            Completion::decode(&wire::read_frame(&mut host).unwrap().payload).unwrap(),
            Completion::success()
        );
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        worker.close(worker.epoch);
        let closed = wire::read_frame(&mut host).unwrap();
        assert_eq!(closed.request, 0);
        assert_eq!(
            Completion::decode(&closed.payload).unwrap(),
            Completion::success()
        );
        thread.join().unwrap().unwrap();
        assert_eq!(retirement.0.load(Ordering::SeqCst), 1);
    }
}
