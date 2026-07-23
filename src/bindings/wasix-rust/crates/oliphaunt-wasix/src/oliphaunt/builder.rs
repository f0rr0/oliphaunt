use std::path::PathBuf;

use anyhow::{Result, bail};

use crate::oliphaunt::base::{PreparedRoot, RootPlan, RootSource, RootTarget, prepare_root};
use crate::oliphaunt::client::Oliphaunt;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::{Extension, resolve_extension_set};
use crate::oliphaunt::interface::DebugLevel;

/// Builder for opening persistent or temporary [`Oliphaunt`] databases.
#[derive(Debug, Clone)]
pub struct OliphauntBuilder {
    target: Option<OliphauntTarget>,
    template_cache: bool,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    load_data_dir_archive: Option<Vec<u8>>,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone)]
enum OliphauntTarget {
    Path(PathBuf),
    AppId {
        qualifier: String,
        organization: String,
        application: String,
    },
    Temporary,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self {
            target: None,
            template_cache: true,
            postgres_config: PostgresConfig::default(),
            startup_config: StartupConfig::default(),
            load_data_dir_archive: None,
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl OliphauntBuilder {
    /// Create a builder. Call [`path`](Self::path), [`app_id`](Self::app_id),
    /// or [`temporary`](Self::temporary) before [`open`](Self::open).
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a persistent database rooted at `root`.
    pub fn path(mut self, root: impl Into<PathBuf>) -> Self {
        self.target = Some(OliphauntTarget::Path(root.into()));
        self
    }

    /// Open a persistent database under the platform data directory.
    pub fn app(
        mut self,
        qualifier: impl Into<String>,
        organization: impl Into<String>,
        application: impl Into<String>,
    ) -> Self {
        self.target = Some(OliphauntTarget::AppId {
            qualifier: qualifier.into(),
            organization: organization.into(),
            application: application.into(),
        });
        self
    }

    /// Open a persistent database under the platform data directory.
    pub fn app_id(self, app_id: (&str, &str, &str)) -> Self {
        self.app(app_id.0, app_id.1, app_id.2)
    }

    /// Open an ephemeral database removed when the instance is dropped.
    ///
    /// Temporary databases use the process-local template cluster cache by
    /// default, avoiding repeated `initdb` work in test suites.
    pub fn temporary(mut self) -> Self {
        self.target = Some(OliphauntTarget::Temporary);
        self
    }

    /// Control whether new databases are cloned from the process-local or
    /// embedded PGDATA template cache.
    pub fn template_cache(mut self, enabled: bool) -> Self {
        self.template_cache = enabled;
        self
    }

    /// Open an ephemeral database with a fresh `initdb`.
    ///
    /// This is a compatibility alias for
    /// `temporary().template_cache(false)`. Fresh initdb uses the bundled split
    /// WASIX `initdb` module; cached temporary databases remain the production
    /// fast path.
    pub fn fresh_temporary(self) -> Self {
        self.temporary().template_cache(false)
    }

    /// Set a PostgreSQL startup GUC for this embedded backend.
    pub fn postgres_config(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.postgres_config.insert(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs for this embedded backend.
    pub fn postgres_configs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
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

    /// Enable PostgreSQL debug logging level `0..=5` for the embedded backend.
    pub fn debug_level(mut self, level: DebugLevel) -> Self {
        self.startup_config.debug_level = Some(level);
        self
    }

    /// Use lower durability settings for ephemeral or cacheable local
    /// workloads.
    pub fn relaxed_durability(mut self, enabled: bool) -> Self {
        self.startup_config.relaxed_durability = enabled;
        self
    }

    /// Append an advanced PostgreSQL startup argument. Prefer
    /// [`postgres_config`](Self::postgres_config) for GUCs.
    pub fn startup_arg(mut self, arg: impl Into<String>) -> Self {
        self.startup_config.extra_args.push(arg.into());
        self
    }

    /// Append advanced PostgreSQL startup arguments.
    pub fn startup_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.startup_config
            .extra_args
            .extend(args.into_iter().map(Into::into));
        self
    }

    /// Load a previously dumped PGDATA tar archive before opening the database.
    pub fn load_data_dir_archive(mut self, archive: impl Into<Vec<u8>>) -> Self {
        self.load_data_dir_archive = Some(archive.into());
        self
    }

    /// Enable a bundled Postgres extension before returning the database.
    #[cfg(feature = "extensions")]
    pub fn extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Enable bundled Postgres extensions before returning the database.
    #[cfg(feature = "extensions")]
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// Install, initialize, and start the selected database.
    pub fn open(self) -> Result<Oliphaunt> {
        self.postgres_config.validate()?;
        self.startup_config.validate()?;
        let target = match self.target.clone() {
            Some(OliphauntTarget::Path(root)) => RootTarget::Path(root),
            Some(OliphauntTarget::AppId {
                qualifier,
                organization,
                application,
            }) => RootTarget::AppId {
                qualifier,
                organization,
                application,
            },
            Some(OliphauntTarget::Temporary) => RootTarget::Temporary,
            None => {
                bail!(
                    "OliphauntBuilder target is not set; call path, app_id, or temporary before open"
                )
            }
        };
        let source = if let Some(archive) = self.load_data_dir_archive.clone() {
            RootSource::DataDirArchive(archive)
        } else if self.template_cache {
            RootSource::Template
        } else {
            RootSource::FreshInitdb
        };
        #[cfg(feature = "extensions")]
        let extensions = resolve_extension_set(&self.extensions)?;
        let plan = RootPlan::new(target, source);
        #[cfg(feature = "extensions")]
        let plan = plan.with_extensions(extensions.clone(), self.postgres_config.clone());
        let prepared = prepare_root(plan)?;
        #[cfg(feature = "extensions")]
        {
            self.open_prepared_root(prepared, extensions)
        }
        #[cfg(not(feature = "extensions"))]
        {
            self.open_prepared_root(prepared)
        }
    }

    fn open_prepared_root(
        self,
        prepared: PreparedRoot,
        #[cfg(feature = "extensions")] extensions: Vec<Extension>,
    ) -> Result<Oliphaunt> {
        let PreparedRoot {
            temp_dir,
            root_lock,
            outcome,
            ..
        } = prepared;
        #[cfg(feature = "extensions")]
        let preinstalled_extensions = outcome.preinstalled_extensions.clone();
        let mut instance = Oliphaunt::new_prepared_with_config(
            outcome,
            self.postgres_config,
            self.startup_config,
        )?;
        if let Some(lock) = root_lock {
            instance.attach_root_lock(lock);
        }
        if let Some(temp_dir) = temp_dir {
            instance.attach_temp_dir(temp_dir);
        }
        #[cfg(feature = "extensions")]
        let mut instance = instance;
        #[cfg(feature = "extensions")]
        for extension in extensions {
            if preinstalled_extensions
                .iter()
                .any(|sql_name| sql_name == extension.sql_name())
            {
                instance.enable_preinstalled_extension(extension)?;
            } else {
                instance.enable_extension(extension)?;
            }
        }
        Ok(instance)
    }
}
