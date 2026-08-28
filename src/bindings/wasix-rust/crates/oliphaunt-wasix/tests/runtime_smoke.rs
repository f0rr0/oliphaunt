#![cfg(feature = "extensions")]

use anyhow::Result;
use oliphaunt_wasix::{
    AsyncOliphaunt, AsyncOliphauntServer, AsyncTransaction, DatabaseStorage, Error, Oliphaunt,
    OliphauntServer, TransactionResult,
};
use std::convert::Infallible;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

// OLIPHAUNT_DOCS_SNIPPET wasix-rust-quickstart

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let mut context = Context::from_waker(Waker::noop());
    future.poll(&mut context)
}

fn synthetic_sdk_error() -> oliphaunt_wasix::Error {
    let workspace = tempfile::tempdir().expect("temporary callback-error workspace");
    Oliphaunt::restore(workspace.path().join("invalid"), b"not a physical archive")
        .expect_err("invalid archive creates a public SDK error")
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
        transaction
            .sql("INSERT INTO items VALUES ($1, $2)")
            .bind(1_i32)
            .bind("committed")
            .execute()?;
        Ok::<(), Error>(())
    })?;
    let rollback: TransactionResult<(), Error> = database.transaction(|transaction| {
        transaction
            .sql("INSERT INTO items VALUES ($1, $2)")
            .bind(2_i32)
            .bind("rolled back")
            .execute()?;
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

#[test]
fn direct_protocol_callback_error_and_panic_recover_before_returning() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    let mut callback_error = Some(synthetic_sdk_error());
    let expected_error = callback_error.as_ref().expect("callback error").to_string();
    let error = database
        .exec_protocol_raw_stream(b"Q\0\0\0\rSELECT 1\0", move |_| {
            Err(callback_error.take().expect("callback fails once"))
        })
        .expect_err("callback error is returned after protocol cleanup");
    assert_eq!(error.to_string(), expected_error);
    assert_eq!(
        database
            .query("SELECT 41::int4 + 1 AS answer")?
            .get_text(0, "answer")?,
        Some("42")
    );

    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = database.exec_protocol_raw_stream(b"Q\0\0\0\rSELECT 2\0", |_| -> () {
            panic!("protocol callback panic probe")
        });
    }));
    assert!(panic.is_err(), "direct callback panic must be resumed");
    assert_eq!(
        database
            .query("SELECT 42::int4 AS answer")?
            .get_text(0, "answer")?,
        Some("42")
    );
    database.close()?;
    Ok(())
}

#[test]
fn direct_server_close_releases_directory_ownership_before_returning() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("server-root");
    let mut server = OliphauntServer::builder()
        .storage(DatabaseStorage::Directory(root.clone()))
        .start()?;
    server.close()?;
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()?;
    database.close()?;
    assert!(server.is_closed());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_api_owns_the_runtime_and_serializes_clones() -> Result<()> {
    let caller_thread = std::thread::current().id();
    let database = AsyncOliphaunt::open().await?;
    let clone = database.clone();

    database
        .execute("CREATE TABLE owner_items(id int PRIMARY KEY, value text NOT NULL)")
        .await?;
    let (first, second) = tokio::join!(
        database
            .sql("INSERT INTO owner_items VALUES ($1, $2)")
            .bind(1_i32)
            .bind("first")
            .execute(),
        clone
            .sql("INSERT INTO owner_items VALUES ($1, $2)")
            .bind(2_i32)
            .bind("second")
            .execute(),
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
            Ok::<(), Infallible>(())
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
        "async callbacks must run on the SDK-owned database thread"
    );
    assert!(
        reentrant_error
            .lock()
            .expect("reentrant error lock")
            .as_deref()
            .is_some_and(|message| message.contains("reentrant WASIX database work"))
    );

    database
        .transaction(async |transaction: &mut AsyncTransaction| {
            let unpinned = clone.query("SELECT 99::int4 AS forbidden").await;
            assert!(
                unpinned
                    .expect_err("unpinned async work must be rejected during a pinned transaction")
                    .to_string()
                    .contains("transaction is active")
            );
            transaction
                .sql("INSERT INTO owner_items VALUES ($1, $2)")
                .bind(3_i32)
                .bind("transaction")
                .execute()
                .await?;
            Ok::<(), Error>(())
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
async fn async_protocol_callback_error_and_panic_recover_the_owner() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let mut callback_error = Some(synthetic_sdk_error());
    let expected_error = callback_error.as_ref().expect("callback error").to_string();
    let error = database
        .exec_protocol_raw_stream(b"Q\0\0\0\rSELECT 1\0", move |_| {
            Err(callback_error.take().expect("callback fails once"))
        })
        .await
        .expect_err("callback error is returned after protocol cleanup");
    assert_eq!(error.to_string(), expected_error);
    assert_eq!(
        database
            .query("SELECT 42::int4 AS answer")
            .await?
            .get_text(0, "answer")?,
        Some("42")
    );

    let error = database
        .exec_protocol_raw_stream(b"Q\0\0\0\rSELECT 2\0", |_| -> () {
            panic!("async protocol callback panic probe")
        })
        .await
        .expect_err("owner-thread callback panic becomes an SDK error");
    assert!(error.to_string().contains("protocol callback panicked"));
    assert_eq!(
        database
            .query("SELECT 42::int4 AS answer")
            .await?
            .get_text(0, "answer")?,
        Some("42")
    );
    database.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panicking_async_transaction_rolls_back_and_releases_the_owner() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    database
        .execute("CREATE TABLE panic_items(id int PRIMARY KEY)")
        .await?;
    let transaction_database = database.clone();
    let task = tokio::spawn(async move {
        transaction_database
            .transaction(async |transaction: &mut AsyncTransaction| {
                transaction
                    .execute("INSERT INTO panic_items VALUES (1)")
                    .await?;
                panic!("async transaction callback panic probe");
                #[allow(unreachable_code)]
                Ok::<(), oliphaunt_wasix::Error>(())
            })
            .await
    });
    assert!(
        task.await
            .expect_err("transaction task must panic")
            .is_panic()
    );
    assert_eq!(
        database
            .query("SELECT count(*)::int4 AS count FROM panic_items")
            .await?
            .get_text(0, "count")?,
        Some("0")
    );
    database.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_queued_operation_has_no_database_effect() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    database
        .execute("CREATE TABLE abandoned_items(id int PRIMARY KEY)")
        .await?;
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let mut release_rx = Some(release_rx);
    let mut blocker = Box::pin(database.exec_protocol_raw_stream(
        b"Q\0\0\0\rSELECT 1\0",
        move |_| {
            if let Some(release_rx) = release_rx.take() {
                entered_tx.send(()).expect("signal blocked owner callback");
                release_rx.recv().expect("release blocked owner callback");
            }
            Ok::<(), Infallible>(())
        },
    ));
    assert!(poll_once(blocker.as_mut()).is_pending());
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("owner callback starts");

    let mut abandoned = Box::pin(database.execute("INSERT INTO abandoned_items VALUES (1)"));
    assert!(poll_once(abandoned.as_mut()).is_pending());
    drop(abandoned);

    release_tx.send(()).expect("release owner callback");
    blocker.await?;
    assert_eq!(
        database
            .query("SELECT count(*)::int4 AS count FROM abandoned_items")
            .await?
            .get_text(0, "count")?,
        Some("0")
    );
    database.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_close_future_does_not_cancel_the_close_attempt() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let mut release_rx = Some(release_rx);
    let mut blocker = Box::pin(database.exec_protocol_raw_stream(
        b"Q\0\0\0\rSELECT 1\0",
        move |_| {
            if let Some(release_rx) = release_rx.take() {
                entered_tx.send(()).expect("signal blocked owner callback");
                release_rx.recv().expect("release blocked owner callback");
            }
            Ok::<(), Infallible>(())
        },
    ));
    assert!(poll_once(blocker.as_mut()).is_pending());
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("owner callback starts");

    let mut close = Box::pin(database.close());
    assert!(poll_once(close.as_mut()).is_pending());
    drop(close);
    release_tx.send(()).expect("release owner callback");
    blocker.await?;
    database.close().await?;
    assert!(database.is_closed());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_server_close_releases_directory_ownership_before_completion() -> Result<()> {
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("async-server-root");
    let server = AsyncOliphauntServer::builder()
        .storage(DatabaseStorage::Directory(root.clone()))
        .start()
        .await?;
    server.close().await?;
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()?;
    database.close()?;
    assert!(server.is_closed());
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
            Ok::<(), Infallible>(())
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
        Ok::<(), Error>(())
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
            Ok::<(), Infallible>(())
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

    let mut transaction = Box::pin(database.transaction(
        async |transaction: &mut AsyncTransaction| {
            transaction
                .execute("INSERT INTO rollback_items VALUES (1)")
                .await?;
            std::future::pending::<oliphaunt_wasix::Result<()>>().await
        },
    ));
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

#[test]
fn managed_sync_transaction_rejects_manual_commit_and_retires_the_session() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    let outcome = database.transaction(|transaction| {
        let manual_commit = transaction
            .execute("COMMIT")
            .expect_err("managed transactions must reject a manual COMMIT outcome");
        assert!(
            manual_commit
                .to_string()
                .contains("SDK-managed transaction"),
            "{manual_commit}"
        );
        Ok::<(), oliphaunt_wasix::Error>(())
    });
    assert!(
        outcome
            .expect_err("the outer transaction cannot turn a manual COMMIT into success")
            .to_string()
            .contains("SDK-managed transaction")
    );
    assert!(
        database.query("SELECT 1").is_err(),
        "work after escaped managed ownership must remain close-only"
    );
    database.close()?;
    assert!(database.is_closed());
    Ok(())
}

#[test]
fn managed_sync_transaction_rejects_and_chain_before_dispatch() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    database.transaction(|transaction| {
        for error in [
            transaction
                .execute("ROLLBACK AND CHAIN")
                .expect_err("extended execute rejects transaction replacement"),
            transaction
                .query("ABORT WORK AND CHAIN")
                .expect_err("extended query rejects transaction replacement"),
            transaction
                .exec("SELECT 1; ROLLBACK TRANSACTION AND CHAIN")
                .expect_err("simple exec rejects transaction replacement"),
        ] {
            assert!(
                error
                    .to_string()
                    .contains("not allowed inside an SDK-managed callback transaction"),
                "{error}"
            );
        }
        transaction.execute("SAVEPOINT retained_work")?;
        transaction.execute("ROLLBACK TO SAVEPOINT retained_work")?;
        Ok::<(), oliphaunt_wasix::Error>(())
    })?;
    database.query("SELECT 1")?;
    database.close()?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_async_transaction_rejects_manual_commit_and_retires_the_owner() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let outcome = database
        .transaction(async |transaction: &mut AsyncTransaction| {
            let manual_commit = transaction
                .execute("COMMIT")
                .await
                .expect_err("managed transactions must reject a manual COMMIT outcome");
            assert!(
                manual_commit
                    .to_string()
                    .contains("SDK-managed transaction"),
                "{manual_commit}"
            );
            Ok::<(), oliphaunt_wasix::Error>(())
        })
        .await;
    assert!(
        outcome
            .expect_err("the outer transaction cannot turn a manual COMMIT into success")
            .to_string()
            .contains("SDK-managed transaction")
    );
    assert!(
        database.query("SELECT 1").await.is_err(),
        "work after escaped managed ownership must remain close-only"
    );
    database.close().await?;
    assert!(database.is_closed());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_async_transaction_rejects_and_chain_before_dispatch() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    database
        .transaction(async |transaction: &mut AsyncTransaction| {
            for error in [
                transaction
                    .execute("ROLLBACK AND CHAIN")
                    .await
                    .expect_err("extended execute rejects transaction replacement"),
                transaction
                    .query("ABORT WORK AND CHAIN")
                    .await
                    .expect_err("extended query rejects transaction replacement"),
                transaction
                    .exec("SELECT 1; ROLLBACK TRANSACTION AND CHAIN")
                    .await
                    .expect_err("simple exec rejects transaction replacement"),
            ] {
                assert!(
                    error
                        .to_string()
                        .contains("not allowed inside an SDK-managed callback transaction"),
                    "{error}"
                );
            }
            transaction.execute("SAVEPOINT retained_work").await?;
            transaction
                .execute("ROLLBACK TO SAVEPOINT retained_work")
                .await?;
            Ok::<(), oliphaunt_wasix::Error>(())
        })
        .await?;
    database.query("SELECT 1").await?;
    database.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoning_an_in_flight_async_commit_retires_the_owner() -> Result<()> {
    let database = AsyncOliphaunt::open().await?;
    database
        .exec(
            "CREATE TABLE deferred_commit_probe(id int PRIMARY KEY); \
             CREATE FUNCTION deferred_commit_sleep() RETURNS trigger \
             LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$; \
             CREATE CONSTRAINT TRIGGER deferred_commit_sleep \
             AFTER INSERT ON deferred_commit_probe DEFERRABLE INITIALLY DEFERRED \
             FOR EACH ROW EXECUTE FUNCTION deferred_commit_sleep()",
        )
        .await?;

    let transaction_database = database.clone();
    let (callback_finished, callback_finished_rx) = tokio::sync::oneshot::channel();
    let settlement = tokio::spawn(async move {
        transaction_database
            .transaction(async |transaction: &mut AsyncTransaction| {
                transaction
                    .execute("INSERT INTO deferred_commit_probe VALUES (1)")
                    .await?;
                let _ = callback_finished.send(());
                Ok::<(), oliphaunt_wasix::Error>(())
            })
            .await
    });
    callback_finished_rx
        .await
        .expect("transaction callback reaches settlement");
    tokio::time::sleep(Duration::from_millis(100)).await;
    settlement.abort();
    assert!(
        settlement
            .await
            .expect_err("abandoned settlement task must be cancelled")
            .is_cancelled()
    );

    let later = tokio::time::timeout(Duration::from_secs(5), database.query("SELECT 1"))
        .await
        .expect("owner must finish the in-flight control and reject later work");
    assert!(
        later.is_err(),
        "an unobserved COMMIT result must make the owner close-only"
    );
    database.close().await?;
    assert!(database.is_closed());
    Ok(())
}
