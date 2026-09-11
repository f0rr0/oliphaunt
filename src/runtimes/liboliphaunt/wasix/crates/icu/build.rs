use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    let payload = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("payload");
    println!("cargo:rerun-if-changed={}", payload.display());
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD");
    let archive = payload.join("icu-data.tar.zst");
    let seed = payload.join("cluster-seeds/icu.tar.zst");
    let manifest = payload.join("cluster-seeds/icu.json");
    let fields = if archive.is_file() {
        let bytes = fs::read(&archive).expect("read ICU archive");
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).expect("read ICU seed manifest"))
                .expect("parse ICU seed manifest");
        assert_eq!(
            metadata["runtime"]["version"],
            env::var("CARGO_PKG_VERSION").unwrap()
        );
        assert_eq!(metadata["catalogProfile"], "icu");
        let tree = metadata["icu"]["dataTreeSha256"]
            .as_str()
            .expect("ICU tree digest");
        assert!(seed.is_file(), "missing ICU cluster seed");
        format!(
            "wasix_archive: Some(include_bytes!({archive:?})), wasix_archive_sha256: Some({hash:?}), wasix_data_tree_sha256: Some({tree:?}), wasix_seed_archive: Some(include_bytes!({seed:?})), wasix_seed_manifest: Some(include_bytes!({manifest:?})),"
        )
    } else {
        assert!(
            env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_none(),
            "release package requires ICU payload"
        );
        "wasix_archive: None, wasix_archive_sha256: None, wasix_data_tree_sha256: None, wasix_seed_archive: None, wasix_seed_manifest: None,".into()
    };
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("icu.rs"), format!("/// Optional ICU data for the matching WASIX runtime.\npub const ICU: oliphaunt_resources::IcuData = oliphaunt_resources::IcuData {{ version: env!(\"CARGO_PKG_VERSION\"), runtime_version: env!(\"CARGO_PKG_VERSION\"), native_runtime_version: \"unavailable\", resources: &[], {fields} }};\n")).expect("write ICU descriptor");
}
