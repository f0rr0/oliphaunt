mod startup;

use std::error::Error as StdError;
use std::fmt;
use std::io::{Cursor, Read, Seek, Write};
use std::mem::MaybeUninit;
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use tempfile::TempDir;
use wasmer_types::ModuleHash;
use wasmer_wasix::WasiRuntimeError;
use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
use wasmer_wasix::virtual_fs::{self, AsyncRead, AsyncSeek, AsyncWrite};
use wasmer_wasix::virtual_net::tcp_pair::TcpSocketHalf;
use wasmer_wasix::virtual_net::{
    self, InterestHandler, NetworkError, SocketStatus, VirtualConnectedSocket, VirtualIoSource,
    VirtualNetworking, VirtualSocket, VirtualTcpSocket,
};
use wasmer_wasix::{PluggableRuntime, VirtualFile};

use crate::oliphaunt::base::unpack_runtime_archive_reader;
use crate::oliphaunt::sync_host_fs::SyncHostFileSystem;
use crate::oliphaunt::{aot, assets};

const PG_DUMP_SHORT_OPTIONS: &str = "abBcCd:e:E:f:F:h:j:n:N:Op:RsS:t:T:U:vwWxXZ:";
const PSQL_SHORT_OPTIONS: &str = "aAbc:d:eEf:F:h:HlL:no:p:P:qR:sStT:U:v:VwWxXz?01";
const PG_DUMP_VALUE_OPTIONS: &[&str] = &[
    "--extension",
    "--schema",
    "--exclude-schema",
    "--superuser",
    "--table",
    "--exclude-table",
    "--exclude-table-data",
    "--extra-float-digits",
    "--lock-wait-timeout",
    "--role",
    "--section",
    "--snapshot",
    "--rows-per-insert",
    "--include-foreign-data",
    "--table-and-children",
    "--exclude-table-and-children",
    "--exclude-table-data-and-children",
    "--sync-method",
    "--exclude-extension",
    "--restrict-key",
];
const PSQL_VALUE_OPTIONS: &[&str] = &[
    "--field-separator",
    "--pset",
    "--record-separator",
    "--table-attr",
    "--set",
    "--variable",
];

/// Options for the bundled, in-memory WASIX `pg_dump` runner.
///
/// Captures complete output in memory, subject to available memory and host
/// string-size limits. Use a destination API to avoid retaining stdout.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PgDumpOptions {
    args: Vec<String>,
    startup_timeout: Option<Duration>,
    startup_deadline: Option<Instant>,
    assets: Option<Arc<ToolAssets>>,
}

/// Explicit utility assets from the selected PostgreSQL tools package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolAssets {
    wasm: Vec<u8>,
    aot: Vec<u8>,
    manifest: String,
}

impl ToolAssets {
    /// Supply a trusted compiler-produced utility and its target manifest.
    ///
    /// # Safety
    /// AOT bytes contain native machine code and must come from a trusted package.
    /// Manifest and checksum validation detects mismatches, not malicious code.
    #[allow(unsafe_code)]
    pub unsafe fn new(wasm: Vec<u8>, aot: Vec<u8>, manifest: String) -> Self {
        Self {
            wasm,
            aot,
            manifest,
        }
    }
}

impl PgDumpOptions {
    pub(crate) fn start_startup_budget(mut self) -> Self {
        if self.startup_deadline.is_none() {
            self.startup_deadline = Instant::now()
                .checked_add(self.startup_timeout.unwrap_or(startup::DEFAULT_TIMEOUT));
        }
        self
    }

    /// Begin the existing startup budget before the native adapter copies or queues assets.
    #[cfg(feature = "__internal-napi")]
    #[doc(hidden)]
    pub fn __start_startup_budget(self) -> Self {
        self.start_startup_budget()
    }

    /// Budget through opening the embedded protocol connection; queries/output are excluded.
    /// Defaults to 30 seconds. Expiry cancels the owned guest and waits for cleanup.
    pub fn startup_timeout(mut self, timeout: Duration) -> Self {
        self.startup_timeout = Some(timeout);
        self
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        tool_input_bytes(&self.args, self.assets.as_deref())
    }

    /// Use separately installed utility assets instead of bundled Cargo assets.
    pub fn assets(mut self, assets: ToolAssets) -> Self {
        self.assets = Some(Arc::new(assets));
        self
    }
}

/// Structured failure from a packaged PostgreSQL frontend program.
///
/// On output-capture failure, [`Self::stdout`] and [`Self::stderr`] are empty
/// so neither stream exposes an incomplete prefix.
#[derive(Debug)]
pub struct PostgresToolError {
    tool: &'static str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    stderr_truncated: bool,
    cause: anyhow::Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolOutputCaptureFailure {
    AllocationFailed,
    LockPoisoned,
}

impl ToolOutputCaptureFailure {
    fn io_error(self) -> std::io::Error {
        let kind = match self {
            Self::AllocationFailed => std::io::ErrorKind::OutOfMemory,
            Self::LockPoisoned => std::io::ErrorKind::Other,
        };
        std::io::Error::new(kind, self)
    }
}

impl fmt::Display for ToolOutputCaptureFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllocationFailed => {
                formatter.write_str("could not reserve memory for tool output")
            }
            Self::LockPoisoned => {
                formatter.write_str("stdout and stderr capture lock was poisoned")
            }
        }
    }
}

impl StdError for ToolOutputCaptureFailure {}

#[derive(Debug)]
struct ToolOutputCaptureError {
    failure: ToolOutputCaptureFailure,
    runner_failure: Option<String>,
}

impl fmt::Display for ToolOutputCaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.failure)?;
        if let Some(runner_failure) = &self.runner_failure {
            write!(formatter, "; WASIX tool also failed: {runner_failure}")?;
        }
        Ok(())
    }
}

impl StdError for ToolOutputCaptureError {}

/// Internal marker for a broken virtual connection after a tool may have sent work.
#[derive(Debug)]
pub(crate) struct DirectToolOutcomeUnknown;

impl fmt::Display for DirectToolOutcomeUnknown {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("direct WASIX tool protocol outcome is unknown")
    }
}

impl StdError for DirectToolOutcomeUnknown {}

pub(crate) fn is_direct_tool_outcome_unknown(error: &anyhow::Error) -> bool {
    error.downcast_ref::<DirectToolOutcomeUnknown>().is_some()
}

impl PostgresToolError {
    fn from_output(
        tool: &'static str,
        exit_code: Option<i32>,
        stdout_bytes: Vec<u8>,
        stderr_bytes: Vec<u8>,
        cause: anyhow::Error,
    ) -> Self {
        Self {
            tool,
            exit_code,
            stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
            stdout_bytes,
            stderr_bytes,
            stderr_truncated: false,
            cause,
        }
    }

    pub fn tool(&self) -> &'static str {
        self.tool
    }

    /// Return the frontend program's exit code when one is available.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    /// Return captured standard output.
    ///
    /// This is empty after output-capture overflow.
    pub fn stdout(&self) -> &str {
        &self.stdout
    }

    /// Return captured standard error.
    ///
    /// This is empty after output-capture overflow.
    pub fn stderr(&self) -> &str {
        &self.stderr
    }

    /// Whether earlier diagnostics were discarded on a destination invocation.
    pub fn stderr_truncated(&self) -> bool {
        self.stderr_truncated
    }

    /// Exact stdout bytes, including output which is not valid UTF-8.
    pub fn stdout_bytes(&self) -> &[u8] {
        &self.stdout_bytes
    }

    /// Exact stderr bytes, including output which is not valid UTF-8.
    pub fn stderr_bytes(&self) -> &[u8] {
        &self.stderr_bytes
    }
}

impl fmt::Display for PostgresToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(cause) = self.cause.downcast_ref::<ToolOutputCaptureError>() {
            return write!(formatter, "{} output capture failed: {cause}", self.tool);
        }
        if self
            .cause
            .downcast_ref::<std::string::FromUtf8Error>()
            .is_some()
        {
            return write!(
                formatter,
                "{} produced non-UTF-8 output: {}",
                self.tool, self.cause
            );
        }
        write!(formatter, "{} failed", self.tool)?;
        if let Some(code) = self.exit_code {
            write!(formatter, " with status {code}")?;
        }
        if !self.stderr.trim().is_empty() {
            write!(formatter, ": {}", self.stderr.trim())?;
        }
        Ok(())
    }
}

impl StdError for PostgresToolError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(self.cause.as_ref())
    }
}

impl PgDumpOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one raw `pg_dump` argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Add raw `pg_dump` arguments.
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if let Some(timeout) = self.startup_timeout {
            startup::validate_timeout(timeout)?;
        }
        validate_tool_args(
            "pg_dump",
            &self.args,
            disallowed_pg_dump_flag,
            PG_DUMP_SHORT_OPTIONS,
            PG_DUMP_VALUE_OPTIONS,
        )
    }
}

/// Options for the bundled, in-memory WASIX `psql` runner.
///
/// Captures complete output in memory, subject to available memory and host
/// string-size limits. Use a destination API to avoid retaining stdout.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PsqlOptions {
    args: Vec<String>,
    input: Option<PsqlInput>,
    startup_timeout: Option<Duration>,
    startup_deadline: Option<Instant>,
    assets: Option<Arc<ToolAssets>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PsqlInput {
    Command(String),
    Script(String),
}

impl PsqlOptions {
    pub(crate) fn start_startup_budget(mut self) -> Self {
        if self.startup_deadline.is_none() {
            self.startup_deadline = Instant::now()
                .checked_add(self.startup_timeout.unwrap_or(startup::DEFAULT_TIMEOUT));
        }
        self
    }

    /// Begin the existing startup budget before the native adapter copies or queues assets.
    #[cfg(feature = "__internal-napi")]
    #[doc(hidden)]
    pub fn __start_startup_budget(self) -> Self {
        self.start_startup_budget()
    }

    /// Budget through opening the embedded protocol connection; queries/output are excluded.
    /// Defaults to 30 seconds. Expiry cancels the owned guest and waits for cleanup.
    pub fn startup_timeout(mut self, timeout: Duration) -> Self {
        self.startup_timeout = Some(timeout);
        self
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        let input = match &self.input {
            Some(PsqlInput::Command(value) | PsqlInput::Script(value)) => value.capacity(),
            None => 0,
        };
        tool_input_bytes(&self.args, self.assets.as_deref()).saturating_add(input)
    }

    /// Use separately installed utility assets instead of bundled Cargo assets.
    pub fn assets(mut self, assets: ToolAssets) -> Self {
        self.assets = Some(Arc::new(assets));
        self
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// Add one raw `psql` argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Add raw `psql` arguments.
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Run a non-interactive SQL command with `psql -c`.
    pub fn command(mut self, sql: impl Into<String>) -> Self {
        self.input = Some(PsqlInput::Command(sql.into()));
        self
    }

    /// Run a SQL script through `psql` standard input.
    pub fn script(mut self, sql: impl Into<String>) -> Self {
        self.input = Some(PsqlInput::Script(sql.into()));
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if let Some(timeout) = self.startup_timeout {
            startup::validate_timeout(timeout)?;
        }
        anyhow::ensure!(
            !self.args.is_empty() || self.input.is_some(),
            "psql runner requires non-interactive input; use PsqlOptions::command, PsqlOptions::script, or pass a non-input psql argument"
        );
        validate_tool_args(
            "psql",
            &self.args,
            disallowed_psql_flag,
            PSQL_SHORT_OPTIONS,
            PSQL_VALUE_OPTIONS,
        )?;
        if let Some(input) = &self.input {
            let (name, value) = match input {
                PsqlInput::Command(value) => ("command", value),
                PsqlInput::Script(value) => ("script", value),
            };
            anyhow::ensure!(
                !value.contains('\0'),
                "psql {name} must not contain NUL bytes"
            );
        }
        Ok(())
    }
}

fn tool_input_bytes(args: &[String], assets: Option<&ToolAssets>) -> usize {
    let bytes = args.iter().fold(
        args.len().saturating_mul(size_of::<String>()),
        |bytes, arg| bytes.saturating_add(arg.capacity()),
    );
    assets.map_or(bytes, |assets| {
        bytes
            .saturating_add(assets.wasm.capacity())
            .saturating_add(assets.aot.capacity())
            .saturating_add(assets.manifest.capacity())
    })
}

fn validate_tool_args(
    tool: &'static str,
    arguments: &[String],
    disallowed: fn(&str) -> Option<&'static str>,
    short_options: &str,
    value_options: &[&str],
) -> Result<()> {
    let mut expects_value = false;
    for argument in arguments {
        anyhow::ensure!(
            !argument.contains('\0'),
            "{tool} argument must not contain NUL bytes"
        );
        if expects_value {
            expects_value = false;
            continue;
        }
        if let Some(flag) = disallowed(argument) {
            bail!("{tool} argument '{argument}' conflicts with oliphaunt-wasix's managed {flag}");
        }
        anyhow::ensure!(
            argument != "-" && argument.starts_with('-'),
            "{tool} argument '{argument}' conflicts with oliphaunt-wasix's managed database or username"
        );
        expects_value = option_consumes_next(argument, short_options, value_options);
    }
    if expects_value {
        bail!(
            "{tool} argument '{}' requires a value",
            arguments.last().expect("a pending option has an argument")
        );
    }
    Ok(())
}

fn option_consumes_next(argument: &str, short_options: &str, value_options: &[&str]) -> bool {
    if argument.starts_with("--") {
        return !argument.contains('=')
            && value_options
                .iter()
                .any(|option| option.starts_with(argument));
    }
    let bytes = argument.as_bytes();
    let option_spec = short_options.as_bytes();
    for (index, option) in bytes[1..].iter().enumerate() {
        let Some(position) = option_spec.iter().position(|candidate| candidate == option) else {
            return false;
        };
        if option_spec.get(position + 1) == Some(&b':') {
            return index + 2 == bytes.len();
        }
    }
    false
}

fn disallowed_pg_dump_flag(arg: &str) -> Option<&'static str> {
    if arg == "--" {
        return Some("option terminator");
    }
    const LONG_FLAGS: &[(&str, &str)] = &[
        ("--password", "password prompting"),
        ("--filter", "input file"),
        ("--file", "output file"),
        ("--format", "output format"),
        ("--compress", "output compression"),
        ("--encoding", "output encoding"),
        ("--host", "host"),
        ("--port", "port"),
        ("--username", "username"),
        ("--dbname", "database"),
        ("--jobs", "job count"),
    ];
    const SHORT_FLAGS: &[(&str, &str)] = &[
        ("-W", "password prompting"),
        ("-f", "output file"),
        ("-F", "output format"),
        ("-Z", "output compression"),
        ("-E", "output encoding"),
        ("-h", "host"),
        ("-p", "port"),
        ("-U", "username"),
        ("-d", "database"),
        ("-j", "job count"),
    ];
    disallowed_flag(arg, LONG_FLAGS, SHORT_FLAGS, PG_DUMP_SHORT_OPTIONS)
}

fn disallowed_psql_flag(arg: &str) -> Option<&'static str> {
    if arg == "--" {
        return Some("option terminator");
    }
    const LONG_FLAGS: &[(&str, &str)] = &[
        ("--password", "password prompting"),
        ("--single-step", "interactive prompting"),
        ("--host", "host"),
        ("--port", "port"),
        ("--username", "username"),
        ("--dbname", "database"),
        ("--output", "stdout capture"),
        ("--log-file", "stderr capture"),
        ("--command", "input"),
        ("--file", "input"),
    ];
    const SHORT_FLAGS: &[(&str, &str)] = &[
        ("-W", "password prompting"),
        ("-s", "interactive prompting"),
        ("-h", "host"),
        ("-p", "port"),
        ("-U", "username"),
        ("-d", "database"),
        ("-o", "stdout capture"),
        ("-L", "stderr capture"),
        ("-c", "input"),
        ("-f", "input"),
    ];
    disallowed_flag(arg, LONG_FLAGS, SHORT_FLAGS, PSQL_SHORT_OPTIONS)
}

fn disallowed_flag(
    argument: &str,
    long: &[(&'static str, &'static str)],
    short: &[(&'static str, &'static str)],
    short_options: &str,
) -> Option<&'static str> {
    let long_name = argument.split_once('=').map_or(argument, |(name, _)| name);
    for (flag, label) in long {
        // Native getopt_long accepts unique prefixes while PostgreSQL's
        // bundled fallback requires exact names. Reject either spelling
        // consistently so a managed option cannot become host-dependent.
        if long_name.len() > 2 && long_name.starts_with("--") && flag.starts_with(long_name) {
            return Some(label);
        }
    }
    let bytes = argument.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'-' || bytes[1] == b'-' {
        return None;
    }
    let option_spec = short_options.as_bytes();
    for option in &bytes[1..] {
        let position = option_spec
            .iter()
            .position(|candidate| candidate == option)?;
        if let Some((_, label)) = short
            .iter()
            .find(|(flag, _)| flag.as_bytes() == [b'-', *option])
        {
            return Some(label);
        }
        if option_spec.get(position + 1) == Some(&b':') {
            return None;
        }
    }
    None
}

fn pg_dump_wasm_asset() -> Result<&'static [u8]> {
    assets::pg_dump_wasm()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "WASIX pg_dump asset is not bundled; enable the oliphaunt-wasix `tools` feature so Cargo installs oliphaunt-wasix-tools"
            )
        })
}

fn psql_wasm_asset() -> Result<&'static [u8]> {
    assets::psql_wasm()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "WASIX psql asset is not bundled; enable the oliphaunt-wasix `tools` feature so Cargo installs oliphaunt-wasix-tools"
            )
        })
}

/// Exact byte output from a packaged PostgreSQL frontend program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresToolOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_bytes: usize,
    stderr_truncated: bool,
}

impl PostgresToolOutput {
    /// Exact stdout bytes without UTF-8 conversion.
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    /// Exact stderr bytes without UTF-8 conversion.
    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }

    /// Consume the output into its exact stdout and stderr byte vectors.
    pub fn into_parts(self) -> (Vec<u8>, Vec<u8>) {
        (self.stdout, self.stderr)
    }
}

pub(crate) fn write_tool_file(
    tool: &'static str,
    destination: &Path,
    run: impl FnOnce(std::fs::File) -> Result<PostgresToolSummary>,
) -> Result<PostgresToolSummary> {
    let before_execution = |cause: std::io::Error| {
        anyhow::Error::new(PostgresToolError::from_output(
            tool,
            None,
            Vec::new(),
            Vec::new(),
            anyhow::Error::new(cause),
        ))
    };
    let mut staging = tempfile::Builder::new()
        .prefix(".oliphaunt-tool-")
        .tempfile_in(destination.parent().unwrap_or(Path::new(".")))
        .map_err(before_execution)?;
    let output = run(staging.reopen().map_err(before_execution)?)?;
    let failure = |cause: std::io::Error| {
        let mut error = PostgresToolError::from_output(
            tool,
            Some(0),
            Vec::new(),
            output.stderr.as_bytes().to_vec(),
            anyhow::Error::new(cause),
        );
        error.stderr_truncated = output.stderr_truncated;
        anyhow::Error::new(error)
    };
    staging.flush().map_err(failure)?;
    let staging = staging.into_temp_path();
    std::fs::hard_link(&staging, destination).map_err(failure)?;
    staging.close().map_err(|cause| {
        failure(std::io::Error::new(
            cause.kind(),
            format!(
                "output was published to {}; staging cleanup failed: {cause}",
                destination.display()
            ),
        ))
    })?;
    Ok(output)
}

/// Completion of a tool invocation writing exact bytes to a destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresToolSummary {
    pub stdout_bytes: usize,
    /// Latest 8 KiB of diagnostics, decoded lossily as UTF-8.
    pub stderr: String,
    pub stderr_truncated: bool,
}

impl PostgresToolOutput {
    pub(crate) fn summary(self) -> PostgresToolSummary {
        PostgresToolSummary {
            stdout_bytes: self.stdout_bytes,
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            stderr_truncated: self.stderr_truncated,
        }
    }
}

pub(crate) struct ToolWriters {
    pub stdout: Box<dyn Write + Send>,
    pub stderr: Option<Box<dyn Write + Send>>,
}

type SharedToolOutputCapture = Arc<Mutex<ToolOutputCapture>>;

struct ToolInvocation<'a> {
    name: &'static str,
    wasm: &'a [u8],
    load_module: fn(&wasmer::Engine) -> Result<wasmer::Module>,
    assets: Option<&'a ToolAssets>,
    username: &'a str,
    networking: DirectToolNetworking,
    stdin: Option<Vec<u8>>,
    args: Vec<String>,
}

#[allow(unsafe_code)]
fn run_wasix_client_tool(
    invocation: ToolInvocation<'_>,
    writers: Option<ToolWriters>,
) -> Result<PostgresToolOutput> {
    let ToolInvocation {
        name,
        wasm,
        load_module,
        assets,
        username,
        networking,
        stdin,
        args,
    } = invocation;
    let startup = networking.startup.clone();
    startup.check()?;
    let engine = aot::headless_engine()?;
    let module = match assets {
        // SAFETY: ToolAssets construction requires trusted compiler output.
        Some(assets) => unsafe {
            aot::load_external_tool_module(&engine, name, wasm, &assets.aot, &assets.manifest)
        },
        None => load_module(&engine),
    }
    .with_context(|| format!("load {name} AOT artifact from oliphaunt-wasix-tools-aot-*"))?;

    startup.check()?;
    let fs_root = TempDir::new().with_context(|| format!("create {name} WASIX filesystem root"))?;
    if let Some(runtime_archive) = assets::runtime_archive() {
        unpack_runtime_archive_reader(
            Cursor::new(runtime_archive),
            Path::new("oliphaunt.wasix.tar.zst"),
            fs_root.path(),
        )
        .with_context(|| format!("install WASIX runtime files for {name}"))?;
    }

    startup.check()?;
    let runtime = super::host_runtime::runtime()?;
    let (host_fs, wasix_runtime) = {
        let _runtime_guard = runtime.enter();
        let host_fs = SyncHostFileSystem::new(fs_root.path()).with_context(|| {
            format!(
                "create host filesystem rooted at {}",
                fs_root.path().display()
            )
        })?;
        let host_fs = Arc::new(host_fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
        let tasks = super::host_runtime::tasks()?;
        let supervision = startup.clone();
        let tasks =
            super::postgres_mod::task_policy::GuestTaskManager::observe(tasks, move |task| {
                supervision
                    .register(task.env.process.clone())
                    .map_err(|_| wasmer_wasix::WasiThreadError::Unsupported)
            });
        let mut wasix_runtime = PluggableRuntime::new(Arc::new(tasks));
        wasix_runtime.set_engine(engine.clone());
        wasix_runtime.set_networking_implementation(networking);
        (host_fs, wasix_runtime)
    };

    let capture = Arc::new(Mutex::new(ToolOutputCapture {
        bounded_diagnostics: writers.is_some(),
        ..ToolOutputCapture::default()
    }));
    let (stdout_destination, stderr_destination) = writers
        .map(|writers| (Some(writers.stdout), writers.stderr))
        .unwrap_or_default();
    let stdout_file = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stdout)
        .destination(stdout_destination);
    let stderr_file = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stderr)
        .destination(stderr_destination);
    let destinations = [
        stdout_file.destination.clone(),
        stderr_file.destination.clone(),
    ];
    let mut runner = WasiRunner::new();
    runner
        .with_mount("/".to_owned(), Arc::clone(&host_fs))
        .with_current_dir("/")
        .with_args(args)
        .with_envs([
            ("PGUSER", username),
            ("PGPASSWORD", "password"),
            ("PGSSLMODE", "disable"),
            ("PGCLIENTENCODING", "UTF8"),
        ])
        .with_stdout(Box::new(stdout_file))
        .with_stderr(Box::new(stderr_file));
    if name == "psql" {
        runner.with_envs([("OLIPHAUNT_PSQL_NONINTERACTIVE", "1")]);
    }
    match stdin {
        Some(input) => runner.with_stdin(Box::new(virtual_fs::StaticFile::new(input))),
        None => runner.with_stdin(Box::<virtual_fs::null_file::NullFile>::default()),
    };
    startup.check()?;
    let _runtime_guard = runtime.enter();
    let run_result = runner.run_wasm(
        RuntimeOrEngine::Runtime(Arc::new(wasix_runtime)),
        name,
        module,
        ModuleHash::sha256(wasm),
    );
    // Owned writers cannot be flushed by the caller after moving to the tool.
    // Observe buffered destination errors before reporting a completed invocation.
    for destination in destinations.into_iter().flatten() {
        let result = destination
            .lock()
            .map_err(|_| std::io::Error::other("tool destination writer lock poisoned"))
            .and_then(|mut writer| writer.flush());
        if let Err(error) = result {
            capture
                .lock()
                .map_err(|_| anyhow!("tool capture lock poisoned"))?
                .write_failure
                .get_or_insert(error);
        }
    }
    finish_wasix_client_tool_run(name, run_result, capture)
}

fn finish_wasix_client_tool_run(
    tool: &'static str,
    run_result: Result<()>,
    capture: SharedToolOutputCapture,
) -> Result<PostgresToolOutput> {
    let exit_code = match &run_result {
        Ok(()) => Some(0),
        Err(cause) => cause
            .chain()
            .find_map(|error| error.downcast_ref::<WasiRuntimeError>())
            .and_then(WasiRuntimeError::as_exit_code)
            .map(|code| code.raw()),
    };

    let write_failure = capture
        .lock()
        .ok()
        .and_then(|mut capture| capture.write_failure.take());
    let output = take_tool_output(&capture);
    if let (Some(failure), Ok(output)) = (write_failure, &output) {
        let mut cause = anyhow::Error::new(failure);
        if let Err(runner_failure) = run_result {
            cause = cause.context(format!("WASIX tool also failed: {runner_failure:#}"));
        }
        let mut error = PostgresToolError::from_output(
            tool,
            exit_code,
            Vec::new(),
            output.stderr.clone(),
            cause,
        );
        error.stderr_truncated = output.stderr_truncated;
        return Err(anyhow::Error::new(error));
    }
    match (run_result, output) {
        (Ok(()), Ok(output)) => Ok(output),
        (
            Err(cause),
            Ok(PostgresToolOutput {
                stdout,
                stderr,
                stderr_truncated,
                ..
            }),
        ) => {
            let mut error = PostgresToolError::from_output(tool, exit_code, stdout, stderr, cause);
            error.stderr_truncated = stderr_truncated;
            Err(anyhow::Error::new(error))
        }
        (run_result, Err(failure)) => {
            let runner_failure = run_result.err().map(|cause| format!("{cause:#}"));
            Err(anyhow::Error::new(PostgresToolError::from_output(
                tool,
                exit_code,
                Vec::new(),
                Vec::new(),
                anyhow::Error::new(ToolOutputCaptureError {
                    failure,
                    runner_failure,
                }),
            )))
        }
    }
}

fn take_tool_output(
    capture: &SharedToolOutputCapture,
) -> std::result::Result<PostgresToolOutput, ToolOutputCaptureFailure> {
    let mut capture = capture
        .lock()
        .map_err(|_| ToolOutputCaptureFailure::LockPoisoned)?;
    if let Some(failure) = capture.failure {
        capture.clear_buffers();
        return Err(failure);
    }
    let stdout_bytes = if capture.bounded_diagnostics {
        capture.stdout_bytes
    } else {
        capture.stdout.len()
    };
    let output = PostgresToolOutput {
        stdout: std::mem::take(&mut capture.stdout),
        stderr: std::mem::take(&mut capture.stderr),
        stdout_bytes,
        stderr_truncated: capture.stderr_truncated,
    };
    Ok(output)
}

fn pg_dump_with_networking(
    addr: SocketAddr,
    username: &str,
    database: &str,
    options: &PgDumpOptions,
    networking: DirectToolNetworking,
    writers: Option<ToolWriters>,
) -> Result<PostgresToolOutput> {
    options.validate()?;
    let mut args = options.args.clone();
    args.extend([
        "--encoding=UTF8".to_owned(),
        "--no-password".to_owned(),
        format!("--username={username}"),
        format!("--host={}", addr.ip()),
        format!("--port={}", addr.port()),
        format!("--dbname={database}"),
    ]);
    run_wasix_client_tool(
        ToolInvocation {
            name: "pg_dump",
            wasm: match &options.assets {
                Some(assets) => &assets.wasm,
                None => pg_dump_wasm_asset()?,
            },
            load_module: aot::load_pg_dump_module,
            assets: options.assets.as_deref(),
            username,
            networking,
            stdin: None,
            args,
        },
        writers,
    )
}

fn run_psql_with_networking(
    addr: SocketAddr,
    username: &str,
    database: &str,
    options: &PsqlOptions,
    networking: DirectToolNetworking,
    writers: Option<ToolWriters>,
) -> Result<PostgresToolOutput> {
    options.validate()?;
    let stdin = match &options.input {
        Some(PsqlInput::Script(script)) => Some(script.as_bytes().to_vec()),
        _ => None,
    };
    let args = psql_args(addr, username, database, options);
    run_wasix_client_tool(
        ToolInvocation {
            name: "psql",
            wasm: match &options.assets {
                Some(assets) => &assets.wasm,
                None => psql_wasm_asset()?,
            },
            load_module: aot::load_psql_module,
            assets: options.assets.as_deref(),
            username,
            networking,
            stdin,
            args,
        },
        writers,
    )
}

fn psql_args(
    addr: SocketAddr,
    username: &str,
    database: &str,
    options: &PsqlOptions,
) -> Vec<String> {
    let mut args = options.args.clone();
    args.extend([
        "--no-psqlrc".to_owned(),
        "--no-password".to_owned(),
        "--set=ON_ERROR_STOP=1".to_owned(),
        format!("--username={username}"),
        format!("--host={}", addr.ip()),
        format!("--port={}", addr.port()),
        format!("--dbname={database}"),
    ]);
    match &options.input {
        Some(PsqlInput::Command(command)) => {
            args.extend(["--command".to_owned(), command.clone()]);
        }
        Some(PsqlInput::Script(_)) => args.push("--file=-".to_owned()),
        None => {}
    }
    args
}

pub(crate) fn decode_tool_output(tool: &'static str, output: PostgresToolOutput) -> Result<String> {
    let PostgresToolOutput { stdout, stderr, .. } = output;
    String::from_utf8(stdout).map_err(|cause| {
        let stdout = cause.as_bytes().to_vec();
        anyhow::Error::new(PostgresToolError::from_output(
            tool,
            Some(0),
            stdout,
            stderr,
            anyhow!(cause),
        ))
    })
}

pub(crate) type DirectToolSocket = TcpSocketHalf;

pub(crate) fn run_direct_pg_dump_output<F>(
    username: &str,
    database: &str,
    options: &PgDumpOptions,
    writers: Option<ToolWriters>,
    serve: F,
) -> Result<PostgresToolOutput>
where
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let username = username.to_owned();
    let database = database.to_owned();
    let options = options.clone();
    run_direct_tool(
        options.startup_timeout.unwrap_or(startup::DEFAULT_TIMEOUT),
        options.startup_deadline,
        move |networking| {
            pg_dump_with_networking(
                DIRECT_TOOL_ADDR,
                &username,
                &database,
                &options,
                networking,
                writers,
            )
        },
        serve,
    )
}

pub(crate) fn run_direct_psql_output<F>(
    username: &str,
    database: &str,
    options: &PsqlOptions,
    writers: Option<ToolWriters>,
    serve: F,
) -> Result<PostgresToolOutput>
where
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let username = username.to_owned();
    let database = database.to_owned();
    let options = options.clone();
    run_direct_tool(
        options.startup_timeout.unwrap_or(startup::DEFAULT_TIMEOUT),
        options.startup_deadline,
        move |networking| {
            run_psql_with_networking(
                DIRECT_TOOL_ADDR,
                &username,
                &database,
                &options,
                networking,
                writers,
            )
        },
        serve,
    )
}

fn run_direct_tool<T, R, F>(
    timeout: Duration,
    deadline: Option<Instant>,
    run: R,
    serve: F,
) -> Result<T>
where
    T: Send + 'static,
    R: FnOnce(DirectToolNetworking) -> Result<T> + Send + 'static,
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let startup = Arc::new(startup::Startup::new(timeout, deadline)?);
    startup.check()?;
    let (socket_tx, socket_rx) = mpsc::sync_channel(1);
    let guest_startup = startup.clone();
    let runner = thread::spawn(move || run(DirectToolNetworking::new(socket_tx, guest_startup)));
    let accepted = receive_direct_tool_socket(&socket_rx, &runner, &startup)
        .context("accept direct WASIX tool protocol connection");
    let connection_started = accepted.is_ok();
    drop(socket_rx);
    let serve_result = accepted.and_then(serve);
    let run_result = match runner.join() {
        Ok(result) => result,
        Err(_) => Err(anyhow!("direct WASIX tool runner thread panicked")),
    };
    finish_direct_tool(connection_started, serve_result, run_result)
}

fn finish_direct_tool<T>(
    connection_started: bool,
    serve_result: Result<()>,
    run_result: Result<T>,
) -> Result<T> {
    match (serve_result, run_result) {
        (Ok(()), Ok(output)) => Ok(output),
        (Err(error), Ok(_)) if connection_started => Err(error.context(DirectToolOutcomeUnknown)),
        (Err(_), Ok(output)) => Ok(output),
        (Ok(()), Err(error)) if connection_started && !is_completed_postgres_tool_exit(&error) => {
            Err(error.context(DirectToolOutcomeUnknown))
        }
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(tool_error)) if connection_started => Err(error
            .context(format!("WASIX tool also failed: {tool_error:#}"))
            .context(DirectToolOutcomeUnknown)),
        (Err(error), Err(tool_error)) => {
            Err(error.context(format!("WASIX tool also failed: {tool_error:#}")))
        }
    }
}

fn is_completed_postgres_tool_exit(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<PostgresToolError>()
        .is_some_and(|error| error.exit_code.is_some())
}

const DIRECT_TOOL_PORT: u16 = 65_432;
const DIRECT_TOOL_LOCAL_PORT: u16 = 65_431;
const DIRECT_TOOL_SOCKET_BUFFER: usize = 256 * 1024;
const DIRECT_TOOL_ADDR: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DIRECT_TOOL_PORT);
const DIRECT_TOOL_LOCAL_ADDR: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DIRECT_TOOL_LOCAL_PORT);

struct DirectToolNetworking {
    socket_tx: Mutex<Option<SyncSender<DirectToolSocket>>>,
    startup: Arc<startup::Startup>,
}

impl DirectToolNetworking {
    fn new(socket_tx: SyncSender<DirectToolSocket>, startup: Arc<startup::Startup>) -> Self {
        Self {
            socket_tx: Mutex::new(Some(socket_tx)),
            startup,
        }
    }
}

impl fmt::Debug for DirectToolNetworking {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DirectToolNetworking")
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl VirtualNetworking for DirectToolNetworking {
    async fn connect_tcp(
        &self,
        addr: SocketAddr,
        peer: SocketAddr,
    ) -> virtual_net::Result<Box<dyn VirtualTcpSocket + Sync>> {
        if peer != DIRECT_TOOL_ADDR {
            return Err(NetworkError::ConnectionRefused);
        }
        let sender = self
            .socket_tx
            .lock()
            .map_err(|_| NetworkError::IOError)?
            .take()
            .ok_or(NetworkError::ConnectionRefused)?;
        let local = if addr.port() == 0 {
            DIRECT_TOOL_LOCAL_ADDR
        } else {
            addr
        };
        self.startup
            .connected()
            .map_err(|_| NetworkError::ConnectionAborted)?;
        let (guest, host) = TcpSocketHalf::channel(DIRECT_TOOL_SOCKET_BUFFER, local, peer);
        sender
            .send(host)
            .map_err(|_| NetworkError::ConnectionAborted)?;
        Ok(Box::new(DirectToolTcpSocket {
            inner: guest,
            first_write_ready_probe: true,
        }))
    }

    async fn resolve(
        &self,
        host: &str,
        _port: Option<u16>,
        _dns_server: Option<IpAddr>,
    ) -> virtual_net::Result<Vec<IpAddr>> {
        match host {
            "localhost" | "127.0.0.1" => Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]),
            _ => Err(NetworkError::AddressNotAvailable),
        }
    }
}

#[derive(Debug)]
struct DirectToolTcpSocket {
    inner: TcpSocketHalf,
    first_write_ready_probe: bool,
}

impl VirtualIoSource for DirectToolTcpSocket {
    fn remove_handler(&mut self) {
        self.inner.remove_handler();
    }

    fn poll_read_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<virtual_net::Result<usize>> {
        self.inner.poll_read_ready(cx)
    }

    fn poll_write_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<virtual_net::Result<usize>> {
        if self.first_write_ready_probe {
            self.first_write_ready_probe = false;
            return Poll::Ready(Ok(self.inner.send_buf_size().unwrap_or(1).max(1)));
        }
        self.inner.poll_write_ready(cx)
    }
}

impl VirtualSocket for DirectToolTcpSocket {
    fn set_ttl(&mut self, ttl: u32) -> virtual_net::Result<()> {
        self.inner.set_ttl(ttl)
    }
    fn ttl(&self) -> virtual_net::Result<u32> {
        self.inner.ttl()
    }
    fn addr_local(&self) -> virtual_net::Result<SocketAddr> {
        self.inner.addr_local()
    }
    fn status(&self) -> virtual_net::Result<SocketStatus> {
        self.inner.status()
    }
    fn set_handler(
        &mut self,
        handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> virtual_net::Result<()> {
        self.inner.set_handler(handler)
    }
}

impl VirtualConnectedSocket for DirectToolTcpSocket {
    fn set_linger(&mut self, linger: Option<Duration>) -> virtual_net::Result<()> {
        self.inner.set_linger(linger)
    }
    fn linger(&self) -> virtual_net::Result<Option<Duration>> {
        self.inner.linger()
    }
    fn try_send(&mut self, data: &[u8]) -> virtual_net::Result<usize> {
        self.inner.try_send(data)
    }
    fn try_flush(&mut self) -> virtual_net::Result<()> {
        self.inner.try_flush()
    }
    fn close(&mut self) -> virtual_net::Result<()> {
        self.inner.close()
    }
    fn try_recv(
        &mut self,
        buffer: &mut [MaybeUninit<u8>],
        peek: bool,
    ) -> virtual_net::Result<usize> {
        self.inner.try_recv(buffer, peek)
    }
}

impl VirtualTcpSocket for DirectToolTcpSocket {
    fn set_recv_buf_size(&mut self, size: usize) -> virtual_net::Result<()> {
        self.inner.set_recv_buf_size(size)
    }
    fn recv_buf_size(&self) -> virtual_net::Result<usize> {
        self.inner.recv_buf_size()
    }
    fn set_send_buf_size(&mut self, size: usize) -> virtual_net::Result<()> {
        self.inner.set_send_buf_size(size)
    }
    fn send_buf_size(&self) -> virtual_net::Result<usize> {
        self.inner.send_buf_size()
    }
    fn set_nodelay(&mut self, enabled: bool) -> virtual_net::Result<()> {
        self.inner.set_nodelay(enabled)
    }
    fn nodelay(&self) -> virtual_net::Result<bool> {
        self.inner.nodelay()
    }
    fn set_keepalive(&mut self, enabled: bool) -> virtual_net::Result<()> {
        self.inner.set_keepalive(enabled)
    }
    fn keepalive(&self) -> virtual_net::Result<bool> {
        self.inner.keepalive()
    }
    fn set_dontroute(&mut self, enabled: bool) -> virtual_net::Result<()> {
        self.inner.set_dontroute(enabled)
    }
    fn dontroute(&self) -> virtual_net::Result<bool> {
        self.inner.dontroute()
    }
    fn addr_peer(&self) -> virtual_net::Result<SocketAddr> {
        self.inner.addr_peer()
    }
    fn shutdown(&mut self, how: Shutdown) -> virtual_net::Result<()> {
        self.inner.shutdown(how)
    }
    fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

fn receive_direct_tool_socket<T>(
    socket_rx: &Receiver<DirectToolSocket>,
    runner: &thread::JoinHandle<Result<T>>,
    startup: &startup::Startup,
) -> Result<DirectToolSocket> {
    loop {
        match socket_rx.recv_timeout(startup.remaining().min(Duration::from_millis(5))) {
            Ok(socket) => return Ok(socket),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if runner.is_finished() {
                    bail!("WASIX tool exited before opening its virtual protocol connection");
                }
                startup.check()?;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("WASIX tool virtual networking channel closed before connect")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolOutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Default)]
struct ToolOutputCapture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    failure: Option<ToolOutputCaptureFailure>,
    bounded_diagnostics: bool,
    write_failure: Option<std::io::Error>,
    stdout_bytes: usize,
    stderr_truncated: bool,
}

impl ToolOutputCapture {
    fn stream_len(&self, stream: ToolOutputStream) -> usize {
        match stream {
            ToolOutputStream::Stdout if self.bounded_diagnostics => self.stdout_bytes,
            ToolOutputStream::Stdout => self.stdout.len(),
            ToolOutputStream::Stderr => self.stderr.len(),
        }
    }

    fn stream_mut(&mut self, stream: ToolOutputStream) -> &mut Vec<u8> {
        match stream {
            ToolOutputStream::Stdout => &mut self.stdout,
            ToolOutputStream::Stderr => &mut self.stderr,
        }
    }

    fn clear_buffers(&mut self) {
        self.stdout = Vec::new();
        self.stderr = Vec::new();
    }

    fn fail(&mut self, failure: ToolOutputCaptureFailure) -> std::io::Error {
        self.clear_buffers();
        let failure = *self.failure.get_or_insert(failure);
        failure.io_error()
    }

    fn reserve_for(&mut self, stream: ToolOutputStream, additional: usize) -> std::io::Result<()> {
        if let Some(failure) = self.failure {
            return Err(failure.io_error());
        }
        if self.stream_mut(stream).try_reserve(additional).is_err() {
            return Err(self.fail(ToolOutputCaptureFailure::AllocationFailed));
        }
        Ok(())
    }

    fn write(&mut self, stream: ToolOutputStream, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(failure) = self.failure {
            return Err(failure.io_error());
        }
        if self.bounded_diagnostics {
            if matches!(stream, ToolOutputStream::Stderr) {
                const TAIL_BYTES: usize = 8 * 1024;
                let excess = self
                    .stderr
                    .len()
                    .saturating_add(bytes.len())
                    .saturating_sub(TAIL_BYTES);
                self.stderr_truncated |= excess > 0;
                let tail = if bytes.len() >= TAIL_BYTES {
                    self.stderr.clear();
                    &bytes[bytes.len() - TAIL_BYTES..]
                } else {
                    self.stderr.drain(..excess);
                    bytes
                };
                self.reserve_for(stream, tail.len())?;
                self.stderr.extend_from_slice(tail);
            }
            if matches!(stream, ToolOutputStream::Stdout) {
                self.stdout_bytes = self.stdout_bytes.saturating_add(bytes.len());
            }
            // Keep the tool and protocol draining after a destination failure;
            // report that failure only after its real exit and session cleanup.
            return Ok(bytes.len());
        }
        self.reserve_for(stream, bytes.len())?;
        self.stream_mut(stream).extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn write_vectored(
        &mut self,
        stream: ToolOutputStream,
        buffers: &[std::io::IoSlice<'_>],
    ) -> std::io::Result<usize> {
        let Some(additional) = buffers
            .iter()
            .try_fold(0usize, |total, buffer| total.checked_add(buffer.len()))
        else {
            return Err(self.fail(ToolOutputCaptureFailure::AllocationFailed));
        };
        self.reserve_for(stream, additional)?;
        let output = self.stream_mut(stream);
        for buffer in buffers {
            output.extend_from_slice(buffer);
        }
        Ok(additional)
    }
}

type DestinationWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct CaptureFile {
    capture: SharedToolOutputCapture,
    stream: ToolOutputStream,
    destination: Option<DestinationWriter>,
}

impl fmt::Debug for CaptureFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CaptureFile")
            .field("stream", &self.stream)
            .finish_non_exhaustive()
    }
}

impl CaptureFile {
    fn new(capture: SharedToolOutputCapture, stream: ToolOutputStream) -> Self {
        Self {
            capture,
            stream,
            destination: None,
        }
    }

    fn destination(mut self, writer: Option<Box<dyn Write + Send>>) -> Self {
        self.destination = writer.map(|writer| Arc::new(Mutex::new(writer)));
        self
    }

    fn capture_lock(&self) -> std::io::Result<std::sync::MutexGuard<'_, ToolOutputCapture>> {
        self.capture
            .lock()
            .map_err(|_| ToolOutputCaptureFailure::LockPoisoned.io_error())
    }
}

impl VirtualFile for CaptureFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.capture
            .lock()
            .map(|capture| capture.stream_len(self.stream) as u64)
            .unwrap_or(0)
    }

    fn set_len(&mut self, _new_size: u64) -> Result<(), wasmer_wasix::FsError> {
        Err(wasmer_wasix::FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> Result<(), wasmer_wasix::FsError> {
        Ok(())
    }

    fn poll_read_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<usize>> {
        let ready = self
            .capture_lock()
            .and_then(|capture| match capture.failure {
                Some(failure) => Err(failure.io_error()),
                None => Ok(8192),
            });
        Poll::Ready(ready)
    }
}

impl AsyncRead for CaptureFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for CaptureFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Write::write(self.as_mut().get_mut(), buf))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buffers: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Write::write_vectored(self.as_mut().get_mut(), buffers))
    }

    fn is_write_vectored(&self) -> bool {
        true
    }
}

impl AsyncSeek for CaptureFile {
    fn start_seek(self: Pin<&mut Self>, _position: std::io::SeekFrom) -> std::io::Result<()> {
        Ok(())
    }

    fn poll_complete(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl Read for CaptureFile {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

impl Write for CaptureFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        {
            let mut capture = self.capture_lock()?;
            capture.write(self.stream, buf)?;
            if capture.write_failure.is_some() {
                return Ok(buf.len());
            }
        }
        if let Some(destination) = &self.destination {
            // Each stream owns its writer lock; a blocked stdout destination
            // never holds the shared diagnostic/error-state lock.
            let result = destination
                .lock()
                .map_err(|_| std::io::Error::other("tool destination writer lock poisoned"))
                .and_then(|mut writer| {
                    for chunk in buf.chunks(64 * 1024) {
                        writer.write_all(chunk)?;
                    }
                    Ok(())
                });
            if let Err(error) = result {
                self.capture_lock()?.write_failure.get_or_insert(error);
            }
        }
        Ok(buf.len())
    }

    fn write_vectored(&mut self, buffers: &[std::io::IoSlice<'_>]) -> std::io::Result<usize> {
        let bounded = self.capture_lock()?.bounded_diagnostics;
        if bounded {
            let mut written = 0_usize;
            for buffer in buffers {
                written = written
                    .checked_add(self.write(buffer)?)
                    .ok_or_else(|| std::io::Error::other("tool vectored byte count overflow"))?;
            }
            Ok(written)
        } else {
            self.capture_lock()?.write_vectored(self.stream, buffers)
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Seek for CaptureFile {
    fn seek(&mut self, _pos: std::io::SeekFrom) -> std::io::Result<u64> {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture_files() -> (SharedToolOutputCapture, CaptureFile, CaptureFile) {
        let capture = Arc::new(Mutex::new(ToolOutputCapture::default()));
        let stdout = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stdout);
        let stderr = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stderr);
        (capture, stdout, stderr)
    }

    #[test]
    fn destination_failure_drains_and_preserves_completed_exit_and_diagnostic_tail() {
        let capture = Arc::new(Mutex::new(ToolOutputCapture {
            bounded_diagnostics: true,
            ..ToolOutputCapture::default()
        }));
        let mut stdout = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stdout)
            .destination(Some(Box::new(Cursor::new([]))));
        let mut stderr = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stderr);
        stdout.write_all(&vec![b'x'; 130_000]).unwrap();
        stdout.write_all(b"later").unwrap();
        stderr.write_all(&vec![b'w'; 16_000]).unwrap();
        assert!(capture.lock().unwrap().stdout.is_empty());
        let error = finish_wasix_client_tool_run("psql", Ok(()), capture).unwrap_err();
        let error = error.downcast_ref::<PostgresToolError>().unwrap();
        assert_eq!(error.exit_code(), Some(0));
        assert!(error.stdout_bytes().is_empty());
        assert_eq!(error.stderr_bytes().len(), 8192);
        assert!(error.stderr_truncated());
        assert_eq!(
            error.cause.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::WriteZero
        );
    }

    #[test]
    fn blocked_stdout_does_not_hold_the_stderr_capture_lock() {
        struct GatedWriter {
            entered: mpsc::Sender<()>,
            release: Option<Receiver<()>>,
        }
        impl Write for GatedWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(bytes.len() <= 64 * 1024);
                if let Some(release) = self.release.take() {
                    self.entered.send(()).unwrap();
                    release.recv().unwrap();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let capture = Arc::new(Mutex::new(ToolOutputCapture {
            bounded_diagnostics: true,
            ..ToolOutputCapture::default()
        }));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut stdout = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stdout)
            .destination(Some(Box::new(GatedWriter {
                entered: entered_tx,
                release: Some(release_rx),
            })));
        let mut stderr = CaptureFile::new(Arc::clone(&capture), ToolOutputStream::Stderr);
        let stdout_thread = thread::spawn(move || stdout.write_all(&vec![b'x'; 130_000]));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (drained_tx, drained_rx) = mpsc::channel();
        let stderr_thread = thread::spawn(move || {
            stderr.write_all(b"diagnostic").unwrap();
            drained_tx.send(()).unwrap();
        });
        let drained = drained_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();
        stdout_thread.join().unwrap().unwrap();
        stderr_thread.join().unwrap();
        drained.expect("stderr must drain while stdout is blocked");
        let output = finish_wasix_client_tool_run("pg_dump", Ok(()), capture).unwrap();
        assert!(output.stdout.is_empty());
        assert_eq!(output.stdout_bytes, 130_000);
        assert_eq!(output.stderr, b"diagnostic");
    }

    #[test]
    fn tool_output_capture_preserves_exact_bytes() {
        let (capture, mut stdout, mut stderr) = capture_files();
        Write::write_all(&mut stdout, b"dump\0").unwrap();
        Write::write_all(&mut stderr, b"warn\n").unwrap();

        let output = finish_wasix_client_tool_run("pg_dump", Ok(()), capture).unwrap();
        assert_eq!(output.stdout, b"dump\0");
        assert_eq!(output.stderr, b"warn\n");
    }

    #[test]
    fn tool_output_capture_accepts_more_than_64_mib() {
        let (capture, mut stdout, mut stderr) = capture_files();
        let chunk = vec![b'x'; 1024 * 1024];
        let buffers = [std::io::IoSlice::new(&chunk), std::io::IoSlice::new(b"!")];
        for _ in 0..65 {
            assert_eq!(
                Write::write_vectored(&mut stdout, &buffers).unwrap(),
                chunk.len() + 1
            );
        }
        Write::write_all(&mut stderr, b"diagnostic").unwrap();
        let output = finish_wasix_client_tool_run("pg_dump", Ok(()), capture).unwrap();
        assert_eq!(output.stdout.len(), 65 * (chunk.len() + 1));
        for block in output.stdout.chunks_exact(chunk.len() + 1) {
            assert_eq!(&block[..chunk.len()], chunk);
            assert_eq!(block[chunk.len()], b'!');
        }
        assert_eq!(output.stderr, b"diagnostic");
    }

    #[test]
    fn tool_output_failure_is_sticky_and_fail_closed() {
        let (capture, mut stdout, mut stderr) = capture_files();
        Write::write_all(&mut stdout, b"12345").unwrap();
        Write::write_all(&mut stderr, b"67890").unwrap();

        let failure = capture
            .lock()
            .unwrap()
            .reserve_for(ToolOutputStream::Stdout, usize::MAX)
            .unwrap_err();
        assert!(failure.to_string().contains("could not reserve memory"));
        assert_eq!(capture.lock().unwrap().stdout.capacity(), 0);
        assert_eq!(capture.lock().unwrap().stderr.capacity(), 0);
        let sticky = Write::write(&mut stderr, b"still rejected").unwrap_err();
        assert!(sticky.to_string().contains("could not reserve memory"));

        let error = finish_wasix_client_tool_run("pg_dump", Ok(()), capture)
            .expect_err("a sticky capture failure must override guest exit 0");
        let structured = error
            .downcast_ref::<PostgresToolError>()
            .expect("capture failure must remain a structured tool failure");
        assert_eq!(structured.exit_code(), Some(0));
        assert_eq!(structured.stdout(), "");
        assert_eq!(structured.stderr(), "");
        assert!(
            structured
                .to_string()
                .contains("output capture failed: could not reserve memory")
        );

        let direct_error = finish_direct_tool::<()>(true, Ok(()), Err(error))
            .expect_err("capture failure must remain an ordinary completed tool failure");
        assert!(!is_direct_tool_outcome_unknown(&direct_error));
    }

    #[test]
    fn tool_output_capture_rejects_set_len_without_changing_output() {
        let (capture, mut stdout, _stderr) = capture_files();
        Write::write_all(&mut stdout, b"data").unwrap();
        assert!(matches!(
            VirtualFile::set_len(&mut stdout, u64::MAX),
            Err(wasmer_wasix::FsError::PermissionDenied)
        ));
        assert_eq!(VirtualFile::size(&stdout), 4);

        let output = finish_wasix_client_tool_run("pg_dump", Ok(()), capture).unwrap();
        assert_eq!(output.stdout, b"data");
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn poisoned_tool_output_lock_returns_errors_instead_of_panicking() {
        let (capture, mut stdout, _stderr) = capture_files();
        let poisoned = Arc::clone(&capture);
        assert!(
            thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("intentionally poison tool output capture");
            })
            .join()
            .is_err()
        );

        assert_eq!(VirtualFile::size(&stdout), 0);
        assert!(
            Write::write(&mut stdout, b"data")
                .unwrap_err()
                .to_string()
                .contains("lock was poisoned")
        );
        let error = finish_wasix_client_tool_run("psql", Ok(()), capture)
            .expect_err("a poisoned capture lock must fail the invocation");
        let structured = error.downcast_ref::<PostgresToolError>().unwrap();
        assert_eq!(structured.exit_code(), Some(0));
        assert_eq!(structured.stdout(), "");
        assert_eq!(structured.stderr(), "");
        assert!(structured.to_string().contains("capture lock was poisoned"));
    }

    #[test]
    fn shared_option_fixture_matches_wasix_validation() {
        let fixture: serde_json::Value = serde_json::from_str(
            &crate::oliphaunt::test_fixtures::text("postgres/logical-tools.json"),
        )
        .expect("logical tools fixture must be valid JSON");
        for argument in fixture["pgDump"]["acceptedArgs"].as_array().unwrap() {
            PgDumpOptions::new()
                .arg(argument.as_str().unwrap())
                .validate()
                .expect("shared pg_dump argument must be accepted");
        }
        for arguments in fixture["pgDump"]["acceptedArgv"].as_array().unwrap() {
            PgDumpOptions::new()
                .args(fixture_argv(arguments))
                .validate()
                .expect("shared pg_dump argv must be accepted");
        }
        for argument in fixture["pgDump"]["rejectedArgs"].as_array().unwrap() {
            PgDumpOptions::new()
                .arg(argument.as_str().unwrap())
                .validate()
                .expect_err("shared pg_dump argument must be rejected");
        }
        for arguments in fixture["pgDump"]["rejectedArgv"].as_array().unwrap() {
            PgDumpOptions::new()
                .args(fixture_argv(arguments))
                .validate()
                .expect_err("shared pg_dump argv must be rejected");
        }
        for argument in fixture["psql"]["acceptedArgs"].as_array().unwrap() {
            PsqlOptions::new()
                .command("SELECT 1")
                .arg(argument.as_str().unwrap())
                .validate()
                .expect("shared psql argument must be accepted");
        }
        for arguments in fixture["psql"]["acceptedArgv"].as_array().unwrap() {
            PsqlOptions::new()
                .command("SELECT 1")
                .args(fixture_argv(arguments))
                .validate()
                .expect("shared psql argv must be accepted");
        }
        for argument in fixture["psql"]["rejectedArgs"].as_array().unwrap() {
            PsqlOptions::new()
                .command("SELECT 1")
                .arg(argument.as_str().unwrap())
                .validate()
                .expect_err("shared psql argument must be rejected");
        }
        for arguments in fixture["psql"]["rejectedArgv"].as_array().unwrap() {
            PsqlOptions::new()
                .command("SELECT 1")
                .args(fixture_argv(arguments))
                .validate()
                .expect_err("shared psql argv must be rejected");
        }
    }

    fn fixture_argv(arguments: &serde_json::Value) -> Vec<&str> {
        arguments
            .as_array()
            .expect("shared logical-tools argv must be arrays")
            .iter()
            .map(|argument| {
                argument
                    .as_str()
                    .expect("shared logical-tools argv must contain strings")
            })
            .collect()
    }

    #[test]
    fn psql_is_non_interactive_and_inputs_reject_nul() {
        let script = PsqlOptions::new()
            .script("\\restrict token\nSELECT 1;\n\\unrestrict token\n")
            .arg("--echo-errors");
        script.validate().unwrap();
        let script_args = psql_args(DIRECT_TOOL_ADDR, "user", "database", &script);
        assert!(script_args.iter().any(|arg| arg == "--file=-"));
        assert!(script_args.iter().any(|arg| arg == "--echo-errors"));

        let command = PsqlOptions::new().command("SELECT 1");
        let command_args = psql_args(DIRECT_TOOL_ADDR, "user", "database", &command);
        assert!(!command_args.iter().any(|arg| arg == "--file=-"));
        assert!(
            command_args
                .windows(2)
                .any(|args| args == ["--command", "SELECT 1"])
        );

        let error = PsqlOptions::new()
            .validate()
            .expect_err("psql without input or args must be rejected");
        assert!(error.to_string().contains("requires non-interactive input"));
        let error = PsqlOptions::new()
            .script("SELECT '\0'")
            .validate()
            .expect_err("NUL-bearing psql input must be rejected");
        assert!(error.to_string().contains("must not contain NUL bytes"));
    }

    #[test]
    fn submitted_tool_startup_deadline_is_not_renewed_before_execution() {
        let options = PgDumpOptions::new()
            .startup_timeout(Duration::from_millis(10))
            .start_startup_budget();
        let deadline = options.startup_deadline;
        assert!(deadline.is_some());
        assert_eq!(
            options.clone().start_startup_budget().startup_deadline,
            deadline
        );
        let error = run_direct_tool(
            Duration::from_secs(30),
            Some(Instant::now()),
            |_| -> Result<()> { panic!("expired queued work must not launch its guest") },
            |_| panic!("expired queued work must not enter the database"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("startup deadline exceeded"));
        assert!(!is_direct_tool_outcome_unknown(&error));
    }

    #[test]
    fn failure_before_direct_tool_connection_has_known_outcome() {
        let error = run_direct_tool(
            startup::DEFAULT_TIMEOUT,
            None,
            |_| Err::<String, _>(anyhow!("tool failed before opening its virtual connection")),
            |_| panic!("a pre-connection failure must not enter the database protocol server"),
        )
        .expect_err("the tool runner must report its pre-connection failure");

        // This is the exact predicate used by the database client to decide
        // whether a failed tool run poisons the handle.
        assert!(!is_direct_tool_outcome_unknown(&error));
        assert!(format!("{error:#}").contains("tool failed before opening its virtual connection"));
    }

    #[test]
    fn selected_startup_budget_expires_before_connect_but_not_during_serving() {
        let error = run_direct_tool(
            Duration::from_millis(20),
            None,
            |network| {
                while network.startup.check().is_ok() {
                    thread::sleep(Duration::from_millis(1));
                }
                Err::<(), _>(anyhow!("guest observed startup expiry"))
            },
            |_| panic!("expired startup must not enter the database"),
        )
        .unwrap_err();
        assert!(!is_direct_tool_outcome_unknown(&error));
        assert!(format!("{error:#}").contains("deadline exceeded"));

        let output = run_direct_tool(
            Duration::from_millis(100),
            None,
            |network| {
                let _socket = crate::oliphaunt::host_runtime::runtime()?
                    .block_on(network.connect_tcp(DIRECT_TOOL_LOCAL_ADDR, DIRECT_TOOL_ADDR))?;
                thread::sleep(Duration::from_millis(150));
                network.startup.check()?;
                Ok("finished")
            },
            |_| {
                thread::sleep(Duration::from_millis(150));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(output, "finished");
    }

    #[test]
    fn successful_direct_tool_without_connection_returns_output() {
        let output = run_direct_tool(
            startup::DEFAULT_TIMEOUT,
            None,
            |_| Ok("pg_dump (PostgreSQL) 18.4\n".to_owned()),
            |_| panic!("a successful pre-connection tool must not enter the protocol server"),
        )
        .expect("version-style tool invocations must succeed without opening a connection");

        assert_eq!(output, "pg_dump (PostgreSQL) 18.4\n");
    }

    #[test]
    fn tool_failures_retain_exact_non_utf8_output_bytes() {
        let error = decode_tool_output(
            "pg_dump",
            PostgresToolOutput {
                stdout: vec![0xff, 0, b'a'],
                stderr: vec![0x80, 0xfe],
                stdout_bytes: 3,
                stderr_truncated: false,
            },
        )
        .expect_err("invalid UTF-8 must remain a structured tool failure");
        let error = error
            .downcast_ref::<PostgresToolError>()
            .expect("invalid UTF-8 must expose exact tool diagnostics");

        assert_eq!(error.exit_code(), Some(0));
        assert_eq!(error.stdout_bytes(), &[0xff, 0, b'a']);
        assert_eq!(error.stderr_bytes(), &[0x80, 0xfe]);
        assert!(error.stdout().contains('\u{fffd}'));
        assert!(error.stderr().contains('\u{fffd}'));
    }

    #[test]
    fn runner_panic_is_unknown_only_after_direct_tool_connection() {
        let before_connection = run_direct_tool(
            startup::DEFAULT_TIMEOUT,
            None,
            |_| -> Result<String> {
                panic!("tool runner panicked before opening its virtual connection")
            },
            |_| panic!("a pre-connection panic must not enter the database protocol server"),
        )
        .expect_err("the tool runner panic must become an ordinary error");
        assert!(!is_direct_tool_outcome_unknown(&before_connection));
        assert!(
            before_connection
                .to_string()
                .contains("runner thread panicked")
        );

        let after_connection = finish_direct_tool::<String>(
            true,
            Ok(()),
            Err(anyhow!("direct WASIX tool runner thread panicked")),
        )
        .expect_err("a connected tool runner panic must have an unknown outcome");
        assert!(is_direct_tool_outcome_unknown(&after_connection));

        let broken_connection = finish_direct_tool(
            true,
            Err(anyhow!("virtual protocol connection failed")),
            Ok(String::new()),
        )
        .expect_err("a broken accepted connection must have an unknown outcome");
        assert!(is_direct_tool_outcome_unknown(&broken_connection));

        let ordinary_tool_failure =
            finish_direct_tool::<String>(true, Ok(()), Err(postgres_tool_failure(Some(1))))
                .expect_err("a normal tool failure remains an error");
        assert!(!is_direct_tool_outcome_unknown(&ordinary_tool_failure));

        let runtime_failure =
            finish_direct_tool::<String>(true, Ok(()), Err(postgres_tool_failure(None)))
                .expect_err("an internal WASIX tool failure has an unknown outcome after connect");
        assert!(is_direct_tool_outcome_unknown(&runtime_failure));
    }

    fn postgres_tool_failure(exit_code: Option<i32>) -> anyhow::Error {
        anyhow::Error::new(PostgresToolError::from_output(
            "psql",
            exit_code,
            Vec::new(),
            b"tool failed".to_vec(),
            anyhow!("WASIX tool process failed"),
        ))
    }

    #[cfg(feature = "extension-pgtap")]
    #[test]
    fn public_tools_round_trip_shared_logical_fixture() -> crate::Result<()> {
        let seed = crate::oliphaunt::test_fixtures::text("postgres/logical-tools-seed.sql");
        let verify = crate::oliphaunt::test_fixtures::text("postgres/logical-tools-verify.sql");
        let expected: serde_json::Value = serde_json::from_str(
            &crate::oliphaunt::test_fixtures::text("postgres/logical-tools.json"),
        )
        .expect("logical tool contract must be valid JSON");

        let mut source = crate::oliphaunt::client::Oliphaunt::builder()
            .extension(crate::Extension::PGTAP)
            .open()?;
        source.psql(PsqlOptions::new().script(seed))?;
        let schema = source.pg_dump(PgDumpOptions::new().arg("--schema-only"))?;
        assert!(schema.contains("CREATE TABLE public.logical_items"));
        assert!(!schema.contains("COPY public.logical_items"));
        let dump = source.pg_dump(PgDumpOptions::new())?;
        assert!(dump.contains("COPY public.logical_items"));
        source.close()?;

        let mut restored = crate::oliphaunt::client::Oliphaunt::builder()
            .extension(crate::Extension::PGTAP)
            .open()?;
        restored.psql(PsqlOptions::new().script(dump))?;
        let result = restored.query(&verify)?;
        let values = &expected["expected"];
        let rows = values["rows"].as_i64().unwrap().to_string();
        let sum = values["sum"].as_i64().unwrap().to_string();
        let sequence_last_value = values["sequenceLastValue"].as_i64().unwrap().to_string();
        let normalized_matches = values["normalizedMatches"].as_i64().unwrap().to_string();
        assert_eq!(result.get_text(0, "rows")?, Some(rows.as_str()));
        assert_eq!(result.get_text(0, "sum")?, Some(sum.as_str()));
        assert_eq!(
            result.get_text(0, "sequence_last_value")?,
            Some(sequence_last_value.as_str())
        );
        assert_eq!(
            result.get_text(0, "quoted_value")?,
            values["quotedValue"].as_str()
        );
        assert_eq!(
            result.get_text(0, "normalized_matches")?,
            Some(normalized_matches.as_str())
        );
        assert_eq!(result.get_text(0, "extension_loaded")?, Some("t"));
        restored.close()?;
        Ok(())
    }

    #[cfg(feature = "tools")]
    #[test]
    #[ignore = "requires prepared runtime and tools assets"]
    fn public_tool_destinations_large_dump_restore_and_failure_recovery() -> crate::Result<()> {
        let root = tempfile::tempdir().unwrap();
        let storage = crate::DatabaseStorage::Directory(root.path().join("source"));
        let mut source = crate::Oliphaunt::builder()
            .storage(storage.clone())
            .open()?;
        source.execute("CREATE ROLE logical_owner SUPERUSER LOGIN")?;
        source.close()?;
        let mut source = crate::Oliphaunt::builder()
            .storage(storage.clone())
            .username("logical_owner")
            .open()?;
        source.execute("CREATE TABLE dump_payload AS SELECT g AS id, repeat('λ', 4096) AS value FROM generate_series(1, 8193) AS g")?;
        source.execute("CREATE TABLE effects(value integer)")?;
        let options = || PgDumpOptions::new().arg("--restrict-key=oliphauntOutputTest");
        let destination = root.path().join("dump.sql");
        let summary = source.pg_dump_to_file(options(), &destination, None)?;
        assert!(summary.stdout_bytes > 64 * 1024 * 1024);
        let dump = std::fs::read_to_string(&destination).unwrap();
        assert_eq!(source.pg_dump(options())?, dump);
        assert_eq!(dump.len(), summary.stdout_bytes);
        let error = source
            .pg_dump_to_file(options(), &destination, None)
            .unwrap_err();
        assert_eq!(error.tool_error().unwrap().exit_code(), Some(0));
        assert_eq!(
            std::fs::metadata(&destination).unwrap().len(),
            dump.len() as u64
        );
        let error = source
            .psql_to_writer(
                PsqlOptions::new()
                    .command("INSERT INTO effects VALUES (1); SELECT repeat('x', 100000)"),
                Cursor::new([]),
                None,
            )
            .unwrap_err();
        assert_eq!(error.tool_error().unwrap().exit_code(), Some(0));
        assert_eq!(
            source
                .query("SELECT count(*)::text AS count FROM effects")?
                .get_text(0, "count")?,
            Some("1")
        );
        let failed = root.path().join("failed.sql");
        assert!(
            source
                .psql_to_file(
                    PsqlOptions::new().script("SELECT 1; SELECT 1 / 0"),
                    &failed,
                    None
                )
                .is_err()
        );
        assert!(!failed.exists());
        assert!(std::fs::read_dir(root.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".oliphaunt-tool-")
        }));
        let large_value = root.path().join("large-value.txt");
        let summary = source.psql_to_file(
            PsqlOptions::new()
                .args(["--tuples-only", "--no-align"])
                .command(format!("SELECT repeat('X', {})", 65 * 1024 * 1024)),
            &large_value,
            None,
        )?;
        assert_eq!(summary.stdout_bytes, 65 * 1024 * 1024 + 1);
        assert_eq!(
            std::fs::metadata(&large_value).unwrap().len(),
            summary.stdout_bytes as u64
        );
        let updated_dump_bytes = source.pg_dump(options())?.len();
        source.close()?;

        struct Counter(Arc<std::sync::atomic::AtomicUsize>);
        impl Write for Counter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(bytes.len() <= 64 * 1024);
                self.0
                    .fetch_add(bytes.len(), std::sync::atomic::Ordering::Relaxed);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        struct FlushFailure;
        impl Write for FlushFailure {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("flush failed"))
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let database = crate::AsyncOliphaunt::builder().storage(storage).username("logical_owner").open().await?;
            let bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let summary = database.pg_dump_to_writer(options(), Counter(Arc::clone(&bytes)), None).await?;
            assert_eq!(summary.stdout_bytes, updated_dump_bytes);
            assert_eq!(bytes.load(std::sync::atomic::Ordering::Relaxed), updated_dump_bytes);
            let diagnostics = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let summary = database.psql_to_writer(PsqlOptions::new().command("DO $$ BEGIN FOR i IN 1..100 LOOP RAISE WARNING '%', repeat('w', 1024); END LOOP; END $$"), Counter(bytes), Some(Box::new(Counter(Arc::clone(&diagnostics))))).await?;
            assert!(summary.stderr_truncated);
            assert_eq!(summary.stderr.len(), 8192);
            assert!(diagnostics.load(std::sync::atomic::Ordering::Relaxed) > 100 * 1024);
            let error = database.psql_to_writer(PsqlOptions::new().command("SELECT 1"), FlushFailure, None).await.unwrap_err();
            assert_eq!(error.tool_error().unwrap().exit_code(), Some(0));
            assert_eq!(database.query("SELECT 43::text AS value").await?.get_text(0, "value")?, Some("43"));
            database.close().await
        })?;
        let mut restored = crate::Oliphaunt::builder().open()?;
        restored.execute("CREATE ROLE logical_owner SUPERUSER LOGIN")?;
        restored.psql(PsqlOptions::new().script(dump))?;
        assert_eq!(restored.query("SELECT count(*)::text AS count FROM dump_payload WHERE octet_length(value) = 8192")?.get_text(0, "count")?, Some("8193"));
        restored.close()?;
        Ok(())
    }
}
