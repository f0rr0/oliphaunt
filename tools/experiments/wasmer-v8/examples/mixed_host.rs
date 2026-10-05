use anyhow::{Result, ensure};
use wasmer::{Instance, Module, Store, imports};

#[link(name = "probe_host", kind = "static")]
unsafe extern "C" {
    fn probe_host_map() -> u32;
}

fn main() -> Result<()> {
    let mut store = Store::new(wasmer::v8::V8::new());
    let module = Module::new(
        &store,
        "(module (func (export \"value\") (result i32) i32.const 42))",
    )?;
    let instance = Instance::new(&mut store, &module, &imports! {})?;
    ensure!(
        instance
            .exports
            .get_typed_function::<(), i32>(&store, "value")?
            .call(&mut store)?
            == 42
    );
    ensure!(
        unsafe { probe_host_map() } == 0,
        "V8 linkage corrupted an ordinary MSVC unordered_map"
    );
    println!("PASS mixed native C++ library coexistence");
    Ok(())
}
