use std::ffi::{CStr, CString, c_char, c_int, c_uchar, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow, bail, ensure};
use libloading::Library;

use crate::pglite::base::InstallOutcome;
use crate::pglite::config::{PostgresConfig, StartupConfig};
use crate::pglite::engine::EngineCapabilities;

const ABI_VERSION: u32 = 2;
const ENV_NATIVE_LIB: &str = "PGLITE_OXIDE_NATIVE_LIBPGLITE";

static NATIVE_INSTANCE_OPEN: AtomicBool = AtomicBool::new(false);

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
    version: VersionFn,
    capabilities: CapabilitiesFn,
    free_response: FreeResponseFn,
}

pub(crate) struct NativeLibPgliteSession {
    symbols: NativeSymbols,
    handle: *mut NativeHandle,
    paths: crate::pglite::base::PglitePaths,
    startup_config: StartupConfig,
    single_instance_guard: Option<NativeInstanceGuard>,
}

// SAFETY: `NativeLibPgliteSession` owns one opaque native backend handle. All
// handle operations require `&mut self`, so Rust prevents concurrent access to
// the handle. Moving the owner between threads does not duplicate the handle or
// the process-global instance guard.
unsafe impl Send for NativeLibPgliteSession {}

impl NativeLibPgliteSession {
    pub(crate) fn open(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        let guard = NativeInstanceGuard::acquire()?;

        let symbols = NativeSymbols::load_from_env()?;
        let pgdata = path_to_cstring(outcome.paths.pgdata.clone(), "PGDATA")?;
        let runtime_dir = path_to_cstring(outcome.paths.runtime_root(), "runtime root")?;
        let username = CString::new(startup_config.username.clone())
            .context("native libpglite username contains an interior NUL")?;
        let database = CString::new(startup_config.database.clone())
            .context("native libpglite database contains an interior NUL")?;
        let startup_args = native_startup_args(&postgres_config, &startup_config)?;
        let startup_arg_ptrs = startup_args
            .iter()
            .map(|arg| arg.as_ptr())
            .collect::<Vec<_>>();
        let config = NativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime_dir.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            reserved_flags: 0,
            startup_args: startup_arg_ptrs.as_ptr(),
            startup_arg_count: startup_arg_ptrs.len(),
        };

        let mut handle: *mut NativeHandle = ptr::null_mut();
        let rc = unsafe { (symbols.init)(&config, &mut handle) };
        if rc != 0 || handle.is_null() {
            let message = symbols
                .last_error_text(handle)
                .unwrap_or_else(|| format!("pglite_init failed with status {rc}"));
            bail!("native libpglite init failed: {message}");
        }

        Ok(Self {
            symbols,
            handle,
            paths: outcome.paths,
            startup_config,
            single_instance_guard: Some(guard),
        })
    }

    pub(crate) fn paths(&self) -> &crate::pglite::base::PglitePaths {
        &self.paths
    }

    pub(crate) fn startup_config(&self) -> &StartupConfig {
        &self.startup_config
    }

    pub(crate) fn capabilities(&self) -> EngineCapabilities {
        let version = self.symbols.version_text();
        let flags = unsafe { (self.symbols.capabilities)() };
        EngineCapabilities::native_libpglite(version, flags)
    }

    pub(crate) fn send_buffered(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        self.with_buffered_response(message, |data| Ok(data.to_vec()))
    }

    pub(crate) fn with_buffered_response<T>(
        &mut self,
        message: &[u8],
        f: impl FnOnce(&[u8]) -> Result<T>,
    ) -> Result<T> {
        ensure!(!self.handle.is_null(), "native libpglite backend is closed");
        let mut response = NativeResponse {
            data: ptr::null_mut(),
            len: 0,
        };
        let rc = unsafe {
            (self.symbols.exec_protocol)(
                self.handle,
                message.as_ptr(),
                message.len(),
                &mut response,
            )
        };
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(self.handle)
                .unwrap_or_else(|| format!("pglite_exec_protocol failed with status {rc}"));
            bail!("native libpglite protocol execution failed: {message}");
        }
        if response.data.is_null() {
            return f(&[]);
        }
        let out = unsafe { std::slice::from_raw_parts(response.data, response.len) };
        let result = f(out);
        unsafe { (self.symbols.free_response)(&mut response) };
        result
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        if self.handle.is_null() {
            return Ok(());
        }
        let handle = self.handle;
        self.handle = ptr::null_mut();
        let rc = unsafe { (self.symbols.close)(handle) };
        if rc != 0 {
            let message = self
                .symbols
                .last_error_text(ptr::null_mut())
                .unwrap_or_else(|| format!("pglite_close failed with status {rc}"));
            bail!("native libpglite close failed: {message}");
        }
        self.single_instance_guard = None;
        Ok(())
    }
}

struct NativeInstanceGuard;

impl NativeInstanceGuard {
    fn acquire() -> Result<Self> {
        NATIVE_INSTANCE_OPEN
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| {
                anyhow!("native libpglite v1 supports only one open instance per process")
            })?;
        Ok(Self)
    }
}

impl Drop for NativeInstanceGuard {
    fn drop(&mut self) {
        NATIVE_INSTANCE_OPEN.store(false, Ordering::Release);
    }
}

fn native_startup_args(
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
) -> Result<Vec<CString>> {
    let mut args = Vec::new();
    if let Some(level) = startup_config.debug_level {
        args.push("-d".to_owned());
        args.push(level.to_string());
    }
    if startup_config.relaxed_durability {
        args.push("-c".to_owned());
        args.push("synchronous_commit=off".to_owned());
    }
    for (name, value) in postgres_config.iter() {
        args.push("-c".to_owned());
        args.push(format!("{name}={value}"));
    }
    args.extend(startup_config.extra_args.iter().cloned());
    args.into_iter()
        .map(|arg| {
            CString::new(arg).context("native libpglite startup argument contains an interior NUL")
        })
        .collect()
}

impl Drop for NativeLibPgliteSession {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

impl NativeSymbols {
    fn load_from_env() -> Result<Self> {
        let path = std::env::var_os(ENV_NATIVE_LIB)
            .map(PathBuf::from)
            .ok_or_else(|| {
                anyhow!(
                    "{ENV_NATIVE_LIB} is not set; build the native libpglite spike and point this env var at the dylib"
                )
            })?;
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
            version,
            capabilities,
            free_response,
        })
    }

    fn version_text(&self) -> String {
        let ptr = unsafe { (self.version)() };
        c_string_lossy(ptr).unwrap_or_else(|| "unknown".to_owned())
    }

    fn last_error_text(&self, handle: *mut NativeHandle) -> Option<String> {
        let ptr = unsafe { (self.last_error)(handle) };
        c_string_lossy(ptr)
    }
}

fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
    let symbol = unsafe { library.get::<T>(name) }.with_context(|| {
        format!(
            "native libpglite is missing required symbol {}",
            String::from_utf8_lossy(name).trim_end_matches('\0')
        )
    })?;
    Ok(*symbol)
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

fn load_native_library(path: &Path) -> Result<Library> {
    #[cfg(unix)]
    {
        use libloading::os::unix::{Library as UnixLibrary, RTLD_GLOBAL, RTLD_NOW};

        // PostgreSQL dynamically loads core modules such as plpgsql; those
        // bundles resolve backend symbols from the embedding process.
        let library = unsafe { UnixLibrary::open(Some(path.as_os_str()), RTLD_NOW | RTLD_GLOBAL) }
            .with_context(|| {
                format!(
                    "load native libpglite library {} with global symbol visibility",
                    path.display()
                )
            })?;
        Ok(Library::from(library))
    }
    #[cfg(not(unix))]
    {
        let library = unsafe { Library::new(path) }
            .with_context(|| format!("load native libpglite library {}", path.display()))?;
        Ok(library)
    }
}

fn path_to_cstring(path: PathBuf, label: &str) -> Result<CString> {
    CString::new(path.to_string_lossy().as_bytes())
        .with_context(|| format!("native libpglite {label} contains an interior NUL"))
}
