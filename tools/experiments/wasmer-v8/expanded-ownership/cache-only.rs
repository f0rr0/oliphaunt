use std::{borrow::Cow, sync::Arc};
use wasmer::{Engine, v8::V8};
use wasmer_wasix::{PluggableRuntime, Runtime, SpawnError};
use wasmer_wasix::runtime::{ModuleInput, OverriddenRuntime, module_cache::SharedCache,
    task_manager::tokio::TokioTaskManager};

fn main() {
    let tokio = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _guard = tokio.enter();
    let engine: Engine = V8::new().into();
    let mut runtime = PluggableRuntime::new(Arc::new(TokioTaskManager::new(tokio.handle().clone())));
    runtime.set_engine(engine.clone());
    runtime.set_module_cache(Arc::new(SharedCache::new()));
    runtime.module_cache_only = true;
    let inner: Arc<dyn Runtime + Send + Sync> = Arc::new(runtime);
    let overridden: Arc<dyn Runtime + Send + Sync> = Arc::new(
        OverriddenRuntime::new(inner.clone()).with_engine(engine.clone()));
    for (name, runtime) in [("direct", inner), ("overridden", overridden)] {
        let bytes = include_bytes!("atomic-wasix.wasm");
        let input = ModuleInput::Bytes(Cow::Borrowed(bytes));
        let hashed = input.to_hashed();
        for input in [input, ModuleInput::Hashed(Cow::Owned(hashed))] {
            let result = tokio.block_on(runtime.resolve_module(input, Some(&engine), None));
            assert!(matches!(result, Err(SpawnError::CacheError(_))), "cache miss compiled: {result:?}");
        }
        println!("cache_only_miss={name} bytes_and_hashed=PASS");
    }
    println!("cache_only_policy=PASS misses=4");
}
