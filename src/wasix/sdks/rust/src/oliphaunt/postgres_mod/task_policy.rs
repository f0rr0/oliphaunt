use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use wasmer::{Memory, Module, StoreMut};
use wasmer_wasix::WasiEnvBuilder;
use wasmer_wasix::WasiThreadError;
use wasmer_wasix::runtime::task_manager::{SpawnType, TaskWasm, VirtualTaskManager};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GuestWasmTasks {
    Allow,
    Deny,
}

impl GuestWasmTasks {
    pub(super) fn apply(
        self,
        task_manager: Arc<dyn VirtualTaskManager>,
    ) -> Arc<dyn VirtualTaskManager> {
        match self {
            Self::Allow => task_manager,
            Self::Deny => Arc::new(SingleBackendTaskManager::new(task_manager)),
        }
    }
}

/// Prevent process/vfork allocation before it can mutate the guest process
/// tree. The task-manager gate below also covers thread creation and remains
/// authoritative for every path that would execute another Wasm context.
pub(super) fn constrain_single_backend_tasks(builder: &mut WasiEnvBuilder) {
    builder.capabilities_mut().threading.max_threads = Some(1);
}

/// Keeps host-side asynchronous work available while preventing a shared
/// single-backend database from creating another guest execution context.
#[derive(Debug)]
pub(super) struct SingleBackendTaskManager {
    inner: Arc<dyn VirtualTaskManager>,
}

impl SingleBackendTaskManager {
    pub(super) fn new(inner: Arc<dyn VirtualTaskManager>) -> Self {
        Self { inner }
    }

    fn reject_guest_wasm_task<T>(_task: T) -> Result<(), WasiThreadError> {
        Err(WasiThreadError::Unsupported)
    }
}

impl VirtualTaskManager for SingleBackendTaskManager {
    fn build_memory(
        &self,
        store: &mut StoreMut,
        spawn_type: SpawnType,
    ) -> Result<Option<Memory>, WasiThreadError> {
        self.inner.build_memory(store, spawn_type)
    }

    fn sleep_now(
        &self,
        time: Duration,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + Sync + 'static>> {
        self.inner.sleep_now(time)
    }

    fn task_shared(
        &self,
        task: Box<
            dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> + Send + 'static,
        >,
    ) -> Result<(), WasiThreadError> {
        self.inner.task_shared(task)
    }

    fn task_wasm(&self, task: TaskWasm) -> Result<(), WasiThreadError> {
        Self::reject_guest_wasm_task(task)
    }

    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.inner.task_dedicated(task)
    }

    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        Ok(1)
    }

    fn spawn_with_module(
        &self,
        module: Module,
        task: Box<dyn FnOnce(Module) + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        Self::reject_guest_wasm_task((module, task))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Weak;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::task::{Context, Wake, Waker};

    use anyhow::Result;
    use wasmer_types::ModuleHash;
    use wasmer_wasix::os::task::thread::WasiMemoryLayout;
    use wasmer_wasix::runtime::task_manager::VirtualTaskManager;
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
    use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
    use wasmer_wasix::wasmer_wasix_types::{types::Signal, wasix::ThreadStartType};
    use wasmer_wasix::{WasiControlPlane, WasiEnv, WasiThreadHandle};

    use super::*;

    fn task_managers() -> Result<(
        tokio::runtime::Runtime,
        Arc<dyn VirtualTaskManager>,
        SingleBackendTaskManager,
    )> {
        let runtime = tokio::runtime::Builder::new_multi_thread().build()?;
        let inner: Arc<dyn VirtualTaskManager> =
            Arc::new(TokioTaskManager::new(runtime.handle().clone()));
        let policy = SingleBackendTaskManager::new(inner.clone());
        Ok((runtime, inner, policy))
    }

    #[test]
    fn host_tasks_are_delegated() -> Result<()> {
        let (_runtime, _inner, policy) = task_managers()?;
        let (shared_tx, shared_rx) = mpsc::channel();
        policy.task_shared(Box::new(move || {
            Box::pin(async move {
                shared_tx.send(()).expect("shared task receiver is alive");
            })
        }))?;

        let (dedicated_tx, dedicated_rx) = mpsc::channel();
        policy.task_dedicated(Box::new(move || {
            dedicated_tx
                .send(())
                .expect("dedicated task receiver is alive");
        }))?;

        shared_rx.recv_timeout(Duration::from_secs(2))?;
        dedicated_rx.recv_timeout(Duration::from_secs(2))?;
        assert_eq!(policy.thread_parallelism()?, 1);
        Ok(())
    }

    #[test]
    fn guest_wasm_entrypoints_share_a_fail_closed_gate() {
        let task_ran = Arc::new(AtomicBool::new(false));
        let task_ran_in_guest = task_ran.clone();
        let error = SingleBackendTaskManager::reject_guest_wasm_task(Box::new(move || {
            task_ran_in_guest.store(true, Ordering::SeqCst);
        }))
        .expect_err("guest task_wasm must be denied");
        assert!(matches!(error, WasiThreadError::Unsupported));
        assert!(!task_ran.load(Ordering::SeqCst));

        let module_task_ran = Arc::new(AtomicBool::new(false));
        let module_task_ran_in_guest = module_task_ran.clone();
        let error = SingleBackendTaskManager::reject_guest_wasm_task(Box::new(move || {
            module_task_ran_in_guest.store(true, Ordering::SeqCst);
        }))
        .expect_err("guest spawn_with_module must be denied");
        assert!(matches!(error, WasiThreadError::Unsupported));
        assert!(!module_task_ran.load(Ordering::SeqCst));
    }

    #[test]
    fn process_forks_are_rejected_before_allocation() -> Result<()> {
        let (tokio_runtime, inner, _policy) = task_managers()?;
        let _guard = tokio_runtime.enter();
        let runtime: Arc<dyn Runtime + Send + Sync> = Arc::new(PluggableRuntime::new(inner));
        let mut builder = WasiEnv::builder("single-backend-task-policy-test");
        builder.set_runtime(runtime);
        constrain_single_backend_tasks(&mut builder);
        let env = builder.build()?;

        assert!(env.fork().is_err());
        Ok(())
    }

    struct SignalWake {
        thread: Weak<WasiThreadHandle>,
        wakes: AtomicUsize,
        registry_unlocked: AtomicBool,
    }

    impl SignalWake {
        fn new(thread: &Arc<WasiThreadHandle>) -> Arc<Self> {
            Arc::new(Self {
                thread: Arc::downgrade(thread),
                wakes: AtomicUsize::new(0),
                registry_unlocked: AtomicBool::new(false),
            })
        }
    }

    impl Wake for SignalWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            let thread = self.thread.upgrade().unwrap();
            self.registry_unlocked
                .store(thread.signals().try_lock().is_ok(), Ordering::SeqCst);
            self.wakes.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn signal_waits_release_only_their_registration() {
        let plane = WasiControlPlane::default();
        let process = plane.new_process(ModuleHash::random()).unwrap();
        let thread = Arc::new(
            process
                .new_thread(WasiMemoryLayout::default(), ThreadStartType::MainThread)
                .unwrap(),
        );

        for _ in 0..1_000 {
            let waker = Waker::from(SignalWake::new(&thread));
            let mut wait = Box::pin(thread.wait_for_signal());
            assert!(
                wait.as_mut()
                    .poll(&mut Context::from_waker(&waker))
                    .is_pending()
            );
        }
        assert_eq!(thread.signals().lock().unwrap().1.len(), 0);

        let counter_a = SignalWake::new(&thread);
        let counter_b = SignalWake::new(&thread);
        let waker_a = Waker::from(counter_a.clone());
        let waker_b = Waker::from(counter_b.clone());
        let mut first = Box::pin(thread.wait_for_signal());
        let mut second = Box::pin(thread.wait_for_signal());
        assert!(
            first
                .as_mut()
                .poll(&mut Context::from_waker(&waker_a))
                .is_pending()
        );
        assert!(
            second
                .as_mut()
                .poll(&mut Context::from_waker(&waker_a))
                .is_pending()
        );
        assert!(
            first
                .as_mut()
                .poll(&mut Context::from_waker(&waker_b))
                .is_pending()
        );
        assert_eq!(thread.signals().lock().unwrap().1.len(), 2);
        drop(first);

        thread.signal(Signal::Sigwakeup);
        assert_eq!(counter_a.wakes.load(Ordering::SeqCst), 1);
        assert_eq!(counter_b.wakes.load(Ordering::SeqCst), 0);
        assert!(counter_a.registry_unlocked.load(Ordering::SeqCst));
        assert!(
            second
                .as_mut()
                .poll(&mut Context::from_waker(&waker_a))
                .is_ready()
        );
        drop(second);
        assert_eq!(thread.signals().lock().unwrap().1.len(), 0);
        assert_eq!(thread.pop_signals(), vec![Signal::Sigwakeup]);

        thread.signals_subscribe(&waker_b);
        thread.signals_subscribe(&waker_b);
        assert_eq!(thread.signals().lock().unwrap().1.len(), 1);
        thread.signal(Signal::Sigwakeup);
        assert_eq!(counter_b.wakes.load(Ordering::SeqCst), 1);
        assert!(counter_b.registry_unlocked.load(Ordering::SeqCst));
        assert_eq!(thread.signals().lock().unwrap().1.len(), 0);
    }
}
