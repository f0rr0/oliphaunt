use std::error;
use std::fmt;

/// Result alias used by the native SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Error type for SDK configuration, lifecycle, and engine execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A database root was required but not configured.
    MissingDatabaseRoot,
    /// The selected engine mode cannot provide the requested client sessions.
    UnsupportedClientSessions {
        /// Engine mode that rejected the request.
        mode: crate::EngineMode,
        /// Requested client sessions.
        requested: usize,
        /// Maximum supported client sessions.
        supported: usize,
    },
    /// No concrete native runtime has been linked into the builder.
    RuntimeUnavailable {
        /// Engine mode the caller attempted to open.
        mode: crate::EngineMode,
    },
    /// The selected runtime does not implement the selected engine mode.
    UnsupportedEngineMode {
        /// Engine mode the caller attempted to open.
        mode: crate::EngineMode,
        /// Reason this runtime cannot serve the mode.
        reason: String,
    },
    /// The owner executor has stopped.
    EngineStopped,
    /// A runtime returned an execution failure.
    Engine(String),
    /// A session pin is already active, so unpinned work would violate session
    /// isolation.
    SessionPinned,
    /// A session pin token no longer owns the physical session.
    InvalidSessionPin,
    /// A configuration value was invalid.
    InvalidConfig(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingDatabaseRoot => {
                f.write_str("database root is not configured; call path or temporary")
            }
            Self::UnsupportedClientSessions {
                mode,
                requested,
                supported,
            } => write!(
                f,
                "{mode} supports at most {supported} client session(s), requested {requested}"
            ),
            Self::RuntimeUnavailable { mode } => write!(
                f,
                "no native runtime is linked for {mode}; provide a NativeRuntime implementation"
            ),
            Self::UnsupportedEngineMode { mode, reason } => {
                write!(f, "{mode} is not supported by this runtime: {reason}")
            }
            Self::EngineStopped => f.write_str("native engine executor has stopped"),
            Self::Engine(message) => f.write_str(message),
            Self::SessionPinned => {
                f.write_str("physical session is pinned; use the active SessionPin")
            }
            Self::InvalidSessionPin => {
                f.write_str("session pin is not active for this physical session")
            }
            Self::InvalidConfig(message) => f.write_str(message),
        }
    }
}

impl error::Error for Error {}
