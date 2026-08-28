use std::io::{Read, Write};

use crate::error::{Error, Result};

const MAGIC: &[u8; 4] = b"PGOB";
const HEADER_LEN: usize = 13;
const MAX_FRAME_LEN: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RequestFrame {
    Authenticate(String),
    ExecProtocol(Vec<u8>),
    ExecProtocolStream(Vec<u8>),
    #[cfg(any(feature = "__internal-broker-helper", test))]
    ExecSimpleQuery(String),
    Close,
    Backup,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResponseFrame {
    Ok(Vec<u8>),
    Error(String),
    Chunk(Vec<u8>),
    StreamCallbackAborted(String),
}

/// Internal broker IPC request used by the packaged broker helper.
#[cfg(feature = "__internal-broker-helper")]
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerIpcRequest {
    /// Authenticate the parent SDK process to the broker helper.
    Authenticate(String),
    /// Execute raw PostgreSQL protocol bytes.
    ExecProtocol(Vec<u8>),
    /// Execute raw PostgreSQL protocol bytes and stream backend response chunks.
    ExecProtocolStream(Vec<u8>),
    /// Execute SQL through PostgreSQL's simple-query protocol.
    ExecSimpleQuery(String),
    /// Create a backup artifact.
    Backup,
    /// Cancel the active backend query.
    Cancel,
    /// Close the broker session.
    Close,
}

/// Read one broker IPC request from a stream.
#[cfg(feature = "__internal-broker-helper")]
#[doc(hidden)]
pub fn broker_ipc_read_request(reader: &mut impl Read) -> Result<BrokerIpcRequest> {
    match read_request(reader)? {
        RequestFrame::Authenticate(token) => Ok(BrokerIpcRequest::Authenticate(token)),
        RequestFrame::ExecProtocol(bytes) => Ok(BrokerIpcRequest::ExecProtocol(bytes)),
        RequestFrame::ExecProtocolStream(bytes) => Ok(BrokerIpcRequest::ExecProtocolStream(bytes)),
        RequestFrame::ExecSimpleQuery(sql) => Ok(BrokerIpcRequest::ExecSimpleQuery(sql)),
        RequestFrame::Backup => Ok(BrokerIpcRequest::Backup),
        RequestFrame::Cancel => Ok(BrokerIpcRequest::Cancel),
        RequestFrame::Close => Ok(BrokerIpcRequest::Close),
    }
}

/// Write a successful broker IPC response.
#[cfg(feature = "__internal-broker-helper")]
#[doc(hidden)]
pub fn broker_ipc_write_ok(writer: &mut impl Write, bytes: Vec<u8>) -> Result<()> {
    write_response(writer, ResponseFrame::Ok(bytes))
}

/// Write one successful broker IPC stream chunk.
#[cfg(any(feature = "__internal-broker-helper", test))]
#[doc(hidden)]
pub fn broker_ipc_write_chunk(writer: &mut impl Write, bytes: &[u8]) -> Result<()> {
    write_response(writer, ResponseFrame::Chunk(bytes.to_vec()))
}

/// Write a failed broker IPC response.
#[cfg(feature = "__internal-broker-helper")]
#[doc(hidden)]
pub fn broker_ipc_write_error(writer: &mut impl Write, message: String) -> Result<()> {
    write_response(writer, ResponseFrame::Error(message))
}

/// Write a streamed-protocol callback failure after the broker runtime has
/// independently confirmed ReadyForQuery.
#[cfg(any(feature = "__internal-broker-helper", test))]
#[doc(hidden)]
pub fn broker_ipc_write_stream_callback_aborted(
    writer: &mut impl Write,
    message: String,
) -> Result<()> {
    write_response(writer, ResponseFrame::StreamCallbackAborted(message))
}

pub(crate) fn write_request(writer: &mut impl Write, frame: RequestFrame) -> Result<()> {
    match frame {
        RequestFrame::Authenticate(token) => write_frame(writer, 6, token.as_bytes()),
        RequestFrame::ExecProtocol(bytes) => write_frame(writer, 1, &bytes),
        RequestFrame::ExecProtocolStream(bytes) => write_frame(writer, 4, &bytes),
        #[cfg(any(feature = "__internal-broker-helper", test))]
        RequestFrame::ExecSimpleQuery(sql) => write_frame(writer, 8, sql.as_bytes()),
        RequestFrame::Close => write_frame(writer, 3, &[]),
        RequestFrame::Backup => write_frame(writer, 5, &[]),
        RequestFrame::Cancel => write_frame(writer, 7, &[]),
    }
}

#[cfg(any(feature = "__internal-broker-helper", test))]
pub(crate) fn read_request(reader: &mut impl Read) -> Result<RequestFrame> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        6 => String::from_utf8(payload)
            .map(RequestFrame::Authenticate)
            .map_err(|err| Error::Engine(format!("broker auth frame is not UTF-8: {err}"))),
        1 => Ok(RequestFrame::ExecProtocol(payload)),
        4 => Ok(RequestFrame::ExecProtocolStream(payload)),
        8 => String::from_utf8(payload)
            .map(RequestFrame::ExecSimpleQuery)
            .map_err(|err| Error::Engine(format!("broker simple-query frame is not UTF-8: {err}"))),
        3 => empty_payload(payload, RequestFrame::Close),
        5 => empty_payload(payload, RequestFrame::Backup),
        7 => empty_payload(payload, RequestFrame::Cancel),
        _ => Err(Error::Engine(format!(
            "unknown broker request frame {kind}"
        ))),
    }
}

#[cfg(any(feature = "__internal-broker-helper", test))]
pub(crate) fn write_response(writer: &mut impl Write, frame: ResponseFrame) -> Result<()> {
    match frame {
        ResponseFrame::Ok(bytes) => write_frame(writer, 101, &bytes),
        ResponseFrame::Error(message) => write_frame(writer, 102, message.as_bytes()),
        ResponseFrame::Chunk(bytes) => write_frame(writer, 103, &bytes),
        ResponseFrame::StreamCallbackAborted(message) => {
            write_frame(writer, 104, message.as_bytes())
        }
    }
}

pub(crate) fn read_response(reader: &mut impl Read) -> Result<ResponseFrame> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        101 => Ok(ResponseFrame::Ok(payload)),
        102 => String::from_utf8(payload)
            .map(ResponseFrame::Error)
            .map_err(|err| Error::Engine(format!("broker error frame is not UTF-8: {err}"))),
        103 => Ok(ResponseFrame::Chunk(payload)),
        104 => String::from_utf8(payload)
            .map(ResponseFrame::StreamCallbackAborted)
            .map_err(|err| {
                Error::Engine(format!(
                    "broker stream callback-aborted frame is not UTF-8: {err}"
                ))
            }),
        _ => Err(Error::Engine(format!(
            "unknown broker response frame {kind}"
        ))),
    }
}

#[cfg(any(feature = "__internal-broker-helper", test))]
fn empty_payload(payload: Vec<u8>, frame: RequestFrame) -> Result<RequestFrame> {
    if payload.is_empty() {
        Ok(frame)
    } else {
        Err(Error::Engine(
            "broker control frame unexpectedly had a payload".to_owned(),
        ))
    }
}

fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> Result<()> {
    let len = u64::try_from(payload.len())
        .map_err(|_| Error::Engine("broker frame payload is too large".to_owned()))?;
    let mut header = [0_u8; HEADER_LEN];
    header[..4].copy_from_slice(MAGIC);
    header[4] = kind;
    header[5..].copy_from_slice(&len.to_be_bytes());
    writer
        .write_all(&header)
        .and_then(|()| writer.write_all(payload))
        .and_then(|()| writer.flush())
        .map_err(|err| Error::Engine(format!("write broker frame: {err}")))
}

fn read_frame(reader: &mut impl Read) -> Result<(u8, Vec<u8>)> {
    let mut header = [0_u8; HEADER_LEN];
    reader
        .read_exact(&mut header)
        .map_err(|err| Error::Engine(format!("read broker frame header: {err}")))?;
    if &header[..4] != MAGIC {
        return Err(Error::Engine("broker frame magic mismatch".to_owned()));
    }
    let kind = header[4];
    let len = u64::from_be_bytes(
        header[5..]
            .try_into()
            .expect("frame header contains an 8-byte payload length"),
    );
    if len > MAX_FRAME_LEN {
        return Err(Error::Engine(format!(
            "broker frame payload length {len} exceeds limit {MAX_FRAME_LEN}"
        )));
    }
    let mut payload = vec![0_u8; len as usize];
    reader
        .read_exact(&mut payload)
        .map_err(|err| Error::Engine(format!("read broker frame payload: {err}")))?;
    Ok((kind, payload))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn auth_frame_round_trips() {
        let mut bytes = Vec::new();
        write_request(
            &mut bytes,
            RequestFrame::Authenticate("token-123".to_owned()),
        )
        .unwrap();

        let mut cursor = Cursor::new(bytes);
        assert_eq!(
            read_request(&mut cursor).unwrap(),
            RequestFrame::Authenticate("token-123".to_owned())
        );
    }

    #[test]
    fn backup_frame_still_round_trips() {
        let mut bytes = Vec::new();
        write_request(&mut bytes, RequestFrame::Backup).unwrap();

        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_request(&mut cursor).unwrap(), RequestFrame::Backup);
    }

    #[test]
    fn simple_query_frame_round_trips() {
        let mut bytes = Vec::new();
        write_request(
            &mut bytes,
            RequestFrame::ExecSimpleQuery("SELECT 1".to_owned()),
        )
        .unwrap();

        let mut cursor = Cursor::new(bytes);
        assert_eq!(
            read_request(&mut cursor).unwrap(),
            RequestFrame::ExecSimpleQuery("SELECT 1".to_owned())
        );
    }

    #[test]
    fn cancel_frame_round_trips() {
        let mut bytes = Vec::new();
        write_request(&mut bytes, RequestFrame::Cancel).unwrap();

        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_request(&mut cursor).unwrap(), RequestFrame::Cancel);
    }

    #[test]
    fn streaming_request_and_chunk_frames_round_trip() {
        let mut request = Vec::new();
        write_request(
            &mut request,
            RequestFrame::ExecProtocolStream(vec![0x51, 0, 0, 0, 4]),
        )
        .unwrap();
        assert_eq!(
            read_request(&mut Cursor::new(request)).unwrap(),
            RequestFrame::ExecProtocolStream(vec![0x51, 0, 0, 0, 4])
        );

        let mut response = Vec::new();
        broker_ipc_write_chunk(&mut response, &[0x5a]).unwrap();
        assert_eq!(
            read_response(&mut Cursor::new(response)).unwrap(),
            ResponseFrame::Chunk(vec![0x5a])
        );

        let mut response = Vec::new();
        broker_ipc_write_stream_callback_aborted(&mut response, "consumer stopped".to_owned())
            .unwrap();
        assert_eq!(
            read_response(&mut Cursor::new(response)).unwrap(),
            ResponseFrame::StreamCallbackAborted("consumer stopped".to_owned())
        );
    }
}
