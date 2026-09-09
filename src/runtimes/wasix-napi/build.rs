use std::path::{Path, PathBuf};

const RELEASE_INPUT_ENVS: &[&str] = &[
    "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD",
    "OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR",
    "OLIPHAUNT_WASM_GENERATED_AOT_DIR",
    "OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT",
    "OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS",
];

fn main() {
    napi_build::setup();
    for name in RELEASE_INPUT_ENVS {
        println!("cargo::rerun-if-env-changed={name}");
    }
    println!("cargo::rustc-env=OLIPHAUNT_WASIX_NAPI_ABI_VERSION=1");
    validate_release_inputs();
}

fn validate_release_inputs() {
    if std::env::var_os("CARGO_FEATURE_RELEASE").is_none() {
        return;
    }
    assert!(
        matches!(
            std::env::var("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").as_deref(),
            Ok("1")
        ),
        "WASIX N-API release builds must set OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1",
    );

    let portable = required_directory("OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR");
    for relative in [
        "manifest.json",
        "oliphaunt.wasix.tar.zst",
        "bin/initdb.wasix.wasm",
        "cluster-seeds/standard.tar.zst",
        "cluster-seeds/standard.json",
    ] {
        required_file(&portable.join(relative), "portable WASIX release payload");
    }

    let target = std::env::var("TARGET").expect("Cargo provides TARGET");
    let aot_root = required_directory("OLIPHAUNT_WASM_GENERATED_AOT_DIR");
    let target_aot = if aot_root.ends_with(&target) {
        aot_root
    } else {
        aot_root.join(&target)
    };
    required_file(
        &target_aot.join("manifest.json"),
        "target WASIX core AOT manifest",
    );

    let extension_root = required_directory("OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT");
    assert!(
        std::fs::read_dir(&extension_root)
            .expect("read exact WASIX extension artifact root")
            .next()
            .is_some(),
        "exact WASIX extension artifact root {} must not be empty",
        extension_root.display(),
    );
    let inventory = required_path("OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS");
    required_file(&inventory, "validated WASIX N-API build-input inventory");
    println!("cargo::rerun-if-changed={}", inventory.display());

    // Require the exact core payload manifests relayed by the SDK build.
    let target_suffix = match target.as_str() {
        "aarch64-apple-darwin" => "MACOS_ARM64",
        "aarch64-unknown-linux-gnu" => "LINUX_ARM64_GNU",
        "x86_64-unknown-linux-gnu" => "LINUX_X64_GNU",
        "x86_64-pc-windows-msvc" => "WINDOWS_X64_MSVC",
        other => panic!("unsupported WASIX N-API release target {other}"),
    };
    for name in [
        "DEP_OLIPHAUNT_ARTIFACT_WASIX_RELAY_LIBOLIPHAUNT_WASIX_RUNTIME_MANIFEST".to_owned(),
        format!(
            "DEP_OLIPHAUNT_ARTIFACT_WASIX_RELAY_LIBOLIPHAUNT_WASIX_AOT_{target_suffix}_MANIFEST"
        ),
    ] {
        required_env_file(&name, "relayed WASIX Cargo artifact manifest");
    }
}

fn required_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("WASIX N-API release builds require {name}"))
}

fn required_directory(name: &str) -> PathBuf {
    let path = required_path(name);
    let metadata = std::fs::symlink_metadata(&path)
        .unwrap_or_else(|error| panic!("inspect {name} {}: {error}", path.display()));
    assert!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "{name} must be a regular non-symlink directory: {}",
        path.display(),
    );
    path
}

fn required_file(path: &Path, label: &str) {
    let metadata = std::fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("inspect {label} {}: {error}", path.display()));
    assert!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0,
        "{label} must be a non-empty regular non-symlink file: {}",
        path.display(),
    );
}

fn required_env_file(name: &str, label: &str) {
    println!("cargo::rerun-if-env-changed={name}");
    let path = required_path(name);
    required_file(&path, label);
    println!("cargo::rerun-if-changed={}", path.display());
}
