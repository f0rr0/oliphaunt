use crate::Result;
use std::path::PathBuf;
/// Register resources staged for the application by oliphaunt-build.
pub fn register_build_resources_dir(path: impl Into<PathBuf>) -> Result<()> {
    liboliphaunt_native_bindings::register_build_resources_dir(path).map_err(Into::into)
}

#[doc(hidden)]
pub fn __register_build_resources(path: Option<&str>) -> Result<()> {
    match path {
        Some(path) => register_build_resources_dir(path),
        None => Err(crate::Error::InvalidConfig(
            "OLIPHAUNT_RESOURCES_DIR was not emitted for this package; add oliphaunt-build as a build dependency and call oliphaunt_build::configure() from build.rs".to_owned(),
        )),
    }
}

/// Register the resources staged by `oliphaunt-build` for the current package.
///
/// The macro expands in the application crate, so it can read the
/// `OLIPHAUNT_RESOURCES_DIR` compile-time value emitted by
/// `oliphaunt_build::configure()`.
#[macro_export]
macro_rules! register_build_resources {
    () => {
        $crate::__register_build_resources(option_env!("OLIPHAUNT_RESOURCES_DIR"))
    };
}
