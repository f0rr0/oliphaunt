use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use wasmer::{Function, FunctionEnv, FunctionEnvMut, FunctionType, Instance, Module,
             RuntimeError, Store, Type, Value, imports};

struct PanicPayload(Arc<AtomicUsize>);
impl Drop for PanicPayload {
    fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); }
}

fn main() {
    // Count payload ownership without writing thousands of expected panic hooks.
    std::panic::set_hook(Box::new(|_| {}));
    let selected = std::env::args().nth(1).and_then(|s| s.parse::<usize>().ok());
    for style in 0..4 {
        if selected.is_some_and(|selected| selected != style) { continue; }
        let drops = Arc::new(AtomicUsize::new(0));
        let mut store = Store::new(wasmer::v8::V8::new());
        let counter = drops.clone();
        let env = FunctionEnv::new(&mut store, drops.clone());
        let host = match style {
            0 => Function::new_typed(&mut store, move |_: i32| -> Result<i32, RuntimeError> {
                std::panic::panic_any(PanicPayload(counter.clone()))
            }),
            1 => Function::new_typed_with_env(&mut store, &env,
                |env: FunctionEnvMut<Arc<AtomicUsize>>, _: i32| -> Result<i32, RuntimeError> {
                    std::panic::panic_any(PanicPayload(env.data().clone()))
                }),
            2 => Function::new(&mut store, FunctionType::new([Type::I32], [Type::I32]),
                move |_| -> Result<Vec<Value>, RuntimeError> {
                    std::panic::panic_any(PanicPayload(counter.clone()))
                }),
            3 => Function::new_with_env(&mut store, &env,
                FunctionType::new([Type::I32], [Type::I32]),
                |env: FunctionEnvMut<Arc<AtomicUsize>>, _| -> Result<Vec<Value>, RuntimeError> {
                    std::panic::panic_any(PanicPayload(env.data().clone()))
                }),
            _ => unreachable!(),
        };
        // Precompiled fixture: the SDK intentionally has no runtime WAT parser.
        let module = Module::new(&store, include_bytes!("panic-host.wasm")).unwrap();
        let instance = Instance::new(&mut store, &module,
                                     &imports! { "env" => { "host" => host } }).unwrap();
        let fail = instance.exports.get_typed_function::<i32,i32>(&store,"fail").unwrap();
        let dynamic = instance.exports.get_function("fail").unwrap().clone();
        let good = instance.exports.get_typed_function::<i32,i32>(&store,"good").unwrap();
        for index in 0..1_000 {
            let error = fail.call(&mut store,index).unwrap_err();
            assert!(error.to_string().contains("host function panicked"));
            assert_eq!(drops.load(Ordering::SeqCst), 2*index as usize+1);
            let error = dynamic.call(&mut store,&[Value::I32(index)]).unwrap_err();
            assert!(error.to_string().contains("host function panicked"));
            assert_eq!(drops.load(Ordering::SeqCst), 2*index as usize+2);
            assert_eq!(good.call(&mut store,index).unwrap(), index);
        }
        let retained = fail.call(&mut store,42).unwrap_err();
        drop(dynamic); drop(fail); drop(good); drop(instance); drop(module); drop(store);
        assert!(retained.to_string().contains("host function panicked"));
        assert_eq!(drops.load(Ordering::SeqCst),2_001);
        println!("callback_panic_style={style} typed_and_dynamic_calls=2000 payload_drops=2001 reuse=PASS error_after_store_drop=PASS");
    }
    println!("callback_panic_containment=PASS");
}
