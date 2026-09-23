use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// An explicitly selected seed archive and its resource manifest.
/// Existing database directories do not need a seed.
#[derive(Debug, Clone)]
pub struct ClusterSeed {
    pub(crate) archive: Arc<[u8]>,
    pub(crate) manifest: Arc<[u8]>,
}

impl ClusterSeed {
    pub fn new(archive: impl Into<Arc<[u8]>>, manifest: impl AsRef<[u8]>) -> Self {
        Self {
            archive: archive.into(),
            manifest: Arc::from(manifest.as_ref()),
        }
    }
}

/// Explicitly selected canonical ICU data. Clones share the verified bytes.
#[derive(Debug, Clone)]
pub struct IcuData {
    pub(crate) data: Arc<[u8]>,
    pub(crate) tree_sha256: String,
}

impl IcuData {
    pub fn new(data: impl Into<Arc<[u8]>>, manifest: impl AsRef<[u8]>) -> crate::Result<Self> {
        crate::error::public_result(
            Self::validate(data.into(), manifest.as_ref())
                .map_err(crate::error::invalid_configuration),
        )
    }

    fn validate(data: Arc<[u8]>, manifest: &[u8]) -> Result<Self> {
        let mut fields = std::collections::BTreeMap::new();
        for line in std::str::from_utf8(manifest)?
            .lines()
            .filter(|line| !line.is_empty())
        {
            let (key, value) = line.split_once('=').context("invalid ICU manifest entry")?;
            ensure!(
                fields.insert(key, value).is_none(),
                "duplicate ICU manifest field {key}"
            );
        }
        ensure!(fields.len() == 5, "unexpected ICU manifest fields");
        for (key, expected) in [
            ("schema", "oliphaunt-icu-data-v1"),
            ("artifactRole", "icu-data"),
            ("icuDataVersion", "76.1"),
            ("icuDataForm", "files-le"),
        ] {
            ensure!(
                fields.get(key) == Some(&expected),
                "unsupported ICU manifest {key}"
            );
        }
        ensure!(!data.is_empty(), "ICU data is empty");
        let mut hash = Sha256::new();
        hash.update(b"icudt76l.dat\0");
        hash.update(data.len().to_string().as_bytes());
        hash.update([0]);
        hash.update(&data);
        hash.update(b"\n");
        let tree_sha256 = format!("{:x}", hash.finalize());
        ensure!(
            fields.get("icuDataTreeSha256") == Some(&tree_sha256.as_str()),
            "ICU data does not match its manifest"
        );
        Ok(Self { data, tree_sha256 })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetManifestMetadata {
    pub source_lane: Option<String>,
    pub source_fingerprint: Option<String>,
    pub postgres_version: String,
    pub runtime_module_sha256: String,
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
        if self == Self::Icu && !cfg!(feature = "icu") {
            return Err(crate::error::invalid_configuration(
                "the ICU catalog profile requires the oliphaunt-wasix `icu` feature",
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

pub const fn default_catalog_profile() -> CatalogProfile {
    if cfg!(feature = "icu") {
        CatalogProfile::Icu
    } else {
        CatalogProfile::Standard
    }
}

pub fn asset_manifest_metadata() -> Result<AssetManifestMetadata> {
    asset_manifest_metadata_for(default_catalog_profile())
}

pub(crate) fn asset_manifest_metadata_for(
    _selected_profile: CatalogProfile,
) -> Result<AssetManifestMetadata> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;

    Ok(AssetManifestMetadata {
        source_lane: manifest.source_lane,
        source_fingerprint: manifest.source_fingerprint,
        postgres_version: manifest.runtime.postgres_version,
        runtime_module_sha256: manifest.runtime.module_sha256,
    })
}

pub(crate) fn runtime_archive() -> Option<&'static [u8]> {
    liboliphaunt_wasix_portable::runtime_archive()
}

pub(crate) fn expected_runtime_archive_sha256() -> Result<String> {
    let manifest =
        liboliphaunt_wasix_portable::manifest().context("parse oliphaunt-wasix asset manifest")?;
    Ok(manifest.runtime.sha256)
}

#[cfg(feature = "tools")]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::pg_dump_wasm()
}

#[cfg(feature = "tools")]
pub(crate) fn psql_wasm() -> Option<&'static [u8]> {
    oliphaunt_wasix_tools::psql_wasm()
}

#[cfg(all(feature = "tools-execution", not(feature = "tools")))]
pub(crate) fn pg_dump_wasm() -> Option<&'static [u8]> {
    None
}

#[cfg(all(feature = "tools-execution", not(feature = "tools")))]
pub(crate) fn psql_wasm() -> Option<&'static [u8]> {
    None
}

pub(crate) fn icu_data_archive(profile: CatalogProfile) -> Option<&'static [u8]> {
    if profile == CatalogProfile::Standard {
        return None;
    }
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
    use super::{
        CatalogProfile, asset_manifest_metadata, expected_icu_data_archive_sha256,
        expected_icu_data_tree_sha256, expected_runtime_archive_sha256, icu_data_archive,
        runtime_archive,
    };

    #[test]
    fn asset_helpers_expose_a_consistent_feature_contract() {
        let default_profile = if cfg!(feature = "icu") {
            CatalogProfile::Icu
        } else {
            CatalogProfile::Standard
        };
        assert_eq!(CatalogProfile::default(), default_profile);
        CatalogProfile::Standard.validate_available().unwrap();
        assert_eq!(
            CatalogProfile::Icu.validate_available().is_ok(),
            cfg!(feature = "icu")
        );

        asset_manifest_metadata().unwrap();
        let has_embedded_assets = liboliphaunt_wasix_portable::HAS_EMBEDDED_ASSETS;
        assert_eq!(
            !expected_runtime_archive_sha256().unwrap().is_empty(),
            has_embedded_assets
        );
        assert_eq!(runtime_archive().is_some(), has_embedded_assets);
        assert!(icu_data_archive(CatalogProfile::Standard).is_none());
        let has_icu_assets = icu_data_archive(CatalogProfile::Icu).is_some();
        assert_eq!(expected_icu_data_archive_sha256().is_some(), has_icu_assets);
        assert_eq!(expected_icu_data_tree_sha256().is_some(), has_icu_assets);
    }
}
