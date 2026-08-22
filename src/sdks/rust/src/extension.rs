use std::collections::BTreeSet;

use crate::error::{Error, Result};

#[path = "generated/extensions.rs"]
mod generated_extensions;
pub use generated_extensions::Extension;

impl Extension {
    /// All PostgreSQL 18 extensions known to the native lane.
    pub const ALL_PG18_SUPPORTED: &'static [Self] = generated_extensions::ALL_PG18_SUPPORTED;

    /// SQL extension name used by `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        generated_extensions::sql_name(self)
    }

    pub(crate) const fn native_module_stem(self) -> Option<&'static str> {
        generated_extensions::native_module_stem(self)
    }

    pub(crate) fn native_module_file(self) -> Option<String> {
        self.native_module_stem()
            .map(|stem| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    pub(crate) const fn creates_extension(self) -> bool {
        generated_extensions::creates_extension(self)
    }

    pub(crate) const fn dependencies(self) -> &'static [Extension] {
        generated_extensions::dependencies(self)
    }

    pub(crate) const fn required_shared_preload_library(self) -> Option<&'static str> {
        generated_extensions::required_shared_preload_library(self)
    }

    /// Resolve an extension by SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL_PG18_SUPPORTED
            .iter()
            .copied()
            .find(|extension| extension.sql_name() == sql_name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ExtensionRuntimeEnvironment {
    pub(crate) name: &'static str,
    pub(crate) relative_path: &'static str,
    pub(crate) required_file: &'static str,
}

pub(crate) fn resolve_extensions(direct_extensions: &[Extension]) -> Result<Vec<Extension>> {
    let mut requested = Vec::new();
    requested.extend_from_slice(direct_extensions);

    let mut resolved = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for extension in requested {
        visit_extension(extension, &mut visiting, &mut visited, &mut resolved)?;
    }
    Ok(resolved)
}

pub(crate) fn required_shared_preload_libraries(extensions: &[Extension]) -> Vec<&'static str> {
    extensions
        .iter()
        .filter_map(|extension| extension.required_shared_preload_library())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn visit_extension(
    extension: Extension,
    visiting: &mut BTreeSet<Extension>,
    visited: &mut BTreeSet<Extension>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    if visited.contains(&extension) {
        return Ok(());
    }
    if !visiting.insert(extension) {
        return Err(Error::Engine(format!(
            "cyclic native extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    for dependency in extension.dependencies() {
        visit_extension(*dependency, visiting, visited, resolved)?;
    }
    visiting.remove(&extension);
    visited.insert(extension);
    resolved.push(extension);
    Ok(())
}

pub(crate) fn extension_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    file_name == format!("{sql_name}.control")
        || file_name == format!("{sql_name}.sql")
        || extension_install_sql_file_belongs(sql_name, file_name)
        || extension_versioned_sql_file_belongs(sql_name, file_name)
        || extension_extra_sql_file_belongs(sql_name, file_name)
}

fn extension_versioned_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    file_name
        .strip_prefix(&format!("{sql_name}--"))
        .and_then(|value| value.strip_suffix(".sql"))
        .is_some_and(|version_path| {
            !version_path.is_empty()
                && version_path
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

pub(crate) fn extension_install_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    let Some(version) = file_name
        .strip_prefix(&format!("{sql_name}--"))
        .and_then(|value| value.strip_suffix(".sql"))
    else {
        return false;
    };
    !version.is_empty()
        && !version.contains("--")
        && version.as_bytes()[0].is_ascii_digit()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) const fn extension_runtime_environment(
    extension: Extension,
) -> &'static [ExtensionRuntimeEnvironment] {
    generated_extensions::runtime_environment(extension)
}

fn extension_extra_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    let Some(extension) = Extension::by_sql_name(sql_name) else {
        return false;
    };
    generated_extensions::extension_sql_file_names(extension).contains(&file_name)
        || generated_extensions::extension_sql_file_prefixes(extension)
            .iter()
            .any(|prefix| file_name.starts_with(prefix))
}

pub(crate) const fn extension_data_files(extension: Extension) -> &'static [&'static str] {
    generated_extensions::extension_data_files(extension)
}
