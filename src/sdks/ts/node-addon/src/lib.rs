use liboliphaunt_native_bindings::{
    NativeCancel, NativeOpenOptions as PreparedOpenOptions, NativeSession, ProtocolStreamOutcome,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}
fn validate_library_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(Error::from_reason("liboliphaunt path must not be empty"));
    }
    if path.contains('\0') {
        return Err(Error::from_reason(
            "liboliphaunt path must not contain a null byte",
        ));
    }
    Ok(())
}

#[napi]
pub struct NativeDatabase {
    session: Arc<Mutex<NativeSession>>,
    cancel: NativeCancel,
    environment: Arc<StreamEnvironment>,
    opening: Arc<Opening>,
}
impl Drop for NativeDatabase {
    fn drop(&mut self) {
        // GC records recovery only; PostgreSQL detach belongs to the next
        // asynchronous open, never to a JavaScript finalizer.
        if self.opening.logical_active.load(Ordering::Acquire) {
            self.opening.recovery_pending.store(true, Ordering::Release);
        }
    }
}

#[derive(Default)]
struct StreamEnvironment {
    closed: AtomicBool,
    active: Mutex<Option<Arc<Ack>>>,
}
#[derive(Default)]
struct Ack {
    result: Mutex<Option<Result<()>>>,
    ready: Condvar,
}
impl Ack {
    fn complete(&self, value: Result<()>) {
        let mut slot = lock(&self.result);
        if slot.is_none() {
            *slot = Some(value);
            self.ready.notify_one();
        }
    }
    fn wait(&self) -> Result<()> {
        let mut slot = lock(&self.result);
        while slot.is_none() {
            slot = self
                .ready
                .wait(slot)
                .unwrap_or_else(|_| fatal("native callback synchronization failed"));
        }
        slot.take().unwrap()
    }
}

#[napi(object)]
pub struct OpenOptions {
    pub library_path: String,
    pub pgdata: String,
    pub runtime_directory: Option<String>,
    pub module_directory: Option<String>,
    pub icu_data_directory: Option<String>,
    pub username: String,
    pub database: String,
    pub startup_args: Vec<String>,
}
pub struct OpenTask {
    options: OpenOptions,
    opening: Arc<Opening>,
    recovery: Vec<Arc<Opening>>,
}
impl Drop for OpenTask {
    fn drop(&mut self) {
        let mut state = lock(&self.opening.state);
        if !state.0 {
            state.0 = true;
            self.opening.ready.notify_one();
        }
    }
}
#[derive(Clone)]
pub struct Opened {
    session: Arc<Mutex<NativeSession>>,
    cancel: NativeCancel,
}
struct Opening {
    state: Mutex<(bool, Option<Opened>)>,
    ready: Condvar,
    environment: Arc<StreamEnvironment>,
    recovery_pending: AtomicBool,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    owner: usize,
    logical_active: AtomicBool,
    pending: AtomicUsize,
}
thread_local! {static OPENINGS:std::cell::RefCell<Vec<std::sync::Weak<Opening>>>=Default::default();}
#[napi]
pub struct RecoveryToken {
    opening: Arc<Opening>,
}
#[napi]
impl RecoveryToken {
    #[napi]
    pub fn queue(&self) -> bool {
        if !self.opening.logical_active.load(Ordering::Acquire) {
            return false;
        }
        self.opening.recovery_pending.store(true, Ordering::Release);
        true
    }
}
impl Task for OpenTask {
    type Output = Opened;
    type JsValue = NativeDatabase;
    fn compute(&mut self) -> Result<Opened> {
        let result = (|| {
            for opening in &self.recovery {
                let opened = lock(&opening.state).1.clone();
                if let Some(opened) = opened {
                    opened
                        .session
                        .lock()
                        .map_err(native_error)?
                        .close()
                        .map_err(|error| {
                            native_error(format!(
                                "could not recover the previous logical handle: {error}"
                            ))
                        })?;
                }
                opening.logical_active.store(false, Ordering::Release);
                opening.recovery_pending.store(false, Ordering::Release);
            }
            NativeSession::open_prepared_inputs(PreparedOpenOptions {
                library_path: Some(self.options.library_path.clone().into()),
                pgdata: self.options.pgdata.clone().into(),
                runtime_directory: self.options.runtime_directory.clone().map(Into::into),
                module_directory: self.options.module_directory.clone().map(Into::into),
                icu_data_directory: self.options.icu_data_directory.clone().map(Into::into),
                username: self.options.username.clone(),
                database: self.options.database.clone(),
                startup_args: self.options.startup_args.clone(),
            })
            .map_err(native_error)
            .map(|session| {
                let cancel = session.cancel_handle();
                Opened {
                    session: Arc::new(Mutex::new(session)),
                    cancel,
                }
            })
        })();
        self.opening
            .logical_active
            .store(result.is_ok(), Ordering::Release);
        *lock(&self.opening.state) = (true, result.as_ref().ok().cloned());
        self.opening.ready.notify_one();
        result
    }
    fn resolve(&mut self, _env: Env, opened: Opened) -> Result<NativeDatabase> {
        Ok(NativeDatabase {
            session: opened.session,
            cancel: opened.cancel,
            environment: self.opening.environment.clone(),
            opening: self.opening.clone(),
        })
    }
}

enum StreamError {
    Native(liboliphaunt_native_bindings::Error),
    Js(Error),
}
impl From<liboliphaunt_native_bindings::Error> for StreamError {
    fn from(value: liboliphaunt_native_bindings::Error) -> Self {
        Self::Native(value)
    }
}
impl StreamError {
    fn into_napi(self) -> Error {
        match self {
            Self::Native(e) => native_error(e),
            Self::Js(e) => e,
        }
    }
}
type Callback = Box<dyn FnMut(&[u8]) -> std::result::Result<(), StreamError> + Send>;
enum Operation {
    Query(Vec<u8>),
    SimpleQuery(String),
    Backup,
    Close,
    Stream(Vec<u8>, Callback),
}
pub struct OperationTask {
    session: Arc<Mutex<NativeSession>>,
    operation: Operation,
    environment: Arc<StreamEnvironment>,
    opening: Arc<Opening>,
}
impl Task for OperationTask {
    type Output = Option<Vec<u8>>;
    type JsValue = Either<Uint8Array, ()>;
    fn compute(&mut self) -> Result<Self::Output> {
        let mut session = self.session.lock().map_err(native_error)?;
        if self.environment.closed.load(Ordering::Acquire) {
            return Err(Error::new(Status::Closing, "JS environment closed"));
        }
        match &mut self.operation {
            Operation::Query(bytes) => session
                .exec_protocol_raw(bytes)
                .map(Some)
                .map_err(native_error),
            Operation::Backup => session.backup().map(Some).map_err(native_error),
            Operation::Close => {
                let result = session.close().map(|_| None).map_err(native_error);
                if result.is_err() {
                    self.opening.logical_active.store(true, Ordering::Release);
                }
                result
            }
            Operation::SimpleQuery(sql) => session
                .exec_simple_query(sql)
                .map(Some)
                .map_err(native_error),
            Operation::Stream(bytes, callback) => {
                match session.exec_protocol_raw_stream(bytes, callback.as_mut()) {
                    ProtocolStreamOutcome::ReadyForQuery(result) => {
                        result.map(|_| None).map_err(StreamError::into_napi)
                    }
                    ProtocolStreamOutcome::SessionStateUnknown(error) => Err(native_error(error)),
                }
            }
        }
    }
    fn resolve(&mut self, env: Env, bytes: Self::Output) -> Result<Self::JsValue> {
        Ok(match bytes {
            Some(bytes) => Either::A(js_bytes(&env, &bytes)?),
            None => Either::B(()),
        })
    }
}
impl NativeDatabase {
    fn task<'e>(&self, env: &'e Env, operation: Operation) -> Result<Object<'e>> {
        if !matches!(operation, Operation::Close)
            && !self.opening.logical_active.load(Ordering::Acquire)
        {
            return Err(Error::from_reason("native session is closed"));
        }
        spawn(
            env,
            OperationTask {
                session: self.session.clone(),
                operation,
                environment: self.environment.clone(),
                opening: self.opening.clone(),
            },
            self.opening.clone(),
        )
    }
}
#[napi]
impl NativeDatabase {
    #[napi]
    pub fn open(env: &Env, options: OpenOptions) -> Result<Object<'_>> {
        validate_library_path(&options.library_path)?;
        let opening = register_cleanup(env, false)?;
        let recovery = OPENINGS.with(|entries| {
            let mut entries = entries.borrow_mut();
            entries.retain(|entry| entry.strong_count() > 0);
            let pending = entries
                .iter()
                .filter_map(std::sync::Weak::upgrade)
                .filter(|entry| {
                    entry.owner == opening.owner && entry.recovery_pending.load(Ordering::Acquire)
                })
                .collect();
            entries.push(Arc::downgrade(&opening));
            pending
        });
        spawn(
            env,
            OpenTask {
                options,
                opening: opening.clone(),
                recovery,
            },
            opening,
        )
    }
    #[napi]
    pub fn query<'e>(&self, env: &'e Env, bytes: Uint8Array) -> Result<Object<'e>> {
        self.task(env, Operation::Query(bytes.to_vec()))
    }
    #[napi]
    pub fn backup<'e>(&self, env: &'e Env) -> Result<Object<'e>> {
        self.task(env, Operation::Backup)
    }
    #[napi]
    pub fn close<'e>(&self, env: &'e Env) -> Result<Object<'e>> {
        self.opening.logical_active.store(false, Ordering::Release);
        let result = self.task(env, Operation::Close);
        if result.is_err() {
            self.opening.logical_active.store(true, Ordering::Release);
        }
        result
    }
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        self.cancel.cancel().map_err(native_error)
    }
    #[napi]
    pub fn recovery_token(&self) -> RecoveryToken {
        RecoveryToken {
            opening: self.opening.clone(),
        }
    }
    #[napi]
    pub fn stream<'e>(
        &self,
        env: &'e Env,
        bytes: Uint8Array,
        on_chunk: Function<'_, Uint8Array, Unknown<'static>>,
    ) -> Result<Object<'e>> {
        let threadsafe = on_chunk
            .build_threadsafe_function::<Vec<u8>>()
            .max_queue_size::<1>()
            .build_callback(|context: ThreadsafeCallContext<Vec<u8>>| {
                js_bytes(&context.env, &context.value)
            })?;
        let environment = self.environment.clone();
        let callback: Callback = Box::new(move |bytes| {
            let ack = Arc::new(Ack::default());
            {
                let mut active = lock(&environment.active);
                if environment.closed.load(Ordering::Acquire) {
                    return Err(StreamError::Js(Error::new(
                        Status::Closing,
                        "JS environment closed",
                    )));
                }
                *active = Some(ack.clone());
            }
            let callback_ack = ack.clone();
            let status = threadsafe.call_with_return_value(
                bytes.to_vec(), ThreadsafeFunctionCallMode::Blocking,
                move |result, env| {
                    let result=result.and_then(|value| {
                        if matches!(value.get_type()?, napi::ValueType::Object | napi::ValueType::Function) {
                            let object: Object = unsafe {value.cast()?};
                            let then: Unknown=object.get_named_property("then")?;
                            if then.get_type()? == napi::ValueType::Function {
                                return Err(Error::from_reason("raw protocol stream callback must complete synchronously and must not return a Promise or thenable"));
                            }
                        }
                        Ok(())
                    });
                    let result=result.map_err(|error| {
                        if error.status == Status::PendingException {
                            // The callback bridge may already have captured and
                            // cleared its exception; preserve that retained value.
                            let mut pending=false;
                            unsafe {napi::sys::napi_is_exception_pending(env.raw(),&mut pending);}
                            if !pending {return error;}
                            let mut thrown=std::ptr::null_mut();
                            let status=unsafe {napi::sys::napi_get_and_clear_last_exception(env.raw(), &mut thrown)};
                            if status == napi::sys::Status::napi_ok && !thrown.is_null()
                                && let Ok(value) = unsafe { Unknown::from_napi_value(env.raw(), thrown) } {
                                return Error::from_unknown_without_coercion(value);
                            }
                        }
                        error
                    });
                    callback_ack.complete(result);
                    Ok(())
                }
            );
            if status != Status::Ok {
                ack.complete(Err(Error::new(status, "stream callback failed")));
            }
            let result = ack.wait();
            lock(&environment.active).take();
            result.map_err(StreamError::Js)
        });
        self.task(env, Operation::Stream(bytes.to_vec(), callback))
    }
}

pub struct RestoreTask {
    library: String,
    destination: String,
    bytes: Vec<u8>,
}
impl Task for RestoreTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        NativeSession::restore_from_library(
            std::path::Path::new(&self.library),
            std::path::Path::new(&self.destination),
            &self.bytes,
        )
        .map_err(native_error)
    }
    fn resolve(&mut self, _env: Env, _: ()) -> Result<()> {
        Ok(())
    }
}
#[napi]
pub fn restore(env: &Env, options: RestoreOptions) -> Result<Object<'_>> {
    validate_library_path(&options.library_path)?;
    let opening = register_cleanup(env, true)?;
    spawn(
        env,
        RestoreTask {
            library: options.library_path,
            destination: options.destination,
            bytes: options.bytes.to_vec(),
        },
        opening,
    )
}

fn js_bytes(env: &Env, bytes: &[u8]) -> Result<Uint8Array> {
    // Reuse the current WASIX addon buffer contract, including napi 3.12.2 copy initialization.
    let mut output = Uint8ArraySlice::copy_from(env, bytes)?;
    unsafe { output.as_mut() }.copy_from_slice(bytes);
    output.into_typed_array(env)
}

struct PendingWork(Arc<Opening>);
impl Drop for PendingWork {
    fn drop(&mut self) {
        let _state = lock(&self.0.state);
        self.0.pending.fetch_sub(1, Ordering::AcqRel);
        self.0.ready.notify_all();
    }
}
fn spawn<T: Task + 'static>(env: &Env, mut task: T, opening: Arc<Opening>) -> Result<Object<'_>> {
    let (deferred, promise) = env.create_deferred()?;
    let failed = deferred.clone();
    opening.pending.fetch_add(1, Ordering::AcqRel);
    let pending = PendingWork(opening.clone());
    let started = std::thread::Builder::new()
        .name("oliphaunt-native".into())
        .spawn(move || {
            let result = task.compute();
            deferred.resolve(move |env: Env| {
                let resolved = match result {
                    Ok(output) => task.resolve(env, output),
                    Err(error) => task.reject(env, error),
                };
                task.finally(env)?;
                resolved
            });
            drop(pending);
        });
    match started {
        Ok(worker) => {
            let mut workers = lock(&opening.workers);
            let mut active = Vec::new();
            for previous in workers.drain(..) {
                if previous.is_finished() {
                    previous
                        .join()
                        .unwrap_or_else(|_| fatal("native worker panicked"));
                } else {
                    active.push(previous);
                }
            }
            active.push(worker);
            *workers = active;
        }
        Err(error) => failed.reject(native_error(error)),
    }
    Ok(promise)
}
fn register_cleanup(env: &Env, initialized: bool) -> Result<Arc<Opening>> {
    let opening = Arc::new(Opening {
        state: Mutex::new((initialized, None)),
        ready: Condvar::new(),
        environment: Arc::new(StreamEnvironment::default()),
        recovery_pending: AtomicBool::new(false),
        workers: Mutex::new(Vec::new()),
        owner: env.raw() as usize,
        logical_active: AtomicBool::new(false),
        pending: AtomicUsize::new(0),
    });
    env.add_env_cleanup_hook(opening.clone(), cleanup_opening)?;
    Ok(opening)
}
fn fatal(message: &str) -> ! {
    unsafe {
        napi::sys::napi_fatal_error(
            c"oliphaunt".as_ptr(),
            9,
            message.as_ptr().cast(),
            message.len() as isize,
        );
    }
    std::process::abort()
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|_| fatal("native adapter synchronization failed"))
}
fn quiesce_opening(opening: Arc<Opening>) {
    opening.environment.closed.store(true, Ordering::Release);
    if let Some(ack) = lock(&opening.environment.active).take() {
        ack.complete(Err(Error::new(Status::Closing, "JS environment closed")));
    }
}

// Cleanup runs on the terminating environment, after releasing callback waits.
// Native operations need no JavaScript progress; competing opens fail immediately.
// Join every worker before returning so no addon code outlives its environment.
fn cleanup_opening(opening: Arc<Opening>) {
    quiesce_opening(opening.clone());
    let mut state = lock(&opening.state);
    while !state.0 || opening.pending.load(Ordering::Acquire) != 0 {
        let cancel = state.1.as_ref().map(|opened| opened.cancel.clone());
        drop(state);
        if let Some(cancel) = cancel {
            let _ = cancel.cancel();
        }
        state = lock(&opening.state);
        if !state.0 || opening.pending.load(Ordering::Acquire) != 0 {
            state = opening
                .ready
                .wait_timeout(state, std::time::Duration::from_millis(10))
                .unwrap_or_else(|_| fatal("native cleanup synchronization failed"))
                .0;
        }
    }
    let opened = state.1.take();
    drop(state);
    for worker in lock(&opening.workers).drain(..) {
        worker
            .join()
            .unwrap_or_else(|_| fatal("native worker panicked"));
    }
    if let Some(opened) = opened
        && let Err(error) = lock(&opened.session).close_terminal_if_owned()
    {
        fatal(&error.to_string());
    }
}

#[napi(object)]
pub struct RestoreOptions {
    pub library_path: String,
    pub destination: String,
    pub bytes: Uint8Array,
}
#[napi]
pub fn open(env: &Env, options: OpenOptions) -> Result<Object<'_>> {
    NativeDatabase::open(env, options)
}
#[napi]
pub fn exec_protocol_raw<'e>(
    env: &'e Env,
    handle: &NativeDatabase,
    request: Uint8Array,
) -> Result<Object<'e>> {
    handle.query(env, request)
}
#[napi]
pub fn exec_simple_query<'e>(
    env: &'e Env,
    handle: &NativeDatabase,
    sql: String,
) -> Result<Object<'e>> {
    handle.task(env, Operation::SimpleQuery(sql))
}
#[napi]
pub fn exec_protocol_raw_stream<'e>(
    env: &'e Env,
    handle: &NativeDatabase,
    request: Uint8Array,
    callback: Function<'_, Uint8Array, Unknown<'static>>,
) -> Result<Object<'e>> {
    handle.stream(env, request, callback)
}
#[napi]
pub fn backup<'e>(env: &'e Env, handle: &NativeDatabase) -> Result<Object<'e>> {
    handle.backup(env)
}
#[napi]
pub fn cancel(handle: &NativeDatabase) -> Result<()> {
    handle.cancel()
}
#[napi]
pub fn detach<'e>(env: &'e Env, handle: &NativeDatabase) -> Result<Object<'e>> {
    handle.close(env)
}
#[napi]
pub fn create_forgotten_handle_recovery_token(handle: &NativeDatabase) -> RecoveryToken {
    handle.recovery_token()
}
#[napi]
pub fn queue_forgotten_handle_recovery(token: &RecoveryToken) -> bool {
    token.queue()
}

#[napi]
pub fn version(library_path: String) -> Result<String> {
    validate_library_path(&library_path)?;
    NativeSession::version_from_library(std::path::Path::new(&library_path)).map_err(native_error)
}
