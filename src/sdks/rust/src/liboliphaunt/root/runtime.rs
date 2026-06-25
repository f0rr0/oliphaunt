mod cache_key;
mod install;
mod locate;

use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;

use cache_key::{cached_runtime_is_valid, runtime_cache_key, runtime_cache_manifest};
use install::install_cached_runtime;
use locate::{
    locate_native_embedded_modules_dir, locate_native_install_dir, locate_native_tools_dir,
};

use super::NativeRuntimeProfile;
use crate::error::{Error, Result};
use crate::extension::Extension;

const ENV_RUNTIME_CACHE_DIR: &str = "OLIPHAUNT_RUNTIME_CACHE_DIR";

pub(super) fn materialize_runtime(
    profile: NativeRuntimeProfile,
    extensions: &[Extension],
) -> Result<PathBuf> {
    let install_dir = locate_native_install_dir()?;
    let tools_dir = locate_native_tools_dir(&install_dir);
    let embedded_modules = if profile.needs_embedded_modules() {
        Some(locate_native_embedded_modules_dir(&install_dir)?)
    } else {
        None
    };
    let key = runtime_cache_key(
        profile,
        &install_dir,
        tools_dir.as_deref(),
        embedded_modules.as_deref(),
        extensions,
    )?;
    let cache_root = runtime_cache_root()?;
    fs::create_dir_all(&cache_root).map_err(|err| {
        Error::Engine(format!(
            "create native runtime cache root {}: {err}",
            cache_root.display()
        ))
    })?;
    #[cfg(unix)]
    fs::set_permissions(&cache_root, fs::Permissions::from_mode(0o700)).map_err(|err| {
        Error::Engine(format!(
            "set permissions on native runtime cache root {}: {err}",
            cache_root.display()
        ))
    })?;

    let cache_dir = cache_root.join(&key);
    let lock_path = cache_root.join(format!("{key}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(&lock_path)
        .map_err(|err| {
            Error::Engine(format!(
                "open native runtime cache lock {}: {err}",
                lock_path.display()
            ))
        })?;
    lock.lock_exclusive().map_err(|err| {
        Error::Engine(format!(
            "lock native runtime cache {}: {err}",
            lock_path.display()
        ))
    })?;

    if !cached_runtime_is_valid(&cache_dir, &key, extensions) {
        let build_dir = cache_root.join(format!(
            ".build-{}-{}",
            std::process::id(),
            monotonic_cache_nonce()?
        ));
        if build_dir.exists() {
            fs::remove_dir_all(&build_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove stale native runtime build dir {}: {err}",
                    build_dir.display()
                ))
            })?;
        }
        fs::create_dir_all(&build_dir).map_err(|err| {
            Error::Engine(format!(
                "create native runtime build dir {}: {err}",
                build_dir.display()
            ))
        })?;

        let build_result = install_cached_runtime(
            profile,
            &install_dir,
            tools_dir.as_deref(),
            embedded_modules.as_deref(),
            &build_dir,
            extensions,
        );
        if let Err(error) = build_result {
            let _ = fs::remove_dir_all(&build_dir);
            return Err(error);
        }
        fs::write(
            build_dir.join(".manifest"),
            runtime_cache_manifest(profile, &key, extensions),
        )
        .map_err(|err| {
            Error::Engine(format!(
                "write native runtime cache manifest {}: {err}",
                build_dir.display()
            ))
        })?;
        fs::write(build_dir.join(".complete"), b"ok\n").map_err(|err| {
            Error::Engine(format!(
                "write native runtime cache completion marker {}: {err}",
                build_dir.display()
            ))
        })?;
        if cache_dir.exists() {
            fs::remove_dir_all(&cache_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove invalid native runtime cache {}: {err}",
                    cache_dir.display()
                ))
            })?;
        }
        fs::rename(&build_dir, &cache_dir).map_err(|err| {
            Error::Engine(format!(
                "publish native runtime cache {} -> {}: {err}",
                build_dir.display(),
                cache_dir.display()
            ))
        })?;
    }

    lock.unlock().map_err(|err| {
        Error::Engine(format!(
            "unlock native runtime cache {}: {err}",
            lock_path.display()
        ))
    })?;
    Ok(cache_dir)
}

pub(super) fn runtime_cache_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(ENV_RUNTIME_CACHE_DIR) {
        return Ok(PathBuf::from(path));
    }
    Ok(std::env::temp_dir().join("oliphaunt-runtime-cache"))
}

pub(super) fn monotonic_cache_nonce() -> Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))
}
