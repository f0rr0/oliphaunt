#![cfg(feature = "wasix")]

use anyhow::{Context, Result};
use oliphaunt_wasix::Oliphaunt;
use sqlx::{Connection, Row};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tokio::time::{Duration, timeout};

mod support;
use support::{ChildGuard, TestTrace, trace_step};

fn direct_open_diagnostic() -> String {
    match Oliphaunt::builder().open() {
        Ok(mut pg) => match pg.close() {
            Ok(()) => "direct memory Oliphaunt open succeeded".to_owned(),
            Err(err) => format!("direct memory Oliphaunt open succeeded, close failed: {err:#}"),
        },
        Err(err) => format!("direct memory Oliphaunt open failed: {err:#}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prepared WASIX runtime"]
async fn oliphaunt_proxy_print_uri_accepts_sqlx_connection() -> Result<()> {
    let _trace = TestTrace::new("oliphaunt_proxy_print_uri_accepts_sqlx_connection");
    let executable = std::env::var_os("OLIPHAUNT_PGWIRE_SERVER_BINARY")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_oliphaunt-pgwire-server").into());
    let process = Command::new(executable)
        .args(["--memory", "--print-uri"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn oliphaunt-pgwire-server")?;
    let mut child = ChildGuard::new(process, "oliphaunt-pgwire-server")?;

    let stdout = child
        .child_mut()
        .stdout
        .take()
        .context("oliphaunt-pgwire-server stdout pipe")?;
    let read_uri = tokio::task::spawn_blocking(move || {
        let mut reader = BufReader::new(stdout);
        let mut uri = String::new();
        let bytes = reader
            .read_line(&mut uri)
            .context("read oliphaunt-pgwire-server printed URI")?;
        Ok::<_, anyhow::Error>((bytes, uri))
    });
    let (bytes, uri) = match timeout(Duration::from_secs(30), read_uri).await {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(err))) => return Err(err),
        Ok(Err(err)) => return Err(err).context("join URI reader task"),
        Err(err) => {
            let stderr = child.collect_stderr();
            anyhow::bail!(
                "timed out waiting for oliphaunt-pgwire-server URI: {err}\n\nstderr:\n{stderr}"
            );
        }
    };
    if bytes == 0 {
        let stderr = child.collect_stderr();
        anyhow::bail!("oliphaunt-pgwire-server exited before printing URI\n\nstderr:\n{stderr}");
    }
    let uri = uri.trim();
    assert!(uri.starts_with("postgresql://"), "unexpected URI: {uri}");
    trace_step("oliphaunt_proxy printed URI");

    let mut conn = match timeout(Duration::from_secs(30), sqlx::PgConnection::connect(uri)).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(err)) => {
            let stderr = child.collect_stderr();
            let direct = direct_open_diagnostic();
            anyhow::bail!(
                "connect to oliphaunt-pgwire-server failed: {err:#}\n\nstderr:\n{stderr}\n\ndirect backend diagnostic:\n{direct}"
            );
        }
        Err(err) => {
            let stderr = child.collect_stderr();
            let direct = direct_open_diagnostic();
            anyhow::bail!(
                "timed out connecting to oliphaunt-pgwire-server: {err}\n\nstderr:\n{stderr}\n\ndirect backend diagnostic:\n{direct}"
            );
        }
    };
    let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
        .bind(41_i32)
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("answer")?, 42);

    conn.close().await?;
    Ok(())
}
