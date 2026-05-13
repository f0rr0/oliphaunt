use std::path::PathBuf;

use crate::config::{EngineMode, OpenConfig};
use crate::engine::{EngineSession, NativeRuntime};
use crate::error::{Error, Result};

/// Native server runtime scaffold.
///
/// Server mode is the only mode that may advertise true independent
/// PostgreSQL client sessions. It is not implemented by direct-mode
/// multiplexing.
#[derive(Debug, Clone, Default)]
pub struct NativeServerRuntime {
    executable: Option<PathBuf>,
}

impl NativeServerRuntime {
    /// Create a server runtime that resolves the server executable from package
    /// assets.
    pub fn from_package() -> Self {
        Self { executable: None }
    }

    /// Create a server runtime with an explicit executable.
    pub fn from_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
        }
    }

    /// Return the configured executable, if any.
    pub fn executable(&self) -> Option<&PathBuf> {
        self.executable.as_ref()
    }
}

impl NativeRuntime for NativeServerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeServer {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "NativeServerRuntime only serves native-server mode".to_owned(),
            });
        }
        Err(Error::RuntimeUnavailable {
            mode: EngineMode::NativeServer,
        })
    }
}
