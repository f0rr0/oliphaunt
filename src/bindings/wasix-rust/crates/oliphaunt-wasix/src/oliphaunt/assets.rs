#[cfg(feature = "bundled")]
use anyhow::{Context, Result, anyhow};
#[cfg(feature = "bundled")]
use std::sync::{Arc, OnceLock};

#[cfg(feature = "bundled")]
static ASSET_MANIFEST: OnceLock<
    std::result::Result<Arc<oliphaunt_wasix_assets::AssetManifest>, String>,
> = OnceLock::new();

#[cfg(feature = "bundled")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetManifestMetadata {
    pub source_lane: Option<String>,
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub pgdata_template_source_lane: Option<String>,
    pub pgdata_template_source_fingerprint: Option<String>,
    pub pgdata_template_postgres_version: Option<String>,
}

#[cfg(feature = "bundled")]
fn asset_manifest() -> Result<Arc<oliphaunt_wasix_assets::AssetManifest>> {
    ASSET_MANIFEST
        .get_or_init(|| {
            oliphaunt_wasix_assets::manifest()
                .map(Arc::new)
                .map_err(|err| err.to_string())
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

#[cfg(feature = "bundled")]
pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    let manifest = asset_manifest().context("parse embedded asset manifest")?;
    Ok(AssetManifestMetadata {
        source_lane: manifest.source_lane.clone(),
        source_fingerprint: manifest.source_fingerprint.clone(),
        postgres_version: manifest.runtime.postgres_version.clone(),
        pgdata_template_source_lane: manifest
            .pgdata_template
            .as_ref()
            .and_then(|template| template.source_lane.clone()),
        pgdata_template_source_fingerprint: manifest
            .pgdata_template
            .as_ref()
            .and_then(|template| template.source_fingerprint.clone()),
        pgdata_template_postgres_version: manifest
            .pgdata_template
            .as_ref()
            .map(|template| template.postgres_version.clone()),
    })
}

#[cfg(feature = "bundled")]
pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::runtime_archive()
}

#[cfg(not(feature = "bundled"))]
pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "bundled")]
pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pgdata_template_archive()
}

#[cfg(not(feature = "bundled"))]
pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "bundled")]
pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pgdata_template_manifest()
}

#[cfg(not(feature = "bundled"))]
pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "bundled")]
#[allow(dead_code)]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pg_dump_wasm()
}

#[cfg(not(feature = "bundled"))]
#[allow(dead_code)]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "bundled")]
#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::initdb_wasm()
}

#[cfg(not(feature = "bundled"))]
#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
pub(crate) fn extension_archive(sql_name: &str) -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::extension_archive(sql_name)
}

#[cfg(feature = "bundled")]
pub(crate) fn expected_runtime_archive_sha256() -> Result<String> {
    Ok(asset_manifest()
        .context("parse embedded asset manifest")?
        .runtime
        .sha256
        .clone())
}

#[cfg(feature = "extensions")]
pub(crate) fn expected_extension_archive_sha256(sql_name: &str) -> Result<String> {
    asset_manifest()
        .context("parse embedded asset manifest")?
        .extensions
        .iter()
        .find(|extension| extension.sql_name == sql_name)
        .map(|extension| extension.sha256.clone())
        .ok_or_else(|| anyhow!("extension asset '{sql_name}' is missing from asset manifest"))
}

#[cfg(feature = "bundled")]
pub(crate) fn expected_module_sha256(name: &str) -> Result<String> {
    let manifest = asset_manifest().context("parse embedded asset manifest")?;
    if name == "runtime:oliphaunt" {
        return Ok(manifest.runtime.module_sha256.clone());
    }
    if let Some(name) = name.strip_prefix("runtime-support:") {
        return manifest
            .runtime_support
            .iter()
            .find(|module| module.name == name)
            .map(|module| module.module_sha256.clone())
            .ok_or_else(|| {
                anyhow!("runtime support module '{name}' is missing from asset manifest")
            });
    }
    if name == "tool:pg_dump" {
        return manifest
            .pg_dump
            .as_ref()
            .map(|module| module.module_sha256.clone())
            .ok_or_else(|| anyhow!("pg_dump is missing from asset manifest"));
    }
    if name == "tool:initdb" {
        return manifest
            .initdb
            .as_ref()
            .map(|module| module.module_sha256.clone())
            .ok_or_else(|| anyhow!("initdb is missing from asset manifest"));
    }
    if let Some(sql_name) = name.strip_prefix("extension:") {
        if let Some((sql_name, module_name)) = sql_name.split_once(':') {
            return manifest
                .extensions
                .iter()
                .find(|extension| extension.sql_name == sql_name)
                .and_then(|extension| {
                    extension.native_modules.iter().find(|module| {
                        module.name == module_name || module.path.ends_with(module_name)
                    })
                })
                .map(|module| module.module_sha256.clone())
                .ok_or_else(|| {
                    anyhow!(
                        "extension module '{sql_name}:{module_name}' is missing from asset manifest"
                    )
                });
        }
        let module_sha256 = manifest
            .extensions
            .iter()
            .find(|extension| extension.sql_name == sql_name)
            .map(|extension| extension.module_sha256.clone())
            .ok_or_else(|| anyhow!("extension '{sql_name}' is missing from asset manifest"))?;
        if module_sha256.is_empty() {
            anyhow::bail!("extension '{sql_name}' has no native module in asset manifest");
        }
        return Ok(module_sha256);
    }
    Err(anyhow!("unknown asset module '{name}'"))
}
