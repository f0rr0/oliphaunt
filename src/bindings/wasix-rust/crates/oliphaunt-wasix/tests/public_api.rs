use std::error::Error as _;

use oliphaunt_wasix::{
    DecodeError, Error, FromSql, IntoParameter, Oliphaunt, Parameter, PostgresError,
    PostgresNotice, Result, Transaction, TransactionRollbackError, TypeOid, ValueFormat, ValueRef,
};

struct PublicParameter;

impl IntoParameter for PublicParameter {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::INT4);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_binary(TypeOid::INT4, 7_i32.to_be_bytes())
    }
}

struct PublicDecoder;

impl<'a> FromSql<'a> for PublicDecoder {
    fn from_sql(_value: ValueRef<'a>) -> std::result::Result<Self, DecodeError> {
        Ok(Self)
    }
}

#[tokio::test]
async fn fallible_public_api_uses_the_sdk_result() {
    fn assert_result(_: Result<()>) {}
    fn assert_error<T: std::error::Error + Send + Sync + 'static>() {}

    assert_error::<Error>();
    assert_error::<TransactionRollbackError>();
    let destination = tempfile::tempdir()
        .expect("temporary directory")
        .path()
        .join("restored");
    let result = Oliphaunt::restore(destination, b"not a physical archive").await;
    let error = result.expect_err("invalid archive must fail");
    assert!(!error.to_string().is_empty());
    assert!(error.postgres_error().is_none());
    assert!(error.transaction_rollback_error().is_none());
    assert!(error.source().is_some());
    assert_result(Err(error));

    fn transaction_rollback_surface(error: &TransactionRollbackError) {
        let _: &Error = &error.callback;
        let _: &Error = &error.rollback;
    }
    let _: fn(&TransactionRollbackError) = transaction_rollback_surface;

    fn postgres_diagnostic_surface(error: &PostgresError, notice: &PostgresNotice) {
        let _: (&Option<String>, &Option<String>) =
            (&error.localized_severity, &notice.localized_severity);
        let _: (&Option<String>, &Option<String>) =
            (&error.nonlocalized_severity, &notice.nonlocalized_severity);
        let _: (&Option<String>, &Option<String>) =
            (&error.internal_position, &notice.internal_position);
        let _: (&Option<String>, &Option<String>) = (&error.internal_query, &notice.internal_query);
        let _: (&Option<String>, &Option<String>) = (&error.file, &notice.file);
        let _: (&Option<String>, &Option<String>) = (&error.line, &notice.line);
        let _: (&Option<String>, &Option<String>) = (&error.routine, &notice.routine);
    }
    let _: fn(&PostgresError, &PostgresNotice) = postgres_diagnostic_surface;
}

#[test]
fn typed_and_fluent_database_api_is_public() {
    // liboliphaunt-doc-example:wasix-rust-basic-query
    fn assert_decoder<T>()
    where
        for<'a> T: FromSql<'a>,
    {
    }
    assert_decoder::<String>();
    assert_decoder::<i32>();
    assert_decoder::<PublicDecoder>();

    let parameter = Parameter::null().with_type_oid(TypeOid::UUID);
    assert_eq!(parameter.type_oid(), Some(TypeOid::UUID));
    assert_eq!(parameter.format(), ValueFormat::Text);
    assert_eq!(TypeOid::TIMETZ.get(), 1266);
    assert_eq!(TypeOid::CHAR_ARRAY.get(), 1002);
    assert_eq!(TypeOid::NAME_ARRAY.get(), 1003);
    assert_eq!(TypeOid::XML_ARRAY.get(), 143);
    assert_eq!(TypeOid::TIMETZ_ARRAY.get(), 1270);
    assert_eq!(
        IntoParameter::into_parameter(None::<i64>).type_oid(),
        Some(TypeOid::INT8)
    );
    assert_eq!(
        IntoParameter::into_parameter(PublicParameter).type_oid(),
        Some(TypeOid::INT4)
    );

    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_send<T: Send>(_: T) {}
    assert_send_sync::<Oliphaunt>();
    assert_send(Oliphaunt::builder().open());
    assert_send(oliphaunt_wasix::OliphauntServer::builder().start());

    fn database_surface(database: &Oliphaunt) {
        assert_send(database.query("SELECT 1"));
        let _query = database
            .sql("SELECT $1::int4")
            .bind(1_i32)
            .result_format(ValueFormat::Binary)
            .query();
        let _execute = database
            .sql("UPDATE items SET value = $1")
            .bind("value")
            .execute();
        let _typed_query = database.query_with_params("SELECT $1::int4", [1_i32]);
        let _typed_execute = database.execute_with_params("SELECT $1::bool", [true]);
        let _describe = database
            .sql("SELECT $1::uuid")
            .bind_parameter(Parameter::typed_null(TypeOid::UUID))
            .describe();
        let _exec = database.exec("SELECT 1; SELECT 2");
        let _description = database.describe("SELECT $1::uuid");
        let _raw_stream = database.exec_protocol_raw_stream([], |_| Ok(()));
        let _ = database.is_closed();
    }
    fn transaction_surface(transaction: &Transaction) {
        let _ = transaction.is_closed();
        let _query = transaction.sql("SELECT $1::int4").bind(1_i32).query();
        let _execute = transaction
            .sql("UPDATE items SET value = $1")
            .bind("value")
            .execute();
        let _typed_query = transaction.query_with_params("SELECT $1::int8", [1_i64]);
        let _describe = transaction.sql("SELECT 1").describe();
        std::mem::drop(transaction.exec("SELECT 1"));
        let _raw_stream = transaction.exec_protocol_raw_stream([], |_| Ok(()));
        std::mem::drop(transaction.rollback());
    }
    let _: fn(&Oliphaunt) = database_surface;
    let _: fn(&Transaction) = transaction_surface;

    // liboliphaunt-doc-example:wasix-rust-blocking
    fn blocking_database_surface(database: &mut oliphaunt_wasix::blocking::Oliphaunt) {
        let _: Result<_> = database.query("SELECT 1");
        let _: Result<_> = database.execute("CREATE TABLE item(id int)");
        let _: Result<_> = database.exec("SELECT 1; SELECT 2");
        let _ = database.sql("SELECT $1::int4").bind(1_i32).query();
    }
    fn blocking_transaction_surface(transaction: &mut oliphaunt_wasix::blocking::Transaction<'_>) {
        let _: Result<_> = transaction.query("SELECT 1");
        let _ = transaction.rollback();
    }
    fn blocking_server_surface(server: &mut oliphaunt_wasix::blocking::OliphauntServer) {
        let _ = server.is_closed();
        let _: Result<_> = server.close();
    }
    let _: fn(&mut oliphaunt_wasix::blocking::Oliphaunt) = blocking_database_surface;
    let _: fn(&mut oliphaunt_wasix::blocking::Transaction<'_>) = blocking_transaction_surface;
    let _: fn(&mut oliphaunt_wasix::blocking::OliphauntServer) = blocking_server_surface;
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
    // liboliphaunt-doc-example:wasix-rust-tools
    let options = oliphaunt_wasix::tools::PsqlOptions::new().script("SELECT 1;");
    let _: oliphaunt_wasix::tools::PsqlOptions = options;
    fn assert_tool_error<T: std::error::Error + Send + Sync + 'static>() {}
    assert_tool_error::<oliphaunt_wasix::tools::PostgresToolError>();

    fn async_tool_surface(database: &Oliphaunt) {
        std::mem::drop(oliphaunt_wasix::tools::pg_dump(
            database,
            oliphaunt_wasix::tools::PgDumpOptions::new(),
        ));
        std::mem::drop(oliphaunt_wasix::tools::psql(
            database,
            oliphaunt_wasix::tools::PsqlOptions::new().command("SELECT 1"),
        ));
    }
    fn blocking_tool_surface(database: &mut oliphaunt_wasix::blocking::Oliphaunt) {
        let _: Result<_> = oliphaunt_wasix::blocking::tools::pg_dump(
            database,
            oliphaunt_wasix::blocking::tools::PgDumpOptions::new(),
        );
        let _: Result<_> = oliphaunt_wasix::blocking::tools::psql(
            database,
            oliphaunt_wasix::blocking::tools::PsqlOptions::new().command("SELECT 1"),
        );
    }
    let _: fn(&Oliphaunt) = async_tool_surface;
    let _: fn(&mut oliphaunt_wasix::blocking::Oliphaunt) = blocking_tool_surface;
}
