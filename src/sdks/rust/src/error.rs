use std::error;
use std::fmt;

pub use crate::query_core::{PostgresError, PostgresErrorField};

/// Result alias used by the native SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Error type for SDK configuration, lifecycle, and engine execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The native database session has stopped.
    EngineStopped,
    /// A runtime returned an execution failure.
    Engine(String),
    /// PostgreSQL returned an ErrorResponse.
    Postgres(Box<PostgresError>),
    /// A transaction is active, so work must use its transaction handle.
    TransactionActive,
    /// A transaction callback failed and the subsequent rollback failed too.
    TransactionRollback {
        /// Error returned by the transaction callback.
        callback: Box<Error>,
        /// Error returned while attempting to roll the transaction back.
        rollback: Box<Error>,
    },
    /// A configuration value was invalid.
    InvalidConfig(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineStopped => f.write_str("native database session has stopped"),
            Self::Engine(message) => f.write_str(message),
            Self::Postgres(error) => error.fmt(f),
            Self::TransactionActive => {
                f.write_str("a transaction is active; use the active transaction handle")
            }
            Self::TransactionRollback { callback, rollback } => write!(
                f,
                "transaction callback failed: {callback}; rollback also failed: {rollback}"
            ),
            Self::InvalidConfig(message) => f.write_str(message),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::Postgres(error) => Some(error.as_ref()),
            Self::TransactionRollback { callback, .. } => Some(callback.as_ref()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query_core as core;

    #[test]
    fn localized_severity_is_primary_and_both_forms_remain_available() {
        let fields = vec![
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
            PostgresErrorField {
                code: b'p',
                value: "12".to_owned(),
            },
            PostgresErrorField {
                code: b'q',
                value: "SELECT broken".to_owned(),
            },
            PostgresErrorField {
                code: b'F',
                value: "parse_expr.c".to_owned(),
            },
            PostgresErrorField {
                code: b'L',
                value: "123".to_owned(),
            },
            PostgresErrorField {
                code: b'R',
                value: "transformExpr".to_owned(),
            },
        ];
        let diagnostic_fields = fields
            .into_iter()
            .map(|field| core::DiagnosticField {
                code: field.code,
                value: field.value,
            })
            .collect();
        let error = PostgresError::from_core(core::diagnostic(
            diagnostic_fields,
            "PostgreSQL ErrorResponse",
        ));
        assert_eq!(error.severity.as_deref(), Some("ERREUR"));
        assert_eq!(error.localized_severity.as_deref(), Some("ERREUR"));
        assert_eq!(error.nonlocalized_severity.as_deref(), Some("ERROR"));
        assert_eq!(error.internal_position.as_deref(), Some("12"));
        assert_eq!(error.internal_query.as_deref(), Some("SELECT broken"));
        assert_eq!(error.file.as_deref(), Some("parse_expr.c"));
        assert_eq!(error.line.as_deref(), Some("123"));
        assert_eq!(error.routine.as_deref(), Some("transformExpr"));
    }
}
