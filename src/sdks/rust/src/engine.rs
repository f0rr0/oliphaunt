use crate::config::{EngineMode, OpenConfig};
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{BackupArtifact, BackupFormat, BackupRequest};
use std::sync::Arc;

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
    /// True if this engine/runtime can own multiple database roots.
    pub multi_root: bool,
    /// True if the same host process can close this session and later open a
    /// root again through the same mode.
    pub reopenable: bool,
    /// True when `close` is a logical detach from a resident backend and the
    /// same root can be reopened in this process without reinitializing the
    /// physical backend.
    pub same_root_logical_reopen: bool,
    /// True when this mode can open a different root in the same application
    /// process after closing the current session.
    pub root_switchable: bool,
    /// True when this mode can recover the opened handle after its managed
    /// PostgreSQL process exits unexpectedly.
    pub crash_restartable: bool,
    /// Maximum independent client sessions.
    pub max_client_sessions: usize,
    /// Raw protocol execution.
    pub protocol_raw: bool,
    /// Streaming protocol responses.
    pub protocol_stream: bool,
    /// Out-of-band query cancellation.
    pub query_cancel: bool,
    /// Physical/logical backup and restore APIs.
    pub backup_restore: bool,
    /// Backup formats this mode can produce.
    pub backup_formats: Vec<BackupFormat>,
    /// Backup formats this SDK can restore for this mode family.
    pub restore_formats: Vec<BackupFormat>,
    /// PostgreSQL simple-query execution.
    pub simple_query: bool,
    /// Opt-in PostgreSQL extensions.
    pub extensions: bool,
    /// PostgreSQL-compatible connection strings.
    pub connection_strings: bool,
    /// Connection string for server-style clients when this opened session
    /// exposes one.
    pub connection_string: Option<String>,
}

/// SDK-level support status for one engine mode.
///
/// This is separate from opened-session capabilities: it tells an application
/// whether the SDK can create a runtime for a mode before calling `open`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineModeSupport {
    /// Engine mode.
    pub mode: EngineMode,
    /// True when the SDK surface can open this mode.
    pub available: bool,
    /// Canonical PostgreSQL/session semantics for the mode.
    pub capabilities: EngineCapabilities,
    /// Product reason when `available` is false.
    pub unavailable_reason: Option<&'static str>,
}

impl EngineModeSupport {
    /// Available support entry for a native mode.
    pub fn available(mode: EngineMode) -> Self {
        Self {
            mode,
            available: true,
            capabilities: EngineCapabilities::for_mode(mode),
            unavailable_reason: None,
        }
    }

    /// Unavailable support entry for a native mode.
    pub fn unavailable(mode: EngineMode, reason: &'static str) -> Self {
        Self {
            mode,
            available: false,
            capabilities: EngineCapabilities::for_mode(mode),
            unavailable_reason: Some(reason),
        }
    }
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
                reopenable: true,
                same_root_logical_reopen: true,
                root_switchable: false,
                crash_restartable: false,
                max_client_sessions: 1,
                protocol_raw: true,
                protocol_stream: true,
                query_cancel: true,
                backup_restore: true,
                backup_formats: vec![BackupFormat::PhysicalArchive],
                restore_formats: vec![BackupFormat::PhysicalArchive],
                simple_query: true,
                extensions: true,
                connection_strings: false,
                connection_string: None,
            },
            EngineMode::NativeBroker => Self {
                mode,
                session_concurrency: SessionConcurrency::SerializedSingleSession,
                process_isolated: true,
                multi_root: true,
                reopenable: true,
                same_root_logical_reopen: false,
                root_switchable: true,
                crash_restartable: true,
                max_client_sessions: 1,
                protocol_raw: true,
                protocol_stream: true,
                query_cancel: true,
                backup_restore: true,
                backup_formats: vec![BackupFormat::PhysicalArchive],
                restore_formats: vec![BackupFormat::PhysicalArchive],
                simple_query: true,
                extensions: true,
                connection_strings: false,
                connection_string: None,
            },
            EngineMode::NativeServer => Self {
                mode,
                session_concurrency: SessionConcurrency::IndependentSessions,
                process_isolated: true,
                multi_root: false,
                reopenable: true,
                same_root_logical_reopen: false,
                root_switchable: true,
                crash_restartable: false,
                max_client_sessions: 32,
                protocol_raw: true,
                protocol_stream: true,
                query_cancel: true,
                backup_restore: true,
                backup_formats: vec![BackupFormat::Sql, BackupFormat::PhysicalArchive],
                restore_formats: vec![BackupFormat::PhysicalArchive],
                simple_query: true,
                extensions: true,
                connection_strings: true,
                connection_string: None,
            },
        }
    }

    /// True when this engine can produce the requested backup format.
    pub fn supports_backup_format(&self, format: BackupFormat) -> bool {
        self.backup_restore && self.backup_formats.contains(&format)
    }

    /// True when this engine can restore the requested backup artifact format.
    pub fn supports_restore_format(&self, format: BackupFormat) -> bool {
        self.backup_restore && self.restore_formats.contains(&format)
    }

    /// Rust SDK mode support. The Rust SDK owns all three native modes; runtime
    /// opening can still fail if the configured helper binaries or native
    /// PostgreSQL package are missing.
    pub fn rust_sdk_support() -> [EngineModeSupport; 3] {
        EngineMode::all().map(EngineModeSupport::available)
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

    /// PostgreSQL connection string exposed by server-capable modes.
    fn connection_string(&self) -> Option<String> {
        self.capabilities().connection_string
    }

    /// Out-of-band cancellation handle for the current backend query.
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        None
    }

    /// Execute raw PostgreSQL protocol bytes.
    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse>;

    /// Execute SQL through PostgreSQL's simple-query protocol.
    fn exec_simple_query(&mut self, sql: &str) -> Result<ProtocolResponse> {
        self.exec_protocol_raw(ProtocolRequest::simple_query(sql)?)
    }

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
            "backup is not supported by this runtime".into(),
        ))
    }

    /// Close the session.
    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// Out-of-band query cancellation for engines that can interrupt the active
/// backend without waiting for the serialized owner executor.
pub trait EngineCancel: Send + Sync + 'static {
    /// Request cancellation of the currently active backend query.
    fn cancel(&self) -> Result<()>;
}

/// Default runtime used until a concrete PostgreSQL 18 binding is supplied.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeUnavailable;

impl NativeRuntime for RuntimeUnavailable {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        Err(Error::RuntimeUnavailable { mode: config.mode })
    }
}
