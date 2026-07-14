use std::collections::BTreeSet;

use crate::error::{Error, Result};

#[path = "generated/extensions.rs"]
mod generated_extensions;
pub use generated_extensions::Extension;

impl Extension {
    /// First-party PostgreSQL 18 extensions distributed by the native release lane.
    pub const FIRST_PARTY_PG18_SUPPORTED: &'static [Self] =
        generated_extensions::FIRST_PARTY_PG18_SUPPORTED;

    /// PostgreSQL 18 extensions that public release packaging may ship as
    /// exact prebuilt app-bundle assets today.
    pub const RELEASE_READY_PG18_SUPPORTED: &'static [Self] =
        generated_extensions::RELEASE_READY_PG18_SUPPORTED;

    /// PostgreSQL 18 extensions that have release-ready mobile artifacts today.
    ///
    /// SQL-only extensions do not need a mobile static registry. Native-module
    /// extensions appear here only after the iOS and Android release builds can
    /// link their prebuilt static objects without application developers
    /// compiling extension source.
    pub const MOBILE_RELEASE_READY_PG18_SUPPORTED: &'static [Self] =
        generated_extensions::MOBILE_RELEASE_READY_PG18_SUPPORTED;

    /// Externally sourced PostgreSQL 18 extensions known to the native lane.
    pub const EXTERNAL_PG18_SUPPORTED: &'static [Self] =
        generated_extensions::EXTERNAL_PG18_SUPPORTED;

    /// All PostgreSQL 18 extensions known to the native lane.
    pub const ALL_PG18_SUPPORTED: &'static [Self] = generated_extensions::ALL_PG18_SUPPORTED;

    /// SQL extension name used by `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        generated_extensions::sql_name(self)
    }

    /// Native module stem before the platform dynamic-library suffix.
    pub const fn native_module_stem(self) -> Option<&'static str> {
        generated_extensions::native_module_stem(self)
    }

    /// Native module filename expected under `lib/postgresql`.
    pub fn native_module_file(self) -> Option<String> {
        self.native_module_stem()
            .map(|stem| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    /// Whether this extension has a `CREATE EXTENSION` control file.
    pub const fn creates_extension(self) -> bool {
        generated_extensions::creates_extension(self)
    }

    /// SQL extension dependencies that must be materialized with this extension.
    pub const fn dependencies(self) -> &'static [Extension] {
        generated_extensions::dependencies(self)
    }

    /// Packaging policy for this extension.
    pub const fn artifact_policy(self) -> ExtensionArtifactPolicy {
        generated_extensions::artifact_policy(self)
    }

    /// Whether the native release build currently owns first-party artifacts
    /// for this extension.
    pub const fn first_party_artifact(self) -> bool {
        matches!(self.artifact_policy(), ExtensionArtifactPolicy::FirstParty)
    }

    /// Whether desktop release artifacts may include this extension today.
    pub const fn desktop_release_ready(self) -> bool {
        generated_extensions::desktop_release_ready(self)
    }

    /// Whether iOS and Android release artifacts may include this extension
    /// without app developers building extension source.
    pub const fn mobile_release_ready(self) -> bool {
        generated_extensions::mobile_release_ready(self)
    }

    /// Whether this extension needs a mobile static-registry row when selected
    /// for iOS or Android.
    pub const fn requires_mobile_static_registry(self) -> bool {
        self.native_module_stem().is_some()
    }

    /// Shared-preload library that must be present when this extension is
    /// selected.
    pub const fn required_shared_preload_library(self) -> Option<&'static str> {
        generated_extensions::required_shared_preload_library(self)
    }

    /// Resolve an extension by SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL_PG18_SUPPORTED
            .iter()
            .copied()
            .find(|extension| extension.sql_name() == sql_name)
    }

    /// Resolve a public release-ready extension by exact SQL name.
    ///
    /// This intentionally does not accept catalog labels, aliases, or grouped
    /// selectors. App artifacts are selected one extension at a time so
    /// unrequested extensions cannot be shipped accidentally.
    pub fn by_release_ready_sql_name(sql_name: &str) -> Option<Self> {
        let extension = Self::by_sql_name(sql_name)?;
        extension.desktop_release_ready().then_some(extension)
    }

    /// Static release manifest row for this extension.
    pub const fn manifest_entry(self) -> ExtensionManifestEntry {
        let module = match self.native_module_stem() {
            Some(stem) => ExtensionModuleAsset::NativeModule { stem },
            None => ExtensionModuleAsset::SqlOnly,
        };
        let sql_assets = if self.creates_extension() {
            ExtensionSqlAsset::ControlAndSql
        } else {
            ExtensionSqlAsset::LoadableModuleOnly
        };
        let smoke = if self.creates_extension() {
            ExtensionSmokePlan::CreateExtensionCascade
        } else {
            ExtensionSmokePlan::LoadSharedLibrary
        };
        let mobile_static_link = match module {
            ExtensionModuleAsset::NativeModule { .. } => MobileStaticLinkStatus::PendingRegistry,
            ExtensionModuleAsset::SqlOnly => MobileStaticLinkStatus::NotRequiredSqlOnly,
        };
        ExtensionManifestEntry {
            extension: self,
            sql_name: self.sql_name(),
            pg_major: 18,
            pg18_supported: true,
            creates_extension: self.creates_extension(),
            sql_assets,
            module,
            dependencies: self.dependencies(),
            data_files: extension_data_files(self),
            smoke,
            coverage: ExtensionCoverage::GATED_RELEASE_MATRIX,
            mobile_static_link,
            artifact_policy: self.artifact_policy(),
        }
    }
}

/// How an extension's source is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionSourceKind {
    /// PostgreSQL contrib or PGXS-style Makefile extension.
    Pgxs,
    /// Rust extension built with pgrx.
    Pgrx,
}

/// Binary redistribution policy for a known extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionRedistribution {
    /// The extension license permits first-party binary redistribution.
    Allowed,
    /// Binary redistribution needs a separate commercial or enterprise license.
    RequiresCommercialLicense,
}

/// Packaging policy for a known PostgreSQL 18 extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionArtifactPolicy {
    /// First-party release-lane extension built and tested by oliphaunt.
    FirstParty,
    /// Known external extension that requires explicit assets and release gates.
    External {
        /// Upstream source URL.
        upstream: &'static str,
        /// Upstream license summary.
        license: &'static str,
        /// Source/build kind.
        source_kind: ExtensionSourceKind,
        /// Binary redistribution policy.
        redistribution: ExtensionRedistribution,
        /// Whether the extension must be loaded through shared_preload_libraries.
        requires_shared_preload: bool,
        /// Short release-note detail for this extension.
        notes: &'static str,
    },
}

/// Runtime environment variable required by selected extension data files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExtensionRuntimeEnvironment {
    /// Environment variable name.
    pub name: &'static str,
    /// Directory path relative to the materialized runtime root.
    pub relative_path: &'static str,
    /// File that must exist under `relative_path` before the variable is set.
    pub required_file: &'static str,
}

impl ExtensionArtifactPolicy {
    /// Whether this extension is owned by the current first-party release lane.
    pub const fn is_first_party(self) -> bool {
        matches!(self, Self::FirstParty)
    }

    /// Whether binary redistribution needs separate license approval.
    pub const fn requires_commercial_license(self) -> bool {
        matches!(
            self,
            Self::External {
                redistribution: ExtensionRedistribution::RequiresCommercialLicense,
                ..
            }
        )
    }
}

/// PostgreSQL extension SQL asset class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionSqlAsset {
    /// Extension provides a `.control` file plus install/upgrade SQL files.
    ControlAndSql,
    /// Extension is loaded as a shared library and does not use `CREATE EXTENSION`.
    LoadableModuleOnly,
}

/// Native module asset required by an extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionModuleAsset {
    /// Extension is SQL-only and does not require a native module file.
    SqlOnly,
    /// Extension requires a native module with the given platform-independent stem.
    NativeModule {
        /// Module filename stem before the platform dynamic-library suffix.
        stem: &'static str,
    },
}

impl ExtensionModuleAsset {
    /// Platform-specific native module filename, if this extension needs one.
    pub fn module_file_name(self) -> Option<String> {
        match self {
            Self::SqlOnly => None,
            Self::NativeModule { stem } => {
                Some(format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
            }
        }
    }
}

/// Smoke SQL strategy for proving an extension is usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionSmokePlan {
    /// Run `CREATE EXTENSION <name> CASCADE`.
    CreateExtensionCascade,
    /// Run `LOAD '<name>'`.
    LoadSharedLibrary,
}

impl ExtensionSmokePlan {
    /// Render the SQL used by the native extension smoke matrix.
    pub fn sql(self, sql_name: &str) -> String {
        match self {
            Self::CreateExtensionCascade => {
                format!(
                    "CREATE EXTENSION {} CASCADE",
                    quote_sql_identifier(sql_name)
                )
            }
            Self::LoadSharedLibrary => format!("LOAD '{sql_name}'"),
        }
    }
}

fn quote_sql_identifier(identifier: &str) -> String {
    let mut chars = identifier.chars();
    let bare = matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase() || ch == '_')
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if bare {
        identifier.to_owned()
    } else {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }
}

/// Mobile static-link status for an extension module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MobileStaticLinkStatus {
    /// No native module exists, so mobile static linking is not required.
    NotRequiredSqlOnly,
    /// The extension's native module is present in the mobile static registry.
    RegisteredStaticRegistry,
    /// A mobile static registry entry is required before mobile release.
    PendingRegistry,
}

/// Regression evidence represented by the extension manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExtensionCoverage {
    /// Direct C ABI coverage exists through the broker helper's embedded backend.
    pub direct_c_abi: ExtensionSmokeCoverage,
    /// Broker mode coverage.
    pub broker: ExtensionSmokeCoverage,
    /// Server mode coverage.
    pub server: ExtensionSmokeCoverage,
}

impl ExtensionCoverage {
    /// Coverage provided by `tests/native_extensions.rs` when the gated native
    /// extension matrix is enabled.
    pub const GATED_RELEASE_MATRIX: Self = Self {
        direct_c_abi: ExtensionSmokeCoverage::InstallLoadRestartBackupRestore,
        broker: ExtensionSmokeCoverage::InstallLoadRestartBackupRestore,
        server: ExtensionSmokeCoverage::InstallLoadRestartBackupRestore,
    };
}

/// Per-mode extension smoke coverage level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionSmokeCoverage {
    /// Install/load, reopen, physical backup, restore, and restored reopen pass.
    InstallLoadRestartBackupRestore,
}

/// Static native extension release-manifest row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExtensionManifestEntry {
    /// Extension enum value.
    pub extension: Extension,
    /// SQL name used by PostgreSQL.
    pub sql_name: &'static str,
    /// PostgreSQL major version this manifest row targets.
    pub pg_major: u16,
    /// Whether this extension is supported in the PostgreSQL 18 native lane.
    pub pg18_supported: bool,
    /// Whether this extension is installed with `CREATE EXTENSION`.
    pub creates_extension: bool,
    /// SQL/control asset class.
    pub sql_assets: ExtensionSqlAsset,
    /// Native module asset requirement.
    pub module: ExtensionModuleAsset,
    /// SQL extension dependencies that must be materialized with this extension.
    pub dependencies: &'static [Extension],
    /// Transitive runtime data files required by this extension.
    pub data_files: &'static [&'static str],
    /// Smoke SQL strategy.
    pub smoke: ExtensionSmokePlan,
    /// Regression coverage evidence expected for this release lane.
    pub coverage: ExtensionCoverage,
    /// Mobile static-link readiness.
    pub mobile_static_link: MobileStaticLinkStatus,
    /// First-party or external packaging policy.
    pub artifact_policy: ExtensionArtifactPolicy,
}

impl ExtensionManifestEntry {
    /// Render the smoke SQL for this extension.
    pub fn smoke_sql(self) -> String {
        self.smoke.sql(self.sql_name)
    }

    /// Platform-specific native module filename, if any.
    pub fn module_file_name(self) -> Option<String> {
        self.module.module_file_name()
    }

    /// Whether the native release build currently owns first-party artifacts
    /// and gated smoke coverage for this extension.
    pub const fn first_party_artifact(self) -> bool {
        self.artifact_policy.is_first_party()
    }
}

/// Static manifest for every PostgreSQL 18 extension supported by the native lane.
pub const NATIVE_EXTENSION_MANIFEST: &[ExtensionManifestEntry] =
    generated_extensions::NATIVE_EXTENSION_MANIFEST;

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

/// Sorted, deduplicated `shared_preload_libraries` entries required by a
/// resolved extension selection.
pub fn required_shared_preload_libraries(extensions: &[Extension]) -> Vec<&'static str> {
    extensions
        .iter()
        .filter_map(|extension| extension.required_shared_preload_library())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Resolve explicit extension selections into the concrete extension set that
/// must be present in a native runtime resources.
pub fn resolve_extension_selection(extensions: &[Extension]) -> Result<Vec<Extension>> {
    resolve_extensions(extensions)
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
        || (file_name.starts_with(&format!("{sql_name}--")) && file_name.ends_with(".sql"))
        || extension_extra_sql_file_belongs(sql_name, file_name)
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
