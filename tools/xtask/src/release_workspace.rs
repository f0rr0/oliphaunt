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
const SPLIT_WASIX_TOOL_PAYLOAD_FILES: &[&str] = &["bin/pg_dump.wasix.wasm", "bin/psql.wasix.wasm"];
const SPLIT_WASIX_TOOL_AOT_ARTIFACTS: &[&str] = &["tool:pg_dump", "tool:psql"];
const QUALIFICATION_ONLY_EXTENSION_METADATA: &[&str] =
    &["mobile/qualification-static-extensions.tsv"];

fn stage_release_notices(staging: &Path, profile: &str) -> Result<()> {
    let mut command = command_for_host("bun");
    command
        .arg("tools/release/release-notices.mjs")
        .arg("stage")
        .arg(staging)
        .arg("--profile")
        .arg(profile);
    run_command(&mut command).with_context(|| {
        format!(
            "stage release notices with profile {profile} in {}",
            staging.display()
        )
    })
}

fn check_release_notices(archive: &Path, profile: &str, prefix: Option<&Path>) -> Result<()> {
    let mut command = command_for_host("bun");
    command
        .arg("tools/release/release-notices.mjs")
        .arg("check-archive")
        .arg(archive)
        .arg("--profile")
        .arg(profile);
    if let Some(prefix) = prefix {
        command.arg("--prefix").arg(prefix);
    }
    run_command(&mut command).with_context(|| {
        format!(
            "verify release notices with profile {profile} in {}",
            archive.display()
        )
    })
}

fn check_release_asset_set(output_dir: &Path, version: &str) -> Result<()> {
    let mut command = command_for_host("bun");
    command
        .arg("tools/release/check-liboliphaunt-wasix-release-assets.mjs")
        .arg("--asset-dir")
        .arg(output_dir)
        .arg("--version")
        .arg(version);
    run_command(&mut command).with_context(|| {
        format!(
            "verify complete liboliphaunt-wasix release asset set in {}",
            output_dir.display()
        )
    })
}

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
    copy_core_wasix_asset_payload(
        generated_assets,
        &workspace.join(ASSET_CRATE_PAYLOAD_DIR),
        false,
    )?;
    copy_core_wasix_asset_payload(
        generated_assets,
        &workspace.join(GENERATED_ASSETS_DIR),
        true,
    )?;
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
                false,
            )?;
            copy_core_wasix_aot_payload(
                &generated_aot,
                &workspace.join("target/oliphaunt-wasix/aot").join(target),
                true,
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

fn copy_core_wasix_asset_payload(
    source: &Path,
    destination: &Path,
    retain_split_tools: bool,
) -> Result<()> {
    copy_dir_all(source, destination)?;
    let extension_dir = destination.join("extensions");
    if extension_dir.exists() {
        fs::remove_dir_all(&extension_dir)
            .with_context(|| format!("remove {}", extension_dir.display()))?;
    }
    if !retain_split_tools {
        remove_split_wasix_tool_payload(destination)?;
    }
    strip_core_asset_manifest_extensions(&destination.join("manifest.json"))?;
    ensure_core_wasix_asset_payload(destination, retain_split_tools)
}

fn copy_public_extension_generated_metadata(source: &Path, destination: &Path) -> Result<()> {
    copy_dir_all(source, destination)?;
    for relative in QUALIFICATION_ONLY_EXTENSION_METADATA {
        let candidate = destination.join(relative);
        if candidate.exists() {
            fs::remove_file(&candidate).with_context(|| {
                format!("remove qualification-only metadata {}", candidate.display())
            })?;
        }
        ensure!(
            !candidate.exists(),
            "public WASIX runtime metadata must not contain qualification-only file {}",
            candidate.display()
        );
    }
    Ok(())
}

fn remove_split_wasix_tool_payload(root: &Path) -> Result<()> {
    for relative in SPLIT_WASIX_TOOL_PAYLOAD_FILES {
        let path = root.join(relative);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
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
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| anyhow!("{} must contain a JSON object", manifest_path.display()))?;
    object.remove("pg-dump");
    object.remove("psql");
    let rendered =
        serde_json::to_string_pretty(&manifest).context("serialize core WASIX asset manifest")?;
    fs::write(manifest_path, format!("{rendered}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

fn ensure_core_wasix_asset_payload(root: &Path, retain_split_tools: bool) -> Result<()> {
    ensure_file(&root.join("manifest.json"))?;
    for relative in SPLIT_WASIX_TOOL_PAYLOAD_FILES {
        let path = root.join(relative);
        if retain_split_tools {
            ensure_file(&path)?;
        } else {
            ensure!(
                !path.exists(),
                "core WASIX root crate payload must not contain split tool {}",
                path.display()
            );
        }
    }
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

fn copy_core_wasix_aot_payload(
    source: &Path,
    destination: &Path,
    retain_split_tools: bool,
) -> Result<()> {
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
        if name.starts_with("extension:")
            || (!retain_split_tools && SPLIT_WASIX_TOOL_AOT_ARTIFACTS.contains(&name))
        {
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
    ensure_core_wasix_aot_payload(destination, retain_split_tools)
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

fn ensure_core_wasix_aot_payload(root: &Path, retain_split_tools: bool) -> Result<()> {
    ensure_file(&root.join("manifest.json"))?;
    let text = fs::read_to_string(root.join("manifest.json"))
        .with_context(|| format!("read {}", root.join("manifest.json").display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", root.join("manifest.json").display()))?;
    let mut retained_paths = BTreeSet::new();
    let mut retained_split_tools = BTreeSet::new();
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
        if SPLIT_WASIX_TOOL_AOT_ARTIFACTS.contains(&name) {
            ensure!(
                retain_split_tools,
                "core WASIX AOT payload must not contain split tool artifact {name}"
            );
            retained_split_tools.insert(name.to_owned());
        }
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
    if retain_split_tools {
        for required in SPLIT_WASIX_TOOL_AOT_ARTIFACTS {
            ensure!(
                retained_split_tools.contains(*required),
                "WASIX AOT payload retained for tools must contain split tool artifact {required}"
            );
        }
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
    let staging_root = output_dir.join("staging");
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root).with_context(|| {
            format!(
                "remove completed release staging root {}",
                staging_root.display()
            )
        })?;
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
        checksum_lines.push(format!("{}  ./{name}", sha256_file(bundle)?));
    }
    checksum_lines.sort();
    let checksum_path = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-release-assets.sha256"
    ));
    fs::write(&checksum_path, format!("{}\n", checksum_lines.join("\n")))
        .with_context(|| format!("write {}", checksum_path.display()))?;

    check_release_asset_set(output_dir, &version)?;
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
    copy_core_wasix_asset_payload(generated_assets, &staging.join(GENERATED_ASSETS_DIR), true)?;
    copy_public_extension_generated_metadata(
        Path::new("src/extensions/generated"),
        &staging.join("src/extensions/generated"),
    )?;
    copy_dir_all(
        Path::new("src/runtimes/liboliphaunt/wasix/assets/generated"),
        &staging.join("src/runtimes/liboliphaunt/wasix/assets/generated"),
    )?;
    stage_release_notices(&staging, "wasix-runtime")?;

    let output = output_dir.join(format!(
        "liboliphaunt-wasix-{version}-runtime-portable.tar.zst"
    ));
    deterministic_tar_zst(&staging, Path::new(""), &output)?;
    check_release_notices(&output, "wasix-runtime", None)?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    Ok(output)
}

fn package_release_icu_assets(output_dir: &Path, version: &str) -> Result<PathBuf> {
    let staging = output_dir.join("staging/icu-data");
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    }
    copy_wasix_icu_sidecar(&staging.join("target/oliphaunt-wasix/icu/share/icu"))?;
    stage_release_notices(&staging, "wasix-icu-data")?;
    let output = output_dir.join(format!("liboliphaunt-wasix-{version}-icu-data.tar.zst"));
    deterministic_tar_zst(&staging, Path::new(""), &output)?;
    check_release_notices(&output, "wasix-icu-data", None)?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    Ok(output)
}

fn copy_wasix_icu_sidecar(destination: &Path) -> Result<()> {
    let installed_icu = Path::new(WASIX_GENERATED_WORK_DIR).join("icu-wasix/share/icu");
    let installed_type = portable_icu_entry_type(&installed_icu).with_context(|| {
        format!(
            "missing or unsafe WASIX ICU files data at {}; run src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh before packaging",
            installed_icu.display()
        )
    })?;
    ensure!(
        installed_type.is_dir(),
        "WASIX ICU files data root is not a directory: {}",
        installed_icu.display()
    );
    let source = canonical_icu_data_root(&installed_icu)?;
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("remove {}", destination.display()))?;
    }
    copy_wasix_icu_data_payload(&source, destination)
        .with_context(|| format!("copy WASIX ICU files data from {}", source.display()))?;
    ensure!(
        icu_data_root_contains_data(destination)?,
        "staged WASIX ICU sidecar at {} does not contain icudt files",
        destination.display()
    );
    Ok(())
}

fn copy_wasix_icu_data_payload(source: &Path, destination: &Path) -> Result<()> {
    let source_type = portable_icu_entry_type(source)?;
    ensure!(
        source_type.is_dir(),
        "ICU data root is not a directory: {}",
        source.display()
    );
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    let mut copied = 0usize;
    for child in sorted_children(source)? {
        let name = child
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("ICU data path is not valid UTF-8: {}", child.display()))?;
        let child_type = portable_icu_entry_type(&child)?;
        if child_type.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            copy_file(&child, &destination.join(name))?;
            copied += 1;
        } else if child_type.is_dir() && name.starts_with("icudt") {
            let file_count = validate_portable_icu_tree(&child)?;
            if file_count > 0 {
                copy_dir_all(&child, &destination.join(name))?;
                copied += 1;
            }
        }
    }
    ensure!(
        copied > 0,
        "ICU data root {} has no icudt files-data payload",
        source.display()
    );
    Ok(())
}

fn canonical_icu_data_root(installed_icu: &Path) -> Result<PathBuf> {
    if icu_data_root_contains_data(installed_icu)? {
        return Ok(installed_icu.to_path_buf());
    }

    let mut candidates = Vec::new();
    for child in sorted_children(installed_icu)? {
        if portable_icu_entry_type(&child)?.is_dir() && icu_data_root_contains_data(&child)? {
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

fn portable_icu_entry_type(path: &Path) -> Result<fs::FileType> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspect ICU data path {}", path.display()))?;
    let file_type = metadata.file_type();
    ensure!(
        !file_type.is_symlink(),
        "ICU data tree must not contain a symbolic link: {}",
        path.display()
    );
    ensure!(
        file_type.is_file() || file_type.is_dir(),
        "ICU data tree must contain only regular files and directories: {}",
        path.display()
    );
    Ok(file_type)
}

fn validate_portable_icu_tree(root: &Path) -> Result<usize> {
    ensure!(
        portable_icu_entry_type(root)?.is_dir(),
        "ICU data subtree is not a directory: {}",
        root.display()
    );
    let mut file_count = 0usize;
    for child in sorted_children(root)? {
        let child_type = portable_icu_entry_type(&child)?;
        if child_type.is_dir() {
            file_count += validate_portable_icu_tree(&child)?;
        } else {
            file_count += 1;
        }
    }
    Ok(file_count)
}

fn icu_data_root_contains_data(root: &Path) -> Result<bool> {
    let root_type = portable_icu_entry_type(root)?;
    if !root_type.is_dir() {
        return Ok(false);
    }
    for child in sorted_children(root)? {
        let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let child_type = portable_icu_entry_type(&child)?;
        if child_type.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            return Ok(true);
        }
        if child_type.is_dir()
            && name.starts_with("icudt")
            && validate_portable_icu_tree(&child)? > 0
        {
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
    copy_core_wasix_aot_payload(&generated_aot, &staging, true)?;
    stage_release_notices(&staging, "wasix-aot")?;
    let archive_prefix = Path::new("target/oliphaunt-wasix/aot").join(target);
    deterministic_tar_zst(&staging, &archive_prefix, &output)?;
    check_release_notices(&output, "wasix-aot", Some(&archive_prefix))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "oliphaunt-release-workspace-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn public_wasix_payload_excludes_private_extension_bytes_and_metadata() -> Result<()> {
        let root = fixture_root("deferred-extension-boundary");
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        let raw_assets = root.join("raw-assets");
        fs::create_dir_all(raw_assets.join("extensions"))?;
        fs::write(
            raw_assets.join("manifest.json"),
            r#"{"extensions":[{"sql-name":"example_deferred"}],"pg-dump":{},"psql":{}}"#,
        )?;
        fs::write(
            raw_assets.join("extensions/example_deferred.tar.zst"),
            b"candidate",
        )?;
        fs::write(raw_assets.join("oliphaunt.wasix.tar.zst"), b"runtime")?;

        let public_assets = root.join("public-assets");
        copy_core_wasix_asset_payload(&raw_assets, &public_assets, false)?;
        assert!(!public_assets.join("extensions").exists());
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(public_assets.join("manifest.json"))?)?;
        assert_eq!(manifest["extensions"], serde_json::json!([]));
        assert!(manifest.get("pg-dump").is_none());
        assert!(manifest.get("psql").is_none());

        let generated = root.join("generated");
        fs::create_dir_all(generated.join("mobile"))?;
        fs::write(generated.join("mobile/static-extensions.tsv"), b"public\n")?;
        fs::write(
            generated.join("mobile/qualification-static-extensions.tsv"),
            b"example_deferred\n",
        )?;
        let public_generated = root.join("public-generated");
        copy_public_extension_generated_metadata(&generated, &public_generated)?;
        assert!(
            public_generated
                .join("mobile/static-extensions.tsv")
                .is_file()
        );
        assert!(
            !public_generated
                .join("mobile/qualification-static-extensions.tsv")
                .exists()
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn wasix_icu_sidecar_contains_only_icudt_payload() -> Result<()> {
        let root = fixture_root("icu-data-boundary");
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        let source = root.join("source");
        fs::create_dir_all(source.join("icudt76l/coll"))?;
        fs::create_dir_all(source.join("config"))?;
        fs::write(source.join("icudt76l/root.res"), b"root-data")?;
        fs::write(source.join("icudt76l/coll/en.res"), b"collation-data")?;
        fs::write(source.join("LICENSE"), b"upstream-license")?;
        fs::write(source.join("config/mh-linux"), b"build-only-config")?;
        fs::write(source.join("install-sh"), b"build-only-helper")?;

        let destination = root.join("destination");
        copy_wasix_icu_data_payload(&source, &destination)?;
        assert!(destination.join("icudt76l/root.res").is_file());
        assert!(destination.join("icudt76l/coll/en.res").is_file());
        assert!(!destination.join("LICENSE").exists());
        assert!(!destination.join("config").exists());
        assert!(!destination.join("install-sh").exists());
        assert!(icu_data_root_contains_data(&destination)?);

        let empty = root.join("empty");
        fs::create_dir_all(&empty)?;
        let error = copy_wasix_icu_data_payload(&empty, &root.join("empty-output"))
            .expect_err("empty ICU data roots must fail");
        assert!(
            error
                .to_string()
                .contains("has no icudt files-data payload")
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn wasix_icu_sidecar_rejects_symlinks_at_every_selected_payload_depth() -> Result<()> {
        use std::os::unix::fs::symlink;

        let root = fixture_root("icu-data-symlinks");
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(&root)?;
        let outside_file = root.join("outside.dat");
        let outside_directory = root.join("outside-directory");
        fs::write(&outside_file, b"outside")?;
        fs::create_dir_all(&outside_directory)?;
        fs::write(outside_directory.join("payload.res"), b"outside")?;

        let linked_file_root = root.join("linked-file-root");
        fs::create_dir_all(&linked_file_root)?;
        symlink(&outside_file, linked_file_root.join("icudt76l.dat"))?;
        let error =
            copy_wasix_icu_data_payload(&linked_file_root, &root.join("linked-file-output"))
                .expect_err("top-level ICU data symlinks must fail");
        assert!(
            error
                .to_string()
                .contains("must not contain a symbolic link")
        );

        let linked_directory_root = root.join("linked-directory-root");
        fs::create_dir_all(&linked_directory_root)?;
        symlink(&outside_directory, linked_directory_root.join("icudt76l"))?;
        let error = copy_wasix_icu_data_payload(
            &linked_directory_root,
            &root.join("linked-directory-output"),
        )
        .expect_err("top-level ICU directory symlinks must fail");
        assert!(
            error
                .to_string()
                .contains("must not contain a symbolic link")
        );

        let nested_link_root = root.join("nested-link-root");
        fs::create_dir_all(nested_link_root.join("icudt76l/coll"))?;
        fs::write(nested_link_root.join("icudt76l/root.res"), b"root")?;
        symlink(&outside_file, nested_link_root.join("icudt76l/coll/en.res"))?;
        let error =
            copy_wasix_icu_data_payload(&nested_link_root, &root.join("nested-link-output"))
                .expect_err("nested ICU data symlinks must fail");
        assert!(
            error
                .to_string()
                .contains("must not contain a symbolic link")
        );

        let canonical_link_root = root.join("canonical-link-root");
        fs::create_dir_all(&canonical_link_root)?;
        symlink(&outside_directory, canonical_link_root.join("76.1"))?;
        let error = canonical_icu_data_root(&canonical_link_root)
            .expect_err("canonical ICU root discovery must not follow symlinks");
        assert!(
            error
                .to_string()
                .contains("must not contain a symbolic link")
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }
}
