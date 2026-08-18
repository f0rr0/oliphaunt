use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// Storage used by a native database instance.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DatabaseStorage {
    /// SDK-owned temporary directory.
    #[default]
    TemporaryDirectory,
    /// Caller-owned persistent directory.
    Directory(PathBuf),
}

/// How an empty database storage directory is initialized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseInitialization {
    /// Copy a packaged PostgreSQL template cluster into the storage directory.
    PackagedTemplate,
    /// Initialize empty storage with the packaged `initdb` executable.
    FreshInitdb,
    /// Open an existing directory and fail if it has not been initialized.
    ExistingOnly,
}

/// Backup format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackupFormat {
    /// Portable logical SQL dump.
    Sql,
    /// Physical archive of the database storage directory.
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

    /// Request a same-version physical archive of the database storage directory.
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

/// Policy for an existing restore destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RestoreDestinationPolicy {
    /// Fail if the destination path already exists.
    FailIfExists,
    /// Atomically replace the existing destination after taking its lock.
    ReplaceExisting,
}

/// Restore/import request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreRequest {
    /// Backup artifact to restore.
    pub artifact: BackupArtifact,
    /// Filesystem directory that will receive the restored database.
    pub destination: PathBuf,
    /// Existing-destination behavior.
    pub destination_policy: RestoreDestinationPolicy,
}

impl RestoreRequest {
    /// Restore a same-version physical archive into a persistent directory.
    pub fn physical_archive(destination: impl Into<PathBuf>, artifact: BackupArtifact) -> Self {
        Self {
            artifact,
            destination: destination.into(),
            destination_policy: RestoreDestinationPolicy::FailIfExists,
        }
    }

    /// Set the destination policy.
    pub fn with_destination_policy(mut self, destination_policy: RestoreDestinationPolicy) -> Self {
        self.destination_policy = destination_policy;
        self
    }

    /// Replace an existing destination. The database must not be open by
    /// another process.
    pub fn replace_existing(self) -> Self {
        self.with_destination_policy(RestoreDestinationPolicy::ReplaceExisting)
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
