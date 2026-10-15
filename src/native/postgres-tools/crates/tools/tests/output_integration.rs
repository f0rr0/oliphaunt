use std::fs;
use std::io::{self, Cursor};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use oliphaunt_tools::{
    PgDumpOptions, PsqlOptions, pg_dump, pg_dump_to_file, pg_dump_to_writer, psql, psql_to_file,
    psql_to_writer,
};

struct Server {
    root: PathBuf,
    pg_ctl: PathBuf,
    connection: String,
}

static NEXT_SERVER: AtomicUsize = AtomicUsize::new(0);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new(&self.pg_ctl)
            .args(["stop", "-w", "-t", "20", "-m", "immediate", "-D"])
            .arg(self.root.join("pgdata"))
            .output();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn start_server() -> Server {
    let root = std::env::temp_dir().join(format!(
        "oliphaunt-tools-output-{}-{}",
        std::process::id(),
        NEXT_SERVER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let runtime = PathBuf::from(
        std::env::var_os("OLIPHAUNT_INSTALL_DIR").expect("packaged runtime is required"),
    );
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut server = Server {
        root,
        pg_ctl: runtime.join(format!("bin/pg_ctl{suffix}")),
        connection: String::new(),
    };
    let output = Command::new(runtime.join(format!("bin/initdb{suffix}")))
        .env("OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY", "1")
        .env("OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY", "1")
        .args([
            "--username=postgres",
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
            "-D",
        ])
        .arg(server.root.join("pgdata"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "initdb: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let output = Command::new(&server.pg_ctl)
        .args(["start", "-w", "-t", "20", "-D"])
        .arg(server.root.join("pgdata"))
        .arg("-l")
        .arg(server.root.join("postgres.log"))
        .arg("-o")
        .arg(format!(
            "-h 127.0.0.1 -p {port} -c unix_socket_directories='' -c fsync=off"
        ))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "postgres startup: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.connection = format!("postgresql://postgres@127.0.0.1:{port}/postgres");
    server
}

#[test]
#[ignore = "requires the packaged PostgreSQL runtime and tools"]
fn actual_large_dump_destinations_restore_and_preserve_failure_outcomes() {
    let server = start_server();
    psql(&server.connection, PsqlOptions::new().command("CREATE TABLE dump_payload AS SELECT g AS id, repeat('λ', 4096) AS value FROM generate_series(1, 8193) AS g; CREATE ROLE dump_reader LOGIN; CREATE TABLE effects(value integer); GRANT SELECT ON ALL TABLES IN SCHEMA public TO dump_reader" )).unwrap();
    let reader = server.connection.replace("postgres@", "dump_reader@");
    let options = || PgDumpOptions::new().arg("--restrict-key=oliphauntOutputTest");
    let destination = server.root.join("dump.sql");
    let summary = pg_dump_to_file(&reader, options(), &destination, None).unwrap();
    assert!(summary.stdout_bytes > 64 * 1024 * 1024);
    assert!(!summary.stderr_truncated);
    let dump = fs::read_to_string(&destination).unwrap();
    assert_eq!(dump.len(), summary.stdout_bytes);
    assert_eq!(pg_dump(&reader, options()).unwrap(), dump);
    assert!(pg_dump_to_file(&reader, options(), &destination, None).is_err());
    assert_eq!(fs::metadata(&destination).unwrap().len(), dump.len() as u64);

    psql(
        &server.connection,
        PsqlOptions::new().command("CREATE DATABASE restored"),
    )
    .unwrap();
    let restored = server.connection.trim_end_matches("/postgres").to_owned() + "/restored";
    psql(&restored, PsqlOptions::new().script(dump)).unwrap();
    assert_eq!(
        psql(
            &restored,
            PsqlOptions::new()
                .args(["--tuples-only", "--no-align"])
                .command("SELECT count(*) FROM dump_payload WHERE octet_length(value) = 8192")
        )
        .unwrap()
        .trim(),
        "8193"
    );

    let mut full = [];
    let error = pg_dump_to_writer(
        &reader,
        options(),
        &mut Cursor::new(full.as_mut_slice()),
        None,
    )
    .unwrap_err();
    assert_eq!(error.exit_code, Some(0));
    assert_eq!(
        std::error::Error::source(&error)
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::WriteZero
    );
    let error = psql_to_writer(
        &server.connection,
        PsqlOptions::new().command("INSERT INTO effects VALUES (1); SELECT repeat('x', 100000)"),
        &mut Cursor::new(full.as_mut_slice()),
        None,
    )
    .unwrap_err();
    assert_eq!(error.exit_code, Some(0));
    assert_eq!(
        psql(
            &server.connection,
            PsqlOptions::new()
                .args(["--tuples-only", "--no-align"])
                .command("SELECT count(*) FROM effects")
        )
        .unwrap()
        .trim(),
        "1"
    );

    let failed = server.root.join("failed.sql");
    assert!(
        psql_to_file(
            &server.connection,
            PsqlOptions::new().script("SELECT 1; SELECT 1 / 0"),
            &failed,
            None
        )
        .is_err()
    );
    assert!(!failed.exists());
    assert!(fs::read_dir(&server.root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".oliphaunt-tool-")
    }));

    let mut output = Vec::new();
    let mut complete_diagnostics = Vec::new();
    let diagnostics = psql_to_writer(&server.connection, PsqlOptions::new().command("DO $$ BEGIN FOR i IN 1..100 LOOP RAISE WARNING '%', repeat('w', 1024); END LOOP; END $$"), &mut output, Some(&mut complete_diagnostics)).unwrap();
    assert!(complete_diagnostics.len() > 100 * 1024);
    assert!(diagnostics.stderr_truncated);
    assert_eq!(diagnostics.stderr.len(), 8192);
    assert!(String::from_utf8(output).unwrap().contains("DO"));
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires packaged runtime/tools and Node, Bun and Deno"]
fn installed_npm_destinations_preserve_backpressure_and_error_outcomes() {
    let server = start_server();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let output = Command::new("bash")
        .arg(root.join("src/native/postgres-tools/tools/smoke-packed-tools-npm.sh"))
        .arg("--asset-dir")
        .arg(root.join("target/postgres-tools/native/release-assets"))
        .arg("--output-only")
        .env(
            "OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING",
            &server.connection,
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "installed npm destinations: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
