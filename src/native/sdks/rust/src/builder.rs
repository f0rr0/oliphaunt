use std::path::PathBuf;

#[cfg(feature = "desktop")]
use crate::broker::NativeBrokerRuntime;
use crate::config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, EngineMode, NativeBrokerConfig, NativeServerConfig,
    OpenConfig, PostgresStartupGuc, ServerListen,
};
use crate::database::{AsyncOliphaunt, AsyncOliphauntServer};
use crate::engine::{EngineSession, NativeRuntime};
use crate::error::{Error, Result};
use crate::executor::EngineExecutor;
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
#[cfg(feature = "desktop")]
use crate::server::NativeServerRuntime;
use crate::storage::DatabaseStorage;

/// Builder for opening native Oliphaunt databases on a dedicated SDK owner thread.
#[derive(Debug, Clone)]
pub struct AsyncOliphauntBuilder {
    admission: Option<crate::AdmissionLimits>,
    mode: EngineMode,
    broker: NativeBrokerConfig,
    common: CommonOpenOptions,
}

/// Builder for starting a native PostgreSQL server on a dedicated SDK owner thread.
#[derive(Debug, Clone, Default)]
pub struct AsyncOliphauntServerBuilder {
    server: NativeServerConfig,
    common: CommonOpenOptions,
}

#[derive(Debug, Clone)]
struct CommonOpenOptions {
    storage: DatabaseStorage,
    startup_gucs: Vec<PostgresStartupGuc>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
    seed: Option<liboliphaunt_native_bindings::NativeClusterSeed>,
    icu_data: Option<liboliphaunt_native_bindings::NativeResourceDirectory>,
}

impl Default for CommonOpenOptions {
    fn default() -> Self {
        Self {
            storage: DatabaseStorage::TemporaryDirectory,
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
            seed: None,
            icu_data: None,
        }
    }
}

impl CommonOpenOptions {
    fn build_config(
        &self,
        mode: EngineMode,
        broker: NativeBrokerConfig,
        server: NativeServerConfig,
    ) -> Result<OpenConfig> {
        for extension in &self.extensions {
            if let Some(package) = extension.package()
                && Some(package.runtime_version) != option_env!("OLIPHAUNT_NATIVE_RUNTIME_VERSION")
            {
                return Err(Error::InvalidConfig(format!(
                    "{} requires native runtime {}, but this SDK embeds {}",
                    package.product,
                    package.runtime_version,
                    option_env!("OLIPHAUNT_NATIVE_RUNTIME_VERSION").unwrap_or("no runtime")
                )));
            }
        }
        let config = OpenConfig {
            mode,
            storage: self.storage.clone(),
            broker,
            server,
            startup_gucs: self.startup_gucs.clone(),
            username: self.username.clone(),
            database: self.database.clone(),
            extensions: self.extensions.clone(),
            seed: self.seed.clone(),
            icu_data: self.icu_data.clone(),
        };
        config.validate()?;
        Ok(config)
    }
}

impl Default for AsyncOliphauntBuilder {
    fn default() -> Self {
        Self {
            admission: None,
            mode: EngineMode::Direct,
            broker: NativeBrokerConfig::default(),
            common: CommonOpenOptions::default(),
        }
    }
}

impl AsyncOliphauntBuilder {
    /// Bound pending preparation, queued and executing work; clones and transactions share it.
    /// Omitting this preserves the legacy queued-only admission policy.
    pub fn admission(mut self, limits: crate::AdmissionLimits) -> Self {
        self.admission = Some(limits);
        self
    }

    /// Select an explicit cluster seed for a new database.
    pub fn seed(mut self, seed: liboliphaunt_native_bindings::NativeClusterSeed) -> Self {
        self.common.seed = Some(seed);
        self
    }
    /// Select independently packaged ICU data and its receipt.
    pub fn icu_data(mut self, data: liboliphaunt_native_bindings::NativeResourceDirectory) -> Self {
        self.common.icu_data = Some(data);
        self
    }
    /// Create an asynchronous builder. The database topology defaults to direct.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select the in-process direct topology for [`Self::open`].
    pub fn direct(mut self) -> Self {
        self.mode = EngineMode::Direct;
        self
    }

    /// Select the broker-process topology for [`Self::open`].
    pub fn broker(mut self) -> Self {
        self.mode = EngineMode::Broker;
        self
    }

    /// Select database storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.common.storage = storage;
        self
    }

    /// Use an explicit broker helper executable with `broker().open()`.
    pub fn broker_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.broker.executable = Some(path.into());
        self
    }

    /// Set the helper's deadline for each login handshake. Defaults to five seconds.
    /// Rounded up to whole milliseconds; valid range is 1..=2147483647 milliseconds.
    /// This requires broker mode and does not limit queries or backups.
    #[cfg(feature = "desktop")]
    pub fn broker_handshake_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.broker.handshake_timeout = Some(timeout);
        self
    }

    /// Add an explicit PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.common
            .startup_gucs
            .push(PostgresStartupGuc::new(name, value));
        self
    }

    /// Add explicit PostgreSQL startup GUCs.
    pub fn startup_gucs<N, V>(mut self, gucs: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<String>,
        V: Into<String>,
    {
        self.common.startup_gucs.extend(
            gucs.into_iter()
                .map(|(name, value)| PostgresStartupGuc::new(name, value)),
        );
        self
    }

    /// Set the PostgreSQL startup user.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.common.username = username.into();
        self
    }

    /// Set the PostgreSQL database name.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.common.database = database.into();
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.common.extensions.push(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.common.extensions.extend(extensions);
        self
    }

    pub(crate) fn build_config(&self) -> Result<OpenConfig> {
        if let Some(limits) = self.admission {
            limits
                .validate()
                .map_err(|message| Error::InvalidConfig(message.to_owned()))?;
        }
        if self.mode == EngineMode::Direct && self.broker.executable.is_some() {
            return Err(Error::InvalidConfig(
                "broker_executable(...) requires broker().open()".to_owned(),
            ));
        }
        self.common.build_config(
            self.mode,
            self.broker.clone(),
            NativeServerConfig::default(),
        )
    }

    /// Open a direct or broker database on a dedicated owner thread.
    pub async fn open(self) -> Result<AsyncOliphaunt> {
        let config = self.build_config()?;
        let (executor, ()) =
            EngineExecutor::open_with_admission("oliphaunt-owner", self.admission, move || {
                open_embedded_session(config).map(|session| (session, ()))
            })
            .await?;
        Ok(AsyncOliphaunt::from_executor(executor))
    }
}

impl AsyncOliphauntServerBuilder {
    /// Select independently packaged ICU data and its receipt.
    pub fn icu_data(mut self, data: liboliphaunt_native_bindings::NativeResourceDirectory) -> Self {
        self.common.icu_data = Some(data);
        self
    }
    /// Create an asynchronous local-server builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select server storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.common.storage = storage;
        self
    }

    /// Use an explicit PostgreSQL server executable.
    pub fn server_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.server.executable = Some(path.into());
        self
    }

    /// Select the endpoint exposed by the local server.
    pub fn listen(mut self, listen: ServerListen) -> Self {
        self.server.listen = listen;
        self
    }

    /// Add an explicit PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.common
            .startup_gucs
            .push(PostgresStartupGuc::new(name, value));
        self
    }

    /// Add explicit PostgreSQL startup GUCs.
    pub fn startup_gucs<N, V>(mut self, gucs: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<String>,
        V: Into<String>,
    {
        self.common.startup_gucs.extend(
            gucs.into_iter()
                .map(|(name, value)| PostgresStartupGuc::new(name, value)),
        );
        self
    }

    /// Set the PostgreSQL startup user.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.common.username = username.into();
        self
    }

    /// Set the PostgreSQL database name.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.common.database = database.into();
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.common.extensions.push(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.common.extensions.extend(extensions);
        self
    }

    pub(crate) fn build_config(&self) -> Result<OpenConfig> {
        self.common.build_config(
            EngineMode::Server,
            NativeBrokerConfig::default(),
            self.server.clone(),
        )
    }

    /// Start a local PostgreSQL server and return its lifecycle handle.
    pub async fn start(self) -> Result<AsyncOliphauntServer> {
        let config = self.build_config()?;
        let (executor, connection_string) =
            EngineExecutor::open("oliphaunt-server-owner", move || {
                start_server_session(config)
            })
            .await?;
        Ok(AsyncOliphauntServer::from_executor(
            executor,
            connection_string,
        ))
    }
}

pub(crate) fn open_embedded_session(config: OpenConfig) -> Result<Box<dyn EngineSession>> {
    crate::build_resources::prepare_base_resources()?;
    match config.mode {
        EngineMode::Direct => OliphauntRuntime::from_env().open(config),
        #[cfg(feature = "desktop")]
        EngineMode::Broker => NativeBrokerRuntime::from_config(&config.broker).open(config),
        #[cfg(not(feature = "desktop"))]
        EngineMode::Broker => Err(Error::InvalidConfig(
            "broker requires the desktop feature".into(),
        )),
        EngineMode::Server => unreachable!("server mode uses its dedicated builder"),
    }
}

#[cfg(feature = "desktop")]
pub(crate) fn start_server_session(config: OpenConfig) -> Result<(Box<dyn EngineSession>, String)> {
    crate::build_resources::prepare_base_resources()?;
    let session = NativeServerRuntime::from_config(&config.server).open(config)?;
    let connection_string = session.connection_string().ok_or_else(|| {
        Error::Engine("native server did not expose its connection string".to_owned())
    })?;
    Ok((session, connection_string))
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn start_server_session(
    _config: OpenConfig,
) -> Result<(Box<dyn EngineSession>, String)> {
    Err(Error::InvalidConfig(
        "server requires the desktop feature".into(),
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_invalid_admission_before_owner_construction() {
        for limits in [
            crate::AdmissionLimits::new(0, 1),
            crate::AdmissionLimits::new(1, 0),
        ] {
            assert!(
                super::AsyncOliphauntBuilder::new()
                    .admission(limits)
                    .build_config()
                    .is_err()
            );
        }
    }

    use super::*;

    #[cfg(feature = "desktop")]
    #[test]
    fn handshake_timeout_is_validated_before_owner_construction() {
        use std::time::Duration;
        for timeout in [Duration::ZERO, Duration::from_millis(i32::MAX as u64 + 1)] {
            assert!(
                AsyncOliphauntBuilder::new()
                    .broker()
                    .broker_handshake_timeout(timeout)
                    .build_config()
                    .is_err()
            );
        }
        assert!(
            AsyncOliphauntBuilder::new()
                .broker_handshake_timeout(Duration::from_secs(1))
                .build_config()
                .is_err()
        );
        let config = AsyncOliphauntBuilder::new()
            .broker()
            .broker_handshake_timeout(Duration::from_secs(2))
            .build_config()
            .unwrap();
        assert_eq!(
            config.broker.handshake_timeout,
            Some(Duration::from_secs(2))
        );
    }

    #[test]
    fn direct_open_rejects_a_broker_executable_instead_of_ignoring_it() {
        let error = AsyncOliphauntBuilder::new()
            .broker_executable("oliphaunt-broker")
            .build_config()
            .expect_err("direct cannot silently ignore a broker executable");
        assert_eq!(error.kind(), crate::error::ErrorKind::InvalidConfiguration);
        assert_eq!(
            error.to_string(),
            "broker_executable(...) requires broker().open()"
        );
        AsyncOliphauntBuilder::new()
            .broker()
            .broker_executable("oliphaunt-broker")
            .build_config()
            .expect("broker executable is valid for broker open");
    }

    #[test]
    fn dedicated_server_builder_produces_only_server_configuration() {
        let config = AsyncOliphauntServerBuilder::new()
            .listen(ServerListen::tcp_port(6543))
            .server_executable("postgres")
            .build_config()
            .expect("server configuration");
        assert_eq!(config.mode, EngineMode::Server);
        assert_eq!(config.server.listen, ServerListen::tcp_port(6543));
        assert_eq!(config.server.executable, Some(PathBuf::from("postgres")));
        assert!(config.broker.executable.is_none());
    }
}
