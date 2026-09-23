use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreparedExecution {
    Sequential,
    Pipelined,
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
