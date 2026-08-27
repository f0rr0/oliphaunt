use std::{error, fmt};

/// Error returned by the Oliphaunt Rust WASIX API.
pub struct Error {
    inner: anyhow::Error,
}

/// Structured failure produced when a transaction callback and its rollback
/// attempt both fail.
#[derive(Debug)]
pub struct TransactionRollbackError {
    /// Error returned by the transaction callback.
    pub callback: Box<Error>,
    /// Error returned while attempting to roll the transaction back.
    pub rollback: Box<Error>,
}

/// Result returned by the Oliphaunt Rust WASIX API.
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Return structured PostgreSQL error details when the failure came from
    /// a backend `ErrorResponse`.
    pub fn postgres_error(&self) -> Option<&crate::PostgresError> {
        self.inner.downcast_ref()
    }

    /// Return both typed failures when a transaction callback and its rollback
    /// attempt failed.
    pub fn transaction_rollback_error(&self) -> Option<&TransactionRollbackError> {
        self.inner.downcast_ref()
    }

    /// Return structured frontend-program failure details for `pg_dump` or `psql`.
    #[cfg(feature = "tools")]
    pub fn tool_error(&self) -> Option<&crate::tools::PostgresToolError> {
        self.inner.downcast_ref()
    }

    pub(crate) fn from_anyhow(inner: anyhow::Error) -> Self {
        Self { inner }
    }

    pub(crate) fn message(message: impl fmt::Display + fmt::Debug + Send + Sync + 'static) -> Self {
        Self::from_anyhow(anyhow::Error::msg(message))
    }

    pub(crate) fn transaction_rollback(callback: Self, rollback: Self) -> Self {
        Self::from_anyhow(anyhow::Error::new(TransactionRollbackError {
            callback: Box::new(callback),
            rollback: Box::new(rollback),
        }))
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.inner.fmt(f)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.inner.fmt(f)
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        Some(self.inner.as_ref())
    }
}

impl fmt::Display for TransactionRollbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "transaction callback failed: {}; rollback also failed: {}",
            self.callback, self.rollback
        )
    }
}

impl error::Error for TransactionRollbackError {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        Some(self.callback.as_ref())
    }
}

pub(crate) fn public_result<T>(result: anyhow::Result<T>) -> Result<T> {
    result.map_err(Error::from_anyhow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PostgresError, PostgresErrorField};

    #[test]
    fn postgres_error_finds_structured_backend_error() {
        let postgres = PostgresError {
            severity: Some("ERROR".to_owned()),
            localized_severity: None,
            nonlocalized_severity: Some("ERROR".to_owned()),
            sqlstate: Some("23505".to_owned()),
            message: "duplicate key".to_owned(),
            detail: None,
            hint: None,
            position: None,
            internal_position: None,
            internal_query: None,
            where_: None,
            schema_name: None,
            table_name: None,
            column_name: None,
            data_type_name: None,
            constraint_name: None,
            file: None,
            line: None,
            routine: None,
            fields: vec![PostgresErrorField {
                code: b'C',
                value: "23505".to_owned(),
            }],
            notices: Vec::new(),
        };
        let error = Error::from_anyhow(anyhow::Error::new(postgres));
        assert_eq!(
            error
                .postgres_error()
                .and_then(|error| error.sqlstate.as_deref()),
            Some("23505")
        );
        assert!(error::Error::source(&error).is_some());
    }

    #[test]
    fn transaction_rollback_error_preserves_both_typed_errors() {
        let error = Error::transaction_rollback(
            Error::message("callback failed"),
            Error::message("rollback failed"),
        );

        assert_eq!(
            error.to_string(),
            "transaction callback failed: callback failed; rollback also failed: rollback failed"
        );
        let composite = error
            .transaction_rollback_error()
            .expect("transaction failure remains structured");
        assert_eq!(composite.callback.to_string(), "callback failed");
        assert_eq!(composite.rollback.to_string(), "rollback failed");
    }
}
