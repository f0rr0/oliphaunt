use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "liboliphaunt-wasix";
const ARTIFACT_KIND: &str = "wasix-aot";

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASM_GENERATED_AOT_DIR");

    let target = env::var("CARGO_PKG_NAME")
        .expect("CARGO_PKG_NAME is set by Cargo")
        .strip_prefix("liboliphaunt-wasix-aot-")
        .expect("AOT crate name starts with liboliphaunt-wasix-aot-")
        .to_owned();
    emit_expected_artifact_inputs(&target);

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("generated_aot.rs");
    if let Some(artifact_dir) = find_artifact_dir(&target) {
        emit_rerun_directives(&artifact_dir);
        write_generated_aot(&out, &target, &artifact_dir);
    } else if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("release packaging requires package-local WASIX AOT artifacts for {target}");
    } else {
        write_source_only_aot(&out, &target);
    }
}

fn emit_expected_artifact_inputs(target: &str) {
    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_AOT_DIR") {
        let path = PathBuf::from(path);
        let candidate = if path.ends_with(target) {
            path
        } else {
            path.join(target)
        };
        emit_manifest_probe(&candidate);
    }

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        emit_manifest_probe(&repo_root.join("target/oliphaunt-wasix/aot").join(target));
    }
    emit_manifest_probe(&manifest_dir.join("artifacts"));
}

fn emit_manifest_probe(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        dir.join("manifest.json").display()
    );
}

fn find_artifact_dir(target: &str) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let package_artifacts = manifest_dir.join("artifacts");
    if package_artifacts.join("manifest.json").is_file() {
        return Some(package_artifacts);
    }

    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_AOT_DIR") {
        let path = PathBuf::from(path);
        let candidate = if path.ends_with(target) {
            path
        } else {
            path.join(target)
        };
        if candidate.join("manifest.json").is_file() {
            return Some(candidate);
        }
    }

    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        let target_artifacts = repo_root.join("target/oliphaunt-wasix/aot").join(target);
        if target_artifacts.join("manifest.json").is_file() {
            return Some(target_artifacts);
        }
    }

    None
}

fn repo_root_from_manifest_dir(manifest_dir: &Path) -> Option<&Path> {
    manifest_dir.ancestors().find(|candidate| {
        candidate.join("Cargo.toml").is_file()
            && candidate
                .join("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml")
                .is_file()
    })
}

fn emit_rerun_directives(artifact_dir: &Path) {
    println!("cargo:rerun-if-changed={}", artifact_dir.display());
    if let Ok(entries) = fs::read_dir(artifact_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn write_generated_aot(out: &Path, target: &str, artifact_dir: &Path) {
    let manifest = artifact_dir.join("manifest.json");
    let generated_manifest = out
        .parent()
        .expect("generated AOT output has parent")
        .join("manifest.json");
    let retained_paths = write_core_aot_manifest(&manifest, &generated_manifest);
    let mut cases = String::new();
    if let Ok(entries) = fs::read_dir(artifact_dir) {
        let mut files = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("zst"))
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            let Some(file_name) = file.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(stem) = file_name.strip_suffix("-llvm-opta.bin.zst") else {
                continue;
            };
            let artifact_name = artifact_name_from_file_stem(stem);
            if artifact_name.starts_with("extension:") {
                continue;
            }
            cases.push_str(&format!(
                "        {:?} => Some(include_bytes!({})),\n",
                artifact_name,
                rust_string_literal(&file)
            ));
        }
    }
    cases.push_str("        _ => None,\n");

    let text = format!(
        "pub const TARGET_TRIPLE: &str = {:?};\n\
         pub const ENGINE: &str = \"llvm-opta\";\n\
         pub const HAS_EMBEDDED_AOT: bool = true;\n\
         pub const MANIFEST_JSON: &str = include_str!({});\n\
         #[rustfmt::skip]\n\
         pub fn artifact_bytes(name: &str) -> Option<&'static [u8]> {{\n\
             match name {{\n\
         {cases}    }}\n\
         }}\n",
        target,
        rust_string_literal(&generated_manifest)
    );
    fs::write(out, text).expect("write generated AOT include module");
    let mut manifest_files = vec![generated_manifest];
    for relative in retained_paths {
        manifest_files.push(artifact_dir.join(relative));
    }
    emit_artifact_manifest(
        out.parent().expect("generated AOT output has parent"),
        target,
        artifact_dir,
        &manifest_files,
    );
}

fn write_source_only_aot(out: &Path, target: &str) {
    let manifest = format!(
        "{{\"format-version\":1,\"target-triple\":{target:?},\"engine\":\"llvm-opta\",\"wasmer-version\":\"7.2.0-alpha.3\",\"wasmer-wasix-version\":\"0.702.0-alpha.3\",\"artifacts\":[]}}"
    );
    let text = format!(
        "pub const TARGET_TRIPLE: &str = {target:?};\n\
         pub const ENGINE: &str = \"llvm-opta\";\n\
         pub const HAS_EMBEDDED_AOT: bool = false;\n\
         pub const MANIFEST_JSON: &str = r#\"{manifest}\"#;\n\
         pub fn artifact_bytes(_name: &str) -> Option<&'static [u8]> {{ None }}\n"
    );
    fs::write(out, text).expect("write source-only AOT include module");
}

fn artifact_name_from_file_stem(stem: &str) -> String {
    match stem {
        "oliphaunt" => "runtime:oliphaunt".to_owned(),
        "pg_dump" => "tool:pg_dump".to_owned(),
        "initdb" => "tool:initdb".to_owned(),
        "plpgsql" => "runtime-support:plpgsql".to_owned(),
        "dict_snowball" => "runtime-support:dict_snowball".to_owned(),
        extension_support if extension_support.ends_with("_deps") => {
            let sql_name = extension_support.trim_end_matches("_deps");
            format!("extension:{sql_name}:{extension_support}")
        }
        extension => format!("extension:{extension}"),
    }
}

fn rust_string_literal(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}

fn write_core_aot_manifest(source: &Path, destination: &Path) -> Vec<String> {
    let text = fs::read_to_string(source).expect("read generated WASIX AOT manifest");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).expect("parse generated WASIX AOT manifest");
    let artifacts = manifest
        .get_mut("artifacts")
        .and_then(|value| value.as_array_mut())
        .expect("generated WASIX AOT manifest has artifacts array");
    let mut retained = Vec::new();
    let mut paths = Vec::new();
    for artifact in artifacts.drain(..) {
        let name = artifact
            .get("name")
            .and_then(|value| value.as_str())
            .expect("AOT artifact has name")
            .to_owned();
        if name.starts_with("extension:") {
            continue;
        }
        let path = artifact
            .get("path")
            .and_then(|value| value.as_str())
            .expect("AOT artifact has path")
            .to_owned();
        paths.push(path);
        retained.push(artifact);
    }
    *artifacts = retained;
    let rendered =
        serde_json::to_string_pretty(&manifest).expect("serialize core WASIX AOT manifest");
    fs::write(destination, format!("{rendered}\n")).expect("write core WASIX AOT manifest");
    paths
}

fn emit_artifact_manifest(out_dir: &Path, target: &str, artifact_dir: &Path, files: &[PathBuf]) {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let manifest_path = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {ARTIFACT_SCHEMA:?}\nproduct = {ARTIFACT_PRODUCT:?}\nversion = {version:?}\nkind = {ARTIFACT_KIND:?}\ntarget = {target:?}\n"
    );
    for file in files {
        if !file.is_file() {
            continue;
        }
        let relative = file
            .strip_prefix(artifact_dir)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "manifest.json".to_owned());
        let sha256 = sha256_file(file).expect("hash WASIX AOT artifact file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            relative,
            sha256,
        ));
    }
    fs::write(&manifest_path, text).expect("write WASIX AOT Cargo artifact manifest");
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
