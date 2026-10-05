// Private native Windows delivery control. The pinned DLL is embedded in the
// app, materialized in the user's known local-app-data folder, and loaded by
// absolute path with only its directory and System32 as dependency locations.
use std::{ffi::c_void, io::Write, os::windows::ffi::OsStringExt, sync::OnceLock};

#[repr(C)]
struct Guid { data1: u32, data2: u16, data3: u16, data4: [u8; 8] }
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHGetKnownFolderPath(folder: *const Guid, flags: u32, token: *mut c_void,
                          path: *mut *mut u16) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" { fn CoTaskMemFree(ptr: *mut c_void); }
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}
const DLL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/oliphaunt_wee8.dll"));
static MODULE: OnceLock<usize> = OnceLock::new();

fn load() -> usize {
    const LOCAL_APP_DATA: Guid = Guid { data1: 0xf1b32785, data2: 0x6fba,
        data3: 0x4fcf, data4: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91] };
    let mut folder = std::ptr::null_mut();
    let status = unsafe { SHGetKnownFolderPath(&LOCAL_APP_DATA, 0x8000,
        std::ptr::null_mut(), &mut folder) };
    assert!(status >= 0 && !folder.is_null(), "cannot locate Windows local app data: {status:#x}");
    let mut len = 0;
    unsafe { while *folder.add(len) != 0 { len += 1; } }
    let root = std::path::PathBuf::from(std::ffi::OsString::from_wide(
        unsafe { std::slice::from_raw_parts(folder, len) }));
    unsafe { CoTaskMemFree(folder.cast()) };
    let root = root.join("Oliphaunt/research-engines/RESEARCH_ENGINE_DIGEST");
    std::fs::create_dir_all(&root).expect("cannot create internal engine cache");
    let path = root.join("oliphaunt_wee8.dll");
    if !path.exists() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let temporary = root.join(format!("{}.{}.tmp", std::process::id(), nonce));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).unwrap();
        file.write_all(DLL).unwrap();
        file.sync_all().unwrap();
        drop(file);
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            assert!(path.exists(), "cannot install internal engine cache: {error}");
        }
    }
    assert!(std::fs::read(&path).unwrap() == DLL, "internal engine cache identity differs");
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800) };
    assert!(!module.is_null(), "cannot load internal engine: {}", std::io::Error::last_os_error());
    eprintln!("research_embedded_engine_loaded={}", path.display());
    // Retain the DLL for process life: V8's platform and resolved entries are global.
    module as usize
}

pub(super) unsafe fn symbol(name: &[u8]) -> *mut c_void {
    let module = *MODULE.get_or_init(load) as *mut c_void;
    let ptr = unsafe { GetProcAddress(module, name.as_ptr()) };
    assert!(!ptr.is_null(), "missing pinned engine C entry: {}", String::from_utf8_lossy(name));
    ptr
}
