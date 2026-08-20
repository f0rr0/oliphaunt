use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{SystemTime, UNIX_EPOCH};

use oliphaunt::{Error, Oliphaunt, QueryParam};

// liboliphaunt-doc-example:rust-backup-restore

const DIRECT_CHILD_ACTION: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_CHILD";
const DIRECT_CHILD_ROOT: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_ROOT";
const DIRECT_CHILD_BACKUP: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_BACKUP";

#[test]
fn direct_query_transaction_backup_restore_and_process_ownership_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        eprintln!("skipping native smoke: LIBOLIPHAUNT_PATH is unset");
        return;
    }
    if let Some(action) = std::env::var_os(DIRECT_CHILD_ACTION) {
        let root = PathBuf::from(
            std::env::var_os(DIRECT_CHILD_ROOT).expect("direct smoke child root is missing"),
        );
        match action.to_str() {
            Some("seed") => seed_direct_database(
                &root,
                &PathBuf::from(
                    std::env::var_os(DIRECT_CHILD_BACKUP)
                        .expect("direct smoke child backup path is missing"),
                ),
            ),
            Some("verify") => verify_direct_database(&root),
            _ => panic!("direct smoke child action is invalid"),
        }
        .unwrap();
        return;
    }

    let root = unique_root("native-smoke");
    let restored = unique_root("native-smoke-restored");
    let backup = unique_root("native-smoke-backup.tar");
    let result = std::panic::catch_unwind(|| {
        run_direct_child("seed", &root, Some(&backup));
        Oliphaunt::restore(&restored, std::fs::read(&backup).unwrap()).unwrap();
        run_direct_child("verify", &restored, None);
    });
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(restored);
    let _ = std::fs::remove_file(backup);
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

fn run_direct_child(action: &str, root: &Path, backup: Option<&Path>) {
    let mut command =
        Command::new(std::env::current_exe().expect("current test executable missing"));
    command
        .arg("direct_query_transaction_backup_restore_and_process_ownership_when_available")
        .arg("--exact")
        .arg("--nocapture")
        .env(DIRECT_CHILD_ACTION, action)
        .env(DIRECT_CHILD_ROOT, root);
    if let Some(backup) = backup {
        command.env(DIRECT_CHILD_BACKUP, backup);
    }
    let output = command
        .output()
        .expect("failed to spawn direct smoke child");
    assert!(
        output.status.success(),
        "direct smoke child {action} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn seed_direct_database(root: &Path, backup: &Path) -> oliphaunt::Result<()> {
    let database = block_on(Oliphaunt::builder().directory(root).open())?;
    block_on(database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text)"))?;
    let multiple =
        block_on(database.execute(
            "CREATE TABLE must_not_exist(id integer); INSERT INTO must_not_exist VALUES (1)",
        ))
        .expect_err("high-level execute must represent exactly one statement");
    assert!(
        multiple.to_string().contains("multiple commands"),
        "{multiple}"
    );
    assert_eq!(
        block_on(
            database
                .query("SELECT (to_regclass('public.must_not_exist') IS NULL)::text AS absent",)
        )?
        .get_text(0, "absent")?,
        Some("true")
    );
    block_on(database.execute_with_params(
        "INSERT INTO items VALUES ($1, $2)",
        [QueryParam::from(1_i32), QueryParam::from("one")],
    ))?;
    block_on(database.transaction(async |transaction| {
        transaction.execute("INSERT INTO items VALUES (2, 'two')").await?;
        transaction.execute("SAVEPOINT one_statement_probe").await?;
        let multiple = transaction
            .execute(
                "CREATE TABLE transaction_must_not_exist(id integer); INSERT INTO transaction_must_not_exist VALUES (1)",
            )
            .await
            .expect_err("transaction execute must represent exactly one statement");
        assert!(multiple.to_string().contains("multiple commands"));
        transaction
            .execute("ROLLBACK TO SAVEPOINT one_statement_probe")
            .await?;
        Ok(())
    }))?;
    let rows = block_on(database.query("SELECT value FROM items ORDER BY id"))?;
    assert_eq!(rows.row_count(), Some(2));

    let duplicate = match block_on(Oliphaunt::builder().directory(root).open()) {
        Ok(_) => panic!("second direct instance unexpectedly opened"),
        Err(error) => error,
    };
    assert!(
        duplicate
            .to_string()
            .contains("active process-wide instance"),
        "{duplicate}"
    );

    std::fs::write(backup, block_on(database.backup())?).map_err(|error| {
        Error::Engine(format!(
            "write native smoke backup {}: {error}",
            backup.display()
        ))
    })?;
    block_on(database.close())
}

fn verify_direct_database(root: &Path) -> oliphaunt::Result<()> {
    let database = block_on(Oliphaunt::builder().directory(root).open())?;
    let result = block_on(database.query("SELECT value FROM items ORDER BY id"))?;
    assert_eq!(result.row_count(), Some(2));
    assert_eq!(result.get_text(0, "value")?, Some("one"));
    assert_eq!(result.get_text(1, "value")?, Some("two"));
    block_on(database.close())
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
