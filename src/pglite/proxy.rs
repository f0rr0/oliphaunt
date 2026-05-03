use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::SyncSender,
};

use crate::pglite::backend::{BackendOpenKind, BackendSession};
#[cfg(feature = "extensions")]
use crate::pglite::base::install_missing_extension_archives;
use crate::pglite::base::{InstallOutcome, install_into};
use crate::pglite::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::pglite::extensions::Extension;
use crate::pglite::postgres_mod::{
    ProtocolPumpOutcome, ProtocolStream, StartupProtocolResponse, startup_error_response_output,
};
use crate::pglite::timing;
use crate::pglite::wire::{
    FrontendFrameKind, FrontendFrameReader, classify_frontend_message, error_response,
    response_contains_error, simple_query_message, startup_config_for_message, startup_parameter,
};

static PROTOCOL_STATS: ProtocolStats = ProtocolStats::new();

#[doc(hidden)]
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolStatsSnapshot {
    pub frontend_reads: u64,
    pub frontend_bytes: u64,
    pub frontend_messages: u64,
    pub startup_messages: u64,
    pub protocol_messages: u64,
    pub simple_query_messages: u64,
    pub parse_messages: u64,
    pub bind_messages: u64,
    pub execute_messages: u64,
    pub sync_messages: u64,
    pub flush_messages: u64,
    pub copy_data_messages: u64,
    pub protocol_batches: u64,
    pub protocol_batch_bytes: u64,
    pub backend_send_calls: u64,
    pub backend_send_bytes: u64,
    pub response_writes: u64,
    pub response_bytes: u64,
    pub socket_flushes: u64,
    pub copy_guard_rejections: u64,
    pub streaming_copy_handoffs: u64,
}

struct ProtocolStats {
    enabled: AtomicBool,
    frontend_reads: AtomicU64,
    frontend_bytes: AtomicU64,
    frontend_messages: AtomicU64,
    startup_messages: AtomicU64,
    protocol_messages: AtomicU64,
    simple_query_messages: AtomicU64,
    parse_messages: AtomicU64,
    bind_messages: AtomicU64,
    execute_messages: AtomicU64,
    sync_messages: AtomicU64,
    flush_messages: AtomicU64,
    copy_data_messages: AtomicU64,
    protocol_batches: AtomicU64,
    protocol_batch_bytes: AtomicU64,
    backend_send_calls: AtomicU64,
    backend_send_bytes: AtomicU64,
    response_writes: AtomicU64,
    response_bytes: AtomicU64,
    socket_flushes: AtomicU64,
    copy_guard_rejections: AtomicU64,
    streaming_copy_handoffs: AtomicU64,
}

impl ProtocolStats {
    const fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            frontend_reads: AtomicU64::new(0),
            frontend_bytes: AtomicU64::new(0),
            frontend_messages: AtomicU64::new(0),
            startup_messages: AtomicU64::new(0),
            protocol_messages: AtomicU64::new(0),
            simple_query_messages: AtomicU64::new(0),
            parse_messages: AtomicU64::new(0),
            bind_messages: AtomicU64::new(0),
            execute_messages: AtomicU64::new(0),
            sync_messages: AtomicU64::new(0),
            flush_messages: AtomicU64::new(0),
            copy_data_messages: AtomicU64::new(0),
            protocol_batches: AtomicU64::new(0),
            protocol_batch_bytes: AtomicU64::new(0),
            backend_send_calls: AtomicU64::new(0),
            backend_send_bytes: AtomicU64::new(0),
            response_writes: AtomicU64::new(0),
            response_bytes: AtomicU64::new(0),
            socket_flushes: AtomicU64::new(0),
            copy_guard_rejections: AtomicU64::new(0),
            streaming_copy_handoffs: AtomicU64::new(0),
        }
    }

    fn reset(&self) {
        self.enabled.store(true, Ordering::Relaxed);
        self.frontend_reads.store(0, Ordering::Relaxed);
        self.frontend_bytes.store(0, Ordering::Relaxed);
        self.frontend_messages.store(0, Ordering::Relaxed);
        self.startup_messages.store(0, Ordering::Relaxed);
        self.protocol_messages.store(0, Ordering::Relaxed);
        self.simple_query_messages.store(0, Ordering::Relaxed);
        self.parse_messages.store(0, Ordering::Relaxed);
        self.bind_messages.store(0, Ordering::Relaxed);
        self.execute_messages.store(0, Ordering::Relaxed);
        self.sync_messages.store(0, Ordering::Relaxed);
        self.flush_messages.store(0, Ordering::Relaxed);
        self.copy_data_messages.store(0, Ordering::Relaxed);
        self.protocol_batches.store(0, Ordering::Relaxed);
        self.protocol_batch_bytes.store(0, Ordering::Relaxed);
        self.backend_send_calls.store(0, Ordering::Relaxed);
        self.backend_send_bytes.store(0, Ordering::Relaxed);
        self.response_writes.store(0, Ordering::Relaxed);
        self.response_bytes.store(0, Ordering::Relaxed);
        self.socket_flushes.store(0, Ordering::Relaxed);
        self.copy_guard_rejections.store(0, Ordering::Relaxed);
        self.streaming_copy_handoffs.store(0, Ordering::Relaxed);
    }

    fn snapshot(&self) -> ProtocolStatsSnapshot {
        ProtocolStatsSnapshot {
            frontend_reads: self.frontend_reads.load(Ordering::Relaxed),
            frontend_bytes: self.frontend_bytes.load(Ordering::Relaxed),
            frontend_messages: self.frontend_messages.load(Ordering::Relaxed),
            startup_messages: self.startup_messages.load(Ordering::Relaxed),
            protocol_messages: self.protocol_messages.load(Ordering::Relaxed),
            simple_query_messages: self.simple_query_messages.load(Ordering::Relaxed),
            parse_messages: self.parse_messages.load(Ordering::Relaxed),
            bind_messages: self.bind_messages.load(Ordering::Relaxed),
            execute_messages: self.execute_messages.load(Ordering::Relaxed),
            sync_messages: self.sync_messages.load(Ordering::Relaxed),
            flush_messages: self.flush_messages.load(Ordering::Relaxed),
            copy_data_messages: self.copy_data_messages.load(Ordering::Relaxed),
            protocol_batches: self.protocol_batches.load(Ordering::Relaxed),
            protocol_batch_bytes: self.protocol_batch_bytes.load(Ordering::Relaxed),
            backend_send_calls: self.backend_send_calls.load(Ordering::Relaxed),
            backend_send_bytes: self.backend_send_bytes.load(Ordering::Relaxed),
            response_writes: self.response_writes.load(Ordering::Relaxed),
            response_bytes: self.response_bytes.load(Ordering::Relaxed),
            socket_flushes: self.socket_flushes.load(Ordering::Relaxed),
            copy_guard_rejections: self.copy_guard_rejections.load(Ordering::Relaxed),
            streaming_copy_handoffs: self.streaming_copy_handoffs.load(Ordering::Relaxed),
        }
    }

    fn add(counter: &AtomicU64, value: u64) {
        if PROTOCOL_STATS.enabled.load(Ordering::Relaxed) {
            counter.fetch_add(value, Ordering::Relaxed);
        }
    }
}

#[doc(hidden)]
pub fn reset_protocol_stats() {
    PROTOCOL_STATS.reset();
}

#[doc(hidden)]
pub fn disable_protocol_stats() {
    PROTOCOL_STATS.enabled.store(false, Ordering::Relaxed);
}

#[doc(hidden)]
pub fn protocol_stats_snapshot() -> ProtocolStatsSnapshot {
    PROTOCOL_STATS.snapshot()
}

/// Blocking PostgreSQL socket proxy for the embedded PGlite runtime.
///
/// The proxy intentionally runs each accepted connection on one blocking thread
/// and does not call into the WASIX backend from an async runtime. That avoids
/// nested runtime panics when an async wrapper blocks inside the embedded engine.
#[derive(Debug, Clone)]
pub struct PgliteProxy {
    root: Arc<PathBuf>,
    prepared_root: Option<Arc<InstallOutcome>>,
    postgres_config: Arc<PostgresConfig>,
    startup_config: Arc<StartupConfig>,
    #[cfg(feature = "extensions")]
    extensions: Arc<Vec<Extension>>,
}

impl PgliteProxy {
    /// Create a proxy that stores the PGlite runtime and cluster under `root`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Arc::new(root.into()),
            prepared_root: None,
            postgres_config: Arc::new(PostgresConfig::default()),
            startup_config: Arc::new(StartupConfig::default()),
            #[cfg(feature = "extensions")]
            extensions: Arc::new(Vec::new()),
        }
    }

    pub(crate) fn with_prepared_root(mut self, outcome: InstallOutcome) -> Self {
        self.prepared_root = Some(Arc::new(outcome));
        self
    }

    pub(crate) fn with_postgres_config(mut self, postgres_config: PostgresConfig) -> Self {
        self.postgres_config = Arc::new(postgres_config);
        self
    }

    pub(crate) fn with_startup_config(mut self, startup_config: StartupConfig) -> Self {
        self.startup_config = Arc::new(startup_config);
        self
    }

    /// Enable bundled extensions in the proxy backend before accepting clients.
    #[cfg(feature = "extensions")]
    pub(crate) fn with_extensions(mut self, extensions: Vec<Extension>) -> Self {
        self.extensions = Arc::new(extensions);
        self
    }

    /// Return the root directory used for runtime installation and cluster data.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Serve a TCP listener forever. Connections are handled one at a time.
    pub fn serve_tcp<A>(&self, addr: A) -> Result<()>
    where
        A: ToSocketAddrs,
    {
        let listener = TcpListener::bind(addr).context("bind TCP proxy listener")?;
        self.serve_tcp_listener(listener)
    }

    /// Serve an existing TCP listener forever. Connections are handled one at a time.
    pub fn serve_tcp_listener(&self, listener: TcpListener) -> Result<()> {
        for stream in listener.incoming() {
            let stream = stream.context("accept TCP proxy connection")?;
            self.handle_stream(stream)?;
        }
        Ok(())
    }

    pub(crate) fn serve_tcp_listener_until_ready(
        &self,
        listener: TcpListener,
        shutdown: Arc<AtomicBool>,
        ready: Option<SyncSender<Result<()>>>,
    ) -> Result<()> {
        if let Some(ready) = ready {
            let _ = ready.send(Ok(()));
        }
        while !shutdown.load(Ordering::SeqCst) {
            let (stream, _) = {
                let _phase = timing::phase("proxy.accept_wait");
                listener.accept().context("accept TCP proxy connection")?
            };
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            stream
                .set_nonblocking(false)
                .context("configure TCP proxy stream as blocking")?;
            self.handle_stream(stream)?;
        }

        Ok(())
    }

    /// Accept and handle one TCP connection. Intended for tests and supervised embedding.
    pub fn accept_tcp_once(&self, listener: &TcpListener) -> Result<()> {
        self.accept_tcp_connections(listener, 1)
    }

    /// Accept and handle `count` TCP connections using one embedded backend.
    pub fn accept_tcp_connections(&self, listener: &TcpListener, count: usize) -> Result<()> {
        for _ in 0..count {
            let (stream, _) = listener.accept().context("accept TCP proxy connection")?;
            self.handle_stream(stream)?;
        }
        Ok(())
    }

    /// Serve a Unix-domain socket forever. Connections are handled one at a time.
    #[cfg(unix)]
    pub fn serve_unix(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        if path.exists() {
            std::fs::remove_file(path)
                .with_context(|| format!("remove stale socket {}", path.display()))?;
        }
        let listener = UnixListener::bind(path)
            .with_context(|| format!("bind Unix proxy socket {}", path.display()))?;
        self.serve_unix_listener(listener)
    }

    /// Serve an existing Unix-domain listener forever. Connections are handled one at a time.
    #[cfg(unix)]
    pub fn serve_unix_listener(&self, listener: UnixListener) -> Result<()> {
        for stream in listener.incoming() {
            let stream = stream.context("accept Unix proxy connection")?;
            self.handle_stream(stream)?;
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn serve_unix_listener_until_ready(
        &self,
        listener: UnixListener,
        shutdown: Arc<AtomicBool>,
        ready: Option<SyncSender<Result<()>>>,
    ) -> Result<()> {
        if let Some(ready) = ready {
            let _ = ready.send(Ok(()));
        }
        while !shutdown.load(Ordering::SeqCst) {
            let (stream, _) = {
                let _phase = timing::phase("proxy.accept_wait");
                listener.accept().context("accept Unix proxy connection")?
            };
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            stream
                .set_nonblocking(false)
                .context("configure Unix proxy stream as blocking")?;
            self.handle_stream(stream)?;
        }

        Ok(())
    }

    /// Accept and handle one Unix-domain socket connection.
    #[cfg(unix)]
    pub fn accept_unix_once(&self, listener: &UnixListener) -> Result<()> {
        self.accept_unix_connections(listener, 1)
    }

    /// Accept and handle `count` Unix-domain socket connections using one embedded backend.
    #[cfg(unix)]
    pub fn accept_unix_connections(&self, listener: &UnixListener, count: usize) -> Result<()> {
        for _ in 0..count {
            let (stream, _) = listener.accept().context("accept Unix proxy connection")?;
            self.handle_stream(stream)?;
        }
        Ok(())
    }

    fn handle_stream<S>(&self, mut stream: S) -> Result<()>
    where
        S: CloneProtocolStream,
    {
        let _phase = timing::phase("proxy.handle_stream");
        let mut backend = None::<WireBackend>;
        let mut reader = FrontendFrameReader::default();
        let mut buffer = [0u8; 64 * 1024];
        let mut protocol_batch = Vec::new();

        loop {
            let read = {
                let _phase = timing::phase("proxy.stream_read");
                stream.read(&mut buffer).context("read frontend socket")?
            };
            if read == 0 {
                flush_protocol_batch_if_started(
                    &mut protocol_batch,
                    backend.as_mut(),
                    &mut stream,
                )?;
                break;
            }
            ProtocolStats::add(&PROTOCOL_STATS.frontend_reads, 1);
            ProtocolStats::add(&PROTOCOL_STATS.frontend_bytes, read as u64);

            let mut close_after_flush = false;
            let messages = {
                let _phase = timing::phase("proxy.frontend_parse");
                reader.push(&buffer[..read])?
            };
            let message_count = messages.len();
            ProtocolStats::add(&PROTOCOL_STATS.frontend_messages, message_count as u64);
            let mut message_index = 0usize;
            while message_index < message_count {
                let message = &messages[message_index];
                match classify_frontend_message(message)? {
                    FrontendFrameKind::SslOrGssRequest => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        {
                            let _phase = timing::phase("proxy.startup_response_write");
                            if !write_frontend(&mut stream, b"N", "write SSL refusal")? {
                                close_after_flush = true;
                            }
                        }
                    }
                    FrontendFrameKind::CancelRequest => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        close_after_flush = true;
                    }
                    FrontendFrameKind::Terminate => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        close_after_flush = true;
                    }
                    FrontendFrameKind::Startup => {
                        ProtocolStats::add(&PROTOCOL_STATS.startup_messages, 1);
                        if backend.is_some() {
                            bail!("received a second startup packet on one proxy connection");
                        }
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        let connection_startup_config =
                            startup_config_for_message(&self.startup_config, message)?;
                        let opened_result = {
                            let _phase = timing::phase("proxy.backend_open");
                            WireBackend::open(
                                &self.root,
                                self.prepared_root.as_deref(),
                                &self.postgres_config,
                                &connection_startup_config,
                                self.extensions(),
                            )
                        };
                        let mut opened = match opened_result {
                            Ok(opened) => opened,
                            Err(err) => {
                                let response = startup_error_response_output(&err)
                                    .map_or_else(|| backend_open_error_response(&err), Vec::from);
                                let _ = write_frontend(
                                    &mut stream,
                                    &response,
                                    "write startup backend-open failure",
                                )?;
                                close_after_flush = true;
                                break;
                            }
                        };
                        let response = {
                            let _phase = timing::phase("proxy.startup_response_backend");
                            opened.startup(message)?
                        };
                        let response_accepted =
                            response.accepted && !response_contains_error(&response.output);
                        if response_accepted {
                            #[cfg(feature = "extensions")]
                            {
                                // Use the serving backend for idempotent extension setup; a separate
                                // setup backend adds a full Postgres startup and can force WAL recovery.
                                let _phase = timing::phase("proxy.startup_extension_setup");
                                opened.enable_extensions(self.extensions())?;
                            }
                            if let Some(user) = startup_parameter(message, "user")?
                                && user != "postgres"
                            {
                                let role_response = opened.set_role(user)?;
                                if response_contains_error(&role_response) {
                                    let _ = write_frontend(
                                        &mut stream,
                                        &role_response,
                                        "write startup role rejection",
                                    )?;
                                    opened.close();
                                    close_after_flush = true;
                                    break;
                                }
                            }
                        }
                        {
                            let _phase = timing::phase("proxy.startup_response_write");
                            if !write_frontend(
                                &mut stream,
                                &response.output,
                                "write startup response",
                            )? {
                                opened.close();
                                close_after_flush = true;
                                break;
                            }
                        }
                        if response_accepted {
                            if opened.supports_protocol_pump() {
                                opened.attach_protocol_stream(
                                    stream
                                        .try_clone_for_protocol()
                                        .context("clone frontend socket for protocol pump")?,
                                )?;
                            }
                            backend = Some(opened);
                        } else {
                            opened.close();
                            close_after_flush = true;
                        }
                    }
                    FrontendFrameKind::Protocol => {
                        record_protocol_message(message);
                        let is_last_message_in_read = message_index + 1 == message_count;
                        let flush_after =
                            should_flush_protocol_batch(message, is_last_message_in_read);
                        protocol_batch.extend_from_slice(message);
                        if flush_after {
                            let streamed = {
                                let backend = backend.as_mut().ok_or_else(|| {
                                    anyhow!("frontend protocol message arrived before startup")
                                })?;
                                let continuation = ContinuationPrefix::from_reader(
                                    &messages,
                                    message_index + 1,
                                    &reader,
                                );
                                flush_protocol_batch(
                                    &mut protocol_batch,
                                    backend,
                                    &mut stream,
                                    continuation,
                                )? == FlushOutcome::Streamed
                            };
                            if streamed {
                                if let Some(mut opened) = backend.take() {
                                    opened.close();
                                }
                                return Ok(());
                            }
                        }
                    }
                }
                message_index += 1;
            }
            {
                let _phase = timing::phase("proxy.stream_flush");
                ProtocolStats::add(&PROTOCOL_STATS.socket_flushes, 1);
                if let Err(err) = stream.flush().context("flush frontend socket") {
                    if close_after_flush
                        && err
                            .downcast_ref::<io::Error>()
                            .is_some_and(is_connection_closed_error)
                    {
                        break;
                    }
                    return Err(err);
                }
            }
            if close_after_flush {
                break;
            }
        }

        {
            let _phase = timing::phase("proxy.connection_cleanup");
            if let Some(mut backend) = backend {
                backend.rollback_connection_state();
                backend.close();
            }
        }
        Ok(())
    }

    #[cfg(feature = "extensions")]
    fn extensions(&self) -> &[Extension] {
        self.extensions.as_slice()
    }

    #[cfg(not(feature = "extensions"))]
    fn extensions(&self) -> &[()] {
        &[]
    }
}

trait ProtocolReadiness {
    fn read_ready(&mut self) -> io::Result<bool>;
}

impl ProtocolReadiness for TcpStream {
    fn read_ready(&mut self) -> io::Result<bool> {
        socket_read_ready(self, TcpStream::peek)
    }
}

#[cfg(unix)]
impl ProtocolReadiness for UnixStream {
    fn read_ready(&mut self) -> io::Result<bool> {
        Ok(true)
    }
}

impl ProtocolStream for TcpStream {
    fn read_ready(&mut self) -> io::Result<bool> {
        ProtocolReadiness::read_ready(self)
    }
}

trait CloneProtocolStream: Read + Write + Send + ProtocolStream + Sized + 'static {
    fn try_clone_for_protocol(&self) -> io::Result<Self>;
}

impl CloneProtocolStream for TcpStream {
    fn try_clone_for_protocol(&self) -> io::Result<Self> {
        self.try_clone()
    }
}

fn socket_read_ready<S>(
    stream: &mut S,
    peek: impl FnOnce(&S, &mut [u8]) -> io::Result<usize>,
) -> io::Result<bool>
where
    S: SetNonblocking,
{
    stream.set_nonblocking(true)?;
    let mut byte = [0u8; 1];
    let result = match peek(stream, &mut byte) {
        Ok(read) => Ok(read > 0),
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(false),
        Err(err) => Err(err),
    };
    let restore = stream.set_nonblocking(false);
    match (result, restore) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(err), _) => Err(err),
        (Ok(_), Err(err)) => Err(err),
    }
}

trait SetNonblocking {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()>;
}

impl SetNonblocking for TcpStream {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        TcpStream::set_nonblocking(self, nonblocking)
    }
}

#[cfg(unix)]
impl SetNonblocking for UnixStream {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        UnixStream::set_nonblocking(self, nonblocking)
    }
}

#[cfg(unix)]
impl ProtocolStream for UnixStream {
    fn read_ready(&mut self) -> io::Result<bool> {
        ProtocolReadiness::read_ready(self)
    }
}

#[cfg(unix)]
impl CloneProtocolStream for UnixStream {
    fn try_clone_for_protocol(&self) -> io::Result<Self> {
        self.try_clone()
    }
}

struct ContinuationPrefix<'a> {
    messages: &'a [Vec<u8>],
    first_unhandled_message: usize,
    pending: &'a [u8],
}

impl<'a> ContinuationPrefix<'a> {
    fn empty() -> Self {
        Self {
            messages: &[],
            first_unhandled_message: 0,
            pending: &[],
        }
    }

    fn from_reader(
        messages: &'a [Vec<u8>],
        first_unhandled_message: usize,
        reader: &'a FrontendFrameReader,
    ) -> Self {
        Self {
            messages,
            first_unhandled_message,
            pending: reader.pending(),
        }
    }

    fn into_vec(self) -> Vec<u8> {
        let len = self
            .messages
            .iter()
            .skip(self.first_unhandled_message)
            .map(Vec::len)
            .sum::<usize>()
            + self.pending.len();
        if len == 0 {
            return Vec::new();
        }
        let mut prefix = Vec::with_capacity(len);
        for message in self.messages.iter().skip(self.first_unhandled_message) {
            prefix.extend_from_slice(message);
        }
        prefix.extend_from_slice(self.pending);
        prefix
    }
}

fn record_protocol_message(message: &[u8]) {
    ProtocolStats::add(&PROTOCOL_STATS.protocol_messages, 1);
    match message.first() {
        Some(b'Q') => ProtocolStats::add(&PROTOCOL_STATS.simple_query_messages, 1),
        Some(b'P') => ProtocolStats::add(&PROTOCOL_STATS.parse_messages, 1),
        Some(b'B') => ProtocolStats::add(&PROTOCOL_STATS.bind_messages, 1),
        Some(b'E') => ProtocolStats::add(&PROTOCOL_STATS.execute_messages, 1),
        Some(b'S') => ProtocolStats::add(&PROTOCOL_STATS.sync_messages, 1),
        Some(b'H') => ProtocolStats::add(&PROTOCOL_STATS.flush_messages, 1),
        Some(b'd' | b'c' | b'f') => ProtocolStats::add(&PROTOCOL_STATS.copy_data_messages, 1),
        _ => {}
    }
}

struct WireBackend {
    session: BackendSession,
}

impl WireBackend {
    fn installed_outcome(
        root: &Path,
        prepared_root: Option<&InstallOutcome>,
    ) -> Result<InstallOutcome> {
        let _phase = timing::phase("proxy.backend_install");
        match prepared_root {
            Some(outcome) => Ok(outcome.clone()),
            None => install_into(root),
        }
    }

    #[cfg(feature = "extensions")]
    fn open(
        root: &Path,
        prepared_root: Option<&InstallOutcome>,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        let outcome = Self::installed_outcome(root, prepared_root)?;
        {
            let _phase = timing::phase("proxy.extension_install");
            install_missing_extension_archives(&outcome, extensions)?;
        }
        Self::open_prepared(&outcome, postgres_config, startup_config, extensions)
    }

    #[cfg(feature = "extensions")]
    fn open_prepared(
        outcome: &InstallOutcome,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        let session = BackendSession::open_with_extension_preload(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
            BackendOpenKind::Proxy,
            extensions,
        )?;
        Ok(Self { session })
    }

    #[cfg(not(feature = "extensions"))]
    fn open(
        root: &Path,
        prepared_root: Option<&InstallOutcome>,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        _extensions: &[()],
    ) -> Result<Self> {
        let outcome = Self::installed_outcome(root, prepared_root)?;
        let session = BackendSession::open(
            outcome,
            postgres_config.clone(),
            startup_config.clone(),
            BackendOpenKind::Proxy,
        )?;
        Ok(Self { session })
    }

    fn startup(&mut self, message: &[u8]) -> Result<StartupProtocolResponse> {
        self.session.startup_with_packet(message)
    }

    #[cfg(feature = "extensions")]
    fn enable_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        let _phase = timing::phase("proxy.extension_enable");
        self.session.enable_extensions(extensions)
    }

    fn send(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        let _phase = timing::phase("proxy.backend_send");
        ProtocolStats::add(&PROTOCOL_STATS.backend_send_calls, 1);
        ProtocolStats::add(&PROTOCOL_STATS.backend_send_bytes, message.len() as u64);
        self.session.send_buffered(message, None)
    }

    fn supports_protocol_pump(&self) -> bool {
        self.session.supports_protocol_pump()
    }

    fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        let _phase = timing::phase("proxy.backend_attach_protocol_stream");
        self.session.attach_protocol_stream(stream)
    }

    fn send_with_protocol_pump(
        &mut self,
        message: &[u8],
        continuation_prefix: ContinuationPrefix<'_>,
    ) -> Result<ProtocolPumpOutcome> {
        let _phase = timing::phase("proxy.backend_send");
        ProtocolStats::add(&PROTOCOL_STATS.backend_send_calls, 1);
        ProtocolStats::add(&PROTOCOL_STATS.backend_send_bytes, message.len() as u64);
        self.session
            .send_with_protocol_pump(message, || continuation_prefix.into_vec())
    }

    fn set_role(&mut self, user: &str) -> Result<Vec<u8>> {
        let sql = format!(
            "SET ROLE {}",
            crate::pglite::templating::quote_identifier(user)
        );
        self.send(&simple_query_message(&sql))
    }

    fn rollback_connection_state(&mut self) {
        let _ = self.reset_session_state();
    }

    fn reset_session_state(&mut self) -> Result<()> {
        let _phase = timing::phase("proxy.reset_session_state");
        for sql in ["ROLLBACK", "DISCARD ALL"] {
            let response = self.send(&simple_query_message(sql))?;
            if response.first() == Some(&b'E') {
                bail!("reset proxy backend session state failed while running {sql}");
            }
        }
        Ok(())
    }

    fn close(&mut self) {
        let _phase = timing::phase("proxy.backend_shutdown");
        let _ = self.session.shutdown();
    }
}

fn should_flush_protocol_batch(message: &[u8], is_last_message_in_read: bool) -> bool {
    match message.first() {
        // Simple query and explicit Flush are client-visible boundaries. Keep
        // them immediate so COPY guards and flush semantics stay obvious.
        Some(b'Q' | b'H') => true,
        // COPY frames belong to PostgreSQL's COPY subprotocol. Keep them as
        // immediate flush boundaries so the backend-owned protocol pump can
        // hand over to streaming at the exact CopyInResponse/CopyOutResponse
        // boundary and protocol mistakes fail close to source.
        Some(b'd' | b'c' | b'f') => true,
        // Sync is also a protocol boundary, but pipelined extended-query
        // clients often put several Bind/Execute/Sync groups into one socket
        // read. Batching only those bytes already read avoids extra WASIX host
        // crossings without waiting for future network input.
        Some(b'S') => is_last_message_in_read,
        _ => false,
    }
}

fn backend_open_error_response(err: &anyhow::Error) -> Vec<u8> {
    let error = format!("{err:#}");
    error_response(
        "FATAL",
        "XX000",
        &format!("could not start embedded Postgres backend: {error}"),
    )
}

fn is_connection_closed_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::UnexpectedEof
    )
}

fn write_frontend<S>(stream: &mut S, bytes: &[u8], context: &'static str) -> Result<bool>
where
    S: Write,
{
    match stream.write_all(bytes) {
        Ok(()) => Ok(true),
        Err(err) if is_connection_closed_error(&err) => Ok(false),
        Err(err) => Err(err).context(context),
    }
}

fn flush_protocol_batch_if_started<S>(
    protocol_batch: &mut Vec<u8>,
    backend: Option<&mut WireBackend>,
    stream: &mut S,
) -> Result<()>
where
    S: Write,
{
    if protocol_batch.is_empty() {
        return Ok(());
    }
    let backend =
        backend.ok_or_else(|| anyhow!("frontend protocol message arrived before startup"))?;
    match flush_protocol_batch(protocol_batch, backend, stream, ContinuationPrefix::empty())? {
        FlushOutcome::Continue => Ok(()),
        FlushOutcome::Streamed => {
            bail!("protocol stream was consumed while flushing control packet")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushOutcome {
    Continue,
    Streamed,
}

fn flush_protocol_batch<S>(
    protocol_batch: &mut Vec<u8>,
    backend: &mut WireBackend,
    stream: &mut S,
    continuation_prefix: ContinuationPrefix<'_>,
) -> Result<FlushOutcome>
where
    S: Write,
{
    if protocol_batch.is_empty() {
        return Ok(FlushOutcome::Continue);
    }

    let outcome = {
        let _phase = timing::phase("proxy.protocol_batch");
        ProtocolStats::add(&PROTOCOL_STATS.protocol_batches, 1);
        ProtocolStats::add(
            &PROTOCOL_STATS.protocol_batch_bytes,
            protocol_batch.len() as u64,
        );
        backend.send_with_protocol_pump(protocol_batch, continuation_prefix)?
    };
    protocol_batch.clear();
    match outcome {
        ProtocolPumpOutcome::Buffered(response) => {
            write_backend_response(stream, &response)?;
            Ok(FlushOutcome::Continue)
        }
        ProtocolPumpOutcome::Streamed => {
            ProtocolStats::add(&PROTOCOL_STATS.streaming_copy_handoffs, 1);
            Ok(FlushOutcome::Streamed)
        }
    }
}

fn write_backend_response<S>(stream: &mut S, response: &[u8]) -> Result<()>
where
    S: Write,
{
    if !response.is_empty() {
        let _phase = timing::phase("proxy.response_write");
        ProtocolStats::add(&PROTOCOL_STATS.response_writes, 1);
        ProtocolStats::add(&PROTOCOL_STATS.response_bytes, response.len() as u64);
        stream
            .write_all(response)
            .context("write backend response")?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_batch_flushes_on_client_boundaries() {
        assert!(should_flush_protocol_batch(b"Q\0\0\0\rSELECT 1\0", false));
        assert!(should_flush_protocol_batch(b"Q\0\0\0\rSELECT 1\0", true));
        assert!(!should_flush_protocol_batch(b"S\0\0\0\x04", false));
        assert!(should_flush_protocol_batch(b"S\0\0\0\x04", true));
        assert!(should_flush_protocol_batch(b"H\0\0\0\x04", false));
        assert!(should_flush_protocol_batch(b"H\0\0\0\x04", true));
        assert!(!should_flush_protocol_batch(b"P\0\0\0\x04", true));
        assert!(!should_flush_protocol_batch(b"B\0\0\0\x04", true));
        assert!(!should_flush_protocol_batch(b"D\0\0\0\x04", true));
        assert!(!should_flush_protocol_batch(b"E\0\0\0\x04", true));
    }

    #[test]
    fn response_error_detection_scans_backend_messages() {
        let mut response = Vec::new();
        push_parameter_status(&mut response, "TimeZone", "UTC");
        response.push(b'E');
        response.extend_from_slice(&6_i32.to_be_bytes());
        response.extend_from_slice(b"S\0");
        push_ready_for_query(&mut response, b'I');

        assert!(response_contains_error(&response));
        assert!(!response_contains_error(&backend_ready_response()));
    }

    #[test]
    fn backend_open_error_fallback_never_guesses_postgres_sqlstate() {
        let missing_text =
            backend_open_error_response(&anyhow!("database \"app_db\" does not exist"));
        assert!(missing_text.windows(7).any(|window| window == b"CXX000\0"));
        assert!(!missing_text.windows(7).any(|window| window == b"C3D000\0"));

        let missing_sqlstate =
            backend_open_error_response(&anyhow!("Postgres startup failed with 3D000"));
        assert!(
            missing_sqlstate
                .windows(7)
                .any(|window| window == b"CXX000\0")
        );
        assert!(
            !missing_sqlstate
                .windows(7)
                .any(|window| window == b"C3D000\0")
        );

        let runtime =
            backend_open_error_response(&anyhow!("runtime failed while opening database root"));
        assert!(runtime.windows(7).any(|window| window == b"CXX000\0"));
        assert!(
            !runtime.windows(7).any(|window| window == b"C3D000\0"),
            "runtime failures must not be reported as missing databases"
        );
    }

    fn backend_ready_response() -> Vec<u8> {
        let mut response = Vec::new();
        push_parameter_status(&mut response, "TimeZone", "UTC");
        push_ready_for_query(&mut response, b'I');
        response
    }

    fn push_parameter_status(out: &mut Vec<u8>, key: &str, value: &str) {
        out.push(b'S');
        let len = 4 + key.len() + 1 + value.len() + 1;
        out.extend_from_slice(&(len as i32).to_be_bytes());
        out.extend_from_slice(key.as_bytes());
        out.push(0);
        out.extend_from_slice(value.as_bytes());
        out.push(0);
    }

    fn push_ready_for_query(out: &mut Vec<u8>, status: u8) {
        out.push(b'Z');
        out.extend_from_slice(&5_i32.to_be_bytes());
        out.push(status);
    }
}
