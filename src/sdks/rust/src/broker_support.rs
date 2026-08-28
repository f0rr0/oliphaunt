use std::path::PathBuf;
use std::sync::Arc;

use crate::config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, EngineMode, NativeBrokerConfig, NativeServerConfig,
    OpenConfig, PostgresStartupGuc,
};
use crate::engine::{EngineCancel, EngineSession, NativeRuntime, ProtocolStreamOutcome};
use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::liboliphaunt::OliphauntRuntime;
use crate::storage::DatabaseStorage;

/// Narrow process-helper boundary used by the unpublished broker executable.
#[doc(hidden)]
pub struct BrokerSession {
    session: Box<dyn EngineSession>,
}

/// Out-of-band cancellation handle for a broker-owned session.
#[doc(hidden)]
#[derive(Clone)]
pub struct BrokerCancel {
    cancel: Arc<dyn EngineCancel>,
}

/// Version-locked streamed-protocol completion used by the broker helper.
#[doc(hidden)]
pub enum BrokerStreamOutcome {
    /// The direct runtime confirmed ReadyForQuery; the nested result is the
    /// chunk callback outcome.
    ReadyForQuery(Result<()>),
    /// The direct runtime could not confirm ReadyForQuery after an independent
    /// runtime or transport failure.
    SessionStateUnknown(Error),
}

impl BrokerCancel {
    /// Cancel the active PostgreSQL command.
    pub fn cancel(&self) -> Result<()> {
        self.cancel.cancel()
    }
}

/// Open the direct runtime owned by the broker process.
#[doc(hidden)]
pub fn open(
    root: PathBuf,
    startup_gucs: Vec<(String, String)>,
    username: Option<String>,
    database: Option<String>,
    extensions: Vec<Extension>,
) -> Result<BrokerSession> {
    let config = OpenConfig {
        mode: EngineMode::Direct,
        storage: DatabaseStorage::Directory(root),
        broker: NativeBrokerConfig::default(),
        server: NativeServerConfig::default(),
        startup_gucs: startup_gucs
            .into_iter()
            .map(|(name, value)| PostgresStartupGuc::new(name, value))
            .collect(),
        username: username.unwrap_or_else(|| DEFAULT_USERNAME.to_owned()),
        database: database.unwrap_or_else(|| DEFAULT_DATABASE.to_owned()),
        extensions,
    };
    config.validate()?;
    Ok(BrokerSession {
        session: OliphauntRuntime::from_env().open(config)?,
    })
}

impl BrokerSession {
    /// Obtain an out-of-band cancellation handle.
    pub fn cancel_handle(&self) -> Result<BrokerCancel> {
        self.session
            .cancel_handle()
            .map(|cancel| BrokerCancel { cancel })
            .ok_or_else(|| {
                Error::Engine("native broker session does not support cancellation".into())
            })
    }

    /// Execute raw PostgreSQL protocol bytes.
    pub fn exec_protocol_raw(&mut self, bytes: Vec<u8>) -> Result<Vec<u8>> {
        self.session
            .exec_protocol_raw(bytes.into())
            .map(|response| response.into_bytes())
    }

    /// Execute raw PostgreSQL protocol bytes and forward native response chunks.
    pub fn exec_protocol_raw_stream(
        &mut self,
        bytes: Vec<u8>,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> BrokerStreamOutcome {
        match self.session.exec_protocol_raw_stream(bytes.into(), on_chunk) {
            ProtocolStreamOutcome::ReadyForQuery(result) => {
                BrokerStreamOutcome::ReadyForQuery(result)
            }
            ProtocolStreamOutcome::SessionStateUnknown(error) => {
                BrokerStreamOutcome::SessionStateUnknown(error)
            }
        }
    }

    /// Execute a PostgreSQL simple query.
    pub fn execute(&mut self, sql: &str) -> Result<Vec<u8>> {
        self.session
            .exec_simple_query(sql)
            .map(|response| response.into_bytes())
    }

    /// Create a physical backup.
    pub fn backup(&mut self) -> Result<Vec<u8>> {
        self.session.backup()
    }

    /// Close the broker-owned session.
    pub fn close(&mut self) -> Result<()> {
        self.session.close()
    }
}

/// Restore physical backup bytes into an absent destination.
#[doc(hidden)]
pub fn restore(destination: PathBuf, bytes: Vec<u8>) -> Result<()> {
    OliphauntRuntime::from_env().restore(&destination, &bytes)
}
