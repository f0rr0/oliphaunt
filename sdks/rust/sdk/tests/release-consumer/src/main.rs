use std::error::Error;
use std::future::Future;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::Duration;

use oliphaunt::{AsyncOliphauntServer, DatabaseStorage, ServerListen};

fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: oliphaunt-rust-release-consumer DATABASE_ROOT"))?;
    let backup = root.with_file_name("database-basebackup");
    let copied_log = root.with_file_name("database-basebackup.log");
    let psql = packaged_tool("psql")?;
    let pg_basebackup = packaged_tool("pg_basebackup")?;
    let pg_ctl = packaged_runtime_tool("pg_ctl")?;

    let database = block_on(
        AsyncOliphauntServer::builder()
            .storage(DatabaseStorage::Directory(root.clone()))
            .listen(ServerListen::tcp())
            .start(),
    )?;
    let exercise_source = (|| -> Result<(), Box<dyn Error>> {
        command_succeeded(
            "packaged psql seed",
            &Command::new(&psql)
                .args([
                    "--no-psqlrc",
                    "--no-password",
                    "--set=ON_ERROR_STOP=1",
                    "--dbname",
                    database.connection_string(),
                    "--command",
                    "CREATE SEQUENCE packed_backup_seq START 40; \
                     CREATE TABLE packed_backup_items(\
                       id bigint PRIMARY KEY DEFAULT nextval('packed_backup_seq'),\
                       value text NOT NULL, payload bytea NOT NULL, optional_value text NULL\
                     ); \
                     CREATE UNIQUE INDEX packed_backup_items_value_idx ON packed_backup_items(value); \
                     INSERT INTO packed_backup_items(value, payload, optional_value) VALUES\
                       ('café 🐘', decode('00ff10', 'hex'), NULL),\
                       ('東京', decode('deadbeef', 'hex'), 'present');",
                ])
                .env("PGCONNECT_TIMEOUT", "5")
                .output()?,
        )?;
        command_succeeded(
            "packaged pg_basebackup",
            &Command::new(&pg_basebackup)
                .arg("--dbname")
                .arg(database.connection_string())
                .arg("--pgdata")
                .arg(&backup)
                .args([
                    "--format=plain",
                    "--wal-method=stream",
                    "--checkpoint=fast",
                    "--no-password",
                ])
                .env("PGCONNECT_TIMEOUT", "5")
                .output()?,
        )?;
        require_file(&backup.join("PG_VERSION"))?;
        require_file(&backup.join("backup_label"))?;
        require_file(&backup.join("global/pg_control"))?;
        Ok(())
    })();
    let close_source = block_on(database.close());
    exercise_source?;
    close_source?;

    let port_probe = TcpListener::bind(("127.0.0.1", 0))?;
    let port = port_probe.local_addr()?.port();
    drop(port_probe);
    command_succeeded(
        "packaged pg_ctl start copied PGDATA",
        &Command::new(&pg_ctl)
            .arg("--pgdata")
            .arg(&backup)
            .arg("--log")
            .arg(&copied_log)
            .args(["--wait", "--timeout=60", "start", "--options"])
            .arg(format!("-c listen_addresses=127.0.0.1 -c port={port}"))
            .output()?,
    )?;
    let mut copied = PgCtlGuard::new(pg_ctl, backup);
    let copied_uri = format!("postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable");
    let copied_query = Command::new(&psql)
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
             FROM packed_backup_items; \
             SELECT to_regclass('packed_backup_items_value_idx')::text; \
             SELECT nextval('packed_backup_seq')::text;",
        ])
        .env("PGCONNECT_TIMEOUT", "10")
        .output()?;
    command_succeeded("packaged psql copied PGDATA query", &copied_query)?;
    let rows = String::from_utf8(copied_query.stdout)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let expected = [
        "café 🐘:00ff10:NULL|東京:deadbeef:present",
        "packed_backup_items_value_idx",
        "42",
    ];
    if rows != expected {
        return Err(io::Error::other(format!(
            "copied PGDATA query returned {rows:?}, expected {expected:?}"
        ))
        .into());
    }
    copied.stop()?;
    println!(
        "OLIPHAUNT_RUST_RELEASE_CONSUMER_PASS checks=open,external-psql,pg-basebackup,restart,query,close"
    );
    Ok(())
}

fn packaged_tool(name: &str) -> io::Result<PathBuf> {
    packaged_binary("OLIPHAUNT_TOOLS_DIR", name)
}

fn packaged_runtime_tool(name: &str) -> io::Result<PathBuf> {
    packaged_binary("OLIPHAUNT_INSTALL_DIR", name)
}

fn packaged_binary(root_variable: &str, name: &str) -> io::Result<PathBuf> {
    let root = std::env::var_os(root_variable)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other(format!("{root_variable} is unset")))?;
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let path = root.join("bin").join(name);
    require_file(&path)?;
    Ok(path)
}

fn require_file(path: &Path) -> io::Result<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "required packaged file is missing: {}",
            path.display()
        )))
    }
}

fn command_succeeded(name: &str, output: &Output) -> io::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "{name} failed with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )))
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

    fn stop(&mut self) -> io::Result<()> {
        if !self.active {
            return Ok(());
        }
        let output = Command::new(&self.pg_ctl)
            .arg("--pgdata")
            .arg(&self.pgdata)
            .args(["--wait", "--timeout=60", "stop", "--mode=fast"])
            .output()?;
        command_succeeded("packaged pg_ctl stop copied PGDATA", &output)?;
        self.active = false;
        Ok(())
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

fn block_on<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}
