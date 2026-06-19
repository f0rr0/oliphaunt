use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, anyhow, bail, ensure};
use directories::ProjectDirs;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;
use tracing::info;
use zstd::stream::read::Decoder as ZstdDecoder;

use super::postgres_mod::PostgresMod;
use super::timing;
use crate::oliphaunt::assets;
#[cfg(feature = "extensions")]
use crate::oliphaunt::client::Oliphaunt;
#[cfg(feature = "extensions")]
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
use crate::oliphaunt::data_dir::unpack_pgdata_archive;
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use tempfile::TempDir;

mod template_clone;

use template_clone::clone_pgdata_template_dir;

const RUNTIME_ARCHIVE_NAME: &str = "oliphaunt.wasix.tar.zst";
const PGDATA_TEMPLATE_ARCHIVE_NAME: &str = "pgdata-template.tar.zst";
const MOUNTFS_RUNTIME_MARKER: &str = ".oliphaunt-wasix-mountfs-runtime";
const RUNTIME_LAYOUT_MANIFEST_NAME: &str = ".oliphaunt-wasix-runtime-layout.json";
const PGDATA_OVERLAY_MANIFEST_NAME: &str = ".oliphaunt-wasix-pgdata-overlay.json";
// Bump these when cache materialization semantics change; old mutable PGDATA
// template caches may have been modified by earlier clone strategies.
const PGDATA_TEMPLATE_CACHE_FORMAT: &str = "v2";
#[cfg(feature = "extensions")]
const EXTENSION_PGDATA_TEMPLATE_CACHE_FORMAT: &str = "v5";
const DEFAULT_PASSWORD_FILE: &[u8] = b"password\n";

static RUNTIME_CACHE: OnceLock<std::result::Result<Arc<CachedRuntime>, String>> = OnceLock::new();
static PGDATA_TEMPLATE_CACHE: OnceLock<std::result::Result<Arc<CachedPgDataTemplate>, String>> =
    OnceLock::new();
static PGDATA_TEMPLATE_MANIFEST: OnceLock<std::result::Result<PgDataTemplateManifest, String>> =
    OnceLock::new();
#[cfg(feature = "extensions")]
static EXTENSION_TEMPLATE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static ROOT_LOCKED_PATHS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
const TEMPLATE_RUNTIME_STATE_FILES: &[&str] = &["postmaster.pid", "postmaster.opts"];

#[cfg(feature = "extensions")]
fn extension_template_cache_enabled() -> bool {
    std::env::var_os("OLIPHAUNT_WASM_EXTENSION_TEMPLATE_CACHE")
        .and_then(|value| value.into_string().ok())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
}

#[derive(Debug)]
struct CachedRuntime {
    runtime_root: PathBuf,
}

#[derive(Debug)]
struct CachedPgDataTemplate {
    pgdata: PathBuf,
}

#[cfg(feature = "extensions")]
#[derive(Debug)]
struct CachedExtensionPgDataTemplate {
    pgdata: PathBuf,
    manifest: ExtensionPgDataTemplateManifest,
}

#[derive(Debug, Clone)]
pub struct OliphauntPaths {
    pub pgroot: PathBuf,
    pub pgdata: PathBuf,
}

#[derive(Debug)]
pub(crate) struct RootLock {
    path: PathBuf,
    _file: File,
}

#[derive(Debug)]
struct CacheLock {
    _file: File,
}

#[derive(Debug)]
pub(crate) struct PreparedRoot {
    pub(crate) root: PathBuf,
    pub(crate) temp_dir: Option<TempDir>,
    pub(crate) root_lock: Option<RootLock>,
    pub(crate) outcome: InstallOutcome,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeLayout {
    pub(crate) kind: RuntimeLayoutKind,
    #[cfg(feature = "extensions")]
    pub(crate) local_root: PathBuf,
    pub(crate) module_root: PathBuf,
    pub(crate) pgdata_template_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RuntimeLayoutKind {
    FullLocal,
    SharedRuntimeOverlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLayoutManifest {
    kind: RuntimeLayoutKind,
    source_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PgDataOverlayManifest {
    template_archive_sha256: String,
    postgres_version: String,
    #[serde(default)]
    source_lane: Option<String>,
    #[serde(default)]
    source_fingerprint: Option<String>,
    #[serde(default)]
    extension_sql_names: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeLayoutPolicy {
    Auto,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    FullLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClusterPolicy {
    ExistingOrTemplate,
    ExistingOrFreshInitdb,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RootPrepareOptions {
    pub(crate) runtime: RuntimeLayoutPolicy,
    pub(crate) cluster: ClusterPolicy,
}

#[derive(Debug, Clone)]
pub(crate) struct RootPlan {
    pub(crate) target: RootTarget,
    pub(crate) source: RootSource,
    #[cfg(feature = "extensions")]
    pub(crate) extensions: Vec<Extension>,
    #[cfg(feature = "extensions")]
    pub(crate) postgres_config: PostgresConfig,
}

#[derive(Debug, Clone)]
pub(crate) enum RootTarget {
    Path(PathBuf),
    AppId {
        qualifier: String,
        organization: String,
        application: String,
    },
    Temporary,
}

#[derive(Debug, Clone)]
pub(crate) enum RootSource {
    Template,
    FreshInitdb,
    DataDirArchive(Vec<u8>),
}

impl RootPlan {
    pub(crate) fn new(target: RootTarget, source: RootSource) -> Self {
        Self {
            target,
            source,
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
            #[cfg(feature = "extensions")]
            postgres_config: PostgresConfig::default(),
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn with_extensions(
        mut self,
        extensions: Vec<Extension>,
        postgres_config: PostgresConfig,
    ) -> Self {
        self.extensions = extensions;
        self.postgres_config = postgres_config;
        self
    }
}

impl RootPrepareOptions {
    pub(crate) fn template() -> Self {
        Self {
            runtime: RuntimeLayoutPolicy::Auto,
            cluster: ClusterPolicy::ExistingOrTemplate,
        }
    }

    pub(crate) fn fresh() -> Self {
        Self {
            runtime: RuntimeLayoutPolicy::Auto,
            cluster: ClusterPolicy::ExistingOrFreshInitdb,
        }
    }
}

impl RuntimeLayout {
    pub(crate) fn module_path(&self) -> PathBuf {
        self.module_root.join("bin/oliphaunt")
    }

    pub(crate) fn uses_shared_overlay(&self) -> bool {
        self.kind == RuntimeLayoutKind::SharedRuntimeOverlay
    }
}

/// Files exported by [`build_pgdata_template`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgDataTemplate {
    pub archive_path: PathBuf,
    pub manifest_path: PathBuf,
}

/// Manifest that binds a PGDATA template to the Oliphaunt WASIX runtime it was
/// created with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PgDataTemplateManifest {
    pub postgres_version: String,
    #[serde(default)]
    pub source_lane: Option<String>,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    pub wasm_sha256: String,
    pub archive_sha256: String,
    #[serde(default)]
    pub architecture_independent: bool,
}

#[cfg(feature = "extensions")]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExtensionPgDataTemplateManifest {
    version: u32,
    postgres_version: String,
    #[serde(default)]
    source_lane: Option<String>,
    #[serde(default)]
    source_fingerprint: Option<String>,
    base_template_archive_sha256: String,
    base_template_wasm_sha256: String,
    extension_sql_names: Vec<String>,
    extension_archive_sha256s: Vec<String>,
    postgres_config: Vec<(String, String)>,
    cache_key: String,
}

impl OliphauntPaths {
    pub fn new(app_qual: (&str, &str, &str)) -> Result<Self> {
        let pd = ProjectDirs::from(app_qual.0, app_qual.1, app_qual.2)
            .context("could not resolve app data dir")?;
        let app_dir = pd.data_dir().to_path_buf();
        Ok(Self::with_root(app_dir))
    }

    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        let base = root.into();
        let pgroot = base.join("tmp");
        let pgdata = pgroot.join("oliphaunt").join("base");
        Self { pgroot, pgdata }
    }

    pub fn with_paths(pgroot: impl Into<PathBuf>, pgdata: impl Into<PathBuf>) -> Self {
        Self {
            pgroot: pgroot.into(),
            pgdata: pgdata.into(),
        }
    }

    pub fn mount_root(&self) -> &Path {
        &self.pgroot
    }

    pub(crate) fn install_root(&self) -> &Path {
        self.pgroot.parent().unwrap_or(&self.pgroot)
    }

    pub(crate) fn runtime_root(&self) -> PathBuf {
        self.pgroot.join("oliphaunt")
    }

    pub fn with_temp_dir() -> Result<(TempDir, Self)> {
        let tmp = TempDir::new().context("create temporary directory")?;
        let paths = Self::with_root(tmp.path());
        Ok((tmp, paths))
    }

    fn marker_cluster(&self) -> PathBuf {
        self.pgdata.join("PG_VERSION")
    }

    fn marker_control_file(&self) -> PathBuf {
        self.pgdata.join("global").join("pg_control")
    }

    pub fn is_cluster_initialized(&self) -> bool {
        cluster_is_complete(self)
    }
}

impl RootLock {
    pub(crate) fn acquire(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)
            .with_context(|| format!("create Oliphaunt root {}", root.display()))?;
        let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        {
            let mut locked = ROOT_LOCKED_PATHS
                .get_or_init(|| Mutex::new(BTreeSet::new()))
                .lock()
                .expect("root lock path set poisoned");
            ensure!(
                locked.insert(canonical_root.clone()),
                "Oliphaunt root is already in use: {}",
                root.display()
            );
        }
        let path = root.join(".oliphaunt-wasix.lock");
        let file = match open_root_lock_file(&path) {
            Ok(file) => file,
            Err(err) => {
                release_root_lock_path(&canonical_root);
                return Err(err).with_context(|| {
                    format!(
                        "Oliphaunt root is already in use or unavailable: {}",
                        root.display()
                    )
                });
            }
        };
        if let Err(err) = file.try_lock() {
            release_root_lock_path(&canonical_root);
            return Err(err)
                .with_context(|| format!("Oliphaunt root is already in use: {}", root.display()));
        }
        Ok(Self {
            path: canonical_root,
            _file: file,
        })
    }

    pub(crate) fn acquire_for_paths(paths: &OliphauntPaths) -> Result<Self> {
        Self::acquire(paths.install_root())
    }
}

impl Drop for RootLock {
    fn drop(&mut self) {
        let _ = self._file.unlock();
        release_root_lock_path(&self.path);
    }
}

fn open_root_lock_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        options.share_mode(0);
    }
    options.open(path)
}

fn release_root_lock_path(path: &Path) {
    if let Some(locked) = ROOT_LOCKED_PATHS.get() {
        locked
            .lock()
            .expect("root lock path set poisoned")
            .remove(path);
    }
}

impl CacheLock {
    fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create cache lock directory {}", parent.display()))?;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open cache lock {}", path.display()))?;
        file.lock()
            .with_context(|| format!("lock cache {}", path.display()))?;
        Ok(Self { _file: file })
    }
}

fn locate_runtime_module(paths: &OliphauntPaths) -> Option<(PathBuf, PathBuf)> {
    let oliphaunt_dir = paths.pgroot.join("oliphaunt");
    if !oliphaunt_dir.exists() {
        return None;
    }
    let oliphaunt_bin_dir = oliphaunt_dir.join("bin");
    let module = oliphaunt_bin_dir.join("oliphaunt");
    if !module.exists() {
        return None;
    }

    let share = oliphaunt_dir.join("share").join("postgresql");
    let required_share_files = [
        "postgres.bki",
        "timezonesets/Default",
        "timezone/UTC",
        "timezone/America/New_York",
    ];
    if !share.exists()
        || required_share_files
            .iter()
            .any(|relative| !share.join(relative).is_file())
    {
        return None;
    }
    Some((module, oliphaunt_bin_dir))
}

fn ensure_full_runtime(paths: &OliphauntPaths) -> Result<bool> {
    let _phase = timing::phase("runtime.ensure");
    let source_key = runtime_cache_key()?;
    let existing_runtime = {
        let _phase = timing::phase("runtime.locate_existing");
        locate_runtime_module(paths)
    };
    if existing_runtime.is_some() {
        let source_key_matches = full_runtime_layout_matches_current(paths, &source_key)?;
        let repaired_runtime = if !source_key_matches || runtime_support_files_need_repair(paths)? {
            install_runtime_from_tar(paths)?
        } else {
            false
        };
        write_runtime_layout_manifest(
            &paths.runtime_root(),
            RuntimeLayoutKind::FullLocal,
            &source_key,
        )?;
        ensure_runtime_password_file(&paths.runtime_root())?;
        return Ok(repaired_runtime);
    }

    if let Some(parent) = paths.pgroot.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create parent directory {}", parent.display()))?;
    } else {
        fs::create_dir_all(&paths.pgroot).context("create pgroot dir")?;
    }

    install_runtime_from_tar(paths)?;
    locate_runtime_module(paths).ok_or_else(|| {
        anyhow!(
            "runtime missing: could not locate module under {} after archive install",
            paths.pgroot.display()
        )
    })?;
    write_runtime_layout_manifest(
        &paths.runtime_root(),
        RuntimeLayoutKind::FullLocal,
        &source_key,
    )?;
    ensure_runtime_password_file(&paths.runtime_root())?;

    Ok(true)
}

fn full_runtime_layout_matches_current(
    paths: &OliphauntPaths,
    expected_source_key: &str,
) -> Result<bool> {
    let Some(manifest) = read_runtime_layout_manifest(&paths.runtime_root())? else {
        return Ok(false);
    };
    Ok(manifest.kind == RuntimeLayoutKind::FullLocal && manifest.source_key == expected_source_key)
}

fn runtime_support_files_need_repair(paths: &OliphauntPaths) -> Result<bool> {
    for relative in [
        "password",
        "share/postgresql/postgres.bki",
        "share/postgresql/system_views.sql",
        "share/postgresql/timezonesets/Default",
    ] {
        let path = paths.runtime_root().join(relative);
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
            Ok(_) => return Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(err) => return Err(err).with_context(|| format!("stat {}", path.display())),
        }
    }
    Ok(false)
}

fn runtime_tar_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("OLIPHAUNT_WASM_RUNTIME_ARCHIVE")
        .or_else(|_| std::env::var("OLIPHAUNT_WASM_RUNTIME_TAR"))
    {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn install_runtime_from_tar(paths: &OliphauntPaths) -> Result<bool> {
    let _phase = timing::phase("runtime.archive_install");
    if let Some(tar_path) = runtime_tar_path() {
        info!("installing runtime from tar archive {}", tar_path.display());
        let file = fs::File::open(&tar_path)
            .with_context(|| format!("open runtime archive {}", tar_path.display()))?;
        unpack_runtime_archive_reader(file, &tar_path, &paths.pgroot)?;
    } else if let Some(runtime_archive) = assets::runtime_archive() {
        info!("installing embedded runtime archive");
        maybe_validate_embedded_runtime_archive(runtime_archive)?;
        unpack_runtime_archive_reader(
            Cursor::new(runtime_archive),
            Path::new(RUNTIME_ARCHIVE_NAME),
            &paths.pgroot,
        )?;
    } else {
        bail!(
            "no embedded Oliphaunt runtime assets are available; enable the `bundled` feature or set OLIPHAUNT_WASM_RUNTIME_ARCHIVE"
        );
    }

    Ok(true)
}

#[cfg(feature = "bundled")]
fn maybe_validate_embedded_runtime_archive(bytes: &[u8]) -> Result<()> {
    if strict_asset_verification()? {
        validate_embedded_runtime_archive_strict(bytes)?;
    }
    Ok(())
}

#[cfg(feature = "bundled")]
fn validate_embedded_runtime_archive_strict(bytes: &[u8]) -> Result<()> {
    let expected = assets::expected_runtime_archive_sha256()?;
    let actual = sha256_hex(bytes);
    ensure!(
        actual.eq_ignore_ascii_case(&expected),
        "embedded runtime archive hash mismatch: manifest={expected} actual={actual}"
    );
    Ok(())
}

#[cfg(not(feature = "bundled"))]
fn maybe_validate_embedded_runtime_archive(_bytes: &[u8]) -> Result<()> {
    Ok(())
}

fn unpack_runtime_archive_reader<R: Read>(
    reader: R,
    archive_path: &Path,
    destination: &Path,
) -> Result<()> {
    let _phase = timing::phase("runtime.archive_unpack");
    let decoder = ZstdDecoder::new(reader)
        .with_context(|| format!("decode zstd runtime archive {}", archive_path.display()))?;
    let mut archive = Archive::new(decoder);

    unpack_archive_entries_with_path_map(&mut archive, destination, runtime_archive_relative_path)
        .with_context(|| format!("unpack runtime archive {}", archive_path.display()))?;

    Ok(())
}

fn runtime_archive_relative_path(path: &Path) -> &Path {
    let mut without_dot = path;
    if let Ok(stripped) = without_dot.strip_prefix(".") {
        without_dot = stripped;
    }
    without_dot.strip_prefix("tmp").unwrap_or(without_dot)
}

fn archive_destination(root: &Path, archive_path: &Path) -> Result<PathBuf> {
    let mut dest = root.to_path_buf();
    for component in archive_path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => dest.push(part),
            _ => bail!("unsafe archive path {}", archive_path.display()),
        }
    }
    Ok(dest)
}

fn install_extension_reader<R: Read>(paths: &OliphauntPaths, mut reader: R) -> Result<()> {
    let _phase = timing::phase("extension.archive_install");
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .context("read extension archive")?;
    let archive_reader: Box<dyn Read> = if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        Box::new(ZstdDecoder::new(Cursor::new(bytes)).context("decode zstd extension archive")?)
    } else if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(GzDecoder::new(Cursor::new(bytes)))
    } else {
        Box::new(Cursor::new(bytes))
    };
    let mut ar = Archive::new(archive_reader);
    let target = paths.pgroot.join("oliphaunt");
    std::fs::create_dir_all(&target)
        .with_context(|| format!("create extension target {}", target.display()))?;
    unpack_archive_entries(&mut ar, &target)
        .with_context(|| format!("unpack extension into {}", target.display()))?;
    Ok(())
}

pub fn install_extension_archive(paths: &OliphauntPaths, archive_path: &Path) -> Result<()> {
    let file = std::fs::File::open(archive_path)
        .with_context(|| format!("open extension archive {}", archive_path.display()))?;
    install_extension_reader(paths, file)
}

pub fn install_extension_bytes(paths: &OliphauntPaths, bytes: &[u8]) -> Result<()> {
    install_extension_reader(paths, std::io::Cursor::new(bytes))
}

#[cfg(feature = "extensions")]
pub(crate) fn install_bundled_extension_bytes(
    paths: &OliphauntPaths,
    sql_name: &str,
    bytes: &[u8],
) -> Result<()> {
    if strict_asset_verification()? {
        validate_bundled_extension_archive_strict(sql_name, bytes)?;
    }
    install_extension_bytes(paths, bytes)
}

#[cfg(feature = "extensions")]
fn validate_bundled_extension_archive_strict(sql_name: &str, bytes: &[u8]) -> Result<()> {
    let expected = assets::expected_extension_archive_sha256(sql_name)?;
    let actual = sha256_hex(bytes);
    ensure!(
        actual.eq_ignore_ascii_case(&expected),
        "embedded extension archive '{sql_name}' hash mismatch: manifest={expected} actual={actual}"
    );
    Ok(())
}

pub fn build_pgdata_template(output_dir: impl AsRef<Path>) -> Result<PgDataTemplate> {
    let output_dir = output_dir.as_ref();
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create template output dir {}", output_dir.display()))?;

    let archive_path = output_dir.join(PGDATA_TEMPLATE_ARCHIVE_NAME);
    let manifest_path = output_dir.join("pgdata-template.json");

    let Some(archive) = assets::pgdata_template_archive() else {
        bail!("bundled PGDATA template archive is unavailable");
    };
    let Some(manifest) = assets::pgdata_template_manifest() else {
        bail!("bundled PGDATA template manifest is unavailable");
    };
    validated_embedded_pgdata_template_manifest()?
        .context("bundled PGDATA template manifest is unavailable")?;

    fs::write(&archive_path, archive)
        .with_context(|| format!("write template archive {}", archive_path.display()))?;
    fs::write(&manifest_path, manifest)
        .with_context(|| format!("write template manifest {}", manifest_path.display()))?;

    Ok(PgDataTemplate {
        archive_path,
        manifest_path,
    })
}

fn try_install_embedded_pgdata_template(
    paths: &OliphauntPaths,
    module_path: &Path,
) -> Result<bool> {
    let _phase = timing::phase("pgdata.embedded_template_install");
    if cluster_is_complete(paths) {
        return Ok(false);
    }

    let Some(manifest) = validated_embedded_pgdata_template_manifest()? else {
        return Ok(false);
    };

    ensure_module_matches_template(module_path, &manifest)?;
    let template = pgdata_template_cache()?;

    if let Some(parent) = paths.pgdata.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create pgdata parent {}", parent.display()))?;
    }
    if paths.pgdata.exists() {
        fs::remove_dir_all(&paths.pgdata)
            .with_context(|| format!("remove existing pgdata {}", paths.pgdata.display()))?;
    }
    {
        let _phase = timing::phase("pgdata.cached_template_clone");
        clone_pgdata_template_dir(&template.pgdata, &paths.pgdata)?;
    }
    remove_template_runtime_state(&paths.pgdata)?;
    Ok(true)
}

fn try_prepare_pgdata_template_overlay(
    paths: &OliphauntPaths,
    module_path: &Path,
    runtime_layout: &mut RuntimeLayout,
) -> Result<bool> {
    let _phase = timing::phase("pgdata.overlay_prepare");
    let Some(manifest) = validated_embedded_pgdata_template_manifest()? else {
        return Ok(false);
    };

    ensure_module_matches_template(module_path, &manifest)?;
    let template = pgdata_template_cache()?;
    if let Some(existing) = read_pgdata_overlay_manifest(paths)? {
        ensure!(
            existing.template_archive_sha256 == manifest.archive_sha256,
            "PGDATA overlay at {} was created for template {}, but this runtime provides {}; delete the root/cache and recreate it",
            paths.pgdata.display(),
            existing.template_archive_sha256,
            manifest.archive_sha256
        );
    } else if paths.pgdata.exists() && !cluster_is_complete(paths) {
        fs::remove_dir_all(&paths.pgdata).with_context(|| {
            format!(
                "remove interrupted PGDATA before overlay setup at {}",
                paths.pgdata.display()
            )
        })?;
    }

    fs::create_dir_all(&paths.pgdata)
        .with_context(|| format!("create PGDATA overlay upper {}", paths.pgdata.display()))?;
    fs::write(
        paths.pgdata.join("PG_VERSION"),
        format!("{}\n", manifest.postgres_version.trim()),
    )
    .with_context(|| format!("write {}", paths.pgdata.join("PG_VERSION").display()))?;
    write_pgdata_overlay_manifest(paths, &manifest)?;
    remove_template_runtime_state(&paths.pgdata)?;
    runtime_layout.pgdata_template_root = Some(template.pgdata.clone());
    Ok(true)
}

#[cfg(feature = "extensions")]
fn install_extension_template_into_outcome(
    outcome: &mut InstallOutcome,
    extensions: &[Extension],
    postgres_config: &PostgresConfig,
) -> Result<()> {
    let normalized = normalize_extension_set(extensions);
    if normalized.is_empty() {
        return Ok(());
    }

    let template = extension_pgdata_template_cache(
        &normalized,
        &outcome.runtime_layout.module_path(),
        postgres_config,
    )?;
    if outcome.runtime_layout.uses_shared_overlay() && pgdata_overlay_enabled() {
        install_pgdata_template_overlay_from_extension_template(
            &outcome.paths,
            &mut outcome.runtime_layout,
            &template,
        )?;
    } else {
        install_pgdata_template_clone_from_extension_template(&outcome.paths, &template)?;
        outcome.runtime_layout.pgdata_template_root = None;
    }

    for extension in &normalized {
        let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
            anyhow!(
                "extension asset '{}' is not bundled in this oliphaunt-wasix build",
                extension.sql_name()
            )
        })?;
        install_bundled_extension_bytes(&outcome.paths, extension.sql_name(), bytes)?;
    }
    outcome.preinstalled_extensions = template.manifest.extension_sql_names.clone();
    Ok(())
}

#[cfg(feature = "extensions")]
fn install_pgdata_template_overlay_from_extension_template(
    paths: &OliphauntPaths,
    runtime_layout: &mut RuntimeLayout,
    template: &CachedExtensionPgDataTemplate,
) -> Result<()> {
    let _phase = timing::phase("pgdata.extension_template_overlay");
    if paths.pgdata.exists() {
        fs::remove_dir_all(&paths.pgdata).with_context(|| {
            format!(
                "remove PGDATA before extension overlay {}",
                paths.pgdata.display()
            )
        })?;
    }
    fs::create_dir_all(&paths.pgdata)
        .with_context(|| format!("create PGDATA overlay upper {}", paths.pgdata.display()))?;
    fs::write(
        paths.pgdata.join("PG_VERSION"),
        format!("{}\n", template.manifest.postgres_version.trim()),
    )
    .with_context(|| format!("write {}", paths.pgdata.join("PG_VERSION").display()))?;
    write_pgdata_overlay_manifest_values(
        paths,
        &template.manifest.cache_key,
        &template.manifest.postgres_version,
        template.manifest.source_lane.as_deref(),
        template.manifest.source_fingerprint.as_deref(),
        &template.manifest.extension_sql_names,
    )?;
    remove_template_runtime_state(&paths.pgdata)?;
    runtime_layout.pgdata_template_root = Some(template.pgdata.clone());
    Ok(())
}

#[cfg(feature = "extensions")]
fn install_pgdata_template_clone_from_extension_template(
    paths: &OliphauntPaths,
    template: &CachedExtensionPgDataTemplate,
) -> Result<()> {
    let _phase = timing::phase("pgdata.extension_template_clone");
    if paths.pgdata.exists() {
        fs::remove_dir_all(&paths.pgdata).with_context(|| {
            format!(
                "remove PGDATA before extension template clone {}",
                paths.pgdata.display()
            )
        })?;
    }
    if let Some(parent) = paths.pgdata.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create pgdata parent {}", parent.display()))?;
    }
    clone_pgdata_template_dir(&template.pgdata, &paths.pgdata)?;
    remove_template_runtime_state(&paths.pgdata)?;
    Ok(())
}

fn pgdata_overlay_manifest_path(paths: &OliphauntPaths) -> PathBuf {
    paths.pgdata.join(PGDATA_OVERLAY_MANIFEST_NAME)
}

fn pgdata_overlay_is_installed(paths: &OliphauntPaths) -> bool {
    pgdata_overlay_manifest_path(paths).is_file()
}

fn read_pgdata_overlay_manifest(paths: &OliphauntPaths) -> Result<Option<PgDataOverlayManifest>> {
    let path = pgdata_overlay_manifest_path(paths);
    match fs::read(&path) {
        Ok(bytes) => {
            let manifest = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse PGDATA overlay manifest {}", path.display()))?;
            Ok(Some(manifest))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
    }
}

fn write_pgdata_overlay_manifest(
    paths: &OliphauntPaths,
    manifest: &PgDataTemplateManifest,
) -> Result<()> {
    write_pgdata_overlay_manifest_values(
        paths,
        &manifest.archive_sha256,
        &manifest.postgres_version,
        manifest.source_lane.as_deref(),
        manifest.source_fingerprint.as_deref(),
        &[],
    )
}

fn write_pgdata_overlay_manifest_values(
    paths: &OliphauntPaths,
    template_archive_sha256: &str,
    postgres_version: &str,
    source_lane: Option<&str>,
    source_fingerprint: Option<&str>,
    extension_sql_names: &[String],
) -> Result<()> {
    let overlay = PgDataOverlayManifest {
        template_archive_sha256: template_archive_sha256.to_owned(),
        postgres_version: postgres_version.to_owned(),
        source_lane: source_lane.map(str::to_owned),
        source_fingerprint: source_fingerprint.map(str::to_owned),
        extension_sql_names: extension_sql_names.to_vec(),
    };
    fs::write(
        pgdata_overlay_manifest_path(paths),
        serde_json::to_vec_pretty(&overlay)?,
    )
    .with_context(|| {
        format!(
            "write PGDATA overlay manifest {}",
            pgdata_overlay_manifest_path(paths).display()
        )
    })?;
    Ok(())
}

fn ensure_module_matches_template(
    module_path: &Path,
    manifest: &PgDataTemplateManifest,
) -> Result<()> {
    if !strict_asset_verification()? {
        #[cfg(feature = "bundled")]
        if runtime_tar_path().is_none() {
            let expected = assets::expected_module_sha256("runtime:oliphaunt")?;
            ensure!(
                expected.eq_ignore_ascii_case(&manifest.wasm_sha256),
                "embedded PGDATA template wasm hash mismatch: manifest={} assets={expected}",
                manifest.wasm_sha256
            );
        }
        return Ok(());
    }

    let actual_wasm = sha256_file(module_path)?;
    ensure!(
        actual_wasm.eq_ignore_ascii_case(&manifest.wasm_sha256),
        "embedded PGDATA template wasm hash mismatch: manifest={} actual={actual_wasm}",
        manifest.wasm_sha256
    );
    Ok(())
}

fn validated_embedded_pgdata_template_manifest() -> Result<Option<PgDataTemplateManifest>> {
    let Some(template_manifest) = assets::pgdata_template_manifest() else {
        return Ok(None);
    };
    let Some(template_archive) = assets::pgdata_template_archive() else {
        return Ok(None);
    };

    let manifest = PGDATA_TEMPLATE_MANIFEST
        .get_or_init(|| {
            let manifest: PgDataTemplateManifest = serde_json::from_slice(template_manifest)
                .context("parse embedded PGDATA template manifest")
                .map_err(|err| format!("{err:#}"))?;
            if !manifest.architecture_independent {
                return Err(
                    "embedded PGDATA template manifest must set architectureIndependent=true"
                        .to_string(),
                );
            }
            validate_pgdata_template_manifest_metadata(&manifest)
                .map_err(|err| format!("{err:#}"))?;

            Ok(manifest)
        })
        .clone()
        .map_err(|message| anyhow!(message))?;
    if strict_asset_verification()? {
        let actual_archive = sha256_hex(template_archive);
        ensure!(
            actual_archive.eq_ignore_ascii_case(&manifest.archive_sha256),
            "embedded PGDATA template archive hash mismatch: manifest={} actual={actual_archive}",
            manifest.archive_sha256
        );
    }
    Ok(Some(manifest))
}

#[cfg(feature = "bundled")]
fn validate_pgdata_template_manifest_metadata(manifest: &PgDataTemplateManifest) -> Result<()> {
    let metadata = assets::asset_manifest_metadata()?;
    let asset_source_lane = metadata
        .source_lane
        .as_deref()
        .context("asset manifest is missing source-lane metadata")?;
    let template_source_lane = manifest
        .source_lane
        .as_deref()
        .context("embedded PGDATA template manifest is missing source-lane metadata")?;
    ensure!(
        template_source_lane == asset_source_lane,
        "embedded PGDATA template source lane mismatch: template={} assets={asset_source_lane}",
        template_source_lane
    );
    if let Some(pgdata_source_lane) = metadata.pgdata_template_source_lane.as_deref() {
        ensure!(
            template_source_lane == pgdata_source_lane,
            "embedded PGDATA template source lane mismatch: template={} asset-entry={pgdata_source_lane}",
            template_source_lane
        );
    }

    if let Some(expected) = metadata.pgdata_template_postgres_version.as_deref() {
        ensure!(
            manifest.postgres_version == expected,
            "embedded PGDATA template PostgreSQL version mismatch: template={} asset-entry={expected}",
            manifest.postgres_version
        );
    }

    let expected_fingerprint = metadata
        .pgdata_template_source_fingerprint
        .as_deref()
        .or(metadata.source_fingerprint.as_deref());
    if let Some(expected) = expected_fingerprint {
        ensure!(
            manifest.source_fingerprint.as_deref() == Some(expected),
            "embedded PGDATA template source fingerprint mismatch: template={} assets={expected}",
            manifest
                .source_fingerprint
                .as_deref()
                .unwrap_or("<missing>")
        );
    }

    Ok(())
}

#[cfg(not(feature = "bundled"))]
fn validate_pgdata_template_manifest_metadata(_manifest: &PgDataTemplateManifest) -> Result<()> {
    Ok(())
}

fn pgdata_template_cache() -> Result<Arc<CachedPgDataTemplate>> {
    PGDATA_TEMPLATE_CACHE
        .get_or_init(|| {
            build_pgdata_template_cache()
                .map(Arc::new)
                .map_err(|err| format!("{err:#}"))
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

fn build_pgdata_template_cache() -> Result<CachedPgDataTemplate> {
    let _phase = timing::phase("pgdata.template_cache_install");
    let Some(manifest) = validated_embedded_pgdata_template_manifest()? else {
        bail!("embedded PGDATA template manifest is unavailable");
    };
    let Some(template_archive) = assets::pgdata_template_archive() else {
        bail!("embedded PGDATA template archive is unavailable");
    };

    let dirs = ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")?;
    let cache_root = dirs
        .cache_dir()
        .join("pgdata-template")
        .join(PGDATA_TEMPLATE_CACHE_FORMAT);
    let _cache_lock = CacheLock::acquire(
        &cache_root
            .join(".locks")
            .join(format!("{}.lock", manifest.archive_sha256)),
    )?;
    let root = cache_root.join(&manifest.archive_sha256);
    let pgdata = root.join("base");
    if pgdata.join("PG_VERSION").is_file() && pgdata.join("global/pg_control").is_file() {
        return Ok(CachedPgDataTemplate { pgdata });
    }

    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale PGDATA template cache {}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .with_context(|| format!("create PGDATA template cache {}", root.display()))?;
    let staging = root.join(format!(".base-{}-{}", std::process::id(), tmp_suffix()));
    if let Err(err) = unpack_pgdata_template_archive(template_archive, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    validate_pgdata_template_dir(&staging, &manifest)?;
    remove_template_runtime_state(&staging)?;
    fs::rename(&staging, &pgdata).with_context(|| {
        format!(
            "promote PGDATA template cache {} -> {}",
            staging.display(),
            pgdata.display()
        )
    })?;
    Ok(CachedPgDataTemplate { pgdata })
}

#[cfg(feature = "extensions")]
fn extension_pgdata_template_cache(
    extensions: &[Extension],
    module_path: &Path,
    postgres_config: &PostgresConfig,
) -> Result<Arc<CachedExtensionPgDataTemplate>> {
    let normalized = normalize_extension_set(extensions);
    ensure!(
        !normalized.is_empty(),
        "extension PGDATA template requires at least one extension"
    );

    let guard = EXTENSION_TEMPLATE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow!("extension PGDATA template cache lock was poisoned"))?;
    let template = build_extension_pgdata_template_cache(&normalized, module_path, postgres_config)
        .map(Arc::new);
    drop(guard);
    template
}

#[cfg(feature = "extensions")]
fn build_extension_pgdata_template_cache(
    extensions: &[Extension],
    module_path: &Path,
    postgres_config: &PostgresConfig,
) -> Result<CachedExtensionPgDataTemplate> {
    let _phase = timing::phase("pgdata.extension_template_cache");
    let Some(base_manifest) = validated_embedded_pgdata_template_manifest()? else {
        bail!("embedded PGDATA template manifest is unavailable");
    };
    ensure_module_matches_template(module_path, &base_manifest)?;

    let manifest = extension_pgdata_template_manifest(&base_manifest, extensions, postgres_config)?;
    let dirs = ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")?;
    let cache_root = dirs
        .cache_dir()
        .join("pgdata-extension-template")
        .join(EXTENSION_PGDATA_TEMPLATE_CACHE_FORMAT);
    let _cache_lock = CacheLock::acquire(
        &cache_root
            .join(".locks")
            .join(format!("{}.lock", manifest.cache_key)),
    )?;
    let root = cache_root.join(&manifest.cache_key);
    let pgdata = root.join("base");
    let manifest_path = root.join("extension-template.json");
    if extension_pgdata_template_is_valid(&pgdata, &manifest_path, &manifest)? {
        return Ok(CachedExtensionPgDataTemplate { pgdata, manifest });
    }

    if root.exists() {
        fs::remove_dir_all(&root).with_context(|| {
            format!(
                "remove stale extension PGDATA template cache {}",
                root.display()
            )
        })?;
    }
    fs::create_dir_all(&root)
        .with_context(|| format!("create extension PGDATA template cache {}", root.display()))?;

    let staging_root = root.join(format!(".build-{}-{}", std::process::id(), tmp_suffix()));
    if let Err(err) =
        build_extension_pgdata_template_staging(&staging_root, extensions, postgres_config)
    {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(err);
    }
    let staging_pgdata = OliphauntPaths::with_root(&staging_root).pgdata;
    validate_pgdata_template_dir(&staging_pgdata, &base_manifest)?;
    remove_template_runtime_state(&staging_pgdata)?;
    fs::rename(&staging_pgdata, &pgdata).with_context(|| {
        format!(
            "promote extension PGDATA template cache {} -> {}",
            staging_pgdata.display(),
            pgdata.display()
        )
    })?;
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).with_context(|| {
        format!(
            "write extension template manifest {}",
            manifest_path.display()
        )
    })?;
    fs::remove_dir_all(&staging_root).with_context(|| {
        format!(
            "remove extension template build dir {}",
            staging_root.display()
        )
    })?;
    Ok(CachedExtensionPgDataTemplate { pgdata, manifest })
}

#[cfg(feature = "extensions")]
fn build_extension_pgdata_template_staging(
    staging_root: &Path,
    extensions: &[Extension],
    postgres_config: &PostgresConfig,
) -> Result<()> {
    let _phase = timing::phase("pgdata.extension_template_build");
    if staging_root.exists() {
        fs::remove_dir_all(staging_root)
            .with_context(|| format!("remove stale build dir {}", staging_root.display()))?;
    }
    fs::create_dir_all(staging_root)
        .with_context(|| format!("create build dir {}", staging_root.display()))?;

    let paths = OliphauntPaths::with_root(staging_root);
    let (runtime_layout, unpacked_runtime) =
        prepare_runtime_layout(&paths, RuntimeLayoutPolicy::FullLocal)?;
    let base_template = pgdata_template_cache()?;
    clone_pgdata_template_dir(&base_template.pgdata, &paths.pgdata)?;
    remove_template_runtime_state(&paths.pgdata)?;

    let outcome = InstallOutcome {
        paths,
        unpacked_runtime,
        runtime_layout,
        preinstalled_extensions: Vec::new(),
    };
    let mut db = Oliphaunt::new_prepared_with_config(
        outcome,
        postgres_config.clone(),
        StartupConfig::default(),
    )?;
    for extension in extensions {
        db.enable_extension(*extension)?;
    }
    db.exec("CHECKPOINT", None)
        .context("checkpoint extension PGDATA template")?;
    db.close_for_template_cache()
        .context("cleanly close extension PGDATA template")?;
    Ok(())
}

#[cfg(feature = "extensions")]
fn extension_pgdata_template_is_valid(
    pgdata: &Path,
    manifest_path: &Path,
    expected: &ExtensionPgDataTemplateManifest,
) -> Result<bool> {
    if !pgdata.join("PG_VERSION").is_file() || !pgdata.join("global/pg_control").is_file() {
        return Ok(false);
    }
    let bytes = match fs::read(manifest_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err).with_context(|| format!("read {}", manifest_path.display())),
    };
    let actual: ExtensionPgDataTemplateManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    Ok(&actual == expected)
}

#[cfg(feature = "extensions")]
fn extension_pgdata_template_manifest(
    base_manifest: &PgDataTemplateManifest,
    extensions: &[Extension],
    postgres_config: &PostgresConfig,
) -> Result<ExtensionPgDataTemplateManifest> {
    let extension_sql_names: Vec<String> = extensions
        .iter()
        .map(|extension| extension.sql_name().to_owned())
        .collect();
    let extension_archive_sha256s: Vec<String> = extensions
        .iter()
        .map(|extension| assets::expected_extension_archive_sha256(extension.sql_name()))
        .collect::<Result<_>>()?;
    let postgres_config_entries = postgres_config.stable_entries();

    let mut hasher = Sha256::new();
    hasher.update(b"oliphaunt-wasix-extension-pgdata-template-v5-source-metadata\n");
    hasher.update(base_manifest.postgres_version.as_bytes());
    hasher.update(b"\n");
    if let Some(source_lane) = &base_manifest.source_lane {
        hasher.update(b"source-lane=");
        hasher.update(source_lane.as_bytes());
        hasher.update(b"\n");
    }
    if let Some(source_fingerprint) = &base_manifest.source_fingerprint {
        hasher.update(b"source-fingerprint=");
        hasher.update(source_fingerprint.as_bytes());
        hasher.update(b"\n");
    }
    hasher.update(base_manifest.archive_sha256.as_bytes());
    hasher.update(b"\n");
    hasher.update(base_manifest.wasm_sha256.as_bytes());
    hasher.update(b"\n");
    for (sql_name, archive_sha256) in extension_sql_names
        .iter()
        .zip(extension_archive_sha256s.iter())
    {
        hasher.update(sql_name.as_bytes());
        hasher.update(b":");
        hasher.update(archive_sha256.as_bytes());
        hasher.update(b"\n");
    }
    for (name, value) in &postgres_config_entries {
        hasher.update(name.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
        hasher.update(b"\n");
    }
    let cache_key = format!("{:x}", hasher.finalize());

    Ok(ExtensionPgDataTemplateManifest {
        version: 5,
        postgres_version: base_manifest.postgres_version.clone(),
        source_lane: base_manifest.source_lane.clone(),
        source_fingerprint: base_manifest.source_fingerprint.clone(),
        base_template_archive_sha256: base_manifest.archive_sha256.clone(),
        base_template_wasm_sha256: base_manifest.wasm_sha256.clone(),
        extension_sql_names,
        extension_archive_sha256s,
        postgres_config: postgres_config_entries,
        cache_key,
    })
}

#[cfg(feature = "extensions")]
fn normalize_extension_set(extensions: &[Extension]) -> Vec<Extension> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for extension in extensions {
        if seen.insert(extension.sql_name()) {
            normalized.push(*extension);
        }
    }
    normalized
}

fn validate_pgdata_template_dir(pgdata: &Path, manifest: &PgDataTemplateManifest) -> Result<()> {
    let pg_version = fs::read_to_string(pgdata.join("PG_VERSION"))
        .with_context(|| format!("read {}", pgdata.join("PG_VERSION").display()))?;
    ensure!(
        pg_version.trim() == manifest.postgres_version.trim(),
        "embedded PGDATA template postgres version mismatch: manifest={} actual={}",
        manifest.postgres_version,
        pg_version.trim()
    );
    ensure!(
        pgdata.join("global").join("pg_control").exists(),
        "embedded PGDATA template did not contain global/pg_control at archive root"
    );
    Ok(())
}

fn unpack_pgdata_template_archive(bytes: &[u8], destination: &Path) -> Result<()> {
    let _phase = timing::phase("pgdata.template_unpack");
    let decoder = ZstdDecoder::new(Cursor::new(bytes)).context("decode PGDATA template archive")?;
    let mut archive = Archive::new(decoder);
    unpack_archive_entries(&mut archive, destination)
}

fn unpack_archive_entries<R: Read>(archive: &mut Archive<R>, destination: &Path) -> Result<()> {
    unpack_archive_entries_with_path_map(archive, destination, |path| path)
}

fn unpack_archive_entries_with_path_map<R: Read>(
    archive: &mut Archive<R>,
    destination: &Path,
    map_path: impl for<'path> Fn(&'path Path) -> &'path Path,
) -> Result<()> {
    for entry in archive.entries().context("read archive entries")? {
        let mut entry = entry.context("read archive entry")?;
        let path = entry
            .path()
            .context("read archive entry path")?
            .into_owned();
        let relative = map_path(&path);
        let entry_type = entry.header().entry_type();
        let dest = archive_destination(destination, relative)?;

        if entry_type.is_dir() {
            fs::create_dir_all(&dest)
                .with_context(|| format!("create directory {}", dest.display()))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "unsafe archive entry {} has unsupported type {:?}",
                path.display(),
                entry_type
            );
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create directory {}", parent.display()))?;
        }

        entry
            .unpack(&dest)
            .with_context(|| format!("unpack archive entry {}", path.display()))?;
    }
    Ok(())
}

fn remove_template_runtime_state(pgdata: &Path) -> Result<()> {
    for name in TEMPLATE_RUNTIME_STATE_FILES {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

fn cluster_is_complete(paths: &OliphauntPaths) -> bool {
    (paths.marker_cluster().is_file() && paths.marker_control_file().is_file())
        || pgdata_overlay_is_installed(paths)
}

fn ensure_existing_pgdata_matches_runtime(paths: &OliphauntPaths) -> Result<()> {
    let Some(expected_major) = runtime_postgres_major()? else {
        return Ok(());
    };
    ensure_pgdata_postgres_major_matches(paths, &expected_major)
}

#[cfg(feature = "bundled")]
fn runtime_postgres_major() -> Result<Option<String>> {
    if runtime_tar_path().is_some() {
        return Ok(None);
    }
    let metadata = assets::asset_manifest_metadata()?;
    Ok(Some(postgres_major_from_version(
        &metadata.postgres_version,
    )))
}

#[cfg(not(feature = "bundled"))]
fn runtime_postgres_major() -> Result<Option<String>> {
    Ok(None)
}

fn postgres_major_from_version(version: &str) -> String {
    version
        .trim()
        .split('.')
        .next()
        .filter(|major| !major.is_empty())
        .unwrap_or(version.trim())
        .to_owned()
}

fn ensure_pgdata_postgres_major_matches(
    paths: &OliphauntPaths,
    expected_major: &str,
) -> Result<()> {
    ensure!(
        !expected_major.trim().is_empty(),
        "expected PostgreSQL major version must not be empty"
    );

    if let Some(overlay) = read_pgdata_overlay_manifest(paths)? {
        let actual_major = postgres_major_from_version(&overlay.postgres_version);
        ensure!(
            actual_major == expected_major,
            "existing PGDATA overlay at {} is PostgreSQL {}, but current Oliphaunt runtime is PostgreSQL {}; use a separate root or migrate the database before reusing this root",
            paths.pgdata.display(),
            actual_major,
            expected_major
        );
        return Ok(());
    }

    let pg_version_path = paths.marker_cluster();
    if !pg_version_path.is_file() {
        return Ok(());
    }
    let pg_version = fs::read_to_string(&pg_version_path)
        .with_context(|| format!("read {}", pg_version_path.display()))?;
    let actual_major = postgres_major_from_version(&pg_version);
    ensure!(
        actual_major == expected_major,
        "existing PGDATA at {} is PostgreSQL {}, but current Oliphaunt runtime is PostgreSQL {}; use a separate root or migrate the database before reusing this root",
        paths.pgdata.display(),
        actual_major,
        expected_major
    );
    Ok(())
}

fn remove_interrupted_pgdata(paths: &OliphauntPaths) -> Result<()> {
    if paths.pgdata.exists() && !cluster_is_complete(paths) {
        fs::remove_dir_all(&paths.pgdata).with_context(|| {
            format!(
                "remove interrupted PGDATA without complete cluster markers at {}",
                paths.pgdata.display()
            )
        })?;
    }
    Ok(())
}

fn tmp_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn strict_asset_verification() -> Result<bool> {
    let Some(value) = std::env::var_os("OLIPHAUNT_WASM_AOT_VERIFY") else {
        return Ok(false);
    };
    let value = value.to_string_lossy().to_ascii_lowercase();
    match value.as_str() {
        "" | "fast" | "metadata" | "receipt" | "0" | "false" | "off" => Ok(false),
        "full" | "sha" | "sha256" | "strict" | "1" | "true" | "on" => Ok(true),
        other => bail!("unsupported OLIPHAUNT_WASM_AOT_VERIFY={other}; use `fast` or `full`"),
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(sha256_hex(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn ensure_cluster(paths: &OliphauntPaths) -> Result<()> {
    ensure_cluster_with_template(paths, true)
}

fn ensure_cluster_with_template(paths: &OliphauntPaths, use_template: bool) -> Result<()> {
    let outcome = prepare_database_root(paths.clone(), prepare_options_for_template(use_template))?;
    let mut pg = PostgresMod::new_prepared(outcome.paths.clone(), outcome.runtime_layout.clone())?;
    pg.ensure_cluster()
}

pub fn preload_runtime_module(paths: &OliphauntPaths) -> Result<()> {
    let _ = paths;
    let cached_runtime = runtime_cache()?;
    let module_path = cached_runtime.runtime_root.join("bin/oliphaunt");
    PostgresMod::preload_module(&module_path)
}

#[derive(Debug, Clone)]
pub struct InstallOutcome {
    pub paths: OliphauntPaths,
    pub unpacked_runtime: bool,
    pub(crate) runtime_layout: RuntimeLayout,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    pub(crate) preinstalled_extensions: Vec<String>,
}

impl InstallOutcome {
    #[cfg(feature = "extensions")]
    pub(crate) fn has_preinstalled_extension(&self, extension: Extension) -> bool {
        self.preinstalled_extensions
            .iter()
            .any(|sql_name| sql_name == extension.sql_name())
    }
}

fn prepare_root_from_paths(
    paths: OliphauntPaths,
    root: PathBuf,
    temp_dir: Option<TempDir>,
    root_lock: Option<RootLock>,
    use_template: bool,
) -> Result<PreparedRoot> {
    let outcome = prepare_database_root(paths, prepare_options_for_template(use_template))?;
    Ok(PreparedRoot {
        root,
        temp_dir,
        root_lock,
        outcome,
    })
}

pub(crate) fn prepare_root(plan: RootPlan) -> Result<PreparedRoot> {
    let (paths, root, temp_dir, root_lock, temporary) = match plan.target {
        RootTarget::Path(root) => {
            let paths = OliphauntPaths::with_root(&root);
            let root_lock = RootLock::acquire(&root)?;
            (paths, root, None, Some(root_lock), false)
        }
        RootTarget::AppId {
            qualifier,
            organization,
            application,
        } => {
            let paths = OliphauntPaths::new((
                qualifier.as_str(),
                organization.as_str(),
                application.as_str(),
            ))?;
            let root = paths.install_root().to_path_buf();
            let root_lock = RootLock::acquire_for_paths(&paths)?;
            (paths, root, None, Some(root_lock), false)
        }
        RootTarget::Temporary => {
            let temp_dir = TempDir::new().context("create temporary oliphaunt directory")?;
            let root = temp_dir.path().to_path_buf();
            let paths = OliphauntPaths::with_root(&root);
            (paths, root, Some(temp_dir), None, true)
        }
    };

    match plan.source {
        RootSource::DataDirArchive(archive) => {
            prepare_root_from_data_dir_archive(paths, root, temp_dir, root_lock, &archive)
        }
        source @ (RootSource::Template | RootSource::FreshInitdb) => {
            let use_template = matches!(source, RootSource::Template);
            let prepared = prepare_root_from_paths(paths, root, temp_dir, root_lock, use_template)?;
            #[cfg(feature = "extensions")]
            {
                let mut prepared = prepared;
                if temporary && use_template && extension_template_cache_enabled() {
                    install_extension_template_into_outcome(
                        &mut prepared.outcome,
                        &plan.extensions,
                        &plan.postgres_config,
                    )?;
                }
                Ok(prepared)
            }
            #[cfg(not(feature = "extensions"))]
            {
                let _ = temporary;
                Ok(prepared)
            }
        }
    }
}

fn prepare_root_from_data_dir_archive(
    paths: OliphauntPaths,
    root: PathBuf,
    temp_dir: Option<TempDir>,
    root_lock: Option<RootLock>,
    archive: &[u8],
) -> Result<PreparedRoot> {
    let (runtime_layout, unpacked_runtime) =
        prepare_runtime_layout(&paths, RuntimeLayoutPolicy::Auto)?;
    if paths.pgdata.exists() {
        fs::remove_dir_all(&paths.pgdata)
            .with_context(|| format!("remove existing PGDATA {}", paths.pgdata.display()))?;
    }
    fs::create_dir_all(&paths.pgdata)
        .with_context(|| format!("create PGDATA {}", paths.pgdata.display()))?;
    unpack_pgdata_archive(archive, &paths.pgdata)
        .with_context(|| format!("load PGDATA archive into {}", paths.pgdata.display()))?;
    remove_template_runtime_state(&paths.pgdata)?;
    ensure!(
        paths.marker_cluster().is_file() && paths.marker_control_file().is_file(),
        "loaded PGDATA archive did not contain PG_VERSION and global/pg_control"
    );
    ensure_existing_pgdata_matches_runtime(&paths)?;
    Ok(PreparedRoot {
        root,
        temp_dir,
        root_lock,
        outcome: InstallOutcome {
            paths,
            unpacked_runtime,
            runtime_layout,
            preinstalled_extensions: Vec::new(),
        },
    })
}

#[cfg(feature = "extensions")]
pub(crate) fn install_missing_extension_archives(
    outcome: &InstallOutcome,
    extensions: &[Extension],
) -> Result<()> {
    for extension in extensions {
        if outcome.has_preinstalled_extension(*extension) {
            continue;
        }
        let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
            anyhow!(
                "extension asset '{}' is not bundled in this oliphaunt-wasix build",
                extension.sql_name()
            )
        })?;
        install_bundled_extension_bytes(&outcome.paths, extension.sql_name(), bytes)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct InstallOptions {
    pub ensure_cluster: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            ensure_cluster: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MountInfo {
    mount: PathBuf,
    paths: OliphauntPaths,
    reused_existing: bool,
}

impl MountInfo {
    pub fn into_paths(self) -> OliphauntPaths {
        self.paths
    }

    pub fn mount(&self) -> &Path {
        &self.mount
    }

    pub fn paths(&self) -> &OliphauntPaths {
        &self.paths
    }

    pub fn reused_existing(&self) -> bool {
        self.reused_existing
    }
}

pub fn install_default(app_id: (&str, &str, &str)) -> Result<InstallOutcome> {
    let paths = OliphauntPaths::new(app_id)?;
    prepare_database_root(paths, RootPrepareOptions::template())
}

pub fn install_into(root: &Path) -> Result<InstallOutcome> {
    let paths = OliphauntPaths::with_root(root);
    prepare_database_root(paths, RootPrepareOptions::template())
}

pub(crate) fn prepare_database_root(
    paths: OliphauntPaths,
    options: RootPrepareOptions,
) -> Result<InstallOutcome> {
    let (mut runtime_layout, unpacked_runtime) = prepare_runtime_layout(&paths, options.runtime)?;
    prepare_pgdata(&paths, options.cluster, &mut runtime_layout)?;
    Ok(InstallOutcome {
        paths,
        unpacked_runtime,
        runtime_layout,
        preinstalled_extensions: Vec::new(),
    })
}

fn prepare_pgdata(
    paths: &OliphauntPaths,
    cluster_policy: ClusterPolicy,
    runtime_layout: &mut RuntimeLayout,
) -> Result<()> {
    let _phase = timing::phase("pgdata.initialize");
    if pgdata_overlay_is_installed(paths) {
        ensure!(
            runtime_layout.uses_shared_overlay(),
            "PGDATA at {} uses the template overlay; delete the root/cache and recreate it with the shared runtime layout",
            paths.pgdata.display()
        );
        if try_prepare_pgdata_template_overlay(
            paths,
            &runtime_layout.module_path(),
            runtime_layout,
        )? {
            return Ok(());
        }
    }
    if cluster_is_complete(paths) {
        ensure_existing_pgdata_matches_runtime(paths)?;
        remove_template_runtime_state(&paths.pgdata)?;
        return Ok(());
    }
    if cluster_policy == ClusterPolicy::ExistingOrTemplate
        && pgdata_overlay_enabled()
        && runtime_layout.uses_shared_overlay()
        && try_prepare_pgdata_template_overlay(
            paths,
            &runtime_layout.module_path(),
            runtime_layout,
        )?
    {
        return Ok(());
    }
    if cluster_policy == ClusterPolicy::ExistingOrTemplate
        && try_install_embedded_pgdata_template(paths, &runtime_layout.module_path())?
    {
        return Ok(());
    }
    remove_interrupted_pgdata(paths)?;
    {
        let _phase = timing::phase("pgdata.fresh_initdb");
        PostgresMod::run_split_initdb(paths, runtime_layout)?;
    }
    ensure!(
        cluster_is_complete(paths),
        "split WASIX initdb finished but did not create a complete PGDATA cluster at {}",
        paths.pgdata.display()
    );
    remove_template_runtime_state(&paths.pgdata)
}

fn prepare_options_for_template(use_template: bool) -> RootPrepareOptions {
    if use_template {
        RootPrepareOptions::template()
    } else {
        RootPrepareOptions::fresh()
    }
}

pub fn install_and_init(app_id: (&str, &str, &str)) -> Result<MountInfo> {
    let outcome = install_default(app_id)?;
    if !cluster_is_complete(&outcome.paths) {
        let mut pg =
            PostgresMod::new_prepared(outcome.paths.clone(), outcome.runtime_layout.clone())?;
        pg.ensure_cluster()?;
    }
    Ok(MountInfo {
        mount: outcome.paths.pgroot.clone(),
        paths: outcome.paths,
        reused_existing: !outcome.unpacked_runtime,
    })
}

pub fn install_and_init_in<P: AsRef<Path>>(root: P) -> Result<MountInfo> {
    let outcome = install_into(root.as_ref())?;
    if !cluster_is_complete(&outcome.paths) {
        let mut pg =
            PostgresMod::new_prepared(outcome.paths.clone(), outcome.runtime_layout.clone())?;
        pg.ensure_cluster()?;
    }
    Ok(MountInfo {
        mount: outcome.paths.pgroot.clone(),
        paths: outcome.paths,
        reused_existing: !outcome.unpacked_runtime,
    })
}

pub fn install_with_options(paths: OliphauntPaths, options: InstallOptions) -> Result<MountInfo> {
    let outcome = prepare_database_root(paths, RootPrepareOptions::template())?;
    if options.ensure_cluster && !cluster_is_complete(&outcome.paths) {
        let mut pg =
            PostgresMod::new_prepared(outcome.paths.clone(), outcome.runtime_layout.clone())?;
        pg.ensure_cluster()?;
    }
    Ok(MountInfo {
        mount: outcome.paths.pgroot.clone(),
        paths: outcome.paths,
        reused_existing: !outcome.unpacked_runtime,
    })
}

fn runtime_cache() -> Result<Arc<CachedRuntime>> {
    RUNTIME_CACHE
        .get_or_init(|| {
            build_runtime_cache()
                .map(Arc::new)
                .map_err(|err| format!("{err:#}"))
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

pub(crate) fn shared_runtime_overlay_enabled() -> bool {
    true
}

pub(crate) fn pgdata_overlay_enabled() -> bool {
    true
}

fn prepare_runtime_layout(
    paths: &OliphauntPaths,
    policy: RuntimeLayoutPolicy,
) -> Result<(RuntimeLayout, bool)> {
    match resolve_runtime_layout_kind(paths, policy)? {
        RuntimeLayoutKind::FullLocal => {
            let unpacked_runtime = ensure_full_runtime(paths)?;
            let (module_path, _) = locate_runtime_module(paths).ok_or_else(|| {
                anyhow!(
                    "runtime missing: could not locate module under {} after install",
                    paths.pgroot.display()
                )
            })?;
            let module_root = module_path
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| paths.runtime_root());
            Ok((
                RuntimeLayout {
                    kind: RuntimeLayoutKind::FullLocal,
                    #[cfg(feature = "extensions")]
                    local_root: module_root.clone(),
                    module_root,
                    pgdata_template_root: None,
                },
                unpacked_runtime,
            ))
        }
        RuntimeLayoutKind::SharedRuntimeOverlay => {
            let cached_runtime = runtime_cache()?;
            prepare_shared_runtime_upper_root(&cached_runtime.runtime_root, paths)?;
            Ok((
                RuntimeLayout {
                    kind: RuntimeLayoutKind::SharedRuntimeOverlay,
                    #[cfg(feature = "extensions")]
                    local_root: paths.runtime_root(),
                    module_root: cached_runtime.runtime_root.clone(),
                    pgdata_template_root: None,
                },
                false,
            ))
        }
    }
}

fn resolve_runtime_layout_kind(
    paths: &OliphauntPaths,
    policy: RuntimeLayoutPolicy,
) -> Result<RuntimeLayoutKind> {
    match policy {
        RuntimeLayoutPolicy::FullLocal => return Ok(RuntimeLayoutKind::FullLocal),
        RuntimeLayoutPolicy::Auto => {}
    }

    if let Some(manifest) = read_runtime_layout_manifest(&paths.runtime_root())?
        && manifest.kind == RuntimeLayoutKind::SharedRuntimeOverlay
    {
        return Ok(RuntimeLayoutKind::SharedRuntimeOverlay);
    }
    if paths.runtime_root().join(MOUNTFS_RUNTIME_MARKER).is_file() {
        return Ok(RuntimeLayoutKind::SharedRuntimeOverlay);
    }
    if shared_runtime_overlay_enabled() {
        return Ok(RuntimeLayoutKind::SharedRuntimeOverlay);
    }
    Ok(RuntimeLayoutKind::FullLocal)
}

fn write_runtime_layout_manifest(
    runtime_root: &Path,
    kind: RuntimeLayoutKind,
    source_key: &str,
) -> Result<()> {
    fs::create_dir_all(runtime_root)
        .with_context(|| format!("create runtime root {}", runtime_root.display()))?;
    let manifest = RuntimeLayoutManifest {
        kind,
        source_key: source_key.to_owned(),
    };
    fs::write(
        runtime_root.join(RUNTIME_LAYOUT_MANIFEST_NAME),
        serde_json::to_vec_pretty(&manifest)?,
    )
    .with_context(|| {
        format!(
            "write runtime layout manifest {}",
            runtime_root.join(RUNTIME_LAYOUT_MANIFEST_NAME).display()
        )
    })?;
    Ok(())
}

fn read_runtime_layout_manifest(runtime_root: &Path) -> Result<Option<RuntimeLayoutManifest>> {
    let path = runtime_root.join(RUNTIME_LAYOUT_MANIFEST_NAME);
    match fs::read(&path) {
        Ok(bytes) => {
            let manifest = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse runtime layout manifest {}", path.display()))?;
            Ok(Some(manifest))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
    }
}

fn build_runtime_cache() -> Result<CachedRuntime> {
    let _phase = timing::phase("runtime.cache_install");
    let key = {
        let _phase = timing::phase("runtime.cache_key");
        runtime_cache_key()?
    };
    let dirs = ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")?;
    let cache_root = dirs.cache_dir().join("runtime");
    let _cache_lock = CacheLock::acquire(&cache_root.join(".locks").join(format!("{key}.lock")))?;
    let root = cache_root.join(&key);
    let paths = OliphauntPaths::with_root(root);
    {
        let _phase = timing::phase("runtime.cache_ensure_full");
        ensure_full_runtime(&paths)?;
    }
    let (module_path, _) = {
        let _phase = timing::phase("runtime.cache_locate_module");
        locate_runtime_module(&paths).ok_or_else(|| {
            anyhow!(
                "runtime missing: could not locate module under {} after cache install",
                paths.pgroot.display()
            )
        })?
    };
    if strict_asset_verification()?
        && let Some(manifest) = validated_embedded_pgdata_template_manifest()?
    {
        ensure_module_matches_template(&module_path, &manifest)?;
    }
    let runtime_root = module_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| paths.runtime_root());
    {
        let _phase = timing::phase("runtime.cache_reset_mutable");
        reset_runtime_cache_mutable_state(&runtime_root)?;
    }
    Ok(CachedRuntime { runtime_root })
}

fn reset_runtime_cache_mutable_state(runtime_root: &Path) -> Result<()> {
    for relative in ["base", "tmp", "dev/shm"] {
        let path = runtime_root.join(relative);
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("remove mutable runtime-cache state {}", path.display())
                });
            }
        }
    }
    fs::create_dir_all(runtime_root.join("tmp"))
        .with_context(|| format!("create runtime cache tmp under {}", runtime_root.display()))?;
    fs::create_dir_all(runtime_root.join("dev/shm")).with_context(|| {
        format!(
            "create runtime cache shared-memory dir under {}",
            runtime_root.display()
        )
    })?;
    ensure_runtime_password_file(runtime_root)?;
    Ok(())
}

fn ensure_runtime_password_file(runtime_root: &Path) -> Result<()> {
    let path = runtime_root.join("password");
    let needs_repair = match fs::read(&path) {
        Ok(bytes) => bytes.is_empty(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    };
    if needs_repair {
        fs::write(&path, DEFAULT_PASSWORD_FILE)
            .with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}

fn runtime_cache_key() -> Result<String> {
    if let Some(path) = runtime_tar_path() {
        if strict_asset_verification()? {
            return sha256_file(&path);
        }
        return file_metadata_cache_key(&path);
    }
    if assets::runtime_archive().is_some() {
        return embedded_runtime_archive_sha256();
    }
    bail!(
        "no embedded Oliphaunt runtime assets are available; enable the `bundled` feature or set OLIPHAUNT_WASM_RUNTIME_ARCHIVE"
    )
}

#[cfg(feature = "bundled")]
fn embedded_runtime_archive_sha256() -> Result<String> {
    assets::expected_runtime_archive_sha256()
}

#[cfg(not(feature = "bundled"))]
fn embedded_runtime_archive_sha256() -> Result<String> {
    bail!("embedded runtime archive is unavailable without the `bundled` feature")
}

fn file_metadata_cache_key(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Ok(format!("external-{}-{modified_nanos}", metadata.len()))
}

fn prepare_shared_runtime_upper_root(src_runtime: &Path, paths: &OliphauntPaths) -> Result<()> {
    let _phase = timing::phase("runtime.mountfs_upper_root");
    let dest_runtime = paths.runtime_root();

    {
        let _phase = timing::phase("runtime.mountfs_upper_dirs");
        for path in [
            dest_runtime.to_path_buf(),
            dest_runtime.join("home"),
            dest_runtime.join("dev"),
        ] {
            fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        }
    }

    {
        let _phase = timing::phase("runtime.mountfs_upper_reset");
        reset_dir(&dest_runtime.join("tmp"))?;
        reset_dir(&dest_runtime.join("dev/shm"))?;
    }

    {
        let _phase = timing::phase("runtime.mountfs_upper_identity");
        copy_runtime_file_if_exists(src_runtime.join("password"), dest_runtime.join("password"))?;
    }

    fs::write(dest_runtime.join(MOUNTFS_RUNTIME_MARKER), b"mountfs\n").with_context(|| {
        format!(
            "write {}",
            dest_runtime.join(MOUNTFS_RUNTIME_MARKER).display()
        )
    })?;
    write_runtime_layout_manifest(
        &dest_runtime,
        RuntimeLayoutKind::SharedRuntimeOverlay,
        &runtime_cache_key()?,
    )?;
    Ok(())
}

fn reset_dir(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_dir_all(path).with_context(|| format!("remove {}", path.display()))?;
    }
    fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    Ok(())
}

fn copy_runtime_file_if_exists(src: PathBuf, dest: PathBuf) -> Result<()> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if dest.exists() {
        fs::remove_file(&dest).with_context(|| format!("remove {}", dest.display()))?;
    }
    fs::copy(&src, &dest)
        .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "extensions")]
    #[test]
    fn embedded_pgdata_template_installs_valid_cluster() -> Result<()> {
        if !embedded_pgdata_template_is_available() {
            return Ok(());
        }

        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        ensure_full_runtime(&paths)?;

        let (module_path, _) =
            locate_runtime_module(&paths).context("runtime module should be installed")?;
        assert!(try_install_embedded_pgdata_template(&paths, &module_path)?);

        assert!(paths.pgdata.join("PG_VERSION").exists());
        assert!(paths.pgdata.join("global/pg_control").exists());
        assert!(!paths.pgdata.join("postmaster.pid").exists());
        Ok(())
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn embedded_pgdata_template_replaces_interrupted_pgdata() -> Result<()> {
        if !embedded_pgdata_template_is_available() {
            return Ok(());
        }

        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        ensure_full_runtime(&paths)?;
        fs::create_dir_all(paths.pgdata.join("global"))?;
        fs::write(paths.pgdata.join("postmaster.pid"), b"stale pid")?;
        fs::write(paths.pgdata.join("base.tmp"), b"interrupted initdb")?;

        let (module_path, _) =
            locate_runtime_module(&paths).context("runtime module should be installed")?;
        assert!(try_install_embedded_pgdata_template(&paths, &module_path)?);

        assert!(paths.pgdata.join("PG_VERSION").exists());
        assert!(paths.pgdata.join("global/pg_control").exists());
        assert!(!paths.pgdata.join("postmaster.pid").exists());
        assert!(!paths.pgdata.join("base.tmp").exists());
        Ok(())
    }

    #[cfg(feature = "extensions")]
    fn embedded_pgdata_template_is_available() -> bool {
        assets::pgdata_template_archive().is_some() && assets::pgdata_template_manifest().is_some()
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn fresh_initdb_removes_interrupted_pgdata() -> Result<()> {
        if assets::runtime_archive().is_none() {
            return Ok(());
        }
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        fs::create_dir_all(&paths.pgdata)?;
        fs::write(paths.pgdata.join("postmaster.pid"), b"stale pid")?;
        fs::write(paths.pgdata.join("partial"), b"interrupted initdb")?;

        match prepare_database_root(paths.clone(), RootPrepareOptions::fresh()) {
            Ok(_) => assert!(cluster_is_complete(&paths)),
            Err(err) => assert!(
                format!("{err:#}").contains("split WASIX initdb module is not installed"),
                "unexpected fresh initdb error: {err:#}"
            ),
        }
        assert!(!paths.pgdata.join("postmaster.pid").exists());
        assert!(!paths.pgdata.join("partial").exists());
        Ok(())
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn fresh_initdb_removes_incomplete_pgdata_even_with_pg_version() -> Result<()> {
        if assets::runtime_archive().is_none() {
            return Ok(());
        }
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        fs::create_dir_all(&paths.pgdata)?;
        fs::write(paths.pgdata.join("PG_VERSION"), b"17\n")?;
        fs::write(
            paths.pgdata.join("partial-bootstrap.sql"),
            b"interrupted initdb",
        )?;

        match prepare_database_root(paths.clone(), RootPrepareOptions::fresh()) {
            Ok(_) => assert!(cluster_is_complete(&paths)),
            Err(err) => assert!(
                format!("{err:#}").contains("split WASIX initdb module is not installed"),
                "unexpected fresh initdb error: {err:#}"
            ),
        }
        assert!(!paths.pgdata.join("partial-bootstrap.sql").exists());
        Ok(())
    }

    #[test]
    fn root_lock_is_exclusive_until_dropped() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let first = RootLock::acquire(temp_dir.path())?;
        assert!(temp_dir.path().join(".oliphaunt-wasix.lock").exists());

        let err =
            RootLock::acquire(temp_dir.path()).expect_err("second root lock should be rejected");
        assert!(format!("{err:#}").contains("Oliphaunt root is already in use"));

        drop(first);
        let _second = RootLock::acquire(temp_dir.path())?;
        Ok(())
    }

    #[test]
    fn archive_destination_rejects_parent_components() {
        let err = archive_destination(Path::new("/tmp/root"), Path::new("../escape"))
            .expect_err("parent components must be rejected");
        assert!(err.to_string().contains("unsafe archive path"));
    }

    #[test]
    fn pgdata_major_guard_accepts_same_major_cluster() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        fs::create_dir_all(paths.pgdata.join("global"))?;
        fs::write(paths.pgdata.join("PG_VERSION"), b"18\n")?;
        fs::write(paths.pgdata.join("global/pg_control"), b"control")?;

        ensure_pgdata_postgres_major_matches(&paths, "18")?;
        Ok(())
    }

    #[test]
    fn pgdata_major_guard_rejects_cross_major_cluster() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        fs::create_dir_all(paths.pgdata.join("global"))?;
        fs::write(paths.pgdata.join("PG_VERSION"), b"17\n")?;
        fs::write(paths.pgdata.join("global/pg_control"), b"control")?;

        let err = ensure_pgdata_postgres_major_matches(&paths, "18")
            .expect_err("cross-major PGDATA must be rejected");
        assert!(
            format!("{err:#}").contains("existing PGDATA")
                && format!("{err:#}").contains("PostgreSQL 17")
                && format!("{err:#}").contains("PostgreSQL 18"),
            "unexpected error: {err:#}"
        );
        Ok(())
    }

    #[test]
    fn pgdata_major_guard_rejects_cross_major_overlay() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        fs::create_dir_all(&paths.pgdata)?;
        fs::write(
            pgdata_overlay_manifest_path(&paths),
            br#"{
              "templateArchiveSha256": "old-template",
              "postgresVersion": "17",
              "extensionSqlNames": []
            }"#,
        )?;

        let err = ensure_pgdata_postgres_major_matches(&paths, "18")
            .expect_err("cross-major PGDATA overlay must be rejected");
        assert!(
            format!("{err:#}").contains("existing PGDATA overlay")
                && format!("{err:#}").contains("PostgreSQL 17")
                && format!("{err:#}").contains("PostgreSQL 18"),
            "unexpected error: {err:#}"
        );
        Ok(())
    }

    #[test]
    fn full_runtime_layout_requires_current_source_key() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        write_runtime_layout_manifest(&paths.runtime_root(), RuntimeLayoutKind::FullLocal, "old")?;

        assert!(!full_runtime_layout_matches_current(&paths, "new")?);
        assert!(full_runtime_layout_matches_current(&paths, "old")?);
        Ok(())
    }

    fn tar_bytes_with_entry(path: &[u8], entry_type: u8, body: &[u8], link_name: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].fill(b' ');
        header[156] = entry_type;
        if !link_name.is_empty() {
            header[157..157 + link_name.len()].copy_from_slice(link_name);
        }
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");

        let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
        header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(body);
        let padding = (512 - (body.len() % 512)) % 512;
        bytes.resize(bytes.len() + padding, 0);
        bytes.resize(bytes.len() + 1024, 0);
        bytes
    }

    #[test]
    fn extension_archive_rejects_parent_components() -> Result<()> {
        let bytes = tar_bytes_with_entry(b"../escape", b'0', b"nope", b"");
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        let err = install_extension_bytes(&paths, &bytes).expect_err("unsafe archive must fail");
        assert!(err.to_string().contains("unpack extension"));
        Ok(())
    }

    #[test]
    fn extension_archive_rejects_symlink_entries() -> Result<()> {
        let bytes = tar_bytes_with_entry(
            b"lib/postgresql/vector.so",
            b'2',
            b"",
            b"/tmp/attacker-owned-vector.so",
        );
        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        let err = install_extension_bytes(&paths, &bytes).expect_err("symlink archive must fail");
        assert!(
            err.chain()
                .any(|cause| cause.to_string().contains("unsupported type")),
            "{err:#}"
        );
        Ok(())
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn embedded_runtime_archive_hash_is_validated() -> Result<()> {
        let mut bytes = assets::runtime_archive()
            .expect("embedded runtime archive")
            .to_vec();
        bytes[0] ^= 0xff;
        let err = validate_embedded_runtime_archive_strict(&bytes)
            .expect_err("corrupted runtime archive hash must fail");
        assert!(err.to_string().contains("runtime archive hash mismatch"));
        Ok(())
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn bundled_extension_archive_hash_is_validated() -> Result<()> {
        let mut bytes = assets::extension_archive("vector")
            .expect("embedded vector archive")
            .to_vec();
        bytes[0] ^= 0xff;
        let err = validate_bundled_extension_archive_strict("vector", &bytes)
            .expect_err("corrupted extension archive hash must fail");
        assert!(
            err.to_string()
                .contains("extension archive 'vector' hash mismatch")
        );
        Ok(())
    }
}
