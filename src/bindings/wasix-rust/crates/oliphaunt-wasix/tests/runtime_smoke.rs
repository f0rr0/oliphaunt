#![cfg(feature = "extensions")]

use anyhow::Result;
use oliphaunt_wasix::{
    DatabaseStorage, Oliphaunt as AsyncOliphaunt, Transaction as AsyncTransaction,
    blocking::Oliphaunt,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

// OLIPHAUNT_DOCS_SNIPPET wasix-rust-quickstart

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let mut context = Context::from_waker(Waker::noop());
    future.poll(&mut context)
}

#[test]
fn direct_api_query_transaction_persistence_and_backup() -> Result<()> {
    // liboliphaunt-doc-example:wasix-rust-backup-restore
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
    database.execute("CHECKPOINT")?;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_root_owns_the_runtime_and_serializes_clones() -> Result<()> {
    let caller_thread = std::thread::current().id();
    let database = AsyncOliphaunt::open().await?;
    let clone = database.clone();

    database
        .execute("CREATE TABLE owner_items(id int PRIMARY KEY, value text NOT NULL)")
        .await?;
    let (first, second) = tokio::join!(
        database.execute_with_params("INSERT INTO owner_items VALUES ($1, $2)", ["1", "first"],),
        clone.execute_with_params("INSERT INTO owner_items VALUES ($1, $2)", ["2", "second"],),
    );
    first?;
    second?;

    let callback_thread = Arc::new(Mutex::new(None));
    let callback_thread_capture = Arc::clone(&callback_thread);
    let reentrant_error = Arc::new(Mutex::new(None));
    let reentrant_error_capture = Arc::clone(&reentrant_error);
    let reentrant_database = database.clone();
    tokio::time::timeout(
        Duration::from_secs(5),
        database.exec_protocol_raw_stream(b"Q\0\0\0\rSELECT 1\0", move |_| {
            *callback_thread_capture
                .lock()
                .expect("callback thread lock") = Some(std::thread::current().id());
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("callback probe runtime");
            let error = runtime
                .block_on(reentrant_database.query("SELECT 2"))
                .expect_err("reentrant owner-thread work must fail instead of deadlocking");
            *reentrant_error_capture
                .lock()
                .expect("reentrant error lock") = Some(error.to_string());
            Ok(())
        }),
    )
    .await
    .expect("owner-thread reentrancy must be rejected without deadlocking")?;
    assert_ne!(
        callback_thread
            .lock()
            .expect("callback thread lock")
            .expect("stream callback ran"),
        caller_thread,
        "root callbacks must run on the SDK-owned database thread"
    );
    assert!(
        reentrant_error
            .lock()
            .expect("reentrant error lock")
            .as_deref()
            .is_some_and(|message| message.contains("reentrant WASIX database work"))
    );

    database
        .transaction(async |transaction: &AsyncTransaction| {
            let unpinned = clone.query("SELECT 99::int4 AS forbidden").await;
            assert!(
                unpinned
                    .expect_err("root work must be rejected during a pinned transaction")
                    .to_string()
                    .contains("transaction is active")
            );
            transaction
                .execute_with_params(
                    "INSERT INTO owner_items VALUES ($1, $2)",
                    ["3", "transaction"],
                )
                .await?;
            Ok(())
        })
        .await?;

    let result = database
        .query("SELECT count(*)::int4 AS count FROM owner_items")
        .await?;
    assert_eq!(result.get_text(0, "count")?, Some("3"));
    let (first_close, second_close) = tokio::join!(database.close(), clone.close());
    first_close?;
    second_close?;
    assert!(database.is_closed());
    assert!(database.query("SELECT 1").await.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_query_precedes_later_transaction_begin() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let mut release_rx = Some(release_rx);
    let mut blocker = Box::pin(database.exec_protocol_raw_stream(
        b"Q\0\0\0\rSELECT 1\0",
        move |_| {
            if let Some(release_rx) = release_rx.take() {
                entered_tx.send(()).expect("signal owner callback entry");
                release_rx.recv().expect("release owner callback");
            }
            Ok(())
        },
    ));
    assert!(poll_once(blocker.as_mut()).is_pending());
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("owner callback must start");

    let mut query = Box::pin(database.query("SELECT 42::int4 AS answer"));
    assert!(
        poll_once(query.as_mut()).is_pending(),
        "the blocked owner makes query admission deterministic"
    );
    let mut transaction = Box::pin(database.transaction(async |transaction| {
        transaction
            .query("SELECT 7::int4 AS inside_transaction")
            .await?;
        Ok(())
    }));
    assert!(
        poll_once(transaction.as_mut()).is_pending(),
        "transaction begin must queue behind the admitted query"
    );

    release_tx.send(()).expect("release owner callback");
    let (blocker, query, transaction) = tokio::join!(blocker, query, transaction);
    blocker?;
    let query = query?;
    assert_eq!(query.get_text(0, "answer")?, Some("42"));
    transaction?;
    database.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_drains_admitted_query_and_rejects_later_work() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let mut release_rx = Some(release_rx);
    let mut blocker = Box::pin(database.exec_protocol_raw_stream(
        b"Q\0\0\0\rSELECT 1\0",
        move |_| {
            if let Some(release_rx) = release_rx.take() {
                entered_tx.send(()).expect("signal owner callback entry");
                release_rx.recv().expect("release owner callback");
            }
            Ok(())
        },
    ));
    assert!(poll_once(blocker.as_mut()).is_pending());
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("owner callback must start");

    let mut query = Box::pin(database.query("SELECT 43::int4 AS answer"));
    assert!(poll_once(query.as_mut()).is_pending());
    let mut close = Box::pin(database.close());
    assert!(
        poll_once(close.as_mut()).is_pending(),
        "close must wait behind work admitted before its cutoff"
    );
    let mut rejected = Box::pin(database.query("SELECT 99::int4 AS too_late"));
    let Poll::Ready(rejected) = poll_once(rejected.as_mut()) else {
        panic!("work polled after the close cutoff must be rejected at admission");
    };
    assert!(
        rejected
            .expect_err("post-cutoff work must fail")
            .to_string()
            .contains("closing")
    );

    release_tx.send(()).expect("release owner callback");
    let (blocker, query, close) = tokio::join!(blocker, query, close);
    blocker?;
    let query = query?;
    assert_eq!(query.get_text(0, "answer")?, Some("43"));
    close?;
    assert!(database.is_closed());
    assert!(database.query("SELECT 1").await.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_async_transaction_rolls_back_before_following_work() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    database
        .execute("CREATE TABLE rollback_items(id int PRIMARY KEY)")
        .await?;

    let mut transaction = Box::pin(
        database.transaction(async |transaction: &AsyncTransaction| {
            transaction
                .execute("INSERT INTO rollback_items VALUES (1)")
                .await?;
            std::future::pending::<oliphaunt_wasix::Result<()>>().await
        }),
    );
    tokio::select! {
        _ = &mut transaction => panic!("transaction should remain pending"),
        _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
    }
    drop(transaction);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        database.query("SELECT count(*)::int4 AS count FROM rollback_items"),
    )
    .await
    .expect("best-effort rollback must release the owner")?;
    assert_eq!(result.get_text(0, "count")?, Some("0"));
    database.close().await?;
    Ok(())
}
