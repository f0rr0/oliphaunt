use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Error};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use wasmer::sys::CodeMemoryPolicy;
use wasmer::{Engine, Store, sys::NativeEngineExt};
use wasmer_wasix::{
    LocalNetworking, ResourceLimits, Runtime, VirtualTaskManager,
    os::{TtyBridge, tty_sys::SysTty},
    runtime::{
        module_cache::ModuleCache,
        resolver::{MultiSource, Source},
        task_manager::tokio::{TokioTaskManager, TokioTaskManagerConfig},
    },
    virtual_net::DynVirtualNetworking,
};

use crate::{
    memory_profile::{LinearMemoryProfile, derived_static_style, executor_tunables_for_target},
    sealed::SealedModuleCache,
};

pub(crate) const POLICY_ID: &str =
    "oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2";
pub(crate) const CODE_MEMORY_POLICY_ID: &str =
    "wasmer.code-memory.relocated-regular-file.linux-x86_64.v1";
const TOKIO_WORKER_THREADS: usize = 2;
pub(crate) const HOST_TASK_BUDGET: usize = 96;
const BLOCKING_CORE_THREADS: usize = 1;
const BLOCKING_WORKER_IDLE_TIMEOUT: Duration = Duration::from_millis(1_000);
const WASIX_STACK_RLIMIT_DIVISOR: u64 = 8;

fn task_manager_config() -> TokioTaskManagerConfig {
    TokioTaskManagerConfig {
        core_threads: BLOCKING_CORE_THREADS,
        max_threads: HOST_TASK_BUDGET,
        idle_timeout: BLOCKING_WORKER_IDLE_TIMEOUT,
    }
}

pub(crate) fn build_tokio_runtime() -> Result<tokio::runtime::Runtime, Error> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(TOKIO_WORKER_THREADS)
        .enable_all()
        .build()
        .context("build sealed WASIX-postmaster Tokio runtime")
}

pub(crate) fn headless_engine(
    strict_directory: Option<(&Path, u64, u64)>,
) -> Result<Engine, Error> {
    // In a compiler-free build EngineBuilder cannot apply a new Features set;
    // the serialized artifact carries its compiled feature contract. The CLI
    // flags are compatibility assertions and sealed manifest admission checks
    // the exact {threads, exceptions} set before this engine activates bytes.
    let mut engine = Engine::headless();
    let memory_tunables = executor_tunables_for_target(engine.target())
        .context("derive sealed executor linear-memory profile")?;
    let (static_bound_pages, static_offset_guard_bytes) = derived_static_style(&memory_tunables, 0)
        .context("prove sealed executor linear-memory allocation style")?;
    tracing::debug!(
        linear_memory_profile_id = LinearMemoryProfile::embedded().id(),
        guest_maximum_pages = LinearMemoryProfile::embedded().maximum_pages(),
        static_bound_pages,
        static_offset_guard_bytes,
        "configure trap-preserving sealed linear-memory profile"
    );
    engine.set_tunables(memory_tunables);
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        let (directory, expected_device, expected_inode) = strict_directory.context(
            "Linux x86-64 sealed execution requires an explicit strict code-memory directory",
        )?;
        let policy = CodeMemoryPolicy::strict_linux_x86_64_file_backed(directory)
            .map_err(Error::msg)
            .with_context(|| {
                format!(
                    "configure strict file-backed code memory in {}",
                    directory.display()
                )
            })?;
        anyhow::ensure!(
            policy.id() == CODE_MEMORY_POLICY_ID,
            "strict code-memory policy identity drifted: {}",
            policy.id()
        );
        anyhow::ensure!(
            policy.pinned_directory_device() == Some(expected_device),
            "strict code-memory directory is not on the admitted carrier-state device"
        );
        anyhow::ensure!(
            policy.pinned_directory_inode() == Some(expected_inode),
            "strict code-memory directory changed identity before its descriptor was pinned"
        );
        tracing::debug!(
            code_memory_policy_id = policy.id(),
            code_memory_directory = %policy
                .pinned_directory()
                .expect("strict policy has a pinned directory")
                .display(),
            code_memory_directory_device = expected_device,
            code_memory_directory_inode = expected_inode,
            "configure sealed WASIX-postmaster code-memory ownership"
        );
        engine
            .set_code_memory_policy(policy)
            .map_err(Error::msg)
            .context("install strict code-memory policy before AOT deserialization")?;
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        anyhow::ensure!(
            strict_directory.is_none(),
            "strict Linux x86-64 code-memory directory was supplied on an unsupported platform"
        );
        tracing::debug!(
            code_memory_policy_id = "wasmer.code-memory.anonymous.v1",
            "configure portable sealed WASIX-postmaster code-memory ownership"
        );
    }
    Ok(engine)
}

pub(crate) fn configure_stack(stack_size: usize) -> ResourceLimits {
    wasmer_vm::set_stack_size(stack_size);
    ResourceLimits {
        stack: Some(((wasmer_vm::get_stack_size() as u64) / WASIX_STACK_RLIMIT_DIVISOR).max(1)),
    }
}

pub(crate) struct TtyRestoreGuard {
    tty: Arc<dyn TtyBridge + Send + Sync>,
    original: wasmer_wasix::WasiTtyState,
}

impl TtyRestoreGuard {
    fn new(tty: Arc<dyn TtyBridge + Send + Sync>) -> Self {
        Self {
            original: tty.tty_get(),
            tty,
        }
    }
}

impl Drop for TtyRestoreGuard {
    fn drop(&mut self) {
        self.tty.tty_set(self.original.clone());
    }
}

pub(crate) fn prepare_system_tty() -> (Arc<SysTty>, TtyRestoreGuard) {
    let tty = Arc::new(SysTty);
    let guard = TtyRestoreGuard::new(tty.clone());
    tty.reset();
    (tty, guard)
}

/// Runtime with no compiler, package resolver, registry, or HTTP client.
#[derive(Debug)]
pub(crate) struct SealedPostmasterRuntime {
    tasks: Arc<dyn VirtualTaskManager>,
    networking: DynVirtualNetworking,
    engine: Engine,
    module_cache: Arc<dyn ModuleCache + Send + Sync>,
    resource_limits: ResourceLimits,
    source: Arc<dyn Source + Send + Sync>,
    tty: Arc<SysTty>,
}

impl SealedPostmasterRuntime {
    pub(crate) fn new(
        handle: tokio::runtime::Handle,
        engine: Engine,
        module_cache: Arc<SealedModuleCache>,
        resource_limits: ResourceLimits,
        tty: Arc<SysTty>,
    ) -> Self {
        tracing::debug!(
            runtime_policy_id = POLICY_ID,
            async_worker_threads = TOKIO_WORKER_THREADS,
            host_task_budget = HOST_TASK_BUDGET,
            blocking_core_threads = BLOCKING_CORE_THREADS,
            blocking_worker_idle_timeout_ms = BLOCKING_WORKER_IDLE_TIMEOUT.as_millis(),
            "construct sealed WASIX-postmaster runtime"
        );
        let tasks: Arc<dyn VirtualTaskManager> = Arc::new(TokioTaskManager::new_with_config(
            handle,
            task_manager_config(),
        ));
        let networking: DynVirtualNetworking = Arc::new(LocalNetworking::default());
        Self {
            tasks,
            networking,
            engine,
            module_cache,
            resource_limits,
            source: Arc::new(MultiSource::default()),
            tty,
        }
    }
}

impl Runtime for SealedPostmasterRuntime {
    fn networking(&self) -> &DynVirtualNetworking {
        &self.networking
    }

    fn task_manager(&self) -> &Arc<dyn VirtualTaskManager> {
        &self.tasks
    }

    fn resource_limits(&self) -> ResourceLimits {
        self.resource_limits
    }

    fn module_cache(&self) -> Arc<dyn ModuleCache + Send + Sync> {
        self.module_cache.clone()
    }

    fn source(&self) -> Arc<dyn Source + Send + Sync> {
        self.source.clone()
    }

    fn engine(&self) -> Engine {
        self.engine.clone()
    }

    fn new_store(&self) -> Store {
        // `wasmer-wasix/sys-minimal` does not enable its broad `sys` cfg, so
        // relying on Runtime's default would construct a default store rather
        // than one tied to this exact admitted headless engine.
        Store::new(self.engine.clone())
    }

    fn tty(&self) -> Option<&(dyn TtyBridge + Send + Sync)> {
        Some(self.tty.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_policy_identity_is_stable() {
        assert_eq!(
            POLICY_ID,
            "oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2"
        );
        assert_eq!(TOKIO_WORKER_THREADS, 2);
        assert_eq!(HOST_TASK_BUDGET, 96);
        assert_eq!(
            CODE_MEMORY_POLICY_ID,
            "wasmer.code-memory.relocated-regular-file.linux-x86_64.v1"
        );
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn headless_product_engine_requires_the_exact_admitted_state_identity() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = tempfile::Builder::new()
            .prefix("oliphaunt-code-memory-engine-test-")
            .tempdir_in("/var/tmp")
            .unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let device = directory.path().metadata().unwrap().dev();
        let inode = directory.path().metadata().unwrap().ino();
        headless_engine(Some((directory.path(), device, inode))).unwrap();

        let error = headless_engine(Some((directory.path(), device.wrapping_add(1), inode)))
            .err()
            .expect("mismatched device must be rejected");
        assert!(error.to_string().contains("admitted carrier-state device"));

        let error = headless_engine(Some((directory.path(), device, inode.wrapping_add(1))))
            .err()
            .expect("mismatched inode must be rejected");
        assert!(error.to_string().contains("changed identity"));
    }

    #[test]
    fn runtime_has_exactly_two_tokio_workers() {
        let runtime = build_tokio_runtime().unwrap();
        assert_eq!(runtime.metrics().num_workers(), 2);
    }

    #[test]
    fn blocking_worker_growth_is_bounded_by_the_host_task_budget() {
        let owner = build_tokio_runtime().unwrap();
        let manager =
            TokioTaskManager::new_with_config(owner.handle().clone(), task_manager_config());

        assert_eq!(
            manager.config(),
            TokioTaskManagerConfig {
                core_threads: 1,
                max_threads: HOST_TASK_BUDGET,
                idle_timeout: Duration::from_millis(1_000),
            }
        );
    }

    #[test]
    fn owned_tokio_runtime_keeps_handle_consumers_live() {
        use wasmer_wasix::runtime::task_manager::VirtualTaskManagerExt as _;

        let owner = build_tokio_runtime().unwrap();
        let tasks = Arc::new(TokioTaskManager::new_with_config(
            owner.handle().clone(),
            task_manager_config(),
        ));
        let answer = tasks
            .spawn_and_block_on(async {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                42_u8
            })
            .unwrap();
        assert_eq!(answer, 42);
        drop(tasks);
        drop(owner);
    }

    #[test]
    fn tty_guard_restores_state_during_unwind() {
        use std::sync::Mutex;

        #[derive(Debug)]
        struct FakeTty(Mutex<wasmer_wasix::WasiTtyState>);

        impl TtyBridge for FakeTty {
            fn reset(&self) {}

            fn tty_get(&self) -> wasmer_wasix::WasiTtyState {
                self.0.lock().unwrap().clone()
            }

            fn tty_set(&self, state: wasmer_wasix::WasiTtyState) {
                *self.0.lock().unwrap() = state;
            }
        }

        let original = wasmer_wasix::WasiTtyState::default();
        let tty = Arc::new(FakeTty(Mutex::new(original.clone())));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let tty = tty.clone();
            move || {
                let _guard = TtyRestoreGuard::new(tty.clone());
                let mut changed = tty.tty_get();
                changed.echo = !changed.echo;
                tty.tty_set(changed);
                panic!("exercise unwind restoration");
            }
        }));
        assert!(result.is_err());
        assert_eq!(tty.tty_get(), original);
    }
}
