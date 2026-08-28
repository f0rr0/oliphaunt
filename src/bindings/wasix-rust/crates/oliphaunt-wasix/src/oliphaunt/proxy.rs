use anyhow::{Context, Result, anyhow, bail};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc::SyncSender,
};

use crate::oliphaunt::backend::BackendSession;
use crate::oliphaunt::base::InstallOutcome;
#[cfg(feature = "extensions")]
use crate::oliphaunt::base::install_missing_extension_archives;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::lifecycle::{TeardownOwnership, teardown_result};
use crate::oliphaunt::postgres_mod::{
    ProtocolPumpOutcome, ProtocolStream, StartupProtocolResponse, startup_error_response_output,
};
use crate::oliphaunt::query::simple_query;
use crate::oliphaunt::wire::{
    FrontendFrameKind, FrontendFrameReader, classify_frontend_message, error_response,
    response_contains_error, startup_config_for_message, startup_parameter,
};

const PROXY_READ_BUFFER_BYTES: usize = 64 * 1024;

/// Blocking PostgreSQL socket proxy for the embedded Oliphaunt runtime.
///
/// The proxy intentionally runs each accepted connection on one blocking thread
/// and does not call into the WASIX backend from an async runtime. That avoids
/// nested runtime panics when an async wrapper blocks inside the embedded engine.
#[derive(Debug, Clone)]
pub(crate) struct OliphauntProxy {
    prepared_database: Arc<InstallOutcome>,
    postgres_config: Arc<PostgresConfig>,
    startup_config: Arc<StartupConfig>,
    backend_teardown_failure: Arc<Mutex<Option<String>>>,
    #[cfg(feature = "extensions")]
    extensions: Arc<Vec<Extension>>,
}

/// The one client socket currently owned by the sequential proxy loop.
///
/// A cloned handle lets [`OliphauntServer`](super::server::OliphauntServer)
/// interrupt a blocking client read during shutdown without adding another
/// worker or changing the single-client execution model.
#[derive(Debug, Default)]
pub(crate) struct ActiveConnection {
    stream: Mutex<Option<ActiveStream>>,
}

#[derive(Debug)]
enum ActiveStream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl ActiveConnection {
    fn register_tcp(self: &Arc<Self>, stream: &TcpStream) -> Result<ActiveConnectionGuard> {
        self.register(ActiveStream::Tcp(
            stream
                .try_clone()
                .context("clone active TCP proxy connection")?,
        ))
    }

    #[cfg(unix)]
    fn register_unix(self: &Arc<Self>, stream: &UnixStream) -> Result<ActiveConnectionGuard> {
        self.register(ActiveStream::Unix(
            stream
                .try_clone()
                .context("clone active Unix proxy connection")?,
        ))
    }

    fn register(self: &Arc<Self>, stream: ActiveStream) -> Result<ActiveConnectionGuard> {
        let mut active = self
            .stream
            .lock()
            .map_err(|_| anyhow!("active proxy connection lock was poisoned"))?;
        if active.is_some() {
            bail!("proxy tried to serve more than one client at a time");
        }
        *active = Some(stream);
        Ok(ActiveConnectionGuard {
            active: Arc::clone(self),
        })
    }

    pub(crate) fn shutdown(&self) {
        let Ok(active) = self.stream.lock() else {
            return;
        };
        match active.as_ref() {
            Some(ActiveStream::Tcp(stream)) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            #[cfg(unix)]
            Some(ActiveStream::Unix(stream)) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            None => {}
        }
    }
}

struct ActiveConnectionGuard {
    active: Arc<ActiveConnection>,
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.stream.lock() {
            active.take();
        }
    }
}

impl OliphauntProxy {
    pub(crate) fn from_prepared_database(outcome: InstallOutcome) -> Self {
        Self {
            prepared_database: Arc::new(outcome),
            postgres_config: Arc::new(PostgresConfig::default()),
            startup_config: Arc::new(StartupConfig::default()),
            backend_teardown_failure: Arc::new(Mutex::new(None)),
            #[cfg(feature = "extensions")]
            extensions: Arc::new(Vec::new()),
        }
    }

    pub(crate) fn with_postgres_config(mut self, postgres_config: PostgresConfig) -> Self {
        self.postgres_config = Arc::new(postgres_config);
        self
    }

    pub(crate) fn with_startup_config(mut self, startup_config: StartupConfig) -> Self {
        self.startup_config = Arc::new(startup_config);
        self
    }

    /// Make selected extension artifacts and required pre-start settings
    /// available to proxy clients.
    #[cfg(feature = "extensions")]
    pub(crate) fn with_extensions(mut self, extensions: Vec<Extension>) -> Self {
        self.extensions = Arc::new(extensions);
        self
    }

    pub(crate) fn serve_tcp_listener_until_ready(
        &self,
        listener: TcpListener,
        shutdown: Arc<AtomicBool>,
        active_connection: Arc<ActiveConnection>,
        ready: Option<SyncSender<Result<()>>>,
    ) -> Result<()> {
        if let Some(ready) = ready {
            let _ = ready.send(Ok(()));
        }
        while !shutdown.load(Ordering::SeqCst) {
            let (stream, _) = listener.accept().context("accept TCP proxy connection")?;
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            let result = (|| {
                stream
                    .set_nonblocking(false)
                    .context("configure TCP proxy stream as blocking")?;
                let _active = active_connection.register_tcp(&stream)?;
                if shutdown.load(Ordering::SeqCst) {
                    active_connection.shutdown();
                    return Ok(());
                }
                self.handle_stream(stream)
            })();
            if let Some(error) = self.connection_teardown_failure(&result) {
                return Err(error);
            }
            if let Err(error) = result {
                tracing::debug!("closing failed TCP proxy connection: {error:#}");
            }
        }

        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn serve_unix_listener_until_ready(
        &self,
        listener: UnixListener,
        shutdown: Arc<AtomicBool>,
        active_connection: Arc<ActiveConnection>,
        ready: Option<SyncSender<Result<()>>>,
    ) -> Result<()> {
        if let Some(ready) = ready {
            let _ = ready.send(Ok(()));
        }
        while !shutdown.load(Ordering::SeqCst) {
            let (stream, _) = listener.accept().context("accept Unix proxy connection")?;
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            let result = (|| {
                stream
                    .set_nonblocking(false)
                    .context("configure Unix proxy stream as blocking")?;
                let _active = active_connection.register_unix(&stream)?;
                if shutdown.load(Ordering::SeqCst) {
                    active_connection.shutdown();
                    return Ok(());
                }
                self.handle_stream(stream)
            })();
            if let Some(error) = self.connection_teardown_failure(&result) {
                return Err(error);
            }
            if let Err(error) = result {
                tracing::debug!("closing failed Unix proxy connection: {error:#}");
            }
        }

        Ok(())
    }

    fn handle_stream<S>(&self, mut stream: S) -> Result<()>
    where
        S: CloneProtocolStream,
    {
        let mut backend = None::<WireBackend>;
        let mut reader = FrontendFrameReader::default();
        let mut buffer = [0u8; PROXY_READ_BUFFER_BYTES];
        let mut protocol_batch = Vec::new();

        loop {
            let read = stream.read(&mut buffer).context("read frontend socket")?;
            if read == 0 {
                flush_protocol_batch_if_started(
                    &mut protocol_batch,
                    backend.as_mut(),
                    &mut stream,
                )?;
                break;
            }
            let mut close_after_flush = false;
            let messages = reader.push(&buffer[..read])?;
            let message_count = messages.len();
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
                            WireBackend::open(
                                &self.prepared_database,
                                &self.postgres_config,
                                &connection_startup_config,
                                self.extensions(),
                                Arc::clone(&self.backend_teardown_failure),
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
                        let response = opened.startup(message)?;
                        let response_accepted =
                            response.accepted && !response_contains_error(&response.output);
                        if response_accepted
                            && let Some(user) = startup_parameter(message, "user")?
                            && user != "postgres"
                        {
                            let role_response = opened.set_role(user)?;
                            if response_contains_error(&role_response) {
                                let _ = write_frontend(
                                    &mut stream,
                                    &role_response,
                                    "write startup role rejection",
                                )?;
                                let _ = opened.close();
                                close_after_flush = true;
                                break;
                            }
                        }
                        {
                            if !write_frontend(
                                &mut stream,
                                &response.output,
                                "write startup response",
                            )? {
                                let _ = opened.close();
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
                            let _ = opened.close();
                            close_after_flush = true;
                        }
                    }
                    FrontendFrameKind::Protocol => {
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
                                    opened.close()?;
                                }
                                return Ok(());
                            }
                        }
                    }
                }
                message_index += 1;
            }
            {
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
            if let Some(mut backend) = backend {
                backend.close()?;
            }
        }
        Ok(())
    }

    fn connection_teardown_failure(&self, primary: &Result<()>) -> Option<anyhow::Error> {
        compose_connection_teardown_failure(&self.backend_teardown_failure, primary)
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

fn compose_connection_teardown_failure(
    teardown_failure: &Mutex<Option<String>>,
    primary: &Result<()>,
) -> Option<anyhow::Error> {
    let teardown = teardown_failure
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()?;
    Some(match primary {
        Ok(()) => anyhow!("WASIX proxy backend teardown failed: {teardown}"),
        Err(primary) => anyhow!(
            "WASIX proxy connection failed: {primary:#}; backend teardown also failed: {teardown}"
        ),
    })
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

struct WireBackend {
    session: TeardownOwnership<BackendSession>,
    teardown_failure: Arc<Mutex<Option<String>>>,
    connection_started: bool,
    closed: bool,
}

impl WireBackend {
    #[cfg(feature = "extensions")]
    fn open(
        prepared_database: &InstallOutcome,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        extensions: &[Extension],
        teardown_failure: Arc<Mutex<Option<String>>>,
    ) -> Result<Self> {
        {
            install_missing_extension_archives(prepared_database, extensions)?;
        }
        Self::open_prepared(
            prepared_database,
            postgres_config,
            startup_config,
            extensions,
            teardown_failure,
        )
    }

    #[cfg(feature = "extensions")]
    fn open_prepared(
        outcome: &InstallOutcome,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        extensions: &[Extension],
        teardown_failure: Arc<Mutex<Option<String>>>,
    ) -> Result<Self> {
        let session = BackendSession::open_with_extension_preload(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
            extensions,
        )?;
        Ok(Self {
            session: TeardownOwnership::new(session),
            teardown_failure,
            connection_started: false,
            closed: false,
        })
    }

    #[cfg(not(feature = "extensions"))]
    fn open(
        prepared_database: &InstallOutcome,
        postgres_config: &PostgresConfig,
        startup_config: &StartupConfig,
        _extensions: &[()],
        teardown_failure: Arc<Mutex<Option<String>>>,
    ) -> Result<Self> {
        let session = BackendSession::open(
            prepared_database.clone(),
            postgres_config.clone(),
            startup_config.clone(),
        )?;
        Ok(Self {
            session: TeardownOwnership::new(session),
            teardown_failure,
            connection_started: false,
            closed: false,
        })
    }

    fn startup(&mut self, message: &[u8]) -> Result<StartupProtocolResponse> {
        let response = self.session.startup_with_packet(message)?;
        self.connection_started = response.accepted && !response_contains_error(&response.output);
        Ok(response)
    }

    fn send(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        self.session.send_buffered(message)
    }

    fn supports_protocol_pump(&self) -> bool {
        self.session.supports_protocol_pump()
    }

    fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        self.session.attach_protocol_stream(stream)
    }

    fn send_with_protocol_pump(
        &mut self,
        message: &[u8],
        continuation_prefix: ContinuationPrefix<'_>,
    ) -> Result<ProtocolPumpOutcome> {
        self.session
            .send_with_connection_protocol_pump(message, || continuation_prefix.into_vec())
    }

    fn set_role(&mut self, user: &str) -> Result<Vec<u8>> {
        let sql = format!("SET ROLE {}", crate::oliphaunt::sql::quote_identifier(user));
        self.send(&simple_query(&sql)?)
    }

    fn reset_session_state(&mut self) -> Result<()> {
        for sql in ["ROLLBACK", "DISCARD ALL"] {
            let response = self.send(&simple_query(sql)?)?;
            if response.first() == Some(&b'E') {
                bail!("reset proxy backend session state failed while running {sql}");
            }
        }
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let reset = if self.connection_started {
            teardown_result("WASIX proxy session reset", || self.reset_session_state())
        } else {
            Ok(())
        };
        let shutdown = teardown_result("WASIX proxy backend", || {
            self.session.shutdown()?;
            self.session.release();
            Ok(())
        });
        if let Err(shutdown) = shutdown {
            let mut retained = self
                .teardown_failure
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if retained.is_none() {
                *retained = Some(format!("shutdown proxy backend: {shutdown}"));
            }
        }
        // The listener reads the independent shutdown-failure latch after
        // every handler return. Returning only the reset failure here keeps it
        // primary without duplicating the same shutdown text during composition.
        reset.map_err(|error| anyhow!("reset proxy session state: {error}"))
    }
}

impl Drop for WireBackend {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            tracing::warn!(
                "WASIX proxy backend teardown failed; retaining the backend until process exit: {error:#}"
            );
        }
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

    let outcome = backend.send_with_protocol_pump(protocol_batch, continuation_prefix)?;
    protocol_batch.clear();
    match outcome {
        ProtocolPumpOutcome::Buffered(response) => {
            write_backend_response(stream, &response)?;
            Ok(FlushOutcome::Continue)
        }
        ProtocolPumpOutcome::Streamed => Ok(FlushOutcome::Streamed),
    }
}

fn write_backend_response<S>(stream: &mut S, response: &[u8]) -> Result<()>
where
    S: Write,
{
    if !response.is_empty() {
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
            backend_open_error_response(&anyhow!("runtime failed while opening database storage"));
        assert!(runtime.windows(7).any(|window| window == b"CXX000\0"));
        assert!(
            !runtime.windows(7).any(|window| window == b"C3D000\0"),
            "runtime failures must not be reported as missing databases"
        );
    }

    #[test]
    fn backend_shutdown_latch_is_terminal_and_preserves_primary_error_order() {
        let teardown = Mutex::new(Some("shutdown proxy backend: injected shutdown".to_owned()));
        let primary = Err(anyhow!("injected connection read failure"));
        let combined = compose_connection_teardown_failure(&teardown, &primary)
            .expect("latched shutdown failure makes the listener terminal")
            .to_string();

        assert_eq!(
            combined.matches("injected connection read failure").count(),
            1
        );
        assert_eq!(combined.matches("injected shutdown").count(), 1);
        assert!(
            combined.find("injected connection read failure") < combined.find("injected shutdown")
        );

        let teardown_only = compose_connection_teardown_failure(&teardown, &Ok(()))
            .expect("shutdown failure is terminal without a connection error")
            .to_string();
        assert_eq!(teardown_only.matches("injected shutdown").count(), 1);
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
