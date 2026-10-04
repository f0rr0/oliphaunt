use std::{future::Future, pin::Pin, time::Duration};

use futures::future::BoxFuture;
use wasmer_wasix::{VirtualTaskManager, WasiThreadError, runtime::task_manager::TaskWasm};

/// A deliberately single-realm task manager for synchronous guest calls.
///
/// PostgreSQL's direct protocol pump never yields control back to JavaScript
/// while a guest export is running. Timers therefore have to complete during
/// their first poll, while operations that require another WASM execution
/// context fail explicitly instead of being queued behind the blocked realm.
#[derive(Debug, Default)]
pub(crate) struct CallerRealmTaskManager;

#[async_trait::async_trait]
impl VirtualTaskManager for CallerRealmTaskManager {
    fn sleep_now(
        &self,
        duration: Duration,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + Sync + 'static>> {
        let deadline = instant::Instant::now() + duration;
        Box::pin(async move {
            while instant::Instant::now() < deadline {
                std::hint::spin_loop();
            }
        })
    }

    fn task_shared(
        &self,
        _task: Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        Err(WasiThreadError::Unsupported)
    }

    fn task_wasm(&self, _task: TaskWasm) -> Result<(), WasiThreadError> {
        Err(WasiThreadError::Unsupported)
    }

    fn task_dedicated(
        &self,
        _task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        Err(WasiThreadError::Unsupported)
    }

    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        Ok(1)
    }
}
