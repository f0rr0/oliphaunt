//! Bounded raw exchange records shared by desktop and mobile brokers.
use std::io::{self, Read, Write};

use oliphaunt_query::wire::{MAX_FRONTEND_MESSAGE, frontend_message_len_if_complete};

pub const CHUNK_BYTES: usize = 256 * 1024;
pub const INPUT_BYTES: usize = MAX_FRONTEND_MESSAGE;
pub const VERSION: u16 = 1;
pub type Epoch = [u8; 16];
pub const STARTUP_PARAMETER: &str = "_pq_.oliphaunt_exchange";

/// A duplex connection whose writer can progress while callbacks drain output.
pub trait Connection: Read + Write + Send {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>>;
    fn shutdown(&self);
}

impl Connection for std::net::TcpStream {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
}
#[cfg(unix)]
impl Connection for std::os::unix::net::UnixStream {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
}

pub fn new_epoch() -> io::Result<Epoch> {
    let mut epoch = [0; 16];
    getrandom::fill(&mut epoch).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(epoch)
}
const HEADER_BYTES: usize = 36;
const ERROR_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Query = 1,
    Backup = 2,
    Restore = 3,
    Data = 4,
    End = 5,
    Terminal = 6,
}

#[derive(Debug)]
pub struct Frame {
    pub kind: Kind,
    pub epoch: Epoch,
    pub request: u64,
    pub payload: Vec<u8>,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            kind: Kind::End,
            epoch: [0; 16],
            request: 0,
            payload: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Execution {
    NotStarted = 0,
    Completed = 1,
    Unknown = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Reason {
    Success = 0,
    InvalidRequest = 1,
    Cancelled = 2,
    Deadline = 3,
    WorkerInterrupted = 4,
    Transport = 5,
    Database = 6,
    Callback = 7,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub reason: Reason,
    pub execution: Execution,
    pub requires_reopen: bool,
    pub detail: String,
}

impl Completion {
    pub fn success() -> Self {
        Self {
            reason: Reason::Success,
            execution: Execution::Completed,
            requires_reopen: false,
            detail: String::new(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = vec![
            self.reason as u8,
            self.execution as u8,
            u8::from(self.requires_reopen),
        ];
        let mut end = self.detail.len().min(ERROR_BYTES);
        while !self.detail.is_char_boundary(end) {
            end -= 1;
        }
        bytes.extend_from_slice(&self.detail.as_bytes()[..end]);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() < 3 || bytes.len() > ERROR_BYTES + 3 {
            return Err(invalid("invalid terminal size"));
        }
        let reason = match bytes[0] {
            0 => Reason::Success,
            1 => Reason::InvalidRequest,
            2 => Reason::Cancelled,
            3 => Reason::Deadline,
            4 => Reason::WorkerInterrupted,
            5 => Reason::Transport,
            6 => Reason::Database,
            7 => Reason::Callback,
            _ => return Err(invalid("invalid terminal reason")),
        };
        let execution = match bytes[1] {
            0 => Execution::NotStarted,
            1 => Execution::Completed,
            2 => Execution::Unknown,
            _ => return Err(invalid("invalid execution certainty")),
        };
        let requires_reopen = match bytes[2] {
            0 => false,
            1 => true,
            _ => return Err(invalid("invalid connection state")),
        };
        if (reason == Reason::Success && (execution != Execution::Completed || requires_reopen))
            || (execution == Execution::Unknown && !requires_reopen)
        {
            return Err(invalid("inconsistent terminal result"));
        }
        Ok(Self {
            reason,
            execution,
            requires_reopen,
            detail: std::str::from_utf8(&bytes[3..])
                .map_err(|_| invalid("invalid error text"))?
                .into(),
        })
    }
}

pub fn write_frame(
    output: &mut (impl Write + ?Sized),
    kind: Kind,
    epoch: Epoch,
    request: u64,
    payload: &[u8],
) -> io::Result<()> {
    validate_length(kind, payload.len())?;
    // Zero is reserved for readiness and native Close acknowledgements.
    if request == 0 && kind != Kind::Terminal {
        return Err(invalid("request id is zero"));
    }
    let mut header = [0; HEADER_BYTES];
    header[..4].copy_from_slice(b"OLMB");
    header[4..6].copy_from_slice(&VERSION.to_be_bytes());
    header[6] = kind as u8;
    header[8..24].copy_from_slice(&epoch);
    header[24..32].copy_from_slice(&request.to_be_bytes());
    header[32..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    output.write_all(&header)?;
    output.write_all(payload)
}

pub fn read_frame(input: &mut (impl Read + ?Sized)) -> io::Result<Frame> {
    let mut frame = Frame::default();
    read_frame_into(input, &mut frame)?;
    Ok(frame)
}

/// Reuse bounded payload storage across records without copying response bytes.
pub fn read_frame_into(input: &mut (impl Read + ?Sized), frame: &mut Frame) -> io::Result<()> {
    let mut header = [0; HEADER_BYTES];
    input.read_exact(&mut header)?;
    if &header[..4] != b"OLMB"
        || u16::from_be_bytes(header[4..6].try_into().unwrap()) != VERSION
        || header[7] != 0
    {
        return Err(invalid("incompatible broker exchange protocol"));
    }
    let kind = match header[6] {
        1 => Kind::Query,
        2 => Kind::Backup,
        3 => Kind::Restore,
        4 => Kind::Data,
        5 => Kind::End,
        6 => Kind::Terminal,
        _ => return Err(invalid("invalid bulk record kind")),
    };
    let size = u32::from_be_bytes(header[32..].try_into().unwrap()) as usize;
    validate_length(kind, size)?;
    let request = u64::from_be_bytes(header[24..32].try_into().unwrap());
    if request == 0 && kind != Kind::Terminal {
        return Err(invalid("request id is zero"));
    }
    frame.payload.resize(size, 0);
    input.read_exact(&mut frame.payload)?;
    frame.kind = kind;
    frame.epoch = header[8..24].try_into().unwrap();
    frame.request = request;
    Ok(())
}

fn validate_length(kind: Kind, size: usize) -> io::Result<()> {
    let valid = match kind {
        Kind::Query | Kind::Backup | Kind::Restore => size == 16,
        Kind::Data => size > 0 && size <= CHUNK_BYTES,
        Kind::End => size == 0,
        Kind::Terminal => (3..=ERROR_BYTES + 3).contains(&size),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid("invalid bulk record length"))
    }
}

pub fn invalid(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
}

/// Validate bytes before submission without predicting PostgreSQL readiness.
pub fn validate_input(bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > INPUT_BYTES {
        return Err(invalid("invalid frontend input size"));
    }
    let mut offset = 0;
    while offset < bytes.len() {
        let frame = &bytes[offset..];
        let size = frontend_message_len_if_complete(frame)?
            .ok_or_else(|| invalid("truncated frontend frame"))?;
        if matches!(frame[0], 0 | b'X' | b'p') {
            return Err(invalid("connection control is not an exchange request"));
        }
        offset += size;
    }
    Ok(())
}

pub fn read_ready(input: &mut impl Read) -> io::Result<Epoch> {
    let frame = read_frame(input)?;
    if frame.kind != Kind::Terminal
        || frame.request != 0
        || Completion::decode(&frame.payload)? != Completion::success()
    {
        return Err(invalid(
            "broker did not confirm exchange transport readiness",
        ));
    }
    Ok(frame.epoch)
}

fn write_input(
    output: &mut (impl Write + ?Sized),
    epoch: Epoch,
    request: u64,
    input: &[u8],
) -> io::Result<()> {
    let mut begin = [0; 16];
    begin[..8].copy_from_slice(&(input.len() as u64).to_be_bytes());
    write_frame(output, Kind::Query, epoch, request, &begin)?;
    for chunk in input.chunks(CHUNK_BYTES) {
        write_frame(output, Kind::Data, epoch, request, chunk)?;
    }
    write_frame(output, Kind::End, epoch, request, &[])
}

fn receive<E>(
    input: &mut (impl Read + ?Sized),
    epoch: Epoch,
    request: u64,
    callback: &mut impl FnMut(&[u8]) -> Result<(), E>,
) -> io::Result<(Completion, Option<E>)> {
    let mut callback_error = None;
    let mut frame = Frame::default();
    loop {
        read_frame_into(input, &mut frame)?;
        if frame.epoch != epoch || frame.request != request {
            return Err(invalid("stale broker exchange response"));
        }
        match frame.kind {
            Kind::Data => {
                if callback_error.is_none() {
                    callback_error = callback(&frame.payload).err();
                }
            }
            Kind::Terminal => return Ok((Completion::decode(&frame.payload)?, callback_error)),
            _ => return Err(invalid("unexpected broker exchange response")),
        }
    }
}

/// Preserve callback identity while draining the ordered terminal outcome.
pub fn exchange<E>(
    stream: &mut (impl Connection + ?Sized),
    epoch: Epoch,
    request: u64,
    input: &[u8],
    callback: &mut impl FnMut(&[u8]) -> Result<(), E>,
) -> io::Result<(Completion, Option<E>)> {
    validate_input(input)?;
    if input.len() <= CHUNK_BYTES {
        // The receiver consumes this entire Data record before its first feed.
        // That initial native slot is empty, so upload cannot depend on output.
        let reading = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            write_input(stream, epoch, request, input)?;
            receive(stream, epoch, request, callback)
        }));
        if !matches!(&reading, Ok(Ok((completion, _))) if !completion.requires_reopen) {
            stream.shutdown();
        }
        return match reading {
            Ok(result) => result,
            Err(payload) => std::panic::resume_unwind(payload),
        };
    }
    let mut writer = stream.clone_connection()?;
    std::thread::scope(|scope| {
        let writing = scope.spawn(|| {
            let result = write_input(&mut writer, epoch, request, input);
            if result.is_err() {
                writer.shutdown();
            }
            result
        });
        let reading = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            receive(stream, epoch, request, callback)
        }));
        if !matches!(&reading, Ok(Ok((completion, _))) if !completion.requires_reopen) {
            stream.shutdown();
        }
        let written = writing.join();
        match reading {
            Err(payload) => std::panic::resume_unwind(payload),
            Ok(Err(error)) => Err(error),
            Ok(Ok(result)) => {
                written.map_err(|_| invalid("broker exchange writer panicked"))??;
                Ok(result)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn records_round_trip_with_fragmented_reads_and_reject_lengths_before_allocation() {
        struct Fragments(Cursor<Vec<u8>>);
        impl Read for Fragments {
            fn read(&mut self, data: &mut [u8]) -> io::Result<usize> {
                let len = data.len().min(3);
                self.0.read(&mut data[..len])
            }
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, Kind::Data, [7; 16], 9, b"result").unwrap();
        let frame = read_frame(&mut Fragments(Cursor::new(bytes.clone()))).unwrap();
        assert_eq!(
            (frame.epoch, frame.request, frame.payload),
            ([7; 16], 9, b"result".to_vec())
        );
        bytes[32..36].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            read_frame(&mut Cursor::new(bytes)).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn terminal_preserves_execution_and_connection_health_independently() {
        for execution in [
            Execution::NotStarted,
            Execution::Completed,
            Execution::Unknown,
        ] {
            for requires_reopen in [false, true] {
                let completion = Completion {
                    reason: Reason::Cancelled,
                    execution,
                    requires_reopen,
                    detail: "cancelled".into(),
                };
                let decoded = Completion::decode(&completion.encode());
                if execution == Execution::Unknown && !requires_reopen {
                    assert!(decoded.is_err());
                } else {
                    assert_eq!(decoded.unwrap(), completion);
                }
            }
        }
    }

    fn pair() -> (std::net::TcpStream, std::net::TcpStream) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        for stream in [&client, &server] {
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
        }
        (client, server)
    }

    fn drain_input(stream: &mut impl Read, epoch: Epoch, request: u64) -> usize {
        let mut length = 0;
        loop {
            let frame = read_frame(stream).unwrap();
            assert_eq!((frame.epoch, frame.request), (epoch, request));
            match frame.kind {
                Kind::Data => length += frame.payload.len(),
                Kind::End => return length,
                _ => panic!("unexpected input record"),
            }
        }
    }

    #[test]
    fn callback_failure_drains_terminal_and_keeps_the_original_error() {
        let (mut client, mut server) = pair();
        let input = oliphaunt_query::simple_query("SELECT 1").unwrap();
        let length = input.len();
        let peer = std::thread::spawn(move || {
            let begin = read_frame(&mut server).unwrap();
            assert_eq!(begin.kind, Kind::Query);
            assert_eq!(drain_input(&mut server, [1; 16], 1), length);
            for bytes in [b"first".as_slice(), b"later"] {
                write_frame(&mut server, Kind::Data, [1; 16], 1, bytes).unwrap();
            }
            write_frame(
                &mut server,
                Kind::Terminal,
                [1; 16],
                1,
                &Completion::success().encode(),
            )
            .unwrap();
        });
        let mut calls = 0;
        let error = String::from("original callback error");
        let (completion, callback_error) = exchange(&mut client, [1; 16], 1, &input, &mut |_| {
            calls += 1;
            Err(&error)
        })
        .unwrap();
        assert_eq!(completion, Completion::success());
        assert!(std::ptr::eq(callback_error.unwrap(), &error));
        assert_eq!(calls, 1);
        peer.join().unwrap();
    }

    #[test]
    fn terminal_can_report_unknown_after_partial_postgres_output() {
        let (mut client, mut server) = pair();
        let input = oliphaunt_query::simple_query("SELECT 1").unwrap();
        let expected = Completion {
            reason: Reason::Database,
            execution: Execution::Unknown,
            requires_reopen: true,
            detail: "native failure".into(),
        };
        let terminal = expected.clone();
        let peer = std::thread::spawn(move || {
            read_frame(&mut server).unwrap();
            drain_input(&mut server, [2; 16], 1);
            write_frame(&mut server, Kind::Data, [2; 16], 1, b"D\0").unwrap();
            write_frame(&mut server, Kind::Terminal, [2; 16], 1, &terminal.encode()).unwrap();
        });
        let mut output = Vec::new();
        let (completion, _) = exchange(&mut client, [2; 16], 1, &input, &mut |bytes| {
            output.extend_from_slice(bytes);
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(completion, expected);
        assert_eq!(output, b"D\0");
        peer.join().unwrap();
    }

    #[test]
    fn large_upload_and_output_make_progress_together() {
        let (mut client, mut server) = pair();
        let input = oliphaunt_query::simple_query(&" ".repeat(4 * 1024 * 1024)).unwrap();
        let length = input.len();
        let peer = std::thread::spawn(move || {
            read_frame(&mut server).unwrap();
            let bytes = vec![7; CHUNK_BYTES];
            for _ in 0..16 {
                write_frame(&mut server, Kind::Data, [3; 16], 1, &bytes).unwrap();
            }
            assert_eq!(drain_input(&mut server, [3; 16], 1), length);
            write_frame(
                &mut server,
                Kind::Terminal,
                [3; 16],
                1,
                &Completion::success().encode(),
            )
            .unwrap();
        });
        let mut received = 0;
        let (completion, _) = exchange(&mut client, [3; 16], 1, &input, &mut |bytes| {
            received += bytes.len();
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(completion, Completion::success());
        assert_eq!(received, 16 * CHUNK_BYTES);
        peer.join().unwrap();
    }

    #[test]
    fn one_input_record_can_receive_large_output_before_the_peer_reads_end() {
        let (mut client, mut server) = pair();
        let input = oliphaunt_query::simple_query(&" ".repeat(CHUNK_BYTES - 6)).unwrap();
        assert_eq!(input.len(), CHUNK_BYTES);
        let peer = std::thread::spawn(move || {
            read_frame(&mut server).unwrap();
            let data = read_frame(&mut server).unwrap();
            assert_eq!(data.kind, Kind::Data);
            assert_eq!(data.payload.len(), CHUNK_BYTES);
            let bytes = vec![7; CHUNK_BYTES];
            for _ in 0..16 {
                write_frame(&mut server, Kind::Data, [6; 16], 1, &bytes).unwrap();
            }
            assert_eq!(read_frame(&mut server).unwrap().kind, Kind::End);
            write_frame(
                &mut server,
                Kind::Terminal,
                [6; 16],
                1,
                &Completion::success().encode(),
            )
            .unwrap();
        });
        let mut received = 0;
        let (completion, _) = exchange(&mut client, [6; 16], 1, &input, &mut |bytes| {
            received += bytes.len();
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(completion, Completion::success());
        assert_eq!(received, 16 * CHUNK_BYTES);
        peer.join().unwrap();
    }

    #[test]
    fn completion_does_not_depend_on_frontend_sync_counts() {
        let mut input = oliphaunt_query::simple_query("COPY t FROM STDIN").unwrap();
        input.extend_from_slice(b"S\0\0\0\x04H\0\0\0\x04d\0\0\0\x06x\nc\0\0\0\x04");
        assert!(validate_input(&input).is_ok());

        for code in [
            oliphaunt_query::wire::PROTOCOL_3,
            oliphaunt_query::wire::CANCEL_REQUEST_CODE,
            oliphaunt_query::wire::SSL_REQUEST_CODE,
        ] {
            let mut input = oliphaunt_query::simple_query("SELECT 1").unwrap();
            input.extend_from_slice(&8_u32.to_be_bytes());
            input.extend_from_slice(&code.to_be_bytes());
            let (mut client, mut server) = pair();
            let error = exchange(
                &mut client,
                [1; 16],
                1,
                &input,
                &mut |_| -> Result<(), ()> { panic!("invalid input must not invoke the callback") },
            )
            .unwrap_err();
            assert!(error.to_string().contains("connection control"));
            server.set_nonblocking(true).unwrap();
            assert_eq!(
                server.read(&mut [0]).unwrap_err().kind(),
                io::ErrorKind::WouldBlock,
            );
        }
    }

    #[test]
    fn a_reply_from_another_connection_generation_is_terminal() {
        let (mut client, mut server) = pair();
        let input = oliphaunt_query::simple_query("SELECT 1").unwrap();
        let peer = std::thread::spawn(move || {
            read_frame(&mut server).unwrap();
            drain_input(&mut server, [4; 16], 1);
            write_frame(
                &mut server,
                Kind::Terminal,
                [5; 16],
                1,
                &Completion::success().encode(),
            )
            .unwrap();
        });
        let error =
            exchange(&mut client, [4; 16], 1, &input, &mut |_| Ok::<_, ()>(())).unwrap_err();
        assert!(error.to_string().contains("stale broker exchange response"));
        peer.join().unwrap();
    }
}
