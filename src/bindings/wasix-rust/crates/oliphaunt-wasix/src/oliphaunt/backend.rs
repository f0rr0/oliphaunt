use anyhow::{Result, ensure};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::oliphaunt::base::InstallOutcome;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::postgres_mod::{
    PostgresMod, ProtocolPumpOutcome, ProtocolPumpScope, ProtocolStream, StartupProtocolResponse,
};
use crate::oliphaunt::transport::Transport;

static WASIX_BACKEND_OPEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) struct BackendSession(Box<WasixBackendSession>);

pub(crate) struct WasixBackendSession {
    pg: PostgresMod,
    transport: Transport,
    outcome: InstallOutcome,
}

impl WasixBackendSession {
    pub(crate) fn open(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        #[cfg(feature = "extensions")]
        {
            Self::open_with_extension_preload(outcome, postgres_config, startup_config, &[])
        }
        #[cfg(not(feature = "extensions"))]
        {
            Self::open_without_extension_preload(outcome, postgres_config, startup_config)
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn open_with_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        Self::open_inner(outcome, postgres_config, startup_config, extensions)
    }

    #[cfg(not(feature = "extensions"))]
    fn open_without_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        Self::open_inner(outcome, postgres_config, startup_config)
    }

    #[cfg(feature = "extensions")]
    fn open_inner(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        let _open_guard = wasix_backend_open_guard();
        let pg = Self::new_postgres(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
        )?;
        for extension in extensions {
            pg.preload_extension_module(*extension)?;
        }
        let (pg, transport) = Self::finish_open(pg)?;
        Ok(Self {
            pg,
            transport,
            outcome,
        })
    }

    #[cfg(not(feature = "extensions"))]
    fn open_inner(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        let _open_guard = wasix_backend_open_guard();
        let pg = Self::new_postgres(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
        )?;
        let (pg, transport) = Self::finish_open(pg)?;
        Ok(Self {
            pg,
            transport,
            outcome,
        })
    }

    fn new_postgres(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<PostgresMod> {
        let pg = PostgresMod::new_prepared_with_config(
            outcome.runtime_layout,
            outcome.pgdata_storage,
            postgres_config,
            startup_config,
        )?;
        Ok(pg)
    }

    fn finish_open(mut pg: PostgresMod) -> Result<(PostgresMod, Transport)> {
        pg.ensure_cluster()?;
        let transport = Transport::prepare(&mut pg)?;
        Ok((pg, transport))
    }

    #[cfg(all(feature = "extensions", test))]
    pub(crate) fn runtime_storage(&self) -> &crate::oliphaunt::storage::StorageRoot {
        &self.outcome.runtime_layout.mutable_root
    }

    pub(crate) fn pgdata_storage(&self) -> &crate::oliphaunt::storage::PgDataStorage {
        &self.outcome.pgdata_storage
    }

    pub(crate) fn send_buffered(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        self.transport.send(&mut self.pg, message)
    }

    pub(crate) fn startup_with_packet(
        &mut self,
        message: &[u8],
    ) -> Result<StartupProtocolResponse> {
        self.pg.start_protocol_with_startup_packet(message)
    }

    #[cfg(feature = "tools")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.pg.existing_startup_response()
    }

    #[cfg(feature = "tools")]
    pub(crate) fn startup_config(&self) -> &StartupConfig {
        self.pg.startup_config()
    }

    pub(crate) fn supports_protocol_pump(&self) -> bool {
        self.pg.supports_streaming_protocol()
    }

    pub(crate) fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        self.pg.attach_protocol_stream(stream)
    }

    pub(crate) fn send_with_protocol_pump(
        &mut self,
        message: &[u8],
    ) -> Result<ProtocolPumpOutcome> {
        ensure!(
            self.supports_protocol_pump(),
            "WASIX runtime is missing backend-owned protocol pump exports"
        );
        self.pg
            .send_protocol_pump(message, Vec::new, ProtocolPumpScope::Copy)
    }

    pub(crate) fn send_with_connection_protocol_pump(
        &mut self,
        message: &[u8],
        continuation_prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        ensure!(
            self.supports_protocol_pump(),
            "WASIX runtime is missing backend-owned protocol pump exports"
        );
        self.pg
            .send_protocol_pump(message, continuation_prefix, ProtocolPumpScope::Connection)
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.pg.shutdown_backend()
    }
}

impl BackendSession {
    pub(crate) fn open(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        WasixBackendSession::open(outcome, postgres_config, startup_config)
            .map(Box::new)
            .map(Self)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn open_with_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        extensions: &[Extension],
    ) -> Result<Self> {
        WasixBackendSession::open_with_extension_preload(
            outcome,
            postgres_config,
            startup_config,
            extensions,
        )
        .map(Box::new)
        .map(Self)
    }

    #[cfg(all(feature = "extensions", test))]
    pub(crate) fn runtime_storage(&self) -> &crate::oliphaunt::storage::StorageRoot {
        self.0.runtime_storage()
    }

    pub(crate) fn pgdata_storage(&self) -> &crate::oliphaunt::storage::PgDataStorage {
        self.0.pgdata_storage()
    }

    pub(crate) fn send_buffered(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        self.0.send_buffered(message)
    }

    pub(crate) fn startup_with_packet(
        &mut self,
        message: &[u8],
    ) -> Result<StartupProtocolResponse> {
        self.0.startup_with_packet(message)
    }

    #[cfg(feature = "tools")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.0.existing_startup_response()
    }

    #[cfg(feature = "tools")]
    pub(crate) fn startup_config(&self) -> &StartupConfig {
        self.0.startup_config()
    }

    pub(crate) fn supports_protocol_pump(&self) -> bool {
        self.0.supports_protocol_pump()
    }

    pub(crate) fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        self.0.attach_protocol_stream(stream)
    }

    pub(crate) fn send_with_protocol_pump(
        &mut self,
        message: &[u8],
    ) -> Result<ProtocolPumpOutcome> {
        self.0.send_with_protocol_pump(message)
    }

    pub(crate) fn send_with_connection_protocol_pump(
        &mut self,
        message: &[u8],
        continuation_prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        self.0
            .send_with_connection_protocol_pump(message, continuation_prefix)
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.0.shutdown()
    }
}

fn wasix_backend_open_guard() -> MutexGuard<'static, ()> {
    // Wasmer/WASIX backend startup uses process-wide runtime and module-cache
    // state. Serialize creation and `_start`; already-open backends still run
    // independently after startup.
    WASIX_BACKEND_OPEN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("WASIX backend open lock poisoned")
}
