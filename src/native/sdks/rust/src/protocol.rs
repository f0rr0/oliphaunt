use crate::error::{Error, Result};
use crate::query_core;

/// Raw PostgreSQL frontend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProtocolRequest {
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
        query_core::simple_query(sql)
            .map(Self::new)
            .map_err(|error| match error {
                query_core::Error::Protocol(message) => Error::Engine(message),
                query_core::Error::Postgres { .. } => {
                    unreachable!("frontend encoding cannot produce a backend diagnostic")
                }
            })
    }

    /// Borrow the raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
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
pub(crate) struct ProtocolResponse {
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
        let error = ProtocolRequest::simple_query("SELECT 1\0SELECT 2").unwrap_err();

        assert_eq!(error.kind(), crate::error::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            "simple query SQL must not contain NUL bytes"
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
