use std::collections::BTreeMap;

use anyhow::{Result, bail, ensure};

use crate::oliphaunt::interface::DebugLevel;

pub(crate) const SINGLE_BACKEND_STARTUP_GUCS: &[(&str, &str)] = &[
    ("exit_on_error", "false"),
    ("max_wal_senders", "0"),
    ("max_worker_processes", "0"),
    ("max_parallel_workers", "0"),
    ("max_parallel_workers_per_gather", "0"),
    ("max_parallel_maintenance_workers", "0"),
    ("io_method", "sync"),
];

/// PostgreSQL startup configuration applied through normal `postgres -c` GUC
/// handling before the embedded backend starts.
///
/// Settings added here override `oliphaunt-wasix`'s default startup profile because
/// they are appended after the defaults in the generated PostgreSQL argv. Settings
/// that enforce the embedded single-backend runtime shape accept only their
/// canonical value and are omitted from the user-specific configuration.
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

    #[cfg(feature = "extensions")]
    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.settings.get(name).map(String::as_str)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for (name, value) in &self.settings {
            validate_guc_name(name)?;
            if let Some(required) = single_backend_guc_value(name) {
                ensure!(
                    value == required,
                    "Postgres config setting '{name}' is managed by oliphaunt-wasix and must remain '{required}'"
                );
            }
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
            .filter(|(name, _)| single_backend_guc_value(name).is_none())
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn stable_entries(&self) -> Vec<(String, String)> {
        self.settings
            .iter()
            .filter(|(name, _)| single_backend_guc_value(name).is_none())
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
        validate_extra_args(&self.extra_args)?;
        Ok(())
    }

    pub(crate) fn effective_extra_args(&self) -> Vec<&str> {
        let mut effective = Vec::with_capacity(self.extra_args.len());
        let mut index = 0;
        while index < self.extra_args.len() {
            if let Some((assignment, consumed)) = startup_assignment(&self.extra_args, index) {
                let name = assignment
                    .split_once('=')
                    .map_or(assignment, |(name, _)| name);
                if single_backend_guc_value(name).is_some() {
                    index += consumed;
                    continue;
                }
            }
            effective.push(self.extra_args[index].as_str());
            index += 1;
        }
        effective
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

fn single_backend_guc_value(name: &str) -> Option<&'static str> {
    let normalized = name.trim().replace('-', "_");
    SINGLE_BACKEND_STARTUP_GUCS
        .iter()
        .find_map(|(managed, value)| normalized.eq_ignore_ascii_case(managed).then_some(*value))
}

fn validate_extra_args(args: &[String]) -> Result<()> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        ensure!(
            arg.starts_with('-') && arg != "-" && arg != "--",
            "Postgres startup argument '{arg}' must be an option; use database() for the database name"
        );
        if let Some(assignment) = arg.strip_prefix("--") {
            validate_startup_assignment(assignment)?;
            index += 1;
            continue;
        }

        let cluster = &arg.as_bytes()[1..];
        ensure!(
            cluster.is_ascii(),
            "Postgres startup argument '{arg}' contains a non-ASCII option"
        );
        let mut option_index = 0;
        while option_index < cluster.len() {
            let option = cluster[option_index] as char;
            ensure!(
                is_postgres_short_option(option),
                "Postgres startup argument '{arg}' contains unsupported option '-{option}'"
            );
            option_index += 1;
            if !postgres_short_option_takes_value(option) {
                continue;
            }
            let value = if option_index < cluster.len() {
                std::str::from_utf8(&cluster[option_index..]).expect("ASCII option cluster")
            } else {
                index += 1;
                args.get(index).map(String::as_str).ok_or_else(|| {
                    anyhow::anyhow!("Postgres startup option '-{option}' requires a value")
                })?
            };
            if option == 'c' {
                validate_startup_assignment(value)?;
            }
            break;
        }
        index += 1;
    }
    Ok(())
}

fn is_postgres_short_option(option: char) -> bool {
    matches!(
        option,
        'B' | 'b'
            | 'C'
            | 'c'
            | 'D'
            | 'd'
            | 'E'
            | 'e'
            | 'F'
            | 'f'
            | 'h'
            | 'i'
            | 'j'
            | 'k'
            | 'l'
            | 'N'
            | 'n'
            | 'O'
            | 'P'
            | 'p'
            | 'r'
            | 'S'
            | 's'
            | 'T'
            | 't'
            | 'v'
            | 'W'
    )
}

fn postgres_short_option_takes_value(option: char) -> bool {
    matches!(
        option,
        'B' | 'C' | 'c' | 'D' | 'd' | 'f' | 'h' | 'k' | 'N' | 'p' | 'r' | 'S' | 't' | 'v' | 'W'
    )
}

fn validate_startup_assignment(assignment: &str) -> Result<()> {
    let (name, value) = assignment.split_once('=').ok_or_else(|| {
        anyhow::anyhow!("Postgres startup setting '{assignment}' requires a value")
    })?;
    if let Some(required) = single_backend_guc_value(name) {
        ensure!(
            value == required,
            "Postgres startup setting '{name}' is managed by oliphaunt-wasix and must remain '{required}'"
        );
    }
    Ok(())
}

fn startup_assignment(args: &[String], index: usize) -> Option<(&str, usize)> {
    let arg = args.get(index)?;
    if arg == "-c" {
        args.get(index + 1)
            .map(|assignment| (assignment.as_str(), 2))
    } else if let Some(assignment) = arg.strip_prefix("-c") {
        (!assignment.is_empty()).then_some((assignment, 1))
    } else {
        arg.strip_prefix("--").map(|assignment| (assignment, 1))
    }
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
    use super::{PostgresConfig, StartupConfig};

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
    fn rejects_managed_single_backend_startup_args() {
        for args in [
            vec!["-c".to_owned(), "max_worker_processes=1".to_owned()],
            vec!["-cmax_parallel_workers=1".to_owned()],
            vec!["--io-method=worker".to_owned()],
            vec!["-Fcio_method=worker".to_owned()],
        ] {
            let config = StartupConfig {
                extra_args: args,
                ..StartupConfig::default()
            };
            let err = config
                .validate()
                .expect_err("managed startup argument should be rejected");
            assert!(err.to_string().contains("must remain"));
        }
    }

    #[test]
    fn accepts_matching_single_backend_startup_args() {
        let config = StartupConfig {
            extra_args: vec![
                "-cMAX_WORKER_PROCESSES=0".to_owned(),
                "--io-method=sync".to_owned(),
            ],
            ..StartupConfig::default()
        };
        config.validate().unwrap();
        assert!(config.effective_extra_args().is_empty());
    }

    #[test]
    fn rejects_startup_arguments_that_break_option_parsing() {
        for args in [
            vec!["--".to_owned()],
            vec!["postgres".to_owned()],
            vec!["-D".to_owned()],
            vec!["-C".to_owned()],
            vec!["--application-name".to_owned()],
        ] {
            let config = StartupConfig {
                extra_args: args,
                ..StartupConfig::default()
            };
            assert!(config.validate().is_err());
        }
    }
}
