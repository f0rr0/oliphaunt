#![cfg(feature = "extensions")]

use anyhow::{Context, Result};
use pglite_oxide::{Pglite, capture_phase_timings};
use sqlx::{Connection, Row};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tokio::time::{Duration, timeout};

mod support;
use support::{ChildGuard, TestTrace, trace_step};

fn direct_open_diagnostic() -> String {
    let (result, phases) = capture_phase_timings(|| Pglite::builder().temporary().open());
    let outcome = match result {
        Ok(mut pg) => match pg.close() {
            Ok(()) => "direct temporary Pglite open succeeded".to_owned(),
            Err(err) => format!("direct temporary Pglite open succeeded, close failed: {err:#}"),
        },
        Err(err) => format!("direct temporary Pglite open failed: {err:#}"),
    };
    format!("{outcome}\nphases:\n{phases:#?}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pglite_proxy_print_uri_accepts_sqlx_connection() -> Result<()> {
    let _trace = TestTrace::new("pglite_proxy_print_uri_accepts_sqlx_connection");
    let process = Command::new(env!("CARGO_BIN_EXE_pglite-proxy"))
        .args(["--temporary", "--tcp", "127.0.0.1:0", "--print-uri"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn pglite-proxy")?;
    let mut child = ChildGuard::new(process, "pglite-proxy")?;

    let stdout = child
        .child_mut()
        .stdout
        .take()
        .context("pglite-proxy stdout pipe")?;
    let mut reader = BufReader::new(stdout);
    let mut uri = String::new();
    let bytes = reader
        .read_line(&mut uri)
        .context("read pglite-proxy printed URI")?;
    if bytes == 0 {
        let stderr = child.collect_stderr();
        anyhow::bail!("pglite-proxy exited before printing URI\n\nstderr:\n{stderr}");
    }
    let uri = uri.trim();
    assert!(
        uri.starts_with("postgresql://") || uri.starts_with("postgres://"),
        "unexpected URI: {uri}"
    );
    trace_step("pglite_proxy printed URI");

    let mut conn = match timeout(Duration::from_secs(30), sqlx::PgConnection::connect(uri)).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(err)) => {
            let stderr = child.collect_stderr();
            let direct = direct_open_diagnostic();
            anyhow::bail!(
                "connect to pglite-proxy failed: {err:#}\n\nstderr:\n{stderr}\n\ndirect backend diagnostic:\n{direct}"
            );
        }
        Err(err) => {
            let stderr = child.collect_stderr();
            let direct = direct_open_diagnostic();
            anyhow::bail!(
                "timed out connecting to pglite-proxy: {err}\n\nstderr:\n{stderr}\n\ndirect backend diagnostic:\n{direct}"
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
