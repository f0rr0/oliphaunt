// Maintainer diagnostic: prints cancellation limits; it is not a parity gate.
use std::{
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use wasmer::{Function, Instance, Memory, MemoryType, Module, RuntimeError, Store, imports};

fn wait(store: &mut Store, memory: Memory) -> wasmer::TypedFunction<i64, i32> {
    let module = Module::new(&*store, "(module (import \"env\" \"memory\" (memory 1 1 shared)) (func (export \"wait\") (param i64) (result i32) i32.const 0 i32.const 0 local.get 0 memory.atomic.wait32))").unwrap();
    Instance::new(
        store,
        &module,
        &imports! { "env" => { "memory" => memory } },
    )
    .unwrap()
    .exports
    .get_typed_function(&*store, "wait")
    .unwrap()
}
fn signal_later(ops: wasmer::MemoryOps) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        ops.disable_atomics().unwrap();
    })
}

#[derive(Debug)]
struct Marker(Arc<AtomicUsize>);
impl fmt::Display for Marker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("typed marker")
    }
}
impl Error for Marker {}
impl Drop for Marker {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn main() {
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    match std::env::args().nth(1).as_deref() {
        Some("growth") => {
            let mut owner = Store::new(engine.clone());
            let memory = Memory::new(&mut owner, MemoryType::new(1, Some(3), true)).unwrap();
            memory.view(&owner).write(0, &[41]).unwrap();
            let shared = memory.as_shared(&owner).unwrap();
            let mut child = Store::new(engine);
            let attached = shared.try_attach(&mut child).unwrap();
            assert_eq!(attached.view(&child).copy_range_to_vec(0..1).unwrap(), [41]);
            attached.view(&child).write(0, &[42]).unwrap();
            assert_eq!(memory.view(&owner).copy_range_to_vec(0..1).unwrap(), [42]);
            assert_eq!(attached.grow(&mut child, 1).unwrap().0, 1);
            assert_eq!(memory.size(&owner).0, 2);
            let copy = memory.copy(&owner).unwrap();
            let copied = copy.try_attach(&mut child).unwrap();
            copied.view(&child).write(0, &[43]).unwrap();
            assert_eq!(memory.view(&owner).copy_range_to_vec(0..1).unwrap(), [42]);
            assert_eq!(copied.size(&child).0, 2);
            drop(memory);
            drop(owner);
            assert_eq!(attached.view(&child).copy_range_to_vec(0..1).unwrap(), [42]);
            println!(
                "public_api_growth=PASS shared_writes=true grown_pages=2 copy_independent=true owner_drop_safe=true"
            );
        }
        Some("copy-cancellation") => {
            let mut owner = Store::new(engine.clone());
            let memory = Memory::new(&mut owner, MemoryType::new(1, Some(1), true)).unwrap();
            let copy = memory.copy(&owner).unwrap();
            let ops = copy.ops();
            let mut child = Store::new(engine);
            let _attached = copy.try_attach(&mut child).unwrap();
            let original_wait = wait(&mut owner, memory);
            let signal = signal_later(ops);
            let result = original_wait.call(&mut owner, 1_000_000_000);
            signal.join().unwrap();
            println!(
                "public_api_copy_cancellation original_wait_trapped={} original_wait_result={result:?}",
                result.is_err()
            );
        }
        Some("memory-scope") => {
            let mut store = Store::new(engine);
            let first = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
            let second = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
            let first_shared = first.as_shared(&store).unwrap();
            let second_shared = second.as_shared(&store).unwrap();
            let second_wait = wait(&mut store, second);
            let signal = signal_later(first_shared.ops());
            let result = second_wait.call(&mut store, 1_000_000_000);
            signal.join().unwrap();
            println!(
                "public_api_memory_scope second_memory_wait_trapped={} second_memory_wait_result={result:?}",
                result.is_err()
            );
            drop(second_shared);
        }
        Some("repeat-wait") => {
            let mut store = Store::new(engine);
            let memory = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
            let shared = memory.as_shared(&store).unwrap();
            let function = wait(&mut store, memory);
            let signal = signal_later(shared.ops());
            let first = function.call(&mut store, 1_000_000_000);
            signal.join().unwrap();
            let second = function.call(&mut store, 100_000_000);
            println!(
                "public_api_repeat_wait first_trapped={} subsequent_wait_trapped={} subsequent_wait_result={second:?}",
                first.is_err(),
                second.is_err()
            );
        }
        Some("host-error") => {
            let drops = Arc::new(AtomicUsize::new(0));
            let counter = drops.clone();
            let mut store = Store::new(engine);
            let host = Function::new_typed(&mut store, move || -> Result<i32, RuntimeError> {
                Err(RuntimeError::user(Box::new(Marker(counter.clone()))))
            });
            let error = host
                .typed::<(), i32>(&store)
                .unwrap()
                .call(&mut store)
                .unwrap_err();
            let cloned = error.clone();
            assert!(error.downcast_ref::<Marker>().is_some());
            assert!(Error::source(&error).is_some());
            drop(host);
            drop(store);
            drop(error);
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            assert!(cloned.downcast_ref::<Marker>().is_some());
            assert_eq!(cloned.message(), "typed marker");
            assert!(Error::source(&cloned).is_some());
            drop(cloned);
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            println!(
                "public_api_host_error=PASS typed_downcast=true source_chain=true cloned_after_store_drop=true payload_drops=1"
            );
        }
        _ => panic!("choose growth, copy-cancellation, memory-scope, repeat-wait or host-error"),
    }
}
