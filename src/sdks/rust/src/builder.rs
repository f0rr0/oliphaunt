use std::path::PathBuf;

use crate::broker::NativeBrokerRuntime;
use crate::config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, EngineMode, NativeBrokerConfig, NativeServerConfig,
    OpenConfig, PostgresStartupGuc, ServerListen,
};
use crate::database::{Oliphaunt, OliphauntServer};
use crate::engine::NativeRuntime;
use crate::error::{Error, Result};
use crate::executor::EngineExecutor;
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
use crate::server::NativeServerRuntime;
use crate::storage::DatabaseStorage;

/// Builder for opening native Oliphaunt databases.
pub struct OliphauntBuilder {
    mode: EngineMode,
    mode_explicit: bool,
    storage: DatabaseStorage,
    broker: NativeBrokerConfig,
    server: NativeServerConfig,
    server_listen_configured: bool,
    startup_gucs: Vec<PostgresStartupGuc>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self {
            mode: EngineMode::Direct,
            mode_explicit: false,
            storage: DatabaseStorage::TemporaryDirectory,
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            server_listen_configured: false,
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

    /// Select the in-process direct topology for [`Self::open`].
    ///
    /// Do not combine this selector with [`Self::open_server`].
    pub fn direct(mut self) -> Self {
        self.mode = EngineMode::Direct;
        self.mode_explicit = true;
        self
    }

    /// Select the broker-process topology for [`Self::open`].
    ///
    /// Do not combine this selector with [`Self::open_server`].
    pub fn broker(mut self) -> Self {
        self.mode = EngineMode::Broker;
        self.mode_explicit = true;
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

    /// Use an explicit broker helper executable with `broker().open()`.
    pub fn broker_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.broker.executable = Some(path.into());
        self
    }

    /// Use an explicit PostgreSQL server executable with [`Self::open_server`].
    pub fn server_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.server.executable = Some(path.into());
        self
    }

    /// Select the local endpoint exposed by [`Self::open_server`].
    pub fn listen(mut self, listen: ServerListen) -> Self {
        self.server.listen = listen;
        self.server_listen_configured = true;
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

    fn build_config(&self, terminal: BuilderTerminal) -> Result<OpenConfig> {
        self.validate_terminal(terminal)?;
        let config = OpenConfig {
            mode: match terminal {
                BuilderTerminal::Open => self.mode,
                BuilderTerminal::OpenServer => EngineMode::Server,
            },
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

    fn validate_terminal(&self, terminal: BuilderTerminal) -> Result<()> {
        match terminal {
            BuilderTerminal::Open => {
                if self.server.executable.is_some() {
                    return Err(Error::InvalidConfig(
                        "server_executable(...) is only valid with open_server()".to_owned(),
                    ));
                }
                if self.server_listen_configured {
                    return Err(Error::InvalidConfig(
                        "listen(...) is only valid with open_server()".to_owned(),
                    ));
                }
                if self.mode == EngineMode::Direct && self.broker.executable.is_some() {
                    return Err(Error::InvalidConfig(
                        "broker_executable(...) requires broker().open()".to_owned(),
                    ));
                }
            }
            BuilderTerminal::OpenServer => {
                if self.mode_explicit {
                    return Err(Error::InvalidConfig(format!(
                        "{}() selects an embedded topology and cannot be combined with open_server(); omit the topology selector",
                        self.mode
                    )));
                }
                if self.broker.executable.is_some() {
                    return Err(Error::InvalidConfig(
                        "broker_executable(...) is only valid with broker().open()".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Open a direct or broker database.
    ///
    /// Server-only listener and executable options are rejected instead of
    /// being silently ignored.
    pub async fn open(self) -> Result<Oliphaunt> {
        let config = self.build_config(BuilderTerminal::Open)?;
        let (executor, ()) = EngineExecutor::open("oliphaunt-owner", move || {
            let session = match config.mode {
                EngineMode::Direct => OliphauntRuntime::from_env().open(config)?,
                EngineMode::Broker => {
                    NativeBrokerRuntime::from_config(&config.broker).open(config)?
                }
                EngineMode::Server => unreachable!("server mode uses open_server"),
            };
            Ok((session, ()))
        })
        .await?;
        Ok(Oliphaunt::from_executor(executor))
    }

    /// Open a local PostgreSQL server and return its server handle.
    ///
    /// Explicit direct/broker selectors and broker-only options are rejected
    /// instead of being silently ignored.
    pub async fn open_server(self) -> Result<OliphauntServer> {
        let config = self.build_config(BuilderTerminal::OpenServer)?;
        let (executor, connection_string) =
            EngineExecutor::open("oliphaunt-server-owner", move || {
                let session = NativeServerRuntime::from_config(&config.server).open(config)?;
                let connection_string = session.connection_string().ok_or_else(|| {
                    Error::Engine("native server did not expose its connection string".to_owned())
                })?;
                Ok((session, connection_string))
            })
            .await?;
        Ok(OliphauntServer::from_executor(executor, connection_string))
    }
}

#[derive(Clone, Copy)]
enum BuilderTerminal {
    Open,
    OpenServer,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalid_config(builder: OliphauntBuilder, terminal: BuilderTerminal) -> String {
        match builder.build_config(terminal) {
            Err(Error::InvalidConfig(message)) => message,
            Err(error) => panic!("expected invalid configuration, got {error}"),
            Ok(_) => panic!("expected terminal-specific configuration rejection"),
        }
    }

    #[test]
    fn open_rejects_server_only_options_including_an_explicit_default_listener() {
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().server_executable("postgres"),
                BuilderTerminal::Open,
            ),
            "server_executable(...) is only valid with open_server()"
        );
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().listen(ServerListen::tcp()),
                BuilderTerminal::Open,
            ),
            "listen(...) is only valid with open_server()"
        );
    }

    #[test]
    fn direct_open_rejects_a_broker_executable_instead_of_ignoring_it() {
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().broker_executable("oliphaunt-broker"),
                BuilderTerminal::Open,
            ),
            "broker_executable(...) requires broker().open()"
        );
        OliphauntBuilder::new()
            .broker()
            .broker_executable("oliphaunt-broker")
            .build_config(BuilderTerminal::Open)
            .expect("broker executable is valid for broker open");
    }

    #[test]
    fn open_server_rejects_embedded_topology_selection_and_broker_options() {
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().direct(),
                BuilderTerminal::OpenServer,
            ),
            "direct() selects an embedded topology and cannot be combined with open_server(); omit the topology selector"
        );
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().broker(),
                BuilderTerminal::OpenServer,
            ),
            "broker() selects an embedded topology and cannot be combined with open_server(); omit the topology selector"
        );
        assert_eq!(
            invalid_config(
                OliphauntBuilder::new().broker_executable("oliphaunt-broker"),
                BuilderTerminal::OpenServer,
            ),
            "broker_executable(...) is only valid with broker().open()"
        );
    }
}
