// Tests the existing APIs with automatic Store/shared-memory lifetime hooks.
// There are no raw isolate handles, custom MemoryOps or manual retirement here.
use std::{panic::AssertUnwindSafe, sync::{Arc, Barrier, mpsc}, time::{Duration, Instant}};
use wasmer::{Function, Instance, Memory, MemoryType, Module, Store, imports};
use wasmer_wasix::{WasiEnv, wasmer_wasix_types::wasi::Signal};

fn cycle(engine: &wasmer::Engine, workers: usize, index: usize) {
    let mut store = Store::new(engine.clone());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&store).unwrap();
    // A second share of the same native memory must use the same kill state.
    let alias = memory.as_shared(&store).unwrap();
    let capture = Function::new_typed(&mut store, || {});
    let module = Module::new(&store, include_bytes!("atomic-wasix.wasm")).unwrap();
    let instance = Instance::new(&mut store, &module,
        &imports! { "env" => { "capture" => capture, "memory" => memory } }).unwrap();
    let mut env = WasiEnv::builder("automatic-interrupt-control")
        .engine(engine.clone()).finalize(&mut store).unwrap();
    env.initialize(&mut store, instance.clone()).unwrap();
    let process = env.data(&store).process.clone();
    process.register_memory(alias);
    let (ready, received) = mpsc::channel();
    let handles: Vec<_> = (0..workers).map(|_| {
        let shared = shared.clone();
        let engine = engine.clone();
        let ready = ready.clone();
        std::thread::spawn(move || {
            let mut store = Store::new(engine);
            let memory = shared.attach(&mut store);
            // Resharing an attached memory must preserve the original state.
            let reshare = memory.as_shared(&store).unwrap();
            let capture = Function::new_typed(&mut store, || {});
            let module = Module::new(&store, include_bytes!("atomic-wasix.wasm")).unwrap();
            let instance = Instance::new(&mut store, &module,
                &imports! { "env" => { "capture" => capture, "memory" => memory } }).unwrap();
            let wait = instance.exports.get_typed_function::<(), i32>(&store, "wait").unwrap();
            ready.send(()).unwrap();
            let start = Instant::now();
            let error = wait.call(&mut store).expect_err("WASIX kill must interrupt the wait");
            let elapsed = start.elapsed().as_millis();
            drop(wait); drop(instance); drop(module); drop(store);
            assert!(!error.to_string().is_empty());
            reshare.disable_atomics().unwrap();
            assert!(elapsed < 3000, "interruption took {elapsed}ms");
            elapsed
        })
    }).collect();
    for _ in 0..workers { received.recv_timeout(Duration::from_secs(5)).unwrap(); }
    std::thread::sleep(Duration::from_millis(250));
    process.signal_process(Signal::Sigkill);
    let elapsed: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let late = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut late_store = Store::new(engine.clone());
        shared.clone().attach(&mut late_store);
    }));
    assert!(late.is_err(), "disabled shared memory accepted a new attachment");
    env.data(&store).blocking_on_exit(Some(0.into()));
    let ops = shared.ops();
    drop(env); drop(instance); drop(module); drop(store); drop(shared);
    for _ in 0..100 {
        process.signal_process(Signal::Sigkill);
        ops.disable_atomics().unwrap();
    }
    println!("automatic_interrupt_cycle={index} workers={workers} elapsed_ms={elapsed:?} late_attach=REJECTED late_signals=PASS");
}

fn teardown_race(engine: &wasmer::Engine, index: usize) {
    let mut owner = Store::new(engine.clone());
    let memory = Memory::new(&mut owner, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&owner).unwrap();
    let ops = shared.ops();
    let barrier = Arc::new(Barrier::new(9));
    let handles: Vec<_> = (0..8).map(|_| {
        let barrier = barrier.clone();
        let engine = engine.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut store = Store::new(engine);
            let memory = shared.attach(&mut store);
            barrier.wait();
            drop(memory); drop(store);
        })
    }).collect();
    barrier.wait();
    drop(memory); drop(owner); drop(shared);
    for _ in 0..100 { ops.disable_atomics().unwrap(); }
    for handle in handles { handle.join().unwrap(); }
    // The operations handle deliberately outlives every native Store.
    ops.disable_atomics().unwrap();
    println!("automatic_teardown_race={index} stores=9 interrupts=101 result=PASS");
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _guard = runtime.enter();
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    for index in 1..=20 { cycle(&engine, 1, index); }
    for index in 21..=25 { cycle(&engine, 3, index); }
    for index in 1..=32 { teardown_race(&engine, index); }
    println!("automatic_store_interrupt=PASS wait_cycles=25 waiters=35 late_attach_rejections=25 post_teardown_signals=2500 teardown_races=32 race_stores=288");
}
