use super::*;

pub(super) fn run_native_postgres_streaming_benchmark(
    native: &NativePostgres,
    open_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let connect_started = Instant::now();
    let mut client = NativePostgresRawClient::connect(native)?;
    let connect_micros = connect_started.elapsed().as_micros();
    server_rss.sample();

    let mut tests = Vec::new();
    for case in streaming_cases() {
        let mut bytes = 0usize;
        let mut chunks = 0usize;
        let started = Instant::now();
        client.exec_streaming(case.sql, |chunk| {
            bytes = bytes.saturating_add(chunk.len());
            chunks = chunks.saturating_add(1);
            Ok(())
        })?;
        tests.push(single_sample_result(
            case.id,
            format!(
                "{}; streamed {bytes} bytes across {chunks} protocol frame(s)",
                case.label
            ),
            "seconds",
            bytes,
            started.elapsed(),
        ));
        server_rss.sample();
    }
    client.terminate()?;

    Ok(BenchmarkRun {
        suite: "streaming",
        mode: "native_postgres_raw",
        description: "Native Postgres streaming control over the raw PostgreSQL wire protocol against the liboliphaunt-matched template1 database target.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

pub(super) fn run_native_postgres_backup_restore_benchmark(
    native: &NativePostgres,
    postgres_bin: &Path,
    open_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres backup/restore Tokio runtime")?;
    let setup_started = Instant::now();
    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, native);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres backup setup client")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        client
            .simple_query(&backup_restore_setup_sql())
            .await
            .context("execute native Postgres backup/restore setup")?;
        drop(client);
        let _ = connection_task.await;
        Ok::<_, anyhow::Error>(())
    })?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let backup_path = native.root.join("backup.dump");
    let backup_started = Instant::now();
    run_native_postgres_tool(
        native,
        native_postgres_sibling_tool(postgres_bin, "pg_dump"),
        [
            "-d".to_owned(),
            NATIVE_BENCHMARK_DATABASE.to_owned(),
            "-Fc".to_owned(),
            "-f".to_owned(),
            backup_path.display().to_string(),
        ],
    )
    .context("run native Postgres pg_dump backup")?;
    let backup_elapsed = backup_started.elapsed();
    let backup_bytes = fs::metadata(&backup_path)
        .with_context(|| format!("stat native Postgres backup {}", backup_path.display()))?
        .len() as usize;
    ensure!(backup_bytes > 0, "native Postgres backup was empty");
    server_rss.sample();

    let restore_started = Instant::now();
    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, native);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres restore control client")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        client
            .simple_query("DROP DATABASE IF EXISTS oliphaunt_restore")
            .await
            .context("drop native Postgres restore database")?;
        client
            .simple_query("CREATE DATABASE oliphaunt_restore TEMPLATE template0")
            .await
            .context("create native Postgres restore database")?;
        drop(client);
        let _ = connection_task.await;
        Ok::<_, anyhow::Error>(())
    })?;
    run_native_postgres_tool(
        native,
        native_postgres_sibling_tool(postgres_bin, "pg_restore"),
        [
            "-d".to_owned(),
            "oliphaunt_restore".to_owned(),
            backup_path.display().to_string(),
        ],
    )
    .context("run native Postgres pg_restore")?;
    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client_db(&mut config, native, "oliphaunt_restore");
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect restored native Postgres database")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let row = client
            .query_one("SELECT count(*)::int8 FROM backup_restore_items", &[])
            .await
            .context("query restored native Postgres row count")?;
        let count: i64 = row.get(0);
        ensure!(
            count == BACKUP_RESTORE_EXPECTED_ROWS as i64,
            "native Postgres restored row count mismatch: got {count}, expected {BACKUP_RESTORE_EXPECTED_ROWS}"
        );
        drop(client);
        let _ = connection_task.await;
        Ok::<_, anyhow::Error>(())
    })?;
    let restore_elapsed = restore_started.elapsed();
    server_rss.sample();

    Ok(BenchmarkRun {
        suite: "backup-restore",
        mode: "native_postgres",
        description: "Native Postgres backup/restore control using pg_dump -Fc and pg_restore against the liboliphaunt-matched temporary cluster.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests: vec![
            single_sample_result(
                "pg_dump_custom_backup",
                format!(
                    "pg_dump custom-format backup; backup size {}",
                    fmt_bytes_label(backup_bytes)
                ),
                "seconds",
                backup_bytes,
                backup_elapsed,
            ),
            single_sample_result(
                "pg_restore_custom_backup",
                format!(
                    "pg_restore custom-format restore; backup size {}",
                    fmt_bytes_label(backup_bytes)
                ),
                "seconds",
                backup_bytes,
                restore_elapsed,
            ),
        ],
    })
}

pub(super) fn run_native_postgres_physical_backup_restore_benchmark(
    native: &NativePostgres,
    postgres_bin: &Path,
    open_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres physical backup/restore Tokio runtime")?;
    let setup_started = Instant::now();
    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, native);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres physical backup setup client")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        client
            .simple_query(&backup_restore_setup_sql())
            .await
            .context("execute native Postgres physical backup setup")?;
        drop(client);
        let _ = connection_task.await;
        Ok::<_, anyhow::Error>(())
    })?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let backup_started = Instant::now();
    let archive_bytes = native_postgres_physical_archive(&runtime, native)
        .context("create native Postgres physical archive")?;
    let backup_elapsed = backup_started.elapsed();
    let archive_len = archive_bytes.len();
    ensure!(archive_len > 0, "native Postgres physical backup was empty");
    server_rss.sample();

    let restore_root = env::current_dir()
        .context("read current directory")?
        .join("target/perf")
        .join(format!("npg-r-{}-{}", std::process::id(), now_micros()?));
    let restore_started = Instant::now();
    native_postgres_restore_physical_archive(&archive_bytes, &restore_root).with_context(|| {
        format!(
            "restore native Postgres physical archive into {}",
            restore_root.display()
        )
    })?;
    let restore_elapsed = restore_started.elapsed();

    let restore_data_dir = restore_root.join("pgdata");
    let mut restored = NativePostgres::start_existing(
        postgres_bin,
        restore_root.clone(),
        restore_data_dir,
        tuning,
    )
    .context("start restored native Postgres physical backup")?;
    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, &restored);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect restored native Postgres physical backup")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let row = client
            .query_one("SELECT count(*)::int8 FROM backup_restore_items", &[])
            .await
            .context("query restored native Postgres physical backup row count")?;
        let count: i64 = row.get(0);
        ensure!(
            count == BACKUP_RESTORE_EXPECTED_ROWS as i64,
            "native Postgres physical restored row count mismatch: got {count}, expected {BACKUP_RESTORE_EXPECTED_ROWS}"
        );
        drop(client);
        let _ = connection_task.await;
        Ok::<_, anyhow::Error>(())
    })?;
    server_rss.sample();
    terminate_child_gracefully(&mut restored.child);

    Ok(BenchmarkRun {
        suite: "backup-restore",
        mode: "native_postgres_physical",
        description: "Native Postgres physical backup/restore control using pg_backup_start/pg_backup_stop and the same filtered PGDATA tar archive semantics as liboliphaunt.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests: vec![
            single_sample_result(
                "physical_archive_backup",
                format!(
                    "Native Postgres physical archive backup; archive size {}",
                    fmt_bytes_label(archive_len)
                ),
                "seconds",
                archive_len,
                backup_elapsed,
            ),
            single_sample_result(
                "physical_archive_restore",
                format!(
                    "Native Postgres physical archive restore; archive size {}",
                    fmt_bytes_label(archive_len)
                ),
                "seconds",
                archive_len,
                restore_elapsed,
            ),
        ],
    })
}

fn native_postgres_physical_archive(
    runtime: &tokio::runtime::Runtime,
    native: &NativePostgres,
) -> Result<Vec<u8>> {
    let (client, connection_task) = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, native);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres physical backup client")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        client
            .query_one(
                "SELECT pg_backup_start(label => $1, fast => true)",
                &[&NATIVE_POSTGRES_PHYSICAL_BACKUP_LABEL],
            )
            .await
            .context("start native Postgres physical backup")?;
        Ok::<_, anyhow::Error>((client, connection_task))
    })?;

    let mut backup_stopped = false;
    let archive_result = (|| -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut archive = TarBuilder::new(&mut bytes);
            native_postgres_append_pgdata_tree(&mut archive, &native.data_dir)?;
            let stop_files = runtime.block_on(native_postgres_stop_physical_backup(&client))?;
            backup_stopped = true;
            native_postgres_append_pg_wal_tree(&mut archive, &native.data_dir)?;
            native_postgres_append_generated_file(
                &mut archive,
                "pgdata/backup_label",
                stop_files.backup_label,
            )?;
            if let Some(tablespace_map) = stop_files.tablespace_map
                && !tablespace_map.is_empty()
            {
                native_postgres_append_generated_file(
                    &mut archive,
                    "pgdata/tablespace_map",
                    tablespace_map,
                )?;
            }
            archive
                .finish()
                .context("finish native Postgres physical archive")?;
        }
        Ok(bytes)
    })();

    if let Err(error) = &archive_result
        && !backup_stopped
    {
        let stop_error = runtime
            .block_on(native_postgres_stop_physical_backup(&client))
            .err();
        if let Some(stop_error) = stop_error {
            drop(client);
            runtime.block_on(async {
                let _ = connection_task.await;
            });
            bail!(
                "{error}; also failed to leave native Postgres backup mode cleanly: {stop_error}"
            );
        }
    }
    drop(client);
    runtime.block_on(async {
        let _ = connection_task.await;
    });
    archive_result
}

async fn native_postgres_stop_physical_backup(
    client: &tokio_postgres::Client,
) -> Result<NativePostgresBackupStopFiles> {
    let row = client
        .query_one(
            "SELECT labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)",
            &[],
        )
        .await
        .context("stop native Postgres physical backup")?;
    Ok(NativePostgresBackupStopFiles {
        backup_label: row.get::<usize, String>(0),
        tablespace_map: row.get::<usize, Option<String>>(1),
    })
}

struct NativePostgresBackupStopFiles {
    backup_label: String,
    tablespace_map: Option<String>,
}

fn native_postgres_restore_physical_archive(bytes: &[u8], restore_root: &Path) -> Result<()> {
    fs::remove_dir_all(restore_root)
        .or_else(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(err)
            }
        })
        .with_context(|| {
            format!(
                "remove old native Postgres restore root {}",
                restore_root.display()
            )
        })?;
    fs::create_dir_all(restore_root).with_context(|| {
        format!(
            "create native Postgres restore root {}",
            restore_root.display()
        )
    })?;
    let mut archive = Archive::new(Cursor::new(bytes));
    archive.unpack(restore_root).with_context(|| {
        format!(
            "unpack native Postgres physical archive into {}",
            restore_root.display()
        )
    })?;
    ensure!(
        restore_root.join("pgdata/PG_VERSION").is_file(),
        "native Postgres physical archive did not restore pgdata/PG_VERSION"
    );
    Ok(())
}

fn native_postgres_append_pgdata_tree(
    archive: &mut TarBuilder<&mut Vec<u8>>,
    pgdata: &Path,
) -> Result<()> {
    native_postgres_append_directory(archive, pgdata, Path::new("pgdata"))?;
    for entry in native_postgres_sorted_read_dir(pgdata)? {
        native_postgres_append_pgdata_entry(archive, pgdata, &entry.path(), false)?;
    }
    Ok(())
}

fn native_postgres_append_pg_wal_tree(
    archive: &mut TarBuilder<&mut Vec<u8>>,
    pgdata: &Path,
) -> Result<()> {
    let pg_wal = pgdata.join("pg_wal");
    if !pg_wal.is_dir() {
        return Ok(());
    }
    for entry in native_postgres_sorted_read_dir(&pg_wal)? {
        native_postgres_append_pgdata_entry(archive, pgdata, &entry.path(), true)?;
    }
    Ok(())
}

fn native_postgres_append_pgdata_entry(
    archive: &mut TarBuilder<&mut Vec<u8>>,
    pgdata: &Path,
    source: &Path,
    include_wal_contents: bool,
) -> Result<()> {
    let relative = source.strip_prefix(pgdata).with_context(|| {
        format!(
            "strip PGDATA prefix {} from {}",
            pgdata.display(),
            source.display()
        )
    })?;
    if native_postgres_should_skip_pgdata_entry(relative, include_wal_contents) {
        return Ok(());
    }

    let archive_path = Path::new("pgdata").join(relative);
    let metadata = fs::symlink_metadata(source).with_context(|| {
        format!(
            "stat {} for native Postgres physical backup",
            source.display()
        )
    })?;
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        native_postgres_append_directory(archive, source, &archive_path)?;
        for entry in native_postgres_sorted_read_dir(source)? {
            native_postgres_append_pgdata_entry(
                archive,
                pgdata,
                &entry.path(),
                include_wal_contents,
            )?;
        }
    } else if file_type.is_file() {
        let mut file = fs::File::open(source).with_context(|| {
            format!(
                "open {} for native Postgres physical backup",
                source.display()
            )
        })?;
        archive
            .append_file(&archive_path, &mut file)
            .with_context(|| format!("archive native Postgres file {}", source.display()))?;
    } else if file_type.is_symlink() {
        bail!(
            "native Postgres physical benchmark archive does not support symlinked PGDATA entry {}",
            archive_path.display()
        );
    } else {
        bail!(
            "native Postgres physical benchmark archive does not support non-regular PGDATA entry {}",
            archive_path.display()
        );
    }
    Ok(())
}

fn native_postgres_should_skip_pgdata_entry(relative: &Path, include_wal_contents: bool) -> bool {
    if relative == Path::new("postmaster.pid") || relative == Path::new("postmaster.opts") {
        return true;
    }
    if relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "pg_internal.init" || name.starts_with("pgsql_tmp"))
    {
        return true;
    }
    let mut components = relative.components();
    let Some(Component::Normal(first)) = components.next() else {
        return false;
    };
    let has_child = components.next().is_some();
    if !has_child {
        return false;
    }
    first.to_str().is_some_and(|name| {
        NATIVE_POSTGRES_PHYSICAL_TRANSIENT_CONTENT_DIRS.contains(&name)
            || (name == "pg_wal" && !include_wal_contents)
    })
}

fn native_postgres_append_directory(
    archive: &mut TarBuilder<&mut Vec<u8>>,
    source: &Path,
    archive_path: &Path,
) -> Result<()> {
    archive
        .append_dir(archive_path, source)
        .with_context(|| format!("archive native Postgres directory {}", source.display()))
}

fn native_postgres_append_generated_file(
    archive: &mut TarBuilder<&mut Vec<u8>>,
    archive_path: &str,
    contents: String,
) -> Result<()> {
    let bytes = contents.into_bytes();
    let mut header = TarHeader::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive
        .append_data(&mut header, archive_path, Cursor::new(bytes))
        .with_context(|| format!("archive native Postgres generated file {archive_path}"))
}

fn native_postgres_sorted_read_dir(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("read native Postgres directory {}", path.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("read native Postgres directory entry in {}", path.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn native_postgres_sibling_tool(postgres_bin: &Path, tool: &str) -> PathBuf {
    postgres_bin
        .parent()
        .map(|dir| dir.join(tool))
        .unwrap_or_else(|| PathBuf::from(tool))
}

fn run_native_postgres_tool<I>(native: &NativePostgres, tool: PathBuf, extra_args: I) -> Result<()>
where
    I: IntoIterator<Item = String>,
{
    let mut command = Command::new(&tool);
    #[cfg(unix)]
    command.arg("-h").arg(&native.socket_dir);
    #[cfg(not(unix))]
    command.arg("-h").arg("127.0.0.1");
    command
        .arg("-p")
        .arg(native.port.to_string())
        .arg("-U")
        .arg("postgres");
    for arg in extra_args {
        command.arg(arg);
    }
    let output = command
        .output()
        .with_context(|| format!("spawn native Postgres tool {}", tool.display()))?;
    ensure!(
        output.status.success(),
        "native Postgres tool {} failed with {}:\nstdout:\n{}\nstderr:\n{}",
        tool.display(),
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

trait NativePostgresRawStream: Read + Write + Send {}

impl<T> NativePostgresRawStream for T where T: Read + Write + Send {}

struct NativePostgresRawClient {
    stream: BufReader<Box<dyn NativePostgresRawStream>>,
}

impl NativePostgresRawClient {
    fn connect(native: &NativePostgres) -> Result<Self> {
        let mut stream = BufReader::with_capacity(64 * 1024, native_postgres_raw_stream(native)?);
        write_native_postgres_startup(stream.get_mut().as_mut())?;
        read_native_postgres_until_ready(&mut stream, true, &mut |_| Ok(()))?;
        Ok(Self { stream })
    }

    fn exec_streaming(
        &mut self,
        sql: &str,
        mut on_chunk: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let stream = self.stream.get_mut();
        stream
            .write_all(&pg_query(sql))
            .and_then(|()| stream.flush())
            .context("write native Postgres streaming query")?;
        read_native_postgres_until_ready(&mut self.stream, false, &mut on_chunk)
    }

    fn terminate(&mut self) -> Result<()> {
        self.stream
            .get_mut()
            .write_all(&[b'X', 0, 0, 0, 4])
            .and_then(|()| self.stream.get_mut().flush())
            .context("terminate native Postgres raw streaming client")
    }
}

fn native_postgres_raw_stream(native: &NativePostgres) -> Result<Box<dyn NativePostgresRawStream>> {
    #[cfg(unix)]
    {
        let socket_path = native.socket_dir.join(format!(".s.PGSQL.{}", native.port));
        let stream = UnixStream::connect(&socket_path)
            .with_context(|| format!("connect native Postgres socket {}", socket_path.display()))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .context("set native Postgres raw socket read timeout")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .context("set native Postgres raw socket write timeout")?;
        Ok(Box::new(stream))
    }
    #[cfg(not(unix))]
    {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], native.port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(15))
            .with_context(|| format!("connect native Postgres TCP socket {addr}"))?;
        stream
            .set_nodelay(true)
            .context("set TCP_NODELAY on native Postgres raw socket")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .context("set native Postgres raw socket read timeout")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .context("set native Postgres raw socket write timeout")?;
        Ok(Box::new(stream))
    }
}

fn write_native_postgres_startup(stream: &mut dyn Write) -> Result<()> {
    let mut body = Vec::new();
    body.extend_from_slice(&196_608_i32.to_be_bytes());
    push_cstr(&mut body, "user");
    push_cstr(&mut body, "postgres");
    push_cstr(&mut body, "database");
    push_cstr(&mut body, NATIVE_BENCHMARK_DATABASE);
    body.push(0);

    let total_len = i32::try_from(body.len() + 4)
        .map_err(|_| anyhow!("native Postgres startup message is too large"))?;
    stream
        .write_all(&total_len.to_be_bytes())
        .and_then(|()| stream.write_all(&body))
        .and_then(|()| stream.flush())
        .context("write native Postgres startup message")
}

fn read_native_postgres_until_ready(
    stream: &mut dyn Read,
    startup: bool,
    on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let mut callback_error = None;
    let mut frame = Vec::with_capacity(8192);
    loop {
        frame.resize(5, 0);
        stream
            .read_exact(&mut frame[..5])
            .context("read native Postgres protocol header")?;
        let tag = frame[0];
        let len = i32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        ensure!(
            len >= 4,
            "native Postgres returned invalid frame length {len}"
        );
        let body_len = (len as usize) - 4;
        frame.resize(5 + body_len, 0);
        stream
            .read_exact(&mut frame[5..])
            .context("read native Postgres protocol body")?;
        if callback_error.is_none()
            && let Err(error) = on_chunk(&frame)
        {
            callback_error = Some(error);
        }
        match tag {
            b'R' if startup => validate_native_postgres_authentication(&frame[5..])?,
            b'E' => bail!("{}", parse_native_postgres_error_response(&frame[5..])),
            b'Z' => return callback_error.map_or(Ok(()), Err),
            _ => {}
        }
    }
}

fn validate_native_postgres_authentication(body: &[u8]) -> Result<()> {
    ensure!(
        body.len() >= 4,
        "native Postgres returned truncated authentication frame"
    );
    let method = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    ensure!(
        method == 0,
        "native Postgres requested unsupported authentication method {method}"
    );
    Ok(())
}

fn parse_native_postgres_error_response(body: &[u8]) -> String {
    for field in body
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        if field[0] == b'M' {
            return String::from_utf8_lossy(&field[1..]).into_owned();
        }
    }
    "native Postgres returned ErrorResponse".to_owned()
}

pub(super) fn native_postgres_sqlx_options(native: &NativePostgres) -> PgConnectOptions {
    PgConnectOptions::new_without_pgpass()
        .host("127.0.0.1")
        .port(native.port)
        .username("postgres")
        .database(NATIVE_BENCHMARK_DATABASE)
        .ssl_mode(PgSslMode::Disable)
}

pub(super) struct NativePostgres {
    pub(super) child: Child,
    pub(super) root: PathBuf,
    pub(super) data_dir: PathBuf,
    pub(super) socket_dir: PathBuf,
    pub(super) port: u16,
}

impl NativePostgres {
    pub(super) fn start(
        postgres_bin: &Path,
        initdb_bin: &Path,
        tuning: &NativeBenchmarkTuning,
    ) -> Result<Self> {
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

        Self::start_existing(postgres_bin, root, data_dir, tuning)
    }

    pub(super) fn start_existing(
        postgres_bin: &Path,
        root: PathBuf,
        data_dir: PathBuf,
        tuning: &NativeBenchmarkTuning,
    ) -> Result<Self> {
        let socket_dir = root.join("socket");
        fs::create_dir_all(&socket_dir)
            .with_context(|| format!("create {}", socket_dir.display()))?;
        ensure!(
            data_dir.join("PG_VERSION").is_file(),
            "native postgres data directory is missing PG_VERSION: {}",
            data_dir.display()
        );

        let port = reserve_loopback_port()?;
        let log_path = root.join("postgres.log");
        let log = fs::File::create(&log_path)
            .with_context(|| format!("create native Postgres log {}", log_path.display()))?;
        let mut command = Command::new(postgres_bin);
        command.arg("-D").arg(&data_dir);
        #[cfg(unix)]
        {
            command
                .arg("-h")
                .arg("127.0.0.1")
                .arg("-k")
                .arg(&socket_dir);
        }
        #[cfg(not(unix))]
        {
            command.arg("-h").arg("127.0.0.1");
        }
        command.arg("-p").arg(port.to_string());
        for assignment in tuning.native_postgres_control_assignments() {
            command.arg("-c").arg(assignment);
        }
        let child = command
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .spawn()
            .with_context(|| format!("spawn native postgres {}", postgres_bin.display()))?;

        let mut native = Self {
            child,
            root,
            data_dir,
            socket_dir,
            port,
        };
        native.wait_ready(&log_path)?;
        Ok(native)
    }

    fn wait_ready(&mut self, log_path: &Path) -> Result<()> {
        #[cfg(unix)]
        let socket_path = self.socket_dir.join(format!(".s.PGSQL.{}", self.port));
        let start = Instant::now();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create native Postgres readiness Tokio runtime")?;
        let mut last_probe_error = None;
        while start.elapsed() < Duration::from_secs(15) {
            if let Some(status) = self.child.try_wait().context("poll native postgres")? {
                let log = fs::read_to_string(log_path).unwrap_or_default();
                bail!("native postgres exited early with {status}; log:\n{log}");
            }
            #[cfg(unix)]
            let transport_ready = socket_path.exists();
            #[cfg(not(unix))]
            let transport_ready = true;
            if transport_ready {
                match runtime.block_on(self.probe_ready()) {
                    Ok(()) => return Ok(()),
                    Err(err) => last_probe_error = Some(err),
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let log = fs::read_to_string(log_path).unwrap_or_default();
        let probe = last_probe_error
            .map(|err| format!("last readiness probe error: {err}\n"))
            .unwrap_or_default();
        bail!("native postgres did not become ready; {probe}log:\n{log}");
    }

    async fn probe_ready(&self) -> Result<()> {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, self);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect readiness probe")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let query_result = client
            .simple_query("SELECT 1")
            .await
            .context("run readiness probe query");
        drop(client);
        let _ = connection_task.await;
        query_result.map(|_| ())
    }
}

fn reserve_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .context("reserve loopback port for native Postgres benchmark")?;
    let port = listener
        .local_addr()
        .context("read reserved native Postgres benchmark port")?
        .port();
    drop(listener);
    Ok(port)
}

pub(super) fn configure_native_postgres_client(
    config: &mut tokio_postgres::Config,
    native: &NativePostgres,
) {
    configure_native_postgres_client_db(config, native, NATIVE_BENCHMARK_DATABASE)
}

pub(super) fn configure_native_postgres_client_db(
    config: &mut tokio_postgres::Config,
    native: &NativePostgres,
    database: &str,
) {
    config.user("postgres").dbname(database).port(native.port);
    #[cfg(unix)]
    {
        config.host_path(&native.socket_dir);
    }
    #[cfg(not(unix))]
    {
        config.host("127.0.0.1");
    }
}

impl Drop for NativePostgres {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            terminate_child_gracefully(&mut self.child);
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn terminate_child_gracefully(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}
