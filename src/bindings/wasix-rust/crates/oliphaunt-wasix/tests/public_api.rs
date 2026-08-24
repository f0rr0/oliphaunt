use std::error::Error as _;

use oliphaunt_wasix::{Error, Oliphaunt, Result};

#[test]
fn fallible_public_api_uses_the_sdk_result() {
    fn assert_result(_: Result<()>) {}
    fn assert_error<T: std::error::Error + Send + Sync + 'static>() {}

    assert_error::<Error>();
    let destination = tempfile::tempdir()
        .expect("temporary directory")
        .path()
        .join("restored");
    let result = Oliphaunt::restore(destination, b"not a physical archive");
    let error = result.expect_err("invalid archive must fail");
    assert!(!error.to_string().is_empty());
    assert!(error.postgres_error().is_none());
    assert!(error.source().is_some());
    assert_result(Err(error));
}

#[cfg(feature = "extensions")]
#[test]
fn extensions_expose_only_the_selection_contract() {
    use oliphaunt_wasix::extensions::{self, Extension};

    let extension: Extension = extensions::VECTOR;
    assert_eq!(extension.sql_name(), "vector");
    assert_eq!(extensions::by_sql_name("vector"), Some(extension));
    assert!(extensions::ALL.contains(&extension));
}

#[cfg(feature = "tools")]
#[test]
fn packaged_psql_accepts_standard_script_input() {
    let options = oliphaunt_wasix::tools::PsqlOptions::new().script("SELECT 1;");
    let _: oliphaunt_wasix::tools::PsqlOptions = options;
    fn assert_tool_error<T: std::error::Error + Send + Sync + 'static>() {}
    assert_tool_error::<oliphaunt_wasix::tools::PostgresToolError>();
}
