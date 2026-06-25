use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use crate::error::{Error, Result};

static BUILD_RESOURCES_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

/// Register the Oliphaunt resource directory staged by `oliphaunt-build`.
///
/// Applications usually call [`register_build_resources!`] once during startup
/// after their `build.rs` has called `oliphaunt_build::configure()`. The native
/// runtime locator uses this directory before falling back to explicit
/// environment variables and source-tree build layouts.
pub fn register_build_resources_dir(path: impl Into<PathBuf>) -> Result<()> {
    let path = path.into();
    if path.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "Oliphaunt build resources directory cannot be empty".to_owned(),
        ));
    }

    let lock = BUILD_RESOURCES_DIR.get_or_init(|| RwLock::new(None));
    let mut guard = lock
        .write()
        .map_err(|_| Error::Engine("Oliphaunt build resources registry was poisoned".to_owned()))?;
    if let Some(existing) = guard.as_ref() {
        if existing == &path {
            return Ok(());
        }
        return Err(Error::InvalidConfig(format!(
            "Oliphaunt build resources are already registered as {}; cannot replace them with {}",
            existing.display(),
            path.display()
        )));
    }
    *guard = Some(path);
    Ok(())
}

pub(crate) fn registered_build_resources_dir() -> Option<PathBuf> {
    BUILD_RESOURCES_DIR
        .get()
        .and_then(|lock| lock.read().ok().and_then(|guard| guard.clone()))
}

/// Register the resources staged by `oliphaunt-build` for the current package.
///
/// The macro expands in the application crate, so it can read the
/// `OLIPHAUNT_RESOURCES_DIR` compile-time value emitted by
/// `oliphaunt_build::configure()`.
#[macro_export]
macro_rules! register_build_resources {
    () => {
        match option_env!("OLIPHAUNT_RESOURCES_DIR") {
            Some(path) => $crate::register_build_resources_dir(path),
            None => Err($crate::Error::InvalidConfig(
                "OLIPHAUNT_RESOURCES_DIR was not emitted for this package; add oliphaunt-build as a build dependency and call oliphaunt_build::configure() from build.rs"
                    .to_owned(),
            )),
        }
    };
}
