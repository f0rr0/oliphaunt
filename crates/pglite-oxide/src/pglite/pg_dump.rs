use std::fmt;
use std::io::{Read, Seek, Write};
use std::mem::MaybeUninit;
use std::net::Shutdown;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use tempfile::TempDir;
use wasmer::Store;
use wasmer_types::ModuleHash;
use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
use wasmer_wasix::virtual_fs::{self, AsyncRead, AsyncSeek, AsyncWrite};
use wasmer_wasix::virtual_net::tcp_pair::TcpSocketHalf;
use wasmer_wasix::virtual_net::{
    self, InterestHandler, NetworkError, SocketStatus, VirtualConnectedSocket, VirtualIoSource,
    VirtualNetworking, VirtualSocket, VirtualTcpSocket,
};
use wasmer_wasix::{LocalNetworking, PluggableRuntime, VirtualFile};

use crate::pglite::sync_host_fs::SyncHostFileSystem;
use crate::pglite::timing;
use crate::pglite::{aot, assets};

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
            database: "template1".to_owned(),
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

    pub(crate) fn database_ref(&self) -> &str {
        &self.database
    }

    pub(crate) fn username_ref(&self) -> &str {
        &self.username
    }
}

fn validate_passthrough_arg(arg: &str) -> Result<()> {
    if let Some(flag) = disallowed_pg_dump_flag(arg) {
        anyhow::bail!(
            "pg_dump argument '{arg}' conflicts with pglite-oxide's managed {flag}; use PgDumpOptions typed setters where available"
        );
    }
    Ok(())
}

fn disallowed_pg_dump_flag(arg: &str) -> Option<&'static str> {
    const LONG_FLAGS: &[(&str, &str)] = &[
        ("--file", "output file"),
        ("--format", "output format"),
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

pub(crate) fn dump_server_sql(addr: SocketAddr, options: &PgDumpOptions) -> Result<String> {
    dump_sql_with_networking(addr, options, LocalNetworking::new())
}

pub(crate) type PgDumpVirtualSocket = TcpSocketHalf;

pub(crate) fn dump_direct_sql<F>(options: &PgDumpOptions, serve: F) -> Result<String>
where
    F: FnOnce(PgDumpVirtualSocket) -> Result<()>,
{
    options.validate()?;
    let (socket_tx, socket_rx) = mpsc::sync_channel(1);
    let networking = DirectPgDumpNetworking::new(socket_tx);
    let runner_options = options.clone();
    let runner = thread::spawn(move || {
        dump_sql_with_networking(DIRECT_PG_DUMP_ADDR, &runner_options, networking)
    });

    let accepted = receive_direct_pg_dump_socket(&socket_rx, &runner)
        .context("accept direct pg_dump virtual protocol connection");
    let serve_result = match accepted {
        Ok(socket) => serve(socket),
        Err(err) => Err(err),
    };
    let dump_result = runner
        .join()
        .map_err(|_| anyhow!("direct pg_dump runner thread panicked"))?;

    match (serve_result, dump_result) {
        (Ok(()), Ok(sql)) => Ok(sql),
        (Err(err), Ok(_)) => Err(err),
        (Ok(()), Err(err)) => Err(err),
        (Err(err), Err(dump_err)) => {
            Err(err.context(format!("direct pg_dump runner also failed: {dump_err:#}")))
        }
    }
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
    let _phase = timing::phase("pg_dump");
    let wasm = {
        let _phase = timing::phase("pg_dump.load_embedded_module");
        assets::pg_dump_wasm()
            .ok_or_else(|| anyhow!("WASIX pg_dump asset is not bundled in this build"))?
    };
    let engine = aot::headless_engine();
    let module = {
        let _phase = timing::phase("pg_dump.load_aot");
        aot::load_pg_dump_module(&engine)?
    };
    let _store = Store::new(engine.clone());

    let fs_root = TempDir::new().context("create pg_dump WASIX filesystem root")?;
    let runtime = {
        let _phase = timing::phase("pg_dump.tokio_runtime");
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .context("create Tokio runtime for WASIX pg_dump")?
    };
    let (host_fs, wasix_runtime) = {
        let _phase = timing::phase("pg_dump.wasix_runtime");
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

    let output_path = "/host/out.sql";
    let port = addr.port().to_string();
    let host = match addr {
        SocketAddr::V4(addr) => addr.ip().to_string(),
        SocketAddr::V6(addr) => addr.ip().to_string(),
    };
    let mut args = options.args.clone();
    args.extend([
        "-U".to_owned(),
        options.username.clone(),
        "-h".to_owned(),
        host,
        "-p".to_owned(),
        port,
        "--inserts".to_owned(),
        "-j".to_owned(),
        "1".to_owned(),
        "-f".to_owned(),
        output_path.to_owned(),
    ]);
    args.push(options.database.clone());

    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let mut runner = WasiRunner::new();
    runner
        .with_mount("/host".to_owned(), host_fs)
        .with_current_dir("/")
        .with_args(args)
        .with_envs([
            ("PGUSER", options.username.as_str()),
            ("PGPASSWORD", "password"),
            ("PGSSLMODE", "disable"),
        ])
        .with_stdout(Box::new(CaptureFile::new(Arc::clone(&stdout))))
        .with_stderr(Box::new(CaptureFile::new(Arc::clone(&stderr))));
    {
        let _phase = timing::phase("pg_dump.run_wasm");
        runner
            .run_wasm(
                RuntimeOrEngine::Runtime(Arc::new(wasix_runtime)),
                "pg_dump",
                module,
                ModuleHash::sha256(wasm),
            )
            .map_err(|err| {
                let stderr =
                    String::from_utf8_lossy(&stderr.lock().expect("stderr capture poisoned"))
                        .trim()
                        .to_owned();
                if stderr.is_empty() {
                    anyhow!(err)
                } else {
                    anyhow!("{err}; pg_dump stderr: {stderr}")
                }
            })
            .context("run WASIX pg_dump")?;
    }

    {
        let _phase = timing::phase("pg_dump.read_output");
        match std::fs::read_to_string(fs_root.path().join("out.sql")) {
            Ok(sql) => Ok(sql),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let stdout = stdout.lock().expect("stdout capture poisoned");
                if stdout.is_empty() {
                    Err(err).with_context(|| {
                        format!(
                            "read pg_dump output {}",
                            fs_root.path().join("out.sql").display()
                        )
                    })
                } else {
                    String::from_utf8(stdout.clone()).context("decode pg_dump stdout as UTF-8")
                }
            }
            Err(err) => Err(err).with_context(|| {
                format!(
                    "read pg_dump output {}",
                    fs_root.path().join("out.sql").display()
                )
            }),
        }
    }
}

const DIRECT_PG_DUMP_PORT: u16 = 65_432;
const DIRECT_PG_DUMP_SOCKET_BUFFER: usize = 8 * 1024 * 1024;
const DIRECT_PG_DUMP_LOCAL_PORT: u16 = 65_431;
const DIRECT_PG_DUMP_ADDR: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DIRECT_PG_DUMP_PORT);
const DIRECT_PG_DUMP_LOCAL_ADDR: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DIRECT_PG_DUMP_LOCAL_PORT);

struct DirectPgDumpNetworking {
    socket_tx: Mutex<Option<SyncSender<PgDumpVirtualSocket>>>,
}

impl DirectPgDumpNetworking {
    fn new(socket_tx: SyncSender<PgDumpVirtualSocket>) -> Self {
        Self {
            socket_tx: Mutex::new(Some(socket_tx)),
        }
    }
}

impl fmt::Debug for DirectPgDumpNetworking {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DirectPgDumpNetworking")
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl VirtualNetworking for DirectPgDumpNetworking {
    async fn connect_tcp(
        &self,
        addr: SocketAddr,
        peer: SocketAddr,
    ) -> virtual_net::Result<Box<dyn VirtualTcpSocket + Sync>> {
        if peer != DIRECT_PG_DUMP_ADDR {
            return Err(NetworkError::ConnectionRefused);
        }

        let sender = self
            .socket_tx
            .lock()
            .map_err(|_| NetworkError::IOError)?
            .take()
            .ok_or(NetworkError::ConnectionRefused)?;
        let local = if addr.port() == 0 {
            DIRECT_PG_DUMP_LOCAL_ADDR
        } else {
            addr
        };
        let (guest, host) = TcpSocketHalf::channel(DIRECT_PG_DUMP_SOCKET_BUFFER, local, peer);
        sender
            .send(host)
            .map_err(|_| NetworkError::ConnectionAborted)?;
        Ok(Box::new(DirectPgDumpTcpSocket {
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
struct DirectPgDumpTcpSocket {
    inner: TcpSocketHalf,
    // WASIX probes writability once while completing a blocking connect.
    // `TcpSocketHalf` suppresses an immediate second write-ready poll until a
    // write happens, but libpq polls again before its first StartupMessage.
    // Keep the adapter level-triggered for that connect-to-first-write handoff.
    first_write_ready_probe: bool,
}

impl VirtualIoSource for DirectPgDumpTcpSocket {
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

impl VirtualSocket for DirectPgDumpTcpSocket {
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

impl VirtualConnectedSocket for DirectPgDumpTcpSocket {
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

    fn try_recv(&mut self, buf: &mut [MaybeUninit<u8>], peek: bool) -> virtual_net::Result<usize> {
        self.inner.try_recv(buf, peek)
    }
}

impl VirtualTcpSocket for DirectPgDumpTcpSocket {
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

    fn set_nodelay(&mut self, reuse: bool) -> virtual_net::Result<()> {
        self.inner.set_nodelay(reuse)
    }

    fn nodelay(&self) -> virtual_net::Result<bool> {
        self.inner.nodelay()
    }

    fn set_keepalive(&mut self, keepalive: bool) -> virtual_net::Result<()> {
        self.inner.set_keepalive(keepalive)
    }

    fn keepalive(&self) -> virtual_net::Result<bool> {
        self.inner.keepalive()
    }

    fn set_dontroute(&mut self, keepalive: bool) -> virtual_net::Result<()> {
        self.inner.set_dontroute(keepalive)
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

fn receive_direct_pg_dump_socket(
    socket_rx: &Receiver<PgDumpVirtualSocket>,
    runner: &thread::JoinHandle<Result<String>>,
) -> Result<PgDumpVirtualSocket> {
    let started = Instant::now();
    loop {
        match socket_rx.recv_timeout(Duration::from_millis(5)) {
            Ok(socket) => return Ok(socket),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if runner.is_finished() {
                    bail!("pg_dump exited before opening the direct virtual protocol connection");
                }
                if started.elapsed() > Duration::from_secs(30) {
                    bail!(
                        "timed out waiting for pg_dump to open the direct virtual protocol connection"
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("pg_dump direct virtual networking channel closed before connect")
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

#[cfg(all(test, feature = "extensions"))]
mod tests {
    use super::*;
    use crate::pglite::Pglite;
    use crate::pglite::extensions;
    use crate::pglite::server::PgliteServer;
    use serde_json::json;
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
                err.to_string().contains("conflicts with pglite-oxide"),
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_dump_round_trip_plain_sql() -> Result<()> {
        let server = PgliteServer::temporary_tcp()?;
        let mut conn = sqlx::PgConnection::connect(&server.database_url())
            .await
            .context("connect to PGlite server")?;
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
            let dump = server.dump_sql(PgDumpOptions::default())?;
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
        assert!(dump.contains("INSERT INTO"));

        let (server, schema_only) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.dump_sql(PgDumpOptions::new().arg("--schema-only"))?;
            Ok((server, dump))
        })
        .await
        .context("join schema-only pg_dump task")??;
        assert!(schema_only.contains("CREATE TABLE public.dump_items"));
        assert!(
            !schema_only.contains("INSERT INTO public.dump_items"),
            "schema-only dump unexpectedly contained data:\n{schema_only}"
        );

        let (server, quoted) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.dump_sql(PgDumpOptions::new().arg("--quote-all-identifiers"))?;
            Ok((server, dump))
        })
        .await
        .context("join quoted pg_dump task")??;
        assert!(quoted.contains("CREATE TABLE \"public\".\"dump_items\""));
        assert!(quoted.contains("INSERT INTO \"public\".\"dump_items\""));

        let mut usable = sqlx::PgConnection::connect(&server.database_url())
            .await
            .context("reconnect after pg_dump")?;
        let row = sqlx::query("SELECT count(*)::int4 AS count FROM public.dump_items")
            .fetch_one(&mut usable)
            .await
            .context("server should remain usable after pg_dump")?;
        assert_eq!(row.try_get::<i32, _>("count")?, 2);
        usable.close().await?;

        server.shutdown()?;

        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut restored = Pglite::builder().temporary().open()?;
            restored.exec(&dump, None).context("restore pg_dump SQL")?;
            let result = restored.query(
                "SELECT value FROM public.dump_items WHERE id = $1",
                &[json!(2)],
                None,
            )?;
            let value = result
                .rows
                .first()
                .and_then(|row| row.get("value"))
                .cloned();
            assert_eq!(value, Some(json!("beta")));
            let view = restored.query(
                "SELECT count(*)::int AS count FROM public.dump_item_values",
                &[],
                None,
            )?;
            assert_eq!(view.rows[0]["count"], json!(2));
            let sequence = restored.query(
                "SELECT nextval('public.dump_items_seq')::int AS next_value",
                &[],
                None,
            )?;
            assert_eq!(sequence.rows[0]["next_value"], json!(11));
            restored.close()?;
            Ok(())
        })
        .await
        .context("join restore task")??;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_dump_round_trip_vector_extension() -> Result<()> {
        let server = PgliteServer::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .start()?;
        let mut conn = sqlx::PgConnection::connect(&server.database_url())
            .await
            .context("connect to extension-enabled PGlite server")?;
        conn.execute(
            "CREATE TABLE vector_dump_items(id INTEGER PRIMARY KEY, embedding vector(3));
             INSERT INTO vector_dump_items(id, embedding) VALUES (1, '[1,2,3]');",
        )
        .await
        .context("seed vector pg_dump source data")?;
        drop(conn);

        let (server, dump) = tokio::task::spawn_blocking(move || -> Result<_> {
            let dump = server.dump_sql(PgDumpOptions::default())?;
            Ok((server, dump))
        })
        .await
        .context("join vector pg_dump task")??;
        server.shutdown()?;

        assert!(
            dump.contains("CREATE EXTENSION IF NOT EXISTS vector"),
            "dump did not contain vector extension DDL:\n{dump}"
        );
        assert!(dump.contains("CREATE TABLE public.vector_dump_items"));
        assert!(dump.contains("'[1,2,3]'"));

        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut restored = Pglite::builder()
                .temporary()
                .extension(extensions::VECTOR)
                .open()?;
            restored
                .exec(&dump, None)
                .context("restore vector dump SQL")?;
            let result = restored.query(
                "SELECT embedding <-> '[1,2,4]'::vector AS distance \
                 FROM public.vector_dump_items WHERE id = $1",
                &[json!(1)],
                None,
            )?;
            let distance = result
                .rows
                .first()
                .and_then(|row| row.get("distance"))
                .and_then(|value| value.as_f64());
            assert_eq!(distance, Some(1.0));
            restored.close()?;
            Ok(())
        })
        .await
        .context("join vector restore task")??;
        Ok(())
    }

    #[test]
    fn direct_pg_dump_public_api_round_trip() -> Result<()> {
        let mut db = Pglite::temporary()?;
        db.exec("CREATE TABLE direct_dump_items(value TEXT)", None)?;
        db.exec("INSERT INTO direct_dump_items VALUES ('alpha')", None)?;

        let mismatched_database = db
            .dump_sql(PgDumpOptions::new().database("other_database"))
            .expect_err("direct pg_dump should reject database switching");
        assert!(
            mismatched_database
                .to_string()
                .contains("already-open embedded backend database"),
            "unexpected direct pg_dump database mismatch error: {mismatched_database:#}"
        );

        let dump = db.dump_sql(PgDumpOptions::new())?;
        assert!(dump.contains("CREATE TABLE public.direct_dump_items"));
        assert!(dump.contains("INSERT INTO"));
        let source_still_usable = db.query(
            "SELECT count(*)::int AS count FROM direct_dump_items",
            &[],
            None,
        )?;
        assert_eq!(source_still_usable.rows[0]["count"], json!(1));

        let mut restored = Pglite::temporary()?;
        restored.exec(&dump, None)?;
        let result = restored.query("SELECT value FROM public.direct_dump_items", &[], None)?;
        assert_eq!(result.rows[0]["value"], json!("alpha"));

        restored.close()?;
        db.close()?;
        Ok(())
    }

    #[test]
    fn direct_pg_dump_round_trip_vector_extension() -> Result<()> {
        let mut db = Pglite::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .open()?;
        db.exec(
            "CREATE TABLE direct_vector_dump_items(id INTEGER PRIMARY KEY, embedding vector(3));
             INSERT INTO direct_vector_dump_items(id, embedding) VALUES (1, '[1,2,3]');",
            None,
        )?;

        let dump = db.dump_sql(PgDumpOptions::new())?;
        assert!(dump.contains("CREATE EXTENSION IF NOT EXISTS vector"));
        assert!(dump.contains("CREATE TABLE public.direct_vector_dump_items"));

        let mut restored = Pglite::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .open()?;
        restored.exec(&dump, None)?;
        let result = restored.query(
            "SELECT embedding <-> '[1,2,4]'::vector AS distance \
             FROM public.direct_vector_dump_items WHERE id = $1",
            &[json!(1)],
            None,
        )?;
        assert_eq!(result.rows[0]["distance"], json!(1.0));

        restored.close()?;
        db.close()?;
        Ok(())
    }
}
