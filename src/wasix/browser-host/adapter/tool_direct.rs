use std::{
    cell::RefCell,
    error::Error as StdError,
    fmt,
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
use wasmer::{Store, TypedFunction};
use wasmer_types::ModuleHash;
use wasmer_wasix::{Runtime as _, WasiEnvBuilder, WasiError};

use super::{
    RunOptions,
    caller_realm::CallerRealmTaskManager,
    runtime::Runtime,
    utils::{Error, js_error},
};

const DEFAULT_PROGRAM_NAME: &str = "wasm";
use super::protocol_contract::PROTOCOL_CALLBACK_CHUNK_BYTES as PROTOCOL_CHUNK_BYTES;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "OliphauntToolOutput")]
    pub type JsToolOutput;
}

#[wasm_bindgen(typescript_custom_section)]
const TOOL_OUTPUT_TYPE_DEFINITION: &'static str = r#"
export type OliphauntToolOutput = {
    code: number;
    stdoutBytes: Uint8Array;
    stderrBytes: Uint8Array;
}
"#;

fn tool_output(code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> JsToolOutput {
    let output = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&output, &JsValue::from_str("code"), &JsValue::from(code));
    let _ = js_sys::Reflect::set(
        &output,
        &JsValue::from_str("stdoutBytes"),
        &Uint8Array::from(stdout.as_slice()),
    );
    let _ = js_sys::Reflect::set(
        &output,
        &JsValue::from_str("stderrBytes"),
        &Uint8Array::from(stderr.as_slice()),
    );
    output.unchecked_into()
}

/// Immutable frontend-program state shared by repeated invocations in one
/// JavaScript realm. Every invocation still creates fresh WASI process state.
#[wasm_bindgen]
pub struct OliphauntPreparedTool {
    runtime: Arc<Runtime>,
    module: wasmer::Module,
    module_hash: ModuleHash,
}

#[wasm_bindgen(js_name = prepareOliphauntTool)]
pub fn prepare_oliphaunt_tool(
    module: WebAssembly::Module,
    module_bytes: Uint8Array,
) -> Result<OliphauntPreparedTool, Error> {
    let module_bytes = module_bytes.to_vec();
    let module_hash = ModuleHash::new(&module_bytes);
    let module = wasmer::Module::from((module, module_bytes));
    let runtime = Arc::new(super::runtime::runtime(Arc::new(CallerRealmTaskManager))?);
    Ok(OliphauntPreparedTool {
        runtime,
        module,
        module_hash,
    })
}

#[derive(Clone)]
struct ProtocolCallbacks {
    read: Function,
    write: Function,
}

thread_local! {
    static PROTOCOL_CALLBACKS: RefCell<Option<ProtocolCallbacks>> = const { RefCell::new(None) };
}

/// Keeps the caller-realm callbacks active only while the guest is executing.
struct ActiveProtocolCallbacks;

impl ActiveProtocolCallbacks {
    fn begin(read: Function, write: Function) -> anyhow::Result<Self> {
        PROTOCOL_CALLBACKS.with(|active| {
            let mut active = active.borrow_mut();
            ensure!(
                active.is_none(),
                "an Oliphaunt tool protocol session is already active"
            );
            *active = Some(ProtocolCallbacks { read, write });
            Ok(Self)
        })
    }
}

impl Drop for ActiveProtocolCallbacks {
    fn drop(&mut self) {
        PROTOCOL_CALLBACKS.with(|active| *active.borrow_mut() = None);
    }
}

#[derive(Clone, Debug, Default)]
struct ToolProtocolFile;

impl ToolProtocolFile {
    fn callbacks() -> io::Result<ProtocolCallbacks> {
        PROTOCOL_CALLBACKS
            .with(|active| active.borrow().clone())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Oliphaunt tool protocol callbacks are inactive",
                )
            })
    }
}

impl AsyncRead for ToolProtocolFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let requested = buffer.remaining().min(PROTOCOL_CHUNK_BYTES);
        if requested == 0 {
            return Poll::Ready(Ok(()));
        }

        let callbacks = match Self::callbacks() {
            Ok(callbacks) => callbacks,
            Err(error) => return Poll::Ready(Err(error)),
        };
        let value = match callbacks
            .read
            .call1(&JsValue::UNDEFINED, &JsValue::from(requested as u32))
        {
            Ok(value) => value,
            Err(error) => {
                return Poll::Ready(Err(io::Error::other(format!(
                    "Oliphaunt tool protocol read failed: {}",
                    js_error(error)
                ))));
            }
        };
        let input = match value.dyn_into::<Uint8Array>() {
            Ok(input) => input,
            Err(_) => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Oliphaunt tool protocol read must return a Uint8Array",
                )));
            }
        };
        let length = input.length() as usize;
        if length > requested {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Oliphaunt tool protocol read exceeded the requested byte count",
            )));
        }
        if length > 0 {
            input.copy_to(buffer.initialize_unfilled_to(length));
            buffer.advance(length);
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for ToolProtocolFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        if input.is_empty() {
            return Poll::Ready(Ok(0));
        }

        let callbacks = match Self::callbacks() {
            Ok(callbacks) => callbacks,
            Err(error) => return Poll::Ready(Err(error)),
        };
        let length = input.len().min(PROTOCOL_CHUNK_BYTES);
        // Copy the Rust-owned input into JavaScript-owned storage before the
        // callback. It may retain or mutate this independent chunk without
        // aliasing memory that Rust can reuse after this call returns.
        let chunk = Uint8Array::from(&input[..length]);
        match callbacks.write.call1(&JsValue::UNDEFINED, &chunk) {
            Ok(_) => Poll::Ready(Ok(length)),
            Err(error) => Poll::Ready(Err(io::Error::other(format!(
                "Oliphaunt tool protocol write failed: {}",
                js_error(error)
            )))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for ToolProtocolFile {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for ToolProtocolFile {
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

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(PROTOCOL_CHUNK_BYTES))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(PROTOCOL_CHUNK_BYTES))
    }
}

#[derive(Clone, Copy, Debug)]
enum CaptureStream {
    Stdout,
    Stderr,
}

impl fmt::Display for CaptureStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        })
    }
}

#[derive(Clone, Copy, Debug)]
enum CaptureFailure {
    AllocationFailed(CaptureStream),
    LockPoisoned,
}

impl CaptureFailure {
    fn io_error(self) -> io::Error {
        let kind = match self {
            Self::AllocationFailed(_) => io::ErrorKind::OutOfMemory,
            Self::LockPoisoned => io::ErrorKind::Other,
        };
        io::Error::new(kind, self)
    }
}

impl fmt::Display for CaptureFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllocationFailed(stream) => {
                write!(
                    formatter,
                    "Oliphaunt WASIX tool {stream} capture allocation failed"
                )
            }
            Self::LockPoisoned => {
                formatter.write_str("Oliphaunt WASIX tool output capture lock was poisoned")
            }
        }
    }
}

impl StdError for CaptureFailure {}

#[derive(Debug, Default)]
struct CaptureState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    failure: Option<CaptureFailure>,
}

impl CaptureState {
    fn output(&self, stream: CaptureStream) -> &Vec<u8> {
        match stream {
            CaptureStream::Stdout => &self.stdout,
            CaptureStream::Stderr => &self.stderr,
        }
    }

    fn output_mut(&mut self, stream: CaptureStream) -> &mut Vec<u8> {
        match stream {
            CaptureStream::Stdout => &mut self.stdout,
            CaptureStream::Stderr => &mut self.stderr,
        }
    }

    fn discard_output(&mut self) {
        self.stdout = Vec::new();
        self.stderr = Vec::new();
    }

    fn fail(&mut self, failure: CaptureFailure) -> io::Error {
        let failure = *self.failure.get_or_insert(failure);
        self.discard_output();
        failure.io_error()
    }

    fn poison_lock(&mut self) -> CaptureFailure {
        self.failure = Some(CaptureFailure::LockPoisoned);
        self.discard_output();
        CaptureFailure::LockPoisoned
    }

    fn append(&mut self, stream: CaptureStream, input: &[u8]) -> io::Result<usize> {
        if let Some(failure) = self.failure {
            return Err(failure.io_error());
        }
        if self.output_mut(stream).try_reserve(input.len()).is_err() {
            return Err(self.fail(CaptureFailure::AllocationFailed(stream)));
        }
        self.output_mut(stream).extend_from_slice(input);
        Ok(input.len())
    }
}

/// Complete in-memory stdout/stderr capture for a fresh tool process.
/// The handle refuses to publish either stream after any capture failure.
#[derive(Clone, Debug)]
struct CaptureFile {
    state: Arc<Mutex<CaptureState>>,
    stream: CaptureStream,
}

#[derive(Clone, Debug)]
struct CaptureHandle {
    state: Arc<Mutex<CaptureState>>,
}

impl CaptureFile {
    fn pair() -> (Self, Self, CaptureHandle) {
        let state = Arc::new(Mutex::new(CaptureState::default()));
        (
            Self {
                state: state.clone(),
                stream: CaptureStream::Stdout,
            },
            Self {
                state: state.clone(),
                stream: CaptureStream::Stderr,
            },
            CaptureHandle { state },
        )
    }

    fn with_state<T>(
        &self,
        operation: impl FnOnce(&mut CaptureState) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(error) => {
                let mut state = error.into_inner();
                return Err(state.poison_lock().io_error());
            }
        };
        operation(&mut state)
    }
}

impl CaptureHandle {
    fn failure(&self) -> Option<CaptureFailure> {
        match self.state.lock() {
            Ok(state) => state.failure,
            Err(error) => {
                let mut state = error.into_inner();
                state.poison_lock();
                state.failure
            }
        }
    }

    fn finish(&self) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(error) => {
                let mut state = error.into_inner();
                let failure = state.poison_lock();
                return Err(anyhow::Error::new(failure));
            }
        };
        if let Some(failure) = state.failure {
            state.discard_output();
            return Err(anyhow::Error::new(failure));
        }
        Ok((
            std::mem::take(&mut state.stdout),
            std::mem::take(&mut state.stderr),
        ))
    }
}

impl AsyncRead for CaptureFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for CaptureFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        let stream = self.stream;
        Poll::Ready(self.with_state(|state| state.append(stream, input)))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for CaptureFile {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        let stream = self.stream;
        Poll::Ready(self.with_state(|state| Ok(state.output(stream).len() as u64)))
    }
}

impl VirtualFile for CaptureFile {
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
        let stream = self.stream;
        match self.with_state(|state| Ok(state.output(stream).len() as u64)) {
            Ok(size) => size,
            Err(_) => 0,
        }
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(virtual_fs::FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
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

/// Run an Oliphaunt frontend tool synchronously in the caller's JavaScript
/// realm, while routing its private PGWire device through blocking callbacks.
/// The protocol write callback receives an owned JavaScript copy that it may retain.
#[wasm_bindgen(js_name = runOliphauntToolDirect)]
pub async fn run_oliphaunt_tool_direct(
    prepared: &OliphauntPreparedTool,
    options: RunOptions,
    protocol_read: Function,
    protocol_write: Function,
) -> Result<JsToolOutput, Error> {
    if let Some(tty) = prepared.runtime.tty() {
        tty.reset();
    }
    let program_name = options
        .program()
        .as_string()
        .unwrap_or_else(|| DEFAULT_PROGRAM_NAME.to_owned());
    let (stdout, stderr, capture) = CaptureFile::pair();
    let mut builder = WasiEnvBuilder::new(program_name).runtime(prepared.runtime.clone());
    options.configure_tool_direct_builder(
        &mut builder,
        Box::new(ToolProtocolFile),
        Box::new(stdout.clone()),
        Box::new(stderr.clone()),
    )?;

    let mut store = Store::new(prepared.runtime.engine());
    let (instance, _env) = builder
        .instantiate_ext_async(prepared.module.clone(), prepared.module_hash, &mut store)
        .await
        .context("instantiate Oliphaunt WASIX tool")?;
    let start: TypedFunction<(), ()> = instance
        .exports
        .get_typed_function(&store, "_start")
        .context("get Oliphaunt WASIX tool _start export")?;

    let code = {
        let _callbacks = ActiveProtocolCallbacks::begin(protocol_read, protocol_write)?;
        match start.call(&mut store) {
            Ok(()) => 0,
            Err(error) => match runtime_exit_code(&error) {
                Some(code) => code,
                None => {
                    if let Some(failure) = capture.failure() {
                        return Err(Error::from(anyhow::Error::new(failure)));
                    }
                    return Err(Error::from(
                        anyhow::Error::from(error).context("run Oliphaunt WASIX tool"),
                    ));
                }
            },
        }
    };

    let (stdout, stderr) = capture.finish().map_err(Error::from)?;
    Ok(tool_output(code, stdout, stderr))
}

fn runtime_exit_code(error: &wasmer::RuntimeError) -> Option<i32> {
    error
        .downcast_ref::<WasiError>()
        .and_then(|error| match error {
            WasiError::Exit(code) => Some(code.raw()),
            _ => None,
        })
}
