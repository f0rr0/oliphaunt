use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use libloading::Library;
use oliphaunt::{
    BackupRequest, NativeBrokerRuntime, NativeRuntime, Oliphaunt, RestoreRequest, Result,
};

const C_DIRECT_CHILD_ENV: &str = "OLIPHAUNT_ROOT_LOCK_C_DIRECT_CHILD";

#[test]
fn native_server_rejects_duplicate_root_and_reopens_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server root-lock smoke: no native runtime env is set");
        return;
    }

    let root = unique_temp_root("oliphaunt-server-root-lock");
    let first = block_on(Oliphaunt::builder().path(&root).native_server().open()).unwrap();
    assert_query_value(&first, "SELECT 'server-open'::text AS value", "server-open");

    assert_open_fails_with(
        block_on(Oliphaunt::builder().path(&root).native_server().open()),
        &["already open in this process", "lock native root"],
    );
    let archive = block_on(first.backup(BackupRequest::physical_archive())).unwrap();
    assert_fails_with(
        block_on(Oliphaunt::restore(
            RestoreRequest::physical_archive(&root, archive).replace_existing(),
        )),
        &["already open in this process", "lock restore target"],
    );

    block_on(first.close()).unwrap();
    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_server()
            .existing_only()
            .open(),
    )
    .unwrap();
    assert_query_value(
        &reopened,
        "SELECT 'server-reopened'::text AS value",
        "server-reopened",
    );
    block_on(reopened.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_rejects_duplicate_root_across_helpers_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker root-lock smoke: no native runtime env is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker root-lock smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-root-lock");
    let first = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    assert_query_value(&first, "SELECT 'broker-open'::text AS value", "broker-open");

    assert_open_fails_with(
        block_on(
            Oliphaunt::builder()
                .path(&root)
                .native_broker()
                .broker_executable(broker)
                .open(),
        ),
        &["lock native root", "already open", ".oliphaunt.lock"],
    );

    block_on(first.close()).unwrap();
    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    )
    .unwrap();
    assert_query_value(
        &reopened,
        "SELECT 'broker-reopened'::text AS value",
        "broker-reopened",
    );
    block_on(reopened.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_shared_runtime_rejects_duplicate_root_before_helper_spawn() {
    if native_runtime_env_is_unavailable() {
        eprintln!(
            "skipping native broker supervisor root-lock smoke: no native runtime env is set"
        );
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker supervisor root-lock smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let runtime: Arc<dyn NativeRuntime> =
        Arc::new(NativeBrokerRuntime::from_executable(broker).with_max_roots(2));
    let root = unique_temp_root("oliphaunt-broker-supervisor-root-lock");
    let first = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_max_roots(2)
            .runtime_arc(Arc::clone(&runtime))
            .open(),
    )
    .unwrap();

    assert_open_fails_with(
        block_on(
            Oliphaunt::builder()
                .path(&root)
                .native_broker()
                .broker_max_roots(2)
                .runtime_arc(runtime)
                .open(),
        ),
        &["already open in this broker runtime"],
    );

    block_on(first.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn c_direct_and_rust_sdk_root_locks_are_reciprocal_when_env_is_available() {
    if std::env::var_os(C_DIRECT_CHILD_ENV).is_none() {
        run_c_direct_root_lock_child();
        return;
    }

    if native_runtime_env_is_unavailable() {
        eprintln!("skipping reciprocal C/Rust root-lock smoke: no native runtime env is set");
        return;
    }
    let Some(runtime_dir) = native_install_dir() else {
        eprintln!("skipping reciprocal C/Rust root-lock smoke: no native install dir is available");
        return;
    };

    let api = CDirectApi::load_from_env().unwrap();
    let root = unique_temp_root("oliphaunt-c-rust-root-lock");
    let pgdata = root.join("pgdata");
    let rust_server = block_on(Oliphaunt::builder().path(&root).native_server().open()).unwrap();
    assert_query_value(
        &rust_server,
        "SELECT 'rust-first'::text AS value",
        "rust-first",
    );

    assert_c_open_fails_with(
        api.open(&pgdata, &runtime_dir),
        &["already locked", ".oliphaunt.lock", "lock"],
    );
    assert_c_restore_fails_with(
        api.restore_physical_archive_replace(&root, b"not a valid physical archive"),
        &["already locked", "lock"],
    );
    block_on(rust_server.close()).unwrap();

    let mut c_direct = api.open(&pgdata, &runtime_dir).unwrap();
    assert!(
        root.join(".oliphaunt.lock").is_file(),
        "C direct open should create the visible native root lock marker"
    );

    assert_open_fails_with(
        block_on(
            Oliphaunt::builder()
                .path(&root)
                .native_server()
                .existing_only()
                .open(),
        ),
        &["lock native root", "already locked", ".oliphaunt.lock"],
    );

    c_direct.close().unwrap();
    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_server()
            .existing_only()
            .open(),
    )
    .unwrap();
    assert_query_value(
        &reopened,
        "SELECT 'rust-reopened'::text AS value",
        "rust-reopened",
    );
    block_on(reopened.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

fn run_c_direct_root_lock_child() {
    let current_exe = std::env::current_exe().expect("current test executable is unavailable");
    let output = Command::new(current_exe)
        .arg("c_direct_and_rust_sdk_root_locks_are_reciprocal_when_env_is_available")
        .arg("--exact")
        .arg("--nocapture")
        .env(C_DIRECT_CHILD_ENV, "1")
        .output()
        .expect("failed to spawn C direct root-lock child test process");
    assert!(
        output.status.success(),
        "C direct root-lock child failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_query_value(db: &Oliphaunt, sql: &str, expected: &str) {
    let result = block_on(db.query(sql)).unwrap();
    assert_eq!(result.get_text(0, "value").unwrap(), Some(expected));
}

fn assert_open_fails_with(result: Result<Oliphaunt>, expected_needles: &[&str]) {
    match result {
        Ok(db) => {
            let _ = block_on(db.close());
            panic!("expected duplicate native root open to fail");
        }
        Err(error) => {
            let message = error.to_string();
            assert!(
                expected_needles
                    .iter()
                    .any(|needle| message.contains(needle)),
                "unexpected duplicate native root error: {message}"
            );
        }
    }
}

fn assert_c_open_fails_with(
    result: std::result::Result<CDirectHandle<'_>, String>,
    expected_needles: &[&str],
) {
    match result {
        Ok(mut handle) => {
            let _ = handle.close();
            panic!("expected C direct duplicate native root open to fail");
        }
        Err(message) => {
            assert!(
                expected_needles
                    .iter()
                    .any(|needle| message.contains(needle)),
                "unexpected C direct duplicate native root error: {message}"
            );
        }
    }
}

fn assert_c_restore_fails_with(result: std::result::Result<(), String>, expected_needles: &[&str]) {
    match result {
        Ok(()) => panic!("expected C restore over an active native root to fail"),
        Err(message) => {
            assert!(
                expected_needles
                    .iter()
                    .any(|needle| message.contains(needle)),
                "unexpected C restore active-root error: {message}"
            );
        }
    }
}

fn assert_fails_with<T>(result: Result<T>, expected_needles: &[&str]) {
    match result {
        Ok(_) => panic!("expected operation to fail"),
        Err(error) => {
            let message = error.to_string();
            assert!(
                expected_needles
                    .iter()
                    .any(|needle| message.contains(needle)),
                "unexpected error: {message}"
            );
        }
    }
}

fn native_runtime_env_is_unavailable() -> bool {
    std::env::var_os("LIBOLIPHAUNT_PATH").is_none()
}

fn native_broker_executable() -> Option<&'static str> {
    option_env!("CARGO_BIN_EXE_oliphaunt-broker")
}

fn native_library_path() -> Option<PathBuf> {
    ["LIBOLIPHAUNT_PATH"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn native_install_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = ["OLIPHAUNT_INSTALL_DIR"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();

    if let Some(library) = native_library_path() {
        if let Some(work_root) = library.parent().and_then(Path::parent) {
            candidates.push(work_root.join("install"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/liboliphaunt-pg18/install"));
        candidates.push(cwd.join("target/native-liboliphaunt-pg18/install"));
    }

    candidates
        .into_iter()
        .find(|path| path.join("bin/postgres").is_file() && path.join("bin/initdb").is_file())
}

fn unique_temp_root(prefix: &str) -> PathBuf {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
        if !path.exists() {
            return path;
        }
    }
    panic!("failed to allocate a unique temp root for {prefix}");
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);

    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}

struct ThreadWaker(thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

#[repr(C)]
struct CDirectConfig {
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
struct CDirectRestoreOptions {
    abi_version: u32,
    root: *const c_char,
    format: u32,
    data: *const u8,
    len: usize,
    flags: u64,
}

type CDirectRawHandle = c_void;
type CDirectInit = unsafe extern "C" fn(*const CDirectConfig, *mut *mut CDirectRawHandle) -> c_int;
type CDirectRestore = unsafe extern "C" fn(*const CDirectRestoreOptions) -> c_int;
type CDirectClose = unsafe extern "C" fn(*mut CDirectRawHandle) -> c_int;
type CDirectLastError = unsafe extern "C" fn(*mut CDirectRawHandle) -> *const c_char;

const OLIPHAUNT_ABI_VERSION: u32 = 6;

struct CDirectApi {
    _library: Library,
    init: CDirectInit,
    restore: CDirectRestore,
    close: CDirectClose,
    last_error: CDirectLastError,
}

impl CDirectApi {
    fn load_from_env() -> std::result::Result<Self, String> {
        let path = native_library_path()
            .ok_or_else(|| "native liboliphaunt dynamic library is not available".to_owned())?;
        let library = load_c_direct_library(&path)?;
        let init = load_c_symbol(&library, b"oliphaunt_init\0")?;
        let restore = load_c_symbol(&library, b"oliphaunt_restore\0")?;
        let close = load_c_symbol(&library, b"oliphaunt_close\0")?;
        let last_error = load_c_symbol(&library, b"oliphaunt_last_error\0")?;
        Ok(Self {
            _library: library,
            init,
            restore,
            close,
            last_error,
        })
    }

    fn open<'a>(
        &'a self,
        pgdata: &Path,
        runtime_dir: &Path,
    ) -> std::result::Result<CDirectHandle<'a>, String> {
        let pgdata = path_to_c_string(pgdata, "pgdata")?;
        let runtime_dir = path_to_c_string(runtime_dir, "runtime_dir")?;
        let username = CString::new("postgres").unwrap();
        let database = CString::new("postgres").unwrap();
        let config = CDirectConfig {
            abi_version: OLIPHAUNT_ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime_dir.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            reserved_flags: 0,
            startup_args: ptr::null(),
            startup_arg_count: 0,
        };
        let mut handle = ptr::null_mut();
        let rc = unsafe { (self.init)(&config, &mut handle) };
        if rc != 0 {
            return Err(self.last_error_text(handle).unwrap_or_else(|| {
                format!(
                    "oliphaunt_init failed with status {rc} for {}",
                    pgdata.to_string_lossy()
                )
            }));
        }
        if handle.is_null() {
            return Err("oliphaunt_init succeeded with a null handle".to_owned());
        }
        Ok(CDirectHandle {
            api: self,
            handle,
            closed: false,
        })
    }

    fn restore_physical_archive_replace(
        &self,
        root: &Path,
        bytes: &[u8],
    ) -> std::result::Result<(), String> {
        let root = path_to_c_string(root, "restore root")?;
        let options = CDirectRestoreOptions {
            abi_version: OLIPHAUNT_ABI_VERSION,
            root: root.as_ptr(),
            format: 2,
            data: bytes.as_ptr(),
            len: bytes.len(),
            flags: 1,
        };
        let rc = unsafe { (self.restore)(&options) };
        if rc != 0 {
            return Err(self.last_error_text(ptr::null_mut()).unwrap_or_else(|| {
                format!(
                    "oliphaunt_restore failed with status {rc} for {}",
                    root.to_string_lossy()
                )
            }));
        }
        Ok(())
    }

    fn last_error_text(&self, handle: *mut CDirectRawHandle) -> Option<String> {
        let ptr = unsafe { (self.last_error)(handle) };
        if ptr.is_null() {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned(),
        )
    }
}

struct CDirectHandle<'a> {
    api: &'a CDirectApi,
    handle: *mut CDirectRawHandle,
    closed: bool,
}

impl CDirectHandle<'_> {
    fn close(&mut self) -> std::result::Result<(), String> {
        if self.closed {
            return Ok(());
        }
        let rc = unsafe { (self.api.close)(self.handle) };
        self.closed = true;
        if rc != 0 {
            return Err(format!("oliphaunt_close failed with status {rc}"));
        }
        Ok(())
    }
}

impl Drop for CDirectHandle<'_> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn load_c_direct_library(path: &Path) -> std::result::Result<Library, String> {
    #[cfg(unix)]
    {
        use libloading::os::unix::{Library as UnixLibrary, RTLD_GLOBAL, RTLD_NOW};

        let library = unsafe { UnixLibrary::open(Some(path.as_os_str()), RTLD_NOW | RTLD_GLOBAL) }
            .map_err(|error| {
                format!(
                    "load native liboliphaunt library {}: {error}",
                    path.display()
                )
            })?;
        Ok(Library::from(library))
    }

    #[cfg(not(unix))]
    {
        unsafe { Library::new(path) }.map_err(|error| {
            format!(
                "load native liboliphaunt library {}: {error}",
                path.display()
            )
        })
    }
}

fn load_c_symbol<T: Copy>(library: &Library, name: &[u8]) -> std::result::Result<T, String> {
    let symbol = unsafe { library.get::<T>(name) }.map_err(|error| {
        format!(
            "native liboliphaunt is missing required symbol {}: {error}",
            String::from_utf8_lossy(name).trim_end_matches('\0')
        )
    })?;
    Ok(*symbol)
}

fn path_to_c_string(path: &Path, label: &str) -> std::result::Result<CString, String> {
    let text = path.to_string_lossy();
    CString::new(text.as_bytes()).map_err(|_| format!("{label} contains an interior NUL"))
}
