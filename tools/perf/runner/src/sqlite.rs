use super::*;

pub(super) fn perf_sqlite(args: &[String]) -> Result<()> {
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::OliphauntFixture;
    let mut speed_scale = 1.0_f64;
    let mut durability = NativeDurabilityProfile::Safe;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    "backup" | "backup-restore" | "backup_restore" => {
                        BenchmarkSuiteFilter::BackupRestore
                    }
                    other => {
                        bail!(
                            "unknown --suite value {other:?}; sqlite currently supports speed or backup-restore"
                        )
                    }
                };
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
            "--scale" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--scale requires a value"))?;
                speed_scale = value
                    .parse()
                    .with_context(|| format!("parse --scale value {value:?}"))?;
            }
            "--durability" => {
                cursor += 1;
                durability = parse_native_durability(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--durability requires a value"))?,
                )?;
            }
            other => bail!("unknown perf sqlite flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(speed_scale > 0.0, "--scale must be greater than zero");

    let mut runs = Vec::new();
    if suite.includes("speed") {
        runs.push(run_sqlite_speed_benchmark(
            speed_scale,
            speed_sql_source,
            durability,
        )?);
    }
    if suite.includes("backup-restore") {
        runs.push(run_sqlite_backup_restore_benchmark(durability)?);
    }
    let report = BenchmarkReport {
        wasmer_version: "sqlite",
        wasmer_wasix_version: "sqlite",
        wasix_runtime_assets: None,
        source_model: speed_sql_source.source_model(),
        measurement_model: "SQLite control. xtask opens one temporary file-backed SQLite database in-process through rusqlite, applies an explicit durability profile through PRAGMA settings, then executes the selected speed or backup/restore suite.",
        native_tuning: None,
        rtt_iterations: 0,
        speed_scale,
        preload_micros: 0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_sqlite_speed_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
    durability: NativeDurabilityProfile,
) -> Result<BenchmarkRun> {
    let root = unique_perf_root("sqlite-speed")?;
    let database_path = root.join("benchmark.sqlite3");
    let open_started = Instant::now();
    let conn = rusqlite::Connection::open(&database_path)
        .with_context(|| format!("open SQLite benchmark database {}", database_path.display()))?;
    apply_sqlite_durability(&conn, durability)?;
    let open_micros = open_started.elapsed().as_micros();

    let mut tests = Vec::new();
    let run_result = (|| -> Result<()> {
        for case in speed_cases(scale, sql_source)? {
            let started = Instant::now();
            conn.execute_batch(&case.sql)
                .with_context(|| format!("execute SQLite speed benchmark {}", case.id))?;
            tests.push(single_sample_result(
                case.id,
                case.label,
                "seconds",
                case.operation_count,
                started.elapsed(),
            ));
        }
        Ok(())
    })();
    let cleanup_result = fs::remove_dir_all(&root)
        .with_context(|| format!("remove SQLite benchmark root {}", root.display()));
    run_result?;
    cleanup_result?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "sqlite",
        description: "File-backed SQLite control using rusqlite and the same speed SQL batches as the native matrix.",
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn run_sqlite_backup_restore_benchmark(
    durability: NativeDurabilityProfile,
) -> Result<BenchmarkRun> {
    let root = unique_perf_root("sqlite-backup")?;
    let database_path = root.join("backup.sqlite3");
    let backup_path = root.join("backup-copy.sqlite3");
    let restore_path = root.join("restored.sqlite3");

    let open_started = Instant::now();
    let conn = rusqlite::Connection::open(&database_path)
        .with_context(|| format!("open SQLite backup database {}", database_path.display()))?;
    apply_sqlite_durability(&conn, durability)?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    conn.execute_batch(&sqlite_backup_restore_setup_sql())
        .context("execute SQLite backup/restore setup")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let backup_started = Instant::now();
    conn.execute_batch(&format!(
        "VACUUM INTO {};",
        sqlite_string_literal(&backup_path.display().to_string())
    ))
    .context("run SQLite VACUUM INTO backup")?;
    let backup_elapsed = backup_started.elapsed();
    let backup_bytes = fs::metadata(&backup_path)
        .with_context(|| format!("stat SQLite backup {}", backup_path.display()))?
        .len() as usize;

    let restore_started = Instant::now();
    fs::copy(&backup_path, &restore_path).with_context(|| {
        format!(
            "copy SQLite backup {} to restore target {}",
            backup_path.display(),
            restore_path.display()
        )
    })?;
    let restored = rusqlite::Connection::open(&restore_path)
        .with_context(|| format!("open restored SQLite database {}", restore_path.display()))?;
    let count: i64 = restored
        .query_row("SELECT count(*) FROM backup_restore_items", [], |row| {
            row.get(0)
        })
        .context("verify SQLite restored row count")?;
    ensure!(
        count == BACKUP_RESTORE_EXPECTED_ROWS as i64,
        "SQLite restored row count mismatch: got {count}, expected {BACKUP_RESTORE_EXPECTED_ROWS}"
    );
    let restore_elapsed = restore_started.elapsed();

    drop(restored);
    drop(conn);
    fs::remove_dir_all(&root)
        .with_context(|| format!("remove SQLite backup root {}", root.display()))?;

    Ok(BenchmarkRun {
        suite: "backup-restore",
        mode: "sqlite",
        description: "File-backed SQLite backup/restore control using VACUUM INTO for a consistent backup image and file-copy restore.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests: vec![
            single_sample_result(
                "sqlite_vacuum_into_backup",
                format!(
                    "SQLite VACUUM INTO backup; backup size {}",
                    fmt_bytes_label(backup_bytes)
                ),
                "seconds",
                backup_bytes,
                backup_elapsed,
            ),
            single_sample_result(
                "sqlite_file_restore",
                format!(
                    "SQLite file restore; backup size {}",
                    fmt_bytes_label(backup_bytes)
                ),
                "seconds",
                backup_bytes,
                restore_elapsed,
            ),
        ],
    })
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn apply_sqlite_durability(
    conn: &rusqlite::Connection,
    durability: NativeDurabilityProfile,
) -> Result<()> {
    let pragma_sql = match durability {
        NativeDurabilityProfile::Safe => {
            "PRAGMA journal_mode=WAL;\nPRAGMA synchronous=FULL;\nPRAGMA temp_store=MEMORY;\n"
        }
        NativeDurabilityProfile::Balanced => {
            "PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\nPRAGMA temp_store=MEMORY;\n"
        }
        NativeDurabilityProfile::FastDev => {
            "PRAGMA journal_mode=MEMORY;\nPRAGMA synchronous=OFF;\nPRAGMA temp_store=MEMORY;\n"
        }
    };
    conn.execute_batch(pragma_sql)
        .context("apply SQLite benchmark durability PRAGMAs")
}
