#![cfg(feature = "extensions")]

use anyhow::Result;
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

// OLIPHAUNT_DOCS_SNIPPET wasix-rust-quickstart

#[test]
fn direct_api_query_transaction_persistence_and_backup() -> Result<()> {
    let workspace = tempfile::TempDir::new()?;
    let source_root = workspace.path().join("source");
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(source_root))
        .startup_guc("work_mem", "8MB")
        .open()?;

    database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text NOT NULL)")?;
    database.transaction(|transaction| {
        transaction.execute_with_params("INSERT INTO items VALUES ($1, $2)", ["1", "committed"])?;
        Ok(())
    })?;
    let rollback: oliphaunt_wasix::Result<()> = database.transaction(|transaction| {
        transaction
            .execute_with_params("INSERT INTO items VALUES ($1, $2)", ["2", "rolled back"])?;
        transaction.execute("SELECT 1 / 0").map(|_| ())
    });
    assert!(rollback.is_err());

    let rows = database.query_with_params("SELECT value FROM items WHERE id = $1", [1_i32])?;
    assert_eq!(rows.get_text(0, "value")?, Some("committed"));
    database.checkpoint()?;
    let backup = database.backup()?;
    database.close()?;

    let restored_root = workspace.path().join("restored");
    Oliphaunt::restore(&restored_root, backup)?;
    let mut restored = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(restored_root))
        .open()?;
    let rows = restored.query("SELECT count(*)::int4 AS count FROM items")?;
    assert_eq!(rows.get_text(0, "count")?, Some("1"));
    restored.close()?;
    Ok(())
}

#[test]
fn direct_api_recovers_after_postgres_error() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    let error = database
        .query_with_params("SELECT 1 / $1::int4", [0_i32])
        .expect_err("division by zero must fail");
    assert!(error.to_string().contains("division by zero"));
    let result = database.query("SELECT 42::int4 AS value")?;
    assert_eq!(result.get_text(0, "value")?, Some("42"));
    database.close()?;
    Ok(())
}
