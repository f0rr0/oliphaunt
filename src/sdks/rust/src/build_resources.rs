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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_and_macro_contract_is_process_wide_and_immutable() {
        assert_eq!(registered_build_resources_dir(), None);

        let empty_error = register_build_resources_dir(PathBuf::new())
            .expect_err("an empty resource directory must be rejected");
        assert!(matches!(empty_error, Error::InvalidConfig(_)));
        assert_eq!(registered_build_resources_dir(), None);

        // Keep the singleton's complete contract in one test so ordinary
        // `cargo test` execution cannot make assertions order-dependent. If a
        // caller intentionally supplies the compile-time override while
        // testing this crate, use that path for the initial registration so
        // the macro's configured branch remains idempotent.
        let compile_time_resources = option_env!("OLIPHAUNT_RESOURCES_DIR").map(PathBuf::from);
        let registered = compile_time_resources
            .as_ref()
            .filter(|path| !path.as_os_str().is_empty())
            .cloned()
            .unwrap_or_else(|| PathBuf::from("oliphaunt-test-resources"));
        register_build_resources_dir(registered.clone())
            .expect("the first nonempty resource directory must be accepted");
        assert_eq!(registered_build_resources_dir(), Some(registered.clone()));

        register_build_resources_dir(registered.clone())
            .expect("registering the exact same resource directory must be idempotent");

        let replacement = if registered == PathBuf::from("oliphaunt-other-resources") {
            PathBuf::from("oliphaunt-third-resources")
        } else {
            PathBuf::from("oliphaunt-other-resources")
        };
        let replacement_error = register_build_resources_dir(replacement.clone())
            .expect_err("a process-wide resource directory must not be replaceable");
        let Error::InvalidConfig(message) = replacement_error else {
            panic!("replacement must fail as invalid configuration");
        };
        assert!(message.contains(&registered.display().to_string()));
        assert!(message.contains(&replacement.display().to_string()));
        assert_eq!(registered_build_resources_dir(), Some(registered.clone()));

        match compile_time_resources {
            Some(path) if path.as_os_str().is_empty() => {
                let error = crate::register_build_resources!()
                    .expect_err("an empty compile-time resource directory must be rejected");
                assert!(
                    matches!(error, Error::InvalidConfig(message) if message.contains("cannot be empty"))
                );
            }
            Some(_) => {
                crate::register_build_resources!().expect(
                    "the configured macro path must be idempotent with direct registration",
                );
            }
            None => {
                let error = crate::register_build_resources!()
                    .expect_err("the SDK crate itself has no oliphaunt-build configuration");
                let Error::InvalidConfig(message) = error else {
                    panic!("missing build resources must fail as invalid configuration");
                };
                assert!(message.contains("OLIPHAUNT_RESOURCES_DIR was not emitted"));
                assert!(message.contains("oliphaunt_build::configure()"));
            }
        }
        assert_eq!(registered_build_resources_dir(), Some(registered));
    }
}
