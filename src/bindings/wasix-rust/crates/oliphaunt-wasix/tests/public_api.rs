use std::error::Error as _;

use oliphaunt_wasix::{
    DecodeError, Error, FromSql, IntoParameter, Oliphaunt, Parameter, PostgresError,
    PostgresNotice, Result, Transaction, TransactionRollbackError, TypeOid, ValueFormat, ValueRef,
    worker::{Oliphaunt as WorkerOliphaunt, Transaction as WorkerTransaction},
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

#[test]
fn fallible_public_api_uses_the_sdk_result() {
    fn assert_result(_: Result<()>) {}
    fn assert_error<T: std::error::Error + Send + Sync + 'static>() {}

    assert_error::<Error>();
    assert_error::<TransactionRollbackError>();
    let destination = tempfile::tempdir()
        .expect("temporary directory")
        .path()
        .join("restored");
    let result = Oliphaunt::restore(destination, b"not a physical archive");
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
    assert_send_sync::<WorkerOliphaunt>();
    assert_send_sync::<oliphaunt_wasix::worker::OliphauntServer>();
    assert_send(WorkerOliphaunt::builder().open());
    assert_send(WorkerOliphaunt::restore("unused", b""));
    assert_send(oliphaunt_wasix::worker::OliphauntServer::builder().start());

    fn direct_construction_surface() {
        let _: Result<_> = Oliphaunt::builder().open();
        let _: Result<_> = oliphaunt_wasix::OliphauntServer::builder().start();
    }
    let _: fn() = direct_construction_surface;

    // liboliphaunt-doc-example:wasix-rust-basic-query
    fn direct_database_surface(database: &mut Oliphaunt) {
        let _: Result<_> = database.query("SELECT 1");
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
        let _raw = database.exec_protocol_raw([]);
        let _raw_stream = database.exec_protocol_raw_stream([], |_| Ok(()));
        let _backup = database.backup();
        let _ = database.is_closed();
        let _close = database.close();
    }
    fn direct_transaction_surface(transaction: &mut Transaction<'_>) {
        let _ = transaction.is_closed();
        let _query = transaction.sql("SELECT $1::int4").bind(1_i32).query();
        let _execute = transaction
            .sql("UPDATE items SET value = $1")
            .bind("value")
            .execute();
        let _typed_query = transaction.query_with_params("SELECT $1::int8", [1_i64]);
        let _describe = transaction.sql("SELECT 1").describe();
        let _: Result<_> = transaction.exec("SELECT 1");
        let _raw = transaction.exec_protocol_raw([]);
        let _raw_stream = transaction.exec_protocol_raw_stream([], |_| Ok(()));
        let _ = transaction.rollback();
    }
    fn direct_server_surface(server: &mut oliphaunt_wasix::OliphauntServer) {
        let _ = server.is_closed();
        let _: Result<_> = server.close();
    }
    let _: fn(&mut Oliphaunt) = direct_database_surface;
    let _: fn(&mut Transaction<'_>) = direct_transaction_surface;
    let _: fn(&mut oliphaunt_wasix::OliphauntServer) = direct_server_surface;

    // liboliphaunt-doc-example:wasix-rust-worker
    fn worker_database_surface(database: &WorkerOliphaunt) {
        let _clone = database.clone();
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
        let _raw = database.exec_protocol_raw([]);
        let _raw_stream = database.exec_protocol_raw_stream([], |_| Ok(()));
        let _backup = database.backup();
        let _ = database.is_closed();
        let _close = database.close();
    }
    fn worker_transaction_surface(transaction: &WorkerTransaction) {
        let _ = transaction.is_closed();
        let _query = transaction.sql("SELECT $1::int4").bind(1_i32).query();
        let _execute = transaction
            .sql("UPDATE items SET value = $1")
            .bind("value")
            .execute();
        let _typed_query = transaction.query_with_params("SELECT $1::int8", [1_i64]);
        let _describe = transaction.sql("SELECT 1").describe();
        std::mem::drop(transaction.exec("SELECT 1"));
        let _raw = transaction.exec_protocol_raw([]);
        let _raw_stream = transaction.exec_protocol_raw_stream([], |_| Ok(()));
        std::mem::drop(transaction.rollback());
    }
    fn worker_server_surface(server: &oliphaunt_wasix::worker::OliphauntServer) {
        let _clone = server.clone();
        let _ = server.tcp_addr();
        #[cfg(unix)]
        let _ = server.socket_path();
        let _: &str = server.connection_string();
        let _ = server.is_closed();
        assert_send(server.close());
    }
    let _: fn(&WorkerOliphaunt) = worker_database_surface;
    let _: fn(&WorkerTransaction) = worker_transaction_surface;
    let _: fn(&oliphaunt_wasix::worker::OliphauntServer) = worker_server_surface;
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

    fn direct_tool_surface(database: &mut Oliphaunt) {
        let _: Result<_> =
            oliphaunt_wasix::tools::pg_dump(database, oliphaunt_wasix::tools::PgDumpOptions::new());
        let _: Result<_> = oliphaunt_wasix::tools::psql(
            database,
            oliphaunt_wasix::tools::PsqlOptions::new().command("SELECT 1"),
        );
    }
    fn worker_tool_surface(database: &WorkerOliphaunt) {
        std::mem::drop(oliphaunt_wasix::worker::tools::pg_dump(
            database,
            oliphaunt_wasix::worker::tools::PgDumpOptions::new(),
        ));
        std::mem::drop(oliphaunt_wasix::worker::tools::psql(
            database,
            oliphaunt_wasix::worker::tools::PsqlOptions::new().command("SELECT 1"),
        ));
    }
    let _: fn(&mut Oliphaunt) = direct_tool_surface;
    let _: fn(&WorkerOliphaunt) = worker_tool_surface;
}
