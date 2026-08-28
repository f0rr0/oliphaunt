use std::convert::Infallible;
use std::error;
use std::fmt;

pub use crate::query_core::{PostgresError, PostgresErrorField};

/// Result alias used by the native SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Result returned by a callback-scoped transaction.
///
/// `E` is the callback's application error type. The default keeps callbacks
/// which use only SDK errors concise.
pub type TransactionResult<T, E = Error> = std::result::Result<T, TransactionError<E>>;

/// Result returned by raw protocol streaming.
///
/// `E` is the callback's parser or application error type. The default is
/// [`Infallible`] for callbacks which cannot fail deliberately.
pub type RawStreamResult<T, E = Infallible> = std::result::Result<T, RawStreamError<E>>;

mod raw_stream_callback_output {
    pub trait Sealed {}

    impl Sealed for () {}
    impl<E> Sealed for std::result::Result<(), E> {}
}

/// Supported return values from a raw protocol stream callback.
///
/// Return `()` for an infallible callback or `Result<(), E>` to stop delivery
/// with a typed parser or application error. This trait is sealed so the two
/// stable callback forms remain exhaustive.
pub trait RawStreamCallbackOutput: raw_stream_callback_output::Sealed {
    /// Typed callback failure, or [`Infallible`] for a callback returning `()`.
    type Error;

    /// Convert the callback output into its typed result.
    #[doc(hidden)]
    fn into_raw_stream_callback_result(self) -> std::result::Result<(), Self::Error>;
}

impl RawStreamCallbackOutput for () {
    type Error = Infallible;

    fn into_raw_stream_callback_result(self) -> std::result::Result<(), Self::Error> {
        Ok(())
    }
}

impl<E> RawStreamCallbackOutput for std::result::Result<(), E> {
    type Error = E;

    fn into_raw_stream_callback_result(self) -> std::result::Result<(), Self::Error> {
        self
    }
}

/// Error from a callback-scoped transaction.
///
/// Callback code follows the Diesel/sqlx convention `E: From<Error>`, allowing
/// SQL operations to use `?` while deliberate business aborts remain the
/// caller's concrete `E`. If both the callback and rollback fail, both typed
/// causes remain available.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum TransactionError<E> {
    /// `BEGIN`, `COMMIT`, explicit settlement, or another SDK operation failed.
    Database(Error),
    /// The callback deliberately aborted with an application error.
    Callback(E),
    /// The callback returned an error and an attempted rollback failed, possibly
    /// together with releasing the transaction's owner pin.
    CallbackAndRollback {
        /// Error returned by the callback.
        callback: E,
        /// Error returned while rolling back or releasing the transaction pin.
        rollback: Error,
    },
    /// The callback returned an error after an independent database, transport,
    /// or protocol-recovery failure had already expired the transaction. No
    /// rollback was attempted.
    CallbackAndDatabase {
        /// Error returned by the callback.
        callback: E,
        /// Independent SDK, database, transport, or recovery failure.
        database: Error,
    },
}

impl<E> TransactionError<E> {
    /// Wrap a deliberate application-level transaction abort.
    pub fn callback(error: E) -> Self {
        Self::Callback(error)
    }

    /// Return the application error, including when rollback also failed.
    pub fn callback_error(&self) -> Option<&E> {
        match self {
            Self::Callback(error) => Some(error),
            Self::CallbackAndRollback { callback, .. } => Some(callback),
            Self::CallbackAndDatabase { callback, .. } => Some(callback),
            Self::Database(_) => None,
        }
    }

    /// Return the SDK failure which occurred before callback settlement.
    pub fn database_error(&self) -> Option<&Error> {
        match self {
            Self::Database(error)
            | Self::CallbackAndDatabase {
                database: error, ..
            } => Some(error),
            Self::Callback(_) | Self::CallbackAndRollback { .. } => None,
        }
    }

    /// Return the attempted rollback or transaction-pin release failure.
    pub fn rollback_error(&self) -> Option<&Error> {
        match self {
            Self::CallbackAndRollback { rollback, .. } => Some(rollback),
            Self::Database(_) | Self::Callback(_) | Self::CallbackAndDatabase { .. } => None,
        }
    }
}

impl<E> From<Error> for TransactionError<E> {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

impl From<TransactionError<Error>> for Error {
    fn from(error: TransactionError<Error>) -> Self {
        match error {
            TransactionError::Database(error) => error,
            TransactionError::Callback(error) => error,
            TransactionError::CallbackAndRollback { callback, rollback } => {
                Self::transaction_rollback(callback, rollback)
            }
            TransactionError::CallbackAndDatabase { callback, database } => {
                Self::transaction_callback_and_database(callback, database)
            }
        }
    }
}

impl<E> fmt::Display for TransactionError<E>
where
    E: fmt::Display,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Callback(error) => error.fmt(f),
            Self::CallbackAndRollback { callback, rollback } => write!(
                f,
                "transaction callback failed: {callback}; rollback also failed: {rollback}"
            ),
            Self::CallbackAndDatabase { callback, database } => write!(
                f,
                "transaction callback failed: {callback}; an independent database failure also occurred: {database}"
            ),
        }
    }
}

impl<E> error::Error for TransactionError<E>
where
    E: error::Error + 'static,
{
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Callback(error) => Some(error),
            Self::CallbackAndRollback { callback, .. }
            | Self::CallbackAndDatabase { callback, .. } => Some(callback),
        }
    }
}

/// Error from raw PostgreSQL protocol streaming.
///
/// A callback error is returned only after the runtime confirms recovery to
/// `ReadyForQuery`. An independent runtime or transport failure is represented
/// by [`Self::Database`] and remains authoritative.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RawStreamError<E> {
    /// The SDK, runtime, transport, or recovery operation failed.
    Database(Error),
    /// The runtime recovered successfully after the callback returned this
    /// parser or application error.
    Callback(E),
    /// An owner-thread callback panicked after the runtime confirmed
    /// `ReadyForQuery`. Blocking APIs resume the original unwind instead.
    CallbackPanicked(Error),
}

impl<E> RawStreamError<E> {
    /// Return the recovered callback error.
    pub fn callback_error(&self) -> Option<&E> {
        match self {
            Self::Callback(error) => Some(error),
            Self::Database(_) | Self::CallbackPanicked(_) => None,
        }
    }

    /// Return the authoritative SDK or recovery failure.
    pub fn database_error(&self) -> Option<&Error> {
        match self {
            Self::Database(error) => Some(error),
            Self::Callback(_) | Self::CallbackPanicked(_) => None,
        }
    }

    /// Return a recovered owner-thread callback panic. This is distinct from
    /// an independent database/recovery failure and does not imply poisoning.
    pub fn callback_panic_error(&self) -> Option<&Error> {
        match self {
            Self::CallbackPanicked(error) => Some(error),
            Self::Database(_) | Self::Callback(_) => None,
        }
    }
}

impl<E> From<Error> for RawStreamError<E> {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

impl From<RawStreamError<Infallible>> for Error {
    fn from(error: RawStreamError<Infallible>) -> Self {
        match error {
            RawStreamError::Database(error) => error,
            RawStreamError::Callback(never) => match never {},
            RawStreamError::CallbackPanicked(error) => error,
        }
    }
}

impl From<RawStreamError<Error>> for Error {
    fn from(error: RawStreamError<Error>) -> Self {
        match error {
            RawStreamError::Database(error)
            | RawStreamError::Callback(error)
            | RawStreamError::CallbackPanicked(error) => error,
        }
    }
}

impl<E> fmt::Display for RawStreamError<E>
where
    E: fmt::Display,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Callback(error) => error.fmt(f),
            Self::CallbackPanicked(error) => error.fmt(f),
        }
    }
}

impl<E> error::Error for RawStreamError<E>
where
    E: error::Error + 'static,
{
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Callback(error) => Some(error),
            Self::CallbackPanicked(error) => Some(error),
        }
    }
}

pub(crate) const SESSION_STATE_UNKNOWN: &str =
    "PostgreSQL session state is unknown; close the database";

/// Stable category for an Oliphaunt SDK error.
///
/// Match this value when an application needs recovery policy. The concrete
/// [`Error`] remains opaque so implementation details and platform-specific
/// causes can evolve without expanding a public error enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorKind {
    /// A builder option or other caller-supplied configuration is invalid.
    InvalidConfiguration,
    /// The requested work crossed a database or owner lifecycle boundary.
    Lifecycle,
    /// Root work was rejected because a callback transaction owns the session.
    TransactionActive,
    /// PostgreSQL returned a structured `ErrorResponse`.
    Postgres,
    /// An engine, protocol, storage, transport, callback, or other failure.
    Other,
}

/// Opaque error returned by the native Rust SDK.
#[derive(Debug, Clone)]
pub struct Error {
    inner: ErrorInner,
}

#[derive(Debug, Clone)]
enum ErrorInner {
    EngineStopped,
    Engine(String),
    Postgres(Box<PostgresError>),
    TransactionActive,
    TransactionRollback {
        callback: Box<Error>,
        rollback: Box<Error>,
    },
    TransactionCallbackAndDatabase {
        callback: Box<Error>,
        database: Box<Error>,
    },
    InvalidConfiguration(String),
}

impl Error {
    /// Return the stable recovery category for this failure.
    pub const fn kind(&self) -> ErrorKind {
        match &self.inner {
            ErrorInner::EngineStopped => ErrorKind::Lifecycle,
            ErrorInner::Postgres(_) => ErrorKind::Postgres,
            ErrorInner::TransactionActive => ErrorKind::TransactionActive,
            ErrorInner::InvalidConfiguration(_) => ErrorKind::InvalidConfiguration,
            ErrorInner::Engine(_)
            | ErrorInner::TransactionRollback { .. }
            | ErrorInner::TransactionCallbackAndDatabase { .. } => ErrorKind::Other,
        }
    }

    /// Return structured PostgreSQL diagnostics when this is a backend error.
    pub fn postgres_error(&self) -> Option<&PostgresError> {
        match &self.inner {
            ErrorInner::Postgres(error) => Some(error.as_ref()),
            _ => None,
        }
    }

    /// Return both failures when a transaction callback and rollback failed.
    pub fn transaction_rollback_errors(&self) -> Option<(&Error, &Error)> {
        match &self.inner {
            ErrorInner::TransactionRollback { callback, rollback } => {
                Some((callback.as_ref(), rollback.as_ref()))
            }
            _ => None,
        }
    }

    /// Return both failures when a callback error follows an independent
    /// database or protocol failure. This pair never implies that rollback ran.
    pub fn transaction_callback_database_errors(&self) -> Option<(&Error, &Error)> {
        match &self.inner {
            ErrorInner::TransactionCallbackAndDatabase { callback, database } => {
                Some((callback.as_ref(), database.as_ref()))
            }
            _ => None,
        }
    }

    #[allow(non_upper_case_globals)]
    pub(crate) const EngineStopped: Self = Self {
        inner: ErrorInner::EngineStopped,
    };

    #[allow(non_upper_case_globals)]
    pub(crate) const TransactionActive: Self = Self {
        inner: ErrorInner::TransactionActive,
    };

    #[allow(non_snake_case)]
    pub(crate) fn Engine(message: String) -> Self {
        Self {
            inner: ErrorInner::Engine(message),
        }
    }

    #[allow(non_snake_case)]
    pub(crate) fn Postgres(error: Box<PostgresError>) -> Self {
        Self {
            inner: ErrorInner::Postgres(error),
        }
    }

    #[allow(non_snake_case)]
    pub(crate) fn InvalidConfig(message: String) -> Self {
        Self {
            inner: ErrorInner::InvalidConfiguration(message),
        }
    }

    fn transaction_rollback(callback: Self, rollback: Self) -> Self {
        Self {
            inner: ErrorInner::TransactionRollback {
                callback: Box::new(callback),
                rollback: Box::new(rollback),
            },
        }
    }

    fn transaction_callback_and_database(callback: Self, database: Self) -> Self {
        Self {
            inner: ErrorInner::TransactionCallbackAndDatabase {
                callback: Box::new(callback),
                database: Box::new(database),
            },
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.inner {
            ErrorInner::EngineStopped => f.write_str("native database session has stopped"),
            ErrorInner::Engine(message) => f.write_str(message),
            ErrorInner::Postgres(error) => error.fmt(f),
            ErrorInner::TransactionActive => {
                f.write_str("a transaction is active; use the active transaction handle")
            }
            ErrorInner::TransactionRollback { callback, rollback } => write!(
                f,
                "transaction callback failed: {callback}; rollback also failed: {rollback}"
            ),
            ErrorInner::TransactionCallbackAndDatabase { callback, database } => write!(
                f,
                "transaction callback failed: {callback}; an independent database failure also occurred: {database}"
            ),
            ErrorInner::InvalidConfiguration(message) => f.write_str(message),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match &self.inner {
            ErrorInner::Postgres(error) => Some(error.as_ref()),
            ErrorInner::TransactionRollback { callback, .. }
            | ErrorInner::TransactionCallbackAndDatabase { callback, .. } => {
                Some(callback.as_ref())
            }
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

    #[test]
    fn stable_accessors_preserve_typed_failures() {
        let postgres = PostgresError::from_core(core::diagnostic(
            vec![core::DiagnosticField {
                code: b'C',
                value: "23505".to_owned(),
            }],
            "duplicate key",
        ));
        let postgres = Error::Postgres(Box::new(postgres));
        assert_eq!(
            postgres
                .postgres_error()
                .and_then(|error| error.sqlstate.as_deref()),
            Some("23505")
        );
        assert!(postgres.transaction_rollback_errors().is_none());

        let rollback = Error::transaction_rollback(
            Error::Engine("callback".to_owned()),
            Error::Engine("rollback".to_owned()),
        );
        let (callback, rollback_error) = rollback
            .transaction_rollback_errors()
            .expect("composite error remains typed");
        assert_eq!(callback.to_string(), "callback");
        assert_eq!(rollback_error.to_string(), "rollback");
        assert!(rollback.postgres_error().is_none());

        let transaction = TransactionError::CallbackAndDatabase {
            callback: Error::Engine("callback".to_owned()),
            database: Error::Engine("stream recovery".to_owned()),
        };
        assert!(transaction.rollback_error().is_none());
        assert_eq!(
            transaction
                .database_error()
                .map(ToString::to_string)
                .as_deref(),
            Some("stream recovery")
        );
        let flattened: Error = transaction.into();
        let (callback, database) = flattened
            .transaction_callback_database_errors()
            .expect("callback and independent database failure remain typed");
        assert_eq!(callback.to_string(), "callback");
        assert_eq!(database.to_string(), "stream recovery");

        let panic = RawStreamError::<Infallible>::CallbackPanicked(Error::Engine(
            "callback panicked".to_owned(),
        ));
        assert!(panic.database_error().is_none());
        assert_eq!(
            panic
                .callback_panic_error()
                .map(ToString::to_string)
                .as_deref(),
            Some("callback panicked")
        );
    }
}
