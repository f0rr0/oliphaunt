use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "liboliphaunt-wasix";
const ARTIFACT_KIND: &str = "wasix-runtime";
const ARTIFACT_TARGET: &str = "portable";

#[derive(Debug, Clone, Copy)]
struct ExtensionPackage {
    #[allow(dead_code)]
    feature: &'static str,
    env: &'static str,
    product: &'static str,
    sql_name: &'static str,
    crate_ident: &'static str,
}

#[derive(Debug)]
struct SelectedExtension {
    package: ExtensionPackage,
    archive: ExtensionArchiveSource,
    aot_packages: Vec<SelectedExtensionAotPackage>,
}

#[derive(Debug)]
enum ExtensionArchiveSource {
    Crate,
    Local {
        path: PathBuf,
        sha256: String,
        size: u64,
    },
    Missing,
}

#[derive(Debug, Clone, Copy)]
struct ExtensionAotTarget {
    id: &'static str,
    target: &'static str,
    cfg: &'static str,
}

#[derive(Debug)]
struct SelectedExtensionAotPackage {
    target: ExtensionAotTarget,
    source: ExtensionAotSource,
}

#[derive(Debug)]
enum ExtensionAotSource {
    Crate {
        crate_ident: String,
    },
    Local {
        manifest: PathBuf,
        artifacts: Vec<LocalExtensionAotArtifact>,
    },
}

#[derive(Debug)]
struct LocalExtensionAotArtifact {
    name: String,
    path: PathBuf,
}

const EXTENSION_AOT_TARGETS: &[ExtensionAotTarget] = &[
    ExtensionAotTarget {
        id: "macos-arm64",
        target: "aarch64-apple-darwin",
        cfg: r#"all(target_os = "macos", target_arch = "aarch64")"#,
    },
    ExtensionAotTarget {
        id: "linux-arm64-gnu",
        target: "aarch64-unknown-linux-gnu",
        cfg: r#"all(target_os = "linux", target_arch = "aarch64", target_env = "gnu")"#,
    },
    ExtensionAotTarget {
        id: "linux-x64-gnu",
        target: "x86_64-unknown-linux-gnu",
        cfg: r#"all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")"#,
    },
    ExtensionAotTarget {
        id: "windows-x64-msvc",
        target: "x86_64-pc-windows-msvc",
        cfg: r#"all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")"#,
    },
];

const EXTENSION_PACKAGES: &[ExtensionPackage] = &[
    ExtensionPackage {
        feature: "extension-amcheck",
        env: "CARGO_FEATURE_EXTENSION_AMCHECK",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "amcheck",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-auto-explain",
        env: "CARGO_FEATURE_EXTENSION_AUTO_EXPLAIN",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "auto_explain",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-bloom",
        env: "CARGO_FEATURE_EXTENSION_BLOOM",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "bloom",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-btree-gin",
        env: "CARGO_FEATURE_EXTENSION_BTREE_GIN",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "btree_gin",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-btree-gist",
        env: "CARGO_FEATURE_EXTENSION_BTREE_GIST",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "btree_gist",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-citext",
        env: "CARGO_FEATURE_EXTENSION_CITEXT",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "citext",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-cube",
        env: "CARGO_FEATURE_EXTENSION_CUBE",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "cube",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-dict-int",
        env: "CARGO_FEATURE_EXTENSION_DICT_INT",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "dict_int",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-dict-xsyn",
        env: "CARGO_FEATURE_EXTENSION_DICT_XSYN",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "dict_xsyn",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-earthdistance",
        env: "CARGO_FEATURE_EXTENSION_EARTHDISTANCE",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "earthdistance",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-file-fdw",
        env: "CARGO_FEATURE_EXTENSION_FILE_FDW",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "file_fdw",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-fuzzystrmatch",
        env: "CARGO_FEATURE_EXTENSION_FUZZYSTRMATCH",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "fuzzystrmatch",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-hstore",
        env: "CARGO_FEATURE_EXTENSION_HSTORE",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "hstore",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-intarray",
        env: "CARGO_FEATURE_EXTENSION_INTARRAY",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "intarray",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-isn",
        env: "CARGO_FEATURE_EXTENSION_ISN",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "isn",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-lo",
        env: "CARGO_FEATURE_EXTENSION_LO",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "lo",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-ltree",
        env: "CARGO_FEATURE_EXTENSION_LTREE",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "ltree",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pageinspect",
        env: "CARGO_FEATURE_EXTENSION_PAGEINSPECT",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pageinspect",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-buffercache",
        env: "CARGO_FEATURE_EXTENSION_PG_BUFFERCACHE",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_buffercache",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-freespacemap",
        env: "CARGO_FEATURE_EXTENSION_PG_FREESPACEMAP",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_freespacemap",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-surgery",
        env: "CARGO_FEATURE_EXTENSION_PG_SURGERY",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_surgery",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-trgm",
        env: "CARGO_FEATURE_EXTENSION_PG_TRGM",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_trgm",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-visibility",
        env: "CARGO_FEATURE_EXTENSION_PG_VISIBILITY",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_visibility",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-walinspect",
        env: "CARGO_FEATURE_EXTENSION_PG_WALINSPECT",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pg_walinspect",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pgcrypto",
        env: "CARGO_FEATURE_EXTENSION_PGCRYPTO",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "pgcrypto",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-seg",
        env: "CARGO_FEATURE_EXTENSION_SEG",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "seg",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-tablefunc",
        env: "CARGO_FEATURE_EXTENSION_TABLEFUNC",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "tablefunc",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-tcn",
        env: "CARGO_FEATURE_EXTENSION_TCN",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "tcn",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-tsm-system-rows",
        env: "CARGO_FEATURE_EXTENSION_TSM_SYSTEM_ROWS",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "tsm_system_rows",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-tsm-system-time",
        env: "CARGO_FEATURE_EXTENSION_TSM_SYSTEM_TIME",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "tsm_system_time",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-unaccent",
        env: "CARGO_FEATURE_EXTENSION_UNACCENT",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "unaccent",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-uuid-ossp",
        env: "CARGO_FEATURE_EXTENSION_UUID_OSSP",
        product: "oliphaunt-extension-contrib-pg18",
        sql_name: "uuid-ossp",
        crate_ident: "oliphaunt_extension_contrib_pg18",
    },
    ExtensionPackage {
        feature: "extension-pg-hashids",
        env: "CARGO_FEATURE_EXTENSION_PG_HASHIDS",
        product: "oliphaunt-extension-pg-hashids",
        sql_name: "pg_hashids",
        crate_ident: "oliphaunt_extension_pg_hashids",
    },
    ExtensionPackage {
        feature: "extension-pg-ivm",
        env: "CARGO_FEATURE_EXTENSION_PG_IVM",
        product: "oliphaunt-extension-pg-ivm",
        sql_name: "pg_ivm",
        crate_ident: "oliphaunt_extension_pg_ivm",
    },
    ExtensionPackage {
        feature: "extension-pg-textsearch",
        env: "CARGO_FEATURE_EXTENSION_PG_TEXTSEARCH",
        product: "oliphaunt-extension-pg-textsearch",
        sql_name: "pg_textsearch",
        crate_ident: "oliphaunt_extension_pg_textsearch",
    },
    ExtensionPackage {
        feature: "extension-pg-uuidv7",
        env: "CARGO_FEATURE_EXTENSION_PG_UUIDV7",
        product: "oliphaunt-extension-pg-uuidv7",
        sql_name: "pg_uuidv7",
        crate_ident: "oliphaunt_extension_pg_uuidv7",
    },
    ExtensionPackage {
        feature: "extension-pgtap",
        env: "CARGO_FEATURE_EXTENSION_PGTAP",
        product: "oliphaunt-extension-pgtap",
        sql_name: "pgtap",
        crate_ident: "oliphaunt_extension_pgtap",
    },
    ExtensionPackage {
        feature: "extension-postgis",
        env: "CARGO_FEATURE_EXTENSION_POSTGIS",
        product: "oliphaunt-extension-postgis",
        sql_name: "postgis",
        crate_ident: "oliphaunt_extension_postgis",
    },
    ExtensionPackage {
        feature: "extension-vector",
        env: "CARGO_FEATURE_EXTENSION_VECTOR",
        product: "oliphaunt-extension-vector",
        sql_name: "vector",
        crate_ident: "oliphaunt_extension_vector",
    },
];

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASM_GENERATED_ASSETS_DIR");
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT");
    for package in EXTENSION_PACKAGES {
        println!("cargo:rerun-if-env-changed={}", package.env);
    }
    emit_expected_asset_inputs();

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let out = out_dir.join("generated_assets.rs");
    let manifest_text =
        fs::read_to_string(manifest_dir.join("Cargo.toml")).expect("read Cargo.toml");
    let selected_extensions = selected_extensions(&manifest_dir, &manifest_text);

    if let Some(asset_dir) = find_asset_dir() {
        emit_rerun_directives(&asset_dir);
        write_generated_assets(&out, &asset_dir, &selected_extensions);
    } else if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("release packaging requires package-local WASIX runtime payload");
    } else {
        write_source_only_assets(&out, &selected_extensions);
    }
}

fn emit_expected_asset_inputs() {
    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_ASSETS_DIR") {
        emit_manifest_probe(&PathBuf::from(path));
    }

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        emit_manifest_probe(&repo_root.join("target/oliphaunt-wasix/assets"));
    }
    emit_manifest_probe(&manifest_dir.join("payload"));
}

fn emit_manifest_probe(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        dir.join("manifest.json").display()
    );
}

fn find_asset_dir() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let package_payload = manifest_dir.join("payload");
    if package_payload.join("manifest.json").is_file() {
        return Some(package_payload);
    }

    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_ASSETS_DIR") {
        let path = PathBuf::from(path);
        if path.join("manifest.json").is_file() {
            return Some(path);
        }
    }

    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        let target_assets = repo_root.join("target/oliphaunt-wasix/assets");
        if target_assets.join("manifest.json").is_file() {
            return Some(target_assets);
        }
    }

    None
}

fn repo_root_from_manifest_dir(manifest_dir: &Path) -> Option<&Path> {
    manifest_dir.ancestors().find(|candidate| {
        candidate.join("Cargo.toml").is_file()
            && candidate
                .join("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml")
                .is_file()
    })
}

fn emit_rerun_directives(asset_dir: &Path) {
    println!("cargo:rerun-if-changed={}", asset_dir.display());
    visit_files(asset_dir, &mut |path| {
        println!("cargo:rerun-if-changed={}", path.display());
    });
}

fn visit_files(path: &Path, f: &mut impl FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_files(&path, f);
        } else if path.is_file() {
            f(&path);
        }
    }
}

fn write_generated_assets(out: &Path, asset_dir: &Path, selected_extensions: &[SelectedExtension]) {
    let manifest = asset_dir.join("manifest.json");
    let generated_manifest = out
        .parent()
        .expect("generated asset output has parent")
        .join("manifest.json");
    write_core_manifest(&manifest, &generated_manifest, selected_extensions);
    let runtime = asset_dir.join("oliphaunt.wasix.tar.zst");
    let pgdata_archive = asset_dir.join("prepopulated/pgdata-template.tar.zst");
    let pgdata_manifest = asset_dir.join("prepopulated/pgdata-template.json");
    let initdb = asset_dir.join("bin/initdb.wasix.wasm");

    for required in [&manifest, &runtime, &initdb] {
        assert!(
            required.is_file(),
            "generated asset directory {} is missing required file {}",
            asset_dir.display(),
            required.display()
        );
    }
    assert!(
        pgdata_archive.is_file() && pgdata_manifest.is_file(),
        "generated asset directory {} is missing the required PGDATA template; expected both {} and {}",
        asset_dir.display(),
        pgdata_archive.display(),
        pgdata_manifest.display()
    );

    let pgdata_archive_body = optional_include_bytes_body(&pgdata_archive);
    let pgdata_manifest_body = optional_include_bytes_body(&pgdata_manifest);
    let extension_sql_names = selected_extension_sql_names_body(selected_extensions);
    let extension_aot_sql_names = selected_extension_aot_sql_names_body(selected_extensions);
    let extension_archive_body = extension_archive_body(selected_extensions);
    let extension_sha256_body = expected_extension_archive_sha256_body(selected_extensions);
    let extension_aot_manifest_body = extension_aot_manifest_json_body(selected_extensions);
    let extension_aot_bytes_body = extension_aot_artifact_bytes_body(selected_extensions);

    let text = format!(
        "pub const HAS_EMBEDDED_ASSETS: bool = true;\n\
         pub const SELECTED_EXTENSION_SQL_NAMES: &[&str] = {extension_sql_names};\n\
         pub const SELECTED_EXTENSION_AOT_SQL_NAMES: &[&str] = {extension_aot_sql_names};\n\
         pub const MANIFEST_JSON: &str = include_str!({manifest});\n\
         pub fn runtime_archive() -> Option<&'static [u8]> {{ Some(include_bytes!({runtime})) }}\n\
         pub fn pgdata_template_archive() -> Option<&'static [u8]> {{ {pgdata_archive_body} }}\n\
         pub fn pgdata_template_manifest() -> Option<&'static [u8]> {{ {pgdata_manifest_body} }}\n\
         pub fn initdb_wasm() -> Option<&'static [u8]> {{ Some(include_bytes!({initdb})) }}\n\
         pub fn extension_archive(name: &str) -> Option<&'static [u8]> {{\n{extension_archive_body}         }}\n\
         pub fn expected_extension_archive_sha256(name: &str) -> Option<&'static str> {{\n{extension_sha256_body}         }}\n\
         #[allow(clippy::match_single_binding)] // Target cfgs can remove every generated match arm.\n\
         pub fn extension_aot_manifest_json(target: &str, sql_name: &str) -> Option<&'static str> {{\n{extension_aot_manifest_body}         }}\n\
         pub fn extension_aot_artifact_bytes(target: &str, name: &str) -> Option<&'static [u8]> {{\n{extension_aot_bytes_body}         }}\n",
        manifest = rust_string_literal(&generated_manifest),
        runtime = rust_string_literal(&runtime),
        pgdata_archive_body = pgdata_archive_body,
        pgdata_manifest_body = pgdata_manifest_body,
        initdb = rust_string_literal(&initdb),
        extension_sql_names = extension_sql_names,
        extension_aot_sql_names = extension_aot_sql_names,
        extension_archive_body = extension_archive_body,
        extension_sha256_body = extension_sha256_body,
        extension_aot_manifest_body = extension_aot_manifest_body,
        extension_aot_bytes_body = extension_aot_bytes_body,
    );
    fs::write(out, text).expect("write generated asset include module");
    emit_artifact_manifest(
        out.parent().expect("generated asset output has parent"),
        asset_dir,
        &[
            &generated_manifest,
            &runtime,
            &pgdata_archive,
            &pgdata_manifest,
            &initdb,
        ],
    );
}

fn write_source_only_assets(out: &Path, selected_extensions: &[SelectedExtension]) {
    let extension_sql_names = selected_extension_sql_names_body(selected_extensions);
    let extension_aot_sql_names = selected_extension_aot_sql_names_body(selected_extensions);
    let extension_archive_body = extension_archive_body(selected_extensions);
    let extension_sha256_body = expected_extension_archive_sha256_body(selected_extensions);
    let extension_aot_manifest_body = extension_aot_manifest_json_body(selected_extensions);
    let extension_aot_bytes_body = extension_aot_artifact_bytes_body(selected_extensions);
    let mut text = format!(
        "pub const HAS_EMBEDDED_ASSETS: bool = false;\n\
         pub const SELECTED_EXTENSION_SQL_NAMES: &[&str] = {extension_sql_names};\n\
         pub const SELECTED_EXTENSION_AOT_SQL_NAMES: &[&str] = {extension_aot_sql_names};\n"
    );
    text.push_str(
        r##"pub const MANIFEST_JSON: &str = r#"{"format-version":1,"runtime":{"archive":"","sha256":"","module-sha256":"","postgres-version":"","runtime-kind":"source-only-template"},"runtime-support":[],"extensions":[],"sources":[]}"#;
pub fn runtime_archive() -> Option<&'static [u8]> { None }
pub fn pgdata_template_archive() -> Option<&'static [u8]> { None }
pub fn pgdata_template_manifest() -> Option<&'static [u8]> { None }
pub fn initdb_wasm() -> Option<&'static [u8]> { None }
"##,
    );
    text.push_str(&format!(
        "pub fn extension_archive(name: &str) -> Option<&'static [u8]> {{\n\
{extension_archive_body}}}\n\
         pub fn expected_extension_archive_sha256(name: &str) -> Option<&'static str> {{\n\
{extension_sha256_body}}}\n\
         #[allow(clippy::match_single_binding)] // Target cfgs can remove every generated match arm.\n\
         pub fn extension_aot_manifest_json(target: &str, sql_name: &str) -> Option<&'static str> {{\n\
{extension_aot_manifest_body}}}\n\
         pub fn extension_aot_artifact_bytes(target: &str, name: &str) -> Option<&'static [u8]> {{\n\
{extension_aot_bytes_body}}}\n"
    ));
    fs::write(out, text).expect("write source-only asset include module");
}

fn rust_string_literal(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}

fn optional_include_bytes_body(path: &Path) -> String {
    if path.is_file() {
        format!("Some(include_bytes!({}))", rust_string_literal(path))
    } else {
        "None".to_owned()
    }
}

fn write_core_manifest(
    source: &Path,
    destination: &Path,
    selected_extensions: &[SelectedExtension],
) {
    let text = fs::read_to_string(source).expect("read generated WASIX asset manifest");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).expect("parse generated WASIX asset manifest");
    manifest["extensions"] = serde_json::Value::Array(
        selected_extensions
            .iter()
            .filter_map(extension_manifest_entry)
            .collect(),
    );
    let object = manifest
        .as_object_mut()
        .expect("generated WASIX asset manifest is an object");
    object.remove("pg-dump");
    object.remove("psql");
    let rendered =
        serde_json::to_string_pretty(&manifest).expect("serialize core WASIX asset manifest");
    fs::write(destination, format!("{rendered}\n")).expect("write core WASIX asset manifest");
}

fn selected_extensions(manifest_dir: &Path, manifest_text: &str) -> Vec<SelectedExtension> {
    let repo_root = repo_root_from_manifest_dir(manifest_dir).map(Path::to_path_buf);
    EXTENSION_PACKAGES
        .iter()
        .copied()
        .filter_map(|package| {
            env::var_os(package.env)?;
            let archive_package = extension_wasix_package_name(package);
            let archive = if manifest_declares_dependency(manifest_text, &archive_package) {
                ExtensionArchiveSource::Crate
            } else if let Some(path) =
                find_local_extension_archive(manifest_dir, repo_root.as_deref(), package)
            {
                println!("cargo:rerun-if-changed={}", path.display());
                let sha256 =
                    sha256_file(&path).expect("hash selected local WASIX extension archive");
                let size = path
                    .metadata()
                    .expect("stat selected local WASIX extension archive")
                    .len();
                ExtensionArchiveSource::Local { path, sha256, size }
            } else {
                if let Some(root) = env::var_os("OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT") {
                    panic!(
                        "explicit local extension artifact root {} is missing the canonical WASIX archive for selected extension {}",
                        Path::new(&root).display(),
                        package.sql_name,
                    );
                }
                ExtensionArchiveSource::Missing
            };
            let aot_packages = selected_extension_aot_packages(manifest_text, package);
            Some(SelectedExtension {
                package,
                archive,
                aot_packages,
            })
        })
        .collect()
}

fn selected_extension_aot_packages(
    manifest_text: &str,
    package: ExtensionPackage,
) -> Vec<SelectedExtensionAotPackage> {
    let dependencies = EXTENSION_AOT_TARGETS
        .iter()
        .copied()
        .filter_map(|target| {
            let package_name = extension_aot_package_name(package, target);
            manifest_declares_dependency(manifest_text, &package_name).then(|| {
                SelectedExtensionAotPackage {
                    target,
                    source: ExtensionAotSource::Crate {
                        crate_ident: crate_ident(&package_name),
                    },
                }
            })
        })
        .collect::<Vec<_>>();
    if !dependencies.is_empty() {
        return dependencies;
    }
    local_extension_aot_package(package).into_iter().collect()
}

fn local_extension_aot_package(package: ExtensionPackage) -> Option<SelectedExtensionAotPackage> {
    let root = PathBuf::from(env::var_os("OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT")?);
    let product_root = root.join(package.product);
    let product_manifest = product_root.join("extension-artifacts.json");
    let product_value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&product_manifest).unwrap_or_else(|error| {
            panic!(
                "read local extension artifact manifest {}: {error}",
                product_manifest.display()
            )
        }),
    )
    .unwrap_or_else(|error| {
        panic!(
            "parse local extension artifact manifest {}: {error}",
            product_manifest.display()
        )
    });
    assert_eq!(
        product_value
            .get("product")
            .and_then(serde_json::Value::as_str),
        Some(package.product),
        "local extension artifact manifest {} has the wrong product",
        product_manifest.display(),
    );
    let schema = product_value
        .get("schema")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| {
            panic!(
                "local extension artifact manifest {} has no schema",
                product_manifest.display()
            )
        });
    let member = match schema {
        "oliphaunt-extension-ci-artifacts-v1" => {
            assert_eq!(
                product_value
                    .get("sqlName")
                    .and_then(serde_json::Value::as_str),
                Some(package.sql_name),
                "local extension artifact manifest {} has the wrong SQL name",
                product_manifest.display(),
            );
            &product_value
        }
        "oliphaunt-extension-ci-artifacts-v2" => product_value
            .get("extensions")
            .and_then(serde_json::Value::as_array)
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.get("sqlName").and_then(serde_json::Value::as_str) == Some(package.sql_name)
                })
            })
            .unwrap_or_else(|| {
                panic!(
                    "local extension artifact manifest {} lacks bundle member {}",
                    product_manifest.display(),
                    package.sql_name
                )
            }),
        other => panic!(
            "local extension artifact manifest {} has unsupported schema {other}",
            product_manifest.display()
        ),
    };
    let requires_aot = match member.get("nativeModuleStem") {
        Some(serde_json::Value::String(value)) if !value.is_empty() => true,
        Some(serde_json::Value::Null) => false,
        other => panic!(
            "local extension artifact manifest {} has invalid nativeModuleStem {other:?}",
            product_manifest.display(),
        ),
    };
    if !requires_aot {
        return None;
    }

    let build_target = env::var("TARGET").expect("Cargo sets TARGET for build scripts");
    let target = EXTENSION_AOT_TARGETS
        .iter()
        .copied()
        .find(|target| target.target == build_target)
        .unwrap_or_else(|| panic!("unsupported local extension AOT build target {build_target}"));
    let target_root = product_root.join("wasix-aot").join(target.id);
    let aot_dir = if schema == "oliphaunt-extension-ci-artifacts-v2" {
        target_root.join(package.sql_name)
    } else {
        target_root
    };
    let manifest = aot_dir.join("manifest.json");
    let manifest_value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).unwrap_or_else(|error| {
            panic!(
                "read local extension AOT manifest {}: {error}",
                manifest.display()
            )
        }))
        .unwrap_or_else(|error| {
            panic!(
                "parse local extension AOT manifest {}: {error}",
                manifest.display()
            )
        });
    assert_eq!(
        manifest_value
            .get("format-version")
            .and_then(serde_json::Value::as_u64),
        Some(1),
        "local extension AOT manifest {} has an unsupported format",
        manifest.display(),
    );
    assert_eq!(
        manifest_value
            .get("target-triple")
            .and_then(serde_json::Value::as_str),
        Some(target.target),
        "local extension AOT manifest {} targets the wrong platform",
        manifest.display(),
    );
    let rows = manifest_value
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| {
            panic!(
                "local extension AOT manifest {} has no artifacts",
                manifest.display()
            )
        });
    let mut names = BTreeSet::new();
    let mut artifacts = Vec::new();
    for row in rows {
        let name = row
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| {
                panic!(
                    "local extension AOT manifest {} has an artifact without a name",
                    manifest.display()
                )
            });
        let expected_prefix = format!("extension:{}", package.sql_name);
        assert!(
            name == expected_prefix || name.starts_with(&format!("{expected_prefix}:")),
            "local extension AOT manifest {} contains foreign artifact {name}",
            manifest.display(),
        );
        assert!(
            names.insert(name.to_owned()),
            "local extension AOT manifest {} repeats artifact {name}",
            manifest.display()
        );
        let relative = row
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(Path::new)
            .unwrap_or_else(|| {
                panic!(
                    "local extension AOT manifest {} has an artifact without a path",
                    manifest.display()
                )
            });
        assert!(
            !relative.is_absolute()
                && relative
                    .components()
                    .all(|component| matches!(component, Component::Normal(_))),
            "local extension AOT manifest {} contains unsafe path {}",
            manifest.display(),
            relative.display(),
        );
        let artifact = aot_dir.join(relative);
        assert!(
            artifact.is_file(),
            "local extension AOT manifest {} references missing {}",
            manifest.display(),
            artifact.display()
        );
        let expected_sha256 = row
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .unwrap_or_else(|| {
                panic!(
                    "local extension AOT manifest {} has an invalid artifact sha256",
                    manifest.display()
                )
            });
        let actual_sha256 = sha256_file(&artifact).unwrap_or_else(|error| {
            panic!(
                "hash local extension AOT artifact {}: {error}",
                artifact.display()
            )
        });
        assert_eq!(
            actual_sha256,
            expected_sha256,
            "local extension AOT artifact {} does not match its manifest",
            artifact.display()
        );
        println!("cargo:rerun-if-changed={}", artifact.display());
        artifacts.push(LocalExtensionAotArtifact {
            name: name.to_owned(),
            path: artifact,
        });
    }
    println!("cargo:rerun-if-changed={}", product_manifest.display());
    println!("cargo:rerun-if-changed={}", manifest.display());
    Some(SelectedExtensionAotPackage {
        target,
        source: ExtensionAotSource::Local {
            manifest,
            artifacts,
        },
    })
}

fn extension_aot_package_name(package: ExtensionPackage, target: ExtensionAotTarget) -> String {
    let suffix = match target.id {
        "macos-arm64" => "macos-arm64",
        "linux-arm64-gnu" => "linux-arm64",
        "linux-x64-gnu" => "linux-x64",
        "windows-x64-msvc" => "windows-x64",
        other => panic!("unsupported extension AOT target id {other}"),
    };
    format!("{}-aot-{suffix}", package.product)
}

fn extension_wasix_package_name(package: ExtensionPackage) -> String {
    format!("{}-wasix", package.product)
}

fn crate_ident(package_name: &str) -> String {
    package_name.replace('-', "_")
}

fn manifest_declares_dependency(manifest_text: &str, package_name: &str) -> bool {
    manifest_text
        .lines()
        .any(|line| line.trim_start().starts_with(&format!("{package_name} =")))
}

fn find_local_extension_archive(
    manifest_dir: &Path,
    repo_root: Option<&Path>,
    package: ExtensionPackage,
) -> Option<PathBuf> {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let archive_name = format!("{}-{version}-wasix-portable.tar.zst", package.product);
    let roots = if let Some(path) = env::var_os("OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT") {
        // An explicit root binds qualification to exact same-run inputs. Do not
        // silently fall back to stale workspace or package-cache artifacts.
        vec![PathBuf::from(path)]
    } else {
        let mut roots = Vec::new();
        if let Some(repo_root) = repo_root {
            roots.push(repo_root.join("target/extension-artifacts"));
            roots.push(
                repo_root
                    .join("target/local-registry-artifacts/oliphaunt-extension-package-artifacts"),
            );
        }
        roots.push(manifest_dir.join("extension-artifacts"));
        roots
    };

    for root in roots {
        for candidate in [
            root.join(package.product)
                .join("member-assets")
                .join(package.sql_name)
                .join(&archive_name),
            root.join(package.product)
                .join("release-assets")
                .join(&archive_name),
            root.join("oliphaunt-extension-package-artifacts")
                .join(package.product)
                .join("member-assets")
                .join(package.sql_name)
                .join(&archive_name),
            root.join("oliphaunt-extension-package-artifacts")
                .join(package.product)
                .join("release-assets")
                .join(&archive_name),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn selected_extension_sql_names_body(selected_extensions: &[SelectedExtension]) -> String {
    let sql_names = selected_extensions
        .iter()
        .map(|extension| format!("{:?}", extension.package.sql_name))
        .collect::<Vec<_>>()
        .join(", ");
    format!("&[{sql_names}]")
}

fn selected_extension_aot_sql_names_body(selected_extensions: &[SelectedExtension]) -> String {
    let sql_names = selected_extensions
        .iter()
        .filter(|extension| !extension.aot_packages.is_empty())
        .map(|extension| format!("{:?}", extension.package.sql_name))
        .collect::<Vec<_>>()
        .join(", ");
    format!("&[{sql_names}]")
}

fn extension_archive_body(selected_extensions: &[SelectedExtension]) -> String {
    if selected_extensions.is_empty() {
        return "            let _ = name;\n            None\n".to_owned();
    }
    let mut body = String::from("            match name {\n");
    for extension in selected_extensions {
        let sql_name = extension.package.sql_name;
        let expression = match &extension.archive {
            ExtensionArchiveSource::Crate => {
                format!(
                    "{}::archive({sql_name:?})",
                    extension_wasix_crate_ident(extension.package),
                )
            }
            ExtensionArchiveSource::Local { path, .. } => {
                format!("Some(include_bytes!({}))", rust_string_literal(path))
            }
            ExtensionArchiveSource::Missing => "None".to_owned(),
        };
        body.push_str(&format!("                {sql_name:?} => {expression},\n"));
    }
    body.push_str("                _ => None,\n            }\n");
    body
}

fn expected_extension_archive_sha256_body(selected_extensions: &[SelectedExtension]) -> String {
    if selected_extensions.is_empty() {
        return "            let _ = name;\n            None\n".to_owned();
    }
    let mut body = String::from("            match name {\n");
    for extension in selected_extensions {
        let sql_name = extension.package.sql_name;
        let expression = match &extension.archive {
            ExtensionArchiveSource::Crate => {
                format!(
                    "{}::archive_sha256({sql_name:?})",
                    extension_wasix_crate_ident(extension.package),
                )
            }
            ExtensionArchiveSource::Local { sha256, .. } => {
                format!("Some({sha256:?})")
            }
            ExtensionArchiveSource::Missing => "None".to_owned(),
        };
        body.push_str(&format!("                {sql_name:?} => {expression},\n"));
    }
    body.push_str("                _ => None,\n            }\n");
    body
}

fn extension_aot_manifest_json_body(selected_extensions: &[SelectedExtension]) -> String {
    let mut body = String::from("            match (target, sql_name) {\n");
    for extension in selected_extensions {
        let sql_name = extension.package.sql_name;
        for aot in &extension.aot_packages {
            let expression = match &aot.source {
                ExtensionAotSource::Crate { crate_ident } => {
                    format!("{crate_ident}::aot_manifest_json({sql_name:?})")
                }
                ExtensionAotSource::Local { manifest, .. } => {
                    format!("Some(include_str!({}))", rust_string_literal(manifest))
                }
            };
            body.push_str(&format!(
                "                #[cfg({})]\n                ({:?}, {:?}) => {expression},\n",
                aot.target.cfg, aot.target.target, sql_name,
            ));
        }
    }
    body.push_str("                _ => None,\n            }\n");
    body
}

fn extension_aot_artifact_bytes_body(selected_extensions: &[SelectedExtension]) -> String {
    let mut body = String::from("            let _ = (target, name);\n");
    let mut emitted_crates = BTreeSet::new();
    for extension in selected_extensions {
        for aot in &extension.aot_packages {
            match &aot.source {
                ExtensionAotSource::Crate { crate_ident } => {
                    if !emitted_crates.insert((aot.target.target, crate_ident.as_str())) {
                        continue;
                    }
                    body.push_str(&format!(
                        "            #[cfg({})]\n            if target == {:?} {{\n                if let Some(bytes) = {}::aot_artifact_bytes(name) {{\n                    return Some(bytes);\n                }}\n            }}\n",
                        aot.target.cfg,
                        aot.target.target,
                        crate_ident,
                    ));
                }
                ExtensionAotSource::Local { artifacts, .. } => {
                    body.push_str(&format!(
                        "            #[cfg({})]\n            if target == {:?} {{\n                match name {{\n",
                        aot.target.cfg,
                        aot.target.target,
                    ));
                    for artifact in artifacts {
                        body.push_str(&format!(
                            "                    {:?} => return Some(include_bytes!({})),\n",
                            artifact.name,
                            rust_string_literal(&artifact.path),
                        ));
                    }
                    body.push_str(
                        "                    _ => {}\n                }\n            }\n",
                    );
                }
            }
        }
    }
    body.push_str("            None\n");
    body
}

fn extension_manifest_entry(extension: &SelectedExtension) -> Option<serde_json::Value> {
    match &extension.archive {
        ExtensionArchiveSource::Local { sha256, size, .. } => Some(serde_json::json!({
            "name": extension.package.sql_name,
            "sql-name": extension.package.sql_name,
            "archive": format!("extensions/{}.tar.zst", extension.package.sql_name),
            "sha256": sha256,
            "size": size,
        })),
        ExtensionArchiveSource::Crate | ExtensionArchiveSource::Missing => None,
    }
}

fn extension_wasix_crate_ident(package: ExtensionPackage) -> String {
    format!("{}_wasix", package.crate_ident)
}

fn emit_artifact_manifest(out_dir: &Path, asset_dir: &Path, files: &[&Path]) {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let manifest_path = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {ARTIFACT_SCHEMA:?}\nproduct = {ARTIFACT_PRODUCT:?}\nversion = {version:?}\nkind = {ARTIFACT_KIND:?}\ntarget = {ARTIFACT_TARGET:?}\n"
    );
    for file in files {
        if !file.is_file() {
            continue;
        }
        let relative = file
            .strip_prefix(asset_dir)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "manifest.json".to_owned());
        let sha256 = sha256_file(file).expect("hash WASIX runtime artifact file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            relative,
            sha256,
        ));
    }
    fs::write(&manifest_path, text).expect("write WASIX runtime Cargo artifact manifest");
    println!("cargo::metadata=manifest={}", manifest_path.display());
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
