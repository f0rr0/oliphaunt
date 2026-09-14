//! Prepared native inputs for the private generated mobile bindings.

use crate::executor::EngineExecutor;
use crate::{AsyncOliphaunt, Result};
use liboliphaunt_native_bindings::{NativeOpenOptions, NativeSession};
use std::sync::Arc;

/// One request with cancellation authority limited to that request.
pub struct Request {
    database: AsyncOliphaunt,
    cancellation: Arc<crate::executor::RequestCancellation>,
}

impl Request {
    /// Whether the owner started this request; false failures leave SQL untouched.
    pub fn was_submitted(&self) -> bool {
        self.cancellation.was_submitted()
    }
    /// Whether cancellation was requested for this operation.
    pub fn was_cancelled(&self) -> bool {
        self.cancellation.was_cancelled()
    }
    /// Create an independent cancellation handle before starting foreign work.
    pub fn new(database: &AsyncOliphaunt) -> Self {
        Self {
            database: database.clone(),
            cancellation: database.executor.request_cancellation(),
        }
    }

    /// Execute once through the existing owner queue. Abandoning this future cancels its work.
    pub async fn execute(&self, bytes: Vec<u8>) -> Result<Vec<u8>> {
        self.database
            .executor
            .exec_cancellable(
                crate::protocol::ProtocolRequest::new(bytes),
                Arc::clone(&self.cancellation),
            )
            .await
            .map(crate::protocol::ProtocolResponse::into_bytes)
    }

    /// Stream once with the same owned request cancellation and recovery boundary.
    pub async fn stream<F, O>(
        &self,
        bytes: Vec<u8>,
        on_chunk: F,
    ) -> crate::RawStreamResult<(), O::Error>
    where
        F: FnMut(&[u8]) -> O + Send + 'static,
        O: crate::RawStreamCallbackOutput,
        O::Error: Send + 'static,
    {
        let callback_error = Arc::new(std::sync::Mutex::new(None));
        let result = self
            .database
            .executor
            .stream_cancellable(
                crate::protocol::ProtocolRequest::new(bytes),
                crate::database::adapt_raw_stream_callback(on_chunk, Arc::clone(&callback_error)),
                Arc::clone(&self.cancellation),
            )
            .await;
        crate::database::resolve_raw_stream_outcome(result, callback_error)
    }

    /// Request cancellation without targeting any other queued or later operation.
    pub fn cancel(&self) -> Result<()> {
        self.cancellation.cancel()
    }
}

/// Open host-prepared resources on the existing serialized SDK owner thread.
pub async fn open(options: NativeOpenOptions) -> Result<AsyncOliphaunt> {
    let (executor, ()) = EngineExecutor::open("oliphaunt-mobile", move || {
        let session = NativeSession::open_prepared_inputs(options)?;
        Ok((Box::new(session), ()))
    })
    .await?;
    Ok(AsyncOliphaunt::from_executor(executor))
}

/// Restore host-owned bytes without blocking the foreign async executor.
pub async fn restore(
    library: Option<std::path::PathBuf>,
    destination: std::path::PathBuf,
    bytes: Vec<u8>,
) -> Result<()> {
    crate::executor::run_off_thread("oliphaunt-mobile-restore", move || {
        match library {
            Some(path) => NativeSession::restore_from_library(&path, &destination, &bytes),
            None => NativeSession::restore_from_current_process(&destination, &bytes),
        }
        .map_err(Into::into)
    })
    .await
}
