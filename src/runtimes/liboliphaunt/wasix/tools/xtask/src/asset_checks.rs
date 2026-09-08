use super::*;

pub(crate) fn check_generated_manifest(manifest: &SourcesManifest, strict: bool) -> Result<()> {
    check_generated_manifest_with_outputs(
        manifest,
        strict,
        BuildOutputs::discover_for_source_lane(DEFAULT_SOURCE_LANE),
    )
}

pub(crate) fn check_generated_manifest_for_aot(
    manifest: &SourcesManifest,
    strict: bool,
) -> Result<()> {
    check_generated_manifest_with_outputs(
        manifest,
        strict,
        BuildOutputs::discover_for_aot(DEFAULT_SOURCE_LANE),
    )
}

fn check_generated_manifest_with_outputs(
    manifest: &SourcesManifest,
    strict: bool,
    outputs: Result<BuildOutputs>,
) -> Result<()> {
    let source_lane = DEFAULT_SOURCE_LANE;
    match outputs.and_then(|outputs| effective_source_pins(manifest, &outputs)) {
        Ok(expected_sources) => check_generated_manifest_sources_in(
            generated_assets_dir_for_source_lane(source_lane)?,
            &expected_sources,
            source_lane,
            strict,
        ),
        Err(err) if !strict => {
            eprintln!(
                "warning: skipping generated asset manifest source-pin check for {source_lane}: {err:#}"
            );
            Ok(())
        }
        Err(err) => Err(err).context("derive expected generated asset manifest source pins"),
    }
}

pub(crate) fn check_generated_manifest_sources_in(
    asset_dir: &Path,
    expected_sources: &[SourcePin],
    expected_label: &str,
    strict: bool,
) -> Result<()> {
    let path = asset_dir.join("manifest.json");
    if !path.exists() {
        if strict {
            bail!("generated asset manifest is missing at {}", path.display());
        }
        eprintln!(
            "warning: generated asset manifest is missing at {}",
            path.display()
        );
        return Ok(());
    }

    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let generated: GeneratedAssetManifest =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    if expected_label == DEFAULT_SOURCE_LANE {
        let actual = generated.source_lane.as_deref().unwrap_or("<missing>");
        ensure_eq(
            actual,
            expected_label,
            "generated asset manifest source-lane",
        )?;
    }

    let mut drift = Vec::new();
    for source in expected_sources {
        match generated
            .sources
            .iter()
            .find(|generated| generated.name == source.name)
        {
            Some(generated)
                if generated.url == source.url
                    && generated.branch == source.branch
                    && generated.commit == source.commit => {}
            Some(generated) => drift.push(format!(
                "{} generated={}/{}@{} expected={}/{}@{}",
                source.name,
                generated.url,
                generated.branch,
                generated.commit,
                source.url,
                source.branch,
                source.commit
            )),
            None => drift.push(format!("{} missing from generated manifest", source.name)),
        }
    }
    let expected_source_names = expected_sources
        .iter()
        .map(|source| source.name.as_str())
        .collect::<BTreeSet<_>>();
    for source in &generated.sources {
        if !expected_source_names.contains(source.name.as_str()) {
            drift.push(format!(
                "{} is unexpected in generated manifest",
                source.name
            ));
        }
    }

    if drift.is_empty() {
        println!("generated asset manifest source pins match {expected_label}");
        return Ok(());
    }

    let details = drift.join("; ");
    if strict {
        bail!("generated asset manifest has stale source pins: {details}");
    }
    eprintln!("warning: generated asset manifest has stale source pins: {details}");
    Ok(())
}

pub(crate) fn verify_asset_manifest_hashes() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&text).context("parse generated asset manifest")?;
    let base = Path::new(GENERATED_ASSETS_DIR);

    let runtime_archive = base.join(&manifest.runtime.archive);
    verify_file_sha256(
        &runtime_archive,
        &manifest.runtime.sha256,
        "runtime archive",
    )?;
    let runtime_module = archive_entry_bytes(&runtime_archive, RUNTIME_MODULE_ARCHIVE_MEMBER)?;
    ensure_eq(
        &sha256_bytes(&runtime_module),
        &manifest.runtime.module_sha256,
        "runtime module sha256",
    )?;
    for module in &manifest.runtime_support {
        let bytes = archive_entry_bytes(&runtime_archive, &format!("oliphaunt/{}", module.path))?;
        ensure_eq(
            &sha256_bytes(&bytes),
            &module.sha256,
            &format!("runtime support {} sha256", module.name),
        )?;
        ensure_eq(
            &sha256_bytes(&bytes),
            &module.module_sha256,
            &format!("runtime support {} module sha256", module.name),
        )?;
    }

    if let Some(pg_dump) = &manifest.pg_dump {
        verify_file_sha256(&base.join(&pg_dump.path), &pg_dump.sha256, "pg_dump wasm")?;
        ensure_eq(
            &pg_dump.sha256,
            &pg_dump.module_sha256,
            "pg_dump module sha256",
        )?;
    }
    if let Some(psql) = &manifest.psql {
        verify_file_sha256(&base.join(&psql.path), &psql.sha256, "psql wasm")?;
        ensure_eq(&psql.sha256, &psql.module_sha256, "psql module sha256")?;
    }
    if let Some(initdb) = &manifest.initdb {
        verify_file_sha256(&base.join(&initdb.path), &initdb.sha256, "initdb wasm")?;
        ensure_eq(
            &initdb.sha256,
            &initdb.module_sha256,
            "initdb module sha256",
        )?;
    }

    for extension in &manifest.extensions {
        let archive = base.join(&extension.archive);
        verify_file_sha256(
            &archive,
            &extension.sha256,
            &format!("extension {} archive", extension.sql_name),
        )?;
        if let Some(native_module) = &extension.native_module {
            let entry = format!("lib/postgresql/{native_module}");
            let bytes = archive_entry_bytes(&archive, &entry)?;
            ensure_eq(
                &sha256_bytes(&bytes),
                &extension.module_sha256,
                &format!("extension {} module sha256", extension.sql_name),
            )?;
        }
        for module in &extension.native_modules {
            let bytes = archive_entry_bytes(&archive, &module.path)?;
            ensure_eq(
                &sha256_bytes(&bytes),
                &module.module_sha256,
                &format!(
                    "extension {} native module {} sha256",
                    extension.sql_name, module.name
                ),
            )?;
        }
    }

    for (profile, seed) in &manifest.cluster_seeds {
        verify_cluster_seed_hash(
            profile,
            &base.join(&seed.archive),
            &base.join(&seed.manifest),
        )?;
        verify_file_sha256(
            &base.join(&seed.archive),
            &seed.sha256,
            &format!("{profile} cluster seed"),
        )?;
        ensure_file(&base.join(&seed.manifest))?;
        ensure_eq(
            &seed.runtime_module_sha256,
            &manifest.runtime.module_sha256,
            &format!("{profile} cluster seed runtime module sha256"),
        )?;
        if let Some(initdb) = &manifest.initdb {
            ensure_eq(
                &seed.initdb_module_sha256,
                &initdb.module_sha256,
                &format!("{profile} cluster seed initdb module sha256"),
            )?;
        }
    }
    ensure!(
        manifest
            .cluster_seeds
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            == ["icu", "standard"],
        "generated asset manifest must contain exactly the icu and standard cluster seeds"
    );

    println!("generated asset hashes match manifests");
    Ok(())
}

fn verify_cluster_seed_hash(profile: &str, archive: &Path, manifest_path: &Path) -> Result<()> {
    ensure!(
        manifest_path.exists() && archive.exists(),
        "generated assets must include the {profile} cluster seed archive and manifest; expected both {} and {}",
        manifest_path.display(),
        archive.display()
    );
    let text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let expected = manifest
        .get("archive")
        .and_then(serde_json::Value::as_object)
        .and_then(|archive| archive.get("sha256"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("{} is missing archive.sha256", manifest_path.display()))?;
    ensure_eq(
        manifest
            .get("catalogProfile")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>"),
        profile,
        "cluster seed catalogProfile",
    )?;
    verify_file_sha256(
        archive,
        expected,
        &format!("{profile} cluster seed archive"),
    )?;
    Ok(())
}

fn verify_file_sha256(path: &Path, expected: &str, field: &str) -> Result<()> {
    ensure_file(path)?;
    let actual = sha256_file(path)?;
    ensure_eq(&actual, expected, field)
}

const AOT_TARGETS: &[(&str, &str)] = &[
    ("aarch64-apple-darwin", "macos-arm64"),
    ("x86_64-unknown-linux-gnu", "linux-x64-gnu"),
    ("aarch64-unknown-linux-gnu", "linux-arm64-gnu"),
    ("x86_64-pc-windows-msvc", "windows-x64-msvc"),
];

pub(crate) fn aot_target_id_for_triple(target: &str) -> Result<&'static str> {
    AOT_TARGETS
        .iter()
        .find(|(triple, _)| *triple == target)
        .map(|(_, id)| *id)
        .with_context(|| format!("unsupported AOT target triple {target}"))
}

pub(crate) fn ensure_supported_aot_target(target: &str) -> Result<()> {
    aot_target_id_for_triple(target).map(|_| ())
}

pub(crate) fn verify_generated_extension_surface() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&manifest_text).context("parse committed asset manifest")?;
    if skip_extensions_for_perf_probe() && manifest.extensions.is_empty() {
        println!("core-only asset manifest detected; skipping generated extension surface guard");
        return Ok(());
    }
    let catalog = crate::extension_catalog::manifest_metadata_by_sql_name()?;
    let manifest_sql_names = manifest
        .extensions
        .iter()
        .map(|extension| extension.sql_name.clone())
        .collect::<BTreeSet<_>>();
    let catalog_sql_names = catalog.keys().cloned().collect::<BTreeSet<_>>();
    if manifest_sql_names != catalog_sql_names {
        bail!(
            "supported extension catalog and asset manifest disagree: manifest-only={:?} catalog-only={:?}",
            manifest_sql_names
                .difference(&catalog_sql_names)
                .collect::<Vec<_>>(),
            catalog_sql_names
                .difference(&manifest_sql_names)
                .collect::<Vec<_>>()
        );
    }

    Ok(())
}

pub(crate) fn check_canonical_asset_layout(strict: bool) -> Result<()> {
    check_canonical_asset_layout_in(Path::new(GENERATED_ASSETS_DIR), strict)
}

pub(crate) fn check_canonical_asset_layout_in(asset_dir: &Path, strict: bool) -> Result<()> {
    let runtime_archive = asset_dir.join("oliphaunt.wasix.tar.zst");
    if !runtime_archive.exists() {
        if strict {
            bail!(
                "runtime asset archive is missing at {}",
                runtime_archive.display()
            );
        }
        eprintln!(
            "warning: runtime asset archive is missing at {}",
            runtime_archive.display()
        );
        return Ok(());
    }

    let runtime_entries = archive_entries(&runtime_archive)?;
    let required_paths = [
        RUNTIME_MODULE_ARCHIVE_MEMBER,
        "oliphaunt/bin/initdb",
        "oliphaunt/lib/postgresql/dict_snowball.so",
        "oliphaunt/lib/postgresql/plpgsql.so",
        "oliphaunt/share/postgresql/snowball_create.sql",
        "oliphaunt/share/postgresql/extension/plpgsql--1.0.sql",
        "oliphaunt/share/postgresql/extension/plpgsql.control",
        "oliphaunt/share/postgresql/timezone/UTC",
        "oliphaunt/share/postgresql/timezone/America/New_York",
        "oliphaunt/share/postgresql/timezonesets/Default",
    ];
    for required in required_paths {
        if !runtime_entries.contains(required) {
            bail!(
                "runtime archive {} is missing canonical path {required}",
                runtime_archive.display()
            );
        }
    }
    for language in [
        "danish",
        "dutch",
        "english",
        "finnish",
        "french",
        "german",
        "hungarian",
        "italian",
        "nepali",
        "norwegian",
        "portuguese",
        "russian",
        "spanish",
        "swedish",
        "turkish",
    ] {
        let required = format!("oliphaunt/share/postgresql/tsearch_data/{language}.stop");
        if !runtime_entries.contains(required.as_str()) {
            bail!(
                "runtime archive {} is missing canonical path {required}",
                runtime_archive.display()
            );
        }
    }
    if runtime_entries
        .iter()
        .any(|entry| entry == "oliphaunt/share/icu" || entry.starts_with("oliphaunt/share/icu/"))
    {
        bail!(
            "runtime archive {} must not bundle ICU data under oliphaunt/share/icu; ICU is published as the separate oliphaunt-icu package",
            runtime_archive.display()
        );
    }
    for forbidden in [
        "oliphaunt/share/extension",
        "oliphaunt/share/timezonesets",
        "oliphaunt/lib/plpgsql.so",
        "oliphaunt/lib/dict_snowball.so",
        "oliphaunt/bin/pg_dump",
        "oliphaunt/bin/psql",
        "oliphaunt/bin/oliphaunt",
    ] {
        if runtime_entries.contains(forbidden)
            || runtime_entries
                .iter()
                .any(|entry| entry.starts_with(&format!("{forbidden}/")))
        {
            bail!(
                "runtime archive {} contains non-canonical duplicate path {forbidden}",
                runtime_archive.display()
            );
        }
    }

    let extensions_dir = asset_dir.join("extensions");
    if extensions_dir.exists() {
        for entry in fs::read_dir(&extensions_dir)
            .with_context(|| format!("read {}", extensions_dir.display()))?
        {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("zst") {
                continue;
            }
            check_extension_archive_layout(&path)?;
        }
    } else if strict && !skip_extensions_for_perf_probe() {
        bail!(
            "extension asset directory is missing at {}",
            extensions_dir.display()
        );
    }

    println!("canonical asset layout guard passed");
    Ok(())
}

fn check_extension_archive_layout(path: &Path) -> Result<()> {
    let entries = archive_entries(path)?;
    for entry in entries {
        if matches!(
            entry.as_str(),
            "lib"
                | "lib/postgresql"
                | "share"
                | "share/proj"
                | "share/postgresql"
                | "share/postgresql/extension"
                | "share/postgresql/tsearch_data"
        ) {
            continue;
        }
        if entry.starts_with("lib/postgresql/")
            || entry.starts_with("share/proj/")
            || entry.starts_with("share/postgresql/extension/")
            || entry.starts_with("share/postgresql/tsearch_data/")
        {
            continue;
        }
        bail!(
            "extension archive {} contains non-canonical path {entry}",
            path.display()
        );
    }
    Ok(())
}
