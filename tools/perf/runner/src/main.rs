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
#[cfg(feature = "legacy-oliphaunt")]
use directories::ProjectDirs;
use futures_util::future::try_join_all;
use oliphaunt::{
    DurabilityProfile as NativeDurabilityProfile, PostgresStartupGuc, RuntimeFootprintProfile,
};
#[cfg(feature = "legacy-oliphaunt")]
use oliphaunt_wasix::{
    ExecProtocolOptions, Oliphaunt, OliphauntServer, PhaseTiming, ProtocolStatsSnapshot,
    capture_phase_timings, disable_protocol_stats, extensions, fs_trace_snapshot, measure_phase,
    protocol_stats_snapshot, record_phase_timing, reset_fs_trace, reset_protocol_stats,
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "legacy-oliphaunt")]
use sqlx::Row;
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{Connection, Executor};
use tar::{Archive, Builder as TarBuilder, Header as TarHeader};

use crate::process_rss::ProcessTreeRssSampler;

mod benchmarks;
mod diagnostics;
#[cfg(feature = "legacy-oliphaunt")]
mod legacy_wasix;
mod native_liboliphaunt;
mod native_postgres;
mod prepared_updates;
mod process_rss;
mod report;
mod shared;
mod sqlite;

use benchmarks::*;
use diagnostics::*;
#[cfg(feature = "legacy-oliphaunt")]
use legacy_wasix::*;
use native_liboliphaunt::*;
use native_postgres::*;
use prepared_updates::*;
use report::*;
use shared::*;
use sqlite::*;

const NATIVE_BENCHMARK_DATABASE: &str = "template1";
const OLIPHAUNT_BENCHMARK_SQL_DIR: &str = "benchmarks/native/sql";

#[cfg(not(feature = "legacy-oliphaunt"))]
type PhaseTiming = serde_json::Value;

#[cfg(not(feature = "legacy-oliphaunt"))]
type ProtocolStatsSnapshot = serde_json::Value;

fn main() -> Result<()> {
    perf(env::args().skip(1).collect())
}

pub(crate) fn perf(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("cold") => perf_cold(&args[1..]),
        Some("warm") => perf_warm(&args[1..]),
        Some("bench") => perf_bench(&args[1..]),
        Some("prepared-updates") => perf_prepared_updates(&args[1..]),
        Some("diagnose-indexed-update") => perf_diagnose_indexed_update(),
        Some("diagnose-speed-hotspots") => perf_diagnose_speed_hotspots(),
        Some("diagnose-speed-cases") => perf_diagnose_speed_cases(&args[1..]),
        Some("diagnose-buffer-cache") => perf_diagnose_buffer_cache(),
        Some("native-postgres") => perf_native_postgres(&args[1..]),
        Some("native-liboliphaunt") => perf_native_liboliphaunt(&args[1..]),
        Some("native-liboliphaunt-prepared-child") => {
            perf_native_liboliphaunt_prepared_child(&args[1..])
        }
        Some("native-liboliphaunt-restore-verify-child") => {
            perf_native_liboliphaunt_restore_verify_child(&args[1..])
        }
        Some("sqlite") => perf_sqlite(&args[1..]),
        Some("legacy-wasix-sqlx") => perf_legacy_wasix_sqlx(&args[1..]),
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
            "usage: cargo run -p oliphaunt-perf -- <cold|warm|bench|prepared-updates|native-postgres|native-liboliphaunt|sqlite|legacy-wasix-sqlx|diagnose-indexed-update|diagnose-speed-hotspots|diagnose-speed-cases|diagnose-buffer-cache|smoke> [--reset-cache]"
        ),
    }
}

#[cfg(not(feature = "legacy-oliphaunt"))]
fn legacy_oliphaunt_unavailable<T>(command: &str) -> Result<T> {
    bail!(
        "{command} requires oliphaunt-perf feature `legacy-oliphaunt`; enable it explicitly or avoid this legacy WASIX/Oliphaunt control command"
    )
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

#[cfg(feature = "legacy-oliphaunt")]
fn perf_cold(args: &[String]) -> Result<()> {
    let reset_cache = args.iter().any(|arg| arg == "--reset-cache");
    for arg in args {
        if arg != "--reset-cache" {
            bail!("unknown perf cold flag: {arg}");
        }
    }

    let cache_dir = oliphaunt_wasix_cache_dir()?;
    let cache_state_at_start = if reset_cache {
        if cache_dir.exists() {
            fs::remove_dir_all(&cache_dir)
                .with_context(|| format!("reset oliphaunt-wasix cache {}", cache_dir.display()))?;
        }
        "cold_absent_after_reset"
    } else if cache_dir.exists() {
        "existing"
    } else {
        "cold_absent"
    };

    let mut operations = Vec::new();

    operations.push(capture_operation(
        "process_cold_runtime_preload",
        "First explicit runtime preload in this xtask process. With --reset-cache, this includes first-install cache bootstrap.",
        cache_state_at_start,
        "cold",
        "internal_preload_temp_root",
        "not_a_query",
        "runtime_preload",
        "operation.total",
        Oliphaunt::preload,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_direct_first_query",
        "First direct query for a newly opened temporary database after runtime preload in the same process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_root",
        "first_query_after_open",
        "direct_select_with_bind",
        "visible.direct_open_to_first_query",
        run_direct_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_second_new_temp_direct_first_query",
        "Repeat first direct query for a second newly opened temporary database in the same warm process.",
        "warm_after_runtime_preload",
        "warm",
        "second_new_temporary_root",
        "first_query_after_open",
        "direct_select_with_bind",
        "visible.direct_open_to_first_query",
        run_direct_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_vector_preload",
        "Explicit preload of the representative extension artifact after runtime preload.",
        "warm_after_runtime_preload",
        "warm",
        "internal_preload_temp_root",
        "not_a_query",
        "vector_extension_preload",
        "operation.total",
        || Oliphaunt::preload_extensions([extensions::VECTOR]),
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_direct_vector_first_query",
        "First vector-backed direct query for a newly opened temporary database after vector preload.",
        "warm_after_vector_preload",
        "warm",
        "new_temporary_root_with_requested_vector",
        "first_extension_backed_query_after_open",
        "direct_vector_distance",
        "visible.direct_open_to_first_query",
        run_direct_vector_query,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_tokio_postgres_first_query",
        "First tokio-postgres query against a new temporary OliphauntServer in the warm process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_server_root",
        "first_client_query_after_server_start",
        "tokio_postgres_select_with_bind",
        "visible.server_start_to_first_tokio_postgres_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", OliphauntServer::temporary_tcp)?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
                    .await
                    .context("connect tokio-postgres to OliphauntServer")?;
                record_phase_timing("client.tokio_postgres_connect", started.elapsed());
                let connection_handle = tokio::spawn(connection);
                let started = Instant::now();
                let row = client
                    .query_one("SELECT $1::int4 + 1 AS answer", &[&41_i32])
                    .await
                    .context("run first tokio-postgres query")?;
                record_phase_timing("client.tokio_postgres_first_query", started.elapsed());
                let answer: i32 = row.get("answer");
                if answer != 42 {
                    bail!("server query returned {answer}, expected 42");
                }
                drop(client);
                connection_handle
                    .await
                    .context("join tokio-postgres connection task")?
                    .context("tokio-postgres connection task")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_tokio_postgres_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_sqlx_first_query",
        "First SQLx query against a new temporary OliphauntServer in the warm process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_server_root",
        "first_client_query_after_server_start",
        "sqlx_select_with_bind",
        "visible.server_start_to_first_sqlx_query",
        run_server_sqlx_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_sqlx_vector_first_query",
        "First vector-backed SQLx query against a new extension-enabled temporary OliphauntServer.",
        "warm_after_vector_preload",
        "warm",
        "new_temporary_server_root_with_requested_vector",
        "first_extension_backed_client_query_after_server_start",
        "sqlx_vector_distance",
        "visible.server_start_to_first_sqlx_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", || {
                OliphauntServer::builder()
                    .temporary()
                    .extension(extensions::VECTOR)
                    .start()
            })?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let mut conn = sqlx::PgConnection::connect(&uri)
                    .await
                    .context("connect SQLx to extension-enabled OliphauntServer")?;
                record_phase_timing("client.sqlx_extension_connect", started.elapsed());
                let started = Instant::now();
                let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
                    .fetch_one(&mut conn)
                    .await
                    .context("run first SQLx extension-backed query")?;
                record_phase_timing("client.sqlx_extension_first_query", started.elapsed());
                let distance: f64 = row.try_get("distance").context("read vector distance")?;
                if distance != 1.0 {
                    bail!("SQLx vector query returned {distance}, expected 1.0");
                }
                conn.close().await.context("close SQLx connection")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_sqlx_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    let preinstalled_extension_root = unique_perf_root("server-sqlx-preinstalled-extension")?;
    {
        let mut db = Oliphaunt::builder()
            .path(&preinstalled_extension_root)
            .extension(extensions::VECTOR)
            .open()
            .context("prepare preinstalled extension perf root")?;
        db.close()
            .context("close preinstalled extension perf root")?;
    }
    operations.push(capture_operation(
        "process_warm_existing_persistent_server_sqlx_vector_first_query",
        "Diagnostic first vector-backed SQLx query against an existing persistent root where vector was already installed.",
        "warm_after_vector_preload",
        "warm",
        "existing_persistent_root_with_preinstalled_vector",
        "first_client_query_after_server_start",
        "sqlx_vector_distance",
        "visible.server_start_to_first_sqlx_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", || {
                OliphauntServer::builder()
                    .path(&preinstalled_extension_root)
                    .extension(extensions::VECTOR)
                    .start()
            })?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let mut conn = sqlx::PgConnection::connect(&uri)
                    .await
                    .context("connect SQLx to preinstalled-extension OliphauntServer")?;
                record_phase_timing("client.sqlx_extension_connect", started.elapsed());
                let started = Instant::now();
                let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
                    .fetch_one(&mut conn)
                    .await
                    .context("run first SQLx preinstalled-extension query")?;
                record_phase_timing("client.sqlx_extension_first_query", started.elapsed());
                let distance: f64 = row.try_get("distance").context("read vector distance")?;
                if distance != 1.0 {
                    bail!("SQLx vector query returned {distance}, expected 1.0");
                }
                conn.close().await.context("close SQLx connection")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_sqlx_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    let _ = fs::remove_dir_all(&preinstalled_extension_root);

    let report = ColdPerfReport {
        wasmer_version: "7.2.0",
        wasmer_wasix_version: "0.702.0",
        wasix_runtime_assets: wasix_runtime_asset_report()?,
        cache_reset_requested: reset_cache,
        cache_dir: cache_dir.display().to_string(),
        cache_state_at_start,
        measurement_model: "Operations run sequentially in one xtask process. 'Warm' means process/runtime/module caches have been warmed by earlier operations; 'first query' means first query after opening that operation's new database root or server.",
        operations,
        experiments: vec![
            ColdPerfExperiment {
                name: "wasmer_webassembly_exceptions",
                status: "production_invariant",
                implementation_risk: "medium",
                artifact_size_impact: "required",
                notes: "the runtime and WASIX build require WebAssembly exception handling; no non-EH fallback or opt-out is supported",
            },
            ColdPerfExperiment {
                name: "wasix_dynamic_linking_flags",
                status: "production_invariant",
                implementation_risk: "medium",
                artifact_size_impact: "required",
                notes: "main modules use dynamic-main flags and extension/tool side modules use PIC shared-module flags from the same configured tree",
            },
            ColdPerfExperiment {
                name: "process_wide_headless_engine_and_module_cache",
                status: "implemented",
                implementation_risk: "low",
                artifact_size_impact: "none",
                notes: "main and side modules are cached by artifact hash inside the process",
            },
            ColdPerfExperiment {
                name: "persistent_raw_aot_cache",
                status: "implemented",
                implementation_risk: "low",
                artifact_size_impact: "none",
                notes: "compressed AOT artifacts expand once to a manifest raw-SHA-keyed cache path; subsequent processes use fast receipt verification before mmap/native deserialization; full content hashing is only enabled with OLIPHAUNT_WASM_AOT_VERIFY=full",
            },
            ColdPerfExperiment {
                name: "mmap_native_deserialization",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "runtime uses Wasmer native mmapped deserialization as the only production AOT loading path",
            },
            ColdPerfExperiment {
                name: "shared_wasix_runtime_and_module_cache",
                status: "implemented",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "runtime infrastructure is shared while Store, Instance, WASI env, mounts, and protocol state remain per database",
            },
            ColdPerfExperiment {
                name: "template_clone_hardlink_reflink_copy",
                status: "implemented",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "immutable runtime files hardlink first; mutable PGDATA uses archive install by default, with per-file reflink available through OLIPHAUNT_WASM_TEMPLATE_REFLINK",
            },
            ColdPerfExperiment {
                name: "eager_pgdata_template_overlay",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "mounts the cached initialized PGDATA template as lower /base and copies individual files into the per-instance upper only before mutating opens",
            },
            ColdPerfExperiment {
                name: "mountfs_overlay_runtime_root",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "serves immutable runtime files from the shared cached lower root and keeps only mutable state plus requested extension assets in the per-root upper root",
            },
            ColdPerfExperiment {
                name: "snapshot_journaling",
                status: "scouted_not_promoted",
                implementation_risk: "high",
                artifact_size_impact: "unknown",
                notes: "Wasmer 7.2 exposes WASIX journal and process snapshot APIs, while StoreSnapshot captures store globals only; promotion requires an isolated restore correctness suite for direct protocol, server mode, extensions, PGDATA, fd state, and mount state",
            },
            ColdPerfExperiment {
                name: "asyncify",
                status: "production_excluded",
                implementation_risk: "high",
                artifact_size_impact: "unknown",
                notes: "not used in production artifacts; only an isolated snapshot/journaling experiment may enable it if Wasm EH plus WASIX journaling cannot support the required control-flow restore path",
            },
        ],
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
fn perf_cold(args: &[String]) -> Result<()> {
    let _ = args;
    legacy_oliphaunt_unavailable("perf cold")
}

#[cfg(feature = "legacy-oliphaunt")]
fn perf_warm(args: &[String]) -> Result<()> {
    let mut query_iterations = 100usize;
    let mut connection_iterations = 20usize;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                query_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--connections" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--connections requires a value"))?;
                connection_iterations = value
                    .parse()
                    .with_context(|| format!("parse --connections value {value:?}"))?;
            }
            other => bail!("unknown perf warm flag: {other}"),
        }
        cursor += 1;
    }
    if query_iterations == 0 {
        bail!("--iterations must be greater than zero");
    }
    if connection_iterations == 0 {
        bail!("--connections must be greater than zero");
    }

    let mut operations = Vec::new();
    operations.push(capture_operation(
        "warm_process_preload",
        "Warm runtime and representative extension artifacts before steady-state workloads.",
        "existing",
        "warm",
        "process_cache",
        "not_a_query",
        "runtime_and_extension_preload",
        "operation.total",
        || {
            Oliphaunt::preload()?;
            Oliphaunt::preload_extensions([extensions::VECTOR])
        },
    )?);
    operations.push(capture_operation(
        "warm_direct_repeated_scalar_queries",
        "Repeated direct API scalar extended-protocol queries on one already-open temporary database.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_direct_root",
        "steady_state_queries",
        "direct_select_with_bind",
        "warm.direct_repeated_scalar_queries.total",
        || run_direct_repeated_selects(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_direct_transaction_batch",
        "Repeated direct API scalar queries inside one transaction on an already-open temporary database.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_direct_root",
        "steady_state_transaction_batch",
        "direct_transaction_select_with_bind",
        "warm.direct_transaction_batch.total",
        || run_direct_transaction_batch(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_direct_repeated_vector_queries",
        "Repeated direct API extension-backed queries on one already-open extension-enabled temporary database.",
        "warm_after_vector_preload",
        "warm",
        "long_lived_temporary_direct_root_with_vector",
        "steady_state_extension_queries",
        "direct_vector_distance",
        "warm.direct_repeated_vector_queries.total",
        || run_direct_repeated_vector_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_single_connection_repeated_queries",
        "Repeated SQLx queries over one connection to one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_single_connection_queries",
        "sqlx_select_with_bind",
        "warm.server_sqlx_single_connection_repeated_queries.total",
        || run_server_sqlx_single_connection_repeated_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_repeated_connections",
        "Repeated SQLx connect-query-close cycles against one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_repeated_connections",
        "sqlx_connect_query_close",
        "warm.server_sqlx_repeated_connections.total",
        || run_server_sqlx_repeated_connections(connection_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_vector_single_connection_repeated_queries",
        "Repeated SQLx extension-backed queries over one connection to one long-lived extension-enabled temporary server.",
        "warm_after_vector_preload",
        "warm",
        "long_lived_temporary_server_root_with_vector",
        "steady_state_extension_queries",
        "sqlx_vector_distance",
        "warm.server_sqlx_vector_single_connection_repeated_queries.total",
        || run_server_sqlx_vector_single_connection_repeated_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_tokio_postgres_single_connection_repeated_queries",
        "Repeated tokio-postgres queries over one connection to one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_single_connection_queries",
        "tokio_postgres_select_with_bind",
        "warm.server_tokio_postgres_single_connection_repeated_queries.total",
        || run_server_tokio_postgres_single_connection_repeated_queries(query_iterations),
    )?);

    let report = WarmPerfReport {
        wasmer_version: "7.2.0",
        wasmer_wasix_version: "0.702.0",
        wasix_runtime_assets: wasix_runtime_asset_report()?,
        query_iterations,
        connection_iterations,
        measurement_model: "Operations run after explicit process preload. Each workload opens one database/server, performs one warmup query where relevant, then records only the repeated steady-state section as the primary latency phase. Open and shutdown phases remain in the phase list for context.",
        operations,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
fn perf_warm(args: &[String]) -> Result<()> {
    let _ = args;
    legacy_oliphaunt_unavailable("perf warm")
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

#[cfg(feature = "legacy-oliphaunt")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkModeFilter {
    All,
    Direct,
    ServerSqlx,
    ServerTokioPostgresSimple,
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

#[cfg(feature = "legacy-oliphaunt")]
impl BenchmarkModeFilter {
    fn includes(self, mode: &'static str) -> bool {
        matches!(
            (self, mode),
            (Self::All, _)
                | (Self::Direct, "direct")
                | (Self::ServerSqlx, "server_sqlx")
                | (
                    Self::ServerTokioPostgresSimple,
                    "server_tokio_postgres_simple"
                )
        )
    }
}

#[cfg(feature = "legacy-oliphaunt")]
fn perf_bench(args: &[String]) -> Result<()> {
    let mut suite = BenchmarkSuiteFilter::All;
    let mut mode = BenchmarkModeFilter::All;
    let mut rtt_iterations = 100usize;
    let mut speed_scale = 1.0f64;
    let mut speed_sql_source = SpeedSqlSource::Generated;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "all" => BenchmarkSuiteFilter::All,
                    "rtt" | "roundtrip" | "round-trip" => BenchmarkSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    other => bail!("unknown --suite value {other:?}; use all, rtt, or speed"),
                };
            }
            "--mode" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--mode requires a value"))?;
                mode = match value.as_str() {
                    "all" => BenchmarkModeFilter::All,
                    "direct" => BenchmarkModeFilter::Direct,
                    "server-sqlx" | "server_sqlx" | "sqlx" | "server" => {
                        BenchmarkModeFilter::ServerSqlx
                    }
                    "server-tokio-postgres-simple"
                    | "server_tokio_postgres_simple"
                    | "tokio-postgres-simple"
                    | "tokio_postgres_simple"
                    | "tokio-postgres"
                    | "tokio_postgres" => BenchmarkModeFilter::ServerTokioPostgresSimple,
                    other => {
                        bail!(
                            "unknown --mode value {other:?}; use all, direct, server-sqlx, or server-tokio-postgres-simple"
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
            "--scale" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--scale requires a value"))?;
                speed_scale = value
                    .parse()
                    .with_context(|| format!("parse --scale value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = match value.as_str() {
                    "generated" | "local" => SpeedSqlSource::Generated,
                    "oliphaunt" | "fixture" | "oliphaunt-fixture" => {
                        SpeedSqlSource::OliphauntFixture
                    }
                    other => {
                        bail!("unknown --speed-source value {other:?}; use generated or oliphaunt")
                    }
                };
            }
            other => bail!("unknown perf bench flag: {other}"),
        }
        cursor += 1;
    }
    if rtt_iterations == 0 {
        bail!("--iterations must be greater than zero");
    }
    if !speed_scale.is_finite() || speed_scale <= 0.0 {
        bail!("--scale must be a finite positive number");
    }
    if speed_sql_source == SpeedSqlSource::OliphauntFixture
        && (speed_scale - 1.0).abs() > f64::EPSILON
    {
        bail!("--speed-source oliphaunt uses fixed upstream SQL files and requires --scale 1");
    }

    let preload_started = Instant::now();
    Oliphaunt::preload()?;
    let preload_micros = preload_started.elapsed().as_micros();

    let mut runs = Vec::new();
    if suite.includes("rtt") && mode.includes("direct") {
        runs.push(run_rtt_direct_benchmark(rtt_iterations)?);
    }
    if suite.includes("rtt") && mode.includes("server_sqlx") {
        runs.push(run_rtt_server_sqlx_benchmark(rtt_iterations)?);
    }
    if suite.includes("rtt") && mode.includes("server_tokio_postgres_simple") {
        runs.push(run_rtt_server_tokio_postgres_simple_benchmark(
            rtt_iterations,
        )?);
    }
    if suite.includes("speed") && mode.includes("direct") {
        runs.push(run_speed_direct_benchmark(speed_scale, speed_sql_source)?);
    }
    if suite.includes("speed") && mode.includes("server_sqlx") {
        runs.push(run_speed_server_sqlx_benchmark(
            speed_scale,
            speed_sql_source,
        )?);
    }
    ensure!(
        !runs.is_empty(),
        "selected benchmark filter produced no runs"
    );

    let report = BenchmarkReport {
        wasmer_version: "7.2.0",
        wasmer_wasix_version: "0.702.0",
        wasix_runtime_assets: Some(wasix_runtime_asset_report()?),
        source_model: speed_sql_source.source_model(),
        measurement_model: "Database/server open and setup are measured separately. Test timings start immediately before each SQL execution call and end after that execution completes. RTT tests sort samples, discard the lowest and highest 10% when possible, and report trimmed averages in microseconds.",
        native_tuning: None,
        rtt_iterations,
        speed_scale,
        preload_micros,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
fn perf_bench(args: &[String]) -> Result<()> {
    let _ = args;
    legacy_oliphaunt_unavailable("perf bench")
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
        wasmer_version: "native-postgres",
        wasmer_wasix_version: "native-postgres",
        wasix_runtime_assets: None,
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
        preload_micros: 0,
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
            protocol_stats: None,
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
            protocol_stats: None,
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
        gate_model: None,
        wasix_runtime_assets: None,
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

#[cfg(feature = "legacy-oliphaunt")]
fn perf_legacy_wasix_sqlx(args: &[String]) -> Result<()> {
    let mut database_url: Option<String> = None;
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::OliphauntFixture;
    let mut rtt_iterations = 100usize;
    let mut open_micros = 0u128;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--database-url" => {
                cursor += 1;
                database_url = Some(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--database-url requires a value"))?
                        .to_owned(),
                );
            }
            "--open-micros" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--open-micros requires a value"))?;
                open_micros = value
                    .parse()
                    .with_context(|| format!("parse --open-micros value {value:?}"))?;
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
                    other => bail!("unknown --suite value {other:?}; use all, rtt, or speed"),
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
            other => bail!("unknown perf legacy-wasix-sqlx flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");
    let database_url = database_url.ok_or_else(|| anyhow!("--database-url is required"))?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create legacy WASIX Oliphaunt SQLx benchmark Tokio runtime")?;
    let runs = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .context("connect SQLx client to legacy WASIX Oliphaunt socket server")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let mut runs = Vec::new();
        if suite.includes("rtt") {
            runs.push(
                run_legacy_wasix_rtt_sqlx_benchmark(
                    &mut conn,
                    rtt_iterations,
                    open_micros,
                    connect_micros,
                )
                .await?,
            );
        }
        if suite.includes("speed") {
            runs.push(
                run_legacy_wasix_speed_sqlx_benchmark(
                    &mut conn,
                    speed_sql_source,
                    open_micros,
                    connect_micros,
                )
                .await?,
            );
        }
        conn.close()
            .await
            .context("close SQLx legacy WASIX Oliphaunt benchmark client")?;
        Ok::<_, anyhow::Error>(runs)
    })?;

    let report = BenchmarkReport {
        wasmer_version: "node-oliphaunt",
        wasmer_wasix_version: "node-oliphaunt",
        wasix_runtime_assets: None,
        source_model: speed_sql_source.source_model(),
        measurement_model: "Oliphaunt fixture control. A caller supplies a PostgreSQL-compatible database URL, then xtask runs the benchmark SQL through one long-lived SQLx connection.",
        native_tuning: None,
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
fn perf_legacy_wasix_sqlx(args: &[String]) -> Result<()> {
    let _ = args;
    legacy_oliphaunt_unavailable("perf legacy-wasix-sqlx")
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

#[cfg(feature = "legacy-oliphaunt")]
async fn run_legacy_wasix_rtt_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    conn.execute(rtt_setup_sql())
        .await
        .context("execute legacy WASIX Oliphaunt RTT setup over SQLx")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            conn.execute(case.sql.as_str()).await.with_context(|| {
                format!(
                    "execute legacy WASIX Oliphaunt RTT benchmark {} over SQLx",
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
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "legacy_wasix_sqlx",
        description: "legacy WASIX Oliphaunt over the Postgres wire protocol using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: None,
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

#[cfg(feature = "legacy-oliphaunt")]
async fn run_legacy_wasix_speed_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
    conn.execute(
        "DROP TABLE IF EXISTS t1 CASCADE;\
         DROP TABLE IF EXISTS t2 CASCADE;\
         DROP TABLE IF EXISTS t2_1 CASCADE;\
         DROP TABLE IF EXISTS t3 CASCADE;\
         DROP TABLE IF EXISTS t3_1 CASCADE;",
    )
    .await
    .context("clear legacy WASIX Oliphaunt speed benchmark tables over SQLx")?;

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        conn.execute(case.sql.as_str()).await.with_context(|| {
            format!(
                "execute legacy WASIX Oliphaunt speed benchmark {} over SQLx",
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
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "legacy_wasix_sqlx",
        description: "legacy WASIX Oliphaunt speed suite over TCP using one SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn unique_perf_root(name: &str) -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("read system clock for perf root")?
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "oliphaunt-wasix-{name}-{}-{now}",
        std::process::id()
    ));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale perf root {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("create perf root {}", root.display()))?;
    Ok(root)
}
