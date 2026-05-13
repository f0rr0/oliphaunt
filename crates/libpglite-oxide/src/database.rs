use std::sync::Arc;

use crate::builder::PgliteBuilder;
use crate::engine::EngineCapabilities;
use crate::error::Result;
use crate::executor::EngineExecutor;
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{BackupArtifact, BackupRequest};

/// Open native PGlite database handle.
#[derive(Clone)]
pub struct Pglite {
    executor: Arc<EngineExecutor>,
}

impl Pglite {
    /// Create a native PGlite builder.
    pub fn builder() -> PgliteBuilder {
        PgliteBuilder::new()
    }

    pub(crate) fn from_executor(executor: Arc<EngineExecutor>) -> Self {
        Self { executor }
    }

    /// Return the capabilities of the opened native engine.
    pub fn capabilities(&self) -> EngineCapabilities {
        self.executor.capabilities()
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
        self.exec_protocol_raw(ProtocolRequest::simple_query(sql))
            .await
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
        pin.exec_protocol_raw(ProtocolRequest::simple_query("BEGIN"))
            .await?;
        Ok(Transaction {
            pin: Some(pin),
            finished: false,
        })
    }

    /// Force a checkpoint.
    pub async fn checkpoint(&self) -> Result<()> {
        self.executor.checkpoint().await
    }

    /// Create a backup.
    pub async fn backup(&self, request: BackupRequest) -> Result<BackupArtifact> {
        self.executor.backup(request).await
    }

    /// Close the database.
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
            .exec_protocol_raw(ProtocolRequest::simple_query(sql))
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

    /// Commit the transaction and release the session pin.
    pub async fn commit(mut self) -> Result<()> {
        self.pin
            .as_ref()
            .expect("transaction pin is present until commit or rollback")
            .exec_protocol_raw(ProtocolRequest::simple_query("COMMIT"))
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
            .exec_protocol_raw(ProtocolRequest::simple_query("ROLLBACK"))
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
        }
    }
}
