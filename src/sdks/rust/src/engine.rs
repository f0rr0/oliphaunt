use std::sync::Arc;

use crate::config::OpenConfig;
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};

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

    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let response = self.exec_protocol_raw(request)?;
        on_chunk(response.as_bytes())
    }

    #[cfg(feature = "broker-helper")]
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
