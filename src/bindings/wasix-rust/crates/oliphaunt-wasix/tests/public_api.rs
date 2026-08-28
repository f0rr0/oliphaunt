use std::error::Error as _;
use std::path::PathBuf;

#[cfg(unix)]
use oliphaunt_wasix::ServerListen;
use oliphaunt_wasix::{
    AsyncOliphaunt, AsyncOliphauntBuilder, AsyncOliphauntServer, AsyncOliphauntServerBuilder,
    AsyncSql, AsyncTransaction, DatabaseStorage, DecodeError, Error, ErrorKind, FromSql,
    IntoParameter, Oliphaunt, Parameter, PostgresError, PostgresNotice, RawStreamCallbackOutput,
    RawStreamError, RawStreamResult, Result, Transaction, TransactionError, TransactionResult,
    TypeOid, ValueFormat, ValueRef,
};

#[cfg(unix)]
fn non_utf8_unix_socket_directory() -> PathBuf {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let mut leaf = format!("oliphaunt-wasix-socket-{}-", std::process::id()).into_bytes();
    leaf.push(0xff);
    std::env::temp_dir().join(OsString::from_vec(leaf))
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
struct ParserError;

impl std::fmt::Display for ParserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("parser stopped the stream")
    }
}

impl std::error::Error for ParserError {}

fn sdk_only_blocking_callbacks(database: &mut Oliphaunt) -> Result<()> {
    database.transaction(|transaction| {
        transaction.execute("SELECT 1")?;
        Ok(())
    })?;
    database.exec_protocol_raw_stream([], |_| ())?;
    database.exec_protocol_raw_stream([], |_| -> Result<()> { Ok(()) })?;
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

async fn sdk_only_async_callbacks(database: &AsyncOliphaunt) -> Result<()> {
    database
        .transaction(async |transaction| {
            transaction.execute("SELECT 1").await?;
            Ok(())
        })
        .await?;
    database.exec_protocol_raw_stream([], |_| ()).await?;
    database
        .exec_protocol_raw_stream([], |_| -> Result<()> { Ok(()) })
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

fn assert_invalid_startup_identity(error: Error, name: &str) {
    assert_invalid_configuration(error, &format!("{name} must not be empty"));
}

fn assert_invalid_configuration(error: Error, expected_message: &str) {
    assert_eq!(error.kind(), ErrorKind::InvalidConfiguration);
    assert_eq!(error.to_string(), expected_message);
}

fn expect_sdk_error<T>(result: Result<T>, message: &str) -> Error {
    match result {
        Ok(_) => panic!("{message}"),
        Err(error) => error,
    }
}

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

assert_not_impl!(Oliphaunt: Send);
assert_not_impl!(Oliphaunt: Sync);
assert_not_impl!(oliphaunt_wasix::OliphauntServer: Clone);
assert_not_impl!(oliphaunt_wasix::OliphauntServer: Sync);
assert_not_impl!(AsyncTransaction: Sync);

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
    fn assert_error<T: Clone + std::error::Error + Send + Sync + 'static>() {}
    fn assert_error_kind<T: Copy + Eq + std::fmt::Debug + Send + Sync + 'static>() {}

    assert_error::<Error>();
    assert_error_kind::<ErrorKind>();
    assert_error::<TransactionError<ApplicationError>>();
    assert_error::<RawStreamError<ParserError>>();
    let destination = tempfile::tempdir()
        .expect("temporary directory")
        .path()
        .join("restored");
    let result = Oliphaunt::restore(destination, b"not a physical archive");
    let error = result.expect_err("invalid archive must fail");
    assert!(!error.to_string().is_empty());
    assert!(error.postgres_error().is_none());
    assert!(error.transaction_rollback_errors().is_none());
    assert!(error.transaction_callback_database_errors().is_none());
    assert!(error.source().is_some());
    assert_result(Err(error));

    fn transaction_rollback_tuple_surface(error: &Error) {
        let _: ErrorKind = error.kind();
        let _stable_match = match error.kind() {
            ErrorKind::InvalidConfiguration => "invalid-configuration",
            ErrorKind::Lifecycle => "lifecycle",
            ErrorKind::TransactionActive => "transaction-active",
            ErrorKind::Postgres => "postgres",
            _ => "other-or-future",
        };
        let _: Option<(&Error, &Error)> = error.transaction_rollback_errors();
        let _: Option<(&Error, &Error)> = error.transaction_callback_database_errors();
    }
    let _: fn(&Error) = transaction_rollback_tuple_surface;

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
fn direct_builders_reject_empty_startup_identities_before_runtime_work() {
    for value in ["", " \t\n"] {
        let error = expect_sdk_error(
            Oliphaunt::builder().username(value).open(),
            "empty username must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "username");

        let error = expect_sdk_error(
            Oliphaunt::builder().database(value).open(),
            "empty database must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "database");

        let error = expect_sdk_error(
            oliphaunt_wasix::OliphauntServer::builder()
                .username(value)
                .start(),
            "empty server username must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "username");

        let error = expect_sdk_error(
            oliphaunt_wasix::OliphauntServer::builder()
                .database(value)
                .start(),
            "empty server database must fail before runtime setup",
        );
        assert_invalid_startup_identity(error, "database");
    }
}

#[tokio::test]
async fn async_builders_preserve_startup_identity_validation() {
    let error = expect_sdk_error(
        AsyncOliphaunt::builder().username(" \t\n").open().await,
        "async database must preserve direct username validation",
    );
    assert_invalid_startup_identity(error, "username");

    let error = expect_sdk_error(
        AsyncOliphauntServer::builder().database("").start().await,
        "async server must preserve direct database validation",
    );
    assert_invalid_startup_identity(error, "database");
}

#[test]
fn sync_builders_reject_invalid_host_paths_before_filesystem_work() {
    for (path, reason) in [
        (PathBuf::new(), "must not be empty"),
        (PathBuf::from("invalid\0path"), "must not contain NUL bytes"),
    ] {
        let error = expect_sdk_error(
            Oliphaunt::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .open(),
            "invalid storage path must fail before runtime setup",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        let error = expect_sdk_error(
            oliphaunt_wasix::OliphauntServer::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .start(),
            "invalid server storage path must fail before runtime setup",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        #[cfg(unix)]
        {
            let error = expect_sdk_error(
                oliphaunt_wasix::OliphauntServer::builder()
                    .listen(ServerListen::unix(path))
                    .start(),
                "invalid Unix listener path must fail before runtime setup",
            );
            assert_invalid_configuration(error, &format!("Unix socket directory {reason}"));
        }
    }

    #[cfg(unix)]
    {
        let path = non_utf8_unix_socket_directory();
        assert!(!path.exists());
        let error = expect_sdk_error(
            oliphaunt_wasix::OliphauntServer::builder()
                .listen(ServerListen::unix(path.clone()))
                .start(),
            "non-UTF-8 Unix listener path must fail before runtime setup",
        );
        assert_invalid_configuration(
            error,
            "Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path",
        );
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn async_builders_preserve_host_path_validation() {
    for (path, reason) in [
        (PathBuf::new(), "must not be empty"),
        (PathBuf::from("invalid\0path"), "must not contain NUL bytes"),
    ] {
        let error = expect_sdk_error(
            AsyncOliphaunt::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .open()
                .await,
            "async database must preserve storage path validation",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        let error = expect_sdk_error(
            AsyncOliphauntServer::builder()
                .storage(DatabaseStorage::Directory(path.clone()))
                .start()
                .await,
            "async server must preserve storage path validation",
        );
        assert_invalid_configuration(error, &format!("database storage directory {reason}"));

        #[cfg(unix)]
        {
            let error = expect_sdk_error(
                AsyncOliphauntServer::builder()
                    .listen(ServerListen::unix(path))
                    .start()
                    .await,
                "async server must preserve Unix listener path validation",
            );
            assert_invalid_configuration(error, &format!("Unix socket directory {reason}"));
        }
    }

    #[cfg(unix)]
    {
        let path = non_utf8_unix_socket_directory();
        assert!(!path.exists());
        let error = expect_sdk_error(
            AsyncOliphauntServer::builder()
                .listen(ServerListen::unix(path.clone()))
                .start()
                .await,
            "async non-UTF-8 Unix listener path must fail before runtime setup",
        );
        assert_invalid_configuration(
            error,
            "Unix socket directory must be valid UTF-8 so the published PostgreSQL connection string preserves the exact path",
        );
        assert!(!path.exists());
    }
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
    fn assert_send_type<T: Send>() {}
    fn assert_clone<T: Clone>() {}
    fn assert_debug<T: std::fmt::Debug>() {}
    fn assert_send<T: Send>(_: T) {}
    fn assert_raw_callback_output<T: RawStreamCallbackOutput>() {}
    // The direct database owns a caller-thread Wasmer store, but the direct
    // server's database already lives on its supervised listener thread.
    assert_send_type::<oliphaunt_wasix::OliphauntServer>();
    assert_send_sync::<AsyncOliphaunt>();
    assert_clone::<AsyncOliphaunt>();
    assert_debug::<AsyncOliphauntBuilder>();
    assert_send_sync::<AsyncOliphauntBuilder>();
    assert_clone::<AsyncOliphauntBuilder>();
    assert_send_type::<AsyncTransaction>();
    assert_send_sync::<AsyncOliphauntServer>();
    assert_clone::<AsyncOliphauntServer>();
    assert_send_sync::<AsyncOliphauntServerBuilder>();
    assert_clone::<AsyncOliphauntServerBuilder>();
    assert_debug::<AsyncOliphauntServerBuilder>();
    assert_send(AsyncOliphaunt::open());
    assert_send(AsyncOliphaunt::builder().open());
    assert_send(AsyncOliphaunt::restore("unused", b""));
    assert_send(AsyncOliphauntServer::builder().start());
    assert_raw_callback_output::<()>();
    assert_raw_callback_output::<std::result::Result<(), ParserError>>();

    fn async_sql_is_send<'db, 'q>(statement: AsyncSql<'db, 'q>) {
        assert_send(statement);
    }
    let _: for<'db, 'q> fn(AsyncSql<'db, 'q>) = async_sql_is_send;

    fn direct_construction_surface() {
        let _: Result<_> = Oliphaunt::open();
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
        let streamed_bytes = std::sync::Arc::new(std::sync::Mutex::new(0_usize));
        let callback_bytes = std::sync::Arc::clone(&streamed_bytes);
        let _owned_raw_stream = database.exec_protocol_raw_stream([], move |chunk| {
            *callback_bytes.lock().expect("stream byte counter") += chunk.len();
        });
        let _ = streamed_bytes;
        let _raw_stream = database.exec_protocol_raw_stream([], |_| ());
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
        let _ = transaction.rollback();
    }
    fn direct_server_surface(server: &mut oliphaunt_wasix::OliphauntServer) {
        let _: &str = server.connection_string();
        let _ = server.is_closed();
        let _: Result<_> = server.close();
    }
    let _: fn(&mut Oliphaunt) = direct_database_surface;
    let _: fn(&mut Oliphaunt) -> Result<()> = sdk_only_blocking_callbacks;
    let _: fn(&mut Oliphaunt) -> TransactionResult<(), ApplicationError> =
        typed_blocking_transaction;
    let _: fn(&mut Oliphaunt) -> RawStreamResult<(), ParserError> = typed_blocking_stream;
    let _: fn(&mut Transaction<'_>) = direct_transaction_surface;
    let _: fn(&mut oliphaunt_wasix::OliphauntServer) = direct_server_surface;

    // liboliphaunt-doc-example:wasix-rust-async
    fn async_database_surface(database: &AsyncOliphaunt) {
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
        let _raw_stream = database.exec_protocol_raw_stream([], |_| ());
        let _backup = database.backup();
        let _ = database.is_closed();
        let _close = database.close();
        std::mem::drop(sdk_only_async_callbacks(database));
        std::mem::drop(typed_async_transaction(database));
        assert_send(typed_async_stream(database));
    }
    fn async_transaction_surface(transaction: &mut AsyncTransaction) {
        let _ = transaction.is_closed();
        std::mem::drop(transaction.sql("SELECT $1::int4").bind(1_i32).query());
        std::mem::drop(
            transaction
                .sql("UPDATE items SET value = $1")
                .bind("value")
                .execute(),
        );
        std::mem::drop(transaction.query_with_params("SELECT $1::int8", [1_i64]));
        std::mem::drop(transaction.sql("SELECT 1").describe());
        std::mem::drop(transaction.exec("SELECT 1"));
        std::mem::drop(transaction.rollback());
    }
    fn async_server_surface(server: &AsyncOliphauntServer) {
        let _clone = server.clone();
        let _: &str = server.connection_string();
        let _ = server.is_closed();
        assert_send(server.close());
    }
    let _: fn(&AsyncOliphaunt) = async_database_surface;
    let _: fn(&mut AsyncTransaction) = async_transaction_surface;
    let _: fn(&AsyncOliphauntServer) = async_server_surface;
}

#[cfg(feature = "extension-vector")]
#[test]
fn extensions_expose_only_the_selection_contract() {
    use oliphaunt_wasix::Extension;

    fn assert_extension_traits<T: Copy + Eq + std::hash::Hash + Ord>() {}
    assert_extension_traits::<Extension>();

    let extension: Extension = Extension::VECTOR;
    assert_eq!(extension.sql_name(), "vector");
    assert_eq!(Extension::by_sql_name("vector"), Some(extension));
    assert!(Extension::ALL.contains(&extension));
}

#[cfg(feature = "extension-earthdistance")]
#[test]
fn extension_features_expose_required_dependency_selectors() {
    use oliphaunt_wasix::Extension;

    assert_eq!(
        Extension::by_sql_name("earthdistance"),
        Some(Extension::EARTHDISTANCE)
    );
    assert_eq!(Extension::by_sql_name("cube"), Some(Extension::CUBE));
    assert!(Extension::ALL.contains(&Extension::EARTHDISTANCE));
    assert!(Extension::ALL.contains(&Extension::CUBE));
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
        let _: Result<_> = database.pg_dump(oliphaunt_wasix::tools::PgDumpOptions::new());
        let _: Result<_> =
            database.psql(oliphaunt_wasix::tools::PsqlOptions::new().command("SELECT 1"));
    }
    fn async_tool_surface(database: &AsyncOliphaunt) {
        std::mem::drop(database.pg_dump(oliphaunt_wasix::tools::PgDumpOptions::new()));
        std::mem::drop(
            database.psql(oliphaunt_wasix::tools::PsqlOptions::new().command("SELECT 1")),
        );
    }
    let _: fn(&mut Oliphaunt) = direct_tool_surface;
    let _: fn(&AsyncOliphaunt) = async_tool_surface;
}
