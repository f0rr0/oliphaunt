use super::*;

use std::net::TcpStream;
use std::thread;

use crate::process_rss::NativeLiboliphauntChildRssSampler;
use oliphaunt::{
    DatabaseStorage as NativeDatabaseStorage, Oliphaunt as NativeOliphaunt,
    OliphauntBuilder as NativeOliphauntBuilder, OliphauntServer as NativeOliphauntServer,
    OliphauntServerBuilder as NativeOliphauntServerBuilder, ServerListen as NativeServerListen,
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
    ensure!(
        !(engine == NativeLiboliphauntEngineMode::Server
            && suite == NativeLiboliphauntSuiteFilter::BackupRestore),
        "native server backup is not an SDK operation; use PostgreSQL backup tools"
    );

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
        engine: "native-liboliphaunt",
        source_model: speed_sql_source.source_model(),
        measurement_model: engine.measurement_model(),
        native_tuning: Some(tuning.report()),
        rtt_iterations,
        speed_scale: 1.0,
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
            "direct" => Ok(Self::Direct),
            "broker" => Ok(Self::Broker),
            "server" => Ok(Self::Server),
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
            (Self::Direct, "rtt") => {
                "Native liboliphaunt in-process direct Rust API with blocking caller-side measurement."
            }
            (Self::Direct, "speed") => {
                "Native liboliphaunt speed suite through the blocking in-process direct Rust API."
            }
            (Self::Direct, "large-results") => {
                "Native liboliphaunt large-result raw-protocol transfer through the blocking in-process direct Rust API."
            }
            (Self::Direct, "backup-restore") => {
                "Native liboliphaunt physical archive backup and restore through the blocking in-process direct Rust API."
            }
            (Self::Broker, "rtt") => {
                "Native liboliphaunt blocking Rust API in broker mode through a helper process and local IPC."
            }
            (Self::Broker, "speed") => {
                "Native liboliphaunt speed suite through the blocking Rust API and broker helper-process IPC."
            }
            (Self::Broker, "large-results") => {
                "Native liboliphaunt large-result raw-protocol transfer through the blocking Rust API and broker helper-process IPC."
            }
            (Self::Broker, "backup-restore") => {
                "Native liboliphaunt physical archive backup and restore through the blocking Rust API and broker helper-process IPC."
            }
            (Self::Server, "rtt") => {
                "Native liboliphaunt blocking Rust API through a real local PostgreSQL server process."
            }
            (Self::Server, "speed") => {
                "Native liboliphaunt speed suite through the blocking Rust API and a real local PostgreSQL server process."
            }
            (Self::Server, "large-results") => {
                "Native liboliphaunt large-result raw-protocol transfer through the blocking Rust API and a real local PostgreSQL server process."
            }
            _ => "Native liboliphaunt benchmark.",
        }
    }

    fn measurement_model(self) -> &'static str {
        match self {
            Self::Direct => {
                "Native liboliphaunt direct-mode control. xtask opens one embedded native PostgreSQL backend in-process through the crate-root synchronous Rust SDK. Each measured call blocks the benchmark caller until completion without an SDK owner-queue hop; liboliphaunt owns the embedded backend on its internal pthread. RTT sample loops sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
            Self::Broker => {
                "Native liboliphaunt broker-mode control. xtask measures blocking calls through the crate-root synchronous Rust SDK; a helper process owns the native backend and the caller sends raw protocol/control frames over local IPC. RTT sample loops sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
            Self::Server => {
                "Native liboliphaunt server control. xtask starts a real local PostgreSQL server through OliphauntServer::builder().start() and measures blocking raw-protocol calls through an external PostgreSQL client connected to its public connection string. RTT sample loops sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each Oliphaunt fixture SQL file as one simple-query buffer."
            }
        }
    }
}

enum NativeLiboliphauntDatabase {
    Database(NativeOliphaunt),
    Server {
        owner: NativeOliphauntServer,
        client: NativeServerProtocolClient,
    },
}

impl NativeLiboliphauntDatabase {
    fn open(
        root: &Path,
        execution: NativeLiboliphauntEngineMode,
        tuning: &NativeBenchmarkTuning,
    ) -> Result<Self> {
        match execution {
            NativeLiboliphauntEngineMode::Direct | NativeLiboliphauntEngineMode::Broker => {
                native_liboliphaunt_builder(root, execution, tuning)
                    .open()
                    .map(Self::Database)
                    .map_err(Into::into)
            }
            NativeLiboliphauntEngineMode::Server => {
                let owner = native_liboliphaunt_server_builder(root, tuning).start()?;
                let client = NativeServerProtocolClient::connect(owner.connection_string())?;
                Ok(Self::Server { owner, client })
            }
        }
    }

    fn execute(&mut self, sql: &str) -> Result<()> {
        match self {
            Self::Database(database) => {
                database.execute(sql)?;
                Ok(())
            }
            Self::Server { client, .. } => {
                let response = client.exec_protocol_raw(&pg_query(sql))?;
                ensure_protocol_response_ok(&response)
            }
        }
    }

    fn query_first_text(&mut self, sql: &str, column: &str) -> Result<String> {
        match self {
            Self::Database(database) => database
                .query(sql)?
                .get_text(0, column)?
                .map(str::to_owned)
                .context("native liboliphaunt query value was NULL"),
            Self::Server { client, .. } => {
                let response = client.exec_protocol_raw(&pg_query(sql))?;
                ensure_protocol_response_ok(&response)?;
                first_protocol_data_row_text(&response)
                    .context("native server query returned no text DataRow value")
            }
        }
    }

    fn exec_protocol_raw(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        match self {
            Self::Database(database) => database.exec_protocol_raw(request).map_err(Into::into),
            Self::Server { client, .. } => client.exec_protocol_raw(request),
        }
    }

    fn close(&mut self) -> Result<()> {
        match self {
            Self::Database(database) => database.close().map_err(Into::into),
            Self::Server { owner, client } => {
                let terminate = client.terminate();
                let close = owner.close().map_err(anyhow::Error::from);
                terminate?;
                close
            }
        }
    }
}

struct NativeServerProtocolClient {
    stream: TcpStream,
}

impl NativeServerProtocolClient {
    const DUPLEX_REQUEST_THRESHOLD: usize = 256 * 1024;

    fn connect(connection_string: &str) -> Result<Self> {
        let (address, user, database) = parse_native_server_connection_string(connection_string)?;
        let mut stream = TcpStream::connect(&address)
            .with_context(|| format!("connect native server benchmark client to {address}"))?;
        stream
            .set_nodelay(true)
            .context("set native server benchmark TCP_NODELAY")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .context("set native server benchmark read timeout")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(120)))
            .context("set native server benchmark write timeout")?;
        write_native_server_startup(&mut stream, &user, &database)?;
        read_native_server_until_ready(&mut stream, false, true)?;
        Ok(Self { stream })
    }

    fn exec_protocol_raw(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        if request.len() < Self::DUPLEX_REQUEST_THRESHOLD {
            self.stream
                .write_all(request)
                .and_then(|()| self.stream.flush())
                .context("write native server benchmark protocol request")?;
            return read_native_server_until_ready(&mut self.stream, true, false);
        }
        let mut reader = self
            .stream
            .try_clone()
            .context("clone native server benchmark protocol stream")?;
        let reader = thread::Builder::new()
            .name("oliphaunt-perf-server-reader".to_owned())
            .spawn(move || read_native_server_until_ready(&mut reader, true, false))
            .context("spawn native server benchmark protocol reader")?;
        let write = self
            .stream
            .write_all(request)
            .and_then(|()| self.stream.flush())
            .context("write native server benchmark protocol request");
        let read = reader
            .join()
            .map_err(|_| anyhow!("native server benchmark protocol reader panicked"))?;
        write?;
        read
    }

    fn terminate(&mut self) -> Result<()> {
        self.stream
            .write_all(&[b'X', 0, 0, 0, 4])
            .and_then(|()| self.stream.flush())
            .context("terminate native server benchmark client")
    }
}

fn parse_native_server_connection_string(value: &str) -> Result<(String, String, String)> {
    let target = value
        .strip_prefix("postgresql://")
        .context("native server benchmark expected a PostgreSQL TCP connection string")?;
    let (user, target) = target
        .split_once('@')
        .context("native server benchmark connection string omitted its user")?;
    let (address, database) = target
        .split_once('/')
        .context("native server benchmark connection string omitted its database")?;
    ensure!(
        address.contains(':') && !address.starts_with('/'),
        "native server benchmark requires its explicit TCP listener"
    );
    Ok((
        address.to_owned(),
        user.to_owned(),
        database.split('?').next().unwrap_or(database).to_owned(),
    ))
}

fn write_native_server_startup(stream: &mut TcpStream, user: &str, database: &str) -> Result<()> {
    let mut body = 196_608_i32.to_be_bytes().to_vec();
    for value in ["user", user, "database", database] {
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let length = i32::try_from(body.len() + 4)
        .map_err(|_| anyhow!("native server benchmark startup message is too large"))?;
    stream
        .write_all(&length.to_be_bytes())
        .and_then(|()| stream.write_all(&body))
        .and_then(|()| stream.flush())
        .context("write native server benchmark startup message")
}

fn read_native_server_until_ready(
    stream: &mut TcpStream,
    capture: bool,
    error_is_fatal: bool,
) -> Result<Vec<u8>> {
    let mut response = Vec::new();
    loop {
        let mut header = [0_u8; 5];
        stream
            .read_exact(&mut header)
            .context("read native server benchmark response header")?;
        let length = i32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        ensure!(
            length >= 4,
            "native server returned invalid frame length {length}"
        );
        let mut body = vec![0_u8; (length as usize) - 4];
        stream
            .read_exact(&mut body)
            .context("read native server benchmark response body")?;
        if capture {
            response.extend_from_slice(&header);
            response.extend_from_slice(&body);
        }
        if error_is_fatal && header[0] == b'E' {
            bail!("native server benchmark startup received ErrorResponse");
        }
        if header[0] == b'Z' {
            return Ok(response);
        }
    }
}

fn first_protocol_data_row_text(mut bytes: &[u8]) -> Option<String> {
    while bytes.len() >= 5 {
        let length = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if length < 4 || bytes.len() < 1 + length as usize {
            return None;
        }
        let total = 1 + length as usize;
        if bytes[0] == b'D' {
            let body = &bytes[5..total];
            if body.len() < 6 || i16::from_be_bytes([body[0], body[1]]) < 1 {
                return None;
            }
            let value_length = i32::from_be_bytes([body[2], body[3], body[4], body[5]]);
            if value_length < 0 || body.len() < 6 + value_length as usize {
                return None;
            }
            return Some(String::from_utf8_lossy(&body[6..6 + value_length as usize]).into_owned());
        }
        bytes = &bytes[total..];
    }
    None
}

fn run_native_liboliphaunt_rtt_benchmark(
    engine: NativeLiboliphauntEngineMode,
    iterations: usize,
    tuning: &NativeBenchmarkTuning,
) -> Result<BenchmarkRun> {
    let root = native_liboliphaunt_benchmark_root(engine.label(), "rtt")?;
    let open_started = Instant::now();
    let mut db = NativeLiboliphauntDatabase::open(&root, engine, tuning)
        .with_context(|| format!("open native liboliphaunt {} RTT database", engine.label()))?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let setup_started = Instant::now();
    db.execute(rtt_setup_sql())
        .with_context(|| format!("execute native liboliphaunt {} RTT setup", engine.label()))?;
    let setup_micros = setup_started.elapsed().as_micros();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            db.execute(&case.sql)
                .with_context(|| format!("execute RTT benchmark {}", case.id))?;
            samples.push(started.elapsed().as_micros());
        }
        let test = samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        );
        tests.push(test);
        child_rss.sample();
    }
    db.close()?;
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
    let open_started = Instant::now();
    let mut db = NativeLiboliphauntDatabase::open(&root, engine, tuning)
        .with_context(|| format!("open native liboliphaunt {} speed database", engine.label()))?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in cases {
        let started = Instant::now();
        db.execute(&case.sql)
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
    db.close()?;
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
    let root = native_liboliphaunt_benchmark_root(engine.label(), "large-results")?;
    let open_started = Instant::now();
    let mut db = NativeLiboliphauntDatabase::open(&root, engine, tuning).with_context(|| {
        format!(
            "open native liboliphaunt {} large-result database",
            engine.label()
        )
    })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut child_rss = NativeLiboliphauntChildRssSampler::new();
    child_rss.sample();

    let mut tests = Vec::new();
    for case in streaming_cases() {
        let started = Instant::now();
        let response = db.exec_protocol_raw(&pg_query(case.sql)).with_context(|| {
            format!(
                "execute native liboliphaunt {} large-result benchmark {}",
                engine.label(),
                case.id
            )
        })?;
        let bytes = response.len();
        tests.push(single_sample_result(
            case.id,
            format!("{}; transferred {bytes} raw protocol bytes", case.label),
            "seconds",
            bytes,
            started.elapsed(),
        ));
        child_rss.sample();
    }
    db.close()?;
    cleanup_native_liboliphaunt_benchmark_root(engine, &root, "large-results")?;

    Ok(BenchmarkRun {
        suite: "large-results",
        mode: engine.benchmark_mode(),
        description: engine.description("large-results"),
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
    let open_started = Instant::now();
    let mut db = native_liboliphaunt_builder(&root, engine, tuning)
        .open()
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
    db.execute(&setup_sql).with_context(|| {
        format!(
            "execute native liboliphaunt {} backup/restore setup",
            engine.label()
        )
    })?;
    let setup_micros = setup_started.elapsed().as_micros();
    child_rss.sample();

    let backup_started = Instant::now();
    let artifact = db
        .backup()
        .with_context(|| format!("backup native liboliphaunt {} root", engine.label()))?;
    let backup_elapsed = backup_started.elapsed();
    ensure!(
        !artifact.is_empty(),
        "native liboliphaunt {} backup returned an empty archive",
        engine.label()
    );
    let archive_bytes = artifact.len();
    child_rss.sample();

    db.close()?;

    let restore_started = Instant::now();
    NativeOliphaunt::restore(&restore_root, artifact).with_context(|| {
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
    let mut db = NativeLiboliphauntDatabase::open(&root, engine, &tuning).with_context(|| {
        format!(
            "open restored native-liboliphaunt {} root {}",
            engine.label(),
            root.display()
        )
    })?;
    let count = db
        .query_first_text(
            "SELECT count(*)::text AS count FROM backup_restore_items",
            "count",
        )
        .context("query restored backup_restore_items count")?;
    ensure!(
        count == expected_rows.to_string(),
        "restored row count mismatch: got {count}, expected {expected_rows}"
    );
    db.close()?;
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
    let open_started = Instant::now();
    let mut db = NativeLiboliphauntDatabase::open(&root, engine, tuning)
        .context("open native-liboliphaunt prepared database")?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    db.execute(&setup_benchmark2)
        .context("execute native-liboliphaunt prepared setup benchmark2")?;
    db.execute(&setup_benchmark6)
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
    exec_raw_checked(&mut db, &prepare, "prepare native-liboliphaunt statement")?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    exec_raw_checked(
        &mut db,
        &pg_query("BEGIN"),
        "begin prepared-update transaction",
    )?;
    let operation_count = match update_values {
        NativeLiboliphauntPreparedValues::Numeric(updates) => {
            execute_native_liboliphaunt_prepared_updates(
                &mut db,
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
                &mut db,
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
        &mut db,
        &pg_query("COMMIT"),
        "commit prepared-update transaction",
    )?;
    let elapsed = started.elapsed();

    db.close()
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
    let profile_gucs = tuning
        .runtime_footprint
        .postgres_gucs()
        .iter()
        .chain(tuning.durability.postgres_gucs())
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()));
    let explicit_gucs = tuning
        .startup_gucs
        .iter()
        .map(|guc| (guc.name.clone(), guc.value.clone()));
    let builder = NativeOliphaunt::builder()
        .storage(NativeDatabaseStorage::Directory(root.to_path_buf()))
        .startup_gucs(profile_gucs.chain(explicit_gucs));
    match engine {
        NativeLiboliphauntEngineMode::Direct => builder.direct(),
        NativeLiboliphauntEngineMode::Broker => builder.broker(),
        NativeLiboliphauntEngineMode::Server => builder,
    }
}

fn native_liboliphaunt_server_builder(
    root: &Path,
    tuning: &NativeBenchmarkTuning,
) -> NativeOliphauntServerBuilder {
    let profile_gucs = tuning
        .runtime_footprint
        .postgres_gucs()
        .iter()
        .chain(tuning.durability.postgres_gucs())
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()));
    let explicit_gucs = tuning
        .startup_gucs
        .iter()
        .map(|guc| (guc.name.clone(), guc.value.clone()));
    NativeOliphauntServer::builder()
        .storage(NativeDatabaseStorage::Directory(root.to_path_buf()))
        .listen(NativeServerListen::tcp())
        .startup_gucs(profile_gucs.chain(explicit_gucs))
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

enum NativeLiboliphauntPreparedValues {
    Numeric(Vec<(i32, i32)>),
    Text(Vec<(i32, String)>),
}

fn execute_native_liboliphaunt_prepared_updates<I>(
    db: &mut NativeLiboliphauntDatabase,
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
                db,
                &batch,
                "execute pipelined native-liboliphaunt prepared updates",
            )?;
        }
    }
    Ok(())
}

fn exec_raw_checked(
    db: &mut NativeLiboliphauntDatabase,
    message: &[u8],
    context: &'static str,
) -> Result<()> {
    let response = db.exec_protocol_raw(message).with_context(|| context)?;
    ensure_protocol_response_ok(&response).with_context(|| context)
}

pub(super) fn run_native_liboliphaunt_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    target_index: usize,
    options: &SpeedDiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target = &cases[target_index];
    let root = native_liboliphaunt_benchmark_root("direct", "diagnose-speed")?;
    let open_started = Instant::now();
    let mut db = NativeOliphaunt::builder()
        .storage(NativeDatabaseStorage::Directory(root.clone()))
        .direct()
        .startup_gucs(
            options
                .durability
                .postgres_gucs()
                .iter()
                .map(|(name, value)| (*name, *value)),
        )
        .open()
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
        db.execute(&setup_case.sql)
            .with_context(|| format!("run native liboliphaunt setup case {}", setup_case.id))?;
        child_rss.sample();
    }
    let setup_micros = setup_started.elapsed().as_micros();

    let started = Instant::now();
    db.execute(&target.sql)
        .with_context(|| format!("run native liboliphaunt measured case {}", target.id))?;
    let elapsed_micros = started.elapsed().as_micros();
    child_rss.sample();
    let settings = db
        .exec_protocol_raw(pg_query(speed_diagnostic_settings_sql()))
        .map(|response| diagnostic_settings_from_protocol_response(&response))
        .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string() }));

    db.close()?;

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
    })
}
