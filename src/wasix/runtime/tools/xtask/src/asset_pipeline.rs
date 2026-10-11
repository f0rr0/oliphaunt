use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssetProduct {
    Runtime,
    Tools,
    Extensions,
}

impl AssetProduct {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "runtime" => Ok(Self::Runtime),
            "tools" => Ok(Self::Tools),
            "extensions" => Ok(Self::Extensions),
            _ => bail!("unknown asset product {value:?}"),
        }
    }
    fn root(self) -> PathBuf {
        PathBuf::from(match self {
            Self::Runtime => "target/oliphaunt-wasix",
            Self::Tools => "target/postgres-tools/wasix",
            Self::Extensions => "target/extensions/wasix",
        })
    }
    fn owns(self, name: &str) -> bool {
        match self {
            Self::Runtime => {
                name.starts_with("runtime:")
                    || name.starts_with("runtime-support:")
                    || name == "tool:initdb"
            }
            Self::Tools => matches!(name, "tool:pg_dump" | "tool:psql"),
            Self::Extensions => name.starts_with("extension:"),
        }
    }
}

pub(crate) struct BuildOutputs {
    product: AssetProduct,
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

pub(crate) fn generated_assets_dir_for_source_lane(source_lane: &str) -> Result<&'static Path> {
    match canonical_source_lane(source_lane)? {
        "stable" => Ok(Path::new(GENERATED_ASSETS_DIR)),
        other => bail!("unsupported WASIX asset source lane {other:?}"),
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

impl BuildOutputs {
    pub(crate) fn discover_for_source_lane(source_lane: &str) -> Result<Self> {
        Self::discover_product(source_lane, AssetProduct::Runtime)
    }

    fn discover_product(source_lane: &str, product: AssetProduct) -> Result<Self> {
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
        if product == AssetProduct::Tools {
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
        if product == AssetProduct::Extensions {
            for extension in extension_catalog::extension_build_specs()? {
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
            product,
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
        Self::discover_product_for_aot(source_lane, AssetProduct::Runtime)
    }

    fn discover_product_for_aot(source_lane: &str, product: AssetProduct) -> Result<Self> {
        let canonical = canonical_source_lane(source_lane)?;
        if canonical == DEFAULT_SOURCE_LANE {
            return Self::discover_product(source_lane, product).or_else(|build_err| {
                eprintln!(
                    "warning: transient WASIX build tree unavailable for {source_lane} AOT packaging: {build_err:#}"
                );
                Self::from_packaged_assets_for_source_lane(source_lane, product)
            });
        }
        unreachable!("canonical_source_lane returned an unsupported lane: {canonical}")
    }

    fn from_packaged_assets_for_source_lane(
        source_lane: &str,
        product: AssetProduct,
    ) -> Result<Self> {
        let manifest_path = product.root().join("assets/manifest.json");
        let manifest: AssetManifestOut = serde_json::from_str(
            &fs::read_to_string(&manifest_path)
                .with_context(|| format!("read {}", manifest_path.display()))?,
        )?;
        ensure_packaged_asset_matches_source_lane(&manifest, source_lane)?;
        let canonical_source_lane = canonical_source_lane(source_lane)?;
        let base = product.root().join("aot-inputs");
        if base.exists() {
            fs::remove_dir_all(&base).with_context(|| format!("remove {}", base.display()))?;
        }
        fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;

        let assets_base = product.root().join("assets");
        let runtime_archive =
            generated_assets_dir_for_source_lane(source_lane)?.join(&manifest.runtime.archive);
        let runtime_path = base.join("runtime/oliphaunt");
        write_bytes_file(
            &runtime_path,
            &archive_entry_bytes(&runtime_archive, RUNTIME_MODULE_ARCHIVE_MEMBER)?,
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
            copy_file(
                &generated_assets_dir_for_source_lane(source_lane)?.join(&initdb.path),
                &path,
            )?;
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

        let declared = build_output_modules_from_asset_manifest(&manifest);
        for module in &modules {
            let expected = declared
                .iter()
                .find(|row| row.name == module.name)
                .ok_or_else(|| anyhow!("packaged manifest omits module {}", module.name))?;
            ensure_eq(
                &sha256_file(&module.path)?,
                &expected.sha256,
                &format!("packaged module {} sha256", module.name),
            )?;
        }

        Ok(Self {
            product,
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
            ensure_file(
                &self
                    .source_dir
                    .join(format!("src/backend/snowball/stopwords/{language}.stop")),
            )?;
        }
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

    fn manifest_path(&self) -> Result<PathBuf> {
        if self.product == AssetProduct::Runtime {
            Ok(build_output_manifest_path_for_source_lane(&self.source_lane)?.to_owned())
        } else {
            Ok(self.product.root().join("build-output-manifest.json"))
        }
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
        fs::write(&path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
    }
}

fn extension_build_module_path(
    build_dir: &Path,
    extension: &extension_catalog::ExtensionBuildSpec,
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
            "supported extension {} has unsupported build kind {other}",
            extension.sql_name
        ),
    }
}

fn pgxs_extension_build_dir(
    build_dir: &Path,
    extension: &extension_catalog::ExtensionBuildSpec,
) -> PathBuf {
    build_dir.join("pgxs").join(&extension.id)
}

fn extension_aot_file_stem(extension: &extension_catalog::ExtensionBuildSpec) -> String {
    extension.sql_name.replace('/', "_")
}

fn validate_module_link_metadata(module: &BuildModuleManifestOut) -> Result<()> {
    if module.link.exports.is_empty() {
        bail!("{} has no WASM exports", module.name);
    }

    match module.kind.as_str() {
        "runtime" => {
            let thread_spawn_imports = module
                .link
                .imports
                .iter()
                .filter(|import| is_thread_spawn_import(import))
                .map(|import| format!("{}.{}", import.module, import.name))
                .collect::<Vec<_>>();
            ensure!(
                thread_spawn_imports.is_empty(),
                "{} violates the single-backend contract with thread-spawn imports: {}",
                module.name,
                thread_spawn_imports.join(", ")
            );
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

fn is_thread_spawn_import(import: &WasmImportOut) -> bool {
    matches!(
        import.name.trim_start_matches('_'),
        "thread-spawn"
            | "thread_spawn"
            | "thread_spawn_v2"
            | "wasi_thread_spawn"
            | "wasi_thread_spawn_v2"
            | "pthread_create"
    )
}

fn validate_build_output_link_closure(outputs: &BuildOutputs) -> Result<()> {
    let runtime = outputs
        .modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_link = read_wasm_link_metadata(&runtime.path)?;
    validate_sealed_runtime_exports(&runtime_link)?;
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
    let side_module_basenames = side_module_basename_index(
        side_modules
            .iter()
            .map(|module| (module.name.as_str(), module.path.as_path())),
    )?;

    let mut failures = Vec::new();
    for module in side_modules {
        let link = side_module_links
            .get(&module.name)
            .ok_or_else(|| anyhow!("missing link metadata for {}", module.name))?;
        let provider_exports =
            side_module_provider_exports(&module.name, &side_module_links, &side_module_basenames)?;
        for import in &link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            if import_resolves_from_wasm_exports(import, &provider_exports, &module.name)? {
                continue;
            }
            if !import_resolves_from_wasm_exports(import, &runtime_link.exports, "runtime")? {
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

fn validate_sealed_runtime_exports(runtime: &WasmLinkMetadataOut) -> Result<()> {
    let policy_path = repo_relative_path("src/wasix/runtime/assets/generated/wasix-dl.exports");
    let policy = fs::read_to_string(&policy_path)
        .with_context(|| format!("read {}", policy_path.display()))?;
    validate_runtime_exports_from_policy(runtime, &policy)
}

fn validate_runtime_exports_from_policy(runtime: &WasmLinkMetadataOut, policy: &str) -> Result<()> {
    let mut expected = policy
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    expected.extend(
        WASIX_LINKER_RUNTIME_EXPORTS
            .iter()
            .map(|name| (*name).to_owned()),
    );
    let actual = runtime
        .exports
        .iter()
        .map(|export| export.name.clone())
        .collect::<BTreeSet<_>>();
    ensure_exact_runtime_export_surface(&actual, &expected)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredRuntimeManifestSpec {
    runtime: PathBuf,
    archive: PathBuf,
    initdb: PathBuf,
    export_policy: PathBuf,
    support: Vec<DeclaredRuntimeSupport>,
    source_fingerprint: String,
    postgres_version: String,
    sources: Vec<SourcePin>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredRuntimeSupport {
    name: String,
    path: String,
    source: PathBuf,
}

fn declared_manifest_args(args: &[String]) -> Result<(PathBuf, PathBuf)> {
    let mut spec = None;
    let mut output = None;
    let mut args = args.iter();
    while let Some(option) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| anyhow!("{option} requires a path"))?;
        ensure!(
            !value.is_empty() && !value.starts_with("--"),
            "{option} requires a path"
        );
        let field = match option.as_str() {
            "--spec" => &mut spec,
            "--output" => &mut output,
            _ => bail!("unknown declared-manifest option {option}"),
        };
        ensure!(
            field.replace(PathBuf::from(value)).is_none(),
            "duplicate {option}"
        );
    }
    let spec = spec.context("declared-manifest requires --spec")?;
    let output = output.context("declared-manifest requires --output")?;
    ensure!(
        spec != output,
        "manifest output must differ from specification input"
    );
    Ok((spec, output))
}

fn validate_declared_source_facts(
    source_fingerprint: &str,
    postgres_version: &str,
    sources: &[SourcePin],
) -> Result<()> {
    let fingerprint = source_fingerprint.split(':').collect::<Vec<_>>();
    let is_digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    ensure!(
        fingerprint.len() == 3 && is_digest(fingerprint[1]) && is_digest(fingerprint[2]),
        "invalid declared PostgreSQL source fingerprint"
    );
    ensure_eq(
        postgres_version,
        &format!("{}-wasix-oliphaunt", fingerprint[0]),
        "declared PostgreSQL version",
    )?;
    let names = sources
        .iter()
        .map(|source| source.name.as_str())
        .collect::<BTreeSet<_>>();
    ensure!(
        names.len() == sources.len(),
        "duplicate declared source pin"
    );
    let postgres = sources
        .iter()
        .find(|source| source.name == "postgresql")
        .context("declared sources require PostgreSQL")?;
    ensure_eq(
        &postgres.branch,
        &format!("v{}", fingerprint[0]),
        "declared PostgreSQL source branch",
    )?;
    ensure_eq(
        &postgres.commit,
        fingerprint[1],
        "declared PostgreSQL source digest",
    )?;
    let patches = sources
        .iter()
        .find(|source| source.name == "oliphaunt-wasix-stable-patches")
        .context("declared sources require WASIX patches")?;
    ensure_eq(
        &patches.commit,
        fingerprint[2],
        "declared PostgreSQL patch digest",
    )?;
    ensure_eq(
        &patches.url,
        POSTGRES_PATCH_SERIES_PATH,
        "declared PostgreSQL patch source",
    )?;
    Ok(())
}

fn declared_runtime_manifest(spec: DeclaredRuntimeManifestSpec) -> Result<AssetManifestOut> {
    validate_declared_source_facts(
        &spec.source_fingerprint,
        &spec.postgres_version,
        &spec.sources,
    )?;

    let runtime_link = read_wasm_link_metadata(&spec.runtime)?;
    validate_module_link_metadata(&BuildModuleManifestOut {
        name: "runtime:oliphaunt".to_owned(),
        kind: "runtime".to_owned(),
        path: String::new(),
        sha256: String::new(),
        link: runtime_link.clone(),
    })?;
    let policy = fs::read_to_string(&spec.export_policy)
        .with_context(|| format!("read {}", spec.export_policy.display()))?;
    validate_runtime_exports_from_policy(&runtime_link, &policy)?;

    let support_names = spec
        .support
        .iter()
        .map(|item| item.name.as_str())
        .collect::<BTreeSet<_>>();
    ensure!(
        support_names == BTreeSet::from(["plpgsql", "dict_snowball"])
            && support_names.len() == spec.support.len(),
        "declared runtime requires exactly plpgsql and dict_snowball support modules"
    );
    let mut runtime_support = Vec::new();
    for item in &spec.support {
        ensure_eq(
            &item.path,
            &format!("lib/postgresql/{}.so", item.name),
            "declared runtime support path",
        )?;
        let link = read_wasm_link_metadata(&item.source)?;
        validate_module_link_metadata(&BuildModuleManifestOut {
            name: format!("runtime-support:{}", item.name),
            kind: "runtime-support".to_owned(),
            path: item.path.clone(),
            sha256: String::new(),
            link: link.clone(),
        })?;
        let digest = sha256_file(&item.source)?;
        runtime_support.push(BinaryAssetOut {
            name: item.name.clone(),
            path: item.path.clone(),
            sha256: digest.clone(),
            module_sha256: digest,
            size: fs::metadata(&item.source)?.len(),
            link,
        });
    }
    let links = runtime_support
        .iter()
        .map(|item| (item.name.clone(), item.link.clone()))
        .collect::<BTreeMap<_, _>>();
    let basenames = side_module_basename_index(
        spec.support
            .iter()
            .map(|item| (item.name.as_str(), item.source.as_path())),
    )?;
    for item in &runtime_support {
        let providers = side_module_provider_exports(&item.name, &links, &basenames)?;
        for import in item
            .link
            .imports
            .iter()
            .filter(|import| import_should_resolve_from_runtime(import))
        {
            ensure!(
                import_resolves_from_wasm_exports(import, &providers, &item.name)?
                    || import_resolves_from_wasm_exports(import, &runtime_link.exports, "runtime")?,
                "declared runtime support {} has unresolved {}.{}",
                item.name,
                import.module,
                import.name
            );
        }
    }
    let initdb_link = read_wasm_link_metadata(&spec.initdb)?;
    validate_module_link_metadata(&BuildModuleManifestOut {
        name: "tool:initdb".to_owned(),
        kind: "tool".to_owned(),
        path: String::new(),
        sha256: String::new(),
        link: initdb_link.clone(),
    })?;
    let initdb_digest = sha256_file(&spec.initdb)?;
    Ok(AssetManifestOut {
        format_version: ASSET_MANIFEST_FORMAT_VERSION,
        source_lane: Some(DEFAULT_SOURCE_LANE.to_owned()),
        source_fingerprint: Some(spec.source_fingerprint),
        runtime: RuntimeAssetOut {
            archive: "oliphaunt.wasix.tar.zst".to_owned(),
            sha256: sha256_file(&spec.archive)?,
            module_sha256: sha256_file(&spec.runtime)?,
            postgres_version: spec.postgres_version,
            runtime_kind: "wasix-dynamic-main".to_owned(),
            link: runtime_link,
        },
        runtime_support,
        pg_dump: None,
        psql: None,
        initdb: Some(BinaryAssetOut {
            name: "initdb".to_owned(),
            path: "bin/initdb.wasix.wasm".to_owned(),
            sha256: initdb_digest.clone(),
            module_sha256: initdb_digest,
            size: fs::metadata(&spec.initdb)?.len(),
            link: initdb_link,
        }),
        extensions: Vec::new(),
        sources: spec.sources,
    })
}

/// Pure I/O assembly of the frozen consumer manifest from explicit native outputs.
pub(crate) fn generate_declared_wasix_manifest(args: &[String]) -> Result<()> {
    let (input, output) = declared_manifest_args(args)?;
    let bytes = fs::read(&input).with_context(|| format!("read {}", input.display()))?;
    let spec: DeclaredRuntimeManifestSpec =
        serde_json::from_slice(&bytes).context("parse declared runtime manifest specification")?;
    ensure!(
        output != spec.runtime
            && output != spec.archive
            && output != spec.initdb
            && output != spec.export_policy
            && spec.support.iter().all(|item| item.source != output),
        "manifest output must differ from all declared inputs"
    );
    let manifest = declared_runtime_manifest(spec)?;
    fs::write(
        &output,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )
    .with_context(|| format!("write {}", output.display()))?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredToolsManifestSpec {
    pg_dump: PathBuf,
    psql: PathBuf,
    version: String,
    runtime_version: String,
    source_fingerprint: String,
    postgres_version: String,
    sources: Vec<SourcePin>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeclaredToolsManifest {
    schema: String,
    version: String,
    runtime_version: String,
    source_fingerprint: String,
    pg_dump: DeclaredToolIdentity,
    psql: DeclaredToolIdentity,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct DeclaredToolIdentity {
    name: String,
    path: String,
    sha256: String,
    size: u64,
}

fn declared_tool_identity(name: &'static str, module: &Path) -> Result<DeclaredToolIdentity> {
    let link = read_wasm_link_metadata(module)?;
    validate_module_link_metadata(&BuildModuleManifestOut {
        name: format!("tool:{name}"),
        kind: "tool".to_owned(),
        path: String::new(),
        sha256: String::new(),
        link: link.clone(),
    })?;
    ensure!(
        link.dylink_needed.is_empty() && has_wasm_export(&link, "_start"),
        "declared {name} must be a standalone WASIX command"
    );
    Ok(DeclaredToolIdentity {
        name: name.to_owned(),
        path: format!("bin/{name}.wasix.wasm"),
        sha256: sha256_file(module)?,
        size: fs::metadata(module)?.len(),
    })
}

/// Package identity for the two physical commands, without requiring the core runtime.
pub(crate) fn generate_declared_tools_manifest(args: &[String]) -> Result<()> {
    let (input, output) = declared_manifest_args(args)?;
    let spec: DeclaredToolsManifestSpec = serde_json::from_slice(&fs::read(&input)?)
        .context("parse declared tools manifest specification")?;
    ensure!(
        output != spec.pg_dump && output != spec.psql,
        "tools manifest output must differ from all declared inputs"
    );
    validate_declared_source_facts(
        &spec.source_fingerprint,
        &spec.postgres_version,
        &spec.sources,
    )?;
    for version in [&spec.version, &spec.runtime_version] {
        let parts = version.split('.').collect::<Vec<_>>();
        ensure!(
            parts.len() == 3
                && parts.iter().all(|part| !part.is_empty()
                    && (part.len() == 1 || !part.starts_with('0'))
                    && part.bytes().all(|byte| byte.is_ascii_digit())),
            "declared tools require stable semantic product/runtime versions"
        );
    }
    let manifest = DeclaredToolsManifest {
        schema: "postgres-tools-wasix-portable-v1".to_owned(),
        pg_dump: declared_tool_identity("pg_dump", &spec.pg_dump)?,
        psql: declared_tool_identity("psql", &spec.psql)?,
        version: spec.version,
        runtime_version: spec.runtime_version,
        source_fingerprint: spec.source_fingerprint,
    };
    fs::write(
        &output,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )
    .with_context(|| format!("write {}", output.display()))?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredAotManifestSpec {
    portable_manifest: PathBuf,
    toolchain: PathBuf,
    target_triple: String,
    artifacts: Vec<DeclaredAotArtifact>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredAotArtifact {
    name: String,
    path: String,
    image: PathBuf,
    module: PathBuf,
}

struct DeclaredAotModules {
    source_lane: Option<String>,
    source_fingerprint: Option<String>,
    postgres_version: String,
    modules: BTreeMap<String, String>,
    paths: BTreeMap<String, String>,
}

fn declared_aot_modules(file: &Path) -> Result<DeclaredAotModules> {
    let bytes = fs::read(file)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    if value.get("schema").is_some() {
        let portable: DeclaredToolsManifest =
            serde_json::from_slice(&bytes).context("parse declared portable tools manifest")?;
        ensure!(
            portable.schema == "postgres-tools-wasix-portable-v1",
            "declared AOT requires the canonical portable tools manifest"
        );
        for version in [&portable.version, &portable.runtime_version] {
            let parts = version.split('.').collect::<Vec<_>>();
            ensure!(
                parts.len() == 3
                    && parts.iter().all(|part| !part.is_empty()
                        && (part.len() == 1 || !part.starts_with('0'))
                        && part.bytes().all(|byte| byte.is_ascii_digit())),
                "declared tools AOT requires stable product and runtime versions"
            );
        }
        let fingerprint = portable.source_fingerprint;
        let parts = fingerprint.split(':').collect::<Vec<_>>();
        ensure!(
            parts.len() == 3
                && !parts[0].is_empty()
                && parts[1..].iter().all(|part| part.len() == 64
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())),
            "declared tools AOT requires the portable source fingerprint"
        );
        let postgres_version = parts[0].to_owned();
        let mut modules = BTreeMap::new();
        let mut paths = BTreeMap::new();
        for (name, identity) in [("pg_dump", portable.pg_dump), ("psql", portable.psql)] {
            ensure!(
                identity.name == name
                    && identity.path == format!("bin/{name}.wasix.wasm")
                    && identity.size > 0
                    && identity.sha256.len() == 64
                    && identity
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
                "declared tools AOT requires canonical physical command identities"
            );
            let key = format!("tool:{name}");
            modules.insert(key.clone(), identity.sha256);
            paths.insert(key, format!("{name}-llvm-opta.bin.zst"));
        }
        return Ok(DeclaredAotModules {
            source_lane: Some(DEFAULT_SOURCE_LANE.to_owned()),
            source_fingerprint: Some(fingerprint),
            postgres_version,
            modules,
            paths,
        });
    }
    let portable: AssetManifestOut =
        serde_json::from_slice(&bytes).context("parse declared portable runtime manifest")?;
    ensure!(
        portable.format_version == ASSET_MANIFEST_FORMAT_VERSION
            && portable.runtime.runtime_kind == "wasix-dynamic-main"
            && portable.extensions.is_empty()
            && portable.pg_dump.is_none()
            && portable.psql.is_none(),
        "declared AOT requires the portable core runtime manifest"
    );
    ensure!(
        portable.source_lane.as_deref() == Some(DEFAULT_SOURCE_LANE)
            && portable
                .source_fingerprint
                .as_ref()
                .is_some_and(|value| !value.is_empty()),
        "declared AOT requires the portable source lane and fingerprint"
    );
    let mut modules = BTreeMap::from([(
        "runtime:oliphaunt".to_owned(),
        portable.runtime.module_sha256.clone(),
    )]);
    let initdb = portable
        .initdb
        .as_ref()
        .context("portable manifest has no initdb")?;
    modules.insert("tool:initdb".to_owned(), initdb.module_sha256.clone());
    for support in &portable.runtime_support {
        ensure!(
            modules
                .insert(
                    format!("runtime-support:{}", support.name),
                    support.module_sha256.clone()
                )
                .is_none(),
            "duplicate portable runtime support module"
        );
    }
    let paths = BTreeMap::from(
        [
            ("runtime:oliphaunt", "oliphaunt-llvm-opta.bin.zst"),
            ("tool:initdb", "initdb-llvm-opta.bin.zst"),
            ("runtime-support:plpgsql", "plpgsql-llvm-opta.bin.zst"),
            (
                "runtime-support:dict_snowball",
                "dict_snowball-llvm-opta.bin.zst",
            ),
        ]
        .map(|(name, path)| (name.to_owned(), path.to_owned())),
    );
    ensure!(
        modules.keys().collect::<BTreeSet<_>>() == paths.keys().collect::<BTreeSet<_>>(),
        "portable manifest must contain exactly the four runtime AOT modules"
    );
    Ok(DeclaredAotModules {
        source_lane: portable.source_lane,
        source_fingerprint: portable.source_fingerprint,
        postgres_version: portable.runtime.postgres_version,
        modules,
        paths,
    })
}

fn declared_aot_manifest(spec: DeclaredAotManifestSpec) -> Result<AotManifest> {
    // Admission of the exact target is owned by the canonical Bazel target
    // projection. This I/O boundary still rejects empty or path-like triples.
    ensure!(
        spec.target_triple.split('-').count() >= 3
            && spec.target_triple.split('-').all(|part| !part.is_empty())
            && spec
                .target_triple
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "invalid declared AOT target triple"
    );
    let portable = declared_aot_modules(&spec.portable_manifest)?;
    let toolchain: WasixToolchainManifest = toml::from_str(&fs::read_to_string(&spec.toolchain)?)
        .context("parse declared WASIX toolchain manifest")?;
    ensure!(
        !toolchain.toolchain.wasmer.is_empty() && !toolchain.toolchain.wasmer_wasix.is_empty(),
        "declared AOT requires pinned Wasmer versions"
    );
    let mut seen = BTreeSet::new();
    let mut artifacts = Vec::new();
    for item in &spec.artifacts {
        let expected_path = portable
            .paths
            .get(item.name.as_str())
            .context("unknown declared AOT module")?;
        ensure!(
            seen.insert(item.name.as_str()),
            "duplicate declared AOT module"
        );
        ensure_eq(&item.path, expected_path, "declared AOT artifact path")?;
        let module_sha256 = sha256_file(&item.module)?;
        ensure_eq(
            &module_sha256,
            &portable.modules[&item.name],
            "declared AOT portable module digest",
        )?;
        let raw = decode_zstd_file(&item.image)?;
        ensure!(!raw.is_empty(), "declared AOT image is empty");
        artifacts.push(AotManifestArtifact {
            name: item.name.clone(),
            path: item.path.clone(),
            sha256: sha256_file(&item.image)?,
            raw_sha256: sha256_bytes(&raw),
            raw_size: raw.len() as u64,
            module_sha256,
            compressed: true,
        });
    }
    ensure!(
        seen == portable
            .paths
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        "declared AOT requires every portable image"
    );
    artifacts.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(AotManifest {
        format_version: AOT_MANIFEST_FORMAT_VERSION,
        source_lane: portable.source_lane,
        source_fingerprint: portable.source_fingerprint,
        postgres_version: Some(portable.postgres_version),
        target_triple: spec.target_triple,
        engine: "llvm-opta".to_owned(),
        wasmer_version: toolchain.toolchain.wasmer,
        wasmer_wasix_version: toolchain.toolchain.wasmer_wasix,
        artifacts,
    })
}

/// Describe physical native serializer outputs without discovering a checkout.
pub(crate) fn generate_declared_aot_manifest(args: &[String]) -> Result<()> {
    let (input, output) = declared_manifest_args(args)?;
    let spec: DeclaredAotManifestSpec = serde_json::from_slice(&fs::read(&input)?)
        .context("parse declared AOT manifest specification")?;
    ensure!(
        output != spec.portable_manifest
            && output != spec.toolchain
            && spec
                .artifacts
                .iter()
                .all(|item| output != item.image && output != item.module),
        "AOT manifest output must differ from all declared inputs"
    );
    let manifest = declared_aot_manifest(spec)?;
    fs::write(
        &output,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )
    .with_context(|| format!("write {}", output.display()))?;
    Ok(())
}

fn ensure_exact_runtime_export_surface(
    actual: &BTreeSet<String>,
    expected: &BTreeSet<String>,
) -> Result<()> {
    let missing = expected.difference(actual).cloned().collect::<Vec<_>>();
    let unexpected = actual.difference(expected).cloned().collect::<Vec<_>>();
    ensure!(
        missing.is_empty() && unexpected.is_empty(),
        "sealed WASIX runtime export surface differs: missing={missing:?} unexpected={unexpected:?}"
    );
    Ok(())
}

fn side_module_provider_exports(
    module_name: &str,
    links_by_name: &BTreeMap<String, WasmLinkMetadataOut>,
    names_by_basename: &BTreeMap<String, String>,
) -> Result<Vec<WasmExportOut>> {
    let mut provider_names = BTreeSet::from([module_name.to_owned()]);
    let mut pending = vec![module_name.to_owned()];
    while let Some(name) = pending.pop() {
        let link = links_by_name
            .get(&name)
            .ok_or_else(|| anyhow!("missing side-module link metadata for {name}"))?;
        for needed in &link.dylink_needed {
            let dependency = names_by_basename.get(needed).ok_or_else(|| {
                anyhow!("{name} declares missing WASIX dynamic dependency {needed}")
            })?;
            if provider_names.insert(dependency.clone()) {
                pending.push(dependency.clone());
            }
        }
    }
    Ok(provider_names
        .into_iter()
        .flat_map(|name| {
            links_by_name
                .get(&name)
                .into_iter()
                .flat_map(|link| link.exports.iter().cloned())
        })
        .collect())
}

fn side_module_basename_index<'a>(
    modules: impl IntoIterator<Item = (&'a str, &'a Path)>,
) -> Result<BTreeMap<String, String>> {
    let mut names_by_basename = BTreeMap::new();
    for (name, path) in modules {
        let basename = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("side-module {name} path has no UTF-8 basename"))?;
        if let Some(previous) = names_by_basename.insert(basename.to_owned(), name.to_owned()) {
            bail!("WASIX side modules {previous} and {name} share dynamic basename {basename}");
        }
    }
    Ok(names_by_basename)
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
        let path = Path::new("src/wasix/runtime/assets/generated/wasix-dl.exports");
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
    let path = Path::new("src/wasix/runtime/assets/generated/wasix-dl.exports");
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

fn wasix_export_list_text(source_lane: &str) -> Result<String> {
    for manifest_path in [Path::new(
        "target/extensions/wasix/build-output-manifest.json",
    )] {
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
    let asset_dir = Path::new("target/extensions/wasix/assets");
    if asset_dir.join("manifest.json").exists() {
        let manifest: AssetManifestOut =
            serde_json::from_str(&fs::read_to_string(asset_dir.join("manifest.json"))?)?;
        if ensure_packaged_asset_matches_source_lane(&manifest, source_lane).is_ok() {
            let modules = build_output_modules_from_asset_manifest(&manifest);
            return wasix_export_list_from_modules(&modules);
        }
        eprintln!(
            "warning: ignoring generated asset manifest for PostgreSQL {} while generating export list for {source_lane}",
            manifest.runtime.postgres_version
        );
    }

    let outputs = BuildOutputs::discover_product(source_lane, AssetProduct::Extensions)?;
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

pub(crate) fn read_asset_manifest_from(asset_dir: &Path) -> Result<AssetManifestOut> {
    let path = asset_dir.join("manifest.json");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    ensure!(
        manifest.format_version == ASSET_MANIFEST_FORMAT_VERSION,
        "{} must use WASIX asset manifest format {}",
        path.display(),
        ASSET_MANIFEST_FORMAT_VERSION,
    );
    Ok(manifest)
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

    let _runtime = modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let side_modules = modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
        .collect::<Vec<_>>();
    wasix_export_list_from_side_modules(&side_modules)
}

fn wasix_export_list_from_side_modules(side_modules: &[&BuildModuleManifestOut]) -> Result<String> {
    let side_module_links = side_modules
        .iter()
        .map(|module| (module.name.clone(), module.link.clone()))
        .collect::<BTreeMap<_, _>>();
    let side_module_basenames = side_module_basename_index(
        side_modules
            .iter()
            .map(|module| (module.name.as_str(), Path::new(&module.path))),
    )?;
    let mut required_exports = BTreeSet::<String>::new();

    for &abi_export in required_runtime_abi_exports() {
        required_exports.insert(abi_export.to_owned());
    }

    for module in side_modules {
        let module_exports =
            side_module_provider_exports(&module.name, &side_module_links, &side_module_basenames)?;
        for import in &module.link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            if import_resolves_from_wasm_exports(import, &module_exports, &module.name)? {
                continue;
            }
            // The strict final link proves that the runtime defines every policy symbol. Do not
            // consult the previously sealed runtime here: doing so would make adding a new side
            // module import impossible without first restoring an ambient export surface.
            required_exports.insert(runtime_export_name_for_side_import(import));
        }
    }

    Ok(required_exports.into_iter().collect::<Vec<_>>().join("\n") + "\n")
}

#[derive(Debug, PartialEq, Eq)]
struct DeclaredExportPolicyArgs {
    modules: Vec<(String, PathBuf)>,
    output: PathBuf,
    response: PathBuf,
}

fn declared_export_policy_args(args: &[String]) -> Result<DeclaredExportPolicyArgs> {
    let mut modules = BTreeMap::new();
    let mut output = None;
    let mut response = None;
    let mut args = args.iter();
    while let Some(option) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| anyhow!("{option} requires a value"))?;
        ensure!(
            !value.is_empty() && !value.starts_with("--"),
            "{option} requires a value"
        );
        match option.as_str() {
            "--module" => {
                let (name, path) = value
                    .split_once('=')
                    .ok_or_else(|| anyhow!("--module requires name=path"))?;
                ensure!(
                    !name.is_empty() && !path.is_empty(),
                    "--module requires name=path"
                );
                ensure!(
                    modules
                        .insert(name.to_owned(), PathBuf::from(path))
                        .is_none(),
                    "duplicate module {name}"
                );
            }
            "--output" => {
                ensure!(
                    output.replace(PathBuf::from(value)).is_none(),
                    "duplicate --output"
                );
            }
            "--response" => {
                ensure!(
                    response.replace(PathBuf::from(value)).is_none(),
                    "duplicate --response"
                );
            }
            _ => bail!("unknown export-policy option {option}"),
        }
    }
    let output = output.ok_or_else(|| anyhow!("export-policy requires --output"))?;
    let response = response.ok_or_else(|| anyhow!("export-policy requires --response"))?;
    ensure!(
        output != response,
        "policy and response outputs must differ"
    );
    ensure!(
        modules
            .values()
            .all(|path| path != &output && path != &response),
        "policy outputs must differ from module inputs"
    );
    Ok(DeclaredExportPolicyArgs {
        modules: modules.into_iter().collect(),
        output,
        response,
    })
}

/// Analyze only explicitly declared modules; this command never discovers or builds assets.
pub(crate) fn generate_declared_wasix_export_policy(args: &[String]) -> Result<()> {
    let args = declared_export_policy_args(args)?;
    let modules = args
        .modules
        .iter()
        .map(|(name, path)| {
            let module = BuildModuleManifestOut {
                name: name.clone(),
                kind: "runtime-support".to_owned(),
                path: path
                    .to_str()
                    .ok_or_else(|| anyhow!("module path must be UTF-8"))?
                    .to_owned(),
                sha256: String::new(),
                link: read_wasm_link_metadata(path)?,
            };
            validate_module_link_metadata(&module)?;
            Ok(module)
        })
        .collect::<Result<Vec<_>>>()?;
    let policy = wasix_export_list_from_side_modules(&modules.iter().collect::<Vec<_>>())?;
    let response = policy
        .lines()
        .map(|symbol| {
            ensure!(
                symbol
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| byte.is_ascii_alphabetic()
                        || byte == b'_'
                        || (index > 0
                            && (byte.is_ascii_digit()
                                || byte == b'.'
                                || byte == b'$'
                                || byte == b'@'))),
                "invalid linker export symbol {symbol:?}"
            );
            Ok(format!("--export={symbol}\n"))
        })
        .collect::<Result<String>>()?;
    fs::write(&args.output, policy).with_context(|| format!("write {}", args.output.display()))?;
    fs::write(&args.response, response)
        .with_context(|| format!("write {}", args.response.display()))?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredExtensionLinkSpec {
    sql_name: String,
    runtime: PathBuf,
    runtime_manifest: PathBuf,
    modules: Vec<DeclaredExtensionModule>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredExtensionModule {
    name: String,
    path: PathBuf,
    runtime_path: String,
}

/// Resolve one declared extension's physical side-module closure against its core.
pub(crate) fn generate_declared_extension_link(args: &[String]) -> Result<()> {
    let (input, output) = declared_manifest_args(args)?;
    let spec: DeclaredExtensionLinkSpec = serde_json::from_slice(&fs::read(&input)?)?;
    ensure!(
        !spec.sql_name.is_empty()
            && spec
                .sql_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "invalid declared extension SQL name"
    );
    ensure!(
        output != spec.runtime
            && output != spec.runtime_manifest
            && spec.modules.iter().all(|module| output != module.path),
        "extension link output must differ from its declared inputs"
    );
    let portable: AssetManifestOut = serde_json::from_slice(&fs::read(&spec.runtime_manifest)?)?;
    ensure!(
        portable.format_version == ASSET_MANIFEST_FORMAT_VERSION
            && portable.runtime.runtime_kind == "wasix-dynamic-main"
            && portable.source_lane.as_deref() == Some(DEFAULT_SOURCE_LANE),
        "extension link requires its canonical portable runtime manifest"
    );
    ensure_eq(
        &sha256_file(&spec.runtime)?,
        &portable.runtime.module_sha256,
        "extension core module digest",
    )?;
    let runtime_link = read_wasm_link_metadata(&spec.runtime)?;
    ensure!(
        serde_json::to_value(&runtime_link)? == serde_json::to_value(&portable.runtime.link)?,
        "extension core link metadata differs from its physical module"
    );
    let mut links = BTreeMap::new();
    let mut runtime_paths = BTreeSet::new();
    let mut native_modules = Vec::new();
    for module in &spec.modules {
        ensure!(
            module.runtime_path
                == format!(
                    "lib/postgresql/{}",
                    module
                        .path
                        .file_name()
                        .context("extension module filename")?
                        .to_str()
                        .context("extension module filename UTF-8")?
                ),
            "extension module has a noncanonical runtime destination"
        );
        ensure!(
            runtime_paths.insert(&module.runtime_path),
            "duplicate extension module destination"
        );
        let link = read_wasm_link_metadata(&module.path)?;
        validate_module_link_metadata(&BuildModuleManifestOut {
            name: module.name.clone(),
            kind: "extension".to_owned(),
            path: module.path.display().to_string(),
            sha256: String::new(),
            link: link.clone(),
        })?;
        ensure!(
            links.insert(module.name.clone(), link).is_none(),
            "duplicate extension module name"
        );
        let digest = sha256_file(&module.path)?;
        native_modules.push(serde_json::json!({"name": module.name, "path": module.runtime_path, "sha256": digest, "moduleSha256": digest, "size": fs::metadata(&module.path)?.len()}));
    }
    ensure!(
        links.contains_key(&spec.sql_name),
        "extension closure has no primary SQL module"
    );
    let basenames = side_module_basename_index(
        spec.modules
            .iter()
            .map(|module| (module.name.as_str(), module.path.as_path())),
    )?;
    let mut required = BTreeSet::new();
    for module in &spec.modules {
        let providers = side_module_provider_exports(&module.name, &links, &basenames)?;
        for import in &links[&module.name].imports {
            if !import_should_resolve_from_runtime(import)
                || import_resolves_from_wasm_exports(import, &providers, &module.name)?
            {
                continue;
            }
            let name = resolved_wasm_export_name(import, &runtime_link.exports, "runtime")?
                .ok_or_else(|| {
                    anyhow!(
                        "extension {} has unresolved import {}.{} ({})",
                        module.name,
                        import.module,
                        import.name,
                        import.kind
                    )
                })?;
            required.insert(name);
        }
    }
    native_modules.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    let result = serde_json::json!({"schema": "oliphaunt-declared-wasix-extension-link-v1", "sqlName": spec.sql_name,
        "nativeModules": native_modules, "coreExportsRequired": required, "unresolvedImports": [], "moduleLinkMetadata": links,
        "sourceFingerprint": portable.source_fingerprint.context("extension core source fingerprint")?, "postgresVersion": portable.runtime.postgres_version});
    fs::write(
        output,
        format!("{}\n", serde_json::to_string_pretty(&result)?),
    )?;
    Ok(())
}

pub(crate) fn required_runtime_abi_exports() -> &'static [&'static str] {
    REQUIRED_RUNTIME_ABI_EXPORTS
}

const WASIX_LINKER_RUNTIME_EXPORTS: &[&str] = &[
    "__data_end",
    "__tls_align",
    "__tls_base",
    "__tls_size",
    "__wasm_apply_data_relocs",
    "__wasm_call_ctors",
    "__wasm_init_tls",
    "__wasm_sigaction",
    "__wasm_signal",
    "wasi_thread_start",
];

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

fn import_resolves_from_wasm_exports(
    import: &WasmImportOut,
    exports: &[WasmExportOut],
    provider: &str,
) -> Result<bool> {
    Ok(resolved_wasm_export_name(import, exports, provider)?.is_some())
}

fn resolved_wasm_export_name(
    import: &WasmImportOut,
    exports: &[WasmExportOut],
    provider: &str,
) -> Result<Option<String>> {
    let mut candidates = exports
        .iter()
        .filter(|export| export.name == import.name)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        let normalized = import.name.trim_start_matches('_');
        candidates = exports
            .iter()
            .filter(|export| export.name.trim_start_matches('_') == normalized)
            .collect();
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let expected_kind = match import.module.as_str() {
        "GOT.func" => "func",
        "GOT.mem" => "global",
        _ => import.kind.as_str(),
    };
    ensure!(
        candidates.iter().any(|export| export.kind == expected_kind),
        "{provider} provides {}.{} as {:?}, expected {expected_kind}",
        import.module,
        import.name,
        candidates
            .iter()
            .map(|export| export.kind.as_str())
            .collect::<BTreeSet<_>>()
    );
    Ok(candidates
        .into_iter()
        .find(|export| export.kind == expected_kind)
        .map(|export| export.name.clone()))
}

fn runtime_export_name_for_side_import(import: &WasmImportOut) -> String {
    import.name.clone()
}

fn extension_asset_provider_exports(
    primary_link: &WasmLinkMetadataOut,
    primary_path: &Path,
    sql_name: &str,
    native_modules: &[OwnedExtensionNativeModule],
    native_module_links: &BTreeMap<String, WasmLinkMetadataOut>,
) -> Result<Vec<WasmExportOut>> {
    let root_name = format!("extension:{sql_name}");
    let mut links = BTreeMap::from([(root_name.clone(), primary_link.clone())]);
    let mut paths = vec![(root_name.as_str(), primary_path)];
    let mut dependency_names = Vec::new();
    for module in native_modules {
        if module.name == sql_name {
            continue;
        }
        let name = format!("extension:{sql_name}:{}", module.name);
        let link = native_module_links
            .get(&module.name)
            .ok_or_else(|| anyhow!("missing link metadata for {name}"))?;
        links.insert(name.clone(), link.clone());
        dependency_names.push((name, module.path.as_path()));
    }
    paths.extend(
        dependency_names
            .iter()
            .map(|(name, path)| (name.as_str(), *path)),
    );
    let basenames = side_module_basename_index(paths)?;
    side_module_provider_exports(&root_name, &links, &basenames)
}

fn has_wasm_export(link: &WasmLinkMetadataOut, name: &str) -> bool {
    link.exports
        .iter()
        .any(|export| export.name == name || export.name == format!("_{name}"))
}

pub(crate) fn prepare_aot_artifacts(
    target: &str,
    source_lane: &str,
    product: AssetProduct,
) -> Result<()> {
    ensure_supported_aot_target(target)?;
    let outputs = BuildOutputs::discover_product_for_aot(source_lane, product)?;
    let source_dir = outputs.product.root().join("aot-source").join(target);
    if source_dir.exists() {
        fs::remove_dir_all(&source_dir)
            .with_context(|| format!("remove {}", source_dir.display()))?;
    }
    fs::create_dir_all(&source_dir).with_context(|| format!("create {}", source_dir.display()))?;

    for module in outputs
        .modules
        .iter()
        .filter(|module| module.requires_aot && product.owns(&module.name))
    {
        let output = source_dir.join(&module.aot_file);
        let input = fs::canonicalize(&module.path)
            .with_context(|| format!("canonicalize {}", module.path.display()))?;
        let input = input.to_str().context("AOT input path is not UTF-8")?;
        let output = output.to_str().context("AOT output path is not UTF-8")?;
        ensure!(
            !input.contains(['\t', '\r', '\n']) && !output.contains(['\t', '\r', '\n']),
            "AOT paths must not contain control delimiters"
        );
        println!("{input}\t{output}");
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
    product: AssetProduct,
) -> Result<()> {
    let outputs = BuildOutputs::discover_product_for_aot(source_lane, product)?;
    package_aot_artifacts(target, &outputs, manifest)?;
    check_aot_product_manifest(target, source_lane, product)
}

pub(crate) fn package_assets(
    manifest: &SourcesManifest,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    package_assets_with_options(manifest, target, true, source_lane, AssetProduct::Runtime)
}

pub(crate) fn package_assets_without_aot(
    manifest: &SourcesManifest,
    source_lane: &str,
) -> Result<()> {
    package_assets_with_options(
        manifest,
        host_target_triple(),
        false,
        source_lane,
        AssetProduct::Runtime,
    )
}

pub(crate) fn package_product_assets(
    manifest: &SourcesManifest,
    source_lane: &str,
    product: AssetProduct,
) -> Result<()> {
    package_assets_with_options(manifest, host_target_triple(), false, source_lane, product)
}

fn package_assets_with_options(
    manifest: &SourcesManifest,
    target: &str,
    include_aot: bool,
    source_lane: &str,
    product: AssetProduct,
) -> Result<()> {
    let outputs = BuildOutputs::discover_product(source_lane, product)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    let build = &outputs.build_dir;
    let source = &outputs.source_dir;
    let stage_path = if product == AssetProduct::Runtime {
        outputs.package_stage.clone()
    } else {
        product.root().join("package-stage")
    };
    let stage = &stage_path;

    if stage.exists() {
        fs::remove_dir_all(stage).with_context(|| format!("remove {}", stage.display()))?;
    }
    fs::create_dir_all(stage).with_context(|| format!("create {}", stage.display()))?;

    let runtime_stage = stage.join("runtime/oliphaunt");
    if product == AssetProduct::Runtime {
        stage_runtime_tree(build, source, &runtime_stage)?;
    }
    let assets_path = product.root().join("assets");
    let assets_dir = &assets_path;
    if assets_dir.exists() {
        fs::remove_dir_all(assets_dir)
            .with_context(|| format!("remove {}", assets_dir.display()))?;
    }
    fs::create_dir_all(assets_dir).with_context(|| format!("create {}", assets_dir.display()))?;
    let runtime_archive =
        generated_assets_dir_for_source_lane(source_lane)?.join("oliphaunt.wasix.tar.zst");
    if product == AssetProduct::Runtime {
        deterministic_tar_zst(&runtime_stage, Path::new("oliphaunt"), &runtime_archive)?;
    }

    let pg_dump = if product != AssetProduct::Tools {
        None
    } else {
        let pg_dump = assets_dir.join("bin/pg_dump.wasix.wasm");
        copy_file(outputs.module_path("tool:pg_dump")?, &pg_dump)?;
        Some(pg_dump)
    };
    let psql = if product != AssetProduct::Tools {
        None
    } else {
        let psql = assets_dir.join("bin/psql.wasix.wasm");
        copy_file(outputs.module_path("tool:psql")?, &psql)?;
        Some(psql)
    };
    let initdb = generated_assets_dir_for_source_lane(source_lane)?.join("bin/initdb.wasix.wasm");
    if product == AssetProduct::Runtime {
        copy_file(outputs.module_path("tool:initdb")?, &initdb)?;
    }

    let extension_artifacts = if product == AssetProduct::Extensions {
        build_extension_artifacts(source, build, stage, assets_dir, &outputs)?
    } else {
        Vec::new()
    };
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
        })
        .collect::<Vec<_>>();

    if include_aot {
        package_aot_artifacts(target, &outputs, manifest)?;
    }
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

    if product == AssetProduct::Extensions {
        verify_generated_extension_surface()?;
        check_generated_wasix_export_list(true)?;
    }
    println!("packaged {product:?} assets into {}", assets_dir.display());
    if include_aot {
        println!("packaged {target} AOT artifacts");
    } else {
        println!("skipped {target} AOT artifact packaging by request");
    }
    Ok(())
}

pub(crate) fn stage_compiler_runtime(source_lane: &str) -> Result<()> {
    let outputs = BuildOutputs::discover_for_source_lane(source_lane)?;
    let install = Path::new(WASIX_POSTGRES_GENERATED_BUILD_DIR).join("install");
    if install.exists() {
        fs::remove_dir_all(&install).with_context(|| format!("remove {}", install.display()))?;
    }
    stage_runtime_tree(&outputs.build_dir, &outputs.source_dir, &install)
}

fn build_extension_artifacts(
    source: &Path,
    build: &Path,
    stage: &Path,
    assets_dir: &Path,
    outputs: &BuildOutputs,
) -> Result<Vec<OwnedExtensionArtifact>> {
    let mut packages = Vec::new();
    for extension in extension_catalog::extension_build_specs()? {
        let extension_stage = stage.join("extensions").join(&extension.sql_name);
        stage_extension(source, build, &extension, &extension_stage)?;
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
        });
    }
    Ok(packages)
}

fn extension_native_module_artifacts(
    extension: &extension_catalog::ExtensionBuildSpec,
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

fn stage_extension(
    source: &Path,
    build: &Path,
    extension: &extension_catalog::ExtensionBuildSpec,
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
            "supported extension {} has unsupported packaging build kind {other}",
            extension.sql_name
        ),
    }
}

fn stage_recipe_staged_extension(
    build: &Path,
    extension: &extension_catalog::ExtensionBuildSpec,
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
    extension: &extension_catalog::ExtensionBuildSpec,
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
    extension: &extension_catalog::ExtensionBuildSpec,
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
        &source.join("src/backend/snowball/stopwords"),
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
    let source_dir = outputs.product.root().join("aot-source").join(target);
    if !source_dir.exists() {
        let source_lane_arg = if outputs.source_lane == DEFAULT_SOURCE_LANE {
            String::new()
        } else {
            format!(" --source-lane {}", outputs.source_lane)
        };
        bail!(
            "AOT source directory {} is missing; run `bash src/wasix/runtime/tools/serialize-aot.sh --target-triple {target}{source_lane_arg}` before packaging",
            source_dir.display()
        );
    }

    let artifacts_dir = outputs.product.root().join("aot").join(target);
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
        .filter(|module| module.requires_aot && outputs.product.owns(&module.name))
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
        format_version: AOT_MANIFEST_FORMAT_VERSION,
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
    let outputs = BuildOutputs::discover_product_for_aot(source_lane, AssetProduct::Extensions)?;
    let source_dir = outputs.product.root().join("aot-source").join(target);
    if !source_dir.exists() {
        let source_lane_arg = if outputs.source_lane == DEFAULT_SOURCE_LANE {
            String::new()
        } else {
            format!(" --source-lane {}", outputs.source_lane)
        };
        bail!(
            "AOT source directory {} is missing; run `bash src/wasix/runtime/tools/serialize-aot.sh --target-triple {target}{source_lane_arg}` before packaging extension AOT artifacts",
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
            format_version: AOT_MANIFEST_FORMAT_VERSION,
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
    check_aot_product_manifest(target, source_lane, AssetProduct::Runtime)
}

pub(crate) fn check_aot_product_manifest(
    target: &str,
    source_lane: &str,
    product: AssetProduct,
) -> Result<()> {
    let sources = load_wasix_toolchain_manifest()?;
    let outputs = BuildOutputs::discover_product_for_aot(source_lane, product)?;
    let artifacts_dir = product.root().join("aot").join(target);
    let manifest_path = artifacts_dir.join("manifest.json");
    ensure_file(&manifest_path)?;
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    ensure!(
        manifest.format_version == AOT_MANIFEST_FORMAT_VERSION,
        "AOT manifest format-version must be {AOT_MANIFEST_FORMAT_VERSION}, got {}",
        manifest.format_version
    );
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
            product.owns(&artifact.name),
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
        .filter(|module| module.requires_aot && outputs.product.owns(&module.name))
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
    Path::new("src/wasix/runtime/crates/aot")
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
    let extension_metadata = extension_catalog::manifest_metadata_by_sql_name()?;
    let effective_sources = effective_source_pins(sources, outputs)?;
    let manifest = AssetManifestOut {
        format_version: ASSET_MANIFEST_FORMAT_VERSION,
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
                    let primary_path = extension.module_path.ok_or_else(|| {
                        anyhow!(
                            "extension {} has link metadata without a module",
                            extension.sql_name
                        )
                    })?;
                    let module_exports = extension_asset_provider_exports(
                        link,
                        primary_path,
                        extension.sql_name,
                        extension.native_modules,
                        &native_module_links,
                    )?;
                    for import in &link.imports {
                        if !import_should_resolve_from_runtime(import) {
                            continue;
                        }
                        if import_resolves_from_wasm_exports(
                            import,
                            &module_exports,
                            extension.sql_name,
                        )? {
                            continue;
                        }
                        if let Some(name) =
                            resolved_wasm_export_name(import, &runtime_link.exports, "runtime")?
                        {
                            core_exports_required.push(name);
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
                let native_modules = extension
                    .native_modules
                    .iter()
                    .map(|module| {
                        let link = native_module_links
                            .get(&module.name)
                            .cloned()
                            .ok_or_else(|| anyhow!("missing link metadata for {}", module.name))?;
                        Ok::<_, anyhow::Error>(BinaryAssetOut {
                            name: module.name.clone(),
                            path: module.runtime_path.clone(),
                            sha256: sha256_file(&module.path)?,
                            module_sha256: sha256_file(&module.path)?,
                            size: fs::metadata(&module.path)
                                .with_context(|| format!("metadata {}", module.path.display()))?
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
                    control_files,
                    dependencies: metadata.dependencies.clone(),
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

    #[test]
    fn declared_export_policy_rejects_ambiguous_arguments() {
        for arguments in [
            vec!["--output"],
            vec!["--output", "--response"],
            vec!["--unknown", "value"],
            vec!["--module", "missing-separator"],
            vec!["--module", "=path"],
            vec!["--module", "name="],
            vec!["--module", "one=file", "--module", "one=other"],
            vec!["--output", "one", "--output", "two"],
            vec!["--output", "same", "--response", "same"],
            vec![
                "--module",
                "one=input",
                "--output",
                "input",
                "--response",
                "other",
            ],
        ] {
            let arguments = arguments.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert!(
                declared_export_policy_args(&arguments).is_err(),
                "{arguments:?}"
            );
        }
    }

    #[test]
    fn declared_export_policy_analyzes_only_explicit_wasm_inputs() {
        let directory =
            std::env::temp_dir().join(format!("oliphaunt-export-policy-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create isolated fixture directory");
        let module = directory.join("plugin.so");
        // Independently encoded valid WASM: a dylink.0 side module imports
        // env.backend, and reexports that function as plugin.
        let wasm = b"\0asm\x01\0\0\0\0\x0f\x08dylink.0\x01\x04\0\0\0\0\x01\x04\x01\x60\0\0\x02\x0f\x01\x03env\x07backend\0\0\x07\x0a\x01\x06plugin\0\0";
        fs::write(&module, wasm).expect("write independent WASM fixture");
        let output = directory.join("exports");
        let response = directory.join("exports.rsp");
        let arguments = vec![
            "--module".to_owned(),
            format!("plugin={}", module.display()),
            "--output".to_owned(),
            output.to_str().unwrap().to_owned(),
            "--response".to_owned(),
            response.to_str().unwrap().to_owned(),
        ];
        generate_declared_wasix_export_policy(&arguments).expect("derive compiled import policy");
        let policy = fs::read_to_string(&output).expect("read export policy");
        assert!(policy.lines().any(|symbol| symbol == "backend"));
        assert!(!policy.lines().any(|symbol| symbol == "plugin"));
        for abi in REQUIRED_RUNTIME_ABI_EXPORTS {
            assert!(policy.lines().any(|symbol| symbol == *abi));
        }
        assert_eq!(
            fs::read_to_string(&response).unwrap(),
            policy
                .lines()
                .map(|symbol| format!("--export={symbol}\n"))
                .collect::<String>()
        );
        let first = fs::read(&output).unwrap();
        generate_declared_wasix_export_policy(&arguments).expect("repeat deterministic policy");
        assert_eq!(fs::read(&output).unwrap(), first);
        fs::write(&module, b"invalid WASM").expect("replace malformed input");
        assert!(generate_declared_wasix_export_policy(&arguments).is_err());
        fs::remove_dir_all(directory).expect("remove fixture directory");
    }

    #[test]
    fn declared_extension_link_binds_physical_core_and_side_module() {
        let directory =
            std::env::temp_dir().join(format!("oliphaunt-extension-link-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let module = directory.join("plugin.so");
        fs::write(&module, b"\0asm\x01\0\0\0\0\x0f\x08dylink.0\x01\x04\0\0\0\0\x01\x04\x01\x60\0\0\x02\x0f\x01\x03env\x07backend\0\0\x07\x0a\x01\x06plugin\0\0").unwrap();
        let runtime = directory.join("postgres.wasm");
        fs::write(&runtime, b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0b\x01\x07backend\0\0\x0a\x04\x01\x02\0\x0b").unwrap();
        let manifest = directory.join("manifest.json");
        let portable = serde_json::json!({"format-version": ASSET_MANIFEST_FORMAT_VERSION, "source-lane": "stable", "source-fingerprint": "18.4:declared-test",
            "runtime": {"archive": "oliphaunt.wasix.tar.zst", "sha256": "a".repeat(64), "module-sha256": sha256_file(&runtime).unwrap(), "postgres-version": "18.4", "runtime-kind": "wasix-dynamic-main", "link": read_wasm_link_metadata(&runtime).unwrap()}, "runtime-support": [], "extensions": [], "sources": []});
        fs::write(&manifest, serde_json::to_vec(&portable).unwrap()).unwrap();
        let spec = directory.join("spec.json");
        let mut inputs = serde_json::json!({"sql_name": "plugin", "runtime": runtime, "runtime_manifest": manifest, "modules": [{"name": "plugin", "path": module, "runtime_path": "lib/postgresql/plugin.so"}]});
        fs::write(&spec, serde_json::to_vec(&inputs).unwrap()).unwrap();
        let output = directory.join("link.json");
        let args = [
            "--spec".to_owned(),
            spec.display().to_string(),
            "--output".to_owned(),
            output.display().to_string(),
        ];
        generate_declared_extension_link(&args).unwrap();
        let first = fs::read(&output).unwrap();
        let result: serde_json::Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(
            result["coreExportsRequired"],
            serde_json::json!(["backend"])
        );
        assert_eq!(
            result["nativeModules"][0]["moduleSha256"],
            sha256_file(&module).unwrap()
        );
        generate_declared_extension_link(&args).unwrap();
        assert_eq!(fs::read(&output).unwrap(), first);
        inputs["modules"][0]["runtime_path"] = serde_json::json!("../plugin.so");
        fs::write(&spec, serde_json::to_vec(&inputs).unwrap()).unwrap();
        assert!(generate_declared_extension_link(&args).is_err());
        inputs["modules"][0]["runtime_path"] = serde_json::json!("lib/postgresql/plugin.so");
        fs::write(&spec, serde_json::to_vec(&inputs).unwrap()).unwrap();
        let original_module = fs::read(&module).unwrap();
        let mut unresolved_module = original_module.clone();
        let position = unresolved_module
            .windows(7)
            .position(|bytes| bytes == b"backend")
            .unwrap();
        unresolved_module[position..position + 7].copy_from_slice(b"missing");
        fs::write(&module, unresolved_module).unwrap();
        assert!(
            generate_declared_extension_link(&args)
                .unwrap_err()
                .to_string()
                .contains("unresolved import env.missing")
        );
        fs::write(&module, original_module).unwrap();
        let mut wrong_link = portable.clone();
        wrong_link["runtime"]["link"]["exports"][0]["name"] = serde_json::json!("invented");
        fs::write(&manifest, serde_json::to_vec(&wrong_link).unwrap()).unwrap();
        assert!(generate_declared_extension_link(&args).is_err());
        fs::write(&manifest, serde_json::to_vec(&portable).unwrap()).unwrap();
        fs::write(&runtime, b"invalid core bytes").unwrap();
        assert!(generate_declared_extension_link(&args).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn declared_manifest_rejects_ambiguous_arguments() {
        for arguments in [
            vec![],
            vec!["--spec"],
            vec!["--spec", "--output"],
            vec!["--spec", "file", "--output", "file"],
            vec!["--unknown", "file"],
            vec!["--spec", "one", "--spec", "two"],
            vec!["--spec", "file", "--output", "one", "--output", "two"],
        ] {
            assert!(
                declared_manifest_args(
                    &arguments.into_iter().map(str::to_owned).collect::<Vec<_>>()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn declared_manifest_uses_physical_modules_and_rejects_stale_facts() {
        fn uleb(mut value: usize, bytes: &mut Vec<u8>) {
            loop {
                let byte = (value & 0x7f) as u8;
                value >>= 7;
                bytes.push(byte | if value == 0 { 0 } else { 0x80 });
                if value == 0 {
                    return;
                }
            }
        }
        fn main_wasm(exports: &[String]) -> Vec<u8> {
            // Independent encoder: one () -> () function with explicit aliases.
            let mut wasm = b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0".to_vec();
            let mut section = Vec::new();
            uleb(exports.len(), &mut section);
            for name in exports {
                uleb(name.len(), &mut section);
                section.extend(name.bytes());
                section.extend([0, 0]);
            }
            wasm.push(7);
            uleb(section.len(), &mut wasm);
            wasm.extend(section);
            wasm.extend([10, 4, 1, 2, 0, 11]);
            wasm
        }
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-declared-manifest-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let runtime = root.join("postgres.wasm");
        let initdb = root.join("initdb.wasm");
        let archive = root.join("runtime.tar.zst");
        let policy = root.join("exports");
        let exports = REQUIRED_RUNTIME_ABI_EXPORTS
            .iter()
            .chain(WASIX_LINKER_RUNTIME_EXPORTS)
            .map(|name| (*name).to_owned())
            .chain(std::iter::once("backend".to_owned()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        fs::write(&runtime, main_wasm(&exports)).unwrap();
        fs::write(&initdb, main_wasm(&["_start".to_owned()])).unwrap();
        fs::write(&archive, b"physical archive bytes").unwrap();
        fs::write(
            &policy,
            REQUIRED_RUNTIME_ABI_EXPORTS
                .iter()
                .map(|name| format!("{name}\n"))
                .chain(std::iter::once("backend\n".to_owned()))
                .collect::<String>(),
        )
        .unwrap();
        let side = b"\0asm\x01\0\0\0\0\x0f\x08dylink.0\x01\x04\0\0\0\0\x01\x04\x01\x60\0\0\x02\x0f\x01\x03env\x07backend\0\0\x07\x0a\x01\x06plugin\0\0";
        let support = ["plpgsql", "dict_snowball"].map(|name| {
            let source = root.join(format!("{name}.so"));
            fs::write(&source, side).unwrap();
            serde_json::json!({"name": name, "path": format!("lib/postgresql/{name}.so"), "source": source})
        });
        let source_hash = "a".repeat(64);
        let patch_hash = "b".repeat(64);
        let spec = serde_json::json!({
            "runtime": runtime, "initdb": initdb, "archive": archive, "export_policy": policy, "support": support,
            "source_fingerprint": format!("42.8:{source_hash}:{patch_hash}"), "postgres_version": "42.8-wasix-oliphaunt",
            "sources": [
                {"name": "postgresql", "url": "https://source.test/pg.tar.bz2", "branch": "v42.8", "commit": source_hash},
                {"name": "oliphaunt-wasix-stable-patches", "url": POSTGRES_PATCH_SERIES_PATH, "branch": "series", "commit": patch_hash},
            ],
        });
        let input = root.join("spec.json");
        let output = root.join("manifest.json");
        let args = [
            "--spec".to_owned(),
            input.to_str().unwrap().to_owned(),
            "--output".to_owned(),
            output.to_str().unwrap().to_owned(),
        ];
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        generate_declared_wasix_manifest(&args).unwrap();
        let bytes = fs::read(&output).unwrap();
        let manifest: AssetManifestOut = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            manifest.runtime.module_sha256,
            sha256_file(&runtime).unwrap()
        );
        assert_eq!(manifest.runtime.sha256, sha256_file(&archive).unwrap());
        assert_eq!(manifest.runtime.postgres_version, "42.8-wasix-oliphaunt");
        assert_eq!(manifest.runtime_support.len(), 2);
        assert_eq!(
            manifest.initdb.unwrap().module_sha256,
            sha256_file(&initdb).unwrap()
        );
        generate_declared_wasix_manifest(&args).unwrap();
        assert_eq!(bytes, fs::read(&output).unwrap());
        for mutate in [
            "unknown",
            "source-digest",
            "version",
            "support-path",
            "missing-support",
            "missing-input",
        ] {
            let mut invalid = spec.clone();
            match mutate {
                "unknown" => invalid["undeclared"] = serde_json::json!(true),
                "source-digest" => {
                    invalid["sources"][0]["commit"] = serde_json::json!("c".repeat(64))
                }
                "version" => {
                    invalid["postgres_version"] = serde_json::json!("42.9-wasix-oliphaunt")
                }
                "support-path" => invalid["support"][0]["path"] = serde_json::json!("../outside"),
                "missing-support" => invalid["support"]
                    .as_array_mut()
                    .unwrap()
                    .pop()
                    .map(|_| ())
                    .unwrap(),
                "missing-input" => invalid["initdb"] = serde_json::json!(root.join("missing.wasm")),
                _ => unreachable!(),
            }
            fs::write(&input, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(generate_declared_wasix_manifest(&args).is_err(), "{mutate}");
        }
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        fs::write(&runtime, main_wasm(&["_start".to_owned()])).unwrap();
        assert!(generate_declared_wasix_manifest(&args).is_err());
        fs::write(&runtime, b"invalid WASM").unwrap();
        assert!(generate_declared_wasix_manifest(&args).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_tools_manifest_checks_physical_commands_and_independent_versions() {
        let root =
            std::env::temp_dir().join(format!("oliphaunt-declared-tools-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let pg_dump = root.join("pg_dump.wasm");
        let psql = root.join("psql.wasm");
        // Independent WASM fixture: one empty function exported as _start.
        let command = b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x04\x01\x02\0\x0b";
        fs::write(&pg_dump, command).unwrap();
        fs::write(&psql, command).unwrap();
        let source_hash = "a".repeat(64);
        let patch_hash = "b".repeat(64);
        let spec = serde_json::json!({
            "pg_dump": pg_dump, "psql": psql, "version": "2.3.4", "runtime_version": "7.8.9",
            "source_fingerprint": format!("42.8:{source_hash}:{patch_hash}"), "postgres_version": "42.8-wasix-oliphaunt",
            "sources": [
                {"name": "postgresql", "url": "https://source.test/pg.tar.bz2", "branch": "v42.8", "commit": source_hash},
                {"name": "oliphaunt-wasix-stable-patches", "url": POSTGRES_PATCH_SERIES_PATH, "branch": "series", "commit": patch_hash},
            ],
        });
        let input = root.join("spec.json");
        let output = root.join("manifest.json");
        let args = [
            "--spec".to_owned(),
            input.to_str().unwrap().to_owned(),
            "--output".to_owned(),
            output.to_str().unwrap().to_owned(),
        ];
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        generate_declared_tools_manifest(&args).unwrap();
        let bytes = fs::read(&output).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(manifest["schema"], "postgres-tools-wasix-portable-v1");
        assert_eq!(manifest["version"], "2.3.4");
        assert_eq!(manifest["runtimeVersion"], "7.8.9");
        assert_eq!(manifest["pgDump"]["path"], "bin/pg_dump.wasix.wasm");
        assert_eq!(manifest["psql"]["size"], command.len());
        assert_eq!(
            manifest["pgDump"]["sha256"],
            format!("{:x}", Sha256::digest(command))
        );
        generate_declared_tools_manifest(&args).unwrap();
        assert_eq!(bytes, fs::read(&output).unwrap());
        for mutate in [
            "unknown",
            "version",
            "runtime-version",
            "source-digest",
            "missing-input",
        ] {
            let mut invalid = spec.clone();
            match mutate {
                "unknown" => invalid["undeclared"] = serde_json::json!(true),
                "version" => invalid["version"] = serde_json::json!("2.3"),
                "runtime-version" => invalid["runtime_version"] = serde_json::json!("07.8.9"),
                "source-digest" => {
                    invalid["sources"][0]["commit"] = serde_json::json!("c".repeat(64))
                }
                "missing-input" => invalid["psql"] = serde_json::json!(root.join("missing.wasm")),
                _ => unreachable!(),
            }
            fs::write(&input, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(generate_declared_tools_manifest(&args).is_err(), "{mutate}");
        }
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        let mut no_start = command.to_vec();
        let position = no_start
            .windows(6)
            .position(|name| name == b"_start")
            .unwrap();
        no_start[position..position + 6].copy_from_slice(b"other!");
        fs::write(&psql, no_start).unwrap();
        assert!(generate_declared_tools_manifest(&args).is_err());
        fs::write(&psql, b"invalid WASM").unwrap();
        assert!(generate_declared_tools_manifest(&args).is_err());
        fs::write(&psql, command).unwrap();
        let mut collision = args.clone();
        collision[3] = psql.to_str().unwrap().to_owned();
        assert!(generate_declared_tools_manifest(&collision).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_tools_aot_uses_only_its_two_commands_and_rejects_cross_family_inputs() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-declared-tools-aot-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let portable_path = root.join("tools.json");
        let toolchain = root.join("toolchain.toml");
        fs::write(
            &toolchain,
            "[toolchain]\nwasmer = '9.8.7'\nwasmer-wasix = '0.987.0'\n",
        )
        .unwrap();
        let mut artifacts = Vec::new();
        let mut identities = serde_json::Map::new();
        for (key, name) in [("pgDump", "pg_dump"), ("psql", "psql")] {
            let module = root.join(format!("{name}.wasm"));
            let image = root.join(format!("{name}.bin.zst"));
            fs::write(&module, format!("portable command {name}")).unwrap();
            fs::write(
                &image,
                zstd::stream::encode_all(format!("AOT command {name}").as_bytes(), 19).unwrap(),
            )
            .unwrap();
            identities.insert(key.to_owned(), serde_json::json!({"name": name, "path": format!("bin/{name}.wasix.wasm"), "sha256": sha256_file(&module).unwrap(), "size": fs::metadata(&module).unwrap().len()}));
            artifacts.push(serde_json::json!({"name": format!("tool:{name}"), "path": format!("{name}-llvm-opta.bin.zst"), "image": image, "module": module}));
        }
        let mut portable = serde_json::json!({"schema": "postgres-tools-wasix-portable-v1", "version": "0.2.4", "runtimeVersion": "0.3.2", "sourceFingerprint": format!("18.4:{}:{}", "a".repeat(64), "b".repeat(64))});
        portable.as_object_mut().unwrap().extend(identities);
        fs::write(&portable_path, serde_json::to_vec(&portable).unwrap()).unwrap();
        let spec = serde_json::json!({"portable_manifest": portable_path, "toolchain": toolchain, "target_triple": "aarch64-apple-darwin", "artifacts": artifacts});
        let input = root.join("spec.json");
        let output = root.join("manifest.json");
        let args = [
            "--spec".to_owned(),
            input.to_str().unwrap().to_owned(),
            "--output".to_owned(),
            output.to_str().unwrap().to_owned(),
        ];
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        generate_declared_aot_manifest(&args).unwrap();
        let first = fs::read(&output).unwrap();
        let manifest: AotManifest = serde_json::from_slice(&first).unwrap();
        assert_eq!(
            manifest
                .artifacts
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["tool:pg_dump", "tool:psql"]
        );
        assert_eq!(manifest.postgres_version.as_deref(), Some("18.4"));
        assert_eq!(manifest.target_triple, "aarch64-apple-darwin");
        generate_declared_aot_manifest(&args).unwrap();
        assert_eq!(first, fs::read(&output).unwrap());
        for case in ["family", "schema", "missing", "module", "duplicate", "path"] {
            let mut invalid = spec.clone();
            match case {
                "family" => {
                    invalid["artifacts"][0]["name"] = serde_json::json!("runtime:oliphaunt")
                }
                "schema" => {
                    let mut invalid_portable = portable.clone();
                    invalid_portable["schema"] = serde_json::json!("unknown");
                    fs::write(
                        &portable_path,
                        serde_json::to_vec(&invalid_portable).unwrap(),
                    )
                    .unwrap();
                }
                "missing" => {
                    invalid["artifacts"].as_array_mut().unwrap().pop();
                }
                "module" => {
                    invalid["artifacts"][0]["module"] = invalid["artifacts"][1]["module"].clone()
                }
                "duplicate" => invalid["artifacts"][0] = invalid["artifacts"][1].clone(),
                "path" => invalid["artifacts"][0]["path"] = serde_json::json!("../outside"),
                _ => unreachable!(),
            }
            fs::write(&input, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(generate_declared_aot_manifest(&args).is_err(), "{case}");
            fs::write(&portable_path, serde_json::to_vec(&portable).unwrap()).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_aot_manifest_records_physical_images_and_rejects_mismatches() {
        let root =
            std::env::temp_dir().join(format!("oliphaunt-declared-aot-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let portable_path = root.join("portable.json");
        let toolchain = root.join("toolchain.toml");
        fs::write(
            &toolchain,
            "[toolchain]\nwasmer = '9.8.7'\nwasmer-wasix = '0.987.0'\n",
        )
        .unwrap();
        let names = [
            ("runtime:oliphaunt", "oliphaunt"),
            ("tool:initdb", "initdb"),
            ("runtime-support:plpgsql", "plpgsql"),
            ("runtime-support:dict_snowball", "dict_snowball"),
        ];
        let mut artifacts = Vec::new();
        let mut digests = BTreeMap::new();
        for (name, stem) in names {
            let module = root.join(format!("{stem}.wasm"));
            let image = root.join(format!("{stem}.bin.zst"));
            fs::write(&module, format!("physical portable {name}")).unwrap();
            fs::write(
                &image,
                zstd::stream::encode_all(format!("physical AOT {name}").as_bytes(), 19).unwrap(),
            )
            .unwrap();
            digests.insert(stem, sha256_file(&module).unwrap());
            artifacts.push(serde_json::json!({
                "name": name, "path": format!("{stem}-llvm-opta.bin.zst"), "image": image, "module": module,
            }));
        }
        let link = serde_json::to_value(WasmLinkMetadataOut::default()).unwrap();
        let binary = |name: &str| {
            serde_json::json!({
                "name": name, "path": format!("lib/postgresql/{name}.so"), "sha256": digests[name],
                "module-sha256": digests[name], "size": 1, "link": link,
            })
        };
        let portable = serde_json::json!({
            "format-version": ASSET_MANIFEST_FORMAT_VERSION, "source-lane": DEFAULT_SOURCE_LANE,
            "source-fingerprint": "physical source identity",
            "runtime": {"archive": "oliphaunt.wasix.tar.zst", "sha256": "archive digest", "module-sha256": digests["oliphaunt"],
                "postgres-version": "42.8-wasix-oliphaunt", "runtime-kind": "wasix-dynamic-main", "link": link},
            "runtime-support": [binary("plpgsql"), binary("dict_snowball")], "initdb": binary("initdb"), "extensions": [], "sources": [],
        });
        fs::write(&portable_path, serde_json::to_vec(&portable).unwrap()).unwrap();
        let spec = serde_json::json!({
            "portable_manifest": portable_path, "toolchain": toolchain,
            "target_triple": "x86_64-pc-windows-msvc", "artifacts": artifacts,
        });
        let input = root.join("spec.json");
        let output = root.join("manifest.json");
        let args = [
            "--spec".to_owned(),
            input.to_str().unwrap().to_owned(),
            "--output".to_owned(),
            output.to_str().unwrap().to_owned(),
        ];
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        generate_declared_aot_manifest(&args).unwrap();
        let bytes = fs::read(&output).unwrap();
        let manifest: AotManifest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(manifest.format_version, AOT_MANIFEST_FORMAT_VERSION);
        assert_eq!(manifest.target_triple, "x86_64-pc-windows-msvc");
        assert_eq!(manifest.wasmer_version, "9.8.7");
        assert_eq!(manifest.wasmer_wasix_version, "0.987.0");
        assert_eq!(
            manifest.source_fingerprint.as_deref(),
            Some("physical source identity")
        );
        assert_eq!(
            manifest.postgres_version.as_deref(),
            Some("42.8-wasix-oliphaunt")
        );
        assert_eq!(manifest.artifacts.len(), 4);
        for artifact in &manifest.artifacts {
            let raw = format!("physical AOT {}", artifact.name);
            assert_eq!(artifact.raw_sha256, sha256_bytes(raw.as_bytes()));
            assert_eq!(artifact.raw_size, raw.len() as u64);
            assert!(artifact.compressed);
        }
        generate_declared_aot_manifest(&args).unwrap();
        assert_eq!(bytes, fs::read(&output).unwrap());
        for case in [
            "unknown",
            "target",
            "module",
            "path",
            "missing",
            "duplicate",
            "missing-image",
        ] {
            let mut invalid = spec.clone();
            match case {
                "unknown" => invalid["undeclared"] = serde_json::json!(true),
                "target" => invalid["target_triple"] = serde_json::json!("../outside"),
                "module" => {
                    invalid["artifacts"][0]["module"] = invalid["artifacts"][1]["module"].clone()
                }
                "path" => invalid["artifacts"][0]["path"] = serde_json::json!("../outside"),
                "missing" => {
                    invalid["artifacts"].as_array_mut().unwrap().pop();
                }
                "duplicate" => invalid["artifacts"][0] = invalid["artifacts"][1].clone(),
                "missing-image" => {
                    invalid["artifacts"][0]["image"] = serde_json::json!(root.join("missing"))
                }
                _ => unreachable!(),
            }
            fs::write(&input, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(generate_declared_aot_manifest(&args).is_err(), "{case}");
        }
        fs::write(&input, serde_json::to_vec(&spec).unwrap()).unwrap();
        let mut invalid = portable.clone();
        invalid["format-version"] = serde_json::json!(999);
        fs::write(&portable_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(generate_declared_aot_manifest(&args).is_err());
        fs::write(&portable_path, serde_json::to_vec(&portable).unwrap()).unwrap();
        let image = PathBuf::from(spec["artifacts"][0]["image"].as_str().unwrap());
        fs::write(&image, b"corrupt compressed image").unwrap();
        assert!(generate_declared_aot_manifest(&args).is_err());
        fs::write(&image, zstd::stream::encode_all(&b""[..], 19).unwrap()).unwrap();
        assert!(generate_declared_aot_manifest(&args).is_err());
        fs::write(&toolchain, "invalid TOML").unwrap();
        assert!(generate_declared_aot_manifest(&args).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn manifest_extension_metadata(
        create_extension: bool,
        control_files: Vec<&str>,
    ) -> extension_catalog::ManifestExtensionMetadata {
        extension_catalog::ManifestExtensionMetadata {
            source_kind: "postgres-contrib".to_owned(),
            control_files: control_files.into_iter().map(str::to_owned).collect(),
            dependencies: Vec::new(),
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
            format_version: AOT_MANIFEST_FORMAT_VERSION,
            source_lane: source_lane.map(str::to_owned),
            source_fingerprint: source_fingerprint.map(str::to_owned),
            postgres_version: postgres_version.map(str::to_owned),
            target_triple: "aarch64-apple-darwin".to_owned(),
            engine: "llvm-opta".to_owned(),
            wasmer_version: "7.2.1".to_owned(),
            wasmer_wasix_version: "0.702.1".to_owned(),
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
    fn downloaded_stable_aot_manifest_rejects_noncanonical_format_version() {
        let path = temp_aot_manifest_path("wrong-format-version");
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
        manifest.format_version = AOT_MANIFEST_FORMAT_VERSION + 1;
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
        .expect_err("downloaded AOT manifest with a noncanonical format version should fail");

        assert!(
            error.to_string().contains("AOT manifest format-version"),
            "unexpected validation error: {error:#}"
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
        manifest.wasmer_version = "7.2.1-alpha.3".to_owned();
        manifest.wasmer_wasix_version = "0.702.1-alpha.3".to_owned();
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

    fn wasm_export(name: &str, kind: &str) -> WasmExportOut {
        WasmExportOut {
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
    fn single_backend_runtime_rejects_thread_creation_imports() {
        for import in [
            wasm_import("wasi", "thread-spawn", "func"),
            wasm_import("wasix_32v1", "thread_spawn_v2", "func"),
            wasm_import("env", "__pthread_create", "func"),
        ] {
            assert!(is_thread_spawn_import(&import), "{import:?}");
        }

        for import in [
            wasm_import("wasix_32v1", "thread_exit", "func"),
            wasm_import("wasix_32v1", "thread_signal", "func"),
            wasm_import("wasix_32v1", "thread_parallelism", "func"),
        ] {
            assert!(!is_thread_spawn_import(&import), "{import:?}");
        }
    }

    #[test]
    fn side_module_exports_satisfy_their_own_dynamic_symbol_imports() {
        let module_exports = vec![
            wasm_export("GEOSArea_r", "func"),
            wasm_export("_ZN10FlatGeobuf11PackedRTree4initEt", "func"),
            wasm_export("ZN10FlatGeobuf11PackedRTree4initEt", "func"),
        ];

        for import in [
            wasm_import("env", "GEOSArea_r", "func"),
            wasm_import("GOT.func", "_ZN10FlatGeobuf11PackedRTree4initEt", "global"),
            wasm_import("GOT.func", "ZN10FlatGeobuf11PackedRTree4initEt", "global"),
        ] {
            assert!(import_should_resolve_from_runtime(&import));
            assert!(
                import_resolves_from_wasm_exports(&import, &module_exports, "test module")
                    .expect("valid typed provider"),
                "{import:?} should be self-resolved by the linked side module"
            );
        }
    }

    #[test]
    fn new_extension_imports_extend_the_sealed_runtime_policy() {
        let runtime_import = wasm_import("env", "SearchSysCache1", "func");
        let module_exports = vec![wasm_export("GEOSArea_r", "func")];

        assert!(import_should_resolve_from_runtime(&runtime_import));
        assert!(
            !import_resolves_from_wasm_exports(&runtime_import, &module_exports, "test module")
                .expect("absent export")
        );
        assert_eq!(
            runtime_export_name_for_side_import(&runtime_import),
            "SearchSysCache1"
        );
    }

    #[test]
    fn side_module_provider_kinds_must_match_dynamic_imports() {
        let error = import_resolves_from_wasm_exports(
            &wasm_import("GOT.func", "SearchSysCache1", "global"),
            &[wasm_export("SearchSysCache1", "global")],
            "test module",
        )
        .expect_err("function-address imports must resolve to functions");
        assert!(error.to_string().contains("expected func"));
    }

    #[test]
    fn side_module_providers_follow_declared_dynamic_dependencies() {
        let root = WasmLinkMetadataOut {
            dylink_needed: vec!["declared.so".to_owned()],
            exports: vec![wasm_export("root_symbol", "func")],
            ..Default::default()
        };
        let declared = WasmLinkMetadataOut {
            exports: vec![wasm_export("declared_symbol", "func")],
            ..Default::default()
        };
        let undeclared = WasmLinkMetadataOut {
            exports: vec![wasm_export("undeclared_symbol", "func")],
            ..Default::default()
        };
        let links = BTreeMap::from([
            ("extension:test".to_owned(), root),
            ("extension:test:declared".to_owned(), declared),
            ("extension:test:undeclared".to_owned(), undeclared),
        ]);
        let basenames = BTreeMap::from([
            ("root.so".to_owned(), "extension:test".to_owned()),
            (
                "declared.so".to_owned(),
                "extension:test:declared".to_owned(),
            ),
            (
                "undeclared.so".to_owned(),
                "extension:test:undeclared".to_owned(),
            ),
        ]);

        let exports = side_module_provider_exports("extension:test", &links, &basenames)
            .expect("declared provider graph");
        assert!(
            import_resolves_from_wasm_exports(
                &wasm_import("env", "declared_symbol", "func"),
                &exports,
                "test graph",
            )
            .expect("declared provider")
        );
        assert!(
            !import_resolves_from_wasm_exports(
                &wasm_import("env", "undeclared_symbol", "func"),
                &exports,
                "test graph",
            )
            .expect("undeclared provider")
        );
    }

    #[test]
    fn sealed_runtime_export_policy_requires_exact_surface() {
        let expected = BTreeSet::from(["_start".to_owned(), "runtime_abi".to_owned()]);
        ensure_exact_runtime_export_surface(&expected, &expected).expect("exact export surface");

        let error = ensure_exact_runtime_export_surface(
            &BTreeSet::from(["_start".to_owned(), "ambient".to_owned()]),
            &expected,
        )
        .expect_err("ambient export must fail");
        let message = error.to_string();
        assert!(message.contains("runtime_abi"));
        assert!(message.contains("ambient"));
    }
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
        url: "src/wasix/runtime/postgres/series".to_owned(),
        mirror_url: None,
        branch: "series".to_owned(),
        commit: patch_fingerprint.to_owned(),
        source_date_epoch: None,
        sha256: None,
        strip_prefix: None,
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
    let shared_text = fs::read_to_string(&shared_path)
        .with_context(|| format!("read {}", shared_path.display()))?;
    let shared: PostgresSharedSourceManifest =
        toml::from_str(&shared_text).with_context(|| format!("parse {}", shared_path.display()))?;
    let series = fs::read_to_string(repo_relative_path(POSTGRES_PATCH_SERIES_PATH))?;
    let mut seen = BTreeSet::new();
    let mut patches = Vec::new();
    for name in series
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        ensure!(
            name.ends_with(".patch")
                && !Path::new(name).is_absolute()
                && !name.contains('\\')
                && !name.split('/').any(|part| part == "..")
                && seen.insert(name),
            "invalid or duplicate PostgreSQL patch: {name}"
        );
        patches.push(name.to_owned());
    }
    ensure!(!patches.is_empty(), "PostgreSQL patch series is empty");
    Ok(PostgresSourceManifest {
        postgresql: shared.postgresql,
        patches,
    })
}

pub(crate) fn repo_relative_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() || path.exists() {
        return path.to_path_buf();
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../..")
        .join(path)
}

fn ensure_matching_marker(expected: &str, actual_path: &Path, field: &str) -> Result<()> {
    let actual = fs::read_to_string(actual_path)
        .with_context(|| format!("read {}", actual_path.display()))?;
    ensure_eq(actual.trim(), expected, field)
}
