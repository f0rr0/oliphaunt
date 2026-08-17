use std::collections::BTreeSet;
#[cfg(not(unix))]
use std::ffi::OsString;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Cursor, Read};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, anyhow, bail, ensure};
use directories::ProjectDirs;
#[cfg(any(feature = "extensions", test))]
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;
use tracing::info;
use zstd::stream::read::Decoder as ZstdDecoder;

use super::postgres_mod::PostgresMod;
use super::timing;
use crate::oliphaunt::assets;
use crate::oliphaunt::data_dir::{unpack_pgdata_archive, unpack_virtual_pgdata_archive};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::storage::{
    DatabaseInitialization, DatabaseStorage, PgDataStorage, StorageRoot, vfs_create_dir_all,
    vfs_file_exists, vfs_read, vfs_remove_file_if_exists, vfs_write,
};
use tempfile::TempDir;
use wasmer_wasix::virtual_fs::FileSystem as VirtualFileSystem;

mod template_clone;

use template_clone::{clone_pgdata_template_dir, clone_pgdata_template_dir_into_existing};

const RUNTIME_ARCHIVE_NAME: &str = "oliphaunt.wasix.tar.zst";
const MOUNTFS_RUNTIME_MARKER: &str = ".oliphaunt-wasix-mountfs-runtime";
const RUNTIME_LAYOUT_MANIFEST_NAME: &str = ".oliphaunt-wasix-runtime-layout.json";
const PGDATA_OVERLAY_MANIFEST_NAME: &str = ".oliphaunt-wasix-pgdata-overlay.json";
const ICU_DATA_MARKER_NAME: &str = ".oliphaunt-icu-data.sha256";
// Bump these when cache materialization semantics change; old mutable PGDATA
// template caches may have been modified by earlier clone strategies.
const PGDATA_TEMPLATE_CACHE_FORMAT: &str = "v2";
const DEFAULT_PASSWORD_FILE: &[u8] = b"password\n";
#[cfg(not(unix))]
const DATABASE_LOCK_FILE_SUFFIX: &str = ".oliphaunt-wasix.lock";

static RUNTIME_CACHE: OnceLock<std::result::Result<Arc<CachedRuntime>, String>> = OnceLock::new();
static PGDATA_TEMPLATE_CACHE: OnceLock<std::result::Result<Arc<CachedPgDataTemplate>, String>> =
    OnceLock::new();
static PGDATA_TEMPLATE_MANIFEST: OnceLock<std::result::Result<PgDataTemplateManifest, String>> =
    OnceLock::new();
static ROOT_LOCKED_PATHS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
const TEMPLATE_RUNTIME_STATE_FILES: &[&str] = &["postmaster.pid", "postmaster.opts"];

#[derive(Debug)]
struct CachedRuntime {
    runtime_root: PathBuf,
    filesystem: Arc<dyn VirtualFileSystem + Send + Sync>,
}

#[derive(Debug)]
struct CachedPgDataTemplate {
    pgdata: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct OliphauntPaths {
    pub(crate) pgroot: PathBuf,
    pub(crate) pgdata: PathBuf,
}

#[derive(Debug)]
pub(crate) struct DirectoryLock {
    path: PathBuf,
    _file: File,
}

#[derive(Debug)]
struct CacheLock {
    _file: File,
}

#[derive(Debug)]
pub(crate) struct PreparedDatabase {
    pub(crate) workspace: Option<TempDir>,
    pub(crate) directory_lock: Option<DirectoryLock>,
    pub(crate) outcome: InstallOutcome,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeLayout {
    pub(crate) kind: RuntimeLayoutKind,
    pub(crate) mutable_root: StorageRoot,
    pub(crate) shared_root: Option<Arc<dyn VirtualFileSystem + Send + Sync>>,
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
pub(crate) enum ClusterPolicy {
    ExistingOrTemplate,
    ExistingOrFreshInitdb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IncompleteClusterPolicy {
    RecoverSdkOwned,
    FailIfNonEmpty,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RootPrepareOptions {
    pub(crate) cluster: ClusterPolicy,
    pub(crate) incomplete_cluster: IncompleteClusterPolicy,
}

#[derive(Debug, Clone)]
pub(crate) struct DatabasePlan {
    pub(crate) storage: DatabaseStorage,
    pub(crate) initialization: DatabaseInitialization,
}

impl DatabasePlan {
    pub(crate) fn new(storage: DatabaseStorage, initialization: DatabaseInitialization) -> Self {
        Self {
            storage,
            initialization,
        }
    }
}

impl RootPrepareOptions {
    pub(crate) fn template() -> Self {
        Self {
            cluster: ClusterPolicy::ExistingOrTemplate,
            incomplete_cluster: IncompleteClusterPolicy::RecoverSdkOwned,
        }
    }

    pub(crate) fn fresh() -> Self {
        Self {
            cluster: ClusterPolicy::ExistingOrFreshInitdb,
            incomplete_cluster: IncompleteClusterPolicy::RecoverSdkOwned,
        }
    }

    pub(crate) fn fail_if_incomplete(mut self) -> Self {
        self.incomplete_cluster = IncompleteClusterPolicy::FailIfNonEmpty;
        self
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

/// Manifest that binds a PGDATA template to the Oliphaunt WASIX runtime it was
/// created with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PgDataTemplateManifest {
    postgres_version: String,
    #[serde(default)]
    source_lane: Option<String>,
    #[serde(default)]
    source_fingerprint: Option<String>,
    wasm_sha256: String,
    archive_sha256: String,
    #[serde(default)]
    architecture_independent: bool,
}

impl OliphauntPaths {
    pub(crate) fn with_root(root: impl Into<PathBuf>) -> Self {
        let base = root.into();
        let pgroot = base.join("tmp");
        let pgdata = pgroot.join("oliphaunt").join("base");
        Self { pgroot, pgdata }
    }

    pub(crate) fn with_pgdata(
        runtime_workspace: impl Into<PathBuf>,
        pgdata: impl Into<PathBuf>,
    ) -> Self {
        Self {
            pgroot: runtime_workspace.into().join("tmp"),
            pgdata: pgdata.into(),
        }
    }

    pub(crate) fn runtime_root(&self) -> PathBuf {
        self.pgroot.join("oliphaunt")
    }

    fn marker_cluster(&self) -> PathBuf {
        self.pgdata.join("PG_VERSION")
    }

    fn marker_control_file(&self) -> PathBuf {
        self.pgdata.join("global").join("pg_control")
    }
}

impl DirectoryLock {
    pub(crate) fn acquire(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory)
            .with_context(|| format!("create database directory {}", directory.display()))?;
        let canonical_root =
            dunce::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
        {
            let mut locked = ROOT_LOCKED_PATHS
                .get_or_init(|| Mutex::new(BTreeSet::new()))
                .lock()
                .expect("database directory lock set poisoned");
            ensure!(
                locked.insert(canonical_root.clone()),
                "database directory is already in use: {}",
                directory.display()
            );
        }
        // On Unix, flock the directory inode itself. Other hosts use a stable
        // sibling file because their file APIs cannot portably lock a
        // directory. PGDATA remains empty for initdb on every platform.
        let file = match open_root_lock_file(&canonical_root) {
            Ok(file) => file,
            Err(err) => {
                release_root_lock_path(&canonical_root);
                return Err(err).with_context(|| {
                    format!(
                        "database directory is already in use or unavailable: {}",
                        directory.display()
                    )
                });
            }
        };
        if let Err(err) = file.try_lock() {
            release_root_lock_path(&canonical_root);
            return Err(err).with_context(|| {
                format!(
                    "database directory is already in use: {}",
                    directory.display()
                )
            });
        }
        Ok(Self {
            path: canonical_root,
            _file: file,
        })
    }
}

#[cfg(not(unix))]
fn database_lock_path(directory: &Path) -> Result<PathBuf> {
    let parent = directory.parent().with_context(|| {
        format!(
            "database directory must have a parent for its ownership lock: {}",
            directory.display()
        )
    })?;
    let file_name = directory.file_name().with_context(|| {
        format!(
            "database directory must have a final component: {}",
            directory.display()
        )
    })?;
    let mut lock_name = OsString::from(".");
    lock_name.push(file_name);
    lock_name.push(DATABASE_LOCK_FILE_SUFFIX);
    Ok(parent.join(lock_name))
}

impl Drop for DirectoryLock {
    fn drop(&mut self) {
        let _ = self._file.unlock();
        release_root_lock_path(&self.path);
    }
}

#[cfg(unix)]
fn open_root_lock_file(directory: &Path) -> std::io::Result<File> {
    File::open(directory)
}

#[cfg(not(unix))]
fn open_root_lock_file(directory: &Path) -> std::io::Result<File> {
    let path = database_lock_path(directory).map_err(std::io::Error::other)?;
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
            .expect("database directory lock set poisoned")
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
        let repaired_icu = install_optional_icu_data(&paths.runtime_root())?;
        write_runtime_layout_manifest(
            &paths.runtime_root(),
            RuntimeLayoutKind::FullLocal,
            &source_key,
        )?;
        ensure_runtime_password_file(&paths.runtime_root())?;
        return Ok(repaired_runtime || repaired_icu);
    }

    if let Some(parent) = paths.pgroot.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create parent directory {}", parent.display()))?;
    } else {
        fs::create_dir_all(&paths.pgroot).context("create pgroot dir")?;
    }

    install_runtime_from_tar(paths)?;
    install_optional_icu_data(&paths.runtime_root())?;
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

fn install_runtime_from_tar(paths: &OliphauntPaths) -> Result<bool> {
    let _phase = timing::phase("runtime.archive_install");
    if let Some(runtime_archive) = assets::runtime_archive() {
        info!("installing embedded runtime archive");
        if strict_asset_verification()? {
            validate_embedded_runtime_archive_strict(runtime_archive)?;
        }
        unpack_runtime_archive_reader(
            Cursor::new(runtime_archive),
            Path::new(RUNTIME_ARCHIVE_NAME),
            &paths.pgroot,
        )?;
    } else {
        bail!(
            "Oliphaunt WASIX runtime assets are unavailable; publish and stage package-manager-resolved liboliphaunt-wasix runtime artifacts with the application"
        );
    }

    Ok(true)
}

pub(crate) fn install_optional_icu_data(runtime_root: &Path) -> Result<bool> {
    let _phase = timing::phase("runtime.icu_data_install");
    let icu_dir = runtime_root.join("share/icu");
    let marker = runtime_root.join(ICU_DATA_MARKER_NAME);
    let Some(archive) = assets::icu_data_archive() else {
        let mut changed = false;
        if icu_dir.exists() {
            fs::remove_dir_all(&icu_dir)
                .with_context(|| format!("remove unselected ICU data {}", icu_dir.display()))?;
            changed = true;
        }
        match fs::remove_file(&marker) {
            Ok(()) => changed = true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).with_context(|| format!("remove {}", marker.display())),
        }
        return Ok(changed);
    };

    let expected = sha256_hex(archive);
    if icu_data_root_contains_data(&icu_dir)?
        && fs::read_to_string(&marker)
            .map(|value| value.trim() == expected)
            .unwrap_or(false)
    {
        return Ok(false);
    }

    if icu_dir.exists() {
        fs::remove_dir_all(&icu_dir)
            .with_context(|| format!("remove stale ICU data {}", icu_dir.display()))?;
    }
    unpack_icu_data_archive_reader(Cursor::new(archive), runtime_root)?;
    ensure!(
        icu_data_root_contains_data(&icu_dir)?,
        "embedded ICU data archive did not install icudt data under {}",
        icu_dir.display()
    );
    fs::write(&marker, format!("{expected}\n"))
        .with_context(|| format!("write {}", marker.display()))?;
    Ok(true)
}

fn unpack_icu_data_archive_reader<R: Read>(reader: R, destination: &Path) -> Result<()> {
    let decoder = ZstdDecoder::new(reader).context("decode ICU data archive")?;
    let mut archive = Archive::new(decoder);
    for entry in archive.entries().context("read ICU data archive entries")? {
        let mut entry = entry.context("read ICU data archive entry")?;
        let path = entry
            .path()
            .context("read ICU data archive entry path")?
            .into_owned();
        let relative = icu_archive_relative_path(&path)?;
        let entry_type = entry.header().entry_type();
        let dest = archive_destination(destination, relative)?;
        if entry_type.is_dir() {
            fs::create_dir_all(&dest)
                .with_context(|| format!("create ICU data directory {}", dest.display()))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "unsafe ICU data archive entry {} has unsupported type {:?}",
                path.display(),
                entry_type
            );
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create ICU data directory {}", parent.display()))?;
        }
        entry
            .unpack(&dest)
            .with_context(|| format!("unpack ICU data archive entry {}", path.display()))?;
    }
    Ok(())
}

fn icu_archive_relative_path(path: &Path) -> Result<&Path> {
    let mut without_dot = path;
    if let Ok(stripped) = without_dot.strip_prefix(".") {
        without_dot = stripped;
    }
    let relative = without_dot
        .strip_prefix("tmp/oliphaunt")
        .unwrap_or(without_dot);
    let mut components = relative.components();
    let under_share_icu = matches!(components.next(), Some(Component::Normal(part)) if part == "share")
        && matches!(components.next(), Some(Component::Normal(part)) if part == "icu");
    if !under_share_icu {
        bail!(
            "ICU data archive entry {} must stay under share/icu",
            path.display()
        );
    }
    Ok(relative)
}

fn icu_data_root_contains_data(root: &Path) -> Result<bool> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err).with_context(|| format!("read {}", root.display())),
    };
    for entry in entries {
        let entry = entry.with_context(|| format!("read entry in {}", root.display()))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            return Ok(true);
        }
        if path.is_dir() && name.starts_with("icudt") && directory_contains_file(&path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn directory_contains_file(path: &Path) -> Result<bool> {
    for entry in fs::read_dir(path).with_context(|| format!("read {}", path.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", path.display()))?;
        if entry.path().is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn unpack_runtime_archive_reader<R: Read>(
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

#[cfg(any(feature = "extensions", test))]
fn install_extension_reader<R: Read>(root: &StorageRoot, mut reader: R) -> Result<()> {
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
    match root {
        StorageRoot::HostDirectory(target) => {
            fs::create_dir_all(target)
                .with_context(|| format!("create extension target {}", target.display()))?;
            unpack_archive_entries(&mut ar, target)
                .with_context(|| format!("unpack extension into {}", target.display()))?;
        }
        StorageRoot::Memory(filesystem) => {
            unpack_archive_entries_virtual(&mut ar, filesystem.as_ref())
                .context("unpack extension into memory")?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn install_extension_bytes(paths: &OliphauntPaths, bytes: &[u8]) -> Result<()> {
    install_extension_reader(
        &StorageRoot::host_directory(paths.runtime_root()),
        std::io::Cursor::new(bytes),
    )
}

#[cfg(feature = "extensions")]
pub(crate) fn install_bundled_extension_bytes(
    root: &StorageRoot,
    sql_name: &str,
    bytes: &[u8],
) -> Result<()> {
    if strict_asset_verification()? {
        validate_bundled_extension_archive_strict(sql_name, bytes)?;
    }
    install_extension_reader(root, Cursor::new(bytes))
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

fn validate_embedded_runtime_archive_strict(bytes: &[u8]) -> Result<()> {
    let expected = assets::expected_runtime_archive_sha256()?;
    let actual = sha256_hex(bytes);
    ensure!(
        actual.eq_ignore_ascii_case(&expected),
        "embedded runtime archive hash mismatch: manifest={expected} actual={actual}"
    );
    Ok(())
}

fn try_install_embedded_pgdata_template(
    paths: &OliphauntPaths,
    module_path: &Path,
    preserve_pgdata_root: bool,
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
    if paths.pgdata.exists() && !preserve_pgdata_root {
        fs::remove_dir_all(&paths.pgdata)
            .with_context(|| format!("remove existing pgdata {}", paths.pgdata.display()))?;
    }
    {
        let _phase = timing::phase("pgdata.cached_template_clone");
        if preserve_pgdata_root {
            clone_pgdata_template_dir_into_existing(&template.pgdata, &paths.pgdata)?;
        } else {
            clone_pgdata_template_dir(&template.pgdata, &paths.pgdata)?;
        }
    }
    remove_template_runtime_state(&paths.pgdata)?;
    Ok(true)
}

fn try_prepare_pgdata_template_overlay(
    paths: &OliphauntPaths,
    module_path: &Path,
    runtime_layout: &mut RuntimeLayout,
    preserve_pgdata_root: bool,
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
            "PGDATA overlay at {} was created for template {}, but this runtime provides {}; delete the database storage/runtime cache and recreate it",
            paths.pgdata.display(),
            existing.template_archive_sha256,
            manifest.archive_sha256
        );
    } else if paths.pgdata.exists() && !cluster_is_complete(paths) && !preserve_pgdata_root {
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

fn unpack_pgdata_template_archive_virtual(
    bytes: &[u8],
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    let decoder = ZstdDecoder::new(Cursor::new(bytes)).context("decode PGDATA template archive")?;
    let mut archive = Archive::new(decoder);
    unpack_archive_entries_virtual(&mut archive, filesystem)
        .context("unpack packaged archive into memory")
}

fn unpack_archive_entries_virtual<R: Read>(
    archive: &mut Archive<R>,
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    for entry in archive.entries().context("read archive entries")? {
        let mut entry = entry.context("read archive entry")?;
        let path = entry
            .path()
            .context("read archive entry path")?
            .into_owned();
        let destination = archive_destination(Path::new("/"), &path)?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            vfs_create_dir_all(filesystem, &destination)?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "unsafe PGDATA archive entry {} has unsupported type {:?}",
                path.display(),
                entry_type
            );
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .with_context(|| format!("read archive entry {}", path.display()))?;
        vfs_write(filesystem, &destination, &bytes)?;
    }
    Ok(())
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

fn remove_virtual_runtime_state(filesystem: &(dyn VirtualFileSystem + Send + Sync)) -> Result<()> {
    for name in TEMPLATE_RUNTIME_STATE_FILES {
        vfs_remove_file_if_exists(filesystem, &Path::new("/").join(name))?;
    }
    Ok(())
}

fn cluster_is_complete(paths: &OliphauntPaths) -> bool {
    (paths.marker_cluster().is_file() && paths.marker_control_file().is_file())
        || pgdata_overlay_is_installed(paths)
}

pub(crate) fn virtual_cluster_is_complete(
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> bool {
    vfs_file_exists(filesystem, Path::new("/PG_VERSION"))
        && vfs_file_exists(filesystem, Path::new("/global/pg_control"))
}

fn ensure_virtual_pgdata_matches_runtime(
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    let Some(expected_major) = runtime_postgres_major()? else {
        return Ok(());
    };
    let pg_version = vfs_read(filesystem, Path::new("/PG_VERSION"))?;
    let pg_version = std::str::from_utf8(&pg_version).context("PG_VERSION is not UTF-8")?;
    let actual_major = postgres_major_from_version(pg_version);
    ensure!(
        actual_major == expected_major,
        "database archive is PostgreSQL {actual_major}, but this Oliphaunt runtime is PostgreSQL {expected_major}"
    );
    Ok(())
}

fn ensure_existing_pgdata_matches_runtime(paths: &OliphauntPaths) -> Result<()> {
    let Some(expected_major) = runtime_postgres_major()? else {
        return Ok(());
    };
    ensure_pgdata_postgres_major_matches(paths, &expected_major)
}

fn ensure_pgdata_empty_or_absent(pgdata: &Path) -> Result<()> {
    ensure!(
        !pgdata.join("tmp/oliphaunt/base/PG_VERSION").is_file(),
        "database directory {} uses the retired nested storage layout; select a new raw PGDATA directory (automatic v1 migration is intentionally unsupported)",
        pgdata.display()
    );
    let mut entries = match fs::read_dir(pgdata) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(err).with_context(|| format!("read PGDATA {}", pgdata.display()));
        }
    };
    ensure!(
        entries.next().transpose()?.is_none(),
        "persistent database storage contains a non-empty incomplete PGDATA at {}; refusing to delete or reinitialize caller-owned data",
        pgdata.display()
    );
    Ok(())
}

fn runtime_postgres_major() -> Result<Option<String>> {
    let metadata = assets::asset_manifest_metadata()?;
    if metadata.postgres_version.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(postgres_major_from_version(
        &metadata.postgres_version,
    )))
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
            "existing PGDATA overlay at {} is PostgreSQL {}, but current Oliphaunt runtime is PostgreSQL {}; use a separate database directory or migrate the database before reusing it",
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
        "existing PGDATA at {} is PostgreSQL {}, but current Oliphaunt runtime is PostgreSQL {}; use a separate database directory or migrate the database before reusing it",
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

pub(crate) fn preload_runtime_module() -> Result<()> {
    let cached_runtime = runtime_cache()?;
    let module_path = cached_runtime.runtime_root.join("bin/oliphaunt");
    PostgresMod::preload_module(&module_path)
}

#[derive(Debug, Clone)]
pub(crate) struct InstallOutcome {
    pub(crate) runtime_layout: RuntimeLayout,
    pub(crate) pgdata_storage: PgDataStorage,
}

fn prepare_host_database(
    paths: OliphauntPaths,
    workspace: Option<TempDir>,
    directory_lock: Option<DirectoryLock>,
    initialization: DatabaseInitialization,
) -> Result<PreparedDatabase> {
    if let DatabaseInitialization::PhysicalArchive(archive) = initialization {
        return prepare_host_database_from_archive(paths, workspace, directory_lock, &archive);
    }
    let use_template = matches!(initialization, DatabaseInitialization::PackagedTemplate);
    let outcome = prepare_database_root(paths, prepare_options_for_template(use_template))?;
    Ok(PreparedDatabase {
        workspace,
        directory_lock,
        outcome,
    })
}

pub(crate) fn prepare_database(plan: DatabasePlan) -> Result<PreparedDatabase> {
    if matches!(plan.storage, DatabaseStorage::Memory) {
        return prepare_memory_database(plan);
    }

    let (paths, workspace, directory_lock) = match &plan.storage {
        DatabaseStorage::Memory => unreachable!("memory storage handled above"),
        DatabaseStorage::Directory(directory) => {
            let directory_lock = DirectoryLock::acquire(directory)?;
            let workspace = TempDir::new().context("create WASIX runtime workspace")?;
            let paths = OliphauntPaths::with_pgdata(workspace.path(), directory);
            (paths, Some(workspace), Some(directory_lock))
        }
    };

    let prepared = prepare_host_database(paths, workspace, directory_lock, plan.initialization)?;
    Ok(prepared)
}

fn prepare_memory_database(plan: DatabasePlan) -> Result<PreparedDatabase> {
    let mut runtime_layout = prepare_memory_runtime_layout()?;
    runtime_layout.pgdata_template_root = None;
    let pgdata_storage = PgDataStorage::memory();
    let filesystem = pgdata_storage
        .memory_filesystem()
        .expect("memory storage has a virtual filesystem");

    match plan.initialization {
        DatabaseInitialization::PackagedTemplate => {
            let manifest = validated_embedded_pgdata_template_manifest()?
                .context("packaged PGDATA template is unavailable")?;
            ensure_module_matches_template(&runtime_layout.module_path(), &manifest)?;
            let archive = assets::pgdata_template_archive()
                .context("packaged PGDATA template archive is unavailable")?;
            unpack_pgdata_template_archive_virtual(archive, filesystem.as_ref())?;
        }
        DatabaseInitialization::FreshInitdb => {
            PostgresMod::run_split_initdb(&runtime_layout, &pgdata_storage)?;
        }
        DatabaseInitialization::PhysicalArchive(archive) => {
            unpack_virtual_pgdata_archive(&archive, filesystem.as_ref())?;
        }
    }

    remove_virtual_runtime_state(filesystem.as_ref())?;
    ensure!(
        virtual_cluster_is_complete(filesystem.as_ref()),
        "database initialization did not produce PG_VERSION and global/pg_control"
    );
    ensure_virtual_pgdata_matches_runtime(filesystem.as_ref())?;

    Ok(PreparedDatabase {
        workspace: None,
        directory_lock: None,
        outcome: InstallOutcome {
            runtime_layout,
            pgdata_storage,
        },
    })
}

fn prepare_host_database_from_archive(
    paths: OliphauntPaths,
    workspace: Option<TempDir>,
    directory_lock: Option<DirectoryLock>,
    archive: &[u8],
) -> Result<PreparedDatabase> {
    let runtime_layout = prepare_runtime_layout(&paths)?;
    ensure!(
        !cluster_is_complete(&paths),
        "archive initialization cannot replace an existing database directory"
    );
    ensure_pgdata_empty_or_absent(&paths.pgdata)?;
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
    Ok(PreparedDatabase {
        workspace,
        directory_lock,
        outcome: InstallOutcome {
            runtime_layout,
            pgdata_storage: PgDataStorage::host_directory(paths.pgdata),
        },
    })
}

#[cfg(feature = "extensions")]
pub(crate) fn install_missing_extension_archives(
    outcome: &InstallOutcome,
    extensions: &[Extension],
) -> Result<()> {
    for extension in extensions {
        let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
            anyhow!(
                "extension asset '{}' is not bundled in this oliphaunt-wasix build",
                extension.sql_name()
            )
        })?;
        install_bundled_extension_bytes(
            &outcome.runtime_layout.mutable_root,
            extension.sql_name(),
            bytes,
        )?;
    }
    Ok(())
}

pub(crate) fn prepare_database_root(
    paths: OliphauntPaths,
    options: RootPrepareOptions,
) -> Result<InstallOutcome> {
    let mut runtime_layout = prepare_runtime_layout(&paths)?;
    prepare_pgdata(
        &paths,
        options.cluster,
        options.incomplete_cluster,
        &mut runtime_layout,
    )?;
    Ok(InstallOutcome {
        runtime_layout,
        pgdata_storage: PgDataStorage::host_directory(paths.pgdata),
    })
}

fn prepare_pgdata(
    paths: &OliphauntPaths,
    cluster_policy: ClusterPolicy,
    incomplete_cluster: IncompleteClusterPolicy,
    runtime_layout: &mut RuntimeLayout,
) -> Result<()> {
    let _phase = timing::phase("pgdata.initialize");
    let preserve_pgdata_root = incomplete_cluster == IncompleteClusterPolicy::FailIfNonEmpty;
    ensure!(
        !(preserve_pgdata_root && pgdata_overlay_is_installed(paths)),
        "persistent database storage at {} uses the retired PGDATA overlay layout; select a new empty raw PGDATA directory (automatic migration is intentionally unsupported)",
        paths.pgdata.display()
    );
    if pgdata_overlay_is_installed(paths) {
        ensure!(
            runtime_layout.uses_shared_overlay(),
            "PGDATA at {} uses the template overlay; delete the database storage/runtime cache and recreate it with the shared runtime layout",
            paths.pgdata.display()
        );
        if try_prepare_pgdata_template_overlay(
            paths,
            &runtime_layout.module_path(),
            runtime_layout,
            preserve_pgdata_root,
        )? {
            return Ok(());
        }
    }
    if cluster_is_complete(paths) {
        ensure_existing_pgdata_matches_runtime(paths)?;
        remove_template_runtime_state(&paths.pgdata)?;
        return Ok(());
    }
    if incomplete_cluster == IncompleteClusterPolicy::FailIfNonEmpty {
        ensure_pgdata_empty_or_absent(&paths.pgdata)?;
    }
    if cluster_policy == ClusterPolicy::ExistingOrTemplate
        && !preserve_pgdata_root
        && pgdata_overlay_enabled()
        && runtime_layout.uses_shared_overlay()
        && try_prepare_pgdata_template_overlay(
            paths,
            &runtime_layout.module_path(),
            runtime_layout,
            preserve_pgdata_root,
        )?
    {
        return Ok(());
    }
    if cluster_policy == ClusterPolicy::ExistingOrTemplate
        && try_install_embedded_pgdata_template(
            paths,
            &runtime_layout.module_path(),
            preserve_pgdata_root,
        )?
    {
        return Ok(());
    }
    if incomplete_cluster == IncompleteClusterPolicy::RecoverSdkOwned {
        remove_interrupted_pgdata(paths)?;
    }
    {
        let _phase = timing::phase("pgdata.fresh_initdb");
        PostgresMod::run_split_initdb(
            runtime_layout,
            &PgDataStorage::host_directory(paths.pgdata.clone()),
        )?;
    }
    ensure!(
        cluster_is_complete(paths),
        "split WASIX initdb finished but did not create a complete PGDATA cluster at {}",
        paths.pgdata.display()
    );
    remove_template_runtime_state(&paths.pgdata)
}

fn prepare_options_for_template(use_template: bool) -> RootPrepareOptions {
    let options = if use_template {
        RootPrepareOptions::template()
    } else {
        RootPrepareOptions::fresh()
    };
    options.fail_if_incomplete()
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

fn prepare_runtime_layout(paths: &OliphauntPaths) -> Result<RuntimeLayout> {
    match resolve_runtime_layout_kind(paths)? {
        RuntimeLayoutKind::FullLocal => {
            ensure_full_runtime(paths)?;
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
            Ok(RuntimeLayout {
                kind: RuntimeLayoutKind::FullLocal,
                mutable_root: StorageRoot::host_directory(module_root.clone()),
                shared_root: None,
                module_root,
                pgdata_template_root: None,
            })
        }
        RuntimeLayoutKind::SharedRuntimeOverlay => {
            let cached_runtime = runtime_cache()?;
            prepare_shared_runtime_upper_root(&cached_runtime.runtime_root, paths)?;
            Ok(RuntimeLayout {
                kind: RuntimeLayoutKind::SharedRuntimeOverlay,
                mutable_root: StorageRoot::host_directory(paths.runtime_root()),
                shared_root: Some(cached_runtime.filesystem.clone()),
                module_root: cached_runtime.runtime_root.clone(),
                pgdata_template_root: None,
            })
        }
    }
}

fn prepare_memory_runtime_layout() -> Result<RuntimeLayout> {
    let cached_runtime = runtime_cache()?;
    let mutable_root = StorageRoot::memory();
    for path in ["/home", "/dev", "/dev/shm", "/tmp"] {
        mutable_root.create_dir_all(Path::new(path))?;
    }
    Ok(RuntimeLayout {
        kind: RuntimeLayoutKind::SharedRuntimeOverlay,
        mutable_root,
        shared_root: Some(cached_runtime.filesystem.clone()),
        module_root: cached_runtime.runtime_root.clone(),
        pgdata_template_root: None,
    })
}

fn resolve_runtime_layout_kind(paths: &OliphauntPaths) -> Result<RuntimeLayoutKind> {
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
    let filesystem: Arc<dyn VirtualFileSystem + Send + Sync> =
        Arc::new(virtual_fs::mem_fs::FileSystem::default());
    copy_host_directory_into_virtual(&runtime_root, Path::new("/"), filesystem.as_ref())?;
    Ok(CachedRuntime {
        runtime_root,
        filesystem,
    })
}

fn copy_host_directory_into_virtual(
    source: &Path,
    destination: &Path,
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    vfs_create_dir_all(filesystem, destination)?;
    let mut entries = fs::read_dir(source)
        .with_context(|| format!("read runtime directory {}", source.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .with_context(|| format!("read runtime entry type {}", entry.path().display()))?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_host_directory_into_virtual(&entry.path(), &target, filesystem)?;
        } else if file_type.is_file() {
            let bytes = fs::read(entry.path())
                .with_context(|| format!("read runtime file {}", entry.path().display()))?;
            vfs_write(filesystem, &target, &bytes)?;
        } else {
            bail!(
                "runtime cache entry {} must be a regular file or directory",
                entry.path().display()
            );
        }
    }
    Ok(())
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
    if let Some(runtime_archive) = assets::runtime_archive() {
        let mut hasher = Sha256::new();
        hasher.update(b"oliphaunt-wasix-runtime-cache-v2\nruntime=");
        hasher.update(sha256_hex(runtime_archive).as_bytes());
        hasher.update(b"\nicu=");
        if let Some(icu_archive) = assets::icu_data_archive() {
            hasher.update(sha256_hex(icu_archive).as_bytes());
        } else {
            hasher.update(b"absent");
        }
        return Ok(format!("{:x}", hasher.finalize()));
    }
    bail!(
        "Oliphaunt WASIX runtime assets are unavailable; package-manager-resolved runtime artifacts were not staged"
    )
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

    #[test]
    fn memory_storage_uses_no_host_workspace() -> Result<()> {
        if assets::pgdata_template_archive().is_none()
            || assets::pgdata_template_manifest().is_none()
        {
            return Ok(());
        }

        let prepared = prepare_database(DatabasePlan::new(
            DatabaseStorage::Memory,
            DatabaseInitialization::PackagedTemplate,
        ))?;
        assert!(prepared.workspace.is_none());
        assert!(matches!(
            &prepared.outcome.runtime_layout.mutable_root,
            StorageRoot::Memory(_)
        ));
        for path in ["/home", "/dev", "/dev/shm", "/tmp"] {
            assert!(
                prepared
                    .outcome
                    .runtime_layout
                    .mutable_root
                    .is_dir(Path::new(path)),
                "memory runtime is missing {path}"
            );
        }
        let shared_root = prepared
            .outcome
            .runtime_layout
            .shared_root
            .as_ref()
            .context("memory runtime should have an immutable shared root")?;
        assert!(
            shared_root
                .metadata(Path::new("/bin/oliphaunt"))
                .is_ok_and(|metadata| metadata.is_file()),
            "memory runtime is missing /bin/oliphaunt"
        );
        let filesystem = prepared
            .outcome
            .pgdata_storage
            .memory_filesystem()
            .expect("memory database owns a virtual PGDATA filesystem");
        assert!(vfs_file_exists(
            filesystem.as_ref(),
            Path::new("/PG_VERSION")
        ));
        assert!(vfs_file_exists(
            filesystem.as_ref(),
            Path::new("/global/pg_control")
        ));
        Ok(())
    }

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
        assert!(try_install_embedded_pgdata_template(
            &paths,
            &module_path,
            false,
        )?);

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
        assert!(try_install_embedded_pgdata_template(
            &paths,
            &module_path,
            false,
        )?);

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
    fn directory_lock_is_exclusive_until_dropped() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let first = DirectoryLock::acquire(temp_dir.path())?;
        assert!(fs::read_dir(temp_dir.path())?.next().is_none());

        let err = DirectoryLock::acquire(temp_dir.path())
            .expect_err("second directory lock should be rejected");
        assert!(format!("{err:#}").contains("database directory is already in use"));

        drop(first);
        let second = DirectoryLock::acquire(temp_dir.path())?;
        drop(second);
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
    fn base_wasix_assets_do_not_embed_extension_archives() {
        assert!(assets::extension_archive("vector").is_none());
        assert!(assets::extension_archive("hstore").is_none());
    }
}
