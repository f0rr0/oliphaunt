use std::fs;
use std::path::Path;

pub(crate) fn text(shared_relative: &str, packaged_relative: &str) -> String {
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        package_root
            .join("../../shared/fixtures")
            .join(shared_relative),
        package_root.join(packaged_relative),
    ];
    for candidate in &candidates {
        if let Ok(value) = fs::read_to_string(candidate) {
            return value;
        }
    }
    panic!(
        "missing shared test fixture {shared_relative}; checked {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
}
