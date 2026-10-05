fn main() {
    #[cfg(windows)]
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    #[cfg(not(windows))]
    let engine: wasmer::Engine = wasmer::sys::EngineBuilder::headless().engine().into();
    #[cfg(windows)]
    let mut store = wasmer::Store::new(engine.clone());
    #[cfg(not(windows))]
    let store = wasmer::Store::new(engine.clone());
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = rt.enter();
    let tasks = std::sync::Arc::new(
        wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager::new(rt.handle().clone()),
    );
    let mut runtime = wasmer_wasix::PluggableRuntime::new(tasks);
    runtime.module_cache_only = true;
    runtime.set_engine(engine);
    let _signal = wasmer_wasix_types::wasi::Signal::Sigkill;
    #[cfg(windows)]
    {
        // Direct host calls verify the DLL dispatch and automatic Store capture.
        // This control does not compile a guest module.
        let function = wasmer::Function::new_typed(&mut store, |value: i32| value + 1);
        assert_eq!(
            function
                .typed::<i32, i32>(&store)
                .unwrap()
                .call(&mut store, 41)
                .unwrap(),
            42
        );
        let memory =
            wasmer::Memory::new(&mut store, wasmer::MemoryType::new(1, Some(1), true)).unwrap();
        let shared = memory.as_shared(&store).unwrap();
        let mut attached = wasmer::Store::new(store.engine().clone());
        let _memory = shared.clone().attach(&mut attached);
        drop(attached);
        drop(store);
        shared.disable_atomics().unwrap();
    }
    #[cfg(not(windows))]
    assert!(store.engine().is_sys());
    engine::write_dll(std::path::Path::new("reconstructed.dll")).unwrap();
    println!("aligned_family_consumer=PASS");
}
