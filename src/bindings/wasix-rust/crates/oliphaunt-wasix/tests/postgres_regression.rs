use anyhow::{Context, Result, ensure};
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};
use serde::Deserialize;
use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DURABILITY_CHILD_ROOT: &str = "OLIPHAUNT_WASIX_DURABILITY_CHILD_ROOT";
const DURABILITY_CHILD_READY: &str = "OLIPHAUNT_WASIX_DURABILITY_CHILD_READY";

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

#[test]
fn shared_postgres_behavior_contract() -> Result<()> {
    let fixture = shared_fixture(
        "postgres/behavior-contract.json",
        "postgres-behavior-contract.json",
    )?;
    let contract: BehaviorContract = serde_json::from_str(&fixture)?;
    ensure!(
        contract.schema_version == 2,
        "unsupported behavior fixture schema"
    );
    ensure!(
        contract.id == "postgres-18-core-behavior",
        "unexpected fixture id"
    );

    let mut database = Oliphaunt::open()?;
    for statement in &contract.statements {
        database.execute(statement)?;
    }
    let expected = database
        .execute(&contract.expected_error.sql)
        .expect_err("shared PostgreSQL behavior contract expected an error");
    ensure!(
        expected
            .postgres_error()
            .and_then(|error| error.sqlstate.as_deref())
            == Some(contract.expected_error.sqlstate.as_str()),
        "shared PostgreSQL behavior contract returned the wrong SQLSTATE: {expected:#}"
    );
    for statement in &contract.recovery_statements {
        database.execute(statement)?;
    }
    let result = database.query(&contract.assertion.sql)?;
    ensure!(
        result.get_text(0, &contract.assertion.column)?
            == Some(contract.assertion.expected.as_str()),
        "shared PostgreSQL behavior assertion failed"
    );
    ensure!(
        result.get_text(0, "rows")? == Some("2"),
        "shared PostgreSQL behavior fixture returned the wrong row count"
    );
    ensure!(
        result.get_text(0, &contract.assertion.column)? == Some(contract.sentinel.as_str()),
        "shared PostgreSQL behavior sentinel drifted"
    );
    for statement in &contract.cleanup_statements {
        database.execute(statement)?;
    }
    database.close()?;
    Ok(())
}

fn shared_fixture(shared_relative: &str, packaged_name: &str) -> Result<String> {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let shared = manifest_dir
        .join("../../../../shared/fixtures")
        .join(shared_relative);
    let packaged = manifest_dir.join("src/testdata").join(packaged_name);
    std::fs::read_to_string(&shared)
        .or_else(|_| std::fs::read_to_string(&packaged))
        .with_context(|| {
            format!(
                "read shared fixture {} or packaged fixture {}",
                shared.display(),
                packaged.display()
            )
        })
}

#[test]
fn savepoints_error_recovery_and_indexed_updates() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    database.execute(
        "CREATE TABLE indexed_items(\
           id integer PRIMARY KEY, key integer UNIQUE NOT NULL, value text NOT NULL)",
    )?;
    database.execute("CREATE INDEX indexed_items_value_idx ON indexed_items(value)")?;
    database.execute(
        "INSERT INTO indexed_items \
         SELECT value, value, 'value-' || value::text FROM generate_series(1, 200) value",
    )?;

    database.transaction(|transaction| {
        transaction.execute("SAVEPOINT expected_error")?;
        let duplicate = transaction
            .execute("INSERT INTO indexed_items VALUES (201, 1, 'duplicate')")
            .expect_err("the unique index must reject a duplicate key");
        if !duplicate.to_string().contains("duplicate key") {
            return Err(duplicate);
        }
        transaction.execute("ROLLBACK TO SAVEPOINT expected_error")?;
        transaction.execute("UPDATE indexed_items SET value = 'updated' WHERE key = 42")?;
        Ok::<(), oliphaunt_wasix::Error>(())
    })?;

    database.execute("SET enable_seqscan = off")?;
    let plan =
        database.query("EXPLAIN (COSTS OFF) SELECT value FROM indexed_items WHERE key = 42")?;
    let mut used_index = false;
    for row in plan.rows() {
        used_index |= row
            .text(0)?
            .is_some_and(|line| line.contains("Index Scan") || line.contains("Index Only Scan"));
    }
    ensure!(
        used_index,
        "PostgreSQL did not plan the indexed lookup through its index: {:?}",
        plan.rows()
    );
    ensure!(
        database
            .query("SELECT value FROM indexed_items WHERE key = 42")?
            .get_text(0, "value")?
            == Some("updated"),
        "the indexed update was not visible"
    );

    let expected = database
        .query("SELECT 1 / 0")
        .expect_err("division by zero must fail");
    ensure!(
        expected.to_string().contains("division by zero"),
        "{expected:#}"
    );
    ensure!(
        database
            .query("SELECT 42::text AS value")?
            .get_text(0, "value")?
            == Some("42"),
        "the session did not recover after an expected PostgreSQL error"
    );
    database.close()?;
    Ok(())
}

#[test]
fn panicking_transaction_callback_rolls_back_and_releases_the_database() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    database.execute("CREATE TABLE panic_probe(value integer NOT NULL)")?;

    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _: oliphaunt_wasix::TransactionResult<(), oliphaunt_wasix::Error> = database
            .transaction(|transaction| {
                transaction.execute("INSERT INTO panic_probe VALUES (1)")?;
                panic!("transaction callback panic probe");
            });
    }));
    ensure!(panic.is_err(), "the callback panic must be rethrown");
    ensure!(
        database
            .query("SELECT count(*)::text AS count FROM panic_probe")?
            .get_text(0, "count")?
            == Some("0"),
        "the panicking callback's transaction was not rolled back"
    );

    database.transaction(|transaction| {
        transaction.execute("INSERT INTO panic_probe VALUES (2)")?;
        Ok::<(), oliphaunt_wasix::Error>(())
    })?;
    ensure!(
        database
            .query("SELECT value::text AS value FROM panic_probe")?
            .get_text(0, "value")?
            == Some("2"),
        "transaction ownership remained stranded after the panic"
    );
    database.close()?;
    Ok(())
}

#[test]
fn memory_instances_are_isolated() -> Result<()> {
    let mut first = Oliphaunt::open()?;
    first.execute("CREATE TABLE private_state(value integer)")?;
    first.execute("INSERT INTO private_state VALUES (1)")?;

    let mut second = Oliphaunt::open()?;
    ensure!(
        second
            .query("SELECT to_regclass('private_state')::text AS value")?
            .get_text(0, "value")?
            .is_none(),
        "independent memory databases shared PostgreSQL state"
    );
    second.close()?;
    first.close()?;
    Ok(())
}

#[test]
fn persistent_clean_close_reopens_with_committed_data() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("database");
    {
        let mut database = Oliphaunt::builder()
            .storage(DatabaseStorage::Directory(root.clone()))
            .open()?;
        database.execute("CREATE TABLE durable(value integer NOT NULL)")?;
        database.execute("INSERT INTO durable VALUES (42)")?;
        database.close()?;
    }

    let mut reopened = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()
        .context("reopen a cleanly closed persistent database")?;
    ensure!(
        reopened
            .query("SELECT value::text AS value FROM durable")?
            .get_text(0, "value")?
            == Some("42"),
        "clean close did not preserve committed data"
    );
    reopened.close()?;
    Ok(())
}

#[test]
fn persistent_commit_survives_abrupt_process_exit() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("database");
    let ready = workspace.path().join("committed");
    let stderr = workspace.path().join("child.stderr");
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--exact")
        .arg("abrupt_process_child_commits_then_waits")
        .arg("--nocapture")
        .env(DURABILITY_CHILD_ROOT, &root)
        .env(DURABILITY_CHILD_READY, &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(File::create(&stderr)?))
        .spawn()
        .context("spawn abrupt durability child")?;

    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if ready.exists() {
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let diagnostics = std::fs::read_to_string(&stderr).unwrap_or_default();
                anyhow::bail!(
                    "abrupt durability child exited before committing ({status}): {diagnostics}"
                );
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("poll abrupt durability child");
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let diagnostics = std::fs::read_to_string(&stderr).unwrap_or_default();
            anyhow::bail!("abrupt durability child did not commit in time: {diagnostics}");
        }
        thread::sleep(Duration::from_millis(25));
    }

    child.kill().context("kill abrupt durability child")?;
    child.wait().context("reap abrupt durability child")?;

    let mut reopened = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()
        .context("recover database after abrupt process exit")?;
    let recovered_wal_sync_method = reopened
        .query("SHOW wal_sync_method")?
        .get_text(0, "wal_sync_method")?
        .map(str::to_owned);
    ensure!(
        recovered_wal_sync_method.as_deref() == Some("fdatasync"),
        "recovered WASIX database did not use fdatasync WAL durability: {recovered_wal_sync_method:?}"
    );
    ensure!(
        reopened
            .query("SELECT value::text AS value FROM durable")?
            .get_text(0, "value")?
            == Some("42"),
        "abrupt process exit lost an acknowledged commit"
    );
    reopened.close()?;
    Ok(())
}

#[test]
fn abrupt_process_child_commits_then_waits() -> Result<()> {
    let Some(root) = std::env::var_os(DURABILITY_CHILD_ROOT) else {
        return Ok(());
    };
    let ready = std::env::var_os(DURABILITY_CHILD_READY)
        .context("abrupt durability child has no readiness path")?;
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root.into()))
        .open()?;
    let wal_sync_method = database
        .query("SHOW wal_sync_method")?
        .get_text(0, "wal_sync_method")?
        .map(str::to_owned);
    ensure!(
        wal_sync_method.as_deref() == Some("fdatasync"),
        "WASIX directory database did not use fdatasync WAL durability: {wal_sync_method:?}"
    );
    database.execute("CREATE TABLE durable(value integer NOT NULL)")?;
    database.execute("INSERT INTO durable VALUES (42)")?;
    std::fs::write(ready, b"committed")?;
    loop {
        thread::park();
    }
}
