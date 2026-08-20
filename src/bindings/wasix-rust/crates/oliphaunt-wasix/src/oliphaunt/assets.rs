#[cfg(feature = "extensions")]
use anyhow::anyhow;
use anyhow::{Context, Result, ensure};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetManifestMetadata {
    pub source_lane: Option<String>,
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub runtime_module_sha256: String,
    pub pgdata_template_source_lane: Option<String>,
    pub pgdata_template_source_fingerprint: Option<String>,
    pub pgdata_template_postgres_version: Option<String>,
}

pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;
    if liboliphaunt_wasix_portable::HAS_EMBEDDED_ASSETS {
        let template = manifest
            .pgdata_template
            .as_ref()
            .context("embedded WASIX assets are missing the PGDATA template entry")?;
        validate_embedded_source_fingerprints(
            manifest.source_fingerprint.as_deref(),
            template.source_fingerprint.as_deref(),
        )?;
    }
    Ok(AssetManifestMetadata {
        source_lane: manifest.source_lane,
        source_fingerprint: manifest.source_fingerprint,
        postgres_version: manifest.runtime.postgres_version,
        runtime_module_sha256: manifest.runtime.module_sha256,
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

fn validate_embedded_source_fingerprints(
    asset_fingerprint: Option<&str>,
    template_fingerprint: Option<&str>,
) -> Result<()> {
    let asset_fingerprint = asset_fingerprint
        .filter(|value| !value.trim().is_empty())
        .context("embedded WASIX asset manifest is missing source-fingerprint metadata")?;
    let template_fingerprint = template_fingerprint
        .filter(|value| !value.trim().is_empty())
        .context("embedded WASIX PGDATA template is missing source-fingerprint metadata")?;
    ensure!(
        template_fingerprint == asset_fingerprint,
        "embedded WASIX runtime and PGDATA template source fingerprints differ"
    );
    Ok(())
}

pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::runtime_archive()
}

pub(crate) fn expected_runtime_archive_sha256() -> Result<String> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;
    Ok(manifest.runtime.sha256)
}

pub(crate) fn pgdata_template_archive() -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::pgdata_template_archive()
}

pub(crate) fn pgdata_template_manifest() -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::pgdata_template_manifest()
}

#[cfg(feature = "tools")]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::pg_dump_wasm()
}

#[cfg(feature = "tools")]
pub(crate) fn psql_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::psql_wasm()
}

#[allow(dead_code)]
pub(crate) fn initdb_wasm() -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::initdb_wasm()
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
    liboliphaunt_wasix_portable::extension_archive(sql_name)
}

#[cfg(feature = "extensions")]
pub(crate) fn expected_extension_archive_sha256(sql_name: &str) -> Result<String> {
    liboliphaunt_wasix_portable::expected_extension_archive_sha256(sql_name)
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow!("extension asset '{sql_name}' is not embedded in this oliphaunt-wasix build")
        })
}

#[cfg(feature = "extensions")]
pub(crate) fn extension_aot_manifest_json(target: &str, sql_name: &str) -> Option<&'static str> {
    liboliphaunt_wasix_portable::extension_aot_manifest_json(target, sql_name)
}

#[cfg(feature = "extensions")]
pub(crate) fn extension_aot_artifact_bytes(target: &str, name: &str) -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::extension_aot_artifact_bytes(target, name)
}

#[cfg(test)]
mod tests {
    use super::validate_embedded_source_fingerprints;

    #[test]
    fn embedded_source_fingerprints_are_required_and_equal() {
        validate_embedded_source_fingerprints(Some("source-key"), Some("source-key"))
            .expect("matching identities");
        assert!(validate_embedded_source_fingerprints(None, Some("source-key")).is_err());
        assert!(validate_embedded_source_fingerprints(Some("source-key"), Some(" ")).is_err());
        assert!(validate_embedded_source_fingerprints(Some("runtime"), Some("template")).is_err());
    }
}
