use std::collections::BTreeMap;

use anyhow::{Result, bail, ensure};

use crate::oliphaunt::interface::DebugLevel;

/// PostgreSQL startup configuration applied through normal `postgres -c` GUC
/// handling before the embedded backend starts.
///
/// Settings added here override `oliphaunt-wasix`'s default startup profile because
/// they are appended after the defaults in the generated PostgreSQL argv.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PostgresConfig {
    settings: BTreeMap<String, String>,
}

impl PostgresConfig {
    /// Create an empty startup configuration.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set or replace one PostgreSQL GUC.
    pub fn set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.settings.insert(name.into(), value.into());
        self
    }

    pub(crate) fn insert(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.settings.insert(name.into(), value.into());
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for (name, value) in &self.settings {
            validate_guc_name(name)?;
            ensure!(
                !value.contains('\0'),
                "Postgres config value for '{name}' must not contain NUL bytes"
            );
        }
        Ok(())
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.settings
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn stable_entries(&self) -> Vec<(String, String)> {
        self.settings
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupConfig {
    pub(crate) username: String,
    pub(crate) database: String,
    pub(crate) debug_level: Option<DebugLevel>,
    pub(crate) relaxed_durability: bool,
    pub(crate) extra_args: Vec<String>,
}

impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            username: "postgres".to_owned(),
            database: "template1".to_owned(),
            debug_level: None,
            relaxed_durability: false,
            extra_args: Vec::new(),
        }
    }
}

impl StartupConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_startup_value("username", &self.username)?;
        validate_startup_value("database", &self.database)?;
        if let Some(level) = self.debug_level {
            ensure!(
                level <= 5,
                "Postgres debug level must be between 0 and 5, got {level}"
            );
        }
        for arg in &self.extra_args {
            ensure!(
                !arg.contains('\0'),
                "Postgres startup argument must not contain NUL bytes"
            );
        }
        Ok(())
    }
}

fn validate_guc_name(name: &str) -> Result<()> {
    ensure!(!name.is_empty(), "Postgres config name must not be empty");
    ensure!(
        !name.contains('\0') && !name.contains('='),
        "Postgres config name '{name}' must not contain NUL bytes or '='"
    );

    for part in name.split('.') {
        if part.is_empty() {
            bail!("Postgres config name '{name}' contains an empty identifier part");
        }
        let mut chars = part.chars();
        let first = chars.next().expect("part is non-empty");
        if !(first == '_' || first.is_ascii_alphabetic()) {
            bail!("Postgres config name '{name}' must start each identifier with a letter or '_'");
        }
        if chars.any(|ch| !(ch == '_' || ch.is_ascii_alphanumeric())) {
            bail!("Postgres config name '{name}' may only contain letters, digits, '_', and '.'");
        }
    }

    Ok(())
}

fn validate_startup_value(name: &str, value: &str) -> Result<()> {
    ensure!(
        !value.is_empty(),
        "Postgres startup {name} must not be empty"
    );
    ensure!(
        !value.contains('\0'),
        "Postgres startup {name} must not contain NUL bytes"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::PostgresConfig;

    #[test]
    fn validates_builtin_and_extension_guc_names() {
        PostgresConfig::new()
            .set("synchronous_commit", "off")
            .set("pg_stat_statements.track", "all")
            .validate()
            .unwrap();
    }

    #[test]
    fn rejects_invalid_guc_names_before_startup() {
        let err = PostgresConfig::new()
            .set("bad=name", "off")
            .validate()
            .expect_err("invalid GUC name should be rejected");
        assert!(err.to_string().contains("must not contain"));
    }
}
