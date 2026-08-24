mod cache_key;
mod install;
mod locate;

use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;

use cache_key::{
    cached_runtime_is_valid_with_icu, runtime_cache_key_with_icu, runtime_cache_manifest_with_icu,
};
use install::install_cached_runtime_with_icu;
use locate::{
    locate_native_cluster_seed_dir, locate_native_embedded_modules_dir,
    locate_native_extension_artifact_dirs, locate_native_icu_data_dir, locate_native_install_dir,
    package_managed_resources_are_registered,
};

use super::{NativeCatalogProfile, NativeRuntimeProfile};
use crate::error::{Error, Result};
use crate::extension::Extension;

const ENV_RUNTIME_CACHE_DIR: &str = "OLIPHAUNT_RUNTIME_CACHE_DIR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResolvedRuntimeClosure {
    pub(super) runtime_dir: PathBuf,
    pub(super) catalog_profile: NativeCatalogProfile,
    pub(super) cluster_seed_dir: Option<PathBuf>,
}

pub(super) fn resolve_runtime_closure(
    profile: NativeRuntimeProfile,
    extensions: &[Extension],
    requested_catalog_profile: Option<NativeCatalogProfile>,
) -> Result<ResolvedRuntimeClosure> {
    let available_icu_data = locate_native_icu_data_dir();
    let catalog_profile = requested_catalog_profile.unwrap_or_else(|| {
        if available_icu_data.is_some() {
            NativeCatalogProfile::Icu
        } else {
            NativeCatalogProfile::Standard
        }
    });
    let icu_data = match catalog_profile {
        NativeCatalogProfile::Standard => None,
        NativeCatalogProfile::Icu => Some(available_icu_data.ok_or_else(|| {
            Error::Engine(
                "ICU was selected, but the package-managed ICU data tree is unavailable; add the matching oliphaunt-icu artifact or set OLIPHAUNT_ICU_DATA_DIR"
                    .to_owned(),
            )
        })?),
    };
    let runtime_dir = materialize_runtime(profile, extensions, icu_data.as_deref())?;
    let cluster_seed_dir = locate_native_cluster_seed_dir(catalog_profile);
    if requested_catalog_profile.is_none()
        && package_managed_resources_are_registered()
        && cluster_seed_dir.is_none()
    {
        return Err(Error::Engine(format!(
            "the package-managed {} runtime closure is missing its matching cluster seed",
            catalog_profile.id()
        )));
    }
    Ok(ResolvedRuntimeClosure {
        runtime_dir,
        catalog_profile,
        cluster_seed_dir,
    })
}

pub(super) fn materialize_runtime(
    profile: NativeRuntimeProfile,
    extensions: &[Extension],
    icu_data: Option<&Path>,
) -> Result<PathBuf> {
    let install_dir = locate_native_install_dir()?;
    let extension_artifact_dirs = locate_native_extension_artifact_dirs();
    let embedded_modules = if profile.needs_embedded_modules() {
        Some(locate_native_embedded_modules_dir(&install_dir)?)
    } else {
        None
    };
    let key = runtime_cache_key_with_icu(
        profile,
        &install_dir,
        embedded_modules.as_deref(),
        &extension_artifact_dirs,
        extensions,
        icu_data,
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

    if !cached_runtime_is_valid_with_icu(profile, &cache_dir, &key, extensions, icu_data.is_some())
    {
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

        let build_result = install_cached_runtime_with_icu(
            profile,
            &install_dir,
            embedded_modules.as_deref(),
            &extension_artifact_dirs,
            &build_dir,
            extensions,
            icu_data,
        );
        if let Err(error) = build_result {
            let _ = fs::remove_dir_all(&build_dir);
            return Err(error);
        }
        fs::write(
            build_dir.join(".manifest"),
            runtime_cache_manifest_with_icu(profile, &key, extensions, icu_data.is_some()),
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

pub(super) fn extension_artifact_root_for<'a>(
    install_dir: &'a std::path::Path,
    extension_artifact_dirs: &'a [PathBuf],
    extension: Extension,
) -> &'a std::path::Path {
    extension_artifact_dirs
        .iter()
        .find(|root| extension_artifact_root_contains(root, extension))
        .map(PathBuf::as_path)
        .unwrap_or(install_dir)
}

fn extension_artifact_root_contains(root: &std::path::Path, extension: Extension) -> bool {
    if extension.creates_extension() {
        return root
            .join("share/postgresql/extension")
            .join(format!("{}.control", extension.sql_name()))
            .is_file();
    }
    extension
        .native_module_file()
        .is_some_and(|module| root.join("lib/postgresql").join(module).is_file())
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn product_root_identity_uses_control_or_module_according_to_extension_contract() {
        let temp = TempTree::new("extension-product-root");
        let install_dir = temp.path().join("runtime");
        let product_root = temp
            .path()
            .join("resources/extension/oliphaunt-extension-contrib-pg18");
        fs::create_dir_all(&install_dir).expect("create fallback runtime");

        let amcheck_module = Extension::Amcheck
            .native_module_file()
            .expect("amcheck has a native module");
        write_artifact_file(&product_root, &format!("lib/postgresql/{amcheck_module}"));
        assert!(!extension_artifact_root_contains(
            &product_root,
            Extension::Amcheck
        ));
        assert_eq!(
            extension_artifact_root_for(
                &install_dir,
                std::slice::from_ref(&product_root),
                Extension::Amcheck,
            ),
            install_dir
        );

        write_artifact_file(&product_root, "share/postgresql/extension/amcheck.control");
        assert!(extension_artifact_root_contains(
            &product_root,
            Extension::Amcheck
        ));

        let auto_explain_module = Extension::AutoExplain
            .native_module_file()
            .expect("auto_explain has a native module");
        write_artifact_file(
            &product_root,
            &format!("lib/postgresql/{auto_explain_module}"),
        );
        assert!(!Extension::AutoExplain.creates_extension());
        assert!(extension_artifact_root_contains(
            &product_root,
            Extension::AutoExplain
        ));
        assert_eq!(
            extension_artifact_root_for(
                &install_dir,
                std::slice::from_ref(&product_root),
                Extension::AutoExplain,
            ),
            product_root
        );
    }

    fn write_artifact_file(root: &Path, relative: &str) {
        let file = root.join(relative);
        fs::create_dir_all(file.parent().expect("artifact file parent"))
            .expect("create artifact file parent");
        fs::write(file, b"test\n").expect("write artifact file");
    }

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "oliphaunt-runtime-test-{name}-{nanos}-{}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp tree");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
