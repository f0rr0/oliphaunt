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
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
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

/// Options for the bundled WASIX `pg_dump` runner.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PgDumpOptions {
    args: Vec<String>,
}

/// Structured failure from a packaged PostgreSQL frontend program.
#[derive(Debug)]
pub struct PostgresToolError {
    tool: &'static str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    cause: anyhow::Error,
}

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
            cause,
        }
    }

    pub fn tool(&self) -> &'static str {
        self.tool
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub fn stdout(&self) -> &str {
        &self.stdout
    }

    pub fn stderr(&self) -> &str {
        &self.stderr
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
        validate_tool_args(
            "pg_dump",
            &self.args,
            disallowed_pg_dump_flag,
            PG_DUMP_SHORT_OPTIONS,
            PG_DUMP_VALUE_OPTIONS,
        )
    }
}

/// Options for the bundled WASIX `psql` runner.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PsqlOptions {
    args: Vec<String>,
    input: Option<PsqlInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PsqlInput {
    Command(String),
    Script(String),
}

impl PsqlOptions {
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

struct ToolInvocation<'a, N> {
    name: &'static str,
    wasm: &'static [u8],
    load_module: fn(&wasmer::Engine) -> Result<wasmer::Module>,
    username: &'a str,
    networking: N,
    stdin: Option<Vec<u8>>,
    args: Vec<String>,
}

fn run_wasix_client_tool<N>(invocation: ToolInvocation<'_, N>) -> Result<PostgresToolOutput>
where
    N: VirtualNetworking + Sync,
{
    let ToolInvocation {
        name,
        wasm,
        load_module,
        username,
        networking,
        stdin,
        args,
    } = invocation;
    let engine = aot::headless_engine();
    let module = load_module(&engine)
        .with_context(|| format!("load {name} AOT artifact from oliphaunt-wasix-tools-aot-*"))?;

    let fs_root = TempDir::new().with_context(|| format!("create {name} WASIX filesystem root"))?;
    if let Some(runtime_archive) = assets::runtime_archive() {
        unpack_runtime_archive_reader(
            Cursor::new(runtime_archive),
            Path::new("oliphaunt.wasix.tar.zst"),
            fs_root.path(),
        )
        .with_context(|| format!("install WASIX runtime files for {name}"))?;
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .with_context(|| format!("create Tokio runtime for WASIX {name}"))?;
    let (host_fs, wasix_runtime) = {
        let _runtime_guard = runtime.enter();
        let host_fs = SyncHostFileSystem::new(fs_root.path()).with_context(|| {
            format!(
                "create host filesystem rooted at {}",
                fs_root.path().display()
            )
        })?;
        let host_fs = Arc::new(host_fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
        let mut wasix_runtime = PluggableRuntime::new(Arc::new(TokioTaskManager::new(
            tokio::runtime::Handle::current(),
        )));
        wasix_runtime.set_engine(engine.clone());
        wasix_runtime.set_networking_implementation(networking);
        (host_fs, wasix_runtime)
    };

    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
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
        .with_stdout(Box::new(CaptureFile::new(Arc::clone(&stdout))))
        .with_stderr(Box::new(CaptureFile::new(Arc::clone(&stderr))));
    if name == "psql" {
        runner.with_envs([("OLIPHAUNT_PSQL_NONINTERACTIVE", "1")]);
    }
    match stdin {
        Some(input) => runner.with_stdin(Box::new(virtual_fs::StaticFile::new(input))),
        None => runner.with_stdin(Box::<virtual_fs::null_file::NullFile>::default()),
    };
    if let Err(cause) = runner.run_wasm(
        RuntimeOrEngine::Runtime(Arc::new(wasix_runtime)),
        name,
        module,
        ModuleHash::sha256(wasm),
    ) {
        let exit_code = cause
            .chain()
            .find_map(|error| error.downcast_ref::<WasiRuntimeError>())
            .and_then(WasiRuntimeError::as_exit_code)
            .map(|code| code.raw());
        let stdout = stdout.lock().expect("stdout capture poisoned").clone();
        let stderr = stderr.lock().expect("stderr capture poisoned").clone();
        return Err(anyhow::Error::new(PostgresToolError::from_output(
            name, exit_code, stdout, stderr, cause,
        )));
    }

    let stdout = std::mem::take(&mut *stdout.lock().expect("stdout capture poisoned"));
    let stderr = std::mem::take(&mut *stderr.lock().expect("stderr capture poisoned"));
    Ok(PostgresToolOutput { stdout, stderr })
}

fn pg_dump_with_networking<N>(
    addr: SocketAddr,
    username: &str,
    database: &str,
    options: &PgDumpOptions,
    networking: N,
) -> Result<PostgresToolOutput>
where
    N: VirtualNetworking + Sync,
{
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
    run_wasix_client_tool(ToolInvocation {
        name: "pg_dump",
        wasm: pg_dump_wasm_asset()?,
        load_module: aot::load_pg_dump_module,
        username,
        networking,
        stdin: None,
        args,
    })
}

fn run_psql_with_networking<N>(
    addr: SocketAddr,
    username: &str,
    database: &str,
    options: &PsqlOptions,
    networking: N,
) -> Result<PostgresToolOutput>
where
    N: VirtualNetworking + Sync,
{
    options.validate()?;
    let stdin = match &options.input {
        Some(PsqlInput::Script(script)) => Some(script.as_bytes().to_vec()),
        _ => None,
    };
    let args = psql_args(addr, username, database, options);
    run_wasix_client_tool(ToolInvocation {
        name: "psql",
        wasm: psql_wasm_asset()?,
        load_module: aot::load_psql_module,
        username,
        networking,
        stdin,
        args,
    })
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
    let PostgresToolOutput { stdout, stderr } = output;
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
    serve: F,
) -> Result<PostgresToolOutput>
where
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let username = username.to_owned();
    let database = database.to_owned();
    let options = options.clone();
    run_direct_tool(
        move |networking| {
            pg_dump_with_networking(DIRECT_TOOL_ADDR, &username, &database, &options, networking)
        },
        serve,
    )
}

pub(crate) fn run_direct_psql_output<F>(
    username: &str,
    database: &str,
    options: &PsqlOptions,
    serve: F,
) -> Result<PostgresToolOutput>
where
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let username = username.to_owned();
    let database = database.to_owned();
    let options = options.clone();
    run_direct_tool(
        move |networking| {
            run_psql_with_networking(DIRECT_TOOL_ADDR, &username, &database, &options, networking)
        },
        serve,
    )
}

fn run_direct_tool<T, R, F>(run: R, serve: F) -> Result<T>
where
    T: Send + 'static,
    R: FnOnce(DirectToolNetworking) -> Result<T> + Send + 'static,
    F: FnOnce(DirectToolSocket) -> Result<()>,
{
    let (socket_tx, socket_rx) = mpsc::sync_channel(1);
    let runner = thread::spawn(move || run(DirectToolNetworking::new(socket_tx)));
    let accepted = receive_direct_tool_socket(&socket_rx, &runner)
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
}

impl DirectToolNetworking {
    fn new(socket_tx: SyncSender<DirectToolSocket>) -> Self {
        Self {
            socket_tx: Mutex::new(Some(socket_tx)),
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
) -> Result<DirectToolSocket> {
    let started = Instant::now();
    loop {
        match socket_rx.recv_timeout(Duration::from_millis(5)) {
            Ok(socket) => return Ok(socket),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if runner.is_finished() {
                    bail!("WASIX tool exited before opening its virtual protocol connection");
                }
                if started.elapsed() > Duration::from_secs(30) {
                    bail!("timed out waiting for WASIX tool virtual protocol connection");
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("WASIX tool virtual networking channel closed before connect")
            }
        }
    }
}

#[derive(Debug)]
struct CaptureFile {
    buffer: Arc<Mutex<Vec<u8>>>,
}

impl CaptureFile {
    fn new(buffer: Arc<Mutex<Vec<u8>>>) -> Self {
        Self { buffer }
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
        self.buffer.lock().expect("capture lock poisoned").len() as u64
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
        Poll::Ready(Ok(8192))
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
        Poll::Ready(self.write(buf))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
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
        self.buffer
            .lock()
            .expect("capture lock poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
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

    #[test]
    fn shared_option_fixture_matches_wasix_validation() {
        let fixture: serde_json::Value =
            serde_json::from_str(&crate::oliphaunt::test_fixtures::text(
                "postgres/logical-tools.json",
                "postgres-logical-tools.json",
            ))
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
    fn failure_before_direct_tool_connection_has_known_outcome() {
        let error = run_direct_tool(
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
    fn successful_direct_tool_without_connection_returns_output() {
        let output = run_direct_tool(
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
        let seed = crate::oliphaunt::test_fixtures::text(
            "postgres/logical-tools-seed.sql",
            "postgres-logical-tools-seed.sql",
        );
        let verify = crate::oliphaunt::test_fixtures::text(
            "postgres/logical-tools-verify.sql",
            "postgres-logical-tools-verify.sql",
        );
        let expected: serde_json::Value =
            serde_json::from_str(&crate::oliphaunt::test_fixtures::text(
                "postgres/logical-tools.json",
                "postgres-logical-tools.json",
            ))
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
}
