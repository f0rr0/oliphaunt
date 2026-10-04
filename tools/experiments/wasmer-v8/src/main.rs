use std::{path::Path, sync::Arc, time::Instant};

use anyhow::{Context, Result, bail, ensure};
use wasmer::{
    Engine, Exception, Function, Instance, Memory, MemoryType, Module, RuntimeError, Store, Tag,
    Value, imports,
};

const EH: &str = r#"(module
  (tag $error (export "error") (param i32))
  (func $throw (export "throw") (param i32) (result i32)
    local.get 0 throw $error)
  (table 1 funcref)
  (elem (i32.const 0) $throw)
  (type $unary (func (param i32) (result i32)))
  (func (export "catch") (param i32) (result i32)
    (block $caught (result i32)
      (try_table (result i32) (catch $error $caught)
        local.get 0 call $throw)))
  (func (export "indirect") (param i32) (result i32)
    (block $caught (result i32)
      (try_table (result i32) (catch $error $caught)
        local.get 0 i32.const 0 call_indirect (type $unary))))
  (func (export "rethrow") (param i32) (result i32)
    (block $outer (result i32)
      (try_table (result i32) (catch $error $outer)
        (block $inner (result exnref)
          (try_table (result exnref) (catch_all_ref $inner)
            local.get 0 throw $error))
        throw_ref)))
  (func (export "simple") (result i32) i32.const 42))"#;

fn engine() -> Engine {
    wasmer::v8::V8::new().into()
}

fn instance(store: &mut Store, wat: &str, imports: &wasmer::Imports) -> Result<Instance> {
    eprintln!("stage: compile");
    let module = Module::new(&*store, wat).context("compile guest")?;
    eprintln!("stage: instantiate");
    Instance::new(store, &module, imports).context("instantiate guest")
}

fn check_eh(store: &mut Store, instance: &Instance) -> Result<()> {
    let simple = instance
        .exports
        .get_typed_function::<(), i32>(store, "simple")?;
    for name in ["catch", "indirect", "rethrow"] {
        eprintln!("stage: {name}");
        let run = instance
            .exports
            .get_typed_function::<i32, i32>(store, name)?;
        for n in 0..100 {
            ensure!(run.call(store, n)? == n, "exception payload changed");
            ensure!(simple.call(store)? == 42, "subsequent call failed");
        }
    }
    Ok(())
}

fn shared_memory(cross_thread: bool) -> Result<()> {
    let engine = engine();
    let mut store = Store::new(engine.clone());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(4), true))?;
    let wat = r#"(module
      (import "env" "memory" (memory 1 4 shared))
      (func (export "add") (result i32)
        i32.const 0 i32.const 1 i32.atomic.rmw.add)
      (func (export "load") (result i32) i32.const 0 i32.atomic.load)
      (func (export "grow") (result i32) i32.const 1 memory.grow))"#;
    let module = Module::new(&store, wat)?;
    let inst = Instance::new(
        &mut store,
        &module,
        &imports! { "env" => {"memory" => memory.clone()} },
    )?;
    let add = inst.exports.get_typed_function::<(), i32>(&store, "add")?;
    ensure!(add.call(&mut store)? == 0);
    if cross_thread {
        let shared = memory.as_shared(&store).context("shared memory handle")?;
        // Construct each store on its owning thread. Moving an existing V8 store
        // is a separate diagnostic, not a supported execution strategy.
        let worker = std::thread::spawn(move || -> Result<()> {
            let mut worker_store = Store::new(engine);
            let memory = shared.attach(&mut worker_store);
            let inst = Instance::new(
                &mut worker_store,
                &module,
                &imports! { "env" => {"memory" => memory} },
            )?;
            let add = inst
                .exports
                .get_typed_function::<(), i32>(&worker_store, "add")?;
            for n in 1..101 {
                ensure!(add.call(&mut worker_store)? == n);
            }
            Ok(())
        });
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("memory worker panicked"))??;
        let load = inst.exports.get_typed_function::<(), i32>(&store, "load")?;
        ensure!(
            load.call(&mut store)? == 101,
            "shared writes were not visible"
        );
    } else {
        let grow = inst.exports.get_typed_function::<(), i32>(&store, "grow")?;
        ensure!(grow.call(&mut store)? == 1);
        memory.view(&store).write(65_536, b"after-growth")?;
        let mut bytes = [0; 12];
        memory.view(&store).read(65_536, &mut bytes)?;
        ensure!(&bytes == b"after-growth");
        ensure!(memory.view(&store).size().0 == 2);
    }
    Ok(())
}

fn cross_module() -> Result<()> {
    let mut store = Store::new(engine());
    let origin = instance(&mut store, EH, &imports! {})?;
    let tag = origin.exports.get::<Tag>("error")?.clone();
    let side = instance(
        &mut store,
        r#"(module
      (import "env" "error" (tag $error (param i32)))
      (func (export "throw") (param i32) (result i32) local.get 0 throw $error))"#,
        &imports! { "env" => {"error" => tag.clone()} },
    )?;
    let throw = side.exports.get_function("throw")?.clone();
    let caller = instance(
        &mut store,
        r#"(module
      (import "env" "error" (tag $error (param i32)))
      (import "env" "throw" (func $throw (param i32) (result i32)))
      (func (export "catch") (param i32) (result i32)
        (block $caught (result i32)
          (try_table (result i32) (catch $error $caught) local.get 0 call $throw))))"#,
        &imports! { "env" => {"error" => tag, "throw" => throw} },
    )?;
    let catch = caller
        .exports
        .get_typed_function::<i32, i32>(&store, "catch")?;
    for n in 0..100 {
        ensure!(catch.call(&mut store, n)? == n);
    }
    Ok(())
}

fn callback(panic: bool, dynamic: bool, contain_panic: bool) -> Result<()> {
    let mut store = Store::new(engine());
    let fail = move || -> Result<i32, RuntimeError> {
        if panic {
            let trigger = || -> i32 { panic!("intentional isolated host callback panic") };
            if contain_panic {
                return std::panic::catch_unwind(trigger).map_err(|_| {
                    RuntimeError::new("intentional host error marker: contained panic")
                });
            }
            return Ok(trigger());
        }
        Err(RuntimeError::new("intentional host error marker"))
    };
    let host = if dynamic {
        Function::new(
            &mut store,
            wasmer::FunctionType::new([], [wasmer::Type::I32]),
            move |_| fail().map(|n| vec![Value::I32(n)]),
        )
    } else {
        Function::new_typed(&mut store, fail)
    };
    let inst = instance(
        &mut store,
        r#"(module
      (import "env" "host" (func $host (result i32)))
      (func (export "run") (result i32) call $host)
      (func (export "simple") (result i32) i32.const 42))"#,
        &imports! { "env" => {"host" => host} },
    )?;
    let run = inst.exports.get_typed_function::<(), i32>(&store, "run")?;
    let error = run.call(&mut store).expect_err("callback must fail");
    ensure!(
        error.to_string().contains("intentional host error marker"),
        "host error lost: {error}"
    );
    ensure!(
        inst.exports
            .get_typed_function::<(), i32>(&store, "simple")?
            .call(&mut store)?
            == 42
    );
    Ok(())
}

fn host_atomics() -> Result<()> {
    let mut store = Store::new(engine());
    let memory = Memory::new(&mut store, MemoryType::new(1, Some(4), true))?;
    let shared = memory.as_shared(&store).context("shared memory handle")?;
    let results = [
        ("notify", shared.notify(0u32.into(), 1).map(|_| ())),
        (
            "wait",
            shared
                .wait(0u32.into(), Some(std::time::Duration::from_millis(1)))
                .map(|_| ()),
        ),
        ("wake_all", shared.wake_all_atomic_waiters()),
        ("disable_atomics", shared.disable_atomics()),
    ];
    for (name, result) in &results {
        println!("host_atomics_{name}={result:?}");
    }
    ensure!(
        results.iter().all(|(_, r)| r.is_ok()),
        "host atomic operations unavailable"
    );
    Ok(())
}

fn host_error_identity(dynamic: bool) -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[derive(Debug)]
    struct Marker(Arc<AtomicUsize>);
    impl std::fmt::Display for Marker {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("typed host error marker")
        }
    }
    impl std::error::Error for Marker {}
    impl Drop for Marker {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let destroyed = Arc::new(AtomicUsize::new(0));
    let counter = destroyed.clone();
    let mut store = Store::new(engine());
    let fail = move || -> Result<i32, RuntimeError> {
        Err(RuntimeError::user(Box::new(Marker(counter.clone()))))
    };
    let host = if dynamic {
        Function::new(
            &mut store,
            wasmer::FunctionType::new([], [wasmer::Type::I32]),
            move |_| fail().map(|n| vec![Value::I32(n)]),
        )
    } else {
        Function::new_typed(&mut store, fail)
    };
    let inst = instance(
        &mut store,
        r#"(module
      (import "env" "host" (func $host (result i32)))
      (func (export "run") (result i32) call $host)
      (func (export "simple") (result i32) i32.const 42))"#,
        &imports! { "env" => {"host" => host} },
    )?;
    let run = inst.exports.get_typed_function::<(), i32>(&store, "run")?;
    let simple = inst
        .exports
        .get_typed_function::<(), i32>(&store, "simple")?;
    for n in 0..100 {
        let error = run
            .call(&mut store)
            .expect_err("typed host error must propagate");
        ensure!(
            error.downcast_ref::<Marker>().is_some(),
            "host error type identity lost: {error}"
        );
        ensure!(
            destroyed.load(Ordering::SeqCst) == n,
            "error destroyed prematurely"
        );
        drop(error);
        ensure!(
            destroyed.load(Ordering::SeqCst) == n + 1,
            "error payload was not destroyed exactly once"
        );
        ensure!(simple.call(&mut store)? == 42);
    }
    Ok(())
}

#[cfg(feature = "wasix")]
fn wasi_exit() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = runtime.enter();
    let mut store = Store::new(engine());
    let module = Module::new(
        &store,
        r#"(module
      (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
      (memory (export "memory") 1)
      (func (export "_start"))
      (func (export "run") i32.const 42 call $exit))"#,
    )?;
    let (inst, env) = wasmer_wasix::WasiEnv::builder("v8-exit-probe")
        .engine(store.engine().clone())
        .instantiate(module, &mut store)?;
    let error = inst
        .exports
        .get_typed_function::<(), ()>(&store, "run")?
        .call(&mut store)
        .expect_err("proc_exit must return a host error");
    println!("wasi_exit_error={error}");
    ensure!(
        matches!(error.downcast_ref::<wasmer_wasix::WasiError>(), Some(wasmer_wasix::WasiError::Exit(code)) if code.raw()==42),
        "WasiError::Exit type or exit code lost"
    );
    env.on_exit(&mut store, None);
    Ok(())
}

#[cfg(feature = "wasix")]
fn async_call() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    let mut store = Store::new(engine());
    let inst = instance(
        &mut store,
        "(module (func (export \"run\") (result i32) i32.const 42))",
        &imports! {},
    )?;
    let run = inst.exports.get_function("run")?.clone();
    let store = store.into_async();
    let values = runtime.block_on(run.call_async(&store, vec![]))?;
    ensure!(values.as_ref() == [Value::I32(42)]);
    Ok(())
}

#[cfg(feature = "wasix")]
fn blocking_io() -> Result<()> {
    use std::io::Write;
    use wasmer_wasix::{WasiEnv, virtual_fs::Pipe};
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = runtime.enter();
    let (stdin, mut writer) = Pipe::channel();
    let mut store = Store::new(engine());
    let module = Module::new(
        &store,
        r#"(module
      (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "_start"))
      (func (export "run") (result i32)
        i32.const 0 i32.const 64 i32.store
        i32.const 4 i32.const 4 i32.store
        i32.const 0 i32.const 0 i32.const 1 i32.const 8 call $read))"#,
    )?;
    let (inst, env) = WasiEnv::builder("v8-io-probe")
        .engine(store.engine().clone())
        .stdin(Box::new(stdin))
        .instantiate(module, &mut store)?;
    let producer = std::thread::spawn(move || -> std::io::Result<()> {
        std::thread::sleep(std::time::Duration::from_millis(100));
        writer.write_all(b"V8OK")?;
        // Dropping the writer closes this direction of the pipe: the second read must see EOF.
        Ok(())
    });
    let run = inst.exports.get_typed_function::<(), i32>(&store, "run")?;
    let start = Instant::now();
    ensure!(run.call(&mut store)? == 0, "blocking fd_read failed");
    let memory = inst.exports.get_memory("memory")?;
    let mut bytes = [0; 4];
    memory.view(&store).read(64, &mut bytes)?;
    ensure!(&bytes == b"V8OK", "pipe data changed");
    memory.view(&store).read(8, &mut bytes)?;
    ensure!(u32::from_le_bytes(bytes) == 4);
    println!("blocked_read_ms={}", start.elapsed().as_millis());
    producer
        .join()
        .map_err(|_| anyhow::anyhow!("pipe producer panicked"))??;
    ensure!(run.call(&mut store)? == 0, "EOF fd_read failed");
    memory.view(&store).read(8, &mut bytes)?;
    ensure!(u32::from_le_bytes(bytes) == 0, "EOF was not delivered");
    env.on_exit(&mut store, None);
    Ok(())
}

#[cfg(feature = "wasix")]
fn directory_io() -> Result<()> {
    use wasmer_wasix::WasiEnv;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = runtime.enter();
    let path = std::env::current_dir()?.join("v8-directory");
    std::fs::create_dir_all(&path)?;
    // A fresh instance/store/environment must reopen the file through WASI.
    for writing in [true, false] {
        let mut store = Store::new(engine());
        let module = Module::new(&store, include_str!("../directory.wat"))?;
        let (inst, env) = WasiEnv::builder("v8-directory-probe")
            .engine(store.engine().clone())
            .fs(Arc::new(wasmer_wasix::virtual_fs::host_fs::FileSystem::new(
                runtime.handle().clone(),
                &path,
            )?)
                as Arc<
                    dyn wasmer_wasix::virtual_fs::FileSystem + Send + Sync,
                >)
            .map_dir("work", "/")?
            .instantiate(module, &mut store)?;
        let memory = inst.exports.get_memory("memory")?;
        let prestat = inst
            .exports
            .get_typed_function::<i32, i32>(&store, "prestat")?;
        let name = inst
            .exports
            .get_typed_function::<(i32, i32), i32>(&store, "name")?;
        let mut directory = None;
        for fd in 3..32 {
            if prestat.call(&mut store, fd)? != 0 {
                continue;
            }
            let mut bytes = [0; 4];
            memory.view(&store).read(36, &mut bytes)?;
            let length = u32::from_le_bytes(bytes) as usize;
            ensure!(length < 256, "unexpected preopen name length");
            ensure!(name.call(&mut store, fd, length as i32)? == 0);
            let mut bytes = vec![0; length];
            memory.view(&store).read(256, &mut bytes)?;
            println!("preopen_fd={fd} name={}", String::from_utf8_lossy(&bytes));
            if bytes == b"work" || bytes == b"/work" {
                directory = Some(fd);
                break;
            }
        }
        let directory = directory.context("mapped WASI preopen missing")?;
        let open = inst
            .exports
            .get_typed_function::<(i32, i32, i64), i32>(&store, "open")?;
        // WASI rights: read=2, sync=16, write=64. oflags: create=1, truncate=8.
        let errno = open.call(
            &mut store,
            directory,
            if writing { 9 } else { 0 },
            if writing { 82 } else { 2 },
        )?;
        ensure!(errno == 0, "path_open errno={errno} writing={writing}");
        let mut bytes = [0; 4];
        memory.view(&store).read(0, &mut bytes)?;
        let fd = u32::from_le_bytes(bytes) as i32;
        let operation = inst
            .exports
            .get_typed_function::<i32, i32>(&store, if writing { "write" } else { "read" })?;
        let errno = operation.call(&mut store, fd)?;
        ensure!(errno == 0, "file I/O errno={errno} writing={writing}");
        memory.view(&store).read(8, &mut bytes)?;
        ensure!(u32::from_le_bytes(bytes) == 4, "short file I/O");
        if writing {
            let errno = inst
                .exports
                .get_typed_function::<i32, i32>(&store, "sync")?
                .call(&mut store, fd)?;
            ensure!(errno == 0, "fd_sync errno={errno}");
        } else {
            memory.view(&store).read(192, &mut bytes)?;
            ensure!(&bytes == b"V8OK", "reopened file data changed");
        }
        ensure!(
            inst.exports
                .get_typed_function::<i32, i32>(&store, "close")?
                .call(&mut store, fd)?
                == 0
        );
        env.on_exit(&mut store, None);
        println!(
            "file_phase={} complete",
            if writing {
                "write-sync-close"
            } else {
                "reopen-read-close"
            }
        );
    }
    ensure!(std::fs::read(path.join("probe.bin"))? == b"V8OK");
    Ok(())
}

fn recursion(with_eh: bool) -> Result<()> {
    let mut store = Store::new(engine());
    let recurse = if with_eh {
        "(block $caught (result i32) (try_table (result i32) (catch $error $caught) local.get 0 i32.const 1 i32.sub call $rec i32.const 1 i32.add))"
    } else {
        "local.get 0 i32.const 1 i32.sub call $rec i32.const 1 i32.add"
    };
    let inst = instance(
        &mut store,
        &format!(
            r#"(module
      (tag $error (param i32))
      (func $rec (export "run") (param i32) (result i32)
        local.get 0 i32.eqz if (result i32) i32.const 0 else {recurse} end)
      (func (export "simple") (result i32) i32.const 42))"#
        ),
        &imports! {},
    )?;
    let run = inst.exports.get_typed_function::<i32, i32>(&store, "run")?;
    ensure!(run.call(&mut store, 100)? == 100);
    let error = run
        .call(&mut store, 1_000_000)
        .expect_err("deep recursion must trap");
    println!("stack_trap={error}");
    ensure!(
        error.to_string().to_lowercase().contains("stack"),
        "unexpected recursion error: {error}"
    );
    ensure!(
        inst.exports
            .get_typed_function::<(), i32>(&store, "simple")?
            .call(&mut store)?
            == 42
    );
    Ok(())
}

#[cfg(feature = "wasix")]
fn wasix() -> Result<()> {
    use wasmer_wasix::WasiEnv;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = runtime.enter();
    let mut store = Store::new(engine());
    let module = Module::new(
        &store,
        r#"(module
      (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
      (memory (export "memory") 1 4)
      (func (export "_start"))
      (func (export "run") (result i32) i32.const 1 i64.const 1 i32.const 0 call $clock))"#,
    )?;
    eprintln!("stage: WASIX instantiate");
    let (inst, env) = WasiEnv::builder("v8-probe")
        .engine(store.engine().clone())
        .instantiate(module, &mut store)?;
    let run = inst.exports.get_typed_function::<(), i32>(&store, "run")?;
    ensure!(run.call(&mut store)? == 0, "WASIX clock syscall failed");
    let mut bytes = [0; 8];
    inst.exports
        .get_memory("memory")?
        .view(&store)
        .read(0, &mut bytes)?;
    ensure!(
        u64::from_le_bytes(bytes) > 0,
        "clock did not write guest memory"
    );
    env.on_exit(&mut store, None);
    Ok(())
}

fn main() -> Result<()> {
    let case = std::env::args().nth(1).context("expected a probe case")?;
    let start = Instant::now();
    eprintln!(
        "case={case} backend=v8 wasmer=7.5.0 platform={}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match case.as_str() {
        "basic" => {
            let mut store = Store::new(engine());
            let inst = instance(
                &mut store,
                "(module (func (export \"run\") (param i32) (result i32) local.get 0 i32.const 1 i32.add))",
                &imports! {},
            )?;
            let run = inst.exports.get_typed_function::<i32, i32>(&store, "run")?;
            for n in 0..1000 {
                ensure!(run.call(&mut store, n)? == n + 1);
            }
        }
        "guest-eh" => {
            let mut store = Store::new(engine());
            let inst = instance(&mut store, EH, &imports! {})?;
            check_eh(&mut store, &inst)?;
        }
        "cross-module-eh" => cross_module()?,
        "uncaught-eh" => {
            let mut store = Store::new(engine());
            let inst = instance(&mut store, EH, &imports! {})?;
            let throw = inst
                .exports
                .get_typed_function::<i32, i32>(&store, "throw")?;
            for n in 0..100 {
                let error = throw
                    .call(&mut store, n)
                    .expect_err("guest exception must escape as an error");
                if n == 0 {
                    println!(
                        "uncaught_message={} is_exception={} exception_object={}",
                        error.message(),
                        error.is_exception(),
                        error.to_exception().is_some()
                    );
                }
            }
            check_eh(&mut store, &inst)?;
        }
        "host-error" => callback(false, false, false)?,
        "host-error-dynamic" => callback(false, true, false)?,
        "host-error-identity" => host_error_identity(false)?,
        "host-error-identity-dynamic" => host_error_identity(true)?,
        "contained-host-panic" => callback(true, false, true)?,
        "contained-host-panic-dynamic" => callback(true, true, true)?,
        "host-panic" => callback(true, false, false)?,
        "host-panic-dynamic" => callback(true, true, false)?,
        "host-atomics" => host_atomics()?,
        "uncaught-eh-metadata" => {
            let mut store = Store::new(engine());
            let inst = instance(&mut store, EH, &imports! {})?;
            let error = inst
                .exports
                .get_typed_function::<i32, i32>(&store, "throw")?
                .call(&mut store, 42)
                .expect_err("guest exception must escape");
            println!(
                "uncaught_message={} is_exception={} exception_object={}",
                error.message(),
                error.is_exception(),
                error.to_exception().is_some()
            );
            ensure!(
                error.is_exception() && error.to_exception().is_some(),
                "V8 does not expose typed uncaught-exception metadata"
            );
        }
        "host-exception" => {
            let mut store = Store::new(engine());
            let tag = Tag::new(&mut store, [wasmer::Type::I32]);
            let _exception = Exception::new(&mut store, &tag, &[Value::I32(42)]);
        }
        "shared-memory" => shared_memory(false)?,
        "shared-memory-thread" => shared_memory(true)?,
        "stack-overflow" => recursion(false)?,
        "eh-stack-overflow" => recursion(true)?,
        "cache-write" => {
            let store = Store::new(engine());
            let module = Module::new(&store, EH)?;
            module.serialize_to_file("guest.v8cache")?;
            println!("cache_bytes={}", std::fs::metadata("guest.v8cache")?.len());
        }
        "cache-read" => {
            let mut store = Store::new(engine());
            // Only deserialize bytes produced by this exact executable on this
            // runner. Wasmer deserialization accepts trusted executable input.
            let module =
                unsafe { Module::deserialize_from_file(&store, Path::new("guest.v8cache"))? };
            let inst = Instance::new(&mut store, &module, &imports! {})?;
            check_eh(&mut store, &inst)?;
        }
        "module-thread" => {
            let engine = engine();
            let store = Store::new(engine.clone());
            let module = Arc::new(Module::new(&store, EH)?);
            let worker_module = module.clone();
            std::thread::spawn(move || -> Result<()> {
                let mut store = Store::new(engine);
                let inst = Instance::new(&mut store, &worker_module, &imports! {})?;
                check_eh(&mut store, &inst)
            })
            .join()
            .map_err(|_| anyhow::anyhow!("module worker panicked"))??;
        }
        "wasix" => {
            #[cfg(feature = "wasix")]
            wasix()?;
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        "blocking-io" => {
            #[cfg(feature = "wasix")]
            blocking_io()?;
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        "directory-io" => {
            #[cfg(feature = "wasix")]
            directory_io()?;
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        "wasi-exit" => {
            #[cfg(feature = "wasix")]
            wasi_exit()?;
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        "async-call" => {
            #[cfg(feature = "wasix")]
            async_call()?;
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        "postgres-module" => {
            #[cfg(feature = "wasix")]
            {
                let path = std::env::args()
                    .nth(2)
                    .context("expected portable PostgreSQL Wasm path")?;
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()?;
                let _guard = runtime.enter();
                let mut store = Store::new(engine());
                eprintln!("stage: compile real PostgreSQL module");
                let module = Module::from_file(&store, path)?;
                println!(
                    "postgres_imports={} postgres_exports={}",
                    module.imports().count(),
                    module.exports().count()
                );
                eprintln!("stage: instantiate real PostgreSQL module through WASIX");
                let (_inst, env) = wasmer_wasix::WasiEnv::builder("postgres")
                    .engine(store.engine().clone())
                    .instantiate(module, &mut store)?;
                env.on_exit(&mut store, None);
                // Deliberately do not call _start: this case only probes loading the existing
                // dynamic-main artifact. A complete SDK, filesystem and seed are needed for SQL.
            }
            #[cfg(not(feature = "wasix"))]
            bail!("rebuild with --features wasix");
        }
        _ => bail!("unknown probe case: {case}"),
    }
    println!("PASS {case} elapsed_us={}", start.elapsed().as_micros());
    Ok(())
}
