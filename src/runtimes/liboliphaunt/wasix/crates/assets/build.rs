use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_WASM_GENERATED_ASSETS_DIR");
    emit_expected_asset_inputs();

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let out = out_dir.join("generated_assets.rs");

    if let Some(asset_dir) = find_asset_dir() {
        emit_rerun_directives(&asset_dir);
        write_generated_assets(&out, &asset_dir);
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
    if let Some(path) = env::var_os("OLIPHAUNT_WASM_GENERATED_ASSETS_DIR") {
        let path = PathBuf::from(path);
        if path.join("manifest.json").is_file() {
            return Some(path);
        }
    }

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    if let Some(repo_root) = repo_root_from_manifest_dir(&manifest_dir) {
        let target_assets = repo_root.join("target/oliphaunt-wasix/assets");
        if target_assets.join("manifest.json").is_file() {
            return Some(target_assets);
        }
    }

    let package_payload = manifest_dir.join("payload");
    if package_payload.join("manifest.json").is_file() {
        return Some(package_payload);
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

    let mut extension_cases = String::new();
    let extension_dir = asset_dir.join("extensions");
    if extension_dir.is_dir() {
        let mut archives = fs::read_dir(&extension_dir)
            .expect("read generated extension directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("zst"))
            .collect::<Vec<_>>();
        archives.sort();
        for archive in archives {
            let Some(file_name) = archive.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(sql_name) = file_name.strip_suffix(".tar.zst") else {
                continue;
            };
            extension_cases.push_str(&format!(
                "        {:?} => Some(include_bytes!({})),\n",
                sql_name,
                rust_string_literal(&archive)
            ));
        }
    }
    extension_cases.push_str("        _ => None,\n");

    let text = format!(
        "pub const HAS_EMBEDDED_ASSETS: bool = true;\n\
         pub const MANIFEST_JSON: &str = include_str!({manifest});\n\
         pub fn runtime_archive() -> Option<&'static [u8]> {{ Some(include_bytes!({runtime})) }}\n\
         pub fn pgdata_template_archive() -> Option<&'static [u8]> {{ {pgdata_archive_body} }}\n\
         pub fn pgdata_template_manifest() -> Option<&'static [u8]> {{ {pgdata_manifest_body} }}\n\
         pub fn pg_dump_wasm() -> Option<&'static [u8]> {{ {pg_dump_body} }}\n\
         pub fn initdb_wasm() -> Option<&'static [u8]> {{ Some(include_bytes!({initdb})) }}\n\
         #[rustfmt::skip]\n\
         pub fn extension_archive(name: &str) -> Option<&'static [u8]> {{\n\
             match name {{\n\
         {extension_cases}    }}\n\
         }}\n",
        manifest = rust_string_literal(&manifest),
        runtime = rust_string_literal(&runtime),
        pgdata_archive_body = pgdata_archive_body,
        pgdata_manifest_body = pgdata_manifest_body,
        pg_dump_body = pg_dump_body,
        initdb = rust_string_literal(&initdb),
    );
    fs::write(out, text).expect("write generated asset include module");
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
