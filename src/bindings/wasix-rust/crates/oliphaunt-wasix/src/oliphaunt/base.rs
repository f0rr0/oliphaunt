use std::collections::BTreeSet;
use std::ffi::OsString;
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
use crate::oliphaunt::assets;
use crate::oliphaunt::database_root_descriptor::{
    DirectoryState, PGDATA_DIRECTORY, inspect_directory_root, sync_directory,
    write_database_root_descriptor,
};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::storage::{
    DatabaseStorage, PgDataStorage, StorageRoot, vfs_create_dir_all, vfs_file_exists, vfs_read,
    vfs_remove_file_if_exists, vfs_write,
};
use tempfile::TempDir;
use wasmer_wasix::virtual_fs::FileSystem as VirtualFileSystem;

mod cluster_seed_clone;

use cluster_seed_clone::clone_cluster_seed_dir;

const RUNTIME_ARCHIVE_NAME: &str = "oliphaunt.wasix.tar.zst";
const MOUNTFS_RUNTIME_MARKER: &str = ".oliphaunt-wasix-mountfs-runtime";
const RUNTIME_LAYOUT_MANIFEST_NAME: &str = ".oliphaunt-wasix-runtime-layout.json";
const RUNTIME_CACHE_COMPLETION_MARKER: &str = ".oliphaunt-wasix-runtime-cache-v1";
const ICU_DATA_MARKER_NAME: &str = ".oliphaunt-icu-data.sha256";
// Bump this when cache materialization semantics change.
const CLUSTER_SEED_CACHE_FORMAT: &str = "v1";
const DEFAULT_PASSWORD_FILE: &[u8] = b"password\n";
const DATABASE_LOCK_FILE_SUFFIX: &str = ".oliphaunt-wasix-rust.lock";

static RUNTIME_CACHE: OnceLock<std::result::Result<Arc<CachedRuntime>, String>> = OnceLock::new();
static RUNTIME_CACHE_KEY: OnceLock<std::result::Result<String, String>> = OnceLock::new();
static CLUSTER_SEED_CACHE: OnceLock<std::result::Result<Arc<CachedClusterSeed>, String>> =
    OnceLock::new();
static CLUSTER_SEED_MANIFEST: OnceLock<std::result::Result<ClusterSeedManifest, String>> =
    OnceLock::new();
static ROOT_LOCKED_PATHS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
const CLUSTER_SEED_RUNTIME_STATE_FILES: &[&str] = &["postmaster.pid", "postmaster.opts"];

#[derive(Debug)]
struct CachedRuntime {
    runtime_root: PathBuf,
    filesystem: Arc<dyn VirtualFileSystem + Send + Sync>,
}

#[derive(Debug)]
struct CachedClusterSeed {
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

#[derive(Debug, Clone)]
pub(crate) struct DatabasePlan {
    pub(crate) storage: DatabaseStorage,
}

impl DatabasePlan {
    pub(crate) fn new(storage: DatabaseStorage) -> Self {
        Self { storage }
    }
}

impl RuntimeLayout {
    pub(crate) fn module_path(&self) -> PathBuf {
        self.module_root.join("bin/postgres")
    }

    pub(crate) fn uses_shared_overlay(&self) -> bool {
        self.kind == RuntimeLayoutKind::SharedRuntimeOverlay
    }
}

/// Manifest that binds a cluster seed to the Oliphaunt WASIX runtime it was
/// created with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedRuntimeIdentity {
    product: String,
    version: String,
    engine_family: String,
    physical_format: String,
    postgres_major: u32,
    compatibility_key: String,
    consumer_sha256: String,
    producer_sha256: String,
    initdb_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedSourceIdentity {
    fingerprint: String,
    catalog_version: String,
    lane: String,
    producer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedArchiveIdentity {
    path: String,
    sha256: String,
    compressed_bytes: u64,
    expanded_bytes: u64,
    regular_files: u64,
    directories: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedExtensionIdentity {
    selected: Vec<String>,
    startup_configuration: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedIcuIdentity {
    artifact_role: String,
    upstream_version: String,
    source_commit: String,
    data_tree_sha256: String,
    data_version: String,
    data_form: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterSeedManifest {
    schema: String,
    artifact_role: String,
    catalog_profile: String,
    runtime: ClusterSeedRuntimeIdentity,
    source: ClusterSeedSourceIdentity,
    init_profile: String,
    archive: ClusterSeedArchiveIdentity,
    required_runtime_features: Vec<String>,
    extensions: ClusterSeedExtensionIdentity,
    icu: Option<ClusterSeedIcuIdentity>,
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
        let absolute = if directory.is_absolute() {
            directory.to_path_buf()
        } else {
            std::env::current_dir()?.join(directory)
        };
        let parent = absolute.parent().with_context(|| {
            format!(
                "database directory must have a parent for its ownership lock: {}",
                directory.display()
            )
        })?;
        let file_name = absolute.file_name().with_context(|| {
            format!(
                "database directory must have a final component: {}",
                directory.display()
            )
        })?;
        fs::create_dir_all(parent)
            .with_context(|| format!("create database parent {}", parent.display()))?;
        let parent_metadata = fs::symlink_metadata(parent)
            .with_context(|| format!("inspect database parent {}", parent.display()))?;
        ensure!(
            parent_metadata.is_dir() && !parent_metadata.file_type().is_symlink(),
            "database directory parent must be a real directory: {}",
            parent.display()
        );
        let canonical_root = dunce::canonicalize(parent)?.join(file_name);
        match fs::symlink_metadata(&canonical_root) {
            Ok(metadata) => ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "database directory must be a real directory: {}",
                directory.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("inspect database directory"),
        }
        {
            let mut locked = ROOT_LOCKED_PATHS
                .get_or_init(|| Mutex::new(BTreeSet::new()))
                .lock()
                .expect("database directory lock set poisoned");
            ensure!(
                locked.insert(canonical_root.clone()),
                "database root is already in use: {}",
                directory.display()
            );
        }
        let file = match open_root_lock_file(&canonical_root) {
            Ok(file) => file,
            Err(err) => {
                release_root_lock_path(&canonical_root);
                return Err(err).with_context(|| {
                    format!(
                        "database root is already in use or unavailable: {}",
                        directory.display()
                    )
                });
            }
        };
        if let Err(err) = file.try_lock() {
            release_root_lock_path(&canonical_root);
            return Err(err).with_context(|| {
                format!("database root is already in use: {}", directory.display())
            });
        }
        Ok(Self {
            path: canonical_root,
            _file: file,
        })
    }
}

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
    let bin_dir = oliphaunt_dir.join("bin");
    let module = bin_dir.join("postgres");
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
    Some((module, bin_dir))
}

fn ensure_full_runtime(paths: &OliphauntPaths) -> Result<bool> {
    let source_key = runtime_cache_key()?;
    let existing_runtime = { locate_runtime_module(paths) };
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

    let expected_archive = assets::expected_icu_data_archive_sha256()
        .context("embedded ICU data archive is missing its packaged digest")?;
    let expected_tree = assets::expected_icu_data_tree_sha256()
        .context("embedded ICU data archive is missing its logical tree digest")?;
    let strict = strict_asset_verification()?;
    if strict {
        let actual_archive = sha256_hex(archive);
        ensure!(
            actual_archive.eq_ignore_ascii_case(expected_archive),
            "embedded ICU data archive hash mismatch: manifest={expected_archive} actual={actual_archive}"
        );
    }

    if icu_data_root_contains_data(&icu_dir)?
        && installed_icu_marker_matches(runtime_root, expected_archive)?
    {
        if strict {
            ensure_installed_icu_tree_matches(&icu_dir, expected_tree)?;
        }
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
    if strict {
        ensure_installed_icu_tree_matches(&icu_dir, expected_tree)?;
    }
    fs::write(&marker, format!("{expected_archive}\n"))
        .with_context(|| format!("write {}", marker.display()))?;
    Ok(true)
}

fn installed_icu_marker_matches(runtime_root: &Path, expected_archive: &str) -> Result<bool> {
    let marker = runtime_root.join(ICU_DATA_MARKER_NAME);
    match fs::read_to_string(&marker) {
        Ok(value) => Ok(value.trim().eq_ignore_ascii_case(expected_archive)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).with_context(|| format!("read {}", marker.display())),
    }
}

fn ensure_installed_icu_tree_matches(icu_root: &Path, expected_tree: &str) -> Result<()> {
    let actual_tree = logical_tree_sha256(icu_root)?;
    ensure!(
        actual_tree.eq_ignore_ascii_case(expected_tree),
        "installed ICU data tree hash mismatch: manifest={expected_tree} actual={actual_tree}"
    );
    Ok(())
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

fn try_install_embedded_cluster_seed(paths: &OliphauntPaths, module_path: &Path) -> Result<bool> {
    if cluster_is_complete(paths) {
        return Ok(false);
    }

    let Some(manifest) = validated_embedded_cluster_seed_manifest()? else {
        return Ok(false);
    };

    ensure_module_matches_seed(module_path, &manifest)?;
    let seed = cluster_seed_cache()?;

    publish_cluster_seed_clone(&seed.pgdata, &paths.pgdata)?;
    Ok(true)
}

fn publish_cluster_seed_clone(source: &Path, pgdata: &Path) -> Result<()> {
    let root = pgdata
        .parent()
        .context("PGDATA has no managed-root parent")?;
    fs::create_dir_all(root).with_context(|| format!("create pgdata parent {}", root.display()))?;
    let staging = cluster_seed_publication_staging(pgdata)?;
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .with_context(|| format!("remove stale cluster seed staging {}", staging.display()))?;
    }
    if pgdata.exists() {
        fs::remove_dir_all(pgdata)
            .with_context(|| format!("remove existing pgdata {}", pgdata.display()))?;
    }
    let result = (|| -> Result<()> {
        clone_cluster_seed_dir(source, &staging)?;
        remove_cluster_seed_runtime_state(&staging)?;
        promote_synced_directory(&staging, pgdata, root, "cluster seed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn cluster_seed_publication_staging(pgdata: &Path) -> Result<PathBuf> {
    let root = pgdata
        .parent()
        .context("PGDATA has no managed-root parent")?;
    let parent = root
        .parent()
        .context("managed database root has no parent directory")?;
    let name = root
        .file_name()
        .context("managed database root has no directory name")?;
    let mut staging = OsString::from(".");
    staging.push(name);
    staging.push(".pgdata.oliphaunt-seed");
    Ok(parent.join(staging))
}

fn sync_publication_tree(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspect publication entry {}", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "cluster seed publication contains a symbolic link: {}",
        path.display()
    );
    if metadata.is_file() {
        sync_publication_file(path)
            .with_context(|| format!("sync publication file {}", path.display()))?;
        return Ok(());
    }
    ensure!(
        metadata.is_dir(),
        "cluster seed publication contains a special file: {}",
        path.display()
    );
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("read publication directory {}", path.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        sync_publication_tree(&entry.path())?;
    }
    sync_directory(path).with_context(|| format!("sync publication directory {}", path.display()))
}

#[cfg(windows)]
fn sync_publication_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(not(windows))]
fn sync_publication_file(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}

fn promote_synced_directory(
    staging: &Path,
    target: &Path,
    parent: &Path,
    label: &str,
) -> Result<()> {
    sync_publication_tree(staging)?;
    fs::rename(staging, target).with_context(|| {
        format!(
            "promote {label} {} -> {}",
            staging.display(),
            target.display()
        )
    })?;
    sync_directory(parent).with_context(|| format!("sync {label} parent {}", parent.display()))
}

fn ensure_module_matches_seed(module_path: &Path, manifest: &ClusterSeedManifest) -> Result<()> {
    let strict = strict_asset_verification()?;
    if let Some(icu) = &manifest.icu {
        let runtime_root = module_path
            .parent()
            .and_then(Path::parent)
            .context("WASIX runtime module has no runtime root")?;
        ensure_installed_icu_matches_seed(runtime_root, &icu.data_tree_sha256, strict)?;
    }
    if strict {
        let actual_wasm = sha256_file(module_path)?;
        ensure!(
            actual_wasm.eq_ignore_ascii_case(&manifest.runtime.consumer_sha256),
            "embedded cluster seed wasm hash mismatch: manifest={} actual={actual_wasm}",
            manifest.runtime.consumer_sha256
        );
    }
    Ok(())
}

fn ensure_installed_icu_matches_seed(
    runtime_root: &Path,
    seed_tree_sha256: &str,
    strict: bool,
) -> Result<()> {
    let expected_archive = assets::expected_icu_data_archive_sha256()
        .context("ICU cluster seed requires packaged ICU data")?;
    let expected_tree = assets::expected_icu_data_tree_sha256()
        .context("packaged ICU data is missing its logical tree digest")?;
    ensure_installed_icu_identity(
        runtime_root,
        seed_tree_sha256,
        expected_archive,
        expected_tree,
        strict,
    )
}

fn ensure_installed_icu_identity(
    runtime_root: &Path,
    seed_tree_sha256: &str,
    expected_archive: &str,
    expected_tree: &str,
    strict: bool,
) -> Result<()> {
    ensure!(
        seed_tree_sha256.eq_ignore_ascii_case(expected_tree),
        "packaged ICU data does not match the ICU cluster seed: seed={seed_tree_sha256} packaged={expected_tree}"
    );
    let icu_root = runtime_root.join("share/icu");
    ensure!(
        icu_data_root_contains_data(&icu_root)?,
        "installed ICU data is missing under {}",
        icu_root.display()
    );
    ensure!(
        installed_icu_marker_matches(runtime_root, expected_archive)?,
        "installed ICU data receipt does not match the packaged ICU data"
    );
    if strict {
        ensure_installed_icu_tree_matches(&icu_root, expected_tree)?;
    }
    Ok(())
}

/// Digest the logical portable files tree as sorted `path NUL size NUL file-bytes LF` rows.
fn logical_tree_sha256(root: &Path) -> Result<String> {
    ensure!(
        root.is_dir(),
        "ICU data directory is missing: {}",
        root.display()
    );
    let mut files = Vec::new();
    collect_regular_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    ensure!(
        !files.is_empty(),
        "ICU data directory is empty: {}",
        root.display()
    );
    let mut digest = Sha256::new();
    for (relative, file) in files {
        let size = fs::metadata(&file)
            .with_context(|| format!("metadata {}", file.display()))?
            .len();
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(size.to_string().as_bytes());
        digest.update([0]);
        digest.update(fs::read(&file).with_context(|| format!("read {}", file.display()))?);
        digest.update([b'\n']);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_regular_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)
        .with_context(|| format!("read {}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).with_context(|| format!("inspect {}", path.display()))?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "ICU data must not contain symlinks: {}",
            path.display()
        );
        if metadata.is_dir() {
            collect_regular_files(root, &path, files)?;
        } else {
            ensure!(
                metadata.is_file(),
                "ICU data must contain only files and directories: {}",
                path.display()
            );
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("ICU data path is not UTF-8")?
                .replace('\\', "/");
            files.push((relative, path));
        }
    }
    Ok(())
}

fn validated_embedded_cluster_seed_manifest() -> Result<Option<ClusterSeedManifest>> {
    let Some(seed_manifest) = assets::cluster_seed_manifest() else {
        return Ok(None);
    };
    let Some(seed_archive) = assets::cluster_seed_archive() else {
        return Ok(None);
    };

    let manifest = CLUSTER_SEED_MANIFEST
        .get_or_init(|| {
            let manifest: ClusterSeedManifest = serde_json::from_slice(seed_manifest)
                .context("parse embedded cluster seed manifest")
                .map_err(|err| format!("{err:#}"))?;
            validate_cluster_seed_manifest_metadata(&manifest).map_err(|err| format!("{err:#}"))?;

            Ok(manifest)
        })
        .clone()
        .map_err(|message| anyhow!(message))?;
    if strict_asset_verification()? {
        let actual_archive = sha256_hex(seed_archive);
        ensure!(
            actual_archive.eq_ignore_ascii_case(&manifest.archive.sha256),
            "embedded cluster seed archive hash mismatch: manifest={} actual={actual_archive}",
            manifest.archive.sha256
        );
    }
    Ok(Some(manifest))
}

fn validate_cluster_seed_manifest_metadata(manifest: &ClusterSeedManifest) -> Result<()> {
    let selected_profile = assets::selected_catalog_profile().as_str();
    validate_cluster_seed_profile_contract(ClusterSeedProfile::from(manifest), selected_profile)?;
    ensure!(
        manifest.runtime.product == "liboliphaunt-wasix"
            && manifest.runtime.engine_family == "wasix"
            && manifest.runtime.physical_format == "wasix-pg18-v1"
            && manifest.runtime.compatibility_key == "wasix-pg18-datum32-v1"
            && manifest.runtime.postgres_major == 18,
        "embedded cluster seed has an incompatible WASIX physical identity"
    );
    ensure!(
        manifest.runtime.consumer_sha256 == manifest.runtime.producer_sha256,
        "embedded cluster seed producer and consumer runtime digests differ"
    );
    ensure!(
        manifest.archive.path == format!("cluster-seeds/{selected_profile}.tar.zst")
            && manifest.archive.compressed_bytes > 0
            && manifest.archive.expanded_bytes > 0
            && manifest.archive.regular_files > 0
            && manifest.archive.directories > 0,
        "embedded cluster seed archive identity is invalid"
    );
    ensure!(
        manifest.extensions.selected.is_empty()
            && manifest.extensions.startup_configuration.is_empty(),
        "embedded cluster seed must be extension-free"
    );
    let metadata = assets::asset_manifest_metadata()?;
    ensure!(
        metadata.cluster_seed_profile == selected_profile
            && metadata.cluster_seed_compatibility_key == "wasix-pg18-datum32-v1",
        "asset manifest selected cluster seed identity is inconsistent"
    );
    let asset_source_lane = metadata
        .source_lane
        .as_deref()
        .context("asset manifest is missing source-lane metadata")?;
    let seed_source_lane = manifest.source.lane.as_str();
    ensure!(
        seed_source_lane == asset_source_lane,
        "embedded cluster seed source lane mismatch: seed={} assets={asset_source_lane}",
        seed_source_lane
    );
    if let Some(pgdata_source_lane) = metadata.cluster_seed_source_lane.as_deref() {
        ensure!(
            seed_source_lane == pgdata_source_lane,
            "embedded cluster seed source lane mismatch: seed={} asset-entry={pgdata_source_lane}",
            seed_source_lane
        );
    }

    if let Some(expected) = metadata.cluster_seed_postgres_version.as_deref() {
        ensure!(
            manifest.runtime.postgres_major.to_string() == expected,
            "embedded cluster seed PostgreSQL version mismatch: seed={} asset-entry={expected}",
            manifest.runtime.postgres_major
        );
    }

    let expected_fingerprint = metadata
        .cluster_seed_source_fingerprint
        .as_deref()
        .or(metadata.source_fingerprint.as_deref());
    if let Some(expected) = expected_fingerprint {
        ensure!(
            manifest.source.fingerprint == expected,
            "embedded cluster seed source fingerprint mismatch: seed={} assets={expected}",
            manifest.source.fingerprint
        );
    }

    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct ClusterSeedProfile<'a> {
    schema: &'a str,
    artifact_role: &'a str,
    catalog_profile: &'a str,
    required_runtime_features: &'a [String],
    icu: Option<&'a ClusterSeedIcuIdentity>,
}

impl<'a> From<&'a ClusterSeedManifest> for ClusterSeedProfile<'a> {
    fn from(manifest: &'a ClusterSeedManifest) -> Self {
        Self {
            schema: &manifest.schema,
            artifact_role: &manifest.artifact_role,
            catalog_profile: &manifest.catalog_profile,
            required_runtime_features: &manifest.required_runtime_features,
            icu: manifest.icu.as_ref(),
        }
    }
}

fn validate_cluster_seed_profile_contract(
    manifest: ClusterSeedProfile<'_>,
    selected_profile: &str,
) -> Result<()> {
    let expected_role = if selected_profile == "icu" {
        "cluster-seed-icu"
    } else {
        "cluster-seed-standard"
    };
    ensure!(
        manifest.schema == "oliphaunt-cluster-seed-v1",
        "unsupported cluster seed schema"
    );
    ensure!(
        manifest.catalog_profile == selected_profile && manifest.artifact_role == expected_role,
        "embedded cluster seed profile mismatch: selected={selected_profile} manifest={} role={}",
        manifest.catalog_profile,
        manifest.artifact_role
    );
    if selected_profile == "icu" {
        let icu = manifest
            .icu
            .as_ref()
            .context("ICU cluster seed is missing ICU identity")?;
        ensure!(
            manifest.required_runtime_features == ["icu"]
                && icu.artifact_role == "icu-data"
                && icu.upstream_version == "76.1"
                && icu.data_version == "76.1"
                && icu.data_form == "files-le",
            "ICU cluster seed has an incompatible ICU identity"
        );
    } else {
        ensure!(
            manifest.required_runtime_features.is_empty() && manifest.icu.is_none(),
            "standard cluster seed must not require or identify ICU data"
        );
    }
    Ok(())
}

fn cluster_seed_cache() -> Result<Arc<CachedClusterSeed>> {
    CLUSTER_SEED_CACHE
        .get_or_init(|| {
            build_cluster_seed_cache()
                .map(Arc::new)
                .map_err(|err| format!("{err:#}"))
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

fn build_cluster_seed_cache() -> Result<CachedClusterSeed> {
    let Some(manifest) = validated_embedded_cluster_seed_manifest()? else {
        bail!("embedded cluster seed manifest is unavailable");
    };
    let Some(seed_archive) = assets::cluster_seed_archive() else {
        bail!("embedded cluster seed archive is unavailable");
    };

    let dirs = ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")?;
    let cache_root = dirs
        .cache_dir()
        .join("cluster-seeds")
        .join(assets::selected_catalog_profile().as_str())
        .join(CLUSTER_SEED_CACHE_FORMAT);
    let _cache_lock = CacheLock::acquire(
        &cache_root
            .join(".locks")
            .join(format!("{}.lock", manifest.archive.sha256)),
    )?;
    let root = cache_root.join(&manifest.archive.sha256);
    let pgdata = root.join("base");
    if pgdata.join("PG_VERSION").is_file() && pgdata.join("global/pg_control").is_file() {
        return Ok(CachedClusterSeed { pgdata });
    }

    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale cluster seed cache {}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .with_context(|| format!("create cluster seed cache {}", root.display()))?;
    let staging = root.join(format!(".base-{}-{}", std::process::id(), tmp_suffix()));
    let result = (|| -> Result<()> {
        unpack_cluster_seed_archive(seed_archive, &staging)?;
        validate_cluster_seed_dir(&staging, &manifest)?;
        remove_cluster_seed_runtime_state(&staging)?;
        promote_synced_directory(&staging, &pgdata, &root, "cluster seed cache")
    })();
    if let Err(error) = result {
        let cleanup = (|| -> Result<()> {
            if staging.exists() {
                fs::remove_dir_all(&staging).with_context(|| {
                    format!("remove failed cache staging {}", staging.display())
                })?;
            }
            if pgdata.exists() {
                fs::remove_dir_all(&pgdata).with_context(|| {
                    format!("remove uncertain cache PGDATA {}", pgdata.display())
                })?;
            }
            sync_directory(&root)
                .with_context(|| format!("sync cleaned cache root {}", root.display()))
        })();
        if let Err(cleanup) = cleanup {
            return Err(error.context(format!(
                "cluster seed cache cleanup also failed: {cleanup:#}"
            )));
        }
        return Err(error);
    }
    Ok(CachedClusterSeed { pgdata })
}

fn validate_cluster_seed_dir(pgdata: &Path, manifest: &ClusterSeedManifest) -> Result<()> {
    let pg_version = fs::read_to_string(pgdata.join("PG_VERSION"))
        .with_context(|| format!("read {}", pgdata.join("PG_VERSION").display()))?;
    ensure!(
        pg_version.trim() == manifest.runtime.postgres_major.to_string(),
        "embedded cluster seed postgres version mismatch: manifest={} actual={}",
        manifest.runtime.postgres_major,
        pg_version.trim()
    );
    ensure!(
        pgdata.join("global").join("pg_control").exists(),
        "embedded cluster seed did not contain global/pg_control at archive root"
    );
    Ok(())
}

fn unpack_cluster_seed_archive(bytes: &[u8], destination: &Path) -> Result<()> {
    let decoder = ZstdDecoder::new(Cursor::new(bytes)).context("decode cluster seed archive")?;
    let mut archive = Archive::new(decoder);
    unpack_archive_entries(&mut archive, destination)
}

fn unpack_cluster_seed_archive_virtual(
    bytes: &[u8],
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    let decoder = ZstdDecoder::new(Cursor::new(bytes)).context("decode cluster seed archive")?;
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

fn remove_cluster_seed_runtime_state(pgdata: &Path) -> Result<()> {
    for name in CLUSTER_SEED_RUNTIME_STATE_FILES {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

fn remove_virtual_runtime_state(filesystem: &(dyn VirtualFileSystem + Send + Sync)) -> Result<()> {
    for name in CLUSTER_SEED_RUNTIME_STATE_FILES {
        vfs_remove_file_if_exists(filesystem, &Path::new("/").join(name))?;
    }
    Ok(())
}

fn cluster_is_complete(paths: &OliphauntPaths) -> bool {
    paths.marker_cluster().is_file() && paths.marker_control_file().is_file()
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

#[derive(Debug, Clone)]
pub(crate) struct InstallOutcome {
    pub(crate) runtime_layout: RuntimeLayout,
    pub(crate) pgdata_storage: PgDataStorage,
}

fn prepare_host_database(
    paths: OliphauntPaths,
    workspace: Option<TempDir>,
    directory_lock: Option<DirectoryLock>,
    initialize: bool,
) -> Result<PreparedDatabase> {
    let outcome = prepare_database_root(paths, initialize)?;
    Ok(PreparedDatabase {
        workspace,
        directory_lock,
        outcome,
    })
}

pub(crate) fn prepare_database(
    plan: DatabasePlan,
    initial_username: &str,
) -> Result<PreparedDatabase> {
    if matches!(plan.storage, DatabaseStorage::Memory) {
        ensure_initial_username(DirectoryState::New, initial_username)?;
        return prepare_memory_database(plan);
    }

    let DatabaseStorage::Directory(directory) = &plan.storage else {
        unreachable!("memory storage handled above")
    };
    let directory_lock = DirectoryLock::acquire(directory)?;
    let directory_exists = match fs::symlink_metadata(directory) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error).context("inspect database directory"),
    };
    if !directory_exists {
        ensure_initial_username(DirectoryState::New, initial_username)?;
        fs::create_dir(directory)
            .with_context(|| format!("create database directory {}", directory.display()))?;
    }
    let metadata = fs::symlink_metadata(directory)
        .with_context(|| format!("inspect database directory {}", directory.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "database directory must be a real directory: {}",
        directory.display()
    );
    let state = inspect_directory_root(directory)?;
    ensure_initial_username(state, initial_username)?;
    let workspace = TempDir::new().context("create WASIX runtime workspace")?;
    let paths = OliphauntPaths::with_pgdata(workspace.path(), directory.join(PGDATA_DIRECTORY));
    let prepared = match prepare_host_database(
        paths,
        Some(workspace),
        Some(directory_lock),
        state == DirectoryState::New,
    ) {
        Ok(prepared) => prepared,
        Err(error) if state == DirectoryState::New => {
            return Err(cleanup_owned_new_pgdata(directory, error));
        }
        Err(error) => return Err(error),
    };
    if state == DirectoryState::New
        && let Err(error) = write_database_root_descriptor(directory)
    {
        // A failure after rename/fsync has an uncertain publication state;
        // leave the complete root untouched. Before publication, PGDATA is
        // solely ours and must not strand the caller's empty root.
        let descriptor =
            directory.join(crate::oliphaunt::database_root_descriptor::DESCRIPTOR_FILE);
        match fs::symlink_metadata(&descriptor) {
            Ok(_) => return Err(error),
            Err(inspect) if inspect.kind() == std::io::ErrorKind::NotFound => {
                return Err(cleanup_owned_new_pgdata(directory, error));
            }
            Err(inspect) => {
                return Err(error.context(format!(
                    "preserved PGDATA because root descriptor publication at {} is uncertain: {inspect}",
                    descriptor.display()
                )));
            }
        }
    }
    Ok(prepared)
}

fn ensure_initial_username(state: DirectoryState, username: &str) -> Result<()> {
    ensure!(
        state == DirectoryState::Existing || username == "postgres",
        "PostgreSQL username {username:?} selects an existing role; new storage must first be opened as postgres"
    );
    Ok(())
}

fn cleanup_owned_new_pgdata(root: &Path, error: anyhow::Error) -> anyhow::Error {
    let pgdata = root.join(PGDATA_DIRECTORY);
    let removal = match fs::remove_dir_all(&pgdata) {
        Ok(()) => Ok(()),
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cleanup) => Err(anyhow!(
            "remove PGDATA created during first open at {}: {cleanup}",
            pgdata.display()
        )),
    };
    let cleanup = removal.and_then(|()| {
        sync_directory(root)
            .with_context(|| format!("sync database root {} after cleanup", root.display()))
    });
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => error.context(format!(
            "failed to clean unpublished PGDATA created during first open: {cleanup:#}"
        )),
    }
}

fn prepare_memory_database(_plan: DatabasePlan) -> Result<PreparedDatabase> {
    let runtime_layout = prepare_memory_runtime_layout()?;
    let pgdata_storage = PgDataStorage::memory();
    let filesystem = pgdata_storage
        .memory_filesystem()
        .expect("memory storage has a virtual filesystem");

    let manifest = validated_embedded_cluster_seed_manifest()?
        .context("packaged cluster seed is unavailable")?;
    ensure_module_matches_seed(&runtime_layout.module_path(), &manifest)?;
    let archive =
        assets::cluster_seed_archive().context("packaged cluster seed archive is unavailable")?;
    unpack_cluster_seed_archive_virtual(archive, filesystem.as_ref())?;

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

#[cfg(feature = "extensions")]
pub(crate) fn install_missing_extension_archives(
    outcome: &InstallOutcome,
    extensions: &[Extension],
) -> Result<()> {
    for extension in extensions {
        let bytes = assets::extension_archive(extension.sql_name()).ok_or_else(|| {
            crate::error::invalid_configuration(format!(
                "extension asset '{}' is not bundled in this oliphaunt-wasix build",
                extension.sql_name()
            ))
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
    initialize: bool,
) -> Result<InstallOutcome> {
    let mut runtime_layout = prepare_runtime_layout(&paths)?;
    prepare_pgdata(&paths, initialize, &mut runtime_layout)?;
    Ok(InstallOutcome {
        runtime_layout,
        pgdata_storage: PgDataStorage::host_directory(paths.pgdata),
    })
}

fn prepare_pgdata(
    paths: &OliphauntPaths,
    initialize: bool,
    runtime_layout: &mut RuntimeLayout,
) -> Result<()> {
    if cluster_is_complete(paths) {
        ensure_existing_pgdata_matches_runtime(paths)?;
        remove_cluster_seed_runtime_state(&paths.pgdata)?;
        return Ok(());
    }
    ensure!(
        initialize,
        "existing managed database root has incomplete PGDATA at {}",
        paths.pgdata.display()
    );
    if try_install_embedded_cluster_seed(paths, &runtime_layout.module_path())? {
        return Ok(());
    }
    if std::env::var("OLIPHAUNT_WASIX_DEVELOPMENT_INITDB").as_deref() == Ok("1") {
        PostgresMod::run_split_initdb(
            runtime_layout,
            &PgDataStorage::host_directory(paths.pgdata.clone()),
        )?;
    } else {
        bail!(
            "the selected packaged {} cluster seed is unavailable; published packages do not silently fall back to initdb",
            assets::selected_catalog_profile().as_str()
        );
    }
    ensure!(
        cluster_is_complete(paths),
        "split WASIX initdb finished but did not create a complete PGDATA cluster at {}",
        paths.pgdata.display()
    );
    remove_cluster_seed_runtime_state(&paths.pgdata)
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
    let key = runtime_cache_key()?;
    let dirs = ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")?;
    let cache_root = dirs.cache_dir().join("runtime");
    let _cache_lock = CacheLock::acquire(&cache_root.join(".locks").join(format!("{key}.lock")))?;
    let root = cache_root.join(&key);
    let mut paths = OliphauntPaths::with_root(&root);
    let cache_is_current = runtime_cache_completion_matches(&root, &key)?
        && locate_runtime_module(&paths).is_some()
        && full_runtime_layout_matches_current(&paths, &key)?
        && !runtime_support_files_need_repair(&paths)?;
    if !cache_is_current {
        let staging = cache_root.join(format!(".{key}.build"));
        if staging.exists() {
            fs::remove_dir_all(&staging).with_context(|| {
                format!("remove stale runtime cache staging {}", staging.display())
            })?;
        }
        let staging_paths = OliphauntPaths::with_root(&staging);
        let build_result = (|| -> Result<()> {
            ensure_full_runtime(&staging_paths)?;
            reset_runtime_cache_mutable_state(&staging_paths.runtime_root())?;
            let marker = staging.join(RUNTIME_CACHE_COMPLETION_MARKER);
            fs::write(&marker, format!("{key}\n")).with_context(|| {
                format!("write runtime cache completion marker {}", marker.display())
            })?;
            if root.exists() {
                fs::remove_dir_all(&root)
                    .with_context(|| format!("remove invalid runtime cache {}", root.display()))?;
            }
            promote_synced_directory(&staging, &root, &cache_root, "runtime cache")
        })();
        if let Err(error) = build_result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        paths = OliphauntPaths::with_root(&root);
    }
    let (module_path, _) = {
        locate_runtime_module(&paths).ok_or_else(|| {
            anyhow!(
                "runtime missing: could not locate module under {} after cache install",
                paths.pgroot.display()
            )
        })?
    };
    if strict_asset_verification()?
        && let Some(manifest) = validated_embedded_cluster_seed_manifest()?
    {
        ensure_module_matches_seed(&module_path, &manifest)?;
    }
    let runtime_root = module_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| paths.runtime_root());
    let filesystem: Arc<dyn VirtualFileSystem + Send + Sync> =
        Arc::new(virtual_fs::mem_fs::FileSystem::default());
    copy_host_directory_into_virtual(&runtime_root, Path::new("/"), filesystem.as_ref())?;
    Ok(CachedRuntime {
        runtime_root,
        filesystem,
    })
}

fn runtime_cache_completion_matches(root: &Path, key: &str) -> Result<bool> {
    let marker = root.join(RUNTIME_CACHE_COMPLETION_MARKER);
    match fs::read_to_string(&marker) {
        Ok(value) => Ok(value.trim() == key),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("read {}", marker.display())),
    }
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
    RUNTIME_CACHE_KEY
        .get_or_init(|| build_runtime_cache_key().map_err(|error| format!("{error:#}")))
        .clone()
        .map_err(|message| anyhow!(message))
}

fn build_runtime_cache_key() -> Result<String> {
    ensure!(
        assets::runtime_archive().is_some(),
        "Oliphaunt WASIX runtime assets are unavailable; package-manager-resolved runtime artifacts were not staged"
    );
    let runtime_sha256 = assets::expected_runtime_archive_sha256()?;
    let icu_sha256 = if assets::icu_data_archive().is_some() {
        Some(
            assets::expected_icu_data_archive_sha256()
                .context("embedded ICU data archive is missing its packaged digest")?,
        )
    } else {
        None
    };
    Ok(runtime_cache_key_from_digests(&runtime_sha256, icu_sha256))
}

fn runtime_cache_key_from_digests(runtime_sha256: &str, icu_sha256: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"oliphaunt-wasix-resolved-runtime-closure-v2\nruntime=");
    hasher.update(runtime_sha256.to_ascii_lowercase().as_bytes());
    hasher.update(b"\nicu=");
    hasher.update(
        icu_sha256
            .map(str::to_ascii_lowercase)
            .as_deref()
            .unwrap_or("absent")
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

fn prepare_shared_runtime_upper_root(src_runtime: &Path, paths: &OliphauntPaths) -> Result<()> {
    let dest_runtime = paths.runtime_root();

    {
        for path in [
            dest_runtime.to_path_buf(),
            dest_runtime.join("home"),
            dest_runtime.join("dev"),
        ] {
            fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        }
    }

    {
        reset_dir(&dest_runtime.join("tmp"))?;
        reset_dir(&dest_runtime.join("dev/shm"))?;
    }

    {
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SharedClusterSeedProfile {
        schema: String,
        artifact_role: String,
        catalog_profile: String,
        required_runtime_features: Vec<String>,
        icu: Option<ClusterSeedIcuIdentity>,
    }

    impl SharedClusterSeedProfile {
        fn as_contract(&self) -> ClusterSeedProfile<'_> {
            ClusterSeedProfile {
                schema: &self.schema,
                artifact_role: &self.artifact_role,
                catalog_profile: &self.catalog_profile,
                required_runtime_features: &self.required_runtime_features,
                icu: self.icu.as_ref(),
            }
        }
    }

    #[test]
    fn runtime_cache_key_uses_only_declared_runtime_closure_digests() {
        let runtime = "a".repeat(64);
        let other_runtime = "b".repeat(64);
        let icu = "c".repeat(64);
        let other_icu = "d".repeat(64);

        let standard = runtime_cache_key_from_digests(&runtime, None);
        assert_eq!(
            standard,
            runtime_cache_key_from_digests(&runtime.to_ascii_uppercase(), None)
        );
        assert_ne!(
            standard,
            runtime_cache_key_from_digests(&other_runtime, None)
        );
        let with_icu = runtime_cache_key_from_digests(&runtime, Some(&icu));
        assert_ne!(standard, with_icu);
        assert_ne!(
            with_icu,
            runtime_cache_key_from_digests(&runtime, Some(&other_icu))
        );
    }

    #[test]
    fn runtime_cache_completion_marker_binds_the_published_key() -> Result<()> {
        let root = TempDir::new()?;
        assert!(!runtime_cache_completion_matches(root.path(), "expected")?);

        fs::write(
            root.path().join(RUNTIME_CACHE_COMPLETION_MARKER),
            b"other\n",
        )?;
        assert!(!runtime_cache_completion_matches(root.path(), "expected")?);

        fs::write(
            root.path().join(RUNTIME_CACHE_COMPLETION_MARKER),
            b"expected\n",
        )?;
        assert!(runtime_cache_completion_matches(root.path(), "expected")?);
        Ok(())
    }

    #[test]
    fn installed_icu_uses_receipt_normally_and_hashes_the_tree_only_when_strict() -> Result<()> {
        let root = tempfile::tempdir()?;
        let icu_root = root.path().join("share/icu/icudt76l");
        fs::create_dir_all(&icu_root)?;
        fs::write(icu_root.join("data.dat"), b"installed bytes")?;

        let archive_sha256 = "a".repeat(64);
        let declared_tree_sha256 = "b".repeat(64);
        fs::write(
            root.path().join(ICU_DATA_MARKER_NAME),
            format!("{archive_sha256}\n"),
        )?;

        ensure_installed_icu_identity(
            root.path(),
            &declared_tree_sha256,
            &archive_sha256,
            &declared_tree_sha256,
            false,
        )?;
        let error = ensure_installed_icu_identity(
            root.path(),
            &declared_tree_sha256,
            &archive_sha256,
            &declared_tree_sha256,
            true,
        )
        .expect_err("strict verification must hash the installed tree");
        assert!(error.to_string().contains("tree hash mismatch"));

        let actual_tree_sha256 = logical_tree_sha256(&root.path().join("share/icu"))?;
        ensure_installed_icu_identity(
            root.path(),
            &actual_tree_sha256,
            &archive_sha256,
            &actual_tree_sha256,
            true,
        )?;

        fs::write(root.path().join(ICU_DATA_MARKER_NAME), "stale\n")?;
        let error = ensure_installed_icu_identity(
            root.path(),
            &declared_tree_sha256,
            &archive_sha256,
            &declared_tree_sha256,
            false,
        )
        .expect_err("normal verification must reject a stale receipt");
        assert!(error.to_string().contains("receipt does not match"));
        Ok(())
    }

    #[test]
    fn shared_cluster_seed_profile_fixtures_match_binding_semantics() -> Result<()> {
        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../shared/cluster-seed-contract/fixtures");
        let standard: SharedClusterSeedProfile = serde_json::from_str(&fs::read_to_string(
            fixture_root.join("standard.valid.json"),
        )?)?;
        validate_cluster_seed_profile_contract(standard.as_contract(), "standard")?;

        let icu: SharedClusterSeedProfile =
            serde_json::from_str(&fs::read_to_string(fixture_root.join("icu.valid.json"))?)?;
        validate_cluster_seed_profile_contract(icu.as_contract(), "icu")?;

        let mismatch: SharedClusterSeedProfile = serde_json::from_str(&fs::read_to_string(
            fixture_root.join("profile-mismatch.invalid.json"),
        )?)?;
        let error = validate_cluster_seed_profile_contract(mismatch.as_contract(), "standard")
            .expect_err("profile mismatch fixture must be rejected");
        assert!(error.to_string().contains("profile mismatch"));
        Ok(())
    }

    #[test]
    fn username_selects_an_existing_role_without_mutating_new_storage() -> Result<()> {
        ensure_initial_username(DirectoryState::Existing, "app_user")?;
        let parent = tempfile::tempdir()?;
        let root = parent.path().join("database");
        let error = prepare_database(
            DatabasePlan::new(DatabaseStorage::Directory(root.clone())),
            "app_user",
        )
        .expect_err("a non-postgres role cannot initialize a new root");

        assert!(
            error
                .to_string()
                .contains("new storage must first be opened as postgres")
        );
        assert!(!root.exists());
        Ok(())
    }

    #[test]
    fn failed_first_open_removes_only_owned_pgdata() -> Result<()> {
        let root = tempfile::tempdir()?;
        let pgdata = root.path().join(PGDATA_DIRECTORY);
        fs::create_dir(&pgdata)?;
        fs::write(pgdata.join("partial"), b"partial")?;

        let primary = anyhow!("first open failed");
        let returned = cleanup_owned_new_pgdata(root.path(), primary);

        assert_eq!(returned.to_string(), "first open failed");
        assert!(root.path().is_dir());
        assert!(!pgdata.exists());
        Ok(())
    }

    #[test]
    fn cluster_seed_publication_replaces_staging_then_promotes_complete_pgdata() -> Result<()> {
        let source = TempDir::new()?;
        fs::create_dir_all(source.path().join("global"))?;
        fs::create_dir(source.path().join("pg_wal"))?;
        fs::write(source.path().join("PG_VERSION"), b"18\n")?;
        fs::write(source.path().join("global/pg_control"), b"control")?;
        fs::write(source.path().join("postmaster.pid"), b"stale")?;

        let parent = TempDir::new()?;
        let root = parent.path().join("database");
        fs::create_dir(&root)?;
        let pgdata = root.join(PGDATA_DIRECTORY);
        let staging = cluster_seed_publication_staging(&pgdata)?;
        fs::create_dir(&staging)?;
        fs::write(staging.join("interrupted"), b"stale")?;

        publish_cluster_seed_clone(source.path(), &pgdata)?;

        assert!(pgdata.join("PG_VERSION").is_file());
        assert!(pgdata.join("global/pg_control").is_file());
        assert!(!pgdata.join("postmaster.pid").exists());
        assert!(!staging.exists());
        Ok(())
    }

    #[test]
    fn publication_tree_syncs_regular_files_on_this_host() -> Result<()> {
        let root = TempDir::new()?;
        fs::create_dir(root.path().join("nested"))?;
        fs::write(root.path().join("nested/marker"), b"complete\n")?;

        sync_publication_tree(root.path())?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn cluster_seed_publication_failure_leaves_no_partial_pgdata_or_staging() -> Result<()> {
        let source = TempDir::new()?;
        fs::write(source.path().join("PG_VERSION"), b"18\n")?;
        std::os::unix::fs::symlink("PG_VERSION", source.path().join("unsafe-link"))?;

        let parent = TempDir::new()?;
        let root = parent.path().join("database");
        fs::create_dir(&root)?;
        let pgdata = root.join(PGDATA_DIRECTORY);
        let staging = cluster_seed_publication_staging(&pgdata)?;

        let error = publish_cluster_seed_clone(source.path(), &pgdata)
            .expect_err("symbolic links must fail before publication");

        assert!(format!("{error:#}").contains("symbolic link"));
        assert!(!pgdata.exists());
        assert!(!staging.exists());
        Ok(())
    }

    #[test]
    fn memory_storage_uses_no_host_workspace() -> Result<()> {
        if assets::cluster_seed_archive().is_none() || assets::cluster_seed_manifest().is_none() {
            return Ok(());
        }

        let prepared = prepare_database(DatabasePlan::new(DatabaseStorage::Memory), "postgres")?;
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
                .metadata(Path::new("/bin/postgres"))
                .is_ok_and(|metadata| metadata.is_file()),
            "memory runtime is missing /bin/postgres"
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
    fn embedded_cluster_seed_installs_valid_cluster() -> Result<()> {
        if !embedded_cluster_seed_is_available() {
            return Ok(());
        }

        let temp_dir = TempDir::new()?;
        let paths = OliphauntPaths::with_root(temp_dir.path());
        ensure_full_runtime(&paths)?;

        let (module_path, _) =
            locate_runtime_module(&paths).context("runtime module should be installed")?;
        assert!(try_install_embedded_cluster_seed(&paths, &module_path,)?);

        assert!(paths.pgdata.join("PG_VERSION").exists());
        assert!(paths.pgdata.join("global/pg_control").exists());
        assert!(!paths.pgdata.join("postmaster.pid").exists());
        Ok(())
    }

    #[cfg(feature = "extensions")]
    #[test]
    fn embedded_cluster_seed_replaces_interrupted_pgdata() -> Result<()> {
        if !embedded_cluster_seed_is_available() {
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
        assert!(try_install_embedded_cluster_seed(&paths, &module_path,)?);

        assert!(paths.pgdata.join("PG_VERSION").exists());
        assert!(paths.pgdata.join("global/pg_control").exists());
        assert!(!paths.pgdata.join("postmaster.pid").exists());
        assert!(!paths.pgdata.join("base.tmp").exists());
        Ok(())
    }

    #[cfg(feature = "extensions")]
    fn embedded_cluster_seed_is_available() -> bool {
        assets::cluster_seed_archive().is_some() && assets::cluster_seed_manifest().is_some()
    }

    #[test]
    fn directory_lock_is_exclusive_until_dropped() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let root = temp_dir.path().join("database");
        let first = DirectoryLock::acquire(&root)?;
        assert!(!root.exists());

        let err =
            DirectoryLock::acquire(&root).expect_err("second directory lock should be rejected");
        assert!(format!("{err:#}").contains("database root is already in use"));

        drop(first);
        let second = DirectoryLock::acquire(&root)?;
        drop(second);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn directory_lock_rejects_a_symlinked_root() -> Result<()> {
        use std::os::unix::fs::symlink;

        let parent = TempDir::new()?;
        let target = parent.path().join("target");
        let link = parent.path().join("link");
        fs::create_dir(&target)?;
        symlink(&target, &link)?;

        let error = DirectoryLock::acquire(&link).expect_err("symlinked roots must be rejected");
        assert!(format!("{error:#}").contains("must be a real directory"));
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
