use anyhow::Result;
use wasmer::{AsStoreMut, Function, FunctionEnv, FunctionEnvMut, Store, Type, TypedFunction};

fn main() -> Result<()> {
    assert!(wasmer_vm::remaining_execution_stack().is_none());
    let budget = wasmer_vm::get_stack_size() as u64;
    let mut store = Store::default();
    if !wasmer_vm::execution_stack_accounting_supported() {
        assert!(Function::new_execution_stack_remaining(&mut store).is_err());
        println!("PASS unsupported accounting rejected before guest instantiation");
        return Ok(());
    }
    let function = Function::new_execution_stack_remaining(&mut store)?;
    assert!(function.ty(&store).params().is_empty());
    assert_eq!(function.ty(&store).results(), &[Type::I64]);
    let typed = function.typed::<(), u64>(&store)?;
    for _ in 0..1000 {
        let remaining = typed.call(&mut store)?;
        assert!(remaining > budget / 2 && remaining < budget);
        let dynamic = function.call(&mut store, &[])?;
        let remaining = dynamic[0].i64().unwrap() as u64;
        assert!(remaining > budget / 2 && remaining < budget);
        assert!(wasmer_vm::remaining_execution_stack().is_none());
    }
    let env = FunctionEnv::new(&mut store, typed);
    let nested = Function::new_typed_with_env(
        &mut store,
        &env,
        |mut env: FunctionEnvMut<TypedFunction<(), u64>>| -> Result<u64, wasmer::RuntimeError> {
            let before = wasmer_vm::remaining_execution_stack();
            assert!(
                before.is_none(),
                "ordinary host callbacks must not get a stale guest sample"
            );
            let inner = env.data().clone();
            let remaining = inner.call(&mut env.as_store_mut())?;
            assert_eq!(wasmer_vm::remaining_execution_stack(), before);
            Ok(remaining)
        },
    )
    .typed::<(), u64>(&store)?;
    for _ in 0..1000 {
        let remaining = nested.call(&mut store)?;
        assert!(remaining > budget / 2 && remaining < budget);
        assert!(wasmer_vm::remaining_execution_stack().is_none());
    }
    println!(
        "PASS scalar typed/dynamic ABI and nested host/guest restoration: 1000 cycles each, stack={budget}"
    );
    Ok(())
}
