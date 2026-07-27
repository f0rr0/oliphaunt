use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};

pub(crate) fn default_initdb_profile() -> &'static str {
    "allow-group-access,encoding=UTF8,locale=C.UTF-8,locale-provider=libc,auth=trust,no-sync"
}

pub(crate) fn clean_generated_pgdata_template(pgdata: &Path) -> Result<()> {
    for name in ["postmaster.pid", "postmaster.opts"] {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(feature = "template-runner")]
pub(crate) fn run_wasix_initdb_template(runtime_stage: &Path, work_root: &Path) -> Result<()> {
    use std::env;
    use std::sync::Arc;

    use wasmer::Engine;
    use wasmer_wasix::bin_factory::BinaryPackage;
    use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
    use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
    use wasmer_wasix::virtual_fs;
    use wasmer_wasix::virtual_fs::null_file::NullFile;

    use crate::fs_utils::{copy_file, copy_tree_filtered};

    let package_dir = work_root.join("package");
    let package_root = work_root.join("root");
    let pgdata_root = work_root.join("pgdata");
    fs::create_dir_all(package_dir.join("modules"))
        .with_context(|| format!("create {}", package_dir.join("modules").display()))?;
    fs::create_dir_all(&pgdata_root)
        .with_context(|| format!("create {}", pgdata_root.display()))?;
    copy_tree_filtered(runtime_stage, &package_root, None)?;
    copy_file(
        &runtime_stage.join("bin/initdb"),
        &package_dir.join("modules/initdb.wasm"),
    )?;
    copy_file(
        &runtime_stage.join("bin/oliphaunt"),
        &package_dir.join("modules/postgres.wasm"),
    )?;
    let wasmer_toml = r#"
[package]
name = "oliphaunt-wasix/initdb-template"
version = "0.0.0"
description = "oliphaunt-wasix generated PGDATA template builder"

[[module]]
name = "initdb"
source = "modules/initdb.wasm"
abi = "wasi"

[[module]]
name = "postgres"
source = "modules/postgres.wasm"
abi = "wasi"

[[command]]
name = "initdb"
module = "initdb"

[[command]]
name = "postgres"
module = "postgres"
"#;
    fs::write(package_dir.join("wasmer.toml"), wasmer_toml)
        .with_context(|| format!("write {}", package_dir.join("wasmer.toml").display()))?;

    let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("create Tokio runtime for WASIX initdb template generation")?;
    let _guard = tokio_runtime.enter();
    let engine = Engine::default();
    let task_manager = Arc::new(TokioTaskManager::new(tokio_runtime.handle().clone()));
    let mut runtime = PluggableRuntime::new(task_manager);
    runtime.set_engine(engine.clone());
    runtime.set_package_loader(LocalOnlyPackageLoader);
    let runtime: Arc<dyn Runtime + Send + Sync> = Arc::new(runtime);
    let package = tokio_runtime
        .block_on(BinaryPackage::from_dir(&package_dir, runtime.as_ref()))
        .context("load WASIX initdb package")?;
    let root_fs = Arc::new(
        virtual_fs::host_fs::FileSystem::new(tokio_runtime.handle().clone(), &package_root)
            .with_context(|| {
                format!(
                    "create WASIX template root filesystem at {}",
                    package_root.display()
                )
            })?,
    ) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
    let pgdata_fs = Arc::new(
        virtual_fs::host_fs::FileSystem::new(tokio_runtime.handle().clone(), &pgdata_root)
            .with_context(|| {
                format!(
                    "create WASIX template PGDATA filesystem at {}",
                    pgdata_root.display()
                )
            })?,
    ) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;

    let (stdout_file, stdout_capture) = TailCaptureFile::new(64 * 1024);
    let (stderr_file, stderr_capture) = TailCaptureFile::new(64 * 1024);
    let run_result = {
        let mut runner = WasiRunner::new();
        runner.with_current_dir("/");
        runner.with_mount("/".to_owned(), root_fs);
        runner.with_mount("/base".to_owned(), pgdata_fs);
        runner.with_args(default_initdb_args());
        runner.with_envs([
            ("PGDATA", "/base"),
            ("PGSYSCONFDIR", "/base"),
            ("HOME", "/home/postgres"),
            ("USER", "postgres"),
            ("LOGNAME", "postgres"),
            ("PGCLIENTENCODING", "UTF8"),
            ("PATH", "/bin"),
            ("LC_CTYPE", "C.UTF-8"),
            ("TZ", "UTC"),
            ("PGTZ", "UTC"),
            ("PG_COLOR", "never"),
        ]);
        runner.with_stdin(Box::<NullFile>::default());
        runner.with_stdout(Box::new(stdout_file));
        runner.with_stderr(Box::new(stderr_file));
        runner.run_command("initdb", &package, RuntimeOrEngine::Runtime(runtime))
    };
    let stdout = stdout_capture.text();
    let stderr = stderr_capture.text();
    if env::var_os("OLIPHAUNT_WASM_TEMPLATE_LOG").is_some() || run_result.is_err() {
        print_captured_wasix_output("initdb stdout", &stdout);
        print_captured_wasix_output("initdb stderr", &stderr);
    }
    run_result.context("run WASIX initdb to generate PGDATA template")
}

#[cfg(not(feature = "template-runner"))]
pub(crate) fn run_wasix_initdb_template(_runtime_stage: &Path, _work_root: &Path) -> Result<()> {
    bail!(
        "`assets template` and template generation during release-build require `cargo run -p xtask --features template-runner -- ...` so xtask has a maintainer-only Wasmer compiler backend"
    )
}

#[cfg_attr(not(feature = "template-runner"), allow(dead_code))]
fn default_initdb_args() -> Vec<&'static str> {
    vec![
        "--allow-group-access",
        "--encoding",
        "UTF8",
        "--locale=C.UTF-8",
        "--locale-provider=libc",
        "--auth=trust",
        "--no-sync",
        "-D",
        "/base",
    ]
}

#[cfg(feature = "template-runner")]
fn print_captured_wasix_output(label: &str, output: &str) {
    if output.trim().is_empty() {
        eprintln!("{label}: <empty>");
    } else {
        eprintln!("--- {label} ---");
        eprint!("{output}");
        if !output.ends_with('\n') {
            eprintln!();
        }
        eprintln!("--- end {label} ---");
    }
}

#[cfg(feature = "template-runner")]
#[derive(Debug, Default)]
struct LocalOnlyPackageLoader;

#[cfg(feature = "template-runner")]
#[derive(Debug, Clone)]
struct TailCaptureFile {
    inner: std::sync::Arc<std::sync::Mutex<TailCaptureState>>,
    limit: usize,
}

#[cfg(feature = "template-runner")]
#[derive(Debug, Default)]
struct TailCaptureState {
    bytes: std::collections::VecDeque<u8>,
}

#[cfg(feature = "template-runner")]
#[derive(Debug, Clone)]
struct TailCaptureHandle {
    inner: std::sync::Arc<std::sync::Mutex<TailCaptureState>>,
}

#[cfg(feature = "template-runner")]
impl TailCaptureFile {
    fn new(limit: usize) -> (Self, TailCaptureHandle) {
        let inner = std::sync::Arc::new(std::sync::Mutex::new(TailCaptureState::default()));
        (
            Self {
                inner: inner.clone(),
                limit,
            },
            TailCaptureHandle { inner },
        )
    }

    fn push_tail(&self, bytes: &[u8]) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        for byte in bytes {
            state.bytes.push_back(*byte);
            while state.bytes.len() > self.limit {
                state.bytes.pop_front();
            }
        }
    }
}

#[cfg(feature = "template-runner")]
impl TailCaptureHandle {
    fn text(&self) -> String {
        let Ok(state) = self.inner.lock() else {
            return "<template output capture lock poisoned>".to_owned();
        };
        let bytes = state.bytes.iter().copied().collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[cfg(feature = "template-runner")]
impl wasmer_wasix::virtual_fs::AsyncSeek for TailCaptureFile {
    fn start_seek(
        self: std::pin::Pin<&mut Self>,
        _position: std::io::SeekFrom,
    ) -> std::io::Result<()> {
        Ok(())
    }

    fn poll_complete(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<u64>> {
        std::task::Poll::Ready(Ok(0))
    }
}

#[cfg(feature = "template-runner")]
impl wasmer_wasix::virtual_fs::AsyncRead for TailCaptureFile {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &mut wasmer_wasix::virtual_fs::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[cfg(feature = "template-runner")]
impl wasmer_wasix::virtual_fs::AsyncWrite for TailCaptureFile {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.push_tail(buf);
        std::task::Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_write_vectored(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let mut total = 0;
        for buf in bufs {
            self.push_tail(buf);
            total += buf.len();
        }
        std::task::Poll::Ready(Ok(total))
    }

    fn is_write_vectored(&self) -> bool {
        true
    }
}

#[cfg(feature = "template-runner")]
impl wasmer_wasix::virtual_fs::VirtualFile for TailCaptureFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.inner
            .lock()
            .map(|state| state.bytes.len() as u64)
            .unwrap_or(0)
    }

    fn set_len(&mut self, _new_size: u64) -> wasmer_wasix::virtual_fs::Result<()> {
        Ok(())
    }

    fn unlink(&mut self) -> wasmer_wasix::virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Ready(Ok(0))
    }

    fn poll_write_ready(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Ready(Ok(self.limit))
    }
}

#[cfg(feature = "template-runner")]
#[async_trait::async_trait]
impl wasmer_wasix::runtime::package_loader::PackageLoader for LocalOnlyPackageLoader {
    async fn load(
        &self,
        summary: &wasmer_wasix::runtime::resolver::PackageSummary,
    ) -> Result<webc::Container> {
        bail!(
            "WASIX template generation only supports local packages; unexpected dependency {}",
            summary.pkg.id
        )
    }

    async fn load_package_tree(
        &self,
        root: &webc::Container,
        resolution: &wasmer_wasix::runtime::resolver::Resolution,
        root_is_local_dir: bool,
    ) -> Result<wasmer_wasix::bin_factory::BinaryPackage> {
        wasmer_wasix::runtime::package_loader::load_package_tree(
            root,
            self,
            resolution,
            root_is_local_dir,
        )
        .await
    }
}
