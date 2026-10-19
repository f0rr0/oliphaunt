use std::{fs, path::PathBuf};

use liboliphaunt_native_bindings::{
    DatabaseStorage, NativeClusterSeed, NativeConfig, NativeResourceDirectory, NativeSession,
    PreparedNativeRoot,
};

#[test]
#[ignore = "requires prepared native runtime and explicit standard/ICU seed and ICU data resources"]
fn explicit_resources_initialize_reopen_and_reject_corruption() {
    let path = |name| {
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")))
    };
    let standard = path("OLIPHAUNT_TEST_STANDARD_SEED");
    let icu = path("OLIPHAUNT_TEST_ICU_SEED");
    let icu_data = NativeResourceDirectory {
        directory: path("OLIPHAUNT_TEST_ICU_DATA"),
        manifest: path("OLIPHAUNT_TEST_ICU_MANIFEST"),
    };
    let scratch = Scratch(std::env::temp_dir().join(format!(
            "oliphaunt-explicit-resources-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    fs::create_dir_all(scratch.path()).unwrap();
    let profile = std::env::var("OLIPHAUNT_TEST_PROFILE")
        .expect("OLIPHAUNT_TEST_PROFILE is required (standard or icu), each in a fresh process");
    assert!(profile == "standard" || profile == "icu");
    for (name, seed_dir, data) in [("standard", &standard, None), ("icu", &icu, Some(icu_data))]
        .into_iter()
        .filter(|(name, _, _)| *name == profile)
    {
        let root = scratch.path().join(name);
        let mut config = NativeConfig {
            storage: DatabaseStorage::Directory(root.clone()),
            seed: Some(NativeClusterSeed::new(
                fs::read(seed_dir.join("seed.tar.zst")).unwrap(),
                fs::read(seed_dir.join("manifest.json")).unwrap(),
            )),
            icu_data: data,
            ..NativeConfig::default()
        };
        let mut session = NativeSession::open(config.clone()).unwrap();
        let sql = if name == "icu" {
            "SELECT 'a' < 'b' COLLATE \"und-x-icu\""
        } else {
            "SELECT 42"
        };
        let mut request = vec![b'Q'];
        request.extend_from_slice(&((sql.len() + 5) as u32).to_be_bytes());
        request.extend_from_slice(sql.as_bytes());
        request.push(0);
        let response = session.exec_protocol_raw(&request).unwrap();
        let mut frames = response.as_slice();
        let mut has_row = false;
        while !frames.is_empty() {
            assert!(frames.len() >= 5);
            let length = u32::from_be_bytes(frames[1..5].try_into().unwrap()) as usize;
            assert!(length >= 4 && frames.len() > length);
            assert_ne!(
                frames[0],
                b'E',
                "query returned an error: {:?}",
                String::from_utf8_lossy(frames)
            );
            has_row |= frames[0] == b'D';
            frames = &frames[length + 1..];
        }
        assert!(has_row, "query must return a data row");
        session.close_terminal().unwrap();
        config.seed = Some(NativeClusterSeed::new(vec![0], b"invalid"));
        let reopened = PreparedNativeRoot::prepare(&config, &[]).unwrap();
        assert!(reopened.pgdata.join("global/pg_control").is_file());
        drop(reopened);
        config.storage = DatabaseStorage::Directory(scratch.path().join(format!("corrupt-{name}")));
        assert!(PreparedNativeRoot::prepare(&config, &[]).is_err());
        let DatabaseStorage::Directory(rejected) = &config.storage else {
            unreachable!()
        };
        assert!(!rejected.join("pgdata").exists());
    }
    let fresh = NativeConfig {
        storage: DatabaseStorage::Directory(scratch.path().join("initdb")),
        ..NativeConfig::default()
    };
    let prepared = PreparedNativeRoot::prepare(&fresh, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(prepared.pgdata.join("PG_VERSION"))
            .unwrap()
            .trim(),
        "18"
    );
}

struct Scratch(PathBuf);
impl Scratch {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
