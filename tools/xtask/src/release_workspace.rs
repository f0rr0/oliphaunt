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
    copy_core_wasix_asset_payload(generated_assets, &workspace.join(ASSET_CRATE_PAYLOAD_DIR))?;
    copy_core_wasix_asset_payload(generated_assets, &workspace.join(GENERATED_ASSETS_DIR))?;
    update_staged_root_asset_metadata(&workspace)?;

    for target in supported_aot_targets() {
        let generated_aot = generated_aot_dir(target);
        if generated_aot.join("manifest.json").is_file() {
            ensure_aot_manifest_matches_source_lane(
                &generated_aot.join("manifest.json"),
                target,
                DEFAULT_SOURCE_LANE,
            )?;
            copy_core_wasix_aot_payload(
                &generated_aot,
                &workspace
                    .join("src/runtimes/liboliphaunt/wasix/crates/aot")
                    .join(target)
                    .join("artifacts"),
            )?;
            copy_core_wasix_aot_payload(
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

fn copy_core_wasix_asset_payload(source: &Path, destination: &Path) -> Result<()> {
    copy_dir_all(source, destination)?;
    let extension_dir = destination.join("extensions");
    if extension_dir.exists() {
        fs::remove_dir_all(&extension_dir)
            .with_context(|| format!("remove {}", extension_dir.display()))?;
    }
    strip_core_asset_manifest_extensions(&destination.join("manifest.json"))?;
    ensure_core_wasix_asset_payload(destination)
}

fn strip_core_asset_manifest_extensions(manifest_path: &Path) -> Result<()> {
    let text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let extensions = manifest
        .get_mut("extensions")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| {
            anyhow!(
                "{} must contain an extensions array",
                manifest_path.display()
            )
        })?;
    extensions.clear();
    let rendered =
        serde_json::to_string_pretty(&manifest).context("serialize core WASIX asset manifest")?;
    fs::write(manifest_path, format!("{rendered}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

fn ensure_core_wasix_asset_payload(root: &Path) -> Result<()> {
    ensure_file(&root.join("manifest.json"))?;
    for file in sorted_files(root)? {
        let relative = file
            .strip_prefix(root)
            .with_context(|| format!("strip {} from {}", root.display(), file.display()))?;
        if relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            == Some("extensions")
        {
            bail!(
                "core WASIX asset payload must not contain extension archive {}",
                file.display()
            );
        }
    }
    Ok(())
}

fn copy_core_wasix_aot_payload(source: &Path, destination: &Path) -> Result<()> {
    copy_dir_all(source, destination)?;
    let manifest_path = destination.join("manifest.json");
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let artifacts = manifest
        .get_mut("artifacts")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| {
            anyhow!(
                "{} must contain an artifacts array",
                manifest_path.display()
            )
        })?;
    let mut retained = Vec::new();
    let mut retained_paths = BTreeSet::new();
    for artifact in artifacts.drain(..) {
        let name = artifact
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                anyhow!(
                    "{} contains an artifact without a name",
                    manifest_path.display()
                )
            })?;
        let path = artifact
            .get("path")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                anyhow!(
                    "{} contains artifact {name} without a path",
                    manifest_path.display()
                )
            })?;
        let relative_path = validated_aot_artifact_path(path, &manifest_path, name)?;
        if name.starts_with("extension:") {
            let artifact_path = destination.join(&relative_path);
            if artifact_path.exists() {
                fs::remove_file(&artifact_path)
                    .with_context(|| format!("remove {}", artifact_path.display()))?;
            }
        } else {
            let artifact_path = destination.join(&relative_path);
            ensure_file(&artifact_path)?;
            retained_paths.insert(relative_path);
            retained.push(artifact);
        }
    }
    ensure!(
        !retained.is_empty(),
        "{} core WASIX AOT manifest would contain no artifacts",
        manifest_path.display()
    );
    *artifacts = retained;
    remove_unretained_aot_payload_files(destination, &retained_paths)?;
    let rendered =
        serde_json::to_string_pretty(&manifest).context("serialize core WASIX AOT manifest")?;
    fs::write(&manifest_path, format!("{rendered}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))?;
    ensure_core_wasix_aot_payload(destination)
}

fn validated_aot_artifact_path(path: &str, manifest_path: &Path, name: &str) -> Result<PathBuf> {
    let relative_path = Path::new(path);
    ensure!(
        relative_path.is_relative()
            && relative_path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
        "{} artifact {name} path must be a simple relative file path, got {path}",
        manifest_path.display()
    );
    Ok(relative_path.to_path_buf())
}

fn remove_unretained_aot_payload_files(
    root: &Path,
    retained_paths: &BTreeSet<PathBuf>,
) -> Result<()> {
    for file in sorted_files(root)? {
        let relative = file
            .strip_prefix(root)
            .with_context(|| format!("strip {} from {}", root.display(), file.display()))?;
        if relative == Path::new("manifest.json") || retained_paths.contains(relative) {
            continue;
        }
        fs::remove_file(&file).with_context(|| format!("remove {}", file.display()))?;
    }
    Ok(())
}

fn ensure_core_wasix_aot_payload(root: &Path) -> Result<()> {
    ensure_file(&root.join("manifest.json"))?;
    let text = fs::read_to_string(root.join("manifest.json"))
        .with_context(|| format!("read {}", root.join("manifest.json").display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", root.join("manifest.json").display()))?;
    let mut retained_paths = BTreeSet::new();
    for artifact in manifest
        .get("artifacts")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            anyhow!(
                "{} must contain an artifacts array",
                root.join("manifest.json").display()
            )
        })?
    {
        let name = artifact
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("{} contains an artifact without a name", root.display()))?;
        ensure!(
            !name.starts_with("extension:"),
            "core WASIX AOT payload must not contain extension artifact {name}"
        );
        let path = artifact
            .get("path")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("{} contains artifact {name} without a path", root.display()))?;
        let relative_path = validated_aot_artifact_path(path, &root.join("manifest.json"), name)?;
        ensure_file(&root.join(&relative_path))?;
        retained_paths.insert(relative_path);
    }
    for file in sorted_files(root)? {
        let relative = file
            .strip_prefix(root)
            .with_context(|| format!("strip {} from {}", root.display(), file.display()))?;
        ensure!(
            relative == Path::new("manifest.json") || retained_paths.contains(relative),
            "core WASIX AOT payload contains unmanifested artifact {}",
            file.display()
        );
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
    bundles.push(package_release_icu_assets(output_dir, &version)?);
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
    copy_core_wasix_asset_payload(generated_assets, &staging.join(GENERATED_ASSETS_DIR))?;
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

fn package_release_icu_assets(output_dir: &Path, version: &str) -> Result<PathBuf> {
    let staging = output_dir.join("staging/icu-data");
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    }
    copy_wasix_icu_sidecar(&staging.join("target/oliphaunt-wasix/icu/share/icu"))?;
    let output = output_dir.join(format!("liboliphaunt-wasix-{version}-icu-data.tar.zst"));
    deterministic_tar_zst(&staging, Path::new(""), &output)?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    Ok(output)
}

fn copy_wasix_icu_sidecar(destination: &Path) -> Result<()> {
    let installed_icu = Path::new(WASIX_GENERATED_WORK_DIR).join("icu-wasix/share/icu");
    ensure!(
        installed_icu.is_dir(),
        "missing WASIX ICU files data at {}; run src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh before packaging",
        installed_icu.display()
    );
    let source = canonical_icu_data_root(&installed_icu)?;
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("remove {}", destination.display()))?;
    }
    copy_dir_all(&source, destination)
        .with_context(|| format!("copy WASIX ICU data from {}", source.display()))?;
    ensure!(
        icu_data_root_contains_data(destination)?,
        "staged WASIX ICU sidecar at {} does not contain icudt files",
        destination.display()
    );
    Ok(())
}

fn canonical_icu_data_root(installed_icu: &Path) -> Result<PathBuf> {
    if icu_data_root_contains_data(installed_icu)? {
        return Ok(installed_icu.to_path_buf());
    }

    let mut candidates = Vec::new();
    for child in sorted_children(installed_icu)? {
        if child.is_dir() && icu_data_root_contains_data(&child)? {
            candidates.push(child);
        }
    }
    ensure!(
        candidates.len() == 1,
        "WASIX ICU install root {} must contain exactly one data directory, found {}",
        installed_icu.display(),
        candidates.len()
    );
    Ok(candidates.remove(0))
}

fn icu_data_root_contains_data(root: &Path) -> Result<bool> {
    if !root.is_dir() {
        return Ok(false);
    }
    for child in sorted_children(root)? {
        let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if child.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            return Ok(true);
        }
        if child.is_dir() && name.starts_with("icudt") && !sorted_files(&child)?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn package_release_aot_assets(output_dir: &Path, target: &str, version: &str) -> Result<PathBuf> {
    ensure_supported_aot_target(target)?;
    let generated_aot = generated_aot_dir(target);
    ensure_file(&generated_aot.join("manifest.json"))?;
    ensure_aot_manifest_matches_source_lane(
        &generated_aot.join("manifest.json"),
        target,
        DEFAULT_SOURCE_LANE,
    )?;

    let target_id = aot_target_id_for_triple(target)?;
    let output = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-runtime-aot-{target_id}.tar.zst"
    ));
    let staging = output_dir.join("staging").join(target);
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    }
    copy_core_wasix_aot_payload(&generated_aot, &staging)?;
    deterministic_tar_zst(
        &staging,
        &Path::new("target/oliphaunt-wasix/aot").join(target),
        &output,
    )?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
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
