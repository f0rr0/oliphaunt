use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct TemporaryDirectory {
    path: PathBuf,
    remove: bool,
}

impl TemporaryDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path, remove: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.remove = false;
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if self.remove {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn unique_sibling_directory(destination: &Path, label: &str) -> Result<PathBuf> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let basename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for sequence in 0..100_u32 {
        let candidate = parent.join(format!(
            ".{basename}.{label}-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", candidate.display()));
            }
        }
    }
    bail!(
        "could not allocate a unique sibling directory for {}",
        destination.display()
    )
}

fn normalize_downloaded_aot_artifact(target: &str, artifact_dir: &Path) -> Result<()> {
    let marker = artifact_dir.join("target-triple.txt");
    let files = artifact_dir.join("files");
    if !marker.exists() && !files.exists() {
        return Ok(());
    }

    ensure_file(&marker)?;
    ensure!(
        files.is_dir(),
        "downloaded AOT artifact envelope is missing files directory: {}",
        files.display()
    );
    let actual = fs::read_to_string(&marker)
        .with_context(|| format!("read {}", marker.display()))?
        .trim()
        .to_owned();
    ensure_eq(
        &actual,
        target,
        "downloaded AOT artifact target-triple marker",
    )?;

    let normalized = artifact_dir.with_extension("normalized");
    if normalized.exists() {
        fs::remove_dir_all(&normalized)
            .with_context(|| format!("remove {}", normalized.display()))?;
    }
    copy_dir_all(&files, &normalized)?;
    fs::remove_dir_all(artifact_dir)
        .with_context(|| format!("remove {}", artifact_dir.display()))?;
    fs::rename(&normalized, artifact_dir).with_context(|| {
        format!(
            "rename normalized AOT artifact {} -> {}",
            normalized.display(),
            artifact_dir.display()
        )
    })?;
    Ok(())
}

fn extract_tar_zst(archive: &Path, destination: &Path) -> Result<()> {
    let file = fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", archive.display()))?;
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(destination).with_context(|| {
        format!(
            "unpack {} into {}",
            archive.display(),
            destination.display()
        )
    })
}

fn validate_downloaded_artifacts(download_dir: &Path, targets: &[String]) -> Result<()> {
    for entry in WalkDir::new(download_dir).follow_links(false) {
        let entry = entry.with_context(|| format!("walk {}", download_dir.display()))?;
        let file_type = entry.file_type();
        ensure!(
            file_type.is_dir() || file_type.is_file(),
            "downloaded artifact envelope contains a symbolic link or special file: {}",
            entry.path().display()
        );
    }
    let downloaded_assets = download_dir.join(GENERATED_ASSETS_DIR);
    ensure_file(&downloaded_assets.join("manifest.json"))?;
    let downloaded_manifest = read_asset_manifest_from(&downloaded_assets)?;
    ensure_packaged_asset_matches_source_lane(&downloaded_manifest, DEFAULT_SOURCE_LANE)?;

    for target in targets {
        let downloaded_aot = download_dir.join("target/oliphaunt-wasix/aot").join(target);
        ensure_file(&downloaded_aot.join("manifest.json"))?;
        ensure_aot_manifest_matches_source_lane(
            &downloaded_aot.join("manifest.json"),
            target,
            DEFAULT_SOURCE_LANE,
        )?;
    }
    Ok(())
}

struct PreparedPromotion {
    backup: Option<PathBuf>,
    destination: PathBuf,
    promoted: bool,
    stage: TemporaryDirectory,
}

fn promote_directories_transactionally(entries: &[(PathBuf, PathBuf)]) -> Result<()> {
    let mut prepared = Vec::new();
    for (source, destination) in entries {
        let stage_path = unique_sibling_directory(destination, "install")?;
        let stage = TemporaryDirectory::new(stage_path);
        copy_dir_all(source, stage.path()).with_context(|| {
            format!(
                "stage validated directory {} for {}",
                source.display(),
                destination.display()
            )
        })?;
        let backup = if destination.exists() {
            let backup = unique_sibling_directory(destination, "previous")?;
            fs::remove_dir(&backup).with_context(|| format!("prepare {}", backup.display()))?;
            Some(backup)
        } else {
            None
        };
        prepared.push(PreparedPromotion {
            backup,
            destination: destination.clone(),
            promoted: false,
            stage,
        });
    }

    for index in 0..prepared.len() {
        let destination = prepared[index].destination.clone();
        if let Some(backup) = prepared[index].backup.clone()
            && let Err(error) = fs::rename(&destination, &backup)
        {
            rollback_promotions(&mut prepared, index);
            return Err(error).with_context(|| {
                format!(
                    "move existing install {} -> {}",
                    destination.display(),
                    backup.display()
                )
            });
        }
        if let Err(error) = fs::rename(prepared[index].stage.path(), &destination) {
            if let Some(backup) = prepared[index].backup.take() {
                let _ = fs::rename(backup, &destination);
            }
            rollback_promotions(&mut prepared, index);
            return Err(error).with_context(|| {
                format!(
                    "promote validated install {} -> {}",
                    prepared[index].stage.path().display(),
                    destination.display()
                )
            });
        }
        prepared[index].stage.disarm();
        prepared[index].promoted = true;
    }
    for item in &mut prepared {
        if let Some(backup) = item.backup.take() {
            fs::remove_dir_all(&backup)
                .with_context(|| format!("remove prior install {}", backup.display()))?;
        }
    }
    Ok(())
}

fn rollback_promotions(prepared: &mut [PreparedPromotion], before: usize) {
    for item in prepared[..before].iter_mut().rev() {
        if !item.promoted {
            continue;
        }
        let _ = fs::remove_dir_all(&item.destination);
        if let Some(backup) = item.backup.take() {
            let _ = fs::rename(backup, &item.destination);
        }
        item.promoted = false;
    }
}

fn install_downloaded_artifacts(download_dir: &Path, targets: &[String]) -> Result<()> {
    validate_downloaded_artifacts(download_dir, targets)?;
    let mut entries = vec![(
        download_dir.join(GENERATED_ASSETS_DIR),
        PathBuf::from(GENERATED_ASSETS_DIR),
    )];
    for target in targets {
        entries.push((
            download_dir.join("target/oliphaunt-wasix/aot").join(target),
            generated_aot_dir(target),
        ));
    }
    promote_directories_transactionally(&entries)
}

pub(super) fn ensure_aot_manifest_matches_source_lane(
    manifest_path: &Path,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    let expected = canonical_source_lane(source_lane)?;
    let text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    ensure!(
        manifest.format_version == AOT_MANIFEST_FORMAT_VERSION,
        "AOT manifest format-version must be {AOT_MANIFEST_FORMAT_VERSION}, got {}",
        manifest.format_version
    );
    let actual = manifest.source_lane.as_deref().unwrap_or("<missing>");
    ensure_eq(actual, expected, "AOT manifest source-lane")?;
    ensure_eq(
        &manifest.target_triple,
        target,
        "AOT manifest target-triple",
    )?;
    let sources = load_wasix_toolchain_manifest()?;
    ensure_eq(
        &manifest.wasmer_version,
        &sources.toolchain.wasmer,
        "AOT manifest wasmer-version",
    )?;
    ensure_eq(
        &manifest.wasmer_wasix_version,
        &sources.toolchain.wasmer_wasix,
        "AOT manifest wasmer-wasix-version",
    )?;
    ensure!(
        !manifest.artifacts.is_empty(),
        "AOT manifest {} contains no artifacts",
        manifest_path.display()
    );
    match expected {
        "stable" => {
            ensure_postgres_source_fingerprint_matches_current(
                manifest.source_fingerprint.as_deref(),
                "PG18 AOT manifest source-fingerprint",
            )?;
            if let Some(postgres_version) = manifest.postgres_version.as_deref() {
                ensure!(
                    postgres_version.starts_with("18."),
                    "AOT manifest is PostgreSQL {postgres_version}, not the PG18 WASIX runtime"
                );
            }
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
    Ok(())
}

pub(super) fn install_local_assets(args: &[String]) -> Result<()> {
    let target = value_after(args, "--target-triple").unwrap_or(host_target_triple());
    install_local_assets_for_target(target)
}

fn install_local_assets_for_target(target: &str) -> Result<()> {
    ensure_supported_aot_target(target)?;
    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    let generated_manifest = read_asset_manifest_from(generated_assets)?;
    ensure_packaged_asset_matches_source_lane(&generated_manifest, DEFAULT_SOURCE_LANE)?;
    check_canonical_asset_layout(true)?;
    check_generated_manifest_for_aot(&load_sources_manifest()?, true)?;
    verify_asset_manifest_hashes()?;

    find_aot_artifact_dir(target)?;
    check_aot_package_manifest(target, DEFAULT_SOURCE_LANE)?;
    println!("local generated assets are installed for {target}");
    Ok(())
}

pub(super) fn import_downloaded_assets(args: &[String]) -> Result<()> {
    let directory = Path::new(
        value_after(args, "--from").context("--from requires a staged download directory")?,
    );
    let targets: Vec<String> = args
        .windows(2)
        .filter(|pair| pair[0] == "--target-triple")
        .map(|pair| pair[1].clone())
        .collect();
    ensure!(
        !targets.is_empty(),
        "at least one --target-triple is required"
    );
    for target in &targets {
        ensure_supported_aot_target(target)?;
        normalize_downloaded_aot_artifact(target, &directory.join(generated_aot_dir(target)))?;
    }
    install_downloaded_artifacts(directory, &targets)?;
    for target in targets {
        install_local_assets_for_target(&target)?;
    }
    Ok(())
}

pub(super) fn unpack_downloaded_archive(args: &[String]) -> Result<()> {
    ensure!(args.len() == 3, "usage: assets unpack ARCHIVE DIRECTORY");
    extract_tar_zst(Path::new(&args[1]), Path::new(&args[2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-asset-io-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn install_staging_failure_cannot_partially_replace_destinations() {
        let root = test_root("transaction");
        let source = root.join("source");
        let missing = root.join("missing");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        fs::write(first.join("old-first"), b"old-first").unwrap();
        fs::write(second.join("old-second"), b"old-second").unwrap();
        assert!(
            promote_directories_transactionally(&[
                (source, first.clone()),
                (missing, second.clone())
            ])
            .is_err()
        );
        assert_eq!(fs::read(first.join("old-first")).unwrap(), b"old-first");
        assert_eq!(fs::read(second.join("old-second")).unwrap(), b"old-second");
        fs::remove_dir_all(root).unwrap();
    }
}
