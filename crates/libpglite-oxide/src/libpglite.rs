use std::collections::BTreeSet;
use std::ffi::{CStr, CString, OsStr, c_char, c_int, c_uchar, c_void};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use libloading::Library;

use crate::config::{EngineMode, OpenConfig};
use crate::engine::{EngineCapabilities, EngineSession, NativeRuntime, SessionConcurrency};
use crate::error::{Error, Result};
use crate::extension::{Extension, extension_data_files, extension_sql_file_belongs};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{BackupArtifact, BackupFormat, BackupRequest, DatabaseRoot};

const ABI_VERSION: u32 = 2;
const ENV_LIBPGLITE: &str = "LIBPGLITE_OXIDE_LIBPGLITE";
const ENV_INSTALL_DIR: &str = "LIBPGLITE_OXIDE_INSTALL_DIR";
const ENV_POSTGRES: &str = "LIBPGLITE_OXIDE_POSTGRES";
const ENV_INITDB: &str = "LIBPGLITE_OXIDE_INITDB";
const LEGACY_ENV_LIBPGLITE: &str = "PGLITE_NATIVE_LIBPGLITE";
const LEGACY_ENV_OXIDE_LIBPGLITE: &str = "PGLITE_OXIDE_NATIVE_LIBPGLITE";
const LEGACY_ENV_INSTALL_DIR: &str = "PGLITE_OXIDE_NATIVE_INSTALL_DIR";
const LEGACY_ENV_POSTGRES: &str = "PGLITE_OXIDE_NATIVE_POSTGRES";
const LEGACY_ENV_INITDB: &str = "PGLITE_OXIDE_NATIVE_INITDB";
const CAP_PROTOCOL_RAW: u64 = 1 << 0;
const CAP_PROTOCOL_STREAM: u64 = 1 << 1;
const CAP_MULTI_INSTANCE: u64 = 1 << 2;
const CAP_SERVER_MODE: u64 = 1 << 3;
const CAP_EXTENSIONS: u64 = 1 << 4;

static DIRECT_INSTANCE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Source used to locate the native `libpglite` dynamic library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibPgliteRuntimeSource {
    /// Resolve from `LIBPGLITE_OXIDE_LIBPGLITE`, falling back to legacy
    /// native-spike environment variables during migration.
    Env,
    /// Load from an explicit path.
    Path(PathBuf),
}

/// Runtime implementation backed by the native PostgreSQL `libpglite` C ABI.
#[derive(Debug, Clone)]
pub struct LibPgliteRuntime {
    source: LibPgliteRuntimeSource,
}

impl LibPgliteRuntime {
    /// Create a runtime that resolves the library path from the environment.
    pub fn from_env() -> Self {
        Self {
            source: LibPgliteRuntimeSource::Env,
        }
    }

    /// Create a runtime that loads a specific library path.
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self {
            source: LibPgliteRuntimeSource::Path(path.into()),
        }
    }
}

impl Default for LibPgliteRuntime {
    fn default() -> Self {
        Self::from_env()
    }
}

impl NativeRuntime for LibPgliteRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeDirect {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "the current libpglite C ABI is an in-process direct engine; broker and true server modes need their own runtimes".to_owned(),
            });
        }
        let _guard = DIRECT_INSTANCE_LOCK
            .get_or_init(|| Mutex::new(()))
            .try_lock()
            .map_err(|_| {
                Error::Engine(
                    "native direct already has an active process-wide instance".to_owned(),
                )
            })?;
        let extensions = config.resolved_extensions()?;
        let root = PreparedNativeRoot::prepare(&config, &extensions)?;
        let symbols = Arc::new(NativeSymbols::load(&self.source)?);
        let session = LibPgliteSession::open(symbols, root, config, _guard)?;
        Ok(Box::new(session))
    }
}

struct LibPgliteSession {
    symbols: Arc<NativeSymbols>,
    handle: *mut NativeHandle,
    root: PreparedNativeRoot,
    _guard: Option<MutexGuard<'static, ()>>,
}

unsafe impl Send for LibPgliteSession {}

impl LibPgliteSession {
    fn open(
        symbols: Arc<NativeSymbols>,
        root: PreparedNativeRoot,
        config: OpenConfig,
        guard: MutexGuard<'static, ()>,
    ) -> Result<Self> {
        let pgdata = path_to_cstring(&root.pgdata, "PGDATA")?;
        let runtime_dir = path_to_cstring(&root.runtime_dir, "runtime dir")?;
        let username = CString::new("postgres")
            .map_err(|_| Error::InvalidConfig("username contains an interior NUL".to_owned()))?;
        let database = CString::new("template1")
            .map_err(|_| Error::InvalidConfig("database contains an interior NUL".to_owned()))?;
        let startup_args = startup_args(&config)?;
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
            reserved_flags: 0,
            startup_args: startup_arg_ptrs.as_ptr(),
            startup_arg_count: startup_arg_ptrs.len(),
        };

        let mut handle = ptr::null_mut();
        let rc = unsafe { (symbols.init)(&native_config, &mut handle) };
        if rc != 0 || handle.is_null() {
            let message = symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("pglite_init failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native libpglite init failed: {message}"
            )));
        }

        Ok(Self {
            symbols,
            handle,
            root,
            _guard: Some(guard),
        })
    }

    fn close_handle(&mut self) -> Result<()> {
        if self.handle.is_null() {
            return Ok(());
        }
        let handle = self.handle;
        self.handle = ptr::null_mut();
        let rc = unsafe { (self.symbols.close)(handle) };
        self._guard = None;
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(ptr::null_mut())
                .unwrap_or_else(|| format!("pglite_close failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native libpglite close failed: {message}"
            )));
        }
        Ok(())
    }
}

impl EngineSession for LibPgliteSession {
    fn capabilities(&self) -> EngineCapabilities {
        let flags = unsafe { (self.symbols.capabilities)() };
        EngineCapabilities {
            mode: EngineMode::NativeDirect,
            session_concurrency: SessionConcurrency::SerializedSingleSession,
            process_isolated: false,
            multi_root: flags & CAP_MULTI_INSTANCE != 0,
            max_client_sessions: 1,
            protocol_raw: flags & CAP_PROTOCOL_RAW != 0,
            protocol_stream: flags & CAP_PROTOCOL_STREAM != 0,
            extension_packs: flags & CAP_EXTENSIONS != 0,
            connection_strings: flags & CAP_SERVER_MODE != 0,
        }
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        if self.handle.is_null() {
            return Err(Error::EngineStopped);
        }
        let bytes = request.as_bytes();
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let rc = unsafe {
            (self.symbols.exec_protocol)(self.handle, bytes.as_ptr(), bytes.len(), &mut response)
        };
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(self.handle)
                .unwrap_or_else(|| format!("pglite_exec_protocol failed with status {rc}"));
            return Err(Error::Engine(format!(
                "native libpglite protocol execution failed: {message}"
            )));
        }
        if response.data.is_null() {
            return Ok(ProtocolResponse::new(Vec::new()));
        }
        let out = unsafe { std::slice::from_raw_parts(response.data, response.len).to_vec() };
        unsafe { (self.symbols.free_response)(&mut response) };
        Ok(ProtocolResponse::new(out))
    }

    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let response = self.exec_protocol_raw(request)?;
        on_chunk(response.as_bytes())
    }

    fn checkpoint(&mut self) -> Result<()> {
        self.exec_protocol_raw(ProtocolRequest::simple_query("CHECKPOINT"))
            .map(|_| ())
    }

    fn backup(&mut self, request: BackupRequest) -> Result<BackupArtifact> {
        match request.format {
            BackupFormat::PhysicalArchive => Err(Error::Engine(format!(
                "physical backup is not implemented yet; root is {}",
                self.root.root.display()
            ))),
            BackupFormat::Sql | BackupFormat::PgliteArchive => Err(Error::Engine(format!(
                "{:?} backup is not implemented by the direct libpglite runtime yet",
                request.format
            ))),
        }
    }

    fn close(&mut self) -> Result<()> {
        self.close_handle()
    }
}

impl Drop for LibPgliteSession {
    fn drop(&mut self) {
        let _ = self.close_handle();
    }
}

fn startup_args(config: &OpenConfig) -> Result<Vec<CString>> {
    let mut args = Vec::new();
    for (name, value) in config.durability.postgres_gucs() {
        args.push("-c".to_owned());
        args.push(format!("{name}={value}"));
    }
    args.into_iter()
        .map(|arg| {
            CString::new(arg).map_err(|_| {
                Error::InvalidConfig("startup argument contains an interior NUL".to_owned())
            })
        })
        .collect()
}

struct PreparedNativeRoot {
    root: PathBuf,
    pgdata: PathBuf,
    runtime_dir: PathBuf,
    _lock: File,
    temporary: bool,
}

impl PreparedNativeRoot {
    fn prepare(config: &OpenConfig, extensions: &[Extension]) -> Result<Self> {
        let (root, temporary) = match &config.storage.root {
            DatabaseRoot::Path(root) => (root.clone(), false),
            DatabaseRoot::Temporary => (create_temporary_root()?, true),
        };
        fs::create_dir_all(&root).map_err(|err| {
            Error::Engine(format!(
                "create native database root {}: {err}",
                root.display()
            ))
        })?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(root.join(".pglite.lock"))
            .map_err(|err| Error::Engine(format!("open native root lock: {err}")))?;
        lock.try_lock_exclusive()
            .map_err(|err| Error::Engine(format!("lock native root {}: {err}", root.display())))?;

        let pgdata = root.join("pgdata");
        let runtime_dir = root.join("runtime");
        fs::create_dir_all(&pgdata).map_err(|err| {
            Error::Engine(format!("create native PGDATA {}: {err}", pgdata.display()))
        })?;
        materialize_runtime(&runtime_dir, extensions)?;

        Ok(Self {
            root,
            pgdata,
            runtime_dir,
            _lock: lock,
            temporary,
        })
    }
}

impl Drop for PreparedNativeRoot {
    fn drop(&mut self) {
        let _ = self._lock.unlock();
        if self.temporary {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn materialize_runtime(runtime_dir: &Path, extensions: &[Extension]) -> Result<()> {
    let install_dir = locate_native_install_dir()?;
    if runtime_dir.exists() {
        fs::remove_dir_all(runtime_dir).map_err(|err| {
            Error::Engine(format!(
                "remove stale native runtime {}: {err}",
                runtime_dir.display()
            ))
        })?;
    }
    fs::create_dir_all(runtime_dir).map_err(|err| {
        Error::Engine(format!(
            "create native runtime dir {}: {err}",
            runtime_dir.display()
        ))
    })?;

    copy_file_preserving_permissions(
        &install_dir.join("bin/postgres"),
        &runtime_dir.join("bin/postgres"),
    )?;
    let initdb = install_dir.join("bin/initdb");
    if initdb.is_file() {
        copy_file_preserving_permissions(&initdb, &runtime_dir.join("bin/initdb"))?;
    }

    install_native_share_tree(&install_dir, runtime_dir, extensions)?;
    install_native_library_tree(&install_dir, runtime_dir, extensions)
}

fn install_native_share_tree(
    install_dir: &Path,
    runtime_dir: &Path,
    extensions: &[Extension],
) -> Result<()> {
    let source_share = install_dir.join("share/postgresql");
    let target_share = runtime_dir.join("share/postgresql");
    if !source_share.is_dir() {
        return Err(Error::Engine(format!(
            "native PostgreSQL install is missing share/postgresql at {}",
            source_share.display()
        )));
    }

    copy_directory_filtered(&source_share, &target_share, native_core_share_file)?;
    remove_file_if_exists(&target_share.join("tsearch_data/unaccent.rules"))?;
    remove_file_if_exists(&target_share.join("tsearch_data/xsyn_sample.rules"))?;

    let target_extension_dir = target_share.join("extension");
    fs::create_dir_all(&target_extension_dir).map_err(|err| {
        Error::Engine(format!("create {}: {err}", target_extension_dir.display()))
    })?;

    copy_named_extension_sql_files(&source_share, &target_share, "plpgsql", true)?;
    for extension in extensions {
        copy_extension_sql_files(&source_share, &target_share, *extension)?;
        copy_extension_data_files(&source_share, &target_share, *extension)?;
    }
    Ok(())
}

fn install_native_library_tree(
    install_dir: &Path,
    runtime_dir: &Path,
    extensions: &[Extension],
) -> Result<()> {
    let source_lib = install_dir.join("lib/postgresql");
    let embedded_modules = locate_native_embedded_modules_dir(install_dir)?;
    let target_lib = runtime_dir.join("lib/postgresql");
    if !source_lib.is_dir() {
        return Err(Error::Engine(format!(
            "native PostgreSQL install is missing lib/postgresql at {}",
            source_lib.display()
        )));
    }
    fs::create_dir_all(&target_lib).map_err(|err| {
        Error::Engine(format!(
            "create native library dir {}: {err}",
            target_lib.display()
        ))
    })?;

    let extension_modules = native_packaged_extension_module_files();
    let embedded_core_modules = native_embedded_core_module_files();
    for entry in fs::read_dir(&source_lib)
        .map_err(|err| Error::Engine(format!("read native library dir: {err}")))?
    {
        let entry =
            entry.map_err(|err| Error::Engine(format!("read native library entry: {err}")))?;
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if extension_modules.contains(&file_name) || embedded_core_modules.contains(&file_name) {
            continue;
        }
        copy_file_preserving_permissions(&source, &target_lib.join(&file_name))?;
    }

    for module in embedded_core_modules {
        copy_native_embedded_module(&embedded_modules, &target_lib, &module)?;
    }
    for extension in extensions {
        let Some(module) = extension.native_module_file() else {
            continue;
        };
        copy_native_embedded_module(&embedded_modules, &target_lib, &module)?;
    }
    Ok(())
}

fn locate_native_install_dir() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(env_path_candidates([
        ENV_INSTALL_DIR,
        LEGACY_ENV_INSTALL_DIR,
    ]));
    for env_name in [
        ENV_POSTGRES,
        ENV_INITDB,
        LEGACY_ENV_POSTGRES,
        LEGACY_ENV_INITDB,
    ] {
        if let Some(path) = std::env::var_os(env_name) {
            let path = PathBuf::from(path);
            if let Some(install_dir) = path.parent().and_then(Path::parent) {
                candidates.push(install_dir.to_path_buf());
            }
        }
    }
    for path in resolve_library_path_candidates() {
        if let Some(work_root) = path.parent().and_then(Path::parent) {
            candidates.push(work_root.join("install"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/libpglite-pg18/install"));
        candidates.push(cwd.join("target/native-libpglite-pg18/install"));
    }

    for candidate in candidates {
        if native_install_dir_is_valid(&candidate) {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(format!(
        "could not locate native PostgreSQL 18 install tree; set {ENV_INSTALL_DIR} or {ENV_POSTGRES}"
    )))
}

fn locate_native_embedded_modules_dir(install_dir: &Path) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for path in resolve_library_path_candidates() {
        if let Some(out_dir) = path.parent() {
            candidates.push(out_dir.join("modules"));
        }
    }
    if let Some(work_root) = install_dir.parent() {
        candidates.push(work_root.join("out/modules"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/libpglite-pg18/out/modules"));
        candidates.push(cwd.join("target/native-libpglite-pg18/out/modules"));
    }

    for candidate in candidates {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(
        "could not locate native embedded PostgreSQL 18 module artifacts; build native libpglite first"
            .to_owned(),
    ))
}

fn native_install_dir_is_valid(path: &Path) -> bool {
    path.join("bin/postgres").is_file()
        && path
            .join("share/postgresql/postgresql.conf.sample")
            .is_file()
        && path.join("lib/postgresql").is_dir()
}

fn native_core_share_file(relative: &Path) -> bool {
    if relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == OsStr::new("extension"))
    {
        return false;
    }
    !matches!(
        relative.to_str(),
        Some("tsearch_data/unaccent.rules" | "tsearch_data/xsyn_sample.rules")
    )
}

fn native_packaged_extension_module_files() -> BTreeSet<String> {
    Extension::ALL_PG18_SUPPORTED
        .iter()
        .filter_map(|extension| extension.native_module_file())
        .collect()
}

fn native_embedded_core_module_files() -> BTreeSet<String> {
    [format!("plpgsql{}", std::env::consts::DLL_SUFFIX)]
        .into_iter()
        .collect()
}

fn copy_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    extension: Extension,
) -> Result<()> {
    copy_named_extension_sql_files(
        source_share,
        target_share,
        extension.sql_name(),
        extension.creates_extension(),
    )
}

fn copy_named_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    sql_name: &str,
    require_control: bool,
) -> Result<()> {
    let source_dir = source_share.join("extension");
    let target_dir = target_share.join("extension");
    let mut copied = 0usize;
    for entry in fs::read_dir(&source_dir).map_err(|err| {
        Error::Engine(format!(
            "read extension dir {}: {err}",
            source_dir.display()
        ))
    })? {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", source_dir.display()))
        })?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if extension_sql_file_belongs(sql_name, &file_name) {
            copy_file_preserving_permissions(&entry.path(), &target_dir.join(&file_name))?;
            copied += 1;
        }
    }
    if require_control {
        if !target_dir.join(format!("{sql_name}.control")).is_file() {
            return Err(Error::Engine(format!(
                "native extension '{sql_name}' is not available for PostgreSQL 18: missing control file in {}",
                source_dir.display()
            )));
        }
    } else if copied == 0 && sql_name != "auto_explain" {
        return Err(Error::Engine(format!(
            "native extension '{sql_name}' did not match any SQL/control files in {}",
            source_dir.display()
        )));
    }
    Ok(())
}

fn copy_extension_data_files(
    source_share: &Path,
    target_share: &Path,
    extension: Extension,
) -> Result<()> {
    for relative in extension_data_files(extension) {
        copy_file_preserving_permissions(
            &source_share.join(relative),
            &target_share.join(relative),
        )?;
    }
    Ok(())
}

fn copy_native_embedded_module(
    embedded_modules: &Path,
    target_lib: &Path,
    module: &str,
) -> Result<()> {
    let source = embedded_modules.join(module);
    if !source.is_file() {
        return Err(Error::Engine(format!(
            "native embedded PostgreSQL 18 module is missing {}",
            source.display()
        )));
    }
    copy_file_preserving_permissions(&source, &target_lib.join(module))
}

fn copy_directory_filtered(
    source: &Path,
    destination: &Path,
    should_copy_file: fn(&Path) -> bool,
) -> Result<()> {
    fn walk(
        source_root: &Path,
        current: &Path,
        destination: &Path,
        should_copy_file: fn(&Path) -> bool,
    ) -> Result<()> {
        for entry in fs::read_dir(current)
            .map_err(|err| Error::Engine(format!("read directory {}: {err}", current.display())))?
        {
            let entry =
                entry.map_err(|err| Error::Engine(format!("read directory entry: {err}")))?;
            let source_path = entry.path();
            let relative = source_path.strip_prefix(source_root).map_err(|err| {
                Error::Engine(format!(
                    "strip source prefix {} from {}: {err}",
                    source_root.display(),
                    source_path.display()
                ))
            })?;
            let target_path = destination.join(relative);
            if source_path.is_dir() {
                fs::create_dir_all(&target_path).map_err(|err| {
                    Error::Engine(format!("create directory {}: {err}", target_path.display()))
                })?;
                walk(source_root, &source_path, destination, should_copy_file)?;
            } else if source_path.is_file() && should_copy_file(relative) {
                copy_file_preserving_permissions(&source_path, &target_path)?;
            }
        }
        Ok(())
    }
    fs::create_dir_all(destination).map_err(|err| {
        Error::Engine(format!("create directory {}: {err}", destination.display()))
    })?;
    walk(source, source, destination, should_copy_file)
}

fn copy_file_preserving_permissions(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    let permissions = fs::metadata(source)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", source.display())))?
        .permissions();
    fs::copy(source, destination).map_err(|err| {
        Error::Engine(format!(
            "copy {} -> {}: {err}",
            source.display(),
            destination.display()
        ))
    })?;
    fs::set_permissions(destination, permissions).map_err(|err| {
        Error::Engine(format!(
            "set permissions on {}: {err}",
            destination.display()
        ))
    })
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::Engine(format!("remove {}: {err}", path.display()))),
    }
}

#[repr(C)]
struct NativeConfig {
    abi_version: u32,
    pgdata: *const c_char,
    runtime_dir: *const c_char,
    username: *const c_char,
    database: *const c_char,
    reserved_flags: u64,
    startup_args: *const *const c_char,
    startup_arg_count: usize,
}

#[repr(C)]
struct NativeResponse {
    data: *mut c_uchar,
    len: usize,
}

type NativeHandle = c_void;
type InitFn = unsafe extern "C" fn(*const NativeConfig, *mut *mut NativeHandle) -> c_int;
type ExecProtocolFn =
    unsafe extern "C" fn(*mut NativeHandle, *const c_uchar, usize, *mut NativeResponse) -> c_int;
type CloseFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type LastErrorFn = unsafe extern "C" fn(*mut NativeHandle) -> *const c_char;
type VersionFn = unsafe extern "C" fn() -> *const c_char;
type CapabilitiesFn = unsafe extern "C" fn() -> u64;
type FreeResponseFn = unsafe extern "C" fn(*mut NativeResponse);

struct NativeSymbols {
    _library: Library,
    init: InitFn,
    exec_protocol: ExecProtocolFn,
    close: CloseFn,
    last_error: LastErrorFn,
    _version: VersionFn,
    capabilities: CapabilitiesFn,
    free_response: FreeResponseFn,
}

unsafe impl Send for NativeSymbols {}
unsafe impl Sync for NativeSymbols {}

impl NativeSymbols {
    fn load(source: &LibPgliteRuntimeSource) -> Result<Self> {
        let path = resolve_library_path(source)?;
        let library = load_native_library(&path)?;
        let init = load_symbol(&library, b"pglite_init\0")?;
        let exec_protocol = load_symbol(&library, b"pglite_exec_protocol\0")?;
        let close = load_symbol(&library, b"pglite_close\0")?;
        let last_error = load_symbol(&library, b"pglite_last_error\0")?;
        let version = load_symbol(&library, b"pglite_version\0")?;
        let capabilities = load_symbol(&library, b"pglite_capabilities\0")?;
        let free_response = load_symbol(&library, b"pglite_free_response\0")?;
        Ok(Self {
            _library: library,
            init,
            exec_protocol,
            close,
            last_error,
            _version: version,
            capabilities,
            free_response,
        })
    }

    fn last_error_text(&self, handle: *mut NativeHandle) -> Option<String> {
        let ptr = unsafe { (self.last_error)(handle) };
        c_string_lossy(ptr)
    }
}

fn resolve_library_path(source: &LibPgliteRuntimeSource) -> Result<PathBuf> {
    match source {
        LibPgliteRuntimeSource::Path(path) => Ok(path.clone()),
        LibPgliteRuntimeSource::Env => resolve_library_path_candidates()
            .into_iter()
            .next()
            .ok_or_else(|| {
                Error::Engine(format!(
                    "{ENV_LIBPGLITE} is not set; set it to a native libpglite dynamic library"
                ))
            }),
    }
}

fn resolve_library_path_candidates() -> Vec<PathBuf> {
    env_path_candidates([
        ENV_LIBPGLITE,
        LEGACY_ENV_LIBPGLITE,
        LEGACY_ENV_OXIDE_LIBPGLITE,
    ])
}

fn env_path_candidates<const N: usize>(names: [&str; N]) -> Vec<PathBuf> {
    names
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect()
}

fn load_native_library(path: &Path) -> Result<Library> {
    #[cfg(unix)]
    {
        use libloading::os::unix::{Library as UnixLibrary, RTLD_GLOBAL, RTLD_NOW};

        let library = unsafe { UnixLibrary::open(Some(path.as_os_str()), RTLD_NOW | RTLD_GLOBAL) }
            .map_err(|err| {
                Error::Engine(format!(
                    "load native libpglite library {}: {err}",
                    path.display()
                ))
            })?;
        Ok(Library::from(library))
    }
    #[cfg(not(unix))]
    {
        let library = unsafe { Library::new(path) }.map_err(|err| {
            Error::Engine(format!(
                "load native libpglite library {}: {err}",
                path.display()
            ))
        })?;
        Ok(library)
    }
}

fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
    let symbol = unsafe { library.get::<T>(name) }.map_err(|err| {
        Error::Engine(format!(
            "native libpglite is missing required symbol {}: {err}",
            String::from_utf8_lossy(name).trim_end_matches('\0')
        ))
    })?;
    Ok(*symbol)
}

fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
    let text = path.to_string_lossy();
    CString::new(text.as_bytes())
        .map_err(|_| Error::InvalidConfig(format!("{label} contains an interior NUL")))
}

fn c_string_lossy(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn create_temporary_root() -> Result<PathBuf> {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))?
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("libpglite-oxide-{pid}-{nanos}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(Error::Engine(format!(
                    "create temporary native root {}: {err}",
                    path.display()
                )));
            }
        }
    }
    Err(Error::Engine(
        "failed to allocate a unique temporary native root".to_owned(),
    ))
}
