use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::builder::OliphauntBuilder;
use crate::error::{Error, Result};
use crate::executor::{EngineExecutor, run_off_thread};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{
    CommandResult, ExecResult, IntoParameter, Parameter, QueryResult, ReadyStatus,
    StatementDescription, ValueFormat, describe_statement_request, extended_statement_request,
    parse_exec_response, parse_extended_command_response, parse_extended_query_response,
    parse_simple_command_response, parse_statement_description, reject_copy_statements,
};
use crate::session::{
    TRANSACTION_ACTIVE, TRANSACTION_FAILED, TRANSACTION_FINISHING, TRANSACTION_RELEASED,
    TRANSACTION_ROLLED_BACK, TransactionGuard,
};

/// Cloneable asynchronous native database backed by one dedicated owner thread.
#[derive(Clone)]
pub struct Oliphaunt {
    executor: Arc<EngineExecutor>,
}

/// Local PostgreSQL server with an SDK session owned by a dedicated thread.
///
/// Use [`OliphauntServer::connection_string`] with ordinary PostgreSQL clients.
/// Physical server backups use the packaged `pg_basebackup` tool rather than
/// the embedded database backup API.
#[derive(Clone)]
pub struct OliphauntServer {
    database: Oliphaunt,
    connection_string: String,
}

/// Fluent PostgreSQL statement bound to a native database or transaction.
#[must_use = "a SQL statement does nothing until execute(), query(), or describe() is awaited"]
pub struct Sql<'db, 'q> {
    target: SqlTarget<'db>,
    sql: Cow<'q, str>,
    params: Vec<Parameter>,
    result_format: ValueFormat,
}

enum SqlTarget<'db> {
    Database(&'db Oliphaunt),
    Transaction(&'db Transaction),
}

impl<'db, 'q> Sql<'db, 'q> {
    fn database(database: &'db Oliphaunt, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            target: SqlTarget::Database(database),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    fn transaction(transaction: &'db Transaction, sql: impl Into<Cow<'q, str>>) -> Self {
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
    pub async fn execute(self) -> Result<CommandResult> {
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
    pub async fn query(self) -> Result<QueryResult> {
        let request = extended_statement_request(&self.sql, &self.params, self.result_format)?;
        let response = self.exchange(request, "query()").await?;
        let result = parse_extended_query_response(&response)?;
        self.validate_ready(result.ready_status(), "query()")?;
        Ok(result)
    }

    /// Parse and describe a statement without executing it.
    pub async fn describe(self) -> Result<StatementDescription> {
        let request = describe_statement_request(&self.sql, &self.params)?;
        let response = self.exchange(request, "describe()").await?;
        let description = parse_statement_description(&response)?;
        self.validate_ready(description.ready_status(), "describe()")?;
        Ok(description)
    }

    async fn exchange(
        &self,
        request: ProtocolRequest,
        operation: &str,
    ) -> Result<ProtocolResponse> {
        match &self.target {
            SqlTarget::Database(database) => {
                database.executor.exec_structured(request, operation).await
            }
            SqlTarget::Transaction(transaction) => {
                transaction.exec_request(request, operation).await
            }
        }
    }

    fn validate_ready(&self, status: ReadyStatus, operation: &str) -> Result<()> {
        match &self.target {
            SqlTarget::Database(_) if status == ReadyStatus::Idle => Ok(()),
            SqlTarget::Database(_) => Err(Error::Engine(format!(
                "{operation} returned non-idle readiness after structured recovery"
            ))),
            SqlTarget::Transaction(transaction) => transaction.validate_ready(status, operation),
        }
    }
}

impl Oliphaunt {
    /// Create a dedicated owner-thread native builder.
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
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
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::database(self, sql)
    }

    /// Whether this shared handle has been terminally retired.
    ///
    /// This becomes true after successful close and after a teardown attempt
    /// has started but failed. A pre-teardown validation error such as
    /// [`Error::TransactionActive`] leaves it false so the caller can settle
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
    /// Do not block waiting for another operation on this database from inside
    /// the callback: reentrant owner work is rejected to prevent deadlock.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.executor
            .exec_protocol_raw_stream(ProtocolRequest::new(request.as_ref().to_vec()), on_chunk)
            .await
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
    /// [`Sql::bind`] or [`Sql::bind_parameter`].
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

    async fn start_transaction(&self) -> Result<Transaction> {
        // Pinning and BEGIN are one owner command. No unrelated operation can
        // observe a pinned-but-not-started transaction or interleave between
        // those two state transitions.
        let token = self.executor.begin_transaction().await?;
        let pin = SessionPin {
            executor: Arc::clone(&self.executor),
            token,
            released: false,
        };
        Ok(Transaction {
            pin: Some(pin),
            guard: TransactionGuard::active(),
        })
    }

    /// Run a closure inside an explicit SQL transaction pinned to the physical
    /// session.
    ///
    /// This is the ergonomic counterpart to `transaction()`: it sends `BEGIN`,
    /// gives the closure access to the active transaction handle, commits on
    /// success, and rolls back best-effort when the closure returns an error.
    /// While the closure runs, unpinned work on the same `Oliphaunt` handle is
    /// rejected.
    pub async fn transaction<T>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx Transaction) -> Result<T>,
    ) -> Result<T> {
        let tx = self.start_transaction().await?;
        match body(&tx).await {
            Ok(value) => {
                if tx.is_closed() {
                    tx.finish_explicit_rollback().await?;
                    Ok(value)
                } else {
                    tx.commit().await?;
                    Ok(value)
                }
            }
            Err(error) => {
                let rollback = if tx.is_closed() {
                    tx.finish_explicit_rollback().await
                } else {
                    tx.rollback_and_release().await
                };
                match rollback {
                    Ok(()) => Err(error),
                    Err(terminal) if terminal == error => Err(error),
                    Err(rollback) => Err(Error::TransactionRollback {
                        callback: Box::new(error),
                        rollback: Box::new(rollback),
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
    /// [`Error::TransactionActive`] and reopens admission for an explicit retry.
    /// Required `COMMIT` or `ROLLBACK` settlement for a pre-cutoff transaction
    /// remains admissible in FIFO order while close is pending. Concurrent close
    /// calls share one attempt. Success resolves only after the session and its
    /// root lock are released. Once runtime teardown starts, success or failure
    /// terminally retires the handle; a failure is retained exactly and returned
    /// by every repeated close. Call `cancel().await` when a running statement
    /// should be interrupted. Dropping the final handle only requests best-effort
    /// cleanup and never synchronously joins the owner thread.
    pub async fn close(&self) -> Result<()> {
        self.executor.close().await
    }
}

impl OliphauntServer {
    pub(crate) fn from_executor(executor: Arc<EngineExecutor>, connection_string: String) -> Self {
        Self {
            database: Oliphaunt::from_executor(executor),
            connection_string,
        }
    }

    /// Return the nonoptional libpq connection string for the local server.
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }

    /// Build a typed, fluent PostgreSQL statement on the SDK session.
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        self.database.sql(sql)
    }

    /// Whether the SDK session has been terminally retired.
    pub fn is_closed(&self) -> bool {
        self.database.is_closed()
    }

    /// Execute a PostgreSQL command.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.database.execute(sql).await
    }

    /// Execute a PostgreSQL command with extended-query parameters.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        self.database.execute_with_params(sql, params).await
    }

    /// Query PostgreSQL and parse one result set.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.database.query(sql).await
    }

    /// Query PostgreSQL with extended-query parameters.
    pub async fn query_with_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        self.database.query_with_params(sql, params).await
    }

    /// Parse and describe a statement on the SDK session without executing it.
    pub async fn describe(&self, sql: &str) -> Result<StatementDescription> {
        self.database.describe(sql).await
    }

    /// Execute possibly multi-statement SQL through PostgreSQL's simple-query protocol.
    pub async fn exec(&self, sql: &str) -> Result<ExecResult> {
        self.database.exec(sql).await
    }

    /// Execute raw PostgreSQL protocol bytes.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.database.exec_protocol_raw(request).await
    }

    /// Execute raw PostgreSQL protocol bytes with the database stream-callback contract.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.database
            .exec_protocol_raw_stream(request, on_chunk)
            .await
    }

    /// Run a callback in a transaction pinned to the SDK connection.
    pub async fn transaction<T>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx Transaction) -> Result<T>,
    ) -> Result<T> {
        self.database.transaction(body).await
    }

    /// Request cancellation of the active SDK query out of band.
    pub async fn cancel(&self) -> Result<()> {
        self.database.cancel().await
    }

    /// Stop the local server.
    pub async fn close(&self) -> Result<()> {
        self.database.close().await
    }
}

/// Session pin used for transaction or session-state-sensitive protocol work.
struct SessionPin {
    executor: Arc<EngineExecutor>,
    token: u64,
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
            .pinned_exec_protocol_control(self.token, ProtocolRequest::simple_query(sql)?)
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
            .pinned_exec_protocol_control(self.token, request.into())
            .await
    }

    /// Release the session pin.
    pub async fn release(mut self) -> Result<()> {
        let result = self.executor.release_pin(self.token).await;
        if result.is_ok() {
            self.released = true;
        }
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
pub struct Transaction {
    pin: Option<SessionPin>,
    guard: Arc<TransactionGuard>,
}

impl Transaction {
    /// Build a typed, fluent PostgreSQL statement inside this transaction.
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::transaction(self, sql)
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

    fn validate_ready(&self, status: ReadyStatus, operation: &str) -> Result<()> {
        match status {
            ReadyStatus::InTransaction | ReadyStatus::FailedTransaction => Ok(()),
            ReadyStatus::Idle => {
                let error = Error::Engine(format!(
                    "{operation} ended the callback transaction outside Transaction::rollback(); the session is now unusable"
                ));
                self.pin
                    .as_ref()
                    .expect("transaction pin is retained until the callback returns")
                    .executor
                    .poison_transaction_state();
                self.guard.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
                if let Ok(mut terminal_error) = self.guard.terminal_error.lock()
                    && terminal_error.is_none()
                {
                    *terminal_error = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    async fn exec_request(
        &self,
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
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute a command with extended-query parameters inside the transaction.
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
    /// protocol inside the transaction and return its row-shaped result.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query().await
    }

    /// Execute SQL with extended-query parameters inside the transaction.
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

    /// Execute possibly multi-statement SQL through PostgreSQL's simple-query protocol.
    pub async fn exec(&self, sql: &str) -> Result<ExecResult> {
        reject_copy_statements(sql)?;
        let response = self
            .exec_request(ProtocolRequest::simple_query(sql)?, "Transaction::exec()")
            .await?;
        let result = parse_exec_response(&response)?;
        self.validate_ready(result.ready_status(), "Transaction::exec()")?;
        Ok(result)
    }

    /// Parse and describe a statement without executing it.
    pub async fn describe(&self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Execute raw protocol bytes inside the transaction.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.ensure_active()?;
        let pin = self
            .pin
            .as_ref()
            .expect("transaction pin is retained until the callback returns");
        pin.executor
            .pinned_exec_protocol_raw_guarded(
                pin.token,
                ProtocolRequest::new(request.as_ref().to_vec()),
                Arc::clone(&self.guard),
            )
            .await
            .map(ProtocolResponse::into_bytes)
    }

    /// Execute raw PostgreSQL protocol bytes with the database stream-callback
    /// contract inside the active transaction.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.ensure_active()?;
        let pin = self
            .pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback");
        pin.executor
            .pinned_exec_protocol_raw_stream(
                pin.token,
                ProtocolRequest::new(request.as_ref().to_vec()),
                Some(Arc::clone(&self.guard)),
                on_chunk,
            )
            .await
    }

    /// Roll back this callback transaction immediately.
    ///
    /// The handle expires after the first attempt. If the callback subsequently
    /// returns `Ok`, the outer transaction skips `COMMIT` and returns that value.
    pub async fn rollback(&self) -> Result<()> {
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
                if let Ok(mut terminal_error) = self.guard.terminal_error.lock() {
                    *terminal_error = Some(error.clone());
                }
                self.guard.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
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
            let _ = self
                .pin
                .take()
                .expect("transaction pin is present")
                .release()
                .await;
            return Err(primary);
        }
        self.guard
            .state
            .store(TRANSACTION_RELEASED, Ordering::SeqCst);
        self.pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await
    }

    async fn rollback_and_release(self) -> Result<()> {
        let rollback = self.rollback().await;
        let finish = self.finish_explicit_rollback().await;
        rollback.and(finish)
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
        let release = self
            .pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await;
        self.guard
            .state
            .store(TRANSACTION_RELEASED, Ordering::SeqCst);
        match (state, terminal_error, release) {
            (TRANSACTION_ROLLED_BACK, _, release) => release,
            (TRANSACTION_FAILED, Some(error), Ok(())) => Err(error),
            (TRANSACTION_FAILED, Some(error), Err(release)) => Err(Error::Engine(format!(
                "transaction rollback failed: {error}; releasing its session pin also failed: {release}"
            ))),
            (TRANSACTION_FAILED, None, release) => release.and(Err(Error::Engine(
                "transaction rollback failed and its error could not be retained".to_owned(),
            ))),
            (TRANSACTION_FINISHING, _, Ok(())) => Err(Error::Engine(
                "transaction control outcome is unknown; close the database".to_owned(),
            )),
            (TRANSACTION_FINISHING, _, Err(release)) => Err(Error::Engine(format!(
                "transaction control outcome is unknown and releasing its session pin failed: {release}"
            ))),
            (_, _, release) => release.and(Err(Error::Engine(
                "transaction finished in an invalid state".to_owned(),
            ))),
        }
    }
}

impl Drop for Transaction {
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::engine::EngineSession;

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
        calls: AtomicUsize,
    }

    impl EngineSession for FailBeginAndRecovery {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            Err(Error::Engine(if call == 0 {
                "BEGIN failed".to_owned()
            } else {
                "ROLLBACK failed".to_owned()
            }))
        }
    }

    struct CountBeginOnlySession {
        calls: Arc<AtomicUsize>,
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(CountBeginOnlySession {
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
    fn failed_begin_recovery_poisons_unknown_transaction_state() {
        let executor = EngineExecutor::spawn(Box::new(FailBeginAndRecovery {
            calls: AtomicUsize::new(0),
        }));
        let db = Oliphaunt::from_executor(executor);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime");

        let begin = match runtime.block_on(db.start_transaction()) {
            Ok(_) => panic!("BEGIN unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(begin, Error::Engine("BEGIN failed".to_owned()));
        let subsequent = runtime.block_on(db.execute("SELECT 1")).unwrap_err();
        assert_eq!(
            subsequent,
            Error::Engine("transaction state is unknown; close the database".to_owned())
        );
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        assert_eq!(
            runtime
                .block_on(db.exec_protocol_raw([9]))
                .expect_err("unpinned work must not use a transaction-owned session"),
            Error::TransactionActive
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert_eq!(
            runtime
                .block_on(db.transaction(async |_transaction| Ok(41_u8)))
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert_eq!(
            runtime
                .block_on(db.transaction(async |transaction| {
                    transaction.rollback().await?;
                    assert!(transaction.is_closed());
                    assert_eq!(
                        transaction.rollback().await.unwrap_err(),
                        Error::Engine("transaction is no longer active".to_owned())
                    );
                    Ok(43_u8)
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
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
                        .contains("outside Transaction::rollback()")
                );
                Ok(())
            }))
            .expect_err("outer transaction must not turn manual COMMIT into success");
        assert!(
            error
                .to_string()
                .contains("outside Transaction::rollback()")
        );
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("poisoned transaction can close");
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let Error::Postgres(error) = runtime
            .block_on(db.execute("SELECT 1 / 0"))
            .expect_err("PostgreSQL error is returned after recovery")
        else {
            panic!("expected structured PostgreSQL error");
        };
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert!(matches!(
            runtime.block_on(db.execute("UPDATE items SET value = 1")),
            Err(Error::Engine(message))
                if message.contains("omitted ParseComplete or BindComplete")
        ));
        assert!(matches!(
            runtime.block_on(db.query("")),
            Err(Error::Engine(message))
                if message.contains("omitted ParseComplete or BindComplete")
        ));
        runtime.block_on(db.close()).expect("database closes");
    }

    #[test]
    fn transaction_callback_error_rolls_back_and_preserves_the_body_error() {
        let session = ScriptedTransactionSession::new([
            Ok(command_response("BEGIN")),
            Ok(command_response("ROLLBACK")),
            Ok(ProtocolResponse::new([4, 0])),
        ]);
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        assert_eq!(
            runtime.block_on(db.transaction(async |_transaction| {
                Err::<(), _>(Error::Engine("body failed".to_owned()))
            })),
            Err(Error::Engine("body failed".to_owned()))
        );
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
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
        let Error::TransactionRollback { callback, rollback } = error else {
            panic!("callback and rollback failures must remain structured");
        };
        assert_eq!(*callback, Error::Engine("body failed".to_owned()));
        assert_eq!(
            *rollback,
            Error::Engine("ROLLBACK transport failed".to_owned())
        );
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        assert_eq!(
            runtime.block_on(transaction.commit()).unwrap_err(),
            Error::Engine("COMMIT transport failed".to_owned())
        );
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        assert!(matches!(
            runtime.block_on(transaction.commit()),
            Err(Error::Engine(message))
                if message.contains("expected COMMIT and idle readiness, got ROLLBACK")
        ));
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
        let db = Oliphaunt::from_executor(EngineExecutor::spawn(Box::new(session)));
        let runtime = test_runtime();

        let transaction = runtime
            .block_on(db.start_transaction())
            .expect("transaction begins");
        assert_eq!(
            runtime
                .block_on(transaction.rollback_and_release())
                .unwrap_err(),
            Error::Engine("ROLLBACK transport failed".to_owned())
        );
        assert_unknown_transaction_state(&runtime, &db);
        runtime
            .block_on(db.close())
            .expect("unknown transaction state can close");
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime")
    }

    fn assert_unknown_transaction_state(runtime: &tokio::runtime::Runtime, db: &Oliphaunt) {
        assert_eq!(
            runtime.block_on(db.exec_protocol_raw([1])).unwrap_err(),
            Error::Engine("transaction state is unknown; close the database".to_owned())
        );
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
