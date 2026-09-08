use super::*;

pub(super) fn perf_diagnose_speed_cases(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    let mut engine = DiagnosticEngine::NativeOliphaunt;
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
    NativeOliphaunt,
    NativePostgres,
}

impl DiagnosticEngine {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "native" | "native-liboliphaunt" | "liboliphaunt" => Ok(Self::NativeOliphaunt),
            "native-postgres" | "postgres" | "pg" => Ok(Self::NativePostgres),
            other => bail!(
                "unknown diagnostic engine {other:?}; use native-liboliphaunt or native-postgres"
            ),
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
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
    if options.engine == DiagnosticEngine::NativeOliphaunt {
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
        measurement_model: "Each case opens a fresh disposable database, runs all earlier Oliphaunt speed tests outside the measured section, then records the selected speed-test SQL. Native direct diagnostics run one case per process. Native PostgreSQL diagnostics start a fresh temporary cluster per case and use the same database target as liboliphaunt.",
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
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
    run_native_postgres_speed_hotspot_diagnostic_case(cases, target_index, options)
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
