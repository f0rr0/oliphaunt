use std::env;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

const REPORT_SCHEMA: &str = "oliphaunt.rust-api-model-run.v1";
const CLASSIFICATION: &str = "diagnostic-only";
const SELECT_ONE_SQL: &str = "SELECT 1::text AS value";

fn main() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|argument| matches!(argument.as_str(), "-h" | "--help"))
    {
        print_help();
        return Ok(());
    }

    let options = Options::parse(&arguments)?;
    let report = match (options.runtime, options.api) {
        (RuntimeFamily::Native, ApiModel::Sync) => run_native_sync(options)?,
        (RuntimeFamily::Native, ApiModel::Async) => run_native_async(options)?,
        (RuntimeFamily::Wasix, ApiModel::Sync) => run_wasix_sync(options)?,
        (RuntimeFamily::Wasix, ApiModel::Async) => run_wasix_async(options)?,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn print_help() {
    println!(
        "oliphaunt-rust-api-model \
  --runtime native|wasix \
  --api sync|async \
  [--iterations N] [--warmup N]\n\n\
Runs one API model in one process. Use tools/perf/rust-api-model/run.sh to run\n\
the paired sync and async processes and produce a diagnostic-only report."
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeFamily {
    Native,
    Wasix,
}

impl RuntimeFamily {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "native" => Ok(Self::Native),
            "wasix" => Ok(Self::Wasix),
            other => bail!("unsupported --runtime {other:?}; use native or wasix"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Wasix => "wasix",
        }
    }

    fn execution_owner(self, api: ApiModel) -> &'static str {
        match (self, api) {
            (Self::Native, ApiModel::Sync) => "liboliphaunt-backend-thread",
            (Self::Native, ApiModel::Async) => "sdk-owner-thread-plus-liboliphaunt-backend-thread",
            (Self::Wasix, ApiModel::Sync) => "caller-thread",
            (Self::Wasix, ApiModel::Async) => "sdk-owner-thread",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiModel {
    Sync,
    Async,
}

impl ApiModel {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "sync" => Ok(Self::Sync),
            "async" => Ok(Self::Async),
            other => bail!("unsupported --api {other:?}; use sync or async"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Async => "async",
        }
    }

    fn calling_contract(self) -> &'static str {
        match self {
            Self::Sync => "blocking",
            Self::Async => "awaited",
        }
    }

    fn sdk_queue(self) -> &'static str {
        match self {
            Self::Sync => "none",
            Self::Async => "one-owner-fifo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Options {
    runtime: RuntimeFamily,
    api: ApiModel,
    iterations: usize,
    warmup_iterations: usize,
}

impl Options {
    fn parse(arguments: &[String]) -> Result<Self> {
        let mut runtime = None;
        let mut api = None;
        let mut iterations = 200usize;
        let mut warmup_iterations = 20usize;
        let mut cursor = 0usize;

        while cursor < arguments.len() {
            let flag = arguments[cursor].as_str();
            cursor += 1;
            let value = arguments
                .get(cursor)
                .with_context(|| format!("{flag} requires a value"))?;
            match flag {
                "--runtime" => runtime = Some(RuntimeFamily::parse(value)?),
                "--api" => api = Some(ApiModel::parse(value)?),
                "--iterations" => {
                    iterations = value
                        .parse()
                        .with_context(|| format!("parse --iterations value {value:?}"))?;
                }
                "--warmup" => {
                    warmup_iterations = value
                        .parse()
                        .with_context(|| format!("parse --warmup value {value:?}"))?;
                }
                other => bail!("unsupported argument {other:?}; use --help for usage"),
            }
            cursor += 1;
        }

        ensure!(iterations > 0, "--iterations must be greater than zero");
        ensure!(warmup_iterations > 0, "--warmup must be greater than zero");
        Ok(Self {
            runtime: runtime.context("--runtime is required")?,
            api: api.context("--api is required")?,
            iterations,
            warmup_iterations,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunReport {
    schema: &'static str,
    classification: &'static str,
    release_evidence: bool,
    runtime: &'static str,
    api: &'static str,
    calling_contract: &'static str,
    execution_owner: &'static str,
    sdk_queue: &'static str,
    topology: &'static str,
    process_model: &'static str,
    sql: &'static str,
    iterations: usize,
    warmup_iterations: usize,
    open_micros: f64,
    close_micros: f64,
    operations: Vec<OperationReport>,
}

impl RunReport {
    fn new(
        options: Options,
        open: Duration,
        close: Duration,
        operations: Vec<OperationReport>,
    ) -> Self {
        Self {
            schema: REPORT_SCHEMA,
            classification: CLASSIFICATION,
            release_evidence: false,
            runtime: options.runtime.label(),
            api: options.api.label(),
            calling_contract: options.api.calling_contract(),
            execution_owner: options.runtime.execution_owner(options.api),
            sdk_queue: options.api.sdk_queue(),
            topology: "direct",
            process_model: "one-api-model-per-process",
            sql: SELECT_ONE_SQL,
            iterations: options.iterations,
            warmup_iterations: options.warmup_iterations,
            open_micros: duration_micros(open),
            close_micros: duration_micros(close),
            operations,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationReport {
    operation: &'static str,
    samples: usize,
    total_micros: f64,
    mean_micros: f64,
    operations_per_second: f64,
    min_micros: f64,
    p50_micros: f64,
    p95_micros: f64,
    p99_micros: f64,
    max_micros: f64,
}

impl OperationReport {
    fn from_samples(operation: &'static str, mut samples: Vec<u64>) -> Result<Self> {
        ensure!(!samples.is_empty(), "{operation} produced no samples");
        samples.sort_unstable();
        let total_nanos = samples.iter().map(|sample| *sample as u128).sum::<u128>();
        let total_micros = total_nanos as f64 / 1_000.0;
        let sample_count = samples.len();
        Ok(Self {
            operation,
            samples: sample_count,
            total_micros,
            mean_micros: total_micros / sample_count as f64,
            operations_per_second: sample_count as f64 * 1_000_000.0 / total_micros,
            min_micros: samples[0] as f64 / 1_000.0,
            p50_micros: percentile_nanos(&samples, 50) as f64 / 1_000.0,
            p95_micros: percentile_nanos(&samples, 95) as f64 / 1_000.0,
            p99_micros: percentile_nanos(&samples, 99) as f64 / 1_000.0,
            max_micros: samples[sample_count - 1] as f64 / 1_000.0,
        })
    }
}

fn percentile_nanos(sorted: &[u64], percentile: usize) -> u64 {
    let rank = (percentile * sorted.len()).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn duration_micros(duration: Duration) -> f64 {
    duration.as_nanos() as f64 / 1_000.0
}

fn elapsed_nanos(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

fn simple_query_request(sql: &str) -> Vec<u8> {
    let payload_len = sql.len() + 1;
    let length = u32::try_from(payload_len + 4).expect("benchmark SQL request length fits u32");
    let mut request = Vec::with_capacity(payload_len + 5);
    request.push(b'Q');
    request.extend(length.to_be_bytes());
    request.extend(sql.as_bytes());
    request.push(0);
    request
}

fn validate_protocol_response(response: &[u8]) -> Result<()> {
    let mut offset = 0usize;
    let mut ready = false;
    while offset + 5 <= response.len() {
        let tag = response[offset];
        let length = u32::from_be_bytes([
            response[offset + 1],
            response[offset + 2],
            response[offset + 3],
            response[offset + 4],
        ]) as usize;
        ensure!(length >= 4, "invalid backend message length {length}");
        let frame_len = 1 + length;
        ensure!(
            frame_len <= response.len() - offset,
            "truncated backend message"
        );
        ensure!(tag != b'E', "backend returned ErrorResponse");
        ready |= tag == b'Z';
        offset += frame_len;
    }
    ensure!(offset == response.len(), "trailing backend response bytes");
    ensure!(ready, "backend response omitted ReadyForQuery");
    Ok(())
}

fn measure_sync<T>(
    iterations: usize,
    mut operation: impl FnMut() -> Result<T>,
    mut validate: impl FnMut(T) -> Result<()>,
) -> Result<Vec<u64>> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let value = operation()?;
        samples.push(elapsed_nanos(started));
        validate(value)?;
    }
    Ok(samples)
}

async fn measure_async<T>(
    iterations: usize,
    mut operation: impl AsyncFnMut() -> Result<T>,
    mut validate: impl FnMut(T) -> Result<()>,
) -> Result<Vec<u64>> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let value = operation().await?;
        samples.push(elapsed_nanos(started));
        validate(value)?;
    }
    Ok(samples)
}

trait SyncDiagnosticDatabase {
    type QueryOutput;

    fn query_one(&mut self) -> Result<Self::QueryOutput>;
    fn raw_query(&mut self, request: &[u8]) -> Result<Vec<u8>>;
    fn validate_query(output: Self::QueryOutput) -> Result<()>;
}

trait AsyncDiagnosticDatabase {
    type QueryOutput;

    async fn query_one(&self) -> Result<Self::QueryOutput>;
    async fn raw_query(&self, request: &[u8]) -> Result<Vec<u8>>;
    fn validate_query(output: Self::QueryOutput) -> Result<()>;
}

fn validate_select_one(value: Option<&str>) -> Result<()> {
    ensure!(value == Some("1"), "unexpected SELECT 1 result");
    Ok(())
}

impl SyncDiagnosticDatabase for oliphaunt::Oliphaunt {
    type QueryOutput = oliphaunt::QueryResult;

    fn query_one(&mut self) -> Result<Self::QueryOutput> {
        Ok(self.query(SELECT_ONE_SQL)?)
    }

    fn raw_query(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        Ok(self.exec_protocol_raw(request)?)
    }

    fn validate_query(output: Self::QueryOutput) -> Result<()> {
        validate_select_one(output.get_text(0, "value")?)
    }
}

impl AsyncDiagnosticDatabase for oliphaunt::AsyncOliphaunt {
    type QueryOutput = oliphaunt::QueryResult;

    async fn query_one(&self) -> Result<Self::QueryOutput> {
        Ok(self.query(SELECT_ONE_SQL).await?)
    }

    async fn raw_query(&self, request: &[u8]) -> Result<Vec<u8>> {
        Ok(self.exec_protocol_raw(request).await?)
    }

    fn validate_query(output: Self::QueryOutput) -> Result<()> {
        validate_select_one(output.get_text(0, "value")?)
    }
}

#[cfg(feature = "rust-api-model-wasix")]
impl SyncDiagnosticDatabase for oliphaunt_wasix::Oliphaunt {
    type QueryOutput = oliphaunt_wasix::QueryResult;

    fn query_one(&mut self) -> Result<Self::QueryOutput> {
        Ok(self.query(SELECT_ONE_SQL)?)
    }

    fn raw_query(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        Ok(self.exec_protocol_raw(request)?)
    }

    fn validate_query(output: Self::QueryOutput) -> Result<()> {
        validate_select_one(output.get_text(0, "value")?)
    }
}

#[cfg(feature = "rust-api-model-wasix")]
impl AsyncDiagnosticDatabase for oliphaunt_wasix::AsyncOliphaunt {
    type QueryOutput = oliphaunt_wasix::QueryResult;

    async fn query_one(&self) -> Result<Self::QueryOutput> {
        Ok(self.query(SELECT_ONE_SQL).await?)
    }

    async fn raw_query(&self, request: &[u8]) -> Result<Vec<u8>> {
        Ok(self.exec_protocol_raw(request).await?)
    }

    fn validate_query(output: Self::QueryOutput) -> Result<()> {
        validate_select_one(output.get_text(0, "value")?)
    }
}

fn run_sync_operations<D: SyncDiagnosticDatabase>(
    database: &mut D,
    options: Options,
    request: &[u8],
) -> Result<Vec<OperationReport>> {
    measure_sync(
        options.warmup_iterations,
        || database.query_one(),
        D::validate_query,
    )?;
    let query = OperationReport::from_samples(
        "query-select-1",
        measure_sync(
            options.iterations,
            || database.query_one(),
            D::validate_query,
        )?,
    )?;

    measure_sync(
        options.warmup_iterations,
        || database.raw_query(request),
        |response| validate_protocol_response(&response),
    )?;
    let raw = OperationReport::from_samples(
        "raw-simple-query-select-1",
        measure_sync(
            options.iterations,
            || database.raw_query(request),
            |response| validate_protocol_response(&response),
        )?,
    )?;

    Ok(vec![query, raw])
}

async fn run_async_operations<D: AsyncDiagnosticDatabase>(
    database: &D,
    options: Options,
    request: &[u8],
) -> Result<Vec<OperationReport>> {
    measure_async(
        options.warmup_iterations,
        async || database.query_one().await,
        D::validate_query,
    )
    .await?;
    let query = OperationReport::from_samples(
        "query-select-1",
        measure_async(
            options.iterations,
            async || database.query_one().await,
            D::validate_query,
        )
        .await?,
    )?;

    measure_async(
        options.warmup_iterations,
        async || database.raw_query(request).await,
        |response| validate_protocol_response(&response),
    )
    .await?;
    let raw = OperationReport::from_samples(
        "raw-simple-query-select-1",
        measure_async(
            options.iterations,
            async || database.raw_query(request).await,
            |response| validate_protocol_response(&response),
        )
        .await?,
    )?;

    Ok(vec![query, raw])
}

fn run_native_sync(options: Options) -> Result<RunReport> {
    let opened = Instant::now();
    let mut database = oliphaunt::Oliphaunt::builder()
        .direct()
        .open()
        .context("open native synchronous diagnostic database")?;
    let open = opened.elapsed();
    let request = simple_query_request(SELECT_ONE_SQL);
    let operations = run_sync_operations(&mut database, options, &request)?;

    let closed = Instant::now();
    database
        .close()
        .context("close native synchronous diagnostic database")?;
    Ok(RunReport::new(options, open, closed.elapsed(), operations))
}

fn run_native_async(options: Options) -> Result<RunReport> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .context("build diagnostic Tokio runtime")?
        .block_on(async move {
            let opened = Instant::now();
            let database = oliphaunt::AsyncOliphaunt::builder()
                .direct()
                .open()
                .await
                .context("open native asynchronous diagnostic database")?;
            let open = opened.elapsed();
            let request = simple_query_request(SELECT_ONE_SQL);
            let operations = run_async_operations(&database, options, &request).await?;

            let closed = Instant::now();
            database
                .close()
                .await
                .context("close native asynchronous diagnostic database")?;
            Ok(RunReport::new(options, open, closed.elapsed(), operations))
        })
}

#[cfg(feature = "rust-api-model-wasix")]
fn run_wasix_sync(options: Options) -> Result<RunReport> {
    let opened = Instant::now();
    let mut database =
        oliphaunt_wasix::Oliphaunt::open().context("open WASIX synchronous diagnostic database")?;
    let open = opened.elapsed();
    let request = simple_query_request(SELECT_ONE_SQL);
    let operations = run_sync_operations(&mut database, options, &request)?;

    let closed = Instant::now();
    database
        .close()
        .context("close WASIX synchronous diagnostic database")?;
    Ok(RunReport::new(options, open, closed.elapsed(), operations))
}

#[cfg(not(feature = "rust-api-model-wasix"))]
fn run_wasix_sync(_options: Options) -> Result<RunReport> {
    bail!("WASIX diagnostics require --features rust-api-model-wasix")
}

#[cfg(feature = "rust-api-model-wasix")]
fn run_wasix_async(options: Options) -> Result<RunReport> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .context("build diagnostic Tokio runtime")?
        .block_on(async move {
            let opened = Instant::now();
            let database = oliphaunt_wasix::AsyncOliphaunt::open()
                .await
                .context("open WASIX asynchronous diagnostic database")?;
            let open = opened.elapsed();
            let request = simple_query_request(SELECT_ONE_SQL);
            let operations = run_async_operations(&database, options, &request).await?;

            let closed = Instant::now();
            database
                .close()
                .await
                .context("close WASIX asynchronous diagnostic database")?;
            Ok(RunReport::new(options, open, closed.elapsed(), operations))
        })
}

#[cfg(not(feature = "rust-api-model-wasix"))]
fn run_wasix_async(_options: Options) -> Result<RunReport> {
    bail!("WASIX diagnostics require --features rust-api-model-wasix")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_require_explicit_runtime_and_api() {
        let error = Options::parse(&[]).unwrap_err();
        assert!(error.to_string().contains("--runtime is required"));

        let options = Options::parse(&[
            "--runtime".into(),
            "native".into(),
            "--api".into(),
            "async".into(),
            "--iterations".into(),
            "17".into(),
            "--warmup".into(),
            "3".into(),
        ])
        .unwrap();
        assert_eq!(options.runtime, RuntimeFamily::Native);
        assert_eq!(options.api, ApiModel::Async);
        assert_eq!(options.iterations, 17);
        assert_eq!(options.warmup_iterations, 3);
    }

    #[test]
    fn report_stats_use_nearest_rank_percentiles() {
        let report = OperationReport::from_samples(
            "probe",
            (1_u64..=100).map(|value| value * 1_000).collect(),
        )
        .unwrap();
        assert_eq!(report.samples, 100);
        assert_eq!(report.mean_micros, 50.5);
        assert_eq!(report.p50_micros, 50.0);
        assert_eq!(report.p95_micros, 95.0);
        assert_eq!(report.p99_micros, 99.0);
    }

    #[test]
    fn raw_response_validation_requires_ready_and_rejects_errors() {
        let ready = [b'Z', 0, 0, 0, 5, b'I'];
        validate_protocol_response(&ready).unwrap();

        let error = [b'E', 0, 0, 0, 4];
        assert!(validate_protocol_response(&error).is_err());
        let command = [b'C', 0, 0, 0, 4];
        assert!(validate_protocol_response(&command).is_err());
    }
}
