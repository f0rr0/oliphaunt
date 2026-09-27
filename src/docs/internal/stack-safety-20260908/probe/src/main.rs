use wasmer::{Function, Instance, Module, Store, imports};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut store = Store::default();
    let headroom = Function::new_execution_stack_remaining(&mut store)?;
    let compiled = Module::new(&store, include_str!("../probe.wat"))?;
    // The consumed runtime uses serialized AOT, so exercise that path too.
    let module = unsafe { Module::deserialize(&store, compiled.serialize()?)? };
    let instance = Instance::new(
        &mut store,
        &module,
        &imports! {"env" => {"headroom" => headroom}},
    )?;
    let run = instance
        .exports
        .get_typed_function::<i32, i32>(&store, "run")?;
    let rethrow = instance
        .exports
        .get_typed_function::<(), i32>(&store, "rethrow")?;
    for _ in 0..100 {
        assert_eq!(rethrow.call(&mut store)?, 42);
        assert_eq!(run.call(&mut store, 0)?, 42);
    }
    println!("PASS 100 serialized-AOT deep throw/catch and catch_ref/throw_ref cycles");
    // Approach the reserve with a measured descent, then enter a bounded descent
    // with no application checks. The engine must reject an unsafe throw.
    let mut terminal = None;
    for extra in (0..=2048).step_by(64) {
        match run.call(&mut store, extra) {
            Ok(value) => assert_eq!(value, 42),
            Err(error) => {
                assert_eq!(
                    error.clone().to_trap(),
                    Some(wasmer_vm::TrapCode::StackOverflow)
                );
                terminal = Some(extra);
                break;
            }
        }
    }
    let extra = terminal.expect("unchecked descent must eventually fail closed");
    assert_eq!(wasmer_vm::remaining_execution_stack(), None);
    println!("PASS terminal StackOverflow after {extra} unchecked frames; no database-reuse claim");
    Ok(())
}
