use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::EngineMode;
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::extension::{
    extension_install_sql_file_belongs, extension_sql_file_belongs, extension_sql_file_names,
    extension_sql_file_prefixes,
};
use crate::liboliphaunt::{MaterializedNativeResources, materialize_native_resources_for_runtime};

mod extension_artifact;
mod extension_index;
mod manifest;
mod package;
mod static_registry;

pub use extension_artifact::create_prebuilt_extension_artifact;
use extension_artifact::*;
pub use extension_index::{
    create_prebuilt_extension_artifact_index, list_prebuilt_extension_artifact_index_catalog,
    resolve_prebuilt_extension_artifacts_from_indexes, sign_prebuilt_extension_artifact_index,
};
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
const EXTENSION_ARTIFACT_INDEX_LAYOUT: &str = "oliphaunt-extension-artifact-index-v1";
const EXTENSION_ARTIFACT_INDEX_SIGNATURE_LAYOUT: &str =
    "oliphaunt-extension-artifact-index-signature-v1";
const RUNTIME_FILES_LAYOUT: &str = "postgres-runtime-files-v1";
const TEMPLATE_PGDATA_LAYOUT: &str = "postgres-template-pgdata-v1";
const STATIC_REGISTRY_PACKAGE_LAYOUT: &str = "oliphaunt-static-registry-v1";
const STATIC_REGISTRY_SOURCE_FILE: &str = "oliphaunt_static_registry.c";
const STATIC_REGISTRY_SOURCE_MANIFEST_VALUE: &str = "static-registry/oliphaunt_static_registry.c";
// Resource-relative directory under the runtime path `static-registry/archives`.
const STATIC_REGISTRY_ARCHIVES_DIR: &str = "archives";

/// Options for building platform SDK runtime resources.
#[derive(Debug, Clone)]
pub struct NativeRuntimeResourceOptions {
    /// Directory that receives the generated `oliphaunt/...` resource tree.
    pub output_dir: PathBuf,
    /// Native engine mode whose runtime resources should be generated for.
    pub mode: EngineMode,
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
            mode: EngineMode::NativeDirect,
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

    /// Select the engine mode whose resources should be packaged.
    pub fn mode(mut self, mode: EngineMode) -> Self {
        self.mode = mode;
        self
    }

    /// Add one exact PostgreSQL extension to the runtime resources.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Add exact PostgreSQL extensions to the runtime resources.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Add one optional runtime feature to the resource bundle.
    pub fn runtime_feature(mut self, feature: NativeRuntimeFeature) -> Self {
        self.runtime_features.push(feature);
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

    /// Declare one native module stem as present in the platform static
    /// registry.
    pub fn mobile_static_module_stem(mut self, stem: impl Into<String>) -> Self {
        self.mobile_static_module_stems.push(stem.into());
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

    /// Add exact prebuilt extension artifact directories.
    pub fn prebuilt_extensions(mut self, roots: impl IntoIterator<Item = PathBuf>) -> Self {
        self.prebuilt_extensions
            .extend(roots.into_iter().map(NativePrebuiltExtensionArtifact::new));
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

/// One target-specific mobile static archive for an exact prebuilt extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionMobileStaticArchive {
    /// Mobile target key, for example `ios-simulator`, `ios-device`, or
    /// `arm64-v8a`.
    pub target: String,
    /// Already-built static archive file for the extension module.
    pub archive: PathBuf,
}

impl NativeExtensionMobileStaticArchive {
    /// Create a mobile static archive reference.
    pub fn new(target: impl Into<String>, archive: impl Into<PathBuf>) -> Self {
        Self {
            target: target.into(),
            archive: archive.into(),
        }
    }
}

/// One target-specific dependency archive needed by mobile static extension
/// archives in an exact prebuilt extension artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionMobileStaticDependencyArchive {
    /// Mobile target key, for example `ios-simulator`, `ios-device`, or
    /// `arm64-v8a`.
    pub target: String,
    /// Portable dependency name, for example `openssl`, `geos`, or `proj`.
    pub name: String,
    /// Already-built static archive file for this dependency.
    pub archive: PathBuf,
}

impl NativeExtensionMobileStaticDependencyArchive {
    /// Create a mobile static dependency archive reference.
    pub fn new(
        target: impl Into<String>,
        name: impl Into<String>,
        archive: impl Into<PathBuf>,
    ) -> Self {
        Self {
            target: target.into(),
            name: name.into(),
            archive: archive.into(),
        }
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

/// Output format for an exact prebuilt extension artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeExtensionArtifactFormat {
    /// Write an unpacked artifact directory.
    Directory,
    /// Write an uncompressed tar archive.
    Tar,
    /// Write a gzip-compressed tar archive.
    TarGz,
    /// Write a zstd-compressed tar archive.
    TarZst,
}

/// Legal payload profile carried by one native prebuilt extension artifact.
///
/// The profile determines the exact release-notice leaves at the artifact
/// root. External artifacts additionally declare their exact PostgreSQL-
/// relative upstream license paths through
/// [`NativeExtensionArtifactLegalContract::license_file`].
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

/// Exact legal source contract for a produced extension artifact.
///
/// `source_root` contains the profile's root notice files and every declared
/// PostgreSQL-relative upstream license file. For example, an external file
/// declared as `share/licenses/acme/LICENSE` is read from that path beneath
/// `source_root` and written beneath the artifact's `files/` tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactLegalContract {
    /// Payload-specific release-notice profile.
    pub profile: NativeExtensionArtifactLicenseProfile,
    /// Directory containing the exact legal source leaves.
    pub source_root: PathBuf,
    /// Sorted by the producer into exact PostgreSQL-relative license paths.
    pub license_files: Vec<PathBuf>,
}

impl NativeExtensionArtifactLegalContract {
    /// Create a legal contract with no external upstream license files.
    pub fn new(
        profile: NativeExtensionArtifactLicenseProfile,
        source_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            profile,
            source_root: source_root.into(),
            license_files: Vec::new(),
        }
    }

    /// Add one exact PostgreSQL-relative upstream license file.
    pub fn license_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.license_files.push(path.into());
        self
    }

    /// Add exact PostgreSQL-relative upstream license files.
    pub fn license_files(mut self, paths: impl IntoIterator<Item = PathBuf>) -> Self {
        self.license_files.extend(paths);
        self
    }
}

/// Options for creating one exact prebuilt extension artifact from built
/// PostgreSQL runtime files.
#[derive(Debug, Clone)]
pub struct NativeExtensionArtifactOptions {
    /// Artifact directory or archive path to write.
    pub output: PathBuf,
    /// Built PostgreSQL runtime root containing `share/postgresql` and
    /// `lib/postgresql`.
    pub runtime_files: PathBuf,
    /// Exact SQL extension name used by `CREATE EXTENSION`.
    pub sql_name: String,
    /// Exact stable `liboliphaunt-native` version this artifact was built for.
    pub native_runtime_version: String,
    /// Whether the artifact represents a SQL extension with control/SQL files.
    pub creates_extension: bool,
    /// Native module stem used by PostgreSQL extension SQL.
    pub native_module_stem: Option<String>,
    /// Target-specific native module filename under `lib/postgresql`.
    pub native_module_file: Option<String>,
    /// Public target id that produced the dynamic native module payload.
    pub native_target: Option<String>,
    /// Directory containing the native-direct module built for the same
    /// desktop target. Desktop artifacts carry this module under
    /// `files/lib/modules` alongside the server module under
    /// `files/lib/postgresql`.
    pub embedded_module_root: Option<PathBuf>,
    /// Exact extension dependencies.
    pub dependencies: Vec<String>,
    /// Additional files under `share/postgresql` required by the extension.
    pub data_files: Vec<PathBuf>,
    /// Exact ancillary SQL basenames under `share/postgresql/extension` that
    /// do not follow the extension's canonical install/update naming.
    pub extension_sql_file_names: Vec<String>,
    /// Exact ancillary SQL basename prefixes under
    /// `share/postgresql/extension`.
    pub extension_sql_file_prefixes: Vec<String>,
    /// PostgreSQL shared-preload libraries required when this extension is
    /// selected.
    pub shared_preload_libraries: Vec<String>,
    /// Whether matching iOS/Android static artifacts are available.
    pub mobile_prebuilt: bool,
    /// Target-specific mobile static archives carried by this artifact.
    pub mobile_static_archives: Vec<NativeExtensionMobileStaticArchive>,
    /// Target-specific static dependency archives needed by carried mobile
    /// extension archives.
    pub mobile_static_dependency_archives: Vec<NativeExtensionMobileStaticDependencyArchive>,
    /// Static registry C symbol prefix for mobile artifacts.
    pub static_symbol_prefix: Option<String>,
    /// SQL-visible to link-time C symbol aliases for mobile static artifacts.
    pub static_symbol_aliases: Vec<NativeExtensionStaticSymbolAlias>,
    /// Exact legal profile, source root, and upstream-license leaf inventory.
    ///
    /// Artifact creation fails closed when this is absent.
    pub legal_contract: Option<NativeExtensionArtifactLegalContract>,
    /// Artifact output format.
    pub format: NativeExtensionArtifactFormat,
    /// Replace an existing output path.
    pub replace_existing: bool,
}

impl NativeExtensionArtifactOptions {
    /// Create artifact options for one exact SQL extension.
    pub fn new(
        output: impl Into<PathBuf>,
        runtime_files: impl Into<PathBuf>,
        sql_name: impl Into<String>,
        native_runtime_version: impl Into<String>,
    ) -> Self {
        Self {
            output: output.into(),
            runtime_files: runtime_files.into(),
            sql_name: sql_name.into(),
            native_runtime_version: native_runtime_version.into(),
            creates_extension: true,
            native_module_stem: None,
            native_module_file: None,
            native_target: None,
            embedded_module_root: None,
            dependencies: Vec::new(),
            data_files: Vec::new(),
            extension_sql_file_names: Vec::new(),
            extension_sql_file_prefixes: Vec::new(),
            shared_preload_libraries: Vec::new(),
            mobile_prebuilt: false,
            mobile_static_archives: Vec::new(),
            mobile_static_dependency_archives: Vec::new(),
            static_symbol_prefix: None,
            static_symbol_aliases: Vec::new(),
            legal_contract: None,
            format: NativeExtensionArtifactFormat::Directory,
            replace_existing: false,
        }
    }

    /// Set whether control/SQL extension files are required.
    pub fn creates_extension(mut self, creates_extension: bool) -> Self {
        self.creates_extension = creates_extension;
        self
    }

    /// Set the native module stem.
    pub fn native_module_stem(mut self, stem: impl Into<String>) -> Self {
        self.native_module_stem = Some(stem.into());
        self
    }

    /// Set the target-specific native module filename under `lib/postgresql`.
    pub fn native_module_file(mut self, file_name: impl Into<String>) -> Self {
        self.native_module_file = Some(file_name.into());
        self
    }

    /// Set the public target id that produced the dynamic native module.
    pub fn native_target(mut self, target: impl Into<String>) -> Self {
        self.native_target = Some(target.into());
        self
    }

    /// Set the directory containing the native-direct desktop module.
    pub fn embedded_module_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.embedded_module_root = Some(root.into());
        self
    }

    /// Add one exact dependency.
    pub fn dependency(mut self, dependency: impl Into<String>) -> Self {
        self.dependencies.push(dependency.into());
        self
    }

    /// Add exact dependencies.
    pub fn dependencies(mut self, dependencies: impl IntoIterator<Item = String>) -> Self {
        self.dependencies.extend(dependencies);
        self
    }

    /// Add one data file path relative to `share/postgresql`.
    pub fn data_file(mut self, data_file: impl Into<PathBuf>) -> Self {
        self.data_files.push(data_file.into());
        self
    }

    /// Add data file paths relative to `share/postgresql`.
    pub fn data_files(mut self, data_files: impl IntoIterator<Item = PathBuf>) -> Self {
        self.data_files.extend(data_files);
        self
    }

    /// Add one exact ancillary SQL basename.
    pub fn extension_sql_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.extension_sql_file_names.push(file_name.into());
        self
    }

    /// Add exact ancillary SQL basenames.
    pub fn extension_sql_file_names(
        mut self,
        file_names: impl IntoIterator<Item = String>,
    ) -> Self {
        self.extension_sql_file_names.extend(file_names);
        self
    }

    /// Add one exact ancillary SQL basename prefix.
    pub fn extension_sql_file_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.extension_sql_file_prefixes.push(prefix.into());
        self
    }

    /// Add exact ancillary SQL basename prefixes.
    pub fn extension_sql_file_prefixes(
        mut self,
        prefixes: impl IntoIterator<Item = String>,
    ) -> Self {
        self.extension_sql_file_prefixes.extend(prefixes);
        self
    }

    /// Add one required shared-preload library.
    pub fn shared_preload_library(mut self, library: impl Into<String>) -> Self {
        self.shared_preload_libraries.push(library.into());
        self
    }

    /// Add required shared-preload libraries.
    pub fn shared_preload_libraries(mut self, libraries: impl IntoIterator<Item = String>) -> Self {
        self.shared_preload_libraries.extend(libraries);
        self
    }

    /// Mark whether matching mobile static artifacts exist.
    pub fn mobile_prebuilt(mut self, mobile_prebuilt: bool) -> Self {
        self.mobile_prebuilt = mobile_prebuilt;
        self
    }

    /// Add one target-specific mobile static archive.
    pub fn mobile_static_archive(
        mut self,
        target: impl Into<String>,
        archive: impl Into<PathBuf>,
    ) -> Self {
        self.mobile_static_archives
            .push(NativeExtensionMobileStaticArchive::new(target, archive));
        self.mobile_prebuilt = true;
        self
    }

    /// Add target-specific mobile static archives.
    pub fn mobile_static_archives(
        mut self,
        archives: impl IntoIterator<Item = NativeExtensionMobileStaticArchive>,
    ) -> Self {
        let mut any = false;
        for archive in archives {
            any = true;
            self.mobile_static_archives.push(archive);
        }
        if any {
            self.mobile_prebuilt = true;
        }
        self
    }

    /// Add one target-specific mobile static dependency archive.
    pub fn mobile_static_dependency_archive(
        mut self,
        target: impl Into<String>,
        name: impl Into<String>,
        archive: impl Into<PathBuf>,
    ) -> Self {
        self.mobile_static_dependency_archives.push(
            NativeExtensionMobileStaticDependencyArchive::new(target, name, archive),
        );
        self
    }

    /// Add target-specific mobile static dependency archives.
    pub fn mobile_static_dependency_archives(
        mut self,
        archives: impl IntoIterator<Item = NativeExtensionMobileStaticDependencyArchive>,
    ) -> Self {
        self.mobile_static_dependency_archives.extend(archives);
        self
    }

    /// Set the generated mobile static registry symbol prefix.
    pub fn static_symbol_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.static_symbol_prefix = Some(prefix.into());
        self
    }

    /// Add one static-registry symbol alias.
    pub fn static_symbol_alias(
        mut self,
        sql_symbol: impl Into<String>,
        linked_symbol: impl Into<String>,
    ) -> Self {
        self.static_symbol_aliases
            .push(NativeExtensionStaticSymbolAlias::new(
                sql_symbol,
                linked_symbol,
            ));
        self
    }

    /// Add static-registry symbol aliases.
    pub fn static_symbol_aliases(
        mut self,
        aliases: impl IntoIterator<Item = NativeExtensionStaticSymbolAlias>,
    ) -> Self {
        self.static_symbol_aliases.extend(aliases);
        self
    }

    /// Set the exact legal payload contract for this artifact.
    pub fn legal_contract(mut self, contract: NativeExtensionArtifactLegalContract) -> Self {
        self.legal_contract = Some(contract);
        self
    }

    /// Select the artifact output format.
    pub fn format(mut self, format: NativeExtensionArtifactFormat) -> Self {
        self.format = format;
        self
    }

    /// Allow replacement of an existing artifact path.
    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }
}

/// Prebuilt extension artifact created by the Rust SDK tooling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifact {
    /// Artifact directory or archive path.
    pub path: PathBuf,
    /// Manifest path when the artifact is an unpacked directory.
    pub manifest_path: Option<PathBuf>,
    /// Exact SQL extension name.
    pub sql_name: String,
    /// Exact legal payload profile recorded in the manifest.
    pub license_profile: NativeExtensionArtifactLicenseProfile,
    /// Exact PostgreSQL-relative upstream license paths carried under `files/`.
    pub license_files: Vec<PathBuf>,
    /// Artifact output format.
    pub format: NativeExtensionArtifactFormat,
}

/// Options for resolving exact prebuilt extension artifacts from release
/// indexes.
#[derive(Debug, Clone)]
pub struct NativeExtensionArtifactIndexOptions {
    /// Index TOML files to read. Later indexes may not redefine the same
    /// `(target, sql_name)` pair.
    pub indexes: Vec<PathBuf>,
    /// Target artifact key, such as `aarch64-apple-darwin`.
    pub target: String,
    /// Exact SQL extension names to resolve from indexes. Dependencies are
    /// resolved transitively.
    pub extensions: Vec<String>,
    /// Optional cache directory for URL-backed artifact rows. Local sidecar
    /// artifacts next to an index are preferred; missing URL-backed artifacts
    /// are downloaded here and then verified before use.
    pub artifact_cache_dir: Option<PathBuf>,
    /// Trusted publisher keys for signed artifact indexes.
    pub trusted_signing_keys: Vec<NativeExtensionArtifactIndexTrustRoot>,
    /// Require every artifact index to have a valid sidecar signature.
    pub require_signatures: bool,
}

impl NativeExtensionArtifactIndexOptions {
    /// Create artifact-index resolution options for one target.
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            indexes: Vec::new(),
            target: target.into(),
            extensions: Vec::new(),
            artifact_cache_dir: None,
            trusted_signing_keys: Vec::new(),
            require_signatures: false,
        }
    }

    /// Add one index file.
    pub fn index(mut self, index: impl Into<PathBuf>) -> Self {
        self.indexes.push(index.into());
        self
    }

    /// Add index files.
    pub fn indexes(mut self, indexes: impl IntoIterator<Item = PathBuf>) -> Self {
        self.indexes.extend(indexes);
        self
    }

    /// Select one exact SQL extension name.
    pub fn extension(mut self, extension: impl Into<String>) -> Self {
        self.extensions.push(extension.into());
        self
    }

    /// Select exact SQL extension names.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = String>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Cache directory for URL-backed artifact index rows.
    pub fn artifact_cache_dir(mut self, cache_dir: impl Into<PathBuf>) -> Self {
        self.artifact_cache_dir = Some(cache_dir.into());
        self
    }

    /// Set an optional cache directory for URL-backed artifact index rows.
    pub fn maybe_artifact_cache_dir(mut self, cache_dir: Option<PathBuf>) -> Self {
        self.artifact_cache_dir = cache_dir;
        self
    }

    /// Trust one Ed25519 publisher key for artifact index signatures.
    pub fn trusted_signing_key(mut self, key: NativeExtensionArtifactIndexTrustRoot) -> Self {
        self.trusted_signing_keys.push(key);
        self
    }

    /// Trust Ed25519 publisher keys for artifact index signatures.
    pub fn trusted_signing_keys(
        mut self,
        keys: impl IntoIterator<Item = NativeExtensionArtifactIndexTrustRoot>,
    ) -> Self {
        self.trusted_signing_keys.extend(keys);
        self
    }

    /// Require signed artifact indexes.
    pub fn require_signatures(mut self, required: bool) -> Self {
        self.require_signatures = required;
        self
    }
}

/// Resolution result for exact extension artifact indexes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexResolution {
    /// Verified artifact paths in dependency order.
    pub artifacts: Vec<NativePrebuiltExtensionArtifact>,
    /// Exact external extension names resolved from indexes.
    pub extension_names: Vec<String>,
}

/// Catalog entries advertised by exact prebuilt extension artifact indexes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexCatalog {
    /// Exact external extension rows available for the selected target.
    pub extensions: Vec<NativeExtensionArtifactIndexCatalogEntry>,
}

/// One exact external extension advertised by an artifact index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexCatalogEntry {
    /// Exact SQL extension name.
    pub sql_name: String,
    /// Target artifact key.
    pub target: String,
    /// Whether `CREATE EXTENSION` control/SQL files are present.
    pub creates_extension: bool,
    /// Native module stem required by the extension, if any.
    pub native_module_stem: Option<String>,
    /// Exact extension dependencies advertised by the index.
    pub dependencies: Vec<String>,
    /// Required `shared_preload_libraries` entries advertised by the index.
    pub shared_preload_libraries: Vec<String>,
    /// Whether iOS/Android app bundles can consume this artifact without
    /// building extension source.
    pub mobile_prebuilt: bool,
    /// Mobile targets whose static archives are carried by the artifact.
    pub mobile_static_archive_targets: Vec<String>,
    /// Optional artifact URL advertised by the index.
    pub url: Option<String>,
}

/// Options for creating an exact prebuilt extension artifact index.
#[derive(Debug, Clone)]
pub struct NativeExtensionArtifactIndexCreateOptions {
    /// Index TOML path to write.
    pub output: PathBuf,
    /// Target artifact key shared by every indexed artifact.
    pub target: String,
    /// Archive artifact files to index.
    pub artifacts: Vec<PathBuf>,
    /// Optional HTTPS base URL used to publish each relative artifact path.
    pub artifact_base_url: Option<String>,
    /// Replace an existing output path.
    pub replace_existing: bool,
}

/// Trusted Ed25519 publisher key for exact extension artifact indexes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexTrustRoot {
    /// Stable publisher key identifier.
    pub key_id: String,
    /// Hex-encoded 32-byte Ed25519 public key.
    pub public_key_hex: String,
}

impl NativeExtensionArtifactIndexTrustRoot {
    /// Create a trusted artifact-index publisher key.
    pub fn new(key_id: impl Into<String>, public_key_hex: impl Into<String>) -> Self {
        Self {
            key_id: key_id.into(),
            public_key_hex: public_key_hex.into(),
        }
    }
}

/// Options for signing one exact extension artifact index.
#[derive(Debug, Clone)]
pub struct NativeExtensionArtifactIndexSigningOptions {
    /// Index TOML path whose exact bytes will be signed.
    pub index: PathBuf,
    /// Stable publisher key identifier.
    pub key_id: String,
    /// Hex-encoded 32-byte Ed25519 signing key.
    pub signing_key_hex: String,
    /// Detached signature path. Defaults to `<index>.sig`.
    pub signature_path: Option<PathBuf>,
    /// Replace an existing signature file.
    pub replace_existing: bool,
}

impl NativeExtensionArtifactIndexSigningOptions {
    /// Create signing options for one artifact index.
    pub fn new(
        index: impl Into<PathBuf>,
        key_id: impl Into<String>,
        signing_key_hex: impl Into<String>,
    ) -> Self {
        Self {
            index: index.into(),
            key_id: key_id.into(),
            signing_key_hex: signing_key_hex.into(),
            signature_path: None,
            replace_existing: false,
        }
    }

    /// Write the detached signature to a specific path.
    pub fn signature_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.signature_path = Some(path.into());
        self
    }

    /// Set an optional detached signature path.
    pub fn maybe_signature_path(mut self, path: Option<PathBuf>) -> Self {
        self.signature_path = path;
        self
    }

    /// Allow replacement of an existing detached signature file.
    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }
}

/// Detached signature created for one exact extension artifact index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexSignature {
    /// Signature sidecar path.
    pub path: PathBuf,
    /// Signed artifact index path.
    pub index: PathBuf,
    /// Stable publisher key identifier.
    pub key_id: String,
    /// Hex-encoded Ed25519 public key derived from the signing key.
    pub public_key_hex: String,
    /// Hex-encoded Ed25519 signature.
    pub signature_hex: String,
}

impl NativeExtensionArtifactIndexCreateOptions {
    /// Create options for one target artifact index.
    pub fn new(output: impl Into<PathBuf>, target: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            target: target.into(),
            artifacts: Vec::new(),
            artifact_base_url: None,
            replace_existing: false,
        }
    }

    /// Add one artifact archive file.
    pub fn artifact(mut self, artifact: impl Into<PathBuf>) -> Self {
        self.artifacts.push(artifact.into());
        self
    }

    /// Add artifact archive files.
    pub fn artifacts(mut self, artifacts: impl IntoIterator<Item = PathBuf>) -> Self {
        self.artifacts.extend(artifacts);
        self
    }

    /// Set an HTTPS base URL for artifact rows in the generated index.
    pub fn artifact_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.artifact_base_url = Some(base_url.into());
        self
    }

    /// Set an optional base URL for artifact rows in the generated index.
    pub fn maybe_artifact_base_url(mut self, base_url: Option<String>) -> Self {
        self.artifact_base_url = base_url;
        self
    }

    /// Allow replacement of an existing index path.
    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }
}

/// Exact prebuilt extension artifact index created by the Rust SDK tooling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndex {
    /// Index TOML path.
    pub path: PathBuf,
    /// Target artifact key.
    pub target: String,
    /// Indexed artifacts.
    pub artifacts: Vec<NativeExtensionArtifactIndexArtifact>,
}

/// One artifact row in an exact prebuilt extension artifact index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeExtensionArtifactIndexArtifact {
    /// Exact SQL extension name.
    pub sql_name: String,
    /// Target artifact key.
    pub target: String,
    /// Whether `CREATE EXTENSION` control/SQL files are present.
    pub creates_extension: bool,
    /// Native module stem required by the extension, if any.
    pub native_module_stem: Option<String>,
    /// Exact extension dependencies.
    pub dependencies: Vec<String>,
    /// Required `shared_preload_libraries` entries.
    pub shared_preload_libraries: Vec<String>,
    /// Whether iOS/Android app bundles can consume this artifact without
    /// building extension source.
    pub mobile_prebuilt: bool,
    /// Mobile targets whose static archives are carried by the artifact.
    pub mobile_static_archive_targets: Vec<String>,
    /// Relative artifact path recorded in the index.
    pub path: PathBuf,
    /// Optional HTTPS artifact URL recorded in the index.
    pub url: Option<String>,
    /// Hex-encoded SHA-256 digest of the artifact archive file.
    pub sha256: String,
    /// Artifact archive byte length.
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExtensionArtifactIndexEntry {
    index_path: PathBuf,
    sql_name: String,
    target: String,
    creates_extension: bool,
    native_module_stem: Option<String>,
    dependencies: Vec<String>,
    shared_preload_libraries: Vec<String>,
    mobile_prebuilt: bool,
    mobile_static_archive_targets: Vec<String>,
    relative_path: PathBuf,
    path: PathBuf,
    url: Option<String>,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionArtifactIndexToml {
    schema: String,
    pg_major: u16,
    artifacts: Vec<ExtensionArtifactIndexEntryToml>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionArtifactIndexEntryToml {
    sql_name: String,
    target: String,
    #[serde(default = "default_true")]
    creates_extension: bool,
    native_module_stem: Option<String>,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    shared_preload_libraries: Vec<String>,
    #[serde(default)]
    mobile_prebuilt: bool,
    #[serde(default)]
    mobile_static_archive_targets: Vec<String>,
    path: String,
    url: Option<String>,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionArtifactIndexSignatureToml {
    schema: String,
    algorithm: String,
    key_id: String,
    public_key: Option<String>,
    signature: String,
}

fn default_true() -> bool {
    true
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
    /// Bytes in runtime, template, and static-registry resource trees. This
    /// intentionally excludes the report file itself to avoid circular output.
    pub package_bytes: u64,
    /// Bytes in `runtime/files`.
    pub runtime_bytes: u64,
    /// Bytes in `template-pgdata/files`.
    pub template_pgdata_bytes: u64,
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
    /// Root directory containing `runtime` and `template-pgdata` resources.
    pub root: PathBuf,
    /// Runtime files directory copied into app storage before opening.
    pub runtime_files: PathBuf,
    /// Template PGDATA files directory copied for first open on mobile.
    pub template_pgdata_files: PathBuf,
    /// Content key of the source runtime cache.
    pub runtime_cache_key: String,
    /// Content key of the source template PGDATA cache.
    pub template_cache_key: String,
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

/// Build the portable runtime-resource layout produced by the Rust SDK and used
/// by the platform SDKs.
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
    let materialized = materialize_native_resources_for_runtime(options.mode, &extensions)?;
    let root = options.output_dir.join("oliphaunt");
    prepare_output_root(&root, options.replace_existing)?;

    write_runtime_resource_tree(
        &root,
        options.mode,
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
        template_pgdata_files: root.join("template-pgdata/files"),
        static_registry_manifest: root.join("static-registry/manifest.properties"),
        static_registry_source: (mobile_static_registry.state
            == MobileStaticRegistryState::Complete)
            .then(|| root.join(format!("static-registry/{STATIC_REGISTRY_SOURCE_FILE}"))),
        root,
        runtime_cache_key: materialized.runtime_cache_key,
        template_cache_key: materialized.template_cache_key,
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
        let Some(extension) = Extension::by_release_ready_sql_name(sql_name) else {
            return Err(Error::InvalidConfig(format!(
                "selected extension '{sql_name}' is neither built into this Oliphaunt release nor provided as a prebuilt extension artifact"
            )));
        };
        let selected_extension = built_in_runtime_resource_extension(extension);
        (
            selected_extension,
            extension
                .dependencies()
                .iter()
                .map(|dependency| dependency.sql_name().to_owned())
                .collect::<Vec<_>>(),
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
    RuntimeResourceExtension {
        sql_name: extension.sql_name().to_owned(),
        native_runtime_version: None,
        creates_extension: extension.creates_extension(),
        native_module_stem: extension.native_module_stem().map(str::to_owned),
        native_module_file: extension.native_module_file(),
        native_target: None,
        dependencies: extension
            .dependencies()
            .iter()
            .map(|dependency| dependency.sql_name().to_owned())
            .collect(),
        data_files: extension_data_paths(extension),
        extension_sql_file_names: extension_sql_file_names(extension)
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        extension_sql_file_prefixes: extension_sql_file_prefixes(extension)
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        shared_preload_libraries: extension
            .required_shared_preload_library()
            .map(|library| vec![library.to_owned()])
            .unwrap_or_default(),
        mobile_prebuilt: extension.mobile_release_ready(),
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

fn mobile_static_archive_targets(archives: &[MobileStaticArchive]) -> Vec<String> {
    archives
        .iter()
        .map(|archive| archive.target.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn extension_data_paths(extension: Extension) -> Vec<PathBuf> {
    crate::extension::extension_data_files(extension)
        .iter()
        .map(PathBuf::from)
        .collect()
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
    #[cfg(feature = "extension-signing")]
    use super::extension_index::hex_bytes;
    use super::*;
    use crate::extension::resolve_extension_selection;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tar::EntryType;

    #[test]
    fn mobile_static_registry_metadata_marks_sql_only_packages_not_required() {
        let extensions = runtime_resource_extensions(&[Extension::Pgtap]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::NotRequired);
        assert!(metadata.registered_extensions.is_empty());
        assert!(metadata.pending_extensions.is_empty());
        assert!(metadata.native_module_stems.is_empty());
    }

    #[test]
    fn mobile_static_registry_metadata_marks_module_extensions_pending() {
        let extensions = runtime_resource_extensions(&[Extension::Vector]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Pending);
        assert_eq!(metadata.pending_extensions, vec!["vector"]);
        assert_eq!(metadata.native_module_stems, vec!["vector"]);
        assert!(metadata.registered_extensions.is_empty());
    }

    #[test]
    fn mobile_static_registry_requirement_rejects_pending_modules() {
        let extensions = runtime_resource_extensions(&[Extension::Vector]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let error = require_mobile_static_registry_ready(&metadata).unwrap_err();
        assert_eq!(
            error,
            Error::InvalidConfig(
                "selected extension(s) require mobile static registry entries before iOS/Android packaging: vector"
                    .to_owned()
            )
        );
    }

    #[test]
    fn mobile_static_registry_metadata_marks_declared_modules_complete() {
        let extensions = runtime_resource_extensions(&[Extension::Vector]);
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
        let extensions = runtime_resource_extensions(&[Extension::Hstore]);
        let metadata =
            mobile_static_registry_metadata(&extensions, &["hstore".to_owned()]).unwrap();
        assert_eq!(metadata.state, MobileStaticRegistryState::Complete);
        assert_eq!(metadata.registered_extensions, vec!["hstore"]);
        assert!(metadata.pending_extensions.is_empty());
        assert_eq!(metadata.native_module_stems, vec!["hstore"]);
        require_mobile_static_registry_ready(&metadata).unwrap();
    }

    #[test]
    fn mobile_static_registry_metadata_rejects_unavailable_mobile_artifacts() {
        let extensions = runtime_resource_extensions(&[Extension::Graph]);
        let error =
            mobile_static_registry_metadata(&extensions, &["graph".to_owned()]).unwrap_err();
        assert_eq!(
            error,
            Error::InvalidConfig(
                "selected extension 'graph' does not have release-ready iOS/Android static artifacts; app bundles cannot mark module stem 'graph' complete without a prebuilt mobile artifact"
                    .to_owned()
            )
        );
    }

    #[test]
    fn mobile_static_registry_metadata_rejects_unknown_registered_modules() {
        let extensions = runtime_resource_extensions(&[Extension::Vector]);
        let error =
            mobile_static_registry_metadata(&extensions, &["hstore".to_owned()]).unwrap_err();
        assert_eq!(
            error,
            Error::InvalidConfig(
                "mobile static registry module stem(s) were not selected by these runtime resources: hstore"
                    .to_owned()
            )
        );
    }

    #[test]
    fn manifest_records_mobile_static_registry_metadata() {
        let extensions = runtime_resource_extensions(&[Extension::Vector]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            mode: EngineMode::NativeDirect,
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
    }

    #[test]
    fn manifest_records_required_shared_preload_libraries() {
        let extensions = runtime_resource_extensions(&[Extension::PgSearch, Extension::PgSearch]);
        let preload = shared_preload_libraries(&extensions);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            mode: EngineMode::NativeDirect,
            extensions: &extensions,
            runtime_features: &[],
            shared_preload_libraries: &preload,
            mobile_static_registry: &metadata,
        };
        let text = manifest_text(&manifest);
        assert!(text.contains("selectedExtensions=pg_search\n"));
        assert!(text.contains("extensions=pg_search\n"));
        assert!(text.contains("sharedPreloadLibraries=pg_search\n"));
    }

    #[test]
    fn manifest_separates_selected_and_createable_extension_domains() {
        let extensions = runtime_resource_extensions(&[Extension::Hstore, Extension::AutoExplain]);
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        let manifest = RuntimeResourceManifest {
            cache_key: "runtime-domain-smoke",
            layout: RUNTIME_FILES_LAYOUT,
            mode: EngineMode::NativeDirect,
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
            template_pgdata: temp.join("materialized/template-pgdata"),
            runtime_cache_key: "runtime-icu".to_owned(),
            template_cache_key: "template".to_owned(),
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
        write_file(&materialized.template_pgdata.join("PG_VERSION"), b"18\n");
        fs::create_dir_all(&root).unwrap();

        let metadata = mobile_static_registry_metadata(&[], &[]).unwrap();
        write_runtime_resource_tree(
            &root,
            EngineMode::NativeDirect,
            &materialized,
            &[],
            &[],
            &[],
            &metadata,
            None,
        )
        .unwrap();

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
            template_pgdata: temp.join("materialized/template-pgdata"),
            runtime_cache_key: "runtime-icu".to_owned(),
            template_cache_key: "template".to_owned(),
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
        write_file(&materialized.template_pgdata.join("PG_VERSION"), b"18\n");
        fs::create_dir_all(&root).unwrap();

        let metadata = mobile_static_registry_metadata(&[], &[]).unwrap();
        write_runtime_resource_tree(
            &root,
            EngineMode::NativeDirect,
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
        write_file(&root.join("template-pgdata/files/PG_VERSION"), b"18\n");
        write_file(
            &root.join("static-registry/manifest.properties"),
            b"state=pending\n",
        );

        let selected_extensions = runtime_resource_extensions(
            &resolve_extension_selection(&[Extension::Vector]).unwrap(),
        );
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
        write_file(&root.join("template-pgdata/files/PG_VERSION"), b"18\n");
        write_file(
            &root.join("static-registry/manifest.properties"),
            b"state=pending\n",
        );

        let selected_extensions = runtime_resource_extensions(
            &resolve_extension_selection(&[Extension::Unaccent]).unwrap(),
        );
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
        write_file(&temp.join("template-pgdata/files/PG_VERSION"), b"18\n");
        let pending_metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        copy_prebuilt_extension_artifacts(
            &runtime_files,
            &extensions,
            EngineMode::NativeServer,
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
        copy_portable_tree(
            &temp.join("template-pgdata"),
            &temp.join("oliphaunt/template-pgdata"),
        )
        .unwrap();
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
        let server_runtime = temp.join("server-runtime");
        let direct_runtime = temp.join("direct-runtime");
        let broker_runtime = temp.join("broker-runtime");

        copy_prebuilt_extension_artifacts(
            &server_runtime,
            &extensions,
            EngineMode::NativeServer,
            Some("test-target"),
            &metadata,
        )
        .unwrap();
        copy_prebuilt_extension_artifacts(
            &direct_runtime,
            &extensions,
            EngineMode::NativeDirect,
            Some("test-target"),
            &metadata,
        )
        .unwrap();
        copy_prebuilt_extension_artifacts(
            &broker_runtime,
            &extensions,
            EngineMode::NativeBroker,
            Some("test-target"),
            &metadata,
        )
        .unwrap();

        assert_eq!(
            fs::read(server_runtime.join("lib/postgresql").join(&module)).unwrap(),
            b"acme-module\n"
        );
        assert_eq!(
            fs::read(direct_runtime.join("lib/postgresql").join(&module)).unwrap(),
            b"acme-embedded-module\n"
        );
        assert_eq!(
            fs::read(broker_runtime.join("lib/postgresql").join(&module)).unwrap(),
            b"acme-embedded-module\n"
        );

        fs::remove_file(artifact.join("files/lib/modules").join(&module)).unwrap();
        let error = copy_prebuilt_extension_artifacts(
            &temp.join("missing-direct-runtime"),
            &extensions,
            EngineMode::NativeDirect,
            Some("test-target"),
            &metadata,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&format!("files/lib/modules/{module}")),
            "unexpected missing native-direct profile error: {error}"
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
            EngineMode::NativeDirect,
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
        write_file(&root.join("template-pgdata/files/PG_VERSION"), b"18\n");
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
        let template_pgdata = temp.join("template-pgdata");
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
        write_file(&template_pgdata.join("PG_VERSION"), b"18\n");

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
            EngineMode::NativeServer,
            &MaterializedNativeResources {
                runtime_dir: base_runtime,
                template_pgdata,
                runtime_cache_key: "runtime-cache".to_owned(),
                template_cache_key: "template-cache".to_owned(),
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
                .prebuilt_extensions(vec![first, second])
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
            EngineMode::NativeServer,
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
    fn prebuilt_extension_tar_zst_archive_is_validated_and_consumed() {
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
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact, "acme_ext");

        let prepared =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &archive,
            )])
            .unwrap();
        let extensions = resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
        assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);

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
    fn extension_artifact_archive_policy_covers_observed_android_postgis_shape() {
        let policy = extension_artifact_archive_policy().unwrap();
        assert_eq!(policy.max_compressed_bytes, 128 * 1024 * 1024);
        assert_eq!(policy.max_expanded_bytes, 512 * 1024 * 1024);
        assert_eq!(policy.max_member_bytes, 256 * 1024 * 1024);
        assert_eq!(policy.max_members, 4096);

        // Exact high-water marks from the qualified Android ARM64 PostGIS leaf
        // artifact that exposed the former 48/256 MiB consumer-only limits.
        assert!(64_676_748 <= policy.max_compressed_bytes);
        assert!(345_621_694 <= policy.max_expanded_bytes);
        assert!(154_827_564 <= policy.max_member_bytes);
        assert!(27 <= policy.max_members);

        let root = Path::new("android-arm64-v8a/postgis");
        let mut shape = ExtensionArtifactArchiveShape {
            member_count: 0,
            expanded_bytes: 1024,
        };
        let mut observed_member_sizes = vec![154_827_564, 110_259_522, 80_534_608];
        observed_member_sizes.resize(27, 0);
        for (index, bytes) in observed_member_sizes.into_iter().enumerate() {
            record_extension_artifact_archive_member(
                root,
                Path::new(&format!("member-{index}.bin")),
                bytes,
                policy,
                &mut shape,
            )
            .unwrap();
        }
        assert_eq!(shape.member_count, 27);
        assert!(shape.expanded_bytes <= policy.max_expanded_bytes);

        let error = record_extension_artifact_archive_member(
            root,
            Path::new("too-large.bin"),
            policy.max_member_bytes + 1,
            policy,
            &mut ExtensionArtifactArchiveShape {
                member_count: 0,
                expanded_bytes: 1024,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("exceeds 268435456 bytes"));
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
    fn create_prebuilt_extension_artifact_copies_only_exact_declared_runtime_files() {
        let temp = unique_temp_root("oliphaunt-create-prebuilt-extension-artifact");
        let runtime = temp.join("runtime");
        write_extension_source_runtime(&runtime, "acme_ext", "acme_ext.so");
        write_file(
            &runtime.join("share/postgresql/extension/hstore.control"),
            b"comment = 'should not leak'\n",
        );
        write_file(
            &runtime.join("share/postgresql/extension/uninstall_acme_ext.sql"),
            b"-- carrier-declared ancillary SQL\n",
        );
        write_file(
            &runtime.join("share/postgresql/extension/acme_aux--1.0.sql"),
            b"-- carrier-declared ancillary SQL family\n",
        );
        write_file(
            &runtime.join("share/postgresql/data/unused.rules"),
            b"unused\n",
        );
        let ios_archive = temp.join("liboliphaunt_extension_acme_ext_ios_simulator.a");
        write_file(&ios_archive, b"acme-ios-simulator-static\n");
        let ios_dependency_archive = temp.join("libcrypto.a");
        write_file(&ios_dependency_archive, b"acme-ios-simulator-libcrypto\n");
        let artifact_root = temp.join("artifact");

        let created = create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(&artifact_root, &runtime, "acme_ext", "1.2.3")
                .native_module_stem("acme_ext")
                .native_module_file("acme_ext.so")
                .native_target("test-target")
                .dependency("cube")
                .data_file("data/acme_ext.rules")
                .extension_sql_file_name("uninstall_acme_ext.sql")
                .extension_sql_file_prefix("acme_aux--")
                .shared_preload_library("acme_preload")
                .mobile_prebuilt(true)
                .mobile_static_archive("ios-simulator", &ios_archive)
                .mobile_static_dependency_archive(
                    "ios-simulator",
                    "openssl",
                    &ios_dependency_archive,
                )
                .static_symbol_prefix("acme_static")
                .legal_contract(write_external_legal_contract(&temp, "acme_ext")),
        )
        .unwrap();

        assert_eq!(created.path, artifact_root);
        assert_eq!(created.sql_name, "acme_ext");
        assert_eq!(
            created.license_profile,
            NativeExtensionArtifactLicenseProfile::ExternalNative
        );
        assert_eq!(
            created.license_files,
            vec![PathBuf::from("share/licenses/acme_ext/LICENSE")]
        );
        assert_eq!(created.format, NativeExtensionArtifactFormat::Directory);
        assert!(created.manifest_path.unwrap().is_file());
        let manifest = fs::read_to_string(artifact_root.join("manifest.properties")).unwrap();
        assert!(manifest.contains("packageLayout=oliphaunt-extension-artifact-v1\n"));
        assert!(manifest.contains("sqlName=acme_ext\n"));
        assert!(manifest.contains("nativeModuleStem=acme_ext\n"));
        assert!(manifest.contains("nativeModuleFile=acme_ext.so\n"));
        assert!(manifest.contains("nativeTarget=test-target\n"));
        assert!(manifest.contains("nativeRuntimeProduct=liboliphaunt-native\n"));
        assert!(manifest.contains("nativeRuntimeVersion=1.2.3\n"));
        assert!(manifest.contains("dependencies=cube\n"));
        assert!(manifest.contains("dataFiles=data/acme_ext.rules\n"));
        assert!(manifest.contains("extensionSqlFileNames=uninstall_acme_ext.sql\n"));
        assert!(manifest.contains("extensionSqlFilePrefixes=acme_aux--\n"));
        assert!(manifest.contains("sharedPreloadLibraries=acme_preload\n"));
        assert!(manifest.contains("mobilePrebuilt=yes\n"));
        assert!(manifest.contains(
            "mobileStaticArchives=ios-simulator:mobile-static/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a\n"
        ));
        assert!(manifest.contains(
            "mobileStaticDependencyArchives=ios-simulator:openssl:mobile-static/ios-simulator/dependencies/openssl/libcrypto.a\n"
        ));
        assert!(manifest.contains("staticSymbolPrefix=acme_static\n"));
        assert!(manifest.contains("licenseFiles=share/licenses/acme_ext/LICENSE\n"));
        assert!(manifest.contains("licenseProfile=external-native\n"));
        let parsed_manifest = parse_canonical_properties_manifest(
            &artifact_root.join("manifest.properties"),
            &manifest,
            &EXTENSION_ARTIFACT_MANIFEST_KEYS,
        )
        .unwrap();
        assert_eq!(
            parsed_manifest
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            EXTENSION_ARTIFACT_MANIFEST_KEYS
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
        );
        assert!(
            artifact_root
                .join("files/share/postgresql/extension/acme_ext.control")
                .is_file()
        );
        assert!(
            artifact_root
                .join("files/share/postgresql/extension/acme_ext--1.0.sql")
                .is_file()
        );
        assert!(
            artifact_root
                .join("files/share/postgresql/extension/uninstall_acme_ext.sql")
                .is_file()
        );
        assert!(
            artifact_root
                .join("files/share/postgresql/extension/acme_aux--1.0.sql")
                .is_file()
        );
        assert!(
            artifact_root
                .join("files/lib/postgresql/acme_ext.so")
                .is_file()
        );
        assert!(
            artifact_root
                .join("mobile-static/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a")
                .is_file()
        );
        assert!(
            artifact_root
                .join("mobile-static/ios-simulator/dependencies/openssl/libcrypto.a")
                .is_file()
        );
        assert!(artifact_root.join("LICENSE").is_file());
        assert!(artifact_root.join("THIRD_PARTY_NOTICES.md").is_file());
        assert!(
            artifact_root
                .join("files/share/licenses/acme_ext/LICENSE")
                .is_file()
        );
        assert!(
            !artifact_root
                .join("files/share/postgresql/extension/hstore.control")
                .exists()
        );
        assert!(
            !artifact_root
                .join("files/share/postgresql/data/unused.rules")
                .exists()
        );

        let loaded = load_prebuilt_extension_artifact(&artifact_root).unwrap();
        assert_eq!(loaded.sql_name, "acme_ext");
        assert_eq!(loaded.native_module_file.as_deref(), Some("acme_ext.so"));
        assert_eq!(loaded.native_target.as_deref(), Some("test-target"));
        assert_eq!(loaded.native_runtime_version.as_deref(), Some("1.2.3"));
        assert_eq!(loaded.dependencies, vec!["cube"]);
        assert_eq!(
            loaded.extension_sql_file_names,
            vec!["uninstall_acme_ext.sql"]
        );
        assert_eq!(loaded.extension_sql_file_prefixes, vec!["acme_aux--"]);
        assert_eq!(loaded.shared_preload_libraries, vec!["acme_preload"]);
        assert!(loaded.mobile_prebuilt);
        assert_eq!(
            mobile_static_archive_targets(&loaded.mobile_static_archives),
            vec!["ios-simulator"]
        );
        assert_eq!(loaded.mobile_static_dependency_archives.len(), 1);
        assert_eq!(
            loaded.license_profile,
            Some(NativeExtensionArtifactLicenseProfile::ExternalNative)
        );
        assert_eq!(
            loaded.license_files,
            vec![PathBuf::from("share/licenses/acme_ext/LICENSE")]
        );
        assert_eq!(
            loaded.mobile_static_dependency_archives[0].relative_path,
            PathBuf::from("mobile-static/ios-simulator/dependencies/openssl/libcrypto.a")
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn desktop_extension_artifact_carries_distinct_server_and_embedded_modules() {
        let temp = unique_temp_root("oliphaunt-create-desktop-extension-profiles");
        let runtime = temp.join("runtime");
        let embedded_modules = temp.join("embedded-modules");
        write_extension_source_runtime(&runtime, "acme_ext", "acme_ext.so");
        write_file(
            &runtime.join("lib/postgresql/acme_ext.so"),
            b"server-profile-module\n",
        );
        write_file(
            &embedded_modules.join("acme_ext.so"),
            b"embedded-profile-module\n",
        );
        let artifact_root = temp.join("artifact");

        create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(&artifact_root, &runtime, "acme_ext", "1.2.3")
                .native_module_stem("acme_ext")
                .native_module_file("acme_ext.so")
                .native_target("linux-x64-gnu")
                .embedded_module_root(&embedded_modules)
                .legal_contract(write_external_legal_contract(&temp, "acme_ext")),
        )
        .unwrap();

        assert_eq!(
            fs::read(artifact_root.join("files/lib/postgresql/acme_ext.so")).unwrap(),
            b"server-profile-module\n"
        );
        assert_eq!(
            fs::read(artifact_root.join("files/lib/modules/acme_ext.so")).unwrap(),
            b"embedded-profile-module\n"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn desktop_extension_artifact_rejects_a_missing_embedded_module_profile() {
        let temp = unique_temp_root("oliphaunt-create-desktop-extension-missing-profile");
        let runtime = temp.join("runtime");
        write_extension_source_runtime(&runtime, "acme_ext", "acme_ext.so");

        let error = create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(
                temp.join("artifact"),
                &runtime,
                "acme_ext",
                "1.2.3",
            )
            .native_module_stem("acme_ext")
            .native_module_file("acme_ext.so")
            .native_target("macos-arm64"),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("desktop prebuilt extension artifacts with nativeModuleStem must declare an embedded module root"),
            "unexpected missing embedded profile error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn create_prebuilt_extension_tar_zst_artifact_roundtrips_through_consumer() {
        let temp = unique_temp_root("oliphaunt-create-prebuilt-extension-tar-zst");
        let runtime = temp.join("runtime");
        write_extension_source_runtime(
            &runtime,
            "acme_ext",
            &format!("acme_ext{}", std::env::consts::DLL_SUFFIX),
        );
        write_file(
            &runtime.join("share/postgresql/extension/hstore.control"),
            b"comment = 'should not leak'\n",
        );
        let archive = temp.join("acme_ext.tar.zst");

        let created = create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(&archive, &runtime, "acme_ext", "1.2.3")
                .native_module_stem("acme_ext")
                .native_target("test-target")
                .data_file("data/acme_ext.rules")
                .format(NativeExtensionArtifactFormat::TarZst)
                .legal_contract(write_external_legal_contract(&temp, "acme_ext")),
        )
        .unwrap();
        assert_eq!(created.path, archive);
        assert_eq!(created.format, NativeExtensionArtifactFormat::TarZst);
        assert!(created.manifest_path.is_none());

        let prepared =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &created.path,
            )])
            .unwrap();
        let extensions = resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
        assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);

        let runtime_files = temp.join("packaged-runtime");
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        copy_prebuilt_extension_artifacts(
            &runtime_files,
            &extensions,
            EngineMode::NativeServer,
            Some("test-target"),
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
                .join("share/postgresql/extension/hstore.control")
                .exists(),
            "producer archives must preserve selected-only consumer behavior"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn create_prebuilt_extension_tar_gz_artifact_roundtrips_through_consumer() {
        let temp = unique_temp_root("oliphaunt-create-prebuilt-extension-tar-gz");
        let runtime = temp.join("runtime");
        write_extension_source_runtime(
            &runtime,
            "acme_ext",
            &format!("acme_ext{}", std::env::consts::DLL_SUFFIX),
        );
        write_file(
            &runtime.join("share/postgresql/extension/hstore.control"),
            b"comment = 'should not leak'\n",
        );
        let archive = temp.join("acme_ext.tar.gz");

        let created = create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(&archive, &runtime, "acme_ext", "1.2.3")
                .native_module_stem("acme_ext")
                .native_target("test-target")
                .data_file("data/acme_ext.rules")
                .format(NativeExtensionArtifactFormat::TarGz)
                .legal_contract(write_external_legal_contract(&temp, "acme_ext")),
        )
        .unwrap();
        assert_eq!(created.path, archive);
        assert_eq!(created.format, NativeExtensionArtifactFormat::TarGz);
        assert!(created.manifest_path.is_none());

        let prepared =
            PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
                &created.path,
            )])
            .unwrap();
        let extensions = resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
        assert_eq!(selected_extension_names(&extensions), vec!["acme_ext"]);

        let runtime_files = temp.join("packaged-runtime");
        let metadata = mobile_static_registry_metadata(&extensions, &[]).unwrap();
        copy_prebuilt_extension_artifacts(
            &runtime_files,
            &extensions,
            EngineMode::NativeServer,
            Some("test-target"),
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
                .join("share/postgresql/extension/hstore.control")
                .exists(),
            "gzip producer archives must preserve selected-only consumer behavior"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn extension_artifact_index_resolves_verified_dependency_closure() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index");
        let dep_artifact_root = temp.join("dep-root");
        write_prebuilt_extension_artifact(
            &dep_artifact_root,
            "acme_dep",
            "acme_dep",
            "acme_dep_static",
            "data/acme_ext.rules",
            false,
        );
        let dep_archive = temp.join("acme_dep.tar.zst");
        write_tar_zst_archive_from_dir(&dep_archive, &dep_artifact_root, "acme_dep");

        let ext_artifact_root = temp.join("ext-root");
        write_prebuilt_extension_artifact(
            &ext_artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let manifest = ext_artifact_root.join("manifest.properties");
        let text = fs::read_to_string(&manifest).unwrap();
        fs::write(
            &manifest,
            text.replace("dependencies=\n", "dependencies=acme_dep\n"),
        )
        .unwrap();
        let ext_archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&ext_archive, &ext_artifact_root, "acme_ext");

        let index = temp.join("extensions.toml");
        write_extension_artifact_index(
            &index,
            "test-target",
            &[("acme_dep", &dep_archive), ("acme_ext", &ext_archive)],
        );

        let resolution = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext"),
        )
        .unwrap();
        assert_eq!(resolution.extension_names, vec!["acme_dep", "acme_ext"]);
        assert_eq!(resolution.artifacts.len(), 2);
        assert_eq!(resolution.artifacts[0].root, dep_archive);
        assert_eq!(resolution.artifacts[1].root, ext_archive);

        let prepared = PreparedPrebuiltExtensionArtifacts::prepare(&resolution.artifacts).unwrap();
        let extensions = resolve_runtime_resource_extensions(&[], prepared.artifacts()).unwrap();
        assert_eq!(
            selected_extension_names(&extensions),
            vec!["acme_dep", "acme_ext"]
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn create_extension_artifact_index_writes_canonical_verified_toml() {
        let temp = unique_temp_root("oliphaunt-create-extension-artifact-index");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");

        let created = create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap();
        assert_eq!(created.path, index);
        assert_eq!(created.target, "test-target");
        assert_eq!(created.artifacts.len(), 1);
        assert_eq!(created.artifacts[0].sql_name, "acme_ext");
        assert!(created.artifacts[0].creates_extension);
        assert_eq!(
            created.artifacts[0].native_module_stem.as_deref(),
            Some("acme_ext")
        );
        assert_eq!(created.artifacts[0].dependencies, Vec::<String>::new());
        assert_eq!(
            created.artifacts[0].shared_preload_libraries,
            Vec::<String>::new()
        );
        assert!(!created.artifacts[0].mobile_prebuilt);
        assert_eq!(created.artifacts[0].path, PathBuf::from("acme_ext.tar.zst"));
        assert_eq!(
            created.artifacts[0].bytes,
            fs::metadata(&archive).unwrap().len()
        );
        assert_eq!(
            created.artifacts[0].sha256,
            sha256_file_hex(&archive).unwrap()
        );

        let text = fs::read_to_string(&created.path).unwrap();
        assert!(text.contains("schema = \"oliphaunt-extension-artifact-index-v1\"\n"));
        assert!(text.contains("pg_major = 18\n"));
        assert!(text.contains("sql_name = \"acme_ext\"\n"));
        assert!(text.contains("target = \"test-target\"\n"));
        assert!(text.contains("creates_extension = true\n"));
        assert!(text.contains("native_module_stem = \"acme_ext\"\n"));
        assert!(text.contains("dependencies = []\n"));
        assert!(text.contains("shared_preload_libraries = []\n"));
        assert!(text.contains("mobile_prebuilt = false\n"));
        assert!(text.contains("path = \"acme_ext.tar.zst\"\n"));
        assert!(text.contains("sha256 = \""));
        assert!(text.contains("bytes = "));

        let resolved = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&created.path)
                .extension("acme_ext"),
        )
        .unwrap();
        assert_eq!(resolved.extension_names, vec!["acme_ext"]);
        assert_eq!(resolved.artifacts[0].root, archive);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn extension_artifact_index_catalog_lists_external_metadata_without_native_env() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-catalog");
        let runtime = temp.join("runtime");
        write_extension_source_runtime(&runtime, "acme_ext", "acme_ext.so");
        let ios_archive = temp.join("liboliphaunt_extension_acme_ext_ios_simulator.a");
        write_file(&ios_archive, b"acme-ios-simulator-static\n");
        let archive = temp.join("acme_ext.tar.zst");

        create_prebuilt_extension_artifact(
            NativeExtensionArtifactOptions::new(&archive, &runtime, "acme_ext", "1.2.3")
                .native_module_stem("acme_ext")
                .native_module_file("acme_ext.so")
                .native_target("test-target")
                .dependency("cube")
                .shared_preload_library("acme_preload")
                .mobile_prebuilt(true)
                .mobile_static_archive("ios-simulator", &ios_archive)
                .static_symbol_prefix("acme_static")
                .format(NativeExtensionArtifactFormat::TarZst)
                .legal_contract(write_external_legal_contract(&temp, "acme_ext")),
        )
        .unwrap();

        let index = temp.join("extensions.toml");
        create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap();

        let catalog = list_prebuilt_extension_artifact_index_catalog(
            NativeExtensionArtifactIndexOptions::new("test-target").index(&index),
        )
        .unwrap();

        assert_eq!(catalog.extensions.len(), 1);
        let entry = &catalog.extensions[0];
        assert_eq!(entry.sql_name, "acme_ext");
        assert_eq!(entry.target, "test-target");
        assert!(entry.creates_extension);
        assert_eq!(entry.native_module_stem.as_deref(), Some("acme_ext"));
        assert_eq!(entry.dependencies, vec!["cube"]);
        assert_eq!(entry.shared_preload_libraries, vec!["acme_preload"]);
        assert!(entry.mobile_prebuilt);
        assert_eq!(entry.mobile_static_archive_targets, vec!["ios-simulator"]);

        let other_target = list_prebuilt_extension_artifact_index_catalog(
            NativeExtensionArtifactIndexOptions::new("other-target").index(&index),
        )
        .unwrap();
        assert!(other_target.extensions.is_empty());

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn extension_artifact_index_downloads_url_backed_artifacts_to_verified_cache() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-download");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("published/acme_ext.tar.zst");
        fs::create_dir_all(archive.parent().unwrap()).unwrap();
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let bytes = fs::metadata(&archive).unwrap().len();
        let sha256 = sha256_file_hex(&archive).unwrap();

        let index = temp.join("index/extensions.toml");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            format!(
                "\
schema = \"oliphaunt-extension-artifact-index-v1\"
pg_major = 18

[[artifacts]]
sql_name = \"acme_ext\"
target = \"test-target\"
path = \"downloads/acme_ext.tar.zst\"
url = \"file://{}\"
sha256 = \"{sha256}\"
bytes = {bytes}
",
                archive.display()
            ),
        )
        .unwrap();
        let cache = temp.join("cache");

        let resolution = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext")
                .artifact_cache_dir(&cache),
        )
        .unwrap();

        let cached = cache.join("test-target/downloads/acme_ext.tar.zst");
        assert!(cached.is_file());
        assert_eq!(resolution.extension_names, vec!["acme_ext"]);
        assert_eq!(resolution.artifacts[0].root, cached);

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn extension_artifact_index_requires_cache_for_url_backed_missing_artifacts() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-download-cache");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("published/acme_ext.tar.zst");
        fs::create_dir_all(archive.parent().unwrap()).unwrap();
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");
        fs::write(
            &index,
            format!(
                "\
schema = \"oliphaunt-extension-artifact-index-v1\"
pg_major = 18

[[artifacts]]
sql_name = \"acme_ext\"
target = \"test-target\"
path = \"missing/acme_ext.tar.zst\"
url = \"file://{}\"
sha256 = \"{}\"
bytes = {}
",
                archive.display(),
                sha256_file_hex(&archive).unwrap(),
                fs::metadata(&archive).unwrap().len()
            ),
        )
        .unwrap();

        let error = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext"),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("--extension-cache"),
            "unexpected missing cache error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn create_extension_artifact_index_can_publish_url_rows() {
        let temp = unique_temp_root("oliphaunt-create-extension-artifact-index-url");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");

        let created = create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive)
                .artifact_base_url("https://example.invalid/oliphaunt/extensions"),
        )
        .unwrap();

        assert_eq!(
            created.artifacts[0].url.as_deref(),
            Some("https://example.invalid/oliphaunt/extensions/acme_ext.tar.zst")
        );
        let text = fs::read_to_string(&created.path).unwrap();
        assert!(
            text.contains(
                "url = \"https://example.invalid/oliphaunt/extensions/acme_ext.tar.zst\"\n"
            )
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(feature = "extension-signing")]
    #[test]
    fn extension_artifact_index_signature_verifies_trusted_publisher_key() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-signature");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");
        create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap();
        let (signing_key, public_key) = test_extension_index_key_pair();
        let signature = sign_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexSigningOptions::new(&index, "test-publisher", signing_key),
        )
        .unwrap();
        assert!(signature.path.is_file());
        assert_eq!(signature.public_key_hex, public_key);

        let resolution = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext")
                .trusted_signing_key(NativeExtensionArtifactIndexTrustRoot::new(
                    "test-publisher",
                    public_key,
                ))
                .require_signatures(true),
        )
        .unwrap();
        assert_eq!(resolution.extension_names, vec!["acme_ext"]);

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(feature = "extension-signing")]
    #[test]
    fn extension_artifact_index_signature_rejects_modified_index() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-signature-modified");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");
        create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap();
        let (signing_key, public_key) = test_extension_index_key_pair();
        sign_prebuilt_extension_artifact_index(NativeExtensionArtifactIndexSigningOptions::new(
            &index,
            "test-publisher",
            signing_key,
        ))
        .unwrap();
        let mut index_text = fs::read_to_string(&index).unwrap();
        index_text.push('\n');
        fs::write(&index, index_text).unwrap();

        let error = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext")
                .trusted_signing_key(NativeExtensionArtifactIndexTrustRoot::new(
                    "test-publisher",
                    public_key,
                ))
                .require_signatures(true),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("failed verification"),
            "unexpected modified signature error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(feature = "extension-signing")]
    #[test]
    fn extension_artifact_index_requires_signature_when_trust_is_required() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-signature-required");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");
        create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap();
        let (_, public_key) = test_extension_index_key_pair();

        let error = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext")
                .trusted_signing_key(NativeExtensionArtifactIndexTrustRoot::new(
                    "test-publisher",
                    public_key,
                ))
                .require_signatures(true),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(".sig"),
            "unexpected missing signature error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn create_extension_artifact_index_rejects_artifacts_outside_index_dir() {
        let temp = unique_temp_root("oliphaunt-create-extension-artifact-index-outside");
        let outside = unique_temp_root("oliphaunt-extension-artifact-outside");
        let artifact_root = outside.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = outside.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");

        let error = create_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexCreateOptions::new(&index, "test-target")
                .artifact(&archive),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("must be inside index directory"),
            "unexpected outside-index error: {error}"
        );

        let _ = fs::remove_dir_all(temp);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn extension_artifact_index_rejects_checksum_mismatch() {
        let temp = unique_temp_root("oliphaunt-extension-artifact-index-checksum");
        let artifact_root = temp.join("artifact-root");
        write_prebuilt_extension_artifact(
            &artifact_root,
            "acme_ext",
            "acme_ext",
            "acme_static",
            "data/acme_ext.rules",
            false,
        );
        let archive = temp.join("acme_ext.tar.zst");
        write_tar_zst_archive_from_dir(&archive, &artifact_root, "acme_ext");
        let index = temp.join("extensions.toml");
        let bytes = fs::metadata(&archive).unwrap().len();
        fs::write(
            &index,
            format!(
                "\
schema = \"oliphaunt-extension-artifact-index-v1\"
pg_major = 18

[[artifacts]]
sql_name = \"acme_ext\"
target = \"test-target\"
path = \"acme_ext.tar.zst\"
sha256 = \"{}\"
bytes = {bytes}
",
                "0".repeat(64)
            ),
        )
        .unwrap();

        let error = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new("test-target")
                .index(&index)
                .extension("acme_ext"),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("has sha256"),
            "unexpected checksum error: {error}"
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

    fn write_extension_source_runtime(root: &Path, sql_name: &str, module_file: &str) {
        write_file(
            &root
                .join("share/postgresql/extension")
                .join(format!("{sql_name}.control")),
            b"comment = 'acme extension'\n",
        );
        write_file(
            &root
                .join("share/postgresql/extension")
                .join(format!("{sql_name}--1.0.sql")),
            b"CREATE FUNCTION acme_ext_echo(integer) RETURNS integer AS 'MODULE_PATHNAME' LANGUAGE C STRICT;\n",
        );
        write_file(
            &root.join("share/postgresql/data/acme_ext.rules"),
            b"acme-data\n",
        );
        write_file(
            &root.join("lib/postgresql").join(module_file),
            b"acme-module\n",
        );
    }

    fn write_external_legal_contract(
        temp: &Path,
        sql_name: &str,
    ) -> NativeExtensionArtifactLegalContract {
        let root = temp.join(format!("legal-{sql_name}"));
        write_legal_fixture_file(&root.join("LICENSE"), b"fixture Oliphaunt license\n");
        write_legal_fixture_file(
            &root.join("THIRD_PARTY_NOTICES.md"),
            b"fixture third-party notices\n",
        );
        let license = PathBuf::from(format!("share/licenses/{sql_name}/LICENSE"));
        write_legal_fixture_file(&root.join(&license), b"fixture upstream license\n");
        NativeExtensionArtifactLegalContract::new(
            NativeExtensionArtifactLicenseProfile::ExternalNative,
            root,
        )
        .license_file(license)
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

    fn write_extension_artifact_index(index: &Path, target: &str, artifacts: &[(&str, &Path)]) {
        let mut text = String::from(
            "\
schema = \"oliphaunt-extension-artifact-index-v1\"
pg_major = 18
",
        );
        for (sql_name, artifact) in artifacts {
            let file_name = artifact.file_name().unwrap().to_string_lossy();
            let bytes = fs::metadata(artifact).unwrap().len();
            let sha256 = sha256_file_hex(artifact).unwrap();
            text.push_str(&format!(
                "\n[[artifacts]]\nsql_name = \"{sql_name}\"\ntarget = \"{target}\"\npath = \"{file_name}\"\nsha256 = \"{sha256}\"\nbytes = {bytes}\n"
            ));
        }
        write_file(index, text.as_bytes());
    }

    #[cfg(feature = "extension-signing")]
    fn test_extension_index_key_pair() -> (String, String) {
        use ed25519_dalek::SigningKey;

        let signing_key_bytes = [7u8; 32];
        let signing_key = SigningKey::from_bytes(&signing_key_bytes);
        (
            hex_bytes(&signing_key_bytes),
            hex_bytes(&signing_key.verifying_key().to_bytes()),
        )
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
