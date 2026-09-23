//! Prepared database ownership and low-level PostgreSQL protocol sessions.
//!
//! Socket adapters can own their transport without duplicating runtime setup.
//! Release a prepared database only after every session has shut down successfully.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Result, ensure};

use crate::DatabaseStorage;
use crate::oliphaunt::backend::BackendSession;
use crate::oliphaunt::base::{DatabasePlan, InstallOutcome, prepare_database};
use crate::oliphaunt::lifecycle::TeardownOwnership;

pub use crate::oliphaunt::assets::{CatalogProfile, ClusterSeed, IcuData, default_catalog_profile};
pub use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
pub use crate::oliphaunt::extensions::{
    postgres_config_with_extension_startup, resolve_extension_set,
};
pub use crate::oliphaunt::postgres_mod::{
    ProtocolPumpOutcome, ProtocolStream, StartupProtocolResponse, startup_error_response_output,
};

/// Owns the prepared cluster's temporary directory and exclusive directory lock.
/// A failed or omitted explicit release retains these resources until process exit.
#[derive(Debug)]
pub struct PreparedDatabase {
    owned: TeardownOwnership<crate::oliphaunt::base::PreparedDatabase>,
    runtime: PreparedRuntime,
    released: bool,
}

/// Cloneable runtime descriptor. It keeps a prepared database from being released
/// while an adapter or backend session still uses its files.
#[derive(Debug, Clone)]
pub struct PreparedRuntime {
    outcome: InstallOutcome,
    lifetime: Arc<()>,
}

impl PreparedDatabase {
    pub fn prepare(
        storage: DatabaseStorage,
        profile: CatalogProfile,
        username: &str,
    ) -> Result<Self> {
        Self::prepare_with_seed(storage, profile, username, None)
    }

    pub fn prepare_with_seed(
        storage: DatabaseStorage,
        profile: CatalogProfile,
        username: &str,
        seed: Option<ClusterSeed>,
    ) -> Result<Self> {
        Self::prepare_with_resources(storage, profile, username, seed, None)
    }

    pub fn prepare_with_resources(
        storage: DatabaseStorage,
        profile: CatalogProfile,
        username: &str,
        seed: Option<ClusterSeed>,
        icu_data: Option<IcuData>,
    ) -> Result<Self> {
        storage.validate()?;
        let mut plan = DatabasePlan::new(storage, profile);
        plan.seed = seed;
        plan.icu_data = icu_data;
        let prepared = prepare_database(plan, username)?;
        let runtime = PreparedRuntime {
            outcome: prepared.outcome.clone(),
            lifetime: Arc::new(()),
        };
        Ok(Self {
            owned: TeardownOwnership::new(prepared),
            runtime,
            released: false,
        })
    }

    pub fn runtime(&self) -> Result<PreparedRuntime> {
        ensure!(!self.released, "prepared database was released");
        Ok(self.runtime.clone())
    }

    /// Release files and root locking only after all runtime descriptors and
    /// sessions have been dropped. Failed session shutdown deliberately retains
    /// its descriptor, preventing accidental deletion of an uncertain backend.
    pub fn release(&mut self) -> Result<()> {
        ensure!(
            Arc::strong_count(&self.runtime.lifetime) == 1,
            "prepared database still has active runtime/session owners"
        );
        self.owned.release();
        self.released = true;
        Ok(())
    }
}

impl PreparedRuntime {
    pub fn catalog_profile(&self) -> CatalogProfile {
        self.outcome.runtime_layout.catalog_profile
    }
    pub fn runtime_root(&self) -> PathBuf {
        self.outcome.runtime_layout.module_root.clone()
    }

    pub fn open(&self, config: PostgresConfig, startup: StartupConfig) -> Result<ProtocolSession> {
        let backend = BackendSession::open(self.outcome.clone(), config, startup)?;
        Ok(ProtocolSession::new(backend, self.lifetime.clone()))
    }

    #[cfg(feature = "extensions")]
    pub fn open_with_extensions(
        &self,
        config: PostgresConfig,
        startup: StartupConfig,
        extensions: &[crate::Extension],
    ) -> Result<ProtocolSession> {
        crate::oliphaunt::base::install_missing_extension_archives(&self.outcome, extensions)?;
        let backend = BackendSession::open_with_extension_preload(
            self.outcome.clone(),
            config,
            startup,
            extensions,
        )?;
        Ok(ProtocolSession::new(backend, self.lifetime.clone()))
    }
}

/// One backend with explicitly owned protocol I/O and terminal shutdown.
pub struct ProtocolSession {
    backend: TeardownOwnership<BackendSession>,
    lifetime: TeardownOwnership<Arc<()>>,
    closed: bool,
    shutdown_error: Option<String>,
}

impl ProtocolSession {
    fn new(backend: BackendSession, lifetime: Arc<()>) -> Self {
        Self {
            backend: TeardownOwnership::new(backend),
            lifetime: TeardownOwnership::new(lifetime),
            closed: false,
            shutdown_error: None,
        }
    }
    pub fn startup_with_packet(&mut self, packet: &[u8]) -> Result<StartupProtocolResponse> {
        ensure!(!self.closed, "protocol session was closed");
        self.backend.startup_with_packet(packet)
    }
    pub fn send_buffered(&mut self, packet: &[u8]) -> Result<Vec<u8>> {
        ensure!(!self.closed, "protocol session was closed");
        self.backend.send_buffered(packet)
    }
    pub fn supports_protocol_pump(&self) -> bool {
        !self.closed && self.backend.supports_protocol_pump()
    }
    pub fn attach_protocol_stream<S: ProtocolStream + 'static>(&mut self, stream: S) -> Result<()> {
        ensure!(!self.closed, "protocol session was closed");
        self.backend.attach_protocol_stream(stream)
    }
    pub fn send_with_connection_protocol_pump(
        &mut self,
        packet: &[u8],
        prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        ensure!(!self.closed, "protocol session was closed");
        self.backend
            .send_with_connection_protocol_pump(packet, prefix)
    }
    pub fn shutdown(&mut self) -> Result<()> {
        if !self.closed {
            self.closed = true;
            if let Err(error) = self.backend.shutdown() {
                self.shutdown_error = Some(error.to_string());
                return Err(error);
            }
            self.backend.release();
            self.lifetime.release();
        }
        if let Some(error) = &self.shutdown_error {
            anyhow::bail!("{error}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oliphaunt::base::{DirectoryLock, RuntimeLayout, RuntimeLayoutKind};
    use crate::oliphaunt::storage::StorageRoot;

    fn prepared(root: &std::path::Path) -> Result<PreparedDatabase> {
        let outcome = InstallOutcome {
            runtime_layout: RuntimeLayout {
                catalog_profile: CatalogProfile::Standard,
                kind: RuntimeLayoutKind::FullLocal,
                mutable_root: StorageRoot::host_directory(root),
                shared_root: None,
                module_root: root.to_owned(),
            },
            pgdata_storage: StorageRoot::host_directory(root.join("pgdata")),
        };
        Ok(PreparedDatabase {
            owned: TeardownOwnership::new(crate::oliphaunt::base::PreparedDatabase {
                workspace: None,
                directory_lock: Some(DirectoryLock::acquire(root)?),
                outcome: outcome.clone(),
            }),
            runtime: PreparedRuntime {
                outcome,
                lifetime: Arc::new(()),
            },
            released: false,
        })
    }

    #[test]
    fn live_runtime_descriptor_prevents_release_then_success_unlocks_root() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut prepared = prepared(root.path())?;
        let runtime = prepared.runtime()?;
        assert!(prepared.release().is_err());
        assert!(DirectoryLock::acquire(root.path()).is_err());
        drop(runtime);
        prepared.release()?;
        assert!(prepared.runtime().is_err());
        drop(DirectoryLock::acquire(root.path())?);
        Ok(())
    }

    #[test]
    fn omitted_release_retains_unknown_backend_root_ownership() -> Result<()> {
        let root = tempfile::tempdir()?;
        drop(prepared(root.path())?);
        assert!(DirectoryLock::acquire(root.path()).is_err());
        Ok(())
    }
}
