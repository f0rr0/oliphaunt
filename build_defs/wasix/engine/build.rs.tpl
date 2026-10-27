#[cfg(feature = "v8")]
fn main() {
    assert_eq!(std::env::var("TARGET").unwrap(), "x86_64-pc-windows-msvc");
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let source = root.join("prebuilt/embedded_bindings.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    std::fs::copy(source, out.join("v8_bindings.rs")).unwrap();
    oliphaunt_wasmer_v8_windows_x64_msvc::write_dll(&out.join("oliphaunt_wee8.dll")).unwrap();
}

#[cfg(not(feature = "v8"))]
fn main() {}
