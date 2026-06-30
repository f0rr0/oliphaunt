use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use wasmparser::{Dylink0Subsection, ExternalKind, KnownCustom, Parser, Payload, TypeRef};

#[derive(Debug, Deserialize)]
pub(super) struct SourcesManifest {
    pub(super) toolchain: Toolchain,
    pub(super) build: BuildConfig,
    pub(super) sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
pub(super) struct WasixToolchainManifest {
    pub(super) toolchain: Toolchain,
    pub(super) build: BuildConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct GeneratedAssetManifest {
    #[serde(default)]
    pub(super) source_lane: Option<String>,
    #[serde(default)]
    pub(super) sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PostgresSourceManifest {
    pub(super) postgresql: PostgresPostgresqlSource,
    pub(super) patches: PostgresPatchManifest,
}

#[derive(Debug, Deserialize)]
pub(super) struct PostgresSharedSourceManifest {
    pub(super) postgresql: PostgresPostgresqlSource,
}

#[derive(Debug, Deserialize)]
pub(super) struct PostgresProductPatchManifest {
    pub(super) patches: PostgresPatchManifest,
}

#[derive(Debug, Deserialize)]
pub(super) struct PostgresPostgresqlSource {
    pub(super) version: String,
    pub(super) url: String,
    pub(super) sha256: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PostgresPatchManifest {
    pub(super) series: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Toolchain {
    pub(super) wasmer: String,
    #[serde(rename = "wasmer-wasix")]
    pub(super) wasmer_wasix: String,
    #[allow(dead_code)]
    pub(super) wasixcc: String,
    #[allow(dead_code)]
    pub(super) llvm: String,
    #[allow(dead_code)]
    pub(super) docker_image: String,
    #[allow(dead_code)]
    pub(super) docker_image_digest: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct BuildConfig {
    pub(super) postgres_prefix: String,
    pub(super) postgres_pkglibdir: String,
    pub(super) postgres_sharedir: String,
    pub(super) main_flags: Vec<String>,
    pub(super) extension_flags: Vec<String>,
    pub(super) archive_format: String,
    pub(super) deterministic_archives: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct SourcePin {
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "SourceKind::is_git")]
    pub(super) kind: SourceKind,
    pub(super) url: String,
    pub(super) branch: String,
    pub(super) commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) strip_prefix: Option<String>,
    #[serde(skip)]
    pub(super) origin: SourceOrigin,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SourceKind {
    Git,
    Archive,
}

impl Default for SourceKind {
    fn default() -> Self {
        Self::Git
    }
}

impl SourceKind {
    pub(super) fn is_git(&self) -> bool {
        matches!(self, Self::Git)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceOrigin {
    SharedThirdParty,
    NativeThirdParty,
    WasixThirdParty,
    Extension,
    Generated,
}

impl Default for SourceOrigin {
    fn default() -> Self {
        Self::Generated
    }
}

impl SourcePin {
    pub(super) fn archive_stamp(&self) -> String {
        format!(
            "name={}\nkind=archive\nurl={}\nbranch={}\ncommit={}\nsha256={}\nstrip-prefix={}\n",
            self.name,
            self.url,
            self.branch,
            self.commit,
            self.sha256.as_deref().unwrap_or(""),
            self.strip_prefix.as_deref().unwrap_or("")
        )
    }
}

pub(super) struct ExtensionArtifact<'a> {
    pub(super) name: &'a str,
    pub(super) sql_name: &'a str,
    pub(super) archive: &'a str,
    pub(super) path: &'a Path,
    pub(super) module_path: Option<&'a Path>,
    pub(super) native_module: Option<&'a str>,
    pub(super) native_modules: &'a [OwnedExtensionNativeModule],
    pub(super) stable: bool,
}

pub(super) struct OwnedExtensionArtifact {
    pub(super) name: String,
    pub(super) sql_name: String,
    pub(super) archive: String,
    pub(super) path: PathBuf,
    pub(super) module_path: Option<PathBuf>,
    pub(super) native_module: Option<String>,
    pub(super) native_modules: Vec<OwnedExtensionNativeModule>,
    pub(super) stable: bool,
}

#[derive(Debug, Clone)]
pub(super) struct OwnedExtensionNativeModule {
    pub(super) name: String,
    pub(super) runtime_path: String,
    pub(super) path: PathBuf,
}

pub(super) struct BinaryPackage<'a> {
    pub(super) name: &'a str,
    pub(super) path: &'a Path,
    pub(super) runtime_path: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct BuildOutputManifestOut {
    pub(super) format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) postgres_version: Option<String>,
    pub(super) build_profile: String,
    pub(super) modules: Vec<BuildModuleManifestOut>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct BuildModuleManifestOut {
    pub(super) name: String,
    pub(super) kind: String,
    pub(super) path: String,
    pub(super) sha256: String,
    pub(super) link: WasmLinkMetadataOut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct AssetManifestOut {
    pub(super) format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_fingerprint: Option<String>,
    pub(super) runtime: RuntimeAssetOut,
    pub(super) runtime_support: Vec<BinaryAssetOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pg_dump: Option<BinaryAssetOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) psql: Option<BinaryAssetOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) initdb: Option<BinaryAssetOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pgdata_template: Option<PgDataTemplateAssetOut>,
    pub(super) extensions: Vec<ExtensionAssetOut>,
    pub(super) sources: Vec<SourcePin>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct RuntimeAssetOut {
    pub(super) archive: String,
    pub(super) sha256: String,
    pub(super) module_sha256: String,
    pub(super) postgres_version: String,
    pub(super) runtime_kind: String,
    pub(super) link: WasmLinkMetadataOut,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct BinaryAssetOut {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) sha256: String,
    pub(super) module_sha256: String,
    pub(super) size: u64,
    pub(super) link: WasmLinkMetadataOut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct PgDataTemplateAssetOut {
    pub(super) archive: String,
    pub(super) manifest: String,
    pub(super) sha256: String,
    pub(super) size: u64,
    pub(super) runtime_module_sha256: String,
    pub(super) initdb_module_sha256: String,
    pub(super) source_pins_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_fingerprint: Option<String>,
    pub(super) postgres_version: String,
    pub(super) catalog_version: String,
    pub(super) init_profile: String,
    pub(super) wasmer_version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct ExtensionAssetOut {
    pub(super) name: String,
    pub(super) sql_name: String,
    pub(super) source_kind: String,
    pub(super) archive: String,
    pub(super) sha256: String,
    pub(super) module_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native_module: Option<String>,
    #[serde(default)]
    pub(super) native_modules: Vec<BinaryAssetOut>,
    pub(super) size: u64,
    pub(super) stable: bool,
    pub(super) control_files: Vec<String>,
    pub(super) dependencies: Vec<String>,
    pub(super) native_dependencies: Vec<String>,
    pub(super) load_order: Vec<String>,
    pub(super) lifecycle: ExtensionLifecycleOut,
    pub(super) extension_imports: Vec<WasmImportOut>,
    pub(super) core_exports_required: Vec<String>,
    pub(super) unresolved_imports: Vec<WasmImportOut>,
    pub(super) installed_files: Vec<String>,
    pub(super) smoke_status: ExtensionSmokeStatusOut,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) link: Option<WasmLinkMetadataOut>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct ExtensionLifecycleOut {
    pub(super) create_extension: bool,
    pub(super) create_schema: Option<String>,
    pub(super) load_sql: Vec<String>,
    pub(super) post_create_sql: Vec<String>,
    pub(super) startup_config: Vec<String>,
    pub(super) preload_required: bool,
    pub(super) restart_required: bool,
    pub(super) shared_memory_required: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct ExtensionSmokeStatusOut {
    pub(super) promoted: bool,
    pub(super) direct: String,
    pub(super) server: String,
    pub(super) restart: String,
    pub(super) dump_restore: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmLinkMetadataOut {
    pub(super) has_dylink0: bool,
    pub(super) dylink_needed: Vec<String>,
    pub(super) dylink_runtime_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) dylink_memory: Option<WasmDylinkMemoryOut>,
    pub(super) dylink_imports: Vec<WasmDylinkSymbolOut>,
    pub(super) dylink_exports: Vec<WasmDylinkSymbolOut>,
    pub(super) imports: Vec<WasmImportOut>,
    pub(super) exports: Vec<WasmExportOut>,
    pub(super) memories: Vec<WasmMemoryOut>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmDylinkMemoryOut {
    pub(super) memory_size: u32,
    pub(super) memory_alignment: u32,
    pub(super) table_size: u32,
    pub(super) table_alignment: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmDylinkSymbolOut {
    pub(super) module: Option<String>,
    pub(super) name: String,
    pub(super) flags: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmImportOut {
    pub(super) module: String,
    pub(super) name: String,
    pub(super) kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmExportOut {
    pub(super) name: String,
    pub(super) kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) struct WasmMemoryOut {
    pub(super) initial_pages: u64,
    pub(super) maximum_pages: Option<u64>,
    pub(super) memory64: bool,
    pub(super) shared: bool,
    pub(super) page_size_log2: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct AotManifest {
    pub(super) format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) postgres_version: Option<String>,
    pub(super) target_triple: String,
    pub(super) engine: String,
    pub(super) wasmer_version: String,
    pub(super) wasmer_wasix_version: String,
    pub(super) artifacts: Vec<AotManifestArtifact>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) struct AotManifestArtifact {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) sha256: String,
    pub(super) raw_sha256: String,
    pub(super) raw_size: u64,
    pub(super) module_sha256: String,
    pub(super) compressed: bool,
}

pub(super) fn read_wasm_link_metadata(path: &Path) -> Result<WasmLinkMetadataOut> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut metadata = WasmLinkMetadataOut {
        has_dylink0: false,
        dylink_needed: Vec::new(),
        dylink_runtime_paths: Vec::new(),
        dylink_memory: None,
        dylink_imports: Vec::new(),
        dylink_exports: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        memories: Vec::new(),
    };

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.with_context(|| format!("parse {}", path.display()))? {
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import =
                        import.with_context(|| format!("read import from {}", path.display()))?;
                    metadata.imports.push(WasmImportOut {
                        module: import.module.to_owned(),
                        name: import.name.to_owned(),
                        kind: type_ref_kind(import.ty).to_owned(),
                    });
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export =
                        export.with_context(|| format!("read export from {}", path.display()))?;
                    metadata.exports.push(WasmExportOut {
                        name: export.name.to_owned(),
                        kind: external_kind_name(export.kind).to_owned(),
                    });
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory =
                        memory.with_context(|| format!("read memory from {}", path.display()))?;
                    metadata.memories.push(wasm_memory_out(memory));
                }
            }
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                metadata.has_dylink0 = true;
                let KnownCustom::Dylink0(reader) = section.as_known() else {
                    bail!("{} contains an unreadable dylink.0 section", path.display());
                };
                for subsection in reader {
                    match subsection
                        .with_context(|| format!("read dylink.0 from {}", path.display()))?
                    {
                        Dylink0Subsection::MemInfo(info) => {
                            metadata.dylink_memory = Some(WasmDylinkMemoryOut {
                                memory_size: info.memory_size,
                                memory_alignment: info.memory_alignment,
                                table_size: info.table_size,
                                table_alignment: info.table_alignment,
                            });
                        }
                        Dylink0Subsection::Needed(needed) => {
                            metadata
                                .dylink_needed
                                .extend(needed.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::RuntimePath(paths) => {
                            metadata
                                .dylink_runtime_paths
                                .extend(paths.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::ImportInfo(imports) => {
                            metadata
                                .dylink_imports
                                .extend(imports.into_iter().map(|import| WasmDylinkSymbolOut {
                                    module: Some(import.module.to_owned()),
                                    name: import.field.to_owned(),
                                    flags: import.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::ExportInfo(exports) => {
                            metadata
                                .dylink_exports
                                .extend(exports.into_iter().map(|export| WasmDylinkSymbolOut {
                                    module: None,
                                    name: export.name.to_owned(),
                                    flags: export.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::Unknown { .. } => {}
                    }
                }
            }
            _ => {}
        }
    }

    metadata.dylink_needed.sort();
    metadata.dylink_needed.dedup();
    metadata.dylink_runtime_paths.sort();
    metadata.dylink_runtime_paths.dedup();
    metadata.dylink_imports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.dylink_exports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.imports.sort_by(|left, right| {
        (left.module.as_str(), left.name.as_str(), left.kind.as_str()).cmp(&(
            right.module.as_str(),
            right.name.as_str(),
            right.kind.as_str(),
        ))
    });
    metadata.exports.sort_by(|left, right| {
        (left.name.as_str(), left.kind.as_str()).cmp(&(right.name.as_str(), right.kind.as_str()))
    });
    metadata.memories.sort_by(|left, right| {
        (
            left.initial_pages,
            left.maximum_pages,
            left.memory64,
            left.shared,
            left.page_size_log2,
        )
            .cmp(&(
                right.initial_pages,
                right.maximum_pages,
                right.memory64,
                right.shared,
                right.page_size_log2,
            ))
    });

    Ok(metadata)
}

fn type_ref_kind(ty: TypeRef) -> &'static str {
    match ty {
        TypeRef::Func(_) | TypeRef::FuncExact(_) => "func",
        TypeRef::Table(_) => "table",
        TypeRef::Memory(_) => "memory",
        TypeRef::Global(_) => "global",
        TypeRef::Tag(_) => "tag",
    }
}

fn external_kind_name(kind: ExternalKind) -> &'static str {
    match kind {
        ExternalKind::Func | ExternalKind::FuncExact => "func",
        ExternalKind::Table => "table",
        ExternalKind::Memory => "memory",
        ExternalKind::Global => "global",
        ExternalKind::Tag => "tag",
    }
}

fn wasm_memory_out(memory: wasmparser::MemoryType) -> WasmMemoryOut {
    WasmMemoryOut {
        initial_pages: memory.initial,
        maximum_pages: memory.maximum,
        memory64: memory.memory64,
        shared: memory.shared,
        page_size_log2: memory.page_size_log2,
    }
}
