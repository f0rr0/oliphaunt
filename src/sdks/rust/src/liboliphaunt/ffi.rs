use std::ffi::{CStr, CString, c_char, c_int, c_uchar, c_void};
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};

use libloading::Library;

use super::OliphauntRuntimeSource;
use crate::error::{Error, Result};

pub(super) const ABI_VERSION: u32 = 6;
pub(super) const INIT_OPTIONS_ABI_VERSION: u32 = 1;
pub(super) const CAP_PROTOCOL_RAW: u64 = 1 << 0;
pub(super) const CAP_PROTOCOL_STREAM: u64 = 1 << 1;
pub(super) const CAP_MULTI_INSTANCE: u64 = 1 << 2;
pub(super) const CAP_SERVER_MODE: u64 = 1 << 3;
pub(super) const CAP_EXTENSIONS: u64 = 1 << 4;
pub(super) const CAP_QUERY_CANCEL: u64 = 1 << 5;
pub(super) const CAP_BACKUP_RESTORE: u64 = 1 << 6;
pub(super) const CAP_SIMPLE_QUERY: u64 = 1 << 7;
pub(super) const CAP_LOGICAL_REOPEN: u64 = 1 << 9;

pub(super) const CONFIG_EXTERNAL_ROOT_LOCK: u64 = 1 << 0;

pub(super) const BACKUP_FORMAT_SQL: u32 = 1;
pub(super) const BACKUP_FORMAT_PHYSICAL_ARCHIVE: u32 = 2;
pub(super) const BACKUP_FORMAT_OLIPHAUNT_ARCHIVE: u32 = 3;

pub(super) const ENV_OLIPHAUNT: &str = "LIBOLIPHAUNT_PATH";
pub(super) const ENV_INSTALL_DIR: &str = "OLIPHAUNT_INSTALL_DIR";
pub(super) const ENV_EMBEDDED_MODULE_DIR: &str = "OLIPHAUNT_EMBEDDED_MODULE_DIR";
pub(super) const ENV_POSTGRES: &str = "OLIPHAUNT_POSTGRES";
pub(super) const ENV_INITDB: &str = "OLIPHAUNT_INITDB";

#[repr(C)]
pub(super) struct NativeConfig {
    pub(super) abi_version: u32,
    pub(super) pgdata: *const c_char,
    pub(super) runtime_dir: *const c_char,
    pub(super) username: *const c_char,
    pub(super) database: *const c_char,
    pub(super) reserved_flags: u64,
    pub(super) startup_args: *const *const c_char,
    pub(super) startup_arg_count: usize,
}

#[repr(C)]
pub(super) struct NativeInitOptions {
    pub(super) abi_version: u32,
    pub(super) module_dir: *const c_char,
    pub(super) reserved_flags: u64,
}

#[repr(C)]
pub(super) struct NativeResponse {
    pub(super) data: *mut c_uchar,
    pub(super) len: usize,
}

#[repr(C)]
pub(super) struct NativeArchiveFile {
    pub(super) path: *const c_char,
    pub(super) data: *const c_uchar,
    pub(super) len: usize,
    pub(super) mode: u32,
    pub(super) reserved_flags: u64,
}

#[repr(C)]
pub(super) struct NativeBackupOptions {
    pub(super) abi_version: u32,
    pub(super) format: u32,
    pub(super) generated_files: *const NativeArchiveFile,
    pub(super) generated_file_count: usize,
    pub(super) reserved_flags: u64,
}

pub(super) type NativeHandle = c_void;
type InitExFn = unsafe extern "C" fn(
    *const NativeConfig,
    *const NativeInitOptions,
    *mut *mut NativeHandle,
) -> c_int;
type ExecProtocolFn =
    unsafe extern "C" fn(*mut NativeHandle, *const c_uchar, usize, *mut NativeResponse) -> c_int;
type ExecSimpleQueryFn =
    unsafe extern "C" fn(*mut NativeHandle, *const c_char, usize, *mut NativeResponse) -> c_int;
pub(super) type StreamCallbackFn =
    unsafe extern "C" fn(*mut c_void, *const c_uchar, usize) -> c_int;
type ExecProtocolStreamFn = unsafe extern "C" fn(
    *mut NativeHandle,
    *const c_uchar,
    usize,
    StreamCallbackFn,
    *mut c_void,
) -> c_int;
type CloseFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type DetachFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type CancelFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type LastErrorFn = unsafe extern "C" fn(*mut NativeHandle) -> *const c_char;
type VersionFn = unsafe extern "C" fn() -> *const c_char;
type CapabilitiesFn = unsafe extern "C" fn() -> u64;
type FreeResponseFn = unsafe extern "C" fn(*mut NativeResponse);
type BackupFn = unsafe extern "C" fn(*mut NativeHandle, u32, *mut NativeResponse) -> c_int;
type BackupExFn = unsafe extern "C" fn(
    *mut NativeHandle,
    *const NativeBackupOptions,
    *mut NativeResponse,
) -> c_int;

pub(super) struct NativeSymbols {
    _library: ManuallyDrop<Library>,
    pub(super) init_ex: InitExFn,
    pub(super) exec_protocol: ExecProtocolFn,
    pub(super) exec_simple_query: Option<ExecSimpleQueryFn>,
    pub(super) exec_protocol_stream: Option<ExecProtocolStreamFn>,
    pub(super) cancel: CancelFn,
    pub(super) detach: DetachFn,
    _close: CloseFn,
    pub(super) last_error: LastErrorFn,
    _version: VersionFn,
    pub(super) capabilities: CapabilitiesFn,
    pub(super) free_response: FreeResponseFn,
    pub(super) backup: Option<BackupFn>,
    pub(super) backup_ex: Option<BackupExFn>,
}

// SAFETY: NativeSymbols is immutable after load. Function pointers are plain C
// symbols tied to `_library`, and the library is intentionally leaked for the
// process lifetime so those pointers cannot dangle while shared between the SDK
// executor and cancellation paths.
unsafe impl Send for NativeSymbols {}
// SAFETY: See the Send impl. Calling through a symbol still requires the caller
// to provide a valid synchronized handle; this table only shares immutable
// function addresses and the pinned dynamic library ownership.
unsafe impl Sync for NativeSymbols {}

impl NativeSymbols {
    pub(super) fn load(source: &OliphauntRuntimeSource) -> Result<Self> {
        let path = resolve_library_path(source)?;
        let library = load_native_library(&path)?;
        let init_ex = load_symbol(&library, b"oliphaunt_init_ex\0")?;
        let exec_protocol = load_symbol(&library, b"oliphaunt_exec_protocol\0")?;
        let exec_simple_query = load_optional_symbol(&library, b"oliphaunt_exec_simple_query\0");
        let exec_protocol_stream =
            load_optional_symbol(&library, b"oliphaunt_exec_protocol_stream\0");
        let cancel = load_symbol(&library, b"oliphaunt_cancel\0")?;
        let detach = load_symbol(&library, b"oliphaunt_detach\0")?;
        let close = load_symbol(&library, b"oliphaunt_close\0")?;
        let last_error = load_symbol(&library, b"oliphaunt_last_error\0")?;
        let version = load_symbol(&library, b"oliphaunt_version\0")?;
        let capabilities = load_symbol(&library, b"oliphaunt_capabilities\0")?;
        let free_response = load_symbol(&library, b"oliphaunt_free_response\0")?;
        let backup = load_optional_symbol(&library, b"oliphaunt_backup\0");
        let backup_ex = load_optional_symbol(&library, b"oliphaunt_backup_ex\0");
        Ok(Self {
            // liboliphaunt embeds PostgreSQL, which owns process-global runtime
            // state while a backend session is active. Logical SDK close uses
            // oliphaunt_detach; oliphaunt_close remains terminal for the process
            // lifetime. Dropping the dynamic library can invalidate callbacks,
            // signal handlers, or other global runtime pointers that PostgreSQL
            // installed inside the host process.
            _library: ManuallyDrop::new(library),
            init_ex,
            exec_protocol,
            exec_simple_query,
            exec_protocol_stream,
            cancel,
            detach,
            _close: close,
            last_error,
            _version: version,
            capabilities,
            free_response,
            backup,
            backup_ex,
        })
    }

    pub(super) fn last_error_text(&self, handle: *mut NativeHandle) -> Option<String> {
        let ptr = unsafe { (self.last_error)(handle) };
        c_string_lossy(ptr)
    }
}

fn resolve_library_path(source: &OliphauntRuntimeSource) -> Result<PathBuf> {
    match source {
        OliphauntRuntimeSource::Path(path) => Ok(path.clone()),
        OliphauntRuntimeSource::Env => resolve_library_path_candidates()
            .into_iter()
            .next()
            .ok_or_else(|| {
                Error::Engine(format!(
                    "{ENV_OLIPHAUNT} is not set; set it to a native liboliphaunt dynamic library"
                ))
            }),
    }
}

pub(super) fn resolve_library_path_candidates() -> Vec<PathBuf> {
    env_path_candidates([ENV_OLIPHAUNT])
}

pub(super) fn env_path_candidates<const N: usize>(names: [&str; N]) -> Vec<PathBuf> {
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
                    "load native liboliphaunt library {}: {err}",
                    path.display()
                ))
            })?;
        Ok(Library::from(library))
    }
    #[cfg(not(unix))]
    {
        let library = unsafe { Library::new(path) }.map_err(|err| {
            Error::Engine(format!(
                "load native liboliphaunt library {}: {err}",
                path.display()
            ))
        })?;
        Ok(library)
    }
}

fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
    let symbol = unsafe { library.get::<T>(name) }.map_err(|err| {
        Error::Engine(format!(
            "native liboliphaunt is missing required symbol {}: {err}",
            String::from_utf8_lossy(name).trim_end_matches('\0')
        ))
    })?;
    Ok(*symbol)
}

fn load_optional_symbol<T: Copy>(library: &Library, name: &[u8]) -> Option<T> {
    unsafe { library.get::<T>(name) }.ok().map(|symbol| *symbol)
}

pub(super) fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
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
