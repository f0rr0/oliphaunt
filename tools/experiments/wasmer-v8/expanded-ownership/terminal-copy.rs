// Detached copies retain bytes and attachments without cancelling their source.
use wasmer::{Instance, Memory, MemoryType, Module, Store, imports};

fn main() {
    let engine: wasmer::Engine = wasmer::v8::V8::new().into();
    let mut owner = Store::new(engine.clone());
    let memory = Memory::new(&mut owner, MemoryType::new(1, Some(1), true)).unwrap();
    let copy = memory.copy(&owner).unwrap();
    let mut child = Store::new(engine.clone());
    let attached = copy.clone().try_attach(&mut child).unwrap();
    let child_module = Module::new(&child, include_bytes!("terminal-wait.wasm")).unwrap();
    let module = Module::new(&owner, include_bytes!("terminal-wait.wasm")).unwrap();
    let instance = Instance::new(
        &mut owner,
        &module,
        &imports! { "env" => { "memory" => memory } },
    )
    .unwrap();
    let wait = instance
        .exports
        .get_typed_function::<i64, i32>(&owner, "wait")
        .unwrap();
    let ops = copy.ops();
    let signal = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        ops.terminate_execution_contexts().unwrap();
    });
    assert_eq!(wait.call(&mut owner, 100_000_000).unwrap(), 2);
    signal.join().unwrap();
    assert!(
        copy.clone()
            .try_attach(&mut Store::new(engine.clone()))
            .is_err()
    );
    assert!(
        Instance::new(
            &mut child,
            &child_module,
            &imports! { "env" => { "memory" => attached } }
        )
        .is_err()
    );

    let mut owner = Store::new(engine.clone());
    let memory = Memory::new(&mut owner, MemoryType::new(1, Some(3), true)).unwrap();
    memory.view(&owner).write(0, &[41]).unwrap();
    let shared = memory.as_shared(&owner).unwrap();
    let mut child = Store::new(engine);
    let attached = shared.try_attach(&mut child).unwrap();
    attached.view(&child).write(0, &[42]).unwrap();
    assert_eq!(memory.view(&owner).copy_range_to_vec(0..1).unwrap(), [42]);
    attached.grow(&mut child, 1).unwrap();
    assert_eq!(memory.size(&owner).0, 2);
    let copied = memory.copy(&owner).unwrap().try_attach(&mut child).unwrap();
    copied.view(&child).write(0, &[43]).unwrap();
    assert_eq!(memory.view(&owner).copy_range_to_vec(0..1).unwrap(), [42]);
    assert_eq!(copied.size(&child).0, 2);
    drop(memory);
    drop(owner);
    assert_eq!(attached.view(&child).copy_range_to_vec(0..1).unwrap(), [42]);
    println!(
        "terminal_copy=PASS source_wait=timeout child_entry=denied late_attach=denied shared_growth=preserved copy_bytes=independent owner_drop=safe"
    );
}
