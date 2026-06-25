use std::fs;
use std::path::Path;

use super::super::NativeRuntimeProfile;
use super::super::extensions::{
    core_share_file, data_files, embedded_core_module_files, extension_sql_file_is_control,
    extension_sql_file_is_sql, packaged_extension_module_files, selected_extension_names,
};
use super::super::files::sorted_read_dir;
use super::super::fingerprint::{
    canonical_or_original, fingerprint_directory_filtered, fingerprint_file,
    fingerprint_named_extension_sql_files, fingerprint_optional_file, hash_path, hash_str,
    new_state,
};
use super::super::{
    NATIVE_RUNTIME_TOOLS, NATIVE_TOOLS_PACKAGE_TOOLS, existing_native_tool_path, native_tool_path,
};
use crate::error::{Error, Result};
use crate::extension::Extension;

const RUNTIME_CACHE_VERSION: &str = "pg18-runtime-cache-v5";

pub(super) fn runtime_cache_key(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    tools_dir: Option<&Path>,
    embedded_modules: Option<&Path>,
    extensions: &[Extension],
) -> Result<String> {
    let mut state = new_state();
    hash_str(&mut state, RUNTIME_CACHE_VERSION);
    hash_str(&mut state, profile.cache_id());
    hash_path(&mut state, &canonical_or_original(install_dir));
    if let Some(tools_dir) = tools_dir {
        hash_str(&mut state, "native-tools");
        hash_path(&mut state, &canonical_or_original(tools_dir));
    } else {
        hash_str(&mut state, "native-tools:none");
    }
    if let Some(embedded_modules) = embedded_modules {
        hash_path(&mut state, &canonical_or_original(embedded_modules));
    }
    hash_str(&mut state, std::env::consts::DLL_SUFFIX);

    for name in selected_extension_names(extensions) {
        hash_str(&mut state, name);
    }

    for tool in NATIVE_RUNTIME_TOOLS {
        fingerprint_optional_file(
            &mut state,
            install_dir,
            &existing_native_tool_path(install_dir, tool),
        )?;
    }
    let tools_dir = tools_dir.unwrap_or(install_dir);
    for tool in NATIVE_TOOLS_PACKAGE_TOOLS {
        fingerprint_optional_file(
            &mut state,
            tools_dir,
            &existing_native_tool_path(tools_dir, tool),
        )?;
    }

    let source_share = install_dir.join("share/postgresql");
    fingerprint_directory_filtered(&mut state, &source_share, &source_share, core_share_file)?;
    fingerprint_named_extension_sql_files(&mut state, &source_share, "plpgsql")?;
    for extension in extensions {
        fingerprint_named_extension_sql_files(&mut state, &source_share, extension.sql_name())?;
        for relative in data_files(*extension) {
            fingerprint_optional_file(&mut state, &source_share, &source_share.join(relative))?;
        }
    }
    let source_lib = install_dir.join("lib/postgresql");
    let extension_modules = packaged_extension_module_files();
    let embedded_core_modules = embedded_core_module_files();
    for entry in sorted_read_dir(&source_lib)? {
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
        fingerprint_file(&mut state, &source_lib, &source)?;
    }
    match profile {
        NativeRuntimeProfile::OliphauntEmbedded => {
            let embedded_modules = embedded_modules.ok_or_else(|| {
                Error::Engine(
                    "native liboliphaunt runtime requires embedded PostgreSQL modules".to_owned(),
                )
            })?;
            for module in embedded_core_modules {
                fingerprint_optional_file(
                    &mut state,
                    embedded_modules,
                    &embedded_modules.join(&module),
                )?;
            }
            for extension in extensions {
                if let Some(module) = extension.native_module_file() {
                    fingerprint_optional_file(
                        &mut state,
                        embedded_modules,
                        &embedded_modules.join(module),
                    )?;
                }
            }
        }
        NativeRuntimeProfile::PostgresServer => {
            for extension in extensions {
                if let Some(module) = extension.native_module_file() {
                    fingerprint_optional_file(&mut state, &source_lib, &source_lib.join(module))?;
                }
            }
        }
    }

    Ok(format!("{state:016x}"))
}

pub(super) fn cached_runtime_is_valid(
    cache_dir: &Path,
    key: &str,
    extensions: &[Extension],
) -> bool {
    if !cache_dir.join(".complete").is_file()
        || !native_tool_path(cache_dir, "postgres").is_file()
        || !native_tool_path(cache_dir, "initdb").is_file()
        || !native_tool_path(cache_dir, "pg_ctl").is_file()
        || !cache_dir
            .join("share/postgresql/postgresql.conf.sample")
            .is_file()
        || !cache_dir
            .join("share/postgresql/extension/plpgsql.control")
            .is_file()
    {
        return false;
    }
    let Ok(manifest) = fs::read_to_string(cache_dir.join(".manifest")) else {
        return false;
    };
    if !manifest
        .lines()
        .any(|line| line == format!("version={RUNTIME_CACHE_VERSION}"))
        || !manifest.lines().any(|line| line == format!("key={key}"))
    {
        return false;
    }

    for extension in extensions {
        if extension.creates_extension()
            && (!cache_dir
                .join("share/postgresql/extension")
                .join(format!("{}.control", extension.sql_name()))
                .is_file()
                || !cache_contains_extension_sql_file(cache_dir, *extension))
        {
            return false;
        }
        if let Some(module) = extension.native_module_file()
            && !cache_dir.join("lib/postgresql").join(module).is_file()
        {
            return false;
        }
        for relative in data_files(*extension) {
            if !cache_dir.join("share/postgresql").join(relative).is_file() {
                return false;
            }
        }
    }
    true
}

fn cache_contains_extension_sql_file(cache_dir: &Path, extension: Extension) -> bool {
    let extension_dir = cache_dir.join("share/postgresql/extension");
    let Ok(entries) = fs::read_dir(extension_dir) else {
        return false;
    };
    entries.filter_map(|entry| entry.ok()).any(|entry| {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        !extension_sql_file_is_control(extension.sql_name(), &file_name)
            && extension_sql_file_is_sql(&file_name)
            && crate::extension::extension_sql_file_belongs(extension.sql_name(), &file_name)
            && entry.path().is_file()
    })
}

pub(super) fn runtime_cache_manifest(
    profile: NativeRuntimeProfile,
    key: &str,
    extensions: &[Extension],
) -> String {
    let extension_names = selected_extension_names(extensions);
    format!(
        "version={RUNTIME_CACHE_VERSION}\nprofile={}\nkey={key}\nextensions={}\n",
        profile.cache_id(),
        extension_names.join(",")
    )
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

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
                "oliphaunt-cache-key-test-{}-{}-{nanos}",
                std::process::id(),
                name
            ));
            std::fs::create_dir(&path).expect("create temp test tree");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn selected_extension_sql_and_module_content_participate_in_cache_key() {
        let temp = TempTree::new("selected-extension");
        let install_dir = temp.path().join("install");
        write_fake_install(&install_dir);

        let first = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[Extension::Hstore],
        )
        .expect("create first runtime cache key");

        write_file(
            &install_dir.join("share/postgresql/extension/hstore--1.0.sql"),
            b"create function hstore_version() returns text language sql as 'select ''v2''';\n",
        );
        let changed_sql = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[Extension::Hstore],
        )
        .expect("create SQL-mutated runtime cache key");
        assert_ne!(
            first, changed_sql,
            "selected extension SQL changes must invalidate the runtime cache"
        );

        write_file(
            &install_dir
                .join("lib/postgresql")
                .join(format!("hstore{}", std::env::consts::DLL_SUFFIX)),
            b"hstore-module-v2",
        );
        let changed_module = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[Extension::Hstore],
        )
        .expect("create module-mutated runtime cache key");
        assert_ne!(
            changed_sql, changed_module,
            "selected extension module changes must invalidate the runtime cache"
        );
    }

    #[test]
    fn unselected_extension_assets_do_not_pollute_cache_key() {
        let temp = TempTree::new("unselected-extension");
        let install_dir = temp.path().join("install");
        write_fake_install(&install_dir);

        let first = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[],
        )
        .expect("create first runtime cache key");

        write_file(
            &install_dir.join("share/postgresql/extension/hstore.control"),
            b"comment = 'mutated but unselected'\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/hstore--1.0.sql"),
            b"select 'mutated but unselected';\n",
        );
        write_file(
            &install_dir
                .join("lib/postgresql")
                .join(format!("hstore{}", std::env::consts::DLL_SUFFIX)),
            b"hstore-module-mutated-but-unselected",
        );

        let second = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[],
        )
        .expect("create second runtime cache key");
        assert_eq!(
            first, second,
            "unselected extension assets must stay invisible to runtime cache identity"
        );
    }

    #[test]
    fn icu_data_content_does_not_participate_in_base_runtime_cache_key() {
        let temp = TempTree::new("icu-data");
        let install_dir = temp.path().join("install");
        write_fake_install(&install_dir);
        write_file(
            &install_dir.join("include/pg_config.h"),
            b"#define USE_ICU 1\n",
        );
        write_file(
            &install_dir.join("share/icu/76.1/icudt76l.dat"),
            b"icu-data-v1",
        );

        let first = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[],
        )
        .expect("create first ICU runtime cache key");

        write_file(
            &install_dir.join("share/icu/76.1/icudt76l.dat"),
            b"icu-data-v2",
        );
        let second = runtime_cache_key(
            NativeRuntimeProfile::PostgresServer,
            &install_dir,
            None,
            None,
            &[],
        )
        .expect("create changed ICU runtime cache key");

        assert_eq!(
            first, second,
            "external ICU package contents must not change the base runtime cache identity"
        );
    }

    #[test]
    fn runtime_validation_requires_selected_extension_assets() {
        let temp = TempTree::new("validation");
        let cache_dir = temp.path().join("cache");
        write_minimal_cache_dir(&cache_dir, "cache-key");

        assert!(
            cached_runtime_is_valid(&cache_dir, "cache-key", &[]),
            "minimal cache is valid when no optional extensions are selected"
        );
        assert!(
            !cached_runtime_is_valid(&cache_dir, "cache-key", &[Extension::Hstore]),
            "selected extension cache must require the extension control and module files"
        );

        let sql_without_module = temp.path().join("cache-sql-without-module");
        write_minimal_cache_dir(&sql_without_module, "cache-key");
        write_file(
            &sql_without_module.join("share/postgresql/extension/hstore.control"),
            b"comment = 'hstore'\n",
        );
        write_file(
            &sql_without_module.join("share/postgresql/extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );
        assert!(
            !cached_runtime_is_valid(&sql_without_module, "cache-key", &[Extension::Hstore]),
            "selected extension cache must reject SQL/control assets without the matching native module"
        );

        write_file(
            &cache_dir.join("share/postgresql/extension/hstore.control"),
            b"comment = 'hstore'\n",
        );
        write_file(
            &cache_dir
                .join("lib/postgresql")
                .join(format!("hstore{}", std::env::consts::DLL_SUFFIX)),
            b"hstore-module",
        );

        assert!(
            !cached_runtime_is_valid(&cache_dir, "cache-key", &[Extension::Hstore]),
            "selected extension cache must require an extension SQL install file, not only control and module files"
        );

        write_file(
            &cache_dir.join("share/postgresql/extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );

        assert!(
            cached_runtime_is_valid(&cache_dir, "cache-key", &[Extension::Hstore]),
            "selected extension cache is valid only after required assets are present"
        );
    }

    fn write_fake_install(install_dir: &Path) {
        for tool in ["postgres", "initdb", "pg_ctl", "pg_dump", "psql"] {
            write_file(&install_dir.join("bin").join(tool), tool.as_bytes());
        }
        write_file(
            &install_dir.join("share/postgresql/postgresql.conf.sample"),
            b"# sample\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/plpgsql.control"),
            b"comment = 'PL/pgSQL'\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/hstore.control"),
            b"comment = 'hstore'\n",
        );
        write_file(
            &install_dir.join("share/postgresql/extension/hstore--1.0.sql"),
            b"select 'hstore-v1';\n",
        );
        write_file(
            &install_dir.join("lib/postgresql/postgres_core_fixture.so"),
            b"core-module",
        );
        write_file(
            &install_dir
                .join("lib/postgresql")
                .join(format!("hstore{}", std::env::consts::DLL_SUFFIX)),
            b"hstore-module-v1",
        );
    }

    fn write_minimal_cache_dir(cache_dir: &Path, key: &str) {
        write_file(&cache_dir.join(".complete"), b"ok\n");
        write_file(
            &cache_dir.join(".manifest"),
            runtime_cache_manifest(NativeRuntimeProfile::PostgresServer, key, &[]).as_bytes(),
        );
        write_file(&cache_dir.join("bin/postgres"), b"postgres");
        write_file(&cache_dir.join("bin/initdb"), b"initdb");
        write_file(&cache_dir.join("bin/pg_ctl"), b"pg_ctl");
        write_file(
            &cache_dir.join("share/postgresql/postgresql.conf.sample"),
            b"# sample\n",
        );
        write_file(
            &cache_dir.join("share/postgresql/extension/plpgsql.control"),
            b"comment = 'PL/pgSQL'\n",
        );
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent directory");
        }
        std::fs::write(path, contents).expect("write fixture file");
    }
}
