use super::*;

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn capture_operation(
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn oliphaunt_wasix_cache_dir() -> Result<PathBuf> {
    ProjectDirs::from("dev", "oliphaunt-wasix", "oliphaunt-wasix")
        .context("could not resolve oliphaunt-wasix cache directory")
        .map(|dirs| dirs.cache_dir().to_path_buf())
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_direct_select_one() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Oliphaunt::builder().temporary().open()?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_direct_vector_query() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Oliphaunt::builder()
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_server_sqlx_select_one() -> Result<()> {
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
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to OliphauntServer")?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_direct_repeated_selects(iterations: usize) -> Result<()> {
    let mut db = Oliphaunt::builder().temporary().open()?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_direct_transaction_batch(iterations: usize) -> Result<()> {
    let mut db = Oliphaunt::builder().temporary().open()?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_direct_repeated_vector_queries(iterations: usize) -> Result<()> {
    let mut db = Oliphaunt::builder()
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

#[cfg(feature = "legacy-oliphaunt")]
fn run_direct_scalar_query(db: &mut Oliphaunt, value: i32) -> Result<()> {
    let result = db.query(
        "SELECT $1::int4 + 1 AS answer",
        &[serde_json::json!(value)],
        None,
    )?;
    ensure_json_int(&result.rows[0]["answer"], value as i64 + 1)
}

#[cfg(feature = "legacy-oliphaunt")]
fn run_direct_vector_distance_query(db: &mut Oliphaunt) -> Result<()> {
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_server_sqlx_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", OliphauntServer::temporary_tcp)?;
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
            .context("connect SQLx to OliphauntServer")?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_server_sqlx_repeated_connections(iterations: usize) -> Result<()> {
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
        for value in 0..iterations {
            let mut conn = sqlx::PgConnection::connect(&uri)
                .await
                .context("connect SQLx to OliphauntServer")?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_server_sqlx_vector_single_connection_repeated_queries(
    iterations: usize,
) -> Result<()> {
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
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to extension-enabled OliphauntServer")?;
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

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_server_tokio_postgres_single_connection_repeated_queries(
    iterations: usize,
) -> Result<()> {
    let server = measure_phase("server.start", OliphauntServer::temporary_tcp)?;
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
            .context("connect tokio-postgres to OliphauntServer")?;
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

#[cfg(feature = "legacy-oliphaunt")]
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

#[cfg(feature = "legacy-oliphaunt")]
async fn run_sqlx_vector_query(conn: &mut sqlx::PgConnection) -> Result<()> {
    let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
        .fetch_one(conn)
        .await
        .context("run SQLx vector query")?;
    let distance: f64 = row.try_get("distance").context("read vector distance")?;
    ensure!(distance == 1.0, "SQLx vector query returned {distance}");
    Ok(())
}

#[cfg(feature = "legacy-oliphaunt")]
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

#[cfg(feature = "legacy-oliphaunt")]
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

#[cfg(feature = "legacy-oliphaunt")]
fn ensure_json_int(value: &serde_json::Value, expected: i64) -> Result<()> {
    let Some(actual) = value.as_i64() else {
        bail!("expected integer JSON value {expected}, got {value}");
    };
    if actual != expected {
        bail!("expected integer JSON value {expected}, got {actual}");
    }
    Ok(())
}
