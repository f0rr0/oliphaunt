use std::collections::{BTreeMap, BTreeSet};

fn safe_payload_relative(relative: &str) {
    assert!(
        !relative
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\\' | ':'))
            && relative
                .split('/')
                .all(|part| !matches!(part, "" | "." | "..")),
        "invalid WASIX AOT payload path: {relative}"
    );
}

fn payload_files(root: &Path) -> Vec<(String, PathBuf)> {
    fn visit(root: &Path, current: &Path, files: &mut Vec<(String, PathBuf)>) {
        for entry in fs::read_dir(current).expect("read WASIX AOT payload directory") {
            let entry = entry.expect("read WASIX AOT payload entry");
            let path = entry.path();
            let kind = entry.file_type().expect("read WASIX AOT payload file type");
            if kind.is_dir() {
                visit(root, &path, files);
            } else {
                assert!(
                    kind.is_file() || (kind.is_symlink() && path.is_file()),
                    "WASIX AOT payload must contain regular files"
                );
                let relative = path
                    .strip_prefix(root)
                    .expect("WASIX AOT payload relative path")
                    .to_str()
                    .expect("WASIX AOT payload path is UTF-8")
                    .replace('\\', "/");
                safe_payload_relative(&relative);
                files.push((relative, path));
            }
        }
    }
    let mut files = Vec::new();
    if root.is_dir() {
        visit(root, root, &mut files);
    }
    files
}

fn reconstruct_payload(part_roots: &[&str]) -> PathBuf {
    let artifacts =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo")).join("artifacts");
    if artifacts.exists() {
        fs::remove_dir_all(&artifacts).expect("remove stale WASIX AOT artifacts");
    }
    fs::create_dir_all(&artifacts).expect("create WASIX AOT artifacts");
    let mut files = BTreeMap::new();
    let mut chunks: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in part_roots {
        let root = Path::new(root);
        let root = if root.is_absolute() {
            root.to_owned()
        } else {
            safe_payload_relative(root.to_str().expect("WASIX AOT part path is UTF-8"));
            let base = PathBuf::from(
                env::var_os("OLIPHAUNT_BAZEL_EXEC_ROOT")
                    .expect("relative WASIX AOT parts require their declared Bazel execution root"),
            );
            assert!(
                base.is_absolute(),
                "WASIX AOT execution root must be absolute"
            );
            base.join(root)
        };
        assert!(
            root.is_dir(),
            "missing WASIX AOT payload part: {}",
            root.display()
        );
        println!("cargo:rerun-if-changed={}", root.display());
        for (relative, file) in payload_files(&root.join("files")) {
            assert!(
                files.insert(relative.clone(), file).is_none(),
                "duplicate WASIX AOT payload file: {relative}"
            );
        }
        for (relative, file) in payload_files(&root.join("chunks")) {
            let (name, index) = relative
                .rsplit_once(".part")
                .expect("WASIX AOT chunk needs a .part suffix");
            safe_payload_relative(name);
            assert!(
                index.len() == 3 && index.bytes().all(|byte| byte.is_ascii_digit()),
                "invalid WASIX AOT chunk index: {relative}"
            );
            chunks
                .entry(name.to_owned())
                .or_default()
                .push((index.parse().expect("WASIX AOT chunk index"), file));
        }
    }
    for (relative, source) in &files {
        let destination = artifacts.join(relative);
        fs::create_dir_all(destination.parent().expect("WASIX AOT payload parent"))
            .expect("create WASIX AOT payload parent");
        fs::copy(source, destination).expect("copy WASIX AOT payload file");
    }
    for (relative, mut rows) in chunks {
        assert!(
            !files.contains_key(&relative),
            "WASIX AOT payload mixes complete and chunked file: {relative}"
        );
        rows.sort_by_key(|(index, _)| *index);
        let destination = artifacts.join(&relative);
        fs::create_dir_all(destination.parent().expect("WASIX AOT chunk parent"))
            .expect("create WASIX AOT chunk parent");
        let mut writer =
            fs::File::create(destination).expect("create WASIX AOT reconstructed file");
        for (expected, (actual, chunk)) in rows.iter().enumerate() {
            assert_eq!(
                *actual, expected,
                "non-contiguous WASIX AOT chunks for {relative}"
            );
            io::copy(
                &mut fs::File::open(chunk).expect("open WASIX AOT chunk"),
                &mut writer,
            )
            .expect("append WASIX AOT chunk");
        }
    }
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(artifacts.join("manifest.json")).expect("read WASIX AOT part manifest"),
    )
    .expect("parse WASIX AOT part manifest");
    let mut expected = BTreeSet::new();
    for artifact in manifest["artifacts"]
        .as_array()
        .expect("WASIX AOT manifest artifacts")
    {
        let relative = artifact["path"].as_str().expect("WASIX AOT artifact path");
        safe_payload_relative(relative);
        assert!(
            expected.insert(relative.to_owned()),
            "duplicate WASIX AOT artifact path"
        );
        assert_eq!(
            sha256_file(&artifacts.join(relative)).expect("hash reconstructed WASIX AOT artifact"),
            artifact["sha256"]
                .as_str()
                .expect("WASIX AOT artifact SHA-256"),
            "WASIX AOT payload digest mismatch for {relative}"
        );
    }
    let actual: BTreeSet<_> = payload_files(&artifacts)
        .into_iter()
        .filter(|(relative, _)| relative.ends_with(".zst"))
        .map(|(relative, _)| relative)
        .collect();
    assert_eq!(
        actual, expected,
        "WASIX AOT payload artifact file set mismatch"
    );
    artifacts
}
