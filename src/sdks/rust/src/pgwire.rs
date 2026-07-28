use std::io::{self, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};

const PROTOCOL_VERSION_3: i32 = 196_608;
const CANCEL_REQUEST_CODE: i32 = 80_877_102;
const POSTGRES_WIRE_READ_BUFFER: usize = 64 * 1024;
const DUPLEX_RAW_REQUEST_THRESHOLD: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BackendKeyData {
    process_id: i32,
    secret_key: i32,
}

trait PostgresStream: Read + Write + Send {
    fn try_clone_stream(&self) -> io::Result<Box<dyn PostgresStream>>;
    fn set_stream_timeouts(
        &self,
        read_timeout: Option<Duration>,
        write_timeout: Option<Duration>,
    ) -> io::Result<()>;
}

impl PostgresStream for TcpStream {
    fn try_clone_stream(&self) -> io::Result<Box<dyn PostgresStream>> {
        self.try_clone()
            .map(|stream| Box::new(stream) as Box<dyn PostgresStream>)
    }

    fn set_stream_timeouts(
        &self,
        read_timeout: Option<Duration>,
        write_timeout: Option<Duration>,
    ) -> io::Result<()> {
        self.set_read_timeout(read_timeout)?;
        self.set_write_timeout(write_timeout)
    }
}

#[cfg(unix)]
impl PostgresStream for UnixStream {
    fn try_clone_stream(&self) -> io::Result<Box<dyn PostgresStream>> {
        self.try_clone()
            .map(|stream| Box::new(stream) as Box<dyn PostgresStream>)
    }

    fn set_stream_timeouts(
        &self,
        read_timeout: Option<Duration>,
        write_timeout: Option<Duration>,
    ) -> io::Result<()> {
        self.set_read_timeout(read_timeout)?;
        self.set_write_timeout(write_timeout)
    }
}

pub(crate) struct PostgresWireClient {
    stream: BufReader<Box<dyn PostgresStream>>,
    endpoint: PostgresEndpoint,
    backend_key: BackendKeyData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PostgresCancelToken {
    endpoint: PostgresEndpoint,
    backend_key: BackendKeyData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PostgresEndpoint {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

impl PostgresCancelToken {
    pub(crate) fn cancel(&self, connect_timeout: Duration, io_timeout: Duration) -> Result<()> {
        send_cancel_request(
            &self.endpoint,
            self.backend_key,
            connect_timeout,
            io_timeout,
        )
    }
}

impl PostgresWireClient {
    pub(crate) fn connect_endpoint(
        endpoint: PostgresEndpoint,
        user: &str,
        database: &str,
        connect_timeout: Duration,
        io_timeout: Duration,
    ) -> Result<Self> {
        let mut stream = BufReader::with_capacity(
            POSTGRES_WIRE_READ_BUFFER,
            connect_stream(&endpoint, connect_timeout, io_timeout)?,
        );
        write_startup_message(stream.get_mut().as_mut(), user, database)?;
        let mut backend_key = None;
        read_until_ready(&mut stream, false, true, Some(&mut backend_key))?;
        stream
            .get_ref()
            .as_ref()
            .set_stream_timeouts(None, None)
            .map_err(|err| {
                Error::Engine(format!(
                    "clear steady-state native server protocol socket timeouts: {err}"
                ))
            })?;
        let backend_key = backend_key.ok_or_else(|| {
            Error::Engine("native server did not return BackendKeyData during startup".to_owned())
        })?;
        Ok(Self {
            stream,
            endpoint,
            backend_key,
        })
    }

    pub(crate) fn exec_protocol_raw(
        &mut self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        if request.as_bytes().len() >= DUPLEX_RAW_REQUEST_THRESHOLD {
            return self.exec_protocol_raw_duplex(request);
        }
        self.exec_protocol_raw_sequential(request)
    }

    fn exec_protocol_raw_sequential(
        &mut self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        write_protocol_request(self.stream.get_mut().as_mut(), request.as_bytes())?;
        let bytes = read_until_ready(&mut self.stream, true, false, None)?;
        Ok(ProtocolResponse::new(bytes))
    }

    fn exec_protocol_raw_duplex(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        if !self.stream.buffer().is_empty() {
            return self.exec_protocol_raw_sequential(request);
        }
        let reader_stream = self
            .stream
            .get_ref()
            .as_ref()
            .try_clone_stream()
            .map_err(|err| Error::Engine(format!("clone native server protocol stream: {err}")))?;
        let reader = thread::Builder::new()
            .name("liboliphaunt-native-server-reader".to_owned())
            .spawn(move || {
                let mut reader = BufReader::with_capacity(POSTGRES_WIRE_READ_BUFFER, reader_stream);
                read_until_ready(&mut reader, true, false, None)
            })
            .map_err(|err| Error::Engine(format!("spawn native server protocol reader: {err}")))?;

        let write_result =
            write_protocol_request(self.stream.get_mut().as_mut(), request.as_bytes());
        let read_result = reader
            .join()
            .map_err(|_| Error::Engine("native server protocol reader panicked".to_owned()))?;

        write_result?;
        let bytes = read_result?;
        Ok(ProtocolResponse::new(bytes))
    }

    pub(crate) fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        mut on_chunk: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        write_protocol_request(self.stream.get_mut().as_mut(), request.as_bytes())?;
        read_until_ready_stream(&mut self.stream, false, &mut on_chunk)
    }

    pub(crate) fn terminate(&mut self) -> Result<()> {
        let stream = self.stream.get_mut();
        stream
            .write_all(&[b'X', 0, 0, 0, 4])
            .and_then(|()| stream.flush())
            .map_err(|err| Error::Engine(format!("terminate native server connection: {err}")))
    }

    pub(crate) fn cancel_token(&self) -> PostgresCancelToken {
        PostgresCancelToken {
            endpoint: self.endpoint.clone(),
            backend_key: self.backend_key,
        }
    }
}

fn write_protocol_request(stream: &mut dyn Write, bytes: &[u8]) -> Result<()> {
    stream
        .write_all(bytes)
        .and_then(|()| stream.flush())
        .map_err(|err| Error::Engine(format!("write native server protocol request: {err}")))
}

fn connect_stream(
    endpoint: &PostgresEndpoint,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Result<Box<dyn PostgresStream>> {
    match endpoint {
        PostgresEndpoint::Tcp(addr) => {
            let stream = connect_tcp_stream(*addr, connect_timeout, io_timeout)?;
            Ok(Box::new(stream))
        }
        #[cfg(unix)]
        PostgresEndpoint::Unix(path) => {
            let stream = UnixStream::connect(path).map_err(|err| {
                Error::Engine(format!(
                    "connect to native server socket {}: {err}",
                    path.display()
                ))
            })?;
            stream.set_read_timeout(Some(io_timeout)).map_err(|err| {
                Error::Engine(format!(
                    "set native server socket read timeout {}: {err}",
                    path.display()
                ))
            })?;
            stream.set_write_timeout(Some(io_timeout)).map_err(|err| {
                Error::Engine(format!(
                    "set native server socket write timeout {}: {err}",
                    path.display()
                ))
            })?;
            Ok(Box::new(stream))
        }
    }
}

fn connect_tcp_stream(
    addr: SocketAddr,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&addr, connect_timeout)
        .map_err(|err| Error::Engine(format!("connect to native server {addr}: {err}")))?;
    stream
        .set_nodelay(true)
        .map_err(|err| Error::Engine(format!("set TCP_NODELAY on native server: {err}")))?;
    stream
        .set_read_timeout(Some(io_timeout))
        .map_err(|err| Error::Engine(format!("set native server read timeout: {err}")))?;
    stream
        .set_write_timeout(Some(io_timeout))
        .map_err(|err| Error::Engine(format!("set native server write timeout: {err}")))?;
    Ok(stream)
}

fn write_startup_message(stream: &mut dyn Write, user: &str, database: &str) -> Result<()> {
    let mut body = Vec::new();
    body.extend_from_slice(&PROTOCOL_VERSION_3.to_be_bytes());
    push_cstr(&mut body, "user");
    push_cstr(&mut body, user);
    push_cstr(&mut body, "database");
    push_cstr(&mut body, database);
    body.push(0);

    let total_len = i32::try_from(body.len() + 4)
        .map_err(|_| Error::Engine("startup message is too large".to_owned()))?;
    let mut packet = Vec::with_capacity(body.len() + 4);
    packet.extend_from_slice(&total_len.to_be_bytes());
    packet.extend_from_slice(&body);
    stream
        .write_all(&packet)
        .map_err(|err| Error::Engine(format!("write native server startup message: {err}")))
}

fn push_cstr(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn read_until_ready(
    stream: &mut dyn Read,
    include_messages: bool,
    error_is_fatal: bool,
    backend_key: Option<&mut Option<BackendKeyData>>,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    read_until_ready_stream_with_key(
        stream,
        error_is_fatal,
        &mut |frame| {
            if include_messages {
                out.extend_from_slice(frame);
            }
            Ok(())
        },
        backend_key,
    )?;
    Ok(out)
}

fn read_until_ready_stream(
    stream: &mut dyn Read,
    error_is_fatal: bool,
    on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    read_until_ready_stream_with_key(stream, error_is_fatal, on_chunk, None)
}

fn read_until_ready_stream_with_key(
    stream: &mut dyn Read,
    error_is_fatal: bool,
    on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    mut backend_key: Option<&mut Option<BackendKeyData>>,
) -> Result<()> {
    let mut callback_error = None;
    let mut frame = Vec::with_capacity(8192);
    loop {
        frame.resize(5, 0);
        stream.read_exact(&mut frame[..5]).map_err(|err| {
            Error::Engine(format!("read native server protocol message header: {err}"))
        })?;
        let tag = frame[0];
        let len = i32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        if len < 4 {
            return Err(Error::Engine(format!(
                "native server returned invalid message length {len}"
            )));
        }
        let body_len = (len as usize).saturating_sub(4);
        frame.resize(5 + body_len, 0);
        stream.read_exact(&mut frame[5..]).map_err(|err| {
            Error::Engine(format!("read native server protocol message body: {err}"))
        })?;
        let body = &frame[5..];
        if callback_error.is_none()
            && let Err(error) = on_chunk(&frame)
        {
            callback_error = Some(error);
        }

        match tag {
            b'R' => handle_authentication(body)?,
            b'K' => {
                if let Some(target) = backend_key.as_deref_mut() {
                    *target = Some(parse_backend_key_data(body)?);
                }
            }
            b'E' if error_is_fatal => return Err(Error::Engine(parse_error_response(body))),
            b'Z' => return callback_error.map_or(Ok(()), Err),
            _ => {}
        }
    }
}

fn parse_backend_key_data(body: &[u8]) -> Result<BackendKeyData> {
    if body.len() != 8 {
        return Err(Error::Engine(format!(
            "native server returned invalid BackendKeyData length {}",
            body.len()
        )));
    }
    Ok(BackendKeyData {
        process_id: i32::from_be_bytes([body[0], body[1], body[2], body[3]]),
        secret_key: i32::from_be_bytes([body[4], body[5], body[6], body[7]]),
    })
}

fn send_cancel_request(
    endpoint: &PostgresEndpoint,
    backend_key: BackendKeyData,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Result<()> {
    let mut stream = connect_stream(endpoint, connect_timeout, io_timeout)?;
    let mut packet = Vec::with_capacity(16);
    packet.extend_from_slice(&16_i32.to_be_bytes());
    packet.extend_from_slice(&CANCEL_REQUEST_CODE.to_be_bytes());
    packet.extend_from_slice(&backend_key.process_id.to_be_bytes());
    packet.extend_from_slice(&backend_key.secret_key.to_be_bytes());
    stream
        .write_all(&packet)
        .and_then(|()| stream.flush())
        .map_err(|err| Error::Engine(format!("write native server cancel request: {err}")))
}

fn handle_authentication(body: &[u8]) -> Result<()> {
    if body.len() < 4 {
        return Err(Error::Engine(
            "native server returned truncated authentication message".to_owned(),
        ));
    }
    let method = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    if method == 0 {
        Ok(())
    } else {
        Err(Error::Engine(format!(
            "native server requested unsupported authentication method {method}"
        )))
    }
}

fn parse_error_response(body: &[u8]) -> String {
    let mut message = None;
    for field in body
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        if field[0] == b'M' {
            message = Some(String::from_utf8_lossy(&field[1..]).into_owned());
            break;
        }
    }
    message.unwrap_or_else(|| "native server returned an error response".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_backend_key_data() {
        let key = parse_backend_key_data(&[0, 0, 0, 7, 0, 0, 0, 11]).unwrap();
        assert_eq!(
            key,
            BackendKeyData {
                process_id: 7,
                secret_key: 11,
            }
        );
    }

    #[test]
    fn rejects_malformed_backend_key_data() {
        assert!(parse_backend_key_data(&[0, 1, 2]).is_err());
    }
}
