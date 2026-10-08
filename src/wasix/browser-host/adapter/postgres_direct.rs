use std::{
    cell::RefCell,
    collections::VecDeque,
    io::{self, SeekFrom},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context as TaskContext, Poll},
};

use anyhow::{Context, ensure};
use js_sys::{Function, Uint8Array, WebAssembly};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::VirtualFile;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};
use wasmer::{Instance as WasmerInstance, Store, TypedFunction, Value, WasmTypeList};
use wasmer_wasix::{
    Runtime as _, WasiEnvBuilder, WasiError, WasiFunctionEnv, oliphaunt_direct_memory,
};

use super::{RunOptions, caller_realm::CallerRealmTaskManager, runtime::Runtime, utils::Error};

const DEFAULT_PROGRAM_NAME: &str = "/bin/postgres";
const OLIPHAUNT_EXIT_STARTUP_REJECTED: i32 = 98;
const OLIPHAUNT_EXIT_ALIVE: i32 = 99;
const STDERR_LIMIT_BYTES: usize = 16 * 1024;
use super::protocol_contract::PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT;
use super::protocol_contract::{
    PROTOCOL_BUFFERED, PROTOCOL_CALLBACK_CHUNK_BYTES as PROTOCOL_CHUNK_BYTES, PROTOCOL_HYBRID,
};
const PROCESS_STARTUP_OK: i32 = 0;
const PROCESS_STARTUP_ERROR: i32 = -1;
const STARTUP_OUTCOME_VERSION: u32 = 1;
const STARTUP_OUTCOME_DESCRIPTOR_BYTES: u32 = 32;
const STARTUP_OUTCOME_PENDING: u32 = 0;
const STARTUP_OUTCOME_REJECTED: u32 = 1;

thread_local! {
    static PROTOCOL_CALLBACK: RefCell<Option<Function>> = const { RefCell::new(None) };
    static PROTOCOL_INPUT_CALLBACK: RefCell<Option<Function>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug, Default)]
struct ProtocolStdin;

impl ProtocolStdin {
    fn begin(&self, callback: Function) -> anyhow::Result<()> {
        PROTOCOL_INPUT_CALLBACK.with(|active| {
            let mut active = active.borrow_mut();
            ensure!(
                active.is_none(),
                "protocol input callback is already active"
            );
            *active = Some(callback);
            Ok(())
        })
    }

    fn finish(&self) {
        PROTOCOL_INPUT_CALLBACK.with(|active| *active.borrow_mut() = None);
    }
}

impl AsyncRead for ProtocolStdin {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let callback = match PROTOCOL_INPUT_CALLBACK.with(|active| active.borrow().clone()) {
            Some(callback) => callback,
            None => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "protocol input callback is inactive",
                )));
            }
        };
        let requested = buffer.remaining().min(PROTOCOL_CHUNK_BYTES);
        if requested == 0 {
            return Poll::Ready(Ok(()));
        }
        let value = match callback.call1(&JsValue::UNDEFINED, &JsValue::from(requested as u32)) {
            Ok(value) => value,
            Err(error) => {
                return Poll::Ready(Err(io::Error::other(format!(
                    "protocol input callback failed: {error:?}"
                ))));
            }
        };
        let input = match value.dyn_into::<Uint8Array>() {
            Ok(input) => input,
            Err(_) => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "protocol input callback must return a Uint8Array",
                )));
            }
        };
        let length = input.length() as usize;
        if length > requested {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "protocol input callback exceeded the requested byte count",
            )));
        }
        if length > 0 {
            input.copy_to(buffer.initialize_unfilled_to(length));
            buffer.advance(length);
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for ProtocolStdin {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _input: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "protocol stdin is read-only",
        )))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for ProtocolStdin {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for ProtocolStdin {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }
    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn get_special_fd(&self) -> Option<u32> {
        Some(0)
    }
    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(PROTOCOL_CHUNK_BYTES))
    }
    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }
}

#[derive(Clone, Debug)]
enum ProtocolStdoutFailure {
    Callback(String),
    LockPoisoned,
}

impl ProtocolStdoutFailure {
    fn message(&self) -> String {
        match self {
            Self::Callback(failure) => format!("protocol stream callback failed: {failure}"),
            Self::LockPoisoned => "protocol stream state lock was poisoned".to_string(),
        }
    }

    fn into_anyhow(self) -> anyhow::Error {
        anyhow::anyhow!(self.message())
    }

    fn into_io(self) -> io::Error {
        io::Error::other(self.message())
    }
}

#[derive(Debug, Default)]
struct ProtocolStdoutState {
    failure: Option<ProtocolStdoutFailure>,
}

impl ProtocolStdoutState {
    fn poison_lock(&mut self) -> ProtocolStdoutFailure {
        self.failure = Some(ProtocolStdoutFailure::LockPoisoned);
        ProtocolStdoutFailure::LockPoisoned
    }

    fn record_callback_failure(&mut self, failure: String) -> ProtocolStdoutFailure {
        match &self.failure {
            Some(failure) => failure.clone(),
            None => {
                let failure = ProtocolStdoutFailure::Callback(failure);
                self.failure = Some(failure.clone());
                failure
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ProtocolStdout {
    state: Arc<Mutex<ProtocolStdoutState>>,
}

impl ProtocolStdout {
    fn begin(&self, callback: Function) -> anyhow::Result<()> {
        PROTOCOL_CALLBACK.with(|active| {
            ensure!(
                active.borrow().is_none(),
                "protocol stream callback is already active"
            );
            Ok(())
        })?;
        self.with_state(|state| state.failure = None)
            .map_err(ProtocolStdoutFailure::into_anyhow)?;
        PROTOCOL_CALLBACK.with(|active| *active.borrow_mut() = Some(callback));
        Ok(())
    }

    fn finish(&self) -> anyhow::Result<()> {
        PROTOCOL_CALLBACK.with(|active| *active.borrow_mut() = None);
        let failure = match self.with_state(|state| state.failure.clone()) {
            Ok(failure) => failure,
            Err(failure) => Some(failure),
        };
        match failure {
            Some(failure) => Err(failure.into_anyhow()),
            None => Ok(()),
        }
    }

    fn with_state<T>(
        &self,
        operation: impl FnOnce(&mut ProtocolStdoutState) -> T,
    ) -> Result<T, ProtocolStdoutFailure> {
        match self.state.lock() {
            Ok(mut state) => Ok(operation(&mut state)),
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                Err(state.poison_lock())
            }
        }
    }

    fn deliver(&self, input: &[u8]) -> io::Result<()> {
        let failure = match self.with_state(|state| state.failure.clone()) {
            Ok(failure) => failure,
            Err(failure) => Some(failure),
        };
        if let Some(failure) = failure {
            return Err(failure.into_io());
        }
        let callback = PROTOCOL_CALLBACK
            .with(|active| active.borrow().clone())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "protocol callback is inactive")
            })?;
        for input in input.chunks(PROTOCOL_CHUNK_BYTES) {
            let chunk = Uint8Array::from(input);
            if let Err(error) = callback.call1(&JsValue::UNDEFINED, &chunk) {
                let failure = match self
                    .with_state(|state| state.record_callback_failure(format!("{error:?}")))
                {
                    Ok(failure) | Err(failure) => failure,
                };
                return Err(failure.into_io());
            }
        }
        Ok(())
    }
}

impl AsyncWrite for ProtocolStdout {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.deliver(input) {
            Ok(()) => Poll::Ready(Ok(input.len())),
            Err(error) => Poll::Ready(Err(error)),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for ProtocolStdout {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for ProtocolStdout {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for ProtocolStdout {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }
    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn get_special_fd(&self) -> Option<u32> {
        Some(1)
    }
    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }
    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(PROTOCOL_CHUNK_BYTES))
    }
}

#[derive(Clone, Debug, Default)]
struct BoundedStderr {
    bytes: Arc<Mutex<VecDeque<u8>>>,
}

impl BoundedStderr {
    fn append(&self, input: &[u8]) {
        let mut bytes = self.bytes.lock().expect("bounded stderr lock poisoned");
        if input.len() >= STDERR_LIMIT_BYTES {
            bytes.clear();
            bytes.extend(&input[input.len() - STDERR_LIMIT_BYTES..]);
            return;
        }
        let overflow = bytes
            .len()
            .saturating_add(input.len())
            .saturating_sub(STDERR_LIMIT_BYTES);
        bytes.drain(..overflow);
        bytes.extend(input);
    }

    fn attach(&self, error: anyhow::Error) -> anyhow::Error {
        let mut bytes = self.bytes.lock().expect("bounded stderr lock poisoned");
        if bytes.is_empty() {
            return error;
        }
        let stderr = String::from_utf8_lossy(bytes.make_contiguous());
        error.context(format!("WASIX stderr (last 16 KiB):\n{stderr}"))
    }
}

impl AsyncWrite for BoundedStderr {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.append(input);
        Poll::Ready(Ok(input.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for BoundedStderr {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for BoundedStderr {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for BoundedStderr {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.bytes
            .lock()
            .expect("bounded stderr lock poisoned")
            .len() as u64
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        let target = usize::try_from(new_size)
            .unwrap_or(usize::MAX)
            .min(STDERR_LIMIT_BYTES);
        let mut bytes = self.bytes.lock().expect("bounded stderr lock poisoned");
        while bytes.len() > target {
            bytes.pop_front();
        }
        bytes.resize(target, 0);
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        self.bytes
            .lock()
            .expect("bounded stderr lock poisoned")
            .clear();
        Ok(())
    }

    fn get_special_fd(&self) -> Option<u32> {
        Some(2)
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainLoopOutcome {
    Processed,
    Recovered,
    InputEnded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectInstanceState {
    Open,
    StartupPhase,
    GuestPhase,
    StartupRejected,
    Closing,
    Poisoned,
    Closed,
}

enum BackendStartOutcome {
    Alive,
    Rejected(Vec<u8>),
}

enum DirectStartupOutcome {
    Processed { output: Uint8Array, status: i32 },
    Rejected(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartupOutcomeDescriptor {
    kind: u32,
    data_pointer: u64,
    data_length: u64,
}

impl MainLoopOutcome {
    fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Processed),
            1 => Some(Self::Recovered),
            2 => Some(Self::InputEnded),
            _ => None,
        }
    }
}

#[wasm_bindgen(inline_js = r#"
export function oliphauntCopyToGuest(memory, pointer, input) {
    new Uint8Array(memory.buffer, pointer, input.byteLength).set(input);
}

export function oliphauntCopyFromGuest(memory, pointer, length) {
    // slice() deliberately returns owned protocol bytes. A view would become
    // invalid or mutable as soon as PostgreSQL reuses or grows guest memory.
    return new Uint8Array(memory.buffer, pointer, length).slice();
}

"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = oliphauntCopyToGuest)]
    fn oliphaunt_copy_to_guest(
        memory: &JsValue,
        pointer: u32,
        input: &Uint8Array,
    ) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = oliphauntCopyFromGuest)]
    fn oliphaunt_copy_from_guest(
        memory: &JsValue,
        pointer: u32,
        length: u32,
    ) -> Result<Uint8Array, JsValue>;
}
/// Instantiate the integrated Oliphaunt/PostgreSQL guest in this JS realm.
///
/// The returned driver is synchronous by design: every guest export runs on
/// the caller's stack, and this code never constructs a Worker or ThreadPool.
#[wasm_bindgen(js_name = instantiateOliphauntDirect)]
pub async fn instantiate_oliphaunt_direct(
    module: WebAssembly::Module,
    module_bytes: Uint8Array,
    options: RunOptions,
) -> Result<OliphauntDirectInstance, Error> {
    let stderr = BoundedStderr::default();
    let protocol_stdin = ProtocolStdin;
    let protocol_stdout = ProtocolStdout::default();
    OliphauntDirectInstance::instantiate(
        module,
        module_bytes,
        options,
        protocol_stdin,
        protocol_stdout,
        stderr.clone(),
    )
    .await
    .map_err(|error| Error::from(stderr.attach(error.into_anyhow())))
}

#[wasm_bindgen]
pub struct OliphauntDirectInstance {
    // Runtime and instance must outlive every function handle and the Store.
    _runtime: Arc<Runtime>,
    store: Store,
    _instance: WasmerInstance,
    _env: WasiFunctionEnv,
    protocol_stdin: ProtocolStdin,
    protocol_stdout: ProtocolStdout,
    stderr: BoundedStderr,
    guest_memory: JsValue,
    input_reset: TypedFunction<(), i32>,
    input_reserve: TypedFunction<i32, i32>,
    input_commit: TypedFunction<i32, i32>,
    input_available: TypedFunction<(), i32>,
    output_reset: TypedFunction<(), i32>,
    output_len: TypedFunction<(), i32>,
    output_data: TypedFunction<(), i32>,
    set_protocol_transport: TypedFunction<i32, i32>,
    set_active: TypedFunction<i32, i32>,
    prepare_trusted_embedded_session: TypedFunction<(), i32>,
    startup_outcome: TypedFunction<(), i32>,
    wasi_start: TypedFunction<(), ()>,
    start_oliphaunt: TypedFunction<(), ()>,
    run_atexit_funcs: Option<TypedFunction<(), ()>>,
    get_port: TypedFunction<(), i32>,
    process_startup: TypedFunction<(i32, i32, i32), i32>,
    send_conn_data: TypedFunction<(), ()>,
    pq_flush: TypedFunction<(), i32>,
    pq_buffer_remaining_data: TypedFunction<(), i32>,
    main_loop: TypedFunction<(), i32>,
    send_ready: TypedFunction<(), ()>,
    backend_started: bool,
    protocol_started: bool,
    state: DirectInstanceState,
}

#[wasm_bindgen]
impl OliphauntDirectInstance {
    /// Start PostgreSQL and process one frontend startup packet.
    #[wasm_bindgen(js_name = startup)]
    pub fn startup(&mut self, packet: Uint8Array) -> Result<Uint8Array, Error> {
        match self.startup_inner(&packet) {
            Ok(DirectStartupOutcome::Processed { output, .. }) => Ok(output),
            Ok(DirectStartupOutcome::Rejected(protocol)) => Err(self.startup_rejection_error(
                anyhow::anyhow!("_start rejected Oliphaunt single-user backend"),
                protocol,
            )),
            Err(error) if self.state == DirectInstanceState::StartupPhase => {
                self.poison_guest_phase();
                Err(Error::from(self.stderr.attach(error)))
            }
            Err(error) => Err(Error::from(self.stderr.attach(error))),
        }
    }

    /// Execute raw PostgreSQL frontend-protocol bytes synchronously.
    #[wasm_bindgen(js_name = execProtocolRaw)]
    pub fn exec_protocol_raw(&mut self, input: Uint8Array) -> Result<Uint8Array, Error> {
        if let Err(error) = self.ensure_protocol_started() {
            return Err(Error::from(self.stderr.attach(error)));
        }
        let result = self.run_guest_phase("buffered protocol exchange", |direct| {
            let previous = direct
                .set_protocol_transport
                .call(&mut direct.store, PROTOCOL_BUFFERED)
                .context("enable buffered protocol transport")?;
            ensure!(
                previous == PROTOCOL_BUFFERED,
                "enable buffered protocol transport returned previous mode {previous}, expected {PROTOCOL_BUFFERED}"
            );
            direct.exec_protocol_raw_inner(&input, false)
        });
        match result {
            Ok(output) => Ok(output),
            Err(error) => Err(Error::from(self.stderr.attach(error))),
        }
    }

    /// Execute raw PostgreSQL protocol bytes and synchronously deliver owned chunks.
    #[wasm_bindgen(js_name = execProtocolStream)]
    pub fn exec_protocol_stream(
        &mut self,
        input: Uint8Array,
        on_chunk: Function,
    ) -> Result<u32, Error> {
        if let Err(error) = self.ensure_protocol_started() {
            return Err(Error::from(self.stderr.attach(error)));
        }
        let result = self.run_guest_phase("streaming protocol exchange", |direct| {
            direct.exec_protocol_stream_inner(&input, on_chunk)
        });
        match result {
            Ok(()) => Ok(0),
            Err(error) => Err(Error::from(self.stderr.attach(error))),
        }
    }

    /// Execute a protocol exchange with synchronous full-duplex callbacks.
    #[wasm_bindgen(js_name = execProtocolDuplex)]
    pub fn exec_protocol_duplex(
        &mut self,
        input: Uint8Array,
        on_read: Function,
        on_chunk: Function,
    ) -> Result<(), Error> {
        if let Err(error) = self.ensure_protocol_started() {
            return Err(Error::from(self.stderr.attach(error)));
        }
        let result = self.run_guest_phase("duplex protocol exchange", |direct| {
            direct.exec_protocol_duplex_inner(&input, on_read, on_chunk)
        });
        match result {
            Ok(()) => Ok(()),
            Err(error) => Err(Error::from(self.stderr.attach(error))),
        }
    }

    /// Shut down the embedded lifecycle. This does not consume the JS object.
    pub fn close(&mut self) -> Result<(), Error> {
        match self.close_inner() {
            Ok(()) => Ok(()),
            Err(error) => Err(Error::from(self.stderr.attach(error))),
        }
    }
}

impl OliphauntDirectInstance {
    fn exec_protocol_duplex_inner(
        &mut self,
        payload: &Uint8Array,
        on_read: Function,
        on_chunk: Function,
    ) -> anyhow::Result<()> {
        self.protocol_stdin.begin(on_read)?;
        let result =
            self.exec_protocol_callback_inner(payload, on_chunk.clone(), PROTOCOL_HYBRID, true);
        self.protocol_stdin.finish();
        let output = result?;
        let length = output.length() as usize;
        for start in (0..length).step_by(PROTOCOL_CHUNK_BYTES) {
            let end = start.saturating_add(PROTOCOL_CHUNK_BYTES).min(length);
            let chunk = output.slice(start as u32, end as u32);
            on_chunk
                .call1(&JsValue::UNDEFINED, &chunk)
                .map_err(|error| anyhow::anyhow!("protocol stream callback failed: {error:?}"))?;
        }
        Ok(())
    }

    fn exec_protocol_stream_inner(
        &mut self,
        payload: &Uint8Array,
        on_chunk: Function,
    ) -> anyhow::Result<()> {
        let output = self.exec_protocol_callback_inner(
            payload,
            on_chunk,
            PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT,
            false,
        )?;
        ensure!(
            output.length() == 0,
            "buffered-input/streamed-output transport left {} buffered protocol bytes",
            output.length()
        );
        Ok(())
    }

    fn exec_protocol_callback_inner(
        &mut self,
        payload: &Uint8Array,
        on_chunk: Function,
        transport: i32,
        streaming_input: bool,
    ) -> anyhow::Result<Uint8Array> {
        self.protocol_stdout.begin(on_chunk.clone())?;
        let previous = match self
            .set_protocol_transport
            .call(&mut self.store, transport)
            .with_context(|| format!("enable protocol transport mode {transport}"))
        {
            Ok(previous) if previous == PROTOCOL_BUFFERED => previous,
            Ok(previous) => {
                let _ = self.protocol_stdout.finish();
                anyhow::bail!(
                    "enable protocol transport mode {transport} returned previous mode {previous}, expected {PROTOCOL_BUFFERED}"
                );
            }
            Err(error) => {
                let _ = self.protocol_stdout.finish();
                return Err(error);
            }
        };
        let execution = self.exec_protocol_raw_inner(payload, streaming_input);
        let restore = if execution.is_err() {
            // Once any guest-facing step fails, guest state is unknown. The
            // outer phase boundary will poison the instance; do not re-enter
            // the guest merely to restore the transport selector.
            Ok(())
        } else {
            self.set_protocol_transport
                .call(&mut self.store, previous)
                .with_context(|| format!("restore protocol transport from mode {transport}"))
                .and_then(|replaced| {
                    ensure!(
                        replaced == transport,
                        "restore protocol transport replaced mode {replaced}, expected {transport}"
                    );
                    Ok(())
                })
        };
        let callback = self.protocol_stdout.finish();

        callback?;
        let output = execution?;
        restore?;
        Ok(output)
    }

    fn startup_inner(&mut self, packet: &Uint8Array) -> anyhow::Result<DirectStartupOutcome> {
        match self.state {
            DirectInstanceState::Open => {}
            DirectInstanceState::StartupRejected => {
                anyhow::bail!(
                    "Oliphaunt direct startup was already rejected; the direct instance cannot be reused"
                )
            }
            _ => self.ensure_open()?,
        }
        ensure!(
            !self.protocol_started,
            "Oliphaunt direct startup already completed"
        );
        self.state = DirectInstanceState::StartupPhase;
        let outcome = self.startup_guest_inner(packet)?;
        match outcome {
            DirectStartupOutcome::Processed { status, .. } => {
                self.state = if status == PROCESS_STARTUP_ERROR {
                    DirectInstanceState::StartupRejected
                } else {
                    DirectInstanceState::Open
                };
            }
            DirectStartupOutcome::Rejected(_) => self.poison_guest_phase(),
        }
        Ok(outcome)
    }

    fn startup_guest_inner(&mut self, packet: &Uint8Array) -> anyhow::Result<DirectStartupOutcome> {
        match self.start_backend()? {
            BackendStartOutcome::Alive => {}
            BackendStartOutcome::Rejected(protocol) => {
                return Ok(DirectStartupOutcome::Rejected(protocol));
            }
        }
        self.reset_io()?;
        self.push_input_js(packet)?;

        let port = self
            .get_port
            .call(&mut self.store)
            .context("oliphaunt_wasix_get_proc_port")?;
        ensure!(port > 0, "oliphaunt_wasix_get_proc_port returned null");
        let status = self
            .process_startup
            .call(&mut self.store, port, 1, 1)
            .context("ProcessStartupPacket")?;
        ensure!(
            status == PROCESS_STARTUP_OK || status == PROCESS_STARTUP_ERROR,
            "ProcessStartupPacket returned invalid status {status}"
        );
        if status == PROCESS_STARTUP_OK {
            self.send_conn_data
                .call(&mut self.store)
                .context("oliphaunt_wasix_send_conn_data")?;
            self.protocol_started = true;
        }
        let flush_status = self
            .pq_flush
            .call(&mut self.store)
            .context("oliphaunt_wasix_pq_flush after startup")?;
        ensure!(
            flush_status == 0,
            "oliphaunt_wasix_pq_flush after startup returned {flush_status}"
        );
        Ok(DirectStartupOutcome::Processed {
            output: self.take_output_js()?,
            status,
        })
    }

    fn exec_protocol_raw_inner(
        &mut self,
        payload: &Uint8Array,
        streaming: bool,
    ) -> anyhow::Result<Uint8Array> {
        ensure!(
            self.state == DirectInstanceState::GuestPhase,
            "direct protocol exchange did not enter its guest phase"
        );
        ensure!(
            self.protocol_started,
            "Oliphaunt direct startup has not completed"
        );
        if payload.length() == 0 {
            return Ok(Uint8Array::new_with_length(0));
        }

        self.reset_io()?;
        self.push_input_js(payload)?;
        let payload_len = payload.length() as usize;
        let max_attempts = (payload_len / 5).saturating_add(2).max(1);
        let mut attempts = 0usize;
        let mut input_ended = false;
        while self.protocol_input_remaining()? > 0 {
            attempts += 1;
            ensure!(
                attempts <= max_attempts,
                "PostgreSQL direct protocol pump did not drain input"
            );
            match self.call_main_loop()? {
                MainLoopOutcome::Processed | MainLoopOutcome::Recovered => {}
                MainLoopOutcome::InputEnded if streaming => {
                    input_ended = true;
                    break;
                }
                MainLoopOutcome::InputEnded => {
                    return Err(self.terminal_main_loop_outcome(
                        "PostgresMainLoopOnce reported input end while dispatching buffered protocol input",
                    ));
                }
            }
        }
        if !input_ended {
            self.send_ready_after_main_loop()?;
            self.flush_after_main_loop()?;
        }
        self.take_output_js()
    }

    fn close_inner(&mut self) -> anyhow::Result<()> {
        match self.state {
            DirectInstanceState::Poisoned | DirectInstanceState::Closed => return Ok(()),
            DirectInstanceState::StartupPhase
            | DirectInstanceState::GuestPhase
            | DirectInstanceState::Closing => {
                self.poison_guest_phase();
                anyhow::bail!(
                    "Oliphaunt direct instance cannot close during an active guest phase; the direct instance is closed"
                );
            }
            DirectInstanceState::Open | DirectInstanceState::StartupRejected => {}
        }
        self.state = DirectInstanceState::Closing;
        let result = (|| {
            let expected_active = i32::from(self.backend_started);
            let previous_active = self
                .set_active
                .call(&mut self.store, 0)
                .context("oliphaunt_wasix_set_active(0)")?;
            ensure!(
                previous_active == expected_active,
                "oliphaunt_wasix_set_active(0) returned previous state {previous_active}, expected {expected_active}"
            );
            if let Some(run_atexit_funcs) = &self.run_atexit_funcs {
                run_atexit_funcs
                    .call(&mut self.store)
                    .context("oliphaunt_wasix_run_atexit_funcs")?;
            }
            Ok(())
        })();
        self.backend_started = false;
        self.protocol_started = false;
        match result {
            Ok(()) => {
                self.state = DirectInstanceState::Closed;
                Ok(())
            }
            Err(error) => {
                self.state = DirectInstanceState::Poisoned;
                Err(error.context("direct instance cleanup failed; the direct instance is closed"))
            }
        }
    }
    async fn instantiate(
        module: WebAssembly::Module,
        module_bytes: Uint8Array,
        options: RunOptions,
        protocol_stdin: ProtocolStdin,
        protocol_stdout: ProtocolStdout,
        stderr: BoundedStderr,
    ) -> Result<Self, Error> {
        // Direct execution intentionally has no configurable networking or
        // worker-backed runtime. RunOptions is reused for args/env/fs mounts.
        let mut runtime = super::runtime::runtime(Arc::new(CallerRealmTaskManager))?;
        runtime.with_instantiation_hook(super::clock::DirectClockHook);
        let runtime = Arc::new(runtime);
        let program_name = options
            .program()
            .as_string()
            .unwrap_or_else(|| DEFAULT_PROGRAM_NAME.to_owned());
        let mut builder = WasiEnvBuilder::new(program_name).runtime(runtime.clone());
        options.configure_direct_builder(
            &mut builder,
            Box::new(protocol_stdin.clone()),
            Box::new(protocol_stdout.clone()),
            Box::new(stderr.clone()),
        )?;

        let module = wasmer::Module::from((module, module_bytes.to_vec()));
        let mut store = Store::new(runtime.engine());
        let (instance, env) = builder
            .instantiate_async(module, &mut store)
            .await
            .context("instantiate Oliphaunt direct WASIX module")?;
        let guest_memory = oliphaunt_direct_memory(&env, &store)
            .context("get WASIX guest memory for direct PGWire")?;
        seed_exported_c_string(
            &mut store,
            &instance,
            &env,
            "my_exec_path",
            DEFAULT_PROGRAM_NAME,
        )?;

        let input_reset = typed_export(&mut store, &instance, "oliphaunt_wasix_input_reset")?;
        let input_reserve = typed_export(&mut store, &instance, "oliphaunt_wasix_input_reserve")?;
        let input_commit = typed_export(&mut store, &instance, "oliphaunt_wasix_input_commit")?;
        let input_available =
            typed_export(&mut store, &instance, "oliphaunt_wasix_input_available")?;
        let output_reset = typed_export(&mut store, &instance, "oliphaunt_wasix_output_reset")?;
        let output_len = typed_export(&mut store, &instance, "oliphaunt_wasix_output_len")?;
        let output_data = typed_export(&mut store, &instance, "oliphaunt_wasix_output_data")?;
        let set_protocol_transport = typed_export(
            &mut store,
            &instance,
            "oliphaunt_wasix_set_protocol_transport",
        )?;
        let set_active = typed_export(&mut store, &instance, "oliphaunt_wasix_set_active")?;
        let prepare_trusted_embedded_session = typed_export(
            &mut store,
            &instance,
            "oliphaunt_wasix_prepare_trusted_embedded_session",
        )?;
        let startup_outcome =
            typed_export(&mut store, &instance, "oliphaunt_wasix_startup_outcome_v1")?;
        let wasi_start = typed_export(&mut store, &instance, "_start")?;
        let start_oliphaunt = typed_export(&mut store, &instance, "oliphaunt_wasix_start")?;
        let run_atexit_funcs =
            optional_typed_export(&mut store, &instance, "oliphaunt_wasix_run_atexit_funcs")?;
        let get_port = typed_export(&mut store, &instance, "oliphaunt_wasix_get_proc_port")?;
        let process_startup = typed_export(&mut store, &instance, "ProcessStartupPacket")?;
        let send_conn_data = typed_export(&mut store, &instance, "oliphaunt_wasix_send_conn_data")?;
        let pq_flush = typed_export(&mut store, &instance, "oliphaunt_wasix_pq_flush")?;
        let pq_buffer_remaining_data =
            typed_export(&mut store, &instance, "pq_buffer_remaining_data")?;
        let main_loop = typed_export(&mut store, &instance, "PostgresMainLoopOnce")?;
        let send_ready = typed_export(
            &mut store,
            &instance,
            "PostgresSendReadyForQueryIfNecessary",
        )?;

        let mut direct = Self {
            _runtime: runtime,
            store,
            _instance: instance,
            _env: env,
            protocol_stdin,
            protocol_stdout,
            stderr,
            guest_memory,
            input_reset,
            input_reserve,
            input_commit,
            input_available,
            output_reset,
            output_len,
            output_data,
            set_protocol_transport,
            set_active,
            prepare_trusted_embedded_session,
            startup_outcome,
            wasi_start,
            start_oliphaunt,
            run_atexit_funcs,
            get_port,
            process_startup,
            send_conn_data,
            pq_flush,
            pq_buffer_remaining_data,
            main_loop,
            send_ready,
            backend_started: false,
            protocol_started: false,
            state: DirectInstanceState::Open,
        };
        direct.reset_io()?;
        Ok(direct)
    }

    fn ensure_open(&self) -> anyhow::Result<()> {
        ensure!(
            self.state == DirectInstanceState::Open,
            "Oliphaunt direct instance is closed"
        );
        Ok(())
    }

    fn ensure_protocol_started(&self) -> anyhow::Result<()> {
        match self.state {
            DirectInstanceState::Open => {}
            DirectInstanceState::StartupRejected => {
                anyhow::bail!(
                    "Oliphaunt direct startup was rejected; the direct instance cannot be reused"
                )
            }
            _ => self.ensure_open()?,
        }
        ensure!(
            self.protocol_started,
            "Oliphaunt direct startup has not completed"
        );
        Ok(())
    }

    fn run_guest_phase<T>(
        &mut self,
        phase: &'static str,
        operation: impl FnOnce(&mut Self) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        self.ensure_open()?;
        self.state = DirectInstanceState::GuestPhase;
        match operation(self) {
            Ok(value) if self.state == DirectInstanceState::GuestPhase => {
                self.state = DirectInstanceState::Open;
                Ok(value)
            }
            Ok(_) => anyhow::bail!(
                "{phase} reached a terminal lifecycle state; the direct instance is closed"
            ),
            Err(error) => {
                if self.state == DirectInstanceState::GuestPhase {
                    self.poison_guest_phase();
                }
                Err(error.context(format!(
                    "{phase} failed after entering the guest; the direct instance is closed"
                )))
            }
        }
    }

    fn poison_guest_phase(&mut self) {
        // Any failure after a guest phase starts can leave arbitrary guest
        // state behind. No later operation, including close, may call another
        // guest export.
        self.state = DirectInstanceState::Poisoned;
        self.backend_started = false;
        self.protocol_started = false;
    }

    fn terminal_main_loop_outcome(&self, failure: impl Into<String>) -> anyhow::Error {
        anyhow::anyhow!(failure.into())
    }

    fn terminal_main_loop_error(&self, error: wasmer::RuntimeError) -> anyhow::Error {
        anyhow::Error::from(error)
            .context("PostgresMainLoopOnce trapped instead of returning a typed outcome")
    }

    fn call_main_loop(&mut self) -> anyhow::Result<MainLoopOutcome> {
        let status = match self.main_loop.call(&mut self.store) {
            Ok(status) => status,
            Err(error) => return Err(self.terminal_main_loop_error(error)),
        };
        MainLoopOutcome::from_i32(status).ok_or_else(|| {
            self.terminal_main_loop_outcome(format!(
                "PostgresMainLoopOnce returned invalid typed outcome {status}"
            ))
        })
    }

    fn send_ready_after_main_loop(&mut self) -> anyhow::Result<()> {
        self.send_ready
            .call(&mut self.store)
            .context("PostgresSendReadyForQueryIfNecessary trapped after a typed main-loop outcome")
    }

    fn flush_after_main_loop(&mut self) -> anyhow::Result<()> {
        let status = self
            .pq_flush
            .call(&mut self.store)
            .context("oliphaunt_wasix_pq_flush trapped after a typed main-loop outcome")?;
        ensure!(
            status == 0,
            "protocol output flush returned {status} after a typed main-loop outcome"
        );
        Ok(())
    }

    fn start_backend(&mut self) -> anyhow::Result<BackendStartOutcome> {
        if self.backend_started {
            return Ok(BackendStartOutcome::Alive);
        }
        let previous_active = self
            .set_active
            .call(&mut self.store, 1)
            .context("oliphaunt_wasix_set_active(1)")?;
        ensure!(
            previous_active == 0,
            "oliphaunt_wasix_set_active(1) returned previous state {previous_active}, expected 0"
        );
        let prepare_status = self
            .prepare_trusted_embedded_session
            .call(&mut self.store)
            .context("oliphaunt_wasix_prepare_trusted_embedded_session")?;
        ensure!(
            prepare_status == 0,
            "oliphaunt_wasix_prepare_trusted_embedded_session rejected after PostgreSQL startup began"
        );
        let startup_outcome_pointer = self
            .startup_outcome
            .call(&mut self.store)
            .context("oliphaunt_wasix_startup_outcome_v1 before _start")?;
        let pending = self.read_startup_outcome_descriptor(startup_outcome_pointer)?;
        ensure!(
            pending.kind == STARTUP_OUTCOME_PENDING,
            "startup outcome was not pending before _start"
        );
        ensure!(
            pending.data_pointer == 0 && pending.data_length == 0,
            "pending startup outcome carried protocol data"
        );
        match self.wasi_start.call(&mut self.store) {
            Err(error) if runtime_exit_code(&error) == Some(OLIPHAUNT_EXIT_ALIVE) => {}
            Err(error) if runtime_exit_code(&error) == Some(OLIPHAUNT_EXIT_STARTUP_REJECTED) => {
                let protocol = self
                    .read_startup_rejection(startup_outcome_pointer)
                    .context("read rejected _start outcome")?;
                return Ok(BackendStartOutcome::Rejected(protocol));
            }
            Ok(()) => anyhow::bail!("_start returned without an Oliphaunt lifecycle exit"),
            Err(error) => return Err(error).context("_start Oliphaunt single-user backend"),
        }
        self.start_oliphaunt
            .call(&mut self.store)
            .context("oliphaunt_wasix_start")?;
        self.backend_started = true;
        Ok(BackendStartOutcome::Alive)
    }

    fn read_startup_outcome_descriptor(
        &self,
        descriptor_pointer: i32,
    ) -> anyhow::Result<StartupOutcomeDescriptor> {
        ensure!(
            descriptor_pointer != 0,
            "oliphaunt_wasix_startup_outcome_v1 returned null"
        );
        let bytes = oliphaunt_copy_from_guest(
            &self.guest_memory,
            descriptor_pointer as u32,
            STARTUP_OUTCOME_DESCRIPTOR_BYTES,
        )
        .map_err(|error| anyhow::anyhow!("copy startup outcome descriptor: {error:?}"))?
        .to_vec();
        ensure!(
            bytes.len() == STARTUP_OUTCOME_DESCRIPTOR_BYTES as usize,
            "short startup outcome descriptor"
        );
        let version = read_u32_le(&bytes, 0);
        let size = read_u32_le(&bytes, 4);
        let kind = read_u32_le(&bytes, 8);
        let reserved = read_u32_le(&bytes, 12);
        ensure!(
            version == STARTUP_OUTCOME_VERSION,
            "unsupported startup outcome version {version}"
        );
        ensure!(
            size == STARTUP_OUTCOME_DESCRIPTOR_BYTES,
            "invalid startup outcome descriptor size {size}"
        );
        ensure!(reserved == 0, "startup outcome reserved field was nonzero");
        Ok(StartupOutcomeDescriptor {
            kind,
            data_pointer: read_u64_le(&bytes, 16),
            data_length: read_u64_le(&bytes, 24),
        })
    }

    fn read_startup_rejection(&self, descriptor_pointer: i32) -> anyhow::Result<Vec<u8>> {
        let descriptor = self.read_startup_outcome_descriptor(descriptor_pointer)?;
        ensure!(
            descriptor.kind == STARTUP_OUTCOME_REJECTED,
            "_start Exit98 did not publish a rejected startup outcome"
        );
        ensure!(
            (1..=1_048_576).contains(&descriptor.data_length) && descriptor.data_pointer > 0,
            "rejected startup outcome carried empty or oversized protocol data"
        );
        let end = descriptor
            .data_pointer
            .checked_add(descriptor.data_length)
            .context("startup rejection protocol bounds overflow")?;
        ensure!(
            end <= u32::MAX as u64 + 1,
            "startup rejection protocol exceeds Wasm32 memory bounds"
        );
        let pointer = u32::try_from(descriptor.data_pointer)
            .context("startup rejection protocol pointer exceeds u32")?;
        let length = u32::try_from(descriptor.data_length)
            .context("startup rejection protocol length exceeds u32")?;
        let protocol = oliphaunt_copy_from_guest(&self.guest_memory, pointer, length)
            .map_err(|error| anyhow::anyhow!("copy startup rejection protocol: {error:?}"))?
            .to_vec();
        ensure!(
            protocol.len() == length as usize,
            "short startup rejection protocol copy"
        );
        validate_startup_rejection_protocol(&protocol)?;
        Ok(protocol)
    }

    fn reset_io(&mut self) -> anyhow::Result<()> {
        ensure!(
            self.input_reset
                .call(&mut self.store)
                .context("oliphaunt_wasix_input_reset")?
                == 0,
            "oliphaunt_wasix_input_reset failed"
        );
        ensure!(
            self.output_reset
                .call(&mut self.store)
                .context("oliphaunt_wasix_output_reset")?
                == 0,
            "oliphaunt_wasix_output_reset failed"
        );
        Ok(())
    }

    fn push_input_js(&mut self, bytes: &Uint8Array) -> anyhow::Result<()> {
        let len = i32::try_from(bytes.length()).context("direct protocol input exceeds i32")?;
        if len == 0 {
            return Ok(());
        }
        let ptr = self
            .input_reserve
            .call(&mut self.store, len)
            .context("oliphaunt_wasix_input_reserve")?;
        ensure!(ptr > 0, "oliphaunt_wasix_input_reserve returned null");
        oliphaunt_copy_to_guest(&self.guest_memory, ptr as u32, bytes)
            .map_err(|error| anyhow::anyhow!("copy direct protocol input into guest: {error:?}"))?;
        let committed = self
            .input_commit
            .call(&mut self.store, len)
            .context("oliphaunt_wasix_input_commit")?;
        ensure!(committed == len, "short direct protocol input commit");
        Ok(())
    }

    fn take_output_js(&mut self) -> anyhow::Result<Uint8Array> {
        let len = self
            .output_len
            .call(&mut self.store)
            .context("oliphaunt_wasix_output_len")?;
        ensure!(len >= 0, "negative direct protocol output length");
        if len == 0 {
            return Ok(Uint8Array::new_with_length(0));
        }
        let ptr = self
            .output_data
            .call(&mut self.store)
            .context("oliphaunt_wasix_output_data")?;
        ensure!(ptr > 0, "oliphaunt_wasix_output_data returned null");
        let output = oliphaunt_copy_from_guest(&self.guest_memory, ptr as u32, len as u32)
            .map_err(|error| {
                anyhow::anyhow!("copy direct protocol output from guest: {error:?}")
            })?;
        ensure!(
            self.output_reset
                .call(&mut self.store)
                .context("oliphaunt_wasix_output_reset after read")?
                == 0,
            "oliphaunt_wasix_output_reset after read failed"
        );
        Ok(output)
    }

    fn protocol_input_remaining(&mut self) -> anyhow::Result<i32> {
        let available = self
            .input_available
            .call(&mut self.store)
            .context("oliphaunt_wasix_input_available")?;
        ensure!(available >= 0, "negative direct protocol input length");
        if available > 0 {
            return Ok(available);
        }
        let buffered = self
            .pq_buffer_remaining_data
            .call(&mut self.store)
            .context("pq_buffer_remaining_data")?;
        ensure!(buffered >= 0, "negative buffered protocol input length");
        Ok(buffered)
    }

    fn startup_rejection_error(&self, error: anyhow::Error, protocol: Vec<u8>) -> Error {
        let error = self.stderr.attach(error);
        let js_error = js_sys::Error::new(&error.to_string());
        let _ = js_sys::Reflect::set(
            &js_error,
            &wasm_bindgen::JsValue::from_str("protocolResponse"),
            &Uint8Array::from(protocol.as_slice()),
        );
        let _ = js_sys::Reflect::set(
            &js_error,
            &wasm_bindgen::JsValue::from_str("detailedMessage"),
            &wasm_bindgen::JsValue::from_str(&format!("{error:#}")),
        );
        Error::js(js_error)
    }
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_u64_le(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn validate_startup_rejection_protocol(protocol: &[u8]) -> anyhow::Result<()> {
    let mut offset = 0usize;
    let mut found_error_response = false;
    while offset < protocol.len() {
        ensure!(
            protocol.len() - offset >= 5,
            "truncated startup rejection protocol frame"
        );
        let tag = protocol[offset];
        let frame_length =
            u32::from_be_bytes(protocol[offset + 1..offset + 5].try_into().unwrap()) as usize;
        ensure!(
            frame_length >= 4,
            "invalid startup rejection protocol frame length {frame_length}"
        );
        let frame_end = offset
            .checked_add(1)
            .and_then(|value| value.checked_add(frame_length))
            .context("startup rejection protocol frame bounds overflow")?;
        ensure!(
            frame_end <= protocol.len(),
            "truncated startup rejection protocol frame"
        );
        if tag == b'E' {
            validate_error_response_fields(&protocol[offset + 5..frame_end])?;
            found_error_response = true;
        }
        offset = frame_end;
    }
    ensure!(
        found_error_response,
        "startup rejection protocol did not contain an ErrorResponse"
    );
    Ok(())
}

fn validate_error_response_fields(fields: &[u8]) -> anyhow::Result<()> {
    ensure!(
        fields.last() == Some(&0),
        "startup ErrorResponse was not terminated"
    );
    let mut offset = 0usize;
    let mut found_sqlstate = false;
    while offset < fields.len() - 1 {
        ensure!(
            fields[offset] != 0,
            "startup ErrorResponse terminated before the end of its frame"
        );
        let field_type = fields[offset];
        offset += 1;
        let terminator = fields[offset..]
            .iter()
            .position(|byte| *byte == 0)
            .context("startup ErrorResponse contained an unterminated field")?;
        if field_type == b'C' {
            ensure!(
                terminator == 5,
                "startup ErrorResponse carried an invalid SQLSTATE"
            );
            found_sqlstate = true;
        }
        offset += terminator + 1;
    }
    ensure!(
        offset == fields.len() - 1,
        "startup ErrorResponse contained trailing bytes"
    );
    ensure!(
        found_sqlstate,
        "startup ErrorResponse did not contain a SQLSTATE"
    );
    Ok(())
}

fn typed_export<Args, Rets>(
    store: &mut Store,
    instance: &WasmerInstance,
    name: &str,
) -> anyhow::Result<TypedFunction<Args, Rets>>
where
    Args: WasmTypeList,
    Rets: WasmTypeList,
{
    instance
        .exports
        .get_typed_function::<Args, Rets>(&*store, name)
        .or_else(|_| {
            instance
                .exports
                .get_typed_function::<Args, Rets>(&*store, &format!("_{name}"))
        })
        .with_context(|| format!("get {name} export"))
}

fn optional_typed_export<Args, Rets>(
    store: &mut Store,
    instance: &WasmerInstance,
    name: &str,
) -> anyhow::Result<Option<TypedFunction<Args, Rets>>>
where
    Args: WasmTypeList,
    Rets: WasmTypeList,
{
    if instance.exports.get_function(name).is_err()
        && instance.exports.get_function(&format!("_{name}")).is_err()
    {
        return Ok(None);
    }
    typed_export(store, instance, name).map(Some)
}

fn seed_exported_c_string(
    store: &mut Store,
    instance: &WasmerInstance,
    env: &WasiFunctionEnv,
    name: &str,
    value: &str,
) -> anyhow::Result<()> {
    let Ok(global) = instance.exports.get_global(name) else {
        return Ok(());
    };
    let Value::I32(ptr) = global.get(&mut *store) else {
        return Ok(());
    };
    if ptr <= 0 {
        return Ok(());
    }
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    env.data(&*store)
        .try_memory_view(&*store)
        .context("get WASIX memory view")?
        .write(ptr as u64, &bytes)
        .with_context(|| format!("seed {name} at 0x{ptr:x}"))?;
    Ok(())
}

fn runtime_exit_code(error: &wasmer::RuntimeError) -> Option<i32> {
    error
        .downcast_ref::<WasiError>()
        .and_then(|error| match error {
            WasiError::Exit(code) => Some(code.raw()),
            _ => None,
        })
}
