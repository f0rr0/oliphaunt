use std::error;
use std::fmt;
use std::str;

/// Result alias used by the native SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Error type for SDK configuration, lifecycle, and engine execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A database root was required but not configured.
    MissingDatabaseRoot,
    /// The selected engine mode cannot provide the requested client sessions.
    UnsupportedClientSessions {
        /// Engine mode that rejected the request.
        mode: crate::EngineMode,
        /// Requested client sessions.
        requested: usize,
        /// Maximum supported client sessions.
        supported: usize,
    },
    /// No concrete native runtime has been linked into the builder.
    RuntimeUnavailable {
        /// Engine mode the caller attempted to open.
        mode: crate::EngineMode,
    },
    /// The selected runtime does not implement the selected engine mode.
    UnsupportedEngineMode {
        /// Engine mode the caller attempted to open.
        mode: crate::EngineMode,
        /// Reason this runtime cannot serve the mode.
        reason: String,
    },
    /// The owner executor has stopped.
    EngineStopped,
    /// A runtime returned an execution failure.
    Engine(String),
    /// PostgreSQL returned an ErrorResponse.
    Postgres(PostgresError),
    /// A session pin is already active, so unpinned work would violate session
    /// isolation.
    SessionPinned,
    /// A session pin token no longer owns the physical session.
    InvalidSessionPin,
    /// A configuration value was invalid.
    InvalidConfig(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingDatabaseRoot => {
                f.write_str("database root is not configured; call path or temporary")
            }
            Self::UnsupportedClientSessions {
                mode,
                requested,
                supported,
            } => write!(
                f,
                "{mode} supports at most {supported} client session(s), requested {requested}"
            ),
            Self::RuntimeUnavailable { mode } => write!(
                f,
                "no native runtime is linked for {mode}; provide a NativeRuntime implementation"
            ),
            Self::UnsupportedEngineMode { mode, reason } => {
                write!(f, "{mode} is not supported by this runtime: {reason}")
            }
            Self::EngineStopped => f.write_str("native engine executor has stopped"),
            Self::Engine(message) => f.write_str(message),
            Self::Postgres(error) => error.fmt(f),
            Self::SessionPinned => {
                f.write_str("physical session is pinned; use the active SessionPin")
            }
            Self::InvalidSessionPin => {
                f.write_str("session pin is not active for this physical session")
            }
            Self::InvalidConfig(message) => f.write_str(message),
        }
    }
}

impl error::Error for Error {}

/// Structured PostgreSQL `ErrorResponse` decoded from backend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresError {
    /// Backend severity, such as `ERROR` or `FATAL`.
    pub severity: Option<String>,
    /// SQLSTATE code, such as `23505` for unique violations.
    pub sqlstate: Option<String>,
    /// Primary human-readable PostgreSQL error message.
    pub message: String,
    /// Optional detailed explanation from PostgreSQL.
    pub detail: Option<String>,
    /// Optional hint from PostgreSQL.
    pub hint: Option<String>,
    /// Optional source statement position.
    pub position: Option<String>,
    /// Optional context stack, exposed as `where` by PostgreSQL.
    pub where_: Option<String>,
    /// Optional schema name reported by PostgreSQL.
    pub schema_name: Option<String>,
    /// Optional table name reported by PostgreSQL.
    pub table_name: Option<String>,
    /// Optional column name reported by PostgreSQL.
    pub column_name: Option<String>,
    /// Optional data type name reported by PostgreSQL.
    pub data_type_name: Option<String>,
    /// Optional constraint name reported by PostgreSQL.
    pub constraint_name: Option<String>,
    /// Raw ErrorResponse fields in backend order.
    pub fields: Vec<PostgresErrorField>,
}

impl PostgresError {
    /// Build a structured PostgreSQL error from raw protocol fields.
    pub fn from_fields(fields: Vec<PostgresErrorField>) -> Self {
        Self {
            severity: field_value(&fields, b'S').or_else(|| field_value(&fields, b'V')),
            sqlstate: field_value(&fields, b'C'),
            message: field_value(&fields, b'M')
                .unwrap_or_else(|| "PostgreSQL ErrorResponse".to_owned()),
            detail: field_value(&fields, b'D'),
            hint: field_value(&fields, b'H'),
            position: field_value(&fields, b'P'),
            where_: field_value(&fields, b'W'),
            schema_name: field_value(&fields, b's'),
            table_name: field_value(&fields, b't'),
            column_name: field_value(&fields, b'c'),
            data_type_name: field_value(&fields, b'd'),
            constraint_name: field_value(&fields, b'n'),
            fields,
        }
    }

    pub(crate) fn fallback() -> Self {
        Self::from_fields(vec![PostgresErrorField {
            code: b'M',
            value: "PostgreSQL ErrorResponse".to_owned(),
        }])
    }
}

impl fmt::Display for PostgresError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.severity, &self.sqlstate) {
            (Some(severity), Some(sqlstate)) => {
                write!(f, "{severity} [{sqlstate}]: {}", self.message)
            }
            (Some(severity), None) => write!(f, "{severity}: {}", self.message),
            (None, Some(sqlstate)) => write!(f, "[{sqlstate}]: {}", self.message),
            (None, None) => f.write_str(&self.message),
        }
    }
}

/// One raw field from a PostgreSQL `ErrorResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresErrorField {
    /// Single-byte PostgreSQL field code.
    pub code: u8,
    /// Field value decoded as UTF-8.
    pub value: String,
}

pub(crate) fn parse_postgres_error_response(mut body: &[u8]) -> PostgresError {
    let mut fields = Vec::new();
    while let Some((&code, rest)) = body.split_first() {
        body = rest;
        if code == 0 {
            break;
        }
        let Some((value, remaining)) = read_error_cstring(body) else {
            return PostgresError::fallback();
        };
        fields.push(PostgresErrorField { code, value });
        body = remaining;
    }
    PostgresError::from_fields(fields)
}

fn field_value(fields: &[PostgresErrorField], code: u8) -> Option<String> {
    fields
        .iter()
        .find(|field| field.code == code)
        .map(|field| field.value.clone())
}

fn read_error_cstring(input: &[u8]) -> Option<(String, &[u8])> {
    let nul = input.iter().position(|byte| *byte == 0)?;
    let value = str::from_utf8(&input[..nul]).ok()?.to_owned();
    Some((value, &input[nul + 1..]))
}
