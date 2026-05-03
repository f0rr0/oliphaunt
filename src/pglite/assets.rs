#[cfg(feature = "extensions")]
use anyhow::{Context, Result, anyhow};
#[cfg(feature = "extensions")]
use std::sync::{Arc, OnceLock};

#[cfg(feature = "extensions")]
static ASSET_MANIFEST: OnceLock<
    std::result::Result<Arc<pglite_oxide_assets::AssetManifest>, String>,
> = OnceLock::new();

#[cfg(feature = "extensions")]
fn asset_manifest() -> Result<Arc<pglite_oxide_assets::AssetManifest>> {
    ASSET_MANIFEST
        .get_or_init(|| {
            pglite_oxide_assets::manifest()
                .map(Arc::new)
                .map_err(|err| err.to_string())
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

#[cfg(feature = "extensions")]
pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    pglite_oxide_assets::runtime_archive()
}

#[cfg(not(feature = "extensions"))]
pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    pglite_oxide_assets::pgdata_template_archive()
}

#[cfg(not(feature = "extensions"))]
pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    pglite_oxide_assets::pgdata_template_manifest()
}

#[cfg(not(feature = "extensions"))]
pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
#[allow(dead_code)]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    pglite_oxide_assets::pg_dump_wasm()
}

#[cfg(not(feature = "extensions"))]
#[allow(dead_code)]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    pglite_oxide_assets::initdb_wasm()
}

#[cfg(not(feature = "extensions"))]
#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    None
}

#[cfg(feature = "extensions")]
pub(crate) fn extension_archive(sql_name: &str) -> Option<&'static [u8]> {
    pglite_oxide_assets::extension_archive(sql_name)
}

#[cfg(feature = "extensions")]
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

#[cfg(feature = "extensions")]
pub(crate) fn expected_module_sha256(name: &str) -> Result<String> {
    let manifest = asset_manifest().context("parse embedded asset manifest")?;
    if name == "runtime:pglite" {
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
