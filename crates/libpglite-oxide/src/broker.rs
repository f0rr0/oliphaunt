use std::path::PathBuf;

use crate::config::{EngineMode, OpenConfig};
use crate::engine::{EngineSession, NativeRuntime};
use crate::error::{Error, Result};

/// Broker runtime scaffold.
///
/// Broker mode is intentionally separate from direct mode. A complete broker
/// implementation will own helper-process startup, root ownership, worker
/// supervision, crash recovery, and local IPC.
#[derive(Debug, Clone, Default)]
pub struct NativeBrokerRuntime {
    executable: Option<PathBuf>,
}

impl NativeBrokerRuntime {
    /// Create a broker runtime that resolves the broker executable from package
    /// assets.
    pub fn from_package() -> Self {
        Self { executable: None }
    }

    /// Create a broker runtime with an explicit helper executable.
    pub fn from_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
        }
    }

    /// Return the configured helper executable, if any.
    pub fn executable(&self) -> Option<&PathBuf> {
        self.executable.as_ref()
    }
}

impl NativeRuntime for NativeBrokerRuntime {
    fn open(&self, config: OpenConfig) -> Result<Box<dyn EngineSession>> {
        if config.mode != EngineMode::NativeBroker {
            return Err(Error::UnsupportedEngineMode {
                mode: config.mode,
                reason: "NativeBrokerRuntime only serves native-broker mode".to_owned(),
            });
        }
        Err(Error::RuntimeUnavailable {
            mode: EngineMode::NativeBroker,
        })
    }
}
