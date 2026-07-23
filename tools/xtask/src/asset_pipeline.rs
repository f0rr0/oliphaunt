use super::*;

pub(crate) struct BuildOutputs {
    source_lane: String,
    source_fingerprint: Option<String>,
    postgres_version: String,
    build_dir: PathBuf,
    source_dir: PathBuf,
    package_stage: PathBuf,
    modules: Vec<BuildModuleOutput>,
}

struct BuildModuleOutput {
    name: String,
    kind: String,
    path: PathBuf,
    aot_file: String,
    requires_aot: bool,
}

fn postgres_source_dir() -> Result<PathBuf> {
    let manifest = load_postgres_source_manifest()?;
    let source = postgres_default_source_dir(&manifest);
    ensure!(
        source.join(".oliphaunt-wasix-source-fingerprint").is_file(),
        "missing prepared PG18 WASIX source at {}; run {POSTGRES_PREPARE_SCRIPT}",
        source.display()
    );
    check_prepared_postgres_source(&manifest, &source, Path::new(WASIX_POSTGRES_WORK_DIR))?;
    Ok(source)
}

fn postgres_version_for_source_lane(source_lane: &str, source_dir: &Path) -> Result<String> {
    match source_lane {
        "stable" => {
            let version_path = source_dir.join(".oliphaunt-wasix-postgres-version");
            let version = fs::read_to_string(&version_path)
                .with_context(|| format!("read {}", version_path.display()))?;
            let version = version.trim();
            ensure!(
                !version.is_empty(),
                "{} must contain a PostgreSQL version",
                version_path.display()
            );
            Ok(version.to_owned())
        }
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    }
}

fn source_fingerprint_for_source_lane(
    source_lane: &str,
    source_dir: &Path,
) -> Result<Option<String>> {
    match source_lane {
        "stable" => {
            let path = source_dir.join(".oliphaunt-wasix-source-fingerprint");
            let fingerprint =
                fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
            let fingerprint = fingerprint.trim();
            ensure!(
                !fingerprint.is_empty(),
                "{} must contain a PG18 source fingerprint",
                path.display()
            );
            Ok(Some(fingerprint.to_owned()))
        }
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    }
}

fn expected_postgres_source_fingerprint() -> Result<String> {
    let manifest = load_postgres_source_manifest()?;
    postgres_expected_source_fingerprint(&manifest)
}

pub(crate) fn ensure_postgres_source_fingerprint_matches_current(
    actual: Option<&str>,
    field: &str,
) -> Result<()> {
    let expected = expected_postgres_source_fingerprint()?;
    ensure_eq(actual.unwrap_or("<missing>"), &expected, field)
}

fn postgres_major_version(postgres_version: &str) -> String {
    postgres_version
        .split('.')
        .next()
        .filter(|major| !major.is_empty())
        .unwrap_or(postgres_version)
        .to_owned()
}

pub(crate) fn ensure_packaged_asset_matches_source_lane(
    manifest: &AssetManifestOut,
    source_lane: &str,
) -> Result<()> {
    let expected = canonical_source_lane(source_lane)?;
    if let Some(actual) = manifest.source_lane.as_deref() {
        ensure_eq(actual, expected, "packaged asset manifest source-lane")?;
    }
    match expected {
        "stable" => ensure!(
            manifest.runtime.postgres_version.starts_with("18."),
            "packaged assets are PostgreSQL {}, not the PG18 WASIX runtime",
            manifest.runtime.postgres_version
        ),
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
    if expected == "stable" {
        ensure_postgres_source_fingerprint_matches_current(
            manifest.source_fingerprint.as_deref(),
            "packaged asset manifest source-fingerprint",
        )?;
    }
    Ok(())
}

fn ensure_build_output_manifest_matches_source_lane(
    manifest: &BuildOutputManifestOut,
    source_lane: &str,
) -> Result<()> {
    let expected = canonical_source_lane(source_lane)?;
    let actual = manifest.source_lane.as_deref().unwrap_or("<missing>");
    match expected {
        "stable" => {
            ensure_eq(actual, "stable", "WASIX build output manifest source-lane")?;
            let pg18 = load_postgres_source_manifest()?;
            ensure_eq(
                manifest.postgres_version.as_deref().unwrap_or("<missing>"),
                pg18.postgresql.version.as_str(),
                "WASIX build output manifest postgres-version",
            )?;
            ensure_postgres_source_fingerprint_matches_current(
                manifest.source_fingerprint.as_deref(),
                "WASIX build output manifest source-fingerprint",
            )?;
            ensure_postgres_build_output_manifest_paths_are_stable(manifest)?;
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
    if let Some(postgres_version) = manifest.postgres_version.as_deref() {
        match expected {
            "stable" => ensure!(
                postgres_version.starts_with("18."),
                "WASIX build output manifest is PostgreSQL {postgres_version}, not the PG18 WASIX runtime"
            ),
            _ => unreachable!("canonical_source_lane returned an unsupported lane"),
        }
    }
    Ok(())
}

fn ensure_postgres_build_output_manifest_paths_are_stable(
    manifest: &BuildOutputManifestOut,
) -> Result<()> {
    let postgres_root = Path::new(WASIX_POSTGRES_DOCKER_BUILD_DIR);
    for module in &manifest.modules {
        let path = Path::new(&module.path);
        ensure!(
            path.starts_with(postgres_root),
            "PostgreSQL build output manifest module {} points outside the stable build root: {}",
            module.name,
            module.path
        );
    }
    Ok(())
}

pub(crate) fn canonical_source_lane(source_lane: &str) -> Result<&'static str> {
    match source_lane {
        "stable" | "released" | "packaged" | "default" => Ok(DEFAULT_SOURCE_LANE),
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    }
}

pub(crate) fn build_output_manifest_path_for_source_lane(
    source_lane: &str,
) -> Result<&'static Path> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(WASIX_POSTGRES_BUILD_MANIFEST_PATH)),
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    }
}

pub(crate) fn build_output_manifest_paths_for_source_lane(
    source_lane: &str,
) -> Result<Vec<&'static Path>> {
    let primary = build_output_manifest_path_for_source_lane(source_lane)?;
    let _ = canonical_source_lane(source_lane)?;
    Ok(vec![primary])
}

pub(crate) fn generated_assets_dir_for_source_lane(source_lane: &str) -> Result<&'static Path> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(GENERATED_ASSETS_DIR)),
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    }
}

pub(crate) fn generated_aot_source_dir_for_source_lane(
    target: &str,
    source_lane: &str,
) -> Result<PathBuf> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(WASIX_POSTGRES_GENERATED_BUILD_DIR)
            .join("aot")
            .join(target)),
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

fn generated_aot_inputs_dir_for_source_lane(source_lane: &str) -> Result<PathBuf> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(WASIX_POSTGRES_GENERATED_BUILD_DIR).join("aot-inputs")),
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

pub(crate) fn generated_aot_dir_for_source_lane(
    target: &str,
    source_lane: &str,
) -> Result<PathBuf> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(GENERATED_AOT_DIR).join(target)),
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

pub(crate) fn skip_extensions_for_perf_probe() -> bool {
    env::var("OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF").as_deref() == Ok("1")
}

impl BuildOutputs {
    pub(crate) fn discover_for_source_lane(source_lane: &str) -> Result<Self> {
        let source_lane = canonical_source_lane(source_lane)?;
        let (canonical_source_lane, build_dir, source_dir, package_stage) = match source_lane {
            "stable" => (
                "stable".to_owned(),
                PathBuf::from(WASIX_POSTGRES_DOCKER_BUILD_DIR),
                postgres_source_dir()?,
                PathBuf::from(WASIX_POSTGRES_GENERATED_BUILD_DIR).join("package-stage"),
            ),
            other => unreachable!("canonical_source_lane returned an unsupported lane: {other}"),
        };
        let mut modules = vec![
            BuildModuleOutput {
                name: "runtime:oliphaunt".to_owned(),
                kind: "runtime".to_owned(),
                path: build_dir.join("src/backend/oliphaunt"),
                aot_file: "oliphaunt-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            },
            BuildModuleOutput {
                name: "runtime-support:plpgsql".to_owned(),
                kind: "runtime-support".to_owned(),
                path: build_dir.join("src/pl/plpgsql/src/plpgsql.so"),
                aot_file: "plpgsql-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            },
            BuildModuleOutput {
                name: "runtime-support:dict_snowball".to_owned(),
                kind: "runtime-support".to_owned(),
                path: build_dir.join("src/backend/snowball/dict_snowball.so"),
                aot_file: "dict_snowball-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            },
            BuildModuleOutput {
                name: "tool:initdb".to_owned(),
                kind: "tool".to_owned(),
                path: build_dir.join("src/bin/initdb/initdb"),
                aot_file: "initdb-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            },
        ];
        if !skip_extensions_for_perf_probe() {
            modules.push(BuildModuleOutput {
                name: "tool:pg_dump".to_owned(),
                kind: "tool".to_owned(),
                path: build_dir.join("src/bin/pg_dump/pg_dump"),
                aot_file: "pg_dump-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            });
            modules.push(BuildModuleOutput {
                name: "tool:psql".to_owned(),
                kind: "tool".to_owned(),
                path: build_dir.join("src/bin/psql/psql"),
                aot_file: "psql-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            });
        }
        if !skip_extensions_for_perf_probe() {
            for extension in extension_catalog::promoted_build_specs()? {
                for support_module in &extension.native_support_modules {
                    modules.push(BuildModuleOutput {
                        name: format!("extension:{}:{}", extension.sql_name, support_module.name),
                        kind: "extension".to_owned(),
                        path: build_dir.join(&support_module.build_path),
                        aot_file: support_module.aot_file.clone(),
                        requires_aot: true,
                    });
                }
                if extension.module_file.is_some() {
                    modules.push(BuildModuleOutput {
                        name: format!("extension:{}", extension.sql_name),
                        kind: "extension".to_owned(),
                        path: extension_build_module_path(&build_dir, &extension)?,
                        aot_file: format!(
                            "{}-llvm-opta.bin.zst",
                            extension_aot_file_stem(&extension)
                        ),
                        requires_aot: true,
                    });
                }
            }
        }

        let outputs = Self {
            postgres_version: postgres_version_for_source_lane(
                &canonical_source_lane,
                &source_dir,
            )?,
            source_fingerprint: source_fingerprint_for_source_lane(
                &canonical_source_lane,
                &source_dir,
            )?,
            source_lane: canonical_source_lane,
            build_dir,
            source_dir,
            package_stage,
            modules,
        };
        outputs.ensure_required_files()?;
        Ok(outputs)
    }

    pub(crate) fn discover_for_aot(source_lane: &str) -> Result<Self> {
        let canonical = canonical_source_lane(source_lane)?;
        if canonical == DEFAULT_SOURCE_LANE {
            return Self::discover_for_source_lane(source_lane).or_else(|build_err| {
                eprintln!(
                    "warning: transient WASIX build tree unavailable for {source_lane} AOT packaging: {build_err:#}"
                );
                Self::from_packaged_assets_for_source_lane(source_lane)
            });
        }
        unreachable!("canonical_source_lane returned an unsupported lane: {canonical}")
    }

    fn from_packaged_assets_for_source_lane(source_lane: &str) -> Result<Self> {
        let manifest = read_asset_manifest_for_source_lane(source_lane)?;
        ensure_packaged_asset_matches_source_lane(&manifest, source_lane)?;
        let canonical_source_lane = canonical_source_lane(source_lane)?;
        let base = generated_aot_inputs_dir_for_source_lane(source_lane)?;
        if base.exists() {
            fs::remove_dir_all(&base).with_context(|| format!("remove {}", base.display()))?;
        }
        fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;

        let assets_base = generated_assets_dir_for_source_lane(source_lane)?;
        let runtime_archive = assets_base.join(&manifest.runtime.archive);
        let runtime_path = base.join("runtime/oliphaunt");
        write_bytes_file(
            &runtime_path,
            &archive_entry_bytes(&runtime_archive, "oliphaunt/bin/oliphaunt")?,
        )?;

        let mut modules = vec![BuildModuleOutput {
            name: "runtime:oliphaunt".to_owned(),
            kind: "runtime".to_owned(),
            path: runtime_path,
            aot_file: "oliphaunt-llvm-opta.bin.zst".to_owned(),
            requires_aot: true,
        }];

        for support in &manifest.runtime_support {
            let path = base.join("runtime-support").join(&support.name);
            write_bytes_file(
                &path,
                &archive_entry_bytes(&runtime_archive, &format!("oliphaunt/{}", support.path))?,
            )?;
            modules.push(BuildModuleOutput {
                name: format!("runtime-support:{}", support.name),
                kind: "runtime-support".to_owned(),
                path,
                aot_file: format!("{}-llvm-opta.bin.zst", support.name),
                requires_aot: true,
            });
        }

        if let Some(pg_dump) = &manifest.pg_dump {
            let path = base.join("tools/pg_dump");
            copy_file(&assets_base.join(&pg_dump.path), &path)?;
            modules.push(BuildModuleOutput {
                name: "tool:pg_dump".to_owned(),
                kind: "tool".to_owned(),
                path,
                aot_file: "pg_dump-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            });
        }
        if let Some(psql) = &manifest.psql {
            let path = base.join("tools/psql");
            copy_file(&assets_base.join(&psql.path), &path)?;
            modules.push(BuildModuleOutput {
                name: "tool:psql".to_owned(),
                kind: "tool".to_owned(),
                path,
                aot_file: "psql-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            });
        }
        if let Some(initdb) = &manifest.initdb {
            let path = base.join("tools/initdb");
            copy_file(&assets_base.join(&initdb.path), &path)?;
            modules.push(BuildModuleOutput {
                name: "tool:initdb".to_owned(),
                kind: "tool".to_owned(),
                path,
                aot_file: "initdb-llvm-opta.bin.zst".to_owned(),
                requires_aot: true,
            });
        }

        for extension in &manifest.extensions {
            let mut native_modules = extension.native_modules.clone();
            if native_modules.is_empty()
                && let Some(native_module) = extension.native_module.as_deref()
                && !extension.module_sha256.is_empty()
            {
                native_modules.push(BinaryAssetOut {
                    name: extension.sql_name.clone(),
                    path: format!("lib/postgresql/{native_module}"),
                    sha256: extension.module_sha256.clone(),
                    module_sha256: extension.module_sha256.clone(),
                    size: 0,
                    link: extension.link.clone().unwrap_or_default(),
                });
            }
            for native_module in native_modules {
                if native_module.module_sha256.is_empty() {
                    continue;
                }
                let path = base.join("extensions").join(&extension.sql_name).join(
                    Path::new(&native_module.path)
                        .file_name()
                        .unwrap_or_default(),
                );
                write_bytes_file(
                    &path,
                    &archive_entry_bytes(
                        &assets_base.join(&extension.archive),
                        &native_module.path,
                    )?,
                )?;
                modules.push(BuildModuleOutput {
                    name: if native_module.name == extension.sql_name {
                        format!("extension:{}", extension.sql_name)
                    } else {
                        format!("extension:{}:{}", extension.sql_name, native_module.name)
                    },
                    kind: "extension".to_owned(),
                    path,
                    aot_file: format!("{}-llvm-opta.bin.zst", native_module.name.replace('/', "_")),
                    requires_aot: true,
                });
            }
        }

        Ok(Self {
            source_lane: canonical_source_lane.to_owned(),
            source_fingerprint: manifest.source_fingerprint.clone(),
            postgres_version: manifest.runtime.postgres_version.clone(),
            build_dir: base.clone(),
            source_dir: base.clone(),
            package_stage: base,
            modules,
        })
    }

    fn ensure_required_files(&self) -> Result<()> {
        for module in &self.modules {
            ensure_file(&module.path)?;
        }
        self.ensure_build_source_markers()?;
        ensure_file(&self.build_dir.join("src/timezone/compiled/UTC"))?;
        ensure_file(
            &self
                .build_dir
                .join("src/backend/snowball/snowball_create.sql"),
        )?;
        Ok(())
    }

    fn ensure_build_source_markers(&self) -> Result<()> {
        match self.source_lane.as_str() {
            "stable" => {
                let source_fingerprint = self
                    .source_fingerprint
                    .as_deref()
                    .ok_or_else(|| anyhow!("PG18 build outputs are missing source fingerprint"))?;
                ensure_matching_marker(
                    source_fingerprint,
                    &self.build_dir.join(".oliphaunt-wasix-source-fingerprint"),
                    "PG18 build source fingerprint",
                )?;
                ensure_matching_marker(
                    &self.postgres_version,
                    &self.build_dir.join(".oliphaunt-wasix-postgres-version"),
                    "PG18 build PostgreSQL version marker",
                )?;
            }
            other => bail!("unsupported WASIX asset source lane {other:?}"),
        }
        Ok(())
    }

    fn module_path(&self, name: &str) -> Result<&Path> {
        self.modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| module.path.as_path())
            .ok_or_else(|| anyhow!("missing build output module {name}"))
    }

    fn manifest_path(&self) -> Result<&'static Path> {
        build_output_manifest_path_for_source_lane(&self.source_lane)
    }

    fn write_manifest(&self) -> Result<()> {
        let manifest = BuildOutputManifestOut {
            format_version: 1,
            source_lane: Some(self.source_lane.clone()),
            source_fingerprint: self.source_fingerprint.clone(),
            postgres_version: Some(self.postgres_version.clone()),
            build_profile: fs::read_to_string(
                self.build_dir.join(".oliphaunt-wasix-build-profile"),
            )
            .context("read WASIX build profile signature")?,
            modules: self
                .modules
                .iter()
                .map(|module| {
                    Ok(BuildModuleManifestOut {
                        name: module.name.clone(),
                        kind: module.kind.clone(),
                        path: module.path.to_string_lossy().into_owned(),
                        sha256: sha256_file(&module.path)?,
                        link: read_wasm_link_metadata(&module.path)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        };
        for module in &manifest.modules {
            validate_module_link_metadata(module)?;
        }
        ensure_build_output_manifest_matches_source_lane(&manifest, &self.source_lane)?;
        let text = serde_json::to_string_pretty(&manifest)
            .context("serialize WASIX build output manifest")?;
        let path = self.manifest_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
    }
}

fn extension_build_module_path(
    build_dir: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
) -> Result<PathBuf> {
    let module_file = extension
        .module_file
        .as_deref()
        .ok_or_else(|| anyhow!("extension {} has no native module", extension.sql_name))?;
    match extension.build_kind.as_str() {
        "postgres-contrib" => {
            let contrib_dir = extension
                .contrib_dir
                .as_deref()
                .ok_or_else(|| anyhow!("contrib extension {} has no contrib_dir", extension.id))?;
            Ok(build_dir
                .join("contrib")
                .join(contrib_dir)
                .join(module_file))
        }
        kind if extension_catalog::is_pgxs_style_build_kind(kind) => {
            Ok(pgxs_extension_build_dir(build_dir, extension).join(module_file))
        }
        kind if extension_catalog::is_recipe_staged_build_kind(kind) => {
            let staging = extension
                .staging
                .as_ref()
                .ok_or_else(|| anyhow!("extension {} has no staging metadata", extension.id))?;
            let module_source_dir = staging.module_source_dir.as_deref().ok_or_else(|| {
                anyhow!(
                    "extension {} staging metadata has no module_source_dir",
                    extension.id
                )
            })?;
            Ok(build_dir.join(module_source_dir).join(module_file))
        }
        other => bail!(
            "promoted extension {} has unsupported build kind {other}",
            extension.sql_name
        ),
    }
}

fn pgxs_extension_build_dir(
    build_dir: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
) -> PathBuf {
    build_dir.join("pgxs").join(&extension.id)
}

fn extension_aot_file_stem(extension: &extension_catalog::PromotedExtensionBuildSpec) -> String {
    extension.sql_name.replace('/', "_")
}

fn validate_build_profile_outputs(outputs: &BuildOutputs, profile: &str) -> Result<()> {
    let signature_path = outputs.build_dir.join(".oliphaunt-wasix-build-profile");
    let signature = fs::read_to_string(&signature_path)
        .with_context(|| format!("read {}", signature_path.display()))?;
    let profile_line = format!("profile={profile}");
    if !signature.lines().any(|line| line == profile_line) {
        bail!(
            "WASIX build profile signature does not match requested profile {profile}: {}",
            signature_path.display()
        );
    }

    if profile.starts_with("release") {
        let cflags = signature
            .lines()
            .find_map(|line| line.strip_prefix("cflags="))
            .unwrap_or_default();
        let has_release_opt = ["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| cflags.split_whitespace().any(|part| part == *flag));
        if !has_release_opt || !cflags.split_whitespace().any(|part| part == "-g0") {
            bail!(
                "release WASIX profile must include an optimizing -O flag and -g0; got cflags={cflags:?}"
            );
        }

        let makefile = outputs.build_dir.join("src/Makefile.global");
        let makefile_text = fs::read_to_string(&makefile)
            .with_context(|| format!("read {}", makefile.display()))?;
        if !["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| makefile_text.contains(flag))
        {
            bail!(
                "release WASIX build did not propagate optimization flags into {}",
                makefile.display()
            );
        }
    }

    Ok(())
}

fn validate_module_link_metadata(module: &BuildModuleManifestOut) -> Result<()> {
    if module.link.exports.is_empty() {
        bail!("{} has no WASM exports", module.name);
    }

    match module.kind.as_str() {
        "runtime" => {
            let missing = required_runtime_abi_exports()
                .iter()
                .copied()
                .filter(|export| !has_wasm_export(&module.link, export))
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                bail!(
                    "{} is missing required Rust/WASIX ABI exports: {}",
                    module.name,
                    missing.join(", ")
                );
            }
            for banned in [
                "oliphaunt_wasix_initdb",
                "oliphaunt_wasix_backend",
                "PostgresRecoverProtocolError",
            ] {
                if has_wasm_export(&module.link, banned) {
                    bail!(
                        "{} exports legacy builder-branch lifecycle entrypoint {banned}",
                        module.name
                    );
                }
            }
        }
        "runtime-support" | "extension" => {
            if !module.link.has_dylink0 {
                bail!("{} is not a WASM dynamic-linking side module", module.name);
            }
            if module.link.imports.is_empty() && module.link.dylink_imports.is_empty() {
                bail!(
                    "{} has no imports; side-module linkage is suspicious",
                    module.name
                );
            }
        }
        "tool" => {}
        other => bail!("{} has unknown build output kind {other}", module.name),
    }

    Ok(())
}

fn validate_build_output_link_closure(outputs: &BuildOutputs) -> Result<()> {
    let runtime = outputs
        .modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_link = read_wasm_link_metadata(&runtime.path)?;
    let runtime_exports = runtime_link
        .exports
        .iter()
        .flat_map(|export| {
            let name = export.name.trim_start_matches('_').to_owned();
            [export.name.clone(), name]
        })
        .collect::<HashSet<_>>();

    let side_modules = outputs
        .modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
        .collect::<Vec<_>>();
    let side_module_links = side_modules
        .iter()
        .map(|module| {
            Ok::<_, anyhow::Error>((module.name.clone(), read_wasm_link_metadata(&module.path)?))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let side_module_exports = side_module_links
        .iter()
        .map(|(name, link)| (name.clone(), wasm_export_name_set(link)))
        .collect::<BTreeMap<_, _>>();

    let mut failures = Vec::new();
    for module in side_modules {
        let link = side_module_links
            .get(&module.name)
            .ok_or_else(|| anyhow!("missing link metadata for {}", module.name))?;
        let provider_exports = side_module_provider_exports(&module.name, &side_module_exports);
        for import in &link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            if import_resolves_from_linked_module_exports(import, &provider_exports) {
                continue;
            }
            let normalized = import.name.trim_start_matches('_');
            if !runtime_exports.contains(import.name.as_str())
                && !runtime_exports.contains(normalized)
            {
                failures.push(format!(
                    "{} imports {}.{}",
                    module.name, import.module, import.name
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!(
            "WASIX dynamic-link closure has unresolved side-module imports: {}",
            failures.join(", ")
        );
    }
    Ok(())
}

fn side_module_provider_exports(
    module_name: &str,
    exports_by_name: &BTreeMap<String, HashSet<String>>,
) -> HashSet<String> {
    let mut exports = exports_by_name
        .get(module_name)
        .cloned()
        .unwrap_or_default();
    if let Some(sql_name) = extension_module_sql_name(module_name) {
        let support_prefix = format!("extension:{sql_name}:");
        for (name, module_exports) in exports_by_name {
            if name.starts_with(&support_prefix) {
                exports.extend(module_exports.iter().cloned());
            }
        }
    }
    exports
}

fn extension_module_sql_name(module_name: &str) -> Option<&str> {
    module_name
        .strip_prefix("extension:")
        .and_then(|rest| rest.split(':').next())
        .filter(|sql_name| !sql_name.is_empty())
}

pub(crate) fn generate_wasix_export_list(write: bool, source_lane: &str) -> Result<()> {
    let output = wasix_export_list_text(source_lane)?;
    if write {
        let path = Path::new("src/runtimes/liboliphaunt/wasix/assets/generated/wasix-dl.exports");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, output).with_context(|| format!("write {}", path.display()))?;
    } else {
        print!("{output}");
    }
    Ok(())
}

pub(crate) fn check_generated_wasix_export_list(strict: bool) -> Result<()> {
    let expected = match wasix_export_list_text(DEFAULT_SOURCE_LANE) {
        Ok(expected) => expected,
        Err(err) if !strict => {
            eprintln!("warning: skipping generated WASIX export-list check: {err:#}");
            return Ok(());
        }
        Err(err) => return Err(err).context("generate expected WASIX export list"),
    };
    let path = Path::new("src/runtimes/liboliphaunt/wasix/assets/generated/wasix-dl.exports");
    if !path.exists() {
        if strict {
            bail!(
                "generated WASIX export list is missing at {}; run `cargo run -p xtask -- assets export-list --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated WASIX export list is missing at {}",
            path.display()
        );
        return Ok(());
    }
    let actual = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if actual != expected {
        if strict {
            bail!(
                "generated WASIX export list is stale at {}; run `cargo run -p xtask -- assets export-list --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated WASIX export list is stale at {}",
            path.display()
        );
    }
    Ok(())
}

pub(crate) fn check_source_controlled_wasix_export_list() -> Result<()> {
    let path = Path::new("src/runtimes/liboliphaunt/wasix/assets/generated/wasix-dl.exports");
    ensure_file(path)?;
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        !text.trim().is_empty(),
        "{} must not be empty",
        path.display()
    );
    for symbol in [
        "ProcessStartupPacket",
        "PostgresMainLoopOnce",
        "PostgresMainLongJmp",
        "PostgresSendReadyForQueryIfNecessary",
        "oliphaunt_wasix_get_proc_port",
        "oliphaunt_wasix_pq_flush",
        "oliphaunt_wasix_send_conn_data",
        "oliphaunt_wasix_set_active",
        "oliphaunt_wasix_set_force_host_error_recovery",
        "oliphaunt_wasix_protocol_stream_active",
        "oliphaunt_wasix_start",
        "oliphaunt_wasix_set_protocol_transport",
        "oliphaunt_wasix_input_write",
        "oliphaunt_wasix_output_read",
        "malloc",
        "free",
    ] {
        ensure!(
            text.lines().any(|line| line == symbol),
            "{} is missing required runtime/protocol export symbol {symbol}",
            path.display()
        );
    }
    let mut previous: Option<&str> = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(previous) = previous {
            ensure!(
                previous <= line,
                "{} must stay sorted for deterministic reviews; {previous} appears before {line}",
                path.display()
            );
        }
        previous = Some(line);
    }
    println!("source-controlled WASIX export-list guard passed");
    Ok(())
}

fn wasix_export_list_text(source_lane: &str) -> Result<String> {
    for manifest_path in build_output_manifest_paths_for_source_lane(source_lane)? {
        if !manifest_path.exists() {
            continue;
        }
        let manifest = read_build_output_manifest(manifest_path)?;
        match ensure_build_output_manifest_matches_source_lane(&manifest, source_lane) {
            Ok(()) => return wasix_export_list_from_modules(&manifest.modules),
            Err(err) => {
                eprintln!(
                    "warning: ignoring WASIX build output manifest {} while generating export list for {source_lane}: {err:#}",
                    manifest_path.display()
                );
            }
        }
    }
    let asset_dir = generated_assets_dir_for_source_lane(source_lane)?;
    if asset_dir.join("manifest.json").exists() {
        let manifest = read_asset_manifest_for_source_lane(source_lane)?;
        if ensure_packaged_asset_matches_source_lane(&manifest, source_lane).is_ok() {
            let modules = build_output_modules_from_asset_manifest(&manifest);
            return wasix_export_list_from_modules(&modules);
        }
        eprintln!(
            "warning: ignoring generated asset manifest for PostgreSQL {} while generating export list for {source_lane}",
            manifest.runtime.postgres_version
        );
    }

    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    let modules = outputs
        .modules
        .iter()
        .map(|module| {
            Ok(BuildModuleManifestOut {
                name: module.name.clone(),
                kind: module.kind.clone(),
                path: module.path.to_string_lossy().into_owned(),
                sha256: String::new(),
                link: read_wasm_link_metadata(&module.path)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    wasix_export_list_from_modules(&modules)
}

fn read_build_output_manifest(path: &Path) -> Result<BuildOutputManifestOut> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

pub(crate) fn read_asset_manifest_for_source_lane(source_lane: &str) -> Result<AssetManifestOut> {
    read_asset_manifest_from(generated_assets_dir_for_source_lane(source_lane)?)
}

pub(crate) fn read_asset_manifest_from(asset_dir: &Path) -> Result<AssetManifestOut> {
    let path = asset_dir.join("manifest.json");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn build_output_modules_from_asset_manifest(
    manifest: &AssetManifestOut,
) -> Vec<BuildModuleManifestOut> {
    let mut modules = vec![BuildModuleManifestOut {
        name: "runtime:oliphaunt".to_owned(),
        kind: "runtime".to_owned(),
        path: manifest.runtime.archive.clone(),
        sha256: manifest.runtime.module_sha256.clone(),
        link: manifest.runtime.link.clone(),
    }];

    modules.extend(
        manifest
            .runtime_support
            .iter()
            .map(|module| BuildModuleManifestOut {
                name: format!("runtime-support:{}", module.name),
                kind: "runtime-support".to_owned(),
                path: module.path.clone(),
                sha256: module.module_sha256.clone(),
                link: module.link.clone(),
            }),
    );

    if let Some(pg_dump) = &manifest.pg_dump {
        modules.push(BuildModuleManifestOut {
            name: "tool:pg_dump".to_owned(),
            kind: "tool".to_owned(),
            path: pg_dump.path.clone(),
            sha256: pg_dump.module_sha256.clone(),
            link: pg_dump.link.clone(),
        });
    }
    if let Some(psql) = &manifest.psql {
        modules.push(BuildModuleManifestOut {
            name: "tool:psql".to_owned(),
            kind: "tool".to_owned(),
            path: psql.path.clone(),
            sha256: psql.module_sha256.clone(),
            link: psql.link.clone(),
        });
    }
    if let Some(initdb) = &manifest.initdb {
        modules.push(BuildModuleManifestOut {
            name: "tool:initdb".to_owned(),
            kind: "tool".to_owned(),
            path: initdb.path.clone(),
            sha256: initdb.module_sha256.clone(),
            link: initdb.link.clone(),
        });
    }

    for extension in &manifest.extensions {
        for native_module in &extension.native_modules {
            modules.push(BuildModuleManifestOut {
                name: if native_module.name == extension.sql_name {
                    format!("extension:{}", extension.sql_name)
                } else {
                    format!("extension:{}:{}", extension.sql_name, native_module.name)
                },
                kind: "extension".to_owned(),
                path: native_module.path.clone(),
                sha256: native_module.module_sha256.clone(),
                link: native_module.link.clone(),
            });
        }
        let has_primary_native_module = extension
            .native_modules
            .iter()
            .any(|module| module.name == extension.sql_name);
        if !has_primary_native_module && let Some(link) = extension.link.clone() {
            modules.push(BuildModuleManifestOut {
                name: format!("extension:{}", extension.sql_name),
                kind: "extension".to_owned(),
                path: extension.archive.clone(),
                sha256: extension.module_sha256.clone(),
                link,
            });
        }
    }

    modules
}

fn wasix_export_list_from_modules(modules: &[BuildModuleManifestOut]) -> Result<String> {
    for module in modules {
        validate_module_link_metadata(module)?;
    }

    let runtime = modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_exports = wasm_export_name_set(&runtime.link);
    let side_module_exports = modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
        .map(|module| (module.name.clone(), wasm_export_name_set(&module.link)))
        .collect::<BTreeMap<_, _>>();
    let mut required_exports = BTreeSet::<String>::new();
    let mut unresolved = Vec::new();

    for abi_export in required_runtime_abi_exports().iter().copied() {
        let normalized = abi_export.trim_start_matches('_');
        if runtime_exports.contains(abi_export) {
            required_exports.insert(abi_export.to_owned());
        } else if runtime_exports.contains(normalized) {
            required_exports.insert(normalized.to_owned());
        } else {
            unresolved.push(format!("runtime ABI export {abi_export}"));
        }
    }

    for module in modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
    {
        let module_exports = side_module_provider_exports(&module.name, &side_module_exports);
        for import in &module.link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            if import_resolves_from_linked_module_exports(import, &module_exports) {
                continue;
            }
            let normalized = import.name.trim_start_matches('_');
            if runtime_exports.contains(import.name.as_str()) {
                required_exports.insert(import.name.clone());
            } else if runtime_exports.contains(normalized) {
                required_exports.insert(normalized.to_owned());
            } else {
                unresolved.push(format!(
                    "{} imports {}.{}",
                    module.name, import.module, import.name
                ));
            }
        }
    }

    if !unresolved.is_empty() {
        bail!(
            "cannot generate WASIX dynamic-link export list with unresolved imports: {}",
            unresolved.join(", ")
        );
    }

    Ok(required_exports.into_iter().collect::<Vec<_>>().join("\n") + "\n")
}

pub(crate) fn required_runtime_abi_exports() -> &'static [&'static str] {
    &[
        "_start",
        "oliphaunt_wasix_set_active",
        "oliphaunt_wasix_start",
        "oliphaunt_wasix_get_proc_port",
        "ProcessStartupPacket",
        "oliphaunt_wasix_send_conn_data",
        "oliphaunt_wasix_pq_flush",
        "pq_buffer_remaining_data",
        "PostgresMainLoopOnce",
        "PostgresSendReadyForQueryIfNecessary",
        "PostgresMainLongJmp",
        "oliphaunt_wasix_set_protocol_stdio",
        "oliphaunt_wasix_set_force_host_error_recovery",
        "oliphaunt_wasix_protocol_stream_active",
        "oliphaunt_wasix_input_reset",
        "oliphaunt_wasix_input_write",
        "oliphaunt_wasix_input_available",
        "oliphaunt_wasix_output_reset",
        "oliphaunt_wasix_output_len",
        "oliphaunt_wasix_output_read",
        "oliphaunt_wasix_set_protocol_transport",
    ]
}

fn import_should_resolve_from_runtime(import: &WasmImportOut) -> bool {
    if import_is_wasix_linker_provided(import) {
        return false;
    }
    matches!(import.module.as_str(), "env" | "GOT.func" | "GOT.mem")
}

fn import_is_wasix_linker_provided(import: &WasmImportOut) -> bool {
    matches!(
        (import.module.as_str(), import.name.as_str()),
        (
            "env",
            "__c_longjmp"
                | "__cpp_exception"
                | "__indirect_function_table"
                | "__memory_base"
                | "__stack_pointer"
                | "__table_base"
                | "memory",
        ) | ("GOT.mem", "__heap_base" | "__stack_high" | "__stack_low")
    )
}

fn import_resolves_from_linked_module_exports(
    import: &WasmImportOut,
    module_exports: &HashSet<String>,
) -> bool {
    module_exports.contains(import.name.as_str())
        || module_exports.contains(import.name.trim_start_matches('_'))
}

fn extension_asset_provider_exports(
    primary_link: &WasmLinkMetadataOut,
    sql_name: &str,
    native_module_links: &BTreeMap<String, WasmLinkMetadataOut>,
) -> HashSet<String> {
    let mut exports = wasm_export_name_set(primary_link);
    for (name, link) in native_module_links {
        if name == sql_name {
            continue;
        }
        exports.extend(wasm_export_name_set(link));
    }
    exports
}

fn wasm_export_name_set(link: &WasmLinkMetadataOut) -> HashSet<String> {
    link.exports
        .iter()
        .flat_map(|export| {
            let normalized = export.name.trim_start_matches('_').to_owned();
            [export.name.clone(), normalized]
        })
        .collect()
}

fn has_wasm_export(link: &WasmLinkMetadataOut, name: &str) -> bool {
    link.exports
        .iter()
        .any(|export| export.name == name || export.name == format!("_{name}"))
}

pub(crate) fn build_asset_spine(
    _manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    let execute = args.iter().any(|arg| arg == "--execute")
        || env::var("OLIPHAUNT_WASM_EXECUTE_ASSET_BUILD").as_deref() == Ok("1");
    let source_lane =
        canonical_source_lane(value_after(args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE))?;
    let backend_script = match source_lane {
        "stable" => "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        other => bail!("unsupported WASIX asset source lane {other:?}"),
    };

    println!("asset build inputs validated");
    println!("profile={profile}");
    println!("target-triple={target}");

    let commands = asset_build_commands(backend_script)?;

    if !execute {
        println!("source-spine build is ready but not executed by default");
        println!("run with --execute or OLIPHAUNT_WASM_EXECUTE_ASSET_BUILD=1 to invoke:");
        for command in &commands {
            println!("  {}", command.script);
        }
        println!("follow with `assets package` and `assets aot` to refresh publishable artifacts");
        return Ok(());
    }

    for command_spec in commands {
        if skip_extensions_for_perf_probe() && command_spec.skip_for_core_probe {
            println!("skipping {} for core-only perf probe", command_spec.script);
            continue;
        }
        let mut command = Command::new("bash");
        command
            .arg(&command_spec.script)
            .env("OLIPHAUNT_WASM_BUILD_PROFILE", profile);
        run_command(&mut command)?;
    }

    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    println!(
        "wrote WASIX build output manifest to {}",
        outputs.manifest_path()?.display()
    );
    Ok(())
}

struct AssetBuildCommand {
    script: String,
    skip_for_core_probe: bool,
}

fn asset_build_commands(backend_script: &str) -> Result<Vec<AssetBuildCommand>> {
    let mut commands = vec![
        AssetBuildCommand {
            script: backend_script.to_owned(),
            skip_for_core_probe: false,
        },
        AssetBuildCommand {
            script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh"
                .to_owned(),
            skip_for_core_probe: false,
        },
        AssetBuildCommand {
            script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh".to_owned(),
            skip_for_core_probe: false,
        },
        AssetBuildCommand {
            script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh"
                .to_owned(),
            skip_for_core_probe: true,
        },
        AssetBuildCommand {
            script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh"
                .to_owned(),
            skip_for_core_probe: true,
        },
    ];
    for extension in extension_catalog::promoted_build_specs()? {
        if !extension_catalog::is_recipe_staged_build_kind(&extension.build_kind) {
            continue;
        }
        let script = extension.build_script.clone().ok_or_else(|| {
            anyhow!(
                "recipe-staged extension {} has no WASIX build script",
                extension.sql_name
            )
        })?;
        commands.push(AssetBuildCommand {
            script,
            skip_for_core_probe: true,
        });
    }
    commands.push(AssetBuildCommand {
        script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh".to_owned(),
        skip_for_core_probe: true,
    });
    commands.push(AssetBuildCommand {
        script: "src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh".to_owned(),
        skip_for_core_probe: true,
    });
    Ok(commands)
}

pub(crate) fn release_build_assets(
    manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    let source_lane = value_after(args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
    let mut build_args = vec![
        "build".to_owned(),
        "--profile".to_owned(),
        profile.to_owned(),
        "--target-triple".to_owned(),
        target.to_owned(),
        "--execute".to_owned(),
    ];
    build_args.extend(
        args.iter()
            .filter(|arg| {
                matches!(
                    arg.as_str(),
                    "--skip-build" | "--skip-aot" | "--skip-package-size"
                )
            })
            .cloned(),
    );

    if !args.iter().any(|arg| arg == "--skip-build") {
        build_asset_spine(manifest, profile, target, &build_args)?;
    } else {
        eprintln!("warning: skipping WASIX rebuild by request");
    }

    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;

    let skip_aot = args.iter().any(|arg| arg == "--skip-aot");
    package_assets_with_options(manifest, target, false, source_lane)?;
    let asset_dir = generated_assets_dir_for_source_lane(source_lane)?;
    check_canonical_asset_layout_in(asset_dir, true)?;
    let expected_sources = effective_source_pins(manifest, &outputs)?;
    check_generated_manifest_sources_in(asset_dir, &expected_sources, source_lane, true)?;

    if !skip_aot {
        generate_aot_artifacts(target, source_lane)?;
        package_aot_artifacts(target, &outputs, manifest)?;
        check_aot_package_manifest(target, source_lane)?;
    } else {
        eprintln!("warning: skipping AOT generation by request");
    }

    if !args.iter().any(|arg| arg == "--skip-package-size") {
        enforce_package_size_for_source_lane(source_lane)?;
    }

    Ok(())
}

pub(crate) fn generate_aot_artifacts(target: &str, source_lane: &str) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot(source_lane)?;
    let source_dir = generated_aot_source_dir_for_source_lane(target, &outputs.source_lane)?;
    if source_dir.exists() {
        fs::remove_dir_all(&source_dir)
            .with_context(|| format!("remove {}", source_dir.display()))?;
    }
    fs::create_dir_all(&source_dir).with_context(|| format!("create {}", source_dir.display()))?;
    let serializer = ensure_aot_serializer_binary()?;

    for module in outputs.modules.iter().filter(|module| module.requires_aot) {
        let output = source_dir.join(&module.aot_file);
        generate_one_aot_artifact(&serializer, &module.path, &output)?;
    }
    Ok(())
}

fn is_core_aot_module(name: &str) -> bool {
    !name.starts_with("extension:")
}

pub(crate) fn package_aot_only(
    manifest: &SourcesManifest,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot(source_lane)?;
    package_aot_artifacts(target, &outputs, manifest)?;
    check_aot_package_manifest(target, source_lane)
}

fn ensure_aot_serializer_binary() -> Result<PathBuf> {
    let mut command = Command::new("cargo");
    command
        .args([
            "build",
            "-p",
            "xtask",
            "--release",
            "--locked",
            "--features",
            "aot-serializer",
        ])
        .env("CARGO_INCREMENTAL", "0");
    if env::var_os("LLVM_SYS_221_PREFIX").is_none() && Path::new("/opt/homebrew/opt/llvm").exists()
    {
        command.env("LLVM_SYS_221_PREFIX", "/opt/homebrew/opt/llvm");
    }
    configure_windows_llvm_aot_link(&mut command);
    run_command(&mut command).context("build maintainer AOT serializer")?;

    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    let target_dir = if target_dir.is_absolute() {
        target_dir
    } else {
        env::current_dir()
            .context("read current directory")?
            .join(target_dir)
    };
    let serializer = target_dir
        .join("release")
        .join(format!("xtask{}", env::consts::EXE_SUFFIX));
    ensure_file(&serializer)?;
    Ok(serializer)
}

fn generate_one_aot_artifact(serializer: &Path, input: &Path, output: &Path) -> Result<()> {
    ensure_file(input)?;
    let input =
        fs::canonicalize(input).with_context(|| format!("canonicalize {}", input.display()))?;
    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        env::current_dir()
            .context("read current directory")?
            .join(output)
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut command = Command::new(serializer);
    command
        .args(["aot-serializer", "serialize", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(output)
        .env("CARGO_INCREMENTAL", "0");
    if env::var_os("LLVM_SYS_221_PREFIX").is_none() && Path::new("/opt/homebrew/opt/llvm").exists()
    {
        command.env("LLVM_SYS_221_PREFIX", "/opt/homebrew/opt/llvm");
    }
    configure_windows_llvm_aot_link(&mut command);
    run_command(&mut command)
        .with_context(|| format!("generate AOT artifact for {}", input.display()))
}

fn configure_windows_llvm_aot_link(command: &mut Command) {
    if !cfg!(windows) {
        return;
    }

    let Some(prefix) = env::var_os("LLVM_SYS_221_PREFIX").or_else(|| env::var_os("LLVM_PATH"))
    else {
        return;
    };
    let llvm_lib = PathBuf::from(prefix).join("lib");
    if llvm_lib.is_dir() {
        let mut lib = llvm_lib.display().to_string();
        if let Some(existing) = env::var_os("LIB").and_then(|value| value.into_string().ok())
            && !existing.is_empty()
        {
            lib.push(';');
            lib.push_str(&existing);
        }
        command.env("LIB", lib);
    }
}

pub(crate) fn package_assets(
    manifest: &SourcesManifest,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    package_assets_with_options(manifest, target, true, source_lane)
}

pub(crate) fn package_assets_without_aot(
    manifest: &SourcesManifest,
    source_lane: &str,
) -> Result<()> {
    package_assets_with_options(manifest, host_target_triple(), false, source_lane)
}

fn package_assets_with_options(
    manifest: &SourcesManifest,
    target: &str,
    include_aot: bool,
    source_lane: &str,
) -> Result<()> {
    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    let build = &outputs.build_dir;
    let source = &outputs.source_dir;
    let stage = &outputs.package_stage;

    if stage.exists() {
        fs::remove_dir_all(stage).with_context(|| format!("remove {}", stage.display()))?;
    }
    fs::create_dir_all(stage).with_context(|| format!("create {}", stage.display()))?;

    let runtime_stage = stage.join("runtime/oliphaunt");
    stage_runtime_tree(build, source, &runtime_stage)?;
    let assets_dir = generated_assets_dir_for_source_lane(source_lane)?;
    if assets_dir.exists() {
        fs::remove_dir_all(assets_dir)
            .with_context(|| format!("remove {}", assets_dir.display()))?;
    }
    fs::create_dir_all(assets_dir).with_context(|| format!("create {}", assets_dir.display()))?;
    if skip_extensions_for_perf_probe() {
        fs::create_dir_all(assets_dir.join("extensions"))
            .with_context(|| format!("create {}", assets_dir.join("extensions").display()))?;
    }

    let runtime_archive = assets_dir.join("oliphaunt.wasix.tar.zst");
    deterministic_tar_zst(&runtime_stage, Path::new("oliphaunt"), &runtime_archive)?;

    let pg_dump = if skip_extensions_for_perf_probe() {
        None
    } else {
        let pg_dump = assets_dir.join("bin/pg_dump.wasix.wasm");
        copy_file(outputs.module_path("tool:pg_dump")?, &pg_dump)?;
        Some(pg_dump)
    };
    let psql = if skip_extensions_for_perf_probe() {
        None
    } else {
        let psql = assets_dir.join("bin/psql.wasix.wasm");
        copy_file(outputs.module_path("tool:psql")?, &psql)?;
        Some(psql)
    };
    let initdb = assets_dir.join("bin/initdb.wasix.wasm");
    copy_file(outputs.module_path("tool:initdb")?, &initdb)?;

    let extension_artifacts =
        build_promoted_extension_artifacts(source, build, stage, assets_dir, &outputs)?;
    let extension_artifact_refs = extension_artifacts
        .iter()
        .map(|extension| ExtensionArtifact {
            name: extension.name.as_str(),
            sql_name: extension.sql_name.as_str(),
            archive: extension.archive.as_str(),
            path: extension.path.as_path(),
            module_path: extension.module_path.as_deref(),
            native_module: extension.native_module.as_deref(),
            native_modules: &extension.native_modules,
            stable: extension.stable,
        })
        .collect::<Vec<_>>();

    if include_aot {
        package_aot_artifacts(target, &outputs, manifest)?;
    }
    generate_pgdata_template_from_runtime_stage(manifest, &outputs, &runtime_stage, assets_dir)?;
    write_asset_manifest(
        manifest,
        &outputs,
        assets_dir,
        outputs.module_path("runtime:oliphaunt")?,
        &runtime_archive,
        pg_dump.as_deref(),
        psql.as_deref(),
        &initdb,
        &[
            BinaryPackage {
                name: "plpgsql",
                path: outputs.module_path("runtime-support:plpgsql")?,
                runtime_path: "lib/postgresql/plpgsql.so",
            },
            BinaryPackage {
                name: "dict_snowball",
                path: outputs.module_path("runtime-support:dict_snowball")?,
                runtime_path: "lib/postgresql/dict_snowball.so",
            },
        ],
        &extension_artifact_refs,
    )?;

    println!("packaged runtime assets into {}", assets_dir.display());
    if include_aot {
        println!("packaged {target} AOT artifacts");
    } else {
        println!("skipped {target} AOT artifact packaging by request");
    }
    Ok(())
}

pub(crate) fn generate_pgdata_template_asset(
    manifest: &SourcesManifest,
    source_lane: &str,
) -> Result<()> {
    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    let stage_root = outputs.package_stage.join("template-runtime");
    if stage_root.exists() {
        fs::remove_dir_all(&stage_root)
            .with_context(|| format!("remove {}", stage_root.display()))?;
    }
    stage_runtime_tree(&outputs.build_dir, &outputs.source_dir, &stage_root)?;
    generate_pgdata_template_from_runtime_stage(
        manifest,
        &outputs,
        &stage_root,
        generated_assets_dir_for_source_lane(source_lane)?,
    )
}

fn generate_pgdata_template_from_runtime_stage(
    manifest: &SourcesManifest,
    outputs: &BuildOutputs,
    runtime_stage: &Path,
    assets_dir: &Path,
) -> Result<()> {
    let output_dir = assets_dir.join("prepopulated");
    if output_dir.exists() {
        fs::remove_dir_all(&output_dir)
            .with_context(|| format!("remove {}", output_dir.display()))?;
    }
    fs::create_dir_all(&output_dir).with_context(|| format!("create {}", output_dir.display()))?;

    let work_root = assets_dir.join("template-work");
    if work_root.exists() {
        fs::remove_dir_all(&work_root)
            .with_context(|| format!("remove {}", work_root.display()))?;
    }
    fs::create_dir_all(&work_root).with_context(|| format!("create {}", work_root.display()))?;

    template_runner::run_wasix_initdb_template(runtime_stage, &work_root)?;

    let pgdata = work_root.join("pgdata");
    ensure!(
        pgdata.join("PG_VERSION").is_file() && pgdata.join("global/pg_control").is_file(),
        "WASIX initdb did not create a complete PGDATA template at {}",
        pgdata.display()
    );
    template_runner::clean_generated_pgdata_template(&pgdata)?;

    let archive = output_dir.join("pgdata-template.tar.zst");
    deterministic_tar_zst(&pgdata, Path::new(""), &archive)?;
    let manifest_path = output_dir.join("pgdata-template.json");
    let source_pins = effective_source_pins(manifest, outputs)?;
    let mut manifest_json = serde_json::json!({
        "architectureIndependent": true,
        "archiveSha256": sha256_file(&archive)?,
        "catalogVersion": postgres_catalog_version(&outputs.source_dir)?,
        "generatedBy": "wasix-initdb",
        "initProfile": template_runner::default_initdb_profile(),
        "initdbSha256": sha256_file(outputs.module_path("tool:initdb")?)?,
        "postgresVersion": postgres_major_version(&outputs.postgres_version),
        "sourceLane": outputs.source_lane.as_str(),
        "sourcePinsSha256": source_pins_sha256(&source_pins)?,
        "wasmerVersion": manifest.toolchain.wasmer,
        "wasmSha256": sha256_file(outputs.module_path("runtime:oliphaunt")?)?,
    });
    if let Some(source_fingerprint) = &outputs.source_fingerprint {
        manifest_json["sourceFingerprint"] = serde_json::json!(source_fingerprint);
    }
    fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest_json)?),
    )
    .with_context(|| format!("write {}", manifest_path.display()))?;
    fs::remove_dir_all(&work_root).with_context(|| format!("remove {}", work_root.display()))?;
    Ok(())
}

fn build_promoted_extension_artifacts(
    source: &Path,
    build: &Path,
    stage: &Path,
    assets_dir: &Path,
    outputs: &BuildOutputs,
) -> Result<Vec<OwnedExtensionArtifact>> {
    if skip_extensions_for_perf_probe() {
        return Ok(Vec::new());
    }

    let mut packages = Vec::new();
    for extension in extension_catalog::promoted_build_specs()? {
        let extension_stage = stage.join("extensions").join(&extension.sql_name);
        stage_promoted_extension(source, build, &extension, &extension_stage)?;
        let archive_path = assets_dir.join(&extension.archive);
        deterministic_tar_zst(&extension_stage, Path::new(""), &archive_path)?;
        let native_modules = extension_native_module_artifacts(&extension, outputs)?;
        packages.push(OwnedExtensionArtifact {
            name: extension.display_name,
            sql_name: extension.sql_name.clone(),
            archive: extension.archive.clone(),
            path: archive_path,
            module_path: if extension.module_file.is_some() {
                Some(
                    outputs
                        .module_path(&format!("extension:{}", extension.sql_name))?
                        .to_path_buf(),
                )
            } else {
                None
            },
            native_module: extension.module_file.clone(),
            native_modules,
            stable: extension.stable,
        });
    }
    Ok(packages)
}

fn extension_native_module_artifacts(
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    outputs: &BuildOutputs,
) -> Result<Vec<OwnedExtensionNativeModule>> {
    let mut modules = Vec::new();
    for support_module in &extension.native_support_modules {
        modules.push(OwnedExtensionNativeModule {
            name: support_module.name.clone(),
            runtime_path: support_module.runtime_path.clone(),
            path: outputs
                .module_path(&format!(
                    "extension:{}:{}",
                    extension.sql_name, support_module.name
                ))?
                .to_path_buf(),
        });
    }
    if let Some(module_file) = &extension.module_file {
        modules.push(OwnedExtensionNativeModule {
            name: extension.sql_name.clone(),
            runtime_path: format!("lib/postgresql/{module_file}"),
            path: outputs
                .module_path(&format!("extension:{}", extension.sql_name))?
                .to_path_buf(),
        });
    }
    Ok(modules)
}

fn stage_promoted_extension(
    source: &Path,
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    match extension.build_kind.as_str() {
        "postgres-contrib" => stage_contrib_extension(source, build, extension, stage),
        kind if extension_catalog::is_pgxs_style_build_kind(kind) => {
            stage_pgxs_style_extension(build, extension, stage)
        }
        kind if extension_catalog::is_recipe_staged_build_kind(kind) => {
            stage_recipe_staged_extension(build, extension, stage)
        }
        other => bail!(
            "promoted extension {} has unsupported packaging build kind {other}",
            extension.sql_name
        ),
    }
}

fn stage_recipe_staged_extension(
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    let staging = extension
        .staging
        .as_ref()
        .ok_or_else(|| anyhow!("extension {} has no staging metadata", extension.id))?;
    let extension_sql_dir = stage.join("share/postgresql/extension");
    let module_dir = stage.join("lib/postgresql");
    fs::create_dir_all(&extension_sql_dir)
        .with_context(|| format!("create {}", extension_sql_dir.display()))?;
    fs::create_dir_all(&module_dir).with_context(|| format!("create {}", module_dir.display()))?;

    let module_file = extension
        .module_file
        .as_deref()
        .ok_or_else(|| anyhow!("extension {} has no native module file", extension.id))?;
    let module_source_dir = staging.module_source_dir.as_deref().ok_or_else(|| {
        anyhow!(
            "extension {} staging metadata has no module_source_dir",
            extension.id
        )
    })?;
    copy_file(
        &build.join(module_source_dir).join(module_file),
        &module_dir.join(module_file),
    )?;
    for support_module in &extension.native_support_modules {
        let source = build.join(&support_module.build_path);
        ensure!(
            source.is_file(),
            "extension {} build did not produce support module {}",
            extension.id,
            source.display()
        );
        copy_file(&source, &stage.join(&support_module.runtime_path))?;
    }
    let control_source = staging.control_source.as_deref().ok_or_else(|| {
        anyhow!(
            "extension {} staging metadata has no control_source",
            extension.id
        )
    })?;
    let control_source = build.join(control_source);
    let control_file_name = control_source.file_name().ok_or_else(|| {
        anyhow!(
            "control source has no file name: {}",
            control_source.display()
        )
    })?;
    copy_file(&control_source, &extension_sql_dir.join(control_file_name))?;

    let sql_source_dir = staging.sql_source_dir.as_deref().ok_or_else(|| {
        anyhow!(
            "extension {} staging metadata has no sql_source_dir",
            extension.id
        )
    })?;
    let sql_source_dir = build.join(sql_source_dir);
    let copied_sql = copy_extension_sql_dir(&sql_source_dir, &extension_sql_dir)?;
    ensure!(
        copied_sql,
        "extension {} build did not produce extension SQL files under {}",
        extension.id,
        sql_source_dir.display()
    );
    for excluded in &extension.excluded_sql_extensions {
        let excluded_control = format!("{excluded}.control");
        ensure!(
            !extension_sql_dir.join(&excluded_control).exists(),
            "extension {} archive must not include excluded extension control file {excluded_control}",
            extension.id
        );
    }
    for data_dir in &staging.data_dirs {
        let source = build.join(&data_dir.source);
        ensure!(
            source.is_dir(),
            "extension {} staging data directory is missing: {}",
            extension.id,
            source.display()
        );
        copy_dir_all(&source, &stage.join(&data_dir.destination))?;
    }
    Ok(())
}

fn stage_pgxs_style_extension(
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    let source = Path::new(&extension.source_dir);
    let build_dir = pgxs_extension_build_dir(build, extension);
    let sql_name = extension.sql_name.as_str();
    let extension_sql_dir = stage.join("share/postgresql/extension");
    fs::create_dir_all(stage.join("share/postgresql/extension"))
        .with_context(|| format!("create {}", extension_sql_dir.display()))?;
    if let Some(module_file) = &extension.module_file {
        fs::create_dir_all(stage.join("lib/postgresql"))
            .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
        copy_file(
            &build_dir.join(module_file),
            &stage.join("lib/postgresql").join(module_file),
        )?;
    }
    if extension.lifecycle.create_extension || extension.control_file.is_some() {
        let control_file = extension
            .control_file
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| source.join(format!("{sql_name}.control")));
        copy_file(
            &control_file,
            &stage
                .join("share/postgresql/extension")
                .join(control_file.file_name().unwrap_or_default()),
        )?;
    }
    let mut copied_root_sql = copy_extension_sql_files(&build_dir, sql_name, &extension_sql_dir)?;
    if !copied_root_sql {
        copied_root_sql = copy_extension_sql_files(source, sql_name, &extension_sql_dir)?;
    }
    if !copied_root_sql {
        let copied_build_sql_dir =
            copy_extension_sql_dir(&build_dir.join("sql"), &extension_sql_dir)?;
        if !copied_build_sql_dir {
            copy_extension_sql_dir(&source.join("sql"), &extension_sql_dir)?;
        }
    }
    if extension.id == "age" {
        let age_sql = extension_sql_dir.join("age--1.7.0.sql");
        let age_sql_text =
            fs::read_to_string(&age_sql).with_context(|| format!("read {}", age_sql.display()))?;
        ensure!(
            age_sql_text.contains("CREATE TYPE graphid"),
            "{} must contain AGE graphid type definition",
            age_sql.display()
        );
        ensure!(
            !age_sql_text
                .lines()
                .any(|line| line.trim() == "PASSEDBYVALUE,"),
            "{} still declares graphid PASSEDBYVALUE for wasm32/WASIX; rebuild AGE with SIZEOF_DATUM=4",
            age_sql.display()
        );
    }
    Ok(())
}

fn copy_extension_sql_files(source: &Path, sql_name: &str, destination: &Path) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    let mut copied = false;
    for entry in sorted_children(source)? {
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with(&format!("{sql_name}--")) || name == format!("{sql_name}.sql"))
            && name.ends_with(".sql")
        {
            copy_file(&entry, &destination.join(name))?;
            copied = true;
        }
    }
    Ok(copied)
}

fn copy_extension_sql_dir(source: &Path, destination: &Path) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    let mut copied = false;
    for entry in sorted_files(source)? {
        if entry.extension().and_then(|ext| ext.to_str()) != Some("sql") {
            continue;
        }
        let file_name = entry
            .file_name()
            .ok_or_else(|| anyhow!("SQL file has no name: {}", entry.display()))?;
        copy_file(&entry, &destination.join(file_name))?;
        copied = true;
    }
    Ok(copied)
}

fn stage_contrib_extension(
    source: &Path,
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    let contrib_dir = extension
        .contrib_dir
        .as_deref()
        .ok_or_else(|| anyhow!("contrib extension {} has no contrib_dir", extension.id))?;
    let extension_source = source.join("contrib").join(contrib_dir);
    fs::create_dir_all(stage.join("share/postgresql/extension")).with_context(|| {
        format!(
            "create {}",
            stage.join("share/postgresql/extension").display()
        )
    })?;
    if let Some(module_file) = &extension.module_file {
        fs::create_dir_all(stage.join("lib/postgresql"))
            .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
        copy_file(
            &build.join("contrib").join(contrib_dir).join(module_file),
            &stage.join("lib/postgresql").join(module_file),
        )?;
    }
    if extension.lifecycle.create_extension || extension.control_file.is_some() {
        let control_file = extension_source.join(format!("{}.control", extension.sql_name));
        copy_file(
            &control_file,
            &stage
                .join("share/postgresql/extension")
                .join(control_file.file_name().unwrap_or_default()),
        )?;
    }
    for entry in sorted_children(&extension_source)? {
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with(&format!("{}--", extension.sql_name))
            || name == format!("{}.sql", extension.sql_name))
            && name.ends_with(".sql")
        {
            copy_file(&entry, &stage.join("share/postgresql/extension").join(name))?;
        } else if name.ends_with(".rules") {
            let tsearch_data = stage.join("share/postgresql/tsearch_data");
            fs::create_dir_all(&tsearch_data)
                .with_context(|| format!("create {}", tsearch_data.display()))?;
            copy_file(&entry, &tsearch_data.join(name))?;
        }
    }
    Ok(())
}

fn stage_runtime_tree(build: &Path, source: &Path, runtime: &Path) -> Result<()> {
    let bin = runtime.join("bin");
    let lib = runtime.join("lib/postgresql");
    let share = runtime.join("share/postgresql");
    fs::create_dir_all(&bin).with_context(|| format!("create {}", bin.display()))?;
    fs::create_dir_all(&lib).with_context(|| format!("create {}", lib.display()))?;
    fs::create_dir_all(&share).with_context(|| format!("create {}", share.display()))?;

    copy_file(&build.join("src/backend/oliphaunt"), &bin.join("oliphaunt"))?;
    copy_file(&build.join("src/backend/oliphaunt"), &bin.join("postgres"))?;
    copy_file(&build.join("src/bin/initdb/initdb"), &bin.join("initdb"))?;
    fs::write(runtime.join("password"), b"password\n")
        .with_context(|| format!("write {}", runtime.join("password").display()))?;

    copy_file(
        &build.join("src/include/catalog/postgres.bki"),
        &share.join("postgres.bki"),
    )?;
    copy_file(
        &build.join("src/include/catalog/system_constraints.sql"),
        &share.join("system_constraints.sql"),
    )?;
    for relative in [
        "src/backend/catalog/system_functions.sql",
        "src/backend/catalog/system_views.sql",
        "src/backend/catalog/information_schema.sql",
        "src/backend/catalog/sql_features.txt",
        "src/backend/libpq/pg_hba.conf.sample",
        "src/backend/libpq/pg_ident.conf.sample",
        "src/backend/utils/misc/postgresql.conf.sample",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &share.join(file_name))?;
    }

    copy_file(
        &build.join("src/backend/snowball/snowball_create.sql"),
        &share.join("snowball_create.sql"),
    )?;
    copy_file(
        &build.join("src/backend/snowball/dict_snowball.so"),
        &lib.join("dict_snowball.so"),
    )?;
    copy_file(
        &build.join("src/pl/plpgsql/src/plpgsql.so"),
        &lib.join("plpgsql.so"),
    )?;

    let extension_dir = share.join("extension");
    fs::create_dir_all(&extension_dir)
        .with_context(|| format!("create {}", extension_dir.display()))?;
    for relative in [
        "src/pl/plpgsql/src/plpgsql.control",
        "src/pl/plpgsql/src/plpgsql--1.0.sql",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &extension_dir.join(file_name))?;
    }

    copy_tree_filtered(
        &source.join("src/backend/tsearch/dicts"),
        &share.join("tsearch_data"),
        None,
    )?;
    copy_tree_filtered(
        &source.join("src/timezone/tznames"),
        &share.join("timezonesets"),
        Some(&["Makefile", "meson.build", "README"]),
    )?;
    stage_timezone_database(source, build, &share)?;
    Ok(())
}

fn stage_timezone_database(source: &Path, build: &Path, share: &Path) -> Result<()> {
    let tzdata = source.join("src/timezone/data/tzdata.zi");
    ensure_file(&tzdata)?;
    let compiled_timezone_dir = build.join("src/timezone/compiled");

    let timezone_dir = share.join("timezone");
    if timezone_dir.exists() {
        fs::remove_dir_all(&timezone_dir)
            .with_context(|| format!("remove {}", timezone_dir.display()))?;
    }
    fs::create_dir_all(&timezone_dir)
        .with_context(|| format!("create {}", timezone_dir.display()))?;
    copy_tree_filtered(&compiled_timezone_dir, &timezone_dir, None).with_context(|| {
        format!(
            "copy compiled PostgreSQL timezone database from {}",
            compiled_timezone_dir.display()
        )
    })?;

    for required in ["UTC", "GMT", "Etc/UTC", "America/New_York"] {
        let path = timezone_dir.join(required);
        if !path.is_file() {
            bail!(
                "compiled PostgreSQL timezone database is missing required zone {}",
                path.display()
            );
        }
    }
    Ok(())
}

fn package_aot_artifacts(
    target: &str,
    outputs: &BuildOutputs,
    sources: &SourcesManifest,
) -> Result<()> {
    let source_dir = generated_aot_source_dir_for_source_lane(target, &outputs.source_lane)?;
    if !source_dir.exists() {
        let source_lane_arg = if outputs.source_lane == DEFAULT_SOURCE_LANE {
            String::new()
        } else {
            format!(" --source-lane {}", outputs.source_lane)
        };
        bail!(
            "AOT source directory {} is missing; run `cargo run -p xtask -- assets aot --target-triple {target}{source_lane_arg}` before packaging",
            source_dir.display()
        );
    }

    let artifacts_dir = generated_aot_dir_for_source_lane(target, &outputs.source_lane)?;
    if artifacts_dir.exists() {
        fs::remove_dir_all(&artifacts_dir)
            .with_context(|| format!("remove {}", artifacts_dir.display()))?;
    }
    fs::create_dir_all(&artifacts_dir)
        .with_context(|| format!("create {}", artifacts_dir.display()))?;

    let mut manifest_artifacts = Vec::new();
    for module in outputs
        .modules
        .iter()
        .filter(|module| module.requires_aot && is_core_aot_module(&module.name))
    {
        let name = module.name.as_str();
        let file = module.aot_file.as_str();
        let source = source_dir.join(file);
        if !source.exists() {
            bail!(
                "missing AOT artifact {}; run AOT generation for target {target} before packaging",
                source.display()
            );
        }
        let destination = artifacts_dir.join(file);
        copy_file(&source, &destination)?;
        let raw_artifact = decode_zstd_file(&destination)
            .with_context(|| format!("decode AOT artifact {}", destination.display()))?;
        let module_sha256 = outputs
            .modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| sha256_file(&module.path))
            .transpose()?
            .ok_or_else(|| anyhow!("missing build output module {name} for AOT manifest"))?;
        manifest_artifacts.push(AotManifestArtifact {
            name: name.to_owned(),
            path: file.to_owned(),
            sha256: sha256_file(&destination)?,
            raw_sha256: sha256_bytes(&raw_artifact),
            raw_size: raw_artifact.len() as u64,
            module_sha256,
            compressed: true,
        });
    }
    ensure!(
        !manifest_artifacts.is_empty(),
        "AOT packaging produced an empty manifest for {target}"
    );

    let manifest = AotManifest {
        format_version: 1,
        source_lane: Some(outputs.source_lane.clone()),
        source_fingerprint: outputs.source_fingerprint.clone(),
        postgres_version: Some(outputs.postgres_version.clone()),
        target_triple: target.to_owned(),
        engine: "llvm-opta".to_owned(),
        wasmer_version: sources.toolchain.wasmer.clone(),
        wasmer_wasix_version: sources.toolchain.wasmer_wasix.clone(),
        artifacts: manifest_artifacts,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).context("serialize AOT manifest")?;
    fs::write(
        artifacts_dir.join("manifest.json"),
        format!("{manifest_json}\n"),
    )
    .with_context(|| format!("write {}", artifacts_dir.join("manifest.json").display()))?;
    Ok(())
}

pub(crate) fn package_extension_aot_artifacts(
    sources: &SourcesManifest,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot(source_lane)?;
    let source_dir = generated_aot_source_dir_for_source_lane(target, &outputs.source_lane)?;
    if !source_dir.exists() {
        let source_lane_arg = if outputs.source_lane == DEFAULT_SOURCE_LANE {
            String::new()
        } else {
            format!(" --source-lane {}", outputs.source_lane)
        };
        bail!(
            "AOT source directory {} is missing; run `cargo run -p xtask -- assets aot --target-triple {target}{source_lane_arg}` before packaging extension AOT artifacts",
            source_dir.display()
        );
    }

    let target_id = aot_target_id_for_triple(target)?;
    let artifacts_root = Path::new("target/extensions/wasix/aot-artifacts").join(target_id);
    if artifacts_root.exists() {
        fs::remove_dir_all(&artifacts_root)
            .with_context(|| format!("remove {}", artifacts_root.display()))?;
    }
    fs::create_dir_all(&artifacts_root)
        .with_context(|| format!("create {}", artifacts_root.display()))?;

    let mut grouped: BTreeMap<String, Vec<AotManifestArtifact>> = BTreeMap::new();
    for module in outputs
        .modules
        .iter()
        .filter(|module| module.requires_aot && !is_core_aot_module(&module.name))
    {
        let Some(sql_name) = extension_module_sql_name(&module.name) else {
            bail!("extension AOT module has invalid name {}", module.name);
        };
        let source = source_dir.join(&module.aot_file);
        if !source.exists() {
            bail!(
                "missing extension AOT artifact {}; run AOT generation for target {target} before packaging",
                source.display()
            );
        }
        let extension_dir = artifacts_root.join(sql_name);
        fs::create_dir_all(&extension_dir)
            .with_context(|| format!("create {}", extension_dir.display()))?;
        let destination = extension_dir.join(&module.aot_file);
        copy_file(&source, &destination)?;
        let raw_artifact = decode_zstd_file(&destination)
            .with_context(|| format!("decode extension AOT artifact {}", destination.display()))?;
        grouped
            .entry(sql_name.to_owned())
            .or_default()
            .push(AotManifestArtifact {
                name: module.name.clone(),
                path: module.aot_file.clone(),
                sha256: sha256_file(&destination)?,
                raw_sha256: sha256_bytes(&raw_artifact),
                raw_size: raw_artifact.len() as u64,
                module_sha256: sha256_file(&module.path)?,
                compressed: true,
            });
    }

    ensure!(
        !grouped.is_empty(),
        "extension AOT packaging produced no artifacts for {target}"
    );

    for (sql_name, mut artifacts) in grouped {
        artifacts.sort_by(|left, right| left.name.cmp(&right.name));
        let manifest = AotManifest {
            format_version: 1,
            source_lane: Some(outputs.source_lane.clone()),
            source_fingerprint: outputs.source_fingerprint.clone(),
            postgres_version: Some(outputs.postgres_version.clone()),
            target_triple: target.to_owned(),
            engine: "llvm-opta".to_owned(),
            wasmer_version: sources.toolchain.wasmer.clone(),
            wasmer_wasix_version: sources.toolchain.wasmer_wasix.clone(),
            artifacts,
        };
        let manifest_json =
            serde_json::to_string_pretty(&manifest).context("serialize extension AOT manifest")?;
        let manifest_path = artifacts_root.join(&sql_name).join("manifest.json");
        fs::write(&manifest_path, format!("{manifest_json}\n"))
            .with_context(|| format!("write {}", manifest_path.display()))?;
    }
    Ok(())
}

pub(crate) fn check_aot_package_manifest(target: &str, source_lane: &str) -> Result<()> {
    let sources = load_wasix_toolchain_manifest()?;
    let outputs = BuildOutputs::discover_for_aot(source_lane)?;
    let artifacts_dir = find_aot_artifact_dir_for_source_lane(target, &outputs.source_lane)?;
    let manifest_path = artifacts_dir.join("manifest.json");
    ensure_file(&manifest_path)?;
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let actual_lane = manifest.source_lane.as_deref().unwrap_or("<missing>");
    ensure_eq(
        actual_lane,
        outputs.source_lane.as_str(),
        "AOT manifest source-lane",
    )?;
    if let Some(source_fingerprint) = outputs.source_fingerprint.as_deref() {
        ensure_eq(
            manifest
                .source_fingerprint
                .as_deref()
                .unwrap_or("<missing>"),
            source_fingerprint,
            "AOT manifest source-fingerprint",
        )?;
    }
    if let Some(postgres_version) = manifest.postgres_version.as_deref() {
        ensure_eq(
            postgres_version,
            outputs.postgres_version.as_str(),
            "AOT manifest postgres-version",
        )?;
    }
    ensure_eq(
        &manifest.target_triple,
        target,
        "AOT manifest target-triple",
    )?;
    ensure_eq(&manifest.engine, "llvm-opta", "AOT manifest engine")?;
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

    for artifact in &manifest.artifacts {
        let artifact_relative_path = Path::new(&artifact.path);
        ensure!(
            artifact_relative_path.is_relative()
                && artifact_relative_path
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))),
            "AOT artifact {} path must be a simple relative file path, got {}",
            artifact.name,
            artifact.path
        );
        let path = artifacts_dir.join(&artifact.path);
        ensure_file(&path)?;
        let actual_hash = sha256_file(&path)?;
        ensure_eq(
            &actual_hash,
            &artifact.sha256,
            &format!("AOT artifact {} sha256", artifact.name),
        )?;
        if artifact.compressed {
            let raw = decode_zstd_file(&path)
                .with_context(|| format!("decode AOT artifact {}", path.display()))?;
            ensure_eq(
                &sha256_bytes(&raw),
                &artifact.raw_sha256,
                &format!("AOT artifact {} raw sha256", artifact.name),
            )?;
            let actual_raw_size = raw.len() as u64;
            if actual_raw_size != artifact.raw_size {
                bail!(
                    "AOT artifact {} raw size mismatch: expected {} got {}",
                    artifact.name,
                    artifact.raw_size,
                    actual_raw_size
                );
            }
        }
        let module = outputs
            .modules
            .iter()
            .find(|module| module.name == artifact.name)
            .ok_or_else(|| anyhow!("AOT manifest references unknown module {}", artifact.name))?;
        ensure!(
            module.requires_aot,
            "AOT manifest references non-release-AOT module {}",
            artifact.name
        );
        ensure!(
            is_core_aot_module(&artifact.name),
            "core AOT manifest must not reference extension module {}",
            artifact.name
        );
        let module_hash = sha256_file(&module.path)?;
        ensure_eq(
            &module_hash,
            &artifact.module_sha256,
            &format!("AOT artifact {} source module sha256", artifact.name),
        )?;
    }
    let expected = outputs
        .modules
        .iter()
        .filter(|module| module.requires_aot && is_core_aot_module(&module.name))
        .map(|module| module.name.as_str())
        .collect::<BTreeSet<_>>();
    let actual = manifest
        .artifacts
        .iter()
        .map(|artifact| artifact.name.as_str())
        .collect::<BTreeSet<_>>();
    ensure!(
        actual == expected,
        "AOT manifest module set mismatch: expected {expected:?} got {actual:?}"
    );
    let expected_files = manifest
        .artifacts
        .iter()
        .map(|artifact| artifact.path.as_str())
        .collect::<BTreeSet<_>>();
    let actual_files = sorted_files(&artifacts_dir)?
        .into_iter()
        .map(|path| {
            path.strip_prefix(&artifacts_dir)
                .with_context(|| {
                    format!("strip {} from {}", artifacts_dir.display(), path.display())
                })
                .and_then(|relative| {
                    relative.to_str().map(str::to_owned).ok_or_else(|| {
                        anyhow!("AOT artifact path is not UTF-8: {}", path.display())
                    })
                })
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let mut expected_package_files = expected_files
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    expected_package_files.insert("manifest.json".to_owned());
    ensure!(
        actual_files == expected_package_files,
        "AOT artifact file set mismatch: expected {expected_package_files:?} got {actual_files:?}"
    );
    Ok(())
}

pub(crate) fn generated_aot_dir(target: &str) -> PathBuf {
    Path::new(GENERATED_AOT_DIR).join(target)
}

fn crate_aot_artifact_dir(target: &str) -> PathBuf {
    Path::new("src/runtimes/liboliphaunt/wasix/crates/aot")
        .join(target)
        .join("artifacts")
}

pub(crate) fn find_aot_artifact_dir(target: &str) -> Result<PathBuf> {
    find_aot_artifact_dir_for_source_lane(target, DEFAULT_SOURCE_LANE)
}

fn find_aot_artifact_dir_for_source_lane(target: &str, source_lane: &str) -> Result<PathBuf> {
    let generated = generated_aot_dir_for_source_lane(target, source_lane)?;
    if generated.join("manifest.json").is_file() {
        return Ok(generated);
    }
    let crate_dir = crate_aot_artifact_dir(target);
    if crate_dir.join("manifest.json").is_file() {
        return Ok(crate_dir);
    }
    bail!(
        "missing AOT artifacts for {target}; expected {} or {}",
        generated.display(),
        crate_dir.display()
    )
}

#[allow(clippy::too_many_arguments)] // Each parameter is a distinct frozen asset-manifest input.
fn write_asset_manifest(
    sources: &SourcesManifest,
    outputs: &BuildOutputs,
    assets_dir: &Path,
    runtime_module: &Path,
    runtime_archive: &Path,
    pg_dump: Option<&Path>,
    psql: Option<&Path>,
    initdb: &Path,
    runtime_support: &[BinaryPackage<'_>],
    extensions: &[ExtensionArtifact<'_>],
) -> Result<()> {
    let runtime_link = read_wasm_link_metadata(runtime_module)?;
    let runtime_exports = wasm_export_name_set(&runtime_link);
    let extension_metadata = extension_catalog::manifest_metadata_by_sql_name()?;
    let effective_sources = effective_source_pins(sources, outputs)?;
    let manifest = AssetManifestOut {
        format_version: 1,
        source_lane: Some(outputs.source_lane.clone()),
        source_fingerprint: outputs.source_fingerprint.clone(),
        runtime: RuntimeAssetOut {
            archive: "oliphaunt.wasix.tar.zst".to_owned(),
            sha256: sha256_file(runtime_archive)?,
            module_sha256: sha256_file(runtime_module)?,
            postgres_version: outputs.postgres_version.clone(),
            runtime_kind: "wasix-dynamic-main".to_owned(),
            link: runtime_link.clone(),
        },
        runtime_support: runtime_support
            .iter()
            .map(|module| {
                Ok::<_, anyhow::Error>(BinaryAssetOut {
                    name: module.name.to_owned(),
                    path: module.runtime_path.to_owned(),
                    sha256: sha256_file(module.path)?,
                    module_sha256: sha256_file(module.path)?,
                    size: fs::metadata(module.path)
                        .with_context(|| format!("metadata {}", module.path.display()))?
                        .len(),
                    link: read_wasm_link_metadata(module.path)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        pg_dump: pg_dump
            .map(|pg_dump| {
                Ok::<_, anyhow::Error>(BinaryAssetOut {
                    name: "pg_dump".to_owned(),
                    path: "bin/pg_dump.wasix.wasm".to_owned(),
                    sha256: sha256_file(pg_dump)?,
                    module_sha256: sha256_file(pg_dump)?,
                    size: fs::metadata(pg_dump)
                        .with_context(|| format!("metadata {}", pg_dump.display()))?
                        .len(),
                    link: read_wasm_link_metadata(pg_dump)?,
                })
            })
            .transpose()?,
        psql: psql
            .map(|psql| {
                Ok::<_, anyhow::Error>(BinaryAssetOut {
                    name: "psql".to_owned(),
                    path: "bin/psql.wasix.wasm".to_owned(),
                    sha256: sha256_file(psql)?,
                    module_sha256: sha256_file(psql)?,
                    size: fs::metadata(psql)
                        .with_context(|| format!("metadata {}", psql.display()))?
                        .len(),
                    link: read_wasm_link_metadata(psql)?,
                })
            })
            .transpose()?,
        initdb: Some(BinaryAssetOut {
            name: "initdb".to_owned(),
            path: "bin/initdb.wasix.wasm".to_owned(),
            sha256: sha256_file(initdb)?,
            module_sha256: sha256_file(initdb)?,
            size: fs::metadata(initdb)
                .with_context(|| format!("metadata {}", initdb.display()))?
                .len(),
            link: read_wasm_link_metadata(initdb)?,
        }),
        pgdata_template: Some(pgdata_template_asset_out(
            sources,
            outputs,
            runtime_module,
            initdb,
            &assets_dir.join("prepopulated/pgdata-template.tar.zst"),
            &assets_dir.join("prepopulated/pgdata-template.json"),
        )?),
        extensions: extensions
            .iter()
            .map(|extension| {
                let link = extension
                    .module_path
                    .map(read_wasm_link_metadata)
                    .transpose()?;
                let native_module_links = extension
                    .native_modules
                    .iter()
                    .map(|module| {
                        Ok::<_, anyhow::Error>((
                            module.name.clone(),
                            read_wasm_link_metadata(&module.path)?,
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>>>()?;
                let metadata = extension_metadata.get(extension.sql_name).ok_or_else(|| {
                    anyhow!(
                        "extension {} is missing from generated extension catalog",
                        extension.sql_name
                    )
                })?;
                let mut core_exports_required = Vec::new();
                let mut unresolved_imports = Vec::new();
                if let Some(link) = &link {
                    let module_exports = extension_asset_provider_exports(
                        link,
                        extension.sql_name,
                        &native_module_links,
                    );
                    for import in &link.imports {
                        if !import_should_resolve_from_runtime(import) {
                            continue;
                        }
                        if import_resolves_from_linked_module_exports(import, &module_exports) {
                            continue;
                        }
                        let normalized = import.name.trim_start_matches('_');
                        if runtime_exports.contains(import.name.as_str()) {
                            core_exports_required.push(import.name.clone());
                        } else if runtime_exports.contains(normalized) {
                            core_exports_required.push(normalized.to_owned());
                        } else {
                            unresolved_imports.push(import.clone());
                        }
                    }
                }
                core_exports_required.sort();
                core_exports_required.dedup();
                let installed_files = archive_file_list(extension.path)?;
                let control_files = extension_control_files_for_asset_manifest(
                    outputs.source_lane.as_str(),
                    metadata,
                    &installed_files,
                    extension.sql_name,
                )?;
                let promoted = extension.stable
                    && metadata.smoke_status.direct == "passed"
                    && metadata.smoke_status.server == "passed"
                    && metadata.smoke_status.restart == "passed"
                    && metadata.smoke_status.dump_restore == "passed";
                ensure!(
                    !metadata.smoke_status.promoted || promoted,
                    "extension {} catalog metadata marks the asset promoted but current package evidence is insufficient",
                    extension.sql_name
                );
                let native_modules = extension
                    .native_modules
                    .iter()
                    .map(|module| {
                        let link = native_module_links.get(&module.name).cloned().ok_or_else(
                            || anyhow!("missing link metadata for {}", module.name),
                        )?;
                        Ok::<_, anyhow::Error>(BinaryAssetOut {
                            name: module.name.clone(),
                            path: module.runtime_path.clone(),
                            sha256: sha256_file(&module.path)?,
                            module_sha256: sha256_file(&module.path)?,
                            size: fs::metadata(&module.path)
                                .with_context(|| {
                                    format!("metadata {}", module.path.display())
                                })?
                                .len(),
                            link,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(ExtensionAssetOut {
                    name: extension.name.to_owned(),
                    sql_name: extension.sql_name.to_owned(),
                    source_kind: metadata.source_kind.clone(),
                    archive: extension.archive.to_owned(),
                    sha256: sha256_file(extension.path)?,
                    module_sha256: extension
                        .module_path
                        .map(sha256_file)
                        .transpose()?
                        .unwrap_or_default(),
                    native_module: extension.native_module.map(str::to_owned),
                    native_modules,
                    size: fs::metadata(extension.path)
                        .with_context(|| format!("metadata {}", extension.path.display()))?
                        .len(),
                    stable: extension.stable,
                    control_files,
                    dependencies: metadata.dependencies.clone(),
                    native_dependencies: metadata.native_dependencies.clone(),
                    load_order: metadata.load_order.clone(),
                    lifecycle: ExtensionLifecycleOut {
                        create_extension: metadata.lifecycle.create_extension,
                        create_schema: metadata.lifecycle.create_schema.clone(),
                        load_sql: metadata.lifecycle.load_sql.clone(),
                        post_create_sql: metadata.lifecycle.post_create_sql.clone(),
                        startup_config: metadata.lifecycle.startup_config.clone(),
                        preload_required: metadata.lifecycle.preload_required,
                        restart_required: metadata.lifecycle.restart_required,
                        shared_memory_required: metadata.lifecycle.shared_memory_required,
                    },
                    extension_imports: link
                        .as_ref()
                        .map(|link| link.imports.clone())
                        .unwrap_or_default(),
                    core_exports_required,
                    unresolved_imports,
                    installed_files,
                    smoke_status: ExtensionSmokeStatusOut {
                        promoted,
                        direct: metadata.smoke_status.direct.clone(),
                        server: metadata.smoke_status.server.clone(),
                        restart: metadata.smoke_status.restart.clone(),
                        dump_restore: metadata.smoke_status.dump_restore.clone(),
                    },
                    link,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        sources: effective_sources,
    };

    let text = serde_json::to_string_pretty(&manifest).context("serialize asset manifest")?;
    let manifest_path = assets_dir.join("manifest.json");
    fs::write(&manifest_path, format!("{text}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

fn extension_control_files_for_asset_manifest(
    source_lane: &str,
    metadata: &extension_catalog::ManifestExtensionMetadata,
    installed_files: &[String],
    sql_name: &str,
) -> Result<Vec<String>> {
    ensure_eq(
        canonical_source_lane(source_lane)?,
        DEFAULT_SOURCE_LANE,
        "extension manifest source lane",
    )?;

    let mut control_files = installed_files
        .iter()
        .filter(|path| {
            path.starts_with("share/postgresql/extension/") && path.ends_with(".control")
        })
        .cloned()
        .collect::<Vec<_>>();
    control_files.sort();
    control_files.dedup();
    if metadata.lifecycle.create_extension || !metadata.control_files.is_empty() {
        ensure!(
            !control_files.is_empty(),
            "PG18 extension {sql_name} manifest control-files must come from packaged extension archive contents"
        );
    }
    ensure!(
        control_files
            .iter()
            .all(|path| !path.contains("removed-fork")),
        "PG18 extension {sql_name} manifest control-files must not reference removed source paths"
    );
    Ok(control_files)
}

#[allow(clippy::items_after_test_module)] // Later helpers are shared by production and these focused tests.
#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_extension_metadata(
        create_extension: bool,
        control_files: Vec<&str>,
    ) -> extension_catalog::ManifestExtensionMetadata {
        extension_catalog::ManifestExtensionMetadata {
            source_kind: "postgres-contrib".to_owned(),
            control_files: control_files.into_iter().map(str::to_owned).collect(),
            dependencies: Vec::new(),
            native_dependencies: Vec::new(),
            load_order: Vec::new(),
            lifecycle: extension_catalog::ManifestExtensionLifecycle {
                create_extension,
                create_schema: None,
                load_sql: Vec::new(),
                post_create_sql: Vec::new(),
                startup_config: Vec::new(),
                preload_required: false,
                restart_required: false,
                shared_memory_required: false,
            },
            smoke_status: extension_catalog::ManifestExtensionSmokeStatus {
                promoted: true,
                direct: "passed".to_owned(),
                server: "passed".to_owned(),
                restart: "passed".to_owned(),
                dump_restore: "not-run".to_owned(),
            },
        }
    }

    #[test]
    fn pg18_lane_uses_packaged_control_files() {
        let metadata = manifest_extension_metadata(
            true,
            vec!["target/oliphaunt-sources/checkouts/removed-fork/contrib/pg_trgm/pg_trgm.control"],
        );
        let installed_files = vec![
            "share/postgresql/extension/pg_trgm.control".to_owned(),
            "share/postgresql/extension/pg_trgm--1.6.sql".to_owned(),
            "share/postgresql/extension/pg_trgm.control".to_owned(),
        ];

        let control_files = extension_control_files_for_asset_manifest(
            "stable",
            &metadata,
            &installed_files,
            "pg_trgm",
        )
        .expect("PG18 packaged control files");

        assert_eq!(
            control_files,
            vec!["share/postgresql/extension/pg_trgm.control"]
        );
    }

    #[test]
    fn legacy_pg17_lane_is_not_selectable_for_control_files() {
        let metadata = manifest_extension_metadata(
            true,
            vec!["target/oliphaunt-sources/checkouts/removed-fork/contrib/pg_trgm/pg_trgm.control"],
        );
        let installed_files = vec!["share/postgresql/extension/pg_trgm.control".to_owned()];

        let error = extension_control_files_for_asset_manifest(
            "pg17",
            &metadata,
            &installed_files,
            "pg_trgm",
        )
        .expect_err("PG17 lane must no longer be selectable");

        assert!(
            error
                .to_string()
                .contains("unsupported WASIX asset source lane")
        );
    }

    #[test]
    fn pg18_lane_requires_packaged_control_files_for_create_extension() {
        let metadata = manifest_extension_metadata(
            true,
            vec!["target/oliphaunt-sources/checkouts/removed-fork/contrib/pg_trgm/pg_trgm.control"],
        );
        let error = extension_control_files_for_asset_manifest("stable", &metadata, &[], "pg_trgm")
            .expect_err("PG18 missing packaged control file should fail");

        assert!(
            error
                .to_string()
                .contains("must come from packaged extension archive contents")
        );
    }

    #[test]
    fn pg18_lane_rejects_released_control_paths() {
        let metadata = manifest_extension_metadata(true, Vec::new());
        let installed_files =
            vec!["share/postgresql/extension/removed-fork-leak.control".to_owned()];
        let error = extension_control_files_for_asset_manifest(
            "stable",
            &metadata,
            &installed_files,
            "pg_trgm",
        )
        .expect_err("PG18 released path leak should fail");

        assert!(
            error
                .to_string()
                .contains("must not reference removed source paths")
        );
    }

    fn temp_aot_manifest_path(label: &str) -> PathBuf {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "oliphaunt-xtask-aot-manifest-{}-{now}-{label}.json",
            std::process::id()
        ))
    }

    fn write_downloaded_aot_manifest(
        path: &Path,
        source_lane: Option<&str>,
        source_fingerprint: Option<&str>,
        postgres_version: Option<&str>,
    ) {
        let manifest = AotManifest {
            format_version: 1,
            source_lane: source_lane.map(str::to_owned),
            source_fingerprint: source_fingerprint.map(str::to_owned),
            postgres_version: postgres_version.map(str::to_owned),
            target_triple: "aarch64-apple-darwin".to_owned(),
            engine: "llvm-opta".to_owned(),
            wasmer_version: "7.2.0".to_owned(),
            wasmer_wasix_version: "0.702.0".to_owned(),
            artifacts: vec![AotManifestArtifact {
                name: "runtime:oliphaunt".to_owned(),
                path: "oliphaunt.aot.zst".to_owned(),
                sha256: "archive".to_owned(),
                raw_sha256: "raw".to_owned(),
                raw_size: 1,
                module_sha256: "module".to_owned(),
                compressed: true,
            }],
        };
        fs::write(
            path,
            serde_json::to_string(&manifest).expect("serialize AOT manifest"),
        )
        .expect("write AOT manifest");
    }

    #[test]
    fn downloaded_stable_pg18_aot_manifest_is_validated_before_install() {
        let path = temp_aot_manifest_path("pg18-ok");
        let fingerprint = expected_postgres_source_fingerprint().expect("PG18 fingerprint");
        write_downloaded_aot_manifest(
            &path,
            Some("stable"),
            Some(&fingerprint),
            Some("18.4-wasix-oliphaunt"),
        );

        ensure_aot_manifest_matches_source_lane(&path, "aarch64-apple-darwin", DEFAULT_SOURCE_LANE)
            .expect("stable downloaded AOT manifest");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn downloaded_stable_pg18_aot_manifest_requires_source_fingerprint() {
        let path = temp_aot_manifest_path("pg18-missing-fingerprint");
        write_downloaded_aot_manifest(&path, Some("stable"), None, Some("18.4-wasix-oliphaunt"));

        let error = ensure_aot_manifest_matches_source_lane(
            &path,
            "aarch64-apple-darwin",
            DEFAULT_SOURCE_LANE,
        )
        .expect_err("PG18 downloaded AOT manifest should require source fingerprint");

        assert!(
            error
                .to_string()
                .contains("PG18 AOT manifest source-fingerprint")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn downloaded_stable_aot_manifest_rejects_stale_wasmer_metadata() {
        let path = temp_aot_manifest_path("stale-wasmer");
        let fingerprint = expected_postgres_source_fingerprint().expect("PG18 fingerprint");
        write_downloaded_aot_manifest(
            &path,
            Some("stable"),
            Some(&fingerprint),
            Some("18.4-wasix-oliphaunt"),
        );
        let mut manifest: AotManifest =
            serde_json::from_str(&fs::read_to_string(&path).expect("read AOT manifest"))
                .expect("parse AOT manifest");
        manifest.wasmer_version = "7.2.0-alpha.3".to_owned();
        manifest.wasmer_wasix_version = "0.702.0-alpha.3".to_owned();
        fs::write(
            &path,
            serde_json::to_string(&manifest).expect("serialize AOT manifest"),
        )
        .expect("write AOT manifest");

        let error = ensure_aot_manifest_matches_source_lane(
            &path,
            "aarch64-apple-darwin",
            DEFAULT_SOURCE_LANE,
        )
        .expect_err("downloaded AOT manifest with stale Wasmer metadata should fail");

        let error = format!("{error:#}");
        assert!(
            error.contains("AOT manifest wasmer-version"),
            "unexpected validation error: {error}"
        );
        let _ = fs::remove_file(path);
    }

    fn wasm_import(module: &str, name: &str, kind: &str) -> WasmImportOut {
        WasmImportOut {
            module: module.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
        }
    }

    #[test]
    fn wasix_linker_provided_imports_do_not_require_runtime_exports() {
        for import in [
            wasm_import("env", "memory", "memory"),
            wasm_import("env", "__indirect_function_table", "table"),
            wasm_import("env", "__stack_pointer", "global"),
            wasm_import("env", "__c_longjmp", "tag"),
            wasm_import("env", "__cpp_exception", "tag"),
            wasm_import("env", "__memory_base", "global"),
            wasm_import("env", "__table_base", "global"),
            wasm_import("GOT.mem", "__heap_base", "global"),
            wasm_import("GOT.mem", "__stack_high", "global"),
            wasm_import("GOT.mem", "__stack_low", "global"),
        ] {
            assert!(
                !import_should_resolve_from_runtime(&import),
                "{import:?} should be provided by the WASIX dynamic linker"
            );
        }
    }

    #[test]
    fn side_module_exports_satisfy_their_own_dynamic_symbol_imports() {
        let module_exports = HashSet::from([
            "GEOSArea_r".to_owned(),
            "_ZN10FlatGeobuf11PackedRTree4initEt".to_owned(),
            "ZN10FlatGeobuf11PackedRTree4initEt".to_owned(),
        ]);

        for import in [
            wasm_import("env", "GEOSArea_r", "func"),
            wasm_import("GOT.func", "_ZN10FlatGeobuf11PackedRTree4initEt", "global"),
            wasm_import("GOT.func", "ZN10FlatGeobuf11PackedRTree4initEt", "global"),
        ] {
            assert!(import_should_resolve_from_runtime(&import));
            assert!(
                import_resolves_from_linked_module_exports(&import, &module_exports),
                "{import:?} should be self-resolved by the linked side module"
            );
        }
    }

    #[test]
    fn unresolved_extension_imports_still_require_runtime_exports() {
        let runtime_import = wasm_import("env", "SearchSysCache1", "func");
        let module_exports = HashSet::from(["GEOSArea_r".to_owned()]);

        assert!(import_should_resolve_from_runtime(&runtime_import));
        assert!(!import_resolves_from_linked_module_exports(
            &runtime_import,
            &module_exports
        ));
    }
}

fn pgdata_template_asset_out(
    sources: &SourcesManifest,
    outputs: &BuildOutputs,
    runtime_module: &Path,
    initdb_module: &Path,
    archive: &Path,
    manifest: &Path,
) -> Result<PgDataTemplateAssetOut> {
    ensure_file(archive)?;
    ensure_file(manifest)?;
    let manifest_text =
        fs::read_to_string(manifest).with_context(|| format!("read {}", manifest.display()))?;
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest_text)
        .with_context(|| format!("parse {}", manifest.display()))?;
    let template_source_lane = manifest_json
        .get("sourceLane")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<missing>");
    ensure_eq(
        template_source_lane,
        outputs.source_lane.as_str(),
        "PGDATA template manifest sourceLane",
    )?;
    if let Some(source_fingerprint) = outputs.source_fingerprint.as_deref() {
        let template_source_fingerprint = manifest_json
            .get("sourceFingerprint")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>");
        ensure_eq(
            template_source_fingerprint,
            source_fingerprint,
            "PGDATA template manifest sourceFingerprint",
        )?;
    }
    let source_pins = effective_source_pins(sources, outputs)?;
    Ok(PgDataTemplateAssetOut {
        archive: "prepopulated/pgdata-template.tar.zst".to_owned(),
        manifest: "prepopulated/pgdata-template.json".to_owned(),
        sha256: sha256_file(archive)?,
        size: fs::metadata(archive)
            .with_context(|| format!("metadata {}", archive.display()))?
            .len(),
        runtime_module_sha256: sha256_file(runtime_module)?,
        initdb_module_sha256: sha256_file(initdb_module)?,
        source_pins_sha256: source_pins_sha256(&source_pins)?,
        source_lane: Some(outputs.source_lane.clone()),
        source_fingerprint: outputs.source_fingerprint.clone(),
        postgres_version: postgres_major_version(&outputs.postgres_version),
        catalog_version: manifest_json
            .get("catalogVersion")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        init_profile: template_runner::default_initdb_profile().to_owned(),
        wasmer_version: sources.toolchain.wasmer.clone(),
    })
}

pub(crate) fn effective_source_pins(
    sources: &SourcesManifest,
    outputs: &BuildOutputs,
) -> Result<Vec<SourcePin>> {
    let mut pins = sources
        .sources
        .iter()
        .filter(|source| !is_released_source_pin_for_pg18_manifest(source))
        .cloned()
        .collect::<Vec<_>>();
    let pg18 = load_postgres_source_manifest()?;
    pins.push(SourcePin {
        name: "postgresql".to_owned(),
        kind: SourceKind::Git,
        url: pg18.postgresql.url,
        mirror_url: None,
        branch: format!("v{}", pg18.postgresql.version),
        commit: pg18.postgresql.sha256,
        source_date_epoch: None,
        sha256: None,
        strip_prefix: None,
        origin: SourceOrigin::Generated,
    });

    let fingerprint = if let Some(fingerprint) = outputs.source_fingerprint.as_deref() {
        fingerprint.to_owned()
    } else {
        let fingerprint_path = outputs
            .source_dir
            .join(".oliphaunt-wasix-source-fingerprint");
        fs::read_to_string(&fingerprint_path)
            .with_context(|| format!("read {}", fingerprint_path.display()))?
            .trim()
            .to_owned()
    };
    let patch_fingerprint = fingerprint
        .trim()
        .rsplit(':')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("PG18 source fingerprint is invalid: {fingerprint:?}"))?;
    pins.push(SourcePin {
        name: "oliphaunt-wasix-stable-patches".to_owned(),
        kind: SourceKind::Git,
        url: "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches".to_owned(),
        mirror_url: None,
        branch: "series".to_owned(),
        commit: patch_fingerprint.to_owned(),
        source_date_epoch: None,
        sha256: None,
        strip_prefix: None,
        origin: SourceOrigin::Generated,
    });

    Ok(pins)
}

fn is_released_source_pin_for_pg18_manifest(source: &SourcePin) -> bool {
    source.name.contains("removed-fork")
        || source.branch.contains("removed-fork")
        || source.url.contains("removed-fork")
}

pub(crate) fn load_postgres_source_manifest() -> Result<PostgresSourceManifest> {
    let shared_path = repo_relative_path(POSTGRES_SHARED_SOURCE_MANIFEST_PATH);
    let product_path = repo_relative_path(POSTGRES_SOURCE_MANIFEST_PATH);
    let shared_text = fs::read_to_string(&shared_path)
        .with_context(|| format!("read {}", shared_path.display()))?;
    let product_text = fs::read_to_string(&product_path)
        .with_context(|| format!("read {}", product_path.display()))?;
    let shared: PostgresSharedSourceManifest =
        toml::from_str(&shared_text).with_context(|| format!("parse {}", shared_path.display()))?;
    let product: PostgresProductPatchManifest = toml::from_str(&product_text)
        .with_context(|| format!("parse {}", product_path.display()))?;
    Ok(PostgresSourceManifest {
        postgresql: shared.postgresql,
        patches: product.patches,
    })
}

pub(crate) fn repo_relative_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() || path.exists() {
        return path.to_path_buf();
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn source_pins_sha256(sources: &[SourcePin]) -> Result<String> {
    let pins = serde_json::to_vec(sources).context("serialize source pins")?;
    Ok(sha256_bytes(&pins))
}

fn postgres_catalog_version(source_dir: &Path) -> Result<String> {
    let path = source_dir.join("src/include/catalog/catversion.h");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#define CATALOG_VERSION_NO") {
            let value = rest.trim();
            if !value.is_empty() {
                return Ok(value.to_owned());
            }
        }
    }
    bail!("{} does not define CATALOG_VERSION_NO", path.display())
}

pub(crate) fn update_staged_root_asset_metadata(workspace: &Path) -> Result<()> {
    let asset_dir = workspace.join(GENERATED_ASSETS_DIR);
    let manifest = read_asset_manifest_from(&asset_dir)?;
    let runtime_archive = asset_dir.join(&manifest.runtime.archive);
    let runtime_module = archive_entry_bytes(&runtime_archive, "oliphaunt/bin/oliphaunt")?;
    update_root_asset_metadata_in(
        workspace,
        &asset_dir,
        &manifest,
        &sha256_bytes(&runtime_module),
    )
}

fn update_root_asset_metadata_in(
    workspace: &Path,
    asset_dir: &Path,
    manifest: &AssetManifestOut,
    runtime_module_sha256: &str,
) -> Result<()> {
    let path = workspace.join("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml");
    let tools_path = workspace.join("src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml");
    let mut text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let mut tools_text = fs::read_to_string(&tools_path)
        .with_context(|| format!("read {}", tools_path.display()))?;
    let pg18 = load_postgres_source_manifest()?;
    text = replace_metadata_value(text, "postgres-version", &manifest.runtime.postgres_version);
    text = replace_metadata_value(text, "postgres-source-url", &pg18.postgresql.url);
    text = replace_metadata_value(text, "postgres-source-sha256", &pg18.postgresql.sha256);
    text = replace_metadata_value(
        text,
        "postgres-patch-count",
        &pg18.patches.series.len().to_string(),
    );
    text = replace_metadata_value(text, "runtime-archive-sha256", &manifest.runtime.sha256);
    text = replace_metadata_value(text, "oliphaunt-wasix-sha256", runtime_module_sha256);
    let pgdata_template = asset_dir.join("prepopulated/pgdata-template.tar.zst");
    if pgdata_template.exists() {
        text = replace_metadata_value(
            text,
            "pgdata-template-archive-sha256",
            &sha256_file(&pgdata_template)?,
        );
    }
    if let Some(pg_dump) = &manifest.pg_dump {
        tools_text = replace_metadata_value(tools_text, "pg-dump-wasix-sha256", &pg_dump.sha256);
    }
    if let Some(psql) = &manifest.psql {
        tools_text = replace_metadata_value(tools_text, "psql-wasix-sha256", &psql.sha256);
    }
    if let Some(initdb) = &manifest.initdb {
        text = replace_metadata_value(text, "initdb-wasix-sha256", &initdb.sha256);
    }
    fs::write(&path, text).with_context(|| format!("write {}", path.display()))?;
    fs::write(&tools_path, tools_text).with_context(|| format!("write {}", tools_path.display()))
}

fn replace_metadata_value(mut text: String, key: &str, value: &str) -> String {
    let needle = format!("{key} = \"");
    let Some(start) = text.find(&needle) else {
        eprintln!("warning: Cargo.toml metadata key '{key}' is missing; not updating it");
        return text;
    };
    let value_start = start + needle.len();
    let Some(relative_end) = text[value_start..].find('"') else {
        return text;
    };
    text.replace_range(value_start..value_start + relative_end, value);
    text
}

fn ensure_matching_marker(expected: &str, actual_path: &Path, field: &str) -> Result<()> {
    let actual = fs::read_to_string(actual_path)
        .with_context(|| format!("read {}", actual_path.display()))?;
    ensure_eq(actual.trim(), expected, field)
}
