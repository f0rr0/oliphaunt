use oliphaunt::{
    DatabaseStorage, DecodeError, Error, ExecResult, Extension, FromSql, IntoParameter, Oliphaunt,
    OliphauntBuilder, OliphauntServer, Parameter, PostgresError, PostgresNotice, QueryFormat,
    QueryParam, StatementDescription, Transaction, TypeOid, ValueFormat, ValueRef,
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

fn assert_send_future<T: Send>(_: T) {}

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
    fn assert_error<T: std::error::Error + Send + Sync + 'static>() {}
    assert_send_sync::<Oliphaunt>();
    assert_send_sync::<OliphauntServer>();
    assert_send_future(Oliphaunt::builder().temporary_directory().open());
    assert_send_future(Oliphaunt::builder().open_server());
    assert_error::<Error>();
    assert_error::<PostgresError>();
    assert_send_future(Oliphaunt::restore(
        std::path::PathBuf::from("unused-public-api-check"),
        Vec::<u8>::new(),
    ));

    fn transaction_rollback_surface(error: &Error) {
        if let Error::TransactionRollback { callback, rollback } = error {
            let _: &Error = callback;
            let _: &Error = rollback;
        }
    }
    let _: fn(&Error) = transaction_rollback_surface;

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
    let typed_null = IntoParameter::into_parameter(None::<i64>);
    assert_eq!(typed_null.type_oid(), Some(TypeOid::INT8));
    assert_eq!(
        IntoParameter::into_parameter(PublicParameter).type_oid(),
        Some(TypeOid::INT4)
    );

    fn database_surface(database: &Oliphaunt) {
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
        let _describe_convenience = database.describe("SELECT 1");
        let _describe = database
            .sql("SELECT $1::uuid")
            .bind_parameter(Parameter::typed_null(TypeOid::UUID))
            .describe();
        let _exec: std::pin::Pin<
            Box<dyn std::future::Future<Output = oliphaunt::Result<ExecResult>> + '_>,
        > = Box::pin(database.exec("SELECT 1; SELECT 2"));
        let _description: std::pin::Pin<
            Box<dyn std::future::Future<Output = oliphaunt::Result<StatementDescription>> + '_>,
        > = Box::pin(database.sql("SELECT 1").describe());
        let _raw_stream = database.exec_protocol_raw_stream([], |_| Ok(()));
        assert_send_future(database.cancel());
        let _closed = database.is_closed();
        let _transaction = database.transaction(async |transaction: &Transaction| {
            let _closed = transaction.is_closed();
            let _typed_query = transaction.query_with_params("SELECT $1::int8", [1_i64]);
            let _raw_stream = transaction.exec_protocol_raw_stream([], |_| Ok(()));
            transaction.rollback().await?;
            Ok(())
        });
    }
    let _: fn(&Oliphaunt) = database_surface;

    fn server_surface(server: &OliphauntServer) {
        let _describe = server.describe("SELECT 1");
        let _raw_stream = server.exec_protocol_raw_stream([], |_| Ok(()));
        assert_send_future(server.cancel());
    }
    let _: fn(&OliphauntServer) = server_surface;
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
