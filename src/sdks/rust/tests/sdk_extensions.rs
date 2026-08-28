use std::collections::BTreeSet;
use std::path::PathBuf;

use oliphaunt::Extension;

fn generated_extension_metadata() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/generated/sdk/extensions.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn public_extension_catalog_matches_generated_extension_selection_metadata() {
    fn assert_extension_traits<T: Copy + Eq + std::hash::Hash + Ord>() {}
    assert_extension_traits::<Extension>();

    let metadata = generated_extension_metadata();
    let rows = metadata["extensions"]
        .as_array()
        .expect("generated Rust SDK extension metadata must define extensions");
    let generated_names = rows
        .iter()
        .map(|row| {
            row["sql-name"]
                .as_str()
                .expect("extension row must define sql-name")
        })
        .collect::<BTreeSet<_>>();
    let public_names = Extension::ALL
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<BTreeSet<_>>();

    assert_eq!(public_names, generated_names);
    assert_eq!(public_names.len(), Extension::ALL.len());

    for extension in Extension::ALL {
        assert_eq!(
            Extension::by_sql_name(extension.sql_name()),
            Some(*extension)
        );
    }
}

#[test]
fn extension_selection_uses_exact_sql_names_without_aliases() {
    assert_eq!(Extension::by_sql_name("vector"), Some(Extension::VECTOR));
    assert_eq!(
        Extension::by_sql_name("uuid-ossp"),
        Some(Extension::UUID_OSSP)
    );
    for unsupported_alias in [
        "core",
        "search",
        "geo",
        "vector-pack",
        "vector_pack",
        "vector+search",
    ] {
        assert_eq!(Extension::by_sql_name(unsupported_alias), None);
    }
}
