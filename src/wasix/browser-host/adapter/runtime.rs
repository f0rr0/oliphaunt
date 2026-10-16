use super::utils::Error;
use std::sync::Arc;
use wasmer_wasix::{PluggableRuntime, VirtualTaskManager};
/// Keep runtime configuration local to each direct instance or tool process.
/// No registry, networking or shared command pool participates in SQL calls.
pub(crate) type Runtime = PluggableRuntime;
pub(crate) fn runtime(tasks: Arc<dyn VirtualTaskManager>) -> Result<Runtime, Error> {
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_tty(Arc::new(wasmer_wasix::runtime::DefaultTty::default()));
    Ok(runtime)
}
