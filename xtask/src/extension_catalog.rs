use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

const CATALOG_PATH: &str = "assets/generated/extensions.catalog.json";
const BUILD_PLAN_PATH: &str = "assets/generated/extensions.build-plan.json";
const CONTRIB_BUILD_PLAN_PATH: &str = "assets/generated/contrib-build.tsv";
const PGXS_BUILD_PLAN_PATH: &str = "assets/generated/pgxs-build.tsv";
const PROMOTION_CONFIG_PATH: &str = "assets/extensions.promoted.toml";
const SMOKE_CONFIG_PATH: &str = "assets/extensions.smoke.toml";
const PGLITE_REPL_EXTENSIONS: &str = "assets/checkouts/pglite/docs/repl/allExtensions.ts";
const PGLITE_DOCS_EXTENSIONS: &str = "assets/checkouts/pglite/docs/extensions/extensions.data.ts";
const PGLITE_PACKAGE_JSON: &str = "assets/checkouts/pglite/packages/pglite/package.json";
const PGLITE_CONTRIB_SRC: &str = "assets/checkouts/pglite/packages/pglite/src/contrib";
const PGLITE_TESTS: &str = "assets/checkouts/pglite/packages/pglite/tests";
const PGLITE_POSTGIS_TESTS: &str = "assets/checkouts/pglite/packages/pglite-postgis/tests";
const POSTGRES_CONTRIB: &str = "assets/checkouts/postgres-pglite/contrib";
const POSTGRES_OTHER_EXTENSIONS: &str = "assets/checkouts/postgres-pglite/pglite/other_extensions";
const PGVECTOR_CHECKOUT: &str = "assets/checkouts/pgvector";
const EXTERNAL_EXTENSION_CHECKOUT_ROOT: &str = "assets/checkouts";
const ASSET_MANIFEST: &str = "target/pglite-oxide/assets/manifest.json";

pub(crate) fn extensions(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("discover") => {
            let catalog = discover_catalog()?;
            validate_catalog(&catalog)?;
            let text = serde_json::to_string_pretty(&catalog).context("serialize catalog")?;
            if args.iter().any(|arg| arg == "--write") {
                write_catalog(&text)?;
            } else {
                println!("{text}");
            }
            Ok(())
        }
        Some("generate") => {
            let catalog = discover_catalog()?;
            validate_catalog(&catalog)?;
            let text = serde_json::to_string_pretty(&catalog).context("serialize catalog")?;
            write_catalog(&text)?;
            write_build_plan_files(&catalog)?;
            write_generated_extension_api(&catalog)?;
            Ok(())
        }
        Some("build-plan") => {
            let catalog = discover_catalog()?;
            validate_catalog(&catalog)?;
            if args.iter().any(|arg| arg == "--write") {
                write_build_plan_files(&catalog)
            } else if args.iter().any(|arg| arg == "--check") {
                check_build_plan_file(true)
            } else {
                let plan = build_plan(&catalog)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&plan)
                        .context("serialize extension build plan")?
                );
                Ok(())
            }
        }
        Some("check") => {
            check_catalog_file(true)?;
            check_build_plan_file(true)
        }
        Some(other) => bail!("unknown extensions subcommand: {other}"),
        None => {
            bail!(
                "usage: cargo run -p xtask -- extensions <discover|generate|build-plan|check> [--write|--check]"
            )
        }
    }
}

pub(crate) fn check_catalog_file(strict: bool) -> Result<()> {
    let catalog = discover_catalog()?;
    validate_catalog(&catalog)?;
    let expected = serde_json::to_string_pretty(&catalog).context("serialize extension catalog")?;
    let path = Path::new(CATALOG_PATH);
    if !path.exists() {
        if strict {
            bail!(
                "generated extension catalog is missing at {}; run `cargo run -p xtask -- extensions discover --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated extension catalog is missing at {}",
            path.display()
        );
        return Ok(());
    }
    let actual = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if !extension_catalog_text_matches_source_control(&actual, &expected)? {
        if strict {
            bail!(
                "generated extension catalog is stale at {}; run `cargo run -p xtask -- extensions discover --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated extension catalog is stale at {}",
            path.display()
        );
    }
    Ok(())
}

pub(crate) fn check_build_plan_file(strict: bool) -> Result<()> {
    let catalog = discover_catalog()?;
    validate_catalog(&catalog)?;
    let expected = build_plan_texts(&catalog)?;
    for (path, text, command) in [
        (
            BUILD_PLAN_PATH,
            expected.json.as_str(),
            "cargo run -p xtask -- extensions build-plan --write",
        ),
        (
            CONTRIB_BUILD_PLAN_PATH,
            expected.contrib_tsv.as_str(),
            "cargo run -p xtask -- extensions build-plan --write",
        ),
        (
            PGXS_BUILD_PLAN_PATH,
            expected.pgxs_tsv.as_str(),
            "cargo run -p xtask -- extensions build-plan --write",
        ),
    ] {
        let path = Path::new(path);
        if !path.exists() {
            if strict {
                bail!(
                    "generated extension build plan is missing at {}; run `{command}`",
                    path.display()
                );
            }
            eprintln!(
                "warning: generated extension build plan is missing at {}",
                path.display()
            );
            continue;
        }
        let actual =
            fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let matches = if path == Path::new(BUILD_PLAN_PATH) {
            extension_build_plan_text_matches_source_control(&actual, text)?
        } else {
            actual.trim_end() == text.trim_end()
        };
        if !matches {
            if strict {
                bail!(
                    "generated extension build plan is stale at {}; run `{command}`",
                    path.display()
                );
            }
            eprintln!(
                "warning: generated extension build plan is stale at {}",
                path.display()
            );
        }
    }
    Ok(())
}

fn extension_catalog_text_matches_source_control(actual: &str, expected: &str) -> Result<bool> {
    let actual: serde_json::Value =
        serde_json::from_str(actual).context("parse generated extension catalog")?;
    let expected: serde_json::Value =
        serde_json::from_str(expected).context("parse expected extension catalog")?;
    Ok(normalize_extension_catalog_for_source_control(actual)
        == normalize_extension_catalog_for_source_control(expected))
}

fn extension_build_plan_text_matches_source_control(actual: &str, expected: &str) -> Result<bool> {
    let actual: serde_json::Value =
        serde_json::from_str(actual).context("parse generated extension build plan")?;
    let expected: serde_json::Value =
        serde_json::from_str(expected).context("parse expected extension build plan")?;
    Ok(normalize_generated_inputs_for_source_control(actual)
        == normalize_generated_inputs_for_source_control(expected))
}

fn normalize_extension_catalog_for_source_control(value: serde_json::Value) -> serde_json::Value {
    let mut value = normalize_generated_inputs_for_source_control(value);
    if let Some(extensions) = value
        .get_mut("extensions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for extension in extensions {
            if let Some(promotion) = extension
                .get_mut("promotion")
                .and_then(serde_json::Value::as_object_mut)
            {
                promotion.remove("packaged");
                promotion.remove("promoted");
                promotion.remove("module-sha256");
            }
        }
    }
    value
}

fn normalize_generated_inputs_for_source_control(
    mut value: serde_json::Value,
) -> serde_json::Value {
    if let Some(inputs) = value
        .get_mut("generated-from")
        .and_then(serde_json::Value::as_array_mut)
    {
        inputs.retain(|input| {
            input.get("name").and_then(serde_json::Value::as_str) != Some("asset-manifest-evidence")
        });
    }
    value
}

pub(crate) fn manifest_metadata_by_sql_name() -> Result<BTreeMap<String, ManifestExtensionMetadata>>
{
    let catalog = discover_catalog()?;
    validate_catalog(&catalog)?;
    Ok(catalog
        .extensions
        .into_iter()
        .map(|extension| {
            (
                extension.sql_name.clone(),
                ManifestExtensionMetadata {
                    source_kind: extension.source_kind,
                    control_files: extension.control_file.into_iter().collect(),
                    dependencies: extension.dependencies,
                    native_dependencies: extension.native_dependencies,
                    load_order: extension.load_order,
                    lifecycle: ManifestExtensionLifecycle {
                        create_extension: extension.lifecycle.create_extension,
                        create_schema: extension.lifecycle.create_schema,
                        load_sql: extension.lifecycle.load_sql,
                        post_create_sql: extension.lifecycle.post_create_sql,
                        startup_config: extension.lifecycle.startup_config,
                        preload_required: extension.lifecycle.preload_required,
                        restart_required: extension.lifecycle.restart_required,
                        shared_memory_required: extension.lifecycle.shared_memory_required,
                    },
                    smoke_status: ManifestExtensionSmokeStatus {
                        promoted: extension.promotion.promoted,
                        direct: extension.smoke.direct,
                        server: extension.smoke.server,
                        restart: extension.smoke.restart,
                        dump_restore: extension.smoke.dump_restore,
                    },
                },
            )
        })
        .collect())
}

pub(crate) fn promoted_build_specs() -> Result<Vec<PromotedExtensionBuildSpec>> {
    let catalog = discover_catalog()?;
    validate_catalog(&catalog)?;
    build_specs(&catalog)
}

pub(crate) fn build_plan_contrib_path() -> &'static str {
    CONTRIB_BUILD_PLAN_PATH
}

pub(crate) fn build_plan_pgxs_path() -> &'static str {
    PGXS_BUILD_PLAN_PATH
}

fn build_specs(catalog: &ExtensionCatalog) -> Result<Vec<PromotedExtensionBuildSpec>> {
    let mut specs = Vec::new();
    for extension in catalog
        .extensions
        .iter()
        .filter(|extension| extension.promotion.requested)
    {
        let archive = extension
            .promotion
            .archive
            .clone()
            .unwrap_or_else(|| format!("extensions/{}.tar.zst", extension.sql_name));
        specs.push(PromotedExtensionBuildSpec {
            id: extension.id.clone(),
            display_name: extension.display_name.clone(),
            sql_name: extension.sql_name.clone(),
            source_kind: extension.source_kind.clone(),
            build_kind: build_kind(extension).to_owned(),
            source_dir: extension_source_dir(extension),
            make_args: pgxs_make_args(extension),
            contrib_dir: (extension.source_kind == "postgres-contrib")
                .then(|| extension_contrib_dir_name(&extension.id)),
            module_file: extension.native_module_file.clone(),
            archive,
            control_file: extension.control_file.clone(),
            stable: extension.promotion.stable,
            dependencies: extension.dependencies.clone(),
            native_dependencies: extension.native_dependencies.clone(),
            load_order: extension.load_order.clone(),
            lifecycle: extension.lifecycle.clone(),
            smoke: extension.smoke.clone(),
            tests: extension.tests.clone(),
        });
    }
    specs.sort_by(|left, right| left.sql_name.cmp(&right.sql_name));
    Ok(specs)
}

#[derive(Debug, Clone)]
pub(crate) struct PromotedExtensionBuildSpec {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) sql_name: String,
    pub(crate) source_kind: String,
    pub(crate) build_kind: String,
    pub(crate) source_dir: String,
    pub(crate) make_args: Vec<String>,
    pub(crate) contrib_dir: Option<String>,
    pub(crate) module_file: Option<String>,
    pub(crate) archive: String,
    pub(crate) control_file: Option<String>,
    pub(crate) stable: bool,
    pub(crate) dependencies: Vec<String>,
    pub(crate) native_dependencies: Vec<String>,
    pub(crate) load_order: Vec<String>,
    pub(crate) lifecycle: ExtensionLifecycle,
    pub(crate) smoke: ExtensionSmokeEvidence,
    pub(crate) tests: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ManifestExtensionMetadata {
    pub(crate) source_kind: String,
    pub(crate) control_files: Vec<String>,
    pub(crate) dependencies: Vec<String>,
    pub(crate) native_dependencies: Vec<String>,
    pub(crate) load_order: Vec<String>,
    pub(crate) lifecycle: ManifestExtensionLifecycle,
    pub(crate) smoke_status: ManifestExtensionSmokeStatus,
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

#[derive(Debug, Clone)]
pub(crate) struct ManifestExtensionSmokeStatus {
    pub(crate) promoted: bool,
    pub(crate) direct: String,
    pub(crate) server: String,
    pub(crate) restart: String,
    pub(crate) dump_restore: String,
}

fn write_catalog(text: &str) -> Result<()> {
    let path = Path::new(CATALOG_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
}

fn write_build_plan_files(catalog: &ExtensionCatalog) -> Result<()> {
    let texts = build_plan_texts(catalog)?;
    for (path, text) in [
        (BUILD_PLAN_PATH, texts.json),
        (CONTRIB_BUILD_PLAN_PATH, texts.contrib_tsv),
        (PGXS_BUILD_PLAN_PATH, texts.pgxs_tsv),
    ] {
        let path = Path::new(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, text).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}

fn build_plan_texts(catalog: &ExtensionCatalog) -> Result<BuildPlanTexts> {
    let plan = build_plan(catalog)?;
    let json =
        serde_json::to_string_pretty(&plan).context("serialize extension build plan")? + "\n";
    let mut contrib_tsv = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\tstable\n".to_owned();
    let mut pgxs_tsv =
        "# id\tsql_name\tsource_dir\tmodule_file\tarchive\tstable\tmake_args\n".to_owned();
    for extension in &plan.extensions {
        match extension.build_kind.as_str() {
            "postgres-contrib" => {
                let contrib_dir = extension.contrib_dir.as_deref().ok_or_else(|| {
                    anyhow!("contrib extension {} has no contrib_dir", extension.id)
                })?;
                contrib_tsv.push_str(&format!(
                    "{}\t{}\t{}\t{}\t{}\t{}\n",
                    extension.id,
                    extension.sql_name,
                    contrib_dir,
                    extension.module_file.as_deref().unwrap_or("-"),
                    extension.archive,
                    extension.stable
                ));
            }
            "pgxs-external" => {
                pgxs_tsv.push_str(&format!(
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                    extension.id,
                    extension.sql_name,
                    extension.source_dir,
                    extension.module_file.as_deref().unwrap_or("-"),
                    extension.archive,
                    extension.stable,
                    shell_words(&extension.make_args)
                ));
            }
            "postgis" => {}
            other => bail!(
                "extension {} has unsupported build kind {other}",
                extension.id
            ),
        }
    }
    Ok(BuildPlanTexts {
        json,
        contrib_tsv,
        pgxs_tsv,
    })
}

fn build_plan(catalog: &ExtensionCatalog) -> Result<ExtensionBuildPlan> {
    let specs = build_specs(catalog)?;
    Ok(ExtensionBuildPlan {
        format_version: 1,
        generated_from: vec![
            CatalogInput {
                name: "extension-catalog".to_owned(),
                path: CATALOG_PATH.to_owned(),
            },
            CatalogInput {
                name: "promotion-config".to_owned(),
                path: PROMOTION_CONFIG_PATH.to_owned(),
            },
            CatalogInput {
                name: "asset-manifest-evidence".to_owned(),
                path: ASSET_MANIFEST.to_owned(),
            },
        ],
        extensions: specs
            .into_iter()
            .map(|spec| ExtensionBuildPlanEntry {
                id: spec.id,
                sql_name: spec.sql_name,
                display_name: spec.display_name,
                source_kind: spec.source_kind,
                build_kind: spec.build_kind,
                source_dir: spec.source_dir,
                make_args: spec.make_args,
                contrib_dir: spec.contrib_dir,
                module_file: spec.module_file,
                archive: spec.archive,
                control_file: spec.control_file,
                stable: spec.stable,
                dependencies: spec.dependencies,
                native_dependencies: spec.native_dependencies,
                load_order: spec.load_order,
                lifecycle: spec.lifecycle,
                smoke: spec.smoke,
                tests: spec.tests,
            })
            .collect(),
    })
}

fn write_generated_extension_api(catalog: &ExtensionCatalog) -> Result<()> {
    let promoted = promoted_extensions(catalog);
    let candidates = packaged_extensions(catalog);
    let mut text = String::new();
    text.push_str("// @generated by `cargo run -p xtask -- extensions generate`\n\n");
    text.push_str("use super::{Extension, ExtensionSetup};\n\n");
    text.push_str("const EMPTY_SQL_NAMES: &[&str] = &[];\n");
    text.push_str("const EMPTY_SQL: &[&str] = &[];\n\n");

    for extension in &candidates {
        let prefix = extension.rust_constant.as_str();
        let candidate_const = format!("CANDIDATE_{prefix}");
        let dependencies = api_dependencies(extension);
        if dependencies.is_empty() {
            text.push_str(&format!(
                "const {candidate_const}_DEPENDENCIES: &[&str] = EMPTY_SQL_NAMES;\n"
            ));
        } else {
            text.push_str(&format!(
                "const {candidate_const}_DEPENDENCIES: &[&str] = &{};\n",
                rust_string_array(&dependencies)
            ));
        }
        if extension.lifecycle.load_sql.is_empty() {
            text.push_str(&format!(
                "const {candidate_const}_LOAD_SQL: &[&str] = EMPTY_SQL;\n"
            ));
        } else {
            text.push_str(&format!(
                "const {candidate_const}_LOAD_SQL: &[&str] = &{};\n",
                rust_string_array(&extension.lifecycle.load_sql)
            ));
        }
        if extension.lifecycle.post_create_sql.is_empty() {
            text.push_str(&format!(
                "const {candidate_const}_POST_CREATE_SQL: &[&str] = EMPTY_SQL;\n"
            ));
        } else {
            text.push_str(&format!(
                "const {candidate_const}_POST_CREATE_SQL: &[&str] = &{};\n",
                rust_string_array(&extension.lifecycle.post_create_sql)
            ));
        }
        text.push('\n');
        let archive = extension
            .promotion
            .archive
            .as_deref()
            .ok_or_else(|| anyhow!("packaged extension {} is missing archive", extension.id))?;
        text.push_str(&format!(
            "pub(crate) const {candidate_const}: Extension = Extension::new(\n    {:?},\n    {:?},\n    {:?},\n    {},\n    {},\n    {candidate_const}_DEPENDENCIES,\n    ExtensionSetup::new(\n        {},\n        {},\n        {candidate_const}_LOAD_SQL,\n        {candidate_const}_POST_CREATE_SQL,\n    ),\n);\n\n",
            extension.display_name,
            extension.sql_name,
            archive,
            option_string_literal(extension.native_module_file.as_deref()),
            option_string_literal(
                extension
                    .native_module_file
                    .as_ref()
                    .map(|_| format!("extension:{}", extension.sql_name))
                    .as_deref()
            ),
            extension.lifecycle.create_extension,
            option_string_literal(extension.lifecycle.create_schema.as_deref()),
        ));
    }

    for extension in &promoted {
        let prefix = extension.rust_constant.as_str();
        text.push_str(&format!(
            "pub const {prefix}: Extension = CANDIDATE_{prefix};\n"
        ));
    }
    if !promoted.is_empty() {
        text.push('\n');
    }

    let all = promoted
        .iter()
        .map(|extension| extension.rust_constant.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    text.push_str(&format!("pub const ALL: &[Extension] = &[{all}];\n"));
    let candidates_all = candidates
        .iter()
        .map(|extension| format!("CANDIDATE_{}", extension.rust_constant))
        .collect::<Vec<_>>()
        .join(", ");
    text.push_str(&format!(
        "pub(crate) const CANDIDATES: &[Extension] = &[{candidates_all}];\n"
    ));

    fs::write("src/pglite/generated_extensions.rs", text)
        .context("write src/pglite/generated_extensions.rs")
}

fn promoted_extensions(catalog: &ExtensionCatalog) -> Vec<&ExtensionCatalogEntry> {
    catalog
        .extensions
        .iter()
        .filter(|extension| extension.promotion.promoted)
        .collect()
}

fn packaged_extensions(catalog: &ExtensionCatalog) -> Vec<&ExtensionCatalogEntry> {
    catalog
        .extensions
        .iter()
        .filter(|extension| {
            extension.promotion.requested
                && extension.promotion.packaged
                && extension.promotion.archive.is_some()
        })
        .collect()
}

fn rust_string_array(values: &[String]) -> String {
    let items = values
        .iter()
        .map(|value| format!("{value:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{items}]")
}

fn option_string_literal(value: Option<&str>) -> String {
    value
        .map(|value| format!("Some({value:?})"))
        .unwrap_or_else(|| "None".to_owned())
}

fn discover_catalog() -> Result<ExtensionCatalog> {
    let repl = parse_repl_exports(Path::new(PGLITE_REPL_EXTENSIONS))?;
    let docs = parse_docs_catalog(Path::new(PGLITE_DOCS_EXTENSIONS))?;
    let package_exports = parse_package_exports(Path::new(PGLITE_PACKAGE_JSON))?;
    let promotion_requests = parse_promotion_config(Path::new(PROMOTION_CONFIG_PATH))?;
    let smoke_evidence = parse_smoke_config(Path::new(SMOKE_CONFIG_PATH))?;
    let packaged = parse_packaged_manifest(Path::new(ASSET_MANIFEST))?;
    let submodules = parse_other_extension_submodules(Path::new(POSTGRES_OTHER_EXTENSIONS))?;

    let mut ids = BTreeSet::new();
    ids.extend(repl.keys().cloned());
    ids.extend(docs.keys().filter(|id| id.as_str() != "live").cloned());

    let mut entries = Vec::new();
    for id in ids {
        let repl_export = repl.get(&id);
        let docs_entry = docs.get(&id);
        let sql_name = discover_sql_name(&id, repl_export, docs_entry)?;
        let control_file = discover_control_file(&id, &sql_name, repl_export);
        let control = control_file
            .as_ref()
            .filter(|path| path.is_file())
            .map(|path| parse_control_file(path))
            .transpose()?;
        let tests = discover_test_paths(&id);
        let lifecycle = classify_lifecycle(&id, control.as_ref());
        let dependencies = discover_dependencies(&id, control.as_ref());
        let source_kind = classify_source_kind(&id, repl_export, docs_entry);
        let native_module_file =
            discover_native_module_file(&id, &sql_name, source_kind, control.as_ref())?;
        let request = promotion_requests
            .get(id.as_str())
            .or_else(|| promotion_requests.get(sql_name.as_str()));
        let asset = packaged.get(sql_name.as_str());
        let archive = asset
            .and_then(|asset| asset.archive.clone())
            .or_else(|| request.and_then(|request| request.archive.clone()))
            .or_else(|| request.map(|_| format!("extensions/{sql_name}.tar.zst")));
        let requested = request.map(|request| request.build).unwrap_or(false);
        let stable = request.map(|request| request.stable).unwrap_or(false);
        let blocker = request.and_then(|request| request.blocker.clone());
        let packaged = asset.is_some();
        let asset_stable = asset.map(|asset| asset.stable).unwrap_or(false);
        let smoke = smoke_evidence
            .get(id.as_str())
            .or_else(|| smoke_evidence.get(sql_name.as_str()))
            .cloned()
            .unwrap_or_default();
        let promotion = PromotionStatus {
            configured: request.is_some(),
            requested,
            packaged,
            promoted: requested
                && stable
                && packaged
                && asset_stable
                && smoke.direct == "passed"
                && smoke.server == "passed"
                && smoke.restart == "passed",
            stable,
            archive,
            module_sha256: asset.and_then(|asset| asset.module_sha256.clone()),
            blocker,
        };
        let mut notes = Vec::new();
        if id == "live" {
            notes.push("PGlite plugin, not a SQL extension".to_owned());
        }
        if control_file.as_ref().is_none_or(|path| !path.is_file())
            && lifecycle.create_extension
            && source_kind != "pglite-plugin"
        {
            notes.push("control file unavailable in current checkout; source submodule may not be initialized".to_owned());
        }
        if let Some(submodule) = submodules.get(&id) {
            notes.push(format!(
                "postgres-pglite submodule {} pinned at {}",
                submodule.url, submodule.commit
            ));
        }
        if let Some(blocker) = &promotion.blocker {
            notes.push(format!("promotion blocker: {blocker}"));
        }

        entries.push(ExtensionCatalogEntry {
            id: id.clone(),
            sql_name,
            rust_constant: rust_constant_name(&id),
            display_name: docs_entry
                .map(|entry| entry.name.clone())
                .unwrap_or_else(|| id.clone()),
            source_kind: source_kind.to_owned(),
            pglite_import_name: repl_export
                .map(|entry| entry.import_name.clone())
                .or_else(|| docs_entry.map(|entry| entry.import_name.clone()))
                .unwrap_or_else(|| id.clone()),
            pglite_import_path: repl_export
                .map(|entry| entry.import_path.clone())
                .or_else(|| docs_entry.map(|entry| entry.import_path.clone())),
            package_export: package_exports.get(&id).cloned().or_else(|| {
                (source_kind == "postgres-contrib")
                    .then(|| package_exports.get("*").map(|_| format!("./contrib/{id}")))
                    .flatten()
            }),
            tags: docs_entry
                .map(|entry| entry.tags.clone())
                .unwrap_or_default(),
            bundle_size: docs_entry.and_then(|entry| entry.size),
            control_file: control_file
                .filter(|path| path.is_file())
                .map(|path| normalize_path(&path)),
            control,
            dependencies,
            native_dependencies: Vec::new(),
            load_order: known_load_order(&id),
            lifecycle,
            smoke,
            tests,
            native_module_file,
            promotion,
            notes,
        });
    }

    entries.sort_by(|left, right| left.id.cmp(&right.id));

    Ok(ExtensionCatalog {
        format_version: 1,
        generated_from: vec![
            CatalogInput {
                name: "pglite-repl-exports".to_owned(),
                path: PGLITE_REPL_EXTENSIONS.to_owned(),
            },
            CatalogInput {
                name: "pglite-docs-catalog".to_owned(),
                path: PGLITE_DOCS_EXTENSIONS.to_owned(),
            },
            CatalogInput {
                name: "pglite-package-exports".to_owned(),
                path: PGLITE_PACKAGE_JSON.to_owned(),
            },
            CatalogInput {
                name: "pglite-contrib-modules".to_owned(),
                path: PGLITE_CONTRIB_SRC.to_owned(),
            },
            CatalogInput {
                name: "postgres-contrib".to_owned(),
                path: POSTGRES_CONTRIB.to_owned(),
            },
            CatalogInput {
                name: "postgres-pglite-other-extensions".to_owned(),
                path: POSTGRES_OTHER_EXTENSIONS.to_owned(),
            },
            CatalogInput {
                name: "extension-promotion-config".to_owned(),
                path: PROMOTION_CONFIG_PATH.to_owned(),
            },
            CatalogInput {
                name: "extension-smoke-evidence".to_owned(),
                path: SMOKE_CONFIG_PATH.to_owned(),
            },
            CatalogInput {
                name: "asset-manifest-evidence".to_owned(),
                path: ASSET_MANIFEST.to_owned(),
            },
        ],
        extensions: entries,
    })
}

fn validate_catalog(catalog: &ExtensionCatalog) -> Result<()> {
    ensure!(
        catalog.format_version == 1,
        "extension catalog format must be 1"
    );
    let mut ids = BTreeSet::new();
    let mut sql_names = BTreeSet::new();
    for extension in &catalog.extensions {
        ensure!(
            ids.insert(extension.id.as_str()),
            "duplicate extension id {}",
            extension.id
        );
        ensure!(
            extension.id != "live",
            "live must not be included in SQL extension catalog"
        );
        ensure!(
            extension.promotion.configured,
            "{} is missing from {}; every discovered SQL extension must be explicitly build-requested or blocked",
            extension.id,
            PROMOTION_CONFIG_PATH
        );
        ensure!(
            extension.promotion.requested || extension.promotion.blocker.is_some(),
            "{} is not build-requested and has no blocker in {}",
            extension.id,
            PROMOTION_CONFIG_PATH
        );
        ensure!(
            sql_names.insert(extension.sql_name.as_str()),
            "duplicate SQL extension name {}",
            extension.sql_name
        );
        ensure!(
            !extension.promotion.promoted || extension.promotion.stable,
            "{} cannot be promoted without stable=true",
            extension.id
        );
        if extension.promotion.requested {
            ensure!(
                extension.promotion.archive.is_some(),
                "requested extension {} must resolve to an archive path",
                extension.id
            );
            ensure!(
                extension.source_kind != "pglite-plugin",
                "requested extension {} is not a SQL extension",
                extension.id
            );
            ensure!(
                extension.lifecycle.create_extension || !extension.lifecycle.load_sql.is_empty(),
                "requested extension {} must declare a lifecycle operation",
                extension.id
            );
        }
        if extension.promotion.promoted {
            ensure!(
                !extension.tests.is_empty(),
                "promoted extension {} must have a smoke test source",
                extension.id
            );
            ensure!(
                extension.lifecycle.create_extension || !extension.lifecycle.load_sql.is_empty(),
                "promoted extension {} must declare a lifecycle operation",
                extension.id
            );
        }
        for dependency in &extension.dependencies {
            if runtime_provided_sql_extensions().contains(&dependency.as_str()) {
                continue;
            }
            ensure!(
                catalog
                    .extensions
                    .iter()
                    .any(|candidate| candidate.sql_name == *dependency
                        || candidate.id == *dependency),
                "{} depends on unknown extension {}",
                extension.id,
                dependency
            );
            if extension.promotion.promoted {
                ensure!(
                    catalog.extensions.iter().any(|candidate| {
                        candidate.promotion.promoted
                            && (candidate.sql_name == *dependency || candidate.id == *dependency)
                    }),
                    "promoted extension {} depends on unpromoted extension {}",
                    extension.id,
                    dependency
                );
            }
            if extension.promotion.requested {
                ensure!(
                    catalog.extensions.iter().any(|candidate| {
                        candidate.promotion.requested
                            && (candidate.sql_name == *dependency || candidate.id == *dependency)
                    }),
                    "requested extension {} depends on unrequested extension {}",
                    extension.id,
                    dependency
                );
            }
        }
    }

    for required in [
        "vector", "pg_trgm", "hstore", "pgcrypto", "pgtap", "postgis",
    ] {
        ensure!(
            catalog
                .extensions
                .iter()
                .any(|extension| extension.id == required || extension.sql_name == required),
            "extension catalog is missing required PGlite extension {required}"
        );
    }
    Ok(())
}

fn api_dependencies(extension: &ExtensionCatalogEntry) -> Vec<String> {
    extension
        .dependencies
        .iter()
        .filter(|dependency| !runtime_provided_sql_extensions().contains(&dependency.as_str()))
        .cloned()
        .collect()
}

fn runtime_provided_sql_extensions() -> &'static [&'static str] {
    &["plpgsql"]
}

fn parse_repl_exports(path: &Path) -> Result<BTreeMap<String, ReplExport>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut exports = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("export { ") else {
            continue;
        };
        let Some((name, module_part)) = rest.split_once(" } from ") else {
            continue;
        };
        let import_path = strip_quoted(module_part.trim())
            .ok_or_else(|| anyhow!("could not parse export module from {line:?}"))?;
        exports.insert(
            name.to_owned(),
            ReplExport {
                import_name: name.to_owned(),
                import_path: import_path.to_owned(),
            },
        );
    }
    Ok(exports)
}

fn parse_docs_catalog(path: &Path) -> Result<BTreeMap<String, DocsCatalogEntry>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut entries = BTreeMap::new();
    let mut current = DocsCatalogEntryBuilder::default();
    let mut in_entry = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "{" {
            in_entry = true;
            current = DocsCatalogEntryBuilder::default();
            continue;
        }
        if !in_entry {
            continue;
        }
        if trimmed == "}," || trimmed == "}" {
            if let Some(entry) = std::mem::take(&mut current).finish() {
                entries.insert(entry.import_name.clone(), entry);
            }
            in_entry = false;
            continue;
        }
        if let Some(value) = parse_string_field(trimmed, "name") {
            current.name = Some(value.to_owned());
        } else if let Some(value) = parse_string_field(trimmed, "importPath") {
            current.import_path = Some(value.to_owned());
        } else if let Some(value) = parse_string_field(trimmed, "importName") {
            current.import_name = Some(value.to_owned());
        } else if let Some(value) = parse_u64_field(trimmed, "size") {
            current.size = Some(value);
        } else if let Some(tags) = parse_tags_field(trimmed) {
            current.tags = tags;
        }
    }
    Ok(entries)
}

fn parse_package_exports(path: &Path) -> Result<BTreeMap<String, String>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    let mut exports = BTreeMap::new();
    let Some(map) = json.get("exports").and_then(|value| value.as_object()) else {
        return Ok(exports);
    };
    for key in map.keys() {
        let Some(name) = key.strip_prefix("./") else {
            continue;
        };
        if name == "contrib" {
            continue;
        }
        if let Some(name) = name.strip_prefix("contrib/") {
            exports.insert(name.to_owned(), key.clone());
        } else {
            exports.insert(name.to_owned(), key.clone());
        }
    }
    Ok(exports)
}

fn parse_promotion_config(path: &Path) -> Result<BTreeMap<String, PromotionRequest>> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let config: PromotionConfig =
        toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        config.format_version == 1,
        "{} format_version must be 1",
        path.display()
    );
    let mut requests = BTreeMap::new();
    for request in config.extensions {
        ensure!(!request.id.is_empty(), "promotion request has empty id");
        ensure!(
            requests.insert(request.id.clone(), request).is_none(),
            "duplicate promotion request"
        );
    }
    Ok(requests)
}

fn parse_smoke_config(path: &Path) -> Result<BTreeMap<String, ExtensionSmokeEvidence>> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let config: SmokeConfig =
        toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        config.format_version == 1,
        "{} format_version must be 1",
        path.display()
    );
    let mut evidence = BTreeMap::new();
    for mut extension in config.extensions {
        ensure!(!extension.id.is_empty(), "smoke evidence has empty id");
        normalize_smoke_statuses(&mut extension);
        ensure_valid_smoke_status(&extension.direct, &extension.id, "direct")?;
        ensure_valid_smoke_status(&extension.server, &extension.id, "server")?;
        ensure_valid_smoke_status(&extension.restart, &extension.id, "restart")?;
        ensure_valid_smoke_status(&extension.dump_restore, &extension.id, "dump-restore")?;
        ensure!(
            evidence
                .insert(
                    extension.id.clone(),
                    ExtensionSmokeEvidence::from(extension)
                )
                .is_none(),
            "duplicate smoke evidence"
        );
    }
    Ok(evidence)
}

fn normalize_smoke_statuses(extension: &mut SmokeConfigExtension) {
    if extension.direct.is_empty() {
        extension.direct = "not-run".to_owned();
    }
    if extension.server.is_empty() {
        extension.server = "not-run".to_owned();
    }
    if extension.restart.is_empty() {
        extension.restart = "not-run".to_owned();
    }
    if extension.dump_restore.is_empty() {
        extension.dump_restore = "not-run".to_owned();
    }
}

fn ensure_valid_smoke_status(status: &str, id: &str, field: &str) -> Result<()> {
    ensure!(
        matches!(status, "passed" | "failed" | "not-run" | "blocked"),
        "extension {id} has invalid smoke status for {field}: {status}"
    );
    Ok(())
}

fn parse_packaged_manifest(path: &Path) -> Result<BTreeMap<String, PackagedExtension>> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let manifest: AssetManifest =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    Ok(manifest
        .extensions
        .into_iter()
        .map(|extension| {
            (
                extension.sql_name,
                PackagedExtension {
                    archive: Some(extension.archive),
                    module_sha256: Some(extension.module_sha256),
                    stable: extension.stable,
                },
            )
        })
        .collect())
}

fn parse_other_extension_submodules(path: &Path) -> Result<BTreeMap<String, SubmodulePin>> {
    let gitmodules = path
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join(".gitmodules"))
        .ok_or_else(|| anyhow!("could not resolve postgres-pglite .gitmodules"))?;
    let gitmodules_text = fs::read_to_string(&gitmodules)
        .with_context(|| format!("read {}", gitmodules.display()))?;
    let mut urls = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in gitmodules_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[submodule ") {
            current = trimmed
                .split('"')
                .nth(1)
                .and_then(|value| value.strip_prefix("pglite/other_extensions/"))
                .map(str::to_owned);
        } else if let Some(url) = trimmed.strip_prefix("url = ")
            && let Some(name) = &current
        {
            urls.insert(name.clone(), url.to_owned());
        }
    }

    let status = std::process::Command::new("git")
        .args([
            "-C",
            "assets/checkouts/postgres-pglite",
            "submodule",
            "status",
        ])
        .output()
        .context("read postgres-pglite submodule status")?;
    let status_text = String::from_utf8(status.stdout).context("submodule status utf8")?;
    let mut pins = BTreeMap::new();
    for line in status_text.lines() {
        let trimmed = line.trim_start_matches(['-', '+', ' ']);
        let mut parts = trimmed.split_whitespace();
        let Some(commit) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };
        let Some(name) = path.strip_prefix("pglite/other_extensions/") else {
            continue;
        };
        if let Some(url) = urls.get(name) {
            pins.insert(
                name.to_owned(),
                SubmodulePin {
                    url: url.clone(),
                    commit: commit.to_owned(),
                },
            );
        }
    }
    Ok(pins)
}

fn discover_sql_name(
    id: &str,
    repl_export: Option<&ReplExport>,
    _docs_entry: Option<&DocsCatalogEntry>,
) -> Result<String> {
    if id == "uuid_ossp" {
        return Ok("uuid-ossp".to_owned());
    }
    if id == "vector" {
        return Ok("vector".to_owned());
    }
    let control_file = discover_control_file(id, id, repl_export);
    if let Some(path) = control_file
        && path.is_file()
        && let Some(stem) = path.file_stem().and_then(|stem| stem.to_str())
    {
        return Ok(stem.to_owned());
    }
    Ok(id.to_owned())
}

fn discover_control_file(
    id: &str,
    sql_name: &str,
    repl_export: Option<&ReplExport>,
) -> Option<PathBuf> {
    let candidates = if repl_export
        .map(|entry| entry.import_path.contains("/contrib/"))
        .unwrap_or(false)
    {
        let dashed_id = id.replace('_', "-");
        vec![
            Path::new(POSTGRES_CONTRIB)
                .join(id)
                .join(format!("{sql_name}.control")),
            Path::new(POSTGRES_CONTRIB)
                .join(id)
                .join(format!("{id}.control")),
            Path::new(POSTGRES_CONTRIB)
                .join(id)
                .join(format!("{dashed_id}.control")),
            Path::new(POSTGRES_CONTRIB)
                .join(&dashed_id)
                .join(format!("{sql_name}.control")),
            Path::new(POSTGRES_CONTRIB)
                .join(&dashed_id)
                .join(format!("{dashed_id}.control")),
        ]
    } else {
        vec![
            Path::new(&extension_source_dir_for(
                id,
                classify_source_kind(id, repl_export, None),
            ))
            .join(format!("{sql_name}.control")),
        ]
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn parse_control_file(path: &Path) -> Result<ControlMetadata> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut control = ControlMetadata::default();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = strip_quoted(value.trim())
            .unwrap_or_else(|| value.trim().trim_matches('"'))
            .to_owned();
        match key {
            "default_version" => control.default_version = Some(value),
            "module_pathname" => control.module_pathname = Some(value),
            "requires" => {
                control.requires = value
                    .split(',')
                    .map(|item| item.trim().trim_matches('"').to_owned())
                    .filter(|item| !item.is_empty())
                    .collect();
            }
            "relocatable" => control.relocatable = Some(value),
            "schema" => control.schema = Some(value),
            _ => {}
        }
    }
    Ok(control)
}

fn discover_dependencies(id: &str, control: Option<&ControlMetadata>) -> Vec<String> {
    let mut dependencies = BTreeSet::new();
    if let Some(control) = control {
        dependencies.extend(control.requires.iter().cloned());
    }
    if id == "earthdistance" {
        dependencies.insert("cube".to_owned());
    }
    dependencies.into_iter().collect()
}

fn discover_native_module_file(
    id: &str,
    sql_name: &str,
    source_kind: &str,
    control: Option<&ControlMetadata>,
) -> Result<Option<String>> {
    if let Some(module_pathname) = control.and_then(|control| control.module_pathname.as_deref()) {
        return Ok(module_pathname_to_file(module_pathname));
    }

    let source_dir = extension_source_dir_for(id, source_kind);
    if source_dir.is_empty() {
        return Ok(None);
    }
    let makefile = Path::new(&source_dir).join("Makefile");
    if !makefile.is_file() {
        return Ok(None);
    }
    discover_native_module_file_from_makefile(&makefile, sql_name)
}

fn module_pathname_to_file(module_pathname: &str) -> Option<String> {
    let value = module_pathname
        .strip_prefix("$libdir/")
        .or_else(|| module_pathname.strip_prefix("${libdir}/"))
        .unwrap_or(module_pathname)
        .trim();
    if value.is_empty() {
        return None;
    }
    let file = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value);
    if file.ends_with(".so") {
        Some(file.to_owned())
    } else {
        Some(format!("{file}.so"))
    }
}

fn discover_native_module_file_from_makefile(
    makefile: &Path,
    sql_name: &str,
) -> Result<Option<String>> {
    let text =
        fs::read_to_string(makefile).with_context(|| format!("read {}", makefile.display()))?;
    let mut variables = BTreeMap::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() || line.starts_with("ifeq") || line.starts_with("ifneq") {
            continue;
        }
        let Some((key, value)) = parse_make_assignment(line) else {
            continue;
        };
        variables.insert(key.to_owned(), value.to_owned());
    }

    for key in ["MODULE_big", "MODULES"] {
        let Some(value) = variables.get(key) else {
            continue;
        };
        let expanded = expand_make_value(value, &variables, 0);
        let modules = expanded
            .split_whitespace()
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if modules.is_empty() {
            continue;
        }
        let selected = modules
            .iter()
            .copied()
            .find(|module| *module == sql_name)
            .unwrap_or(modules[0]);
        return Ok(Some(if selected.ends_with(".so") {
            selected.to_owned()
        } else {
            format!("{selected}.so")
        }));
    }
    Ok(None)
}

fn parse_make_assignment(line: &str) -> Option<(&str, &str)> {
    for operator in [":=", "?=", "="] {
        if let Some((key, value)) = line.split_once(operator) {
            let key = key.trim();
            if key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            {
                return Some((key, value.trim()));
            }
        }
    }
    None
}

fn expand_make_value(value: &str, variables: &BTreeMap<String, String>, depth: usize) -> String {
    if depth > 8 {
        return value.to_owned();
    }
    let mut out = String::new();
    let mut rest = value;
    while let Some(index) = rest.find('$') {
        out.push_str(&rest[..index]);
        rest = &rest[index..];
        let Some(open) = rest.chars().nth(1) else {
            out.push('$');
            rest = &rest[1..];
            continue;
        };
        let close = match open {
            '(' => ')',
            '{' => '}',
            _ => {
                out.push('$');
                rest = &rest[1..];
                continue;
            }
        };
        let Some(close_index) = rest.find(close) else {
            out.push('$');
            rest = &rest[1..];
            continue;
        };
        let key = &rest[2..close_index];
        if let Some(replacement) = variables.get(key) {
            out.push_str(&expand_make_value(replacement, variables, depth + 1));
        } else {
            out.push_str(&rest[..=close_index]);
        }
        rest = &rest[close_index + 1..];
    }
    out.push_str(rest);
    out
}

fn classify_lifecycle(id: &str, control: Option<&ControlMetadata>) -> ExtensionLifecycle {
    let mut lifecycle = ExtensionLifecycle {
        create_extension: id != "auto_explain",
        create_schema: Some(
            control
                .and_then(|control| control.schema.clone())
                .unwrap_or_else(|| "pg_catalog".to_owned()),
        ),
        load_sql: Vec::new(),
        post_create_sql: Vec::new(),
        startup_config: Vec::new(),
        preload_required: false,
        restart_required: false,
        shared_memory_required: false,
    };
    match id {
        "auto_explain" => {
            lifecycle.create_extension = false;
            lifecycle.create_schema = None;
            lifecycle.load_sql = vec![
                "LOAD 'auto_explain';".to_owned(),
                "SET auto_explain.log_min_duration = '0';".to_owned(),
                "SET auto_explain.log_analyze = 'true';".to_owned(),
                "SET auto_explain.log_level = 'NOTICE';".to_owned(),
            ];
        }
        "age" => {
            lifecycle.load_sql.push("LOAD 'age';".to_owned());
            lifecycle
                .post_create_sql
                .push("SET search_path = ag_catalog, \"$user\", public;".to_owned());
        }
        _ => {}
    }
    lifecycle
}

fn classify_source_kind(
    id: &str,
    repl_export: Option<&ReplExport>,
    docs_entry: Option<&DocsCatalogEntry>,
) -> &'static str {
    if id == "live"
        || docs_entry
            .map(|entry| entry.tags.iter().any(|tag| tag == "pglite plugin"))
            .unwrap_or(false)
    {
        "pglite-plugin"
    } else if repl_export
        .map(|entry| entry.import_path.contains("/contrib/"))
        .unwrap_or(false)
    {
        "postgres-contrib"
    } else if id == "postgis" {
        "postgis"
    } else {
        "pglite-other-extension"
    }
}

fn discover_test_paths(id: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut test_names = vec![id.to_owned()];
    if id == "vector" {
        test_names.push("pgvector".to_owned());
    }
    for test_name in test_names {
        for candidate in [
            Path::new(PGLITE_TESTS)
                .join("contrib")
                .join(format!("{test_name}.test.js")),
            Path::new(PGLITE_TESTS)
                .join("contrib")
                .join(format!("{test_name}.test.ts")),
            Path::new(PGLITE_TESTS).join(format!("{test_name}.test.js")),
            Path::new(PGLITE_TESTS).join(format!("{test_name}.test.ts")),
            Path::new(PGLITE_POSTGIS_TESTS).join(format!("{test_name}.test.ts")),
            Path::new(PGLITE_POSTGIS_TESTS).join(format!("{test_name}.test.js")),
        ] {
            if candidate.is_file() {
                paths.push(normalize_path(&candidate));
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn known_load_order(id: &str) -> Vec<String> {
    match id {
        "postgis" => vec![
            "lib/postgresql/postgis-3.so".to_owned(),
            "lib/postgresql/postgis_topology-3.so".to_owned(),
            "lib/postgresql/postgis_raster-3.so".to_owned(),
        ],
        _ => Vec::new(),
    }
}

fn build_kind(extension: &ExtensionCatalogEntry) -> &'static str {
    match extension.source_kind.as_str() {
        "postgres-contrib" => "postgres-contrib",
        "pglite-other-extension" => "pgxs-external",
        "postgis" => "postgis",
        _ => "unsupported",
    }
}

fn extension_source_dir(extension: &ExtensionCatalogEntry) -> String {
    extension_source_dir_for(&extension.id, &extension.source_kind)
}

fn pgxs_make_args(extension: &ExtensionCatalogEntry) -> Vec<String> {
    match extension.id.as_str() {
        // AGE's graphid SQL is target-ABI sensitive. wasm32/WASIX has a 4-byte
        // Datum, so AGE must generate pass-by-reference graphid SQL.
        "age" => vec!["SIZEOF_DATUM=4".to_owned()],
        _ => Vec::new(),
    }
}

fn extension_source_dir_for(id: &str, source_kind: &str) -> String {
    match source_kind {
        "postgres-contrib" => Path::new(POSTGRES_CONTRIB)
            .join(extension_contrib_dir_name(id))
            .to_string_lossy()
            .replace('\\', "/"),
        "pglite-other-extension" if id == "vector" => PGVECTOR_CHECKOUT.to_owned(),
        "pglite-other-extension" | "postgis" => Path::new(EXTERNAL_EXTENSION_CHECKOUT_ROOT)
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

fn parse_string_field<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(&format!("{field}: "))?;
    strip_quoted(rest.trim_end_matches(',').trim())
}

fn parse_u64_field(line: &str, field: &str) -> Option<u64> {
    let rest = line.strip_prefix(&format!("{field}: "))?;
    rest.trim_end_matches(',').trim().parse().ok()
}

fn parse_tags_field(line: &str) -> Option<Vec<String>> {
    let rest = line.strip_prefix("tags: ")?;
    let rest = rest.trim().trim_end_matches(',').trim();
    let rest = rest.strip_prefix('[')?.strip_suffix(']')?;
    Some(
        rest.split(',')
            .filter_map(|item| strip_quoted(item.trim()).map(str::to_owned))
            .collect(),
    )
}

fn strip_quoted(value: &str) -> Option<&str> {
    let value = value.trim().trim_end_matches(',');
    if value.len() < 2 {
        return None;
    }
    let quote = value.as_bytes()[0] as char;
    if quote != '\'' && quote != '"' {
        return None;
    }
    value
        .strip_prefix(quote)
        .and_then(|value| value.strip_suffix(quote))
}

fn rust_constant_name(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn shell_words(words: &[String]) -> String {
    if words.is_empty() {
        "-".to_owned()
    } else {
        words.join(" ")
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionCatalog {
    format_version: u32,
    generated_from: Vec<CatalogInput>,
    extensions: Vec<ExtensionCatalogEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct CatalogInput {
    name: String,
    path: String,
}

struct BuildPlanTexts {
    json: String,
    contrib_tsv: String,
    pgxs_tsv: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionBuildPlan {
    format_version: u32,
    generated_from: Vec<CatalogInput>,
    extensions: Vec<ExtensionBuildPlanEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionBuildPlanEntry {
    id: String,
    sql_name: String,
    display_name: String,
    source_kind: String,
    build_kind: String,
    source_dir: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    make_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    contrib_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_file: Option<String>,
    archive: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_file: Option<String>,
    stable: bool,
    dependencies: Vec<String>,
    native_dependencies: Vec<String>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
    smoke: ExtensionSmokeEvidence,
    tests: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct ExtensionCatalogEntry {
    id: String,
    sql_name: String,
    rust_constant: String,
    display_name: String,
    source_kind: String,
    pglite_import_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pglite_import_path: Option<String>,
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
    native_dependencies: Vec<String>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
    smoke: ExtensionSmokeEvidence,
    tests: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_module_file: Option<String>,
    promotion: PromotionStatus,
    notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct ReplExport {
    import_name: String,
    import_path: String,
}

#[derive(Debug, Clone)]
struct DocsCatalogEntry {
    name: String,
    import_path: String,
    import_name: String,
    tags: Vec<String>,
    size: Option<u64>,
}

#[derive(Debug, Default)]
struct DocsCatalogEntryBuilder {
    name: Option<String>,
    import_path: Option<String>,
    import_name: Option<String>,
    tags: Vec<String>,
    size: Option<u64>,
}

impl DocsCatalogEntryBuilder {
    fn finish(self) -> Option<DocsCatalogEntry> {
        Some(DocsCatalogEntry {
            name: self.name?,
            import_path: self.import_path?,
            import_name: self.import_name?,
            tags: self.tags,
            size: self.size,
        })
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct ExtensionSmokeEvidence {
    direct: String,
    server: String,
    restart: String,
    dump_restore: String,
}

impl Default for ExtensionSmokeEvidence {
    fn default() -> Self {
        Self {
            direct: "not-run".to_owned(),
            server: "not-run".to_owned(),
            restart: "not-run".to_owned(),
            dump_restore: "not-run".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct PromotionStatus {
    configured: bool,
    requested: bool,
    packaged: bool,
    promoted: bool,
    stable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocker: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct PromotionConfig {
    format_version: u32,
    #[serde(default)]
    extensions: Vec<PromotionRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct PromotionRequest {
    id: String,
    #[serde(default = "default_true")]
    build: bool,
    #[serde(default)]
    stable: bool,
    #[serde(default)]
    archive: Option<String>,
    #[serde(default)]
    blocker: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct SmokeConfig {
    format_version: u32,
    #[serde(default)]
    extensions: Vec<SmokeConfigExtension>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct SmokeConfigExtension {
    id: String,
    #[serde(default)]
    direct: String,
    #[serde(default)]
    server: String,
    #[serde(default)]
    restart: String,
    #[serde(default)]
    dump_restore: String,
}

impl From<SmokeConfigExtension> for ExtensionSmokeEvidence {
    fn from(value: SmokeConfigExtension) -> Self {
        Self {
            direct: value.direct,
            server: value.server,
            restart: value.restart,
            dump_restore: value.dump_restore,
        }
    }
}

#[derive(Debug, Clone)]
struct PackagedExtension {
    archive: Option<String>,
    module_sha256: Option<String>,
    stable: bool,
}

#[derive(Debug)]
struct SubmodulePin {
    url: String,
    commit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct AssetManifest {
    #[serde(default)]
    extensions: Vec<AssetManifestExtension>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct AssetManifestExtension {
    sql_name: String,
    archive: String,
    #[serde(default)]
    module_sha256: String,
    #[serde(default)]
    stable: bool,
}
