use anyhow::{Context, Result, ensure};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetManifestMetadata {
    pub source_lane: Option<String>,
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub runtime_module_sha256: String,
    pub cluster_seed_source_lane: Option<String>,
    pub cluster_seed_source_fingerprint: Option<String>,
    pub cluster_seed_postgres_version: Option<String>,
    pub cluster_seed_profile: String,
    pub cluster_seed_compatibility_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogProfile {
    Standard,
    Icu,
}

impl CatalogProfile {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Icu => "icu",
        }
    }
}

pub(crate) const fn selected_catalog_profile() -> CatalogProfile {
    if cfg!(feature = "icu") {
        CatalogProfile::Icu
    } else {
        CatalogProfile::Standard
    }
}

pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;
    if liboliphaunt_wasix_portable::HAS_EMBEDDED_ASSETS {
        let seed = manifest
            .cluster_seeds
            .get(selected_catalog_profile().as_str())
            .context("embedded WASIX assets are missing the selected cluster seed entry")?;
        validate_embedded_source_fingerprints(
            manifest.source_fingerprint.as_deref(),
            seed.source_fingerprint.as_deref(),
        )?;
    }
    let selected_profile = selected_catalog_profile();
    let seed = manifest.cluster_seeds.get(selected_profile.as_str());
    Ok(AssetManifestMetadata {
        source_lane: manifest.source_lane,
        source_fingerprint: manifest.source_fingerprint,
        postgres_version: manifest.runtime.postgres_version,
        runtime_module_sha256: manifest.runtime.module_sha256,
        cluster_seed_source_lane: seed.and_then(|seed| seed.source_lane.clone()),
        cluster_seed_source_fingerprint: seed.and_then(|seed| seed.source_fingerprint.clone()),
        cluster_seed_postgres_version: seed.map(|seed| seed.postgres_version.clone()),
        cluster_seed_profile: selected_profile.as_str().to_owned(),
        cluster_seed_compatibility_key: seed
            .map(|seed| seed.compatibility_key.clone())
            .unwrap_or_default(),
    })
}

fn validate_embedded_source_fingerprints(
    asset_fingerprint: Option<&str>,
    seed_fingerprint: Option<&str>,
) -> Result<()> {
    let asset_fingerprint = asset_fingerprint
        .filter(|value| !value.trim().is_empty())
        .context("embedded WASIX asset manifest is missing source-fingerprint metadata")?;
    let seed_fingerprint = seed_fingerprint
        .filter(|value| !value.trim().is_empty())
        .context("embedded WASIX cluster seed is missing source-fingerprint metadata")?;
    ensure!(
        seed_fingerprint == asset_fingerprint,
        "embedded WASIX runtime and cluster seed source fingerprints differ"
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

pub(crate) fn cluster_seed_archive() -> Option<&'static [u8]> {
    match selected_catalog_profile() {
        CatalogProfile::Standard => liboliphaunt_wasix_portable::standard_cluster_seed_archive(),
        CatalogProfile::Icu => {
            #[cfg(feature = "icu")]
            {
                liboliphaunt_wasix_portable::icu_cluster_seed_archive()
            }
            #[cfg(not(feature = "icu"))]
            {
                None
            }
        }
    }
}

pub(crate) fn cluster_seed_manifest() -> Option<&'static [u8]> {
    match selected_catalog_profile() {
        CatalogProfile::Standard => liboliphaunt_wasix_portable::standard_cluster_seed_manifest(),
        CatalogProfile::Icu => {
            #[cfg(feature = "icu")]
            {
                liboliphaunt_wasix_portable::icu_cluster_seed_manifest()
            }
            #[cfg(not(feature = "icu"))]
            {
                None
            }
        }
    }
}

#[cfg(feature = "tools")]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::pg_dump_wasm()
}

#[cfg(feature = "tools")]
pub(crate) fn psql_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::psql_wasm()
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

pub(crate) fn expected_icu_data_archive_sha256() -> Option<&'static str> {
    #[cfg(feature = "icu")]
    {
        oliphaunt_icu::ICU_DATA_ARCHIVE_SHA256
    }
    #[cfg(not(feature = "icu"))]
    {
        None
    }
}

pub(crate) fn expected_icu_data_tree_sha256() -> Option<&'static str> {
    #[cfg(feature = "icu")]
    {
        oliphaunt_icu::ICU_DATA_TREE_SHA256
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
            crate::error::invalid_configuration(format!(
                "extension asset '{sql_name}' is not embedded in this oliphaunt-wasix build"
            ))
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
        assert!(validate_embedded_source_fingerprints(Some("runtime"), Some("seed")).is_err());
    }
}
