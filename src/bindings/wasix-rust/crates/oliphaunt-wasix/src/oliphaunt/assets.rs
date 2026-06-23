#[cfg(feature = "extensions")]
use anyhow::anyhow;
use anyhow::{Context, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetManifestMetadata {
    pub source_lane: Option<String>,
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub pgdata_template_source_lane: Option<String>,
    pub pgdata_template_source_fingerprint: Option<String>,
    pub pgdata_template_postgres_version: Option<String>,
}

pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    let manifest =
        oliphaunt_wasix_assets::manifest().context("parse oliphaunt-wasix asset manifest")?;
    Ok(AssetManifestMetadata {
        source_lane: manifest.source_lane,
        source_fingerprint: manifest.source_fingerprint,
        postgres_version: manifest.runtime.postgres_version,
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

pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::runtime_archive()
}

pub(crate) fn expected_runtime_archive_sha256() -> Result<String> {
    let manifest =
        oliphaunt_wasix_assets::manifest().context("parse oliphaunt-wasix asset manifest")?;
    Ok(manifest.runtime.sha256)
}

pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pgdata_template_archive()
}

pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pgdata_template_manifest()
}

#[allow(dead_code)]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::pg_dump_wasm()
}

#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::initdb_wasm()
}

pub(crate) fn icu_data_archive() -> Option<&'static [u8]> {
    #[cfg(feature = "icu")]
    {
        oliphaunt_icu::icu_data_archive()
    }
    #[cfg(not(feature = "icu"))]
    {
        None
    }
}

#[cfg(feature = "extensions")]
pub(crate) fn extension_archive(sql_name: &str) -> Option<&'static [u8]> {
    oliphaunt_wasix_assets::extension_archive(sql_name)
}

#[cfg(feature = "extensions")]
pub(crate) fn expected_extension_archive_sha256(sql_name: &str) -> Result<String> {
    Err(anyhow!(
        "extension asset '{sql_name}' is not embedded in this oliphaunt-wasix build"
    ))
}
