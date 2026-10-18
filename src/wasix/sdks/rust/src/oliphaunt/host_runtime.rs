use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use tokio::runtime::Runtime;
use wasmer_wasix::runtime::task_manager::{VirtualTaskManager, tokio::TokioTaskManager};

use crate::error::invalid_configuration;

/// Host resources shared by embedded WASIX databases and tools in one process.
/// Configure before first use. Omitted fields preserve the current selection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostRuntimeOptions {
    /// Async executor workers. Omitted: Tokio's CPU/environment-based selection.
    pub async_worker_threads: Option<usize>,
    /// Maximum lazily created Tokio blocking workers, separate from guest tasks. Default: 512.
    pub max_blocking_threads: Option<usize>,
    /// Dedicated Wasm/host task workers, created on demand and retained.
    /// Omitted: Wasmer's existing max(200, available CPUs * 100) policy.
    pub max_dedicated_threads: Option<usize>,
    /// Concurrent file helpers per initial-copy/publication operation. Default: 4.
    /// Higher values can increase storage contention; every durability barrier remains checked.
    pub max_concurrent_io: Option<usize>,
}

struct HostRuntime {
    runtime: Arc<Runtime>,
    tasks: Arc<TokioTaskManager>,
    async_worker_threads: usize,
    max_blocking_threads: usize,
    max_dedicated_threads: usize,
    max_concurrent_io: usize,
}

static HOST: OnceLock<Result<HostRuntime, String>> = OnceLock::new();
// Preserve Tokio's blocking-pool default and the existing publication-helper policy.
const DEFAULT_MAX_BLOCKING_THREADS: usize = 512;
const DEFAULT_MAX_CONCURRENT_IO: usize = 4;

impl HostRuntimeOptions {
    fn validate(self) -> Result<()> {
        for (name, value) in [
            ("async_worker_threads", self.async_worker_threads),
            ("max_blocking_threads", self.max_blocking_threads),
            ("max_dedicated_threads", self.max_dedicated_threads),
            ("max_concurrent_io", self.max_concurrent_io),
        ] {
            if value.is_some_and(|value| value == 0 || value > u32::MAX as usize) {
                return Err(invalid_configuration(format!(
                    "{name} must be a positive u32"
                )));
            }
        }
        Ok(())
    }
}

/// Select process-wide host resources before opening databases or running tools.
/// Repeating the selected values is allowed; changing a live host is rejected.
pub fn configure_host_runtime(options: HostRuntimeOptions) -> crate::Result<()> {
    crate::error::public_result(host(Some(options)).map(|_| ()))
}

fn host(options: Option<HostRuntimeOptions>) -> Result<&'static HostRuntime> {
    let requested = options.unwrap_or_default();
    requested.validate()?;
    let host = HOST
        .get_or_init(|| {
            let mut builder = tokio::runtime::Builder::new_multi_thread();
            if let Some(workers) = requested.async_worker_threads {
                builder.worker_threads(workers);
            }
            let max_blocking_threads = requested
                .max_blocking_threads
                .unwrap_or(DEFAULT_MAX_BLOCKING_THREADS);
            builder
                .max_blocking_threads(max_blocking_threads)
                .enable_all()
                .thread_name("oliphaunt-wasix-host");
            let runtime = builder
                .build()
                .context("create shared WASIX host executor")
                .map_err(|error| format!("{error:#}"))?;
            let max_dedicated_threads = requested
                .max_dedicated_threads
                .unwrap_or_else(TokioTaskManager::default_max_threads);
            let tasks = Arc::new(TokioTaskManager::with_max_threads(
                runtime.handle().clone(),
                max_dedicated_threads,
            ));
            Ok(HostRuntime {
                tasks,
                max_dedicated_threads,
                async_worker_threads: runtime.metrics().num_workers(),
                runtime: Arc::new(runtime),
                max_blocking_threads,
                max_concurrent_io: requested
                    .max_concurrent_io
                    .unwrap_or(DEFAULT_MAX_CONCURRENT_IO),
            })
        })
        .as_ref()
        .map_err(|message| anyhow::anyhow!("{message}"))?;
    for (name, value, selected) in [
        (
            "async_worker_threads",
            requested.async_worker_threads,
            host.async_worker_threads,
        ),
        (
            "max_blocking_threads",
            requested.max_blocking_threads,
            host.max_blocking_threads,
        ),
        (
            "max_dedicated_threads",
            requested.max_dedicated_threads,
            host.max_dedicated_threads,
        ),
        (
            "max_concurrent_io",
            requested.max_concurrent_io,
            host.max_concurrent_io,
        ),
    ] {
        if value.is_some_and(|value| value != selected) {
            return Err(invalid_configuration(format!(
                "WASIX host {name} is already {selected}; configure before first use"
            )));
        }
    }
    Ok(host)
}

pub(super) fn runtime() -> Result<Arc<Runtime>> {
    Ok(Arc::clone(&host(None)?.runtime))
}

pub(super) fn tasks() -> Result<Arc<dyn VirtualTaskManager>> {
    Ok(host(None)?.tasks.clone())
}

pub(super) fn publication_concurrency() -> Result<usize> {
    Ok(host(None)?.max_concurrent_io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_pool_is_shared_and_respects_the_selected_cap() {
        const CHILD: &str = "OLIPHAUNT_HOST_POOL_TEST";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "oliphaunt::host_runtime::tests::dedicated_pool_is_shared_and_respects_the_selected_cap", "--nocapture"])
                .env(CHILD, "1").output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        configure_host_runtime(HostRuntimeOptions {
            async_worker_threads: Some(1),
            max_blocking_threads: Some(2),
            max_dedicated_threads: Some(2),
            max_concurrent_io: Some(1),
        })
        .unwrap();
        let selected = host(None).unwrap();
        assert_eq!(selected.runtime.metrics().num_workers(), 1);
        assert_eq!(publication_concurrency().unwrap(), 1);
        assert!(Arc::ptr_eq(&tasks().unwrap(), &tasks().unwrap()));
        let (entered, started) = std::sync::mpsc::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        let waiting = Arc::new(std::sync::Mutex::new(waiting));
        let (finished, done) = std::sync::mpsc::channel();
        for _ in 0..3 {
            let (entered, waiting, finished) = (entered.clone(), waiting.clone(), finished.clone());
            tasks()
                .unwrap()
                .task_dedicated(Box::new(move || {
                    entered.send(()).unwrap();
                    waiting.lock().unwrap().recv().unwrap();
                    finished.send(()).unwrap();
                }))
                .unwrap();
        }
        let budget = std::time::Duration::from_secs(2);
        started.recv_timeout(budget).unwrap();
        started.recv_timeout(budget).unwrap();
        assert!(
            started
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err()
        );
        for _ in 0..3 {
            release.send(()).unwrap();
        }
        for _ in 0..3 {
            done.recv_timeout(budget).unwrap();
        }
    }

    #[test]
    fn host_configuration_is_checked_before_initialization() {
        for options in [
            HostRuntimeOptions {
                async_worker_threads: Some(0),
                ..Default::default()
            },
            HostRuntimeOptions {
                max_blocking_threads: Some(0),
                ..Default::default()
            },
            HostRuntimeOptions {
                max_dedicated_threads: Some(0),
                ..Default::default()
            },
            HostRuntimeOptions {
                max_concurrent_io: Some(0),
                ..Default::default()
            },
        ] {
            assert!(options.validate().is_err());
        }
        let selected = host(None).unwrap();
        configure_host_runtime(HostRuntimeOptions {
            async_worker_threads: Some(selected.async_worker_threads),
            max_blocking_threads: Some(selected.max_blocking_threads),
            max_dedicated_threads: Some(selected.max_dedicated_threads),
            max_concurrent_io: Some(selected.max_concurrent_io),
        })
        .unwrap();
        assert!(
            configure_host_runtime(HostRuntimeOptions {
                max_concurrent_io: Some(selected.max_concurrent_io + 1),
                ..Default::default()
            })
            .is_err()
        );
    }
}
