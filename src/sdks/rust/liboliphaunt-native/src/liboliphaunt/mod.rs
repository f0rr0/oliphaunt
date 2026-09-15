use std::ffi::CString;
use std::ffi::c_char;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

mod ffi;
pub mod root;

pub(crate) use self::root::{PreparedNativeRoot, native_root_key};

use self::ffi::{
    ABI_VERSION, CONFIG_EXTERNAL_ROOT_LOCK, NativeConfig as FfiNativeConfig, NativeErrorCapture,
    NativeHandle, NativeResponse, NativeRestoreOptions, NativeSymbols,
    STREAM_CALLBACK_ABORTED_STATUS, path_to_cstring,
};
use crate::config::NativeConfig as OpenConfig;
pub enum ProtocolStreamOutcome<E = Error> {
    ReadyForQuery(std::result::Result<(), E>),
    SessionStateUnknown(Error),
}
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::storage::DatabaseStorage;

static DIRECT_INSTANCE_ACTIVE: AtomicBool = AtomicBool::new(false);
static DIRECT_RESIDENT_ROOT: OnceLock<Mutex<Option<DirectResidentRoot>>> = OnceLock::new();

/// Materialized native inputs consumed only by Oliphaunt's unpublished
/// packaging tool.
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePackagingResources {
    /// Fully materialized PostgreSQL runtime directory.
    pub runtime_dir: PathBuf,
    /// Content key for the runtime directory.
    pub runtime_cache_key: String,
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
    extensions: &[Extension],
    catalog_profile: NativePackagingCatalogProfile,
) -> Result<NativePackagingResources> {
    let catalog_profile = match catalog_profile {
        NativePackagingCatalogProfile::Standard => root::NativeCatalogProfile::Standard,
        NativePackagingCatalogProfile::Icu => root::NativeCatalogProfile::Icu,
    };
    let resources = root::materialize_native_resources_for_runtime(
        root::NativeRuntimeProfile::OliphauntEmbedded,
        extensions,
        catalog_profile,
    )?;
    Ok(NativePackagingResources {
        runtime_dir: resources.runtime_dir,
        runtime_cache_key: resources.runtime_cache_key,
    })
}

impl NativeSession {
    /// Read the runtime version without opening a database or acquiring a session.
    pub fn version_from_library(path: &std::path::Path) -> Result<String> {
        let symbols = NativeSymbols::load_path(path)?;
        let version = unsafe { (symbols.version)() };
        if version.is_null() {
            return Err(Error::Engine(
                "native runtime returned a null version".into(),
            ));
        }
        Ok(unsafe { std::ffi::CStr::from_ptr(version) }
            .to_string_lossy()
            .into_owned())
    }

    pub fn restore(destination: &std::path::Path, bytes: &[u8]) -> Result<()> {
        Self::restore_with_symbols(NativeSymbols::load()?, destination, bytes)
    }

    pub fn restore_from_library(
        library: &std::path::Path,
        destination: &std::path::Path,
        bytes: &[u8],
    ) -> Result<()> {
        Self::restore_with_symbols(NativeSymbols::load_path(library)?, destination, bytes)
    }

    /// Restore using a runtime already linked into the current process.
    pub fn restore_from_current_process(destination: &std::path::Path, bytes: &[u8]) -> Result<()> {
        Self::restore_with_symbols(NativeSymbols::load_current_process()?, destination, bytes)
    }

    fn restore_with_symbols(
        symbols: NativeSymbols,
        destination: &std::path::Path,
        bytes: &[u8],
    ) -> Result<()> {
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
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe { (symbols.restore_with_error)(&options, &mut error) };
        if rc != 0 {
            let message = captured_native_error(&error, "oliphaunt_restore", rc);
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
    icu_data: Option<(crate::NativeResourceDirectory, String)>,
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
            icu_data: config
                .icu_data
                .as_ref()
                .map(|data| {
                    root::resources::validate_icu_data(data).map(|digest| (data.clone(), digest))
                })
                .transpose()?,
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
            && self.icu_data == requested.icu_data
    }
}

struct DirectResidentRoot {
    root: PreparedNativeRoot,
    key: DirectResidentKey,
    configuration_bound: bool,
}

impl NativeSession {
    pub fn open(config: OpenConfig) -> Result<Self> {
        config.validate()?;
        let instance_lease = acquire_direct_instance_lease()?;
        let extensions = config.resolved_extensions()?;
        let startup_args = startup_arg_strings(&config, &extensions);
        let requested_key = DirectResidentKey::requested(&config, &extensions, startup_args)?;
        let symbols = Arc::new(NativeSymbols::load()?);
        let (root, configuration_bound) =
            take_or_prepare_direct_root(&config, &extensions, &requested_key)?;
        let resident_key = requested_key.bind_actual_root(&root)?;
        match NativeSession::open_prepared(
            symbols,
            root,
            config,
            &extensions,
            resident_key.clone(),
            instance_lease,
        ) {
            Ok(session) => Ok(session),
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
            "native direct resident runtime is already bound to root {bound_root}; use .broker() or OliphauntServer::builder().start() for multiple roots in one process"
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
    let mut resident = match slot.lock() {
        Ok(resident) => resident,
        Err(_) => {
            std::mem::forget(root);
            return Err(Error::Engine(
                "native direct resident root lock was poisoned".into(),
            ));
        }
    };
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

pub struct NativeSession {
    symbols: Arc<NativeSymbols>,
    handle: Arc<SharedNativeHandle>,
    cancel: Arc<NativeCancel>,
    root: Option<PreparedNativeRoot>,
    resident_key: Option<DirectResidentKey>,
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
    generation: u64,
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

#[derive(Clone)]
pub struct NativeCancel {
    symbols: Arc<NativeSymbols>,
    handle: Arc<SharedNativeHandle>,
}

/// Concurrent input for an executing PostgreSQL protocol stream.
///
/// This keeps the native library and logical session alive, but does not keep a
/// detached session usable. Each feed must name the exact active stream token.
#[derive(Clone)]
pub struct NativeProtocolInput {
    _symbols: Arc<NativeSymbols>,
    handle: Arc<SharedNativeHandle>,
    token: ffi::StreamTokenFn,
    feed: ffi::FeedStreamFn,
}

impl NativeProtocolInput {
    /// Return the current stream token, or `None` while no stream is running.
    pub fn active_token(&self) -> Result<Option<u64>> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        if guard.is_null() {
            return Err(Error::EngineStopped);
        }
        let token = unsafe { (self.token)(*guard) };
        Ok((token != 0).then_some(token))
    }

    /// Supply complete frontend frames to the named stream.
    ///
    /// `false` means bounded native input storage is full: no bytes were
    /// accepted, and the caller may retry the same bytes. Errors, including a
    /// stale stream token, must not be retried against a newer stream.
    pub fn feed(&self, token: u64, request: &[u8]) -> Result<bool> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        if guard.is_null() {
            return Err(Error::EngineStopped);
        }
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe { (self.feed)(*guard, token, request.as_ptr(), request.len(), &mut error) };
        match rc {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(Error::Engine(captured_native_error(
                &error,
                "oliphaunt_feed_protocol_stream",
                rc,
            ))),
        }
    }
}

impl NativeCancel {
    pub fn cancel(&self) -> Result<()> {
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

impl NativeSession {
    fn open_prepared(
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
        let icu_data = match config
            .icu_data
            .as_ref()
            .map(|data| path_to_cstring(&data.directory, "ICU data directory"))
            .transpose()
        {
            Ok(value) => value,
            Err(error) => return Err(DirectOpenFailure::before_native(root, error)),
        };
        let startup_arg_ptrs = startup_args
            .iter()
            .map(|arg| arg.as_ptr())
            .collect::<Vec<_>>();
        let native_config = FfiNativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime_dir.as_ptr(),
            module_dir: module_dir.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            flags: CONFIG_EXTERNAL_ROOT_LOCK,
            startup_args: startup_arg_ptrs.as_ptr(),
            startup_arg_count: startup_arg_ptrs.len(),
            icu_data_dir: icu_data.as_ref().map_or(ptr::null(), |path| path.as_ptr()),
        };
        let handle = match init_handle(&symbols, &native_config) {
            Ok(handle) => handle,
            Err(error) => return Err(DirectOpenFailure::after_native(root, error)),
        };

        let handle = Arc::new(handle);
        let cancel = Arc::new(NativeCancel {
            symbols: Arc::clone(&symbols),
            handle: Arc::clone(&handle),
        });

        Ok(Self {
            symbols,
            handle,
            cancel,
            root: Some(root),
            resident_key: Some(resident_key),
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
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe { (self.symbols.detach_with_error)(handle, &mut error) };
        if rc != 0 {
            let message = captured_native_error(&error, "oliphaunt_detach", rc);
            return Err(Error::Engine(format!(
                "native liboliphaunt detach failed: {message}"
            )));
        }
        *guard = ptr::null_mut();
        if let Some(root) = self.root.take() {
            store_direct_resident_root(
                root,
                self.resident_key
                    .take()
                    .expect("prepared root has resident identity"),
                true,
            )?;
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

    fn free_failed_response(&self, response: &mut NativeResponse) {
        if !response.data.is_null() {
            unsafe { (self.symbols.free_response)(response) };
        }
    }
}

impl NativeSession {
    pub fn cancel_handle(&self) -> NativeCancel {
        (*self.cancel).clone()
    }

    /// Resolve the optional incremental-input capability before starting work.
    /// Existing complete-buffer operations do not require these ABI symbols.
    pub fn protocol_input(&self) -> Result<NativeProtocolInput> {
        let (token, feed) = self.symbols.stream_input_symbols()?;
        Ok(NativeProtocolInput {
            _symbols: Arc::clone(&self.symbols),
            handle: Arc::clone(&self.handle),
            token,
            feed,
        })
    }

    pub fn exec_protocol_raw(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        let guard =
            self.handle.handle.read().map_err(|_| {
                Error::Engine("native liboliphaunt handle lock poisoned".to_owned())
            })?;
        let handle = *guard;
        if handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let bytes = request;
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe {
            (self.symbols.exec_protocol_with_error)(
                handle,
                bytes.as_ptr(),
                bytes.len(),
                &mut response,
                &mut error,
            )
        };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = captured_native_error(&error, "oliphaunt_exec_protocol", rc);
            return Err(Error::Engine(format!(
                "native liboliphaunt protocol execution failed: {message}"
            )));
        }
        if response.data.is_null() {
            return Ok(Vec::new());
        }
        Ok(self.bytes_from_native_response(response))
    }

    pub fn exec_protocol_raw_stream<E: From<Error>>(
        &mut self,
        request: &[u8],
        on_chunk: &mut dyn FnMut(&[u8]) -> std::result::Result<(), E>,
    ) -> ProtocolStreamOutcome<E> {
        let guard = match self.handle.handle.read() {
            Ok(guard) => guard,
            Err(_) => {
                return ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(
                    "native liboliphaunt handle lock poisoned".to_owned(),
                ));
            }
        };
        let handle = *guard;
        if handle.is_null() {
            return ProtocolStreamOutcome::SessionStateUnknown(Error::EngineStopped);
        }

        let bytes = request;
        let mut context = StreamContext {
            on_chunk,
            error: None,
        };
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe {
            (self.symbols.exec_protocol_raw_stream_with_error)(
                handle,
                bytes.as_ptr(),
                bytes.len(),
                stream_callback::<E>,
                (&mut context as *mut StreamContext<'_, E>).cast(),
                &mut error,
            )
        };
        if rc == STREAM_CALLBACK_ABORTED_STATUS {
            return match context.error {
                Some(error) => ProtocolStreamOutcome::ReadyForQuery(Err(error.into_consumer_error())),
                None => ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(
                    "native liboliphaunt reported a recovered callback abort without a callback error"
                        .to_owned(),
                )),
            };
        }
        if rc != 0 {
            let message = captured_native_error(&error, "oliphaunt_exec_protocol_raw_stream", rc);
            // Every non-sentinel failure is independently authoritative: it
            // may have interrupted recovery and must not be masked by a
            // callback error (or by the original panic retained by the
            // blocking API).
            return ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(format!(
                "native liboliphaunt protocol stream failed: {message}"
            )));
        }
        if context.error.is_some() {
            return ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(
                "native liboliphaunt reported stream success after rejecting its callback"
                    .to_owned(),
            ));
        }
        ProtocolStreamOutcome::ReadyForQuery(Ok(()))
    }

    pub fn exec_simple_query(&mut self, sql: &str) -> Result<Vec<u8>> {
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
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe {
            (self.symbols.exec_simple_query_with_error)(
                handle,
                sql.as_ptr().cast::<c_char>(),
                sql.len(),
                &mut response,
                &mut error,
            )
        };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = captured_native_error(&error, "oliphaunt_exec_simple_query", rc);
            return Err(Error::Engine(format!(
                "native liboliphaunt simple query failed: {message}"
            )));
        }
        Ok(self.bytes_from_native_response(response))
    }

    pub fn backup(&mut self) -> Result<Vec<u8>> {
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
        let mut error = NativeErrorCapture::zeroed();
        let rc = unsafe { (self.symbols.backup_with_error)(handle, &mut response, &mut error) };
        if rc != 0 {
            self.free_failed_response(&mut response);
            let message = captured_native_error(&error, "oliphaunt_backup", rc);
            return Err(Error::Engine(format!(
                "native liboliphaunt physical backup failed: {message}"
            )));
        }
        Ok(self.bytes_from_native_response(response))
    }

    pub fn close(&mut self) -> Result<()> {
        self.close_handle()
    }
}

fn captured_native_error(
    capture: &NativeErrorCapture,
    operation: &str,
    status: std::ffi::c_int,
) -> String {
    capture
        .error_text()
        .unwrap_or_else(|| format!("{operation} failed with status {status}"))
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        if self.close_handle().is_err() {
            // Native teardown is unconfirmed. Keep storage and the process
            // lease alive rather than delete a database still owned by C.
            if let Some(root) = self.root.take() {
                std::mem::forget(root);
            }
            if let Some(lease) = self._lease.take() {
                std::mem::forget(lease);
            }
        }
    }
}

fn startup_arg_strings(config: &OpenConfig, extensions: &[Extension]) -> Vec<String> {
    let mut args = Vec::new();
    for assignment in config.postgres_startup_assignments(extensions) {
        args.push("-c".to_owned());
        args.push(assignment);
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
            icu_data: None,
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
            icu_data: None,
        };
        let corrected = DirectResidentKey {
            requested_root_key: None,
            actual_root_key: PathBuf::new(),
            username: "postgres".to_owned(),
            database: "postgres".to_owned(),
            startup_args: Vec::new(),
            selected_extensions: Vec::new(),
            icu_data: None,
        };

        assert!(key.matches_storage(&corrected));
        assert!(!key.matches_configuration(&corrected));
    }

    #[test]
    fn direct_startup_args_include_required_preload_libraries_before_init() {
        let mut config = OpenConfig::direct("target/test-roots/native-direct-preload");
        config.startup_gucs = vec![crate::config::PostgresStartupGuc::new(
            "shared_preload_libraries",
            "auto_explain, pg_textsearch",
        )];
        config.extensions = vec![Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH];
        let extensions = config.resolved_extensions().unwrap();
        let args = startup_args(&config, &extensions).unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(&args, "shared_preload_libraries=auto_explain,pg_textsearch");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("shared_preload_libraries="))
                .count(),
            1,
            "caller and extension preload libraries must be merged once before oliphaunt_init"
        );
    }

    #[test]
    fn direct_startup_args_omit_preload_when_selected_extensions_do_not_require_it() {
        let config = OpenConfig::direct("target/test-roots/native-direct-no-preload");
        let args = startup_args(&config, &[Extension::VECTOR]).unwrap();
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

/// Native inputs already prepared and owned by the host application.
pub struct NativeOpenOptions {
    /// Load this library, or resolve already linked/global symbols on Unix.
    pub library_path: Option<PathBuf>,
    pub pgdata: PathBuf,
    pub runtime_directory: Option<PathBuf>,
    pub module_directory: Option<PathBuf>,
    /// Explicit ICU data directory; independent of the host process environment.
    pub icu_data_directory: Option<PathBuf>,
    pub username: String,
    pub database: String,
    pub startup_args: Vec<String>,
}

impl NativeSession {
    /// Open host-prepared inputs without assembling or deleting their resources.
    /// The native library acquires the database root lock itself.
    pub fn open_prepared_inputs(options: NativeOpenOptions) -> Result<Self> {
        let lease = acquire_direct_instance_lease()?;
        let symbols = Arc::new(match &options.library_path {
            Some(path) => NativeSymbols::load_path(path)?,
            None => NativeSymbols::load_current_process()?,
        });
        let pgdata = path_to_cstring(&options.pgdata, "PGDATA")?;
        let runtime = options
            .runtime_directory
            .as_deref()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|p| path_to_cstring(p, "runtime directory"))
            .transpose()?;
        let modules = options
            .module_directory
            .as_deref()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|p| path_to_cstring(p, "module directory"))
            .transpose()?;
        let username = CString::new(options.username)
            .map_err(|_| Error::InvalidConfig("username contains an interior NUL".into()))?;
        let database = CString::new(options.database)
            .map_err(|_| Error::InvalidConfig("database contains an interior NUL".into()))?;
        let icu_data = options
            .icu_data_directory
            .as_deref()
            .map(|path| path_to_cstring(path, "ICU data directory"))
            .transpose()?;
        let args = options
            .startup_args
            .into_iter()
            .map(|arg| {
                CString::new(arg).map_err(|_| {
                    Error::InvalidConfig("startup argument contains an interior NUL".into())
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let arg_ptrs = args.iter().map(|arg| arg.as_ptr()).collect::<Vec<_>>();
        let config = FfiNativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime.as_ref().map_or(ptr::null(), |p| p.as_ptr()),
            module_dir: modules.as_ref().map_or(ptr::null(), |p| p.as_ptr()),
            username: username.as_ptr(),
            database: database.as_ptr(),
            flags: 0,
            startup_args: arg_ptrs.as_ptr(),
            startup_arg_count: arg_ptrs.len(),
            icu_data_dir: icu_data.as_ref().map_or(ptr::null(), |path| path.as_ptr()),
        };
        let handle = Arc::new(init_handle(&symbols, &config)?);
        let cancel = Arc::new(NativeCancel {
            symbols: symbols.clone(),
            handle: handle.clone(),
        });
        Ok(Self {
            symbols,
            handle,
            cancel,
            root: None,
            resident_key: None,
            _lease: Some(lease),
        })
    }
}

fn init_handle(symbols: &NativeSymbols, config: &FfiNativeConfig) -> Result<SharedNativeHandle> {
    symbols.register_selected_extensions()?;
    let mut handle = ptr::null_mut();
    let mut error = NativeErrorCapture::zeroed();
    let rc = unsafe { (symbols.init_with_error)(config, &mut handle, &mut error) };
    if rc != 0 || handle.is_null() {
        let message = error.error_text().unwrap_or_else(|| {
            if rc == 0 {
                "oliphaunt_init returned a null handle".to_owned()
            } else {
                format!("oliphaunt_init failed with status {rc}")
            }
        });
        return Err(Error::Engine(format!(
            "native liboliphaunt init failed: {message}"
        )));
    }
    let generation = unsafe { (symbols.logical_generation)(handle) };
    if generation == 0 {
        return Err(Error::Engine(
            "native session has no logical generation".into(),
        ));
    }
    Ok(SharedNativeHandle {
        generation,
        handle: RwLock::new(handle),
    })
}

impl NativeSession {
    /// Terminally close this native generation before releasing its root and
    /// process-wide instance lease. Hosts must first release any stream callback
    /// waiting for their event loop so active execution can finish.
    pub fn close_terminal(&mut self) -> Result<()> {
        if self.close_terminal_if_owned()? {
            Ok(())
        } else {
            Err(Error::Engine(
                "native session no longer owns terminal cleanup".into(),
            ))
        }
    }

    /// Close this generation, returning false if a newer owner has authority.
    /// Actual cleanup failures remain errors and retain the root and lease.
    pub fn close_terminal_if_owned(&mut self) -> Result<bool> {
        // A detached session no longer owns the Rust process lease. Do not
        // wait for or interrupt a newer active session or an in-progress open.
        let _detached_lease = if self._lease.is_none() {
            match acquire_direct_instance_lease() {
                Ok(lease) => Some(lease),
                Err(_) => return Ok(false),
            }
        } else {
            None
        };
        let mut guard = self
            .handle
            .handle
            .write()
            .map_err(|_| Error::Engine("native handle lock poisoned".into()))?;
        let status = unsafe { (self.symbols.close_if_generation)(self.handle.generation) };
        match status {
            0 => {}
            1 => return Ok(false),
            _ => {
                return Err(Error::Engine(format!(
                    "native generation cleanup failed with status {status}"
                )));
            }
        }
        *guard = ptr::null_mut();
        drop(guard);
        self.root = None;
        self.resident_key = None;
        if let Some(slot) = DIRECT_RESIDENT_ROOT.get() {
            // C has stopped. No Rust opener can race the detached lease held
            // above, so its retained temporary root can now be removed safely.
            if let Ok(mut resident) = slot.lock() {
                resident.take();
            }
        }
        self._lease = None;
        Ok(true)
    }
}

enum StreamCallbackFailure<E> {
    Consumer(E),
    Native(Error),
    Panic(Box<dyn std::any::Any + Send>),
}
impl<E: From<Error>> StreamCallbackFailure<E> {
    // Called only after the C function has confirmed recovery and returned.
    fn into_consumer_error(self) -> E {
        match self {
            Self::Consumer(error) => error,
            Self::Native(error) => error.into(),
            Self::Panic(payload) => std::panic::resume_unwind(payload),
        }
    }
}
struct StreamContext<'a, E> {
    on_chunk: &'a mut dyn FnMut(&[u8]) -> std::result::Result<(), E>,
    error: Option<StreamCallbackFailure<E>>,
}

unsafe extern "C" fn stream_callback<E: From<Error>>(
    context: *mut std::ffi::c_void,
    data: *const std::ffi::c_uchar,
    len: usize,
) -> std::ffi::c_int {
    let context = unsafe { &mut *(context.cast::<StreamContext<'_, E>>()) };
    if context.error.is_some() {
        return -1;
    }
    if data.is_null() && len > 0 {
        context.error = Some(StreamCallbackFailure::Native(Error::Engine(
            "native liboliphaunt stream callback received null data".to_owned(),
        )));
        return -1;
    }
    let bytes = if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data, len) }
    };
    match catch_unwind(AssertUnwindSafe(|| (context.on_chunk)(bytes))) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            context.error = Some(StreamCallbackFailure::Consumer(error));
            -1
        }
        Err(payload) => {
            context.error = Some(StreamCallbackFailure::Panic(payload));
            -1
        }
    }
}

#[cfg(test)]
mod callback_safety_tests {
    use super::*;

    struct ConsumerError(Arc<()>);
    impl From<Error> for ConsumerError {
        fn from(_: Error) -> Self {
            std::panic::panic_any("consumer conversion panicked");
        }
    }

    #[test]
    fn native_callback_error_conversion_cannot_unwind_through_c() {
        let mut callback = |_: &[u8]| Ok::<(), ConsumerError>(());
        let mut context = StreamContext {
            on_chunk: &mut callback,
            error: None,
        };
        assert_eq!(
            unsafe {
                stream_callback::<ConsumerError>(
                    (&mut context as *mut StreamContext<'_, ConsumerError>).cast(),
                    ptr::null(),
                    1,
                )
            },
            -1
        );
        let failure = context.error.take().unwrap();
        let panic = catch_unwind(AssertUnwindSafe(|| failure.into_consumer_error()));
        assert_eq!(
            panic.err().unwrap().downcast_ref::<&str>(),
            Some(&"consumer conversion panicked")
        );
    }

    #[test]
    fn callback_panic_payload_is_resumed_after_returning_from_c() {
        let original = Arc::new(());
        let payload = original.clone();
        let mut callback = move |_: &[u8]| -> std::result::Result<(), ConsumerError> {
            std::panic::panic_any(payload.clone())
        };
        let mut context = StreamContext {
            on_chunk: &mut callback,
            error: None,
        };
        assert_eq!(
            unsafe {
                stream_callback::<ConsumerError>(
                    (&mut context as *mut StreamContext<'_, ConsumerError>).cast(),
                    ptr::null(),
                    0,
                )
            },
            -1
        );
        let failure = context.error.take().unwrap();
        let panic = catch_unwind(AssertUnwindSafe(|| failure.into_consumer_error()));
        assert!(Arc::ptr_eq(
            &original,
            panic.err().unwrap().downcast_ref::<Arc<()>>().unwrap()
        ));
    }

    #[test]
    fn callback_error_identity_survives_additional_recovery_chunks() {
        let original = Arc::new(());
        let error = original.clone();
        let mut calls = 0;
        let mut callback = |_: &[u8]| {
            calls += 1;
            Err(ConsumerError(error.clone()))
        };
        let mut context = StreamContext {
            on_chunk: &mut callback,
            error: None,
        };
        for _ in 0..2 {
            assert_eq!(
                unsafe {
                    stream_callback::<ConsumerError>(
                        (&mut context as *mut StreamContext<'_, ConsumerError>).cast(),
                        ptr::null(),
                        0,
                    )
                },
                -1
            );
        }
        let error = context.error.take().unwrap().into_consumer_error();
        assert!(Arc::ptr_eq(&original, &error.0));
        assert_eq!(calls, 1);
    }
}
