//! PostgreSQL frontend framing and connection control messages, independent of any runtime.
use std::io::{Error, ErrorKind, Result};

macro_rules! anyhow { ($($args:tt)*) => { Error::new(ErrorKind::InvalidData, format!($($args)*)) }; }
macro_rules! bail { ($($args:tt)*) => { return Err(anyhow!($($args)*)) }; }

pub const SSL_REQUEST_CODE: i32 = 80_877_103;
pub const GSSENC_REQUEST_CODE: i32 = 80_877_104;
pub const CANCEL_REQUEST_CODE: i32 = 80_877_102;
pub const PROTOCOL_3: i32 = 196_608;
pub const MAX_FRONTEND_MESSAGE: usize = 128 * 1024 * 1024;

#[derive(Default)]
pub struct FrontendFrameReader {
    buffer: Vec<u8>,
}

impl FrontendFrameReader {
    pub fn append(&mut self, input: &[u8]) {
        self.buffer.extend_from_slice(input);
    }

    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let Some(message_len) = frontend_message_len_if_complete(&self.buffer)? else {
            return Ok(None);
        };
        Ok(Some(self.buffer.drain(..message_len).collect()))
    }

    pub fn push(&mut self, input: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.append(input);
        let mut messages = Vec::new();
        while let Some(message) = self.next_frame()? {
            messages.push(message);
        }
        Ok(messages)
    }

    pub fn pending(&self) -> &[u8] {
        &self.buffer
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontendFrameKind {
    Protocol,
    Startup,
    SslOrGssRequest,
    CancelRequest,
    Terminate,
}

pub fn frontend_message_len_if_complete(buffer: &[u8]) -> Result<Option<usize>> {
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
            bail!("startup/control packet length {len} exceeds limit");
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

pub fn classify_frontend_message(message: &[u8]) -> Result<FrontendFrameKind> {
    if message.is_empty() {
        bail!("empty frontend message");
    }

    if message[0] == 0 {
        if message.len() < 8 {
            bail!("startup/control packet is too short");
        }
        let code = i32::from_be_bytes(message[4..8].try_into().unwrap());
        return Ok(match code {
            SSL_REQUEST_CODE | GSSENC_REQUEST_CODE => FrontendFrameKind::SslOrGssRequest,
            CANCEL_REQUEST_CODE => FrontendFrameKind::CancelRequest,
            PROTOCOL_3 => FrontendFrameKind::Startup,
            other => bail!("unsupported startup/control packet code {other}"),
        });
    }

    if message[0] == b'X' {
        return Ok(FrontendFrameKind::Terminate);
    }

    Ok(FrontendFrameKind::Protocol)
}

pub fn startup_parameter<'a>(message: &'a [u8], wanted: &str) -> Result<Option<&'a str>> {
    Ok(startup_parameters(message)?.get(wanted).copied())
}

/// Decode one complete protocol 3.0 startup packet without accepting ambiguous
/// duplicate keys or ignoring bytes after the terminating empty key.
pub fn startup_parameters(message: &[u8]) -> Result<std::collections::BTreeMap<&str, &str>> {
    if message.len() < 9
        || frontend_message_len_if_complete(message)? != Some(message.len())
        || i32::from_be_bytes(message[4..8].try_into().unwrap()) != PROTOCOL_3
    {
        bail!("expected one complete PostgreSQL protocol 3.0 startup packet");
    }
    let mut parameters = std::collections::BTreeMap::new();
    let mut cursor = 8usize;
    while cursor < message.len() {
        if message[cursor] == 0 {
            if cursor + 1 != message.len() {
                bail!("startup packet contains bytes after its terminator");
            }
            return Ok(parameters);
        }
        let key_end = message[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| anyhow!("startup parameter key is not nul-terminated"))?;
        let key = std::str::from_utf8(&message[cursor..key_end])
            .map_err(|error| anyhow!("startup parameter key is not UTF-8: {error}"))?;
        cursor = key_end + 1;

        let value_end = message[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| anyhow!("startup parameter value is not nul-terminated"))?;
        let value = std::str::from_utf8(&message[cursor..value_end])
            .map_err(|error| anyhow!("startup parameter value is not UTF-8: {error}"))?;
        cursor = value_end + 1;
        if parameters.insert(key, value).is_some() {
            bail!("duplicate startup parameter {key}");
        }
    }
    bail!("startup packet is missing its terminating empty key");
}

pub fn response_contains_error(response: &[u8]) -> bool {
    response_contains_tag(response, b'E')
}

pub fn response_contains_tag(response: &[u8], expected: u8) -> bool {
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
        if tag == expected {
            return true;
        }
        cursor += total;
    }
    false
}

pub fn error_response(severity: &str, code: &str, message: &str) -> Vec<u8> {
    let mut body = Vec::new();
    push_error_field(&mut body, b'S', severity);
    push_error_field(&mut body, b'V', severity);
    push_error_field(&mut body, b'C', code);
    push_error_field(&mut body, b'M', message);
    body.push(0);

    let mut response = Vec::with_capacity(body.len() + 5);
    response.push(b'E');
    response.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    response.extend_from_slice(&body);
    response
}

fn push_error_field(body: &mut Vec<u8>, tag: u8, value: &str) {
    body.push(tag);
    body.extend_from_slice(value.as_bytes());
    body.push(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn startup(body: &[u8]) -> Vec<u8> {
        let mut packet = ((body.len() + 8) as i32).to_be_bytes().to_vec();
        packet.extend(PROTOCOL_3.to_be_bytes());
        packet.extend(body);
        packet
    }

    #[test]
    fn startup_parser_validates_the_entire_packet() -> Result<()> {
        let packet = startup(b"user\0postgres\0application_name\0a'b\0\0");
        assert_eq!(startup_parameter(&packet, "user")?, Some("postgres"));
        assert_eq!(
            startup_parameters(&packet)?.get("application_name"),
            Some(&"a'b")
        );
        for body in [
            b"user\0first\0user\0second\0\0".as_slice(),
            b"user\0postgres\0\0ignored",
            b"user\0postgres\0",
            b"user\0postgres\0key\0",
            b"user\0postgres\0bad\0\xff\0\0",
        ] {
            assert!(startup_parameter(&startup(body), "user").is_err());
        }
        let mut length_mismatch = packet.clone();
        length_mismatch.push(0);
        assert!(startup_parameters(&length_mismatch).is_err());
        let mut unsupported = packet;
        unsupported[7] = 2;
        assert!(startup_parameters(&unsupported).is_err());
        Ok(())
    }

    #[test]
    fn frame_reader_buffers_split_messages() -> Result<()> {
        let query = b"Q\0\0\0\rSELECT 1\0";
        let mut reader = FrontendFrameReader::default();
        assert!(reader.push(&query[..3])?.is_empty());
        assert_eq!(reader.push(&query[3..])?, vec![query.to_vec()]);
        Ok(())
    }

    #[test]
    fn classifies_startup_and_control_packets() -> Result<()> {
        let mut startup = Vec::new();
        startup.extend_from_slice(&8_i32.to_be_bytes());
        startup.extend_from_slice(&PROTOCOL_3.to_be_bytes());
        assert_eq!(
            classify_frontend_message(&startup)?,
            FrontendFrameKind::Startup
        );

        let mut ssl = Vec::new();
        ssl.extend_from_slice(&8_i32.to_be_bytes());
        ssl.extend_from_slice(&SSL_REQUEST_CODE.to_be_bytes());
        assert_eq!(
            classify_frontend_message(&ssl)?,
            FrontendFrameKind::SslOrGssRequest
        );
        Ok(())
    }
}
