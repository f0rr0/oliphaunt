use crate::config::{EngineMode, OpenConfig};
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{BackupArtifact, BackupRequest};

/// Concurrency semantics advertised by an engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionConcurrency {
    /// One physical PostgreSQL session. Calls may be concurrent at the Rust
    /// handle level but are serialized by the owner executor.
    SerializedSingleSession,
    /// Multiple independent PostgreSQL client sessions.
    IndependentSessions,
}

/// Capabilities exposed by an opened engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
    /// Engine mode.
    pub mode: EngineMode,
    /// Session concurrency semantics.
    pub session_concurrency: SessionConcurrency,
    /// True if the engine is isolated in a helper/server process.
    pub process_isolated: bool,
    /// True if this engine can own multiple database roots.
    pub multi_root: bool,
    /// Maximum independent client sessions.
    pub max_client_sessions: usize,
    /// Raw protocol execution.
    pub protocol_raw: bool,
    /// Streaming protocol responses.
    pub protocol_stream: bool,
    /// Extension packs.
    pub extension_packs: bool,
    /// PostgreSQL-compatible connection strings.
    pub connection_strings: bool,
}

impl EngineCapabilities {
    /// Canonical capabilities for a mode before runtime-specific refinements.
    pub fn for_mode(mode: EngineMode) -> Self {
        match mode {
            EngineMode::NativeDirect => Self {
                mode,
                session_concurrency: SessionConcurrency::SerializedSingleSession,
                process_isolated: false,
                multi_root: false,
                max_client_sessions: 1,
                protocol_raw: true,
                protocol_stream: true,
                extension_packs: true,
                connection_strings: false,
            },
            EngineMode::NativeBroker => Self {
                mode,
                session_concurrency: SessionConcurrency::SerializedSingleSession,
                process_isolated: true,
                multi_root: true,
                max_client_sessions: 1,
                protocol_raw: true,
                protocol_stream: true,
                extension_packs: true,
                connection_strings: false,
            },
            EngineMode::NativeServer => Self {
                mode,
                session_concurrency: SessionConcurrency::IndependentSessions,
                process_isolated: true,
                multi_root: false,
                max_client_sessions: 32,
                protocol_raw: true,
                protocol_stream: true,
                extension_packs: true,
                connection_strings: true,
            },
        }
    }
}

/// Concrete native runtime provider.
pub trait NativeRuntime: Send + Sync + 'static {
    /// Open an engine session for the validated config.
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>>;
}

/// Opened engine session owned by the SDK executor thread.
pub trait EngineSession: Send + 'static {
    /// Capabilities for this opened session.
    fn capabilities(&self) -> EngineCapabilities;

    /// Execute raw PostgreSQL protocol bytes.
    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse>;

    /// Execute raw PostgreSQL protocol bytes and stream backend bytes.
    fn exec_protocol_stream(
        &mut self,
        request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let response = self.exec_protocol_raw(request)?;
        on_chunk(response.as_bytes())
    }

    /// Force a checkpoint.
    fn checkpoint(&mut self) -> Result<()> {
        Ok(())
    }

    /// Produce a backup artifact.
    fn backup(&mut self, request: BackupRequest) -> Result<BackupArtifact> {
        let _ = request;
        Err(Error::Engine(
            "backup is not implemented by this runtime".into(),
        ))
    }

    /// Close the session.
    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// Default runtime used until a concrete PostgreSQL 18 binding is supplied.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeUnavailable;

impl NativeRuntime for RuntimeUnavailable {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        Err(Error::RuntimeUnavailable { mode: config.mode })
    }
}
