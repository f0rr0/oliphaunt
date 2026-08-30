//! Node-API boundary for the Oliphaunt WASIX Rust runtime.
//!
//! `NativeWasixActorDatabase` and `NativeWasixServer` reuse the Rust async
//! owners directly. Promise settlement is the only owner-to-JavaScript hop;
//! no Tokio runtime or Node async-work queue participates in database work.

use std::collections::BTreeMap;
use std::mem;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
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
#[cfg(feature = "extensions")]
use oliphaunt_wasix::Extension;
#[cfg(feature = "tools")]
use oliphaunt_wasix::tools::{PgDumpOptions, PostgresToolOutput, PsqlOptions};
use oliphaunt_wasix::{
    AsyncOliphaunt, AsyncOliphauntBuilder, AsyncOliphauntServer, AsyncOliphauntServerBuilder,
    CatalogProfile, DatabaseStorage, ErrorKind, Oliphaunt, OliphauntBuilder, RawStreamError,
    ServerListen, StorageCommitState, StorageErrorCode, StorageErrorPhase,
};
use sha2::{Digest, Sha256};

const ADDON_ABI_VERSION: u32 = 1;
const NODE_API_VERSION: u32 = 8;
const RUNTIME_VERSION: &str = env!("OLIPHAUNT_WASIX_RUNTIME_VERSION");

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
pub struct NativeOpenOptions {
    pub profile: String,
    pub storage: NativeStorageOptions,
    pub username: String,
    pub database: String,
    #[napi(js_name = "startupGucs")]
    pub startup_gucs: BTreeMap<String, String>,
    pub extensions: Vec<String>,
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
    pub listen: NativeListenOptions,
}

#[napi(object)]
pub struct NativeToolResult {
    pub status: i32,
    pub stdout: Uint8Array,
    pub stderr: Uint8Array,
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
    pub fn pg_dump(&mut self, env: Env, args: Vec<String>) -> Result<NativeToolResult> {
        #[cfg(feature = "tools")]
        {
            let output = self.invoke_core(&env, "run WASIX pg_dump", |database| {
                database.pg_dump_output(PgDumpOptions::new().args(args))
            })?;
            native_tool_result(&env, "run WASIX pg_dump", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args);
            Err(missing_release_feature("tools", "pgDump"))
        }
    }

    #[napi(catch_unwind)]
    pub fn psql(
        &mut self,
        env: Env,
        args: Vec<String>,
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
            let options = psql_options(args, command, script);
            let output = self.invoke_core(&env, "run WASIX psql", |database| {
                database.psql_output(options)
            })?;
            native_tool_result(&env, "run WASIX psql", output)
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, command, script);
            Err(missing_release_feature("tools", "psql"))
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
    active: Mutex<Option<Arc<StreamAck>>>,
}

impl StreamEnvironment {
    fn new() -> Self {
        Self {
            alive: AtomicBool::new(true),
            active: Mutex::new(None),
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
        *active = Some(ack);
        Ok(())
    }

    fn deactivate(&self, ack: &Arc<StreamAck>) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, ack))
        {
            active.take();
        }
    }

    fn shutdown(&self) {
        let active = {
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.alive.store(false, Ordering::Release);
            active.take()
        };
        if let Some(active) = active {
            active.complete(Err(Error::new(
                Status::Closing,
                "JavaScript environment closed during protocol streaming",
            )));
        }
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
    pub fn open(env: Env, options: NativeServerOpenOptions) -> Result<Object<'static>> {
        let builder = configure_async_server(options)?;
        let (deferred, promise) = env.create_deferred()?;
        builder.start_with_completion(move |result| {
            deferred.resolve(move |env| {
                result
                    .map(|server| Self { server })
                    .map_err(|error| native_runtime_error(&env, "open WASIX server", error))
            });
        });
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
    static STANDARD_SEED_MANIFEST: OnceLock<String> = OnceLock::new();
    static ICU_SEED_MANIFEST: OnceLock<String> = OnceLock::new();
    let manifest = embedded_portable_manifest()?;
    match component.as_str() {
        "runtimeArchive" => embedded_identity(
            "runtime archive",
            liboliphaunt_wasix_portable::runtime_archive(),
            &manifest.runtime.sha256,
        ),
        "standardSeedArchive" => {
            let seed = embedded_seed(manifest, "standard")?;
            embedded_identity(
                "standard cluster seed archive",
                liboliphaunt_wasix_portable::standard_cluster_seed_archive(),
                &seed.sha256,
            )
        }
        "standardSeedManifest" => hashed_embedded_identity(
            "standard cluster seed manifest",
            liboliphaunt_wasix_portable::standard_cluster_seed_manifest(),
            &STANDARD_SEED_MANIFEST,
        ),
        "icuDataArchive" => embedded_identity(
            "ICU data archive",
            oliphaunt_icu::icu_data_archive(),
            oliphaunt_icu::ICU_DATA_ARCHIVE_SHA256.ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "WASIX ICU data archive has no embedded SHA-256 identity".to_owned(),
                )
            })?,
        ),
        "icuSeedArchive" => {
            let seed = embedded_seed(manifest, "icu")?;
            embedded_identity(
                "ICU cluster seed archive",
                liboliphaunt_wasix_portable::icu_cluster_seed_archive(),
                &seed.sha256,
            )
        }
        "icuSeedManifest" => hashed_embedded_identity(
            "ICU cluster seed manifest",
            liboliphaunt_wasix_portable::icu_cluster_seed_manifest(),
            &ICU_SEED_MANIFEST,
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

#[napi(js_name = "toolIdentity", catch_unwind)]
pub fn tool_identity(name: String) -> Result<String> {
    #[cfg(feature = "tools")]
    {
        static PG_DUMP: OnceLock<String> = OnceLock::new();
        static PSQL: OnceLock<String> = OnceLock::new();
        let (bytes, identity) = match name.as_str() {
            "pg_dump" => (oliphaunt_wasix_tools::pg_dump_wasm(), &PG_DUMP),
            "psql" => (oliphaunt_wasix_tools::psql_wasm(), &PSQL),
            _ => {
                return Err(invalid_argument(format!(
                    "unsupported WASIX tool {name:?}; expected \"pg_dump\" or \"psql\""
                )));
            }
        };
        hashed_embedded_identity(&format!("tool {name}"), bytes, identity)
    }
    #[cfg(not(feature = "tools"))]
    {
        let _ = name;
        Err(missing_release_feature("tools", "toolIdentity"))
    }
}

fn configure_direct_database(options: NativeOpenOptions) -> Result<OliphauntBuilder> {
    let NativeOpenOptions {
        profile,
        storage,
        username,
        database,
        startup_gucs,
        extensions,
    } = options;
    let mut builder = Oliphaunt::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs);
    builder = apply_direct_extensions(builder, extensions)?;
    Ok(builder)
}

fn configure_actor_database(options: NativeOpenOptions) -> Result<AsyncOliphauntBuilder> {
    let NativeOpenOptions {
        profile,
        storage,
        username,
        database,
        startup_gucs,
        extensions,
    } = options;
    let mut builder = AsyncOliphaunt::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs);
    builder = apply_async_extensions(builder, extensions)?;
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
        listen,
    } = options;
    let mut builder = AsyncOliphauntServer::builder()
        .storage(resolve_storage(storage)?)
        .catalog_profile(resolve_profile(&profile)?)
        .username(username)
        .database(database)
        .startup_gucs(startup_gucs)
        .listen(resolve_listen(listen)?);
    builder = apply_server_extensions(builder, extensions)?;
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
fn resolve_extensions(names: Vec<String>) -> Result<Vec<Extension>> {
    names
        .into_iter()
        .map(|name| {
            Extension::by_sql_name(&name).ok_or_else(|| {
                invalid_argument(format!(
                    "WASIX extension {name:?} is unknown or unavailable in this runtime"
                ))
            })
        })
        .collect()
}

fn apply_direct_extensions(
    builder: OliphauntBuilder,
    names: Vec<String>,
) -> Result<OliphauntBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() {
            Ok(builder)
        } else {
            Err(missing_release_feature("extensions", "open"))
        }
    }
}

fn apply_async_extensions(
    builder: AsyncOliphauntBuilder,
    names: Vec<String>,
) -> Result<AsyncOliphauntBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() {
            Ok(builder)
        } else {
            Err(missing_release_feature("extensions", "open"))
        }
    }
}

fn apply_server_extensions(
    builder: AsyncOliphauntServerBuilder,
    names: Vec<String>,
) -> Result<AsyncOliphauntServerBuilder> {
    #[cfg(feature = "extensions")]
    {
        Ok(builder.extensions(resolve_extensions(names)?))
    }
    #[cfg(not(feature = "extensions"))]
    {
        if names.is_empty() {
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
    // napi-rs 3.12.2 allocates here but does not initialize the new
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

fn embedded_seed<'a>(
    manifest: &'a liboliphaunt_wasix_portable::AssetManifest,
    profile: &str,
) -> Result<&'a liboliphaunt_wasix_portable::ClusterSeedAsset> {
    manifest.cluster_seeds.get(profile).ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("WASIX {profile} cluster seed is not embedded in this addon"),
        )
    })
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

fn hashed_embedded_identity(
    label: &str,
    bytes: Option<&[u8]>,
    identity: &'static OnceLock<String>,
) -> Result<String> {
    let bytes = bytes.ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("WASIX {label} is not embedded in this addon"),
        )
    })?;
    Ok(identity
        .get_or_init(|| {
            let sha256 = format!("{:x}", Sha256::digest(bytes));
            format!("{sha256}:{}", bytes.len())
        })
        .clone())
}

#[cfg(test)]
mod tests {
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
    pub fn open(env: Env, options: NativeOpenOptions) -> Result<Object<'static>> {
        let builder = configure_actor_database(options)?;
        let (deferred, promise) = env.create_deferred()?;
        builder.open_with_completion(move |result| {
            deferred.resolve(move |env| {
                let database = result.map_err(|error| {
                    native_runtime_error(&env, "open WASIX actor database", error)
                })?;
                Self::attach(&env, database)
            });
        });
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
    pub fn pg_dump(&self, env: Env, args: Vec<String>) -> Result<Object<'static>> {
        #[cfg(feature = "tools")]
        {
            let database = self.database.clone();
            let (deferred, promise) = env.create_deferred()?;
            database.pg_dump_output_with_completion(
                PgDumpOptions::new().args(args),
                move |result| {
                    deferred
                        .resolve(move |env| native_tool_result(&env, "run WASIX pg_dump", result));
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args);
            Err(missing_release_feature("tools", "pgDump"))
        }
    }

    #[napi(catch_unwind, ts_return_type = "Promise<NativeToolResult>")]
    pub fn psql(
        &self,
        env: Env,
        args: Vec<String>,
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
                psql_options(args, command, script),
                move |result| {
                    deferred.resolve(move |env| native_tool_result(&env, "run WASIX psql", result));
                },
            );
            Ok(static_object(&env, promise))
        }
        #[cfg(not(feature = "tools"))]
        {
            let _ = (env, args, command, script);
            Err(missing_release_feature("tools", "psql"))
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
