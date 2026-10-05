// Private signal-path control. Production must obtain capabilities from the
// Store embedding and retire them in Store teardown; the guest callback here
// supplies a capability without relying on native object layout.
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};
use wasmer::{Function, Instance, Memory, MemoryType, Module, Store, imports};
use wasmer_wasix::{WasiEnv, wasmer_wasix_types::wasi::Signal};

#[cfg(not(windows))]
unsafe extern "C" {
    #[link_name = "_ZN2v87Isolate10GetCurrentEv"]
    fn current_isolate() -> *mut std::ffi::c_void;
    #[link_name = "_ZN2v87Isolate18TerminateExecutionEv"]
    fn terminate_execution(isolate: *mut std::ffi::c_void);
}

#[cfg(windows)]
mod native {
    use std::{ffi::c_void, sync::OnceLock};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }
    type Current = unsafe extern "C" fn() -> *mut c_void;
    type Terminate = unsafe extern "C" fn(*mut c_void);
    pub fn methods() -> &'static (Current, Terminate) {
        static METHODS: OnceLock<(Current, Terminate)> = OnceLock::new();
        METHODS.get_or_init(|| unsafe {
            let name: Vec<u16> = "oliphaunt_wee8.dll\0".encode_utf16().collect();
            let module = GetModuleHandleW(name.as_ptr());
            assert!(!module.is_null());
            let current = GetProcAddress(module, b"?GetCurrent@Isolate@v8@@SAPEAV12@XZ\0".as_ptr());
            let terminate = GetProcAddress(module, b"?TerminateExecution@Isolate@v8@@QEAAXXZ\0".as_ptr());
            assert!(!current.is_null() && !terminate.is_null());
            (std::mem::transmute::<*mut c_void, Current>(current),
             std::mem::transmute::<*mut c_void, Terminate>(terminate))
        })
    }
}
#[cfg(windows)]
unsafe fn current_isolate() -> *mut std::ffi::c_void { unsafe { (native::methods().0)() } }
#[cfg(windows)]
unsafe fn terminate_execution(ptr: *mut std::ffi::c_void) { unsafe { (native::methods().1)(ptr) } }

struct Registry {
    disabled: bool,
    entries: Vec<Option<usize>>,
    interrupts: usize,
}
impl Registry {
    fn capture(&mut self, index: usize) {
        let ptr = unsafe { current_isolate() };
        assert!(!ptr.is_null());
        self.entries[index] = Some(ptr as usize);
        if self.disabled { unsafe { terminate_execution(ptr) }; self.interrupts += 1; }
    }
    fn kill(&mut self) {
        self.disabled = true;
        for ptr in self.entries.iter().flatten() {
            unsafe { terminate_execution(*ptr as *mut std::ffi::c_void) };
            self.interrupts += 1;
        }
    }
}

fn cycle(engine: &wasmer::Engine, workers: usize, stock: bool, index: usize) {
    let mut store = Store::new(engine.clone());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&store).unwrap();
    let capture = Function::new_typed(&mut store, || {});
    let module = Module::new(&store, include_bytes!("atomic-wasix.wasm")).unwrap();
    let instance = Instance::new(&mut store, &module,
        &imports! { "env" => { "capture" => capture, "memory" => memory } }).unwrap();
    let mut env = WasiEnv::builder("native-signal-registry-control")
        .engine(engine.clone()).finalize(&mut store).unwrap();
    env.initialize(&mut store, instance.clone()).unwrap();
    let process = env.data(&store).process.clone();
    let registry = Arc::new(Mutex::new(Registry {
        disabled: false, entries: vec![None; workers + 1], interrupts: 0,
    }));
    if stock { process.register_memory(shared.clone()); }
    else {
        let registry = registry.clone();
        process.register_memory(wasmer::MemoryOps::research_sigkill_bridge(Arc::new(move || {
            // Retirement and interruption hold the same lock. A disabled
            // registry also interrupts any subsequently attached isolate.
            registry.lock().unwrap().kill();
        })));
    }
    let worker = |number: usize| {
        let registry = registry.clone();
        let engine = engine.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut store = Store::new(engine);
            let memory = shared.attach(&mut store);
            let captured = registry.clone();
            let capture = Function::new_typed(&mut store, move || captured.lock().unwrap().capture(number));
            // Direct host-function calls enter this Store's isolate scope.
            // Acquire the initial capability before creating any guest module.
            if !registry.lock().unwrap().disabled {
                capture.call(&mut store, &[]).unwrap();
                assert!(registry.lock().unwrap().entries[number].is_some());
            }
            let module = Module::new(&store, include_bytes!("atomic-wasix.wasm")).unwrap();
            let instance = Instance::new(&mut store, &module,
                &imports! { "env" => { "capture" => capture, "memory" => memory } }).unwrap();
            let wait = instance.exports.get_typed_function::<(), i32>(&store, "wait").unwrap();
            let start = Instant::now();
            let error = wait.call(&mut store).expect_err("indefinite wait must be interrupted");
            let elapsed = start.elapsed().as_millis();
            // Retire while the Store is alive, then retain the error across teardown.
            registry.lock().unwrap().entries[number] = None;
            drop(wait); drop(instance); drop(module); drop(store);
            assert!(!error.to_string().is_empty());
            assert!(elapsed < 3000, "slow interruption: {elapsed}ms");
            elapsed
        })
    };
    let start = Instant::now();
    let handles: Vec<_> = (0..workers).map(worker).collect();
    while registry.lock().unwrap().entries[..workers].iter().any(Option::is_none) {
        assert!(start.elapsed() < Duration::from_secs(5), "isolate capture timeout");
        std::thread::sleep(Duration::from_millis(1));
    }
    std::thread::sleep(Duration::from_millis(250));
    process.signal_process(Signal::Sigkill);
    println!("wasix_sigkill_sent=true workers={workers} stock={stock}");
    let elapsed: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    // A newly attached isolate must also stop after the memory is disabled.
    let late_elapsed = worker(workers).join().unwrap();
    let registry_state = registry.lock().unwrap();
    assert!(registry_state.disabled && registry_state.entries.iter().all(Option::is_none));
    assert_eq!(registry_state.interrupts, workers + 1);
    drop(registry_state);
    env.data(&store).blocking_on_exit(Some(0.into()));
    drop(env); drop(instance); drop(module); drop(store); drop(shared);
    for _ in 0..100 { process.signal_process(Signal::Sigkill); }
    println!("signal_registry_cycle={index} workers={workers} elapsed_ms={elapsed:?} late_attach_ms={late_elapsed} late_signal_after_store_drop=PASS");
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _guard = runtime.enter();
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    if std::env::var_os("RESEARCH_ATOMIC_STOCK").is_some() { cycle(&engine, 1, true, 0); return; }
    for index in 1..=20 { cycle(&engine, 1, false, index); }
    for index in 21..=25 { cycle(&engine, 3, false, index); }
    println!("native_wasix_signal_registry=PASS single_cycles=20 three_waiter_cycles=5 late_attach=25 late_signals=2500");
}
