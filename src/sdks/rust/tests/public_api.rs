use oliphaunt::{
    DatabaseStorage, Extension, Oliphaunt, OliphauntBuilder, OliphauntServer, QueryFormat,
    QueryParam,
};

// OLIPHAUNT_DOCS_SNIPPET rust-quickstart
// liboliphaunt-doc-example:rust-build-script
// liboliphaunt-doc-example:rust-basic-query

#[test]
fn public_api_has_only_the_deliberate_native_vocabulary() {
    let _: OliphauntBuilder = Oliphaunt::builder()
        .direct()
        .storage(DatabaseStorage::TemporaryDirectory)
        .startup_guc("work_mem", "8MB")
        .startup_gucs([("application_name", "oliphaunt")])
        .username("postgres")
        .database("postgres")
        .extension(Extension::Vector);

    let _: QueryParam = "text".into();
    let _: QueryFormat = QueryFormat::Text;

    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Oliphaunt>();
    assert_send_sync::<OliphauntServer>();
}

#[test]
fn extension_catalog_is_exact_and_sorted() {
    let names = Extension::ALL_PG18_SUPPORTED
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<Vec<_>>();
    assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(names.len(), 39);
    for extension in Extension::ALL_PG18_SUPPORTED {
        assert_eq!(
            Extension::by_sql_name(extension.sql_name()),
            Some(*extension)
        );
    }
}
