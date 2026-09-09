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

/// Packaged PostgreSQL initialization and runtime-data profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogProfile {
    /// The standard PostgreSQL catalog without packaged ICU data.
    Standard,
    /// The ICU catalog with its matching packaged ICU data.
    Icu,
}

impl CatalogProfile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Icu => "icu",
        }
    }

    pub(crate) fn validate_available(self) -> Result<()> {
        if self == Self::Icu && SELECTED_ICU.get().is_none() {
            return Err(crate::error::invalid_configuration(
                "the ICU catalog profile requires explicitly selected ICU package data",
            ));
        }
        Ok(())
    }
}

impl Default for CatalogProfile {
    fn default() -> Self {
        default_catalog_profile()
    }
}

pub(crate) const fn default_catalog_profile() -> CatalogProfile {
    CatalogProfile::Standard
}

// One exact ICU release serves this runtime generation. Database selection stays
// on each builder; publishing data here never changes another builder's profile.
static SELECTED_ICU: std::sync::OnceLock<oliphaunt_resources::IcuData> = std::sync::OnceLock::new();

pub(crate) fn register_icu(data: oliphaunt_resources::IcuData) -> Result<()> {
    use sha2::{Digest, Sha256};
    ensure!(
        data.runtime_version == liboliphaunt_wasix_portable::PACKAGE_VERSION,
        "ICU package is incompatible with the selected WASIX runtime"
    );
    let archive = data
        .wasix_archive
        .context("selected ICU package has no WASIX archive")?;
    let expected = data
        .wasix_archive_sha256
        .context("selected ICU package has no archive digest")?;
    ensure!(
        format!("{:x}", Sha256::digest(archive)) == expected,
        "ICU package archive hash mismatch"
    );
    let tree = data
        .wasix_data_tree_sha256
        .context("selected ICU package has no logical tree digest")?;
    let manifest = liboliphaunt_wasix_portable::manifest()?;
    let seed = data
        .wasix_seed_archive
        .context("selected ICU package has no cluster seed")?;
    let seed_manifest = data
        .wasix_seed_manifest
        .context("selected ICU package has no seed manifest")?;
    let expected_seed = manifest
        .cluster_seeds
        .get("icu")
        .context("runtime has no ICU seed identity")?;
    ensure!(
        format!("{:x}", Sha256::digest(seed)) == expected_seed.sha256,
        "ICU cluster seed archive hash mismatch"
    );
    let parsed: serde_json::Value = serde_json::from_slice(seed_manifest)?;
    ensure!(
        parsed["catalogProfile"] == "icu"
            && parsed["runtime"]["version"] == data.runtime_version
            && parsed["icu"]["dataTreeSha256"] == tree,
        "ICU seed manifest does not match selected package"
    );
    ensure!(
        manifest
            .cluster_seeds
            .get("icu")
            .and_then(|seed| seed.icu_data_tree_sha256.as_deref())
            == Some(tree),
        "selected ICU package does not match the runtime's ICU seed"
    );
    let selected = SELECTED_ICU.get_or_init(|| data);
    ensure!(
        selected.version == data.version
            && selected.wasix_archive_sha256 == data.wasix_archive_sha256
            && selected.wasix_data_tree_sha256 == data.wasix_data_tree_sha256,
        "conflicting ICU packages for one WASIX runtime"
    );
    Ok(())
}

pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    asset_manifest_metadata_for(default_catalog_profile())
}

pub(crate) fn asset_manifest_metadata_for(
    selected_profile: CatalogProfile,
) -> Result<AssetManifestMetadata> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;
    if cluster_seed_manifest(selected_profile).is_some() {
        let seed = manifest
            .cluster_seeds
            .get(selected_profile.as_str())
            .context("embedded WASIX assets are missing the selected cluster seed entry")?;
        validate_embedded_source_fingerprints(
            manifest.source_fingerprint.as_deref(),
            seed.source_fingerprint.as_deref(),
        )?;
    }
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

pub(crate) fn cluster_seed_archive(profile: CatalogProfile) -> Option<&'static [u8]> {
    match profile {
        CatalogProfile::Standard => liboliphaunt_wasix_portable::standard_cluster_seed_archive(),
        CatalogProfile::Icu => SELECTED_ICU.get().and_then(|data| data.wasix_seed_archive),
    }
}

pub(crate) fn cluster_seed_manifest(profile: CatalogProfile) -> Option<&'static [u8]> {
    match profile {
        CatalogProfile::Standard => liboliphaunt_wasix_portable::standard_cluster_seed_manifest(),
        CatalogProfile::Icu => SELECTED_ICU.get().and_then(|data| data.wasix_seed_manifest),
    }
}

#[cfg(feature = "__internal-tools")]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    if let Some(bytes) = super::tools::installed_tool_wasm("pg_dump") {
        return Some(bytes);
    }
    #[cfg(feature = "tools")]
    {
        return oliphaunt_wasix_tools::pg_dump_wasm();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(feature = "__internal-tools")]
pub(crate) fn psql_wasm() -> Option<&'static [u8]> {
    if let Some(bytes) = super::tools::installed_tool_wasm("psql") {
        return Some(bytes);
    }
    #[cfg(feature = "tools")]
    {
        return oliphaunt_wasix_tools::psql_wasm();
    }
    #[allow(unreachable_code)]
    None
}

pub(crate) fn icu_data_archive(profile: CatalogProfile) -> Option<&'static [u8]> {
    if profile == CatalogProfile::Standard {
        return None;
    }
    SELECTED_ICU.get().and_then(|data| data.wasix_archive)
}

pub(crate) fn expected_icu_data_archive_sha256() -> Option<&'static str> {
    SELECTED_ICU
        .get()
        .and_then(|data| data.wasix_archive_sha256)
}

pub(crate) fn expected_icu_data_tree_sha256() -> Option<&'static str> {
    SELECTED_ICU
        .get()
        .and_then(|data| data.wasix_data_tree_sha256)
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
    use super::{
        CatalogProfile, asset_manifest_metadata, cluster_seed_archive, cluster_seed_manifest,
        expected_icu_data_archive_sha256, expected_icu_data_tree_sha256,
        expected_runtime_archive_sha256, icu_data_archive, runtime_archive,
        validate_embedded_source_fingerprints,
    };

    #[test]
    fn asset_helpers_expose_a_consistent_feature_contract() {
        let default_profile = CatalogProfile::Standard;
        assert_eq!(CatalogProfile::default(), default_profile);
        CatalogProfile::Standard.validate_available().unwrap();
        assert_eq!(
            CatalogProfile::Icu.validate_available().is_ok(),
            super::SELECTED_ICU.get().is_some()
        );

        let metadata = asset_manifest_metadata().unwrap();
        assert_eq!(metadata.cluster_seed_profile, default_profile.as_str());
        let has_embedded_assets = liboliphaunt_wasix_portable::HAS_EMBEDDED_ASSETS;
        assert_eq!(
            !expected_runtime_archive_sha256().unwrap().is_empty(),
            has_embedded_assets
        );
        assert_eq!(runtime_archive().is_some(), has_embedded_assets);
        assert_eq!(
            cluster_seed_archive(CatalogProfile::Standard).is_some(),
            has_embedded_assets
        );
        assert_eq!(
            cluster_seed_manifest(CatalogProfile::Standard).is_some(),
            has_embedded_assets
        );
        assert!(icu_data_archive(CatalogProfile::Standard).is_none());
        let has_icu_assets = icu_data_archive(CatalogProfile::Icu).is_some();
        assert_eq!(expected_icu_data_archive_sha256().is_some(), has_icu_assets);
        assert_eq!(expected_icu_data_tree_sha256().is_some(), has_icu_assets);
    }

    #[test]
    fn embedded_source_fingerprints_are_required_and_equal() {
        validate_embedded_source_fingerprints(Some("source-key"), Some("source-key"))
            .expect("matching identities");
        assert!(validate_embedded_source_fingerprints(None, Some("source-key")).is_err());
        assert!(validate_embedded_source_fingerprints(Some("source-key"), Some(" ")).is_err());
        assert!(validate_embedded_source_fingerprints(Some("runtime"), Some("seed")).is_err());
    }
}
