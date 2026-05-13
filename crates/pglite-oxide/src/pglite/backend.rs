#[cfg(feature = "extensions")]
use anyhow::Context;
use anyhow::{Result, bail, ensure};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::pglite::base::InstallOutcome;
use crate::pglite::config::{PostgresConfig, StartupConfig};
use crate::pglite::engine::{EngineCapabilities, EngineKind};
#[cfg(feature = "extensions")]
use crate::pglite::extensions::native_extension_setup_sql;
#[cfg(feature = "extensions")]
use crate::pglite::extensions::{Extension, extension_session_setup_sql, extension_setup_sql};
use crate::pglite::interface::DataTransferContainer;
use crate::pglite::native::NativeLibPgliteSession;
use crate::pglite::postgres_mod::{
    PostgresMod, ProtocolPumpOutcome, ProtocolStream, StartupProtocolResponse,
};
use crate::pglite::timing;
use crate::pglite::transport::Transport;
use crate::pglite::wire::raw_protocol_message_len;
#[cfg(feature = "extensions")]
use crate::pglite::wire::{response_contains_error, simple_query_message};

static WASIX_BACKEND_OPEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendOpenKind {
    Direct,
    Proxy,
}

pub(crate) enum BackendSession {
    Wasix(Box<WasixBackendSession>),
    Native(Box<NativeLibPgliteSession>),
}

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
                BackendOpenKind::Direct => "pglite.postgres_new",
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
                BackendOpenKind::Direct => "pglite.ensure_cluster",
                BackendOpenKind::Proxy => "proxy.backend_ensure_cluster",
            });
            pg.ensure_cluster()?;
        }
        let transport = {
            let _phase = timing::phase(match kind {
                BackendOpenKind::Direct => "pglite.transport_prepare",
                BackendOpenKind::Proxy => "proxy.transport_prepare",
            });
            Transport::prepare(&mut pg)?
        };
        Ok((pg, transport))
    }

    pub(crate) fn paths(&self) -> &crate::pglite::base::PglitePaths {
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
                    bail!(
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
        engine: EngineKind,
    ) -> Result<Self> {
        match engine {
            EngineKind::WasixLegacy => {
                WasixBackendSession::open(outcome, postgres_config, startup_config, kind)
                    .map(Box::new)
                    .map(Self::Wasix)
            }
            EngineKind::NativeLibPglite => {
                ensure!(
                    kind == BackendOpenKind::Direct,
                    "native libpglite happy path only supports direct Pglite, not PgliteServer"
                );
                NativeLibPgliteSession::open(outcome, postgres_config, startup_config)
                    .map(Box::new)
                    .map(Self::Native)
            }
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
        WasixBackendSession::open_with_extension_preload(
            outcome,
            postgres_config,
            startup_config,
            kind,
            extensions,
        )
        .map(Box::new)
        .map(Self::Wasix)
    }

    pub(crate) fn capabilities(&self) -> EngineCapabilities {
        match self {
            Self::Wasix(session) => {
                EngineCapabilities::wasix_legacy(session.supports_protocol_pump())
            }
            Self::Native(session) => session.capabilities(),
        }
    }

    pub(crate) fn paths(&self) -> &crate::pglite::base::PglitePaths {
        match self {
            Self::Wasix(session) => session.paths(),
            Self::Native(session) => session.paths(),
        }
    }

    pub(crate) fn pgdata_template_root(&self) -> Option<&std::path::Path> {
        match self {
            Self::Wasix(session) => session.pgdata_template_root(),
            Self::Native(_) => None,
        }
    }

    pub(crate) fn startup_config(&self) -> &StartupConfig {
        match self {
            Self::Wasix(session) => session.startup_config(),
            Self::Native(session) => session.startup_config(),
        }
    }

    #[cfg(debug_assertions)]
    pub(crate) fn guest_bridge_allocation_counts(&self) -> (u64, u64) {
        match self {
            Self::Wasix(session) => session.guest_bridge_allocation_counts(),
            Self::Native(_) => (0, 0),
        }
    }

    pub(crate) fn send_buffered(
        &mut self,
        message: &[u8],
        requested: Option<DataTransferContainer>,
    ) -> Result<Vec<u8>> {
        match self {
            Self::Wasix(session) => session.send_buffered(message, requested),
            Self::Native(session) => {
                if matches!(requested, Some(DataTransferContainer::File)) {
                    bail!("file transport is not implemented for the native libpglite backend");
                }
                session.send_buffered(message)
            }
        }
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
        match self {
            Self::Wasix(session) => {
                let data = session.send_buffered(message, requested)?;
                f(&data)
            }
            Self::Native(session) => {
                ensure!(
                    requested.is_none(),
                    "native libpglite does not support alternate data transfer containers"
                );
                session.with_buffered_response(message, f)
            }
        }
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
        match self {
            Self::Wasix(session) => session.send_framed_raw_stream(message, requested, on_data),
            Self::Native(_) => {
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
        }
    }

    pub(crate) fn startup_with_packet(
        &mut self,
        message: &[u8],
    ) -> Result<StartupProtocolResponse> {
        match self {
            Self::Wasix(session) => session.startup_with_packet(message),
            Self::Native(_) => {
                let _ = message;
                bail!("native libpglite happy path does not support frontend startup packets yet")
            }
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        match self {
            Self::Wasix(session) => session.existing_startup_response(),
            Self::Native(_) => None,
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_extension_module(&mut self, extension: Extension) -> Result<()> {
        match self {
            Self::Wasix(session) => session.preload_extension_module(extension),
            Self::Native(_) => {
                bail!("native libpglite happy path does not support extension preloading yet")
            }
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_installed_extension(&mut self, extension: Extension) -> Result<()> {
        match self {
            Self::Wasix(session) => session.preload_installed_extension(extension),
            Self::Native(_) => {
                bail!("native libpglite happy path does not support extension preloading yet")
            }
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn enable_extensions(&mut self, extensions: &[Extension]) -> Result<()> {
        match self {
            Self::Wasix(session) => session.enable_extensions(extensions),
            Self::Native(_) if extensions.is_empty() => Ok(()),
            Self::Native(session) => {
                for extension in extensions {
                    for sql in native_extension_setup_sql(*extension) {
                        let response = session
                            .send_buffered(&simple_query_message(&sql))
                            .with_context(|| {
                                format!("enable native extension '{}'", extension.sql_name())
                            })?;
                        if response_contains_error(&response) {
                            bail!(
                                "enable native extension '{}' returned a Postgres error",
                                extension.sql_name()
                            );
                        }
                    }
                }
                Ok(())
            }
        }
    }

    pub(crate) fn supports_protocol_pump(&self) -> bool {
        match self {
            Self::Wasix(session) => session.supports_protocol_pump(),
            Self::Native(_) => false,
        }
    }

    pub(crate) fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        match self {
            Self::Wasix(session) => session.attach_protocol_stream(stream),
            Self::Native(_) => {
                bail!("native libpglite happy path does not support protocol stream attachment yet")
            }
        }
    }

    pub(crate) fn send_with_protocol_pump(
        &mut self,
        message: &[u8],
        continuation_prefix: impl FnOnce() -> Vec<u8>,
    ) -> Result<ProtocolPumpOutcome> {
        match self {
            Self::Wasix(session) => session.send_with_protocol_pump(message, continuation_prefix),
            Self::Native(_) => {
                bail!("native libpglite happy path does not support protocol pump yet")
            }
        }
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        match self {
            Self::Wasix(session) => session.shutdown(),
            Self::Native(session) => session.shutdown(),
        }
    }

    pub(crate) fn restart(&mut self) -> Result<()> {
        match self {
            Self::Wasix(session) => session.restart(),
            Self::Native(_) => bail!("native libpglite happy path does not support restart yet"),
        }
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
