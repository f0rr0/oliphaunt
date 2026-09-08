use std::collections::BTreeMap;
use std::process::Command;

use oliphaunt_native_packaging::built_in_extension_catalog;

#[test]
fn extension_catalog_cli_lists_the_generated_packaging_inventory_without_runtime_inputs() {
    let output = Command::new(env!("CARGO_BIN_EXE_oliphaunt-resources"))
        .arg("--list-extensions")
        .env_remove("LIBOLIPHAUNT_PATH")
        .env_remove("OLIPHAUNT_POSTGRES")
        .env_remove("OLIPHAUNT_INITDB")
        .env_remove("OLIPHAUNT_INSTALL_DIR")
        .output()
        .expect("run oliphaunt-resources --list-extensions");
    assert!(
        output.status.success(),
        "catalog command failed with status {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("catalog output must be UTF-8");
    let mut lines = stdout.lines();
    assert_eq!(
        lines.next(),
        Some(
            "sql_name\tpg_major\tcreates_extension\tnative_module_stem\tdependencies\tshared_preload\tdesktop_prebuilt\tmobile_prebuilt\tmobile_static_registry_required\tmobile_static_archive_targets\tdata_files\tartifact"
        )
    );
    let rows = lines
        .map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            assert_eq!(columns.len(), 12, "catalog row must have 12 columns");
            (columns[0].to_owned(), columns)
        })
        .collect::<BTreeMap<_, _>>();

    let expected = built_in_extension_catalog();
    assert_eq!(rows.len(), expected.len());
    for extension in expected {
        let row = rows
            .get(&extension.sql_name)
            .unwrap_or_else(|| panic!("catalog must contain {}", extension.sql_name));
        assert_eq!(row[1], extension.postgres_major.to_string());
        assert_eq!(
            row[2],
            if extension.creates_extension {
                "yes"
            } else {
                "no"
            }
        );
        assert_eq!(
            row[3],
            extension.native_module_stem.as_deref().unwrap_or("-")
        );
        assert_eq!(row[6], "yes");
        assert_eq!(row[7], "yes");
        assert_eq!(row[11], "first-party");
    }
}
