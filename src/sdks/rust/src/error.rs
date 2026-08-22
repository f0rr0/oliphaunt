use std::error;
use std::fmt;
use std::str;

/// Result alias used by the native SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Error type for SDK configuration, lifecycle, and engine execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The owner executor has stopped.
    EngineStopped,
    /// A runtime returned an execution failure.
    Engine(String),
    /// PostgreSQL returned an ErrorResponse.
    Postgres(Box<PostgresError>),
    /// A transaction is active, so work must use its transaction handle.
    TransactionActive,
    /// A configuration value was invalid.
    InvalidConfig(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineStopped => f.write_str("native engine executor has stopped"),
            Self::Engine(message) => f.write_str(message),
            Self::Postgres(error) => error.fmt(f),
            Self::TransactionActive => {
                f.write_str("a transaction is active; use the active transaction handle")
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
    pub(crate) fn from_fields(fields: Vec<PostgresErrorField>) -> Self {
        Self {
            severity: field_value(&fields, b'V').or_else(|| field_value(&fields, b'S')),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonlocalized_severity_takes_precedence() {
        let error = PostgresError::from_fields(vec![
            PostgresErrorField {
                code: b'S',
                value: "ERREUR".to_owned(),
            },
            PostgresErrorField {
                code: b'V',
                value: "ERROR".to_owned(),
            },
            PostgresErrorField {
                code: b'M',
                value: "failure".to_owned(),
            },
        ]);
        assert_eq!(error.severity.as_deref(), Some("ERROR"));
    }
}
