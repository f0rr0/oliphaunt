use std::{collections::HashSet, io::Write as _, sync::Arc};

use anyhow::{Context, Error, ensure};
use wasmer_wasix::{
    Runtime, WasiError, WasiRuntimeError,
    runners::{
        MappedDirectory,
        wasi::{RuntimeOrEngine, WasiRunner},
    },
};

#[cfg(any(unix, windows))]
use wasmer_wasix::os::task::HostLifecycleSupervisor;

use crate::{
    VERSION,
    args::{Command, RunOptions, VolumeSpec},
    runtime::{
        HOST_TASK_BUDGET, SealedPostmasterRuntime, build_tokio_runtime, configure_stack,
        headless_engine, prepare_system_tty,
    },
    sealed,
};

/// Parse process arguments and execute the requested product command.
pub fn run_from_env() -> i32 {
    let command = match crate::args::parse_from(std::env::args_os()) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error:#}");
            return 2;
        }
    };

    match command {
        Command::Version => {
            println!("oliphaunt-wasix-postmaster-executor {VERSION}");
            0
        }
        Command::Run(options) => exit_code_for_result(execute(options)),
    }
}

/// Execute one strictly parsed sealed PostgreSQL request.
pub fn execute(options: RunOptions) -> Result<(), Error> {
    ensure!(
        options.stack_size > 0,
        "stack size must be greater than zero"
    );
    ensure!(
        !options.volumes.is_empty(),
        "at least one explicit host volume is required"
    );
    let resource_limits = configure_stack(options.stack_size);
    // This owner must remain in this stack frame until `run_wasm` has joined
    // the root and all fresh EXEC_BACKEND tasks. The task manager intentionally
    // receives only a Handle; dropping this owner earlier would stop its reactor.
    let tokio_runtime = build_tokio_runtime()?;
    let handle = tokio_runtime.handle().clone();
    let _runtime_guard = handle.enter();

    let prepared = sealed::prepare(&options.manifest, &options.input)?;
    prepared
        .runtime_identity()
        .context("sealed manifest selected no product runtime identity")?;
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let (code_memory_directory, code_memory_device, code_memory_inode) =
        prepared.strict_code_memory_directory()?;
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let engine = headless_engine(Some((
        &code_memory_directory,
        code_memory_device,
        code_memory_inode,
    )))?;
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    let engine = headless_engine(None)?;
    let loaded = sealed::load(prepared, &engine)?;

    // This scope-owned guard restores host terminal state after every normal
    // return, error propagation, or unwind, independent of runtime Arc clones.
    let (tty, _tty_restore_guard) = prepare_system_tty();
    let runtime = Arc::new(SealedPostmasterRuntime::new(
        handle,
        engine,
        loaded.module_cache.clone(),
        resource_limits,
        tty,
    ));
    let runtime: Arc<dyn Runtime + Send + Sync> = runtime;

    let mapped_directories = resolve_volumes(&options.volumes)?;
    let mut runner = WasiRunner::new();
    apply_host_task_budget(&mut runner);
    runner
        .with_args(options.guest_args)
        .with_mapped_directories(mapped_directories);
    attach_host_lifecycle(&mut runner)?;
    for (guest_path, module_hash) in loaded.executables {
        runner.with_sealed_module(guest_path, module_hash, None);
    }

    ensure!(
        wasmer_wasix::is_wasix_module(&loaded.module),
        "sealed PostgreSQL entrypoint is not a WASIX module"
    );
    let program_name = loaded.path.display().to_string();
    runner.run_wasm(
        RuntimeOrEngine::Runtime(runtime),
        &program_name,
        loaded.module,
        loaded.module_hash,
    )
}

fn apply_host_task_budget(runner: &mut WasiRunner) {
    // WasiEnvBuilder creates the one process-tree control plane from these
    // capabilities. Its exact CAS admission guard therefore shares the same
    // receipt-bound ceiling as the host blocking-worker pool.
    runner.capabilities_mut().threading.max_threads = Some(HOST_TASK_BUDGET);
}

fn resolve_volumes(volumes: &[VolumeSpec]) -> Result<Vec<MappedDirectory>, Error> {
    let mut canonical_hosts = HashSet::new();
    let mut guest_mounts = HashSet::new();
    volumes
        .iter()
        .map(|volume| {
            crate::args::validate_guest_path(&volume.guest)?;
            ensure!(
                guest_mounts.insert(volume.guest.clone()),
                "duplicate guest volume mount '{}'",
                volume.guest
            );
            let host = volume.host.canonicalize().with_context(|| {
                format!(
                    "canonicalize host directory for --volume {}:{}",
                    volume.host.display(),
                    volume.guest
                )
            })?;
            ensure!(
                host.is_dir(),
                "--volume host path '{}' is not a directory",
                host.display()
            );
            ensure!(
                canonical_hosts.insert((host.clone(), volume.guest.clone())),
                "duplicate canonical --volume mapping '{}:{}'",
                host.display(),
                volume.guest
            );
            Ok(MappedDirectory {
                host,
                guest: volume.guest.clone(),
            })
        })
        .collect()
}

#[cfg(any(unix, windows))]
fn attach_host_lifecycle(runner: &mut WasiRunner) -> Result<(), Error> {
    let supervisor = HostLifecycleSupervisor::install()
        .context("install exclusive product executor host lifecycle supervision")?;
    runner.with_host_lifecycle_supervisor(Arc::new(supervisor));
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn attach_host_lifecycle(_runner: &mut WasiRunner) -> Result<(), Error> {
    Ok(())
}

/// Convert an execution result to the process status used by the full CLI.
pub fn exit_code_for_result(result: Result<(), Error>) -> i32 {
    let exit_code = match result {
        Ok(()) => 0,
        Err(error) => {
            if let Some(exit_code) = error.chain().find_map(wasi_exit_code) {
                exit_code.raw()
            } else {
                eprintln!("error: {error:#}");
                1
            }
        }
    };

    std::io::stdout().flush().ok();
    std::io::stderr().flush().ok();
    exit_code
}

fn wasi_exit_code(
    error: &(dyn std::error::Error + 'static),
) -> Option<wasmer_wasix::types::wasi::ExitCode> {
    if let Some(WasiError::Exit(exit_code)) = error.downcast_ref() {
        return Some(*exit_code);
    }
    error
        .downcast_ref::<WasiRuntimeError>()
        .and_then(WasiRuntimeError::as_exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_runtime_policy_is_declared_at_the_execution_boundary() {
        assert_eq!(
            crate::runtime::POLICY_ID,
            "oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2"
        );
    }

    #[test]
    fn product_runner_applies_the_same_guest_and_host_task_budget() {
        let mut runner = WasiRunner::new();
        apply_host_task_budget(&mut runner);

        assert_eq!(
            runner.capabilities_mut().threading.max_threads,
            Some(crate::runtime::HOST_TASK_BUDGET)
        );
        assert_eq!(crate::runtime::HOST_TASK_BUDGET, 96);
    }

    #[test]
    fn success_maps_to_zero() {
        assert_eq!(exit_code_for_result(Ok(())), 0);
    }

    #[test]
    fn wasi_exit_status_is_preserved() {
        let error = Error::new(WasiError::Exit(7_u16.into()));
        assert_eq!(exit_code_for_result(Err(error)), 7);
    }

    #[test]
    fn volume_resolution_requires_existing_directories() {
        let missing = VolumeSpec {
            host: std::path::Path::new("/path/that/must/not/exist").to_path_buf(),
            guest: "/data".to_owned(),
        };
        assert!(resolve_volumes(&[missing]).is_err());
    }
}
