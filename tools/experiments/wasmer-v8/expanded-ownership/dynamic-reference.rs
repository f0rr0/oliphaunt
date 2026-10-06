// Call-vector cleanup must preserve borrowed and returned function references.
use wasmer::{Instance, Module, Store, Value, imports};

fn main() {
    let mut store = Store::new(wasmer::v8::V8::new());
    let module = Module::new(&store, include_bytes!("dynamic-reference.wasm")).unwrap();
    let instance = Instance::new(&mut store, &module, &imports! {}).unwrap();
    let target = instance.exports.get_function("target").unwrap().clone();
    let identity = instance.exports.get_function("identity").unwrap();
    let consume = instance.exports.get_function("consume").unwrap();
    for _ in 0..1000 {
        assert!(matches!(
            consume
                .call(&mut store, &[Value::FuncRef(Some(target.clone()))])
                .unwrap()[0],
            Value::I32(7)
        ));
        assert_eq!(
            target
                .typed::<i32, i32>(&store)
                .unwrap()
                .call(&mut store, 41)
                .unwrap(),
            42
        );
        let result = identity
            .call(&mut store, &[Value::FuncRef(Some(target.clone()))])
            .unwrap();
        let Value::FuncRef(Some(returned)) = &result[0] else {
            panic!("function reference")
        };
        assert_eq!(
            returned
                .typed::<i32, i32>(&store)
                .unwrap()
                .call(&mut store, 41)
                .unwrap(),
            42
        );
        assert_eq!(
            target
                .typed::<i32, i32>(&store)
                .unwrap()
                .call(&mut store, 42)
                .unwrap(),
            43
        );
        assert!(matches!(
            identity.call(&mut store, &[Value::FuncRef(None)]).unwrap()[0],
            Value::FuncRef(None)
        ));
    }
    drop(instance);
    drop(target);
    drop(module);
    drop(store);
    println!(
        "dynamic_reference=PASS cycles=1000 borrowed_function=usable returned_function=usable null=preserved teardown=safe"
    );
}
