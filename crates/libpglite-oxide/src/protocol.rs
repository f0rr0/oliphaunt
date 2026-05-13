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
    pub fn simple_query(sql: &str) -> Self {
        let mut body = Vec::new();
        body.extend_from_slice(sql.as_bytes());
        body.push(0);

        let mut packet = Vec::with_capacity(body.len() + 5);
        packet.push(b'Q');
        packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        packet.extend_from_slice(&body);
        Self { bytes: packet }
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
