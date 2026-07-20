use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

const CATALOG_PATH: &str = "src/extensions/generated/extensions.catalog.json";
const SOURCE_CATALOG_PATH: &str = "src/extensions/catalog/extensions.source.json";
const BUILD_PLAN_PATH: &str = "src/extensions/generated/extensions.build-plan.json";
const CONTRIB_BUILD_PLAN_PATH: &str = "src/extensions/generated/contrib-build.tsv";
const PGXS_BUILD_PLAN_PATH: &str = "src/extensions/generated/pgxs-build.tsv";
const PROMOTION_CONFIG_PATH: &str = "src/extensions/catalog/extensions.promoted.toml";
const SMOKE_CONFIG_PATH: &str = "src/extensions/catalog/extensions.smoke.toml";
const CONTRIB_MANIFEST_PATH: &str = "src/extensions/contrib/postgres18.toml";
const POSTGRES_CONTRIB: &str = "src/postgres/versions/18/contrib";
const POSTGRES_OTHER_EXTENSIONS: &str = "src/extensions/external";
const EXTERNAL_EXTENSION_RECIPE_ROOT: &str = "src/extensions/external";
const PGVECTOR_CHECKOUT: &str = "target/oliphaunt-sources/checkouts/pgvector";
const EXTERNAL_EXTENSION_CHECKOUT_ROOT: &str = "target/oliphaunt-sources/checkouts";
const ASSET_MANIFEST: &str = "target/oliphaunt-wasix/assets/manifest.json";

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
    if !extension_discovery_inputs_available(strict)? {
        return Ok(());
    }
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
    if !extension_discovery_inputs_available(strict)? {
        return Ok(());
    }
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
            extension_build_plan_tsv_matches_source_control(&actual, text)
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

fn extension_build_plan_tsv_matches_source_control(actual: &str, expected: &str) -> bool {
    normalize_extension_build_plan_tsv(actual) == normalize_extension_build_plan_tsv(expected)
}

fn normalize_extension_build_plan_tsv(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end()
        .to_owned()
}

fn extension_discovery_inputs_available(strict: bool) -> Result<bool> {
    for required in [
        SOURCE_CATALOG_PATH,
        CATALOG_PATH,
        PROMOTION_CONFIG_PATH,
        SMOKE_CONFIG_PATH,
        CONTRIB_MANIFEST_PATH,
    ] {
        let path = Path::new(required);
        if path.exists() {
            continue;
        }
        if strict {
            bail!(
                "extension graph input is missing at {}; restore the committed extension catalog/config",
                path.display()
            );
        }
        eprintln!(
            "warning: extension graph input is missing at {}; skipping generated extension catalog checks in source-only verification",
            path.display()
        );
        return Ok(false);
    }
    Ok(true)
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
    if extension_discovery_inputs_available(false)? {
        let catalog = discover_catalog()?;
        validate_catalog(&catalog)?;
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
    } else {
        manifest_metadata_by_sql_name_from_generated_plan()
    }
}

pub(crate) fn promoted_build_specs() -> Result<Vec<PromotedExtensionBuildSpec>> {
    if extension_discovery_inputs_available(false)? {
        let catalog = discover_catalog()?;
        validate_catalog(&catalog)?;
        build_specs(&catalog)
    } else {
        promoted_build_specs_from_generated_plan()
    }
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
        let wasix_target = wasix_target_recipe(&extension.sql_name)?;
        let mut native_support_modules = wasix_target
            .as_ref()
            .map(|target| target.native_support_modules.clone())
            .unwrap_or_default();
        native_support_modules.sort_by(|left, right| left.name.cmp(&right.name));
        let build_kind = build_kind(extension, wasix_target.as_ref())?;
        specs.push(PromotedExtensionBuildSpec {
            id: extension.id.clone(),
            display_name: extension.display_name.clone(),
            sql_name: extension.sql_name.clone(),
            source_kind: extension.source_kind.clone(),
            build_kind,
            build_script: wasix_target
                .as_ref()
                .and_then(|target| target.build_script.clone()),
            required_build_files: wasix_target
                .as_ref()
                .map(|target| target.required_build_files.clone())
                .unwrap_or_default(),
            required_build_globs: wasix_target
                .as_ref()
                .map(|target| target.required_build_globs.clone())
                .unwrap_or_default(),
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
            native_support_modules,
            excluded_sql_extensions: wasix_target
                .as_ref()
                .map(|target| target.excluded_sql_extensions.clone())
                .unwrap_or_default(),
            staging: wasix_target.and_then(|target| target.staging),
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
    pub(crate) build_script: Option<String>,
    pub(crate) required_build_files: Vec<String>,
    pub(crate) required_build_globs: Vec<String>,
    pub(crate) source_dir: String,
    pub(crate) make_args: Vec<String>,
    pub(crate) contrib_dir: Option<String>,
    pub(crate) module_file: Option<String>,
    pub(crate) archive: String,
    pub(crate) control_file: Option<String>,
    pub(crate) stable: bool,
    pub(crate) dependencies: Vec<String>,
    pub(crate) native_dependencies: Vec<String>,
    pub(crate) native_support_modules: Vec<NativeSupportModuleSpec>,
    pub(crate) excluded_sql_extensions: Vec<String>,
    pub(crate) staging: Option<ExtensionStagingSpec>,
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
            kind if is_pgxs_style_build_kind(kind) => {
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
            kind if is_recipe_staged_build_kind(kind) => {}
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
                build_script: spec.build_script,
                required_build_files: spec.required_build_files,
                required_build_globs: spec.required_build_globs,
                source_dir: spec.source_dir,
                make_args: spec.make_args,
                contrib_dir: spec.contrib_dir,
                module_file: spec.module_file,
                archive: spec.archive,
                control_file: spec.control_file,
                stable: spec.stable,
                dependencies: spec.dependencies,
                native_dependencies: spec.native_dependencies,
                native_support_modules: spec.native_support_modules,
                excluded_sql_extensions: spec.excluded_sql_extensions,
                staging: spec.staging,
                load_order: spec.load_order,
                lifecycle: spec.lifecycle,
                smoke: spec.smoke,
                tests: spec.tests,
            })
            .collect(),
    })
}

fn promoted_build_specs_from_generated_plan() -> Result<Vec<PromotedExtensionBuildSpec>> {
    promoted_build_specs_from_generated_plan_at(Path::new(BUILD_PLAN_PATH))
}

fn promoted_build_specs_from_generated_plan_at(
    path: &Path,
) -> Result<Vec<PromotedExtensionBuildSpec>> {
    let text = fs::read_to_string(path).with_context(|| {
        format!(
            "read {}; extension discovery inputs are unavailable, so generated build plan fallback is required",
            path.display()
        )
    })?;
    let plan: ExtensionBuildPlan =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        plan.format_version == 1,
        "extension build plan format must be 1"
    );
    Ok(plan
        .extensions
        .into_iter()
        .map(|extension| PromotedExtensionBuildSpec {
            id: extension.id,
            display_name: extension.display_name,
            sql_name: extension.sql_name,
            source_kind: extension.source_kind,
            build_kind: extension.build_kind,
            build_script: extension.build_script,
            required_build_files: extension.required_build_files,
            required_build_globs: extension.required_build_globs,
            source_dir: extension.source_dir,
            make_args: extension.make_args,
            contrib_dir: extension.contrib_dir,
            module_file: extension.module_file,
            archive: extension.archive,
            control_file: extension.control_file,
            stable: extension.stable,
            dependencies: extension.dependencies,
            native_dependencies: extension.native_dependencies,
            native_support_modules: extension.native_support_modules,
            excluded_sql_extensions: extension.excluded_sql_extensions,
            staging: extension.staging,
            load_order: extension.load_order,
            lifecycle: extension.lifecycle,
            smoke: extension.smoke,
            tests: extension.tests,
        })
        .collect())
}

fn manifest_metadata_by_sql_name_from_generated_plan()
-> Result<BTreeMap<String, ManifestExtensionMetadata>> {
    let path = Path::new(BUILD_PLAN_PATH);
    let text = fs::read_to_string(path).with_context(|| {
        format!(
            "read {}; extension discovery inputs are unavailable, so generated build plan fallback is required",
            path.display()
        )
    })?;
    let plan: ExtensionBuildPlan =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        plan.format_version == 1,
        "extension build plan format must be 1"
    );
    Ok(plan
        .extensions
        .into_iter()
        .map(|extension| {
            (
                extension.sql_name.clone(),
                manifest_metadata_from_build_plan_entry(extension),
            )
        })
        .collect())
}

fn manifest_metadata_from_catalog_entry(
    extension: ExtensionCatalogEntry,
) -> ManifestExtensionMetadata {
    ManifestExtensionMetadata {
        source_kind: extension.source_kind,
        control_files: extension.control_file.into_iter().collect(),
        dependencies: extension.dependencies,
        native_dependencies: extension.native_dependencies,
        load_order: extension.load_order,
        lifecycle: manifest_lifecycle_from_extension(extension.lifecycle),
        smoke_status: ManifestExtensionSmokeStatus {
            promoted: extension.promotion.promoted,
            ..manifest_smoke_status_from_evidence(extension.smoke)
        },
    }
}

fn manifest_metadata_from_build_plan_entry(
    extension: ExtensionBuildPlanEntry,
) -> ManifestExtensionMetadata {
    let promoted = extension.stable
        && extension.smoke.direct == "passed"
        && extension.smoke.server == "passed"
        && extension.smoke.restart == "passed"
        && extension.smoke.dump_restore == "passed";
    ManifestExtensionMetadata {
        source_kind: extension.source_kind,
        control_files: extension.control_file.into_iter().collect(),
        dependencies: extension.dependencies,
        native_dependencies: extension.native_dependencies,
        load_order: extension.load_order,
        lifecycle: manifest_lifecycle_from_extension(extension.lifecycle),
        smoke_status: ManifestExtensionSmokeStatus {
            promoted,
            ..manifest_smoke_status_from_evidence(extension.smoke)
        },
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

fn manifest_smoke_status_from_evidence(
    smoke: ExtensionSmokeEvidence,
) -> ManifestExtensionSmokeStatus {
    ManifestExtensionSmokeStatus {
        promoted: false,
        direct: smoke.direct,
        server: smoke.server,
        restart: smoke.restart,
        dump_restore: smoke.dump_restore,
    }
}

fn write_generated_extension_api(catalog: &ExtensionCatalog) -> Result<()> {
    let promoted = promoted_extensions(catalog);
    let candidates = packaged_extensions(catalog);
    let mut text = String::new();
    text.push_str("// @generated by `cargo run -p xtask -- extensions generate`\n\n");
    text.push_str("use super::{Extension, ExtensionNativeModule, ExtensionSetup};\n\n");
    text.push_str("const EMPTY_SQL_NAMES: &[&str] = &[];\n");
    text.push_str("const EMPTY_SQL: &[&str] = &[];\n");
    text.push_str("const EMPTY_NATIVE_MODULES: &[ExtensionNativeModule] = &[];\n\n");

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
        let native_support_modules = api_native_support_modules(extension)?;
        if native_support_modules.is_empty() {
            text.push_str(&format!(
                "const {candidate_const}_NATIVE_SUPPORT_MODULES: &[ExtensionNativeModule] = EMPTY_NATIVE_MODULES;\n"
            ));
        } else {
            let native_modules = native_support_modules
                .iter()
                .map(|(runtime_path, aot_name)| {
                    format!(
                        "ExtensionNativeModule::new({runtime_path:?}, {})",
                        option_string_literal(aot_name.as_deref())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!(
                "const {candidate_const}_NATIVE_SUPPORT_MODULES: &[ExtensionNativeModule] = &[{native_modules}];\n"
            ));
        }
        text.push('\n');
        let archive = extension.promotion.archive.as_deref().ok_or_else(|| {
            anyhow!(
                "release-ready extension {} is missing archive",
                extension.id
            )
        })?;
        let aot_name = extension.native_module_file.as_ref().and(
            extension
                .promotion
                .packaged
                .then(|| format!("extension:{}", extension.sql_name)),
        );
        text.push_str(&format!(
            "pub(crate) const {candidate_const}: Extension = Extension::new(\n    {:?},\n    {:?},\n    {:?},\n    {candidate_const}_NATIVE_SUPPORT_MODULES,\n    {},\n    {},\n    {candidate_const}_DEPENDENCIES,\n    ExtensionSetup::new(\n        {},\n        {},\n        {candidate_const}_LOAD_SQL,\n        {candidate_const}_POST_CREATE_SQL,\n    ),\n);\n\n",
            extension.display_name,
            extension.sql_name,
            archive,
            option_string_literal(extension.native_module_file.as_deref()),
            option_string_literal(aot_name.as_deref()),
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

    let path = Path::new(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/generated_extensions.rs",
    );
    fs::write(path, text).with_context(|| format!("write {}", path.display()))?;
    format_rust_source(path)
}

fn promoted_extensions(catalog: &ExtensionCatalog) -> Vec<&ExtensionCatalogEntry> {
    catalog
        .extensions
        .iter()
        .filter(|extension| extension.promotion.promoted)
        .collect()
}

fn format_rust_source(path: &Path) -> Result<()> {
    let status = Command::new("rustfmt")
        .arg(path)
        .status()
        .with_context(|| format!("run rustfmt on {}", path.display()))?;
    ensure!(
        status.success(),
        "rustfmt failed for {} with status {status}",
        path.display()
    );
    Ok(())
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
    let mut catalog = read_source_catalog()?;
    merge_source_owned_default_versions(&mut catalog)?;
    let promotion_requests = parse_promotion_config(Path::new(PROMOTION_CONFIG_PATH))?;
    let smoke_evidence = parse_smoke_config(Path::new(SMOKE_CONFIG_PATH))?;
    let packaged = parse_packaged_manifest(Path::new(ASSET_MANIFEST))?;

    for extension in &mut catalog.extensions {
        let request = promotion_requests
            .get(extension.id.as_str())
            .or_else(|| promotion_requests.get(extension.sql_name.as_str()));
        let asset = packaged.get(extension.sql_name.as_str());
        let archive = asset
            .and_then(|asset| asset.archive.clone())
            .or_else(|| request.and_then(|request| request.archive.clone()))
            .or_else(|| request.map(|_| format!("extensions/{}.tar.zst", extension.sql_name)));
        let requested = request.map(|request| request.build).unwrap_or(false);
        let stable = request.map(|request| request.stable).unwrap_or(false);
        let blocker = request.and_then(|request| request.blocker.clone());
        let packaged = asset.is_some();
        let asset_stable = asset.map(|asset| asset.stable).unwrap_or(false);
        extension.smoke = smoke_evidence
            .get(extension.id.as_str())
            .or_else(|| smoke_evidence.get(extension.sql_name.as_str()))
            .cloned()
            .unwrap_or_default();
        extension.promotion = PromotionStatus {
            configured: request.is_some(),
            requested,
            packaged,
            promoted: requested
                && stable
                && packaged
                && asset_stable
                && extension.smoke.direct == "passed"
                && extension.smoke.server == "passed"
                && extension.smoke.restart == "passed"
                && extension.smoke.dump_restore == "passed",
            stable,
            archive,
            module_sha256: asset.and_then(|asset| asset.module_sha256.clone()),
            blocker,
        };
        extension
            .notes
            .retain(|note| !note.starts_with("promotion blocker: "));
        if let Some(blocker) = &extension.promotion.blocker {
            extension
                .notes
                .push(format!("promotion blocker: {blocker}"));
        }
    }

    catalog
        .extensions
        .sort_by(|left, right| left.id.cmp(&right.id));
    catalog.generated_from = catalog_inputs();
    Ok(catalog)
}

fn read_source_catalog() -> Result<ExtensionCatalog> {
    read_source_catalog_at(Path::new("."))
}

fn read_source_catalog_at(repository_root: &Path) -> Result<ExtensionCatalog> {
    let path = repository_root.join(SOURCE_CATALOG_PATH);
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let catalog: ExtensionCatalog =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        catalog.generated_from.is_empty(),
        "{} is a curated input and must not contain generated-from",
        path.display()
    );
    for extension in &catalog.extensions {
        ensure!(
            extension.smoke == ExtensionSmokeEvidence::default(),
            "{} extension {} must not contain derived smoke evidence",
            path.display(),
            extension.id
        );
        ensure!(
            extension.promotion == PromotionStatus::default(),
            "{} extension {} must not contain derived promotion state",
            path.display(),
            extension.id
        );
        ensure!(
            extension
                .control
                .as_ref()
                .and_then(|control| control.default_version.as_ref())
                .is_none(),
            "{} extension {} must not own control.default-version; use source-owned extension metadata",
            path.display(),
            extension.id
        );
    }
    Ok(catalog)
}

fn merge_source_owned_default_versions(catalog: &mut ExtensionCatalog) -> Result<()> {
    let versions = source_owned_default_versions()?;
    let catalog_sql_names = catalog
        .extensions
        .iter()
        .map(|extension| extension.sql_name.as_str())
        .collect::<BTreeSet<_>>();
    for sql_name in versions.keys() {
        ensure!(
            catalog_sql_names.contains(sql_name.as_str()),
            "source-owned default-version metadata names unknown SQL extension {sql_name}"
        );
    }

    for extension in &mut catalog.extensions {
        let version = versions.get(extension.sql_name.as_str());
        if extension.lifecycle.create_extension {
            let version = version.ok_or_else(|| {
                anyhow!(
                    "extension {} creates a SQL extension but has no source-owned default-version metadata",
                    extension.id
                )
            })?;
            let control = extension.control.as_mut().ok_or_else(|| {
                anyhow!(
                    "extension {} creates a SQL extension but has no structural control metadata",
                    extension.id
                )
            })?;
            control.default_version = Some(version.clone());
        } else {
            ensure!(
                version.is_none(),
                "module-only extension {} must not declare a control default-version",
                extension.id
            );
        }
    }
    Ok(())
}

fn source_owned_default_versions() -> Result<BTreeMap<String, String>> {
    source_owned_default_versions_at(Path::new("."))
}

fn source_owned_default_versions_at(repository_root: &Path) -> Result<BTreeMap<String, String>> {
    let mut versions = BTreeMap::new();
    let contrib_path = repository_root.join(CONTRIB_MANIFEST_PATH);
    let contrib_text = fs::read_to_string(&contrib_path)
        .with_context(|| format!("read {}", contrib_path.display()))?;
    let contrib: ContribSourceManifest = toml::from_str(&contrib_text)
        .with_context(|| format!("parse {}", contrib_path.display()))?;
    for row in contrib.extensions {
        let Some(version) = row.default_version else {
            continue;
        };
        validate_default_version(&version, &format!("{} {}", contrib_path.display(), row.id))?;
        let previous = versions.insert(row.sql_name.clone(), version);
        ensure!(
            previous.is_none(),
            "{} repeats default-version metadata for {}",
            contrib_path.display(),
            row.sql_name
        );
    }

    let external_root = repository_root.join(EXTERNAL_EXTENSION_RECIPE_ROOT);
    let mut source_paths = fs::read_dir(&external_root)
        .with_context(|| format!("read {}", external_root.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("source.toml"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    source_paths.sort();
    for source_path in source_paths {
        let text = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        let source: ExternalSourceMetadata =
            toml::from_str(&text).with_context(|| format!("parse {}", source_path.display()))?;
        let Some(control) = source.extension_control else {
            continue;
        };
        validate_default_version(
            &control.default_version,
            &format!("{} extension-control", source_path.display()),
        )?;
        ensure!(
            !control.source_path.is_empty() && !Path::new(&control.source_path).is_absolute(),
            "{} extension-control.source-path must be a non-empty relative path",
            source_path.display()
        );
        let expected_control_file = Path::new(EXTERNAL_EXTENSION_CHECKOUT_ROOT)
            .join(&source.name)
            .join(&control.source_path)
            .to_string_lossy()
            .replace('\\', "/");
        let catalog_control_file = read_source_catalog_at(repository_root)?
            .extensions
            .into_iter()
            .find(|extension| extension.sql_name == control.sql_name)
            .and_then(|extension| extension.control_file);
        ensure!(
            catalog_control_file.as_deref() == Some(expected_control_file.as_str()),
            "{} extension-control provenance resolves to {}, but {} declares {:?}",
            source_path.display(),
            expected_control_file,
            SOURCE_CATALOG_PATH,
            catalog_control_file
        );
        if let Some(source_default_version) = control.source_default_version.as_deref() {
            ensure!(
                source_default_version == "@EXTVERSION@",
                "{} has unsupported templated source default-version {source_default_version:?}",
                source_path.display()
            );
        }
        let previous = versions.insert(control.sql_name.clone(), control.default_version);
        ensure!(
            previous.is_none(),
            "source metadata repeats default-version for {}",
            control.sql_name
        );
    }
    Ok(versions)
}

fn validate_default_version(version: &str, context: &str) -> Result<()> {
    ensure!(
        !version.is_empty()
            && version.len() <= 128
            && !version.contains("--")
            && version
                .chars()
                .all(|character| character.is_ascii_alphanumeric()
                    || matches!(character, '.' | '_' | '-')),
        "{context} has invalid literal default-version {version:?}"
    );
    Ok(())
}

fn catalog_inputs() -> Vec<CatalogInput> {
    vec![
        CatalogInput {
            name: "postgres18-source".to_owned(),
            path: "src/postgres/versions/18/source.toml".to_owned(),
        },
        CatalogInput {
            name: "extension-catalog".to_owned(),
            path: SOURCE_CATALOG_PATH.to_owned(),
        },
        CatalogInput {
            name: "postgres-contrib".to_owned(),
            path: CONTRIB_MANIFEST_PATH.to_owned(),
        },
        CatalogInput {
            name: "external-extension-recipes".to_owned(),
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
    ]
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
                extension.source_kind != "oliphaunt-plugin",
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
            "extension catalog is missing required Oliphaunt extension {required}"
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

fn api_native_support_modules(
    extension: &ExtensionCatalogEntry,
) -> Result<Vec<(String, Option<String>)>> {
    Ok(wasix_native_support_modules(&extension.sql_name)?
        .into_iter()
        .map(|module| {
            (
                module.runtime_path,
                extension
                    .promotion
                    .stable
                    .then(|| format!("extension:{}:{}", extension.sql_name, module.name)),
            )
        })
        .collect())
}

fn wasix_native_support_modules(sql_name: &str) -> Result<Vec<NativeSupportModuleSpec>> {
    let mut modules = wasix_target_recipe(sql_name)?
        .map(|recipe| recipe.native_support_modules)
        .unwrap_or_default();
    modules.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(modules)
}

fn wasix_target_recipe(sql_name: &str) -> Result<Option<ExtensionTargetRecipe>> {
    let path = Path::new(EXTERNAL_EXTENSION_RECIPE_ROOT)
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

fn runtime_provided_sql_extensions() -> &'static [&'static str] {
    &["plpgsql"]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    build_script: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    required_build_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    required_build_globs: Vec<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    native_support_modules: Vec<NativeSupportModuleSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    excluded_sql_extensions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staging: Option<ExtensionStagingSpec>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
    smoke: ExtensionSmokeEvidence,
    tests: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct ExtensionTargetRecipe {
    #[serde(default)]
    build_kind: Option<String>,
    #[serde(default)]
    build_script: Option<String>,
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
    native_dependencies: Vec<String>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
    #[serde(default)]
    smoke: ExtensionSmokeEvidence,
    tests: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_module_file: Option<String>,
    #[serde(default)]
    promotion: PromotionStatus,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
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
struct ContribSourceManifest {
    #[serde(default)]
    extensions: Vec<ContribSourceExtension>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ContribSourceExtension {
    id: String,
    sql_name: String,
    #[serde(default)]
    default_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ExternalSourceMetadata {
    name: String,
    #[serde(default)]
    extension_control: Option<ExternalExtensionControl>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ExternalExtensionControl {
    sql_name: String,
    source_path: String,
    #[serde(default)]
    source_default_version: Option<String>,
    default_version: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn build_plan_entry_for_manifest_metadata_test() -> ExtensionBuildPlanEntry {
        ExtensionBuildPlanEntry {
            id: "vector".to_owned(),
            sql_name: "vector".to_owned(),
            display_name: "pgvector".to_owned(),
            source_kind: "oliphaunt-other-extension".to_owned(),
            build_kind: "pgxs-external".to_owned(),
            build_script: None,
            required_build_files: Vec::new(),
            required_build_globs: Vec::new(),
            source_dir: "target/oliphaunt-sources/checkouts/pgvector".to_owned(),
            make_args: Vec::new(),
            contrib_dir: None,
            module_file: Some("vector.so".to_owned()),
            archive: "extensions/vector.tar.zst".to_owned(),
            control_file: Some(
                "target/oliphaunt-sources/checkouts/pgvector/vector.control".to_owned(),
            ),
            stable: true,
            dependencies: vec!["plpgsql".to_owned()],
            native_dependencies: vec!["runtime:oliphaunt".to_owned()],
            native_support_modules: Vec::new(),
            excluded_sql_extensions: Vec::new(),
            staging: None,
            load_order: vec!["vector".to_owned()],
            lifecycle: ExtensionLifecycle {
                create_extension: true,
                create_schema: Some("extensions".to_owned()),
                load_sql: vec!["select 1".to_owned()],
                post_create_sql: vec!["select 2".to_owned()],
                startup_config: vec!["shared_preload_libraries=vector".to_owned()],
                preload_required: true,
                restart_required: true,
                shared_memory_required: false,
            },
            smoke: ExtensionSmokeEvidence {
                direct: "passed".to_owned(),
                server: "passed".to_owned(),
                restart: "passed".to_owned(),
                dump_restore: "passed".to_owned(),
            },
            tests: vec!["src/extensions/tests/vector.test.ts".to_owned()],
        }
    }

    #[test]
    fn extension_build_plan_tsv_freshness_is_checkout_line_ending_stable() {
        let expected = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\tstable\namcheck\tamcheck\tamcheck\tamcheck.so\textensions/amcheck.tar.zst\ttrue\n";
        let windows_checkout = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\tstable\r\namcheck\tamcheck\tamcheck\tamcheck.so\textensions/amcheck.tar.zst\ttrue\r\n";

        assert!(extension_build_plan_tsv_matches_source_control(
            windows_checkout,
            expected
        ));
    }

    #[test]
    fn generated_catalog_versions_are_merged_from_non_generated_source_metadata() -> Result<()> {
        assert_ne!(SOURCE_CATALOG_PATH, CATALOG_PATH);
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let source_catalog = read_source_catalog_at(&repo_root)?;
        let versions = source_owned_default_versions_at(&repo_root)?;
        let generated_text = fs::read_to_string(repo_root.join(CATALOG_PATH))?;
        let catalog: ExtensionCatalog = serde_json::from_str(&generated_text)?;

        assert!(source_catalog.generated_from.is_empty());
        assert!(source_catalog.extensions.iter().all(|extension| {
            extension
                .control
                .as_ref()
                .and_then(|control| control.default_version.as_ref())
                .is_none()
        }));

        assert_eq!(
            catalog
                .generated_from
                .iter()
                .find(|input| input.name == "extension-catalog")
                .map(|input| input.path.as_str()),
            Some(SOURCE_CATALOG_PATH)
        );
        assert!(
            !catalog.generated_from.iter().any(|input| {
                input.name == "postgres-contrib" && input.path == POSTGRES_CONTRIB
            })
        );
        for extension in catalog.extensions {
            let generated = extension
                .control
                .as_ref()
                .and_then(|control| control.default_version.as_ref());
            assert_eq!(generated, versions.get(&extension.sql_name));
            if let Some(version) = generated {
                assert!(!version.contains('@'));
            }
        }
        Ok(())
    }

    #[test]
    fn build_plan_manifest_metadata_preserves_runtime_contract() {
        let metadata =
            manifest_metadata_from_build_plan_entry(build_plan_entry_for_manifest_metadata_test());

        assert_eq!(metadata.source_kind, "oliphaunt-other-extension");
        assert_eq!(
            metadata.control_files,
            vec!["target/oliphaunt-sources/checkouts/pgvector/vector.control"]
        );
        assert_eq!(metadata.dependencies, vec!["plpgsql"]);
        assert_eq!(metadata.native_dependencies, vec!["runtime:oliphaunt"]);
        assert_eq!(metadata.load_order, vec!["vector"]);
        assert!(metadata.lifecycle.create_extension);
        assert_eq!(
            metadata.lifecycle.create_schema.as_deref(),
            Some("extensions")
        );
        assert_eq!(metadata.lifecycle.load_sql, vec!["select 1"]);
        assert_eq!(metadata.lifecycle.post_create_sql, vec!["select 2"]);
        assert!(metadata.lifecycle.preload_required);
        assert!(metadata.lifecycle.restart_required);
        assert!(!metadata.lifecycle.shared_memory_required);
        assert!(metadata.smoke_status.promoted);
        assert_eq!(metadata.smoke_status.direct, "passed");
        assert_eq!(metadata.smoke_status.server, "passed");
        assert_eq!(metadata.smoke_status.restart, "passed");
        assert_eq!(metadata.smoke_status.dump_restore, "passed");
    }

    #[test]
    fn build_plan_manifest_metadata_requires_all_smoke_evidence_for_promoted() {
        let mut entry = build_plan_entry_for_manifest_metadata_test();
        entry.smoke.restart = "not-run".to_owned();

        let metadata = manifest_metadata_from_build_plan_entry(entry);

        assert!(!metadata.smoke_status.promoted);
        assert_eq!(metadata.smoke_status.restart, "not-run");

        let mut entry = build_plan_entry_for_manifest_metadata_test();
        entry.smoke.dump_restore = "not-run".to_owned();

        let metadata = manifest_metadata_from_build_plan_entry(entry);

        assert!(!metadata.smoke_status.promoted);
        assert_eq!(metadata.smoke_status.dump_restore, "not-run");
    }

    #[test]
    fn generated_postgis_build_spec_preserves_wasix_target_recipe_metadata() -> Result<()> {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let specs = promoted_build_specs_from_generated_plan_at(&repo_root.join(BUILD_PLAN_PATH))?;
        let postgis = specs
            .iter()
            .find(|extension| extension.sql_name == "postgis")
            .expect("postgis must be a promoted build spec");

        assert_eq!(postgis.build_kind, "autotools");
        assert_eq!(
            postgis.build_script.as_deref(),
            Some("src/extensions/external/postgis/tools/build_wasix.sh")
        );
        assert_eq!(
            postgis.required_build_files,
            vec![
                "postgis/postgis-3.so",
                "postgis/liboliphaunt_postgis_deps.so",
                "extensions/postgis/postgis.control",
                "share/proj/proj.db",
            ]
        );
        assert_eq!(
            postgis.required_build_globs,
            vec!["extensions/postgis/sql/postgis--*.sql"]
        );
        assert_eq!(
            postgis
                .native_support_modules
                .iter()
                .map(|module| module.name.as_str())
                .collect::<Vec<_>>(),
            vec!["postgis_deps"]
        );
        assert!(
            postgis
                .excluded_sql_extensions
                .contains(&"postgis_raster".to_owned())
        );

        let staging = postgis
            .staging
            .as_ref()
            .expect("postgis must declare WASIX staging metadata");
        assert_eq!(
            staging.module_source_dir.as_deref(),
            Some("postgis/postgis")
        );
        assert_eq!(
            staging.control_source.as_deref(),
            Some("postgis/extensions/postgis/postgis.control")
        );
        assert_eq!(
            staging.sql_source_dir.as_deref(),
            Some("postgis/extensions/postgis/sql")
        );
        assert_eq!(staging.data_dirs.len(), 1);
        assert_eq!(staging.data_dirs[0].source, "postgis/share/proj");
        assert_eq!(staging.data_dirs[0].destination, "share/proj");
        Ok(())
    }
}
