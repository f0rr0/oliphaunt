use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};

#[cfg(feature = "cluster-seed-runner")]
pub(crate) const INTERNAL_ICU_READY_ENV: &str = "OLIPHAUNT_INTERNAL_ICU_READY";
#[cfg(feature = "cluster-seed-runner")]
pub(crate) const INTERNAL_ICU_READY_VALUE: &str = "1";
#[cfg(feature = "cluster-seed-runner")]
const SKIP_SYSTEM_COLLATION_DISCOVERY_ENV: &str =
    "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY";
#[cfg(feature = "cluster-seed-runner")]
const SKIP_ICU_COLLATION_DISCOVERY_ENV: &str = "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogProfile {
    Standard,
    Icu,
}

impl CatalogProfile {
    pub(crate) const ALL: [Self; 2] = [Self::Standard, Self::Icu];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Icu => "icu",
        }
    }

    pub(crate) const fn artifact_role(self) -> &'static str {
        match self {
            Self::Standard => "cluster-seed-standard",
            Self::Icu => "cluster-seed-icu",
        }
    }
}

pub(crate) fn default_initdb_profile() -> &'static str {
    "allow-group-access,encoding=UTF8,locale=C.UTF-8,locale-provider=libc,auth=trust,no-sync"
}

pub(crate) fn clean_generated_cluster_seed(pgdata: &Path) -> Result<()> {
    for name in ["postmaster.pid", "postmaster.opts"] {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(feature = "cluster-seed-runner")]
pub(crate) fn run_wasix_initdb_cluster_seed(
    runtime_stage: &Path,
    work_root: &Path,
    profile: CatalogProfile,
    icu_data_root: Option<&Path>,
) -> Result<()> {
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
    let staged_icu_data = package_root.join("share/icu");
    if staged_icu_data.exists() {
        fs::remove_dir_all(&staged_icu_data)
            .with_context(|| format!("remove {}", staged_icu_data.display()))?;
    }
    match (profile, icu_data_root) {
        (CatalogProfile::Standard, None) => {}
        (CatalogProfile::Standard, Some(_)) => {
            bail!("standard cluster-seed generation must not receive ICU data")
        }
        (CatalogProfile::Icu, Some(icu_data_root)) => {
            copy_tree_filtered(icu_data_root, &staged_icu_data, None)?;
        }
        (CatalogProfile::Icu, None) => {
            bail!("ICU cluster-seed generation requires verified ICU data")
        }
    }
    copy_file(
        &runtime_stage.join("bin/initdb"),
        &package_dir.join("modules/initdb.wasm"),
    )?;
    copy_file(
        &runtime_stage.join("bin/postgres"),
        &package_dir.join("modules/postgres.wasm"),
    )?;
    let wasmer_toml = r#"
[package]
name = "oliphaunt-wasix/cluster-seed-producer"
version = "0.0.0"
description = "Oliphaunt WASIX cluster seed producer"

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
        .context("create Tokio runtime for WASIX cluster-seed generation")?;
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
                    "create WASIX cluster-seed root filesystem at {}",
                    package_root.display()
                )
            })?,
    ) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
    let pgdata_fs = Arc::new(
        virtual_fs::host_fs::FileSystem::new(tokio_runtime.handle().clone(), &pgdata_root)
            .with_context(|| {
                format!(
                    "create WASIX cluster-seed PGDATA filesystem at {}",
                    pgdata_root.display()
                )
            })?,
    ) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;

    let (stdout_file, stdout_capture) = TailCaptureFile::new(64 * 1024);
    let (stderr_file, stderr_capture) = TailCaptureFile::new(64 * 1024);
    let run_result = {
        let mut runner = WasiRunner::new();
        runner.with_current_dir("/");
        runner.with_mount("/".to_owned(), root_fs.clone());
        runner.with_mount("/base".to_owned(), pgdata_fs.clone());
        runner.with_args(default_initdb_args());
        runner.with_envs(cluster_seed_producer_environment(profile));
        runner.with_stdin(Box::<NullFile>::default());
        runner.with_stdout(Box::new(stdout_file));
        runner.with_stderr(Box::new(stderr_file));
        runner.run_command(
            "initdb",
            &package,
            RuntimeOrEngine::Runtime(runtime.clone()),
        )
    };
    let stdout = stdout_capture.text();
    let stderr = stderr_capture.text();
    if env::var_os("OLIPHAUNT_WASM_CLUSTER_SEED_LOG").is_some() || run_result.is_err() {
        print_captured_wasix_output("initdb stdout", &stdout);
        print_captured_wasix_output("initdb stderr", &stderr);
    }
    run_result.context("run WASIX initdb to generate cluster seed")?;
    verify_wasix_cluster_seed_profile(&package, runtime, root_fs, pgdata_fs, profile)
}

#[cfg(not(feature = "cluster-seed-runner"))]
pub(crate) fn run_wasix_initdb_cluster_seed(
    _runtime_stage: &Path,
    _work_root: &Path,
    _profile: CatalogProfile,
    _icu_data_root: Option<&Path>,
) -> Result<()> {
    bail!(
        "`assets cluster-seeds` and seed generation during release-build require `cargo run -p xtask --features cluster-seed-runner -- ...` so xtask has a maintainer-only Wasmer compiler backend"
    )
}

#[cfg_attr(not(feature = "cluster-seed-runner"), allow(dead_code))]
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

#[cfg(feature = "cluster-seed-runner")]
fn cluster_seed_environment(profile: CatalogProfile) -> Vec<(&'static str, &'static str)> {
    let mut environment = vec![
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
    ];
    if profile == CatalogProfile::Icu {
        environment.push(("ICU_DATA", "/share/icu"));
    }
    environment
}

#[cfg(feature = "cluster-seed-runner")]
fn cluster_seed_producer_environment(profile: CatalogProfile) -> Vec<(&'static str, &'static str)> {
    let mut environment = cluster_seed_environment(profile);
    environment.push((SKIP_SYSTEM_COLLATION_DISCOVERY_ENV, "1"));
    if profile == CatalogProfile::Standard {
        environment.push((SKIP_ICU_COLLATION_DISCOVERY_ENV, "1"));
    } else {
        environment.push((INTERNAL_ICU_READY_ENV, INTERNAL_ICU_READY_VALUE));
    }
    environment
}

#[cfg(feature = "cluster-seed-runner")]
fn verify_wasix_cluster_seed_profile(
    package: &wasmer_wasix::bin_factory::BinaryPackage,
    runtime: std::sync::Arc<dyn wasmer_wasix::runtime::Runtime + Send + Sync>,
    root_fs: std::sync::Arc<dyn wasmer_wasix::virtual_fs::FileSystem + Send + Sync>,
    pgdata_fs: std::sync::Arc<dyn wasmer_wasix::virtual_fs::FileSystem + Send + Sync>,
    profile: CatalogProfile,
) -> Result<()> {
    use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
    use wasmer_wasix::virtual_fs;

    const CONTRACT_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/shared/cluster-seed-contract/profile-probe.json"
    ));

    let contract: ClusterSeedProfileProbeContract =
        serde_json::from_str(CONTRACT_JSON).context("parse shared cluster-seed profile probe")?;
    if contract.schema != "oliphaunt-cluster-seed-profile-probe-v1" {
        bail!(
            "unsupported shared cluster-seed profile probe schema {}",
            contract.schema
        );
    }
    let probe = match profile {
        CatalogProfile::Standard => &contract.profiles.standard,
        CatalogProfile::Icu => &contract.profiles.icu,
    };

    for attempt in 1..=2 {
        let (stdout_file, stdout_capture) = TailCaptureFile::new(64 * 1024);
        let (stderr_file, stderr_capture) = TailCaptureFile::new(64 * 1024);
        let mut runner = WasiRunner::new();
        runner.with_current_dir("/");
        runner.with_mount("/".to_owned(), root_fs.clone());
        runner.with_mount("/base".to_owned(), pgdata_fs.clone());
        runner.with_args(vec!["--single", "-D", "/base", "postgres"]);
        runner.with_envs(cluster_seed_environment(profile));
        runner.with_stdin(Box::new(virtual_fs::StaticFile::new(
            format!("{};\n", probe.sql).into_bytes(),
        )));
        runner.with_stdout(Box::new(stdout_file));
        runner.with_stderr(Box::new(stderr_file));
        let result = runner.run_command(
            "postgres",
            package,
            RuntimeOrEngine::Runtime(runtime.clone()),
        );
        let stdout = stdout_capture.text();
        let stderr = stderr_capture.text();
        let failed = result.is_err() || !stdout.contains(&probe.expected);
        if std::env::var_os("OLIPHAUNT_WASM_CLUSTER_SEED_LOG").is_some() || failed {
            print_captured_wasix_output("profile probe stdout", &stdout);
            print_captured_wasix_output("profile probe stderr", &stderr);
        }
        result.with_context(|| {
            format!(
                "run {} WASIX cluster-seed profile probe (attempt {attempt})",
                profile.as_str()
            )
        })?;
        if !stdout.contains(&probe.expected) {
            bail!(
                "{} WASIX cluster-seed profile probe attempt {attempt} did not emit {:?}",
                profile.as_str(),
                probe.expected
            );
        }
    }
    Ok(())
}

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, serde::Deserialize)]
struct ClusterSeedProfileProbeContract {
    schema: String,
    profiles: ClusterSeedProfileProbes,
}

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, serde::Deserialize)]
struct ClusterSeedProfileProbes {
    standard: ClusterSeedProfileProbe,
    icu: ClusterSeedProfileProbe,
}

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, serde::Deserialize)]
struct ClusterSeedProfileProbe {
    sql: String,
    expected: String,
}

#[cfg(feature = "cluster-seed-runner")]
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

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, Default)]
struct LocalOnlyPackageLoader;

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, Clone)]
struct TailCaptureFile {
    inner: std::sync::Arc<std::sync::Mutex<TailCaptureState>>,
    limit: usize,
}

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, Default)]
struct TailCaptureState {
    bytes: std::collections::VecDeque<u8>,
}

#[cfg(feature = "cluster-seed-runner")]
#[derive(Debug, Clone)]
struct TailCaptureHandle {
    inner: std::sync::Arc<std::sync::Mutex<TailCaptureState>>,
}

#[cfg(feature = "cluster-seed-runner")]
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

#[cfg(feature = "cluster-seed-runner")]
impl TailCaptureHandle {
    fn text(&self) -> String {
        let Ok(state) = self.inner.lock() else {
            return "<cluster-seed output capture lock poisoned>".to_owned();
        };
        let bytes = state.bytes.iter().copied().collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[cfg(feature = "cluster-seed-runner")]
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

#[cfg(feature = "cluster-seed-runner")]
impl wasmer_wasix::virtual_fs::AsyncRead for TailCaptureFile {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &mut wasmer_wasix::virtual_fs::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[cfg(feature = "cluster-seed-runner")]
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

#[cfg(feature = "cluster-seed-runner")]
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

#[cfg(feature = "cluster-seed-runner")]
#[async_trait::async_trait]
impl wasmer_wasix::runtime::package_loader::PackageLoader for LocalOnlyPackageLoader {
    async fn load(
        &self,
        summary: &wasmer_wasix::runtime::resolver::PackageSummary,
    ) -> Result<webc::Container> {
        bail!(
            "WASIX cluster-seed generation only supports local packages; unexpected dependency {}",
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
