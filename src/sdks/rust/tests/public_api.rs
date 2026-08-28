use oliphaunt::{
    AsyncOliphaunt, AsyncOliphauntBuilder, AsyncOliphauntServer, AsyncOliphauntServerBuilder,
    AsyncSql, AsyncTransaction, CancelHandle, DatabaseStorage, DecodeError, Error, ErrorKind,
    ExecResult, Extension, FromSql, IntoParameter, Oliphaunt, OliphauntBuilder, OliphauntServer,
    OliphauntServerBuilder, Parameter, PostgresError, PostgresNotice, QueryFormat,
    RawStreamCallbackOutput, RawStreamError, RawStreamResult, Sql, StatementDescription,
    Transaction, TransactionError, TransactionResult, TypeOid, ValueFormat, ValueRef,
};

#[derive(Debug)]
enum ApplicationError {
    Database(Error),
    Abort,
}

impl From<Error> for ApplicationError {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for ApplicationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(formatter),
            Self::Abort => formatter.write_str("application aborted the transaction"),
        }
    }
}

impl std::error::Error for ApplicationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Abort => None,
        }
    }
}

#[derive(Debug)]
struct ParserError;

impl std::fmt::Display for ParserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("parser stopped the stream")
    }
}

impl std::error::Error for ParserError {}

fn sdk_only_blocking_callbacks(database: &mut Oliphaunt) -> oliphaunt::Result<()> {
    database.transaction(|transaction| {
        transaction.execute("SELECT 1")?;
        Ok(())
    })?;
    database.exec_protocol_raw_stream([], |_| ())?;
    database.exec_protocol_raw_stream([], |_| -> oliphaunt::Result<()> { Ok(()) })?;
    Ok(())
}

fn typed_blocking_transaction(database: &mut Oliphaunt) -> TransactionResult<(), ApplicationError> {
    database.transaction(|transaction| {
        transaction.execute("SELECT 1")?;
        Err(ApplicationError::Abort)
    })
}

fn typed_blocking_stream(database: &mut Oliphaunt) -> RawStreamResult<(), ParserError> {
    database.exec_protocol_raw_stream([], |_| Err(ParserError))
}

async fn sdk_only_async_callbacks(database: &AsyncOliphaunt) -> oliphaunt::Result<()> {
    database
        .transaction(async |transaction| {
            transaction.execute("SELECT 1").await?;
            Ok(())
        })
        .await?;
    database.exec_protocol_raw_stream([], |_| ()).await?;
    database
        .exec_protocol_raw_stream([], |_| -> oliphaunt::Result<()> { Ok(()) })
        .await?;
    Ok(())
}

async fn typed_async_transaction(
    database: &AsyncOliphaunt,
) -> TransactionResult<(), ApplicationError> {
    database
        .transaction(async |transaction| {
            transaction.execute("SELECT 1").await?;
            Err(ApplicationError::Abort)
        })
        .await
}

async fn typed_async_stream(database: &AsyncOliphaunt) -> RawStreamResult<(), ParserError> {
    database
        .exec_protocol_raw_stream([], |_| Err(ParserError))
        .await
}

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

macro_rules! assert_not_impl {
    ($type:ty: $bound:path) => {
        const _: fn() = || {
            trait AmbiguousIfImpl<A> {
                fn marker() {}
            }
            struct Invalid;
            impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
            impl<T: ?Sized + $bound> AmbiguousIfImpl<Invalid> for T {}
            let _ = <$type as AmbiguousIfImpl<_>>::marker;
        };
    };
}

assert_not_impl!(Oliphaunt: Sync);
assert_not_impl!(OliphauntServer: Sync);
assert_not_impl!(AsyncTransaction: Sync);

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
        .extension(Extension::VECTOR);

    let _: Parameter = "text".into_parameter();
    let _: QueryFormat = QueryFormat::Text;

    fn assert_error<T: std::error::Error + Send + Sync + 'static>() {}
    fn assert_clone<T: Clone>() {}
    fn assert_copy<T: Copy>() {}
    fn assert_debug<T: std::fmt::Debug>() {}
    fn assert_eq_type<T: Eq>() {}
    fn assert_hash<T: std::hash::Hash>() {}
    fn assert_ord<T: Ord>() {}
    fn assert_send<T: Send>() {}
    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_raw_callback_output<T: RawStreamCallbackOutput>() {}
    assert_send::<Oliphaunt>();
    assert_send::<OliphauntServer>();
    assert_clone::<OliphauntBuilder>();
    assert_clone::<AsyncOliphauntBuilder>();
    assert_clone::<OliphauntServerBuilder>();
    assert_clone::<AsyncOliphauntServerBuilder>();
    assert_debug::<OliphauntBuilder>();
    assert_debug::<AsyncOliphauntBuilder>();
    assert_debug::<OliphauntServerBuilder>();
    assert_debug::<AsyncOliphauntServerBuilder>();
    assert_send_sync::<OliphauntBuilder>();
    assert_send_sync::<AsyncOliphauntBuilder>();
    assert_send_sync::<OliphauntServerBuilder>();
    assert_send_sync::<AsyncOliphauntServerBuilder>();
    assert_send_sync::<CancelHandle>();
    fn cancellation_surface(handle: &CancelHandle) {
        let _: CancelHandle = handle.clone();
        let _: oliphaunt::Result<()> = handle.cancel();
    }
    let _: fn(&CancelHandle) = cancellation_surface;
    // liboliphaunt-doc-example:rust-async-basic
    assert_send_sync::<AsyncOliphaunt>();
    assert_send_sync::<AsyncOliphauntServer>();
    assert_send::<AsyncTransaction>();
    assert_send_future(AsyncOliphaunt::builder().open());
    assert_send_future(AsyncOliphauntServer::builder().start());
    assert_send_future(AsyncOliphaunt::restore(
        std::path::PathBuf::from("unused-async-public-api-check"),
        Vec::<u8>::new(),
    ));
    assert_error::<Error>();
    assert_clone::<Error>();
    assert_copy::<ErrorKind>();
    assert_debug::<ErrorKind>();
    assert_eq_type::<ErrorKind>();
    assert_send_sync::<ErrorKind>();
    assert_copy::<Extension>();
    assert_debug::<Extension>();
    assert_eq_type::<Extension>();
    assert_hash::<Extension>();
    assert_ord::<Extension>();
    assert_send_sync::<Extension>();
    assert_error::<PostgresError>();
    assert_error::<TransactionError<ApplicationError>>();
    assert_error::<RawStreamError<ParserError>>();
    assert_raw_callback_output::<()>();
    assert_raw_callback_output::<std::result::Result<(), ParserError>>();

    fn generic_error_surface(
        transaction: &TransactionError<ApplicationError>,
        stream: &RawStreamError<ParserError>,
    ) {
        let _: Option<&ApplicationError> = transaction.callback_error();
        let _: Option<&Error> = transaction.database_error();
        let _: Option<&Error> = transaction.rollback_error();
        let _: Option<&ParserError> = stream.callback_error();
        let _: Option<&Error> = stream.database_error();
        let _: Option<&Error> = stream.callback_panic_error();
    }
    let _: fn(&TransactionError<ApplicationError>, &RawStreamError<ParserError>) =
        generic_error_surface;

    fn flatten_sdk_errors(
        transaction: TransactionError<Error>,
        stream: RawStreamError<Error>,
        infallible: RawStreamError<std::convert::Infallible>,
    ) {
        let _: Error = transaction.into();
        let _: Error = stream.into();
        let _: Error = infallible.into();
    }
    let _ = flatten_sdk_errors;

    fn caller_thread_terminals(builder: OliphauntBuilder) {
        let _: oliphaunt::Result<Oliphaunt> = builder.open();
        let _: oliphaunt::Result<Oliphaunt> = Oliphaunt::open();
        // liboliphaunt-doc-example:rust-start-server
        let _: oliphaunt::Result<OliphauntServer> = OliphauntServer::builder().start();
        let _: oliphaunt::Result<()> = Oliphaunt::restore(
            std::path::PathBuf::from("unused-public-api-check"),
            Vec::<u8>::new(),
        );
    }
    let _: fn(OliphauntBuilder) = caller_thread_terminals;

    fn transaction_rollback_surface(error: &Error) {
        let _: ErrorKind = error.kind();
        let _: Error = error.clone();
        let _: Option<&PostgresError> = error.postgres_error();
        let _: Option<(&Error, &Error)> = error.transaction_rollback_errors();
        let _: Option<(&Error, &Error)> = error.transaction_callback_database_errors();
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

    fn database_surface(database: &mut Oliphaunt) {
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
        let _exec: oliphaunt::Result<ExecResult> = database.exec("SELECT 1; SELECT 2");
        let _description: oliphaunt::Result<StatementDescription> =
            database.sql("SELECT 1").describe();
        let mut streamed_bytes = 0_usize;
        let _borrowed_raw_stream = database.exec_protocol_raw_stream([], |chunk| {
            streamed_bytes += chunk.len();
        });
        let _ = streamed_bytes;
        let _raw_stream = database.exec_protocol_raw_stream([], |_| ());
        let _cancel = database.cancel();
        let _cancel_handle = database.cancel_handle();
        let _closed = database.is_closed();
        let _transaction = database.transaction(|transaction: &mut Transaction<'_>| {
            let _closed = transaction.is_closed();
            let _typed_query = transaction.query_with_params("SELECT $1::int8", [1_i64]);
            transaction.rollback()?;
            Ok::<(), Error>(())
        });
    }
    let _: fn(&mut Oliphaunt) = database_surface;
    let _: fn(&mut Oliphaunt) -> oliphaunt::Result<()> = sdk_only_blocking_callbacks;
    let _: fn(&mut Oliphaunt) -> TransactionResult<(), ApplicationError> =
        typed_blocking_transaction;
    let _: fn(&mut Oliphaunt) -> RawStreamResult<(), ParserError> = typed_blocking_stream;

    fn server_surface(server: &mut OliphauntServer) {
        let _: &str = server.connection_string();
        let _: bool = server.is_closed();
        let _: oliphaunt::Result<()> = server.close();
    }
    let _: fn(&mut OliphauntServer) = server_surface;

    fn async_database_surface(database: &AsyncOliphaunt) {
        let _: AsyncOliphauntBuilder = AsyncOliphaunt::builder();
        assert_send_future(AsyncOliphaunt::open());
        assert_send_future(AsyncOliphauntServer::builder().start());
        let _: AsyncSql<'_, '_> = database.sql("SELECT 1");
        assert_send_future(database.sql("SELECT $1::int4").bind(1_i32).query());
        assert_send_future(database.execute_with_params("SELECT $1::bool", [true]));
        assert_send_future(database.exec("SELECT 1; SELECT 2"));
        assert_send_future(database.describe("SELECT 1"));
        assert_send_future(database.exec_protocol_raw([]));
        assert_send_future(database.exec_protocol_raw_stream([], |_| ()));
        assert_send_future(database.backup());
        assert_send_future(database.cancel());
        assert_send_future(
            database.transaction(async |transaction: &mut AsyncTransaction| {
                assert_send_future(transaction.query_with_params("SELECT $1::int8", [1_i64]));
                assert_send_future(transaction.exec("SELECT 1; SELECT 2"));
                assert_send_future(transaction.describe("SELECT 1"));
                transaction.rollback().await?;
                Ok::<(), Error>(())
            }),
        );
        assert_send_future(database.close());
        assert_send_future(sdk_only_async_callbacks(database));
        assert_send_future(typed_async_transaction(database));
        assert_send_future(typed_async_stream(database));
    }
    let _: fn(&AsyncOliphaunt) = async_database_surface;

    fn async_server_surface(server: &AsyncOliphauntServer) {
        let _: &str = server.connection_string();
        let _: bool = server.is_closed();
        assert_send_future(server.close());
    }
    let _: fn(&AsyncOliphauntServer) = async_server_surface;

    fn blocking_statement_type<'db, 'q>(
        database: &'db mut Oliphaunt,
        sql: &'q str,
    ) -> Sql<'db, 'q> {
        database.sql(sql)
    }
    let _ = blocking_statement_type;
}

#[test]
fn extension_catalog_is_exact_and_sorted() {
    let names = Extension::ALL
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<Vec<_>>();
    assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(names.len(), 39);
    for extension in Extension::ALL {
        assert_eq!(
            Extension::by_sql_name(extension.sql_name()),
            Some(*extension)
        );
    }
}
