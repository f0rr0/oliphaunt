use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use liboliphaunt_native_bindings::Extension;
use liboliphaunt_native_bindings::{
    NativePackagingCatalogProfile, NativePackagingResources as MaterializedNativeResources,
    materialize_native_packaging_resources,
};

/// Error returned by native packaging tooling.
///
/// Packaging validation and filesystem failures are intentionally owned by
/// this unpublished tooling crate. Native binding failures retain their source.
#[derive(Debug)]
pub enum Error {
    /// A packaging option, manifest, artifact, or command-line value is invalid.
    InvalidConfig(String),
    /// A packaging filesystem, archive, or subprocess operation failed.
    Engine(String),
    /// Native bindings failed while materializing runtime resources.
    Oliphaunt(liboliphaunt_native_bindings::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) | Self::Engine(message) => formatter.write_str(message),
            Self::Oliphaunt(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Oliphaunt(error) => Some(error),
            Self::InvalidConfig(_) | Self::Engine(_) => None,
        }
    }
}

impl From<liboliphaunt_native_bindings::Error> for Error {
    fn from(error: liboliphaunt_native_bindings::Error) -> Self {
        Self::Oliphaunt(error)
    }
}

/// Result returned by native packaging tooling.
pub type Result<T> = std::result::Result<T, Error>;

mod catalog;
mod extension_artifact;
mod manifest;
mod package;
mod static_registry;

use extension_artifact::*;
use manifest::*;
use package::*;
use static_registry::*;

const RUNTIME_RESOURCES_SCHEMA: &str = "oliphaunt-runtime-resources-v1";
const EXTENSION_ARTIFACT_LAYOUT: &str = "oliphaunt-extension-artifact-v1";
const EXTENSION_ARTIFACT_NATIVE_RUNTIME_PRODUCT: &str = "liboliphaunt-native";
const EXTENSION_ARTIFACT_MANIFEST_KEYS: [&str; 22] = [
    "packageLayout",
    "pgMajor",
    "sqlName",
    "createsExtension",
    "nativeModuleStem",
    "nativeModuleFile",
    "nativeTarget",
    "nativeRuntimeProduct",
    "nativeRuntimeVersion",
    "dependencies",
    "dataFiles",
    "extensionSqlFileNames",
    "extensionSqlFilePrefixes",
    "sharedPreloadLibraries",
    "mobilePrebuilt",
    "mobileStaticArchives",
    "mobileStaticDependencyArchives",
    "staticSymbolPrefix",
    "staticSymbolAliases",
    "licenseFiles",
    "licenseProfile",
    "files",
];
const RUNTIME_FILES_LAYOUT: &str = "postgres-runtime-files-v1";
const STATIC_REGISTRY_PACKAGE_LAYOUT: &str = "oliphaunt-static-registry-v1";
const STATIC_REGISTRY_SOURCE_FILE: &str = "oliphaunt_static_registry.c";
const STATIC_REGISTRY_SOURCE_MANIFEST_VALUE: &str = "static-registry/oliphaunt_static_registry.c";
// Resource-relative directory under the runtime path `static-registry/archives`.
const STATIC_REGISTRY_ARCHIVES_DIR: &str = "archives";

fn extension_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    file_name == format!("{sql_name}.control")
        || file_name == format!("{sql_name}.sql")
        || extension_install_sql_file_belongs(sql_name, file_name)
        || extension_versioned_sql_file_belongs(sql_name, file_name)
        || catalog::by_sql_name(sql_name).is_some_and(|extension| {
            extension
                .extension_sql_file_names
                .iter()
                .any(|name| name == file_name)
                || (file_name.ends_with(".sql")
                    && extension
                        .extension_sql_file_prefixes
                        .iter()
                        .any(|prefix| file_name.starts_with(prefix)))
        })
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

fn extension_install_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
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

/// Options for building platform SDK runtime resources.
#[derive(Debug, Clone)]
pub struct NativeRuntimeResourceOptions {
    /// Directory that receives the generated `oliphaunt/...` resource tree.
    pub output_dir: PathBuf,
    /// Exact PostgreSQL extensions made available by these runtime resources.
    pub extensions: Vec<Extension>,
    /// Optional runtime data/features made available by these resources.
    pub runtime_features: Vec<NativeRuntimeFeature>,
    /// Replace an existing `liboliphaunt` resource tree under `output_dir`.
    pub replace_existing: bool,
    /// Fail packaging when selected native-module extensions do not have a
    /// mobile static-registry entry.
    pub require_mobile_static_registry: bool,
    /// Native module stems that the platform build has registered for static
    /// mobile loading.
    pub mobile_static_module_stems: Vec<String>,
    /// Exact third-party extension artifacts that are already built for the
    /// target PostgreSQL runtime.
    pub prebuilt_extensions: Vec<NativePrebuiltExtensionArtifact>,
    /// Exact stable `liboliphaunt-native` version selected by the package.
    ///
    /// This is required whenever `prebuilt_extensions` is non-empty. Every
    /// artifact must declare the same version in `nativeRuntimeVersion`.
    pub native_runtime_version: Option<String>,
    /// Public artifact target the runtime resources are being packaged for.
    ///
    /// This is required for every prebuilt artifact that declares a native
    /// module, including iOS and Android artifacts whose modules are linked
    /// through `mobile-static` archives instead of copied as dynamic modules.
    pub extension_target: Option<String>,
}

impl NativeRuntimeResourceOptions {
    /// Create options for native-direct runtime resources.
    pub fn new(output_dir: impl Into<PathBuf>) -> Self {
        Self {
            output_dir: output_dir.into(),
            extensions: Vec::new(),
            runtime_features: Vec::new(),
            replace_existing: false,
            require_mobile_static_registry: false,
            mobile_static_module_stems: Vec::new(),
            prebuilt_extensions: Vec::new(),
            native_runtime_version: None,
            extension_target: None,
        }
    }

    /// Add one exact PostgreSQL extension to the runtime resources.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Add optional runtime features to the resource bundle.
    pub fn runtime_features(
        mut self,
        features: impl IntoIterator<Item = NativeRuntimeFeature>,
    ) -> Self {
        self.runtime_features.extend(features);
        self
    }

    /// Allow replacement of an existing generated `liboliphaunt` resource tree.
    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }

    /// Require every selected native-module extension to be mobile static-ready.
    pub fn require_mobile_static_registry(mut self, required: bool) -> Self {
        self.require_mobile_static_registry = required;
        self
    }

    /// Declare native module stems as present in the platform static registry.
    pub fn mobile_static_module_stems(mut self, stems: Vec<String>) -> Self {
        self.mobile_static_module_stems.extend(stems);
        self
    }

    /// Add one exact prebuilt extension artifact directory.
    pub fn prebuilt_extension(mut self, root: impl Into<PathBuf>) -> Self {
        self.prebuilt_extensions
            .push(NativePrebuiltExtensionArtifact::new(root));
        self
    }

    /// Select the exact stable `liboliphaunt-native` version for prebuilt
    /// extension compatibility checks.
    pub fn native_runtime_version(mut self, version: impl Into<String>) -> Self {
        self.native_runtime_version = Some(version.into());
        self
    }

    /// Set the public artifact target these runtime resources are packaged for.
    pub fn extension_target(mut self, target: impl Into<String>) -> Self {
        self.extension_target = Some(target.into());
        self
    }
}

/// Optional runtime data/features selected independently from PostgreSQL
/// extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NativeRuntimeFeature {
    /// ICU locale/collation data under `share/icu`.
    Icu,
}

impl NativeRuntimeFeature {
    /// Stable manifest/CLI spelling for this runtime feature.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Icu => "icu",
        }
    }
}

/// One exact third-party extension artifact that has already been built.
///
/// The artifact may be an unpacked directory, `.tar`, `.tar.gz` (or `.tgz`),
/// or `.tar.zst`. Its root must contain `manifest.properties` with
/// `packageLayout=oliphaunt-extension-artifact-v1` and a `files/` tree whose
/// paths mirror PostgreSQL runtime paths, such as
/// `files/share/postgresql/extension/<name>.control`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePrebuiltExtensionArtifact {
    /// Artifact root directory or archive file.
    pub root: PathBuf,
}

impl NativePrebuiltExtensionArtifact {
    /// Create a prebuilt extension artifact reference.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

/// One mobile static-registry symbol alias for an exact prebuilt extension.
///
/// `sql_symbol` is the C symbol name referenced by extension SQL. `linked_symbol`
/// is the actual C identifier exported by the carried mobile static archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionStaticSymbolAlias {
    /// SQL-visible C symbol name.
    pub sql_symbol: String,
    /// Link-time C identifier in the mobile static archive.
    pub linked_symbol: String,
}

impl NativeExtensionStaticSymbolAlias {
    /// Create a static-registry symbol alias.
    pub fn new(sql_symbol: impl Into<String>, linked_symbol: impl Into<String>) -> Self {
        Self {
            sql_symbol: sql_symbol.into(),
            linked_symbol: linked_symbol.into(),
        }
    }
}

/// Legal payload profile carried by one native prebuilt extension artifact.
///
/// The profile determines the exact release-notice leaves at the artifact
/// root. External artifacts additionally declare their exact PostgreSQL-
/// relative upstream license paths in their manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeExtensionArtifactLicenseProfile {
    /// Contrib payload carrying PostgreSQL notices.
    ContribNative,
    /// Contrib payload carrying PostgreSQL and embedded OpenSSL notices.
    ContribNativeOpenSsl,
    /// Independently versioned external-extension payload.
    ExternalNative,
}

impl NativeExtensionArtifactLicenseProfile {
    /// Stable `manifest.properties` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContribNative => "contrib-native",
            Self::ContribNativeOpenSsl => "contrib-native-openssl",
            Self::ExternalNative => "external-native",
        }
    }

    /// Parse the stable `manifest.properties` spelling.
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "contrib-native" => Ok(Self::ContribNative),
            "contrib-native-openssl" => Ok(Self::ContribNativeOpenSsl),
            "external-native" => Ok(Self::ExternalNative),
            _ => Err(Error::InvalidConfig(format!(
                "unsupported native extension artifact license profile '{value}'; expected contrib-native, contrib-native-openssl, or external-native"
            ))),
        }
    }
}

/// Mobile static-registry readiness of generated runtime resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobileStaticRegistryState {
    /// The selected extensions do not require native modules.
    NotRequired,
    /// Every selected native-module extension has a mobile static-registry row.
    Complete,
    /// At least one selected native-module extension still needs registry work.
    Pending,
}

impl MobileStaticRegistryState {
    fn as_manifest_value(self) -> &'static str {
        match self {
            Self::NotRequired => "not-required",
            Self::Complete => "complete",
            Self::Pending => "pending",
        }
    }
}

/// Mobile static-registry metadata recorded in generated runtime resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileStaticRegistryMetadata {
    /// Runtime-resource readiness state.
    pub state: MobileStaticRegistryState,
    /// Selected SQL extension names that are registered for mobile static use.
    pub registered_extensions: Vec<String>,
    /// Selected SQL extension names that still need mobile static registry rows.
    pub pending_extensions: Vec<String>,
    /// Native module stems required by the selected extensions.
    pub native_module_stems: Vec<String>,
}

/// Size report for generated runtime resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRuntimeResourceSizeReport {
    /// Stable TSV report path under the resource root.
    pub path: PathBuf,
    /// Bytes in runtime and static-registry resource trees. This
    /// intentionally excludes the report file itself to avoid circular output.
    pub package_bytes: u64,
    /// Bytes in `runtime/files`.
    pub runtime_bytes: u64,
    /// Bytes in `static-registry`.
    pub static_registry_bytes: u64,
    /// De-duplicated bytes for all selected extension assets present in the
    /// runtime tree.
    pub selected_extension_bytes: u64,
    /// Per-extension asset footprints.
    pub extensions: Vec<ExtensionSizeReport>,
}

/// Size report row for one selected extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionSizeReport {
    /// SQL extension name.
    pub name: String,
    /// Number of runtime files counted for this extension.
    pub file_count: usize,
    /// Runtime bytes counted for this extension.
    pub bytes: u64,
}

/// Runtime resources generated by the Rust SDK and consumed by Swift, Kotlin,
/// and React Native SDKs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRuntimeResources {
    /// Root directory containing runtime and static-registry resources.
    pub root: PathBuf,
    /// Runtime files directory copied into app storage before opening.
    pub runtime_files: PathBuf,
    /// Content key of the source runtime cache.
    pub runtime_cache_key: String,
    /// Built-in extensions materialized into the runtime resources.
    pub extensions: Vec<Extension>,
    /// Optional runtime features materialized into the runtime resources.
    pub runtime_features: Vec<NativeRuntimeFeature>,
    /// Exact extension names materialized into the runtime resources, including
    /// built-in and concrete prebuilt extension artifacts.
    pub extension_names: Vec<String>,
    /// Mobile static-registry metadata for the materialized runtime resources.
    pub mobile_static_registry: MobileStaticRegistryMetadata,
    /// PostgreSQL shared-preload libraries required by the selected extensions.
    pub shared_preload_libraries: Vec<String>,
    /// Static registry manifest generated for platform SDK resources.
    pub static_registry_manifest: PathBuf,
    /// Generated static registry source when the runtime resources are
    /// mobile-ready.
    pub static_registry_source: Option<PathBuf>,
    /// Package and extension size report.
    pub size_report: NativeRuntimeResourceSizeReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeResourceExtension {
    sql_name: String,
    native_runtime_version: Option<String>,
    creates_extension: bool,
    native_module_stem: Option<String>,
    native_module_file: Option<String>,
    native_target: Option<String>,
    dependencies: Vec<String>,
    data_files: Vec<PathBuf>,
    extension_sql_file_names: Vec<String>,
    extension_sql_file_prefixes: Vec<String>,
    shared_preload_libraries: Vec<String>,
    mobile_prebuilt: bool,
    mobile_static_archives: Vec<MobileStaticArchive>,
    mobile_static_dependency_archives: Vec<MobileStaticDependencyArchive>,
    static_symbol_prefix: Option<String>,
    static_symbol_aliases: Vec<NativeExtensionStaticSymbolAlias>,
    license_profile: Option<NativeExtensionArtifactLicenseProfile>,
    license_files: Vec<PathBuf>,
    source: RuntimeResourceExtensionSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeResourceExtensionSource {
    BuiltIn(Extension),
    Prebuilt { root: PathBuf, files_root: PathBuf },
}

#[derive(Debug)]
struct PreparedPrebuiltExtensionArtifacts {
    artifacts: Vec<NativePrebuiltExtensionArtifact>,
    extraction_root: Option<PathBuf>,
}

impl PreparedPrebuiltExtensionArtifacts {
    fn prepare(artifacts: &[NativePrebuiltExtensionArtifact]) -> Result<Self> {
        let mut prepared = Vec::new();
        let mut extraction_root = None;
        for (index, artifact) in artifacts.iter().enumerate() {
            if artifact.root.is_dir() {
                prepared.push(artifact.clone());
            } else if artifact.root.is_file() {
                let root = extraction_root.get_or_insert_with(unique_extension_extraction_root);
                fs::create_dir_all(&root).map_err(|err| {
                    Error::Engine(format!(
                        "create prebuilt extension artifact extraction root {}: {err}",
                        root.display()
                    ))
                })?;
                let destination = root.join(format!("artifact-{index}"));
                let extracted_root =
                    extract_prebuilt_extension_archive(&artifact.root, &destination)?;
                prepared.push(NativePrebuiltExtensionArtifact::new(extracted_root));
            } else {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact {} must be an unpacked directory, .tar archive, .tar.gz/.tgz archive, or .tar.zst archive",
                    artifact.root.display()
                )));
            }
        }
        Ok(Self {
            artifacts: prepared,
            extraction_root,
        })
    }

    fn artifacts(&self) -> &[NativePrebuiltExtensionArtifact] {
        &self.artifacts
    }
}

impl Drop for PreparedPrebuiltExtensionArtifacts {
    fn drop(&mut self) {
        if let Some(root) = &self.extraction_root {
            let _ = fs::remove_dir_all(root);
        }
    }
}

/// Build the portable runtime-resource layout consumed by platform SDK
/// packaging.
pub fn build_native_runtime_resources(
    options: NativeRuntimeResourceOptions,
) -> Result<NativeRuntimeResources> {
    if options.output_dir.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "native runtime-resource output directory must not be empty".to_owned(),
        ));
    }

    let expected_native_runtime_version = expected_prebuilt_native_runtime_version(&options)?;
    let prebuilt_artifacts =
        PreparedPrebuiltExtensionArtifacts::prepare(&options.prebuilt_extensions)?;
    let selected_extensions =
        resolve_runtime_resource_extensions(&options.extensions, prebuilt_artifacts.artifacts())?;
    validate_prebuilt_native_runtime_versions(
        &selected_extensions,
        expected_native_runtime_version,
    )?;
    validate_prebuilt_extension_targets(&selected_extensions, options.extension_target.as_deref())?;
    let runtime_features = normalize_runtime_features(&options.runtime_features);
    let extensions = built_in_extensions(&selected_extensions);
    let extension_names = selected_extension_names(&selected_extensions);
    let shared_preload_libraries = shared_preload_libraries(&selected_extensions);
    let mobile_static_registry =
        mobile_static_registry_metadata(&selected_extensions, &options.mobile_static_module_stems)?;
    if options.require_mobile_static_registry {
        require_mobile_static_registry_ready(&mobile_static_registry)?;
    }
    let catalog_profile = if runtime_features.contains(&NativeRuntimeFeature::Icu) {
        NativePackagingCatalogProfile::Icu
    } else {
        NativePackagingCatalogProfile::Standard
    };
    let materialized = materialize_native_packaging_resources(&extensions, catalog_profile)?;
    let root = options.output_dir.join("oliphaunt");
    prepare_output_root(&root, options.replace_existing)?;

    write_runtime_resource_tree(
        &root,
        &materialized,
        &selected_extensions,
        &runtime_features,
        &shared_preload_libraries,
        &mobile_static_registry,
        options.extension_target.as_deref(),
    )?;
    let size_report = runtime_resource_size_report(
        &root,
        &selected_extensions,
        options.extension_target.as_deref(),
        &mobile_static_registry,
    )?;
    write_runtime_resource_size_report(&size_report)?;

    Ok(NativeRuntimeResources {
        runtime_files: root.join("runtime/files"),
        static_registry_manifest: root.join("static-registry/manifest.properties"),
        static_registry_source: (mobile_static_registry.state
            == MobileStaticRegistryState::Complete)
            .then(|| root.join(format!("static-registry/{STATIC_REGISTRY_SOURCE_FILE}"))),
        root,
        runtime_cache_key: materialized.runtime_cache_key,
        extensions,
        runtime_features,
        extension_names,
        mobile_static_registry,
        shared_preload_libraries,
        size_report,
    })
}

fn expected_prebuilt_native_runtime_version(
    options: &NativeRuntimeResourceOptions,
) -> Result<Option<&str>> {
    let version = options.native_runtime_version.as_deref();
    if let Some(version) = version {
        validate_stable_semver(
            version,
            "selected liboliphaunt-native version for prebuilt extension packaging",
        )?;
    }
    if !options.prebuilt_extensions.is_empty() && version.is_none() {
        return Err(Error::InvalidConfig(
            "prebuilt extension packaging requires an exact stable liboliphaunt-native version; set NativeRuntimeResourceOptions::native_runtime_version(...) or pass --liboliphaunt-native-version <X.Y.Z>"
                .to_owned(),
        ));
    }
    Ok(version)
}

fn validate_prebuilt_native_runtime_versions(
    extensions: &[RuntimeResourceExtension],
    expected: Option<&str>,
) -> Result<()> {
    for extension in extensions {
        if !matches!(
            extension.source,
            RuntimeResourceExtensionSource::Prebuilt { .. }
        ) {
            continue;
        }
        let expected = expected.ok_or_else(|| {
            Error::InvalidConfig(
                "prebuilt extension packaging requires an exact stable liboliphaunt-native version"
                    .to_owned(),
            )
        })?;
        let actual = extension
            .native_runtime_version
            .as_deref()
            .expect("validated v1 prebuilt extension manifests carry nativeRuntimeVersion");
        if actual != expected {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact for '{}' requires liboliphaunt-native version '{}', but runtime packaging selected '{}'",
                extension.sql_name, actual, expected
            )));
        }
    }
    Ok(())
}

fn validate_prebuilt_extension_targets(
    extensions: &[RuntimeResourceExtension],
    extension_target: Option<&str>,
) -> Result<()> {
    for extension in extensions {
        if !matches!(
            extension.source,
            RuntimeResourceExtensionSource::Prebuilt { .. }
        ) || extension.native_module_stem.is_none()
        {
            continue;
        }
        validate_prebuilt_extension_target(extension, extension_target)?;
    }
    Ok(())
}

fn normalize_runtime_features(features: &[NativeRuntimeFeature]) -> Vec<NativeRuntimeFeature> {
    let normalized = features.iter().copied().collect::<BTreeSet<_>>();
    normalized.into_iter().collect()
}

fn runtime_feature_names(features: &[NativeRuntimeFeature]) -> Vec<&'static str> {
    features.iter().map(|feature| feature.as_str()).collect()
}

fn resolve_runtime_resource_extensions(
    built_in: &[Extension],
    prebuilt_artifacts: &[NativePrebuiltExtensionArtifact],
) -> Result<Vec<RuntimeResourceExtension>> {
    let mut prebuilt = BTreeMap::new();
    for artifact in prebuilt_artifacts {
        let extension = load_prebuilt_extension_artifact(&artifact.root)?;
        if prebuilt
            .insert(extension.sql_name.clone(), extension)
            .is_some()
        {
            return Err(Error::InvalidConfig(
                "prebuilt extension artifacts must not repeat the same SQL extension name"
                    .to_owned(),
            ));
        }
    }

    let mut requested = built_in
        .iter()
        .map(|extension| extension.sql_name().to_owned())
        .collect::<Vec<_>>();
    requested.extend(prebuilt.keys().cloned());

    let mut resolved = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for sql_name in requested {
        visit_runtime_resource_extension(
            &sql_name,
            &prebuilt,
            &mut visiting,
            &mut visited,
            &mut resolved,
        )?;
    }
    Ok(resolved)
}

fn visit_runtime_resource_extension(
    sql_name: &str,
    prebuilt: &BTreeMap<String, RuntimeResourceExtension>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
    resolved: &mut Vec<RuntimeResourceExtension>,
) -> Result<()> {
    if visited.contains(sql_name) {
        return Ok(());
    }
    if !visiting.insert(sql_name.to_owned()) {
        return Err(Error::InvalidConfig(format!(
            "cyclic native extension dependency involving '{sql_name}'"
        )));
    }

    let (extension, dependencies) = if let Some(extension) = prebuilt.get(sql_name) {
        (
            extension.clone(),
            extension
                .dependencies()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        )
    } else {
        let Some(extension) = Extension::by_sql_name(sql_name) else {
            return Err(Error::InvalidConfig(format!(
                "selected extension '{sql_name}' is neither built into this Oliphaunt release nor provided as a prebuilt extension artifact"
            )));
        };
        let selected_extension = built_in_runtime_resource_extension(extension);
        (
            selected_extension,
            catalog::for_extension(extension).dependencies.clone(),
        )
    };

    for dependency in dependencies {
        visit_runtime_resource_extension(&dependency, prebuilt, visiting, visited, resolved)?;
    }
    visiting.remove(sql_name);
    visited.insert(sql_name.to_owned());
    resolved.push(extension);
    Ok(())
}

fn built_in_runtime_resource_extension(extension: Extension) -> RuntimeResourceExtension {
    let catalog = catalog::for_extension(extension);
    RuntimeResourceExtension {
        sql_name: catalog.sql_name.clone(),
        native_runtime_version: None,
        creates_extension: catalog.creates_extension,
        native_module_stem: catalog.native_module_stem.clone(),
        native_module_file: catalog
            .native_module_stem
            .as_deref()
            .map(|stem| format!("{stem}{}", std::env::consts::DLL_SUFFIX)),
        native_target: None,
        dependencies: catalog.dependencies.clone(),
        data_files: catalog
            .runtime_share_data_files
            .iter()
            .map(PathBuf::from)
            .collect(),
        extension_sql_file_names: catalog.extension_sql_file_names.clone(),
        extension_sql_file_prefixes: catalog.extension_sql_file_prefixes.clone(),
        shared_preload_libraries: catalog.shared_preload_libraries.clone(),
        mobile_prebuilt: true,
        mobile_static_archives: Vec::new(),
        mobile_static_dependency_archives: Vec::new(),
        static_symbol_prefix: None,
        static_symbol_aliases: Vec::new(),
        license_profile: None,
        license_files: Vec::new(),
        source: RuntimeResourceExtensionSource::BuiltIn(extension),
    }
}

fn built_in_extensions(extensions: &[RuntimeResourceExtension]) -> Vec<Extension> {
    extensions
        .iter()
        .filter_map(|extension| match extension.source {
            RuntimeResourceExtensionSource::BuiltIn(extension) => Some(extension),
            RuntimeResourceExtensionSource::Prebuilt { .. } => None,
        })
        .collect()
}

fn selected_extension_names(extensions: &[RuntimeResourceExtension]) -> Vec<String> {
    let mut names = extensions
        .iter()
        .map(|extension| extension.sql_name.clone())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn createable_extension_names(extensions: &[RuntimeResourceExtension]) -> Vec<String> {
    let mut names = extensions
        .iter()
        .filter(|extension| extension.creates_extension)
        .map(|extension| extension.sql_name.clone())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn load_prebuilt_extension_artifact(root: &Path) -> Result<RuntimeResourceExtension> {
    let manifest_path = root.join("manifest.properties");
    let manifest_text = fs::read_to_string(&manifest_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "read prebuilt extension artifact manifest {}: {err}",
            manifest_path.display()
        ))
    })?;
    let manifest = parse_canonical_properties_manifest(
        &manifest_path,
        &manifest_text,
        &EXTENSION_ARTIFACT_MANIFEST_KEYS,
    )?;
    require_property(
        &manifest_path,
        &manifest,
        "packageLayout",
        EXTENSION_ARTIFACT_LAYOUT,
    )?;
    require_exact_manifest_keys(&manifest_path, &manifest, &EXTENSION_ARTIFACT_MANIFEST_KEYS)?;
    let pg_major = required_manifest_value(&manifest_path, &manifest, "pgMajor")?;
    if pg_major != "18" {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} targets PostgreSQL {pg_major}; Oliphaunt native packages require PostgreSQL 18",
            manifest_path.display()
        )));
    }
    let files_value = manifest
        .get("files")
        .map(String::as_str)
        .unwrap_or("files")
        .trim();
    if files_value != "files" {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} must use files=files",
            manifest_path.display()
        )));
    }
    let files_root = root.join("files");
    if !files_root.is_dir() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} is missing files/ runtime tree",
            root.display()
        )));
    }

    let sql_name = required_manifest_value(&manifest_path, &manifest, "sqlName")?.to_owned();
    validate_portable_id(&sql_name, "prebuilt extension sqlName")?;
    require_property(
        &manifest_path,
        &manifest,
        "nativeRuntimeProduct",
        EXTENSION_ARTIFACT_NATIVE_RUNTIME_PRODUCT,
    )?;
    let native_runtime_version =
        required_manifest_value(&manifest_path, &manifest, "nativeRuntimeVersion")?.to_owned();
    validate_stable_semver(
        &native_runtime_version,
        "prebuilt extension nativeRuntimeVersion",
    )?;
    let creates_extension = parse_manifest_yes_no(&manifest_path, &manifest, "createsExtension")?;
    let native_module_stem = optional_manifest_id(&manifest_path, &manifest, "nativeModuleStem")?;
    let native_module_file = optional_manifest_id(&manifest_path, &manifest, "nativeModuleFile")?;
    if native_module_file.is_some() && native_module_stem.is_none() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} uses nativeModuleFile without nativeModuleStem",
            manifest_path.display()
        )));
    }
    let native_module_file = native_module_stem.as_ref().map(|stem| {
        native_module_file
            .clone()
            .unwrap_or_else(|| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    });
    let native_target = optional_manifest_id(&manifest_path, &manifest, "nativeTarget")?;
    if native_module_stem.is_some() && native_target.is_none() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} declares nativeModuleStem but is missing nativeTarget",
            manifest_path.display()
        )));
    }
    let dependencies = parse_manifest_id_list(&manifest_path, &manifest, "dependencies")?;
    let data_files = parse_manifest_relative_path_list(&manifest_path, &manifest, "dataFiles")?;
    let extension_sql_file_names =
        parse_manifest_id_list(&manifest_path, &manifest, "extensionSqlFileNames")?;
    for file_name in &extension_sql_file_names {
        if !file_name.ends_with(".sql") {
            return Err(Error::InvalidConfig(format!(
                "manifest {} extensionSqlFileNames entry '{}' must be a SQL basename",
                manifest_path.display(),
                file_name
            )));
        }
    }
    let extension_sql_file_prefixes =
        parse_manifest_id_list(&manifest_path, &manifest, "extensionSqlFilePrefixes")?;
    for prefix in &extension_sql_file_prefixes {
        if prefix.contains('.') {
            return Err(Error::InvalidConfig(format!(
                "manifest {} extensionSqlFilePrefixes entry '{}' must be a basename prefix without '.'",
                manifest_path.display(),
                prefix
            )));
        }
    }
    let shared_preload_libraries =
        parse_manifest_id_list(&manifest_path, &manifest, "sharedPreloadLibraries")?;
    let mobile_prebuilt = parse_manifest_yes_no(&manifest_path, &manifest, "mobilePrebuilt")?;
    let mobile_static_archives =
        parse_manifest_mobile_static_archives(&manifest_path, &manifest, "mobileStaticArchives")?;
    let mobile_static_dependency_archives = parse_manifest_mobile_static_dependency_archives(
        &manifest_path,
        &manifest,
        "mobileStaticDependencyArchives",
    )?;
    let static_symbol_prefix =
        optional_manifest_c_identifier(&manifest_path, &manifest, "staticSymbolPrefix")?;
    let static_symbol_aliases =
        parse_manifest_static_symbol_aliases(&manifest_path, &manifest, "staticSymbolAliases")?;
    let license_files =
        parse_manifest_relative_path_list(&manifest_path, &manifest, "licenseFiles")?;
    validate_extension_artifact_license_paths(&manifest_path, &license_files)?;
    let license_profile = NativeExtensionArtifactLicenseProfile::parse(required_manifest_value(
        &manifest_path,
        &manifest,
        "licenseProfile",
    )?)?;
    validate_extension_artifact_license_profile(
        &manifest_path,
        &sql_name,
        native_target.as_deref(),
        &mobile_static_dependency_archives,
        license_profile,
        &license_files,
    )?;
    validate_prebuilt_extension_mobile_static_archives(
        root,
        &manifest_path,
        native_module_stem.as_deref(),
        mobile_prebuilt,
        &mobile_static_archives,
    )?;
    validate_prebuilt_extension_mobile_static_dependency_archives(
        root,
        &manifest_path,
        &mobile_static_archives,
        &mobile_static_dependency_archives,
    )?;

    let extension = RuntimeResourceExtension {
        sql_name,
        native_runtime_version: Some(native_runtime_version),
        creates_extension,
        native_module_stem,
        native_module_file,
        native_target,
        dependencies,
        data_files,
        extension_sql_file_names,
        extension_sql_file_prefixes,
        shared_preload_libraries,
        mobile_prebuilt,
        mobile_static_archives,
        mobile_static_dependency_archives,
        static_symbol_prefix,
        static_symbol_aliases,
        license_profile: Some(license_profile),
        license_files,
        source: RuntimeResourceExtensionSource::Prebuilt {
            root: root.to_path_buf(),
            files_root,
        },
    };
    validate_prebuilt_extension_leaf_inventory(root, &manifest_path, &extension)?;
    Ok(extension)
}

impl RuntimeResourceExtension {
    fn dependencies(&self) -> Vec<&str> {
        self.dependencies.iter().map(String::as_str).collect()
    }
}

fn runtime_extension_sql_file_belongs(
    extension: &RuntimeResourceExtension,
    file_name: &str,
) -> bool {
    (extension.creates_extension
        && (file_name == format!("{}.control", extension.sql_name)
            || file_name == format!("{}.sql", extension.sql_name)
            || (file_name.starts_with(&format!("{}--", extension.sql_name))
                && file_name.ends_with(".sql"))))
        || extension
            .extension_sql_file_names
            .iter()
            .any(|name| name == file_name)
        || (file_name.ends_with(".sql")
            && extension
                .extension_sql_file_prefixes
                .iter()
                .any(|prefix| file_name.starts_with(prefix)))
}

fn require_mobile_static_registry_ready(metadata: &MobileStaticRegistryMetadata) -> Result<()> {
    if metadata.state != MobileStaticRegistryState::Pending {
        return Ok(());
    }
    Err(Error::InvalidConfig(format!(
        "selected extension(s) require mobile static registry entries before iOS/Android packaging: {}",
        metadata.pending_extensions.join(",")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tar::EntryType;

    #[test]
    fn logical_tree_digest_uses_portable_path_order() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        write_file(&root.path().join("a/b"), b"nested");
        write_file(&root.path().join("a0"), b"flat");

        let windows_native_order = vec![
            ("a0".to_string(), root.path().join("a0")),
            ("a/b".to_string(), root.path().join("a/b")),
        ];
        let expected = "33fcdf990b4a606acc4d5cdda3ab275513c3a2fa87ae72bafc5f4e1278a2faa3";
        assert_eq!(
            logical_tree_sha256_files(windows_native_order).unwrap(),
            expected
        );
        assert_eq!(logical_tree_sha256(root.path()).unwrap(), expected);
    }

    #[test]
    fn mobile_static_registry_metadata_marks_sql_only_packages_not_required() {
        let extensions = runtime_resource_extensions(&[Extension::PGTAP]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::NotRequired);
        assert!(metadata.registered_extensions.is_empty());
        assert!(metadata.pending_extensions.is_empty());
        assert!(metadata.native_module_stems.is_empty());
    }

    #[test]
    fn mobile_static_registry_metadata_marks_module_extensions_pending() {
        let extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Pending);
        assert_eq!(metadata.pending_extensions, vec!["vector"]);
        assert_eq!(metadata.native_module_stems, vec!["vector"]);
        assert!(metadata.registered_extensions.is_empty());
    }

    #[test]
    fn mobile_static_registry_requirement_rejects_pending_modules() {
        let extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let error = require_mobile_static_registry_ready(&metadata).unwrap_err();
        assert!(matches!(
            error,
            Error::InvalidConfig(message)
                if message
                    == "selected extension(s) require mobile static registry entries before iOS/Android packaging: vector"
        ));
    }

    #[test]
    fn mobile_static_registry_metadata_marks_declared_modules_complete() {
        let extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let metadata =
            mobile_static_registry_metadata(&extensions, &["vector".to_owned()]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Complete);
        assert_eq!(metadata.registered_extensions, vec!["vector"]);
        assert!(metadata.pending_extensions.is_empty());
        assert_eq!(metadata.native_module_stems, vec!["vector"]);
        require_mobile_static_registry_ready(&metadata).unwrap();
    }

    #[test]
    fn mobile_static_registry_metadata_marks_hstore_complete_after_prebuilt_artifact_support() {
        let extensions = runtime_resource_extensions(&[Extension::HSTORE]);
        let metadata =
            mobile_static_registry_metadata(&extensions, &["hstore".to_owned()]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Complete);
        assert_eq!(metadata.registered_extensions, vec!["hstore"]);
        assert!(metadata.pending_extensions.is_empty());
        assert_eq!(metadata.native_module_stems, vec!["hstore"]);
        require_mobile_static_registry_ready(&metadata).unwrap();
    }

    #[test]
    fn mobile_static_registry_metadata_rejects_unknown_registered_modules() {
        let extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let error =
            mobile_static_registry_metadata(&extensions, &["hstore".to_owned()]).unwrap_err();
        assert!(matches!(
            error,
            Error::InvalidConfig(message)
                if message
                    == "mobile static registry module stem(s) were not selected by these runtime resources: hstore"
        ));
    }

    #[test]
    fn manifest_records_mobile_static_registry_metadata() {
        let extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            artifact_role: "runtime",
            catalog_profile: "",
            icu_data_tree_sha256: "",
            extensions: &extensions,
            runtime_features: &[],
            shared_preload_libraries: &[],
            mobile_static_registry: &metadata,
        };
        let text = manifest_text(&manifest);
        assert!(text.contains("selectedExtensions=vector\n"));
        assert!(text.contains("extensions=vector\n"));
        assert!(text.contains("sharedPreloadLibraries=\n"));
        assert!(text.contains("mobileStaticRegistryState=pending\n"));
        assert!(text.contains("mobileStaticRegistryPending=vector\n"));
        assert!(text.contains("nativeModuleStems=vector\n"));
        assert!(text.contains("mobileStaticRegistrySource=\n"));
        assert_eq!(
            text.lines()
                .map(|line| line.split_once('=').unwrap().0)
                .collect::<Vec<_>>(),
            vec![
                "schema",
                "layout",
                "artifactRole",
                "catalogProfile",
                "clusterSeedTarget",
                "icuDataTreeSha256",
                "mode",
                "cacheKey",
                "selectedExtensions",
                "extensions",
                "runtimeFeatures",
                "sharedPreloadLibraries",
                "mobileStaticRegistryState",
                "mobileStaticRegistryRegistered",
                "mobileStaticRegistryPending",
                "nativeModuleStems",
                "mobileStaticRegistrySource",
            ]
        );
    }

    #[test]
    fn manifest_records_required_shared_preload_libraries() {
        let extensions =
            runtime_resource_extensions(&[Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH]);
        let preload = shared_preload_libraries(&extensions);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            artifact_role: "runtime",
            catalog_profile: "",
            icu_data_tree_sha256: "",
            extensions: &extensions,
            runtime_features: &[],
            shared_preload_libraries: &preload,
            mobile_static_registry: &metadata,
        };
        let text = manifest_text(&manifest);
        assert!(text.contains("selectedExtensions=pg_textsearch\n"));
        assert!(text.contains("extensions=pg_textsearch\n"));
        assert!(text.contains("sharedPreloadLibraries=pg_textsearch\n"));
    }

    #[test]
    fn manifest_separates_selected_and_createable_extension_domains() {
        let extensions = runtime_resource_extensions(&[Extension::HSTORE, Extension::AUTO_EXPLAIN]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-domain-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            artifact_role: "runtime",
            catalog_profile: "",
            icu_data_tree_sha256: "",
            extensions: &extensions,
            runtime_features: &[],
            shared_preload_libraries: &[],
            mobile_static_registry: &metadata,
        };
        let text = manifest_text(&manifest);
        assert!(text.contains("selectedExtensions=auto_explain,hstore\n"));
        assert!(text.contains("extensions=hstore\n"));
        assert!(!text.contains("extensions=auto_explain"));
    }

    #[test]
    fn runtime_resource_package_omits_native_icu_files_data() {
        let temp = unique_temp_root("oliphaunt-runtime-resources-icu-data");
        let root = temp.join("oliphaunt");
        let materialized = MaterializedNativeResources {
            runtime_dir: temp.join("materialized/runtime"),
            runtime_cache_key: "runtime-icu".to_owned(),
        };
        write_file(
            &materialized
                .runtime_dir
                .join("share/postgresql/postgresql.conf.sample"),
            b"core-runtime",
        );
        write_file(
            &materialized.runtime_dir.join("share/icu/icudt76l.dat"),
            b"icu-data",
        );
        fs::create_dir_all(&root).unwrap();

        let metadata = mobile_static_registry_metadata(&[], &[]).unwrap();
        write_runtime_resource_tree(&root, &materialized, &[], &[], &[], &metadata, None).unwrap();

        assert!(
            !root.join("runtime/files/share/icu").exists(),
            "base runtime-resource packages must not carry ICU data; apps opt in through the ICU package"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_resource_package_copies_native_icu_data_when_feature_selected() {
        let temp = unique_temp_root("oliphaunt-runtime-resources-selected-icu-data");
        let root = temp.join("oliphaunt");
        let materialized = MaterializedNativeResources {
            runtime_dir: temp.join("materialized/runtime"),
            runtime_cache_key: "runtime-icu".to_owned(),
        };
        write_file(
            &materialized
                .runtime_dir
                .join("share/postgresql/postgresql.conf.sample"),
            b"core-runtime",
        );
        write_file(
            &materialized.runtime_dir.join("share/icu/icudt76l.dat"),
            b"icu-data",
        );
        fs::create_dir_all(&root).unwrap();

        let metadata = mobile_static_registry_metadata(&[], &[]).unwrap();
        write_runtime_resource_tree(
            &root,
            &materialized,
            &[],
            &[NativeRuntimeFeature::Icu],
            &[],
            &metadata,
            None,
        )
        .unwrap();

        assert!(root.join("runtime/files/share/icu/icudt76l.dat").is_file());
        let manifest = fs::read_to_string(root.join("runtime/manifest.properties")).unwrap();
        assert!(manifest.contains("runtimeFeatures=icu\n"));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn package_size_report_counts_selected_extension_assets() {
        let temp = unique_temp_root("oliphaunt-runtime-resources-size-report");
        let root = temp.join("oliphaunt");
        write_file(
            &root.join("runtime/files/share/postgresql/extension/vector.control"),
            b"vector-control",
        );
        write_file(
            &root.join("runtime/files/share/postgresql/extension/vector--1.0.sql"),
            b"vector-sql",
        );
        write_file(
            &root
                .join("runtime/files/lib/postgresql")
                .join(format!("vector{}", std::env::consts::DLL_SUFFIX)),
            b"vector-module",
        );
        write_file(
            &root.join("runtime/files/share/postgresql/postgresql.conf.sample"),
            b"core-runtime",
        );

        write_file(
            &root.join("static-registry/manifest.properties"),
            b"state=pending\n",
        );

        let selected_extensions = runtime_resource_extensions(&[Extension::VECTOR]);
        let metadata = mobile_static_registry_metadata(&selected_extensions, &[]).unwrap();
        let report = runtime_resource_size_report(
            &root,
            &selected_extensions,
            Some("test-target"),
            &metadata,
        )
        .unwrap();
        write_runtime_resource_size_report(&report).unwrap();

        let vector_bytes = b"vector-control".len() as u64
            + b"vector-sql".len() as u64
            + b"vector-module".len() as u64;
        assert_eq!(report.selected_extension_bytes, vector_bytes);
        assert_eq!(report.extensions.len(), 1);
        assert_eq!(report.extensions[0].name, "vector");
        assert_eq!(report.extensions[0].file_count, 3);
        assert_eq!(report.extensions[0].bytes, vector_bytes);

        let text = fs::read_to_string(root.join("package-size.tsv")).unwrap();
        assert!(text.contains("kind\tid\textensions\tfiles\tbytes\n"));
        assert!(text.contains(&format!("extensions\tselected\t-\t-\t{vector_bytes}\n")));
        assert!(text.contains(&format!("extension\tvector\t-\t3\t{vector_bytes}\n")));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn package_size_report_counts_selected_extension_data_files_under_share() {
        let temp = unique_temp_root("oliphaunt-runtime-resources-data-file-report");
        let root = temp.join("oliphaunt");
        write_file(
            &root.join("runtime/files/share/postgresql/extension/unaccent.control"),
            b"unaccent-control",
        );
        write_file(
            &root.join("runtime/files/share/postgresql/extension/unaccent--1.1.sql"),
            b"unaccent-sql",
        );
        write_file(
            &root.join("runtime/files/share/postgresql/tsearch_data/unaccent.rules"),
            b"unaccent-rules",
        );
        write_file(
            &root
                .join("runtime/files/lib/postgresql")
                .join(format!("unaccent{}", std::env::consts::DLL_SUFFIX)),
            b"unaccent-module",
        );
        write_file(
            &root.join("runtime/files/share/postgresql/postgresql.conf.sample"),
            b"core-runtime",
        );

        write_file(
            &root.join("static-registry/manifest.properties"),
            b"state=pending\n",
        );

        let selected_extensions = runtime_resource_extensions(&[Extension::UNACCENT]);
        let metadata = mobile_static_registry_metadata(&selected_extensions, &[]).unwrap();
        let report = runtime_resource_size_report(
            &root,
            &selected_extensions,
            Some("test-target"),
            &metadata,
        )
        .unwrap();

        let unaccent_bytes = b"unaccent-control".len() as u64
            + b"unaccent-sql".len() as u64
            + b"unaccent-rules".len() as u64
            + b"unaccent-module".len() as u64;
        assert_eq!(report.selected_extension_bytes, unaccent_bytes);
        assert_eq!(report.extensions.len(), 1);
        assert_eq!(report.extensions[0].name, "unaccent");
        assert_eq!(report.extensions[0].file_count, 4);
        assert_eq!(report.extensions[0].bytes, unaccent_bytes);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn module_symbol_parser_finds_module_pathname_and_exact_libdir_symbols() {
        let symbols = module_c_symbols(
            r#"
-- Commented AS 'MODULE_PATHNAME', 'ignored_symbol' LANGUAGE C;
CREATE FUNCTION public.implicit_symbol(integer) RETURNS integer
  AS 'MODULE_PATHNAME' LANGUAGE C IMMUTABLE STRICT;
CREATE OR REPLACE FUNCTION public.explicit_sql_name(integer) RETURNS integer
  AS 'MODULE_PATHNAME', 'explicit_c_symbol'
  LANGUAGE C STRICT;
CREATE OR REPLACE FUNCTION public.spheroid_in(cstring) RETURNS spheroid
  AS '$libdir/postgis-3', 'ellipsoid_in'
  LANGUAGE 'c' IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION public.default_literal_decoy(text DEFAULT '$libdir/postgis-3') RETURNS integer
  AS '$libdir/not-postgis-3', 'default_literal_must_not_be_registered' LANGUAGE C;
CREATE FUNCTION public.as_keyword_decoy(text DEFAULT 'AS ''$libdir/postgis-3'', ''also_not_registered''') RETURNS integer
  AS '$libdir/not-postgis-3', 'as_literal_must_not_be_registered' LANGUAGE C;
CREATE FUNCTION public.foreign_module(integer) RETURNS integer
  AS '$libdir/not-postgis-3', 'must_not_be_registered' LANGUAGE C;
CREATE FUNCTION sql_only(integer) RETURNS integer
  LANGUAGE sql AS 'SELECT $1';
"#,
            "postgis-3",
        )
        .unwrap();
        assert_eq!(
            symbols,
            vec!["ellipsoid_in", "explicit_c_symbol", "implicit_symbol"]
        );
    }

    #[test]
    fn static_registry_source_declares_magic_init_and_sql_symbols() {
        let modules = vec![StaticRegistryModule {
            extension_sql_name: "vector".to_owned(),
            module_stem: "vector".to_owned(),
            symbol_prefix: "oliphaunt_static_vector".to_owned(),
            sql_symbols: vec!["vector_in".to_owned(), "vector_out".to_owned()],
            symbol_aliases: BTreeMap::new(),
        }];
        let source = static_registry_source_text(&modules);
        assert!(source.contains("liboliphaunt_selected_static_extensions"));
        assert!(source.contains("oliphaunt_static_vector_Pg_magic_func"));
        assert!(source.contains("oliphaunt_static_vector__PG_init"));
        assert!(source.contains("OLIPHAUNT_STATIC_OPTIONAL"));
        assert!(source.contains("extern const void *oliphaunt_static_vector_Pg_magic_func(void);"));
        assert!(source.contains(
            "extern void oliphaunt_static_vector__PG_init(void) OLIPHAUNT_STATIC_OPTIONAL;"
        ));
        assert!(source.contains("extern void vector_in(void);"));
        assert!(!source.contains(&format!("OLIPHAUNT_STATIC_{}", "WEAK")));
        assert!(!source.contains("extern void vector_in(void) OLIPHAUNT_STATIC_OPTIONAL"));
        assert!(source.contains("{ .name = \"vector_in\", .address = (void *)vector_in }"));
        assert!(
            source.contains(
                "{ .name = \"pg_finfo_vector_in\", .address = (void *)pg_finfo_vector_in }"
            )
        );
        let manifest = static_registry_manifest_text(
            &MobileStaticRegistryMetadata {
                state: MobileStaticRegistryState::Complete,
                registered_extensions: vec!["vector".to_owned()],
                pending_extensions: vec![],
                native_module_stems: vec!["vector".to_owned()],
            },
            &modules,
            &[],
            &[],
        );
        assert!(manifest.contains("packageLayout=oliphaunt-static-registry-v1\n"));
        assert!(manifest.contains("source=oliphaunt_static_registry.c\n"));
        assert!(manifest.contains("module.vector.sqlSymbols=vector_in,vector_out\n"));
    }

    #[test]
    fn prebuilt_extension_artifact_is_exact_and_mobile_registry_ready() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-artifact");
        let artifact = temp.join("acme_ext");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );
        write_file(
            &artifact.join("files/share/postgresql/extension/hstore.control"),
            b"comment = 'should not leak'\n",
        );

        let error = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("contains undeclared extension SQL/control file files/share/postgresql/extension/hstore.control"),
            "unexpected extra-leaf error: {error}"
        );
        fs::remove_file(artifact.join("files/share/postgresql/extension/hstore.control")).unwrap();

        let extensions = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);

        let runtime_files = temp.join("runtime/files");
        write_file(
            &runtime_files.join("share/postgresql/postgresql.conf.sample"),
            b"core-runtime",
        );

        let pending_metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        copy_prebuilt_extension_artifacts(
            &runtime_files,
            &extensions,
            Some("test-target"),
            &pending_metadata,
        )
        .unwrap();

        assert!(
            runtime_files
                .join("share/postgresql/extension/acme_ext.control")
                .is_file()
        );
        assert!(
            runtime_files
                .join("share/postgresql/extension/acme_ext--1.0.sql")
                .is_file()
        );
        assert!(
            runtime_files
                .join("share/postgresql/data/acme_ext.rules")
                .is_file()
        );
        assert!(
            runtime_files
                .join("lib/postgresql")
                .join(format!("acme_ext{}", std::env::consts::DLL_SUFFIX))
                .is_file()
        );
        assert!(
            !runtime_files
                .join("share/postgresql/extension/hstore.control")
                .exists(),
            "unselected files inside a prebuilt extension artifact must not leak"
        );

        let metadata =
            mobile_static_registry_metadata(&extensions, &["acme_ext".to_owned()]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Complete);
        assert_eq!(metadata.registered_extensions, vec!["acme_ext"]);
        assert_eq!(metadata.native_module_stems, vec!["acme_ext"]);

        let modules = static_registry_modules(&runtime_files, &extensions, &metadata).unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].extension_sql_name, "acme_ext");
        assert_eq!(modules[0].symbol_prefix, "acme_static");
        assert_eq!(modules[0].sql_symbols, vec!["acme_ext_echo"]);
        let static_registry_dir = temp.join("oliphaunt/static-registry");
        let archives = copy_prebuilt_mobile_static_archives(&static_registry_dir, &extensions)
            .expect("copy selected mobile static archives");
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].target, "ios-simulator");
        assert!(
            static_registry_dir
                .join(
                    "archives/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a"
                )
                .is_file(),
            "selected external mobile static archive must be copied into runtime resources"
        );
        let dependency_archives =
            copy_prebuilt_mobile_static_dependency_archives(&static_registry_dir, &extensions)
                .expect("copy selected mobile static dependency archives");
        assert_eq!(dependency_archives.len(), 1);
        assert_eq!(dependency_archives[0].target, "ios-simulator");
        assert_eq!(dependency_archives[0].name, "openssl");
        assert!(
            static_registry_dir
                .join("archives/ios-simulator/dependencies/openssl/libcrypto.a")
                .is_file(),
            "selected external mobile static dependency archive must be copied into runtime resources"
        );
        let static_manifest =
            static_registry_manifest_text(&metadata, &modules, &archives, &dependency_archives);
        assert!(static_manifest.contains("archiveTargets=ios-simulator\n"));
        assert!(static_manifest.contains("dependencyArchiveTargets=ios-simulator\n"));
        assert!(static_manifest.contains("dependencyArchives=openssl\n"));
        assert!(static_manifest.contains("module.acme_ext.archiveTargets=ios-simulator\n"));
        assert!(static_manifest.contains(
            "module.acme_ext.archive.ios-simulator=archives/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a\n"
        ));
        assert!(static_manifest.contains("dependency.openssl.archiveTargets=ios-simulator\n"));
        assert!(static_manifest.contains(
            "dependency.openssl.archive.ios-simulator=archives/ios-simulator/dependencies/openssl/libcrypto.a\n"
        ));

        write_file(
            &temp.join("oliphaunt/static-registry/manifest.properties"),
            b"state=complete\n",
        );
        copy_portable_tree(&runtime_files, &temp.join("oliphaunt/runtime/files")).unwrap();
        let report = runtime_resource_size_report(
            &temp.join("oliphaunt"),
            &extensions,
            Some("test-target"),
            &pending_metadata,
        )
        .unwrap();
        assert_eq!(report.extensions.len(), 1);
        assert_eq!(report.extensions[0].name, "acme_ext");
        assert_eq!(report.extensions[0].file_count, 5);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_resource_packaging_selects_the_engine_module_profile() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-engine-profiles");
        let artifact = temp.join("acme_ext");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let extensions = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let module = format!("acme_ext{}", std::env::consts::DLL_SUFFIX);
        let direct_runtime = temp.join("direct-runtime");

        copy_prebuilt_extension_artifacts(
            &direct_runtime,
            &extensions,
            Some("test-target"),
            &metadata,
        )
        .unwrap();
        assert_eq!(
            fs::read(direct_runtime.join("lib/postgresql").join(&module)).unwrap(),
            b"acme-embedded-module\n"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_mobile_static_registry_skips_desktop_dynamic_module() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-mobile-static");
        let artifact = temp.join("acme_ext");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );
        let extensions = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        let metadata =
            mobile_static_registry_metadata(&extensions, &["acme_ext".to_owned()]).unwrap();
        let runtime_files = temp.join("runtime/files");
        copy_prebuilt_extension_artifacts(
            &runtime_files,
            &extensions,
            Some("ios-xcframework"),
            &metadata,
        )
        .unwrap();

        assert!(
            runtime_files
                .join("share/postgresql/extension/acme_ext.control")
                .is_file()
        );
        assert!(
            !runtime_files
                .join("lib/postgresql")
                .join(format!("acme_ext{}", std::env::consts::DLL_SUFFIX))
                .exists(),
            "mobile-static extension packaging must not copy a desktop dynamic module"
        );
        let root = temp.join("oliphaunt");
        write_file(
            &root.join("static-registry/manifest.properties"),
            b"state=complete\n",
        );
        copy_portable_tree(&runtime_files, &root.join("runtime/files")).unwrap();

        let report =
            runtime_resource_size_report(&root, &extensions, Some("ios-xcframework"), &metadata)
                .unwrap();
        assert_eq!(report.extensions[0].file_count, 4);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_resource_tree_generates_static_registry_from_packaged_prebuilt_sql() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-packaged-static-registry");
        let base_runtime = temp.join("base-runtime");
        write_file(
            &base_runtime.join("share/postgresql/postgresql.conf.sample"),
            b"core-runtime\n",
        );
        write_file(
            &base_runtime.join("share/postgresql/extension/plpgsql.control"),
            b"comment = 'must not leak'\n",
        );
        write_file(
            &base_runtime.join("share/postgresql/extension/plpgsql--1.0.sql"),
            b"select 'must not leak';\n",
        );
        write_file(
            &base_runtime.join("share/postgresql/extension/acme_ext--base.sql"),
            b"select 'base acme must not shadow prebuilt';\n",
        );
        write_file(
            &base_runtime
                .join("lib/postgresql")
                .join(format!("acme_ext{}", std::env::consts::DLL_SUFFIX)),
            b"base-acme-module\n",
        );

        let artifact = temp.join("acme_ext");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );
        let manifest = artifact.join("manifest.properties");
        let alias_line = "staticSymbolAliases=acme_ext_echo:acme_static_acme_ext_echo,pg_finfo_acme_ext_echo:acme_static_pg_finfo_acme_ext_echo,helper_symbol:acme_static_helper_symbol\n";
        let mut manifest_text = fs::read_to_string(&manifest).unwrap();
        if manifest_text.contains("staticSymbolAliases=\n") {
            manifest_text = manifest_text.replace("staticSymbolAliases=\n", alias_line);
        } else {
            manifest_text.push_str(alias_line);
        }
        write_file(&manifest, manifest_text.as_bytes());
        let extensions = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        let metadata =
            mobile_static_registry_metadata(&extensions, &["acme_ext".to_owned()]).unwrap();

        let root = temp.join("oliphaunt");
        write_runtime_resource_tree(
            &root,
            &MaterializedNativeResources {
                runtime_dir: base_runtime,
                runtime_cache_key: "runtime-cache".to_owned(),
            },
            &extensions,
            &[],
            &[],
            &metadata,
            Some("test-target"),
        )
        .unwrap();

        let registry_source =
            fs::read_to_string(root.join("static-registry/oliphaunt_static_registry.c")).unwrap();
        assert!(registry_source.contains("liboliphaunt_selected_static_extensions"));
        assert!(
            registry_source.contains("acme_ext_echo"),
            "static registry must parse SQL copied from the prebuilt extension artifact"
        );
        assert!(
            registry_source.contains("extern void acme_static_acme_ext_echo(void);"),
            "static registry must reference aliased link-time symbols"
        );
        assert!(
            registry_source.contains(
                "{ .name = \"acme_ext_echo\", .address = (void *)acme_static_acme_ext_echo }"
            ),
            "static registry must keep SQL symbol names while pointing at aliased symbols"
        );
        assert!(
            registry_source.contains(
                "{ .name = \"helper_symbol\", .address = (void *)acme_static_helper_symbol }"
            ),
            "static registry must include explicit aliases outside main extension SQL"
        );
        assert!(
            root.join("runtime/files/share/postgresql/extension/acme_ext--1.0.sql")
                .is_file(),
            "prebuilt SQL must be part of the final runtime package"
        );
        assert!(
            root.join("runtime/files/share/postgresql/extension/plpgsql.control")
                .is_file(),
            "PL/pgSQL control metadata is mandatory baseline runtime metadata"
        );
        assert!(
            root.join("runtime/files/share/postgresql/extension/plpgsql--1.0.sql")
                .is_file(),
            "PL/pgSQL SQL metadata is mandatory baseline runtime metadata"
        );
        assert!(
            !root
                .join("runtime/files/share/postgresql/extension/acme_ext--base.sql")
                .exists(),
            "base runtime files for a prebuilt-selected extension must not shadow the exact artifact"
        );
        assert!(
            !root
                .join("runtime/files/lib/postgresql")
                .join(format!("acme_ext{}", std::env::consts::DLL_SUFFIX))
                .exists(),
            "mobile-static prebuilt extensions must not retain base dynamic modules"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_rejects_missing_native_target() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-missing-target");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap();
        fs::write(
            &manifest,
            text.replace("nativeTarget=test-target\n", "nativeTarget=\n"),
        )
        .unwrap();

        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("missing nativeTarget"),
            "unexpected missing-target error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_requires_canonical_native_runtime_product() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-native-product");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let canonical = fs::read_to_string(&manifest).unwrap();

        fs::write(
            &manifest,
            canonical.replace(
                "nativeRuntimeProduct=liboliphaunt-native\n",
                "nativeRuntimeProduct=another-runtime\n",
            ),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("nativeRuntimeProduct='another-runtime', expected 'liboliphaunt-native'"),
            "unexpected wrong-product error: {error}"
        );

        fs::write(
            &manifest,
            canonical.replace("nativeRuntimeProduct=liboliphaunt-native\n", ""),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("missing=[nativeRuntimeProduct]"),
            "unexpected missing-product error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_requires_stable_native_runtime_version() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-native-version");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let canonical = fs::read_to_string(&manifest).unwrap();

        fs::write(
            &manifest,
            canonical.replace(
                "nativeRuntimeVersion=1.2.3\n",
                "nativeRuntimeVersion=1.2.3-rc.1\n",
            ),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("stable semantic version"),
            "unexpected prerelease-version error: {error}"
        );

        fs::write(
            &manifest,
            canonical.replace("nativeRuntimeVersion=1.2.3\n", ""),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("missing=[nativeRuntimeVersion]"),
            "unexpected missing-version error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_rejects_unknown_manifest_key() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-unknown-key");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let mut text = fs::read_to_string(&manifest).unwrap();
        text.push_str("futureCompatibilityGuess=yes\n");
        fs::write(&manifest, text).unwrap();

        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unknown=[futureCompatibilityGuess]"),
            "unexpected unknown-key error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_requires_canonical_ancillary_sql_fields() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-ancillary-sql-fields");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let canonical = fs::read_to_string(&manifest).unwrap();

        fs::write(
            &manifest,
            canonical.replace(
                "extensionSqlFileNames=\n",
                "extensionSqlFileNames=z.sql,a.sql\n",
            ),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("extensionSqlFileNames must be sorted and unique"),
            "unexpected unsorted ancillary-SQL error: {error}"
        );

        fs::write(
            &manifest,
            canonical.replace(
                "extensionSqlFilePrefixes=\n",
                "extensionSqlFilePrefixes=acme_,acme_\n",
            ),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("extensionSqlFilePrefixes must be sorted and unique"),
            "unexpected duplicate ancillary-SQL-prefix error: {error}"
        );

        let reordered = canonical.replace(
            "extensionSqlFileNames=\nextensionSqlFilePrefixes=\n",
            "extensionSqlFilePrefixes=\nextensionSqlFileNames=\n",
        );
        fs::write(&manifest, reordered).unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("line 12 must be canonical field extensionSqlFileNames"),
            "unexpected reordered-field error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_rejects_noncanonical_boolean_values() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-noncanonical-bool");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = artifact.join("manifest.properties");
        let canonical = fs::read_to_string(&manifest).unwrap();

        fs::write(
            &manifest,
            canonical.replace("createsExtension=yes\n", "createsExtension=true\n"),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("createsExtension='true', expected canonical yes/no"),
            "unexpected createsExtension boolean error: {error}"
        );

        fs::write(
            &manifest,
            canonical.replace("mobilePrebuilt=no\n", "mobilePrebuilt=false\n"),
        )
        .unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("mobilePrebuilt='false', expected canonical yes/no"),
            "unexpected mobilePrebuilt boolean error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_packaging_requires_selected_native_runtime_version() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-selected-version-required");
        let artifact = temp.join("artifact-root");
        let output = temp.join("output");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );

        let error = build_native_runtime_resources(
            NativeRuntimeResourceOptions::new(&output).prebuilt_extension(&artifact),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires an exact stable liboliphaunt-native version"),
            "unexpected missing selected-version error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_packaging_rejects_wrong_native_runtime_version_before_materialization() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-wrong-native-version");
        let artifact = temp.join("artifact-root");
        let output = temp.join("output");
        write_prebuilt_extension_artifact_for_runtime(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
            "1.2.4",
        );

        let error = build_native_runtime_resources(
            NativeRuntimeResourceOptions::new(&output)
                .prebuilt_extension(&artifact)
                .native_runtime_version("1.2.3"),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(
                "requires liboliphaunt-native version '1.2.4', but runtime packaging selected '1.2.3'"
            ),
            "unexpected mismatched-version error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_packaging_rejects_mixed_native_runtime_versions() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-mixed-native-versions");
        let first = temp.join("first");
        let second = temp.join("second");
        let output = temp.join("output");
        write_prebuilt_extension_artifact_for_runtime(
            &first,
            "acme_a",
            "acme_a",
            "acme_static_a",
            "data/acme_a.rules",
            false,
            "1.2.3",
        );
        write_prebuilt_extension_artifact_for_runtime(
            &second,
            "acme_b",
            "acme_b",
            "acme_static_b",
            "data/acme_b.rules",
            false,
            "1.2.4",
        );

        let error = build_native_runtime_resources(
            NativeRuntimeResourceOptions::new(&output)
                .prebuilt_extension(first)
                .prebuilt_extension(second)
                .native_runtime_version("1.2.3"),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("artifact for 'acme_b'")
                && error.to_string().contains("version '1.2.4'")
                && error.to_string().contains("selected '1.2.3'"),
            "unexpected mixed-version error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_rejects_wrong_runtime_target() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-wrong-target");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let extensions = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let error = copy_prebuilt_extension_artifacts(
            &temp.join("runtime/files"),
            &extensions,
            Some("linux-x64-gnu"),
            &metadata,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(
                "prebuilt extension artifact for 'acme_ext' targets 'test-target', but runtime packaging target is 'linux-x64-gnu'"
            ),
            "unexpected wrong-target error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn mobile_static_prebuilt_extension_rejects_wrong_runtime_target_before_materialization() {
        let temp = unique_temp_root("oliphaunt-mobile-static-prebuilt-wrong-target");
        let artifact = temp.join("artifact-root");
        let output = temp.join("output");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );

        let error = build_native_runtime_resources(
            NativeRuntimeResourceOptions::new(&output)
                .prebuilt_extension(&artifact)
                .native_runtime_version("1.2.3")
                .extension_target("ios-simulator")
                .mobile_static_module_stems(vec!["acme_ext".to_owned()]),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(
                "prebuilt extension artifact for 'acme_ext' targets 'test-target', but runtime packaging target is 'ios-simulator'"
            ),
            "unexpected mobile-static wrong-target error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_tar_archive_is_validated_and_consumed() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar");
        write_tar_archive_from_dir(&archive, &artifact, "acme_ext");

        let prepared =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive,
            )])
            .unwrap();
        let extensions = resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
        assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);
        assert_eq!(
            extensions[0].native_module_stem.as_deref(),
            Some("acme_ext")
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_nested_archive_rejects_top_level_file_sibling() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-file-sibling");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext-with-file-sibling.tar");
        write_tar_archive_from_dir_with_top_level_sibling(
            &archive,
            &artifact,
            "acme_ext",
            "undeclared.txt",
            false,
        );

        let error =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive,
            )])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one top-level directory with no sibling entries"),
            "unexpected top-level file sibling error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_nested_archive_rejects_top_level_directory_sibling() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-directory-sibling");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext-with-directory-sibling.tar");
        write_tar_archive_from_dir_with_top_level_sibling(
            &archive,
            &artifact,
            "acme_ext",
            "undeclared",
            true,
        );

        let error =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive,
            )])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one top-level directory with no sibling entries"),
            "unexpected top-level directory sibling error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_archive_rejects_noncanonical_legal_header_modes() {
        for (case, member) in [
            ("root-license", "acme_ext/LICENSE"),
            (
                "declared-upstream-license",
                "acme_ext/files/share/licenses/acme_ext/LICENSE",
            ),
        ] {
            let temp = unique_temp_root(&format!(
                "oliphaunt-prebuilt-extension-tar-legal-mode-{case}"
            ));
            let artifact = temp.join("artifact-root");
            write_prebuilt_extension_artifact(
                &artifact,
                "acme_ext",
                "acme_ext",
                "acme_static",
                "data/acme_ext.rules",
                false,
            );
            let archive = temp.join(format!("acme_ext-{case}.tar"));
            write_tar_archive_from_dir(&archive, &artifact, "acme_ext");
            rewrite_tar_archive_member_mode(&archive, Path::new(member), 0o600);

            let error = PreparedPrebuiltExtensionArtifacts::prepare(&[
                NativePrebuiltExtensionArtifact::new(&archive),
            ])
            .unwrap_err();
            assert!(
                error.to_string().contains(&format!(
                    "legal member {member} must have exact tar header mode 0644, got 0600"
                )),
                "unexpected {case} legal header-mode error: {error}"
            );

            let _ = fs::remove_dir_all(temp);
        }
    }

    #[test]
    fn prebuilt_extension_artifact_rejects_mobile_archive_path_escape() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-mobile-path");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );
        let wrong_relative = "files/lib/postgresql/liboliphaunt_extension_acme_ext.a";
        write_file(&artifact.join(wrong_relative), b"wrong-place-static\n");
        let manifest = artifact.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap();
        fs::write(
            &manifest,
            text.replace(
                "mobileStaticArchives=ios-simulator:mobile-static/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a\n",
                &format!("mobileStaticArchives=ios-simulator:{wrong_relative}\n"),
            ),
        )
        .unwrap();

        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("must use mobile-static"),
            "unexpected mobile archive path error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_compressed_archives_are_validated_and_consumed() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-zst");
        let artifact = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let tar = temp.join("source.tar");
        write_tar_archive_from_dir(&tar, &artifact, "acme_ext");
        let bytes = fs::read(&tar).unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gzip, &bytes).unwrap();
        let gz = temp.join("acme_ext.tar.gz");
        fs::write(&gz, gzip.finish().unwrap()).unwrap();
        let zst = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&zst, &artifact, "acme_ext");
        for archive in [gz, zst] {
            let prepared = PreparedPrebuiltExtensionArtifacts::prepare(&[
                NativePrebuiltExtensionArtifact::new(&archive),
            ])
            .unwrap();
            let extensions =
                resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
            assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);
        }

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_archive_rejects_non_file_entries() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-symlink");
        let archive_path = temp.join("malicious.tar");
        let mut bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut bytes);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(EntryType::symlink());
            header.set_path("manifest.properties").unwrap();
            header.set_link_name("/tmp/not-allowed").unwrap();
            header.set_mode(0o777);
            header.set_size(0);
            header.set_cksum();
            archive.append(&header, std::io::empty()).unwrap();
            archive.finish().unwrap();
        }
        write_file(&archive_path, &bytes);

        let error =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive_path,
            )])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("must be a regular file or directory"),
            "unexpected symlink-entry error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_archive_rejects_oversized_members_before_extraction() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-oversized-member");
        let archive_path = temp.join("oversized.tar");
        fs::create_dir_all(&temp).unwrap();
        let policy = extension_artifact_archive_policy().unwrap();
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(EntryType::Regular);
        header.set_path("files/oversized.bin").unwrap();
        header.set_mode(0o644);
        header.set_size(policy.max_member_bytes + 1);
        header.set_cksum();
        let mut bytes = header.as_bytes().to_vec();
        bytes.extend_from_slice(&[0u8; 1024]);
        write_file(&archive_path, &bytes);

        let error =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive_path,
            )])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("member larger than 268435456 bytes"),
            "unexpected oversized-member error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_archive_rejects_oversized_compressed_carriers_before_decoding() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-tar-oversized-compressed");
        let archive_path = temp.join("oversized.tar.gz");
        fs::create_dir_all(&temp).unwrap();
        let file = File::create(&archive_path).unwrap();
        let policy = extension_artifact_archive_policy().unwrap();
        file.set_len(policy.max_compressed_bytes + 1).unwrap();

        let error =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive_path,
            )])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("must contain between 1 and 134217728 bytes"),
            "unexpected oversized-carrier error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn production_extension_legal_profiles_load_with_exact_leaf_inventories() {
        let temp = unique_temp_root("oliphaunt-extension-legal-profiles");
        let cube = temp.join("cube");
        write_profiled_extension_artifact(
            &cube,
            "cube",
            "cube",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ContribNative,
            &[],
        );
        let loaded = load_prebuilt_extension_artifact(&cube).unwrap();
        assert_eq!(
            loaded.license_profile,
            Some(NativeExtensionArtifactLicenseProfile::ContribNative)
        );
        assert!(loaded.license_files.is_empty());

        let pgcrypto = temp.join("pgcrypto");
        write_profiled_extension_artifact(
            &pgcrypto,
            "pgcrypto",
            "pgcrypto",
            "macos-arm64",
            NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl,
            &[],
        );
        let loaded = load_prebuilt_extension_artifact(&pgcrypto).unwrap();
        assert_eq!(
            loaded.license_profile,
            Some(NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl)
        );

        let postgis = temp.join("postgis");
        let postgis_licenses = [
            "share/licenses/geos/COPYING",
            "share/licenses/postgis/COPYING",
        ];
        write_profiled_extension_artifact(
            &postgis,
            "postgis",
            "postgis-3",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ExternalNative,
            &postgis_licenses,
        );
        let loaded = load_prebuilt_extension_artifact(&postgis).unwrap();
        assert_eq!(
            loaded.license_profile,
            Some(NativeExtensionArtifactLicenseProfile::ExternalNative)
        );
        assert_eq!(
            loaded.license_files,
            postgis_licenses.map(PathBuf::from).to_vec()
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_rejects_missing_extra_unsafe_and_wrong_profile_legal_files() {
        let temp = unique_temp_root("oliphaunt-extension-legal-adversarial");

        let missing = temp.join("missing");
        write_profiled_extension_artifact(
            &missing,
            "postgis",
            "postgis-3",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ExternalNative,
            &["share/licenses/postgis/COPYING"],
        );
        fs::remove_file(missing.join("files/share/licenses/postgis/COPYING")).unwrap();
        let error = load_prebuilt_extension_artifact(&missing).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("leaf inventory mismatch; missing: files/share/licenses/postgis/COPYING"),
            "unexpected missing legal leaf error: {error}"
        );

        let extra = temp.join("extra");
        write_profiled_extension_artifact(
            &extra,
            "cube",
            "cube",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ContribNative,
            &[],
        );
        write_file(
            &extra.join("THIRD_PARTY_LICENSES/undeclared.txt"),
            b"undeclared\n",
        );
        let error = load_prebuilt_extension_artifact(&extra).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("undeclared: THIRD_PARTY_LICENSES/undeclared.txt"),
            "unexpected extra legal leaf error: {error}"
        );

        let unsafe_path = temp.join("unsafe");
        write_profiled_extension_artifact(
            &unsafe_path,
            "postgis",
            "postgis-3",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ExternalNative,
            &["share/licenses/postgis/COPYING"],
        );
        let manifest = unsafe_path.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap().replace(
            "licenseFiles=share/licenses/postgis/COPYING\n",
            "licenseFiles=../outside-license\n",
        );
        fs::write(&manifest, text).unwrap();
        let error = load_prebuilt_extension_artifact(&unsafe_path).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("contains path component \"..\" that is unsafe on supported build hosts"),
            "unexpected unsafe legal path error: {error}"
        );

        let wrong_profile = temp.join("wrong-profile");
        write_profiled_extension_artifact(
            &wrong_profile,
            "cube",
            "cube",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ContribNative,
            &[],
        );
        let manifest = wrong_profile.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap().replace(
            "licenseProfile=contrib-native\n",
            "licenseProfile=external-native\n",
        );
        fs::write(&manifest, text).unwrap();
        let error = load_prebuilt_extension_artifact(&wrong_profile).unwrap_err();
        assert!(
            error.to_string().contains("expected 'contrib-native'"),
            "unexpected wrong legal profile error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn prebuilt_extension_rejects_noncanonical_legal_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp = unique_temp_root("oliphaunt-extension-legal-mode");
        let artifact = temp.join("cube");
        write_profiled_extension_artifact(
            &artifact,
            "cube",
            "cube",
            "linux-x64-gnu",
            NativeExtensionArtifactLicenseProfile::ContribNative,
            &[],
        );
        fs::set_permissions(artifact.join("LICENSE"), fs::Permissions::from_mode(0o600)).unwrap();
        let error = load_prebuilt_extension_artifact(&artifact).unwrap_err();
        assert!(
            error.to_string().contains("LICENSE must have mode 0644"),
            "unexpected legal mode error: {error}"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_can_override_builtin_artifact_payload() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-override");
        let artifact = temp.join("vector");
        write_prebuilt_extension_artifact(
            &artifact,
            "vector",
            "vector",
            "oliphaunt_static_vector",
            "data/vector.rules",
            true,
        );

        let resolved = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].sql_name, "vector");
        assert!(matches!(
            resolved[0].source,
            RuntimeResourceExtensionSource::Prebuilt { .. }
        ));
        assert_eq!(resolved[0].mobile_static_archives.len(), 1);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prebuilt_extension_artifact_dependencies_must_be_available() {
        let temp = unique_temp_root("oliphaunt-prebuilt-extension-missing-dependency");
        let artifact = temp.join("acme_ext");
        write_prebuilt_extension_artifact(
            &artifact,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            true,
        );
        let manifest = artifact.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap();
        fs::write(
            &manifest,
            text.replace("dependencies=\n", "dependencies=missing_ext\n"),
        )
        .unwrap();

        let error = resolve_runtime_resource_extensions(
            &[],
            &[NativePrebuiltExtensionArtifact::new(&artifact)],
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(
                "selected extension 'missing_ext' is neither built into this Oliphaunt release nor provided as a prebuilt extension artifact"
            ),
            "unexpected missing-dependency error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn write_legal_fixture_file(path: &Path, contents: &[u8]) {
        write_file(path, contents);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o644))
                .expect("set canonical fixture legal mode");
        }
    }

    fn write_prebuilt_extension_artifact(
        root: &Path,
        sql_name: &str,
        module_stem: &str,
        static_symbol_prefix: &str,
        data_file: &str,
        mobile_prebuilt: bool,
    ) {
        write_prebuilt_extension_artifact_for_runtime(
            root,
            sql_name,
            module_stem,
            static_symbol_prefix,
            data_file,
            mobile_prebuilt,
            "1.2.3",
        );
    }

    fn write_prebuilt_extension_artifact_for_runtime(
        root: &Path,
        sql_name: &str,
        module_stem: &str,
        static_symbol_prefix: &str,
        data_file: &str,
        mobile_prebuilt: bool,
        native_runtime_version: &str,
    ) {
        let mobile_static_archives = if mobile_prebuilt {
            format!(
                "ios-simulator:mobile-static/ios-simulator/extensions/{module_stem}/liboliphaunt_extension_{module_stem}.a"
            )
        } else {
            String::new()
        };
        let mobile_static_dependency_archives = if mobile_prebuilt {
            "ios-simulator:openssl:mobile-static/ios-simulator/dependencies/openssl/libcrypto.a"
                .to_owned()
        } else {
            String::new()
        };
        write_file(
            &root.join("manifest.properties"),
            format!(
                "\
packageLayout=oliphaunt-extension-artifact-v1
pgMajor=18
sqlName={sql_name}
createsExtension=yes
nativeModuleStem={module_stem}
nativeModuleFile=
nativeTarget=test-target
nativeRuntimeProduct=liboliphaunt-native
nativeRuntimeVersion={native_runtime_version}
dependencies=
dataFiles={data_file}
extensionSqlFileNames=
extensionSqlFilePrefixes=
sharedPreloadLibraries=
mobilePrebuilt={}
mobileStaticArchives={mobile_static_archives}
mobileStaticDependencyArchives={mobile_static_dependency_archives}
staticSymbolPrefix={static_symbol_prefix}
staticSymbolAliases=
licenseFiles=share/licenses/{sql_name}/LICENSE
licenseProfile=external-native
files=files
",
                if mobile_prebuilt { "yes" } else { "no" }
            )
            .as_bytes(),
        );
        write_file(
            &root
                .join("files/share/postgresql/extension")
                .join(format!("{sql_name}.control")),
            b"comment = 'acme extension'\n",
        );
        write_file(
            &root
                .join("files/share/postgresql/extension")
                .join(format!("{sql_name}--1.0.sql")),
            b"CREATE FUNCTION acme_ext_echo(integer) RETURNS integer AS 'MODULE_PATHNAME' LANGUAGE C STRICT;\n",
        );
        write_file(
            &root.join("files/share/postgresql").join(data_file),
            b"acme-data\n",
        );
        write_legal_fixture_file(&root.join("LICENSE"), b"fixture Oliphaunt license\n");
        write_legal_fixture_file(
            &root.join("THIRD_PARTY_NOTICES.md"),
            b"fixture third-party notices\n",
        );
        write_legal_fixture_file(
            &root
                .join("files/share/licenses")
                .join(sql_name)
                .join("LICENSE"),
            b"fixture upstream license\n",
        );
        write_file(
            &root
                .join("files/lib/postgresql")
                .join(format!("{module_stem}{}", std::env::consts::DLL_SUFFIX)),
            b"acme-module\n",
        );
        write_file(
            &root
                .join("files/lib/modules")
                .join(format!("{module_stem}{}", std::env::consts::DLL_SUFFIX)),
            b"acme-embedded-module\n",
        );
        if mobile_prebuilt {
            write_file(
                &root
                    .join("mobile-static/ios-simulator/extensions")
                    .join(module_stem)
                    .join(format!("liboliphaunt_extension_{module_stem}.a")),
                b"acme-ios-simulator-static\n",
            );
            write_file(
                &root.join("mobile-static/ios-simulator/dependencies/openssl/libcrypto.a"),
                b"acme-ios-simulator-libcrypto\n",
            );
        }
    }

    fn write_profiled_extension_artifact(
        root: &Path,
        sql_name: &str,
        module_stem: &str,
        target: &str,
        profile: NativeExtensionArtifactLicenseProfile,
        license_files: &[&str],
    ) {
        let module_file = format!("{module_stem}.so");
        let license_value = license_files.join(",");
        write_file(
            &root.join("manifest.properties"),
            format!(
                "\
packageLayout=oliphaunt-extension-artifact-v1
pgMajor=18
sqlName={sql_name}
createsExtension=yes
nativeModuleStem={module_stem}
nativeModuleFile={module_file}
nativeTarget={target}
nativeRuntimeProduct=liboliphaunt-native
nativeRuntimeVersion=1.2.3
dependencies=
dataFiles=
extensionSqlFileNames=
extensionSqlFilePrefixes=
sharedPreloadLibraries=
mobilePrebuilt=no
mobileStaticArchives=
mobileStaticDependencyArchives=
staticSymbolPrefix=
staticSymbolAliases=
licenseFiles={license_value}
licenseProfile={}
files=files
",
                profile.as_str()
            )
            .as_bytes(),
        );
        write_legal_fixture_file(&root.join("LICENSE"), b"fixture Oliphaunt license\n");
        write_legal_fixture_file(
            &root.join("THIRD_PARTY_NOTICES.md"),
            b"fixture third-party notices\n",
        );
        if matches!(
            profile,
            NativeExtensionArtifactLicenseProfile::ContribNative
                | NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl
        ) {
            write_legal_fixture_file(
                &root.join(EXTENSION_ARTIFACT_POSTGRESQL_LICENSE),
                b"fixture PostgreSQL license\n",
            );
        }
        if profile == NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl {
            write_legal_fixture_file(
                &root.join(EXTENSION_ARTIFACT_OPENSSL_LICENSE),
                b"fixture OpenSSL license\n",
            );
        }
        for license in license_files {
            write_legal_fixture_file(
                &root.join("files").join(license),
                format!("fixture upstream license {license}\n").as_bytes(),
            );
        }
        write_file(
            &root
                .join("files/share/postgresql/extension")
                .join(format!("{sql_name}.control")),
            b"comment = 'profile fixture'\n",
        );
        write_file(
            &root
                .join("files/share/postgresql/extension")
                .join(format!("{sql_name}--1.0.sql")),
            b"SELECT 1;\n",
        );
        write_file(
            &root.join("files/lib/postgresql").join(&module_file),
            b"fixture server module\n",
        );
        write_file(
            &root.join("files/lib/modules").join(module_file),
            b"fixture embedded module\n",
        );
    }

    fn write_tar_archive_from_dir(archive_path: &Path, source: &Path, prefix: &str) {
        if let Some(parent) = archive_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let file = File::create(archive_path).unwrap();
        let mut archive = tar::Builder::new(file);
        archive.mode(tar::HeaderMode::Deterministic);
        archive.append_dir_all(prefix, source).unwrap();
        archive.finish().unwrap();
    }

    fn write_tar_archive_from_dir_with_top_level_sibling(
        archive_path: &Path,
        source: &Path,
        prefix: &str,
        sibling: &str,
        sibling_is_directory: bool,
    ) {
        if let Some(parent) = archive_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let file = File::create(archive_path).unwrap();
        let mut archive = tar::Builder::new(file);
        archive.append_dir_all(prefix, source).unwrap();
        let mut header = tar::Header::new_ustar();
        header.set_path(sibling).unwrap();
        header.set_mode(if sibling_is_directory { 0o755 } else { 0o644 });
        header.set_size(0);
        header.set_entry_type(if sibling_is_directory {
            EntryType::Directory
        } else {
            EntryType::Regular
        });
        header.set_cksum();
        archive.append(&header, io::empty()).unwrap();
        archive.finish().unwrap();
    }

    fn rewrite_tar_archive_member_mode(archive_path: &Path, member: &Path, mode: u32) {
        let source_path = archive_path.with_extension("original.tar");
        fs::rename(archive_path, &source_path).unwrap();
        let source_file = File::open(&source_path).unwrap();
        let mut source_archive = tar::Archive::new(source_file);
        let output_file = File::create(archive_path).unwrap();
        let mut output_archive = tar::Builder::new(output_file);
        let mut found = false;
        for entry in source_archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            let mut header = entry.header().clone();
            if header.entry_type().is_file() {
                header.set_mode(if path == member { mode } else { 0o644 });
                header.set_cksum();
                found |= path == member;
            }
            output_archive.append(&header, &mut entry).unwrap();
        }
        output_archive.finish().unwrap();
        assert!(
            found,
            "tar fixture is missing mode override member {}",
            member.display()
        );
        fs::remove_file(source_path).unwrap();
    }

    fn write_tar_zst_archive_from_dir(archive_path: &Path, source: &Path, prefix: &str) {
        let tar_path = archive_path.with_extension("tar");
        write_tar_archive_from_dir(&tar_path, source, prefix);
        let tar_bytes = fs::read(&tar_path).unwrap();
        let compressed = zstd::stream::encode_all(tar_bytes.as_slice(), 0).unwrap();
        write_file(archive_path, &compressed);
        let _ = fs::remove_file(tar_path);
    }

    fn runtime_resource_extensions(extensions: &[Extension]) -> Vec<RuntimeResourceExtension> {
        extensions
            .iter()
            .copied()
            .map(built_in_runtime_resource_extension)
            .collect()
    }

    fn unique_temp_root(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }
}
