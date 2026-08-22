use std::io::{Cursor, Read, Seek, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};

use anyhow::{Context, Result, anyhow};
use tempfile::TempDir;
use wasmer_types::ModuleHash;
use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
use wasmer_wasix::virtual_fs::{self, AsyncRead, AsyncSeek, AsyncWrite};
use wasmer_wasix::virtual_net::VirtualNetworking;
use wasmer_wasix::{LocalNetworking, PluggableRuntime, VirtualFile};

use crate::oliphaunt::base::{install_optional_icu_data, unpack_runtime_archive_reader};
use crate::oliphaunt::sync_host_fs::SyncHostFileSystem;
use crate::oliphaunt::{aot, assets};

/// Options for the bundled WASIX `pg_dump` runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgDumpOptions {
    args: Vec<String>,
    database: String,
    username: String,
}

impl Default for PgDumpOptions {
    fn default() -> Self {
        Self {
            args: Vec::new(),
            database: "postgres".to_owned(),
            username: "postgres".to_owned(),
        }
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

    /// Select the database to dump.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.database = database.into();
        self
    }

    /// Select the user passed to `pg_dump`.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.username = username.into();
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for (name, value) in [("database", &self.database), ("username", &self.username)] {
            anyhow::ensure!(
                !value.is_empty() && !value.contains('\0'),
                "pg_dump {name} must not be empty or contain NUL bytes"
            );
        }
        for arg in &self.args {
            anyhow::ensure!(
                !arg.contains('\0'),
                "pg_dump argument must not contain NUL bytes"
            );
            validate_passthrough_arg(arg)?;
        }
        Ok(())
    }
}

/// Options for the bundled WASIX `psql` runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PsqlOptions {
    args: Vec<String>,
    database: String,
    username: String,
    input: Option<PsqlInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PsqlInput {
    Command(String),
    Script(String),
}

impl Default for PsqlOptions {
    fn default() -> Self {
        Self {
            args: Vec::new(),
            database: "postgres".to_owned(),
            username: "postgres".to_owned(),
            input: None,
        }
    }
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

    /// Run a SQL script with `psql -f`.
    pub fn script(mut self, sql: impl Into<String>) -> Self {
        self.input = Some(PsqlInput::Script(sql.into()));
        self
    }

    /// Select the database passed to `psql`.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.database = database.into();
        self
    }

    /// Select the user passed to `psql`.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.username = username.into();
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        for (name, value) in [("database", &self.database), ("username", &self.username)] {
            anyhow::ensure!(
                !value.is_empty() && !value.contains('\0'),
                "psql {name} must not be empty or contain NUL bytes"
            );
        }
        anyhow::ensure!(
            !self.args.is_empty() || self.input.is_some(),
            "psql runner requires non-interactive input; use PsqlOptions::command, PsqlOptions::script, or pass a non-input psql argument"
        );
        for arg in &self.args {
            anyhow::ensure!(
                !arg.contains('\0'),
                "psql argument must not contain NUL bytes"
            );
            validate_psql_passthrough_arg(arg)?;
        }
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

fn validate_passthrough_arg(arg: &str) -> Result<()> {
    if let Some(flag) = disallowed_pg_dump_flag(arg) {
        anyhow::bail!(
            "pg_dump argument '{arg}' conflicts with oliphaunt-wasix's managed {flag}; use PgDumpOptions typed setters where available"
        );
    }
    Ok(())
}

fn disallowed_pg_dump_flag(arg: &str) -> Option<&'static str> {
    const LONG_FLAGS: &[(&str, &str)] = &[
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
    for (flag, label) in LONG_FLAGS {
        if arg == *flag
            || arg
                .strip_prefix(*flag)
                .is_some_and(|tail| tail.starts_with('='))
        {
            return Some(label);
        }
    }

    const SHORT_FLAGS: &[(&str, &str)] = &[
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
    for (flag, label) in SHORT_FLAGS {
        if arg == *flag || (arg.starts_with(*flag) && arg.len() > flag.len()) {
            return Some(label);
        }
    }
    None
}

fn validate_psql_passthrough_arg(arg: &str) -> Result<()> {
    if let Some(flag) = disallowed_psql_flag(arg) {
        anyhow::bail!(
            "psql argument '{arg}' conflicts with oliphaunt-wasix's managed {flag}; use PsqlOptions typed setters where available"
        );
    }
    Ok(())
}

fn disallowed_psql_flag(arg: &str) -> Option<&'static str> {
    const LONG_FLAGS: &[(&str, &str)] = &[
        ("--host", "host"),
        ("--port", "port"),
        ("--username", "username"),
        ("--dbname", "database"),
        ("--output", "stdout capture"),
        ("--log-file", "stderr capture"),
        ("--command", "input"),
        ("--file", "input"),
    ];
    for (flag, label) in LONG_FLAGS {
        if arg == *flag
            || arg
                .strip_prefix(*flag)
                .is_some_and(|tail| tail.starts_with('='))
        {
            return Some(label);
        }
    }

    const SHORT_FLAGS: &[(&str, &str)] = &[
        ("-h", "host"),
        ("-p", "port"),
        ("-U", "username"),
        ("-d", "database"),
        ("-o", "stdout capture"),
        ("-L", "stderr capture"),
        ("-c", "input"),
        ("-f", "input"),
    ];
    for (flag, label) in SHORT_FLAGS {
        if arg == *flag || (arg.starts_with(*flag) && arg.len() > flag.len()) {
            return Some(label);
        }
    }
    None
}

pub(crate) fn dump_server_sql(addr: SocketAddr, options: &PgDumpOptions) -> Result<String> {
    dump_sql_with_networking(addr, options, LocalNetworking::new())
}

pub(crate) fn run_server_psql(addr: SocketAddr, options: &PsqlOptions) -> Result<String> {
    run_psql_with_networking(addr, options, LocalNetworking::new())
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

struct ToolOutput {
    fs_root: TempDir,
    stdout: Vec<u8>,
}

fn run_wasix_client_tool<N, F>(
    tool_name: &'static str,
    wasm: &'static [u8],
    load_module: fn(&wasmer::Engine) -> Result<wasmer::Module>,
    addr: SocketAddr,
    username: &str,
    networking: N,
    build_args: F,
) -> Result<ToolOutput>
where
    N: VirtualNetworking + Sync,
    F: FnOnce(&Path, String, String) -> Result<Vec<String>>,
{
    let engine = aot::headless_engine();
    let module = load_module(&engine).with_context(|| {
        format!("load {tool_name} AOT artifact from oliphaunt-wasix-tools-aot-*")
    })?;

    let fs_root =
        TempDir::new().with_context(|| format!("create {tool_name} WASIX filesystem root"))?;
    if let Some(runtime_archive) = assets::runtime_archive() {
        unpack_runtime_archive_reader(
            Cursor::new(runtime_archive),
            Path::new("oliphaunt.wasix.tar.zst"),
            fs_root.path(),
        )
        .with_context(|| format!("install WASIX runtime files for {tool_name}"))?;
        install_optional_icu_data(&fs_root.path().join("oliphaunt"))
            .with_context(|| format!("install WASIX ICU data for {tool_name}"))?;
    }

    let host = addr.ip().to_string();
    let port = addr.port().to_string();
    let args = build_args(fs_root.path(), host, port)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .with_context(|| format!("create Tokio runtime for WASIX {tool_name}"))?;
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
        .with_mount("/host".to_owned(), host_fs)
        .with_current_dir("/")
        .with_args(args)
        .with_envs([
            ("PGUSER", username),
            ("PGPASSWORD", "password"),
            ("PGSSLMODE", "disable"),
        ])
        .with_stdout(Box::new(CaptureFile::new(Arc::clone(&stdout))))
        .with_stderr(Box::new(CaptureFile::new(Arc::clone(&stderr))));
    if fs_root.path().join("oliphaunt/share/icu").is_dir() {
        runner.with_envs([("ICU_DATA", "/oliphaunt/share/icu")]);
    }
    runner
        .run_wasm(
            RuntimeOrEngine::Runtime(Arc::new(wasix_runtime)),
            tool_name,
            module,
            ModuleHash::sha256(wasm),
        )
        .map_err(|err| {
            let stderr = String::from_utf8_lossy(&stderr.lock().expect("stderr capture poisoned"))
                .trim()
                .to_owned();
            if stderr.is_empty() {
                anyhow!(err)
            } else {
                anyhow!("{err}; {tool_name} stderr: {stderr}")
            }
        })
        .with_context(|| format!("run WASIX {tool_name}"))?;

    let stdout = stdout.lock().expect("stdout capture poisoned").clone();
    Ok(ToolOutput { fs_root, stdout })
}

fn dump_sql_with_networking<N>(
    addr: SocketAddr,
    options: &PgDumpOptions,
    networking: N,
) -> Result<String>
where
    N: VirtualNetworking + Sync,
{
    options.validate()?;
    let output = run_wasix_client_tool(
        "pg_dump",
        pg_dump_wasm_asset()?,
        aot::load_pg_dump_module,
        addr,
        &options.username,
        networking,
        |_, host, port| {
            let mut args = options.args.clone();
            args.extend([
                "-U".to_owned(),
                options.username.clone(),
                "-h".to_owned(),
                host,
                "-p".to_owned(),
                port,
                "-f".to_owned(),
                "/host/out.sql".to_owned(),
            ]);
            args.push(options.database.clone());
            Ok(args)
        },
    )?;

    let output_path = output.fs_root.path().join("out.sql");
    match std::fs::read_to_string(&output_path) {
        Ok(sql) => Ok(sql),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound && !output.stdout.is_empty() => {
            String::from_utf8(output.stdout).context("decode pg_dump stdout as UTF-8")
        }
        Err(err) => {
            Err(err).with_context(|| format!("read pg_dump output {}", output_path.display()))
        }
    }
}

fn run_psql_with_networking<N>(
    addr: SocketAddr,
    options: &PsqlOptions,
    networking: N,
) -> Result<String>
where
    N: VirtualNetworking + Sync,
{
    options.validate()?;
    let output = run_wasix_client_tool(
        "psql",
        psql_wasm_asset()?,
        aot::load_psql_module,
        addr,
        &options.username,
        networking,
        |fs_root, host, port| {
            if let Some(PsqlInput::Script(script)) = &options.input {
                std::fs::write(fs_root.join("input.sql"), script)
                    .context("stage psql input script")?;
            }
            let mut args = vec![
                "-X".to_owned(),
                "-v".to_owned(),
                "ON_ERROR_STOP=1".to_owned(),
                "-U".to_owned(),
                options.username.clone(),
                "-h".to_owned(),
                host,
                "-p".to_owned(),
                port,
                "-d".to_owned(),
                options.database.clone(),
            ];
            args.extend(options.args.clone());
            match &options.input {
                Some(PsqlInput::Command(command)) => {
                    args.extend(["-c".to_owned(), command.clone()]);
                }
                Some(PsqlInput::Script(_)) => {
                    args.extend(["-f".to_owned(), "/host/input.sql".to_owned()]);
                }
                None => {}
            }
            Ok(args)
        },
    )?;
    String::from_utf8(output.stdout).context("decode psql stdout as UTF-8")
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

#[cfg(all(test, feature = "tools", feature = "extensions"))]
mod tests {
    use super::*;
    use crate::oliphaunt::extensions;
    use crate::oliphaunt::server::OliphauntServer;
    use sqlx::{Connection, Executor, Row};

    #[test]
    fn pg_dump_options_reject_managed_args() {
        for arg in [
            "-f",
            "-f/tmp/out.sql",
            "--file",
            "--file=/tmp/out.sql",
            "-F",
            "-Fc",
            "--format",
            "--format=custom",
            "-Z",
            "-Z9",
            "--compress",
            "--compress=zstd",
            "-E",
            "-EUTF8",
            "--encoding",
            "--encoding=UTF8",
            "-h",
            "-hlocalhost",
            "--host=localhost",
            "-p",
            "-p5432",
            "--port=5432",
            "-U",
            "-Upostgres",
            "--username=postgres",
            "-d",
            "-dpostgres",
            "--dbname=postgres",
            "-j",
            "-j2",
            "--jobs=2",
        ] {
            let err = PgDumpOptions::new()
                .arg(arg)
                .validate()
                .expect_err("managed pg_dump arg should be rejected");
            assert!(
                err.to_string().contains("conflicts with oliphaunt-wasix"),
                "unexpected error for {arg}: {err:#}"
            );
        }
    }

    #[test]
    fn pg_dump_options_allow_dump_shaping_args() -> Result<()> {
        PgDumpOptions::new()
            .args([
                "--schema-only",
                "--quote-all-identifiers",
                "-n",
                "public",
                "-t",
                "dump_items",
            ])
            .validate()
    }

    #[test]
    fn pg_dump_options_explain_fixed_text_output() {
        for (arg, label) in [
            ("--compress=zstd", "output compression"),
            ("-Z9", "output compression"),
            ("--encoding=UTF8", "output encoding"),
            ("-EUTF8", "output encoding"),
        ] {
            let error = PgDumpOptions::new()
                .arg(arg)
                .validate()
                .expect_err("fixed-output pg_dump argument must be rejected");
            assert!(
                error.to_string().contains(label),
                "unexpected error for {arg}: {error:#}"
            );
        }
    }

    #[test]
    fn psql_options_reject_managed_args() {
        for arg in [
            "-h",
            "-hlocalhost",
            "--host=localhost",
            "-p",
            "-p5432",
            "--port=5432",
            "-U",
            "-Upostgres",
            "--username=postgres",
            "-d",
            "-dpostgres",
            "--dbname=postgres",
            "-o",
            "-o/tmp/out",
            "--output=/tmp/out",
            "-L",
            "-L/tmp/log",
            "--log-file=/tmp/log",
            "-c",
            "-cSELECT 1",
            "--command=SELECT 1",
            "-f",
            "-f/tmp/input.sql",
            "--file=/tmp/input.sql",
        ] {
            let err = PsqlOptions::new()
                .command("SELECT 1")
                .arg(arg)
                .validate()
                .expect_err("managed psql arg should be rejected");
            assert!(
                err.to_string().contains("conflicts with oliphaunt-wasix"),
                "unexpected error for {arg}: {err:#}"
            );
        }
    }

    #[test]
    fn psql_options_require_non_interactive_args() {
        let err = PsqlOptions::new()
            .validate()
            .expect_err("psql without args should be rejected");
        assert!(
            err.to_string().contains("requires non-interactive input"),
            "unexpected error: {err:#}"
        );
    }

    #[test]
    fn psql_options_allow_command_and_formatting_args() -> Result<()> {
        PsqlOptions::new().arg("-tA").command("SELECT 1").validate()
    }

    #[test]
    fn psql_options_accept_script_and_reject_nul() -> Result<()> {
        PsqlOptions::new()
            .script("\\restrict AbC123\nSELECT 1;\n\\unrestrict AbC123\n")
            .validate()?;
        let error = PsqlOptions::new()
            .script("SELECT '\0'")
            .validate()
            .expect_err("NUL-bearing psql script must be rejected");
        assert!(error.to_string().contains("script must not contain NUL"));
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_dump_round_trip_plain_sql() -> Result<()> {
        let server = OliphauntServer::builder().start()?;
        let mut conn = sqlx::PgConnection::connect(&server.connection_string())
            .await
            .context("connect to Oliphaunt server")?;
        conn.execute(
            "CREATE TABLE dump_items(id INTEGER PRIMARY KEY, value TEXT);
             CREATE INDEX dump_items_value_idx ON dump_items(value);
             CREATE SEQUENCE dump_items_seq START WITH 10;
             CREATE VIEW dump_item_values AS SELECT value FROM dump_items;
             INSERT INTO dump_items(id, value) VALUES (1, 'alpha'), (2, 'beta');
             SELECT nextval('dump_items_seq');",
        )
        .await
        .context("seed pg_dump source data")?;
        drop(conn);

        let (server, dump) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.pg_dump(PgDumpOptions::default())?;
            Ok((server, dump))
        })
        .await
        .context("join pg_dump task")??;

        assert!(dump.contains("PostgreSQL database dump"));
        assert!(
            dump.contains("CREATE TABLE public.dump_items"),
            "dump did not contain dump_items table DDL:\n{dump}"
        );
        assert!(dump.contains("CREATE INDEX dump_items_value_idx"));
        assert!(dump.contains("CREATE SEQUENCE public.dump_items_seq"));
        assert!(dump.contains("CREATE VIEW public.dump_item_values"));
        assert!(dump.contains("COPY public.dump_items (id, value) FROM stdin;"));
        assert!(dump.lines().any(|line| line.starts_with("\\restrict ")));
        assert!(dump.lines().any(|line| line.starts_with("\\unrestrict ")));

        let (server, schema_only) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.pg_dump(PgDumpOptions::new().arg("--schema-only"))?;
            Ok((server, dump))
        })
        .await
        .context("join schema-only pg_dump task")??;
        assert!(schema_only.contains("CREATE TABLE public.dump_items"));
        assert!(
            !schema_only.contains("COPY public.dump_items"),
            "schema-only dump unexpectedly contained data:\n{schema_only}"
        );

        let (server, quoted) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.pg_dump(PgDumpOptions::new().arg("--quote-all-identifiers"))?;
            Ok((server, dump))
        })
        .await
        .context("join quoted pg_dump task")??;
        assert!(quoted.contains("CREATE TABLE \"public\".\"dump_items\""));
        assert!(quoted.contains("COPY \"public\".\"dump_items\" (\"id\", \"value\") FROM stdin;"));

        let mut usable = sqlx::PgConnection::connect(&server.connection_string())
            .await
            .context("reconnect after pg_dump")?;
        let row = sqlx::query("SELECT count(*)::int4 AS count FROM public.dump_items")
            .fetch_one(&mut usable)
            .await
            .context("server should remain usable after pg_dump")?;
        assert_eq!(row.try_get::<i32, _>("count")?, 2);
        let sequence_state = sqlx::query(
            "SELECT last_value::int8 AS last_value, is_called FROM public.dump_items_seq",
        )
        .fetch_one(&mut usable)
        .await
        .context("read source sequence state after pg_dump")?;
        let source_last_value = sequence_state.try_get::<i64, _>("last_value")?;
        assert!(sequence_state.try_get::<bool, _>("is_called")?);
        usable.close().await?;

        server.close()?;

        let restored = OliphauntServer::builder().start()?;
        let restored = tokio::task::spawn_blocking(move || -> Result<_> {
            restored
                .psql(PsqlOptions::new().script(dump))
                .context("restore standard pg_dump script through packaged psql")?;
            Ok(restored)
        })
        .await
        .context("join packaged psql restore task")??;
        let mut connection = sqlx::PgConnection::connect(&restored.connection_string())
            .await
            .context("connect to restored Oliphaunt server")?;
        let result = sqlx::query("SELECT value FROM public.dump_items WHERE id = $1")
            .bind(2_i32)
            .fetch_one(&mut connection)
            .await?;
        assert_eq!(result.try_get::<&str, _>("value")?, "beta");
        let view = sqlx::query("SELECT count(*)::int AS count FROM public.dump_item_values")
            .fetch_one(&mut connection)
            .await?;
        assert_eq!(view.try_get::<i32, _>("count")?, 2);
        let sequence = sqlx::query("SELECT nextval('public.dump_items_seq')::bigint AS next_value")
            .fetch_one(&mut connection)
            .await?;
        assert_eq!(
            sequence.try_get::<i64, _>("next_value")?,
            source_last_value + 1
        );
        connection.close().await?;
        restored.close()?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_dump_round_trips_every_embedded_extension() -> Result<()> {
        let embedded = extensions::ALL
            .iter()
            .copied()
            .filter(|extension| assets::extension_archive(extension.sql_name()).is_some())
            .collect::<Vec<_>>();
        if embedded.is_empty() {
            eprintln!("skipping extension pg_dump smoke; no extension archives are embedded");
            return Ok(());
        }
        anyhow::ensure!(
            embedded
                .windows(2)
                .all(|pair| pair[0].sql_name() < pair[1].sql_name()),
            "embedded extension dump/restore set must remain sorted by SQL name"
        );

        eprintln!(
            "WASIX extension pg_dump/psql catalog: {}",
            embedded
                .iter()
                .map(|extension| extension.sql_name())
                .collect::<Vec<_>>()
                .join(", ")
        );

        for extension in embedded {
            pg_dump_round_trip_extension(extension).await?;
        }
        Ok(())
    }

    async fn pg_dump_round_trip_extension(extension: extensions::Extension) -> Result<()> {
        let sql_name = extension.sql_name();
        let server = OliphauntServer::builder().extension(extension).start()?;
        let mut connection = sqlx::PgConnection::connect(&server.connection_string())
            .await
            .context("connect to extension pg_dump source server")?;
        let recipe = extensions::extension_smoke_sql(sql_name);
        for statement in extensions::extension_smoke_statements(&recipe) {
            connection.execute(statement).await.with_context(|| {
                format!("run canonical source smoke for extension {sql_name}:\n{statement}")
            })?;
        }
        connection.close().await?;

        let (server, dump) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.pg_dump(PgDumpOptions::default())?;
            Ok((server, dump))
        })
        .await
        .context("join extension pg_dump task")??;
        server.close()?;

        if extension.creates_extension() {
            let unquoted = format!("CREATE EXTENSION IF NOT EXISTS {sql_name}");
            let quoted = format!("CREATE EXTENSION IF NOT EXISTS \"{sql_name}\"");
            anyhow::ensure!(
                dump.contains(&unquoted) || dump.contains(&quoted),
                "pg_dump output omitted extension {sql_name}"
            );
        }

        let restored = OliphauntServer::builder().extension(extension).start()?;
        let restored = tokio::task::spawn_blocking(move || -> Result<_> {
            restored
                .psql(PsqlOptions::new().script(dump))
                .context("restore catalog-extension pg_dump script through packaged psql")?;
            Ok(restored)
        })
        .await
        .context("join catalog-extension packaged psql restore task")??;
        let mut connection = sqlx::PgConnection::connect(&restored.connection_string())
            .await
            .context("connect to restored catalog-extension server")?;

        if extension.creates_extension() {
            let present = sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM pg_extension WHERE extname = $1",
            )
            .bind(sql_name)
            .fetch_one(&mut connection)
            .await
            .with_context(|| format!("verify restored extension catalog row for {sql_name}"))?;
            anyhow::ensure!(present == 1, "restored extension {sql_name} is missing");
        }

        if extension == extensions::VECTOR {
            let distance = sqlx::query_scalar::<_, f64>(
                "SELECT embedding <-> '[1,2,4]'::vector FROM oliphaunt_vector WHERE id = 1",
            )
            .fetch_one(&mut connection)
            .await
            .context("verify the canonical vector row survived pg_dump/psql restore")?;
            anyhow::ensure!(distance == 1.0, "restored vector distance must equal 1");
        }

        let recipe = extensions::extension_smoke_sql(sql_name);
        for statement in extensions::extension_smoke_statements(&recipe) {
            connection.execute(statement).await.with_context(|| {
                format!("run canonical restored smoke for extension {sql_name}:\n{statement}")
            })?;
        }
        connection.close().await?;
        restored.close()?;
        Ok(())
    }
}
