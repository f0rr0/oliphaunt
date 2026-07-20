use std::ffi::{CString, c_char};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

mod ffi;
mod root;

pub(crate) use self::root::{
    MaterializedNativeResources, materialize_native_resources_for_runtime,
};
pub(crate) use self::root::{
    NativeRootLock, PreparedNativeRoot, ROOT_MANIFEST_FILE as NATIVE_ROOT_MANIFEST_FILE,
    configure_native_tool_env, ensure_root_manifest as ensure_native_root_manifest,
    native_root_key, root_manifest_text as native_root_manifest_text,
    validate_root_manifest_text as validate_native_root_manifest_text,
};

use self::ffi::{
    ABI_VERSION, BACKUP_FORMAT_OLIPHAUNT_ARCHIVE, BACKUP_FORMAT_PHYSICAL_ARCHIVE,
    BACKUP_FORMAT_SQL, CAP_BACKUP_RESTORE, CAP_EXTENSIONS, CAP_LOGICAL_REOPEN, CAP_MULTI_INSTANCE,
    CAP_PROTOCOL_RAW, CAP_PROTOCOL_STREAM, CAP_QUERY_CANCEL, CAP_SERVER_MODE, CAP_SIMPLE_QUERY,
    NativeArchiveFile, NativeBackupOptions, NativeConfig, NativeHandle, NativeInitOptions,
    NativeResponse, NativeSymbols, path_to_cstring,
};
use crate::backup::{
    PHYSICAL_ARCHIVE_MANIFEST_PATH, annotate_physical_archive_backup,
    physical_archive_metadata_files,
};
use crate::config::{EngineMode, OpenConfig};
use crate::engine::{
    EngineCancel, EngineCapabilities, EngineSession, NativeRuntime, SessionConcurrency,
};
use crate::error::{Error, Result};
use crate::extension::{Extension, required_shared_preload_libraries};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::DatabaseRoot;
use crate::storage::{BackupArtifact, BackupFormat, BackupRequest};

static DIRECT_INSTANCE_ACTIVE: AtomicBool = AtomicBool::new(false);
static DIRECT_RESIDENT_ROOT: OnceLock<Mutex<Option<DirectResidentRoot>>> = OnceLock::new();

/// Source used to locate the native `liboliphaunt` dynamic library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OliphauntRuntimeSource {
    /// Resolve from `LIBOLIPHAUNT_PATH`, falling back to legacy
    /// native-spike environment variables during migration.
    Env,
    /// Load from an explicit path.
    Path(PathBuf),
}

/// Runtime implementation backed by the native PostgreSQL `liboliphaunt` C ABI.
#[derive(Debug, Clone)]
pub struct OliphauntRuntime {
    source: OliphauntRuntimeSource,
}

impl OliphauntRuntime {
    /// Create a runtime that resolves the library path from the environment.
    pub fn from_env() -> Self {
        Self {
            source: OliphauntRuntimeSource::Env,
        }
    }

    /// Create a runtime that loads a specific library path.
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self {
            source: OliphauntRuntimeSource::Path(path.into()),
        }
    }
}

impl Default for OliphauntRuntime {
    fn default() -> Self {
        Self::from_env()
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
        let requested_root_key = match &config.storage.root {
            DatabaseRoot::Path(root) => Some(native_root_key(root)?),
            DatabaseRoot::Temporary => None,
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

    fn matches_request(&self, requested: &Self) -> bool {
        requested
            .requested_root_key
            .as_ref()
            .is_some_and(|requested_root| requested_root == &self.actual_root_key)
            && self.username == requested.username
            && self.database == requested.database
            && self.startup_args == requested.startup_args
            && self.selected_extensions == requested.selected_extensions
    }
}

struct DirectResidentRoot {
    root: PreparedNativeRoot,
    key: DirectResidentKey,
}

impl NativeRuntime for OliphauntRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeDirect {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "the current liboliphaunt C ABI is an in-process direct engine; broker and true server modes need their own runtimes".to_owned(),
            });
        }
        config.validate()?;
        let instance_lease = acquire_direct_instance_lease()?;
        let extensions = config.resolved_extensions()?;
        let startup_args = startup_arg_strings(&config, &extensions);
        let requested_key = DirectResidentKey::requested(&config, &extensions, startup_args)?;
        let symbols = Arc::new(NativeSymbols::load(&self.source)?);
        let (root, root_was_resident) =
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
                let (root, error) = *failure;
                if root_was_resident {
                    store_direct_resident_root(root, resident_key)?;
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
        if existing.key.matches_request(requested_key) {
            return Ok((existing.root, true));
        }
        let bound_root = existing.key.actual_root_key.display().to_string();
        *resident = Some(existing);
        return Err(Error::Engine(format!(
            "native direct resident runtime is already bound to root {bound_root}; use NativeBroker or NativeServer for multiple roots in one process"
        )));
    }
    drop(resident);

    PreparedNativeRoot::prepare(config, extensions).map(|root| (root, false))
}

fn store_direct_resident_root(root: PreparedNativeRoot, key: DirectResidentKey) -> Result<()> {
    let slot = DIRECT_RESIDENT_ROOT.get_or_init(|| Mutex::new(None));
    let mut resident = slot
        .lock()
        .map_err(|_| Error::Engine("native direct resident root lock was poisoned".to_owned()))?;
    *resident = Some(DirectResidentRoot { root, key });
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
    selected_extensions: Vec<Extension>,
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
    ) -> std::result::Result<Self, Box<(PreparedNativeRoot, Error)>> {
        if let Err(error) = root.refresh_manifest() {
            return Err(Box::new((root, error)));
        }
        let pgdata = match path_to_cstring(&root.pgdata, "PGDATA") {
            Ok(value) => value,
            Err(error) => return Err(Box::new((root, error))),
        };
        let runtime_dir = match path_to_cstring(&root.runtime_dir, "runtime dir") {
            Ok(value) => value,
            Err(error) => return Err(Box::new((root, error))),
        };
        let module_dir = match path_to_cstring(
            &root.runtime_dir.join("lib/postgresql"),
            "embedded module dir",
        ) {
            Ok(value) => value,
            Err(error) => return Err(Box::new((root, error))),
        };
        let username = match CString::new(config.username.as_str()) {
            Ok(value) => value,
            Err(_) => {
                return Err(Box::new((
                    root,
                    Error::InvalidConfig("username contains an interior NUL".to_owned()),
                )));
            }
        };
        let database = match CString::new(config.database.as_str()) {
            Ok(value) => value,
            Err(_) => {
                return Err(Box::new((
                    root,
                    Error::InvalidConfig("database contains an interior NUL".to_owned()),
                )));
            }
        };
        let startup_args = match startup_args(&config, extensions) {
            Ok(value) => value,
            Err(error) => return Err(Box::new((root, error))),
        };
        let startup_arg_ptrs = startup_args
            .iter()
            .map(|arg| arg.as_ptr())
            .collect::<Vec<_>>();
        let native_config = NativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime_dir.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            reserved_flags: ffi::CONFIG_EXTERNAL_ROOT_LOCK,
            startup_args: startup_arg_ptrs.as_ptr(),
            startup_arg_count: startup_arg_ptrs.len(),
        };
        let init_options = NativeInitOptions {
            abi_version: ffi::INIT_OPTIONS_ABI_VERSION,
            module_dir: module_dir.as_ptr(),
            reserved_flags: 0,
        };

        let mut handle = ptr::null_mut();
        let rc = unsafe { (symbols.init_ex)(&native_config, &init_options, &mut handle) };
        if rc != 0 || handle.is_null() {
            let message = symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("oliphaunt_init_ex failed with status {rc}"));
            return Err(Box::new((
                root,
                Error::Engine(format!("native liboliphaunt init_ex failed: {message}")),
            )));
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
            selected_extensions: extensions.to_vec(),
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
            store_direct_resident_root(root, self.resident_key.clone())?;
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
    fn capabilities(&self) -> EngineCapabilities {
        let flags = unsafe { (self.symbols.capabilities)() };
        EngineCapabilities {
            mode: EngineMode::NativeDirect,
            session_concurrency: SessionConcurrency::SerializedSingleSession,
            process_isolated: false,
            multi_root: flags & CAP_MULTI_INSTANCE != 0,
            reopenable: flags & CAP_LOGICAL_REOPEN != 0,
            same_root_logical_reopen: flags & CAP_LOGICAL_REOPEN != 0,
            root_switchable: false,
            crash_restartable: false,
            max_client_sessions: 1,
            protocol_raw: flags & CAP_PROTOCOL_RAW != 0,
            protocol_stream: flags & CAP_PROTOCOL_STREAM != 0,
            query_cancel: flags & CAP_QUERY_CANCEL != 0,
            backup_restore: flags & CAP_BACKUP_RESTORE != 0,
            backup_formats: vec![BackupFormat::PhysicalArchive],
            restore_formats: vec![BackupFormat::PhysicalArchive],
            simple_query: flags & CAP_SIMPLE_QUERY != 0,
            extensions: flags & CAP_EXTENSIONS != 0,
            connection_strings: flags & CAP_SERVER_MODE != 0,
            connection_string: None,
        }
    }

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
        let Some(exec_stream) = self.symbols.exec_protocol_stream else {
            drop(guard);
            let response = self.exec_protocol_raw(request)?;
            return on_chunk(response.as_bytes());
        };

        struct StreamContext<'a> {
            on_chunk: &'a mut dyn FnMut(&[u8]) -> Result<()>,
            error: Option<Error>,
        }

        unsafe extern "C" fn stream_callback(
            context: *mut std::ffi::c_void,
            data: *const std::ffi::c_uchar,
            len: usize,
        ) -> std::ffi::c_int {
            let context = unsafe { &mut *(context as *mut StreamContext<'_>) };
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
            exec_stream(
                handle,
                bytes.as_ptr(),
                bytes.len(),
                stream_callback,
                &mut context as *mut StreamContext<'_> as *mut std::ffi::c_void,
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

    fn checkpoint(&mut self) -> Result<()> {
        self.exec_simple_query("CHECKPOINT").map(|_| ())
    }

    fn backup(&mut self, request: BackupRequest) -> Result<BackupArtifact> {
        match request.format {
            BackupFormat::PhysicalArchive => {
                let root = self.root.as_ref().ok_or(Error::EngineStopped)?;
                let pgdata = root.pgdata.clone();
                let selected_extensions = self.selected_extensions.clone();

                if let Some(backup_ex) = self.symbols.backup_ex {
                    let metadata_files = physical_archive_metadata_files(
                        &pgdata,
                        &selected_extensions,
                        |request| self.exec_protocol_raw(request),
                    )?;
                    let root_manifest_path = CString::new(NATIVE_ROOT_MANIFEST_FILE)
                        .expect("native root manifest path is a static C string");
                    let backup_manifest_path = CString::new(PHYSICAL_ARCHIVE_MANIFEST_PATH)
                        .expect("physical archive manifest path is a static C string");
                    let root_manifest_bytes = metadata_files.root_manifest.as_bytes();
                    let backup_manifest_bytes = metadata_files.backup_manifest.as_bytes();
                    let generated_files = [
                        NativeArchiveFile {
                            path: root_manifest_path.as_ptr(),
                            data: root_manifest_bytes.as_ptr(),
                            len: root_manifest_bytes.len(),
                            mode: 0o600,
                            reserved_flags: 0,
                        },
                        NativeArchiveFile {
                            path: backup_manifest_path.as_ptr(),
                            data: backup_manifest_bytes.as_ptr(),
                            len: backup_manifest_bytes.len(),
                            mode: 0o600,
                            reserved_flags: 0,
                        },
                    ];
                    let options = NativeBackupOptions {
                        abi_version: ABI_VERSION,
                        format: BACKUP_FORMAT_PHYSICAL_ARCHIVE,
                        generated_files: generated_files.as_ptr(),
                        generated_file_count: generated_files.len(),
                        reserved_flags: 0,
                    };
                    let guard = self.handle.handle.read().map_err(|_| {
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
                    let rc = unsafe { backup_ex(handle, &options, &mut response) };
                    if rc != 0 {
                        self.free_failed_response(&mut response);
                        let message = self.symbols.last_error_text(handle).unwrap_or_else(|| {
                            format!("oliphaunt_backup_ex failed with status {rc}")
                        });
                        return Err(Error::Engine(format!(
                            "native liboliphaunt physical backup failed: {message}"
                        )));
                    }
                    let bytes = self.bytes_from_native_response(response);
                    return Ok(BackupArtifact {
                        format: BackupFormat::PhysicalArchive,
                        bytes,
                    });
                }

                let backup = self.symbols.backup.ok_or_else(|| {
                    Error::Engine(
                        "native liboliphaunt is missing required oliphaunt_backup symbol"
                            .to_owned(),
                    )
                })?;
                let guard = self.handle.handle.read().map_err(|_| {
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
                let rc = unsafe { backup(handle, BACKUP_FORMAT_PHYSICAL_ARCHIVE, &mut response) };
                if rc != 0 {
                    let message = self
                        .symbols
                        .last_error_text(handle)
                        .unwrap_or_else(|| format!("oliphaunt_backup failed with status {rc}"));
                    return Err(Error::Engine(format!(
                        "native liboliphaunt physical backup failed: {message}"
                    )));
                }
                let bytes = self.bytes_from_native_response(response);
                drop(guard);
                let artifact = BackupArtifact {
                    format: BackupFormat::PhysicalArchive,
                    bytes,
                };
                annotate_physical_archive_backup(
                    artifact,
                    &pgdata,
                    &selected_extensions,
                    |request| self.exec_protocol_raw(request),
                )
            }
            BackupFormat::Sql => Err(Error::Engine(format!(
                "logical SQL backup requires NativeServer mode with pg_dump; direct mode C ABI format {} is intentionally unavailable",
                BACKUP_FORMAT_SQL
            ))),
            BackupFormat::OliphauntArchive => Err(Error::Engine(format!(
                "OliphauntArchive has no stable on-disk format yet; direct mode C ABI format {} is intentionally unavailable",
                BACKUP_FORMAT_OLIPHAUNT_ARCHIVE
            ))),
        }
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
    fn direct_startup_args_include_required_preload_libraries_before_init() {
        let mut config = OpenConfig::native_direct("target/test-roots/native-direct-preload");
        config.extensions = vec![Extension::PgSearch, Extension::PgSearch];
        let extensions = config.resolved_extensions().unwrap();
        let args = startup_args(&config, &extensions).unwrap();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_startup_config_arg(&args, "shared_preload_libraries=pg_search");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "shared_preload_libraries=pg_search")
                .count(),
            1,
            "preload libraries must be deduplicated before oliphaunt_init"
        );
    }

    #[test]
    fn direct_startup_args_omit_preload_when_selected_extensions_do_not_require_it() {
        let config = OpenConfig::native_direct("target/test-roots/native-direct-no-preload");
        let args = startup_args(&config, &[Extension::Graph]).unwrap();
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
    fn direct_startup_args_apply_footprint_before_durability_and_overrides() {
        let mut config = OpenConfig::native_direct("target/test-roots/native-direct-footprint");
        config.runtime_footprint = crate::RuntimeFootprintProfile::BalancedMobile;
        config.durability = crate::DurabilityProfile::Balanced;
        config.startup_gucs = vec![
            crate::PostgresStartupGuc::new("shared_buffers", "64MB"),
            crate::PostgresStartupGuc::new("synchronous_commit", "local"),
        ];
        let args = startup_arg_strings(&config, &[]);

        assert_startup_config_arg(&args, "shared_buffers=32MB");
        assert_startup_config_arg(&args, "synchronous_commit=off");
        assert_startup_config_arg(&args, "shared_buffers=64MB");
        assert_startup_config_arg(&args, "synchronous_commit=local");
        assert!(
            index_of(&args, "shared_buffers=32MB") < index_of(&args, "shared_buffers=64MB"),
            "explicit startup GUCs must be able to override the runtime footprint: {args:?}"
        );
        assert!(
            index_of(&args, "synchronous_commit=off") < index_of(&args, "synchronous_commit=local"),
            "explicit startup GUCs must be able to override durability defaults: {args:?}"
        );
    }

    #[test]
    fn invalid_startup_gucs_are_rejected_before_open() {
        let mut config = OpenConfig::native_direct("target/test-roots/native-direct-invalid-guc");
        config.startup_gucs = vec![crate::PostgresStartupGuc::new("shared-buffers", "16MB")];

        let error = config.validate().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("must contain only ASCII letters, digits, '_' or '.'"),
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

    fn index_of(args: &[String], expected: &str) -> usize {
        args.iter()
            .position(|arg| arg == expected)
            .unwrap_or_else(|| panic!("missing startup argument {expected:?} in {args:?}"))
    }
}
