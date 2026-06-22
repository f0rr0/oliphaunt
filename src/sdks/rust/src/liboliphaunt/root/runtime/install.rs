use std::fs;
use std::path::Path;

use super::super::NativeRuntimeProfile;
use super::super::extensions::{
    copy_embedded_module, copy_extension_data_files, copy_extension_sql_files,
    copy_named_extension_sql_files, core_share_file, embedded_core_module_files,
    packaged_extension_module_files,
};
use super::super::files::{
    copy_directory_filtered, copy_file_preserving_permissions, remove_file_if_exists,
};
use crate::error::{Error, Result};
use crate::extension::Extension;

pub(super) fn install_cached_runtime(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    embedded_modules: Option<&Path>,
    runtime_dir: &Path,
    extensions: &[Extension],
) -> Result<()> {
    fs::create_dir_all(runtime_dir).map_err(|err| {
        Error::Engine(format!(
            "create native runtime dir {}: {err}",
            runtime_dir.display()
        ))
    })?;

    for tool in ["postgres", "initdb", "pg_ctl", "pg_dump", "psql"] {
        let source = install_dir.join("bin").join(tool);
        if source.is_file() {
            install_runtime_tool(&source, &runtime_dir.join("bin").join(tool))?;
        }
    }

    install_native_share_tree(install_dir, runtime_dir, extensions)?;
    install_native_library_tree(
        profile,
        install_dir,
        embedded_modules,
        runtime_dir,
        extensions,
    )
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
    extensions: &[Extension],
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
    for extension in extensions {
        copy_extension_sql_files(&source_share, &target_share, *extension)?;
        copy_extension_data_files(&source_share, &target_share, *extension)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::extension::resolve_extension_selection;

    #[test]
    fn install_rejects_missing_transitive_extension_dependency_assets() {
        let temp = TempTree::new("missing-transitive-extension-assets");
        let install_dir = temp.path().join("install");
        write_minimal_install(&install_dir);
        write_extension_assets(&install_dir, Extension::Earthdistance);

        let extensions = resolve_extension_selection(&[Extension::Earthdistance]).unwrap();
        assert_eq!(extensions, vec![Extension::Cube, Extension::Earthdistance]);

        let error = install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
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
        write_extension_assets(&install_dir, Extension::Vector);
        write_extension_assets(&install_dir, Extension::Hstore);

        install_cached_runtime(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            &runtime_dir,
            &[Extension::Vector],
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
                .join(Extension::Vector.native_module_file().unwrap())
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
                .join(Extension::Hstore.native_module_file().unwrap())
                .exists(),
            "unselected hstore module must not leak into vector-only packages"
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
        for tool in ["postgres", "initdb"] {
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
            &runtime_dir,
            &[],
        )
        .unwrap();

        for tool in ["postgres", "initdb"] {
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
        if let Some(module) = extension.native_module_file() {
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
    extensions: &[Extension],
) -> Result<()> {
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

    let extension_modules = packaged_extension_module_files();
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
        if extension_modules.contains(&file_name)
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
    for extension in extensions {
        let Some(module) = extension.native_module_file() else {
            continue;
        };
        match profile {
            NativeRuntimeProfile::OliphauntEmbedded => {
                let embedded_modules = embedded_modules.ok_or_else(|| {
                    Error::Engine(
                        "native liboliphaunt runtime requires embedded PostgreSQL extension modules"
                            .to_owned(),
                    )
                })?;
                copy_embedded_module(embedded_modules, &target_lib, &module)?;
            }
            NativeRuntimeProfile::PostgresServer => {
                copy_file_preserving_permissions(
                    &source_lib.join(&module),
                    &target_lib.join(&module),
                )?;
            }
        }
    }
    Ok(())
}
