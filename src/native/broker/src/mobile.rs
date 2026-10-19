//! Bounded bulk records for mobile brokers. XPC/Binder own lifecycle and
//! cancellation; this transport owns only ordered request/result/archive bytes.
use std::io::{self, Read, Write};

use oliphaunt_query::wire::{MAX_FRONTEND_MESSAGE, frontend_message_len_if_complete};

pub const CHUNK_BYTES: usize = 256 * 1024;
pub const INPUT_BYTES: usize = MAX_FRONTEND_MESSAGE;
pub const VERSION: u16 = 1;
pub type Epoch = [u8; 16];
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
    output: &mut impl Write,
    kind: Kind,
    epoch: Epoch,
    request: u64,
    payload: &[u8],
) -> io::Result<()> {
    validate_length(kind, payload.len())?;
    // Zero is reserved for the terminal acknowledgement of native Close.
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

pub fn read_frame(input: &mut impl Read) -> io::Result<Frame> {
    let mut header = [0; HEADER_BYTES];
    input.read_exact(&mut header)?;
    if &header[..4] != b"OLMB"
        || u16::from_be_bytes(header[4..6].try_into().unwrap()) != VERSION
        || header[7] != 0
    {
        return Err(invalid("incompatible mobile broker protocol"));
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
    let mut payload = vec![0; size];
    input.read_exact(&mut payload)?;
    Ok(Frame {
        kind,
        epoch: header[8..24].try_into().unwrap(),
        request,
        payload,
    })
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

/// A request must have exactly one synchronization boundary. PostgreSQL owns
/// SQL semantics; this validates only framing and complete-exchange topology.
pub fn validate_request(bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > INPUT_BYTES {
        return Err(invalid("invalid frontend input size"));
    }
    let mut offset = 0;
    while offset < bytes.len() {
        let frame = &bytes[offset..];
        let size = frontend_message_len_if_complete(frame)?
            .ok_or_else(|| invalid("truncated frontend frame"))?;
        let last = offset + size == bytes.len();
        match frame[0] {
            b'Q' if offset == 0 && last && size >= 6 && frame[size - 1] == 0 => return Ok(()),
            b'S' if last && size == 5 => return Ok(()),
            b'P' | b'B' | b'D' | b'E' | b'C' | b'H' if !last => {}
            _ => {
                return Err(invalid(
                    "broker operation requires one Query or one extended exchange ending in Sync",
                ));
            }
        }
        offset += size;
    }
    Err(invalid("missing frontend synchronization boundary"))
}

pub fn invalid(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
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

    #[test]
    fn raw_exchange_has_exactly_one_boundary() {
        let query = b"Q\0\0\0\rSELECT 1\0";
        assert!(validate_request(query).is_ok());
        assert!(validate_request(b"P\0\0\0\x04S\0\0\0\x04").is_ok());
        for bytes in [
            [query.as_slice(), query.as_slice()].concat(),
            b"S\0\0\0\x04S\0\0\0\x04".to_vec(),
            b"P\0\0\0\x04".to_vec(),
            b"X\0\0\0\x04".to_vec(),
            query[..query.len() - 1].to_vec(),
        ] {
            assert!(validate_request(&bytes).is_err());
        }
    }
}
