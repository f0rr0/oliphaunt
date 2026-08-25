mod cluster_seed;
mod descriptor;
mod extensions;
mod files;
mod fingerprint;
mod runtime;

use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use sha2::{Digest, Sha256};

use crate::config::{DEFAULT_USERNAME, EngineMode, OpenConfig};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::storage::DatabaseStorage;
use files::{sync_directory, sync_directory_tree};

static ACTIVE_ROOTS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();
pub(super) const NATIVE_RUNTIME_TOOLS: [&str; 3] = ["postgres", "initdb", "pg_ctl"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeCatalogProfile {
    Standard,
    Icu,
}

impl NativeCatalogProfile {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Icu => "icu",
        }
    }
}

#[cfg(feature = "internal-native-packaging")]
pub(crate) struct MaterializedNativeResources {
    pub(crate) runtime_dir: PathBuf,
    pub(crate) cluster_seed: PathBuf,
    pub(crate) runtime_cache_key: String,
    pub(crate) cluster_seed_cache_key: String,
}

pub(crate) struct PreparedNativeRoot {
    pub(crate) root: PathBuf,
    pub(crate) pgdata: PathBuf,
    pub(crate) runtime_dir: PathBuf,
    lock: Option<NativeRootLock>,
    temporary: bool,
}

impl PreparedNativeRoot {
    pub(crate) fn prepare(config: &OpenConfig, extensions: &[Extension]) -> Result<Self> {
        Self::prepare_inner(config, extensions, true)
    }

    pub(crate) fn prepare_for_server(
        config: &OpenConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        Self::prepare_inner(config, extensions, true)
    }

    fn prepare_inner(
        config: &OpenConfig,
        extensions: &[Extension],
        lock_root: bool,
    ) -> Result<Self> {
        let (root, temporary) = match &config.storage {
            DatabaseStorage::Directory(root) => (root.clone(), false),
            DatabaseStorage::TemporaryDirectory => (create_temporary_root()?, true),
        };
        let mut temporary_cleanup =
            TemporaryNativeRootCleanup::new(temporary.then(|| root.clone()));
        let lock = lock_root
            .then(|| NativeRootLock::acquire(&root, "native root"))
            .transpose()?;
        if root.exists() || fs::symlink_metadata(&root).is_ok() {
            let metadata = fs::symlink_metadata(&root).map_err(|err| {
                Error::Engine(format!(
                    "inspect native database root {}: {err}",
                    root.display()
                ))
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(Error::Engine(format!(
                    "native database root {} must be a real directory",
                    root.display()
                )));
            }
        }
        fs::create_dir_all(&root).map_err(|err| {
            Error::Engine(format!(
                "create native database root {}: {err}",
                root.display()
            ))
        })?;
        let initialized = descriptor::validate_root_for_open(&root)?;
        if !initialized && config.username != DEFAULT_USERNAME {
            return Err(Error::InvalidConfig(format!(
                "new native database storage is bootstrapped as {DEFAULT_USERNAME}; create role {:?} before selecting it as username",
                config.username
            )));
        }
        let pgdata = root.join("pgdata");
        let runtime_closure = runtime::resolve_runtime_closure(
            NativeRuntimeProfile::for_mode(config.mode),
            extensions,
            None,
        )?;
        let runtime_dir = runtime_closure.runtime_dir;
        let mut pgdata_cleanup = CreatedPgdataCleanup::new();
        if !initialized {
            let initialization = (|| -> Result<()> {
                let staging_pgdata = root.join(format!(
                    ".pgdata.tmp-{}-{}",
                    std::process::id(),
                    temporary_file_nonce()?
                ));
                fs::create_dir(&staging_pgdata).map_err(|err| {
                    Error::Engine(format!(
                        "create staged native PGDATA {}: {err}",
                        staging_pgdata.display()
                    ))
                })?;
                pgdata_cleanup.arm(staging_pgdata.clone());
                cluster_seed::bootstrap_pgdata_if_needed(
                    NativeRuntimeProfile::for_mode(config.mode),
                    &runtime_dir,
                    &runtime_closure.initdb_runtime_dir,
                    runtime_closure.catalog_profile,
                    runtime_closure.cluster_seed_dir.as_deref(),
                    &staging_pgdata,
                )?;
                sync_directory_tree(&staging_pgdata)?;
                fs::rename(&staging_pgdata, &pgdata).map_err(|err| {
                    Error::Engine(format!(
                        "publish native PGDATA {} -> {}: {err}",
                        staging_pgdata.display(),
                        pgdata.display()
                    ))
                })?;
                pgdata_cleanup.arm(pgdata.clone());
                sync_directory(&root)?;
                descriptor::publish_native_root_descriptor(&root)
            })();
            if let Err(error) = initialization {
                return Err(recover_failed_native_root_initialization(
                    &root,
                    &mut pgdata_cleanup,
                    error,
                ));
            }
        }

        let prepared = Self {
            root,
            pgdata,
            runtime_dir,
            lock,
            temporary,
        };
        temporary_cleanup.disarm();
        pgdata_cleanup.disarm();
        Ok(prepared)
    }

    pub(crate) fn tool_path(&self, tool_name: &str) -> PathBuf {
        native_tool_path(&self.runtime_dir, tool_name)
    }

    pub(crate) fn refresh_descriptor(&self) -> Result<()> {
        descriptor::validate_existing_root(&self.root)
    }

    pub(crate) fn root_key(&self) -> Result<PathBuf> {
        native_root_key(&self.root)
    }
}

struct CreatedPgdataCleanup {
    path: Option<PathBuf>,
}

impl CreatedPgdataCleanup {
    fn new() -> Self {
        Self { path: None }
    }

    fn arm(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    fn disarm(&mut self) {
        self.path = None;
    }

    fn cleanup(&mut self, root: &Path, primary: Error) -> Error {
        let Some(path) = self.path.take() else {
            return primary;
        };
        let removal = match fs::remove_dir_all(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(Error::Engine(format!(
                "remove native initialization path {}: {error}",
                path.display()
            ))),
        };
        let cleanup = removal.and_then(|()| sync_directory(root));
        match cleanup {
            Ok(()) => primary,
            Err(cleanup) => Error::Engine(format!(
                "{primary}; additionally failed to clean unpublished native initialization: {cleanup}"
            )),
        }
    }
}

impl Drop for CreatedPgdataCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn recover_failed_native_root_initialization(
    root: &Path,
    cleanup: &mut CreatedPgdataCleanup,
    error: Error,
) -> Error {
    // The descriptor rename is the publication commit point. A following
    // directory-fsync failure must not turn a complete managed root into a
    // descriptor that names deleted PGDATA.
    match fs::symlink_metadata(root.join(descriptor::ROOT_DESCRIPTOR_FILE)) {
        Ok(_) => {
            cleanup.disarm();
            error
        }
        Err(inspect) if inspect.kind() == std::io::ErrorKind::NotFound => {
            cleanup.cleanup(root, error)
        }
        Err(inspect) => {
            cleanup.disarm();
            Error::Engine(format!(
                "{error}; preserved PGDATA because root descriptor publication is uncertain: {inspect}"
            ))
        }
    }
}

struct TemporaryNativeRootCleanup {
    path: Option<PathBuf>,
}

impl TemporaryNativeRootCleanup {
    fn new(path: Option<PathBuf>) -> Self {
        Self { path }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TemporaryNativeRootCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(super) fn native_tool_path(root: &Path, tool_name: &str) -> PathBuf {
    root.join("bin")
        .join(format!("{tool_name}{}", std::env::consts::EXE_SUFFIX))
}

pub(super) fn existing_native_tool_path(root: &Path, tool_name: &str) -> PathBuf {
    let suffixed = native_tool_path(root, tool_name);
    if suffixed.is_file() {
        return suffixed;
    }
    root.join("bin").join(tool_name)
}

pub(crate) fn configure_native_tool_env(command: &mut Command, runtime_dir: &Path) {
    for key in [
        "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
        "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
        "OLIPHAUNT_INTERNAL_ICU_READY",
    ] {
        command.env_remove(key);
    }
    let dirs = native_dynamic_library_dirs(runtime_dir);
    if dirs.is_empty() {
        return;
    }
    let Some(joined) = prepend_env_paths(native_dynamic_library_env_name(), dirs) else {
        return;
    };
    command.env(native_dynamic_library_env_name(), joined);
}

fn native_dynamic_library_env_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "DYLD_LIBRARY_PATH"
    } else if cfg!(target_os = "windows") {
        "PATH"
    } else {
        "LD_LIBRARY_PATH"
    }
}

fn native_dynamic_library_dirs(runtime_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        let bin_dir = runtime_dir.join("bin");
        if bin_dir.is_dir() {
            dirs.push(bin_dir);
        }
    }
    let lib_dir = runtime_dir.join("lib");
    if lib_dir.is_dir() {
        dirs.push(lib_dir);
    }
    dirs
}

fn prepend_env_paths(name: &str, mut dirs: Vec<PathBuf>) -> Option<OsString> {
    if let Some(existing) = env::var_os(name) {
        dirs.extend(env::split_paths(&existing));
    }
    env::join_paths(dirs).ok()
}

impl Drop for PreparedNativeRoot {
    fn drop(&mut self) {
        drop(self.lock.take());
        if self.temporary {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[derive(Debug)]
pub(crate) struct NativeRootLock {
    key: PathBuf,
    stable_file: File,
}

impl NativeRootLock {
    pub(crate) fn acquire(root: &Path, label: &str) -> Result<Self> {
        let absolute = if root.is_absolute() {
            root.to_path_buf()
        } else {
            env::current_dir()
                .map_err(|err| {
                    Error::Engine(format!("resolve native root current directory: {err}"))
                })?
                .join(root)
        };
        let parent = absolute.parent().ok_or_else(|| {
            Error::Engine(format!(
                "native root {} has no parent directory for stable lock",
                root.display()
            ))
        })?;
        fs::create_dir_all(parent).map_err(|err| {
            Error::Engine(format!(
                "create native root parent {} for stable lock: {err}",
                parent.display()
            ))
        })?;
        let key = canonical_root_key(root)?;
        let roots = ACTIVE_ROOTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
        {
            let mut active = roots
                .lock()
                .map_err(|_| Error::Engine("native root lock registry was poisoned".to_owned()))?;
            if !active.insert(key.clone()) {
                return Err(Error::Engine(format!(
                    "{label} {} is already open in this process",
                    key.display()
                )));
            }
        }

        let stable_lock_path = stable_root_lock_path(&key)?;
        let stable_file = match lock_file(&stable_lock_path) {
            Ok(file) => file,
            Err(err) => {
                release_active_root(&key);
                return Err(Error::Engine(format!(
                    "lock {label} {}: {err}",
                    root.display()
                )));
            }
        };

        Ok(Self { key, stable_file })
    }
}

impl Drop for NativeRootLock {
    fn drop(&mut self) {
        let _ = self.stable_file.unlock();
        release_active_root(&self.key);
    }
}

fn lock_file(path: &Path) -> std::io::Result<File> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(path)?;
    lock.try_lock_exclusive()?;
    Ok(lock)
}

fn stable_root_lock_path(key: &Path) -> Result<PathBuf> {
    let parent = key
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| {
            Error::Engine(format!(
                "native root {} has no immediate parent directory for stable lock",
                key.display()
            ))
        })?;
    let digest = Sha256::digest(path_identity_bytes(key));
    let mut suffix = String::with_capacity(32);
    for byte in &digest[..16] {
        write!(&mut suffix, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(parent.join(format!(".oliphaunt-root-{suffix}.lock")))
}

fn canonical_root_key(root: &Path) -> Result<PathBuf> {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|err| Error::Engine(format!("resolve native root current directory: {err}")))?
            .join(root)
    };
    if let Ok(canonical) = absolute.canonicalize() {
        return Ok(canonical);
    }

    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    while let Some(name) = cursor.file_name() {
        missing.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        if let Ok(canonical_parent) = parent.canonicalize() {
            let mut key = canonical_parent;
            for component in missing.iter().rev() {
                key.push(component);
            }
            return Ok(normalize_path(&key));
        }
        cursor = parent;
    }

    Ok(normalize_path(&absolute))
}

pub(crate) fn native_root_key(root: &Path) -> Result<PathBuf> {
    canonical_root_key(root)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

#[cfg(unix)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    let mut identity = path.to_string_lossy().replace('/', "\\");
    if let Some(suffix) = identity.strip_prefix("\\\\?\\UNC\\") {
        identity = format!("\\\\{suffix}");
    } else if let Some(suffix) = identity.strip_prefix("\\\\?\\") {
        identity = suffix.to_owned();
    }
    identity.make_ascii_lowercase();
    identity.into_bytes()
}

fn release_active_root(key: &Path) {
    if let Some(roots) = ACTIVE_ROOTS.get()
        && let Ok(mut active) = roots.lock()
    {
        active.remove(key);
    }
}

#[cfg(feature = "internal-native-packaging")]
pub(crate) fn materialize_native_resources_for_runtime(
    mode: EngineMode,
    extensions: &[Extension],
    catalog_profile: NativeCatalogProfile,
) -> Result<MaterializedNativeResources> {
    let profile = NativeRuntimeProfile::for_mode(mode);
    let runtime_closure =
        runtime::resolve_runtime_closure(profile, extensions, Some(catalog_profile))?;
    let runtime_dir = runtime_closure.runtime_dir;
    let cluster_seed = cluster_seed::materialize_cluster_seed(
        profile,
        &runtime_dir,
        &runtime_closure.initdb_runtime_dir,
        runtime_closure.catalog_profile,
    )?;
    let runtime_cache_key = cache_key_from_leaf(&runtime_dir, "native runtime cache")?;
    let cluster_seed_cache_key = cluster_seed
        .parent()
        .ok_or_else(|| {
            Error::Engine(format!(
                "native cluster-seed path {} has no cache-key parent",
                cluster_seed.display()
            ))
        })
        .and_then(|parent| cache_key_from_leaf(parent, "native PGDATA cluster seed cache"))?;

    Ok(MaterializedNativeResources {
        runtime_dir,
        cluster_seed,
        runtime_cache_key,
        cluster_seed_cache_key,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeRuntimeProfile {
    OliphauntEmbedded,
    PostgresServer,
}

impl NativeRuntimeProfile {
    fn for_mode(mode: EngineMode) -> Self {
        match mode {
            EngineMode::Direct | EngineMode::Broker => Self::OliphauntEmbedded,
            EngineMode::Server => Self::PostgresServer,
        }
    }

    pub(super) const fn cache_id(self) -> &'static str {
        match self {
            Self::OliphauntEmbedded => "liboliphaunt-embedded",
            Self::PostgresServer => "postgres-server",
        }
    }

    pub(super) const fn needs_embedded_modules(self) -> bool {
        matches!(self, Self::OliphauntEmbedded)
    }
}

#[cfg(feature = "internal-native-packaging")]
fn cache_key_from_leaf(path: &std::path::Path, label: &str) -> Result<String> {
    let key = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            Error::Engine(format!(
                "{label} path {} does not end in a UTF-8 cache key",
                path.display()
            ))
        })?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(Error::Engine(format!(
            "{label} path {} has invalid cache key '{key}'",
            path.display()
        )));
    }
    Ok(key.to_owned())
}

fn create_temporary_root() -> Result<PathBuf> {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = temporary_file_nonce()?;
    for attempt in 0..100_u32 {
        let path = parent.join(format!("oliphaunt-{pid}-{nanos}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(Error::Engine(format!(
                    "create temporary native root {}: {err}",
                    path.display()
                )));
            }
        }
    }
    Err(Error::Engine(
        "failed to allocate a unique temporary native root".to_owned(),
    ))
}

fn temporary_file_nonce() -> Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::io::{BufRead, BufReader, Write as _};
    use std::process::{Command, Stdio};

    use super::*;
    use crate::liboliphaunt::ffi::{
        ABI_VERSION, NativeConfig, NativeHandle, NativeSymbols, path_to_cstring,
    };

    #[test]
    fn native_tool_environment_drops_producer_only_collation_signals() {
        let mut command = Command::new("postgres");
        for key in [
            "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
            "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
            "OLIPHAUNT_INTERNAL_ICU_READY",
        ] {
            command.env(key, "1");
        }
        configure_native_tool_env(&mut command, Path::new("/missing-runtime"));
        for key in [
            "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
            "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
            "OLIPHAUNT_INTERNAL_ICU_READY",
        ] {
            assert_eq!(
                command
                    .get_envs()
                    .find(|(candidate, _)| *candidate == OsStr::new(key))
                    .and_then(|(_, value)| value),
                None
            );
        }
    }

    #[test]
    fn temporary_root_cleanup_removes_unclaimed_directories() {
        let root = create_temporary_root().unwrap();
        {
            let _cleanup = TemporaryNativeRootCleanup::new(Some(root.clone()));
            assert!(root.is_dir());
        }
        assert!(!root.exists());
    }

    #[test]
    fn failed_native_publication_keeps_pgdata_after_descriptor_commit() {
        let root = create_temporary_root().unwrap();
        let pgdata = root.join("pgdata");
        fs::create_dir_all(pgdata.join("global")).unwrap();
        fs::create_dir(pgdata.join("pg_wal")).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();
        fs::write(pgdata.join("global/pg_control"), b"control").unwrap();
        descriptor::publish_native_root_descriptor(&root).unwrap();

        let mut cleanup = CreatedPgdataCleanup::new();
        cleanup.arm(pgdata.clone());
        let error = recover_failed_native_root_initialization(
            &root,
            &mut cleanup,
            Error::Engine("root fsync failed".to_owned()),
        );

        assert_eq!(error.to_string(), "root fsync failed");
        assert!(pgdata.is_dir());
        assert!(root.join(".oliphaunt.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_native_publication_does_not_validate_away_a_renamed_descriptor() {
        let root = create_temporary_root().unwrap();
        let pgdata = root.join("pgdata");
        fs::create_dir(&pgdata).unwrap();
        fs::write(
            root.join(descriptor::ROOT_DESCRIPTOR_FILE),
            b"publication marker",
        )
        .unwrap();

        let mut cleanup = CreatedPgdataCleanup::new();
        cleanup.arm(pgdata.clone());
        recover_failed_native_root_initialization(
            &root,
            &mut cleanup,
            Error::Engine("directory sync failed".to_owned()),
        );

        assert!(pgdata.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_native_publication_removes_uncommitted_pgdata() {
        let root = create_temporary_root().unwrap();
        let pgdata = root.join("pgdata");
        fs::create_dir(&pgdata).unwrap();
        fs::write(pgdata.join("partial"), b"partial").unwrap();

        let mut cleanup = CreatedPgdataCleanup::new();
        cleanup.arm(pgdata.clone());
        let error = recover_failed_native_root_initialization(
            &root,
            &mut cleanup,
            Error::Engine("descriptor publication failed".to_owned()),
        );

        assert_eq!(error.to_string(), "descriptor publication failed");
        assert!(!pgdata.exists());
        assert!(root.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn native_pgdata_publication_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = create_temporary_root().unwrap();
        let pgdata = root.join("pgdata");
        fs::create_dir(&pgdata).unwrap();
        fs::write(pgdata.join("target"), b"target").unwrap();
        symlink("target", pgdata.join("link")).unwrap();

        let error = sync_directory_tree(&pgdata).unwrap_err();

        assert!(error.to_string().contains("symbolic link"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fresh_native_root_rejects_non_bootstrap_role_before_pgdata_mutation() {
        let root = create_temporary_root().unwrap();
        let mut config = OpenConfig::direct(&root);
        config.username = "app_user".to_owned();

        let error = match PreparedNativeRoot::prepare(&config, &[]) {
            Ok(_) => panic!("a fresh root cannot bootstrap an arbitrary connection role"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("bootstrapped as postgres"));
        assert!(!root.join("pgdata").exists());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_root_lock_rejects_same_process_duplicate_and_reopens() {
        let root = create_temporary_root().unwrap();
        let first = NativeRootLock::acquire(&root, "native root").unwrap();
        let duplicate = NativeRootLock::acquire(&root, "native root").unwrap_err();
        assert!(
            duplicate
                .to_string()
                .contains("already open in this process"),
            "unexpected duplicate lock error: {duplicate}"
        );

        drop(first);
        NativeRootLock::acquire(&root, "native root").unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_root_lock_uses_a_stable_sibling_without_mutating_the_root() {
        let parent = create_temporary_root().unwrap();
        let root = parent.join("database");
        fs::create_dir(&root).unwrap();
        let first = NativeRootLock::acquire(&root, "native root").unwrap();
        assert!(!root.join(".oliphaunt.lock").exists());
        let duplicate = NativeRootLock::acquire(&root, "native root").unwrap_err();
        assert!(
            duplicate
                .to_string()
                .contains("already open in this process"),
            "unexpected duplicate lock error: {duplicate}"
        );
        drop(first);
        NativeRootLock::acquire(&root, "native root").unwrap();
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn native_root_lock_creates_the_immediate_parent_for_a_missing_destination() {
        let parent = create_temporary_root().unwrap();
        let root = parent.join("nested/database");
        let lock = NativeRootLock::acquire(&root, "native root").unwrap();
        assert!(root.parent().unwrap().is_dir());
        assert!(!root.exists());
        drop(lock);
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(unix)]
    #[test]
    fn native_root_lock_identity_resolves_symlinked_parent_and_unicode_leaf() {
        use std::os::unix::fs::symlink;

        let parent = create_temporary_root().unwrap();
        let real_parent = parent.join("real");
        let linked_parent = parent.join("linked");
        fs::create_dir(&real_parent).unwrap();
        symlink(&real_parent, &linked_parent).unwrap();
        let real = canonical_root_key(&real_parent.join("dátabase")).unwrap();
        let linked = canonical_root_key(&linked_parent.join("dátabase")).unwrap();
        assert_eq!(real, linked);
        assert_eq!(
            stable_root_lock_path(&real).unwrap(),
            stable_root_lock_path(&linked).unwrap()
        );
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn native_c_and_rust_root_locks_are_reciprocal_when_available() {
        if env::var_os("LIBOLIPHAUNT_PATH").is_none() {
            return;
        }
        let root = create_temporary_root().unwrap();
        let config = OpenConfig::direct(&root);
        let mut prepared = PreparedNativeRoot::prepare(&config, &[]).unwrap();
        let rust_lock = prepared
            .lock
            .take()
            .expect("Rust preparation owns the root lock");

        let busy = run_native_c_lock_probe("expect-busy", &prepared);
        assert!(busy.status.success(), "C lock probe failed: {busy:?}");

        drop(rust_lock);
        let mut owner = spawn_native_c_lock_probe("hold", &prepared);
        let stdout = owner.stdout.take().expect("capture C lock probe stdout");
        let mut lines = BufReader::new(stdout).lines();
        let mut ready = false;
        for line in lines.by_ref() {
            if line.unwrap().contains("OLIPHAUNT_C_LOCK_READY") {
                ready = true;
                break;
            }
        }
        assert!(ready, "C lock probe exited before acquiring the root lock");
        let error = NativeRootLock::acquire(&root, "native root")
            .expect_err("Rust lock must observe the C-owned lease");
        assert!(error.to_string().contains("lock native root"), "{error}");
        owner
            .stdin
            .as_mut()
            .expect("capture C lock probe stdin")
            .write_all(b"release\n")
            .unwrap();
        assert!(owner.wait().unwrap().success());

        NativeRootLock::acquire(&root, "native root")
            .expect("Rust lock must reopen after the C owner exits");
        drop(prepared);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_c_root_lock_probe_child() {
        let Ok(mode) = env::var("OLIPHAUNT_NATIVE_LOCK_PROBE_MODE") else {
            return;
        };
        let root = PathBuf::from(env::var_os("OLIPHAUNT_NATIVE_LOCK_PROBE_ROOT").unwrap());
        let runtime_dir =
            PathBuf::from(env::var_os("OLIPHAUNT_NATIVE_LOCK_PROBE_RUNTIME").unwrap());
        let pgdata = path_to_cstring(&root.join("pgdata"), "probe PGDATA").unwrap();
        let runtime = path_to_cstring(&runtime_dir, "probe runtime").unwrap();
        let module = path_to_cstring(&runtime_dir.join("lib/postgresql"), "probe module").unwrap();
        let username = std::ffi::CString::new("postgres").unwrap();
        let database = std::ffi::CString::new("postgres").unwrap();
        let config = NativeConfig {
            abi_version: ABI_VERSION,
            pgdata: pgdata.as_ptr(),
            runtime_dir: runtime.as_ptr(),
            module_dir: module.as_ptr(),
            username: username.as_ptr(),
            database: database.as_ptr(),
            reserved_flags: 0,
            startup_args: std::ptr::null(),
            startup_arg_count: 0,
        };
        let symbols = NativeSymbols::load().unwrap();
        let mut handle: *mut NativeHandle = std::ptr::null_mut();
        let status = unsafe { (symbols.init)(&config, &mut handle) };
        if mode == "expect-busy" {
            assert_ne!(status, 0, "C unexpectedly acquired the Rust-owned root");
            assert!(handle.is_null());
            let message = symbols.last_error_text(handle).unwrap_or_default();
            assert!(message.contains("already locked"), "{message}");
            return;
        }
        assert_eq!(mode, "hold");
        assert_eq!(
            status,
            0,
            "{}",
            symbols.last_error_text(handle).unwrap_or_default()
        );
        assert!(!handle.is_null());
        println!("OLIPHAUNT_C_LOCK_READY");
        std::io::stdout().flush().unwrap();
        let mut release = String::new();
        std::io::stdin().read_line(&mut release).unwrap();
        assert_eq!(unsafe { (symbols.detach)(handle) }, 0);
    }

    fn spawn_native_c_lock_probe(mode: &str, prepared: &PreparedNativeRoot) -> std::process::Child {
        let test_name = "liboliphaunt::root::tests::native_c_root_lock_probe_child";
        Command::new(env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_MODE", mode)
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_ROOT", &prepared.root)
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_RUNTIME", &prepared.runtime_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    }

    fn run_native_c_lock_probe(mode: &str, prepared: &PreparedNativeRoot) -> std::process::Output {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "liboliphaunt::root::tests::native_c_root_lock_probe_child",
                "--nocapture",
            ])
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_MODE", mode)
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_ROOT", &prepared.root)
            .env("OLIPHAUNT_NATIVE_LOCK_PROBE_RUNTIME", &prepared.runtime_dir);
        command.output().unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_lock_identity_normalizes_prefix_separators_and_ascii_case() {
        let first = path_identity_bytes(Path::new(r"\\?\C:\Data\Oliphaunt"));
        let second = path_identity_bytes(Path::new("c:/data/oliphaunt"));
        assert_eq!(first, second);

        let first_unc = path_identity_bytes(Path::new(r"\\?\UNC\Server\Share\Database"));
        let second_unc = path_identity_bytes(Path::new(r"\\server\share\database"));
        assert_eq!(first_unc, second_unc);
    }
}
