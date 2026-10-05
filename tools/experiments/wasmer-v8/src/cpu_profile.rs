//! Research only. Product delivery needs a C bridge and pregenerated bindings.
#[cfg(feature = "wasix")]
use anyhow::Context;
use anyhow::{Result, ensure};
use wasmer::{Instance, Module, Store, imports};

// Verified against the pinned 11.9.7 Linux and Windows archives with llvm-nm.
// Both are public static C++ functions with no implicit `this` argument.
unsafe extern "C" {
    #[cfg_attr(target_os = "linux", link_name = "_ZN2v82V818SetFlagsFromStringEPKcm")]
    #[cfg_attr(
        target_os = "windows",
        link_name = "?SetFlagsFromString@V8@v8@@SAXPEBD_K@Z"
    )]
    fn set_v8_flags(flags: *const u8, len: usize);
}

const BASELINE: &str = "--mcpu=generic --no-enable-sse4-2 --no-enable-sahf --no-enable-avx --no-enable-avx2 --no-enable-avx-vnni --no-enable-avx-vnni-int8 --no-enable-fma3 --no-enable-f16c --no-enable-bmi1 --no-enable-bmi2 --no-enable-lzcnt --no-enable-popcnt";
const WAT: &str = r#"(module
  (tag $error (param i32))
  (func (export "catch") (result i32)
    (block $caught (result i32)
      (try_table (result i32) (catch $error $caught)
        i32.const 42 throw $error)))
  (func (export "simd") (result i32)
    v128.const i32x4 1 2 3 4
    v128.const i32x4 4 3 2 1
    i32x4.add
    i32x4.extract_lane 2))"#;

pub fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(2).collect();
    ensure!(
        args.len() >= 3,
        "expected cpu-profile baseline|default write|read CACHE [POSTGRES_WASM]"
    );
    let mode = args[0].as_str();
    ensure!(
        mode == "baseline" || mode == "default",
        "unknown CPU profile"
    );
    ensure!(args[1] == "write" || args[1] == "read", "unknown operation");
    // V8 initialization is process-wide. This must precede even the first engine.
    if mode == "baseline" {
        unsafe { set_v8_flags(BASELINE.as_ptr(), BASELINE.len()) };
    }
    let mut store = Store::new(super::engine());
    let bytes = if args[1] == "write" {
        Module::new(&store, WAT)?.serialize()?.to_vec()
    } else {
        // The reader never compiles a module, including the header probe.
        std::fs::read(&args[2])?
    };
    let offsets: Vec<_> = bytes
        .windows(20)
        .enumerate()
        .filter_map(|(i, b)| (b[2..4] == [0xde, 0xc0]).then_some(i))
        .collect();
    ensure!(offsets.len() == 1, "ambiguous native header: {offsets:?}");
    let offset = offsets[0];
    let header: Vec<_> = bytes[offset..offset + 20]
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    println!(
        "mode={mode} operation={} artifact_cpu_features={:#x} flag_hash={:#x} native_header={header:?}",
        args[1], header[2], header[3]
    );
    if mode == "baseline" && args[1] == "write" {
        // SSE4.1 + SSSE3 + SSE3; leave JCC mitigation and CETSS enabled.
        ensure!(header[2] & !0x18000 == 0xe, "unexpected normalized mask");
    }
    if args[1] == "write" {
        std::fs::write(&args[2], &bytes)?;
        std::fs::write(format!("{}.header", args[2]), format!("{header:?}\n"))?;
    }
    let loaded = unsafe { Module::deserialize(&store, &bytes)? };
    let instance = Instance::new(&mut store, &loaded, &imports! {})?;
    let caught = instance
        .exports
        .get_typed_function::<(), i32>(&store, "catch")?
        .call(&mut store)?;
    let simd = instance
        .exports
        .get_typed_function::<(), i32>(&store, "simd")?
        .call(&mut store)?;
    ensure!(caught == 42 && simd == 5, "unexpected guest result");
    println!(
        "serialized_eh={caught} serialized_simd={simd} bytes={}",
        bytes.len()
    );
    if let Some(path) = args.get(3) {
        let cache = format!("{}.postgres.cache", args[2]);
        let postgres = if args[1] == "write" {
            let wasm = std::fs::read(path)?;
            let bytes = Module::new(&store, wasm)?.serialize()?.to_vec();
            std::fs::write(&cache, &bytes)?;
            bytes
        } else {
            std::fs::read(&cache)?
        };
        let module = unsafe { Module::deserialize(&store, &postgres)? };
        println!(
            "actual_postgres_serialized_bytes={} imports={} exports={}",
            postgres.len(),
            module.imports().count(),
            module.exports().count()
        );
        #[cfg(feature = "wasix")]
        {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let _guard = runtime.enter();
            let (_inst, env) = wasmer_wasix::WasiEnv::builder("postgres")
                .engine(store.engine().clone())
                .instantiate(module, &mut store)
                .context("instantiate fixed-profile PostgreSQL through WASIX")?;
            env.on_exit(&mut store, None);
            println!("actual_postgres_wasix_instantiation=pass (no SQL execution)");
        }
    }
    Ok(())
}
