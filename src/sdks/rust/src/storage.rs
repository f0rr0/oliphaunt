use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// Live database root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseRoot {
    /// Persistent root directory.
    Path(PathBuf),
    /// Temporary root owned by the SDK.
    Temporary,
}

/// Bootstrap policy for a new database root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapStrategy {
    /// Copy a packaged PostgreSQL template cluster into the root.
    PackagedTemplate,
    /// Open an existing root and fail if it has not been bootstrapped.
    ExistingOnly,
    /// Tooling-only fallback. Production mobile paths must not require this.
    InitdbToolingOnly {
        /// Path to the initdb executable.
        initdb: PathBuf,
    },
}

/// Root locking policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RootLockPolicy {
    /// One process owns the root directly.
    ExclusiveProcess,
    /// A broker process owns the root.
    BrokerOwned,
}

/// Storage configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageConfig {
    /// Database root.
    pub root: DatabaseRoot,
    /// Bootstrap strategy.
    pub bootstrap: BootstrapStrategy,
    /// Locking policy.
    pub lock_policy: RootLockPolicy,
}

/// Backup format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackupFormat {
    /// Portable logical SQL dump.
    Sql,
    /// Physical archive of the root directory.
    PhysicalArchive,
    /// Product-level portable archive.
    OliphauntArchive,
}

/// Backup request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupRequest {
    /// Requested format.
    pub format: BackupFormat,
}

impl BackupRequest {
    /// Request a portable logical SQL backup.
    pub fn sql() -> Self {
        Self {
            format: BackupFormat::Sql,
        }
    }

    /// Request a same-version physical archive of the database root.
    pub fn physical_archive() -> Self {
        Self {
            format: BackupFormat::PhysicalArchive,
        }
    }
}

/// Backup bytes returned by an engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupArtifact {
    /// Format of the bytes.
    pub format: BackupFormat,
    /// Backup payload.
    pub bytes: Vec<u8>,
}

/// Policy for an existing restore target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RestoreTargetPolicy {
    /// Fail if the target root already contains files.
    FailIfExists,
    /// Atomically replace the existing root after taking its root lock.
    ReplaceExisting,
}

/// Restore/import request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreRequest {
    /// Backup artifact to restore.
    pub artifact: BackupArtifact,
    /// Target database root.
    pub target: DatabaseRoot,
    /// Existing-target behavior.
    pub target_policy: RestoreTargetPolicy,
}

impl RestoreRequest {
    /// Restore a same-version physical archive into a persistent root.
    pub fn physical_archive(root: impl Into<PathBuf>, artifact: BackupArtifact) -> Self {
        Self {
            artifact,
            target: DatabaseRoot::Path(root.into()),
            target_policy: RestoreTargetPolicy::FailIfExists,
        }
    }

    /// Set the target policy.
    pub fn with_target_policy(mut self, target_policy: RestoreTargetPolicy) -> Self {
        self.target_policy = target_policy;
        self
    }

    /// Replace an existing root. The existing root must not be open by another
    /// process.
    pub fn replace_existing(self) -> Self {
        self.with_target_policy(RestoreTargetPolicy::ReplaceExisting)
    }
}

pub(crate) fn path_contains_nul(path: &Path) -> bool {
    #[cfg(unix)]
    {
        path.as_os_str().as_bytes().contains(&0)
    }
    #[cfg(windows)]
    {
        path.as_os_str().encode_wide().any(|unit| unit == 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.to_string_lossy().bytes().any(|byte| byte == 0)
    }
}
