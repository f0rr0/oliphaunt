use std::io::{Read, Write};

use liboliphaunt_native_bindings::{Error, Result};

const MAGIC: &[u8; 4] = b"PGOB";
const HEADER_LEN: usize = 13;
const MAX_FRAME_LEN: u64 = 128 * 1024 * 1024;
const BACKUP_CHUNK_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestFrame {
    Authenticate(String),
    Close,
    Backup,
    BackupStream,
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
        RequestFrame::BackupStream => write_frame(writer, 7, &[]),
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
        7 => empty_payload(payload, RequestFrame::BackupStream),
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

/// Write archive bytes in bounded frames on the existing management connection.
pub fn write_backup_chunk(writer: &mut impl Write, bytes: &[u8]) -> Result<()> {
    for chunk in bytes.chunks(BACKUP_CHUNK_LEN) {
        write_frame(writer, 103, chunk)?;
    }
    Ok(())
}

/// Drain through terminal completion, retaining a destination failure separately.
pub fn read_backup_response(
    reader: &mut impl Read,
    writer: &mut (impl Write + ?Sized),
) -> Result<(ResponseFrame, Option<std::io::Error>)> {
    let mut destination_failure = None;
    loop {
        let (kind, payload) = read_frame(reader)?;
        match kind {
            103 if !payload.is_empty() => {
                if destination_failure.is_none() {
                    destination_failure = writer.write_all(&payload).err();
                }
            }
            101 if payload.is_empty() => {
                return Ok((ResponseFrame::Ok(payload), destination_failure));
            }
            102 => {
                let message = String::from_utf8(payload).map_err(|error| {
                    Error::Engine(format!("broker error frame is not UTF-8: {error}"))
                })?;
                return Ok((ResponseFrame::Error(message), destination_failure));
            }
            _ => {
                return Err(Error::Engine(format!(
                    "unexpected broker backup frame {kind}"
                )));
            }
        }
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
    let limit = if kind == 103 {
        BACKUP_CHUNK_LEN as u64
    } else {
        MAX_FRAME_LEN
    };
    if len > limit {
        return Err(Error::Engine(format!(
            "broker frame payload length {len} exceeds limit {limit}"
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
    fn backup_stream_chunks_are_bounded_and_a_failed_sink_drains_completion() {
        let payload = vec![b'x'; 3 * BACKUP_CHUNK_LEN + 17];
        let mut frames = Vec::new();
        write_backup_chunk(&mut frames, &payload).unwrap();
        write_response(&mut frames, ResponseFrame::Ok(Vec::new())).unwrap();
        write_response(&mut frames, ResponseFrame::Ok(b"next".to_vec())).unwrap();
        let mut reader = Cursor::new(&frames);
        for expected in [BACKUP_CHUNK_LEN, BACKUP_CHUNK_LEN, BACKUP_CHUNK_LEN, 17] {
            let (kind, bytes) = read_frame(&mut reader).unwrap();
            assert_eq!(kind, 103);
            assert_eq!(bytes.len(), expected);
        }
        let mut reader = Cursor::new(&frames);
        let mut output = Vec::new();
        let (completion, failure) = read_backup_response(&mut reader, &mut output).unwrap();
        assert_eq!(completion, ResponseFrame::Ok(Vec::new()));
        assert!(failure.is_none());
        assert_eq!(output, payload);
        assert_eq!(
            read_response(&mut reader).unwrap(),
            ResponseFrame::Ok(b"next".to_vec())
        );

        let mut reader = Cursor::new(&frames);
        let mut full = [];
        let (completion, failure) =
            read_backup_response(&mut reader, &mut Cursor::new(full.as_mut_slice())).unwrap();
        assert_eq!(completion, ResponseFrame::Ok(Vec::new()));
        assert!(failure.is_some());
        assert_eq!(
            read_response(&mut reader).unwrap(),
            ResponseFrame::Ok(b"next".to_vec())
        );

        let mut header = [0_u8; HEADER_LEN];
        header[..4].copy_from_slice(MAGIC);
        header[4] = 103;
        header[5..].copy_from_slice(&(BACKUP_CHUNK_LEN as u64 + 1).to_be_bytes());
        assert!(read_backup_response(&mut Cursor::new(header), &mut Vec::new()).is_err());
    }
}
