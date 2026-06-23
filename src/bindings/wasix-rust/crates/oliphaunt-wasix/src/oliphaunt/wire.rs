use anyhow::{Context, Result, anyhow, bail};

use crate::oliphaunt::config::StartupConfig;

pub(crate) const SSL_REQUEST_CODE: i32 = 80_877_103;
pub(crate) const GSSENC_REQUEST_CODE: i32 = 80_877_104;
pub(crate) const CANCEL_REQUEST_CODE: i32 = 80_877_102;
pub(crate) const PROTOCOL_3: i32 = 196_608;
pub(crate) const MAX_FRONTEND_MESSAGE: usize = 128 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct FrontendFrameReader {
    buffer: Vec<u8>,
}

impl FrontendFrameReader {
    pub(crate) fn push(&mut self, input: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.buffer.extend_from_slice(input);
        let mut messages = Vec::new();

        loop {
            let Some(message_len) = frontend_message_len_if_complete(&self.buffer)? else {
                break;
            };
            messages.push(self.buffer.drain(..message_len).collect());
        }

        Ok(messages)
    }

    pub(crate) fn pending(&self) -> &[u8] {
        &self.buffer
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrontendFrameKind {
    Protocol,
    Startup,
    SslOrGssRequest,
    CancelRequest,
    Terminate,
}

pub(crate) fn frontend_message_len_if_complete(buffer: &[u8]) -> Result<Option<usize>> {
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

pub(crate) fn raw_protocol_message_len(buffer: &[u8]) -> Result<usize> {
    if buffer.len() < 5 {
        bail!("raw protocol stream input contains an incomplete frontend message header");
    }
    let len = i32::from_be_bytes(buffer[1..5].try_into().unwrap());
    if len < 4 {
        bail!("raw protocol stream input contains invalid frontend message length {len}");
    }
    let total = 1usize
        .checked_add(len as usize)
        .ok_or_else(|| anyhow!("raw protocol stream frontend message length overflow"))?;
    if total > MAX_FRONTEND_MESSAGE {
        bail!("raw protocol stream frontend message length {total} exceeds limit");
    }
    if buffer.len() < total {
        bail!(
            "raw protocol stream input contains incomplete frontend message: expected {total} bytes, got {}",
            buffer.len()
        );
    }
    Ok(total)
}

pub(crate) fn classify_frontend_message(message: &[u8]) -> Result<FrontendFrameKind> {
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

pub(crate) fn startup_parameter<'a>(message: &'a [u8], wanted: &str) -> Result<Option<&'a str>> {
    if message.len() < 8 {
        bail!("startup packet is too short");
    }
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
        if key == wanted {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

pub(crate) fn startup_config_for_message(
    base: &StartupConfig,
    message: &[u8],
) -> Result<StartupConfig> {
    let mut config = base.clone();
    if let Some(user) = startup_parameter(message, "user")? {
        config.username = user.to_owned();
    }
    if let Some(database) = startup_parameter(message, "database")? {
        config.database = database.to_owned();
    }
    config.validate()?;
    Ok(config)
}

pub(crate) fn response_contains_error(response: &[u8]) -> bool {
    response_contains_tag(response, b'E')
}

pub(crate) fn response_contains_tag(response: &[u8], expected: u8) -> bool {
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

pub(crate) fn error_response(severity: &str, code: &str, message: &str) -> Vec<u8> {
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

pub(crate) fn simple_query_message(sql: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(sql.len() + 6);
    message.push(b'Q');
    message.extend_from_slice(&((sql.len() + 5) as i32).to_be_bytes());
    message.extend_from_slice(sql.as_bytes());
    message.push(0);
    message
}

fn push_error_field(body: &mut Vec<u8>, tag: u8, value: &str) {
    body.push(tag);
    body.extend_from_slice(value.as_bytes());
    body.push(0);
}

#[cfg(test)]
mod tests {
    use super::*;

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
