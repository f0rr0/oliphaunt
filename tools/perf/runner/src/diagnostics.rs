use super::*;

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn perf_diagnose_indexed_update() -> Result<()> {
    Oliphaunt::preload()?;

    let benchmark2 = read_oliphaunt_benchmark_sql("2")?;
    let benchmark6 = read_oliphaunt_benchmark_sql("6")?;
    let benchmark9 = read_oliphaunt_benchmark_sql("9")?;
    let benchmark10 = read_oliphaunt_benchmark_sql("10")?;
    let unlogged_benchmark2 = benchmark2.replace("CREATE TABLE", "CREATE UNLOGGED TABLE");
    let lookup_index_only = "CREATE INDEX i2a ON t2(a);\n";

    let cases = vec![
        run_indexed_update_diagnostic_case(
            "exact_numeric_indexed",
            "Oliphaunt benchmark2 + benchmark6, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "exact_text_indexed",
            "Oliphaunt benchmark2 + benchmark6, then exact benchmark10 text updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_lookup_index_only",
            "Oliphaunt benchmark2 + index on lookup column a only, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_lookup_index_only",
            "Oliphaunt benchmark2 + index on lookup column a only, then exact benchmark10 text updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_unlogged_indexed",
            "Oliphaunt benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark9 numeric updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_unlogged_indexed",
            "Oliphaunt benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark10 text updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_indexed",
            "Oliphaunt benchmark2 + benchmark6 + exact benchmark9 numeric updates, then exact benchmark10 text updates",
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
            "Oliphaunt benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM t2, then exact benchmark10 text updates",
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
            "Oliphaunt benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM FULL t2, then exact benchmark10 text updates",
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
            "Oliphaunt benchmark2 + benchmark6, then one set-based numeric update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET b = b + 1;\nCOMMIT;\n",
            1,
        )?,
        run_indexed_update_diagnostic_case(
            "set_based_text_indexed",
            "Oliphaunt benchmark2 + benchmark6, then one set-based text update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET c = c || ' updated';\nCOMMIT;\n",
            1,
        )?,
    ];

    let report = IndexedUpdateDiagnosticReport {
        source_model: "Exact Oliphaunt fixture benchmark SQL files from benchmarks/native/sql plus controlled variants.",
        measurement_model: "Each case opens a fresh temporary database, runs setup outside the measured section, then records the measured update SQL and internal Rust/WASIX phase timings.",
        wasix_runtime_assets: wasix_runtime_asset_report()?,
        cases,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
pub(super) fn perf_diagnose_indexed_update() -> Result<()> {
    legacy_oliphaunt_unavailable("perf diagnose-indexed-update")
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn perf_diagnose_speed_hotspots() -> Result<()> {
    let options = SpeedDiagnosticOptions {
        engine: DiagnosticEngine::WasixLegacy,
        postgres_bin: default_native_postgres_tool("postgres", &["OLIPHAUNT_POSTGRES"]),
        initdb_bin: default_native_postgres_tool("initdb", &["OLIPHAUNT_INITDB"]),
        durability: NativeDurabilityProfile::Safe,
    };
    perf_diagnose_speed_ids(&["9", "10", "11", "14"], &options)
}

#[cfg(not(feature = "legacy-oliphaunt"))]
pub(super) fn perf_diagnose_speed_hotspots() -> Result<()> {
    legacy_oliphaunt_unavailable("perf diagnose-speed-hotspots")
}

pub(super) fn perf_diagnose_speed_cases(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    let mut engine = DiagnosticEngine::WasixLegacy;
    let mut postgres_bin = default_native_postgres_tool("postgres", &["OLIPHAUNT_POSTGRES"]);
    let mut initdb_bin = default_native_postgres_tool("initdb", &["OLIPHAUNT_INITDB"]);
    let mut durability = NativeDurabilityProfile::Safe;
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
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
        } else if arg == "--ids" {
            cursor += 1;
            let raw_ids = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--ids requires a value"))?;
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
        } else if let Some(raw_engine) = arg.strip_prefix("--engine=") {
            engine = DiagnosticEngine::parse(raw_engine)?;
        } else if arg == "--engine" {
            cursor += 1;
            let raw_engine = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--engine requires a value"))?;
            engine = DiagnosticEngine::parse(raw_engine)?;
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if arg == "--durability" {
            cursor += 1;
            durability = parse_native_durability(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--durability requires a value"))?,
            )?;
        } else {
            bail!("unknown perf diagnose-speed-cases flag: {arg}");
        }
        cursor += 1;
    }

    let cases = speed_cases(1.0, SpeedSqlSource::OliphauntFixture)?;
    let selected_ids = match ids {
        Some(ids) => ids,
        None => cases.iter().map(|case| case.id.to_owned()).collect(),
    };
    let selected_refs = selected_ids.iter().map(String::as_str).collect::<Vec<_>>();
    let options = SpeedDiagnosticOptions {
        engine,
        postgres_bin,
        initdb_bin,
        durability,
    };
    perf_diagnose_speed_ids(&selected_refs, &options)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DiagnosticEngine {
    WasixLegacy,
    NativeOliphaunt,
    NativePostgres,
}

impl DiagnosticEngine {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "wasix" | "wasix-legacy" | "legacy" => Ok(Self::WasixLegacy),
            "native" | "native-liboliphaunt" | "liboliphaunt" => Ok(Self::NativeOliphaunt),
            "native-postgres" | "postgres" | "pg" => Ok(Self::NativePostgres),
            other => bail!(
                "unknown diagnostic engine {other:?}; use wasix, native-liboliphaunt, or native-postgres"
            ),
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::WasixLegacy => "wasix_legacy",
            Self::NativeOliphaunt => "native_liboliphaunt",
            Self::NativePostgres => "native_postgres",
        }
    }
}

pub(super) struct SpeedDiagnosticOptions {
    pub(super) engine: DiagnosticEngine,
    pub(super) postgres_bin: PathBuf,
    pub(super) initdb_bin: PathBuf,
    pub(super) durability: NativeDurabilityProfile,
}

fn perf_diagnose_speed_ids(ids: &[&str], options: &SpeedDiagnosticOptions) -> Result<()> {
    if options.engine == DiagnosticEngine::WasixLegacy {
        #[cfg(feature = "legacy-oliphaunt")]
        Oliphaunt::preload()?;
        #[cfg(not(feature = "legacy-oliphaunt"))]
        legacy_oliphaunt_unavailable("perf diagnose-speed-cases --engine wasix")?;
    } else if options.engine == DiagnosticEngine::NativeOliphaunt {
        ensure!(
            ids.len() == 1,
            "native liboliphaunt direct diagnostics can run one case per process; pass a single --ids value"
        );
    }
    let cases = speed_cases(1.0, SpeedSqlSource::OliphauntFixture)?;
    let mut diagnostics = Vec::new();
    for id in ids {
        diagnostics.push(run_speed_hotspot_diagnostic_case(&cases, id, options)?);
    }

    let report = SpeedHotspotDiagnosticReport {
        source_model: "Exact Oliphaunt fixture benchmark SQL files from benchmarks/native/sql.",
        measurement_model: "Each case opens a fresh temporary database, runs all earlier Oliphaunt speed tests outside the measured section, then records the selected speed-test SQL. WASIX diagnostics include FS trace and internal Rust phase timings. Native direct diagnostics run one case per process. Native PostgreSQL diagnostics start a fresh temporary cluster per case and use the same database target as liboliphaunt.",
        wasix_runtime_assets: (options.engine == DiagnosticEngine::WasixLegacy)
            .then(wasix_runtime_asset_report)
            .transpose()?,
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn perf_diagnose_buffer_cache() -> Result<()> {
    Oliphaunt::preload()?;
    let cases = speed_cases(1.0, SpeedSqlSource::OliphauntFixture)?;
    let diagnostics = vec![
        run_buffer_cache_diagnostic_case(
            &cases,
            "11",
            &[
                "BEGIN",
                "INSERT INTO t1 SELECT b,a,c FROM t2",
                "INSERT INTO t2 SELECT b,a,c FROM t1",
                "COMMIT",
            ],
        )?,
        run_buffer_cache_diagnostic_case(&cases, "14", &["INSERT INTO t2 SELECT * FROM t1"])?,
    ];

    let report = BufferCacheDiagnosticReport {
        source_model: "Exact Oliphaunt fixture benchmark SQL files from benchmarks/native/sql.",
        measurement_model: "Each case opens a fresh temporary database, runs all earlier Oliphaunt speed tests outside the measured section, then executes EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the target data-moving statements.",
        wasix_runtime_assets: wasix_runtime_asset_report()?,
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
pub(super) fn perf_diagnose_buffer_cache() -> Result<()> {
    legacy_oliphaunt_unavailable("perf diagnose-buffer-cache")
}

#[cfg(feature = "legacy-oliphaunt")]
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

    let mut builder = Oliphaunt::builder().temporary();
    if let Some(config) = perf_postgres_config_from_env()? {
        builder = builder.postgres_configs(config);
    }
    let mut db = builder
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
        "SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes, current_setting('synchronous_commit') AS synchronous_commit, current_setting('wal_buffers') AS wal_buffers, current_setting('work_mem') AS work_mem",
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
                wal_state: buffer_cache_wal_state_json(&mut db)?,
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
            wal_state: buffer_cache_wal_state_json(&mut db)?,
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

#[cfg(feature = "legacy-oliphaunt")]
fn buffer_cache_wal_state_json(db: &mut Oliphaunt) -> Result<serde_json::Value> {
    exec_rows_json(
        db,
        "SELECT pg_current_wal_insert_lsn()::text AS insert_lsn, pg_current_wal_lsn()::text AS write_lsn, pg_current_wal_flush_lsn()::text AS flush_lsn, pg_wal_lsn_diff(pg_current_wal_insert_lsn(), pg_current_wal_flush_lsn())::bigint AS insert_flush_bytes",
    )
}

#[cfg(feature = "legacy-oliphaunt")]
fn perf_postgres_config_from_env() -> Result<Option<Vec<(String, String)>>> {
    let mut config = Vec::new();
    for (env_name, guc_name) in [
        ("OLIPHAUNT_WASM_PERF_WAL_BUFFERS", "wal_buffers"),
        (
            "OLIPHAUNT_WASM_PERF_SYNCHRONOUS_COMMIT",
            "synchronous_commit",
        ),
        ("OLIPHAUNT_WASM_PERF_FULL_PAGE_WRITES", "full_page_writes"),
    ] {
        let Ok(value) = env::var(env_name) else {
            continue;
        };
        ensure!(
            !value.contains('\0') && !value.trim().is_empty(),
            "{env_name} must be a non-empty PostgreSQL GUC value without NUL bytes"
        );
        config.push((guc_name.to_owned(), value));
    }
    Ok((!config.is_empty()).then_some(config))
}

#[cfg(feature = "legacy-oliphaunt")]
fn exec_rows_json(db: &mut Oliphaunt, sql: &str) -> Result<serde_json::Value> {
    let results = db.exec(sql, None)?;
    Ok(results_to_json(results))
}

#[cfg(feature = "legacy-oliphaunt")]
fn results_to_json(results: Vec<oliphaunt_wasix::Results>) -> serde_json::Value {
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
    options: &SpeedDiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;

    if options.engine == DiagnosticEngine::NativeOliphaunt {
        return run_native_liboliphaunt_speed_hotspot_diagnostic_case(cases, target_index, options);
    }
    if options.engine == DiagnosticEngine::NativePostgres {
        return run_native_postgres_speed_hotspot_diagnostic_case(cases, target_index, options);
    }

    #[cfg(feature = "legacy-oliphaunt")]
    return run_wasix_speed_hotspot_diagnostic_case(cases, target_index, options);

    #[cfg(not(feature = "legacy-oliphaunt"))]
    legacy_oliphaunt_unavailable("perf diagnose-speed-cases --engine wasix")
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_wasix_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    target_index: usize,
    options: &SpeedDiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target = &cases[target_index];
    let mut db = Oliphaunt::builder()
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
        engine: options.engine.label(),
        process_model: "wasix_legacy_embedded_runtime",
        id: target.id.to_owned(),
        label: target.label.clone(),
        open_micros: None,
        connect_micros: None,
        setup_micros,
        elapsed_micros: elapsed.as_micros(),
        operation_count: target.operation_count,
        settings: serde_json::Value::Null,
        observed_server_peak_rss_bytes: None,
        fs_trace,
        phases,
    })
}

fn run_native_postgres_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    target_index: usize,
    options: &SpeedDiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target = &cases[target_index];
    let open_started = Instant::now();
    let tuning = NativeBenchmarkTuning {
        durability: options.durability,
        ..NativeBenchmarkTuning::default()
    };
    let native = NativePostgres::start(&options.postgres_bin, &options.initdb_bin, &tuning)
        .with_context(|| {
            format!(
                "start native Postgres diagnostic database for {}",
                target.id
            )
        })?;
    let open_micros = open_started.elapsed().as_micros();
    let server_pid = native.child.id();
    let mut server_rss = ProcessTreeRssSampler::new(server_pid);
    server_rss.sample();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres speed diagnostic Tokio runtime")?;

    let diagnostic = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, &native);
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres speed diagnostic client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("native Postgres diagnostic connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        for setup_case in &cases[..target_index] {
            client
                .simple_query(&setup_case.sql)
                .await
                .with_context(|| {
                    format!(
                        "run native Postgres diagnostic setup case {}",
                        setup_case.id
                    )
                })?;
            server_rss.sample();
        }
        let setup_micros = setup_started.elapsed().as_micros();

        let started = Instant::now();
        client.simple_query(&target.sql).await.with_context(|| {
            format!("run native Postgres diagnostic measured case {}", target.id)
        })?;
        let elapsed_micros = started.elapsed().as_micros();
        server_rss.sample();
        let settings = client
            .simple_query(speed_diagnostic_settings_sql())
            .await
            .map(|messages| diagnostic_settings_from_simple_query_messages(&messages))
            .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string() }));

        drop(client);
        connection_task.await.ok();

        Ok::<_, anyhow::Error>(SpeedHotspotDiagnosticCase {
            engine: DiagnosticEngine::NativePostgres.label(),
            process_model: "native_postgres_postmaster_control",
            id: target.id.to_owned(),
            label: target.label.clone(),
            open_micros: Some(open_micros),
            connect_micros: Some(connect_micros),
            setup_micros,
            elapsed_micros,
            operation_count: target.operation_count,
            settings,
            observed_server_peak_rss_bytes: server_rss.peak_bytes(),
            fs_trace: serde_json::Value::Null,
            phases: Vec::new(),
        })
    })?;

    drop(native);
    Ok(diagnostic)
}

pub(super) fn speed_diagnostic_settings_sql() -> &'static str {
    "SELECT json_build_object(\
        'server_version', current_setting('server_version'),\
        'shared_buffers', current_setting('shared_buffers'),\
        'fsync', current_setting('fsync'),\
        'full_page_writes', current_setting('full_page_writes'),\
        'synchronous_commit', current_setting('synchronous_commit'),\
        'wal_buffers', current_setting('wal_buffers'),\
        'work_mem', current_setting('work_mem'),\
        'max_worker_processes', current_setting('max_worker_processes'),\
        'max_parallel_workers', current_setting('max_parallel_workers'),\
        'max_parallel_workers_per_gather', current_setting('max_parallel_workers_per_gather'),\
        'autovacuum', current_setting('autovacuum'),\
        'data_directory', current_setting('data_directory')\
    )::text"
}

pub(super) fn diagnostic_settings_from_protocol_response(bytes: &[u8]) -> serde_json::Value {
    match first_protocol_data_row_text_values(bytes).first() {
        Some(json) => serde_json::from_str(json)
            .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string(), "raw": json })),
        None => serde_json::json!({ "error": "settings query did not return a DataRow" }),
    }
}

fn diagnostic_settings_from_simple_query_messages(
    messages: &[tokio_postgres::SimpleQueryMessage],
) -> serde_json::Value {
    for message in messages {
        if let tokio_postgres::SimpleQueryMessage::Row(row) = message {
            let Some(json) = row.get(0) else {
                return serde_json::json!({ "error": "settings row had no first column" });
            };
            return serde_json::from_str(json).unwrap_or_else(
                |error| serde_json::json!({ "error": error.to_string(), "raw": json }),
            );
        }
    }
    serde_json::json!({ "error": "settings query did not return a row" })
}

fn first_protocol_data_row_text_values(mut bytes: &[u8]) -> Vec<String> {
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if len < 4 {
            break;
        }
        let total = 1 + len as usize;
        if bytes.len() < total {
            break;
        }
        if tag == b'D' {
            return parse_protocol_data_row_text_values(&bytes[5..total]);
        }
        bytes = &bytes[total..];
    }
    Vec::new()
}

fn parse_protocol_data_row_text_values(payload: &[u8]) -> Vec<String> {
    if payload.len() < 2 {
        return Vec::new();
    }
    let columns = i16::from_be_bytes([payload[0], payload[1]]);
    if columns < 0 {
        return Vec::new();
    }
    let mut offset = 2;
    let mut values = Vec::with_capacity(columns as usize);
    for _ in 0..columns {
        if payload.len().saturating_sub(offset) < 4 {
            return Vec::new();
        }
        let len = i32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]);
        offset += 4;
        if len == -1 {
            values.push("NULL".to_owned());
            continue;
        }
        if len < 0 {
            return Vec::new();
        }
        let len = len as usize;
        if payload.len().saturating_sub(offset) < len {
            return Vec::new();
        }
        values.push(String::from_utf8_lossy(&payload[offset..offset + len]).into_owned());
        offset += len;
    }
    values
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_indexed_update_diagnostic_case(
    name: &'static str,
    description: &'static str,
    setup_sql: &[&str],
    measured_sql: &str,
    operation_count: usize,
) -> Result<IndexedUpdateDiagnosticCase> {
    let mut db = Oliphaunt::builder()
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

#[cfg(feature = "legacy-oliphaunt")]
fn indexed_update_stats(db: &mut Oliphaunt) -> Result<serde_json::Value> {
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
