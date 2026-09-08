use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use tokio::runtime::Runtime as TokioRuntime;
use tracing::debug;
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

use super::protocol_limits_generated::BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES;
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
const OLIPHAUNT_EXIT_STARTUP_REJECTED: i32 = 98;
const OLIPHAUNT_EXIT_ALIVE: i32 = 99;
const STARTUP_OUTCOME_ABI_VERSION: u32 = 1;
const STARTUP_OUTCOME_DESCRIPTOR_SIZE: usize = 32;
// Reject corrupt startup descriptors before reading guest memory. This bounds
// diagnostic output only, not query results; match the startup ABI in bridge.c.
const STARTUP_OUTCOME_MAX_PROTOCOL_BYTES: u64 = 1024 * 1024;
const STARTUP_OUTCOME_PENDING: u32 = 0;
const STARTUP_OUTCOME_REJECTED: u32 = 1;
// Retain only the latest startup/tool diagnostics per stream. Larger tails help
// debugging but increase per-instance retention; they never limit SQL output.
const DIAGNOSTIC_TAIL_BYTES: usize = 8 * 1024;

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
    terminal_failure: Option<String>,
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

    fn into_error(self) -> anyhow::Error {
        let diagnostic = (|| {
            let mut input = self.output.as_slice();
            while !input.is_empty() {
                let (tag, body, rest) = crate::oliphaunt::query::read_backend_message(input)?;
                if tag == b'E' {
                    return crate::oliphaunt::query::parse_postgres_error(body);
                }
                input = rest;
            }
            anyhow::bail!("startup response has no PostgreSQL ErrorResponse")
        })();
        // Keep both typed identities: SDK callers get SQLSTATE/details, while
        // the proxy can still forward the original startup response bytes.
        diagnostic
            .map_or_else(|error| error, anyhow::Error::new)
            .context(self)
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
    /// Stream output for a finite buffered request without waiting for COPY.
    OutputStream,
    /// Return after PostgreSQL completes the COPY command that activated the stream.
    #[cfg_attr(not(feature = "tools"), allow(dead_code))]
    Copy,
    /// Keep pumping until the frontend connection ends.
    Connection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainLoopOutcome {
    Processed,
    Recovered,
    InputEnded,
}

impl MainLoopOutcome {
    fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Processed),
            1 => Some(Self::Recovered),
            2 => Some(Self::InputEnded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolTransportMode {
    Buffered = 0,
    Stream = 1,
    Hybrid = 2,
    BufferedInputStreamedOutput = 3,
}

impl ProtocolTransportMode {
    fn from_i32(value: i32) -> Result<Self> {
        match value {
            0 => Ok(Self::Buffered),
            1 => Ok(Self::Stream),
            2 => Ok(Self::Hybrid),
            3 => Ok(Self::BufferedInputStreamedOutput),
            other => anyhow::bail!("invalid WASIX protocol transport mode {other}"),
        }
    }
}

impl ProtocolPumpScope {
    fn transport_mode(self) -> ProtocolTransportMode {
        match self {
            Self::OutputStream => ProtocolTransportMode::BufferedInputStreamedOutput,
            Self::Copy | Self::Connection => ProtocolTransportMode::Hybrid,
        }
    }
}

struct OliphauntLifecycleExports {
    prepare_trusted_embedded_session: TypedFunction<(), i32>,
    startup_outcome_ptr: i32,
    wasi_start: TypedFunction<(), ()>,
    set_active: TypedFunction<i32, i32>,
    start_oliphaunt: TypedFunction<(), ()>,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    run_atexit_funcs: Option<TypedFunction<(), ()>>,
}

struct WasixProtocolExports {
    get_port: TypedFunction<(), i32>,
    process_startup: TypedFunction<(i32, i32, i32), i32>,
    send_conn_data: TypedFunction<(), ()>,
    pq_flush: TypedFunction<(), i32>,
    pq_buffer_remaining_data: TypedFunction<(), i32>,
    main_loop: TypedFunction<(), i32>,
    send_ready: TypedFunction<(), ()>,
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
        validate_pending_startup_outcome(&store, &env, lifecycle.startup_outcome_ptr)?;

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
            terminal_failure: None,
        };
        Ok(pg)
    }

    pub(crate) fn ensure_cluster(&mut self) -> Result<()> {
        self.ensure_not_terminal()?;
        self.initialize_cluster()?;
        self.start_backend()
    }

    pub fn initialize_cluster(&mut self) -> Result<()> {
        self.ensure_not_terminal()?;
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
        self.ensure_not_terminal()?;
        if self.backend_started {
            return Ok(());
        }
        {
            self.lifecycle
                .set_active
                .call(&mut self.store, 1)
                .context("oliphaunt_wasix_set_active(1)")?;
        }
        {
            let prepare_status = self
                .lifecycle
                .prepare_trusted_embedded_session
                .call(&mut self.store)
                .context("oliphaunt_wasix_prepare_trusted_embedded_session")?;
            ensure!(
                prepare_status == 0,
                "oliphaunt_wasix_prepare_trusted_embedded_session rejected after PostgreSQL startup began"
            );
        }
        {
            match self.lifecycle.wasi_start.call(&mut self.store) {
                Ok(()) => {
                    let failure = format!(
                        "_start returned without an Oliphaunt lifecycle exit{}",
                        self.startup_failure_detail()
                    );
                    self.poison_main_loop(failure.clone());
                    return Err(anyhow::anyhow!("{failure}; the backend is closed"));
                }
                Err(err) if runtime_error_exit_code(&err) == Some(OLIPHAUNT_EXIT_ALIVE) => {}
                Err(err)
                    if runtime_error_exit_code(&err) == Some(OLIPHAUNT_EXIT_STARTUP_REJECTED) =>
                {
                    return self.atomic_startup_rejection(err);
                }
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

    fn startup_failure(&mut self, err: wasmer::RuntimeError, context: &str) -> Result<()> {
        let failure = format!("{context}{}", self.startup_failure_detail());
        self.poison_main_loop(failure.clone());
        Err(anyhow::Error::from(err).context(format!("{failure}; the backend is closed")))
    }

    fn atomic_startup_rejection(&mut self, exit: wasmer::RuntimeError) -> Result<()> {
        match read_rejected_startup_outcome(
            &self.store,
            &self.env,
            self.lifecycle.startup_outcome_ptr,
        ) {
            Ok(output) => {
                let rejection = StartupErrorResponse::new(output);
                self.poison_main_loop(rejection.to_string());
                Err(rejection.into_error())
            }
            Err(error) => {
                let failure = format!(
                    "_start returned controlled startup-rejection exit {OLIPHAUNT_EXIT_STARTUP_REJECTED}, but its atomic outcome was invalid: {error}{}",
                    self.startup_failure_detail()
                );
                self.poison_main_loop(failure.clone());
                Err(error.context(format!(
                    "{failure}; original runtime error: {exit}; the backend is closed"
                )))
            }
        }
    }

    fn startup_failure_detail(&self) -> String {
        let mut detail = String::new();
        let stderr = self.wasi_stderr.text();
        if !stderr.trim().is_empty() {
            detail.push_str("\nWASIX stderr tail:\n");
            detail.push_str(stderr.trim_end());
        }
        detail
    }

    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    pub(crate) fn shutdown_backend(&mut self) -> Result<()> {
        self.ensure_not_terminal()?;
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
        self.ensure_not_terminal()?;
        validate_protocol_input_length(payload.len())?;
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
        self.ensure_not_terminal()?;
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
        self.ensure_not_terminal()?;
        validate_protocol_input_length(payload.len())?;
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
        let transport_mode = scope.transport_mode();
        let previous_mode = self.set_protocol_transport(transport_mode)?;
        if previous_mode != ProtocolTransportMode::Buffered {
            return Err(self.terminal_guest_failure(
                "WASIX protocol transport was not buffered before protocol pump",
            ));
        }
        let result = self.send_protocol_inner(payload);
        if let Some(failure) = self.terminal_failure.as_ref() {
            // The main loop failed before a streaming continuation could be
            // trusted. Propagate its terminal result without another guest call.
            return match result {
                Err(error) => Err(error),
                Ok(_) => Err(anyhow::anyhow!(
                    "WASIX protocol pump entered terminal state without an error result: {failure}; the backend is closed"
                )),
            };
        }
        if scope == ProtocolPumpScope::OutputStream {
            let execution = result.and_then(|output| {
                if output.is_empty() {
                    Ok(())
                } else {
                    Err(self.terminal_guest_failure(format!(
                        "buffered-input/streamed-output transport retained {} buffered response bytes",
                        output.len()
                    )))
                }
            });
            let restore_result = if self.terminal_failure.is_some() {
                // A transport contract violation makes guest state untrustworthy.
                Ok(())
            } else {
                self.restore_protocol_transport(previous_mode, transport_mode)
            };
            execution.and(restore_result)?;
            return Ok(ProtocolPumpOutcome::Streamed);
        }
        let active = self.protocol_stream_active()?;
        if active {
            let stream_result = match scope {
                ProtocolPumpScope::OutputStream => {
                    unreachable!("one-way output stream handled before COPY activation")
                }
                // The triggering PostgresMainLoopOnce call synchronously completes
                // COPY. Starting another iteration would consume the next frontend
                // frame (normally Terminate) as part of the borrowed session.
                ProtocolPumpScope::Copy => result.map(|_| ()),
                ProtocolPumpScope::Connection => result.and_then(|_| {
                    self.set_protocol_stream_prefix(continuation_prefix())?;
                    self.serve_protocol_stream_inner()
                }),
            };
            let restore_result = if self.terminal_failure.is_some() {
                // A terminal streaming result can leave arbitrary guest state.
                // Clear host-owned state below, but do not call a guest export.
                Ok(())
            } else {
                self.restore_protocol_transport(previous_mode, transport_mode)
            };
            let clear_result = self.clear_protocol_stream_prefix();
            stream_result.and(restore_result).and(clear_result)?;
            Ok(ProtocolPumpOutcome::Streamed)
        } else {
            let output = result;
            let restore_result = self.restore_protocol_transport(previous_mode, transport_mode);
            restore_result?;
            let output = output?;
            Ok(ProtocolPumpOutcome::Buffered(output))
        }
    }

    fn send_protocol_inner(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        self.run_guest_phase("buffered protocol dispatch", |pg| {
            pg.dispatch_buffered_protocol(payload)
        })
    }

    fn dispatch_buffered_protocol(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        {
            self.io.reset(&mut self.store)?;
        }
        {
            self.io.push_input(&mut self.store, &self.env, payload)?;
        }

        {
            let max_attempts = (payload.len() / 5).saturating_add(2).max(1);
            let mut attempts = 0usize;
            while self.protocol_input_remaining()? > 0 {
                attempts += 1;
                ensure!(
                    attempts <= max_attempts,
                    "Postgres protocol dispatch did not drain buffered input after {attempts} attempts"
                );
                let status = match self.protocol.main_loop.call(&mut self.store) {
                    Ok(status) => status,
                    Err(err) => return Err(self.terminal_main_loop_error(err)),
                };
                match self.decode_main_loop_outcome(status)? {
                    MainLoopOutcome::Processed => {}
                    MainLoopOutcome::Recovered => {
                        // The guest already ran PostgreSQL's top-level cleanup.
                        // Keep pumping so an extended-protocol Sync already in
                        // this buffer is consumed before ReadyForQuery is sent.
                        debug!(
                            "PostgresMainLoopOnce recovered a PostgreSQL error inside the guest"
                        );
                    }
                    MainLoopOutcome::InputEnded => {
                        return Err(self.terminal_main_loop_outcome(
                            "PostgresMainLoopOnce reported input end while dispatching buffered protocol input",
                        ));
                    }
                }
            }

            self.finish_main_loop_output("after buffered protocol dispatch")?;
            let output = self.take_buffered_protocol_output("after protocol dispatch")?;
            Ok(output)
        }
    }

    pub(crate) fn supports_streaming_protocol(&self) -> bool {
        self.protocol_stdio.is_some()
    }

    fn serve_protocol_stream_inner(&mut self) -> Result<()> {
        loop {
            let status = match self.protocol.main_loop.call(&mut self.store) {
                Ok(status) => status,
                Err(err) => return Err(self.terminal_main_loop_error(err)),
            };
            match self.decode_main_loop_outcome(status)? {
                MainLoopOutcome::Processed => {}
                MainLoopOutcome::Recovered => {
                    // Recovery and ErrorResponse production completed before
                    // the typed return; only ReadyForQuery and flushing remain.
                    debug!(
                        "PostgresMainLoopOnce recovered a PostgreSQL error while serving streaming protocol"
                    );
                }
                MainLoopOutcome::InputEnded => break,
            }
            self.finish_main_loop_output("while serving streaming protocol")?;
        }
        Ok(())
    }

    fn set_protocol_transport(
        &mut self,
        mode: ProtocolTransportMode,
    ) -> Result<ProtocolTransportMode> {
        ensure!(
            self.protocol_stdio.is_some(),
            "WASIX runtime does not export protocol stdio switching"
        );
        self.run_guest_phase("set protocol transport", |pg| {
            let stdio = pg.protocol_stdio.as_ref().expect("checked protocol stdio");
            let previous = stdio
                .set_protocol_transport
                .call(&mut pg.store, mode as i32)
                .context("oliphaunt_wasix_set_protocol_transport")?;
            ProtocolTransportMode::from_i32(previous)
        })
    }

    fn restore_protocol_transport(
        &mut self,
        previous_mode: ProtocolTransportMode,
        expected_current: ProtocolTransportMode,
    ) -> Result<()> {
        self.run_guest_phase("restore protocol transport", |pg| {
            let current = pg.set_protocol_transport(previous_mode)?;
            ensure!(
                current == expected_current,
                "oliphaunt_wasix_set_protocol_transport restore observed unexpected current mode {current:?}, expected {expected_current:?}"
            );
            Ok(())
        })
    }

    fn protocol_stream_active(&mut self) -> Result<bool> {
        self.run_guest_phase("read protocol stream state", |pg| {
            let stdio = pg
                .protocol_stdio
                .as_ref()
                .context("WASIX runtime does not export protocol stream state")?;
            let active = stdio
                .protocol_stream_active
                .call(&mut pg.store)
                .context("oliphaunt_wasix_protocol_stream_active")?;
            match active {
                0 => Ok(false),
                1 => Ok(true),
                other => anyhow::bail!("invalid WASIX protocol stream state {other}"),
            }
        })
    }

    fn start_protocol(&mut self) -> Result<()> {
        self.ensure_not_terminal()?;
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
        self.ensure_not_terminal()?;
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
            self.flush_protocol_output("after rejected startup")?;
            let output = self.take_buffered_protocol_output("after rejected protocol startup")?;
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
            self.flush_protocol_output("after accepted startup")?;
            self.take_buffered_protocol_output("after accepted protocol startup")?
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

    fn ensure_not_terminal(&self) -> Result<()> {
        ensure_guest_phase_live(self.terminal_failure.as_deref())
    }

    fn run_guest_phase<T>(
        &mut self,
        phase: &str,
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        self.ensure_not_terminal()?;
        let result = operation(self);
        finish_guest_phase(result, phase, |failure| {
            if self.terminal_failure.is_none() {
                self.poison_main_loop(failure);
            }
        })
    }

    fn decode_main_loop_outcome(&mut self, status: i32) -> Result<MainLoopOutcome> {
        MainLoopOutcome::from_i32(status).ok_or_else(|| {
            self.terminal_main_loop_outcome(format!(
                "PostgresMainLoopOnce returned invalid typed outcome {status}"
            ))
        })
    }

    fn terminal_main_loop_outcome(&mut self, failure: impl Into<String>) -> anyhow::Error {
        self.terminal_guest_failure(failure)
    }

    fn terminal_guest_failure(&mut self, failure: impl Into<String>) -> anyhow::Error {
        let failure = failure.into();
        self.poison_main_loop(failure.clone());
        anyhow::anyhow!("{failure}; the backend is closed")
    }

    fn take_buffered_protocol_output(&mut self, phase: &str) -> Result<Vec<u8>> {
        match self.io.take_output(&mut self.store, &self.env) {
            Ok(output) => Ok(output),
            Err(error) => {
                let failure =
                    format!("failed to take bounded WASIX protocol output {phase}: {error:#}");
                self.poison_main_loop(failure.clone());
                Err(error.context(format!("{failure}; the backend is closed")))
            }
        }
    }

    fn terminal_main_loop_error(&mut self, err: wasmer::RuntimeError) -> anyhow::Error {
        let failure =
            "PostgresMainLoopOnce trapped instead of returning a typed outcome".to_owned();
        self.poison_main_loop(failure.clone());
        anyhow::Error::from(err).context(format!("{failure}; the backend is closed"))
    }

    fn finish_main_loop_output(&mut self, phase: &str) -> Result<()> {
        if let Err(err) = self.protocol.send_ready.call(&mut self.store) {
            return Err(self.terminal_post_step_export_error(
                "PostgresSendReadyForQueryIfNecessary",
                phase,
                err,
            ));
        }
        self.flush_protocol_output(phase)
    }

    fn flush_protocol_output(&mut self, phase: &str) -> Result<()> {
        let status = match self.protocol.pq_flush.call(&mut self.store) {
            Ok(status) => status,
            Err(err) => {
                return Err(self.terminal_post_step_export_error(
                    "oliphaunt_wasix_pq_flush",
                    phase,
                    err,
                ));
            }
        };
        if status != 0 {
            return Err(self.terminal_guest_failure(format!(
                "oliphaunt_wasix_pq_flush returned failure status {status} {phase}"
            )));
        }
        Ok(())
    }

    fn terminal_post_step_export_error(
        &mut self,
        export: &str,
        phase: &str,
        err: wasmer::RuntimeError,
    ) -> anyhow::Error {
        let failure = match runtime_error_exit_code(&err) {
            Some(code) => format!("{export} failed {phase} with WASI exit code {code}"),
            None => format!(
                "{export} trapped {phase} outside the live PostgreSQL main-loop recovery boundary"
            ),
        };
        self.poison_main_loop(failure.clone());
        anyhow::Error::from(err).context(format!("{failure}; the backend is closed"))
    }

    fn poison_main_loop(&mut self, failure: String) {
        // A trap or invalid outcome can leave arbitrary guest state behind. Mark
        // the host terminal without invoking another guest export, including
        // shutdown or a separate recovery entry point.
        self.terminal_failure = Some(failure);
        self.backend_started = false;
        self.started = false;
        self.startup_response = None;
    }

    fn protocol_input_remaining(&mut self) -> Result<i32> {
        let host_remaining = self.io.available(&mut self.store)?;
        if host_remaining > 0 {
            return Ok(host_remaining);
        }
        let buffered = self
            .protocol
            .pq_buffer_remaining_data
            .call(&mut self.store)
            .context("pq_buffer_remaining_data")?;
        ensure!(
            buffered >= 0,
            "pq_buffer_remaining_data returned negative length {buffered}"
        );
        Ok(buffered)
    }
}

fn validate_protocol_input_length(length: usize) -> Result<()> {
    i32::try_from(length).context("protocol input exceeds i32")?;
    Ok(())
}

fn ensure_guest_phase_live(terminal_failure: Option<&str>) -> Result<()> {
    if let Some(failure) = terminal_failure {
        anyhow::bail!(
            "Oliphaunt WASIX PostgreSQL backend cannot be reused after a terminal guest failure: {failure}"
        );
    }
    Ok(())
}

fn finish_guest_phase<T>(result: Result<T>, phase: &str, poison: impl FnOnce(String)) -> Result<T> {
    result.map_err(|error| {
        let failure = format!("WASIX guest phase {phase} failed: {error:#}");
        poison(failure.clone());
        error.context(format!("{failure}; the backend is closed"))
    })
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

    let (stdout_file, stdout_capture) = TailCaptureFile::new(DIAGNOSTIC_TAIL_BYTES);
    let (stderr_file, stderr_capture) = TailCaptureFile::new(DIAGNOSTIC_TAIL_BYTES);

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
        let prepare_trusted_embedded_session = typed_export(
            store,
            instance,
            "oliphaunt_wasix_prepare_trusted_embedded_session",
        )?;
        let startup_outcome =
            typed_export::<(), i32>(store, instance, "oliphaunt_wasix_startup_outcome_v1")?;
        let startup_outcome_ptr = startup_outcome
            .call(&mut *store)
            .context("oliphaunt_wasix_startup_outcome_v1")?;
        ensure!(
            startup_outcome_ptr != 0,
            "oliphaunt_wasix_startup_outcome_v1 returned null"
        );
        let wasi_start = typed_export(store, instance, "_start")?;
        let set_active = typed_export(store, instance, "oliphaunt_wasix_set_active")?;
        let start_oliphaunt = typed_export(store, instance, "oliphaunt_wasix_start")?;
        let run_atexit_funcs =
            optional_typed_export(store, instance, "oliphaunt_wasix_run_atexit_funcs")?;

        Ok(Self {
            prepare_trusted_embedded_session,
            startup_outcome_ptr,
            wasi_start,
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

        Ok(Self {
            get_port,
            process_startup,
            send_conn_data,
            pq_flush,
            pq_buffer_remaining_data,
            main_loop,
            send_ready,
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
        "oliphaunt_wasix_prepare_trusted_embedded_session",
        "oliphaunt_wasix_startup_outcome_v1",
        "oliphaunt_wasix_start",
        "oliphaunt_wasix_set_active",
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
        let guest_len = self
            .output_len
            .call(&mut *store)
            .context("oliphaunt_wasix_output_len")?;
        let len = checked_buffered_protocol_output_len(guest_len)?;
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
        let mut bytes = allocate_zeroed_buffered_protocol_output(len)?;
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
}

fn checked_buffered_protocol_output_len(guest_len: i32) -> Result<usize> {
    let len = usize::try_from(guest_len).with_context(|| {
        format!("oliphaunt_wasix_output_len returned invalid length {guest_len}")
    })?;
    ensure!(
        len <= BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES,
        "buffered WASIX protocol output is {len} bytes, exceeding the inclusive {}-byte host limit",
        BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES
    );
    Ok(len)
}

fn allocate_zeroed_buffered_protocol_output(len: usize) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(len)
        .context("reserve bounded WASIX protocol output")?;
    output.resize(len, 0);
    Ok(output)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartupOutcomeDescriptor {
    kind: u32,
    protocol_ptr: u64,
    protocol_len: u64,
}

fn decode_startup_outcome_descriptor(bytes: &[u8]) -> Result<StartupOutcomeDescriptor> {
    ensure!(
        bytes.len() == STARTUP_OUTCOME_DESCRIPTOR_SIZE,
        "startup outcome descriptor has {} bytes, expected {STARTUP_OUTCOME_DESCRIPTOR_SIZE}",
        bytes.len()
    );
    let field = |offset: usize| {
        u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("fixed startup outcome u32 field"),
        )
    };
    let wide_field = |offset: usize| {
        u64::from_le_bytes(
            bytes[offset..offset + 8]
                .try_into()
                .expect("fixed startup outcome u64 field"),
        )
    };
    let version = field(0);
    let byte_size = field(4);
    let kind = field(8);
    let reserved = field(12);
    ensure!(
        version == STARTUP_OUTCOME_ABI_VERSION,
        "startup outcome ABI version {version}, expected {STARTUP_OUTCOME_ABI_VERSION}"
    );
    ensure!(
        byte_size as usize == STARTUP_OUTCOME_DESCRIPTOR_SIZE,
        "startup outcome descriptor size {byte_size}, expected {STARTUP_OUTCOME_DESCRIPTOR_SIZE}"
    );
    ensure!(reserved == 0, "startup outcome reserved field is nonzero");
    Ok(StartupOutcomeDescriptor {
        kind,
        protocol_ptr: wide_field(16),
        protocol_len: wide_field(24),
    })
}

fn read_startup_outcome_descriptor(
    store: &Store,
    env: &WasiFunctionEnv,
    descriptor_ptr: i32,
) -> Result<StartupOutcomeDescriptor> {
    ensure!(
        descriptor_ptr != 0,
        "startup outcome descriptor pointer is null"
    );
    let descriptor_ptr = descriptor_ptr as u32 as u64;
    let view = env
        .data(store)
        .try_memory_view(store)
        .context("get WASIX memory view for startup outcome")?;
    let descriptor_end = descriptor_ptr
        .checked_add(STARTUP_OUTCOME_DESCRIPTOR_SIZE as u64)
        .context("startup outcome descriptor address overflow")?;
    ensure!(
        descriptor_end <= view.data_size(),
        "startup outcome descriptor is outside guest memory"
    );
    let mut bytes = [0u8; STARTUP_OUTCOME_DESCRIPTOR_SIZE];
    view.read(descriptor_ptr, &mut bytes)
        .context("read startup outcome descriptor")?;
    decode_startup_outcome_descriptor(&bytes)
}

fn validate_pending_startup_outcome(
    store: &Store,
    env: &WasiFunctionEnv,
    descriptor_ptr: i32,
) -> Result<()> {
    let descriptor = read_startup_outcome_descriptor(store, env, descriptor_ptr)?;
    ensure!(
        descriptor.kind == STARTUP_OUTCOME_PENDING,
        "startup outcome was not pending before _start"
    );
    ensure!(
        descriptor.protocol_ptr == 0 && descriptor.protocol_len == 0,
        "pending startup outcome exposed protocol bytes"
    );
    Ok(())
}

fn read_rejected_startup_outcome(
    store: &Store,
    env: &WasiFunctionEnv,
    descriptor_ptr: i32,
) -> Result<Vec<u8>> {
    let descriptor = read_startup_outcome_descriptor(store, env, descriptor_ptr)?;
    ensure!(
        descriptor.kind == STARTUP_OUTCOME_REJECTED,
        "startup outcome kind {} is not rejected",
        descriptor.kind
    );
    ensure!(
        descriptor.protocol_ptr != 0 && descriptor.protocol_len != 0,
        "rejected startup outcome has no protocol bytes"
    );
    ensure!(
        descriptor.protocol_len <= STARTUP_OUTCOME_MAX_PROTOCOL_BYTES,
        "startup rejection protocol response exceeds the {}-byte host limit",
        STARTUP_OUTCOME_MAX_PROTOCOL_BYTES
    );
    let view = env
        .data(store)
        .try_memory_view(store)
        .context("get WASIX memory view for startup rejection")?;
    let protocol_end = descriptor
        .protocol_ptr
        .checked_add(descriptor.protocol_len)
        .context("startup rejection protocol address overflow")?;
    ensure!(
        protocol_end <= view.data_size(),
        "startup rejection protocol response is outside guest memory"
    );
    let protocol_len = descriptor.protocol_len as usize;
    let mut output = Vec::new();
    output
        .try_reserve_exact(protocol_len)
        .context("reserve startup rejection protocol response")?;
    output.resize(protocol_len, 0);
    view.read(descriptor.protocol_ptr, &mut output)
        .context("read atomic startup rejection protocol response")?;
    ensure!(
        complete_protocol_response_contains_error(&output),
        "atomic startup rejection is not a complete PostgreSQL response containing ErrorResponse"
    );
    Ok(output)
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

fn complete_protocol_response_contains_error(response: &[u8]) -> bool {
    let mut cursor = 0usize;
    let mut contains_error = false;
    while cursor < response.len() {
        let Some(header_end) = cursor.checked_add(5) else {
            return false;
        };
        if header_end > response.len() {
            return false;
        }
        let tag = response[cursor];
        let len = i32::from_be_bytes(
            response[cursor + 1..cursor + 5]
                .try_into()
                .expect("checked protocol length field"),
        );
        if len < 4 {
            return false;
        }
        let Some(next) = cursor.checked_add(1 + len as usize) else {
            return false;
        };
        if next > response.len() {
            return false;
        }
        if tag == b'E' {
            if !error_response_has_valid_sqlstate(&response[cursor + 5..next]) {
                return false;
            }
            contains_error = true;
        }
        cursor = next;
    }
    contains_error
}

fn error_response_has_valid_sqlstate(fields: &[u8]) -> bool {
    if fields.last() != Some(&0) {
        return false;
    }
    let mut cursor = 0usize;
    let mut contains_sqlstate = false;
    while cursor < fields.len() - 1 {
        let field_type = fields[cursor];
        if field_type == 0 {
            return false;
        }
        cursor += 1;
        let Some(terminator) = fields[cursor..].iter().position(|byte| *byte == 0) else {
            return false;
        };
        if field_type == b'C' {
            if terminator != 5 {
                return false;
            }
            contains_sqlstate = true;
        }
        cursor += terminator + 1;
    }
    cursor == fields.len() - 1 && contains_sqlstate
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
    fn startup_rejection_preserves_public_diagnostic_and_proxy_bytes() {
        let output = crate::oliphaunt::wire::error_response("FATAL", "28000", "login denied");
        let error = StartupErrorResponse::new(output.clone())
            .into_error()
            .context("open database");
        assert_eq!(
            startup_error_response_output(&error),
            Some(output.as_slice())
        );
        let error = crate::Error::from_anyhow(error);
        assert_eq!(error.kind(), crate::ErrorKind::Postgres);
        let diagnostic = error.postgres_error().expect("typed startup error");
        assert_eq!(diagnostic.sqlstate.as_deref(), Some("28000"));
        assert_eq!(diagnostic.message, "login denied");
    }
    #[test]
    fn main_loop_outcome_classification_is_exact() {
        assert_eq!(
            MainLoopOutcome::from_i32(0),
            Some(MainLoopOutcome::Processed)
        );
        assert_eq!(
            MainLoopOutcome::from_i32(1),
            Some(MainLoopOutcome::Recovered)
        );
        assert_eq!(
            MainLoopOutcome::from_i32(2),
            Some(MainLoopOutcome::InputEnded)
        );
        assert_eq!(MainLoopOutcome::from_i32(-1), None);
        assert_eq!(MainLoopOutcome::from_i32(3), None);
        assert_eq!(MainLoopOutcome::from_i32(99), None);
        assert_eq!(MainLoopOutcome::from_i32(100), None);
    }

    #[test]
    fn protocol_transport_modes_and_pump_intent_are_exact() {
        assert_eq!(
            ProtocolTransportMode::from_i32(0).unwrap(),
            ProtocolTransportMode::Buffered
        );
        assert_eq!(
            ProtocolTransportMode::from_i32(1).unwrap(),
            ProtocolTransportMode::Stream
        );
        assert_eq!(
            ProtocolTransportMode::from_i32(2).unwrap(),
            ProtocolTransportMode::Hybrid
        );
        assert_eq!(
            ProtocolTransportMode::from_i32(3).unwrap(),
            ProtocolTransportMode::BufferedInputStreamedOutput
        );
        for invalid in [-1, 4, 99] {
            assert!(ProtocolTransportMode::from_i32(invalid).is_err());
        }

        assert_eq!(
            ProtocolPumpScope::OutputStream.transport_mode(),
            ProtocolTransportMode::BufferedInputStreamedOutput
        );
        assert_eq!(
            ProtocolPumpScope::Copy.transport_mode(),
            ProtocolTransportMode::Hybrid
        );
        assert_eq!(
            ProtocolPumpScope::Connection.transport_mode(),
            ProtocolTransportMode::Hybrid
        );
    }

    #[test]
    fn buffered_protocol_output_length_is_inclusively_bounded() {
        assert_eq!(checked_buffered_protocol_output_len(0).unwrap(), 0);
        assert_eq!(
            checked_buffered_protocol_output_len(
                i32::try_from(BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES).unwrap()
            )
            .unwrap(),
            BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES
        );

        let oversized = checked_buffered_protocol_output_len(
            i32::try_from(BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES + 1).unwrap(),
        )
        .unwrap_err();
        assert!(
            oversized
                .to_string()
                .contains("exceeding the inclusive 67108864-byte host limit")
        );

        let negative = checked_buffered_protocol_output_len(-1).unwrap_err();
        assert!(negative.to_string().contains("invalid length -1"));
    }

    #[test]
    fn buffered_protocol_output_allocation_is_fallible_and_zeroed() {
        let output = allocate_zeroed_buffered_protocol_output(4).unwrap();
        assert_eq!(output, [0, 0, 0, 0]);

        let allocation_failure = allocate_zeroed_buffered_protocol_output(usize::MAX).unwrap_err();
        assert!(
            allocation_failure
                .to_string()
                .contains("reserve bounded WASIX protocol output")
        );
    }

    #[test]
    fn startup_outcome_descriptor_is_versioned_and_exact() -> Result<()> {
        let mut bytes = [0u8; STARTUP_OUTCOME_DESCRIPTOR_SIZE];
        bytes[0..4].copy_from_slice(&STARTUP_OUTCOME_ABI_VERSION.to_le_bytes());
        bytes[4..8].copy_from_slice(&(STARTUP_OUTCOME_DESCRIPTOR_SIZE as u32).to_le_bytes());
        bytes[8..12].copy_from_slice(&STARTUP_OUTCOME_REJECTED.to_le_bytes());
        bytes[16..24].copy_from_slice(&0x1234_u64.to_le_bytes());
        bytes[24..32].copy_from_slice(&0x5678_u64.to_le_bytes());

        assert_eq!(
            decode_startup_outcome_descriptor(&bytes)?,
            StartupOutcomeDescriptor {
                kind: STARTUP_OUTCOME_REJECTED,
                protocol_ptr: 0x1234,
                protocol_len: 0x5678,
            }
        );

        let mut wrong_version = bytes;
        wrong_version[0..4].copy_from_slice(&2_u32.to_le_bytes());
        assert!(
            decode_startup_outcome_descriptor(&wrong_version)
                .unwrap_err()
                .to_string()
                .contains("ABI version 2")
        );
        let mut wrong_size = bytes;
        wrong_size[4..8].copy_from_slice(&24_u32.to_le_bytes());
        assert!(
            decode_startup_outcome_descriptor(&wrong_size)
                .unwrap_err()
                .to_string()
                .contains("descriptor size 24")
        );
        let mut reserved = bytes;
        reserved[12..16].copy_from_slice(&1_u32.to_le_bytes());
        assert!(
            decode_startup_outcome_descriptor(&reserved)
                .unwrap_err()
                .to_string()
                .contains("reserved field")
        );
        Ok(())
    }

    #[test]
    fn atomic_startup_response_requires_complete_protocol_frames_and_error() {
        let error =
            crate::oliphaunt::wire::error_response("FATAL", "3D000", "database does not exist");
        assert!(complete_protocol_response_contains_error(&error));

        let mut notice_then_error = vec![b'N', 0, 0, 0, 5, 0];
        notice_then_error.extend_from_slice(&error);
        assert!(complete_protocol_response_contains_error(
            &notice_then_error
        ));

        let mut trailing = error.clone();
        trailing.push(0xff);
        assert!(!complete_protocol_response_contains_error(&trailing));
        assert!(!complete_protocol_response_contains_error(
            &error[..error.len() - 1]
        ));
        assert!(!complete_protocol_response_contains_error(&[
            b'N', 0, 0, 0, 5, 0
        ]));
        assert!(!complete_protocol_response_contains_error(&[
            b'E', 0, 0, 0, 4
        ]));
        assert!(!complete_protocol_response_contains_error(&[
            b'E', 0, 0, 0, 5, 0
        ]));
        assert!(!complete_protocol_response_contains_error(&[
            b'E', 0, 0, 0, 10, b'C', b'3', b'D', b'0', b'0', 0
        ]));
        assert!(!complete_protocol_response_contains_error(&[
            b'E', 0, 0, 0, 13, b'C', b'3', b'D', b'0', b'0', b'0', b'0', 0, 0
        ]));
        assert!(!complete_protocol_response_contains_error(&[
            b'E', 0, 0, 0, 10, b'C', b'3', b'D', b'0', b'0', b'0'
        ]));
        assert!(!complete_protocol_response_contains_error(&[]));
    }

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
        // Main's initdb patch uses environment policy, not a seed-profile CLI.
        assert!(!split_initdb_args().contains(&"--oliphaunt-seed-profile"));
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
    fn guest_phase_failure_blocks_restore_and_reuse() {
        for phase in [
            "input reset",
            "input reservation",
            "input availability",
            "dispatch progress",
            "set protocol transport",
            "read protocol stream state",
            "restore protocol transport",
        ] {
            let mut terminal = None;
            let mut subsequent_guest_calls = 0;
            let error = finish_guest_phase::<()>(
                Err(anyhow::anyhow!("injected trap or invalid result")),
                phase,
                |failure| terminal = Some(failure),
            )
            .unwrap_err();
            assert!(error.to_string().contains("the backend is closed"));
            assert!(terminal.as_deref().unwrap().contains(phase));
            // Both cleanup restores and future dispatch use this admission gate.
            for _ in 0..2 {
                let attempt = ensure_guest_phase_live(terminal.as_deref()).map(|()| {
                    subsequent_guest_calls += 1;
                });
                assert!(attempt.is_err());
            }
            assert_eq!(subsequent_guest_calls, 0);
        }
    }

    #[test]
    fn successful_guest_phase_and_predispatch_validation_do_not_poison() {
        let mut terminal = None;
        assert_eq!(
            finish_guest_phase(Ok(7), "dispatch", |failure| {
                terminal = Some(failure);
            })
            .unwrap(),
            7
        );
        assert!(terminal.is_none());
        assert!(validate_protocol_input_length(i32::MAX as usize).is_ok());
        assert!(validate_protocol_input_length(i32::MAX as usize + 1).is_err());
        assert!(ensure_guest_phase_live(terminal.as_deref()).is_ok());
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
