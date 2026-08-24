#![deny(unsafe_code)]

use std::error::Error as StdError;
use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

/// Product id for the native PostgreSQL client tools artifact family.
pub const PRODUCT: &str = "oliphaunt-tools";

/// Artifact kind relayed by this facade crate.
pub const KIND: &str = "native-tools";

/// Options for a plain-text `pg_dump`.
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

/// Options for a non-interactive `psql` invocation.
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
    pub stdout: String,
    /// UTF-8 standard error captured before failure.
    pub stderr: String,
    source: Option<std::io::Error>,
}

impl fmt::Display for PostgresToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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
pub fn pg_dump(
    connection_string: &str,
    options: PgDumpOptions,
) -> Result<String, PostgresToolError> {
    validate_connection_string("pg_dump", connection_string)?;
    validate_args("pg_dump", &options.args, disallowed_pg_dump_flag)?;
    let mut arguments = options
        .args
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.push(OsString::from("--encoding=UTF8"));
    arguments.push(OsString::from(format!("--dbname={connection_string}")));
    run_tool("pg_dump", arguments, None)
}

/// Run packaged non-interactive `psql` against a PostgreSQL connection string.
pub fn psql(connection_string: &str, options: PsqlOptions) -> Result<String, PostgresToolError> {
    validate_connection_string("psql", connection_string)?;
    validate_args("psql", &options.args, disallowed_psql_flag)?;
    if options.input.is_none() && options.args.is_empty() {
        return Err(configuration_error(
            "psql",
            "psql requires command(), script(), or a non-input argument",
        ));
    }
    let mut arguments = options
        .args
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.push(OsString::from("--no-psqlrc"));
    arguments.push(OsString::from("--set=ON_ERROR_STOP=1"));
    arguments.push(OsString::from(format!("--dbname={connection_string}")));
    let stdin = match options.input {
        Some(PsqlInput::Command(command)) => {
            validate_text("psql", "command", &command)?;
            arguments.push(OsString::from("--command"));
            arguments.push(OsString::from(command));
            None
        }
        Some(PsqlInput::Script(script)) => {
            validate_text("psql", "script", &script)?;
            Some(script.into_bytes())
        }
        None => None,
    };
    run_tool("psql", arguments, stdin)
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
    })?;
    // Drain stdout/stderr while a potentially large psql script is written.
    // Writing all stdin first can deadlock when the child fills an output pipe.
    let input_writer = stdin.and_then(|input| {
        child
            .stdin
            .take()
            .map(|mut writer| thread::spawn(move || writer.write_all(&input)))
    });
    let output = child
        .wait_with_output()
        .map_err(|source| PostgresToolError {
            tool,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            source: Some(source),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let input_failure = input_writer.and_then(|writer| match writer.join() {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some(std::io::Error::other("psql stdin writer panicked")),
    });
    if !output.status.success() {
        return Err(PostgresToolError {
            tool,
            exit_code: output.status.code(),
            stdout,
            stderr,
            source: None,
        });
    }
    if let Some(source) = input_failure {
        return Err(PostgresToolError {
            tool,
            exit_code: output.status.code(),
            stdout,
            stderr,
            source: Some(source),
        });
    }
    String::from_utf8(output.stdout).map_err(|error| PostgresToolError {
        tool,
        exit_code: output.status.code(),
        stdout,
        stderr: format!("{stderr}{} produced non-UTF-8 output: {error}", tool),
        source: None,
    })
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

fn validate_args(
    tool: &'static str,
    arguments: &[String],
    disallowed: fn(&str) -> Option<&'static str>,
) -> Result<(), PostgresToolError> {
    for argument in arguments {
        validate_text(tool, "argument", argument)?;
        if let Some(managed) = disallowed(argument) {
            return Err(configuration_error(
                tool,
                &format!("argument {argument:?} conflicts with Oliphaunt-managed {managed}"),
            ));
        }
    }
    Ok(())
}

fn disallowed_pg_dump_flag(argument: &str) -> Option<&'static str> {
    disallowed_flag(
        argument,
        &[
            ("--file", "output"),
            ("--format", "plain format"),
            ("--compress", "compression"),
            ("--encoding", "UTF-8 encoding"),
            ("--host", "connection"),
            ("--port", "connection"),
            ("--username", "connection"),
            ("--dbname", "connection"),
            ("--jobs", "job count"),
        ],
        &[
            ("-f", "output"),
            ("-F", "plain format"),
            ("-Z", "compression"),
            ("-E", "UTF-8 encoding"),
            ("-h", "connection"),
            ("-p", "connection"),
            ("-U", "connection"),
            ("-d", "connection"),
            ("-j", "job count"),
        ],
    )
}

fn disallowed_psql_flag(argument: &str) -> Option<&'static str> {
    disallowed_flag(
        argument,
        &[
            ("--host", "connection"),
            ("--port", "connection"),
            ("--username", "connection"),
            ("--dbname", "connection"),
            ("--output", "stdout capture"),
            ("--log-file", "stderr capture"),
            ("--command", "input"),
            ("--file", "input"),
        ],
        &[
            ("-h", "connection"),
            ("-p", "connection"),
            ("-U", "connection"),
            ("-d", "connection"),
            ("-o", "stdout capture"),
            ("-L", "stderr capture"),
            ("-c", "input"),
            ("-f", "input"),
        ],
    )
}

fn disallowed_flag(
    argument: &str,
    long: &[(&'static str, &'static str)],
    short: &[(&'static str, &'static str)],
) -> Option<&'static str> {
    for (flag, label) in long {
        if argument == *flag
            || argument
                .strip_prefix(*flag)
                .is_some_and(|tail| tail.starts_with('='))
        {
            return Some(label);
        }
    }
    for (flag, label) in short {
        if argument == *flag || (argument.starts_with(*flag) && argument.len() > flag.len()) {
            return Some(label);
        }
    }
    None
}

fn configuration_error(tool: &'static str, message: &str) -> PostgresToolError {
    PostgresToolError {
        tool,
        exit_code: None,
        stdout: String::new(),
        stderr: message.to_owned(),
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_option_fixture_matches_native_validation() {
        let fixture = include_str!("../../../../../../shared/fixtures/postgres/logical-tools.json");
        for argument in fixture_arguments(fixture, "pgDump", "acceptedArgs") {
            assert!(disallowed_pg_dump_flag(&argument).is_none());
        }
        for argument in fixture_arguments(fixture, "pgDump", "rejectedArgs") {
            assert!(disallowed_pg_dump_flag(&argument).is_some());
        }
        for argument in fixture_arguments(fixture, "psql", "acceptedArgs") {
            assert!(disallowed_psql_flag(&argument).is_none());
        }
        for argument in fixture_arguments(fixture, "psql", "rejectedArgs") {
            assert!(disallowed_psql_flag(&argument).is_some());
        }
    }

    fn fixture_arguments(fixture: &str, section: &str, field: &str) -> Vec<String> {
        let section = fixture
            .split_once(&format!("\"{section}\": {{"))
            .expect("shared logical-tools fixture section")
            .1;
        let array = section
            .split_once(&format!("\"{field}\": ["))
            .expect("shared logical-tools fixture argument array")
            .1
            .split_once(']')
            .expect("shared logical-tools fixture argument array terminator")
            .0;
        array
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| {
                line.trim_end_matches(',')
                    .strip_prefix('"')
                    .and_then(|line| line.strip_suffix('"'))
                    .expect("shared logical-tools arguments must be JSON strings")
                    .to_owned()
            })
            .collect()
    }
}
