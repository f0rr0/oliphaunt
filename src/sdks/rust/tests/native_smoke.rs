use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{SystemTime, UNIX_EPOCH};

use oliphaunt::{Error, Oliphaunt, QueryParam};

// liboliphaunt-doc-example:rust-backup-restore

#[test]
fn direct_query_transaction_backup_restore_and_root_ownership_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        eprintln!("skipping native smoke: LIBOLIPHAUNT_PATH is unset");
        return;
    }

    let root = unique_root("native-smoke");
    let restored = unique_root("native-smoke-restored");
    let result = (|| -> oliphaunt::Result<()> {
        let database = block_on(Oliphaunt::builder().directory(&root).open())?;
        block_on(database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text)"))?;
        block_on(database.execute_with_params(
            "INSERT INTO items VALUES ($1, $2)",
            [QueryParam::from(1_i32), QueryParam::from("one")],
        ))?;
        block_on(database.transaction(async |transaction| {
            transaction
                .execute("INSERT INTO items VALUES (2, 'two')")
                .await?;
            Ok(())
        }))?;
        let rows = block_on(database.query("SELECT value FROM items ORDER BY id"))?;
        assert_eq!(rows.row_count(), Some(2));

        let duplicate = match block_on(Oliphaunt::builder().directory(&root).open()) {
            Ok(_) => panic!("duplicate root unexpectedly opened"),
            Err(error) => error,
        };
        assert!(
            duplicate.to_string().contains("already open"),
            "{duplicate}"
        );

        let backup = block_on(database.backup())?;
        block_on(database.close())?;
        Oliphaunt::restore(&restored, backup)?;
        let reopened = block_on(Oliphaunt::builder().directory(&restored).open())?;
        assert_eq!(
            block_on(reopened.query("SELECT count(*) FROM items"))?.row_count(),
            Some(1)
        );
        block_on(reopened.close())
    })();
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(restored);
    result.unwrap();
}

#[test]
fn descriptorless_nonempty_root_is_rejected_without_mutation_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        return;
    }
    let root = unique_root("native-invalid-root");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("user-file"), b"keep").unwrap();
    let error = match block_on(Oliphaunt::builder().directory(&root).open()) {
        Ok(_) => panic!("descriptorless nonempty root unexpectedly opened"),
        Err(error) => error,
    };
    assert!(matches!(error, Error::Engine(_)));
    assert_eq!(std::fs::read(root.join("user-file")).unwrap(), b"keep");
    assert!(!root.join("pgdata").exists());
    assert!(!root.join(".oliphaunt.json").exists());
    let _ = std::fs::remove_dir_all(root);
}

fn unique_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
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
