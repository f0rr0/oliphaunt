use std::path::PathBuf;
use std::sync::Arc;

use crate::config::{
    DurabilityProfile, EngineMode, NativeBrokerConfig, NativeDirectConfig, NativeServerConfig,
    OpenConfig,
};
use crate::database::Pglite;
use crate::engine::NativeRuntime;
use crate::error::{Error, Result};
use crate::executor::EngineExecutor;
use crate::extension::{Extension, ExtensionPack};
use crate::libpglite::LibPgliteRuntime;
use crate::storage::{BootstrapStrategy, DatabaseRoot, RootLockPolicy, StorageConfig};

/// Builder for opening native PGlite databases.
pub struct PgliteBuilder {
    mode: EngineMode,
    root: Option<DatabaseRoot>,
    bootstrap: BootstrapStrategy,
    lock_policy: RootLockPolicy,
    direct: NativeDirectConfig,
    broker: NativeBrokerConfig,
    server: NativeServerConfig,
    durability: DurabilityProfile,
    extension_packs: Vec<ExtensionPack>,
    extensions: Vec<Extension>,
    runtime: Arc<dyn NativeRuntime>,
}

impl Default for PgliteBuilder {
    fn default() -> Self {
        Self {
            mode: EngineMode::NativeDirect,
            root: None,
            bootstrap: BootstrapStrategy::PackagedTemplate,
            lock_policy: RootLockPolicy::ExclusiveProcess,
            direct: NativeDirectConfig::default(),
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            durability: DurabilityProfile::Safe,
            extension_packs: Vec::new(),
            extensions: Vec::new(),
            runtime: Arc::new(LibPgliteRuntime::from_env()),
        }
    }
}

impl PgliteBuilder {
    /// Create a native builder. Defaults to `NativeDirect`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select native direct mode.
    pub fn native_direct(mut self) -> Self {
        self.mode = EngineMode::NativeDirect;
        self.lock_policy = RootLockPolicy::ExclusiveProcess;
        self
    }

    /// Select native broker mode.
    pub fn native_broker(mut self) -> Self {
        self.mode = EngineMode::NativeBroker;
        self.lock_policy = RootLockPolicy::BrokerOwned;
        self
    }

    /// Select native server mode.
    pub fn native_server(mut self) -> Self {
        self.mode = EngineMode::NativeServer;
        self.lock_policy = RootLockPolicy::BrokerOwned;
        self
    }

    /// Select a native engine mode.
    pub fn engine(mut self, mode: EngineMode) -> Self {
        self.mode = mode;
        self.lock_policy = match mode {
            EngineMode::NativeDirect => RootLockPolicy::ExclusiveProcess,
            EngineMode::NativeBroker | EngineMode::NativeServer => RootLockPolicy::BrokerOwned,
        };
        self
    }

    /// Open a persistent database root directory.
    pub fn path(mut self, path: impl Into<PathBuf>) -> Self {
        self.root = Some(DatabaseRoot::Path(path.into()));
        self
    }

    /// Open a temporary database root owned by the SDK.
    pub fn temporary(mut self) -> Self {
        self.root = Some(DatabaseRoot::Temporary);
        self
    }

    /// Use a packaged template cluster for first-open bootstrap.
    pub fn packaged_template(mut self) -> Self {
        self.bootstrap = BootstrapStrategy::PackagedTemplate;
        self
    }

    /// Require an existing already-bootstrapped root.
    pub fn existing_only(mut self) -> Self {
        self.bootstrap = BootstrapStrategy::ExistingOnly;
        self
    }

    /// Use initdb only for development/tooling flows.
    pub fn initdb_tooling_only(mut self, initdb: impl Into<PathBuf>) -> Self {
        self.bootstrap = BootstrapStrategy::InitdbToolingOnly {
            initdb: initdb.into(),
        };
        self
    }

    /// Set direct-mode logical client sessions.
    pub fn max_client_sessions(mut self, sessions: usize) -> Self {
        self.direct.max_client_sessions = sessions;
        self.server.max_client_sessions = sessions;
        self
    }

    /// Configure broker maximum roots.
    pub fn broker_max_roots(mut self, roots: usize) -> Self {
        self.broker.max_roots = roots;
        self
    }

    /// Set durability profile.
    pub fn durability(mut self, durability: DurabilityProfile) -> Self {
        self.durability = durability;
        self
    }

    /// Opt into an extension pack.
    pub fn extension_pack(mut self, pack: ExtensionPack) -> Self {
        self.extension_packs.push(pack);
        self
    }

    /// Opt into one native PostgreSQL extension.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Use a concrete native runtime implementation.
    pub fn runtime(mut self, runtime: impl NativeRuntime) -> Self {
        self.runtime = Arc::new(runtime);
        self
    }

    /// Use a shared native runtime implementation.
    pub fn runtime_arc(mut self, runtime: Arc<dyn NativeRuntime>) -> Self {
        self.runtime = runtime;
        self
    }

    /// Build and validate the open configuration without opening the engine.
    pub fn build_config(&self) -> Result<OpenConfig> {
        let root = self.root.clone().ok_or(Error::MissingDatabaseRoot)?;
        let config = OpenConfig {
            mode: self.mode,
            storage: StorageConfig {
                root,
                bootstrap: self.bootstrap.clone(),
                lock_policy: self.lock_policy,
            },
            direct: self.direct.clone(),
            broker: self.broker.clone(),
            server: self.server.clone(),
            durability: self.durability,
            extension_packs: self.extension_packs.clone(),
            extensions: self.extensions.clone(),
        };
        config.validate()?;
        Ok(config)
    }

    /// Open the database.
    pub async fn open(self) -> Result<Pglite> {
        let config = self.build_config()?;
        let session = self.runtime.open(config)?;
        let executor = EngineExecutor::spawn(session);
        Ok(Pglite::from_executor(executor))
    }
}
