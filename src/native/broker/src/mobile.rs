//! Mobile operation policy over the shared broker exchange records.
pub use crate::exchange::*;
use oliphaunt_query::wire::frontend_message_len_if_complete;
use std::io;

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

#[cfg(test)]
mod tests {
    use super::*;

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
