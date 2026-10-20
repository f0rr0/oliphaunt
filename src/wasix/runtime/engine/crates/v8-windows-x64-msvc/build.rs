use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let source = root.join(
        "../../../../../../target/oliphaunt-wasix/engine/windows-x64-msvc/oliphaunt_wee8.dll",
    );
    println!("cargo:rerun-if-changed={}", source.display());
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::copy(&source, output.join("oliphaunt_wee8.dll"))
        .expect("build the Windows engine through liboliphaunt-wasix:engine-build first");
}
