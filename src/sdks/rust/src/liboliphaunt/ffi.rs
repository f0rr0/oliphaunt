use std::ffi::{CString, c_char, c_int, c_uchar, c_void};
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};

use libloading::Library;

use crate::error::{Error, Result};

pub(super) const ABI_VERSION: u32 = 10;
pub(super) const CONFIG_EXTERNAL_ROOT_LOCK: u64 = 1 << 0;
pub(super) const ERROR_CAPTURE_CAPACITY: usize = 1024;
/// Positive stream status reserved by ABI 10 for a callback abort after the
/// runtime has independently confirmed the request's ReadyForQuery boundary.
pub(super) const STREAM_CALLBACK_ABORTED_STATUS: c_int = 1;

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
    pub(super) module_dir: *const c_char,
    pub(super) username: *const c_char,
    pub(super) database: *const c_char,
    pub(super) flags: u64,
    pub(super) startup_args: *const *const c_char,
    pub(super) startup_arg_count: usize,
}

#[repr(C)]
pub(super) struct NativeResponse {
    pub(super) data: *mut c_uchar,
    pub(super) len: usize,
}

#[repr(C)]
pub(super) struct NativeErrorCapture {
    length: u32,
    message: [c_char; ERROR_CAPTURE_CAPACITY],
}

impl NativeErrorCapture {
    pub(super) const fn zeroed() -> Self {
        Self {
            length: 0,
            message: [0; ERROR_CAPTURE_CAPACITY],
        }
    }

    pub(super) fn error_text(&self) -> Option<String> {
        decode_error_text(self.length as usize, &self.message)
    }
}

#[repr(C)]
pub(super) struct NativeRestoreOptions {
    pub(super) abi_version: u32,
    pub(super) destination: *const c_char,
    pub(super) data: *const c_uchar,
    pub(super) len: usize,
}

pub(super) type NativeHandle = c_void;
type InitWithErrorFn = unsafe extern "C" fn(
    *const NativeConfig,
    *mut *mut NativeHandle,
    *mut NativeErrorCapture,
) -> c_int;
type ExecProtocolWithErrorFn = unsafe extern "C" fn(
    *mut NativeHandle,
    *const c_uchar,
    usize,
    *mut NativeResponse,
    *mut NativeErrorCapture,
) -> c_int;
pub(super) type StreamCallbackFn =
    unsafe extern "C" fn(*mut c_void, *const c_uchar, usize) -> c_int;
type ExecProtocolRawStreamWithErrorFn = unsafe extern "C" fn(
    *mut NativeHandle,
    *const c_uchar,
    usize,
    StreamCallbackFn,
    *mut c_void,
    *mut NativeErrorCapture,
) -> c_int;
type ExecSimpleQueryWithErrorFn = unsafe extern "C" fn(
    *mut NativeHandle,
    *const c_char,
    usize,
    *mut NativeResponse,
    *mut NativeErrorCapture,
) -> c_int;
type CloseFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type DetachWithErrorFn = unsafe extern "C" fn(*mut NativeHandle, *mut NativeErrorCapture) -> c_int;
type CancelFn = unsafe extern "C" fn(*mut NativeHandle) -> c_int;
type CopyLastErrorFn = unsafe extern "C" fn(*mut NativeHandle, *mut c_char, usize) -> usize;
type VersionFn = unsafe extern "C" fn() -> *const c_char;
type FreeResponseFn = unsafe extern "C" fn(*mut NativeResponse);
type BackupWithErrorFn =
    unsafe extern "C" fn(*mut NativeHandle, *mut NativeResponse, *mut NativeErrorCapture) -> c_int;
type RestoreWithErrorFn =
    unsafe extern "C" fn(*const NativeRestoreOptions, *mut NativeErrorCapture) -> c_int;

pub(super) struct NativeSymbols {
    _library: ManuallyDrop<Library>,
    pub(super) init_with_error: InitWithErrorFn,
    pub(super) exec_protocol_with_error: ExecProtocolWithErrorFn,
    pub(super) exec_protocol_raw_stream_with_error: ExecProtocolRawStreamWithErrorFn,
    #[cfg_attr(not(feature = "__internal-broker-helper"), allow(dead_code))]
    pub(super) exec_simple_query_with_error: ExecSimpleQueryWithErrorFn,
    pub(super) cancel: CancelFn,
    pub(super) detach_with_error: DetachWithErrorFn,
    _close: CloseFn,
    copy_last_error: CopyLastErrorFn,
    _version: VersionFn,
    pub(super) free_response: FreeResponseFn,
    pub(super) backup_with_error: BackupWithErrorFn,
    pub(super) restore_with_error: RestoreWithErrorFn,
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
    pub(super) fn load() -> Result<Self> {
        let path = resolve_library_path()?;
        let library = load_native_library(&path)?;
        let init_with_error = load_symbol(&library, b"oliphaunt_init_with_error\0")?;
        let exec_protocol_with_error =
            load_symbol(&library, b"oliphaunt_exec_protocol_with_error\0")?;
        let exec_protocol_raw_stream_with_error =
            load_symbol(&library, b"oliphaunt_exec_protocol_raw_stream_with_error\0")?;
        let exec_simple_query_with_error =
            load_symbol(&library, b"oliphaunt_exec_simple_query_with_error\0")?;
        let cancel = load_symbol(&library, b"oliphaunt_cancel\0")?;
        let detach_with_error = load_symbol(&library, b"oliphaunt_detach_with_error\0")?;
        let close = load_symbol(&library, b"oliphaunt_close\0")?;
        let copy_last_error = load_symbol(&library, b"oliphaunt_copy_last_error\0")?;
        let version = load_symbol(&library, b"oliphaunt_version\0")?;
        let free_response = load_symbol(&library, b"oliphaunt_free_response\0")?;
        let backup_with_error = load_symbol(&library, b"oliphaunt_backup_with_error\0")?;
        let restore_with_error = load_symbol(&library, b"oliphaunt_restore_with_error\0")?;
        Ok(Self {
            // liboliphaunt embeds PostgreSQL, which owns process-global runtime
            // state while a backend session is active. Logical SDK close uses
            // oliphaunt_detach; oliphaunt_close remains terminal for the process
            // lifetime. Dropping the dynamic library can invalidate callbacks,
            // signal handlers, or other global runtime pointers that PostgreSQL
            // installed inside the host process.
            _library: ManuallyDrop::new(library),
            init_with_error,
            exec_protocol_with_error,
            exec_protocol_raw_stream_with_error,
            exec_simple_query_with_error,
            cancel,
            detach_with_error,
            _close: close,
            copy_last_error,
            _version: version,
            free_response,
            backup_with_error,
            restore_with_error,
        })
    }

    /// Cancel has no `_with_error` ABI entry point. It is synchronous in this
    /// adapter, so copy its same-thread result into one ABI-sized buffer before
    /// returning to the caller. Every other operation uses its own capture.
    pub(super) fn last_error_text(&self, handle: *mut NativeHandle) -> Option<String> {
        let mut message = [0; ERROR_CAPTURE_CAPACITY];
        let length = unsafe { (self.copy_last_error)(handle, message.as_mut_ptr(), message.len()) };
        decode_error_text(length, &message)
    }
}

fn decode_error_text(length: usize, message: &[c_char]) -> Option<String> {
    let bounded_length = length.min(message.len().saturating_sub(1));
    if bounded_length == 0 {
        return None;
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(message.as_ptr().cast::<u8>(), bounded_length) };
    let text_length = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    (text_length != 0).then(|| String::from_utf8_lossy(&bytes[..text_length]).into_owned())
}

fn resolve_library_path() -> Result<PathBuf> {
    resolve_library_path_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| {
            Error::Engine(format!(
                "{ENV_OLIPHAUNT} is not set; set it to a native liboliphaunt dynamic library"
            ))
        })
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

pub(super) fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::InvalidConfig(format!("{label} contains an interior NUL")))
    }
    #[cfg(not(unix))]
    {
        let text = path.to_str().ok_or_else(|| {
            Error::InvalidConfig(format!("{label} is not representable as UTF-8"))
        })?;
        CString::new(text)
            .map_err(|_| Error::InvalidConfig(format!("{label} contains an interior NUL")))
    }
}

#[cfg(test)]
mod tests {
    use std::mem::{align_of, offset_of, size_of};

    use super::*;

    #[test]
    fn error_capture_matches_abi_10_layout() {
        assert_eq!(offset_of!(NativeErrorCapture, length), 0);
        assert_eq!(offset_of!(NativeErrorCapture, message), size_of::<u32>());
        assert_eq!(
            size_of::<NativeErrorCapture>(),
            size_of::<u32>() + ERROR_CAPTURE_CAPACITY
        );
        assert_eq!(align_of::<NativeErrorCapture>(), align_of::<u32>());
    }

    #[test]
    fn error_capture_decode_is_zeroed_bounded_and_lossy() {
        let mut capture = NativeErrorCapture::zeroed();
        assert_eq!(capture.error_text(), None);
        assert!(capture.message.iter().all(|byte| *byte == 0));

        capture.length = 5;
        for (slot, byte) in capture.message.iter_mut().zip(b"error") {
            *slot = *byte as c_char;
        }
        assert_eq!(capture.error_text().as_deref(), Some("error"));

        capture.length = u32::MAX;
        capture.message.fill(b'x' as c_char);
        let bounded = capture.error_text().expect("bounded capture text");
        assert_eq!(bounded.len(), ERROR_CAPTURE_CAPACITY - 1);
        assert!(bounded.bytes().all(|byte| byte == b'x'));

        capture.message[2] = 0;
        assert_eq!(capture.error_text().as_deref(), Some("xx"));

        capture.length = 1;
        capture.message[0] = -1_i8 as c_char;
        assert_eq!(capture.error_text().as_deref(), Some("�"));
    }
}
