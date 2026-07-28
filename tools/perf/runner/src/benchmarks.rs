use super::*;

pub(super) fn read_oliphaunt_benchmark_sql(id: &str) -> Result<String> {
    let path = Path::new(OLIPHAUNT_BENCHMARK_SQL_DIR).join(format!("benchmark{id}.sql"));
    fs::read_to_string(&path)
        .with_context(|| format!("read Oliphaunt benchmark SQL {}", path.display()))
}

pub(super) struct RttCase {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) sql: String,
}

pub(super) struct SpeedCase {
    pub(super) id: &'static str,
    pub(super) label: String,
    pub(super) sql: String,
    pub(super) operation_count: usize,
}

pub(super) struct StreamingCase {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) sql: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SpeedSqlSource {
    Generated,
    OliphauntFixture,
}

impl SpeedSqlSource {
    pub(super) fn source_model(self) -> &'static str {
        match self {
            SpeedSqlSource::Generated => {
                "Mirrors the two Oliphaunt benchmark families documented at https://oliphaunt.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and a SQLite speedtest-style SQL suite. The speed suite is generated locally instead of vendoring Oliphaunt's generated SQL files."
            }
            SpeedSqlSource::OliphauntFixture => {
                "Mirrors the two Oliphaunt benchmark families documented at https://oliphaunt.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and the exact SQL files from benchmarks/native/sql."
            }
        }
    }
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_rtt_direct_benchmark(iterations: usize) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Oliphaunt::builder().temporary().open()?;
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
        description: "Oliphaunt direct Rust API, matching Oliphaunt's in-process exec-style benchmark shape.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_rtt_server_sqlx_benchmark(iterations: usize) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_oliphaunt_server()?;
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
        description: "OliphauntServer over the Postgres wire protocol using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_rtt_server_tokio_postgres_simple_benchmark(
    iterations: usize,
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_oliphaunt_server()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create tokio-postgres simple RTT runtime")?;

    let (connect_micros, setup_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres simple RTT client")?;
        let connection_handle = tokio::spawn(connection);
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        client
            .batch_execute(rtt_setup_sql())
            .await
            .context("execute RTT setup over tokio-postgres simple-query protocol")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let mut tests = Vec::new();
        for case in rtt_cases() {
            let mut samples = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let started = Instant::now();
                client.batch_execute(&case.sql).await.with_context(|| {
                    format!(
                        "execute RTT benchmark {} over tokio-postgres simple-query protocol",
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

        drop(client);
        connection_handle
            .await
            .context("join tokio-postgres simple RTT connection task")?
            .context("tokio-postgres simple RTT connection task")?;
        Ok::<_, anyhow::Error>((connect_micros, setup_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "server_tokio_postgres_simple",
        description: "OliphauntServer over the Postgres wire protocol using one long-lived tokio-postgres connection and the simple-query protocol without SQLx.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_speed_direct_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Oliphaunt::builder().temporary().open()?;
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
        description: "Generated SQLite speedtest-style SQL suite through Oliphaunt direct Rust API.",
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn run_speed_server_sqlx_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_oliphaunt_server()?;
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
        description: "Generated SQLite speedtest-style SQL suite through one SQLx connection to OliphauntServer.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

#[cfg(feature = "legacy-oliphaunt")]
fn benchmark_oliphaunt_server() -> Result<OliphauntServer> {
    OliphauntServer::builder()
        .temporary()
        .database("postgres")
        .start()
}

pub(super) fn rtt_setup_sql() -> &'static str {
    "\
CREATE TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);
CREATE TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);
"
}

pub(super) fn rtt_cases() -> Vec<RttCase> {
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

pub(super) fn streaming_cases() -> &'static [StreamingCase] {
    &[
        StreamingCase {
            id: "large_text_8mb",
            label: "Large text result, approximately 8 MiB of row payload",
            sql: "SELECT i, repeat('x', 1024) AS payload FROM generate_series(1, 8192) AS i",
        },
        StreamingCase {
            id: "wide_text_16mb",
            label: "Wide text result, approximately 16 MiB of row payload",
            sql: "SELECT repeat('y', 1048576) AS payload FROM generate_series(1, 16)",
        },
        StreamingCase {
            id: "copy_out_8mb",
            label: "COPY TO STDOUT result, approximately 8 MiB of CopyData payload",
            sql: "COPY (SELECT i, repeat('c', 1024) AS payload FROM generate_series(1, 8192) AS i) TO STDOUT",
        },
    ]
}

#[cfg(feature = "legacy-oliphaunt")]
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

pub(super) fn samples_result(
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
    let p90 = percentile_sorted(&sorted, 0.90);
    let p95 = percentile_sorted(&sorted, 0.95);
    let p99 = percentile_sorted(&sorted, 0.99);
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
        p90_micros: p90,
        p95_micros: p95,
        p99_micros: p99,
    }
}

pub(super) fn single_sample_result(
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
        p90_micros: Some(elapsed_micros),
        p95_micros: Some(elapsed_micros),
        p99_micros: Some(elapsed_micros),
    }
}

fn percentile_sorted(sorted: &[u128], percentile: f64) -> Option<u128> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * percentile).round() as usize;
    sorted.get(idx).copied()
}

pub(super) fn speed_cases(scale: f64, sql_source: SpeedSqlSource) -> Result<Vec<SpeedCase>> {
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

    if sql_source == SpeedSqlSource::OliphauntFixture {
        let benchmark_dir = Path::new(OLIPHAUNT_BENCHMARK_SQL_DIR);
        for case in &mut cases {
            let path = benchmark_dir.join(format!("benchmark{}.sql", case.id));
            case.sql = fs::read_to_string(&path)
                .with_context(|| format!("read Oliphaunt benchmark SQL {}", path.display()))?;
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
