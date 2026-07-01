use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;

use super::files::copy_file_preserving_permissions;
use crate::error::{Error, Result};
use crate::extension::{Extension, extension_data_files, extension_sql_file_belongs};

pub(super) fn selected_extension_names(extensions: &[Extension]) -> Vec<&'static str> {
    let mut names = extensions
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();
    names
}

pub(super) fn core_share_file(relative: &Path) -> bool {
    if relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == OsStr::new("extension"))
    {
        return false;
    }
    !matches!(
        relative.to_str(),
        Some("tsearch_data/unaccent.rules" | "tsearch_data/xsyn_sample.rules")
    )
}

pub(super) fn packaged_extension_module_files() -> BTreeSet<String> {
    Extension::ALL_PG18_SUPPORTED
        .iter()
        .filter_map(|extension| extension.native_module_file())
        .collect()
}

pub(super) fn embedded_core_module_files() -> BTreeSet<String> {
    [format!("plpgsql{}", std::env::consts::DLL_SUFFIX)]
        .into_iter()
        .collect()
}

pub(super) fn data_files(extension: Extension) -> &'static [&'static str] {
    extension_data_files(extension)
}

pub(super) fn copy_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    extension: Extension,
) -> Result<()> {
    copy_named_extension_sql_files(
        source_share,
        target_share,
        extension.sql_name(),
        extension.creates_extension(),
    )
}

pub(super) fn copy_named_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    sql_name: &str,
    require_control: bool,
) -> Result<()> {
    let source_dir = source_share.join("extension");
    let target_dir = target_share.join("extension");
    let mut copied = 0usize;
    let mut copied_control = false;
    let mut copied_sql = false;
    for entry in fs::read_dir(&source_dir).map_err(|err| {
        Error::Engine(format!(
            "read extension dir {}: {err}",
            source_dir.display()
        ))
    })? {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", source_dir.display()))
        })?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if extension_sql_file_belongs(sql_name, &file_name) {
            if extension_sql_file_is_control(sql_name, &file_name) {
                copied_control = true;
            } else if extension_sql_file_is_sql(&file_name) {
                copied_sql = true;
            }
            copy_file_preserving_permissions(&entry.path(), &target_dir.join(&file_name))?;
            copied += 1;
        }
    }
    if require_control {
        if !copied_control || !target_dir.join(format!("{sql_name}.control")).is_file() {
            return Err(Error::Engine(format!(
                "native extension '{sql_name}' is not available for PostgreSQL 18: missing control file in {}",
                source_dir.display()
            )));
        }
        if !copied_sql {
            return Err(Error::Engine(format!(
                "native extension '{sql_name}' is not available for PostgreSQL 18: missing SQL install file in {}",
                source_dir.display()
            )));
        }
    } else if copied == 0 && sql_name != "auto_explain" {
        return Err(Error::Engine(format!(
            "native extension '{sql_name}' did not match any SQL/control files in {}",
            source_dir.display()
        )));
    }
    Ok(())
}

pub(super) fn copy_extension_data_files(
    source_share: &Path,
    target_share: &Path,
    extension: Extension,
) -> Result<()> {
    for relative in extension_data_files(extension) {
        copy_file_preserving_permissions(
            &source_share.join(relative),
            &target_share.join(relative),
        )?;
    }
    Ok(())
}

pub(super) fn copy_embedded_module(
    embedded_modules: &Path,
    target_lib: &Path,
    module: &str,
) -> Result<()> {
    let source = embedded_modules.join(module);
    if !source.is_file() {
        return Err(Error::Engine(format!(
            "native embedded PostgreSQL 18 module is missing {}",
            source.display()
        )));
    }
    copy_file_preserving_permissions(&source, &target_lib.join(module))
}

pub(super) fn extension_sql_file_is_control(sql_name: &str, file_name: &str) -> bool {
    file_name == format!("{sql_name}.control")
}

pub(super) fn extension_sql_file_is_sql(file_name: &str) -> bool {
    file_name.ends_with(".sql")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn create_extension_assets_require_control_and_sql_files() {
        let temp = TempTree::new("extension-assets");
        let source_share = temp.path().join("source/share/postgresql");
        let target_share = temp.path().join("target/share/postgresql");

        write_file(
            &source_share.join("extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );
        let missing_control =
            copy_extension_sql_files(&source_share, &target_share, Extension::Hstore).unwrap_err();
        assert!(
            missing_control.to_string().contains("missing control file"),
            "unexpected missing-control error: {missing_control}"
        );

        fs::remove_dir_all(&target_share).unwrap();
        fs::remove_file(source_share.join("extension/hstore--1.0.sql")).unwrap();
        write_file(
            &source_share.join("extension/hstore.control"),
            b"comment = 'hstore'\n",
        );
        let missing_sql =
            copy_extension_sql_files(&source_share, &target_share, Extension::Hstore).unwrap_err();
        assert!(
            missing_sql.to_string().contains("missing SQL install file"),
            "unexpected missing-SQL error: {missing_sql}"
        );

        write_file(
            &source_share.join("extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );
        copy_extension_sql_files(&source_share, &target_share, Extension::Hstore).unwrap();
        assert!(target_share.join("extension/hstore.control").is_file());
        assert!(target_share.join("extension/hstore--1.0.sql").is_file());
    }

    #[test]
    fn loadable_module_extension_does_not_require_create_extension_sql() {
        let temp = TempTree::new("loadable-module-extension-assets");
        let source_share = temp.path().join("source/share/postgresql");
        let target_share = temp.path().join("target/share/postgresql");
        fs::create_dir_all(source_share.join("extension")).unwrap();

        copy_extension_sql_files(&source_share, &target_share, Extension::AutoExplain).unwrap();
    }

    #[test]
    fn extension_sql_file_belongs_uses_generated_extra_file_metadata() {
        let postgis = Extension::Postgis.sql_name();

        assert!(extension_sql_file_belongs("pgtap", "pgtap-core--1.3.5.sql"));
        assert!(extension_sql_file_belongs("pgtap", "pgtap-schema.sql"));
        assert!(extension_sql_file_belongs("pgtap", "uninstall_pgtap.sql"));
        assert!(extension_sql_file_belongs(postgis, "postgis_comments.sql"));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis_proc_set_search_path.sql"
        ));
        assert!(extension_sql_file_belongs(postgis, "rtpostgis--3.6.sql"));

        assert!(!extension_sql_file_belongs("pgtap", "postgis_comments.sql"));
        assert!(!extension_sql_file_belongs(postgis, "pgtap-core.sql"));
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
                "oliphaunt-extension-assets-test-{}-{name}-{nanos}",
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

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }
}
