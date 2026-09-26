use crate::config::OpenConfig;
use crate::engine::{EngineCancel, EngineSession, NativeRuntime, ProtocolStreamOutcome};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::{Error, Result};
use liboliphaunt_native_bindings::{NativeCancel, NativeSession};
#[cfg(feature = "desktop")]
pub(crate) use liboliphaunt_native_bindings::{PreparedNativeRoot, configure_native_tool_env};
use std::sync::Arc;
#[derive(Debug, Clone, Default)]
pub struct OliphauntRuntime;
impl OliphauntRuntime {
    pub fn from_env() -> Self {
        Self
    }
    pub(crate) fn restore(&self, destination: &std::path::Path, bytes: &[u8]) -> Result<()> {
        NativeSession::restore(destination, bytes).map_err(Into::into)
    }
}
impl NativeRuntime for OliphauntRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        config.validate()?;
        Ok(Box::new(NativeSession::open(config.native_config())?))
    }
}
impl EngineCancel for NativeCancel {
    fn cancel(&self) -> Result<()> {
        NativeCancel::cancel(self).map_err(Into::into)
    }
}
impl EngineSession for NativeSession {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        Some(Arc::new(NativeSession::cancel_handle(self)))
    }
    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        NativeSession::exec_protocol_raw(self, request.as_bytes())
            .map(ProtocolResponse::new)
            .map_err(Into::into)
    }
    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        match NativeSession::exec_protocol_raw_stream::<Error>(self, request.as_bytes(), on_chunk) {
            liboliphaunt_native_bindings::ProtocolStreamOutcome::ReadyForQuery(result) => {
                ProtocolStreamOutcome::ReadyForQuery(result)
            }
            liboliphaunt_native_bindings::ProtocolStreamOutcome::SessionStateUnknown(error) => {
                ProtocolStreamOutcome::SessionStateUnknown(error.into())
            }
        }
    }
    fn backup(&mut self) -> Result<Vec<u8>> {
        NativeSession::backup(self).map_err(Into::into)
    }
    fn close(&mut self) -> Result<()> {
        NativeSession::close(self).map_err(Into::into)
    }
}
