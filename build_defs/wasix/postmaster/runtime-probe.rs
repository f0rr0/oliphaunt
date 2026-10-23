//! Test-only primitive execution with the product's actual runtime implementation.
//!
//! This does not construct or admit a public PostgreSQL carrier. Its immutable
//! one-module cache is solely for isolating SjLj and vfork lowering failures.

use std::{env, fs, os::unix::fs::MetadataExt, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, ensure};
use oliphaunt_wasix_postmaster_executor::{exit_code_for_result, memory_profile};
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::{
    Runtime,
    runners::wasi::{RuntimeOrEngine, WasiRunner},
};

// Compile the unchanged production runtime, not a copied runtime policy.
#[path = "../../../src/wasix/postmaster/executor/src/runtime.rs"]
mod runtime;

mod sealed {
    use super::*;
    use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

    #[derive(Debug)]
    pub(crate) struct SealedModuleCache {
        pub(crate) engine: wasmer::EngineId,
        pub(crate) hash: ModuleHash,
        pub(crate) module: Module,
    }

    #[async_trait::async_trait]
    impl ModuleCache for SealedModuleCache {
        fn is_authoritative(&self) -> bool {
            true
        }
        async fn load(&self, key: ModuleHash, engine: &Engine) -> Result<Module, CacheError> {
            if key != self.hash || engine.id() != self.engine {
                return Err(CacheError::NotFound);
            }
            Ok(self.module.clone())
        }
        async fn contains(&self, key: ModuleHash, engine: &Engine) -> Result<bool, CacheError> {
            Ok(key == self.hash && engine.id() == self.engine)
        }
        async fn save(
            &self,
            _key: ModuleHash,
            _engine: &Engine,
            _module: &Module,
        ) -> Result<(), CacheError> {
            Err(CacheError::other(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "immutable primitive probe cache",
            )))
        }
    }
}

fn run() -> Result<()> {
    let mut arguments = env::args_os().skip(1);
    let wasm = PathBuf::from(arguments.next().context("expected probe WASM")?);
    let artifact = PathBuf::from(arguments.next().context("expected verified probe AOT")?);
    ensure!(
        arguments.next().is_none(),
        "expected only WASM and verified AOT paths"
    );
    let bytes = fs::read(&wasm)?;
    let hash = ModuleHash::sha256(&bytes);
    let temporary = PathBuf::from(
        env::var_os("TEST_TMPDIR").unwrap_or_else(|| env::temp_dir().into_os_string()),
    );
    let directory = temporary.join(format!("postmaster-runtime-probe-{}", std::process::id()));
    fs::create_dir(&directory)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::metadata(&directory)?;
    let engine = runtime::headless_engine(Some((&directory, metadata.dev(), metadata.ino())))?;
    // The declared compiler action has verified the embedded module digest and
    // memory plan before this test receives these exact local artifact bytes.
    let module = unsafe { Module::deserialize_from_file(&engine, &artifact) }?;
    let cache = Arc::new(sealed::SealedModuleCache {
        engine: engine.id(),
        hash,
        module: module.clone(),
    });
    let tokio = runtime::build_tokio_runtime()?;
    let handle = tokio.handle().clone();
    let _guard = handle.enter();
    let (tty, _restore) = runtime::prepare_system_tty();
    let runtime: Arc<dyn Runtime + Send + Sync> = Arc::new(runtime::SealedPostmasterRuntime::new(
        handle,
        engine,
        cache,
        runtime::configure_stack(8 * 1024 * 1024),
        tty,
    ));
    let mut runner = WasiRunner::new();
    runner.capabilities_mut().threading.max_threads = Some(runtime::HOST_TASK_BUDGET);
    runner.with_sealed_module("/probe".to_owned(), hash, None);
    runner.run_wasm(RuntimeOrEngine::Runtime(runtime), "/probe", module, hash)
}

fn main() {
    std::process::exit(exit_code_for_result(run()));
}
