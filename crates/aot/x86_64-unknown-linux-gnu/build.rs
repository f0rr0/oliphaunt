use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PGLITE_OXIDE_GENERATED_AOT_DIR");

    let target = env::var("CARGO_PKG_NAME")
        .expect("CARGO_PKG_NAME is set by Cargo")
        .strip_prefix("pglite-oxide-aot-")
        .expect("AOT crate name starts with pglite-oxide-aot-")
        .to_owned();
    emit_expected_artifact_inputs(&target);

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("generated_aot.rs");
    if let Some(artifact_dir) = find_artifact_dir(&target) {
        emit_rerun_directives(&artifact_dir);
        write_generated_aot(&out, &target, &artifact_dir);
    } else {
        write_source_only_aot(&out, &target);
    }
}

fn emit_expected_artifact_inputs(target: &str) {
    if let Some(path) = env::var_os("PGLITE_OXIDE_GENERATED_AOT_DIR") {
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
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    if let Some(repo_root) = repo_root {
        emit_manifest_probe(&repo_root.join("target/pglite-oxide/aot").join(target));
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
    if let Some(path) = env::var_os("PGLITE_OXIDE_GENERATED_AOT_DIR") {
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

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    if let Some(repo_root) = repo_root {
        let target_artifacts = repo_root.join("target/pglite-oxide/aot").join(target);
        if target_artifacts.join("manifest.json").is_file() {
            return Some(target_artifacts);
        }
    }

    let package_artifacts = manifest_dir.join("artifacts");
    if package_artifacts.join("manifest.json").is_file() {
        return Some(package_artifacts);
    }

    None
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
         pub const MANIFEST_JSON: &str = include_str!({});\n\
         #[rustfmt::skip]\n\
         pub fn artifact_bytes(name: &str) -> Option<&'static [u8]> {{\n\
             match name {{\n\
         {cases}    }}\n\
         }}\n",
        target,
        rust_string_literal(&manifest)
    );
    fs::write(out, text).expect("write generated AOT include module");
}

fn write_source_only_aot(out: &Path, target: &str) {
    let manifest = format!(
        "{{\"format-version\":1,\"target-triple\":{target:?},\"engine\":\"llvm-opta\",\"wasmer-version\":\"7.2.0-alpha.3\",\"wasmer-wasix-version\":\"0.702.0-alpha.3\",\"artifacts\":[]}}"
    );
    let text = format!(
        "pub const TARGET_TRIPLE: &str = {target:?};\n\
         pub const ENGINE: &str = \"llvm-opta\";\n\
         pub const MANIFEST_JSON: &str = r#\"{manifest}\"#;\n\
         pub fn artifact_bytes(_name: &str) -> Option<&'static [u8]> {{ None }}\n"
    );
    fs::write(out, text).expect("write source-only AOT include module");
}

fn artifact_name_from_file_stem(stem: &str) -> String {
    match stem {
        "pglite" => "runtime:pglite".to_owned(),
        "pg_dump" => "tool:pg_dump".to_owned(),
        "initdb" => "tool:initdb".to_owned(),
        "plpgsql" => "runtime-support:plpgsql".to_owned(),
        "dict_snowball" => "runtime-support:dict_snowball".to_owned(),
        extension => format!("extension:{extension}"),
    }
}

fn rust_string_literal(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}
