use anyhow::{Context, Result, anyhow, bail, ensure};
use std::io::{Read, Write};
use std::net::{TcpListener, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::SyncSender,
};

#[cfg(feature = "extensions")]
use crate::pglite::base::install_missing_extension_archives;
use crate::pglite::base::{InstallOutcome, install_into};
#[cfg(feature = "extensions")]
use crate::pglite::extensions::{Extension, create_extension_sql};
use crate::pglite::postgres_mod::{PostgresMod, StartupProtocolResponse};
use crate::pglite::timing;
use crate::pglite::transport::Transport;

const SSL_REQUEST_CODE: i32 = 80_877_103;
const GSSENC_REQUEST_CODE: i32 = 80_877_104;
const CANCEL_REQUEST_CODE: i32 = 80_877_102;
const PROTOCOL_3: i32 = 196_608;
const MAX_FRONTEND_MESSAGE: usize = 64 * 1024 * 1024;

/// Blocking PostgreSQL socket proxy for the embedded PGlite runtime.
///
/// The proxy intentionally runs each accepted connection on one blocking thread
/// and does not call into the WASIX backend from an async runtime. That avoids
/// nested runtime panics when an async wrapper blocks inside the embedded engine.
#[derive(Debug, Clone)]
pub struct PgliteProxy {
    root: Arc<PathBuf>,
    prepared_root: Option<Arc<InstallOutcome>>,
    #[cfg(feature = "extensions")]
    extensions: Arc<Vec<Extension>>,
}

impl PgliteProxy {
    /// Create a proxy that stores the PGlite runtime and cluster under `root`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Arc::new(root.into()),
            prepared_root: None,
            #[cfg(feature = "extensions")]
            extensions: Arc::new(Vec::new()),
        }
    }

    pub(crate) fn with_prepared_root(mut self, outcome: InstallOutcome) -> Self {
        self.prepared_root = Some(Arc::new(outcome));
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
        S: Read + Write,
    {
        let _phase = timing::phase("proxy.handle_stream");
        let mut backend = None;
        let mut reader = FrontendMessageReader::default();
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

            let mut close_after_flush = false;
            let messages = {
                let _phase = timing::phase("proxy.frontend_parse");
                reader.push(&buffer[..read])?
            };
            for message in messages {
                match classify_frontend_message(&message)? {
                    FrontendMessageKind::SslOrGssRequest => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        {
                            let _phase = timing::phase("proxy.startup_response_write");
                            stream.write_all(b"N").context("write SSL refusal")?;
                        }
                    }
                    FrontendMessageKind::CancelRequest => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        close_after_flush = true;
                    }
                    FrontendMessageKind::Terminate => {
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        close_after_flush = true;
                    }
                    FrontendMessageKind::Startup => {
                        if backend.is_some() {
                            bail!("received a second startup packet on one proxy connection");
                        }
                        flush_protocol_batch_if_started(
                            &mut protocol_batch,
                            backend.as_mut(),
                            &mut stream,
                        )?;
                        if let Some(response) = validate_startup_identity(&message)? {
                            stream
                                .write_all(&response)
                                .context("write startup rejection")?;
                            close_after_flush = true;
                            continue;
                        }
                        let mut opened = {
                            let _phase = timing::phase("proxy.backend_open");
                            WireBackend::open(
                                &self.root,
                                self.prepared_root.as_deref(),
                                self.extensions(),
                            )?
                        };
                        let response = {
                            let _phase = timing::phase("proxy.startup_response_backend");
                            opened.startup(&message)?
                        };
                        if response.accepted && !response_contains_error(&response.output) {
                            #[cfg(feature = "extensions")]
                            {
                                // Use the serving backend for idempotent extension setup; a separate
                                // setup backend adds a full Postgres startup and can force WAL recovery.
                                let _phase = timing::phase("proxy.startup_extension_setup");
                                opened.enable_extensions(self.extensions())?;
                            }
                        }
                        {
                            let _phase = timing::phase("proxy.startup_response_write");
                            stream
                                .write_all(&response.output)
                                .context("write startup response")?;
                        }
                        if response.accepted && !response_contains_error(&response.output) {
                            backend = Some(opened);
                        } else {
                            close_after_flush = true;
                        }
                    }
                    FrontendMessageKind::Protocol => {
                        let flush_after = should_flush_protocol_batch(&message);
                        protocol_batch.extend_from_slice(&message);
                        if flush_after {
                            let backend = backend.as_mut().ok_or_else(|| {
                                anyhow!("frontend protocol message arrived before startup")
                            })?;
                            flush_protocol_batch(&mut protocol_batch, backend, &mut stream)?;
                        }
                    }
                }
            }
            {
                let _phase = timing::phase("proxy.stream_flush");
                stream.flush().context("flush frontend socket")?;
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

struct WireBackend {
    pg: PostgresMod,
    transport: Transport,
    #[cfg(feature = "extensions")]
    preinstalled_extensions: Vec<String>,
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

    fn open_postgres_with(
        outcome: &InstallOutcome,
        configure: impl FnOnce(&mut PostgresMod) -> Result<()>,
    ) -> Result<(PostgresMod, Transport)> {
        let mut pg = {
            let _phase = timing::phase("proxy.backend_postgres_new");
            PostgresMod::new_prepared(outcome.paths.clone(), outcome.runtime_layout.clone())?
        };
        configure(&mut pg)?;
        {
            let _phase = timing::phase("proxy.backend_ensure_cluster");
            pg.ensure_cluster()?;
        }
        let transport = {
            let _phase = timing::phase("proxy.transport_prepare");
            Transport::prepare(&mut pg)?
        };
        Ok((pg, transport))
    }

    #[cfg(feature = "extensions")]
    fn open(
        root: &Path,
        prepared_root: Option<&InstallOutcome>,
        extensions: &[Extension],
    ) -> Result<Self> {
        let outcome = Self::installed_outcome(root, prepared_root)?;
        {
            let _phase = timing::phase("proxy.extension_install");
            install_missing_extension_archives(&outcome, extensions)?;
        }
        Self::open_prepared(&outcome, extensions)
    }

    #[cfg(feature = "extensions")]
    fn open_prepared(outcome: &InstallOutcome, extensions: &[Extension]) -> Result<Self> {
        let (pg, transport) = Self::open_postgres_with(outcome, |pg| {
            for extension in extensions {
                let _phase = timing::phase("proxy.extension_preload");
                pg.preload_extension_module(*extension)?;
            }
            Ok(())
        })?;
        Ok(Self {
            pg,
            transport,
            preinstalled_extensions: outcome.preinstalled_extensions.clone(),
        })
    }

    #[cfg(not(feature = "extensions"))]
    fn open(
        root: &Path,
        prepared_root: Option<&InstallOutcome>,
        _extensions: &[()],
    ) -> Result<Self> {
        let outcome = Self::installed_outcome(root, prepared_root)?;
        let (pg, transport) = Self::open_postgres_with(&outcome, |_| Ok(()))?;
        Ok(Self { pg, transport })
    }

    fn startup(&mut self, message: &[u8]) -> Result<StartupProtocolResponse> {
        self.pg.start_protocol_with_startup_packet(message)
    }

    #[cfg(feature = "extensions")]
    fn enable_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        for extension in extensions {
            if self
                .preinstalled_extensions
                .iter()
                .any(|sql_name| sql_name == extension.sql_name())
            {
                continue;
            }
            let sql = create_extension_sql(*extension);
            let response = {
                let _phase = timing::phase("proxy.extension_enable");
                self.send(&simple_query_message(&sql)).with_context(|| {
                    format!("enable bundled extension '{}'", extension.sql_name())
                })?
            };
            if response.first() == Some(&b'E') {
                bail!(
                    "enable bundled extension '{}' returned a Postgres error",
                    extension.sql_name()
                );
            }
        }
        Ok(())
    }

    fn send(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        let _phase = timing::phase("proxy.backend_send");
        self.transport.send(&mut self.pg, message, None)
    }

    fn reject_copy_from_stdin(&mut self) -> Result<Vec<u8>> {
        self.send(&simple_query_message(
            "DO $$ BEGIN RAISE EXCEPTION USING \
             ERRCODE = '0A000', \
             MESSAGE = 'COPY FROM STDIN requires streaming protocol support and is not supported by pglite-oxide server mode yet'; \
             END $$",
        ))
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
        let _ = self.pg.shutdown_backend();
    }
}

#[derive(Default)]
struct FrontendMessageReader {
    buffer: Vec<u8>,
}

impl FrontendMessageReader {
    fn push(&mut self, input: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.buffer.extend_from_slice(input);
        let mut messages = Vec::new();

        loop {
            let Some(message_len) = frontend_message_len(&self.buffer)? else {
                break;
            };
            let message = self.buffer.drain(..message_len).collect();
            messages.push(message);
        }

        Ok(messages)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrontendMessageKind {
    Protocol,
    Startup,
    SslOrGssRequest,
    CancelRequest,
    Terminate,
}

fn frontend_message_len(buffer: &[u8]) -> Result<Option<usize>> {
    if buffer.len() < 4 {
        return Ok(None);
    }

    if buffer[0] == 0 {
        let len = i32::from_be_bytes(buffer[0..4].try_into().unwrap());
        if len < 8 {
            bail!("invalid startup packet length {len}");
        }
        let len = len as usize;
        if len > MAX_FRONTEND_MESSAGE {
            bail!("startup packet length {len} exceeds limit");
        }
        return Ok((buffer.len() >= len).then_some(len));
    }

    if buffer.len() < 5 {
        return Ok(None);
    }
    let len = i32::from_be_bytes(buffer[1..5].try_into().unwrap());
    if len < 4 {
        bail!("invalid frontend message length {len}");
    }
    let total = 1usize
        .checked_add(len as usize)
        .ok_or_else(|| anyhow!("frontend message length overflow"))?;
    if total > MAX_FRONTEND_MESSAGE {
        bail!("frontend message length {total} exceeds limit");
    }
    Ok((buffer.len() >= total).then_some(total))
}

fn classify_frontend_message(message: &[u8]) -> Result<FrontendMessageKind> {
    if message.is_empty() {
        bail!("empty frontend message");
    }

    if message[0] == 0 {
        if message.len() < 8 {
            bail!("startup/control packet is too short");
        }
        let code = i32::from_be_bytes(message[4..8].try_into().unwrap());
        return Ok(match code {
            SSL_REQUEST_CODE | GSSENC_REQUEST_CODE => FrontendMessageKind::SslOrGssRequest,
            CANCEL_REQUEST_CODE => FrontendMessageKind::CancelRequest,
            PROTOCOL_3 => FrontendMessageKind::Startup,
            other => bail!("unsupported startup/control packet code {other}"),
        });
    }

    if message[0] == b'X' {
        return Ok(FrontendMessageKind::Terminate);
    }

    Ok(FrontendMessageKind::Protocol)
}

fn should_flush_protocol_batch(message: &[u8]) -> bool {
    matches!(message.first(), Some(b'Q' | b'S' | b'H'))
}

fn validate_startup_identity(message: &[u8]) -> Result<Option<Vec<u8>>> {
    ensure!(message.len() >= 8, "startup packet is too short");
    let code = i32::from_be_bytes(message[4..8].try_into().unwrap());
    ensure!(code == PROTOCOL_3, "startup packet is not protocol 3");

    let mut user = None;
    let mut database = None;
    let mut cursor = 8usize;
    while cursor < message.len() {
        if message[cursor] == 0 {
            break;
        }
        let key_end = message[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| anyhow!("startup parameter key is not nul-terminated"))?;
        let key = std::str::from_utf8(&message[cursor..key_end])
            .context("startup parameter key is not UTF-8")?;
        cursor = key_end + 1;

        let value_end = message[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| anyhow!("startup parameter value is not nul-terminated"))?;
        let value = std::str::from_utf8(&message[cursor..value_end])
            .context("startup parameter value is not UTF-8")?;
        cursor = value_end + 1;

        match key {
            "user" => user = Some(value),
            "database" => database = Some(value),
            _ => {}
        }
    }

    if user != Some("postgres") {
        return Ok(Some(startup_error_response(
            "28000",
            "pglite-oxide server mode only accepts user \"postgres\"",
        )));
    }

    if database.unwrap_or("template1") != "template1" {
        return Ok(Some(startup_error_response(
            "3D000",
            "pglite-oxide server mode only accepts database \"template1\"",
        )));
    }

    Ok(None)
}

fn startup_error_response(sqlstate: &str, message: &str) -> Vec<u8> {
    let mut body = Vec::new();
    push_error_field(&mut body, b'S', "FATAL");
    push_error_field(&mut body, b'V', "FATAL");
    push_error_field(&mut body, b'C', sqlstate);
    push_error_field(&mut body, b'M', message);
    body.push(0);

    let mut response = Vec::with_capacity(body.len() + 5);
    response.push(b'E');
    response.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    response.extend_from_slice(&body);
    response
}

fn push_error_field(out: &mut Vec<u8>, field: u8, value: &str) {
    out.push(field);
    out.extend_from_slice(value.as_bytes());
    out.push(0);
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
    flush_protocol_batch(protocol_batch, backend, stream)
}

fn flush_protocol_batch<S>(
    protocol_batch: &mut Vec<u8>,
    backend: &mut WireBackend,
    stream: &mut S,
) -> Result<()>
where
    S: Write,
{
    if protocol_batch.is_empty() {
        return Ok(());
    }

    let response = {
        let _phase = timing::phase("proxy.protocol_batch");
        if simple_query_contains_copy_from_stdin(protocol_batch) {
            backend.reject_copy_from_stdin()?
        } else {
            backend.send(protocol_batch)?
        }
    };
    protocol_batch.clear();
    if !response.is_empty() {
        let _phase = timing::phase("proxy.response_write");
        stream
            .write_all(&response)
            .context("write backend response")?;
    }

    Ok(())
}

fn is_simple_query_message(message: &[u8]) -> bool {
    message.first() == Some(&b'Q')
}

fn simple_query_contains_copy_from_stdin(message: &[u8]) -> bool {
    let Some(sql) = simple_query_sql(message) else {
        return false;
    };
    sql_contains_copy_from_stdin(sql)
}

fn simple_query_sql(message: &[u8]) -> Option<&str> {
    if !is_simple_query_message(message) || message.len() < 6 {
        return None;
    }
    let len = i32::from_be_bytes(message[1..5].try_into().ok()?);
    if len < 5 {
        return None;
    }
    let len = len as usize;
    if len.checked_add(1)? != message.len() || *message.last()? != 0 {
        return None;
    }
    std::str::from_utf8(&message[5..message.len() - 1]).ok()
}

fn sql_contains_copy_from_stdin(sql: &str) -> bool {
    let mut in_copy_statement = false;
    let mut saw_from = false;

    for token in sql_word_tokens(sql) {
        if token == ";" {
            in_copy_statement = false;
            saw_from = false;
            continue;
        }
        if !in_copy_statement {
            in_copy_statement = token == "COPY";
            saw_from = false;
            continue;
        }
        if saw_from && token == "STDIN" {
            return true;
        }
        saw_from = token == "FROM";
    }

    false
}

fn sql_word_tokens(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\'' => cursor = skip_single_quoted(bytes, cursor),
            b'"' => cursor = skip_double_quoted(bytes, cursor),
            b'-' if bytes.get(cursor + 1) == Some(&b'-') => {
                cursor = skip_line_comment(bytes, cursor + 2);
            }
            b'/' if bytes.get(cursor + 1) == Some(&b'*') => {
                cursor = skip_block_comment(bytes, cursor + 2);
            }
            b'$' => {
                if let Some(next) = skip_dollar_quoted(bytes, cursor) {
                    cursor = next;
                } else {
                    cursor += 1;
                }
            }
            b';' => {
                tokens.push(";".to_owned());
                cursor += 1;
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = cursor;
                cursor += 1;
                while cursor < bytes.len()
                    && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
                {
                    cursor += 1;
                }
                tokens.push(sql[start..cursor].to_ascii_uppercase());
            }
            _ => cursor += 1,
        }
    }

    tokens
}

fn skip_single_quoted(bytes: &[u8], mut cursor: usize) -> usize {
    cursor += 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\'' {
            cursor += 1;
            if bytes.get(cursor) == Some(&b'\'') {
                cursor += 1;
                continue;
            }
            break;
        }
        cursor += 1;
    }
    cursor
}

fn skip_double_quoted(bytes: &[u8], mut cursor: usize) -> usize {
    cursor += 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' {
            cursor += 1;
            if bytes.get(cursor) == Some(&b'"') {
                cursor += 1;
                continue;
            }
            break;
        }
        cursor += 1;
    }
    cursor
}

fn skip_line_comment(bytes: &[u8], mut cursor: usize) -> usize {
    while cursor < bytes.len() && bytes[cursor] != b'\n' {
        cursor += 1;
    }
    cursor
}

fn skip_block_comment(bytes: &[u8], mut cursor: usize) -> usize {
    while cursor + 1 < bytes.len() {
        if bytes[cursor] == b'*' && bytes[cursor + 1] == b'/' {
            return cursor + 2;
        }
        cursor += 1;
    }
    bytes.len()
}

fn skip_dollar_quoted(bytes: &[u8], cursor: usize) -> Option<usize> {
    let mut end = cursor + 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    if bytes.get(end) != Some(&b'$') {
        return None;
    }
    let delimiter = &bytes[cursor..=end];
    let body_start = end + 1;
    bytes[body_start..]
        .windows(delimiter.len())
        .position(|window| window == delimiter)
        .map(|offset| body_start + offset + delimiter.len())
}

fn response_contains_error(response: &[u8]) -> bool {
    let mut cursor = 0usize;
    while cursor + 5 <= response.len() {
        let tag = response[cursor];
        let len = i32::from_be_bytes(response[cursor + 1..cursor + 5].try_into().unwrap());
        if len < 4 {
            return false;
        }
        let total = 1usize.saturating_add(len as usize);
        if cursor + total > response.len() {
            return false;
        }
        if tag == b'E' {
            return true;
        }
        cursor += total;
    }
    false
}

fn simple_query_message(sql: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(sql.len() + 6);
    message.push(b'Q');
    message.extend_from_slice(&((sql.len() + 5) as i32).to_be_bytes());
    message.extend_from_slice(sql.as_bytes());
    message.push(0);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_reader_buffers_split_messages() -> Result<()> {
        let query = b"Q\0\0\0\rSELECT 1\0";
        let mut reader = FrontendMessageReader::default();
        assert!(reader.push(&query[..3])?.is_empty());
        let messages = reader.push(&query[3..])?;
        assert_eq!(messages, vec![query.to_vec()]);
        Ok(())
    }

    #[test]
    fn frontend_reader_splits_batched_messages() -> Result<()> {
        let mut batch = Vec::new();
        batch.extend_from_slice(b"Q\0\0\0\rSELECT 1\0");
        batch.extend_from_slice(b"X\0\0\0\x04");

        let mut reader = FrontendMessageReader::default();
        let messages = reader.push(&batch)?;
        assert_eq!(messages.len(), 2);
        assert_eq!(
            classify_frontend_message(&messages[0])?,
            FrontendMessageKind::Protocol
        );
        assert_eq!(
            classify_frontend_message(&messages[1])?,
            FrontendMessageKind::Terminate
        );
        Ok(())
    }

    #[test]
    fn classify_ssl_request() -> Result<()> {
        let mut message = Vec::new();
        message.extend_from_slice(&8_i32.to_be_bytes());
        message.extend_from_slice(&SSL_REQUEST_CODE.to_be_bytes());
        assert_eq!(
            classify_frontend_message(&message)?,
            FrontendMessageKind::SslOrGssRequest
        );
        Ok(())
    }

    #[test]
    fn classify_startup_request() -> Result<()> {
        let mut message = Vec::new();
        message.extend_from_slice(&8_i32.to_be_bytes());
        message.extend_from_slice(&PROTOCOL_3.to_be_bytes());
        assert_eq!(
            classify_frontend_message(&message)?,
            FrontendMessageKind::Startup
        );
        Ok(())
    }

    #[test]
    fn protocol_batch_flushes_on_client_boundaries() {
        assert!(should_flush_protocol_batch(b"Q\0\0\0\rSELECT 1\0"));
        assert!(should_flush_protocol_batch(b"S\0\0\0\x04"));
        assert!(should_flush_protocol_batch(b"H\0\0\0\x04"));
        assert!(!should_flush_protocol_batch(b"P\0\0\0\x04"));
        assert!(!should_flush_protocol_batch(b"B\0\0\0\x04"));
        assert!(!should_flush_protocol_batch(b"D\0\0\0\x04"));
        assert!(!should_flush_protocol_batch(b"E\0\0\0\x04"));
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
    fn copy_from_stdin_detection_ignores_literals_comments_and_quoted_identifiers() {
        assert!(sql_contains_copy_from_stdin(
            "CREATE TABLE items(value text); COPY items(value) FROM STDIN WITH CSV"
        ));
        assert!(sql_contains_copy_from_stdin(
            "/* comment */ copy public.items from stdin"
        ));
        assert!(!sql_contains_copy_from_stdin(
            "SELECT 'COPY items FROM STDIN' AS text"
        ));
        assert!(!sql_contains_copy_from_stdin(
            "SELECT $$ COPY items FROM STDIN $$ AS text"
        ));
        assert!(!sql_contains_copy_from_stdin("COPY items TO STDOUT"));
        assert!(!sql_contains_copy_from_stdin(
            "COPY items FROM '/tmp/input.csv'"
        ));
        assert!(!sql_contains_copy_from_stdin(
            "SELECT \"copy\" FROM stdin_table"
        ));
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
