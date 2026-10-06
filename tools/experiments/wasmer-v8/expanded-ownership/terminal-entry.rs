// Maintainer regression: terminal cancellation rejects every guest entry path.
use wasmer::{AsStoreMut, Instance, Memory, MemoryType, Module, OnCalledAction, Store, imports};

const MODULE: &[u8] = include_bytes!("terminal-call.wasm");
const START: &[u8] = include_bytes!("terminal-start.wasm");

fn check(scenario: &str) {
    let guarded = true;
    let mut store = Store::new(wasmer::v8::V8::new());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&store).unwrap();
    let module = Module::new(&store, MODULE).unwrap();
    let start = Module::new(&store, START).unwrap();
    let instance = Instance::new(
        &mut store,
        &module,
        &imports! { "env" => { "memory" => memory.clone() } },
    )
    .unwrap();

    if scenario.starts_with("retry-") || scenario.starts_with("finish-") {
        let ops = shared.ops();
        let finish = scenario.starts_with("finish-");
        store.as_store_mut().on_called(move |_| {
            ops.terminate_execution_contexts().unwrap();
            Ok(if finish {
                OnCalledAction::Finish
            } else {
                OnCalledAction::InvokeAgain
            })
        });
    } else {
        // Consume V8's one-shot termination before testing subsequent entry.
        let ops = shared.ops();
        let signal = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            ops.terminate_execution_contexts().unwrap();
        });
        let wait = instance
            .exports
            .get_typed_function::<i64, i32>(&store, "wait")
            .unwrap();
        assert!(wait.call(&mut store, 1_000_000_000).is_err());
        signal.join().unwrap();
    }

    let result = match scenario {
        "entry-typed" | "retry-typed" | "finish-typed" => instance
            .exports
            .get_typed_function::<(), ()>(&store, "bump")
            .unwrap()
            .call(&mut store),
        "entry-dynamic" | "retry-dynamic" | "finish-dynamic" => instance
            .exports
            .get_function("bump")
            .unwrap()
            .call(&mut store, &[])
            .map(|_| ()),
        "entry-start" => Instance::new(
            &mut store,
            &start,
            &imports! { "env" => { "memory" => memory.clone() } },
        )
        .map(|_| ())
        .map_err(|error| wasmer::RuntimeError::new(error.to_string())),
        _ => panic!(
            "choose entry-typed, entry-dynamic, entry-start, retry-typed, retry-dynamic, finish-typed or finish-dynamic"
        ),
    };
    let mut bytes = [0; 4];
    memory.view(&store).read(0, &mut bytes).unwrap();
    let writes = u32::from_le_bytes(bytes);
    let expected = if scenario.starts_with("retry-") {
        if guarded { 1 } else { 2 }
    } else if scenario.starts_with("finish-") {
        1
    } else if guarded {
        0
    } else {
        1
    };
    assert_eq!(writes, expected, "guest execution count");
    assert_eq!(
        result.is_err(),
        guarded,
        "terminal entry result: {result:?}"
    );
    println!("terminal_entry_review=PASS scenario={scenario} guarded={guarded} writes={writes}");
}

fn main() {
    for scenario in [
        "entry-typed",
        "entry-dynamic",
        "entry-start",
        "retry-typed",
        "retry-dynamic",
        "finish-typed",
        "finish-dynamic",
    ] {
        check(scenario);
    }
}
