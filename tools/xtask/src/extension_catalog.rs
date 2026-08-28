use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

const CATALOG_PATH: &str = "src/extensions/generated/extensions.catalog.json";
const SOURCE_CATALOG_PATH: &str = "src/extensions/catalog/extensions.source.json";
const CONTRIB_BUILD_PLAN_PATH: &str = "src/extensions/generated/contrib-build.tsv";
const PGXS_BUILD_PLAN_PATH: &str = "src/extensions/generated/pgxs-build.tsv";
const CONTRIB_MANIFEST_PATH: &str = "src/extensions/contrib/postgres18.toml";
const POSTGRES_CONTRIB: &str = "src/postgres/versions/18/contrib";
const POSTGRES_OTHER_EXTENSIONS: &str = "src/extensions/external";
const EXTERNAL_EXTENSION_RECIPE_ROOT: &str = "src/extensions/external";
const PGVECTOR_CHECKOUT: &str = "target/oliphaunt-sources/checkouts/pgvector";
const EXTERNAL_EXTENSION_CHECKOUT_ROOT: &str = "target/oliphaunt-sources/checkouts";

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
        let matches = extension_build_plan_tsv_matches_source_control(&actual, text);
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
    for required in [SOURCE_CATALOG_PATH, CATALOG_PATH, CONTRIB_MANIFEST_PATH] {
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

fn normalize_extension_catalog_for_source_control(value: serde_json::Value) -> serde_json::Value {
    normalize_generated_inputs_for_source_control(value)
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
    ensure!(
        extension_discovery_inputs_available(false)?,
        "extension manifest metadata requires the extension source catalog and recipes"
    );
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
}

pub(crate) fn extension_build_specs() -> Result<Vec<ExtensionBuildSpec>> {
    ensure!(
        extension_discovery_inputs_available(false)?,
        "extension build specs require the extension source catalog and recipes"
    );
    let catalog = discover_catalog()?;
    validate_catalog(&catalog)?;
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
            dependencies: extension.dependencies.clone(),
            native_support_modules,
            excluded_sql_extensions: wasix_target
                .as_ref()
                .map(|target| target.excluded_sql_extensions.clone())
                .unwrap_or_default(),
            staging: wasix_target.and_then(|target| target.staging),
            load_order: extension.load_order.clone(),
            lifecycle: extension.lifecycle.clone(),
            tests: extension.tests.clone(),
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
    pub(crate) dependencies: Vec<String>,
    pub(crate) native_support_modules: Vec<NativeSupportModuleSpec>,
    pub(crate) excluded_sql_extensions: Vec<String>,
    pub(crate) staging: Option<ExtensionStagingSpec>,
    pub(crate) load_order: Vec<String>,
    pub(crate) lifecycle: ExtensionLifecycle,
    pub(crate) tests: Vec<String>,
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
    let mut contrib_tsv = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\n".to_owned();
    let mut pgxs_tsv = "# id\tsql_name\tsource_dir\tmodule_file\tarchive\tmake_args\n".to_owned();
    for extension in &plan.extensions {
        match extension.build_kind.as_str() {
            "postgres-contrib" => {
                let contrib_dir = extension.contrib_dir.as_deref().ok_or_else(|| {
                    anyhow!("contrib extension {} has no contrib_dir", extension.id)
                })?;
                contrib_tsv.push_str(&format!(
                    "{}\t{}\t{}\t{}\t{}\n",
                    extension.id,
                    extension.sql_name,
                    contrib_dir,
                    extension.module_file.as_deref().unwrap_or("-"),
                    extension.archive
                ));
            }
            kind if is_pgxs_style_build_kind(kind) => {
                pgxs_tsv.push_str(&format!(
                    "{}\t{}\t{}\t{}\t{}\t{}\n",
                    extension.id,
                    extension.sql_name,
                    extension.source_dir,
                    extension.module_file.as_deref().unwrap_or("-"),
                    extension.archive,
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
        contrib_tsv,
        pgxs_tsv,
    })
}

fn build_plan(catalog: &ExtensionCatalog) -> Result<ExtensionBuildPlan> {
    let specs = build_specs(catalog)?;
    Ok(ExtensionBuildPlan {
        format_version: 1,
        generated_from: vec![CatalogInput {
            name: "extension-catalog".to_owned(),
            path: CATALOG_PATH.to_owned(),
        }],
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
                dependencies: spec.dependencies,
                native_support_modules: spec.native_support_modules,
                excluded_sql_extensions: spec.excluded_sql_extensions,
                staging: spec.staging,
                load_order: spec.load_order,
                lifecycle: spec.lifecycle,
                tests: spec.tests,
            })
            .collect(),
    })
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

fn write_generated_extension_api(catalog: &ExtensionCatalog) -> Result<()> {
    validate_wasix_sdk_extension_features(catalog)?;
    let extensions = &catalog.extensions;
    let mut text = String::new();
    text.push_str("// @generated by `cargo run -p xtask -- extensions generate`\n\n");
    text.push_str("use super::Extension;\n\n");

    for extension in extensions {
        let prefix = extension.rust_constant.as_str();
        let definition_const = format!("DEFINITION_{prefix}");
        let feature = wasix_extension_feature(extension);
        let dependencies = api_dependencies(extension);
        let native_support_modules = api_native_support_modules(extension)?;
        let native_modules = native_support_modules
            .iter()
            .map(|(runtime_path, aot_name)| {
                format!(
                    "super::ExtensionNativeModule {{ runtime_path: {runtime_path:?}, aot_name: {} }}",
                    option_string_literal(aot_name.as_deref())
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let aot_name = extension
            .native_module_file
            .as_ref()
            .map(|_| format!("extension:{}", extension.sql_name));
        text.push_str(&format!(
            "#[cfg(feature = {feature:?})]\nconst {definition_const}: Extension = Extension {{\n    sql_name: {:?},\n    native_support_modules: &[{native_modules}],\n    native_module_file: {},\n    aot_name: {},\n    dependencies: &{},\n    startup_config: &{},\n}};\n\n",
            extension.sql_name,
            option_string_literal(extension.native_module_file.as_deref()),
            option_string_literal(aot_name.as_deref()),
            rust_string_array(&dependencies),
            rust_string_array(&extension.lifecycle.startup_config),
        ));
    }

    text.push_str("impl Extension {\n");
    for extension in extensions {
        let prefix = extension.rust_constant.as_str();
        let feature = wasix_extension_feature(extension);
        text.push_str(&format!(
            "    /// Select the `{}` artifact.\n    #[cfg(feature = {feature:?})]\n    pub const {prefix}: Self = DEFINITION_{prefix};\n",
            extension.sql_name
        ));
    }

    let all = extensions
        .iter()
        .map(|extension| {
            format!(
                "        #[cfg(feature = {:?})]\n        Self::{},",
                wasix_extension_feature(extension),
                extension.rust_constant
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    text.push_str(&format!(
        "\n    /// Extension artifacts enabled in this Cargo build.\n    pub const ALL: &'static [Self] = &[\n{all}\n    ];\n}}\n"
    ));

    text.push_str(
        "\n#[cfg(test)]\npub(super) fn creates_database_object_for_test(extension: Extension) -> bool {\n    match extension.sql_name() {\n",
    );
    for extension in extensions {
        let feature = wasix_extension_feature(extension);
        text.push_str(&format!(
            "        #[cfg(feature = {feature:?})]\n        {:?} => {},\n",
            extension.sql_name, extension.lifecycle.create_extension
        ));
    }
    text.push_str("        _ => false,\n    }\n}\n");

    text.push_str(
        "\n#[cfg(test)]\npub(super) fn activation_sql_for_test(extension: Extension) -> &'static [&'static str] {\n    match extension.sql_name() {\n",
    );
    for extension in extensions {
        let feature = wasix_extension_feature(extension);
        let activation_sql = api_test_activation_sql(extension);
        text.push_str(&format!(
            "        #[cfg(feature = {feature:?})]\n        {:?} => &{},\n",
            extension.sql_name,
            rust_string_array(&activation_sql)
        ));
    }
    text.push_str("        _ => &[],\n    }\n}\n");

    let path = Path::new(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/generated_extensions.rs",
    );
    fs::write(path, text).with_context(|| format!("write {}", path.display()))?;
    format_rust_source(path)
}

fn validate_wasix_sdk_extension_features(catalog: &ExtensionCatalog) -> Result<()> {
    let manifest_path = Path::new("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml");
    let manifest_text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: toml::Value = toml::from_str(&manifest_text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let features = manifest
        .get("features")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| anyhow!("{} is missing [features]", manifest_path.display()))?;

    for extension in &catalog.extensions {
        let feature = wasix_extension_feature(extension);
        let members = features
            .get(&feature)
            .and_then(toml::Value::as_array)
            .ok_or_else(|| {
                anyhow!(
                    "{} is missing WASIX SDK feature {feature} for extension {}",
                    manifest_path.display(),
                    extension.sql_name
                )
            })?;
        let members = members
            .iter()
            .filter_map(toml::Value::as_str)
            .collect::<BTreeSet<_>>();
        ensure!(
            members.contains("extensions"),
            "WASIX SDK feature {feature} must enable the extensions carrier"
        );
        let portable_feature = format!("liboliphaunt-wasix-portable/{feature}");
        ensure!(
            members.contains(portable_feature.as_str()),
            "WASIX SDK feature {feature} must enable bundled asset feature {portable_feature}"
        );

        for dependency in api_dependencies(extension) {
            let dependency_extension = catalog
                .extensions
                .iter()
                .find(|candidate| candidate.sql_name == dependency || candidate.id == dependency)
                .ok_or_else(|| {
                    anyhow!(
                        "extension {} has unknown WASIX API dependency {dependency}",
                        extension.sql_name
                    )
                })?;
            let dependency_feature = wasix_extension_feature(dependency_extension);
            ensure!(
                members.contains(dependency_feature.as_str()),
                "WASIX SDK feature {feature} must enable dependency feature {dependency_feature} so Extension::by_sql_name can resolve it"
            );
        }
    }
    Ok(())
}

fn wasix_extension_feature(extension: &ExtensionCatalogEntry) -> String {
    format!("extension-{}", extension.sql_name.replace('_', "-"))
}

fn api_test_activation_sql(extension: &ExtensionCatalogEntry) -> Vec<String> {
    let mut statements = Vec::new();
    if extension.lifecycle.create_extension {
        if let Some(schema) = extension
            .lifecycle
            .create_schema
            .as_deref()
            .filter(|schema| *schema != "pg_catalog")
        {
            statements.push(format!(
                "CREATE SCHEMA IF NOT EXISTS {};",
                quote_sql_identifier(schema)
            ));
        }
        let mut create = format!(
            "CREATE EXTENSION IF NOT EXISTS {}",
            quote_sql_identifier(&extension.sql_name)
        );
        if let Some(schema) = extension.lifecycle.create_schema.as_deref() {
            create.push_str(" WITH SCHEMA ");
            create.push_str(&quote_sql_identifier(schema));
        }
        create.push(';');
        statements.push(create);
    }
    statements.extend(extension.lifecycle.load_sql.iter().cloned());
    statements.extend(extension.lifecycle.post_create_sql.iter().cloned());
    statements
}

fn quote_sql_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
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
            sql_names.insert(extension.sql_name.as_str()),
            "duplicate SQL extension name {}",
            extension.sql_name
        );
        ensure!(
            extension.source_kind != "oliphaunt-plugin",
            "supported extension {} is not a SQL extension",
            extension.id
        );
        ensure!(
            !extension.tests.is_empty(),
            "supported extension {} must have a smoke test source",
            extension.id
        );
        ensure!(
            extension.lifecycle.create_extension || !extension.lifecycle.load_sql.is_empty(),
            "supported extension {} must declare a lifecycle operation",
            extension.id
        );
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
                Some(format!("extension:{}:{}", extension.sql_name, module.name)),
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
    wasix_target_recipe_at(Path::new("."), sql_name)
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

fn runtime_provided_sql_extensions() -> &'static [&'static str] {
    &["plpgsql"]
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
    dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    native_support_modules: Vec<NativeSupportModuleSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    excluded_sql_extensions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staging: Option<ExtensionStagingSpec>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycle,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_build_plan_tsv_freshness_is_checkout_line_ending_stable() {
        let expected = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\namcheck\tamcheck\tamcheck\tamcheck.so\textensions/amcheck.tar.zst\n";
        let windows_checkout = "# id\tsql_name\tcontrib_dir\tmodule_file\tarchive\r\namcheck\tamcheck\tamcheck\tamcheck.so\textensions/amcheck.tar.zst\r\n";

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
    fn generated_postgis_build_spec_preserves_wasix_target_recipe_metadata() -> Result<()> {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let catalog = read_source_catalog_at(&repo_root)?;
        let specs = build_specs_at(&catalog, &repo_root)?;
        let postgis = specs
            .iter()
            .find(|extension| extension.sql_name == "postgis")
            .expect("postgis must be a supported build spec");

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
