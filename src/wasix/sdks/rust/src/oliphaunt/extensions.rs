use std::collections::{BTreeMap, BTreeSet};

#[cfg(all(test, feature = "extension-pg-textsearch"))]
use anyhow::bail;
use anyhow::{Context, Result, ensure};

use crate::oliphaunt::config::PostgresConfig;

const SHARED_PRELOAD_LIBRARIES: &str = "shared_preload_libraries";

#[path = "generated_extensions.rs"]
mod generated;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ExtensionNativeModule {
    runtime_path: &'static str,
    aot_name: Option<&'static str>,
}

impl ExtensionNativeModule {
    pub(crate) const fn runtime_path(self) -> &'static str {
        self.runtime_path
    }

    pub(crate) const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }
}

/// A bundled PostgreSQL extension artifact that Oliphaunt can make available.
///
/// Selecting an extension does not run `CREATE EXTENSION`, `LOAD`, or other
/// database-local SQL. Applications retain ordinary migration ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Extension {
    sql_name: &'static str,
    native_support_modules: &'static [ExtensionNativeModule],
    native_module_file: Option<&'static str>,
    aot_name: Option<&'static str>,
    dependencies: &'static [&'static str],
    startup_config: &'static [&'static str],
    package: Option<&'static ExtensionPackage>,
}

impl Extension {
    /// Bind extension metadata to the exact package selected by Cargo.
    #[doc(hidden)]
    pub const fn with_package(mut self, package: &'static ExtensionPackage) -> Self {
        self.package = Some(package);
        self
    }

    pub(crate) const fn package(self) -> Option<&'static ExtensionPackage> {
        self.package
    }

    /// SQL extension name used in `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        self.sql_name
    }

    /// Resolve a known extension artifact by its SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|extension| extension.sql_name == sql_name)
    }

    pub(crate) const fn aot_name(self) -> Option<&'static str> {
        self.aot_name
    }

    pub(crate) const fn native_module_file(self) -> Option<&'static str> {
        self.native_module_file
    }

    pub(crate) const fn native_support_modules(self) -> &'static [ExtensionNativeModule] {
        self.native_support_modules
    }

    pub(crate) const fn dependencies(self) -> &'static [&'static str] {
        self.dependencies
    }

    pub(crate) const fn startup_config(self) -> &'static [&'static str] {
        if let Some(package) = self.package
            && let Some(install) = package.install
        {
            return install.startup_config;
        }
        // Legacy descriptors never carried lifecycle facts; their caller/SDK policy remains explicit.
        self.startup_config
    }

    fn required_sql_names(self) -> Result<Vec<String>> {
        if let Some(package) = self.package {
            if let Some(install) = package.install {
                return Ok(install
                    .dependencies
                    .iter()
                    .map(|name| (*name).to_owned())
                    .collect());
            }
            return legacy_package_dependencies(package, self.sql_name());
        }
        Ok(self
            .dependencies()
            .iter()
            .map(|name| (*name).to_owned())
            .collect())
    }

    pub(crate) fn required_native_modules(self) -> Result<Vec<(String, Option<String>)>> {
        if let Some(package) = self.package {
            if let Some(install) = package.install {
                return Ok(install
                    .native_modules
                    .iter()
                    .map(|(path, name)| ((*path).to_owned(), Some((*name).to_owned())))
                    .collect());
            }
            let files = legacy_package_files(package, self.sql_name())?;
            let modules: Vec<_> = files
                .iter()
                .filter(|(path, _)| path.starts_with("lib/") && path.ends_with(".so"))
                .collect();
            if modules.is_empty() {
                return Ok(Vec::new());
            }
            let identities = super::aot::package_module_identities(package.aot_manifest())?;
            use sha2::{Digest, Sha256};
            return modules
                .into_iter()
                .map(|(path, bytes)| {
                    let digest = format!("{:x}", Sha256::digest(bytes));
                    let matches: Vec<_> = identities
                        .iter()
                        .filter(|(_, hash)| *hash == digest)
                        .collect();
                    ensure!(
                        matches.len() == 1,
                        "legacy package module {path} must match exactly one original AOT identity"
                    );
                    Ok((path.clone(), Some(matches[0].0.clone())))
                })
                .collect();
        }
        let mut modules: Vec<_> = self
            .native_support_modules()
            .iter()
            .map(|module| {
                (
                    module.runtime_path().to_owned(),
                    module.aot_name().map(str::to_owned),
                )
            })
            .collect();
        if let Some(module) = self.native_module_file() {
            modules.push((
                format!("lib/postgresql/{module}"),
                self.aot_name().map(str::to_owned),
            ));
        }
        Ok(modules)
    }
}

pub fn resolve_extension_set(extensions: &[Extension]) -> Result<Vec<Extension>> {
    let mut visiting = BTreeSet::new();
    let mut visited = Vec::new();
    let mut resolved = Vec::new();
    let mut requested = extensions.to_vec();
    requested.sort_by_key(|extension| extension.sql_name());
    for pair in requested.windows(2) {
        if pair[0].sql_name() == pair[1].sql_name() && pair[0] != pair[1] {
            return Err(crate::error::invalid_configuration(format!(
                "conflicting packages selected for extension '{}'",
                pair[0].sql_name()
            )));
        }
    }
    let selected: BTreeMap<_, _> = requested
        .iter()
        .map(|extension| (extension.sql_name(), *extension))
        .collect();
    for extension in requested {
        if Extension::by_sql_name(extension.sql_name()).is_none() {
            return Err(crate::error::invalid_configuration(format!(
                "unsupported extension '{}'",
                extension.sql_name()
            )));
        }
        visit_extension(
            extension,
            &selected,
            extension
                .package
                .map_or(&[], |package| package.dependencies),
            &mut visiting,
            &mut visited,
            &mut resolved,
        )?;
    }
    Ok(resolved)
}

/// Merge startup settings required by selected extensions into the caller's
/// PostgreSQL configuration before either a cluster seed or a backend is started.
///
/// `shared_preload_libraries` is a list-valued GUC, so caller-provided and
/// extension-required entries are unioned in stable first-seen order. Other
/// extension startup settings may reuse an identical caller value, but a
/// conflicting value is rejected instead of silently weakening the extension
/// contract.
pub fn postgres_config_with_extension_startup(
    mut postgres_config: PostgresConfig,
    extensions: &[Extension],
) -> Result<PostgresConfig> {
    let mut shared_preload_libraries = Vec::new();
    let mut seen_shared_preload_libraries = BTreeSet::new();
    if let Some(configured) = postgres_config.get(SHARED_PRELOAD_LIBRARIES) {
        append_unique_csv_values(
            configured,
            &mut shared_preload_libraries,
            &mut seen_shared_preload_libraries,
        );
    }

    for extension in extensions {
        for assignment in extension.startup_config() {
            let (name, value) = parse_startup_config_assignment(*extension, assignment)?;

            if name == SHARED_PRELOAD_LIBRARIES {
                append_unique_csv_values(
                    value,
                    &mut shared_preload_libraries,
                    &mut seen_shared_preload_libraries,
                );
                continue;
            }

            if let Some(configured) = postgres_config.get(name) {
                if configured != value {
                    return Err(crate::error::invalid_configuration(format!(
                        "extension '{}' requires PostgreSQL startup config {name}={value}, but the caller configured {name}={configured}",
                        extension.sql_name()
                    )));
                }
            } else {
                postgres_config.insert(name, value);
            }
        }
    }

    if !shared_preload_libraries.is_empty() {
        postgres_config.insert(SHARED_PRELOAD_LIBRARIES, shared_preload_libraries.join(","));
    }
    postgres_config.validate()?;
    Ok(postgres_config)
}

#[cfg(all(test, feature = "extension-pg-textsearch"))]
pub(crate) fn ensure_extension_startup_config_is_active(
    postgres_config: &PostgresConfig,
    extension: Extension,
) -> Result<()> {
    for assignment in extension.startup_config() {
        let (name, required) = parse_startup_config_assignment(extension, assignment)?;
        let configured = postgres_config.get(name);
        let satisfied = if name == SHARED_PRELOAD_LIBRARIES {
            let configured_values = configured
                .into_iter()
                .flat_map(comma_separated_values)
                .collect::<BTreeSet<_>>();
            comma_separated_values(required).all(|value| configured_values.contains(value))
        } else {
            configured == Some(required)
        };

        if !satisfied {
            let configured = configured
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("<unset>");
            bail!(
                "extension '{}' requires PostgreSQL startup config {name}={required} before PostgreSQL starts, but the already-running backend has {name}={configured}; reopen the database with this extension selected on OliphauntBuilder (call .extension(...) before .open()), because it cannot be enabled safely after startup",
                extension.sql_name()
            );
        }
    }
    Ok(())
}

fn parse_startup_config_assignment(extension: Extension, assignment: &str) -> Result<(&str, &str)> {
    let (name, value) = assignment.split_once('=').ok_or_else(|| {
        crate::error::invalid_configuration(format!(
            "extension '{}' has invalid startup config assignment '{assignment}'; expected name=value",
            extension.sql_name()
        ))
    })?;
    let name = name.trim();
    let value = value.trim();
    if name.is_empty() {
        return Err(crate::error::invalid_configuration(format!(
            "extension '{}' has an empty startup config name in assignment '{assignment}'",
            extension.sql_name()
        )));
    }
    if value.is_empty() {
        return Err(crate::error::invalid_configuration(format!(
            "extension '{}' has an empty startup config value in assignment '{assignment}'",
            extension.sql_name()
        )));
    }
    Ok((name, value))
}

fn append_unique_csv_values(value: &str, ordered: &mut Vec<String>, seen: &mut BTreeSet<String>) {
    for item in comma_separated_values(value) {
        if seen.insert(item.to_owned()) {
            ordered.push(item.to_owned());
        }
    }
}

fn comma_separated_values(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

fn visit_extension(
    extension: Extension,
    selected: &BTreeMap<&'static str, Extension>,
    package_dependencies: &'static [ExtensionPackageDependency],
    visiting: &mut BTreeSet<&'static str>,
    visited: &mut Vec<(Extension, &'static [ExtensionPackageDependency])>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    if let Some(package) = extension.package
        && package.runtime_version() != liboliphaunt_wasix_portable::PACKAGE_VERSION
    {
        return Err(crate::error::invalid_configuration(format!(
            "{}@{} requires WASIX runtime {}, selected {}",
            package.product(),
            package.version(),
            package.runtime_version(),
            liboliphaunt_wasix_portable::PACKAGE_VERSION
        )));
    }
    if resolved
        .iter()
        .any(|prior| prior.sql_name() == extension.sql_name() && *prior != extension)
    {
        return Err(crate::error::invalid_configuration(format!(
            "conflicting packages selected for extension '{}'",
            extension.sql_name()
        )));
    }
    if visiting.contains(extension.sql_name()) {
        return Err(crate::error::invalid_configuration(format!(
            "cyclic extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    // Resource identity excludes acquisition tables, so validate each distinct reachable context.
    if visited.iter().any(|(prior, dependencies)| {
        *prior == extension && std::ptr::eq(*dependencies, package_dependencies)
    }) {
        return Ok(());
    }
    visiting.insert(extension.sql_name());
    for dependency in extension.required_sql_names()? {
        if dependency == "plpgsql" {
            continue;
        }
        let mut dependency_extension = Extension::by_sql_name(&dependency).ok_or_else(|| {
            crate::error::invalid_configuration(format!(
                "selected extension '{}' depends on missing catalog extension '{}'",
                extension.sql_name(),
                dependency
            ))
        })?;
        let mut dependency_package: Option<&'static ExtensionPackage> = None;
        for candidate in package_dependencies
            .iter()
            .filter(|candidate| candidate.sql_name == dependency)
        {
            ensure!(
                dependency_package.is_none_or(|prior| prior == &candidate.package),
                "conflicting packages selected for extension '{dependency}'"
            );
            dependency_package = Some(&candidate.package);
        }
        if let Some(package) = dependency_package {
            dependency_extension = dependency_extension.with_package(package);
        } else if let Some(package) = extension.package
            && package.install.is_none()
            && package
                .archives()
                .iter()
                .any(|(name, _, _)| *name == dependency)
        {
            dependency_extension = dependency_extension.with_package(package);
        }
        let mut dependency_context = package_dependencies;
        if let Some(explicit) = selected.get(dependency.as_str()) {
            if dependency_extension.package.is_some() && dependency_extension != *explicit {
                return Err(crate::error::invalid_configuration(format!(
                    "conflicting packages selected for extension '{dependency}'"
                )));
            }
            if dependency_extension.package.is_none() {
                dependency_context = explicit.package.map_or(&[], |package| package.dependencies);
            }
            dependency_extension = *explicit;
        } else if dependency_extension.package.is_none()
            && extension
                .package
                .is_some_and(|package| package.install.is_some())
        {
            return Err(crate::error::invalid_configuration(format!(
                "packaged extension '{}' lacks its frozen dependency package '{dependency}'",
                extension.sql_name()
            )));
        }
        visit_extension(
            dependency_extension,
            selected,
            dependency_context,
            visiting,
            visited,
            resolved,
        )?;
    }
    visiting.remove(extension.sql_name());
    visited.push((extension, package_dependencies));
    if !resolved
        .iter()
        .any(|prior| prior.sql_name() == extension.sql_name())
    {
        resolved.push(extension);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn extension_smoke_sql(sql_name: &str) -> String {
    crate::oliphaunt::test_fixtures::text(&format!("extensions/{sql_name}.sql"))
}

#[cfg(test)]
pub(crate) fn extension_smoke_statements(sql: &str) -> impl Iterator<Item = &str> {
    sql.split("-- oliphaunt-statement")
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
}

#[cfg(test)]
fn extension_activation_sql_for_test(extension: Extension) -> Result<Vec<&'static str>> {
    Ok(resolve_extension_set(&[extension])?
        .into_iter()
        .flat_map(|resolved| generated::activation_sql_for_test(resolved).iter().copied())
        .collect())
}

#[cfg(all(test, feature = "extension-pg-textsearch"))]
mod startup_config_tests {
    use super::*;

    #[test]
    fn late_pg_textsearch_enable_requires_active_preload() {
        let error = ensure_extension_startup_config_is_active(
            &PostgresConfig::default(),
            Extension::PG_TEXTSEARCH,
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("shared_preload_libraries=pg_textsearch"));
        assert!(message.contains("already-running backend"));
        assert!(message.contains(".extension(...) before .open()"));

        let mut active = PostgresConfig::default();
        active.insert(
            "shared_preload_libraries",
            "auto_explain, pg_textsearch,pg_textsearch",
        );
        ensure_extension_startup_config_is_active(&active, Extension::PG_TEXTSEARCH).unwrap();
    }
}

#[cfg(all(test, feature = "extensions"))]
mod extension_tests {
    use super::*;
    use crate::DatabaseStorage;
    use crate::Oliphaunt;
    use anyhow::{Context, Result, ensure};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn public_extensions_pass_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(Extension::ALL)
    }

    #[test]
    fn public_extensions_materialize_only_requested_libraries() -> Result<()> {
        run_lifecycle_materialization_set(Extension::ALL)
    }

    #[allow(unsafe_code)]
    fn declared_contrib_extensions() -> Result<Vec<Extension>> {
        use serde::Deserialize;
        use sha2::{Digest, Sha256};

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Packet {
            product: String,
            version: String,
            runtime_version: String,
            archives: Vec<Archive>,
            aot_manifest: PathBuf,
            aot_artifacts: Vec<AotArtifact>,
            core_module_sha256: String,
            core_manifest: PathBuf,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Archive {
            sql_name: String,
            path: PathBuf,
            sha256: String,
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct AotArtifact {
            path: String,
            source: PathBuf,
        }

        let packet_path = std::env::var_os("OLIPHAUNT_DECLARED_EXTENSION_PACKET")
            .context("declared contrib lifecycle requires OLIPHAUNT_DECLARED_EXTENSION_PACKET")?;
        let packet: Packet = serde_json::from_slice(&std::fs::read(packet_path)?)?;
        ensure!(packet.product == "oliphaunt-extension-contrib-pg18");
        ensure!(packet.version == packet.runtime_version);
        ensure!(packet.runtime_version == liboliphaunt_wasix_portable::PACKAGE_VERSION);
        let runtime = crate::oliphaunt::assets::asset_manifest_metadata()?;
        ensure!(
            packet.core_module_sha256 == runtime.runtime_module_sha256,
            "declared contrib must execute its exact current source-built core"
        );
        let core_manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&packet.core_manifest)?)?;
        ensure!(
            core_manifest["runtime"]["module-sha256"].as_str()
                == Some(packet.core_module_sha256.as_str()),
            "declared core manifest differs from its physical module identity"
        );
        ensure!(
            core_manifest["source-fingerprint"].as_str() == runtime.source_fingerprint.as_deref()
                && core_manifest["runtime"]["postgres-version"].as_str()
                    == Some(runtime.postgres_version.as_str()),
            "declared core manifest differs from the SDK's compiled runtime supplier"
        );
        let canonical_names: Vec<String> = serde_json::from_str(
            option_env!("OLIPHAUNT_DECLARED_CONTRIB_SQL_NAMES")
                .context("declared contrib test requires its compiled canonical member names")?,
        )?;
        let canonical_extensions: Vec<_> = canonical_names
            .iter()
            .map(|name| {
                Extension::by_sql_name(name)
                    .context("declared contrib source member has no canonical SDK metadata")
            })
            .collect::<Result<_>>()?;
        let expected_names: BTreeSet<_> = canonical_extensions
            .iter()
            .map(|extension| extension.sql_name())
            .collect();
        let archive_names: BTreeSet<_> = packet
            .archives
            .iter()
            .map(|archive| archive.sql_name.as_str())
            .collect();
        ensure!(
            !expected_names.is_empty()
                && canonical_names.len() == expected_names.len()
                && packet.archives.len() == expected_names.len()
                && archive_names == expected_names,
            "declared contrib packet must contain all canonical members exactly once"
        );

        let aot_manifest_text = std::fs::read_to_string(&packet.aot_manifest)?;
        let aot_manifest: serde_json::Value = serde_json::from_str(&aot_manifest_text)?;
        ensure!(
            aot_manifest["source-fingerprint"].as_str() == runtime.source_fingerprint.as_deref()
                && aot_manifest["postgres-version"].as_str()
                    == Some(runtime.postgres_version.as_str()),
            "declared contrib AOT differs from its exact core supplier"
        );
        let manifest_artifacts = aot_manifest["artifacts"]
            .as_array()
            .context("declared contrib AOT manifest has no artifacts")?;
        let expected_aot_names: BTreeSet<_> = canonical_extensions
            .iter()
            .map(|extension| {
                extension
                    .aot_name()
                    .context("declared contrib member must have an AOT identity")
            })
            .collect::<Result<_>>()?;
        let actual_aot_names: BTreeSet<_> = manifest_artifacts
            .iter()
            .map(|artifact| {
                artifact["name"]
                    .as_str()
                    .context("declared contrib AOT artifact has no name")
            })
            .collect::<Result<_>>()?;
        let actual_aot_paths: BTreeSet<_> = manifest_artifacts
            .iter()
            .map(|artifact| {
                artifact["path"]
                    .as_str()
                    .context("declared contrib AOT artifact has no path")
            })
            .collect::<Result<_>>()?;
        let packet_aot_paths: BTreeSet<_> = packet
            .aot_artifacts
            .iter()
            .map(|artifact| artifact.path.as_str())
            .collect();
        ensure!(
            manifest_artifacts.len() == expected_aot_names.len()
                && actual_aot_names == expected_aot_names
                && actual_aot_paths.len() == manifest_artifacts.len()
                && packet.aot_artifacts.len() == manifest_artifacts.len()
                && packet_aot_paths == actual_aot_paths,
            "declared contrib AOT packet must contain its exact canonical host cohort"
        );

        let archives: Vec<(&'static str, &'static [u8], &'static str)> = packet
            .archives
            .into_iter()
            .map(|archive| {
                let bytes = std::fs::read(&archive.path)?;
                ensure!(
                    format!("{:x}", Sha256::digest(&bytes)) == archive.sha256,
                    "declared {} archive differs from its final npm identity",
                    archive.sql_name
                );
                Ok((
                    &*Box::leak(archive.sql_name.into_boxed_str()),
                    &*Box::leak(bytes.into_boxed_slice()),
                    &*Box::leak(archive.sha256.into_boxed_str()),
                ))
            })
            .collect::<Result<_>>()?;
        let aot_artifacts: Vec<(&'static str, &'static [u8])> = packet
            .aot_artifacts
            .into_iter()
            .map(|artifact| {
                let bytes = std::fs::read(&artifact.source)?;
                let metadata = manifest_artifacts
                    .iter()
                    .find(|entry| entry["path"].as_str() == Some(artifact.path.as_str()))
                    .context("declared AOT input has no manifest identity")?;
                ensure!(
                    Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
                        == metadata["sha256"].as_str(),
                    "declared AOT input differs from its final Cargo identity"
                );
                Ok((
                    &*Box::leak(
                        metadata["name"]
                            .as_str()
                            .context("declared AOT input has no module name")?
                            .to_owned()
                            .into_boxed_str(),
                    ),
                    &*Box::leak(bytes.into_boxed_slice()),
                ))
            })
            .collect::<Result<_>>()?;
        // The declared Bazel packet supplies trusted final-carrier AOT bytes; leaks stay in this test.
        let package = Box::leak(Box::new(unsafe {
            ExtensionPackage::from_trusted_release(
                Box::leak(packet.product.into_boxed_str()),
                Box::leak(packet.version.into_boxed_str()),
                Box::leak(packet.runtime_version.into_boxed_str()),
                Box::leak(archives.into_boxed_slice()),
                Box::leak(aot_manifest_text.into_boxed_str()),
                Box::leak(aot_artifacts.into_boxed_slice()),
            )
        }));
        let extensions: Vec<_> = canonical_extensions
            .iter()
            .map(|extension| extension.with_package(package))
            .collect();
        Ok(extensions)
    }

    #[test]
    #[ignore = "requires declared Bazel packet"]
    fn declared_contrib_carriers_pass_full_lifecycle() -> Result<()> {
        let extensions = declared_contrib_extensions()?;
        let package = extensions[0]
            .package()
            .context("declared contrib selection has no final package")?;
        run_direct_and_restart_smoke_set(&extensions)?;
        run_lifecycle_materialization_set(&extensions)?;

        let cube = Extension::by_sql_name("cube")
            .context("canonical contrib feature set lacks cube")?
            .with_package(package);
        let earthdistance = Extension::by_sql_name("earthdistance")
            .context("canonical contrib feature set lacks earthdistance")?
            .with_package(package);
        let root = tempfile::TempDir::new()?;
        let mut selected = Oliphaunt::builder()
            .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
            .extension(cube)
            .extension(earthdistance)
            .open()?;
        let runtime_root = selected
            .runtime_storage()
            .host_path()
            .context("selected contrib must use a host runtime workspace")?;
        assert_only_resolved_extension_libraries_are_materialized(runtime_root, earthdistance)?;
        ensure!(relative_files(&runtime_root.join("lib/postgresql")).len() == 2);
        run_direct_smoke(&mut selected, earthdistance)?;
        selected.close()?;
        Ok(())
    }

    #[cfg(feature = "tools-execution")]
    #[test]
    #[ignore = "requires declared Bazel extension and tools packets"]
    #[allow(unsafe_code)]
    fn declared_contrib_carriers_pass_logical_dump_restore() -> Result<()> {
        run_declared_logical_dump_restore(&declared_contrib_extensions()?)
    }

    #[cfg(all(feature = "tools-execution", feature = "extension-uuid-ossp"))]
    #[test]
    #[ignore = "requires exact current-source native-host extension and tools packets"]
    fn declared_uuid_ossp_carriers_pass_aot_host_smoke() -> Result<()> {
        let extensions = declared_contrib_extensions()?;
        ensure!(extensions.len() == 1 && extensions[0].sql_name() == "uuid-ossp");
        run_direct_and_restart_smoke_set(&extensions)?;
        run_lifecycle_materialization_set(&extensions)?;
        run_declared_logical_dump_restore(&extensions)
    }

    #[cfg(feature = "tools-execution")]
    #[allow(unsafe_code)]
    fn run_declared_logical_dump_restore(extensions: &[Extension]) -> Result<()> {
        use crate::tools::{PgDumpOptions, PsqlOptions, ToolAssets};
        use serde::Deserialize;

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Tool {
            wasm: PathBuf,
            aot: PathBuf,
            manifest: PathBuf,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Tools {
            version: String,
            runtime_version: String,
            pg_dump: Tool,
            psql: Tool,
        }

        let tools_path = std::env::var_os("OLIPHAUNT_DECLARED_TOOLS_PACKET")
            .context("declared contrib logical restore requires its final tools packet")?;
        let tools: Tools = serde_json::from_slice(&std::fs::read(tools_path)?)?;
        ensure!(
            Some(tools.version.as_str()) == option_env!("OLIPHAUNT_DECLARED_TOOLS_VERSION"),
            "declared tools differ from their canonical compiled product version"
        );
        ensure!(tools.runtime_version == liboliphaunt_wasix_portable::PACKAGE_VERSION);
        let assets = |tool: Tool| -> Result<ToolAssets> {
            // SAFETY: the runner validates these exact final-carrier bytes and manifests.
            Ok(unsafe {
                ToolAssets::new(
                    std::fs::read(tool.wasm)?,
                    std::fs::read(tool.aot)?,
                    std::fs::read_to_string(tool.manifest)?,
                )
            })
        };
        let pg_dump = assets(tools.pg_dump)?;
        let psql = assets(tools.psql)?;
        for &extension in extensions {
            let name = extension.sql_name();
            eprintln!("logical dump/restore extension: {name}");
            let mut source = Oliphaunt::builder().extension(extension).open()?;
            run_direct_smoke(&mut source, extension)?;
            source.exec("CREATE TABLE oliphaunt_logical_restore_probe(value text NOT NULL); INSERT INTO oliphaunt_logical_restore_probe VALUES ('retained')")?;
            let dump = source
                .pg_dump(PgDumpOptions::new().assets(pg_dump.clone()))
                .with_context(|| format!("dump declared contrib {name}"))?;
            ensure!(dump.contains("COPY public.oliphaunt_logical_restore_probe"));
            source.close()?;
            let mut restored = Oliphaunt::builder().extension(extension).open()?;
            restored
                .psql(PsqlOptions::new().assets(psql.clone()).script(dump))
                .with_context(|| format!("restore declared contrib {name}"))?;
            assert_extension_catalog_state(&mut restored, extension)?;
            verify_persisted_fixture(&mut restored, extension)?;
            ensure!(
                restored
                    .query("SELECT value FROM oliphaunt_logical_restore_probe")?
                    .get_text(0, "value")?
                    == Some("retained")
            );
            restored.close()?;
        }
        Ok(())
    }

    #[test]
    #[cfg(all(feature = "extension-cube", feature = "extension-earthdistance"))]
    fn dependent_extension_activation_includes_dependencies_first() -> Result<()> {
        let activation = extension_activation_sql_for_test(Extension::EARTHDISTANCE)?;
        assert_eq!(activation.len(), 2);
        assert!(activation[0].contains("\"cube\""));
        assert!(activation[1].contains("\"earthdistance\""));
        Ok(())
    }

    #[test]
    #[cfg(feature = "extension-uuid-ossp")]
    fn uuid_ossp_aot_direct_and_restart_smoke() -> Result<()> {
        run_direct_and_restart_smoke_set(&[Extension::UUID_OSSP])
    }

    #[test]
    #[cfg(feature = "extension-uuid-ossp")]
    fn uuid_ossp_aot_materialization_smoke() -> Result<()> {
        run_lifecycle_materialization_set(&[Extension::UUID_OSSP])
    }

    #[cfg(all(feature = "tools-execution", feature = "extension-uuid-ossp"))]
    #[test]
    fn uuid_ossp_aot_dump_restore_smoke() -> Result<()> {
        use crate::tools::{PgDumpOptions, PsqlOptions};

        let mut source = Oliphaunt::builder()
            .extension(Extension::UUID_OSSP)
            .open()
            .context("open UUID-OSSP AOT dump source")?;
        source
            .psql(PsqlOptions::new().script(
                "CREATE EXTENSION \"uuid-ossp\";\
                 CREATE TABLE uuid_ossp_aot_items(\
                   id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),\
                   label text NOT NULL\
                 );\
                INSERT INTO uuid_ossp_aot_items(label) VALUES ('first'), ('second');",
            ))
            .context("seed UUID-OSSP AOT dump source through psql")?;
        let dump = source
            .pg_dump(PgDumpOptions::new())
            .context("dump UUID-OSSP AOT source through pg_dump")?;
        ensure!(
            dump.contains("COPY public.uuid_ossp_aot_items"),
            "UUID-OSSP AOT dump should retain PostgreSQL COPY output"
        );
        source.close().context("close UUID-OSSP AOT dump source")?;

        let mut restored = Oliphaunt::builder()
            .extension(Extension::UUID_OSSP)
            .open()
            .context("open UUID-OSSP AOT restore target")?;
        restored
            .psql(PsqlOptions::new().script(dump))
            .context("restore UUID-OSSP AOT dump through psql")?;
        let result = restored.query(
            "SELECT count(*)::int4 AS rows,\
                    count(DISTINCT id)::int4 AS ids,\
                    bool_and(length(id::text) = 36) AS valid_ids,\
                    length(uuid_generate_v4()::text)::int4 AS generated_length \
             FROM uuid_ossp_aot_items",
        )?;
        ensure!(result.get_text(0, "rows")? == Some("2"));
        ensure!(result.get_text(0, "ids")? == Some("2"));
        ensure!(result.get_text(0, "valid_ids")? == Some("t"));
        ensure!(result.get_text(0, "generated_length")? == Some("36"));
        restored
            .close()
            .context("close UUID-OSSP AOT restore target")?;
        Ok(())
    }

    fn embedded_extension_archives(extensions: &[Extension]) -> Result<Vec<Extension>> {
        let embedded: Vec<_> = extensions
            .iter()
            .copied()
            .filter(|extension| {
                if let Some(package) = extension.package() {
                    package
                        .archives()
                        .iter()
                        .any(|(name, _, _)| *name == extension.sql_name())
                } else {
                    crate::oliphaunt::assets::extension_archive(extension.sql_name()).is_some()
                }
            })
            .collect();
        let embedded_names: BTreeSet<_> = embedded
            .iter()
            .map(|extension| extension.sql_name())
            .collect();
        let missing: Vec<_> = extensions
            .iter()
            .map(|extension| extension.sql_name())
            .filter(|name| !embedded_names.contains(name))
            .collect();
        ensure!(
            missing.is_empty(),
            "required WASIX extension archives are unavailable: {}",
            missing.join(", ")
        );
        Ok(embedded)
    }

    fn run_direct_and_restart_smoke_set(extensions: &[Extension]) -> Result<()> {
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_direct_and_restart_smoke(extension) {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension direct/restart smoke failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    fn run_one_direct_and_restart_smoke(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        {
            let mut db = Oliphaunt::builder()
                .extension(extension)
                .open()
                .with_context(|| format!("open temporary database with extension {name}"))?;
            assert_extension_not_installed(&mut db, extension)?;
            run_direct_smoke(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close temporary database with extension {name}"))?;
            record_mode(extension, "direct")?;
        }

        let root = tempfile::TempDir::new()
            .with_context(|| format!("create restart root for extension {name}"))?;
        {
            let mut db = Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
                .extension(extension)
                .open()
                .with_context(|| {
                    format!("open persistent database with extension {name} before restart")
                })?;
            assert_extension_not_installed(&mut db, extension)?;
            run_direct_smoke(&mut db, extension)?;
            assert_extension_catalog_state(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close persistent database with extension {name}"))?;
        }
        {
            let mut db = Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
                .extension(extension)
                .open()
                .with_context(|| {
                    format!("reopen persistent database with extension {name} after restart")
                })?;
            assert_extension_catalog_state(&mut db, extension)?;
            verify_persisted_fixture(&mut db, extension)?;
            verify_backup_restore(&mut db, extension)?;
            db.close()
                .with_context(|| format!("close restarted database with extension {name}"))?;
            record_mode(extension, "restart")?;
        }
        Ok(())
    }

    fn run_lifecycle_materialization_set(extensions: &[Extension]) -> Result<()> {
        let extensions = embedded_extension_archives(extensions)?;
        let mut failures = Vec::new();
        for extension in extensions {
            if let Err(error) = run_one_lifecycle_materialization(extension) {
                failures.push(format!("{}: {error:?}", extension.sql_name()));
            }
        }
        ensure!(
            failures.is_empty(),
            "extension lifecycle/materialization failures:\n{}",
            failures.join("\n\n")
        );
        Ok(())
    }

    fn run_one_lifecycle_materialization(extension: Extension) -> Result<()> {
        let name = extension.sql_name();
        let root = tempfile::TempDir::new()
            .with_context(|| format!("create lifecycle root for extension {name}"))?;
        {
            let mut db = Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(root.path().to_path_buf()))
                .extension(extension)
                .open()
                .with_context(|| format!("open lifecycle database with extension {name}"))?;
            let runtime_root = db
                .runtime_storage()
                .host_path()
                .context("directory database should use a host runtime workspace")?;
            assert_only_resolved_extension_libraries_are_materialized(runtime_root, extension)?;
            db.close()
                .with_context(|| format!("close lifecycle database with extension {name}"))?;
            record_mode(extension, "materialization")?;
        }
        Ok(())
    }

    fn run_direct_smoke(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        ensure!(
            db.exec("SELECT 1 / 0").is_err(),
            "SQL errors must fail direct smoke"
        );
        for statement in extension_activation_sql_for_test(extension)? {
            db.exec(statement).with_context(|| {
                format!(
                    "explicit activation failed for extension {} while running:\n{}",
                    extension.sql_name(),
                    statement
                )
            })?;
        }
        let smoke_sql = extension_smoke_sql(extension.sql_name());
        for statement in extension_smoke_statements(&smoke_sql) {
            db.exec(statement).with_context(|| {
                format!(
                    "direct smoke failed for extension {} while running:\n{}",
                    extension.sql_name(),
                    statement
                )
            })?;
        }
        Ok(())
    }

    fn record_mode(extension: Extension, mode: &str) -> Result<()> {
        if let Some(root) = std::env::var_os("OLIPHAUNT_EXTENSION_EVIDENCE_DIR") {
            std::fs::write(
                Path::new(&root).join(format!("{}.{mode}", extension.sql_name())),
                "passed\n",
            )?;
        }
        Ok(())
    }

    fn verify_persisted_fixture(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        if !generated::creates_database_object_for_test(extension) {
            for statement in extension_activation_sql_for_test(extension)? {
                db.exec(statement).with_context(|| {
                    format!(
                        "reactivate session-local extension {}",
                        extension.sql_name()
                    )
                })?;
            }
        }
        let recipe = extension_smoke_sql(extension.sql_name());
        let verification = recipe
            .split_once("-- oliphaunt-verify")
            .map_or(recipe.as_str(), |(_, verification)| verification);
        for statement in extension_smoke_statements(verification) {
            db.exec(statement).with_context(|| {
                format!(
                    "verify reopened or restored extension {}",
                    extension.sql_name()
                )
            })?;
        }
        Ok(())
    }

    fn verify_backup_restore(source: &mut Oliphaunt, extension: Extension) -> Result<()> {
        source.exec("CREATE TABLE oliphaunt_restore_probe(value text); INSERT INTO oliphaunt_restore_probe VALUES ('retained')")?;
        let backup = source.backup()?;
        let root = tempfile::TempDir::new()?;
        let destination = root.path().join("restored");
        Oliphaunt::restore(&destination, backup)?;
        let mut restored = Oliphaunt::builder()
            .storage(DatabaseStorage::Directory(destination))
            .extension(extension)
            .open()?;
        assert_extension_catalog_state(&mut restored, extension)?;
        verify_persisted_fixture(&mut restored, extension)?;
        ensure!(
            restored
                .query("SELECT value FROM oliphaunt_restore_probe")?
                .get_text(0, "value")?
                == Some("retained")
        );
        restored.close()?;
        record_mode(extension, "backup-restore")
    }

    fn assert_extension_not_installed(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        if !generated::creates_database_object_for_test(extension) {
            return Ok(());
        }
        let result = db.query_with_params(
            "SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = $1",
            [extension.sql_name()],
        )?;
        ensure!(
            result.get_text(0, "count")? == Some("0"),
            "selecting extension {} must not install it in pg_extension",
            extension.sql_name()
        );
        Ok(())
    }

    fn assert_extension_catalog_state(db: &mut Oliphaunt, extension: Extension) -> Result<()> {
        if generated::creates_database_object_for_test(extension) {
            let result = db.query_with_params(
                "SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = $1",
                [extension.sql_name()],
            )?;
            ensure!(
                result.get_text(0, "count")? == Some("1"),
                "extension {} should survive restart in pg_extension",
                extension.sql_name()
            );
        } else {
            let result = db.query("SELECT 1::int4 AS ok")?;
            ensure!(
                result.get_text(0, "ok")? == Some("1"),
                "extension {} should reopen cleanly",
                extension.sql_name()
            );
        }
        Ok(())
    }

    fn assert_only_resolved_extension_libraries_are_materialized(
        runtime_root: &Path,
        extension: Extension,
    ) -> Result<()> {
        let expected = resolve_extension_set(&[extension])?
            .into_iter()
            .flat_map(|extension| {
                let mut modules = extension
                    .native_support_modules()
                    .iter()
                    .map(|module| {
                        PathBuf::from(module.runtime_path())
                            .strip_prefix("lib/postgresql")
                            .map(PathBuf::from)
                            .unwrap_or_else(|_| PathBuf::from(module.runtime_path()))
                    })
                    .collect::<Vec<_>>();
                if let Some(module) = extension.native_module_file() {
                    modules.push(PathBuf::from(module));
                }
                modules
            })
            .collect::<BTreeSet<_>>();
        let actual = relative_files(&runtime_root.join("lib/postgresql"))
            .into_iter()
            .collect::<BTreeSet<_>>();
        ensure!(
            actual == expected,
            "upper runtime library layer for {} should contain only resolved requested libraries; expected {:?}, got {:?}",
            extension.sql_name(),
            expected,
            actual
        );
        Ok(())
    }

    fn relative_files(root: &Path) -> Vec<PathBuf> {
        fn walk(base: &Path, current: &Path, files: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(current) else {
                return;
            };
            for entry in entries {
                let entry = entry.expect("read runtime test directory entry");
                let path = entry.path();
                if path.is_dir() {
                    walk(base, &path, files);
                } else if path.is_file() {
                    files.push(
                        path.strip_prefix(base)
                            .expect("relative extension library path")
                            .to_path_buf(),
                    );
                }
            }
        }

        let mut files = Vec::new();
        walk(root, root, &mut files);
        files.sort();
        files
    }
}

fn legacy_package_files(
    package: &ExtensionPackage,
    sql_name: &str,
) -> Result<BTreeMap<String, Vec<u8>>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let matches: Vec<_> = package
        .archives()
        .iter()
        .filter(|(name, _, _)| *name == sql_name)
        .collect();
    ensure!(
        matches.len() == 1,
        "extension package must contain exactly one archive for {sql_name}"
    );
    let (_, bytes, expected) = matches[0];
    ensure!(
        format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected),
        "extension archive hash mismatch for {sql_name}"
    );
    let mut archive = super::base::extension_archive(bytes)?;
    let mut observed = BTreeSet::new();
    let mut files = BTreeMap::new();
    for entry in archive.entries().context("read legacy extension archive")? {
        let mut entry = entry.context("read legacy extension entry")?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        ensure!(
            entry.header().entry_type().is_file(),
            "legacy extension archive contains a nonregular member"
        );
        let path = entry
            .path()?
            .to_str()
            .context("extension archive path is not UTF-8")?
            .to_owned();
        ensure!(
            !path.starts_with('/')
                && !path.contains('\\')
                && path
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != ".."),
            "unsafe extension archive path {path}"
        );
        ensure!(
            observed.insert(path.clone()),
            "duplicate extension archive member {path}"
        );
        if path.ends_with(".control") || (path.starts_with("lib/") && path.ends_with(".so")) {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            files.insert(path, bytes);
        }
    }
    Ok(files)
}

fn legacy_package_dependencies(package: &ExtensionPackage, sql_name: &str) -> Result<Vec<String>> {
    let files = legacy_package_files(package, sql_name)?;
    let controls: BTreeMap<_, _> = files
        .iter()
        .filter_map(|(path, bytes)| {
            path.strip_prefix("share/postgresql/extension/")?
                .strip_suffix(".control")
                .map(|name| (name, bytes))
        })
        .collect();
    let mut dependencies = BTreeSet::new();
    for (name, bytes) in &controls {
        let text = std::str::from_utf8(bytes).context("extension control is not UTF-8")?;
        let mut declared = false;
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                ensure!(
                    line.split_whitespace().next() != Some("requires"),
                    "invalid requires assignment in {name}.control"
                );
                continue;
            };
            if key.trim() != "requires" {
                continue;
            }
            ensure!(!declared, "duplicate requires assignment in {name}.control");
            declared = true;
            let value = value.trim_start();
            let value = if let Some(quoted) = value.strip_prefix('\'') {
                let (value, remainder) = quoted
                    .split_once('\'')
                    .context("unterminated control requires")?;
                ensure!(
                    remainder.trim().is_empty() || remainder.trim().starts_with('#'),
                    "invalid control requires suffix"
                );
                value
            } else {
                let value = value.split('#').next().unwrap_or_default().trim();
                ensure!(!value.is_empty(), "empty unquoted control requires");
                value
            };
            if value.trim().is_empty() {
                continue;
            }
            let mut seen = BTreeSet::new();
            for dependency in value.split(',').map(str::trim) {
                ensure!(
                    !dependency.is_empty()
                        && dependency.bytes().all(|byte| byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || byte == b'_'
                            || byte == b'-')
                        && seen.insert(dependency),
                    "invalid control dependency {dependency}"
                );
                if !controls.contains_key(dependency) && dependency != "plpgsql" {
                    dependencies.insert(dependency.to_owned());
                }
            }
        }
    }
    Ok(dependencies.into_iter().collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct FrozenExtensionInstall {
    dependencies: &'static [&'static str],
    native_modules: &'static [(&'static str, &'static str)],
    startup_config: &'static [&'static str],
}

/// A flat, package-owned dependency resource snapshot used by generated facades.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExtensionPackageDependency {
    sql_name: &'static str,
    package: ExtensionPackage,
}

/// Immutable resources owned by an independently released WASIX package.
///
/// Applications use the descriptor exported by their extension crate.
#[derive(Debug, Clone, Copy)]
pub struct ExtensionPackage {
    product: &'static str,
    version: &'static str,
    runtime_version: &'static str,
    archives: &'static [(&'static str, &'static [u8], &'static str)],
    aot_manifest: &'static str,
    aot_artifacts: &'static [(&'static str, &'static [u8])],
    install: Option<FrozenExtensionInstall>,
    dependencies: &'static [ExtensionPackageDependency],
}

type ExtensionPackageIdentity = (
    &'static str,
    &'static str,
    &'static str,
    &'static [(&'static str, &'static [u8], &'static str)],
    &'static str,
    &'static [(&'static str, &'static [u8])],
    Option<FrozenExtensionInstall>,
);

impl PartialEq for ExtensionPackage {
    fn eq(&self, other: &Self) -> bool {
        self.identity() == other.identity()
    }
}
impl Eq for ExtensionPackage {}
impl PartialOrd for ExtensionPackage {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ExtensionPackage {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.identity().cmp(&other.identity())
    }
}
impl std::hash::Hash for ExtensionPackage {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::hash::Hash::hash(&self.identity(), state);
    }
}

impl ExtensionPackage {
    // Dependency bindings are request composition; the immutable resource identity stays finite.
    fn identity(&self) -> ExtensionPackageIdentity {
        (
            self.product,
            self.version,
            self.runtime_version,
            self.archives,
            self.aot_manifest,
            self.aot_artifacts,
            self.install,
        )
    }

    /// Bind the requirements captured by the original package's install contract.
    #[doc(hidden)]
    pub const fn with_install(
        mut self,
        dependencies: &'static [&'static str],
        native_modules: &'static [(&'static str, &'static str)],
        startup_config: &'static [&'static str],
    ) -> Self {
        self.install = Some(FrozenExtensionInstall {
            dependencies,
            native_modules,
            startup_config,
        });
        self
    }

    /// Bind the complete, flat dependency closure without changing any resource owner.
    #[doc(hidden)]
    pub const fn with_dependencies(
        mut self,
        dependencies: &'static [ExtensionPackageDependency],
    ) -> Self {
        self.dependencies = dependencies;
        self
    }

    /// Capture one dependency without nesting package graphs or recursive identities.
    #[doc(hidden)]
    pub const fn as_dependency(mut self, sql_name: &'static str) -> ExtensionPackageDependency {
        self.dependencies = &[];
        ExtensionPackageDependency {
            sql_name,
            package: self,
        }
    }

    /// Package-owned product.
    pub const fn product(self) -> &'static str {
        self.product
    }
    /// Package-owned version.
    pub const fn version(self) -> &'static str {
        self.version
    }
    /// Package-owned runtime version.
    pub const fn runtime_version(self) -> &'static str {
        self.runtime_version
    }
    /// Package-owned archives.
    pub const fn archives(self) -> &'static [(&'static str, &'static [u8], &'static str)] {
        self.archives
    }
    /// Package-owned aot manifest.
    pub const fn aot_manifest(self) -> &'static str {
        self.aot_manifest
    }
    /// Package-owned aot artifacts.
    pub const fn aot_artifacts(self) -> &'static [(&'static str, &'static [u8])] {
        self.aot_artifacts
    }

    /// Construct a descriptor in a generated extension package.
    ///
    /// # Safety
    /// Every AOT artifact must have been produced by the trusted Oliphaunt build
    /// for the declared engine and target. The manifest and archive identities
    /// must belong to that same release. A caller-provided hash alone does not
    /// establish this trust: arbitrary serialized native code is not safe input.
    #[doc(hidden)]
    #[allow(unsafe_code)]
    pub const unsafe fn from_trusted_release(
        product: &'static str,
        version: &'static str,
        runtime_version: &'static str,
        archives: &'static [(&'static str, &'static [u8], &'static str)],
        aot_manifest: &'static str,
        aot_artifacts: &'static [(&'static str, &'static [u8])],
    ) -> Self {
        Self {
            product,
            version,
            runtime_version,
            archives,
            aot_manifest,
            aot_artifacts,
            install: None,
            dependencies: &[],
        }
    }
}

#[cfg(all(test, feature = "extensions"))]
#[allow(unsafe_code)]
mod package_requirement_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn resources(product: &'static str, runtime: &'static str) -> ExtensionPackage {
        // Inert resources exercise descriptor selection and never deserialize native code.
        unsafe { ExtensionPackage::from_trusted_release(product, "1.2.3", runtime, &[], "", &[]) }
    }

    #[test]
    fn legacy_controls_accept_postgresql_requires_syntax_and_reject_malformed_assignments() {
        let read = |controls: &[(&str, &str)]| {
            let mut archive = tar::Builder::new(Vec::new());
            for (name, text) in controls {
                let mut header = tar::Header::new_gnu();
                header.set_size(text.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive
                    .append_data(
                        &mut header,
                        format!("share/postgresql/extension/{name}.control"),
                        text.as_bytes(),
                    )
                    .unwrap();
            }
            let bytes = Box::leak(archive.into_inner().unwrap().into_boxed_slice());
            let hash = Box::leak(format!("{:x}", Sha256::digest(&*bytes)).into_boxed_str());
            let package = ExtensionPackage {
                archives: Box::leak(vec![("postgis", &*bytes, &*hash)].into_boxed_slice()),
                ..resources("oliphaunt-extension-postgis", "1.2.3")
            };
            legacy_package_dependencies(&package, "postgis")
        };
        // The packaged raster/topology controls use bare identifiers; tiger uses a quoted list.
        assert_eq!(
            read(&[
                ("postgis", "default_version = '3.6.4'\n"),
                ("postgis_raster", "requires = postgis\n"),
                ("postgis_topology", "requires = postgis # owned member\n"),
                (
                    "postgis_tiger_geocoder",
                    "requires = 'postgis,fuzzystrmatch' # external member\n",
                ),
            ])
            .unwrap(),
            ["fuzzystrmatch"]
        );
        for text in [
            "requires = fuzzystrmatch # bare identifier\n",
            "requires = 'fuzzystrmatch,plpgsql' # quoted list\n",
        ] {
            assert_eq!(read(&[("postgis", text)]).unwrap(), ["fuzzystrmatch"]);
        }
        assert!(
            read(&[("postgis", "requires = '' # no dependencies\n")])
                .unwrap()
                .is_empty()
        );
        for text in [
            "requires\n",
            "requires =\n",
            "requires = # comment\n",
            "requires = 'cube\n",
            "requires = cube trailing\n",
            "requires = 'cube' trailing\n",
            "requires = 'cube,,hstore'\n",
            "requires = 'cube,cube'\n",
            "requires = 'cube'\nrequires = 'hstore'\n",
        ] {
            assert!(read(&[("postgis", text)]).is_err(), "{text}");
        }
    }

    #[test]
    fn captured_postgis_requirements_override_new_sdk_modules_dependencies_and_startup() {
        let package = Box::leak(Box::new(
            resources(
                "oliphaunt-extension-postgis",
                liboliphaunt_wasix_portable::PACKAGE_VERSION,
            )
            .with_install(
                &[],
                &[("lib/postgresql/postgis-3.so", "extension:postgis")],
                &["search_path=public"],
            ),
        ));
        let extension = Extension::POSTGIS.with_package(package);
        assert_eq!(resolve_extension_set(&[extension]).unwrap(), [extension]);
        assert_eq!(
            extension.required_native_modules().unwrap(),
            [(
                "lib/postgresql/postgis-3.so".to_owned(),
                Some("extension:postgis".to_owned())
            )]
        );
        assert_eq!(extension.startup_config(), ["search_path=public"]);
        assert_eq!(Extension::POSTGIS.dependencies(), &["fuzzystrmatch"]);
    }

    #[test]
    fn foreign_packages_keep_their_owner_and_reject_conflicts_cycles_and_transitive_host_mismatch()
    {
        let host = liboliphaunt_wasix_portable::PACKAGE_VERSION;
        let foreign =
            resources("oliphaunt-extension-contrib-pg18", host).with_install(&[], &[], &[]);
        let dependencies =
            Box::leak(vec![foreign.as_dependency("fuzzystrmatch")].into_boxed_slice());
        let package = Box::leak(Box::new(
            resources("oliphaunt-extension-postgis", host)
                .with_install(&["fuzzystrmatch", "plpgsql"], &[], &[])
                .with_dependencies(dependencies),
        ));
        let extension = Extension::POSTGIS.with_package(package);
        let resolved = resolve_extension_set(&[extension]).unwrap();
        assert_eq!(
            resolved
                .iter()
                .map(|extension| extension.sql_name())
                .collect::<Vec<_>>(),
            ["fuzzystrmatch", "postgis"]
        );
        assert_eq!(
            resolved[0].package().unwrap().product(),
            "oliphaunt-extension-contrib-pg18"
        );
        let conflicting = Box::leak(Box::new(resources("another-owner", host).with_install(
            &[],
            &[],
            &[],
        )));
        assert!(
            resolve_extension_set(&[
                extension,
                Extension::FUZZYSTRMATCH.with_package(conflicting)
            ])
            .unwrap_err()
            .to_string()
            .contains("conflicting packages")
        );
        let duplicate_candidates = Box::leak(
            vec![
                foreign.as_dependency("fuzzystrmatch"),
                conflicting.as_dependency("fuzzystrmatch"),
            ]
            .into_boxed_slice(),
        );
        let duplicate_root =
            Box::leak(Box::new((*package).with_dependencies(duplicate_candidates)));
        assert!(
            resolve_extension_set(&[Extension::POSTGIS.with_package(duplicate_root)])
                .unwrap_err()
                .to_string()
                .contains("conflicting packages selected for extension 'fuzzystrmatch'")
        );
        let incompatible =
            resources("oliphaunt-extension-contrib-pg18", "999.0.0").with_install(&[], &[], &[]);
        let incompatible_dependencies =
            Box::leak(vec![incompatible.as_dependency("fuzzystrmatch")].into_boxed_slice());
        let incompatible_root = Box::leak(Box::new(
            (*package).with_dependencies(incompatible_dependencies),
        ));
        assert!(
            resolve_extension_set(&[Extension::POSTGIS.with_package(incompatible_root)])
                .unwrap_err()
                .to_string()
                .contains("requires WASIX runtime")
        );
        let cyclic = resources("oliphaunt-extension-contrib-pg18", host).with_install(
            &["postgis"],
            &[],
            &[],
        );
        let cyclic_dependencies =
            Box::leak(vec![cyclic.as_dependency("fuzzystrmatch")].into_boxed_slice());
        let cyclic_root = Box::leak(Box::new((*package).with_dependencies(cyclic_dependencies)));
        assert!(
            resolve_extension_set(&[Extension::POSTGIS.with_package(cyclic_root)])
                .unwrap_err()
                .to_string()
                .contains("cyclic extension dependency")
        );
        let nested = foreign.with_install(&["cube"], &[], &[]);
        let first_cube = resources("original-cube-owner", host).with_install(&[], &[], &[]);
        let second_cube = resources("different-cube-owner", host).with_install(&[], &[], &[]);
        let first_context = Box::leak(
            vec![
                nested.as_dependency("fuzzystrmatch"),
                first_cube.as_dependency("cube"),
            ]
            .into_boxed_slice(),
        );
        let second_context = Box::leak(
            vec![
                nested.as_dependency("fuzzystrmatch"),
                second_cube.as_dependency("cube"),
            ]
            .into_boxed_slice(),
        );
        let first_root = Box::leak(Box::new((*package).with_dependencies(first_context)));
        let second_root = Box::leak(Box::new((*package).with_dependencies(second_context)));
        assert_eq!(*first_root, *second_root);
        assert!(
            resolve_extension_set(&[
                Extension::POSTGIS.with_package(first_root),
                Extension::POSTGIS.with_package(second_root),
            ])
            .unwrap_err()
            .to_string()
            .contains("conflicting packages selected for extension 'cube'")
        );
        assert_eq!(*package, package.as_dependency("postgis").package);
    }

    #[test]
    fn legacy_postgis_uses_original_control_and_archive_modules_and_preserves_sdk_startup_policy() {
        let module = b"inert original postgis wasm";
        let mut archive = tar::Builder::new(Vec::new());
        for (path, bytes) in [
            (
                "share/postgresql/extension/postgis.control",
                &b"default_version = '3.5.0'\n"[..],
            ),
            ("lib/postgresql/postgis-3.so", &module[..]),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, path, bytes).unwrap();
        }
        let bytes: &'static [u8] = Box::leak(archive.into_inner().unwrap().into_boxed_slice());
        let hash = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        let archives = Box::leak(vec![("postgis", bytes, &*hash)].into_boxed_slice());
        let target = if cfg!(target_os = "windows") {
            "x86_64-pc-windows-msvc"
        } else if cfg!(target_os = "macos") {
            "aarch64-apple-darwin"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64-unknown-linux-gnu"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        let postgres = crate::oliphaunt::assets::asset_manifest_metadata()
            .unwrap()
            .postgres_version;
        let manifest = Box::leak(serde_json::json!({"format-version": 1, "postgres-version": postgres, "target-triple": target, "engine": super::super::aot::EXPECTED_AOT_ENGINE, "wasmer-version": super::super::aot::EXPECTED_WASMER_VERSION, "wasmer-wasix-version": super::super::aot::EXPECTED_WASMER_WASIX_VERSION, "artifacts": [{"name": "extension:postgis", "sha256": "a".repeat(64), "module-sha256": format!("{:x}", Sha256::digest(module))}]}).to_string().into_boxed_str());
        let package = Box::leak(Box::new(unsafe {
            ExtensionPackage::from_trusted_release(
                "oliphaunt-extension-postgis",
                "3.5.0",
                liboliphaunt_wasix_portable::PACKAGE_VERSION,
                archives,
                manifest,
                &[],
            )
        }));
        let extension = Extension::POSTGIS.with_package(package);
        assert_eq!(resolve_extension_set(&[extension]).unwrap(), [extension]);
        let unused_dependencies = Box::leak(
            vec![
                resources(
                    "original-unused-contrib",
                    liboliphaunt_wasix_portable::PACKAGE_VERSION,
                )
                .with_install(&[], &[], &[])
                .as_dependency("fuzzystrmatch"),
                resources("conflicting-unused-contrib", "999.0.0")
                    .with_install(&[], &[], &[])
                    .as_dependency("fuzzystrmatch"),
            ]
            .into_boxed_slice(),
        );
        let with_unused = Box::leak(Box::new((*package).with_dependencies(unused_dependencies)));
        let old_extension = Extension::POSTGIS.with_package(with_unused);
        assert_eq!(
            resolve_extension_set(&[old_extension]).unwrap(),
            [old_extension]
        );
        assert_eq!(
            extension.required_native_modules().unwrap(),
            [(
                "lib/postgresql/postgis-3.so".to_owned(),
                Some("extension:postgis".to_owned())
            )]
        );
        assert_eq!(
            Extension::PG_TEXTSEARCH
                .with_package(package)
                .startup_config(),
            Extension::PG_TEXTSEARCH.startup_config()
        );
    }
}
