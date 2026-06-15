use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};

use super::*;
use crate::asset_io::ensure_aot_manifest_matches_source_lane;

const RELEASE_RELEVANT_UNTRACKED_PATHS: &[&str] = &[
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "src/extensions",
    "src/bindings/wasix-rust",
    "src/runtimes/liboliphaunt/wasix",
    "tools/xtask",
];

pub(super) fn stage_release_workspace() -> Result<()> {
    let stage_root = Path::new(RELEASE_STAGE_DIR);
    let workspace = stage_root.join("workspace");
    if stage_root.exists() {
        fs::remove_dir_all(stage_root)
            .with_context(|| format!("remove {}", stage_root.display()))?;
    }
    fs::create_dir_all(&workspace).with_context(|| format!("create {}", workspace.display()))?;

    ensure_no_unexpected_untracked_release_files()?;
    let tracked = command_output("git", &["ls-files", "-z", "--cached"], Path::new("."))?;
    for path in tracked.split('\0').filter(|path| !path.is_empty()) {
        let source = Path::new(path);
        let destination = workspace.join(path);
        copy_file(source, &destination)?;
    }

    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    let generated_manifest = read_asset_manifest_from(generated_assets)?;
    ensure_packaged_asset_matches_source_lane(&generated_manifest, DEFAULT_SOURCE_LANE)?;
    copy_dir_all(generated_assets, &workspace.join(ASSET_CRATE_PAYLOAD_DIR))?;
    copy_dir_all(generated_assets, &workspace.join(GENERATED_ASSETS_DIR))?;
    update_staged_root_asset_metadata(&workspace)?;

    for target in supported_aot_targets() {
        let generated_aot = generated_aot_dir(target);
        if generated_aot.join("manifest.json").is_file() {
            ensure_aot_manifest_matches_source_lane(
                &generated_aot.join("manifest.json"),
                target,
                DEFAULT_SOURCE_LANE,
            )?;
            copy_dir_all(
                &generated_aot,
                &workspace
                    .join("src/runtimes/liboliphaunt/wasix/crates/aot")
                    .join(target)
                    .join("artifacts"),
            )?;
            copy_dir_all(
                &generated_aot,
                &workspace.join("target/oliphaunt-wasix/aot").join(target),
            )?;
        }
    }

    fs::write(
        stage_root.join("README.txt"),
        "Generated liboliphaunt-wasix release workspace.\n",
    )
    .with_context(|| format!("write {}", stage_root.join("README.txt").display()))?;
    println!("staged release workspace at {}", workspace.display());
    Ok(())
}

fn ensure_no_unexpected_untracked_release_files() -> Result<()> {
    let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard", "--"];
    args.extend(RELEASE_RELEVANT_UNTRACKED_PATHS);
    let untracked = command_output("git", &args, Path::new("."))?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !untracked.is_empty() {
        return Err(anyhow!(
            "WASM release staging refuses untracked release-relevant files; add them to git or move them out of release roots: {}",
            untracked.join(", ")
        ));
    }
    Ok(())
}

pub(super) fn package_release_assets() -> Result<()> {
    let output_dir = Path::new(RELEASE_ASSET_BUNDLE_DIR);
    if output_dir.exists() {
        fs::remove_dir_all(output_dir)
            .with_context(|| format!("remove {}", output_dir.display()))?;
    }
    fs::create_dir_all(output_dir).with_context(|| format!("create {}", output_dir.display()))?;

    let version = wasix_runtime_release_version()?;
    let mut bundles = Vec::new();
    bundles.push(package_release_portable_assets(output_dir, &version)?);
    for target in supported_aot_targets() {
        bundles.push(package_release_aot_assets(output_dir, target, &version)?);
    }

    let mut checksum_lines = Vec::new();
    for bundle in &bundles {
        let name = bundle
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                anyhow!(
                    "release asset path is not valid UTF-8: {}",
                    bundle.display()
                )
            })?;
        checksum_lines.push(format!("{}  {name}", sha256_file(bundle)?));
    }
    checksum_lines.sort();
    let checksum_path = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-release-assets.sha256"
    ));
    fs::write(&checksum_path, format!("{}\n", checksum_lines.join("\n")))
        .with_context(|| format!("write {}", checksum_path.display()))?;

    println!("packaged public release assets in {}", output_dir.display());
    Ok(())
}

fn package_release_portable_assets(output_dir: &Path, version: &str) -> Result<PathBuf> {
    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    let manifest = read_asset_manifest_from(generated_assets)?;
    ensure_packaged_asset_matches_source_lane(&manifest, DEFAULT_SOURCE_LANE)?;
    ensure_file(Path::new(ASSET_INPUT_FINGERPRINT_PATH))?;

    let staging = output_dir.join("staging/portable-wasix");
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    }
    copy_dir_all(generated_assets, &staging.join(GENERATED_ASSETS_DIR))?;
    copy_dir_all(
        Path::new("src/extensions/generated"),
        &staging.join("src/extensions/generated"),
    )?;
    copy_dir_all(
        Path::new("src/runtimes/liboliphaunt/wasix/assets/generated"),
        &staging.join("src/runtimes/liboliphaunt/wasix/assets/generated"),
    )?;

    let output = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-runtime-portable.tar.zst"
    ));
    deterministic_tar_zst(&staging, Path::new(""), &output)?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    Ok(output)
}

fn package_release_aot_assets(output_dir: &Path, target: &str, version: &str) -> Result<PathBuf> {
    ensure_supported_aot_target(target)?;
    let generated_aot = generated_aot_dir(target);
    ensure_file(&generated_aot.join("manifest.json"))?;
    check_aot_package_manifest(target, DEFAULT_SOURCE_LANE)?;

    let target_id = aot_target_id_for_triple(target)?;
    let output = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-runtime-aot-{target_id}.tar.zst"
    ));
    deterministic_tar_zst(
        &generated_aot,
        &Path::new("target/oliphaunt-wasix/aot").join(target),
        &output,
    )?;
    Ok(output)
}

fn wasix_runtime_release_version() -> Result<String> {
    let manifest = fs::read_to_string("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml")
        .context("read src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml")?;
    let mut in_package = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed == "[package]" {
            in_package = true;
            continue;
        }
        if in_package && trimmed.starts_with('[') {
            break;
        }
        if in_package && trimmed.starts_with("version") {
            let Some((_, raw_value)) = trimmed.split_once('=') else {
                continue;
            };
            let version = raw_value.trim().trim_matches('"');
            if !version.is_empty() {
                return Ok(version.to_owned());
            }
        }
    }
    Err(anyhow!(
        "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml [package].version is missing"
    ))
}

pub(super) fn run_in_release_workspace(command: &str, args: &[&str]) -> Result<()> {
    let workspace = Path::new(RELEASE_STAGE_DIR).join("workspace");
    let mut command = command_for_host(command);
    command
        .args(args)
        .current_dir(&workspace)
        .env("OLIPHAUNT_WASM_RELEASE_STAGED", "1");
    run_command(&mut command)
}
