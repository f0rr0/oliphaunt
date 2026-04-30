use std::collections::HashSet;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail, ensure};
use directories::ProjectDirs;
use pglite_oxide::{
    Pglite, PgliteServer, PhaseTiming, capture_phase_timings, extensions, fs_trace_snapshot,
    measure_phase, record_phase_timing, reset_fs_trace,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, Row};
use walkdir::WalkDir;
use wasmparser::{Dylink0Subsection, ExternalKind, KnownCustom, Parser, Payload, TypeRef};
use zstd::stream::write::Encoder as ZstdEncoder;

const POSTGRES_PGLITE_SOURCE: &str = "postgres-pglite";
const POSTGRES_PGLITE_PATH: &str = "assets/checkouts/postgres-pglite";
const PGLITE_BUILD_SOURCE: &str = "pglite-build";
const PGLITE_BUILD_PATH: &str = "assets/checkouts/pglite-build";
const WASIX_BUILD_ROOT: &str = "assets/wasix-build";
const WASIX_DOCKER_BUILD_DIR: &str = "assets/wasix-build/work/docker-pglite";
const WASIX_PATCHED_SOURCE_DIR: &str = "assets/wasix-build/work/postgres-pglite-wasix-src";
const WASIX_BUILD_MANIFEST_PATH: &str = "assets/wasix-build/build/outputs.json";
const WASIX_PATCH_PATH: &str = "assets/wasix-build/patches/postgres-pglite-wasix-dl.patch";
const WASIX_BRIDGE_PATH: &str = "assets/wasix-build/wasix_shim/pglite_wasix_bridge.c";
const DEFAULT_ASSET_BUILD_PROFILE: &str = "release-o3";
const PGVECTOR_BUILD_DIR: &str = "assets/checkouts/pgvector";
const PGLITE_BENCHMARK_SQL_DIR: &str = "assets/checkouts/pglite/packages/benchmark/src";
const EXPECTED_POSTGRES_PGLITE_BRANCH: &str = "REL_17_5-pglite";
const EXPECTED_PGLITE_BUILD_BRANCH: &str = "portable";

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("assets") => assets(args.collect()),
        Some("package-size") => package_size(args.collect()),
        Some("perf") => perf(args.collect()),
        Some("help") | None => {
            print_usage();
            Ok(())
        }
        Some(other) => bail!("unknown xtask command: {other}"),
    }
}

fn assets(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("check") => {
            let strict_local = args.iter().any(|arg| arg == "--strict-local");
            let strict_generated = args.iter().any(|arg| arg == "--strict-generated");
            let manifest = check_sources_manifest(strict_local)?;
            check_no_legacy_runtime_shims()?;
            check_production_wasix_build_inputs()?;
            check_rust_startup_abi_boundary()?;
            check_canonical_asset_layout(strict_generated)?;
            check_generated_manifest(&manifest, strict_generated)
        }
        Some("audit-upstream") => {
            let strict = args.iter().any(|arg| arg == "--strict");
            let manifest = check_sources_manifest(false)?;
            audit_upstream_fixes(&manifest, strict)
        }
        Some("build") => {
            let manifest = check_sources_manifest(false)?;
            let profile = value_after(&args, "--profile").unwrap_or(DEFAULT_ASSET_BUILD_PROFILE);
            let target = value_after(&args, "--target-triple").unwrap_or(env::consts::ARCH);
            build_asset_spine(&manifest, profile, target, &args)
        }
        Some("fetch") => {
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            fetch_pinned_sources(&manifest)
        }
        Some("release-build") => {
            let manifest = check_sources_manifest(true)?;
            let profile = value_after(&args, "--profile").unwrap_or(DEFAULT_ASSET_BUILD_PROFILE);
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            release_build_assets(&manifest, profile, target, &args)
        }
        Some("package") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            package_assets(&manifest, target)
        }
        Some("aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            generate_aot_artifacts(target)
        }
        Some("source-spine") => {
            let check_patch = args.iter().any(|arg| arg == "--check-patch-applies");
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            println!("validated {} pinned asset sources", manifest.sources.len());
            check_source_spine(&manifest, true, check_patch)
        }
        Some("smoke") => run("cargo", &["test", "--workspace", "--locked", "asset_"]),
        Some(other) => bail!("unknown assets subcommand: {other}"),
        None => {
            bail!(
                "usage: cargo run -p xtask -- assets <check|audit-upstream|source-spine|fetch|build|release-build|package|smoke>"
            )
        }
    }
}

fn package_size(args: Vec<String>) -> Result<()> {
    let enforce = args.iter().any(|arg| arg == "--enforce");
    let package_dir = Path::new("target/package");
    if !package_dir.exists() {
        fs::create_dir_all(package_dir)
            .with_context(|| format!("create {}", package_dir.display()))?;
    } else {
        fs::remove_dir_all(package_dir)
            .with_context(|| format!("remove {}", package_dir.display()))?;
    }
    run(
        "cargo",
        &[
            "package",
            "--workspace",
            "--exclude",
            "xtask",
            "--locked",
            "--no-verify",
            "--allow-dirty",
        ],
    )?;

    let limit = 10 * 1024 * 1024;
    let mut failures = Vec::new();
    for entry in WalkDir::new(package_dir).max_depth(1) {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("crate") {
            continue;
        }
        let size = entry.metadata()?.len();
        println!("{} {} bytes", path.display(), size);
        if size > limit {
            failures.push((path.to_path_buf(), size));
        }
    }

    if enforce && !failures.is_empty() {
        let details = failures
            .iter()
            .map(|(path, size)| format!("{} ({size} bytes)", path.display()))
            .collect::<Vec<_>>()
            .join(", ");
        bail!("crate package size limit exceeded: {details}");
    }
    Ok(())
}

fn perf(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("cold") => perf_cold(&args[1..]),
        Some("warm") => perf_warm(&args[1..]),
        Some("bench") => perf_bench(&args[1..]),
        Some("diagnose-indexed-update") => perf_diagnose_indexed_update(),
        Some("diagnose-speed-hotspots") => perf_diagnose_speed_hotspots(),
        Some("diagnose-speed-cases") => perf_diagnose_speed_cases(&args[1..]),
        Some("diagnose-buffer-cache") => perf_diagnose_buffer_cache(),
        Some("native-postgres") => perf_native_postgres(&args[1..]),
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
            "usage: cargo run -p xtask -- perf <cold|warm|bench|native-postgres|diagnose-indexed-update|diagnose-speed-hotspots|diagnose-speed-cases|diagnose-buffer-cache|smoke> [--reset-cache]"
        ),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColdPerfReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    cache_reset_requested: bool,
    cache_dir: String,
    cache_state_at_start: &'static str,
    measurement_model: &'static str,
    operations: Vec<PerfOperation>,
    experiments: Vec<ColdPerfExperiment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PerfOperation {
    name: &'static str,
    description: &'static str,
    cache_state_before: String,
    process_state_before: &'static str,
    root_state: &'static str,
    query_state: &'static str,
    workload: &'static str,
    primary_latency_phase: &'static str,
    primary_latency_micros: u128,
    elapsed_micros: u128,
    correct: bool,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WarmPerfReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    query_iterations: usize,
    connection_iterations: usize,
    measurement_model: &'static str,
    operations: Vec<PerfOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    source_model: &'static str,
    measurement_model: &'static str,
    rtt_iterations: usize,
    speed_scale: f64,
    preload_micros: u128,
    runs: Vec<BenchmarkRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkRun {
    suite: &'static str,
    mode: &'static str,
    description: &'static str,
    open_micros: u128,
    connect_micros: Option<u128>,
    setup_micros: u128,
    tests: Vec<BenchmarkTestResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkTestResult {
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    sample_count: usize,
    trimmed_sample_count: usize,
    elapsed_micros: u128,
    average_micros: Option<f64>,
    min_micros: Option<u128>,
    p50_micros: Option<u128>,
    p95_micros: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedUpdateDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    cases: Vec<IndexedUpdateDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedUpdateDiagnosticCase {
    name: &'static str,
    description: &'static str,
    setup_micros: u128,
    elapsed_micros: u128,
    operation_count: usize,
    stats_before: serde_json::Value,
    stats_after: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
struct SpeedHotspotDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    cases: Vec<SpeedHotspotDiagnosticCase>,
}

#[derive(Debug, Serialize)]
struct SpeedHotspotDiagnosticCase {
    id: String,
    label: String,
    setup_micros: u128,
    elapsed_micros: u128,
    operation_count: usize,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    cases: Vec<BufferCacheDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticCase {
    id: String,
    label: String,
    setup_micros: u128,
    settings: serde_json::Value,
    relation_sizes: serde_json::Value,
    statements: Vec<BufferCacheDiagnosticStatement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticStatement {
    sql: String,
    elapsed_micros: u128,
    explain_rows: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColdPerfExperiment {
    name: &'static str,
    status: &'static str,
    implementation_risk: &'static str,
    artifact_size_impact: &'static str,
    notes: &'static str,
}

fn perf_cold(args: &[String]) -> Result<()> {
    let reset_cache = args.iter().any(|arg| arg == "--reset-cache");
    for arg in args {
        if arg != "--reset-cache" {
            bail!("unknown perf cold flag: {arg}");
        }
    }

    let cache_dir = pglite_oxide_cache_dir()?;
    let cache_state_at_start = if reset_cache {
        if cache_dir.exists() {
            fs::remove_dir_all(&cache_dir)
                .with_context(|| format!("reset pglite-oxide cache {}", cache_dir.display()))?;
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
        Pglite::preload,
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
        || Pglite::preload_extensions([extensions::VECTOR]),
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
        "First tokio-postgres query against a new temporary PgliteServer in the warm process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_server_root",
        "first_client_query_after_server_start",
        "tokio_postgres_select_with_bind",
        "visible.server_start_to_first_tokio_postgres_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
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
                    .context("connect tokio-postgres to PGliteServer")?;
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
        "First SQLx query against a new temporary PgliteServer in the warm process.",
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
        "First vector-backed SQLx query against a new extension-enabled temporary PgliteServer.",
        "warm_after_vector_preload",
        "warm",
        "new_temporary_server_root_with_requested_vector",
        "first_extension_backed_client_query_after_server_start",
        "sqlx_vector_distance",
        "visible.server_start_to_first_sqlx_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", || {
                PgliteServer::builder()
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
                    .context("connect SQLx to extension-enabled PGliteServer")?;
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
        let mut db = Pglite::builder()
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
                PgliteServer::builder()
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
                    .context("connect SQLx to preinstalled-extension PGliteServer")?;
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
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
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
                notes: "compressed AOT artifacts expand once to a manifest raw-SHA-keyed cache path; subsequent processes use fast receipt verification before mmap/native deserialization; full content hashing is only enabled with PGLITE_OXIDE_AOT_VERIFY=full",
            },
            ColdPerfExperiment {
                name: "mmap_native_deserialization",
                status: if aot_deserialize_mmap_perf_enabled() {
                    "default_measured_in_this_run"
                } else {
                    "diagnostic_file_mode_measured"
                },
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "default uses Wasmer native mmapped deserialization; set PGLITE_OXIDE_AOT_DESERIALIZE=file only to compare with the older read/deserialization path",
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
                notes: "immutable runtime files hardlink first; mutable PGDATA uses archive install by default, with per-file reflink available through PGLITE_OXIDE_TEMPLATE_REFLINK",
            },
            ColdPerfExperiment {
                name: "eager_pgdata_template_overlay",
                status: if pgdata_overlay_perf_enabled() {
                    "default_measured_in_this_run"
                } else {
                    "implemented_opted_out"
                },
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "enabled by default; set PGLITE_OXIDE_PGDATA_OVERLAY=0 to opt out. Mounts the cached initialized PGDATA template as lower /base and copies individual files into the per-instance upper only before mutating opens",
            },
            ColdPerfExperiment {
                name: "mountfs_overlay_runtime_root",
                status: if mountfs_perf_enabled() {
                    "default_measured_in_this_run"
                } else {
                    "implemented_opted_out"
                },
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "enabled by default; set PGLITE_OXIDE_MOUNTFS=0 to opt out. Serves immutable runtime files from the shared cached lower root and keeps only mutable state plus requested extension assets in the per-root upper root",
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
            Pglite::preload()?;
            Pglite::preload_extensions([extensions::VECTOR])
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
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
        query_iterations,
        connection_iterations,
        measurement_model: "Operations run after explicit process preload. Each workload opens one database/server, performs one warmup query where relevant, then records only the repeated steady-state section as the primary latency phase. Open and shutdown phases remain in the phase list for context.",
        operations,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkSuiteFilter {
    All,
    Rtt,
    Speed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkModeFilter {
    All,
    Direct,
    ServerSqlx,
}

impl BenchmarkSuiteFilter {
    fn includes(self, suite: &'static str) -> bool {
        matches!(
            (self, suite),
            (Self::All, _) | (Self::Rtt, "rtt") | (Self::Speed, "speed")
        )
    }
}

impl BenchmarkModeFilter {
    fn includes(self, mode: &'static str) -> bool {
        matches!(
            (self, mode),
            (Self::All, _) | (Self::Direct, "direct") | (Self::ServerSqlx, "server_sqlx")
        )
    }
}

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
                    other => {
                        bail!("unknown --mode value {other:?}; use all, direct, or server-sqlx")
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
                    "pglite" | "pglite-vendored" | "upstream" => SpeedSqlSource::PgliteVendored,
                    other => {
                        bail!("unknown --speed-source value {other:?}; use generated or pglite")
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
    if speed_sql_source == SpeedSqlSource::PgliteVendored
        && (speed_scale - 1.0).abs() > f64::EPSILON
    {
        bail!("--speed-source pglite uses fixed upstream SQL files and requires --scale 1");
    }

    let preload_started = Instant::now();
    Pglite::preload()?;
    let preload_micros = preload_started.elapsed().as_micros();

    let mut runs = Vec::new();
    if suite.includes("rtt") && mode.includes("direct") {
        runs.push(run_rtt_direct_benchmark(rtt_iterations)?);
    }
    if suite.includes("rtt") && mode.includes("server_sqlx") {
        runs.push(run_rtt_server_sqlx_benchmark(rtt_iterations)?);
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
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
        source_model: speed_sql_source.source_model(),
        measurement_model: "Database/server open and setup are measured separately. Test timings start immediately before each SQL execution call and end after that execution completes. RTT tests sort samples, discard the lowest and highest 10% when possible, and report trimmed averages in microseconds.",
        rtt_iterations,
        speed_scale,
        preload_micros,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_native_postgres(args: &[String]) -> Result<()> {
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut rtt_iterations = 100usize;
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
                    "pglite" | "pglite-vendored" | "upstream" => SpeedSqlSource::PgliteVendored,
                    other => {
                        bail!("unknown --speed-source value {other:?}; use generated or pglite")
                    }
                };
            }
            other => bail!("unknown perf native-postgres flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");

    let native = NativePostgres::start(&postgres_bin, &initdb_bin)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres benchmark Tokio runtime")?;
    let runs = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        config
            .user("postgres")
            .dbname("postgres")
            .host_path(&native.socket_dir)
            .port(native.port);
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

        let mut runs = Vec::new();
        if suite.includes("rtt") {
            runs.push(
                run_native_postgres_rtt_benchmark(&client, rtt_iterations, connect_micros).await?,
            );
        }
        if suite.includes("speed") {
            runs.push(
                run_native_postgres_speed_benchmark(&client, speed_sql_source, connect_micros)
                    .await?,
            );
        }
        drop(client);
        connection_task.await.ok();
        Ok::<_, anyhow::Error>(runs)
    })?;

    let report = BenchmarkReport {
        wasmer_version: "native-postgres",
        wasmer_wasix_version: "native-postgres",
        source_model: speed_sql_source.source_model(),
        measurement_model: "Native Postgres control. xtask starts a temporary local cluster with PGlite-parity startup GUCs and sends each benchmark SQL file as one simple-query buffer through tokio-postgres simple_query. This intentionally avoids psql -f because psql splits files client-side.",
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

async fn run_native_postgres_rtt_benchmark(
    client: &tokio_postgres::Client,
    iterations: usize,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    client
        .simple_query(rtt_setup_sql())
        .await
        .context("execute native Postgres RTT setup")?;
    let setup_micros = setup_started.elapsed().as_micros();

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
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_postgres",
        description: "Native Postgres over Unix socket using tokio-postgres simple_query.",
        open_micros: 0,
        connect_micros: Some(connect_micros),
        setup_micros,
        tests,
    })
}

async fn run_native_postgres_speed_benchmark(
    client: &tokio_postgres::Client,
    sql_source: SpeedSqlSource,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
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
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_postgres",
        description: "Native Postgres speed suite over Unix socket using tokio-postgres simple_query.",
        open_micros: 0,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        tests,
    })
}

struct NativePostgres {
    child: Child,
    root: PathBuf,
    socket_dir: PathBuf,
    port: u16,
}

impl NativePostgres {
    fn start(postgres_bin: &Path, initdb_bin: &Path) -> Result<Self> {
        let root = env::current_dir()
            .context("read current directory")?
            .join("target/perf")
            .join(format!(
                "native-postgres-{}-{}",
                std::process::id(),
                now_micros()?
            ));
        let data_dir = root.join("data");
        let socket_dir = root.join("socket");
        fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;
        fs::create_dir_all(&socket_dir)
            .with_context(|| format!("create {}", socket_dir.display()))?;

        let init_status = Command::new(initdb_bin)
            .arg("-D")
            .arg(&data_dir)
            .args([
                "-A",
                "trust",
                "-U",
                "postgres",
                "--encoding=UTF8",
                "--no-instructions",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .with_context(|| format!("spawn native initdb {}", initdb_bin.display()))?;
        ensure!(
            init_status.success(),
            "native initdb failed with {init_status}"
        );

        let port = 55432 + (std::process::id() % 1000) as u16;
        let log_path = root.join("postgres.log");
        let log = fs::File::create(&log_path)
            .with_context(|| format!("create native Postgres log {}", log_path.display()))?;
        let child = Command::new(postgres_bin)
            .arg("-D")
            .arg(&data_dir)
            .arg("-h")
            .arg("")
            .arg("-k")
            .arg(&socket_dir)
            .arg("-p")
            .arg(port.to_string())
            .args([
                "-F",
                "-c",
                "fsync=off",
                "-c",
                "synchronous_commit=on",
                "-c",
                "shared_buffers=128MB",
                "-c",
                "wal_buffers=4MB",
                "-c",
                "min_wal_size=80MB",
                "-c",
                "max_worker_processes=1",
                "-c",
                "max_parallel_workers=0",
                "-c",
                "max_parallel_workers_per_gather=0",
                "-c",
                "autovacuum=off",
                "-c",
                "log_checkpoints=off",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .spawn()
            .with_context(|| format!("spawn native postgres {}", postgres_bin.display()))?;

        let mut native = Self {
            child,
            root,
            socket_dir,
            port,
        };
        native.wait_ready(&log_path)?;
        Ok(native)
    }

    fn wait_ready(&mut self, log_path: &Path) -> Result<()> {
        let socket_path = self.socket_dir.join(format!(".s.PGSQL.{}", self.port));
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if let Some(status) = self.child.try_wait().context("poll native postgres")? {
                let log = fs::read_to_string(log_path).unwrap_or_default();
                bail!("native postgres exited early with {status}; log:\n{log}");
            }
            if socket_path.exists() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let log = fs::read_to_string(log_path).unwrap_or_default();
        bail!("native postgres did not become ready; log:\n{log}");
    }
}

impl Drop for NativePostgres {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn perf_diagnose_indexed_update() -> Result<()> {
    Pglite::preload()?;

    let benchmark2 = read_pglite_benchmark_sql("2")?;
    let benchmark6 = read_pglite_benchmark_sql("6")?;
    let benchmark9 = read_pglite_benchmark_sql("9")?;
    let benchmark10 = read_pglite_benchmark_sql("10")?;
    let unlogged_benchmark2 = benchmark2.replace("CREATE TABLE", "CREATE UNLOGGED TABLE");
    let lookup_index_only = "CREATE INDEX i2a ON t2(a);\n";

    let cases = vec![
        run_indexed_update_diagnostic_case(
            "exact_numeric_indexed",
            "PGlite benchmark2 + benchmark6, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "exact_text_indexed",
            "PGlite benchmark2 + benchmark6, then exact benchmark10 text updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_lookup_index_only",
            "PGlite benchmark2 + index on lookup column a only, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_lookup_index_only",
            "PGlite benchmark2 + index on lookup column a only, then exact benchmark10 text updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_unlogged_indexed",
            "PGlite benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark9 numeric updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_unlogged_indexed",
            "PGlite benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark10 text updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_indexed",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_vacuumed",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM t2, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
                "VACUUM t2;\n",
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_vacuum_full",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM FULL t2, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
                "VACUUM FULL t2;\n",
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "set_based_numeric_indexed",
            "PGlite benchmark2 + benchmark6, then one set-based numeric update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET b = b + 1;\nCOMMIT;\n",
            1,
        )?,
        run_indexed_update_diagnostic_case(
            "set_based_text_indexed",
            "PGlite benchmark2 + benchmark6, then one set-based text update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET c = c || ' updated';\nCOMMIT;\n",
            1,
        )?,
    ];

    let report = IndexedUpdateDiagnosticReport {
        source_model: "Exact PGlite benchmark SQL files from assets/checkouts/pglite/packages/benchmark/src plus controlled variants.",
        measurement_model: "Each case opens a fresh temporary database, runs setup outside the measured section, then records the measured update SQL and internal Rust/WASIX phase timings.",
        cases,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_diagnose_speed_hotspots() -> Result<()> {
    perf_diagnose_speed_ids(&["9", "10", "11", "14"])
}

fn perf_diagnose_speed_cases(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    for arg in args {
        if let Some(raw_ids) = arg.strip_prefix("--ids=") {
            let parsed = raw_ids
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if parsed.is_empty() {
                bail!("--ids must contain at least one speed benchmark id");
            }
            ids = Some(parsed);
        } else {
            bail!("unknown perf diagnose-speed-cases flag: {arg}");
        }
    }

    let cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let selected_ids = match ids {
        Some(ids) => ids,
        None => cases.iter().map(|case| case.id.to_owned()).collect(),
    };
    let selected_refs = selected_ids.iter().map(String::as_str).collect::<Vec<_>>();
    perf_diagnose_speed_ids(&selected_refs)
}

fn perf_diagnose_speed_ids(ids: &[&str]) -> Result<()> {
    Pglite::preload()?;
    let cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let mut diagnostics = Vec::new();
    for id in ids {
        diagnostics.push(run_speed_hotspot_diagnostic_case(&cases, id)?);
    }

    let report = SpeedHotspotDiagnosticReport {
        source_model: "Exact PGlite benchmark SQL files from assets/checkouts/pglite/packages/benchmark/src.",
        measurement_model: "Each case opens a fresh temporary database, runs all earlier PGlite speed tests outside the measured section, then records the selected speed-test SQL, FS trace, and internal Rust/WASIX phase timings.",
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_diagnose_buffer_cache() -> Result<()> {
    Pglite::preload()?;
    let cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let mut diagnostics = Vec::new();
    diagnostics.push(run_buffer_cache_diagnostic_case(
        &cases,
        "11",
        &[
            "BEGIN",
            "INSERT INTO t1 SELECT b,a,c FROM t2",
            "INSERT INTO t2 SELECT b,a,c FROM t1",
            "COMMIT",
        ],
    )?);
    diagnostics.push(run_buffer_cache_diagnostic_case(
        &cases,
        "14",
        &["INSERT INTO t2 SELECT * FROM t1"],
    )?);

    let report = BufferCacheDiagnosticReport {
        source_model: "Exact PGlite benchmark SQL files from assets/checkouts/pglite/packages/benchmark/src.",
        measurement_model: "Each case opens a fresh temporary database, runs all earlier PGlite speed tests outside the measured section, then executes EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the target data-moving statements.",
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_buffer_cache_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    statements: &[&str],
) -> Result<BufferCacheDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let mut db = Pglite::builder()
        .temporary()
        .open()
        .with_context(|| format!("open buffer-cache diagnostic database for {}", target.id))?;

    let setup_started = Instant::now();
    for setup_case in &cases[..target_index] {
        db.exec(&setup_case.sql, None)
            .with_context(|| format!("run buffer-cache setup case {}", setup_case.id))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();

    let settings = exec_rows_json(
        &mut db,
        "SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('wal_buffers') AS wal_buffers, current_setting('work_mem') AS work_mem",
    )?;
    let relation_sizes = exec_rows_json(
        &mut db,
        "SELECT relname, pg_relation_size(oid)::bigint AS bytes FROM pg_class WHERE relname IN ('t1', 't2', 'i2a', 'i2b') ORDER BY relname",
    )?;

    let mut explained = Vec::new();
    for statement in statements {
        if matches!(*statement, "BEGIN" | "COMMIT") {
            let (result, phases) = capture_phase_timings(|| {
                let started = Instant::now();
                let result = db.exec(statement, None);
                (result, started.elapsed())
            });
            let (result, elapsed) = result;
            result.with_context(|| format!("run transaction control statement {statement}"))?;
            explained.push(BufferCacheDiagnosticStatement {
                sql: (*statement).to_owned(),
                elapsed_micros: elapsed.as_micros(),
                explain_rows: serde_json::Value::Null,
                fs_trace: serde_json::Value::Null,
                phases,
            });
            continue;
        }

        reset_fs_trace();
        let explain_sql = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {statement}");
        let (result, phases) = capture_phase_timings(|| {
            let started = Instant::now();
            let result = db.exec(&explain_sql, None);
            (result, started.elapsed())
        });
        let (result, elapsed) = result;
        let result = result.with_context(|| format!("run buffer-cache explain for {statement}"))?;
        let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
        explained.push(BufferCacheDiagnosticStatement {
            sql: (*statement).to_owned(),
            elapsed_micros: elapsed.as_micros(),
            explain_rows: results_to_json(result),
            fs_trace,
            phases,
        });
    }

    db.close()
        .with_context(|| format!("close buffer-cache diagnostic database for {}", target.id))?;

    Ok(BufferCacheDiagnosticCase {
        id: target.id.to_owned(),
        label: target.label.clone(),
        setup_micros,
        settings,
        relation_sizes,
        statements: explained,
    })
}

fn exec_rows_json(db: &mut Pglite, sql: &str) -> Result<serde_json::Value> {
    let results = db.exec(sql, None)?;
    Ok(results_to_json(results))
}

fn results_to_json(results: Vec<pglite_oxide::Results>) -> serde_json::Value {
    serde_json::Value::Array(
        results
            .into_iter()
            .map(|result| {
                serde_json::json!({
                    "fields": result
                        .fields
                        .into_iter()
                        .map(|field| {
                            serde_json::json!({
                                "name": field.name,
                                "dataTypeId": field.data_type_id,
                            })
                        })
                        .collect::<Vec<_>>(),
                    "rows": result.rows,
                    "affectedRows": result.affected_rows,
                })
            })
            .collect(),
    )
}

fn run_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let mut db = Pglite::builder()
        .temporary()
        .open()
        .with_context(|| format!("open speed hotspot diagnostic database for {}", target.id))?;

    let setup_started = Instant::now();
    for setup_case in &cases[..target_index] {
        db.exec(&setup_case.sql, None)
            .with_context(|| format!("run speed hotspot setup case {}", setup_case.id))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();

    reset_fs_trace();
    let (result, phases) = capture_phase_timings(|| {
        let started = Instant::now();
        let result = db.exec(&target.sql, None);
        (result, started.elapsed())
    });
    let (result, elapsed) = result;
    result.with_context(|| format!("run speed hotspot measured case {}", target.id))?;
    let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
    db.close()
        .with_context(|| format!("close speed hotspot diagnostic database for {}", target.id))?;

    Ok(SpeedHotspotDiagnosticCase {
        id: target.id.to_owned(),
        label: target.label.clone(),
        setup_micros,
        elapsed_micros: elapsed.as_micros(),
        operation_count: target.operation_count,
        fs_trace,
        phases,
    })
}

fn read_pglite_benchmark_sql(id: &str) -> Result<String> {
    let path = Path::new(PGLITE_BENCHMARK_SQL_DIR).join(format!("benchmark{id}.sql"));
    fs::read_to_string(&path)
        .with_context(|| format!("read PGlite benchmark SQL {}", path.display()))
}

fn run_indexed_update_diagnostic_case(
    name: &'static str,
    description: &'static str,
    setup_sql: &[&str],
    measured_sql: &str,
    operation_count: usize,
) -> Result<IndexedUpdateDiagnosticCase> {
    let mut db = Pglite::builder()
        .temporary()
        .open()
        .with_context(|| format!("open diagnostic database for {name}"))?;

    let setup_started = Instant::now();
    for sql in setup_sql {
        db.exec(sql, None)
            .with_context(|| format!("run diagnostic setup for {name}"))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();
    let stats_before = indexed_update_stats(&mut db)
        .with_context(|| format!("collect diagnostic pre-stats for {name}"))?;

    reset_fs_trace();
    let (result, phases) = capture_phase_timings(|| {
        let started = Instant::now();
        let result = db.exec(measured_sql, None);
        (result, started.elapsed())
    });
    let (result, elapsed) = result;
    result.with_context(|| format!("run diagnostic measured SQL for {name}"))?;
    let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
    let stats_after = indexed_update_stats(&mut db)
        .with_context(|| format!("collect diagnostic post-stats for {name}"))?;
    db.close()
        .with_context(|| format!("close diagnostic database for {name}"))?;

    Ok(IndexedUpdateDiagnosticCase {
        name,
        description,
        setup_micros,
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        stats_before,
        stats_after,
        fs_trace,
        phases,
    })
}

fn indexed_update_stats(db: &mut Pglite) -> Result<serde_json::Value> {
    let result = db.query(
        "SELECT \
             pg_relation_size('t2'::regclass)::text AS t2_size, \
             pg_relation_size('i2a'::regclass)::text AS i2a_size, \
             coalesce(pg_relation_size(to_regclass('i2b')), 0)::text AS i2b_size, \
             coalesce((SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_tup_upd, \
             coalesce((SELECT n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_tup_hot_upd, \
             coalesce((SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_dead_tup",
        &[],
        None,
    )?;
    Ok(result
        .rows
        .into_iter()
        .next()
        .unwrap_or(serde_json::Value::Null))
}

struct RttCase {
    id: &'static str,
    label: &'static str,
    sql: String,
}

struct SpeedCase {
    id: &'static str,
    label: String,
    sql: String,
    operation_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SpeedSqlSource {
    Generated,
    PgliteVendored,
}

impl SpeedSqlSource {
    fn source_model(self) -> &'static str {
        match self {
            SpeedSqlSource::Generated => {
                "Mirrors the two PGlite benchmark families documented at https://pglite.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and a SQLite speedtest-style SQL suite. The speed suite is generated locally instead of vendoring PGlite's generated SQL files."
            }
            SpeedSqlSource::PgliteVendored => {
                "Mirrors the two PGlite benchmark families documented at https://pglite.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and the exact SQL files from assets/checkouts/pglite/packages/benchmark/src."
            }
        }
    }
}

fn run_rtt_direct_benchmark(iterations: usize) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Pglite::builder().temporary().open()?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    db.exec(rtt_setup_sql(), None)?;
    let setup_micros = setup_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        tests.push(run_rtt_case(iterations, &case, |sql| {
            db.exec(sql, None)?;
            Ok(())
        })?);
    }
    db.close()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "direct",
        description: "PGlite direct Rust API, matching PGlite's in-process exec-style benchmark shape.",
        open_micros,
        connect_micros: None,
        setup_micros,
        tests,
    })
}

fn run_rtt_server_sqlx_benchmark(iterations: usize) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = PgliteServer::temporary_tcp()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create benchmark Tokio runtime")?;

    let (connect_micros, setup_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx benchmark client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        conn.execute(rtt_setup_sql())
            .await
            .context("execute RTT setup over SQLx")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let mut tests = Vec::new();
        for case in rtt_cases() {
            let mut samples = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let started = Instant::now();
                conn.execute(case.sql.as_str())
                    .await
                    .with_context(|| format!("execute RTT benchmark {} over SQLx", case.id))?;
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
        conn.close().await.context("close SQLx benchmark client")?;
        Ok::<_, anyhow::Error>((connect_micros, setup_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "server_sqlx",
        description: "PGliteServer over the Postgres wire protocol using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        tests,
    })
}

fn run_speed_direct_benchmark(scale: f64, sql_source: SpeedSqlSource) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Pglite::builder().temporary().open()?;
    let open_micros = open_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in speed_cases(scale, sql_source)? {
        let started = Instant::now();
        db.exec(&case.sql, None)
            .with_context(|| format!("execute speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
    }
    db.close()?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "direct",
        description: "Generated SQLite speedtest-style SQL suite through PGlite direct Rust API.",
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        tests,
    })
}

fn run_speed_server_sqlx_benchmark(scale: f64, sql_source: SpeedSqlSource) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = PgliteServer::temporary_tcp()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create benchmark Tokio runtime")?;

    let (connect_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx speed benchmark client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let mut tests = Vec::new();
        for case in speed_cases(scale, sql_source)? {
            let started = Instant::now();
            conn.execute(case.sql.as_str())
                .await
                .with_context(|| format!("execute speed benchmark {} over SQLx", case.id))?;
            tests.push(single_sample_result(
                case.id,
                case.label,
                "seconds",
                case.operation_count,
                started.elapsed(),
            ));
        }
        conn.close()
            .await
            .context("close SQLx speed benchmark client")?;
        Ok::<_, anyhow::Error>((connect_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "server_sqlx",
        description: "Generated SQLite speedtest-style SQL suite through one SQLx connection to PgliteServer.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        tests,
    })
}

fn rtt_setup_sql() -> &'static str {
    "\
CREATE TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);
CREATE TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);
"
}

fn rtt_cases() -> Vec<RttCase> {
    vec![
        RttCase {
            id: "1",
            label: "insert small row",
            sql: "INSERT INTO t1 (a) VALUES (1);".to_owned(),
        },
        RttCase {
            id: "2",
            label: "select small row",
            sql: "SELECT * FROM t1 WHERE id = 333;".to_owned(),
        },
        RttCase {
            id: "3",
            label: "update small row",
            sql: "UPDATE t1 SET a = 2 WHERE id = 666;".to_owned(),
        },
        RttCase {
            id: "4",
            label: "delete small row",
            sql: "DELETE FROM t1 WHERE id IN (SELECT id FROM t1 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "5",
            label: "insert 1kb row",
            sql: format!("INSERT INTO t2 (a) VALUES ('{}');", "a".repeat(1_000)),
        },
        RttCase {
            id: "6",
            label: "select 1kb row",
            sql: "SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "7",
            label: "update 1kb row",
            sql: format!("UPDATE t2 SET a = '{}' WHERE id = 1;", "a".repeat(1_000)),
        },
        RttCase {
            id: "8",
            label: "delete 1kb row",
            sql: "DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "9",
            label: "insert 10kb row",
            sql: format!("INSERT INTO t2 (a) VALUES ('{}');", "a".repeat(10_000)),
        },
        RttCase {
            id: "10",
            label: "select 10kb row",
            sql: "SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "11",
            label: "update 10kb row",
            sql: format!("UPDATE t2 SET a = '{}' WHERE id = 1;", "a".repeat(10_000)),
        },
        RttCase {
            id: "12",
            label: "delete 10kb row",
            sql: "DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
    ]
}

fn run_rtt_case(
    iterations: usize,
    case: &RttCase,
    mut execute: impl FnMut(&str) -> Result<()>,
) -> Result<BenchmarkTestResult> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        execute(&case.sql).with_context(|| format!("execute RTT benchmark {}", case.id))?;
        samples.push(started.elapsed().as_micros());
    }
    Ok(samples_result(
        case.id,
        format!("Test {}: {}", case.id, case.label),
        "milliseconds",
        iterations,
        samples,
    ))
}

fn samples_result(
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    samples: Vec<u128>,
) -> BenchmarkTestResult {
    let elapsed_micros = samples.iter().sum();
    let mut sorted = samples;
    sorted.sort_unstable();
    let trim = if sorted.len() >= 10 {
        sorted.len() / 10
    } else {
        0
    };
    let trimmed = &sorted[trim..sorted.len() - trim];
    let average = trimmed.iter().sum::<u128>() as f64 / trimmed.len() as f64;
    let p50 = percentile_sorted(&sorted, 0.50);
    let p95 = percentile_sorted(&sorted, 0.95);
    BenchmarkTestResult {
        id,
        label,
        unit,
        operation_count,
        sample_count: sorted.len(),
        trimmed_sample_count: trimmed.len(),
        elapsed_micros,
        average_micros: Some(average),
        min_micros: sorted.first().copied(),
        p50_micros: p50,
        p95_micros: p95,
    }
}

fn single_sample_result(
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    elapsed: Duration,
) -> BenchmarkTestResult {
    let elapsed_micros = elapsed.as_micros();
    BenchmarkTestResult {
        id,
        label,
        unit,
        operation_count,
        sample_count: 1,
        trimmed_sample_count: 1,
        elapsed_micros,
        average_micros: None,
        min_micros: Some(elapsed_micros),
        p50_micros: Some(elapsed_micros),
        p95_micros: Some(elapsed_micros),
    }
}

fn percentile_sorted(sorted: &[u128], percentile: f64) -> Option<u128> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * percentile).round() as usize;
    sorted.get(idx).copied()
}

fn speed_cases(scale: f64, sql_source: SpeedSqlSource) -> Result<Vec<SpeedCase>> {
    let insert_1k = scaled_count(1_000, scale);
    let insert_25k = scaled_count(25_000, scale);
    let select_100 = scaled_count(100, scale);
    let select_5k = scaled_count(5_000, scale);
    let update_1k = scaled_count(1_000, scale);
    let update_25k = scaled_count(25_000, scale);
    let refill_12k = scaled_count(12_000, scale);
    let mut cases = vec![
        SpeedCase {
            id: "1",
            label: format!("Test 1: {insert_1k} INSERTs"),
            sql: speed_create_and_insert("t1", insert_1k, false, false),
            operation_count: insert_1k,
        },
        SpeedCase {
            id: "2",
            label: format!("Test 2: {insert_25k} INSERTs in a transaction"),
            sql: speed_create_and_insert("t2", insert_25k, true, false),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "2.1",
            label: format!("Test 2.1: {insert_25k} INSERTs in single statement"),
            sql: speed_create_and_insert("t2_1", insert_25k, true, true),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "3",
            label: format!("Test 3: {insert_25k} INSERTs into an indexed table"),
            sql: speed_indexed_create_and_insert("t3", "i3", insert_25k, false),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "3.1",
            label: format!("Test 3.1: {insert_25k} INSERTs into an indexed table in single statement"),
            sql: speed_indexed_create_and_insert("t3_1", "i3_1", insert_25k, true),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "4",
            label: format!("Test 4: {select_100} SELECTs without an index"),
            sql: speed_select_range("t2", select_100, 100),
            operation_count: select_100,
        },
        SpeedCase {
            id: "5",
            label: format!("Test 5: {select_100} SELECTs on a string comparison"),
            sql: speed_select_like("t2", select_100),
            operation_count: select_100,
        },
        SpeedCase {
            id: "6",
            label: "Test 6: Creating indexes".to_owned(),
            sql: "CREATE INDEX i2a ON t2(a);\nCREATE INDEX i2b ON t2(b);\n".to_owned(),
            operation_count: 2,
        },
        SpeedCase {
            id: "7",
            label: format!("Test 7: {select_5k} SELECTs with an index"),
            sql: speed_select_range("t2", select_5k, 100),
            operation_count: select_5k,
        },
        SpeedCase {
            id: "8",
            label: format!("Test 8: {update_1k} UPDATEs without an index"),
            sql: speed_update_t1(update_1k),
            operation_count: update_1k,
        },
        SpeedCase {
            id: "9",
            label: format!("Test 9: {update_25k} UPDATEs with an index"),
            sql: speed_update_t2_numeric(update_25k),
            operation_count: update_25k,
        },
        SpeedCase {
            id: "10",
            label: format!("Test 10: {update_25k} text UPDATEs with an index"),
            sql: speed_update_t2_text(update_25k),
            operation_count: update_25k,
        },
        SpeedCase {
            id: "11",
            label: "Test 11: INSERTs from a SELECT".to_owned(),
            sql: "BEGIN;\nINSERT INTO t1 SELECT b,a,c FROM t2;\nINSERT INTO t2 SELECT b,a,c FROM t1;\nCOMMIT;\n".to_owned(),
            operation_count: 2,
        },
        SpeedCase {
            id: "12",
            label: "Test 12: DELETE without an index".to_owned(),
            sql: "DELETE FROM t2 WHERE c LIKE '%fifty%';\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "13",
            label: "Test 13: DELETE with an index".to_owned(),
            sql: "DELETE FROM t2 WHERE a > 10 AND a < 20000;\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "14",
            label: "Test 14: A big INSERT after a big DELETE".to_owned(),
            sql: "INSERT INTO t2 SELECT * FROM t1;\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "15",
            label: format!("Test 15: A big DELETE followed by {refill_12k} small INSERTs"),
            sql: speed_delete_and_refill_t1(refill_12k),
            operation_count: refill_12k + 1,
        },
        SpeedCase {
            id: "16",
            label: "Test 16: DROP TABLE".to_owned(),
            sql: "DROP TABLE t1;\nDROP TABLE t2;\nDROP TABLE t3;\nDROP TABLE t2_1;\nDROP TABLE t3_1;\n".to_owned(),
            operation_count: 5,
        },
    ];

    if sql_source == SpeedSqlSource::PgliteVendored {
        let benchmark_dir = Path::new(PGLITE_BENCHMARK_SQL_DIR);
        for case in &mut cases {
            let path = benchmark_dir.join(format!("benchmark{}.sql", case.id));
            case.sql = fs::read_to_string(&path)
                .with_context(|| format!("read PGlite benchmark SQL {}", path.display()))?;
        }
    }

    Ok(cases)
}

fn scaled_count(base: usize, scale: f64) -> usize {
    ((base as f64 * scale).round() as usize).max(1)
}

fn speed_create_and_insert(
    table: &str,
    rows: usize,
    transaction: bool,
    single_statement: bool,
) -> String {
    let mut sql = String::new();
    if transaction {
        sql.push_str("BEGIN;\n");
    }
    sql.push_str(&format!(
        "CREATE TABLE {table}(a INTEGER, b INTEGER, c VARCHAR(100));\n"
    ));
    if single_statement {
        sql.push_str(&format!("INSERT INTO {table} VALUES\n"));
        for row in 1..=rows {
            if row > 1 {
                sql.push_str(",\n");
            }
            sql.push_str(&speed_row_values(row, row));
        }
        sql.push_str(";\n");
    } else {
        append_insert_rows(&mut sql, table, rows, 0);
    }
    if transaction {
        sql.push_str("COMMIT;\n");
    }
    sql
}

fn speed_indexed_create_and_insert(
    table: &str,
    index: &str,
    rows: usize,
    single_statement: bool,
) -> String {
    let mut sql = String::new();
    sql.push_str("BEGIN;\n");
    sql.push_str(&format!(
        "CREATE TABLE {table}(a INTEGER, b INTEGER, c VARCHAR(100));\n"
    ));
    sql.push_str(&format!("CREATE INDEX {index} ON {table}(c);\n"));
    if single_statement {
        sql.push_str(&format!("INSERT INTO {table} VALUES\n"));
        for row in 1..=rows {
            if row > 1 {
                sql.push_str(",\n");
            }
            sql.push_str(&speed_row_values(row, row + 17));
        }
        sql.push_str(";\n");
    } else {
        append_insert_rows(&mut sql, table, rows, 17);
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn append_insert_rows(sql: &mut String, table: &str, rows: usize, seed_offset: usize) {
    for row in 1..=rows {
        sql.push_str(&format!(
            "INSERT INTO {table} VALUES{};\n",
            speed_row_values(row, row + seed_offset)
        ));
    }
}

fn speed_row_values(row: usize, seed: usize) -> String {
    let value = deterministic_benchmark_value(seed);
    format!("({row}, {value}, '{}')", synthetic_benchmark_text(value))
}

fn speed_select_range(table: &str, count: usize, width: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let low = step * width;
        let high = low + width;
        sql.push_str(&format!(
            "SELECT count(*), avg(b) FROM {table} WHERE b >= {low} AND b < {high};\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_select_like(table: &str, count: usize) -> String {
    const WORDS: &[&str] = &[
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let word = WORDS[step % WORDS.len()];
        sql.push_str(&format!(
            "SELECT count(*), avg(b) FROM {table} WHERE c LIKE '%{word}%';\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t1(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let low = step * 10;
        let high = low + 10;
        sql.push_str(&format!(
            "UPDATE t1 SET b = b * 2 WHERE a >= {low} AND a < {high};\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t2_numeric(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for row in 1..=count {
        let value = deterministic_benchmark_value(row + 101);
        sql.push_str(&format!("UPDATE t2 SET b = {value} WHERE a = {row};\n"));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t2_text(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for row in 1..=count {
        let value = deterministic_benchmark_value(row + 202);
        sql.push_str(&format!(
            "UPDATE t2 SET c = '{}' WHERE a = {row};\n",
            synthetic_benchmark_text(value)
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_delete_and_refill_t1(count: usize) -> String {
    let mut sql = String::from("BEGIN;\nDELETE FROM t1;\n");
    append_insert_rows(&mut sql, "t1", count, 303);
    sql.push_str("COMMIT;\n");
    sql
}

fn deterministic_benchmark_value(seed: usize) -> usize {
    ((seed as u64)
        .wrapping_mul(1_103_515_245)
        .wrapping_add(12_345)
        % 100_000) as usize
}

fn synthetic_benchmark_text(value: usize) -> String {
    const WORDS: &[&str] = &[
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    format!(
        "{} {} {} {}",
        WORDS[value % WORDS.len()],
        WORDS[(value / 7) % WORDS.len()],
        WORDS[(value / 97) % WORDS.len()],
        value
    )
}

fn mountfs_perf_enabled() -> bool {
    env_flag_enabled_by_default("PGLITE_OXIDE_MOUNTFS", true)
}

fn pgdata_overlay_perf_enabled() -> bool {
    env_flag_enabled_by_default("PGLITE_OXIDE_PGDATA_OVERLAY", true)
}

fn aot_deserialize_mmap_perf_enabled() -> bool {
    let Some(value) = env::var_os("PGLITE_OXIDE_AOT_DESERIALIZE") else {
        return true;
    };
    matches!(
        value.to_string_lossy().to_ascii_lowercase().as_str(),
        "" | "mmap" | "native" | "mmapped"
    )
}

fn env_flag_enabled_by_default(name: &str, default: bool) -> bool {
    let Some(value) = env::var_os(name) else {
        return default;
    };
    !matches!(
        value.to_string_lossy().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "off" | "no"
    )
}

fn capture_operation(
    name: &'static str,
    description: &'static str,
    cache_state_before: impl Into<String>,
    process_state_before: &'static str,
    root_state: &'static str,
    query_state: &'static str,
    workload: &'static str,
    primary_latency_phase: &'static str,
    operation: impl FnOnce() -> Result<()>,
) -> Result<PerfOperation> {
    let started = Instant::now();
    let (result, phases) = capture_phase_timings(operation);
    let elapsed_micros = started.elapsed().as_micros();
    result?;
    let primary_latency_micros = phases
        .iter()
        .rev()
        .find(|phase| phase.name == primary_latency_phase)
        .map(|phase| phase.elapsed_micros)
        .unwrap_or(elapsed_micros);
    Ok(PerfOperation {
        name,
        description,
        cache_state_before: cache_state_before.into(),
        process_state_before,
        root_state,
        query_state,
        workload,
        primary_latency_phase,
        primary_latency_micros,
        elapsed_micros,
        correct: true,
        phases,
    })
}

fn pglite_oxide_cache_dir() -> Result<PathBuf> {
    ProjectDirs::from("dev", "pglite-oxide", "pglite-oxide")
        .context("could not resolve pglite-oxide cache directory")
        .map(|dirs| dirs.cache_dir().to_path_buf())
}

fn run_direct_select_one() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Pglite::builder().temporary().open()?;
    let result = db.query(
        "SELECT $1::int4 + 1 AS answer",
        &[serde_json::json!(41)],
        None,
    )?;
    ensure_json_int(&result.rows[0]["answer"], 42)?;
    record_phase_timing(
        "visible.direct_open_to_first_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_vector_query() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;
    let result = db.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
        &[],
        None,
    )?;
    if result.rows[0]["distance"].as_f64().is_none() {
        bail!("extension-backed query did not return a float distance");
    }
    record_phase_timing(
        "visible.direct_open_to_first_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.close", || db.close())
}

fn run_server_sqlx_select_one() -> Result<()> {
    let visible_started = Instant::now();
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
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
            .context("connect SQLx to PGliteServer")?;
        record_phase_timing("client.sqlx_connect", started.elapsed());
        let started = Instant::now();
        let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
            .bind(41_i32)
            .fetch_one(&mut conn)
            .await
            .context("run first SQLx query")?;
        record_phase_timing("client.sqlx_first_query", started.elapsed());
        let answer: i32 = row.try_get("answer").context("read SQLx answer")?;
        if answer != 42 {
            bail!("SQLx server query returned {answer}, expected 42");
        }
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    record_phase_timing(
        "visible.server_start_to_first_sqlx_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_direct_repeated_selects(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    run_direct_scalar_query(&mut db, 41)?;
    let started = Instant::now();
    for value in 0..iterations {
        run_direct_scalar_query(&mut db, value as i32)?;
    }
    record_total_and_average(
        "warm.direct_repeated_scalar_queries.total",
        "warm.direct_repeated_scalar_queries.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_transaction_batch(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    run_direct_scalar_query(&mut db, 41)?;
    let started = Instant::now();
    db.transaction(|tx| {
        for value in 0..iterations {
            let result = tx.query(
                "SELECT $1::int4 + 1 AS answer",
                &[serde_json::json!(value as i32)],
                None,
            )?;
            ensure_json_int(&result.rows[0]["answer"], value as i64 + 1)?;
        }
        Ok(())
    })?;
    record_total_and_average(
        "warm.direct_transaction_batch.total",
        "warm.direct_transaction_batch.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_repeated_vector_queries(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;
    run_direct_vector_distance_query(&mut db)?;
    let started = Instant::now();
    for _ in 0..iterations {
        run_direct_vector_distance_query(&mut db)?;
    }
    record_total_and_average(
        "warm.direct_repeated_vector_queries.total",
        "warm.direct_repeated_vector_queries.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_scalar_query(db: &mut Pglite, value: i32) -> Result<()> {
    let result = db.query(
        "SELECT $1::int4 + 1 AS answer",
        &[serde_json::json!(value)],
        None,
    )?;
    ensure_json_int(&result.rows[0]["answer"], value as i64 + 1)
}

fn run_direct_vector_distance_query(db: &mut Pglite) -> Result<()> {
    let result = db.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
        &[],
        None,
    )?;
    if result.rows[0]["distance"].as_f64().is_none() {
        bail!("extension-backed query did not return a float distance");
    }
    Ok(())
}

fn run_server_sqlx_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to PGliteServer")?;
        run_sqlx_scalar_query(&mut conn, 41).await?;
        let started = Instant::now();
        for value in 0..iterations {
            run_sqlx_scalar_query(&mut conn, value as i32).await?;
        }
        record_total_and_average(
            "warm.server_sqlx_single_connection_repeated_queries.total",
            "warm.server_sqlx_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_sqlx_repeated_connections(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let started = Instant::now();
        for value in 0..iterations {
            let mut conn = sqlx::PgConnection::connect(&uri)
                .await
                .context("connect SQLx to PGliteServer")?;
            run_sqlx_scalar_query(&mut conn, value as i32).await?;
            conn.close().await.context("close SQLx connection")?;
        }
        record_total_and_average(
            "warm.server_sqlx_repeated_connections.total",
            "warm.server_sqlx_repeated_connections.avg",
            started.elapsed(),
            iterations,
        );
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_sqlx_vector_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", || {
        PgliteServer::builder()
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
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to extension-enabled PGliteServer")?;
        run_sqlx_vector_query(&mut conn).await?;
        let started = Instant::now();
        for _ in 0..iterations {
            run_sqlx_vector_query(&mut conn).await?;
        }
        record_total_and_average(
            "warm.server_sqlx_vector_single_connection_repeated_queries.total",
            "warm.server_sqlx_vector_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_tokio_postgres_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres to PGliteServer")?;
        let connection_handle = tokio::spawn(connection);
        run_tokio_postgres_scalar_query(&client, 41).await?;
        let started = Instant::now();
        for value in 0..iterations {
            run_tokio_postgres_scalar_query(&client, value as i32).await?;
        }
        record_total_and_average(
            "warm.server_tokio_postgres_single_connection_repeated_queries.total",
            "warm.server_tokio_postgres_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        drop(client);
        connection_handle
            .await
            .context("join tokio-postgres connection task")?
            .context("tokio-postgres connection task")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

async fn run_sqlx_scalar_query(conn: &mut sqlx::PgConnection, value: i32) -> Result<()> {
    let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
        .bind(value)
        .fetch_one(conn)
        .await
        .context("run SQLx scalar query")?;
    let answer: i32 = row.try_get("answer").context("read SQLx answer")?;
    ensure!(answer == value + 1, "SQLx query returned {answer}");
    Ok(())
}

async fn run_sqlx_vector_query(conn: &mut sqlx::PgConnection) -> Result<()> {
    let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
        .fetch_one(conn)
        .await
        .context("run SQLx vector query")?;
    let distance: f64 = row.try_get("distance").context("read vector distance")?;
    ensure!(distance == 1.0, "SQLx vector query returned {distance}");
    Ok(())
}

async fn run_tokio_postgres_scalar_query(
    client: &tokio_postgres::Client,
    value: i32,
) -> Result<()> {
    let row = client
        .query_one("SELECT $1::int4 + 1 AS answer", &[&value])
        .await
        .context("run tokio-postgres scalar query")?;
    let answer: i32 = row.get("answer");
    ensure!(
        answer == value + 1,
        "tokio-postgres query returned {answer}"
    );
    Ok(())
}

fn record_total_and_average(
    total_name: &'static str,
    average_name: &'static str,
    elapsed: Duration,
    iterations: usize,
) {
    record_phase_timing(total_name, elapsed);
    let average = elapsed.as_micros() / iterations as u128;
    record_phase_timing(
        average_name,
        Duration::from_micros(average.try_into().unwrap_or(u64::MAX)),
    );
}

fn unique_perf_root(name: &str) -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("read system clock for perf root")?
        .as_nanos();
    let root = env::temp_dir().join(format!("pglite-oxide-{name}-{}-{now}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale perf root {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("create perf root {}", root.display()))?;
    Ok(root)
}

fn ensure_json_int(value: &serde_json::Value, expected: i64) -> Result<()> {
    let Some(actual) = value.as_i64() else {
        bail!("expected integer JSON value {expected}, got {value}");
    };
    if actual != expected {
        bail!("expected integer JSON value {expected}, got {actual}");
    }
    Ok(())
}

fn check_sources_manifest(strict_local: bool) -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    check_source_spine(&manifest, strict_local, false)?;
    println!("validated {} pinned asset sources", manifest.sources.len());
    Ok(manifest)
}

fn fetch_pinned_sources(manifest: &SourcesManifest) -> Result<()> {
    run("git", &["submodule", "sync", "--recursive"])?;
    for source in &manifest.sources {
        let Some(path) = source_checkout_path(source.name.as_str()) else {
            eprintln!(
                "warning: source '{}' has no configured checkout path; skipping fetch",
                source.name
            );
            continue;
        };
        if !path.exists() {
            run(
                "git",
                &[
                    "submodule",
                    "update",
                    "--init",
                    "--recursive",
                    path.to_str().unwrap_or_default(),
                ],
            )?;
        }
        ensure_clean_checkout(path)?;
        let mut fetch = Command::new("git");
        fetch
            .args(["fetch", "origin", &source.commit, "--depth", "1"])
            .current_dir(path);
        run_command(&mut fetch).with_context(|| format!("fetch {}", source.name))?;
        let mut checkout = Command::new("git");
        checkout
            .args(["checkout", &source.commit])
            .current_dir(path);
        run_command(&mut checkout).with_context(|| {
            format!(
                "checkout {} at {} in {}",
                source.name,
                source.commit,
                path.display()
            )
        })?;
    }
    check_source_spine(manifest, true, false)
}

fn source_checkout_path(name: &str) -> Option<&'static Path> {
    match name {
        POSTGRES_PGLITE_SOURCE => Some(Path::new(POSTGRES_PGLITE_PATH)),
        PGLITE_BUILD_SOURCE => Some(Path::new(PGLITE_BUILD_PATH)),
        "pglite" => Some(Path::new("assets/checkouts/pglite")),
        "pgvector" => Some(Path::new(PGVECTOR_BUILD_DIR)),
        "pglite-bindings" => Some(Path::new("assets/checkouts/pglite-bindings")),
        _ => None,
    }
}

fn ensure_clean_checkout(path: &Path) -> Result<()> {
    if !path.exists() {
        bail!("source checkout is missing: {}", path.display());
    }
    let status = command_output("git", &["status", "--porcelain"], path)
        .with_context(|| format!("read status for {}", path.display()))?;
    if !status.trim().is_empty() {
        bail!(
            "source checkout {} has uncommitted changes; preserve them before fetching pins",
            path.display()
        );
    }
    Ok(())
}

fn load_sources_manifest() -> Result<SourcesManifest> {
    let path = Path::new("assets/sources.toml");
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    toml::from_str(&text).context("parse assets/sources.toml")
}

fn validate_sources_manifest(manifest: &SourcesManifest) -> Result<()> {
    if manifest.sources.is_empty() {
        bail!("assets/sources.toml must contain at least one source pin");
    }
    ensure_eq(
        &manifest.toolchain.wasmer,
        "7.2.0-alpha.2",
        "toolchain.wasmer",
    )?;
    ensure_eq(
        &manifest.toolchain.wasmer_wasix,
        "0.702.0-alpha.2",
        "toolchain.wasmer-wasix",
    )?;
    if !manifest
        .toolchain
        .docker_image_digest
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit()))
    {
        bail!(
            "toolchain.docker_image_digest must pin a concrete sha256 digest, got {}",
            manifest.toolchain.docker_image_digest
        );
    }
    let dockerfile = fs::read_to_string("assets/wasix-build/docker/Dockerfile")
        .context("read WASIX build Dockerfile")?;
    if !dockerfile.contains(&format!(
        "FROM ubuntu:24.04@{}",
        manifest.toolchain.docker_image_digest
    )) {
        bail!("WASIX build Dockerfile must pin the same base image digest as assets/sources.toml");
    }
    ensure_eq(
        &manifest.build.postgres_prefix,
        "/",
        "build.postgres_prefix",
    )?;
    ensure_eq(
        &manifest.build.postgres_pkglibdir,
        "/lib/postgresql",
        "build.postgres_pkglibdir",
    )?;
    ensure_eq(
        &manifest.build.postgres_sharedir,
        "/share/postgresql",
        "build.postgres_sharedir",
    )?;
    ensure_contains(
        &manifest.build.main_flags,
        "-fwasm-exceptions",
        "build.main_flags",
    )?;
    ensure_no_flag_contains(&manifest.build.main_flags, "asyncify", "build.main_flags")?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-fwasm-exceptions",
        "build.extension_flags",
    )?;
    ensure_no_flag_contains(
        &manifest.build.extension_flags,
        "asyncify",
        "build.extension_flags",
    )?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-fPIC",
        "build.extension_flags",
    )?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-Wl,-shared",
        "build.extension_flags",
    )?;
    ensure_eq(
        &manifest.build.archive_format,
        "tar.zst",
        "build.archive_format",
    )?;
    if !manifest.build.deterministic_archives {
        bail!("build.deterministic_archives must be true");
    }
    for source in &manifest.sources {
        if source.name.trim().is_empty()
            || source.url.trim().is_empty()
            || source.branch.trim().is_empty()
            || source.commit.len() < 40
        {
            bail!("invalid source pin in assets/sources.toml: {source:?}");
        }
    }
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    ensure_eq(
        &postgres.branch,
        EXPECTED_POSTGRES_PGLITE_BRANCH,
        "postgres-pglite source branch",
    )?;
    let pglite_build = source_by_name(manifest, PGLITE_BUILD_SOURCE)?;
    ensure_eq(
        &pglite_build.branch,
        EXPECTED_PGLITE_BUILD_BRANCH,
        "pglite-build source branch",
    )?;
    Ok(())
}

fn check_generated_manifest(manifest: &SourcesManifest, strict: bool) -> Result<()> {
    let path = Path::new("crates/assets/assets/manifest.json");
    if !path.exists() {
        if strict {
            bail!("generated asset manifest is missing at {}", path.display());
        }
        eprintln!(
            "warning: generated asset manifest is missing at {}",
            path.display()
        );
        return Ok(());
    }

    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let generated: GeneratedAssetManifest =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;

    let mut drift = Vec::new();
    for source in &manifest.sources {
        match generated
            .sources
            .iter()
            .find(|generated| generated.name == source.name)
        {
            Some(generated)
                if generated.url == source.url
                    && generated.branch == source.branch
                    && generated.commit == source.commit => {}
            Some(generated) => drift.push(format!(
                "{} generated={}/{}@{} expected={}/{}@{}",
                source.name,
                generated.url,
                generated.branch,
                generated.commit,
                source.url,
                source.branch,
                source.commit
            )),
            None => drift.push(format!("{} missing from generated manifest", source.name)),
        }
    }

    if drift.is_empty() {
        println!("generated asset manifest source pins match assets/sources.toml");
        return Ok(());
    }

    let details = drift.join("; ");
    if strict {
        bail!("generated asset manifest has stale source pins: {details}");
    }
    eprintln!("warning: generated asset manifest has stale source pins: {details}");
    Ok(())
}

fn check_no_legacy_runtime_shims() -> Result<()> {
    let banned = [
        (
            "src/pglite/base.rs",
            &[
                "normalize_runtime_tree",
                "mirror_configured_share_layout",
                "mirror_configured_lib_layout",
                "normalize_pgdata_config",
                "share/timezonesets/Default",
                "write minimal timezoneset",
                "log_timezone = UTC",
                "timezone = UTC",
            ][..],
        ),
        (
            "src/pglite/postgres_mod.rs",
            &[
                "\"pgl_initdb\"",
                "\"pgl_backend\"",
                "PostgresRecoverProtocolError",
            ][..],
        ),
    ];

    let mut failures = Vec::new();
    for (path, patterns) in banned {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        for pattern in patterns {
            if text.contains(pattern) {
                failures.push(format!(
                    "{path} contains legacy runtime shim marker {pattern:?}"
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    println!("legacy runtime shim source guard passed");
    Ok(())
}

fn check_production_wasix_build_inputs() -> Result<()> {
    for required in [
        WASIX_PATCH_PATH,
        WASIX_BRIDGE_PATH,
        "assets/wasix-build/wasix_shim/pglite_wasix_bridge_abi_test.c",
        "assets/wasix-build/wasix_shim/pglite_wasix_shim.c",
        "assets/wasix-build/analyze_pgl_stubs.sh",
        "assets/wasix-build/configure_wasix_dl.sh",
        "assets/wasix-build/profile_flags.sh",
        "assets/wasix-build/prepare_patched_source.sh",
        "assets/wasix-build/pg_config_wasix.sh",
        "assets/wasix-build/docker/Dockerfile",
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgvector.sh",
        "assets/wasix-build/docker_pgtrgm.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ] {
        if !Path::new(required).exists() {
            bail!("production WASIX build input is missing: {required}");
        }
    }

    let legacy_root = ["spikes", "wasix-postgres-build"].join("/");
    let legacy_source_root = ["spikes", "upstream"].join("/");
    let production_files = [
        "xtask/src/main.rs",
        "assets/wasix-build/analyze_pgl_stubs.sh",
        "assets/wasix-build/configure_wasix_dl.sh",
        "assets/wasix-build/profile_flags.sh",
        "assets/wasix-build/prepare_patched_source.sh",
        "assets/wasix-build/pg_config_wasix.sh",
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgvector.sh",
        "assets/wasix-build/docker_pgtrgm.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ];
    for path in production_files {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        if text.contains(&legacy_root) {
            bail!("{path} still depends on legacy production build root {legacy_root}");
        }
        if text.contains(&legacy_source_root) {
            bail!("{path} still depends on historical source checkout root {legacy_source_root}");
        }
        if path == "assets/wasix-build/configure_wasix_dl.sh"
            && text.contains("--disable-spinlocks")
        {
            bail!(
                "{path} disables PostgreSQL spinlocks; WASIX builds must use the toolchain atomics path"
            );
        }
    }

    ensure_file_contains_all(
        "assets/wasix-build/profile_flags.sh",
        &[
            "release)",
            "-O2 -g0",
            "release-o3)",
            "-O3 -g0 -flto=thin",
            "-flto=thin",
            "release-os)",
            "-Os -g0",
            "release-oz)",
            "-Oz -g0",
            "--converge:--strip-debug:--strip-producers",
            "WASIXCC_RUN_WASM_OPT",
            "WASIXCC_WASM_OPT_FLAGS",
            "PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT",
            "PGLITE_OXIDE_WASIX_BACKEND_TIMING",
            "production WASIX artifacts require WebAssembly exceptions",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/configure_wasix_dl.sh",
        &[
            "profile_flags.sh",
            "PGLITE_OXIDE_PROFILE_CFLAGS",
            "-sWASM_EXCEPTIONS=yes",
            "-sPIC=yes",
            "-Dlongjmp=pgl_longjmp",
            "-Dsiglongjmp=pgl_siglongjmp",
            "-DPGLITE_WASIX_BACKEND_TIMING",
            "-sMODULE_KIND=dynamic-main",
            "-Wl,-shared",
            "LDFLAGS_EX=\"$MAIN_LDFLAGS$LDFLAGS_EXTRA\"",
            "LDFLAGS_SL=\"$SIDE_MODULE_LDFLAGS\"",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_BRIDGE_PATH,
        &[
            "pgl_backend_timing_reset",
            "pgl_backend_timing_start",
            "pgl_backend_timing_end",
            "pgl_backend_timing_elapsed_us",
            "CLOCK_MONOTONIC",
            "#ifdef PGLITE_WASIX_BACKEND_TIMING",
            "pgl_setPGliteActive",
            "pgl_longjmp",
            "pgl_siglongjmp",
            "pgl_run_atexit_funcs",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_PATCH_PATH,
        &[
            "#if defined(PGLITE_WASIX_DL) && defined(PGLITE_WASIX_BACKEND_TIMING)",
            "PGL_BACKEND_TIMING_CREATE_SHARED_MEMORY",
            "PGL_BACKEND_TIMING_RELATION_CACHE_PHASE3",
            "PGL_BACKEND_TIMING_INITIALIZE_ACL",
            "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
            "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/docker_pglite.sh",
        &[
            "PGLITE_OXIDE_BUILD_PROFILE",
            "PGLITE_OXIDE_WASIX_BACKEND_TIMING",
            ".pglite-oxide-build-profile",
            "pglite_oxide_wasix_profile_signature",
        ],
    )?;
    ensure_file_not_contains_any(
        "assets/wasix-build/configure_wasix_dl.sh",
        &["ASYNCIFY", "-sASYNCIFY"],
    )?;

    println!("production WASIX build input guard passed");
    Ok(())
}

fn check_rust_startup_abi_boundary() -> Result<()> {
    let path = Path::new("src/pglite/postgres_mod.rs");
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

    for marker in [
        "struct PgliteLifecycleExports",
        "struct WasixProtocolExports",
        "fn ensure_integrated_pglite_contract",
        "fn record_backend_c_timings",
        "pgl_backend_timing_reset",
        "pgl_backend_timing_elapsed_us",
        "The upstream lifecycle is already running by this point",
    ] {
        if !text.contains(marker) {
            bail!(
                "{} must keep upstream lifecycle exports separate from WASIX protocol ABI; missing {marker:?}",
                path.display()
            );
        }
    }
    if text.contains("struct Exports") {
        bail!(
            "{} must not collapse PGlite lifecycle and WASIX protocol exports into a generic Exports struct",
            path.display()
        );
    }

    let lifecycle_start = text
        .find("struct PgliteLifecycleExports")
        .ok_or_else(|| anyhow!("missing PgliteLifecycleExports"))?;
    let protocol_start = text
        .find("struct WasixProtocolExports")
        .ok_or_else(|| anyhow!("missing WasixProtocolExports"))?;
    let lifecycle_block = &text[lifecycle_start..protocol_start];
    for protocol_marker in [
        "ProcessStartupPacket",
        "PostgresMainLoopOnce",
        "pgl_wasix_input",
    ] {
        if lifecycle_block.contains(protocol_marker) {
            bail!(
                "{} lifecycle export block leaked WASIX protocol marker {protocol_marker:?}",
                path.display()
            );
        }
    }
    for lifecycle_marker in ["wasi_start", "set_active", "start_pglite"] {
        if !lifecycle_block.contains(lifecycle_marker) {
            bail!(
                "{} must drive the integrated PGlite lifecycle; missing {lifecycle_marker:?}",
                path.display()
            );
        }
    }

    println!("Rust startup ABI boundary guard passed");
    Ok(())
}

fn check_canonical_asset_layout(strict: bool) -> Result<()> {
    let runtime_archive = Path::new("crates/assets/assets/pglite.wasix.tar.zst");
    if !runtime_archive.exists() {
        if strict {
            bail!(
                "runtime asset archive is missing at {}",
                runtime_archive.display()
            );
        }
        eprintln!(
            "warning: runtime asset archive is missing at {}",
            runtime_archive.display()
        );
        return Ok(());
    }

    let runtime_entries = archive_entries(runtime_archive)?;
    for required in [
        "pglite/bin/pglite",
        "pglite/bin/pg_dump",
        "pglite/lib/postgresql/plpgsql.so",
        "pglite/share/postgresql/extension/plpgsql.control",
        "pglite/share/postgresql/timezone/UTC",
        "pglite/share/postgresql/timezone/America/New_York",
        "pglite/share/postgresql/timezonesets/Default",
    ] {
        if !runtime_entries.contains(required) {
            bail!(
                "runtime archive {} is missing canonical path {required}",
                runtime_archive.display()
            );
        }
    }
    for forbidden in [
        "pglite/share/extension",
        "pglite/share/timezonesets",
        "pglite/lib/plpgsql.so",
        "pglite/lib/dict_snowball.so",
    ] {
        if runtime_entries.contains(forbidden)
            || runtime_entries
                .iter()
                .any(|entry| entry.starts_with(&format!("{forbidden}/")))
        {
            bail!(
                "runtime archive {} contains non-canonical duplicate path {forbidden}",
                runtime_archive.display()
            );
        }
    }

    let extensions_dir = Path::new("crates/assets/assets/extensions");
    if extensions_dir.exists() {
        for entry in fs::read_dir(extensions_dir)
            .with_context(|| format!("read {}", extensions_dir.display()))?
        {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("zst") {
                continue;
            }
            check_extension_archive_layout(&path)?;
        }
    } else if strict {
        bail!(
            "extension asset directory is missing at {}",
            extensions_dir.display()
        );
    }

    println!("canonical asset layout guard passed");
    Ok(())
}

fn check_extension_archive_layout(path: &Path) -> Result<()> {
    let entries = archive_entries(path)?;
    for entry in entries {
        if matches!(
            entry.as_str(),
            "lib" | "lib/postgresql" | "share" | "share/postgresql" | "share/postgresql/extension"
        ) {
            continue;
        }
        if entry.starts_with("lib/postgresql/") || entry.starts_with("share/postgresql/extension/")
        {
            continue;
        }
        bail!(
            "extension archive {} contains non-canonical path {entry}",
            path.display()
        );
    }
    Ok(())
}

fn archive_entries(path: &Path) -> Result<HashSet<String>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decode {}", path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = HashSet::new();
    for entry in archive
        .entries()
        .with_context(|| format!("read entries from {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("read entry from {}", path.display()))?;
        let entry_path = entry
            .path()
            .with_context(|| format!("read entry path from {}", path.display()))?;
        let entry = entry_path
            .to_str()
            .ok_or_else(|| anyhow!("archive {} has non-UTF-8 path", path.display()))?
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if !entry.is_empty() {
            entries.insert(entry);
        }
    }
    Ok(entries)
}

fn audit_upstream_fixes(manifest: &SourcesManifest, strict: bool) -> Result<()> {
    let checkout = Path::new(POSTGRES_PGLITE_PATH);
    if !checkout.exists() {
        bail!("missing local checkout {}", checkout.display());
    }
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    println!(
        "auditing upstream fixes against {} {}",
        postgres.branch, postgres.commit
    );

    let mut pending_required = Vec::new();
    for item in UPSTREAM_AUDIT {
        let status = if is_git_ancestor(checkout, item.commit)? {
            "included".to_owned()
        } else if let Some(replacement) = replacement_for_upstream_item(item.id)? {
            format!("replaced ({replacement})")
        } else if item.required {
            pending_required.push(item.id);
            "pending".to_owned()
        } else {
            "optional".to_owned()
        };
        println!(
            "{status:32} {} {} - {}",
            item.id, item.commit, item.description
        );
    }

    if strict && !pending_required.is_empty() {
        bail!(
            "required upstream fixes are not included in the active source branch: {}",
            pending_required.join(", ")
        );
    }
    Ok(())
}

fn replacement_for_upstream_item(id: &str) -> Result<Option<&'static str>> {
    match id {
        "stable-protocol-exports" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "src/backend/tcop/postgres.c",
                    "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
                    "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
                    "__attribute__((export_name(\"ProcessStartupPacket\"))) int",
                ],
            )?;
            let patch_text = fs::read_to_string(WASIX_PATCH_PATH)
                .with_context(|| format!("read {WASIX_PATCH_PATH}"))?;
            if patch_adds_marker(&patch_text, "ProcessStartupPacket: STUB") {
                bail!("WASIX patch must not add a stub ProcessStartupPacket");
            }
            ensure_file_contains_all(
                "src/pglite/postgres_mod.rs",
                &["PgliteLifecycleExports", "WasixProtocolExports"],
            )?;
            ensure_file_not_contains_any(
                "src/pglite/postgres_mod.rs",
                &[
                    "apply_direct_startup_gucs",
                    "pgl_apply_default_gucs",
                    "PostgresRecoverProtocolError",
                ],
            )?;
            ensure_file_contains_all(
                "tests/client_compat.rs",
                &[
                    "sqlx_extended_query_errors_recover_after_sync",
                    "raw_wire_protocol_bind_errors_are_synchronized",
                    "postgres_control_packets_are_handled_safely",
                ],
            )?;
            Ok(Some("WASIX protocol ABI + client/raw-wire tests"))
        }
        "stable-checkpointer-disable" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "RequestCheckpoint(CHECKPOINT_CAUSE_XLOG)",
                    "#ifndef __PGLITE__",
                    "#endif",
                ],
            )?;
            ensure_file_contains_all(
                "tests/runtime_smoke.rs",
                &["persistent_fresh_initdb_survives_restart_and_stale_state_files"],
            )?;
            Ok(Some("ported into wasix-dl patch"))
        }
        "stable-external-checkpointer" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "src/backend/postmaster/checkpointer.c",
                    "RequestCheckpoint(int flags)",
                    "#ifndef __PGLITE__",
                    "if (!IsPostmasterEnvironment)",
                ],
            )?;
            ensure_file_contains_all(
                "tests/performance_smoke.rs",
                &["cached_extension_template_opens_without_startup_xlog_recovery"],
            )?;
            Ok(Some(
                "ported in-process checkpoint behavior into wasix-dl patch",
            ))
        }
        "stable-imported-memory" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &[
                    "-sMODULE_KIND=dynamic-main",
                    "-sWASM_EXCEPTIONS=yes",
                    "-Wl,-shared",
                ],
            )?;
            ensure_file_contains_all(
                "crates/assets/assets/manifest.json",
                &["wasix-dynamic-main"],
            )?;
            Ok(Some("WASIX dynamic-main/side-module memory contract"))
        }
        "stable-memory-stack" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &["-sSTACK_SIZE=8MB", "-sINITIAL_MEMORY=128MB"],
            )?;
            Ok(Some(
                "WASIX build profile pins stack and initial memory sizing",
            ))
        }
        "stable-postgres-user" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &["static char name[] = \"postgres\"", "\"/home/postgres\""],
            )?;
            ensure_file_contains_all(
                "src/pglite/postgres_mod.rs",
                &[
                    "(\"PGUSER\", \"postgres\")",
                    "(\"PGDATABASE\", \"template1\")",
                ],
            )?;
            ensure_file_contains_all(
                "tests/runtime_smoke.rs",
                &["current_user", "session_user", "Some(&json!(\"postgres\"))"],
            )?;
            Ok(Some("WASIX identity bridge + runtime smoke tests"))
        }
        "stable-initdb-single-no-exit" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &[
                    "-Dexit=pgl_exit",
                    "-Dlongjmp=pgl_longjmp",
                    "-Dsiglongjmp=pgl_siglongjmp",
                ],
            )?;
            ensure_file_contains_all(
                "tests/runtime_smoke.rs",
                &[
                    "persistent_fresh_initdb_survives_restart_and_stale_state_files",
                    "persistent_fresh_initdb_recovers_interrupted_pgdata_without_marker",
                    "persistent_fresh_initdb_recovers_interrupted_pgdata_with_incomplete_markers",
                ],
            )?;
            Ok(Some(
                "WASIX bridge follows upstream PGlite single-user process-exit/longjmp lifecycle",
            ))
        }
        "stable-atexit-single-cleanup" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &["pgl_atexit", "pgl_run_atexit_funcs", "pgl_exit(int status)"],
            )?;
            Ok(Some(
                "WASIX bridge stores atexit handlers and lets Rust close run them explicitly",
            ))
        }
        "stable-postmaster-environment" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &["IsPostmasterEnvironment = true", "pgl_startPGlite"],
            )?;
            Ok(Some(
                "uses upstream PGlite pgl_startPGlite postmaster-environment setup",
            ))
        }
        "stable-timer-cleanup" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &[
                    "pgl_clear_interval_timer",
                    "setitimer(ITIMER_REAL",
                    "pgl_exit(int status)",
                ],
            )?;
            Ok(Some("WASIX process-exit bridge clears interval timers"))
        }
        _ => Ok(None),
    }
}

fn ensure_file_contains_all(path: &str, markers: &[&str]) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let missing = markers
        .iter()
        .copied()
        .filter(|marker| !text.contains(marker))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        bail!(
            "{path} is missing required upstream replacement markers: {}",
            missing.join(", ")
        );
    }
    Ok(())
}

fn ensure_file_not_contains_any(path: &str, markers: &[&str]) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let present = markers
        .iter()
        .copied()
        .filter(|marker| text.contains(marker))
        .collect::<Vec<_>>();
    if !present.is_empty() {
        bail!(
            "{path} contains production-excluded markers: {}",
            present.join(", ")
        );
    }
    Ok(())
}

fn is_git_ancestor(checkout: &Path, commit: &str) -> Result<bool> {
    let status = Command::new("git")
        .args(["merge-base", "--is-ancestor", commit, "HEAD"])
        .current_dir(checkout)
        .status()
        .with_context(|| format!("check whether {commit} is in {}", checkout.display()))?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => bail!("git merge-base failed for {commit} with {status}"),
    }
}

fn check_source_spine(
    manifest: &SourcesManifest,
    strict_local: bool,
    check_patch_applies: bool,
) -> Result<()> {
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    let gitmodules_path = command_output(
        "git",
        &[
            "config",
            "-f",
            ".gitmodules",
            "--get",
            "submodule.assets/checkouts/postgres-pglite.path",
        ],
        Path::new("."),
    )
    .context("read postgres-pglite path from .gitmodules")?;
    ensure_eq(
        gitmodules_path.trim(),
        POSTGRES_PGLITE_PATH,
        ".gitmodules postgres-pglite path",
    )?;
    let gitmodules_branch = command_output(
        "git",
        &[
            "config",
            "-f",
            ".gitmodules",
            "--get",
            "submodule.assets/checkouts/postgres-pglite.branch",
        ],
        Path::new("."),
    )
    .context("read postgres-pglite branch from .gitmodules")?;
    ensure_eq(
        gitmodules_branch.trim(),
        EXPECTED_POSTGRES_PGLITE_BRANCH,
        ".gitmodules postgres-pglite branch",
    )?;
    let pglite_build = source_by_name(manifest, PGLITE_BUILD_SOURCE)?;
    let gitmodules_build_path = command_output(
        "git",
        &[
            "config",
            "-f",
            ".gitmodules",
            "--get",
            "submodule.assets/checkouts/pglite-build.path",
        ],
        Path::new("."),
    )
    .context("read pglite-build path from .gitmodules")?;
    ensure_eq(
        gitmodules_build_path.trim(),
        PGLITE_BUILD_PATH,
        ".gitmodules pglite-build path",
    )?;
    let gitmodules_build_branch = command_output(
        "git",
        &[
            "config",
            "-f",
            ".gitmodules",
            "--get",
            "submodule.assets/checkouts/pglite-build.branch",
        ],
        Path::new("."),
    )
    .context("read pglite-build branch from .gitmodules")?;
    ensure_eq(
        gitmodules_build_branch.trim(),
        EXPECTED_PGLITE_BUILD_BRANCH,
        ".gitmodules pglite-build branch",
    )?;

    let patch = Path::new(WASIX_PATCH_PATH);
    if !patch.exists() {
        bail!("missing WASIX source patch at {}", patch.display());
    }
    let patch_text =
        fs::read_to_string(patch).with_context(|| format!("read {}", patch.display()))?;
    let required_patch_markers = [
        "src/template/wasix-dl",
        "src/makefiles/Makefile.wasix-dl",
        "src/include/port/wasix-dl.h",
        "src/include/port/wasix-dl/sys/ipc.h",
        "src/include/port/wasix-dl/sys/shm.h",
        "src/backend/tcop/postgres.c",
        "src/backend/tcop/backend_startup.c",
        "__attribute__((export_name(\"ProcessStartupPacket\"))) int",
        "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
        "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
        "PGL_BACKEND_TIMING_INIT_POSTGRES",
        "PGL_BACKEND_TIMING_SHARED_MEMORY",
        "wasm_dl_extension_imports_dir",
        "PGLITE_WASIX_DL",
    ];
    let missing_patch_markers = required_patch_markers
        .iter()
        .copied()
        .filter(|marker| !patch_text.contains(marker))
        .collect::<Vec<_>>();
    if !missing_patch_markers.is_empty() {
        bail!(
            "WASIX patch {} is missing expected source-spine entries: {}",
            patch.display(),
            missing_patch_markers.join(", ")
        );
    }
    let banned_added_patch_markers = [
        "#pragma warning \"-------------------- TEST",
        "return stderr;",
        "popen[%s]",
        "pg_pclose(%s)",
        "ProcessStartupPacket: STUB",
        "select_default_timezone(%s): STUB",
        "emscripten_extension_imports_dir :=",
        "pglite-wasm/",
    ];
    let mut banned_patch_additions = Vec::new();
    for marker in banned_added_patch_markers {
        if patch_adds_marker(&patch_text, marker) {
            banned_patch_additions.push(marker);
        }
    }
    if !banned_patch_additions.is_empty() {
        bail!(
            "WASIX patch {} reintroduces spike debug/shim additions: {}",
            patch.display(),
            banned_patch_additions.join(", ")
        );
    }
    let bridge = Path::new(WASIX_BRIDGE_PATH);
    if !bridge.exists() {
        bail!("missing WASIX PGlite bridge at {}", bridge.display());
    }
    let bridge_text =
        fs::read_to_string(bridge).with_context(|| format!("read {}", bridge.display()))?;
    if !bridge_text.contains("pgl_wasix_input_write")
        || !bridge_text.contains("pgl_recv")
        || !bridge_text.contains("pgl_shmget")
        || !bridge_text.contains("strcmp(command, \"locale -a\") != 0")
        || !bridge_text.contains("strcmp(mode, \"r\") != 0")
        || !bridge_text.contains("static char name[] = \"postgres\"")
        || !bridge_text.contains("PGLITE_PROTOCOL_FD")
        || !bridge_text.contains("pgl_write_int_sockopt")
        || !bridge_text.contains("errno = ENOPROTOOPT")
        || !bridge_text.contains("return recv(fd, buf, n, flags)")
        || !bridge_text.contains("return send(fd, buf, n, flags)")
        || !bridge_text.contains("return connect(socket, address, address_len)")
        || !bridge_text.contains("return munmap(addr, length)")
        || !bridge_text.contains("return poll(fds, nfds, timeout)")
    {
        bail!(
            "WASIX bridge {} does not contain expected protocol/socket/shared-memory/locale identity allowlisted ABI",
            bridge.display()
        );
    }
    for banned in [
        "(void) level;\n\t(void) optname;\n\t(void) optval;\n\t(void) optlen;\n\treturn 0;",
        "(void) addr;\n\t(void) len;\n\treturn 0;",
        "(void) fd;\n\t(void) flags;\n\treturn pgl_wasix_buffer_read",
        "(void) fd;\n\t(void) flags;\n\treturn pgl_wasix_buffer_write",
        "(void) addr;\n\t(void) length;\n\treturn 0;",
        "fds[i].revents = fds[i].events;",
    ] {
        if bridge_text.contains(banned) {
            bail!(
                "WASIX bridge {} reintroduced broad fake-success socket/fd behavior: {}",
                bridge.display(),
                banned.escape_debug()
            );
        }
    }
    if bridge_text.contains("return 123;") {
        bail!(
            "WASIX bridge {} reintroduced a magic successful-looking system() status",
            bridge.display()
        );
    }
    if !bridge_text.contains("pgl_system(const char *command)")
        || !bridge_text.contains("errno = ENOSYS;")
        || !bridge_text.contains("return -1;")
    {
        bail!(
            "WASIX bridge {} must fail unsupported system() calls closed with ENOSYS",
            bridge.display()
        );
    }
    let stub_analysis = Path::new("assets/wasix-build/analyze_pgl_stubs.sh");
    if !stub_analysis.exists() {
        bail!(
            "missing pgl_stubs link-symbol analysis script at {}",
            stub_analysis.display()
        );
    }
    let stub_analysis_text = fs::read_to_string(stub_analysis)
        .with_context(|| format!("read {}", stub_analysis.display()))?;
    for marker in [
        "Runtime link inputs requiring WASIX host ABI ownership",
        "Frontend tool inputs requiring frontend/common ownership",
        "do not by themselves justify adding symbols to the production WASIX bridge",
    ] {
        if !stub_analysis_text.contains(marker) {
            bail!(
                "{} must keep runtime pgl_stubs ownership separate from frontend tool symbols",
                stub_analysis.display()
            );
        }
    }
    check_wasix_bridge_abi_harness()?;
    for script in [
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgvector.sh",
        "assets/wasix-build/docker_pgtrgm.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ] {
        let text = fs::read_to_string(script).with_context(|| format!("read {script}"))?;
        if !text.contains(".pglite-oxide-bridge-sha256") {
            bail!("{script} must validate the WASIX bridge hash before reusing build outputs");
        }
    }
    let docker_pglite = fs::read_to_string("assets/wasix-build/docker_pglite.sh")
        .context("read assets/wasix-build/docker_pglite.sh")?;
    if !docker_pglite.contains("/usr/sbin/zic")
        || !docker_pglite.contains("src/timezone/compiled/UTC")
    {
        bail!(
            "docker_pglite.sh must compile pinned PostgreSQL timezone data inside the pinned Docker build"
        );
    }
    let docker_pgvector = fs::read_to_string("assets/wasix-build/docker_pgvector.sh")
        .context("read assets/wasix-build/docker_pgvector.sh")?;
    if !docker_pgvector.contains("-e PGVECTOR=\"$CONTAINER_PGVECTOR\"")
        || !docker_pgvector.contains("make -s -j\"$JOBS\" -C \"$PGVECTOR\"")
    {
        bail!("docker_pgvector.sh must build the pinned pgvector checkout via the PGVECTOR input");
    }

    let checkout = Path::new(POSTGRES_PGLITE_PATH);
    if !checkout.exists() {
        if strict_local {
            bail!("missing local checkout {}", checkout.display());
        }
        eprintln!("warning: local checkout {} is missing", checkout.display());
        return Ok(());
    }

    let head = command_output("git", &["rev-parse", "HEAD"], checkout)
        .with_context(|| format!("read HEAD for {}", checkout.display()))?;
    let branch = command_output("git", &["branch", "--show-current"], checkout)
        .unwrap_or_else(|_| String::from("<detached>"));
    if strict_local && head.trim() != postgres.commit {
        bail!(
            "local {} checkout is at {}, expected {} from assets/sources.toml",
            checkout.display(),
            head.trim(),
            postgres.commit
        );
    }
    if strict_local && branch.trim() != postgres.branch {
        bail!(
            "local {} checkout is on branch '{}', expected '{}'",
            checkout.display(),
            branch.trim(),
            postgres.branch
        );
    }
    if !strict_local && head.trim() != postgres.commit {
        eprintln!(
            "warning: local {} checkout is at {}, expected {}",
            checkout.display(),
            head.trim(),
            postgres.commit
        );
    }

    let status = command_output("git", &["status", "--porcelain"], checkout)
        .with_context(|| format!("read status for {}", checkout.display()))?;
    if strict_local && !status.trim().is_empty() {
        bail!(
            "local {} checkout has uncommitted changes; preserve them as a patch before strict asset builds",
            checkout.display()
        );
    }
    if !strict_local && !status.trim().is_empty() {
        eprintln!(
            "warning: local {} checkout has uncommitted changes",
            checkout.display()
        );
    }

    let pglite_build_checkout = Path::new(PGLITE_BUILD_PATH);
    if !pglite_build_checkout.exists() {
        if strict_local {
            bail!("missing local checkout {}", pglite_build_checkout.display());
        }
        eprintln!(
            "warning: local checkout {} is missing",
            pglite_build_checkout.display()
        );
    } else {
        let build_head = command_output("git", &["rev-parse", "HEAD"], pglite_build_checkout)
            .with_context(|| format!("read HEAD for {}", pglite_build_checkout.display()))?;
        let build_branch =
            command_output("git", &["branch", "--show-current"], pglite_build_checkout)
                .unwrap_or_else(|_| String::from("<detached>"));
        if strict_local && build_head.trim() != pglite_build.commit {
            bail!(
                "local {} checkout is at {}, expected {} from assets/sources.toml",
                pglite_build_checkout.display(),
                build_head.trim(),
                pglite_build.commit
            );
        }
        if !strict_local && build_head.trim() != pglite_build.commit {
            eprintln!(
                "warning: local {} checkout is at {}, expected {}",
                pglite_build_checkout.display(),
                build_head.trim(),
                pglite_build.commit
            );
        }
        if strict_local && build_branch.trim() != pglite_build.branch {
            bail!(
                "local {} checkout is on branch '{}', expected '{}'",
                pglite_build_checkout.display(),
                build_branch.trim(),
                pglite_build.branch
            );
        }
        let build_status = command_output("git", &["status", "--porcelain"], pglite_build_checkout)
            .with_context(|| format!("read status for {}", pglite_build_checkout.display()))?;
        if strict_local && !build_status.trim().is_empty() {
            bail!(
                "local {} checkout has uncommitted changes; preserve them before strict asset builds",
                pglite_build_checkout.display()
            );
        }
        if !strict_local && !build_status.trim().is_empty() {
            eprintln!(
                "warning: local {} checkout has uncommitted changes",
                pglite_build_checkout.display()
            );
        }

        ensure_file(&pglite_build_checkout.join("wasm-build/build-ext.sh"))?;
    }

    let required_upstream_markers = [
        ("build-pglite.sh", "-Dlongjmp=pgl_longjmp"),
        ("build-pglite.sh", "-Dsiglongjmp=pgl_siglongjmp"),
        ("build-pglite.sh", "-sSTACK_SIZE=8MB"),
        ("build-pglite.sh", "-sINITIAL_MEMORY=128MB"),
        ("pglite/src/pglitec/pglitec.c", "pgl_setPGliteActive"),
        ("pglite/src/pglitec/pglitec.c", "pgl_longjmp"),
        ("pglite/src/pglitec/pglitec.c", "pgl_run_atexit_funcs"),
        (
            "pglite/static/included.pglite.exports",
            "PostgresMainLongJmp",
        ),
        ("src/backend/tcop/postgres.c", "pgl_startPGlite"),
        ("src/backend/tcop/postgres.c", "PostgresMainLoopOnce"),
        ("src/backend/tcop/postgres.c", "PostgresMainLongJmp"),
        ("src/backend/tcop/backend_startup.c", "ProcessStartupPacket"),
    ];
    let mut missing_upstream_markers = Vec::new();
    for (relative, marker) in required_upstream_markers {
        let path = checkout.join(relative);
        let text = fs::read_to_string(&path).unwrap_or_default();
        if !text.contains(marker) {
            missing_upstream_markers.push(format!("{relative}:{marker}"));
        }
    }
    if !missing_upstream_markers.is_empty() {
        bail!(
            "local {} checkout is missing expected PGlite builder protocol/lifecycle markers: {}",
            checkout.display(),
            missing_upstream_markers.join(", ")
        );
    }

    if check_patch_applies {
        let patch_path =
            fs::canonicalize(patch).with_context(|| format!("canonicalize {}", patch.display()))?;
        let status = Command::new("git")
            .args(["apply", "--check", "--whitespace=nowarn"])
            .arg(&patch_path)
            .current_dir(checkout)
            .status()
            .with_context(|| format!("check whether {} applies", patch.display()))?;
        if !status.success() {
            bail!(
                "WASIX patch {} does not apply cleanly to {}; rebase it before Phase 1 is complete",
                patch.display(),
                checkout.display()
            );
        }
    }

    Ok(())
}

fn patch_adds_marker(patch_text: &str, marker: &str) -> bool {
    patch_text
        .lines()
        .any(|line| line.starts_with('+') && !line.starts_with("+++") && line.contains(marker))
}

#[cfg(unix)]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    let bridge = Path::new(WASIX_BRIDGE_PATH);
    let harness = Path::new("assets/wasix-build/wasix_shim/pglite_wasix_bridge_abi_test.c");
    if !harness.exists() {
        bail!("missing WASIX bridge ABI harness at {}", harness.display());
    }

    let out_dir = Path::new("target/xtask");
    fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let binary = out_dir.join("pglite_wasix_bridge_abi_test");
    let cc = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let status = Command::new(&cc)
        .args(["-std=c11", "-Wall", "-Wextra"])
        .arg(bridge)
        .arg(harness)
        .arg("-o")
        .arg(&binary)
        .status()
        .with_context(|| format!("compile WASIX bridge ABI harness with {cc}"))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness compilation failed with {status}");
    }
    let status = Command::new(&binary)
        .status()
        .with_context(|| format!("run {}", binary.display()))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness failed with {status}");
    }
    println!("WASIX bridge ABI harness passed");
    Ok(())
}

#[cfg(not(unix))]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    eprintln!("warning: skipping POSIX WASIX bridge ABI harness on non-Unix host");
    Ok(())
}

struct BuildOutputs {
    build_dir: PathBuf,
    source_dir: PathBuf,
    package_stage: PathBuf,
    modules: Vec<BuildModuleOutput>,
}

struct BuildModuleOutput {
    name: &'static str,
    kind: &'static str,
    path: PathBuf,
    aot_file: &'static str,
}

impl BuildOutputs {
    fn discover() -> Result<Self> {
        let build_dir = PathBuf::from(WASIX_DOCKER_BUILD_DIR);
        let source_dir = PathBuf::from(WASIX_PATCHED_SOURCE_DIR);
        let package_stage = PathBuf::from(WASIX_BUILD_ROOT).join("build/package-stage");
        let modules = vec![
            BuildModuleOutput {
                name: "runtime:pglite",
                kind: "runtime",
                path: build_dir.join("src/backend/pglite"),
                aot_file: "pglite-llvm-opta.bin.zst",
            },
            BuildModuleOutput {
                name: "runtime-support:plpgsql",
                kind: "runtime-support",
                path: build_dir.join("src/pl/plpgsql/src/plpgsql.so"),
                aot_file: "plpgsql-llvm-opta.bin.zst",
            },
            BuildModuleOutput {
                name: "runtime-support:dict_snowball",
                kind: "runtime-support",
                path: build_dir.join("src/backend/snowball/dict_snowball.so"),
                aot_file: "dict_snowball-llvm-opta.bin.zst",
            },
            BuildModuleOutput {
                name: "extension:vector",
                kind: "extension",
                path: PathBuf::from(PGVECTOR_BUILD_DIR).join("vector.so"),
                aot_file: "vector-llvm-opta.bin.zst",
            },
            BuildModuleOutput {
                name: "extension:pg_trgm",
                kind: "extension",
                path: build_dir.join("contrib/pg_trgm/pg_trgm.so"),
                aot_file: "pg_trgm-llvm-opta.bin.zst",
            },
            BuildModuleOutput {
                name: "tool:pg_dump",
                kind: "tool",
                path: build_dir.join("src/bin/pg_dump/pg_dump"),
                aot_file: "pg_dump-llvm-opta.bin.zst",
            },
        ];

        let outputs = Self {
            build_dir,
            source_dir,
            package_stage,
            modules,
        };
        outputs.ensure_required_files()?;
        Ok(outputs)
    }

    fn ensure_required_files(&self) -> Result<()> {
        for module in &self.modules {
            ensure_file(&module.path)?;
        }
        ensure_file(&self.build_dir.join("src/timezone/compiled/UTC"))?;
        ensure_file(
            &self
                .build_dir
                .join("src/backend/snowball/snowball_create.sql"),
        )?;
        Ok(())
    }

    fn module_path(&self, name: &str) -> Result<&Path> {
        self.modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| module.path.as_path())
            .ok_or_else(|| anyhow!("missing build output module {name}"))
    }

    fn write_manifest(&self) -> Result<()> {
        let manifest = BuildOutputManifestOut {
            format_version: 1,
            build_profile: fs::read_to_string(self.build_dir.join(".pglite-oxide-build-profile"))
                .context("read WASIX build profile signature")?,
            modules: self
                .modules
                .iter()
                .map(|module| {
                    Ok(BuildModuleManifestOut {
                        name: module.name.to_owned(),
                        kind: module.kind.to_owned(),
                        path: module.path.to_string_lossy().into_owned(),
                        sha256: sha256_file(&module.path)?,
                        link: read_wasm_link_metadata(&module.path)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        };
        for module in &manifest.modules {
            validate_module_link_metadata(module)?;
        }
        let text = serde_json::to_string_pretty(&manifest)
            .context("serialize WASIX build output manifest")?;
        let path = Path::new(WASIX_BUILD_MANIFEST_PATH);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
    }
}

fn validate_build_profile_outputs(outputs: &BuildOutputs, profile: &str) -> Result<()> {
    let signature_path = outputs.build_dir.join(".pglite-oxide-build-profile");
    let signature = fs::read_to_string(&signature_path)
        .with_context(|| format!("read {}", signature_path.display()))?;
    let profile_line = format!("profile={profile}");
    if !signature.lines().any(|line| line == profile_line) {
        bail!(
            "WASIX build profile signature does not match requested profile {profile}: {}",
            signature_path.display()
        );
    }

    if profile.starts_with("release") {
        let cflags = signature
            .lines()
            .find_map(|line| line.strip_prefix("cflags="))
            .unwrap_or_default();
        let has_release_opt = ["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| cflags.split_whitespace().any(|part| part == *flag));
        if !has_release_opt || !cflags.split_whitespace().any(|part| part == "-g0") {
            bail!(
                "release WASIX profile must include an optimizing -O flag and -g0; got cflags={cflags:?}"
            );
        }

        let makefile = outputs.build_dir.join("src/Makefile.global");
        let makefile_text = fs::read_to_string(&makefile)
            .with_context(|| format!("read {}", makefile.display()))?;
        if !["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| makefile_text.contains(flag))
        {
            bail!(
                "release WASIX build did not propagate optimization flags into {}",
                makefile.display()
            );
        }
    }

    Ok(())
}

fn validate_module_link_metadata(module: &BuildModuleManifestOut) -> Result<()> {
    if module.link.exports.is_empty() {
        bail!("{} has no WASM exports", module.name);
    }

    match module.kind.as_str() {
        "runtime" => {
            let required = [
                "_start",
                "pgl_setPGliteActive",
                "pgl_startPGlite",
                "pgl_getMyProcPort",
                "ProcessStartupPacket",
                "pgl_sendConnData",
                "pgl_pq_flush",
                "pq_buffer_remaining_data",
                "PostgresMainLoopOnce",
                "PostgresSendReadyForQueryIfNecessary",
                "PostgresMainLongJmp",
                "pgl_wasix_input_reset",
                "pgl_wasix_input_write",
                "pgl_wasix_input_available",
                "pgl_wasix_output_reset",
                "pgl_wasix_output_len",
                "pgl_wasix_output_read",
            ];
            let missing = required
                .iter()
                .copied()
                .filter(|export| !has_wasm_export(&module.link, export))
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                bail!(
                    "{} is missing required Rust/WASIX ABI exports: {}",
                    module.name,
                    missing.join(", ")
                );
            }
            for banned in ["pgl_initdb", "pgl_backend", "PostgresRecoverProtocolError"] {
                if has_wasm_export(&module.link, banned) {
                    bail!(
                        "{} exports legacy builder-branch lifecycle entrypoint {banned}",
                        module.name
                    );
                }
            }
        }
        "runtime-support" | "extension" => {
            if !module.link.has_dylink0 {
                bail!("{} is not a WASM dynamic-linking side module", module.name);
            }
            if module.link.imports.is_empty() && module.link.dylink_imports.is_empty() {
                bail!(
                    "{} has no imports; side-module linkage is suspicious",
                    module.name
                );
            }
        }
        "tool" => {}
        other => bail!("{} has unknown build output kind {other}", module.name),
    }

    Ok(())
}

fn validate_build_output_link_closure(outputs: &BuildOutputs) -> Result<()> {
    let runtime = outputs
        .modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_link = read_wasm_link_metadata(&runtime.path)?;
    let runtime_exports = runtime_link
        .exports
        .iter()
        .flat_map(|export| {
            let name = export.name.trim_start_matches('_').to_owned();
            [export.name.clone(), name]
        })
        .collect::<HashSet<_>>();

    let mut failures = Vec::new();
    for module in outputs
        .modules
        .iter()
        .filter(|module| matches!(module.kind, "runtime-support" | "extension"))
    {
        let link = read_wasm_link_metadata(&module.path)?;
        for import in &link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            let normalized = import.name.trim_start_matches('_');
            if !runtime_exports.contains(import.name.as_str())
                && !runtime_exports.contains(normalized)
            {
                failures.push(format!(
                    "{} imports {}.{}",
                    module.name, import.module, import.name
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!(
            "WASIX dynamic-link closure has unresolved side-module imports: {}",
            failures.join(", ")
        );
    }
    Ok(())
}

fn import_should_resolve_from_runtime(import: &WasmImportOut) -> bool {
    match import.module.as_str() {
        "env" | "GOT.func" | "GOT.mem" => !matches!(
            import.name.as_str(),
            "__indirect_function_table"
                | "__memory_base"
                | "__stack_pointer"
                | "__table_base"
                | "memory"
        ),
        _ => false,
    }
}

fn has_wasm_export(link: &WasmLinkMetadataOut, name: &str) -> bool {
    link.exports
        .iter()
        .any(|export| export.name == name || export.name == format!("_{name}"))
}

fn build_asset_spine(
    _manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    let execute = args.iter().any(|arg| arg == "--execute")
        || env::var("PGLITE_OXIDE_EXECUTE_ASSET_BUILD").as_deref() == Ok("1");

    println!("asset build inputs validated");
    println!("profile={profile}");
    println!("target-triple={target}");

    let commands = [
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgvector.sh",
        "assets/wasix-build/docker_pgtrgm.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ];

    if !execute {
        println!("source-spine build is ready but not executed by default");
        println!("run with --execute or PGLITE_OXIDE_EXECUTE_ASSET_BUILD=1 to invoke:");
        for command in commands {
            println!("  {command}");
        }
        println!("follow with `assets package` and `assets aot` to refresh publishable artifacts");
        return Ok(());
    }

    for script in commands {
        let mut command = Command::new("bash");
        command
            .arg(script)
            .env("PGLITE_OXIDE_BUILD_PROFILE", profile);
        run_command(&mut command)?;
    }

    let outputs = BuildOutputs::discover()?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    println!("wrote WASIX build output manifest to {WASIX_BUILD_MANIFEST_PATH}");
    Ok(())
}

fn release_build_assets(
    manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    if args.iter().any(|arg| arg == "--fetch") {
        fetch_pinned_sources(manifest)?;
    }

    let mut build_args = vec![
        "build".to_owned(),
        "--profile".to_owned(),
        profile.to_owned(),
        "--target-triple".to_owned(),
        target.to_owned(),
        "--execute".to_owned(),
    ];
    build_args.extend(
        args.iter()
            .filter(|arg| {
                matches!(
                    arg.as_str(),
                    "--skip-build" | "--skip-aot" | "--skip-package-size"
                )
            })
            .cloned(),
    );

    if !args.iter().any(|arg| arg == "--skip-build") {
        build_asset_spine(manifest, profile, target, &build_args)?;
    } else {
        eprintln!("warning: skipping WASIX rebuild by request");
    }

    let outputs = BuildOutputs::discover()?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;

    if !args.iter().any(|arg| arg == "--skip-aot") {
        generate_aot_artifacts(target)?;
    } else {
        eprintln!("warning: skipping AOT generation by request");
    }

    package_assets(manifest, target)?;
    check_canonical_asset_layout(true)?;
    check_generated_manifest(manifest, true)?;
    check_aot_package_manifest(target)?;

    if !args.iter().any(|arg| arg == "--skip-package-size") {
        package_size(vec!["--enforce".to_owned()])?;
    }

    Ok(())
}

fn generate_aot_artifacts(target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover()?;
    let source_dir = Path::new("assets/wasix-build/build/aot").join(target);
    fs::create_dir_all(&source_dir).with_context(|| format!("create {}", source_dir.display()))?;

    for module in &outputs.modules {
        let output = source_dir.join(module.aot_file);
        generate_one_aot_artifact(&module.path, &output)?;
    }
    Ok(())
}

fn generate_one_aot_artifact(input: &Path, output: &Path) -> Result<()> {
    ensure_file(input)?;
    let input =
        fs::canonicalize(input).with_context(|| format!("canonicalize {}", input.display()))?;
    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        env::current_dir()
            .context("read current directory")?
            .join(output)
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut command = Command::new("cargo");
    command
        .args([
            "run",
            "--release",
            "--features",
            "llvm-engine",
            "--bin",
            "serialize_aot",
            "--",
            "--input",
        ])
        .arg(&input)
        .arg("--output")
        .arg(output)
        .args(["--engine", "llvm"])
        .current_dir("spikes/wasmer-wasix-eval");
    if env::var_os("LLVM_SYS_221_PREFIX").is_none() && Path::new("/opt/homebrew/opt/llvm").exists()
    {
        command.env("LLVM_SYS_221_PREFIX", "/opt/homebrew/opt/llvm");
    }
    run_command(&mut command)
        .with_context(|| format!("generate AOT artifact for {}", input.display()))
}

fn package_assets(manifest: &SourcesManifest, target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover()?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    let build = &outputs.build_dir;
    let source = &outputs.source_dir;
    let stage = &outputs.package_stage;

    if stage.exists() {
        fs::remove_dir_all(stage).with_context(|| format!("remove {}", stage.display()))?;
    }
    fs::create_dir_all(stage).with_context(|| format!("create {}", stage.display()))?;

    let runtime_stage = stage.join("runtime/pglite");
    stage_runtime_tree(build, source, &runtime_stage)?;
    let runtime_archive = Path::new("crates/assets/assets/pglite.wasix.tar.zst");
    deterministic_tar_zst(&runtime_stage, Path::new("pglite"), runtime_archive)?;

    let pg_dump = Path::new("crates/assets/assets/bin/pg_dump.wasix.wasm");
    copy_file(outputs.module_path("tool:pg_dump")?, pg_dump)?;

    let vector_stage = stage.join("extensions/vector");
    stage_vector_extension(&vector_stage)?;
    let vector_archive = Path::new("crates/assets/assets/extensions/vector.tar.zst");
    deterministic_tar_zst(&vector_stage, Path::new(""), vector_archive)?;

    let pg_trgm_stage = stage.join("extensions/pg_trgm");
    stage_pg_trgm_extension(source, build, &pg_trgm_stage)?;
    let pg_trgm_archive = Path::new("crates/assets/assets/extensions/pg_trgm.tar.zst");
    deterministic_tar_zst(&pg_trgm_stage, Path::new(""), pg_trgm_archive)?;

    package_aot_artifacts(target, &outputs, manifest)?;
    write_asset_manifest(
        manifest,
        outputs.module_path("runtime:pglite")?,
        runtime_archive,
        pg_dump,
        &[
            BinaryPackage {
                name: "plpgsql",
                path: outputs.module_path("runtime-support:plpgsql")?,
                runtime_path: "lib/postgresql/plpgsql.so",
            },
            BinaryPackage {
                name: "dict_snowball",
                path: outputs.module_path("runtime-support:dict_snowball")?,
                runtime_path: "lib/postgresql/dict_snowball.so",
            },
        ],
        &[
            ExtensionPackage {
                name: "pgvector",
                sql_name: "vector",
                archive: "extensions/vector.tar.zst",
                path: vector_archive,
                module_path: outputs.module_path("extension:vector")?,
                stable: true,
            },
            ExtensionPackage {
                name: "pg_trgm",
                sql_name: "pg_trgm",
                archive: "extensions/pg_trgm.tar.zst",
                path: pg_trgm_archive,
                module_path: outputs.module_path("extension:pg_trgm")?,
                stable: true,
            },
        ],
    )?;
    update_pgdata_template_manifest(outputs.module_path("runtime:pglite")?)?;

    println!("packaged runtime assets into crates/assets/assets");
    println!("packaged {target} AOT artifacts when present");
    Ok(())
}

fn stage_runtime_tree(build: &Path, source: &Path, runtime: &Path) -> Result<()> {
    let bin = runtime.join("bin");
    let lib = runtime.join("lib/postgresql");
    let share = runtime.join("share/postgresql");
    fs::create_dir_all(&bin).with_context(|| format!("create {}", bin.display()))?;
    fs::create_dir_all(&lib).with_context(|| format!("create {}", lib.display()))?;
    fs::create_dir_all(&share).with_context(|| format!("create {}", share.display()))?;

    copy_file(&build.join("src/backend/pglite"), &bin.join("pglite"))?;
    copy_file(&build.join("src/bin/pg_dump/pg_dump"), &bin.join("pg_dump"))?;
    fs::write(bin.join("postgres"), [])
        .with_context(|| format!("write {}", bin.join("postgres").display()))?;
    fs::write(bin.join("initdb"), [])
        .with_context(|| format!("write {}", bin.join("initdb").display()))?;
    fs::write(runtime.join("password"), b"password\n")
        .with_context(|| format!("write {}", runtime.join("password").display()))?;

    copy_file(
        &build.join("src/include/catalog/postgres.bki"),
        &share.join("postgres.bki"),
    )?;
    copy_file(
        &build.join("src/include/catalog/system_constraints.sql"),
        &share.join("system_constraints.sql"),
    )?;
    for relative in [
        "src/backend/catalog/system_functions.sql",
        "src/backend/catalog/system_views.sql",
        "src/backend/catalog/information_schema.sql",
        "src/backend/catalog/sql_features.txt",
        "src/backend/libpq/pg_hba.conf.sample",
        "src/backend/libpq/pg_ident.conf.sample",
        "src/backend/utils/misc/postgresql.conf.sample",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &share.join(file_name))?;
    }

    copy_file(
        &build.join("src/backend/snowball/snowball_create.sql"),
        &share.join("snowball_create.sql"),
    )?;
    copy_file(
        &build.join("src/backend/snowball/dict_snowball.so"),
        &lib.join("dict_snowball.so"),
    )?;
    copy_file(
        &build.join("src/pl/plpgsql/src/plpgsql.so"),
        &lib.join("plpgsql.so"),
    )?;

    let extension_dir = share.join("extension");
    fs::create_dir_all(&extension_dir)
        .with_context(|| format!("create {}", extension_dir.display()))?;
    for relative in [
        "src/pl/plpgsql/src/plpgsql.control",
        "src/pl/plpgsql/src/plpgsql--1.0.sql",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &extension_dir.join(file_name))?;
    }

    copy_tree_filtered(
        &source.join("src/backend/tsearch/dicts"),
        &share.join("tsearch_data"),
        None,
    )?;
    copy_tree_filtered(
        &source.join("src/timezone/tznames"),
        &share.join("timezonesets"),
        Some(&["Makefile", "meson.build", "README"]),
    )?;
    stage_timezone_database(source, build, &share)?;
    Ok(())
}

fn stage_timezone_database(source: &Path, build: &Path, share: &Path) -> Result<()> {
    let tzdata = source.join("src/timezone/data/tzdata.zi");
    ensure_file(&tzdata)?;
    let compiled_timezone_dir = build.join("src/timezone/compiled");

    let timezone_dir = share.join("timezone");
    if timezone_dir.exists() {
        fs::remove_dir_all(&timezone_dir)
            .with_context(|| format!("remove {}", timezone_dir.display()))?;
    }
    fs::create_dir_all(&timezone_dir)
        .with_context(|| format!("create {}", timezone_dir.display()))?;
    copy_tree_filtered(&compiled_timezone_dir, &timezone_dir, None).with_context(|| {
        format!(
            "copy compiled PostgreSQL timezone database from {}",
            compiled_timezone_dir.display()
        )
    })?;

    for required in ["UTC", "GMT", "Etc/UTC", "America/New_York"] {
        let path = timezone_dir.join(required);
        if !path.is_file() {
            bail!(
                "compiled PostgreSQL timezone database is missing required zone {}",
                path.display()
            );
        }
    }
    Ok(())
}

fn stage_vector_extension(stage: &Path) -> Result<()> {
    let source = Path::new(PGVECTOR_BUILD_DIR);
    fs::create_dir_all(stage.join("lib/postgresql"))
        .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
    fs::create_dir_all(stage.join("share/postgresql/extension")).with_context(|| {
        format!(
            "create {}",
            stage.join("share/postgresql/extension").display()
        )
    })?;
    copy_file(
        &source.join("vector.so"),
        &stage.join("lib/postgresql/vector.so"),
    )?;
    copy_file(
        &source.join("vector.control"),
        &stage.join("share/postgresql/extension/vector.control"),
    )?;
    for entry in sorted_files(&source.join("sql"))? {
        let file_name = entry
            .file_name()
            .ok_or_else(|| anyhow!("SQL file has no name: {}", entry.display()))?;
        copy_file(
            &entry,
            &stage.join("share/postgresql/extension").join(file_name),
        )?;
    }
    Ok(())
}

fn stage_pg_trgm_extension(source: &Path, build: &Path, stage: &Path) -> Result<()> {
    let extension_source = source.join("contrib/pg_trgm");
    fs::create_dir_all(stage.join("lib/postgresql"))
        .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
    fs::create_dir_all(stage.join("share/postgresql/extension")).with_context(|| {
        format!(
            "create {}",
            stage.join("share/postgresql/extension").display()
        )
    })?;
    copy_file(
        &build.join("contrib/pg_trgm/pg_trgm.so"),
        &stage.join("lib/postgresql/pg_trgm.so"),
    )?;
    copy_file(
        &extension_source.join("pg_trgm.control"),
        &stage.join("share/postgresql/extension/pg_trgm.control"),
    )?;
    for entry in sorted_files(&extension_source)? {
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("pg_trgm--") && name.ends_with(".sql") {
            copy_file(&entry, &stage.join("share/postgresql/extension").join(name))?;
        }
    }
    Ok(())
}

fn package_aot_artifacts(
    target: &str,
    outputs: &BuildOutputs,
    sources: &SourcesManifest,
) -> Result<()> {
    let source_dir = Path::new("assets/wasix-build/build/aot").join(target);
    if !source_dir.exists() {
        eprintln!(
            "warning: AOT source directory {} is missing; skipping AOT packaging",
            source_dir.display()
        );
        return Ok(());
    }

    let crate_dir = Path::new("crates/aot").join(target);
    let artifacts_dir = crate_dir.join("artifacts");
    fs::create_dir_all(&artifacts_dir)
        .with_context(|| format!("create {}", artifacts_dir.display()))?;

    let artifacts = [
        ("runtime:pglite", "pglite-llvm-opta.bin.zst"),
        ("runtime-support:plpgsql", "plpgsql-llvm-opta.bin.zst"),
        (
            "runtime-support:dict_snowball",
            "dict_snowball-llvm-opta.bin.zst",
        ),
        ("extension:vector", "vector-llvm-opta.bin.zst"),
        ("extension:pg_trgm", "pg_trgm-llvm-opta.bin.zst"),
        ("tool:pg_dump", "pg_dump-llvm-opta.bin.zst"),
    ];
    let mut manifest_artifacts = Vec::new();
    for (name, file) in artifacts {
        let source = source_dir.join(file);
        if !source.exists() {
            eprintln!("warning: missing AOT artifact {}", source.display());
            continue;
        }
        let destination = artifacts_dir.join(file);
        copy_file(&source, &destination)?;
        let raw_artifact = decode_zstd_file(&destination)
            .with_context(|| format!("decode AOT artifact {}", destination.display()))?;
        let module_sha256 = outputs
            .modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| sha256_file(&module.path))
            .transpose()?
            .ok_or_else(|| anyhow!("missing build output module {name} for AOT manifest"))?;
        manifest_artifacts.push(AotManifestArtifact {
            name: name.to_owned(),
            path: format!("artifacts/{file}"),
            sha256: sha256_file(&destination)?,
            raw_sha256: sha256_bytes(&raw_artifact),
            raw_size: raw_artifact.len() as u64,
            module_sha256,
            compressed: true,
        });
    }

    let manifest = AotManifest {
        format_version: 1,
        target_triple: target.to_owned(),
        engine: "llvm-opta".to_owned(),
        wasmer_version: sources.toolchain.wasmer.clone(),
        wasmer_wasix_version: sources.toolchain.wasmer_wasix.clone(),
        artifacts: manifest_artifacts,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).context("serialize AOT manifest")?;
    fs::write(
        artifacts_dir.join("manifest.json"),
        format!("{manifest_json}\n"),
    )
    .with_context(|| format!("write {}", artifacts_dir.join("manifest.json").display()))?;
    write_aot_lib(&crate_dir.join("src/lib.rs"), target, &manifest_json)?;
    Ok(())
}

fn write_aot_lib(path: &Path, target: &str, manifest_json: &str) -> Result<()> {
    let manifest: AotManifest =
        serde_json::from_str(manifest_json).context("parse generated AOT manifest")?;
    let mut cases = String::new();
    for artifact in &manifest.artifacts {
        let file = artifact
            .path
            .strip_prefix("artifacts/")
            .ok_or_else(|| anyhow!("AOT artifact path must start with artifacts/"))?;
        let one_line = format!(
            "        {:?} => Some(include_bytes!(\"../artifacts/{}\")),\n",
            artifact.name, file
        );
        if one_line.trim_end().len() <= 100 {
            cases.push_str(&one_line);
        } else {
            cases.push_str(&format!(
                "        {:?} => Some(include_bytes!(\n            \"../artifacts/{}\"\n        )),\n",
                artifact.name, file
            ));
        }
    }
    if cases.is_empty() {
        cases.push_str("        _ => None,\n");
    } else {
        cases.push_str("        _ => None,\n");
    }

    let text = format!(
        "#![deny(unsafe_code)]\n\npub const TARGET_TRIPLE: &str = {:?};\npub const ENGINE: &str = \"llvm-opta\";\npub const MANIFEST_JSON: &str = include_str!(\"../artifacts/manifest.json\");\n\npub fn artifact_bytes(name: &str) -> Option<&'static [u8]> {{\n    match name {{\n{}    }}\n}}\n",
        target, cases
    );
    fs::write(path, text).with_context(|| format!("write {}", path.display()))
}

fn check_aot_package_manifest(target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover()?;
    let crate_dir = Path::new("crates/aot").join(target);
    let manifest_path = crate_dir.join("artifacts/manifest.json");
    ensure_file(&manifest_path)?;
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    ensure_eq(
        &manifest.target_triple,
        target,
        "AOT manifest target-triple",
    )?;
    ensure_eq(&manifest.engine, "llvm-opta", "AOT manifest engine")?;
    ensure_eq(
        &manifest.wasmer_version,
        "7.2.0-alpha.2",
        "AOT manifest wasmer-version",
    )?;
    ensure_eq(
        &manifest.wasmer_wasix_version,
        "0.702.0-alpha.2",
        "AOT manifest wasmer-wasix-version",
    )?;

    for artifact in &manifest.artifacts {
        let path = crate_dir.join(&artifact.path);
        ensure_file(&path)?;
        let actual_hash = sha256_file(&path)?;
        ensure_eq(
            &actual_hash,
            &artifact.sha256,
            &format!("AOT artifact {} sha256", artifact.name),
        )?;
        if artifact.compressed {
            let raw = decode_zstd_file(&path)
                .with_context(|| format!("decode AOT artifact {}", path.display()))?;
            ensure_eq(
                &sha256_bytes(&raw),
                &artifact.raw_sha256,
                &format!("AOT artifact {} raw sha256", artifact.name),
            )?;
            let actual_raw_size = raw.len() as u64;
            if actual_raw_size != artifact.raw_size {
                bail!(
                    "AOT artifact {} raw size mismatch: expected {} got {}",
                    artifact.name,
                    artifact.raw_size,
                    actual_raw_size
                );
            }
        }
        let module = outputs
            .modules
            .iter()
            .find(|module| module.name == artifact.name)
            .ok_or_else(|| anyhow!("AOT manifest references unknown module {}", artifact.name))?;
        let module_hash = sha256_file(&module.path)?;
        ensure_eq(
            &module_hash,
            &artifact.module_sha256,
            &format!("AOT artifact {} source module sha256", artifact.name),
        )?;
    }
    Ok(())
}

fn write_asset_manifest(
    sources: &SourcesManifest,
    runtime_module: &Path,
    runtime_archive: &Path,
    pg_dump: &Path,
    runtime_support: &[BinaryPackage<'_>],
    extensions: &[ExtensionPackage<'_>],
) -> Result<()> {
    let manifest = AssetManifestOut {
        format_version: 1,
        runtime: RuntimeAssetOut {
            archive: "pglite.wasix.tar.zst".to_owned(),
            sha256: sha256_file(runtime_archive)?,
            module_sha256: sha256_file(runtime_module)?,
            postgres_version: "17.5".to_owned(),
            runtime_kind: "wasix-dynamic-main".to_owned(),
            link: read_wasm_link_metadata(runtime_module)?,
        },
        runtime_support: runtime_support
            .iter()
            .map(|module| {
                Ok(BinaryAssetOut {
                    name: module.name.to_owned(),
                    path: module.runtime_path.to_owned(),
                    sha256: sha256_file(module.path)?,
                    module_sha256: sha256_file(module.path)?,
                    size: fs::metadata(module.path)
                        .with_context(|| format!("metadata {}", module.path.display()))?
                        .len(),
                    link: read_wasm_link_metadata(module.path)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        pg_dump: Some(BinaryAssetOut {
            name: "pg_dump".to_owned(),
            path: "bin/pg_dump.wasix.wasm".to_owned(),
            sha256: sha256_file(pg_dump)?,
            module_sha256: sha256_file(pg_dump)?,
            size: fs::metadata(pg_dump)
                .with_context(|| format!("metadata {}", pg_dump.display()))?
                .len(),
            link: read_wasm_link_metadata(pg_dump)?,
        }),
        extensions: extensions
            .iter()
            .map(|extension| {
                Ok(ExtensionAssetOut {
                    name: extension.name.to_owned(),
                    sql_name: extension.sql_name.to_owned(),
                    archive: extension.archive.to_owned(),
                    sha256: sha256_file(extension.path)?,
                    module_sha256: sha256_file(extension.module_path)?,
                    size: fs::metadata(extension.path)
                        .with_context(|| format!("metadata {}", extension.path.display()))?
                        .len(),
                    stable: extension.stable,
                    link: read_wasm_link_metadata(extension.module_path)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        sources: sources.sources.clone(),
    };

    let text = serde_json::to_string_pretty(&manifest).context("serialize asset manifest")?;
    fs::write("crates/assets/assets/manifest.json", format!("{text}\n"))
        .context("write crates/assets/assets/manifest.json")?;
    update_root_asset_metadata(&manifest, &sha256_file(runtime_module)?)
}

fn update_pgdata_template_manifest(runtime_module: &Path) -> Result<()> {
    let manifest_path = Path::new("crates/assets/assets/prepopulated/pgdata-template.json");
    if !manifest_path.exists() {
        eprintln!(
            "warning: PGDATA template manifest {} is missing",
            manifest_path.display()
        );
        return Ok(());
    }
    let text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    manifest["wasmSha256"] = serde_json::Value::String(sha256_file(runtime_module)?);
    let archive = fs::read("crates/assets/assets/prepopulated/pgdata-template.tar.zst")
        .context("read embedded PGDATA template archive")?;
    manifest["archiveSha256"] = serde_json::Value::String(sha256_bytes(&archive));
    let output =
        serde_json::to_string_pretty(&manifest).context("serialize PGDATA template manifest")?;
    fs::write(manifest_path, format!("{output}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))
}

fn update_root_asset_metadata(
    manifest: &AssetManifestOut,
    runtime_module_sha256: &str,
) -> Result<()> {
    let path = Path::new("Cargo.toml");
    let mut text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    text = replace_metadata_value(text, "runtime-archive-sha256", &manifest.runtime.sha256);
    text = replace_metadata_value(text, "pglite-wasix-sha256", runtime_module_sha256);
    let pgdata_template = Path::new("crates/assets/assets/prepopulated/pgdata-template.tar.zst");
    if pgdata_template.exists() {
        text = replace_metadata_value(
            text,
            "pgdata-template-archive-sha256",
            &sha256_file(pgdata_template)?,
        );
    }
    if let Some(pg_dump) = &manifest.pg_dump {
        text = replace_metadata_value(text, "pg-dump-wasix-sha256", &pg_dump.sha256);
    }
    fs::write(path, text).with_context(|| format!("write {}", path.display()))
}

fn replace_metadata_value(mut text: String, key: &str, value: &str) -> String {
    let needle = format!("{key} = \"");
    let Some(start) = text.find(&needle) else {
        eprintln!("warning: Cargo.toml metadata key '{key}' is missing; not updating it");
        return text;
    };
    let value_start = start + needle.len();
    let Some(relative_end) = text[value_start..].find('"') else {
        return text;
    };
    text.replace_range(value_start..value_start + relative_end, value);
    text
}

fn deterministic_tar_zst(source_root: &Path, archive_root: &Path, output: &Path) -> Result<()> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    let encoder =
        ZstdEncoder::new(file, 19).with_context(|| format!("create zstd {}", output.display()))?;
    let mut builder = tar::Builder::new(encoder);
    append_tree(&mut builder, source_root, source_root, archive_root)?;
    let encoder = builder.into_inner().context("finish tar stream")?;
    encoder
        .finish()
        .with_context(|| format!("finish {}", output.display()))?;
    Ok(())
}

fn append_tree<W: io::Write>(
    builder: &mut tar::Builder<W>,
    root: &Path,
    current: &Path,
    archive_root: &Path,
) -> Result<()> {
    let relative = current
        .strip_prefix(root)
        .with_context(|| format!("strip {} from {}", root.display(), current.display()))?;
    let archive_path = if relative.as_os_str().is_empty() {
        archive_root.to_path_buf()
    } else {
        archive_root.join(relative)
    };

    if !archive_path.as_os_str().is_empty() {
        let mut header = tar::Header::new_gnu();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_username("root").ok();
        header.set_groupname("root").ok();
        if current.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, io::empty())
                .with_context(|| format!("append directory {}", archive_path.display()))?;
        } else if current.is_file() {
            let bytes = fs::read(current).with_context(|| format!("read {}", current.display()))?;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(if is_executable(current) { 0o755 } else { 0o644 });
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, bytes.as_slice())
                .with_context(|| format!("append file {}", archive_path.display()))?;
        }
    }

    if current.is_dir() {
        for child in sorted_children(current)? {
            append_tree(builder, root, &child, archive_root)?;
        }
    }
    Ok(())
}

fn copy_tree_filtered(
    source: &Path,
    destination: &Path,
    skip_names: Option<&[&str]>,
) -> Result<()> {
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in sorted_files(source)? {
        let relative = entry
            .strip_prefix(source)
            .with_context(|| format!("strip {} from {}", source.display(), entry.display()))?;
        if let Some(file_name) = relative.file_name().and_then(|name| name.to_str()) {
            if skip_names
                .map(|names| names.iter().any(|skip| *skip == file_name))
                .unwrap_or(false)
            {
                continue;
            }
        }
        copy_file(&entry, &destination.join(relative))?;
    }
    Ok(())
}

fn sorted_children(path: &Path) -> Result<Vec<PathBuf>> {
    let mut children = fs::read_dir(path)
        .with_context(|| format!("read directory {}", path.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("read child in {}", path.display()))?;
    children.sort();
    Ok(children)
}

fn sorted_files(path: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.with_context(|| format!("walk {}", path.display()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    ensure_file(source)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::copy(source, destination)
        .with_context(|| format!("copy {} -> {}", source.display(), destination.display()))?;
    Ok(())
}

fn ensure_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!("expected file missing: {}", path.display());
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(sha256_bytes(&bytes))
}

fn decode_zstd_file(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", path.display()))?;
    let mut raw = Vec::new();
    io::copy(&mut decoder, &mut raw).with_context(|| format!("decompress {}", path.display()))?;
    Ok(raw)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn read_wasm_link_metadata(path: &Path) -> Result<WasmLinkMetadataOut> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut metadata = WasmLinkMetadataOut {
        has_dylink0: false,
        dylink_needed: Vec::new(),
        dylink_runtime_paths: Vec::new(),
        dylink_memory: None,
        dylink_imports: Vec::new(),
        dylink_exports: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        memories: Vec::new(),
    };

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.with_context(|| format!("parse {}", path.display()))? {
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import =
                        import.with_context(|| format!("read import from {}", path.display()))?;
                    metadata.imports.push(WasmImportOut {
                        module: import.module.to_owned(),
                        name: import.name.to_owned(),
                        kind: type_ref_kind(import.ty).to_owned(),
                    });
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export =
                        export.with_context(|| format!("read export from {}", path.display()))?;
                    metadata.exports.push(WasmExportOut {
                        name: export.name.to_owned(),
                        kind: external_kind_name(export.kind).to_owned(),
                    });
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory =
                        memory.with_context(|| format!("read memory from {}", path.display()))?;
                    metadata.memories.push(wasm_memory_out(memory));
                }
            }
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                metadata.has_dylink0 = true;
                let KnownCustom::Dylink0(reader) = section.as_known() else {
                    bail!("{} contains an unreadable dylink.0 section", path.display());
                };
                for subsection in reader {
                    match subsection
                        .with_context(|| format!("read dylink.0 from {}", path.display()))?
                    {
                        Dylink0Subsection::MemInfo(info) => {
                            metadata.dylink_memory = Some(WasmDylinkMemoryOut {
                                memory_size: info.memory_size,
                                memory_alignment: info.memory_alignment,
                                table_size: info.table_size,
                                table_alignment: info.table_alignment,
                            });
                        }
                        Dylink0Subsection::Needed(needed) => {
                            metadata
                                .dylink_needed
                                .extend(needed.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::RuntimePath(paths) => {
                            metadata
                                .dylink_runtime_paths
                                .extend(paths.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::ImportInfo(imports) => {
                            metadata
                                .dylink_imports
                                .extend(imports.into_iter().map(|import| WasmDylinkSymbolOut {
                                    module: Some(import.module.to_owned()),
                                    name: import.field.to_owned(),
                                    flags: import.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::ExportInfo(exports) => {
                            metadata
                                .dylink_exports
                                .extend(exports.into_iter().map(|export| WasmDylinkSymbolOut {
                                    module: None,
                                    name: export.name.to_owned(),
                                    flags: export.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::Unknown { .. } => {}
                    }
                }
            }
            _ => {}
        }
    }

    metadata.dylink_needed.sort();
    metadata.dylink_needed.dedup();
    metadata.dylink_runtime_paths.sort();
    metadata.dylink_runtime_paths.dedup();
    metadata.dylink_imports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.dylink_exports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.imports.sort_by(|left, right| {
        (left.module.as_str(), left.name.as_str(), left.kind.as_str()).cmp(&(
            right.module.as_str(),
            right.name.as_str(),
            right.kind.as_str(),
        ))
    });
    metadata.exports.sort_by(|left, right| {
        (left.name.as_str(), left.kind.as_str()).cmp(&(right.name.as_str(), right.kind.as_str()))
    });
    metadata.memories.sort_by(|left, right| {
        (
            left.initial_pages,
            left.maximum_pages,
            left.memory64,
            left.shared,
            left.page_size_log2,
        )
            .cmp(&(
                right.initial_pages,
                right.maximum_pages,
                right.memory64,
                right.shared,
                right.page_size_log2,
            ))
    });

    Ok(metadata)
}

fn type_ref_kind(ty: TypeRef) -> &'static str {
    match ty {
        TypeRef::Func(_) | TypeRef::FuncExact(_) => "func",
        TypeRef::Table(_) => "table",
        TypeRef::Memory(_) => "memory",
        TypeRef::Global(_) => "global",
        TypeRef::Tag(_) => "tag",
    }
}

fn external_kind_name(kind: ExternalKind) -> &'static str {
    match kind {
        ExternalKind::Func | ExternalKind::FuncExact => "func",
        ExternalKind::Table => "table",
        ExternalKind::Memory => "memory",
        ExternalKind::Global => "global",
        ExternalKind::Tag => "tag",
    }
}

fn wasm_memory_out(memory: wasmparser::MemoryType) -> WasmMemoryOut {
    WasmMemoryOut {
        initial_pages: memory.initial,
        maximum_pages: memory.maximum,
        memory64: memory.memory64,
        shared: memory.shared,
        page_size_log2: memory.page_size_log2,
    }
}

fn host_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "x86_64-apple-darwin";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unsupported"
}

fn source_by_name<'a>(manifest: &'a SourcesManifest, name: &str) -> Result<&'a SourcePin> {
    manifest
        .sources
        .iter()
        .find(|source| source.name == name)
        .ok_or_else(|| anyhow!("assets/sources.toml is missing source '{name}'"))
}

fn ensure_eq(actual: &str, expected: &str, field: &str) -> Result<()> {
    if actual != expected {
        bail!("{field} must be '{expected}', got '{actual}'");
    }
    Ok(())
}

fn ensure_contains(values: &[String], expected: &str, field: &str) -> Result<()> {
    if !values.iter().any(|value| value == expected) {
        bail!("{field} must contain '{expected}'");
    }
    Ok(())
}

fn ensure_no_flag_contains(values: &[String], forbidden: &str, field: &str) -> Result<()> {
    let forbidden_lower = forbidden.to_ascii_lowercase();
    if let Some(value) = values
        .iter()
        .find(|value| value.to_ascii_lowercase().contains(&forbidden_lower))
    {
        bail!("{field} must not contain '{forbidden}', got '{value}'");
    }
    Ok(())
}

fn command_output(command: &str, args: &[&str], cwd: &Path) -> Result<String> {
    let output = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stderr(Stdio::inherit())
        .output()
        .map_err(|err| anyhow!("failed to spawn {command}: {err}"))?;
    if !output.status.success() {
        bail!("{command} {} failed with {}", args.join(" "), output.status);
    }
    String::from_utf8(output.stdout).context("command output was not valid UTF-8")
}

fn now_micros() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX_EPOCH")?
        .as_micros())
}

fn value_after<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn run(command: &str, args: &[&str]) -> Result<()> {
    let mut command = Command::new(command);
    command.args(args);
    run_command(&mut command)
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

fn print_usage() {
    eprintln!("usage:");
    eprintln!("  cargo run -p xtask -- assets check [--strict-local] [--strict-generated]");
    eprintln!("  cargo run -p xtask -- assets audit-upstream [--strict]");
    eprintln!("  cargo run -p xtask -- assets source-spine [--check-patch-applies]");
    eprintln!("  cargo run -p xtask -- assets fetch");
    eprintln!(
        "  cargo run -p xtask -- assets build --profile release-o3 --target-triple <triple> [--execute]"
    );
    eprintln!(
        "  cargo run -p xtask -- assets release-build --profile release-o3 --target-triple <triple> [--fetch]"
    );
    eprintln!("  cargo run -p xtask -- assets aot --target-triple <triple>");
    eprintln!("  cargo run -p xtask -- assets package [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets smoke");
    eprintln!("  cargo run -p xtask -- package-size --enforce");
    eprintln!("  cargo run -p xtask -- perf cold [--reset-cache]");
    eprintln!("  cargo run -p xtask -- perf warm [--iterations N] [--connections N]");
    eprintln!(
        "  cargo run -p xtask -- perf bench [--suite all|rtt|speed] [--mode all|direct|server-sqlx] [--iterations N] [--scale N]"
    );
    eprintln!("  cargo run -p xtask -- perf native-postgres [--suite all|rtt|speed]");
    eprintln!("  cargo run -p xtask -- perf diagnose-speed-hotspots");
    eprintln!("  cargo run -p xtask -- perf diagnose-speed-cases [--ids=1,6,12,16]");
    eprintln!("  cargo run -p xtask -- perf smoke");
}

#[derive(Debug, Deserialize)]
struct SourcesManifest {
    toolchain: Toolchain,
    build: BuildConfig,
    sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
struct GeneratedAssetManifest {
    #[serde(default)]
    sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
struct Toolchain {
    wasmer: String,
    #[serde(rename = "wasmer-wasix")]
    wasmer_wasix: String,
    #[allow(dead_code)]
    wasixcc: String,
    #[allow(dead_code)]
    llvm: String,
    #[allow(dead_code)]
    docker_image: String,
    #[allow(dead_code)]
    docker_image_digest: String,
}

#[derive(Debug, Deserialize)]
struct BuildConfig {
    postgres_prefix: String,
    postgres_pkglibdir: String,
    postgres_sharedir: String,
    main_flags: Vec<String>,
    extension_flags: Vec<String>,
    archive_format: String,
    deterministic_archives: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct SourcePin {
    name: String,
    url: String,
    branch: String,
    commit: String,
}

struct ExtensionPackage<'a> {
    name: &'a str,
    sql_name: &'a str,
    archive: &'a str,
    path: &'a Path,
    module_path: &'a Path,
    stable: bool,
}

struct BinaryPackage<'a> {
    name: &'a str,
    path: &'a Path,
    runtime_path: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BuildOutputManifestOut {
    format_version: u32,
    build_profile: String,
    modules: Vec<BuildModuleManifestOut>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BuildModuleManifestOut {
    name: String,
    kind: String,
    path: String,
    sha256: String,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AssetManifestOut {
    format_version: u32,
    runtime: RuntimeAssetOut,
    runtime_support: Vec<BinaryAssetOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pg_dump: Option<BinaryAssetOut>,
    extensions: Vec<ExtensionAssetOut>,
    sources: Vec<SourcePin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct RuntimeAssetOut {
    archive: String,
    sha256: String,
    module_sha256: String,
    postgres_version: String,
    runtime_kind: String,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BinaryAssetOut {
    name: String,
    path: String,
    sha256: String,
    module_sha256: String,
    size: u64,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ExtensionAssetOut {
    name: String,
    sql_name: String,
    archive: String,
    sha256: String,
    module_sha256: String,
    size: u64,
    stable: bool,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmLinkMetadataOut {
    has_dylink0: bool,
    dylink_needed: Vec<String>,
    dylink_runtime_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dylink_memory: Option<WasmDylinkMemoryOut>,
    dylink_imports: Vec<WasmDylinkSymbolOut>,
    dylink_exports: Vec<WasmDylinkSymbolOut>,
    imports: Vec<WasmImportOut>,
    exports: Vec<WasmExportOut>,
    memories: Vec<WasmMemoryOut>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmDylinkMemoryOut {
    memory_size: u32,
    memory_alignment: u32,
    table_size: u32,
    table_alignment: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmDylinkSymbolOut {
    module: Option<String>,
    name: String,
    flags: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmImportOut {
    module: String,
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmExportOut {
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmMemoryOut {
    initial_pages: u64,
    maximum_pages: Option<u64>,
    memory64: bool,
    shared: bool,
    page_size_log2: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifest {
    format_version: u32,
    target_triple: String,
    engine: String,
    wasmer_version: String,
    wasmer_wasix_version: String,
    artifacts: Vec<AotManifestArtifact>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifestArtifact {
    name: String,
    path: String,
    sha256: String,
    raw_sha256: String,
    raw_size: u64,
    module_sha256: String,
    compressed: bool,
}

struct UpstreamAuditItem {
    id: &'static str,
    commit: &'static str,
    description: &'static str,
    required: bool,
}

const UPSTREAM_AUDIT: &[UpstreamAuditItem] = &[
    UpstreamAuditItem {
        id: "stable-foundation",
        commit: "01792c31a62b7045eb22e93d7dad022bb64b1184",
        description: "REL_17_5-pglite pinned source used by @electric-sql/pglite 0.4.5",
        required: true,
    },
    UpstreamAuditItem {
        id: "builder-age",
        commit: "c7c530a",
        description: "builder branch AGE extension source and packaging reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "builder-pgdump",
        commit: "f5f1005",
        description: "builder branch backend pg_dump work reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "builder-pgcrypto",
        commit: "bee4a36",
        description: "builder branch pgcrypto backend work reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "stable-protocol-exports",
        commit: "a58ae720b72b0a350babe4e22652467253217e11",
        description: "stable branch PGlite protocol exports and startup HBA load",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-checkpointer-disable",
        commit: "01792c31a62b7045eb22e93d7dad022bb64b1184",
        description: "stable branch disables WAL-fill checkpointer requests",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-external-checkpointer",
        commit: "ebb22839ae6fc3837d24e949626075175f5281fd",
        description: "stable branch disables external checkpointer dependency in PGlite",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-imported-memory",
        commit: "0c98d7c9c9bd3b0d01cb6728c4802b705f05ee54",
        description: "stable branch imported memory build fix",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-memory-stack",
        commit: "9ebefd39f8d4d16b1bea9992ed03c19d43b9d956",
        description: "stable branch adjusts initial memory and stack sizing",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-postgres-user",
        commit: "ac31093ac4d9291a167c11a1eac9dc956d4fab77",
        description: "stable branch default postgres user and home",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-initdb-single-no-exit",
        commit: "a679d34cc89848bc1c46b32e4449203b6b2a2320",
        description: "stable branch keeps initdb single-user phase from exiting process state",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-atexit-single-cleanup",
        commit: "f8ab9b9f13ef9a094afac993006f24edd6aa3357",
        description: "stable branch removes PGlite atexit handler replay during embedded restart",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-postmaster-environment",
        commit: "50354221668b9a5d2f9cf79cd4bc93fa68ef923d",
        description: "stable branch marks PGlite single-user mode as postmaster environment",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-timer-cleanup",
        commit: "e01963726df03e4700de48b69d1ac16ea5e20bef",
        description: "stable branch clears timers on embedded process exit",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-is-transaction-block",
        commit: "6c76f5e",
        description: "stable branch IsTransactionBlock export",
        required: false,
    },
    UpstreamAuditItem {
        id: "stable-postgis",
        commit: "d0f2748",
        description: "stable branch PostGIS backend proof",
        required: false,
    },
];
