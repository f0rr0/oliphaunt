#[cfg(feature = "v8")]
fn main() {
    use std::{env, fs, path::PathBuf};
    assert_eq!(env::var("TARGET").unwrap(), "x86_64-pc-windows-msvc");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let bindings = root.join("prebuilt/embedded_bindings.rs");
    println!("cargo:rerun-if-changed={}", bindings.display());
    fs::copy(bindings, output.join("v8_bindings.rs")).unwrap();
    oliphaunt_wasmer_v8_windows_x64_msvc::write_dll(&output.join("oliphaunt_wee8.dll")).unwrap();
}

#[cfg(not(feature = "v8"))]
fn main() {}
