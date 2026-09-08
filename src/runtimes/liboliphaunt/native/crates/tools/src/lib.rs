#![deny(unsafe_code)]

mod arguments;

use std::error::Error as StdError;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use arguments::{validate_pg_dump_arguments, validate_psql_arguments};

/// Product id for the native PostgreSQL client tools artifact family.
pub const PRODUCT: &str = "oliphaunt-tools";

/// Artifact kind relayed by this facade crate.
pub const KIND: &str = "native-tools";

// Keep this in sync with src/shared/postgres-tool-output-contract/contract.json.
const CAPTURED_OUTPUT_LIMIT_BYTES: usize = 67_108_864;

/// Options for the in-memory, plain-text `pg_dump` convenience API.
///
/// Standard output and standard error share an inclusive 64 MiB aggregate
/// capture limit per process. Exceeding it fails without returning partial
/// output. A streaming or sink API is not currently available.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PgDumpOptions {
    args: Vec<String>,
}

impl PgDumpOptions {
    /// Create default plain-text dump options.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one PostgreSQL `pg_dump` argument.
    pub fn arg(mut self, argument: impl Into<String>) -> Self {
        self.args.push(argument.into());
        self
    }

    /// Add PostgreSQL `pg_dump` arguments.
    pub fn args(mut self, arguments: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }
}

/// Options for an in-memory, non-interactive `psql` invocation.
///
/// Standard output and standard error share an inclusive 64 MiB aggregate
/// capture limit per process. Exceeding it fails without returning partial
/// output. A streaming or sink API is not currently available.
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
    /// Create default non-interactive psql options.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one PostgreSQL `psql` argument.
    pub fn arg(mut self, argument: impl Into<String>) -> Self {
        self.args.push(argument.into());
        self
    }

    /// Add PostgreSQL `psql` arguments.
    pub fn args(mut self, arguments: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    /// Run one command through `psql -c`.
    pub fn command(mut self, sql: impl Into<String>) -> Self {
        self.input = Some(PsqlInput::Command(sql.into()));
        self
    }

    /// Run a complete SQL script through psql standard input.
    pub fn script(mut self, sql: impl Into<String>) -> Self {
        self.input = Some(PsqlInput::Script(sql.into()));
        self
    }
}

/// Failure returned by a PostgreSQL frontend program.
#[derive(Debug)]
pub struct PostgresToolError {
    /// Program name (`pg_dump` or `psql`).
    pub tool: &'static str,
    /// Process exit status when the program started.
    pub exit_code: Option<i32>,
    /// UTF-8 standard output captured before failure.
    ///
    /// This is empty after output-capture overflow so no partial prefix is
    /// exposed.
    pub stdout: String,
    /// UTF-8 standard error captured before failure.
    ///
    /// This is empty after output-capture overflow so no partial prefix is
    /// exposed.
    pub stderr: String,
    source: Option<std::io::Error>,
    output_capture_failure: Option<OutputCaptureFailure>,
}

impl fmt::Display for PostgresToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(failure) = self.output_capture_failure {
            return match failure {
                OutputCaptureFailure::LimitExceeded => {
                    write!(formatter, "{} {failure}", self.tool)
                }
                _ => write!(formatter, "{} output capture failed: {failure}", self.tool),
            };
        }
        if let Some(source) = &self.source {
            return write!(formatter, "could not run {}: {source}", self.tool);
        }
        write!(
            formatter,
            "{} exited with status {}{}",
            self.tool,
            self.exit_code
                .map_or_else(|| "unknown".to_owned(), |status| status.to_string()),
            if self.stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", self.stderr.trim())
            }
        )
    }
}

impl StdError for PostgresToolError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn StdError + 'static))
    }
}

/// Run packaged `pg_dump` against a PostgreSQL connection string.
///
/// Returns unchanged PostgreSQL UTF-8 output through the inclusive 64 MiB
/// combined stdout/stderr capture limit. Exceeding the limit returns
/// [`PostgresToolError`] without partial output. Streaming larger dumps is not
/// currently supported.
pub fn pg_dump(
    connection_string: &str,
    options: PgDumpOptions,
) -> Result<String, PostgresToolError> {
    validate_connection_string("pg_dump", connection_string)?;
    validate_pg_dump_arguments(&options.args)
        .map_err(|message| configuration_error("pg_dump", &message))?;
    let mut arguments = options
        .args
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.push(OsString::from("--encoding=UTF8"));
    arguments.push(OsString::from("--no-password"));
    arguments.push(OsString::from(format!("--dbname={connection_string}")));
    run_tool("pg_dump", arguments, None)
}

/// Run packaged non-interactive `psql` against a PostgreSQL connection string.
///
/// Returns unchanged PostgreSQL UTF-8 output through the inclusive 64 MiB
/// combined stdout/stderr capture limit. Exceeding the limit returns
/// [`PostgresToolError`] without partial output. Streaming larger results is
/// not currently supported.
pub fn psql(connection_string: &str, options: PsqlOptions) -> Result<String, PostgresToolError> {
    validate_connection_string("psql", connection_string)?;
    validate_psql_arguments(&options.args)
        .map_err(|message| configuration_error("psql", &message))?;
    if options.input.is_none() && options.args.is_empty() {
        return Err(configuration_error(
            "psql",
            "psql requires command(), script(), or a non-input argument",
        ));
    }
    match options.input.as_ref() {
        Some(PsqlInput::Command(command)) => validate_text("psql", "command", command)?,
        Some(PsqlInput::Script(script)) => validate_text("psql", "script", script)?,
        None => {}
    }
    let (arguments, stdin) = psql_invocation(connection_string, options);
    run_tool("psql", arguments, stdin)
}

fn psql_invocation(
    connection_string: &str,
    options: PsqlOptions,
) -> (Vec<OsString>, Option<Vec<u8>>) {
    let mut arguments = options
        .args
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.extend([
        OsString::from("--no-psqlrc"),
        OsString::from("--no-password"),
        OsString::from("--set=ON_ERROR_STOP=1"),
        OsString::from(format!("--dbname={connection_string}")),
    ]);
    let stdin = match options.input {
        Some(PsqlInput::Command(command)) => {
            arguments.push(OsString::from("--command"));
            arguments.push(OsString::from(command));
            None
        }
        Some(PsqlInput::Script(script)) => {
            arguments.push(OsString::from("--file=-"));
            Some(script.into_bytes())
        }
        None => None,
    };
    (arguments, stdin)
}

fn run_tool(
    tool: &'static str,
    arguments: Vec<OsString>,
    stdin: Option<Vec<u8>>,
) -> Result<String, PostgresToolError> {
    let executable = resolve_tool(tool)?;
    let mut command = Command::new(&executable);
    command
        .args(arguments)
        .env("PGCLIENTENCODING", "UTF8")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_runtime_environment(&mut command, &executable);
    let mut child = command.spawn().map_err(|source| PostgresToolError {
        tool,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        source: Some(source),
        output_capture_failure: None,
    })?;
    let captured = Arc::new(Mutex::new(CapturedOutput::new(CAPTURED_OUTPUT_LIMIT_BYTES)));
    let stdout_reader = spawn_output_reader(
        child
            .stdout
            .take()
            .expect("stdout is piped for PostgreSQL tools"),
        Arc::clone(&captured),
        OutputChannel::Stdout,
    );
    let stderr_reader = spawn_output_reader(
        child
            .stderr
            .take()
            .expect("stderr is piped for PostgreSQL tools"),
        Arc::clone(&captured),
        OutputChannel::Stderr,
    );
    // Drain stdout/stderr while a potentially large psql script is written.
    // Writing all stdin first can deadlock when the child fills an output pipe.
    let input_writer = stdin.and_then(|input| {
        child
            .stdin
            .take()
            .map(|mut writer| thread::spawn(move || writer.write_all(&input)))
    });
    let status = child.wait();
    if status.is_err() {
        // A failed wait can leave the process and its pipe readers alive.
        // Terminate it before joining the readers so this error path cannot
        // strand background threads.
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout_failure = join_output_reader(stdout_reader, "stdout");
    let stderr_failure = join_output_reader(stderr_reader, "stderr");
    let input_failure = input_writer.and_then(|writer| match writer.join() {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some(std::io::Error::other("psql stdin writer panicked")),
    });
    let captured = take_captured_output(&captured);
    let exit_code = status
        .as_ref()
        .ok()
        .and_then(std::process::ExitStatus::code);
    if let Some(failure) = captured.failure {
        return Err(PostgresToolError {
            tool,
            exit_code,
            stdout: String::new(),
            stderr: String::new(),
            source: None,
            output_capture_failure: Some(failure),
        });
    }
    let status = match status {
        Ok(status) => status,
        Err(source) => return Err(io_failure(tool, exit_code, captured, source)),
    };
    if let Some(source) = stdout_failure.or(stderr_failure) {
        return Err(io_failure(tool, status.code(), captured, source));
    }
    let CapturedOutput { stdout, stderr, .. } = captured;
    if !status.success() {
        return Err(PostgresToolError {
            tool,
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            source: None,
            output_capture_failure: None,
        });
    }
    if let Some(source) = input_failure {
        return Err(PostgresToolError {
            tool,
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            source: Some(source),
            output_capture_failure: None,
        });
    }
    String::from_utf8(stdout).map_err(|error| PostgresToolError {
        tool,
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(error.as_bytes()).into_owned(),
        stderr: format!(
            "{}{} produced non-UTF-8 output: {error}",
            String::from_utf8_lossy(&stderr),
            tool
        ),
        source: None,
        output_capture_failure: None,
    })
}

#[derive(Debug, Clone, Copy)]
enum OutputChannel {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputCaptureFailure {
    LimitExceeded,
    AllocationFailed,
    LockPoisoned,
}

impl fmt::Display for OutputCaptureFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitExceeded => write!(
                formatter,
                "combined stdout and stderr exceeded the {CAPTURED_OUTPUT_LIMIT_BYTES}-byte capture limit; larger valid output requires a streaming or sink API, which is not currently available"
            ),
            Self::AllocationFailed => write!(
                formatter,
                "could not reserve memory for stdout and stderr within the {CAPTURED_OUTPUT_LIMIT_BYTES}-byte capture limit"
            ),
            Self::LockPoisoned => {
                formatter.write_str("stdout and stderr capture lock was poisoned")
            }
        }
    }
}

#[derive(Debug)]
struct CapturedOutput {
    limit: usize,
    retained_bytes: usize,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    failure: Option<OutputCaptureFailure>,
}

impl CapturedOutput {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            retained_bytes: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
            failure: None,
        }
    }

    fn retain(&mut self, channel: OutputChannel, bytes: &[u8]) {
        if self.failure.is_some() {
            return;
        }
        let Some(next_size) = self.retained_bytes.checked_add(bytes.len()) else {
            self.fail(OutputCaptureFailure::LimitExceeded);
            return;
        };
        if next_size > self.limit {
            self.fail(OutputCaptureFailure::LimitExceeded);
            return;
        }
        let destination = match channel {
            OutputChannel::Stdout => &mut self.stdout,
            OutputChannel::Stderr => &mut self.stderr,
        };
        if destination.try_reserve_exact(bytes.len()).is_err() {
            self.fail(OutputCaptureFailure::AllocationFailed);
            return;
        }
        destination.extend_from_slice(bytes);
        self.retained_bytes = next_size;
    }

    fn fail(&mut self, failure: OutputCaptureFailure) {
        self.failure.get_or_insert(failure);
        self.retained_bytes = 0;
        self.stdout = Vec::new();
        self.stderr = Vec::new();
    }
}

fn spawn_output_reader<R>(
    reader: R,
    captured: Arc<Mutex<CapturedOutput>>,
    channel: OutputChannel,
) -> JoinHandle<io::Result<usize>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || drain_output(reader, &captured, channel))
}

fn drain_output(
    mut reader: impl Read,
    captured: &Mutex<CapturedOutput>,
    channel: OutputChannel,
) -> io::Result<usize> {
    let mut buffer = [0_u8; 32 * 1024];
    let mut observed_bytes = 0_usize;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(observed_bytes);
        }
        observed_bytes = observed_bytes.saturating_add(count);
        match captured.lock() {
            Ok(mut captured) => captured.retain(channel, &buffer[..count]),
            Err(poisoned) => {
                let mut captured = poisoned.into_inner();
                captured.fail(OutputCaptureFailure::LockPoisoned);
            }
        }
    }
}

fn join_output_reader(reader: JoinHandle<io::Result<usize>>, channel: &str) -> Option<io::Error> {
    match reader.join() {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some(io::Error::other(format!(
            "PostgreSQL tool {channel} reader panicked"
        ))),
    }
}

fn take_captured_output(captured: &Mutex<CapturedOutput>) -> CapturedOutput {
    let mut captured = match captured.lock() {
        Ok(captured) => captured,
        Err(poisoned) => {
            let mut captured = poisoned.into_inner();
            captured.fail(OutputCaptureFailure::LockPoisoned);
            captured
        }
    };
    let limit = captured.limit;
    std::mem::replace(&mut *captured, CapturedOutput::new(limit))
}

fn io_failure(
    tool: &'static str,
    exit_code: Option<i32>,
    captured: CapturedOutput,
    source: io::Error,
) -> PostgresToolError {
    PostgresToolError {
        tool,
        exit_code,
        stdout: String::from_utf8_lossy(&captured.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&captured.stderr).into_owned(),
        source: Some(source),
        output_capture_failure: None,
    }
}

fn resolve_tool(tool: &'static str) -> Result<PathBuf, PostgresToolError> {
    let executable = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_owned()
    };
    let mut roots = Vec::new();
    if let Some(directory) = std::env::var_os("OLIPHAUNT_TOOLS_DIR") {
        roots.push(PathBuf::from(directory));
    }
    if let Some(directory) = option_env!("OLIPHAUNT_PACKAGED_TOOLS_DIR") {
        roots.push(PathBuf::from(directory));
    }
    if let Some(directory) = option_env!("OLIPHAUNT_RESOURCES_DIR") {
        roots.push(PathBuf::from(directory).join("native-tools/oliphaunt-tools/runtime"));
    }
    if let Ok(current) = std::env::current_exe()
        && let Some(directory) = current.parent()
    {
        roots.push(directory.join("oliphaunt-tools/runtime"));
        roots.push(directory.join("runtime"));
    }
    for root in roots {
        let candidate = root.join("bin").join(&executable);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(configuration_error(
        tool,
        &format!(
            "could not locate packaged {tool}; add the oliphaunt-tools artifact facade or set OLIPHAUNT_TOOLS_DIR"
        ),
    ))
}

fn configure_runtime_environment(command: &mut Command, executable: &Path) {
    let Some(runtime) = executable.parent().and_then(Path::parent) else {
        return;
    };
    let library = runtime.join("lib");
    prepend_environment_path(command, "PATH", executable.parent().unwrap_or(runtime));
    if cfg!(target_os = "macos") {
        prepend_environment_path(command, "DYLD_LIBRARY_PATH", &library);
    } else if cfg!(unix) {
        prepend_environment_path(command, "LD_LIBRARY_PATH", &library);
    }
    let icu = runtime.join("share/icu");
    if icu.is_dir() {
        command.env("ICU_DATA", icu);
    }
}

fn prepend_environment_path(command: &mut Command, name: &str, value: &Path) {
    let mut paths = vec![value.to_path_buf()];
    if let Some(existing) = std::env::var_os(name) {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env(name, joined);
    }
}

fn validate_connection_string(tool: &'static str, value: &str) -> Result<(), PostgresToolError> {
    if value.trim().is_empty() || value.as_bytes().contains(&0) {
        return Err(configuration_error(
            tool,
            "connection string must not be empty or contain NUL bytes",
        ));
    }
    Ok(())
}

fn validate_text(tool: &'static str, label: &str, value: &str) -> Result<(), PostgresToolError> {
    if value.as_bytes().contains(&0) {
        return Err(configuration_error(
            tool,
            &format!("{label} must not contain NUL bytes"),
        ));
    }
    Ok(())
}

fn configuration_error(tool: &'static str, message: &str) -> PostgresToolError {
    PostgresToolError {
        tool,
        exit_code: None,
        stdout: String::new(),
        stderr: message.to_owned(),
        source: None,
        output_capture_failure: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn psql_scripts_explicitly_read_standard_input() {
        let (script, stdin) = psql_invocation(
            "postgresql://localhost/postgres",
            PsqlOptions::new().script("SELECT 1;"),
        );
        assert!(script.iter().any(|argument| argument == "--file=-"));
        assert_eq!(stdin.as_deref(), Some(b"SELECT 1;".as_slice()));

        let (command, stdin) = psql_invocation(
            "postgresql://localhost/postgres",
            PsqlOptions::new().command("SELECT 1"),
        );
        assert!(!command.iter().any(|argument| argument == "--file=-"));
        assert!(
            command
                .windows(2)
                .any(|arguments| arguments == ["--command", "SELECT 1"])
        );
        assert!(stdin.is_none());
    }

    #[test]
    fn captured_output_preserves_both_streams_at_the_aggregate_limit() {
        let mut captured = CapturedOutput::new(7);
        captured.retain(OutputChannel::Stdout, b"out");
        captured.retain(OutputChannel::Stderr, b"err!");

        assert_eq!(captured.failure, None);
        assert_eq!(captured.retained_bytes, 7);
        assert_eq!(captured.stdout, b"out");
        assert_eq!(captured.stderr, b"err!");
    }

    #[test]
    fn captured_output_discards_everything_after_aggregate_overflow() {
        let mut captured = CapturedOutput::new(5);
        captured.retain(OutputChannel::Stdout, b"abc");
        captured.retain(OutputChannel::Stderr, b"def");
        captured.retain(OutputChannel::Stdout, b"later output");

        assert_eq!(captured.failure, Some(OutputCaptureFailure::LimitExceeded));
        assert_eq!(captured.retained_bytes, 0);
        assert!(captured.stdout.is_empty());
        assert!(captured.stderr.is_empty());
    }

    #[test]
    fn output_reader_continues_draining_after_capture_overflow() {
        let bytes = vec![b'x'; 32 * 1024 + 17];
        let captured = Mutex::new(CapturedOutput::new(1));

        let observed = drain_output(Cursor::new(&bytes), &captured, OutputChannel::Stdout)
            .expect("reader should drain all input");
        let captured = captured
            .into_inner()
            .expect("capture lock should remain usable");

        assert_eq!(observed, bytes.len());
        assert_eq!(captured.failure, Some(OutputCaptureFailure::LimitExceeded));
        assert!(captured.stdout.is_empty());
        assert!(captured.stderr.is_empty());
    }

    #[test]
    fn output_limit_error_is_stable_and_contains_no_partial_output() {
        let error = PostgresToolError {
            tool: "pg_dump",
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            source: None,
            output_capture_failure: Some(OutputCaptureFailure::LimitExceeded),
        };

        assert_eq!(
            error.to_string(),
            "pg_dump combined stdout and stderr exceeded the 67108864-byte capture limit; larger valid output requires a streaming or sink API, which is not currently available"
        );
        assert!(error.stdout.is_empty());
        assert!(error.stderr.is_empty());
    }

    #[test]
    fn poisoned_capture_is_fail_closed_and_does_not_stop_draining() {
        let captured = Arc::new(Mutex::new(CapturedOutput::new(32)));
        let poison_target = Arc::clone(&captured);
        let _ = std::thread::spawn(move || {
            let _guard = poison_target.lock().unwrap();
            panic!("poison the capture lock");
        })
        .join();

        let observed = drain_output(
            Cursor::new(b"all bytes still drained"),
            &captured,
            OutputChannel::Stdout,
        )
        .expect("poisoning must not stop pipe draining");
        let captured = take_captured_output(&captured);

        assert_eq!(observed, b"all bytes still drained".len());
        assert_eq!(captured.failure, Some(OutputCaptureFailure::LockPoisoned));
        assert!(captured.stdout.is_empty());
        assert!(captured.stderr.is_empty());
    }
}
