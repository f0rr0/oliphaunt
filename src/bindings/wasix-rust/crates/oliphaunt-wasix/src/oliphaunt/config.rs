use std::collections::BTreeMap;

use anyhow::Result;

use crate::error::invalid_configuration;

pub(crate) const SINGLE_BACKEND_STARTUP_GUCS: &[(&str, &str)] = &[
    ("exit_on_error", "false"),
    ("max_wal_senders", "0"),
    ("max_worker_processes", "0"),
    ("max_parallel_workers", "0"),
    ("max_parallel_workers_per_gather", "0"),
    ("max_parallel_maintenance_workers", "0"),
    ("io_method", "sync"),
];

/// PostgreSQL startup GUCs applied through normal `postgres -c` handling before
/// the embedded backend starts.
///
/// Settings added here override `oliphaunt-wasix`'s default startup profile because
/// they are appended after the defaults in the generated PostgreSQL argv. Settings
/// that enforce the embedded single-backend runtime shape accept only their
/// canonical value and are omitted from the user-specific configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PostgresConfig {
    settings: BTreeMap<String, String>,
}

impl PostgresConfig {
    #[cfg(test)]
    fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.insert(name, value);
        self
    }

    pub(crate) fn insert(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        self.settings
            .insert(name.trim().to_ascii_lowercase(), value.into());
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.settings.get(name).map(String::as_str)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for (name, value) in &self.settings {
            validate_guc_name(name)?;
            if matches!(name.as_str(), "config_file" | "data_directory") {
                return Err(invalid_configuration(format!(
                    "Oliphaunt owns PostgreSQL startup GUC '{name}'; configure the database through Oliphaunt's storage API"
                )));
            }
            if let Some(required) = single_backend_guc_value(name)
                && value != required
            {
                return Err(invalid_configuration(format!(
                    "PostgreSQL startup GUC '{name}' is managed by oliphaunt-wasix and must remain '{required}'"
                )));
            }
            if value.contains('\0') {
                return Err(invalid_configuration(format!(
                    "PostgreSQL startup GUC value for '{name}' must not contain NUL bytes"
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.settings
            .iter()
            .filter(|(name, _)| single_backend_guc_value(name).is_none())
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupConfig {
    pub(crate) username: String,
    pub(crate) database: String,
}

impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            username: "postgres".to_owned(),
            database: "postgres".to_owned(),
        }
    }
}

impl StartupConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_startup_value("username", &self.username)?;
        validate_startup_value("database", &self.database)?;
        Ok(())
    }
}

fn validate_guc_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(invalid_configuration(
            "PostgreSQL startup GUC name must not be empty",
        ));
    }
    if name.contains('\0') || name.contains('=') {
        return Err(invalid_configuration(format!(
            "PostgreSQL startup GUC name '{name}' must not contain NUL bytes or '='"
        )));
    }

    for part in name.split('.') {
        if part.is_empty() {
            return Err(invalid_configuration(format!(
                "PostgreSQL startup GUC name '{name}' contains an empty identifier part"
            )));
        }
        let mut chars = part.chars();
        let first = chars.next().expect("part is non-empty");
        if !(first == '_' || first.is_ascii_alphabetic()) {
            return Err(invalid_configuration(format!(
                "PostgreSQL startup GUC name '{name}' must start each component with a letter or '_'"
            )));
        }
        if chars.any(|ch| !(ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())) {
            return Err(invalid_configuration(format!(
                "PostgreSQL startup GUC name '{name}' may only contain letters, digits, '_', '$', and '.'"
            )));
        }
    }

    Ok(())
}

fn single_backend_guc_value(name: &str) -> Option<&'static str> {
    let normalized = name.trim().replace('-', "_");
    SINGLE_BACKEND_STARTUP_GUCS
        .iter()
        .find_map(|(managed, value)| normalized.eq_ignore_ascii_case(managed).then_some(*value))
}

fn validate_startup_value(name: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(invalid_configuration(format!("{name} must not be empty")));
    }
    if value.contains('\0') {
        return Err(invalid_configuration(format!(
            "{name} must not contain NUL bytes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{PostgresConfig, StartupConfig};

    #[test]
    fn validates_builtin_and_extension_guc_names() {
        PostgresConfig::new()
            .set("synchronous_commit", "off")
            .set("pg_stat_statements.track", "all")
            .set("_name", "")
            .set("ext.name$1", "value")
            .set("  trimmed_name  ", "  ")
            .validate()
            .unwrap();
    }

    #[test]
    fn rejects_invalid_guc_names_before_startup() {
        for name in [
            "1name",
            ".foo",
            "a..b",
            "a.1b",
            "ext.$name",
            "bad=name",
            "bad\0name",
        ] {
            PostgresConfig::new()
                .set(name, "off")
                .validate()
                .expect_err("invalid GUC name should be rejected");
        }
    }

    #[test]
    fn rejects_managed_single_backend_gucs() {
        let err = PostgresConfig::new()
            .set("MAX_WORKER_PROCESSES", "1")
            .validate()
            .expect_err("managed GUC should be rejected");
        assert!(err.to_string().contains("must remain '0'"));
    }

    #[test]
    fn accepts_and_canonicalizes_matching_single_backend_gucs() {
        let config = PostgresConfig::new().set("MAX_WORKER_PROCESSES", "0");
        config.validate().unwrap();
        assert!(config.iter().next().is_none());
    }

    #[test]
    fn guc_names_are_case_insensitive_and_last_insertion_wins() {
        let config = PostgresConfig::new()
            .set("work_mem", "1MB")
            .set("WORK_MEM", "2MB");
        config.validate().unwrap();
        assert_eq!(config.iter().collect::<Vec<_>>(), [("work_mem", "2MB")]);
    }

    #[test]
    fn rejects_storage_redirection_gucs_case_insensitively() {
        for name in ["CONFIG_FILE", "data_directory"] {
            let error = PostgresConfig::new()
                .set(name, "/tmp/other")
                .validate()
                .expect_err("storage is SDK-owned");
            assert!(error.to_string().contains("Oliphaunt owns"));
        }
    }

    #[test]
    fn startup_values_match_native_rust_identity_validation() {
        for (username, database, expected_name) in [
            ("", "postgres", "username"),
            (" \t\n", "postgres", "username"),
            ("postgres", "", "database"),
            ("postgres", " \t\n", "database"),
        ] {
            let error = StartupConfig {
                username: username.to_owned(),
                database: database.to_owned(),
            }
            .validate()
            .expect_err("empty and whitespace-only startup identities must be rejected");
            assert_eq!(
                error.to_string(),
                format!("{expected_name} must not be empty")
            );
        }

        for (username, database, expected_name) in [
            ("bad\0user", "postgres", "username"),
            ("postgres", "bad\0database", "database"),
        ] {
            let error = StartupConfig {
                username: username.to_owned(),
                database: database.to_owned(),
            }
            .validate()
            .expect_err("NUL cannot be encoded in a startup cstring");
            assert_eq!(
                error.to_string(),
                format!("{expected_name} must not contain NUL bytes")
            );
        }

        StartupConfig {
            username: " application user ".to_owned(),
            database: " application database ".to_owned(),
        }
        .validate()
        .expect("nonempty PostgreSQL identities are preserved rather than trimmed");
    }
}
