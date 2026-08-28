use std::sync::Arc;

use crate::config::OpenConfig;
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};

/// Internal completion boundary for streamed protocol execution.
///
/// A callback failure is recoverable only when the adapter has independently
/// observed the request's `ReadyForQuery` boundary. Any transport/runtime
/// failure which cannot prove that boundary leaves the physical session state
/// unknown and must take precedence over the callback outcome.
pub(crate) enum ProtocolStreamOutcome {
    ReadyForQuery(Result<()>),
    SessionStateUnknown(Error),
}

pub(crate) trait NativeRuntime: Send + Sync + 'static {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>>;
}

pub(crate) trait EngineSession: Send + 'static {
    fn connection_string(&self) -> Option<String> {
        None
    }

    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        None
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse>;

    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        match self.exec_protocol_raw(request) {
            Ok(response) => ProtocolStreamOutcome::ReadyForQuery(on_chunk(response.as_bytes())),
            Err(error) => ProtocolStreamOutcome::SessionStateUnknown(error),
        }
    }

    #[cfg(feature = "__internal-broker-helper")]
    fn exec_simple_query(&mut self, sql: &str) -> Result<ProtocolResponse> {
        self.exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
    }

    fn backup(&mut self) -> Result<Vec<u8>> {
        Err(Error::Engine(
            "physical backup is not supported by this runtime".into(),
        ))
    }

    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

pub(crate) trait EngineCancel: Send + Sync + 'static {
    fn cancel(&self) -> Result<()>;
}
