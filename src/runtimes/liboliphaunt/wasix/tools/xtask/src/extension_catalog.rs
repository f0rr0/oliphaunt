use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

const CATALOG_PATH: &str = "src/extensions/generated/extensions.catalog.json";
const POSTGRES_CONTRIB: &str = "src/postgres/versions/18/contrib";
const EXTERNAL_EXTENSION_RECIPE_ROOT: &str = "src/extensions/external";
const PGVECTOR_CHECKOUT: &str = "target/oliphaunt-sources/checkouts/pgvector";
const EXTERNAL_EXTENSION_CHECKOUT_ROOT: &str = "target/oliphaunt-sources/checkouts";

pub(crate) fn manifest_metadata_by_sql_name() -> Result<BTreeMap<String, ManifestExtensionMetadata>>
{
    let catalog = read_catalog()?;
    Ok(catalog
        .extensions
        .into_iter()
        .map(|extension| {
            (
                extension.sql_name.clone(),
                manifest_metadata_from_catalog_entry(extension),
            )
        })
        .collect())
}

pub(crate) fn extension_build_specs() -> Result<Vec<ExtensionBuildSpec>> {
    let catalog = read_catalog()?;
    build_specs(&catalog)
}

fn build_specs(catalog: &ExtensionCatalog) -> Result<Vec<ExtensionBuildSpec>> {
    build_specs_at(catalog, Path::new("."))
}

fn build_specs_at(
    catalog: &ExtensionCatalog,
    repository_root: &Path,
) -> Result<Vec<ExtensionBuildSpec>> {
    let mut specs = Vec::new();
    for extension in &catalog.extensions {
        let archive = format!("extensions/{}.tar.zst", extension.sql_name);
        let wasix_target = wasix_target_recipe_at(repository_root, &extension.sql_name)?;
        let mut native_support_modules = wasix_target
            .as_ref()
            .map(|target| target.native_support_modules.clone())
            .unwrap_or_default();
        native_support_modules.sort_by(|left, right| left.name.cmp(&right.name));
        let build_kind = build_kind(extension, wasix_target.as_ref())?;
        specs.push(ExtensionBuildSpec {
            id: extension.id.clone(),
            display_name: extension.display_name.clone(),
            sql_name: extension.sql_name.clone(),
            build_kind,
            source_dir: extension_source_dir(extension),
            contrib_dir: (extension.source_kind == "postgres-contrib")
                .then(|| extension_contrib_dir_name(&extension.id)),
            module_file: extension.native_module_file.clone(),
            archive,
            control_file: extension.control_file.clone(),
            native_support_modules,
            excluded_sql_extensions: wasix_target
                .as_ref()
                .map(|target| target.excluded_sql_extensions.clone())
                .unwrap_or_default(),
            staging: wasix_target.and_then(|target| target.staging),
            lifecycle: extension.lifecycle.clone(),
        });
    }
    specs.sort_by(|left, right| left.sql_name.cmp(&right.sql_name));
    Ok(specs)
}

#[derive(Debug, Clone)]
pub(crate) struct ExtensionBuildSpec {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) sql_name: String,
    pub(crate) build_kind: String,
    pub(crate) source_dir: String,
    pub(crate) contrib_dir: Option<String>,
    pub(crate) module_file: Option<String>,
    pub(crate) archive: String,
    pub(crate) control_file: Option<String>,
    pub(crate) native_support_modules: Vec<NativeSupportModuleSpec>,
    pub(crate) excluded_sql_extensions: Vec<String>,
    pub(crate) staging: Option<ExtensionStagingSpec>,
    pub(crate) lifecycle: ExtensionLifecycle,
}

#[derive(Debug, Clone)]
pub(crate) struct ManifestExtensionMetadata {
    pub(crate) source_kind: String,
    pub(crate) control_files: Vec<String>,
    pub(crate) dependencies: Vec<String>,
    pub(crate) load_order: Vec<String>,
    pub(crate) lifecycle: ManifestExtensionLifecycle,
}

#[derive(Debug, Clone)]
pub(crate) struct ManifestExtensionLifecycle {
    pub(crate) create_extension: bool,
    pub(crate) create_schema: Option<String>,
    pub(crate) load_sql: Vec<String>,
    pub(crate) post_create_sql: Vec<String>,
    pub(crate) startup_config: Vec<String>,
    pub(crate) preload_required: bool,
    pub(crate) restart_required: bool,
    pub(crate) shared_memory_required: bool,
}

fn manifest_metadata_from_catalog_entry(
    extension: ExtensionCatalogEntry,
) -> ManifestExtensionMetadata {
    ManifestExtensionMetadata {
        source_kind: extension.source_kind,
        control_files: extension.control_file.into_iter().collect(),
        dependencies: extension.dependencies,
        load_order: extension.load_order,
        lifecycle: manifest_lifecycle_from_extension(extension.lifecycle),
    }
}

fn manifest_lifecycle_from_extension(lifecycle: ExtensionLifecycle) -> ManifestExtensionLifecycle {
    ManifestExtensionLifecycle {
        create_extension: lifecycle.create_extension,
        create_schema: lifecycle.create_schema,
        load_sql: lifecycle.load_sql,
        post_create_sql: lifecycle.post_create_sql,
        startup_config: lifecycle.startup_config,
        preload_required: lifecycle.preload_required,
        restart_required: lifecycle.restart_required,
        shared_memory_required: lifecycle.shared_memory_required,
    }
}

fn wasix_target_recipe_at(
    repository_root: &Path,
    sql_name: &str,
) -> Result<Option<ExtensionTargetRecipe>> {
    let path = repository_root
        .join(EXTERNAL_EXTENSION_RECIPE_ROOT)
        .join(sql_name)
        .join("targets/wasix.toml");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let mut recipe: ExtensionTargetRecipe =
        toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    recipe
        .native_support_modules
        .sort_by(|left, right| left.name.cmp(&right.name));
    recipe.excluded_sql_extensions.sort();
    Ok(Some(recipe))
}

pub(crate) fn is_pgxs_style_build_kind(kind: &str) -> bool {
    matches!(kind, "pgxs-external" | "pgxs-sql-only")
}

pub(crate) fn is_recipe_staged_build_kind(kind: &str) -> bool {
    matches!(kind, "autotools")
}

fn build_kind(
    extension: &ExtensionCatalogEntry,
    wasix_target: Option<&ExtensionTargetRecipe>,
) -> Result<String> {
    match extension.source_kind.as_str() {
        "postgres-contrib" => Ok("postgres-contrib".to_owned()),
        "oliphaunt-other-extension" => {
            let Some(kind) = wasix_target
                .and_then(|target| target.build_kind.as_deref())
                .filter(|kind| !kind.is_empty())
            else {
                return Ok("pgxs-external".to_owned());
            };
            ensure!(
                is_pgxs_style_build_kind(kind),
                "extension {} has unsupported oliphaunt-other-extension WASIX build kind {kind}",
                extension.id
            );
            Ok(kind.to_owned())
        }
        "postgis" => {
            let kind = wasix_target
                .and_then(|target| target.build_kind.as_deref())
                .ok_or_else(|| {
                    anyhow!("extension {} has no WASIX target build_kind", extension.id)
                })?;
            ensure!(
                is_recipe_staged_build_kind(kind),
                "extension {} has unsupported recipe-staged WASIX build kind {kind}",
                extension.id
            );
            Ok(kind.to_owned())
        }
        other => bail!(
            "extension {} has unsupported source kind {other}",
            extension.id
        ),
    }
}

fn extension_source_dir(extension: &ExtensionCatalogEntry) -> String {
    extension_source_dir_for(&extension.id, &extension.source_kind)
}

fn extension_source_dir_for(id: &str, source_kind: &str) -> String {
    match source_kind {
        "postgres-contrib" => Path::new(POSTGRES_CONTRIB)
            .join(extension_contrib_dir_name(id))
            .to_string_lossy()
            .replace('\\', "/"),
        "oliphaunt-other-extension" if id == "vector" => PGVECTOR_CHECKOUT.to_owned(),
        "oliphaunt-other-extension" | "postgis" => Path::new(EXTERNAL_EXTENSION_CHECKOUT_ROOT)
            .join(id)
            .to_string_lossy()
            .replace('\\', "/"),
        _ => String::new(),
    }
}

fn extension_contrib_dir_name(id: &str) -> String {
    match id {
        "uuid_ossp" => "uuid-ossp".to_owned(),
        other => other.to_owned(),
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionCatalog {
    format_version: u32,
    #[serde(default)]
    generated_from: Vec<CatalogInput>,
    extensions: Vec<ExtensionCatalogEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct CatalogInput {
    name: String,
    path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct ExtensionTargetRecipe {
    #[serde(default)]
    build_kind: Option<String>,
    #[serde(default)]
    required_build_files: Vec<String>,
    #[serde(default)]
    required_build_globs: Vec<String>,
    #[serde(default)]
    native_support_modules: Vec<NativeSupportModuleSpec>,
    #[serde(default)]
    excluded_sql_extensions: Vec<String>,
    #[serde(default)]
    staging: Option<ExtensionStagingSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeSupportModuleSpec {
    pub(crate) name: String,
    #[serde(rename = "runtime-path", alias = "runtime_path")]
    pub(crate) runtime_path: String,
    #[serde(rename = "build-path", alias = "build_path")]
    pub(crate) build_path: String,
    #[serde(rename = "aot-file", alias = "aot_file")]
    pub(crate) aot_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExtensionStagingSpec {
    #[serde(rename = "module-source-dir", alias = "module_source_dir")]
    pub(crate) module_source_dir: Option<String>,
    #[serde(rename = "control-source", alias = "control_source")]
    pub(crate) control_source: Option<String>,
    #[serde(rename = "sql-source-dir", alias = "sql_source_dir")]
    pub(crate) sql_source_dir: Option<String>,
    #[serde(default, rename = "data-dirs", alias = "data_dirs")]
    pub(crate) data_dirs: Vec<ExtensionStagingDataDirSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExtensionStagingDataDirSpec {
    pub(crate) source: String,
    pub(crate) destination: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionCatalogEntry {
    id: String,
    sql_name: String,
    rust_constant: String,
    display_name: String,
    source_kind: String,
    upstream_import_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_import_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_export: Option<String>,
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control: Option<ControlMetadata>,
    dependencies: Vec<String>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
    tests: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_module_file: Option<String>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ControlMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    default_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_pathname: Option<String>,
    requires: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relocatable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct ExtensionLifecycle {
    pub(crate) create_extension: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) create_schema: Option<String>,
    pub(crate) load_sql: Vec<String>,
    pub(crate) post_create_sql: Vec<String>,
    pub(crate) startup_config: Vec<String>,
    pub(crate) preload_required: bool,
    pub(crate) restart_required: bool,
    pub(crate) shared_memory_required: bool,
}

fn read_catalog() -> Result<ExtensionCatalog> {
    let text = fs::read_to_string(CATALOG_PATH).context("read generated extension catalog")?;
    serde_json::from_str(&text).context("parse generated extension catalog")
}
