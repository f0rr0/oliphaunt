use std::borrow::Cow;
use std::cell::Cell;
use std::marker::PhantomData;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::builder::{AsyncOliphauntBuilder, AsyncOliphauntServerBuilder};
#[cfg(test)]
use crate::error::SESSION_STATE_UNKNOWN;
use crate::error::{
    Error, RawStreamCallbackOutput, RawStreamError, RawStreamResult, Result, TransactionError,
    TransactionResult,
};
use crate::executor::{EngineExecutor, ExecutorStreamOutcome, run_off_thread};
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
    TRANSACTION_ROLLED_BACK, TransactionGuard,
};

/// Cloneable asynchronous native database backed by one dedicated SDK owner thread.
///
/// Ordinary work uses bounded FIFO admission. When the queue is saturated, an
/// operation future remains pending until capacity is available; no particular
/// async runtime is required.
#[derive(Clone)]
pub struct AsyncOliphaunt {
    executor: Arc<EngineExecutor>,
}

/// Cloneable asynchronous local PostgreSQL server lifecycle handle.
///
/// Use [`AsyncOliphauntServer::connection_string`] with ordinary PostgreSQL clients.
/// Physical server backups use the packaged `pg_basebackup` tool rather than
/// the embedded database backup API.
#[derive(Clone)]
pub struct AsyncOliphauntServer {
    owner: AsyncOliphaunt,
    connection_string: String,
}

/// Fluent PostgreSQL statement bound to a native database or transaction.
#[must_use = "a SQL statement does nothing until execute(), query(), or describe() is awaited"]
pub struct AsyncSql<'db, 'q> {
    target: SqlTarget<'db>,
    sql: Cow<'q, str>,
    params: Vec<Parameter>,
    result_format: ValueFormat,
}

fn adapt_raw_stream_callback<F, O>(
    mut on_chunk: F,
    callback_error: Arc<Mutex<Option<O::Error>>>,
) -> impl FnMut(&[u8]) -> Result<()> + Send + 'static
where
    F: FnMut(&[u8]) -> O + Send + 'static,
    O: RawStreamCallbackOutput,
    O::Error: Send + 'static,
{
    move |chunk| match on_chunk(chunk).into_raw_stream_callback_result() {
        Ok(()) => Ok(()),
        Err(error) => {
            *callback_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
            Err(Error::Engine(
                "raw protocol stream callback stopped delivery".to_owned(),
            ))
        }
    }
}

fn resolve_raw_stream_outcome<E>(
    outcome: Result<ExecutorStreamOutcome>,
    callback_error: Arc<Mutex<Option<E>>>,
) -> RawStreamResult<(), E> {
    let outcome = outcome.map_err(RawStreamError::Database)?;
    match outcome {
        ExecutorStreamOutcome::ReadyForQuery(result) => {
            let callback_error = callback_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(error) = callback_error {
                Err(RawStreamError::Callback(error))
            } else {
                result.map_err(RawStreamError::Database)
            }
        }
        ExecutorStreamOutcome::CallbackPanicked(error) => {
            Err(RawStreamError::CallbackPanicked(error))
        }
        ExecutorStreamOutcome::SessionStateUnknown(error) => Err(RawStreamError::Database(error)),
    }
}

enum SqlTarget<'db> {
    Database(&'db AsyncOliphaunt),
    Transaction(&'db mut AsyncTransaction),
}

impl<'db, 'q> AsyncSql<'db, 'q> {
    fn database(database: &'db AsyncOliphaunt, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            target: SqlTarget::Database(database),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    fn transaction(transaction: &'db mut AsyncTransaction, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            target: SqlTarget::Transaction(transaction),
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

    /// Execute a single statement that must not return rows.
    pub async fn execute(mut self) -> Result<CommandResult> {
        self.reject_transaction_chain()?;
        let request = extended_statement_request(&self.sql, &self.params, self.result_format)?;
        let response = self.exchange(request, "execute()").await?;
        let result = parse_extended_command_response(&response)?;
        self.validate_ready(result.ready_status(), "execute()")?;
        Ok(result)
    }

    /// Execute one statement and return its row-shaped result.
    ///
    /// A command-only statement is accepted as an empty field/row result with
    /// its command tag retained for ORM call sites that cannot classify SQL.
    pub async fn query(mut self) -> Result<QueryResult> {
        self.reject_transaction_chain()?;
        let request = extended_statement_request(&self.sql, &self.params, self.result_format)?;
        let response = self.exchange(request, "query()").await?;
        let result = parse_extended_query_response(&response)?;
        self.validate_ready(result.ready_status(), "query()")?;
        Ok(result)
    }

    /// Parse and describe a statement without executing it.
    pub async fn describe(mut self) -> Result<StatementDescription> {
        let request = describe_statement_request(&self.sql, &self.params)?;
        let response = self.exchange(request, "describe()").await?;
        let description = parse_statement_description(&response)?;
        self.validate_ready(description.ready_status(), "describe()")?;
        Ok(description)
    }

    fn reject_transaction_chain(&self) -> Result<()> {
        if matches!(&self.target, SqlTarget::Transaction(_)) {
            reject_transaction_chain(&self.sql)?;
        }
        Ok(())
    }

    async fn exchange(
        &mut self,
        request: ProtocolRequest,
        operation: &str,
    ) -> Result<ProtocolResponse> {
        match &mut self.target {
            SqlTarget::Database(database) => {
                database.executor.exec_structured(request, operation).await
            }
            SqlTarget::Transaction(transaction) => {
                transaction.exec_request(request, operation).await
            }
        }
    }

    fn validate_ready(&mut self, status: ReadyStatus, operation: &str) -> Result<()> {
        match &mut self.target {
            SqlTarget::Database(_) if status == ReadyStatus::Idle => Ok(()),
            SqlTarget::Database(_) => Err(Error::Engine(format!(
                "{operation} returned non-idle readiness after structured recovery"
            ))),
            SqlTarget::Transaction(_) => Ok(()),
        }
    }
}

impl AsyncOliphaunt {
    /// Create a dedicated owner-thread native builder.
    pub fn builder() -> AsyncOliphauntBuilder {
        AsyncOliphauntBuilder::new()
    }

    /// Open an asynchronous direct database with default temporary-directory storage.
    pub async fn open() -> Result<Self> {
        Self::builder().open().await
    }

    /// Restore physical backup bytes into an empty filesystem destination.
    ///
    /// The backup is copied before filesystem and native restore work moves to
    /// a dedicated blocking thread, so polling this future does not monopolize
    /// an async executor thread.
    pub async fn restore(
        destination: impl Into<std::path::PathBuf>,
        backup: impl AsRef<[u8]>,
    ) -> Result<()> {
        let destination = destination.into();
        let backup = backup.as_ref().to_vec();
        run_off_thread("oliphaunt-restore", move || {
            crate::liboliphaunt::OliphauntRuntime::from_env().restore(&destination, &backup)
        })
        .await
    }

    pub(crate) fn from_executor(executor: Arc<EngineExecutor>) -> Self {
        Self { executor }
    }

    /// Build a typed, fluent PostgreSQL statement.
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> AsyncSql<'db, 'q> {
        AsyncSql::database(self, sql)
    }

    /// Whether this shared handle has been terminally retired.
    ///
    /// This becomes true after successful close and after a teardown attempt
    /// has started but failed. A pre-teardown validation error such as
    /// [`crate::ErrorKind::TransactionActive`] leaves it false so the caller can settle
    /// the transaction and retry.
    pub fn is_closed(&self) -> bool {
        self.executor.is_closed()
    }

    /// Request cancellation of the currently active backend query.
    ///
    /// Engines that support cancellation issue this out of band rather than
    /// queueing behind normal SQL work. Awaiting this method waits for the
    /// cancellation request itself; the query future independently reports
    /// PostgreSQL's final cancellation or completion result.
    pub async fn cancel(&self) -> Result<()> {
        self.executor.cancel().await
    }

    /// Execute raw PostgreSQL protocol bytes through the owner executor.
    ///
    /// A runtime failure that returns no complete response poisons the session
    /// until close because its PostgreSQL boundary is unknown.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.executor
            .exec_protocol_raw(ProtocolRequest::new(request.as_ref().to_vec()))
            .await
            .map(ProtocolResponse::into_bytes)
    }

    /// Execute raw PostgreSQL protocol bytes and receive bounded backend chunks.
    ///
    /// The callback runs synchronously on the SDK owner thread, one invocation
    /// at a time. Its borrowed bytes are valid only for that invocation. Slow
    /// callbacks apply backpressure; a returned error or panic stops callback
    /// delivery while the runtime drains to `ReadyForQuery` before resolving.
    /// Return `()` for infallible delivery or `Result<(), E>` for a typed stop.
    /// Because the callback runs on the SDK owner thread, a recovered panic is
    /// returned as [`RawStreamError::CallbackPanicked`] rather than unwinding
    /// on the awaiting thread. It does not poison the session.
    /// Do not block waiting for another operation on this database from inside
    /// the callback: reentrant owner work is rejected to prevent deadlock.
    pub async fn exec_protocol_raw_stream<F, O>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> RawStreamResult<(), O::Error>
    where
        F: FnMut(&[u8]) -> O + Send + 'static,
        O: RawStreamCallbackOutput,
        O::Error: Send + 'static,
    {
        let callback_error = Arc::new(Mutex::new(None));
        let outcome = self
            .executor
            .exec_protocol_raw_stream_outcome(
                ProtocolRequest::new(request.as_ref().to_vec()),
                adapt_raw_stream_callback(on_chunk, Arc::clone(&callback_error)),
            )
            .await;
        resolve_raw_stream_outcome(outcome, callback_error)
    }

    /// Execute exactly one PostgreSQL command through the extended-query protocol.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute a PostgreSQL command with extended-query parameters.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.execute().await
    }

    /// Execute exactly one SQL statement through PostgreSQL's extended-query
    /// protocol and parse one result set into rows and fields.
    ///
    /// Use `exec_protocol_raw` for COPY,
    /// multi-result-set protocol handling, or custom frontend protocol flows.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query().await
    }

    /// Execute SQL with extended-query parameters and parse one result set.
    pub async fn query_with_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.query().await
    }

    /// Parse and describe a statement without executing it.
    ///
    /// Use [`Self::sql`] when parameter type hints must be supplied with
    /// [`AsyncSql::bind`] or [`AsyncSql::bind_parameter`].
    pub async fn describe(&self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Execute possibly multi-statement SQL through PostgreSQL's simple-query protocol.
    pub async fn exec(&self, sql: &str) -> Result<ExecResult> {
        reject_copy_statements(sql)?;
        let response = self
            .executor
            .exec_structured(ProtocolRequest::simple_query(sql)?, "exec()")
            .await?;
        let result = parse_exec_response(&response)?;
        if result.ready_status() != ReadyStatus::Idle {
            return Err(Error::Engine(
                "exec() returned non-idle readiness after structured recovery".to_owned(),
            ));
        }
        Ok(result)
    }

    async fn start_transaction(&self) -> Result<AsyncTransaction> {
        // Pinning and BEGIN are one owner command. No unrelated operation can
        // observe a pinned-but-not-started transaction or interleave between
        // those two state transitions.
        let token = self.executor.begin_transaction().await?;
        let guard = TransactionGuard::active();
        let pin = SessionPin {
            executor: Arc::clone(&self.executor),
            token,
            guard: Arc::clone(&guard),
            released: false,
        };
        Ok(AsyncTransaction {
            pin: Some(pin),
            guard,
            not_sync: PhantomData,
        })
    }

    /// Run a closure inside an explicit SQL transaction pinned to the physical
    /// session.
    ///
    /// The SDK sends `BEGIN`, gives the closure access to the active transaction
    /// handle, commits on success, and rolls back when the closure returns an
    /// error.
    /// While the closure runs, unpinned work on the same `AsyncOliphaunt` handle is
    /// rejected.
    ///
    /// The callback returns ordinary `Result<T, E>` with `E: From<Error>`, so
    /// SDK calls use `?` while business aborts remain typed. The outer
    /// [`TransactionError`] preserves callback plus rollback or independent
    /// database failures without conflating those lifecycle outcomes.
    pub async fn transaction<T, E>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx mut AsyncTransaction) -> std::result::Result<T, E>,
    ) -> TransactionResult<T, E>
    where
        E: From<Error>,
    {
        let mut tx = self
            .start_transaction()
            .await
            .map_err(TransactionError::Database)?;
        match body(&mut tx).await {
            Ok(value) => {
                if tx.is_closed() {
                    tx.finish_explicit_rollback()
                        .await
                        .map_err(TransactionError::Database)?;
                    Ok(value)
                } else {
                    tx.commit().await.map_err(TransactionError::Database)?;
                    Ok(value)
                }
            }
            Err(error) => {
                let state = tx.guard.state.load(Ordering::SeqCst);
                let rollback_was_attempted = state == TRANSACTION_ACTIVE
                    || state == TRANSACTION_ROLLED_BACK
                    || tx.guard.terminal_failure_was_rollback();
                let settlement = if tx.is_closed() {
                    tx.finish_explicit_rollback().await
                } else {
                    tx.rollback_and_release().await
                };
                match settlement {
                    Ok(()) => Err(TransactionError::Callback(error)),
                    Err(rollback) if rollback_was_attempted => {
                        Err(TransactionError::CallbackAndRollback {
                            callback: error,
                            rollback,
                        })
                    }
                    Err(database) => Err(TransactionError::CallbackAndDatabase {
                        callback: error,
                        database,
                    }),
                }
            }
        }
    }

    /// Create a backup.
    pub async fn backup(&self) -> Result<Vec<u8>> {
        self.executor.backup().await
    }

    /// Close the database.
    ///
    /// Close establishes one total-order cutoff in the owner queue. Work
    /// admitted before the cutoff, including transaction begin or control,
    /// drains before close; later application work is rejected. If that earlier
    /// work leaves a transaction active, close returns
    /// [`crate::ErrorKind::TransactionActive`] and reopens admission for an explicit retry.
    /// Required `COMMIT` or `ROLLBACK` settlement for a pre-cutoff transaction
    /// remains admissible in FIFO order while close is pending. Concurrent close
    /// calls share one attempt. Success resolves only after the session and its
    /// root lock are released. Once runtime teardown starts, success or failure
    /// terminally retires the handle; a failure is retained exactly and returned
    /// by every repeated close. Successful teardown releases storage ownership;
    /// failed teardown deliberately retains it until process exit rather than
    /// invoking an unproven second destructor. Call `cancel().await` when a
    /// running statement should be interrupted. Dropping the final handle only
    /// requests best-effort cleanup and never synchronously joins the owner thread.
    pub async fn close(&self) -> Result<()> {
        self.executor.close().await
    }
}

impl AsyncOliphauntServer {
    /// Create a dedicated asynchronous local-server builder.
    pub fn builder() -> AsyncOliphauntServerBuilder {
        AsyncOliphauntServerBuilder::new()
    }

    pub(crate) fn from_executor(executor: Arc<EngineExecutor>, connection_string: String) -> Self {
        Self {
            owner: AsyncOliphaunt::from_executor(executor),
            connection_string,
        }
    }

    /// Return the nonoptional libpq connection string for the local server.
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }

    /// Whether the server has been terminally retired.
    ///
    /// This is lifecycle state, not a health check. `false` does not poll the
    /// PostgreSQL child or prove that the published endpoint is reachable.
    pub fn is_closed(&self) -> bool {
        self.owner.is_closed()
    }

    /// Stop the local server.
    ///
    /// Successful teardown releases managed-root ownership. If teardown fails,
    /// the owner retains the server resources until process exit rather than
    /// attempting an unproven second destructive cleanup. Concurrent callers
    /// observe the same terminal close result.
    pub async fn close(&self) -> Result<()> {
        self.owner.close().await
    }
}

/// Session pin used for transaction or session-state-sensitive protocol work.
struct SessionPin {
    executor: Arc<EngineExecutor>,
    token: u64,
    guard: Arc<TransactionGuard>,
    released: bool,
}

impl SessionPin {
    async fn execute_transaction_command(
        &self,
        sql: &str,
        expected: &str,
        expected_status: ReadyStatus,
    ) -> Result<CommandResult> {
        let response = self
            .executor
            .pinned_exec_protocol_control(
                self.token,
                ProtocolRequest::simple_query(sql)?,
                Arc::clone(&self.guard),
            )
            .await?;
        let result = parse_simple_command_response(&response)?;
        if result.command_tag() != Some(expected) {
            return Err(Error::Engine(format!(
                "PostgreSQL transaction command expected {expected}, got {}",
                result.command_tag().unwrap_or("no command tag")
            )));
        }
        if result.ready_status() != expected_status {
            return Err(Error::Engine(format!(
                "PostgreSQL transaction command {expected} returned unexpected ReadyForQuery state {:?}",
                result.ready_status()
            )));
        }
        Ok(result)
    }

    /// Execute transaction control bytes while holding the physical-session pin.
    async fn exec_protocol_control(
        &self,
        request: impl Into<ProtocolRequest>,
    ) -> Result<ProtocolResponse> {
        self.executor
            .pinned_exec_protocol_control(self.token, request.into(), Arc::clone(&self.guard))
            .await
    }

    /// Release the session pin.
    pub async fn release(mut self) -> Result<()> {
        let result = self.executor.release_pin(self.token).await;
        // The owner has completed the authoritative release attempt. Retrying
        // it from Drop after a returned error could only enqueue an unobserved
        // second control operation against an already-mismatched or stopped
        // owner state.
        self.released = true;
        result
    }
}

impl Drop for SessionPin {
    fn drop(&mut self) {
        if !self.released {
            self.executor.release_pin_best_effort(self.token);
            self.released = true;
        }
    }
}

/// Explicit callback-scoped transaction pinned to one PostgreSQL session.
pub struct AsyncTransaction {
    pin: Option<SessionPin>,
    guard: Arc<TransactionGuard>,
    not_sync: PhantomData<Cell<()>>,
}

impl AsyncTransaction {
    /// Build a typed, fluent PostgreSQL statement inside this transaction.
    pub fn sql<'db, 'q>(&'db mut self, sql: impl Into<Cow<'q, str>>) -> AsyncSql<'db, 'q> {
        AsyncSql::transaction(self, sql)
    }

    /// Whether this callback transaction has been rolled back or finalized.
    pub fn is_closed(&self) -> bool {
        self.guard.state.load(Ordering::SeqCst) != TRANSACTION_ACTIVE
    }

    fn ensure_active(&self) -> Result<()> {
        if self.guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE {
            Ok(())
        } else {
            Err(Error::Engine("transaction is no longer active".to_owned()))
        }
    }

    async fn exec_request(
        &mut self,
        request: ProtocolRequest,
        operation: &str,
    ) -> Result<ProtocolResponse> {
        self.ensure_active()?;
        let pin = self
            .pin
            .as_ref()
            .expect("transaction pin is retained until the callback returns");
        pin.executor
            .pinned_exec_structured(pin.token, request, operation, Arc::clone(&self.guard))
            .await
    }

    /// Execute exactly one SQL statement through PostgreSQL's extended-query
    /// protocol inside the transaction.
    pub async fn execute(&mut self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute a command with extended-query parameters inside the transaction.
    pub async fn execute_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.execute().await
    }

    /// Execute exactly one SQL statement through PostgreSQL's extended-query
    /// protocol inside the transaction and return its row-shaped result.
    pub async fn query(&mut self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query().await
    }

    /// Execute SQL with extended-query parameters inside the transaction.
    pub async fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.query().await
    }

    /// Execute possibly multi-statement SQL through PostgreSQL's simple-query protocol.
    pub async fn exec(&mut self, sql: &str) -> Result<ExecResult> {
        reject_copy_statements(sql)?;
        reject_transaction_chain(sql)?;
        let response = self
            .exec_request(
                ProtocolRequest::simple_query(sql)?,
                "AsyncTransaction::exec()",
            )
            .await?;
        let result = parse_exec_response(&response)?;
        Ok(result)
    }

    /// Parse and describe a statement without executing it.
    pub async fn describe(&mut self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Roll back this callback transaction immediately.
    ///
    /// The handle expires after the first attempt. If the callback subsequently
    /// returns `Ok`, the outer transaction skips `COMMIT` and returns that value.
    pub async fn rollback(&mut self) -> Result<()> {
        self.guard
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| Error::Engine("transaction is no longer active".to_owned()))?;
        let rollback = self
            .pin
            .as_ref()
            .expect("transaction pin is retained until the callback returns")
            .execute_transaction_command("ROLLBACK", "ROLLBACK", ReadyStatus::Idle)
            .await;
        match rollback {
            Ok(_) => {
                self.guard
                    .state
                    .store(TRANSACTION_ROLLED_BACK, Ordering::SeqCst);
                Ok(())
            }
            Err(error) => {
                self.pin
                    .as_ref()
                    .expect("transaction pin is retained until the callback returns")
                    .executor
                    .poison_transaction_state();
                self.guard.fail_rollback(error.clone());
                Err(error)
            }
        }
    }

    /// Commit the transaction and release the session pin.
    async fn commit(mut self) -> Result<()> {
        self.guard
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| Error::Engine("transaction is no longer active".to_owned()))?;
        let commit = self
            .pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_control(ProtocolRequest::simple_query("COMMIT")?)
            .await;
        let result = commit.and_then(|response| parse_simple_command_response(&response));
        let tag = result
            .as_ref()
            .ok()
            .and_then(CommandResult::command_tag)
            .map(str::to_owned);
        let ready_status = result.as_ref().ok().map(CommandResult::ready_status);
        if tag.as_deref() != Some("COMMIT") || ready_status != Some(ReadyStatus::Idle) {
            let known_rollback =
                tag.as_deref() == Some("ROLLBACK") && ready_status == Some(ReadyStatus::Idle);
            let primary = result.err().unwrap_or_else(|| {
                Error::Engine(format!(
                    "PostgreSQL transaction command expected COMMIT and idle readiness, got {} with {ready_status:?}",
                    tag.as_deref().unwrap_or("no command tag"),
                ))
            });
            // PostgreSQL may already have committed. A later ROLLBACK cannot
            // undo that boundary, so retain the primary error and mark the
            // session unusable instead of implying recovery. PostgreSQL's
            // COMMIT -> ROLLBACK tag is the one known-idle failure outcome.
            if !known_rollback {
                self.pin
                    .as_ref()
                    .expect("transaction pin is present until commit or rollback")
                    .executor
                    .poison_transaction_state();
            }
            self.guard
                .state
                .store(TRANSACTION_RELEASED, Ordering::SeqCst);
            let executor = Arc::clone(
                &self
                    .pin
                    .as_ref()
                    .expect("transaction pin is present")
                    .executor,
            );
            let release = self
                .pin
                .take()
                .expect("transaction pin is present")
                .release()
                .await;
            return match release {
                Ok(()) => Err(primary),
                Err(release) => {
                    executor.poison_transaction_state();
                    Err(Error::Engine(format!(
                        "transaction commit failed: {primary}; releasing its session pin also failed: {release}"
                    )))
                }
            };
        }
        self.guard
            .state
            .store(TRANSACTION_RELEASED, Ordering::SeqCst);
        let executor = Arc::clone(
            &self
                .pin
                .as_ref()
                .expect("transaction pin is present until commit or rollback")
                .executor,
        );
        let release = self
            .pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await;
        if release.is_err() {
            executor.poison_transaction_state();
        }
        release
    }

    async fn rollback_and_release(mut self) -> Result<()> {
        // rollback() stores its definitive outcome in the guard. Settlement is
        // authoritative because it also observes whether the physical-session
        // pin was released; returning the first error here would discard that
        // second lifecycle failure.
        let _ = self.rollback().await;
        self.finish_explicit_rollback().await
    }

    async fn finish_explicit_rollback(mut self) -> Result<()> {
        let state = self.guard.state.load(Ordering::SeqCst);
        if state == TRANSACTION_FINISHING {
            self.pin
                .as_ref()
                .expect("transaction pin is present until callback completion")
                .executor
                .poison_transaction_state();
        }
        let terminal_error = self
            .guard
            .terminal_error
            .lock()
            .ok()
            .and_then(|mut error| error.take());
        let executor = Arc::clone(
            &self
                .pin
                .as_ref()
                .expect("transaction pin is present until commit or rollback")
                .executor,
        );
        let release = self
            .pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await;
        if release.is_err() {
            executor.poison_transaction_state();
        }
        self.guard
            .state
            .store(TRANSACTION_RELEASED, Ordering::SeqCst);
        match (state, terminal_error, release) {
            (TRANSACTION_ROLLED_BACK, _, release) => release,
            (TRANSACTION_FAILED, Some(error), Ok(())) => Err(error),
            (TRANSACTION_FAILED, Some(error), Err(release)) => Err(Error::Engine(format!(
                "transaction rollback failed: {error}; releasing its session pin also failed: {release}"
            ))),
            (TRANSACTION_FAILED, None, Ok(())) => Err(Error::Engine(
                "transaction rollback failed and its error could not be retained".to_owned(),
            )),
            (TRANSACTION_FAILED, None, Err(release)) => Err(Error::Engine(format!(
                "transaction rollback failed and its error could not be retained; releasing its session pin also failed: {release}"
            ))),
            (TRANSACTION_FINISHING, _, Ok(())) => Err(Error::Engine(
                "transaction control outcome is unknown; close the database".to_owned(),
            )),
            (TRANSACTION_FINISHING, _, Err(release)) => Err(Error::Engine(format!(
                "transaction control outcome is unknown and releasing its session pin failed: {release}"
            ))),
            (_, _, Ok(())) => Err(Error::Engine(
                "transaction finished in an invalid state".to_owned(),
            )),
            (_, _, Err(release)) => Err(Error::Engine(format!(
                "transaction finished in an invalid state and releasing its session pin failed: {release}"
            ))),
        }
    }
}

impl Drop for AsyncTransaction {
    fn drop(&mut self) {
        let state = self
            .guard
            .state
            .swap(TRANSACTION_RELEASED, Ordering::SeqCst);
        if let Some(mut pin) = self.pin.take() {
            if state == TRANSACTION_ACTIVE {
                pin.released = true;
                pin.executor.rollback_and_release_pin_best_effort(pin.token);
            } else if state == TRANSACTION_FINISHING {
                // A COMMIT or explicit ROLLBACK was already admitted before
                // its awaiting future was cancelled. Sending another
                // ROLLBACK could run after a successful COMMIT and cannot
                // establish the original outcome, so poison and only release.
                pin.executor.poison_transaction_state();
                pin.released = true;
                pin.executor.release_pin_best_effort(pin.token);
            } else {
                pin.released = true;
                pin.executor.release_pin_best_effort(pin.token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::task::{Context, Poll, Waker};

    use super::*;
    use crate::engine::EngineSession;
    use crate::error::ErrorKind;

    struct ScriptedTransactionSession {
        responses: VecDeque<Result<ProtocolResponse>>,
    }

    impl ScriptedTransactionSession {
        fn new(responses: impl IntoIterator<Item = Result<ProtocolResponse>>) -> Self {
            Self {
                responses: responses.into_iter().collect(),
            }
        }
    }

    impl EngineSession for ScriptedTransactionSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.responses
                .pop_front()
                .expect("scripted transaction response")
        }
    }

    struct FailBeginAndRecovery {
        calls: Arc<AtomicUsize>,
    }

    impl EngineSession for FailBeginAndRecovery {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(call, 0, "BEGIN transport failure must not send ROLLBACK");
            Err(Error::Engine("BEGIN failed".to_owned()))
        }
    }

    struct CountBeginOnlySession {
        calls: Arc<AtomicUsize>,
    }

    struct BlockingCommitSession {
        calls: usize,
        commit_started: mpsc::Sender<()>,
        release_commit: mpsc::Receiver<()>,
        commit_tag: &'static str,
    }

    impl EngineSession for BlockingCommitSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            let call = self.calls;
            self.calls += 1;
            match call {
                0 => Ok(command_response("BEGIN")),
                1 => {
                    self.commit_started.send(()).expect("announce COMMIT");
                    self.release_commit.recv().expect("release COMMIT");
                    Ok(command_response(self.commit_tag))
                }
                _ => panic!("unexpected transaction command {call}"),
            }
        }
    }

    impl EngineSession for CountBeginOnlySession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(call, 0, "drop sent a second transaction-control command");
            Ok(command_response("BEGIN"))
        }
    }

    #[test]
    fn dropping_a_finishing_transaction_poisons_without_second_rollback() {
        let calls = Arc::new(AtomicUsize::new(0));
        let db =
            AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(CountBeginOnlySession {
                calls: Arc::clone(&calls),
            })));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        transaction
            .guard
            .state
            .store(TRANSACTION_FINISHING, Ordering::SeqCst);
        drop(transaction);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while db.executor.session_is_pinned() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("unknown transaction state can close");
    }

    #[test]
    fn begin_transport_failure_poisons_without_blind_recovery() {
        let calls = Arc::new(AtomicUsize::new(0));
        let executor = EngineExecutor::spawn(Box::new(FailBeginAndRecovery {
            calls: Arc::clone(&calls),
        }));
        let db = AsyncOliphaunt::from_executor(executor);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime");

        let begin = match runtime.block_on(db.start_transaction()) {
            Ok(_) => panic!("BEGIN unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_error(&begin, ErrorKind::Other, "BEGIN failed");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let subsequent = runtime.block_on(db.execute("SELECT 1")).unwrap_err();
        assert_error(&subsequent, ErrorKind::Other, SESSION_STATE_UNKNOWN);
        runtime
            .block_on(db.close())
            .expect("poisoned database can close");
    }

    #[test]
    fn transaction_pin_rejects_unpinned_work_until_rollback_releases_it() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([7])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let error = runtime
            .block_on(db.exec_protocol_raw([9]))
            .expect_err("unpinned work must not use a transaction-owned session");
        assert_error(
            &error,
            ErrorKind::TransactionActive,
            "a transaction is active; use the active transaction handle",
        );
        runtime
            .block_on(transaction.rollback_and_release())
            .expect("transaction rolls back and releases its pin");
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([8]))
                .expect("work resumes after rollback"),
            vec![7]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn transaction_callback_commits_and_releases_the_pin() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("COMMIT")),
            Ok(ProtocolResponse::new([4, 1])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert_eq!(
            runtime
                .block_on(db.transaction(async |_transaction| Ok::<u8, Error>(41_u8)))
                .expect("transaction callback commits"),
            41
        );
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("work resumes after commit"),
            vec![4, 1]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn explicit_rollback_is_one_shot_and_skips_outer_commit() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([4, 3])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert_eq!(
            runtime
                .block_on(db.transaction(async |transaction| {
                    transaction.rollback().await?;
                    assert!(transaction.is_closed());
                    let error = transaction.rollback().await.unwrap_err();
                    assert_error(&error, ErrorKind::Other, "transaction is no longer active");
                    Ok::<u8, Error>(43_u8)
                }))
                .expect("explicit rollback returns the callback value"),
            43
        );
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("work resumes without an outer COMMIT"),
            vec![4, 3]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn manual_transaction_control_cannot_masquerade_as_explicit_rollback() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(extended_command_response("COMMIT")),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let error = runtime
            .block_on(db.transaction(async |transaction| {
                let error = transaction
                    .execute("COMMIT")
                    .await
                    .expect_err("manual COMMIT escapes callback ownership");
                assert!(
                    error
                        .to_string()
                        .contains("outside the SDK-managed transaction lifecycle")
                );
                Ok::<(), Error>(())
            }))
            .expect_err("outer transaction must not turn manual COMMIT into success");
        assert!(
            error
                .to_string()
                .contains("outside the SDK-managed transaction lifecycle")
        );
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned transaction can close");
    }

    #[test]
    fn transaction_chain_is_rejected_before_async_dispatch() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("COMMIT")),
            Ok(ProtocolResponse::new([4, 8])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        runtime
            .block_on(db.transaction(async |transaction| {
                for error in [
                    transaction
                        .execute("ROLLBACK AND CHAIN")
                        .await
                        .expect_err("extended execute rejects transaction replacement"),
                    transaction
                        .query("ABORT WORK AND CHAIN")
                        .await
                        .expect_err("extended query rejects transaction replacement"),
                    transaction
                        .exec("SELECT 1; ROLLBACK TRANSACTION AND CHAIN")
                        .await
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
            }))
            .expect("preflight rejections leave the owned transaction active");

        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("only BEGIN and the outer COMMIT reached the session"),
            vec![4, 8]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn database_structured_error_recovers_to_idle_and_preserves_postgres_error() {
        let mut primary = Vec::new();
        let mut error_body = Vec::new();
        error_body.extend_from_slice(b"SERROR\0C22012\0Mdivision by zero\0\0");
        push_backend_message(&mut primary, b'E', &error_body);
        push_backend_message(&mut primary, b'Z', b"E");
        let session = ScriptedTransactionSession::new([
            Ok(ProtocolResponse::new(primary)),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([8, 8])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let error = runtime
            .block_on(db.execute("SELECT 1 / 0"))
            .expect_err("PostgreSQL error is returned after recovery");
        assert_eq!(error.kind(), ErrorKind::Postgres);
        let error = error
            .postgres_error()
            .expect("expected structured PostgreSQL error");
        assert_eq!(error.sqlstate.as_deref(), Some("22012"));
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("owner completed rollback before admitting more work"),
            vec![8, 8]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn database_query_and_execute_require_extended_protocol_controls() {
        let mut empty = Vec::new();
        push_backend_message(&mut empty, b'I', &[]);
        push_backend_message(&mut empty, b'Z', b"I");
        let session = ScriptedTransactionSession::new([
            Ok(command_response("UPDATE 1")),
            Ok(ProtocolResponse::new(empty)),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let execute = runtime
            .block_on(db.execute("UPDATE items SET value = 1"))
            .expect_err("missing extended-protocol controls must fail");
        assert_eq!(execute.kind(), ErrorKind::Other);
        assert!(
            execute
                .to_string()
                .contains("omitted ParseComplete or BindComplete")
        );
        let query = runtime
            .block_on(db.query(""))
            .expect_err("missing extended-protocol controls must fail");
        assert_eq!(query.kind(), ErrorKind::Other);
        assert!(
            query
                .to_string()
                .contains("omitted ParseComplete or BindComplete")
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn transaction_callback_error_rolls_back_and_preserves_the_body_error() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([4, 0])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let error = runtime
            .block_on(db.transaction(async |_transaction| {
                Err::<(), _>(Error::Engine("body failed".to_owned()))
            }))
            .expect_err("callback error must be returned");
        let TransactionError::Callback(callback) = error else {
            panic!("expected callback transaction error");
        };
        assert_error(&callback, ErrorKind::Other, "body failed");
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("confirmed rollback leaves the session usable"),
            vec![4, 0]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn transaction_callback_rollback_failure_poisons_and_reports_both_errors() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Err(Error::Engine("ROLLBACK transport failed".to_owned())),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let error = runtime
            .block_on(db.transaction(async |_transaction| {
                Err::<(), _>(Error::Engine("body failed".to_owned()))
            }))
            .expect_err("the callback and rollback both fail");
        assert_eq!(
            error.to_string(),
            "transaction callback failed: body failed; rollback also failed: ROLLBACK transport failed"
        );
        let TransactionError::CallbackAndRollback { callback, rollback } = error else {
            panic!("callback and rollback failures must remain structured");
        };
        assert_error(&callback, ErrorKind::Other, "body failed");
        assert_error(&rollback, ErrorKind::Other, "ROLLBACK transport failed");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned transaction can close");
    }

    #[test]
    fn unknown_commit_outcome_poisons_the_session_until_close() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Err(Error::Engine("COMMIT transport failed".to_owned())),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let error = runtime.block_on(transaction.commit()).unwrap_err();
        assert_error(&error, ErrorKind::Other, "COMMIT transport failed");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("unknown transaction state can close");
    }

    #[test]
    fn commit_reported_as_rollback_is_known_idle_and_releases_the_pin() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([4, 2])),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let error = runtime
            .block_on(transaction.commit())
            .expect_err("ROLLBACK command tag must fail commit");
        assert_eq!(error.kind(), ErrorKind::Other);
        assert!(
            error
                .to_string()
                .contains("expected COMMIT and idle readiness, got ROLLBACK")
        );
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([1]))
                .expect("known rolled-back transaction leaves session usable"),
            vec![4, 2]
        );
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn unknown_rollback_outcome_poisons_the_session_until_close() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Err(Error::Engine("ROLLBACK transport failed".to_owned())),
        ]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let error = runtime
            .block_on(transaction.rollback_and_release())
            .unwrap_err();
        assert_error(&error, ErrorKind::Other, "ROLLBACK transport failed");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("unknown transaction state can close");
    }

    #[test]
    fn rollback_settlement_reports_both_control_and_pin_release_failures() {
        let session = ScriptedTransactionSession::new([Ok(command_response("BEGIN"))]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let mut transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let real_token = transaction.pin.as_ref().expect("transaction pin").token;
        transaction.pin.as_mut().expect("transaction pin").token = real_token + 1;

        let error = runtime
            .block_on(transaction.rollback_and_release())
            .expect_err("both settlement operations use the rejected token");
        assert_eq!(
            error.to_string(),
            "transaction rollback failed: transaction is no longer active; releasing its session pin also failed: transaction is no longer active"
        );
        runtime
            .block_on(db.executor.release_pin(real_token))
            .expect("release the deliberately retained test pin");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned transaction can close");
    }

    #[test]
    fn abnormal_commit_reports_its_pin_release_failure() {
        let session = ScriptedTransactionSession::new([Ok(command_response("BEGIN"))]);
        let db = AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let mut transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let real_token = transaction.pin.as_ref().expect("transaction pin").token;
        transaction.pin.as_mut().expect("transaction pin").token = real_token + 1;

        let error = runtime
            .block_on(transaction.commit())
            .expect_err("COMMIT and release both reject the mismatched token");
        assert_eq!(
            error.to_string(),
            "transaction commit failed: transaction is no longer active; releasing its session pin also failed: transaction is no longer active"
        );
        runtime
            .block_on(db.executor.release_pin(real_token))
            .expect("release the deliberately retained test pin");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("unknown commit outcome can close");
    }

    #[test]
    fn successful_commit_with_failed_pin_release_poisons_the_database() {
        let (commit_started, started) = mpsc::channel();
        let (release, release_commit) = mpsc::channel();
        let db =
            AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(BlockingCommitSession {
                calls: 0,
                commit_started,
                release_commit,
                commit_tag: "COMMIT",
            })));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let token = transaction.pin.as_ref().expect("transaction pin").token;
        let mut commit = Box::pin(transaction.commit());
        assert!(poll_once(commit.as_mut()).is_pending());
        started.recv().expect("COMMIT reaches owner");

        // Queue a competing internal release while COMMIT owns the executor.
        // It runs after the successful COMMIT but before commit() can enqueue
        // its own authoritative release attempt.
        let mut competing_release = Box::pin(db.executor.release_pin(token));
        assert!(poll_once(competing_release.as_mut()).is_pending());
        release.send(()).expect("finish COMMIT");
        runtime
            .block_on(competing_release)
            .expect("competing release clears the owner pin");

        let error = runtime.block_on(commit).unwrap_err();
        assert_error(&error, ErrorKind::Other, "transaction is no longer active");
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned committed transaction can close");
    }

    #[test]
    fn known_rollback_commit_with_failed_pin_release_reports_both_and_poisons() {
        let (commit_started, started) = mpsc::channel();
        let (release, release_commit) = mpsc::channel();
        let db =
            AsyncOliphaunt::from_executor(EngineExecutor::spawn(Box::new(BlockingCommitSession {
                calls: 0,
                commit_started,
                release_commit,
                commit_tag: "ROLLBACK",
            })));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        let token = transaction.pin.as_ref().expect("transaction pin").token;
        let mut commit = Box::pin(transaction.commit());
        assert!(poll_once(commit.as_mut()).is_pending());
        started.recv().expect("COMMIT reaches owner");

        let mut competing_release = Box::pin(db.executor.release_pin(token));
        assert!(poll_once(competing_release.as_mut()).is_pending());
        release.send(()).expect("finish COMMIT as ROLLBACK");
        runtime
            .block_on(competing_release)
            .expect("competing release clears the owner pin");

        let error = runtime
            .block_on(commit)
            .expect_err("known rollback and pin release both fail the commit");
        assert!(
            error
                .to_string()
                .contains("expected COMMIT and idle readiness, got ROLLBACK"),
            "primary commit failure is retained: {error}"
        );
        assert!(
            error
                .to_string()
                .contains("releasing its session pin also failed: transaction is no longer active"),
            "pin-release failure is retained: {error}"
        );
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned rolled-back transaction can close");
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime")
    }

    fn poll_once<F: Future>(future: std::pin::Pin<&mut F>) -> Poll<F::Output> {
        let mut context = Context::from_waker(Waker::noop());
        future.poll(&mut context)
    }

    fn assert_unknown_transaction_state(runtime: &tokio::runtime::Runtime, db: &AsyncOliphaunt) {
        let error = runtime.block_on(db.exec_protocol_raw([1])).unwrap_err();
        assert_error(&error, ErrorKind::Other, SESSION_STATE_UNKNOWN);
    }

    fn assert_error(error: &Error, expected_kind: ErrorKind, expected_message: &str) {
        assert_eq!(error.kind(), expected_kind);
        assert_eq!(error.to_string(), expected_message);
    }

    fn command_response(tag: &str) -> ProtocolResponse {
        let mut bytes = Vec::new();
        let mut command = tag.as_bytes().to_vec();
        command.push(0);
        push_backend_message(&mut bytes, b'C', &command);
        push_backend_message(&mut bytes, b'Z', if tag == "BEGIN" { b"T" } else { b"I" });
        ProtocolResponse::new(bytes)
    }

    fn extended_command_response(tag: &str) -> ProtocolResponse {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'1', &[]);
        push_backend_message(&mut bytes, b'2', &[]);
        push_backend_message(&mut bytes, b'n', &[]);
        let mut command = tag.as_bytes().to_vec();
        command.push(0);
        push_backend_message(&mut bytes, b'C', &command);
        push_backend_message(&mut bytes, b'Z', b"I");
        ProtocolResponse::new(bytes)
    }

    fn push_backend_message(bytes: &mut Vec<u8>, tag: u8, body: &[u8]) {
        bytes.push(tag);
        bytes.extend_from_slice(&i32::try_from(body.len() + 4).unwrap().to_be_bytes());
        bytes.extend_from_slice(body);
    }
}
