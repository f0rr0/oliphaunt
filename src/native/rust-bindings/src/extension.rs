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

    /// Bind independently acquired package descriptors to frozen dependency names.
    #[doc(hidden)]
    pub const fn with_dependencies(mut self, dependencies: &'static [Extension]) -> Self {
        self.package_dependencies = dependencies;
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

    /// Canonical dependency modules consumed by unpublished native packaging.
    #[cfg(feature = "internal-native-packaging")]
    #[doc(hidden)]
    pub const fn native_dependency_module_stems(self) -> &'static [&'static str] {
        generated_extensions::native_dependency_module_stems(self)
    }

    /// Current host construction; historical carriers retain their physical inventory.
    #[cfg(feature = "internal-native-packaging")]
    #[doc(hidden)]
    pub const fn native_dependency_module_stems_for_host(self) -> &'static [&'static str] {
        generated_extensions::native_dependency_module_stems_for_host(self)
    }

    /// Every native PostgreSQL module shipped by this extension product.
    pub fn native_module_files(self) -> impl Iterator<Item = String> {
        generated_extensions::native_module_stems(self)
            .iter()
            .map(|stem| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    pub(crate) fn native_dependency_module_files(self) -> impl Iterator<Item = String> {
        generated_extensions::native_dependency_module_stems(self)
            .iter()
            .copied()
            .filter(move |stem| !generated_extensions::native_module_stems(self).contains(stem))
            .map(|stem| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    /// SQL extensions installed from this product's shared artifact.
    pub const fn sql_members(self) -> &'static [&'static str] {
        generated_extensions::sql_members(self)
    }

    pub const fn creates_extension(self) -> bool {
        generated_extensions::creates_extension(self)
    }

    /// Source declarations; packaged selection uses its frozen resource metadata.
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
    let mut requested: BTreeMap<&'static str, Extension> = BTreeMap::new();
    for &extension in direct_extensions {
        validate_package(extension)?;
        if let Some(previous) = requested.get(extension.sql_name()) {
            if previous.package != extension.package {
                return Err(Error::InvalidConfig(format!(
                    "conflicting native extension packages for {}",
                    extension.sql_name()
                )));
            }
        } else {
            requested.insert(extension.sql_name(), extension);
        }
    }
    let mut resolved = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = Vec::new();
    let mut contexts = direct_extensions.to_vec();
    contexts.sort_by_key(|extension| extension.sql_name());
    for extension in contexts {
        visit_extension(
            extension,
            &requested,
            &mut visiting,
            &mut visited,
            &mut resolved,
        )?;
    }
    // Acquisition tables have served their purpose. The closed runtime selection
    // carries every actual package separately and must not retain cyclic tables.
    for extension in &mut resolved {
        extension.package_dependencies = &[];
    }
    Ok(resolved)
}

fn validate_package(extension: Extension) -> Result<()> {
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
    Ok(())
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
    visited: &mut Vec<Extension>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    validate_package(extension)?;
    if let Some(previous) = resolved
        .iter()
        .find(|previous| previous.sql_name() == extension.sql_name())
    {
        if previous.package != extension.package {
            return Err(Error::InvalidConfig(format!(
                "conflicting native extension packages for {}",
                extension.sql_name()
            )));
        }
    }
    if visiting.contains(extension.sql_name()) {
        return Err(Error::InvalidConfig(format!(
            "cyclic native extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    if visited.iter().any(|previous| {
        previous.sql_name() == extension.sql_name()
            && previous.package == extension.package
            && std::ptr::eq(
                previous.package_dependencies,
                extension.package_dependencies,
            )
    }) {
        return Ok(());
    }
    visiting.insert(extension.sql_name());
    let dependencies = match extension.package {
        Some(package) => packaged_dependencies(extension, package)?,
        None => extension.dependencies().to_vec(),
    };
    for dependency in dependencies {
        let same_owner = generated_extensions::artifact_product(dependency)
            == generated_extensions::artifact_product(extension);
        let inherited = if same_owner {
            let mut inherited = dependency;
            inherited.package = extension.package;
            inherited.package_dependencies = extension.package_dependencies;
            inherited
        } else {
            dependency
        };
        let mut candidates = extension
            .package_dependencies
            .iter()
            .filter(|candidate| candidate.sql_name() == dependency.sql_name())
            .copied()
            .collect::<Vec<_>>();
        if same_owner && inherited.package.is_some() {
            candidates.push(inherited);
        }
        if let Some(explicit) = requested.get(dependency.sql_name()) {
            candidates.push(*explicit);
        }
        if candidates.is_empty() {
            candidates.push(
                resolved
                    .iter()
                    .find(|candidate| candidate.sql_name() == dependency.sql_name())
                    .copied()
                    .unwrap_or(inherited),
            );
        }
        // Check acquired contexts before an older caller's empty attachment table.
        candidates.sort_by_key(|candidate| candidate.package_dependencies.is_empty());
        let package = candidates[0].package;
        for selected in candidates {
            if selected.package != package
                || (inherited.package.is_some() && selected.package != inherited.package)
            {
                return Err(Error::InvalidConfig(format!(
                    "conflicting native extension packages for {}",
                    selected.sql_name()
                )));
            }
            if extension.package.is_some() && !same_owner && selected.package.is_none() {
                return Err(Error::InvalidConfig(format!(
                    "native extension package {} requires an installed package for {}",
                    extension.sql_name(),
                    selected.sql_name()
                )));
            }
            if let (Some(owner), Some(dependency)) = (extension.package, selected.package)
                && owner.runtime_version != dependency.runtime_version
            {
                return Err(Error::InvalidConfig(format!(
                    "native extension packages {} and {} require different runtime versions",
                    extension.sql_name(),
                    selected.sql_name()
                )));
            }
            visit_extension(selected, requested, visiting, visited, resolved)?;
        }
    }
    visiting.remove(extension.sql_name());
    visited.push(extension);
    if !resolved
        .iter()
        .any(|previous| previous.sql_name() == extension.sql_name())
    {
        resolved.push(extension);
    }
    Ok(())
}

fn packaged_resource<'a>(
    package: &'a ExtensionPackage,
    relative: &str,
    executable_allowed: bool,
) -> Result<Option<&'a [u8]>> {
    use sha2::{Digest, Sha256};

    let mut found = None;
    for &(path, bytes, digest, executable) in package.resources {
        if path != relative {
            continue;
        }
        if (!executable_allowed && executable)
            || format!("{:x}", Sha256::digest(bytes)) != digest
            || found.is_some()
        {
            return Err(Error::InvalidConfig(format!(
                "invalid packaged native extension metadata: {relative}"
            )));
        }
        found = Some(bytes);
    }
    Ok(found)
}

fn packaged_dependencies(
    extension: Extension,
    package: &ExtensionPackage,
) -> Result<Vec<Extension>> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Requirements {
        schema: String,
        product: String,
        version: String,
        runtime_version: String,
        sql_name: String,
        dependencies: Vec<String>,
    }

    let relative = format!(
        "extension/{}/.oliphaunt/{}.json",
        package.product,
        extension.sql_name()
    );
    let dependencies = if let Some(bytes) = packaged_resource(package, &relative, false)? {
        let requirements: Requirements = serde_json::from_slice(bytes).map_err(|error| {
            Error::InvalidConfig(format!(
                "read packaged native extension requirements: {error}"
            ))
        })?;
        if requirements.schema != "oliphaunt-native-extension-requirements-v1"
            || requirements.product != package.product
            || requirements.version != package.version
            || requirements.runtime_version != package.runtime_version
            || requirements.sql_name != extension.sql_name()
            || requirements
                .dependencies
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || requirements
                .dependencies
                .iter()
                .any(|name| name == extension.sql_name())
        {
            return Err(Error::InvalidConfig(format!(
                "invalid packaged native extension requirements for {}",
                extension.sql_name()
            )));
        }
        requirements.dependencies
    } else {
        legacy_packaged_dependencies(extension, package)?
    };
    dependencies
        .into_iter()
        .filter(|name| name != "plpgsql")
        .map(|name| {
            Extension::by_sql_name(&name).ok_or_else(|| {
                Error::InvalidConfig(format!(
                    "native extension package {} requires unknown extension {name}",
                    extension.sql_name()
                ))
            })
        })
        .collect()
}

fn legacy_packaged_dependencies(
    extension: Extension,
    package: &ExtensionPackage,
) -> Result<Vec<String>> {
    let mut controls = BTreeMap::new();
    for &member in extension.sql_members() {
        let relative = format!(
            "extension/{}/share/postgresql/extension/{member}.control",
            package.product
        );
        if let Some(bytes) = packaged_resource(package, &relative, false)? {
            let text = std::str::from_utf8(bytes).map_err(|error| {
                Error::InvalidConfig(format!("read packaged control {relative}: {error}"))
            })?;
            controls.insert(member, control_requirements(text, &relative)?);
        }
    }
    if !controls.contains_key(extension.sql_name()) {
        let sql_prefix = format!(
            "extension/{}/share/postgresql/extension/{}",
            package.product,
            extension.sql_name()
        );
        let has_sql_evidence = package.resources.iter().any(|resource| {
            resource.0.strip_prefix(&sql_prefix).is_some_and(|suffix| {
                suffix == ".control"
                    || (suffix.starts_with("--") && suffix.ends_with(".sql"))
                    || suffix == ".sql"
            })
        });
        // The supported legacy module-only adapter uses the stable identity and
        // actual primary module bytes; it does not invent historical lifecycle metadata.
        if !extension.creates_extension()
            && extension.sql_members().is_empty()
            && !has_sql_evidence
            && let Some(module) = extension.native_module_file()
        {
            for profile in ["postgresql", "modules"] {
                let relative = format!("extension/{}/lib/{profile}/{module}", package.product);
                if packaged_resource(package, &relative, true)?.is_some() {
                    return Ok(Vec::new());
                }
            }
        }
        return Err(Error::InvalidConfig(format!(
            "native extension package {} has no frozen dependency metadata or primary control",
            extension.sql_name()
        )));
    }
    let mut dependencies = BTreeSet::new();
    for (member, requirements) in &controls {
        for name in requirements {
            if name.as_str() == *member {
                return Err(Error::InvalidConfig(format!(
                    "packaged native extension control {member} requires itself"
                )));
            }
            if !controls.contains_key(name.as_str()) {
                dependencies.insert(name.clone());
            }
        }
    }
    Ok(dependencies.into_iter().collect())
}

fn control_requirements(text: &str, label: &str) -> Result<Vec<String>> {
    let invalid = || Error::InvalidConfig(format!("invalid requires in packaged control {label}"));
    let mut requirements = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            if line.split_whitespace().next() == Some("requires") {
                return Err(invalid());
            }
            continue;
        };
        if key.trim() != "requires" {
            continue;
        }
        if requirements.is_some() {
            return Err(invalid());
        }
        let value = value.trim_start();
        let value = if let Some(quoted) = value.strip_prefix('\'') {
            let end = quoted.find('\'').ok_or_else(&invalid)?;
            let rest = quoted[end + 1..].trim_start();
            if !rest.is_empty() && !rest.starts_with('#') {
                return Err(invalid());
            }
            &quoted[..end]
        } else {
            let value = value.split('#').next().unwrap_or_default().trim();
            if value.is_empty() {
                return Err(invalid());
            }
            value
        };
        let names = if value.trim().is_empty() {
            Vec::new()
        } else {
            value
                .split(',')
                .map(|name| name.trim().to_owned())
                .collect::<Vec<_>>()
        };
        let mut seen = BTreeSet::new();
        if names.iter().any(|name| {
            name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || !seen.insert(name)
        }) {
            return Err(invalid());
        }
        requirements = Some(names);
    }
    // PostgreSQL controls without a requires setting declare no SQL prerequisites.
    Ok(requirements.unwrap_or_default())
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

    fn package(
        product: &'static str,
        version: &'static str,
        resources: Vec<(String, Vec<u8>)>,
    ) -> &'static ExtensionPackage {
        use sha2::{Digest, Sha256};
        let resources = resources
            .into_iter()
            .map(|(path, bytes)| {
                let digest = Box::leak(format!("{:x}", Sha256::digest(&bytes)).into_boxed_str());
                (
                    Box::leak(path.into_boxed_str()) as &str,
                    Box::leak(bytes.into_boxed_slice()) as &[u8],
                    digest as &str,
                    false,
                )
            })
            .collect::<Vec<_>>();
        Box::leak(Box::new(ExtensionPackage {
            product,
            version,
            runtime_version: "0.2.0",
            resources: Box::leak(resources.into_boxed_slice()),
        }))
    }

    fn requirements(
        product: &str,
        version: &str,
        sql_name: &str,
        dependencies: &[&str],
    ) -> (String, Vec<u8>) {
        (
            format!("extension/{product}/.oliphaunt/{sql_name}.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": "oliphaunt-native-extension-requirements-v1",
                "product": product,
                "version": version,
                "runtime_version": "0.2.0",
                "sql_name": sql_name,
                "dependencies": dependencies,
            }))
            .unwrap(),
        )
    }

    #[test]
    fn selected_packages_follow_dependencies_and_reject_identity_conflicts() {
        let product = "oliphaunt-extension-contrib-pg18";
        let package = package(
            product,
            "9.8.7",
            vec![
                requirements(product, "9.8.7", "earthdistance", &["cube"]),
                requirements(product, "9.8.7", "cube", &[]),
            ],
        );
        let other = Box::leak(Box::new(ExtensionPackage {
            version: "9.8.8",
            ..*package
        }));
        let selected = Extension::EARTHDISTANCE.with_package(package);
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
                .all(|extension| extension.package() == Some(package))
        );
        assert!(
            resolve_extensions(&[selected, Extension::EARTHDISTANCE.with_package(other)]).is_err()
        );
        assert!(resolve_extensions(&[selected, Extension::CUBE.with_package(other)]).is_err());
        assert!(resolve_extensions(&[Extension::VECTOR.with_package(package)]).is_err());
    }

    #[test]
    fn packaged_dependencies_use_frozen_records_and_explicit_foreign_packages() {
        let product = "oliphaunt-extension-postgis";
        let old = package(
            product,
            "3.6.3",
            vec![requirements(product, "3.6.3", "postgis", &[])],
        );
        let postgis = Extension::POSTGIS.with_package(old);
        assert_eq!(resolve_extensions(&[postgis]).unwrap(), [postgis]);
        assert_eq!(
            resolve_extensions(&[Extension::POSTGIS]).unwrap(),
            [Extension::FUZZYSTRMATCH, Extension::POSTGIS]
        );

        let current = package(
            product,
            "3.6.4",
            vec![requirements(
                product,
                "3.6.4",
                "postgis",
                &["fuzzystrmatch"],
            )],
        );
        let postgis = Extension::POSTGIS.with_package(current);
        assert!(
            resolve_extensions(&[postgis])
                .unwrap_err()
                .to_string()
                .contains("requires an installed package")
        );
        let contrib = "oliphaunt-extension-contrib-pg18";
        let fuzzy = Extension::FUZZYSTRMATCH.with_package(package(
            contrib,
            "0.2.0",
            vec![requirements(contrib, "0.2.0", "fuzzystrmatch", &[])],
        ));
        assert_eq!(
            resolve_extensions(&[postgis, fuzzy]).unwrap(),
            [fuzzy, postgis]
        );
        let bound = postgis.with_dependencies(Box::leak(vec![fuzzy].into_boxed_slice()));
        assert_eq!(
            resolve_extensions(&[bound]).unwrap(),
            [fuzzy, bound.with_dependencies(&[])]
        );
        let old_bound = Extension::POSTGIS
            .with_package(old)
            .with_dependencies(Box::leak(vec![fuzzy].into_boxed_slice()));
        assert_eq!(
            resolve_extensions(&[old_bound]).unwrap(),
            [old_bound.with_dependencies(&[])],
            "an unused acquired descriptor cannot add a historical edge"
        );

        let other_fuzzy = Extension::FUZZYSTRMATCH.with_package(package(
            contrib,
            "0.2.1",
            vec![requirements(contrib, "0.2.1", "fuzzystrmatch", &[])],
        ));
        let differently_bound =
            postgis.with_dependencies(Box::leak(vec![other_fuzzy].into_boxed_slice()));
        assert!(
            resolve_extensions(&[bound, differently_bound])
                .unwrap_err()
                .to_string()
                .contains("conflicting native extension packages for fuzzystrmatch")
        );
        assert_eq!(
            resolve_extensions(&[bound, bound]).unwrap(),
            [fuzzy, bound.with_dependencies(&[])]
        );
        assert!(
            resolve_extensions(&[bound, other_fuzzy])
                .unwrap_err()
                .to_string()
                .contains("conflicting native extension packages")
        );
        let wrong_host = Box::leak(Box::new(ExtensionPackage {
            runtime_version: "0.2.1",
            ..*fuzzy.package().unwrap()
        }));
        let wrong_host = postgis.with_dependencies(Box::leak(
            vec![Extension::FUZZYSTRMATCH.with_package(wrong_host)].into_boxed_slice(),
        ));
        assert!(
            resolve_extensions(&[wrong_host])
                .unwrap_err()
                .to_string()
                .contains("different runtime versions")
        );

        for dependencies in [
            vec!["postgis"],
            vec!["unknown"],
            vec!["fuzzystrmatch", "fuzzystrmatch"],
        ] {
            let invalid = package(
                product,
                "3.6.4",
                vec![requirements(product, "3.6.4", "postgis", &dependencies)],
            );
            assert!(resolve_extensions(&[Extension::POSTGIS.with_package(invalid)]).is_err());
        }
        let mismatched = package(
            product,
            "3.6.3",
            vec![requirements(product, "3.6.4", "postgis", &[])],
        );
        assert!(resolve_extensions(&[Extension::POSTGIS.with_package(mismatched)]).is_err());
        let (path, bytes) = requirements(product, "3.6.3", "postgis", &[]);
        let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown.as_object_mut().unwrap().remove("dependencies");
        let unknown = package(
            product,
            "3.6.3",
            vec![(path, serde_json::to_vec(&unknown).unwrap())],
        );
        assert!(resolve_extensions(&[Extension::POSTGIS.with_package(unknown)]).is_err());
    }

    #[test]
    fn attached_dependency_contexts_reject_nested_conflicts_and_cycles() {
        let contrib = "oliphaunt-extension-contrib-pg18";
        let fuzzy = |version| {
            Extension::FUZZYSTRMATCH.with_package(package(
                contrib,
                version,
                vec![requirements(contrib, version, "fuzzystrmatch", &[])],
            ))
        };
        let vector_product = "oliphaunt-extension-vector";
        let independent_vector = Extension::VECTOR.with_package(package(
            vector_product,
            "1.0.0",
            vec![requirements(vector_product, "1.0.0", "vector", &[])],
        ));
        let siblings = package(
            contrib,
            "0.2.0",
            vec![
                requirements(contrib, "0.2.0", "earthdistance", &["cube"]),
                requirements(contrib, "0.2.0", "cube", &["vector"]),
            ],
        );
        let earthdistance = Extension::EARTHDISTANCE
            .with_package(siblings)
            .with_dependencies(Box::leak(vec![independent_vector].into_boxed_slice()));
        let inherited = resolve_extensions(&[earthdistance]).unwrap();
        assert_eq!(
            inherited
                .iter()
                .map(|extension| extension.sql_name())
                .collect::<Vec<_>>(),
            ["vector", "cube", "earthdistance"]
        );
        assert!(
            inherited
                .iter()
                .all(|extension| extension.package_dependencies.is_empty())
        );
        assert_eq!(resolve_extensions(&inherited).unwrap(), inherited);
        let vector_package = package(
            vector_product,
            "1.0.0",
            vec![requirements(
                vector_product,
                "1.0.0",
                "vector",
                &["fuzzystrmatch"],
            )],
        );
        let vector = |version| {
            Extension::VECTOR
                .with_package(vector_package)
                .with_dependencies(Box::leak(vec![fuzzy(version)].into_boxed_slice()))
        };
        let postgis_product = "oliphaunt-extension-postgis";
        let postgis = Extension::POSTGIS
            .with_package(package(
                postgis_product,
                "3.6.4",
                vec![requirements(
                    postgis_product,
                    "3.6.4",
                    "postgis",
                    &["vector"],
                )],
            ))
            .with_dependencies(Box::leak(vec![vector("0.2.0")].into_boxed_slice()));
        let pgtap_product = "oliphaunt-extension-pgtap";
        let pgtap = Extension::PGTAP
            .with_package(package(
                pgtap_product,
                "1.3.4",
                vec![requirements(pgtap_product, "1.3.4", "pgtap", &["vector"])],
            ))
            .with_dependencies(Box::leak(vec![vector("0.2.1")].into_boxed_slice()));
        assert!(
            resolve_extensions(&[postgis, pgtap])
                .unwrap_err()
                .to_string()
                .contains("conflicting native extension packages for fuzzystrmatch")
        );
        assert!(
            resolve_extensions(&[postgis, vector("0.2.1")])
                .unwrap_err()
                .to_string()
                .contains("conflicting native extension packages for fuzzystrmatch")
        );

        let sibling = |version| {
            Extension::EARTHDISTANCE
                .with_package(siblings)
                .with_dependencies(Box::leak(vec![vector(version)].into_boxed_slice()))
        };
        let postgis_sibling = Extension::POSTGIS
            .with_package(package(
                postgis_product,
                "3.6.5",
                vec![requirements(
                    postgis_product,
                    "3.6.5",
                    "postgis",
                    &["earthdistance"],
                )],
            ))
            .with_dependencies(Box::leak(vec![sibling("0.2.0")].into_boxed_slice()));
        let pgtap_sibling = Extension::PGTAP
            .with_package(package(
                pgtap_product,
                "1.3.5",
                vec![requirements(
                    pgtap_product,
                    "1.3.5",
                    "pgtap",
                    &["earthdistance"],
                )],
            ))
            .with_dependencies(Box::leak(vec![sibling("0.2.1")].into_boxed_slice()));
        assert!(
            resolve_extensions(&[postgis_sibling, pgtap_sibling])
                .unwrap_err()
                .to_string()
                .contains("conflicting native extension packages for fuzzystrmatch")
        );

        let cyclic_vector = Extension::VECTOR.with_package(package(
            vector_product,
            "1.0.0",
            vec![requirements(
                vector_product,
                "1.0.0",
                "vector",
                &["postgis"],
            )],
        ));
        let cyclic = postgis.with_dependencies(Box::leak(vec![cyclic_vector].into_boxed_slice()));
        assert!(
            resolve_extensions(&[cyclic])
                .unwrap_err()
                .to_string()
                .contains("cyclic native extension dependency")
        );
    }

    #[test]
    fn unused_cyclic_attachment_tables_do_not_recurse_or_escape_resolution() {
        static A: [Extension; 1] = [Extension::VECTOR.with_dependencies(&B)];
        static B: [Extension; 1] = [Extension::VECTOR.with_dependencies(&A)];
        let first = Extension::VECTOR.with_dependencies(&A);
        let second = Extension::VECTOR.with_dependencies(&B);
        let resolved = resolve_extensions(&[first, first, second]).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].sql_name(), "vector");
        assert!(resolved[0].package_dependencies.is_empty());
        let repeated = resolve_extensions(&resolved).unwrap();
        assert_eq!(repeated.len(), 1);
        assert_eq!(repeated[0].sql_name(), "vector");
        assert!(repeated[0].package_dependencies.is_empty());

        let product = "oliphaunt-extension-postgis";
        let old = package(
            product,
            "3.6.3",
            vec![requirements(product, "3.6.3", "postgis", &[])],
        );
        let old = Extension::POSTGIS.with_package(old);
        let resolved =
            resolve_extensions(&[old.with_dependencies(&A), old.with_dependencies(&B)]).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].sql_name(), "postgis");
        assert!(resolved[0].package_dependencies.is_empty());
    }

    #[test]
    fn legacy_packages_follow_only_their_actual_control_requirements() {
        let product = "oliphaunt-extension-postgis";
        let control = |member: &str, text: &str| {
            (
                format!("extension/{product}/share/postgresql/extension/{member}.control"),
                text.as_bytes().to_vec(),
            )
        };
        let old = package(
            product,
            "3.6.3",
            vec![control("postgis", "comment = 'historical primary only'\n")],
        );
        let postgis = Extension::POSTGIS.with_package(old);
        assert_eq!(resolve_extensions(&[postgis]).unwrap(), [postgis]);
        let companions = package(
            product,
            "3.6.4",
            vec![
                control("postgis", "comment = 'primary'\n"),
                control(
                    "postgis_tiger_geocoder",
                    "requires = 'postgis, fuzzystrmatch' # own frozen prerequisites\n",
                ),
            ],
        );
        assert!(
            resolve_extensions(&[Extension::POSTGIS.with_package(companions)])
                .unwrap_err()
                .to_string()
                .contains("requires an installed package")
        );
        let missing = package(
            product,
            "3.6.3",
            vec![(
                format!("extension/{product}/README.md"),
                b"missing control".to_vec(),
            )],
        );
        assert!(
            resolve_extensions(&[Extension::POSTGIS.with_package(missing)])
                .unwrap_err()
                .to_string()
                .contains("no frozen dependency metadata or primary control")
        );
        for malformed in [
            "requires =\n",
            "requires = #comment\n",
            "requires\n",
            "requires = 'cube\n",
            "requires = 'cube' trailing\n",
            "requires = 'cube,cube'\n",
            "requires = 'cube'\nrequires = 'hstore'\n",
        ] {
            assert!(control_requirements(malformed, "fixture").is_err());
        }
        assert_eq!(
            control_requirements("requires = ''\n", "fixture").unwrap(),
            Vec::<String>::new()
        );

        let contrib = "oliphaunt-extension-contrib-pg18";
        let module = Extension::AUTO_EXPLAIN.native_module_file().unwrap();
        let module_path = format!("extension/{contrib}/lib/postgresql/{module}");
        let legacy_module = package(
            contrib,
            "0.2.0",
            vec![(module_path, b"actual legacy module".to_vec())],
        );
        let auto_explain = Extension::AUTO_EXPLAIN.with_package(legacy_module);
        assert_eq!(resolve_extensions(&[auto_explain]).unwrap(), [auto_explain]);
        let malformed_module = package(
            contrib,
            "0.2.0",
            vec![
                (
                    format!("extension/{contrib}/lib/postgresql/{module}"),
                    b"legacy module".to_vec(),
                ),
                (
                    format!("extension/{contrib}/share/postgresql/extension/auto_explain.control"),
                    b"requires =\n".to_vec(),
                ),
            ],
        );
        assert!(
            resolve_extensions(&[Extension::AUTO_EXPLAIN.with_package(malformed_module)]).is_err()
        );
        let missing = package(
            contrib,
            "0.2.0",
            vec![(
                format!("extension/{contrib}/README.md"),
                b"no module".to_vec(),
            )],
        );
        assert!(resolve_extensions(&[Extension::AUTO_EXPLAIN.with_package(missing)]).is_err());
    }
}
