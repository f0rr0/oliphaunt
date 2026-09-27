use std::collections::{BTreeMap, BTreeSet};

use crate::error::{Error, Result};

#[path = "generated/extensions.rs"]
mod generated_extensions;
pub use generated_extensions::Extension;

/// Immutable resources exported by a generated extension Cargo package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ExtensionPackage {
    pub product: &'static str,
    pub version: &'static str,
    pub runtime_version: &'static str,
    pub resources: &'static [crate::EmbeddedResource],
}

impl Extension {
    /// Attach this extension's independently installed Cargo resources.
    #[doc(hidden)]
    pub const fn with_package(mut self, package: &'static ExtensionPackage) -> Self {
        self.package = Some(package);
        self
    }

    #[doc(hidden)]
    pub const fn package(self) -> Option<&'static ExtensionPackage> {
        self.package
    }

    /// SQL extension name used by `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        generated_extensions::sql_name(self)
    }

    pub const fn native_module_stem(self) -> Option<&'static str> {
        generated_extensions::native_module_stem(self)
    }

    pub fn native_module_file(self) -> Option<String> {
        self.native_module_stem()
            .map(|stem| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    pub const fn creates_extension(self) -> bool {
        generated_extensions::creates_extension(self)
    }

    pub const fn dependencies(self) -> &'static [Extension] {
        generated_extensions::dependencies(self)
    }

    pub const fn required_shared_preload_library(self) -> Option<&'static str> {
        generated_extensions::required_shared_preload_library(self)
    }

    /// Resolve an extension by SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|extension| extension.sql_name() == sql_name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExtensionRuntimeEnvironment {
    pub name: &'static str,
    pub relative_path: &'static str,
    pub required_file: &'static str,
}

pub fn resolve_extensions(direct_extensions: &[Extension]) -> Result<Vec<Extension>> {
    let mut requested = BTreeMap::new();
    for &extension in direct_extensions {
        if let Some(package) = extension.package
            && (package.product != generated_extensions::artifact_product(extension)
                || package.version.is_empty()
                || package.runtime_version.is_empty()
                || package.resources.is_empty())
        {
            return Err(Error::InvalidConfig(format!(
                "invalid native extension package for {}",
                extension.sql_name()
            )));
        }
        if let Some(previous) = requested.insert(extension.sql_name(), extension)
            && previous.package != extension.package
        {
            return Err(Error::InvalidConfig(format!(
                "conflicting native extension packages for {}",
                extension.sql_name()
            )));
        }
    }
    let mut resolved = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for &extension in requested.values() {
        visit_extension(
            extension,
            &requested,
            &mut visiting,
            &mut visited,
            &mut resolved,
        )?;
    }
    Ok(resolved)
}

/// Materialize only the independently selected Cargo packages. Broker children
/// receive this directory explicitly; it never changes another database's selection.
#[doc(hidden)]
pub fn materialize_extension_resources(
    extensions: &[Extension],
) -> Result<Option<std::path::PathBuf>> {
    let mut packages = BTreeSet::new();
    let mut resources = Vec::new();
    for extension in resolve_extensions(extensions)? {
        if let Some(package) = extension.package
            && packages.insert(package as *const ExtensionPackage)
        {
            resources.extend_from_slice(package.resources);
        }
    }
    if resources.is_empty() {
        Ok(None)
    } else {
        crate::materialize_embedded_resources(&resources).map(Some)
    }
}

pub fn required_shared_preload_libraries(extensions: &[Extension]) -> Vec<&'static str> {
    extensions
        .iter()
        .filter_map(|extension| extension.required_shared_preload_library())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn visit_extension(
    extension: Extension,
    requested: &BTreeMap<&'static str, Extension>,
    visiting: &mut BTreeSet<&'static str>,
    visited: &mut BTreeSet<&'static str>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    if visited.contains(extension.sql_name()) {
        return Ok(());
    }
    if !visiting.insert(extension.sql_name()) {
        return Err(Error::InvalidConfig(format!(
            "cyclic native extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    for dependency in extension.dependencies() {
        let inherited = if generated_extensions::artifact_product(*dependency)
            == generated_extensions::artifact_product(extension)
        {
            {
                let mut inherited = *dependency;
                inherited.package = extension.package;
                inherited
            }
        } else {
            *dependency
        };
        let selected = requested
            .get(dependency.sql_name())
            .copied()
            .unwrap_or(inherited);
        if inherited.package.is_some() && selected.package != inherited.package {
            return Err(Error::InvalidConfig(format!(
                "conflicting native extension packages for {}",
                selected.sql_name()
            )));
        }
        visit_extension(selected, requested, visiting, visited, resolved)?;
    }
    visiting.remove(extension.sql_name());
    visited.insert(extension.sql_name());
    resolved.push(extension);
    Ok(())
}

pub fn extension_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
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

pub fn extension_install_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
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

pub const fn extension_runtime_environment(
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

pub const fn extension_data_files(extension: Extension) -> &'static [&'static str] {
    generated_extensions::extension_data_files(extension)
}

#[cfg(test)]
mod package_tests {
    use super::*;

    #[test]
    fn selected_packages_follow_dependencies_and_reject_identity_conflicts() {
        static PACKAGE: ExtensionPackage = ExtensionPackage {
            product: "oliphaunt-extension-contrib-pg18",
            version: "9.8.7",
            runtime_version: "0.2.0",
            resources: &[(
                "extension/fixture/file",
                b"",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                false,
            )],
        };
        static OTHER: ExtensionPackage = ExtensionPackage {
            version: "9.8.8",
            ..PACKAGE
        };
        let selected = Extension::EARTHDISTANCE.with_package(&PACKAGE);
        let resolved = resolve_extensions(&[selected]).unwrap();
        assert_eq!(
            resolved
                .iter()
                .map(|extension| extension.sql_name())
                .collect::<Vec<_>>(),
            ["cube", "earthdistance"]
        );
        assert!(
            resolved
                .iter()
                .all(|extension| extension.package() == Some(&PACKAGE))
        );
        assert!(
            resolve_extensions(&[selected, Extension::EARTHDISTANCE.with_package(&OTHER)]).is_err()
        );
        assert!(resolve_extensions(&[selected, Extension::CUBE.with_package(&OTHER)]).is_err());
        assert!(resolve_extensions(&[Extension::VECTOR.with_package(&PACKAGE)]).is_err());
    }
}
