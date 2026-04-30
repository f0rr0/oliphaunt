use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::future::Future;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tokio::io::ReadBuf;
use tokio::runtime::Runtime as TokioRuntime;
use tracing::warn;
use wasmer::{Engine, Instance, Module, Store, TypedFunction, WasmTypeList};
use wasmer_types::ModuleHash;
use wasmer_wasix::fs::WasiFsRoot;
use wasmer_wasix::runners::wasi::{PackageOrHash, RuntimeOrEngine, WasiRunner};
use wasmer_wasix::runtime::module_cache::ModuleCache;
use wasmer_wasix::runtime::module_cache::SharedCache;
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
use wasmer_wasix::virtual_fs::null_file::NullFile;
use wasmer_wasix::{WasiError, WasiFunctionEnv, virtual_fs};
use webc::metadata::annotations::Wasi;

use super::aot;
use super::base::{PglitePaths, RuntimeLayout};
#[cfg(feature = "extensions")]
use super::extensions::Extension;
use super::sync_host_fs::SyncHostFileSystem;
use super::timing;

const PGLITE_EXE_PATH: &str = "/bin/pglite";
const PGDATA_DIR: &str = "/base";
const WASM_PREFIX: &str = "/";
const RUNTIME_SIDE_MODULES: &[(&str, &str)] = &[
    ("plpgsql.so", "runtime-support:plpgsql"),
    ("dict_snowball.so", "runtime-support:dict_snowball"),
];
const PGLITE_EXIT_ALIVE: i32 = 99;
const POSTGRES_MAIN_LONGJMP: i32 = 100;
const BACKEND_C_TIMINGS: &[(i32, &str)] = &[
    (1, "postgres.backend.c.main_pre"),
    (2, "postgres.backend.c.restart_single_user_main"),
    (3, "postgres.backend.c.async_single_user_main"),
    (4, "postgres.backend.c.standalone_process"),
    (5, "postgres.backend.c.guc_init"),
    (6, "postgres.backend.c.switch_parse"),
    (7, "postgres.backend.c.config_files"),
    (8, "postgres.backend.c.data_dir_lock"),
    (9, "postgres.backend.c.control_file"),
    (10, "postgres.backend.c.preload_libraries"),
    (11, "postgres.backend.c.shared_memory"),
    (12, "postgres.backend.c.base_init"),
    (13, "postgres.backend.c.init_postgres"),
    (14, "postgres.backend.c.post_init"),
    (15, "postgres.backend.c.message_contexts"),
    (16, "postgres.backend.c.postmaster_environment"),
    (17, "postgres.backend.c.init_proc_phase2"),
    (18, "postgres.backend.c.startup_xlog"),
    (19, "postgres.backend.c.relcache_catcache_init"),
    (20, "postgres.backend.c.transaction_snapshot"),
    (21, "postgres.backend.c.session_user"),
    (22, "postgres.backend.c.database_lookup"),
    (23, "postgres.backend.c.database_lock_recheck"),
    (24, "postgres.backend.c.database_path"),
    (25, "postgres.backend.c.relcache_phase3"),
    (26, "postgres.backend.c.check_my_database"),
    (27, "postgres.backend.c.startup_options"),
    (28, "postgres.backend.c.process_settings"),
    (29, "postgres.backend.c.session_initialization"),
    (30, "postgres.backend.c.session_preload_libraries"),
    (31, "postgres.backend.c.init_max_backends"),
    (32, "postgres.backend.c.create_shared_memory"),
    (33, "postgres.backend.c.init_process"),
    (34, "postgres.backend.c.relation_cache_phase3"),
    (35, "postgres.backend.c.initialize_acl"),
];

static FS_TRACE: FsTraceState = FsTraceState::new();

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsTraceSnapshot {
    enabled: bool,
    open_count: u64,
    read_count: u64,
    read_bytes: u64,
    write_count: u64,
    write_bytes: u64,
    seek_count: u64,
    metadata_count: u64,
    read_dir_count: u64,
    create_dir_count: u64,
    remove_file_count: u64,
    remove_dir_count: u64,
    rename_count: u64,
    set_len_count: u64,
    unlink_count: u64,
    total_elapsed_micros: u64,
    read_elapsed_micros: u64,
    write_elapsed_micros: u64,
    seek_elapsed_micros: u64,
}

struct FsTraceState {
    open_count: AtomicU64,
    read_count: AtomicU64,
    read_bytes: AtomicU64,
    write_count: AtomicU64,
    write_bytes: AtomicU64,
    seek_count: AtomicU64,
    metadata_count: AtomicU64,
    read_dir_count: AtomicU64,
    create_dir_count: AtomicU64,
    remove_file_count: AtomicU64,
    remove_dir_count: AtomicU64,
    rename_count: AtomicU64,
    set_len_count: AtomicU64,
    unlink_count: AtomicU64,
    total_elapsed_micros: AtomicU64,
    read_elapsed_micros: AtomicU64,
    write_elapsed_micros: AtomicU64,
    seek_elapsed_micros: AtomicU64,
}

impl FsTraceState {
    const fn new() -> Self {
        Self {
            open_count: AtomicU64::new(0),
            read_count: AtomicU64::new(0),
            read_bytes: AtomicU64::new(0),
            write_count: AtomicU64::new(0),
            write_bytes: AtomicU64::new(0),
            seek_count: AtomicU64::new(0),
            metadata_count: AtomicU64::new(0),
            read_dir_count: AtomicU64::new(0),
            create_dir_count: AtomicU64::new(0),
            remove_file_count: AtomicU64::new(0),
            remove_dir_count: AtomicU64::new(0),
            rename_count: AtomicU64::new(0),
            set_len_count: AtomicU64::new(0),
            unlink_count: AtomicU64::new(0),
            total_elapsed_micros: AtomicU64::new(0),
            read_elapsed_micros: AtomicU64::new(0),
            write_elapsed_micros: AtomicU64::new(0),
            seek_elapsed_micros: AtomicU64::new(0),
        }
    }

    fn reset(&self) {
        for counter in [
            &self.open_count,
            &self.read_count,
            &self.read_bytes,
            &self.write_count,
            &self.write_bytes,
            &self.seek_count,
            &self.metadata_count,
            &self.read_dir_count,
            &self.create_dir_count,
            &self.remove_file_count,
            &self.remove_dir_count,
            &self.rename_count,
            &self.set_len_count,
            &self.unlink_count,
            &self.total_elapsed_micros,
            &self.read_elapsed_micros,
            &self.write_elapsed_micros,
            &self.seek_elapsed_micros,
        ] {
            counter.store(0, Ordering::Relaxed);
        }
    }

    fn record_total(&self, elapsed: Duration) {
        self.total_elapsed_micros.fetch_add(
            elapsed.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }

    fn snapshot(&self) -> FsTraceSnapshot {
        FsTraceSnapshot {
            enabled: fs_trace_enabled(),
            open_count: self.open_count.load(Ordering::Relaxed),
            read_count: self.read_count.load(Ordering::Relaxed),
            read_bytes: self.read_bytes.load(Ordering::Relaxed),
            write_count: self.write_count.load(Ordering::Relaxed),
            write_bytes: self.write_bytes.load(Ordering::Relaxed),
            seek_count: self.seek_count.load(Ordering::Relaxed),
            metadata_count: self.metadata_count.load(Ordering::Relaxed),
            read_dir_count: self.read_dir_count.load(Ordering::Relaxed),
            create_dir_count: self.create_dir_count.load(Ordering::Relaxed),
            remove_file_count: self.remove_file_count.load(Ordering::Relaxed),
            remove_dir_count: self.remove_dir_count.load(Ordering::Relaxed),
            rename_count: self.rename_count.load(Ordering::Relaxed),
            set_len_count: self.set_len_count.load(Ordering::Relaxed),
            unlink_count: self.unlink_count.load(Ordering::Relaxed),
            total_elapsed_micros: self.total_elapsed_micros.load(Ordering::Relaxed),
            read_elapsed_micros: self.read_elapsed_micros.load(Ordering::Relaxed),
            write_elapsed_micros: self.write_elapsed_micros.load(Ordering::Relaxed),
            seek_elapsed_micros: self.seek_elapsed_micros.load(Ordering::Relaxed),
        }
    }
}

pub fn reset_fs_trace() {
    FS_TRACE.reset();
}

pub fn fs_trace_snapshot() -> FsTraceSnapshot {
    FS_TRACE.snapshot()
}
static WASIX_PROCESS_RUNTIME: OnceLock<std::result::Result<Arc<WasixProcessRuntime>, String>> =
    OnceLock::new();
static SEEDED_SIDE_MODULES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static SEEDED_AOT_ARTIFACTS: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();

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
    malloc: TypedFunction<i32, i32>,
    io: WasixPgliteIo,
    lifecycle: PgliteLifecycleExports,
    protocol: WasixProtocolExports,
    paths: PglitePaths,
    cluster_ready: bool,
    backend_started: bool,
    started: bool,
}

pub(crate) struct StartupProtocolResponse {
    pub(crate) output: Vec<u8>,
    pub(crate) accepted: bool,
}

struct PgliteLifecycleExports {
    wasi_start: TypedFunction<(), ()>,
    set_active: TypedFunction<i32, i32>,
    start_pglite: TypedFunction<(), ()>,
    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    run_atexit_funcs: Option<TypedFunction<(), ()>>,
    backend_timing_reset: Option<TypedFunction<(), ()>>,
    backend_timing_elapsed_us: Option<TypedFunction<i32, i64>>,
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

struct WasixPgliteIo {
    input_reset: TypedFunction<(), i32>,
    input_write: TypedFunction<(i32, i32), i32>,
    input_available: TypedFunction<(), i32>,
    output_reset: TypedFunction<(), i32>,
    output_len: TypedFunction<(), i32>,
    output_read: TypedFunction<(i32, i32), i32>,
}

impl PostgresMod {
    pub(crate) fn preload_module(module_path: &std::path::Path) -> Result<()> {
        let runtime_root = module_path
            .parent()
            .and_then(Path::parent)
            .context("runtime module path must be under bin/pglite")?;
        let (engine, _) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        preload_runtime_side_modules(
            &process_runtime.tokio_runtime,
            &engine,
            &process_runtime.wasix_module_cache,
            runtime_root,
        )
    }

    pub(crate) fn new_prepared(paths: PglitePaths, runtime_layout: RuntimeLayout) -> Result<Self> {
        ensure_runtime_dirs(&paths)?;
        #[cfg(feature = "extensions")]
        let runtime_root = runtime_layout.local_root.clone();
        let module_runtime_root = runtime_layout.module_root.clone();
        ensure!(
            module_runtime_root.join("bin/pglite").exists(),
            "WASIX PGlite executable not found at {}",
            module_runtime_root.join("bin/pglite").display()
        );

        let (engine, module) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        {
            let _phase = timing::phase("wasix.preload_runtime_side_modules");
            preload_runtime_side_modules(
                &process_runtime.tokio_runtime,
                &engine,
                &process_runtime.wasix_module_cache,
                &module_runtime_root,
            )?;
        }
        #[cfg(feature = "extensions")]
        {
            let _phase = timing::phase("wasix.preload_installed_extension_side_modules");
            preload_installed_extension_side_modules(
                &process_runtime.tokio_runtime,
                &engine,
                &process_runtime.wasix_module_cache,
                &runtime_root,
            )?;
        }
        let mut store = Store::new(engine.clone());

        let _phase = timing::phase("wasix.instance_create");
        let (instance, env) = instantiate_wasix_module(
            &process_runtime.tokio_runtime,
            &process_runtime.wasix_runtime,
            &mut store,
            &paths,
            &runtime_layout,
            module.clone(),
        )?;
        seed_exported_c_string_value(&mut store, &instance, &env, "my_exec_path", PGLITE_EXE_PATH)?;

        let (malloc, io, lifecycle, protocol) = {
            let _phase = timing::phase("wasix.export_load");
            let malloc = typed_export::<i32, i32>(&mut store, &instance, "malloc")?;
            let io = WasixPgliteIo::new(&mut store, &instance)?;
            ensure_integrated_pglite_contract(&instance)?;
            let lifecycle = PgliteLifecycleExports::load(&mut store, &instance)?;
            let protocol = WasixProtocolExports::load(&mut store, &instance)?;
            (malloc, io, lifecycle, protocol)
        };

        let pg = Self {
            engine,
            tokio_runtime: process_runtime.tokio_runtime.clone(),
            wasix_module_cache: process_runtime.wasix_module_cache.clone(),
            _wasix_runtime: process_runtime.wasix_runtime.clone(),
            store,
            _instance: instance,
            env,
            malloc,
            io,
            lifecycle,
            protocol,
            paths,
            cluster_ready: false,
            backend_started: false,
            started: false,
        };
        Ok(pg)
    }

    pub fn paths(&self) -> &PglitePaths {
        &self.paths
    }

    pub fn ensure_cluster(&mut self) -> Result<()> {
        self.initialize_cluster()?;
        self.start_backend()
    }

    pub fn initialize_cluster(&mut self) -> Result<()> {
        if self.cluster_ready {
            return Ok(());
        }

        ensure!(
            self.paths.is_cluster_initialized(),
            "PGDATA is not initialized; install the WASIX runtime assets and PGDATA template before opening"
        );
        self.cluster_ready = true;
        Ok(())
    }

    fn start_backend(&mut self) -> Result<()> {
        if self.backend_started {
            return Ok(());
        }
        let _phase = timing::phase("postgres.backend_start");
        if let Some(reset) = &self.lifecycle.backend_timing_reset {
            reset
                .call(&mut self.store)
                .context("pgl_backend_timing_reset")?;
        }
        {
            let _phase = timing::phase("postgres.backend_start.set_active");
            self.lifecycle
                .set_active
                .call(&mut self.store, 1)
                .context("pgl_setPGliteActive(1)")?;
        }
        {
            let _phase = timing::phase("postgres.backend_start.single_user_main");
            match self.lifecycle.wasi_start.call(&mut self.store) {
                Ok(()) => {}
                Err(err) if runtime_error_exit_code(&err) == Some(PGLITE_EXIT_ALIVE) => {}
                Err(err) => return Err(err).context("_start PGlite single-user backend"),
            }
        }
        self.lifecycle
            .start_pglite
            .call(&mut self.store)
            .context("pgl_startPGlite")?;
        self.record_backend_c_timings()?;
        self.backend_started = true;
        Ok(())
    }

    #[cfg_attr(not(feature = "extensions"), allow(dead_code))]
    pub(crate) fn shutdown_backend(&mut self) -> Result<()> {
        let _phase = timing::phase("postgres.backend_shutdown");
        self.lifecycle
            .set_active
            .call(&mut self.store, 0)
            .context("pgl_setPGliteActive(0)")?;
        if let Some(run_atexit_funcs) = &self.lifecycle.run_atexit_funcs {
            run_atexit_funcs
                .call(&mut self.store)
                .context("pgl_run_atexit_funcs")?;
        }
        self.backend_started = false;
        self.started = false;
        self.cluster_ready = false;
        Ok(())
    }

    fn record_backend_c_timings(&mut self) -> Result<()> {
        let Some(elapsed) = &self.lifecycle.backend_timing_elapsed_us else {
            return Ok(());
        };

        for &(id, name) in BACKEND_C_TIMINGS {
            let elapsed_micros = elapsed
                .call(&mut self.store, id)
                .with_context(|| format!("pgl_backend_timing_elapsed_us({id})"))?;
            if elapsed_micros > 0 {
                timing::record_phase_timing(name, Duration::from_micros(elapsed_micros as u64));
            }
        }
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub fn preload_extension_module(&self, extension: Extension) -> Result<()> {
        let runtime_root = self.paths.runtime_root();
        let library = runtime_root
            .join("lib")
            .join("postgresql")
            .join(format!("{}.so", extension.sql_name()));
        ensure!(
            library.exists(),
            "extension library for '{}' is not installed at {}",
            extension.sql_name(),
            library.display()
        );

        seed_side_module_cache(
            &self.tokio_runtime,
            &self.engine,
            &self.wasix_module_cache,
            &library,
            extension.aot_name(),
            &format!("extension '{}'", extension.sql_name()),
        )?;
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_extension_module_from_paths(
        paths: &PglitePaths,
        extension: Extension,
    ) -> Result<()> {
        let runtime_root = paths.runtime_root();
        let library = runtime_root
            .join("lib")
            .join("postgresql")
            .join(format!("{}.so", extension.sql_name()));
        ensure!(
            library.exists(),
            "extension library for '{}' is not installed at {}",
            extension.sql_name(),
            library.display()
        );

        let (engine, _) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        seed_side_module_cache(
            &process_runtime.tokio_runtime,
            &engine,
            &process_runtime.wasix_module_cache,
            &library,
            extension.aot_name(),
            &format!("extension '{}'", extension.sql_name()),
        )
    }

    pub fn send_protocol(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        {
            let _phase = timing::phase("postgres.protocol.ensure_started");
            self.start_protocol()?;
        }
        if payload.is_empty() {
            return Ok(Vec::new());
        }

        {
            let _phase = timing::phase("postgres.protocol.input_reset");
            self.io.reset(&mut self.store)?;
        }
        {
            let _phase = timing::phase("postgres.protocol.input_write");
            self.io
                .push_input(&mut self.store, &self.env, &self.malloc, payload)?;
        }

        {
            let _phase = timing::phase("postgres.protocol.dispatch_buffer");
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
                let _phase = timing::phase("postgres.protocol.send_ready");
                self.protocol
                    .send_ready
                    .call(&mut self.store)
                    .context("PostgresSendReadyForQueryIfNecessary")?;
            }
            {
                let _phase = timing::phase("postgres.protocol.pq_flush");
                self.protocol
                    .pq_flush
                    .call(&mut self.store)
                    .context("pgl_pq_flush after protocol buffer")?;
            }
            let output = {
                let _phase = timing::phase("postgres.protocol.output_read");
                self.io
                    .take_output(&mut self.store, &self.env, &self.malloc)
                    .context("take backend output after protocol buffer")?
            };
            if !recovered_protocol_error && protocol_response_contains_error(&output) {
                self.recover_non_trapping_protocol_error()?;
            }
            Ok(output)
        }
    }

    fn start_protocol(&mut self) -> Result<()> {
        if self.started {
            return Ok(());
        }
        let startup = startup_packet("postgres", "template1");
        let response = self.start_protocol_with_startup_packet(&startup)?;
        ensure!(
            response.accepted,
            "PGlite WASIX startup packet was rejected: {}",
            summarize_protocol(&response.output)
        );
        ensure!(
            !protocol_response_contains_error(&response.output),
            "PGlite WASIX startup packet returned an error: {}",
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
            "PGlite WASIX protocol startup has already completed for this backend"
        );

        let _phase = timing::phase("postgres.startup_packet");
        {
            let _phase = timing::phase("postgres.startup_packet.input_reset");
            self.io.reset(&mut self.store)?;
        }
        {
            let _phase = timing::phase("postgres.startup_packet.input_write");
            self.io
                .push_input(&mut self.store, &self.env, &self.malloc, startup)?;
        }

        // The upstream lifecycle is already running by this point. These calls
        // open the Rust-owned direct wire-protocol transport on top of that
        // lifecycle; they must not grow into a second backend lifecycle.
        let port = {
            let _phase = timing::phase("postgres.startup_packet.get_port");
            self.protocol
                .get_port
                .call(&mut self.store)
                .context("pgl_getMyProcPort")?
        };
        ensure!(port > 0, "pgl_getMyProcPort returned null");

        let status = {
            let _phase = timing::phase("postgres.startup_packet.process_startup");
            self.protocol
                .process_startup
                .call(&mut self.store, port, 1, 1)
                .context("ProcessStartupPacket")?
        };
        if status != 0 {
            let _ = self.protocol.pq_flush.call(&mut self.store);
            let output = self
                .io
                .take_output(&mut self.store, &self.env, &self.malloc)?;
            return Ok(StartupProtocolResponse {
                output,
                accepted: false,
            });
        }
        let output = {
            let _phase = timing::phase("postgres.startup_packet.ready");
            {
                let _phase = timing::phase("postgres.startup_packet.send_conn_data");
                self.protocol
                    .send_conn_data
                    .call(&mut self.store)
                    .context("pgl_sendConnData")?;
            }
            {
                let _phase = timing::phase("postgres.startup_packet.pq_flush");
                self.protocol
                    .pq_flush
                    .call(&mut self.store)
                    .context("pgl_pq_flush after startup")?;
            }
            {
                let _phase = timing::phase("postgres.startup_packet.output_read");
                self.io
                    .take_output(&mut self.store, &self.env, &self.malloc)?
            }
        };
        self.started = true;
        Ok(StartupProtocolResponse {
            output,
            accepted: true,
        })
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
                warn!("PostgresMainLoopOnce trapped while draining after recovery: {drain_err}");
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
            .context("pgl_pq_flush after backend ErrorResponse recovery")?;
        let _ = self
            .io
            .take_output(&mut self.store, &self.env, &self.malloc)?;
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
            let _phase = timing::phase("wasix.runtime_construct");
            let tokio_runtime = {
                let _phase = timing::phase("wasix.runtime_construct.tokio");
                Arc::new(
                    tokio::runtime::Builder::new_multi_thread()
                        .enable_all()
                        .build()
                        .context("create Tokio runtime for Wasmer/WASIX filesystem")
                        .map_err(|err| format!("{err:#}"))?,
                )
            };
            let wasix_module_cache = {
                let _phase = timing::phase("wasix.runtime_construct.module_cache");
                Arc::new(SharedCache::new())
            };
            let wasix_runtime = {
                let _phase = timing::phase("wasix.runtime_construct.pluggable_runtime");
                build_wasix_runtime(&tokio_runtime, engine, wasix_module_cache.clone())
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

fn instantiate_wasix_module(
    runtime: &TokioRuntime,
    wasix_runtime: &Arc<dyn Runtime + Send + Sync>,
    store: &mut Store,
    paths: &PglitePaths,
    runtime_layout: &RuntimeLayout,
    module: Module,
) -> Result<(Instance, WasiFunctionEnv)> {
    let _phase = timing::phase("wasix.instantiate");
    let _guard = runtime.enter();
    let root_fs = {
        let _phase = timing::phase("wasix.instantiate.root_fs");
        if runtime_layout.uses_shared_overlay() {
            mountfs_overlay_wasi_root(paths, runtime_layout)?
        } else {
            host_wasi_root(&paths.runtime_root())?
        }
    };

    let mut runner = WasiRunner::new();
    runner.with_current_dir("/");
    if let Some(pgdata_mount) = {
        let _phase = timing::phase("wasix.instantiate.pgdata_mount");
        pgdata_overlay_mount(paths, runtime_layout)?
    } {
        // Wasmer's WASI runner rebuilds the final MountFileSystem from the
        // supplied root "/" filesystem plus runner-owned mounts. Nested mounts
        // inside WasiFsRoot would be dropped by prepare_webc_env.
        runner.with_mount(PGDATA_DIR.to_owned(), pgdata_mount);
    }
    if std::env::var_os("PGLITE_OXIDE_WASIX_STDIO").is_none() {
        runner
            .with_stdout(Box::<NullFile>::default())
            .with_stderr(Box::<NullFile>::default());
    }
    let wasi = Wasi::new(PGLITE_EXE_PATH);
    let mut builder = {
        let _phase = timing::phase("wasix.instantiate.prepare_env");
        runner
            .prepare_webc_env(
                PGLITE_EXE_PATH,
                &wasi,
                PackageOrHash::Hash(ModuleHash::random()),
                RuntimeOrEngine::Runtime(wasix_runtime.clone()),
                Some(root_fs),
            )
            .context("prepare Wasmer/WASIX runner environment")?
    };
    add_pglite_env(&mut builder);
    add_pglite_args(&mut builder);

    {
        let _phase = timing::phase("wasix.instantiate.module");
        builder
            .instantiate(module, store)
            .context("instantiate PGlite WASIX module")
    }
}

fn host_wasi_root(runtime_root: &Path) -> Result<WasiFsRoot> {
    Ok(WasiFsRoot::from_filesystem(maybe_trace_filesystem(
        host_filesystem(runtime_root)?,
    )))
}

fn mountfs_overlay_wasi_root(
    paths: &PglitePaths,
    runtime_layout: &RuntimeLayout,
) -> Result<WasiFsRoot> {
    let _phase = timing::phase("wasix.mountfs_overlay_construct");
    let runtime_root = paths.runtime_root();
    // PostgreSQL opens some paths relative to PGDATA after chdir. Keep runtime
    // files as a root overlay, and mount PGDATA separately only when we can use
    // an eager-copy overlay that avoids Wasmer's lazy COW write failures.
    let primary =
        virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(&runtime_root)?));
    let secondary = virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(
        &runtime_layout.module_root,
    )?));
    let overlay = virtual_fs::OverlayFileSystem::new(primary, [secondary]);

    Ok(WasiFsRoot::from_filesystem(Arc::new(overlay)))
}

fn pgdata_overlay_mount(
    paths: &PglitePaths,
    runtime_layout: &RuntimeLayout,
) -> Result<Option<Arc<dyn virtual_fs::FileSystem + Send + Sync>>> {
    if let Some(pgdata_template_root) = &runtime_layout.pgdata_template_root {
        let fs =
            EagerCopyOverlayFileSystem::new(paths.pgdata.clone(), pgdata_template_root.clone())?;
        return Ok(Some(maybe_trace_filesystem(Arc::new(fs))));
    }
    Ok(None)
}

struct EagerCopyOverlayFileSystem {
    upper_root: PathBuf,
    lower_root: PathBuf,
    overlay:
        virtual_fs::OverlayFileSystem<virtual_fs::ArcFileSystem, [virtual_fs::ArcFileSystem; 1]>,
}

impl fmt::Debug for EagerCopyOverlayFileSystem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EagerCopyOverlayFileSystem")
            .field("upper_root", &self.upper_root)
            .field("lower_root", &self.lower_root)
            .finish_non_exhaustive()
    }
}

impl EagerCopyOverlayFileSystem {
    fn new(upper_root: PathBuf, lower_root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&upper_root)
            .with_context(|| format!("create PGDATA overlay upper {}", upper_root.display()))?;
        let upper_root = upper_root.canonicalize().with_context(|| {
            format!("canonicalize PGDATA overlay upper {}", upper_root.display())
        })?;
        let lower_root = lower_root.canonicalize().with_context(|| {
            format!("canonicalize PGDATA overlay lower {}", lower_root.display())
        })?;
        let upper = virtual_fs::ArcFileSystem::new(host_filesystem(&upper_root)?);
        let lower = virtual_fs::ArcFileSystem::new(host_filesystem(&lower_root)?);
        Ok(Self {
            upper_root,
            lower_root,
            overlay: virtual_fs::OverlayFileSystem::new(upper, [lower]),
        })
    }

    fn ensure_upper_copy(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<()> {
        let Some(relative) = normalize_overlay_path(path)? else {
            return Ok(());
        };

        let upper = self.upper_root.join(&relative);
        if upper.exists() {
            return Ok(());
        }

        let lower = self.lower_root.join(&relative);
        let metadata = match fs::symlink_metadata(&lower) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        };

        if conf.create_new {
            return Err(virtual_fs::FsError::AlreadyExists);
        }
        if metadata.is_dir() {
            return Ok(());
        }
        if !metadata.is_file() {
            return Err(virtual_fs::FsError::Unsupported);
        }

        if let Some(parent) = upper.parent() {
            fs::create_dir_all(parent).map_err(virtual_fs::FsError::from)?;
        }
        if conf.truncate && !conf.read && !conf.append {
            fs::File::create(&upper).map_err(virtual_fs::FsError::from)?;
        } else {
            fs::copy(&lower, &upper).map_err(virtual_fs::FsError::from)?;
        }
        Ok(())
    }
}

impl virtual_fs::FileSystem for EagerCopyOverlayFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.overlay.readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.overlay.read_dir(path)
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.overlay.create_dir(path)
    }

    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.overlay.create_symlink(source, target)
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.overlay.remove_dir(path)
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.ensure_upper_copy(from, &mutating_open_config())?;
            self.overlay.rename(from, to).await
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.overlay.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.overlay.symlink_metadata(path)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.overlay.remove_file(path)
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for EagerCopyOverlayFileSystem {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        if conf.would_mutate() {
            self.ensure_upper_copy(path, conf)?;
        }
        virtual_fs::FileSystem::new_open_options(&self.overlay)
            .options(conf.clone())
            .open(path)
    }
}

fn normalize_overlay_path(path: &Path) -> virtual_fs::Result<Option<PathBuf>> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::Prefix(_) => {
                return Err(virtual_fs::FsError::PermissionDenied);
            }
        }
    }
    if relative.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(relative))
    }
}

fn mutating_open_config() -> virtual_fs::OpenOptionsConfig {
    virtual_fs::OpenOptionsConfig {
        read: true,
        write: true,
        create_new: false,
        create: false,
        append: false,
        truncate: false,
    }
}

fn host_filesystem(host_path: &Path) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let host_fs = SyncHostFileSystem::new(host_path)
        .with_context(|| format!("create host fs rooted at {}", host_path.display()))?;
    Ok(Arc::new(host_fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>)
}

fn fs_trace_enabled() -> bool {
    env_flag_enabled("PGLITE_OXIDE_WASIX_FS_TRACE")
}

fn env_flag_enabled(name: &str) -> bool {
    let Some(value) = std::env::var_os(name) else {
        return false;
    };
    !matches!(
        value.to_string_lossy().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "off" | "no"
    )
}

fn maybe_trace_filesystem(
    inner: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
) -> Arc<dyn virtual_fs::FileSystem + Send + Sync> {
    if fs_trace_enabled() {
        Arc::new(TracedFileSystem { inner }) as Arc<dyn virtual_fs::FileSystem + Send + Sync>
    } else {
        inner
    }
}

#[derive(Debug)]
struct TracedFileSystem {
    inner: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
}

impl TracedFileSystem {
    fn record<T>(&self, counter: &AtomicU64, operation: impl FnOnce() -> T) -> T {
        counter.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = operation();
        FS_TRACE.record_total(started.elapsed());
        result
    }
}

impl virtual_fs::FileSystem for TracedFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.record(&FS_TRACE.metadata_count, || self.inner.readlink(path))
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.record(&FS_TRACE.read_dir_count, || self.inner.read_dir(path))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.create_dir_count, || self.inner.create_dir(path))
    }

    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.create_dir_count, || {
            self.inner.create_symlink(source, target)
        })
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.remove_dir_count, || self.inner.remove_dir(path))
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        FS_TRACE.rename_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            let started = Instant::now();
            let result = self.inner.rename(from, to).await;
            FS_TRACE.record_total(started.elapsed());
            result
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.record(&FS_TRACE.metadata_count, || self.inner.metadata(path))
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.record(&FS_TRACE.metadata_count, || {
            self.inner.symlink_metadata(path)
        })
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.remove_file_count, || self.inner.remove_file(path))
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for TracedFileSystem {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        FS_TRACE.open_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let file = virtual_fs::FileSystem::new_open_options(&self.inner)
            .options(conf.clone())
            .open(path);
        FS_TRACE.record_total(started.elapsed());
        file.map(|inner| Box::new(TracedVirtualFile { inner }) as _)
    }
}

#[derive(Debug)]
struct TracedVirtualFile {
    inner: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
}

impl virtual_fs::VirtualFile for TracedVirtualFile {
    fn last_accessed(&self) -> u64 {
        self.inner.last_accessed()
    }

    fn last_modified(&self) -> u64 {
        self.inner.last_modified()
    }

    fn created_time(&self) -> u64 {
        self.inner.created_time()
    }

    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.inner.set_times(atime, mtime)
    }

    fn size(&self) -> u64 {
        self.inner.size()
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        FS_TRACE.set_len_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = self.inner.set_len(new_size);
        FS_TRACE.record_total(started.elapsed());
        result
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        FS_TRACE.unlink_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = self.inner.unlink();
        FS_TRACE.record_total(started.elapsed());
        result
    }

    fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.inner.get_special_fd()
    }

    fn write_from_mmap(&mut self, offset: u64, len: u64) -> io::Result<()> {
        self.inner.write_from_mmap(offset, len)
    }

    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_read_ready(cx)
    }

    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_write_ready(cx)
    }
}

impl virtual_fs::AsyncRead for TracedVirtualFile {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            let bytes = buf.filled().len().saturating_sub(before) as u64;
            FS_TRACE.read_count.fetch_add(1, Ordering::Relaxed);
            FS_TRACE.read_bytes.fetch_add(bytes, Ordering::Relaxed);
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.read_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }
}

impl virtual_fs::AsyncWrite for TracedVirtualFile {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(bytes)) = &result {
            FS_TRACE.write_count.fetch_add(1, Ordering::Relaxed);
            FS_TRACE
                .write_bytes
                .fetch_add(*bytes as u64, Ordering::Relaxed);
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.write_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_shutdown(cx)
    }
}

impl virtual_fs::AsyncSeek for TracedVirtualFile {
    fn start_seek(self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        let this = self.get_mut();
        FS_TRACE.seek_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).start_seek(position);
        let elapsed = started.elapsed();
        FS_TRACE.record_total(elapsed);
        FS_TRACE.seek_elapsed_micros.fetch_add(
            elapsed.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        result
    }

    fn poll_complete(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        let this = self.get_mut();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_complete(cx);
        if let Poll::Ready(Ok(_)) = &result {
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.seek_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }
}

fn build_wasix_runtime(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: Arc<SharedCache>,
) -> Arc<dyn Runtime + Send + Sync> {
    let _guard = runtime.enter();
    let task_manager = Arc::new(TokioTaskManager::new(runtime.handle().clone()));
    let mut wasix_runtime = PluggableRuntime::new(task_manager);
    wasix_runtime.set_engine(engine.clone());
    wasix_runtime.set_module_cache(module_cache);
    Arc::new(wasix_runtime)
}

fn preload_runtime_side_modules(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    runtime_root: &Path,
) -> Result<()> {
    let _phase = timing::phase("wasix.seed_runtime_side_modules");
    let lib_dir = runtime_root.join("lib/postgresql");
    for (file_name, artifact_name) in RUNTIME_SIDE_MODULES {
        let library = lib_dir.join(file_name);
        ensure!(
            library.exists(),
            "runtime support module '{}' is not installed at {}",
            file_name,
            library.display()
        );

        seed_side_module_cache(
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
fn preload_installed_extension_side_modules(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    runtime_root: &Path,
) -> Result<()> {
    let _phase = timing::phase("wasix.seed_extension_side_modules");
    let lib_dir = runtime_root.join("lib/postgresql");
    for extension in super::extensions::ALL {
        let library = lib_dir.join(format!("{}.so", extension.sql_name()));
        if !library.exists() {
            continue;
        }
        seed_side_module_cache(
            runtime,
            engine,
            module_cache,
            &library,
            extension.aot_name(),
            &format!("installed extension '{}'", extension.sql_name()),
        )?;
    }
    Ok(())
}

fn seed_side_module_cache(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    library: &Path,
    artifact_name: &'static str,
    label: &str,
) -> Result<()> {
    if SEEDED_AOT_ARTIFACTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("seeded AOT artifact cache poisoned")
        .contains(artifact_name)
    {
        return Ok(());
    }

    let wasm = {
        let _phase = timing::phase("wasix.seed_side_module.read_wasm");
        fs::read(library).with_context(|| format!("read side module {}", library.display()))?
    };
    let module_hash = {
        let _phase = timing::phase("wasix.seed_side_module.module_hash");
        ModuleHash::new(&wasm)
    };
    let seed_key = format!("{artifact_name}:{module_hash}");
    if SEEDED_SIDE_MODULES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("seeded side module cache poisoned")
        .contains(&seed_key)
    {
        return Ok(());
    }

    let module = {
        let _phase = timing::phase("wasix.seed_side_module.load_aot");
        aot::load_artifact_module(engine, artifact_name)?
    };
    {
        let _phase = timing::phase("wasix.seed_side_module.save_cache");
        runtime
            .block_on(module_cache.save(module_hash, engine, &module))
            .with_context(|| format!("seed Wasmer module cache for {label} ({module_hash})"))?;
    }
    SEEDED_SIDE_MODULES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("seeded side module cache poisoned")
        .insert(seed_key);
    SEEDED_AOT_ARTIFACTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("seeded AOT artifact cache poisoned")
        .insert(artifact_name);
    Ok(())
}

impl PgliteLifecycleExports {
    fn load(store: &mut Store, instance: &Instance) -> Result<Self> {
        let wasi_start = typed_export(store, instance, "_start")?;
        let set_active = typed_export(store, instance, "pgl_setPGliteActive")?;
        let start_pglite = typed_export(store, instance, "pgl_startPGlite")?;
        let run_atexit_funcs = optional_typed_export(store, instance, "pgl_run_atexit_funcs")?;
        let backend_timing_reset =
            optional_typed_export(store, instance, "pgl_backend_timing_reset")?;
        let backend_timing_elapsed_us =
            optional_typed_export(store, instance, "pgl_backend_timing_elapsed_us")?;

        Ok(Self {
            wasi_start,
            set_active,
            start_pglite,
            run_atexit_funcs,
            backend_timing_reset,
            backend_timing_elapsed_us,
        })
    }
}

impl WasixProtocolExports {
    fn load(store: &mut Store, instance: &Instance) -> Result<Self> {
        let get_port = typed_export(store, instance, "pgl_getMyProcPort")?;
        let process_startup = typed_export(store, instance, "ProcessStartupPacket")?;
        let send_conn_data = typed_export(store, instance, "pgl_sendConnData")?;
        let pq_flush = typed_export(store, instance, "pgl_pq_flush")?;
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

fn ensure_integrated_pglite_contract(instance: &Instance) -> Result<()> {
    for name in [
        "pgl_startPGlite",
        "pgl_setPGliteActive",
        "PostgresMainLongJmp",
    ] {
        ensure!(
            instance.exports.get_function(name).is_ok()
                || instance.exports.get_function(&format!("_{name}")).is_ok(),
            "WASIX runtime is missing integrated PGlite lifecycle export {name}"
        );
    }
    Ok(())
}

impl WasixPgliteIo {
    fn new(store: &mut Store, instance: &Instance) -> Result<Self> {
        let io = Self {
            input_reset: typed_export(store, instance, "pgl_wasix_input_reset")?,
            input_write: typed_export(store, instance, "pgl_wasix_input_write")?,
            input_available: typed_export(store, instance, "pgl_wasix_input_available")?,
            output_reset: typed_export(store, instance, "pgl_wasix_output_reset")?,
            output_len: typed_export(store, instance, "pgl_wasix_output_len")?,
            output_read: typed_export(store, instance, "pgl_wasix_output_read")?,
        };
        io.reset(store)?;
        Ok(io)
    }

    fn reset(&self, store: &mut Store) -> Result<()> {
        ensure!(
            self.input_reset
                .call(&mut *store)
                .context("pgl_wasix_input_reset")?
                == 0,
            "pgl_wasix_input_reset failed"
        );
        ensure!(
            self.output_reset
                .call(&mut *store)
                .context("pgl_wasix_output_reset")?
                == 0,
            "pgl_wasix_output_reset failed"
        );
        Ok(())
    }

    fn push_input(
        &self,
        store: &mut Store,
        env: &WasiFunctionEnv,
        malloc: &TypedFunction<i32, i32>,
        bytes: &[u8],
    ) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let ptr = write_bytes(store, env, malloc, bytes)?;
        let written = self
            .input_write
            .call(&mut *store, ptr, bytes.len() as i32)
            .context("pgl_wasix_input_write")?;
        ensure!(
            written == bytes.len() as i32,
            "pgl_wasix_input_write wrote {written}, expected {}",
            bytes.len()
        );
        Ok(())
    }

    fn available(&self, store: &mut Store) -> Result<i32> {
        let available = self
            .input_available
            .call(store)
            .context("pgl_wasix_input_available")?;
        ensure!(
            available >= 0,
            "pgl_wasix_input_available returned negative length {available}"
        );
        Ok(available)
    }

    fn take_output(
        &self,
        store: &mut Store,
        env: &WasiFunctionEnv,
        malloc: &TypedFunction<i32, i32>,
    ) -> Result<Vec<u8>> {
        let len = self
            .output_len
            .call(&mut *store)
            .context("pgl_wasix_output_len")?;
        ensure!(
            len >= 0,
            "pgl_wasix_output_len returned negative length {len}"
        );
        if len == 0 {
            return Ok(Vec::new());
        }
        let ptr = malloc
            .call(&mut *store, len)
            .context("malloc for pgl_wasix_output_read")?;
        ensure!(ptr > 0, "malloc returned null for output read");
        let read = self
            .output_read
            .call(&mut *store, ptr, len)
            .context("pgl_wasix_output_read")?;
        ensure!(
            read >= 0 && read <= len,
            "invalid pgl_wasix_output_read length {read}"
        );

        let mut bytes = vec![0u8; read as usize];
        let view = env
            .data(&*store)
            .try_memory_view(&*store)
            .context("get WASIX memory view")?;
        view.read(ptr as u64, &mut bytes)
            .with_context(|| format!("read SQL output at 0x{ptr:x}"))?;
        ensure!(
            self.output_reset
                .call(&mut *store)
                .context("pgl_wasix_output_reset after read")?
                == 0,
            "pgl_wasix_output_reset after read failed"
        );
        Ok(bytes)
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
        .get_typed_function::<Args, Rets>(&mut *store, name)
        .or_else(|_| {
            instance
                .exports
                .get_typed_function::<Args, Rets>(&mut *store, &format!("_{name}"))
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

fn add_pglite_env(builder: &mut wasmer_wasix::WasiEnvBuilder) {
    for (key, value) in [
        ("PREFIX", WASM_PREFIX),
        ("PGDATA", PGDATA_DIR),
        ("PGUSER", "postgres"),
        ("PGDATABASE", "template1"),
        ("MODE", "REACT"),
        ("REPL", "N"),
        ("PGSYSCONFDIR", WASM_PREFIX),
        ("PGCLIENTENCODING", "UTF8"),
        ("LC_CTYPE", "C.UTF-8"),
        ("TZ", "UTC"),
        ("PGTZ", "UTC"),
        ("PG_COLOR", "never"),
    ] {
        builder.add_env(key, value);
    }
}

fn add_pglite_args(builder: &mut wasmer_wasix::WasiEnvBuilder) {
    for arg in [
        "--single",
        "-F",
        "-O",
        "-j",
        "-c",
        "search_path=public",
        "-c",
        "exit_on_error=false",
        "-c",
        "log_checkpoints=false",
        "-c",
        "max_worker_processes=0",
        "-c",
        "max_parallel_workers=0",
        "-c",
        "max_parallel_workers_per_gather=0",
        "-c",
        "wal_buffers=4MB",
        "-c",
        "min_wal_size=80MB",
        "-c",
        "shared_buffers=128MB",
        "-D",
        PGDATA_DIR,
        "template1",
    ] {
        builder.add_arg(arg);
    }
}

fn ensure_runtime_dirs(paths: &PglitePaths) -> Result<()> {
    for path in [
        paths.runtime_root(),
        paths.pgdata.clone(),
        paths.runtime_root().join("home"),
        paths.runtime_root().join("dev"),
        paths.runtime_root().join("dev/shm"),
        paths.runtime_root().join("tmp"),
    ] {
        fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
    }

    let urandom = paths.runtime_root().join("dev/urandom");
    if !urandom.exists() {
        fs::write(&urandom, [42u8; 128]).with_context(|| format!("seed {}", urandom.display()))?;
    }
    for name in ["null", "stdout", "stderr", "zero"] {
        let path = paths.runtime_root().join("dev").join(name);
        if !path.exists() {
            fs::write(&path, []).with_context(|| format!("create {}", path.display()))?;
        }
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

fn write_bytes(
    store: &mut Store,
    env: &WasiFunctionEnv,
    malloc: &TypedFunction<i32, i32>,
    bytes: &[u8],
) -> Result<i32> {
    let ptr = malloc
        .call(&mut *store, bytes.len() as i32)
        .context("malloc for guest bytes")?;
    ensure!(ptr > 0, "malloc returned null for guest bytes");
    let view = env
        .data(&*store)
        .try_memory_view(&*store)
        .context("get WASIX memory view")?;
    view.write(ptr as u64, bytes)
        .with_context(|| format!("write guest bytes at 0x{ptr:x}"))?;
    Ok(ptr)
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
        messages.push(format!("{tag}({} bytes)", len - 4));
        cursor = end;
    }
    if cursor < bytes.len() {
        messages.push(format!("tail:{} bytes", bytes.len() - cursor));
    }
    format!("{} bytes [{}]", bytes.len(), messages.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mountfs_pgdata_overlay_exposes_lower_template_files() -> Result<()> {
        use tokio::io::AsyncWriteExt;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _guard = runtime.enter();
        let temp = tempfile::TempDir::new()?;
        let runtime_root = temp.path().join("runtime");
        let pgdata_upper = runtime_root.join("base");
        let pgdata_lower = temp.path().join("template");
        fs::create_dir_all(&pgdata_upper)?;
        fs::create_dir_all(&pgdata_lower)?;
        fs::write(pgdata_lower.join("postgresql.conf"), b"from-template\n")?;

        let root = virtual_fs::MountFileSystem::new();
        root.mount(Path::new("/"), host_filesystem(&runtime_root)?)?;
        root.mount(
            Path::new(PGDATA_DIR),
            Arc::new(EagerCopyOverlayFileSystem::new(
                pgdata_upper.clone(),
                pgdata_lower.clone(),
            )?),
        )?;

        virtual_fs::FileSystem::metadata(&root, Path::new("/base/postgresql.conf"))?;
        virtual_fs::FileSystem::new_open_options(&root)
            .read(true)
            .open("/base/postgresql.conf")?;
        let mut writable = virtual_fs::FileSystem::new_open_options(&root)
            .write(true)
            .open("/base/postgresql.conf")?;
        runtime.block_on(async {
            writable.write_all(b"upper-only\n").await?;
            writable.flush().await
        })?;
        assert!(pgdata_upper.join("postgresql.conf").is_file());
        assert_eq!(
            fs::read_to_string(pgdata_lower.join("postgresql.conf"))?,
            "from-template\n"
        );
        Ok(())
    }
}
