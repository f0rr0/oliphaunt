use std::path::PathBuf;

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
    PgliteArchive,
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
}

/// Backup bytes returned by an engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupArtifact {
    /// Format of the bytes.
    pub format: BackupFormat,
    /// Backup payload.
    pub bytes: Vec<u8>,
}
