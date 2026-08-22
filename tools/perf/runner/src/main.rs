use std::env;
use std::fs;
use std::io::{BufReader, Cursor, Read, Write};
use std::net::TcpListener;
#[cfg(not(unix))]
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::future::try_join_all;
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{Connection, Executor};
use tar::{Archive, Builder as TarBuilder, Header as TarHeader};

use crate::process_rss::ProcessTreeRssSampler;

mod benchmarks;
mod diagnostics;
mod native_liboliphaunt;
mod native_postgres;
mod prepared_updates;
mod process_rss;
mod report;
mod shared;
mod sqlite;

use benchmarks::*;
use diagnostics::*;
use native_liboliphaunt::*;
use native_postgres::*;
use prepared_updates::*;
use report::*;
use shared::*;
use sqlite::*;

const NATIVE_BENCHMARK_DATABASE: &str = "template1";
const OLIPHAUNT_BENCHMARK_SQL_DIR: &str = "benchmarks/native/sql";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeDurabilityProfile {
    Safe,
    Balanced,
    FastDev,
}

impl NativeDurabilityProfile {
    fn postgres_gucs(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Safe => &[
                ("fsync", "on"),
                ("full_page_writes", "on"),
                ("synchronous_commit", "on"),
            ],
            Self::Balanced => &[
                ("fsync", "on"),
                ("full_page_writes", "on"),
                ("synchronous_commit", "off"),
            ],
            Self::FastDev => &[
                ("fsync", "off"),
                ("full_page_writes", "off"),
                ("synchronous_commit", "off"),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeFootprintProfile {
    Throughput,
    BalancedMobile,
    SmallMobile,
}

impl RuntimeFootprintProfile {
    fn postgres_gucs(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Throughput => &[
                ("shared_buffers", "128MB"),
                ("wal_buffers", "4MB"),
                ("min_wal_size", "80MB"),
            ],
            Self::BalancedMobile => &[
                ("max_connections", "1"),
                ("shared_buffers", "32MB"),
                ("min_wal_size", "32MB"),
                ("max_wal_size", "64MB"),
            ],
            Self::SmallMobile => &[
                ("max_connections", "1"),
                ("shared_buffers", "8MB"),
                ("wal_buffers", "256kB"),
                ("min_wal_size", "32MB"),
                ("max_wal_size", "64MB"),
            ],
        }
    }
}

impl std::fmt::Display for RuntimeFootprintProfile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Throughput => "throughput",
            Self::BalancedMobile => "balanced-mobile",
            Self::SmallMobile => "small-mobile",
        })
    }
}

#[derive(Debug, Clone)]
struct PostgresStartupGuc {
    name: String,
    value: String,
}

impl PostgresStartupGuc {
    fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }
}

fn main() -> Result<()> {
    perf(env::args().skip(1).collect())
}

pub(crate) fn perf(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("diagnose-speed-cases") => perf_diagnose_speed_cases(&args[1..]),
        Some("native-postgres") => perf_native_postgres(&args[1..]),
        Some("native-liboliphaunt") => perf_native_liboliphaunt(&args[1..]),
        Some("native-liboliphaunt-prepared-child") => {
            perf_native_liboliphaunt_prepared_child(&args[1..])
        }
        Some("native-liboliphaunt-restore-verify-child") => {
            perf_native_liboliphaunt_restore_verify_child(&args[1..])
        }
        Some("sqlite") => perf_sqlite(&args[1..]),
        Some("smoke") => run(
            "cargo",
            &[
                "test",
                "--workspace",
                "--locked",
                "preload",
                "--",
                "--nocapture",
            ],
        ),
        Some(other) => bail!("unknown perf subcommand: {other}"),
        None => bail!(
            "usage: cargo run -p oliphaunt-perf -- <native-postgres|native-liboliphaunt|sqlite|diagnose-speed-cases|smoke>"
        ),
    }
}

fn now_micros() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX_EPOCH")?
        .as_micros())
}

fn run(command: &str, args: &[&str]) -> Result<()> {
    let mut command = command_for_host(command);
    command.args(args);
    run_command(&mut command)
}

fn command_for_host(command: &str) -> Command {
    if cfg!(windows)
        && Path::new(command)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sh"))
    {
        let mut shell = Command::new(windows_bash_path());
        shell.arg("--noprofile").arg("--norc");
        shell.arg(command);
        return shell;
    }
    Command::new(command)
}

#[cfg(windows)]
fn windows_bash_path() -> PathBuf {
    for path in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from("bash")
}

#[cfg(not(windows))]
fn windows_bash_path() -> &'static str {
    "bash"
}

fn run_command(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .map_err(|err| anyhow!("failed to spawn command: {err}"))?;
    if !status.success() {
        bail!("command failed with {status}");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkSuiteFilter {
    All,
    Rtt,
    Speed,
    Streaming,
    PreparedUpdates,
    BackupRestore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativePostgresClientMode {
    TokioPostgresSimple,
    Sqlx,
}

impl BenchmarkSuiteFilter {
    fn includes(self, suite: &'static str) -> bool {
        matches!(
            (self, suite),
            (Self::All, "rtt" | "speed")
                | (Self::Rtt, "rtt")
                | (Self::Speed, "speed")
                | (Self::Streaming, "streaming")
                | (Self::PreparedUpdates, "prepared-updates")
                | (Self::BackupRestore, "backup-restore")
        )
    }
}

fn default_native_postgres_tool(tool: &str, env_names: &[&str]) -> PathBuf {
    for env_name in env_names {
        if let Ok(value) = env::var(env_name)
            && !value.is_empty()
        {
            return PathBuf::from(value);
        }
    }
    if let Ok(root) = env::current_dir() {
        let repo_pinned = root
            .join("target")
            .join("liboliphaunt-pg18")
            .join("install")
            .join("bin")
            .join(tool);
        if repo_pinned.is_file() {
            return repo_pinned;
        }
    }
    PathBuf::from(tool)
}

fn perf_native_postgres(args: &[String]) -> Result<()> {
    let mut postgres_bin = default_native_postgres_tool("postgres", &["OLIPHAUNT_POSTGRES"]);
    let mut initdb_bin = default_native_postgres_tool("initdb", &["OLIPHAUNT_INITDB"]);
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::OliphauntFixture;
    let mut rtt_iterations = 100usize;
    let mut prepared_rows = 25_000usize;
    let mut client_mode = NativePostgresClientMode::TokioPostgresSimple;
    let mut tuning = NativeBenchmarkTuning::default();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--postgres-bin" => {
                cursor += 1;
                postgres_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
                );
            }
            "--initdb-bin" => {
                cursor += 1;
                initdb_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
                );
            }
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "all" => BenchmarkSuiteFilter::All,
                    "rtt" | "roundtrip" | "round-trip" => BenchmarkSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    "stream" | "streaming" | "large-results" => BenchmarkSuiteFilter::Streaming,
                    "prepared" | "prepared-updates" => BenchmarkSuiteFilter::PreparedUpdates,
                    "backup" | "backup-restore" | "backup_restore" => {
                        BenchmarkSuiteFilter::BackupRestore
                    }
                    other => {
                        bail!(
                            "unknown --suite value {other:?}; use all, rtt, speed, streaming, prepared-updates, or backup-restore"
                        )
                    }
                };
            }
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                rtt_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                prepared_rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = match value.as_str() {
                    "generated" | "local" => SpeedSqlSource::Generated,
                    "oliphaunt" | "oliphaunt-vendored" | "upstream" => {
                        SpeedSqlSource::OliphauntFixture
                    }
                    other => {
                        bail!("unknown --speed-source value {other:?}; use generated or oliphaunt")
                    }
                };
            }
            "--client" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--client requires a value"))?;
                client_mode = match value.as_str() {
                    "tokio-postgres-simple"
                    | "tokio_postgres_simple"
                    | "tokio-postgres"
                    | "tokio_postgres"
                    | "simple"
                    | "simple-query" => NativePostgresClientMode::TokioPostgresSimple,
                    "sqlx" => NativePostgresClientMode::Sqlx,
                    other => {
                        bail!("unknown --client value {other:?}; use tokio-postgres-simple or sqlx")
                    }
                };
            }
            "--durability" => {
                cursor += 1;
                tuning.durability = parse_native_durability(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--durability requires a value"))?,
                )?;
            }
            "--runtime-footprint" => {
                cursor += 1;
                tuning.runtime_footprint = parse_runtime_footprint(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--runtime-footprint requires a value"))?,
                )?;
            }
            "--startup-guc" => {
                cursor += 1;
                tuning.startup_gucs.push(parse_startup_guc(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--startup-guc requires a value"))?,
                )?);
            }
            other => bail!("unknown perf native-postgres flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");
    ensure!(prepared_rows > 0, "--rows must be greater than zero");

    if suite == BenchmarkSuiteFilter::PreparedUpdates {
        return perf_native_postgres_prepared_updates(
            &postgres_bin,
            &initdb_bin,
            prepared_rows,
            tuning,
        );
    }

    let native_open_started = Instant::now();
    let native = NativePostgres::start(&postgres_bin, &initdb_bin, &tuning)?;
    let native_open_micros = native_open_started.elapsed().as_micros();
    let mut runs = Vec::new();
    if suite.includes("rtt") || suite.includes("speed") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create native Postgres benchmark Tokio runtime")?;
        let mut client_runs = runtime.block_on(async {
            match client_mode {
                NativePostgresClientMode::TokioPostgresSimple => {
                    let mut config = tokio_postgres::Config::new();
                    configure_native_postgres_client(&mut config, &native);
                    let connect_started = Instant::now();
                    let (client, connection) = config
                        .connect(tokio_postgres::NoTls)
                        .await
                        .context("connect to native Postgres benchmark cluster")?;
                    let connection_task = tokio::spawn(async move {
                        if let Err(err) = connection.await {
                            eprintln!("native Postgres benchmark connection error: {err}");
                        }
                    });
                    let connect_micros = connect_started.elapsed().as_micros();
                    let server_pid = native.child.id();

                    let mut runs = Vec::new();
                    if suite.includes("rtt") {
                        let mut sampler = ProcessTreeRssSampler::new(server_pid);
                        runs.push(
                            run_native_postgres_rtt_benchmark(
                                &client,
                                rtt_iterations,
                                native_open_micros,
                                connect_micros,
                                &mut sampler,
                            )
                            .await?,
                        );
                    }
                    if suite.includes("speed") {
                        let mut sampler = ProcessTreeRssSampler::new(server_pid);
                        runs.push(
                            run_native_postgres_speed_benchmark(
                                &client,
                                speed_sql_source,
                                native_open_micros,
                                connect_micros,
                                &mut sampler,
                            )
                            .await?,
                        );
                    }
                    drop(client);
                    connection_task.await.ok();
                    Ok::<_, anyhow::Error>(runs)
                }
                NativePostgresClientMode::Sqlx => {
                    let connect_started = Instant::now();
                    let mut conn =
                        sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
                            .await
                            .context("connect SQLx native Postgres benchmark client")?;
                    let connect_micros = connect_started.elapsed().as_micros();
                    let server_pid = native.child.id();

                    let mut runs = Vec::new();
                    if suite.includes("rtt") {
                        let mut sampler = ProcessTreeRssSampler::new(server_pid);
                        runs.push(
                            run_native_postgres_rtt_sqlx_benchmark(
                                &mut conn,
                                rtt_iterations,
                                native_open_micros,
                                connect_micros,
                                &mut sampler,
                            )
                            .await?,
                        );
                    }
                    if suite.includes("speed") {
                        let mut sampler = ProcessTreeRssSampler::new(server_pid);
                        runs.push(
                            run_native_postgres_speed_sqlx_benchmark(
                                &mut conn,
                                speed_sql_source,
                                native_open_micros,
                                connect_micros,
                                &mut sampler,
                            )
                            .await?,
                        );
                    }
                    conn.close()
                        .await
                        .context("close SQLx native Postgres benchmark client")?;
                    Ok::<_, anyhow::Error>(runs)
                }
            }
        })?;
        runs.append(&mut client_runs);
    }
    if suite.includes("streaming") {
        let mut sampler = ProcessTreeRssSampler::new(native.child.id());
        runs.push(run_native_postgres_streaming_benchmark(
            &native,
            native_open_micros,
            &mut sampler,
        )?);
    }
    if suite.includes("backup-restore") {
        let mut sampler = ProcessTreeRssSampler::new(native.child.id());
        runs.push(run_native_postgres_physical_backup_restore_benchmark(
            &native,
            &postgres_bin,
            native_open_micros,
            &mut sampler,
            &tuning,
        )?);
        runs.push(run_native_postgres_backup_restore_benchmark(
            &native,
            &postgres_bin,
            native_open_micros,
            &mut sampler,
        )?);
    }
    ensure!(
        !runs.is_empty(),
        "selected native Postgres suite produced no runs"
    );

    let report = BenchmarkReport {
        engine: "native-postgres",
        source_model: speed_sql_source.source_model(),
        measurement_model: match client_mode {
            NativePostgresClientMode::TokioPostgresSimple => {
                "Native Postgres control. xtask starts a temporary local cluster with the selected durability profile and Oliphaunt-parity startup GUCs, connects to the same template1 database target used by liboliphaunt, then sends each benchmark SQL file as one simple-query buffer through tokio-postgres simple_query. This intentionally avoids psql -f because psql splits files client-side."
            }
            NativePostgresClientMode::Sqlx => {
                "Native Postgres control. xtask starts a temporary local cluster with the selected durability profile and Oliphaunt-parity startup GUCs, connects to the same template1 database target used by liboliphaunt, then runs the benchmark SQL through one long-lived SQLx connection."
            }
        },
        native_tuning: Some(tuning.report()),
        rtt_iterations,
        speed_scale: 1.0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_native_postgres_prepared_updates(
    postgres_bin: &Path,
    initdb_bin: &Path,
    rows: usize,
    tuning: NativeBenchmarkTuning,
) -> Result<()> {
    let numeric_updates = parsed_numeric_updates(rows)?;
    let text_updates = parsed_text_updates(rows)?;
    let runs = vec![
        PreparedUpdateRun {
            mode: "native_postgres_tokio_prepared".to_owned(),
            description: "Native PostgreSQL control using tokio-postgres with one prepared statement and one Execute await per update.".to_owned(),
            tests: run_native_prepared_update_tests(
                postgres_bin,
                initdb_bin,
                &tuning,
                &numeric_updates,
                &text_updates,
                PreparedExecution::Sequential,
            )?,
        },
        PreparedUpdateRun {
            mode: "native_postgres_tokio_pipelined_prepared".to_owned(),
            description: "Native PostgreSQL control using tokio-postgres with one prepared statement and pipelined Execute futures inside one transaction.".to_owned(),
            tests: run_native_prepared_update_tests(
                postgres_bin,
                initdb_bin,
                &tuning,
                &numeric_updates,
                &text_updates,
                PreparedExecution::Pipelined,
            )?,
        },
    ];

    let report = PreparedUpdateReport {
        source_model: "Exact Oliphaunt fixture benchmark2/benchmark6 setup plus update values parsed from benchmark9 and benchmark10.",
        measurement_model: "Native PostgreSQL prepared-update control. Each test starts a fresh temporary local PostgreSQL cluster with the selected durability profile and Oliphaunt-parity startup GUCs, connects through tokio-postgres, prepares one statement, then executes N updates inside one transaction.",
        native_tuning: Some(tuning.report()),
        rows,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

async fn run_native_postgres_rtt_benchmark(
    client: &tokio_postgres::Client,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    client
        .simple_query(rtt_setup_sql())
        .await
        .context("execute native Postgres RTT setup")?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            client
                .simple_query(&case.sql)
                .await
                .with_context(|| format!("execute native Postgres RTT benchmark {}", case.id))?;
            samples.push(started.elapsed().as_micros());
        }
        tests.push(samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        ));
        server_rss.sample();
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_postgres",
        description: "Native Postgres over Unix socket using tokio-postgres simple_query against the liboliphaunt-matched template1 database target.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_native_postgres_speed_benchmark(
    client: &tokio_postgres::Client,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    client
        .simple_query(
            "DROP TABLE IF EXISTS t1 CASCADE;\
             DROP TABLE IF EXISTS t2 CASCADE;\
             DROP TABLE IF EXISTS t2_1 CASCADE;\
             DROP TABLE IF EXISTS t3 CASCADE;\
             DROP TABLE IF EXISTS t3_1 CASCADE;",
        )
        .await
        .context("clear native Postgres speed benchmark tables")?;
    server_rss.sample();

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        client
            .simple_query(&case.sql)
            .await
            .with_context(|| format!("execute native Postgres speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
        server_rss.sample();
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_postgres",
        description: "Native Postgres speed suite over Unix socket using tokio-postgres simple_query against the liboliphaunt-matched template1 database target.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_native_postgres_rtt_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    conn.execute(rtt_setup_sql())
        .await
        .context("execute native Postgres RTT setup over SQLx")?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            conn.execute(case.sql.as_str()).await.with_context(|| {
                format!(
                    "execute native Postgres RTT benchmark {} over SQLx",
                    case.id
                )
            })?;
            samples.push(started.elapsed().as_micros());
        }
        tests.push(samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        ));
        server_rss.sample();
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_postgres_sqlx",
        description: "Native Postgres over TCP using one long-lived SQLx connection against the liboliphaunt-matched template1 database target.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_native_postgres_speed_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    conn.execute(
        "DROP TABLE IF EXISTS t1 CASCADE;\
         DROP TABLE IF EXISTS t2 CASCADE;\
         DROP TABLE IF EXISTS t2_1 CASCADE;\
         DROP TABLE IF EXISTS t3 CASCADE;\
         DROP TABLE IF EXISTS t3_1 CASCADE;",
    )
    .await
    .context("clear native Postgres speed benchmark tables over SQLx")?;
    server_rss.sample();

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        conn.execute(case.sql.as_str()).await.with_context(|| {
            format!(
                "execute native Postgres speed benchmark {} over SQLx",
                case.id
            )
        })?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
        server_rss.sample();
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_postgres_sqlx",
        description: "Native Postgres speed suite over TCP using one SQLx connection against the liboliphaunt-matched template1 database target.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

fn unique_perf_root(name: &str) -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("read system clock for perf root")?
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "oliphaunt-perf-{name}-{}-{now}",
        std::process::id()
    ));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale perf root {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("create perf root {}", root.display()))?;
    Ok(root)
}
