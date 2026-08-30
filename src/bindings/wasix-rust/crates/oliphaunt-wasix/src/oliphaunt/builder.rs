use anyhow::Result;

use crate::oliphaunt::assets::{CatalogProfile, default_catalog_profile};
#[cfg(feature = "extensions")]
use crate::oliphaunt::base::install_missing_extension_archives;
use crate::oliphaunt::base::{DatabasePlan, PreparedDatabase, prepare_database};
use crate::oliphaunt::client::Oliphaunt;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::{
    Extension, postgres_config_with_extension_startup, resolve_extension_set,
};
use crate::oliphaunt::storage::DatabaseStorage;

/// Builder for opening [`Oliphaunt`] databases.
#[derive(Debug, Clone)]
pub struct OliphauntBuilder {
    storage: DatabaseStorage,
    catalog_profile: CatalogProfile,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self {
            storage: DatabaseStorage::Memory,
            catalog_profile: default_catalog_profile(),
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl OliphauntBuilder {
    /// Create a builder for a memory database initialized from the packaged
    /// cluster seed.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select where PostgreSQL stores its mutable database files.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.storage = storage;
        self
    }

    /// Select the packaged standard or ICU catalog and matching runtime data.
    #[cfg(any(feature = "__internal-napi", test))]
    #[doc(hidden)]
    pub fn catalog_profile(mut self, profile: CatalogProfile) -> Self {
        self.catalog_profile = profile;
        self
    }

    /// Set a PostgreSQL startup GUC for this embedded backend.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.postgres_config.insert(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs for this embedded backend.
    pub fn startup_gucs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        for (name, value) in settings {
            self.postgres_config.insert(name, value);
        }
        self
    }

    /// Connect as a PostgreSQL role. The role must already exist in the
    /// cluster.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.startup_config.username = username.into();
        self
    }

    /// Connect to a PostgreSQL database. The database must already exist in the
    /// cluster.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.startup_config.database = database.into();
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to the database.
    /// Database-local installation remains the application's migration concern.
    #[cfg(feature = "extensions")]
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to the database.
    /// Database-local installation remains the application's migration concern.
    #[cfg(feature = "extensions")]
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Install, initialize, and start the selected database.
    pub fn open(self) -> crate::Result<Oliphaunt> {
        crate::error::public_result(self.open_inner())
    }

    pub(crate) fn open_inner(self) -> Result<Oliphaunt> {
        #[cfg(feature = "extensions")]
        let (extensions, postgres_config) = self.resolved_extension_startup()?;
        #[cfg(not(feature = "extensions"))]
        let postgres_config = self.postgres_config.clone();
        postgres_config.validate()?;
        self.storage.validate()?;
        self.startup_config.validate()?;
        let plan = DatabasePlan::new(self.storage.clone(), self.catalog_profile);
        let prepared = prepare_database(plan, &self.startup_config.username)?;
        #[cfg(feature = "extensions")]
        {
            self.open_prepared_database(prepared, extensions, postgres_config)
        }
        #[cfg(not(feature = "extensions"))]
        {
            self.open_prepared_database(prepared, postgres_config)
        }
    }

    #[cfg(feature = "extensions")]
    fn resolved_extension_startup(&self) -> Result<(Vec<Extension>, PostgresConfig)> {
        let extensions = resolve_extension_set(&self.extensions)?;
        let postgres_config =
            postgres_config_with_extension_startup(self.postgres_config.clone(), &extensions)?;
        Ok((extensions, postgres_config))
    }

    fn open_prepared_database(
        self,
        prepared: PreparedDatabase,
        #[cfg(feature = "extensions")] extensions: Vec<Extension>,
        postgres_config: PostgresConfig,
    ) -> Result<Oliphaunt> {
        let PreparedDatabase {
            workspace,
            directory_lock,
            outcome,
        } = prepared;
        #[cfg(feature = "extensions")]
        install_missing_extension_archives(&outcome, &extensions)?;
        #[cfg(feature = "extensions")]
        let mut instance = Oliphaunt::new_prepared_with_config_and_extension_preload(
            outcome,
            postgres_config,
            self.startup_config,
            &extensions,
        )?;
        #[cfg(not(feature = "extensions"))]
        let mut instance =
            Oliphaunt::new_prepared_with_config(outcome, postgres_config, self.startup_config)?;
        if let Some(lock) = directory_lock {
            instance.attach_directory_lock(lock);
        }
        if let Some(workspace) = workspace {
            instance.attach_workspace(workspace);
        }
        Ok(instance)
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    #[test]
    fn default_builder_selects_memory() {
        let builder = OliphauntBuilder::default();
        assert_eq!(builder.storage, DatabaseStorage::Memory);
        assert_eq!(builder.catalog_profile, CatalogProfile::default());
    }

    #[test]
    fn catalog_profile_is_an_immutable_builder_value() {
        let standard = OliphauntBuilder::new().catalog_profile(CatalogProfile::Standard);
        let icu = standard.clone().catalog_profile(CatalogProfile::Icu);

        assert_eq!(standard.catalog_profile, CatalogProfile::Standard);
        assert_eq!(icu.catalog_profile, CatalogProfile::Icu);
    }

    #[cfg(not(feature = "icu"))]
    #[test]
    fn unavailable_icu_profile_is_rejected_before_storage_mutation() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let root = parent.path().join("database");
        let error = OliphauntBuilder::new()
            .storage(DatabaseStorage::Directory(root.clone()))
            .catalog_profile(CatalogProfile::Icu)
            .open()
            .err()
            .expect("ICU profile requires its packaging feature");

        assert_eq!(error.kind(), crate::ErrorKind::InvalidConfiguration);
        assert!(error.to_string().contains("requires"));
        assert!(!root.exists());
    }

    #[test]
    fn fluent_configuration_preserves_postgres_vocabulary() {
        let directory = std::path::PathBuf::from("database-root");
        let builder = OliphauntBuilder::new()
            .storage(DatabaseStorage::Directory(directory.clone()))
            .startup_guc("work_mem", "16MB")
            .startup_gucs([("application_name", "builder-test")])
            .username("app_user")
            .database("app_database");

        assert_eq!(builder.storage, DatabaseStorage::Directory(directory));
        assert_eq!(
            builder.postgres_config.iter().collect::<Vec<_>>(),
            vec![("application_name", "builder-test"), ("work_mem", "16MB")]
        );
        assert_eq!(builder.startup_config.username, "app_user");
        assert_eq!(builder.startup_config.database, "app_database");
    }

    #[test]
    fn open_rejects_invalid_startup_configuration_before_runtime_work() {
        let error = OliphauntBuilder::new()
            .startup_guc("bad=name", "value")
            .open()
            .err()
            .expect("invalid GUCs must fail before preparing a database");

        assert!(error.to_string().contains("must not contain"));
    }
}

#[cfg(all(test, feature = "extension-pg-textsearch"))]
mod tests {
    use super::*;
    use crate::oliphaunt::extensions::Extension;

    #[test]
    fn direct_path_merges_pg_textsearch_preload_once_before_open() {
        let builder = OliphauntBuilder::new()
            .startup_guc("shared_preload_libraries", "auto_explain")
            .startup_guc("work_mem", "16MB")
            .extensions([Extension::PG_TEXTSEARCH, Extension::PG_TEXTSEARCH]);

        let (_, postgres_config) = builder.resolved_extension_startup().unwrap();

        assert_eq!(
            postgres_config.get("shared_preload_libraries"),
            Some("auto_explain,pg_textsearch")
        );
        assert_eq!(postgres_config.get("work_mem"), Some("16MB"));
        assert_eq!(
            postgres_config
                .get("shared_preload_libraries")
                .unwrap()
                .split(',')
                .filter(|library| *library == "pg_textsearch")
                .count(),
            1
        );
    }
}
