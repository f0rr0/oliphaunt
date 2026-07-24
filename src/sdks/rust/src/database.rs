use std::sync::Arc;

use crate::builder::OliphauntBuilder;
use crate::engine::EngineCapabilities;
use crate::error::Result;
use crate::executor::EngineExecutor;
use crate::lifecycle::{BackgroundPreparationOptions, BackgroundPreparationResult};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{QueryParam, QueryResult, extended_query_request, parse_query_response};
use crate::storage::{BackupArtifact, BackupFormat, BackupRequest, RestoreRequest};

/// Open native Oliphaunt database handle.
#[derive(Clone)]
pub struct Oliphaunt {
    executor: Arc<EngineExecutor>,
}

impl Oliphaunt {
    /// Create a native Oliphaunt builder.
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
    }

    /// Restore a backup artifact into a database root.
    pub async fn restore(request: RestoreRequest) -> Result<std::path::PathBuf> {
        Self::restore_blocking(request)
    }

    /// Restore a backup artifact into a database root from synchronous host
    /// tooling.
    pub fn restore_blocking(request: RestoreRequest) -> Result<std::path::PathBuf> {
        crate::backup::restore_backup(request)
    }

    pub(crate) fn from_executor(executor: Arc<EngineExecutor>) -> Self {
        Self { executor }
    }

    /// Return the capabilities of the opened native engine.
    pub fn capabilities(&self) -> EngineCapabilities {
        self.executor.capabilities()
    }

    /// Return a PostgreSQL-compatible connection string when the engine exposes
    /// one. Direct mode intentionally returns `None`.
    pub fn connection_string(&self) -> Option<String> {
        self.executor.connection_string()
    }

    /// True when the opened engine can produce the requested backup format.
    pub fn supports_backup_format(&self, format: BackupFormat) -> bool {
        self.capabilities().supports_backup_format(format)
    }

    /// True when the opened engine can restore the requested backup artifact
    /// format.
    pub fn supports_restore_format(&self, format: BackupFormat) -> bool {
        self.capabilities().supports_restore_format(format)
    }

    /// Request cancellation of the currently active backend query.
    ///
    /// Engines that support cancellation issue this out of band rather than
    /// queueing behind normal SQL work.
    pub fn cancel(&self) -> Result<()> {
        self.executor.cancel()
    }

    /// Execute raw PostgreSQL protocol bytes through the owner executor.
    pub async fn exec_protocol_raw(
        &self,
        request: impl Into<ProtocolRequest>,
    ) -> Result<ProtocolResponse> {
        self.executor.exec_protocol_raw(request.into()).await
    }

    /// Execute SQL through PostgreSQL's simple-query protocol.
    pub async fn execute(&self, sql: &str) -> Result<ProtocolResponse> {
        self.executor.exec_simple_query(sql.to_owned()).await
    }

    /// Execute SQL through PostgreSQL's simple-query protocol and parse one
    /// result set into rows and fields.
    ///
    /// Use `exec_protocol_raw` or `exec_protocol_raw_stream` for COPY,
    /// multi-result-set protocol handling, or custom frontend protocol flows.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        let response = self.execute(sql).await?;
        parse_query_response(&response)
    }

    /// Execute a parameterized SQL statement through PostgreSQL's extended
    /// protocol and parse one result set.
    pub async fn query_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let request = extended_query_request(sql, params)?;
        let response = self.exec_protocol_raw(request).await?;
        parse_query_response(&response)
    }

    /// Execute raw PostgreSQL protocol bytes and stream backend bytes.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl Into<ProtocolRequest>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.executor
            .exec_protocol_stream(request.into(), on_chunk)
            .await
    }

    /// Pin the single physical session for transaction/session-state-sensitive
    /// work. While the pin is active, unpinned work is rejected.
    pub async fn pin_session(&self) -> Result<SessionPin> {
        let token = self.executor.pin_session().await?;
        Ok(SessionPin {
            executor: Arc::clone(&self.executor),
            token,
            released: false,
        })
    }

    /// Start an explicit SQL transaction pinned to the physical session.
    pub async fn transaction(&self) -> Result<Transaction> {
        let pin = self.pin_session().await?;
        pin.exec_protocol_raw(ProtocolRequest::simple_query("BEGIN")?)
            .await?;
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
    pub async fn with_transaction<T>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx Transaction) -> Result<T>,
    ) -> Result<T> {
        let tx = self.transaction().await?;
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
        self.executor.checkpoint().await
    }

    /// Prepare the database for mobile or desktop app suspension.
    ///
    /// The SDK sends cancellation out of band when active work is running and
    /// checkpoints only when the physical session is idle. It never fakes
    /// checkpoint success while a transaction or explicit session pin owns the
    /// single direct-mode session.
    pub async fn prepare_for_background(
        &self,
        options: BackgroundPreparationOptions,
    ) -> Result<BackgroundPreparationResult> {
        self.executor.prepare_for_background(options).await
    }

    /// Resume the database after app foregrounding.
    ///
    /// This probes the owner executor with a cheap PostgreSQL query so callers
    /// observe any runtime failure immediately instead of on the next user
    /// query.
    pub async fn resume_from_background(&self) -> Result<()> {
        self.executor.resume_from_background().await
    }

    /// Create a backup.
    pub async fn backup(&self, request: BackupRequest) -> Result<BackupArtifact> {
        self.executor.backup(request).await
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

/// Session pin used for transaction or session-state-sensitive protocol work.
pub struct SessionPin {
    executor: Arc<EngineExecutor>,
    token: u64,
    released: bool,
}

impl SessionPin {
    /// Execute raw protocol bytes while holding the physical-session pin.
    pub async fn exec_protocol_raw(
        &self,
        request: impl Into<ProtocolRequest>,
    ) -> Result<ProtocolResponse> {
        self.executor
            .pinned_exec_protocol_raw(self.token, request.into())
            .await
    }

    /// Execute raw PostgreSQL protocol bytes and stream backend bytes while
    /// holding the physical-session pin.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl Into<ProtocolRequest>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.executor
            .pinned_exec_protocol_stream(self.token, request.into(), on_chunk)
            .await
    }

    /// Execute a parameterized SQL statement while holding the physical-session
    /// pin.
    pub async fn query_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        let request = extended_query_request(sql, params)?;
        let response = self.exec_protocol_raw(request).await?;
        parse_query_response(&response)
    }

    /// Execute SQL through PostgreSQL's simple-query protocol while holding the
    /// physical-session pin.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        let response = self
            .exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
            .await?;
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
    pub async fn execute(&self, sql: &str) -> Result<ProtocolResponse> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
            .await
    }

    /// Execute SQL through PostgreSQL's simple-query protocol inside the
    /// transaction and parse one result set.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .query(sql)
            .await
    }

    /// Execute a parameterized SQL statement through PostgreSQL's extended
    /// protocol inside the transaction and parse one result set.
    pub async fn query_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: Into<QueryParam>,
    {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .query_params(sql, params)
            .await
    }

    /// Execute raw protocol bytes inside the transaction.
    pub async fn exec_protocol_raw(
        &self,
        request: impl Into<ProtocolRequest>,
    ) -> Result<ProtocolResponse> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(request)
            .await
    }

    /// Execute raw PostgreSQL protocol bytes and stream backend bytes inside
    /// the transaction.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl Into<ProtocolRequest>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw_stream(request, on_chunk)
            .await
    }

    /// Commit the transaction and release the session pin.
    pub async fn commit(mut self) -> Result<()> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query("COMMIT")?)
            .await?;
        self.finished = true;
        self.pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await
    }

    /// Roll back the transaction and release the session pin.
    pub async fn rollback(mut self) -> Result<()> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query("ROLLBACK")?)
            .await?;
        self.finished = true;
        self.pin
            .take()
            .expect("transaction pin is present until commit or rollback")
            .release()
            .await
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
