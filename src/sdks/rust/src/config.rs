use std::fmt;
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

impl fmt::Display for EngineMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Direct => f.write_str("direct"),
            Self::Broker => f.write_str("broker"),
            Self::Server => f.write_str("server"),
        }
    }
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
    pub(crate) port: Option<u16>,
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
                if self.server.port == Some(0) {
                    return Err(Error::InvalidConfig(
                        "native server port must be greater than zero; omit the port to allocate one"
                            .to_owned(),
                    ));
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

    pub(crate) fn postgres_startup_assignments(&self) -> Vec<String> {
        self.startup_gucs
            .iter()
            .map(PostgresStartupGuc::startup_assignment)
            .collect()
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
    use super::{OpenConfig, PostgresStartupGuc};

    #[test]
    fn startup_guc_names_use_portable_postgres_grammar() {
        let mut config = OpenConfig::direct("target/test-roots/native-direct-guc-grammar");
        config.startup_gucs = vec![
            PostgresStartupGuc::new("_name", ""),
            PostgresStartupGuc::new("ext.name$1", "on"),
        ];
        config.validate().unwrap();
        assert_eq!(
            config.postgres_startup_assignments(),
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
}
