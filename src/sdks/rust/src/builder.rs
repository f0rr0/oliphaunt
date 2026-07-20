use std::path::PathBuf;
use std::sync::Arc;

use crate::broker::NativeBrokerRuntime;
use crate::config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, DurabilityProfile, EngineMode, NativeBrokerConfig,
    NativeDirectConfig, NativeServerConfig, OpenConfig, PostgresStartupGuc,
    RuntimeFootprintProfile,
};
use crate::database::Oliphaunt;
use crate::engine::NativeRuntime;
use crate::error::{Error, Result};
use crate::executor::EngineExecutor;
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
use crate::server::NativeServerRuntime;
use crate::storage::{BootstrapStrategy, DatabaseRoot, RootLockPolicy, StorageConfig};

/// Builder for opening native Oliphaunt databases.
pub struct OliphauntBuilder {
    mode: EngineMode,
    root: Option<DatabaseRoot>,
    bootstrap: BootstrapStrategy,
    lock_policy: RootLockPolicy,
    direct: NativeDirectConfig,
    broker: NativeBrokerConfig,
    server: NativeServerConfig,
    durability: DurabilityProfile,
    runtime_footprint: RuntimeFootprintProfile,
    startup_gucs: Vec<PostgresStartupGuc>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
    runtime: Option<Arc<dyn NativeRuntime>>,
}

impl Default for OliphauntBuilder {
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
            runtime_footprint: RuntimeFootprintProfile::Throughput,
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
            runtime: None,
        }
    }
}

impl OliphauntBuilder {
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

    /// Set logical client sessions for modes that expose client sessions.
    ///
    /// Direct and broker mode validate this as exactly `1`; server mode is the
    /// mode for true independent PostgreSQL client sessions.
    pub fn max_client_sessions(mut self, sessions: usize) -> Self {
        self.direct.max_client_sessions = sessions;
        self.broker.max_client_sessions = sessions;
        self.server.max_client_sessions = sessions;
        self
    }

    /// Configure broker maximum roots.
    ///
    /// Broker mode supervises one isolated helper process per active root while
    /// each helper owns one physical PostgreSQL backend session. Use this to
    /// bound how many roots one shared broker runtime may own at once.
    pub fn broker_max_roots(mut self, roots: usize) -> Self {
        self.broker.max_roots = roots;
        self
    }

    /// Use an explicit broker helper executable.
    pub fn broker_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.broker.executable = Some(path.into());
        self
    }

    /// Use an explicit PostgreSQL server executable.
    pub fn server_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.server.executable = Some(path.into());
        self
    }

    /// Use an explicit server port instead of allocating an ephemeral one.
    pub fn server_port(mut self, port: u16) -> Self {
        self.server.port = Some(port);
        self
    }

    /// Set durability profile.
    pub fn durability(mut self, durability: DurabilityProfile) -> Self {
        self.durability = durability;
        self
    }

    /// Set runtime footprint profile.
    pub fn runtime_footprint(mut self, profile: RuntimeFootprintProfile) -> Self {
        self.runtime_footprint = profile;
        self
    }

    /// Add an explicit PostgreSQL startup GUC override.
    ///
    /// Later overrides win when PostgreSQL receives the generated `-c`
    /// arguments, so this method can intentionally override the selected
    /// footprint or durability profile.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.startup_gucs.push(PostgresStartupGuc::new(name, value));
        self
    }

    /// Add explicit PostgreSQL startup GUC overrides.
    pub fn startup_gucs(mut self, gucs: impl IntoIterator<Item = PostgresStartupGuc>) -> Self {
        self.startup_gucs.extend(gucs);
        self
    }

    /// Set the PostgreSQL startup user/role for SDK-owned connections.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.username = username.into();
        self
    }

    /// Set the PostgreSQL database name for SDK-owned connections.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.database = database.into();
        self
    }

    /// Opt into one native PostgreSQL extension.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Opt into native PostgreSQL extensions.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Use a concrete native runtime implementation.
    pub fn runtime(mut self, runtime: impl NativeRuntime) -> Self {
        self.runtime = Some(Arc::new(runtime));
        self
    }

    /// Use a shared native runtime implementation.
    pub fn runtime_arc(mut self, runtime: Arc<dyn NativeRuntime>) -> Self {
        self.runtime = Some(runtime);
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
            runtime_footprint: self.runtime_footprint,
            startup_gucs: self.startup_gucs.clone(),
            username: self.username.clone(),
            database: self.database.clone(),
            extensions: self.extensions.clone(),
        };
        config.validate()?;
        Ok(config)
    }

    /// Open the database.
    pub async fn open(self) -> Result<Oliphaunt> {
        let config = self.build_config()?;
        let runtime = self.runtime.unwrap_or_else(|| default_runtime_for(&config));
        let session = runtime.open(config)?;
        let executor = EngineExecutor::spawn(session);
        Ok(Oliphaunt::from_executor(executor))
    }
}

fn default_runtime_for(config: &OpenConfig) -> Arc<dyn NativeRuntime> {
    match config.mode {
        EngineMode::NativeDirect => Arc::new(OliphauntRuntime::from_env()),
        EngineMode::NativeBroker => Arc::new(NativeBrokerRuntime::from_config(&config.broker)),
        EngineMode::NativeServer => Arc::new(NativeServerRuntime::from_config(&config.server)),
    }
}
