use std::fmt;
use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::extension::{Extension, ExtensionPack, resolve_extensions};
use crate::storage::{BootstrapStrategy, DatabaseRoot, RootLockPolicy, StorageConfig};

/// Native runtime mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineMode {
    /// In-process embedded mode with one physical PostgreSQL backend session.
    NativeDirect,
    /// Helper-process mode for robust multi-root desktop operation.
    NativeBroker,
    /// Local PostgreSQL-compatible server mode with true independent sessions.
    NativeServer,
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
    /// Maximum roots this broker may own for the application.
    pub max_roots: usize,
}

impl Default for NativeBrokerConfig {
    fn default() -> Self {
        Self {
            executable: None,
            max_roots: 32,
        }
    }
}

/// Server-mode configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeServerConfig {
    /// Maximum independent PostgreSQL client sessions.
    pub max_client_sessions: usize,
}

impl Default for NativeServerConfig {
    fn default() -> Self {
        Self {
            max_client_sessions: 32,
        }
    }
}

/// Fully validated configuration used to open a native PGlite database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenConfig {
    /// Runtime mode.
    pub mode: EngineMode,
    /// Storage and bootstrap policy.
    pub storage: StorageConfig,
    /// Direct-mode settings.
    pub direct: NativeDirectConfig,
    /// Broker-mode settings.
    pub broker: NativeBrokerConfig,
    /// Server-mode settings.
    pub server: NativeServerConfig,
    /// Durability profile.
    pub durability: DurabilityProfile,
    /// Explicitly selected extension packs.
    pub extension_packs: Vec<ExtensionPack>,
    /// Explicitly selected individual extensions.
    pub extensions: Vec<Extension>,
}

impl OpenConfig {
    /// Build a direct-mode config for a persistent root.
    pub fn native_direct(root: impl Into<PathBuf>) -> Self {
        Self {
            mode: EngineMode::NativeDirect,
            storage: StorageConfig {
                root: DatabaseRoot::Path(root.into()),
                bootstrap: BootstrapStrategy::PackagedTemplate,
                lock_policy: RootLockPolicy::ExclusiveProcess,
            },
            direct: NativeDirectConfig::default(),
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            durability: DurabilityProfile::Safe,
            extension_packs: Vec::new(),
            extensions: Vec::new(),
        }
    }

    /// Validate cross-field constraints.
    pub fn validate(&self) -> Result<()> {
        match self.mode {
            EngineMode::NativeDirect if self.direct.max_client_sessions > 1 => {
                Err(Error::UnsupportedClientSessions {
                    mode: self.mode,
                    requested: self.direct.max_client_sessions,
                    supported: 1,
                })
            }
            EngineMode::NativeBroker if self.broker.max_roots == 0 => Err(Error::InvalidConfig(
                "native broker max_roots must be greater than zero".to_owned(),
            )),
            EngineMode::NativeServer if self.server.max_client_sessions == 0 => {
                Err(Error::InvalidConfig(
                    "native server max_client_sessions must be greater than zero".to_owned(),
                ))
            }
            _ => Ok(()),
        }
    }

    /// Resolve individual extension selections and extension packs.
    pub fn resolved_extensions(&self) -> Result<Vec<Extension>> {
        resolve_extensions(&self.extensions, &self.extension_packs)
    }
}
