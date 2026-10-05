use wasmer::{AsStoreMut, Instance, Module, Store, imports};

#[test]
fn numeric_arguments_survive_repeated_calls_and_reentry() {
    // Diagnostic compilation of a tiny fixture; product guests remain producer AOT.
    let wasm = &[0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 3, 2, 0, 0, 7, 22, 2, 7, 105, 110, 99, 95, 111, 110, 101, 0, 0, 8, 102, 97, 105, 108, 95, 111, 110, 101, 0, 1, 10, 13, 2, 7, 0, 32, 0, 65, 1, 106, 11, 3, 0, 0, 11];
    let mut store = Store::new(wasmer::v8::V8::new());
    let module = Module::new(&store, wasm).unwrap();
    let instance = Instance::new(&mut store, &module, &imports! {}).unwrap();
    let inc = instance.exports.get_typed_function::<i32, i32>(&store, "inc_one").unwrap();
    let fail = instance.exports.get_typed_function::<i32, i32>(&store, "fail_one").unwrap();
    for index in 0..100_000 {
        assert_eq!(inc.call(&mut store, index).unwrap(), index + 1);
    }
    for _ in 0..1_000 {
        store.as_store_mut().on_called(|_| Ok(wasmer_types::OnCalledAction::InvokeAgain));
        assert_eq!(inc.call(&mut store, 41).unwrap(), 42);
        assert!(fail.call(&mut store, 7).is_err());
        store.as_store_mut().on_called(|_| Ok(wasmer_types::OnCalledAction::Finish));
        assert_eq!(inc.call(&mut store, 41).unwrap(), 42);
        store.as_store_mut().on_called(|_| Err("diagnostic callback failure".into()));
        assert!(inc.call(&mut store, 41).is_err());
    }
    println!("PASS numeric argument ownership: 100000 ordinary calls; 1000 retry, finish, guest trap and callback error calls");
}
