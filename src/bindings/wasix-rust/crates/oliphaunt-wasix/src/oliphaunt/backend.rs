#[cfg(feature = "extensions")]
use anyhow::Context;
use anyhow::{Result, ensure};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::oliphaunt::base::InstallOutcome;
use crate::oliphaunt::config::{PostgresConfig, StartupConfig};
use crate::oliphaunt::engine::EngineCapabilities;
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::{Extension, extension_session_setup_sql, extension_setup_sql};
use crate::oliphaunt::interface::DataTransferContainer;
use crate::oliphaunt::postgres_mod::{
    PostgresMod, ProtocolPumpOutcome, ProtocolStream, StartupProtocolResponse,
};
use crate::oliphaunt::timing;
use crate::oliphaunt::transport::Transport;
use crate::oliphaunt::wire::raw_protocol_message_len;
#[cfg(feature = "extensions")]
use crate::oliphaunt::wire::{response_contains_error, simple_query_message};

static WASIX_BACKEND_OPEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendOpenKind {
    Direct,
    Proxy,
}

pub(crate) struct BackendSession(Box<WasixBackendSession>);

pub(crate) struct WasixBackendSession {
    pg: PostgresMod,
    transport: Transport,
    outcome: InstallOutcome,
    postgres_config: PostgresConfig,
    startup_config: StartupConfig,
    kind: BackendOpenKind,
    #[cfg(feature = "extensions")]
    preinstalled_extensions: Vec<String>,
    #[cfg(feature = "extensions")]
    preloaded_extensions: Vec<Extension>,
}

impl WasixBackendSession {
    pub(crate) fn open(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
    ) -> Result<Self> {
        #[cfg(feature = "extensions")]
        {
            Self::open_with_extension_preload(outcome, postgres_config, startup_config, kind, &[])
        }
        #[cfg(not(feature = "extensions"))]
        {
            Self::open_without_extension_preload(outcome, postgres_config, startup_config, kind)
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn open_with_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
        extensions: &[Extension],
    ) -> Result<Self> {
        Self::open_inner(outcome, postgres_config, startup_config, kind, extensions)
    }

    #[cfg(not(feature = "extensions"))]
    fn open_without_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
    ) -> Result<Self> {
        Self::open_inner(outcome, postgres_config, startup_config, kind)
    }

    #[cfg(feature = "extensions")]
    fn open_inner(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
        extensions: &[Extension],
    ) -> Result<Self> {
        let _open_guard = wasix_backend_open_guard();
        let preinstalled_extensions = outcome.preinstalled_extensions.clone();
        let pg = Self::new_postgres(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
            kind,
        )?;
        for extension in extensions {
            pg.preload_extension_module(*extension)?;
        }
        let (pg, transport) = Self::finish_open(pg, kind)?;
        Ok(Self {
            pg,
            transport,
            outcome,
            postgres_config,
            startup_config,
            kind,
            preinstalled_extensions,
            preloaded_extensions: extensions.to_vec(),
        })
    }

    #[cfg(not(feature = "extensions"))]
    fn open_inner(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
    ) -> Result<Self> {
        let _open_guard = wasix_backend_open_guard();
        let pg = Self::new_postgres(
            outcome.clone(),
            postgres_config.clone(),
            startup_config.clone(),
            kind,
        )?;
        let (pg, transport) = Self::finish_open(pg, kind)?;
        Ok(Self {
            pg,
            transport,
            outcome,
            postgres_config,
            startup_config,
            kind,
        })
    }

    fn new_postgres(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
    ) -> Result<PostgresMod> {
        let pg = {
            let _phase = timing::phase(match kind {
                BackendOpenKind::Direct => "oliphaunt.postgres_new",
                BackendOpenKind::Proxy => "proxy.backend_postgres_new",
            });
            PostgresMod::new_prepared_with_config(
                outcome.paths,
                outcome.runtime_layout,
                postgres_config,
                startup_config,
            )?
        };
        Ok(pg)
    }

    fn finish_open(mut pg: PostgresMod, kind: BackendOpenKind) -> Result<(PostgresMod, Transport)> {
        {
            let _phase = timing::phase(match kind {
                BackendOpenKind::Direct => "oliphaunt.ensure_cluster",
                BackendOpenKind::Proxy => "proxy.backend_ensure_cluster",
            });
            pg.ensure_cluster()?;
        }
        let transport = {
            let _phase = timing::phase(match kind {
                BackendOpenKind::Direct => "oliphaunt.transport_prepare",
                BackendOpenKind::Proxy => "proxy.transport_prepare",
            });
            Transport::prepare(&mut pg)?
        };
        Ok((pg, transport))
    }

    pub(crate) fn paths(&self) -> &crate::oliphaunt::base::OliphauntPaths {
        self.pg.paths()
    }

    pub(crate) fn pgdata_template_root(&self) -> Option<&std::path::Path> {
        self.pg.pgdata_template_root()
    }

    pub(crate) fn startup_config(&self) -> &StartupConfig {
        &self.startup_config
    }

    #[cfg(debug_assertions)]
    pub(crate) fn guest_bridge_allocation_counts(&self) -> (u64, u64) {
        self.pg.guest_bridge_allocation_counts()
    }

    pub(crate) fn send_buffered(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
    ) -> Result<Vec<u8>> {
        self.transport.send(&mut self.pg, message, requested)
    }

    pub(crate) fn send_framed_raw_stream<F>(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
        mut on_data: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        let mut cursor = 0usize;
        while cursor < message.len() {
            let frame_len = raw_protocol_message_len(&message[cursor..])?;
            let end = cursor + frame_len;
            let data = self.send_buffered(&message[cursor..end], requested)?;
            if !data.is_empty() {
                on_data(&data)?;
            }
            cursor = end;
        }
        Ok(())
    }

    pub(crate) fn startup_with_packet(
        &mut self,
        message: &[u8],
    ) -> Result<StartupProtocolResponse> {
        self.pg.start_protocol_with_startup_packet(message)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.pg.existing_startup_response()
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_extension_module(&mut self, extension: Extension) -> Result<()> {
        self.pg.preload_extension_module(extension)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_installed_extension(&mut self, extension: Extension) -> Result<()> {
        self.preload_extension_module(extension)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn enable_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        for extension in extensions {
            let setup_sql = if self.has_preinstalled_extension(*extension) {
                self.preload_installed_extension(*extension)?;
                extension_session_setup_sql(*extension)
            } else {
                extension_setup_sql(*extension)
            };
            for sql in setup_sql {
                let response = self
                    .send_buffered(&simple_query_message(&sql), None)
                    .with_context(|| {
                        format!("enable bundled extension '{}'", extension.sql_name())
                    })?;
                if response_contains_error(&response) {
                    anyhow::bail!(
                        "enable bundled extension '{}' returned a Postgres error",
                        extension.sql_name()
                    );
                }
            }
        }
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn has_preinstalled_extension(&self, extension: Extension) -> bool {
        self.preinstalled_extensions
            .iter()
            .any(|sql_name| sql_name == extension.sql_name())
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
        continuation_prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        ensure!(
            self.supports_protocol_pump(),
            "WASIX runtime is missing backend-owned protocol pump exports"
        );
        self.pg.send_protocol_pump(message, continuation_prefix)
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.pg.shutdown_backend()
    }

    pub(crate) fn restart(&mut self) -> Result<()> {
        let _open_guard = wasix_backend_open_guard();
        let pg = Self::new_postgres(
            self.outcome.clone(),
            self.postgres_config.clone(),
            self.startup_config.clone(),
            self.kind,
        )?;
        #[cfg(feature = "extensions")]
        for extension in &self.preloaded_extensions {
            pg.preload_extension_module(*extension)?;
        }
        let (pg, transport) = Self::finish_open(pg, self.kind)?;
        self.pg = pg;
        self.transport = transport;
        Ok(())
    }
}

impl BackendSession {
    pub(crate) fn open(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
    ) -> Result<Self> {
        WasixBackendSession::open(outcome, postgres_config, startup_config, kind)
            .map(Box::new)
            .map(Self)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn open_with_extension_preload(
        outcome: InstallOutcome,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
        kind: BackendOpenKind,
        extensions: &[Extension],
    ) -> Result<Self> {
        WasixBackendSession::open_with_extension_preload(
            outcome,
            postgres_config,
            startup_config,
            kind,
            extensions,
        )
        .map(Box::new)
        .map(Self)
    }

    pub(crate) fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::wasix_legacy(self.0.supports_protocol_pump())
    }

    pub(crate) fn paths(&self) -> &crate::oliphaunt::base::OliphauntPaths {
        self.0.paths()
    }

    pub(crate) fn pgdata_template_root(&self) -> Option<&std::path::Path> {
        self.0.pgdata_template_root()
    }

    pub(crate) fn startup_config(&self) -> &StartupConfig {
        self.0.startup_config()
    }

    #[cfg(debug_assertions)]
    pub(crate) fn guest_bridge_allocation_counts(&self) -> (u64, u64) {
        self.0.guest_bridge_allocation_counts()
    }

    pub(crate) fn send_buffered(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
    ) -> Result<Vec<u8>> {
        self.0.send_buffered(message, requested)
    }

    pub(crate) fn with_buffered<F, T>(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
        f: F,
    ) -> Result<T>
    where
        F: FnOnce(&[u8]) -> Result<T>,
    {
        let data = self.0.send_buffered(message, requested)?;
        f(&data)
    }

    pub(crate) fn send_framed_raw_stream<F>(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
        on_data: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        self.0.send_framed_raw_stream(message, requested, on_data)
    }

    pub(crate) fn startup_with_packet(
        &mut self,
        message: &[u8],
    ) -> Result<StartupProtocolResponse> {
        self.0.startup_with_packet(message)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.0.existing_startup_response()
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_extension_module(&mut self, extension: Extension) -> Result<()> {
        self.0.preload_extension_module(extension)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_installed_extension(&mut self, extension: Extension) -> Result<()> {
        self.0.preload_installed_extension(extension)
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn enable_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        self.0.enable_extensions(extensions)
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
        continuation_prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        self.0.send_with_protocol_pump(message, continuation_prefix)
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.0.shutdown()
    }

    pub(crate) fn restart(&mut self) -> Result<()> {
        self.0.restart()
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
