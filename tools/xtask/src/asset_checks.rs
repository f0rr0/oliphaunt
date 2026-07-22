use super::*;
use crate::asset_fingerprint::asset_input_fingerprint;
use crate::source_spine::source_checkout_path;

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

pub(crate) fn verify_committed_assets() -> Result<()> {
    check_source_free_repo()?;
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    check_no_legacy_runtime_shims()?;
    check_production_wasix_build_inputs()?;
    check_postgres_source_spine()?;
    check_source_lane_isolation()?;
    check_rust_startup_abi_boundary()?;
    check_or_write_asset_input_fingerprint(false)?;
    check_no_committed_portable_asset_blobs()?;
    check_no_committed_aot_artifacts()?;
    check_aot_crate_templates(&manifest)?;
    verify_generated_extension_surface_if_available()?;
    check_source_controlled_wasix_export_list()?;
    println!("source-controlled asset inputs and crate templates passed");
    Ok(())
}

pub(crate) fn check_source_free_repo() -> Result<()> {
    if Path::new(".gitmodules").exists() {
        bail!("tracked upstream source checkouts are not allowed: remove .gitmodules");
    }
    if is_release_staged_workspace() && !Path::new(".git").exists() {
        return Ok(());
    }
    for path in [
        "src/runtimes/liboliphaunt/wasix/assets/build/build",
        "src/runtimes/liboliphaunt/wasix/assets/build/work",
    ] {
        if Path::new(path).exists() {
            bail!(
                "{path} must not exist under source control roots; generated WASIX build/work data lives under target/oliphaunt-wasix/wasix-build"
            );
        }
    }
    for path in [
        "assets",
        SOURCE_CHECKOUT_ROOT,
        WASIX_GENERATED_BUILD_DIR,
        WASIX_GENERATED_WORK_DIR,
        GENERATED_ASSETS_DIR,
        RELEASE_STAGE_DIR,
    ] {
        let tracked = command_output("git", &["ls-files", path], Path::new("."))?;
        if !tracked.trim().is_empty() {
            bail!(
                "{path} contains tracked generated/source checkout files:\n{}",
                tracked.trim()
            );
        }
    }
    Ok(())
}

pub(crate) fn is_release_staged_workspace() -> bool {
    env::var_os("OLIPHAUNT_WASM_RELEASE_STAGED").as_deref() == Some(std::ffi::OsStr::new("1"))
}

fn check_no_committed_portable_asset_blobs() -> Result<()> {
    let tracked = command_output(
        "git",
        &[
            "ls-files",
            ASSET_CRATE_PAYLOAD_DIR,
            LEGACY_STATIC_WASI_ARCHIVE,
            "assets/bin",
            "assets/prepopulated",
            "src/extensions/artifacts/*.tar.gz",
        ],
        Path::new("."),
    )?;
    if !tracked.trim().is_empty() {
        bail!(
            "portable WASIX asset payloads must be generated by CI/release and must not be committed:\n{}",
            tracked.trim()
        );
    }
    println!("committed repo contains no portable WASIX asset blobs");
    Ok(())
}

pub(crate) fn check_or_write_asset_input_fingerprint(write: bool) -> Result<()> {
    let fingerprint = asset_input_fingerprint()?;
    let path = Path::new(ASSET_INPUT_FINGERPRINT_PATH);
    if write {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, format!("{fingerprint}\n"))
            .with_context(|| format!("write {}", path.display()))?;
        println!("wrote {}", path.display());
        return Ok(());
    }

    let expected = fs::read_to_string(path).with_context(|| {
        format!(
            "read {}; run `cargo run -p xtask -- assets input-fingerprint --write` after refreshing assets",
            path.display()
        )
    })?;
    ensure_eq(
        fingerprint.as_str(),
        expected.trim(),
        "committed asset input fingerprint",
    )
}

#[cfg(test)]
mod asset_fingerprint_tests {
    use std::path::Path;

    use super::aot_target_specs;
    use crate::asset_fingerprint::{
        ASSET_INPUT_PATHS, WASIX_XTASK_BINARY_PRODUCER_INPUTS, is_asset_binary_semantic_input,
        normalize_internal_asset_package_manifest, normalize_workspace_lockfile,
    };

    #[test]
    fn fingerprint_inventory_covers_every_active_wasix_producer_surface() {
        for path in [
            "src/runtimes/liboliphaunt/wasix/moon.yml",
            "src/runtimes/liboliphaunt/wasix/tools",
        ] {
            assert!(ASSET_INPUT_PATHS.contains(&path), "{path}");
        }

        let carrier_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/runtimes/liboliphaunt/wasix/crates");
        for entry in std::fs::read_dir(&carrier_root).expect("read WASIX carrier template root") {
            let entry = entry.expect("read WASIX carrier template entry");
            if !entry
                .file_type()
                .expect("read WASIX carrier template type")
                .is_dir()
            {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .expect("WASIX carrier template name is UTF-8")
                .to_owned();
            let path = format!("src/runtimes/liboliphaunt/wasix/crates/{name}");
            assert!(ASSET_INPUT_PATHS.contains(&path.as_str()), "{path}");
        }

        for path in [
            "tools/xtask/Cargo.toml",
            "tools/xtask/src/aot_serializer.rs",
            "tools/xtask/src/asset_fingerprint.rs",
            "tools/xtask/src/asset_manifest.rs",
            "tools/xtask/src/asset_pipeline.rs",
            "tools/xtask/src/extension_catalog.rs",
            "tools/xtask/src/fs_utils.rs",
            "tools/xtask/src/main.rs",
            "tools/xtask/src/postgres_guard.rs",
            "tools/xtask/src/template_runner.rs",
        ] {
            assert!(WASIX_XTASK_BINARY_PRODUCER_INPUTS.contains(&path), "{path}");
        }
        for path in [
            "tools/xtask/src",
            "tools/xtask/src/asset_checks.rs",
            "tools/xtask/src/asset_io.rs",
            "tools/xtask/src/release_workspace.rs",
            "tools/xtask/src/source_spine.rs",
        ] {
            assert!(!ASSET_INPUT_PATHS.contains(&path), "{path}");
            assert!(
                !WASIX_XTASK_BINARY_PRODUCER_INPUTS.contains(&path),
                "{path}"
            );
        }
    }

    #[test]
    fn release_envelope_files_do_not_invalidate_binary_assets() {
        for file in [
            "src/extensions/external/vector/.release-semantic-inputs.json",
            "src/extensions/external/vector/CHANGELOG.md",
            "src/extensions/external/vector/VERSION",
            "src/extensions/external/vector/targets/artifacts.toml",
            "src/extensions/external/example_deferred/publication-blocker.toml",
            "src/extensions/external/vector/release.toml",
            "src/extensions/external/vector/upstream-license-data.json",
            "src/extensions/external/vector/moon.yml",
            "src/extensions/external/vector/smoke.sql",
            "src/sources/toolchains/android-emulator-runner.toml",
            "src/sources/toolchains/maestro.toml",
            "src/sources/toolchains/node.toml",
            "src/sources/toolchains/moon.yml",
            "src/postgres/versions/18/fetch-source.test.sh",
            "src/postgres/versions/18/testdata/curl",
            "src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-wasixcc.test.sh",
            "tools/xtask/src/asset_checks.rs",
            "tools/xtask/src/asset_io.rs",
            "tools/xtask/src/release_workspace.rs",
            "tools/xtask/src/source_spine.rs",
        ] {
            assert!(!is_asset_binary_semantic_input(file), "{file}");
        }
        for file in [
            "src/extensions/external/vector/source.toml",
            "src/extensions/external/vector/patches/0001-wasix.patch",
            "src/sources/toolchains/wasix.toml",
            "src/postgres/versions/18/fetch-source.sh",
            "src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-wasixcc.sh",
            "src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.sh",
            "src/runtimes/liboliphaunt/wasix/assets/build/docker/isrg-root-x1.pem",
            "src/runtimes/liboliphaunt/wasix/assets/build/build.sh",
            "src/runtimes/liboliphaunt/wasix/moon.yml",
            "src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh",
            "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh",
            "src/runtimes/liboliphaunt/wasix/crates/tools/build.rs",
            "src/runtimes/liboliphaunt/wasix/crates/tools-aot/x86_64-pc-windows-msvc/build.rs",
        ] {
            assert!(is_asset_binary_semantic_input(file), "{file}");
        }
    }

    #[test]
    fn cargo_manifest_normalization_only_masks_the_product_version() {
        let manifest = "[package]\nname = \"producer\"\nversion = \"1.2.3\"\n\n[dependencies]\nserde = \"1.0\"\n";
        let normalized = normalize_internal_asset_package_manifest(manifest);
        assert!(normalized.contains("version = \"<release-version>\""));
        assert!(normalized.contains("serde = \"1.0\""));
    }

    #[test]
    fn lockfile_normalization_masks_only_workspace_package_versions() {
        let lockfile = "version = 4\n\n[[package]]\nname = \"local\"\nversion = \"1.2.3\"\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\nsource = \"registry+https://example.invalid\"\n";
        let normalized = normalize_workspace_lockfile(lockfile);
        assert!(normalized.contains("name = \"local\"\nversion = \"<release-version>\""));
        assert!(normalized.contains("name = \"serde\"\nversion = \"1.0.0\""));
    }

    #[test]
    fn aot_matrix_pins_every_wasmer_llvm_archive() {
        let expected = [
            (
                "macos-arm64",
                "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847",
                479_103_872,
            ),
            (
                "linux-x64-gnu",
                "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906",
                741_670_068,
            ),
            (
                "linux-arm64-gnu",
                "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1",
                668_873_496,
            ),
            (
                "windows-x64-msvc",
                "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e",
                757_929_860,
            ),
        ];
        assert_eq!(aot_target_specs().len(), expected.len());
        for spec in aot_target_specs() {
            let (_, sha256, bytes) = expected
                .iter()
                .find(|(target_id, _, _)| *target_id == spec.target_id)
                .unwrap_or_else(|| panic!("unexpected AOT target {}", spec.target_id));
            assert_eq!(spec.llvm_sha256, *sha256, "{}", spec.target_id);
            assert_eq!(spec.llvm_bytes, *bytes, "{}", spec.target_id);
            assert!(spec.llvm_url.starts_with("https://"), "{}", spec.target_id);
            assert_eq!(spec.llvm_sha256.len(), 64, "{}", spec.target_id);
            assert!(
                spec.llvm_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "{}",
                spec.target_id
            );
        }
    }
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
    let runtime_module = archive_entry_bytes(&runtime_archive, "oliphaunt/bin/oliphaunt")?;
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

    let pgdata_archive = base.join("prepopulated/pgdata-template.tar.zst");
    verify_pgdata_template_hash(&pgdata_archive)?;
    if let Some(template) = &manifest.pgdata_template {
        verify_file_sha256(
            &base.join(&template.archive),
            &template.sha256,
            "PGDATA template",
        )?;
        ensure_file(&base.join(&template.manifest))?;
        ensure_eq(
            &template.runtime_module_sha256,
            &manifest.runtime.module_sha256,
            "PGDATA template runtime module sha256",
        )?;
        if let Some(initdb) = &manifest.initdb {
            ensure_eq(
                &template.initdb_module_sha256,
                &initdb.module_sha256,
                "PGDATA template initdb module sha256",
            )?;
        }
    }

    if is_release_staged_workspace() {
        verify_root_asset_metadata(&manifest, &manifest.runtime.module_sha256)?;
        verify_file_sha256(
            &pgdata_archive,
            &cargo_metadata_value(
                "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
                "pgdata-template-archive-sha256",
            )?,
            "PGDATA template archive metadata",
        )?;
    }

    println!("generated asset hashes match manifests");
    Ok(())
}

fn verify_pgdata_template_hash(pgdata_archive: &Path) -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("prepopulated/pgdata-template.json");
    ensure!(
        manifest_path.exists() && pgdata_archive.exists(),
        "generated assets must include the bundled PGDATA template required by the default runtime; expected both {} and {}",
        manifest_path.display(),
        pgdata_archive.display()
    );
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let expected = manifest
        .get("archiveSha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("{} is missing archiveSha256", manifest_path.display()))?;
    verify_file_sha256(pgdata_archive, expected, "PGDATA template archive")?;
    Ok(())
}

fn verify_root_asset_metadata(
    manifest: &AssetManifestOut,
    runtime_module_sha256: &str,
) -> Result<()> {
    verify_root_metadata_value(
        "runtime-archive-sha256",
        &manifest.runtime.sha256,
        "runtime archive metadata",
    )?;
    verify_root_metadata_value(
        "oliphaunt-wasix-sha256",
        runtime_module_sha256,
        "runtime module metadata",
    )?;
    verify_root_metadata_value(
        "postgres-version",
        &manifest.runtime.postgres_version,
        "PostgreSQL version metadata",
    )?;
    let pg18 = load_postgres_source_manifest()?;
    verify_root_metadata_value(
        "postgres-source-url",
        &pg18.postgresql.url,
        "PostgreSQL source URL metadata",
    )?;
    verify_root_metadata_value(
        "postgres-source-sha256",
        &pg18.postgresql.sha256,
        "PostgreSQL source sha256 metadata",
    )?;
    verify_root_metadata_value(
        "postgres-patch-count",
        &pg18.patches.series.len().to_string(),
        "PostgreSQL patch count metadata",
    )?;
    if let Some(pg_dump) = &manifest.pg_dump {
        verify_tools_metadata_value("pg-dump-wasix-sha256", &pg_dump.sha256, "pg_dump metadata")?;
    }
    if let Some(psql) = &manifest.psql {
        verify_tools_metadata_value("psql-wasix-sha256", &psql.sha256, "psql metadata")?;
    }
    if let Some(initdb) = &manifest.initdb {
        verify_root_metadata_value("initdb-wasix-sha256", &initdb.sha256, "initdb metadata")?;
    }
    Ok(())
}

fn verify_root_metadata_value(key: &str, expected: &str, field: &str) -> Result<()> {
    let actual = cargo_metadata_value(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
        key,
    )?;
    ensure_eq(&actual, expected, field)
}

fn verify_tools_metadata_value(key: &str, expected: &str, field: &str) -> Result<()> {
    let actual = cargo_metadata_value(
        "src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml",
        key,
    )?;
    ensure_eq(&actual, expected, field)
}

fn cargo_metadata_value(path: &str, key: &str) -> Result<String> {
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let needle = format!("{key} = \"");
    let start = text
        .find(&needle)
        .ok_or_else(|| anyhow!("{path} metadata key '{key}' is missing"))?
        + needle.len();
    let end = text[start..]
        .find('"')
        .ok_or_else(|| anyhow!("{path} metadata key '{key}' is unterminated"))?;
    Ok(text[start..start + end].to_owned())
}

fn verify_file_sha256(path: &Path, expected: &str, field: &str) -> Result<()> {
    ensure_file(path)?;
    let actual = sha256_file(path)?;
    ensure_eq(&actual, expected, field)
}

fn check_no_committed_aot_artifacts() -> Result<()> {
    let tracked = command_output(
        "git",
        &["ls-files", "src/runtimes/liboliphaunt/wasix/crates/aot"],
        Path::new("."),
    )?;
    let committed_artifacts = tracked
        .lines()
        .filter(|path| path.contains("/artifacts/"))
        .collect::<Vec<_>>();
    if !committed_artifacts.is_empty() {
        bail!(
            "native AOT artifacts must be generated by CI and must not be committed:\n{}",
            committed_artifacts.join("\n")
        );
    }
    println!("committed repo contains no native AOT artifact blobs");
    Ok(())
}

fn check_aot_crate_templates(sources: &SourcesManifest) -> Result<()> {
    let expected = supported_aot_targets();
    for target in expected {
        let crate_dir = Path::new("src/runtimes/liboliphaunt/wasix/crates/aot").join(target);
        ensure_file(&crate_dir.join("Cargo.toml"))?;
        ensure_file(&crate_dir.join("README.md"))?;
        ensure_file(&crate_dir.join("build.rs"))?;
        let lib = crate_dir.join("src/lib.rs");
        ensure_file(&lib)?;

        let cargo_toml = fs::read_to_string(crate_dir.join("Cargo.toml"))
            .with_context(|| format!("read {}/Cargo.toml", crate_dir.display()))?;
        if !cargo_toml.contains("\"build.rs\"") || !cargo_toml.contains("\"artifacts/**\"") {
            bail!(
                "{} must include build.rs and generated artifacts/** when CI materializes the AOT crate",
                crate_dir.join("Cargo.toml").display()
            );
        }

        let lib_text =
            fs::read_to_string(&lib).with_context(|| format!("read {}", lib.display()))?;
        for required in [
            "#![deny(unsafe_code)]",
            "include!(concat!(env!(\"OUT_DIR\")",
        ] {
            if !lib_text.contains(required) {
                bail!("{} is not a source-only AOT crate template", lib.display());
            }
        }
        if lib_text.contains("include_bytes!") || lib_text.contains("include_str!(\"../artifacts/")
        {
            bail!(
                "{} embeds generated AOT artifacts; generated artifacts belong only in CI/release workspaces",
                lib.display()
            );
        }
        let build_rs = fs::read_to_string(crate_dir.join("build.rs"))
            .with_context(|| format!("read {}/build.rs", crate_dir.display()))?;
        for required in [
            "OLIPHAUNT_WASM_GENERATED_AOT_DIR",
            "target/oliphaunt-wasix/aot",
            "wasmer-version",
            sources.toolchain.wasmer.as_str(),
            "wasmer-wasix-version",
            sources.toolchain.wasmer_wasix.as_str(),
        ] {
            if !build_rs.contains(required) {
                bail!(
                    "{} build.rs is missing source-only AOT marker {required}",
                    crate_dir.display()
                );
            }
        }
    }
    println!("AOT crates are source-only templates for CI-generated release artifacts");
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct AotTargetSpec {
    triple: &'static str,
    target_id: &'static str,
    runner_os: &'static str,
    package: &'static str,
    llvm_url: &'static str,
    llvm_sha256: &'static str,
    llvm_bytes: u64,
}

#[derive(Debug, Serialize)]
struct AotCiMatrix {
    include: Vec<AotCiTarget>,
}

#[derive(Debug, Serialize)]
struct AotCiTarget {
    os: &'static str,
    target: &'static str,
    target_id: &'static str,
    package: &'static str,
    artifact: String,
    llvm_url: &'static str,
    llvm_sha256: &'static str,
    llvm_bytes: u64,
}

fn aot_target_specs() -> &'static [AotTargetSpec] {
    &[
        AotTargetSpec {
            triple: "aarch64-apple-darwin",
            target_id: "macos-arm64",
            runner_os: "macos-26",
            package: "liboliphaunt-wasix-aot-aarch64-apple-darwin",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-darwin-aarch64.tar.xz",
            llvm_sha256: "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847",
            llvm_bytes: 479_103_872,
        },
        AotTargetSpec {
            triple: "x86_64-unknown-linux-gnu",
            target_id: "linux-x64-gnu",
            runner_os: "ubuntu-24.04",
            package: "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-amd64.tar.xz",
            llvm_sha256: "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906",
            llvm_bytes: 741_670_068,
        },
        AotTargetSpec {
            triple: "aarch64-unknown-linux-gnu",
            target_id: "linux-arm64-gnu",
            runner_os: "ubuntu-24.04-arm",
            package: "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-aarch64.tar.xz",
            llvm_sha256: "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1",
            llvm_bytes: 668_873_496,
        },
        AotTargetSpec {
            triple: "x86_64-pc-windows-msvc",
            target_id: "windows-x64-msvc",
            runner_os: "windows-2025-vs2026",
            package: "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-windows-amd64.tar.xz",
            llvm_sha256: "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e",
            llvm_bytes: 757_929_860,
        },
    ]
}

pub(crate) fn supported_aot_targets() -> Vec<&'static str> {
    aot_target_specs().iter().map(|spec| spec.triple).collect()
}

pub(crate) fn supported_aot_target_ids() -> Vec<&'static str> {
    aot_target_specs()
        .iter()
        .map(|spec| spec.target_id)
        .collect()
}

pub(crate) fn aot_target_id_for_triple(target_triple: &str) -> Result<&'static str> {
    aot_target_specs()
        .iter()
        .find(|spec| spec.triple == target_triple)
        .map(|spec| spec.target_id)
        .with_context(|| {
            format!(
                "unsupported AOT target triple {target_triple}; supported triples are {}",
                supported_aot_targets().join(", ")
            )
        })
}

pub(crate) fn aot_triple_for_target_selector(selector: &str) -> Result<&'static str> {
    aot_target_specs()
        .iter()
        .find(|spec| selector == spec.triple || selector == spec.target_id)
        .map(|spec| spec.triple)
        .with_context(|| {
            format!(
                "unsupported AOT target {selector}; supported target ids are {}",
                supported_aot_target_ids().join(", ")
            )
        })
}

pub(crate) fn aot_artifact_name(target_triple: &str) -> String {
    let target_id = aot_target_id_for_triple(target_triple)
        .expect("AOT artifact names are only generated for supported target triples");
    format!("liboliphaunt-wasix-runtime-aot-{target_id}")
}

fn portable_wasix_artifact_name() -> &'static str {
    "liboliphaunt-wasix-runtime-portable"
}

pub(crate) fn print_supported_aot_targets() -> Result<()> {
    for spec in aot_target_specs() {
        println!("{}", spec.target_id);
    }
    Ok(())
}

pub(crate) fn print_internal_asset_packages() -> Result<()> {
    println!("liboliphaunt-wasix-portable");
    for spec in aot_target_specs() {
        println!("{}", spec.package);
    }
    Ok(())
}

pub(crate) fn print_ci_artifact_names() -> Result<()> {
    println!("{}", portable_wasix_artifact_name());
    for spec in aot_target_specs() {
        println!("{}", aot_artifact_name(spec.triple));
    }
    Ok(())
}

pub(crate) fn print_aot_ci_matrix(args: &[String]) -> Result<()> {
    let requested = value_after(args, "--target")
        .or_else(|| value_after(args, "--target-triple"))
        .unwrap_or("all");
    let github_output = args.iter().any(|arg| arg == "--github-output");
    let targets = aot_target_specs()
        .iter()
        .filter(|spec| {
            requested == "all" || requested == spec.triple || requested == spec.target_id
        })
        .map(|spec| AotCiTarget {
            os: spec.runner_os,
            target: spec.triple,
            target_id: spec.target_id,
            package: spec.package,
            artifact: aot_artifact_name(spec.triple),
            llvm_url: spec.llvm_url,
            llvm_sha256: spec.llvm_sha256,
            llvm_bytes: spec.llvm_bytes,
        })
        .collect::<Vec<_>>();
    ensure!(
        !targets.is_empty(),
        "unsupported native AOT target: {requested}"
    );
    let matrix = AotCiMatrix { include: targets };
    let json = serde_json::to_string(&matrix).context("serialize AOT CI matrix")?;
    if github_output {
        println!("matrix={json}");
    } else {
        println!("{}", serde_json::to_string_pretty(&matrix)?);
    }
    Ok(())
}

pub(crate) fn ensure_supported_aot_target(target: &str) -> Result<()> {
    if aot_target_specs().iter().any(|spec| spec.triple == target) {
        return Ok(());
    }
    bail!(
        "unsupported AOT target {target}; supported targets are {}",
        supported_aot_targets().join(", ")
    )
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
    let catalog_text = fs::read_to_string("src/extensions/generated/extensions.catalog.json")
        .context("read src/extensions/generated/extensions.catalog.json")?;
    let catalog: serde_json::Value =
        serde_json::from_str(&catalog_text).context("parse generated extension catalog")?;
    let generated = fs::read_to_string(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/generated_extensions.rs",
    )
    .context(
        "read src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/generated_extensions.rs",
    )?;

    let mut packaged_constants = BTreeMap::new();
    let mut promoted_constants = BTreeMap::new();
    for entry in catalog
        .get("extensions")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow!("extension catalog is missing extensions array"))?
    {
        let sql_name = entry
            .get("sql-name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("extension is missing sql-name"))?;
        let rust_constant = entry
            .get("rust-constant")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("extension {sql_name} is missing rust-constant"))?;
        let requested = entry
            .pointer("/promotion/requested")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let packaged = entry
            .pointer("/promotion/packaged")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let has_archive = entry
            .pointer("/promotion/archive")
            .and_then(|value| value.as_str())
            .is_some();
        if requested && packaged && has_archive {
            packaged_constants.insert(sql_name.to_owned(), rust_constant.to_owned());
        }
        let promoted = entry
            .pointer("/promotion/promoted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if promoted {
            promoted_constants.insert(sql_name.to_owned(), rust_constant.to_owned());
        }
    }

    let manifest_packaged_sql_names = manifest
        .extensions
        .iter()
        .map(|extension| extension.sql_name.clone())
        .collect::<BTreeSet<_>>();
    let catalog_packaged_sql_names = packaged_constants.keys().cloned().collect::<BTreeSet<_>>();
    if manifest_packaged_sql_names != catalog_packaged_sql_names {
        bail!(
            "packaged extension catalog and asset manifest disagree: manifest-only={:?} catalog-only={:?}",
            manifest_packaged_sql_names
                .difference(&catalog_packaged_sql_names)
                .collect::<Vec<_>>(),
            catalog_packaged_sql_names
                .difference(&manifest_packaged_sql_names)
                .collect::<Vec<_>>()
        );
    }

    let manifest_promoted_sql_names = manifest
        .extensions
        .iter()
        .filter(|extension| extension.smoke_status.promoted)
        .map(|extension| extension.sql_name.clone())
        .collect::<BTreeSet<_>>();
    let catalog_sql_names = promoted_constants.keys().cloned().collect::<BTreeSet<_>>();
    if manifest_promoted_sql_names != catalog_sql_names {
        bail!(
            "promoted extension catalog and asset manifest disagree: manifest-only={:?} catalog-only={:?}",
            manifest_promoted_sql_names
                .difference(&catalog_sql_names)
                .collect::<Vec<_>>(),
            catalog_sql_names
                .difference(&manifest_promoted_sql_names)
                .collect::<Vec<_>>()
        );
    }

    for extension in &manifest.extensions {
        let rust_constant = packaged_constants.get(&extension.sql_name).ok_or_else(|| {
            anyhow!(
                "extension {} missing from packaged catalog",
                extension.sql_name
            )
        })?;
        let candidate_const = format!("CANDIDATE_{rust_constant}");
        for (needle, description) in [
            (
                format!("pub(crate) const {candidate_const}: Extension ="),
                "packaged candidate extension constant",
            ),
            (
                format!("    {candidate_const},"),
                "extensions::CANDIDATES entry",
            ),
            (format!("{:?}", extension.sql_name), "extension SQL name"),
            (format!("{:?}", extension.archive), "extension archive path"),
        ] {
            if !generated.contains(&needle) {
                bail!("generated extension API is stale: missing {description} {needle}");
            }
        }
        if extension.smoke_status.promoted {
            for (needle, description) in [
                (
                    format!("pub const {rust_constant}: Extension = {candidate_const};"),
                    "public extension constant",
                ),
                (format!("    {rust_constant},"), "extensions::ALL entry"),
            ] {
                if !generated.contains(&needle) {
                    bail!("generated extension API is stale: missing {description} {needle}");
                }
            }
        }
        if extension.smoke_status.promoted {
            for status in [
                &extension.smoke_status.direct,
                &extension.smoke_status.server,
                &extension.smoke_status.restart,
                &extension.smoke_status.dump_restore,
            ] {
                ensure_eq(
                    status,
                    "passed",
                    &format!("extension {} smoke status", extension.sql_name),
                )?;
            }
        }
    }
    println!("generated extension API matches asset manifest and catalog");
    Ok(())
}

fn verify_generated_extension_surface_if_available() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    if !manifest_path.exists() {
        eprintln!(
            "warning: generated asset manifest is unavailable at {}; skipping generated extension manifest parity in source-only verification",
            manifest_path.display()
        );
        return Ok(());
    }
    let manifest_text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&manifest_text).context("parse generated asset manifest")?;
    if manifest.extensions.is_empty() {
        eprintln!(
            "warning: generated asset manifest is core-only; skipping generated extension manifest parity in source-only verification"
        );
        return Ok(());
    }
    verify_generated_extension_surface()
}

pub(crate) fn check_no_legacy_runtime_shims() -> Result<()> {
    let banned = [
        (
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs",
            &[
                "normalize_runtime_tree",
                "mirror_configured_share_layout",
                "mirror_configured_lib_layout",
                "normalize_pgdata_config",
                "share/timezonesets/Default",
                "write minimal timezoneset",
                "log_timezone = UTC",
                "timezone = UTC",
            ][..],
        ),
        (
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs",
            &[
                "\"oliphaunt_wasix_initdb\"",
                "\"oliphaunt_wasix_backend\"",
                "PostgresRecoverProtocolError",
            ][..],
        ),
    ];

    let mut failures = Vec::new();
    for (path, patterns) in banned {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        for pattern in patterns {
            if text.contains(pattern) {
                failures.push(format!(
                    "{path} contains legacy runtime shim marker {pattern:?}"
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    println!("legacy runtime shim source guard passed");
    Ok(())
}

pub(crate) fn check_production_wasix_build_inputs() -> Result<()> {
    for required in [
        WASIX_BRIDGE_PATH,
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge_abi_test.c",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim_abi_test.c",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_shim.c",
        "src/runtimes/liboliphaunt/wasix/assets/build/analyze_pgl_stubs.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/pg_config_wasix.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/isrg-root-x1.pem",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_icu_link.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_openssl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_sqlite.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_geos.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libxml2.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_jsonc.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_proj.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh",
        "src/extensions/external/postgis/tools/build_wasix.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim.c",
        "src/runtimes/liboliphaunt/native/portable-uuid/include/uuid/uuid.h",
        "src/runtimes/liboliphaunt/native/portable-uuid/portable_uuid.c",
        POSTGRES_SOURCE_MANIFEST_PATH,
        POSTGRES_PATCH_SERIES_PATH,
        POSTGRES_EXPERIMENT_DISPOSITION_PATH,
    ] {
        if !Path::new(required).exists() {
            bail!("production WASIX build input is missing: {required}");
        }
    }
    check_wasix_shell_script_syntax()?;
    check_root_asset_metadata_keys()?;

    let production_files = [
        "tools/xtask/src/asset_pipeline.rs",
        "src/runtimes/liboliphaunt/wasix/assets/build/analyze_pgl_stubs.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/pg_config_wasix.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_icu_link.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_openssl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_sqlite.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_geos.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libxml2.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_jsonc.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_proj.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh",
        "src/extensions/external/postgis/tools/build_wasix.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim.c",
    ];
    for path in production_files {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        if path == "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh"
            && text.contains("--disable-spinlocks")
        {
            bail!(
                "{path} disables PostgreSQL spinlocks; WASIX builds must use the toolchain atomics path"
            );
        }
    }
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh",
        &[
            "WASIX_HOME:=/opt/wasixcc-home/.wasixcc",
            "ln -s \"$WASIX_HOME\" \"$HOME/.wasixcc\"",
            "export PATH=\"$WASIX_HOME/bin:$PATH\"",
        ],
    )?;
    for path in wasix_build_scripts_requiring_docker_env()? {
        ensure_file_contains_all(&path, &["docker_wasix_env.sh"])?;
    }

    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh",
        &[
            "release)",
            "-O2 -g0",
            "release-o3)",
            "-O3 -g0 -flto=thin",
            "-flto=thin",
            "release-os)",
            "-Os -g0",
            "release-oz)",
            "-Oz -g0",
            "--converge:--strip-debug:--strip-producers",
            "WASIXCC_RUN_WASM_OPT",
            "WASIXCC_WASM_OPT_FLAGS",
            "OLIPHAUNT_WASM_ALLOW_ASYNCIFY_EXPERIMENT",
            "OLIPHAUNT_WASM_WASIX_BACKEND_TIMING",
            "production WASIX artifacts require WebAssembly exceptions",
            "build_wasix_icu_sha256",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        &[
            "build_wasix_icu.sh",
            "--with-icu",
            "ICU_CFLAGS",
            "ICU_LIBS",
            "oliphaunt_wasix_icu_cflags",
            "oliphaunt_wasix_icu_libs",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_icu_link.sh",
        &[
            "oliphaunt_wasix_cxx_runtime_libs",
            "oliphaunt_wasix_icu_cflags",
            "oliphaunt_wasix_icu_libs",
            "U_STATIC_IMPLEMENTATION",
            "WASIX_CXX_RUNTIME_LIB_DIR",
            "sysroot-exnref-ehpic",
            "libicui18n.a",
            "libicuuc.a",
            "libicudata.a",
            "libc++.a",
            "libc++abi.a",
            "libunwind.a",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh",
        &[
            "unicode/ucol.h",
            "--with-data-packaging=files",
            "static-consumer",
            "stub-data-archive",
            "icu_stub_data_archive_ready",
            "icu_files_data_ready",
            "icu_install_stub_data_archive",
            "members=\"$(ar -t \"$archive\")\"",
            "icu_wasix_config_ready",
            "icu_cv_host_frag=mh-linux",
            "wasix-platform-fragment=mh-linux",
            "ac_cv_var_tzname=no",
            "ac_cv_var__tzname=no",
            "wasix-timezone-cache=no-tzname",
            "icu_pkgdata_opts=\"-O $ICU_BUILD_DIR/data/icupkg.inc -w\"",
            "wasix-data-packaging=files-without-assembly",
            "stubdata\\.ao",
            "packagedata",
            "--disable-tools",
            "--disable-icuio",
            "--disable-layoutex",
            "makeconv",
            "genrb",
            "pkgdata",
            "libicui18n.a",
            "libicuuc.a",
            "libicudata.a",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs",
        &["ICU_DATA", "/share/icu", "wasix_icu_data_is_available"],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/pg_dump.rs",
        &[
            "ICU_DATA",
            "/oliphaunt/share/icu",
            "install_optional_icu_data",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/pg_config_wasix.sh",
        &[
            ". \"$ROOT/source_lane.sh\"",
            "oliphaunt_wasix_default_build_dir",
            "PGSRC must be set when pg_config_wasix.sh runs",
            "PG18 PGSRC is missing .oliphaunt-wasix-postgres-version",
            "PG18 PGSRC is missing .oliphaunt-wasix-source-fingerprint",
            ".oliphaunt-wasix-postgres-version",
            "source_toml=\"$ROOT/postgres/source.toml\"",
            "PostgreSQL $(postgres_version)",
            "--includedir-server",
            "$BUILD_DIR/src/include",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_BRIDGE_PATH,
        &[
            "oliphaunt_wasix_backend_timing_reset",
            "oliphaunt_wasix_backend_timing_start",
            "oliphaunt_wasix_backend_timing_end",
            "oliphaunt_wasix_backend_timing_elapsed_us",
            "CLOCK_MONOTONIC",
            "#ifdef OLIPHAUNT_WASIX_BACKEND_TIMING",
            "oliphaunt_wasix_set_force_host_error_recovery",
            "force_host_error_recovery",
            "Hosts without that support",
            "oliphaunt_wasix_set_active",
            "oliphaunt_wasix_longjmp",
            "oliphaunt_wasix_siglongjmp",
            "memcmp(env, (void *) postgresmain_sigjmp_buf, sizeof(jmp_buf)) == 0",
            "oliphaunt_wasix_getegid",
            "oliphaunt_wasix_getpwuid_r",
            "oliphaunt_wasix_run_atexit_funcs",
        ],
    )?;
    check_wasix_bridge_abi_harness()?;
    check_wasix_initdb_shim_abi_harness()?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        &[
            "OLIPHAUNT_WASM_BUILD_PROFILE",
            "OLIPHAUNT_WASM_WASIX_BACKEND_TIMING",
            ".oliphaunt-wasix-build-profile",
            ".oliphaunt-wasix-icu-build",
            "oliphaunt_wasix_wasix_profile_signature",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
        &[
            "build_wasix_icu.sh",
            "oliphaunt_wasix_icu_cflags",
            "oliphaunt_wasix_icu_libs",
            "ICU_CFLAGS",
            "ICU_LIBS",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh",
        &[
            "build_wasix_icu.sh",
            "oliphaunt_wasix_icu_cflags",
            "oliphaunt_wasix_icu_libs",
            "ICU_CFLAGS",
            "ICU_LIBS",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh",
        &[
            "build_wasix_icu.sh",
            "oliphaunt_wasix_icu_cflags",
            "oliphaunt_wasix_icu_libs",
            "ICU_CFLAGS",
            "ICU_LIBS",
        ],
    )?;
    for path in [
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
    ] {
        ensure_file_contains_all(path, &["OLIPHAUNT_WASM_SKIP_IMAGE_BUILD"])?;
    }
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh",
        &[
            "oliphaunt_wasix_run_extension_build_in_docker_if_needed",
            "OLIPHAUNT_WASM_EXTENSION_BUILD_IN_DOCKER",
            "command -v wasixcc",
            "oliphaunt_wasix_extension_build_outputs_exist",
            "required_build_files",
            "required_build_globs",
        ],
    )?;
    ensure_file_contains_all(
        "src/extensions/external/postgis/tools/build_wasix.sh",
        &[
            "oliphaunt_wasix_run_extension_build_in_docker_if_needed",
            "oliphaunt_wasix_extension_build_outputs_exist",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh",
        &[
            "oliphaunt_wasix_apply_wasix_profile configure",
            "oliphaunt_wasix_apply_wasix_profile build",
        ],
    )?;

    println!("production WASIX build input guard passed");
    Ok(())
}

fn wasix_build_scripts_requiring_docker_env() -> Result<Vec<PathBuf>> {
    let scripts = crate::postgres_guard::wasix_build_shell_scripts()?
        .into_iter()
        .filter(|path| {
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                return false;
            };
            file_name.starts_with("build_wasix_")
                || matches!(
                    file_name,
                    "analyze_pgl_stubs.sh"
                        | "docker_contrib_extensions.sh"
                        | "docker_oliphaunt.sh"
                        | "docker_pgdump.sh"
                        | "docker_pgxs_extensions.sh"
                        | "docker_psql.sh"
                        | "docker_runtime_support.sh"
                )
        })
        .collect::<Vec<_>>();
    ensure!(
        !scripts.is_empty(),
        "WASIX build guard found no scripts requiring docker_wasix_env.sh"
    );
    Ok(scripts)
}

fn check_root_asset_metadata_keys() -> Result<()> {
    let path = "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml";
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    for required in [
        "postgres-version",
        "postgres-source-url",
        "postgres-source-sha256",
        "postgres-patch-count",
        "runtime-archive-sha256",
        "oliphaunt-wasix-sha256",
        "pgdata-template-archive-sha256",
        "initdb-wasix-sha256",
    ] {
        let needle = format!("{required} = \"");
        ensure!(
            text.contains(&needle),
            "{path} is missing WASIX asset metadata key {required}"
        );
    }
    let tools_path = "src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml";
    let tools_text =
        fs::read_to_string(tools_path).with_context(|| format!("read {tools_path}"))?;
    for required in ["pg-dump-wasix-sha256", "psql-wasix-sha256"] {
        let needle = format!("{required} = \"");
        ensure!(
            tools_text.contains(&needle),
            "{tools_path} is missing WASIX tools asset metadata key {required}"
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
    let required_paths = vec![
        "oliphaunt/bin/oliphaunt",
        "oliphaunt/bin/postgres",
        "oliphaunt/bin/initdb",
        "oliphaunt/lib/postgresql/plpgsql.so",
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

pub(crate) fn audit_upstream_fixes(_manifest: &SourcesManifest, _strict: bool) -> Result<()> {
    check_postgres_source_spine()?;
    check_production_wasix_build_inputs()?;
    check_no_legacy_runtime_shims()?;
    check_source_lane_isolation()?;
    println!("audited PG18 WASIX runtime guards");
    Ok(())
}

pub(crate) fn ensure_file_contains_all(path: impl AsRef<Path>, markers: &[&str]) -> Result<()> {
    let path = path.as_ref();
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let missing = markers
        .iter()
        .copied()
        .filter(|marker| !text.contains(marker))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        bail!(
            "{} is missing required upstream replacement markers: {}",
            path.display(),
            missing.join(", ")
        );
    }
    Ok(())
}

pub(crate) fn ensure_file_not_contains_any(path: &str, markers: &[&str]) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let present = markers
        .iter()
        .copied()
        .filter(|marker| text.contains(marker))
        .collect::<Vec<_>>();
    if !present.is_empty() {
        bail!(
            "{path} contains production-excluded markers: {}",
            present.join(", ")
        );
    }
    Ok(())
}

pub(crate) fn check_manifest_source_checkouts_filtered<F>(
    manifest: &SourcesManifest,
    strict_local: bool,
    include: F,
) -> Result<()>
where
    F: Fn(&SourcePin) -> bool,
{
    for source in &manifest.sources {
        if !include(source) {
            continue;
        }
        let Some(path) = source_checkout_path(source.name.as_str()) else {
            if strict_local {
                bail!("source '{}' has no configured checkout path", source.name);
            }
            eprintln!(
                "warning: source '{}' has no configured checkout path",
                source.name
            );
            continue;
        };
        if source.kind == SourceKind::Archive {
            check_archive_source_path(source, &path, strict_local)?;
            continue;
        }
        if !path.join(".git").exists() {
            if strict_local {
                bail!("missing local checkout {}", path.display());
            }
            eprintln!("warning: local checkout {} is missing", path.display());
            continue;
        }
        let head = command_output("git", &["rev-parse", "HEAD"], &path)
            .with_context(|| format!("read HEAD for {}", path.display()))?;
        if head.trim() != source.commit {
            if strict_local {
                bail!(
                    "local {} checkout is at {}, expected {} from source metadata",
                    path.display(),
                    head.trim(),
                    source.commit
                );
            }
            eprintln!(
                "warning: local {} checkout is at {}, expected {}",
                path.display(),
                head.trim(),
                source.commit
            );
        }
        let branch = command_output("git", &["branch", "--show-current"], &path)
            .unwrap_or_else(|_| String::from("<detached>"));
        if strict_local && branch.trim() != source.branch {
            bail!(
                "local {} checkout is on branch '{}', expected '{}'",
                path.display(),
                branch.trim(),
                source.branch
            );
        }
        let status = source_checkout_status_for_source(source.name.as_str(), &path)
            .with_context(|| format!("read status for {}", path.display()))?;
        if !status.trim().is_empty() {
            if strict_local {
                bail!(
                    "local {} checkout ({}) has uncommitted changes; preserve them before strict asset builds",
                    path.display(),
                    source.name
                );
            }
            eprintln!(
                "warning: local {} checkout ({}) has uncommitted changes",
                path.display(),
                source.name
            );
        }
    }
    Ok(())
}

fn check_archive_source_path(source: &SourcePin, path: &Path, strict_local: bool) -> Result<()> {
    let stamp_path = path.join(".oliphaunt-source-pin");
    if !path.is_dir() || !stamp_path.is_file() {
        if strict_local {
            bail!("missing local archive source {}", path.display());
        }
        eprintln!(
            "warning: local archive source {} is missing",
            path.display()
        );
        return Ok(());
    }
    let actual = fs::read_to_string(&stamp_path)
        .with_context(|| format!("read {}", stamp_path.display()))?;
    let tree_sha256 = match archive_source_tree_digest(path) {
        Ok(digest) => digest,
        Err(error) if strict_local => {
            return Err(error).with_context(|| {
                format!(
                    "verify local archive source {} ({})",
                    path.display(),
                    source.name
                )
            });
        }
        Err(error) => {
            eprintln!(
                "warning: local archive source {} ({}) has unverifiable contents: {error}",
                path.display(),
                source.name
            );
            return Ok(());
        }
    };
    let expected = source.archive_stamp(&tree_sha256);
    if actual != expected {
        if strict_local {
            bail!(
                "local archive source {} ({}) does not match source metadata",
                path.display(),
                source.name
            );
        }
        eprintln!(
            "warning: local archive source {} ({}) does not match source metadata",
            path.display(),
            source.name
        );
    }
    Ok(())
}

fn archive_source_tree_digest(path: &Path) -> Result<String> {
    const MAX_ENTRIES: usize = 500_000;
    const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

    let mut entries: Vec<(Vec<u8>, &'static str, String)> = Vec::new();
    let mut total_bytes = 0_u64;
    for entry in WalkDir::new(path).follow_links(false).into_iter() {
        let entry = entry.with_context(|| format!("walk archive source {}", path.display()))?;
        if entry.path() == path {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .with_context(|| format!("derive path below {}", path.display()))?;
        if relative == Path::new(".oliphaunt-source-pin") {
            continue;
        }
        let relative = relative
            .components()
            .map(|component| {
                component.as_os_str().to_str().ok_or_else(|| {
                    anyhow!(
                        "archive source path is not UTF-8: {}",
                        entry.path().display()
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join("/");
        let metadata = fs::symlink_metadata(entry.path())
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        let (kind, detail) = if metadata.is_dir() {
            ("directory", String::new())
        } else if metadata.is_file() {
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| anyhow!("archive source byte count overflow"))?;
            ensure!(
                total_bytes <= MAX_BYTES,
                "archive source {} exceeds {MAX_BYTES} bytes",
                path.display()
            );
            (
                "file",
                format!("{}:{}", metadata.len(), sha256_file(entry.path())?),
            )
        } else if metadata.file_type().is_symlink() {
            let target = fs::read_link(entry.path())
                .with_context(|| format!("read symlink {}", entry.path().display()))?;
            let target = target.to_str().ok_or_else(|| {
                anyhow!("symlink target is not UTF-8: {}", entry.path().display())
            })?;
            ("symlink", target.to_owned())
        } else {
            bail!(
                "archive source contains unsupported filesystem object {}",
                entry.path().display()
            );
        };
        entries.push((relative.as_bytes().to_vec(), kind, detail));
        ensure!(
            entries.len() <= MAX_ENTRIES,
            "archive source {} exceeds {MAX_ENTRIES} entries",
            path.display()
        );
    }

    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (relative, kind, detail) in entries {
        for field in [kind.as_bytes(), relative.as_slice(), detail.as_bytes()] {
            hasher.update(field);
            hasher.update([0]);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn source_checkout_status(path: &Path) -> Result<String> {
    command_output("git", &["status", "--porcelain"], path)
}

pub(crate) fn source_checkout_status_for_source(name: &str, path: &Path) -> Result<String> {
    if name == "postgres18-extension-sources" {
        return command_output(
            "git",
            &["status", "--porcelain", "--ignore-submodules=all"],
            path,
        );
    }
    source_checkout_status(path)
}

#[cfg(unix)]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    let bridge = Path::new(WASIX_BRIDGE_PATH);
    let harness = Path::new(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge_abi_test.c",
    );
    if !harness.exists() {
        bail!("missing WASIX bridge ABI harness at {}", harness.display());
    }

    let out_dir = Path::new("target/xtask");
    fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let binary = out_dir.join("oliphaunt_wasix_bridge_abi_test");
    let cc = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let status = Command::new(&cc)
        .args(["-std=c11", "-Wall", "-Wextra"])
        .arg(bridge)
        .arg(harness)
        .arg("-o")
        .arg(&binary)
        .status()
        .with_context(|| format!("compile WASIX bridge ABI harness with {cc}"))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness compilation failed with {status}");
    }
    let status = Command::new(&binary)
        .stdout(Stdio::null())
        .status()
        .with_context(|| format!("run {}", binary.display()))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness failed with {status}");
    }
    println!("WASIX bridge ABI harness passed");
    Ok(())
}

#[cfg(unix)]
fn check_wasix_initdb_shim_abi_harness() -> Result<()> {
    let shim = Path::new(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim.c",
    );
    let harness = Path::new(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim_abi_test.c",
    );
    if !harness.exists() {
        bail!(
            "missing WASIX initdb shim ABI harness at {}",
            harness.display()
        );
    }

    let out_dir = Path::new("target/xtask");
    fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let binary = out_dir.join("oliphaunt_wasix_initdb_shim_abi_test");
    let cc = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let status = Command::new(&cc)
        .args(["-std=c11", "-Wall", "-Wextra"])
        .arg(shim)
        .arg(harness)
        .arg("-o")
        .arg(&binary)
        .status()
        .with_context(|| format!("compile {}", harness.display()))?;
    if !status.success() {
        bail!("failed to compile {}", harness.display());
    }

    let status = Command::new(&binary)
        .status()
        .with_context(|| format!("run {}", binary.display()))?;
    if !status.success() {
        bail!("WASIX initdb shim ABI harness failed");
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_wasix_initdb_shim_abi_harness() -> Result<()> {
    println!("skipping WASIX initdb shim ABI harness on non-Unix host");
    Ok(())
}

#[cfg(not(unix))]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    eprintln!("warning: skipping POSIX WASIX bridge ABI harness on non-Unix host");
    Ok(())
}
