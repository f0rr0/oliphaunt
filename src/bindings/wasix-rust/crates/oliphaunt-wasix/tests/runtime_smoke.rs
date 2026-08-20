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
    let multiple = database
        .execute("CREATE TABLE must_not_exist(id integer); INSERT INTO must_not_exist VALUES (1)")
        .expect_err("high-level execute must represent exactly one statement");
    assert!(
        multiple.to_string().contains("multiple commands"),
        "{multiple}"
    );
    assert_eq!(
        database
            .query("SELECT (to_regclass('public.must_not_exist') IS NULL)::text AS absent")?
            .get_text(0, "absent")?,
        Some("true")
    );
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
    database.execute("PREPARE oliphaunt_backup_probe AS SELECT 7::int4 AS value")?;
    database.execute("CREATE TEMP TABLE oliphaunt_backup_temp(value text NOT NULL)")?;
    database.execute("INSERT INTO oliphaunt_backup_temp VALUES ('session-state')")?;
    database.execute("SET application_name = 'oliphaunt-backup-session'")?;
    database.execute("SET search_path = pg_temp, public")?;
    database.execute("CREATE ROLE oliphaunt_backup_role SUPERUSER")?;
    database.execute("SET ROLE oliphaunt_backup_role")?;
    database.query("SELECT pg_advisory_lock(424242)")?;
    database.execute("LISTEN oliphaunt_backup_probe")?;
    database.checkpoint()?;
    let backup = database.backup()?;
    assert_eq!(
        database
            .query("EXECUTE oliphaunt_backup_probe")?
            .get_text(0, "value")?,
        Some("7")
    );
    assert_eq!(
        database
            .query("SELECT value FROM oliphaunt_backup_temp")?
            .get_text(0, "value")?,
        Some("session-state")
    );
    assert_eq!(
        database
            .query("SELECT current_setting('application_name') AS value")?
            .get_text(0, "value")?,
        Some("oliphaunt-backup-session")
    );
    assert_eq!(
        database
            .query("SELECT current_setting('search_path') AS value")?
            .get_text(0, "value")?,
        Some("pg_temp, public")
    );
    assert_eq!(
        database
            .query("SELECT current_user AS value")?
            .get_text(0, "value")?,
        Some("oliphaunt_backup_role")
    );
    assert_eq!(
        database
            .query(
                "SELECT count(*)::int4 AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
            )?
            .get_text(0, "count")?,
        Some("1")
    );
    assert_eq!(
        database
            .query(
                "SELECT count(*)::int4 AS count FROM pg_listening_channels() AS channels(channel) WHERE channel = 'oliphaunt_backup_probe'",
            )?
            .get_text(0, "count")?,
        Some("1")
    );
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
