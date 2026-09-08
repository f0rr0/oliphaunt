use super::*;

pub(crate) fn check_postgres_source_spine() -> Result<()> {
    let manifest = load_postgres_source_manifest()?;
    let source = postgres_default_source_dir(&manifest);
    if source.exists() {
        check_prepared_postgres_source(&manifest, &source, Path::new(WASIX_POSTGRES_WORK_DIR))?;
    }
    Ok(())
}

pub(crate) fn check_prepared_postgres_source(
    manifest: &PostgresSourceManifest,
    source: &Path,
    work_root: &Path,
) -> Result<()> {
    ensure!(
        source.is_dir(),
        "prepared PG18 source path is not a directory: {}",
        source.display()
    );

    let version_path = source.join(".oliphaunt-wasix-postgres-version");
    let version = fs::read_to_string(&version_path)
        .with_context(|| format!("read {}", version_path.display()))?;
    ensure_eq(
        version.trim(),
        manifest.postgresql.version.as_str(),
        "prepared PG18 source version marker",
    )?;
    let expected_fingerprint = postgres_expected_source_fingerprint(manifest)?;
    let source_fingerprint_path = source.join(".oliphaunt-wasix-source-fingerprint");
    let source_fingerprint = fs::read_to_string(&source_fingerprint_path)
        .with_context(|| format!("read {}", source_fingerprint_path.display()))?;
    ensure_eq(
        source_fingerprint.trim(),
        &expected_fingerprint,
        "prepared PG18 source fingerprint marker",
    )?;
    let work_fingerprint_path = work_root.join(".source-fingerprint");
    let work_fingerprint = fs::read_to_string(&work_fingerprint_path)
        .with_context(|| format!("read {}", work_fingerprint_path.display()))?;
    ensure_eq(
        work_fingerprint.trim(),
        &expected_fingerprint,
        "prepared PG18 work fingerprint marker",
    )?;

    Ok(())
}

pub(crate) fn postgres_default_source_dir(manifest: &PostgresSourceManifest) -> PathBuf {
    Path::new(WASIX_POSTGRES_WORK_DIR)
        .join("work")
        .join(format!(
            "postgresql-{}-oliphaunt-wasix-src",
            manifest.postgresql.version
        ))
}

pub(crate) fn postgres_expected_source_fingerprint(
    manifest: &PostgresSourceManifest,
) -> Result<String> {
    Ok(format!(
        "{}:{}:{}",
        manifest.postgresql.version,
        manifest.postgresql.sha256,
        postgres_patch_series_hash(&manifest.patches)?
    ))
}

fn postgres_patch_series_hash(patches: &[String]) -> Result<String> {
    let mut hasher = Sha256::new();
    let inputs = std::iter::once(repo_relative_path(POSTGRES_PATCH_SERIES_PATH)).chain(
        patches
            .iter()
            .map(|name| repo_relative_path(POSTGRES_PATCH_DIR).join(name)),
    );
    for path in inputs {
        let hash = sha256_text_file_lf(&path)?;
        hasher.update(hash.as_bytes());
        hasher.update(b"\n");
    }
    Ok(format!("{:x}", hasher.finalize()))
}
