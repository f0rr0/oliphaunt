use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "oliphaunt-wasix-tools";
const ARTIFACT_KIND: &str = "wasix-tools";
const ARTIFACT_TARGET: &str = "portable";

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASM_GENERATED_ASSETS_DIR");
    emit_expected_asset_inputs();

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let out = out_dir.join("generated_tools.rs");
    if let Some(asset_dir) = find_asset_dir() {
        emit_rerun_directives(&asset_dir);
        write_generated_tools(&out, &asset_dir);
    } else if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("release packaging requires package-local WASIX tools payload");
    } else {
        write_source_only_tools(&out);
    }
}

fn emit_expected_asset_inputs() {
    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_ASSETS_DIR") {
        emit_tool_probes(&PathBuf::from(path));
    }

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        emit_tool_probes(&repo_root.join("target/oliphaunt-wasix/assets"));
    }
    emit_tool_probes(&manifest_dir.join("payload"));
}

fn emit_tool_probes(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        dir.join("bin/pg_dump.wasix.wasm").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        dir.join("bin/psql.wasix.wasm").display()
    );
}

fn find_asset_dir() -> Option<PathBuf> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let package_payload = manifest_dir.join("payload");
    if package_payload.join("bin/pg_dump.wasix.wasm").is_file()
        && package_payload.join("bin/psql.wasix.wasm").is_file()
    {
        return Some(package_payload);
    }

    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_ASSETS_DIR") {
        let path = PathBuf::from(path);
        if path.join("bin/pg_dump.wasix.wasm").is_file()
            && path.join("bin/psql.wasix.wasm").is_file()
        {
            return Some(path);
        }
    }

    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        let target_assets = repo_root.join("target/oliphaunt-wasix/assets");
        if target_assets.join("bin/pg_dump.wasix.wasm").is_file()
            && target_assets.join("bin/psql.wasix.wasm").is_file()
        {
            return Some(target_assets);
        }
    }
    None
}

fn repo_root_from_manifest_dir(manifest_dir: &Path) -> Option<PathBuf> {
    for ancestor in manifest_dir.ancestors() {
        if ancestor.join(".git").exists() && ancestor.join("Cargo.toml").is_file() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
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

fn write_generated_tools(out: &Path, asset_dir: &Path) {
    let pg_dump = asset_dir.join("bin/pg_dump.wasix.wasm");
    let psql = asset_dir.join("bin/psql.wasix.wasm");
    for required in [&pg_dump, &psql] {
        assert!(
            required.is_file(),
            "generated WASIX tools directory {} is missing required file {}",
            asset_dir.display(),
            required.display()
        );
    }
    let text = format!(
        "pub const HAS_EMBEDDED_TOOLS: bool = true;\n\
         pub fn pg_dump_wasm() -> Option<&'static [u8]> {{ Some(include_bytes!({pg_dump})) }}\n\
         pub fn psql_wasm() -> Option<&'static [u8]> {{ Some(include_bytes!({psql})) }}\n",
        pg_dump = rust_string_literal(&pg_dump),
        psql = rust_string_literal(&psql),
    );
    fs::write(out, text).expect("write generated WASIX tool include module");
    emit_artifact_manifest(
        out.parent().expect("generated tool output has parent"),
        asset_dir,
        &[&pg_dump, &psql],
    );
}

fn write_source_only_tools(out: &Path) {
    fs::write(
        out,
        "pub const HAS_EMBEDDED_TOOLS: bool = false;\n\
         pub fn pg_dump_wasm() -> Option<&'static [u8]> { None }\n\
         pub fn psql_wasm() -> Option<&'static [u8]> { None }\n",
    )
    .expect("write source-only WASIX tool include module");
}

fn rust_string_literal(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}

fn emit_artifact_manifest(out_dir: &Path, asset_dir: &Path, files: &[&Path]) {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let manifest_path = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {ARTIFACT_SCHEMA:?}\nproduct = {ARTIFACT_PRODUCT:?}\nversion = {version:?}\nkind = {ARTIFACT_KIND:?}\ntarget = {ARTIFACT_TARGET:?}\n"
    );
    for file in files {
        let relative = file
            .strip_prefix(asset_dir)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| {
                file.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let sha256 = sha256_file(file).expect("hash WASIX tools artifact file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            relative,
            sha256,
        ));
    }
    fs::write(&manifest_path, text).expect("write WASIX tools Cargo artifact manifest");
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
