use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "liboliphaunt-wasix";
const ARTIFACT_KIND: &str = "wasix-runtime";
const ARTIFACT_TARGET: &str = "portable";

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASM_GENERATED_ASSETS_DIR");
    emit_expected_asset_inputs();

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let out = out_dir.join("generated_assets.rs");

    if let Some(asset_dir) = find_asset_dir() {
        emit_rerun_directives(&asset_dir);
        write_generated_assets(&out, &asset_dir);
    } else if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("release packaging requires package-local WASIX runtime payload");
    } else {
        write_source_only_assets(&out);
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

fn write_generated_assets(out: &Path, asset_dir: &Path) {
    let manifest = asset_dir.join("manifest.json");
    let generated_manifest = out
        .parent()
        .expect("generated asset output has parent")
        .join("manifest.json");
    write_core_manifest(&manifest, &generated_manifest);
    let runtime = asset_dir.join("oliphaunt.wasix.tar.zst");
    let pgdata_archive = asset_dir.join("prepopulated/pgdata-template.tar.zst");
    let pgdata_manifest = asset_dir.join("prepopulated/pgdata-template.json");
    let pg_dump = asset_dir.join("bin/pg_dump.wasix.wasm");
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
    let pg_dump_body = optional_include_bytes_body(&pg_dump);

    let text = format!(
        "pub const HAS_EMBEDDED_ASSETS: bool = true;\n\
         pub const MANIFEST_JSON: &str = include_str!({manifest});\n\
         pub fn runtime_archive() -> Option<&'static [u8]> {{ Some(include_bytes!({runtime})) }}\n\
         pub fn pgdata_template_archive() -> Option<&'static [u8]> {{ {pgdata_archive_body} }}\n\
         pub fn pgdata_template_manifest() -> Option<&'static [u8]> {{ {pgdata_manifest_body} }}\n\
         pub fn pg_dump_wasm() -> Option<&'static [u8]> {{ {pg_dump_body} }}\n\
         pub fn initdb_wasm() -> Option<&'static [u8]> {{ Some(include_bytes!({initdb})) }}\n\
         pub fn extension_archive(_name: &str) -> Option<&'static [u8]> {{ None }}\n",
        manifest = rust_string_literal(&generated_manifest),
        runtime = rust_string_literal(&runtime),
        pgdata_archive_body = pgdata_archive_body,
        pgdata_manifest_body = pgdata_manifest_body,
        pg_dump_body = pg_dump_body,
        initdb = rust_string_literal(&initdb),
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
            &pg_dump,
            &initdb,
        ],
    );
}

fn write_source_only_assets(out: &Path) {
    let text = r##"pub const HAS_EMBEDDED_ASSETS: bool = false;
pub const MANIFEST_JSON: &str = r#"{"format-version":1,"runtime":{"archive":"","sha256":"","module-sha256":"","postgres-version":"","runtime-kind":"source-only-template"},"runtime-support":[],"pg-dump":null,"extensions":[],"sources":[]}"#;
pub fn runtime_archive() -> Option<&'static [u8]> { None }
pub fn pgdata_template_archive() -> Option<&'static [u8]> { None }
pub fn pgdata_template_manifest() -> Option<&'static [u8]> { None }
pub fn pg_dump_wasm() -> Option<&'static [u8]> { None }
pub fn initdb_wasm() -> Option<&'static [u8]> { None }
pub fn extension_archive(_name: &str) -> Option<&'static [u8]> { None }
"##;
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

fn write_core_manifest(source: &Path, destination: &Path) {
    let text = fs::read_to_string(source).expect("read generated WASIX asset manifest");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).expect("parse generated WASIX asset manifest");
    manifest["extensions"] = serde_json::Value::Array(Vec::new());
    let rendered =
        serde_json::to_string_pretty(&manifest).expect("serialize core WASIX asset manifest");
    fs::write(destination, format!("{rendered}\n")).expect("write core WASIX asset manifest");
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
