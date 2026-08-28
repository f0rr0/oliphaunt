use std::borrow::Cow;
use std::cell::Cell;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::builder::{AsyncOliphauntServerBuilder, open_embedded_session, start_server_session};
use crate::cancellation::CancellationGate;
use crate::engine::{EngineSession, ProtocolStreamOutcome};
use crate::error::{
    Error, RawStreamCallbackOutput, RawStreamError, RawStreamResult, Result, SESSION_STATE_UNKNOWN,
    TransactionError, TransactionResult,
};
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{
    CommandResult, ExecResult, IntoParameter, Parameter, QueryResult, ReadyStatus,
    StatementDescription, ValueFormat, describe_statement_request, extended_statement_request,
    parse_exec_response, parse_extended_command_response, parse_extended_query_response,
    parse_simple_command_response, parse_statement_description, reject_copy_statements,
    reject_transaction_chain,
};
use crate::session::{
    TRANSACTION_ACTIVE, TRANSACTION_FAILED, TRANSACTION_FINISHING, TRANSACTION_RELEASED,
    TRANSACTION_ROLLED_BACK, TransactionGuard, begin_transaction, execute_structured_operation,
    execute_transaction_structured_operation, inactive_transaction_error,
};
use crate::storage::DatabaseStorage;

/// Builder for blocking native database handles.
///
/// Database topology and execution placement are independent: `.direct()` and
/// `.broker()` select where PostgreSQL lives. Operations through this builder's
/// handles complete before returning and add no SDK owner-thread queue. The
/// native runtime may still use its own backend thread. Use
/// [`crate::AsyncOliphauntBuilder`] for asynchronous, cloneable handles backed
/// by a dedicated SDK owner thread.
#[derive(Debug, Clone)]
pub struct OliphauntBuilder {
    inner: crate::builder::AsyncOliphauntBuilder,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self {
            inner: crate::builder::AsyncOliphauntBuilder::new(),
        }
    }
}

impl OliphauntBuilder {
    /// Create a blocking builder. The database topology defaults to direct.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select the in-process direct database topology.
    pub fn direct(mut self) -> Self {
        self.inner = self.inner.direct();
        self
    }

    /// Select the broker-process database topology.
    ///
    /// Protocol transport remains blocking. The broker process is a PostgreSQL
    /// isolation boundary, not an SDK owner thread.
    pub fn broker(mut self) -> Self {
        self.inner = self.inner.broker();
        self
    }

    /// Select database storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.inner = self.inner.storage(storage);
        self
    }

    /// Use an explicit broker helper executable with `broker().open()`.
    pub fn broker_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.inner = self.inner.broker_executable(path);
        self
    }

    /// Add an explicit PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner = self.inner.startup_guc(name, value);
        self
    }

    /// Add explicit PostgreSQL startup GUCs.
    pub fn startup_gucs<N, V>(mut self, gucs: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<String>,
        V: Into<String>,
    {
        self.inner = self.inner.startup_gucs(gucs);
        self
    }

    /// Set the PostgreSQL startup user.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.inner = self.inner.username(username);
        self
    }

    /// Set the PostgreSQL database name.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.inner = self.inner.database(database);
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Open a blocking direct or broker database.
    pub fn open(self) -> Result<Oliphaunt> {
        let config = self.inner.build_config()?;
        open_embedded_session(config).map(Oliphaunt::from_session)
    }
}

/// Builder for a blocking local PostgreSQL server lifecycle handle.
#[derive(Debug, Clone, Default)]
pub struct OliphauntServerBuilder {
    inner: AsyncOliphauntServerBuilder,
}

impl OliphauntServerBuilder {
    /// Create a blocking local-server builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Select server storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.inner = self.inner.storage(storage);
        self
    }

    /// Use an explicit PostgreSQL server executable.
    pub fn server_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.inner = self.inner.server_executable(path);
        self
    }

    /// Select the endpoint exposed by the local server.
    pub fn listen(mut self, listen: crate::ServerListen) -> Self {
        self.inner = self.inner.listen(listen);
        self
    }

    /// Add an explicit PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner = self.inner.startup_guc(name, value);
        self
    }

    /// Add explicit PostgreSQL startup GUCs.
    pub fn startup_gucs<N, V>(mut self, gucs: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<String>,
        V: Into<String>,
    {
        self.inner = self.inner.startup_gucs(gucs);
        self
    }

    /// Set the PostgreSQL startup user.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.inner = self.inner.username(username);
        self
    }

    /// Set the PostgreSQL database name.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.inner = self.inner.database(database);
        self
    }

    /// Make one bundled PostgreSQL extension artifact available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    /// Make bundled PostgreSQL extension artifacts available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Start a local PostgreSQL server and return its lifecycle handle.
    pub fn start(self) -> Result<OliphauntServer> {
        let config = self.inner.build_config()?;
        let (session, connection_string) = start_server_session(config)?;
        Ok(OliphauntServer {
            owner: Oliphaunt::from_session(session),
            connection_string,
        })
    }
}

/// Cloneable, thread-safe cancellation capability for a blocking database.
///
/// Obtain this before starting a long synchronous operation, then move a clone
/// to another thread. Calling [`Self::cancel`] sends cancellation out of band;
/// the blocked database call still returns PostgreSQL's final outcome. Once
/// database teardown reaches its terminal cutoff, retained handles return an
/// error categorized as [`crate::ErrorKind::Lifecycle`]. Teardown waits for cancellation calls admitted
/// before that cutoff to finish.
#[derive(Clone)]
pub struct CancelHandle {
    gate: Arc<CancellationGate>,
}

impl CancelHandle {
    /// Request cancellation of the database operation currently executing.
    pub fn cancel(&self) -> Result<()> {
        let admitted = self.gate.admit()?;
        admitted.cancel()
    }

    fn from_gate(gate: &Arc<CancellationGate>) -> Result<Self> {
        gate.ensure_supported()?;
        Ok(Self {
            gate: Arc::clone(gate),
        })
    }
}

/// Blocking native database with no SDK owner-thread queue.
///
/// Calls wait on the invoking thread, while the native runtime may execute its
/// PostgreSQL backend on an internal pthread. The exclusive handle is `Send`
/// but not `Sync`: it can move between threads, but it cannot be shared for
/// concurrent access. Use [`crate::AsyncOliphaunt`] when the database must be
/// cloneable or used without blocking an async executor thread.
///
/// ```compile_fail
/// fn require_sync<T: Sync>() {}
/// fn main() {
///     require_sync::<oliphaunt::Oliphaunt>();
/// }
/// ```
pub struct Oliphaunt {
    session: Option<Box<dyn EngineSession>>,
    cancellation: Arc<CancellationGate>,
    transaction_poisoned: AtomicBool,
    closed: bool,
    close_result: Option<Result<()>>,
    not_sync: PhantomData<Cell<()>>,
}

impl Oliphaunt {
    /// Create a blocking native builder.
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
    }

    /// Open a blocking direct database with the default temporary-directory storage.
    pub fn open() -> Result<Self> {
        Self::builder().open()
    }

    /// Restore physical backup bytes synchronously into an empty destination.
    pub fn restore(destination: impl Into<PathBuf>, backup: impl AsRef<[u8]>) -> Result<()> {
        OliphauntRuntime::from_env().restore(&destination.into(), backup.as_ref())
    }

    fn from_session(session: Box<dyn EngineSession>) -> Self {
        let cancellation = CancellationGate::with_target(session.cancel_handle());
        Self {
            session: Some(session),
            cancellation,
            transaction_poisoned: AtomicBool::new(false),
            closed: false,
            close_result: None,
            not_sync: PhantomData,
        }
    }

    /// Build a typed, fluent PostgreSQL statement.
    pub fn sql<'db, 'q>(&'db mut self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::database(self, sql)
    }

    /// Whether this handle has begun terminal teardown.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Return an out-of-band cancellation handle suitable for another thread.
    pub fn cancel_handle(&self) -> Result<CancelHandle> {
        self.ensure_not_closed()?;
        CancelHandle::from_gate(&self.cancellation)
    }

    /// Request cancellation immediately on the calling thread.
    ///
    /// To interrupt a synchronous operation which is already blocking this
    /// database's thread, obtain [`Self::cancel_handle`] first and invoke that
    /// handle from another thread.
    pub fn cancel(&self) -> Result<()> {
        self.cancel_handle()?.cancel()
    }

    /// Execute raw PostgreSQL protocol bytes synchronously.
    ///
    /// A runtime failure that returns no complete response poisons the session
    /// until close because its PostgreSQL boundary is unknown.
    pub fn exec_protocol_raw(&mut self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.exec_protocol_response(ProtocolRequest::new(request.as_ref().to_vec()))
            .map(ProtocolResponse::into_bytes)
    }

    /// Execute raw protocol bytes and synchronously receive bounded chunks.
    ///
    /// The callback runs inline and may borrow caller state. A slow callback
    /// applies backpressure. A callback panic is contained before crossing any
    /// native ABI, then its original payload is resumed on the invoking thread
    /// only after the adapter confirms `ReadyForQuery`. If transport or runtime
    /// recovery independently fails, that failure is returned instead and the
    /// session is poisoned until close.
    ///
    /// Return `()` from an infallible callback, or `Result<(), E>` to stop with
    /// a typed parser/application error. A typed error is exposed through
    /// [`RawStreamError::Callback`] only after confirmed recovery.
    pub fn exec_protocol_raw_stream<F, O>(
        &mut self,
        request: impl AsRef<[u8]>,
        mut on_chunk: F,
    ) -> RawStreamResult<(), O::Error>
    where
        F: FnMut(&[u8]) -> O,
        O: RawStreamCallbackOutput,
    {
        self.ensure_ready().map_err(RawStreamError::Database)?;
        let mut callback_error = None;
        let mut callback_panic = None;
        let outcome = {
            let mut guarded = |chunk: &[u8]| {
                if callback_error.is_some() || callback_panic.is_some() {
                    return Err(Error::Engine(
                        "raw protocol stream callback already stopped".to_owned(),
                    ));
                }
                match catch_unwind(AssertUnwindSafe(|| {
                    on_chunk(chunk).into_raw_stream_callback_result()
                })) {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => {
                        callback_error = Some(error);
                        Err(Error::Engine(
                            "raw protocol stream callback stopped delivery".to_owned(),
                        ))
                    }
                    Err(panic) => {
                        let message = panic_message(panic.as_ref());
                        callback_panic = Some(panic);
                        Err(Error::Engine(format!(
                            "raw protocol stream callback panicked: {message}"
                        )))
                    }
                }
            };
            self.session
                .as_deref_mut()
                .ok_or(Error::EngineStopped)
                .map_err(RawStreamError::Database)?
                .exec_protocol_raw_stream(
                    ProtocolRequest::new(request.as_ref().to_vec()),
                    &mut guarded,
                )
        };
        match outcome {
            ProtocolStreamOutcome::ReadyForQuery(result) => {
                if let Some(panic) = callback_panic {
                    resume_unwind(panic);
                }
                if let Some(error) = callback_error {
                    return Err(RawStreamError::Callback(error));
                }
                result.map_err(RawStreamError::Database)
            }
            ProtocolStreamOutcome::SessionStateUnknown(error) => {
                self.transaction_poisoned.store(true, Ordering::SeqCst);
                Err(RawStreamError::Database(error))
            }
        }
    }

    /// Execute exactly one PostgreSQL command through the extended-query protocol.
    pub fn execute(&mut self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute()
    }

    /// Execute a PostgreSQL command with extended-query parameters.
    pub fn execute_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value))
            .execute()
    }

    /// Execute one statement and return its row-shaped result.
    pub fn query(&mut self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query()
    }

    /// Execute one parameterized statement and return its row-shaped result.
    pub fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value))
            .query()
    }

    /// Parse and describe a statement without executing it.
    pub fn describe(&mut self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe()
    }

    /// Execute possibly multi-statement SQL through the simple-query protocol.
    pub fn exec(&mut self, sql: &str) -> Result<ExecResult> {
        reject_copy_statements(sql)?;
        let response = self.exec_structured(ProtocolRequest::simple_query(sql)?, "exec()")?;
        let result = parse_exec_response(&response)?;
        if result.ready_status() != ReadyStatus::Idle {
            return Err(Error::Engine(
                "exec() returned non-idle readiness after structured recovery".to_owned(),
            ));
        }
        Ok(result)
    }

    /// Run a synchronous callback inside one PostgreSQL transaction.
    ///
    /// The transaction exclusively borrows this database. Success commits;
    /// failure rolls back. Calling [`Transaction::rollback`] ends it early and
    /// makes the outer callback skip `COMMIT`.
    ///
    /// The callback returns ordinary `Result<T, E>` with `E: From<Error>`, so
    /// SDK calls use `?` and deliberate business aborts remain typed. The outer
    /// [`TransactionError`] distinguishes callback errors, literal rollback
    /// failures, and independent database/protocol failures.
    pub fn transaction<F, T, E>(&mut self, callback: F) -> TransactionResult<T, E>
    where
        F: FnOnce(&mut Transaction<'_>) -> std::result::Result<T, E>,
        E: From<Error>,
    {
        self.begin_transaction()
            .map_err(TransactionError::Database)?;
        let mut transaction = Transaction {
            database: self,
            guard: TransactionGuard::active(),
        };
        let callback_result = catch_unwind(AssertUnwindSafe(|| callback(&mut transaction)));
        let result = match callback_result {
            Ok(callback_result)
                if transaction.guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE =>
            {
                match callback_result {
                    Ok(value) => transaction
                        .commit()
                        .map(|()| value)
                        .map_err(TransactionError::Database),
                    Err(error) => match transaction.rollback() {
                        Ok(()) => Err(TransactionError::Callback(error)),
                        Err(rollback) => Err(TransactionError::CallbackAndRollback {
                            callback: error,
                            rollback,
                        }),
                    },
                }
            }
            Ok(callback_result) => transaction.resolve_inactive(callback_result),
            Err(panic) => {
                transaction.recover_after_callback_panic();
                drop(transaction);
                resume_unwind(panic);
            }
        };
        drop(transaction);
        result
    }

    /// Create a physical backup synchronously.
    pub fn backup(&mut self) -> Result<Vec<u8>> {
        self.ensure_ready()?;
        self.session
            .as_deref_mut()
            .ok_or(Error::EngineStopped)?
            .backup()
    }

    /// Close the database synchronously.
    ///
    /// The first teardown result is retained. Once teardown starts, the handle
    /// is terminal even if the runtime reports a failure. New cancellation
    /// calls are rejected at the teardown cutoff; cancellation already admitted
    /// before it is allowed to finish before the engine session is closed.
    /// Successful teardown releases the session and storage root. A failed
    /// teardown deliberately retains that native ownership until process exit
    /// rather than risking a second destructive cleanup attempt.
    pub fn close(&mut self) -> Result<()> {
        if let Some(result) = &self.close_result {
            return result.clone();
        }
        self.closed = true;
        self.cancellation.stop_and_wait();
        let result = self.session.take().map(close_session).unwrap_or(Ok(()));
        self.close_result = Some(result.clone());
        result
    }

    fn begin_transaction(&mut self) -> Result<()> {
        self.ensure_ready()?;
        let transaction_poisoned = &self.transaction_poisoned;
        let session = self.session.as_deref_mut().ok_or(Error::EngineStopped)?;
        begin_transaction(session, transaction_poisoned)
    }

    fn exec_protocol_response(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        self.ensure_ready()?;
        let result = self
            .session
            .as_deref_mut()
            .ok_or(Error::EngineStopped)?
            .exec_protocol_raw(request);
        if result.is_err() {
            // A raw response is the caller's responsibility, but a runtime
            // error means no complete PostgreSQL boundary was returned at all.
            self.transaction_poisoned.store(true, Ordering::SeqCst);
        }
        result
    }

    fn exec_control(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        self.ensure_not_closed()?;
        self.session
            .as_deref_mut()
            .ok_or(Error::EngineStopped)?
            .exec_protocol_raw(request)
    }

    fn exec_structured(
        &mut self,
        request: ProtocolRequest,
        operation: &str,
    ) -> Result<ProtocolResponse> {
        self.ensure_ready()?;
        let transaction_poisoned = &self.transaction_poisoned;
        let session = self.session.as_deref_mut().ok_or(Error::EngineStopped)?;
        execute_structured_operation(session, transaction_poisoned, request, operation)
    }

    fn exec_transaction_structured(
        &mut self,
        request: ProtocolRequest,
        operation: &str,
        guard: &TransactionGuard,
    ) -> Result<ProtocolResponse> {
        self.ensure_ready()?;
        let transaction_poisoned = &self.transaction_poisoned;
        let session = self.session.as_deref_mut().ok_or(Error::EngineStopped)?;
        execute_transaction_structured_operation(
            session,
            transaction_poisoned,
            guard,
            request,
            operation,
        )
    }

    fn poison_transaction(&self) {
        self.transaction_poisoned.store(true, Ordering::SeqCst);
    }

    fn ensure_not_closed(&self) -> Result<()> {
        if self.closed || self.session.is_none() {
            Err(Error::EngineStopped)
        } else {
            Ok(())
        }
    }

    fn ensure_ready(&self) -> Result<()> {
        self.ensure_not_closed()?;
        if self.transaction_poisoned.load(Ordering::SeqCst) {
            Err(Error::Engine(SESSION_STATE_UNKNOWN.to_owned()))
        } else {
            Ok(())
        }
    }
}

impl Drop for Oliphaunt {
    fn drop(&mut self) {
        self.closed = true;
        self.cancellation.stop_and_wait();
        if let Some(session) = self.session.take() {
            let _ = close_session(session);
        }
    }
}

/// Fluent synchronous PostgreSQL statement bound to a database or transaction.
#[must_use = "a SQL statement does nothing until execute(), query(), or describe() is called"]
pub struct Sql<'db, 'q> {
    database: &'db mut Oliphaunt,
    transaction: Option<Arc<TransactionGuard>>,
    sql: Cow<'q, str>,
    params: Vec<Parameter>,
    result_format: ValueFormat,
}

impl<'db, 'q> Sql<'db, 'q> {
    fn database(database: &'db mut Oliphaunt, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            database,
            transaction: None,
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    fn transaction(transaction: &'db mut Transaction<'_>, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            database: &mut *transaction.database,
            transaction: Some(Arc::clone(&transaction.guard)),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    /// Append one positional PostgreSQL parameter.
    pub fn bind(mut self, value: impl IntoParameter) -> Self {
        self.params.push(value.into_parameter());
        self
    }

    /// Append an explicitly constructed positional parameter.
    pub fn bind_parameter(mut self, value: Parameter) -> Self {
        self.params.push(value);
        self
    }

    /// Select one PostgreSQL result format for every returned column.
    pub fn result_format(mut self, format: ValueFormat) -> Self {
        self.result_format = format;
        self
    }

    /// Execute one statement which must not return rows.
    pub fn execute(mut self) -> Result<CommandResult> {
        self.reject_transaction_chain()?;
        let request = extended_statement_request(&self.sql, &self.params, self.result_format)?;
        let response = self.exchange(request, "execute()")?;
        let result = parse_extended_command_response(&response)?;
        self.validate_ready(result.ready_status(), "execute()")?;
        Ok(result)
    }

    /// Execute one statement and return its row-shaped result.
    pub fn query(mut self) -> Result<QueryResult> {
        self.reject_transaction_chain()?;
        let request = extended_statement_request(&self.sql, &self.params, self.result_format)?;
        let response = self.exchange(request, "query()")?;
        let result = parse_extended_query_response(&response)?;
        self.validate_ready(result.ready_status(), "query()")?;
        Ok(result)
    }

    /// Parse and describe a statement without executing it.
    pub fn describe(mut self) -> Result<StatementDescription> {
        let request = describe_statement_request(&self.sql, &self.params)?;
        let response = self.exchange(request, "describe()")?;
        let result = parse_statement_description(&response)?;
        self.validate_ready(result.ready_status(), "describe()")?;
        Ok(result)
    }

    fn reject_transaction_chain(&self) -> Result<()> {
        if self.transaction.is_some() {
            reject_transaction_chain(&self.sql)?;
        }
        Ok(())
    }

    fn exchange(&mut self, request: ProtocolRequest, operation: &str) -> Result<ProtocolResponse> {
        match &self.transaction {
            Some(guard) => self
                .database
                .exec_transaction_structured(request, operation, guard),
            None => self.database.exec_structured(request, operation),
        }
    }

    fn validate_ready(&self, status: ReadyStatus, operation: &str) -> Result<()> {
        match (&self.transaction, status) {
            (None, ReadyStatus::Idle) | (Some(_), _) => Ok(()),
            (None, _) => Err(Error::Engine(format!(
                "{operation} returned non-idle readiness after structured recovery"
            ))),
        }
    }
}

/// Callback-scoped transaction on a synchronous database.
pub struct Transaction<'db> {
    database: &'db mut Oliphaunt,
    guard: Arc<TransactionGuard>,
}

impl Transaction<'_> {
    /// Build a typed, fluent statement inside this transaction.
    pub fn sql<'db, 'q>(&'db mut self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::transaction(self, sql)
    }

    /// Whether this transaction has rolled back or entered terminal settlement.
    pub fn is_closed(&self) -> bool {
        self.guard.state.load(Ordering::SeqCst) != TRANSACTION_ACTIVE
    }

    /// Execute one command inside the transaction.
    pub fn execute(&mut self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute()
    }

    /// Execute one parameterized command inside the transaction.
    pub fn execute_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value))
            .execute()
    }

    /// Execute one statement and return rows inside the transaction.
    pub fn query(&mut self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query()
    }

    /// Execute one parameterized statement and return rows inside the transaction.
    pub fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value))
            .query()
    }

    /// Execute possibly multi-statement SQL through the simple-query protocol.
    pub fn exec(&mut self, sql: &str) -> Result<ExecResult> {
        self.ensure_active()?;
        reject_copy_statements(sql)?;
        reject_transaction_chain(sql)?;
        let response = self.database.exec_transaction_structured(
            ProtocolRequest::simple_query(sql)?,
            "Transaction::exec()",
            &self.guard,
        )?;
        let result = parse_exec_response(&response)?;
        Ok(result)
    }

    /// Parse and describe a statement inside the transaction without executing it.
    pub fn describe(&mut self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe()
    }

    /// Roll back immediately and make the outer callback skip `COMMIT`.
    pub fn rollback(&mut self) -> Result<()> {
        self.guard
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| inactive_transaction_error())?;
        let rollback = self.execute_transaction_command("ROLLBACK", "ROLLBACK", ReadyStatus::Idle);
        match rollback {
            Ok(_) => {
                self.guard
                    .state
                    .store(TRANSACTION_ROLLED_BACK, Ordering::SeqCst);
                Ok(())
            }
            Err(error) => {
                self.database.poison_transaction();
                self.guard.fail_rollback(error.clone());
                Err(error)
            }
        }
    }

    fn commit(&mut self) -> Result<()> {
        self.guard
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| inactive_transaction_error())?;
        let result = self
            .database
            .exec_control(ProtocolRequest::simple_query("COMMIT")?)
            .and_then(|response| parse_simple_command_response(&response));
        let tag = result
            .as_ref()
            .ok()
            .and_then(CommandResult::command_tag)
            .map(str::to_owned);
        let ready = result.as_ref().ok().map(CommandResult::ready_status);
        self.guard
            .state
            .store(TRANSACTION_RELEASED, Ordering::SeqCst);
        if tag.as_deref() == Some("COMMIT") && ready == Some(ReadyStatus::Idle) {
            return Ok(());
        }
        let known_rollback = tag.as_deref() == Some("ROLLBACK") && ready == Some(ReadyStatus::Idle);
        let error = result.err().unwrap_or_else(|| {
            Error::Engine(format!(
                "PostgreSQL transaction command expected COMMIT and idle readiness, got {} with {ready:?}",
                tag.as_deref().unwrap_or("no command tag")
            ))
        });
        if !known_rollback {
            self.database.poison_transaction();
        }
        Err(error)
    }

    fn execute_transaction_command(
        &mut self,
        sql: &str,
        expected: &str,
        expected_status: ReadyStatus,
    ) -> Result<CommandResult> {
        let response = self
            .database
            .exec_control(ProtocolRequest::simple_query(sql)?)?;
        let result = parse_simple_command_response(&response)?;
        if result.command_tag() != Some(expected) || result.ready_status() != expected_status {
            return Err(Error::Engine(format!(
                "PostgreSQL transaction command expected {expected} with {expected_status:?} readiness, got {} with {:?}",
                result.command_tag().unwrap_or("no command tag"),
                result.ready_status()
            )));
        }
        Ok(result)
    }

    fn ensure_active(&self) -> Result<()> {
        if self.guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE {
            Ok(())
        } else {
            Err(inactive_transaction_error())
        }
    }

    fn resolve_inactive<T, E>(
        &mut self,
        callback_result: std::result::Result<T, E>,
    ) -> TransactionResult<T, E> {
        let state = self.guard.state.load(Ordering::SeqCst);
        if state == TRANSACTION_ROLLED_BACK {
            return callback_result.map_err(TransactionError::Callback);
        }
        let terminal = self
            .guard
            .terminal_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
            .unwrap_or_else(|| match state {
                TRANSACTION_FAILED => Error::Engine(
                    "transaction failed and its terminal error could not be retained".to_owned(),
                ),
                TRANSACTION_FINISHING => Error::Engine(
                    "transaction settlement did not reach a terminal state".to_owned(),
                ),
                _ => Error::Engine("transaction finished in an invalid state".to_owned()),
            });
        match callback_result {
            Ok(_) => Err(TransactionError::Database(terminal)),
            Err(callback) if self.guard.terminal_failure_was_rollback() => {
                Err(TransactionError::CallbackAndRollback {
                    callback,
                    rollback: terminal,
                })
            }
            Err(callback) => Err(TransactionError::CallbackAndDatabase {
                callback,
                database: terminal,
            }),
        }
    }

    fn recover_after_callback_panic(&mut self) {
        match self.guard.state.load(Ordering::SeqCst) {
            TRANSACTION_ACTIVE => {
                if catch_unwind(AssertUnwindSafe(|| self.rollback())).is_err()
                    || self.guard.state.load(Ordering::SeqCst) != TRANSACTION_ROLLED_BACK
                {
                    self.database.poison_transaction();
                }
            }
            TRANSACTION_ROLLED_BACK => {}
            _ => self.database.poison_transaction(),
        }
    }
}

/// Synchronous local PostgreSQL server lifecycle handle.
///
/// Like [`Oliphaunt`], this handle is `Send` but not `Sync`.
///
/// ```compile_fail
/// fn require_sync<T: Sync>() {}
/// fn main() {
///     require_sync::<oliphaunt::OliphauntServer>();
/// }
/// ```
pub struct OliphauntServer {
    owner: Oliphaunt,
    connection_string: String,
}

impl OliphauntServer {
    /// Create a dedicated blocking local-server builder.
    pub fn builder() -> OliphauntServerBuilder {
        OliphauntServerBuilder::new()
    }

    /// Return the libpq connection string for external PostgreSQL clients.
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }

    /// Whether the server has begun terminal teardown.
    ///
    /// This is lifecycle state, not a health check. `false` does not poll the
    /// PostgreSQL child or prove that the published endpoint is reachable.
    pub fn is_closed(&self) -> bool {
        self.owner.is_closed()
    }

    /// Stop the local server synchronously.
    ///
    /// Successful teardown releases managed-root ownership. If teardown fails,
    /// the handle retains the server resources until process exit rather than
    /// attempting an unproven second destructive cleanup.
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}

fn close_session(mut session: Box<dyn EngineSession>) -> Result<()> {
    let close = catch_unwind(AssertUnwindSafe(|| session.close())).unwrap_or_else(|panic| {
        Err(Error::Engine(format!(
            "native engine session panicked during close: {}",
            panic_message(panic.as_ref())
        )))
    });
    match close {
        Ok(()) => catch_unwind(AssertUnwindSafe(|| drop(session))).map_err(|panic| {
            Error::Engine(format!(
                "native engine session destructor panicked after close: {}",
                panic_message(panic.as_ref())
            ))
        }),
        Err(error) => {
            // Teardown began but did not complete. A second implicit teardown
            // could corrupt native process state, so preserve ownership until
            // process exit just like the asynchronous owner executor does.
            std::mem::forget(session);
            Err(error)
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = panic.downcast_ref::<&'static str>() {
        (*message).to_owned()
    } else {
        "unknown panic payload".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::{Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    use super::*;
    use crate::engine::EngineCancel;
    use crate::error::ErrorKind;

    fn assert_error(error: &Error, expected_kind: ErrorKind, expected_message: &str) {
        assert_eq!(error.kind(), expected_kind);
        assert_eq!(error.to_string(), expected_message);
    }

    fn expect_error<T>(
        result: Result<T>,
        expected_kind: ErrorKind,
        expected_message: &str,
    ) -> Error {
        let error = match result {
            Ok(_) => panic!("expected an SDK error"),
            Err(error) => error,
        };
        assert_error(&error, expected_kind, expected_message);
        error
    }

    struct ScriptedSession {
        responses: VecDeque<Result<ProtocolResponse>>,
        calls: Option<Arc<Mutex<Vec<thread::ThreadId>>>>,
    }

    impl ScriptedSession {
        fn new(responses: impl IntoIterator<Item = Result<ProtocolResponse>>) -> Self {
            Self {
                responses: responses.into_iter().collect(),
                calls: None,
            }
        }
    }

    impl EngineSession for ScriptedSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            if let Some(calls) = &self.calls {
                calls.lock().unwrap().push(thread::current().id());
            }
            self.responses
                .pop_front()
                .expect("scripted direct response")
        }
    }

    struct CountingCancel {
        calls: AtomicUsize,
    }

    impl CountingCancel {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl EngineCancel for CountingCancel {
        fn cancel(&self) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct ReentrantCancel {
        calls: AtomicUsize,
        nested: Mutex<Option<CancelHandle>>,
    }

    impl EngineCancel for ReentrantCancel {
        fn cancel(&self) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let nested = self
                .nested
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(nested) = nested {
                nested.cancel()?;
            }
            Ok(())
        }
    }

    struct PanickingCancel;

    impl EngineCancel for PanickingCancel {
        fn cancel(&self) -> Result<()> {
            panic!("cancellation panic probe")
        }
    }

    #[test]
    fn engine_cancellation_runs_without_the_lifecycle_lock() {
        let implementation = Arc::new(ReentrantCancel {
            calls: AtomicUsize::new(0),
            nested: Mutex::new(None),
        });
        let target: Arc<dyn EngineCancel> = implementation.clone();
        let gate = CancellationGate::with_target(Some(target));
        let handle = CancelHandle::from_gate(&gate).expect("cancellation is supported");
        *implementation
            .nested
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(handle.clone());

        handle
            .cancel()
            .expect("nested cancellation does not deadlock");
        assert_eq!(implementation.calls.load(Ordering::SeqCst), 2);
        assert_eq!(gate.active_cancellations(), 0);
        gate.stop_and_wait();
        expect_error(
            handle.cancel(),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
    }

    #[test]
    fn cancellation_panic_releases_its_lifecycle_admission() {
        let target: Arc<dyn EngineCancel> = Arc::new(PanickingCancel);
        let gate = CancellationGate::with_target(Some(target));
        let handle = CancelHandle::from_gate(&gate).expect("cancellation is supported");

        let panic = catch_unwind(AssertUnwindSafe(|| handle.cancel()));
        assert!(panic.is_err());
        assert_eq!(gate.active_cancellations(), 0);
        gate.stop_and_wait();
        expect_error(
            handle.cancel(),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
    }

    struct BlockingCancel {
        started: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl EngineCancel for BlockingCancel {
        fn cancel(&self) -> Result<()> {
            if let Some(started) = self
                .started
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                started.send(()).expect("announce admitted cancellation");
            }
            self.release
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .recv()
                .expect("release admitted cancellation");
            Ok(())
        }
    }

    struct CancellableSession {
        cancel: Arc<dyn EngineCancel>,
        closes: Arc<AtomicUsize>,
        close_started: Option<mpsc::Sender<()>>,
    }

    impl EngineSession for CancellableSession {
        fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
            Some(Arc::clone(&self.cancel))
        }

        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            if let Some(close_started) = self.close_started.take() {
                close_started.send(()).expect("announce session close");
            }
            Ok(())
        }
    }

    #[test]
    fn close_waits_for_admitted_cancellation_and_rejects_later_calls() {
        let (cancel_started, cancel_started_rx) = mpsc::channel();
        let (cancel_release, cancel_release_rx) = mpsc::channel();
        let (close_started, close_started_rx) = mpsc::channel();
        let closes = Arc::new(AtomicUsize::new(0));
        let blocking: Arc<dyn EngineCancel> = Arc::new(BlockingCancel {
            started: Mutex::new(Some(cancel_started)),
            release: Mutex::new(cancel_release_rx),
        });
        let mut database = Oliphaunt::from_session(Box::new(CancellableSession {
            cancel: blocking,
            closes: Arc::clone(&closes),
            close_started: Some(close_started),
        }));
        let gate = Arc::clone(&database.cancellation);
        let handle = database.cancel_handle().expect("cancellation is supported");
        let late_handle = handle.clone();
        let cancellation = thread::spawn(move || handle.cancel());
        cancel_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancellation reaches its engine target");

        let coordinator = thread::spawn(move || {
            if !gate.wait_for_cutoff(Duration::from_secs(2)) {
                cancel_release
                    .send(())
                    .expect("release cancellation after cutoff timeout");
                panic!("close did not establish the cancellation cutoff");
            }
            assert_eq!(gate.active_cancellations(), 1);

            expect_error(
                late_handle.cancel(),
                ErrorKind::Lifecycle,
                "native database session has stopped",
            );
            assert!(matches!(
                close_started_rx.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            cancel_release
                .send(())
                .expect("release admitted cancellation");
            close_started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("session close starts after cancellation settles");
        });

        database.close().expect("close waits and then succeeds");
        coordinator.join().expect("coordinate close cutoff");
        cancellation
            .join()
            .expect("join cancellation thread")
            .expect("admitted cancellation succeeds");
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn drop_retires_exported_cancellation_handles() {
        let cancel = Arc::new(CountingCancel::new());
        let closes = Arc::new(AtomicUsize::new(0));
        let handle = {
            let cancel_target: Arc<dyn EngineCancel> = cancel.clone();
            let database = Oliphaunt::from_session(Box::new(CancellableSession {
                cancel: cancel_target,
                closes: Arc::clone(&closes),
                close_started: None,
            }));
            database.cancel_handle().expect("cancellation is supported")
        };

        expect_error(
            handle.cancel(),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        assert_eq!(cancel.calls.load(Ordering::SeqCst), 0);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn blocking_execution_adds_no_sdk_owner_thread_hop() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let session = ScriptedSession {
            responses: VecDeque::from([Ok(ProtocolResponse::new([1, 2, 3]))]),
            calls: Some(Arc::clone(&calls)),
        };
        let mut database = Oliphaunt::from_session(Box::new(session));
        assert_eq!(database.exec_protocol_raw([9]).unwrap(), [1, 2, 3]);
        assert_eq!(*calls.lock().unwrap(), [thread::current().id()]);
        database.close().unwrap();
    }

    #[test]
    fn blocking_database_can_move_between_threads_and_back() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let session = ScriptedSession {
            responses: VecDeque::from([
                Ok(ProtocolResponse::new([1, 2, 3])),
                Ok(ProtocolResponse::new([4, 5, 6])),
            ]),
            calls: Some(Arc::clone(&calls)),
        };
        let database = Oliphaunt::from_session(Box::new(session));
        let origin = thread::current().id();

        let (mut database, moved_to) = thread::spawn(move || {
            let moved_to = thread::current().id();
            let mut database = database;
            assert_eq!(database.exec_protocol_raw([9]).unwrap(), [1, 2, 3]);
            (database, moved_to)
        })
        .join()
        .expect("blocking database moves to another thread");

        assert_ne!(origin, moved_to);
        assert_eq!(database.exec_protocol_raw([8]).unwrap(), [4, 5, 6]);
        assert_eq!(*calls.lock().unwrap(), [moved_to, origin]);
        database.close().unwrap();
    }

    struct FailedRawSession {
        calls: Arc<AtomicUsize>,
    }

    impl EngineSession for FailedRawSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(Error::Engine(
                "raw transport failed before ReadyForQuery".to_owned(),
            ))
        }
    }

    #[test]
    fn blocking_raw_transport_failure_poisons_without_a_second_engine_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut database = Oliphaunt::from_session(Box::new(FailedRawSession {
            calls: Arc::clone(&calls),
        }));

        expect_error(
            database.exec_protocol_raw([1]),
            ErrorKind::Other,
            "raw transport failed before ReadyForQuery",
        );
        expect_error(
            database.exec_protocol_raw([2]),
            ErrorKind::Other,
            SESSION_STATE_UNKNOWN,
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        database.close().unwrap();
    }

    struct RecoveringStreamSession {
        recovered: Arc<AtomicBool>,
    }

    impl EngineSession for RecoveringStreamSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            assert!(
                self.recovered.load(Ordering::SeqCst),
                "the stream call returns only after recovery"
            );
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn exec_protocol_raw_stream(
            &mut self,
            _request: ProtocolRequest,
            on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
        ) -> ProtocolStreamOutcome {
            let callback = on_chunk(&[1, 2, 3]);
            self.recovered.store(true, Ordering::SeqCst);
            ProtocolStreamOutcome::ReadyForQuery(callback)
        }
    }

    #[test]
    fn blocking_stream_resumes_callback_panic_after_recovery() {
        let recovered = Arc::new(AtomicBool::new(false));
        let mut database = Oliphaunt::from_session(Box::new(RecoveringStreamSession {
            recovered: Arc::clone(&recovered),
        }));

        let panic = catch_unwind(AssertUnwindSafe(|| {
            database.exec_protocol_raw_stream([1], |_| -> () { panic!("stream panic payload") })
        }))
        .expect_err("blocking callback panic resumes on its invoking thread");
        assert_eq!(panic_message(panic.as_ref()), "stream panic payload");
        assert!(recovered.load(Ordering::SeqCst));
        assert_eq!(database.exec_protocol_raw([7]).unwrap(), [7]);
        database.close().unwrap();
    }

    struct FailedStreamRecoverySession;

    impl EngineSession for FailedStreamRecoverySession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new([]))
        }

        fn exec_protocol_raw_stream(
            &mut self,
            _request: ProtocolRequest,
            on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
        ) -> ProtocolStreamOutcome {
            let _ = on_chunk(&[1, 2, 3]);
            ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(
                "stream transport failed before ReadyForQuery".to_owned(),
            ))
        }
    }

    #[test]
    fn blocking_stream_does_not_resume_callback_panic_when_recovery_fails() {
        let mut database = Oliphaunt::from_session(Box::new(FailedStreamRecoverySession));

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            database.exec_protocol_raw_stream([1], |_| -> () { panic!("stream panic payload") })
        }))
        .expect("an independent recovery failure takes precedence over callback unwind");
        let stream_error = outcome.expect_err("stream recovery failure is reported");
        assert!(stream_error.callback_error().is_none());
        assert!(stream_error.callback_panic_error().is_none());
        assert_error(
            stream_error
                .database_error()
                .expect("recovery failure remains a database error"),
            ErrorKind::Other,
            "stream transport failed before ReadyForQuery",
        );
        expect_error(
            database.exec_protocol_raw([7]),
            ErrorKind::Other,
            SESSION_STATE_UNKNOWN,
        );
        database.close().unwrap();
    }

    #[test]
    fn transaction_callback_commits_without_an_executor_hop() {
        let session = ScriptedSession::new([
            Ok(command_response("BEGIN", b'T')),
            Ok(extended_command_response("INSERT 0 1", b'T')),
            Ok(command_response("COMMIT", b'I')),
            Ok(ProtocolResponse::new([4, 1])),
        ]);
        let mut database = Oliphaunt::from_session(Box::new(session));

        assert_eq!(
            database
                .transaction(|transaction| {
                    transaction.execute("INSERT INTO items VALUES (1)")?;
                    Ok::<u8, Error>(41_u8)
                })
                .unwrap(),
            41
        );
        assert_eq!(database.exec_protocol_raw([1]).unwrap(), [4, 1]);
        database.close().unwrap();
    }

    #[test]
    fn explicit_rollback_is_one_shot_and_skips_commit() {
        let session = ScriptedSession::new([
            Ok(command_response("BEGIN", b'T')),
            Ok(command_response("ROLLBACK", b'I')),
            Ok(ProtocolResponse::new([4, 3])),
        ]);
        let mut database = Oliphaunt::from_session(Box::new(session));

        assert_eq!(
            database
                .transaction(|transaction| {
                    transaction.rollback()?;
                    assert!(transaction.is_closed());
                    expect_error(
                        transaction.rollback(),
                        ErrorKind::Other,
                        "transaction is no longer active",
                    );
                    Ok::<u8, Error>(43_u8)
                })
                .unwrap(),
            43
        );
        assert_eq!(database.exec_protocol_raw([1]).unwrap(), [4, 3]);
        database.close().unwrap();
    }

    #[test]
    fn manual_structured_commit_poisoning_is_not_misreported_as_success() {
        let session = ScriptedSession::new([
            Ok(command_response("BEGIN", b'T')),
            Ok(extended_command_response("COMMIT", b'I')),
        ]);
        let mut database = Oliphaunt::from_session(Box::new(session));

        let error = database
            .transaction(|transaction| {
                let error = transaction
                    .execute("COMMIT")
                    .expect_err("manual COMMIT escapes callback ownership");
                assert!(
                    error
                        .to_string()
                        .contains("outside the SDK-managed transaction lifecycle")
                );
                Ok::<(), Error>(())
            })
            .expect_err("outer transaction cannot turn manual COMMIT into success");
        assert!(
            error
                .to_string()
                .contains("outside the SDK-managed transaction lifecycle")
        );
        expect_error(
            database.exec_protocol_raw([1]),
            ErrorKind::Other,
            SESSION_STATE_UNKNOWN,
        );
        database.close().unwrap();
    }

    #[test]
    fn transaction_chain_is_rejected_before_direct_dispatch() {
        let session = ScriptedSession::new([
            Ok(command_response("BEGIN", b'T')),
            Ok(command_response("COMMIT", b'I')),
            Ok(ProtocolResponse::new([4, 8])),
        ]);
        let mut database = Oliphaunt::from_session(Box::new(session));

        database
            .transaction(|transaction| {
                for error in [
                    transaction
                        .execute("ROLLBACK AND CHAIN")
                        .expect_err("extended execute rejects transaction replacement"),
                    transaction
                        .query("ABORT WORK AND CHAIN")
                        .expect_err("extended query rejects transaction replacement"),
                    transaction
                        .exec("SELECT 1; ROLLBACK TRANSACTION AND CHAIN")
                        .expect_err("simple exec rejects transaction replacement"),
                ] {
                    assert!(
                        error
                            .to_string()
                            .contains("not allowed inside an SDK-managed callback transaction"),
                        "unexpected preflight error: {error}"
                    );
                }
                Ok::<(), Error>(())
            })
            .expect("preflight rejections leave the owned transaction active");

        assert_eq!(
            database
                .exec_protocol_raw([1])
                .expect("only BEGIN and the outer COMMIT reached the session"),
            [4, 8]
        );
        database.close().unwrap();
    }

    #[test]
    fn callback_panic_rolls_back_before_resuming_unwind() {
        let session = ScriptedSession::new([
            Ok(command_response("BEGIN", b'T')),
            Ok(command_response("ROLLBACK", b'I')),
            Ok(ProtocolResponse::new([7, 7])),
        ]);
        let mut database = Oliphaunt::from_session(Box::new(session));

        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _ = database.transaction::<_, (), Error>(|_| panic!("callback panic probe"));
        }));
        assert!(panic.is_err());
        assert_eq!(database.exec_protocol_raw([1]).unwrap(), [7, 7]);
        database.close().unwrap();
    }

    struct FailingCloseSession {
        closes: Arc<AtomicUsize>,
        cancel: Arc<CountingCancel>,
    }

    impl EngineSession for FailingCloseSession {
        fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
            let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
            Some(cancel)
        }

        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            unreachable!("close-only test session")
        }

        fn close(&mut self) -> Result<()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Err(Error::Engine("detach failed".to_owned()))
        }
    }

    #[test]
    fn close_failure_is_terminal_and_replayed_without_second_teardown() {
        let closes = Arc::new(AtomicUsize::new(0));
        let cancel = Arc::new(CountingCancel::new());
        let mut database = Oliphaunt::from_session(Box::new(FailingCloseSession {
            closes: Arc::clone(&closes),
            cancel: Arc::clone(&cancel),
        }));
        let cancel_handle = database.cancel_handle().expect("cancellation is supported");
        expect_error(database.close(), ErrorKind::Other, "detach failed");
        expect_error(database.close(), ErrorKind::Other, "detach failed");
        assert!(database.is_closed());
        expect_error(
            cancel_handle.cancel(),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        assert_eq!(cancel.calls.load(Ordering::SeqCst), 0);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    fn command_response(tag: &str, ready: u8) -> ProtocolResponse {
        let mut bytes = Vec::new();
        let mut command = tag.as_bytes().to_vec();
        command.push(0);
        push_backend_message(&mut bytes, b'C', &command);
        push_backend_message(&mut bytes, b'Z', &[ready]);
        ProtocolResponse::new(bytes)
    }

    fn extended_command_response(tag: &str, ready: u8) -> ProtocolResponse {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'1', &[]);
        push_backend_message(&mut bytes, b'2', &[]);
        push_backend_message(&mut bytes, b'n', &[]);
        let mut command = tag.as_bytes().to_vec();
        command.push(0);
        push_backend_message(&mut bytes, b'C', &command);
        push_backend_message(&mut bytes, b'Z', &[ready]);
        ProtocolResponse::new(bytes)
    }

    fn push_backend_message(bytes: &mut Vec<u8>, tag: u8, body: &[u8]) {
        bytes.push(tag);
        bytes.extend_from_slice(&i32::try_from(body.len() + 4).unwrap().to_be_bytes());
        bytes.extend_from_slice(body);
    }
}
