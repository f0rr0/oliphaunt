use std::fs;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use super::super::NativeRuntimeProfile;
use super::super::extensions::{
    ResolvedExtensionModules, copy_embedded_module, copy_extension_data_files,
    copy_extension_sql_files, copy_named_extension_sql_files, core_share_file,
    embedded_core_module_files, packaged_extension_module_files,
};
use super::super::files::{
    copy_directory_filtered, copy_directory_tree, copy_file_preserving_permissions,
    remove_file_if_exists,
};
use super::super::{NATIVE_RUNTIME_TOOLS, existing_native_tool_path, native_tool_path};
use crate::error::{Error, Result};
#[cfg(test)]
use crate::extension::Extension;

#[cfg(test)]
pub(super) fn install_cached_runtime(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    embedded_modules: Option<&Path>,
    extension_artifact_dirs: &[PathBuf],
    runtime_dir: &Path,
    extensions: &[Extension],
) -> Result<()> {
    let extension_modules = super::super::extensions::resolve_extension_modules(
        profile,
        install_dir,
        extension_artifact_dirs,
        extensions,
    )?;
    install_cached_runtime_with_icu(
        profile,
        install_dir,
        embedded_modules,
        runtime_dir,
        &extension_modules,
        None,
    )
}

pub(super) fn install_cached_runtime_with_icu(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    embedded_modules: Option<&Path>,
    runtime_dir: &Path,
    extension_modules: &[ResolvedExtensionModules],
    icu_data: Option<&Path>,
) -> Result<()> {
    fs::create_dir_all(runtime_dir).map_err(|err| {
        Error::Engine(format!(
            "create native runtime dir {}: {err}",
            runtime_dir.display()
        ))
    })?;

    for tool in NATIVE_RUNTIME_TOOLS {
        install_required_runtime_tool(install_dir, runtime_dir, tool, "native runtime")?;
    }

    install_native_share_tree(install_dir, runtime_dir, extension_modules)?;
    install_native_library_tree(
        profile,
        install_dir,
        embedded_modules,
        runtime_dir,
        extension_modules,
    )?;
    if let Some(icu_data) = icu_data {
        copy_directory_tree(
            icu_data,
            &runtime_dir.join("share/icu"),
            super::super::files::CopyMode::ByteCopy,
        )?;
    }
    Ok(())
}

fn install_required_runtime_tool(
    source_root: &Path,
    runtime_dir: &Path,
    tool: &str,
    label: &str,
) -> Result<()> {
    let source = existing_native_tool_path(source_root, tool);
    if !source.is_file() {
        return Err(Error::Engine(format!(
            "{label} artifact is missing required PostgreSQL tool {tool} at {}",
            source.display()
        )));
    }
    install_runtime_tool(&source, &native_tool_path(runtime_dir, tool))
}

fn install_runtime_tool(source: &Path, destination: &Path) -> Result<()> {
    copy_file_preserving_permissions(source, destination)?;
    ensure_runtime_tool_executable(destination)
}

#[cfg(unix)]
fn ensure_runtime_tool_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::metadata(path).map_err(|err| {
        Error::Engine(format!(
            "stat native runtime tool {}: {err}",
            path.display()
        ))
    })?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    if mode & 0o111 != 0 {
        return Ok(());
    }
    permissions.set_mode(mode | 0o111);
    fs::set_permissions(path, permissions).map_err(|err| {
        Error::Engine(format!(
            "set executable permissions on native runtime tool {}: {err}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn ensure_runtime_tool_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn install_native_share_tree(
    install_dir: &Path,
    runtime_dir: &Path,
    extension_modules: &[ResolvedExtensionModules],
) -> Result<()> {
    let source_share = install_dir.join("share/postgresql");
    let target_share = runtime_dir.join("share/postgresql");
    if !source_share.is_dir() {
        return Err(Error::Engine(format!(
            "native PostgreSQL install is missing share/postgresql at {}",
            source_share.display()
        )));
    }

    copy_directory_filtered(&source_share, &target_share, core_share_file)?;
    remove_file_if_exists(&target_share.join("tsearch_data/unaccent.rules"))?;
    remove_file_if_exists(&target_share.join("tsearch_data/xsyn_sample.rules"))?;

    let target_extension_dir = target_share.join("extension");
    fs::create_dir_all(&target_extension_dir).map_err(|err| {
        Error::Engine(format!("create {}: {err}", target_extension_dir.display()))
    })?;

    copy_named_extension_sql_files(&source_share, &target_share, "plpgsql", true)?;
    for extension in extension_modules {
        let extension_share = extension.source_root.join("share/postgresql");
        copy_extension_sql_files(&extension_share, &target_share, extension.extension)?;
        copy_extension_data_files(&extension_share, &target_share, extension.extension)?;
    }
    Ok(())
}

#[allow(clippy::items_after_test_module)] // Installation helpers remain below their contract tests for locality.
#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::extension::{extension_data_files, resolve_extensions};

    #[test]
    fn install_rejects_missing_transitive_extension_dependency_assets() {
        let temp = TempTree::new("missing-transitive-extension-assets");
        let install_dir = temp.path().join("install");
        write_minimal_install(&install_dir);
        write_extension_assets(&install_dir, Extension::EARTHDISTANCE);

        let extensions = resolve_extensions(&[Extension::EARTHDISTANCE]).unwrap();
        assert_eq!(extensions, vec![Extension::CUBE, Extension::EARTHDISTANCE]);

        let error = install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &temp.path().join("runtime"),
            &extensions,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("native extension 'cube'"),
            "unexpected missing-dependency error: {error}"
        );
        assert!(
            error.to_string().contains("missing control file"),
            "unexpected missing-dependency error: {error}"
        );
    }

    #[test]
    fn install_copies_only_selected_extension_assets() {
        let temp = TempTree::new("selected-extension-assets");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_extension_assets(&install_dir, Extension::VECTOR);
        write_extension_assets(&install_dir, Extension::HSTORE);

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[Extension::VECTOR],
        )
        .unwrap();

        assert!(
            runtime_dir
                .join("share/postgresql/extension/vector.control")
                .is_file()
        );
        assert!(
            runtime_dir
                .join("lib/postgresql")
                .join(Extension::VECTOR.native_module_file().unwrap())
                .is_file()
        );
        assert!(
            !runtime_dir
                .join("share/postgresql/extension/hstore.control")
                .exists(),
            "unselected hstore SQL assets must not leak into vector-only packages"
        );
        assert!(
            !runtime_dir
                .join("lib/postgresql")
                .join(Extension::HSTORE.native_module_file().unwrap())
                .exists(),
            "unselected hstore module must not leak into vector-only packages"
        );
    }

    #[test]
    fn install_copies_selected_extension_assets_from_sidecar_artifact() {
        let temp = TempTree::new("sidecar-extension-assets");
        let install_dir = temp.path().join("install");
        let extension_dir = temp
            .path()
            .join("extension/oliphaunt-extension-contrib-pg18");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::HSTORE);

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[extension_dir],
            &runtime_dir,
            &[Extension::HSTORE],
        )
        .unwrap();

        assert!(
            runtime_dir
                .join("share/postgresql/extension/hstore.control")
                .is_file()
        );
        assert!(
            runtime_dir
                .join("lib/postgresql")
                .join(Extension::HSTORE.native_module_file().unwrap())
                .is_file()
        );
    }

    #[test]
    fn install_selects_distinct_server_and_embedded_sidecar_modules() {
        let temp = TempTree::new("dual-profile-sidecar-extension");
        let install_dir = temp.path().join("install");
        let extension_dir = temp
            .path()
            .join("extension/oliphaunt-extension-contrib-pg18");
        let embedded_modules = temp.path().join("embedded-modules");
        let server_runtime = temp.path().join("server-runtime");
        let embedded_runtime = temp.path().join("embedded-runtime");
        let module = Extension::HSTORE
            .native_module_file()
            .expect("hstore has a native module");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::HSTORE);
        write_file(
            &extension_dir.join("lib/postgresql").join(&module),
            b"server-profile-module\n",
        );
        write_file(
            &extension_dir.join("lib/modules").join(&module),
            b"embedded-profile-module\n",
        );
        for core_module in embedded_core_module_files() {
            write_file(
                &embedded_modules.join(core_module),
                b"embedded-core-module\n",
            );
        }
        write_file(
            &embedded_modules.join(&module),
            b"global-fallback-must-not-win\n",
        );

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            std::slice::from_ref(&extension_dir),
            &server_runtime,
            &[Extension::HSTORE],
        )
        .unwrap();
        install_cached_runtime(
            NativeRuntimeProfile::OliphauntEmbedded,
            &install_dir,
            Some(&embedded_modules),
            &[extension_dir],
            &embedded_runtime,
            &[Extension::HSTORE],
        )
        .unwrap();

        assert_eq!(
            fs::read(server_runtime.join("lib/postgresql").join(&module)).unwrap(),
            b"server-profile-module\n"
        );
        assert_eq!(
            fs::read(embedded_runtime.join("lib/postgresql").join(module)).unwrap(),
            b"embedded-profile-module\n"
        );
    }

    #[test]
    fn install_copies_declared_dependency_modules_from_the_selected_profile() {
        let temp = TempTree::new("selected-dependency-modules");
        let install_dir = temp.path().join("install");
        let extension_dir = temp.path().join("postgis-sidecar");
        let embedded_modules = temp.path().join("embedded-modules");
        write_minimal_install(&install_dir);
        write_extension_assets(&install_dir, Extension::POSTGIS);
        write_extension_assets(&install_dir, Extension::HSTORE);
        write_extension_assets(&extension_dir, Extension::POSTGIS);
        for relative in extension_data_files(Extension::POSTGIS) {
            write_file(
                &extension_dir.join("share/postgresql").join(relative),
                b"postgis data",
            );
        }
        for module in embedded_core_module_files() {
            write_file(&embedded_modules.join(module), b"embedded core");
        }
        for module in Extension::POSTGIS.native_module_files() {
            write_file(
                &extension_dir.join("lib/postgresql").join(&module),
                b"server module",
            );
            write_file(
                &extension_dir.join("lib/modules").join(&module),
                b"embedded module",
            );
            write_file(
                &embedded_modules.join(module),
                b"global fallback must not win",
            );
        }
        for (profile, expected) in [
            (
                NativeRuntimeProfile::PostgresServer,
                b"server module".as_slice(),
            ),
            (
                NativeRuntimeProfile::OliphauntEmbedded,
                b"embedded module".as_slice(),
            ),
        ] {
            let runtime = temp.path().join(profile.cache_id());
            install_cached_runtime(
                profile,
                &install_dir,
                Some(&embedded_modules),
                std::slice::from_ref(&extension_dir),
                &runtime,
                &[Extension::POSTGIS],
            )
            .unwrap();
            for module in Extension::POSTGIS.native_module_files() {
                assert_eq!(
                    fs::read(runtime.join("lib/postgresql").join(module)).unwrap(),
                    expected
                );
            }
            assert!(
                !runtime
                    .join("lib/postgresql")
                    .join(Extension::HSTORE.native_module_file().unwrap())
                    .exists()
            );
        }
    }

    #[test]
    fn install_rejects_missing_declared_dependency_modules_in_both_profiles() {
        let temp = TempTree::new("missing-dependency-modules");
        let install_dir = temp.path().join("install");
        let extension_dir = temp.path().join("postgis-sidecar");
        let embedded_modules = temp.path().join("embedded-modules");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::POSTGIS);
        for relative in extension_data_files(Extension::POSTGIS) {
            write_file(
                &extension_dir.join("share/postgresql").join(relative),
                b"postgis data",
            );
        }
        for module in embedded_core_module_files() {
            write_file(&embedded_modules.join(module), b"embedded core");
        }
        let main_module = Extension::POSTGIS.native_module_file().unwrap();
        write_file(
            &extension_dir.join("lib/modules").join(&main_module),
            b"embedded module",
        );
        let dependency = Extension::POSTGIS
            .native_module_files()
            .find(|module| module != &main_module)
            .unwrap();
        write_file(
            &extension_dir.join("extension.json"),
            serde_json::json!({
                "schema": "oliphaunt-extension-member-payload-v1",
                "sql_name": "postgis",
                "dependency_modules": [&dependency],
            })
            .to_string()
            .as_bytes(),
        );
        fs::remove_file(extension_dir.join("lib/postgresql").join(&dependency)).unwrap();
        for profile in [
            NativeRuntimeProfile::PostgresServer,
            NativeRuntimeProfile::OliphauntEmbedded,
        ] {
            let error = install_cached_runtime(
                profile,
                &install_dir,
                Some(&embedded_modules),
                std::slice::from_ref(&extension_dir),
                &temp.path().join(profile.cache_id()),
                &[Extension::POSTGIS],
            )
            .unwrap_err();
            assert!(
                error.to_string().contains(&dependency),
                "unexpected dependency error: {error}"
            );
        }
    }

    #[test]
    fn install_preserves_legacy_statically_linked_modules_in_both_profiles() {
        let temp = TempTree::new("legacy-static-dependency-modules");
        let install_dir = temp.path().join("install");
        let extension_dir = temp.path().join("postgis-sidecar");
        let embedded_modules = temp.path().join("embedded-modules");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::POSTGIS);
        let main = Extension::POSTGIS.native_module_file().unwrap();
        for module in Extension::POSTGIS
            .native_module_files()
            .filter(|module| module != &main)
        {
            fs::remove_file(extension_dir.join("lib/postgresql").join(module)).unwrap();
        }
        for relative in extension_data_files(Extension::POSTGIS) {
            write_file(
                &extension_dir.join("share/postgresql").join(relative),
                b"postgis data",
            );
        }
        for module in embedded_core_module_files() {
            write_file(&embedded_modules.join(module), b"embedded core");
        }
        write_file(
            &extension_dir.join("lib/modules").join(&main),
            b"static embedded module",
        );
        let resolved = super::super::super::extensions::resolve_extension_modules(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            std::slice::from_ref(&extension_dir),
            &[Extension::POSTGIS],
        )
        .unwrap();
        assert_eq!(resolved[0].files, vec![main.clone()]);
        for profile in [
            NativeRuntimeProfile::PostgresServer,
            NativeRuntimeProfile::OliphauntEmbedded,
        ] {
            let runtime = temp.path().join(profile.cache_id());
            install_cached_runtime(
                profile,
                &install_dir,
                Some(&embedded_modules),
                std::slice::from_ref(&extension_dir),
                &runtime,
                &[Extension::POSTGIS],
            )
            .unwrap();
            fs::write(runtime.join(".complete"), b"ok").unwrap();
            fs::write(
                runtime.join(".manifest"),
                super::super::cache_key::runtime_cache_manifest(
                    profile,
                    "legacy-key",
                    &[Extension::POSTGIS],
                ),
            )
            .unwrap();
            assert!(super::super::cache_key::cached_runtime_is_valid_with_icu(
                profile,
                &runtime,
                "legacy-key",
                &resolved,
                false
            ));
            assert!(runtime.join("lib/postgresql").join(&main).is_file());
        }
    }

    #[test]
    fn install_excludes_unselected_dependency_modules_from_the_base_install() {
        let temp = TempTree::new("unselected-dependency-modules");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_extension_assets(&install_dir, Extension::POSTGIS);
        write_extension_assets(&install_dir, Extension::HSTORE);
        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[Extension::HSTORE],
        )
        .unwrap();
        for module in Extension::POSTGIS.native_module_files() {
            assert!(!runtime_dir.join("lib/postgresql").join(module).exists());
        }
    }

    #[test]
    fn declared_embedded_modules_cannot_use_different_global_fallback_bytes() {
        let temp = TempTree::new("declared-embedded-no-fallback");
        let install_dir = temp.path().join("install");
        let extension_dir = temp.path().join("postgis-sidecar");
        let embedded_modules = temp.path().join("embedded-modules");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::POSTGIS);
        for relative in extension_data_files(Extension::POSTGIS) {
            write_file(
                &extension_dir.join("share/postgresql").join(relative),
                b"postgis data",
            );
        }
        for module in embedded_core_module_files() {
            write_file(&embedded_modules.join(module), b"embedded core");
        }
        let files: Vec<_> = Extension::POSTGIS.native_module_files().collect();
        let package = Box::leak(Box::new(crate::ExtensionPackage {
            product: "oliphaunt-extension-postgis",
            version: "3.6.4",
            runtime_version: "0.3.3",
            resources: Box::leak(
                files
                    .iter()
                    .map(|module| {
                        let relative: &'static str = Box::leak(
                            format!("extension/oliphaunt-extension-postgis/lib/modules/{module}")
                                .into_boxed_str(),
                        );
                        (
                            relative,
                            b"selected embedded".as_slice(),
                            "unused-in-resolver",
                            true,
                        )
                    })
                    .collect::<Vec<_>>()
                    .into_boxed_slice(),
            ),
        }));
        for extension in [Extension::POSTGIS, Extension::POSTGIS.with_package(package)] {
            write_file(&extension_dir.join("extension.json"), serde_json::json!({
                "schema": "oliphaunt-extension-member-payload-v1", "sql_name": "postgis", "dependency_modules": &files[1..],
            }).to_string().as_bytes());
            for missing in &files {
                for module in &files {
                    write_file(
                        &extension_dir.join("lib/modules").join(module),
                        b"selected embedded",
                    );
                    write_file(&embedded_modules.join(module), b"different global bytes");
                }
                fs::remove_file(extension_dir.join("lib/modules").join(missing)).unwrap();
                let key = || {
                    super::super::cache_key::runtime_cache_key(
                        NativeRuntimeProfile::OliphauntEmbedded,
                        &install_dir,
                        Some(&embedded_modules),
                        std::slice::from_ref(&extension_dir),
                        &[extension],
                    )
                    .unwrap()
                };
                let missing_key = key();
                write_file(
                    &embedded_modules.join(missing),
                    b"global bytes changed again",
                );
                assert_eq!(
                    missing_key,
                    key(),
                    "missing declared files must not hash global fallback bytes"
                );
                let error = install_cached_runtime(
                    NativeRuntimeProfile::OliphauntEmbedded,
                    &install_dir,
                    Some(&embedded_modules),
                    std::slice::from_ref(&extension_dir),
                    &temp.path().join("runtime"),
                    &[extension],
                )
                .unwrap_err();
                assert!(
                    error.to_string().contains(
                        &extension_dir
                            .join("lib/modules")
                            .join(missing)
                            .display()
                            .to_string()
                    ),
                    "unexpected owned-file error: {error}"
                );
                write_file(
                    &extension_dir.join("lib/modules").join(missing),
                    b"selected embedded",
                );
                assert_ne!(
                    missing_key,
                    key(),
                    "restoring the original declared file must change its cache identity"
                );
            }
        }
    }

    #[test]
    fn legacy_primary_modules_keep_their_undeclared_embedded_fallback() {
        let temp = TempTree::new("legacy-primary-fallback");
        let install_dir = temp.path().join("install");
        let extension_dir = temp.path().join("hstore-sidecar");
        let embedded_modules = temp.path().join("embedded-modules");
        write_minimal_install(&install_dir);
        write_extension_assets(&extension_dir, Extension::HSTORE);
        for module in embedded_core_module_files() {
            write_file(&embedded_modules.join(module), b"embedded core");
        }
        let main = Extension::HSTORE.native_module_file().unwrap();
        let old_path: &'static str = Box::leak(
            format!("extension/oliphaunt-extension-contrib-pg18/lib/postgresql/{main}")
                .into_boxed_str(),
        );
        let old_package = Box::leak(Box::new(crate::ExtensionPackage {
            product: "oliphaunt-extension-contrib-pg18",
            version: "0.3.3",
            runtime_version: "0.3.3",
            resources: Box::leak(
                vec![(
                    old_path,
                    b"legacy server".as_slice(),
                    "unused-in-resolver",
                    true,
                )]
                .into_boxed_slice(),
            ),
        }));
        for (index, extension) in [
            Extension::HSTORE,
            Extension::HSTORE.with_package(old_package),
        ]
        .into_iter()
        .enumerate()
        {
            let runtime = temp.path().join(format!("runtime-{index}"));
            write_file(&embedded_modules.join(&main), b"legacy embedded v1");
            let key = || {
                super::super::cache_key::runtime_cache_key(
                    NativeRuntimeProfile::OliphauntEmbedded,
                    &install_dir,
                    Some(&embedded_modules),
                    std::slice::from_ref(&extension_dir),
                    &[extension],
                )
                .unwrap()
            };
            let first = key();
            install_cached_runtime(
                NativeRuntimeProfile::OliphauntEmbedded,
                &install_dir,
                Some(&embedded_modules),
                std::slice::from_ref(&extension_dir),
                &runtime,
                &[extension],
            )
            .unwrap();
            assert_eq!(
                fs::read(runtime.join("lib/postgresql").join(&main)).unwrap(),
                b"legacy embedded v1"
            );
            write_file(&embedded_modules.join(&main), b"legacy embedded v2");
            assert_ne!(
                first,
                key(),
                "allowed legacy fallback bytes must remain part of cache identity"
            );
        }
    }

    #[test]
    fn install_copies_module_only_extension_from_product_sidecar() {
        let temp = TempTree::new("module-only-sidecar-extension");
        let install_dir = temp.path().join("install");
        let extension_dir = temp
            .path()
            .join("extension/oliphaunt-extension-contrib-pg18");
        let runtime_dir = temp.path().join("runtime");
        let module = Extension::AUTO_EXPLAIN
            .native_module_file()
            .expect("auto_explain has a native module");
        write_minimal_install(&install_dir);
        write_file(
            &extension_dir.join("lib/postgresql").join(&module),
            b"auto_explain module\n",
        );

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[extension_dir],
            &runtime_dir,
            &[Extension::AUTO_EXPLAIN],
        )
        .unwrap();

        assert_eq!(
            fs::read(runtime_dir.join("lib/postgresql").join(module)).unwrap(),
            b"auto_explain module\n"
        );
        assert!(
            !runtime_dir
                .join("share/postgresql/extension/auto_explain.control")
                .exists()
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_restores_executable_bits_for_runtime_tools() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempTree::new("runtime-tool-permissions");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_file(&install_dir.join("bin/initdb"), b"initdb");
        write_file(&install_dir.join("bin/pg_ctl"), b"pg_ctl");
        for tool in ["postgres", "initdb", "pg_ctl"] {
            fs::set_permissions(
                install_dir.join("bin").join(tool),
                fs::Permissions::from_mode(0o644),
            )
            .expect("make source runtime tool non-executable");
        }

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[],
        )
        .unwrap();

        for tool in ["postgres", "initdb", "pg_ctl"] {
            let mode = fs::metadata(runtime_dir.join("bin").join(tool))
                .expect("stat copied runtime tool")
                .permissions()
                .mode();
            assert_ne!(
                mode & 0o111,
                0,
                "copied runtime tool should be executable: {tool}"
            );
        }
    }

    #[test]
    fn install_omits_icu_data_from_base_runtime() {
        let temp = TempTree::new("icu-data");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_file(
            &install_dir.join("include/pg_config.h"),
            b"#define USE_ICU 1\n#define U_STATIC_IMPLEMENTATION 1\n",
        );
        write_file(
            &install_dir.join("share/icu/76.1/icudt76l.dat"),
            b"icu data",
        );

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[],
        )
        .unwrap();

        assert!(
            !runtime_dir.join("share/icu").exists(),
            "base native runtimes must not bundle ICU data; apps opt in through the ICU package"
        );
    }

    #[test]
    fn install_copies_runtime_library_root_files() {
        let temp = TempTree::new("runtime-lib-root");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[],
        )
        .unwrap();

        assert_eq!(
            fs::read(runtime_dir.join("lib/libpq.so")).unwrap(),
            b"libpq"
        );
    }

    #[test]
    fn install_accepts_icu_enabled_installs_without_icu_data() {
        let temp = TempTree::new("missing-icu-data");
        let install_dir = temp.path().join("install");
        let runtime_dir = temp.path().join("runtime");
        write_minimal_install(&install_dir);
        write_file(
            &install_dir.join("include/pg_config.h"),
            b"#define USE_ICU 1\n",
        );

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &[],
            &runtime_dir,
            &[],
        )
        .unwrap();
        assert!(!runtime_dir.join("share/icu").exists());
    }

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "oliphaunt-runtime-install-test-{}-{name}-{nanos}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create temp test tree");
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

    fn write_minimal_install(install_dir: &Path) {
        write_file(&install_dir.join("bin/postgres"), b"postgres");
        write_file(&install_dir.join("bin/initdb"), b"initdb");
        write_file(&install_dir.join("bin/pg_ctl"), b"pg_ctl");
        write_file(&install_dir.join("bin/pg_basebackup"), b"pg_basebackup");
        write_file(&install_dir.join("bin/pg_dump"), b"pg_dump");
        write_file(&install_dir.join("bin/psql"), b"psql");
        write_file(
            &install_dir.join("share/postgresql/postgresql.conf.sample"),
            b"# sample\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/plpgsql.control"),
            b"comment = 'PL/pgSQL'\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/plpgsql--1.0.sql"),
            b"select 'plpgsql install';\n",
        );
        fs::create_dir_all(install_dir.join("lib/postgresql")).expect("create lib dir");
        write_file(&install_dir.join("lib/libpq.so"), b"libpq");
    }

    fn write_extension_assets(install_dir: &Path, extension: Extension) {
        write_file(
            &install_dir
                .join("share/postgresql/extension")
                .join(format!("{}.control", extension.sql_name())),
            format!("comment = '{}'\n", extension.sql_name()).as_bytes(),
        );
        write_file(
            &install_dir
                .join("share/postgresql/extension")
                .join(format!("{}--1.0.sql", extension.sql_name())),
            format!("select '{} install';\n", extension.sql_name()).as_bytes(),
        );
        for module in extension.native_module_files() {
            write_file(
                &install_dir.join("lib/postgresql").join(module),
                format!("{} module\n", extension.sql_name()).as_bytes(),
            );
        }
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }
}

fn install_native_library_tree(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    embedded_modules: Option<&Path>,
    runtime_dir: &Path,
    extension_modules: &[ResolvedExtensionModules],
) -> Result<()> {
    install_runtime_library_root(install_dir, runtime_dir)?;

    let source_lib = install_dir.join("lib/postgresql");
    let target_lib = runtime_dir.join("lib/postgresql");
    if !source_lib.is_dir() {
        return Err(Error::Engine(format!(
            "native PostgreSQL install is missing lib/postgresql at {}",
            source_lib.display()
        )));
    }
    fs::create_dir_all(&target_lib).map_err(|err| {
        Error::Engine(format!(
            "create native library dir {}: {err}",
            target_lib.display()
        ))
    })?;

    let packaged_modules = packaged_extension_module_files();
    let embedded_core_modules = embedded_core_module_files();
    for entry in fs::read_dir(&source_lib)
        .map_err(|err| Error::Engine(format!("read native library dir: {err}")))?
    {
        let entry =
            entry.map_err(|err| Error::Engine(format!("read native library entry: {err}")))?;
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if packaged_modules.contains(&file_name)
            || (profile.needs_embedded_modules() && embedded_core_modules.contains(&file_name))
        {
            continue;
        }
        copy_file_preserving_permissions(&source, &target_lib.join(&file_name))?;
    }

    if profile.needs_embedded_modules() {
        let embedded_modules = embedded_modules.ok_or_else(|| {
            Error::Engine(
                "native liboliphaunt runtime requires embedded PostgreSQL modules".to_owned(),
            )
        })?;
        for module in embedded_core_modules {
            copy_embedded_module(embedded_modules, &target_lib, &module)?;
        }
    }
    for extension in extension_modules {
        let extension_root = &extension.source_root;
        let extension_lib = extension_root.join("lib/postgresql");
        for module in &extension.files {
            match profile {
                NativeRuntimeProfile::OliphauntEmbedded => {
                    let embedded_extension_lib = extension_root.join("lib/modules");
                    if embedded_extension_lib.join(module).is_file()
                        || extension.embedded_fallback_file.as_ref() != Some(module)
                    {
                        copy_file_preserving_permissions(
                            &embedded_extension_lib.join(module),
                            &target_lib.join(module),
                        )?;
                    } else {
                        let embedded_modules = embedded_modules.ok_or_else(|| {
                        Error::Engine(
                            "native liboliphaunt runtime requires embedded PostgreSQL extension modules"
                                .to_owned(),
                        )
                    })?;
                        copy_embedded_module(embedded_modules, &target_lib, module)?;
                    }
                }
                NativeRuntimeProfile::PostgresServer => {
                    copy_file_preserving_permissions(
                        &extension_lib.join(module),
                        &target_lib.join(module),
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn install_runtime_library_root(install_dir: &Path, runtime_dir: &Path) -> Result<()> {
    let source_lib = install_dir.join("lib");
    if !source_lib.is_dir() {
        return Ok(());
    }
    let target_lib = runtime_dir.join("lib");
    fs::create_dir_all(&target_lib).map_err(|err| {
        Error::Engine(format!(
            "create native runtime library dir {}: {err}",
            target_lib.display()
        ))
    })?;
    for entry in fs::read_dir(&source_lib)
        .map_err(|err| Error::Engine(format!("read native runtime library dir: {err}")))?
    {
        let entry = entry
            .map_err(|err| Error::Engine(format!("read native runtime library entry: {err}")))?;
        let source = entry.path();
        if source.is_file() {
            copy_file_preserving_permissions(&source, &target_lib.join(entry.file_name()))?;
        }
    }
    Ok(())
}
