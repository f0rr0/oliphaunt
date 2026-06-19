#[cfg(debug_assertions)]
use std::cell::Cell;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

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
use wasmer_wasix::runtime::task_manager::VirtualTaskManagerExt;
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
use wasmer_wasix::virtual_fs::null_file::NullFile;
use wasmer_wasix::{WasiError, WasiFunctionEnv, virtual_fs};
use webc::metadata::Command as WebcCommand;
use webc::metadata::annotations::{WASI_RUNNER_URI, Wasi};

use super::aot;
use super::base::{OliphauntPaths, RuntimeLayout};
use super::config::{PostgresConfig, StartupConfig};
#[cfg(feature = "extensions")]
use super::extensions::Extension;
use super::timing;

mod stdio;
mod wasix_fs;

pub(crate) use stdio::ProtocolStream;
use stdio::{ProtocolStdioAttachment, ProtocolStdioFile, TailCaptureFile, TailCaptureHandle};
use wasix_fs::{
    EagerCopyOverlayFileSystem, host_filesystem, maybe_trace_filesystem, wasi_root_with_devices,
};
pub use wasix_fs::{FsTraceSnapshot, fs_trace_snapshot, reset_fs_trace};

const OLIPHAUNT_EXE_PATH: &str = "/bin/oliphaunt";
const PGDATA_DIR: &str = "/base";
const WASM_PREFIX: &str = "/";
const RUNTIME_SIDE_MODULES: &[(&str, &str)] = &[
    ("plpgsql.so", "runtime-support:plpgsql"),
    ("dict_snowball.so", "runtime-support:dict_snowball"),
];
const OLIPHAUNT_EXIT_ALIVE: i32 = 99;
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
    (36, "postgres.backend.c.exec_simple_query"),
    (37, "postgres.backend.c.exec_start_xact"),
    (38, "postgres.backend.c.exec_drop_unnamed"),
    (39, "postgres.backend.c.exec_parse"),
    (40, "postgres.backend.c.exec_snapshot"),
    (41, "postgres.backend.c.exec_analyze_rewrite"),
    (42, "postgres.backend.c.exec_plan"),
    (43, "postgres.backend.c.exec_portal_start"),
    (44, "postgres.backend.c.exec_dest_receiver"),
    (45, "postgres.backend.c.exec_portal_run"),
    (46, "postgres.backend.c.exec_finish_xact"),
    (47, "postgres.backend.c.exec_command_counter"),
    (48, "postgres.backend.c.exec_end_command"),
    (49, "postgres.backend.c.heapam_tuple_update"),
    (50, "postgres.backend.c.btree_doinsert"),
    (51, "postgres.backend.c.xlog_insert_record"),
    (52, "postgres.backend.c.btree_mkscankey"),
    (53, "postgres.backend.c.btree_search_insert"),
    (54, "postgres.backend.c.btree_check_unique"),
    (55, "postgres.backend.c.btree_find_insertloc"),
    (56, "postgres.backend.c.btree_insertonpg"),
    (57, "postgres.backend.c.btree_split"),
    (58, "postgres.backend.c.btree_binsrch_insert"),
    (59, "postgres.backend.c.btree_compare"),
    (60, "postgres.backend.c.heap_determine_columns"),
    (61, "postgres.backend.c.heap_toast_update"),
    (62, "postgres.backend.c.heap_get_buffer_for_tuple"),
    (63, "postgres.backend.c.heap_put_tuple"),
    (64, "postgres.backend.c.heap_log_update"),
    (65, "postgres.backend.c.commit_record"),
    (66, "postgres.backend.c.commit_procarray_end"),
    (67, "postgres.backend.c.commit_callbacks"),
    (68, "postgres.backend.c.commit_resource_before_locks"),
    (69, "postgres.backend.c.commit_aio"),
    (70, "postgres.backend.c.commit_buffers"),
    (71, "postgres.backend.c.commit_relcache_typecache"),
    (72, "postgres.backend.c.commit_inval"),
    (73, "postgres.backend.c.commit_resource_locks"),
    (74, "postgres.backend.c.commit_pending_deletes"),
    (75, "postgres.backend.c.commit_notify"),
    (76, "postgres.backend.c.commit_local_cleanup"),
    (77, "postgres.backend.c.commit_memory"),
    (78, "postgres.backend.c.commit_xlog_record"),
    (79, "postgres.backend.c.commit_xlog_flush"),
    (80, "postgres.backend.c.commit_clog_commit_tree"),
    (81, "postgres.backend.c.commit_async_xact_lsn"),
    (82, "postgres.backend.c.commit_async_commit_tree"),
    (83, "postgres.backend.c.commit_sync_rep_wait"),
    (84, "postgres.backend.c.xlog_write_pwrite"),
    (85, "postgres.backend.c.xlog_write_pgstat_io"),
    (86, "postgres.backend.c.xlog_flush_wait_insertions"),
    (87, "postgres.backend.c.xlog_flush_wal_write_lock"),
    (88, "postgres.backend.c.xlog_flush_xlog_write"),
    (89, "postgres.backend.c.xlog_flush_walsnd_wakeup"),
    (90, "postgres.backend.c.xlog_write_loop"),
    (91, "postgres.backend.c.xlog_write_loop_scan"),
    (92, "postgres.backend.c.xlog_write_before_pwrite"),
    (93, "postgres.backend.c.xlog_write_after_pwrite"),
    (94, "postgres.backend.c.xlog_write_fsync"),
    (95, "postgres.backend.c.xlog_write_walsnd_request"),
    (96, "postgres.backend.c.xlog_write_shared_status"),
    (97, "postgres.backend.c.xlog_write_atomic_result"),
    (98, "postgres.backend.c.xlog_write_loop_count"),
    (99, "postgres.backend.c.xlog_write_group_count"),
    (100, "postgres.backend.c.xlog_write_page_count"),
    (101, "postgres.backend.c.xlog_write_pwrite_count"),
    (102, "postgres.backend.c.xlog_write_pwrite_bytes"),
    (103, "postgres.backend.c.xlog_write_request_bytes"),
];

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
    guest_allocator: GuestAllocator,
    io: WasixOliphauntIo,
    lifecycle: OliphauntLifecycleExports,
    protocol: WasixProtocolExports,
    protocol_stdio: Option<WasixProtocolStdioExports>,
    protocol_stdio_file: ProtocolStdioFile,
    wasi_stderr: TailCaptureHandle,
    protocol_stdio_attachment: Option<ProtocolStdioAttachment>,
    paths: OliphauntPaths,
    pgdata_template_root: Option<PathBuf>,
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

pub(crate) enum ProtocolPumpOutcome {
    Buffered(Vec<u8>),
    Streamed,
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

#[derive(Clone)]
struct WasixProtocolStdioExports {
    set_protocol_transport: TypedFunction<i32, i32>,
    protocol_stream_active: TypedFunction<(), i32>,
}

struct WasixOliphauntIo {
    input_reset: TypedFunction<(), i32>,
    input_write: TypedFunction<(i32, i32), i32>,
    input_available: TypedFunction<(), i32>,
    output_reset: TypedFunction<(), i32>,
    output_len: TypedFunction<(), i32>,
    output_read: TypedFunction<(i32, i32), i32>,
}

struct GuestAllocator {
    malloc: TypedFunction<i32, i32>,
    free: TypedFunction<i32, ()>,
    #[cfg(debug_assertions)]
    allocations: Cell<u64>,
    #[cfg(debug_assertions)]
    frees: Cell<u64>,
}

impl PostgresMod {
    pub(crate) fn preload_module(module_path: &std::path::Path) -> Result<()> {
        let runtime_root = module_path
            .parent()
            .and_then(Path::parent)
            .context("runtime module path must be under bin/oliphaunt")?;
        let (engine, _) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        preload_runtime_side_modules(
            &process_runtime.tokio_runtime,
            &engine,
            &process_runtime.wasix_module_cache,
            runtime_root,
        )
    }

    pub(crate) fn new_prepared(
        paths: OliphauntPaths,
        runtime_layout: RuntimeLayout,
    ) -> Result<Self> {
        Self::new_prepared_with_config(
            paths,
            runtime_layout,
            PostgresConfig::default(),
            StartupConfig::default(),
        )
    }

    pub(crate) fn new_prepared_with_config(
        paths: OliphauntPaths,
        runtime_layout: RuntimeLayout,
        postgres_config: PostgresConfig,
        startup_config: StartupConfig,
    ) -> Result<Self> {
        postgres_config.validate()?;
        startup_config.validate()?;
        ensure_runtime_dirs(&paths)?;
        #[cfg(feature = "extensions")]
        let runtime_root = runtime_layout.local_root.clone();
        let module_runtime_root = runtime_layout.module_root.clone();
        ensure!(
            module_runtime_root.join("bin/oliphaunt").exists(),
            "WASIX Oliphaunt executable not found at {}",
            module_runtime_root.join("bin/oliphaunt").display()
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
        let (instance, env, protocol_stdio_file, wasi_stderr) =
            instantiate_wasix_module(WasixInstantiateInput {
                runtime: &process_runtime.tokio_runtime,
                wasix_runtime: &process_runtime.wasix_runtime,
                store: &mut store,
                paths: &paths,
                runtime_layout: &runtime_layout,
                postgres_config: &postgres_config,
                startup_config: &startup_config,
                module: module.clone(),
            })?;
        seed_exported_c_string_value(
            &mut store,
            &instance,
            &env,
            "my_exec_path",
            OLIPHAUNT_EXE_PATH,
        )?;

        let (guest_allocator, io, lifecycle, protocol, protocol_stdio) = {
            let _phase = timing::phase("wasix.export_load");
            let guest_allocator = GuestAllocator::load(&mut store, &instance)?;
            let io = WasixOliphauntIo::new(&mut store, &instance)?;
            ensure_integrated_oliphaunt_contract(&instance)?;
            let lifecycle = OliphauntLifecycleExports::load(&mut store, &instance)?;
            let protocol = WasixProtocolExports::load(&mut store, &instance)?;
            let protocol_stdio = WasixProtocolStdioExports::load(&mut store, &instance)?;
            (guest_allocator, io, lifecycle, protocol, protocol_stdio)
        };

        let pg = Self {
            engine,
            tokio_runtime: process_runtime.tokio_runtime.clone(),
            wasix_module_cache: process_runtime.wasix_module_cache.clone(),
            _wasix_runtime: process_runtime.wasix_runtime.clone(),
            store,
            _instance: instance,
            env,
            guest_allocator,
            io,
            lifecycle,
            protocol,
            protocol_stdio,
            protocol_stdio_file,
            wasi_stderr,
            protocol_stdio_attachment: None,
            paths,
            pgdata_template_root: runtime_layout.pgdata_template_root.clone(),
            startup_config,
            startup_response: None,
            cluster_ready: false,
            backend_started: false,
            started: false,
        };
        Ok(pg)
    }

    pub fn paths(&self) -> &OliphauntPaths {
        &self.paths
    }

    pub(crate) fn pgdata_template_root(&self) -> Option<&Path> {
        self.pgdata_template_root.as_deref()
    }

    #[cfg(debug_assertions)]
    pub(crate) fn guest_bridge_allocation_counts(&self) -> (u64, u64) {
        self.guest_allocator.allocation_counts()
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
        self.reset_backend_c_timings()?;
        self.configure_host_error_recovery()?;
        {
            let _phase = timing::phase("postgres.backend_start.set_active");
            self.lifecycle
                .set_active
                .call(&mut self.store, 1)
                .context("oliphaunt_wasix_set_active(1)")?;
        }
        {
            let _phase = timing::phase("postgres.backend_start.single_user_main");
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
        self.record_backend_c_timings()?;
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
        match self
            .io
            .take_output(&mut self.store, &self.env, &self.guest_allocator)
        {
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
        let _phase = timing::phase("postgres.backend_shutdown");
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

    fn record_backend_c_timings(&mut self) -> Result<()> {
        let Some(elapsed) = &self.lifecycle.backend_timing_elapsed_us else {
            return Ok(());
        };

        for &(id, name) in BACKEND_C_TIMINGS {
            let elapsed_micros = elapsed
                .call(&mut self.store, id)
                .with_context(|| format!("oliphaunt_wasix_backend_timing_elapsed_us({id})"))?;
            if elapsed_micros > 0 {
                timing::record_phase_timing(name, Duration::from_micros(elapsed_micros as u64));
            }
        }
        Ok(())
    }

    fn reset_backend_c_timings(&mut self) -> Result<()> {
        let Some(reset) = &self.lifecycle.backend_timing_reset else {
            return Ok(());
        };

        reset
            .call(&mut self.store)
            .context("oliphaunt_wasix_backend_timing_reset")?;
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub fn preload_extension_module(&self, extension: Extension) -> Result<()> {
        let runtime_root = self.paths.runtime_root();
        for module in extension.native_support_modules() {
            seed_extension_side_module(
                &self.tokio_runtime,
                &self.engine,
                &self.wasix_module_cache,
                &runtime_root,
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
            &runtime_root,
            &format!("lib/postgresql/{module_file}"),
            extension.aot_name(),
            &format!("extension '{}'", extension.sql_name()),
        )?;
        Ok(())
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn preload_extension_module_from_paths(
        paths: &OliphauntPaths,
        extension: Extension,
    ) -> Result<()> {
        let (engine, _) = aot::load_runtime_module()?;
        let process_runtime = process_wasix_runtime(&engine)?;
        let runtime_root = paths.runtime_root();
        for module in extension.native_support_modules() {
            seed_extension_side_module(
                &process_runtime.tokio_runtime,
                &engine,
                &process_runtime.wasix_module_cache,
                &runtime_root,
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
            &process_runtime.tokio_runtime,
            &engine,
            &process_runtime.wasix_module_cache,
            &runtime_root,
            &format!("lib/postgresql/{module_file}"),
            extension.aot_name(),
            &format!("extension '{}'", extension.sql_name()),
        )
    }

    pub(crate) fn run_split_initdb(
        paths: &OliphauntPaths,
        runtime_layout: &RuntimeLayout,
    ) -> Result<()> {
        run_split_initdb(paths, runtime_layout)
    }

    pub fn send_protocol(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        {
            let _phase = timing::phase("postgres.protocol.ensure_started");
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
    ) -> Result<ProtocolPumpOutcome> {
        {
            let _phase = timing::phase("postgres.protocol.ensure_started");
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
            self.set_protocol_stream_prefix(continuation_prefix())?;
            let stream_result = result.and_then(|_| self.serve_protocol_stream_inner());
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
        self.reset_backend_c_timings()?;

        {
            let _phase = timing::phase("postgres.protocol.input_reset");
            self.io.reset(&mut self.store)?;
        }
        {
            let _phase = timing::phase("postgres.protocol.input_write");
            self.io
                .push_input(&mut self.store, &self.env, &self.guest_allocator, payload)?;
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
                    .context("oliphaunt_wasix_pq_flush after protocol buffer")?;
            }
            let output = {
                let _phase = timing::phase("postgres.protocol.output_read");
                self.io
                    .take_output(&mut self.store, &self.env, &self.guest_allocator)
                    .context("take backend output after protocol buffer")?
            };
            if !recovered_protocol_error && protocol_response_contains_error(&output) {
                self.recover_non_trapping_protocol_error()?;
            }
            self.record_backend_c_timings()?;
            Ok(output)
        }
    }

    pub(crate) fn supports_streaming_protocol(&self) -> bool {
        self.protocol_stdio.is_some()
    }

    fn serve_protocol_stream_inner(&mut self) -> Result<()> {
        self.reset_backend_c_timings()?;
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
        self.record_backend_c_timings()?;
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

        let _phase = timing::phase("postgres.startup_packet");
        {
            let _phase = timing::phase("postgres.startup_packet.input_reset");
            self.io.reset(&mut self.store)?;
        }
        {
            let _phase = timing::phase("postgres.startup_packet.input_write");
            self.io
                .push_input(&mut self.store, &self.env, &self.guest_allocator, startup)?;
        }

        // The upstream lifecycle is already running by this point. These calls
        // open the Rust-owned direct wire-protocol transport on top of that
        // lifecycle; they must not grow into a second backend lifecycle.
        let port = {
            let _phase = timing::phase("postgres.startup_packet.get_port");
            self.protocol
                .get_port
                .call(&mut self.store)
                .context("oliphaunt_wasix_get_proc_port")?
        };
        ensure!(port > 0, "oliphaunt_wasix_get_proc_port returned null");

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
                .take_output(&mut self.store, &self.env, &self.guest_allocator)?;
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
                    .context("oliphaunt_wasix_send_conn_data")?;
            }
            {
                let _phase = timing::phase("postgres.startup_packet.pq_flush");
                self.protocol
                    .pq_flush
                    .call(&mut self.store)
                    .context("oliphaunt_wasix_pq_flush after startup")?;
            }
            {
                let _phase = timing::phase("postgres.startup_packet.output_read");
                self.io
                    .take_output(&mut self.store, &self.env, &self.guest_allocator)?
            }
        };
        self.started = true;
        self.startup_response = Some(output.clone());
        Ok(StartupProtocolResponse {
            output,
            accepted: true,
        })
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn existing_startup_response(&self) -> Option<Vec<u8>> {
        self.startup_response.clone()
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
        let _ = self
            .io
            .take_output(&mut self.store, &self.env, &self.guest_allocator)?;
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

struct WasixInstantiateInput<'a> {
    runtime: &'a TokioRuntime,
    wasix_runtime: &'a Arc<dyn Runtime + Send + Sync>,
    store: &'a mut Store,
    paths: &'a OliphauntPaths,
    runtime_layout: &'a RuntimeLayout,
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
    let _phase = timing::phase("wasix.instantiate");
    let _guard = input.runtime.enter();
    let root_fs = {
        let _phase = timing::phase("wasix.instantiate.root_fs");
        if input.runtime_layout.uses_shared_overlay() {
            mountfs_overlay_wasi_root(input.paths, input.runtime_layout)?
        } else {
            host_wasi_root(&input.paths.runtime_root())?
        }
    };

    let mut runner = WasiRunner::new();
    runner.with_current_dir("/");
    let protocol_stdio_file = ProtocolStdioFile::new();
    let (stderr_file, stderr_capture) = TailCaptureFile::new(16 * 1024);
    runner.with_stdin(Box::new(protocol_stdio_file.clone()));
    runner.with_stdout(Box::new(protocol_stdio_file.clone()));
    runner.with_stderr(Box::new(stderr_file));
    let wasi = Wasi::new(OLIPHAUNT_EXE_PATH);
    let mut builder = {
        let _phase = timing::phase("wasix.instantiate.prepare_env");
        runner
            .prepare_webc_env(
                OLIPHAUNT_EXE_PATH,
                &wasi,
                PackageOrHash::Hash(ModuleHash::random()),
                RuntimeOrEngine::Runtime(input.wasix_runtime.clone()),
                Some(root_fs),
            )
            .context("prepare Wasmer/WASIX runner environment")?
    };
    {
        let _phase = timing::phase("wasix.instantiate.pgdata_preopen");
        add_pgdata_preopen(&mut builder)?;
    }
    add_oliphaunt_env(&mut builder, input.startup_config);
    add_oliphaunt_args(&mut builder, input.postgres_config, input.startup_config)?;

    {
        let _phase = timing::phase("wasix.instantiate.module");
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

fn host_wasi_root(runtime_root: &Path) -> Result<WasiFsRoot> {
    let root = maybe_trace_filesystem(host_filesystem(runtime_root)?);
    Ok(WasiFsRoot::from_filesystem(wasi_root_with_devices(root)?))
}

fn mountfs_overlay_wasi_root(
    paths: &OliphauntPaths,
    runtime_layout: &RuntimeLayout,
) -> Result<WasiFsRoot> {
    let _phase = timing::phase("wasix.mountfs_overlay_construct");
    let runtime_root = paths.runtime_root();
    let primary =
        virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(&runtime_root)?));
    let secondary = virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(
        &runtime_layout.module_root,
    )?));
    let overlay = Arc::new(virtual_fs::OverlayFileSystem::new(primary, [secondary]));
    let root: Arc<dyn virtual_fs::FileSystem + Send + Sync> =
        if let Some(pgdata) = pgdata_overlay_filesystem(paths, runtime_layout)? {
            wasi_root_with_pgdata_mount(overlay, pgdata)?
        } else {
            overlay
        };

    Ok(WasiFsRoot::from_filesystem(wasi_root_with_devices(root)?))
}

fn pgdata_overlay_filesystem(
    paths: &OliphauntPaths,
    runtime_layout: &RuntimeLayout,
) -> Result<Option<Arc<dyn virtual_fs::FileSystem + Send + Sync>>> {
    if let Some(pgdata_template_root) = &runtime_layout.pgdata_template_root {
        let fs =
            EagerCopyOverlayFileSystem::new(paths.pgdata.clone(), pgdata_template_root.clone())?;
        return Ok(Some(maybe_trace_filesystem(Arc::new(fs))));
    }
    Ok(None)
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
) -> Arc<dyn Runtime + Send + Sync> {
    let _guard = runtime.enter();
    let task_manager = Arc::new(TokioTaskManager::new(runtime.handle().clone()));
    let mut wasix_runtime = PluggableRuntime::new(task_manager);
    wasix_runtime.set_engine(engine.clone());
    wasix_runtime.set_module_cache(module_cache);
    Arc::new(wasix_runtime)
}

fn run_split_initdb(paths: &OliphauntPaths, runtime_layout: &RuntimeLayout) -> Result<()> {
    let _phase = timing::phase("initdb.split_wasix");
    let initdb_module = runtime_layout.module_root.join("bin/initdb");
    let postgres_module = runtime_layout.module_root.join("bin/postgres");
    ensure!(
        initdb_module.exists(),
        "split WASIX initdb module is not installed at {}; regenerate assets with `xtask assets template`",
        initdb_module.display()
    );
    ensure!(
        postgres_module.exists(),
        "WASIX postgres module is not installed at {}",
        postgres_module.display()
    );

    fs::create_dir_all(&paths.pgdata)
        .with_context(|| format!("create fresh PGDATA {}", paths.pgdata.display()))?;

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
    );

    let package = split_initdb_binary_package(&initdb_module, &postgres_module)?;
    let root_fs = split_initdb_root_filesystem(paths, runtime_layout)?;
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

    {
        let _phase = timing::phase("initdb.split_wasix.run_command");
        let result =
            run_package_command_with_root(&runner, "initdb", &package, initdb_runtime, root_fs);
        if let Err(err) = result {
            let stdout = stdout_capture.text();
            let stderr = stderr_capture.text();
            let diagnostics = split_initdb_diagnostics(paths, runtime_layout);
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
    paths: &OliphauntPaths,
    runtime_layout: &RuntimeLayout,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let root: Arc<dyn virtual_fs::FileSystem + Send + Sync> =
        if runtime_layout.uses_shared_overlay() {
            let upper = virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(
                &paths.runtime_root(),
            )?));
            let lower = virtual_fs::ArcFileSystem::new(maybe_trace_filesystem(host_filesystem(
                &runtime_layout.module_root,
            )?));
            Arc::new(virtual_fs::OverlayFileSystem::new(upper, [lower]))
        } else {
            maybe_trace_filesystem(host_filesystem(&paths.runtime_root())?)
        };

    let pgdata = maybe_trace_filesystem(host_filesystem(&paths.pgdata)?);
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

fn split_initdb_diagnostics(paths: &OliphauntPaths, runtime_layout: &RuntimeLayout) -> String {
    let pgdata_parent = paths.pgdata.parent().unwrap_or(&paths.pgdata);
    format!(
        "initdb diagnostics:\n  layout_kind={:?}\n  pgdata_host={}\n  pgdata_parent={}\n  runtime_root={}\n  module_root={}\n  pgdata_entries={}",
        runtime_layout.kind,
        path_state(&paths.pgdata),
        path_state(pgdata_parent),
        path_state(&paths.runtime_root()),
        path_state(&runtime_layout.module_root),
        dir_entry_sample(&paths.pgdata),
    )
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
    for extension in super::extensions::ALL {
        for module in extension.native_support_modules() {
            let library = runtime_root.join(module.runtime_path());
            if !library.exists() {
                continue;
            }
            let Some(aot_name) = module.aot_name() else {
                continue;
            };
            seed_side_module_cache(
                runtime,
                engine,
                module_cache,
                &library,
                aot_name,
                &format!(
                    "installed extension '{}' support module '{}'",
                    extension.sql_name(),
                    module.runtime_path()
                ),
            )?;
        }

        let Some(module_file) = extension.native_module_file() else {
            continue;
        };
        let Some(aot_name) = extension.aot_name() else {
            continue;
        };
        let library = runtime_root
            .join("lib")
            .join("postgresql")
            .join(module_file);
        if !library.exists() {
            continue;
        }
        seed_side_module_cache(
            runtime,
            engine,
            module_cache,
            &library,
            aot_name,
            &format!("installed extension '{}'", extension.sql_name()),
        )?;
    }
    Ok(())
}

#[cfg(feature = "extensions")]
fn seed_extension_side_module(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    runtime_root: &Path,
    runtime_path: &str,
    aot_name: Option<&'static str>,
    label: &str,
) -> Result<()> {
    let Some(aot_name) = aot_name else {
        return Ok(());
    };
    let library = runtime_root.join(runtime_path);
    ensure!(
        library.exists(),
        "{label} is not installed at {}",
        library.display()
    );
    seed_side_module_cache(runtime, engine, module_cache, &library, aot_name, label)
}

fn seed_side_module_cache(
    runtime: &TokioRuntime,
    engine: &Engine,
    module_cache: &Arc<SharedCache>,
    library: &Path,
    artifact_name: &'static str,
    label: &str,
) -> Result<()> {
    seed_wasix_module_cache(runtime, engine, module_cache, library, artifact_name, label)
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
        let _phase = timing::phase("wasix.seed_side_module.read_wasm");
        fs::read(wasm_path).with_context(|| format!("read WASIX module {}", wasm_path.display()))?
    };
    let module_hash = {
        let _phase = timing::phase("wasix.seed_side_module.module_hash");
        ModuleHash::new(&wasm)
    };
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
    let module = {
        let _phase = timing::phase("wasix.seed_side_module.load_aot");
        aot::load_artifact_module(engine, artifact_name)?
    };
    {
        let _phase = timing::phase("wasix.seed_side_module.save_cache");
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
        let backend_timing_reset =
            optional_typed_export(store, instance, "oliphaunt_wasix_backend_timing_reset")?;
        let backend_timing_elapsed_us =
            optional_typed_export(store, instance, "oliphaunt_wasix_backend_timing_elapsed_us")?;

        Ok(Self {
            wasi_start,
            set_force_host_error_recovery,
            set_active,
            start_oliphaunt,
            run_atexit_funcs,
            backend_timing_reset,
            backend_timing_elapsed_us,
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
            input_write: typed_export(store, instance, "oliphaunt_wasix_input_write")?,
            input_available: typed_export(store, instance, "oliphaunt_wasix_input_available")?,
            output_reset: typed_export(store, instance, "oliphaunt_wasix_output_reset")?,
            output_len: typed_export(store, instance, "oliphaunt_wasix_output_len")?,
            output_read: typed_export(store, instance, "oliphaunt_wasix_output_read")?,
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

    fn push_input(
        &self,
        store: &mut Store,
        env: &WasiFunctionEnv,
        allocator: &GuestAllocator,
        bytes: &[u8],
    ) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let written = allocator.with_bytes(store, env, bytes, |store, ptr| {
            self.input_write
                .call(&mut *store, ptr, bytes.len() as i32)
                .context("oliphaunt_wasix_input_write")
        })?;
        ensure!(
            written == bytes.len() as i32,
            "oliphaunt_wasix_input_write wrote {written}, expected {}",
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

    fn take_output(
        &self,
        store: &mut Store,
        env: &WasiFunctionEnv,
        allocator: &GuestAllocator,
    ) -> Result<Vec<u8>> {
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
        let bytes = allocator.with_allocation(store, len, |store, ptr| {
            let read = self
                .output_read
                .call(&mut *store, ptr, len)
                .context("oliphaunt_wasix_output_read")?;
            ensure!(
                read >= 0 && read <= len,
                "invalid oliphaunt_wasix_output_read length {read}"
            );

            let mut bytes = vec![0u8; read as usize];
            let view = env
                .data(&*store)
                .try_memory_view(&*store)
                .context("get WASIX memory view")?;
            view.read(ptr as u64, &mut bytes)
                .with_context(|| format!("read SQL output at 0x{ptr:x}"))?;
            Ok(bytes)
        })?;
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

impl GuestAllocator {
    fn load(store: &mut Store, instance: &Instance) -> Result<Self> {
        let malloc = typed_export::<i32, i32>(store, instance, "malloc")?;
        let free = typed_export::<i32, ()>(store, instance, "pg_free")
            .or_else(|_| typed_export::<i32, ()>(store, instance, "free"))
            .context("get pg_free/free export")?;
        Ok(Self {
            malloc,
            free,
            #[cfg(debug_assertions)]
            allocations: Cell::new(0),
            #[cfg(debug_assertions)]
            frees: Cell::new(0),
        })
    }

    #[cfg(debug_assertions)]
    fn allocation_counts(&self) -> (u64, u64) {
        (self.allocations.get(), self.frees.get())
    }

    fn with_bytes<R>(
        &self,
        store: &mut Store,
        env: &WasiFunctionEnv,
        bytes: &[u8],
        f: impl FnOnce(&mut Store, i32) -> Result<R>,
    ) -> Result<R> {
        let ptr = self.allocate(store, bytes.len() as i32)?;
        self.run_and_free(store, ptr, |store, ptr| {
            let view = env
                .data(&*store)
                .try_memory_view(&*store)
                .context("get WASIX memory view")?;
            view.write(ptr as u64, bytes)
                .with_context(|| format!("write guest bytes at 0x{ptr:x}"))?;
            f(store, ptr)
        })
    }

    fn with_allocation<R>(
        &self,
        store: &mut Store,
        len: i32,
        f: impl FnOnce(&mut Store, i32) -> Result<R>,
    ) -> Result<R> {
        let ptr = self.allocate(store, len)?;
        self.run_and_free(store, ptr, f)
    }

    fn allocate(&self, store: &mut Store, len: i32) -> Result<i32> {
        let ptr = self
            .malloc
            .call(&mut *store, len)
            .context("malloc guest allocation")?;
        ensure!(ptr > 0, "malloc returned null for guest allocation");
        #[cfg(debug_assertions)]
        self.allocations.set(self.allocations.get() + 1);
        Ok(ptr)
    }

    fn run_and_free<R>(
        &self,
        store: &mut Store,
        ptr: i32,
        f: impl FnOnce(&mut Store, i32) -> Result<R>,
    ) -> Result<R> {
        let result = f(store, ptr);
        let free_result = self
            .free
            .call(&mut *store, ptr)
            .with_context(|| format!("free guest allocation at 0x{ptr:x}"));
        #[cfg(debug_assertions)]
        if free_result.is_ok() {
            self.frees.set(self.frees.get() + 1);
        }
        match (result, free_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Ok(_), Err(err)) => Err(err),
            (Err(err), Ok(())) => Err(err),
            (Err(err), Err(free_err)) => Err(err.context(format!(
                "failed to free guest allocation at 0x{ptr:x} after previous error: {free_err:#}"
            ))),
        }
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
    // Wasmer does not implement nested WebAssembly exception throws on MSVC
    // hosts. The WASIX bridge therefore routes PostgreSQL ERROR longjmps
    // through the existing process-exit recovery boundary on that host
    // capability, while preserving normal nested unwinding elsewhere.
    cfg!(target_env = "msvc")
}

fn add_oliphaunt_env(builder: &mut wasmer_wasix::WasiEnvBuilder, startup_config: &StartupConfig) {
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
}

fn add_oliphaunt_args(
    builder: &mut wasmer_wasix::WasiEnvBuilder,
    postgres_config: &PostgresConfig,
    startup_config: &StartupConfig,
) -> Result<()> {
    postgres_config.validate()?;
    startup_config.validate()?;
    for arg in ["--single", "-F", "-O", "-j"] {
        builder.add_arg(arg);
    }
    if let Some(level) = startup_config.debug_level {
        builder.add_arg("-d");
        builder.add_arg(level.to_string());
    }
    for (name, value) in DEFAULT_STARTUP_GUCS {
        builder.add_arg("-c");
        builder.add_arg(format!("{name}={value}"));
    }
    if startup_config.relaxed_durability {
        builder.add_arg("-c");
        builder.add_arg("synchronous_commit=off");
    }
    for (name, value) in postgres_config.iter() {
        builder.add_arg("-c");
        builder.add_arg(format!("{name}={value}"));
    }
    for arg in &startup_config.extra_args {
        builder.add_arg(arg);
    }
    for arg in ["-D", PGDATA_DIR, startup_config.database.as_str()] {
        builder.add_arg(arg);
    }
    Ok(())
}

const DEFAULT_STARTUP_GUCS: &[(&str, &str)] = &[
    ("search_path", "public"),
    ("exit_on_error", "false"),
    ("log_checkpoints", "false"),
    ("max_wal_senders", "0"),
    ("max_worker_processes", "0"),
    ("max_parallel_workers", "0"),
    ("max_parallel_workers_per_gather", "0"),
    // PostgreSQL 18 defaults io_method=worker, but the embedded WASIX
    // single-user backend has no postmaster-managed IO worker process model.
    ("io_method", "sync"),
    ("wal_buffers", "4MB"),
    ("min_wal_size", "80MB"),
    ("shared_buffers", "128MB"),
];

fn ensure_runtime_dirs(paths: &OliphauntPaths) -> Result<()> {
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
    use std::io;
    use std::pin::Pin;

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

    #[test]
    fn mountfs_pgdata_overlay_creates_files_in_lower_only_directories() -> Result<()> {
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
        fs::create_dir_all(pgdata_lower.join("global"))?;

        let root = virtual_fs::MountFileSystem::new();
        root.mount(Path::new("/"), host_filesystem(&runtime_root)?)?;
        root.mount(
            Path::new(PGDATA_DIR),
            Arc::new(EagerCopyOverlayFileSystem::new(
                pgdata_upper.clone(),
                pgdata_lower,
            )?),
        )?;

        let mut writable = virtual_fs::FileSystem::new_open_options(&root)
            .write(true)
            .create(true)
            .open("/base/global/postmaster.pid")?;
        runtime.block_on(async {
            writable.write_all(b"lock\n").await?;
            writable.flush().await
        })?;

        assert_eq!(
            fs::read_to_string(pgdata_upper.join("global/postmaster.pid"))?,
            "lock\n"
        );
        Ok(())
    }

    #[test]
    fn mountfs_root_filesystem_routes_pgdata_as_mutable_subtree() -> Result<()> {
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
        fs::create_dir_all(pgdata_lower.join("global"))?;
        fs::write(pgdata_lower.join("PG_VERSION"), b"17\n")?;
        fs::write(pgdata_lower.join("global/pg_control"), b"control\n")?;

        let root = wasi_root_with_pgdata_mount(
            host_filesystem(&runtime_root)?,
            Arc::new(EagerCopyOverlayFileSystem::new(
                pgdata_upper.clone(),
                pgdata_lower,
            )?),
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

        assert_eq!(
            fs::read_to_string(pgdata_upper.join("postmaster.pid"))?,
            "lock\n"
        );
        Ok(())
    }
}
