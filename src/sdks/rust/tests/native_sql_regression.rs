use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::time::{SystemTime, UNIX_EPOCH};

use oliphaunt::{
    AsyncOliphaunt as Oliphaunt, AsyncOliphauntBuilder as OliphauntBuilder, AsyncOliphauntServer,
    DatabaseStorage, Error, ErrorKind, IntoParameter, Parameter, Result, ServerListen,
};
use serde::Deserialize;

mod support;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BehaviorContract {
    schema_version: u32,
    id: String,
    sentinel: String,
    statements: Vec<String>,
    expected_error: BehaviorExpectedError,
    recovery_statements: Vec<String>,
    assertion: BehaviorAssertion,
    cleanup_statements: Vec<String>,
}

#[derive(Deserialize)]
struct BehaviorExpectedError {
    sql: String,
    sqlstate: String,
}

#[derive(Deserialize)]
struct BehaviorAssertion {
    sql: String,
    column: String,
    expected: String,
}

#[derive(Debug)]
enum CallbackError {
    Database(Error),
    ApplicationFailure,
}

impl From<Error> for CallbackError {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for CallbackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(formatter),
            Self::ApplicationFailure => formatter.write_str("application failure"),
        }
    }
}

impl std::error::Error for CallbackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::ApplicationFailure => None,
        }
    }
}

#[test]
fn native_postgres_types_errors_and_transaction_recovery_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        eprintln!("skipping native SQL regression: LIBOLIPHAUNT_PATH is unset");
        return;
    }

    run_embedded(Oliphaunt::builder()).unwrap();

    if let Some(broker) = option_env!("CARGO_BIN_EXE_oliphaunt-broker")
        .map(str::to_owned)
        .or_else(|| std::env::var("OLIPHAUNT_BROKER").ok())
    {
        run_embedded(Oliphaunt::builder().broker().broker_executable(broker)).unwrap();
    } else {
        eprintln!("skipping native broker SQL regression: broker helper is unavailable");
    }

    let server_root = unique_root("server-sql-regression");
    let server_result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
        let server = block_on(
            AsyncOliphauntServer::builder()
                .storage(DatabaseStorage::Directory(server_root.clone()))
                .listen(ServerListen::tcp())
                .start(),
        )?;
        assert!(!server.connection_string().is_empty());
        let version = support::external_raw_query(
            server.connection_string(),
            simple_query_request("SELECT current_setting('server_version_num') AS version"),
        )?;
        assert!(
            support::first_data_row_text_values(&version)
                .first()
                .is_some_and(|value| value.starts_with("18"))
        );
        let copy = support::external_raw_query(
            server.connection_string(),
            simple_query_request("COPY (SELECT 'server-stream') TO STDOUT"),
        )?;
        assert!(
            copy.contains(&b'H'),
            "server response omitted CopyOutResponse"
        );
        assert!(copy.contains(&b'd'), "server response omitted CopyData");
        assert!(
            copy.contains(&b'C'),
            "server response omitted CommandComplete"
        );
        assert!(
            copy.contains(&b'Z'),
            "server response omitted ReadyForQuery"
        );
        Ok(block_on(server.close())?)
    })();
    let _ = std::fs::remove_dir_all(server_root);
    server_result.unwrap();
}

fn run_embedded(builder: OliphauntBuilder) -> Result<()> {
    let db = block_on(builder.open())?;
    let source = support::fixture_text(
        "shared/fixtures/postgres/behavior-contract.json",
        "testdata/behavior-contract.json",
    );
    let contract: BehaviorContract =
        serde_json::from_str(&source).expect("shared PostgreSQL behavior contract is valid JSON");
    assert_eq!(contract.schema_version, 2);
    assert_eq!(contract.id, "postgres-18-core-behavior");
    for statement in &contract.statements {
        block_on(db.execute(statement))?;
    }
    let expected = block_on(db.execute(&contract.expected_error.sql)).unwrap_err();
    assert_eq!(expected.kind(), ErrorKind::Postgres);
    let postgres = expected
        .postgres_error()
        .expect("PostgreSQL behavior-contract error has diagnostics");
    assert_eq!(
        postgres.sqlstate.as_deref(),
        Some(contract.expected_error.sqlstate.as_str())
    );
    for statement in &contract.recovery_statements {
        block_on(db.execute(statement))?;
    }
    let assertion = block_on(db.query(&contract.assertion.sql))?;
    assert_eq!(
        assertion.get_text(0, &contract.assertion.column)?,
        Some(contract.assertion.expected.as_str())
    );
    assert_eq!(contract.sentinel, contract.assertion.expected);

    let parameters = block_on(db.query_with_params(
        "SELECT $1::text AS text_value, encode($2::bytea, 'hex') AS bytes_value",
        [
            "parameter".into_parameter(),
            Parameter::binary([0_u8, 1, 255]),
        ],
    ))?;
    assert_eq!(parameters.get_text(0, "text_value")?, Some("parameter"));
    assert_eq!(parameters.get_text(0, "bytes_value")?, Some("0001ff"));

    let duplicate = block_on(db.execute(
        "INSERT INTO oliphaunt_contract.projects(slug, budget, labels, metadata, created_at) VALUES ('alpha', 1, ARRAY[]::text[], '{}', CURRENT_TIMESTAMP)",
    ))
    .unwrap_err();
    assert_eq!(duplicate.kind(), ErrorKind::Postgres);
    let postgres = duplicate
        .postgres_error()
        .expect("PostgreSQL duplicate-key error has diagnostics");
    assert_eq!(postgres.sqlstate.as_deref(), Some("23505"));

    block_on(db.transaction(async |transaction| {
        transaction.execute("SAVEPOINT before_duplicate").await?;
        let duplicate = transaction
            .execute("INSERT INTO oliphaunt_contract.projects(slug, budget, labels, metadata, created_at) VALUES ('alpha', 1, ARRAY[]::text[], '{}', CURRENT_TIMESTAMP)")
            .await
            .unwrap_err();
        assert_eq!(duplicate.kind(), ErrorKind::Postgres);
        assert_eq!(
            duplicate
                .postgres_error()
                .and_then(|error| error.sqlstate.as_deref()),
            Some("23505")
        );
        transaction.execute("ROLLBACK TO SAVEPOINT before_duplicate").await?;
        transaction
            .execute("INSERT INTO oliphaunt_contract.projects(slug, budget, labels, metadata, created_at) VALUES ('saved', 1, ARRAY[]::text[], '{}', CURRENT_TIMESTAMP)")
            .await?;
        Ok(())
    }))?;

    let body_error = block_on(db.transaction(async |transaction| {
        transaction
            .execute("INSERT INTO oliphaunt_contract.projects(slug, budget, labels, metadata, created_at) VALUES ('rolled-back', 1, ARRAY[]::text[], '{}', CURRENT_TIMESTAMP)")
            .await?;
        Err::<(), _>(CallbackError::ApplicationFailure)
    }))
    .unwrap_err();
    assert!(
        matches!(
            body_error.callback_error(),
            Some(CallbackError::ApplicationFailure)
        ),
        "typed callback failure must remain intact: {body_error}"
    );
    assert!(body_error.database_error().is_none());
    assert!(body_error.rollback_error().is_none());

    let count =
        block_on(db.query("SELECT count(*)::text AS count FROM oliphaunt_contract.projects"))?;
    assert_eq!(count.get_text(0, "count")?, Some("3"));

    block_on(db.execute("CREATE TABLE copy_probe(id integer PRIMARY KEY, value text NOT NULL)"))?;
    let copy_response = block_on(db.exec_protocol_raw(copy_in_request(
        "COPY copy_probe (id, value) FROM STDIN",
        b"1\tone\n2\ttwo\n",
    )))?;
    assert!(
        copy_response.contains(&b'G'),
        "COPY-IN response omitted CopyInResponse"
    );
    assert!(
        copy_response.contains(&b'C'),
        "COPY-IN response omitted CommandComplete"
    );
    let copied =
        block_on(db.query("SELECT string_agg(value, ',' ORDER BY id) AS values FROM copy_probe"))?;
    assert_eq!(copied.get_text(0, "values")?, Some("one,two"));
    let chunks = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let captured = Arc::clone(&chunks);
    block_on(db.exec_protocol_raw_stream(
        simple_query_request("COPY (SELECT value FROM copy_probe ORDER BY id) TO STDOUT"),
        move |chunk| {
            captured.lock().unwrap().push(chunk.to_vec());
        },
    ))?;
    assert_streamed_copy_response(&chunks);
    let reused = block_on(db.query("SELECT 'ready'::text AS value"))?;
    assert_eq!(reused.get_text(0, "value")?, Some("ready"));
    for statement in &contract.cleanup_statements {
        block_on(db.execute(statement))?;
    }
    block_on(db.close())
}

fn assert_streamed_copy_response(chunks: &Arc<Mutex<Vec<Vec<u8>>>>) {
    let response = chunks.lock().unwrap().concat();
    assert!(response.contains(&b'H'), "stream omitted CopyOutResponse");
    assert!(response.contains(&b'd'), "stream omitted CopyData");
    assert!(response.contains(&b'C'), "stream omitted CommandComplete");
    assert!(response.contains(&b'Z'), "stream omitted ReadyForQuery");
}

fn simple_query_request(sql: &str) -> Vec<u8> {
    frontend_message(b'Q', &[sql.as_bytes(), &[0]].concat())
}

fn copy_in_request(sql: &str, data: &[u8]) -> Vec<u8> {
    let mut request = frontend_message(b'Q', &[sql.as_bytes(), &[0]].concat());
    request.extend(frontend_message(b'd', data));
    request.extend(frontend_message(b'c', &[]));
    request
}

fn frontend_message(tag: u8, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len() + 4).expect("frontend message length fits u32");
    let mut message = Vec::with_capacity(payload.len() + 5);
    message.push(tag);
    message.extend(length.to_be_bytes());
    message.extend(payload);
    message
}

fn unique_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("oliphaunt-{label}-{}-{nonce}", std::process::id()))
}

fn block_on<F: Future>(future: F) -> F::Output {
    struct ThreadWake(std::thread::Thread);
    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
