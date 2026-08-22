use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// Storage used by a native database instance.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DatabaseStorage {
    /// SDK-owned temporary directory.
    #[default]
    TemporaryDirectory,
    /// Caller-owned persistent directory.
    Directory(PathBuf),
}

pub(crate) fn path_contains_nul(path: &Path) -> bool {
    #[cfg(unix)]
    {
        path.as_os_str().as_bytes().contains(&0)
    }
    #[cfg(windows)]
    {
        path.as_os_str().encode_wide().any(|unit| unit == 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.to_string_lossy().bytes().any(|byte| byte == 0)
    }
}
