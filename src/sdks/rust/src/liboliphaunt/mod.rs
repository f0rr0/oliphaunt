use std::ffi::CString;
#[cfg(feature = "broker-helper")]
use std::ffi::c_char;
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

mod ffi;
mod root;

pub(crate) use self::root::{PreparedNativeRoot, configure_native_tool_env, native_root_key};

use self::ffi::{
    ABI_VERSION, CONFIG_EXTERNAL_ROOT_LOCK, NativeConfig, NativeHandle, NativeResponse,
    NativeRestoreOptions, NativeSymbols, path_to_cstring,
};
use crate::config::{EngineMode, OpenConfig};
use crate::engine::{EngineCancel, EngineSession, NativeRuntime};
use crate::error::{Error, Result};
use crate::extension::{Extension, required_shared_preload_libraries};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::DatabaseStorage;

static DIRECT_INSTANCE_ACTIVE: AtomicBool = AtomicBool::new(false);
static DIRECT_RESIDENT_ROOT: OnceLock<Mutex<Option<DirectResidentRoot>>> = OnceLock::new();

/// Runtime implementation backed by the native PostgreSQL `liboliphaunt` C ABI.
#[derive(Debug, Clone, Default)]
pub struct OliphauntRuntime;

/// Materialized native inputs consumed only by Oliphaunt's unpublished
/// packaging tool.
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePackagingResources {
    /// Fully materialized PostgreSQL runtime directory.
    pub runtime_dir: PathBuf,
    /// Fully initialized PostgreSQL cluster seed directory.
    pub cluster_seed: PathBuf,
    /// Content key for the runtime directory.
    pub runtime_cache_key: String,
    /// Content key for the PostgreSQL cluster seed directory.
    pub cluster_seed_cache_key: String,
}

/// Physical runtime layout requested by unpublished native packaging tools.
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePackagingRuntime {
    /// In-process and broker products share the embedded layout.
    Embedded,
    /// The local PostgreSQL server layout.
    PostgresServer,
}

/// PostgreSQL catalog profile requested by unpublished native packaging tools.
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePackagingCatalogProfile {
    /// Cluster initialized without the optional ICU data carrier.
    Standard,
    /// Cluster initialized with the exact optional ICU data carrier.
    Icu,
}

/// Materialize the exact native inputs used by the unpublished packaging tool.
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
pub fn materialize_native_packaging_resources(
    runtime: NativePackagingRuntime,
    extensions: &[Extension],
    catalog_profile: NativePackagingCatalogProfile,
) -> Result<NativePackagingResources> {
    let mode = match runtime {
        NativePackagingRuntime::Embedded => EngineMode::Direct,
        NativePackagingRuntime::PostgresServer => EngineMode::Server,
    };
    let catalog_profile = match catalog_profile {
        NativePackagingCatalogProfile::Standard => root::NativeCatalogProfile::Standard,
        NativePackagingCatalogProfile::Icu => root::NativeCatalogProfile::Icu,
    };
    let resources =
        root::materialize_native_resources_for_runtime(mode, extensions, catalog_profile)?;
    Ok(NativePackagingResources {
        runtime_dir: resources.runtime_dir,
        cluster_seed: resources.cluster_seed,
        runtime_cache_key: resources.runtime_cache_key,
        cluster_seed_cache_key: resources.cluster_seed_cache_key,
    })
}

impl OliphauntRuntime {
    /// Create a runtime that resolves the library path from the environment.
    pub fn from_env() -> Self {
        Self
    }

    pub(crate) fn restore(&self, destination: &std::path::Path, bytes: &[u8]) -> Result<()> {
        let symbols = NativeSymbols::load()?;
        let destination = path_to_cstring(destination, "restore destination")?;
        let options = NativeRestoreOptions {
            abi_version: ABI_VERSION,
            destination: destination.as_ptr(),
            data: if bytes.is_empty() {
                std::ptr::null()
            } else {
                bytes.as_ptr()
            },
            len: bytes.len(),
        };
        let rc = unsafe { (symbols.restore)(&options) };
        if rc != 0 {
            let message = symbols
                .last_error_text(std::ptr::null_mut())
                .unwrap_or_else(|| format!("oliphaunt_restore failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt restore failed: {message}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectResidentKey {
    requested_root_key: Option<PathBuf>,
    actual_root_key: PathBuf,
    username: String,
    database: String,
    startup_args: Vec<String>,
    selected_extensions: Vec<Extension>,
}

impl DirectResidentKey {
    fn requested(
        config: &OpenConfig,
        extensions: &[Extension],
        startup_args: Vec<String>,
    ) -> Result<Self> {
        let requested_root_key = match &config.storage {
            DatabaseStorage::Directory(root) => Some(native_root_key(root)?),
            DatabaseStorage::TemporaryDirectory => None,
        };
        Ok(Self {
            actual_root_key: requested_root_key.clone().unwrap_or_default(),
            requested_root_key,
            username: config.username.clone(),
            database: config.database.clone(),
            startup_args,
            selected_extensions: extensions.to_vec(),
        })
    }

    fn bind_actual_root(mut self, root: &PreparedNativeRoot) -> Result<Self> {
        self.actual_root_key = root.root_key()?;
        Ok(self)
    }

    fn matches_storage(&self, requested: &Self) -> bool {
        match (&self.requested_root_key, &requested.requested_root_key) {
            (None, None) => true,
            (_, Some(requested_root)) => requested_root == &self.actual_root_key,
            (Some(_), None) => false,
        }
    }

    fn matches_configuration(&self, requested: &Self) -> bool {
        self.matches_storage(requested)
            && self.username == requested.username
            && self.database == requested.database
            && self.startup_args == requested.startup_args
            && self.selected_extensions == requested.selected_extensions
    }
}

struct DirectResidentRoot {
    root: PreparedNativeRoot,
    key: DirectResidentKey,
    configuration_bound: bool,
}

impl NativeRuntime for OliphauntRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        debug_assert_eq!(config.mode, EngineMode::Direct);
        config.validate()?;
        let instance_lease = acquire_direct_instance_lease()?;
        let extensions = config.resolved_extensions()?;
        let startup_args = startup_arg_strings(&config, &extensions);
        let requested_key = DirectResidentKey::requested(&config, &extensions, startup_args)?;
        let symbols = Arc::new(NativeSymbols::load()?);
        let (root, configuration_bound) =
            take_or_prepare_direct_root(&config, &extensions, &requested_key)?;
        let resident_key = requested_key.bind_actual_root(&root)?;
        match OliphauntSession::open(
            symbols,
            root,
            config,
            &extensions,
            resident_key.clone(),
            instance_lease,
        ) {
            Ok(session) => Ok(Box::new(session)),
            Err(failure) => {
                let DirectOpenFailure {
                    root,
                    error,
                    native_open_attempted,
                } = *failure;
                if configuration_bound || native_open_attempted {
                    // Once oliphaunt_init has run, the process-resident backend may
                    // still own PGDATA even when it rejects the logical open.
                    // Keep both persistent and SDK-temporary storage available
                    // for a coherent retry instead of deleting or replacing it.
                    store_direct_resident_root(root, resident_key, configuration_bound)?;
                }
                Err(error)
            }
        }
    }
}

fn take_or_prepare_direct_root(
    config: &OpenConfig,
    extensions: &[Extension],
    requested_key: &DirectResidentKey,
) -> Result<(PreparedNativeRoot, bool)> {
    let slot = DIRECT_RESIDENT_ROOT.get_or_init(|| Mutex::new(None));
    let mut resident = slot
        .lock()
        .map_err(|_| Error::Engine("native direct resident root lock was poisoned".to_owned()))?;
    if let Some(existing) = resident.take() {
        let matches = if existing.configuration_bound {
            existing.key.matches_configuration(requested_key)
        } else {
            existing.key.matches_storage(requested_key)
        };
        if matches {
            return Ok((existing.root, existing.configuration_bound));
        }
        let bound_root = existing.key.actual_root_key.display().to_string();
        *resident = Some(existing);
        return Err(Error::Engine(format!(
            "native direct resident runtime is already bound to root {bound_root}; use .broker() or .open_server() for multiple roots in one process"
        )));
    }
    drop(resident);

    PreparedNativeRoot::prepare(config, extensions).map(|root| (root, false))
}

fn store_direct_resident_root(
    root: PreparedNativeRoot,
    key: DirectResidentKey,
    configuration_bound: bool,
) -> Result<()> {
    let slot = DIRECT_RESIDENT_ROOT.get_or_init(|| Mutex::new(None));
    let mut resident = slot
        .lock()
        .map_err(|_| Error::Engine("native direct resident root lock was poisoned".to_owned()))?;
    *resident = Some(DirectResidentRoot {
        root,
        key,
        configuration_bound,
    });
    Ok(())
}

fn acquire_direct_instance_lease() -> Result<DirectInstanceLease> {
    DIRECT_INSTANCE_ACTIVE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map(|_| DirectInstanceLease)
        .map_err(|_| {
            Error::Engine("native direct already has an active process-wide instance".to_owned())
        })
}

struct DirectInstanceLease;

impl Drop for DirectInstanceLease {
    fn drop(&mut self) {
        DIRECT_INSTANCE_ACTIVE.store(false, Ordering::Release);
    }
}

struct OliphauntSession {
    symbols: Arc<NativeSymbols>,
    handle: Arc<SharedNativeHandle>,
    cancel: Arc<OliphauntCancel>,
    root: Option<PreparedNativeRoot>,
    resident_key: DirectResidentKey,
    _lease: Option<DirectInstanceLease>,
}

struct DirectOpenFailure {
    root: PreparedNativeRoot,
    error: Error,
    native_open_attempted: bool,
}

impl DirectOpenFailure {
    fn before_native(root: PreparedNativeRoot, error: Error) -> Box<Self> {
        Box::new(Self {
            root,
            error,
            native_open_attempted: false,
        })
    }

    fn after_native(root: PreparedNativeRoot, error: Error) -> Box<Self> {
        Box::new(Self {
            root,
            error,
            native_open_attempted: true,
        })
    }
}

struct SharedNativeHandle {
    handle: RwLock<*mut NativeHandle>,
}

// SAFETY: The raw native handle is never accessed directly through shared
// references. All users first take the RwLock: executor-owned protocol/backup
// work holds a read lock, cancellation holds a read lock, and logical close
// takes the write lock, calls `oliphaunt_detach`, then replaces the pointer
// with null before releasing the process-wide direct-instance lease.
unsafe impl Send for SharedNativeHandle {}
// SAFETY: See the Send impl. The RwLock serializes pointer reads against close,
// so shared references can only observe either the still-open handle or null.
unsafe impl Sync for SharedNativeHandle {}

impl SharedNativeHandle {
    fn new(handle: *mut NativeHandle) -> Self {
        Self {
            handle: RwLock::new(handle),
        }
    }
}

struct OliphauntCancel {
    symbols: Arc<NativeSymbols>,
    handle: Arc<SharedNativeHandle>,
}

impl EngineCancel for OliphauntCancel {
    fn cancel(&self) -> Result<()> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let rc = unsafe { (self.symbols.cancel)(handle) };
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_cancel failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt cancel failed: {message}"
            )));
        }
        Ok(())
    }
}

impl OliphauntSession {
    fn open(
        symbols: Arc<NativeSymbols>,
        root: PreparedNativeRoot,
        config: OpenConfig,
        extensions: &[Extension],
        resident_key: DirectResidentKey,
        lease: DirectInstanceLease,
    ) -> std::result::Result<Self, Box<DirectOpenFailure>> {
        if let Err(error) = root.refresh_descriptor() {
            return Err(DirectOpenFailure::before_native(root, error));
        }
        let pgdata = match path_to_cstring(&root.pgdata, "PGDATA") {
            Ok(value) => value,
            Err(error) => return Err(DirectOpenFailure::before_native(root, error)),
        };
        let runtime_dir = match path_to_cstring(&root.runtime_dir, "runtime dir") {
            Ok(value) => value,
            Err(error) => return Err(DirectOpenFailure::before_native(root, error)),
        };
        let module_dir = match path_to_cstring(
            &root.runtime_dir.join("lib/postgresql"),
            "embedded module dir",
        ) {
            Ok(value) => value,
            Err(error) => return Err(DirectOpenFailure::before_native(root, error)),
        };
        let username = match CString::new(config.username.as_str()) {
            Ok(value) => value,
            Err(_) => {
                return Err(DirectOpenFailure::before_native(
                    root,
                    Error::InvalidConfig("username contains an interior NUL".to_owned()),
                ));
            }
        };
        let database = match CString::new(config.database.as_str()) {
            Ok(value) => value,
            Err(_) => {
                return Err(DirectOpenFailure::before_native(
                    root,
                    Error::InvalidConfig("database contains an interior NUL".to_owned()),
                ));
            }
        };
        let startup_args = match startup_args(&config, extensions) {
            Ok(value) => value,
            Err(error) => return Err(DirectOpenFailure::before_native(root, error)),
        };
        let startup_arg_ptrs = startup_args
            .iter()
            .map(|arg| arg.as_ptr())
            .collect::<Vec<_>>();
        let native_config = NativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime_dir.as_ptr(),
            module_dir: module_dir.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            reserved_flags: CONFIG_EXTERNAL_ROOT_LOCK,
            startup_args: startup_arg_ptrs.as_ptr(),
            startup_arg_count: startup_arg_ptrs.len(),
        };
        let mut handle = ptr::null_mut();
        let rc = unsafe { (symbols.init)(&native_config, &mut handle) };
        if rc != 0 || handle.is_null() {
            let message = symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_init failed with status {rc}"));
            return Err(DirectOpenFailure::after_native(
                root,
                Error::Engine(format!("native liboliphaunt init failed: {message}")),
            ));
        }

        let handle = Arc::new(SharedNativeHandle::new(handle));
        let cancel = Arc::new(OliphauntCancel {
            symbols: Arc::clone(&symbols),
            handle: Arc::clone(&handle),
        });

        Ok(Self {
            symbols,
            handle,
            cancel,
            root: Some(root),
            resident_key,
            _lease: Some(lease),
        })
    }

    fn close_handle(&mut self) -> Result<()> {
        let mut guard =
            self.handle.handle.write().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Ok(());
        }
        let rc = unsafe { (self.symbols.detach)(handle) };
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_detach failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt detach failed: {message}"
            )));
        }
        *guard = ptr::null_mut();
        if let Some(root) = self.root.take() {
            store_direct_resident_root(root, self.resident_key.clone(), true)?;
        }
        self._lease = None;
        Ok(())
    }

    fn bytes_from_native_response(&self, mut response: NativeResponse) -> Vec<u8> {
        let bytes = if response.data.is_null() {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(response.data, response.len).to_vec() }
        };
        unsafe { (self.symbols.free_response)(&mut response) };
        bytes
    }

    fn protocol_response_from_native(&self, response: NativeResponse) -> ProtocolResponse {
        let bytes = self.bytes_from_native_response(response);
        ProtocolResponse::new(bytes)
    }

    fn free_failed_response(&self, response: &mut NativeResponse) {
        if !response.data.is_null() {
            unsafe { (self.symbols.free_response)(response) };
        }
    }
}

impl EngineSession for OliphauntSession {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let bytes = request.as_bytes();
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let rc = unsafe {
            (self.symbols.exec_protocol)(handle, bytes.as_ptr(), bytes.len(), &mut response)
        };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = self
                .symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_exec_protocol failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt protocol execution failed: {message}"
            )));
        }
        if response.data.is_null() {
            return Ok(ProtocolResponse::new(Vec::new()));
        }
        Ok(self.protocol_response_from_native(response))
    }

    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }

        struct StreamContext<'a> {
            on_chunk: &'a mut dyn FnMut(&[u8]) -> Result<()>,
            error: Option<Error>,
        }

        unsafe extern "C" fn stream_callback(
            context: *mut std::ffi::c_void,
            data: *const std::ffi::c_uchar,
            len: usize,
        ) -> std::ffi::c_int {
            let context = unsafe { &mut *(context.cast::<StreamContext<'_>>()) };
            if data.is_null() && len > 0 {
                context.error = Some(Error::Engine(
                    "native liboliphaunt stream callback received null data".to_owned(),
                ));
                return -1;
            }
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(data, len) }
            };
            match (context.on_chunk)(bytes) {
                Ok(()) => 0,
                Err(error) => {
                    context.error = Some(error);
                    -1
                }
            }
        }

        let bytes = request.as_bytes();
        let mut context = StreamContext {
            on_chunk,
            error: None,
        };
        let rc = unsafe {
            (self.symbols.exec_protocol_stream)(
                handle,
                bytes.as_ptr(),
                bytes.len(),
                stream_callback,
                (&mut context as *mut StreamContext<'_>).cast(),
            )
        };
        if rc != 0 {
            if let Some(error) = context.error {
                return Err(error);
            }
            let message = self.symbols.last_error_text(handle).unwrap_or_else(|| {
                format!("oliphaunt_exec_protocol_stream failed with status {rc}")
            });
            return Err(Error::Engine(format!(
                "native liboliphaunt protocol stream failed: {message}"
            )));
        }
        Ok(())
    }

    #[cfg(feature = "broker-helper")]
    fn exec_simple_query(&mut self, sql: &str) -> Result<ProtocolResponse> {
        let Some(exec_simple_query) = self.symbols.exec_simple_query else {
            return self.exec_protocol_raw(ProtocolRequest::simple_query(sql)?);
        };
        if sql.as_bytes().contains(&0) {
            return Err(Error::InvalidConfig(
                "simple query contains an interior NUL byte".to_owned(),
            ));
        }
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let rc = unsafe {
            exec_simple_query(
                handle,
                sql.as_ptr().cast::<c_char>(),
                sql.len(),
                &mut response,
            )
        };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = self
                .symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_exec_simple_query failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt simple query failed: {message}"
            )));
        }
        Ok(self.protocol_response_from_native(response))
    }

    fn backup(&mut self) -> Result<Vec<u8>> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let rc = unsafe { (self.symbols.backup)(handle, &mut response) };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = self
                .symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_backup failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native liboliphaunt physical backup failed: {message}"
            )));
        }
        Ok(self.bytes_from_native_response(response))
    }

    fn close(&mut self) -> Result<()> {
        self.close_handle()
    }
}

impl Drop for OliphauntSession {
    fn drop(&mut self) {
        let _ = self.close_handle();
    }
}

fn startup_arg_strings(config: &OpenConfig, extensions: &[Extension]) -> Vec<String> {
    let mut args = Vec::new();
    for assignment in config.postgres_startup_assignments() {
        args.push("-c".to_owned());
        args.push(assignment);
    }
    let preload_libraries = required_shared_preload_libraries(extensions);
    if !preload_libraries.is_empty() {
        args.push("-c".to_owned());
        args.push(format!(
            "shared_preload_libraries={}",
            preload_libraries.join(",")
        ));
    }
    args
}

fn startup_args(config: &OpenConfig, extensions: &[Extension]) -> Result<Vec<CString>> {
    let args = startup_arg_strings(config, extensions);
    args.into_iter()
        .map(|arg| {
            CString::new(arg).map_err(|_| {
                Error::InvalidConfig("startup argument contains an interior NUL".to_owned())
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_temporary_storage_matches_the_process_resident_instance() {
        let key = DirectResidentKey {
            requested_root_key: None,
            actual_root_key: PathBuf::from("/tmp/oliphaunt-resident"),
            username: "postgres".to_owned(),
            database: "postgres".to_owned(),
            startup_args: Vec::new(),
            selected_extensions: Vec::new(),
        };
        let requested = DirectResidentKey {
            actual_root_key: PathBuf::new(),
            ..key.clone()
        };

        assert!(key.matches_storage(&requested));
        assert!(key.matches_configuration(&requested));
    }

    #[test]
    fn failed_direct_open_storage_can_retry_with_corrected_configuration() {
        let key = DirectResidentKey {
            requested_root_key: None,
            actual_root_key: PathBuf::from("/tmp/oliphaunt-failed-open"),
            username: "missing-role".to_owned(),
            database: "postgres".to_owned(),
            startup_args: Vec::new(),
            selected_extensions: Vec::new(),
        };
        let corrected = DirectResidentKey {
            requested_root_key: None,
            actual_root_key: PathBuf::new(),
            username: "postgres".to_owned(),
            database: "postgres".to_owned(),
            startup_args: Vec::new(),
            selected_extensions: Vec::new(),
        };

        assert!(key.matches_storage(&corrected));
        assert!(!key.matches_configuration(&corrected));
    }

    #[test]
    fn direct_startup_args_include_required_preload_libraries_before_init() {
        let mut config = OpenConfig::direct("target/test-roots/native-direct-preload");
        config.extensions = vec![Extension::PgTextsearch, Extension::PgTextsearch];
        let extensions = config.resolved_extensions().unwrap();
        let args = startup_args(&config, &extensions).unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(&args, "shared_preload_libraries=pg_textsearch");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "shared_preload_libraries=pg_textsearch")
                .count(),
            1,
            "preload libraries must be deduplicated before oliphaunt_init"
        );
    }

    #[test]
    fn direct_startup_args_omit_preload_when_selected_extensions_do_not_require_it() {
        let config = OpenConfig::direct("target/test-roots/native-direct-no-preload");
        let args = startup_args(&config, &[Extension::Vector]).unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("shared_preload_libraries=")),
            "direct startup args must not add preload settings for extensions that do not require them: {args:?}"
        );
    }

    #[test]
    fn invalid_startup_gucs_are_rejected_before_open() {
        let mut config = OpenConfig::direct("target/test-roots/native-direct-invalid-guc");
        config.startup_gucs = vec![crate::config::PostgresStartupGuc::new(
            "shared-buffers",
            "16MB",
        )];

        let error = config.validate().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("each dot-separated component must start"),
            "{error}"
        );
    }

    fn assert_startup_config_arg(args: &[String], expected: &str) {
        let Some(index) = args.iter().position(|arg| arg == expected) else {
            panic!("missing direct startup argument {expected:?} in {args:?}");
        };
        assert_eq!(
            args.get(index.saturating_sub(1)).map(String::as_str),
            Some("-c"),
            "direct startup argument {expected:?} must be passed through postgres -c"
        );
    }
}
