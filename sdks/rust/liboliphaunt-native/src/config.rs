use crate::extension::resolve_extensions;
use crate::storage::path_contains_nul;
use crate::{DatabaseStorage, Error, Extension, Result};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
pub const DEFAULT_USERNAME: &str = "postgres";
pub const DEFAULT_DATABASE: &str = "postgres";
/// Explicit PostgreSQL startup GUC override.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PostgresStartupGuc {
    /// PostgreSQL GUC name, such as `shared_buffers`.
    pub name: String,
    /// PostgreSQL GUC value, such as `32MB`.
    pub value: String,
}

impl PostgresStartupGuc {
    /// Create a startup GUC override.
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    fn startup_assignment(&self) -> String {
        format!("{}={}", self.name.trim(), self.value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// An explicitly selected resource tree and the receipt describing its bytes.
pub struct NativeResourceDirectory {
    /// Root directory of PGDATA or ICU data files.
    pub directory: PathBuf,
    /// Seed JSON or ICU properties receipt supplied by the resource package.
    pub manifest: PathBuf,
}

/// Independently selected seed bytes (Cargo) or a producer-unpacked directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeClusterSeed {
    /// Compressed native PGDATA and its independently packaged JSON receipt.
    Archive {
        /// Zstandard-compressed tar archive.
        archive: Arc<[u8]>,
        /// UTF-8 cluster-seed JSON manifest.
        manifest: Arc<[u8]>,
    },
    /// A package-manager-extracted native seed directory.
    Directory(NativeResourceDirectory),
}

impl NativeClusterSeed {
    /// Select a Cargo carrier's `seed_archive()` and `seed_manifest()` outputs.
    pub fn new(archive: impl Into<Arc<[u8]>>, manifest: impl AsRef<[u8]>) -> Self {
        Self::Archive {
            archive: archive.into(),
            manifest: Arc::from(manifest.as_ref()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfig {
    pub storage: DatabaseStorage,
    pub startup_gucs: Vec<PostgresStartupGuc>,
    pub username: String,
    pub database: String,
    pub extensions: Vec<Extension>,
    /// Initialization input for a new embedded database; ignored for existing roots.
    pub seed: Option<NativeClusterSeed>,
    /// Explicit ICU data used by both initialization and database execution.
    pub icu_data: Option<NativeResourceDirectory>,
}
impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            storage: DatabaseStorage::default(),
            startup_gucs: Vec::new(),
            username: DEFAULT_USERNAME.to_owned(),
            database: DEFAULT_DATABASE.to_owned(),
            extensions: Vec::new(),
            seed: None,
            icu_data: None,
        }
    }
}
impl NativeConfig {
    pub fn direct(directory: impl Into<PathBuf>) -> Self {
        Self {
            storage: DatabaseStorage::Directory(directory.into()),
            ..Self::default()
        }
    }
    pub fn validate(&self) -> Result<()> {
        if let Some(NativeClusterSeed::Directory(resource)) = &self.seed {
            validate_config_path("seed directory", &resource.directory)?;
            validate_config_path("seed manifest", &resource.manifest)?;
        }
        if let Some(resource) = &self.icu_data {
            validate_config_path("ICU data directory", &resource.directory)?;
            validate_config_path("ICU data manifest", &resource.manifest)?;
        }
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
        Ok(())
    }
    pub fn resolved_extensions(&self) -> Result<Vec<Extension>> {
        resolve_extensions(&self.extensions)
    }

    pub fn postgres_startup_assignments(&self, extensions: &[Extension]) -> Vec<String> {
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
