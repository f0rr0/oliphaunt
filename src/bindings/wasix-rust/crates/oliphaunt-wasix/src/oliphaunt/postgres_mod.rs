use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use tokio::runtime::Runtime as TokioRuntime;
use tracing::{debug, warn};
use wasmer::{Engine, Instance, Module, Store, TypedFunction, WasmTypeList};
use wasmer_config::package::{PackageHash, PackageId};
use wasmer_types::ModuleHash;
use wasmer_wasix::bin_factory::{BinaryPackage, BinaryPackageCommand, spawn_exec};
use wasmer_wasix::fs::WasiFsRoot;
use wasmer_wasix::runners::wasi::{PackageOrHash, RuntimeOrEngine, WasiRunner};
use wasmer_wasix::runtime::module_cache::ModuleCache;
use wasmer_wasix::runtime::module_cache::SharedCache;
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
use wasmer_wasix::runtime::task_manager::{VirtualTaskManager, VirtualTaskManagerExt};
use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
use wasmer_wasix::virtual_fs::null_file::NullFile;
use wasmer_wasix::{WasiError, WasiFunctionEnv, virtual_fs};
use webc::metadata::Command as WebcCommand;
use webc::metadata::annotations::{WASI_RUNNER_URI, Wasi};

use super::aot;
use super::base::{RuntimeLayout, virtual_cluster_is_complete};
use super::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use super::extensions::Extension;
use super::storage::{PgDataStorage, StorageRoot};

mod stdio;
mod task_policy;
mod wasix_fs;

pub(crate) use stdio::ProtocolStream;
use stdio::{ProtocolStdioAttachment, ProtocolStdioFile, TailCaptureFile, TailCaptureHandle};
use task_policy::{GuestWasmTasks, constrain_single_backend_tasks};
use wasix_fs::{host_filesystem, wasi_root_with_devices};

const POSTGRES_EXE_PATH: &str = "/bin/postgres";
const PGDATA_DIR: &str = "/base";
const ICU_DATA_DIR: &str = "/share/icu";
const SKIP_ICU_COLLATION_DISCOVERY_ENV: &str = "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";
const WASM_PREFIX: &str = "/";
const RUNTIME_SIDE_MODULES: &[(&str, &str)] = &[
    ("plpgsql.so", "runtime-support:plpgsql"),
    ("dict_snowball.so", "runtime-support:dict_snowball"),
];
const OLIPHAUNT_EXIT_ALIVE: i32 = 99;
const POSTGRES_MAIN_LONGJMP: i32 = 100;

static WASIX_PROCESS_RUNTIME: OnceLock<std::result::Result<Arc<WasixProcessRuntime>, String>> =
    OnceLock::new();
static SEEDED_SIDE_MODULES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct WasixProcessRuntime {
    tokio_runtime: Arc<TokioRuntime>,
    wasix_module_cache: Arc<SharedCache>,
    wasix_runtime: Arc<dyn Runtime + Send + Sync>,
}

pub struct PostgresMod {
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    engine: Engine,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    tokio_runtime: Arc<TokioRuntime>,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    wasix_module_cache: Arc<SharedCache>,
    _wasix_runtime: Arc<dyn Runtime + Send + Sync>,
    store: Store,
    _instance: Instance,
    env: WasiFunctionEnv,
    io: WasixOliphauntIo,
    lifecycle: OliphauntLifecycleExports,
    protocol: WasixProtocolExports,
    protocol_stdio: Option<WasixProtocolStdioExports>,
    protocol_stdio_file: ProtocolStdioFile,
    wasi_stderr: TailCaptureHandle,
    protocol_stdio_attachment: Option<ProtocolStdioAttachment>,
    #[cfg(feature = "extensions")]
    runtime_storage: StorageRoot,
    pgdata_storage: PgDataStorage,
    startup_config: StartupConfig,
    startup_response: Option<Vec<u8>>,
    cluster_ready: bool,
    backend_started: bool,
    started: bool,
}

pub(crate) struct StartupProtocolResponse {
    pub(crate) output: Vec<u8>,
    pub(crate) accepted: bool,
}

#[derive(Debug)]
pub(crate) struct StartupErrorResponse {
    output: Vec<u8>,
    summary: String,
}

impl StartupErrorResponse {
    fn new(output: Vec<u8>) -> Self {
        let summary = summarize_protocol(&output);
        Self { output, summary }
    }

    pub(crate) fn output(&self) -> &[u8] {
        &self.output
    }
}

impl fmt::Display for StartupErrorResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Postgres startup returned a protocol ErrorResponse: {}",
            self.summary
        )
    }
}

impl std::error::Error for StartupErrorResponse {}

pub(crate) fn startup_error_response_output(err: &anyhow::Error) -> Option<&[u8]> {
    err.downcast_ref::<StartupErrorResponse>()
        .map(StartupErrorResponse::output)
}

#[derive(Debug)]
pub(crate) enum ProtocolPumpOutcome {
    Buffered(Vec<u8>),
    Streamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProtocolPumpScope {
    /// Return after PostgreSQL completes the COPY command that activated the stream.
    Copy,
    /// Keep pumping until the frontend connection ends.
    Connection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolTransportMode {
    Buffered = 0,
    Stream = 1,
    Hybrid = 2,
}

impl ProtocolTransportMode {
    fn from_i32(value: i32) -> Result<Self> {
        match value {
            0 => Ok(Self::Buffered),
            1 => Ok(Self::Stream),
            2 => Ok(Self::Hybrid),
            other => anyhow::bail!("invalid WASIX protocol transport mode {other}"),
        }
    }
}

struct OliphauntLifecycleExports {
    wasi_start: TypedFunction<(), ()>,
    set_force_host_error_recovery: Option<TypedFunction<i32, i32>>,
    set_active: TypedFunction<i32, i32>,
    start_oliphaunt: TypedFunction<(), ()>,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    run_atexit_funcs: Option<TypedFunction<(), ()>>,
}

struct WasixProtocolExports {
    get_port: TypedFunction<(), i32>,
    process_startup: TypedFunction<(i32, i32, i32), i32>,
    send_conn_data: TypedFunction<(), ()>,
    pq_flush: TypedFunction<(), ()>,
    pq_buffer_remaining_data: TypedFunction<(), i32>,
    main_loop: TypedFunction<(), ()>,
    send_ready: TypedFunction<(), ()>,
    recover_error: TypedFunction<(), ()>,
}

#[derive(Clone)]
struct WasixProtocolStdioExports {
    set_protocol_transport: TypedFunction<i32, i32>,
    protocol_stream_active: TypedFunction<(), i32>,
}

struct WasixOliphauntIo {
    input_reset: TypedFunction<(), i32>,
    input_reserve: TypedFunction<i32, i32>,
    input_commit: TypedFunction<i32, i32>,
    input_available: TypedFunction<(), i32>,
    output_reset: TypedFunction<(), i32>,
    output_len: TypedFunction<(), i32>,
    output_data: TypedFunction<(), i32>,
    output_contains_error: TypedFunction<(), i32>,
}

impl PostgresMod {
    pub(crate) fn new_prepared_with_config(
        runtime_layout: RuntimeLayout,
        pgdata_storage: PgDataStorage,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        postgres_config.validate()?;
        startup_config.validate()?;
        ensure_runtime_dirs(&runtime_layout.mutable_root, &pgdata_storage)?;
        #[cfg(feature = "extensions")]
        let runtime_storage = runtime_layout.mutable_root.clone();
        let module_runtime_root = runtime_layout.module_root.clone();
        ensure!(
            module_runtime_root.join("bin/postgres").exists(),
            "WASIX PostgreSQL executable not found at {}",
            module_runtime_root.join("bin/postgres").display()
        );

        let (engine, module) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        {
            preload_runtime_side_modules(
                &process_runtime.tokio_runtime,
                &engine,
                &process_runtime.wasix_module_cache,
                &module_runtime_root,
            )?;
        }
        let mut store = Store::new(engine.clone());

        let (instance, env, protocol_stdio_file, wasi_stderr) =
            instantiate_wasix_module(WasixInstantiateInput {
                runtime: &process_runtime.tokio_runtime,
                wasix_runtime: &process_runtime.wasix_runtime,
                store: &mut store,
                runtime_layout: &runtime_layout,
                pgdata_storage: &pgdata_storage,
                postgres_config: &postgres_config,
                startup_config: &startup_config,
                module: module.clone(),
            })?;
        seed_exported_c_string_value(
            &mut store,
            &instance,
            &env,
            "my_exec_path",
            POSTGRES_EXE_PATH,
        )?;

        let (io, lifecycle, protocol, protocol_stdio) = {
            let io = WasixOliphauntIo::new(&mut store, &instance)?;
            ensure_integrated_oliphaunt_contract(&instance)?;
            let lifecycle = OliphauntLifecycleExports::load(&mut store, &instance)?;
            let protocol = WasixProtocolExports::load(&mut store, &instance)?;
            let protocol_stdio = WasixProtocolStdioExports::load(&mut store, &instance)?;
            (io, lifecycle, protocol, protocol_stdio)
        };

        let pg = Self {
            engine,
            tokio_runtime: process_runtime.tokio_runtime.clone(),
            wasix_module_cache: process_runtime.wasix_module_cache.clone(),
            _wasix_runtime: process_runtime.wasix_runtime.clone(),
            store,
            _instance: instance,
            env,
            io,
            lifecycle,
            protocol,
            protocol_stdio,
            protocol_stdio_file,
            wasi_stderr,
            protocol_stdio_attachment: None,
            #[cfg(feature = "extensions")]
            runtime_storage,
            pgdata_storage,
            startup_config,
            startup_response: None,
            cluster_ready: false,
            backend_started: false,
            started: false,
        };
        Ok(pg)
    }

    pub(crate) fn ensure_cluster(&mut self) -> Result<()> {
        self.initialize_cluster()?;
        self.start_backend()
    }

    pub fn initialize_cluster(&mut self) -> Result<()> {
        if self.cluster_ready {
            return Ok(());
        }

        let initialized = match &self.pgdata_storage {
            PgDataStorage::HostDirectory(_) => {
                self.pgdata_storage.is_file(Path::new("/PG_VERSION"))
                    && self.pgdata_storage.is_file(Path::new("/global/pg_control"))
            }
            PgDataStorage::Memory(filesystem) => virtual_cluster_is_complete(filesystem.as_ref()),
        };
        ensure!(
            initialized,
            "PGDATA is not initialized; install the WASIX runtime assets and cluster seed before opening"
        );
        self.cluster_ready = true;
        Ok(())
    }

    fn start_backend(&mut self) -> Result<()> {
        if self.backend_started {
            return Ok(());
        }
        self.configure_host_error_recovery()?;
        {
            self.lifecycle
                .set_active
                .call(&mut self.store, 1)
                .context("oliphaunt_wasix_set_active(1)")?;
        }
        {
            match self.lifecycle.wasi_start.call(&mut self.store) {
                Ok(()) => {}
                Err(err) if runtime_error_exit_code(&err) == Some(OLIPHAUNT_EXIT_ALIVE) => {}
                Err(err) => {
                    return self.startup_failure(err, "_start Oliphaunt single-user backend");
                }
            }
        }
        if let Err(err) = self.lifecycle.start_oliphaunt.call(&mut self.store) {
            return self.startup_failure(err, "oliphaunt_wasix_start");
        }
        self.backend_started = true;
        Ok(())
    }

    fn configure_host_error_recovery(&mut self) -> Result<()> {
        let force = host_requires_process_exit_error_recovery();
        let Some(set_force) = &self.lifecycle.set_force_host_error_recovery else {
            if force {
                anyhow::bail!(
                    "WASIX runtime does not export oliphaunt_wasix_set_force_host_error_recovery required by this host"
                );
            }
            return Ok(());
        };

        set_force
            .call(&mut self.store, i32::from(force))
            .context("oliphaunt_wasix_set_force_host_error_recovery")?;
        Ok(())
    }

    fn startup_failure(&mut self, err: wasmer::RuntimeError, context: &str) -> Result<()> {
        if let Some(output) = self.take_startup_output_after_failure() {
            if protocol_response_contains_error(&output) {
                return Err(StartupErrorResponse::new(output).into());
            }
            return Err(err).context(format!(
                "{context}{}",
                self.startup_failure_detail(Some(&output))
            ));
        }
        Err(err).context(format!("{context}{}", self.startup_failure_detail(None)))
    }

    fn take_startup_output_after_failure(&mut self) -> Option<Vec<u8>> {
        let _ = self.protocol.pq_flush.call(&mut self.store);
        match self.io.take_output(&mut self.store, &self.env) {
            Ok(output) if !output.is_empty() => Some(output),
            Ok(_) => None,
            Err(err) => {
                warn!("failed to read startup output after backend failure: {err}");
                None
            }
        }
    }

    fn startup_failure_detail(&self, output: Option<&[u8]>) -> String {
        let mut detail = String::new();
        let stderr = self.wasi_stderr.text();
        if !stderr.trim().is_empty() {
            detail.push_str("\nWASIX stderr tail:\n");
            detail.push_str(stderr.trim_end());
        }
        if let Some(output) = output {
            detail.push_str("\nWASIX startup output tail:\n");
            detail.push_str(&format_output_tail(output));
        }
        detail
    }

    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    pub(crate) fn shutdown_backend(&mut self) -> Result<()> {
        self.lifecycle
            .set_active
            .call(&mut self.store, 0)
            .context("oliphaunt_wasix_set_active(0)")?;
        if let Some(run_atexit_funcs) = &self.lifecycle.run_atexit_funcs {
            run_atexit_funcs
                .call(&mut self.store)
                .context("oliphaunt_wasix_run_atexit_funcs")?;
        }
        self.backend_started = false;
        self.started = false;
        self.startup_response = None;
        self.cluster_ready = false;
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub fn preload_extension_module(&self, extension: Extension) -> Result<()> {
        for module in extension.native_support_modules() {
            seed_extension_side_module(
                &self.tokio_runtime,
                &self.engine,
                &self.wasix_module_cache,
                &self.runtime_storage,
                module.runtime_path(),
                module.aot_name(),
                &format!(
                    "extension '{}' support module '{}'",
                    extension.sql_name(),
                    module.runtime_path()
                ),
            )?;
        }

        let Some(module_file) = extension.native_module_file() else {
            return Ok(());
        };
        seed_extension_side_module(
            &self.tokio_runtime,
            &self.engine,
            &self.wasix_module_cache,
            &self.runtime_storage,
            &format!("lib/postgresql/{module_file}"),
            extension.aot_name(),
            &format!("extension '{}'", extension.sql_name()),
        )?;
        Ok(())
    }

    pub(crate) fn run_split_initdb(
        runtime_layout: &RuntimeLayout,
        pgdata_storage: &PgDataStorage,
    ) -> Result<()> {
        run_split_initdb(runtime_layout, pgdata_storage)
    }

    pub fn send_protocol(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        {
            self.start_protocol()?;
        }
        if payload.is_empty() {
            return Ok(Vec::new());
        }
        self.send_protocol_inner(payload)
    }

    pub(crate) fn attach_protocol_stream<S>(&mut self, stream: S) -> Result<()>
    where
        S: ProtocolStream + 'static,
    {
        ensure!(
            self.protocol_stdio.is_some(),
            "WASIX runtime does not export protocol stream transport"
        );
        if self.protocol_stdio_attachment.is_none() {
            let attachment = self.protocol_stdio_file.attach(stream)?;
            self.protocol_stdio_attachment = Some(attachment);
        }
        Ok(())
    }

    pub(crate) fn set_protocol_stream_prefix(&mut self, prefix: Vec<u8>) -> Result<()> {
        self.protocol_stdio_file.set_prefix(prefix)
    }

    pub(crate) fn clear_protocol_stream_prefix(&mut self) -> Result<()> {
        self.protocol_stdio_file.clear_prefix()
    }

    pub(crate) fn send_protocol_pump(
        &mut self,
        payload: &[u8],
        continuation_prefix: impl FnOnce() -> Vec<u8>,
        scope: ProtocolPumpScope,
    ) -> Result<ProtocolPumpOutcome> {
        {
            self.start_protocol()?;
        }
        if payload.is_empty() {
            return Ok(ProtocolPumpOutcome::Buffered(Vec::new()));
        }
        ensure!(
            self.protocol_stdio_attachment.is_some(),
            "WASIX protocol pump requires an attached stream"
        );
        let previous_mode = self.set_protocol_transport(ProtocolTransportMode::Hybrid)?;
        ensure!(
            previous_mode == ProtocolTransportMode::Buffered,
            "WASIX protocol transport was not buffered before protocol pump"
        );
        let result = self.send_protocol_inner(payload);
        let active = self.protocol_stream_active().unwrap_or(false);
        if active {
            let stream_result = match scope {
                // The triggering PostgresMainLoopOnce call synchronously completes
                // COPY. Starting another iteration would consume the next frontend
                // frame (normally Terminate) as part of the borrowed session.
                ProtocolPumpScope::Copy => result.map(|_| ()),
                ProtocolPumpScope::Connection => result.and_then(|_| {
                    self.set_protocol_stream_prefix(continuation_prefix())?;
                    self.serve_protocol_stream_inner()
                }),
            };
            let restore_result = self.restore_protocol_transport(previous_mode);
            let clear_result = self.clear_protocol_stream_prefix();
            stream_result.and(restore_result).and(clear_result)?;
            Ok(ProtocolPumpOutcome::Streamed)
        } else {
            let output = result;
            let restore_result = self.restore_protocol_transport(previous_mode);
            restore_result?;
            let output = output?;
            Ok(ProtocolPumpOutcome::Buffered(output))
        }
    }

    fn send_protocol_inner(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        {
            self.io.reset(&mut self.store)?;
        }
        {
            self.io.push_input(&mut self.store, &self.env, payload)?;
        }

        {
            let max_attempts = (payload.len() / 5).saturating_add(2).max(1);
            let mut attempts = 0usize;
            let mut recovered_protocol_error = false;
            while self.protocol_input_remaining()? > 0 {
                attempts += 1;
                ensure!(
                    attempts <= max_attempts,
                    "Postgres protocol dispatch did not drain buffered input after {attempts} attempts"
                );
                if let Err(err) = self.protocol.main_loop.call(&mut self.store) {
                    if runtime_error_exit_code(&err) == Some(POSTGRES_MAIN_LONGJMP) {
                        debug!(
                            "PostgresMainLoopOnce used host longjmp fallback; recovering protocol error"
                        );
                        self.recover_protocol_error(payload.len())?;
                        recovered_protocol_error = true;
                    } else if is_wasm_uncaught_exception(&err) {
                        debug!(
                            "PostgresMainLoopOnce trapped for PostgreSQL error; recovering protocol state: {err}"
                        );
                        self.recover_protocol_error(payload.len())?;
                        recovered_protocol_error = true;
                    } else {
                        warn!("PostgresMainLoopOnce trapped; attempting protocol recovery: {err}");
                        self.recover_protocol_error(payload.len())?;
                        recovered_protocol_error = true;
                    }
                }
            }

            {
                self.protocol
                    .send_ready
                    .call(&mut self.store)
                    .context("PostgresSendReadyForQueryIfNecessary")?;
            }
            {
                self.protocol
                    .pq_flush
                    .call(&mut self.store)
                    .context("oliphaunt_wasix_pq_flush after protocol buffer")?;
            }
            let contains_error = self.io.output_contains_error(&mut self.store)?;
            let output = {
                self.io
                    .take_output(&mut self.store, &self.env)
                    .context("take backend output after protocol buffer")?
            };
            if !recovered_protocol_error && contains_error {
                self.recover_non_trapping_protocol_error()?;
            }
            Ok(output)
        }
    }

    pub(crate) fn supports_streaming_protocol(&self) -> bool {
        self.protocol_stdio.is_some()
    }

    fn serve_protocol_stream_inner(&mut self) -> Result<()> {
        loop {
            if let Err(err) = self.protocol.main_loop.call(&mut self.store) {
                if runtime_error_exit_code(&err) == Some(OLIPHAUNT_EXIT_ALIVE) {
                    break;
                }
                if runtime_error_exit_code(&err) == Some(POSTGRES_MAIN_LONGJMP) {
                    debug!(
                        "PostgresMainLoopOnce used host longjmp fallback while serving streaming protocol"
                    );
                    self.protocol.recover_error.call(&mut self.store).context(
                        "recover Postgres main-loop error while serving streaming protocol",
                    )?;
                } else if is_wasm_uncaught_exception(&err) {
                    debug!(
                        "PostgresMainLoopOnce trapped for PostgreSQL error while serving streaming protocol: {err}"
                    );
                    self.protocol.recover_error.call(&mut self.store).context(
                        "recover Postgres main-loop error while serving streaming protocol",
                    )?;
                } else {
                    return Err(err).context("PostgresMainLoopOnce streaming protocol");
                }
            }
            self.protocol
                .send_ready
                .call(&mut self.store)
                .context("PostgresSendReadyForQueryIfNecessary streaming protocol")?;
            self.protocol
                .pq_flush
                .call(&mut self.store)
                .context("oliphaunt_wasix_pq_flush streaming protocol")?;
        }
        Ok(())
    }

    fn set_protocol_transport(
        &mut self,
        mode: ProtocolTransportMode,
    ) -> Result<ProtocolTransportMode> {
        let stdio = self
            .protocol_stdio
            .as_ref()
            .context("WASIX runtime does not export protocol stdio switching")?;
        let previous = stdio
            .set_protocol_transport
            .call(&mut self.store, mode as i32)
            .context("oliphaunt_wasix_set_protocol_transport")?;
        ProtocolTransportMode::from_i32(previous)
    }

    fn restore_protocol_transport(&mut self, previous_mode: ProtocolTransportMode) -> Result<()> {
        let current = self.set_protocol_transport(previous_mode)?;
        ensure!(
            current != previous_mode,
            "oliphaunt_wasix_set_protocol_transport restore observed unchanged current mode"
        );
        Ok(())
    }

    fn protocol_stream_active(&mut self) -> Result<bool> {
        let stdio = self
            .protocol_stdio
            .as_ref()
            .context("WASIX runtime does not export protocol stream state")?;
        Ok(stdio
            .protocol_stream_active
            .call(&mut self.store)
            .context("oliphaunt_wasix_protocol_stream_active")?
            != 0)
    }

    fn start_protocol(&mut self) -> Result<()> {
        if self.started {
            return Ok(());
        }
        let startup = startup_packet(&self.startup_config.username, &self.startup_config.database);
        let response = self.start_protocol_with_startup_packet(&startup)?;
        ensure!(
            response.accepted,
            "Oliphaunt WASIX startup packet was rejected: {}",
            summarize_protocol(&response.output)
        );
        ensure!(
            !protocol_response_contains_error(&response.output),
            "Oliphaunt WASIX startup packet returned an error: {}",
            summarize_protocol(&response.output)
        );
        Ok(())
    }

    pub(crate) fn start_protocol_with_startup_packet(
        &mut self,
        startup: &[u8],
    ) -> Result<StartupProtocolResponse> {
        self.ensure_cluster()?;
        ensure!(
            !self.started,
            "Oliphaunt WASIX protocol startup has already completed for this backend"
        );

        {
            self.io.reset(&mut self.store)?;
        }
        {
            self.io.push_input(&mut self.store, &self.env, startup)?;
        }

        // The upstream lifecycle is already running by this point. These calls
        // open the Rust-owned direct wire-protocol transport on top of that
        // lifecycle; they must not grow into a second backend lifecycle.
        let port = {
            self.protocol
                .get_port
                .call(&mut self.store)
                .context("oliphaunt_wasix_get_proc_port")?
        };
        ensure!(port > 0, "oliphaunt_wasix_get_proc_port returned null");

        let status = {
            self.protocol
                .process_startup
                .call(&mut self.store, port, 1, 1)
                .context("ProcessStartupPacket")?
        };
        if status != 0 {
            let _ = self.protocol.pq_flush.call(&mut self.store);
            let output = self.io.take_output(&mut self.store, &self.env)?;
            return Ok(StartupProtocolResponse {
                output,
                accepted: false,
            });
        }
        let output = {
            {
                self.protocol
                    .send_conn_data
                    .call(&mut self.store)
                    .context("oliphaunt_wasix_send_conn_data")?;
            }
            {
                self.protocol
                    .pq_flush
                    .call(&mut self.store)
                    .context("oliphaunt_wasix_pq_flush after startup")?;
            }
            self.io.take_output(&mut self.store, &self.env)?
        };
        self.started = true;
        self.startup_response = Some(output.clone());
        Ok(StartupProtocolResponse {
            output,
            accepted: true,
        })
    }

    #[cfg(feature = "tools")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.startup_response.clone()
    }

    #[cfg(feature = "tools")]
    pub(crate) fn startup_config(&self) -> &StartupConfig {
        &self.startup_config
    }

    fn recover_protocol_error(&mut self, payload_len: usize) -> Result<()> {
        self.protocol
            .recover_error
            .call(&mut self.store)
            .context("PostgresMainLongJmp after protocol trap")?;

        // PostgreSQL extended-query errors skip messages until Sync. If Sync was
        // already in this host buffer, re-enter the loop to drain it and produce
        // ReadyForQuery from PostgreSQL rather than inventing one in Rust.
        let max_drain_attempts = (payload_len / 5).saturating_add(2).max(1);
        let mut drain_attempts = 0usize;
        while self.protocol_input_remaining()? > 0 {
            drain_attempts += 1;
            ensure!(
                drain_attempts <= max_drain_attempts,
                "Postgres protocol recovery did not drain buffered input after {drain_attempts} attempts"
            );
            if let Err(drain_err) = self.protocol.main_loop.call(&mut self.store) {
                if runtime_error_exit_code(&drain_err) == Some(POSTGRES_MAIN_LONGJMP)
                    || is_wasm_uncaught_exception(&drain_err)
                {
                    debug!(
                        "PostgresMainLoopOnce trapped while draining after PostgreSQL error recovery: {drain_err}"
                    );
                } else {
                    warn!(
                        "PostgresMainLoopOnce trapped while draining after recovery: {drain_err}"
                    );
                }
                self.protocol
                    .recover_error
                    .call(&mut self.store)
                    .context("PostgresMainLongJmp while draining after protocol trap")?;
            }
        }
        Ok(())
    }

    fn recover_non_trapping_protocol_error(&mut self) -> Result<()> {
        self.protocol
            .recover_error
            .call(&mut self.store)
            .context("PostgresMainLongJmp after backend ErrorResponse")?;
        self.protocol
            .send_ready
            .call(&mut self.store)
            .context("PostgresSendReadyForQueryIfNecessary after backend ErrorResponse")?;
        self.protocol
            .pq_flush
            .call(&mut self.store)
            .context("oliphaunt_wasix_pq_flush after backend ErrorResponse recovery")?;
        let _ = self.io.take_output(&mut self.store, &self.env)?;
        Ok(())
    }

    fn protocol_input_remaining(&mut self) -> Result<i32> {
        let host_remaining = self.io.available(&mut self.store)?;
        if host_remaining > 0 {
            return Ok(host_remaining);
        }
        self.protocol
            .pq_buffer_remaining_data
            .call(&mut self.store)
            .context("pq_buffer_remaining_data")
    }
}

fn process_wasix_runtime(engine: &Engine) -> Result<Arc<WasixProcessRuntime>> {
    WASIX_PROCESS_RUNTIME
        .get_or_init(|| {
            let tokio_runtime = {
                Arc::new(
                    tokio::runtime::Builder::new_multi_thread()
                        .enable_all()
                        .build()
                        .context("create Tokio runtime for Wasmer/WASIX filesystem")
                        .map_err(|err| format!("{err:#}"))?,
                )
            };
            let wasix_module_cache = { Arc::new(SharedCache::new()) };
            let wasix_runtime = {
                build_wasix_runtime(
                    &tokio_runtime,
                    engine,
                    wasix_module_cache.clone(),
                    GuestWasmTasks::Deny,
                )
            };

            Ok(Arc::new(WasixProcessRuntime {
                tokio_runtime,
                wasix_module_cache,
                wasix_runtime,
            }))
        })
        .clone()
        .map_err(|message| anyhow::anyhow!(message))
}

struct WasixInstantiateInput<'a> {
    runtime: &'a TokioRuntime,
    wasix_runtime: &'a Arc<dyn Runtime + Send + Sync>,
    store: &'a mut Store,
    runtime_layout: &'a RuntimeLayout,
    pgdata_storage: &'a PgDataStorage,
    postgres_config: &'a PostgresConfig,
    startup_config: &'a StartupConfig,
    module: Module,
}

fn instantiate_wasix_module(
    input: WasixInstantiateInput<'_>,
) -> Result<(
    Instance,
    WasiFunctionEnv,
    ProtocolStdioFile,
    TailCaptureHandle,
)> {
    let _guard = input.runtime.enter();
    let root_fs = database_wasi_root(input.runtime_layout, input.pgdata_storage)?;

    let mut runner = WasiRunner::new();
    runner.with_current_dir("/");
    let protocol_stdio_file = ProtocolStdioFile::new();
    let (stderr_file, stderr_capture) = TailCaptureFile::new(16 * 1024);
    runner.with_stdin(Box::new(protocol_stdio_file.clone()));
    runner.with_stdout(Box::new(protocol_stdio_file.clone()));
    runner.with_stderr(Box::new(stderr_file));
    let wasi = Wasi::new(POSTGRES_EXE_PATH);
    let mut builder = {
        runner
            .prepare_webc_env(
                POSTGRES_EXE_PATH,
                &wasi,
                PackageOrHash::Hash(ModuleHash::random()),
                RuntimeOrEngine::Runtime(input.wasix_runtime.clone()),
                Some(root_fs),
            )
            .context("prepare Wasmer/WASIX runner environment")?
    };
    {
        add_pgdata_preopen(&mut builder)?;
    }
    add_oliphaunt_env(&mut builder, input.startup_config, input.runtime_layout);
    add_oliphaunt_args(
        &mut builder,
        input.postgres_config,
        input.startup_config,
        input.pgdata_storage.is_durable_host_directory(),
    )?;
    constrain_single_backend_tasks(&mut builder);

    {
        builder
            .instantiate(input.module, input.store)
            .context("instantiate Oliphaunt WASIX module")
            .map(|(instance, env)| (instance, env, protocol_stdio_file, stderr_capture))
    }
}

fn add_pgdata_preopen(builder: &mut wasmer_wasix::WasiEnvBuilder) -> Result<()> {
    builder
        .add_preopen_build(|preopen| {
            preopen
                .directory(PGDATA_DIR)
                .alias(PGDATA_DIR.trim_start_matches('/'))
                .read(true)
                .write(true)
                .create(true)
        })
        .context("preopen PGDATA directory for Wasmer/WASIX")?;
    Ok(())
}

fn database_wasi_root(
    runtime_layout: &RuntimeLayout,
    pgdata_storage: &PgDataStorage,
) -> Result<WasiFsRoot> {
    let root = runtime_root_filesystem(runtime_layout)?;
    let pgdata = pgdata_filesystem(pgdata_storage)?;
    let root = wasi_root_with_pgdata_mount(root, pgdata)?;
    Ok(WasiFsRoot::from_filesystem(wasi_root_with_devices(root)?))
}

fn pgdata_filesystem(
    pgdata_storage: &PgDataStorage,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    match pgdata_storage {
        PgDataStorage::Memory(filesystem) => Ok(filesystem.clone()),
        PgDataStorage::HostDirectory(pgdata) => host_filesystem(pgdata),
    }
}

fn runtime_root_filesystem(
    runtime_layout: &RuntimeLayout,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let upper = match &runtime_layout.mutable_root {
        StorageRoot::HostDirectory(path) => host_filesystem(path)?,
        StorageRoot::Memory(filesystem) => filesystem.clone(),
    };
    if !runtime_layout.uses_shared_overlay() {
        return Ok(upper);
    }
    let upper = virtual_fs::ArcFileSystem::new(upper);
    let shared_root = runtime_layout
        .shared_root
        .as_ref()
        .context("shared runtime overlay is missing its immutable filesystem")?;
    let lower = virtual_fs::ArcFileSystem::new(shared_root.clone());
    Ok(Arc::new(virtual_fs::OverlayFileSystem::new(upper, [lower])))
}

fn wasi_root_with_pgdata_mount(
    root: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
    pgdata: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
) -> virtual_fs::Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let mount = virtual_fs::MountFileSystem::new();
    mount.mount(Path::new("/"), root)?;
    mount.mount(Path::new(PGDATA_DIR), pgdata)?;
    Ok(Arc::new(mount))
}

fn build_wasix_runtime(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: Arc<SharedCache>,
    guest_wasm_tasks: GuestWasmTasks,
) -> Arc<dyn Runtime + Send + Sync> {
    let _guard = runtime.enter();
    let task_manager: Arc<dyn VirtualTaskManager> =
        Arc::new(TokioTaskManager::new(runtime.handle().clone()));
    let task_manager = guest_wasm_tasks.apply(task_manager);
    let mut wasix_runtime = PluggableRuntime::new(task_manager);
    wasix_runtime.set_engine(engine.clone());
    wasix_runtime.set_module_cache(module_cache);
    Arc::new(wasix_runtime)
}

fn run_split_initdb(runtime_layout: &RuntimeLayout, pgdata_storage: &PgDataStorage) -> Result<()> {
    let initdb_module = runtime_layout.module_root.join("bin/initdb");
    let postgres_module = runtime_layout.module_root.join("bin/postgres");
    ensure!(
        initdb_module.exists(),
        "split WASIX initdb module is not installed at {}; regenerate assets with `xtask assets cluster-seeds`",
        initdb_module.display()
    );
    ensure!(
        postgres_module.exists(),
        "WASIX postgres module is not installed at {}",
        postgres_module.display()
    );

    if let PgDataStorage::HostDirectory(pgdata) = pgdata_storage {
        fs::create_dir_all(pgdata)
            .with_context(|| format!("create fresh PGDATA {}", pgdata.display()))?;
    }

    let (engine, _) = aot::load_runtime_module()?;
    let process_runtime = process_wasix_runtime(&engine)?;
    seed_wasix_module_cache(
        &process_runtime.tokio_runtime,
        &engine,
        &process_runtime.wasix_module_cache,
        &initdb_module,
        "tool:initdb",
        "split initdb command",
    )?;
    seed_wasix_module_cache(
        &process_runtime.tokio_runtime,
        &engine,
        &process_runtime.wasix_module_cache,
        &postgres_module,
        "runtime:oliphaunt",
        "initdb child postgres command",
    )?;
    preload_runtime_side_modules(
        &process_runtime.tokio_runtime,
        &engine,
        &process_runtime.wasix_module_cache,
        &runtime_layout.module_root,
    )?;
    // initdb execs child postgres commands; isolate that command process tree
    // from concurrently running backends while keeping the module cache shared.
    let initdb_runtime = build_wasix_runtime(
        &process_runtime.tokio_runtime,
        &engine,
        process_runtime.wasix_module_cache.clone(),
        GuestWasmTasks::Allow,
    );

    let package = split_initdb_binary_package(&initdb_module, &postgres_module)?;
    let root_fs = split_initdb_root_filesystem(runtime_layout, pgdata_storage)?;
    root_fs
        .read_dir(Path::new(PGDATA_DIR))
        .with_context(|| format!("verify split initdb {PGDATA_DIR} mount"))?;

    let (stdout_file, stdout_capture) = TailCaptureFile::new(8 * 1024);
    let (stderr_file, stderr_capture) = TailCaptureFile::new(8 * 1024);

    let mut runner = WasiRunner::new();
    runner
        .with_current_dir("/")
        .with_injected_package(package.clone())
        .with_args(split_initdb_args())
        .with_envs([
            ("PGDATA", PGDATA_DIR),
            ("PGSYSCONFDIR", PGDATA_DIR),
            ("HOME", "/home/postgres"),
            ("USER", "postgres"),
            ("LOGNAME", "postgres"),
            ("PGCLIENTENCODING", "UTF8"),
            ("PATH", "/bin"),
            ("LC_CTYPE", "C.UTF-8"),
            ("TZ", "UTC"),
            ("PGTZ", "UTC"),
            ("PG_COLOR", "never"),
        ])
        .with_stdin(Box::<NullFile>::default())
        .with_stdout(Box::new(stdout_file))
        .with_stderr(Box::new(stderr_file));
    runner.with_envs(split_initdb_profile_environment(
        wasix_icu_data_is_available(runtime_layout),
    ));

    {
        let result =
            run_package_command_with_root(&runner, "initdb", &package, initdb_runtime, root_fs);
        if let Err(err) = result {
            let stdout = stdout_capture.text();
            let stderr = stderr_capture.text();
            let diagnostics = split_initdb_diagnostics(runtime_layout, pgdata_storage);
            return Err(err).with_context(|| {
                format!(
                    "run split WASIX initdb\n{}\ninitdb stdout:\n{}\ninitdb stderr:\n{}",
                    diagnostics,
                    if stdout.trim().is_empty() {
                        "<empty>"
                    } else {
                        stdout.trim_end()
                    },
                    if stderr.trim().is_empty() {
                        "<empty>"
                    } else {
                        stderr.trim_end()
                    }
                )
            });
        }
    }
    Ok(())
}

fn split_initdb_root_filesystem(
    runtime_layout: &RuntimeLayout,
    pgdata_storage: &PgDataStorage,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let root = runtime_root_filesystem(runtime_layout)?;

    let pgdata = pgdata_filesystem(pgdata_storage)?;
    // initdb execs a child postgres command during bootstrap. Keep PGDATA inside
    // the root filesystem view so both commands inherit the same /base mount.
    let root = wasi_root_with_pgdata_mount(root, pgdata)?;
    // Wasmer's runner normally starts from a temporary root that provides WASIX
    // device files. Keep the real runtime/PGDATA root mounted for database
    // writes, but route device paths such as /dev/urandom to virtual devices.
    Ok(wasi_root_with_devices(root)?)
}

fn run_package_command_with_root(
    runner: &WasiRunner,
    command_name: &str,
    package: &BinaryPackage,
    runtime: Arc<dyn Runtime + Send + Sync>,
    root_fs: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
) -> Result<()> {
    let cmd = package.get_command(command_name).with_context(|| {
        format!("split initdb package does not contain command {command_name:?}")
    })?;
    let wasi = cmd
        .metadata()
        .annotation("wasi")?
        .unwrap_or_else(|| Wasi::new(command_name));
    let exec_name = wasi.exec_name.as_deref().unwrap_or(command_name);
    let mut builder = runner
        .prepare_webc_env(
            exec_name,
            &wasi,
            PackageOrHash::Package(package),
            RuntimeOrEngine::Runtime(runtime),
            Some(WasiFsRoot::from_filesystem(root_fs)),
        )
        .with_context(|| format!("prepare WASIX command environment for {command_name:?}"))?;
    add_pgdata_preopen(&mut builder)?;

    let env = builder.build()?;
    let runtime = env.runtime.clone();
    let tasks = runtime.task_manager().clone();
    let package = package.clone();
    let command_name = command_name.to_owned();
    let exit_code = tasks.spawn_and_block_on(async move {
        let mut task_handle = spawn_exec(package, &command_name, env, &runtime)
            .await
            .with_context(|| format!("spawn WASIX command {command_name:?}"))?;
        task_handle
            .wait_finished()
            .await
            .map_err(|err| anyhow::anyhow!("{err}"))
            .with_context(|| format!("wait for WASIX command {command_name:?}"))
    })??;

    ensure!(exit_code.raw() == 0, "WASI exited with code: {exit_code}");
    Ok(())
}

fn split_initdb_diagnostics(
    runtime_layout: &RuntimeLayout,
    pgdata_storage: &PgDataStorage,
) -> String {
    if let PgDataStorage::Memory(filesystem) = pgdata_storage {
        let entries = filesystem
            .read_dir(Path::new("/"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .take(16)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_else(|err| format!("<unavailable: {err}>"));
        return format!(
            "initdb diagnostics:\n  layout_kind={:?}\n  storage=memory\n  runtime_workspace=memory\n  module_directory={}\n  database_entries={entries}",
            runtime_layout.kind,
            path_state(&runtime_layout.module_root),
        );
    }
    let PgDataStorage::HostDirectory(pgdata) = pgdata_storage else {
        unreachable!("memory storage returned above")
    };
    let pgdata_parent = pgdata.parent().unwrap_or(pgdata);
    format!(
        "initdb diagnostics:\n  layout_kind={:?}\n  storage=directory\n  data_directory={}\n  data_parent={}\n  runtime_workspace={}\n  module_directory={}\n  database_entries={}",
        runtime_layout.kind,
        path_state(pgdata),
        path_state(pgdata_parent),
        runtime_storage_state(&runtime_layout.mutable_root),
        path_state(&runtime_layout.module_root),
        dir_entry_sample(pgdata),
    )
}

fn runtime_storage_state(storage: &StorageRoot) -> String {
    match storage {
        StorageRoot::HostDirectory(path) => path_state(path),
        StorageRoot::Memory(_) => "memory".to_owned(),
    }
}

fn path_state(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(metadata) => format!(
            "{} ({})",
            path.display(),
            if metadata.is_dir() {
                "dir"
            } else if metadata.is_file() {
                "file"
            } else {
                "other"
            }
        ),
        Err(err) => format!("{} ({})", path.display(), err),
    }
}

fn dir_entry_sample(path: &Path) -> String {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(err) => return format!("<read_dir failed: {err}>"),
    };
    let mut names = entries
        .filter_map(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .take(8)
        .collect::<Vec<_>>();
    names.sort();
    if names.is_empty() {
        "<empty>".to_owned()
    } else {
        names.join(", ")
    }
}

fn split_initdb_args() -> Vec<&'static str> {
    vec![
        "--allow-group-access",
        "--encoding",
        "UTF8",
        "--locale",
        "C.UTF-8",
        "--locale-provider",
        "libc",
        "--auth",
        "trust",
        "-D",
        PGDATA_DIR,
    ]
}

fn split_initdb_binary_package(
    initdb_module: &Path,
    postgres_module: &Path,
) -> Result<BinaryPackage> {
    let initdb_wasm =
        fs::read(initdb_module).with_context(|| format!("read {}", initdb_module.display()))?;
    let postgres_wasm =
        fs::read(postgres_module).with_context(|| format!("read {}", postgres_module.display()))?;

    let mut package_hash = Sha256::new();
    package_hash.update(b"oliphaunt-wasix-split-initdb-package-v1\n");
    package_hash.update(&initdb_wasm);
    package_hash.update(&postgres_wasm);
    let package_hash: [u8; 32] = package_hash.finalize().into();
    let package_id = PackageId::Hash(PackageHash::from_sha256_bytes(package_hash));

    Ok(BinaryPackage {
        id: package_id.clone(),
        package_ids: vec![package_id.clone()],
        when_cached: None,
        entrypoint_cmd: Some("initdb".to_owned()),
        hash: Default::default(),
        package_mounts: None,
        commands: vec![
            split_initdb_command("initdb", initdb_wasm, &package_id),
            split_initdb_command("postgres", postgres_wasm, &package_id),
        ],
        uses: Vec::new(),
        file_system_memory_footprint: 0,
        additional_host_mapped_directories: Vec::new(),
    })
}

fn split_initdb_command(name: &str, wasm: Vec<u8>, package_id: &PackageId) -> BinaryPackageCommand {
    let hash = ModuleHash::new(&wasm);
    let atom: webc::compat::SharedBytes = wasm.into();
    BinaryPackageCommand::new(
        name.to_owned(),
        WebcCommand {
            runner: WASI_RUNNER_URI.to_owned(),
            annotations: Default::default(),
        },
        atom,
        hash,
        None,
        package_id.clone(),
        package_id.clone(),
    )
}

fn preload_runtime_side_modules(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    runtime_root: &Path,
) -> Result<()> {
    let lib_dir = runtime_root.join("lib/postgresql");
    for (file_name, artifact_name) in RUNTIME_SIDE_MODULES {
        let library = lib_dir.join(file_name);
        ensure!(
            library.exists(),
            "runtime support module '{}' is not installed at {}",
            file_name,
            library.display()
        );

        seed_wasix_module_cache(
            runtime,
            engine,
            module_cache,
            &library,
            artifact_name,
            &format!("runtime support module '{file_name}'"),
        )?;
    }
    Ok(())
}

#[cfg(feature = "extensions")]
fn seed_extension_side_module(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    runtime_root: &StorageRoot,
    runtime_path: &str,
    aot_name: Option<&'static str>,
    label: &str,
) -> Result<()> {
    let Some(aot_name) = aot_name else {
        return Ok(());
    };
    let path = Path::new("/").join(runtime_path);
    let wasm = runtime_root
        .read(&path)
        .with_context(|| format!("{label} is not installed at {}", path.display()))?;
    seed_wasix_module_cache_bytes(runtime, engine, module_cache, &wasm, aot_name, label)
}

fn seed_wasix_module_cache(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    wasm_path: &Path,
    artifact_name: &str,
    label: &str,
) -> Result<()> {
    let wasm = {
        fs::read(wasm_path).with_context(|| format!("read WASIX module {}", wasm_path.display()))?
    };
    seed_wasix_module_cache_bytes(runtime, engine, module_cache, &wasm, artifact_name, label)
}

fn seed_wasix_module_cache_bytes(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    wasm: &[u8],
    artifact_name: &str,
    label: &str,
) -> Result<()> {
    let module_hash = ModuleHash::new(wasm);
    let seed_key = format!("{artifact_name}:{}:{module_hash}", aot::engine_identity());
    let mut seeded_side_modules = SEEDED_SIDE_MODULES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("seeded side module cache poisoned");
    if seeded_side_modules.contains(&seed_key) {
        return Ok(());
    }

    // Keep the process-wide seed check and SharedCache write atomic. Wasmer's
    // shared cache is global to all concurrent Oliphaunt instances in this process.
    let module = aot::load_artifact_module(engine, artifact_name)?;
    {
        block_on_tokio_runtime(runtime, module_cache.save(module_hash, engine, &module))
            .with_context(|| format!("seed Wasmer module cache for {label} ({module_hash})"))?;
    }
    seeded_side_modules.insert(seed_key);
    Ok(())
}

fn block_on_tokio_runtime<F, T>(runtime: &TokioRuntime, future: F) -> T
where
    F: Future<Output = T> + Send,
    T: Send,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::scope(|scope| {
            scope
                .spawn(move || runtime.block_on(future))
                .join()
                .unwrap_or_else(|payload| std::panic::resume_unwind(payload))
        });
    }

    runtime.block_on(future)
}

impl OliphauntLifecycleExports {
    fn load(store: &mut Store, instance: &Instance) -> Result<Self> {
        let wasi_start = typed_export(store, instance, "_start")?;
        let set_force_host_error_recovery = optional_typed_export(
            store,
            instance,
            "oliphaunt_wasix_set_force_host_error_recovery",
        )?;
        let set_active = typed_export(store, instance, "oliphaunt_wasix_set_active")?;
        let start_oliphaunt = typed_export(store, instance, "oliphaunt_wasix_start")?;
        let run_atexit_funcs =
            optional_typed_export(store, instance, "oliphaunt_wasix_run_atexit_funcs")?;

        Ok(Self {
            wasi_start,
            set_force_host_error_recovery,
            set_active,
            start_oliphaunt,
            run_atexit_funcs,
        })
    }
}

impl WasixProtocolExports {
    fn load(store: &mut Store, instance: &Instance) -> Result<Self> {
        let get_port = typed_export(store, instance, "oliphaunt_wasix_get_proc_port")?;
        let process_startup = typed_export(store, instance, "ProcessStartupPacket")?;
        let send_conn_data = typed_export(store, instance, "oliphaunt_wasix_send_conn_data")?;
        let pq_flush = typed_export(store, instance, "oliphaunt_wasix_pq_flush")?;
        let pq_buffer_remaining_data = typed_export(store, instance, "pq_buffer_remaining_data")?;
        let main_loop = typed_export(store, instance, "PostgresMainLoopOnce")?;
        let send_ready = typed_export(store, instance, "PostgresSendReadyForQueryIfNecessary")?;
        let recover_error = typed_export(store, instance, "PostgresMainLongJmp")?;

        Ok(Self {
            get_port,
            process_startup,
            send_conn_data,
            pq_flush,
            pq_buffer_remaining_data,
            main_loop,
            send_ready,
            recover_error,
        })
    }
}

impl WasixProtocolStdioExports {
    fn load(store: &mut Store, instance: &Instance) -> Result<Option<Self>> {
        let Some(set_protocol_transport) = optional_typed_export::<i32, i32>(
            store,
            instance,
            "oliphaunt_wasix_set_protocol_transport",
        )?
        else {
            return Ok(None);
        };
        let protocol_stream_active =
            typed_export::<(), i32>(store, instance, "oliphaunt_wasix_protocol_stream_active")?;
        Ok(Some(Self {
            set_protocol_transport,
            protocol_stream_active,
        }))
    }
}

fn ensure_integrated_oliphaunt_contract(instance: &Instance) -> Result<()> {
    for name in [
        "oliphaunt_wasix_start",
        "oliphaunt_wasix_set_active",
        "PostgresMainLongJmp",
    ] {
        ensure!(
            instance.exports.get_function(name).is_ok()
                || instance.exports.get_function(&format!("_{name}")).is_ok(),
            "WASIX runtime is missing integrated Oliphaunt lifecycle export {name}"
        );
    }
    Ok(())
}

impl WasixOliphauntIo {
    fn new(store: &mut Store, instance: &Instance) -> Result<Self> {
        let io = Self {
            input_reset: typed_export(store, instance, "oliphaunt_wasix_input_reset")?,
            input_reserve: typed_export(store, instance, "oliphaunt_wasix_input_reserve")?,
            input_commit: typed_export(store, instance, "oliphaunt_wasix_input_commit")?,
            input_available: typed_export(store, instance, "oliphaunt_wasix_input_available")?,
            output_reset: typed_export(store, instance, "oliphaunt_wasix_output_reset")?,
            output_len: typed_export(store, instance, "oliphaunt_wasix_output_len")?,
            output_data: typed_export(store, instance, "oliphaunt_wasix_output_data")?,
            output_contains_error: typed_export(
                store,
                instance,
                "oliphaunt_wasix_output_contains_error",
            )?,
        };
        io.reset(store)?;
        Ok(io)
    }

    fn reset(&self, store: &mut Store) -> Result<()> {
        ensure!(
            self.input_reset
                .call(&mut *store)
                .context("oliphaunt_wasix_input_reset")?
                == 0,
            "oliphaunt_wasix_input_reset failed"
        );
        ensure!(
            self.output_reset
                .call(&mut *store)
                .context("oliphaunt_wasix_output_reset")?
                == 0,
            "oliphaunt_wasix_output_reset failed"
        );
        Ok(())
    }

    fn push_input(&self, store: &mut Store, env: &WasiFunctionEnv, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let len = i32::try_from(bytes.len()).context("protocol input exceeds i32")?;
        let ptr = self
            .input_reserve
            .call(&mut *store, len)
            .context("oliphaunt_wasix_input_reserve")?;
        ensure!(ptr > 0, "oliphaunt_wasix_input_reserve returned null");
        let view = env
            .data(&*store)
            .try_memory_view(&*store)
            .context("get WASIX memory view")?;
        view.write(ptr as u64, bytes)
            .with_context(|| format!("write protocol input at 0x{ptr:x}"))?;
        let written = self
            .input_commit
            .call(&mut *store, len)
            .context("oliphaunt_wasix_input_commit")?;
        ensure!(
            written == len,
            "oliphaunt_wasix_input_commit committed {written}, expected {}",
            bytes.len()
        );
        Ok(())
    }

    fn available(&self, store: &mut Store) -> Result<i32> {
        let available = self
            .input_available
            .call(store)
            .context("oliphaunt_wasix_input_available")?;
        ensure!(
            available >= 0,
            "oliphaunt_wasix_input_available returned negative length {available}"
        );
        Ok(available)
    }

    fn take_output(&self, store: &mut Store, env: &WasiFunctionEnv) -> Result<Vec<u8>> {
        let len = self
            .output_len
            .call(&mut *store)
            .context("oliphaunt_wasix_output_len")?;
        ensure!(
            len >= 0,
            "oliphaunt_wasix_output_len returned negative length {len}"
        );
        if len == 0 {
            return Ok(Vec::new());
        }
        let ptr = self
            .output_data
            .call(&mut *store)
            .context("oliphaunt_wasix_output_data")?;
        ensure!(
            ptr > 0,
            "oliphaunt_wasix_output_data returned null for non-empty output"
        );
        let mut bytes = vec![0u8; len as usize];
        let view = env
            .data(&*store)
            .try_memory_view(&*store)
            .context("get WASIX memory view")?;
        view.read(ptr as u64, &mut bytes)
            .with_context(|| format!("read protocol output at 0x{ptr:x}"))?;
        ensure!(
            self.output_reset
                .call(&mut *store)
                .context("oliphaunt_wasix_output_reset after read")?
                == 0,
            "oliphaunt_wasix_output_reset after read failed"
        );
        Ok(bytes)
    }

    fn output_contains_error(&self, store: &mut Store) -> Result<bool> {
        Ok(self
            .output_contains_error
            .call(store)
            .context("oliphaunt_wasix_output_contains_error")?
            != 0)
    }
}

fn typed_export<Args, Rets>(
    store: &mut Store,
    instance: &Instance,
    name: &str,
) -> Result<TypedFunction<Args, Rets>>
where
    Args: WasmTypeList,
    Rets: WasmTypeList,
{
    instance
        .exports
        .get_typed_function::<Args, Rets>(&*store, name)
        .or_else(|_| {
            instance
                .exports
                .get_typed_function::<Args, Rets>(&*store, &format!("_{name}"))
        })
        .with_context(|| format!("get {name} export"))
}

fn optional_typed_export<Args, Rets>(
    store: &mut Store,
    instance: &Instance,
    name: &str,
) -> Result<Option<TypedFunction<Args, Rets>>>
where
    Args: WasmTypeList,
    Rets: WasmTypeList,
{
    let underscored_name = format!("_{name}");
    if instance.exports.get_function(name).is_err()
        && instance.exports.get_function(&underscored_name).is_err()
    {
        return Ok(None);
    }
    typed_export(store, instance, name).map(Some)
}

fn runtime_error_exit_code(err: &wasmer::RuntimeError) -> Option<i32> {
    err.downcast_ref::<WasiError>().and_then(|err| match err {
        WasiError::Exit(code) => Some(code.raw()),
        _ => None,
    })
}

fn is_wasm_uncaught_exception(err: &wasmer::RuntimeError) -> bool {
    // Wasmer reports an uncaught WebAssembly exception when PostgreSQL ERROR
    // unwinds across the exported loop boundary. The C recovery export then
    // performs the normal Postgres error cleanup and emits ErrorResponse.
    err.message().contains("uncaught exception")
}

fn host_requires_process_exit_error_recovery() -> bool {
    // Wasmer 7.2.1 disables its WebAssembly exception-handling tests on
    // Windows. Keep PostgreSQL's proven top-level process-exit recovery there;
    // other hosts retain nested PG_TRY/PG_CATCH unwinding.
    cfg!(target_env = "msvc")
}

fn wasix_icu_data_is_available(runtime_layout: &RuntimeLayout) -> bool {
    runtime_layout.mutable_root.is_dir(Path::new("/share/icu"))
        || runtime_layout.module_root.join("share/icu").is_dir()
}

fn split_initdb_profile_environment(icu_data_available: bool) -> Vec<(&'static str, &'static str)> {
    if icu_data_available {
        vec![
            ("ICU_DATA", ICU_DATA_DIR),
            ("OLIPHAUNT_INTERNAL_ICU_READY", "1"),
        ]
    } else {
        vec![(SKIP_ICU_COLLATION_DISCOVERY_ENV, "1")]
    }
}

fn add_oliphaunt_env(
    builder: &mut wasmer_wasix::WasiEnvBuilder,
    startup_config: &StartupConfig,
    runtime_layout: &RuntimeLayout,
) {
    for (key, value) in [
        ("PREFIX", WASM_PREFIX),
        ("PGDATA", PGDATA_DIR),
        ("PGUSER", startup_config.username.as_str()),
        ("PGDATABASE", startup_config.database.as_str()),
        ("MODE", "REACT"),
        ("REPL", "N"),
        ("PGSYSCONFDIR", PGDATA_DIR),
        ("PGCLIENTENCODING", "UTF8"),
        ("LC_CTYPE", "C.UTF-8"),
        ("TZ", "UTC"),
        ("PGTZ", "UTC"),
        ("PG_COLOR", "never"),
        ("PROJ_DATA", "/share/proj"),
    ] {
        builder.add_env(key, value);
    }
    if wasix_icu_data_is_available(runtime_layout) {
        builder.add_env("ICU_DATA", ICU_DATA_DIR);
    }
}

fn add_oliphaunt_args(
    builder: &mut wasmer_wasix::WasiEnvBuilder,
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
    durable_host_storage: bool,
) -> Result<()> {
    for arg in oliphaunt_args(postgres_config, startup_config, durable_host_storage)? {
        builder.add_arg(arg);
    }
    Ok(())
}

fn oliphaunt_args(
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
    durable_host_storage: bool,
) -> Result<Vec<String>> {
    postgres_config.validate()?;
    startup_config.validate()?;
    let mut args = vec!["--single".to_owned()];
    if !durable_host_storage {
        args.push("-F".to_owned());
    }
    args.extend(["-O", "-j"].map(str::to_owned));
    for (name, value) in DEFAULT_STARTUP_GUCS {
        args.push("-c".to_owned());
        args.push(format!("{name}={value}"));
    }
    for (name, value) in postgres_config.iter() {
        args.push("-c".to_owned());
        args.push(format!("{name}={value}"));
    }
    for (name, value) in crate::oliphaunt::config::SINGLE_BACKEND_STARTUP_GUCS {
        args.push("-c".to_owned());
        args.push(format!("{name}={value}"));
    }
    args.extend(["-D", PGDATA_DIR, "--", startup_config.database.as_str()].map(str::to_owned));
    Ok(args)
}

const DEFAULT_STARTUP_GUCS: &[(&str, &str)] = &[
    ("search_path", "public"),
    ("log_checkpoints", "false"),
    ("wal_buffers", "4MB"),
    ("min_wal_size", "80MB"),
    ("shared_buffers", "128MB"),
];

fn ensure_runtime_dirs(
    runtime_storage: &StorageRoot,
    pgdata_storage: &PgDataStorage,
) -> Result<()> {
    for path in ["/", "/home", "/dev", "/dev/shm", "/tmp"] {
        runtime_storage.create_dir_all(Path::new(path))?;
    }
    if let PgDataStorage::HostDirectory(pgdata) = pgdata_storage {
        fs::create_dir_all(pgdata)
            .with_context(|| format!("create PGDATA {}", pgdata.display()))?;
    }

    Ok(())
}

fn startup_packet(user: &str, database: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&196608i32.to_be_bytes());
    for (key, value) in [
        ("user", user),
        ("database", database),
        ("client_encoding", "UTF8"),
        ("DateStyle", "ISO, MDY"),
        ("TimeZone", "UTC"),
    ] {
        body.extend_from_slice(key.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);

    let mut packet = Vec::with_capacity(body.len() + 4);
    packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(&body);
    packet
}

fn protocol_response_contains_error(response: &[u8]) -> bool {
    let mut cursor = 0usize;
    while cursor + 5 <= response.len() {
        let tag = response[cursor];
        let len = i32::from_be_bytes(response[cursor + 1..cursor + 5].try_into().unwrap());
        if len < 4 {
            return false;
        }
        let total = 1usize.saturating_add(len as usize);
        if cursor + total > response.len() {
            return false;
        }
        if tag == b'E' {
            return true;
        }
        cursor += total;
    }
    false
}

fn format_output_tail(bytes: &[u8]) -> String {
    const LIMIT: usize = 512;
    let skipped = bytes.len().saturating_sub(LIMIT);
    let tail = &bytes[skipped..];
    let mut hex = String::new();
    for (index, byte) in tail.iter().enumerate() {
        if index > 0 {
            hex.push(' ');
        }
        hex.push_str(&format!("{byte:02x}"));
    }
    let text = String::from_utf8_lossy(tail);
    format!(
        "{} bytes total, showing last {} bytes\nhex: {hex}\nutf8-lossy:\n{text}",
        bytes.len(),
        tail.len()
    )
}

fn seed_exported_c_string_value(
    store: &mut Store,
    instance: &Instance,
    env: &WasiFunctionEnv,
    name: &str,
    value: &str,
) -> Result<()> {
    let Ok(global) = instance.exports.get_global(name) else {
        return Ok(());
    };
    let wasmer::Value::I32(ptr) = global.get(&mut *store) else {
        return Ok(());
    };
    if ptr <= 0 {
        return Ok(());
    }
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    let view = env
        .data(&*store)
        .try_memory_view(&*store)
        .context("get WASIX memory view")?;
    view.write(ptr as u64, &bytes)
        .with_context(|| format!("seed {name} at 0x{ptr:x}"))?;
    Ok(())
}

fn summarize_protocol(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "0 bytes".to_owned();
    }

    let mut cursor = 0usize;
    let mut messages = Vec::new();
    while cursor + 5 <= bytes.len() {
        let tag = bytes[cursor] as char;
        let len = i32::from_be_bytes([
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
            bytes[cursor + 4],
        ]);
        if len < 4 {
            messages.push(format!("{tag}(bad-len:{len})"));
            break;
        }
        let end = cursor + 1 + len as usize;
        if end > bytes.len() {
            messages.push(format!("{tag}(truncated:{len})"));
            break;
        }
        if tag == 'E' {
            messages.push(summarize_error_response(&bytes[cursor + 5..end]));
        } else {
            messages.push(format!("{tag}({} bytes)", len - 4));
        }
        cursor = end;
    }
    if cursor < bytes.len() {
        messages.push(format!("tail:{} bytes", bytes.len() - cursor));
    }
    format!("{} bytes [{}]", bytes.len(), messages.join(", "))
}

fn summarize_error_response(body: &[u8]) -> String {
    let mut cursor = 0usize;
    let mut severity = None;
    let mut verbose_severity = None;
    let mut code = None;
    let mut message = None;
    while cursor < body.len() {
        let tag = body[cursor];
        cursor += 1;
        if tag == 0 {
            break;
        }
        let Some(end) = body[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
        else {
            break;
        };
        let value = String::from_utf8_lossy(&body[cursor..end]);
        match tag {
            b'S' => severity = Some(value.into_owned()),
            b'V' => verbose_severity = Some(value.into_owned()),
            b'C' => code = Some(value.into_owned()),
            b'M' => message = Some(value.into_owned()),
            _ => {}
        }
        cursor = end + 1;
    }

    let mut fields = Vec::new();
    if let Some(severity) = verbose_severity.or(severity) {
        fields.push(format!("severity={severity:?}"));
    }
    if let Some(code) = code {
        fields.push(format!("code={code:?}"));
    }
    if let Some(message) = message {
        fields.push(format!("message={message:?}"));
    }
    if fields.is_empty() {
        format!("E({} bytes)", body.len())
    } else {
        format!("E({})", fields.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::pin::Pin;

    #[test]
    fn postgres_argv_delimits_an_option_like_database_name() -> Result<()> {
        let startup = StartupConfig {
            database: "--io-method=worker".to_owned(),
            ..StartupConfig::default()
        };

        let args = oliphaunt_args(&PostgresConfig::default(), &startup, false)?;

        assert!(
            args.windows(2)
                .any(|tail| tail == ["--", "--io-method=worker"])
        );
        Ok(())
    }

    #[test]
    fn split_initdb_selects_exact_collation_profile_environment() {
        assert_eq!(
            split_initdb_profile_environment(false),
            vec![(SKIP_ICU_COLLATION_DISCOVERY_ENV, "1")]
        );
        assert_eq!(
            split_initdb_profile_environment(true),
            vec![
                ("ICU_DATA", ICU_DATA_DIR),
                ("OLIPHAUNT_INTERNAL_ICU_READY", "1"),
            ]
        );
    }

    #[test]
    fn startup_error_summary_includes_postgres_fields() {
        let response = crate::oliphaunt::wire::error_response(
            "PANIC",
            "42501",
            "could not flush dirty data: Permission denied",
        );

        assert_eq!(
            summarize_protocol(&response),
            "74 bytes [E(severity=\"PANIC\", code=\"42501\", message=\"could not flush dirty data: Permission denied\")]"
        );
    }

    #[test]
    fn protocol_stdio_fails_closed_when_detached() -> Result<()> {
        use std::task::{Context, Poll, Waker};
        use wasmer_wasix::VirtualFile;
        use wasmer_wasix::virtual_fs::AsyncWrite;

        let mut file = ProtocolStdioFile::new();
        let mut cx = Context::from_waker(Waker::noop());

        match Pin::new(&mut file).poll_write_ready(&mut cx) {
            Poll::Ready(Err(err)) => assert_eq!(err.kind(), io::ErrorKind::BrokenPipe),
            other => panic!("unexpected detached write-ready result: {other:?}"),
        }
        match Pin::new(&mut file).poll_write(&mut cx, b"lost bytes") {
            Poll::Ready(Err(err)) => assert_eq!(err.kind(), io::ErrorKind::BrokenPipe),
            other => panic!("unexpected detached write result: {other:?}"),
        }
        match Pin::new(&mut file).poll_flush(&mut cx) {
            Poll::Ready(Err(err)) => assert_eq!(err.kind(), io::ErrorKind::BrokenPipe),
            other => panic!("unexpected detached flush result: {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn block_on_tokio_runtime_works_inside_tokio_runtime() -> Result<()> {
        let worker = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let host = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;

        let value = host.block_on(async { block_on_tokio_runtime(&worker, async { 42 }) });

        assert_eq!(value, 42);
        Ok(())
    }

    #[test]
    fn mountfs_root_filesystem_routes_standalone_pgdata_as_mutable_subtree() -> Result<()> {
        use tokio::io::AsyncWriteExt;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _guard = runtime.enter();
        let temp = tempfile::TempDir::new()?;
        let runtime_root = temp.path().join("runtime");
        let pgdata = runtime_root.join("base");
        fs::create_dir_all(pgdata.join("global"))?;
        fs::write(pgdata.join("PG_VERSION"), b"18\n")?;
        fs::write(pgdata.join("global/pg_control"), b"control\n")?;

        let root = wasi_root_with_pgdata_mount(
            host_filesystem(&runtime_root)?,
            host_filesystem(&pgdata)?,
        )?;

        virtual_fs::FileSystem::metadata(root.as_ref(), Path::new("/base/PG_VERSION"))?;
        let mut entries =
            virtual_fs::FileSystem::read_dir(root.as_ref(), Path::new("/base/global"))?;
        let entry = entries.next().transpose()?.context("expected pg_control")?;
        assert_eq!(entry.path, Path::new("/base/global/pg_control"));

        let mut lock_file = virtual_fs::FileSystem::new_open_options(root.as_ref())
            .read(true)
            .write(true)
            .create_new(true)
            .open("/base/postmaster.pid")?;
        runtime.block_on(async {
            lock_file.write_all(b"lock\n").await?;
            lock_file.flush().await
        })?;

        assert_eq!(fs::read_to_string(pgdata.join("postmaster.pid"))?, "lock\n");
        Ok(())
    }
}
