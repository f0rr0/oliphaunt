use std::{error::Error, fmt, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use wasmer::{AsStoreMut, Function, FunctionType, Instance, Module, RuntimeError, Store, Type, Value, imports};

#[derive(Debug)]
struct Marker(Arc<AtomicUsize>);
impl fmt::Display for Marker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("owned host error marker") }
}
impl Error for Marker {}
impl Drop for Marker {
    fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); }
}

fn main() {
    let mut store = Store::new(wasmer::v8::V8::new());
    let module = Module::new(&store, r#"(module
      (func (export "fail") (param i32) (result i32) unreachable)
      (func (export "good") (param i32) (result i32) local.get 0))"#).unwrap();
    let instance = Instance::new(&mut store, &module, &imports! {}).unwrap();
    let fail = instance.exports.get_typed_function::<i32, i32>(&store, "fail").unwrap();
    let good = instance.exports.get_typed_function::<i32, i32>(&store, "good").unwrap();
    for index in 0..10_000 {
        let error = fail.call(&mut store, index).unwrap_err();
        assert!(error.to_string().contains("unreachable"));
        // Drop a trap discarded by WASIX reentry, and one discarded by a callback error.
        store.as_store_mut().on_called(|_| Ok(wasmer_types::OnCalledAction::InvokeAgain));
        assert!(fail.call(&mut store, index).unwrap_err().to_string().contains("unreachable"));
        store.as_store_mut().on_called(|_| Err("override callback error".into()));
        assert!(fail.call(&mut store, index).unwrap_err().to_string().contains("override callback error"));
        assert_eq!(good.call(&mut store, index).unwrap(), index);
    }
    let retained_error = fail.call(&mut store, 7).unwrap_err();
    drop(good); drop(fail); drop(instance); drop(module); drop(store);
    for _ in 0..10_000 { assert!(retained_error.to_string().contains("unreachable")); }
    println!("PASS guest traps: retry/discard/reuse; error formatted 10000 times after Store drop");

    for dynamic in [false, true] {
        let drops = Arc::new(AtomicUsize::new(0));
        let counter = drops.clone();
        let mut store = Store::new(wasmer::v8::V8::new());
        let callback = move || -> Result<i32, RuntimeError> {
            Err(RuntimeError::user(Box::new(Marker(counter.clone()))))
        };
        let host = if dynamic {
            Function::new(&mut store, FunctionType::new([], [Type::I32]),
                move |_| callback().map(|n| vec![Value::I32(n)]))
        } else { Function::new_typed(&mut store, callback) };
        let module = Module::new(&store, r#"(module
          (import "env" "host" (func $host (result i32)))
          (func (export "run") (result i32) call $host))"#).unwrap();
        let instance = Instance::new(&mut store, &module, &imports! { "env" => { "host" => host } }).unwrap();
        let run = instance.exports.get_typed_function::<(), i32>(&store, "run").unwrap();
        for index in 0..10_000 {
            let error = run.call(&mut store).unwrap_err();
            assert!(error.downcast_ref::<Marker>().is_some());
            assert_eq!(drops.load(Ordering::SeqCst), index);
            drop(error);
            assert_eq!(drops.load(Ordering::SeqCst), index + 1);
        }
        let error = run.call(&mut store).unwrap_err();
        drop(run); drop(instance); drop(module); drop(store);
        assert!(error.downcast_ref::<Marker>().is_some());
        assert_eq!(drops.load(Ordering::SeqCst), 10_000);
        drop(error);
        assert_eq!(drops.load(Ordering::SeqCst), 10_001);
        println!("PASS host traps dynamic={dynamic}: 10001 typed payloads each destroyed once, including after Store drop");
    }
}
