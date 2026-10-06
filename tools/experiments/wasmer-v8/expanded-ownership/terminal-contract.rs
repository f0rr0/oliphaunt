// Maintainer regression: explicit terminal WASIX shutdown, unsupported general atomics.
use wasmer::{AtomicsError, Instance, Memory, MemoryType, Module, Store, imports};
use wasmer_wasix::{WasiEnv, wasmer_wasix_types::wasi::Signal};

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = runtime.enter();
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    let mut store = Store::new(engine.clone());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&store).unwrap();
    let module = Module::new(&store, include_bytes!("terminal-wait.wasm")).unwrap();
    let instance = Instance::new(
        &mut store,
        &module,
        &imports! { "env" => { "memory" => memory } },
    )
    .unwrap();
    let wait = instance
        .exports
        .get_typed_function::<i64, i32>(&store, "wait")
        .unwrap();
    assert!(matches!(
        shared.disable_atomics(),
        Err(AtomicsError::Unimplemented)
    ));
    assert_eq!(wait.call(&mut store, 1_000_000).unwrap(), 2);

    let mut env = WasiEnv::builder("terminal-contract-review")
        .engine(engine.clone())
        .finalize(&mut store)
        .unwrap();
    env.initialize(&mut store, instance.clone()).unwrap();
    let process = env.data(&store).process.clone();
    process.register_memory(shared.clone());
    let signal = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        process.signal_process(Signal::Sigkill);
    });
    assert!(wait.call(&mut store, 1_000_000_000).is_err());
    signal.join().unwrap();
    assert!(wait.call(&mut store, 1_000_000).is_err());
    let mut late = Store::new(engine);
    assert!(shared.clone().try_attach(&mut late).is_err());
    let ops = shared.ops();
    env.data(&store).blocking_on_exit(Some(1.into()));
    drop(env);
    drop(wait);
    drop(instance);
    drop(module);
    drop(store);
    drop(shared);
    ops.terminate_execution_contexts().unwrap();
    println!(
        "terminal_contract_review=PASS atomics=unimplemented ordinary_wait=timeout sigkill=interrupted reentry=denied late_attach=denied late_cancel=safe"
    );
}
