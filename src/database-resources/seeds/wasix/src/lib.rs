use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};

#[cfg(feature = "cluster-seed-runner")]
pub const INTERNAL_ICU_READY_ENV: &str = "OLIPHAUNT_INTERNAL_ICU_READY";
#[cfg(feature = "cluster-seed-runner")]
pub const INTERNAL_ICU_READY_VALUE: &str = "1";
#[cfg(feature = "cluster-seed-runner")]
const SKIP_SYSTEM_COLLATION_DISCOVERY_ENV: &str =
    "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY";
#[cfg(feature = "cluster-seed-runner")]
const SKIP_ICU_COLLATION_DISCOVERY_ENV: &str = "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogProfile {
    Standard,
    Icu,
}

impl CatalogProfile {
    pub const ALL: [Self; 2] = [Self::Standard, Self::Icu];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Icu => "icu",
        }
    }

    pub const fn artifact_role(self) -> &'static str {
        match self {
            Self::Standard => "cluster-seed-standard",
            Self::Icu => "cluster-seed-icu",
        }
    }
}

pub fn default_initdb_profile() -> &'static str {
    "allow-group-access,encoding=UTF8,locale=C.UTF-8,locale-provider=libc,auth=trust,no-sync"
}

pub fn clean_generated_cluster_seed(pgdata: &Path) -> Result<()> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        pgdata_directories: Vec<String>,
    }
    let contract: Contract =
        serde_json::from_str(include_str!("../../../contracts/contract.json"))?;
    for directory in contract.pgdata_directories {
        let metadata = fs::symlink_metadata(pgdata.join(&directory)).with_context(|| {
            format!("cluster seed is missing required PostgreSQL directory {directory}")
        })?;
        anyhow::ensure!(
            metadata.is_dir(),
            "cluster seed has an unsafe PostgreSQL directory {directory}"
        );
    }
    for name in ["postmaster.pid", "postmaster.opts"] {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(feature = "cluster-seed-runner")]
pub fn run_wasix_initdb_cluster_seed(
    runtime_stage: &Path,
    work_root: &Path,
    profile: CatalogProfile,
    icu_data_root: Option<&Path>,
) -> Result<()> {
    use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
    use wasmer_wasix::virtual_fs::null_file::NullFile;

    with_wasix_cluster_seed_runner(
        runtime_stage,
        work_root,
        profile,
        icu_data_root,
        None,
        |seed_runner| {
            let (stdout_file, stdout_capture) = TailCaptureFile::new(64 * 1024);
            let (stderr_file, stderr_capture) = TailCaptureFile::new(64 * 1024);
            let run_result = {
                let mut runner = WasiRunner::new();
                runner.with_current_dir("/");
                runner.with_mount("/".to_owned(), seed_runner.root_fs.clone());
                runner.with_mount("/base".to_owned(), seed_runner.pgdata_fs.clone());
                runner.with_args(default_initdb_args());
                runner.with_envs(cluster_seed_producer_environment(profile));
                runner.with_stdin(Box::<NullFile>::default());
                runner.with_stdout(Box::new(stdout_file));
                runner.with_stderr(Box::new(stderr_file));
                runner.run_command(
                    "initdb",
                    &seed_runner.package,
                    RuntimeOrEngine::Runtime(seed_runner.runtime.clone()),
                )
            };
            let stdout = stdout_capture.text();
            let stderr = stderr_capture.text();
            if std::env::var_os("OLIPHAUNT_WASM_CLUSTER_SEED_LOG").is_some() || run_result.is_err()
            {
                print_captured_wasix_output("initdb stdout", &stdout);
                print_captured_wasix_output("initdb stderr", &stderr);
            }
            run_result.context("run WASIX initdb to generate cluster seed")?;
            verify_wasix_cluster_seed_profile(seed_runner, profile)
        },
    )
}

#[cfg(feature = "cluster-seed-runner")]
pub fn verify_wasix_cluster_seed(
    runtime_stage: &Path,
    work_root: &Path,
    profile: CatalogProfile,
    pgdata_source: &Path,
    icu_data_root: Option<&Path>,
) -> Result<()> {
    with_wasix_cluster_seed_runner(
        runtime_stage,
        work_root,
        profile,
        icu_data_root,
        Some(pgdata_source),
        |runner| {
            verify_wasix_cluster_seed_profile(runner, profile)?;
            runner.run_sql(
                profile,
                "CREATE TABLE public.oliphaunt_seed_consumer_probe (id integer PRIMARY KEY, marker text NOT NULL);\nINSERT INTO public.oliphaunt_seed_consumer_probe VALUES (1, 'persisted-after-reopen');\n",
                "create and populate WASIX cluster-seed persistence probe",
            )?;
            let stdout = runner.run_sql(
                profile,
                "SELECT CASE WHEN count(*) = 1 AND min(marker) = 'persisted-after-reopen' THEN 'oliphaunt-wasix-seed-persistence-ok' ELSE 'oliphaunt-wasix-seed-persistence-invalid' END FROM public.oliphaunt_seed_consumer_probe WHERE id = 1;\n",
                "reopen WASIX cluster seed and read persistence probe",
            )?;
            anyhow::ensure!(
                stdout.contains("oliphaunt-wasix-seed-persistence-ok"),
                "reopened WASIX cluster seed did not preserve the inserted row"
            );
            Ok(())
        },
    )
}

#[cfg(feature = "cluster-seed-runner")]
struct ClusterSeedRunner {
    package: wasmer_wasix::bin_factory::BinaryPackage,
    runtime: std::sync::Arc<dyn wasmer_wasix::runtime::Runtime + Send + Sync>,
    root_fs: std::sync::Arc<dyn wasmer_wasix::virtual_fs::FileSystem + Send + Sync>,
    pgdata_fs: std::sync::Arc<dyn wasmer_wasix::virtual_fs::FileSystem + Send + Sync>,
}

#[cfg(feature = "cluster-seed-runner")]
fn with_wasix_cluster_seed_runner(
    runtime_stage: &Path,
    work_root: &Path,
    profile: CatalogProfile,
    icu_data_root: Option<&Path>,
    pgdata_source: Option<&Path>,
    run: impl FnOnce(&ClusterSeedRunner) -> Result<()>,
) -> Result<()> {
    use std::sync::Arc;

    use wasmer::Engine;
    use wasmer_wasix::bin_factory::BinaryPackage;
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
    use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
    use wasmer_wasix::virtual_fs;

    validate_cluster_seed_work_root(runtime_stage, work_root, icu_data_root, pgdata_source)?;

    let package_dir = work_root.join("package");
    let package_root = work_root.join("root");
    let pgdata_root = work_root.join("pgdata");
    fs::create_dir_all(package_dir.join("modules"))
        .with_context(|| format!("create {}", package_dir.join("modules").display()))?;
    fs::create_dir_all(&pgdata_root)
        .with_context(|| format!("create {}", pgdata_root.display()))?;
    if let Some(source) = pgdata_source {
        copy_tree(source, &pgdata_root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pgdata_root, fs::Permissions::from_mode(0o700))
                .context("set private copied PGDATA permissions")?;
        }
    }
    copy_tree(runtime_stage, &package_root)?;
    let staged_icu_data = package_root.join("share/icu");
    if staged_icu_data.exists() {
        fs::remove_dir_all(&staged_icu_data)
            .with_context(|| format!("remove {}", staged_icu_data.display()))?;
    }
    match (profile, icu_data_root) {
        (CatalogProfile::Standard, None) => {}
        (CatalogProfile::Standard, Some(_)) => {
            bail!("standard cluster seed must not receive ICU data")
        }
        (CatalogProfile::Icu, Some(icu_data_root)) => {
            anyhow::ensure!(
                fs::symlink_metadata(icu_data_root.join("icudt76l.dat"))
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0),
                "ICU cluster seed requires a nonempty icudt76l.dat file"
            );
            copy_tree(icu_data_root, &staged_icu_data)?;
        }
        (CatalogProfile::Icu, None) => {
            bail!("ICU cluster seed requires verified ICU data")
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
        .context("create Tokio runtime for WASIX cluster seed")?;
    let _guard = tokio_runtime.enter();
    let engine = Engine::default();
    let task_manager = Arc::new(TokioTaskManager::new(tokio_runtime.handle().clone()));
    let mut runtime = PluggableRuntime::new(task_manager);
    runtime.set_engine(engine.clone());
    runtime.set_package_loader(LocalOnlyPackageLoader);
    let runtime: Arc<dyn Runtime + Send + Sync> = Arc::new(runtime);
    let package = tokio_runtime
        .block_on(BinaryPackage::from_dir(&package_dir, runtime.as_ref()))
        .context("load local WASIX cluster-seed package")?;
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

    run(&ClusterSeedRunner {
        package,
        runtime,
        root_fs,
        pgdata_fs,
    })
}

#[cfg(feature = "cluster-seed-runner")]
fn validate_cluster_seed_work_root(
    runtime_stage: &Path,
    work_root: &Path,
    icu_data_root: Option<&Path>,
    pgdata_source: Option<&Path>,
) -> Result<()> {
    anyhow::ensure!(
        !work_root
            .components()
            .any(|component| component == std::path::Component::ParentDir),
        "work directory must not contain parent components"
    );
    anyhow::ensure!(!work_root.exists(), "work directory must be new");
    let mut ancestor = if work_root.is_absolute() {
        work_root.to_path_buf()
    } else {
        std::env::current_dir()?.join(work_root)
    };
    let mut missing = Vec::new();
    let mut resolved = loop {
        match fs::canonicalize(&ancestor) {
            Ok(path) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .context("work directory has no existing ancestor")?
                        .to_os_string(),
                );
                anyhow::ensure!(ancestor.pop(), "work directory has no existing ancestor");
            }
            Err(error) => return Err(error).context("resolve cluster-seed work directory"),
        }
    };
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    match fs::symlink_metadata(&resolved) {
        Ok(_) => bail!("work directory must be new"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect resolved cluster-seed work directory"),
    }
    for source in [Some(runtime_stage), pgdata_source, icu_data_root]
        .into_iter()
        .flatten()
    {
        let input = fs::canonicalize(source)
            .with_context(|| format!("resolve seed input directory {}", source.display()))?;
        anyhow::ensure!(
            !resolved.starts_with(&input),
            "work directory must be outside seed input directory {}",
            source.display()
        );
    }
    Ok(())
}

#[cfg(not(feature = "cluster-seed-runner"))]
pub fn run_wasix_initdb_cluster_seed(
    _runtime_stage: &Path,
    _work_root: &Path,
    _profile: CatalogProfile,
    _icu_data_root: Option<&Path>,
) -> Result<()> {
    bail!(
        "WASIX seed generation requires the seed producer's `cluster-seed-runner` feature; run `bash src/database-resources/seeds/build.sh`"
    )
}

#[cfg(not(feature = "cluster-seed-runner"))]
pub fn verify_wasix_cluster_seed(
    _runtime_stage: &Path,
    _work_root: &Path,
    _profile: CatalogProfile,
    _pgdata_source: &Path,
    _icu_data_root: Option<&Path>,
) -> Result<()> {
    bail!("WASIX seed verification requires the seed producer's `cluster-seed-runner` feature")
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
    runner: &ClusterSeedRunner,
    profile: CatalogProfile,
) -> Result<()> {
    const CONTRACT_JSON: &str = include_str!("../../../contracts/profile-probe.json");

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
        let label = format!(
            "{} WASIX cluster-seed profile probe (attempt {attempt})",
            profile.as_str()
        );
        let stdout = runner.run_sql(profile, &format!("{};\n", probe.sql), &label)?;
        if !stdout.contains(&probe.expected) {
            print_captured_wasix_output("profile probe stdout", &stdout);
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
impl ClusterSeedRunner {
    fn run_sql(&self, profile: CatalogProfile, sql: &str, label: &str) -> Result<String> {
        use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
        use wasmer_wasix::virtual_fs;

        let (stdout_file, stdout_capture) = TailCaptureFile::new(64 * 1024);
        let (stderr_file, stderr_capture) = TailCaptureFile::new(64 * 1024);
        let mut runner = WasiRunner::new();
        runner.with_current_dir("/");
        runner.with_mount("/".to_owned(), self.root_fs.clone());
        runner.with_mount("/base".to_owned(), self.pgdata_fs.clone());
        runner.with_args(vec!["--single", "-D", "/base", "postgres"]);
        runner.with_envs(cluster_seed_environment(profile));
        runner.with_stdin(Box::new(virtual_fs::StaticFile::new(
            sql.as_bytes().to_vec(),
        )));
        runner.with_stdout(Box::new(stdout_file));
        runner.with_stderr(Box::new(stderr_file));
        let result = runner.run_command(
            "postgres",
            &self.package,
            RuntimeOrEngine::Runtime(self.runtime.clone()),
        );
        let stdout = stdout_capture.text();
        let stderr = stderr_capture.text();
        let sql_failed = stdout_capture.saw_postgres_error() || stderr_capture.saw_postgres_error();
        let failed = result.is_err() || sql_failed;
        if std::env::var_os("OLIPHAUNT_WASM_CLUSTER_SEED_LOG").is_some() || failed {
            print_captured_wasix_output(&format!("{label} stdout"), &stdout);
            print_captured_wasix_output(&format!("{label} stderr"), &stderr);
        }
        result.with_context(|| format!("run {label}"))?;
        anyhow::ensure!(
            !sql_failed,
            "{label} emitted PostgreSQL ERROR, FATAL, or PANIC"
        );
        Ok(stdout)
    }
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
    postgres_error: bool,
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
        // Keep failure evidence even when later output displaces it from the captured tail.
        let mut scan = state
            .bytes
            .iter()
            .rev()
            .take(5)
            .copied()
            .collect::<Vec<_>>();
        scan.reverse();
        scan.extend_from_slice(bytes);
        state.postgres_error |= scan
            .windows(6)
            .any(|window| matches!(window, b"ERROR:" | b"FATAL:" | b"PANIC:"));
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
    fn saw_postgres_error(&self) -> bool {
        self.inner
            .lock()
            .map(|state| state.postgres_error)
            .unwrap_or(true)
    }

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

#[cfg(feature = "cluster-seed-runner")]
fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, destination).with_context(|| format!("copy {}", source.display()))?;
    Ok(())
}

#[cfg(feature = "cluster-seed-runner")]
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    anyhow::ensure!(
        fs::symlink_metadata(source)?.is_dir(),
        "seed input must be a regular directory: {}",
        source.display()
    );
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        } else if kind.is_file() {
            copy_file(&entry.path(), &destination.join(entry.file_name()))?;
        } else {
            bail!(
                "seed input must contain only regular files and directories: {}",
                entry.path().display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn rejects_missing_empty_pgdata_directory() -> Result<()> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-seed-layout-{}-{nonce}",
            std::process::id()
        ));
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/contract.json"))?;
        for directory in contract["pgdataDirectories"].as_array().unwrap() {
            fs::create_dir_all(root.join(directory.as_str().unwrap()))?;
        }
        clean_generated_cluster_seed(&root)?;
        fs::remove_dir(root.join("pg_notify"))?;
        let error = clean_generated_cluster_seed(&root).unwrap_err();
        fs::remove_dir_all(root)?;
        assert!(error.to_string().contains("pg_notify"));
        Ok(())
    }

    #[cfg(feature = "cluster-seed-runner")]
    fn work_root_fixture() -> Result<std::path::PathBuf> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-seed-work-root-{}-{nonce}",
            std::process::id()
        ));
        for name in ["runtime", "pgdata", "icu", "outside"] {
            fs::create_dir_all(root.join(name))?;
        }
        Ok(root)
    }

    #[cfg(feature = "cluster-seed-runner")]
    #[test]
    fn rejects_work_inside_inputs_before_creating_missing_parents() -> Result<()> {
        let root = work_root_fixture()?;
        let runtime = root.join("runtime");
        let pgdata = root.join("pgdata");
        let icu = root.join("icu");
        for input in [&runtime, &pgdata, &icu] {
            let work = input.join("missing/also-missing/work");
            let error = validate_cluster_seed_work_root(&runtime, &work, Some(&icu), Some(&pgdata))
                .unwrap_err();
            assert!(error.to_string().contains("outside seed input directory"));
            assert!(!input.join("missing").exists());
            let error = validate_cluster_seed_work_root(&runtime, input, Some(&icu), Some(&pgdata))
                .unwrap_err();
            assert!(error.to_string().contains("work directory must be new"));
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(feature = "cluster-seed-runner")]
    #[test]
    fn accepts_unrelated_new_workspace_without_creating_it() -> Result<()> {
        let root = work_root_fixture()?;
        let work = root.join("outside/missing/also-missing/work");
        validate_cluster_seed_work_root(
            &root.join("runtime"),
            &work,
            Some(&root.join("icu")),
            Some(&root.join("pgdata")),
        )?;
        assert!(!root.join("outside/missing").exists());
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(feature = "cluster-seed-runner")]
    #[test]
    fn rejects_parent_components_before_mutating_inputs() -> Result<()> {
        let root = work_root_fixture()?;
        let runtime = root.join("runtime");
        let pgdata = root.join("pgdata");
        let icu = root.join("icu");
        for input in [&runtime, &pgdata, &icu] {
            fs::write(input.join("frozen-input"), "unchanged")?;
            let work = input.join("missing/../../outside/work");
            let error = validate_cluster_seed_work_root(&runtime, &work, Some(&icu), Some(&pgdata))
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("must not contain parent components")
            );
            assert_eq!(fs::read_to_string(input.join("frozen-input"))?, "unchanged");
            assert_eq!(fs::read_dir(input)?.count(), 1);
        }
        assert!(!root.join("outside/work").exists());
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(all(feature = "cluster-seed-runner", unix))]
    #[test]
    fn rejects_work_inside_symlink_aliased_inputs() -> Result<()> {
        let root = work_root_fixture()?;
        let runtime = root.join("runtime");
        let pgdata = root.join("pgdata");
        let icu = root.join("icu");
        let aliases = [
            root.join("runtime-alias"),
            root.join("pgdata-alias"),
            root.join("icu-alias"),
        ];
        for (input, alias) in [&runtime, &pgdata, &icu].into_iter().zip(&aliases) {
            std::os::unix::fs::symlink(input, alias)?;
        }
        for (input, alias) in [&runtime, &pgdata, &icu].into_iter().zip(&aliases) {
            for work in [
                input.join("missing/also-missing/work"),
                alias.join("missing/also-missing/work"),
            ] {
                let error = validate_cluster_seed_work_root(
                    &aliases[0],
                    &work,
                    Some(&aliases[2]),
                    Some(&aliases[1]),
                )
                .unwrap_err();
                assert!(error.to_string().contains("outside seed input directory"));
                assert!(!input.join("missing").exists());
            }
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(feature = "cluster-seed-runner")]
    #[test]
    fn retains_postgres_errors_across_chunks_and_tail_eviction() {
        for severity in [b"ERROR:".as_slice(), b"FATAL:", b"PANIC:"] {
            let (file, capture) = TailCaptureFile::new(64);
            file.push_tail(&severity[..3]);
            assert!(!capture.saw_postgres_error());
            file.push_tail(&severity[3..]);
            file.push_tail(&vec![b' '; 128]);
            file.push_tail(b"oliphaunt-standard-seed-ok");
            assert!(capture.text().contains("oliphaunt-standard-seed-ok"));
            assert!(
                !capture
                    .text()
                    .contains(std::str::from_utf8(severity).unwrap())
            );
            assert!(capture.saw_postgres_error());
        }
        let (file, capture) = TailCaptureFile::new(64);
        file.push_tail(b"oliphaunt-standard-seed-ok");
        assert!(!capture.saw_postgres_error());
    }
}
