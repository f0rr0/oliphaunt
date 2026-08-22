use anyhow::{Context, Result, ensure};
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};
use serde::Deserialize;

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
        Ok(())
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
