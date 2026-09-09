#![deny(unsafe_code)]

include!(concat!(env!("OUT_DIR"), "/generated_icu.rs"));

/// Select this optional ICU package for a native or WASIX database.
pub const ICU: oliphaunt_resources::IcuData = oliphaunt_resources::IcuData {
    version: env!("CARGO_PKG_VERSION"),
    native_runtime_version: env!("OLIPHAUNT_ICU_NATIVE_RUNTIME_VERSION"),
    runtime_version: env!("CARGO_PKG_VERSION"),
    resources: include!(concat!(env!("OUT_DIR"), "/native_icu.rs")),
    wasix_archive: icu_data_archive(),
    wasix_archive_sha256: ICU_DATA_ARCHIVE_SHA256,
    wasix_data_tree_sha256: ICU_DATA_TREE_SHA256,
    wasix_seed_archive: ICU_SEED_ARCHIVE,
    wasix_seed_manifest: ICU_SEED_MANIFEST,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_identities_track_the_embedded_payload() {
        assert_eq!(HAS_ICU_DATA, icu_data_archive().is_some());
        assert_eq!(HAS_ICU_DATA, ICU_DATA_ARCHIVE_SHA256.is_some());
        assert_eq!(HAS_ICU_DATA, ICU_DATA_TREE_SHA256.is_some());
    }
}
