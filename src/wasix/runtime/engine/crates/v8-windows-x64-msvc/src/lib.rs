//! Internal build carrier. Release packaging supplies the same verified engine bytes.
pub fn write_dll(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::write(
        path,
        include_bytes!(concat!(env!("OUT_DIR"), "/oliphaunt_wee8.dll")),
    )
}
