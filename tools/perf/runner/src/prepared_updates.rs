use super::*;

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn perf_prepared_updates(args: &[String]) -> Result<()> {
    let mut rows = 25_000usize;
    let mut skip_native = false;
    let mut gate = false;
    let mut only_sqlx = false;
    let mut only_direct_raw = false;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--skip-native" => {
                skip_native = true;
            }
            "--gate" => {
                gate = true;
            }
            "--only-sqlx" => {
                only_sqlx = true;
                skip_native = true;
            }
            "--only-direct-raw" => {
                only_direct_raw = true;
                skip_native = true;
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
            other => bail!(
                "unknown perf prepared-updates flag: {other}; use --skip-native, --gate, --rows, --only-sqlx, or --only-direct-raw"
            ),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows must be greater than zero");
    ensure!(
        !(only_sqlx && only_direct_raw),
        "--only-sqlx and --only-direct-raw are mutually exclusive"
    );

    Oliphaunt::preload()?;
    let numeric_updates = parsed_numeric_updates(rows)?;
    let text_updates = parsed_text_updates(rows)?;
    ensure!(
        numeric_updates.len() == rows && text_updates.len() == rows,
        "prepared update parser returned fewer rows than requested"
    );

    let mut runs = Vec::new();
    if !only_direct_raw {
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_server_sqlx",
            "OliphauntServer over TCP using SQLx parameterized queries and SQLx statement cache.",
            || run_oliphaunt_sqlx_prepared_update_tests(&numeric_updates, &text_updates),
        )?);
    }
    if only_direct_raw {
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_direct_raw_pipelined_prepared",
            "Direct embedded Oliphaunt raw frontend/backend protocol with one prepared statement and one pipelined Bind/Execute batch per test.",
            || {
                run_oliphaunt_direct_raw_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    PreparedExecution::Pipelined,
                )
            },
        )?);
    }
    if !only_sqlx && !only_direct_raw {
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_server_tcp_tokio_postgres_prepared",
            "OliphauntServer over TCP using tokio-postgres explicit prepared statements.",
            || {
                run_oliphaunt_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    OliphauntPreparedEndpoint::Tcp,
                    PreparedExecution::Sequential,
                )
            },
        )?);
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_server_tcp_tokio_postgres_pipelined_prepared",
            "OliphauntServer over TCP using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.",
            || {
                run_oliphaunt_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    OliphauntPreparedEndpoint::Tcp,
                    PreparedExecution::Pipelined,
                )
            },
        )?);
    }
    #[cfg(unix)]
    if !only_sqlx && !only_direct_raw {
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_server_unix_tokio_postgres_prepared",
            "OliphauntServer over Unix socket using tokio-postgres explicit prepared statements.",
            || {
                run_oliphaunt_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    OliphauntPreparedEndpoint::Unix,
                    PreparedExecution::Sequential,
                )
            },
        )?);
        runs.push(oliphaunt_prepared_update_run(
            "oliphaunt_server_unix_tokio_postgres_pipelined_prepared",
            "OliphauntServer over Unix socket using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.",
            || run_oliphaunt_tokio_prepared_update_tests(
                &numeric_updates,
                &text_updates,
                OliphauntPreparedEndpoint::Unix,
                PreparedExecution::Pipelined,
            ),
        )?);
    }
    let mut native_tuning_report = None;
    if !skip_native {
        let native_postgres = env::var("OLIPHAUNT_POSTGRES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("postgres"));
        let native_initdb = env::var("OLIPHAUNT_INITDB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("initdb"));
        let native_tuning = NativeBenchmarkTuning::default();
        runs.push(PreparedUpdateRun {
            mode: "native_tokio_postgres_prepared".to_owned(),
            description:
                "Native Postgres over Unix socket using tokio-postgres explicit prepared statements."
                    .to_owned(),
            protocol_stats: None,
            tests: run_native_prepared_update_tests(
                &native_postgres,
                &native_initdb,
                &native_tuning,
                &numeric_updates,
                &text_updates,
                PreparedExecution::Sequential,
            )?,
        });
        runs.push(PreparedUpdateRun {
            mode: "native_tokio_postgres_pipelined_prepared".to_owned(),
            description: "Native Postgres over Unix socket using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.".to_owned(),
            protocol_stats: None,
            tests: run_native_prepared_update_tests(
                &native_postgres,
                &native_initdb,
                &native_tuning,
                &numeric_updates,
                &text_updates,
                PreparedExecution::Pipelined,
            )?,
        });
        native_tuning_report = Some(native_tuning.report());
    }

    let report = PreparedUpdateReport {
        source_model: "Exact Oliphaunt fixture benchmark2/benchmark6 setup plus update values parsed from benchmark9 and benchmark10.",
        measurement_model: "Each test uses a fresh database, creates the same indexed t2 table, prepares one parameterized UPDATE statement, then executes N updates inside one transaction. Oliphaunt server runs use one local server per test; native Postgres uses a temporary Unix-socket cluster with the same benchmark GUCs as perf native-postgres.",
        gate_model: gate.then_some("Optional local regression gate for oliphaunt-wasix server prepared-update transport: SQLx and sequential tokio-postgres must stay below 5s per 25k rows, pipelined tokio-postgres must stay below 1.5s per 25k rows, non-COPY prepared traffic must not use streaming handoff, and pipelined prepared traffic must stay batched. Thresholds scale linearly with --rows."),
        wasix_runtime_assets: Some(wasix_runtime_asset_report()?),
        native_tuning: native_tuning_report,
        rows,
        runs,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    if gate {
        validate_prepared_update_gate(&report)?;
    }
    Ok(())
}

#[cfg(not(feature = "legacy-oliphaunt"))]
pub(super) fn perf_prepared_updates(args: &[String]) -> Result<()> {
    let _ = args;
    legacy_oliphaunt_unavailable("perf prepared-updates")
}

#[cfg(feature = "legacy-oliphaunt")]
fn oliphaunt_prepared_update_run(
    mode: &'static str,
    description: &'static str,
    run: impl FnOnce() -> Result<Vec<PreparedUpdateTest>>,
) -> Result<PreparedUpdateRun> {
    reset_protocol_stats();
    let tests = match run() {
        Ok(tests) => tests,
        Err(err) => {
            disable_protocol_stats();
            return Err(err);
        }
    };
    let protocol_stats = Some(protocol_stats_snapshot());
    disable_protocol_stats();
    Ok(PreparedUpdateRun {
        mode: mode.to_owned(),
        description: description.to_owned(),
        protocol_stats,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
fn validate_prepared_update_gate(report: &PreparedUpdateReport) -> Result<()> {
    let scale = report.rows as f64 / 25_000_f64;
    for run in &report.runs {
        let Some(base_limit_micros) = prepared_update_limit_micros(&run.mode) else {
            continue;
        };
        let limit = (base_limit_micros as f64 * scale).ceil() as u128;
        for test in &run.tests {
            ensure!(
                test.elapsed_micros <= limit,
                "prepared-update gate failed for {} {}: {:.3}ms > {:.3}ms",
                run.mode,
                test.id,
                test.elapsed_micros as f64 / 1_000.0,
                limit as f64 / 1_000.0
            );
        }
        if let Some(stats) = run.protocol_stats.as_ref() {
            ensure!(
                stats.streaming_copy_handoffs == 0,
                "prepared-update gate failed for {}: non-COPY traffic used streaming handoff",
                run.mode
            );
        }
        if run.mode.contains("pipelined") {
            let stats = run
                .protocol_stats
                .as_ref()
                .context("missing protocol stats for pipelined prepared-update run")?;
            ensure!(
                stats.protocol_batches < 1_000,
                "prepared-update gate failed for {}: pipelined traffic was not batched ({} protocol batches)",
                run.mode,
                stats.protocol_batches
            );
        }
    }
    Ok(())
}

#[cfg(feature = "legacy-oliphaunt")]
fn prepared_update_limit_micros(mode: &str) -> Option<u128> {
    if mode.starts_with("native_") {
        return None;
    }
    if mode.contains("pipelined") {
        Some(1_500_000)
    } else {
        Some(5_000_000)
    }
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_oliphaunt_sqlx_prepared_update_tests(
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-update SQLx Tokio runtime")?;

    let numeric = run_oliphaunt_sqlx_prepared_update_case(
        &runtime,
        "numeric_indexed",
        "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
        "UPDATE t2 SET b=$1 WHERE a=$2",
        PreparedUpdateValues::Numeric(numeric_updates),
    )?;
    let text = run_oliphaunt_sqlx_prepared_update_case(
        &runtime,
        "text_indexed",
        "Parameterized text UPDATEs with indexes on lookup and numeric column",
        "UPDATE t2 SET c=$1 WHERE a=$2",
        PreparedUpdateValues::Text(text_updates),
    )?;
    Ok(vec![numeric, text])
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_oliphaunt_direct_raw_prepared_update_tests(
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    Ok(vec![
        run_oliphaunt_direct_raw_prepared_update_case(
            "numeric_indexed",
            "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
            "UPDATE t2 SET b=$1 WHERE a=$2",
            &[23, 23],
            DirectRawPreparedValues::Numeric(numeric_updates),
            execution,
        )?,
        run_oliphaunt_direct_raw_prepared_update_case(
            "text_indexed",
            "Parameterized text UPDATEs with indexes on lookup and numeric column",
            "UPDATE t2 SET c=$1 WHERE a=$2",
            &[25, 23],
            DirectRawPreparedValues::Text(text_updates),
            execution,
        )?,
    ])
}

#[cfg(feature = "legacy-oliphaunt")]
enum DirectRawPreparedValues<'a> {
    Numeric(&'a [(i32, i32)]),
    Text(&'a [(i32, String)]),
}

#[cfg(feature = "legacy-oliphaunt")]
impl DirectRawPreparedValues<'_> {
    fn len(&self) -> usize {
        match self {
            Self::Numeric(values) => values.len(),
            Self::Text(values) => values.len(),
        }
    }
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_oliphaunt_direct_raw_prepared_update_case(
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    param_oids: &[i32],
    values: DirectRawPreparedValues<'_>,
    execution: PreparedExecution,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let mut db = Oliphaunt::builder()
        .temporary()
        .open()
        .context("open direct raw prepared-update database")?;
    let open_micros = open_started.elapsed().as_micros();
    let operation_count = values.len();

    let setup_started = Instant::now();
    db.exec(&read_oliphaunt_benchmark_sql("2")?, None)
        .context("execute direct raw prepared-update setup benchmark2")?;
    db.exec(&read_oliphaunt_benchmark_sql("6")?, None)
        .context("execute direct raw prepared-update setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let statement_name = "oliphaunt_bench_update";
    let mut prepare = Vec::new();
    prepare.extend(pg_parse(Some(statement_name), sql, param_oids));
    prepare.extend(pg_describe(b'S', Some(statement_name)));
    prepare.extend(pg_sync());
    let prepare_started = Instant::now();
    exec_wasix_raw_checked(
        &mut db,
        &prepare,
        "prepare direct raw prepared-update statement",
    )?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    exec_wasix_raw_checked(&mut db, &pg_query("BEGIN"), "begin direct raw transaction")?;
    match values {
        DirectRawPreparedValues::Numeric(updates) => execute_wasix_direct_raw_prepared_updates(
            &mut db,
            statement_name,
            execution,
            updates
                .iter()
                .map(|(lookup, value)| [value.to_string(), lookup.to_string()]),
        )?,
        DirectRawPreparedValues::Text(updates) => execute_wasix_direct_raw_prepared_updates(
            &mut db,
            statement_name,
            execution,
            updates
                .iter()
                .map(|(lookup, value)| [value.clone(), lookup.to_string()]),
        )?,
    }
    exec_wasix_raw_checked(
        &mut db,
        &pg_query("COMMIT"),
        "commit direct raw transaction",
    )?;
    let elapsed = started.elapsed();

    db.close()
        .context("close direct raw prepared-update database")?;
    Ok(PreparedUpdateTest {
        id,
        label,
        open_micros,
        connect_micros: 0,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        average_micros: elapsed.as_micros() as f64 / operation_count as f64,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
fn execute_wasix_direct_raw_prepared_updates<I>(
    db: &mut Oliphaunt,
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
                exec_wasix_raw_checked(
                    db,
                    &batch,
                    "execute sequential direct raw prepared update",
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
            exec_wasix_raw_checked(db, &batch, "execute pipelined direct raw prepared updates")?;
        }
    }
    Ok(())
}

#[cfg(feature = "legacy-oliphaunt")]
fn exec_wasix_raw_checked(db: &mut Oliphaunt, message: &[u8], context: &'static str) -> Result<()> {
    let response = db
        .exec_protocol_raw(message, ExecProtocolOptions::no_sync())
        .with_context(|| context)?;
    ensure_protocol_response_ok(&response).with_context(|| context)
}

#[cfg(feature = "legacy-oliphaunt")]
enum PreparedUpdateValues<'a> {
    Numeric(&'a [(i32, i32)]),
    Text(&'a [(i32, String)]),
}

#[cfg(feature = "legacy-oliphaunt")]
impl PreparedUpdateValues<'_> {
    fn len(&self) -> usize {
        match self {
            Self::Numeric(values) => values.len(),
            Self::Text(values) => values.len(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreparedExecution {
    Sequential,
    Pipelined,
}

#[cfg(feature = "legacy-oliphaunt")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OliphauntPreparedEndpoint {
    Tcp,
    #[cfg(unix)]
    Unix,
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_oliphaunt_sqlx_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    values: PreparedUpdateValues<'_>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let server = OliphauntServer::temporary_tcp()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let operation_count = values.len();

    let test = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx prepared-update client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        conn.execute(read_oliphaunt_benchmark_sql("2")?.as_str())
            .await
            .context("execute prepared-update SQLx setup benchmark2")?;
        conn.execute(read_oliphaunt_benchmark_sql("6")?.as_str())
            .await
            .context("execute prepared-update SQLx setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let prepare_started = Instant::now();
        let _statement = conn
            .prepare(sql)
            .await
            .with_context(|| format!("prepare SQLx statement {sql}"))?;
        let prepare_micros = prepare_started.elapsed().as_micros();

        let elapsed = measure_async_transaction_sqlx(&mut conn, sql, values).await?;
        conn.close()
            .await
            .context("close SQLx prepared-update client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: Some(prepare_micros),
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
        })
    })?;
    server.shutdown()?;
    Ok(test)
}

#[cfg(feature = "legacy-oliphaunt")]
async fn measure_async_transaction_sqlx(
    conn: &mut sqlx::PgConnection,
    sql: &'static str,
    values: PreparedUpdateValues<'_>,
) -> Result<Duration> {
    let started = Instant::now();
    conn.execute("BEGIN")
        .await
        .context("begin SQLx transaction")?;
    match values {
        PreparedUpdateValues::Numeric(values) => {
            for (lookup, value) in values {
                sqlx::query(sql)
                    .bind(*value)
                    .bind(*lookup)
                    .execute(&mut *conn)
                    .await
                    .context("execute SQLx prepared numeric update")?;
            }
        }
        PreparedUpdateValues::Text(values) => {
            for (lookup, value) in values {
                sqlx::query(sql)
                    .bind(value.as_str())
                    .bind(*lookup)
                    .execute(&mut *conn)
                    .await
                    .context("execute SQLx prepared text update")?;
            }
        }
    }
    conn.execute("COMMIT")
        .await
        .context("commit SQLx transaction")?;
    Ok(started.elapsed())
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_oliphaunt_tokio_prepared_update_tests(
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    endpoint: OliphauntPreparedEndpoint,
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-update tokio-postgres runtime")?;

    Ok(vec![
        run_oliphaunt_tokio_prepared_update_case(
            &runtime,
            "numeric_indexed",
            "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
            "UPDATE t2 SET b=$1 WHERE a=$2",
            numeric_updates,
            None,
            endpoint,
            execution,
        )?,
        run_oliphaunt_tokio_prepared_update_case(
            &runtime,
            "text_indexed",
            "Parameterized text UPDATEs with indexes on lookup and numeric column",
            "UPDATE t2 SET c=$1 WHERE a=$2",
            &[],
            Some(text_updates),
            endpoint,
            execution,
        )?,
    ])
}

#[cfg(feature = "legacy-oliphaunt")]
#[allow(clippy::too_many_arguments)]
fn run_oliphaunt_tokio_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    endpoint: OliphauntPreparedEndpoint,
    execution: PreparedExecution,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let server = start_prepared_update_oliphaunt_server(endpoint)?;
    let open_micros = open_started.elapsed().as_micros();
    let connection = oliphaunt_prepared_update_connection(&server, endpoint)?;
    #[cfg(unix)]
    let cleanup_socket_dir = match &connection {
        PreparedOliphauntConnection::Tcp(_) => None,
        PreparedOliphauntConnection::Unix { socket_dir, .. } => Some(socket_dir.clone()),
    };

    let test = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        config.user("postgres").dbname("template1");
        match &connection {
            PreparedOliphauntConnection::Tcp(addr) => {
                config.host(addr.ip().to_string()).port(addr.port());
            }
            #[cfg(unix)]
            PreparedOliphauntConnection::Unix { socket_dir, port } => {
                config.host_path(socket_dir).port(*port);
            }
        }
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres prepared-update client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("prepared-update oliphaunt connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let result = run_tokio_prepared_update_case_on_client(
            &client,
            id,
            label,
            sql,
            numeric_updates,
            text_updates,
            execution,
            open_micros,
            connect_micros,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })?;
    server.shutdown()?;
    #[cfg(unix)]
    if let Some(socket_dir) = cleanup_socket_dir {
        let _ = fs::remove_dir_all(socket_dir);
    }
    Ok(test)
}

#[cfg(feature = "legacy-oliphaunt")]
fn start_prepared_update_oliphaunt_server(
    endpoint: OliphauntPreparedEndpoint,
) -> Result<OliphauntServer> {
    match endpoint {
        OliphauntPreparedEndpoint::Tcp => OliphauntServer::temporary_tcp(),
        #[cfg(unix)]
        OliphauntPreparedEndpoint::Unix => {
            let socket_dir = env::current_dir()
                .context("read current directory")?
                .join("target/perf")
                .join(format!(
                    "oliphaunt-prepared-unix-{}-{}",
                    std::process::id(),
                    now_micros()?
                ));
            let port = 5432;
            let socket_path = socket_dir.join(format!(".s.PGSQL.{port}"));
            OliphauntServer::builder()
                .temporary()
                .unix(socket_path)
                .start()
        }
    }
}

#[cfg(feature = "legacy-oliphaunt")]
enum PreparedOliphauntConnection {
    Tcp(std::net::SocketAddr),
    #[cfg(unix)]
    Unix {
        socket_dir: PathBuf,
        port: u16,
    },
}

#[cfg(feature = "legacy-oliphaunt")]
fn oliphaunt_prepared_update_connection(
    server: &OliphauntServer,
    endpoint: OliphauntPreparedEndpoint,
) -> Result<PreparedOliphauntConnection> {
    match endpoint {
        OliphauntPreparedEndpoint::Tcp => {
            let addr = server
                .tcp_addr()
                .ok_or_else(|| anyhow!("prepared-update OliphauntServer did not bind TCP"))?;
            Ok(PreparedOliphauntConnection::Tcp(addr))
        }
        #[cfg(unix)]
        OliphauntPreparedEndpoint::Unix => {
            let socket_path = server.socket_path().ok_or_else(|| {
                anyhow!("prepared-update OliphauntServer did not bind Unix socket")
            })?;
            let socket_dir = socket_path
                .parent()
                .ok_or_else(|| anyhow!("prepared-update Unix socket has no parent directory"))?
                .to_path_buf();
            let port = socket_path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(".s.PGSQL."))
                .ok_or_else(|| {
                    anyhow!(
                        "prepared-update Unix socket path is not libpq-shaped: {}",
                        socket_path.display()
                    )
                })?
                .parse()
                .context("parse prepared-update Unix socket port")?;
            Ok(PreparedOliphauntConnection::Unix { socket_dir, port })
        }
    }
}

pub(super) fn run_native_prepared_update_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    tuning: &NativeBenchmarkTuning,
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native prepared-update Tokio runtime")?;

    Ok(vec![
        run_native_prepared_update_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            tuning,
            "numeric_indexed",
            "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
            "UPDATE t2 SET b=$1 WHERE a=$2",
            numeric_updates,
            None,
            execution,
        )?,
        run_native_prepared_update_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            tuning,
            "text_indexed",
            "Parameterized text UPDATEs with indexes on lookup and numeric column",
            "UPDATE t2 SET c=$1 WHERE a=$2",
            &[],
            Some(text_updates),
            execution,
        )?,
    ])
}

#[allow(clippy::too_many_arguments)]
fn run_native_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    tuning: &NativeBenchmarkTuning,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    execution: PreparedExecution,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin, tuning)?;
    let open_micros = open_started.elapsed().as_micros();

    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, &native);
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native prepared-update client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("native prepared-update connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let result = run_tokio_prepared_update_case_on_client(
            &client,
            id,
            label,
            sql,
            numeric_updates,
            text_updates,
            execution,
            open_micros,
            connect_micros,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_tokio_prepared_update_case_on_client(
    client: &tokio_postgres::Client,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    execution: PreparedExecution,
    open_micros: u128,
    connect_micros: u128,
) -> Result<PreparedUpdateTest> {
    let setup_started = Instant::now();
    client
        .simple_query(&read_oliphaunt_benchmark_sql("2")?)
        .await
        .context("execute prepared-update setup benchmark2")?;
    client
        .simple_query(&read_oliphaunt_benchmark_sql("6")?)
        .await
        .context("execute prepared-update setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let prepare_started = Instant::now();
    let statement = client
        .prepare(sql)
        .await
        .with_context(|| format!("prepare tokio-postgres statement {sql}"))?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    client
        .simple_query("BEGIN")
        .await
        .context("begin tokio-postgres prepared-update transaction")?;
    let operation_count = if let Some(text_updates) = text_updates {
        match execution {
            PreparedExecution::Sequential => {
                for (lookup, value) in text_updates {
                    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [value, lookup];
                    client
                        .execute(&statement, &params)
                        .await
                        .context("execute tokio-postgres prepared text update")?;
                }
            }
            PreparedExecution::Pipelined => {
                let updates = text_updates.iter().map(|(lookup, value)| {
                    let statement = &statement;
                    async move {
                        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] =
                            [value, lookup];
                        client.execute(statement, &params).await
                    }
                });
                try_join_all(updates)
                    .await
                    .context("execute pipelined tokio-postgres prepared text updates")?;
            }
        }
        text_updates.len()
    } else {
        match execution {
            PreparedExecution::Sequential => {
                for (lookup, value) in numeric_updates {
                    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [value, lookup];
                    client
                        .execute(&statement, &params)
                        .await
                        .context("execute tokio-postgres prepared numeric update")?;
                }
            }
            PreparedExecution::Pipelined => {
                let updates = numeric_updates.iter().map(|(lookup, value)| {
                    let statement = &statement;
                    async move {
                        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] =
                            [value, lookup];
                        client.execute(statement, &params).await
                    }
                });
                try_join_all(updates)
                    .await
                    .context("execute pipelined tokio-postgres prepared numeric updates")?;
            }
        }
        numeric_updates.len()
    };
    client
        .simple_query("COMMIT")
        .await
        .context("commit tokio-postgres prepared-update transaction")?;
    let elapsed = started.elapsed();

    Ok(PreparedUpdateTest {
        id,
        label,
        open_micros,
        connect_micros,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        average_micros: elapsed.as_micros() as f64 / operation_count as f64,
    })
}

pub(super) fn parsed_numeric_updates(limit: usize) -> Result<Vec<(i32, i32)>> {
    let sql = read_oliphaunt_benchmark_sql("9")?;
    let mut updates = Vec::with_capacity(limit);
    for line in sql.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("UPDATE t2 SET b=") else {
            continue;
        };
        let rest = rest
            .strip_suffix(';')
            .ok_or_else(|| anyhow!("numeric update line is missing semicolon: {line}"))?;
        let (value, lookup) = rest
            .split_once(" WHERE a=")
            .ok_or_else(|| anyhow!("numeric update line has unexpected shape: {line}"))?;
        updates.push((lookup.parse()?, value.parse()?));
        if updates.len() == limit {
            break;
        }
    }
    ensure!(
        updates.len() == limit,
        "benchmark9 only contained {} update rows; requested {limit}",
        updates.len()
    );
    Ok(updates)
}

pub(super) fn parsed_text_updates(limit: usize) -> Result<Vec<(i32, String)>> {
    let sql = read_oliphaunt_benchmark_sql("10")?;
    let mut updates = Vec::with_capacity(limit);
    for line in sql.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("UPDATE t2 SET c='") else {
            continue;
        };
        let rest = rest
            .strip_suffix(';')
            .ok_or_else(|| anyhow!("text update line is missing semicolon: {line}"))?;
        let (value, lookup) = rest
            .split_once("' WHERE a=")
            .ok_or_else(|| anyhow!("text update line has unexpected shape: {line}"))?;
        updates.push((lookup.parse()?, value.to_owned()));
        if updates.len() == limit {
            break;
        }
    }
    ensure!(
        updates.len() == limit,
        "benchmark10 only contained {} update rows; requested {limit}",
        updates.len()
    );
    Ok(updates)
}
