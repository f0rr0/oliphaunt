mod extensions;
mod files;
mod fingerprint;
mod manifest;
mod runtime;
mod template;

use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use sha2::{Digest, Sha256};

use crate::config::{EngineMode, OpenConfig};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::storage::DatabaseRoot;

static ACTIVE_ROOTS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();
pub(super) const NATIVE_RUNTIME_TOOLS: [&str; 5] =
    ["postgres", "initdb", "pg_ctl", "pg_dump", "psql"];

pub(crate) struct MaterializedNativeResources {
    pub(crate) runtime_dir: PathBuf,
    pub(crate) template_pgdata: PathBuf,
    pub(crate) runtime_cache_key: String,
    pub(crate) template_cache_key: String,
}

pub(crate) use self::manifest::{
    ROOT_MANIFEST_FILE, ensure_root_manifest, root_manifest_text, validate_root_manifest_text,
};

pub(crate) struct PreparedNativeRoot {
    pub(crate) root: PathBuf,
    pub(crate) pgdata: PathBuf,
    pub(crate) runtime_dir: PathBuf,
    lock: Option<NativeRootLock>,
    temporary: bool,
}

impl PreparedNativeRoot {
    pub(crate) fn prepare(config: &OpenConfig, extensions: &[Extension]) -> Result<Self> {
        let (root, temporary) = match &config.storage.root {
            DatabaseRoot::Path(root) => (root.clone(), false),
            DatabaseRoot::Temporary => (create_temporary_root()?, true),
        };
        fs::create_dir_all(&root).map_err(|err| {
            Error::Engine(format!(
                "create native database root {}: {err}",
                root.display()
            ))
        })?;
        let lock = NativeRootLock::acquire(&root, "native root")?;

        let pgdata = root.join("pgdata");
        fs::create_dir_all(&pgdata).map_err(|err| {
            Error::Engine(format!("create native PGDATA {}: {err}", pgdata.display()))
        })?;
        let runtime_dir =
            runtime::materialize_runtime(NativeRuntimeProfile::for_mode(config.mode), extensions)?;
        template::bootstrap_pgdata_if_needed(
            NativeRuntimeProfile::for_mode(config.mode),
            &pgdata,
            &config.storage.bootstrap,
        )?;
        ensure_root_manifest(&root, &pgdata)?;

        Ok(Self {
            root,
            pgdata,
            runtime_dir,
            lock: Some(lock),
            temporary,
        })
    }

    pub(crate) fn tool_path(&self, tool_name: &str) -> PathBuf {
        native_tool_path(&self.runtime_dir, tool_name)
    }

    pub(crate) fn refresh_manifest(&self) -> Result<()> {
        ensure_root_manifest(&self.root, &self.pgdata)
    }

    pub(crate) fn root_key(&self) -> Result<PathBuf> {
        native_root_key(&self.root)
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
    root_file: Option<File>,
}

impl NativeRootLock {
    pub(crate) fn acquire(root: &Path, label: &str) -> Result<Self> {
        Self::acquire_inner(root, label, true)
    }

    pub(crate) fn reserve_path(root: &Path, label: &str) -> Result<Self> {
        Self::acquire_inner(root, label, false)
    }

    fn acquire_inner(root: &Path, label: &str, lock_root_marker: bool) -> Result<Self> {
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

        let root_file = if lock_root_marker {
            let root_lock_path = root.join(".oliphaunt.lock");
            match lock_file(&root_lock_path) {
                Ok(file) => Some(file),
                Err(err) => {
                    drop(stable_file);
                    release_active_root(&key);
                    return Err(Error::Engine(format!(
                        "lock {label} {}: {err}",
                        root.display()
                    )));
                }
            }
        } else {
            None
        };

        Ok(Self {
            key,
            stable_file,
            root_file,
        })
    }
}

impl Drop for NativeRootLock {
    fn drop(&mut self) {
        if let Some(root_file) = &self.root_file {
            let _ = root_file.unlock();
        }
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
    let parent = stable_root_lock_dir(key).ok_or_else(|| {
        Error::Engine(format!(
            "native root {} has no parent directory for stable lock",
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

fn stable_root_lock_dir(key: &Path) -> Option<PathBuf> {
    let mut cursor = key.parent()?;
    loop {
        if cursor.is_dir() {
            return Some(cursor.to_path_buf());
        }
        cursor = cursor.parent()?;
    }
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
    path.to_string_lossy().as_bytes().to_vec()
}

fn release_active_root(key: &Path) {
    if let Some(roots) = ACTIVE_ROOTS.get()
        && let Ok(mut active) = roots.lock()
    {
        active.remove(key);
    }
}

pub(crate) fn materialize_native_resources_for_runtime(
    mode: EngineMode,
    extensions: &[Extension],
) -> Result<MaterializedNativeResources> {
    let profile = NativeRuntimeProfile::for_mode(mode);
    let runtime_dir = runtime::materialize_runtime(profile, extensions)?;
    let template_pgdata = template::materialize_pgdata_template(profile)?;
    let runtime_cache_key = cache_key_from_leaf(&runtime_dir, "native runtime cache")?;
    let template_cache_key = template_pgdata
        .parent()
        .ok_or_else(|| {
            Error::Engine(format!(
                "native PGDATA template path {} has no cache-key parent",
                template_pgdata.display()
            ))
        })
        .and_then(|parent| cache_key_from_leaf(parent, "native PGDATA template cache"))?;

    Ok(MaterializedNativeResources {
        runtime_dir,
        template_pgdata,
        runtime_cache_key,
        template_cache_key,
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
            EngineMode::NativeDirect | EngineMode::NativeBroker => Self::OliphauntEmbedded,
            EngineMode::NativeServer => Self::PostgresServer,
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
    use super::*;

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
    fn native_root_lock_reserves_missing_target_paths() {
        let parent = create_temporary_root().unwrap();
        let root = parent.join("missing-target");
        let first = NativeRootLock::reserve_path(&root, "restore target").unwrap();
        assert!(
            !root.exists(),
            "path reservation must not materialize the restore target"
        );

        let duplicate = NativeRootLock::reserve_path(&root, "restore target").unwrap_err();
        assert!(
            duplicate
                .to_string()
                .contains("already open in this process"),
            "unexpected duplicate reservation error: {duplicate}"
        );

        fs::create_dir_all(&root).unwrap();
        let open_error = NativeRootLock::acquire(&root, "native root").unwrap_err();
        assert!(
            open_error
                .to_string()
                .contains("already open in this process"),
            "missing-target reservation did not block later root open: {open_error}"
        );

        drop(first);
        NativeRootLock::acquire(&root, "native root").unwrap();
        let _ = fs::remove_dir_all(parent);
    }
}
