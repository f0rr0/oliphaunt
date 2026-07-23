use super::*;

use crate::process_rss::NativeLiboliphauntChildRssSampler;
use oliphaunt::{
    BackupRequest as NativeBackupRequest, Oliphaunt as NativeOliphaunt,
    OliphauntBuilder as NativeOliphauntBuilder, ProtocolRequest as NativeProtocolRequest,
    RestoreRequest as NativeRestoreRequest,
};

pub(super) fn perf_native_liboliphaunt(args: &[String]) -> Result<()> {
    let mut suite = NativeLiboliphauntSuiteFilter::Rtt;
    let mut engine = NativeLiboliphauntEngineMode::Direct;
    let mut speed_sql_source = SpeedSqlSource::OliphauntFixture;
    let mut rtt_iterations = 100usize;
    let mut prepared_rows = 25_000usize;
    let mut tuning = NativeBenchmarkTuning::default();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--engine" | "--mode" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--engine requires a value"))?;
                engine = NativeLiboliphauntEngineMode::parse(value)?;
            }
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "rtt" | "roundtrip" | "round-trip" => NativeLiboliphauntSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => NativeLiboliphauntSuiteFilter::Speed,
                    "stream" | "streaming" | "large-results" => {
                        NativeLiboliphauntSuiteFilter::Streaming
                    }
                    "prepared-updates" | "prepared" => {
                        NativeLiboliphauntSuiteFilter::PreparedUpdates
                    }
                    "backup" | "backup-restore" | "backup_restore" => {
                        NativeLiboliphauntSuiteFilter::BackupRestore
                    }
                    "all" => bail!(
                        "native-liboliphaunt v1 can only open once per process; run --suite rtt, speed, streaming, prepared-updates, and backup-restore in separate commands"
                    ),
                    other => {
                        bail!(
                            "unknown --suite value {other:?}; use rtt, speed, streaming, prepared-updates, or backup-restore"
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
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                prepared_rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
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
            other => bail!("unknown perf native-liboliphaunt flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");
    ensure!(prepared_rows > 0, "--rows must be greater than zero");

    if suite == NativeLiboliphauntSuiteFilter::PreparedUpdates {
        return perf_native_liboliphaunt_prepared_updates(engine, prepared_rows, tuning);
    }

    let run = match suite {
        NativeLiboliphauntSuiteFilter::Rtt => {
            run_native_liboliphaunt_rtt_benchmark(engine, rtt_iterations, &tuning)?
        }
        NativeLiboliphauntSuiteFilter::Speed => {
            run_native_liboliphaunt_speed_benchmark(engine, speed_sql_source, &tuning)?
        }
        NativeLiboliphauntSuiteFilter::Streaming => {
            run_native_liboliphaunt_streaming_benchmark(engine, &tuning)?
        }
        NativeLiboliphauntSuiteFilter::BackupRestore => {
            run_native_liboliphaunt_backup_restore_benchmark(engine, &tuning)?
        }
        NativeLiboliphauntSuiteFilter::PreparedUpdates => {
            unreachable!("prepared-updates returns before benchmark report construction")
        }
    };
    let report = BenchmarkReport {
        wasmer_version: "native-liboliphaunt",
        wasmer_wasix_version: "native-liboliphaunt",
        wasix_runtime_assets: None,
        source_model: speed_sql_source.source_model(),
        measurement_model: engine.measurement_model(),
        native_tuning: Some(tuning.report()),
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs: vec![run],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeLiboliphauntSuiteFilter {
    Rtt,
    Speed,
    Streaming,
    PreparedUpdates,
    BackupRestore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeLiboliphauntEngineMode {
    Direct,
    Broker,
    Server,
}

impl NativeLiboliphauntEngineMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "direct" | "native-direct" | "native_direct" => Ok(Self::Direct),
            "broker" | "native-broker" | "native_broker" => Ok(Self::Broker),
            "server" | "native-server" | "native_server" => Ok(Self::Server),
            other => {
                bail!("unknown native-liboliphaunt engine {other:?}; use direct, broker, or server")
            }
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Broker => "broker",
            Self::Server => "server",
        }
    }

    fn benchmark_mode(self) -> &'static str {
        match self {
            Self::Direct => "native_liboliphaunt_direct",
            Self::Broker => "native_liboliphaunt_broker",
            Self::Server => "native_liboliphaunt_server",
        }
    }

    fn description(self, suite: &'static str) -> &'static str {
        match (self, suite) {
            (Self::Direct, "rtt") => "Native liboliphaunt in-process direct Rust API.",
            (Self::Direct, "speed") => {
                "Native liboliphaunt speed suite through the in-process direct Rust API."
            }
            (Self::Direct, "streaming") => {
                "Native liboliphaunt large-result streaming through the in-process direct Rust API."
            }
            (Self::Direct, "backup-restore") => {
                "Native liboliphaunt physical archive backup and restore through the in-process direct Rust API."
            }
            (Self::Broker, "rtt") => {
                "Native liboliphaunt broker mode through a helper process and local IPC."
            }
            (Self::Broker, "speed") => {
                "Native liboliphaunt speed suite through broker helper-process IPC."
            }
            (Self::Broker, "streaming") => {
                "Native liboliphaunt large-result streaming through broker helper-process IPC."
            }
            (Self::Broker, "backup-restore") => {
                "Native liboliphaunt physical archive backup and restore through broker helper-process IPC."
            }
            (Self::Server, "rtt") => {
                "Native liboliphaunt server mode through a real local PostgreSQL server process."
            }
            (Self::Server, "speed") => {
                "Native liboliphaunt speed suite through a real local PostgreSQL server process."
            }
            (Self::Server, "streaming") => {
                "Native liboliphaunt large-result streaming through a real local PostgreSQL server process."
            }
            (Self::Server, "backup-restore") => {
                "Native liboliphaunt physical archive backup and restore through a real local PostgreSQL server process."
            }
            _ => "Native liboliphaunt benchmark.",
        }
    }

    fn measurement_model(self) -> &'static str {
        match self {
            Self::Direct => {
                "Native liboliphaunt direct-mode control. xtask opens one embedded native PostgreSQL backend in-process through the oliphaunt Rust SDK. RTT sample loops run inside one Tokio runtime, sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
            Self::Broker => {
                "Native liboliphaunt broker-mode control. xtask opens oliphaunt in broker mode, where a helper process owns the direct native backend and the Rust client sends raw protocol/control frames over local IPC. RTT sample loops run inside one Tokio runtime, sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
            Self::Server => {
                "Native liboliphaunt server-mode control. xtask opens oliphaunt in server mode, which starts a real local PostgreSQL server process and sends raw PostgreSQL protocol frames through the SDK's server client. RTT sample loops run inside one Tokio runtime, sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
        }
    }
}

fn run_native_liboliphaunt_rtt_benchmark(
    engine: NativeLiboliphauntEngineMode,
    iterations: usize,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let root = native_liboliphaunt_benchmark_root(engine.label(), "rtt")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let db = runtime
        .block_on(native_liboliphaunt_builder(&root, engine, tuning).open())
        .with_context(|| format!("open native liboliphaunt {} RTT database", engine.label()))?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let setup_started = Instant::now();
    runtime
        .block_on(db.execute(rtt_setup_sql()))
        .with_context(|| format!("execute native liboliphaunt {} RTT setup", engine.label()))?;
    let setup_micros = setup_started.elapsed().as_micros();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let test = runtime.block_on(async {
            let mut samples = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let started = Instant::now();
                db.execute(&case.sql)
                    .await
                    .with_context(|| format!("execute RTT benchmark {}", case.id))?;
                samples.push(started.elapsed().as_micros());
            }
            Ok::<_, anyhow::Error>(samples_result(
                case.id,
                format!("Test {}: {}", case.id, case.label),
                "milliseconds",
                iterations,
                samples,
            ))
        })?;
        tests.push(test);
        child_rss.sample();
    }
    runtime.block_on(db.close())?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "RTT")?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: engine.benchmark_mode(),
        description: engine.description("rtt"),
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: child_rss.peak_bytes(),
        tests,
    })
}

fn run_native_liboliphaunt_speed_benchmark(
    engine: NativeLiboliphauntEngineMode,
    sql_source: SpeedSqlSource,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let cases = speed_cases(1.0, sql_source)?;
    let root = native_liboliphaunt_benchmark_root(engine.label(), "speed")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let db = runtime
        .block_on(native_liboliphaunt_builder(&root, engine, tuning).open())
        .with_context(|| format!("open native liboliphaunt {} speed database", engine.label()))?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in cases {
        let started = Instant::now();
        runtime
            .block_on(db.execute(&case.sql))
            .with_context(|| format!("execute native liboliphaunt speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
        child_rss.sample();
    }
    runtime.block_on(db.close())?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "speed")?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: engine.benchmark_mode(),
        description: engine.description("speed"),
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: child_rss.peak_bytes(),
        tests,
    })
}

fn run_native_liboliphaunt_streaming_benchmark(
    engine: NativeLiboliphauntEngineMode,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let root = native_liboliphaunt_benchmark_root(engine.label(), "streaming")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let db = runtime
        .block_on(native_liboliphaunt_builder(&root, engine, tuning).open())
        .with_context(|| {
            format!(
                "open native liboliphaunt {} streaming database",
                engine.label()
            )
        })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in streaming_cases() {
        let counters = std::sync::Arc::new(std::sync::Mutex::new((0usize, 0usize)));
        let counters_for_callback = std::sync::Arc::clone(&counters);
        let started = Instant::now();
        runtime
            .block_on(
                db.exec_protocol_raw_stream(pg_query(case.sql), move |chunk| {
                    let mut counters = counters_for_callback.lock().map_err(|_| {
                        oliphaunt::Error::Engine(
                            "streaming benchmark counter lock poisoned".to_owned(),
                        )
                    })?;
                    counters.0 = counters.0.saturating_add(chunk.len());
                    counters.1 = counters.1.saturating_add(1);
                    Ok(())
                }),
            )
            .with_context(|| {
                format!(
                    "execute native liboliphaunt {} streaming benchmark {}",
                    engine.label(),
                    case.id
                )
            })?;
        let (bytes, chunks) = *counters
            .lock()
            .map_err(|_| anyhow!("streaming benchmark counter lock poisoned"))?;
        tests.push(single_sample_result(
            case.id,
            format!(
                "{}; streamed {bytes} bytes across {chunks} chunk(s)",
                case.label
            ),
            "seconds",
            bytes,
            started.elapsed(),
        ));
        child_rss.sample();
    }
    runtime.block_on(db.close())?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "streaming")?;

    Ok(BenchmarkRun {
        suite: "streaming",
        mode: engine.benchmark_mode(),
        description: engine.description("streaming"),
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: child_rss.peak_bytes(),
        tests,
    })
}

fn run_native_liboliphaunt_backup_restore_benchmark(
    engine: NativeLiboliphauntEngineMode,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let root = native_liboliphaunt_benchmark_root(engine.label(), "backup")?;
    let restore_root = native_liboliphaunt_benchmark_root(engine.label(), "restore")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let db = runtime
        .block_on(native_liboliphaunt_builder(&root, engine, tuning).open())
        .with_context(|| {
            format!(
                "open native liboliphaunt {} backup/restore database",
                engine.label()
            )
        })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let setup_started = Instant::now();
    let setup_sql = backup_restore_setup_sql();
    runtime.block_on(db.execute(&setup_sql)).with_context(|| {
        format!(
            "execute native liboliphaunt {} backup/restore setup",
            engine.label()
        )
    })?;
    let setup_micros = setup_started.elapsed().as_micros();
    child_rss.sample();

    let backup_started = Instant::now();
    let artifact = runtime
        .block_on(db.backup(NativeBackupRequest::physical_archive()))
        .with_context(|| format!("backup native liboliphaunt {} root", engine.label()))?;
    let backup_elapsed = backup_started.elapsed();
    ensure!(
        !artifact.bytes.is_empty(),
        "native liboliphaunt {} backup returned an empty archive",
        engine.label()
    );
    let archive_bytes = artifact.bytes.len();
    child_rss.sample();

    runtime.block_on(db.close())?;

    let restore_started = Instant::now();
    runtime
        .block_on(NativeOliphaunt::restore(
            NativeRestoreRequest::physical_archive(&restore_root, artifact),
        ))
        .with_context(|| {
            format!(
                "restore native liboliphaunt {} physical archive",
                engine.label()
            )
        })?;
    let restore_elapsed = restore_started.elapsed();

    verify_native_liboliphaunt_restored_root(engine, &restore_root, tuning)?;

    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "backup")?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &restore_root, "restore")?;

    Ok(BenchmarkRun {
        suite: "backup-restore",
        mode: engine.benchmark_mode(),
        description: engine.description("backup-restore"),
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: child_rss.peak_bytes(),
        tests: vec![
            single_sample_result(
                "physical_archive_backup",
                format!(
                    "Physical archive backup; archive size {}",
                    fmt_bytes_label(archive_bytes)
                ),
                "seconds",
                archive_bytes,
                backup_elapsed,
            ),
            single_sample_result(
                "physical_archive_restore",
                format!(
                    "Physical archive restore; archive size {}",
                    fmt_bytes_label(archive_bytes)
                ),
                "seconds",
                archive_bytes,
                restore_elapsed,
            ),
        ],
    })
}

fn verify_native_liboliphaunt_restored_root(
    engine: NativeLiboliphauntEngineMode,
    root: &Path,
    tuning: &NativeBenchmarkTuning,
) -> Result<()> {
    let mut args = vec![
        "perf".to_owned(),
        "native-liboliphaunt-restore-verify-child".to_owned(),
        "--engine".to_owned(),
        engine.label().to_owned(),
        "--root".to_owned(),
        root.display().to_string(),
        "--expected-rows".to_owned(),
        BACKUP_RESTORE_EXPECTED_ROWS.to_string(),
        "--durability".to_owned(),
        native_durability_arg(tuning.durability).to_owned(),
        "--runtime-footprint".to_owned(),
        tuning.runtime_footprint.to_string(),
    ];
    for guc in &tuning.startup_gucs {
        args.push("--startup-guc".to_owned());
        args.push(format!("{}={}", guc.name.trim(), guc.value));
    }

    let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
        .args(args)
        .output()
        .with_context(|| {
            format!(
                "run native-liboliphaunt {} restore verification child",
                engine.label()
            )
        })?;
    ensure!(
        output.status.success(),
        "native-liboliphaunt restore verification child failed for {}:\nstdout:\n{}\nstderr:\n{}",
        engine.label(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

pub(super) fn perf_native_liboliphaunt_restore_verify_child(args: &[String]) -> Result<()> {
    let mut engine = NativeLiboliphauntEngineMode::Direct;
    let mut root = None;
    let mut expected_rows = BACKUP_RESTORE_EXPECTED_ROWS;
    let mut tuning = NativeBenchmarkTuning::default();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--engine" | "--mode" => {
                cursor += 1;
                engine = NativeLiboliphauntEngineMode::parse(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--engine requires a value"))?,
                )?;
            }
            "--root" => {
                cursor += 1;
                root = Some(PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--root requires a value"))?,
                ));
            }
            "--expected-rows" => {
                cursor += 1;
                expected_rows = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--expected-rows requires a value"))?
                    .parse()
                    .context("parse --expected-rows")?;
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
            other => bail!("unknown native-liboliphaunt restore verification child flag: {other}"),
        }
        cursor += 1;
    }
    let root = root.context("--root is required")?;
    let runtime = native_liboliphaunt_runtime()?;
    let db = runtime
        .block_on(
            native_liboliphaunt_builder(&root, engine, &tuning)
                .existing_only()
                .open(),
        )
        .with_context(|| {
            format!(
                "open restored native-liboliphaunt {} root {}",
                engine.label(),
                root.display()
            )
        })?;
    let result = runtime
        .block_on(db.query("SELECT count(*)::text AS count FROM backup_restore_items"))
        .context("query restored backup_restore_items count")?;
    let count = result
        .get_text(0, "count")
        .context("read restored count column")?
        .context("restored count was NULL")?;
    ensure!(
        count == expected_rows.to_string(),
        "restored row count mismatch: got {count}, expected {expected_rows}"
    );
    runtime.block_on(db.close())?;
    println!("verified restored rows: {count}");
    Ok(())
}

fn perf_native_liboliphaunt_prepared_updates(
    engine: NativeLiboliphauntEngineMode,
    rows: usize,
    tuning: NativeBenchmarkTuning,
) -> Result<()> {
    let sequential_mode = format!("{}_prepared", engine.benchmark_mode());
    let pipelined_mode = format!("{}_pipelined_prepared", engine.benchmark_mode());
    let sequential_description = format!(
        "Native liboliphaunt {} mode using one named prepared statement and one Bind/Execute/Sync round trip per update.",
        engine.label()
    );
    let pipelined_description = format!(
        "Native liboliphaunt {} mode using one named prepared statement and one pipelined Bind/Execute batch inside one transaction.",
        engine.label()
    );
    let runs = vec![
        PreparedUpdateRun {
            mode: sequential_mode,
            description: sequential_description,
            protocol_stats: None,
            tests: run_native_liboliphaunt_prepared_update_tests(
                engine,
                rows,
                &tuning,
                PreparedExecution::Sequential,
            )?,
        },
        PreparedUpdateRun {
            mode: pipelined_mode,
            description: pipelined_description,
            protocol_stats: None,
            tests: run_native_liboliphaunt_prepared_update_tests(
                engine,
                rows,
                &tuning,
                PreparedExecution::Pipelined,
            )?,
        },
    ];

    let report = PreparedUpdateReport {
        source_model: "Exact Oliphaunt fixture benchmark2/benchmark6 setup plus update values parsed from benchmark9 and benchmark10.",
        measurement_model: "Each native-liboliphaunt prepared-update test runs in a fresh xtask child process. The child opens the selected native SDK mode, prepares one named statement over the raw frontend/backend protocol, then executes N updates inside one transaction.",
        gate_model: None,
        wasix_runtime_assets: None,
        native_tuning: Some(tuning.report()),
        rows,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_native_liboliphaunt_prepared_update_tests(
    engine: NativeLiboliphauntEngineMode,
    rows: usize,
    tuning: &NativeBenchmarkTuning,
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    Ok(vec![
        run_native_liboliphaunt_prepared_update_child(
            engine,
            NativeLiboliphauntPreparedCase::Numeric,
            execution,
            rows,
            tuning,
        )?,
        run_native_liboliphaunt_prepared_update_child(
            engine,
            NativeLiboliphauntPreparedCase::Text,
            execution,
            rows,
            tuning,
        )?,
    ])
}

fn run_native_liboliphaunt_prepared_update_child(
    engine: NativeLiboliphauntEngineMode,
    case: NativeLiboliphauntPreparedCase,
    execution: PreparedExecution,
    rows: usize,
    tuning: &NativeBenchmarkTuning,
) -> Result<PreparedUpdateTest> {
    let rows_arg = rows.to_string();
    let mut child_args = vec![
        "perf".to_owned(),
        "native-liboliphaunt-prepared-child".to_owned(),
        "--engine".to_owned(),
        engine.label().to_owned(),
        "--case".to_owned(),
        case.arg().to_owned(),
        "--execution".to_owned(),
        execution.arg().to_owned(),
        "--rows".to_owned(),
        rows_arg,
        "--durability".to_owned(),
        native_durability_arg(tuning.durability).to_owned(),
        "--runtime-footprint".to_owned(),
        tuning.runtime_footprint.to_string(),
    ];
    for guc in &tuning.startup_gucs {
        child_args.push("--startup-guc".to_owned());
        child_args.push(format!("{}={}", guc.name.trim(), guc.value));
    }
    let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
        .args(child_args)
        .output()
        .with_context(|| format!("run native-liboliphaunt prepared child for {}", case.arg()))?;

    if !output.status.success() {
        bail!(
            "native-liboliphaunt prepared child failed for {} {}:\nstdout:\n{}\nstderr:\n{}",
            case.arg(),
            execution.arg(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let metrics: PreparedUpdateChildMetrics =
        serde_json::from_slice(&output.stdout).with_context(|| {
            format!(
                "parse native-liboliphaunt prepared child JSON for {} {}",
                case.arg(),
                execution.arg()
            )
        })?;
    Ok(metrics.into_test(case))
}

pub(super) fn perf_native_liboliphaunt_prepared_child(args: &[String]) -> Result<()> {
    let mut engine = NativeLiboliphauntEngineMode::Direct;
    let mut case = None;
    let mut execution = None;
    let mut rows = 25_000usize;
    let mut tuning = NativeBenchmarkTuning::default();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--engine" | "--mode" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--engine requires a value"))?;
                engine = NativeLiboliphauntEngineMode::parse(value)?;
            }
            "--case" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--case requires a value"))?;
                case = Some(NativeLiboliphauntPreparedCase::parse(value)?);
            }
            "--execution" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--execution requires a value"))?;
                execution = Some(parse_prepared_execution(value)?);
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
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
            other => bail!("unknown native-liboliphaunt prepared child flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows must be greater than zero");
    let case = case.context("--case is required")?;
    let execution = execution.context("--execution is required")?;

    let metrics =
        run_native_liboliphaunt_prepared_update_case(engine, case, execution, rows, &tuning)?;
    println!("{}", serde_json::to_string_pretty(&metrics)?);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum NativeLiboliphauntPreparedCase {
    Numeric,
    Text,
}

impl NativeLiboliphauntPreparedCase {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "numeric" | "numeric-indexed" => Ok(Self::Numeric),
            "text" | "text-indexed" => Ok(Self::Text),
            other => bail!("unknown native-liboliphaunt prepared case {other:?}"),
        }
    }

    fn arg(self) -> &'static str {
        match self {
            Self::Numeric => "numeric",
            Self::Text => "text",
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Numeric => "numeric_indexed",
            Self::Text => "text_indexed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Numeric => {
                "Parameterized numeric UPDATEs with indexes on lookup and updated columns"
            }
            Self::Text => "Parameterized text UPDATEs with indexes on lookup and numeric column",
        }
    }
}

fn parse_prepared_execution(value: &str) -> Result<PreparedExecution> {
    match value {
        "sequential" => Ok(PreparedExecution::Sequential),
        "pipelined" | "pipeline" => Ok(PreparedExecution::Pipelined),
        other => bail!("unknown prepared execution {other:?}"),
    }
}

impl PreparedExecution {
    fn arg(self) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::Pipelined => "pipelined",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateChildMetrics {
    open_micros: u128,
    connect_micros: u128,
    setup_micros: u128,
    prepare_micros: Option<u128>,
    elapsed_micros: u128,
    operation_count: usize,
    average_micros: f64,
}

impl PreparedUpdateChildMetrics {
    fn into_test(self, case: NativeLiboliphauntPreparedCase) -> PreparedUpdateTest {
        PreparedUpdateTest {
            id: case.id(),
            label: case.label(),
            open_micros: self.open_micros,
            connect_micros: self.connect_micros,
            setup_micros: self.setup_micros,
            prepare_micros: self.prepare_micros,
            elapsed_micros: self.elapsed_micros,
            operation_count: self.operation_count,
            average_micros: self.average_micros,
        }
    }
}

fn run_native_liboliphaunt_prepared_update_case(
    engine: NativeLiboliphauntEngineMode,
    case: NativeLiboliphauntPreparedCase,
    execution: PreparedExecution,
    rows: usize,
    tuning: &NativeBenchmarkTuning,
) -> Result<PreparedUpdateChildMetrics> {
    let setup_benchmark2 = read_oliphaunt_benchmark_sql("2")?;
    let setup_benchmark6 = read_oliphaunt_benchmark_sql("6")?;
    let update_values = match case {
        NativeLiboliphauntPreparedCase::Numeric => {
            NativeLiboliphauntPreparedValues::Numeric(parsed_numeric_updates(rows)?)
        }
        NativeLiboliphauntPreparedCase::Text => {
            NativeLiboliphauntPreparedValues::Text(parsed_text_updates(rows)?)
        }
    };

    let root = native_liboliphaunt_benchmark_root(engine.label(), "prepared")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let builder = native_liboliphaunt_builder(&root, engine, tuning);
    let db = runtime
        .block_on(builder.open())
        .context("open native-liboliphaunt prepared database")?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    runtime
        .block_on(db.execute(&setup_benchmark2))
        .context("execute native-liboliphaunt prepared setup benchmark2")?;
    runtime
        .block_on(db.execute(&setup_benchmark6))
        .context("execute native-liboliphaunt prepared setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let statement_name = "oliphaunt_bench_update";
    let (sql, param_oids) = match case {
        NativeLiboliphauntPreparedCase::Numeric => ("UPDATE t2 SET b=$1 WHERE a=$2", &[23, 23][..]),
        NativeLiboliphauntPreparedCase::Text => ("UPDATE t2 SET c=$1 WHERE a=$2", &[25, 23][..]),
    };
    let mut prepare = Vec::new();
    prepare.extend(pg_parse(Some(statement_name), sql, param_oids));
    prepare.extend(pg_describe(b'S', Some(statement_name)));
    prepare.extend(pg_sync());
    let prepare_started = Instant::now();
    exec_raw_checked(
        &runtime,
        &db,
        &prepare,
        "prepare native-liboliphaunt statement",
    )?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    exec_raw_checked(
        &runtime,
        &db,
        &pg_query("BEGIN"),
        "begin prepared-update transaction",
    )?;
    let operation_count = match update_values {
        NativeLiboliphauntPreparedValues::Numeric(updates) => {
            execute_native_liboliphaunt_prepared_updates(
                &runtime,
                &db,
                statement_name,
                execution,
                updates
                    .iter()
                    .map(|(lookup, value)| [value.to_string(), lookup.to_string()]),
            )?;
            updates.len()
        }
        NativeLiboliphauntPreparedValues::Text(updates) => {
            execute_native_liboliphaunt_prepared_updates(
                &runtime,
                &db,
                statement_name,
                execution,
                updates
                    .iter()
                    .map(|(lookup, value)| [value.clone(), lookup.to_string()]),
            )?;
            updates.len()
        }
    };
    exec_raw_checked(
        &runtime,
        &db,
        &pg_query("COMMIT"),
        "commit prepared-update transaction",
    )?;
    let elapsed = started.elapsed();

    runtime
        .block_on(db.close())
        .context("close native-liboliphaunt prepared-update database")?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "prepared-update")?;

    Ok(PreparedUpdateChildMetrics {
        open_micros,
        connect_micros: 0,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        average_micros: elapsed.as_micros() as f64 / operation_count as f64,
    })
}

fn native_liboliphaunt_builder(
    root: &Path,
    engine: NativeLiboliphauntEngineMode,
    tuning: &NativeBenchmarkTuning,
) -> NativeOliphauntBuilder {
    let builder = NativeOliphaunt::builder()
        .path(root)
        .durability(tuning.durability)
        .runtime_footprint(tuning.runtime_footprint)
        .startup_gucs(tuning.startup_gucs.clone());
    match engine {
        NativeLiboliphauntEngineMode::Direct => builder.native_direct(),
        NativeLiboliphauntEngineMode::Broker => builder.native_broker(),
        NativeLiboliphauntEngineMode::Server => builder.native_server(),
    }
}

fn native_liboliphaunt_benchmark_root(engine: &str, label: &str) -> Result<PathBuf> {
    let root = env::current_dir()
        .context("read current directory")?
        .join("target/perf")
        .join(format!(
            "native-liboliphaunt-{engine}-{label}-{}-{}",
            std::process::id(),
            now_micros()?
        ));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale native liboliphaunt root {}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .with_context(|| format!("create native liboliphaunt root {}", root.display()))?;
    Ok(root)
}

fn cleanup_native_liboliphaunt_benchmark_root(
    engine: NativeLiboliphauntEngineMode,
    root: &Path,
    label: &str,
) -> Result<()> {
    if engine == NativeLiboliphauntEngineMode::Direct {
        return Ok(());
    }
    fs::remove_dir_all(root)
        .with_context(|| format!("remove native liboliphaunt {label} root {}", root.display()))
}

fn native_liboliphaunt_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build native liboliphaunt benchmark runtime")
}

enum NativeLiboliphauntPreparedValues {
    Numeric(Vec<(i32, i32)>),
    Text(Vec<(i32, String)>),
}

fn execute_native_liboliphaunt_prepared_updates<I>(
    runtime: &tokio::runtime::Runtime,
    db: &NativeOliphaunt,
    statement_name: &str,
    execution: PreparedExecution,
    values: I,
) -> Result<()>
where
    I: IntoIterator<Item = [String; 2]>,
{
    match execution {
        PreparedExecution::Sequential => {
            for value_pair in values {
                let mut batch = Vec::new();
                batch.extend(pg_bind(None, statement_name, &value_pair));
                batch.extend(pg_execute(None));
                batch.extend(pg_sync());
                exec_raw_checked(
                    runtime,
                    db,
                    &batch,
                    "execute sequential native-liboliphaunt prepared update",
                )?;
            }
        }
        PreparedExecution::Pipelined => {
            let mut batch = Vec::new();
            for (idx, value_pair) in values.into_iter().enumerate() {
                let portal = format!("p{idx}");
                batch.extend(pg_bind(Some(&portal), statement_name, &value_pair));
                batch.extend(pg_execute(Some(&portal)));
                batch.extend(pg_close(b'P', Some(&portal)));
            }
            batch.extend(pg_sync());
            exec_raw_checked(
                runtime,
                db,
                &batch,
                "execute pipelined native-liboliphaunt prepared updates",
            )?;
        }
    }
    Ok(())
}

fn exec_raw_checked(
    runtime: &tokio::runtime::Runtime,
    db: &NativeOliphaunt,
    message: &[u8],
    context: &'static str,
) -> Result<()> {
    let response = runtime
        .block_on(db.exec_protocol_raw(NativeProtocolRequest::new(message.to_vec())))
        .with_context(|| context)?;
    ensure_protocol_response_ok(response.as_bytes()).with_context(|| context)
}

pub(super) fn run_native_liboliphaunt_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    target_index: usize,
    options: &SpeedDiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target = &cases[target_index];
    let root = native_liboliphaunt_benchmark_root("direct", "diagnose-speed")?;
    let runtime = native_liboliphaunt_runtime()?;
    let open_started = Instant::now();
    let db = runtime
        .block_on(
            NativeOliphaunt::builder()
                .path(&root)
                .native_direct()
                .durability(options.durability)
                .open(),
        )
        .with_context(|| {
            format!(
                "open native liboliphaunt diagnostic database for {}",
                target.id
            )
        })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let setup_started = Instant::now();
    for setup_case in &cases[..target_index] {
        runtime
            .block_on(db.execute(&setup_case.sql))
            .with_context(|| format!("run native liboliphaunt setup case {}", setup_case.id))?;
        child_rss.sample();
    }
    let setup_micros = setup_started.elapsed().as_micros();

    let started = Instant::now();
    runtime
        .block_on(db.execute(&target.sql))
        .with_context(|| format!("run native liboliphaunt measured case {}", target.id))?;
    let elapsed_micros = started.elapsed().as_micros();
    child_rss.sample();
    let settings = runtime
        .block_on(db.execute(speed_diagnostic_settings_sql()))
        .map(|response| diagnostic_settings_from_protocol_response(response.as_bytes()))
        .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string() }));

    runtime.block_on(db.close())?;

    Ok(SpeedHotspotDiagnosticCase {
        engine: DiagnosticEngine::NativeOliphaunt.label(),
        process_model: "native_liboliphaunt_in_process_standalone_backend",
        id: target.id.to_owned(),
        label: target.label.clone(),
        open_micros: Some(open_micros),
        connect_micros: None,
        setup_micros,
        elapsed_micros,
        operation_count: target.operation_count,
        settings,
        observed_server_peak_rss_bytes: child_rss.peak_bytes(),
        fs_trace: serde_json::Value::Null,
        phases: Vec::new(),
    })
}
