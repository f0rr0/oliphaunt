use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::extension::{Extension, resolve_extensions};
use crate::storage::{DatabaseInitialization, DatabaseStorage, path_contains_nul};

/// Default PostgreSQL role used by SDK-managed native sessions.
pub const DEFAULT_USERNAME: &str = "postgres";

/// Default PostgreSQL database used by SDK-managed native sessions.
pub const DEFAULT_DATABASE: &str = "postgres";

/// Native runtime mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineMode {
    /// In-process embedded mode with one physical PostgreSQL backend session.
    NativeDirect,
    /// Helper-process mode for process-isolated desktop operation.
    NativeBroker,
    /// Local PostgreSQL-compatible server mode with true independent sessions.
    NativeServer,
}

impl EngineMode {
    /// All native engine modes in the canonical Rust SDK order.
    pub const ALL: [Self; 3] = [Self::NativeDirect, Self::NativeBroker, Self::NativeServer];

    /// Return every native engine mode in the canonical Rust SDK order.
    pub fn all() -> [Self; 3] {
        Self::ALL
    }
}

impl fmt::Display for EngineMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NativeDirect => f.write_str("native-direct"),
            Self::NativeBroker => f.write_str("native-broker"),
            Self::NativeServer => f.write_str("native-server"),
        }
    }
}

/// Durability profile selected by the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum DurabilityProfile {
    /// PostgreSQL-safe durability defaults.
    #[default]
    Safe,
    /// Lower commit latency while keeping filesystem durability enabled.
    Balanced,
    /// Development/test profile that may lose recent data on crash.
    FastDev,
}

impl DurabilityProfile {
    /// PostgreSQL GUCs implied by this profile.
    pub fn postgres_gucs(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Safe => &[
                ("fsync", "on"),
                ("full_page_writes", "on"),
                ("synchronous_commit", "on"),
            ],
            Self::Balanced => &[
                ("fsync", "on"),
                ("full_page_writes", "on"),
                ("synchronous_commit", "off"),
            ],
            Self::FastDev => &[
                ("fsync", "off"),
                ("full_page_writes", "off"),
                ("synchronous_commit", "off"),
            ],
        }
    }
}

/// PostgreSQL runtime footprint profile selected by the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum RuntimeFootprintProfile {
    /// Throughput-oriented defaults matching the current native runtime lane.
    #[default]
    Throughput,
    /// Mobile-oriented defaults that keep durability reasonable while reducing
    /// shared-memory and WAL footprint for resident embedded use.
    BalancedMobile,
    /// Smallest supported resident footprint for apps that prioritize package
    /// and memory pressure over peak throughput.
    SmallMobile,
}

impl RuntimeFootprintProfile {
    /// PostgreSQL GUCs implied by this profile.
    pub fn postgres_gucs(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Throughput => &[
                ("shared_buffers", "128MB"),
                ("wal_buffers", "4MB"),
                ("min_wal_size", "80MB"),
            ],
            Self::BalancedMobile => &[
                ("max_connections", "1"),
                ("superuser_reserved_connections", "0"),
                ("reserved_connections", "0"),
                ("autovacuum_worker_slots", "1"),
                ("max_wal_senders", "0"),
                ("max_replication_slots", "0"),
                ("shared_buffers", "32MB"),
                ("wal_buffers", "-1"),
                ("min_wal_size", "32MB"),
                ("max_wal_size", "64MB"),
                ("io_method", "sync"),
                ("io_max_concurrency", "1"),
            ],
            Self::SmallMobile => &[
                ("max_connections", "1"),
                ("superuser_reserved_connections", "0"),
                ("reserved_connections", "0"),
                ("autovacuum_worker_slots", "1"),
                ("max_wal_senders", "0"),
                ("max_replication_slots", "0"),
                ("shared_buffers", "8MB"),
                ("wal_buffers", "256kB"),
                ("min_wal_size", "32MB"),
                ("max_wal_size", "64MB"),
                ("work_mem", "1MB"),
                ("maintenance_work_mem", "16MB"),
                ("io_method", "sync"),
                ("io_max_concurrency", "1"),
            ],
        }
    }
}

impl fmt::Display for RuntimeFootprintProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Throughput => f.write_str("throughput"),
            Self::BalancedMobile => f.write_str("balanced-mobile"),
            Self::SmallMobile => f.write_str("small-mobile"),
        }
    }
}

/// Explicit PostgreSQL startup GUC override.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PostgresStartupGuc {
    /// PostgreSQL GUC name, such as `shared_buffers`.
    pub name: String,
    /// PostgreSQL GUC value, such as `32MB`.
    pub value: String,
}

impl PostgresStartupGuc {
    /// Create a startup GUC override. Validation runs when the database is
    /// opened or when `OpenConfig::validate` is called.
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    fn startup_assignment(&self) -> String {
        format!("{}={}", self.name.trim(), self.value)
    }
}

/// Direct-mode configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDirectConfig {
    /// Maximum logical client sessions allowed through this handle.
    pub max_client_sessions: usize,
}

impl Default for NativeDirectConfig {
    fn default() -> Self {
        Self {
            max_client_sessions: 1,
        }
    }
}

/// Broker-mode configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeBrokerConfig {
    /// Optional broker executable path. None means resolve from package assets.
    pub executable: Option<PathBuf>,
    /// Maximum logical client sessions allowed through each broker-owned instance.
    ///
    /// Broker mode may supervise multiple instances, but each instance still has one
    /// physical PostgreSQL backend session. Values other than `1` are rejected
    /// before the helper process is started.
    pub max_client_sessions: usize,
    /// Maximum database instances this broker may own for the application.
    ///
    /// The Rust SDK broker supervisor admits up to this many active instances and
    /// starts one isolated helper process per instance. A single helper still owns
    /// one physical PostgreSQL backend session.
    pub max_instances: usize,
}

impl Default for NativeBrokerConfig {
    fn default() -> Self {
        Self {
            executable: None,
            max_client_sessions: 1,
            max_instances: 1,
        }
    }
}

/// Server-mode configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeServerConfig {
    /// Optional PostgreSQL server executable. None means use the packaged
    /// runtime tree selected for the database instance.
    pub executable: Option<PathBuf>,
    /// Maximum independent PostgreSQL client sessions.
    pub max_client_sessions: usize,
    /// Optional fixed localhost port. None means allocate an ephemeral port.
    pub port: Option<u16>,
}

impl Default for NativeServerConfig {
    fn default() -> Self {
        Self {
            executable: None,
            max_client_sessions: 32,
            port: None,
        }
    }
}

/// Fully validated configuration used to open a native Oliphaunt database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenConfig {
    /// Runtime mode.
    pub mode: EngineMode,
    /// Storage used by the database instance.
    pub storage: DatabaseStorage,
    /// Initialization policy for an empty storage directory.
    pub initialization: DatabaseInitialization,
    /// Direct-mode settings.
    pub direct: NativeDirectConfig,
    /// Broker-mode settings.
    pub broker: NativeBrokerConfig,
    /// Server-mode settings.
    pub server: NativeServerConfig,
    /// Durability profile.
    pub durability: DurabilityProfile,
    /// Runtime footprint profile.
    pub runtime_footprint: RuntimeFootprintProfile,
    /// Explicit PostgreSQL startup GUC overrides.
    pub startup_gucs: Vec<PostgresStartupGuc>,
    /// PostgreSQL startup user/role for SDK-owned connections.
    pub username: String,
    /// PostgreSQL database name for SDK-owned connections.
    pub database: String,
    /// Explicitly selected PostgreSQL extensions.
    pub extensions: Vec<Extension>,
}

impl OpenConfig {
    /// Build a direct-mode config for a persistent directory.
    pub fn native_direct(directory: impl Into<PathBuf>) -> Self {
        Self {
            mode: EngineMode::NativeDirect,
            storage: DatabaseStorage::Directory(directory.into()),
            initialization: DatabaseInitialization::PackagedTemplate,
            direct: NativeDirectConfig::default(),
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            durability: DurabilityProfile::Safe,
            runtime_footprint: RuntimeFootprintProfile::Throughput,
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
        }
    }

    /// Validate cross-field constraints.
    pub fn validate(&self) -> Result<()> {
        for guc in &self.startup_gucs {
            validate_postgres_startup_guc(guc)?;
        }
        if let DatabaseStorage::Directory(directory) = &self.storage {
            if directory.as_os_str().is_empty() {
                return Err(Error::InvalidConfig(
                    "database storage directory must not be empty".to_owned(),
                ));
            }
            if path_contains_nul(directory) {
                return Err(Error::InvalidConfig(
                    "database storage directory must not contain NUL bytes".to_owned(),
                ));
            }
        }
        validate_startup_identity("username", &self.username)?;
        validate_startup_identity("database", &self.database)?;
        let _ = self.resolved_extensions()?;
        match self.mode {
            EngineMode::NativeDirect if self.direct.max_client_sessions == 0 => {
                Err(Error::InvalidConfig(
                    "native direct max_client_sessions must be exactly 1".to_owned(),
                ))
            }
            EngineMode::NativeDirect if self.direct.max_client_sessions > 1 => {
                Err(Error::UnsupportedClientSessions {
                    mode: self.mode,
                    requested: self.direct.max_client_sessions,
                    supported: 1,
                })
            }
            EngineMode::NativeBroker if self.broker.max_client_sessions == 0 => {
                Err(Error::InvalidConfig(
                    "native broker max_client_sessions must be exactly 1".to_owned(),
                ))
            }
            EngineMode::NativeBroker if self.broker.max_client_sessions > 1 => {
                Err(Error::UnsupportedClientSessions {
                    mode: self.mode,
                    requested: self.broker.max_client_sessions,
                    supported: 1,
                })
            }
            EngineMode::NativeBroker if self.broker.max_instances == 0 => {
                Err(Error::InvalidConfig(
                    "native broker max_instances must be greater than zero".to_owned(),
                ))
            }
            EngineMode::NativeBroker => {
                if let Some(executable) = &self.broker.executable {
                    validate_config_path("native broker executable path", executable)?;
                }
                Ok(())
            }
            EngineMode::NativeServer if self.server.max_client_sessions == 0 => {
                Err(Error::InvalidConfig(
                    "native server max_client_sessions must be greater than zero".to_owned(),
                ))
            }
            EngineMode::NativeServer if self.server.port == Some(0) => Err(Error::InvalidConfig(
                "native server port must be greater than zero; omit the port to allocate one"
                    .to_owned(),
            )),
            EngineMode::NativeServer => {
                if let Some(executable) = &self.server.executable {
                    validate_config_path("native server executable path", executable)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Resolve selected extensions and their hard PostgreSQL dependencies.
    pub fn resolved_extensions(&self) -> Result<Vec<Extension>> {
        resolve_extensions(&self.extensions)
    }

    pub(crate) fn postgres_startup_assignments(&self) -> Vec<String> {
        let mut assignments = Vec::new();
        for (name, value) in self.runtime_footprint.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        for (name, value) in self.durability.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        for guc in &self.startup_gucs {
            assignments.push(guc.startup_assignment());
        }
        assignments
    }
}

fn validate_config_path(label: &str, path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(format!("{label} must not be empty")));
    }
    if path_contains_nul(path) {
        return Err(Error::InvalidConfig(format!(
            "{label} must not contain NUL bytes"
        )));
    }
    Ok(())
}

fn validate_startup_identity(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(Error::InvalidConfig(format!("{label} must not be empty")));
    }
    if value.as_bytes().contains(&0) {
        return Err(Error::InvalidConfig(format!(
            "{label} must not contain NUL bytes"
        )));
    }
    Ok(())
}

fn validate_postgres_startup_guc(guc: &PostgresStartupGuc) -> Result<()> {
    let name = guc.name.trim();
    if name.is_empty() {
        return Err(Error::InvalidConfig(
            "PostgreSQL startup GUC name must not be empty".to_owned(),
        ));
    }
    if name.as_bytes().contains(&0) || guc.value.as_bytes().contains(&0) {
        return Err(Error::InvalidConfig(
            "PostgreSQL startup GUC must not contain NUL bytes".to_owned(),
        ));
    }
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
    {
        return Err(Error::InvalidConfig(format!(
            "PostgreSQL startup GUC name '{}' must contain only ASCII letters, digits, '_' or '.'",
            guc.name
        )));
    }
    if guc.value.trim().is_empty() {
        return Err(Error::InvalidConfig(format!(
            "PostgreSQL startup GUC '{}' value must not be empty",
            guc.name
        )));
    }
    Ok(())
}
