use std::io::{self, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

use crate::error::{Error, Result};

const PROTOCOL_VERSION_3: i32 = 196_608;
const POSTGRES_WIRE_READ_BUFFER: usize = 64 * 1024;

trait PostgresStream: Read + Write + Send {
    fn set_stream_timeouts(
        &self,
        read_timeout: Option<Duration>,
        write_timeout: Option<Duration>,
    ) -> io::Result<()>;
}

impl PostgresStream for TcpStream {
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PostgresEndpoint {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
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
        read_until_ready(&mut stream)?;
        stream
            .get_ref()
            .as_ref()
            .set_stream_timeouts(None, None)
            .map_err(|err| {
                Error::Engine(format!(
                    "clear steady-state native server protocol socket timeouts: {err}"
                ))
            })?;
        Ok(Self { stream })
    }

    pub(crate) fn terminate(&mut self) -> Result<()> {
        let stream = self.stream.get_mut();
        stream
            .write_all(&[b'X', 0, 0, 0, 4])
            .and_then(|()| stream.flush())
            .map_err(|err| Error::Engine(format!("terminate native server connection: {err}")))
    }
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

fn read_until_ready(stream: &mut dyn Read) -> Result<()> {
    let mut frame = Vec::with_capacity(8192);
    loop {
        frame.resize(5, 0);
        if let Err(err) = stream.read_exact(&mut frame[..5]) {
            return Err(Error::Engine(format!(
                "read native server protocol message header: {err}"
            )));
        }
        let tag = frame[0];
        let len = i32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        if len < 4 {
            return Err(Error::Engine(format!(
                "native server returned invalid message length {len}"
            )));
        }
        let body_len = (len as usize).saturating_sub(4);
        frame.resize(5 + body_len, 0);
        if let Err(err) = stream.read_exact(&mut frame[5..]) {
            return Err(Error::Engine(format!(
                "read native server protocol message body: {err}"
            )));
        }
        let body = &frame[5..];

        match tag {
            b'R' => handle_authentication(body)?,
            b'E' => return Err(Error::Engine(parse_error_response(body))),
            b'Z' => return Ok(()),
            _ => {}
        }
    }
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
