#![deny(unsafe_code)]

use serde::{Deserialize, Serialize};

include!(concat!(env!("OUT_DIR"), "/generated_assets.rs"));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct AssetManifest {
    pub format_version: u32,
    #[serde(default)]
    pub source_lane: Option<String>,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    pub runtime: RuntimeAsset,
    #[serde(default)]
    pub runtime_support: Vec<BinaryAsset>,
    #[serde(default)]
    pub pg_dump: Option<BinaryAsset>,
    #[serde(default)]
    pub initdb: Option<BinaryAsset>,
    #[serde(default)]
    pub pgdata_template: Option<PgDataTemplateAsset>,
    #[serde(default)]
    pub extensions: Vec<ExtensionAsset>,
    #[serde(default)]
    pub sources: Vec<SourcePin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct RuntimeAsset {
    pub archive: String,
    pub sha256: String,
    #[serde(default)]
    pub module_sha256: String,
    pub postgres_version: String,
    pub runtime_kind: String,
    #[serde(default)]
    pub link: Option<WasmLinkMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct BinaryAsset {
    pub name: String,
    pub path: String,
    pub sha256: String,
    #[serde(default)]
    pub module_sha256: String,
    #[serde(default)]
    pub native_module: Option<String>,
    pub size: u64,
    #[serde(default)]
    pub link: Option<WasmLinkMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct PgDataTemplateAsset {
    pub archive: String,
    pub manifest: String,
    pub sha256: String,
    pub size: u64,
    pub runtime_module_sha256: String,
    pub initdb_module_sha256: String,
    pub source_pins_sha256: String,
    #[serde(default)]
    pub source_lane: Option<String>,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub catalog_version: String,
    pub init_profile: String,
    pub wasmer_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct ExtensionAsset {
    pub name: String,
    pub sql_name: String,
    #[serde(default)]
    pub source_kind: String,
    pub archive: String,
    pub sha256: String,
    #[serde(default)]
    pub module_sha256: String,
    #[serde(default)]
    pub native_modules: Vec<BinaryAsset>,
    pub size: u64,
    #[serde(default)]
    pub stable: bool,
    #[serde(default)]
    pub control_files: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub native_dependencies: Vec<String>,
    #[serde(default)]
    pub load_order: Vec<String>,
    #[serde(default)]
    pub lifecycle: Option<ExtensionLifecycle>,
    #[serde(default)]
    pub extension_imports: Vec<WasmImport>,
    #[serde(default)]
    pub core_exports_required: Vec<String>,
    #[serde(default)]
    pub unresolved_imports: Vec<WasmImport>,
    #[serde(default)]
    pub installed_files: Vec<String>,
    #[serde(default)]
    pub smoke_status: Option<ExtensionSmokeStatus>,
    #[serde(default)]
    pub link: Option<WasmLinkMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct ExtensionLifecycle {
    pub create_extension: bool,
    #[serde(default)]
    pub create_schema: Option<String>,
    #[serde(default)]
    pub load_sql: Vec<String>,
    #[serde(default)]
    pub post_create_sql: Vec<String>,
    #[serde(default)]
    pub startup_config: Vec<String>,
    #[serde(default)]
    pub preload_required: bool,
    #[serde(default)]
    pub restart_required: bool,
    #[serde(default)]
    pub shared_memory_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct ExtensionSmokeStatus {
    pub promoted: bool,
    pub direct: String,
    pub server: String,
    pub restart: String,
    pub dump_restore: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmLinkMetadata {
    pub has_dylink0: bool,
    #[serde(default)]
    pub dylink_needed: Vec<String>,
    #[serde(default)]
    pub dylink_runtime_paths: Vec<String>,
    #[serde(default)]
    pub dylink_memory: Option<WasmDylinkMemory>,
    #[serde(default)]
    pub dylink_imports: Vec<WasmDylinkSymbol>,
    #[serde(default)]
    pub dylink_exports: Vec<WasmDylinkSymbol>,
    #[serde(default)]
    pub imports: Vec<WasmImport>,
    #[serde(default)]
    pub exports: Vec<WasmExport>,
    #[serde(default)]
    pub memories: Vec<WasmMemory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmDylinkMemory {
    pub memory_size: u32,
    pub memory_alignment: u32,
    pub table_size: u32,
    pub table_alignment: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmDylinkSymbol {
    pub module: Option<String>,
    pub name: String,
    pub flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmImport {
    pub module: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmExport {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct WasmMemory {
    pub initial_pages: u64,
    pub maximum_pages: Option<u64>,
    pub memory64: bool,
    pub shared: bool,
    pub page_size_log2: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct SourcePin {
    pub name: String,
    pub url: String,
    pub branch: String,
    pub commit: String,
}

pub fn manifest() -> Result<AssetManifest, serde_json::Error> {
    serde_json::from_str(MANIFEST_JSON)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_and_keeps_core_payload_extension_free() {
        let manifest = manifest().expect("asset manifest should parse");
        if !HAS_EMBEDDED_ASSETS {
            assert_eq!(manifest.runtime.runtime_kind, "source-only-template");
            assert!(manifest.extensions.is_empty());
            return;
        }
        assert_eq!(manifest.runtime.postgres_version, "18.4");
        assert_eq!(manifest.runtime.runtime_kind, "wasix-dynamic-main");
        assert!(manifest.extensions.is_empty());
    }

    #[test]
    fn pg18_manifest_metadata_round_trips() {
        let manifest: AssetManifest = serde_json::from_str(
            r#"{
              "format-version": 1,
              "source-lane": "stable",
              "source-fingerprint": "postgresql-18.4:patch-stack",
              "runtime": {
                "archive": "oliphaunt.wasix.tar.zst",
                "sha256": "runtime-archive",
                "module-sha256": "runtime-module",
                "postgres-version": "18.4",
                "runtime-kind": "wasix-dynamic-main"
              },
              "runtime-support": [],
              "pgdata-template": {
                "archive": "prepopulated/pgdata-template.tar.zst",
                "manifest": "prepopulated/pgdata-template.json",
                "sha256": "template-archive",
                "size": 1,
                "runtime-module-sha256": "runtime-module",
                "initdb-module-sha256": "initdb-module",
                "source-pins-sha256": "source-pins",
                "source-lane": "stable",
                "source-fingerprint": "postgresql-18.4:patch-stack",
                "postgres-version": "18",
                "catalog-version": "202505281",
                "init-profile": "default",
                "wasmer-version": "6.0.0"
              },
              "extensions": [],
              "sources": []
            }"#,
        )
        .expect("PG18 asset manifest metadata should parse");

        assert_eq!(manifest.source_lane.as_deref(), Some("stable"));
        assert_eq!(
            manifest.source_fingerprint.as_deref(),
            Some("postgresql-18.4:patch-stack")
        );
        let template = manifest.pgdata_template.expect("PGDATA template asset");
        assert_eq!(template.source_lane.as_deref(), Some("stable"));
        assert_eq!(
            template.source_fingerprint.as_deref(),
            Some("postgresql-18.4:patch-stack")
        );
    }
}
