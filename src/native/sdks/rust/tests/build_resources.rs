#[test]
fn registered_resources_supply_the_native_library() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_some() {
        return;
    }
    let root =
        std::env::temp_dir().join(format!("oliphaunt-build-resources-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let library = root
        .join("native-runtime/liboliphaunt-native")
        .join(if cfg!(windows) { "bin" } else { "lib" })
        .join(if cfg!(windows) {
            "oliphaunt.dll"
        } else if cfg!(target_os = "macos") {
            "liboliphaunt.dylib"
        } else {
            "liboliphaunt.so"
        });
    std::fs::create_dir_all(library.parent().unwrap()).unwrap();
    std::fs::write(&library, b"invalid native library").unwrap();
    oliphaunt::register_build_resources_dir(&root).unwrap();
    let error = match oliphaunt::Oliphaunt::open() {
        Ok(_) => panic!("invalid native library unexpectedly loaded"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains(library.to_str().unwrap()),
        "{error}"
    );
    std::fs::remove_dir_all(root).unwrap();
}
