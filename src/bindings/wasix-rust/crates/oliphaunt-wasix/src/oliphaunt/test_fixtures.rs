use std::fs;
use std::path::Path;

pub(crate) fn text(shared_relative: &str, packaged_name: &str) -> String {
    source_text(&format!("shared/fixtures/{shared_relative}"), packaged_name)
}

pub(crate) fn source_text(src_relative: &str, packaged_name: &str) -> String {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let shared = manifest_dir.join("../../../../").join(src_relative);
    let packaged = manifest_dir.join("src/testdata").join(packaged_name);
    fs::read_to_string(&shared)
        .or_else(|shared_error| {
            fs::read_to_string(&packaged).map_err(|packaged_error| {
                std::io::Error::new(
                    packaged_error.kind(),
                    format!(
                        "read shared fixture {} ({shared_error}) or packaged fixture {} ({packaged_error})",
                        shared.display(),
                        packaged.display()
                    ),
                )
            })
        })
        .unwrap_or_else(|error| panic!("{error}"))
}
