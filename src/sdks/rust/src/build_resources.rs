use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use crate::error::{Error, Result};

static BUILD_RESOURCES_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

pub use oliphaunt_resources::EmbeddedResource;

const BASE_RESOURCES: &[EmbeddedResource] = include!(env!("OLIPHAUNT_EMBEDDED_RESOURCES_RS"));
static EMBEDDED_BASE: OnceLock<std::result::Result<Option<PathBuf>, String>> = OnceLock::new();

pub(crate) fn prepare_base_resources() -> Result<Option<PathBuf>> {
    EMBEDDED_BASE
        .get_or_init(|| {
            if BASE_RESOURCES.is_empty() {
                return Ok(None);
            }
            materialize_embedded_resources(BASE_RESOURCES)
                .map(Some)
                .map_err(|error| error.to_string())
        })
        .clone()
        .map_err(Error::Engine)
}

pub(crate) fn embedded_base_resources_dir() -> Option<PathBuf> {
    EMBEDDED_BASE
        .get()
        .and_then(|result| result.as_ref().ok())
        .cloned()
        .flatten()
}

pub(crate) fn materialize_embedded_resources(files: &[EmbeddedResource]) -> Result<PathBuf> {
    use fs2::FileExt;
    use sha2::{Digest, Sha256};
    use std::fs::{self, OpenOptions};
    use std::path::{Component, Path};
    let mut selected = std::collections::BTreeMap::new();
    for &(relative, bytes, digest, executable) in files {
        if (relative.ends_with('/') && (!bytes.is_empty() || executable))
            || relative.is_empty()
            || relative.contains('\\')
            || relative.contains(':')
            || Path::new(relative)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(Error::InvalidConfig(format!(
                "invalid embedded resource path {relative:?}"
            )));
        }
        if format!("{:x}", Sha256::digest(bytes)) != digest {
            return Err(Error::InvalidConfig(format!(
                "embedded resource checksum mismatch: {relative}"
            )));
        }
        if let Some(previous) = selected.insert(relative, (bytes, digest, executable))
            && previous != (bytes, digest, executable)
        {
            return Err(Error::InvalidConfig(format!(
                "conflicting embedded resource: {relative}"
            )));
        }
    }
    let mut hash = Sha256::new();
    for (relative, (_, digest, executable)) in &selected {
        hash.update(relative.as_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        hash.update([u8::from(*executable)]);
    }
    let key = format!("{:x}", hash.finalize());
    let cache = std::env::var_os("OLIPHAUNT_RUNTIME_CACHE_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| {
            Error::Engine("no cache directory available for native resources".to_owned())
        })?
        .join("oliphaunt-embedded");
    let io = |error: std::io::Error| {
        Error::Engine(format!("prepare embedded native resources: {error}"))
    };
    fs::create_dir_all(&cache).map_err(io)?;
    if fs::symlink_metadata(&cache)
        .map_err(io)?
        .file_type()
        .is_symlink()
    {
        return Err(Error::Engine(
            "embedded resource cache must not be a symbolic link".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).map_err(io)?;
    }
    let lock_path = cache.join(format!("{key}.lock"));
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(Error::Engine(
            "embedded resource lock must not be a symbolic link".to_owned(),
        ));
    }
    let mut lock_options = OpenOptions::new();
    lock_options
        .create(true)
        .truncate(false)
        .read(true)
        .write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        lock_options.custom_flags(libc::O_NOFOLLOW);
    }
    let lock = lock_options.open(lock_path).map_err(io)?;
    lock.lock_exclusive().map_err(io)?;
    let directory = cache.join(&key);
    let expected_paths = selected
        .keys()
        .flat_map(|relative| {
            Path::new(relative)
                .ancestors()
                .filter(|path| !path.as_os_str().is_empty())
                .map(|path| directory.join(path))
                .collect::<Vec<_>>()
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut pending = vec![directory.clone()];
    let mut inventory_valid = true;
    while let Some(parent) = pending.pop() {
        let Ok(entries) = fs::read_dir(&parent) else {
            inventory_valid = false;
            break;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                inventory_valid = false;
                break;
            };
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                inventory_valid = false;
                break;
            };
            if !expected_paths.contains(&path)
                || kind.is_symlink()
                || (!kind.is_file() && !kind.is_dir())
            {
                inventory_valid = false;
                break;
            }
            if kind.is_dir() {
                pending.push(path);
            }
        }
        if !inventory_valid {
            break;
        }
    }
    let valid = inventory_valid
        && fs::symlink_metadata(&directory)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        && selected.iter().all(|(relative, (_, digest, executable))| {
            let path = directory.join(relative);
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                return false;
            };
            if relative.ends_with('/') {
                return metadata.is_dir() && !metadata.file_type().is_symlink();
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if (metadata.permissions().mode() & 0o111 != 0) != *executable {
                    return false;
                }
            }
            fs::read(path).is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == *digest)
        });
    if !valid {
        let staging = cache.join(format!(".{key}-{}", std::process::id()));
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(io)?;
        }
        fs::create_dir(&staging).map_err(io)?;
        for (relative, (bytes, _, executable)) in selected {
            let path = staging.join(relative);
            if relative.ends_with('/') {
                fs::create_dir_all(&path).map_err(io)?;
                continue;
            }
            fs::create_dir_all(path.parent().expect("resource parent")).map_err(io)?;
            fs::write(&path, bytes).map_err(io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    path,
                    fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
                )
                .map_err(io)?;
            }
        }
        if let Ok(metadata) = fs::symlink_metadata(&directory) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                fs::remove_file(&directory).map_err(io)?;
            } else {
                fs::remove_dir_all(&directory).map_err(io)?;
            }
        }
        fs::rename(staging, &directory).map_err(io)?;
    }
    FileExt::unlock(&lock).map_err(io)?;
    Ok(directory)
}

/// Register the Oliphaunt resource directory staged by `oliphaunt-build`.
///
/// Advanced preassembled deployments call [`crate::register_build_resources!`]
/// after their `build.rs` has called `oliphaunt_build::configure()`. Ordinary
/// applications use automatically embedded resources. The native
/// runtime locator uses this directory before source-tree layouts. Explicit
/// library and install-directory environment overrides take precedence.
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

pub(crate) fn resources_dir_candidates() -> Vec<PathBuf> {
    registered_build_resources_dir()
        .into_iter()
        .chain(std::env::var_os("OLIPHAUNT_RESOURCES_DIR").map(PathBuf::from))
        .chain(embedded_base_resources_dir())
        .collect()
}

/// Implementation of the exported registration macro.
#[doc(hidden)]
pub fn __register_build_resources(path: Option<&str>) -> Result<()> {
    let path = path.ok_or_else(|| Error::InvalidConfig(
        "OLIPHAUNT_RESOURCES_DIR was not emitted for this package; add oliphaunt-build as a build dependency and call oliphaunt_build::configure() from build.rs".to_owned(),
    ))?;
    register_build_resources_dir(path)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_resources_reject_unsafe_paths_and_repair_modified_cache_files() {
        use sha2::{Digest, Sha256};
        let digest: &'static str =
            Box::leak(format!("{:x}", Sha256::digest(b"resource cache test")).into_boxed_str());
        for relative in ["../escape", "/absolute", "C:/escape", "a/../escape"] {
            assert!(
                materialize_embedded_resources(&[(
                    relative,
                    b"resource cache test",
                    digest,
                    false
                )])
                .is_err()
            );
        }
        assert!(materialize_embedded_resources(&[("file", b"wrong", digest, false)]).is_err());
        let files = [(
            "extension/test/payload",
            &b"resource cache test"[..],
            digest,
            false,
        )];
        let root = materialize_embedded_resources(&files).unwrap();
        assert_eq!(root, materialize_embedded_resources(&files).unwrap());
        std::fs::write(root.join("extension/test/payload"), b"modified").unwrap();
        let repaired = materialize_embedded_resources(&files).unwrap();
        assert_eq!(
            std::fs::read(repaired.join("extension/test/payload")).unwrap(),
            b"resource cache test"
        );
        std::fs::write(root.join("unexpected.so"), b"unselected code").unwrap();
        materialize_embedded_resources(&files).unwrap();
        assert!(!root.join("unexpected.so").exists());
        #[cfg(unix)]
        {
            let outside = root.with_extension("symlink-test");
            std::fs::create_dir_all(outside.join("test")).unwrap();
            std::fs::write(outside.join("test/payload"), b"resource cache test").unwrap();
            std::fs::remove_dir_all(root.join("extension")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("extension")).unwrap();
            materialize_embedded_resources(&files).unwrap();
            assert!(
                !std::fs::symlink_metadata(root.join("extension"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(
                std::fs::read(outside.join("test/payload")).unwrap(),
                b"resource cache test"
            );
            std::fs::remove_dir_all(outside).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
        let directory_resources = [(
            "cluster-seed/files/pg_wal/",
            &b""[..],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            false,
        )];
        let directory_root = materialize_embedded_resources(&directory_resources).unwrap();
        assert!(directory_root.join("cluster-seed/files/pg_wal").is_dir());
        assert_eq!(
            directory_root,
            materialize_embedded_resources(&directory_resources).unwrap()
        );
        std::fs::remove_dir_all(directory_root).unwrap();
    }

    #[test]
    fn registration_and_macro_contract_is_process_wide_and_immutable() {
        assert_eq!(registered_build_resources_dir(), None);

        let empty_error = register_build_resources_dir(PathBuf::new())
            .expect_err("an empty resource directory must be rejected");
        assert_eq!(
            empty_error.kind(),
            crate::error::ErrorKind::InvalidConfiguration
        );
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

        let replacement =
            if registered.as_path() == std::path::Path::new("oliphaunt-other-resources") {
                PathBuf::from("oliphaunt-third-resources")
            } else {
                PathBuf::from("oliphaunt-other-resources")
            };
        let replacement_error = register_build_resources_dir(replacement.clone())
            .expect_err("a process-wide resource directory must not be replaceable");
        assert_eq!(
            replacement_error.kind(),
            crate::error::ErrorKind::InvalidConfiguration
        );
        let message = replacement_error.to_string();
        assert!(message.contains(&registered.display().to_string()));
        assert!(message.contains(&replacement.display().to_string()));
        assert_eq!(registered_build_resources_dir(), Some(registered.clone()));

        match compile_time_resources {
            Some(path) if path.as_os_str().is_empty() => {
                let error = crate::register_build_resources!()
                    .expect_err("an empty compile-time resource directory must be rejected");
                assert_eq!(error.kind(), crate::error::ErrorKind::InvalidConfiguration);
                assert!(error.to_string().contains("cannot be empty"));
            }
            Some(_) => {
                crate::register_build_resources!().expect(
                    "the configured macro path must be idempotent with direct registration",
                );
            }
            None => {
                let error = crate::register_build_resources!()
                    .expect_err("the SDK crate itself has no oliphaunt-build configuration");
                assert_eq!(error.kind(), crate::error::ErrorKind::InvalidConfiguration);
                let message = error.to_string();
                assert!(message.contains("OLIPHAUNT_RESOURCES_DIR was not emitted"));
                assert!(message.contains("oliphaunt_build::configure()"));
            }
        }
        assert_eq!(registered_build_resources_dir(), Some(registered));
    }
}
