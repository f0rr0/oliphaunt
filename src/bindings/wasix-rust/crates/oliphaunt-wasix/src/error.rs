use std::{convert::Infallible, error, fmt, sync::Arc};

/// Stable, programmatically useful classification for an Oliphaunt failure.
///
/// The concrete [`Error`] remains opaque so implementation and platform
/// details can evolve without breaking callers. Match this non-exhaustive enum
/// with a wildcard arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorKind {
    /// A builder option, storage descriptor, or extension selection is invalid.
    InvalidConfiguration,
    /// The database or server is closing, closed, or its owner has stopped.
    Lifecycle,
    /// An operation conflicts with an active managed transaction.
    TransactionActive,
    /// PostgreSQL returned a structured backend `ErrorResponse`.
    Postgres,
    /// A transport, runtime, protocol, callback, or other failure.
    Other,
}

/// Error returned by the Oliphaunt Rust WASIX API.
#[derive(Clone)]
pub struct Error {
    kind: ErrorKind,
    inner: Arc<anyhow::Error>,
}

#[derive(Debug)]
struct ClassifiedCause {
    kind: ErrorKind,
    message: String,
}

#[derive(Debug, Clone)]
struct TransactionRollbackCause {
    callback: Box<Error>,
    rollback: Box<Error>,
}

#[derive(Debug, Clone)]
struct TransactionCallbackAndDatabaseCause {
    callback: Box<Error>,
    database: Box<Error>,
}

/// Result returned by the Oliphaunt Rust WASIX API.
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

impl Error {
    /// Return the stable category of this failure.
    pub const fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// Return structured PostgreSQL error details when the failure came from
    /// a backend `ErrorResponse`.
    pub fn postgres_error(&self) -> Option<&crate::PostgresError> {
        self.inner.downcast_ref()
    }

    /// Return both failures when a transaction callback and rollback failed.
    pub fn transaction_rollback_errors(&self) -> Option<(&Error, &Error)> {
        self.inner
            .downcast_ref::<TransactionRollbackCause>()
            .map(|error| (error.callback.as_ref(), error.rollback.as_ref()))
    }

    /// Return both failures when a callback error follows an independent
    /// database or protocol failure. This pair never implies that rollback ran.
    pub fn transaction_callback_database_errors(&self) -> Option<(&Error, &Error)> {
        self.inner
            .downcast_ref::<TransactionCallbackAndDatabaseCause>()
            .map(|error| (error.callback.as_ref(), error.database.as_ref()))
    }

    /// Return structured frontend-program failure details for `pg_dump` or `psql`.
    #[cfg(feature = "tools")]
    pub fn tool_error(&self) -> Option<&crate::tools::PostgresToolError> {
        self.inner.downcast_ref()
    }

    pub(crate) fn from_anyhow(inner: anyhow::Error) -> Self {
        let kind = inner
            .downcast_ref::<ClassifiedCause>()
            .map(|cause| cause.kind)
            .or_else(|| {
                inner
                    .downcast_ref::<crate::PostgresError>()
                    .map(|_| ErrorKind::Postgres)
            })
            .unwrap_or(ErrorKind::Other);
        Self {
            kind,
            inner: Arc::new(inner),
        }
    }

    pub(crate) fn message(message: impl fmt::Display + fmt::Debug + Send + Sync + 'static) -> Self {
        Self::from_anyhow(anyhow::Error::msg(message))
    }

    pub(crate) fn lifecycle(message: impl fmt::Display + Send + Sync + 'static) -> Self {
        Self::classified(ErrorKind::Lifecycle, message)
    }

    pub(crate) fn transaction_active(message: impl fmt::Display + Send + Sync + 'static) -> Self {
        Self::classified(ErrorKind::TransactionActive, message)
    }

    fn classified(kind: ErrorKind, message: impl fmt::Display + Send + Sync + 'static) -> Self {
        Self::from_anyhow(classified_anyhow(kind, message))
    }

    pub(crate) fn transaction_rollback(callback: Self, rollback: Self) -> Self {
        Self::from_anyhow(anyhow::Error::new(TransactionRollbackCause {
            callback: Box::new(callback),
            rollback: Box::new(rollback),
        }))
    }

    pub(crate) fn transaction_callback_and_database(callback: Self, database: Self) -> Self {
        Self::from_anyhow(anyhow::Error::new(TransactionCallbackAndDatabaseCause {
            callback: Box::new(callback),
            database: Box::new(database),
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
        Some(self.inner.as_ref().as_ref())
    }
}

impl fmt::Display for ClassifiedCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}

impl error::Error for ClassifiedCause {}

pub(crate) fn classified_anyhow(
    kind: ErrorKind,
    message: impl fmt::Display + Send + Sync + 'static,
) -> anyhow::Error {
    anyhow::Error::new(ClassifiedCause {
        kind,
        message: message.to_string(),
    })
}

pub(crate) fn invalid_configuration(
    message: impl fmt::Display + Send + Sync + 'static,
) -> anyhow::Error {
    classified_anyhow(ErrorKind::InvalidConfiguration, message)
}

pub(crate) fn lifecycle(message: impl fmt::Display + Send + Sync + 'static) -> anyhow::Error {
    classified_anyhow(ErrorKind::Lifecycle, message)
}

pub(crate) fn transaction_active(
    message: impl fmt::Display + Send + Sync + 'static,
) -> anyhow::Error {
    classified_anyhow(ErrorKind::TransactionActive, message)
}

impl fmt::Display for TransactionRollbackCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "transaction callback failed: {}; rollback also failed: {}",
            self.callback, self.rollback
        )
    }
}

impl error::Error for TransactionRollbackCause {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        Some(self.callback.as_ref())
    }
}

impl fmt::Display for TransactionCallbackAndDatabaseCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "transaction callback failed: {}; an independent database failure also occurred: {}",
            self.callback, self.database
        )
    }
}

impl error::Error for TransactionCallbackAndDatabaseCause {
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
        assert_eq!(error.kind(), ErrorKind::Postgres);
        assert_eq!(
            error
                .postgres_error()
                .and_then(|error| error.sqlstate.as_deref()),
            Some("23505")
        );
        assert!(error::Error::source(&error).is_some());

        let replay = error.clone();
        assert_eq!(replay.postgres_error(), error.postgres_error());
        assert_eq!(replay.to_string(), error.to_string());
    }

    #[test]
    fn typed_classification_survives_anyhow_context_without_message_inference() {
        use anyhow::Context as _;

        let invalid = Err::<(), _>(invalid_configuration("invalid storage"))
            .context("open database")
            .unwrap_err();
        assert_eq!(
            Error::from_anyhow(invalid).kind(),
            ErrorKind::InvalidConfiguration
        );

        let same_words = Error::message("invalid storage");
        assert_eq!(same_words.kind(), ErrorKind::Other);
        assert_eq!(Error::lifecycle("closed").kind(), ErrorKind::Lifecycle);
        assert_eq!(
            Error::transaction_active("active transaction").kind(),
            ErrorKind::TransactionActive
        );
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
        let (callback, rollback) = error
            .transaction_rollback_errors()
            .expect("callback and rollback failures remain typed");
        assert_eq!(callback.to_string(), "callback failed");
        assert_eq!(rollback.to_string(), "rollback failed");

        let transaction = TransactionError::CallbackAndDatabase {
            callback: Error::message("callback failed"),
            database: Error::message("stream recovery failed"),
        };
        assert!(transaction.rollback_error().is_none());
        assert_eq!(
            transaction
                .database_error()
                .map(ToString::to_string)
                .as_deref(),
            Some("stream recovery failed")
        );
        let flattened: Error = transaction.into();
        let (callback, database) = flattened
            .transaction_callback_database_errors()
            .expect("callback and independent database failure remain typed");
        assert_eq!(callback.to_string(), "callback failed");
        assert_eq!(database.to_string(), "stream recovery failed");

        let panic =
            RawStreamError::<Infallible>::CallbackPanicked(Error::message("callback panicked"));
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
