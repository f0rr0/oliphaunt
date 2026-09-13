#![deny(unsafe_code)]

/// Optional ICU data and seed for the matching native runtime.
pub const ICU: oliphaunt_resources::IcuData = oliphaunt_resources::IcuData {
    version: env!("CARGO_PKG_VERSION"),
    native_runtime_version: env!("CARGO_PKG_VERSION"),
    runtime_version: "unavailable",
    resources: include!(concat!(env!("OUT_DIR"), "/native_icu.rs")),
    wasix_archive: None,
    wasix_archive_sha256: None,
    wasix_data_tree_sha256: None,
    wasix_seed_archive: None,
    wasix_seed_manifest: None,
};
