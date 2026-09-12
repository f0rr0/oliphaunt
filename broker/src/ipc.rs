use std::io::{Read, Write};

use liboliphaunt_native_bindings::{Error, Result};

const MAGIC: &[u8; 4] = b"PGOB";
const HEADER_LEN: usize = 13;
const MAX_FRAME_LEN: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestFrame {
    Authenticate(String),
    Close,
    Backup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseFrame {
    Ok(Vec<u8>),
    Error(String),
}

pub fn write_request(writer: &mut impl Write, frame: RequestFrame) -> Result<()> {
    match frame {
        RequestFrame::Authenticate(token) => write_frame(writer, 6, token.as_bytes()),
        RequestFrame::Close => write_frame(writer, 3, &[]),
        RequestFrame::Backup => write_frame(writer, 5, &[]),
    }
}

pub fn read_request(reader: &mut impl Read) -> Result<RequestFrame> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        6 => String::from_utf8(payload)
            .map(RequestFrame::Authenticate)
            .map_err(|err| Error::Engine(format!("broker auth frame is not UTF-8: {err}"))),
        3 => empty_payload(payload, RequestFrame::Close),
        5 => empty_payload(payload, RequestFrame::Backup),
        _ => Err(Error::Engine(format!(
            "unknown broker request frame {kind}"
        ))),
    }
}

pub fn write_response(writer: &mut impl Write, frame: ResponseFrame) -> Result<()> {
    match frame {
        ResponseFrame::Ok(bytes) => write_frame(writer, 101, &bytes),
        ResponseFrame::Error(message) => write_frame(writer, 102, message.as_bytes()),
    }
}

pub fn read_response(reader: &mut impl Read) -> Result<ResponseFrame> {
    let (kind, payload) = read_frame(reader)?;
    match kind {
        101 => Ok(ResponseFrame::Ok(payload)),
        102 => String::from_utf8(payload)
            .map(ResponseFrame::Error)
            .map_err(|err| Error::Engine(format!("broker error frame is not UTF-8: {err}"))),
        _ => Err(Error::Engine(format!(
            "unknown broker response frame {kind}"
        ))),
    }
}

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
}
