use std::path::PathBuf;

use crate::broker::NativeBrokerRuntime;
use crate::config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, EngineMode, NativeBrokerConfig, NativeServerConfig,
    OpenConfig, PostgresStartupGuc, ServerListen,
};
use crate::database::{Oliphaunt, OliphauntServer};
use crate::engine::NativeRuntime;
use crate::error::Result;
use crate::executor::EngineExecutor;
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
use crate::server::NativeServerRuntime;
use crate::storage::DatabaseStorage;

/// Builder for opening native Oliphaunt databases.
pub struct OliphauntBuilder {
    mode: EngineMode,
    storage: DatabaseStorage,
    broker: NativeBrokerConfig,
    server: NativeServerConfig,
    startup_gucs: Vec<PostgresStartupGuc>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self {
            mode: EngineMode::Direct,
            storage: DatabaseStorage::TemporaryDirectory,
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
        }
    }
}

impl OliphauntBuilder {
    /// Create a native builder. Defaults to direct mode.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select direct execution.
    pub fn direct(mut self) -> Self {
        self.mode = EngineMode::Direct;
        self
    }

    /// Select broker execution.
    pub fn broker(mut self) -> Self {
        self.mode = EngineMode::Broker;
        self
    }

    /// Select database storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.storage = storage;
        self
    }

    /// Open a caller-owned persistent directory.
    pub fn directory(self, path: impl Into<PathBuf>) -> Self {
        self.storage(DatabaseStorage::Directory(path.into()))
    }

    /// Open an SDK-owned temporary directory.
    pub fn temporary_directory(self) -> Self {
        self.storage(DatabaseStorage::TemporaryDirectory)
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

    /// Select the local endpoint exposed by server mode.
    pub fn listen(mut self, listen: ServerListen) -> Self {
        self.server.listen = listen;
        self
    }

    /// Add an explicit PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.startup_gucs.push(PostgresStartupGuc::new(name, value));
        self
    }

    /// Add explicit PostgreSQL startup GUCs.
    pub fn startup_gucs<N, V>(mut self, gucs: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<String>,
        V: Into<String>,
    {
        self.startup_gucs.extend(
            gucs.into_iter()
                .map(|(name, value)| PostgresStartupGuc::new(name, value)),
        );
        self
    }

    /// Set the PostgreSQL startup user.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.username = username.into();
        self
    }

    /// Set the PostgreSQL database name.
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

    pub(crate) fn build_config(&self) -> Result<OpenConfig> {
        let config = OpenConfig {
            mode: self.mode,
            storage: self.storage.clone(),
            broker: self.broker.clone(),
            server: self.server.clone(),
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
        let session = match config.mode {
            EngineMode::Direct => OliphauntRuntime::from_env().open(config)?,
            EngineMode::Broker => NativeBrokerRuntime::from_config(&config.broker).open(config)?,
            EngineMode::Server => unreachable!("server mode uses open_server"),
        };
        Ok(Oliphaunt::from_executor(EngineExecutor::spawn(session)))
    }

    /// Open a local PostgreSQL server and return its server handle.
    pub async fn open_server(mut self) -> Result<OliphauntServer> {
        self.mode = EngineMode::Server;
        let config = self.build_config()?;
        let session = NativeServerRuntime::from_config(&config.server).open(config)?;
        let connection_string = session.connection_string().ok_or_else(|| {
            crate::Error::Engine("native server did not expose its connection string".to_owned())
        })?;
        Ok(OliphauntServer::from_executor(
            EngineExecutor::spawn(session),
            connection_string,
        ))
    }
}
