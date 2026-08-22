use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use oliphaunt::Extension;

const GENERATED_EXTENSION_CATALOG: &str =
    include_str!("../../../src/extensions/generated/sdk/extensions.json");

#[derive(Debug, Deserialize)]
struct CatalogDocument {
    extensions: Vec<CatalogExtension>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct CatalogExtension {
    pub(crate) sql_name: String,
    pub(crate) postgres_major: u16,
    pub(crate) creates_extension: bool,
    pub(crate) native_module_stem: Option<String>,
    pub(crate) dependencies: Vec<String>,
    pub(crate) runtime_share_data_files: Vec<String>,
    pub(crate) extension_sql_file_names: Vec<String>,
    pub(crate) extension_sql_file_prefixes: Vec<String>,
    pub(crate) shared_preload_libraries: Vec<String>,
    pub(crate) artifact_product: Option<String>,
}

fn catalog() -> &'static BTreeMap<String, CatalogExtension> {
    static CATALOG: OnceLock<BTreeMap<String, CatalogExtension>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let document: CatalogDocument = serde_json::from_str(GENERATED_EXTENSION_CATALOG)
            .expect("generated extension catalog must remain valid JSON");
        document
            .extensions
            .into_iter()
            .map(|entry| (entry.sql_name.clone(), entry))
            .collect()
    })
}

pub(crate) fn all() -> impl Iterator<Item = &'static CatalogExtension> {
    catalog().values()
}

pub(crate) fn by_sql_name(sql_name: &str) -> Option<&'static CatalogExtension> {
    catalog().get(sql_name)
}

pub(crate) fn for_extension(extension: Extension) -> &'static CatalogExtension {
    by_sql_name(extension.sql_name())
        .expect("every generated Rust extension must exist in the generated extension catalog")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_catalog_matches_the_rust_extension_domain() {
        assert_eq!(catalog().len(), Extension::ALL_PG18_SUPPORTED.len());
        for extension in Extension::ALL_PG18_SUPPORTED {
            let entry = for_extension(*extension);
            assert_eq!(entry.sql_name, extension.sql_name());
            assert_eq!(entry.postgres_major, 18);
        }
    }
}
