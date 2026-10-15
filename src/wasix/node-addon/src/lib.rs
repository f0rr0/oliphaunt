//! Node-API boundary for the Oliphaunt WASIX Rust runtime.
//!
//! `NativeWasixActorDatabase` and `NativeWasixServer` reuse the Rust async
//! owners directly. Promise settlement is the only owner-to-JavaScript hop;
//! no Tokio runtime or Node async-work queue participates in database work.

use std::collections::BTreeMap;
#[cfg(feature = "tools")]
use std::collections::BTreeSet;
use std::mem;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
#[cfg(feature = "tools")]
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::{self, ThreadId};

use napi::Env;
use napi::bindgen_prelude::{
    Function, JsObjectValue, JsValue, Object, ObjectFinalize, ToNapiValue, Uint8Array,
    Uint8ArraySlice,
};
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use oliphaunt_pgwire_server::{AsyncOliphauntServer, AsyncOliphauntServerBuilder, ServerListen};
#[cfg(feature = "extensions")]
use oliphaunt_wasix::Extension;
#[cfg(feature = "tools")]
use oliphaunt_wasix::tools::{
    PgDumpOptions, PostgresToolOutput, PostgresToolSummary, PsqlOptions, ToolAssets,
};
use oliphaunt_wasix::{
    AsyncOliphaunt, AsyncOliphauntBuilder, CatalogProfile, ClusterSeed, DatabaseStorage, ErrorKind,
    IcuData, Oliphaunt, OliphauntBuilder, RawStreamError, StorageCommitState, StorageErrorCode,
    StorageErrorPhase,
};

#[cfg(feature = "extensions")]
mod extension_package;

const ADDON_ABI_VERSION: u32 = 3;
const NODE_API_VERSION: u32 = 8;
const RUNTIME_VERSION: &str = liboliphaunt_wasix_portable::PACKAGE_VERSION;

/// Keep the native image mapped after a JavaScript Worker environment exits.
///
/// The synchronous `/direct` placement can initialize Wasmer/WASIX's
/// process-wide Tokio runtime without first creating a Node-API deferred or
/// threadsafe function. Those napi-rs values normally request this same pin,
/// but a direct-only Worker has neither. The runtime's native threads can
/// outlive that Worker environment, so Windows must not `FreeLibrary` (and
/// Unix hosts must not `dlclose`) the code containing their wakers. napi-rs
/// implements this as a process-once loader reference and leaves the event
/// loop unreferenced.
#[inline]
fn retain_addon_image_for_process_runtime() {
    #[cfg(not(feature = "test-noop"))]
    napi::bindgen_prelude::retain_current_module_for_unload_safety();
}

#[napi(object)]
pub struct NativeStorageOptions {
    pub kind: String,
    pub path: Option<String>,
}

#[napi(object)]
pub struct NativeSeedInput {
    pub archive: Uint8Array,
    pub manifest: Uint8Array,
}

#[napi(object)]
pub struct NativeIcuInput {
    pub data: Uint8Array,
    pub manifest: Uint8Array,
}

// Snapshot caller-owned views before resource preparation moves off the JS thread.
fn snapshot_resources(seed: &mut Option<NativeSeedInput>, icu: &mut Option<NativeIcuInput>) {
    if let Some(seed) = seed {
        seed.archive = Uint8Array::new(seed.archive.to_vec());
        seed.manifest = Uint8Array::new(seed.manifest.to_vec());
    }
    if let Some(icu) = icu {
        icu.data = Uint8Array::new(icu.data.to_vec());
        icu.manifest = Uint8Array::new(icu.manifest.to_vec());
    }
}

#[napi(object)]
pub struct NativeExtensionPackage {
    pub sql_name: String,
    pub product: String,
    pub version: String,
    pub package_json: String,
    pub archive_sha256: String,
    pub archive_size: u32,
    pub aot_package_json: Option<String>,
}

#[napi(object)]
pub struct NativeAdmissionOptions {
    pub max_pending_operations: f64,
    pub high_water_mark_bytes: f64,
}

fn resolve_admission(options: &NativeAdmissionOptions) -> Result<oliphaunt_wasix::AdmissionLimits> {
    fn value(value: f64) -> Result<usize> {
        if !value.is_finite() || value < 1.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
            return Err(invalid_argument(
                "admission limits must be positive integers within the WASIX owner range",
            ));
        }
        Ok(value as usize)
    }
    Ok(oliphaunt_wasix::AdmissionLimits::new(
        value(options.max_pending_operations)?,
        value(options.high_water_mark_bytes)?,
    ))
}

#[napi(object)]
pub struct NativeOpenOptions {
    pub admission: Option<NativeAdmissionOptions>,
    pub profile: String,
    pub storage: NativeStorageOptions,
    pub username: String,
    pub database: String,
    #[napi(js_name = "startupGucs")]
    pub startup_gucs: BTreeMap<String, String>,
    pub extensions: Vec<String>,
    pub extension_packages: Option<Vec<NativeExtensionPackage>>,
    pub seed: Option<NativeSeedInput>,
    #[napi(js_name = "icuData")]
    pub icu_data: Option<NativeIcuInput>,
}

#[napi(object)]
pub struct NativeListenOptions {
    pub transport: String,
    pub port: Option<u32>,
    pub directory: Option<String>,
}

#[napi(object)]
pub struct NativeServerOpenOptions {
    pub profile: String,
    pub storage: NativeStorageOptions,
    pub username: String,
    pub database: String,
    #[napi(js_name = "startupGucs")]
    pub startup_gucs: BTreeMap<String, String>,
    pub extensions: Vec<String>,
    pub extension_packages: Option<Vec<NativeExtensionPackage>>,
    pub seed: Option<NativeSeedInput>,
    #[napi(js_name = "icuData")]
    pub icu_data: Option<NativeIcuInput>,
    pub listen: NativeListenOptions,
}

#[napi(object)]
pub struct NativeToolResult {
    pub status: i32,
    pub stdout: Uint8Array,
    pub stderr: Uint8Array,
}

#[napi(object)]
pub struct NativeToolSummary {
    pub stdout_bytes: f64,
    pub stderr: String,
    pub stderr_truncated: bool,
}

#[napi(object)]
pub struct NativeToolAssets {
    pub wasm: Uint8Array,
    pub aot: Uint8Array,
    pub manifest: String,
}

#[cfg(feature = "tools")]
#[allow(unsafe_code)]
fn tool_assets(assets: NativeToolAssets) -> ToolAssets {
    // SAFETY: this API loads the caller's trusted native-code tool package.
    // Rust validates its target, source identity and all content hashes before
    // deserializing. Own both buffers before any asynchronous execution.
    unsafe { ToolAssets::new(assets.wasm.to_vec(), assets.aot.to_vec(), assets.manifest) }
}

#[derive(Debug)]
struct CreatorThread {
    id: ThreadId,
}

impl CreatorThread {
    fn current() -> Self {
        Self {
            id: thread::current().id(),
        }
    }

    fn require(&self, owner: &'static str) -> Result<()> {
        if thread::current().id() == self.id {
            return Ok(());
        }
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "{owner} is bound to the JavaScript thread that created it; open and use it in the same Node.js, Bun, Deno, or Electron isolate"
            ),
        ))
    }
}

/// Synchronous database owner for the `/direct` placement and for a real
/// JavaScript Worker placement which loads `/direct` in its own isolate.
#[napi(custom_finalize)]
pub struct NativeWasixDatabase {
    owner: CreatorThread,
    database: Option<Oliphaunt>,
}

impl NativeWasixDatabase {
    fn invoke_result<T, E>(
        &mut self,
        env: &Env,
        operation: &'static str,
        action: impl FnOnce(&mut Oliphaunt) -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        self.owner.require("WASIX direct database")?;
        let Some(mut database) = self.database.take() else {
            return Err(native_lifecycle_error(
                env,
                operation,
                "WASIX direct database is closed",
            ));
        };
        match catch_unwind(AssertUnwindSafe(|| action(&mut database))) {
            Ok(result) => {
                self.database = Some(database);
                Ok(result)
            }
            Err(payload) => {
                // The Wasmer store cannot be trusted after an unwind. Retire
                // and quarantine it instead of allowing a second entry or Drop.
                mem::forget(payload);
                mem::forget(database);
                Err(native_lifecycle_error(
                    env,
                    operation,
                    "WASIX direct database panicked and was permanently retired",
                ))
            }
        }
    }

    fn invoke_core<T>(
        &mut self,
        env: &Env,
        operation: &'static str,
        action: impl FnOnce(&mut Oliphaunt) -> oliphaunt_wasix::Result<T>,
    ) -> Result<oliphaunt_wasix::Result<T>> {
        self.invoke_result(env, operation, action)
    }

    fn invoke<T>(
        &mut self,
        env: &Env,
        operation: &'static str,
        action: impl FnOnce(&mut Oliphaunt) -> oliphaunt_wasix::Result<T>,
    ) -> Result<T> {
        self.invoke_core(env, operation, action)?
            .map_err(|error| native_runtime_error(env, operation, error))
    }
}

impl Drop for NativeWasixDatabase {
    fn drop(&mut self) {
        let Some(mut database) = self.database.take() else {
            return;
        };
        if thread::current().id() != self.owner.id {
            mem::forget(database);
            return;
        }
        if let Err(payload) = catch_unwind(AssertUnwindSafe(|| {
            let _ = database.close();
        })) {
            mem::forget(payload);
            mem::forget(database);
        }
    }
}

impl ObjectFinalize for NativeWasixDatabase {
    fn finalize(mut self, _env: Env) -> Result<()> {
        // A V8/N-API finalizer is an environment-teardown callback, not an
        // explicit lifecycle operation. Synchronous PostgreSQL shutdown could
        // hang teardown indefinitely, so quarantine the still-open creator-
        // thread-affine store. An already closed store is safe to drop and
        // release normally; explicit `close()` therefore does not leak its
        // Wasmer allocation. Drop sees `None` after this method.
        drop_if_closed_or_quarantine(&mut self.database, Oliphaunt::is_closed);
        Ok(())
    }
}

fn drop_if_closed_or_quarantine<T>(value: &mut Option<T>, is_closed: impl FnOnce(&T) -> bool) {
    if let Some(value) = value.take() {
        if is_closed(&value) {
            drop(value);
        } else {
            mem::forget(value);
        }
    }
}

#[napi]
impl NativeWasixDatabase {
    #[napi(factory, catch_unwind)]
    pub fn open(env: Env, options: NativeOpenOptions) -> Result<Self> {
        retain_addon_image_for_process_runtime();
        let database = configure_direct_database(options)?
            .open()
            .map_err(|error| native_runtime_error(&env, "open WASIX direct database", error))?;
        Ok(Self {
            owner: CreatorThread::current(),
            database: Some(database),
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn closed(&self) -> Result<bool> {
        self.owner.require("WASIX direct database")?;
        Ok(self.database.as_ref().is_none_or(Oliphaunt::is_closed))
    }

    #[napi(js_name = "execProtocolRaw", catch_unwind)]
    pub fn exec_protocol_raw(
        &mut self,
        env: Env,
        request: Uint8ArraySlice<'_>,
    ) -> Result<Uint8Array> {
        let response = self.invoke(&env, "execute PostgreSQL protocol request", |database| {
            database.exec_protocol_raw(request.as_ref())
        })?;
        v8_owned_bytes(&env, &response)
    }

    #[napi(js_name = "execProtocolRawStream", catch_unwind)]
    pub fn exec_protocol_raw_stream(
        &mut self,
        env: Env,
        request: Uint8ArraySlice<'_>,
        on_chunk: Function<'_, Uint8Array, ()>,
    ) -> Result<&'static str> {
        let callback = on_chunk.create_ref()?;
        let raw_env = env.raw() as usize;
        let owner_thread = self.owner.id;
        let result =
            self.invoke_result(&env, "stream PostgreSQL protocol response", |database| {
                database.exec_protocol_raw_stream(request.as_ref(), move |chunk| {
                    if thread::current().id() != owner_thread {
                        return Err(Error::new(
                            Status::GenericFailure,
                            "WASIX protocol callback left its JavaScript owner thread",
                        ));
                    }
                    let callback_env = Env::from_raw(raw_env as napi::sys::napi_env);
                    let output = v8_owned_bytes(&callback_env, chunk)?;
                    callback.borrow_back(&callback_env)?.call(output)
                })
            })?;
        match result {
            Ok(()) => Ok("complete"),
            Err(RawStreamError::Callback(_)) => Ok("callbackAborted"),
            Err(RawStreamError::Database(error)) => Err(native_runtime_error(
                &env,
                "stream PostgreSQL protocol response",
                error,
            )),
            Err(RawStreamError::CallbackPanicked(error)) => Err(native_runtime_error(
                &env,
                "stream PostgreSQL protocol callback",
                error,
            )),
            Err(_) => Err(Error::new(
                Status::GenericFailure,
                "stream PostgreSQL protocol response: unknown stream error",
            )),
        }
    }

    #[napi(catch_unwind)]
    pub fn backup(&mut self, env: Env) -> Result<Uint8Array> {
        let backup = self.invoke(&env, "back up WASIX database", Oliphaunt::backup)?;
        v8_owned_bytes(&env, &backup)
    }

    #[napi(js_name = "pgDump", catch_unwind)]
    pub fn pg_dump(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
    ) -> Result<NativeToolResult> {
        #[cfg(feature = "tools")]
        {
            let output = self.invoke_core(&env, "run WASIX pg_dump", |database| {
                database.pg_dump_output(PgDumpOptions::new().args(args).assets(tool_assets(assets)))
            })?;
            native_tool_result(&env, "run WASIX pg_dump", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets);
            Err(missing_release_feature("tools", "pgDump"))
        }
    }

    #[napi(catch_unwind)]
    pub fn psql(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<NativeToolResult> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let options = psql_options(args, command, script).assets(tool_assets(assets));
            let output = self.invoke_core(&env, "run WASIX psql", |database| {
                database.psql_output(options)
            })?;
            native_tool_result(&env, "run WASIX psql", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, command, script);
            Err(missing_release_feature("tools", "psql"))
        }
    }

    #[napi(js_name = "pgDumpToFile", catch_unwind)]
    pub fn pg_dump_to_file(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: String,
    ) -> Result<NativeToolSummary> {
        #[cfg(feature = "tools")]
        {
            let options = PgDumpOptions::new().args(args).assets(tool_assets(assets));
            let output = self.invoke_core(&env, "write WASIX pg_dump file", |database| {
                database.pg_dump_to_file(options, destination, None)
            })?;
            native_tool_summary(&env, "write WASIX pg_dump file", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination);
            Err(missing_release_feature("tools", "pgDumpToFile"))
        }
    }

    #[napi(js_name = "psqlToFile", catch_unwind)]
    pub fn psql_to_file(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: String,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<NativeToolSummary> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let options = psql_options(args, command, script).assets(tool_assets(assets));
            let output = self.invoke_core(&env, "write WASIX psql file", |database| {
                database.psql_to_file(options, destination, None)
            })?;
            native_tool_summary(&env, "write WASIX psql file", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination, command, script);
            Err(missing_release_feature("tools", "psqlToFile"))
        }
    }

    #[napi(js_name = "pgDumpToRegisteredOutput", catch_unwind)]
    pub fn pg_dump_to_registered_output(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        registration: u32,
    ) -> Result<NativeToolSummary> {
        #[cfg(feature = "tools")]
        {
            let writers = take_tool_output(registration)?;
            let options = PgDumpOptions::new().args(args).assets(tool_assets(assets));
            let output = self.invoke_core(&env, "stream WASIX pg_dump", |database| {
                database.pg_dump_to_writer(options, writers.stdout, writers.stderr)
            })?;
            native_tool_summary(&env, "stream WASIX pg_dump", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, registration);
            Err(missing_release_feature("tools", "pgDumpToRegisteredOutput"))
        }
    }

    #[napi(js_name = "psqlToRegisteredOutput", catch_unwind)]
    pub fn psql_to_registered_output(
        &mut self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        registration: u32,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<NativeToolSummary> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let writers = take_tool_output(registration)?;
            let options = psql_options(args, command, script).assets(tool_assets(assets));
            let output = self.invoke_core(&env, "stream WASIX psql", |database| {
                database.psql_to_writer(options, writers.stdout, writers.stderr)
            })?;
            native_tool_summary(&env, "stream WASIX psql", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, registration, command, script);
            Err(missing_release_feature("tools", "psqlToRegisteredOutput"))
        }
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self, env: Env) -> Result<()> {
        self.invoke(&env, "close WASIX direct database", Oliphaunt::close)
    }
}

#[derive(Default)]
struct StreamEnvironment {
    alive: AtomicBool,
    active: Mutex<Vec<Arc<StreamAck>>>,
}

impl StreamEnvironment {
    fn new() -> Self {
        Self {
            alive: AtomicBool::new(true),
            active: Mutex::new(Vec::new()),
        }
    }

    fn activate(&self, ack: Arc<StreamAck>) -> Result<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "stream state lock poisoned"))?;
        if !self.alive.load(Ordering::Acquire) {
            return Err(Error::new(
                Status::Closing,
                "JavaScript environment is closing",
            ));
        }
        active.push(ack);
        Ok(())
    }

    fn deactivate(&self, ack: &Arc<StreamAck>) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        active.retain(|current| !Arc::ptr_eq(current, ack));
    }

    fn shutdown(&self) {
        let active = {
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.alive.store(false, Ordering::Release);
            std::mem::take(&mut *active)
        };
        for active in active {
            active.complete(Err(Error::new(
                Status::Closing,
                "JavaScript environment closed during streaming",
            )));
        }
    }
}

#[cfg(feature = "tools")]
struct JsToolWriter<F>(F);

#[cfg(feature = "tools")]
impl<F: FnMut(&[u8]) -> std::io::Result<()>> std::io::Write for JsToolWriter<F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        (self.0)(bytes)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(feature = "tools")]
struct ToolChunk {
    bytes: Vec<u8>,
    ack: Arc<StreamAck>,
}

#[cfg(feature = "tools")]
fn js_tool_writer(
    callback: Function<'_, Object<'static>, ()>,
    environment: Arc<StreamEnvironment>,
) -> Result<impl std::io::Write + Send + 'static> {
    let threadsafe = callback
        .build_threadsafe_function::<ToolChunk>()
        .max_queue_size::<1>()
        .build_callback(|context: ThreadsafeCallContext<ToolChunk>| {
            let mut packet = Object::new(&context.env)?;
            packet
                .set_named_property("chunk", v8_owned_bytes(&context.env, &context.value.bytes)?)?;
            let ack = context.value.ack;
            let acknowledge = context
                .env
                .create_function_from_closure::<Option<String>, (), _>(
                    "acknowledge",
                    move |context| {
                        let result = (if context.length() == 0 {
                            Ok(None)
                        } else {
                            context.get::<Option<String>>(0)
                        })
                        .and_then(|failure| {
                            failure.map_or(Ok(()), |message| {
                                Err(Error::new(Status::GenericFailure, message))
                            })
                        });
                        ack.complete(result);
                        Ok(())
                    },
                )?;
            packet.set_named_property("acknowledge", acknowledge)?;
            Ok(static_object(&context.env, packet))
        })?;
    Ok(JsToolWriter(move |bytes: &[u8]| {
        let ack = Arc::new(StreamAck::default());
        environment
            .activate(Arc::clone(&ack))
            .map_err(std::io::Error::other)?;
        let callback_ack = Arc::clone(&ack);
        let status = threadsafe.call_with_return_value(
            ToolChunk {
                bytes: bytes.to_vec(),
                ack: Arc::clone(&ack),
            },
            ThreadsafeFunctionCallMode::Blocking,
            move |result, _env| {
                // Returning a Promise is not destination credit. Only the
                // explicit acknowledgement after its write releases this wait.
                if let Err(error) = result {
                    callback_ack.complete(Err(error));
                }
                Ok(())
            },
        );
        if status != Status::Ok {
            ack.complete(Err(Error::new(
                status,
                "queue tool output on the JavaScript thread",
            )));
        }
        let result = ack.wait();
        environment.deactivate(&ack);
        result.map_err(std::io::Error::other)
    }))
}

// Output callbacks belong to the responsive parent realm. A same-process
// Worker consumes the writers once while keeping its synchronous database.
#[cfg(feature = "tools")]
struct RegisteredToolOutput {
    environment_key: usize,
    environment: Arc<StreamEnvironment>,
    writers: Option<ToolOutputWriters>,
}

#[cfg(feature = "tools")]
struct ToolOutputWriters {
    stdout: Box<dyn std::io::Write + Send>,
    stderr: Option<Box<dyn std::io::Write + Send>>,
}

#[cfg(feature = "tools")]
#[derive(Default)]
struct ToolOutputRegistry {
    outputs: BTreeMap<u32, RegisteredToolOutput>,
    environments: BTreeSet<usize>,
}

#[cfg(feature = "tools")]
fn tool_output_registry() -> &'static Mutex<ToolOutputRegistry> {
    static REGISTRY: OnceLock<Mutex<ToolOutputRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(ToolOutputRegistry::default()))
}

#[cfg(feature = "tools")]
fn release_tool_output(id: u32) {
    let output = tool_output_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .outputs
        .remove(&id);
    if let Some(output) = output {
        output.environment.shutdown();
    }
}

#[cfg(feature = "tools")]
fn release_tool_environment(environment_key: usize) {
    let outputs = {
        let mut registry = tool_output_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.environments.remove(&environment_key);
        registry
            .outputs
            .extract_if(.., |_, output| output.environment_key == environment_key)
            .map(|(_, output)| output)
            .collect::<Vec<_>>()
    };
    for output in outputs {
        output.environment.shutdown();
    }
}

#[cfg(feature = "tools")]
fn take_tool_output(id: u32) -> Result<ToolOutputWriters> {
    tool_output_registry()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "tool output registry lock poisoned"))?
        .outputs
        .get_mut(&id)
        .and_then(|output| output.writers.take())
        .ok_or_else(|| invalid_argument("tool output registration is closed or already consumed"))
}

/// Private, one-shot output handoff between same-process JavaScript realms.
#[cfg(feature = "tools")]
#[napi(custom_finalize)]
pub struct NativeWasixToolOutput {
    id: u32,
}

#[cfg(feature = "tools")]
impl ObjectFinalize for NativeWasixToolOutput {}

#[cfg(feature = "tools")]
impl Drop for NativeWasixToolOutput {
    fn drop(&mut self) {
        release_tool_output(self.id);
    }
}

#[cfg(feature = "tools")]
#[napi]
impl NativeWasixToolOutput {
    #[napi(factory, catch_unwind)]
    pub fn open(env: Env, destination: Object<'_>) -> Result<Self> {
        static NEXT_ID: AtomicU32 = AtomicU32::new(1);
        let id = NEXT_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| Error::new(Status::GenericFailure, "tool output identifiers exhausted"))?;
        let environment = Arc::new(StreamEnvironment::new());
        let stdout = js_tool_writer(
            destination.get_named_property("stdout")?,
            Arc::clone(&environment),
        )?;
        let stderr = destination
            .get_named_property::<Option<Function<'_, Object<'static>, ()>>>("stderr")?
            .map(|callback| js_tool_writer(callback, Arc::clone(&environment)))
            .transpose()?
            .map(|writer| Box::new(writer) as Box<dyn std::io::Write + Send>);
        let environment_key = env.raw() as usize;
        let mut registry = tool_output_registry().lock().map_err(|_| {
            Error::new(Status::GenericFailure, "tool output registry lock poisoned")
        })?;
        // Keep one cleanup hook per environment, rather than retaining one
        // hook and its callback state for every completed tool invocation.
        if !registry.environments.contains(&environment_key) {
            env.add_env_cleanup_hook(environment_key, release_tool_environment)?;
            registry.environments.insert(environment_key);
        }
        registry.outputs.insert(
            id,
            RegisteredToolOutput {
                environment_key,
                environment,
                writers: Some(ToolOutputWriters {
                    stdout: Box::new(stdout),
                    stderr,
                }),
            },
        );
        Ok(Self { id })
    }

    #[napi(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    #[napi(catch_unwind)]
    pub fn close(&self) {
        release_tool_output(self.id);
    }
}

#[derive(Default)]
struct StreamAck {
    result: Mutex<Option<Result<()>>>,
    ready: Condvar,
}

impl StreamAck {
    fn complete(&self, result: Result<()>) {
        let mut slot = self
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if slot.is_none() {
            *slot = Some(result);
            self.ready.notify_one();
        }
    }

    fn wait(&self) -> Result<()> {
        let mut slot = self.result.lock().map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "stream acknowledgement lock poisoned",
            )
        })?;
        while slot.is_none() {
            slot = self.ready.wait(slot).map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "stream acknowledgement lock poisoned",
                )
            })?;
        }
        slot.take().expect("stream acknowledgement is present")
    }
}

/// Promise-facing database which directly owns one `AsyncOliphaunt` actor.
#[napi(custom_finalize)]
pub struct NativeWasixActorDatabase {
    database: AsyncOliphaunt,
    stream_environment: Arc<StreamEnvironment>,
}

impl NativeWasixActorDatabase {
    fn attach(env: &Env, database: AsyncOliphaunt) -> Result<Self> {
        let stream_environment = Arc::new(StreamEnvironment::new());
        let cleanup_environment = Arc::clone(&stream_environment);
        let _cleanup = env.add_env_cleanup_hook(cleanup_environment, |environment| {
            environment.shutdown();
        })?;
        Ok(Self {
            database,
            stream_environment,
        })
    }
}

/// Promise-facing local wire server backed by the existing Rust server owner.
#[napi(custom_finalize)]
pub struct NativeWasixServer {
    server: AsyncOliphauntServer,
}

impl ObjectFinalize for NativeWasixServer {}

#[napi]
impl NativeWasixServer {
    #[napi(catch_unwind, ts_return_type = "Promise<NativeWasixServer>")]
    pub fn open(env: Env, mut options: NativeServerOpenOptions) -> Result<Object<'static>> {
        snapshot_resources(&mut options.seed, &mut options.icu_data);
        let (deferred, promise) = env.create_deferred()?;
        AsyncOliphauntServerBuilder::start_configured_with_completion(
            move || configure_async_server(options).map_err(|error| error.reason),
            move |result| {
                deferred.resolve(move |env| {
                    result
                        .map(|server| Self { server })
                        .map_err(|error| native_runtime_error(&env, "open WASIX server", error))
                });
            },
        );
        Ok(static_object(&env, promise))
    }

    #[napi(getter, js_name = "connectionString", catch_unwind)]
    pub fn connection_string(&self) -> String {
        self.server.connection_string().to_owned()
    }

    #[napi(getter, catch_unwind)]
    pub fn closed(&self) -> bool {
        self.server.is_closed()
    }

    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn close(&self, env: Env) -> Result<Object<'static>> {
        let server = self.server.clone();
        let (deferred, promise) = env.create_deferred()?;
        server.close_with_completion(move |result| {
            deferred.resolve(move |env| {
                result.map_err(|error| native_runtime_error(&env, "close WASIX server", error))
            });
        });
        Ok(static_object(&env, promise))
    }
}

#[napi(js_name = "restore", catch_unwind, ts_return_type = "Promise<void>")]
pub fn restore_database(
    env: Env,
    destination: String,
    backup: Uint8ArraySlice<'_>,
) -> Result<Object<'static>> {
    let destination = PathBuf::from(destination);
    let backup = backup.as_ref().to_vec();
    let (deferred, promise) = env.create_deferred()?;
    AsyncOliphaunt::restore_with_completion(destination, backup, move |result| {
        deferred.resolve(move |env| {
            result.map_err(|error| native_runtime_error(&env, "restore WASIX database", error))
        });
    });
    Ok(static_object(&env, promise))
}

#[napi(js_name = "restoreDirect", catch_unwind)]
pub fn restore_database_direct(
    env: Env,
    destination: String,
    backup: Uint8ArraySlice<'_>,
) -> Result<()> {
    retain_addon_image_for_process_runtime();
    Oliphaunt::restore(PathBuf::from(destination), backup.as_ref())
        .map_err(|error| native_runtime_error(&env, "restore WASIX database", error))
}

#[napi(js_name = "addonAbiVersion", catch_unwind)]
pub fn addon_abi_version() -> u32 {
    ADDON_ABI_VERSION
}

#[napi(js_name = "nodeApiVersion", catch_unwind)]
pub fn node_api_version() -> u32 {
    NODE_API_VERSION
}

#[napi(js_name = "runtimeVersion", catch_unwind)]
pub fn runtime_version() -> &'static str {
    RUNTIME_VERSION
}

#[napi(js_name = "supportedProfiles", catch_unwind)]
pub fn supported_profiles() -> Vec<&'static str> {
    vec!["standard", "icu"]
}

#[napi(js_name = "payloadIdentity", catch_unwind)]
pub fn payload_identity(component: String) -> Result<String> {
    let manifest = embedded_portable_manifest()?;
    match component.as_str() {
        "runtimeArchive" => embedded_identity(
            "runtime archive",
            liboliphaunt_wasix_portable::runtime_archive(),
            &manifest.runtime.sha256,
        ),
        _ => Err(invalid_argument(format!(
            "unsupported WASIX payload component {component:?}"
        ))),
    }
}

#[napi(js_name = "extensionIdentity", catch_unwind)]
pub fn extension_identity(sql_name: String) -> Result<String> {
    #[cfg(feature = "extensions")]
    {
        let bytes = liboliphaunt_wasix_portable::extension_archive(&sql_name).ok_or_else(|| {
            invalid_argument(format!(
                "WASIX extension {sql_name:?} is not embedded in this addon"
            ))
        })?;
        let sha256 = liboliphaunt_wasix_portable::expected_extension_archive_sha256(&sql_name)
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    format!("WASIX extension {sql_name:?} has no embedded SHA-256 identity"),
                )
            })?;
        Ok(format!("{sha256}:{}", bytes.len()))
    }
    #[cfg(not(feature = "extensions"))]
    {
        let _ = sql_name;
        Err(missing_release_feature("extensions", "extensionIdentity"))
    }
}

fn configure_direct_database(options: NativeOpenOptions) -> Result<OliphauntBuilder> {
    let NativeOpenOptions {
        admission,
        profile,
        storage,
        username,
        database,
        startup_gucs,
        extensions,
        extension_packages,
        seed,
        icu_data,
    } = options;
    if admission.is_some() {
        return Err(invalid_argument(
            "direct native sessions have no admission queue",
        ));
    }
    let mut builder = Oliphaunt::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs);
    if let Some(seed) = seed {
        builder = builder.seed(ClusterSeed::new(
            seed.archive.to_vec(),
            seed.manifest.as_ref(),
        ));
    }
    if let Some(icu) = icu_data {
        let data = IcuData::new(icu.data.to_vec(), icu.manifest.as_ref())
            .map_err(|error| invalid_argument(format!("invalid ICU data: {error}")))?;
        builder = builder.icu_data(data);
    }
    builder = apply_direct_extensions(builder, extensions, extension_packages.unwrap_or_default())?;
    Ok(builder)
}

fn configure_actor_database(options: NativeOpenOptions) -> Result<AsyncOliphauntBuilder> {
    let NativeOpenOptions {
        admission,
        profile,
        storage,
        username,
        database,
        startup_gucs,
        extensions,
        extension_packages,
        seed,
        icu_data,
    } = options;
    let mut builder = AsyncOliphaunt::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs);
    if let Some(admission) = admission {
        builder = builder.admission(resolve_admission(&admission)?);
    }
    if let Some(seed) = seed {
        builder = builder.seed(ClusterSeed::new(
            seed.archive.to_vec(),
            seed.manifest.as_ref(),
        ));
    }
    if let Some(icu) = icu_data {
        let data = IcuData::new(icu.data.to_vec(), icu.manifest.as_ref())
            .map_err(|error| invalid_argument(format!("invalid ICU data: {error}")))?;
        builder = builder.icu_data(data);
    }
    builder = apply_async_extensions(builder, extensions, extension_packages.unwrap_or_default())?;
    Ok(builder)
}

fn configure_async_server(options: NativeServerOpenOptions) -> Result<AsyncOliphauntServerBuilder> {
    let NativeServerOpenOptions {
        profile,
        storage,
        username,
        database,
        startup_gucs,
        extensions,
        extension_packages,
        seed,
        icu_data,
        listen,
    } = options;
    let mut builder = AsyncOliphauntServer::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs)
        .listen(resolve_listen(listen)?);
    if let Some(seed) = seed {
        builder = builder.seed(ClusterSeed::new(
            seed.archive.to_vec(),
            seed.manifest.as_ref(),
        ));
    }
    if let Some(icu) = icu_data {
        let data = IcuData::new(icu.data.to_vec(), icu.manifest.as_ref())
            .map_err(|error| invalid_argument(format!("invalid ICU data: {error}")))?;
        builder = builder.icu_data(data);
    }
    builder = apply_server_extensions(builder, extensions, extension_packages.unwrap_or_default())?;
    Ok(builder)
}

fn resolve_profile(profile: &str) -> Result<CatalogProfile> {
    match profile {
        "standard" => Ok(CatalogProfile::Standard),
        "icu" => Ok(CatalogProfile::Icu),
        value => Err(invalid_argument(format!(
            "unsupported WASIX profile {value:?}; expected \"standard\" or \"icu\""
        ))),
    }
}

fn resolve_storage(storage: NativeStorageOptions) -> Result<DatabaseStorage> {
    match storage.kind.as_str() {
        "memory" => {
            if storage.path.is_some() {
                return Err(invalid_argument("memory storage must not include path"));
            }
            Ok(DatabaseStorage::Memory)
        }
        "directory" => {
            let path = storage
                .path
                .filter(|path| !path.is_empty())
                .ok_or_else(|| invalid_argument("directory storage requires a non-empty path"))?;
            Ok(DatabaseStorage::Directory(PathBuf::from(path)))
        }
        kind => Err(invalid_argument(format!(
            "unsupported WASIX storage kind {kind:?}; expected \"memory\" or \"directory\""
        ))),
    }
}

fn resolve_listen(listen: NativeListenOptions) -> Result<ServerListen> {
    let port = listen.port.map(resolve_port).transpose()?;
    match listen.transport.as_str() {
        "tcp" => {
            if listen.directory.is_some() {
                return Err(invalid_argument(
                    "TCP listen options must not include directory",
                ));
            }
            Ok(port.map_or_else(ServerListen::tcp, ServerListen::tcp_port))
        }
        "unix" => {
            #[cfg(unix)]
            {
                let path = listen
                    .directory
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| {
                        invalid_argument("Unix listen options require a non-empty directory")
                    })?;
                Ok(match port {
                    Some(port) => ServerListen::unix_port(path, port),
                    None => ServerListen::unix(path),
                })
            }
            #[cfg(not(unix))]
            {
                let _ = (listen.directory, port);
                Err(invalid_argument(
                    "Unix-domain WASIX server listeners are not supported on Windows",
                ))
            }
        }
        kind => Err(invalid_argument(format!(
            "unsupported WASIX server transport {kind:?}; expected \"tcp\" or \"unix\""
        ))),
    }
}

fn resolve_port(port: u32) -> Result<u16> {
    u16::try_from(port)
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| invalid_argument("server port must be in the range 1..=65535"))
}

#[cfg(feature = "extensions")]
fn resolve_extensions(
    names: Vec<String>,
    packages: Vec<NativeExtensionPackage>,
) -> Result<Vec<Extension>> {
    let mut selected = BTreeMap::new();
    for package in packages {
        if !names.contains(&package.sql_name) || selected.contains_key(&package.sql_name) {
            return Err(invalid_argument(
                "duplicate or unselected extension package",
            ));
        }
        selected.insert(package.sql_name.clone(), extension_package::load(package)?);
    }
    names
        .into_iter()
        .map(|name| {
            selected
                .remove(&name)
                .or_else(|| Extension::by_sql_name(&name))
                .ok_or_else(|| invalid_argument(format!("unknown WASIX extension {name:?}")))
        })
        .collect()
}

fn apply_direct_extensions(
    builder: OliphauntBuilder,
    names: Vec<String>,
    packages: Vec<NativeExtensionPackage>,
) -> Result<OliphauntBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names, packages)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() && packages.is_empty() {
            Ok(builder)
        } else {
            Err(missing_release_feature("extensions", "open"))
        }
    }
}

fn apply_async_extensions(
    builder: AsyncOliphauntBuilder,
    names: Vec<String>,
    packages: Vec<NativeExtensionPackage>,
) -> Result<AsyncOliphauntBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names, packages)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() && packages.is_empty() {
            Ok(builder)
        } else {
            Err(missing_release_feature("extensions", "open"))
        }
    }
}

fn apply_server_extensions(
    builder: AsyncOliphauntServerBuilder,
    names: Vec<String>,
    packages: Vec<NativeExtensionPackage>,
) -> Result<AsyncOliphauntServerBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names, packages)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() && packages.is_empty() {
            Ok(builder)
        } else {
            Err(missing_release_feature("extensions", "server open"))
        }
    }
}

#[cfg(feature = "tools")]
fn psql_options(args: Vec<String>, command: Option<String>, script: Option<String>) -> PsqlOptions {
    let mut options = PsqlOptions::new().args(args);
    if let Some(command) = command {
        options = options.command(command);
    }
    if let Some(script) = script {
        options = options.script(script);
    }
    options
}

fn static_object(env: &Env, object: Object<'_>) -> Object<'static> {
    // `Object` is a copyable local N-API handle; its Rust lifetime only ties it
    // to the current handle scope. The value is returned immediately to N-API
    // and is never retained in Rust under this widened marker lifetime.
    Object::from_raw(env.raw(), object.raw())
}

fn v8_owned_bytes(env: &Env, bytes: &[u8]) -> Result<Uint8Array> {
    // napi-rs allocates here but does not initialize the new
    // ArrayBuffer from `bytes`; fill the V8-owned allocation explicitly.
    let mut output = Uint8ArraySlice::copy_from(env, bytes)?;
    // SAFETY: the new ArrayBuffer is not observable by JavaScript until this
    // function returns, and its allocation has exactly `bytes.len()` elements.
    unsafe { output.as_mut() }.copy_from_slice(bytes);
    output.into_typed_array(env)
}

#[cfg(feature = "tools")]
fn native_tool_result(
    env: &Env,
    operation: &'static str,
    result: oliphaunt_wasix::Result<PostgresToolOutput>,
) -> Result<NativeToolResult> {
    match result {
        Ok(output) => {
            let (stdout, stderr) = output.into_parts();
            Ok(NativeToolResult {
                status: 0,
                stdout: v8_owned_bytes(env, &stdout)?,
                stderr: v8_owned_bytes(env, &stderr)?,
            })
        }
        Err(error) => {
            if let Some(tool) = error.tool_error()
                && let Some(status) = tool.exit_code()
            {
                if status == 0 {
                    return Err(native_tool_error(env, operation, tool));
                }
                return Ok(NativeToolResult {
                    status,
                    stdout: v8_owned_bytes(env, tool.stdout_bytes())?,
                    stderr: v8_owned_bytes(env, tool.stderr_bytes())?,
                });
            }
            Err(native_runtime_error(env, operation, error))
        }
    }
}

#[cfg(feature = "tools")]
fn native_tool_summary(
    env: &Env,
    operation: &'static str,
    result: oliphaunt_wasix::Result<PostgresToolSummary>,
) -> Result<NativeToolSummary> {
    match result {
        Ok(output) => Ok(NativeToolSummary {
            stdout_bytes: output.stdout_bytes as f64,
            stderr: output.stderr,
            stderr_truncated: output.stderr_truncated,
        }),
        Err(error) => match error.tool_error() {
            Some(tool) => Err(native_tool_error(env, operation, tool)),
            None => Err(native_runtime_error(env, operation, error)),
        },
    }
}

fn invalid_argument(reason: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, reason.into())
}

#[cfg(any(not(feature = "tools"), not(feature = "extensions")))]
fn missing_release_feature(feature: &str, operation: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("WASIX N-API {operation} requires an addon built with the {feature} feature"),
    )
}

fn native_runtime_error(
    env: &Env,
    operation: &'static str,
    error: oliphaunt_wasix::Error,
) -> Error {
    if error.kind() == ErrorKind::Storage
        && let Some(details) = error.storage_error()
    {
        return native_storage_error(
            env,
            operation,
            &error,
            details.code(),
            details.commit_state(),
            details.phase(),
        );
    }
    let (marker, code) = match error.kind() {
        ErrorKind::InvalidConfiguration => ("configuration", "invalid-configuration"),
        ErrorKind::Lifecycle => ("lifecycle", "lifecycle"),
        ErrorKind::TransactionActive => ("transaction", "transaction-active"),
        ErrorKind::Postgres => ("postgres", "postgres-error"),
        ErrorKind::Storage => ("runtime", "unclassified-storage-error"),
        ErrorKind::Other => ("runtime", "runtime-error"),
        _ => ("runtime", "runtime-error"),
    };
    native_tagged_error(
        env,
        "OliphauntWasixError",
        marker,
        code,
        operation,
        format!("{operation}: {error}"),
    )
}

fn native_lifecycle_error(env: &Env, operation: &'static str, reason: &'static str) -> Error {
    native_tagged_error(
        env,
        "OliphauntWasixError",
        "lifecycle",
        "lifecycle",
        operation,
        format!("{operation}: {reason}"),
    )
}

fn native_tagged_error(
    env: &Env,
    name: &'static str,
    marker: &'static str,
    code: &'static str,
    operation: &'static str,
    reason: String,
) -> Error {
    let tagged = (|| -> Result<Error> {
        let mut object = env.create_error(Error::new(Status::GenericFailure, reason.clone()))?;
        object.set_named_property("name", name)?;
        object.set_named_property("oliphauntWasixError", marker)?;
        object.set_named_property("oliphauntWasixAddonAbi", ADDON_ABI_VERSION)?;
        object.set_named_property("code", code)?;
        object.set_named_property("operation", operation)?;
        Ok(Error::from_unknown_without_coercion(
            object.into_unknown(env)?,
        ))
    })();
    tagged.unwrap_or_else(|tag_error| {
        Error::new(
            Status::GenericFailure,
            format!("{reason}; construct structured native error: {tag_error}"),
        )
    })
}

fn native_storage_error(
    env: &Env,
    operation: &'static str,
    error: &oliphaunt_wasix::Error,
    code: StorageErrorCode,
    commit_state: StorageCommitState,
    phase: StorageErrorPhase,
) -> Error {
    let reason = format!("{operation}: {error}");
    let tagged = (|| -> Result<Error> {
        let mut object = env.create_error(Error::new(Status::GenericFailure, reason.clone()))?;
        object.set_named_property("name", "OliphauntWasixStorageError")?;
        object.set_named_property("oliphauntWasixError", "storage")?;
        object.set_named_property("oliphauntWasixAddonAbi", ADDON_ABI_VERSION)?;
        object.set_named_property("code", storage_code(code))?;
        object.set_named_property("commitState", storage_commit_state(commit_state))?;
        object.set_named_property("phase", storage_phase(phase))?;
        object.set_named_property("operation", operation)?;
        Ok(Error::from_unknown_without_coercion(
            object.into_unknown(env)?,
        ))
    })();
    tagged.unwrap_or_else(|tag_error| {
        Error::new(
            Status::GenericFailure,
            format!("{reason}; construct structured storage error: {tag_error}"),
        )
    })
}

#[cfg(feature = "tools")]
fn native_tool_error(
    env: &Env,
    operation: &'static str,
    tool: &oliphaunt_wasix::tools::PostgresToolError,
) -> Error {
    let reason = format!("{operation}: {tool}");
    let tagged = (|| -> Result<Error> {
        let mut object = env.create_error(Error::new(Status::GenericFailure, reason.clone()))?;
        object.set_named_property("name", "OliphauntWasixToolError")?;
        object.set_named_property("oliphauntWasixError", "tool")?;
        object.set_named_property("oliphauntWasixAddonAbi", ADDON_ABI_VERSION)?;
        object.set_named_property("code", "tool-error")?;
        object.set_named_property("operation", operation)?;
        object.set_named_property("tool", tool.tool())?;
        object.set_named_property("exitCode", tool.exit_code())?;
        object.set_named_property("stdout", v8_owned_bytes(env, tool.stdout_bytes())?)?;
        object.set_named_property("stderr", v8_owned_bytes(env, tool.stderr_bytes())?)?;
        object.set_named_property("stderrTruncated", tool.stderr_truncated())?;
        Ok(Error::from_unknown_without_coercion(
            object.into_unknown(env)?,
        ))
    })();
    tagged.unwrap_or_else(|tag_error| {
        Error::new(
            Status::GenericFailure,
            format!("{reason}; construct structured tool error: {tag_error}"),
        )
    })
}

fn storage_code(code: StorageErrorCode) -> &'static str {
    match code {
        StorageErrorCode::Busy => "busy",
        StorageErrorCode::Corrupt => "corrupt",
        StorageErrorCode::Incomplete => "incomplete",
        StorageErrorCode::Incompatible => "incompatible",
        StorageErrorCode::PublicationFailed => "publication-failed",
        StorageErrorCode::Unavailable => "unavailable",
        _ => "unavailable",
    }
}

fn storage_commit_state(state: StorageCommitState) -> &'static str {
    match state {
        StorageCommitState::NotPersisted => "not-persisted",
        StorageCommitState::Persisted => "persisted",
        StorageCommitState::Unchanged => "unchanged",
        StorageCommitState::Unknown => "unknown",
        _ => "unknown",
    }
}

fn storage_phase(phase: StorageErrorPhase) -> &'static str {
    match phase {
        StorageErrorPhase::Ownership => "ownership",
        StorageErrorPhase::Open => "open",
        StorageErrorPhase::OpenPublication => "open-publication",
        StorageErrorPhase::Operation => "operation",
        StorageErrorPhase::Backup => "backup",
        StorageErrorPhase::Close => "close",
        StorageErrorPhase::RestoreValidation => "restore-validation",
        StorageErrorPhase::RestoreStaging => "restore-staging",
        StorageErrorPhase::RestorePublication => "restore-publication",
        StorageErrorPhase::RestoreDurability => "restore-durability",
        _ => "operation",
    }
}

fn embedded_portable_manifest() -> Result<&'static liboliphaunt_wasix_portable::AssetManifest> {
    static MANIFEST: OnceLock<
        std::result::Result<liboliphaunt_wasix_portable::AssetManifest, String>,
    > = OnceLock::new();
    match MANIFEST
        .get_or_init(|| liboliphaunt_wasix_portable::manifest().map_err(|error| error.to_string()))
    {
        Ok(manifest) => Ok(manifest),
        Err(error) => Err(Error::new(
            Status::GenericFailure,
            format!("parse embedded WASIX payload manifest: {error}"),
        )),
    }
}

fn embedded_identity(label: &str, bytes: Option<&[u8]>, sha256: &str) -> Result<String> {
    let bytes = bytes.ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("WASIX {label} is not embedded in this addon"),
        )
    })?;
    Ok(format!("{sha256}:{}", bytes.len()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn admission_boundary_rejects_fractional_zero_and_overflow_before_snapshotting() {
        for value in [
            0.0,
            -1.0,
            1.5,
            f64::NAN,
            f64::INFINITY,
            u32::MAX as f64 + 1.0,
        ] {
            assert!(
                super::resolve_admission(&super::NativeAdmissionOptions {
                    max_pending_operations: value,
                    high_water_mark_bytes: 8.0
                })
                .is_err()
            );
            assert!(
                super::resolve_admission(&super::NativeAdmissionOptions {
                    max_pending_operations: 1.0,
                    high_water_mark_bytes: value
                })
                .is_err()
            );
        }
        assert_eq!(
            super::resolve_admission(&super::NativeAdmissionOptions {
                max_pending_operations: 1.0,
                high_water_mark_bytes: 8.0
            })
            .unwrap(),
            oliphaunt_wasix::AdmissionLimits::new(1, 8)
        );
    }

    #[test]
    fn environment_shutdown_releases_both_output_waiters() {
        let environment = super::StreamEnvironment::new();
        let stdout = std::sync::Arc::new(super::StreamAck::default());
        let stderr = std::sync::Arc::new(super::StreamAck::default());
        environment
            .activate(std::sync::Arc::clone(&stdout))
            .unwrap();
        environment
            .activate(std::sync::Arc::clone(&stderr))
            .unwrap();
        environment.shutdown();
        assert!(stdout.wait().is_err());
        assert!(stderr.wait().is_err());
        assert!(
            environment
                .activate(std::sync::Arc::new(super::StreamAck::default()))
                .is_err()
        );
    }

    #[test]
    fn acknowledging_stdout_does_not_remove_stderr_waiter() {
        let environment = super::StreamEnvironment::new();
        let stdout = std::sync::Arc::new(super::StreamAck::default());
        let stderr = std::sync::Arc::new(super::StreamAck::default());
        environment
            .activate(std::sync::Arc::clone(&stdout))
            .unwrap();
        environment
            .activate(std::sync::Arc::clone(&stderr))
            .unwrap();
        stdout.complete(Ok(()));
        environment.deactivate(&stdout);
        assert!(stdout.wait().is_ok());
        environment.shutdown();
        assert!(stderr.wait().is_err());
    }

    use std::sync::atomic::AtomicUsize;

    use super::*;

    struct DropCounter {
        drops: Arc<AtomicUsize>,
        closed: bool,
    }

    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn environment_finalizer_drops_closed_and_quarantines_open_owners() {
        let drops = Arc::new(AtomicUsize::new(0));
        let mut open = Some(DropCounter {
            drops: Arc::clone(&drops),
            closed: false,
        });
        drop_if_closed_or_quarantine(&mut open, |value| value.closed);
        assert!(open.is_none());
        assert_eq!(drops.load(Ordering::SeqCst), 0);

        let mut closed = Some(DropCounter {
            drops: Arc::clone(&drops),
            closed: true,
        });
        drop_if_closed_or_quarantine(&mut closed, |value| value.closed);
        assert!(closed.is_none());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn profile_selection_is_explicit() {
        assert_eq!(
            resolve_profile("standard").unwrap(),
            CatalogProfile::Standard
        );
        assert_eq!(resolve_profile("icu").unwrap(), CatalogProfile::Icu);
        assert!(resolve_profile("default").is_err());
    }

    #[test]
    fn directory_storage_requires_path() {
        let error = resolve_storage(NativeStorageOptions {
            kind: "directory".to_owned(),
            path: None,
        })
        .unwrap_err();
        assert!(error.reason.contains("requires a non-empty path"));
    }

    #[test]
    fn explicit_zero_port_is_rejected() {
        let error = resolve_port(0).unwrap_err();
        assert!(error.reason.contains("1..=65535"));
    }
}

// Dropping these fields never joins the owner thread. AsyncOliphaunt's final
// Arc sends its existing best-effort Shutdown control and returns immediately.
impl ObjectFinalize for NativeWasixActorDatabase {}

#[napi]
impl NativeWasixActorDatabase {
    #[napi(catch_unwind, ts_return_type = "Promise<NativeWasixActorDatabase>")]
    pub fn open(env: Env, mut options: NativeOpenOptions) -> Result<Object<'static>> {
        if let Some(admission) = &options.admission {
            resolve_admission(admission)?;
        }
        snapshot_resources(&mut options.seed, &mut options.icu_data);
        let (deferred, promise) = env.create_deferred()?;
        AsyncOliphauntBuilder::open_configured_with_completion(
            move || configure_actor_database(options).map_err(|error| error.reason),
            move |result| {
                deferred.resolve(move |env| {
                    let database = result.map_err(|error| {
                        native_runtime_error(&env, "open WASIX actor database", error)
                    })?;
                    Self::attach(&env, database)
                });
            },
        );
        Ok(static_object(&env, promise))
    }

    #[napi(getter, catch_unwind)]
    pub fn closed(&self) -> bool {
        self.database.is_closed()
    }

    #[napi(
        js_name = "execProtocolRaw",
        catch_unwind,
        ts_return_type = "Promise<Uint8Array>"
    )]
    pub fn exec_protocol_raw(
        &self,
        env: Env,
        request: Uint8ArraySlice<'_>,
    ) -> Result<Object<'static>> {
        let request = request.as_ref().to_vec();
        let database = self.database.clone();
        let (deferred, promise) = env.create_deferred()?;
        database.exec_protocol_raw_with_completion(request, move |result| {
            deferred.resolve(move |env| {
                let response = result.map_err(|error| {
                    native_runtime_error(&env, "execute PostgreSQL protocol request", error)
                })?;
                v8_owned_bytes(&env, &response)
            });
        });
        Ok(static_object(&env, promise))
    }

    #[napi(
        js_name = "execProtocolRawStream",
        catch_unwind,
        ts_return_type = "Promise<'complete' | 'callbackAborted'>"
    )]
    pub fn exec_protocol_raw_stream(
        &self,
        env: Env,
        request: Uint8ArraySlice<'_>,
        on_chunk: Function<'_, Uint8Array, ()>,
    ) -> Result<Object<'static>> {
        let request = request.as_ref().to_vec();
        let stream_environment = Arc::clone(&self.stream_environment);
        let callback_environment = Arc::clone(&stream_environment);
        let threadsafe = on_chunk
            .build_threadsafe_function::<Vec<u8>>()
            .max_queue_size::<1>()
            .build_callback(|context: ThreadsafeCallContext<Vec<u8>>| {
                v8_owned_bytes(&context.env, &context.value)
            })?;
        let database = self.database.clone();
        let (deferred, promise) = env.create_deferred()?;
        database.exec_protocol_raw_stream_with_completion(
            request,
            move |chunk| {
                let ack = Arc::new(StreamAck::default());
                callback_environment.activate(Arc::clone(&ack))?;
                let callback_ack = Arc::clone(&ack);
                let status = threadsafe.call_with_return_value(
                    chunk.to_vec(),
                    ThreadsafeFunctionCallMode::Blocking,
                    move |result, _env| {
                        callback_ack.complete(result.map(|_| ()));
                        Ok(())
                    },
                );
                if status != Status::Ok {
                    ack.complete(Err(Error::new(
                        status,
                        "queue protocol chunk on the JavaScript thread",
                    )));
                }
                let result = ack.wait();
                callback_environment.deactivate(&ack);
                result
            },
            move |result| {
                deferred.resolve(move |env| match result {
                    Ok(()) => Ok("complete"),
                    Err(RawStreamError::Callback(_)) => Ok("callbackAborted"),
                    Err(RawStreamError::Database(error)) => Err(native_runtime_error(
                        &env,
                        "stream PostgreSQL protocol response",
                        error,
                    )),
                    Err(RawStreamError::CallbackPanicked(error)) => Err(native_runtime_error(
                        &env,
                        "stream PostgreSQL protocol callback",
                        error,
                    )),
                    Err(_) => Err(Error::new(
                        Status::GenericFailure,
                        "stream PostgreSQL protocol response: unknown stream error",
                    )),
                });
            },
        );
        Ok(static_object(&env, promise))
    }

    #[napi(catch_unwind, ts_return_type = "Promise<Uint8Array>")]
    pub fn backup(&self, env: Env) -> Result<Object<'static>> {
        let database = self.database.clone();
        let (deferred, promise) = env.create_deferred()?;
        database.backup_with_completion(move |result| {
            deferred.resolve(move |env| {
                let backup = result
                    .map_err(|error| native_runtime_error(&env, "back up WASIX database", error))?;
                v8_owned_bytes(&env, &backup)
            });
        });
        Ok(static_object(&env, promise))
    }

    #[napi(
        js_name = "pgDump",
        catch_unwind,
        ts_return_type = "Promise<NativeToolResult>"
    )]
    pub fn pg_dump(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
    ) -> Result<Object<'static>> {
        #[cfg(feature = "tools")]
        {
            let database = self.database.clone();
            let (deferred, promise) = env.create_deferred()?;
            database.pg_dump_output_with_completion(
                PgDumpOptions::new().args(args).assets(tool_assets(assets)),
                move |result| {
                    deferred
                        .resolve(move |env| native_tool_result(&env, "run WASIX pg_dump", result));
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets);
            Err(missing_release_feature("tools", "pgDump"))
        }
    }

    #[napi(catch_unwind, ts_return_type = "Promise<NativeToolResult>")]
    pub fn psql(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<Object<'static>> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let database = self.database.clone();
            let (deferred, promise) = env.create_deferred()?;
            database.psql_output_with_completion(
                psql_options(args, command, script).assets(tool_assets(assets)),
                move |result| {
                    deferred.resolve(move |env| native_tool_result(&env, "run WASIX psql", result));
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, command, script);
            Err(missing_release_feature("tools", "psql"))
        }
    }

    #[napi(
        js_name = "pgDumpToFile",
        catch_unwind,
        ts_return_type = "Promise<NativeToolSummary>"
    )]
    pub fn pg_dump_to_file(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: String,
    ) -> Result<Object<'static>> {
        #[cfg(feature = "tools")]
        {
            let database = self.database.clone();
            let (deferred, promise) = env.create_deferred()?;
            database.pg_dump_to_file_with_completion(
                PgDumpOptions::new().args(args).assets(tool_assets(assets)),
                PathBuf::from(destination),
                move |result| {
                    deferred.resolve(move |env| {
                        native_tool_summary(&env, "write WASIX pg_dump file", result)
                    });
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination);
            Err(missing_release_feature("tools", "pgDumpToFile"))
        }
    }

    #[napi(
        js_name = "psqlToFile",
        catch_unwind,
        ts_return_type = "Promise<NativeToolSummary>"
    )]
    pub fn psql_to_file(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: String,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<Object<'static>> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let database = self.database.clone();
            let (deferred, promise) = env.create_deferred()?;
            database.psql_to_file_with_completion(
                psql_options(args, command, script).assets(tool_assets(assets)),
                PathBuf::from(destination),
                move |result| {
                    deferred.resolve(move |env| {
                        native_tool_summary(&env, "write WASIX psql file", result)
                    });
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination, command, script);
            Err(missing_release_feature("tools", "psqlToFile"))
        }
    }

    #[napi(
        js_name = "pgDumpToStream",
        catch_unwind,
        ts_return_type = "Promise<NativeToolSummary>"
    )]
    pub fn pg_dump_to_stream(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: Object<'_>,
    ) -> Result<Object<'static>> {
        #[cfg(feature = "tools")]
        {
            let writer = js_tool_writer(
                destination.get_named_property("stdout")?,
                Arc::clone(&self.stream_environment),
            )?;
            let stderr = destination
                .get_named_property::<Option<Function<'_, Object<'static>, ()>>>("stderr")?;
            let diagnostics = stderr
                .map(|callback| js_tool_writer(callback, Arc::clone(&self.stream_environment)))
                .transpose()?
                .map(|writer| Box::new(writer) as Box<dyn std::io::Write + Send>);
            let (deferred, promise) = env.create_deferred()?;
            self.database.pg_dump_to_writer_with_completion(
                PgDumpOptions::new().args(args).assets(tool_assets(assets)),
                writer,
                diagnostics,
                move |result| {
                    deferred.resolve(move |env| {
                        native_tool_summary(&env, "stream WASIX pg_dump", result)
                    });
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination);
            Err(missing_release_feature("tools", "pgDumpToStream"))
        }
    }

    #[napi(
        js_name = "psqlToStream",
        catch_unwind,
        ts_return_type = "Promise<NativeToolSummary>"
    )]
    pub fn psql_to_stream(
        &self,
        env: Env,
        args: Vec<String>,
        assets: NativeToolAssets,
        destination: Object<'_>,
        command: Option<String>,
        script: Option<String>,
    ) -> Result<Object<'static>> {
        if command.is_some() && script.is_some() {
            return Err(invalid_argument(
                "psql accepts either command or script, not both",
            ));
        }
        #[cfg(feature = "tools")]
        {
            let writer = js_tool_writer(
                destination.get_named_property("stdout")?,
                Arc::clone(&self.stream_environment),
            )?;
            let stderr = destination
                .get_named_property::<Option<Function<'_, Object<'static>, ()>>>("stderr")?;
            let diagnostics = stderr
                .map(|callback| js_tool_writer(callback, Arc::clone(&self.stream_environment)))
                .transpose()?
                .map(|writer| Box::new(writer) as Box<dyn std::io::Write + Send>);
            let (deferred, promise) = env.create_deferred()?;
            self.database.psql_to_writer_with_completion(
                psql_options(args, command, script).assets(tool_assets(assets)),
                writer,
                diagnostics,
                move |result| {
                    deferred
                        .resolve(move |env| native_tool_summary(&env, "stream WASIX psql", result));
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, assets, destination, command, script);
            Err(missing_release_feature("tools", "psqlToStream"))
        }
    }

    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn close(&self, env: Env) -> Result<Object<'static>> {
        let database = self.database.clone();
        let (deferred, promise) = env.create_deferred()?;
        database.close_with_completion(move |result| {
            deferred.resolve(move |env| {
                result.map_err(|error| {
                    native_runtime_error(&env, "close WASIX actor database", error)
                })
            });
        });
        Ok(static_object(&env, promise))
    }
}
