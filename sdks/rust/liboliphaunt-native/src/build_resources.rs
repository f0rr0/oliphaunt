use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use crate::error::{Error, Result};

static BUILD_RESOURCES_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

/// Register the Oliphaunt resource directory staged by `oliphaunt-build`.
///
/// Applications usually call their SDK registration macro once during startup
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_registration_is_immutable_and_idempotent() {
        assert!(matches!(
            register_build_resources_dir(""),
            Err(Error::InvalidConfig(_))
        ));
        assert_eq!(registered_build_resources_dir(), None);
        register_build_resources_dir("application-resources").unwrap();
        register_build_resources_dir("application-resources").unwrap();
        assert!(matches!(
            register_build_resources_dir("different-resources"),
            Err(Error::InvalidConfig(_))
        ));
        assert_eq!(
            registered_build_resources_dir(),
            Some(PathBuf::from("application-resources"))
        );
    }
}
