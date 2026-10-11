use std::{env, fs, path::Path};

fn main() {
    assert_eq!(
        module_path!(),
        "build_script_build",
        "private compiler identity must match Cargo"
    );
    assert_eq!(env!("CARGO_CRATE_NAME"), "build_script_build");
    assert_eq!(env!("CARGO_PKG_NAME"), "oliphaunt-query");
    assert_eq!(env::var("CARGO_PKG_NAME").unwrap(), env!("CARGO_PKG_NAME"));
    assert_eq!(
        env::var("CARGO_PKG_VERSION").unwrap(),
        env!("CARGO_PKG_VERSION")
    );
    let output = Path::new(&env::var("OUT_DIR").unwrap()).join("observed.rs");
    fs::write(output, "pub const BUILD_SCRIPT_VALUE: u32 = 42;\n").unwrap();
}
