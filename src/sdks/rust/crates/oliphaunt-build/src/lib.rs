//! Cargo build-script integration for Oliphaunt applications.
//!
//! `configure()` is intended to be called from an application `build.rs`.
//! Cargo resolves target-specific artifact crates; this crate stages the
//! already-resolved files into `OUT_DIR`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const LOCK_SCHEMA: &str = "oliphaunt-assets-lock-v1";
const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const ARTIFACT_ENV_SUFFIX: &str = "_MANIFEST";

/// Run Oliphaunt build-script configuration and fail the Cargo build on error.
pub fn configure() {
    match try_configure() {
        Ok(output) => {
            for instruction in output.cargo_instructions {
                println!("{instruction}");
            }
        }
        Err(error) => {
            println!("cargo::error={error}");
            panic!("oliphaunt-build failed: {error}");
        }
    }
}

/// Run Oliphaunt build-script configuration from Cargo-provided environment.
pub fn try_configure() -> Result<BuildOutput> {
    BuildContext::from_env()?.configure()
}

/// Successful build-script output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildOutput {
    pub resources_dir: PathBuf,
    pub lock_file: PathBuf,
    pub generated_rust: PathBuf,
    pub cargo_instructions: Vec<String>,
}

#[derive(Debug, Clone)]
struct BuildContext {
    manifest_dir: PathBuf,
    out_dir: PathBuf,
    target: String,
    artifact_manifest_paths: Vec<PathBuf>,
}

impl BuildContext {
    fn from_env() -> Result<Self> {
        let vars: BTreeMap<String, OsString> = env::vars_os()
            .filter_map(|(key, value)| key.into_string().ok().map(|key| (key, value)))
            .collect();
        let manifest_dir = required_path_var(&vars, "CARGO_MANIFEST_DIR")?;
        let out_dir = required_path_var(&vars, "OUT_DIR")?;
        let target = required_string_var(&vars, "TARGET")?;
        let artifact_manifest_paths = vars
            .iter()
            .filter_map(|(key, value)| {
                (key.starts_with(ARTIFACT_ENV_PREFIX)
                    && key.ends_with(ARTIFACT_ENV_SUFFIX)
                    && !value.is_empty())
                .then(|| PathBuf::from(value))
            })
            .collect();
        Ok(Self {
            manifest_dir,
            out_dir,
            target,
            artifact_manifest_paths,
        })
    }

    fn configure(&self) -> Result<BuildOutput> {
        let cargo_toml = self.manifest_dir.join("Cargo.toml");
        let app = read_application_manifest(&cargo_toml)?;
        let metadata = app.package.metadata.oliphaunt;
        let artifacts = self.read_artifact_manifests()?;
        let selected = select_artifacts(&metadata, &artifacts, &self.target)?;

        let root = self.out_dir.join("oliphaunt");
        let resources_dir = root.join("resources");
        let lock_file = root.join("oliphaunt-assets.lock");
        let generated_rust = root.join("oliphaunt_assets.rs");

        if resources_dir.exists() {
            fs::remove_dir_all(&resources_dir).map_err(|source| {
                Error::io(
                    "clean stale Oliphaunt resources directory",
                    &resources_dir,
                    source,
                )
            })?;
        }
        fs::create_dir_all(&resources_dir).map_err(|source| {
            Error::io(
                "create Oliphaunt resources directory",
                &resources_dir,
                source,
            )
        })?;
        fs::create_dir_all(&root)
            .map_err(|source| Error::io("create Oliphaunt OUT_DIR", &root, source))?;

        let staged = stage_artifacts(&selected, &resources_dir)?;
        write_lock_file(&lock_file, &metadata, &self.target, &staged)?;
        write_generated_rust(&generated_rust, &resources_dir, &lock_file)?;

        let mut cargo_instructions = vec![
            format!("cargo::rerun-if-changed={}", cargo_toml.display()),
            format!(
                "cargo::rustc-env=OLIPHAUNT_RESOURCES_DIR={}",
                resources_dir.display()
            ),
            format!(
                "cargo::rustc-env=OLIPHAUNT_ASSETS_LOCK={}",
                lock_file.display()
            ),
            format!(
                "cargo::rustc-env=OLIPHAUNT_ASSETS_RS={}",
                generated_rust.display()
            ),
        ];
        for manifest in &self.artifact_manifest_paths {
            cargo_instructions.push(format!("cargo::rerun-if-changed={}", manifest.display()));
        }
        for artifact in &selected {
            for file in &artifact.files {
                cargo_instructions
                    .push(format!("cargo::rerun-if-changed={}", file.source.display()));
            }
        }

        Ok(BuildOutput {
            resources_dir,
            lock_file,
            generated_rust,
            cargo_instructions,
        })
    }

    fn read_artifact_manifests(&self) -> Result<Vec<ArtifactManifest>> {
        let mut artifacts = Vec::new();
        let mut seen = BTreeSet::new();
        for path in &self.artifact_manifest_paths {
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if !seen.insert(canonical) {
                continue;
            }
            let text = fs::read_to_string(path)
                .map_err(|source| Error::io("read Oliphaunt artifact manifest", path, source))?;
            let mut manifest: ArtifactManifest =
                toml::from_str(&text).map_err(|source| Error::parse(path, source))?;
            manifest.source_manifest = Some(path.clone());
            manifest.validate()?;
            artifacts.push(manifest);
        }
        Ok(artifacts)
    }
}

fn required_path_var(vars: &BTreeMap<String, OsString>, key: &str) -> Result<PathBuf> {
    vars.get(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| Error::new(format!("Cargo did not set {key}")))
}

fn required_string_var(vars: &BTreeMap<String, OsString>, key: &str) -> Result<String> {
    vars.get(key)
        .and_then(|value| value.clone().into_string().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(format!("Cargo did not set {key}")))
}

fn read_application_manifest(path: &Path) -> Result<ApplicationManifest> {
    let text = fs::read_to_string(path)
        .map_err(|source| Error::io("read application Cargo.toml", path, source))?;
    let manifest: ApplicationManifest =
        toml::from_str(&text).map_err(|source| Error::parse(path, source))?;
    manifest.package.metadata.oliphaunt.validate()?;
    Ok(manifest)
}

fn select_artifacts(
    metadata: &OliphauntMetadata,
    artifacts: &[ArtifactManifest],
    target: &str,
) -> Result<Vec<ArtifactManifest>> {
    let selected_extensions: BTreeSet<&str> =
        metadata.extensions.iter().map(String::as_str).collect();
    for artifact in artifacts {
        if artifact.kind == ArtifactKind::Extension {
            let extension = artifact.extension.as_deref().ok_or_else(|| {
                Error::new(format!(
                    "{} extension artifact is missing extension name",
                    artifact.label()
                ))
            })?;
            if !selected_extensions.contains(extension) {
                return Err(Error::new(format!(
                    "{} was provided by Cargo but extension {extension:?} is not selected in [package.metadata.oliphaunt]",
                    artifact.label()
                )));
            }
        }
    }

    let mut selected = Vec::new();
    match metadata.runtime.as_str() {
        "liboliphaunt-native" => {
            selected.push(require_artifact(
                artifacts,
                "liboliphaunt-native",
                Some(&metadata.runtime_version),
                ArtifactKind::NativeRuntime,
                target,
                "selected native runtime",
            )?);
            selected.push(require_artifact(
                artifacts,
                "oliphaunt-tools",
                Some(&metadata.runtime_version),
                ArtifactKind::NativeTools,
                target,
                "selected native tools",
            )?);
            selected.push(require_artifact(
                artifacts,
                "oliphaunt-broker",
                None,
                ArtifactKind::BrokerHelper,
                target,
                "selected native broker helper",
            )?);
        }
        "liboliphaunt-wasix" => {
            selected.push(require_artifact(
                artifacts,
                "liboliphaunt-wasix",
                Some(&metadata.runtime_version),
                ArtifactKind::WasixRuntime,
                "portable",
                "selected WASIX portable runtime",
            )?);
            selected.push(require_artifact(
                artifacts,
                "oliphaunt-wasix-tools",
                Some(&metadata.runtime_version),
                ArtifactKind::WasixTools,
                "portable",
                "selected WASIX tools",
            )?);
            selected.push(require_artifact(
                artifacts,
                "liboliphaunt-wasix",
                Some(&metadata.runtime_version),
                ArtifactKind::WasixAot,
                target,
                "selected WASIX AOT runtime",
            )?);
            selected.push(require_artifact(
                artifacts,
                "oliphaunt-wasix-tools",
                Some(&metadata.runtime_version),
                ArtifactKind::WasixToolsAot,
                target,
                "selected WASIX tools AOT runtime",
            )?);
        }
        other => {
            return Err(Error::new(format!(
                "unsupported [package.metadata.oliphaunt] runtime {other:?}; use \"liboliphaunt-native\" or \"liboliphaunt-wasix\""
            )));
        }
    }

    if metadata.icu {
        selected.push(require_artifact(
            artifacts,
            "oliphaunt-icu",
            None,
            ArtifactKind::IcuData,
            "portable",
            "selected ICU data",
        )?);
    }

    for extension in &metadata.extensions {
        selected.push(require_extension_artifact(artifacts, extension, target)?);
    }

    Ok(selected)
}

fn require_artifact(
    artifacts: &[ArtifactManifest],
    product: &str,
    version: Option<&str>,
    kind: ArtifactKind,
    target: &str,
    label: &str,
) -> Result<ArtifactManifest> {
    let matches: Vec<_> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.product == product
                && version.is_none_or(|version| artifact.version == version)
                && artifact.kind == kind
                && artifact.target == target
        })
        .cloned()
        .collect();
    let version_label = version
        .map(|version| format!(" version={version}"))
        .unwrap_or_default();
    if matches.len() > 1 {
        return Err(Error::new(format!(
            "multiple Cargo-resolved Oliphaunt artifacts match {label}: product={product}{version_label} kind={} target={target}",
            kind.as_str()
        )));
    }
    matches
        .into_iter()
        .next()
        .ok_or_else(|| {
            Error::new(format!(
                "missing Cargo-resolved Oliphaunt artifact for {label}: product={product}{version_label} kind={} target={target}",
                kind.as_str()
            ))
        })
}

fn require_extension_artifact(
    artifacts: &[ArtifactManifest],
    extension: &str,
    target: &str,
) -> Result<ArtifactManifest> {
    let matches: Vec<_> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.kind == ArtifactKind::Extension
                && artifact.target == target
                && artifact.extension.as_deref() == Some(extension)
        })
        .cloned()
        .collect();
    if matches.len() > 1 {
        return Err(Error::new(format!(
            "multiple Cargo-resolved Oliphaunt extension artifacts match extension={extension} target={target}"
        )));
    }
    matches
        .into_iter()
        .next()
        .ok_or_else(|| {
            Error::new(format!(
                "missing Cargo-resolved Oliphaunt extension artifact for extension={extension} target={target}"
            ))
        })
}

fn stage_artifacts(
    artifacts: &[ArtifactManifest],
    resources_dir: &Path,
) -> Result<Vec<LockedArtifact>> {
    let mut staged = Vec::new();
    for artifact in artifacts {
        let artifact_dir = resources_dir
            .join(artifact.kind.as_str())
            .join(&artifact.product);
        let mut locked_files = Vec::new();
        for file in &artifact.files {
            let relative = checked_relative_path(&file.relative)?;
            let dest = artifact_dir.join(&relative);
            let bytes = fs::read(&file.source).map_err(|source| {
                Error::io("read Oliphaunt artifact file", &file.source, source)
            })?;
            let actual = sha256_hex(&bytes);
            if actual != file.sha256 {
                return Err(Error::new(format!(
                    "checksum mismatch for {}: manifest={} actual={actual}",
                    file.source.display(),
                    file.sha256
                )));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|source| {
                    Error::io("create staged artifact directory", parent, source)
                })?;
            }
            fs::write(&dest, bytes).map_err(|source| {
                Error::io("write staged Oliphaunt artifact file", &dest, source)
            })?;
            set_executable_if_needed(&dest, file.executable)?;
            locked_files.push(LockedFile {
                path: dest
                    .strip_prefix(resources_dir)
                    .unwrap_or(&dest)
                    .to_string_lossy()
                    .replace('\\', "/"),
                sha256: file.sha256.clone(),
                executable: file.executable,
            });
        }
        staged.push(LockedArtifact {
            product: artifact.product.clone(),
            version: artifact.version.clone(),
            kind: artifact.kind.as_str().to_owned(),
            target: artifact.target.clone(),
            extension: artifact.extension.clone(),
            files: locked_files,
        });
    }
    Ok(staged)
}

fn checked_relative_path(path: &str) -> Result<PathBuf> {
    let value = Path::new(path);
    if value.is_absolute()
        || value
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(Error::new(format!(
            "artifact relative path must stay inside resources directory: {path:?}"
        )));
    }
    Ok(value.to_path_buf())
}

fn set_executable_if_needed(path: &Path, executable: bool) -> Result<()> {
    if !executable {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|source| Error::io("read staged file permissions", path, source))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|source| Error::io("set staged file executable bit", path, source))?;
    }
    Ok(())
}

fn write_lock_file(
    path: &Path,
    metadata: &OliphauntMetadata,
    target: &str,
    artifacts: &[LockedArtifact],
) -> Result<()> {
    let lock = LockFile {
        schema: LOCK_SCHEMA.to_owned(),
        target: target.to_owned(),
        runtime: metadata.runtime.clone(),
        runtime_version: metadata.runtime_version.clone(),
        icu: metadata.icu,
        extensions: metadata.extensions.clone(),
        artifacts: artifacts.to_vec(),
    };
    let text = toml::to_string_pretty(&lock)
        .map_err(|source| Error::new(format!("serialize Oliphaunt assets lock: {source}")))?;
    fs::write(path, text).map_err(|source| Error::io("write Oliphaunt assets lock", path, source))
}

fn write_generated_rust(path: &Path, resources_dir: &Path, lock_file: &Path) -> Result<()> {
    let text = format!(
        "pub const OLIPHAUNT_RESOURCES_DIR: &str = {:?};\npub const OLIPHAUNT_ASSETS_LOCK: &str = {:?};\n",
        resources_dir.display().to_string(),
        lock_file.display().to_string(),
    );
    fs::write(path, text)
        .map_err(|source| Error::io("write generated Oliphaunt Rust constants", path, source))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

#[derive(Debug, Deserialize)]
struct ApplicationManifest {
    package: ApplicationPackage,
}

#[derive(Debug, Deserialize)]
struct ApplicationPackage {
    #[serde(default)]
    metadata: ApplicationPackageMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct ApplicationPackageMetadata {
    oliphaunt: OliphauntMetadata,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct OliphauntMetadata {
    runtime: String,
    runtime_version: String,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    icu: bool,
}

impl OliphauntMetadata {
    fn validate(&self) -> Result<()> {
        if self.runtime.is_empty() {
            return Err(Error::new(
                "missing [package.metadata.oliphaunt].runtime".to_owned(),
            ));
        }
        if self.runtime_version.is_empty() {
            return Err(Error::new(
                "missing [package.metadata.oliphaunt].runtime-version".to_owned(),
            ));
        }
        let mut seen = BTreeSet::new();
        for extension in &self.extensions {
            if extension.is_empty() {
                return Err(Error::new(
                    "[package.metadata.oliphaunt].extensions must not contain empty names",
                ));
            }
            if !seen.insert(extension) {
                return Err(Error::new(format!(
                    "duplicate [package.metadata.oliphaunt] extension {extension:?}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ArtifactManifest {
    schema: String,
    product: String,
    version: String,
    kind: ArtifactKind,
    target: String,
    extension: Option<String>,
    files: Vec<ArtifactFile>,
    #[serde(skip)]
    source_manifest: Option<PathBuf>,
}

impl ArtifactManifest {
    fn validate(&self) -> Result<()> {
        if self.schema != ARTIFACT_SCHEMA {
            return Err(Error::new(format!(
                "{} must use schema {ARTIFACT_SCHEMA:?}",
                self.label()
            )));
        }
        if self.product.is_empty() || self.version.is_empty() || self.target.is_empty() {
            return Err(Error::new(format!(
                "{} must declare product, version, and target",
                self.label()
            )));
        }
        if self.kind == ArtifactKind::Extension
            && self.extension.as_deref().unwrap_or("").is_empty()
        {
            return Err(Error::new(format!(
                "{} extension artifact must declare extension",
                self.label()
            )));
        }
        if self.files.is_empty() {
            return Err(Error::new(format!(
                "{} must contain at least one file",
                self.label()
            )));
        }
        self.validate_product_kind()?;
        self.validate_payload()?;
        Ok(())
    }

    fn label(&self) -> String {
        self.source_manifest
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| format!("{} {} {}", self.product, self.kind.as_str(), self.target))
    }

    fn validate_product_kind(&self) -> Result<()> {
        let expected = match self.kind {
            ArtifactKind::NativeRuntime => Some("liboliphaunt-native"),
            ArtifactKind::NativeTools => Some("oliphaunt-tools"),
            ArtifactKind::WasixRuntime | ArtifactKind::WasixAot => Some("liboliphaunt-wasix"),
            ArtifactKind::WasixTools | ArtifactKind::WasixToolsAot => Some("oliphaunt-wasix-tools"),
            ArtifactKind::BrokerHelper => Some("oliphaunt-broker"),
            ArtifactKind::IcuData => Some("oliphaunt-icu"),
            ArtifactKind::Extension => None,
        };
        if let Some(expected) = expected {
            if self.product != expected {
                return Err(Error::new(format!(
                    "{} kind {} must use product {expected:?}",
                    self.label(),
                    self.kind.as_str()
                )));
            }
        } else if !self.product.starts_with("oliphaunt-extension-") {
            return Err(Error::new(format!(
                "{} extension artifact product must start with \"oliphaunt-extension-\"",
                self.label()
            )));
        }
        Ok(())
    }

    fn validate_payload(&self) -> Result<()> {
        let relatives: BTreeSet<&str> = self
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect();
        match self.kind {
            ArtifactKind::NativeRuntime => {
                self.require_files(
                    &relatives,
                    &[
                        "runtime/bin/postgres",
                        "runtime/bin/initdb",
                        "runtime/bin/pg_ctl",
                    ],
                )?;
                self.reject_files(
                    &relatives,
                    &[
                        "runtime/bin/pg_dump",
                        "runtime/bin/psql",
                        "runtime/bin/pg_dump.exe",
                        "runtime/bin/psql.exe",
                    ],
                )?;
            }
            ArtifactKind::NativeTools => {
                self.require_files(&relatives, &["runtime/bin/pg_dump", "runtime/bin/psql"])?;
                self.reject_files(
                    &relatives,
                    &[
                        "runtime/bin/postgres",
                        "runtime/bin/initdb",
                        "runtime/bin/pg_ctl",
                        "runtime/bin/postgres.exe",
                        "runtime/bin/initdb.exe",
                        "runtime/bin/pg_ctl.exe",
                    ],
                )?;
            }
            ArtifactKind::WasixRuntime => {
                self.require_files(
                    &relatives,
                    &["oliphaunt.wasix.tar.zst", "bin/initdb.wasix.wasm"],
                )?;
                self.reject_files(
                    &relatives,
                    &[
                        "bin/pg_ctl.wasix.wasm",
                        "bin/pg_dump.wasix.wasm",
                        "bin/psql.wasix.wasm",
                    ],
                )?;
            }
            ArtifactKind::WasixTools => {
                self.require_files(
                    &relatives,
                    &["bin/pg_dump.wasix.wasm", "bin/psql.wasix.wasm"],
                )?;
                self.reject_files(
                    &relatives,
                    &[
                        "bin/postgres.wasix.wasm",
                        "bin/initdb.wasix.wasm",
                        "bin/pg_ctl.wasix.wasm",
                    ],
                )?;
            }
            ArtifactKind::WasixToolsAot => {
                self.require_files(
                    &relatives,
                    &["pg_dump-llvm-opta.bin.zst", "psql-llvm-opta.bin.zst"],
                )?;
                self.reject_files(
                    &relatives,
                    &[
                        "postgres-llvm-opta.bin.zst",
                        "initdb-llvm-opta.bin.zst",
                        "pg_ctl-llvm-opta.bin.zst",
                    ],
                )?;
            }
            ArtifactKind::WasixAot => {
                self.require_files(&relatives, &["manifest.json"])?;
                self.reject_files(
                    &relatives,
                    &[
                        "pg_ctl-llvm-opta.bin.zst",
                        "pg_dump-llvm-opta.bin.zst",
                        "psql-llvm-opta.bin.zst",
                    ],
                )?;
            }
            ArtifactKind::BrokerHelper | ArtifactKind::IcuData | ArtifactKind::Extension => {}
        }
        Ok(())
    }

    fn require_files(&self, relatives: &BTreeSet<&str>, required: &[&str]) -> Result<()> {
        for relative in required {
            if !relatives.contains(relative) && !windows_tool_variant_present(relatives, relative) {
                return Err(Error::new(format!(
                    "{} {} artifact is missing required payload {relative:?}",
                    self.label(),
                    self.kind.as_str()
                )));
            }
        }
        Ok(())
    }

    fn reject_files(&self, relatives: &BTreeSet<&str>, rejected: &[&str]) -> Result<()> {
        for relative in rejected {
            if relatives.contains(relative) {
                return Err(Error::new(format!(
                    "{} {} artifact must not contain payload {relative:?}",
                    self.label(),
                    self.kind.as_str()
                )));
            }
        }
        Ok(())
    }
}

fn windows_tool_variant_present(relatives: &BTreeSet<&str>, relative: &str) -> bool {
    if !relative.starts_with("runtime/bin/") || relative.ends_with(".exe") {
        return false;
    }
    let windows_relative = format!("{relative}.exe");
    relatives.contains(windows_relative.as_str())
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ArtifactKind {
    NativeRuntime,
    NativeTools,
    WasixRuntime,
    WasixTools,
    WasixAot,
    WasixToolsAot,
    BrokerHelper,
    IcuData,
    Extension,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::NativeRuntime => "native-runtime",
            Self::NativeTools => "native-tools",
            Self::WasixRuntime => "wasix-runtime",
            Self::WasixTools => "wasix-tools",
            Self::WasixAot => "wasix-aot",
            Self::WasixToolsAot => "wasix-tools-aot",
            Self::BrokerHelper => "broker-helper",
            Self::IcuData => "icu-data",
            Self::Extension => "extension",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ArtifactFile {
    source: PathBuf,
    relative: String,
    sha256: String,
    #[serde(default)]
    executable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct LockFile {
    schema: String,
    target: String,
    runtime: String,
    runtime_version: String,
    icu: bool,
    extensions: Vec<String>,
    artifacts: Vec<LockedArtifact>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct LockedArtifact {
    product: String,
    version: String,
    kind: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    files: Vec<LockedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct LockedFile {
    path: String,
    sha256: String,
    executable: bool,
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    message: String,
}

impl Error {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn io(action: &str, path: &Path, source: io::Error) -> Self {
        Self::new(format!("{action} {}: {source}", path.display()))
    }

    fn parse(path: &Path, source: toml::de::Error) -> Self {
        Self::new(format!("parse {}: {source}", path.display()))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn missing_application_metadata_fails() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"app\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![],
        };
        let error = context.configure().expect_err("missing metadata must fail");
        assert!(
            error
                .to_string()
                .contains("missing [package.metadata.oliphaunt].runtime")
        );
    }

    #[test]
    fn selected_runtime_requires_cargo_resolved_artifact() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
"#,
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![],
        };
        let error = context
            .configure()
            .expect_err("missing runtime artifact must fail");
        assert!(
            error
                .to_string()
                .contains("missing Cargo-resolved Oliphaunt artifact")
        );
        assert!(error.to_string().contains("kind=native-runtime"));
    }

    #[test]
    fn icu_selection_requires_icu_artifact() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
icu = true
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "0.1.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let broker_manifest = write_artifact_manifest(
            &temp,
            "broker.toml",
            "oliphaunt-broker",
            "0.1.0",
            "broker-helper",
            "x86_64-unknown-linux-gnu",
            None,
            "bin/oliphaunt-broker",
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![runtime_manifest, tools_manifest, broker_manifest],
        };
        let error = context
            .configure()
            .expect_err("missing ICU artifact must fail");
        assert!(error.to_string().contains("product=oliphaunt-icu"));
        assert!(error.to_string().contains("kind=icu-data"));
    }

    #[test]
    fn native_runtime_selection_requires_broker_helper_artifact() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "0.1.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![runtime_manifest, tools_manifest],
        };
        let error = context
            .configure()
            .expect_err("missing broker helper artifact must fail");
        assert!(error.to_string().contains("product=oliphaunt-broker"));
        assert!(error.to_string().contains("kind=broker-helper"));
    }

    #[test]
    fn native_runtime_allows_independent_auxiliary_artifact_versions() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "1.2.0"
extensions = ["vector"]
icu = true
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "1.2.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "1.2.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let broker_manifest = write_artifact_manifest(
            &temp,
            "broker.toml",
            "oliphaunt-broker",
            "2.0.0",
            "broker-helper",
            "x86_64-unknown-linux-gnu",
            None,
            "bin/oliphaunt-broker",
        );
        let icu_manifest = write_artifact_manifest(
            &temp,
            "icu.toml",
            "oliphaunt-icu",
            "3.0.0",
            "icu-data",
            "portable",
            None,
            "share/icu/icudt.dat",
        );
        let extension_manifest = write_artifact_manifest(
            &temp,
            "vector.toml",
            "oliphaunt-extension-vector",
            "4.0.0",
            "extension",
            "x86_64-unknown-linux-gnu",
            Some("vector"),
            "extensions/vector/vector.control",
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![
                runtime_manifest,
                tools_manifest,
                broker_manifest,
                icu_manifest,
                extension_manifest,
            ],
        };

        let output = context
            .configure()
            .expect("Cargo-resolved auxiliary artifact versions should be accepted");

        let lock = fs::read_to_string(output.lock_file).unwrap();
        assert!(lock.contains("product = \"liboliphaunt-native\""));
        assert!(lock.contains("version = \"1.2.0\""));
        assert!(lock.contains("product = \"oliphaunt-tools\""));
        assert!(lock.contains("product = \"oliphaunt-broker\""));
        assert!(lock.contains("version = \"2.0.0\""));
        assert!(lock.contains("product = \"oliphaunt-icu\""));
        assert!(lock.contains("version = \"3.0.0\""));
        assert!(lock.contains("product = \"oliphaunt-extension-vector\""));
        assert!(lock.contains("version = \"4.0.0\""));
    }

    #[test]
    fn unselected_extension_artifact_fails() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "0.1.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let broker_manifest = write_artifact_manifest(
            &temp,
            "broker.toml",
            "oliphaunt-broker",
            "0.1.0",
            "broker-helper",
            "x86_64-unknown-linux-gnu",
            None,
            "bin/oliphaunt-broker",
        );
        let extension_manifest = write_artifact_manifest(
            &temp,
            "vector.toml",
            "oliphaunt-extension-vector",
            "0.1.0",
            "extension",
            "x86_64-unknown-linux-gnu",
            Some("vector"),
            "extensions/vector/vector.control",
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![
                runtime_manifest,
                tools_manifest,
                broker_manifest,
                extension_manifest,
            ],
        };
        let error = context
            .configure()
            .expect_err("unselected extension artifact must fail");
        assert!(error.to_string().contains("is not selected"));
    }

    #[test]
    fn selected_artifact_files_are_staged_and_locked() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
extensions = ["vector"]
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "0.1.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let broker_manifest = write_artifact_manifest(
            &temp,
            "broker.toml",
            "oliphaunt-broker",
            "0.1.0",
            "broker-helper",
            "x86_64-unknown-linux-gnu",
            None,
            "bin/oliphaunt-broker",
        );
        let extension_manifest = write_artifact_manifest(
            &temp,
            "vector.toml",
            "oliphaunt-extension-vector",
            "0.1.0",
            "extension",
            "x86_64-unknown-linux-gnu",
            Some("vector"),
            "extensions/vector/vector.control",
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![
                runtime_manifest,
                tools_manifest,
                broker_manifest,
                extension_manifest,
            ],
        };

        let output = context
            .configure()
            .expect("selected artifacts should stage");

        assert!(
            output
                .resources_dir
                .join("native-runtime/liboliphaunt-native/runtime/bin/postgres")
                .is_file()
        );
        assert!(
            output
                .resources_dir
                .join("native-tools/oliphaunt-tools/runtime/bin/pg_dump")
                .is_file()
        );
        assert!(
            output
                .resources_dir
                .join("broker-helper/oliphaunt-broker/bin/oliphaunt-broker")
                .is_file()
        );
        assert!(
            output
                .resources_dir
                .join("extension/oliphaunt-extension-vector/extensions/vector/vector.control")
                .is_file()
        );
        let lock = fs::read_to_string(output.lock_file).unwrap();
        assert!(lock.contains("schema = \"oliphaunt-assets-lock-v1\""));
        assert!(lock.contains("runtime = \"liboliphaunt-native\""));
        assert!(lock.contains("kind = \"broker-helper\""));
        assert!(lock.contains("extension = \"vector\""));
        let generated = fs::read_to_string(output.generated_rust).unwrap();
        assert!(generated.contains("OLIPHAUNT_RESOURCES_DIR"));
    }

    #[test]
    fn staging_cleans_stale_resource_files() {
        let temp = app_with_metadata(
            r#"
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
"#,
        );
        let runtime_manifest = write_artifact_manifest(
            &temp,
            "runtime.toml",
            "liboliphaunt-native",
            "0.1.0",
            "native-runtime",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/postgres",
        );
        let tools_manifest = write_artifact_manifest(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            "runtime/bin/pg_dump",
        );
        let broker_manifest = write_artifact_manifest(
            &temp,
            "broker.toml",
            "oliphaunt-broker",
            "0.1.0",
            "broker-helper",
            "x86_64-unknown-linux-gnu",
            None,
            "bin/oliphaunt-broker",
        );
        let out_dir = temp.path().join("out");
        let stale = out_dir.join("oliphaunt/resources/extension/stale/stale.control");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "stale").unwrap();
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir,
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![runtime_manifest, tools_manifest, broker_manifest],
        };

        let output = context.configure().expect("selected runtime should stage");

        assert!(!stale.exists());
        assert!(
            output
                .resources_dir
                .join("native-runtime/liboliphaunt-native/runtime/bin/postgres")
                .is_file()
        );
    }

    #[test]
    fn artifact_manifest_rejects_incomplete_native_tools_payload() {
        let temp = app_with_metadata("");
        let tools_manifest = write_artifact_manifest_with_relatives(
            &temp,
            "tools.toml",
            "oliphaunt-tools",
            "0.1.0",
            "native-tools",
            "x86_64-unknown-linux-gnu",
            None,
            &["runtime/bin/pg_dump"],
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            artifact_manifest_paths: vec![tools_manifest],
        };

        let error = context
            .read_artifact_manifests()
            .expect_err("native tools without psql must fail validation");

        assert!(error.to_string().contains("missing required payload"));
        assert!(error.to_string().contains("runtime/bin/psql"));
    }

    #[test]
    fn artifact_manifest_rejects_wasix_pg_ctl_tool_payload() {
        let temp = app_with_metadata("");
        let tools_manifest = write_artifact_manifest_with_relatives(
            &temp,
            "wasix-tools.toml",
            "oliphaunt-wasix-tools",
            "0.1.0",
            "wasix-tools",
            "portable",
            None,
            &[
                "bin/pg_dump.wasix.wasm",
                "bin/psql.wasix.wasm",
                "bin/pg_ctl.wasix.wasm",
            ],
        );
        let context = BuildContext {
            manifest_dir: temp.path().to_path_buf(),
            out_dir: temp.path().join("out"),
            target: "wasm32-wasip1".to_owned(),
            artifact_manifest_paths: vec![tools_manifest],
        };

        let error = context
            .read_artifact_manifests()
            .expect_err("WASIX tools must not contain pg_ctl");

        assert!(error.to_string().contains("must not contain payload"));
        assert!(error.to_string().contains("bin/pg_ctl.wasix.wasm"));
    }

    fn app_with_metadata(metadata: &str) -> TempDir {
        let temp = TempDir::new().unwrap();
        let manifest = format!(
            r#"[package]
name = "app"
version = "0.1.0"
edition = "2024"
{metadata}
"#,
        );
        fs::write(temp.path().join("Cargo.toml"), manifest).unwrap();
        temp
    }

    fn write_artifact_manifest(
        temp: &TempDir,
        manifest_name: &str,
        product: &str,
        version: &str,
        kind: &str,
        target: &str,
        extension: Option<&str>,
        relative: &str,
    ) -> PathBuf {
        let relatives = test_artifact_relatives(kind, relative);
        let relative_refs: Vec<&str> = relatives.iter().map(String::as_str).collect();
        write_artifact_manifest_with_relatives(
            temp,
            manifest_name,
            product,
            version,
            kind,
            target,
            extension,
            &relative_refs,
        )
    }

    fn write_artifact_manifest_with_relatives(
        temp: &TempDir,
        manifest_name: &str,
        product: &str,
        version: &str,
        kind: &str,
        target: &str,
        extension: Option<&str>,
        relatives: &[&str],
    ) -> PathBuf {
        let extension_line = extension
            .map(|value| format!("extension = {value:?}\n"))
            .unwrap_or_default();
        let mut manifest = format!(
            r#"schema = "oliphaunt-artifact-manifest-v1"
product = {product:?}
version = {version:?}
kind = {kind:?}
target = {target:?}
{extension_line}
"#,
        );
        let source_root = temp.path().join("artifacts").join(manifest_name);
        for relative in relatives {
            let source = source_root.join(relative.replace(['/', '\\'], "_"));
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            let mut file = fs::File::create(&source).unwrap();
            write!(file, "{product}:{kind}:{target}:{relative}").unwrap();
            let bytes = fs::read(&source).unwrap();
            let sha256 = sha256_hex(&bytes);
            manifest.push_str(&format!(
                r#"
[[files]]
source = "{}"
relative = {relative:?}
sha256 = {sha256:?}
executable = true
"#,
                source.display(),
            ));
        }
        let path = temp.path().join(manifest_name);
        fs::write(&path, manifest).unwrap();
        path
    }

    fn test_artifact_relatives(kind: &str, primary: &str) -> Vec<String> {
        let mut relatives = match kind {
            "native-runtime" => vec![
                "runtime/bin/postgres".to_owned(),
                "runtime/bin/initdb".to_owned(),
                "runtime/bin/pg_ctl".to_owned(),
            ],
            "native-tools" => vec![
                "runtime/bin/pg_dump".to_owned(),
                "runtime/bin/psql".to_owned(),
            ],
            "wasix-runtime" => vec![
                "manifest.json".to_owned(),
                "oliphaunt.wasix.tar.zst".to_owned(),
                "prepopulated/pgdata-template.tar.zst".to_owned(),
                "prepopulated/pgdata-template.json".to_owned(),
                "bin/initdb.wasix.wasm".to_owned(),
            ],
            "wasix-tools" => vec![
                "bin/pg_dump.wasix.wasm".to_owned(),
                "bin/psql.wasix.wasm".to_owned(),
            ],
            "wasix-aot" => vec![
                "manifest.json".to_owned(),
                "oliphaunt-llvm-opta.bin.zst".to_owned(),
                "initdb-llvm-opta.bin.zst".to_owned(),
            ],
            "wasix-tools-aot" => vec![
                "manifest.json".to_owned(),
                "pg_dump-llvm-opta.bin.zst".to_owned(),
                "psql-llvm-opta.bin.zst".to_owned(),
            ],
            _ => vec![primary.to_owned()],
        };
        if !relatives.iter().any(|relative| relative == primary) {
            relatives.push(primary.to_owned());
        }
        relatives
    }
}
