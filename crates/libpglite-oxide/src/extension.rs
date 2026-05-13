use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;

use crate::error::{Error, Result};

/// Native PostgreSQL 18 extension that can be explicitly selected by an app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Extension {
    /// PostgreSQL `amcheck`.
    Amcheck,
    /// PostgreSQL `auto_explain`.
    AutoExplain,
    /// PostgreSQL `bloom`.
    Bloom,
    /// PostgreSQL `btree_gin`.
    BtreeGin,
    /// PostgreSQL `btree_gist`.
    BtreeGist,
    /// PostgreSQL `citext`.
    Citext,
    /// PostgreSQL `cube`.
    Cube,
    /// PostgreSQL `dict_int`.
    DictInt,
    /// PostgreSQL `dict_xsyn`.
    DictXsyn,
    /// PostgreSQL `earthdistance`.
    Earthdistance,
    /// PostgreSQL `file_fdw`.
    FileFdw,
    /// PostgreSQL `fuzzystrmatch`.
    Fuzzystrmatch,
    /// PostgreSQL `hstore`.
    Hstore,
    /// PostgreSQL `intarray`.
    Intarray,
    /// PostgreSQL `isn`.
    Isn,
    /// PostgreSQL `lo`.
    Lo,
    /// PostgreSQL `ltree`.
    Ltree,
    /// PostgreSQL `pageinspect`.
    Pageinspect,
    /// PostgreSQL `pg_buffercache`.
    PgBuffercache,
    /// PostgreSQL `pg_freespacemap`.
    PgFreespacemap,
    /// PostgreSQL `pg_ivm`.
    PgIvm,
    /// PostgreSQL `pg_surgery`.
    PgSurgery,
    /// PostgreSQL `pg_textsearch`.
    PgTextsearch,
    /// PostgreSQL `pg_trgm`.
    PgTrgm,
    /// PostgreSQL `pg_uuidv7`.
    PgUuidv7,
    /// PostgreSQL `pg_visibility`.
    PgVisibility,
    /// PostgreSQL `pg_walinspect`.
    PgWalinspect,
    /// PostgreSQL `pgtap`.
    Pgtap,
    /// PostgreSQL `seg`.
    Seg,
    /// PostgreSQL `tablefunc`.
    Tablefunc,
    /// PostgreSQL `tcn`.
    Tcn,
    /// PostgreSQL `tsm_system_rows`.
    TsmSystemRows,
    /// PostgreSQL `tsm_system_time`.
    TsmSystemTime,
    /// PostgreSQL `unaccent`.
    Unaccent,
    /// PostgreSQL `vector`.
    Vector,
}

impl Extension {
    /// All extensions currently supported by the native PostgreSQL 18 lane.
    pub const ALL_PG18_SUPPORTED: &'static [Self] = &[
        Self::Amcheck,
        Self::AutoExplain,
        Self::Bloom,
        Self::BtreeGin,
        Self::BtreeGist,
        Self::Citext,
        Self::Cube,
        Self::DictInt,
        Self::DictXsyn,
        Self::Earthdistance,
        Self::FileFdw,
        Self::Fuzzystrmatch,
        Self::Hstore,
        Self::Intarray,
        Self::Isn,
        Self::Lo,
        Self::Ltree,
        Self::Pageinspect,
        Self::PgBuffercache,
        Self::PgFreespacemap,
        Self::PgIvm,
        Self::PgSurgery,
        Self::PgTextsearch,
        Self::PgTrgm,
        Self::PgUuidv7,
        Self::PgVisibility,
        Self::PgWalinspect,
        Self::Pgtap,
        Self::Seg,
        Self::Tablefunc,
        Self::Tcn,
        Self::TsmSystemRows,
        Self::TsmSystemTime,
        Self::Unaccent,
        Self::Vector,
    ];

    /// SQL extension name used by `CREATE EXTENSION`.
    pub const fn sql_name(self) -> &'static str {
        match self {
            Self::Amcheck => "amcheck",
            Self::AutoExplain => "auto_explain",
            Self::Bloom => "bloom",
            Self::BtreeGin => "btree_gin",
            Self::BtreeGist => "btree_gist",
            Self::Citext => "citext",
            Self::Cube => "cube",
            Self::DictInt => "dict_int",
            Self::DictXsyn => "dict_xsyn",
            Self::Earthdistance => "earthdistance",
            Self::FileFdw => "file_fdw",
            Self::Fuzzystrmatch => "fuzzystrmatch",
            Self::Hstore => "hstore",
            Self::Intarray => "intarray",
            Self::Isn => "isn",
            Self::Lo => "lo",
            Self::Ltree => "ltree",
            Self::Pageinspect => "pageinspect",
            Self::PgBuffercache => "pg_buffercache",
            Self::PgFreespacemap => "pg_freespacemap",
            Self::PgIvm => "pg_ivm",
            Self::PgSurgery => "pg_surgery",
            Self::PgTextsearch => "pg_textsearch",
            Self::PgTrgm => "pg_trgm",
            Self::PgUuidv7 => "pg_uuidv7",
            Self::PgVisibility => "pg_visibility",
            Self::PgWalinspect => "pg_walinspect",
            Self::Pgtap => "pgtap",
            Self::Seg => "seg",
            Self::Tablefunc => "tablefunc",
            Self::Tcn => "tcn",
            Self::TsmSystemRows => "tsm_system_rows",
            Self::TsmSystemTime => "tsm_system_time",
            Self::Unaccent => "unaccent",
            Self::Vector => "vector",
        }
    }

    /// Native module filename expected under `lib/postgresql`.
    pub fn native_module_file(self) -> Option<String> {
        let stem = match self {
            Self::AutoExplain => "auto_explain",
            Self::Amcheck => "amcheck",
            Self::Bloom => "bloom",
            Self::BtreeGin => "btree_gin",
            Self::BtreeGist => "btree_gist",
            Self::Citext => "citext",
            Self::Cube => "cube",
            Self::DictInt => "dict_int",
            Self::DictXsyn => "dict_xsyn",
            Self::Earthdistance => "earthdistance",
            Self::FileFdw => "file_fdw",
            Self::Fuzzystrmatch => "fuzzystrmatch",
            Self::Hstore => "hstore",
            Self::Intarray => "_int",
            Self::Isn => "isn",
            Self::Lo => "lo",
            Self::Ltree => "ltree",
            Self::Pageinspect => "pageinspect",
            Self::PgBuffercache => "pg_buffercache",
            Self::PgFreespacemap => "pg_freespacemap",
            Self::PgIvm => "pg_ivm",
            Self::PgSurgery => "pg_surgery",
            Self::PgTextsearch => "pg_textsearch",
            Self::PgTrgm => "pg_trgm",
            Self::PgUuidv7 => "pg_uuidv7",
            Self::PgVisibility => "pg_visibility",
            Self::PgWalinspect => "pg_walinspect",
            Self::Pgtap => "pgtap",
            Self::Seg => "seg",
            Self::Tablefunc => "tablefunc",
            Self::Tcn => "tcn",
            Self::TsmSystemRows => "tsm_system_rows",
            Self::TsmSystemTime => "tsm_system_time",
            Self::Unaccent => "unaccent",
            Self::Vector => "vector",
        };
        Some(format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    }

    /// Whether this extension has a `CREATE EXTENSION` control file.
    pub const fn creates_extension(self) -> bool {
        !matches!(self, Self::AutoExplain)
    }

    /// SQL extension dependencies that must be materialized with this extension.
    pub const fn dependencies(self) -> &'static [Extension] {
        match self {
            Self::Earthdistance => &[Self::Cube],
            _ => &[],
        }
    }

    /// Resolve an extension by SQL name.
    pub fn by_sql_name(sql_name: &str) -> Option<Self> {
        Self::ALL_PG18_SUPPORTED
            .iter()
            .copied()
            .find(|extension| extension.sql_name() == sql_name)
    }
}

/// Stable extension-pack identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExtensionPackId(String);

impl ExtensionPackId {
    /// Create an extension-pack identifier.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrow the identifier as a string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ExtensionPackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Where an extension pack comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionPackSource {
    /// Pack is built into the native SDK/artifact.
    BuiltIn,
    /// Pack is loaded from a manifest path.
    ManifestPath(PathBuf),
}

/// How the pack is loaded by a platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExtensionLoading {
    /// Static symbol registry. This is the portable mobile-first path.
    StaticRegistry,
    /// Signed dynamic libraries from manifest-approved paths.
    SignedDynamic,
}

/// Explicit extension pack selected by the application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionPack {
    /// Pack identifier.
    pub id: ExtensionPackId,
    /// Pack source.
    pub source: ExtensionPackSource,
    /// Loading policy.
    pub loading: ExtensionLoading,
    /// Extensions made available by the pack.
    pub extensions: Vec<Extension>,
}

impl ExtensionPack {
    /// Core native extension pack.
    pub fn core() -> Self {
        Self::built_in_with_extensions(
            "core",
            Extension::ALL_PG18_SUPPORTED
                .iter()
                .copied()
                .filter(|extension| *extension != Extension::Vector)
                .collect(),
        )
    }

    /// Vector extension pack.
    pub fn vector() -> Self {
        Self::built_in_with_extensions("vector", vec![Extension::Vector])
    }

    /// Search extension pack.
    pub fn search() -> Self {
        Self::built_in_with_extensions(
            "search",
            vec![
                Extension::DictInt,
                Extension::DictXsyn,
                Extension::PgTextsearch,
                Extension::PgTrgm,
                Extension::Unaccent,
            ],
        )
    }

    /// Geo extension pack.
    pub fn geo() -> Self {
        Self::built_in_with_extensions("geo", vec![Extension::Cube, Extension::Earthdistance])
    }

    /// Built-in static pack with no predeclared extensions.
    pub fn built_in(id: impl Into<String>) -> Self {
        Self::built_in_with_extensions(id, Vec::new())
    }

    /// Built-in static pack with a concrete extension list.
    pub fn built_in_with_extensions(id: impl Into<String>, extensions: Vec<Extension>) -> Self {
        Self {
            id: ExtensionPackId::new(id),
            source: ExtensionPackSource::BuiltIn,
            loading: ExtensionLoading::StaticRegistry,
            extensions,
        }
    }

    /// Signed dynamic pack from a manifest path.
    pub fn signed_dynamic_manifest(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: ExtensionPackId::new(id),
            source: ExtensionPackSource::ManifestPath(path.into()),
            loading: ExtensionLoading::SignedDynamic,
            extensions: Vec::new(),
        }
    }
}

pub(crate) fn resolve_extensions(
    direct_extensions: &[Extension],
    packs: &[ExtensionPack],
) -> Result<Vec<Extension>> {
    for pack in packs {
        if matches!(pack.source, ExtensionPackSource::ManifestPath(_)) {
            return Err(Error::Engine(format!(
                "extension pack '{}' uses a manifest path; signed dynamic packs are not implemented yet",
                pack.id
            )));
        }
    }

    let mut requested = Vec::new();
    requested.extend_from_slice(direct_extensions);
    for pack in packs {
        requested.extend_from_slice(&pack.extensions);
    }

    let mut resolved = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for extension in requested {
        visit_extension(extension, &mut visiting, &mut visited, &mut resolved)?;
    }
    Ok(resolved)
}

fn visit_extension(
    extension: Extension,
    visiting: &mut BTreeSet<Extension>,
    visited: &mut BTreeSet<Extension>,
    resolved: &mut Vec<Extension>,
) -> Result<()> {
    if visited.contains(&extension) {
        return Ok(());
    }
    if !visiting.insert(extension) {
        return Err(Error::Engine(format!(
            "cyclic native extension dependency involving '{}'",
            extension.sql_name()
        )));
    }
    for dependency in extension.dependencies() {
        visit_extension(*dependency, visiting, visited, resolved)?;
    }
    visiting.remove(&extension);
    visited.insert(extension);
    resolved.push(extension);
    Ok(())
}

pub(crate) fn extension_sql_file_belongs(sql_name: &str, file_name: &str) -> bool {
    file_name == format!("{sql_name}.control")
        || file_name == format!("{sql_name}.sql")
        || (file_name.starts_with(&format!("{sql_name}--")) && file_name.ends_with(".sql"))
        || (sql_name == "pgtap"
            && (file_name.starts_with("pgtap-core")
                || file_name.starts_with("pgtap-schema")
                || file_name == "uninstall_pgtap.sql"))
}

pub(crate) fn extension_data_files(extension: Extension) -> &'static [&'static str] {
    match extension {
        Extension::Unaccent => &["tsearch_data/unaccent.rules"],
        Extension::DictXsyn => &["tsearch_data/xsyn_sample.rules"],
        _ => &[],
    }
}
