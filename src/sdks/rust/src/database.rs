use std::sync::Arc;

use crate::builder::OliphauntBuilder;
use crate::error::{Error, Result};
use crate::executor::EngineExecutor;
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{
    CommandResult, QueryParam, QueryResult, extended_query_request, parse_command_response,
    parse_query_response,
};

/// Open native Oliphaunt database handle.
#[derive(Clone)]
pub struct Oliphaunt {
    executor: Arc<EngineExecutor>,
}

/// Local PostgreSQL server owned by Oliphaunt.
///
/// Use [`OliphauntServer::connection_string`] with ordinary PostgreSQL clients.
/// Physical server backups use the packaged `pg_basebackup` tool rather than
/// the embedded database backup API.
#[derive(Clone)]
pub struct OliphauntServer {
    database: Oliphaunt,
    connection_string: String,
}

impl Oliphaunt {
    /// Create a native Oliphaunt builder.
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
    }

    /// Restore physical backup bytes into an empty filesystem destination.
    pub fn restore(
        destination: impl Into<std::path::PathBuf>,
        backup: impl AsRef<[u8]>,
    ) -> Result<()> {
        crate::liboliphaunt::OliphauntRuntime::from_env()
            .restore(&destination.into(), backup.as_ref())
    }

    pub(crate) fn from_executor(executor: Arc<EngineExecutor>) -> Self {
        Self { executor }
    }

    /// Request cancellation of the currently active backend query.
    ///
    /// Engines that support cancellation issue this out of band rather than
    /// queueing behind normal SQL work.
    pub fn cancel(&self) -> Result<()> {
        self.executor.cancel()
    }

    /// Execute raw PostgreSQL protocol bytes through the owner executor.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.executor
            .exec_protocol_raw(ProtocolRequest::new(request.as_ref().to_vec()))
            .await
            .map(ProtocolResponse::into_bytes)
    }

    /// Execute a PostgreSQL command through the simple-query protocol.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        parse_command_response(&self.executor.exec_simple_query(sql.to_owned()).await?)
    }

    /// Execute a PostgreSQL command with extended-query parameters.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let params = params.into_iter().map(Into::into).collect::<Vec<_>>();
        let response = self
            .executor
            .exec_protocol_raw(extended_query_request(sql, params)?)
            .await?;
        parse_command_response(&response)
    }

    /// Execute SQL through PostgreSQL's simple-query protocol and parse one
    /// result set into rows and fields.
    ///
    /// Use `exec_protocol_raw` for COPY,
    /// multi-result-set protocol handling, or custom frontend protocol flows.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        parse_query_response(&self.executor.exec_simple_query(sql.to_owned()).await?)
    }

    /// Execute SQL with extended-query parameters and parse one result set.
    pub async fn query_with_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let params = params.into_iter().map(Into::into).collect::<Vec<_>>();
        let response = self
            .executor
            .exec_protocol_raw(extended_query_request(sql, params)?)
            .await?;
        parse_query_response(&response)
    }

    /// Pin the single physical session for transaction/session-state-sensitive
    /// work. While the pin is active, unpinned work is rejected.
    async fn pin_session(&self) -> Result<SessionPin> {
        let token = self.executor.pin_session().await?;
        Ok(SessionPin {
            executor: Arc::clone(&self.executor),
            token,
            released: false,
        })
    }

    async fn start_transaction(&self) -> Result<Transaction> {
        let pin = self.pin_session().await?;
        if let Err(error) = pin.execute_transaction_command("BEGIN", "BEGIN").await {
            if pin
                .execute_transaction_command("ROLLBACK", "ROLLBACK")
                .await
                .is_err()
            {
                pin.executor.poison_transaction_state();
            }
            let _ = pin.release().await;
            return Err(error);
        }
        Ok(Transaction {
            pin: Some(pin),
            finished: false,
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
                tx.commit().await?;
                Ok(value)
            }
            Err(error) => {
                let _ = tx.rollback().await;
                Err(error)
            }
        }
    }

    /// Force a checkpoint.
    pub async fn checkpoint(&self) -> Result<()> {
        self.execute("CHECKPOINT").await.map(|_| ())
    }

    /// Create a backup.
    pub async fn backup(&self) -> Result<Vec<u8>> {
        self.executor.backup().await
    }

    /// Close the database.
    ///
    /// Once close starts, queued work is rejected. Active work is allowed to
    /// finish before the engine closes; call `cancel()` explicitly when a
    /// running statement should be interrupted.
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

    /// Execute a PostgreSQL command.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.database.execute(sql).await
    }

    /// Execute a PostgreSQL command with extended-query parameters.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
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
        P: Into<QueryParam>,
    {
        self.database.query_with_params(sql, params).await
    }

    /// Execute raw PostgreSQL protocol bytes.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.database.exec_protocol_raw(request).await
    }

    /// Run a callback in a transaction pinned to the SDK connection.
    pub async fn transaction<T>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx Transaction) -> Result<T>,
    ) -> Result<T> {
        self.database.transaction(body).await
    }

    /// Force a checkpoint.
    pub async fn checkpoint(&self) -> Result<()> {
        self.database.checkpoint().await
    }

    /// Request cancellation of the active SDK query.
    pub fn cancel(&self) -> Result<()> {
        self.database.cancel()
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
    ) -> Result<CommandResult> {
        let response = self
            .exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
            .await?;
        let result = parse_command_response(&response)?;
        if result.command_tag() != Some(expected) {
            return Err(Error::Engine(format!(
                "PostgreSQL transaction command expected {expected}, got {}",
                result.command_tag().unwrap_or("no command tag")
            )));
        }
        Ok(result)
    }

    /// Execute raw protocol bytes while holding the physical-session pin.
    pub async fn exec_protocol_raw(
        &self,
        request: impl Into<ProtocolRequest>,
    ) -> Result<ProtocolResponse> {
        self.executor
            .pinned_exec_protocol_raw(self.token, request.into())
            .await
    }

    async fn query<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let request = extended_query_request(sql, params)?;
        let response = self.exec_protocol_raw(request).await?;
        parse_query_response(&response)
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

/// Explicit transaction pinned to one physical PostgreSQL session.
pub struct Transaction {
    pin: Option<SessionPin>,
    finished: bool,
}

impl Transaction {
    /// Execute SQL through PostgreSQL's simple-query protocol inside the
    /// transaction.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        let response = self
            .pin
            .as_ref()
            .expect("transaction pin is present until callback returns")
            .exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
            .await?;
        parse_command_response(&response)
    }

    /// Execute a command with extended-query parameters inside the transaction.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let params = params.into_iter().map(Into::into).collect::<Vec<_>>();
        let response = self
            .pin
            .as_ref()
            .expect("transaction pin is present until callback returns")
            .exec_protocol_raw(extended_query_request(sql, params)?)
            .await?;
        parse_command_response(&response)
    }

    /// Execute SQL through PostgreSQL's simple-query protocol inside the
    /// transaction and parse one result set.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        let response = self
            .pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
            .await?;
        parse_query_response(&response)
    }

    /// Execute SQL with extended-query parameters inside the transaction.
    pub async fn query_with_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .query(sql, params)
            .await
    }

    /// Execute raw protocol bytes inside the transaction.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::new(request.as_ref().to_vec()))
            .await
            .map(ProtocolResponse::into_bytes)
    }

    /// Commit the transaction and release the session pin.
    async fn commit(mut self) -> Result<()> {
        let commit = self
            .pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query("COMMIT")?)
            .await;
        let result = commit.and_then(|response| parse_command_response(&response));
        let tag = result
            .as_ref()
            .ok()
            .and_then(CommandResult::command_tag)
            .map(str::to_owned);
        if tag.as_deref() != Some("COMMIT") {
            let known_rollback = tag.as_deref() == Some("ROLLBACK");
            let primary = result.err().unwrap_or_else(|| {
                Error::Engine(format!(
                    "PostgreSQL transaction command expected COMMIT, got {}",
                    tag.as_deref().unwrap_or("no command tag")
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
            self.finished = true;
            let _ = self
                .pin
                .take()
                .expect("transaction pin is present")
                .release()
                .await;
            return Err(primary);
        }
        self.finished = true;
        self.pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await
    }

    /// Roll back the transaction and release the session pin.
    async fn rollback(mut self) -> Result<()> {
        let rollback = self
            .pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .execute_transaction_command("ROLLBACK", "ROLLBACK")
            .await;
        if rollback.is_err() {
            self.pin
                .as_ref()
                .expect("transaction pin is present until commit or rollback")
                .executor
                .poison_transaction_state();
        }
        self.finished = true;
        let release = self
            .pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await;
        rollback.and(release)
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        if !self.finished {
            self.finished = true;
            if let Some(mut pin) = self.pin.take() {
                pin.released = true;
                pin.executor.rollback_and_release_pin_best_effort(pin.token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::engine::EngineSession;

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
}
