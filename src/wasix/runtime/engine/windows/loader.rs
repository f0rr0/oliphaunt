// Prepared native Windows delivery. Resolve every entry before initializing V8.
use std::{
    ffi::{OsString, c_void},
    io::{self, Write},
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHGetKnownFolderPath(
        folder: *const Guid,
        flags: u32,
        token: *mut c_void,
        path: *mut *mut u16,
    ) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoTaskMemFree(ptr: *mut c_void);
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}
const DLL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/oliphaunt_wee8.dll"));
static PREPARED: OnceLock<Prepared> = OnceLock::new();
static PREPARING: Mutex<()> = Mutex::new(());

struct Library(usize);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.0 as *mut c_void) };
    }
}
struct Prepared {
    // OnceLock retains a successful DLL for process life. Failed resolution
    // drops the library before V8 initializes any global state.
    _library: Library,
    symbols: Vec<usize>,
}

#[derive(Debug)]
struct DeliveryError {
    action: String,
    path: PathBuf,
    source: io::Error,
}
impl std::fmt::Display for DeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} '{}': {}",
            self.action,
            self.path.display(),
            self.source
        )
    }
}
impl std::error::Error for DeliveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}
fn context(error: io::Error, action: &str, path: &Path) -> io::Error {
    io::Error::new(
        error.kind(),
        DeliveryError {
            action: action.to_owned(),
            path: path.to_owned(),
            source: error,
        },
    )
}

fn cache_path() -> io::Result<PathBuf> {
    const LOCAL_APP_DATA: Guid = Guid {
        data1: 0xf1b32785,
        data2: 0x6fba,
        data3: 0x4fcf,
        data4: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
    };
    let mut folder = std::ptr::null_mut();
    let status =
        unsafe { SHGetKnownFolderPath(&LOCAL_APP_DATA, 0x8000, std::ptr::null_mut(), &mut folder) };
    if status < 0 || folder.is_null() {
        if !folder.is_null() {
            unsafe { CoTaskMemFree(folder.cast()) };
        }
        return Err(io::Error::other(format!(
            "locate Windows local app data: HRESULT {status:#x}"
        )));
    }
    let mut len = 0;
    unsafe {
        while *folder.add(len) != 0 {
            len += 1;
        }
    }
    let root = PathBuf::from(OsString::from_wide(unsafe {
        std::slice::from_raw_parts(folder, len)
    }));
    unsafe { CoTaskMemFree(folder.cast()) };
    Ok(root.join("Oliphaunt/engines/ENGINE_DIGEST/oliphaunt_wee8.dll"))
}

fn valid_payload(path: &Path) -> io::Result<bool> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes == DLL),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(context(error, "read internal engine cache", path)),
    }
}

fn install(path: &Path) -> io::Result<()> {
    // A valid warm cache also works without directory write permission.
    if valid_payload(path)? {
        return Ok(());
    }
    let root = path.parent().expect("internal engine path has a parent");
    std::fs::create_dir_all(root)
        .map_err(|error| context(error, "create internal engine cache", root))?;
    let mut temporary = tempfile::NamedTempFile::new_in(root)
        .map_err(|error| context(error, "create temporary engine", root))?;
    temporary
        .write_all(DLL)
        .map_err(|error| context(error, "write temporary engine", temporary.path()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| context(error, "sync temporary engine", temporary.path()))?;
    if let Err(error) = temporary.persist(path) {
        // Another process may have installed and loaded the same immutable DLL.
        // Accept it only when every byte matches; otherwise leave it untouched.
        if !valid_payload(path).unwrap_or(false) {
            return Err(context(error.error, "replace internal engine cache", path));
        }
    }
    if !valid_payload(path)? {
        return Err(io::Error::other(format!(
            "internal engine cache identity differs: '{}'",
            path.display()
        )));
    }
    Ok(())
}

fn load(path: &Path, names: &[&[u8]]) -> io::Result<Prepared> {
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800) };
    if module.is_null() {
        return Err(context(
            io::Error::last_os_error(),
            "load internal engine",
            path,
        ));
    }
    let library = Library(module as usize);
    let mut symbols = Vec::with_capacity(names.len());
    for name in names {
        let pointer = unsafe { GetProcAddress(module, name.as_ptr()) };
        if pointer.is_null() {
            return Err(context(
                io::Error::last_os_error(),
                &format!(
                    "resolve internal engine entry {}",
                    String::from_utf8_lossy(&name[..name.len() - 1])
                ),
                path,
            ));
        }
        symbols.push(pointer as usize);
    }
    Ok(Prepared {
        _library: library,
        symbols,
    })
}

pub(super) fn prepare() -> io::Result<()> {
    if PREPARED.get().is_some() {
        return Ok(());
    }
    let _lock = PREPARING.lock().unwrap_or_else(|error| error.into_inner());
    if PREPARED.get().is_none() {
        let path = cache_path()?;
        install(&path)?;
        let prepared = load(&path, REQUIRED_SYMBOLS)?;
        PREPARED.get_or_init(|| prepared);
    }
    Ok(())
}

pub(super) fn symbol(index: usize) -> *mut c_void {
    PREPARED
        .get()
        .expect("V8 engine must be prepared before dispatch")
        .symbols[index] as *mut c_void
}

#[cfg(test)]
mod oliphaunt_contract {
    use super::*;

    #[test]
    fn repairs_missing_truncated_and_wrong_engine_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("engine.dll");
        for bytes in [None, Some(&DLL[..DLL.len() / 2]), Some(&b"wrong bytes"[..])] {
            if let Some(bytes) = bytes {
                std::fs::write(&path, bytes).unwrap();
            }
            install(&path).unwrap();
            assert!(valid_payload(&path).unwrap());
        }
    }

    #[test]
    fn a_locked_bad_cache_reports_failure_and_can_be_retried() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("engine.dll");
        std::fs::write(&path, b"wrong bytes").unwrap();
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(install(&path).is_err());
        drop(locked);
        install(&path).unwrap();
        assert!(valid_payload(&path).unwrap());
    }

    #[test]
    fn missing_exports_release_the_library_before_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("engine.dll");
        install(&path).unwrap();
        assert!(load(&path, &[b"oliphaunt_missing_entry\0"]).is_err());
        // Windows prevents removal of a DLL while its image is still loaded.
        std::fs::remove_file(&path).unwrap();
        install(&path).unwrap();
        let prepared = load(&path, REQUIRED_SYMBOLS).unwrap();
        assert_eq!(prepared.symbols.len(), REQUIRED_SYMBOLS.len());
        drop(prepared);
        std::fs::remove_file(&path).unwrap();
    }
}
