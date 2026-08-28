use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::extension::{Extension, resolve_extensions};
use crate::storage::{DatabaseStorage, path_contains_nul};

/// Default PostgreSQL role used by SDK-managed native sessions.
pub(crate) const DEFAULT_USERNAME: &str = "postgres";

/// Default PostgreSQL database used by SDK-managed native sessions.
pub(crate) const DEFAULT_DATABASE: &str = "postgres";

/// Native runtime mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum EngineMode {
    /// In-process embedded PostgreSQL.
    Direct,
    /// Process-isolated embedded PostgreSQL.
    Broker,
    /// Local PostgreSQL-compatible server.
    Server,
}

/// Explicit PostgreSQL startup GUC override.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PostgresStartupGuc {
    /// PostgreSQL GUC name, such as `shared_buffers`.
    pub(crate) name: String,
    /// PostgreSQL GUC value, such as `32MB`.
    pub(crate) value: String,
}

impl PostgresStartupGuc {
    /// Create a startup GUC override.
    pub(crate) fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    fn startup_assignment(&self) -> String {
        format!("{}={}", self.name.trim(), self.value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct NativeBrokerConfig {
    pub(crate) executable: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct NativeServerConfig {
    pub(crate) executable: Option<PathBuf>,
    pub(crate) listen: ServerListen,
}

/// Local endpoint exposed by a native PostgreSQL server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerListen {
    /// Listen on the fixed loopback address. `None` allocates an ephemeral port.
    Tcp {
        /// PostgreSQL port, or `None` for an ephemeral port.
        port: Option<u16>,
    },
    /// Listen in a PostgreSQL Unix-domain socket directory.
    ///
    /// The resolved directory must be valid UTF-8 because server handles
    /// publish it through a portable PostgreSQL connection string.
    #[cfg(unix)]
    Unix {
        /// Directory containing `.s.PGSQL.<port>`.
        directory: PathBuf,
        /// PostgreSQL port encoded in the socket filename.
        port: u16,
    },
}

impl Default for ServerListen {
    fn default() -> Self {
        Self::tcp()
    }
}

impl ServerListen {
    /// Listen on loopback using an ephemeral TCP port.
    pub const fn tcp() -> Self {
        Self::Tcp { port: None }
    }

    /// Listen on loopback using a fixed TCP port.
    pub const fn tcp_port(port: u16) -> Self {
        Self::Tcp { port: Some(port) }
    }

    /// Listen in a UTF-8 Unix-domain socket directory using PostgreSQL port
    /// 5432.
    #[cfg(unix)]
    pub fn unix(directory: impl Into<PathBuf>) -> Self {
        Self::Unix {
            directory: directory.into(),
            port: 5432,
        }
    }

    /// Listen in a UTF-8 Unix-domain socket directory using a fixed PostgreSQL
    /// port.
    #[cfg(unix)]
    pub fn unix_port(directory: impl Into<PathBuf>, port: u16) -> Self {
        Self::Unix {
            directory: directory.into(),
            port,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenConfig {
    pub(crate) mode: EngineMode,
    pub(crate) storage: DatabaseStorage,
    pub(crate) broker: NativeBrokerConfig,
    pub(crate) server: NativeServerConfig,
    pub(crate) startup_gucs: Vec<PostgresStartupGuc>,
    pub(crate) username: String,
    pub(crate) database: String,
    pub(crate) extensions: Vec<Extension>,
}

impl OpenConfig {
    #[cfg(test)]
    pub(crate) fn direct(directory: impl Into<PathBuf>) -> Self {
        Self {
            mode: EngineMode::Direct,
            storage: DatabaseStorage::Directory(directory.into()),
            broker: NativeBrokerConfig::default(),
            server: NativeServerConfig::default(),
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for guc in &self.startup_gucs {
            validate_postgres_startup_guc(guc)?;
            let name = guc.name.trim();
            if ["config_file", "data_directory"]
                .iter()
                .any(|owned| name.eq_ignore_ascii_case(owned))
            {
                return Err(Error::InvalidConfig(format!(
                    "Oliphaunt owns PostgreSQL startup GUC '{name}'; configure the database through Oliphaunt's storage API"
                )));
            }
        }
        if let DatabaseStorage::Directory(directory) = &self.storage {
            validate_config_path("database storage directory", directory)?;
        }
        validate_startup_identity("username", &self.username)?;
        validate_startup_identity("database", &self.database)?;
        let _ = self.resolved_extensions()?;
        match self.mode {
            EngineMode::Broker => {
                if let Some(executable) = &self.broker.executable {
                    validate_config_path("native broker executable path", executable)?;
                }
            }
            EngineMode::Server => {
                for guc in &self.startup_gucs {
                    let name = guc.name.trim();
                    if ["listen_addresses", "port", "unix_socket_directories"]
                        .iter()
                        .any(|owned| name.eq_ignore_ascii_case(owned))
                    {
                        return Err(Error::InvalidConfig(format!(
                            "native server owns PostgreSQL startup GUC '{name}'; configure its storage and listener through OliphauntServerBuilder"
                        )));
                    }
                }
                match &self.server.listen {
                    ServerListen::Tcp { port: Some(0) } => {
                        return Err(Error::InvalidConfig(
                            "native TCP server port must be greater than zero; omit the port to allocate one"
                                .to_owned(),
                        ));
                    }
                    #[cfg(unix)]
                    ServerListen::Unix { directory, port } => {
                        validate_config_path("native server Unix socket directory", directory)?;
                        let resolved_directory = if directory.is_absolute() {
                            directory.clone()
                        } else {
                            std::env::current_dir()
                                .map_err(|error| {
                                    Error::Engine(format!(
                                        "resolve current directory for native server Unix socket: {error}"
                                    ))
                                })?
                                .join(directory)
                        };
                        server_unix_socket_directory_str(&resolved_directory)?;
                        validate_server_unix_socket_path(&resolved_directory, *port)?;
                        if *port == 0 {
                            return Err(Error::InvalidConfig(
                                "native Unix server port must be greater than zero".to_owned(),
                            ));
                        }
                    }
                    _ => {}
                }
                if let Some(executable) = &self.server.executable {
                    validate_config_path("native server executable path", executable)?;
                }
            }
            EngineMode::Direct => {}
        }
        Ok(())
    }

    pub(crate) fn resolved_extensions(&self) -> Result<Vec<Extension>> {
        resolve_extensions(&self.extensions)
    }

    pub(crate) fn postgres_startup_assignments(&self, extensions: &[Extension]) -> Vec<String> {
        let required_preloads = crate::extension::required_shared_preload_libraries(extensions);
        if required_preloads.is_empty() {
            return self
                .startup_gucs
                .iter()
                .map(PostgresStartupGuc::startup_assignment)
                .collect();
        }

        let configured_preloads = self
            .startup_gucs
            .iter()
            .rev()
            .find(|guc| {
                guc.name
                    .trim()
                    .eq_ignore_ascii_case("shared_preload_libraries")
            })
            .map(|guc| guc.value.as_str());
        let mut preloads = Vec::new();
        let mut seen = BTreeSet::new();
        if let Some(configured) = configured_preloads {
            append_unique_csv_values(configured, &mut preloads, &mut seen);
        }
        for required in required_preloads {
            append_unique_csv_values(required, &mut preloads, &mut seen);
        }

        let mut assignments = self
            .startup_gucs
            .iter()
            .filter(|guc| {
                !guc.name
                    .trim()
                    .eq_ignore_ascii_case("shared_preload_libraries")
            })
            .map(PostgresStartupGuc::startup_assignment)
            .collect::<Vec<_>>();
        assignments.push(format!("shared_preload_libraries={}", preloads.join(",")));
        assignments
    }
}

fn append_unique_csv_values(value: &str, ordered: &mut Vec<String>, seen: &mut BTreeSet<String>) {
    for item in value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        if seen.insert(item.to_owned()) {
            ordered.push(item.to_owned());
        }
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

#[cfg(unix)]
pub(crate) fn server_unix_socket_directory_str(directory: &Path) -> Result<&str> {
    directory.to_str().ok_or_else(|| {
        Error::InvalidConfig(
            "native server Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path"
                .to_owned(),
        )
    })
}

#[cfg(unix)]
fn validate_server_unix_socket_path(directory: &Path, port: u16) -> Result<()> {
    let socket = directory.join(format!(".s.PGSQL.{port}"));
    if socket.as_os_str().len() >= 100 {
        return Err(Error::InvalidConfig(format!(
            "native server Unix socket path is too long: {}",
            socket.display()
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
    if !name.split('.').all(|component| {
        let mut bytes = component.bytes();
        bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
    }) {
        return Err(Error::InvalidConfig(format!(
            "PostgreSQL startup GUC name '{}': each dot-separated component must start with an ASCII letter or '_', followed by ASCII letters, digits, '_', or '$'",
            guc.name
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{EngineMode, OpenConfig, PostgresStartupGuc, ServerListen};

    #[test]
    fn startup_guc_names_use_portable_postgres_grammar() {
        let mut config = OpenConfig::direct("target/test-roots/native-direct-guc-grammar");
        config.startup_gucs = vec![
            PostgresStartupGuc::new("_name", ""),
            PostgresStartupGuc::new("ext.name$1", "on"),
        ];
        config.validate().unwrap();
        assert_eq!(
            config.postgres_startup_assignments(&[]),
            ["_name=", "ext.name$1=on"]
        );

        for name in ["1name", ".foo", "a..b", "a.1b", "ext.$name"] {
            config.startup_gucs = vec![PostgresStartupGuc::new(name, "1")];
            assert!(
                config.validate().is_err(),
                "accepted invalid GUC name {name}"
            );
        }
        config.startup_gucs = vec![PostgresStartupGuc::new("good", "bad\0value")];
        assert!(config.validate().is_err());
    }

    #[test]
    fn native_server_rejects_caller_owned_topology_gucs() {
        for name in ["LISTEN_ADDRESSES", "port", "unix_socket_directories"] {
            let mut config = OpenConfig::direct("target/test-roots/native-server-owned-guc");
            config.mode = EngineMode::Server;
            config.startup_gucs = vec![PostgresStartupGuc::new(name, "override")];

            let error = config.validate().expect_err("server topology is SDK-owned");
            assert!(error.to_string().contains("native server owns"), "{error}");
        }
    }

    #[test]
    fn every_native_topology_rejects_storage_redirection_gucs() {
        for mode in [EngineMode::Direct, EngineMode::Broker, EngineMode::Server] {
            for name in ["CONFIG_FILE", "data_directory"] {
                let mut config = OpenConfig::direct("target/test-roots/native-owned-guc");
                config.mode = mode;
                config.startup_gucs = vec![PostgresStartupGuc::new(name, "/tmp/other")];

                let error = config.validate().expect_err("storage is SDK-owned");
                assert!(error.to_string().contains("Oliphaunt owns"), "{error}");
            }
        }
    }

    #[test]
    fn server_listen_matches_shared_postgres_vocabulary() {
        let fixture: serde_json::Value = serde_json::from_str(&crate::test_fixtures::text(
            "postgres/server-listen.json",
            "testdata/server-listen.json",
        ))
        .unwrap();
        assert_eq!(fixture["tcp"]["host"], "127.0.0.1");
        assert_eq!(fixture["unix"]["defaultPort"], 5432);
        assert_eq!(fixture["unix"]["filePrefix"], ".s.PGSQL.");

        let mut config = OpenConfig::direct("target/test-roots/native-server-listen");
        config.mode = EngineMode::Server;
        for port in fixture["tcp"]["validPorts"].as_array().unwrap() {
            config.server.listen = ServerListen::tcp_port(port.as_u64().unwrap() as u16);
            config.validate().unwrap();
        }
        config.server.listen = ServerListen::tcp_port(0);
        assert!(config.validate().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn server_listen_rejects_non_utf8_unix_socket_directory_without_mutation() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let mut leaf = format!(
            "oliphaunt-native-socket-{}-{}-",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        )
        .into_bytes();
        leaf.push(0xff);
        let directory = std::env::temp_dir().join(OsString::from_vec(leaf));
        assert!(!directory.exists());

        let mut config = OpenConfig::direct("target/test-roots/native-server-non-utf8-uri");
        config.mode = EngineMode::Server;
        config.server.listen = ServerListen::unix_port(directory.clone(), 15432);
        let error = config
            .validate()
            .expect_err("a String connection URI cannot preserve a non-UTF-8 socket path");

        assert!(error.to_string().contains("must be valid UTF-8"));
        assert!(!directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn server_listen_rejects_too_long_unix_socket_path_without_mutation() {
        let directory = std::env::temp_dir().join(format!(
            "oliphaunt-native-socket-{}-{}",
            std::process::id(),
            "x".repeat(120)
        ));
        assert!(!directory.exists());

        let mut config = OpenConfig::direct("target/test-roots/native-server-long-uri");
        config.mode = EngineMode::Server;
        config.server.listen = ServerListen::unix_port(directory.clone(), 15432);
        let error = config
            .validate()
            .expect_err("Unix socket sockaddr length must be validated before root preparation");

        assert!(error.to_string().contains("socket path is too long"));
        assert!(!directory.exists());
    }
}
