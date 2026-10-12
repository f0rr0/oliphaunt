use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn root() -> PathBuf {
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let package_root = std::env::var_os("TEST_SRCDIR")
        .zip(std::env::var_os("TEST_WORKSPACE"))
        .filter(|_| !package_root.is_absolute())
        .map(|(root, workspace)| PathBuf::from(root).join(workspace).join(package_root))
        .unwrap_or_else(|| package_root.to_path_buf());
    let packaged = package_root.join("testdata");
    if packaged.is_dir() {
        return packaged;
    }
    package_root
        .ancestors()
        .map(|ancestor| ancestor.join("test-fixtures"))
        .find(|candidate| candidate.is_dir())
        .expect("shared test fixtures are missing from the checkout or package")
}

pub(crate) fn text(relative: &str) -> String {
    let path = root().join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read test fixture {}: {error}", path.display()))
}
