use std::future::Future;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{SystemTime, UNIX_EPOCH};

use oliphaunt::{Error, Oliphaunt, QueryParam};

// liboliphaunt-doc-example:rust-backup-restore

const DIRECT_CHILD_ACTION: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_CHILD";
const DIRECT_CHILD_ROOT: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_ROOT";
const DIRECT_CHILD_BACKUP: &str = "OLIPHAUNT_NATIVE_SMOKE_DIRECT_BACKUP";

#[test]
fn server_supports_external_psql_and_pg_basebackup_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        eprintln!("skipping native server/tool smoke: LIBOLIPHAUNT_PATH is unset");
        return;
    }

    let psql = required_native_tool("psql");
    let pg_basebackup = required_native_tool("pg_basebackup");
    let pg_ctl = required_native_runtime_tool("pg_ctl");
    let root = unique_root("native-server-smoke");
    let backup = unique_root("native-server-basebackup");
    let copied_log = backup.with_extension("log");
    let result = std::panic::catch_unwind(|| {
        let server = block_on(Oliphaunt::builder().directory(&root).open_server()).unwrap();
        let seed_output = Command::new(&psql)
            .args([
                "--no-psqlrc",
                "--no-password",
                "--set=ON_ERROR_STOP=1",
                "--dbname",
                server.connection_string(),
                "--command",
                "CREATE SEQUENCE external_client_seq START 40; \
                 CREATE TABLE external_client_items(\
                   id bigint PRIMARY KEY DEFAULT nextval('external_client_seq'),\
                   value text NOT NULL, payload bytea NOT NULL, optional_value text NULL\
                 ); \
                 CREATE UNIQUE INDEX external_client_items_value_idx ON external_client_items(value); \
                 INSERT INTO external_client_items(value, payload, optional_value) VALUES\
                   ('café 🐘', decode('00ff10', 'hex'), NULL),\
                   ('東京', decode('deadbeef', 'hex'), 'present');",
            ])
            .env("PGCONNECT_TIMEOUT", "5")
            .output()
            .expect("seed native server through packaged psql");
        assert_command_succeeded("psql seed", &seed_output);

        let psql_output = Command::new(&psql)
            .args([
                "--no-psqlrc",
                "--no-align",
                "--tuples-only",
                "--quiet",
                "--no-password",
                "--dbname",
                server.connection_string(),
                "--command",
                "SELECT count(*)::text FROM external_client_items",
            ])
            .env("PGCONNECT_TIMEOUT", "5")
            .output()
            .expect("run packaged psql");
        assert_command_succeeded("psql", &psql_output);
        assert_eq!(
            String::from_utf8(psql_output.stdout)
                .expect("psql output is UTF-8")
                .trim(),
            "2"
        );

        let backup_output = Command::new(&pg_basebackup)
            .arg("--dbname")
            .arg(server.connection_string())
            .arg("--pgdata")
            .arg(&backup)
            .args([
                "--format=plain",
                "--wal-method=stream",
                "--checkpoint=fast",
                "--no-password",
            ])
            .env("PGCONNECT_TIMEOUT", "5")
            .output()
            .expect("run packaged pg_basebackup");
        assert_command_succeeded("pg_basebackup", &backup_output);
        assert_eq!(
            std::fs::read_to_string(backup.join("PG_VERSION"))
                .expect("base backup includes PG_VERSION")
                .trim(),
            "18"
        );
        assert!(backup.join("backup_label").is_file());
        assert!(backup.join("global/pg_control").is_file());
        assert!(backup.join("base").is_dir());

        block_on(server.close()).expect("native server closes after external backup");

        let port_probe = TcpListener::bind(("127.0.0.1", 0)).expect("reserve copied server port");
        let port = port_probe
            .local_addr()
            .expect("read copied server port")
            .port();
        drop(port_probe);
        let start_output = Command::new(&pg_ctl)
            .arg("--pgdata")
            .arg(&backup)
            .arg("--log")
            .arg(&copied_log)
            .args(["--wait", "--timeout=60", "start", "--options"])
            .arg(format!("-c listen_addresses=127.0.0.1 -c port={port}"))
            .output()
            .expect("start copied PGDATA with packaged pg_ctl");
        assert_command_succeeded("pg_ctl start copied PGDATA", &start_output);
        let mut copied = PgCtlGuard::new(pg_ctl.clone(), backup.clone());
        let copied_uri = format!("postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable");
        let copied_output = Command::new(&psql)
            .args([
                "--no-psqlrc",
                "--no-align",
                "--tuples-only",
                "--quiet",
                "--no-password",
                "--dbname",
                &copied_uri,
                "--command",
                "SELECT string_agg(value || ':' || encode(payload, 'hex') || ':' || \
                   coalesce(optional_value, 'NULL'), '|' ORDER BY value COLLATE \"C\") \
                 FROM external_client_items; \
                 SELECT to_regclass('external_client_items_value_idx')::text; \
                 SELECT nextval('external_client_seq')::text;",
            ])
            .env("PGCONNECT_TIMEOUT", "10")
            .output()
            .expect("query copied PGDATA through packaged psql");
        assert_command_succeeded("psql copied PGDATA", &copied_output);
        assert_eq!(
            String::from_utf8(copied_output.stdout)
                .expect("copied psql output is UTF-8")
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>(),
            vec![
                "café 🐘:00ff10:NULL|東京:deadbeef:present",
                "external_client_items_value_idx",
                "42",
            ]
        );
        copied.stop();
    });
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(backup);
    let _ = std::fs::remove_file(copied_log);
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

#[test]
fn fresh_server_roots_have_distinct_postgres_system_identifiers_when_available() {
    if std::env::var_os("LIBOLIPHAUNT_PATH").is_none() {
        eprintln!("skipping native server system-ID smoke: LIBOLIPHAUNT_PATH is unset");
        return;
    }

    let first_root = unique_root("native-server-system-id-first");
    let second_root = unique_root("native-server-system-id-second");
    let result = std::panic::catch_unwind(|| {
        let first = fresh_server_system_identifier(&first_root);
        let second = fresh_server_system_identifier(&second_root);
        assert_ne!(
            first, second,
            "independent fresh server roots must not clone one PostgreSQL system identifier"
        );
    });
    let _ = std::fs::remove_dir_all(first_root);
    let _ = std::fs::remove_dir_all(second_root);
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

fn fresh_server_system_identifier(root: &Path) -> String {
    let server = block_on(Oliphaunt::builder().directory(root).open_server())
        .expect("open fresh native server root");
    let result = block_on(
        server
            .query("SELECT system_identifier::text AS system_identifier FROM pg_control_system()"),
    )
    .expect("query PostgreSQL system identifier");
    let identifier = result
        .get_text(0, "system_identifier")
        .expect("read PostgreSQL system identifier")
        .expect("PostgreSQL system identifier is not null")
        .to_owned();
    identifier
        .parse::<u64>()
        .expect("PostgreSQL system identifier is an unsigned integer");
    block_on(server.close()).expect("close native server after system identifier query");
    identifier
}

struct PgCtlGuard {
    pg_ctl: PathBuf,
    pgdata: PathBuf,
    active: bool,
}

impl PgCtlGuard {
    fn new(pg_ctl: PathBuf, pgdata: PathBuf) -> Self {
        Self {
            pg_ctl,
            pgdata,
            active: true,
        }
    }

    fn stop(&mut self) {
        if !self.active {
            return;
        }
        let output = Command::new(&self.pg_ctl)
            .arg("--pgdata")
            .arg(&self.pgdata)
            .args(["--wait", "--timeout=60", "stop", "--mode=fast"])
            .output()
            .expect("stop copied PGDATA");
        assert_command_succeeded("pg_ctl stop copied PGDATA", &output);
        self.active = false;
    }
}

impl Drop for PgCtlGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = Command::new(&self.pg_ctl)
                .arg("--pgdata")
                .arg(&self.pgdata)
                .args(["--wait", "--timeout=60", "stop", "--mode=immediate"])
                .output();
        }
    }
}

fn required_native_tool(name: &str) -> PathBuf {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("OLIPHAUNT_TOOLS_DIR") {
        candidates.push(PathBuf::from(root).join("bin").join(&filename));
    }
    if let Some(root) = std::env::var_os("OLIPHAUNT_RESOURCES_DIR") {
        candidates.push(
            PathBuf::from(root)
                .join("native-tools/oliphaunt-tools/runtime/bin")
                .join(&filename),
        );
    }
    if let Some(root) = std::env::var_os("OLIPHAUNT_INSTALL_DIR") {
        candidates.push(PathBuf::from(root).join("bin").join(&filename));
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "native smoke requires packaged {name}; checked {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn required_native_runtime_tool(name: &str) -> PathBuf {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("OLIPHAUNT_INSTALL_DIR") {
        candidates.push(PathBuf::from(root).join("bin").join(&filename));
    }
    if let Some(root) = std::env::var_os("OLIPHAUNT_RESOURCES_DIR") {
        candidates.push(
            PathBuf::from(root)
                .join("native-runtime/liboliphaunt-native/runtime/bin")
                .join(&filename),
        );
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "native smoke requires packaged {name}; checked {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn assert_command_succeeded(name: &str, output: &Output) {
    assert!(
        output.status.success(),
        "{name} failed with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

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
