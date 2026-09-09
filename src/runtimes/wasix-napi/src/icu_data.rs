use napi::{Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use oliphaunt_wasix::IcuData;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[napi(object)]
pub struct NativeIcuData {
    pub version: String,
    pub runtime_version: String,
    pub archive: Buffer,
    pub archive_sha256: String,
    pub data_tree_sha256: String,
    pub seed_archive: Buffer,
    pub seed_archive_sha256: String,
    pub seed_manifest: Buffer,
    pub seed_manifest_sha256: String,
}

static ICU: OnceLock<IcuData> = OnceLock::new();

pub(super) fn load(profile: &str, input: Option<NativeIcuData>) -> Result<Option<IcuData>> {
    let Some(input) = input else {
        if profile == "icu" {
            return Err(super::invalid_argument(
                "ICU profile requires the optional ICU package",
            ));
        }
        return Ok(None);
    };
    if profile != "icu" || input.runtime_version != super::RUNTIME_VERSION {
        return Err(super::invalid_argument(
            "ICU data does not match the selected runtime/profile",
        ));
    }
    for (bytes, expected) in [
        (&input.archive, &input.archive_sha256),
        (&input.seed_archive, &input.seed_archive_sha256),
        (&input.seed_manifest, &input.seed_manifest_sha256),
    ] {
        if format!("{:x}", Sha256::digest(bytes.as_ref())) != *expected {
            return Err(super::invalid_argument("ICU package payload hash mismatch"));
        }
    }
    let seed: serde_json::Value = serde_json::from_slice(&input.seed_manifest)
        .map_err(|_| super::invalid_argument("invalid ICU seed manifest"))?;
    if seed["catalogProfile"] != "icu"
        || seed["runtime"]["version"] != input.runtime_version
        || seed["icu"]["dataTreeSha256"] != input.data_tree_sha256
    {
        return Err(super::invalid_argument("ICU data and seed do not match"));
    }
    let runtime = liboliphaunt_wasix_portable::manifest()
        .map_err(|error| super::invalid_argument(error.to_string()))?;
    let expected = runtime
        .cluster_seeds
        .get("icu")
        .ok_or_else(|| super::invalid_argument("runtime has no ICU seed identity"))?;
    if expected.sha256 != input.seed_archive_sha256
        || expected.icu_data_tree_sha256.as_deref() != Some(&input.data_tree_sha256)
    {
        return Err(super::invalid_argument(
            "ICU package does not match the runtime seed identity",
        ));
    }
    let data = ICU.get_or_init(|| IcuData {
        version: Box::leak(input.version.clone().into_boxed_str()),
        runtime_version: super::RUNTIME_VERSION,
        native_runtime_version: "unavailable",
        resources: &[],
        wasix_archive: Some(Box::leak(input.archive.to_vec().into_boxed_slice())),
        wasix_archive_sha256: Some(Box::leak(input.archive_sha256.clone().into_boxed_str())),
        wasix_data_tree_sha256: Some(Box::leak(input.data_tree_sha256.clone().into_boxed_str())),
        wasix_seed_archive: Some(Box::leak(input.seed_archive.to_vec().into_boxed_slice())),
        wasix_seed_manifest: Some(Box::leak(input.seed_manifest.to_vec().into_boxed_slice())),
    });
    if data.version != input.version
        || data.wasix_archive_sha256 != Some(&input.archive_sha256)
        || data.wasix_seed_archive != Some(input.seed_archive.as_ref())
        || data.wasix_seed_manifest != Some(input.seed_manifest.as_ref())
    {
        return Err(super::invalid_argument(
            "conflicting ICU packages for one runtime",
        ));
    }
    Ok(Some(*data))
}
