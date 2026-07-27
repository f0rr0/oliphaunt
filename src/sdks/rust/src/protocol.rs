use crate::error::{Error, Result};

/// Raw PostgreSQL frontend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolRequest {
    bytes: Vec<u8>,
}

impl ProtocolRequest {
    /// Create a raw protocol request.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            bytes: bytes.into(),
        }
    }

    /// Create a PostgreSQL simple-query protocol request.
    pub fn simple_query(sql: &str) -> Result<Self> {
        if sql.as_bytes().contains(&0) {
            return Err(Error::Engine(
                "simple query SQL must not contain NUL bytes".to_owned(),
            ));
        }
        let mut body = Vec::new();
        body.extend_from_slice(sql.as_bytes());
        body.push(0);

        let len = i32::try_from(body.len() + 4)
            .map_err(|_| Error::Engine("simple query protocol message is too large".to_owned()))?;
        let mut packet = Vec::with_capacity(body.len() + 5);
        packet.push(b'Q');
        packet.extend_from_slice(&len.to_be_bytes());
        packet.extend_from_slice(&body);
        Ok(Self { bytes: packet })
    }

    /// Borrow the raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Consume into raw bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl From<Vec<u8>> for ProtocolRequest {
    fn from(bytes: Vec<u8>) -> Self {
        Self::new(bytes)
    }
}

impl From<&[u8]> for ProtocolRequest {
    fn from(bytes: &[u8]) -> Self {
        Self::new(bytes)
    }
}

/// Raw PostgreSQL backend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolResponse {
    bytes: Vec<u8>,
}

impl ProtocolResponse {
    /// Create a raw protocol response.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            bytes: bytes.into(),
        }
    }

    /// Borrow the raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Consume into raw bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_query_rejects_nul_sql_before_building_protocol() {
        assert_eq!(
            ProtocolRequest::simple_query("SELECT 1\0SELECT 2").unwrap_err(),
            Error::Engine("simple query SQL must not contain NUL bytes".to_owned())
        );
    }

    #[test]
    fn simple_query_builds_cstring_frontend_frame() {
        let request = ProtocolRequest::simple_query("SELECT 1").unwrap();
        assert_eq!(
            request.as_bytes(),
            &[
                b'Q', 0, 0, 0, 13, b'S', b'E', b'L', b'E', b'C', b'T', b' ', b'1', 0
            ]
        );
    }
}
