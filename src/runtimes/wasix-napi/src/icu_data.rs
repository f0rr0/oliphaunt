use napi::{
    Result,
    bindgen_prelude::{Buffer, Either},
};
use napi_derive::napi;
use oliphaunt_wasix::IcuData;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[napi(object)]
pub struct NativeIcuData {
    pub version: String,
    pub runtime_version: String,
    pub archive: Either<Buffer, String>,
    pub archive_sha256: String,
    pub data_tree_sha256: String,
    pub seed_archive: Either<Buffer, String>,
    pub seed_archive_sha256: String,
    pub seed_manifest: Either<Buffer, String>,
    pub seed_manifest_sha256: String,
}

impl NativeIcuData {
    // Detach caller-owned JavaScript memory before crossing to a Rust owner.
    pub(super) fn snapshot(&mut self) {
        for source in [
            &mut self.archive,
            &mut self.seed_archive,
            &mut self.seed_manifest,
        ] {
            if let Either::A(bytes) = source {
                *bytes = Buffer::from(bytes.to_vec());
            }
        }
    }
}

fn bytes(source: Either<Buffer, String>) -> Result<Vec<u8>> {
    match source {
        Either::A(bytes) => Ok(bytes.to_vec()),
        Either::B(path) => std::fs::read(path)
            .map_err(|error| super::invalid_argument(format!("read ICU package: {error}"))),
    }
}

static ICU: OnceLock<(String, IcuData)> = OnceLock::new();

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
    let identity = format!(
        "{}:{}:{}:{}:{}",
        input.version,
        input.runtime_version,
        input.archive_sha256,
        input.seed_archive_sha256,
        input.seed_manifest_sha256
    );
    // Installed file packages are immutable within a process, like native imports.
    if matches!(
        (&input.archive, &input.seed_archive, &input.seed_manifest),
        (Either::B(_), Either::B(_), Either::B(_))
    ) {
        if let Some((key, data)) = ICU.get() {
            if key == &identity && data.wasix_data_tree_sha256 == Some(&input.data_tree_sha256) {
                return Ok(Some(*data));
            }
        }
    }
    let archive = bytes(input.archive)?;
    let seed_archive = bytes(input.seed_archive)?;
    let seed_manifest = bytes(input.seed_manifest)?;
    for (bytes, expected) in [
        (&archive, &input.archive_sha256),
        (&seed_archive, &input.seed_archive_sha256),
        (&seed_manifest, &input.seed_manifest_sha256),
    ] {
        if format!("{:x}", Sha256::digest(bytes)) != *expected {
            return Err(super::invalid_argument("ICU package payload hash mismatch"));
        }
    }
    let seed: serde_json::Value = serde_json::from_slice(&seed_manifest)
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
    let (key, data) = ICU.get_or_init(|| {
        (
            identity.clone(),
            IcuData {
                version: Box::leak(input.version.clone().into_boxed_str()),
                runtime_version: super::RUNTIME_VERSION,
                native_runtime_version: "unavailable",
                resources: &[],
                wasix_archive: Some(Box::leak(archive.into_boxed_slice())),
                wasix_archive_sha256: Some(Box::leak(
                    input.archive_sha256.clone().into_boxed_str(),
                )),
                wasix_data_tree_sha256: Some(Box::leak(
                    input.data_tree_sha256.clone().into_boxed_str(),
                )),
                wasix_seed_archive: Some(Box::leak(seed_archive.into_boxed_slice())),
                wasix_seed_manifest: Some(Box::leak(seed_manifest.into_boxed_slice())),
            },
        )
    });
    if key != &identity || data.wasix_data_tree_sha256 != Some(&input.data_tree_sha256) {
        return Err(super::invalid_argument(
            "conflicting ICU packages for one runtime",
        ));
    }
    Ok(Some(*data))
}
