use std::path::PathBuf;

use anyhow::{Result, bail};

use crate::pglite::base::{
    PreparedRoot, prepare_app_root, prepare_path_root, prepare_temporary_root,
};
use crate::pglite::client::Pglite;
#[cfg(feature = "extensions")]
use crate::pglite::extensions::Extension;

/// Builder for opening persistent or temporary [`Pglite`] databases.
#[derive(Debug, Clone)]
pub struct PgliteBuilder {
    target: Option<PgliteTarget>,
    template_cache: bool,
    #[cfg(feature = "extensions")]
    extensions: Vec<Extension>,
}

#[derive(Debug, Clone)]
enum PgliteTarget {
    Path(PathBuf),
    AppId {
        qualifier: String,
        organization: String,
        application: String,
    },
    Temporary,
}

impl Default for PgliteBuilder {
    fn default() -> Self {
        Self {
            target: None,
            template_cache: true,
            #[cfg(feature = "extensions")]
            extensions: Vec::new(),
        }
    }
}

impl PgliteBuilder {
    /// Create a builder. Call [`path`](Self::path), [`app_id`](Self::app_id),
    /// or [`temporary`](Self::temporary) before [`open`](Self::open).
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a persistent database rooted at `root`.
    pub fn path(mut self, root: impl Into<PathBuf>) -> Self {
        self.target = Some(PgliteTarget::Path(root.into()));
        self
    }

    /// Open a persistent database under the platform data directory.
    pub fn app(
        mut self,
        qualifier: impl Into<String>,
        organization: impl Into<String>,
        application: impl Into<String>,
    ) -> Self {
        self.target = Some(PgliteTarget::AppId {
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
        self.target = Some(PgliteTarget::Temporary);
        self
    }

    /// Control whether new databases are cloned from the process-local or
    /// embedded PGDATA template cache.
    pub fn template_cache(mut self, enabled: bool) -> Self {
        self.template_cache = enabled;
        self
    }

    /// Open an ephemeral database without cloning the bundled PGDATA template.
    ///
    /// The current stable PGlite WASIX runtime does not include a host-driven
    /// split `initdb` runner yet, so this is only useful for opening roots that
    /// already contain a complete cluster.
    pub fn fresh_temporary(self) -> Self {
        self.temporary().template_cache(false)
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
    pub fn open(self) -> Result<Pglite> {
        let template_cache = self.template_cache;
        match self.target.clone() {
            Some(PgliteTarget::Path(root)) => {
                let prepared = prepare_path_root(root, template_cache)?;
                self.open_prepared_root(prepared)
            }
            Some(PgliteTarget::AppId {
                qualifier,
                organization,
                application,
            }) => {
                let prepared =
                    prepare_app_root(&qualifier, &organization, &application, template_cache)?;
                self.open_prepared_root(prepared)
            }
            Some(PgliteTarget::Temporary) => self.open_temporary(),
            None => {
                bail!(
                    "PgliteBuilder target is not set; call path, app_id, or temporary before open"
                )
            }
        }
    }

    fn open_temporary(self) -> Result<Pglite> {
        #[cfg(feature = "extensions")]
        let prepared = prepare_temporary_root(self.template_cache, &self.extensions)?;
        #[cfg(not(feature = "extensions"))]
        let prepared = prepare_temporary_root(self.template_cache)?;
        self.open_prepared_root(prepared)
    }

    fn open_prepared_root(self, prepared: PreparedRoot) -> Result<Pglite> {
        let PreparedRoot {
            temp_dir,
            root_lock,
            outcome,
            ..
        } = prepared;
        #[cfg(feature = "extensions")]
        let preinstalled_extensions = outcome.preinstalled_extensions.clone();
        let mut instance = Pglite::new_prepared(outcome)?;
        if let Some(lock) = root_lock {
            instance.attach_root_lock(lock);
        }
        if let Some(temp_dir) = temp_dir {
            instance.attach_temp_dir(temp_dir);
        }
        #[cfg(feature = "extensions")]
        let mut instance = instance;
        #[cfg(feature = "extensions")]
        for extension in self.extensions {
            if preinstalled_extensions
                .iter()
                .any(|sql_name| sql_name == extension.sql_name())
            {
                instance.preload_installed_extension(extension)?;
            } else {
                instance.enable_extension(extension)?;
            }
        }
        Ok(instance)
    }
}
