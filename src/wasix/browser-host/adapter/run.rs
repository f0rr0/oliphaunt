use std::sync::Arc;

use futures::channel::oneshot;
use js_sys::{Uint8Array, WebAssembly};
use wasm_bindgen::{JsCast, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;
use wasmer_wasix::WasiEnvBuilder;

use super::{Instance, RunOptions, instance::ExitCondition, utils::Error};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "WebAssembly.Module | Uint8Array")]
    pub type WasmModule;
}

/// Isolated process execution for our initdb guest, using the SDK's scheduler.
#[wasm_bindgen(js_name = runWasix)]
pub async fn run_wasix(input: WasmModule, options: RunOptions) -> Result<Instance, Error> {
    let module = if let Some(module) = input.dyn_ref::<WebAssembly::Module>() {
        let bytes = options.module_bytes().ok_or_else(|| {
            anyhow::anyhow!("runWasix requires moduleBytes with a precompiled module")
        })?;
        wasmer::Module::from((module.clone(), bytes.to_vec()))
    } else {
        let bytes = input
            .dyn_ref::<Uint8Array>()
            .ok_or_else(|| anyhow::anyhow!("runWasix expects Wasm bytes or a compiled module"))?;
        let module: WebAssembly::Module = JsFuture::from(WebAssembly::compile(bytes))
            .await
            .map_err(Error::js)?
            .dyn_into()
            .map_err(Error::js)?;
        wasmer::Module::from((module, bytes.to_vec()))
    };
    let pool = Arc::new(crate::tasks::ThreadPool::new(None));
    let runtime: Arc<dyn wasmer_wasix::Runtime + Send + Sync> =
        Arc::new(super::runtime::runtime(pool.clone())?);
    let program = options
        .program()
        .as_string()
        .unwrap_or_else(|| "wasm".to_owned());
    let mut builder = WasiEnvBuilder::new(program).runtime(runtime.clone());
    let (stdin, stdout, stderr) = options.configure_builder(&mut builder)?;
    let (sender, exit) = oneshot::channel();
    let env = builder.build()?;
    let mut task = wasmer_wasix::bin_factory::spawn_exec_module(module, env, &runtime)?;
    wasm_bindgen_futures::spawn_local(async move {
        let result = match task.wait_finished().await {
            Ok(code) if code.raw() == 0 => Ok(()),
            Ok(code) => Err(
                wasmer_wasix::WasiRuntimeError::Wasi(wasmer_wasix::WasiError::Exit(code)).into(),
            ),
            Err(error) => Err(anyhow::anyhow!(error.to_string())),
        };
        let _ = sender.send(ExitCondition::from_result(result));
    });
    Ok(Instance {
        stdin,
        stdout,
        stderr,
        exit,
        pool,
    })
}
