use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail, ensure};
use directories::ProjectDirs;
use futures_util::future::try_join_all;
use pglite_oxide::{
    EngineKind, Pglite, PgliteServer, PgliteServerRuntimeConfig, PhaseTiming,
    ProtocolStatsSnapshot, WasixBtreeBottomupDeleteMode, WasmerCompiler, capture_phase_timings,
    disable_protocol_stats, extensions, fs_trace_snapshot, measure_phase, packaged_runtime_kind,
    protocol_stats_snapshot, record_phase_timing, reset_fs_trace, reset_protocol_stats,
    using_wasix_postgres_server_core_assets,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{Connection, Executor, Row};
use walkdir::WalkDir;
use wasmparser::{Dylink0Subsection, ExternalKind, KnownCustom, Name, Parser, Payload, TypeRef};
use zstd::stream::write::Encoder as ZstdEncoder;

mod extension_catalog;

const POSTGRES_PGLITE_SOURCE: &str = "postgres-pglite";
const POSTGRES_PGLITE_PATH: &str = "assets/checkouts/postgres-pglite";
const PGLITE_BUILD_SOURCE: &str = "pglite-build";
const PGLITE_BUILD_PATH: &str = "assets/checkouts/pglite-build";
const WASIX_BUILD_ROOT: &str = "assets/wasix-build";
const WASIX_DOCKER_BUILD_DIR: &str = "assets/wasix-build/work/docker-pglite";
const WASIX_PATCHED_SOURCE_DIR: &str = "assets/wasix-build/work/postgres-pglite-wasix-src";
const WASIX_BUILD_MANIFEST_PATH: &str = "assets/wasix-build/build/outputs.json";
const WASIX_PATCH_PATH: &str = "assets/wasix-build/patches/postgres-pglite-wasix-dl.patch";
const WASIX_BRIDGE_PATH: &str = "assets/wasix-build/wasix_shim/pglite_wasix_bridge.c";
const RUNTIME_KIND_WASIX_DIRECT: &str = "wasix-dynamic-main";
const RUNTIME_KIND_WASIX_POSTGRES_SERVER: &str = "wasix-postgres-server";
const DEFAULT_ASSET_BUILD_PROFILE: &str = "release-o3";
const VALIDATE_XTASK_ENV: &str = "PGLITE_OXIDE_XTASK";
const PGVECTOR_BUILD_DIR: &str = "assets/checkouts/pgvector";
const POSTGRES_OTHER_EXTENSIONS: &str = "assets/checkouts/postgres-pglite/pglite/other_extensions";
const PGLITE_BENCHMARK_SQL_DIR: &str = "assets/checkouts/pglite/packages/benchmark/src";
const SAME_SQL_CASE8_MAX_REPEAT_COUNT: usize = 14;
const EXPECTED_PGLITE_BUILD_BRANCH: &str = "portable";
const ASSET_INPUT_FINGERPRINT_PATH: &str = "assets/generated/asset-inputs.sha256";
const GENERATED_ASSETS_DIR: &str = "target/pglite-oxide/assets";
const ASSET_CRATE_PAYLOAD_DIR: &str = "crates/assets/payload";
const RELEASE_STAGE_DIR: &str = "target/pglite-oxide/release";
const RELEASE_ASSET_BUNDLE_DIR: &str = "target/pglite-oxide/release-assets";
const LEGACY_STATIC_WASI_ARCHIVE: &str = concat!("assets/", "pglite-", "wasi.tar.zst");

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

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("assets") => assets(args.collect()),
        Some("extensions") => extension_catalog::extensions(args.collect()),
        Some("release") => release(args.collect()),
        Some("package-size") => package_size(args.collect()),
        Some("perf") => perf(args.collect()),
        Some("aot-serializer") => aot_serializer(args.collect()),
        Some("help") | None => {
            print_usage();
            Ok(())
        }
        Some(other) => bail!("unknown xtask command: {other}"),
    }
}

fn assets(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("check") => {
            let strict_local = args.iter().any(|arg| arg == "--strict-local");
            let strict_generated = args.iter().any(|arg| arg == "--strict-generated");
            let release_staged = is_release_staged_workspace();
            let manifest = check_sources_manifest(strict_local)?;
            check_source_free_repo()?;
            check_no_legacy_runtime_shims()?;
            check_production_wasix_build_inputs()?;
            check_rust_startup_abi_boundary()?;
            check_canonical_asset_layout(strict_generated)?;
            check_generated_manifest(&manifest, strict_generated)?;
            if strict_generated {
                verify_asset_manifest_hashes()?;
                verify_generated_extension_surface()?;
            }
            if !release_staged {
                extension_catalog::check_catalog_file(strict_generated)?;
                extension_catalog::check_build_plan_file(strict_generated)?;
            }
            check_generated_wasix_export_list(strict_generated)
        }
        Some("verify-committed") => verify_committed_assets(),
        Some("audit-upstream") => {
            let strict = args.iter().any(|arg| arg == "--strict");
            let manifest = check_sources_manifest(false)?;
            audit_upstream_fixes(&manifest, strict)
        }
        Some("build") => {
            let manifest = check_sources_manifest(false)?;
            let profile = value_after(&args, "--profile").unwrap_or(DEFAULT_ASSET_BUILD_PROFILE);
            let target = value_after(&args, "--target-triple").unwrap_or(env::consts::ARCH);
            build_asset_spine(&manifest, profile, target, &args)
        }
        Some("template") => {
            let manifest = check_sources_manifest(false)?;
            generate_pgdata_template_asset(&manifest)
        }
        Some("fetch") => {
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            fetch_pinned_sources(&manifest)
        }
        Some("release-build") => {
            let manifest = check_sources_manifest_for_asset_build(&args)?;
            let profile = value_after(&args, "--profile").unwrap_or(DEFAULT_ASSET_BUILD_PROFILE);
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            release_build_assets(&manifest, profile, target, &args)
        }
        Some("build-host") => {
            let manifest = check_sources_manifest_for_asset_build(&args)?;
            release_build_assets(
                &manifest,
                DEFAULT_ASSET_BUILD_PROFILE,
                host_target_triple(),
                &args,
            )
        }
        Some("download") => download_assets(&args),
        Some("install-local") => install_local_assets(&args),
        Some("ci-matrix") => print_aot_ci_matrix(&args),
        Some("ci-artifacts") => print_ci_artifact_names(),
        Some("aot-targets") => print_supported_aot_targets(),
        Some("internal-packages") => print_internal_asset_packages(),
        Some("package") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            package_assets(&manifest, target)
        }
        Some("package-aot") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            package_aot_only(&manifest, target)
        }
        Some("check-aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            check_aot_package_manifest(target)
        }
        Some("export-list") => {
            let write = args.iter().any(|arg| arg == "--write");
            generate_wasix_export_list(write)
        }
        Some("input-fingerprint") => {
            let write = args.iter().any(|arg| arg == "--write");
            let explain = args.iter().any(|arg| arg == "--explain");
            for arg in &args[1..] {
                match arg.as_str() {
                    "--write" | "--explain" => {}
                    other => bail!("unknown assets input-fingerprint flag: {other}"),
                }
            }
            check_or_write_asset_input_fingerprint(write, explain)
        }
        Some("aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            generate_aot_artifacts(target)
        }
        Some("source-spine") => {
            let check_patch = args.iter().any(|arg| arg == "--check-patch-applies");
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            println!("validated {} pinned asset sources", manifest.sources.len());
            check_source_spine(&manifest, true, check_patch)
        }
        Some("smoke") => run_asset_smoke_tests(&args[1..]),
        Some(other) => bail!("unknown assets subcommand: {other}"),
        None => {
            bail!(
                "usage: cargo run -p xtask -- assets <check|verify-committed|audit-upstream|source-spine|fetch|build|template|build-host|release-build|download|install-local|ci-matrix|ci-artifacts|aot-targets|internal-packages|package|package-aot|check-aot|smoke>"
            )
        }
    }
}

fn release(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("stage") => stage_release_workspace(),
        Some("package-assets") => package_release_assets(),
        Some("dry-run") => {
            stage_release_workspace()?;
            run_in_release_workspace("tools/scripts/validate.sh", &["release", "--allow-dirty"])
        }
        Some("publish") => {
            stage_release_workspace()?;
            run_in_release_workspace("tools/scripts/validate.sh", &["release", "--allow-dirty"])?;
            bail!(
                "xtask release publish staged and validated the release workspace, but publishing still belongs to the Release workflow/release-plz until Trusted Publishing is configured"
            )
        }
        Some(other) => bail!("unknown release subcommand: {other}"),
        None => {
            bail!("usage: cargo run -p xtask -- release <stage|package-assets|dry-run|publish>")
        }
    }
}

fn aot_serializer(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("serialize") => serialize_aot_cli(&args[1..]),
        Some("probe") => probe_aot_serializer_in_process(),
        Some(other) => bail!("unknown aot-serializer subcommand: {other}"),
        None => bail!(
            "usage: cargo run -p xtask --features aot-serializer -- aot-serializer <serialize|probe>"
        ),
    }
}

#[cfg(not(feature = "aot-serializer"))]
fn serialize_aot_cli(_args: &[String]) -> Result<()> {
    bail!("xtask aot-serializer requires `cargo run -p xtask --features aot-serializer -- ...`")
}

#[cfg(feature = "aot-serializer")]
fn serialize_aot_cli(args: &[String]) -> Result<()> {
    let input = value_after(args, "--input")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--input is required"))?;
    let output = value_after(args, "--output")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--output is required"))?;
    serialize_aot_module(&input, &output)
}

#[cfg(not(feature = "aot-serializer"))]
fn probe_aot_serializer_in_process() -> Result<()> {
    bail!(
        "xtask aot-serializer probe requires `cargo run -p xtask --features aot-serializer -- ...`"
    )
}

#[cfg(feature = "aot-serializer")]
fn probe_aot_serializer_in_process() -> Result<()> {
    let engine = llvm_aot_engine();
    let store = wasmer::Store::new(engine.clone());
    const EMPTY_WASM: &[u8] = b"\0asm\x01\0\0\0";
    let module =
        wasmer::Module::new(&store, EMPTY_WASM).context("compile LLVM AOT probe module")?;
    let serialized = module
        .serialize()
        .context("serialize LLVM AOT probe module")?;
    print_aot_engine_config(&engine);
    println!("serialized-probe-bytes: {}", serialized.len());
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn serialize_aot_module(input: &Path, output: &Path) -> Result<()> {
    let engine = llvm_aot_engine();
    print_aot_engine_config(&engine);
    println!("host-target: {}-{}", env::consts::OS, env::consts::ARCH);

    let store = wasmer::Store::new(engine);
    let bytes = fs::read(input).with_context(|| format!("read {}", input.display()))?;
    let module = wasmer::Module::new(&store, &bytes)
        .with_context(|| format!("compile {}", input.display()))?;
    let serialized = module.serialize().context("serialize module")?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    let mut encoder = ZstdEncoder::new(file, 19)
        .with_context(|| format!("create zstd encoder for {}", output.display()))?;
    let mut serialized_slice = serialized.as_ref();
    io::copy(&mut serialized_slice, &mut encoder)
        .with_context(|| format!("write {}", output.display()))?;
    encoder
        .finish()
        .with_context(|| format!("finish {}", output.display()))?;
    println!(
        "serialized {} bytes to {}",
        serialized.len(),
        output.display()
    );
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn llvm_aot_engine() -> wasmer::Engine {
    use wasmer::sys::{CompilerConfig, EngineBuilder, Features, LLVM};

    let mut features = Features::new();
    features.exceptions(true);
    let mut llvm = LLVM::default();
    if env_flag("PGLITE_OXIDE_WASMER_PERFMAP") {
        llvm.enable_perfmap();
    }
    llvm.enable_non_volatile_memops();
    llvm.enable_readonly_funcref_table();
    EngineBuilder::new(llvm)
        .set_target(Some(portable_aot_target()))
        .set_features(Some(features))
        .engine()
        .into()
}

#[cfg(feature = "aot-serializer")]
fn portable_aot_target() -> wasmer_types::target::Target {
    use wasmer_types::target::{Architecture, CpuFeature, Target, Triple};

    let triple = Triple::host();
    let mut cpu_features = CpuFeature::set();
    match triple.architecture {
        Architecture::X86_64 => {
            cpu_features.insert(CpuFeature::SSE2);
        }
        Architecture::Aarch64(_) => {
            cpu_features.insert(CpuFeature::NEON);
        }
        _ => {}
    }

    Target::new(triple, cpu_features)
}

#[cfg(feature = "aot-serializer")]
fn print_aot_engine_config(engine: &wasmer::Engine) {
    let target = portable_aot_target();
    println!("wasmer-engine: llvm");
    println!("wasmer-engine-id: {}", engine.deterministic_id());
    println!("wasmer-target-triple: {}", target.triple());
    println!(
        "wasmer-target-cpu-features: {}",
        format_aot_cpu_features(&target)
    );
    println!("wasmer-feature-exceptions: enabled");
    println!("wasmer-llvm-target-cpu: generic");
    println!("wasmer-llvm-non-volatile-memops: enabled");
    println!("wasmer-llvm-readonly-funcref-table: enabled");
}

#[cfg(feature = "aot-serializer")]
fn format_aot_cpu_features(target: &wasmer_types::target::Target) -> String {
    let mut features = target
        .cpu_features()
        .iter()
        .map(|feature| feature.to_string())
        .collect::<Vec<_>>();
    features.sort();
    if features.is_empty() {
        "none".to_owned()
    } else {
        features.join(",")
    }
}

#[cfg(feature = "aot-serializer")]
fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let value = value.trim();
            !value.is_empty()
                && !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
        })
        .unwrap_or(false)
}

fn package_size(args: Vec<String>) -> Result<()> {
    let enforce = args.iter().any(|arg| arg == "--enforce");
    let package_dir = Path::new("target/package");
    if !package_dir.exists() {
        fs::create_dir_all(package_dir)
            .with_context(|| format!("create {}", package_dir.display()))?;
    } else {
        fs::remove_dir_all(package_dir)
            .with_context(|| format!("remove {}", package_dir.display()))?;
    }
    run(
        "cargo",
        &[
            "package",
            "--workspace",
            "--exclude",
            "xtask",
            "--locked",
            "--no-verify",
            "--allow-dirty",
        ],
    )?;

    let limit = 10 * 1024 * 1024;
    let mut failures = Vec::new();
    for entry in WalkDir::new(package_dir).max_depth(1) {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("crate") {
            continue;
        }
        let size = entry.metadata()?.len();
        println!("{} {} bytes", path.display(), size);
        if size > limit {
            failures.push((path.to_path_buf(), size));
        }
    }

    if enforce && !failures.is_empty() {
        let details = failures
            .iter()
            .map(|(path, size)| format!("{} ({size} bytes)", path.display()))
            .collect::<Vec<_>>()
            .join(", ");
        bail!("crate package size limit exceeded: {details}");
    }
    Ok(())
}

fn download_assets(args: &[String]) -> Result<()> {
    let targets = asset_download_targets(args)?;
    if args.iter().any(|arg| arg == "--release") {
        let tag = value_after(args, "--release").context("--release requires a tag")?;
        ensure!(
            value_after(args, "--run-id").is_none()
                && value_after(args, "--sha").is_none()
                && !args.iter().any(|arg| arg == "--latest-compatible"),
            "assets download accepts only one of --run-id, --sha, --latest-compatible, or --release"
        );
        download_assets_from_release(tag, &targets)?;
        let target_list = targets.join(", ");
        println!("downloaded and installed release assets from {tag} / {target_list}");
        return Ok(());
    }

    let candidates = asset_download_run_candidates(args)?;
    let mut last_error = None;

    for run_id in candidates {
        match download_assets_from_run(&run_id, &targets) {
            Ok(()) => {
                let target_list = targets.join(", ");
                println!(
                    "downloaded and installed Assets workflow artifacts from run {run_id} / {target_list}"
                );
                return Ok(());
            }
            Err(error) => {
                if args.iter().any(|arg| arg == "--latest-compatible") {
                    eprintln!(
                        "Assets workflow run {run_id} is not compatible with this checkout: {error:#}"
                    );
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }

    if let Some(error) = last_error {
        Err(error).context("no compatible successful Assets workflow artifact found")
    } else {
        bail!("no successful Assets workflow artifact found")
    }
}

fn asset_download_targets(args: &[String]) -> Result<Vec<String>> {
    let all_targets = args.iter().any(|arg| arg == "--all-targets");
    let explicit_target = value_after(args, "--target-triple");
    if all_targets && explicit_target.is_some() {
        bail!("assets download accepts either --all-targets or --target-triple, not both");
    }
    if all_targets {
        Ok(supported_aot_targets()
            .iter()
            .map(|target| (*target).to_owned())
            .collect())
    } else {
        let target = explicit_target.unwrap_or(host_target_triple());
        ensure_supported_aot_target(target)?;
        Ok(vec![target.to_owned()])
    }
}

fn asset_download_run_candidates(args: &[String]) -> Result<Vec<String>> {
    let run_id = value_after(args, "--run-id");
    let sha = value_after(args, "--sha");
    let latest_compatible = args.iter().any(|arg| arg == "--latest-compatible");
    let selected_modes =
        usize::from(run_id.is_some()) + usize::from(sha.is_some()) + usize::from(latest_compatible);
    if selected_modes != 1 {
        bail!(
            "assets download requires exactly one of --run-id <id>, --sha <sha>, or --latest-compatible"
        );
    }

    if let Some(run_id) = run_id {
        return Ok(vec![run_id.to_owned()]);
    }

    if let Some(sha) = sha {
        let output = command_output(
            "gh",
            &[
                "run",
                "list",
                "--workflow",
                "Assets",
                "--commit",
                sha,
                "--status",
                "success",
                "--limit",
                "1",
                "--json",
                "databaseId",
                "--jq",
                ".[].databaseId",
            ],
            Path::new("."),
        )
        .with_context(|| format!("find successful Assets workflow run for SHA {sha}"))?;
        return parse_gh_run_ids(&output);
    }

    let branch = value_after(args, "--branch").unwrap_or("main");
    let output = command_output(
        "gh",
        &[
            "run",
            "list",
            "--workflow",
            "Assets",
            "--branch",
            branch,
            "--status",
            "success",
            "--limit",
            "20",
            "--json",
            "databaseId",
            "--jq",
            ".[].databaseId",
        ],
        Path::new("."),
    )
    .with_context(|| format!("find latest successful Assets workflow runs on {branch}"))?;
    parse_gh_run_ids(&output)
}

fn parse_gh_run_ids(output: &str) -> Result<Vec<String>> {
    let runs = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "null")
        .map(str::to_owned)
        .collect::<Vec<_>>();
    ensure!(
        !runs.is_empty(),
        "no successful Assets workflow artifact found"
    );
    Ok(runs)
}

fn download_assets_from_run(run_id: &str, targets: &[String]) -> Result<()> {
    let download_dir = Path::new("target/pglite-oxide/downloads").join(run_id);
    if download_dir.exists() {
        fs::remove_dir_all(&download_dir)
            .with_context(|| format!("remove {}", download_dir.display()))?;
    }
    fs::create_dir_all(&download_dir)
        .with_context(|| format!("create {}", download_dir.display()))?;
    run(
        "gh",
        &[
            "run",
            "download",
            run_id,
            "--name",
            "pglite-oxide-portable-wasix",
            "--dir",
            download_dir.to_str().expect("download dir is utf-8"),
        ],
    )?;
    for target in targets {
        let target_download_dir = download_dir.join(generated_aot_dir(target));
        fs::create_dir_all(&target_download_dir)
            .with_context(|| format!("create {}", target_download_dir.display()))?;
        run(
            "gh",
            &[
                "run",
                "download",
                run_id,
                "--name",
                &format!("pglite-oxide-aot-{target}"),
                "--dir",
                target_download_dir.to_str().expect("download dir is utf-8"),
            ],
        )?;
    }
    verify_downloaded_asset_fingerprint(&download_dir)?;
    install_downloaded_artifacts(&download_dir, targets)?;
    for target in targets {
        install_local_assets_for_target(target)?;
    }
    Ok(())
}

fn download_assets_from_release(tag: &str, targets: &[String]) -> Result<()> {
    let download_dir = Path::new("target/pglite-oxide/downloads").join(format!("release-{tag}"));
    if download_dir.exists() {
        fs::remove_dir_all(&download_dir)
            .with_context(|| format!("remove {}", download_dir.display()))?;
    }
    fs::create_dir_all(&download_dir)
        .with_context(|| format!("create {}", download_dir.display()))?;

    download_and_extract_release_asset(tag, "pglite-oxide-portable-wasix.tar.zst", &download_dir)?;
    for target in targets {
        download_and_extract_release_asset(
            tag,
            &format!("pglite-oxide-aot-{target}.tar.zst"),
            &download_dir,
        )?;
    }

    verify_downloaded_asset_fingerprint(&download_dir)?;
    install_downloaded_artifacts(&download_dir, targets)?;
    for target in targets {
        install_local_assets_for_target(target)?;
    }
    Ok(())
}

fn download_and_extract_release_asset(tag: &str, asset: &str, download_dir: &Path) -> Result<()> {
    let archive = download_dir.join(asset);
    let url = format!("https://github.com/f0rr0/pglite-oxide/releases/download/{tag}/{asset}");
    run(
        "curl",
        &[
            "-fsSL",
            "--retry",
            "3",
            "--output",
            archive
                .to_str()
                .expect("release asset archive path is utf-8"),
            &url,
        ],
    )
    .with_context(|| format!("download release asset {asset} from {url}"))?;
    extract_tar_zst(&archive, download_dir)
        .with_context(|| format!("extract release asset {}", archive.display()))?;
    Ok(())
}

fn extract_tar_zst(archive: &Path, destination: &Path) -> Result<()> {
    let file = fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", archive.display()))?;
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(destination).with_context(|| {
        format!(
            "unpack {} into {}",
            archive.display(),
            destination.display()
        )
    })
}

fn verify_downloaded_asset_fingerprint(download_dir: &Path) -> Result<()> {
    let expected = fs::read_to_string(ASSET_INPUT_FINGERPRINT_PATH)
        .with_context(|| format!("read {}", ASSET_INPUT_FINGERPRINT_PATH))?;
    let downloaded_path = download_dir.join(ASSET_INPUT_FINGERPRINT_PATH);
    let downloaded = fs::read_to_string(&downloaded_path)
        .with_context(|| format!("read {}", downloaded_path.display()))?;
    ensure_eq(
        downloaded.trim(),
        expected.trim(),
        "downloaded asset-input fingerprint",
    )
}

fn install_downloaded_artifacts(download_dir: &Path, targets: &[String]) -> Result<()> {
    let downloaded_assets = download_dir.join(GENERATED_ASSETS_DIR);
    ensure_file(&downloaded_assets.join("manifest.json"))?;
    copy_dir_all(&downloaded_assets, Path::new(GENERATED_ASSETS_DIR))?;

    for target in targets {
        let downloaded_aot = download_dir.join("target/pglite-oxide/aot").join(target);
        ensure_file(&downloaded_aot.join("manifest.json"))?;
        copy_dir_all(&downloaded_aot, &generated_aot_dir(target))?;
    }
    Ok(())
}

fn install_local_assets(args: &[String]) -> Result<()> {
    let target = value_after(args, "--target-triple").unwrap_or(host_target_triple());
    install_local_assets_for_target(target)
}

fn install_local_assets_for_target(target: &str) -> Result<()> {
    ensure_supported_aot_target(target)?;
    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    check_canonical_asset_layout(true)?;
    check_generated_manifest(&load_sources_manifest()?, true)?;
    verify_asset_manifest_hashes()?;
    verify_generated_extension_surface()?;

    find_aot_artifact_dir(target)?;
    check_aot_package_manifest(target)?;
    println!("local generated assets are installed for {target}");
    Ok(())
}

fn run_asset_smoke_tests(args: &[String]) -> Result<()> {
    if let Some(arg) = args.first() {
        bail!("unknown assets smoke flag: {arg}");
    }
    run_validate_script("runtime")
}

fn stage_release_workspace() -> Result<()> {
    let stage_root = Path::new(RELEASE_STAGE_DIR);
    let workspace = stage_root.join("workspace");
    if stage_root.exists() {
        fs::remove_dir_all(stage_root)
            .with_context(|| format!("remove {}", stage_root.display()))?;
    }
    fs::create_dir_all(&workspace).with_context(|| format!("create {}", workspace.display()))?;

    let tracked = command_output(
        "git",
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        Path::new("."),
    )?;
    for path in tracked.split('\0').filter(|path| !path.is_empty()) {
        let source = Path::new(path);
        let destination = workspace.join(path);
        copy_file(source, &destination)?;
    }

    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    copy_dir_all(generated_assets, &workspace.join(ASSET_CRATE_PAYLOAD_DIR))?;
    copy_dir_all(generated_assets, &workspace.join(GENERATED_ASSETS_DIR))?;
    update_staged_root_asset_metadata(&workspace)?;

    for target in supported_aot_targets() {
        let generated_aot = generated_aot_dir(target);
        if generated_aot.join("manifest.json").is_file() {
            copy_dir_all(
                &generated_aot,
                &workspace.join("crates/aot").join(target).join("artifacts"),
            )?;
            copy_dir_all(
                &generated_aot,
                &workspace.join("target/pglite-oxide/aot").join(target),
            )?;
        }
    }

    fs::write(
        stage_root.join("README.txt"),
        "Generated pglite-oxide release workspace.\n",
    )
    .with_context(|| format!("write {}", stage_root.join("README.txt").display()))?;
    println!("staged release workspace at {}", workspace.display());
    Ok(())
}

fn package_release_assets() -> Result<()> {
    let output_dir = Path::new(RELEASE_ASSET_BUNDLE_DIR);
    if output_dir.exists() {
        fs::remove_dir_all(output_dir)
            .with_context(|| format!("remove {}", output_dir.display()))?;
    }
    fs::create_dir_all(output_dir).with_context(|| format!("create {}", output_dir.display()))?;

    let mut bundles = Vec::new();
    bundles.push(package_release_portable_assets(output_dir)?);
    for target in supported_aot_targets() {
        bundles.push(package_release_aot_assets(output_dir, target)?);
    }

    let mut checksum_lines = Vec::new();
    for bundle in &bundles {
        let name = bundle
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                anyhow!(
                    "release asset path is not valid UTF-8: {}",
                    bundle.display()
                )
            })?;
        checksum_lines.push(format!("{}  {name}", sha256_file(bundle)?));
    }
    checksum_lines.sort();
    let checksum_path = output_dir.join("pglite-oxide-release-assets.sha256");
    fs::write(&checksum_path, format!("{}\n", checksum_lines.join("\n")))
        .with_context(|| format!("write {}", checksum_path.display()))?;

    println!("packaged public release assets in {}", output_dir.display());
    Ok(())
}

fn package_release_portable_assets(output_dir: &Path) -> Result<PathBuf> {
    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    ensure_file(Path::new(ASSET_INPUT_FINGERPRINT_PATH))?;

    let staging = output_dir.join("staging/portable-wasix");
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    }
    copy_dir_all(generated_assets, &staging.join(GENERATED_ASSETS_DIR))?;
    copy_dir_all(
        Path::new("assets/generated"),
        &staging.join("assets/generated"),
    )?;

    let output = output_dir.join("pglite-oxide-portable-wasix.tar.zst");
    deterministic_tar_zst(&staging, Path::new(""), &output)?;
    fs::remove_dir_all(&staging).with_context(|| format!("remove {}", staging.display()))?;
    Ok(output)
}

fn package_release_aot_assets(output_dir: &Path, target: &str) -> Result<PathBuf> {
    ensure_supported_aot_target(target)?;
    let generated_aot = generated_aot_dir(target);
    ensure_file(&generated_aot.join("manifest.json"))?;

    let output = output_dir.join(format!("pglite-oxide-aot-{target}.tar.zst"));
    deterministic_tar_zst(
        &generated_aot,
        &Path::new("target/pglite-oxide/aot").join(target),
        &output,
    )?;
    Ok(output)
}

fn run_in_release_workspace(command: &str, args: &[&str]) -> Result<()> {
    let workspace = Path::new(RELEASE_STAGE_DIR).join("workspace");
    let mut command = command_for_host(command);
    command
        .args(args)
        .current_dir(&workspace)
        .env("PGLITE_OXIDE_RELEASE_STAGED", "1");
    run_command(&mut command)
}

fn perf(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("cold") => perf_cold(&args[1..]),
        Some("warm") => perf_warm(&args[1..]),
        Some("bench") => perf_bench(&args[1..]),
        Some("prepared-inserts") => perf_prepared_inserts(&args[1..]),
        Some("prepared-updates") => perf_prepared_updates(&args[1..]),
        Some("prepared-reads") => perf_prepared_reads(&args[1..]),
        Some("diagnose-indexed-update") => perf_diagnose_indexed_update(),
        Some("diagnose-speed-hotspots") => perf_diagnose_speed_hotspots(),
        Some("diagnose-speed-cases") => perf_diagnose_speed_cases(&args[1..]),
        Some("diagnose-speed-parity") => perf_diagnose_speed_parity(&args[1..]),
        Some("diagnose-select-shapes") => perf_diagnose_select_shapes(&args[1..]),
        Some("diagnose-select-shape-profile-compare") => {
            perf_diagnose_select_shape_profile_compare(&args[1..])
        }
        Some("diagnose-speed-profile-compare") => perf_diagnose_speed_profile_compare(&args[1..]),
        Some("diagnose-buffer-cache") => perf_diagnose_buffer_cache(),
        Some("native-postgres") => perf_native_postgres(&args[1..]),
        Some("native-postgres-open") => perf_native_postgres_open(&args[1..]),
        Some("native-libpglite") => perf_native_libpglite(&args[1..]),
        Some("native-libpglite-open") => perf_native_libpglite_open(&args[1..]),
        Some("native-libpglite-sdk") => perf_native_libpglite_sdk(&args[1..]),
        Some("pglite-server-open") => perf_pglite_server_open(&args[1..]),
        Some("native-libpglite-prepared-child") => perf_native_libpglite_prepared_child(&args[1..]),
        Some("pglite-nodefs-sqlx") => perf_pglite_nodefs_sqlx(&args[1..]),
        Some("smoke") => run(
            "cargo",
            &[
                "test",
                "--workspace",
                "--locked",
                "preload",
                "--",
                "--nocapture",
            ],
        ),
        Some(other) => bail!("unknown perf subcommand: {other}"),
        None => bail!(
            "usage: cargo run -p xtask -- perf <cold|warm|bench|prepared-inserts|prepared-updates|prepared-reads|native-postgres|native-postgres-open|native-libpglite|native-libpglite-open|native-libpglite-sdk|pglite-server-open|pglite-nodefs-sqlx|diagnose-indexed-update|diagnose-speed-hotspots|diagnose-speed-cases|diagnose-speed-parity|diagnose-select-shapes|diagnose-select-shape-profile-compare|diagnose-speed-profile-compare|diagnose-buffer-cache|smoke> [--reset-cache]"
        ),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColdPerfReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    cache_reset_requested: bool,
    cache_dir: String,
    cache_state_at_start: &'static str,
    measurement_model: &'static str,
    operations: Vec<PerfOperation>,
    experiments: Vec<ColdPerfExperiment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PerfOperation {
    name: &'static str,
    description: &'static str,
    cache_state_before: String,
    process_state_before: &'static str,
    root_state: &'static str,
    query_state: &'static str,
    workload: &'static str,
    primary_latency_phase: &'static str,
    primary_latency_micros: u128,
    elapsed_micros: u128,
    correct: bool,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WarmPerfReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    query_iterations: usize,
    connection_iterations: usize,
    measurement_model: &'static str,
    operations: Vec<PerfOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    wasmer_version: &'static str,
    wasmer_wasix_version: &'static str,
    source_model: &'static str,
    measurement_model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<BenchmarkRuntimeReport>,
    rtt_iterations: usize,
    speed_scale: f64,
    preload_micros: u128,
    runs: Vec<BenchmarkRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkRuntimeReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    packaged_runtime_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_archive_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_archive_override_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_bin_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_compiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_opt_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_native_cpu: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_full_o3_pipeline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_indirect_call_cache: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_profiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_compiler_threads: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_enable_async_threads: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_no_tty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasix_btree_bottomup_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostLoadReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    captured_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    logical_cpu_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_average_1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_average_5m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_average_15m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_per_logical_cpu_1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    likely_noisy: Option<bool>,
    top_cpu_processes: Vec<HostCpuProcessReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCpuProcessReport {
    pid: u32,
    cpu_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mem_percent: Option<f64>,
    command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkRun {
    suite: &'static str,
    mode: &'static str,
    description: &'static str,
    open_micros: u128,
    connect_micros: Option<u128>,
    setup_micros: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_server_peak_rss_bytes: Option<u64>,
    tests: Vec<BenchmarkTestResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPhaseReport {
    name: String,
    elapsed_micros: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpenReport {
    source_model: &'static str,
    measurement_model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<BenchmarkRuntimeReport>,
    runs: Vec<NativeOpenRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpenRun {
    mode: &'static str,
    description: &'static str,
    open_micros: u128,
    connect_micros: Option<u128>,
    first_query_micros: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_server_peak_rss_bytes: Option<u64>,
    phases: Vec<OpenPhaseReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkTestResult {
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    sample_count: usize,
    trimmed_sample_count: usize,
    elapsed_micros: u128,
    average_micros: Option<f64>,
    min_micros: Option<u128>,
    p50_micros: Option<u128>,
    p90_micros: Option<u128>,
    p95_micros: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateReport {
    source_model: &'static str,
    measurement_model: &'static str,
    gate_model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_variant: Option<DiagnosticSetupVariantReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<BenchmarkRuntimeReport>,
    rows: usize,
    passes: usize,
    runs: Vec<PreparedUpdateRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlx_native_comparison: Option<PreparedUpdateModeComparison>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateRun {
    mode: &'static str,
    description: &'static str,
    protocol_stats: Option<ProtocolStatsSnapshot>,
    tests: Vec<PreparedUpdateTest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateTest {
    id: &'static str,
    label: &'static str,
    open_micros: u128,
    connect_micros: u128,
    setup_micros: u128,
    prepare_micros: Option<u128>,
    elapsed_micros: u128,
    operation_count: usize,
    average_micros: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_profile: Option<SpeedHotspotCpuProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_analysis: Option<PreparedUpdateProfileAnalysis>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateModeComparison {
    candidate_mode: &'static str,
    baseline_mode: &'static str,
    tests: Vec<PreparedUpdateTestComparison>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateTestComparison {
    id: &'static str,
    label: &'static str,
    candidate_elapsed_micros: u128,
    baseline_elapsed_micros: u128,
    elapsed_ratio: f64,
    elapsed_delta_micros: i128,
    candidate_average_micros: f64,
    baseline_average_micros: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateProfileAnalysis {
    #[serde(skip_serializing_if = "Option::is_none")]
    symbolization: Option<ProfileSymbolizationReport>,
    top_symbols: Vec<CpuProfileTopStackEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    callsite_hotspots: Vec<ProfileCallsiteHotspot>,
}

#[derive(Debug, Clone)]
struct PreparedUpdateProfileOptions {
    output_dir: PathBuf,
    seconds: u64,
    delay: Duration,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampledReport {
    source_model: &'static str,
    measurement_model: &'static str,
    completed: bool,
    sample_count: usize,
    accepted_sample_count: usize,
    attempt_count: usize,
    discarded_sample_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load_gate: Option<SampledHostLoadGateReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    passes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_variant: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlx_native_summary: Option<PreparedUpdateSampledComparisonSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prepared_read_roundtrip_decomposition: Option<PreparedReadRoundtripDecomposition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_stability: Option<PreparedSampleStabilityReport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    run_summaries: Vec<PreparedUpdateSampledRunSummary>,
    samples: Vec<PreparedUpdateSampleSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    discarded_samples: Vec<PreparedUpdateDiscardedSampleSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampleSummary {
    sample_index: usize,
    attempt_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_wait: Option<SampledHostLoadWaitReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlx_native_comparison: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateDiscardedSampleSummary {
    attempt_index: usize,
    reject_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_wait: Option<SampledHostLoadWaitReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampledHostLoadGateReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_load_per_logical_cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_top_cpu_percent: Option<f64>,
    max_sample_attempts: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_wait_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_poll_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampledHostLoadWaitReport {
    waited_ms: u128,
    checks: usize,
    satisfied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampledComparisonSummary {
    candidate_mode: String,
    baseline_mode: String,
    tests: Vec<PreparedUpdateSampledTestSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampledTestSummary {
    id: String,
    label: String,
    sample_count: usize,
    candidate_elapsed_micros_samples: Vec<u128>,
    baseline_elapsed_micros_samples: Vec<u128>,
    elapsed_ratio_samples: Vec<f64>,
    candidate_p50_micros: Option<u128>,
    candidate_p90_micros: Option<u128>,
    baseline_p50_micros: Option<u128>,
    baseline_p90_micros: Option<u128>,
    p50_ratio: Option<f64>,
    p90_ratio: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampledRunSummary {
    mode: String,
    tests: Vec<PreparedUpdateSampledRunTestSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateSampledRunTestSummary {
    id: String,
    label: String,
    sample_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_count: Option<u64>,
    elapsed_micros_samples: Vec<u128>,
    p50_micros: Option<u128>,
    p90_micros: Option<u128>,
    min_micros: Option<u128>,
    max_micros: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_to_min_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p90_to_p50_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p50_average_micros: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p90_average_micros: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedSampleStabilityReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_elapsed_spread_ratio_gate: Option<f64>,
    stable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    worst_elapsed_spread_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    violations: Vec<PreparedSampleStabilityViolation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedSampleStabilityViolation {
    mode: String,
    id: String,
    label: String,
    sample_count: usize,
    elapsed_micros_samples: Vec<u128>,
    elapsed_spread_ratio: f64,
    max_elapsed_spread_ratio: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedReadRoundtripDecomposition {
    source_model: &'static str,
    measurement_model: &'static str,
    tests: Vec<PreparedReadRoundtripDecompositionTest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedReadRoundtripDecompositionTest {
    id: String,
    label: String,
    operation_count: u64,
    sqlx_server_p50_micros_per_op: f64,
    sqlx_native_p50_micros_per_op: f64,
    pipelined_server_p50_micros_per_op: f64,
    pipelined_native_p50_micros_per_op: f64,
    sqlx_gap_p50_micros_per_op: f64,
    pipelined_gap_p50_micros_per_op: f64,
    inferred_roundtrip_gap_p50_micros_per_op: f64,
    server_sqlx_over_pipelined_p50_micros_per_op: f64,
    native_sqlx_over_pipelined_p50_micros_per_op: f64,
    sqlx_server_p90_micros_per_op: f64,
    sqlx_native_p90_micros_per_op: f64,
    pipelined_server_p90_micros_per_op: f64,
    pipelined_native_p90_micros_per_op: f64,
    sqlx_gap_p90_micros_per_op: f64,
    pipelined_gap_p90_micros_per_op: f64,
    inferred_roundtrip_gap_p90_micros_per_op: f64,
    server_sqlx_over_pipelined_p90_micros_per_op: f64,
    native_sqlx_over_pipelined_p90_micros_per_op: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedUpdateDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    cases: Vec<IndexedUpdateDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedUpdateDiagnosticCase {
    name: &'static str,
    description: &'static str,
    setup_micros: u128,
    elapsed_micros: u128,
    operation_count: usize,
    stats_before: serde_json::Value,
    stats_after: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedHotspotDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load_gate: Option<SampledHostLoadGateReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_variant: Option<DiagnosticSetupVariantReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<BenchmarkRuntimeReport>,
    cases: Vec<SpeedHotspotDiagnosticCase>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<DiagnosticRunError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedHotspotDiagnosticCase {
    engine: &'static str,
    id: String,
    label: String,
    sample_count: usize,
    target_repeat_count: usize,
    target_repeat_mode: &'static str,
    open_micros: Option<u128>,
    connect_micros: Option<u128>,
    setup_micros: u128,
    elapsed_micros: u128,
    operation_count: usize,
    average_micros: Option<f64>,
    min_micros: Option<u128>,
    p50_micros: Option<u128>,
    p90_micros: Option<u128>,
    p95_micros: Option<u128>,
    observed_server_peak_rss_bytes: Option<u64>,
    settings: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_wait: Option<SampledHostLoadWaitReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_repeat_elapsed_micros: Option<Vec<u128>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_profile: Option<SpeedHotspotCpuProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    samples: Option<Vec<SpeedHotspotDiagnosticSample>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedHotspotDiagnosticSample {
    sample_index: usize,
    target_repeat_count: usize,
    target_repeat_mode: &'static str,
    open_micros: Option<u128>,
    connect_micros: Option<u128>,
    setup_micros: u128,
    elapsed_micros: u128,
    observed_server_peak_rss_bytes: Option<u64>,
    settings: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pre_sample_wait: Option<SampledHostLoadWaitReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_repeat_elapsed_micros: Option<Vec<u128>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_profile: Option<SpeedHotspotCpuProfile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedHotspotCpuProfile {
    tool: &'static str,
    requested_pid: u32,
    pid: u32,
    pid_selection: &'static str,
    seconds: u64,
    delay_millis: u64,
    output_path: String,
    command: Vec<String>,
    status: Option<String>,
    success: Option<bool>,
    output_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    perf_map_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    perf_map_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_stack: Option<Vec<CpuProfileTopStackEntry>>,
    stderr_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuProfileTopStackEntry {
    samples: u64,
    frame: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRunError {
    context: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedProfileCompareReport {
    source_model: &'static str,
    measurement_model: &'static str,
    output_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_variant: Option<DiagnosticSetupVariantReport>,
    runtime: BenchmarkRuntimeReport,
    cases: Vec<SpeedProfileCompareCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedProfileCompareCase {
    id: String,
    label: String,
    operation_count: usize,
    target_repeat_count: usize,
    target_repeat_mode: &'static str,
    elapsed_ratio: Option<f64>,
    elapsed_delta_micros: i128,
    server: SpeedHotspotDiagnosticCase,
    native: SpeedHotspotDiagnosticCase,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_symbolization: Option<ProfileSymbolizationReport>,
    server_top_symbols: Vec<CpuProfileTopStackEntry>,
    native_top_symbols: Vec<CpuProfileTopStackEntry>,
    common_hotspots: Vec<ProfileHotspotCompareEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    server_offset_hotspots: Vec<ProfileOffsetHotspot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    server_callsite_hotspots: Vec<ProfileCallsiteHotspot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSymbolizationReport {
    perf_map_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_map_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotated_perf_map_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbolized_sample_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_tsv_path: Option<String>,
    top_stack: Vec<CpuProfileTopStackEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileHotspotCompareEntry {
    symbol: String,
    server_samples: u64,
    native_samples: u64,
    server_share: f64,
    native_share: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileOffsetHotspot {
    symbol: String,
    samples: u64,
    profile_share: f64,
    offsets: Vec<ProfileOffsetHotspotEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileOffsetHotspotEntry {
    offset: u64,
    offset_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_size_hex: Option<String>,
    samples: u64,
    symbol_share: f64,
    profile_share: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCallsiteHotspot {
    symbol: String,
    samples: u64,
    profile_share: f64,
    callers: Vec<ProfileCallsiteHotspotEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCallsiteHotspotEntry {
    caller_symbol: String,
    caller_frame: String,
    samples: u64,
    symbol_share: f64,
    profile_share: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedParityDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load_gate: Option<SampledHostLoadGateReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_load: Option<HostLoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_variant: Option<DiagnosticSetupVariantReport>,
    runtime: BenchmarkRuntimeReport,
    config_sets: Vec<SpeedParityConfigSet>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<DiagnosticRunError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticSetupVariantReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    btree_deduplicate_items: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    t2_index_shape: Option<&'static str>,
    description: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedParityConfigSet {
    name: String,
    runtime_set: WasmerRuntimeConfigSetReport,
    runtime: BenchmarkRuntimeReport,
    postgres_configs: Vec<PostgresConfigOverride>,
    server_postgres_configs: Vec<PostgresConfigOverride>,
    native_postgres_configs: Vec<PostgresConfigOverride>,
    cases: Vec<SpeedParityCase>,
    worst_p90_ratio: Option<f64>,
    worst_p90_delta_micros: Option<i128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedParityCase {
    id: String,
    label: String,
    operation_count: usize,
    sample_count: usize,
    target_repeat_count: usize,
    target_repeat_mode: &'static str,
    p50_ratio: Option<f64>,
    p90_ratio: Option<f64>,
    p95_ratio: Option<f64>,
    p90_delta_micros: Option<i128>,
    p90_delta_per_operation_nanos: Option<f64>,
    server: SpeedHotspotDiagnosticCase,
    native: SpeedHotspotDiagnosticCase,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostgresConfigOverride {
    name: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticReport {
    source_model: &'static str,
    measurement_model: &'static str,
    cases: Vec<BufferCacheDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticCase {
    id: String,
    label: String,
    setup_micros: u128,
    settings: serde_json::Value,
    relation_sizes: serde_json::Value,
    statements: Vec<BufferCacheDiagnosticStatement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferCacheDiagnosticStatement {
    sql: String,
    elapsed_micros: u128,
    explain_rows: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColdPerfExperiment {
    name: &'static str,
    status: &'static str,
    implementation_risk: &'static str,
    artifact_size_impact: &'static str,
    notes: &'static str,
}

fn perf_cold(args: &[String]) -> Result<()> {
    let reset_cache = args.iter().any(|arg| arg == "--reset-cache");
    for arg in args {
        if arg != "--reset-cache" {
            bail!("unknown perf cold flag: {arg}");
        }
    }

    let cache_dir = pglite_oxide_cache_dir()?;
    let cache_state_at_start = if reset_cache {
        if cache_dir.exists() {
            fs::remove_dir_all(&cache_dir)
                .with_context(|| format!("reset pglite-oxide cache {}", cache_dir.display()))?;
        }
        "cold_absent_after_reset"
    } else if cache_dir.exists() {
        "existing"
    } else {
        "cold_absent"
    };

    let mut operations = Vec::new();

    operations.push(capture_operation(
        "process_cold_runtime_preload",
        "First explicit runtime preload in this xtask process. With --reset-cache, this includes first-install cache bootstrap.",
        cache_state_at_start,
        "cold",
        "internal_preload_temp_root",
        "not_a_query",
        "runtime_preload",
        "operation.total",
        Pglite::preload,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_direct_first_query",
        "First direct query for a newly opened temporary database after runtime preload in the same process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_root",
        "first_query_after_open",
        "direct_select_with_bind",
        "visible.direct_open_to_first_query",
        run_direct_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_second_new_temp_direct_first_query",
        "Repeat first direct query for a second newly opened temporary database in the same warm process.",
        "warm_after_runtime_preload",
        "warm",
        "second_new_temporary_root",
        "first_query_after_open",
        "direct_select_with_bind",
        "visible.direct_open_to_first_query",
        run_direct_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_vector_preload",
        "Explicit preload of the representative extension artifact after runtime preload.",
        "warm_after_runtime_preload",
        "warm",
        "internal_preload_temp_root",
        "not_a_query",
        "vector_extension_preload",
        "operation.total",
        || Pglite::preload_extensions([extensions::VECTOR]),
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_direct_vector_first_query",
        "First vector-backed direct query for a newly opened temporary database after vector preload.",
        "warm_after_vector_preload",
        "warm",
        "new_temporary_root_with_requested_vector",
        "first_extension_backed_query_after_open",
        "direct_vector_distance",
        "visible.direct_open_to_first_query",
        run_direct_vector_query,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_tokio_postgres_first_query",
        "First tokio-postgres query against a new temporary PgliteServer in the warm process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_server_root",
        "first_client_query_after_server_start",
        "tokio_postgres_select_with_bind",
        "visible.server_start_to_first_tokio_postgres_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
                    .await
                    .context("connect tokio-postgres to PGliteServer")?;
                record_phase_timing("client.tokio_postgres_connect", started.elapsed());
                let connection_handle = tokio::spawn(connection);
                let started = Instant::now();
                let row = client
                    .query_one("SELECT $1::int4 + 1 AS answer", &[&41_i32])
                    .await
                    .context("run first tokio-postgres query")?;
                record_phase_timing("client.tokio_postgres_first_query", started.elapsed());
                let answer: i32 = row.get("answer");
                if answer != 42 {
                    bail!("server query returned {answer}, expected 42");
                }
                drop(client);
                connection_handle
                    .await
                    .context("join tokio-postgres connection task")?
                    .context("tokio-postgres connection task")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_tokio_postgres_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_sqlx_first_query",
        "First SQLx query against a new temporary PgliteServer in the warm process.",
        "warm_after_runtime_preload",
        "warm",
        "new_temporary_server_root",
        "first_client_query_after_server_start",
        "sqlx_select_with_bind",
        "visible.server_start_to_first_sqlx_query",
        run_server_sqlx_select_one,
    )?);
    operations.push(capture_operation(
        "process_warm_new_temp_server_sqlx_vector_first_query",
        "First vector-backed SQLx query against a new extension-enabled temporary PgliteServer.",
        "warm_after_vector_preload",
        "warm",
        "new_temporary_server_root_with_requested_vector",
        "first_extension_backed_client_query_after_server_start",
        "sqlx_vector_distance",
        "visible.server_start_to_first_sqlx_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", || {
                PgliteServer::builder()
                    .temporary()
                    .extension(extensions::VECTOR)
                    .start()
            })?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let mut conn = sqlx::PgConnection::connect(&uri)
                    .await
                    .context("connect SQLx to extension-enabled PGliteServer")?;
                record_phase_timing("client.sqlx_extension_connect", started.elapsed());
                let started = Instant::now();
                let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
                    .fetch_one(&mut conn)
                    .await
                    .context("run first SQLx extension-backed query")?;
                record_phase_timing("client.sqlx_extension_first_query", started.elapsed());
                let distance: f64 = row.try_get("distance").context("read vector distance")?;
                if distance != 1.0 {
                    bail!("SQLx vector query returned {distance}, expected 1.0");
                }
                conn.close().await.context("close SQLx connection")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_sqlx_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    let preinstalled_extension_root = unique_perf_root("server-sqlx-preinstalled-extension")?;
    {
        let mut db = Pglite::builder()
            .path(&preinstalled_extension_root)
            .extension(extensions::VECTOR)
            .open()
            .context("prepare preinstalled extension perf root")?;
        db.close()
            .context("close preinstalled extension perf root")?;
    }
    operations.push(capture_operation(
        "process_warm_existing_persistent_server_sqlx_vector_first_query",
        "Diagnostic first vector-backed SQLx query against an existing persistent root where vector was already installed.",
        "warm_after_vector_preload",
        "warm",
        "existing_persistent_root_with_preinstalled_vector",
        "first_client_query_after_server_start",
        "sqlx_vector_distance",
        "visible.server_start_to_first_sqlx_query",
        || {
            let visible_started = Instant::now();
            let server = measure_phase("server.start", || {
                PgliteServer::builder()
                    .path(&preinstalled_extension_root)
                    .extension(extensions::VECTOR)
                    .start()
            })?;
            let uri = server.database_url();
            let runtime = measure_phase("client.tokio_runtime_create", || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("create perf tokio runtime")
            })?;
            runtime.block_on(async move {
                let started = Instant::now();
                let mut conn = sqlx::PgConnection::connect(&uri)
                    .await
                    .context("connect SQLx to preinstalled-extension PGliteServer")?;
                record_phase_timing("client.sqlx_extension_connect", started.elapsed());
                let started = Instant::now();
                let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
                    .fetch_one(&mut conn)
                    .await
                    .context("run first SQLx preinstalled-extension query")?;
                record_phase_timing("client.sqlx_extension_first_query", started.elapsed());
                let distance: f64 = row.try_get("distance").context("read vector distance")?;
                if distance != 1.0 {
                    bail!("SQLx vector query returned {distance}, expected 1.0");
                }
                conn.close().await.context("close SQLx connection")?;
                Ok::<_, anyhow::Error>(())
            })?;
            record_phase_timing(
                "visible.server_start_to_first_sqlx_query",
                visible_started.elapsed(),
            );
            measure_phase("operation.shutdown", || server.shutdown())
        },
    )?);
    let _ = fs::remove_dir_all(&preinstalled_extension_root);

    let report = ColdPerfReport {
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
        cache_reset_requested: reset_cache,
        cache_dir: cache_dir.display().to_string(),
        cache_state_at_start,
        measurement_model: "Operations run sequentially in one xtask process. 'Warm' means process/runtime/module caches have been warmed by earlier operations; 'first query' means first query after opening that operation's new database root or server.",
        operations,
        experiments: vec![
            ColdPerfExperiment {
                name: "wasmer_webassembly_exceptions",
                status: "production_invariant",
                implementation_risk: "medium",
                artifact_size_impact: "required",
                notes: "the runtime and WASIX build require WebAssembly exception handling; no non-EH fallback or opt-out is supported",
            },
            ColdPerfExperiment {
                name: "wasix_dynamic_linking_flags",
                status: "production_invariant",
                implementation_risk: "medium",
                artifact_size_impact: "required",
                notes: "main modules use dynamic-main flags and extension/tool side modules use PIC shared-module flags from the same configured tree",
            },
            ColdPerfExperiment {
                name: "process_wide_headless_engine_and_module_cache",
                status: "implemented",
                implementation_risk: "low",
                artifact_size_impact: "none",
                notes: "main and side modules are cached by artifact hash inside the process",
            },
            ColdPerfExperiment {
                name: "persistent_raw_aot_cache",
                status: "implemented",
                implementation_risk: "low",
                artifact_size_impact: "none",
                notes: "compressed AOT artifacts expand once to a manifest raw-SHA-keyed cache path; subsequent processes use fast receipt verification before mmap/native deserialization; full content hashing is only enabled with PGLITE_OXIDE_AOT_VERIFY=full",
            },
            ColdPerfExperiment {
                name: "mmap_native_deserialization",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "runtime uses Wasmer native mmapped deserialization as the only production AOT loading path",
            },
            ColdPerfExperiment {
                name: "shared_wasix_runtime_and_module_cache",
                status: "implemented",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "runtime infrastructure is shared while Store, Instance, WASI env, mounts, and protocol state remain per database",
            },
            ColdPerfExperiment {
                name: "template_clone_hardlink_reflink_copy",
                status: "implemented",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "immutable runtime files hardlink first; mutable PGDATA uses archive install by default, with per-file reflink available through PGLITE_OXIDE_TEMPLATE_REFLINK",
            },
            ColdPerfExperiment {
                name: "eager_pgdata_template_overlay",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "mounts the cached initialized PGDATA template as lower /base and copies individual files into the per-instance upper only before mutating opens",
            },
            ColdPerfExperiment {
                name: "mountfs_overlay_runtime_root",
                status: "mainline_measured_in_this_run",
                implementation_risk: "medium",
                artifact_size_impact: "none",
                notes: "serves immutable runtime files from the shared cached lower root and keeps only mutable state plus requested extension assets in the per-root upper root",
            },
            ColdPerfExperiment {
                name: "snapshot_journaling",
                status: "scouted_not_promoted",
                implementation_risk: "high",
                artifact_size_impact: "unknown",
                notes: "Wasmer 7.2 exposes WASIX journal and process snapshot APIs, while StoreSnapshot captures store globals only; promotion requires an isolated restore correctness suite for direct protocol, server mode, extensions, PGDATA, fd state, and mount state",
            },
            ColdPerfExperiment {
                name: "asyncify",
                status: "production_excluded",
                implementation_risk: "high",
                artifact_size_impact: "unknown",
                notes: "not used in production artifacts; only an isolated snapshot/journaling experiment may enable it if Wasm EH plus WASIX journaling cannot support the required control-flow restore path",
            },
        ],
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_warm(args: &[String]) -> Result<()> {
    let mut query_iterations = 100usize;
    let mut connection_iterations = 20usize;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                query_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--connections" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--connections requires a value"))?;
                connection_iterations = value
                    .parse()
                    .with_context(|| format!("parse --connections value {value:?}"))?;
            }
            other => bail!("unknown perf warm flag: {other}"),
        }
        cursor += 1;
    }
    if query_iterations == 0 {
        bail!("--iterations must be greater than zero");
    }
    if connection_iterations == 0 {
        bail!("--connections must be greater than zero");
    }

    let mut operations = Vec::new();
    operations.push(capture_operation(
        "warm_process_preload",
        "Warm runtime and representative extension artifacts before steady-state workloads.",
        "existing",
        "warm",
        "process_cache",
        "not_a_query",
        "runtime_and_extension_preload",
        "operation.total",
        || {
            Pglite::preload()?;
            Pglite::preload_extensions([extensions::VECTOR])
        },
    )?);
    operations.push(capture_operation(
        "warm_direct_repeated_scalar_queries",
        "Repeated direct API scalar extended-protocol queries on one already-open temporary database.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_direct_root",
        "steady_state_queries",
        "direct_select_with_bind",
        "warm.direct_repeated_scalar_queries.total",
        || run_direct_repeated_selects(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_direct_transaction_batch",
        "Repeated direct API scalar queries inside one transaction on an already-open temporary database.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_direct_root",
        "steady_state_transaction_batch",
        "direct_transaction_select_with_bind",
        "warm.direct_transaction_batch.total",
        || run_direct_transaction_batch(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_direct_repeated_vector_queries",
        "Repeated direct API extension-backed queries on one already-open extension-enabled temporary database.",
        "warm_after_vector_preload",
        "warm",
        "long_lived_temporary_direct_root_with_vector",
        "steady_state_extension_queries",
        "direct_vector_distance",
        "warm.direct_repeated_vector_queries.total",
        || run_direct_repeated_vector_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_single_connection_repeated_queries",
        "Repeated SQLx queries over one connection to one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_single_connection_queries",
        "sqlx_select_with_bind",
        "warm.server_sqlx_single_connection_repeated_queries.total",
        || run_server_sqlx_single_connection_repeated_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_repeated_connections",
        "Repeated SQLx connect-query-close cycles against one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_repeated_connections",
        "sqlx_connect_query_close",
        "warm.server_sqlx_repeated_connections.total",
        || run_server_sqlx_repeated_connections(connection_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_sqlx_vector_single_connection_repeated_queries",
        "Repeated SQLx extension-backed queries over one connection to one long-lived extension-enabled temporary server.",
        "warm_after_vector_preload",
        "warm",
        "long_lived_temporary_server_root_with_vector",
        "steady_state_extension_queries",
        "sqlx_vector_distance",
        "warm.server_sqlx_vector_single_connection_repeated_queries.total",
        || run_server_sqlx_vector_single_connection_repeated_queries(query_iterations),
    )?);
    operations.push(capture_operation(
        "warm_server_tokio_postgres_single_connection_repeated_queries",
        "Repeated tokio-postgres queries over one connection to one long-lived temporary server.",
        "warm_after_preload",
        "warm",
        "long_lived_temporary_server_root",
        "steady_state_single_connection_queries",
        "tokio_postgres_select_with_bind",
        "warm.server_tokio_postgres_single_connection_repeated_queries.total",
        || run_server_tokio_postgres_single_connection_repeated_queries(query_iterations),
    )?);

    let report = WarmPerfReport {
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
        query_iterations,
        connection_iterations,
        measurement_model: "Operations run after explicit process preload. Each workload opens one database/server, performs one warmup query where relevant, then records only the repeated steady-state section as the primary latency phase. Open and shutdown phases remain in the phase list for context.",
        operations,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkSuiteFilter {
    All,
    Rtt,
    Speed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkModeFilter {
    All,
    Direct,
    ServerSqlx,
    ServerTokioPostgresSimple,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativePostgresClientMode {
    TokioPostgresSimple,
    Sqlx,
}

impl BenchmarkSuiteFilter {
    fn includes(self, suite: &'static str) -> bool {
        matches!(
            (self, suite),
            (Self::All, _) | (Self::Rtt, "rtt") | (Self::Speed, "speed")
        )
    }
}

impl BenchmarkModeFilter {
    fn includes(self, mode: &'static str) -> bool {
        matches!(
            (self, mode),
            (Self::All, _)
                | (Self::Direct, "direct")
                | (Self::ServerSqlx, "server_sqlx")
                | (
                    Self::ServerTokioPostgresSimple,
                    "server_tokio_postgres_simple"
                )
        )
    }
}

fn perf_bench(args: &[String]) -> Result<()> {
    let mut suite = BenchmarkSuiteFilter::All;
    let mut mode = BenchmarkModeFilter::All;
    let mut rtt_iterations = 100usize;
    let mut speed_scale = 1.0f64;
    let mut speed_sql_source = SpeedSqlSource::Generated;
    let mut postgres_configs = Vec::new();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "all" => BenchmarkSuiteFilter::All,
                    "rtt" | "roundtrip" | "round-trip" => BenchmarkSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    other => bail!("unknown --suite value {other:?}; use all, rtt, or speed"),
                };
            }
            "--mode" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--mode requires a value"))?;
                mode = match value.as_str() {
                    "all" => BenchmarkModeFilter::All,
                    "direct" => BenchmarkModeFilter::Direct,
                    "server-sqlx" | "server_sqlx" | "sqlx" | "server" => {
                        BenchmarkModeFilter::ServerSqlx
                    }
                    "server-tokio-postgres-simple"
                    | "server_tokio_postgres_simple"
                    | "tokio-postgres-simple"
                    | "tokio_postgres_simple"
                    | "tokio-postgres"
                    | "tokio_postgres" => BenchmarkModeFilter::ServerTokioPostgresSimple,
                    other => {
                        bail!(
                            "unknown --mode value {other:?}; use all, direct, server-sqlx, or server-tokio-postgres-simple"
                        )
                    }
                };
            }
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                rtt_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--scale" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--scale requires a value"))?;
                speed_scale = value
                    .parse()
                    .with_context(|| format!("parse --scale value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = SpeedSqlSource::parse(value)?;
            }
            "--postgres-config" => {
                cursor += 1;
                let raw_config = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-config requires name=value"))?;
                postgres_configs.push(parse_postgres_config_arg(raw_config)?);
            }
            other => bail!("unknown perf bench flag: {other}"),
        }
        cursor += 1;
    }
    if rtt_iterations == 0 {
        bail!("--iterations must be greater than zero");
    }
    if !speed_scale.is_finite() || speed_scale <= 0.0 {
        bail!("--scale must be a finite positive number");
    }
    if speed_sql_source == SpeedSqlSource::PgliteVendored
        && (speed_scale - 1.0).abs() > f64::EPSILON
    {
        bail!("--speed-source pglite uses fixed upstream SQL files and requires --scale 1");
    }

    let using_server_core_assets = using_wasix_postgres_server_core_assets()?;
    if using_server_core_assets && mode == BenchmarkModeFilter::Direct {
        bail!(
            "direct benchmark mode is not available for PostgreSQL 18 WASIX server-core assets; use --mode server-sqlx or --mode server-tokio-postgres-simple"
        );
    }
    let run_direct = mode.includes("direct") && !using_server_core_assets;

    let preload_micros = if run_direct {
        let preload_started = Instant::now();
        Pglite::preload()?;
        preload_started.elapsed().as_micros()
    } else {
        0
    };

    let mut runs = Vec::new();
    if suite.includes("rtt") && run_direct {
        runs.push(run_rtt_direct_benchmark(rtt_iterations, &postgres_configs)?);
    }
    if suite.includes("rtt") && mode.includes("server_sqlx") {
        runs.push(run_rtt_server_sqlx_benchmark(
            rtt_iterations,
            &postgres_configs,
        )?);
    }
    if suite.includes("rtt") && mode.includes("server_tokio_postgres_simple") {
        runs.push(run_rtt_server_tokio_postgres_simple_benchmark(
            rtt_iterations,
            &postgres_configs,
        )?);
    }
    if suite.includes("speed") && run_direct {
        runs.push(run_speed_direct_benchmark(
            speed_scale,
            speed_sql_source,
            &postgres_configs,
        )?);
    }
    if suite.includes("speed") && mode.includes("server_sqlx") {
        runs.push(run_speed_server_sqlx_benchmark(
            speed_scale,
            speed_sql_source,
            &postgres_configs,
        )?);
    }
    if suite.includes("speed") && mode.includes("server_tokio_postgres_simple") {
        runs.push(run_speed_server_tokio_postgres_simple_benchmark(
            speed_scale,
            speed_sql_source,
            &postgres_configs,
        )?);
    }
    ensure!(
        !runs.is_empty(),
        "selected benchmark filter produced no runs"
    );

    let report = BenchmarkReport {
        wasmer_version: "7.2.0-alpha.2",
        wasmer_wasix_version: "0.702.0-alpha.2",
        source_model: speed_sql_source.source_model(),
        measurement_model: "Database/server open and setup are measured separately. Test timings start immediately before each SQL execution call and end after that execution completes. RTT tests sort samples, discard the lowest and highest 10% when possible, and report trimmed averages in microseconds.",
        runtime: Some(benchmark_runtime_report()?),
        rtt_iterations,
        speed_scale,
        preload_micros,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn benchmark_runtime_report() -> Result<BenchmarkRuntimeReport> {
    let runtime_kind = packaged_runtime_kind()?.map(|kind| kind.to_string());
    let server_core = runtime_kind.as_deref() == Some(RUNTIME_KIND_WASIX_POSTGRES_SERVER);
    let (wasmer_bin, wasmer_bin_sha256) = if server_core {
        resolved_external_wasmer_report()
    } else {
        (None, None)
    };
    let runtime_archive_override = runtime_archive_override_path();
    let runtime_archive_override_sha256 = runtime_archive_override
        .as_deref()
        .map(sha256_file)
        .transpose()?;
    Ok(BenchmarkRuntimeReport {
        packaged_runtime_kind: runtime_kind,
        runtime_archive_override: runtime_archive_override
            .as_deref()
            .map(|path| path.display().to_string()),
        runtime_archive_override_sha256,
        wasmer_bin,
        wasmer_bin_sha256,
        wasmer_compiler: server_core.then(|| {
            env_first([
                "PGLITE_OXIDE_WASMER_COMPILER",
                "WASMER_COMPILER",
                "WASMER_BACKEND",
            ])
            .unwrap_or_else(|| "llvm".to_owned())
        }),
        wasmer_llvm_opt_level: server_core.then(|| {
            env_first([
                "PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL",
                "WASMER_LLVM_OPT_LEVEL",
            ])
            .unwrap_or_else(|| "aggressive".to_owned())
        }),
        wasmer_llvm_native_cpu: server_core.then(|| {
            bool_env_report_with_default(
                [
                    "PGLITE_OXIDE_WASMER_LLVM_NATIVE_CPU",
                    "WASMER_LLVM_NATIVE_CPU",
                ],
                true,
            )
        }),
        wasmer_llvm_full_o3_pipeline: server_core.then(|| {
            bool_env_report([
                "PGLITE_OXIDE_WASMER_LLVM_FULL_O3_PIPELINE",
                "WASMER_LLVM_FULL_O3_PIPELINE",
            ])
        }),
        wasmer_llvm_indirect_call_cache: server_core.then(|| {
            bool_env_report_with_default(
                [
                    "PGLITE_OXIDE_WASMER_LLVM_INDIRECT_CALL_CACHE",
                    "WASMER_LLVM_INDIRECT_CALL_CACHE",
                ],
                true,
            )
        }),
        wasmer_profiler: server_core.then(|| {
            env_first(["PGLITE_OXIDE_WASMER_PROFILER", "WASMER_PROFILER"])
                .unwrap_or_else(|| "none".to_owned())
        }),
        wasmer_compiler_threads: server_core.then(|| {
            env_first([
                "PGLITE_OXIDE_WASMER_COMPILER_THREADS",
                "WASMER_COMPILER_THREADS",
            ])
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(4)
                    .to_string()
            })
        }),
        wasmer_enable_async_threads: server_core
            .then(|| {
                env_bool_value([
                    "PGLITE_OXIDE_WASMER_ENABLE_ASYNC_THREADS",
                    "WASMER_ENABLE_ASYNC_THREADS",
                ])
                .map(|value| value.to_string())
            })
            .flatten(),
        wasmer_no_tty: server_core
            .then(|| {
                env_bool_value(["PGLITE_OXIDE_WASMER_NO_TTY", "WASMER_NO_TTY"])
                    .map(|value| value.to_string())
            })
            .flatten(),
        wasix_btree_bottomup_delete: server_core.then(|| {
            env_first(["PGLITE_OXIDE_WASIX_BTREE_BOTTOMUP_DELETE"])
                .unwrap_or_else(|| WasixBtreeBottomupDeleteMode::Off.as_str().to_owned())
        }),
    })
}

fn runtime_archive_override_path() -> Option<PathBuf> {
    for name in ["PGLITE_OXIDE_RUNTIME_ARCHIVE", "PGLITE_OXIDE_RUNTIME_TAR"] {
        let Ok(path) = env::var(name) else {
            continue;
        };
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn benchmark_runtime_report_for_runtime_set(
    runtime_set: Option<&WasmerRuntimeConfigSetInput>,
) -> Result<BenchmarkRuntimeReport> {
    let mut report = benchmark_runtime_report()?;
    if let Some(runtime_set) = runtime_set {
        if let Some(compiler) = runtime_set.compiler {
            report.wasmer_compiler = Some(compiler.to_string());
        }
        if let Some(level) = &runtime_set.llvm_opt_level {
            report.wasmer_llvm_opt_level = Some(level.clone());
        }
        if let Some(enabled) = runtime_set.llvm_native_cpu {
            report.wasmer_llvm_native_cpu = Some(enabled.to_string());
        }
        if let Some(enabled) = runtime_set.llvm_full_o3_pipeline {
            report.wasmer_llvm_full_o3_pipeline = Some(enabled.to_string());
        }
        if let Some(enabled) = runtime_set.llvm_indirect_call_cache {
            report.wasmer_llvm_indirect_call_cache = Some(enabled.to_string());
        }
        if let Some(profiler) = &runtime_set.wasmer_profiler {
            report.wasmer_profiler = Some(profiler.clone());
        }
        if let Some(threads) = runtime_set.compiler_threads {
            report.wasmer_compiler_threads = Some(threads.to_string());
        }
        if let Some(enabled) = runtime_set.enable_async_threads {
            report.wasmer_enable_async_threads = Some(enabled.to_string());
        }
        if let Some(enabled) = runtime_set.no_tty {
            report.wasmer_no_tty = Some(enabled.to_string());
        }
    }
    Ok(report)
}

fn capture_host_load_report() -> Option<HostLoadReport> {
    let captured_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis());
    let logical_cpu_count = command_stdout("sysctl", &["-n", "hw.logicalcpu"])
        .and_then(|text| text.trim().parse::<u64>().ok());
    let (load_average_1m, load_average_5m, load_average_15m) = capture_load_averages()
        .map(|(one, five, fifteen)| (Some(one), Some(five), Some(fifteen)))
        .unwrap_or((None, None, None));
    let load_per_logical_cpu_1m = match (load_average_1m, logical_cpu_count) {
        (Some(load), Some(cpus)) if cpus > 0 => Some(load / cpus as f64),
        _ => None,
    };
    let likely_noisy = load_per_logical_cpu_1m.map(|load| load >= 0.75);
    let top_cpu_processes = capture_top_cpu_processes(8);

    if captured_at_unix_ms.is_none()
        && logical_cpu_count.is_none()
        && load_average_1m.is_none()
        && top_cpu_processes.is_empty()
    {
        return None;
    }

    Some(HostLoadReport {
        captured_at_unix_ms,
        logical_cpu_count,
        load_average_1m,
        load_average_5m,
        load_average_15m,
        load_per_logical_cpu_1m,
        likely_noisy,
        top_cpu_processes,
    })
}

fn capture_load_averages() -> Option<(f64, f64, f64)> {
    command_stdout("sysctl", &["-n", "vm.loadavg"])
        .and_then(|text| parse_load_averages(&text))
        .or_else(|| {
            fs::read_to_string("/proc/loadavg")
                .ok()
                .and_then(|text| parse_load_averages(&text))
        })
        .or_else(|| command_stdout("uptime", &[]).and_then(|text| parse_load_averages(&text)))
}

fn parse_load_averages(text: &str) -> Option<(f64, f64, f64)> {
    let text = text
        .split_once("load averages:")
        .or_else(|| text.split_once("load average:"))
        .map(|(_, rest)| rest)
        .unwrap_or(text);
    let values = text
        .split(|ch: char| ch.is_whitespace() || ch == ',' || ch == '{' || ch == '}')
        .filter_map(|token| token.parse::<f64>().ok())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [one, five, fifteen, ..] => Some((*one, *five, *fifteen)),
        _ => None,
    }
}

fn capture_top_cpu_processes(limit: usize) -> Vec<HostCpuProcessReport> {
    let Some(output) = command_stdout("ps", &["-axo", "pid=,pcpu=,pmem=,comm="]) else {
        return Vec::new();
    };
    let mut processes = output
        .lines()
        .filter_map(parse_host_cpu_process_line)
        .collect::<Vec<_>>();
    processes.sort_by(|left, right| {
        right
            .cpu_percent
            .partial_cmp(&left.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    processes.truncate(limit);
    processes
}

fn parse_host_cpu_process_line(line: &str) -> Option<HostCpuProcessReport> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let cpu_percent = parts.next()?.parse::<f64>().ok()?;
    let mem_percent = parts.next().and_then(|value| value.parse::<f64>().ok());
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(HostCpuProcessReport {
        pid,
        cpu_percent,
        mem_percent,
        command,
    })
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn bool_env_report(names: [&'static str; 2]) -> String {
    bool_env_report_with_default(names, false)
}

fn bool_env_report_with_default(names: [&'static str; 2], default: bool) -> String {
    env_bool_value(names).unwrap_or(default).to_string()
}

fn env_bool_value(names: [&'static str; 2]) -> Option<bool> {
    names.into_iter().find_map(|name| {
        env::var(name).ok().map(|value| {
            let value = value.trim();
            !value.is_empty()
                && !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
        })
    })
}

fn resolved_external_wasmer_report() -> (Option<String>, Option<String>) {
    match locate_external_wasmer_bin() {
        Ok(path) => {
            let sha256 = sha256_file(&path).ok();
            (Some(path.display().to_string()), sha256)
        }
        Err(_) => (
            Some(
                env_first(["PGLITE_OXIDE_WASMER_BIN", "WASMER_BIN"])
                    .unwrap_or_else(|| "wasmer".to_owned()),
            ),
            None,
        ),
    }
}

fn env_first(names: impl IntoIterator<Item = &'static str>) -> Option<String> {
    names
        .into_iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty()))
}

fn perf_native_postgres(args: &[String]) -> Result<()> {
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut rtt_iterations = 100usize;
    let mut client_mode = NativePostgresClientMode::TokioPostgresSimple;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--postgres-bin" => {
                cursor += 1;
                postgres_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
                );
            }
            "--initdb-bin" => {
                cursor += 1;
                initdb_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
                );
            }
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "all" => BenchmarkSuiteFilter::All,
                    "rtt" | "roundtrip" | "round-trip" => BenchmarkSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    other => bail!("unknown --suite value {other:?}; use all, rtt, or speed"),
                };
            }
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                rtt_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = SpeedSqlSource::parse(value)?;
            }
            "--client" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--client requires a value"))?;
                client_mode = match value.as_str() {
                    "tokio-postgres-simple"
                    | "tokio_postgres_simple"
                    | "tokio-postgres"
                    | "tokio_postgres"
                    | "simple"
                    | "simple-query" => NativePostgresClientMode::TokioPostgresSimple,
                    "sqlx" => NativePostgresClientMode::Sqlx,
                    other => {
                        bail!("unknown --client value {other:?}; use tokio-postgres-simple or sqlx")
                    }
                };
            }
            other => bail!("unknown perf native-postgres flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");

    let native_open_started = Instant::now();
    let native = NativePostgres::start(&postgres_bin, &initdb_bin)?;
    let native_open_micros = native_open_started.elapsed().as_micros();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres benchmark Tokio runtime")?;
    let runs = runtime.block_on(async {
        match client_mode {
            NativePostgresClientMode::TokioPostgresSimple => {
                let mut config = tokio_postgres::Config::new();
                configure_native_postgres_client(&mut config, &native);
                let connect_started = Instant::now();
                let (client, connection) = config
                    .connect(tokio_postgres::NoTls)
                    .await
                    .context("connect to native Postgres benchmark cluster")?;
                let connection_task = tokio::spawn(async move {
                    if let Err(err) = connection.await {
                        eprintln!("native Postgres benchmark connection error: {err}");
                    }
                });
                let connect_micros = connect_started.elapsed().as_micros();
                let server_pid = native.child.id();

                let mut runs = Vec::new();
                if suite.includes("rtt") {
                    let mut sampler = ProcessTreeRssSampler::new(server_pid);
                    runs.push(
                        run_native_postgres_rtt_benchmark(
                            &client,
                            rtt_iterations,
                            native_open_micros,
                            connect_micros,
                            &mut sampler,
                        )
                        .await?,
                    );
                }
                if suite.includes("speed") {
                    let mut sampler = ProcessTreeRssSampler::new(server_pid);
                    runs.push(
                        run_native_postgres_speed_benchmark(
                            &client,
                            speed_sql_source,
                            native_open_micros,
                            connect_micros,
                            &mut sampler,
                        )
                        .await?,
                    );
                }
                drop(client);
                connection_task.await.ok();
                Ok::<_, anyhow::Error>(runs)
            }
            NativePostgresClientMode::Sqlx => {
                let connect_started = Instant::now();
                let mut conn =
                    sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
                        .await
                        .context("connect SQLx native Postgres benchmark client")?;
                let connect_micros = connect_started.elapsed().as_micros();
                let server_pid = native.child.id();

                let mut runs = Vec::new();
                if suite.includes("rtt") {
                    let mut sampler = ProcessTreeRssSampler::new(server_pid);
                    runs.push(
                        run_native_postgres_rtt_sqlx_benchmark(
                            &mut conn,
                            rtt_iterations,
                            native_open_micros,
                            connect_micros,
                            &mut sampler,
                        )
                        .await?,
                    );
                }
                if suite.includes("speed") {
                    let mut sampler = ProcessTreeRssSampler::new(server_pid);
                    runs.push(
                        run_native_postgres_speed_sqlx_benchmark(
                            &mut conn,
                            speed_sql_source,
                            native_open_micros,
                            connect_micros,
                            &mut sampler,
                        )
                        .await?,
                    );
                }
                conn.close()
                    .await
                    .context("close SQLx native Postgres benchmark client")?;
                Ok::<_, anyhow::Error>(runs)
            }
        }
    })?;

    let report = BenchmarkReport {
        wasmer_version: "native-postgres",
        wasmer_wasix_version: "native-postgres",
        source_model: speed_sql_source.source_model(),
        measurement_model: match client_mode {
            NativePostgresClientMode::TokioPostgresSimple => {
                "Native Postgres control. xtask starts a temporary local cluster with PGlite-parity startup GUCs and sends each benchmark SQL file as one simple-query buffer through tokio-postgres simple_query. This intentionally avoids psql -f because psql splits files client-side."
            }
            NativePostgresClientMode::Sqlx => {
                "Native Postgres control. xtask starts a temporary local cluster with PGlite-parity startup GUCs and runs the benchmark SQL through one long-lived SQLx connection."
            }
        },
        runtime: None,
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_native_postgres_open(args: &[String]) -> Result<()> {
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--postgres-bin" => {
                cursor += 1;
                postgres_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
                );
            }
            "--initdb-bin" => {
                cursor += 1;
                initdb_bin = PathBuf::from(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
                );
            }
            other => bail!("unknown perf native-postgres-open flag: {other}"),
        }
        cursor += 1;
    }

    let open_started = Instant::now();
    let native = NativePostgres::start(&postgres_bin, &initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();
    let phases = native.start_phases.clone();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres open-profile Tokio runtime")?;
    let (connect_micros, first_query_micros) = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, &native);
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native Postgres open-profile client")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let first_query_started = Instant::now();
        client
            .simple_query("SELECT 1")
            .await
            .context("run native Postgres open-profile first query")?;
        let first_query_micros = first_query_started.elapsed().as_micros();
        drop(client);
        connection_task.abort();
        Ok::<_, anyhow::Error>((connect_micros, first_query_micros))
    })?;

    let report = NativeOpenReport {
        source_model: "Native PostgreSQL 18 open-profile.",
        measurement_model: "Measures one native PostgreSQL control startup, including initdb, server spawn/readiness, a fresh client connect, and the first simple query. This is the control for native libpglite SDK open-profile runs.",
        runtime: None,
        runs: vec![NativeOpenRun {
            mode: "native_postgres_open",
            description: "Native PostgreSQL server startup and client connect.",
            open_micros,
            connect_micros: Some(connect_micros),
            first_query_micros: Some(first_query_micros),
            observed_server_peak_rss_bytes: None,
            phases,
        }],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_native_libpglite(args: &[String]) -> Result<()> {
    let mut suite = NativeLibpgliteSuiteFilter::Rtt;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut rtt_iterations = 100usize;
    let mut prepared_rows = 25_000usize;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "rtt" | "roundtrip" | "round-trip" => NativeLibpgliteSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => NativeLibpgliteSuiteFilter::Speed,
                    "prepared-updates" | "prepared" => NativeLibpgliteSuiteFilter::PreparedUpdates,
                    "all" => bail!(
                        "native-libpglite v1 can only open once per process; run --suite rtt, speed, and prepared-updates in separate commands"
                    ),
                    other => {
                        bail!(
                            "unknown --suite value {other:?}; use rtt, speed, or prepared-updates"
                        )
                    }
                };
            }
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                rtt_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = SpeedSqlSource::parse(value)?;
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                prepared_rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
            }
            other => bail!("unknown perf native-libpglite flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");
    ensure!(prepared_rows > 0, "--rows must be greater than zero");

    if suite == NativeLibpgliteSuiteFilter::PreparedUpdates {
        return perf_native_libpglite_prepared_updates(prepared_rows);
    }

    let run = match suite {
        NativeLibpgliteSuiteFilter::Rtt => run_native_libpglite_rtt_benchmark(rtt_iterations)?,
        NativeLibpgliteSuiteFilter::Speed => {
            run_native_libpglite_speed_benchmark(speed_sql_source)?
        }
        NativeLibpgliteSuiteFilter::PreparedUpdates => {
            unreachable!("prepared-updates returns before benchmark report construction")
        }
    };
    let report = BenchmarkReport {
        wasmer_version: "native-libpglite",
        wasmer_wasix_version: "native-libpglite",
        source_model: speed_sql_source.source_model(),
        measurement_model: "Native libpglite direct-mode happy-path control. xtask opens one embedded native PostgreSQL backend in-process through EngineKind::NativeLibPglite. RTT tests sort samples, discard the lowest and highest 10% when possible, and report trimmed averages plus percentile latencies. Speed tests run each upstream PGlite SQL file as one simple-query buffer.",
        runtime: None,
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs: vec![run],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_native_libpglite_open(args: &[String]) -> Result<()> {
    let _ = args;
    bail!(
        "perf native-libpglite-open is disabled in this PG18 WASIX server-path worktree; crates/libpglite-oxide native SDK changes were removed"
    )
}

fn perf_pglite_server_open(args: &[String]) -> Result<()> {
    let mut postgres_configs = Vec::new();
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--postgres-config" => {
                cursor += 1;
                let raw_config = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-config requires name=value"))?;
                postgres_configs.push(parse_postgres_config_arg(raw_config)?);
            }
            other => bail!(
                "unknown perf pglite-server-open flag {other:?}; use --postgres-config name=value"
            ),
        }
        cursor += 1;
    }

    let (server_result, phases) = capture_phase_timings(|| {
        let open_started = Instant::now();
        let server = benchmark_pglite_server_with_configs(&postgres_configs)?;
        let open_micros = open_started.elapsed().as_micros();
        Ok::<_, anyhow::Error>((server, open_micros))
    });
    let (server, open_micros) = server_result?;
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    sample_optional_rss(&mut server_rss);

    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create PgliteServer open-profile Tokio runtime")?;
    let (connect_micros, first_query_micros) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect PgliteServer open-profile SQLx client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let first_query_started = Instant::now();
        let value: i32 = sqlx::query("SELECT 1::int4 AS value")
            .fetch_one(&mut conn)
            .await
            .context("run PgliteServer open-profile first query")?
            .try_get("value")
            .context("read PgliteServer open-profile value")?;
        ensure!(value == 1, "unexpected PgliteServer first-query value");
        let first_query_micros = first_query_started.elapsed().as_micros();
        conn.close()
            .await
            .context("close PgliteServer open-profile SQLx client")?;
        Ok::<_, anyhow::Error>((connect_micros, first_query_micros))
    })?;
    sample_optional_rss(&mut server_rss);
    let observed_server_peak_rss_bytes = optional_peak_rss(&server_rss);
    server.shutdown()?;

    let report = NativeOpenReport {
        source_model: "pglite-oxide PgliteServer open-profile.",
        measurement_model: "Measures one PgliteServer startup, including runtime/root preparation, server spawn/readiness where applicable, a fresh SQLx client connect, the first query, and observed external server-process RSS for runtimes that expose one.",
        runtime: Some(benchmark_runtime_report()?),
        runs: vec![NativeOpenRun {
            mode: "pglite_server_open",
            description: "PgliteServer startup and SQLx connect/first-query profile.",
            open_micros,
            connect_micros: Some(connect_micros),
            first_query_micros: Some(first_query_micros),
            observed_server_peak_rss_bytes,
            phases: phases
                .into_iter()
                .map(|phase| OpenPhaseReport {
                    name: phase.name.to_owned(),
                    elapsed_micros: phase.elapsed_micros,
                })
                .collect(),
        }],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn record_open_phase(phases: &mut Vec<OpenPhaseReport>, name: &'static str, started: Instant) {
    phases.push(OpenPhaseReport {
        name: name.to_owned(),
        elapsed_micros: started.elapsed().as_micros(),
    });
}

fn perf_native_libpglite_sdk(args: &[String]) -> Result<()> {
    let _ = args;
    bail!(
        "perf native-libpglite-sdk is disabled in this PG18 WASIX server-path worktree; crates/libpglite-oxide native SDK changes were removed"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeLibpgliteSuiteFilter {
    Rtt,
    Speed,
    PreparedUpdates,
}

fn run_native_libpglite_rtt_benchmark(iterations: usize) -> Result<BenchmarkRun> {
    let root = native_libpglite_benchmark_root("rtt")?;
    let open_started = Instant::now();
    let mut db = Pglite::builder()
        .path(&root)
        .engine(EngineKind::NativeLibPglite)
        .open()?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    db.exec(rtt_setup_sql(), None)
        .context("execute native libpglite RTT setup")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        tests.push(run_rtt_case(iterations, &case, |sql| {
            db.exec(sql, None)?;
            Ok(())
        })?);
    }
    db.close()?;
    fs::remove_dir_all(&root)
        .with_context(|| format!("remove native libpglite RTT root {}", root.display()))?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_libpglite_direct",
        description: "Native libpglite in-process direct Rust API.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn run_native_libpglite_speed_benchmark(sql_source: SpeedSqlSource) -> Result<BenchmarkRun> {
    let cases = speed_cases(1.0, sql_source)?;
    let root = native_libpglite_benchmark_root("speed")?;
    let open_started = Instant::now();
    let mut db = Pglite::builder()
        .path(&root)
        .engine(EngineKind::NativeLibPglite)
        .open()?;
    let open_micros = open_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in cases {
        let started = Instant::now();
        db.exec(&case.sql, None)
            .with_context(|| format!("execute native libpglite speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
    }
    db.close()?;
    fs::remove_dir_all(&root)
        .with_context(|| format!("remove native libpglite speed root {}", root.display()))?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_libpglite_direct",
        description: "Native libpglite speed suite through the in-process direct Rust API.",
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn perf_native_libpglite_prepared_updates(rows: usize) -> Result<()> {
    let runs = vec![
        PreparedUpdateRun {
            mode: "native_libpglite_direct_prepared",
            description: "Native libpglite direct mode using one named prepared statement and one Bind/Execute/Sync round trip per update.",
            protocol_stats: None,
            tests: run_native_libpglite_prepared_update_tests(rows, PreparedExecution::Sequential)?,
        },
        PreparedUpdateRun {
            mode: "native_libpglite_direct_pipelined_prepared",
            description: "Native libpglite direct mode using one named prepared statement and one pipelined Bind/Execute batch inside one transaction.",
            protocol_stats: None,
            tests: run_native_libpglite_prepared_update_tests(rows, PreparedExecution::Pipelined)?,
        },
    ];

    let report = PreparedUpdateReport {
        source_model: "Exact PGlite benchmark2/benchmark6 setup plus update values parsed from benchmark9 and benchmark10.",
        measurement_model: "Each native-libpglite direct test runs in a fresh xtask child process because embedded PostgreSQL 18 cannot currently be reopened safely in the same host process. The child opens one in-process native backend, prepares one named statement over the raw frontend/backend protocol, then executes N updates inside one transaction.",
        gate_model: None,
        host_load: capture_host_load_report(),
        setup_variant: None,
        runtime: None,
        rows,
        passes: 1,
        runs,
        sqlx_native_comparison: None,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_native_libpglite_prepared_update_tests(
    rows: usize,
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    Ok(vec![
        run_native_libpglite_prepared_update_child(
            NativeLibpglitePreparedCase::Numeric,
            execution,
            rows,
        )?,
        run_native_libpglite_prepared_update_child(
            NativeLibpglitePreparedCase::Text,
            execution,
            rows,
        )?,
    ])
}

fn run_native_libpglite_prepared_update_child(
    case: NativeLibpglitePreparedCase,
    execution: PreparedExecution,
    rows: usize,
) -> Result<PreparedUpdateTest> {
    let rows_arg = rows.to_string();
    let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
        .args([
            "perf",
            "native-libpglite-prepared-child",
            "--case",
            case.arg(),
            "--execution",
            execution.arg(),
            "--rows",
            rows_arg.as_str(),
        ])
        .output()
        .with_context(|| format!("run native-libpglite prepared child for {}", case.arg()))?;

    if !output.status.success() {
        bail!(
            "native-libpglite prepared child failed for {} {}:\nstdout:\n{}\nstderr:\n{}",
            case.arg(),
            execution.arg(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let metrics: PreparedUpdateChildMetrics =
        serde_json::from_slice(&output.stdout).with_context(|| {
            format!(
                "parse native-libpglite prepared child JSON for {} {}",
                case.arg(),
                execution.arg()
            )
        })?;
    Ok(metrics.into_test(case))
}

fn perf_native_libpglite_prepared_child(args: &[String]) -> Result<()> {
    let mut case = None;
    let mut execution = None;
    let mut rows = 25_000usize;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--case" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--case requires a value"))?;
                case = Some(NativeLibpglitePreparedCase::parse(value)?);
            }
            "--execution" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--execution requires a value"))?;
                execution = Some(parse_prepared_execution(value)?);
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
            }
            other => bail!("unknown native-libpglite prepared child flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows must be greater than zero");
    let case = case.context("--case is required")?;
    let execution = execution.context("--execution is required")?;

    let metrics = run_native_libpglite_direct_prepared_update_case(case, execution, rows)?;
    println!("{}", serde_json::to_string_pretty(&metrics)?);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum NativeLibpglitePreparedCase {
    Numeric,
    Text,
}

impl NativeLibpglitePreparedCase {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "numeric" | "numeric-indexed" => Ok(Self::Numeric),
            "text" | "text-indexed" => Ok(Self::Text),
            other => bail!("unknown native-libpglite prepared case {other:?}"),
        }
    }

    fn arg(self) -> &'static str {
        match self {
            Self::Numeric => "numeric",
            Self::Text => "text",
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Numeric => "numeric_indexed",
            Self::Text => "text_indexed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Numeric => {
                "Parameterized numeric UPDATEs with indexes on lookup and updated columns"
            }
            Self::Text => "Parameterized text UPDATEs with indexes on lookup and numeric column",
        }
    }
}

fn parse_prepared_execution(value: &str) -> Result<PreparedExecution> {
    match value {
        "sequential" => Ok(PreparedExecution::Sequential),
        "pipelined" | "pipeline" => Ok(PreparedExecution::Pipelined),
        other => bail!("unknown prepared execution {other:?}"),
    }
}

impl PreparedExecution {
    fn arg(self) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::Pipelined => "pipelined",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedUpdateChildMetrics {
    open_micros: u128,
    connect_micros: u128,
    setup_micros: u128,
    prepare_micros: Option<u128>,
    elapsed_micros: u128,
    operation_count: usize,
    average_micros: f64,
}

impl PreparedUpdateChildMetrics {
    fn into_test(self, case: NativeLibpglitePreparedCase) -> PreparedUpdateTest {
        PreparedUpdateTest {
            id: case.id(),
            label: case.label(),
            open_micros: self.open_micros,
            connect_micros: self.connect_micros,
            setup_micros: self.setup_micros,
            prepare_micros: self.prepare_micros,
            elapsed_micros: self.elapsed_micros,
            operation_count: self.operation_count,
            average_micros: self.average_micros,
            cpu_profile: None,
            profile_analysis: None,
        }
    }
}

fn run_native_libpglite_direct_prepared_update_case(
    case: NativeLibpglitePreparedCase,
    execution: PreparedExecution,
    rows: usize,
) -> Result<PreparedUpdateChildMetrics> {
    let setup_benchmark2 = read_pglite_benchmark_sql("2")?;
    let setup_benchmark6 = read_pglite_benchmark_sql("6")?;
    let update_values = match case {
        NativeLibpglitePreparedCase::Numeric => {
            NativeLibpglitePreparedValues::Numeric(parsed_numeric_updates(rows)?)
        }
        NativeLibpglitePreparedCase::Text => {
            NativeLibpglitePreparedValues::Text(parsed_text_updates(rows)?)
        }
    };

    let root = native_libpglite_benchmark_root("prepared")?;
    let open_started = Instant::now();
    let mut db = Pglite::builder()
        .path(&root)
        .engine(EngineKind::NativeLibPglite)
        .open()?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    db.exec(&setup_benchmark2, None)
        .context("execute native-libpglite prepared setup benchmark2")?;
    db.exec(&setup_benchmark6, None)
        .context("execute native-libpglite prepared setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let statement_name = "pglite_bench_update";
    let (sql, param_oids) = match case {
        NativeLibpglitePreparedCase::Numeric => ("UPDATE t2 SET b=$1 WHERE a=$2", &[23, 23][..]),
        NativeLibpglitePreparedCase::Text => ("UPDATE t2 SET c=$1 WHERE a=$2", &[25, 23][..]),
    };
    let mut prepare = Vec::new();
    prepare.extend(pg_parse(Some(statement_name), sql, param_oids));
    prepare.extend(pg_describe(b'S', Some(statement_name)));
    prepare.extend(pg_sync());
    let prepare_started = Instant::now();
    exec_raw_checked(
        &mut db,
        &prepare,
        "prepare native-libpglite direct statement",
    )?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    exec_raw_checked(
        &mut db,
        &pg_query("BEGIN"),
        "begin prepared-update transaction",
    )?;
    let operation_count = match update_values {
        NativeLibpglitePreparedValues::Numeric(updates) => {
            execute_native_libpglite_direct_prepared_updates(
                &mut db,
                statement_name,
                execution,
                updates
                    .iter()
                    .map(|(lookup, value)| [value.to_string(), lookup.to_string()]),
            )?;
            updates.len()
        }
        NativeLibpglitePreparedValues::Text(updates) => {
            execute_native_libpglite_direct_prepared_updates(
                &mut db,
                statement_name,
                execution,
                updates
                    .iter()
                    .map(|(lookup, value)| [value.clone(), lookup.to_string()]),
            )?;
            updates.len()
        }
    };
    exec_raw_checked(
        &mut db,
        &pg_query("COMMIT"),
        "commit prepared-update transaction",
    )?;
    let elapsed = started.elapsed();

    db.close()
        .context("close native-libpglite prepared-update database")?;
    fs::remove_dir_all(&root).with_context(|| {
        format!(
            "remove native libpglite prepared-update root {}",
            root.display()
        )
    })?;

    Ok(PreparedUpdateChildMetrics {
        open_micros,
        connect_micros: 0,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        average_micros: elapsed.as_micros() as f64 / operation_count as f64,
    })
}

fn native_libpglite_benchmark_root(label: &str) -> Result<PathBuf> {
    let root = env::current_dir()
        .context("read current directory")?
        .join("target/perf")
        .join(format!(
            "native-libpglite-{label}-{}-{}",
            std::process::id(),
            now_micros()?
        ));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale native libpglite root {}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .with_context(|| format!("create native libpglite root {}", root.display()))?;
    Ok(root)
}

enum NativeLibpglitePreparedValues {
    Numeric(Vec<(i32, i32)>),
    Text(Vec<(i32, String)>),
}

fn execute_native_libpglite_direct_prepared_updates<I>(
    db: &mut Pglite,
    statement_name: &str,
    execution: PreparedExecution,
    values: I,
) -> Result<()>
where
    I: IntoIterator<Item = [String; 2]>,
{
    match execution {
        PreparedExecution::Sequential => {
            for value_pair in values {
                let mut batch = Vec::new();
                batch.extend(pg_bind(None, statement_name, &value_pair));
                batch.extend(pg_execute(None));
                batch.extend(pg_sync());
                exec_raw_checked(
                    db,
                    &batch,
                    "execute sequential native-libpglite prepared update",
                )?;
            }
        }
        PreparedExecution::Pipelined => {
            let mut batch = Vec::new();
            for (idx, value_pair) in values.into_iter().enumerate() {
                let portal = format!("p{idx}");
                batch.extend(pg_bind(Some(&portal), statement_name, &value_pair));
                batch.extend(pg_execute(Some(&portal)));
                batch.extend(pg_close(b'P', Some(&portal)));
            }
            batch.extend(pg_sync());
            exec_raw_checked(
                db,
                &batch,
                "execute pipelined native-libpglite prepared updates",
            )?;
        }
    }
    Ok(())
}

fn exec_raw_checked(db: &mut Pglite, message: &[u8], context: &'static str) -> Result<()> {
    let response = db
        .exec_protocol_raw(message, pglite_oxide::ExecProtocolOptions::no_sync())
        .with_context(|| context)?;
    ensure_protocol_response_ok(&response).with_context(|| context)
}

fn ensure_protocol_response_ok(response: &[u8]) -> Result<()> {
    let mut off = 0usize;
    let mut ready = false;
    while off + 5 <= response.len() {
        let tag = response[off];
        let len = u32::from_be_bytes([
            response[off + 1],
            response[off + 2],
            response[off + 3],
            response[off + 4],
        ]) as usize;
        ensure!(len >= 4, "invalid backend message length {len}");
        let frame_len = 1 + len;
        ensure!(
            frame_len <= response.len() - off,
            "truncated backend message tag {} length {len}",
            tag as char
        );
        ensure!(tag != b'E', "backend returned ErrorResponse");
        ready |= tag == b'Z';
        off += frame_len;
    }
    ensure!(off == response.len(), "trailing bytes in backend response");
    ensure!(ready, "backend response did not include ReadyForQuery");
    Ok(())
}

fn pg_query(sql: &str) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, sql);
    pg_frame(b'Q', &body)
}

fn pg_parse(name: Option<&str>, sql: &str, types: &[i32]) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, name.unwrap_or(""));
    push_cstr(&mut body, sql);
    push_i16(&mut body, types.len() as i16);
    for oid in types {
        push_i32(&mut body, *oid);
    }
    pg_frame(b'P', &body)
}

fn pg_bind(portal: Option<&str>, statement: &str, values: &[String; 2]) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, portal.unwrap_or(""));
    push_cstr(&mut body, statement);
    push_i16(&mut body, values.len() as i16);
    for _ in values {
        push_i16(&mut body, 0);
    }
    push_i16(&mut body, values.len() as i16);
    for value in values {
        push_i32(&mut body, value.len() as i32);
        body.extend_from_slice(value.as_bytes());
    }
    push_i16(&mut body, 0);
    pg_frame(b'B', &body)
}

fn pg_execute(portal: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, portal.unwrap_or(""));
    push_i32(&mut body, 0);
    pg_frame(b'E', &body)
}

fn pg_describe(target_type: u8, name: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    body.push(target_type);
    push_cstr(&mut body, name.unwrap_or(""));
    pg_frame(b'D', &body)
}

fn pg_close(target_type: u8, name: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    body.push(target_type);
    push_cstr(&mut body, name.unwrap_or(""));
    pg_frame(b'C', &body)
}

fn pg_sync() -> Vec<u8> {
    pg_frame(b'S', &[])
}

fn pg_frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 4 + body.len());
    out.push(tag);
    out.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

fn push_cstr(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn push_i16(out: &mut Vec<u8>, value: i16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_be_bytes());
}

async fn run_native_postgres_rtt_benchmark(
    client: &tokio_postgres::Client,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    client
        .simple_query(rtt_setup_sql())
        .await
        .context("execute native Postgres RTT setup")?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            client
                .simple_query(&case.sql)
                .await
                .with_context(|| format!("execute native Postgres RTT benchmark {}", case.id))?;
            samples.push(started.elapsed().as_micros());
        }
        tests.push(samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        ));
        server_rss.sample();
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_postgres",
        description: "Native Postgres over Unix socket using tokio-postgres simple_query.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_native_postgres_speed_benchmark(
    client: &tokio_postgres::Client,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    client
        .simple_query(
            "DROP TABLE IF EXISTS t1 CASCADE;\
             DROP TABLE IF EXISTS t2 CASCADE;\
             DROP TABLE IF EXISTS t2_1 CASCADE;\
             DROP TABLE IF EXISTS t3 CASCADE;\
             DROP TABLE IF EXISTS t3_1 CASCADE;",
        )
        .await
        .context("clear native Postgres speed benchmark tables")?;
    server_rss.sample();

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        client
            .simple_query(&case.sql)
            .await
            .with_context(|| format!("execute native Postgres speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
        server_rss.sample();
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_postgres",
        description: "Native Postgres speed suite over Unix socket using tokio-postgres simple_query.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

fn native_postgres_sqlx_options(native: &NativePostgres) -> PgConnectOptions {
    PgConnectOptions::new_without_pgpass()
        .host("127.0.0.1")
        .port(native.port)
        .username("postgres")
        .database("postgres")
        .ssl_mode(PgSslMode::Disable)
}

fn perf_pglite_nodefs_sqlx(args: &[String]) -> Result<()> {
    let mut database_url: Option<String> = None;
    let mut suite = BenchmarkSuiteFilter::Speed;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut rtt_iterations = 100usize;
    let mut open_micros = 0u128;
    let mut cursor = 0usize;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--database-url" => {
                cursor += 1;
                database_url = Some(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("--database-url requires a value"))?
                        .to_owned(),
                );
            }
            "--open-micros" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--open-micros requires a value"))?;
                open_micros = value
                    .parse()
                    .with_context(|| format!("parse --open-micros value {value:?}"))?;
            }
            "--suite" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--suite requires a value"))?;
                suite = match value.as_str() {
                    "all" => BenchmarkSuiteFilter::All,
                    "rtt" | "roundtrip" | "round-trip" => BenchmarkSuiteFilter::Rtt,
                    "speed" | "sqlite" | "sqlite-suite" => BenchmarkSuiteFilter::Speed,
                    other => bail!("unknown --suite value {other:?}; use all, rtt, or speed"),
                };
            }
            "--iterations" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--iterations requires a value"))?;
                rtt_iterations = value
                    .parse()
                    .with_context(|| format!("parse --iterations value {value:?}"))?;
            }
            "--speed-source" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
                speed_sql_source = SpeedSqlSource::parse(value)?;
            }
            other => bail!("unknown perf pglite-nodefs-sqlx flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rtt_iterations > 0, "--iterations must be greater than zero");
    let database_url = database_url.ok_or_else(|| anyhow!("--database-url is required"))?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create PGlite NodeFS SQLx benchmark Tokio runtime")?;
    let runs = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .context("connect SQLx client to PGlite NodeFS socket server")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let mut runs = Vec::new();
        if suite.includes("rtt") {
            runs.push(
                run_pglite_nodefs_rtt_sqlx_benchmark(
                    &mut conn,
                    rtt_iterations,
                    open_micros,
                    connect_micros,
                )
                .await?,
            );
        }
        if suite.includes("speed") {
            runs.push(
                run_pglite_nodefs_speed_sqlx_benchmark(
                    &mut conn,
                    speed_sql_source,
                    open_micros,
                    connect_micros,
                )
                .await?,
            );
        }
        conn.close()
            .await
            .context("close SQLx PGlite NodeFS benchmark client")?;
        Ok::<_, anyhow::Error>(runs)
    })?;

    let report = BenchmarkReport {
        wasmer_version: "node-pglite",
        wasmer_wasix_version: "node-pglite",
        source_model: speed_sql_source.source_model(),
        measurement_model: "Upstream PGlite control. A Node process starts @electric-sql/pglite with NodeFS persistence and @electric-sql/pglite-socket, then xtask runs the benchmark SQL through one long-lived SQLx connection.",
        runtime: None,
        rtt_iterations,
        speed_scale: 1.0,
        preload_micros: 0,
        runs,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

async fn run_native_postgres_rtt_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    conn.execute(rtt_setup_sql())
        .await
        .context("execute native Postgres RTT setup over SQLx")?;
    let setup_micros = setup_started.elapsed().as_micros();
    server_rss.sample();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            conn.execute(case.sql.as_str()).await.with_context(|| {
                format!(
                    "execute native Postgres RTT benchmark {} over SQLx",
                    case.id
                )
            })?;
            samples.push(started.elapsed().as_micros());
        }
        tests.push(samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        ));
        server_rss.sample();
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "native_postgres_sqlx",
        description: "Native Postgres over TCP using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_pglite_nodefs_rtt_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    iterations: usize,
    open_micros: u128,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
    let setup_started = Instant::now();
    conn.execute(rtt_setup_sql())
        .await
        .context("execute PGlite NodeFS RTT setup over SQLx")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            conn.execute(case.sql.as_str()).await.with_context(|| {
                format!("execute PGlite NodeFS RTT benchmark {} over SQLx", case.id)
            })?;
            samples.push(started.elapsed().as_micros());
        }
        tests.push(samples_result(
            case.id,
            format!("Test {}: {}", case.id, case.label),
            "milliseconds",
            iterations,
            samples,
        ));
    }

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "pglite_nodefs_sqlx",
        description: "Upstream PGlite NodeFS over the Postgres wire protocol using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

async fn run_native_postgres_speed_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
    server_rss: &mut ProcessTreeRssSampler,
) -> Result<BenchmarkRun> {
    conn.execute(
        "DROP TABLE IF EXISTS t1 CASCADE;\
         DROP TABLE IF EXISTS t2 CASCADE;\
         DROP TABLE IF EXISTS t2_1 CASCADE;\
         DROP TABLE IF EXISTS t3 CASCADE;\
         DROP TABLE IF EXISTS t3_1 CASCADE;",
    )
    .await
    .context("clear native Postgres speed benchmark tables over SQLx")?;
    server_rss.sample();

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        conn.execute(case.sql.as_str()).await.with_context(|| {
            format!(
                "execute native Postgres speed benchmark {} over SQLx",
                case.id
            )
        })?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
        server_rss.sample();
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "native_postgres_sqlx",
        description: "Native Postgres speed suite over TCP using one SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: server_rss.peak_bytes(),
        tests,
    })
}

async fn run_pglite_nodefs_speed_sqlx_benchmark(
    conn: &mut sqlx::PgConnection,
    sql_source: SpeedSqlSource,
    open_micros: u128,
    connect_micros: u128,
) -> Result<BenchmarkRun> {
    conn.execute(
        "DROP TABLE IF EXISTS t1 CASCADE;\
         DROP TABLE IF EXISTS t2 CASCADE;\
         DROP TABLE IF EXISTS t2_1 CASCADE;\
         DROP TABLE IF EXISTS t3 CASCADE;\
         DROP TABLE IF EXISTS t3_1 CASCADE;",
    )
    .await
    .context("clear PGlite NodeFS speed benchmark tables over SQLx")?;

    let mut tests = Vec::new();
    for case in speed_cases(1.0, sql_source)? {
        let started = Instant::now();
        conn.execute(case.sql.as_str()).await.with_context(|| {
            format!(
                "execute PGlite NodeFS speed benchmark {} over SQLx",
                case.id
            )
        })?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
    }
    Ok(BenchmarkRun {
        suite: "speed",
        mode: "pglite_nodefs_sqlx",
        description: "Upstream PGlite NodeFS speed suite over TCP using one SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn prepared_update_sample_count_arg(args: &[String]) -> Result<usize> {
    let mut samples = 1usize;
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(value) = arg
            .strip_prefix("--samples=")
            .or_else(|| arg.strip_prefix("--sample-count="))
        {
            samples = value
                .parse()
                .with_context(|| format!("parse --samples value {value:?}"))?;
        } else if arg == "--samples" || arg == "--sample-count" {
            cursor += 1;
            let value = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            samples = value
                .parse()
                .with_context(|| format!("parse {arg} value {value:?}"))?;
        }
        cursor += 1;
    }
    ensure!(samples > 0, "--samples must be greater than zero");
    Ok(samples)
}

fn prepared_update_args_without_samples(args: &[String]) -> Vec<String> {
    let mut filtered = Vec::with_capacity(args.len() + 2);
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if matches!(
            arg.as_str(),
            "--samples"
                | "--sample-count"
                | "--max-load-per-cpu"
                | "--max-load-per-logical-cpu"
                | "--max-top-cpu-percent"
                | "--max-sample-attempts"
                | "--max-sample-spread-ratio"
                | "--max-sample-elapsed-spread-ratio"
                | "--load-gate-wait-ms"
                | "--host-load-wait-ms"
                | "--load-gate-poll-ms"
                | "--host-load-poll-ms"
        ) {
            cursor += 2;
            continue;
        }
        if arg.starts_with("--samples=")
            || arg.starts_with("--sample-count=")
            || arg.starts_with("--max-load-per-cpu=")
            || arg.starts_with("--max-load-per-logical-cpu=")
            || arg.starts_with("--max-top-cpu-percent=")
            || arg.starts_with("--max-sample-attempts=")
            || arg.starts_with("--max-sample-spread-ratio=")
            || arg.starts_with("--max-sample-elapsed-spread-ratio=")
            || arg.starts_with("--load-gate-wait-ms=")
            || arg.starts_with("--host-load-wait-ms=")
            || arg.starts_with("--load-gate-poll-ms=")
            || arg.starts_with("--host-load-poll-ms=")
        {
            cursor += 1;
            continue;
        }
        filtered.push(arg.clone());
        cursor += 1;
    }
    filtered.push("--samples".to_owned());
    filtered.push("1".to_owned());
    filtered
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WasixPerfStatsOptions {
    log: PathBuf,
    summary_prefix: PathBuf,
    wasmer_bin: Option<PathBuf>,
}

fn prepared_read_wasix_perf_stats_options(
    args: &[String],
) -> Result<Option<WasixPerfStatsOptions>> {
    let mut enabled = false;
    let mut log: Option<PathBuf> = None;
    let mut summary_prefix: Option<PathBuf> = None;
    let mut wasmer_bin: Option<PathBuf> = None;
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if arg == "--wasix-perf-stats" {
            enabled = true;
        } else if let Some(value) = arg.strip_prefix("--wasix-perf-stats-log=") {
            enabled = true;
            log = Some(PathBuf::from(value));
        } else if arg == "--wasix-perf-stats-log" {
            cursor += 1;
            let value = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--wasix-perf-stats-log requires a value"))?;
            enabled = true;
            log = Some(PathBuf::from(value));
        } else if let Some(value) = arg.strip_prefix("--wasix-perf-stats-summary-prefix=") {
            enabled = true;
            summary_prefix = Some(PathBuf::from(value));
        } else if arg == "--wasix-perf-stats-summary-prefix" {
            cursor += 1;
            let value = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--wasix-perf-stats-summary-prefix requires a value"))?;
            enabled = true;
            summary_prefix = Some(PathBuf::from(value));
        } else if let Some(value) = arg.strip_prefix("--wasix-perf-stats-bin=") {
            enabled = true;
            wasmer_bin = Some(PathBuf::from(value));
        } else if arg == "--wasix-perf-stats-bin" {
            cursor += 1;
            let value = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--wasix-perf-stats-bin requires a value"))?;
            enabled = true;
            wasmer_bin = Some(PathBuf::from(value));
        }
        cursor += 1;
    }
    if !enabled {
        return Ok(None);
    }
    let log = log.unwrap_or_else(|| {
        Path::new("target/perf").join(format!(
            "prepared-reads-wasix-perf-stats-{}.log",
            now_micros().unwrap_or(0)
        ))
    });
    let summary_prefix =
        summary_prefix.unwrap_or_else(|| wasix_perf_stats_default_summary_prefix(&log));
    Ok(Some(WasixPerfStatsOptions {
        log,
        summary_prefix,
        wasmer_bin,
    }))
}

fn prepared_read_args_without_wasix_perf_stats(args: &[String]) -> Result<Vec<String>> {
    let mut filtered = Vec::with_capacity(args.len());
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if matches!(
            arg.as_str(),
            "--wasix-perf-stats-log"
                | "--wasix-perf-stats-summary-prefix"
                | "--wasix-perf-stats-bin"
        ) {
            ensure!(args.get(cursor + 1).is_some(), "{arg} requires a value");
            cursor += 2;
            continue;
        }
        if arg == "--wasix-perf-stats"
            || arg.starts_with("--wasix-perf-stats-log=")
            || arg.starts_with("--wasix-perf-stats-summary-prefix=")
            || arg.starts_with("--wasix-perf-stats-bin=")
        {
            cursor += 1;
            continue;
        }
        filtered.push(arg.clone());
        cursor += 1;
    }
    Ok(filtered)
}

fn wasix_perf_stats_default_summary_prefix(log: &Path) -> PathBuf {
    if log.extension().and_then(|extension| extension.to_str()) == Some("log") {
        log.with_extension("")
    } else {
        log.to_path_buf()
    }
}

fn appended_path_suffix(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.display(), suffix))
}

fn wasix_perf_stats_summary_paths(prefix: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("summaryTsv", appended_path_suffix(prefix, ".tsv")),
        ("topTimeTsv", appended_path_suffix(prefix, ".top-time.tsv")),
        (
            "topBytesTsv",
            appended_path_suffix(prefix, ".top-bytes.tsv"),
        ),
        (
            "pwritePathsTsv",
            appended_path_suffix(prefix, ".pwrite-paths.tsv"),
        ),
        (
            "pwritePathsTopTimeTsv",
            appended_path_suffix(prefix, ".pwrite-paths.top-time.tsv"),
        ),
        (
            "pwritePathsTopBytesTsv",
            appended_path_suffix(prefix, ".pwrite-paths.top-bytes.tsv"),
        ),
    ]
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("remove stale {}", path.display())),
    }
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    Ok(())
}

fn prepare_wasix_perf_stats_outputs(options: &WasixPerfStatsOptions) -> Result<()> {
    ensure_parent_dir(&options.log)?;
    ensure_parent_dir(&options.summary_prefix)?;
    remove_file_if_exists(&options.log)?;
    for (_, path) in wasix_perf_stats_summary_paths(&options.summary_prefix) {
        remove_file_if_exists(&path)?;
    }
    Ok(())
}

fn summarize_wasix_perf_stats(log: &Path, prefix: &Path) -> Result<()> {
    let script = Path::new("assets/wasix-build/experiments/fresh-wasix-postgres/bin")
        .join("summarize-wasix-perf-stats.sh");
    let output = Command::new("bash")
        .arg(&script)
        .arg(log)
        .arg(prefix)
        .output()
        .with_context(|| format!("run {}", script.display()))?;
    if !output.status.success() {
        bail!(
            "{} failed with {}\nstdout:\n{}\nstderr:\n{}",
            script.display(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn wasix_perf_stats_report(options: &WasixPerfStatsOptions) -> serde_json::Value {
    let mut report = serde_json::json!({
        "enabled": true,
        "log": options.log.display().to_string(),
        "summaryPrefix": options.summary_prefix.display().to_string(),
    });
    let object = report
        .as_object_mut()
        .expect("wasix perf stats report is an object");
    for (field, path) in wasix_perf_stats_summary_paths(&options.summary_prefix) {
        object.insert(
            field.to_owned(),
            serde_json::json!(path.display().to_string()),
        );
    }
    if let Some(wasmer_bin) = options.wasmer_bin.as_ref() {
        object.insert(
            "wasmerBin".to_owned(),
            serde_json::json!(wasmer_bin.display().to_string()),
        );
    }
    report
}

#[derive(Debug, Clone)]
struct SampledHostLoadGate {
    max_load_per_logical_cpu: Option<f64>,
    max_top_cpu_percent: Option<f64>,
    max_sample_attempts: Option<usize>,
    pre_sample_wait_timeout: Option<Duration>,
    pre_sample_poll_interval: Duration,
}

#[derive(Debug, Clone)]
struct SampledStabilityGate {
    max_elapsed_spread_ratio: Option<f64>,
}

fn sampled_stability_gate_arg(args: &[String]) -> Result<SampledStabilityGate> {
    let mut max_elapsed_spread_ratio = Some(1.15);
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(value) = arg
            .strip_prefix("--max-sample-spread-ratio=")
            .or_else(|| arg.strip_prefix("--max-sample-elapsed-spread-ratio="))
        {
            max_elapsed_spread_ratio = parse_sample_spread_gate_value(value)?;
        } else if arg == "--max-sample-spread-ratio" || arg == "--max-sample-elapsed-spread-ratio" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            max_elapsed_spread_ratio = parse_sample_spread_gate_value(value)?;
            cursor += 1;
        }
        cursor += 1;
    }
    Ok(SampledStabilityGate {
        max_elapsed_spread_ratio,
    })
}

fn parse_sample_spread_gate_value(value: &str) -> Result<Option<f64>> {
    if matches!(value, "off" | "none" | "disabled") {
        return Ok(None);
    }
    let parsed = value
        .parse::<f64>()
        .with_context(|| format!("parse sample spread gate value {value:?}"))?;
    ensure!(
        parsed >= 1.0,
        "--max-sample-spread-ratio must be at least 1.0, or off"
    );
    Ok(Some(parsed))
}

impl SampledHostLoadGate {
    fn is_enabled(&self) -> bool {
        self.max_load_per_logical_cpu.is_some() || self.max_top_cpu_percent.is_some()
    }

    fn max_attempts(&self, sample_count: usize) -> usize {
        self.max_sample_attempts
            .unwrap_or_else(|| sample_count.saturating_mul(3).max(sample_count))
    }

    fn report(&self, sample_count: usize) -> Option<SampledHostLoadGateReport> {
        self.is_enabled().then(|| SampledHostLoadGateReport {
            max_load_per_logical_cpu: self.max_load_per_logical_cpu,
            max_top_cpu_percent: self.max_top_cpu_percent,
            max_sample_attempts: self.max_attempts(sample_count),
            pre_sample_wait_timeout_ms: self
                .pre_sample_wait_timeout
                .map(|duration| duration.as_millis() as u64),
            pre_sample_poll_ms: self
                .pre_sample_wait_timeout
                .map(|_| self.pre_sample_poll_interval.as_millis() as u64),
        })
    }
}

fn sampled_host_load_gate_arg(args: &[String], sample_count: usize) -> Result<SampledHostLoadGate> {
    let mut max_load_per_logical_cpu = None;
    let mut max_top_cpu_percent = None;
    let mut max_sample_attempts = None;
    let mut pre_sample_wait_timeout = None;
    let mut pre_sample_poll_interval = Duration::from_millis(2_000);
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(value) = arg
            .strip_prefix("--max-load-per-cpu=")
            .or_else(|| arg.strip_prefix("--max-load-per-logical-cpu="))
        {
            let value = value
                .parse::<f64>()
                .with_context(|| format!("parse host-load gate value {value:?}"))?;
            ensure!(value > 0.0, "--max-load-per-cpu must be greater than zero");
            max_load_per_logical_cpu = Some(value);
        } else if arg == "--max-load-per-cpu" || arg == "--max-load-per-logical-cpu" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            let parsed = value
                .parse::<f64>()
                .with_context(|| format!("parse host-load gate value {value:?}"))?;
            ensure!(parsed > 0.0, "--max-load-per-cpu must be greater than zero");
            max_load_per_logical_cpu = Some(parsed);
            cursor += 1;
        } else if let Some(value) = arg.strip_prefix("--max-top-cpu-percent=") {
            let value = value
                .parse::<f64>()
                .with_context(|| format!("parse top-CPU gate value {value:?}"))?;
            ensure!(
                value > 0.0,
                "--max-top-cpu-percent must be greater than zero"
            );
            max_top_cpu_percent = Some(value);
        } else if arg == "--max-top-cpu-percent" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("--max-top-cpu-percent requires a value"))?;
            let parsed = value
                .parse::<f64>()
                .with_context(|| format!("parse top-CPU gate value {value:?}"))?;
            ensure!(
                parsed > 0.0,
                "--max-top-cpu-percent must be greater than zero"
            );
            max_top_cpu_percent = Some(parsed);
            cursor += 1;
        } else if let Some(value) = arg.strip_prefix("--max-sample-attempts=") {
            let value = value
                .parse::<usize>()
                .with_context(|| format!("parse --max-sample-attempts value {value:?}"))?;
            ensure!(
                value >= sample_count,
                "--max-sample-attempts must be at least --samples"
            );
            max_sample_attempts = Some(value);
        } else if arg == "--max-sample-attempts" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("--max-sample-attempts requires a value"))?;
            let parsed = value
                .parse::<usize>()
                .with_context(|| format!("parse --max-sample-attempts value {value:?}"))?;
            ensure!(
                parsed >= sample_count,
                "--max-sample-attempts must be at least --samples"
            );
            max_sample_attempts = Some(parsed);
            cursor += 1;
        } else if let Some(value) = arg
            .strip_prefix("--load-gate-wait-ms=")
            .or_else(|| arg.strip_prefix("--host-load-wait-ms="))
        {
            let value = value
                .parse::<u64>()
                .with_context(|| format!("parse host-load wait timeout {value:?}"))?;
            pre_sample_wait_timeout = Some(Duration::from_millis(value));
        } else if arg == "--load-gate-wait-ms" || arg == "--host-load-wait-ms" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            let parsed = value
                .parse::<u64>()
                .with_context(|| format!("parse host-load wait timeout {value:?}"))?;
            pre_sample_wait_timeout = Some(Duration::from_millis(parsed));
            cursor += 1;
        } else if let Some(value) = arg
            .strip_prefix("--load-gate-poll-ms=")
            .or_else(|| arg.strip_prefix("--host-load-poll-ms="))
        {
            let value = value
                .parse::<u64>()
                .with_context(|| format!("parse host-load poll interval {value:?}"))?;
            ensure!(value > 0, "--load-gate-poll-ms must be greater than zero");
            pre_sample_poll_interval = Duration::from_millis(value);
        } else if arg == "--load-gate-poll-ms" || arg == "--host-load-poll-ms" {
            let value = args
                .get(cursor + 1)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            let parsed = value
                .parse::<u64>()
                .with_context(|| format!("parse host-load poll interval {value:?}"))?;
            ensure!(parsed > 0, "--load-gate-poll-ms must be greater than zero");
            pre_sample_poll_interval = Duration::from_millis(parsed);
            cursor += 1;
        }
        cursor += 1;
    }
    ensure!(
        max_load_per_logical_cpu.is_some()
            || max_top_cpu_percent.is_some()
            || pre_sample_wait_timeout.is_none(),
        "--load-gate-wait-ms requires --max-load-per-cpu or --max-top-cpu-percent"
    );

    Ok(SampledHostLoadGate {
        max_load_per_logical_cpu,
        max_top_cpu_percent,
        max_sample_attempts,
        pre_sample_wait_timeout,
        pre_sample_poll_interval,
    })
}

fn wait_for_sample_host_load_gate(gate: &SampledHostLoadGate) -> Option<SampledHostLoadWaitReport> {
    if !gate.is_enabled() {
        return None;
    }
    let timeout = gate.pre_sample_wait_timeout?;
    let started = Instant::now();
    let mut checks = 0usize;

    loop {
        checks += 1;
        let host_load = capture_host_load_report();
        let satisfied = host_load_report_reject_reason(host_load.as_ref(), gate).is_none();
        if satisfied {
            return Some(SampledHostLoadWaitReport {
                waited_ms: started.elapsed().as_millis(),
                checks,
                satisfied: true,
                host_load,
            });
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Some(SampledHostLoadWaitReport {
                waited_ms: elapsed.as_millis(),
                checks,
                satisfied: false,
                host_load,
            });
        }

        std::thread::sleep(gate.pre_sample_poll_interval.min(timeout - elapsed));
    }
}

fn host_load_report_reject_reason(
    host_load: Option<&HostLoadReport>,
    gate: &SampledHostLoadGate,
) -> Option<String> {
    if !gate.is_enabled() {
        return None;
    }
    let Some(host_load) = host_load else {
        return Some("missing hostLoad report".to_owned());
    };
    if let Some(max_load) = gate.max_load_per_logical_cpu {
        let Some(load) = host_load.load_per_logical_cpu_1m else {
            return Some("missing hostLoad.loadPerLogicalCpu1m".to_owned());
        };
        if load > max_load {
            return Some(format!(
                "host load per logical CPU {load:.3} exceeded gate {max_load:.3}"
            ));
        }
    }
    if let Some(max_top_cpu_percent) = gate.max_top_cpu_percent {
        let top_cpu_percent = host_load
            .top_cpu_processes
            .iter()
            .map(|process| process.cpu_percent)
            .fold(0.0, f64::max);
        if top_cpu_percent > max_top_cpu_percent {
            return Some(format!(
                "top process CPU {top_cpu_percent:.1}% exceeded gate {max_top_cpu_percent:.1}%"
            ));
        }
    }
    None
}

fn host_load_value(host_load: Option<&HostLoadReport>) -> Option<serde_json::Value> {
    host_load.and_then(|report| serde_json::to_value(report).ok())
}

fn skip_sampled_host_load_gate_arg(arg: &str, args: &[String], cursor: &mut usize) -> Result<bool> {
    if matches!(
        arg,
        "--max-load-per-cpu"
            | "--max-load-per-logical-cpu"
            | "--max-top-cpu-percent"
            | "--max-sample-attempts"
            | "--max-sample-spread-ratio"
            | "--max-sample-elapsed-spread-ratio"
            | "--load-gate-wait-ms"
            | "--host-load-wait-ms"
            | "--load-gate-poll-ms"
            | "--host-load-poll-ms"
    ) {
        *cursor += 1;
        ensure!(args.get(*cursor).is_some(), "{arg} requires a value");
        return Ok(true);
    }
    Ok(arg.starts_with("--max-load-per-cpu=")
        || arg.starts_with("--max-load-per-logical-cpu=")
        || arg.starts_with("--max-top-cpu-percent=")
        || arg.starts_with("--max-sample-attempts=")
        || arg.starts_with("--max-sample-spread-ratio=")
        || arg.starts_with("--max-sample-elapsed-spread-ratio=")
        || arg.starts_with("--load-gate-wait-ms=")
        || arg.starts_with("--host-load-wait-ms=")
        || arg.starts_with("--load-gate-poll-ms=")
        || arg.starts_with("--host-load-poll-ms="))
}

fn host_load_reject_reason(
    host_load: Option<&serde_json::Value>,
    gate: &SampledHostLoadGate,
) -> Option<String> {
    if !gate.is_enabled() {
        return None;
    }
    let Some(host_load) = host_load else {
        return Some("missing hostLoad report".to_owned());
    };
    if let Some(max_load) = gate.max_load_per_logical_cpu {
        let Some(load) = host_load
            .get("loadPerLogicalCpu1m")
            .and_then(serde_json::Value::as_f64)
        else {
            return Some("missing hostLoad.loadPerLogicalCpu1m".to_owned());
        };
        if load > max_load {
            return Some(format!(
                "host load per logical CPU {load:.3} exceeded gate {max_load:.3}"
            ));
        }
    }
    if let Some(max_top_cpu_percent) = gate.max_top_cpu_percent {
        let top_cpu_percent = host_load
            .get("topCpuProcesses")
            .and_then(serde_json::Value::as_array)
            .map(|processes| {
                processes
                    .iter()
                    .filter_map(|process| process.get("cpuPercent"))
                    .filter_map(serde_json::Value::as_f64)
                    .fold(0.0, f64::max)
            })
            .unwrap_or(0.0);
        if top_cpu_percent > max_top_cpu_percent {
            return Some(format!(
                "top process CPU {top_cpu_percent:.1}% exceeded gate {max_top_cpu_percent:.1}%"
            ));
        }
    }
    None
}

fn perf_prepared_updates_sampled(args: &[String], sample_count: usize) -> Result<()> {
    ensure!(
        !args
            .iter()
            .any(|arg| arg == "--profile" || arg.starts_with("--profile-dir")),
        "--samples cannot be combined with prepared-update CPU profiling"
    );
    let host_load_gate = sampled_host_load_gate_arg(args, sample_count)?;
    let stability_gate = sampled_stability_gate_arg(args)?;
    let max_attempts = if host_load_gate.is_enabled() {
        host_load_gate.max_attempts(sample_count)
    } else {
        sample_count
    };
    let child_args = prepared_update_args_without_samples(args);
    let mut reports = Vec::with_capacity(sample_count);
    let mut samples = Vec::with_capacity(sample_count);
    let mut discarded_samples = Vec::new();
    let mut attempt_index = 0usize;
    while reports.len() < sample_count && attempt_index < max_attempts {
        attempt_index += 1;
        let pre_sample_wait = wait_for_sample_host_load_gate(&host_load_gate);
        if pre_sample_wait.as_ref().is_some_and(|wait| !wait.satisfied) {
            let host_load = host_load_value(
                pre_sample_wait
                    .as_ref()
                    .and_then(|wait| wait.host_load.as_ref()),
            );
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason: "pre-sample host load wait timed out".to_owned(),
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
            .arg("perf")
            .arg("prepared-updates")
            .args(&child_args)
            .output()
            .with_context(|| format!("run prepared-update sample attempt {attempt_index}"))?;
        if !output.status.success() {
            bail!(
                "prepared-update sample attempt {attempt_index} failed with {}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let report: serde_json::Value =
            serde_json::from_slice(&output.stdout).with_context(|| {
                format!("parse prepared-update sample attempt {attempt_index} JSON")
            })?;
        let sqlx_native_comparison = report.get("sqlxNativeComparison").cloned();
        let host_load = report.get("hostLoad").cloned();
        if let Some(reject_reason) = host_load_reject_reason(host_load.as_ref(), &host_load_gate) {
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason,
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let sample_index = reports.len() + 1;
        samples.push(PreparedUpdateSampleSummary {
            sample_index,
            attempt_index,
            pre_sample_wait,
            host_load,
            sqlx_native_comparison,
        });
        reports.push(report);
    }
    if reports.len() != sample_count {
        let first = reports.first();
        let run_summaries = summarize_prepared_update_sampled_runs(&reports);
        let sample_stability = summarize_sample_stability(&run_summaries, &stability_gate);
        let report = PreparedUpdateSampledReport {
            source_model: "Repeated perf prepared-updates runs for p50/p90 SQLx parity measurement.",
            measurement_model: "Each sample is a full perf prepared-updates invocation with fresh PGlite server-core and native PostgreSQL controls. Summary percentiles are computed across per-sample elapsed timings, so use --only-sqlx for fast candidate/control p90 iteration.",
            completed: false,
            sample_count,
            accepted_sample_count: reports.len(),
            attempt_count: attempt_index,
            discarded_sample_count: discarded_samples.len(),
            host_load_gate: host_load_gate.report(sample_count),
            host_load: capture_host_load_report(),
            rows: first
                .and_then(|report| report.get("rows"))
                .and_then(serde_json::Value::as_u64),
            passes: first
                .and_then(|report| report.get("passes"))
                .and_then(serde_json::Value::as_u64),
            setup_variant: first.and_then(|report| report.get("setupVariant")).cloned(),
            runtime: first.and_then(|report| report.get("runtime")).cloned(),
            sqlx_native_summary: summarize_prepared_update_sampled_comparisons(&reports),
            prepared_read_roundtrip_decomposition: None,
            sample_stability,
            run_summaries,
            samples,
            discarded_samples,
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
        bail!(
            "accepted only {} clean prepared-update samples after {attempt_index} attempts; requested {sample_count}",
            reports.len()
        );
    }

    let first = reports
        .first()
        .ok_or_else(|| anyhow!("prepared-update sampled run produced no reports"))?;
    let run_summaries = summarize_prepared_update_sampled_runs(&reports);
    let sample_stability = summarize_sample_stability(&run_summaries, &stability_gate);
    let stability_reject_reason = sample_stability_reject_reason(sample_stability.as_ref());
    let report = PreparedUpdateSampledReport {
        source_model: "Repeated perf prepared-updates runs for p50/p90 SQLx parity measurement.",
        measurement_model: "Each sample is a full perf prepared-updates invocation with fresh PGlite server-core and native PostgreSQL controls. Summary percentiles are computed across per-sample elapsed timings, so use --only-sqlx for fast candidate/control p90 iteration.",
        completed: stability_reject_reason.is_none(),
        sample_count,
        accepted_sample_count: reports.len(),
        attempt_count: attempt_index,
        discarded_sample_count: discarded_samples.len(),
        host_load_gate: host_load_gate.report(sample_count),
        host_load: capture_host_load_report(),
        rows: first.get("rows").and_then(serde_json::Value::as_u64),
        passes: first.get("passes").and_then(serde_json::Value::as_u64),
        setup_variant: first.get("setupVariant").cloned(),
        runtime: first.get("runtime").cloned(),
        sqlx_native_summary: summarize_prepared_update_sampled_comparisons(&reports),
        prepared_read_roundtrip_decomposition: None,
        sample_stability,
        run_summaries,
        samples,
        discarded_samples,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    if let Some(reason) = stability_reject_reason {
        bail!(reason);
    }
    Ok(())
}

fn summarize_prepared_update_sampled_comparisons(
    reports: &[serde_json::Value],
) -> Option<PreparedUpdateSampledComparisonSummary> {
    let first_comparison = reports.first()?.get("sqlxNativeComparison")?;
    let candidate_mode = first_comparison.get("candidateMode")?.as_str()?.to_owned();
    let baseline_mode = first_comparison.get("baselineMode")?.as_str()?.to_owned();
    let mut tests = BTreeMap::<String, PreparedUpdateSampledTestAccumulator>::new();
    for report in reports {
        let comparison = report.get("sqlxNativeComparison")?;
        for test in comparison.get("tests")?.as_array()? {
            let id = test.get("id")?.as_str()?.to_owned();
            let entry =
                tests
                    .entry(id.clone())
                    .or_insert_with(|| PreparedUpdateSampledTestAccumulator {
                        id,
                        label: test
                            .get("label")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        candidate_elapsed_micros_samples: Vec::new(),
                        baseline_elapsed_micros_samples: Vec::new(),
                        elapsed_ratio_samples: Vec::new(),
                    });
            entry
                .candidate_elapsed_micros_samples
                .push(u128::from(test.get("candidateElapsedMicros")?.as_u64()?));
            entry
                .baseline_elapsed_micros_samples
                .push(u128::from(test.get("baselineElapsedMicros")?.as_u64()?));
            entry
                .elapsed_ratio_samples
                .push(test.get("elapsedRatio")?.as_f64()?);
        }
    }

    Some(PreparedUpdateSampledComparisonSummary {
        candidate_mode,
        baseline_mode,
        tests: tests
            .into_values()
            .map(PreparedUpdateSampledTestAccumulator::finish)
            .collect(),
    })
}

fn summarize_prepared_update_sampled_runs(
    reports: &[serde_json::Value],
) -> Vec<PreparedUpdateSampledRunSummary> {
    let mut tests = BTreeMap::<(String, String), PreparedUpdateSampledRunTestAccumulator>::new();
    for report in reports {
        let Some(runs) = report.get("runs").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for run in runs {
            let Some(mode) = run.get("mode").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Some(run_tests) = run.get("tests").and_then(serde_json::Value::as_array) else {
                continue;
            };
            for test in run_tests {
                let Some(id) = test.get("id").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let Some(elapsed_micros) = test
                    .get("elapsedMicros")
                    .and_then(serde_json::Value::as_u64)
                else {
                    continue;
                };
                let key = (mode.to_owned(), id.to_owned());
                let entry =
                    tests
                        .entry(key)
                        .or_insert_with(|| PreparedUpdateSampledRunTestAccumulator {
                            mode: mode.to_owned(),
                            id: id.to_owned(),
                            label: test
                                .get("label")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            operation_count_samples: Vec::new(),
                            elapsed_micros_samples: Vec::new(),
                        });
                if let Some(operation_count) = test
                    .get("operationCount")
                    .and_then(serde_json::Value::as_u64)
                {
                    entry.operation_count_samples.push(operation_count);
                }
                entry
                    .elapsed_micros_samples
                    .push(u128::from(elapsed_micros));
            }
        }
    }

    let mut by_mode = BTreeMap::<String, Vec<PreparedUpdateSampledRunTestSummary>>::new();
    for test in tests.into_values() {
        let mode = test.mode.clone();
        by_mode.entry(mode).or_default().push(test.finish());
    }
    by_mode
        .into_iter()
        .map(|(mode, tests)| PreparedUpdateSampledRunSummary { mode, tests })
        .collect()
}

fn summarize_prepared_read_roundtrip_decomposition(
    reports: &[serde_json::Value],
) -> Option<PreparedReadRoundtripDecomposition> {
    let run_summaries = summarize_prepared_update_sampled_runs(reports);
    let sqlx_server = sampled_run_summary(&run_summaries, "pglite_server_sqlx")?;
    let mut tests = Vec::new();

    for sqlx_server_test in &sqlx_server.tests {
        let id = sqlx_server_test.id.as_str();
        let sqlx_native = sampled_run_test(&run_summaries, "native_postgres_sqlx", id)?;
        let pipelined_server = sampled_run_test(
            &run_summaries,
            "pglite_server_tcp_tokio_postgres_pipelined_prepared",
            id,
        )?;
        let pipelined_native = sampled_run_test(
            &run_summaries,
            "native_tokio_postgres_pipelined_prepared",
            id,
        )?;
        let operation_count = sqlx_server_test.operation_count?;

        let sqlx_server_p50 = sqlx_server_test.p50_average_micros?;
        let sqlx_native_p50 = sqlx_native.p50_average_micros?;
        let pipelined_server_p50 = pipelined_server.p50_average_micros?;
        let pipelined_native_p50 = pipelined_native.p50_average_micros?;
        let sqlx_server_p90 = sqlx_server_test.p90_average_micros?;
        let sqlx_native_p90 = sqlx_native.p90_average_micros?;
        let pipelined_server_p90 = pipelined_server.p90_average_micros?;
        let pipelined_native_p90 = pipelined_native.p90_average_micros?;

        let sqlx_gap_p50 = sqlx_server_p50 - sqlx_native_p50;
        let pipelined_gap_p50 = pipelined_server_p50 - pipelined_native_p50;
        let sqlx_gap_p90 = sqlx_server_p90 - sqlx_native_p90;
        let pipelined_gap_p90 = pipelined_server_p90 - pipelined_native_p90;

        tests.push(PreparedReadRoundtripDecompositionTest {
            id: sqlx_server_test.id.clone(),
            label: sqlx_server_test.label.clone(),
            operation_count,
            sqlx_server_p50_micros_per_op: sqlx_server_p50,
            sqlx_native_p50_micros_per_op: sqlx_native_p50,
            pipelined_server_p50_micros_per_op: pipelined_server_p50,
            pipelined_native_p50_micros_per_op: pipelined_native_p50,
            sqlx_gap_p50_micros_per_op: sqlx_gap_p50,
            pipelined_gap_p50_micros_per_op: pipelined_gap_p50,
            inferred_roundtrip_gap_p50_micros_per_op: sqlx_gap_p50 - pipelined_gap_p50,
            server_sqlx_over_pipelined_p50_micros_per_op: sqlx_server_p50 - pipelined_server_p50,
            native_sqlx_over_pipelined_p50_micros_per_op: sqlx_native_p50 - pipelined_native_p50,
            sqlx_server_p90_micros_per_op: sqlx_server_p90,
            sqlx_native_p90_micros_per_op: sqlx_native_p90,
            pipelined_server_p90_micros_per_op: pipelined_server_p90,
            pipelined_native_p90_micros_per_op: pipelined_native_p90,
            sqlx_gap_p90_micros_per_op: sqlx_gap_p90,
            pipelined_gap_p90_micros_per_op: pipelined_gap_p90,
            inferred_roundtrip_gap_p90_micros_per_op: sqlx_gap_p90 - pipelined_gap_p90,
            server_sqlx_over_pipelined_p90_micros_per_op: sqlx_server_p90 - pipelined_server_p90,
            native_sqlx_over_pipelined_p90_micros_per_op: sqlx_native_p90 - pipelined_native_p90,
        });
    }

    (!tests.is_empty()).then_some(PreparedReadRoundtripDecomposition {
        source_model: "prepared-reads sampled client-mode decomposition",
        measurement_model: "Compares SQLx p50/p90 per-operation latency with tokio-postgres pipelined prepared latency for the same read cases. The pipelined server/native gap estimates backend execution/protocol work when client roundtrips are mostly collapsed; subtracting that from the SQLx server/native gap estimates per-roundtrip host/guest scheduling overhead.",
        tests,
    })
}

fn sampled_run_summary<'a>(
    summaries: &'a [PreparedUpdateSampledRunSummary],
    mode: &str,
) -> Option<&'a PreparedUpdateSampledRunSummary> {
    summaries.iter().find(|summary| summary.mode == mode)
}

fn sampled_run_test<'a>(
    summaries: &'a [PreparedUpdateSampledRunSummary],
    mode: &str,
    id: &str,
) -> Option<&'a PreparedUpdateSampledRunTestSummary> {
    sampled_run_summary(summaries, mode)?
        .tests
        .iter()
        .find(|test| test.id == id)
}

struct PreparedUpdateSampledTestAccumulator {
    id: String,
    label: String,
    candidate_elapsed_micros_samples: Vec<u128>,
    baseline_elapsed_micros_samples: Vec<u128>,
    elapsed_ratio_samples: Vec<f64>,
}

impl PreparedUpdateSampledTestAccumulator {
    fn finish(self) -> PreparedUpdateSampledTestSummary {
        let candidate_p50_micros = percentile_values(&self.candidate_elapsed_micros_samples, 0.50);
        let candidate_p90_micros = percentile_values(&self.candidate_elapsed_micros_samples, 0.90);
        let baseline_p50_micros = percentile_values(&self.baseline_elapsed_micros_samples, 0.50);
        let baseline_p90_micros = percentile_values(&self.baseline_elapsed_micros_samples, 0.90);
        PreparedUpdateSampledTestSummary {
            id: self.id,
            label: self.label,
            sample_count: self.candidate_elapsed_micros_samples.len(),
            candidate_elapsed_micros_samples: self.candidate_elapsed_micros_samples,
            baseline_elapsed_micros_samples: self.baseline_elapsed_micros_samples,
            elapsed_ratio_samples: self.elapsed_ratio_samples,
            candidate_p50_micros,
            candidate_p90_micros,
            baseline_p50_micros,
            baseline_p90_micros,
            p50_ratio: micros_ratio(candidate_p50_micros, baseline_p50_micros),
            p90_ratio: micros_ratio(candidate_p90_micros, baseline_p90_micros),
        }
    }
}

struct PreparedUpdateSampledRunTestAccumulator {
    mode: String,
    id: String,
    label: String,
    operation_count_samples: Vec<u64>,
    elapsed_micros_samples: Vec<u128>,
}

impl PreparedUpdateSampledRunTestAccumulator {
    fn finish(self) -> PreparedUpdateSampledRunTestSummary {
        let p50_micros = percentile_values(&self.elapsed_micros_samples, 0.50);
        let p90_micros = percentile_values(&self.elapsed_micros_samples, 0.90);
        let min_micros = self.elapsed_micros_samples.iter().copied().min();
        let max_micros = self.elapsed_micros_samples.iter().copied().max();
        let operation_count = stable_operation_count(&self.operation_count_samples);
        let p50_average_micros =
            operation_count.and_then(|count| p50_micros.map(|micros| micros as f64 / count as f64));
        let p90_average_micros =
            operation_count.and_then(|count| p90_micros.map(|micros| micros as f64 / count as f64));
        let max_to_min_ratio = micros_ratio(max_micros, min_micros);
        let p90_to_p50_ratio = micros_ratio(p90_micros, p50_micros);
        PreparedUpdateSampledRunTestSummary {
            id: self.id,
            label: self.label,
            sample_count: self.elapsed_micros_samples.len(),
            operation_count,
            elapsed_micros_samples: self.elapsed_micros_samples,
            p50_micros,
            p90_micros,
            min_micros,
            max_micros,
            max_to_min_ratio,
            p90_to_p50_ratio,
            p50_average_micros,
            p90_average_micros,
        }
    }
}

fn summarize_sample_stability(
    run_summaries: &[PreparedUpdateSampledRunSummary],
    gate: &SampledStabilityGate,
) -> Option<PreparedSampleStabilityReport> {
    if run_summaries.is_empty() {
        return None;
    }

    let mut worst_elapsed_spread_ratio = None::<f64>;
    let mut violations = Vec::new();
    for summary in run_summaries {
        for test in &summary.tests {
            let Some(elapsed_spread_ratio) = test.max_to_min_ratio else {
                continue;
            };
            worst_elapsed_spread_ratio = Some(
                worst_elapsed_spread_ratio
                    .map(|worst| worst.max(elapsed_spread_ratio))
                    .unwrap_or(elapsed_spread_ratio),
            );
            if let Some(max_elapsed_spread_ratio) = gate.max_elapsed_spread_ratio
                && elapsed_spread_ratio > max_elapsed_spread_ratio
            {
                violations.push(PreparedSampleStabilityViolation {
                    mode: summary.mode.clone(),
                    id: test.id.clone(),
                    label: test.label.clone(),
                    sample_count: test.sample_count,
                    elapsed_micros_samples: test.elapsed_micros_samples.clone(),
                    elapsed_spread_ratio,
                    max_elapsed_spread_ratio,
                });
            }
        }
    }

    Some(PreparedSampleStabilityReport {
        max_elapsed_spread_ratio_gate: gate.max_elapsed_spread_ratio,
        stable: violations.is_empty(),
        worst_elapsed_spread_ratio,
        violations,
    })
}

fn sample_stability_reject_reason(
    sample_stability: Option<&PreparedSampleStabilityReport>,
) -> Option<String> {
    let sample_stability = sample_stability?;
    if sample_stability.stable {
        return None;
    }
    Some(format!(
        "sample stability gate rejected run: worst elapsed spread ratio {:.3} exceeded gate {:.3}",
        sample_stability
            .worst_elapsed_spread_ratio
            .unwrap_or_default(),
        sample_stability
            .max_elapsed_spread_ratio_gate
            .unwrap_or_default()
    ))
}

fn stable_operation_count(samples: &[u64]) -> Option<u64> {
    let first = *samples.first()?;
    samples
        .iter()
        .all(|sample| *sample == first)
        .then_some(first)
}

fn perf_prepared_reads_sampled(args: &[String], sample_count: usize) -> Result<()> {
    let host_load_gate = sampled_host_load_gate_arg(args, sample_count)?;
    let stability_gate = sampled_stability_gate_arg(args)?;
    let max_attempts = if host_load_gate.is_enabled() {
        host_load_gate.max_attempts(sample_count)
    } else {
        sample_count
    };
    let child_args = prepared_update_args_without_samples(args);
    let mut reports = Vec::with_capacity(sample_count);
    let mut samples = Vec::with_capacity(sample_count);
    let mut discarded_samples = Vec::new();
    let mut attempt_index = 0usize;
    while reports.len() < sample_count && attempt_index < max_attempts {
        attempt_index += 1;
        let pre_sample_wait = wait_for_sample_host_load_gate(&host_load_gate);
        if pre_sample_wait.as_ref().is_some_and(|wait| !wait.satisfied) {
            let host_load = host_load_value(
                pre_sample_wait
                    .as_ref()
                    .and_then(|wait| wait.host_load.as_ref()),
            );
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason: "pre-sample host load wait timed out".to_owned(),
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
            .arg("perf")
            .arg("prepared-reads")
            .args(&child_args)
            .output()
            .with_context(|| format!("run prepared-read sample attempt {attempt_index}"))?;
        if !output.status.success() {
            bail!(
                "prepared-read sample attempt {attempt_index} failed with {}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let report: serde_json::Value = serde_json::from_slice(&output.stdout)
            .with_context(|| format!("parse prepared-read sample attempt {attempt_index} JSON"))?;
        let sqlx_native_comparison = report.get("sqlxNativeComparison").cloned();
        let host_load = report.get("hostLoad").cloned();
        if let Some(reject_reason) = host_load_reject_reason(host_load.as_ref(), &host_load_gate) {
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason,
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let sample_index = reports.len() + 1;
        samples.push(PreparedUpdateSampleSummary {
            sample_index,
            attempt_index,
            pre_sample_wait,
            host_load,
            sqlx_native_comparison,
        });
        reports.push(report);
    }
    if reports.len() != sample_count {
        let first = reports.first();
        let run_summaries = summarize_prepared_update_sampled_runs(&reports);
        let sample_stability = summarize_sample_stability(&run_summaries, &stability_gate);
        let report = PreparedUpdateSampledReport {
            source_model: "Repeated perf prepared-reads runs for p50/p90 SQLx indexed-read parity measurement.",
            measurement_model: "Each sample is a full perf prepared-reads invocation with fresh PGlite server-core and native PostgreSQL controls. Summary percentiles are computed across per-sample elapsed timings.",
            completed: false,
            sample_count,
            accepted_sample_count: reports.len(),
            attempt_count: attempt_index,
            discarded_sample_count: discarded_samples.len(),
            host_load_gate: host_load_gate.report(sample_count),
            host_load: capture_host_load_report(),
            rows: first
                .and_then(|report| report.get("rows"))
                .and_then(serde_json::Value::as_u64),
            passes: first
                .and_then(|report| report.get("passes"))
                .and_then(serde_json::Value::as_u64),
            setup_variant: first.and_then(|report| report.get("setupVariant")).cloned(),
            runtime: first.and_then(|report| report.get("runtime")).cloned(),
            sqlx_native_summary: summarize_prepared_update_sampled_comparisons(&reports),
            prepared_read_roundtrip_decomposition: summarize_prepared_read_roundtrip_decomposition(
                &reports,
            ),
            sample_stability,
            run_summaries,
            samples,
            discarded_samples,
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
        bail!(
            "accepted only {} clean prepared-read samples after {attempt_index} attempts; requested {sample_count}",
            reports.len()
        );
    }

    let first = reports
        .first()
        .ok_or_else(|| anyhow!("prepared-read sampled run produced no reports"))?;
    let run_summaries = summarize_prepared_update_sampled_runs(&reports);
    let sample_stability = summarize_sample_stability(&run_summaries, &stability_gate);
    let stability_reject_reason = sample_stability_reject_reason(sample_stability.as_ref());
    let report = PreparedUpdateSampledReport {
        source_model: "Repeated perf prepared-reads runs for p50/p90 SQLx indexed-read parity measurement.",
        measurement_model: "Each sample is a full perf prepared-reads invocation with fresh PGlite server-core and native PostgreSQL controls. Summary percentiles are computed across per-sample elapsed timings.",
        completed: stability_reject_reason.is_none(),
        sample_count,
        accepted_sample_count: reports.len(),
        attempt_count: attempt_index,
        discarded_sample_count: discarded_samples.len(),
        host_load_gate: host_load_gate.report(sample_count),
        host_load: capture_host_load_report(),
        rows: first.get("rows").and_then(serde_json::Value::as_u64),
        passes: first.get("passes").and_then(serde_json::Value::as_u64),
        setup_variant: first.get("setupVariant").cloned(),
        runtime: first.get("runtime").cloned(),
        sqlx_native_summary: summarize_prepared_update_sampled_comparisons(&reports),
        prepared_read_roundtrip_decomposition: summarize_prepared_read_roundtrip_decomposition(
            &reports,
        ),
        sample_stability,
        run_summaries,
        samples,
        discarded_samples,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    if let Some(reason) = stability_reject_reason {
        bail!(reason);
    }
    Ok(())
}

fn perf_prepared_reads_with_wasix_perf_stats(
    args: &[String],
    options: WasixPerfStatsOptions,
) -> Result<()> {
    prepare_wasix_perf_stats_outputs(&options)?;
    let child_args = prepared_read_args_without_wasix_perf_stats(args)?;
    let mut command = Command::new(env::current_exe().context("resolve current xtask executable")?);
    command
        .arg("perf")
        .arg("prepared-reads")
        .args(&child_args)
        .env("WASIX_PERF_STATS", "1")
        .env("WASIX_PERF_STATS_FILE", &options.log);
    if let Some(wasmer_bin) = options.wasmer_bin.as_ref() {
        command.env("PGLITE_OXIDE_WASMER_BIN", wasmer_bin);
    }
    let output = command
        .output()
        .context("run prepared-reads with WASIX perf stats")?;
    if !output.status.success() {
        bail!(
            "prepared-reads with WASIX perf stats failed with {}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut report: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("parse prepared-reads JSON")?;
    summarize_wasix_perf_stats(&options.log, &options.summary_prefix)?;
    let object = report
        .as_object_mut()
        .ok_or_else(|| anyhow!("prepared-reads JSON report was not an object"))?;
    object.insert(
        "wasixPerfStats".to_owned(),
        wasix_perf_stats_report(&options),
    );
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_prepared_inserts_sampled(args: &[String], sample_count: usize) -> Result<()> {
    ensure!(
        !args
            .iter()
            .any(|arg| arg == "--profile" || arg.starts_with("--profile-dir")),
        "--samples cannot be combined with prepared-insert CPU profiling"
    );
    let host_load_gate = sampled_host_load_gate_arg(args, sample_count)?;
    let stability_gate = sampled_stability_gate_arg(args)?;
    let max_attempts = if host_load_gate.is_enabled() {
        host_load_gate.max_attempts(sample_count)
    } else {
        sample_count
    };
    let child_args = prepared_update_args_without_samples(args);
    let mut reports = Vec::with_capacity(sample_count);
    let mut samples = Vec::with_capacity(sample_count);
    let mut discarded_samples = Vec::new();
    let mut attempt_index = 0usize;
    while reports.len() < sample_count && attempt_index < max_attempts {
        attempt_index += 1;
        let pre_sample_wait = wait_for_sample_host_load_gate(&host_load_gate);
        if pre_sample_wait.as_ref().is_some_and(|wait| !wait.satisfied) {
            let host_load = host_load_value(
                pre_sample_wait
                    .as_ref()
                    .and_then(|wait| wait.host_load.as_ref()),
            );
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason: "pre-sample host load wait timed out".to_owned(),
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let output = Command::new(env::current_exe().context("resolve current xtask executable")?)
            .arg("perf")
            .arg("prepared-inserts")
            .args(&child_args)
            .output()
            .with_context(|| format!("run prepared-insert sample attempt {attempt_index}"))?;
        if !output.status.success() {
            bail!(
                "prepared-insert sample attempt {attempt_index} failed with {}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let report: serde_json::Value =
            serde_json::from_slice(&output.stdout).with_context(|| {
                format!("parse prepared-insert sample attempt {attempt_index} JSON")
            })?;
        let sqlx_native_comparison = report.get("sqlxNativeComparison").cloned();
        let host_load = report.get("hostLoad").cloned();
        if let Some(reject_reason) = host_load_reject_reason(host_load.as_ref(), &host_load_gate) {
            discarded_samples.push(PreparedUpdateDiscardedSampleSummary {
                attempt_index,
                reject_reason,
                pre_sample_wait,
                host_load,
            });
            continue;
        }
        let sample_index = reports.len() + 1;
        samples.push(PreparedUpdateSampleSummary {
            sample_index,
            attempt_index,
            pre_sample_wait,
            host_load,
            sqlx_native_comparison,
        });
        reports.push(report);
    }

    let first = reports.first();
    let run_summaries = summarize_prepared_update_sampled_runs(&reports);
    let sample_stability = summarize_sample_stability(&run_summaries, &stability_gate);
    let stability_reject_reason = sample_stability_reject_reason(sample_stability.as_ref());
    let completed = reports.len() == sample_count && stability_reject_reason.is_none();
    let report = PreparedUpdateSampledReport {
        source_model: "Repeated perf prepared-inserts runs for p50/p90 SQLx insert-shape parity measurement.",
        measurement_model: "Each sample is a full perf prepared-inserts invocation with fresh PG18 WASIX PgliteServer and native PostgreSQL controls. Shapes compare exact literal speedtest INSERT SQL, one multi-values INSERT, a single SQL batch using server-side PREPARE/EXECUTE, and SQLx parameterized inserts inside one transaction.",
        completed,
        sample_count,
        accepted_sample_count: reports.len(),
        attempt_count: attempt_index,
        discarded_sample_count: discarded_samples.len(),
        host_load_gate: host_load_gate.report(sample_count),
        host_load: capture_host_load_report(),
        rows: first
            .and_then(|report| report.get("rows"))
            .and_then(serde_json::Value::as_u64),
        passes: first
            .and_then(|report| report.get("passes"))
            .and_then(serde_json::Value::as_u64),
        setup_variant: first.and_then(|report| report.get("setupVariant")).cloned(),
        runtime: first.and_then(|report| report.get("runtime")).cloned(),
        sqlx_native_summary: summarize_prepared_update_sampled_comparisons(&reports),
        prepared_read_roundtrip_decomposition: None,
        sample_stability,
        run_summaries,
        samples,
        discarded_samples,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    ensure!(
        completed,
        "accepted only {} clean prepared-insert samples after {attempt_index} attempts; requested {sample_count}",
        reports.len()
    );
    if let Some(reason) = stability_reject_reason {
        bail!(reason);
    }
    Ok(())
}

fn perf_prepared_inserts(args: &[String]) -> Result<()> {
    let sample_count = prepared_update_sample_count_arg(args)?;
    if sample_count > 1 {
        return perf_prepared_inserts_sampled(args, sample_count);
    }

    let mut rows = 25_000usize;
    let mut skip_native = false;
    let mut selected_ids: Option<HashSet<String>> = None;
    let mut runtime_set: Option<WasmerRuntimeConfigSetInput> = None;
    let mut profile_dir: Option<PathBuf> = None;
    let mut profile_seconds = 8u64;
    let mut profile_delay = Duration::from_millis(100);
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = args[cursor].clone();
        match arg.as_str() {
            "--skip-native" => {
                skip_native = true;
            }
            "--only-sqlx" | "--sqlx-only" => {}
            "--profile" => {
                profile_dir = Some(Path::new("target/perf").join(format!(
                    "prepared-inserts-profile-{}",
                    now_micros().unwrap_or(0)
                )));
            }
            "--profile-dir" | "--profile-output-dir" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
                profile_dir = Some(PathBuf::from(value));
            }
            "--profile-seconds" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-seconds requires a value"))?;
                profile_seconds = value
                    .parse()
                    .with_context(|| format!("parse --profile-seconds value {value:?}"))?;
                ensure!(
                    profile_seconds > 0,
                    "--profile-seconds must be greater than zero"
                );
            }
            "--profile-delay-ms" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-delay-ms requires a value"))?;
                profile_delay = Duration::from_millis(
                    value
                        .parse()
                        .with_context(|| format!("parse --profile-delay-ms value {value:?}"))?,
                );
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
            }
            "--ids" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--ids requires a value"))?;
                selected_ids = Some(parse_speed_case_ids(value)?.into_iter().collect());
            }
            "--samples" | "--sample-count" => {
                cursor += 1;
                args.get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
            }
            "--runtime-set" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--runtime-set requires a value"))?;
                runtime_set = Some(named_wasmer_runtime_config_set(value)?);
            }
            arg if arg.starts_with("--samples=") || arg.starts_with("--sample-count=") => {}
            arg if arg.starts_with("--ids=") => {
                let value = arg.strip_prefix("--ids=").expect("prefix checked above");
                selected_ids = Some(parse_speed_case_ids(value)?.into_iter().collect());
            }
            arg if arg.starts_with("--runtime-set=") => {
                let value = arg
                    .strip_prefix("--runtime-set=")
                    .expect("prefix checked above");
                runtime_set = Some(named_wasmer_runtime_config_set(value)?);
            }
            other => bail!("unknown perf prepared-inserts flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows must be greater than zero");
    validate_prepared_insert_selection(selected_ids.as_ref())?;

    let profile_options = profile_dir.map(|output_dir| PreparedUpdateProfileOptions {
        output_dir,
        seconds: profile_seconds,
        delay: profile_delay,
    });
    let runtime_config = runtime_set
        .as_ref()
        .and_then(WasmerRuntimeConfigSetInput::runtime_config);
    let using_server_core_assets = using_wasix_postgres_server_core_assets()?;
    if !using_server_core_assets {
        Pglite::preload()?;
    }
    let rows_data = prepared_insert_rows(rows, 0)?;

    let mut runs = vec![pglite_prepared_update_run(
        "pglite_server_sqlx",
        "PgliteServer over TCP using SQLx insert diagnostics.",
        || {
            run_pglite_sqlx_prepared_insert_tests(
                &rows_data,
                selected_ids.as_ref(),
                runtime_config.as_ref(),
                profile_options.as_ref(),
            )
        },
    )?];

    if !skip_native {
        let native_postgres = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("postgres"));
        let native_initdb = env::var("PGLITE_OXIDE_NATIVE_INITDB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("initdb"));
        runs.push(PreparedUpdateRun {
            mode: "native_postgres_sqlx",
            description: "Native Postgres over loopback TCP using SQLx insert diagnostics.",
            protocol_stats: None,
            tests: run_native_sqlx_prepared_insert_tests(
                &native_postgres,
                &native_initdb,
                &rows_data,
                selected_ids.as_ref(),
                profile_options.as_ref(),
            )?,
        });
    }

    annotate_prepared_update_profiles(&mut runs, profile_options.as_ref())?;
    let sqlx_native_comparison =
        prepared_update_mode_comparison(&runs, "pglite_server_sqlx", "native_postgres_sqlx");

    let report = PreparedUpdateReport {
        source_model: "Generated PGlite speedtest-style insert rows with four SQLx insert shapes: exact literal transaction SQL, exact single multi-values SQL, server-side PREPARE/EXECUTE batch SQL, and SQLx parameterized row inserts.",
        measurement_model: "Each test uses a fresh database/server. Literal and multi-values cases measure the same generated SQL shape as speed cases 2 and 2.1. Server PREPARE/EXECUTE creates the table outside measurement, then measures one SQL batch with PREPARE, BEGIN, EXECUTE rows, COMMIT, and DEALLOCATE. SQLx prepared creates the table and prepares one INSERT outside measurement, then measures rows parameterized inserts inside one transaction.",
        gate_model: None,
        host_load: capture_host_load_report(),
        setup_variant: None,
        runtime: using_server_core_assets
            .then(|| benchmark_runtime_report_for_runtime_set(runtime_set.as_ref()))
            .transpose()?,
        rows,
        passes: 1,
        runs,
        sqlx_native_comparison,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_prepared_reads(args: &[String]) -> Result<()> {
    let sample_count = prepared_update_sample_count_arg(args)?;
    if let Some(options) = prepared_read_wasix_perf_stats_options(args)? {
        ensure!(
            sample_count == 1,
            "--wasix-perf-stats cannot be combined with --samples > 1"
        );
        return perf_prepared_reads_with_wasix_perf_stats(args, options);
    }
    if sample_count > 1 {
        return perf_prepared_reads_sampled(args, sample_count);
    }

    let mut rows = 5_000usize;
    let mut passes = 1usize;
    let mut skip_native = false;
    let mut setup_options = DiagnosticOptions::default();
    let mut runtime_set: Option<WasmerRuntimeConfigSetInput> = None;
    let mut profile_dir: Option<PathBuf> = None;
    let mut profile_seconds = 8u64;
    let mut profile_delay = Duration::from_millis(100);
    let mut selected_read_ids: Option<Vec<String>> = None;
    let mut selected_client_modes: Option<HashSet<String>> = None;
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = args[cursor].clone();
        if parse_diagnostic_setup_variant_arg(&arg, args, &mut cursor, &mut setup_options)? {
            cursor += 1;
            continue;
        }
        match arg.as_str() {
            "--skip-native" => {
                skip_native = true;
            }
            "--only-sqlx" | "--sqlx-only" => {
                selected_client_modes = Some(parse_prepared_read_client_modes("sqlx")?);
            }
            "--tokio-only" | "--only-tokio" => {
                selected_client_modes = Some(parse_prepared_read_client_modes("tokio")?);
            }
            "--only-tokio-sequential" => {
                selected_client_modes = Some(parse_prepared_read_client_modes("tokio-sequential")?);
            }
            "--only-tokio-pipelined" => {
                selected_client_modes = Some(parse_prepared_read_client_modes("tokio-pipelined")?);
            }
            arg if arg.starts_with("--client-modes=") || arg.starts_with("--clients=") => {
                let raw_modes = arg
                    .split_once('=')
                    .map(|(_, value)| value)
                    .expect("starts_with '=' arg contains equals");
                selected_client_modes = Some(parse_prepared_read_client_modes(raw_modes)?);
            }
            "--client-modes" | "--clients" => {
                cursor += 1;
                selected_client_modes = Some(parse_prepared_read_client_modes(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?,
                )?);
            }
            arg if arg.starts_with("--ids=") || arg.starts_with("--cases=") => {
                let raw_ids = arg
                    .split_once('=')
                    .map(|(_, value)| value)
                    .expect("starts_with '=' arg contains equals");
                selected_read_ids = Some(parse_speed_case_ids(raw_ids)?);
            }
            "--ids" | "--cases" => {
                cursor += 1;
                selected_read_ids = Some(parse_speed_case_ids(
                    args.get(cursor)
                        .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?,
                )?);
            }
            "--profile" => {
                profile_dir = Some(Path::new("target/perf").join(format!(
                    "prepared-reads-profile-{}",
                    now_micros().unwrap_or(0)
                )));
            }
            "--profile-dir" | "--profile-output-dir" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
                profile_dir = Some(PathBuf::from(value));
            }
            "--profile-seconds" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-seconds requires a value"))?;
                profile_seconds = value
                    .parse()
                    .with_context(|| format!("parse --profile-seconds value {value:?}"))?;
                ensure!(
                    profile_seconds > 0,
                    "--profile-seconds must be greater than zero"
                );
            }
            "--profile-delay-ms" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-delay-ms requires a value"))?;
                profile_delay = Duration::from_millis(
                    value
                        .parse()
                        .with_context(|| format!("parse --profile-delay-ms value {value:?}"))?,
                );
            }
            "--rows" | "--reads" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
                rows = value
                    .parse()
                    .with_context(|| format!("parse {} value {value:?}", args[cursor - 1]))?;
            }
            "--passes" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--passes requires a value"))?;
                passes = value
                    .parse()
                    .with_context(|| format!("parse --passes value {value:?}"))?;
            }
            "--samples" | "--sample-count" => {
                cursor += 1;
                args.get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
            }
            arg if arg.starts_with("--samples=") || arg.starts_with("--sample-count=") => {}
            "--runtime-set" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--runtime-set requires a value"))?;
                runtime_set = Some(named_wasmer_runtime_config_set(value)?);
            }
            other => bail!("unknown perf prepared-reads flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows/--reads must be greater than zero");
    ensure!(passes > 0, "--passes must be greater than zero");
    let profile_options = profile_dir.map(|output_dir| PreparedUpdateProfileOptions {
        output_dir,
        seconds: profile_seconds,
        delay: profile_delay,
    });
    let selected_read_ids = selected_prepared_read_case_ids(selected_read_ids)?;
    let selected_client_modes = selected_client_modes.as_ref();

    let ranges = prepared_read_ranges(rows, passes, 100)?;
    let runtime_config = runtime_set
        .as_ref()
        .and_then(WasmerRuntimeConfigSetInput::runtime_config);
    let using_server_core_assets = using_wasix_postgres_server_core_assets()?;
    if !using_server_core_assets {
        Pglite::preload()?;
    }

    let mut runs = Vec::new();
    if prepared_read_client_mode_selected(selected_client_modes, "sqlx") {
        runs.push(pglite_prepared_update_run(
            "pglite_server_sqlx",
            "PgliteServer over TCP using SQLx parameterized indexed range SELECTs and SQLx statement cache.",
            || {
                run_pglite_sqlx_prepared_read_tests(
                    &ranges,
                    &setup_options,
                    runtime_config.as_ref(),
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )
            },
        )?);
    }
    if prepared_read_client_mode_selected(selected_client_modes, "tokio-sequential") {
        runs.push(pglite_prepared_update_run(
            "pglite_server_tcp_tokio_postgres_prepared",
            "PgliteServer over TCP using tokio-postgres explicit prepared indexed range SELECTs.",
            || {
                run_pglite_tokio_prepared_read_tests(
                    &ranges,
                    &setup_options,
                    runtime_config.as_ref(),
                    PreparedExecution::Sequential,
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )
            },
        )?);
    }
    if prepared_read_client_mode_selected(selected_client_modes, "tokio-pipelined") {
        runs.push(pglite_prepared_update_run(
            "pglite_server_tcp_tokio_postgres_pipelined_prepared",
            "PgliteServer over TCP using tokio-postgres explicit prepared indexed range SELECTs with all reads pipelined inside one transaction.",
            || {
                run_pglite_tokio_prepared_read_tests(
                    &ranges,
                    &setup_options,
                    runtime_config.as_ref(),
                    PreparedExecution::Pipelined,
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )
            },
        )?);
    }

    if !skip_native {
        let native_postgres = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("postgres"));
        let native_initdb = env::var("PGLITE_OXIDE_NATIVE_INITDB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("initdb"));
        if prepared_read_client_mode_selected(selected_client_modes, "sqlx") {
            runs.push(PreparedUpdateRun {
                mode: "native_postgres_sqlx",
                description: "Native Postgres over loopback TCP using SQLx parameterized indexed range SELECTs and SQLx statement cache.",
                protocol_stats: None,
                tests: run_native_sqlx_prepared_read_tests(
                    &native_postgres,
                    &native_initdb,
                    &ranges,
                    &setup_options,
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )?,
            });
        }
        if prepared_read_client_mode_selected(selected_client_modes, "tokio-sequential") {
            runs.push(PreparedUpdateRun {
                mode: "native_tokio_postgres_prepared",
                description: "Native Postgres over loopback TCP using tokio-postgres explicit prepared indexed range SELECTs.",
                protocol_stats: None,
                tests: run_native_tokio_prepared_read_tests(
                    &native_postgres,
                    &native_initdb,
                    &ranges,
                    &setup_options,
                    PreparedExecution::Sequential,
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )?,
            });
        }
        if prepared_read_client_mode_selected(selected_client_modes, "tokio-pipelined") {
            runs.push(PreparedUpdateRun {
                mode: "native_tokio_postgres_pipelined_prepared",
                description: "Native Postgres over loopback TCP using tokio-postgres explicit prepared indexed range SELECTs with all reads pipelined inside one transaction.",
                protocol_stats: None,
                tests: run_native_tokio_prepared_read_tests(
                    &native_postgres,
                    &native_initdb,
                    &ranges,
                    &setup_options,
                    PreparedExecution::Pipelined,
                    profile_options.as_ref(),
                    selected_read_ids.as_ref(),
                )?,
            });
        }
    }

    ensure!(
        !runs.is_empty(),
        "prepared-read client mode selection produced no runs"
    );
    annotate_prepared_update_profiles(&mut runs, profile_options.as_ref())?;
    let sqlx_native_comparison =
        prepared_update_mode_comparison(&runs, "pglite_server_sqlx", "native_postgres_sqlx");
    let report = PreparedUpdateReport {
        source_model: "Exact PGlite benchmark2/benchmark6 setup plus case-7 range predicates converted to one parameterized SELECT.",
        measurement_model: "Each test uses a fresh database, creates the same indexed t2 table, prepares one parameterized SELECT count(*), avg(b) WHERE b range statement, then executes rows * passes reads inside one transaction. PGlite SQLx server runs use loopback TCP; native SQLx uses loopback TCP against a temporary native PostgreSQL cluster with the same benchmark GUCs as perf native-postgres. Unless --only-sqlx is set, tokio-postgres sequential and pipelined prepared controls run the same indexed read shape.",
        gate_model: None,
        host_load: capture_host_load_report(),
        setup_variant: diagnostic_setup_variant_report(&setup_options),
        runtime: using_server_core_assets
            .then(|| benchmark_runtime_report_for_runtime_set(runtime_set.as_ref()))
            .transpose()?,
        rows,
        passes,
        runs,
        sqlx_native_comparison,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn selected_prepared_read_case_ids(
    selected: Option<Vec<String>>,
) -> Result<Option<HashSet<String>>> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    let known = [
        "param_echo",
        "indexed_range_select",
        "indexed_range_server_prepare_batch",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    for id in &selected {
        ensure!(
            known.contains(id.as_str()),
            "unknown prepared-read case {id:?}; known cases are {}",
            known.iter().copied().collect::<Vec<_>>().join(", ")
        );
    }
    Ok(Some(selected.into_iter().collect()))
}

fn prepared_read_case_selected(selected: Option<&HashSet<String>>, id: &str) -> bool {
    selected.is_none_or(|selected| selected.contains(id))
}

fn parse_prepared_read_client_modes(raw_modes: &str) -> Result<HashSet<String>> {
    let mut modes = HashSet::new();
    for mode in raw_modes
        .split(',')
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
    {
        match mode {
            "all" => {
                modes.insert("sqlx".to_owned());
                modes.insert("tokio-sequential".to_owned());
                modes.insert("tokio-pipelined".to_owned());
            }
            "sqlx" => {
                modes.insert("sqlx".to_owned());
            }
            "tokio" | "tokio-postgres" => {
                modes.insert("tokio-sequential".to_owned());
                modes.insert("tokio-pipelined".to_owned());
            }
            "tokio-sequential" | "tokio-prepared" | "sequential" => {
                modes.insert("tokio-sequential".to_owned());
            }
            "tokio-pipelined" | "tokio-pipeline" | "pipelined" | "pipeline" => {
                modes.insert("tokio-pipelined".to_owned());
            }
            other => bail!(
                "unknown prepared-read client mode {other:?}; known modes are sqlx, tokio-sequential, tokio-pipelined, tokio, and all"
            ),
        }
    }
    ensure!(
        !modes.is_empty(),
        "--client-modes must contain at least one mode"
    );
    Ok(modes)
}

fn prepared_read_client_mode_selected(selected: Option<&HashSet<String>>, mode: &str) -> bool {
    selected.is_none_or(|selected| selected.contains(mode))
}

fn prepared_read_ranges(rows: usize, passes: usize, width: i32) -> Result<Vec<(i32, i32)>> {
    let total = rows
        .checked_mul(passes)
        .ok_or_else(|| anyhow!("--rows * --passes overflowed usize"))?;
    let mut ranges = Vec::with_capacity(total);
    for _ in 0..passes {
        for step in 0..rows {
            let low = i32::try_from(step)
                .ok()
                .and_then(|step| step.checked_mul(width))
                .ok_or_else(|| anyhow!("prepared-read low bound overflow at step {step}"))?;
            let high = low
                .checked_add(width)
                .ok_or_else(|| anyhow!("prepared-read high bound overflow at step {step}"))?;
            ranges.push((low, high));
        }
    }
    Ok(ranges)
}

fn perf_prepared_updates(args: &[String]) -> Result<()> {
    let sample_count = prepared_update_sample_count_arg(args)?;
    if sample_count > 1 {
        return perf_prepared_updates_sampled(args, sample_count);
    }

    let mut rows = 25_000usize;
    let mut passes = 1usize;
    let mut skip_native = false;
    let mut gate = false;
    let mut only_sqlx = false;
    let mut setup_options = DiagnosticOptions::default();
    let mut runtime_set: Option<WasmerRuntimeConfigSetInput> = None;
    let mut profile_dir: Option<PathBuf> = None;
    let mut profile_seconds = 8u64;
    let mut profile_delay = Duration::from_millis(100);
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = args[cursor].clone();
        if parse_diagnostic_setup_variant_arg(&arg, args, &mut cursor, &mut setup_options)? {
            cursor += 1;
            continue;
        }
        match arg.as_str() {
            "--skip-native" => {
                skip_native = true;
            }
            "--gate" => {
                gate = true;
            }
            "--only-sqlx" | "--sqlx-only" => {
                only_sqlx = true;
            }
            "--profile" => {
                profile_dir = Some(Path::new("target/perf").join(format!(
                    "prepared-updates-profile-{}",
                    now_micros().unwrap_or(0)
                )));
            }
            "--profile-dir" | "--profile-output-dir" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
                profile_dir = Some(PathBuf::from(value));
            }
            "--profile-seconds" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-seconds requires a value"))?;
                profile_seconds = value
                    .parse()
                    .with_context(|| format!("parse --profile-seconds value {value:?}"))?;
                ensure!(
                    profile_seconds > 0,
                    "--profile-seconds must be greater than zero"
                );
            }
            "--profile-delay-ms" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--profile-delay-ms requires a value"))?;
                profile_delay = Duration::from_millis(
                    value
                        .parse()
                        .with_context(|| format!("parse --profile-delay-ms value {value:?}"))?,
                );
            }
            "--rows" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--rows requires a value"))?;
                rows = value
                    .parse()
                    .with_context(|| format!("parse --rows value {value:?}"))?;
            }
            "--passes" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--passes requires a value"))?;
                passes = value
                    .parse()
                    .with_context(|| format!("parse --passes value {value:?}"))?;
            }
            "--samples" | "--sample-count" => {
                cursor += 1;
                args.get(cursor)
                    .ok_or_else(|| anyhow!("{} requires a value", args[cursor - 1]))?;
            }
            arg if arg.starts_with("--samples=") || arg.starts_with("--sample-count=") => {}
            "--runtime-set" => {
                cursor += 1;
                let value = args
                    .get(cursor)
                    .ok_or_else(|| anyhow!("--runtime-set requires a value"))?;
                runtime_set = Some(named_wasmer_runtime_config_set(value)?);
            }
            other => bail!("unknown perf prepared-updates flag: {other}"),
        }
        cursor += 1;
    }
    ensure!(rows > 0, "--rows must be greater than zero");
    ensure!(passes > 0, "--passes must be greater than zero");
    let total_operations = rows
        .checked_mul(passes)
        .ok_or_else(|| anyhow!("--rows * --passes overflowed usize"))?;
    let profile_options = profile_dir.map(|output_dir| PreparedUpdateProfileOptions {
        output_dir,
        seconds: profile_seconds,
        delay: profile_delay,
    });
    let runtime_config = runtime_set
        .as_ref()
        .and_then(WasmerRuntimeConfigSetInput::runtime_config);

    let using_server_core_assets = using_wasix_postgres_server_core_assets()?;
    if !using_server_core_assets {
        Pglite::preload()?;
    }
    let numeric_updates = parsed_numeric_updates(rows)?;
    let text_updates = parsed_text_updates(rows)?;
    ensure!(
        numeric_updates.len() == rows && text_updates.len() == rows,
        "prepared update parser returned fewer rows than requested"
    );
    let numeric_updates = repeated_numeric_updates(&numeric_updates, passes)?;
    let text_updates = repeated_text_updates(&text_updates, passes)?;
    ensure!(
        numeric_updates.len() == total_operations && text_updates.len() == total_operations,
        "prepared update repetition returned fewer operations than requested"
    );

    let mut runs = vec![pglite_prepared_update_run(
        "pglite_server_sqlx",
        "PgliteServer over TCP using SQLx parameterized queries and SQLx statement cache.",
        || {
            run_pglite_sqlx_prepared_update_tests(
                &numeric_updates,
                &text_updates,
                &setup_options,
                runtime_config.as_ref(),
                profile_options.as_ref(),
            )
        },
    )?];

    if !only_sqlx {
        runs.push(pglite_prepared_update_run(
            "pglite_server_tcp_tokio_postgres_prepared",
            "PgliteServer over TCP using tokio-postgres explicit prepared statements.",
            || {
                run_pglite_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    &setup_options,
                    runtime_config.as_ref(),
                    PglitePreparedEndpoint::Tcp,
                    PreparedExecution::Sequential,
                )
            },
        )?);
        runs.push(pglite_prepared_update_run(
            "pglite_server_tcp_tokio_postgres_pipelined_prepared",
            "PgliteServer over TCP using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.",
            || {
                run_pglite_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    &setup_options,
                    runtime_config.as_ref(),
                    PglitePreparedEndpoint::Tcp,
                    PreparedExecution::Pipelined,
                )
            },
        )?);
    }
    #[cfg(unix)]
    {
        if !using_server_core_assets && !only_sqlx {
            runs.push(pglite_prepared_update_run(
                "pglite_server_unix_tokio_postgres_prepared",
                "PgliteServer over Unix socket using tokio-postgres explicit prepared statements.",
                || {
                    run_pglite_tokio_prepared_update_tests(
                        &numeric_updates,
                        &text_updates,
                        &setup_options,
                        runtime_config.as_ref(),
                        PglitePreparedEndpoint::Unix,
                        PreparedExecution::Sequential,
                    )
                },
            )?);
            runs.push(pglite_prepared_update_run(
                "pglite_server_unix_tokio_postgres_pipelined_prepared",
                "PgliteServer over Unix socket using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.",
                || run_pglite_tokio_prepared_update_tests(
                    &numeric_updates,
                    &text_updates,
                    &setup_options,
                    runtime_config.as_ref(),
                    PglitePreparedEndpoint::Unix,
                    PreparedExecution::Pipelined,
                ),
            )?);
        }
    }
    if !skip_native {
        let native_postgres = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("postgres"));
        let native_initdb = env::var("PGLITE_OXIDE_NATIVE_INITDB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("initdb"));
        if !only_sqlx {
            runs.push(PreparedUpdateRun {
                mode: "native_tokio_postgres_prepared",
                description: "Native Postgres over Unix socket using tokio-postgres explicit prepared statements.",
                protocol_stats: None,
                tests: run_native_prepared_update_tests(
                    &native_postgres,
                    &native_initdb,
                    &numeric_updates,
                    &text_updates,
                    PreparedExecution::Sequential,
                    &setup_options,
                )?,
            });
        }
        runs.push(PreparedUpdateRun {
            mode: "native_postgres_sqlx",
            description: "Native Postgres over loopback TCP using SQLx parameterized queries and SQLx statement cache.",
            protocol_stats: None,
            tests: run_native_sqlx_prepared_update_tests(
                &native_postgres,
                &native_initdb,
                &numeric_updates,
                &text_updates,
                &setup_options,
                profile_options.as_ref(),
            )?,
        });
        if !only_sqlx {
            runs.push(PreparedUpdateRun {
                mode: "native_tokio_postgres_pipelined_prepared",
                description: "Native Postgres over Unix socket using tokio-postgres explicit prepared statements with all update futures pipelined inside one transaction.",
                protocol_stats: None,
                tests: run_native_prepared_update_tests(
                    &native_postgres,
                    &native_initdb,
                    &numeric_updates,
                    &text_updates,
                    PreparedExecution::Pipelined,
                    &setup_options,
                )?,
            });
        }
    }

    annotate_prepared_update_profiles(&mut runs, profile_options.as_ref())?;
    let sqlx_native_comparison =
        prepared_update_mode_comparison(&runs, "pglite_server_sqlx", "native_postgres_sqlx");

    let report = PreparedUpdateReport {
        source_model: "Exact PGlite benchmark2/benchmark6 setup plus update values parsed from benchmark9 and benchmark10. --passes repeats those parsed values for longer profiling transactions; repeat passes perturb updated values so later passes still perform real updates.",
        measurement_model: "Each test uses a fresh database, creates the same indexed t2 table, prepares one parameterized UPDATE statement, then executes rows * passes updates inside one transaction. PGlite SQLx server runs use loopback TCP; native SQLx uses loopback TCP against a temporary native PostgreSQL cluster with the same benchmark GUCs as perf native-postgres.",
        gate_model: gate.then_some("Optional local regression gate for pglite-oxide server prepared-update transport: SQLx and sequential tokio-postgres must stay below 5s per 25k operations, pipelined tokio-postgres must stay below 1.5s per 25k operations, non-COPY prepared traffic must not use streaming handoff, and pipelined prepared traffic must stay batched. Thresholds scale linearly with --rows * --passes."),
        host_load: capture_host_load_report(),
        setup_variant: diagnostic_setup_variant_report(&setup_options),
        runtime: using_server_core_assets
            .then(|| benchmark_runtime_report_for_runtime_set(runtime_set.as_ref()))
            .transpose()?,
        rows,
        passes,
        runs,
        sqlx_native_comparison,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    if gate {
        validate_prepared_update_gate(&report)?;
    }
    Ok(())
}

fn pglite_prepared_update_run(
    mode: &'static str,
    description: &'static str,
    run: impl FnOnce() -> Result<Vec<PreparedUpdateTest>>,
) -> Result<PreparedUpdateRun> {
    reset_protocol_stats();
    let tests = match run() {
        Ok(tests) => tests,
        Err(err) => {
            disable_protocol_stats();
            return Err(err);
        }
    };
    let protocol_stats = Some(protocol_stats_snapshot());
    disable_protocol_stats();
    Ok(PreparedUpdateRun {
        mode,
        description,
        protocol_stats,
        tests,
    })
}

fn annotate_prepared_update_profiles(
    runs: &mut [PreparedUpdateRun],
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<()> {
    let Some(profile_options) = profile_options else {
        return Ok(());
    };
    fs::create_dir_all(&profile_options.output_dir).with_context(|| {
        format!(
            "create prepared-update profile output dir {}",
            profile_options.output_dir.display()
        )
    })?;
    let function_map = default_postgres_export_function_map(&profile_options.output_dir)?;
    for run in runs.iter_mut() {
        if !run.mode.starts_with("pglite_server") {
            continue;
        }
        for test in &mut run.tests {
            let Some(profile) = test.cpu_profile.as_ref() else {
                continue;
            };
            let prefix = format!("{}-{}", run.mode.replace('_', "-"), test.id);
            let symbolization = symbolize_wasix_cpu_profile(
                profile,
                &profile_options.output_dir,
                &prefix,
                function_map.as_deref(),
            )?;
            let top_symbols = symbolization
                .as_ref()
                .map(|symbolization| symbolization.top_stack.clone())
                .unwrap_or_else(|| {
                    profile
                        .top_stack
                        .as_deref()
                        .map(non_idle_profile_top_stack)
                        .unwrap_or_default()
                });
            let top_symbols = if top_symbols.is_empty() {
                profile_call_graph_symbol_hotspots(symbolization.as_ref(), 32)?
            } else {
                top_symbols
            };
            let targets = profile_callsite_target_symbols(&top_symbols, 8);
            let callsite_hotspots =
                profile_callsite_hotspots(symbolization.as_ref(), &targets, &top_symbols, 8, 8)?;
            test.profile_analysis = Some(PreparedUpdateProfileAnalysis {
                symbolization,
                top_symbols,
                callsite_hotspots,
            });
        }
    }
    Ok(())
}

fn prepared_update_mode_comparison(
    runs: &[PreparedUpdateRun],
    candidate_mode: &'static str,
    baseline_mode: &'static str,
) -> Option<PreparedUpdateModeComparison> {
    let candidate = runs.iter().find(|run| run.mode == candidate_mode)?;
    let baseline = runs.iter().find(|run| run.mode == baseline_mode)?;
    let baseline_tests = baseline
        .tests
        .iter()
        .map(|test| (test.id, test))
        .collect::<BTreeMap<_, _>>();
    let tests = candidate
        .tests
        .iter()
        .filter_map(|candidate_test| {
            let baseline_test = *baseline_tests.get(candidate_test.id)?;
            (baseline_test.elapsed_micros > 0).then_some(PreparedUpdateTestComparison {
                id: candidate_test.id,
                label: candidate_test.label,
                candidate_elapsed_micros: candidate_test.elapsed_micros,
                baseline_elapsed_micros: baseline_test.elapsed_micros,
                elapsed_ratio: candidate_test.elapsed_micros as f64
                    / baseline_test.elapsed_micros as f64,
                elapsed_delta_micros: candidate_test.elapsed_micros as i128
                    - baseline_test.elapsed_micros as i128,
                candidate_average_micros: candidate_test.average_micros,
                baseline_average_micros: baseline_test.average_micros,
            })
        })
        .collect::<Vec<_>>();
    (!tests.is_empty()).then_some(PreparedUpdateModeComparison {
        candidate_mode,
        baseline_mode,
        tests,
    })
}

fn validate_prepared_update_gate(report: &PreparedUpdateReport) -> Result<()> {
    let operations = report
        .rows
        .checked_mul(report.passes)
        .ok_or_else(|| anyhow!("prepared update report rows * passes overflowed usize"))?;
    let scale = operations as f64 / 25_000_f64;
    for run in &report.runs {
        let Some(base_limit_micros) = prepared_update_limit_micros(run.mode) else {
            continue;
        };
        let limit = (base_limit_micros as f64 * scale).ceil() as u128;
        for test in &run.tests {
            ensure!(
                test.elapsed_micros <= limit,
                "prepared-update gate failed for {} {}: {:.3}ms > {:.3}ms",
                run.mode,
                test.id,
                test.elapsed_micros as f64 / 1_000.0,
                limit as f64 / 1_000.0
            );
        }
        if let Some(stats) = run.protocol_stats.as_ref() {
            ensure!(
                stats.streaming_copy_handoffs == 0,
                "prepared-update gate failed for {}: non-COPY traffic used streaming handoff",
                run.mode
            );
        }
        if run.mode.contains("pipelined") {
            let stats = run
                .protocol_stats
                .as_ref()
                .context("missing protocol stats for pipelined prepared-update run")?;
            ensure!(
                stats.protocol_batches < 1_000,
                "prepared-update gate failed for {}: pipelined traffic was not batched ({} protocol batches)",
                run.mode,
                stats.protocol_batches
            );
        }
    }
    Ok(())
}

fn prepared_update_limit_micros(mode: &str) -> Option<u128> {
    if mode.starts_with("native_") {
        return None;
    }
    if mode.contains("pipelined") {
        Some(1_500_000)
    } else {
        Some(5_000_000)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedInsertCaseKind {
    LiteralTransactionBatch,
    SingleStatementValues,
    ServerPrepareExecuteBatch,
    SqlxPreparedTransaction,
}

#[derive(Debug, Clone, Copy)]
struct PreparedInsertCaseSpec {
    id: &'static str,
    label: &'static str,
    kind: PreparedInsertCaseKind,
}

const PREPARED_INSERT_CASES: &[PreparedInsertCaseSpec] = &[
    PreparedInsertCaseSpec {
        id: "literal_transaction_batch",
        label: "Literal 25k INSERT statements in one transaction, matching speed case 2",
        kind: PreparedInsertCaseKind::LiteralTransactionBatch,
    },
    PreparedInsertCaseSpec {
        id: "single_statement_values",
        label: "One INSERT statement with 25k VALUES rows, matching speed case 2.1",
        kind: PreparedInsertCaseKind::SingleStatementValues,
    },
    PreparedInsertCaseSpec {
        id: "server_prepare_execute_batch",
        label: "One SQL batch with server-side PREPARE plus EXECUTE rows in one transaction",
        kind: PreparedInsertCaseKind::ServerPrepareExecuteBatch,
    },
    PreparedInsertCaseSpec {
        id: "sqlx_prepared_transaction",
        label: "SQLx parameterized INSERT rows inside one transaction",
        kind: PreparedInsertCaseKind::SqlxPreparedTransaction,
    },
];

fn validate_prepared_insert_selection(selected_ids: Option<&HashSet<String>>) -> Result<()> {
    let Some(selected_ids) = selected_ids else {
        return Ok(());
    };
    for id in selected_ids {
        ensure!(
            PREPARED_INSERT_CASES.iter().any(|case| case.id == id),
            "unknown prepared-insert id {id:?}; use {}",
            PREPARED_INSERT_CASES
                .iter()
                .map(|case| case.id)
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    Ok(())
}

fn prepared_insert_case_selected(selected_ids: Option<&HashSet<String>>, id: &str) -> bool {
    match selected_ids {
        Some(ids) => ids.contains(id),
        None => true,
    }
}

fn prepared_insert_rows(rows: usize, seed_offset: usize) -> Result<Vec<(i32, i32, String)>> {
    ensure!(
        rows <= i32::MAX as usize,
        "--rows must fit in int4 for prepared-insert diagnostics"
    );
    let mut values = Vec::with_capacity(rows);
    for row in 1..=rows {
        let value = deterministic_benchmark_value(row + seed_offset);
        values.push((row as i32, value as i32, synthetic_benchmark_text(value)));
    }
    Ok(values)
}

fn run_pglite_sqlx_prepared_insert_tests(
    rows: &[(i32, i32, String)],
    selected_ids: Option<&HashSet<String>>,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-insert SQLx Tokio runtime")?;
    let mut tests = Vec::new();
    for spec in PREPARED_INSERT_CASES {
        if !prepared_insert_case_selected(selected_ids, spec.id) {
            continue;
        }
        tests.push(run_pglite_sqlx_prepared_insert_case(
            &runtime,
            *spec,
            rows,
            runtime_config,
            profile_options,
        )?);
    }
    Ok(tests)
}

fn run_pglite_sqlx_prepared_insert_case(
    runtime: &tokio::runtime::Runtime,
    spec: PreparedInsertCaseSpec,
    rows: &[(i32, i32, String)],
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let mut server_builder = PgliteServer::builder().temporary();
    if let Some(runtime_config) = runtime_config {
        server_builder = server_builder.runtime_config(runtime_config.clone());
    }
    if profile_options.is_some() {
        server_builder = server_builder.wasmer_profiler("perfmap");
    }
    let server = server_builder.start()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();

    let test = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx prepared-insert client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let table = prepared_insert_table_name(spec.kind);
        let setup_started = Instant::now();
        if prepared_insert_case_needs_table_setup(spec.kind) {
            let create_sql = prepared_insert_create_table_sql(table);
            conn.execute(create_sql.as_str())
                .await
                .context("create prepared-insert table")?;
        }
        let setup_micros = setup_started.elapsed().as_micros();

        let insert_sql = format!("INSERT INTO {table} VALUES ($1, $2, $3)");
        let prepare_micros = if spec.kind == PreparedInsertCaseKind::SqlxPreparedTransaction {
            let prepare_started = Instant::now();
            let _statement = conn
                .prepare(insert_sql.as_str())
                .await
                .context("prepare SQLx insert statement")?;
            Some(prepare_started.elapsed().as_micros())
        } else {
            None
        };

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "pglite-server-sqlx-prepared-insert",
            spec.id,
            server.server_process_id(),
            CpuProfilePidSelection::Exact,
        )?;
        let elapsed_result =
            execute_prepared_insert_shape_sqlx(&mut conn, spec.kind, table, rows, &insert_sql)
                .await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close SQLx prepared-insert client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id: spec.id,
            label: spec.label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros,
            elapsed_micros: elapsed.as_micros(),
            operation_count: rows.len(),
            average_micros: elapsed.as_micros() as f64 / rows.len().max(1) as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })?;
    server.shutdown()?;
    Ok(test)
}

fn run_native_sqlx_prepared_insert_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    rows: &[(i32, i32, String)],
    selected_ids: Option<&HashSet<String>>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native prepared-insert SQLx Tokio runtime")?;
    let mut tests = Vec::new();
    for spec in PREPARED_INSERT_CASES {
        if !prepared_insert_case_selected(selected_ids, spec.id) {
            continue;
        }
        tests.push(run_native_sqlx_prepared_insert_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            *spec,
            rows,
            profile_options,
        )?);
    }
    Ok(tests)
}

fn run_native_sqlx_prepared_insert_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    spec: PreparedInsertCaseSpec,
    rows: &[(i32, i32, String)],
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();

    runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
            .await
            .context("connect native SQLx prepared-insert client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let table = prepared_insert_table_name(spec.kind);
        let setup_started = Instant::now();
        if prepared_insert_case_needs_table_setup(spec.kind) {
            let create_sql = prepared_insert_create_table_sql(table);
            conn.execute(create_sql.as_str())
                .await
                .context("create native prepared-insert table")?;
        }
        let setup_micros = setup_started.elapsed().as_micros();

        let insert_sql = format!("INSERT INTO {table} VALUES ($1, $2, $3)");
        let prepare_micros = if spec.kind == PreparedInsertCaseKind::SqlxPreparedTransaction {
            let prepare_started = Instant::now();
            let _statement = conn
                .prepare(insert_sql.as_str())
                .await
                .context("prepare native SQLx insert statement")?;
            Some(prepare_started.elapsed().as_micros())
        } else {
            None
        };

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "native-postgres-sqlx-prepared-insert",
            spec.id,
            Some(native.child.id()),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )?;
        let elapsed_result =
            execute_prepared_insert_shape_sqlx(&mut conn, spec.kind, table, rows, &insert_sql)
                .await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close native SQLx prepared-insert client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id: spec.id,
            label: spec.label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros,
            elapsed_micros: elapsed.as_micros(),
            operation_count: rows.len(),
            average_micros: elapsed.as_micros() as f64 / rows.len().max(1) as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })
}

async fn execute_prepared_insert_shape_sqlx(
    conn: &mut sqlx::PgConnection,
    kind: PreparedInsertCaseKind,
    table: &str,
    rows: &[(i32, i32, String)],
    prepared_sql: &str,
) -> Result<Duration> {
    let started = Instant::now();
    match kind {
        PreparedInsertCaseKind::LiteralTransactionBatch => {
            let sql = speed_create_and_insert(table, rows.len(), true, false);
            conn.execute(sql.as_str())
                .await
                .context("execute literal transaction insert batch")?;
        }
        PreparedInsertCaseKind::SingleStatementValues => {
            let sql = speed_create_and_insert(table, rows.len(), true, true);
            conn.execute(sql.as_str())
                .await
                .context("execute single-statement values insert batch")?;
        }
        PreparedInsertCaseKind::ServerPrepareExecuteBatch => {
            let sql = prepared_insert_execute_batch_sql(table, rows);
            conn.execute(sql.as_str())
                .await
                .context("execute server PREPARE/EXECUTE insert batch")?;
        }
        PreparedInsertCaseKind::SqlxPreparedTransaction => {
            conn.execute("BEGIN")
                .await
                .context("begin SQLx prepared-insert transaction")?;
            for (row, value, text) in rows {
                sqlx::query(prepared_sql)
                    .bind(*row)
                    .bind(*value)
                    .bind(text.as_str())
                    .execute(&mut *conn)
                    .await
                    .context("execute SQLx prepared insert")?;
            }
            conn.execute("COMMIT")
                .await
                .context("commit SQLx prepared-insert transaction")?;
        }
    }
    Ok(started.elapsed())
}

fn prepared_insert_case_needs_table_setup(kind: PreparedInsertCaseKind) -> bool {
    matches!(
        kind,
        PreparedInsertCaseKind::ServerPrepareExecuteBatch
            | PreparedInsertCaseKind::SqlxPreparedTransaction
    )
}

fn prepared_insert_table_name(kind: PreparedInsertCaseKind) -> &'static str {
    match kind {
        PreparedInsertCaseKind::LiteralTransactionBatch => "__pgo_insert_literal",
        PreparedInsertCaseKind::SingleStatementValues => "__pgo_insert_values",
        PreparedInsertCaseKind::ServerPrepareExecuteBatch => "__pgo_insert_exec",
        PreparedInsertCaseKind::SqlxPreparedTransaction => "__pgo_insert_sqlx",
    }
}

fn prepared_insert_create_table_sql(table: &str) -> String {
    format!("CREATE TABLE {table}(a INTEGER, b INTEGER, c VARCHAR(100));")
}

fn prepared_insert_execute_batch_sql(table: &str, rows: &[(i32, i32, String)]) -> String {
    let statement = "__pgo_insert_row";
    let mut sql = String::with_capacity(128 + rows.len() * 72);
    sql.push_str(&format!(
        "PREPARE {statement}(int4, int4, text) AS INSERT INTO {table} VALUES ($1, $2, $3);\nBEGIN;\n"
    ));
    for (row, value, text) in rows {
        sql.push_str(&format!(
            "EXECUTE {statement}({row}, {value}, {});\n",
            sql_string_literal(text)
        ));
    }
    sql.push_str(&format!("COMMIT;\nDEALLOCATE {statement};\n"));
    sql
}

fn sql_string_literal(value: &str) -> String {
    let mut literal = String::with_capacity(value.len() + 2);
    literal.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            literal.push('\'');
        }
        literal.push(ch);
    }
    literal.push('\'');
    literal
}

fn run_pglite_sqlx_prepared_update_tests(
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-update SQLx Tokio runtime")?;

    let numeric = run_pglite_sqlx_prepared_update_case(
        &runtime,
        "numeric_indexed",
        "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
        "UPDATE t2 SET b=$1 WHERE a=$2",
        PreparedUpdateValues::Numeric(numeric_updates),
        setup_options,
        runtime_config,
        profile_options,
    )?;
    let text = run_pglite_sqlx_prepared_update_case(
        &runtime,
        "text_indexed",
        "Parameterized text UPDATEs with indexes on lookup and numeric column",
        "UPDATE t2 SET c=$1 WHERE a=$2",
        PreparedUpdateValues::Text(text_updates),
        setup_options,
        runtime_config,
        profile_options,
    )?;
    Ok(vec![numeric, text])
}

enum PreparedUpdateValues<'a> {
    Numeric(&'a [(i32, i32)]),
    Text(&'a [(i32, String)]),
}

impl PreparedUpdateValues<'_> {
    fn len(&self) -> usize {
        match self {
            Self::Numeric(values) => values.len(),
            Self::Text(values) => values.len(),
        }
    }
}

fn prepared_update_setup_sql(setup_options: &DiagnosticOptions) -> Result<(String, String)> {
    Ok((
        apply_diagnostic_sql_variants(&read_pglite_benchmark_sql("2")?, setup_options),
        apply_diagnostic_sql_variants(&read_pglite_benchmark_sql("6")?, setup_options),
    ))
}

fn run_pglite_sqlx_prepared_read_tests(
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
    selected_ids: Option<&HashSet<String>>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-read SQLx Tokio runtime")?;

    let mut tests = Vec::new();
    if prepared_read_case_selected(selected_ids, "param_echo") {
        tests.push(run_pglite_sqlx_prepared_read_case(
            &runtime,
            "param_echo",
            "Parameterized SELECT $1::int4 protocol echo",
            "SELECT $1::int4",
            PreparedReadKind::ParamEcho,
            ranges,
            setup_options,
            runtime_config,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_select") {
        tests.push(run_pglite_sqlx_prepared_read_case(
            &runtime,
            "indexed_range_select",
            "Parameterized indexed range SELECT count(*), avg(b)",
            "SELECT count(*), avg(b) FROM t2 WHERE b >= $1 AND b < $2",
            PreparedReadKind::IndexedRangeAggregate,
            ranges,
            setup_options,
            runtime_config,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_server_prepare_batch") {
        tests.push(run_pglite_sqlx_prepared_read_batch_case(
            &runtime,
            "indexed_range_server_prepare_batch",
            "One SQL batch using server-side PREPARE plus EXECUTE for indexed range SELECTs",
            ranges,
            setup_options,
            runtime_config,
            profile_options,
        )?);
    }
    Ok(tests)
}

fn run_pglite_sqlx_prepared_read_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let mut server_builder = PgliteServer::builder().temporary();
    if let Some(runtime_config) = runtime_config {
        server_builder = server_builder.runtime_config(runtime_config.clone());
    }
    if profile_options.is_some() {
        server_builder = server_builder.wasmer_profiler("perfmap");
    }
    let server = server_builder.start()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let operation_count = ranges.len();

    let test = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx prepared-read client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute prepared-read SQLx setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute prepared-read SQLx setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let prepare_started = Instant::now();
        let _statement = conn
            .prepare(sql)
            .await
            .with_context(|| format!("prepare SQLx read statement {sql}"))?;
        let prepare_micros = prepare_started.elapsed().as_micros();

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "pglite-server-sqlx",
            id,
            server.server_process_id(),
            CpuProfilePidSelection::Exact,
        )?;
        let elapsed_result =
            measure_async_transaction_sqlx_reads(&mut conn, sql, read_kind, ranges).await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close SQLx prepared-read client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: Some(prepare_micros),
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })?;
    server.shutdown()?;
    Ok(test)
}

fn run_pglite_sqlx_prepared_read_batch_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let mut server_builder = PgliteServer::builder().temporary();
    if let Some(runtime_config) = runtime_config {
        server_builder = server_builder.runtime_config(runtime_config.clone());
    }
    if profile_options.is_some() {
        server_builder = server_builder.wasmer_profiler("perfmap");
    }
    let server = server_builder.start()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let operation_count = ranges.len();

    let test = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx prepared-read batch client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute prepared-read batch SQLx setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute prepared-read batch SQLx setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let batch_sql = prepared_read_execute_batch_sql(ranges);
        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "pglite-server-sqlx",
            id,
            server.server_process_id(),
            CpuProfilePidSelection::Exact,
        )?;
        let started = Instant::now();
        let elapsed_result = conn
            .execute(batch_sql.as_str())
            .await
            .context("execute SQLx server-side prepared-read batch");
        let elapsed = started.elapsed();
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        elapsed_result?;
        conn.close()
            .await
            .context("close SQLx prepared-read batch client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: None,
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })?;
    server.shutdown()?;
    Ok(test)
}

fn run_pglite_tokio_prepared_read_tests(
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    execution: PreparedExecution,
    profile_options: Option<&PreparedUpdateProfileOptions>,
    selected_ids: Option<&HashSet<String>>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-read tokio-postgres runtime")?;

    let mut tests = Vec::new();
    if prepared_read_case_selected(selected_ids, "param_echo") {
        tests.push(run_pglite_tokio_prepared_read_case(
            &runtime,
            "param_echo",
            "Parameterized SELECT $1::int4 protocol echo",
            "SELECT $1::int4",
            PreparedReadKind::ParamEcho,
            ranges,
            setup_options,
            runtime_config,
            execution,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_select") {
        tests.push(run_pglite_tokio_prepared_read_case(
            &runtime,
            "indexed_range_select",
            "Parameterized indexed range SELECT count(*), avg(b)",
            "SELECT count(*), avg(b) FROM t2 WHERE b >= $1 AND b < $2",
            PreparedReadKind::IndexedRangeAggregate,
            ranges,
            setup_options,
            runtime_config,
            execution,
            profile_options,
        )?);
    }
    Ok(tests)
}

#[allow(clippy::too_many_arguments)]
fn run_pglite_tokio_prepared_read_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    execution: PreparedExecution,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let server = start_prepared_update_pglite_server(
        PglitePreparedEndpoint::Tcp,
        runtime_config,
        profile_options.is_some(),
    )?;
    let open_micros = open_started.elapsed().as_micros();
    let connection = pglite_prepared_update_connection(&server, PglitePreparedEndpoint::Tcp)?;
    let profile_mode = match execution {
        PreparedExecution::Sequential => "pglite-server-tokio-postgres-prepared",
        PreparedExecution::Pipelined => "pglite-server-tokio-postgres-pipelined-prepared",
    };

    let test = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        config.user("postgres").dbname("template1");
        match &connection {
            PreparedPgliteConnection::Tcp(addr) => {
                config.host(addr.ip().to_string()).port(addr.port());
            }
            #[cfg(unix)]
            PreparedPgliteConnection::Unix { socket_dir, port } => {
                config.host_path(socket_dir).port(*port);
            }
        }
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres prepared-read client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("prepared-read pglite connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let result = run_tokio_prepared_read_case_on_client(
            &client,
            id,
            label,
            sql,
            read_kind,
            ranges,
            setup_options,
            execution,
            open_micros,
            connect_micros,
            profile_options,
            profile_mode,
            server.server_process_id(),
            CpuProfilePidSelection::Exact,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })?;
    server.shutdown()?;
    Ok(test)
}

fn run_native_sqlx_prepared_read_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    profile_options: Option<&PreparedUpdateProfileOptions>,
    selected_ids: Option<&HashSet<String>>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native SQLx prepared-read Tokio runtime")?;

    let mut tests = Vec::new();
    if prepared_read_case_selected(selected_ids, "param_echo") {
        tests.push(run_native_sqlx_prepared_read_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "param_echo",
            "Parameterized SELECT $1::int4 protocol echo",
            "SELECT $1::int4",
            PreparedReadKind::ParamEcho,
            ranges,
            setup_options,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_select") {
        tests.push(run_native_sqlx_prepared_read_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "indexed_range_select",
            "Parameterized indexed range SELECT count(*), avg(b)",
            "SELECT count(*), avg(b) FROM t2 WHERE b >= $1 AND b < $2",
            PreparedReadKind::IndexedRangeAggregate,
            ranges,
            setup_options,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_server_prepare_batch") {
        tests.push(run_native_sqlx_prepared_read_batch_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "indexed_range_server_prepare_batch",
            "One SQL batch using server-side PREPARE plus EXECUTE for indexed range SELECTs",
            ranges,
            setup_options,
            profile_options,
        )?);
    }
    Ok(tests)
}

fn run_native_sqlx_prepared_read_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();
    let operation_count = ranges.len();

    runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
            .await
            .context("connect native SQLx prepared-read client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute native SQLx prepared-read setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute native SQLx prepared-read setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let prepare_started = Instant::now();
        let _statement = conn
            .prepare(sql)
            .await
            .with_context(|| format!("prepare native SQLx read statement {sql}"))?;
        let prepare_micros = prepare_started.elapsed().as_micros();

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "native-postgres-sqlx",
            id,
            Some(native.child.id()),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )?;
        let elapsed_result =
            measure_async_transaction_sqlx_reads(&mut conn, sql, read_kind, ranges).await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close native SQLx prepared-read client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: Some(prepare_micros),
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })
}

fn run_native_sqlx_prepared_read_batch_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    id: &'static str,
    label: &'static str,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();
    let operation_count = ranges.len();

    runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
            .await
            .context("connect native SQLx prepared-read batch client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute native SQLx prepared-read batch setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute native SQLx prepared-read batch setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let batch_sql = prepared_read_execute_batch_sql(ranges);
        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "native-postgres-sqlx",
            id,
            Some(native.child.id()),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )?;
        let started = Instant::now();
        let elapsed_result = conn
            .execute(batch_sql.as_str())
            .await
            .context("execute native SQLx server-side prepared-read batch");
        let elapsed = started.elapsed();
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        elapsed_result?;
        conn.close()
            .await
            .context("close native SQLx prepared-read batch client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: None,
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })
}

fn run_native_tokio_prepared_read_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    execution: PreparedExecution,
    profile_options: Option<&PreparedUpdateProfileOptions>,
    selected_ids: Option<&HashSet<String>>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native prepared-read tokio-postgres runtime")?;

    let mut tests = Vec::new();
    if prepared_read_case_selected(selected_ids, "param_echo") {
        tests.push(run_native_tokio_prepared_read_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "param_echo",
            "Parameterized SELECT $1::int4 protocol echo",
            "SELECT $1::int4",
            PreparedReadKind::ParamEcho,
            ranges,
            setup_options,
            execution,
            profile_options,
        )?);
    }
    if prepared_read_case_selected(selected_ids, "indexed_range_select") {
        tests.push(run_native_tokio_prepared_read_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "indexed_range_select",
            "Parameterized indexed range SELECT count(*), avg(b)",
            "SELECT count(*), avg(b) FROM t2 WHERE b >= $1 AND b < $2",
            PreparedReadKind::IndexedRangeAggregate,
            ranges,
            setup_options,
            execution,
            profile_options,
        )?);
    }
    Ok(tests)
}

#[allow(clippy::too_many_arguments)]
fn run_native_tokio_prepared_read_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    execution: PreparedExecution,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();

    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_tcp_client(&mut config, &native);
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native tokio-postgres prepared-read client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("native prepared-read connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();
        let profile_mode = match execution {
            PreparedExecution::Sequential => "native-tokio-postgres-prepared-read",
            PreparedExecution::Pipelined => "native-tokio-postgres-pipelined-prepared-read",
        };

        let result = run_tokio_prepared_read_case_on_client(
            &client,
            id,
            label,
            sql,
            read_kind,
            ranges,
            setup_options,
            execution,
            open_micros,
            connect_micros,
            profile_options,
            profile_mode,
            Some(native.child.id()),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_tokio_prepared_read_case_on_client(
    client: &tokio_postgres::Client,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
    setup_options: &DiagnosticOptions,
    execution: PreparedExecution,
    open_micros: u128,
    connect_micros: u128,
    profile_options: Option<&PreparedUpdateProfileOptions>,
    profile_mode: &str,
    profile_pid: Option<u32>,
    profile_pid_selection: CpuProfilePidSelection,
) -> Result<PreparedUpdateTest> {
    let setup_started = Instant::now();
    let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
    client
        .simple_query(&setup_benchmark2)
        .await
        .context("execute prepared-read setup benchmark2")?;
    client
        .simple_query(&setup_benchmark6)
        .await
        .context("execute prepared-read setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let prepare_started = Instant::now();
    let statement = client
        .prepare(sql)
        .await
        .with_context(|| format!("prepare tokio-postgres read statement {sql}"))?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let mut running_profile = start_prepared_update_profile(
        profile_options,
        profile_mode,
        id,
        profile_pid,
        profile_pid_selection,
    )?;
    let elapsed_result = async {
        let started = Instant::now();
        client
            .simple_query("BEGIN")
            .await
            .context("begin tokio-postgres prepared-read transaction")?;
        let mut total_count = 0_i128;
        match execution {
            PreparedExecution::Sequential => {
                for (low, high) in ranges {
                    total_count += i128::from(
                        execute_tokio_prepared_read(client, &statement, read_kind, *low, *high)
                            .await?,
                    );
                }
            }
            PreparedExecution::Pipelined => {
                let reads = ranges.iter().map(|(low, high)| {
                    let statement = &statement;
                    async move {
                        execute_tokio_prepared_read(client, statement, read_kind, *low, *high).await
                    }
                });
                let values = try_join_all(reads)
                    .await
                    .context("execute pipelined tokio-postgres prepared reads")?;
                for value in values {
                    total_count += i128::from(value);
                }
            }
        }
        client
            .simple_query("COMMIT")
            .await
            .context("commit tokio-postgres prepared-read transaction")?;
        ensure!(
            total_count >= 0,
            "tokio-postgres prepared-read count accumulator underflowed"
        );
        Ok::<_, anyhow::Error>(started.elapsed())
    }
    .await;
    let cpu_profile = finish_cpu_profile(running_profile.take())?;
    let elapsed = elapsed_result?;

    Ok(PreparedUpdateTest {
        id,
        label,
        open_micros,
        connect_micros,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count: ranges.len(),
        average_micros: elapsed.as_micros() as f64 / ranges.len() as f64,
        cpu_profile,
        profile_analysis: None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedReadKind {
    ParamEcho,
    IndexedRangeAggregate,
}

async fn execute_tokio_prepared_read(
    client: &tokio_postgres::Client,
    statement: &tokio_postgres::Statement,
    read_kind: PreparedReadKind,
    low: i32,
    high: i32,
) -> Result<i64> {
    match read_kind {
        PreparedReadKind::ParamEcho => {
            let params: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&low];
            let row = client
                .query_one(statement, &params)
                .await
                .context("execute tokio-postgres parameter echo read")?;
            let value: i32 = row.get(0);
            Ok(i64::from(value))
        }
        PreparedReadKind::IndexedRangeAggregate => {
            let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&low, &high];
            let row = client
                .query_one(statement, &params)
                .await
                .context("execute tokio-postgres indexed range read")?;
            Ok(row.get(0))
        }
    }
}

fn prepared_read_execute_batch_sql(ranges: &[(i32, i32)]) -> String {
    let mut sql = String::with_capacity(128 + ranges.len() * 96);
    sql.push_str(
        "PREPARE __pglite_oxide_read_range(int4, int4) AS \
         SELECT count(*), avg(b) FROM t2 WHERE b >= $1 AND b < $2;\nBEGIN;\n",
    );
    for (low, high) in ranges {
        sql.push_str(&format!(
            "EXECUTE __pglite_oxide_read_range({low}, {high});\n"
        ));
    }
    sql.push_str("COMMIT;\nDEALLOCATE __pglite_oxide_read_range;\n");
    sql
}

async fn measure_async_transaction_sqlx_reads(
    conn: &mut sqlx::PgConnection,
    sql: &'static str,
    read_kind: PreparedReadKind,
    ranges: &[(i32, i32)],
) -> Result<Duration> {
    let started = Instant::now();
    conn.execute("BEGIN")
        .await
        .context("begin SQLx prepared-read transaction")?;
    let mut total_count = 0_i128;
    for (low, high) in ranges {
        total_count +=
            i128::from(execute_sqlx_prepared_read(conn, sql, read_kind, *low, *high).await?);
    }
    conn.execute("COMMIT")
        .await
        .context("commit SQLx prepared-read transaction")?;
    ensure!(
        total_count >= 0,
        "prepared-read count accumulator underflowed"
    );
    Ok(started.elapsed())
}

async fn execute_sqlx_prepared_read(
    conn: &mut sqlx::PgConnection,
    sql: &'static str,
    read_kind: PreparedReadKind,
    low: i32,
    high: i32,
) -> Result<i64> {
    match read_kind {
        PreparedReadKind::ParamEcho => {
            let row = sqlx::query(sql)
                .bind(low)
                .fetch_one(&mut *conn)
                .await
                .context("execute SQLx parameter echo read")?;
            let value: i32 = row.try_get(0).context("read SQLx parameter echo value")?;
            Ok(i64::from(value))
        }
        PreparedReadKind::IndexedRangeAggregate => {
            let row = sqlx::query(sql)
                .bind(low)
                .bind(high)
                .fetch_one(&mut *conn)
                .await
                .context("execute SQLx prepared indexed read")?;
            row.try_get(0)
                .context("read SQLx prepared indexed-read count")
        }
    }
}

fn start_prepared_update_profile(
    options: Option<&PreparedUpdateProfileOptions>,
    mode: &str,
    id: &str,
    pid: Option<u32>,
    pid_selection: CpuProfilePidSelection,
) -> Result<Option<RunningCpuProfile>> {
    let Some(options) = options else {
        return Ok(None);
    };
    let profile = DiagnosticCpuProfileOptions {
        output_path: options.output_dir.join(format!("{mode}-{id}.sample.txt")),
        seconds: options.seconds,
        delay: options.delay,
    };
    start_cpu_profile(pid, Some(&profile), pid_selection)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedExecution {
    Sequential,
    Pipelined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PglitePreparedEndpoint {
    Tcp,
    #[cfg(unix)]
    Unix,
}

fn run_pglite_sqlx_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    values: PreparedUpdateValues<'_>,
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let mut server_builder = PgliteServer::builder().temporary();
    if let Some(runtime_config) = runtime_config {
        server_builder = server_builder.runtime_config(runtime_config.clone());
    }
    if profile_options.is_some() {
        server_builder = server_builder.wasmer_profiler("perfmap");
    }
    let server = server_builder.start()?;
    let open_micros = open_started.elapsed().as_micros();
    let uri = server.database_url();
    let operation_count = values.len();

    let test = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx prepared-update client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute prepared-update SQLx setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute prepared-update SQLx setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let prepare_started = Instant::now();
        let _statement = conn
            .prepare(sql)
            .await
            .with_context(|| format!("prepare SQLx statement {sql}"))?;
        let prepare_micros = prepare_started.elapsed().as_micros();

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "pglite-server-sqlx",
            id,
            server.server_process_id(),
            CpuProfilePidSelection::Exact,
        )?;
        let elapsed_result = measure_async_transaction_sqlx(&mut conn, sql, values).await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close SQLx prepared-update client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: Some(prepare_micros),
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })?;
    server.shutdown()?;
    Ok(test)
}

async fn measure_async_transaction_sqlx(
    conn: &mut sqlx::PgConnection,
    sql: &'static str,
    values: PreparedUpdateValues<'_>,
) -> Result<Duration> {
    let started = Instant::now();
    conn.execute("BEGIN")
        .await
        .context("begin SQLx transaction")?;
    match values {
        PreparedUpdateValues::Numeric(values) => {
            for (lookup, value) in values {
                sqlx::query(sql)
                    .bind(*value)
                    .bind(*lookup)
                    .execute(&mut *conn)
                    .await
                    .context("execute SQLx prepared numeric update")?;
            }
        }
        PreparedUpdateValues::Text(values) => {
            for (lookup, value) in values {
                sqlx::query(sql)
                    .bind(value.as_str())
                    .bind(*lookup)
                    .execute(&mut *conn)
                    .await
                    .context("execute SQLx prepared text update")?;
            }
        }
    }
    conn.execute("COMMIT")
        .await
        .context("commit SQLx transaction")?;
    Ok(started.elapsed())
}

fn run_pglite_tokio_prepared_update_tests(
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    endpoint: PglitePreparedEndpoint,
    execution: PreparedExecution,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create prepared-update tokio-postgres runtime")?;

    Ok(vec![
        run_pglite_tokio_prepared_update_case(
            &runtime,
            "numeric_indexed",
            "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
            "UPDATE t2 SET b=$1 WHERE a=$2",
            numeric_updates,
            None,
            setup_options,
            runtime_config,
            endpoint,
            execution,
        )?,
        run_pglite_tokio_prepared_update_case(
            &runtime,
            "text_indexed",
            "Parameterized text UPDATEs with indexes on lookup and numeric column",
            "UPDATE t2 SET c=$1 WHERE a=$2",
            &[],
            Some(text_updates),
            setup_options,
            runtime_config,
            endpoint,
            execution,
        )?,
    ])
}

#[allow(clippy::too_many_arguments)]
fn run_pglite_tokio_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    setup_options: &DiagnosticOptions,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    endpoint: PglitePreparedEndpoint,
    execution: PreparedExecution,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let server = start_prepared_update_pglite_server(endpoint, runtime_config, false)?;
    let open_micros = open_started.elapsed().as_micros();
    let connection = pglite_prepared_update_connection(&server, endpoint)?;
    #[cfg(unix)]
    let cleanup_socket_dir = match &connection {
        PreparedPgliteConnection::Tcp(_) => None,
        PreparedPgliteConnection::Unix { socket_dir, .. } => Some(socket_dir.clone()),
    };

    let test = runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        config.user("postgres").dbname("template1");
        match &connection {
            PreparedPgliteConnection::Tcp(addr) => {
                config.host(addr.ip().to_string()).port(addr.port());
            }
            #[cfg(unix)]
            PreparedPgliteConnection::Unix { socket_dir, port } => {
                config.host_path(socket_dir).port(*port);
            }
        }
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres prepared-update client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("prepared-update pglite connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let result = run_tokio_prepared_update_case_on_client(
            &client,
            id,
            label,
            sql,
            numeric_updates,
            text_updates,
            setup_options,
            execution,
            open_micros,
            connect_micros,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })?;
    server.shutdown()?;
    #[cfg(unix)]
    if let Some(socket_dir) = cleanup_socket_dir {
        let _ = fs::remove_dir_all(socket_dir);
    }
    Ok(test)
}

fn start_prepared_update_pglite_server(
    endpoint: PglitePreparedEndpoint,
    runtime_config: Option<&PgliteServerRuntimeConfig>,
    enable_perfmap: bool,
) -> Result<PgliteServer> {
    match endpoint {
        PglitePreparedEndpoint::Tcp => {
            let mut builder = PgliteServer::builder().temporary();
            if let Some(runtime_config) = runtime_config {
                builder = builder.runtime_config(runtime_config.clone());
            }
            if enable_perfmap {
                builder = builder.wasmer_profiler("perfmap");
            }
            builder.start()
        }
        #[cfg(unix)]
        PglitePreparedEndpoint::Unix => {
            let socket_dir = env::current_dir()
                .context("read current directory")?
                .join("target/perf")
                .join(format!(
                    "pglite-prepared-unix-{}-{}",
                    std::process::id(),
                    now_micros()?
                ));
            let port = 5432;
            let socket_path = socket_dir.join(format!(".s.PGSQL.{port}"));
            let mut builder = PgliteServer::builder().temporary().unix(socket_path);
            if let Some(runtime_config) = runtime_config {
                builder = builder.runtime_config(runtime_config.clone());
            }
            if enable_perfmap {
                builder = builder.wasmer_profiler("perfmap");
            }
            builder.start()
        }
    }
}

enum PreparedPgliteConnection {
    Tcp(std::net::SocketAddr),
    #[cfg(unix)]
    Unix {
        socket_dir: PathBuf,
        port: u16,
    },
}

fn pglite_prepared_update_connection(
    server: &PgliteServer,
    endpoint: PglitePreparedEndpoint,
) -> Result<PreparedPgliteConnection> {
    match endpoint {
        PglitePreparedEndpoint::Tcp => {
            let addr = server
                .tcp_addr()
                .ok_or_else(|| anyhow!("prepared-update PgliteServer did not bind TCP"))?;
            Ok(PreparedPgliteConnection::Tcp(addr))
        }
        #[cfg(unix)]
        PglitePreparedEndpoint::Unix => {
            let socket_path = server
                .socket_path()
                .ok_or_else(|| anyhow!("prepared-update PgliteServer did not bind Unix socket"))?;
            let socket_dir = socket_path
                .parent()
                .ok_or_else(|| anyhow!("prepared-update Unix socket has no parent directory"))?
                .to_path_buf();
            let port = socket_path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(".s.PGSQL."))
                .ok_or_else(|| {
                    anyhow!(
                        "prepared-update Unix socket path is not libpq-shaped: {}",
                        socket_path.display()
                    )
                })?
                .parse()
                .context("parse prepared-update Unix socket port")?;
            Ok(PreparedPgliteConnection::Unix { socket_dir, port })
        }
    }
}

fn run_native_prepared_update_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    execution: PreparedExecution,
    setup_options: &DiagnosticOptions,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native prepared-update Tokio runtime")?;

    Ok(vec![
        run_native_prepared_update_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "numeric_indexed",
            "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
            "UPDATE t2 SET b=$1 WHERE a=$2",
            numeric_updates,
            None,
            execution,
            setup_options,
        )?,
        run_native_prepared_update_case(
            &runtime,
            postgres_bin,
            initdb_bin,
            "text_indexed",
            "Parameterized text UPDATEs with indexes on lookup and numeric column",
            "UPDATE t2 SET c=$1 WHERE a=$2",
            &[],
            Some(text_updates),
            execution,
            setup_options,
        )?,
    ])
}

fn run_native_sqlx_prepared_update_tests(
    postgres_bin: &Path,
    initdb_bin: &Path,
    numeric_updates: &[(i32, i32)],
    text_updates: &[(i32, String)],
    setup_options: &DiagnosticOptions,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<Vec<PreparedUpdateTest>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native SQLx prepared-update Tokio runtime")?;

    let numeric = run_native_sqlx_prepared_update_case(
        &runtime,
        postgres_bin,
        initdb_bin,
        "numeric_indexed",
        "Parameterized numeric UPDATEs with indexes on lookup and updated columns",
        "UPDATE t2 SET b=$1 WHERE a=$2",
        PreparedUpdateValues::Numeric(numeric_updates),
        setup_options,
        profile_options,
    )?;
    let text = run_native_sqlx_prepared_update_case(
        &runtime,
        postgres_bin,
        initdb_bin,
        "text_indexed",
        "Parameterized text UPDATEs with indexes on lookup and numeric column",
        "UPDATE t2 SET c=$1 WHERE a=$2",
        PreparedUpdateValues::Text(text_updates),
        setup_options,
        profile_options,
    )?;
    Ok(vec![numeric, text])
}

fn run_native_sqlx_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    values: PreparedUpdateValues<'_>,
    setup_options: &DiagnosticOptions,
    profile_options: Option<&PreparedUpdateProfileOptions>,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();
    let operation_count = values.len();

    runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
            .await
            .context("connect native SQLx prepared-update client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
        conn.execute(setup_benchmark2.as_str())
            .await
            .context("execute native SQLx prepared-update setup benchmark2")?;
        conn.execute(setup_benchmark6.as_str())
            .await
            .context("execute native SQLx prepared-update setup benchmark6")?;
        let setup_micros = setup_started.elapsed().as_micros();

        let prepare_started = Instant::now();
        let _statement = conn
            .prepare(sql)
            .await
            .with_context(|| format!("prepare native SQLx statement {sql}"))?;
        let prepare_micros = prepare_started.elapsed().as_micros();

        let mut running_profile = start_prepared_update_profile(
            profile_options,
            "native-postgres-sqlx",
            id,
            Some(native.child.id()),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )?;
        let elapsed_result = measure_async_transaction_sqlx(&mut conn, sql, values).await;
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        let elapsed = elapsed_result?;
        conn.close()
            .await
            .context("close native SQLx prepared-update client")?;

        Ok::<_, anyhow::Error>(PreparedUpdateTest {
            id,
            label,
            open_micros,
            connect_micros,
            setup_micros,
            prepare_micros: Some(prepare_micros),
            elapsed_micros: elapsed.as_micros(),
            operation_count,
            average_micros: elapsed.as_micros() as f64 / operation_count as f64,
            cpu_profile,
            profile_analysis: None,
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn run_native_prepared_update_case(
    runtime: &tokio::runtime::Runtime,
    postgres_bin: &Path,
    initdb_bin: &Path,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    execution: PreparedExecution,
    setup_options: &DiagnosticOptions,
) -> Result<PreparedUpdateTest> {
    let open_started = Instant::now();
    let native = NativePostgres::start(postgres_bin, initdb_bin)?;
    let open_micros = open_started.elapsed().as_micros();

    runtime.block_on(async {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, &native);
        let connect_started = Instant::now();
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect native prepared-update client")?;
        let connection_task = tokio::spawn(async move {
            if let Err(err) = connection.await {
                eprintln!("native prepared-update connection error: {err}");
            }
        });
        let connect_micros = connect_started.elapsed().as_micros();

        let result = run_tokio_prepared_update_case_on_client(
            &client,
            id,
            label,
            sql,
            numeric_updates,
            text_updates,
            setup_options,
            execution,
            open_micros,
            connect_micros,
        )
        .await;
        drop(client);
        let _ = connection_task.await;
        result
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_tokio_prepared_update_case_on_client(
    client: &tokio_postgres::Client,
    id: &'static str,
    label: &'static str,
    sql: &'static str,
    numeric_updates: &[(i32, i32)],
    text_updates: Option<&[(i32, String)]>,
    setup_options: &DiagnosticOptions,
    execution: PreparedExecution,
    open_micros: u128,
    connect_micros: u128,
) -> Result<PreparedUpdateTest> {
    let setup_started = Instant::now();
    let (setup_benchmark2, setup_benchmark6) = prepared_update_setup_sql(setup_options)?;
    client
        .simple_query(&setup_benchmark2)
        .await
        .context("execute prepared-update setup benchmark2")?;
    client
        .simple_query(&setup_benchmark6)
        .await
        .context("execute prepared-update setup benchmark6")?;
    let setup_micros = setup_started.elapsed().as_micros();

    let prepare_started = Instant::now();
    let statement = client
        .prepare(sql)
        .await
        .with_context(|| format!("prepare tokio-postgres statement {sql}"))?;
    let prepare_micros = prepare_started.elapsed().as_micros();

    let started = Instant::now();
    client
        .simple_query("BEGIN")
        .await
        .context("begin tokio-postgres prepared-update transaction")?;
    let operation_count = if let Some(text_updates) = text_updates {
        match execution {
            PreparedExecution::Sequential => {
                for (lookup, value) in text_updates {
                    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [value, lookup];
                    client
                        .execute(&statement, &params)
                        .await
                        .context("execute tokio-postgres prepared text update")?;
                }
            }
            PreparedExecution::Pipelined => {
                let updates = text_updates.iter().map(|(lookup, value)| {
                    let statement = &statement;
                    async move {
                        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] =
                            [value, lookup];
                        client.execute(statement, &params).await
                    }
                });
                try_join_all(updates)
                    .await
                    .context("execute pipelined tokio-postgres prepared text updates")?;
            }
        }
        text_updates.len()
    } else {
        match execution {
            PreparedExecution::Sequential => {
                for (lookup, value) in numeric_updates {
                    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [value, lookup];
                    client
                        .execute(&statement, &params)
                        .await
                        .context("execute tokio-postgres prepared numeric update")?;
                }
            }
            PreparedExecution::Pipelined => {
                let updates = numeric_updates.iter().map(|(lookup, value)| {
                    let statement = &statement;
                    async move {
                        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] =
                            [value, lookup];
                        client.execute(statement, &params).await
                    }
                });
                try_join_all(updates)
                    .await
                    .context("execute pipelined tokio-postgres prepared numeric updates")?;
            }
        }
        numeric_updates.len()
    };
    client
        .simple_query("COMMIT")
        .await
        .context("commit tokio-postgres prepared-update transaction")?;
    let elapsed = started.elapsed();

    Ok(PreparedUpdateTest {
        id,
        label,
        open_micros,
        connect_micros,
        setup_micros,
        prepare_micros: Some(prepare_micros),
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        average_micros: elapsed.as_micros() as f64 / operation_count as f64,
        cpu_profile: None,
        profile_analysis: None,
    })
}

fn parsed_numeric_updates(limit: usize) -> Result<Vec<(i32, i32)>> {
    let sql = read_pglite_benchmark_sql("9")?;
    let mut updates = Vec::with_capacity(limit);
    for line in sql.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("UPDATE t2 SET b=") else {
            continue;
        };
        let rest = rest
            .strip_suffix(';')
            .ok_or_else(|| anyhow!("numeric update line is missing semicolon: {line}"))?;
        let (value, lookup) = rest
            .split_once(" WHERE a=")
            .ok_or_else(|| anyhow!("numeric update line has unexpected shape: {line}"))?;
        updates.push((lookup.parse()?, value.parse()?));
        if updates.len() == limit {
            break;
        }
    }
    ensure!(
        updates.len() == limit,
        "benchmark9 only contained {} update rows; requested {limit}",
        updates.len()
    );
    Ok(updates)
}

fn parsed_text_updates(limit: usize) -> Result<Vec<(i32, String)>> {
    let sql = read_pglite_benchmark_sql("10")?;
    let mut updates = Vec::with_capacity(limit);
    for line in sql.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("UPDATE t2 SET c='") else {
            continue;
        };
        let rest = rest
            .strip_suffix(';')
            .ok_or_else(|| anyhow!("text update line is missing semicolon: {line}"))?;
        let (value, lookup) = rest
            .split_once("' WHERE a=")
            .ok_or_else(|| anyhow!("text update line has unexpected shape: {line}"))?;
        updates.push((lookup.parse()?, value.to_owned()));
        if updates.len() == limit {
            break;
        }
    }
    ensure!(
        updates.len() == limit,
        "benchmark10 only contained {} update rows; requested {limit}",
        updates.len()
    );
    Ok(updates)
}

fn repeated_numeric_updates(updates: &[(i32, i32)], passes: usize) -> Result<Vec<(i32, i32)>> {
    ensure!(
        passes > 0,
        "prepared update passes must be greater than zero"
    );
    let total = updates
        .len()
        .checked_mul(passes)
        .ok_or_else(|| anyhow!("prepared numeric update pass count overflowed usize"))?;
    let mut repeated = Vec::with_capacity(total);
    for pass in 0..passes {
        let value_shift =
            i32::try_from(pass).context("prepared numeric update pass count exceeded i32")?;
        for &(lookup, value) in updates {
            let value = value
                .checked_add(value_shift)
                .ok_or_else(|| anyhow!("prepared numeric update value overflowed i32"))?;
            repeated.push((lookup, value));
        }
    }
    Ok(repeated)
}

fn repeated_text_updates(updates: &[(i32, String)], passes: usize) -> Result<Vec<(i32, String)>> {
    ensure!(
        passes > 0,
        "prepared update passes must be greater than zero"
    );
    let total = updates
        .len()
        .checked_mul(passes)
        .ok_or_else(|| anyhow!("prepared text update pass count overflowed usize"))?;
    let mut repeated = Vec::with_capacity(total);
    for pass in 0..passes {
        for (lookup, value) in updates {
            let value = if pass == 0 {
                value.clone()
            } else {
                format!("{value} #{pass}")
            };
            ensure!(
                value.len() <= 100,
                "prepared text update value exceeded t2.c varchar(100) during --passes expansion"
            );
            repeated.push((*lookup, value));
        }
    }
    Ok(repeated)
}

struct NativePostgres {
    child: Child,
    root: PathBuf,
    socket_dir: PathBuf,
    port: u16,
    start_phases: Vec<OpenPhaseReport>,
}

impl NativePostgres {
    fn start(postgres_bin: &Path, initdb_bin: &Path) -> Result<Self> {
        Self::start_with_configs(postgres_bin, initdb_bin, &[])
    }

    fn start_with_configs(
        postgres_bin: &Path,
        initdb_bin: &Path,
        postgres_configs: &[(String, String)],
    ) -> Result<Self> {
        let mut start_phases = Vec::new();
        let perf_root = env::var_os("PGLITE_OXIDE_PERF_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(default_native_postgres_perf_root);
        let root = perf_root.join(format!(
            "native-postgres-{}-{}",
            std::process::id(),
            now_micros()?
        ));
        let data_dir = root.join("data");
        let socket_dir = root.join("socket");
        let phase_started = Instant::now();
        fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;
        fs::create_dir_all(&socket_dir)
            .with_context(|| format!("create {}", socket_dir.display()))?;
        record_open_phase(
            &mut start_phases,
            "native_postgres.open.create_dirs",
            phase_started,
        );

        let phase_started = Instant::now();
        let init_status = Command::new(initdb_bin)
            .arg("-D")
            .arg(&data_dir)
            .args([
                "-A",
                "trust",
                "-U",
                "postgres",
                "--encoding=UTF8",
                "--no-instructions",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .with_context(|| format!("spawn native initdb {}", initdb_bin.display()))?;
        ensure!(
            init_status.success(),
            "native initdb failed with {init_status}"
        );
        record_open_phase(
            &mut start_phases,
            "native_postgres.open.initdb",
            phase_started,
        );

        let port = reserve_loopback_port()?;
        let log_path = root.join("postgres.log");
        let log = fs::File::create(&log_path)
            .with_context(|| format!("create native Postgres log {}", log_path.display()))?;
        let mut command = Command::new(postgres_bin);
        command.arg("-D").arg(&data_dir);
        #[cfg(unix)]
        {
            command
                .arg("-h")
                .arg("127.0.0.1")
                .arg("-k")
                .arg(&socket_dir);
        }
        #[cfg(not(unix))]
        {
            command.arg("-h").arg("127.0.0.1");
        }
        let phase_started = Instant::now();
        command.arg("-p").arg(port.to_string()).args([
            "-F",
            "-c",
            "search_path=public",
            "-c",
            "exit_on_error=false",
            "-c",
            "fsync=off",
            "-c",
            "synchronous_commit=on",
            "-c",
            "shared_buffers=128MB",
            "-c",
            "wal_buffers=4MB",
            "-c",
            "min_wal_size=80MB",
            "-c",
            "max_worker_processes=0",
            "-c",
            "max_parallel_workers=0",
            "-c",
            "max_parallel_workers_per_gather=0",
            "-c",
            "autovacuum=off",
            "-c",
            "log_checkpoints=off",
            "-c",
            "log_timezone=UTC",
            "-c",
            "TimeZone=UTC",
        ]);
        for (name, value) in postgres_configs {
            command.arg("-c").arg(format!("{name}={value}"));
        }
        let child = command
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .spawn()
            .with_context(|| format!("spawn native postgres {}", postgres_bin.display()))?;
        record_open_phase(
            &mut start_phases,
            "native_postgres.open.spawn",
            phase_started,
        );

        let mut native = Self {
            child,
            root,
            socket_dir,
            port,
            start_phases,
        };
        let phase_started = Instant::now();
        native.wait_ready(&log_path)?;
        record_open_phase(
            &mut native.start_phases,
            "native_postgres.open.wait_ready",
            phase_started,
        );
        Ok(native)
    }

    fn wait_ready(&mut self, log_path: &Path) -> Result<()> {
        #[cfg(unix)]
        let socket_path = self.socket_dir.join(format!(".s.PGSQL.{}", self.port));
        let start = Instant::now();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create native Postgres readiness Tokio runtime")?;
        let mut last_probe_error = None;
        while start.elapsed() < Duration::from_secs(15) {
            if let Some(status) = self.child.try_wait().context("poll native postgres")? {
                let log = fs::read_to_string(log_path).unwrap_or_default();
                bail!("native postgres exited early with {status}; log:\n{log}");
            }
            #[cfg(unix)]
            let transport_ready = socket_path.exists();
            #[cfg(not(unix))]
            let transport_ready = true;
            if transport_ready {
                match runtime.block_on(self.probe_ready()) {
                    Ok(()) => return Ok(()),
                    Err(err) => last_probe_error = Some(err),
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let log = fs::read_to_string(log_path).unwrap_or_default();
        let probe = last_probe_error
            .map(|err| format!("last readiness probe error: {err}\n"))
            .unwrap_or_default();
        bail!("native postgres did not become ready; {probe}log:\n{log}");
    }

    async fn probe_ready(&self) -> Result<()> {
        let mut config = tokio_postgres::Config::new();
        configure_native_postgres_client(&mut config, self);
        let (client, connection) = config
            .connect(tokio_postgres::NoTls)
            .await
            .context("connect readiness probe")?;
        let connection_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let query_result = client
            .simple_query("SELECT 1")
            .await
            .context("run readiness probe query");
        drop(client);
        connection_task.abort();
        query_result.map(|_| ())
    }
}

fn reserve_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .context("reserve loopback port for native Postgres benchmark")?;
    let port = listener
        .local_addr()
        .context("read reserved native Postgres benchmark port")?
        .port();
    drop(listener);
    Ok(port)
}

struct ProcessTreeRssSampler {
    root_pid: u32,
    peak_bytes: u64,
    warned: bool,
}

impl ProcessTreeRssSampler {
    fn new(root_pid: u32) -> Self {
        Self {
            root_pid,
            peak_bytes: 0,
            warned: false,
        }
    }

    fn sample(&mut self) {
        match process_tree_rss_bytes(self.root_pid) {
            Ok(Some(bytes)) => {
                self.peak_bytes = self.peak_bytes.max(bytes);
            }
            Ok(None) => {}
            Err(err) => {
                if !self.warned {
                    eprintln!(
                        "warning: failed to sample server process-tree RSS for pid {}: {err}",
                        self.root_pid
                    );
                    self.warned = true;
                }
            }
        }
    }

    fn peak_bytes(&self) -> Option<u64> {
        (self.peak_bytes > 0).then_some(self.peak_bytes)
    }
}

fn sample_optional_rss(sampler: &mut Option<ProcessTreeRssSampler>) {
    if let Some(sampler) = sampler {
        sampler.sample();
    }
}

fn optional_peak_rss(sampler: &Option<ProcessTreeRssSampler>) -> Option<u64> {
    sampler.as_ref().and_then(ProcessTreeRssSampler::peak_bytes)
}

struct RunningCpuProfile {
    handle: std::thread::JoinHandle<Result<SpeedHotspotCpuProfile>>,
}

#[derive(Debug, Clone, Copy)]
enum CpuProfilePidSelection {
    Exact,
    PreferActivePostgresChild,
}

fn start_cpu_profile(
    pid: Option<u32>,
    options: Option<&DiagnosticCpuProfileOptions>,
    pid_selection: CpuProfilePidSelection,
) -> Result<Option<RunningCpuProfile>> {
    let Some(options) = options else {
        return Ok(None);
    };
    let pid = pid.ok_or_else(|| anyhow!("--sample-server requires an external server PID"))?;
    if let Some(parent) = options
        .output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create profile output directory {}", parent.display()))?;
    }

    let requested_pid = pid;
    let options = options.clone();
    let handle = std::thread::spawn(move || {
        if !options.delay.is_zero() {
            std::thread::sleep(options.delay);
        }
        let (pid, selection_label) = resolve_cpu_profile_pid(requested_pid, pid_selection)?;
        let command = vec![
            "sample".to_owned(),
            pid.to_string(),
            options.seconds.to_string(),
            "-file".to_owned(),
            options.output_path.display().to_string(),
        ];
        let output = Command::new("sample")
            .arg(pid.to_string())
            .arg(options.seconds.to_string())
            .arg("-file")
            .arg(&options.output_path)
            .output()
            .with_context(|| format!("run macOS sample profiler for pid {pid}"))?;

        let output_bytes = fs::metadata(&options.output_path)
            .ok()
            .map(|metadata| metadata.len());
        let top_stack = sample_top_stack_entries(&options.output_path, 32)
            .ok()
            .filter(|entries| !entries.is_empty());
        let (perf_map_path, perf_map_bytes) = copy_wasmer_perf_map(pid, &options.output_path);

        Ok(SpeedHotspotCpuProfile {
            tool: "macos_sample",
            requested_pid,
            pid,
            pid_selection: selection_label,
            seconds: options.seconds,
            delay_millis: options.delay.as_millis() as u64,
            output_path: options.output_path.display().to_string(),
            command,
            status: Some(output.status.to_string()),
            success: Some(output.status.success()),
            output_bytes,
            perf_map_path,
            perf_map_bytes,
            top_stack,
            stderr_tail: (!output.stderr.is_empty()).then(|| tail_lossy_utf8(&output.stderr, 4096)),
        })
    });
    Ok(Some(RunningCpuProfile { handle }))
}

fn copy_wasmer_perf_map(pid: u32, sample_output_path: &Path) -> (Option<String>, Option<u64>) {
    let source = PathBuf::from(format!("/tmp/perf-{pid}.map"));
    if !source.is_file() {
        return (None, None);
    }
    let destination = sample_output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join(format!("perf-{pid}.map"));
    if fs::copy(&source, &destination).is_err() {
        return (None, None);
    }
    let bytes = fs::metadata(&destination)
        .ok()
        .map(|metadata| metadata.len());
    (Some(destination.display().to_string()), bytes)
}

fn sample_top_stack_entries(
    sample_output_path: &Path,
    limit: usize,
) -> Result<Vec<CpuProfileTopStackEntry>> {
    let sample = fs::read_to_string(sample_output_path)
        .with_context(|| format!("read macOS sample output {}", sample_output_path.display()))?;
    let mut in_top_stack = false;
    let mut entries = Vec::new();
    for line in sample.lines() {
        if line.starts_with("Sort by top of stack") {
            in_top_stack = true;
            continue;
        }
        if !in_top_stack {
            continue;
        }
        if line.starts_with("Binary Images:") {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((frame, samples)) = split_sample_top_stack_line(trimmed) else {
            continue;
        };
        entries.push(CpuProfileTopStackEntry { samples, frame });
        if entries.len() >= limit {
            break;
        }
    }
    Ok(entries)
}

fn split_sample_top_stack_line(line: &str) -> Option<(String, u64)> {
    let mut parts = line.rsplitn(2, char::is_whitespace);
    let samples = parts.next()?.parse().ok()?;
    let frame = parts.next()?.trim().to_owned();
    (!frame.is_empty()).then_some((frame, samples))
}

fn finish_cpu_profile(
    profile: Option<RunningCpuProfile>,
) -> Result<Option<SpeedHotspotCpuProfile>> {
    let Some(profile) = profile else {
        return Ok(None);
    };
    let profile = profile
        .handle
        .join()
        .map_err(|_| anyhow!("macOS sample profiler thread panicked"))??;
    Ok(Some(profile))
}

fn symbolize_wasix_profile(
    case: &SpeedHotspotDiagnosticCase,
    output_dir: &Path,
    function_map: Option<&Path>,
) -> Result<Option<ProfileSymbolizationReport>> {
    let Some(profile) = &case.cpu_profile else {
        return Ok(None);
    };
    symbolize_wasix_cpu_profile(profile, output_dir, "server", function_map)
}

fn symbolize_wasix_cpu_profile(
    profile: &SpeedHotspotCpuProfile,
    output_dir: &Path,
    output_prefix: &str,
    function_map: Option<&Path>,
) -> Result<Option<ProfileSymbolizationReport>> {
    let Some(perf_map_path) = profile.perf_map_path.as_ref().map(PathBuf::from) else {
        return Ok(None);
    };
    if !perf_map_path.is_file() {
        return Ok(None);
    }

    let sample_path = PathBuf::from(&profile.output_path);
    let Some(function_map) = function_map.filter(|path| path.is_file()) else {
        return Ok(Some(ProfileSymbolizationReport {
            perf_map_path: perf_map_path.display().to_string(),
            function_map_path: None,
            annotated_perf_map_path: None,
            symbolized_sample_path: None,
            top_tsv_path: None,
            top_stack: profile.top_stack.clone().unwrap_or_default(),
        }));
    };

    let annotated_perf_map = output_dir.join(format!("{output_prefix}.perf.exports.map"));
    let symbolized_prefix = output_dir.join(format!("{output_prefix}.symbolized-exports"));
    let symbolized_sample = PathBuf::from(format!("{}.txt", symbolized_prefix.display()));
    let symbolized_top_tsv = PathBuf::from(format!("{}.top.tsv", symbolized_prefix.display()));

    run_profile_script(
        &Path::new(WASIX_BUILD_ROOT)
            .join("experiments/fresh-wasix-postgres/bin/annotate-wasmer-perfmap.sh"),
        &[&perf_map_path, function_map, &annotated_perf_map],
    )?;
    run_profile_script(
        &Path::new(WASIX_BUILD_ROOT)
            .join("experiments/fresh-wasix-postgres/bin/symbolize-wasmer-sample.sh"),
        &[&sample_path, &annotated_perf_map, &symbolized_prefix],
    )?;

    let top_stack = parse_profile_top_tsv(&symbolized_top_tsv, 64)?;
    Ok(Some(ProfileSymbolizationReport {
        perf_map_path: perf_map_path.display().to_string(),
        function_map_path: Some(function_map.display().to_string()),
        annotated_perf_map_path: Some(annotated_perf_map.display().to_string()),
        symbolized_sample_path: Some(symbolized_sample.display().to_string()),
        top_tsv_path: Some(symbolized_top_tsv.display().to_string()),
        top_stack,
    }))
}

fn run_profile_script(script: &Path, args: &[&Path]) -> Result<()> {
    ensure!(
        script.is_file(),
        "missing profile helper {}",
        script.display()
    );
    let script = script.to_str().ok_or_else(|| {
        anyhow!(
            "profile helper path is not valid UTF-8: {}",
            script.display()
        )
    })?;
    let mut command = command_for_host(script);
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .with_context(|| format!("run profile helper {script}"))?;
    if !output.status.success() {
        bail!(
            "profile helper {} failed with {}\nstdout:\n{}\nstderr:\n{}",
            script,
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn parse_profile_top_tsv(path: &Path, limit: usize) -> Result<Vec<CpuProfileTopStackEntry>> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("read profile top TSV {}", path.display()))?;
    let mut entries = Vec::new();
    for line in contents.lines().skip(1) {
        let Some((samples, frame)) = line.split_once('\t') else {
            continue;
        };
        let Ok(samples) = samples.parse::<u64>() else {
            continue;
        };
        entries.push(CpuProfileTopStackEntry {
            samples,
            frame: frame.to_owned(),
        });
        if entries.len() >= limit {
            break;
        }
    }
    Ok(entries)
}

fn locate_postgres_export_function_map() -> Option<PathBuf> {
    let explicit = env::var_os("PGLITE_OXIDE_POSTGRES_FUNCTION_MAP")
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if explicit.is_some() {
        return explicit;
    }

    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in WalkDir::new("target/perf")
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file()
            || entry.file_name().to_string_lossy() != "postgres-export-function-map.txt"
        {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        if best
            .as_ref()
            .is_none_or(|(best_modified, _)| modified > *best_modified)
        {
            best = Some((modified, entry.path().to_path_buf()));
        }
    }
    best.map(|(_, path)| path)
}

fn default_postgres_export_function_map(output_dir: &Path) -> Result<Option<PathBuf>> {
    if let Some(generated) = generate_postgres_export_function_map(output_dir)? {
        return Ok(Some(generated));
    }
    Ok(locate_postgres_export_function_map())
}

fn generate_postgres_export_function_map(output_dir: &Path) -> Result<Option<PathBuf>> {
    let Some(wasm) = locate_postgres_wasm_module() else {
        return Ok(None);
    };
    let bytes = fs::read(&wasm).with_context(|| {
        format!(
            "read PostgreSQL WASIX module for function map {}",
            wasm.display()
        )
    })?;
    let mut export_names: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    let mut name_section_names: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.with_context(|| format!("parse {}", wasm.display()))? {
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export =
                        export.with_context(|| format!("read export from {}", wasm.display()))?;
                    if matches!(export.kind, ExternalKind::Func | ExternalKind::FuncExact) {
                        export_names
                            .entry(export.index)
                            .or_default()
                            .push(export.name.to_owned());
                    }
                }
            }
            Payload::CustomSection(reader) => {
                if let KnownCustom::Name(names) = reader.as_known() {
                    for subsection in names {
                        if let Name::Function(function_names) = subsection.with_context(|| {
                            format!("read name subsection from {}", wasm.display())
                        })? {
                            for naming in function_names {
                                let naming = naming.with_context(|| {
                                    format!("read function name from {}", wasm.display())
                                })?;
                                let name = naming.name.trim();
                                if !name.is_empty() {
                                    name_section_names
                                        .entry(naming.index)
                                        .or_default()
                                        .push(name.to_owned());
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if export_names.is_empty() && name_section_names.is_empty() {
        return Ok(None);
    }

    let output = output_dir.join("postgres-export-function-map.txt");
    let mut contents = String::new();
    let mut function_indexes = export_names.keys().copied().collect::<BTreeSet<_>>();
    function_indexes.extend(name_section_names.keys().copied());
    for index in function_indexes {
        let mut names = name_section_names
            .get(&index)
            .or_else(|| export_names.get(&index))
            .cloned()
            .unwrap_or_default();
        names.sort();
        names.dedup();
        for name in names {
            contents.push_str(&format!("{index}:{name}\n"));
        }
    }
    fs::write(&output, contents).with_context(|| format!("write {}", output.display()))?;
    Ok(Some(output))
}

fn locate_postgres_wasm_module() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("PGLITE_OXIDE_POSTGRES_WASM")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(explicit);
    }
    [
        "assets/wasix-build/work/docker-pglite/src/backend/postgres",
        "assets/wasix-build/work/experiments/fresh-wasix-postgres/install/wasix-core-release-o3/bin/postgres",
        "assets/wasix-build/work/experiments/fresh-wasix-postgres/builds/wasix-core-release-o3/src/backend/postgres",
        "assets/wasix-build/work/experiments/fresh-wasix-postgres/install/wasix-core/bin/postgres",
        "assets/wasix-build/work/experiments/fresh-wasix-postgres/builds/wasix-core/src/backend/postgres",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

fn cpu_profile_top_stack(case: &SpeedHotspotDiagnosticCase) -> Vec<CpuProfileTopStackEntry> {
    case.cpu_profile
        .as_ref()
        .and_then(|profile| profile.top_stack.clone())
        .unwrap_or_default()
}

fn non_idle_profile_top_stack(entries: &[CpuProfileTopStackEntry]) -> Vec<CpuProfileTopStackEntry> {
    entries
        .iter()
        .filter(|entry| !is_idle_profile_frame(&entry.frame))
        .cloned()
        .collect()
}

fn is_idle_profile_frame(frame: &str) -> bool {
    let symbol = frame
        .split_once("  (in ")
        .map(|(symbol, _)| symbol)
        .unwrap_or(frame)
        .trim();
    matches!(
        symbol,
        "kevent"
            | "semaphore_wait_trap"
            | "__psynch_cvwait"
            | "mach_msg"
            | "mach_msg2_trap"
            | "poll"
            | "__select"
            | "select"
            | "nanosleep"
            | "__semwait_signal"
    )
}

fn compare_profile_hotspots(
    server_top: &[CpuProfileTopStackEntry],
    native_top: &[CpuProfileTopStackEntry],
    limit: usize,
) -> Vec<ProfileHotspotCompareEntry> {
    let server = normalized_profile_counts(server_top);
    let native = normalized_profile_counts(native_top);
    let server_total = server.values().copied().sum::<u64>().max(1) as f64;
    let native_total = native.values().copied().sum::<u64>().max(1) as f64;
    let mut entries = server
        .iter()
        .filter_map(|(symbol, server_samples)| {
            let native_samples = *native.get(symbol)?;
            Some(ProfileHotspotCompareEntry {
                symbol: symbol.clone(),
                server_samples: *server_samples,
                native_samples,
                server_share: *server_samples as f64 / server_total,
                native_share: native_samples as f64 / native_total,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.server_samples
            .cmp(&a.server_samples)
            .then_with(|| b.native_samples.cmp(&a.native_samples))
            .then_with(|| a.symbol.cmp(&b.symbol))
    });
    entries.truncate(limit);
    entries
}

fn profile_offset_hotspots(
    entries: &[CpuProfileTopStackEntry],
    symbol_limit: usize,
    offset_limit: usize,
) -> Vec<ProfileOffsetHotspot> {
    let total_samples = entries
        .iter()
        .map(|entry| entry.samples)
        .sum::<u64>()
        .max(1);
    let mut symbols: BTreeMap<String, BTreeMap<(u64, Option<u64>), u64>> = BTreeMap::new();
    for entry in entries {
        let Some(offset) = parse_profile_symbol_offset(&entry.frame) else {
            continue;
        };
        *symbols
            .entry(offset.symbol)
            .or_default()
            .entry((offset.offset, offset.function_size))
            .or_insert(0) += entry.samples;
    }

    let mut hotspots = symbols
        .into_iter()
        .filter_map(|(symbol, offsets)| {
            let samples = offsets.values().copied().sum::<u64>();
            if samples == 0 {
                return None;
            }
            let mut offset_entries = offsets
                .into_iter()
                .map(
                    |((offset, function_size), samples)| ProfileOffsetHotspotEntry {
                        offset,
                        offset_hex: format!("0x{offset:x}"),
                        function_size,
                        function_size_hex: function_size.map(|size| format!("0x{size:x}")),
                        samples,
                        symbol_share: samples as f64 / samples.max(1) as f64,
                        profile_share: samples as f64 / total_samples as f64,
                    },
                )
                .collect::<Vec<_>>();
            let symbol_samples = samples.max(1);
            for entry in &mut offset_entries {
                entry.symbol_share = entry.samples as f64 / symbol_samples as f64;
            }
            offset_entries.sort_by(|a, b| {
                b.samples
                    .cmp(&a.samples)
                    .then_with(|| a.offset.cmp(&b.offset))
            });
            offset_entries.truncate(offset_limit);
            Some(ProfileOffsetHotspot {
                symbol,
                samples,
                profile_share: samples as f64 / total_samples as f64,
                offsets: offset_entries,
            })
        })
        .collect::<Vec<_>>();
    hotspots.sort_by(|a, b| {
        b.samples
            .cmp(&a.samples)
            .then_with(|| a.symbol.cmp(&b.symbol))
    });
    hotspots.truncate(symbol_limit);
    hotspots
}

fn profile_callsite_target_symbols(
    entries: &[CpuProfileTopStackEntry],
    limit: usize,
) -> Vec<String> {
    let mut counts = normalized_profile_counts(entries)
        .into_iter()
        .collect::<Vec<_>>();
    counts.sort_by(|(a_symbol, a_samples), (b_symbol, b_samples)| {
        b_samples
            .cmp(a_samples)
            .then_with(|| a_symbol.cmp(b_symbol))
    });
    counts
        .into_iter()
        .map(|(symbol, _)| symbol)
        .take(limit)
        .collect()
}

fn profile_callsite_hotspots(
    symbolization: Option<&ProfileSymbolizationReport>,
    target_symbols: &[String],
    top_entries: &[CpuProfileTopStackEntry],
    symbol_limit: usize,
    caller_limit: usize,
) -> Result<Vec<ProfileCallsiteHotspot>> {
    let Some(sample_path) = symbolization
        .and_then(|symbolization| symbolization.symbolized_sample_path.as_ref())
        .map(PathBuf::from)
    else {
        return Ok(Vec::new());
    };
    if target_symbols.is_empty() || !sample_path.is_file() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&sample_path).with_context(|| {
        format!(
            "read symbolized sample call graph {}",
            sample_path.display()
        )
    })?;
    Ok(profile_callsite_hotspots_from_text(
        &text,
        target_symbols,
        top_entries,
        symbol_limit,
        caller_limit,
    ))
}

fn profile_call_graph_symbol_hotspots(
    symbolization: Option<&ProfileSymbolizationReport>,
    limit: usize,
) -> Result<Vec<CpuProfileTopStackEntry>> {
    let Some(sample_path) = symbolization
        .and_then(|symbolization| symbolization.symbolized_sample_path.as_ref())
        .map(PathBuf::from)
    else {
        return Ok(Vec::new());
    };
    if !sample_path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&sample_path)
        .with_context(|| format!("read symbolized sample {}", sample_path.display()))?;
    Ok(profile_call_graph_symbol_hotspots_from_text(&text, limit))
}

fn profile_call_graph_symbol_hotspots_from_text(
    text: &str,
    limit: usize,
) -> Vec<CpuProfileTopStackEntry> {
    let mut in_call_graph = false;
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut stack: Vec<ProfileCallGraphStackFrame> = Vec::new();
    for line in text.lines() {
        if line.starts_with("Call graph:") {
            in_call_graph = true;
            stack.clear();
            continue;
        }
        if line.starts_with("Total number in stack")
            || line.starts_with("Sort by top of stack")
            || line.starts_with("Binary Images:")
        {
            while let Some(frame) = stack.pop() {
                finish_profile_call_graph_stack_frame(frame, &mut counts);
            }
            in_call_graph = false;
            continue;
        }
        if !in_call_graph {
            continue;
        }
        let Some(frame) = parse_profile_call_graph_frame(line) else {
            continue;
        };
        while stack
            .last()
            .is_some_and(|ancestor| ancestor.frame.depth >= frame.depth)
        {
            if let Some(frame) = stack.pop() {
                finish_profile_call_graph_stack_frame(frame, &mut counts);
            }
        }
        if let Some(parent) = stack.last_mut() {
            parent.child_samples = parent.child_samples.saturating_add(frame.samples);
        }
        stack.push(ProfileCallGraphStackFrame {
            frame,
            child_samples: 0,
        });
    }
    while let Some(frame) = stack.pop() {
        finish_profile_call_graph_stack_frame(frame, &mut counts);
    }
    let mut entries = counts
        .into_iter()
        .map(|(symbol, samples)| CpuProfileTopStackEntry {
            samples,
            frame: symbol,
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.samples
            .cmp(&a.samples)
            .then_with(|| a.frame.cmp(&b.frame))
    });
    entries.truncate(limit);
    entries
}

struct ProfileCallGraphStackFrame {
    frame: ProfileCallGraphFrame,
    child_samples: u64,
}

fn finish_profile_call_graph_stack_frame(
    frame: ProfileCallGraphStackFrame,
    counts: &mut BTreeMap<String, u64>,
) {
    if !frame.frame.frame.contains("module_")
        || is_profile_call_graph_scaffold_symbol(&frame.frame.symbol)
    {
        return;
    }
    let samples = frame.frame.samples.saturating_sub(frame.child_samples);
    if samples == 0 {
        return;
    }
    *counts.entry(frame.frame.symbol).or_insert(0) += samples;
}

fn is_profile_call_graph_scaffold_symbol(symbol: &str) -> bool {
    matches!(
        symbol,
        "_start"
            | "__main_void"
            | "__main_argc_argv"
            | "PostmasterMain"
            | "SubPostmasterMain"
            | "IoWorkerMain"
            | "BackendMain"
            | "WaitEventSetWait"
            | "epoll_pwait"
            | "__wasi_epoll_wait"
            | "WaitLatch"
            | "WaitLatchOrSocket"
    )
}

fn profile_callsite_hotspots_from_text(
    text: &str,
    target_symbols: &[String],
    top_entries: &[CpuProfileTopStackEntry],
    symbol_limit: usize,
    caller_limit: usize,
) -> Vec<ProfileCallsiteHotspot> {
    let targets = target_symbols.iter().cloned().collect::<BTreeSet<_>>();
    let total_profile_samples = top_entries
        .iter()
        .map(|entry| entry.samples)
        .sum::<u64>()
        .max(1);
    let mut stack: Vec<ProfileCallGraphFrame> = Vec::new();
    let mut symbols: BTreeMap<String, BTreeMap<(String, String), u64>> = BTreeMap::new();
    let mut in_call_graph = false;

    for line in text.lines() {
        if line.starts_with("Call graph:") {
            in_call_graph = true;
            stack.clear();
            continue;
        }
        if line.starts_with("Total number in stack")
            || line.starts_with("Sort by top of stack")
            || line.starts_with("Binary Images:")
        {
            in_call_graph = false;
            stack.clear();
            continue;
        }
        if !in_call_graph {
            continue;
        }
        let Some(frame) = parse_profile_call_graph_frame(line) else {
            continue;
        };
        while stack
            .last()
            .is_some_and(|ancestor| ancestor.depth >= frame.depth)
        {
            stack.pop();
        }
        if targets.contains(&frame.symbol) {
            let caller = stack
                .last()
                .map(|ancestor| (ancestor.symbol.clone(), ancestor.frame.clone()))
                .unwrap_or_else(|| ("<root>".to_owned(), "<root>".to_owned()));
            *symbols
                .entry(frame.symbol.clone())
                .or_default()
                .entry(caller)
                .or_insert(0) += frame.samples;
        }
        stack.push(frame);
    }

    let mut hotspots = symbols
        .into_iter()
        .filter_map(|(symbol, callers)| {
            let samples = callers.values().copied().sum::<u64>();
            if samples == 0 {
                return None;
            }
            let symbol_samples = samples.max(1);
            let mut caller_entries = callers
                .into_iter()
                .map(
                    |((caller_symbol, caller_frame), samples)| ProfileCallsiteHotspotEntry {
                        caller_symbol,
                        caller_frame,
                        samples,
                        symbol_share: samples as f64 / symbol_samples as f64,
                        profile_share: samples as f64 / total_profile_samples as f64,
                    },
                )
                .collect::<Vec<_>>();
            caller_entries.sort_by(|a, b| {
                b.samples
                    .cmp(&a.samples)
                    .then_with(|| a.caller_symbol.cmp(&b.caller_symbol))
                    .then_with(|| a.caller_frame.cmp(&b.caller_frame))
            });
            caller_entries.truncate(caller_limit);
            Some(ProfileCallsiteHotspot {
                symbol,
                samples,
                profile_share: samples as f64 / total_profile_samples as f64,
                callers: caller_entries,
            })
        })
        .collect::<Vec<_>>();
    hotspots.sort_by(|a, b| {
        b.samples
            .cmp(&a.samples)
            .then_with(|| a.symbol.cmp(&b.symbol))
    });
    hotspots.truncate(symbol_limit);
    hotspots
}

#[derive(Debug, Clone)]
struct ProfileCallGraphFrame {
    depth: usize,
    samples: u64,
    frame: String,
    symbol: String,
}

fn parse_profile_call_graph_frame(line: &str) -> Option<ProfileCallGraphFrame> {
    let count_start = line.find(|ch: char| ch.is_ascii_digit())?;
    let prefix = &line[..count_start];
    if prefix
        .chars()
        .any(|ch| !matches!(ch, ' ' | ':' | '|' | '+' | '!' | '-'))
    {
        return None;
    }
    let rest = &line[count_start..];
    let count_end = rest
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(rest.len());
    let samples = rest[..count_end].parse().ok()?;
    if samples == 0 {
        return None;
    }
    let raw_frame = rest[count_end..].trim_start();
    let frame = raw_frame
        .rsplit_once("=>")
        .map(|(_, symbolized)| symbolized.trim())
        .unwrap_or(raw_frame)
        .to_owned();
    let symbol = normalize_profile_symbol(&frame)?;
    Some(ProfileCallGraphFrame {
        depth: count_start,
        samples,
        frame,
        symbol,
    })
}

#[derive(Debug, PartialEq, Eq)]
struct ProfileSymbolOffset {
    symbol: String,
    offset: u64,
    function_size: Option<u64>,
}

fn parse_profile_symbol_offset(frame: &str) -> Option<ProfileSymbolOffset> {
    let symbol = frame
        .split_once("  (in ")
        .map(|(symbol, _)| symbol)
        .unwrap_or(frame)
        .trim();
    let symbol = symbol
        .rsplit_once("::")
        .map(|(_, rhs)| rhs)
        .unwrap_or(symbol);
    let (symbol, rest) = symbol.split_once("+0x")?;
    let symbol = symbol.trim();
    if symbol.is_empty() || symbol.starts_with("module_") || symbol.starts_with("???") {
        return None;
    }
    let (offset_hex, size_hex) = rest
        .split_once("/0x")
        .map(|(offset, size)| (offset, Some(size)))
        .unwrap_or((rest, None));
    let offset = u64::from_str_radix(offset_hex, 16).ok()?;
    let function_size = size_hex.and_then(|size| u64::from_str_radix(size, 16).ok());
    Some(ProfileSymbolOffset {
        symbol: symbol.to_owned(),
        offset,
        function_size,
    })
}

fn normalized_profile_counts(entries: &[CpuProfileTopStackEntry]) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for entry in entries {
        let Some(symbol) = normalize_profile_symbol(&entry.frame) else {
            continue;
        };
        *counts.entry(symbol).or_insert(0) += entry.samples;
    }
    counts
}

fn normalize_profile_symbol(frame: &str) -> Option<String> {
    let mut symbol = frame.trim();
    if symbol.is_empty() || symbol.starts_with("???") {
        return None;
    }
    if let Some((_, rhs)) = symbol.rsplit_once("::") {
        symbol = rhs;
    }
    if let Some((lhs, _)) = symbol.split_once('+') {
        symbol = lhs;
    }
    if let Some((lhs, _)) = symbol.split_once("  (in ") {
        symbol = lhs;
    }
    symbol = symbol.trim();
    (!symbol.is_empty() && !symbol.starts_with("module_")).then_some(symbol.to_owned())
}

fn resolve_cpu_profile_pid(
    requested_pid: u32,
    selection: CpuProfilePidSelection,
) -> Result<(u32, &'static str)> {
    match selection {
        CpuProfilePidSelection::Exact => Ok((requested_pid, "exact")),
        CpuProfilePidSelection::PreferActivePostgresChild => {
            if let Some(pid) = active_postgres_child_pid(requested_pid)? {
                Ok((pid, "active_postgres_child"))
            } else {
                Ok((requested_pid, "fallback_root"))
            }
        }
    }
}

fn active_postgres_child_pid(root_pid: u32) -> Result<Option<u32>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,stat=,command="])
        .output()
        .context("list process children for CPU profiling")?;
    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut best: Option<(i32, u32)> = None;
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(parent_pid), Some(stat)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(parent_pid)) = (pid.parse::<u32>(), parent_pid.parse::<u32>()) else {
            continue;
        };
        if parent_pid != root_pid {
            continue;
        }
        let command = parts.collect::<Vec<_>>().join(" ");
        let command_lower = command.to_ascii_lowercase();
        if !command_lower.contains("postgres") {
            continue;
        }
        if [
            "checkpointer",
            "background writer",
            "walwriter",
            "autovacuum launcher",
            "logical replication launcher",
        ]
        .iter()
        .any(|name| command_lower.contains(name))
        {
            continue;
        }

        let mut score = 0;
        if stat.contains('R') {
            score += 20;
        }
        if [" update", " insert", " select", " delete", " execute"]
            .iter()
            .any(|token| command_lower.contains(token))
        {
            score += 50;
        }
        if command_lower.contains(" idle") {
            score -= 25;
        }
        if command_lower.contains("127.0.0.1") || command_lower.contains("localhost") {
            score += 5;
        }

        if best.is_none_or(|(best_score, best_pid)| {
            score > best_score || (score == best_score && pid > best_pid)
        }) {
            best = Some((score, pid));
        }
    }

    Ok(best.map(|(_, pid)| pid))
}

fn tail_lossy_utf8(bytes: &[u8], limit: usize) -> String {
    let start = bytes.len().saturating_sub(limit);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn process_tree_rss_bytes(root_pid: u32) -> Result<Option<u64>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss="])
        .output()
        .context("sample process RSS with ps")?;
    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rss_by_pid = HashMap::<u32, u64>::new();
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(parent_pid), Some(rss_kb)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(parent_pid), Ok(rss_kb)) = (
            pid.parse::<u32>(),
            parent_pid.parse::<u32>(),
            rss_kb.parse::<u64>(),
        ) else {
            continue;
        };
        rss_by_pid.insert(pid, rss_kb.saturating_mul(1024));
        children_by_parent.entry(parent_pid).or_default().push(pid);
    }
    if !rss_by_pid.contains_key(&root_pid) {
        return Ok(None);
    }

    let mut total = 0u64;
    let mut stack = vec![root_pid];
    let mut seen = HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        total = total.saturating_add(rss_by_pid.get(&pid).copied().unwrap_or_default());
        if let Some(children) = children_by_parent.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }
    Ok(Some(total))
}

fn configure_native_postgres_client(config: &mut tokio_postgres::Config, native: &NativePostgres) {
    config.user("postgres").dbname("postgres").port(native.port);
    #[cfg(unix)]
    {
        config.host_path(&native.socket_dir);
    }
    #[cfg(not(unix))]
    {
        config.host("127.0.0.1");
    }
}

fn configure_native_postgres_tcp_client(
    config: &mut tokio_postgres::Config,
    native: &NativePostgres,
) {
    config
        .user("postgres")
        .dbname("postgres")
        .host("127.0.0.1")
        .port(native.port);
}

#[cfg(unix)]
fn default_native_postgres_perf_root() -> PathBuf {
    PathBuf::from("/tmp/pglite-oxide-perf")
}

#[cfg(not(unix))]
fn default_native_postgres_perf_root() -> PathBuf {
    env::temp_dir().join("pglite-oxide-perf")
}

impl Drop for NativePostgres {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            terminate_child_gracefully(&mut self.child);
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn terminate_child_gracefully(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}

fn perf_diagnose_indexed_update() -> Result<()> {
    Pglite::preload()?;

    let benchmark2 = read_pglite_benchmark_sql("2")?;
    let benchmark6 = read_pglite_benchmark_sql("6")?;
    let benchmark9 = read_pglite_benchmark_sql("9")?;
    let benchmark10 = read_pglite_benchmark_sql("10")?;
    let unlogged_benchmark2 = benchmark2.replace("CREATE TABLE", "CREATE UNLOGGED TABLE");
    let lookup_index_only = "CREATE INDEX i2a ON t2(a);\n";

    let cases = vec![
        run_indexed_update_diagnostic_case(
            "exact_numeric_indexed",
            "PGlite benchmark2 + benchmark6, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "exact_text_indexed",
            "PGlite benchmark2 + benchmark6, then exact benchmark10 text updates",
            &[benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_lookup_index_only",
            "PGlite benchmark2 + index on lookup column a only, then exact benchmark9 numeric updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_lookup_index_only",
            "PGlite benchmark2 + index on lookup column a only, then exact benchmark10 text updates",
            &[benchmark2.as_str(), lookup_index_only],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "numeric_unlogged_indexed",
            "PGlite benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark9 numeric updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark9,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_unlogged_indexed",
            "PGlite benchmark2 rewritten to UNLOGGED + benchmark6, then exact benchmark10 text updates",
            &[unlogged_benchmark2.as_str(), benchmark6.as_str()],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_indexed",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_vacuumed",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM t2, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
                "VACUUM t2;\n",
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "text_after_numeric_vacuum_full",
            "PGlite benchmark2 + benchmark6 + exact benchmark9 numeric updates + VACUUM FULL t2, then exact benchmark10 text updates",
            &[
                benchmark2.as_str(),
                benchmark6.as_str(),
                benchmark9.as_str(),
                "VACUUM FULL t2;\n",
            ],
            &benchmark10,
            25_000,
        )?,
        run_indexed_update_diagnostic_case(
            "set_based_numeric_indexed",
            "PGlite benchmark2 + benchmark6, then one set-based numeric update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET b = b + 1;\nCOMMIT;\n",
            1,
        )?,
        run_indexed_update_diagnostic_case(
            "set_based_text_indexed",
            "PGlite benchmark2 + benchmark6, then one set-based text update that changes every row",
            &[benchmark2.as_str(), benchmark6.as_str()],
            "BEGIN;\nUPDATE t2 SET c = c || ' updated';\nCOMMIT;\n",
            1,
        )?,
    ];

    let report = IndexedUpdateDiagnosticReport {
        source_model: "Exact PGlite benchmark SQL files from assets/checkouts/pglite/packages/benchmark/src plus controlled variants.",
        measurement_model: "Each case opens a fresh temporary database, runs setup outside the measured section, then records the measured update SQL and internal Rust/WASIX phase timings.",
        cases,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_diagnose_speed_hotspots() -> Result<()> {
    perf_diagnose_speed_ids(
        &["9", "10", "11", "14"],
        DiagnosticEngine::WasixLegacy,
        SpeedSqlSource::PgliteVendored,
        Path::new("postgres"),
        Path::new("initdb"),
        &DiagnosticOptions::default(),
    )
}

fn perf_diagnose_speed_cases(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    let mut engine = DiagnosticEngine::WasixLegacy;
    let mut speed_sql_source = SpeedSqlSource::Generated;
    let mut diagnostic_options = DiagnosticOptions::default();
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(raw_ids) = arg.strip_prefix("--ids=") {
            let parsed = raw_ids
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if parsed.is_empty() {
                bail!("--ids must contain at least one speed benchmark id");
            }
            ids = Some(parsed);
        } else if arg == "--ids" {
            cursor += 1;
            let raw_ids = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--ids requires a value"))?;
            let parsed = raw_ids
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if parsed.is_empty() {
                bail!("--ids must contain at least one speed benchmark id");
            }
            ids = Some(parsed);
        } else if let Some(raw_engine) = arg.strip_prefix("--engine=") {
            engine = DiagnosticEngine::parse(raw_engine)?;
        } else if arg == "--engine" {
            cursor += 1;
            let raw_engine = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--engine requires a value"))?;
            engine = DiagnosticEngine::parse(raw_engine)?;
        } else if let Some(raw_source) = arg.strip_prefix("--speed-source=") {
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if arg == "--speed-source" {
            cursor += 1;
            let raw_source = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if let Some(raw_samples) = arg
            .strip_prefix("--samples=")
            .or_else(|| arg.strip_prefix("--repeats="))
        {
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if arg == "--samples" || arg == "--repeats" {
            cursor += 1;
            let raw_samples = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if let Some(raw_repeats) = arg
            .strip_prefix("--target-repeats=")
            .or_else(|| arg.strip_prefix("--target-repeat-count="))
        {
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if arg == "--target-repeats" || arg == "--target-repeat-count" {
            cursor += 1;
            let raw_repeats = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if let Some(raw_mode) = arg
            .strip_prefix("--target-repeat-mode=")
            .or_else(|| arg.strip_prefix("--repeat-mode="))
        {
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if arg == "--target-repeat-mode" || arg == "--repeat-mode" {
            cursor += 1;
            let raw_mode = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if let Some(raw_path) = arg.strip_prefix("--sample-server=") {
            diagnostic_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
                output_path: PathBuf::from(raw_path),
                ..diagnostic_options.cpu_profile.take().unwrap_or_default()
            });
        } else if arg == "--sample-server" {
            cursor += 1;
            let raw_path = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-server requires an output path"))?;
            diagnostic_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
                output_path: PathBuf::from(raw_path),
                ..diagnostic_options.cpu_profile.take().unwrap_or_default()
            });
        } else if let Some(raw_seconds) = arg.strip_prefix("--sample-seconds=") {
            let mut profile = diagnostic_options.cpu_profile.take().unwrap_or_default();
            profile.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
            diagnostic_options.cpu_profile = Some(profile);
        } else if arg == "--sample-seconds" {
            cursor += 1;
            let raw_seconds = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-seconds requires a value"))?;
            let mut profile = diagnostic_options.cpu_profile.take().unwrap_or_default();
            profile.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
            diagnostic_options.cpu_profile = Some(profile);
        } else if let Some(raw_delay) = arg.strip_prefix("--sample-delay-ms=") {
            let mut profile = diagnostic_options.cpu_profile.take().unwrap_or_default();
            profile.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
            diagnostic_options.cpu_profile = Some(profile);
        } else if arg == "--sample-delay-ms" {
            cursor += 1;
            let raw_delay = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-delay-ms requires a value"))?;
            let mut profile = diagnostic_options.cpu_profile.take().unwrap_or_default();
            profile.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
            diagnostic_options.cpu_profile = Some(profile);
        } else if let Some(raw_set) = arg
            .strip_prefix("--runtime-set=")
            .or_else(|| arg.strip_prefix("--wasmer-runtime-set="))
            .or_else(|| arg.strip_prefix("--wasmer-set="))
        {
            diagnostic_options.wasmer_runtime_set = Some(named_wasmer_runtime_config_set(raw_set)?);
        } else if arg == "--runtime-set" || arg == "--wasmer-runtime-set" || arg == "--wasmer-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a runtime set name"))?;
            diagnostic_options.wasmer_runtime_set = Some(named_wasmer_runtime_config_set(raw_set)?);
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if let Some(raw_config) = arg
            .strip_prefix("--postgres-config=")
            .or_else(|| arg.strip_prefix("--guc="))
        {
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--postgres-config" || arg == "--guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--server-postgres-config=")
            .or_else(|| arg.strip_prefix("--server-guc="))
        {
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--server-postgres-config" || arg == "--server-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--native-postgres-config=")
            .or_else(|| arg.strip_prefix("--native-guc="))
        {
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--native-postgres-config" || arg == "--native-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if parse_diagnostic_setup_variant_arg(
            arg,
            args,
            &mut cursor,
            &mut diagnostic_options,
        )? {
        } else if skip_sampled_host_load_gate_arg(arg, args, &mut cursor)? {
        } else {
            bail!("unknown perf diagnose-speed-cases flag: {arg}");
        }
        cursor += 1;
    }
    diagnostic_options.host_load_gate = Some(sampled_host_load_gate_arg(
        args,
        diagnostic_options.samples,
    )?);

    let cases = speed_cases(1.0, speed_sql_source)?;
    let selected_ids = match ids {
        Some(ids) => ids,
        None => cases.iter().map(|case| case.id.to_owned()).collect(),
    };
    let selected_refs = selected_ids.iter().map(String::as_str).collect::<Vec<_>>();
    if diagnostic_options
        .cpu_profile
        .as_ref()
        .is_some_and(|profile| profile.output_path.as_os_str().is_empty())
    {
        bail!("--sample-seconds and --sample-delay-ms require --sample-server PATH");
    }
    if diagnostic_options.cpu_profile.is_some()
        && (selected_refs.len() != 1 || diagnostic_options.samples != 1)
    {
        bail!(
            "--sample-server requires exactly one --ids value and --samples=1 so the profile output path is unambiguous"
        );
    }
    if engine == DiagnosticEngine::NativeLibPglite
        && (selected_refs.len() != 1 || diagnostic_options.samples != 1)
    {
        bail!(
            "native libpglite speed diagnostics can run only one id and one sample per process; rerun once per id"
        );
    }
    perf_diagnose_speed_ids(
        &selected_refs,
        engine,
        speed_sql_source,
        &postgres_bin,
        &initdb_bin,
        &diagnostic_options,
    )
}

fn perf_diagnose_speed_parity(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut diagnostic_options = DiagnosticOptions::default();
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut global_postgres_configs = Vec::new();
    let mut config_sets = Vec::new();
    let mut runtime_sets = Vec::new();
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(raw_ids) = arg.strip_prefix("--ids=") {
            ids = Some(parse_speed_case_ids(raw_ids)?);
        } else if arg == "--ids" {
            cursor += 1;
            ids = Some(parse_speed_case_ids(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--ids requires a value"))?,
            )?);
        } else if let Some(raw_source) = arg.strip_prefix("--speed-source=") {
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if arg == "--speed-source" {
            cursor += 1;
            let raw_source = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if let Some(raw_samples) = arg
            .strip_prefix("--samples=")
            .or_else(|| arg.strip_prefix("--repeats="))
        {
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if arg == "--samples" || arg == "--repeats" {
            cursor += 1;
            let raw_samples = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if let Some(raw_repeats) = arg
            .strip_prefix("--target-repeats=")
            .or_else(|| arg.strip_prefix("--target-repeat-count="))
        {
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if arg == "--target-repeats" || arg == "--target-repeat-count" {
            cursor += 1;
            let raw_repeats = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if let Some(raw_mode) = arg
            .strip_prefix("--target-repeat-mode=")
            .or_else(|| arg.strip_prefix("--repeat-mode="))
        {
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if arg == "--target-repeat-mode" || arg == "--repeat-mode" {
            cursor += 1;
            let raw_mode = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if let Some(raw_config) = arg
            .strip_prefix("--postgres-config=")
            .or_else(|| arg.strip_prefix("--guc="))
        {
            global_postgres_configs.push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--postgres-config" || arg == "--guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            global_postgres_configs.push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--server-postgres-config=")
            .or_else(|| arg.strip_prefix("--server-guc="))
        {
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--server-postgres-config" || arg == "--server-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--native-postgres-config=")
            .or_else(|| arg.strip_prefix("--native-guc="))
        {
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--native-postgres-config" || arg == "--native-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_set) = arg
            .strip_prefix("--config-set=")
            .or_else(|| arg.strip_prefix("--guc-set="))
        {
            config_sets.push(named_speed_parity_config_set(raw_set)?);
        } else if arg == "--config-set" || arg == "--guc-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a config set name"))?;
            config_sets.push(named_speed_parity_config_set(raw_set)?);
        } else if arg == "--all-config-sets" || arg == "--all-guc-sets" {
            config_sets.extend(default_speed_parity_config_sets());
        } else if let Some(raw_set) = arg
            .strip_prefix("--runtime-set=")
            .or_else(|| arg.strip_prefix("--wasmer-runtime-set="))
            .or_else(|| arg.strip_prefix("--wasmer-set="))
        {
            runtime_sets.push(named_wasmer_runtime_config_set(raw_set)?);
        } else if arg == "--runtime-set" || arg == "--wasmer-runtime-set" || arg == "--wasmer-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a runtime set name"))?;
            runtime_sets.push(named_wasmer_runtime_config_set(raw_set)?);
        } else if arg == "--all-runtime-sets" || arg == "--all-wasmer-sets" {
            runtime_sets.extend(default_wasmer_runtime_config_sets());
        } else if parse_diagnostic_setup_variant_arg(
            arg,
            args,
            &mut cursor,
            &mut diagnostic_options,
        )? {
        } else if skip_sampled_host_load_gate_arg(arg, args, &mut cursor)? {
        } else {
            bail!("unknown perf diagnose-speed-parity flag: {arg}");
        }
        cursor += 1;
    }
    diagnostic_options.host_load_gate = Some(sampled_host_load_gate_arg(
        args,
        diagnostic_options.samples,
    )?);

    let cases = speed_cases(1.0, speed_sql_source)?;
    let selected_ids = match ids {
        Some(ids) => ids,
        None => cases
            .iter()
            .filter(|case| case.id != "16")
            .map(|case| case.id.to_owned())
            .collect(),
    };
    if config_sets.is_empty() {
        let has_custom_postgres_configs = !global_postgres_configs.is_empty()
            || !diagnostic_options.server_postgres_configs.is_empty()
            || !diagnostic_options.native_postgres_configs.is_empty();
        config_sets.push(SpeedParityConfigSetInput {
            name: if has_custom_postgres_configs {
                "custom".to_owned()
            } else {
                "default".to_owned()
            },
            postgres_configs: Vec::new(),
        });
    }
    if runtime_sets.is_empty() {
        runtime_sets.push(WasmerRuntimeConfigSetInput::default_set());
    }

    let mut report_sets = Vec::new();
    for mut config_set in config_sets {
        config_set
            .postgres_configs
            .extend(global_postgres_configs.iter().cloned());
        let mut base_options = diagnostic_options.clone();
        base_options.postgres_configs = config_set.postgres_configs.clone();
        let mut native_cases = HashMap::new();
        for id in &selected_ids {
            let native = run_speed_hotspot_diagnostic_case_samples(
                &cases,
                id,
                DiagnosticEngine::NativePostgresSqlx,
                &postgres_bin,
                &initdb_bin,
                &base_options,
            )?;
            native_cases.insert(id.clone(), native);
        }

        for runtime_set in &runtime_sets {
            let mut set_options = base_options.clone();
            set_options.wasmer_runtime_set = Some(runtime_set.clone());
            let mut parity_cases = Vec::new();
            for id in &selected_ids {
                let server = run_speed_hotspot_diagnostic_case_samples(
                    &cases,
                    id,
                    DiagnosticEngine::WasixServerSqlx,
                    &postgres_bin,
                    &initdb_bin,
                    &set_options,
                )?;
                let native = native_cases
                    .get(id)
                    .ok_or_else(|| anyhow!("missing native diagnostic result for case {id}"))?
                    .clone();
                parity_cases.push(speed_parity_case(server, native)?);
            }

            let worst_p90_ratio = parity_cases
                .iter()
                .filter_map(|case| case.p90_ratio)
                .reduce(f64::max);
            let worst_p90_delta_micros = parity_cases
                .iter()
                .filter_map(|case| case.p90_delta_micros)
                .max();
            report_sets.push(SpeedParityConfigSet {
                name: config_set.name.clone(),
                runtime_set: runtime_set.report(),
                runtime: benchmark_runtime_report_for_runtime_set(Some(runtime_set))?,
                postgres_configs: postgres_config_overrides(&config_set.postgres_configs),
                server_postgres_configs: postgres_config_overrides(
                    &set_options.server_postgres_configs,
                ),
                native_postgres_configs: postgres_config_overrides(
                    &set_options.native_postgres_configs,
                ),
                cases: parity_cases,
                worst_p90_ratio,
                worst_p90_delta_micros,
            });
        }
    }

    let report = SpeedParityDiagnosticReport {
        source_model: speed_sql_source.source_model(),
        measurement_model: "Runs each selected PGlite speed case through PG18 WASIX PgliteServer SQLx and native PostgreSQL 18 SQLx with identical setup SQL, common Postgres GUC overrides, and optional server/native-only GUC overrides, then reports p50/p90/p95 ratios and p90 deltas. Native PostgreSQL controls are run once per Postgres config set and reused across Wasmer runtime flag sets. Use --samples >= 5 for p90 gating; use --ids and --runtime-set/--all-runtime-sets for fast focused bottleneck iteration. For profile-oriented repeated targets, --target-repeat-mode=fresh-sql rewrites supported create-table/index and indexed-update cases so repeats remain representative inside one warm server.",
        completed: true,
        host_load_gate: diagnostic_options
            .host_load_gate
            .as_ref()
            .and_then(|gate| gate.report(diagnostic_options.samples)),
        host_load: capture_host_load_report(),
        setup_variant: diagnostic_setup_variant_report(&diagnostic_options),
        runtime: benchmark_runtime_report()?,
        config_sets: report_sets,
        errors: Vec::new(),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_diagnose_select_shapes(args: &[String]) -> Result<()> {
    let mut count = 5_000usize;
    let mut diagnostic_options = DiagnosticOptions {
        samples: 5,
        ..DiagnosticOptions::default()
    };
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut runtime_set = WasmerRuntimeConfigSetInput::default_set();
    let mut selected_shape_ids: Option<Vec<String>> = None;
    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(raw_count) = arg.strip_prefix("--count=") {
            count = raw_count
                .parse()
                .with_context(|| format!("parse {arg} select shape count"))?;
            ensure!(count > 0, "--count must be greater than zero");
        } else if arg == "--count" {
            cursor += 1;
            let raw_count = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--count requires a value"))?;
            count = raw_count
                .parse()
                .with_context(|| format!("parse {arg} select shape count"))?;
            ensure!(count > 0, "--count must be greater than zero");
        } else if let Some(raw_samples) = arg
            .strip_prefix("--samples=")
            .or_else(|| arg.strip_prefix("--repeats="))
        {
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if arg == "--samples" || arg == "--repeats" {
            cursor += 1;
            let raw_samples = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.samples = raw_samples
                .parse()
                .with_context(|| format!("parse {arg} sample count"))?;
            ensure!(
                diagnostic_options.samples > 0,
                "--samples must be greater than zero"
            );
        } else if let Some(raw_ids) = arg
            .strip_prefix("--shapes=")
            .or_else(|| arg.strip_prefix("--ids="))
        {
            selected_shape_ids = Some(parse_speed_case_ids(raw_ids)?);
        } else if arg == "--shapes" || arg == "--ids" {
            cursor += 1;
            selected_shape_ids = Some(parse_speed_case_ids(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("{arg} requires a value"))?,
            )?);
        } else if let Some(raw_set) = arg
            .strip_prefix("--runtime-set=")
            .or_else(|| arg.strip_prefix("--wasmer-runtime-set="))
            .or_else(|| arg.strip_prefix("--wasmer-set="))
        {
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--runtime-set" || arg == "--wasmer-runtime-set" || arg == "--wasmer-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a runtime set name"))?;
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if let Some(raw_config) = arg
            .strip_prefix("--postgres-config=")
            .or_else(|| arg.strip_prefix("--guc="))
        {
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--postgres-config" || arg == "--guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--server-postgres-config=")
            .or_else(|| arg.strip_prefix("--server-guc="))
        {
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--server-postgres-config" || arg == "--server-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--native-postgres-config=")
            .or_else(|| arg.strip_prefix("--native-guc="))
        {
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--native-postgres-config" || arg == "--native-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if parse_diagnostic_setup_variant_arg(
            arg,
            args,
            &mut cursor,
            &mut diagnostic_options,
        )? {
        } else {
            bail!("unknown perf diagnose-select-shapes flag: {arg}");
        }
        cursor += 1;
    }

    let speed_cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let setup_cases = speed_cases
        .into_iter()
        .take_while(|case| case.id != "7")
        .collect::<Vec<_>>();
    let mut shapes = select_shape_speed_cases(count);
    if let Some(selected_shape_ids) = selected_shape_ids {
        let selected = selected_shape_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let known = shapes.iter().map(|shape| shape.id).collect::<HashSet<_>>();
        for selected_id in &selected_shape_ids {
            ensure!(
                known.contains(selected_id.as_str()),
                "unknown select shape {selected_id:?}; known shapes are {}",
                known.iter().copied().collect::<Vec<_>>().join(", ")
            );
        }
        shapes.retain(|shape| selected.contains(shape.id));
    }
    diagnostic_options.wasmer_runtime_set = Some(runtime_set.clone());
    let native_cases = run_native_postgres_sqlx_select_shape_samples(
        &setup_cases,
        &shapes,
        &postgres_bin,
        &initdb_bin,
        &diagnostic_options,
    )?;
    let server_cases =
        run_server_sqlx_select_shape_samples(&setup_cases, &shapes, &diagnostic_options)?;
    let mut parity_cases = Vec::new();
    for shape in &shapes {
        let native = native_cases
            .get(shape.id)
            .ok_or_else(|| anyhow!("missing native select-shape result for {}", shape.id))?
            .clone();
        let server = server_cases
            .get(shape.id)
            .ok_or_else(|| anyhow!("missing server select-shape result for {}", shape.id))?
            .clone();
        parity_cases.push(speed_parity_case(server, native)?);
    }

    let worst_p90_ratio = parity_cases
        .iter()
        .filter_map(|case| case.p90_ratio)
        .reduce(f64::max);
    let worst_p90_delta_micros = parity_cases
        .iter()
        .filter_map(|case| case.p90_delta_micros)
        .max();
    let report = SpeedParityDiagnosticReport {
        source_model: "Exact PGlite speed setup through the cases before benchmark7, followed by controlled SELECT-only target shapes derived from benchmark7.",
        measurement_model: "Each sample opens a fresh PG18 WASIX PgliteServer SQLx instance and a native PostgreSQL 18 SQLx control, runs every PGlite speed case before benchmark7 as setup, then measures controlled SELECT batches. Shapes split benchmark7 into parser/protocol baseline, same-predicate range scans, distinct range aggregates, index-only LIMIT reads, and heap/text LIMIT reads.",
        completed: true,
        host_load_gate: diagnostic_options
            .host_load_gate
            .as_ref()
            .and_then(|gate| gate.report(diagnostic_options.samples)),
        host_load: capture_host_load_report(),
        setup_variant: diagnostic_setup_variant_report(&diagnostic_options),
        runtime: benchmark_runtime_report()?,
        config_sets: vec![SpeedParityConfigSet {
            name: "select-shapes".to_owned(),
            runtime_set: runtime_set.report(),
            runtime: benchmark_runtime_report_for_runtime_set(Some(&runtime_set))?,
            postgres_configs: postgres_config_overrides(&diagnostic_options.postgres_configs),
            server_postgres_configs: postgres_config_overrides(
                &diagnostic_options.server_postgres_configs,
            ),
            native_postgres_configs: postgres_config_overrides(
                &diagnostic_options.native_postgres_configs,
            ),
            cases: parity_cases,
            worst_p90_ratio,
            worst_p90_delta_micros,
        }],
        errors: Vec::new(),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn perf_diagnose_select_shape_profile_compare(args: &[String]) -> Result<()> {
    let mut count = 5_000usize;
    let mut diagnostic_options = DiagnosticOptions {
        target_repeats: 100,
        target_repeat_mode: TargetRepeatMode::SameSql,
        ..DiagnosticOptions::default()
    };
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut output_dir: Option<PathBuf> = None;
    let mut function_map: Option<PathBuf> = None;
    let mut runtime_set = WasmerRuntimeConfigSetInput::default_set();
    let mut profile_options = DiagnosticCpuProfileOptions {
        seconds: 5,
        delay: Duration::from_millis(100),
        ..DiagnosticCpuProfileOptions::default()
    };
    let mut selected_shape_ids: Option<Vec<String>> = None;

    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(raw_count) = arg.strip_prefix("--count=") {
            count = raw_count
                .parse()
                .with_context(|| format!("parse {arg} select shape count"))?;
            ensure!(count > 0, "--count must be greater than zero");
        } else if arg == "--count" {
            cursor += 1;
            let raw_count = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--count requires a value"))?;
            count = raw_count
                .parse()
                .with_context(|| format!("parse {arg} select shape count"))?;
            ensure!(count > 0, "--count must be greater than zero");
        } else if let Some(raw_ids) = arg
            .strip_prefix("--shapes=")
            .or_else(|| arg.strip_prefix("--ids="))
        {
            selected_shape_ids = Some(parse_speed_case_ids(raw_ids)?);
        } else if arg == "--shapes" || arg == "--ids" {
            cursor += 1;
            selected_shape_ids = Some(parse_speed_case_ids(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("{arg} requires a value"))?,
            )?);
        } else if let Some(raw_repeats) = arg
            .strip_prefix("--target-repeats=")
            .or_else(|| arg.strip_prefix("--target-repeat-count="))
        {
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if arg == "--target-repeats" || arg == "--target-repeat-count" {
            cursor += 1;
            let raw_repeats = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if let Some(raw_mode) = arg
            .strip_prefix("--target-repeat-mode=")
            .or_else(|| arg.strip_prefix("--repeat-mode="))
        {
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if arg == "--target-repeat-mode" || arg == "--repeat-mode" {
            cursor += 1;
            let raw_mode = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if let Some(raw_seconds) = arg.strip_prefix("--sample-seconds=") {
            profile_options.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile_options.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
        } else if arg == "--sample-seconds" {
            cursor += 1;
            let raw_seconds = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-seconds requires a value"))?;
            profile_options.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile_options.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
        } else if let Some(raw_delay) = arg.strip_prefix("--sample-delay-ms=") {
            profile_options.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
        } else if arg == "--sample-delay-ms" {
            cursor += 1;
            let raw_delay = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-delay-ms requires a value"))?;
            profile_options.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
        } else if let Some(raw_dir) = arg.strip_prefix("--output-dir=") {
            output_dir = Some(PathBuf::from(raw_dir));
        } else if arg == "--output-dir" || arg == "--out" {
            cursor += 1;
            let raw_dir = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            output_dir = Some(PathBuf::from(raw_dir));
        } else if let Some(raw_map) = arg
            .strip_prefix("--function-map=")
            .or_else(|| arg.strip_prefix("--wasm-function-map="))
        {
            function_map = Some(PathBuf::from(raw_map));
        } else if arg == "--function-map" || arg == "--wasm-function-map" {
            cursor += 1;
            let raw_map = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            function_map = Some(PathBuf::from(raw_map));
        } else if let Some(raw_set) = arg
            .strip_prefix("--runtime-set=")
            .or_else(|| arg.strip_prefix("--wasmer-runtime-set="))
            .or_else(|| arg.strip_prefix("--wasmer-set="))
        {
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--runtime-set" || arg == "--wasmer-runtime-set" || arg == "--wasmer-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a runtime set name"))?;
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if let Some(raw_config) = arg
            .strip_prefix("--postgres-config=")
            .or_else(|| arg.strip_prefix("--guc="))
        {
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--postgres-config" || arg == "--guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--server-postgres-config=")
            .or_else(|| arg.strip_prefix("--server-guc="))
        {
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--server-postgres-config" || arg == "--server-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--native-postgres-config=")
            .or_else(|| arg.strip_prefix("--native-guc="))
        {
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--native-postgres-config" || arg == "--native-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if parse_diagnostic_setup_variant_arg(
            arg,
            args,
            &mut cursor,
            &mut diagnostic_options,
        )? {
        } else {
            bail!("unknown perf diagnose-select-shape-profile-compare flag: {arg}");
        }
        cursor += 1;
    }

    let speed_cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let setup_cases = speed_cases
        .into_iter()
        .take_while(|case| case.id != "7")
        .collect::<Vec<_>>();
    let mut shapes = select_shape_speed_cases(count);
    if let Some(selected_shape_ids) = selected_shape_ids {
        let selected = selected_shape_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let known = shapes.iter().map(|shape| shape.id).collect::<HashSet<_>>();
        for selected_id in &selected_shape_ids {
            ensure!(
                known.contains(selected_id.as_str()),
                "unknown select shape {selected_id:?}; known shapes are {}",
                known.iter().copied().collect::<Vec<_>>().join(", ")
            );
        }
        shapes.retain(|shape| selected.contains(shape.id));
    } else {
        shapes.retain(|shape| shape.id == "select_count_avg_distinct_ranges");
    }

    let output_dir = output_dir.unwrap_or_else(|| {
        Path::new("target/perf").join(format!(
            "pg18-select-shape-profile-compare-{}",
            now_micros().unwrap_or(0)
        ))
    });
    fs::create_dir_all(&output_dir).with_context(|| {
        format!(
            "create select-shape profile compare output dir {}",
            output_dir.display()
        )
    })?;
    let function_map = match function_map {
        Some(function_map) => Some(function_map),
        None => default_postgres_export_function_map(&output_dir)?,
    };

    let mut report_cases = Vec::new();
    for shape in shapes {
        let case_dir = output_dir.join(format!("shape-{}", shape.id.replace('.', "_")));
        fs::create_dir_all(&case_dir)
            .with_context(|| format!("create select-shape case dir {}", case_dir.display()))?;
        let mut cases = setup_cases.clone();
        cases.push(shape.clone());

        let mut server_runtime_set = runtime_set.clone();
        server_runtime_set.wasmer_profiler = Some("perfmap".to_owned());
        let mut server_options = diagnostic_options.clone();
        server_options.wasmer_runtime_set = Some(server_runtime_set);
        server_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
            output_path: case_dir.join("server.sample.txt"),
            ..profile_options.clone()
        });
        let server = run_speed_hotspot_diagnostic_case_samples(
            &cases,
            shape.id,
            DiagnosticEngine::WasixServerSqlx,
            &postgres_bin,
            &initdb_bin,
            &server_options,
        )?;

        let mut native_options = diagnostic_options.clone();
        native_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
            output_path: case_dir.join("native.sample.txt"),
            ..profile_options.clone()
        });
        let native = run_speed_hotspot_diagnostic_case_samples(
            &cases,
            shape.id,
            DiagnosticEngine::NativePostgresSqlx,
            &postgres_bin,
            &initdb_bin,
            &native_options,
        )?;

        let server_symbolization =
            symbolize_wasix_profile(&server, &case_dir, function_map.as_deref())?;
        let server_top_symbols = server_symbolization
            .as_ref()
            .map(|symbolization| symbolization.top_stack.clone())
            .unwrap_or_else(|| non_idle_profile_top_stack(&cpu_profile_top_stack(&server)));
        let native_top_symbols = non_idle_profile_top_stack(&cpu_profile_top_stack(&native));
        let common_hotspots =
            compare_profile_hotspots(&server_top_symbols, &native_top_symbols, 32);
        let server_offset_hotspots = profile_offset_hotspots(&server_top_symbols, 16, 12);
        let server_callsite_targets = profile_callsite_target_symbols(&server_top_symbols, 8);
        let server_callsite_hotspots = profile_callsite_hotspots(
            server_symbolization.as_ref(),
            &server_callsite_targets,
            &server_top_symbols,
            8,
            8,
        )?;
        let elapsed_delta_micros = server.elapsed_micros as i128 - native.elapsed_micros as i128;
        let elapsed_ratio = (native.elapsed_micros > 0)
            .then_some(server.elapsed_micros as f64 / native.elapsed_micros as f64);

        report_cases.push(SpeedProfileCompareCase {
            id: shape.id.to_owned(),
            label: shape.label.clone(),
            operation_count: shape
                .operation_count
                .saturating_mul(diagnostic_options.target_repeats),
            target_repeat_count: diagnostic_options.target_repeats,
            target_repeat_mode: diagnostic_options.target_repeat_mode.label(),
            elapsed_ratio,
            elapsed_delta_micros,
            server,
            native,
            server_symbolization,
            server_top_symbols,
            native_top_symbols,
            common_hotspots,
            server_offset_hotspots,
            server_callsite_hotspots,
        });
    }

    let mut report_runtime_set = runtime_set;
    report_runtime_set.wasmer_profiler = Some("perfmap".to_owned());
    let report = SpeedProfileCompareReport {
        source_model: "PGlite benchmark7 select-shape diagnostics over the vendored PG18 speed setup.",
        measurement_model: "Runs each selected SELECT shape once on PG18 WASIX PgliteServer SQLx and once on native PostgreSQL 18 SQLx with identical setup SQL, target repeat count, common and side-specific Postgres GUC overrides, and optional setup rewrites. Both runs are sampled with macOS sample(1); the server run forces Wasmer --profiler perfmap and attempts to annotate the perf map with PostgreSQL symbols.",
        output_dir: output_dir.display().to_string(),
        setup_variant: diagnostic_setup_variant_report(&diagnostic_options),
        runtime: benchmark_runtime_report_for_runtime_set(Some(&report_runtime_set))?,
        cases: report_cases,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_server_sqlx_select_shape_samples(
    setup_cases: &[SpeedCase],
    shapes: &[SpeedCase],
    options: &DiagnosticOptions,
) -> Result<HashMap<String, SpeedHotspotDiagnosticCase>> {
    let mut samples_by_id = shapes
        .iter()
        .map(|shape| (shape.id.to_owned(), Vec::with_capacity(options.samples)))
        .collect::<HashMap<_, _>>();

    for _ in 0..options.samples {
        let open_started = Instant::now();
        let runtime_config = options
            .wasmer_runtime_set
            .as_ref()
            .and_then(WasmerRuntimeConfigSetInput::runtime_config);
        let postgres_configs = server_postgres_configs(options);
        let server = benchmark_pglite_server_with_configs_and_runtime(
            &postgres_configs,
            runtime_config.as_ref(),
        )
        .context("start server select-shape diagnostic database")?;
        let open_micros = open_started.elapsed().as_micros();
        let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
        let uri = server.database_url();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create server select-shape diagnostic Tokio runtime")?;

        let (connect_micros, setup_micros, settings, elapsed_by_id) = runtime.block_on(async {
            let connect_started = Instant::now();
            let mut conn = sqlx::PgConnection::connect(&uri)
                .await
                .context("connect server select-shape diagnostic client")?;
            let connect_micros = connect_started.elapsed().as_micros();

            let setup_started = Instant::now();
            for setup_case in setup_cases {
                let setup_sql = setup_sql_for_case(setup_case, options);
                conn.execute(setup_sql.as_str()).await.with_context(|| {
                    format!("run server select-shape setup case {}", setup_case.id)
                })?;
            }
            let setup_micros = setup_started.elapsed().as_micros();
            let settings = sqlx_settings_json(&mut conn)
                .await
                .context("query server select-shape settings")?;
            sample_optional_rss(&mut server_rss);

            let mut elapsed_by_id = HashMap::new();
            for shape in shapes {
                let started = Instant::now();
                conn.execute(shape.sql.as_str()).await.with_context(|| {
                    format!("run server select-shape measured case {}", shape.id)
                })?;
                elapsed_by_id.insert(shape.id.to_owned(), started.elapsed().as_micros());
                sample_optional_rss(&mut server_rss);
            }
            conn.close()
                .await
                .context("close server select-shape diagnostic client")?;
            Ok::<_, anyhow::Error>((connect_micros, setup_micros, settings, elapsed_by_id))
        })?;
        server.shutdown()?;

        for shape in shapes {
            let elapsed_micros = *elapsed_by_id
                .get(shape.id)
                .ok_or_else(|| anyhow!("missing elapsed time for server shape {}", shape.id))?;
            samples_by_id
                .get_mut(shape.id)
                .expect("select shape sample bucket exists")
                .push(speed_hotspot_case(
                    DiagnosticEngine::WasixServerSqlx.label(),
                    shape.id.to_owned(),
                    shape.label.clone(),
                    Some(open_micros),
                    Some(connect_micros),
                    setup_micros,
                    elapsed_micros,
                    shape.operation_count,
                    1,
                    TargetRepeatMode::SameSql,
                    None,
                    optional_peak_rss(&server_rss),
                    settings.clone(),
                    serde_json::json!({
                        "enabled": false,
                        "reason": "PG18 server SQLx select-shape diagnostic runs through an external PgliteServer process"
                    }),
                    vec![
                        PhaseTiming {
                            name: "server.open",
                            elapsed_micros: open_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.connect",
                            elapsed_micros: connect_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.setup",
                            elapsed_micros: setup_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.execute",
                            elapsed_micros,
                        },
                    ],
                    None,
                ));
        }
    }

    Ok(samples_by_id
        .into_iter()
        .map(|(id, samples)| (id, aggregate_speed_hotspot_samples(samples)))
        .collect())
}

fn run_native_postgres_sqlx_select_shape_samples(
    setup_cases: &[SpeedCase],
    shapes: &[SpeedCase],
    postgres_bin: &Path,
    initdb_bin: &Path,
    options: &DiagnosticOptions,
) -> Result<HashMap<String, SpeedHotspotDiagnosticCase>> {
    let mut samples_by_id = shapes
        .iter()
        .map(|shape| (shape.id.to_owned(), Vec::with_capacity(options.samples)))
        .collect::<HashMap<_, _>>();

    for _ in 0..options.samples {
        let open_started = Instant::now();
        let postgres_configs = native_postgres_configs(options);
        let native =
            NativePostgres::start_with_configs(postgres_bin, initdb_bin, &postgres_configs)
                .context("start native Postgres select-shape diagnostic cluster")?;
        let open_micros = open_started.elapsed().as_micros();
        let mut server_rss = ProcessTreeRssSampler::new(native.child.id());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create native Postgres select-shape diagnostic Tokio runtime")?;

        let (connect_micros, setup_micros, settings, elapsed_by_id) = runtime.block_on(async {
            let connect_started = Instant::now();
            let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
                .await
                .context("connect native Postgres select-shape diagnostic client")?;
            let connect_micros = connect_started.elapsed().as_micros();

            let setup_started = Instant::now();
            for setup_case in setup_cases {
                let setup_sql = setup_sql_for_case(setup_case, options);
                conn.execute(setup_sql.as_str()).await.with_context(|| {
                    format!(
                        "run native Postgres select-shape setup case {}",
                        setup_case.id
                    )
                })?;
            }
            let setup_micros = setup_started.elapsed().as_micros();
            let settings = sqlx_settings_json(&mut conn)
                .await
                .context("query native Postgres select-shape settings")?;
            server_rss.sample();

            let mut elapsed_by_id = HashMap::new();
            for shape in shapes {
                let started = Instant::now();
                conn.execute(shape.sql.as_str()).await.with_context(|| {
                    format!(
                        "run native Postgres select-shape measured case {}",
                        shape.id
                    )
                })?;
                elapsed_by_id.insert(shape.id.to_owned(), started.elapsed().as_micros());
                server_rss.sample();
            }
            conn.close()
                .await
                .context("close native Postgres select-shape diagnostic client")?;
            Ok::<_, anyhow::Error>((connect_micros, setup_micros, settings, elapsed_by_id))
        })?;

        for shape in shapes {
            let elapsed_micros = *elapsed_by_id
                .get(shape.id)
                .ok_or_else(|| anyhow!("missing elapsed time for native shape {}", shape.id))?;
            samples_by_id
                .get_mut(shape.id)
                .expect("select shape sample bucket exists")
                .push(speed_hotspot_case(
                    DiagnosticEngine::NativePostgresSqlx.label(),
                    shape.id.to_owned(),
                    shape.label.clone(),
                    Some(open_micros),
                    Some(connect_micros),
                    setup_micros,
                    elapsed_micros,
                    shape.operation_count,
                    1,
                    TargetRepeatMode::SameSql,
                    None,
                    server_rss.peak_bytes(),
                    settings.clone(),
                    serde_json::json!({
                        "enabled": false,
                        "reason": "native PostgreSQL SQLx select-shape diagnostic runs in an external server process"
                    }),
                    vec![
                        PhaseTiming {
                            name: "native_postgres.open",
                            elapsed_micros: open_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.connect",
                            elapsed_micros: connect_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.setup",
                            elapsed_micros: setup_micros,
                        },
                        PhaseTiming {
                            name: "client.sqlx.execute",
                            elapsed_micros,
                        },
                    ],
                    None,
                ));
        }
    }

    Ok(samples_by_id
        .into_iter()
        .map(|(id, samples)| (id, aggregate_speed_hotspot_samples(samples)))
        .collect())
}

fn perf_diagnose_speed_profile_compare(args: &[String]) -> Result<()> {
    let mut ids: Option<Vec<String>> = None;
    let mut speed_sql_source = SpeedSqlSource::PgliteVendored;
    let mut diagnostic_options = DiagnosticOptions {
        target_repeats: 10,
        target_repeat_mode: TargetRepeatMode::FreshSql,
        ..DiagnosticOptions::default()
    };
    let mut postgres_bin = env::var("PGLITE_OXIDE_NATIVE_POSTGRES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("postgres"));
    let mut initdb_bin = env::var("PGLITE_OXIDE_NATIVE_INITDB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("initdb"));
    let mut output_dir: Option<PathBuf> = None;
    let mut function_map: Option<PathBuf> = None;
    let mut runtime_set = WasmerRuntimeConfigSetInput::default_set();
    let mut profile_options = DiagnosticCpuProfileOptions {
        seconds: 5,
        delay: Duration::from_millis(100),
        ..DiagnosticCpuProfileOptions::default()
    };

    let mut cursor = 0usize;
    while cursor < args.len() {
        let arg = &args[cursor];
        if let Some(raw_ids) = arg.strip_prefix("--ids=") {
            ids = Some(parse_speed_case_ids(raw_ids)?);
        } else if arg == "--ids" {
            cursor += 1;
            ids = Some(parse_speed_case_ids(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--ids requires a value"))?,
            )?);
        } else if let Some(raw_source) = arg.strip_prefix("--speed-source=") {
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if arg == "--speed-source" {
            cursor += 1;
            let raw_source = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--speed-source requires a value"))?;
            speed_sql_source = SpeedSqlSource::parse(raw_source)?;
        } else if let Some(raw_repeats) = arg
            .strip_prefix("--target-repeats=")
            .or_else(|| arg.strip_prefix("--target-repeat-count="))
        {
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if arg == "--target-repeats" || arg == "--target-repeat-count" {
            cursor += 1;
            let raw_repeats = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeats = raw_repeats
                .parse()
                .with_context(|| format!("parse {arg} target repeat count"))?;
            ensure!(
                diagnostic_options.target_repeats > 0,
                "--target-repeats must be greater than zero"
            );
        } else if let Some(raw_mode) = arg
            .strip_prefix("--target-repeat-mode=")
            .or_else(|| arg.strip_prefix("--repeat-mode="))
        {
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if arg == "--target-repeat-mode" || arg == "--repeat-mode" {
            cursor += 1;
            let raw_mode = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            diagnostic_options.target_repeat_mode = TargetRepeatMode::parse(raw_mode)?;
        } else if let Some(raw_seconds) = arg.strip_prefix("--sample-seconds=") {
            profile_options.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile_options.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
        } else if arg == "--sample-seconds" {
            cursor += 1;
            let raw_seconds = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-seconds requires a value"))?;
            profile_options.seconds = raw_seconds
                .parse()
                .with_context(|| format!("parse {arg} sample duration"))?;
            ensure!(
                profile_options.seconds > 0,
                "--sample-seconds must be greater than zero"
            );
        } else if let Some(raw_delay) = arg.strip_prefix("--sample-delay-ms=") {
            profile_options.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
        } else if arg == "--sample-delay-ms" {
            cursor += 1;
            let raw_delay = args
                .get(cursor)
                .ok_or_else(|| anyhow!("--sample-delay-ms requires a value"))?;
            profile_options.delay = Duration::from_millis(
                raw_delay
                    .parse()
                    .with_context(|| format!("parse {arg} sample delay"))?,
            );
        } else if let Some(raw_dir) = arg.strip_prefix("--output-dir=") {
            output_dir = Some(PathBuf::from(raw_dir));
        } else if arg == "--output-dir" || arg == "--out" {
            cursor += 1;
            let raw_dir = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            output_dir = Some(PathBuf::from(raw_dir));
        } else if let Some(raw_map) = arg
            .strip_prefix("--function-map=")
            .or_else(|| arg.strip_prefix("--wasm-function-map="))
        {
            function_map = Some(PathBuf::from(raw_map));
        } else if arg == "--function-map" || arg == "--wasm-function-map" {
            cursor += 1;
            let raw_map = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            function_map = Some(PathBuf::from(raw_map));
        } else if let Some(raw_set) = arg
            .strip_prefix("--runtime-set=")
            .or_else(|| arg.strip_prefix("--wasmer-runtime-set="))
            .or_else(|| arg.strip_prefix("--wasmer-set="))
        {
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--runtime-set" || arg == "--wasmer-runtime-set" || arg == "--wasmer-set" {
            cursor += 1;
            let raw_set = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a runtime set name"))?;
            runtime_set = named_wasmer_runtime_config_set(raw_set)?;
        } else if arg == "--postgres-bin" {
            cursor += 1;
            postgres_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--postgres-bin requires a value"))?,
            );
        } else if arg == "--initdb-bin" {
            cursor += 1;
            initdb_bin = PathBuf::from(
                args.get(cursor)
                    .ok_or_else(|| anyhow!("--initdb-bin requires a value"))?,
            );
        } else if let Some(raw_config) = arg
            .strip_prefix("--postgres-config=")
            .or_else(|| arg.strip_prefix("--guc="))
        {
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--postgres-config" || arg == "--guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--server-postgres-config=")
            .or_else(|| arg.strip_prefix("--server-guc="))
        {
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--server-postgres-config" || arg == "--server-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .server_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if let Some(raw_config) = arg
            .strip_prefix("--native-postgres-config=")
            .or_else(|| arg.strip_prefix("--native-guc="))
        {
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if arg == "--native-postgres-config" || arg == "--native-guc" {
            cursor += 1;
            let raw_config = args
                .get(cursor)
                .ok_or_else(|| anyhow!("{arg} requires a name=value pair"))?;
            diagnostic_options
                .native_postgres_configs
                .push(parse_postgres_config_arg(raw_config)?);
        } else if parse_diagnostic_setup_variant_arg(
            arg,
            args,
            &mut cursor,
            &mut diagnostic_options,
        )? {
        } else {
            bail!("unknown perf diagnose-speed-profile-compare flag: {arg}");
        }
        cursor += 1;
    }

    let output_dir = output_dir.unwrap_or_else(|| {
        Path::new("target/perf").join(format!(
            "pg18-speed-profile-compare-{}",
            now_micros().unwrap_or(0)
        ))
    });
    fs::create_dir_all(&output_dir)
        .with_context(|| format!("create profile compare output dir {}", output_dir.display()))?;

    let cases = speed_cases(1.0, speed_sql_source)?;
    let selected_ids = ids.unwrap_or_else(|| vec!["10".to_owned()]);
    let function_map = match function_map {
        Some(function_map) => Some(function_map),
        None => default_postgres_export_function_map(&output_dir)?,
    };
    let mut report_cases = Vec::new();
    for id in selected_ids {
        let target = cases
            .iter()
            .find(|case| case.id == id)
            .ok_or_else(|| anyhow!("unknown speed profile compare case {id}"))?;
        let case_dir = output_dir.join(format!("case-{}", id.replace('.', "_")));
        fs::create_dir_all(&case_dir)
            .with_context(|| format!("create profile compare case dir {}", case_dir.display()))?;

        let mut server_runtime_set = runtime_set.clone();
        server_runtime_set.wasmer_profiler = Some("perfmap".to_owned());
        let mut server_options = diagnostic_options.clone();
        server_options.wasmer_runtime_set = Some(server_runtime_set);
        server_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
            output_path: case_dir.join("server.sample.txt"),
            ..profile_options.clone()
        });
        let server = run_speed_hotspot_diagnostic_case_samples(
            &cases,
            &id,
            DiagnosticEngine::WasixServerSqlx,
            &postgres_bin,
            &initdb_bin,
            &server_options,
        )?;

        let mut native_options = diagnostic_options.clone();
        native_options.cpu_profile = Some(DiagnosticCpuProfileOptions {
            output_path: case_dir.join("native.sample.txt"),
            ..profile_options.clone()
        });
        let native = run_speed_hotspot_diagnostic_case_samples(
            &cases,
            &id,
            DiagnosticEngine::NativePostgresSqlx,
            &postgres_bin,
            &initdb_bin,
            &native_options,
        )?;

        let server_symbolization =
            symbolize_wasix_profile(&server, &case_dir, function_map.as_deref())?;
        let server_top_symbols = server_symbolization
            .as_ref()
            .map(|symbolization| symbolization.top_stack.clone())
            .unwrap_or_else(|| non_idle_profile_top_stack(&cpu_profile_top_stack(&server)));
        let native_top_symbols = non_idle_profile_top_stack(&cpu_profile_top_stack(&native));
        let common_hotspots =
            compare_profile_hotspots(&server_top_symbols, &native_top_symbols, 32);
        let server_offset_hotspots = profile_offset_hotspots(&server_top_symbols, 16, 12);
        let server_callsite_targets = profile_callsite_target_symbols(&server_top_symbols, 8);
        let server_callsite_hotspots = profile_callsite_hotspots(
            server_symbolization.as_ref(),
            &server_callsite_targets,
            &server_top_symbols,
            8,
            8,
        )?;
        let elapsed_delta_micros = server.elapsed_micros as i128 - native.elapsed_micros as i128;
        let elapsed_ratio = (native.elapsed_micros > 0)
            .then_some(server.elapsed_micros as f64 / native.elapsed_micros as f64);

        report_cases.push(SpeedProfileCompareCase {
            id: target.id.to_owned(),
            label: target.label.clone(),
            operation_count: target
                .operation_count
                .saturating_mul(diagnostic_options.target_repeats),
            target_repeat_count: diagnostic_options.target_repeats,
            target_repeat_mode: diagnostic_options.target_repeat_mode.label(),
            elapsed_ratio,
            elapsed_delta_micros,
            server,
            native,
            server_symbolization,
            server_top_symbols,
            native_top_symbols,
            common_hotspots,
            server_offset_hotspots,
            server_callsite_hotspots,
        });
    }

    let mut report_runtime_set = runtime_set;
    report_runtime_set.wasmer_profiler = Some("perfmap".to_owned());
    let report = SpeedProfileCompareReport {
        source_model: speed_sql_source.source_model(),
        measurement_model: "Runs each selected speed case once on PG18 WASIX PgliteServer SQLx and once on native PostgreSQL 18 SQLx with identical setup SQL, target repeat mode, target repeat count, common Postgres GUC overrides, and optional server/native-only GUC overrides. Both runs are sampled with macOS sample(1); the server run forces Wasmer --profiler perfmap and attempts to annotate the perf map with PostgreSQL name-section/export names before producing side-by-side top-stack and common-hotspot summaries. The side-by-side top-symbol lists filter known idle/wait frames; raw sample top stacks remain available under each run's cpuProfile.",
        output_dir: output_dir.display().to_string(),
        setup_variant: diagnostic_setup_variant_report(&diagnostic_options),
        runtime: benchmark_runtime_report_for_runtime_set(Some(&report_runtime_set))?,
        cases: report_cases,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[derive(Debug, Clone)]
struct SpeedParityConfigSetInput {
    name: String,
    postgres_configs: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
struct WasmerRuntimeConfigSetInput {
    name: String,
    compiler: Option<WasmerCompiler>,
    llvm_opt_level: Option<String>,
    llvm_native_cpu: Option<bool>,
    llvm_full_o3_pipeline: Option<bool>,
    llvm_indirect_call_cache: Option<bool>,
    wasmer_profiler: Option<String>,
    compiler_threads: Option<usize>,
    enable_async_threads: Option<bool>,
    no_tty: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmerRuntimeConfigSetReport {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_compiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_opt_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_native_cpu: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_full_o3_pipeline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_llvm_indirect_call_cache: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_profiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_compiler_threads: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_enable_async_threads: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasmer_no_tty: Option<bool>,
}

impl WasmerRuntimeConfigSetInput {
    fn default_set() -> Self {
        Self {
            name: "default".to_owned(),
            compiler: None,
            llvm_opt_level: None,
            llvm_native_cpu: None,
            llvm_full_o3_pipeline: None,
            llvm_indirect_call_cache: None,
            wasmer_profiler: None,
            compiler_threads: None,
            enable_async_threads: None,
            no_tty: None,
        }
    }

    fn runtime_config(&self) -> Option<PgliteServerRuntimeConfig> {
        let mut configured = false;
        let mut config = PgliteServerRuntimeConfig::new();
        if let Some(compiler) = self.compiler {
            configured = true;
            config = config.wasmer_compiler(compiler);
        }
        if let Some(level) = &self.llvm_opt_level {
            configured = true;
            config = config.wasmer_llvm_opt_level(level.clone());
        }
        if let Some(enabled) = self.llvm_native_cpu {
            configured = true;
            config = config.wasmer_llvm_native_cpu(enabled);
        }
        if let Some(enabled) = self.llvm_full_o3_pipeline {
            configured = true;
            config = config.wasmer_llvm_full_o3_pipeline(enabled);
        }
        if let Some(enabled) = self.llvm_indirect_call_cache {
            configured = true;
            config = config.wasmer_llvm_indirect_call_cache(enabled);
        }
        if let Some(profiler) = &self.wasmer_profiler {
            configured = true;
            config = config.wasmer_profiler(profiler.clone());
        }
        if let Some(threads) = self.compiler_threads {
            configured = true;
            config = config.wasmer_compiler_threads(threads);
        }
        if let Some(enabled) = self.enable_async_threads {
            configured = true;
            config = config.wasmer_enable_async_threads(enabled);
        }
        if let Some(enabled) = self.no_tty {
            configured = true;
            config = config.wasmer_no_tty(enabled);
        }
        configured.then_some(config)
    }

    fn report(&self) -> WasmerRuntimeConfigSetReport {
        WasmerRuntimeConfigSetReport {
            name: self.name.clone(),
            wasmer_compiler: self.compiler.map(|compiler| compiler.to_string()),
            wasmer_llvm_opt_level: self.llvm_opt_level.clone(),
            wasmer_llvm_native_cpu: self.llvm_native_cpu,
            wasmer_llvm_full_o3_pipeline: self.llvm_full_o3_pipeline,
            wasmer_llvm_indirect_call_cache: self.llvm_indirect_call_cache,
            wasmer_profiler: self.wasmer_profiler.clone(),
            wasmer_compiler_threads: self.compiler_threads,
            wasmer_enable_async_threads: self.enable_async_threads,
            wasmer_no_tty: self.no_tty,
        }
    }
}

fn parse_speed_case_ids(raw_ids: &str) -> Result<Vec<String>> {
    let parsed = raw_ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    ensure!(
        !parsed.is_empty(),
        "--ids must contain at least one speed benchmark id"
    );
    Ok(parsed)
}

fn named_speed_parity_config_set(name: &str) -> Result<SpeedParityConfigSetInput> {
    let postgres_configs = match name {
        "default" => Vec::new(),
        "sync-off" | "synchronous-commit-off" => {
            vec![("synchronous_commit".to_owned(), "off".to_owned())]
        }
        "full-page-writes-off" | "fpw-off" => {
            vec![("full_page_writes".to_owned(), "off".to_owned())]
        }
        "wal-relaxed" | "sync-fpw-off" => vec![
            ("synchronous_commit".to_owned(), "off".to_owned()),
            ("full_page_writes".to_owned(), "off".to_owned()),
        ],
        "fsync-off" => vec![("fsync".to_owned(), "off".to_owned())],
        "wal-minimal" | "unsafe-wal-minimal" => vec![
            ("wal_level".to_owned(), "minimal".to_owned()),
            ("max_wal_senders".to_owned(), "0".to_owned()),
            ("fsync".to_owned(), "off".to_owned()),
            ("synchronous_commit".to_owned(), "off".to_owned()),
            ("full_page_writes".to_owned(), "off".to_owned()),
        ],
        other => bail!(
            "unknown config set {other:?}; use default, sync-off, full-page-writes-off, wal-relaxed, fsync-off, or wal-minimal"
        ),
    };
    Ok(SpeedParityConfigSetInput {
        name: name.to_owned(),
        postgres_configs,
    })
}

fn default_speed_parity_config_sets() -> Vec<SpeedParityConfigSetInput> {
    ["default", "sync-off", "full-page-writes-off", "wal-relaxed"]
        .into_iter()
        .map(named_speed_parity_config_set)
        .collect::<Result<Vec<_>>>()
        .expect("default speed parity config set names are valid")
}

fn named_wasmer_runtime_config_set(name: &str) -> Result<WasmerRuntimeConfigSetInput> {
    let mut set = WasmerRuntimeConfigSetInput::default_set();
    set.name = name.to_owned();
    match name {
        "default" | "env" => {}
        "portable" | "baseline" | "no-native-cpu" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_native_cpu = Some(false);
        }
        "native-cpu" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_native_cpu = Some(true);
        }
        "full-o3" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_full_o3_pipeline = Some(true);
        }
        "indirect-call-cache" | "icc" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_indirect_call_cache = Some(true);
        }
        "async-threads-on" | "async-threads" => {
            set.enable_async_threads = Some(true);
        }
        "async-threads-off" | "no-async-threads" => {
            set.enable_async_threads = Some(false);
        }
        "no-tty" => {
            set.no_tty = Some(true);
        }
        "native-cpu-icc" | "native-cpu+icc" | "native-cpu-indirect-call-cache" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_native_cpu = Some(true);
            set.llvm_indirect_call_cache = Some(true);
        }
        "full-o3-icc" | "full-o3+icc" | "full-o3-indirect-call-cache" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_full_o3_pipeline = Some(true);
            set.llvm_indirect_call_cache = Some(true);
        }
        "all-flags" | "native-cpu-full-o3-icc" => {
            set.compiler = Some(WasmerCompiler::Llvm);
            set.llvm_native_cpu = Some(true);
            set.llvm_full_o3_pipeline = Some(true);
            set.llvm_indirect_call_cache = Some(true);
        }
        other => bail!(
            "unknown runtime set {other:?}; use default, portable, native-cpu, full-o3, indirect-call-cache, async-threads-on, async-threads-off, no-tty, native-cpu-icc, full-o3-icc, or all-flags"
        ),
    }
    Ok(set)
}

fn default_wasmer_runtime_config_sets() -> Vec<WasmerRuntimeConfigSetInput> {
    [
        "default",
        "portable",
        "native-cpu",
        "full-o3",
        "indirect-call-cache",
        "async-threads-on",
        "async-threads-off",
        "no-tty",
        "native-cpu-icc",
        "full-o3-icc",
        "all-flags",
    ]
    .into_iter()
    .map(named_wasmer_runtime_config_set)
    .collect::<Result<Vec<_>>>()
    .expect("default Wasmer runtime config set names are valid")
}

fn speed_parity_case(
    server: SpeedHotspotDiagnosticCase,
    native: SpeedHotspotDiagnosticCase,
) -> Result<SpeedParityCase> {
    ensure!(
        server.id == native.id,
        "cannot compare mismatched speed cases {} and {}",
        server.id,
        native.id
    );
    ensure!(
        server.operation_count == native.operation_count,
        "cannot compare speed case {} with mismatched operation counts {} and {}",
        server.id,
        server.operation_count,
        native.operation_count
    );
    let operation_count = server.operation_count;
    let p90_delta_micros = micros_delta(server.p90_micros, native.p90_micros);
    let p90_delta_per_operation_nanos =
        p90_delta_micros.map(|delta| (delta as f64 * 1_000.0) / operation_count.max(1) as f64);
    Ok(SpeedParityCase {
        id: server.id.clone(),
        label: server.label.clone(),
        operation_count,
        sample_count: server.sample_count.min(native.sample_count),
        target_repeat_count: server.target_repeat_count,
        target_repeat_mode: server.target_repeat_mode,
        p50_ratio: micros_ratio(server.p50_micros, native.p50_micros),
        p90_ratio: micros_ratio(server.p90_micros, native.p90_micros),
        p95_ratio: micros_ratio(server.p95_micros, native.p95_micros),
        p90_delta_micros,
        p90_delta_per_operation_nanos,
        server,
        native,
    })
}

fn micros_ratio(numerator: Option<u128>, denominator: Option<u128>) -> Option<f64> {
    let numerator = numerator?;
    let denominator = denominator?;
    (denominator > 0).then_some(numerator as f64 / denominator as f64)
}

fn micros_delta(lhs: Option<u128>, rhs: Option<u128>) -> Option<i128> {
    Some(lhs? as i128 - rhs? as i128)
}

fn postgres_config_overrides(configs: &[(String, String)]) -> Vec<PostgresConfigOverride> {
    configs
        .iter()
        .map(|(name, value)| PostgresConfigOverride {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

fn combined_postgres_configs(
    common: &[(String, String)],
    side_specific: &[(String, String)],
) -> Vec<(String, String)> {
    let mut configs = Vec::with_capacity(common.len() + side_specific.len());
    configs.extend(common.iter().cloned());
    configs.extend(side_specific.iter().cloned());
    configs
}

fn server_postgres_configs(options: &DiagnosticOptions) -> Vec<(String, String)> {
    combined_postgres_configs(&options.postgres_configs, &options.server_postgres_configs)
}

fn native_postgres_configs(options: &DiagnosticOptions) -> Vec<(String, String)> {
    combined_postgres_configs(&options.postgres_configs, &options.native_postgres_configs)
}

#[derive(Debug, Clone)]
struct DiagnosticOptions {
    postgres_configs: Vec<(String, String)>,
    server_postgres_configs: Vec<(String, String)>,
    native_postgres_configs: Vec<(String, String)>,
    wasmer_runtime_set: Option<WasmerRuntimeConfigSetInput>,
    host_load_gate: Option<SampledHostLoadGate>,
    samples: usize,
    target_repeats: usize,
    target_repeat_mode: TargetRepeatMode,
    btree_deduplicate_items: Option<bool>,
    t2_index_shape: DiagnosticT2IndexShape,
    cpu_profile: Option<DiagnosticCpuProfileOptions>,
}

impl Default for DiagnosticOptions {
    fn default() -> Self {
        Self {
            postgres_configs: Vec::new(),
            server_postgres_configs: Vec::new(),
            native_postgres_configs: Vec::new(),
            wasmer_runtime_set: None,
            host_load_gate: None,
            samples: 1,
            target_repeats: 1,
            target_repeat_mode: TargetRepeatMode::SameSql,
            btree_deduplicate_items: None,
            t2_index_shape: DiagnosticT2IndexShape::Full,
            cpu_profile: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticT2IndexShape {
    Full,
    LookupOnly,
}

impl DiagnosticT2IndexShape {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "full" | "default" | "pglite" => Ok(Self::Full),
            "lookup-only" | "lookup" | "i2a-only" => Ok(Self::LookupOnly),
            other => bail!("unknown t2 index shape {other:?}; use full or lookup-only"),
        }
    }

    fn label(self) -> Option<&'static str> {
        match self {
            Self::Full => None,
            Self::LookupOnly => Some("lookup-only"),
        }
    }
}

fn parse_diagnostic_setup_variant_arg(
    arg: &str,
    args: &[String],
    cursor: &mut usize,
    options: &mut DiagnosticOptions,
) -> Result<bool> {
    if let Some(raw_value) = arg
        .strip_prefix("--btree-deduplicate-items=")
        .or_else(|| arg.strip_prefix("--setup-btree-deduplicate-items="))
    {
        options.btree_deduplicate_items = parse_optional_btree_deduplicate_items(raw_value)?;
        return Ok(true);
    }
    if arg == "--btree-deduplicate-items" || arg == "--setup-btree-deduplicate-items" {
        *cursor += 1;
        let raw_value = args
            .get(*cursor)
            .ok_or_else(|| anyhow!("{arg} requires off, on, or default"))?;
        options.btree_deduplicate_items = parse_optional_btree_deduplicate_items(raw_value)?;
        return Ok(true);
    }
    if arg == "--no-btree-deduplicate-items" {
        options.btree_deduplicate_items = Some(false);
        return Ok(true);
    }
    if let Some(raw_value) = arg
        .strip_prefix("--t2-index-shape=")
        .or_else(|| arg.strip_prefix("--speed-t2-index-shape="))
    {
        options.t2_index_shape = DiagnosticT2IndexShape::parse(raw_value)?;
        return Ok(true);
    }
    if arg == "--t2-index-shape" || arg == "--speed-t2-index-shape" {
        *cursor += 1;
        let raw_value = args
            .get(*cursor)
            .ok_or_else(|| anyhow!("{arg} requires full or lookup-only"))?;
        options.t2_index_shape = DiagnosticT2IndexShape::parse(raw_value)?;
        return Ok(true);
    }
    Ok(false)
}

fn parse_optional_btree_deduplicate_items(value: &str) -> Result<Option<bool>> {
    match value {
        "default" | "postgres-default" | "pg-default" => Ok(None),
        "on" | "true" | "yes" | "1" => Ok(Some(true)),
        "off" | "false" | "no" | "0" => Ok(Some(false)),
        other => bail!("unknown btree deduplicate_items value {other:?}; use off, on, or default"),
    }
}

fn diagnostic_setup_variant_report(
    options: &DiagnosticOptions,
) -> Option<DiagnosticSetupVariantReport> {
    if options.btree_deduplicate_items.is_none()
        && options.t2_index_shape == DiagnosticT2IndexShape::Full
    {
        return None;
    }
    Some(DiagnosticSetupVariantReport {
        btree_deduplicate_items: options
            .btree_deduplicate_items
            .map(|enabled| if enabled { "on" } else { "off" }),
        t2_index_shape: options.t2_index_shape.label(),
        description: "Benchmark setup SQL is rewritten before native and WASIX runs. Use setup variants only for bottleneck isolation, not as the default PGlite benchmark shape.",
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetRepeatMode {
    SameSql,
    FreshSql,
}

impl TargetRepeatMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "same" | "same-sql" | "exact" => Ok(Self::SameSql),
            "fresh" | "fresh-sql" | "repeat-safe" | "isolated" => Ok(Self::FreshSql),
            other => bail!("unknown target repeat mode {other:?}; use same-sql or fresh-sql"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::SameSql => "same-sql",
            Self::FreshSql => "fresh-sql",
        }
    }
}

#[derive(Debug, Clone)]
struct DiagnosticCpuProfileOptions {
    output_path: PathBuf,
    seconds: u64,
    delay: Duration,
}

impl Default for DiagnosticCpuProfileOptions {
    fn default() -> Self {
        Self {
            output_path: PathBuf::new(),
            seconds: 5,
            delay: Duration::from_millis(100),
        }
    }
}

fn parse_postgres_config_arg(raw: &str) -> Result<(String, String)> {
    let (name, value) = raw
        .split_once('=')
        .ok_or_else(|| anyhow!("Postgres config override must use name=value syntax"))?;
    ensure!(!name.is_empty(), "Postgres config override name is empty");
    ensure!(
        !value.is_empty(),
        "Postgres config override value for {name:?} is empty"
    );
    Ok((name.to_owned(), value.to_owned()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticEngine {
    WasixLegacy,
    WasixServerSqlx,
    WasixServerTokioPostgresSimple,
    NativeLibPglite,
    NativePostgres,
    NativePostgresSqlx,
}

impl DiagnosticEngine {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "wasix" | "wasix-legacy" | "legacy" => Ok(Self::WasixLegacy),
            "server-sqlx" | "wasix-server-sqlx" | "pg18-server-sqlx" => Ok(Self::WasixServerSqlx),
            "server-tokio-postgres-simple"
            | "tokio-postgres-simple"
            | "wasix-server-tokio-postgres-simple"
            | "pg18-server-tokio-postgres-simple" => Ok(Self::WasixServerTokioPostgresSimple),
            "native" | "native-libpglite" | "libpglite" => Ok(Self::NativeLibPglite),
            "native-postgres" | "postgres" | "pg" => Ok(Self::NativePostgres),
            "native-postgres-sqlx" | "postgres-sqlx" | "pg-sqlx" => Ok(Self::NativePostgresSqlx),
            other => bail!(
                "unknown diagnostic engine {other:?}; use wasix, server-sqlx, server-tokio-postgres-simple, native-libpglite, native-postgres, or native-postgres-sqlx"
            ),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::WasixLegacy => "wasix_legacy",
            Self::WasixServerSqlx => "wasix_server_sqlx",
            Self::WasixServerTokioPostgresSimple => "wasix_server_tokio_postgres_simple",
            Self::NativeLibPglite => "native_libpglite",
            Self::NativePostgres => "native_postgres",
            Self::NativePostgresSqlx => "native_postgres_sqlx",
        }
    }

    fn engine_kind(self) -> Option<EngineKind> {
        match self {
            Self::WasixLegacy => Some(EngineKind::WasixLegacy),
            Self::NativeLibPglite => Some(EngineKind::NativeLibPglite),
            Self::WasixServerSqlx
            | Self::WasixServerTokioPostgresSimple
            | Self::NativePostgres
            | Self::NativePostgresSqlx => None,
        }
    }
}

fn perf_diagnose_speed_ids(
    ids: &[&str],
    engine: DiagnosticEngine,
    speed_sql_source: SpeedSqlSource,
    postgres_bin: &Path,
    initdb_bin: &Path,
    options: &DiagnosticOptions,
) -> Result<()> {
    if engine == DiagnosticEngine::WasixLegacy {
        Pglite::preload()?;
    }
    let cases = speed_cases(1.0, speed_sql_source)?;
    let mut diagnostics = Vec::new();
    let measurement_model = "Each sample opens a fresh temporary PG18 WASIX server or native PostgreSQL 18 SQLx control, runs all earlier speed tests outside the measured section, then records the selected speed-test SQL with common and optional server/native-only Postgres GUC overrides. Use --samples for p50/p90/p95. Use --target-repeats and --sample-server for profile-oriented runs. The default repeat mode replays the same SQL; --target-repeat-mode=fresh-sql rewrites supported create-table/index and indexed-update cases so repeats stay repeat-safe and closer to first-pass work.";
    for id in ids {
        match run_speed_hotspot_diagnostic_case_samples(
            &cases,
            id,
            engine,
            postgres_bin,
            initdb_bin,
            options,
        ) {
            Ok(case) => diagnostics.push(case),
            Err(error) => {
                let report = SpeedHotspotDiagnosticReport {
                    source_model: speed_sql_source.source_model(),
                    measurement_model,
                    completed: false,
                    host_load_gate: options
                        .host_load_gate
                        .as_ref()
                        .and_then(|gate| gate.report(options.samples)),
                    host_load: capture_host_load_report(),
                    setup_variant: diagnostic_setup_variant_report(options),
                    runtime: matches!(
                        engine,
                        DiagnosticEngine::WasixServerSqlx
                            | DiagnosticEngine::WasixServerTokioPostgresSimple
                    )
                    .then(|| {
                        benchmark_runtime_report_for_runtime_set(
                            options.wasmer_runtime_set.as_ref(),
                        )
                    })
                    .transpose()?,
                    cases: diagnostics,
                    errors: vec![DiagnosticRunError {
                        context: format!("engine={} id={id}", engine.label()),
                        message: format!("{error:#}"),
                        host_load: capture_host_load_report(),
                    }],
                };
                println!("{}", serde_json::to_string_pretty(&report)?);
                bail!(
                    "speed diagnostic failed for engine={} id={id}; emitted partial JSON report",
                    engine.label()
                );
            }
        }
    }

    let report = SpeedHotspotDiagnosticReport {
        source_model: speed_sql_source.source_model(),
        measurement_model,
        completed: true,
        host_load_gate: options
            .host_load_gate
            .as_ref()
            .and_then(|gate| gate.report(options.samples)),
        host_load: capture_host_load_report(),
        setup_variant: diagnostic_setup_variant_report(options),
        runtime: matches!(
            engine,
            DiagnosticEngine::WasixServerSqlx | DiagnosticEngine::WasixServerTokioPostgresSimple
        )
        .then(|| benchmark_runtime_report_for_runtime_set(options.wasmer_runtime_set.as_ref()))
        .transpose()?,
        cases: diagnostics,
        errors: Vec::new(),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_speed_hotspot_diagnostic_case_samples(
    cases: &[SpeedCase],
    id: &str,
    engine: DiagnosticEngine,
    postgres_bin: &Path,
    initdb_bin: &Path,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let mut samples = Vec::with_capacity(options.samples);
    for sample_index in 1..=options.samples {
        let pre_sample_wait = options
            .host_load_gate
            .as_ref()
            .and_then(wait_for_sample_host_load_gate);
        if pre_sample_wait.as_ref().is_some_and(|wait| !wait.satisfied) {
            bail!(
                "speed diagnostic sample {sample_index} for case {id} timed out waiting for host load gate"
            );
        }
        let mut sample = match engine {
            DiagnosticEngine::WasixLegacy | DiagnosticEngine::NativeLibPglite => {
                run_speed_hotspot_diagnostic_case(cases, id, engine, options)?
            }
            DiagnosticEngine::WasixServerSqlx => {
                run_server_sqlx_speed_hotspot_diagnostic_case(cases, id, options)?
            }
            DiagnosticEngine::WasixServerTokioPostgresSimple => {
                run_server_tokio_postgres_simple_speed_hotspot_diagnostic_case(cases, id, options)?
            }
            DiagnosticEngine::NativePostgres => run_native_postgres_speed_hotspot_diagnostic_case(
                cases,
                id,
                postgres_bin,
                initdb_bin,
                options,
            )?,
            DiagnosticEngine::NativePostgresSqlx => {
                run_native_postgres_sqlx_speed_hotspot_diagnostic_case(
                    cases,
                    id,
                    postgres_bin,
                    initdb_bin,
                    options,
                )?
            }
        };
        sample.pre_sample_wait = pre_sample_wait;
        sample.host_load = capture_host_load_report();
        samples.push(sample);
    }
    Ok(if samples.len() == 1 {
        samples
            .into_iter()
            .next()
            .expect("diagnostic sample count checked above")
    } else {
        aggregate_speed_hotspot_samples(samples)
    })
}

fn aggregate_speed_hotspot_samples(
    samples: Vec<SpeedHotspotDiagnosticCase>,
) -> SpeedHotspotDiagnosticCase {
    let sample_count = samples.len();
    let elapsed = samples
        .iter()
        .map(|sample| sample.elapsed_micros)
        .collect::<Vec<_>>();
    let setup = samples
        .iter()
        .map(|sample| sample.setup_micros)
        .collect::<Vec<_>>();
    let open_micros = optional_percentile(samples.iter().filter_map(|sample| sample.open_micros));
    let connect_micros =
        optional_percentile(samples.iter().filter_map(|sample| sample.connect_micros));
    let observed_server_peak_rss_bytes = samples
        .iter()
        .filter_map(|sample| sample.observed_server_peak_rss_bytes)
        .max();
    let average_micros = Some(elapsed.iter().sum::<u128>() as f64 / elapsed.len().max(1) as f64);
    let min_micros = elapsed.iter().copied().min();
    let p50_micros = percentile_values(&elapsed, 0.50);
    let p90_micros = percentile_values(&elapsed, 0.90);
    let p95_micros = percentile_values(&elapsed, 0.95);
    let setup_micros = percentile_values(&setup, 0.90).unwrap_or(0);
    let first = &samples[0];
    let engine = first.engine;
    let id = first.id.clone();
    let label = first.label.clone();
    let target_repeat_count = first.target_repeat_count;
    let target_repeat_mode = first.target_repeat_mode;
    let operation_count = first.operation_count;
    let settings = first.settings.clone();
    let fs_trace = first.fs_trace.clone();
    let phases = vec![
        PhaseTiming {
            name: "samples.elapsed.p50",
            elapsed_micros: p50_micros.unwrap_or(0),
        },
        PhaseTiming {
            name: "samples.elapsed.p90",
            elapsed_micros: p90_micros.unwrap_or(0),
        },
        PhaseTiming {
            name: "samples.elapsed.p95",
            elapsed_micros: p95_micros.unwrap_or(0),
        },
    ];
    let samples = samples
        .into_iter()
        .enumerate()
        .map(|(index, sample)| SpeedHotspotDiagnosticSample {
            sample_index: index + 1,
            target_repeat_count: sample.target_repeat_count,
            target_repeat_mode: sample.target_repeat_mode,
            open_micros: sample.open_micros,
            connect_micros: sample.connect_micros,
            setup_micros: sample.setup_micros,
            elapsed_micros: sample.elapsed_micros,
            observed_server_peak_rss_bytes: sample.observed_server_peak_rss_bytes,
            settings: sample.settings,
            fs_trace: sample.fs_trace,
            phases: sample.phases,
            pre_sample_wait: sample.pre_sample_wait,
            host_load: sample.host_load,
            target_repeat_elapsed_micros: sample.target_repeat_elapsed_micros,
            cpu_profile: sample.cpu_profile,
        })
        .collect::<Vec<_>>();

    SpeedHotspotDiagnosticCase {
        engine,
        id,
        label,
        sample_count,
        target_repeat_count,
        target_repeat_mode,
        open_micros,
        connect_micros,
        setup_micros,
        elapsed_micros: p90_micros.unwrap_or(0),
        operation_count,
        average_micros,
        min_micros,
        p50_micros,
        p90_micros,
        p95_micros,
        observed_server_peak_rss_bytes,
        settings,
        fs_trace,
        phases,
        pre_sample_wait: None,
        host_load: capture_host_load_report(),
        target_repeat_elapsed_micros: None,
        cpu_profile: None,
        samples: Some(samples),
    }
}

fn percentile_values(values: &[u128], percentile: f64) -> Option<u128> {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    percentile_sorted(&sorted, percentile)
}

fn optional_percentile(values: impl Iterator<Item = u128>) -> Option<u128> {
    let values = values.collect::<Vec<_>>();
    percentile_values(&values, 0.90)
}

fn target_repeat_elapsed_micros(repeat_count: usize, elapsed: Vec<u128>) -> Option<Vec<u128>> {
    (repeat_count > 1).then_some(elapsed)
}

fn target_sqls_for_repeats(target: &SpeedCase, options: &DiagnosticOptions) -> Result<Vec<String>> {
    validate_target_repeat_plan(target, options)?;
    (0..options.target_repeats)
        .map(|repeat_index| {
            let sql = target_sql_for_repeat(target, repeat_index, options.target_repeat_mode)?;
            Ok(apply_diagnostic_sql_variants(&sql, options))
        })
        .collect()
}

fn setup_sql_for_case(case: &SpeedCase, options: &DiagnosticOptions) -> String {
    apply_diagnostic_sql_variants(&case.sql, options)
}

fn apply_diagnostic_sql_variants(sql: &str, options: &DiagnosticOptions) -> String {
    let mut rewritten = match options.t2_index_shape {
        DiagnosticT2IndexShape::Full => sql.to_owned(),
        DiagnosticT2IndexShape::LookupOnly => rewrite_t2_index_shape_lookup_only(sql),
    };
    if let Some(deduplicate_items) = options.btree_deduplicate_items {
        rewritten = rewrite_btree_deduplicate_items(&rewritten, deduplicate_items);
    }
    rewritten
}

fn rewrite_t2_index_shape_lookup_only(sql: &str) -> String {
    let mut rewritten = String::with_capacity(sql.len());
    for line in sql.split_inclusive('\n') {
        if !is_t2_value_index_create_line(line) {
            rewritten.push_str(line);
        }
    }
    rewritten
}

fn is_t2_value_index_create_line(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.contains(" ON t2(b)") {
        return false;
    }
    trimmed.starts_with("CREATE INDEX i2b ")
        || trimmed.starts_with("CREATE INDEX __pgo_i2b_repeat_")
}

fn rewrite_btree_deduplicate_items(sql: &str, enabled: bool) -> String {
    let reloption = if enabled {
        " WITH (deduplicate_items=on)"
    } else {
        " WITH (deduplicate_items=off)"
    };
    let mut rewritten = String::with_capacity(sql.len() + reloption.len() * 4);
    for line in sql.split_inclusive('\n') {
        rewritten.push_str(&rewrite_create_index_line_with_btree_dedup(line, reloption));
    }
    rewritten
}

fn rewrite_create_index_line_with_btree_dedup(line: &str, reloption: &str) -> String {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("CREATE INDEX ")
        || trimmed.contains(" WITH ")
        || !trimmed.trim_end().ends_with(';')
    {
        return line.to_owned();
    }

    let trailing_newline = line.ends_with('\n');
    let line_without_newline = line.strip_suffix('\n').unwrap_or(line);
    let Some(semicolon_index) = line_without_newline.rfind(';') else {
        return line.to_owned();
    };
    let mut rewritten = String::with_capacity(line.len() + reloption.len());
    rewritten.push_str(&line_without_newline[..semicolon_index]);
    rewritten.push_str(reloption);
    rewritten.push(';');
    if trailing_newline {
        rewritten.push('\n');
    }
    rewritten
}

fn validate_target_repeat_plan(target: &SpeedCase, options: &DiagnosticOptions) -> Result<()> {
    if target.id == "8"
        && options.target_repeat_mode == TargetRepeatMode::SameSql
        && options.target_repeats > SAME_SQL_CASE8_MAX_REPEAT_COUNT
    {
        bail!(
            "speed case 8 exact same-sql repeats are unsafe above {SAME_SQL_CASE8_MAX_REPEAT_COUNT}: \
             the benchmark SQL uses b=b*2 and eventually overflows int4. Use \
             --target-repeat-mode=fresh-sql for long profiling runs, or lower --target-repeats."
        );
    }
    Ok(())
}

fn target_sql_for_repeat(
    target: &SpeedCase,
    repeat_index: usize,
    mode: TargetRepeatMode,
) -> Result<String> {
    if mode == TargetRepeatMode::SameSql || repeat_index == 0 {
        return Ok(target.sql.clone());
    }

    match target.id {
        "1" => Ok(rewrite_sql_identifier(
            &target.sql,
            "t1",
            &fresh_repeat_identifier("t1", repeat_index),
        )),
        "2" => Ok(rewrite_sql_identifier(
            &target.sql,
            "t2",
            &fresh_repeat_identifier("t2", repeat_index),
        )),
        "2.1" => Ok(rewrite_sql_identifier(
            &target.sql,
            "t2_1",
            &fresh_repeat_identifier("t2_1", repeat_index),
        )),
        "3" => {
            let sql = rewrite_sql_identifier(
                &target.sql,
                "i3",
                &fresh_repeat_identifier("i3", repeat_index),
            );
            Ok(rewrite_sql_identifier(
                &sql,
                "t3",
                &fresh_repeat_identifier("t3", repeat_index),
            ))
        }
        "3.1" => {
            let sql = rewrite_sql_identifier(
                &target.sql,
                "i3_1",
                &fresh_repeat_identifier("i3_1", repeat_index),
            );
            Ok(rewrite_sql_identifier(
                &sql,
                "t3_1",
                &fresh_repeat_identifier("t3_1", repeat_index),
            ))
        }
        "4" | "5" | "7" => Ok(target.sql.clone()),
        "8" => Ok(speed_update_t1_repeat_safe_variant(target.operation_count)),
        "6" => {
            let sql = rewrite_sql_identifier(
                &target.sql,
                "i2a",
                &fresh_repeat_identifier("i2a", repeat_index),
            );
            Ok(rewrite_sql_identifier(
                &sql,
                "i2b",
                &fresh_repeat_identifier("i2b", repeat_index),
            ))
        }
        "9" => Ok(speed_update_t2_numeric_variant(
            target.operation_count,
            repeat_index,
        )),
        "10" => Ok(speed_update_t2_text_variant(
            target.operation_count,
            repeat_index,
        )),
        other => bail!(
            "--target-repeat-mode=fresh-sql does not yet support speed case {other}; use same-sql for this case or add a repeat-safe SQL rewrite"
        ),
    }
}

fn fresh_repeat_identifier(base: &str, repeat_index: usize) -> String {
    format!("__pgo_{base}_repeat_{}", repeat_index + 1)
}

fn rewrite_sql_identifier(sql: &str, from: &str, to: &str) -> String {
    let mut rewritten = String::with_capacity(sql.len() + 16);
    let mut cursor = 0usize;
    while cursor < sql.len() {
        let ch = sql[cursor..]
            .chars()
            .next()
            .expect("cursor remains on a char boundary");
        if is_pg_identifier_char(ch) {
            let start = cursor;
            cursor += ch.len_utf8();
            while cursor < sql.len() {
                let next = sql[cursor..]
                    .chars()
                    .next()
                    .expect("cursor remains on a char boundary");
                if !is_pg_identifier_char(next) {
                    break;
                }
                cursor += next.len_utf8();
            }
            let token = &sql[start..cursor];
            if token == from {
                rewritten.push_str(to);
            } else {
                rewritten.push_str(token);
            }
        } else {
            rewritten.push(ch);
            cursor += ch.len_utf8();
        }
    }
    rewritten
}

fn is_pg_identifier_char(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphanumeric()
}

fn speed_hotspot_case(
    engine: &'static str,
    id: String,
    label: String,
    open_micros: Option<u128>,
    connect_micros: Option<u128>,
    setup_micros: u128,
    elapsed_micros: u128,
    operation_count: usize,
    target_repeat_count: usize,
    target_repeat_mode: TargetRepeatMode,
    target_repeat_elapsed_micros: Option<Vec<u128>>,
    observed_server_peak_rss_bytes: Option<u64>,
    settings: serde_json::Value,
    fs_trace: serde_json::Value,
    phases: Vec<PhaseTiming>,
    cpu_profile: Option<SpeedHotspotCpuProfile>,
) -> SpeedHotspotDiagnosticCase {
    SpeedHotspotDiagnosticCase {
        engine,
        id,
        label,
        sample_count: 1,
        target_repeat_count,
        target_repeat_mode: target_repeat_mode.label(),
        open_micros,
        connect_micros,
        setup_micros,
        elapsed_micros,
        operation_count,
        average_micros: None,
        min_micros: Some(elapsed_micros),
        p50_micros: Some(elapsed_micros),
        p90_micros: Some(elapsed_micros),
        p95_micros: Some(elapsed_micros),
        observed_server_peak_rss_bytes,
        settings,
        fs_trace,
        phases,
        pre_sample_wait: None,
        host_load: None,
        target_repeat_elapsed_micros,
        cpu_profile,
        samples: None,
    }
}

fn perf_diagnose_buffer_cache() -> Result<()> {
    Pglite::preload()?;
    let cases = speed_cases(1.0, SpeedSqlSource::PgliteVendored)?;
    let diagnostics = vec![
        run_buffer_cache_diagnostic_case(
            &cases,
            "11",
            &[
                "BEGIN",
                "INSERT INTO t1 SELECT b,a,c FROM t2",
                "INSERT INTO t2 SELECT b,a,c FROM t1",
                "COMMIT",
            ],
        )?,
        run_buffer_cache_diagnostic_case(&cases, "14", &["INSERT INTO t2 SELECT * FROM t1"])?,
    ];

    let report = BufferCacheDiagnosticReport {
        source_model: "Exact PGlite benchmark SQL files from assets/checkouts/pglite/packages/benchmark/src.",
        measurement_model: "Each case opens a fresh temporary database, runs all earlier PGlite speed tests outside the measured section, then executes EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the target data-moving statements.",
        cases: diagnostics,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_buffer_cache_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    statements: &[&str],
) -> Result<BufferCacheDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let mut db = Pglite::builder()
        .temporary()
        .open()
        .with_context(|| format!("open buffer-cache diagnostic database for {}", target.id))?;

    let setup_started = Instant::now();
    for setup_case in &cases[..target_index] {
        db.exec(&setup_case.sql, None)
            .with_context(|| format!("run buffer-cache setup case {}", setup_case.id))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();

    let settings = exec_rows_json(
        &mut db,
        "SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('wal_buffers') AS wal_buffers, current_setting('work_mem') AS work_mem",
    )?;
    let relation_sizes = exec_rows_json(
        &mut db,
        "SELECT relname, pg_relation_size(oid)::bigint AS bytes FROM pg_class WHERE relname IN ('t1', 't2', 'i2a', 'i2b') ORDER BY relname",
    )?;

    let mut explained = Vec::new();
    for statement in statements {
        if matches!(*statement, "BEGIN" | "COMMIT") {
            let (result, phases) = capture_phase_timings(|| {
                let started = Instant::now();
                let result = db.exec(statement, None);
                (result, started.elapsed())
            });
            let (result, elapsed) = result;
            result.with_context(|| format!("run transaction control statement {statement}"))?;
            explained.push(BufferCacheDiagnosticStatement {
                sql: (*statement).to_owned(),
                elapsed_micros: elapsed.as_micros(),
                explain_rows: serde_json::Value::Null,
                fs_trace: serde_json::Value::Null,
                phases,
            });
            continue;
        }

        reset_fs_trace();
        let explain_sql = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {statement}");
        let (result, phases) = capture_phase_timings(|| {
            let started = Instant::now();
            let result = db.exec(&explain_sql, None);
            (result, started.elapsed())
        });
        let (result, elapsed) = result;
        let result = result.with_context(|| format!("run buffer-cache explain for {statement}"))?;
        let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
        explained.push(BufferCacheDiagnosticStatement {
            sql: (*statement).to_owned(),
            elapsed_micros: elapsed.as_micros(),
            explain_rows: results_to_json(result),
            fs_trace,
            phases,
        });
    }

    db.close()
        .with_context(|| format!("close buffer-cache diagnostic database for {}", target.id))?;

    Ok(BufferCacheDiagnosticCase {
        id: target.id.to_owned(),
        label: target.label.clone(),
        setup_micros,
        settings,
        relation_sizes,
        statements: explained,
    })
}

fn exec_rows_json(db: &mut Pglite, sql: &str) -> Result<serde_json::Value> {
    let results = db.exec(sql, None)?;
    Ok(results_to_json(results))
}

fn results_to_json(results: Vec<pglite_oxide::Results>) -> serde_json::Value {
    serde_json::Value::Array(
        results
            .into_iter()
            .map(|result| {
                serde_json::json!({
                    "fields": result
                        .fields
                        .into_iter()
                        .map(|field| {
                            serde_json::json!({
                                "name": field.name,
                                "dataTypeId": field.data_type_id,
                            })
                        })
                        .collect::<Vec<_>>(),
                    "rows": result.rows,
                    "affectedRows": result.affected_rows,
                })
            })
            .collect(),
    )
}

fn run_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    engine: DiagnosticEngine,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let mut builder = Pglite::builder()
        .temporary()
        .engine(engine.engine_kind().ok_or_else(|| {
            anyhow!(
                "diagnostic engine {} is not an in-process PGlite engine",
                engine.label()
            )
        })?);
    for (name, value) in &options.postgres_configs {
        builder = builder.postgres_config(name, value);
    }
    let mut db = builder
        .open()
        .with_context(|| format!("open speed hotspot diagnostic database for {}", target.id))?;

    let setup_started = Instant::now();
    for setup_case in &cases[..target_index] {
        let setup_sql = setup_sql_for_case(setup_case, options);
        db.exec(&setup_sql, None)
            .with_context(|| format!("run speed hotspot setup case {}", setup_case.id))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();

    let settings = exec_rows_json(&mut db, SPEED_DIAGNOSTIC_SETTINGS_SQL)?;
    let repeat_sqls = target_sqls_for_repeats(target, options)?;
    reset_fs_trace();
    let (result, phases) = capture_phase_timings(|| {
        let started = Instant::now();
        let mut repeat_elapsed_micros = Vec::with_capacity(repeat_sqls.len());
        for repeat_sql in &repeat_sqls {
            let repeat_started = Instant::now();
            if let Err(err) = db.exec(repeat_sql, None) {
                return (Err(err), started.elapsed(), repeat_elapsed_micros);
            }
            repeat_elapsed_micros.push(repeat_started.elapsed().as_micros());
        }
        (
            Ok(Vec::<pglite_oxide::Results>::new()),
            started.elapsed(),
            repeat_elapsed_micros,
        )
    });
    let (result, elapsed, repeat_elapsed_micros) = result;
    result.with_context(|| format!("run speed hotspot measured case {}", target.id))?;
    let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
    db.close()
        .with_context(|| format!("close speed hotspot diagnostic database for {}", target.id))?;

    Ok(speed_hotspot_case(
        engine.label(),
        target.id.to_owned(),
        target.label.clone(),
        None,
        None,
        setup_micros,
        elapsed.as_micros(),
        target
            .operation_count
            .saturating_mul(options.target_repeats),
        options.target_repeats,
        options.target_repeat_mode,
        target_repeat_elapsed_micros(options.target_repeats, repeat_elapsed_micros),
        None,
        settings,
        fs_trace,
        phases,
        None,
    ))
}

fn run_server_sqlx_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let open_started = Instant::now();
    let runtime_config = options
        .wasmer_runtime_set
        .as_ref()
        .and_then(WasmerRuntimeConfigSetInput::runtime_config);
    let postgres_configs = server_postgres_configs(options);
    let server = benchmark_pglite_server_with_configs_and_runtime(
        &postgres_configs,
        runtime_config.as_ref(),
    )
    .with_context(|| format!("start server SQLx diagnostic database for {}", target.id))?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create server SQLx diagnostic Tokio runtime")?;
    let (
        connect_micros,
        setup_micros,
        elapsed_micros,
        repeat_elapsed_micros,
        settings,
        cpu_profile,
    ) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect server SQLx diagnostic client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        for setup_case in &cases[..target_index] {
            let setup_sql = setup_sql_for_case(setup_case, options);
            conn.execute(setup_sql.as_str()).await.with_context(|| {
                format!("run server SQLx diagnostic setup case {}", setup_case.id)
            })?;
        }
        let setup_micros = setup_started.elapsed().as_micros();
        let settings = sqlx_settings_json(&mut conn)
            .await
            .context("query server SQLx diagnostic settings")?;
        sample_optional_rss(&mut server_rss);
        let repeat_sqls = target_sqls_for_repeats(target, options)?;

        let mut running_profile = start_cpu_profile(
            server.server_process_id(),
            options.cpu_profile.as_ref(),
            CpuProfilePidSelection::Exact,
        )?;
        let started = Instant::now();
        let mut repeat_elapsed_micros = Vec::with_capacity(repeat_sqls.len());
        for repeat_sql in &repeat_sqls {
            let repeat_started = Instant::now();
            conn.execute(repeat_sql.as_str()).await.with_context(|| {
                format!("run server SQLx diagnostic measured case {}", target.id)
            })?;
            repeat_elapsed_micros.push(repeat_started.elapsed().as_micros());
        }
        let elapsed_micros = started.elapsed().as_micros();
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        sample_optional_rss(&mut server_rss);
        conn.close()
            .await
            .context("close server SQLx diagnostic client")?;
        Ok::<_, anyhow::Error>((
            connect_micros,
            setup_micros,
            elapsed_micros,
            repeat_elapsed_micros,
            settings,
            cpu_profile,
        ))
    })?;
    server.shutdown()?;

    Ok(speed_hotspot_case(
        DiagnosticEngine::WasixServerSqlx.label(),
        target.id.to_owned(),
        target.label.clone(),
        Some(open_micros),
        Some(connect_micros),
        setup_micros,
        elapsed_micros,
        target
            .operation_count
            .saturating_mul(options.target_repeats),
        options.target_repeats,
        options.target_repeat_mode,
        target_repeat_elapsed_micros(options.target_repeats, repeat_elapsed_micros),
        optional_peak_rss(&server_rss),
        settings,
        serde_json::json!({
            "enabled": false,
            "reason": "PG18 server SQLx diagnostic runs through an external PgliteServer process"
        }),
        vec![
            PhaseTiming {
                name: "server.open",
                elapsed_micros: open_micros,
            },
            PhaseTiming {
                name: "client.sqlx.connect",
                elapsed_micros: connect_micros,
            },
            PhaseTiming {
                name: "client.sqlx.setup",
                elapsed_micros: setup_micros,
            },
            PhaseTiming {
                name: "client.sqlx.execute",
                elapsed_micros,
            },
        ],
        cpu_profile,
    ))
}

fn run_server_tokio_postgres_simple_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let open_started = Instant::now();
    let runtime_config = options
        .wasmer_runtime_set
        .as_ref()
        .and_then(WasmerRuntimeConfigSetInput::runtime_config);
    let postgres_configs = server_postgres_configs(options);
    let server = benchmark_pglite_server_with_configs_and_runtime(
        &postgres_configs,
        runtime_config.as_ref(),
    )
    .with_context(|| {
        format!(
            "start server tokio-postgres simple diagnostic database for {}",
            target.id
        )
    })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create server tokio-postgres simple diagnostic Tokio runtime")?;
    let (
        connect_micros,
        setup_micros,
        elapsed_micros,
        repeat_elapsed_micros,
        settings,
        cpu_profile,
    ) = runtime.block_on(async {
        let connect_started = Instant::now();
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect server tokio-postgres simple diagnostic client")?;
        let connection_handle = tokio::spawn(connection);
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        for setup_case in &cases[..target_index] {
            let setup_sql = setup_sql_for_case(setup_case, options);
            client.batch_execute(&setup_sql).await.with_context(|| {
                format!(
                    "run server tokio-postgres simple diagnostic setup case {}",
                    setup_case.id
                )
            })?;
        }
        let setup_micros = setup_started.elapsed().as_micros();
        let settings = native_postgres_settings_json(&client)
            .await
            .context("query server tokio-postgres simple diagnostic settings")?;
        sample_optional_rss(&mut server_rss);
        let repeat_sqls = target_sqls_for_repeats(target, options)?;

        let mut running_profile = start_cpu_profile(
            server.server_process_id(),
            options.cpu_profile.as_ref(),
            CpuProfilePidSelection::Exact,
        )?;
        let started = Instant::now();
        let mut repeat_elapsed_micros = Vec::with_capacity(repeat_sqls.len());
        for repeat_sql in &repeat_sqls {
            let repeat_started = Instant::now();
            client.batch_execute(repeat_sql).await.with_context(|| {
                format!(
                    "run server tokio-postgres simple diagnostic measured case {}",
                    target.id
                )
            })?;
            repeat_elapsed_micros.push(repeat_started.elapsed().as_micros());
        }
        let elapsed_micros = started.elapsed().as_micros();
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        sample_optional_rss(&mut server_rss);
        drop(client);
        connection_handle.abort();
        Ok::<_, anyhow::Error>((
            connect_micros,
            setup_micros,
            elapsed_micros,
            repeat_elapsed_micros,
            settings,
            cpu_profile,
        ))
    })?;
    server.shutdown()?;

    Ok(speed_hotspot_case(
        DiagnosticEngine::WasixServerTokioPostgresSimple.label(),
        target.id.to_owned(),
        target.label.clone(),
        Some(open_micros),
        Some(connect_micros),
        setup_micros,
        elapsed_micros,
        target
            .operation_count
            .saturating_mul(options.target_repeats),
        options.target_repeats,
        options.target_repeat_mode,
        target_repeat_elapsed_micros(options.target_repeats, repeat_elapsed_micros),
        optional_peak_rss(&server_rss),
        settings,
        serde_json::json!({
            "enabled": false,
            "reason": "PG18 server tokio-postgres simple diagnostic runs through an external PgliteServer process"
        }),
        vec![
            PhaseTiming {
                name: "server.open",
                elapsed_micros: open_micros,
            },
            PhaseTiming {
                name: "client.tokio_postgres.connect",
                elapsed_micros: connect_micros,
            },
            PhaseTiming {
                name: "client.tokio_postgres.setup",
                elapsed_micros: setup_micros,
            },
            PhaseTiming {
                name: "client.tokio_postgres.batch_execute",
                elapsed_micros,
            },
        ],
        cpu_profile,
    ))
}

fn run_native_postgres_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    postgres_bin: &Path,
    initdb_bin: &Path,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let postgres_configs = native_postgres_configs(options);
    let native = NativePostgres::start_with_configs(postgres_bin, initdb_bin, &postgres_configs)
        .with_context(|| format!("start native Postgres diagnostic cluster for {}", target.id))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres diagnostic Tokio runtime")?;

    let (setup_micros, elapsed_micros, repeat_elapsed_micros, settings, cpu_profile) = runtime
        .block_on(async {
            let mut config = tokio_postgres::Config::new();
            configure_native_postgres_client(&mut config, &native);
            let (client, connection) = config
                .connect(tokio_postgres::NoTls)
                .await
                .context("connect native Postgres diagnostic client")?;
            let connection_task = tokio::spawn(async move {
                let _ = connection.await;
            });

            let setup_started = Instant::now();
            for setup_case in &cases[..target_index] {
                let setup_sql = setup_sql_for_case(setup_case, options);
                client.simple_query(&setup_sql).await.with_context(|| {
                    format!(
                        "run native Postgres diagnostic setup case {}",
                        setup_case.id
                    )
                })?;
            }
            let setup_micros = setup_started.elapsed().as_micros();
            let settings = native_postgres_settings_json(&client)
                .await
                .context("query native Postgres diagnostic settings")?;
            let repeat_sqls = target_sqls_for_repeats(target, options)?;

            let mut running_profile = start_cpu_profile(
                Some(native.child.id()),
                options.cpu_profile.as_ref(),
                CpuProfilePidSelection::PreferActivePostgresChild,
            )?;
            let started = Instant::now();
            let mut repeat_elapsed_micros = Vec::with_capacity(repeat_sqls.len());
            for repeat_sql in &repeat_sqls {
                let repeat_started = Instant::now();
                client.simple_query(&repeat_sql).await.with_context(|| {
                    format!("run native Postgres diagnostic measured case {}", target.id)
                })?;
                repeat_elapsed_micros.push(repeat_started.elapsed().as_micros());
            }
            let elapsed_micros = started.elapsed().as_micros();
            let cpu_profile = finish_cpu_profile(running_profile.take())?;
            drop(client);
            connection_task.abort();
            Ok::<_, anyhow::Error>((
                setup_micros,
                elapsed_micros,
                repeat_elapsed_micros,
                settings,
                cpu_profile,
            ))
        })?;

    Ok(speed_hotspot_case(
        DiagnosticEngine::NativePostgres.label(),
        target.id.to_owned(),
        target.label.clone(),
        None,
        None,
        setup_micros,
        elapsed_micros,
        target
            .operation_count
            .saturating_mul(options.target_repeats),
        options.target_repeats,
        options.target_repeat_mode,
        target_repeat_elapsed_micros(options.target_repeats, repeat_elapsed_micros),
        None,
        settings,
        serde_json::json!({
            "enabled": false,
            "reason": "native PostgreSQL diagnostic runs in an external server process"
        }),
        vec![PhaseTiming {
            name: "client.simple_query",
            elapsed_micros,
        }],
        cpu_profile,
    ))
}

fn run_native_postgres_sqlx_speed_hotspot_diagnostic_case(
    cases: &[SpeedCase],
    id: &str,
    postgres_bin: &Path,
    initdb_bin: &Path,
    options: &DiagnosticOptions,
) -> Result<SpeedHotspotDiagnosticCase> {
    let target_index = cases
        .iter()
        .position(|case| case.id == id)
        .ok_or_else(|| anyhow!("unknown speed hotspot case {id}"))?;
    let target = &cases[target_index];

    let open_started = Instant::now();
    let postgres_configs = native_postgres_configs(options);
    let native = NativePostgres::start_with_configs(postgres_bin, initdb_bin, &postgres_configs)
        .with_context(|| {
            format!(
                "start native Postgres SQLx diagnostic cluster for {}",
                target.id
            )
        })?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = ProcessTreeRssSampler::new(native.child.id());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create native Postgres SQLx diagnostic Tokio runtime")?;

    let (
        connect_micros,
        setup_micros,
        elapsed_micros,
        repeat_elapsed_micros,
        settings,
        cpu_profile,
    ) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect_with(&native_postgres_sqlx_options(&native))
            .await
            .context("connect native Postgres SQLx diagnostic client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        for setup_case in &cases[..target_index] {
            let setup_sql = setup_sql_for_case(setup_case, options);
            conn.execute(setup_sql.as_str()).await.with_context(|| {
                format!(
                    "run native Postgres SQLx diagnostic setup case {}",
                    setup_case.id
                )
            })?;
        }
        let setup_micros = setup_started.elapsed().as_micros();
        let settings = sqlx_settings_json(&mut conn)
            .await
            .context("query native Postgres SQLx diagnostic settings")?;
        server_rss.sample();
        let repeat_sqls = target_sqls_for_repeats(target, options)?;

        let mut running_profile = start_cpu_profile(
            Some(native.child.id()),
            options.cpu_profile.as_ref(),
            CpuProfilePidSelection::PreferActivePostgresChild,
        )?;
        let started = Instant::now();
        let mut repeat_elapsed_micros = Vec::with_capacity(repeat_sqls.len());
        for repeat_sql in &repeat_sqls {
            let repeat_started = Instant::now();
            conn.execute(repeat_sql.as_str()).await.with_context(|| {
                format!(
                    "run native Postgres SQLx diagnostic measured case {}",
                    target.id
                )
            })?;
            repeat_elapsed_micros.push(repeat_started.elapsed().as_micros());
        }
        let elapsed_micros = started.elapsed().as_micros();
        let cpu_profile = finish_cpu_profile(running_profile.take())?;
        server_rss.sample();
        conn.close()
            .await
            .context("close native Postgres SQLx diagnostic client")?;
        Ok::<_, anyhow::Error>((
            connect_micros,
            setup_micros,
            elapsed_micros,
            repeat_elapsed_micros,
            settings,
            cpu_profile,
        ))
    })?;

    Ok(speed_hotspot_case(
        DiagnosticEngine::NativePostgresSqlx.label(),
        target.id.to_owned(),
        target.label.clone(),
        Some(open_micros),
        Some(connect_micros),
        setup_micros,
        elapsed_micros,
        target
            .operation_count
            .saturating_mul(options.target_repeats),
        options.target_repeats,
        options.target_repeat_mode,
        target_repeat_elapsed_micros(options.target_repeats, repeat_elapsed_micros),
        server_rss.peak_bytes(),
        settings,
        serde_json::json!({
            "enabled": false,
            "reason": "native PostgreSQL SQLx diagnostic runs in an external server process"
        }),
        vec![
            PhaseTiming {
                name: "native_postgres.open",
                elapsed_micros: open_micros,
            },
            PhaseTiming {
                name: "client.sqlx.connect",
                elapsed_micros: connect_micros,
            },
            PhaseTiming {
                name: "client.sqlx.setup",
                elapsed_micros: setup_micros,
            },
            PhaseTiming {
                name: "client.sqlx.execute",
                elapsed_micros,
            },
        ],
        cpu_profile,
    ))
}

const SPEED_DIAGNOSTIC_SETTINGS_SQL: &str = "SELECT current_setting('shared_buffers') AS shared_buffers,\
            current_setting('fsync') AS fsync,\
            current_setting('full_page_writes') AS full_page_writes,\
            current_setting('wal_level') AS wal_level,\
            current_setting('max_wal_senders') AS max_wal_senders,\
            current_setting('synchronous_commit') AS synchronous_commit,\
            current_setting('wal_buffers') AS wal_buffers,\
            current_setting('work_mem') AS work_mem,\
            current_setting('jit') AS jit,\
            current_setting('enable_bitmapscan') AS enable_bitmapscan,\
            current_setting('enable_indexscan') AS enable_indexscan,\
            current_setting('enable_seqscan') AS enable_seqscan,\
            current_setting('autovacuum') AS autovacuum,\
            current_setting('max_worker_processes') AS max_worker_processes,\
            current_setting('max_parallel_workers') AS max_parallel_workers,\
            current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather,\
            current_setting('exit_on_error') AS exit_on_error,\
            current_setting('search_path') AS search_path,\
            current_setting('TimeZone') AS timezone";

const SPEED_DIAGNOSTIC_SETTINGS_JSON_SQL: &str = "SELECT json_build_object(\
            'shared_buffers', current_setting('shared_buffers'),\
            'fsync', current_setting('fsync'),\
            'full_page_writes', current_setting('full_page_writes'),\
            'wal_level', current_setting('wal_level'),\
            'max_wal_senders', current_setting('max_wal_senders'),\
            'synchronous_commit', current_setting('synchronous_commit'),\
            'wal_buffers', current_setting('wal_buffers'),\
            'work_mem', current_setting('work_mem'),\
            'jit', current_setting('jit'),\
            'enable_bitmapscan', current_setting('enable_bitmapscan'),\
            'enable_indexscan', current_setting('enable_indexscan'),\
            'enable_seqscan', current_setting('enable_seqscan'),\
            'autovacuum', current_setting('autovacuum'),\
            'max_worker_processes', current_setting('max_worker_processes'),\
            'max_parallel_workers', current_setting('max_parallel_workers'),\
            'max_parallel_workers_per_gather', current_setting('max_parallel_workers_per_gather'),\
            'exit_on_error', current_setting('exit_on_error'),\
            'search_path', current_setting('search_path'),\
            'timezone', current_setting('TimeZone'))::text AS settings";

async fn sqlx_settings_json(conn: &mut sqlx::PgConnection) -> Result<serde_json::Value> {
    let row = sqlx::query(SPEED_DIAGNOSTIC_SETTINGS_JSON_SQL)
        .fetch_one(&mut *conn)
        .await
        .context("query diagnostic settings JSON")?;
    let settings: String = row
        .try_get("settings")
        .context("read diagnostic settings JSON")?;
    serde_json::from_str(&settings).context("parse diagnostic settings JSON")
}

async fn native_postgres_settings_json(
    client: &tokio_postgres::Client,
) -> Result<serde_json::Value> {
    let row = client
        .query_one(SPEED_DIAGNOSTIC_SETTINGS_SQL, &[])
        .await
        .context("query native Postgres settings")?;
    let columns = row.columns();
    let row_values = columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            (
                column.name().to_owned(),
                serde_json::Value::String(row.get::<usize, String>(index)),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(serde_json::json!([
        {
            "fields": columns
                .iter()
                .map(|column| {
                    serde_json::json!({
                        "name": column.name(),
                        "dataTypeId": 25,
                    })
                })
                .collect::<Vec<_>>(),
            "rows": [row_values],
            "affectedRows": null
        }
    ]))
}

fn read_pglite_benchmark_sql(id: &str) -> Result<String> {
    let path = Path::new(PGLITE_BENCHMARK_SQL_DIR).join(format!("benchmark{id}.sql"));
    fs::read_to_string(&path)
        .with_context(|| format!("read PGlite benchmark SQL {}", path.display()))
}

fn run_indexed_update_diagnostic_case(
    name: &'static str,
    description: &'static str,
    setup_sql: &[&str],
    measured_sql: &str,
    operation_count: usize,
) -> Result<IndexedUpdateDiagnosticCase> {
    let mut db = Pglite::builder()
        .temporary()
        .open()
        .with_context(|| format!("open diagnostic database for {name}"))?;

    let setup_started = Instant::now();
    for sql in setup_sql {
        db.exec(sql, None)
            .with_context(|| format!("run diagnostic setup for {name}"))?;
    }
    let setup_micros = setup_started.elapsed().as_micros();
    let stats_before = indexed_update_stats(&mut db)
        .with_context(|| format!("collect diagnostic pre-stats for {name}"))?;

    reset_fs_trace();
    let (result, phases) = capture_phase_timings(|| {
        let started = Instant::now();
        let result = db.exec(measured_sql, None);
        (result, started.elapsed())
    });
    let (result, elapsed) = result;
    result.with_context(|| format!("run diagnostic measured SQL for {name}"))?;
    let fs_trace = serde_json::to_value(fs_trace_snapshot())?;
    let stats_after = indexed_update_stats(&mut db)
        .with_context(|| format!("collect diagnostic post-stats for {name}"))?;
    db.close()
        .with_context(|| format!("close diagnostic database for {name}"))?;

    Ok(IndexedUpdateDiagnosticCase {
        name,
        description,
        setup_micros,
        elapsed_micros: elapsed.as_micros(),
        operation_count,
        stats_before,
        stats_after,
        fs_trace,
        phases,
    })
}

fn indexed_update_stats(db: &mut Pglite) -> Result<serde_json::Value> {
    let result = db.query(
        "SELECT \
             pg_relation_size('t2'::regclass)::text AS t2_size, \
             pg_relation_size('i2a'::regclass)::text AS i2a_size, \
             coalesce(pg_relation_size(to_regclass('i2b')), 0)::text AS i2b_size, \
             coalesce((SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_tup_upd, \
             coalesce((SELECT n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_tup_hot_upd, \
             coalesce((SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 't2'), 0)::text AS n_dead_tup",
        &[],
        None,
    )?;
    Ok(result
        .rows
        .into_iter()
        .next()
        .unwrap_or(serde_json::Value::Null))
}

struct RttCase {
    id: &'static str,
    label: &'static str,
    sql: String,
}

#[derive(Clone)]
struct SpeedCase {
    id: &'static str,
    label: String,
    sql: String,
    operation_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SpeedSqlSource {
    Generated,
    PgliteVendored,
}

impl SpeedSqlSource {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "generated" | "local" => Ok(Self::Generated),
            "pglite" | "pglite-vendored" | "upstream" => Ok(Self::PgliteVendored),
            other => bail!("unknown --speed-source value {other:?}; use generated or pglite"),
        }
    }

    fn source_model(self) -> &'static str {
        match self {
            SpeedSqlSource::Generated => {
                "Mirrors the two PGlite benchmark families documented at https://pglite.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and a SQLite speedtest-style SQL suite. The speed suite is generated locally instead of vendoring PGlite's generated SQL files."
            }
            SpeedSqlSource::PgliteVendored => {
                "Mirrors the two PGlite benchmark families documented at https://pglite.dev/benchmarks: trimmed-average CRUD round-trip microbenchmarks and the exact SQL files from assets/checkouts/pglite/packages/benchmark/src."
            }
        }
    }
}

fn run_rtt_direct_benchmark(
    iterations: usize,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Pglite::builder()
        .temporary()
        .postgres_configs(postgres_configs.iter().cloned())
        .open()?;
    let open_micros = open_started.elapsed().as_micros();

    let setup_started = Instant::now();
    db.exec(rtt_setup_sql(), None)?;
    let setup_micros = setup_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in rtt_cases() {
        tests.push(run_rtt_case(iterations, &case, |sql| {
            db.exec(sql, None)?;
            Ok(())
        })?);
    }
    db.close()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "direct",
        description: "PGlite direct Rust API, matching PGlite's in-process exec-style benchmark shape.",
        open_micros,
        connect_micros: None,
        setup_micros,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn run_rtt_server_sqlx_benchmark(
    iterations: usize,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_pglite_server_with_configs(postgres_configs)?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create benchmark Tokio runtime")?;

    let (connect_micros, setup_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx benchmark client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        conn.execute(rtt_setup_sql())
            .await
            .context("execute RTT setup over SQLx")?;
        let setup_micros = setup_started.elapsed().as_micros();
        sample_optional_rss(&mut server_rss);

        let mut tests = Vec::new();
        for case in rtt_cases() {
            let mut samples = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let started = Instant::now();
                conn.execute(case.sql.as_str())
                    .await
                    .with_context(|| format!("execute RTT benchmark {} over SQLx", case.id))?;
                samples.push(started.elapsed().as_micros());
            }
            tests.push(samples_result(
                case.id,
                format!("Test {}: {}", case.id, case.label),
                "milliseconds",
                iterations,
                samples,
            ));
            sample_optional_rss(&mut server_rss);
        }
        conn.close().await.context("close SQLx benchmark client")?;
        Ok::<_, anyhow::Error>((connect_micros, setup_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "server_sqlx",
        description: "PGliteServer over the Postgres wire protocol using one long-lived SQLx connection.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: optional_peak_rss(&server_rss),
        tests,
    })
}

fn run_rtt_server_tokio_postgres_simple_benchmark(
    iterations: usize,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_pglite_server_with_configs(postgres_configs)?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create tokio-postgres simple RTT runtime")?;

    let (connect_micros, setup_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres simple RTT client")?;
        let connection_handle = tokio::spawn(connection);
        let connect_micros = connect_started.elapsed().as_micros();

        let setup_started = Instant::now();
        client
            .batch_execute(rtt_setup_sql())
            .await
            .context("execute RTT setup over tokio-postgres simple-query protocol")?;
        let setup_micros = setup_started.elapsed().as_micros();
        sample_optional_rss(&mut server_rss);

        let mut tests = Vec::new();
        for case in rtt_cases() {
            let mut samples = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let started = Instant::now();
                client.batch_execute(&case.sql).await.with_context(|| {
                    format!(
                        "execute RTT benchmark {} over tokio-postgres simple-query protocol",
                        case.id
                    )
                })?;
                samples.push(started.elapsed().as_micros());
            }
            tests.push(samples_result(
                case.id,
                format!("Test {}: {}", case.id, case.label),
                "milliseconds",
                iterations,
                samples,
            ));
            sample_optional_rss(&mut server_rss);
        }

        drop(client);
        connection_handle
            .await
            .context("join tokio-postgres simple RTT connection task")?
            .context("tokio-postgres simple RTT connection task")?;
        Ok::<_, anyhow::Error>((connect_micros, setup_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "rtt",
        mode: "server_tokio_postgres_simple",
        description: "PGliteServer over the Postgres wire protocol using one long-lived tokio-postgres connection and the simple-query protocol without SQLx.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros,
        observed_server_peak_rss_bytes: optional_peak_rss(&server_rss),
        tests,
    })
}

fn run_speed_direct_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let mut db = Pglite::builder()
        .temporary()
        .postgres_configs(postgres_configs.iter().cloned())
        .open()?;
    let open_micros = open_started.elapsed().as_micros();

    let mut tests = Vec::new();
    for case in speed_cases(scale, sql_source)? {
        let started = Instant::now();
        db.exec(&case.sql, None)
            .with_context(|| format!("execute speed benchmark {}", case.id))?;
        tests.push(single_sample_result(
            case.id,
            case.label,
            "seconds",
            case.operation_count,
            started.elapsed(),
        ));
    }
    db.close()?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "direct",
        description: "Generated SQLite speedtest-style SQL suite through PGlite direct Rust API.",
        open_micros,
        connect_micros: None,
        setup_micros: 0,
        observed_server_peak_rss_bytes: None,
        tests,
    })
}

fn run_speed_server_sqlx_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_pglite_server_with_configs(postgres_configs)?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create benchmark Tokio runtime")?;

    let (connect_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx speed benchmark client")?;
        let connect_micros = connect_started.elapsed().as_micros();

        let mut tests = Vec::new();
        for case in speed_cases(scale, sql_source)? {
            let started = Instant::now();
            conn.execute(case.sql.as_str())
                .await
                .with_context(|| format!("execute speed benchmark {} over SQLx", case.id))?;
            tests.push(single_sample_result(
                case.id,
                case.label,
                "seconds",
                case.operation_count,
                started.elapsed(),
            ));
            sample_optional_rss(&mut server_rss);
        }
        conn.close()
            .await
            .context("close SQLx speed benchmark client")?;
        Ok::<_, anyhow::Error>((connect_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "server_sqlx",
        description: "Generated SQLite speedtest-style SQL suite through one SQLx connection to PgliteServer.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: optional_peak_rss(&server_rss),
        tests,
    })
}

fn run_speed_server_tokio_postgres_simple_benchmark(
    scale: f64,
    sql_source: SpeedSqlSource,
    postgres_configs: &[(String, String)],
) -> Result<BenchmarkRun> {
    let open_started = Instant::now();
    let server = benchmark_pglite_server_with_configs(postgres_configs)?;
    let open_micros = open_started.elapsed().as_micros();
    let mut server_rss = server.server_process_id().map(ProcessTreeRssSampler::new);
    let uri = server.database_url();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create tokio-postgres simple speed runtime")?;

    let (connect_micros, tests) = runtime.block_on(async {
        let connect_started = Instant::now();
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres simple speed client")?;
        let connection_handle = tokio::spawn(connection);
        let connect_micros = connect_started.elapsed().as_micros();

        let mut tests = Vec::new();
        for case in speed_cases(scale, sql_source)? {
            let started = Instant::now();
            client.batch_execute(&case.sql).await.with_context(|| {
                format!(
                    "execute speed benchmark {} over tokio-postgres simple-query protocol",
                    case.id
                )
            })?;
            tests.push(single_sample_result(
                case.id,
                case.label,
                "seconds",
                case.operation_count,
                started.elapsed(),
            ));
            sample_optional_rss(&mut server_rss);
        }

        drop(client);
        connection_handle
            .await
            .context("join tokio-postgres simple speed connection task")?
            .context("tokio-postgres simple speed connection task")?;
        Ok::<_, anyhow::Error>((connect_micros, tests))
    })?;
    server.shutdown()?;

    Ok(BenchmarkRun {
        suite: "speed",
        mode: "server_tokio_postgres_simple",
        description: "Generated SQLite speedtest-style SQL suite through one tokio-postgres connection to PgliteServer using the simple-query protocol.",
        open_micros,
        connect_micros: Some(connect_micros),
        setup_micros: 0,
        observed_server_peak_rss_bytes: optional_peak_rss(&server_rss),
        tests,
    })
}

fn benchmark_pglite_server_with_configs(
    postgres_configs: &[(String, String)],
) -> Result<PgliteServer> {
    benchmark_pglite_server_with_configs_and_runtime(postgres_configs, None)
}

fn benchmark_pglite_server_with_configs_and_runtime(
    postgres_configs: &[(String, String)],
    runtime_config: Option<&PgliteServerRuntimeConfig>,
) -> Result<PgliteServer> {
    let mut builder = PgliteServer::builder()
        .temporary()
        .database("postgres")
        .postgres_configs(postgres_configs.iter().cloned());
    if let Some(runtime_config) = runtime_config {
        builder = builder.runtime_config(runtime_config.clone());
    }
    builder.start()
}

fn rtt_setup_sql() -> &'static str {
    "\
CREATE TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);
CREATE TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);
"
}

fn rtt_cases() -> Vec<RttCase> {
    vec![
        RttCase {
            id: "1",
            label: "insert small row",
            sql: "INSERT INTO t1 (a) VALUES (1);".to_owned(),
        },
        RttCase {
            id: "2",
            label: "select small row",
            sql: "SELECT * FROM t1 WHERE id = 333;".to_owned(),
        },
        RttCase {
            id: "3",
            label: "update small row",
            sql: "UPDATE t1 SET a = 2 WHERE id = 666;".to_owned(),
        },
        RttCase {
            id: "4",
            label: "delete small row",
            sql: "DELETE FROM t1 WHERE id IN (SELECT id FROM t1 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "5",
            label: "insert 1kb row",
            sql: format!("INSERT INTO t2 (a) VALUES ('{}');", "a".repeat(1_000)),
        },
        RttCase {
            id: "6",
            label: "select 1kb row",
            sql: "SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "7",
            label: "update 1kb row",
            sql: format!("UPDATE t2 SET a = '{}' WHERE id = 1;", "a".repeat(1_000)),
        },
        RttCase {
            id: "8",
            label: "delete 1kb row",
            sql: "DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "9",
            label: "insert 10kb row",
            sql: format!("INSERT INTO t2 (a) VALUES ('{}');", "a".repeat(10_000)),
        },
        RttCase {
            id: "10",
            label: "select 10kb row",
            sql: "SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
        RttCase {
            id: "11",
            label: "update 10kb row",
            sql: format!("UPDATE t2 SET a = '{}' WHERE id = 1;", "a".repeat(10_000)),
        },
        RttCase {
            id: "12",
            label: "delete 10kb row",
            sql: "DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);".to_owned(),
        },
    ]
}

fn run_rtt_case(
    iterations: usize,
    case: &RttCase,
    mut execute: impl FnMut(&str) -> Result<()>,
) -> Result<BenchmarkTestResult> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        execute(&case.sql).with_context(|| format!("execute RTT benchmark {}", case.id))?;
        samples.push(started.elapsed().as_micros());
    }
    Ok(samples_result(
        case.id,
        format!("Test {}: {}", case.id, case.label),
        "milliseconds",
        iterations,
        samples,
    ))
}

fn samples_result(
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    samples: Vec<u128>,
) -> BenchmarkTestResult {
    let elapsed_micros = samples.iter().sum();
    let mut sorted = samples;
    sorted.sort_unstable();
    let trim = if sorted.len() >= 10 {
        sorted.len() / 10
    } else {
        0
    };
    let trimmed = &sorted[trim..sorted.len() - trim];
    let average = trimmed.iter().sum::<u128>() as f64 / trimmed.len() as f64;
    let p50 = percentile_sorted(&sorted, 0.50);
    let p90 = percentile_sorted(&sorted, 0.90);
    let p95 = percentile_sorted(&sorted, 0.95);
    BenchmarkTestResult {
        id,
        label,
        unit,
        operation_count,
        sample_count: sorted.len(),
        trimmed_sample_count: trimmed.len(),
        elapsed_micros,
        average_micros: Some(average),
        min_micros: sorted.first().copied(),
        p50_micros: p50,
        p90_micros: p90,
        p95_micros: p95,
    }
}

fn single_sample_result(
    id: &'static str,
    label: String,
    unit: &'static str,
    operation_count: usize,
    elapsed: Duration,
) -> BenchmarkTestResult {
    let elapsed_micros = elapsed.as_micros();
    BenchmarkTestResult {
        id,
        label,
        unit,
        operation_count,
        sample_count: 1,
        trimmed_sample_count: 1,
        elapsed_micros,
        average_micros: None,
        min_micros: Some(elapsed_micros),
        p50_micros: Some(elapsed_micros),
        p90_micros: Some(elapsed_micros),
        p95_micros: Some(elapsed_micros),
    }
}

fn percentile_sorted(sorted: &[u128], percentile: f64) -> Option<u128> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * percentile).round() as usize;
    sorted.get(idx).copied()
}

fn speed_cases(scale: f64, sql_source: SpeedSqlSource) -> Result<Vec<SpeedCase>> {
    let insert_1k = scaled_count(1_000, scale);
    let insert_25k = scaled_count(25_000, scale);
    let select_100 = scaled_count(100, scale);
    let select_5k = scaled_count(5_000, scale);
    let update_1k = scaled_count(1_000, scale);
    let update_25k = scaled_count(25_000, scale);
    let refill_12k = scaled_count(12_000, scale);
    let mut cases = vec![
        SpeedCase {
            id: "1",
            label: format!("Test 1: {insert_1k} INSERTs"),
            sql: speed_create_and_insert("t1", insert_1k, false, false),
            operation_count: insert_1k,
        },
        SpeedCase {
            id: "2",
            label: format!("Test 2: {insert_25k} INSERTs in a transaction"),
            sql: speed_create_and_insert("t2", insert_25k, true, false),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "2.1",
            label: format!("Test 2.1: {insert_25k} INSERTs in single statement"),
            sql: speed_create_and_insert("t2_1", insert_25k, true, true),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "3",
            label: format!("Test 3: {insert_25k} INSERTs into an indexed table"),
            sql: speed_indexed_create_and_insert("t3", "i3", insert_25k, false),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "3.1",
            label: format!("Test 3.1: {insert_25k} INSERTs into an indexed table in single statement"),
            sql: speed_indexed_create_and_insert("t3_1", "i3_1", insert_25k, true),
            operation_count: insert_25k,
        },
        SpeedCase {
            id: "4",
            label: format!("Test 4: {select_100} SELECTs without an index"),
            sql: speed_select_range("t2", select_100, 100),
            operation_count: select_100,
        },
        SpeedCase {
            id: "5",
            label: format!("Test 5: {select_100} SELECTs on a string comparison"),
            sql: speed_select_like("t2", select_100),
            operation_count: select_100,
        },
        SpeedCase {
            id: "6",
            label: "Test 6: Creating indexes".to_owned(),
            sql: "CREATE INDEX i2a ON t2(a);\nCREATE INDEX i2b ON t2(b);\n".to_owned(),
            operation_count: 2,
        },
        SpeedCase {
            id: "7",
            label: format!("Test 7: {select_5k} SELECTs with an index"),
            sql: speed_select_range("t2", select_5k, 100),
            operation_count: select_5k,
        },
        SpeedCase {
            id: "8",
            label: format!("Test 8: {update_1k} UPDATEs without an index"),
            sql: speed_update_t1(update_1k),
            operation_count: update_1k,
        },
        SpeedCase {
            id: "9",
            label: format!("Test 9: {update_25k} UPDATEs with an index"),
            sql: speed_update_t2_numeric(update_25k),
            operation_count: update_25k,
        },
        SpeedCase {
            id: "10",
            label: format!("Test 10: {update_25k} text UPDATEs with an index"),
            sql: speed_update_t2_text(update_25k),
            operation_count: update_25k,
        },
        SpeedCase {
            id: "11",
            label: "Test 11: INSERTs from a SELECT".to_owned(),
            sql: "BEGIN;\nINSERT INTO t1 SELECT b,a,c FROM t2;\nINSERT INTO t2 SELECT b,a,c FROM t1;\nCOMMIT;\n".to_owned(),
            operation_count: 2,
        },
        SpeedCase {
            id: "12",
            label: "Test 12: DELETE without an index".to_owned(),
            sql: "DELETE FROM t2 WHERE c LIKE '%fifty%';\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "13",
            label: "Test 13: DELETE with an index".to_owned(),
            sql: "DELETE FROM t2 WHERE a > 10 AND a < 20000;\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "14",
            label: "Test 14: A big INSERT after a big DELETE".to_owned(),
            sql: "INSERT INTO t2 SELECT * FROM t1;\n".to_owned(),
            operation_count: 1,
        },
        SpeedCase {
            id: "15",
            label: format!("Test 15: A big DELETE followed by {refill_12k} small INSERTs"),
            sql: speed_delete_and_refill_t1(refill_12k),
            operation_count: refill_12k + 1,
        },
        SpeedCase {
            id: "16",
            label: "Test 16: DROP TABLE".to_owned(),
            sql: "DROP TABLE t1;\nDROP TABLE t2;\nDROP TABLE t3;\nDROP TABLE t2_1;\nDROP TABLE t3_1;\n".to_owned(),
            operation_count: 5,
        },
    ];

    if sql_source == SpeedSqlSource::PgliteVendored {
        let benchmark_dir = Path::new(PGLITE_BENCHMARK_SQL_DIR);
        for case in &mut cases {
            let path = benchmark_dir.join(format!("benchmark{}.sql", case.id));
            case.sql = fs::read_to_string(&path)
                .with_context(|| format!("read PGlite benchmark SQL {}", path.display()))?;
        }
    }

    Ok(cases)
}

fn scaled_count(base: usize, scale: f64) -> usize {
    ((base as f64 * scale).round() as usize).max(1)
}

fn speed_create_and_insert(
    table: &str,
    rows: usize,
    transaction: bool,
    single_statement: bool,
) -> String {
    let mut sql = String::new();
    if transaction {
        sql.push_str("BEGIN;\n");
    }
    sql.push_str(&format!(
        "CREATE TABLE {table}(a INTEGER, b INTEGER, c VARCHAR(100));\n"
    ));
    if single_statement {
        sql.push_str(&format!("INSERT INTO {table} VALUES\n"));
        for row in 1..=rows {
            if row > 1 {
                sql.push_str(",\n");
            }
            sql.push_str(&speed_row_values(row, row));
        }
        sql.push_str(";\n");
    } else {
        append_insert_rows(&mut sql, table, rows, 0);
    }
    if transaction {
        sql.push_str("COMMIT;\n");
    }
    sql
}

fn speed_indexed_create_and_insert(
    table: &str,
    index: &str,
    rows: usize,
    single_statement: bool,
) -> String {
    let mut sql = String::new();
    sql.push_str("BEGIN;\n");
    sql.push_str(&format!(
        "CREATE TABLE {table}(a INTEGER, b INTEGER, c VARCHAR(100));\n"
    ));
    sql.push_str(&format!("CREATE INDEX {index} ON {table}(c);\n"));
    if single_statement {
        sql.push_str(&format!("INSERT INTO {table} VALUES\n"));
        for row in 1..=rows {
            if row > 1 {
                sql.push_str(",\n");
            }
            sql.push_str(&speed_row_values(row, row + 17));
        }
        sql.push_str(";\n");
    } else {
        append_insert_rows(&mut sql, table, rows, 17);
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn append_insert_rows(sql: &mut String, table: &str, rows: usize, seed_offset: usize) {
    for row in 1..=rows {
        sql.push_str(&format!(
            "INSERT INTO {table} VALUES{};\n",
            speed_row_values(row, row + seed_offset)
        ));
    }
}

fn speed_row_values(row: usize, seed: usize) -> String {
    let value = deterministic_benchmark_value(seed);
    format!("({row}, {value}, '{}')", synthetic_benchmark_text(value))
}

fn speed_select_range(table: &str, count: usize, width: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let low = step * width;
        let high = low + width;
        sql.push_str(&format!(
            "SELECT count(*), avg(b) FROM {table} WHERE b >= {low} AND b < {high};\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn select_shape_speed_cases(count: usize) -> Vec<SpeedCase> {
    vec![
        SpeedCase {
            id: "select_constant",
            label: format!("Select shape: {count} SELECT 1 statements"),
            sql: speed_select_constant(count),
            operation_count: count,
        },
        SpeedCase {
            id: "select_count_avg_same_range",
            label: format!(
                "Select shape: {count} indexed count+avg SELECTs over one repeated range"
            ),
            sql: speed_select_range_projection("count(*), avg(b)", count, 100, true, None),
            operation_count: count,
        },
        SpeedCase {
            id: "select_count_avg_distinct_ranges",
            label: format!("Select shape: {count} indexed count+avg SELECTs over distinct ranges"),
            sql: speed_select_range_projection("count(*), avg(b)", count, 100, false, None),
            operation_count: count,
        },
        SpeedCase {
            id: "select_count_only_distinct_ranges",
            label: format!("Select shape: {count} indexed count-only SELECTs over distinct ranges"),
            sql: speed_select_range_projection("count(*)", count, 100, false, None),
            operation_count: count,
        },
        SpeedCase {
            id: "select_avg_only_distinct_ranges",
            label: format!("Select shape: {count} indexed avg-only SELECTs over distinct ranges"),
            sql: speed_select_range_projection("avg(b)", count, 100, false, None),
            operation_count: count,
        },
        SpeedCase {
            id: "select_index_only_limit",
            label: format!("Select shape: {count} indexed LIMIT 1 reads of indexed column b"),
            sql: speed_select_range_projection("b", count, 100, false, Some(1)),
            operation_count: count,
        },
        SpeedCase {
            id: "select_heap_limit",
            label: format!("Select shape: {count} indexed LIMIT 1 reads of full heap row"),
            sql: speed_select_range_projection("a, b, c", count, 100, false, Some(1)),
            operation_count: count,
        },
    ]
}

fn speed_select_constant(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for _ in 0..count {
        sql.push_str("SELECT 1;\n");
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_select_range_projection(
    projection: &str,
    count: usize,
    width: usize,
    repeat_same_range: bool,
    limit: Option<usize>,
) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let range_step = if repeat_same_range { 0 } else { step };
        let low = range_step * width;
        let high = low + width;
        sql.push_str(&format!(
            "SELECT {projection} FROM t2 WHERE b >= {low} AND b < {high}"
        ));
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        sql.push_str(";\n");
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_select_like(table: &str, count: usize) -> String {
    const WORDS: &[&str] = &[
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let word = WORDS[step % WORDS.len()];
        sql.push_str(&format!(
            "SELECT count(*), avg(b) FROM {table} WHERE c LIKE '%{word}%';\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t1(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let low = step * 10;
        let high = low + 10;
        sql.push_str(&format!(
            "UPDATE t1 SET b = b * 2 WHERE a >= {low} AND a < {high};\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t1_repeat_safe_variant(count: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for step in 0..count {
        let low = step * 10;
        let high = low + 10;
        sql.push_str(&format!(
            "UPDATE t1 SET b = b * -1 WHERE a >= {low} AND a < {high};\n"
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t2_numeric(count: usize) -> String {
    speed_update_t2_numeric_variant(count, 0)
}

fn speed_update_t2_numeric_variant(count: usize, variant: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for row in 1..=count {
        let value = deterministic_benchmark_value(row + 101 + variant.saturating_mul(count + 17));
        sql.push_str(&format!("UPDATE t2 SET b = {value} WHERE a = {row};\n"));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_update_t2_text(count: usize) -> String {
    speed_update_t2_text_variant(count, 0)
}

fn speed_update_t2_text_variant(count: usize, variant: usize) -> String {
    let mut sql = String::from("BEGIN;\n");
    for row in 1..=count {
        let value = deterministic_benchmark_value(row + 202 + variant.saturating_mul(count + 31));
        sql.push_str(&format!(
            "UPDATE t2 SET c = '{}' WHERE a = {row};\n",
            synthetic_benchmark_text(value)
        ));
    }
    sql.push_str("COMMIT;\n");
    sql
}

fn speed_delete_and_refill_t1(count: usize) -> String {
    let mut sql = String::from("BEGIN;\nDELETE FROM t1;\n");
    append_insert_rows(&mut sql, "t1", count, 303);
    sql.push_str("COMMIT;\n");
    sql
}

fn deterministic_benchmark_value(seed: usize) -> usize {
    ((seed as u64)
        .wrapping_mul(1_103_515_245)
        .wrapping_add(12_345)
        % 100_000) as usize
}

fn synthetic_benchmark_text(value: usize) -> String {
    const WORDS: &[&str] = &[
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    format!(
        "{} {} {} {}",
        WORDS[value % WORDS.len()],
        WORDS[(value / 7) % WORDS.len()],
        WORDS[(value / 97) % WORDS.len()],
        value
    )
}

#[allow(clippy::too_many_arguments)]
fn capture_operation(
    name: &'static str,
    description: &'static str,
    cache_state_before: impl Into<String>,
    process_state_before: &'static str,
    root_state: &'static str,
    query_state: &'static str,
    workload: &'static str,
    primary_latency_phase: &'static str,
    operation: impl FnOnce() -> Result<()>,
) -> Result<PerfOperation> {
    let started = Instant::now();
    let (result, phases) = capture_phase_timings(operation);
    let elapsed_micros = started.elapsed().as_micros();
    result?;
    let primary_latency_micros = phases
        .iter()
        .rev()
        .find(|phase| phase.name == primary_latency_phase)
        .map(|phase| phase.elapsed_micros)
        .unwrap_or(elapsed_micros);
    Ok(PerfOperation {
        name,
        description,
        cache_state_before: cache_state_before.into(),
        process_state_before,
        root_state,
        query_state,
        workload,
        primary_latency_phase,
        primary_latency_micros,
        elapsed_micros,
        correct: true,
        phases,
    })
}

fn pglite_oxide_cache_dir() -> Result<PathBuf> {
    ProjectDirs::from("dev", "pglite-oxide", "pglite-oxide")
        .context("could not resolve pglite-oxide cache directory")
        .map(|dirs| dirs.cache_dir().to_path_buf())
}

fn run_direct_select_one() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Pglite::builder().temporary().open()?;
    let result = db.query(
        "SELECT $1::int4 + 1 AS answer",
        &[serde_json::json!(41)],
        None,
    )?;
    ensure_json_int(&result.rows[0]["answer"], 42)?;
    record_phase_timing(
        "visible.direct_open_to_first_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_vector_query() -> Result<()> {
    let visible_started = Instant::now();
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;
    let result = db.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
        &[],
        None,
    )?;
    if result.rows[0]["distance"].as_f64().is_none() {
        bail!("extension-backed query did not return a float distance");
    }
    record_phase_timing(
        "visible.direct_open_to_first_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.close", || db.close())
}

fn run_server_sqlx_select_one() -> Result<()> {
    let visible_started = Instant::now();
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let started = Instant::now();
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to PGliteServer")?;
        record_phase_timing("client.sqlx_connect", started.elapsed());
        let started = Instant::now();
        let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
            .bind(41_i32)
            .fetch_one(&mut conn)
            .await
            .context("run first SQLx query")?;
        record_phase_timing("client.sqlx_first_query", started.elapsed());
        let answer: i32 = row.try_get("answer").context("read SQLx answer")?;
        if answer != 42 {
            bail!("SQLx server query returned {answer}, expected 42");
        }
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    record_phase_timing(
        "visible.server_start_to_first_sqlx_query",
        visible_started.elapsed(),
    );
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_direct_repeated_selects(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    run_direct_scalar_query(&mut db, 41)?;
    let started = Instant::now();
    for value in 0..iterations {
        run_direct_scalar_query(&mut db, value as i32)?;
    }
    record_total_and_average(
        "warm.direct_repeated_scalar_queries.total",
        "warm.direct_repeated_scalar_queries.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_transaction_batch(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    run_direct_scalar_query(&mut db, 41)?;
    let started = Instant::now();
    db.transaction(|tx| {
        for value in 0..iterations {
            let result = tx.query(
                "SELECT $1::int4 + 1 AS answer",
                &[serde_json::json!(value as i32)],
                None,
            )?;
            ensure_json_int(&result.rows[0]["answer"], value as i64 + 1)?;
        }
        Ok(())
    })?;
    record_total_and_average(
        "warm.direct_transaction_batch.total",
        "warm.direct_transaction_batch.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_repeated_vector_queries(iterations: usize) -> Result<()> {
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;
    run_direct_vector_distance_query(&mut db)?;
    let started = Instant::now();
    for _ in 0..iterations {
        run_direct_vector_distance_query(&mut db)?;
    }
    record_total_and_average(
        "warm.direct_repeated_vector_queries.total",
        "warm.direct_repeated_vector_queries.avg",
        started.elapsed(),
        iterations,
    );
    measure_phase("operation.close", || db.close())
}

fn run_direct_scalar_query(db: &mut Pglite, value: i32) -> Result<()> {
    let result = db.query(
        "SELECT $1::int4 + 1 AS answer",
        &[serde_json::json!(value)],
        None,
    )?;
    ensure_json_int(&result.rows[0]["answer"], value as i64 + 1)
}

fn run_direct_vector_distance_query(db: &mut Pglite) -> Result<()> {
    let result = db.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
        &[],
        None,
    )?;
    if result.rows[0]["distance"].as_f64().is_none() {
        bail!("extension-backed query did not return a float distance");
    }
    Ok(())
}

fn run_server_sqlx_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to PGliteServer")?;
        run_sqlx_scalar_query(&mut conn, 41).await?;
        let started = Instant::now();
        for value in 0..iterations {
            run_sqlx_scalar_query(&mut conn, value as i32).await?;
        }
        record_total_and_average(
            "warm.server_sqlx_single_connection_repeated_queries.total",
            "warm.server_sqlx_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_sqlx_repeated_connections(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let started = Instant::now();
        for value in 0..iterations {
            let mut conn = sqlx::PgConnection::connect(&uri)
                .await
                .context("connect SQLx to PGliteServer")?;
            run_sqlx_scalar_query(&mut conn, value as i32).await?;
            conn.close().await.context("close SQLx connection")?;
        }
        record_total_and_average(
            "warm.server_sqlx_repeated_connections.total",
            "warm.server_sqlx_repeated_connections.avg",
            started.elapsed(),
            iterations,
        );
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_sqlx_vector_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", || {
        PgliteServer::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .start()
    })?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let mut conn = sqlx::PgConnection::connect(&uri)
            .await
            .context("connect SQLx to extension-enabled PGliteServer")?;
        run_sqlx_vector_query(&mut conn).await?;
        let started = Instant::now();
        for _ in 0..iterations {
            run_sqlx_vector_query(&mut conn).await?;
        }
        record_total_and_average(
            "warm.server_sqlx_vector_single_connection_repeated_queries.total",
            "warm.server_sqlx_vector_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        conn.close().await.context("close SQLx connection")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

fn run_server_tokio_postgres_single_connection_repeated_queries(iterations: usize) -> Result<()> {
    let server = measure_phase("server.start", PgliteServer::temporary_tcp)?;
    let uri = server.database_url();
    let runtime = measure_phase("client.tokio_runtime_create", || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create perf tokio runtime")
    })?;
    runtime.block_on(async move {
        let (client, connection) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .context("connect tokio-postgres to PGliteServer")?;
        let connection_handle = tokio::spawn(connection);
        run_tokio_postgres_scalar_query(&client, 41).await?;
        let started = Instant::now();
        for value in 0..iterations {
            run_tokio_postgres_scalar_query(&client, value as i32).await?;
        }
        record_total_and_average(
            "warm.server_tokio_postgres_single_connection_repeated_queries.total",
            "warm.server_tokio_postgres_single_connection_repeated_queries.avg",
            started.elapsed(),
            iterations,
        );
        drop(client);
        connection_handle
            .await
            .context("join tokio-postgres connection task")?
            .context("tokio-postgres connection task")?;
        Ok::<_, anyhow::Error>(())
    })?;
    measure_phase("operation.shutdown", || server.shutdown())
}

async fn run_sqlx_scalar_query(conn: &mut sqlx::PgConnection, value: i32) -> Result<()> {
    let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
        .bind(value)
        .fetch_one(conn)
        .await
        .context("run SQLx scalar query")?;
    let answer: i32 = row.try_get("answer").context("read SQLx answer")?;
    ensure!(answer == value + 1, "SQLx query returned {answer}");
    Ok(())
}

async fn run_sqlx_vector_query(conn: &mut sqlx::PgConnection) -> Result<()> {
    let row = sqlx::query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
        .fetch_one(conn)
        .await
        .context("run SQLx vector query")?;
    let distance: f64 = row.try_get("distance").context("read vector distance")?;
    ensure!(distance == 1.0, "SQLx vector query returned {distance}");
    Ok(())
}

async fn run_tokio_postgres_scalar_query(
    client: &tokio_postgres::Client,
    value: i32,
) -> Result<()> {
    let row = client
        .query_one("SELECT $1::int4 + 1 AS answer", &[&value])
        .await
        .context("run tokio-postgres scalar query")?;
    let answer: i32 = row.get("answer");
    ensure!(
        answer == value + 1,
        "tokio-postgres query returned {answer}"
    );
    Ok(())
}

fn record_total_and_average(
    total_name: &'static str,
    average_name: &'static str,
    elapsed: Duration,
    iterations: usize,
) {
    record_phase_timing(total_name, elapsed);
    let average = elapsed.as_micros() / iterations as u128;
    record_phase_timing(
        average_name,
        Duration::from_micros(average.try_into().unwrap_or(u64::MAX)),
    );
}

fn unique_perf_root(name: &str) -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("read system clock for perf root")?
        .as_nanos();
    let root = env::temp_dir().join(format!("pglite-oxide-{name}-{}-{now}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("remove stale perf root {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("create perf root {}", root.display()))?;
    Ok(root)
}

fn ensure_json_int(value: &serde_json::Value, expected: i64) -> Result<()> {
    let Some(actual) = value.as_i64() else {
        bail!("expected integer JSON value {expected}, got {value}");
    };
    if actual != expected {
        bail!("expected integer JSON value {expected}, got {actual}");
    }
    Ok(())
}

fn check_sources_manifest(strict_local: bool) -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    if strict_local {
        check_source_spine(&manifest, true, false)?;
    }
    println!("validated {} pinned asset sources", manifest.sources.len());
    Ok(manifest)
}

fn check_sources_manifest_for_asset_build(args: &[String]) -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    if args.iter().any(|arg| arg == "--fetch") {
        fetch_pinned_sources(&manifest)?;
    } else {
        check_source_spine(&manifest, true, false)?;
    }
    println!("validated {} pinned asset sources", manifest.sources.len());
    Ok(manifest)
}

fn fetch_pinned_sources(manifest: &SourcesManifest) -> Result<()> {
    for source in &manifest.sources {
        let Some(path) = source_checkout_path(source.name.as_str()) else {
            eprintln!(
                "warning: source '{}' has no configured checkout path; skipping fetch",
                source.name
            );
            continue;
        };
        if !path.exists() || !path.join(".git").exists() {
            init_source_checkout(source, path)?;
        }
        ensure_clean_checkout(source, path)?;
        ensure_source_remote(path, source)?;
        let mut fetch = Command::new("git");
        fetch
            .args(["fetch", "--depth", "1", "origin", &source.commit])
            .current_dir(path);
        run_command(&mut fetch).with_context(|| format!("fetch {}", source.name))?;
        let mut checkout = Command::new("git");
        checkout
            .args(["checkout", "-B", &source.branch, &source.commit])
            .current_dir(path);
        run_command(&mut checkout).with_context(|| {
            format!(
                "checkout {} at {} in {}",
                source.name,
                source.commit,
                path.display()
            )
        })?;
    }
    check_source_spine(manifest, true, false)
}

fn init_source_checkout(source: &SourcePin, path: &Path) -> Result<()> {
    if path.exists() && !path.join(".git").exists() {
        if path.read_dir()?.next().is_none() {
            fs::remove_dir_all(path)
                .with_context(|| format!("remove empty source placeholder {}", path.display()))?;
        } else {
            bail!(
                "source checkout path {} exists but is not a git checkout; remove it or move it aside",
                path.display()
            );
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut command = Command::new("git");
    command.arg("init").arg(path);
    run_command(&mut command)
        .with_context(|| format!("initialize source checkout {}", path.display()))?;
    ensure_source_remote(path, source)
}

fn ensure_source_remote(path: &Path, source: &SourcePin) -> Result<()> {
    let remotes = command_output("git", &["remote"], path)
        .with_context(|| format!("read git remotes for {}", path.display()))?;
    let mut command = Command::new("git");
    if remotes.lines().any(|remote| remote == "origin") {
        command.args(["remote", "set-url", "origin", &source.url]);
    } else {
        command.args(["remote", "add", "origin", &source.url]);
    }
    command.current_dir(path);
    run_command(&mut command).with_context(|| {
        format!(
            "configure origin remote for {} at {}",
            source.name,
            path.display()
        )
    })
}

fn source_checkout_path(name: &str) -> Option<&'static Path> {
    match name {
        POSTGRES_PGLITE_SOURCE => Some(Path::new(POSTGRES_PGLITE_PATH)),
        PGLITE_BUILD_SOURCE => Some(Path::new(PGLITE_BUILD_PATH)),
        "pglite" => Some(Path::new("assets/checkouts/pglite")),
        "pgvector" => Some(Path::new(PGVECTOR_BUILD_DIR)),
        "pgtap" => Some(Path::new("assets/checkouts/pgtap")),
        "pg_ivm" => Some(Path::new("assets/checkouts/pg_ivm")),
        "pg_uuidv7" => Some(Path::new("assets/checkouts/pg_uuidv7")),
        "pg_hashids" => Some(Path::new("assets/checkouts/pg_hashids")),
        "age" => Some(Path::new("assets/checkouts/age")),
        "pg_textsearch" => Some(Path::new("assets/checkouts/pg_textsearch")),
        "postgis" => Some(Path::new("assets/checkouts/postgis")),
        "pglite-bindings" => Some(Path::new("assets/checkouts/pglite-bindings")),
        _ => None,
    }
}

fn ensure_clean_checkout(source: &SourcePin, path: &Path) -> Result<()> {
    if !path.exists() {
        bail!("source checkout is missing: {}", path.display());
    }
    let status = source_checkout_status_for_source(source.name.as_str(), path)
        .with_context(|| format!("read status for {}", path.display()))?;
    if !status.trim().is_empty() {
        bail!(
            "source checkout {} ({}) has uncommitted changes; preserve them before fetching pins",
            path.display(),
            source.name
        );
    }
    Ok(())
}

fn load_sources_manifest() -> Result<SourcesManifest> {
    let path = Path::new("assets/sources.toml");
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    toml::from_str(&text).context("parse assets/sources.toml")
}

fn validate_sources_manifest(manifest: &SourcesManifest) -> Result<()> {
    if manifest.sources.is_empty() {
        bail!("assets/sources.toml must contain at least one source pin");
    }
    ensure_eq(
        &manifest.toolchain.wasmer,
        "7.2.0-alpha.2",
        "toolchain.wasmer",
    )?;
    ensure_eq(
        &manifest.toolchain.wasmer_wasix,
        "0.702.0-alpha.2",
        "toolchain.wasmer-wasix",
    )?;
    if !manifest
        .toolchain
        .docker_image_digest
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit()))
    {
        bail!(
            "toolchain.docker_image_digest must pin a concrete sha256 digest, got {}",
            manifest.toolchain.docker_image_digest
        );
    }
    let dockerfile = fs::read_to_string("assets/wasix-build/docker/Dockerfile")
        .context("read WASIX build Dockerfile")?;
    if !dockerfile.contains(&format!(
        "FROM ubuntu:24.04@{}",
        manifest.toolchain.docker_image_digest
    )) {
        bail!("WASIX build Dockerfile must pin the same base image digest as assets/sources.toml");
    }
    ensure_eq(
        &manifest.build.postgres_prefix,
        "/",
        "build.postgres_prefix",
    )?;
    ensure_eq(
        &manifest.build.postgres_pkglibdir,
        "/lib/postgresql",
        "build.postgres_pkglibdir",
    )?;
    ensure_eq(
        &manifest.build.postgres_sharedir,
        "/share/postgresql",
        "build.postgres_sharedir",
    )?;
    ensure_contains(
        &manifest.build.main_flags,
        "-fwasm-exceptions",
        "build.main_flags",
    )?;
    ensure_no_flag_contains(&manifest.build.main_flags, "asyncify", "build.main_flags")?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-fwasm-exceptions",
        "build.extension_flags",
    )?;
    ensure_no_flag_contains(
        &manifest.build.extension_flags,
        "asyncify",
        "build.extension_flags",
    )?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-fPIC",
        "build.extension_flags",
    )?;
    ensure_contains(
        &manifest.build.extension_flags,
        "-Wl,-shared",
        "build.extension_flags",
    )?;
    ensure_eq(
        &manifest.build.archive_format,
        "tar.zst",
        "build.archive_format",
    )?;
    if !manifest.build.deterministic_archives {
        bail!("build.deterministic_archives must be true");
    }
    for source in &manifest.sources {
        if source.name.trim().is_empty()
            || source.url.trim().is_empty()
            || source.branch.trim().is_empty()
            || source.commit.len() < 40
        {
            bail!("invalid source pin in assets/sources.toml: {source:?}");
        }
    }
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    let expected_postgres_branch = cargo_metadata_value("postgres-pglite-branch")?;
    ensure_eq(
        &postgres.branch,
        &expected_postgres_branch,
        "postgres-pglite source branch",
    )?;
    let expected_postgres_version = cargo_metadata_value("postgres-version")?;
    let postgres_version = postgres_version_from_sources(manifest)?;
    ensure_eq(
        &postgres_version,
        &expected_postgres_version,
        "postgres-pglite source version",
    )?;
    let pglite_build = source_by_name(manifest, PGLITE_BUILD_SOURCE)?;
    ensure_eq(
        &pglite_build.branch,
        EXPECTED_PGLITE_BUILD_BRANCH,
        "pglite-build source branch",
    )?;
    Ok(())
}

fn check_generated_manifest(manifest: &SourcesManifest, strict: bool) -> Result<()> {
    let path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    if !path.exists() {
        if strict {
            bail!("generated asset manifest is missing at {}", path.display());
        }
        eprintln!(
            "warning: generated asset manifest is missing at {}",
            path.display()
        );
        return Ok(());
    }

    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let generated: GeneratedAssetManifest =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;

    let mut drift = Vec::new();
    let expected_postgres_version = postgres_version_from_sources(manifest)?;
    match &generated.runtime {
        Some(runtime) if runtime.postgres_version == expected_postgres_version => {}
        Some(runtime) => drift.push(format!(
            "runtime postgres-version generated={} expected={}",
            runtime.postgres_version, expected_postgres_version
        )),
        None => drift.push("runtime postgres-version missing from generated manifest".to_owned()),
    }
    for source in &manifest.sources {
        match generated
            .sources
            .iter()
            .find(|generated| generated.name == source.name)
        {
            Some(generated)
                if generated.url == source.url
                    && generated.branch == source.branch
                    && generated.commit == source.commit => {}
            Some(generated) => drift.push(format!(
                "{} generated={}/{}@{} expected={}/{}@{}",
                source.name,
                generated.url,
                generated.branch,
                generated.commit,
                source.url,
                source.branch,
                source.commit
            )),
            None => drift.push(format!("{} missing from generated manifest", source.name)),
        }
    }

    if drift.is_empty() {
        println!("generated asset manifest source pins match assets/sources.toml");
        return Ok(());
    }

    let details = drift.join("; ");
    if strict {
        bail!("generated asset manifest has stale source pins: {details}");
    }
    eprintln!("warning: generated asset manifest has stale source pins: {details}");
    Ok(())
}

fn verify_committed_assets() -> Result<()> {
    check_source_free_repo()?;
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    check_no_legacy_runtime_shims()?;
    check_production_wasix_build_inputs()?;
    check_rust_startup_abi_boundary()?;
    check_or_write_asset_input_fingerprint(false, false)?;
    check_no_committed_portable_asset_blobs()?;
    check_no_committed_aot_artifacts()?;
    check_aot_crate_templates(&manifest)?;
    verify_generated_extension_surface_if_available()?;
    check_source_controlled_wasix_export_list()?;
    println!("source-controlled asset inputs and crate templates passed");
    Ok(())
}

fn check_source_free_repo() -> Result<()> {
    if Path::new(".gitmodules").exists() {
        bail!("tracked upstream source checkouts are not allowed: remove .gitmodules");
    }
    if is_release_staged_workspace() && !Path::new(".git").exists() {
        return Ok(());
    }
    for path in [
        "assets/checkouts",
        "assets/wasix-build/build",
        "assets/wasix-build/work",
        GENERATED_ASSETS_DIR,
        RELEASE_STAGE_DIR,
    ] {
        let tracked = command_output("git", &["ls-files", path], Path::new("."))?;
        if !tracked.trim().is_empty() {
            bail!(
                "{path} contains tracked generated/source checkout files:\n{}",
                tracked.trim()
            );
        }
    }
    Ok(())
}

fn is_release_staged_workspace() -> bool {
    env::var_os("PGLITE_OXIDE_RELEASE_STAGED").as_deref() == Some(std::ffi::OsStr::new("1"))
}

fn check_no_committed_portable_asset_blobs() -> Result<()> {
    let tracked = command_output(
        "git",
        &[
            "ls-files",
            ASSET_CRATE_PAYLOAD_DIR,
            LEGACY_STATIC_WASI_ARCHIVE,
            "assets/bin",
            "assets/prepopulated",
            "assets/extensions/*.tar.gz",
        ],
        Path::new("."),
    )?;
    if !tracked.trim().is_empty() {
        bail!(
            "portable WASIX asset payloads must be generated by CI/release and must not be committed:\n{}",
            tracked.trim()
        );
    }
    println!("committed repo contains no portable WASIX asset blobs");
    Ok(())
}

fn check_or_write_asset_input_fingerprint(write: bool, explain: bool) -> Result<()> {
    let report = asset_input_fingerprint_report()?;
    let path = Path::new(ASSET_INPUT_FINGERPRINT_PATH);
    if write {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, format!("{}\n", report.fingerprint))
            .with_context(|| format!("write {}", path.display()))?;
        println!("wrote {}", path.display());
        if explain {
            print_asset_input_fingerprint_report(&report, Some(path))?;
        }
        return Ok(());
    }

    let expected = fs::read_to_string(path).with_context(|| {
        format!(
            "read {}; run `cargo run -p xtask -- assets input-fingerprint --write` after refreshing assets",
            path.display()
        )
    })?;
    if explain {
        print_asset_input_fingerprint_report(&report, Some(path))?;
        return Ok(());
    }
    ensure_eq(
        report.fingerprint.as_str(),
        expected.trim(),
        "committed asset input fingerprint",
    )?;
    Ok(())
}

#[derive(Debug)]
struct AssetInputFingerprintReport {
    fingerprint: String,
    files: Vec<AssetInputFingerprintFile>,
}

#[derive(Debug)]
struct AssetInputFingerprintFile {
    path: String,
    sha256: String,
    byte_len: usize,
    normalized: bool,
}

fn asset_input_fingerprint_report() -> Result<AssetInputFingerprintReport> {
    let tracked = command_output(
        "git",
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "assets/sources.toml",
            "assets/extensions.promoted.toml",
            "assets/extensions.smoke.toml",
            "assets/wasix-build",
            "crates/assets/Cargo.toml",
            "crates/assets/build.rs",
            "crates/assets/src",
            "crates/aot",
            "tools/xtask/src/main.rs",
            "tools/xtask/src/extension_catalog.rs",
        ],
        Path::new("."),
    )?;
    let mut files = tracked
        .lines()
        .filter(|line| {
            Path::new(line).exists()
                && !line.starts_with("assets/wasix-build/build/")
                && !line.starts_with("assets/wasix-build/experiments/")
                && !line.starts_with("assets/wasix-build/work/")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    if files.is_empty() {
        bail!("no tracked asset input files found");
    }

    let mut hasher = Sha256::new();
    let mut report_files = Vec::with_capacity(files.len());
    for file in files {
        let bytes = asset_input_fingerprint_bytes(&file)?;
        let normalized = is_internal_asset_package_manifest(&file);
        let sha256 = sha256_bytes(&bytes);
        hasher.update(file.as_bytes());
        hasher.update([0]);
        hasher.update(sha256.as_bytes());
        hasher.update([0]);
        report_files.push(AssetInputFingerprintFile {
            path: file,
            sha256,
            byte_len: bytes.len(),
            normalized,
        });
    }
    Ok(AssetInputFingerprintReport {
        fingerprint: format!("{:x}", hasher.finalize()),
        files: report_files,
    })
}

fn print_asset_input_fingerprint_report(
    report: &AssetInputFingerprintReport,
    committed_path: Option<&Path>,
) -> Result<()> {
    println!("asset-input-fingerprint\t{}", report.fingerprint);
    if let Some(path) = committed_path {
        let committed = fs::read_to_string(path)
            .with_context(|| format!("read committed asset fingerprint {}", path.display()))?;
        let committed = committed.trim();
        let status = if committed == report.fingerprint {
            "match"
        } else {
            "mismatch"
        };
        println!("committed-asset-input-fingerprint\t{committed}");
        println!("committed-asset-input-status\t{status}");
    }
    println!("path\tsha256\tbytes\tnormalized");
    for file in &report.files {
        println!(
            "{}\t{}\t{}\t{}",
            file.path, file.sha256, file.byte_len, file.normalized
        );
    }
    Ok(())
}

fn asset_input_fingerprint_bytes(file: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(file).with_context(|| format!("read {file}"))?;
    if !is_internal_asset_package_manifest(file) {
        return Ok(bytes);
    }

    let text = String::from_utf8(bytes).with_context(|| format!("read {file} as UTF-8"))?;
    Ok(normalize_internal_asset_package_manifest(&text).into_bytes())
}

fn is_internal_asset_package_manifest(file: &str) -> bool {
    file == "crates/assets/Cargo.toml"
        || (file.starts_with("crates/aot/") && file.ends_with("/Cargo.toml"))
}

fn normalize_internal_asset_package_manifest(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut in_package = false;

    for chunk in text.split_inclusive('\n') {
        let line = chunk.strip_suffix('\n').unwrap_or(chunk);
        let logical = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = logical.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
        }

        if in_package && is_toml_key(logical, "version") {
            let indent_len = logical.len() - logical.trim_start().len();
            normalized.push_str(&logical[..indent_len]);
            normalized.push_str("version = \"<release-version>\"");
            if line.ends_with('\r') {
                normalized.push('\r');
            }
            if chunk.ends_with('\n') {
                normalized.push('\n');
            }
        } else {
            normalized.push_str(chunk);
        }
    }

    normalized
}

fn is_toml_key(line: &str, key: &str) -> bool {
    line.trim_start()
        .strip_prefix(key)
        .is_some_and(|rest| rest.trim_start().starts_with('='))
}

fn verify_asset_manifest_hashes() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&text).context("parse generated asset manifest")?;
    let base = Path::new(GENERATED_ASSETS_DIR);

    let runtime_archive = base.join(&manifest.runtime.archive);
    verify_file_sha256(
        &runtime_archive,
        &manifest.runtime.sha256,
        "runtime archive",
    )?;
    let runtime_module = archive_entry_bytes(
        &runtime_archive,
        &format!("pglite/{}", manifest.runtime.module_path),
    )?;
    ensure_eq(
        &sha256_bytes(&runtime_module),
        &manifest.runtime.module_sha256,
        "runtime module sha256",
    )?;
    for module in &manifest.runtime_support {
        let bytes = archive_entry_bytes(&runtime_archive, &format!("pglite/{}", module.path))?;
        ensure_eq(
            &sha256_bytes(&bytes),
            &module.sha256,
            &format!("runtime support {} sha256", module.name),
        )?;
        ensure_eq(
            &sha256_bytes(&bytes),
            &module.module_sha256,
            &format!("runtime support {} module sha256", module.name),
        )?;
    }

    if let Some(pg_dump) = &manifest.pg_dump {
        verify_file_sha256(&base.join(&pg_dump.path), &pg_dump.sha256, "pg_dump wasm")?;
        ensure_eq(
            &pg_dump.sha256,
            &pg_dump.module_sha256,
            "pg_dump module sha256",
        )?;
    }
    if let Some(initdb) = &manifest.initdb {
        verify_file_sha256(&base.join(&initdb.path), &initdb.sha256, "initdb wasm")?;
        ensure_eq(
            &initdb.sha256,
            &initdb.module_sha256,
            "initdb module sha256",
        )?;
    }

    for extension in &manifest.extensions {
        let archive = base.join(&extension.archive);
        verify_file_sha256(
            &archive,
            &extension.sha256,
            &format!("extension {} archive", extension.sql_name),
        )?;
        if let Some(native_module) = &extension.native_module {
            let entry = format!("lib/postgresql/{native_module}");
            let bytes = archive_entry_bytes(&archive, &entry)?;
            ensure_eq(
                &sha256_bytes(&bytes),
                &extension.module_sha256,
                &format!("extension {} module sha256", extension.sql_name),
            )?;
        }
    }

    let pgdata_archive = base.join("prepopulated/pgdata-template.tar.zst");
    verify_pgdata_template_hash(&pgdata_archive)?;
    if let Some(template) = &manifest.pgdata_template {
        verify_file_sha256(
            &base.join(&template.archive),
            &template.sha256,
            "PGDATA template",
        )?;
        ensure_file(&base.join(&template.manifest))?;
        ensure_eq(
            &template.runtime_module_sha256,
            &manifest.runtime.module_sha256,
            "PGDATA template runtime module sha256",
        )?;
        if let Some(initdb) = &manifest.initdb {
            ensure_eq(
                &template.initdb_module_sha256,
                &initdb.module_sha256,
                "PGDATA template initdb module sha256",
            )?;
        }
    }

    if is_release_staged_workspace() {
        verify_root_asset_metadata(&manifest, &manifest.runtime.module_sha256)?;
        verify_file_sha256(
            &pgdata_archive,
            &cargo_metadata_value("pgdata-template-archive-sha256")?,
            "PGDATA template archive metadata",
        )?;
    }

    println!("generated asset hashes match manifests");
    Ok(())
}

fn verify_pgdata_template_hash(pgdata_archive: &Path) -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("prepopulated/pgdata-template.json");
    ensure!(
        manifest_path.exists() && pgdata_archive.exists(),
        "generated assets must include the bundled PGDATA template required by the default runtime; expected both {} and {}",
        manifest_path.display(),
        pgdata_archive.display()
    );
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let expected = manifest
        .get("archiveSha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("{} is missing archiveSha256", manifest_path.display()))?;
    verify_file_sha256(pgdata_archive, expected, "PGDATA template archive")?;
    Ok(())
}

fn verify_root_asset_metadata(
    manifest: &AssetManifestOut,
    runtime_module_sha256: &str,
) -> Result<()> {
    verify_metadata_value(
        "postgres-version",
        &manifest.runtime.postgres_version,
        "PostgreSQL version metadata",
    )?;
    let postgres_source = manifest
        .sources
        .iter()
        .find(|source| source.name == POSTGRES_PGLITE_SOURCE)
        .ok_or_else(|| anyhow!("asset manifest is missing source '{POSTGRES_PGLITE_SOURCE}'"))?;
    verify_metadata_value(
        "postgres-pglite-branch",
        &postgres_source.branch,
        "postgres-pglite branch metadata",
    )?;
    verify_metadata_value(
        "runtime-archive-sha256",
        &manifest.runtime.sha256,
        "runtime archive metadata",
    )?;
    verify_metadata_value(
        "pglite-wasix-sha256",
        runtime_module_sha256,
        "runtime module metadata",
    )?;
    if let Some(pg_dump) = &manifest.pg_dump {
        verify_metadata_value("pg-dump-wasix-sha256", &pg_dump.sha256, "pg_dump metadata")?;
    }
    if let Some(initdb) = &manifest.initdb {
        verify_metadata_value("initdb-wasix-sha256", &initdb.sha256, "initdb metadata")?;
    }
    Ok(())
}

fn verify_metadata_value(key: &str, expected: &str, field: &str) -> Result<()> {
    let actual = cargo_metadata_value(key)?;
    ensure_eq(&actual, expected, field)
}

fn cargo_metadata_value(key: &str) -> Result<String> {
    let text = fs::read_to_string("crates/pglite-oxide/Cargo.toml")
        .context("read crates/pglite-oxide/Cargo.toml")?;
    let needle = format!("{key} = \"");
    let start = text
        .find(&needle)
        .ok_or_else(|| anyhow!("crates/pglite-oxide/Cargo.toml metadata key '{key}' is missing"))?
        + needle.len();
    let end = text[start..].find('"').ok_or_else(|| {
        anyhow!("crates/pglite-oxide/Cargo.toml metadata key '{key}' is unterminated")
    })?;
    Ok(text[start..start + end].to_owned())
}

fn verify_file_sha256(path: &Path, expected: &str, field: &str) -> Result<()> {
    ensure_file(path)?;
    let actual = sha256_file(path)?;
    ensure_eq(&actual, expected, field)
}

fn archive_entry_bytes(archive_path: &Path, entry_name: &str) -> Result<Vec<u8>> {
    let file =
        fs::File::open(archive_path).with_context(|| format!("open {}", archive_path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", archive_path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .with_context(|| format!("read {}", archive_path.display()))?
    {
        let mut entry =
            entry.with_context(|| format!("read entry from {}", archive_path.display()))?;
        let path = entry
            .path()
            .with_context(|| format!("read path from {}", archive_path.display()))?
            .to_string_lossy()
            .trim_start_matches("./")
            .to_owned();
        if path == entry_name {
            let mut bytes = Vec::new();
            io::copy(&mut entry, &mut bytes)
                .with_context(|| format!("read {entry_name} from {}", archive_path.display()))?;
            return Ok(bytes);
        }
    }
    bail!(
        "{} is missing archive entry {entry_name}",
        archive_path.display()
    )
}

fn check_no_committed_aot_artifacts() -> Result<()> {
    let tracked = command_output("git", &["ls-files", "crates/aot"], Path::new("."))?;
    let committed_artifacts = tracked
        .lines()
        .filter(|path| path.contains("/artifacts/"))
        .collect::<Vec<_>>();
    if !committed_artifacts.is_empty() {
        bail!(
            "native AOT artifacts must be generated by CI and must not be committed:\n{}",
            committed_artifacts.join("\n")
        );
    }
    println!("committed repo contains no native AOT artifact blobs");
    Ok(())
}

fn check_aot_crate_templates(sources: &SourcesManifest) -> Result<()> {
    let expected = supported_aot_targets();
    for target in expected {
        let crate_dir = Path::new("crates/aot").join(target);
        ensure_file(&crate_dir.join("Cargo.toml"))?;
        ensure_file(&crate_dir.join("README.md"))?;
        ensure_file(&crate_dir.join("build.rs"))?;
        let lib = crate_dir.join("src/lib.rs");
        ensure_file(&lib)?;

        let cargo_toml = fs::read_to_string(crate_dir.join("Cargo.toml"))
            .with_context(|| format!("read {}/Cargo.toml", crate_dir.display()))?;
        if !cargo_toml.contains("\"build.rs\"") || !cargo_toml.contains("\"artifacts/**\"") {
            bail!(
                "{} must include build.rs and generated artifacts/** when CI materializes the AOT crate",
                crate_dir.join("Cargo.toml").display()
            );
        }

        let lib_text =
            fs::read_to_string(&lib).with_context(|| format!("read {}", lib.display()))?;
        for required in [
            "#![deny(unsafe_code)]",
            "include!(concat!(env!(\"OUT_DIR\")",
        ] {
            if !lib_text.contains(required) {
                bail!("{} is not a source-only AOT crate template", lib.display());
            }
        }
        if lib_text.contains("include_bytes!") || lib_text.contains("include_str!(\"../artifacts/")
        {
            bail!(
                "{} embeds generated AOT artifacts; generated artifacts belong only in CI/release workspaces",
                lib.display()
            );
        }
        let build_rs = fs::read_to_string(crate_dir.join("build.rs"))
            .with_context(|| format!("read {}/build.rs", crate_dir.display()))?;
        for required in [
            "PGLITE_OXIDE_GENERATED_AOT_DIR",
            "target/pglite-oxide/aot",
            "wasmer-version",
            sources.toolchain.wasmer.as_str(),
            "wasmer-wasix-version",
            sources.toolchain.wasmer_wasix.as_str(),
        ] {
            if !build_rs.contains(required) {
                bail!(
                    "{} build.rs is missing source-only AOT marker {required}",
                    crate_dir.display()
                );
            }
        }
    }
    println!("AOT crates are source-only templates for CI-generated release artifacts");
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct AotTargetSpec {
    triple: &'static str,
    runner_os: &'static str,
    package: &'static str,
    llvm_url: &'static str,
}

#[derive(Debug, Serialize)]
struct AotCiMatrix {
    include: Vec<AotCiTarget>,
}

#[derive(Debug, Serialize)]
struct AotCiTarget {
    os: &'static str,
    target: &'static str,
    package: &'static str,
    artifact: String,
    llvm_url: &'static str,
}

fn aot_target_specs() -> &'static [AotTargetSpec] {
    &[
        AotTargetSpec {
            triple: "aarch64-apple-darwin",
            runner_os: "macos-15",
            package: "pglite-oxide-aot-aarch64-apple-darwin",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-darwin-aarch64.tar.xz",
        },
        AotTargetSpec {
            triple: "x86_64-unknown-linux-gnu",
            runner_os: "ubuntu-latest",
            package: "pglite-oxide-aot-x86_64-unknown-linux-gnu",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-amd64.tar.xz",
        },
        AotTargetSpec {
            triple: "aarch64-unknown-linux-gnu",
            runner_os: "ubuntu-24.04-arm",
            package: "pglite-oxide-aot-aarch64-unknown-linux-gnu",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-aarch64.tar.xz",
        },
        AotTargetSpec {
            triple: "x86_64-pc-windows-msvc",
            runner_os: "windows-latest",
            package: "pglite-oxide-aot-x86_64-pc-windows-msvc",
            llvm_url: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-windows-amd64.tar.xz",
        },
    ]
}

fn supported_aot_targets() -> Vec<&'static str> {
    aot_target_specs().iter().map(|spec| spec.triple).collect()
}

fn aot_artifact_name(target: &str) -> String {
    format!("pglite-oxide-aot-{target}")
}

fn portable_wasix_artifact_name() -> &'static str {
    "pglite-oxide-portable-wasix"
}

fn print_supported_aot_targets() -> Result<()> {
    for spec in aot_target_specs() {
        println!("{}", spec.triple);
    }
    Ok(())
}

fn print_internal_asset_packages() -> Result<()> {
    println!("pglite-oxide-assets");
    for spec in aot_target_specs() {
        println!("{}", spec.package);
    }
    Ok(())
}

fn print_ci_artifact_names() -> Result<()> {
    println!("{}", portable_wasix_artifact_name());
    for spec in aot_target_specs() {
        println!("{}", aot_artifact_name(spec.triple));
    }
    Ok(())
}

fn print_aot_ci_matrix(args: &[String]) -> Result<()> {
    let requested = value_after(args, "--target")
        .or_else(|| value_after(args, "--target-triple"))
        .unwrap_or("all");
    let github_output = args.iter().any(|arg| arg == "--github-output");
    let targets = aot_target_specs()
        .iter()
        .filter(|spec| requested == "all" || requested == spec.triple)
        .map(|spec| AotCiTarget {
            os: spec.runner_os,
            target: spec.triple,
            package: spec.package,
            artifact: aot_artifact_name(spec.triple),
            llvm_url: spec.llvm_url,
        })
        .collect::<Vec<_>>();
    ensure!(
        !targets.is_empty(),
        "unsupported native AOT target: {requested}"
    );
    let matrix = AotCiMatrix { include: targets };
    let json = serde_json::to_string(&matrix).context("serialize AOT CI matrix")?;
    if github_output {
        println!("matrix={json}");
    } else {
        println!("{}", serde_json::to_string_pretty(&matrix)?);
    }
    Ok(())
}

fn ensure_supported_aot_target(target: &str) -> Result<()> {
    if aot_target_specs().iter().any(|spec| spec.triple == target) {
        return Ok(());
    }
    bail!(
        "unsupported AOT target {target}; supported targets are {}",
        supported_aot_targets().join(", ")
    )
}

fn verify_generated_extension_surface() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AssetManifestOut =
        serde_json::from_str(&manifest_text).context("parse committed asset manifest")?;
    if manifest.runtime.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        println!("skipping promoted extension API parity for PG18 WASIX server-core assets");
        return Ok(());
    }
    let catalog_text = fs::read_to_string("assets/generated/extensions.catalog.json")
        .context("read assets/generated/extensions.catalog.json")?;
    let catalog: serde_json::Value =
        serde_json::from_str(&catalog_text).context("parse generated extension catalog")?;
    let generated = fs::read_to_string("crates/pglite-oxide/src/pglite/generated_extensions.rs")
        .context("read crates/pglite-oxide/src/pglite/generated_extensions.rs")?;

    let mut promoted_constants = BTreeMap::new();
    for entry in catalog
        .get("extensions")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow!("extension catalog is missing extensions array"))?
    {
        let promoted = entry
            .pointer("/promotion/promoted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !promoted {
            continue;
        }
        let sql_name = entry
            .get("sql-name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("promoted extension is missing sql-name"))?;
        let rust_constant = entry
            .get("rust-constant")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("promoted extension {sql_name} is missing rust-constant"))?;
        promoted_constants.insert(sql_name.to_owned(), rust_constant.to_owned());
    }

    let manifest_sql_names = manifest
        .extensions
        .iter()
        .map(|extension| extension.sql_name.clone())
        .collect::<BTreeSet<_>>();
    let catalog_sql_names = promoted_constants.keys().cloned().collect::<BTreeSet<_>>();
    if manifest_sql_names != catalog_sql_names {
        bail!(
            "promoted extension catalog and asset manifest disagree: manifest-only={:?} catalog-only={:?}",
            manifest_sql_names
                .difference(&catalog_sql_names)
                .collect::<Vec<_>>(),
            catalog_sql_names
                .difference(&manifest_sql_names)
                .collect::<Vec<_>>()
        );
    }

    for extension in &manifest.extensions {
        let rust_constant = promoted_constants.get(&extension.sql_name).ok_or_else(|| {
            anyhow!(
                "extension {} missing from promoted catalog",
                extension.sql_name
            )
        })?;
        for (needle, description) in [
            (
                format!("pub const {rust_constant}: Extension ="),
                "public extension constant",
            ),
            (format!("    {rust_constant},"), "extensions::ALL entry"),
            (format!("{:?}", extension.sql_name), "extension SQL name"),
            (format!("{:?}", extension.archive), "extension archive path"),
        ] {
            if !generated.contains(&needle) {
                bail!("generated extension API is stale: missing {description} {needle}");
            }
        }
        for status in [
            &extension.smoke_status.direct,
            &extension.smoke_status.server,
            &extension.smoke_status.restart,
        ] {
            ensure_eq(
                status,
                "passed",
                &format!("extension {} smoke status", extension.sql_name),
            )?;
        }
    }
    println!("generated extension API matches asset manifest and catalog");
    Ok(())
}

fn verify_generated_extension_surface_if_available() -> Result<()> {
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    if !manifest_path.exists() {
        eprintln!(
            "warning: generated asset manifest is unavailable at {}; skipping generated extension manifest parity in source-only verification",
            manifest_path.display()
        );
        return Ok(());
    }
    verify_generated_extension_surface()
}

fn check_no_legacy_runtime_shims() -> Result<()> {
    let banned = [
        (
            "crates/pglite-oxide/src/pglite/base.rs",
            &[
                "normalize_runtime_tree",
                "mirror_configured_share_layout",
                "mirror_configured_lib_layout",
                "normalize_pgdata_config",
                "share/timezonesets/Default",
                "write minimal timezoneset",
                "log_timezone = UTC",
                "timezone = UTC",
            ][..],
        ),
        (
            "crates/pglite-oxide/src/pglite/postgres_mod.rs",
            &[
                "\"pgl_initdb\"",
                "\"pgl_backend\"",
                "PostgresRecoverProtocolError",
            ][..],
        ),
    ];

    let mut failures = Vec::new();
    for (path, patterns) in banned {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        for pattern in patterns {
            if text.contains(pattern) {
                failures.push(format!(
                    "{path} contains legacy runtime shim marker {pattern:?}"
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    println!("legacy runtime shim source guard passed");
    Ok(())
}

fn check_production_wasix_build_inputs() -> Result<()> {
    for required in [
        WASIX_PATCH_PATH,
        WASIX_BRIDGE_PATH,
        "assets/wasix-build/wasix_shim/pglite_wasix_bridge_abi_test.c",
        "assets/wasix-build/wasix_shim/pglite_wasix_initdb_shim_abi_test.c",
        "assets/wasix-build/wasix_shim/pglite_wasix_shim.c",
        "assets/wasix-build/analyze_pgl_stubs.sh",
        "assets/wasix-build/configure_wasix_dl.sh",
        "assets/wasix-build/docker_wasix_env.sh",
        "assets/wasix-build/profile_flags.sh",
        "assets/wasix-build/prepare_patched_source.sh",
        "assets/wasix-build/pg_config_wasix.sh",
        "assets/wasix-build/docker/Dockerfile",
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgxs_extensions.sh",
        "assets/wasix-build/docker_contrib_extensions.sh",
        "assets/wasix-build/docker_pgdump.sh",
        "assets/wasix-build/docker_initdb.sh",
        "assets/wasix-build/wasix_shim/pglite_wasix_initdb_shim.c",
    ] {
        if !Path::new(required).exists() {
            bail!("production WASIX build input is missing: {required}");
        }
    }

    let production_files = [
        "tools/xtask/src/main.rs",
        "assets/wasix-build/analyze_pgl_stubs.sh",
        "assets/wasix-build/configure_wasix_dl.sh",
        "assets/wasix-build/docker_wasix_env.sh",
        "assets/wasix-build/profile_flags.sh",
        "assets/wasix-build/prepare_patched_source.sh",
        "assets/wasix-build/pg_config_wasix.sh",
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgxs_extensions.sh",
        "assets/wasix-build/docker_contrib_extensions.sh",
        "assets/wasix-build/docker_pgdump.sh",
        "assets/wasix-build/docker_initdb.sh",
        "assets/wasix-build/wasix_shim/pglite_wasix_initdb_shim.c",
    ];
    for path in production_files {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        if path == "assets/wasix-build/configure_wasix_dl.sh"
            && text.contains("--disable-spinlocks")
        {
            bail!(
                "{path} disables PostgreSQL spinlocks; WASIX builds must use the toolchain atomics path"
            );
        }
    }
    ensure_file_contains_all(
        "assets/wasix-build/docker_wasix_env.sh",
        &[
            "WASIX_HOME:=/opt/wasixcc-home/.wasixcc",
            "ln -s \"$WASIX_HOME\" \"$HOME/.wasixcc\"",
            "export PATH=\"$WASIX_HOME/bin:$PATH\"",
        ],
    )?;
    for path in [
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgxs_extensions.sh",
        "assets/wasix-build/docker_contrib_extensions.sh",
        "assets/wasix-build/docker_pgdump.sh",
        "assets/wasix-build/analyze_pgl_stubs.sh",
    ] {
        ensure_file_contains_all(path, &["docker_wasix_env.sh"])?;
    }

    ensure_file_contains_all(
        "assets/wasix-build/profile_flags.sh",
        &[
            "release)",
            "-O2 -g0",
            "release-o3)",
            "-O3 -g0 -flto=thin",
            "-flto=thin",
            "release-os)",
            "-Os -g0",
            "release-oz)",
            "-Oz -g0",
            "--converge:--strip-debug:--strip-producers",
            "WASIXCC_RUN_WASM_OPT",
            "WASIXCC_WASM_OPT_FLAGS",
            "PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT",
            "PGLITE_OXIDE_WASIX_BACKEND_TIMING",
            "production WASIX artifacts require WebAssembly exceptions",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/configure_wasix_dl.sh",
        &[
            "profile_flags.sh",
            "PGLITE_OXIDE_PROFILE_CFLAGS",
            "-sWASM_EXCEPTIONS=yes",
            "-sPIC=yes",
            "-Dlongjmp=pgl_longjmp",
            "-Dsiglongjmp=pgl_siglongjmp",
            "-DPGLITE_WASIX_BACKEND_TIMING",
            "-sMODULE_KIND=dynamic-main",
            "-Wl,-shared",
            "LDFLAGS_EX=\"$MAIN_LDFLAGS$LDFLAGS_EXTRA\"",
            "LDFLAGS_SL=\"$SIDE_MODULE_LDFLAGS\"",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_BRIDGE_PATH,
        &[
            "pgl_backend_timing_reset",
            "pgl_backend_timing_start",
            "pgl_backend_timing_end",
            "pgl_backend_timing_elapsed_us",
            "CLOCK_MONOTONIC",
            "#ifdef PGLITE_WASIX_BACKEND_TIMING",
            "pgl_set_force_host_error_recovery",
            "force_host_error_recovery",
            "Hosts without that support",
            "pgl_setPGliteActive",
            "pgl_longjmp",
            "pgl_siglongjmp",
            "memcmp(env, (void *) postgresmain_sigjmp_buf, sizeof(jmp_buf)) == 0",
            "pgl_run_atexit_funcs",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_PATCH_PATH,
        &[
            "#if defined(PGLITE_WASIX_DL) && defined(PGLITE_WASIX_BACKEND_TIMING)",
            "PGL_BACKEND_TIMING_CREATE_SHARED_MEMORY",
            "PGL_BACKEND_TIMING_RELATION_CACHE_PHASE3",
            "PGL_BACKEND_TIMING_INITIALIZE_ACL",
            "PGL_BACKEND_TIMING_EXEC_SIMPLE_QUERY",
            "PGL_BACKEND_TIMING_EXEC_PORTAL_RUN",
            "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
            "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/docker_pglite.sh",
        &[
            "PGLITE_OXIDE_BUILD_PROFILE",
            "PGLITE_OXIDE_WASIX_BACKEND_TIMING",
            ".pglite-oxide-build-profile",
            "pglite_oxide_wasix_profile_signature",
        ],
    )?;
    ensure_file_not_contains_any(
        "assets/wasix-build/configure_wasix_dl.sh",
        &["ASYNCIFY", "-sASYNCIFY"],
    )?;

    println!("production WASIX build input guard passed");
    Ok(())
}

fn check_rust_startup_abi_boundary() -> Result<()> {
    let path = Path::new("crates/pglite-oxide/src/pglite/postgres_mod.rs");
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

    for marker in [
        "struct PgliteLifecycleExports",
        "struct WasixProtocolExports",
        "fn ensure_integrated_pglite_contract",
        "fn record_backend_c_timings",
        "pgl_backend_timing_reset",
        "pgl_backend_timing_elapsed_us",
        "host_requires_process_exit_error_recovery",
        "pgl_set_force_host_error_recovery",
        "The upstream lifecycle is already running by this point",
    ] {
        if !text.contains(marker) {
            bail!(
                "{} must keep upstream lifecycle exports separate from WASIX protocol ABI; missing {marker:?}",
                path.display()
            );
        }
    }
    if text.contains("struct Exports") {
        bail!(
            "{} must not collapse PGlite lifecycle and WASIX protocol exports into a generic Exports struct",
            path.display()
        );
    }

    let lifecycle_start = text
        .find("struct PgliteLifecycleExports")
        .ok_or_else(|| anyhow!("missing PgliteLifecycleExports"))?;
    let protocol_start = text
        .find("struct WasixProtocolExports")
        .ok_or_else(|| anyhow!("missing WasixProtocolExports"))?;
    let lifecycle_block = &text[lifecycle_start..protocol_start];
    for protocol_marker in [
        "ProcessStartupPacket",
        "PostgresMainLoopOnce",
        "pgl_wasix_input",
    ] {
        if lifecycle_block.contains(protocol_marker) {
            bail!(
                "{} lifecycle export block leaked WASIX protocol marker {protocol_marker:?}",
                path.display()
            );
        }
    }
    for lifecycle_marker in [
        "wasi_start",
        "set_force_host_error_recovery",
        "set_active",
        "start_pglite",
    ] {
        if !lifecycle_block.contains(lifecycle_marker) {
            bail!(
                "{} must drive the integrated PGlite lifecycle; missing {lifecycle_marker:?}",
                path.display()
            );
        }
    }

    println!("Rust startup ABI boundary guard passed");
    Ok(())
}

fn check_canonical_asset_layout(strict: bool) -> Result<()> {
    let runtime_archive = Path::new(GENERATED_ASSETS_DIR).join("pglite.wasix.tar.zst");
    if !runtime_archive.exists() {
        if strict {
            bail!(
                "runtime asset archive is missing at {}",
                runtime_archive.display()
            );
        }
        eprintln!(
            "warning: runtime asset archive is missing at {}",
            runtime_archive.display()
        );
        return Ok(());
    }

    let runtime_kind = read_asset_manifest()
        .map(|manifest| manifest.runtime.runtime_kind)
        .unwrap_or_else(|_| RUNTIME_KIND_WASIX_DIRECT.to_owned());
    let runtime_binary = if runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        "pglite/bin/postgres"
    } else {
        "pglite/bin/pglite"
    };
    let runtime_entries = archive_entries(&runtime_archive)?;
    for required in [
        runtime_binary,
        "pglite/bin/postgres",
        "pglite/bin/pg_dump",
        "pglite/bin/initdb",
        "pglite/lib/postgresql/plpgsql.so",
        "pglite/share/postgresql/extension/plpgsql.control",
        "pglite/share/postgresql/timezone/UTC",
        "pglite/share/postgresql/timezone/America/New_York",
        "pglite/share/postgresql/timezonesets/Default",
    ] {
        if !runtime_entries.contains(required) {
            bail!(
                "runtime archive {} is missing canonical path {required}",
                runtime_archive.display()
            );
        }
    }
    for forbidden in [
        "pglite/share/extension",
        "pglite/share/timezonesets",
        "pglite/lib/plpgsql.so",
        "pglite/lib/dict_snowball.so",
    ] {
        if runtime_entries.contains(forbidden)
            || runtime_entries
                .iter()
                .any(|entry| entry.starts_with(&format!("{forbidden}/")))
        {
            bail!(
                "runtime archive {} contains non-canonical duplicate path {forbidden}",
                runtime_archive.display()
            );
        }
    }

    let extensions_dir = Path::new(GENERATED_ASSETS_DIR).join("extensions");
    if extensions_dir.exists() {
        for entry in fs::read_dir(&extensions_dir)
            .with_context(|| format!("read {}", extensions_dir.display()))?
        {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("zst") {
                continue;
            }
            check_extension_archive_layout(&path)?;
        }
    } else if strict && runtime_kind != RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        bail!(
            "extension asset directory is missing at {}",
            extensions_dir.display()
        );
    }

    println!("canonical asset layout guard passed");
    Ok(())
}

fn check_extension_archive_layout(path: &Path) -> Result<()> {
    let entries = archive_entries(path)?;
    for entry in entries {
        if matches!(
            entry.as_str(),
            "lib"
                | "lib/postgresql"
                | "share"
                | "share/postgresql"
                | "share/postgresql/extension"
                | "share/postgresql/tsearch_data"
        ) {
            continue;
        }
        if entry.starts_with("lib/postgresql/")
            || entry.starts_with("share/postgresql/extension/")
            || entry.starts_with("share/postgresql/tsearch_data/")
        {
            continue;
        }
        bail!(
            "extension archive {} contains non-canonical path {entry}",
            path.display()
        );
    }
    Ok(())
}

fn archive_entries(path: &Path) -> Result<HashSet<String>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decode {}", path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = HashSet::new();
    for entry in archive
        .entries()
        .with_context(|| format!("read entries from {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("read entry from {}", path.display()))?;
        let entry_path = entry
            .path()
            .with_context(|| format!("read entry path from {}", path.display()))?;
        let entry = entry_path
            .to_str()
            .ok_or_else(|| anyhow!("archive {} has non-UTF-8 path", path.display()))?
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if !entry.is_empty() {
            entries.insert(entry);
        }
    }
    Ok(entries)
}

fn audit_upstream_fixes(manifest: &SourcesManifest, strict: bool) -> Result<()> {
    let checkout = Path::new(POSTGRES_PGLITE_PATH);
    if !checkout.exists() {
        bail!("missing local checkout {}", checkout.display());
    }
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    println!(
        "auditing upstream fixes against {} {}",
        postgres.branch, postgres.commit
    );

    let mut pending_required = Vec::new();
    for item in UPSTREAM_AUDIT {
        let status = if is_git_ancestor(checkout, item.commit)? {
            "included".to_owned()
        } else if let Some(replacement) = replacement_for_upstream_item(item.id)? {
            format!("replaced ({replacement})")
        } else if item.required {
            pending_required.push(item.id);
            "pending".to_owned()
        } else {
            "optional".to_owned()
        };
        println!(
            "{status:32} {} {} - {}",
            item.id, item.commit, item.description
        );
    }

    if strict && !pending_required.is_empty() {
        bail!(
            "required upstream fixes are not included in the active source branch: {}",
            pending_required.join(", ")
        );
    }
    Ok(())
}

fn replacement_for_upstream_item(id: &str) -> Result<Option<&'static str>> {
    match id {
        "stable-protocol-exports" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "src/backend/tcop/postgres.c",
                    "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
                    "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
                    "__attribute__((export_name(\"ProcessStartupPacket\"))) int",
                ],
            )?;
            let patch_text = fs::read_to_string(WASIX_PATCH_PATH)
                .with_context(|| format!("read {WASIX_PATCH_PATH}"))?;
            if patch_adds_marker(&patch_text, "ProcessStartupPacket: STUB") {
                bail!("WASIX patch must not add a stub ProcessStartupPacket");
            }
            ensure_file_contains_all(
                "crates/pglite-oxide/src/pglite/postgres_mod.rs",
                &["PgliteLifecycleExports", "WasixProtocolExports"],
            )?;
            ensure_file_not_contains_any(
                "crates/pglite-oxide/src/pglite/postgres_mod.rs",
                &[
                    "apply_direct_startup_gucs",
                    "pgl_apply_default_gucs",
                    "PostgresRecoverProtocolError",
                ],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/tests/client_compat.rs",
                &[
                    "sqlx_extended_query_errors_recover_after_sync",
                    "raw_wire_protocol_bind_errors_are_synchronized",
                    "postgres_control_packets_are_handled_safely",
                ],
            )?;
            Ok(Some("WASIX protocol ABI + client/raw-wire tests"))
        }
        "stable-checkpointer-disable" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "RequestCheckpoint(CHECKPOINT_CAUSE_XLOG)",
                    "#ifndef __PGLITE__",
                    "#endif",
                ],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/tests/runtime_smoke.rs",
                &["persistent_fresh_initdb_survives_restart_and_stale_state_files"],
            )?;
            Ok(Some("ported into wasix-dl patch"))
        }
        "stable-external-checkpointer" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &[
                    "src/backend/postmaster/checkpointer.c",
                    "RequestCheckpoint(int flags)",
                    "#ifndef __PGLITE__",
                    "if (!IsPostmasterEnvironment)",
                ],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/tests/performance_smoke.rs",
                &["cached_extension_template_opens_without_startup_xlog_recovery"],
            )?;
            Ok(Some(
                "ported in-process checkpoint behavior into wasix-dl patch",
            ))
        }
        "stable-imported-memory" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &[
                    "-sMODULE_KIND=dynamic-main",
                    "-sWASM_EXCEPTIONS=yes",
                    "-Wl,-shared",
                ],
            )?;
            ensure_file_contains_all(
                Path::new(GENERATED_ASSETS_DIR).join("manifest.json"),
                &["wasix-dynamic-main"],
            )?;
            Ok(Some("WASIX dynamic-main/side-module memory contract"))
        }
        "stable-memory-stack" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &["-sSTACK_SIZE=8MB", "-sINITIAL_MEMORY=128MB"],
            )?;
            Ok(Some(
                "WASIX build profile pins stack and initial memory sizing",
            ))
        }
        "stable-postgres-user" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &["static char name[] = \"postgres\"", "\"/home/postgres\""],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/src/pglite/postgres_mod.rs",
                &[
                    "(\"PGUSER\", \"postgres\")",
                    "(\"PGDATABASE\", \"template1\")",
                ],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/tests/runtime_smoke.rs",
                &["current_user", "session_user", "Some(&json!(\"postgres\"))"],
            )?;
            Ok(Some("WASIX identity bridge + runtime smoke tests"))
        }
        "stable-initdb-single-no-exit" => {
            ensure_file_contains_all(
                "assets/wasix-build/configure_wasix_dl.sh",
                &[
                    "-Dexit=pgl_exit",
                    "-Dlongjmp=pgl_longjmp",
                    "-Dsiglongjmp=pgl_siglongjmp",
                ],
            )?;
            ensure_file_contains_all(
                "crates/pglite-oxide/tests/runtime_smoke.rs",
                &[
                    "persistent_fresh_initdb_survives_restart_and_stale_state_files",
                    "persistent_fresh_initdb_recovers_interrupted_pgdata_without_marker",
                    "persistent_fresh_initdb_recovers_interrupted_pgdata_with_incomplete_markers",
                ],
            )?;
            Ok(Some(
                "WASIX bridge follows upstream PGlite single-user process-exit/longjmp lifecycle",
            ))
        }
        "stable-atexit-single-cleanup" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &["pgl_atexit", "pgl_run_atexit_funcs", "pgl_exit(int status)"],
            )?;
            Ok(Some(
                "WASIX bridge stores atexit handlers and lets Rust close run them explicitly",
            ))
        }
        "stable-postmaster-environment" => {
            ensure_file_contains_all(
                WASIX_PATCH_PATH,
                &["IsPostmasterEnvironment = true", "pgl_startPGlite"],
            )?;
            Ok(Some(
                "uses upstream PGlite pgl_startPGlite postmaster-environment setup",
            ))
        }
        "stable-timer-cleanup" => {
            ensure_file_contains_all(
                WASIX_BRIDGE_PATH,
                &[
                    "pgl_clear_interval_timer",
                    "setitimer(ITIMER_REAL",
                    "pgl_exit(int status)",
                ],
            )?;
            Ok(Some("WASIX process-exit bridge clears interval timers"))
        }
        _ => Ok(None),
    }
}

fn ensure_file_contains_all(path: impl AsRef<Path>, markers: &[&str]) -> Result<()> {
    let path = path.as_ref();
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let missing = markers
        .iter()
        .copied()
        .filter(|marker| !text.contains(marker))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        bail!(
            "{} is missing required upstream replacement markers: {}",
            path.display(),
            missing.join(", ")
        );
    }
    Ok(())
}

fn ensure_file_not_contains_any(path: &str, markers: &[&str]) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let present = markers
        .iter()
        .copied()
        .filter(|marker| text.contains(marker))
        .collect::<Vec<_>>();
    if !present.is_empty() {
        bail!(
            "{path} contains production-excluded markers: {}",
            present.join(", ")
        );
    }
    Ok(())
}

fn is_git_ancestor(checkout: &Path, commit: &str) -> Result<bool> {
    let status = Command::new("git")
        .args(["merge-base", "--is-ancestor", commit, "HEAD"])
        .current_dir(checkout)
        .status()
        .with_context(|| format!("check whether {commit} is in {}", checkout.display()))?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => bail!("git merge-base failed for {commit} with {status}"),
    }
}

fn check_all_manifest_source_checkouts(
    manifest: &SourcesManifest,
    strict_local: bool,
) -> Result<()> {
    for source in &manifest.sources {
        let Some(path) = source_checkout_path(source.name.as_str()) else {
            if strict_local {
                bail!("source '{}' has no configured checkout path", source.name);
            }
            eprintln!(
                "warning: source '{}' has no configured checkout path",
                source.name
            );
            continue;
        };
        if !path.join(".git").exists() {
            if strict_local {
                bail!("missing local checkout {}", path.display());
            }
            eprintln!("warning: local checkout {} is missing", path.display());
            continue;
        }
        let head = command_output("git", &["rev-parse", "HEAD"], path)
            .with_context(|| format!("read HEAD for {}", path.display()))?;
        if head.trim() != source.commit {
            if strict_local {
                bail!(
                    "local {} checkout is at {}, expected {} from assets/sources.toml",
                    path.display(),
                    head.trim(),
                    source.commit
                );
            }
            eprintln!(
                "warning: local {} checkout is at {}, expected {}",
                path.display(),
                head.trim(),
                source.commit
            );
        }
        let branch = command_output("git", &["branch", "--show-current"], path)
            .unwrap_or_else(|_| String::from("<detached>"));
        if strict_local && branch.trim() != source.branch {
            bail!(
                "local {} checkout is on branch '{}', expected '{}'",
                path.display(),
                branch.trim(),
                source.branch
            );
        }
        let status = source_checkout_status_for_source(source.name.as_str(), path)
            .with_context(|| format!("read status for {}", path.display()))?;
        if !status.trim().is_empty() {
            if strict_local {
                bail!(
                    "local {} checkout ({}) has uncommitted changes; preserve them before strict asset builds",
                    path.display(),
                    source.name
                );
            }
            eprintln!(
                "warning: local {} checkout ({}) has uncommitted changes",
                path.display(),
                source.name
            );
        }
    }
    Ok(())
}

fn check_source_spine(
    manifest: &SourcesManifest,
    strict_local: bool,
    check_patch_applies: bool,
) -> Result<()> {
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    check_source_free_repo()?;
    check_all_manifest_source_checkouts(manifest, strict_local)?;
    if postgres.url.contains("github.com/postgres/postgres")
        && postgres.branch.starts_with("REL_18")
    {
        return check_wasix_postgres_server_source_spine(postgres, strict_local);
    }

    let pglite_build = source_by_name(manifest, PGLITE_BUILD_SOURCE)?;

    let patch = Path::new(WASIX_PATCH_PATH);
    if !patch.exists() {
        bail!("missing WASIX source patch at {}", patch.display());
    }
    let patch_text =
        fs::read_to_string(patch).with_context(|| format!("read {}", patch.display()))?;
    let required_patch_markers = [
        "src/template/wasix-dl",
        "src/makefiles/Makefile.wasix-dl",
        "src/include/port/wasix-dl.h",
        "src/include/port/wasix-dl/sys/ipc.h",
        "src/include/port/wasix-dl/sys/shm.h",
        "src/backend/tcop/postgres.c",
        "src/backend/tcop/backend_startup.c",
        "__attribute__((export_name(\"ProcessStartupPacket\"))) int",
        "PGLITE_HOST_EXPORT(\"pgl_startPGlite\")",
        "PGLITE_HOST_EXPORT(\"PostgresMainLongJmp\")",
        "PGL_BACKEND_TIMING_INIT_POSTGRES",
        "PGL_BACKEND_TIMING_SHARED_MEMORY",
        "PGL_BACKEND_TIMING_EXEC_SIMPLE_QUERY",
        "wasm_dl_extension_imports_dir",
        "PGLITE_WASIX_DL",
    ];
    let missing_patch_markers = required_patch_markers
        .iter()
        .copied()
        .filter(|marker| !patch_text.contains(marker))
        .collect::<Vec<_>>();
    if !missing_patch_markers.is_empty() {
        bail!(
            "WASIX patch {} is missing expected source-spine entries: {}",
            patch.display(),
            missing_patch_markers.join(", ")
        );
    }
    let banned_added_patch_markers = [
        "#pragma warning \"-------------------- TEST",
        "return stderr;",
        "popen[%s]",
        "pg_pclose(%s)",
        "ProcessStartupPacket: STUB",
        "select_default_timezone(%s): STUB",
        "emscripten_extension_imports_dir :=",
        "pglite-wasm/",
    ];
    let mut banned_patch_additions = Vec::new();
    for marker in banned_added_patch_markers {
        if patch_adds_marker(&patch_text, marker) {
            banned_patch_additions.push(marker);
        }
    }
    if !banned_patch_additions.is_empty() {
        bail!(
            "WASIX patch {} reintroduces spike debug/shim additions: {}",
            patch.display(),
            banned_patch_additions.join(", ")
        );
    }
    let bridge = Path::new(WASIX_BRIDGE_PATH);
    if !bridge.exists() {
        bail!("missing WASIX PGlite bridge at {}", bridge.display());
    }
    let bridge_text =
        fs::read_to_string(bridge).with_context(|| format!("read {}", bridge.display()))?;
    if !bridge_text.contains("pgl_wasix_input_write")
        || !bridge_text.contains("pgl_recv")
        || !bridge_text.contains("pgl_shmget")
        || !bridge_text.contains("strcmp(command, \"locale -a\") != 0")
        || !bridge_text.contains("strcmp(mode, \"r\") != 0")
        || !bridge_text.contains("static char name[] = \"postgres\"")
        || !bridge_text.contains("PGLITE_PROTOCOL_FD")
        || !bridge_text.contains("pgl_write_int_sockopt")
        || !bridge_text.contains("errno = ENOPROTOOPT")
        || !bridge_text.contains("return recv(fd, buf, n, flags)")
        || !bridge_text.contains("return send(fd, buf, n, flags)")
        || !bridge_text.contains("return connect(socket, address, address_len)")
        || !bridge_text.contains("return munmap(addr, length)")
        || !bridge_text.contains("return poll(fds, nfds, timeout)")
    {
        bail!(
            "WASIX bridge {} does not contain expected protocol/socket/shared-memory/locale identity allowlisted ABI",
            bridge.display()
        );
    }
    for banned in [
        "(void) level;\n\t(void) optname;\n\t(void) optval;\n\t(void) optlen;\n\treturn 0;",
        "(void) addr;\n\t(void) len;\n\treturn 0;",
        "(void) fd;\n\t(void) flags;\n\treturn pgl_wasix_buffer_read",
        "(void) fd;\n\t(void) flags;\n\treturn pgl_wasix_buffer_write",
        "(void) addr;\n\t(void) length;\n\treturn 0;",
        "fds[i].revents = fds[i].events;",
    ] {
        if bridge_text.contains(banned) {
            bail!(
                "WASIX bridge {} reintroduced broad fake-success socket/fd behavior: {}",
                bridge.display(),
                banned.escape_debug()
            );
        }
    }
    if bridge_text.contains("return 123;") {
        bail!(
            "WASIX bridge {} reintroduced a magic successful-looking system() status",
            bridge.display()
        );
    }
    if !bridge_text.contains("pgl_system(const char *command)")
        || !bridge_text.contains("errno = ENOSYS;")
        || !bridge_text.contains("return -1;")
    {
        bail!(
            "WASIX bridge {} must fail unsupported system() calls closed with ENOSYS",
            bridge.display()
        );
    }
    let stub_analysis = Path::new("assets/wasix-build/analyze_pgl_stubs.sh");
    if !stub_analysis.exists() {
        bail!(
            "missing pgl_stubs link-symbol analysis script at {}",
            stub_analysis.display()
        );
    }
    let stub_analysis_text = fs::read_to_string(stub_analysis)
        .with_context(|| format!("read {}", stub_analysis.display()))?;
    for marker in [
        "Runtime link inputs requiring WASIX host ABI ownership",
        "Frontend tool inputs requiring frontend/common ownership",
        "do not by themselves justify adding symbols to the production WASIX bridge",
    ] {
        if !stub_analysis_text.contains(marker) {
            bail!(
                "{} must keep runtime pgl_stubs ownership separate from frontend tool symbols",
                stub_analysis.display()
            );
        }
    }
    check_wasix_bridge_abi_harness()?;
    check_wasix_initdb_shim_abi_harness()?;
    for script in [
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_pgxs_extensions.sh",
        "assets/wasix-build/docker_contrib_extensions.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ] {
        let text = fs::read_to_string(script).with_context(|| format!("read {script}"))?;
        if !text.contains(".pglite-oxide-bridge-sha256") {
            bail!("{script} must validate the WASIX bridge hash before reusing build outputs");
        }
    }
    let docker_pglite = fs::read_to_string("assets/wasix-build/docker_pglite.sh")
        .context("read assets/wasix-build/docker_pglite.sh")?;
    if !docker_pglite.contains("/usr/sbin/zic")
        || !docker_pglite.contains("src/timezone/compiled/UTC")
    {
        bail!(
            "docker_pglite.sh must compile pinned PostgreSQL timezone data inside the pinned Docker build"
        );
    }
    let docker_pgxs = fs::read_to_string("assets/wasix-build/docker_pgxs_extensions.sh")
        .context("read assets/wasix-build/docker_pgxs_extensions.sh")?;
    if !docker_pgxs.contains(extension_catalog::build_plan_pgxs_path())
        || !docker_pgxs.contains("PG_CONFIG=/work/assets/wasix-build/pg_config_wasix.sh")
        || !docker_pgxs.contains("make -s -j\"$JOBS\"")
    {
        bail!("docker_pgxs_extensions.sh must build PGXS extensions from the generated plan");
    }
    let docker_contrib = fs::read_to_string("assets/wasix-build/docker_contrib_extensions.sh")
        .context("read assets/wasix-build/docker_contrib_extensions.sh")?;
    if !docker_contrib.contains(extension_catalog::build_plan_contrib_path())
        || !docker_contrib.contains("make -s -j\"$JOBS\" -C \"$BUILD_DIR/contrib/$contrib_dir\"")
    {
        bail!("docker_contrib_extensions.sh must build contrib extensions from the generated plan");
    }

    let checkout = Path::new(POSTGRES_PGLITE_PATH);
    if !checkout.exists() {
        if strict_local {
            bail!("missing local checkout {}", checkout.display());
        }
        eprintln!("warning: local checkout {} is missing", checkout.display());
        return Ok(());
    }

    let head = command_output("git", &["rev-parse", "HEAD"], checkout)
        .with_context(|| format!("read HEAD for {}", checkout.display()))?;
    let branch = command_output("git", &["branch", "--show-current"], checkout)
        .unwrap_or_else(|_| String::from("<detached>"));
    if strict_local && head.trim() != postgres.commit {
        bail!(
            "local {} checkout is at {}, expected {} from assets/sources.toml",
            checkout.display(),
            head.trim(),
            postgres.commit
        );
    }
    if strict_local && branch.trim() != postgres.branch {
        bail!(
            "local {} checkout is on branch '{}', expected '{}'",
            checkout.display(),
            branch.trim(),
            postgres.branch
        );
    }
    if !strict_local && head.trim() != postgres.commit {
        eprintln!(
            "warning: local {} checkout is at {}, expected {}",
            checkout.display(),
            head.trim(),
            postgres.commit
        );
    }

    let status = source_checkout_status_for_source(postgres.name.as_str(), checkout)
        .with_context(|| format!("read status for {}", checkout.display()))?;
    if strict_local && !status.trim().is_empty() {
        bail!(
            "local {} checkout has uncommitted changes; preserve them as a patch before strict asset builds",
            checkout.display()
        );
    }
    if !strict_local && !status.trim().is_empty() {
        eprintln!(
            "warning: local {} checkout has uncommitted changes",
            checkout.display()
        );
    }

    let pglite_build_checkout = Path::new(PGLITE_BUILD_PATH);
    if !pglite_build_checkout.exists() {
        if strict_local {
            bail!("missing local checkout {}", pglite_build_checkout.display());
        }
        eprintln!(
            "warning: local checkout {} is missing",
            pglite_build_checkout.display()
        );
    } else {
        let build_head = command_output("git", &["rev-parse", "HEAD"], pglite_build_checkout)
            .with_context(|| format!("read HEAD for {}", pglite_build_checkout.display()))?;
        let build_branch =
            command_output("git", &["branch", "--show-current"], pglite_build_checkout)
                .unwrap_or_else(|_| String::from("<detached>"));
        if strict_local && build_head.trim() != pglite_build.commit {
            bail!(
                "local {} checkout is at {}, expected {} from assets/sources.toml",
                pglite_build_checkout.display(),
                build_head.trim(),
                pglite_build.commit
            );
        }
        if !strict_local && build_head.trim() != pglite_build.commit {
            eprintln!(
                "warning: local {} checkout is at {}, expected {}",
                pglite_build_checkout.display(),
                build_head.trim(),
                pglite_build.commit
            );
        }
        if strict_local && build_branch.trim() != pglite_build.branch {
            bail!(
                "local {} checkout is on branch '{}', expected '{}'",
                pglite_build_checkout.display(),
                build_branch.trim(),
                pglite_build.branch
            );
        }
        let build_status =
            source_checkout_status_for_source(pglite_build.name.as_str(), pglite_build_checkout)
                .with_context(|| format!("read status for {}", pglite_build_checkout.display()))?;
        if strict_local && !build_status.trim().is_empty() {
            bail!(
                "local {} checkout has uncommitted changes; preserve them before strict asset builds",
                pglite_build_checkout.display()
            );
        }
        if !strict_local && !build_status.trim().is_empty() {
            eprintln!(
                "warning: local {} checkout has uncommitted changes",
                pglite_build_checkout.display()
            );
        }

        ensure_file(&pglite_build_checkout.join("wasm-build/build-ext.sh"))?;
    }

    let required_upstream_markers = [
        ("build-pglite.sh", "-Dlongjmp=pgl_longjmp"),
        ("build-pglite.sh", "-Dsiglongjmp=pgl_siglongjmp"),
        ("build-pglite.sh", "-sSTACK_SIZE=8MB"),
        ("build-pglite.sh", "-sINITIAL_MEMORY=128MB"),
        ("pglite/src/pglitec/pglitec.c", "pgl_setPGliteActive"),
        ("pglite/src/pglitec/pglitec.c", "pgl_longjmp"),
        ("pglite/src/pglitec/pglitec.c", "pgl_run_atexit_funcs"),
        (
            "pglite/static/included.pglite.exports",
            "PostgresMainLongJmp",
        ),
        ("src/backend/tcop/postgres.c", "pgl_startPGlite"),
        ("src/backend/tcop/postgres.c", "PostgresMainLoopOnce"),
        ("src/backend/tcop/postgres.c", "PostgresMainLongJmp"),
        ("src/backend/tcop/backend_startup.c", "ProcessStartupPacket"),
    ];
    let mut missing_upstream_markers = Vec::new();
    for (relative, marker) in required_upstream_markers {
        let path = checkout.join(relative);
        let text = fs::read_to_string(&path).unwrap_or_default();
        if !text.contains(marker) {
            missing_upstream_markers.push(format!("{relative}:{marker}"));
        }
    }
    if !missing_upstream_markers.is_empty() {
        bail!(
            "local {} checkout is missing expected PGlite builder protocol/lifecycle markers: {}",
            checkout.display(),
            missing_upstream_markers.join(", ")
        );
    }

    if check_patch_applies {
        let patch_path =
            fs::canonicalize(patch).with_context(|| format!("canonicalize {}", patch.display()))?;
        let status = Command::new("git")
            .args(["apply", "--check", "--whitespace=nowarn"])
            .arg(&patch_path)
            .current_dir(checkout)
            .status()
            .with_context(|| format!("check whether {} applies", patch.display()))?;
        if !status.success() {
            bail!(
                "WASIX patch {} does not apply cleanly to {}; rebase it before Phase 1 is complete",
                patch.display(),
                checkout.display()
            );
        }
    }

    Ok(())
}

fn check_wasix_postgres_server_source_spine(
    postgres: &SourcePin,
    strict_local: bool,
) -> Result<()> {
    let checkout = Path::new(POSTGRES_PGLITE_PATH);
    if !checkout.exists() {
        if strict_local {
            bail!("missing local checkout {}", checkout.display());
        }
        eprintln!("warning: local checkout {} is missing", checkout.display());
        return Ok(());
    }

    let head = command_output("git", &["rev-parse", "HEAD"], checkout)
        .with_context(|| format!("read HEAD for {}", checkout.display()))?;
    if strict_local && head.trim() != postgres.commit {
        bail!(
            "local {} checkout is at {}, expected {} from assets/sources.toml",
            checkout.display(),
            head.trim(),
            postgres.commit
        );
    }

    for required in [
        "assets/wasix-build/experiments/fresh-wasix-postgres/overlays/wasix-core/src/template/wasix-core",
        "assets/wasix-build/experiments/fresh-wasix-postgres/overlays/wasix-core/src/makefiles/Makefile.wasix-core",
        "assets/wasix-build/experiments/fresh-wasix-postgres/overlays/wasix-core/src/include/port/wasix-core.h",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0001-wasix-use-posix-dsm-not-sysv.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0003-wasix-libpq-static-encoding-shim.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0004-wasix-core-execbackend-initdb-runtime.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0005-pg-dump-avoid-lto-executequery-collision.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0006-like-literal-substring-fast-path.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0007-top-xid-current-transaction-fast-path.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0008-btree-int4-compare-fast-path.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0009-btree-delete-stack-state.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0010-btree-bottomup-delete-runtime-toggle.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0011-btree-first-int4-compare-fast-path.patch",
        "assets/wasix-build/experiments/fresh-wasix-postgres/patches/0012-hash-bytes-unaligned-load-fast-path.patch",
    ] {
        ensure_file(Path::new(required))?;
    }

    ensure_file_contains_all(
        "assets/wasix-build/docker_pglite.sh",
        &[
            "--with-template=wasix-core",
            "src/backend/postgres",
            ".pglite-oxide-runtime-kind",
            RUNTIME_KIND_WASIX_POSTGRES_SERVER,
            "/usr/sbin/zic",
            "src/timezone/compiled/UTC",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/prepare_patched_source.sh",
        &[
            "experiments/fresh-wasix-postgres",
            "overlays/wasix-core",
            ".pglite-oxide-patch-sha256",
        ],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/docker_pgxs_extensions.sh",
        &["skipping PGXS extension build for PG18 WASIX server-core lane"],
    )?;
    ensure_file_contains_all(
        "assets/wasix-build/docker_contrib_extensions.sh",
        &["skipping contrib extension build for PG18 WASIX server-core lane"],
    )?;

    let patched = Path::new(WASIX_PATCHED_SOURCE_DIR);
    if patched.exists() {
        ensure_file(&patched.join(".pglite-oxide-source-head"))?;
        ensure_file(&patched.join(".pglite-oxide-patch-sha256"))?;
        let patched_head = fs::read_to_string(patched.join(".pglite-oxide-source-head"))
            .with_context(|| {
                format!(
                    "read {}",
                    patched.join(".pglite-oxide-source-head").display()
                )
            })?;
        if strict_local && patched_head.trim() != postgres.commit {
            bail!(
                "patched WASIX source is based on {}, expected {}",
                patched_head.trim(),
                postgres.commit
            );
        }
    }

    println!("PostgreSQL 18 WASIX server-core source spine passed");
    Ok(())
}

fn source_checkout_status(path: &Path) -> Result<String> {
    command_output("git", &["status", "--porcelain"], path)
}

fn source_checkout_status_for_source(name: &str, path: &Path) -> Result<String> {
    if name == POSTGRES_PGLITE_SOURCE {
        return command_output(
            "git",
            &["status", "--porcelain", "--ignore-submodules=all"],
            path,
        );
    }
    source_checkout_status(path)
}

fn patch_adds_marker(patch_text: &str, marker: &str) -> bool {
    patch_text
        .lines()
        .any(|line| line.starts_with('+') && !line.starts_with("+++") && line.contains(marker))
}

#[cfg(unix)]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    let bridge = Path::new(WASIX_BRIDGE_PATH);
    let harness = Path::new("assets/wasix-build/wasix_shim/pglite_wasix_bridge_abi_test.c");
    if !harness.exists() {
        bail!("missing WASIX bridge ABI harness at {}", harness.display());
    }

    let out_dir = Path::new("target/xtask");
    fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let binary = out_dir.join("pglite_wasix_bridge_abi_test");
    let cc = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let status = Command::new(&cc)
        .args(["-std=c11", "-Wall", "-Wextra"])
        .arg(bridge)
        .arg(harness)
        .arg("-o")
        .arg(&binary)
        .status()
        .with_context(|| format!("compile WASIX bridge ABI harness with {cc}"))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness compilation failed with {status}");
    }
    let status = Command::new(&binary)
        .stdout(Stdio::null())
        .status()
        .with_context(|| format!("run {}", binary.display()))?;
    if !status.success() {
        bail!("WASIX bridge ABI harness failed with {status}");
    }
    println!("WASIX bridge ABI harness passed");
    Ok(())
}

#[cfg(unix)]
fn check_wasix_initdb_shim_abi_harness() -> Result<()> {
    let shim = Path::new("assets/wasix-build/wasix_shim/pglite_wasix_initdb_shim.c");
    let harness = Path::new("assets/wasix-build/wasix_shim/pglite_wasix_initdb_shim_abi_test.c");
    if !harness.exists() {
        bail!(
            "missing WASIX initdb shim ABI harness at {}",
            harness.display()
        );
    }

    let out_dir = Path::new("target/xtask");
    fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let binary = out_dir.join("pglite_wasix_initdb_shim_abi_test");
    let cc = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let status = Command::new(&cc)
        .args(["-std=c11", "-Wall", "-Wextra"])
        .arg(shim)
        .arg(harness)
        .arg("-o")
        .arg(&binary)
        .status()
        .with_context(|| format!("compile {}", harness.display()))?;
    if !status.success() {
        bail!("failed to compile {}", harness.display());
    }

    let status = Command::new(&binary)
        .status()
        .with_context(|| format!("run {}", binary.display()))?;
    if !status.success() {
        bail!("WASIX initdb shim ABI harness failed");
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_wasix_initdb_shim_abi_harness() -> Result<()> {
    println!("skipping WASIX initdb shim ABI harness on non-Unix host");
    Ok(())
}

#[cfg(not(unix))]
fn check_wasix_bridge_abi_harness() -> Result<()> {
    eprintln!("warning: skipping POSIX WASIX bridge ABI harness on non-Unix host");
    Ok(())
}

struct BuildOutputs {
    build_dir: PathBuf,
    source_dir: PathBuf,
    package_stage: PathBuf,
    runtime_kind: String,
    runtime_archive_module_path: String,
    modules: Vec<BuildModuleOutput>,
}

struct BuildModuleOutput {
    name: String,
    kind: String,
    path: PathBuf,
    aot_file: String,
}

impl BuildOutputs {
    fn discover() -> Result<Self> {
        let build_dir = PathBuf::from(WASIX_DOCKER_BUILD_DIR);
        let source_dir = PathBuf::from(WASIX_PATCHED_SOURCE_DIR);
        let package_stage = PathBuf::from(WASIX_BUILD_ROOT).join("build/package-stage");
        let direct_runtime = build_dir.join("src/backend/pglite");
        let postgres_runtime = build_dir.join("src/backend/postgres");
        let (runtime_kind, runtime_name, runtime_path, runtime_archive_module_path, aot_file) =
            if direct_runtime.exists() {
                (
                    RUNTIME_KIND_WASIX_DIRECT.to_owned(),
                    "runtime:pglite".to_owned(),
                    direct_runtime,
                    "bin/pglite".to_owned(),
                    "pglite-llvm-opta.bin.zst".to_owned(),
                )
            } else {
                (
                    RUNTIME_KIND_WASIX_POSTGRES_SERVER.to_owned(),
                    "runtime:postgres".to_owned(),
                    postgres_runtime,
                    "bin/postgres".to_owned(),
                    "postgres-llvm-opta.bin.zst".to_owned(),
                )
            };
        let mut modules = vec![
            BuildModuleOutput {
                name: runtime_name,
                kind: "runtime".to_owned(),
                path: runtime_path,
                aot_file,
            },
            BuildModuleOutput {
                name: "runtime-support:plpgsql".to_owned(),
                kind: "runtime-support".to_owned(),
                path: build_dir.join("src/pl/plpgsql/src/plpgsql.so"),
                aot_file: "plpgsql-llvm-opta.bin.zst".to_owned(),
            },
            BuildModuleOutput {
                name: "runtime-support:dict_snowball".to_owned(),
                kind: "runtime-support".to_owned(),
                path: build_dir.join("src/backend/snowball/dict_snowball.so"),
                aot_file: "dict_snowball-llvm-opta.bin.zst".to_owned(),
            },
            BuildModuleOutput {
                name: "tool:pg_dump".to_owned(),
                kind: "tool".to_owned(),
                path: build_dir.join("src/bin/pg_dump/pg_dump"),
                aot_file: "pg_dump-llvm-opta.bin.zst".to_owned(),
            },
            BuildModuleOutput {
                name: "tool:initdb".to_owned(),
                kind: "tool".to_owned(),
                path: build_dir.join("src/bin/initdb/initdb"),
                aot_file: "initdb-llvm-opta.bin.zst".to_owned(),
            },
        ];
        if runtime_kind == RUNTIME_KIND_WASIX_DIRECT {
            for extension in extension_catalog::promoted_build_specs()? {
                if extension.module_file.is_some() {
                    modules.push(BuildModuleOutput {
                        name: format!("extension:{}", extension.sql_name),
                        kind: "extension".to_owned(),
                        path: extension_build_module_path(&build_dir, &extension)?,
                        aot_file: format!(
                            "{}-llvm-opta.bin.zst",
                            extension_aot_file_stem(&extension)
                        ),
                    });
                }
            }
        }

        let outputs = Self {
            build_dir,
            source_dir,
            package_stage,
            runtime_kind,
            runtime_archive_module_path,
            modules,
        };
        outputs.ensure_required_files()?;
        Ok(outputs)
    }

    fn discover_for_aot() -> Result<Self> {
        if !Path::new(WASIX_PATCHED_SOURCE_DIR).exists() {
            return Self::from_packaged_assets();
        }
        Self::discover().or_else(|build_err| {
            eprintln!(
                "warning: transient WASIX build tree unavailable for AOT packaging: {build_err:#}"
            );
            Self::from_packaged_assets()
        })
    }

    fn from_packaged_assets() -> Result<Self> {
        let manifest = read_asset_manifest()?;
        let base = PathBuf::from("assets/wasix-build/build/aot-inputs");
        if base.exists() {
            fs::remove_dir_all(&base).with_context(|| format!("remove {}", base.display()))?;
        }
        fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;

        let assets_base = Path::new(GENERATED_ASSETS_DIR);
        let runtime_archive = assets_base.join(&manifest.runtime.archive);
        let runtime_archive_module_path = manifest.runtime.module_path.clone();
        let runtime_file_name = Path::new(&runtime_archive_module_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pglite");
        let runtime_path = base.join("runtime").join(runtime_file_name);
        write_bytes_file(
            &runtime_path,
            &archive_entry_bytes(
                &runtime_archive,
                &format!("pglite/{runtime_archive_module_path}"),
            )?,
        )?;
        let runtime_name = if manifest.runtime.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
            "runtime:postgres"
        } else {
            "runtime:pglite"
        };
        let runtime_aot_file =
            if manifest.runtime.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
                "postgres-llvm-opta.bin.zst"
            } else {
                "pglite-llvm-opta.bin.zst"
            };

        let mut modules = vec![BuildModuleOutput {
            name: runtime_name.to_owned(),
            kind: "runtime".to_owned(),
            path: runtime_path,
            aot_file: runtime_aot_file.to_owned(),
        }];

        for support in &manifest.runtime_support {
            let path = base.join("runtime-support").join(&support.name);
            write_bytes_file(
                &path,
                &archive_entry_bytes(&runtime_archive, &format!("pglite/{}", support.path))?,
            )?;
            modules.push(BuildModuleOutput {
                name: format!("runtime-support:{}", support.name),
                kind: "runtime-support".to_owned(),
                path,
                aot_file: format!("{}-llvm-opta.bin.zst", support.name),
            });
        }

        if let Some(pg_dump) = &manifest.pg_dump {
            let path = base.join("tools/pg_dump");
            copy_file(&assets_base.join(&pg_dump.path), &path)?;
            modules.push(BuildModuleOutput {
                name: "tool:pg_dump".to_owned(),
                kind: "tool".to_owned(),
                path,
                aot_file: "pg_dump-llvm-opta.bin.zst".to_owned(),
            });
        }
        if let Some(initdb) = &manifest.initdb {
            let path = base.join("tools/initdb");
            copy_file(&assets_base.join(&initdb.path), &path)?;
            modules.push(BuildModuleOutput {
                name: "tool:initdb".to_owned(),
                kind: "tool".to_owned(),
                path,
                aot_file: "initdb-llvm-opta.bin.zst".to_owned(),
            });
        }

        for extension in &manifest.extensions {
            let Some(native_module) = extension.native_module.as_deref() else {
                continue;
            };
            if extension.module_sha256.is_empty() {
                continue;
            }
            let entry = format!("lib/postgresql/{native_module}");
            let path = base
                .join("extensions")
                .join(&extension.sql_name)
                .join(native_module);
            write_bytes_file(
                &path,
                &archive_entry_bytes(&assets_base.join(&extension.archive), &entry)?,
            )?;
            modules.push(BuildModuleOutput {
                name: format!("extension:{}", extension.sql_name),
                kind: "extension".to_owned(),
                path,
                aot_file: format!("{}-llvm-opta.bin.zst", extension.sql_name.replace('/', "_")),
            });
        }

        Ok(Self {
            build_dir: base.clone(),
            source_dir: base.clone(),
            package_stage: base,
            runtime_kind: manifest.runtime.runtime_kind,
            runtime_archive_module_path,
            modules,
        })
    }

    fn ensure_required_files(&self) -> Result<()> {
        for module in &self.modules {
            ensure_file(&module.path)?;
        }
        ensure_file(&self.build_dir.join("src/timezone/compiled/UTC"))?;
        ensure_file(
            &self
                .build_dir
                .join("src/backend/snowball/snowball_create.sql"),
        )?;
        Ok(())
    }

    fn module_path(&self, name: &str) -> Result<&Path> {
        self.modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| module.path.as_path())
            .ok_or_else(|| anyhow!("missing build output module {name}"))
    }

    fn runtime_module(&self) -> Result<&BuildModuleOutput> {
        self.modules
            .iter()
            .find(|module| module.kind == "runtime")
            .ok_or_else(|| anyhow!("build outputs are missing runtime module"))
    }

    fn runtime_module_path(&self) -> Result<&Path> {
        Ok(self.runtime_module()?.path.as_path())
    }

    fn write_manifest(&self) -> Result<()> {
        let manifest = BuildOutputManifestOut {
            format_version: 1,
            build_profile: fs::read_to_string(self.build_dir.join(".pglite-oxide-build-profile"))
                .context("read WASIX build profile signature")?,
            modules: self
                .modules
                .iter()
                .map(|module| {
                    Ok(BuildModuleManifestOut {
                        name: module.name.clone(),
                        kind: module.kind.clone(),
                        path: module.path.to_string_lossy().into_owned(),
                        sha256: sha256_file(&module.path)?,
                        link: read_wasm_link_metadata(&module.path)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        };
        for module in &manifest.modules {
            validate_module_link_metadata(module)?;
        }
        let text = serde_json::to_string_pretty(&manifest)
            .context("serialize WASIX build output manifest")?;
        let path = Path::new(WASIX_BUILD_MANIFEST_PATH);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
    }
}

fn write_bytes_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

fn extension_build_module_path(
    build_dir: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
) -> Result<PathBuf> {
    let module_file = extension
        .module_file
        .as_deref()
        .ok_or_else(|| anyhow!("extension {} has no native module", extension.sql_name))?;
    match extension.build_kind.as_str() {
        "postgres-contrib" => {
            let contrib_dir = extension
                .contrib_dir
                .as_deref()
                .ok_or_else(|| anyhow!("contrib extension {} has no contrib_dir", extension.id))?;
            Ok(build_dir
                .join("contrib")
                .join(contrib_dir)
                .join(module_file))
        }
        "pgxs-external" => Ok(pgxs_extension_build_dir(build_dir, extension).join(module_file)),
        "postgis" => Ok(Path::new(POSTGRES_OTHER_EXTENSIONS)
            .join(&extension.id)
            .join(module_file)),
        other => bail!(
            "promoted extension {} has unsupported build kind {other}",
            extension.sql_name
        ),
    }
}

fn pgxs_extension_build_dir(
    build_dir: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
) -> PathBuf {
    build_dir.join("pgxs").join(&extension.id)
}

fn extension_aot_file_stem(extension: &extension_catalog::PromotedExtensionBuildSpec) -> String {
    extension.sql_name.replace('/', "_")
}

fn validate_build_profile_outputs(outputs: &BuildOutputs, profile: &str) -> Result<()> {
    let signature_path = outputs.build_dir.join(".pglite-oxide-build-profile");
    let signature = fs::read_to_string(&signature_path)
        .with_context(|| format!("read {}", signature_path.display()))?;
    let profile_line = format!("profile={profile}");
    if !signature.lines().any(|line| line == profile_line) {
        bail!(
            "WASIX build profile signature does not match requested profile {profile}: {}",
            signature_path.display()
        );
    }

    if profile.starts_with("release") {
        let cflags = signature
            .lines()
            .find_map(|line| line.strip_prefix("cflags="))
            .unwrap_or_default();
        let has_release_opt = ["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| cflags.split_whitespace().any(|part| part == *flag));
        if !has_release_opt || !cflags.split_whitespace().any(|part| part == "-g0") {
            bail!(
                "release WASIX profile must include an optimizing -O flag and -g0; got cflags={cflags:?}"
            );
        }

        let makefile = outputs.build_dir.join("src/Makefile.global");
        let makefile_text = fs::read_to_string(&makefile)
            .with_context(|| format!("read {}", makefile.display()))?;
        if !["-O2", "-O3", "-Os", "-Oz"]
            .iter()
            .any(|flag| makefile_text.contains(flag))
        {
            bail!(
                "release WASIX build did not propagate optimization flags into {}",
                makefile.display()
            );
        }
    }

    Ok(())
}

fn validate_module_link_metadata(module: &BuildModuleManifestOut) -> Result<()> {
    if module.link.exports.is_empty() {
        bail!("{} has no WASM exports", module.name);
    }

    match module.kind.as_str() {
        "runtime" => {
            if module.name == "runtime:pglite" {
                let missing = required_runtime_abi_exports()
                    .iter()
                    .copied()
                    .filter(|export| !has_wasm_export(&module.link, export))
                    .collect::<Vec<_>>();
                if !missing.is_empty() {
                    bail!(
                        "{} is missing required Rust/WASIX ABI exports: {}",
                        module.name,
                        missing.join(", ")
                    );
                }
                for banned in ["pgl_initdb", "pgl_backend", "PostgresRecoverProtocolError"] {
                    if has_wasm_export(&module.link, banned) {
                        bail!(
                            "{} exports legacy builder-branch lifecycle entrypoint {banned}",
                            module.name
                        );
                    }
                }
            }
        }
        "runtime-support" | "extension" => {
            if !module.link.has_dylink0 {
                bail!("{} is not a WASM dynamic-linking side module", module.name);
            }
            if module.link.imports.is_empty() && module.link.dylink_imports.is_empty() {
                bail!(
                    "{} has no imports; side-module linkage is suspicious",
                    module.name
                );
            }
        }
        "tool" => {}
        other => bail!("{} has unknown build output kind {other}", module.name),
    }

    Ok(())
}

fn validate_build_output_link_closure(outputs: &BuildOutputs) -> Result<()> {
    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        return Ok(());
    }

    let runtime = outputs
        .modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_link = read_wasm_link_metadata(&runtime.path)?;
    let runtime_exports = runtime_link
        .exports
        .iter()
        .flat_map(|export| {
            let name = export.name.trim_start_matches('_').to_owned();
            [export.name.clone(), name]
        })
        .collect::<HashSet<_>>();

    let mut failures = Vec::new();
    for module in outputs
        .modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
    {
        let link = read_wasm_link_metadata(&module.path)?;
        for import in &link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            let normalized = import.name.trim_start_matches('_');
            if !runtime_exports.contains(import.name.as_str())
                && !runtime_exports.contains(normalized)
            {
                failures.push(format!(
                    "{} imports {}.{}",
                    module.name, import.module, import.name
                ));
            }
        }
    }

    if !failures.is_empty() {
        bail!(
            "WASIX dynamic-link closure has unresolved side-module imports: {}",
            failures.join(", ")
        );
    }
    Ok(())
}

fn generate_wasix_export_list(write: bool) -> Result<()> {
    let output = wasix_export_list_text()?;
    if write {
        let path = Path::new("assets/generated/wasix-dl.exports");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(path, output).with_context(|| format!("write {}", path.display()))?;
    } else {
        print!("{output}");
    }
    Ok(())
}

fn check_generated_wasix_export_list(strict: bool) -> Result<()> {
    if Path::new(WASIX_BUILD_MANIFEST_PATH).exists() {
        let manifest = read_build_output_manifest()?;
        if build_modules_are_postgres_server_core(&manifest.modules) {
            println!("skipping direct WASIX export-list check for PG18 server-core runtime");
            return Ok(());
        }
    }
    if Path::new(GENERATED_ASSETS_DIR)
        .join("manifest.json")
        .exists()
    {
        let manifest = read_asset_manifest()?;
        if manifest.runtime.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
            println!("skipping direct WASIX export-list check for PG18 server-core assets");
            return Ok(());
        }
    }

    let expected = match wasix_export_list_text() {
        Ok(expected) => expected,
        Err(err) if !strict => {
            eprintln!("warning: skipping generated WASIX export-list check: {err:#}");
            return Ok(());
        }
        Err(err) => return Err(err).context("generate expected WASIX export list"),
    };
    let path = Path::new("assets/generated/wasix-dl.exports");
    if !path.exists() {
        if strict {
            bail!(
                "generated WASIX export list is missing at {}; run `cargo run -p xtask -- assets export-list --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated WASIX export list is missing at {}",
            path.display()
        );
        return Ok(());
    }
    let actual = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if actual != expected {
        if strict {
            bail!(
                "generated WASIX export list is stale at {}; run `cargo run -p xtask -- assets export-list --write`",
                path.display()
            );
        }
        eprintln!(
            "warning: generated WASIX export list is stale at {}",
            path.display()
        );
    }
    Ok(())
}

fn check_source_controlled_wasix_export_list() -> Result<()> {
    let manifest = load_sources_manifest()?;
    if manifest_uses_postgres_server_core(&manifest)? {
        println!(
            "skipping source-controlled direct WASIX export-list guard for PG18 server-core lane"
        );
        return Ok(());
    }

    let path = Path::new("assets/generated/wasix-dl.exports");
    ensure_file(path)?;
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        !text.trim().is_empty(),
        "{} must not be empty",
        path.display()
    );
    for symbol in [
        "ProcessStartupPacket",
        "PostgresMainLoopOnce",
        "PostgresMainLongJmp",
        "PostgresSendReadyForQueryIfNecessary",
        "pgl_getMyProcPort",
        "pgl_pq_flush",
        "pgl_sendConnData",
        "pgl_setPGliteActive",
        "pgl_set_force_host_error_recovery",
        "pgl_startPGlite",
        "pgl_wasix_input_write",
        "pgl_wasix_output_read",
        "malloc",
        "free",
    ] {
        ensure!(
            text.lines().any(|line| line == symbol),
            "{} is missing required runtime/protocol export symbol {symbol}",
            path.display()
        );
    }
    let mut previous: Option<&str> = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(previous) = previous {
            ensure!(
                previous <= line,
                "{} must stay sorted for deterministic reviews; {previous} appears before {line}",
                path.display()
            );
        }
        previous = Some(line);
    }
    println!("source-controlled WASIX export-list guard passed");
    Ok(())
}

fn manifest_uses_postgres_server_core(manifest: &SourcesManifest) -> Result<bool> {
    let postgres = source_by_name(manifest, POSTGRES_PGLITE_SOURCE)?;
    Ok(postgres.url.contains("github.com/postgres/postgres")
        && postgres.branch.starts_with("REL_18"))
}

fn build_modules_are_postgres_server_core(modules: &[BuildModuleManifestOut]) -> bool {
    modules
        .iter()
        .any(|module| module.kind == "runtime" && module.name == "runtime:postgres")
}

fn wasix_export_list_text() -> Result<String> {
    if Path::new(WASIX_BUILD_MANIFEST_PATH).exists() {
        let manifest = read_build_output_manifest()?;
        return wasix_export_list_from_modules(&manifest.modules);
    }
    if Path::new(GENERATED_ASSETS_DIR)
        .join("manifest.json")
        .exists()
    {
        let manifest = read_asset_manifest()?;
        let modules = build_output_modules_from_asset_manifest(&manifest);
        return wasix_export_list_from_modules(&modules);
    }

    let outputs = BuildOutputs::discover()?;
    let modules = outputs
        .modules
        .iter()
        .map(|module| {
            Ok(BuildModuleManifestOut {
                name: module.name.clone(),
                kind: module.kind.clone(),
                path: module.path.to_string_lossy().into_owned(),
                sha256: String::new(),
                link: read_wasm_link_metadata(&module.path)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    wasix_export_list_from_modules(&modules)
}

fn read_build_output_manifest() -> Result<BuildOutputManifestOut> {
    let path = Path::new(WASIX_BUILD_MANIFEST_PATH);
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn read_asset_manifest() -> Result<AssetManifestOut> {
    read_asset_manifest_from(Path::new(GENERATED_ASSETS_DIR))
}

fn read_asset_manifest_from(asset_dir: &Path) -> Result<AssetManifestOut> {
    let path = asset_dir.join("manifest.json");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn build_output_modules_from_asset_manifest(
    manifest: &AssetManifestOut,
) -> Vec<BuildModuleManifestOut> {
    let runtime_name = if manifest.runtime.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        "runtime:postgres"
    } else {
        "runtime:pglite"
    };
    let mut modules = vec![BuildModuleManifestOut {
        name: runtime_name.to_owned(),
        kind: "runtime".to_owned(),
        path: manifest.runtime.archive.clone(),
        sha256: manifest.runtime.module_sha256.clone(),
        link: manifest.runtime.link.clone(),
    }];

    modules.extend(
        manifest
            .runtime_support
            .iter()
            .map(|module| BuildModuleManifestOut {
                name: format!("runtime-support:{}", module.name),
                kind: "runtime-support".to_owned(),
                path: module.path.clone(),
                sha256: module.module_sha256.clone(),
                link: module.link.clone(),
            }),
    );

    if let Some(pg_dump) = &manifest.pg_dump {
        modules.push(BuildModuleManifestOut {
            name: "tool:pg_dump".to_owned(),
            kind: "tool".to_owned(),
            path: pg_dump.path.clone(),
            sha256: pg_dump.module_sha256.clone(),
            link: pg_dump.link.clone(),
        });
    }
    if let Some(initdb) = &manifest.initdb {
        modules.push(BuildModuleManifestOut {
            name: "tool:initdb".to_owned(),
            kind: "tool".to_owned(),
            path: initdb.path.clone(),
            sha256: initdb.module_sha256.clone(),
            link: initdb.link.clone(),
        });
    }

    modules.extend(manifest.extensions.iter().filter_map(|extension| {
        extension.link.clone().map(|link| BuildModuleManifestOut {
            name: format!("extension:{}", extension.sql_name),
            kind: "extension".to_owned(),
            path: extension.archive.clone(),
            sha256: extension.module_sha256.clone(),
            link,
        })
    }));

    modules
}

fn wasix_export_list_from_modules(modules: &[BuildModuleManifestOut]) -> Result<String> {
    for module in modules {
        validate_module_link_metadata(module)?;
    }

    let runtime = modules
        .iter()
        .find(|module| module.kind == "runtime")
        .ok_or_else(|| anyhow!("build outputs are missing runtime module"))?;
    let runtime_exports = wasm_export_name_set(&runtime.link);
    let mut required_exports = BTreeSet::<String>::new();
    let mut unresolved = Vec::new();

    for abi_export in required_runtime_abi_exports().iter().copied() {
        let normalized = abi_export.trim_start_matches('_');
        if runtime_exports.contains(abi_export) {
            required_exports.insert(abi_export.to_owned());
        } else if runtime_exports.contains(normalized) {
            required_exports.insert(normalized.to_owned());
        } else {
            unresolved.push(format!("runtime ABI export {abi_export}"));
        }
    }

    for module in modules
        .iter()
        .filter(|module| matches!(module.kind.as_str(), "runtime-support" | "extension"))
    {
        for import in &module.link.imports {
            if !import_should_resolve_from_runtime(import) {
                continue;
            }
            let normalized = import.name.trim_start_matches('_');
            if runtime_exports.contains(import.name.as_str()) {
                required_exports.insert(import.name.clone());
            } else if runtime_exports.contains(normalized) {
                required_exports.insert(normalized.to_owned());
            } else {
                unresolved.push(format!(
                    "{} imports {}.{}",
                    module.name, import.module, import.name
                ));
            }
        }
    }

    if !unresolved.is_empty() {
        bail!(
            "cannot generate WASIX dynamic-link export list with unresolved imports: {}",
            unresolved.join(", ")
        );
    }

    Ok(required_exports.into_iter().collect::<Vec<_>>().join("\n") + "\n")
}

fn required_runtime_abi_exports() -> &'static [&'static str] {
    &[
        "_start",
        "pgl_setPGliteActive",
        "pgl_startPGlite",
        "pgl_getMyProcPort",
        "ProcessStartupPacket",
        "pgl_sendConnData",
        "pgl_pq_flush",
        "pq_buffer_remaining_data",
        "PostgresMainLoopOnce",
        "PostgresSendReadyForQueryIfNecessary",
        "PostgresMainLongJmp",
        "pgl_set_protocol_stdio",
        "pgl_set_force_host_error_recovery",
        "pgl_wasix_input_reset",
        "pgl_wasix_input_write",
        "pgl_wasix_input_available",
        "pgl_wasix_output_reset",
        "pgl_wasix_output_len",
        "pgl_wasix_output_read",
    ]
}

fn import_should_resolve_from_runtime(import: &WasmImportOut) -> bool {
    match import.module.as_str() {
        "env" | "GOT.func" | "GOT.mem" => !matches!(
            import.name.as_str(),
            "__indirect_function_table"
                | "__memory_base"
                | "__stack_pointer"
                | "__table_base"
                | "memory"
        ),
        _ => false,
    }
}

fn wasm_export_name_set(link: &WasmLinkMetadataOut) -> HashSet<String> {
    link.exports
        .iter()
        .flat_map(|export| {
            let normalized = export.name.trim_start_matches('_').to_owned();
            [export.name.clone(), normalized]
        })
        .collect()
}

fn has_wasm_export(link: &WasmLinkMetadataOut, name: &str) -> bool {
    link.exports
        .iter()
        .any(|export| export.name == name || export.name == format!("_{name}"))
}

fn build_asset_spine(
    _manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    let execute = args.iter().any(|arg| arg == "--execute")
        || env::var("PGLITE_OXIDE_EXECUTE_ASSET_BUILD").as_deref() == Ok("1");

    println!("asset build inputs validated");
    println!("profile={profile}");
    println!("target-triple={target}");

    let commands = [
        "assets/wasix-build/docker_pglite.sh",
        "assets/wasix-build/docker_runtime_support.sh",
        "assets/wasix-build/docker_initdb.sh",
        "assets/wasix-build/docker_pgxs_extensions.sh",
        "assets/wasix-build/docker_contrib_extensions.sh",
        "assets/wasix-build/docker_pgdump.sh",
    ];

    if !execute {
        println!("source-spine build is ready but not executed by default");
        println!("run with --execute or PGLITE_OXIDE_EXECUTE_ASSET_BUILD=1 to invoke:");
        for command in commands {
            println!("  {command}");
        }
        println!("follow with `assets package` and `assets aot` to refresh publishable artifacts");
        return Ok(());
    }

    for script in commands {
        let mut command = Command::new("bash");
        command
            .arg(script)
            .env("PGLITE_OXIDE_BUILD_PROFILE", profile);
        run_command(&mut command)?;
    }

    let outputs = BuildOutputs::discover()?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    println!("wrote WASIX build output manifest to {WASIX_BUILD_MANIFEST_PATH}");
    Ok(())
}

fn release_build_assets(
    manifest: &SourcesManifest,
    profile: &str,
    target: &str,
    args: &[String],
) -> Result<()> {
    let mut build_args = vec![
        "build".to_owned(),
        "--profile".to_owned(),
        profile.to_owned(),
        "--target-triple".to_owned(),
        target.to_owned(),
        "--execute".to_owned(),
    ];
    build_args.extend(
        args.iter()
            .filter(|arg| {
                matches!(
                    arg.as_str(),
                    "--skip-build" | "--skip-aot" | "--skip-package-size"
                )
            })
            .cloned(),
    );

    if !args.iter().any(|arg| arg == "--skip-build") {
        build_asset_spine(manifest, profile, target, &build_args)?;
    } else {
        eprintln!("warning: skipping WASIX rebuild by request");
    }

    let outputs = BuildOutputs::discover()?;
    validate_build_profile_outputs(&outputs, profile)?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;

    let skip_aot = args.iter().any(|arg| arg == "--skip-aot")
        || outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER;
    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER
        && !args.iter().any(|arg| arg == "--skip-aot")
    {
        eprintln!("warning: PG18 WASIX server-core runtime currently skips embedded AOT packaging");
    }
    package_assets_with_options(manifest, target, false)?;
    check_canonical_asset_layout(true)?;
    check_generated_manifest(manifest, true)?;

    if !skip_aot {
        generate_aot_artifacts(target)?;
        package_aot_artifacts(target, &outputs, manifest)?;
        check_aot_package_manifest(target)?;
    } else {
        eprintln!("warning: skipping AOT generation by request");
    }

    if !args.iter().any(|arg| arg == "--skip-package-size") {
        package_size(vec!["--enforce".to_owned()])?;
    }

    Ok(())
}

fn generate_aot_artifacts(target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot()?;
    let source_dir = Path::new("assets/wasix-build/build/aot").join(target);
    fs::create_dir_all(&source_dir).with_context(|| format!("create {}", source_dir.display()))?;
    let serializer = ensure_aot_serializer_binary()?;

    for module in &outputs.modules {
        let output = source_dir.join(&module.aot_file);
        generate_one_aot_artifact(&serializer, &module.path, &output)?;
    }
    Ok(())
}

fn package_aot_only(manifest: &SourcesManifest, target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot()?;
    package_aot_artifacts(target, &outputs, manifest)?;
    check_aot_package_manifest(target)
}

fn ensure_aot_serializer_binary() -> Result<PathBuf> {
    let mut command = Command::new("cargo");
    command
        .args([
            "build",
            "-p",
            "xtask",
            "--release",
            "--locked",
            "--features",
            "aot-serializer",
        ])
        .env("CARGO_INCREMENTAL", "0");
    if env::var_os("LLVM_SYS_221_PREFIX").is_none() && Path::new("/opt/homebrew/opt/llvm").exists()
    {
        command.env("LLVM_SYS_221_PREFIX", "/opt/homebrew/opt/llvm");
    }
    configure_windows_llvm_aot_link(&mut command);
    run_command(&mut command).context("build maintainer AOT serializer")?;

    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    let target_dir = if target_dir.is_absolute() {
        target_dir
    } else {
        env::current_dir()
            .context("read current directory")?
            .join(target_dir)
    };
    let serializer = target_dir
        .join("release")
        .join(format!("xtask{}", env::consts::EXE_SUFFIX));
    ensure_file(&serializer)?;
    Ok(serializer)
}

fn generate_one_aot_artifact(serializer: &Path, input: &Path, output: &Path) -> Result<()> {
    ensure_file(input)?;
    let input =
        fs::canonicalize(input).with_context(|| format!("canonicalize {}", input.display()))?;
    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        env::current_dir()
            .context("read current directory")?
            .join(output)
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut command = Command::new(serializer);
    command
        .args(["aot-serializer", "serialize", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(output)
        .env("CARGO_INCREMENTAL", "0");
    if env::var_os("LLVM_SYS_221_PREFIX").is_none() && Path::new("/opt/homebrew/opt/llvm").exists()
    {
        command.env("LLVM_SYS_221_PREFIX", "/opt/homebrew/opt/llvm");
    }
    configure_windows_llvm_aot_link(&mut command);
    run_command(&mut command)
        .with_context(|| format!("generate AOT artifact for {}", input.display()))
}

fn configure_windows_llvm_aot_link(command: &mut Command) {
    if !cfg!(windows) {
        return;
    }

    let Some(prefix) = env::var_os("LLVM_SYS_221_PREFIX").or_else(|| env::var_os("LLVM_PATH"))
    else {
        return;
    };
    let llvm_lib = PathBuf::from(prefix).join("lib");
    if llvm_lib.is_dir() {
        let mut lib = llvm_lib.display().to_string();
        if let Some(existing) = env::var_os("LIB").and_then(|value| value.into_string().ok())
            && !existing.is_empty()
        {
            lib.push(';');
            lib.push_str(&existing);
        }
        command.env("LIB", lib);
    }
}

fn package_assets(manifest: &SourcesManifest, target: &str) -> Result<()> {
    package_assets_with_options(manifest, target, true)
}

fn package_assets_with_options(
    manifest: &SourcesManifest,
    target: &str,
    include_aot: bool,
) -> Result<()> {
    let outputs = BuildOutputs::discover()?;
    outputs.write_manifest()?;
    validate_build_output_link_closure(&outputs)?;
    let stage = &outputs.package_stage;

    if stage.exists() {
        fs::remove_dir_all(stage).with_context(|| format!("remove {}", stage.display()))?;
    }
    fs::create_dir_all(stage).with_context(|| format!("create {}", stage.display()))?;

    let runtime_stage = stage.join("runtime/pglite");
    stage_runtime_tree(&outputs, &runtime_stage)?;
    let assets_dir = Path::new(GENERATED_ASSETS_DIR);
    if assets_dir.exists() {
        fs::remove_dir_all(assets_dir)
            .with_context(|| format!("remove {}", assets_dir.display()))?;
    }
    fs::create_dir_all(assets_dir).with_context(|| format!("create {}", assets_dir.display()))?;

    let runtime_archive = assets_dir.join("pglite.wasix.tar.zst");
    deterministic_tar_zst(&runtime_stage, Path::new("pglite"), &runtime_archive)?;

    let pg_dump = assets_dir.join("bin/pg_dump.wasix.wasm");
    copy_file(outputs.module_path("tool:pg_dump")?, &pg_dump)?;
    let initdb = assets_dir.join("bin/initdb.wasix.wasm");
    copy_file(outputs.module_path("tool:initdb")?, &initdb)?;

    let extension_packages = package_promoted_extensions(stage, &outputs)?;
    let extension_package_refs = extension_packages
        .iter()
        .map(|extension| ExtensionPackage {
            name: extension.name.as_str(),
            sql_name: extension.sql_name.as_str(),
            archive: extension.archive.as_str(),
            path: extension.path.as_path(),
            module_path: extension.module_path.as_deref(),
            native_module: extension.native_module.as_deref(),
            stable: extension.stable,
        })
        .collect::<Vec<_>>();

    if include_aot && outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        eprintln!("warning: skipping embedded AOT packaging for PG18 WASIX server-core runtime");
    } else if include_aot {
        package_aot_artifacts(target, &outputs, manifest)?;
    }
    generate_pgdata_template_from_runtime_stage(manifest, &outputs, &runtime_stage, assets_dir)?;
    write_asset_manifest(
        manifest,
        outputs.runtime_module_path()?,
        &runtime_archive,
        &outputs.runtime_kind,
        &outputs.runtime_archive_module_path,
        &pg_dump,
        &initdb,
        &[
            BinaryPackage {
                name: "plpgsql",
                path: outputs.module_path("runtime-support:plpgsql")?,
                runtime_path: "lib/postgresql/plpgsql.so",
            },
            BinaryPackage {
                name: "dict_snowball",
                path: outputs.module_path("runtime-support:dict_snowball")?,
                runtime_path: "lib/postgresql/dict_snowball.so",
            },
        ],
        &extension_package_refs,
    )?;

    println!("packaged runtime assets into {GENERATED_ASSETS_DIR}");
    if include_aot && outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        println!("skipped {target} AOT artifact packaging for PG18 WASIX server-core runtime");
    } else if include_aot {
        println!("packaged {target} AOT artifacts");
    } else {
        println!("skipped {target} AOT artifact packaging by request");
    }
    Ok(())
}

fn generate_pgdata_template_asset(manifest: &SourcesManifest) -> Result<()> {
    let outputs = BuildOutputs::discover()?;
    let stage_root = outputs.package_stage.join("template-runtime");
    if stage_root.exists() {
        fs::remove_dir_all(&stage_root)
            .with_context(|| format!("remove {}", stage_root.display()))?;
    }
    stage_runtime_tree(&outputs, &stage_root)?;
    generate_pgdata_template_from_runtime_stage(
        manifest,
        &outputs,
        &stage_root,
        Path::new(GENERATED_ASSETS_DIR),
    )
}

fn generate_pgdata_template_from_runtime_stage(
    manifest: &SourcesManifest,
    outputs: &BuildOutputs,
    runtime_stage: &Path,
    assets_dir: &Path,
) -> Result<()> {
    let output_dir = assets_dir.join("prepopulated");
    if output_dir.exists() {
        fs::remove_dir_all(&output_dir)
            .with_context(|| format!("remove {}", output_dir.display()))?;
    }
    fs::create_dir_all(&output_dir).with_context(|| format!("create {}", output_dir.display()))?;

    let work_root = assets_dir.join("template-work");
    if work_root.exists() {
        fs::remove_dir_all(&work_root)
            .with_context(|| format!("remove {}", work_root.display()))?;
    }
    fs::create_dir_all(&work_root).with_context(|| format!("create {}", work_root.display()))?;

    run_wasix_initdb_template(manifest, outputs, runtime_stage, &work_root)?;

    let pgdata = work_root.join("pgdata");
    ensure!(
        pgdata.join("PG_VERSION").is_file() && pgdata.join("global/pg_control").is_file(),
        "WASIX initdb did not create a complete PGDATA template at {}",
        pgdata.display()
    );
    clean_generated_pgdata_template(&pgdata)?;
    let pgdata_postgres_version = read_pgdata_postgres_version(&pgdata)?;
    let expected_pgdata_postgres_version = postgres_major_version_from_sources(manifest)?;
    ensure_eq(
        &pgdata_postgres_version,
        &expected_pgdata_postgres_version,
        "WASIX PGDATA template PostgreSQL major version",
    )?;

    let archive = output_dir.join("pgdata-template.tar.zst");
    deterministic_tar_zst(&pgdata, Path::new(""), &archive)?;
    let manifest_path = output_dir.join("pgdata-template.json");
    let manifest_json = serde_json::json!({
        "architectureIndependent": true,
        "archiveSha256": sha256_file(&archive)?,
        "catalogVersion": postgres_catalog_version(&outputs.source_dir)?,
        "generatedBy": "wasix-initdb",
        "initProfile": default_initdb_profile(),
        "initdbSha256": sha256_file(outputs.module_path("tool:initdb")?)?,
        "postgresVersion": pgdata_postgres_version,
        "sourcePinsSha256": source_pins_sha256(manifest)?,
        "wasmerVersion": manifest.toolchain.wasmer,
        "wasmSha256": sha256_file(outputs.runtime_module_path()?)?,
    });
    fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest_json)?),
    )
    .with_context(|| format!("write {}", manifest_path.display()))?;
    fs::remove_dir_all(&work_root).with_context(|| format!("remove {}", work_root.display()))?;
    Ok(())
}

#[cfg(feature = "template-runner")]
fn run_wasix_initdb_template(
    _manifest: &SourcesManifest,
    outputs: &BuildOutputs,
    runtime_stage: &Path,
    work_root: &Path,
) -> Result<()> {
    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        return run_wasix_initdb_template_cli(runtime_stage, work_root);
    }

    use std::sync::Arc;

    use wasmer::Engine;
    use wasmer_wasix::bin_factory::BinaryPackage;
    use wasmer_wasix::runners::wasi::{RuntimeOrEngine, WasiRunner};
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
    use wasmer_wasix::runtime::{PluggableRuntime, Runtime};
    use wasmer_wasix::virtual_fs;
    use wasmer_wasix::virtual_fs::null_file::NullFile;

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
    let postgres_module = if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        runtime_stage.join("bin/postgres")
    } else {
        runtime_stage.join("bin/pglite")
    };
    copy_file(&postgres_module, &package_dir.join("modules/postgres.wasm"))?;
    let wasmer_toml = r#"
[package]
name = "pglite-oxide/initdb-template"
version = "0.0.0"
description = "pglite-oxide generated PGDATA template builder"

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
    if env::var_os("PGLITE_OXIDE_TEMPLATE_LOG").is_some() || run_result.is_err() {
        print_captured_wasix_output("initdb stdout", &stdout);
        print_captured_wasix_output("initdb stderr", &stderr);
    }
    run_result.context("run WASIX initdb to generate PGDATA template")
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

#[cfg(not(feature = "template-runner"))]
fn run_wasix_initdb_template(
    _manifest: &SourcesManifest,
    outputs: &BuildOutputs,
    runtime_stage: &Path,
    work_root: &Path,
) -> Result<()> {
    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        return run_wasix_initdb_template_cli(runtime_stage, work_root);
    }
    bail!(
        "`assets template` and template generation during release-build require `cargo run -p xtask --features template-runner -- ...` so xtask has a maintainer-only Wasmer compiler backend"
    )
}

fn run_wasix_initdb_template_cli(runtime_stage: &Path, work_root: &Path) -> Result<()> {
    let wasmer = locate_external_wasmer_bin()?;
    let workspace = fs::canonicalize(".").context("canonicalize workspace root")?;
    let runtime_stage = fs::canonicalize(runtime_stage)
        .with_context(|| format!("canonicalize {}", runtime_stage.display()))?;
    let pgdata_root = work_root.join("pgdata");
    let dev_shm = work_root.join("dev-shm");
    let wasmer_home = work_root.join("wasmer-home");
    let wasmer_cache = work_root.join("wasmer-cache");
    for dir in [&pgdata_root, &dev_shm, &wasmer_home, &wasmer_cache] {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let pgdata_root = fs::canonicalize(&pgdata_root)
        .with_context(|| format!("canonicalize {}", pgdata_root.display()))?;
    let dev_shm = fs::canonicalize(&dev_shm)
        .with_context(|| format!("canonicalize {}", dev_shm.display()))?;

    let mut command = Command::new(&wasmer);
    command
        .env("WASMER_DIR", &wasmer_home)
        .env("WASMER_CACHE_DIR", &wasmer_cache)
        .arg("run")
        .arg("--quiet");
    append_external_wasmer_compiler_args(&wasmer, &mut command)?;
    command
        .arg("--stack-size")
        .arg("33554432")
        .arg("--enable-exceptions")
        .arg("--enable-threads")
        .arg("--net")
        .arg("--volume")
        .arg(format!("{}:{}", workspace.display(), workspace.display()))
        .arg("--volume")
        .arg(format!("{}:/lib", runtime_stage.join("lib").display()))
        .arg("--volume")
        .arg(format!("{}:/dev/shm", dev_shm.display()));
    for (name, value) in [
        ("PGDATA", pgdata_root.display().to_string()),
        ("PGSYSCONFDIR", pgdata_root.display().to_string()),
        ("HOME", "/home/postgres".to_owned()),
        ("USER", "postgres".to_owned()),
        ("LOGNAME", "postgres".to_owned()),
        ("PGCLIENTENCODING", "UTF8".to_owned()),
        ("PATH", "/bin".to_owned()),
        ("LC_CTYPE", "C.UTF-8".to_owned()),
        ("TZ", "UTC".to_owned()),
        ("PGTZ", "UTC".to_owned()),
        ("PG_COLOR", "never".to_owned()),
    ] {
        command.arg("--env").arg(format!("{name}={value}"));
    }
    command
        .arg(runtime_stage.join("bin/initdb"))
        .arg("--")
        .args([
            "--allow-group-access",
            "--encoding",
            "UTF8",
            "--locale=C.UTF-8",
            "--locale-provider=libc",
            "--auth=trust",
        ])
        .arg("-D")
        .arg(&pgdata_root);

    let output = command.output().with_context(|| {
        format!(
            "run external Wasmer initdb template with {}",
            wasmer.display()
        )
    })?;
    if env::var_os("PGLITE_OXIDE_TEMPLATE_LOG").is_some() || !output.status.success() {
        print_process_output("initdb stdout", &output.stdout);
        print_process_output("initdb stderr", &output.stderr);
    }
    ensure!(
        output.status.success(),
        "external Wasmer initdb template failed with {}",
        output.status
    );
    Ok(())
}

fn locate_external_wasmer_bin() -> Result<PathBuf> {
    for name in ["PGLITE_OXIDE_WASMER_BIN", "WASMER_BIN"] {
        if let Some(value) = env::var_os(name) {
            return resolve_program_path(&value)
                .with_context(|| format!("{name} is set but does not resolve to an executable"));
        }
    }
    let repo_wasmer =
        PathBuf::from("assets/wasix-build/work/upstream/wasmer/target/release/wasmer");
    if repo_wasmer.is_file() {
        return Ok(repo_wasmer);
    }
    resolve_program_path(std::ffi::OsStr::new("wasmer"))
        .context("Wasmer CLI is required for PostgreSQL 18 WASIX server-core template generation")
}

fn resolve_program_path(value: &std::ffi::OsStr) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.components().count() > 1 {
        ensure!(
            path.is_file(),
            "{} is not an executable file",
            path.display()
        );
        return Ok(path);
    }
    let path_env = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&path_env) {
        let candidate = dir.join(&path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!("program {:?} was not found on PATH", value)
}

fn append_external_wasmer_compiler_args(wasmer: &Path, command: &mut Command) -> Result<()> {
    if wasmer_cli_help_contains(wasmer, "--llvm") {
        command.arg("--llvm");
        if wasmer_cli_help_contains(wasmer, "--llvm-opt-level") {
            command
                .arg("--llvm-opt-level")
                .arg(env::var("WASMER_LLVM_OPT_LEVEL").unwrap_or_else(|_| "aggressive".to_owned()));
        }
    }
    if wasmer_cli_help_contains(wasmer, "--compiler-threads") {
        let threads = env::var("WASMER_COMPILER_THREADS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(4)
            });
        command.arg("--compiler-threads").arg(threads.to_string());
    }
    Ok(())
}

fn wasmer_cli_help_contains(wasmer: &Path, option: &str) -> bool {
    let Ok(output) = Command::new(wasmer).arg("run").arg("--help").output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let mut help = String::from_utf8_lossy(&output.stdout).into_owned();
    help.push_str(&String::from_utf8_lossy(&output.stderr));
    help.contains(option)
}

fn print_process_output(label: &str, output: &[u8]) {
    if output.is_empty() {
        eprintln!("{label}: <empty>");
    } else {
        eprintln!("--- {label} ---");
        eprintln!("{}", String::from_utf8_lossy(output));
        eprintln!("--- end {label} ---");
    }
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
        "-D",
        "/base",
    ]
}

fn default_initdb_profile() -> &'static str {
    "allow-group-access,encoding=UTF8,locale=C.UTF-8,locale-provider=libc,auth=trust"
}

fn clean_generated_pgdata_template(pgdata: &Path) -> Result<()> {
    for name in ["postmaster.pid", "postmaster.opts"] {
        let path = pgdata.join(name);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

fn package_promoted_extensions(
    stage: &Path,
    outputs: &BuildOutputs,
) -> Result<Vec<OwnedExtensionPackage>> {
    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        return Ok(Vec::new());
    }

    let source = &outputs.source_dir;
    let build = &outputs.build_dir;
    let mut packages = Vec::new();
    for extension in extension_catalog::promoted_build_specs()? {
        let extension_stage = stage.join("extensions").join(&extension.sql_name);
        stage_promoted_extension(source, build, &extension, &extension_stage)?;
        let archive_path = Path::new(GENERATED_ASSETS_DIR).join(&extension.archive);
        deterministic_tar_zst(&extension_stage, Path::new(""), &archive_path)?;
        packages.push(OwnedExtensionPackage {
            name: extension.display_name,
            sql_name: extension.sql_name.clone(),
            archive: extension.archive.clone(),
            path: archive_path,
            module_path: if extension.module_file.is_some() {
                Some(
                    outputs
                        .module_path(&format!("extension:{}", extension.sql_name))?
                        .to_path_buf(),
                )
            } else {
                None
            },
            native_module: extension.module_file.clone(),
            stable: extension.stable,
        });
    }
    Ok(packages)
}

fn stage_promoted_extension(
    source: &Path,
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    match extension.build_kind.as_str() {
        "postgres-contrib" => stage_contrib_extension(source, build, extension, stage),
        "pgxs-external" => stage_pgxs_style_extension(build, extension, stage),
        other => bail!(
            "promoted extension {} has unsupported packaging build kind {other}",
            extension.sql_name
        ),
    }
}

fn stage_pgxs_style_extension(
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    let source = Path::new(&extension.source_dir);
    let build_dir = pgxs_extension_build_dir(build, extension);
    let sql_name = extension.sql_name.as_str();
    let extension_sql_dir = stage.join("share/postgresql/extension");
    fs::create_dir_all(stage.join("share/postgresql/extension"))
        .with_context(|| format!("create {}", extension_sql_dir.display()))?;
    if let Some(module_file) = &extension.module_file {
        fs::create_dir_all(stage.join("lib/postgresql"))
            .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
        copy_file(
            &build_dir.join(module_file),
            &stage.join("lib/postgresql").join(module_file),
        )?;
    }
    if extension.lifecycle.create_extension || extension.control_file.is_some() {
        let control_file = extension
            .control_file
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| source.join(format!("{sql_name}.control")));
        copy_file(
            &control_file,
            &stage
                .join("share/postgresql/extension")
                .join(control_file.file_name().unwrap_or_default()),
        )?;
    }
    let mut copied_root_sql = copy_extension_sql_files(&build_dir, sql_name, &extension_sql_dir)?;
    if !copied_root_sql {
        copied_root_sql = copy_extension_sql_files(source, sql_name, &extension_sql_dir)?;
    }
    if !copied_root_sql {
        let copied_build_sql_dir =
            copy_extension_sql_dir(&build_dir.join("sql"), &extension_sql_dir)?;
        if !copied_build_sql_dir {
            copy_extension_sql_dir(&source.join("sql"), &extension_sql_dir)?;
        }
    }
    if extension.id == "age" {
        let age_sql = extension_sql_dir.join("age--1.7.0.sql");
        let age_sql_text =
            fs::read_to_string(&age_sql).with_context(|| format!("read {}", age_sql.display()))?;
        ensure!(
            age_sql_text.contains("CREATE TYPE graphid"),
            "{} must contain AGE graphid type definition",
            age_sql.display()
        );
        ensure!(
            !age_sql_text
                .lines()
                .any(|line| line.trim() == "PASSEDBYVALUE,"),
            "{} still declares graphid PASSEDBYVALUE for wasm32/WASIX; rebuild AGE with SIZEOF_DATUM=4",
            age_sql.display()
        );
    }
    Ok(())
}

fn copy_extension_sql_files(source: &Path, sql_name: &str, destination: &Path) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    let mut copied = false;
    for entry in sorted_children(source)? {
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with(&format!("{sql_name}--")) || name == format!("{sql_name}.sql"))
            && name.ends_with(".sql")
        {
            copy_file(&entry, &destination.join(name))?;
            copied = true;
        }
    }
    Ok(copied)
}

fn copy_extension_sql_dir(source: &Path, destination: &Path) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    let mut copied = false;
    for entry in sorted_files(source)? {
        if entry.extension().and_then(|ext| ext.to_str()) != Some("sql") {
            continue;
        }
        let file_name = entry
            .file_name()
            .ok_or_else(|| anyhow!("SQL file has no name: {}", entry.display()))?;
        copy_file(&entry, &destination.join(file_name))?;
        copied = true;
    }
    Ok(copied)
}

fn stage_contrib_extension(
    source: &Path,
    build: &Path,
    extension: &extension_catalog::PromotedExtensionBuildSpec,
    stage: &Path,
) -> Result<()> {
    let contrib_dir = extension
        .contrib_dir
        .as_deref()
        .ok_or_else(|| anyhow!("contrib extension {} has no contrib_dir", extension.id))?;
    let extension_source = source.join("contrib").join(contrib_dir);
    fs::create_dir_all(stage.join("share/postgresql/extension")).with_context(|| {
        format!(
            "create {}",
            stage.join("share/postgresql/extension").display()
        )
    })?;
    if let Some(module_file) = &extension.module_file {
        fs::create_dir_all(stage.join("lib/postgresql"))
            .with_context(|| format!("create {}", stage.join("lib/postgresql").display()))?;
        copy_file(
            &build.join("contrib").join(contrib_dir).join(module_file),
            &stage.join("lib/postgresql").join(module_file),
        )?;
    }
    if extension.lifecycle.create_extension || extension.control_file.is_some() {
        let control_file = extension
            .control_file
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| extension_source.join(format!("{}.control", extension.sql_name)));
        copy_file(
            &control_file,
            &stage
                .join("share/postgresql/extension")
                .join(control_file.file_name().unwrap_or_default()),
        )?;
    }
    for entry in sorted_children(&extension_source)? {
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with(&format!("{}--", extension.sql_name))
            || name == format!("{}.sql", extension.sql_name))
            && name.ends_with(".sql")
        {
            copy_file(&entry, &stage.join("share/postgresql/extension").join(name))?;
        } else if name.ends_with(".rules") {
            let tsearch_data = stage.join("share/postgresql/tsearch_data");
            fs::create_dir_all(&tsearch_data)
                .with_context(|| format!("create {}", tsearch_data.display()))?;
            copy_file(&entry, &tsearch_data.join(name))?;
        }
    }
    Ok(())
}

fn stage_runtime_tree(outputs: &BuildOutputs, runtime: &Path) -> Result<()> {
    let build = &outputs.build_dir;
    let source = &outputs.source_dir;
    let bin = runtime.join("bin");
    let runtime_lib = runtime.join("lib");
    let lib = runtime.join("lib/postgresql");
    let share = runtime.join("share/postgresql");
    fs::create_dir_all(&bin).with_context(|| format!("create {}", bin.display()))?;
    fs::create_dir_all(&runtime_lib)
        .with_context(|| format!("create {}", runtime_lib.display()))?;
    fs::create_dir_all(&lib).with_context(|| format!("create {}", lib.display()))?;
    fs::create_dir_all(&share).with_context(|| format!("create {}", share.display()))?;

    if outputs.runtime_kind == RUNTIME_KIND_WASIX_POSTGRES_SERVER {
        copy_file(outputs.runtime_module_path()?, &bin.join("postgres"))?;
        for (source_path, destination) in [
            (build.join("src/bin/pg_ctl/pg_ctl"), bin.join("pg_ctl")),
            (build.join("src/bin/psql/psql"), bin.join("psql")),
            (
                build.join("src/bin/pg_config/pg_config"),
                bin.join("pg_config"),
            ),
        ] {
            if source_path.exists() {
                copy_file(&source_path, &destination)?;
            }
        }
        let libpq = build.join("src/interfaces/libpq/libpq.so.5.18");
        if libpq.exists() {
            copy_file(&libpq, &runtime_lib.join("libpq.so"))?;
            copy_file(&libpq, &runtime_lib.join("libpq.so.5"))?;
            copy_file(&libpq, &runtime_lib.join("libpq.so.5.18"))?;
        }
    } else {
        copy_file(outputs.runtime_module_path()?, &bin.join("pglite"))?;
        copy_file(outputs.runtime_module_path()?, &bin.join("postgres"))?;
    }
    copy_file(&build.join("src/bin/pg_dump/pg_dump"), &bin.join("pg_dump"))?;
    copy_file(&build.join("src/bin/initdb/initdb"), &bin.join("initdb"))?;
    fs::write(runtime.join("password"), b"password\n")
        .with_context(|| format!("write {}", runtime.join("password").display()))?;

    copy_file(
        &build.join("src/include/catalog/postgres.bki"),
        &share.join("postgres.bki"),
    )?;
    copy_file(
        &build.join("src/include/catalog/system_constraints.sql"),
        &share.join("system_constraints.sql"),
    )?;
    for relative in [
        "src/backend/catalog/system_functions.sql",
        "src/backend/catalog/system_views.sql",
        "src/backend/catalog/information_schema.sql",
        "src/backend/catalog/sql_features.txt",
        "src/backend/libpq/pg_hba.conf.sample",
        "src/backend/libpq/pg_ident.conf.sample",
        "src/backend/utils/misc/postgresql.conf.sample",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &share.join(file_name))?;
    }

    copy_file(
        &build.join("src/backend/snowball/snowball_create.sql"),
        &share.join("snowball_create.sql"),
    )?;
    copy_file(
        &build.join("src/backend/snowball/dict_snowball.so"),
        &lib.join("dict_snowball.so"),
    )?;
    copy_file(
        &build.join("src/pl/plpgsql/src/plpgsql.so"),
        &lib.join("plpgsql.so"),
    )?;

    let extension_dir = share.join("extension");
    fs::create_dir_all(&extension_dir)
        .with_context(|| format!("create {}", extension_dir.display()))?;
    for relative in [
        "src/pl/plpgsql/src/plpgsql.control",
        "src/pl/plpgsql/src/plpgsql--1.0.sql",
    ] {
        let source_path = source.join(relative);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("source file has no name: {}", source_path.display()))?;
        copy_file(&source_path, &extension_dir.join(file_name))?;
    }

    copy_tree_filtered(
        &source.join("src/backend/tsearch/dicts"),
        &share.join("tsearch_data"),
        None,
    )?;
    copy_tree_filtered(
        &source.join("src/timezone/tznames"),
        &share.join("timezonesets"),
        Some(&["Makefile", "meson.build", "README"]),
    )?;
    stage_timezone_database(source, build, &share)?;
    Ok(())
}

fn stage_timezone_database(source: &Path, build: &Path, share: &Path) -> Result<()> {
    let tzdata = source.join("src/timezone/data/tzdata.zi");
    ensure_file(&tzdata)?;
    let compiled_timezone_dir = build.join("src/timezone/compiled");

    let timezone_dir = share.join("timezone");
    if timezone_dir.exists() {
        fs::remove_dir_all(&timezone_dir)
            .with_context(|| format!("remove {}", timezone_dir.display()))?;
    }
    fs::create_dir_all(&timezone_dir)
        .with_context(|| format!("create {}", timezone_dir.display()))?;
    copy_tree_filtered(&compiled_timezone_dir, &timezone_dir, None).with_context(|| {
        format!(
            "copy compiled PostgreSQL timezone database from {}",
            compiled_timezone_dir.display()
        )
    })?;

    for required in ["UTC", "GMT", "Etc/UTC", "America/New_York"] {
        let path = timezone_dir.join(required);
        if !path.is_file() {
            bail!(
                "compiled PostgreSQL timezone database is missing required zone {}",
                path.display()
            );
        }
    }
    Ok(())
}

fn package_aot_artifacts(
    target: &str,
    outputs: &BuildOutputs,
    sources: &SourcesManifest,
) -> Result<()> {
    let source_dir = Path::new("assets/wasix-build/build/aot").join(target);
    if !source_dir.exists() {
        bail!(
            "AOT source directory {} is missing; run `cargo run -p xtask -- assets aot --target-triple {target}` before packaging",
            source_dir.display()
        );
    }

    let artifacts_dir = generated_aot_dir(target);
    if artifacts_dir.exists() {
        fs::remove_dir_all(&artifacts_dir)
            .with_context(|| format!("remove {}", artifacts_dir.display()))?;
    }
    fs::create_dir_all(&artifacts_dir)
        .with_context(|| format!("create {}", artifacts_dir.display()))?;

    let mut manifest_artifacts = Vec::new();
    for module in &outputs.modules {
        let name = module.name.as_str();
        let file = module.aot_file.as_str();
        let source = source_dir.join(file);
        if !source.exists() {
            bail!(
                "missing AOT artifact {}; run AOT generation for target {target} before packaging",
                source.display()
            );
        }
        let destination = artifacts_dir.join(file);
        copy_file(&source, &destination)?;
        let raw_artifact = decode_zstd_file(&destination)
            .with_context(|| format!("decode AOT artifact {}", destination.display()))?;
        let module_sha256 = outputs
            .modules
            .iter()
            .find(|module| module.name == name)
            .map(|module| sha256_file(&module.path))
            .transpose()?
            .ok_or_else(|| anyhow!("missing build output module {name} for AOT manifest"))?;
        manifest_artifacts.push(AotManifestArtifact {
            name: name.to_owned(),
            path: file.to_owned(),
            sha256: sha256_file(&destination)?,
            raw_sha256: sha256_bytes(&raw_artifact),
            raw_size: raw_artifact.len() as u64,
            module_sha256,
            compressed: true,
        });
    }
    ensure!(
        !manifest_artifacts.is_empty(),
        "AOT packaging produced an empty manifest for {target}"
    );

    let manifest = AotManifest {
        format_version: 1,
        target_triple: target.to_owned(),
        engine: "llvm-opta".to_owned(),
        wasmer_version: sources.toolchain.wasmer.clone(),
        wasmer_wasix_version: sources.toolchain.wasmer_wasix.clone(),
        artifacts: manifest_artifacts,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).context("serialize AOT manifest")?;
    fs::write(
        artifacts_dir.join("manifest.json"),
        format!("{manifest_json}\n"),
    )
    .with_context(|| format!("write {}", artifacts_dir.join("manifest.json").display()))?;
    Ok(())
}

fn check_aot_package_manifest(target: &str) -> Result<()> {
    let outputs = BuildOutputs::discover_for_aot()?;
    let artifacts_dir = find_aot_artifact_dir(target)?;
    let manifest_path = artifacts_dir.join("manifest.json");
    ensure_file(&manifest_path)?;
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    ensure_eq(
        &manifest.target_triple,
        target,
        "AOT manifest target-triple",
    )?;
    ensure_eq(&manifest.engine, "llvm-opta", "AOT manifest engine")?;
    ensure_eq(
        &manifest.wasmer_version,
        "7.2.0-alpha.2",
        "AOT manifest wasmer-version",
    )?;
    ensure_eq(
        &manifest.wasmer_wasix_version,
        "0.702.0-alpha.2",
        "AOT manifest wasmer-wasix-version",
    )?;
    ensure!(
        !manifest.artifacts.is_empty(),
        "AOT manifest {} contains no artifacts",
        manifest_path.display()
    );

    for artifact in &manifest.artifacts {
        let path = artifacts_dir.join(&artifact.path);
        ensure_file(&path)?;
        let actual_hash = sha256_file(&path)?;
        ensure_eq(
            &actual_hash,
            &artifact.sha256,
            &format!("AOT artifact {} sha256", artifact.name),
        )?;
        if artifact.compressed {
            let raw = decode_zstd_file(&path)
                .with_context(|| format!("decode AOT artifact {}", path.display()))?;
            ensure_eq(
                &sha256_bytes(&raw),
                &artifact.raw_sha256,
                &format!("AOT artifact {} raw sha256", artifact.name),
            )?;
            let actual_raw_size = raw.len() as u64;
            if actual_raw_size != artifact.raw_size {
                bail!(
                    "AOT artifact {} raw size mismatch: expected {} got {}",
                    artifact.name,
                    artifact.raw_size,
                    actual_raw_size
                );
            }
        }
        let module = outputs
            .modules
            .iter()
            .find(|module| module.name == artifact.name)
            .ok_or_else(|| anyhow!("AOT manifest references unknown module {}", artifact.name))?;
        let module_hash = sha256_file(&module.path)?;
        ensure_eq(
            &module_hash,
            &artifact.module_sha256,
            &format!("AOT artifact {} source module sha256", artifact.name),
        )?;
    }
    Ok(())
}

fn generated_aot_dir(target: &str) -> PathBuf {
    Path::new("target/pglite-oxide/aot").join(target)
}

fn crate_aot_artifact_dir(target: &str) -> PathBuf {
    Path::new("crates/aot").join(target).join("artifacts")
}

fn find_aot_artifact_dir(target: &str) -> Result<PathBuf> {
    let generated = generated_aot_dir(target);
    if generated.join("manifest.json").is_file() {
        return Ok(generated);
    }
    let crate_dir = crate_aot_artifact_dir(target);
    if crate_dir.join("manifest.json").is_file() {
        return Ok(crate_dir);
    }
    bail!(
        "missing AOT artifacts for {target}; expected {} or {}",
        generated.display(),
        crate_dir.display()
    )
}

fn write_asset_manifest(
    sources: &SourcesManifest,
    runtime_module: &Path,
    runtime_archive: &Path,
    runtime_kind: &str,
    runtime_module_path: &str,
    pg_dump: &Path,
    initdb: &Path,
    runtime_support: &[BinaryPackage<'_>],
    extensions: &[ExtensionPackage<'_>],
) -> Result<()> {
    let runtime_link = read_wasm_link_metadata(runtime_module)?;
    let runtime_exports = wasm_export_name_set(&runtime_link);
    let extension_metadata = extension_catalog::manifest_metadata_by_sql_name()?;
    let postgres_version = postgres_version_from_sources(sources)?;
    let manifest = AssetManifestOut {
        format_version: 1,
        runtime: RuntimeAssetOut {
            archive: "pglite.wasix.tar.zst".to_owned(),
            sha256: sha256_file(runtime_archive)?,
            module_sha256: sha256_file(runtime_module)?,
            postgres_version,
            runtime_kind: runtime_kind.to_owned(),
            module_path: runtime_module_path.to_owned(),
            link: runtime_link.clone(),
        },
        runtime_support: runtime_support
            .iter()
            .map(|module| {
                Ok(BinaryAssetOut {
                    name: module.name.to_owned(),
                    path: module.runtime_path.to_owned(),
                    sha256: sha256_file(module.path)?,
                    module_sha256: sha256_file(module.path)?,
                    size: fs::metadata(module.path)
                        .with_context(|| format!("metadata {}", module.path.display()))?
                        .len(),
                    link: read_wasm_link_metadata(module.path)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        pg_dump: Some(BinaryAssetOut {
            name: "pg_dump".to_owned(),
            path: "bin/pg_dump.wasix.wasm".to_owned(),
            sha256: sha256_file(pg_dump)?,
            module_sha256: sha256_file(pg_dump)?,
            size: fs::metadata(pg_dump)
                .with_context(|| format!("metadata {}", pg_dump.display()))?
                .len(),
            link: read_wasm_link_metadata(pg_dump)?,
        }),
        initdb: Some(BinaryAssetOut {
            name: "initdb".to_owned(),
            path: "bin/initdb.wasix.wasm".to_owned(),
            sha256: sha256_file(initdb)?,
            module_sha256: sha256_file(initdb)?,
            size: fs::metadata(initdb)
                .with_context(|| format!("metadata {}", initdb.display()))?
                .len(),
            link: read_wasm_link_metadata(initdb)?,
        }),
        pgdata_template: Some(pgdata_template_asset_out(
            sources,
            runtime_module,
            initdb,
            &Path::new(GENERATED_ASSETS_DIR).join("prepopulated/pgdata-template.tar.zst"),
            &Path::new(GENERATED_ASSETS_DIR).join("prepopulated/pgdata-template.json"),
        )?),
        extensions: extensions
            .iter()
            .map(|extension| {
                let link = extension
                    .module_path
                    .map(read_wasm_link_metadata)
                    .transpose()?;
                let metadata = extension_metadata.get(extension.sql_name).ok_or_else(|| {
                    anyhow!(
                        "extension {} is missing from generated extension catalog",
                        extension.sql_name
                    )
                })?;
                let mut core_exports_required = Vec::new();
                let mut unresolved_imports = Vec::new();
                if let Some(link) = &link {
                    for import in &link.imports {
                        if !import_should_resolve_from_runtime(import) {
                            continue;
                        }
                        let normalized = import.name.trim_start_matches('_');
                        if runtime_exports.contains(import.name.as_str()) {
                            core_exports_required.push(import.name.clone());
                        } else if runtime_exports.contains(normalized) {
                            core_exports_required.push(normalized.to_owned());
                        } else {
                            unresolved_imports.push(import.clone());
                        }
                    }
                }
                core_exports_required.sort();
                core_exports_required.dedup();
                Ok(ExtensionAssetOut {
                    name: extension.name.to_owned(),
                    sql_name: extension.sql_name.to_owned(),
                    source_kind: metadata.source_kind.clone(),
                    archive: extension.archive.to_owned(),
                    sha256: sha256_file(extension.path)?,
                    module_sha256: extension
                        .module_path
                        .map(sha256_file)
                        .transpose()?
                        .unwrap_or_default(),
                    native_module: extension.native_module.map(str::to_owned),
                    size: fs::metadata(extension.path)
                        .with_context(|| format!("metadata {}", extension.path.display()))?
                        .len(),
                    stable: extension.stable,
                    control_files: metadata.control_files.clone(),
                    dependencies: metadata.dependencies.clone(),
                    native_dependencies: metadata.native_dependencies.clone(),
                    load_order: metadata.load_order.clone(),
                    lifecycle: ExtensionLifecycleOut {
                        create_extension: metadata.lifecycle.create_extension,
                        create_schema: metadata.lifecycle.create_schema.clone(),
                        load_sql: metadata.lifecycle.load_sql.clone(),
                        post_create_sql: metadata.lifecycle.post_create_sql.clone(),
                        startup_config: metadata.lifecycle.startup_config.clone(),
                        preload_required: metadata.lifecycle.preload_required,
                        restart_required: metadata.lifecycle.restart_required,
                        shared_memory_required: metadata.lifecycle.shared_memory_required,
                    },
                    extension_imports: link
                        .as_ref()
                        .map(|link| link.imports.clone())
                        .unwrap_or_default(),
                    core_exports_required,
                    unresolved_imports,
                    installed_files: archive_file_list(extension.path)?,
                    smoke_status: ExtensionSmokeStatusOut {
                        promoted: metadata.smoke_status.promoted,
                        direct: metadata.smoke_status.direct.clone(),
                        server: metadata.smoke_status.server.clone(),
                        restart: metadata.smoke_status.restart.clone(),
                        dump_restore: metadata.smoke_status.dump_restore.clone(),
                    },
                    link,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        sources: sources.sources.clone(),
    };

    let text = serde_json::to_string_pretty(&manifest).context("serialize asset manifest")?;
    let manifest_path = Path::new(GENERATED_ASSETS_DIR).join("manifest.json");
    fs::write(&manifest_path, format!("{text}\n"))
        .with_context(|| format!("write {}", manifest_path.display()))?;
    Ok(())
}

fn pgdata_template_asset_out(
    sources: &SourcesManifest,
    runtime_module: &Path,
    initdb_module: &Path,
    archive: &Path,
    manifest: &Path,
) -> Result<PgDataTemplateAssetOut> {
    ensure_file(archive)?;
    ensure_file(manifest)?;
    let manifest_text =
        fs::read_to_string(manifest).with_context(|| format!("read {}", manifest.display()))?;
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest_text)
        .with_context(|| format!("parse {}", manifest.display()))?;
    let postgres_version = manifest_json_string(&manifest_json, "postgresVersion")
        .with_context(|| format!("read postgresVersion from {}", manifest.display()))?;
    Ok(PgDataTemplateAssetOut {
        archive: "prepopulated/pgdata-template.tar.zst".to_owned(),
        manifest: "prepopulated/pgdata-template.json".to_owned(),
        sha256: sha256_file(archive)?,
        size: fs::metadata(archive)
            .with_context(|| format!("metadata {}", archive.display()))?
            .len(),
        runtime_module_sha256: sha256_file(runtime_module)?,
        initdb_module_sha256: sha256_file(initdb_module)?,
        source_pins_sha256: source_pins_sha256(sources)?,
        postgres_version,
        catalog_version: manifest_json
            .get("catalogVersion")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        init_profile: default_initdb_profile().to_owned(),
        wasmer_version: sources.toolchain.wasmer.clone(),
    })
}

fn source_pins_sha256(sources: &SourcesManifest) -> Result<String> {
    let pins = serde_json::to_vec(&sources.sources).context("serialize source pins")?;
    Ok(sha256_bytes(&pins))
}

fn read_pgdata_postgres_version(pgdata: &Path) -> Result<String> {
    let path = pgdata.join("PG_VERSION");
    let version = fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?
        .trim()
        .to_owned();
    ensure!(
        !version.is_empty(),
        "{} must contain a PostgreSQL version",
        path.display()
    );
    Ok(version)
}

fn postgres_version_from_sources(sources: &SourcesManifest) -> Result<String> {
    let source = source_by_name(sources, POSTGRES_PGLITE_SOURCE)?;
    postgres_version_from_pglite_branch(&source.branch).ok_or_else(|| {
        anyhow!(
            "could not derive PostgreSQL version from {} branch '{}'",
            POSTGRES_PGLITE_SOURCE,
            source.branch
        )
    })
}

fn postgres_major_version_from_sources(sources: &SourcesManifest) -> Result<String> {
    let version = postgres_version_from_sources(sources)?;
    version
        .split('.')
        .next()
        .filter(|major| !major.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("PostgreSQL version '{version}' has no major component"))
}

fn postgres_version_from_pglite_branch(branch: &str) -> Option<String> {
    let rest = branch.strip_prefix("REL_")?;
    let raw_version = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '_')
        .collect::<String>();
    let parts = raw_version
        .trim_matches('_')
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty()
        || !parts
            .iter()
            .all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return None;
    }
    Some(parts.join("."))
}

fn manifest_json_string(manifest: &serde_json::Value, key: &str) -> Result<String> {
    manifest
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("manifest is missing string field {key}"))
}

fn postgres_catalog_version(source_dir: &Path) -> Result<String> {
    let path = source_dir.join("src/include/catalog/catversion.h");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#define CATALOG_VERSION_NO") {
            let value = rest.trim();
            if !value.is_empty() {
                return Ok(value.to_owned());
            }
        }
    }
    bail!("{} does not define CATALOG_VERSION_NO", path.display())
}

fn update_staged_root_asset_metadata(workspace: &Path) -> Result<()> {
    let asset_dir = workspace.join(GENERATED_ASSETS_DIR);
    let manifest = read_asset_manifest_from(&asset_dir)?;
    let runtime_archive = asset_dir.join(&manifest.runtime.archive);
    let runtime_module = archive_entry_bytes(
        &runtime_archive,
        &format!("pglite/{}", manifest.runtime.module_path),
    )?;
    update_root_asset_metadata_in(
        workspace,
        &asset_dir,
        &manifest,
        &sha256_bytes(&runtime_module),
    )
}

fn update_root_asset_metadata_in(
    workspace: &Path,
    asset_dir: &Path,
    manifest: &AssetManifestOut,
    runtime_module_sha256: &str,
) -> Result<()> {
    let path = workspace.join("crates/pglite-oxide/Cargo.toml");
    let mut text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    text = replace_metadata_value(text, "postgres-version", &manifest.runtime.postgres_version);
    if let Some(postgres_source) = manifest
        .sources
        .iter()
        .find(|source| source.name == POSTGRES_PGLITE_SOURCE)
    {
        text = replace_metadata_value(text, "postgres-pglite-branch", &postgres_source.branch);
    }
    text = replace_metadata_value(text, "runtime-archive-sha256", &manifest.runtime.sha256);
    text = replace_metadata_value(text, "pglite-wasix-sha256", runtime_module_sha256);
    let pgdata_template = asset_dir.join("prepopulated/pgdata-template.tar.zst");
    if pgdata_template.exists() {
        text = replace_metadata_value(
            text,
            "pgdata-template-archive-sha256",
            &sha256_file(&pgdata_template)?,
        );
    }
    if let Some(pg_dump) = &manifest.pg_dump {
        text = replace_metadata_value(text, "pg-dump-wasix-sha256", &pg_dump.sha256);
    }
    if let Some(initdb) = &manifest.initdb {
        text = replace_metadata_value(text, "initdb-wasix-sha256", &initdb.sha256);
    }
    fs::write(&path, text).with_context(|| format!("write {}", path.display()))
}

fn replace_metadata_value(mut text: String, key: &str, value: &str) -> String {
    let needle = format!("{key} = \"");
    let Some(start) = text.find(&needle) else {
        eprintln!("warning: Cargo.toml metadata key '{key}' is missing; not updating it");
        return text;
    };
    let value_start = start + needle.len();
    let Some(relative_end) = text[value_start..].find('"') else {
        return text;
    };
    text.replace_range(value_start..value_start + relative_end, value);
    text
}

fn deterministic_tar_zst(source_root: &Path, archive_root: &Path, output: &Path) -> Result<()> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    let encoder =
        ZstdEncoder::new(file, 19).with_context(|| format!("create zstd {}", output.display()))?;
    let mut builder = tar::Builder::new(encoder);
    append_tree(&mut builder, source_root, source_root, archive_root)?;
    let encoder = builder.into_inner().context("finish tar stream")?;
    encoder
        .finish()
        .with_context(|| format!("finish {}", output.display()))?;
    Ok(())
}

fn archive_file_list(path: &Path) -> Result<Vec<String>> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let raw = if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        let mut decoder = zstd::stream::read::Decoder::new(std::io::Cursor::new(bytes))
            .with_context(|| format!("create zstd decoder for {}", path.display()))?;
        let mut raw = Vec::new();
        io::copy(&mut decoder, &mut raw)
            .with_context(|| format!("decompress {}", path.display()))?;
        raw
    } else {
        bytes
    };
    let mut archive = tar::Archive::new(std::io::Cursor::new(raw));
    let mut files = Vec::new();
    for entry in archive
        .entries()
        .with_context(|| format!("read tar entries from {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("read tar entry from {}", path.display()))?;
        if entry.header().entry_type().is_file() {
            files.push(
                entry
                    .path()
                    .with_context(|| format!("read tar path from {}", path.display()))?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    files.sort();
    Ok(files)
}

fn append_tree<W: io::Write>(
    builder: &mut tar::Builder<W>,
    root: &Path,
    current: &Path,
    archive_root: &Path,
) -> Result<()> {
    let relative = current
        .strip_prefix(root)
        .with_context(|| format!("strip {} from {}", root.display(), current.display()))?;
    let archive_path = if relative.as_os_str().is_empty() {
        archive_root.to_path_buf()
    } else {
        archive_root.join(relative)
    };

    if !archive_path.as_os_str().is_empty() {
        let mut header = tar::Header::new_gnu();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_username("root").ok();
        header.set_groupname("root").ok();
        if current.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, io::empty())
                .with_context(|| format!("append directory {}", archive_path.display()))?;
        } else if current.is_file() {
            let bytes = fs::read(current).with_context(|| format!("read {}", current.display()))?;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(if is_executable(current) { 0o755 } else { 0o644 });
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, bytes.as_slice())
                .with_context(|| format!("append file {}", archive_path.display()))?;
        }
    }

    if current.is_dir() {
        for child in sorted_children(current)? {
            append_tree(builder, root, &child, archive_root)?;
        }
    }
    Ok(())
}

fn copy_tree_filtered(
    source: &Path,
    destination: &Path,
    skip_names: Option<&[&str]>,
) -> Result<()> {
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in sorted_files(source)? {
        let relative = entry
            .strip_prefix(source)
            .with_context(|| format!("strip {} from {}", source.display(), entry.display()))?;
        if let Some(file_name) = relative.file_name().and_then(|name| name.to_str())
            && skip_names
                .map(|names| names.contains(&file_name))
                .unwrap_or(false)
        {
            continue;
        }
        copy_file(&entry, &destination.join(relative))?;
    }
    Ok(())
}

fn sorted_children(path: &Path) -> Result<Vec<PathBuf>> {
    let mut children = fs::read_dir(path)
        .with_context(|| format!("read directory {}", path.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("read child in {}", path.display()))?;
    children.sort();
    Ok(children)
}

fn sorted_files(path: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.with_context(|| format!("walk {}", path.display()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    ensure_file(source)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::copy(source, destination)
        .with_context(|| format!("copy {} -> {}", source.display(), destination.display()))?;
    Ok(())
}

fn copy_dir_all(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("remove {}", destination.display()))?;
    }
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in WalkDir::new(source) {
        let entry = entry.with_context(|| format!("walk {}", source.display()))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(source)
            .with_context(|| format!("strip {} from {}", source.display(), path.display()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&output).with_context(|| format!("create {}", output.display()))?;
        } else if entry.file_type().is_file() {
            copy_file(path, &output)?;
        }
    }
    Ok(())
}

fn ensure_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!("expected file missing: {}", path.display());
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(sha256_bytes(&bytes))
}

fn decode_zstd_file(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", path.display()))?;
    let mut raw = Vec::new();
    io::copy(&mut decoder, &mut raw).with_context(|| format!("decompress {}", path.display()))?;
    Ok(raw)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn read_wasm_link_metadata(path: &Path) -> Result<WasmLinkMetadataOut> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut metadata = WasmLinkMetadataOut {
        has_dylink0: false,
        dylink_needed: Vec::new(),
        dylink_runtime_paths: Vec::new(),
        dylink_memory: None,
        dylink_imports: Vec::new(),
        dylink_exports: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        memories: Vec::new(),
    };

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.with_context(|| format!("parse {}", path.display()))? {
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import =
                        import.with_context(|| format!("read import from {}", path.display()))?;
                    metadata.imports.push(WasmImportOut {
                        module: import.module.to_owned(),
                        name: import.name.to_owned(),
                        kind: type_ref_kind(import.ty).to_owned(),
                    });
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export =
                        export.with_context(|| format!("read export from {}", path.display()))?;
                    metadata.exports.push(WasmExportOut {
                        name: export.name.to_owned(),
                        kind: external_kind_name(export.kind).to_owned(),
                    });
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory =
                        memory.with_context(|| format!("read memory from {}", path.display()))?;
                    metadata.memories.push(wasm_memory_out(memory));
                }
            }
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                metadata.has_dylink0 = true;
                let KnownCustom::Dylink0(reader) = section.as_known() else {
                    bail!("{} contains an unreadable dylink.0 section", path.display());
                };
                for subsection in reader {
                    match subsection
                        .with_context(|| format!("read dylink.0 from {}", path.display()))?
                    {
                        Dylink0Subsection::MemInfo(info) => {
                            metadata.dylink_memory = Some(WasmDylinkMemoryOut {
                                memory_size: info.memory_size,
                                memory_alignment: info.memory_alignment,
                                table_size: info.table_size,
                                table_alignment: info.table_alignment,
                            });
                        }
                        Dylink0Subsection::Needed(needed) => {
                            metadata
                                .dylink_needed
                                .extend(needed.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::RuntimePath(paths) => {
                            metadata
                                .dylink_runtime_paths
                                .extend(paths.into_iter().map(str::to_owned));
                        }
                        Dylink0Subsection::ImportInfo(imports) => {
                            metadata
                                .dylink_imports
                                .extend(imports.into_iter().map(|import| WasmDylinkSymbolOut {
                                    module: Some(import.module.to_owned()),
                                    name: import.field.to_owned(),
                                    flags: import.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::ExportInfo(exports) => {
                            metadata
                                .dylink_exports
                                .extend(exports.into_iter().map(|export| WasmDylinkSymbolOut {
                                    module: None,
                                    name: export.name.to_owned(),
                                    flags: export.flags.bits(),
                                }));
                        }
                        Dylink0Subsection::Unknown { .. } => {}
                    }
                }
            }
            _ => {}
        }
    }

    metadata.dylink_needed.sort();
    metadata.dylink_needed.dedup();
    metadata.dylink_runtime_paths.sort();
    metadata.dylink_runtime_paths.dedup();
    metadata.dylink_imports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.dylink_exports.sort_by(|left, right| {
        (left.module.as_deref(), left.name.as_str(), left.flags).cmp(&(
            right.module.as_deref(),
            right.name.as_str(),
            right.flags,
        ))
    });
    metadata.imports.sort_by(|left, right| {
        (left.module.as_str(), left.name.as_str(), left.kind.as_str()).cmp(&(
            right.module.as_str(),
            right.name.as_str(),
            right.kind.as_str(),
        ))
    });
    metadata.exports.sort_by(|left, right| {
        (left.name.as_str(), left.kind.as_str()).cmp(&(right.name.as_str(), right.kind.as_str()))
    });
    metadata.memories.sort_by(|left, right| {
        (
            left.initial_pages,
            left.maximum_pages,
            left.memory64,
            left.shared,
            left.page_size_log2,
        )
            .cmp(&(
                right.initial_pages,
                right.maximum_pages,
                right.memory64,
                right.shared,
                right.page_size_log2,
            ))
    });

    Ok(metadata)
}

fn type_ref_kind(ty: TypeRef) -> &'static str {
    match ty {
        TypeRef::Func(_) | TypeRef::FuncExact(_) => "func",
        TypeRef::Table(_) => "table",
        TypeRef::Memory(_) => "memory",
        TypeRef::Global(_) => "global",
        TypeRef::Tag(_) => "tag",
    }
}

fn external_kind_name(kind: ExternalKind) -> &'static str {
    match kind {
        ExternalKind::Func | ExternalKind::FuncExact => "func",
        ExternalKind::Table => "table",
        ExternalKind::Memory => "memory",
        ExternalKind::Global => "global",
        ExternalKind::Tag => "tag",
    }
}

fn wasm_memory_out(memory: wasmparser::MemoryType) -> WasmMemoryOut {
    WasmMemoryOut {
        initial_pages: memory.initial,
        maximum_pages: memory.maximum,
        memory64: memory.memory64,
        shared: memory.shared,
        page_size_log2: memory.page_size_log2,
    }
}

fn host_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unsupported"
}

fn source_by_name<'a>(manifest: &'a SourcesManifest, name: &str) -> Result<&'a SourcePin> {
    manifest
        .sources
        .iter()
        .find(|source| source.name == name)
        .ok_or_else(|| anyhow!("assets/sources.toml is missing source '{name}'"))
}

fn ensure_eq(actual: &str, expected: &str, field: &str) -> Result<()> {
    if actual != expected {
        bail!("{field} must be '{expected}', got '{actual}'");
    }
    Ok(())
}

fn ensure_contains(values: &[String], expected: &str, field: &str) -> Result<()> {
    if !values.iter().any(|value| value == expected) {
        bail!("{field} must contain '{expected}'");
    }
    Ok(())
}

fn ensure_no_flag_contains(values: &[String], forbidden: &str, field: &str) -> Result<()> {
    let forbidden_lower = forbidden.to_ascii_lowercase();
    if let Some(value) = values
        .iter()
        .find(|value| value.to_ascii_lowercase().contains(&forbidden_lower))
    {
        bail!("{field} must not contain '{forbidden}', got '{value}'");
    }
    Ok(())
}

fn command_output(command: &str, args: &[&str], cwd: &Path) -> Result<String> {
    let output = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stderr(Stdio::inherit())
        .output()
        .map_err(|err| anyhow!("failed to spawn {command}: {err}"))?;
    if !output.status.success() {
        bail!("{command} {} failed with {}", args.join(" "), output.status);
    }
    String::from_utf8(output.stdout).context("command output was not valid UTF-8")
}

fn now_micros() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX_EPOCH")?
        .as_micros())
}

fn value_after<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn run(command: &str, args: &[&str]) -> Result<()> {
    let mut command = command_for_host(command);
    command.args(args);
    run_command(&mut command)
}

fn run_validate_script(mode: &str) -> Result<()> {
    let xtask = env::current_exe().context("resolve current xtask executable")?;
    let mut command = command_for_host("tools/scripts/validate.sh");
    command.arg(mode).env(VALIDATE_XTASK_ENV, xtask);
    run_command(&mut command)
}

fn command_for_host(command: &str) -> Command {
    if cfg!(windows)
        && Path::new(command)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sh"))
    {
        let mut shell = Command::new(windows_bash_path());
        shell.arg("--noprofile").arg("--norc");
        shell.arg(command);
        return shell;
    }
    Command::new(command)
}

#[cfg(windows)]
fn windows_bash_path() -> PathBuf {
    for path in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from("bash")
}

#[cfg(not(windows))]
fn windows_bash_path() -> &'static str {
    "bash"
}

fn run_command(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .map_err(|err| anyhow!("failed to spawn command: {err}"))?;
    if !status.success() {
        bail!("command failed with {status}");
    }
    Ok(())
}

fn print_usage() {
    eprintln!("usage:");
    eprintln!("  cargo run -p xtask -- assets check [--strict-local] [--strict-generated]");
    eprintln!("  cargo run -p xtask -- assets verify-committed");
    eprintln!("  cargo run -p xtask -- assets audit-upstream [--strict]");
    eprintln!("  cargo run -p xtask -- assets source-spine [--check-patch-applies]");
    eprintln!("  cargo run -p xtask -- assets fetch");
    eprintln!("  cargo run -p xtask --features aot-serializer -- assets build-host");
    eprintln!("  cargo run -p xtask -- assets download --sha <sha> --target-triple <triple>");
    eprintln!("  cargo run -p xtask -- assets download --run-id <id> --all-targets");
    eprintln!(
        "  cargo run -p xtask -- assets download --latest-compatible --target-triple <triple>"
    );
    eprintln!("  cargo run -p xtask -- assets download --release <tag> --target-triple <triple>");
    eprintln!("  cargo run -p xtask -- assets install-local --target-triple <triple>");
    eprintln!("  cargo run -p xtask -- assets ci-matrix [--target <all|triple>] [--github-output]");
    eprintln!("  cargo run -p xtask -- assets ci-artifacts");
    eprintln!("  cargo run -p xtask -- assets aot-targets");
    eprintln!("  cargo run -p xtask -- assets internal-packages");
    eprintln!("  cargo run -p xtask -- assets input-fingerprint [--write] [--explain]");
    eprintln!(
        "  cargo run -p xtask -- assets build --profile release-o3 --target-triple <triple> [--execute]"
    );
    eprintln!("  cargo run -p xtask --features template-runner -- assets template");
    eprintln!(
        "  cargo run -p xtask --features template-runner -- assets release-build --profile release-o3 --target-triple <triple> [--fetch]"
    );
    eprintln!("  cargo run -p xtask -- assets aot --target-triple <triple>");
    eprintln!(
        "  cargo run -p xtask --features aot-serializer -- assets package [--target-triple <triple>]"
    );
    eprintln!("  cargo run -p xtask -- assets export-list [--write]");
    eprintln!("  cargo run -p xtask -- assets smoke");
    eprintln!("  cargo run -p xtask -- release stage");
    eprintln!("  cargo run -p xtask -- release package-assets");
    eprintln!("  cargo run -p xtask -- release dry-run");
    eprintln!("  cargo run -p xtask -- release publish");
    eprintln!("  cargo run -p xtask -- extensions discover [--write]");
    eprintln!("  cargo run -p xtask -- extensions build-plan [--write|--check]");
    eprintln!("  cargo run -p xtask -- extensions generate");
    eprintln!("  cargo run -p xtask -- extensions check");
    eprintln!("  cargo run -p xtask -- package-size --enforce");
    eprintln!("  cargo run -p xtask -- perf cold [--reset-cache]");
    eprintln!("  cargo run -p xtask -- perf warm [--iterations N] [--connections N]");
    eprintln!(
        "  cargo run -p xtask -- perf bench [--suite all|rtt|speed] [--mode all|direct|server-sqlx|server-tokio-postgres-simple] [--iterations N] [--scale N]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf prepared-inserts [--ids literal_transaction_batch,single_statement_values,server_prepare_execute_batch,sqlx_prepared_transaction] [--rows N] [--samples N] [--max-load-per-cpu N] [--max-top-cpu-percent N] [--max-sample-attempts N] [--max-sample-spread-ratio N|off; default 1.15] [--load-gate-wait-ms N] [--load-gate-poll-ms N] [--skip-native] [--profile] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf prepared-updates [--rows N] [--passes N] [--samples N] [--max-load-per-cpu N] [--max-top-cpu-percent N] [--max-sample-attempts N] [--max-sample-spread-ratio N|off; default 1.15] [--load-gate-wait-ms N] [--load-gate-poll-ms N] [--only-sqlx] [--skip-native] [--gate] [--profile] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf prepared-reads [--ids param_echo,indexed_range_select,indexed_range_server_prepare_batch] [--client-modes sqlx,tokio-sequential,tokio-pipelined|tokio|all] [--only-sqlx|--only-tokio|--only-tokio-sequential|--only-tokio-pipelined] [--reads N] [--passes N] [--samples N] [--max-load-per-cpu N] [--max-top-cpu-percent N] [--max-sample-attempts N] [--max-sample-spread-ratio N|off; default 1.15] [--load-gate-wait-ms N] [--load-gate-poll-ms N] [--skip-native] [--profile] [--profile-dir DIR] [--profile-seconds N] [--profile-delay-ms N] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--wasix-perf-stats] [--wasix-perf-stats-log PATH] [--wasix-perf-stats-summary-prefix PATH] [--wasix-perf-stats-bin PATH] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf native-postgres [--suite all|rtt|speed] [--client tokio-postgres-simple|sqlx]"
    );
    eprintln!("  cargo run -p xtask -- perf native-postgres-open");
    eprintln!(
        "  cargo run -p xtask -- perf native-libpglite --suite rtt|speed|prepared-updates [--iterations N] [--rows N]"
    );
    eprintln!("  cargo run -p xtask -- perf native-libpglite-open");
    eprintln!("  cargo run -p xtask -- perf native-libpglite-sdk [--iterations N]");
    eprintln!("  cargo run -p xtask -- perf pglite-server-open");
    eprintln!(
        "  cargo run -p xtask -- perf pglite-nodefs-sqlx --database-url URL --open-micros N [--suite all|rtt|speed]"
    );
    eprintln!("  cargo run -p xtask -- perf diagnose-speed-hotspots");
    eprintln!(
        "  cargo run -p xtask -- perf diagnose-speed-cases [--ids=1,6,12,16] [--engine wasix|server-sqlx|server-tokio-postgres-simple|native-libpglite|native-postgres|native-postgres-sqlx] [--samples N] [--max-load-per-cpu N] [--max-top-cpu-percent N] [--load-gate-wait-ms N] [--load-gate-poll-ms N] [--target-repeats N] [--target-repeat-mode same-sql|fresh-sql] [--sample-server PATH] [--sample-seconds N] [--speed-source generated|pglite] [--postgres-config name=value] [--server-postgres-config name=value] [--native-postgres-config name=value] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf diagnose-speed-parity [--ids=1,2,9] [--samples N] [--max-load-per-cpu N] [--max-top-cpu-percent N] [--load-gate-wait-ms N] [--load-gate-poll-ms N] [--target-repeats N] [--target-repeat-mode same-sql|fresh-sql] [--speed-source generated|pglite] [--config-set default|sync-off|full-page-writes-off|wal-relaxed|fsync-off|wal-minimal] [--all-config-sets] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--all-runtime-sets] [--postgres-config name=value] [--server-postgres-config name=value] [--native-postgres-config name=value] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf diagnose-select-shapes [--shapes id,id] [--count N] [--samples N] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--postgres-config name=value] [--server-postgres-config name=value] [--native-postgres-config name=value] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf diagnose-select-shape-profile-compare [--shapes id,id] [--count N] [--target-repeats N] [--sample-seconds N] [--sample-delay-ms N] [--output-dir DIR] [--function-map PATH] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--postgres-config name=value] [--server-postgres-config name=value] [--native-postgres-config name=value] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!(
        "  cargo run -p xtask -- perf diagnose-speed-profile-compare [--ids=10] [--target-repeats N] [--target-repeat-mode same-sql|fresh-sql] [--sample-seconds N] [--sample-delay-ms N] [--output-dir DIR] [--function-map PATH] [--runtime-set default|portable|native-cpu|full-o3|indirect-call-cache|async-threads-on|async-threads-off|no-tty|native-cpu-icc|full-o3-icc|all-flags] [--postgres-config name=value] [--server-postgres-config name=value] [--native-postgres-config name=value] [--btree-deduplicate-items off|on|default] [--t2-index-shape full|lookup-only]"
    );
    eprintln!("  cargo run -p xtask -- perf smoke");
}

#[derive(Debug, Deserialize)]
struct SourcesManifest {
    toolchain: Toolchain,
    build: BuildConfig,
    sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
struct GeneratedAssetManifest {
    #[serde(default)]
    runtime: Option<GeneratedRuntimeAssetManifest>,
    #[serde(default)]
    sources: Vec<SourcePin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct GeneratedRuntimeAssetManifest {
    #[serde(default)]
    postgres_version: String,
}

#[derive(Debug, Deserialize)]
struct Toolchain {
    wasmer: String,
    #[serde(rename = "wasmer-wasix")]
    wasmer_wasix: String,
    #[allow(dead_code)]
    wasixcc: String,
    #[allow(dead_code)]
    llvm: String,
    #[allow(dead_code)]
    docker_image: String,
    #[allow(dead_code)]
    docker_image_digest: String,
}

#[derive(Debug, Deserialize)]
struct BuildConfig {
    postgres_prefix: String,
    postgres_pkglibdir: String,
    postgres_sharedir: String,
    main_flags: Vec<String>,
    extension_flags: Vec<String>,
    archive_format: String,
    deterministic_archives: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct SourcePin {
    name: String,
    url: String,
    branch: String,
    commit: String,
}

struct ExtensionPackage<'a> {
    name: &'a str,
    sql_name: &'a str,
    archive: &'a str,
    path: &'a Path,
    module_path: Option<&'a Path>,
    native_module: Option<&'a str>,
    stable: bool,
}

struct OwnedExtensionPackage {
    name: String,
    sql_name: String,
    archive: String,
    path: PathBuf,
    module_path: Option<PathBuf>,
    native_module: Option<String>,
    stable: bool,
}

struct BinaryPackage<'a> {
    name: &'a str,
    path: &'a Path,
    runtime_path: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BuildOutputManifestOut {
    format_version: u32,
    build_profile: String,
    modules: Vec<BuildModuleManifestOut>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BuildModuleManifestOut {
    name: String,
    kind: String,
    path: String,
    sha256: String,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AssetManifestOut {
    format_version: u32,
    runtime: RuntimeAssetOut,
    runtime_support: Vec<BinaryAssetOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pg_dump: Option<BinaryAssetOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initdb: Option<BinaryAssetOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pgdata_template: Option<PgDataTemplateAssetOut>,
    extensions: Vec<ExtensionAssetOut>,
    sources: Vec<SourcePin>,
}

fn default_runtime_module_path() -> String {
    "bin/pglite".to_owned()
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct RuntimeAssetOut {
    archive: String,
    sha256: String,
    module_sha256: String,
    postgres_version: String,
    runtime_kind: String,
    #[serde(default = "default_runtime_module_path")]
    module_path: String,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct BinaryAssetOut {
    name: String,
    path: String,
    sha256: String,
    module_sha256: String,
    size: u64,
    link: WasmLinkMetadataOut,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct PgDataTemplateAssetOut {
    archive: String,
    manifest: String,
    sha256: String,
    size: u64,
    runtime_module_sha256: String,
    initdb_module_sha256: String,
    source_pins_sha256: String,
    postgres_version: String,
    catalog_version: String,
    init_profile: String,
    wasmer_version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ExtensionAssetOut {
    name: String,
    sql_name: String,
    source_kind: String,
    archive: String,
    sha256: String,
    module_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_module: Option<String>,
    size: u64,
    stable: bool,
    control_files: Vec<String>,
    dependencies: Vec<String>,
    native_dependencies: Vec<String>,
    load_order: Vec<String>,
    lifecycle: ExtensionLifecycleOut,
    extension_imports: Vec<WasmImportOut>,
    core_exports_required: Vec<String>,
    unresolved_imports: Vec<WasmImportOut>,
    installed_files: Vec<String>,
    smoke_status: ExtensionSmokeStatusOut,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<WasmLinkMetadataOut>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ExtensionLifecycleOut {
    create_extension: bool,
    create_schema: Option<String>,
    load_sql: Vec<String>,
    post_create_sql: Vec<String>,
    startup_config: Vec<String>,
    preload_required: bool,
    restart_required: bool,
    shared_memory_required: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ExtensionSmokeStatusOut {
    promoted: bool,
    direct: String,
    server: String,
    restart: String,
    dump_restore: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmLinkMetadataOut {
    has_dylink0: bool,
    dylink_needed: Vec<String>,
    dylink_runtime_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dylink_memory: Option<WasmDylinkMemoryOut>,
    dylink_imports: Vec<WasmDylinkSymbolOut>,
    dylink_exports: Vec<WasmDylinkSymbolOut>,
    imports: Vec<WasmImportOut>,
    exports: Vec<WasmExportOut>,
    memories: Vec<WasmMemoryOut>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmDylinkMemoryOut {
    memory_size: u32,
    memory_alignment: u32,
    table_size: u32,
    table_alignment: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmDylinkSymbolOut {
    module: Option<String>,
    name: String,
    flags: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmImportOut {
    module: String,
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmExportOut {
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
struct WasmMemoryOut {
    initial_pages: u64,
    maximum_pages: Option<u64>,
    memory64: bool,
    shared: bool,
    page_size_log2: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifest {
    format_version: u32,
    target_triple: String,
    engine: String,
    wasmer_version: String,
    wasmer_wasix_version: String,
    artifacts: Vec<AotManifestArtifact>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifestArtifact {
    name: String,
    path: String,
    sha256: String,
    raw_sha256: String,
    raw_size: u64,
    module_sha256: String,
    compressed: bool,
}

struct UpstreamAuditItem {
    id: &'static str,
    commit: &'static str,
    description: &'static str,
    required: bool,
}

const UPSTREAM_AUDIT: &[UpstreamAuditItem] = &[
    UpstreamAuditItem {
        id: "stable-foundation",
        commit: "01792c31a62b7045eb22e93d7dad022bb64b1184",
        description: "REL_17_5-pglite pinned source used by @electric-sql/pglite 0.4.5",
        required: true,
    },
    UpstreamAuditItem {
        id: "builder-age",
        commit: "c7c530a",
        description: "builder branch AGE extension source and packaging reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "builder-pgdump",
        commit: "f5f1005",
        description: "builder branch backend pg_dump work reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "builder-pgcrypto",
        commit: "bee4a36",
        description: "builder branch pgcrypto backend work reference",
        required: false,
    },
    UpstreamAuditItem {
        id: "stable-protocol-exports",
        commit: "a58ae720b72b0a350babe4e22652467253217e11",
        description: "stable branch PGlite protocol exports and startup HBA load",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-checkpointer-disable",
        commit: "01792c31a62b7045eb22e93d7dad022bb64b1184",
        description: "stable branch disables WAL-fill checkpointer requests",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-external-checkpointer",
        commit: "ebb22839ae6fc3837d24e949626075175f5281fd",
        description: "stable branch disables external checkpointer dependency in PGlite",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-imported-memory",
        commit: "0c98d7c9c9bd3b0d01cb6728c4802b705f05ee54",
        description: "stable branch imported memory build fix",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-memory-stack",
        commit: "9ebefd39f8d4d16b1bea9992ed03c19d43b9d956",
        description: "stable branch adjusts initial memory and stack sizing",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-postgres-user",
        commit: "ac31093ac4d9291a167c11a1eac9dc956d4fab77",
        description: "stable branch default postgres user and home",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-initdb-single-no-exit",
        commit: "a679d34cc89848bc1c46b32e4449203b6b2a2320",
        description: "stable branch keeps initdb single-user phase from exiting process state",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-atexit-single-cleanup",
        commit: "f8ab9b9f13ef9a094afac993006f24edd6aa3357",
        description: "stable branch removes PGlite atexit handler replay during embedded restart",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-postmaster-environment",
        commit: "50354221668b9a5d2f9cf79cd4bc93fa68ef923d",
        description: "stable branch marks PGlite single-user mode as postmaster environment",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-timer-cleanup",
        commit: "e01963726df03e4700de48b69d1ac16ea5e20bef",
        description: "stable branch clears timers on embedded process exit",
        required: true,
    },
    UpstreamAuditItem {
        id: "stable-is-transaction-block",
        commit: "6c76f5e",
        description: "stable branch IsTransactionBlock export",
        required: false,
    },
    UpstreamAuditItem {
        id: "stable-postgis",
        commit: "d0f2748",
        description: "stable branch PostGIS backend proof",
        required: false,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_load_average_formats() {
        assert_eq!(
            parse_load_averages("{ 11.67 10.41 9.54 }"),
            Some((11.67, 10.41, 9.54))
        );
        assert_eq!(
            parse_load_averages("18:16 up 1 day, load averages: 13.58 11.62 9.62"),
            Some((13.58, 11.62, 9.62))
        );
        assert_eq!(
            parse_load_averages("0.10 0.20 0.30 1/100 123"),
            Some((0.10, 0.20, 0.30))
        );
    }

    #[test]
    fn sampled_host_load_parent_flags_are_not_forwarded_to_child() {
        let args = vec![
            "--samples".to_owned(),
            "9".to_owned(),
            "--max-load-per-cpu".to_owned(),
            "0.5".to_owned(),
            "--max-top-cpu-percent=50".to_owned(),
            "--max-sample-attempts=20".to_owned(),
            "--max-sample-spread-ratio".to_owned(),
            "1.15".to_owned(),
            "--max-sample-elapsed-spread-ratio=1.20".to_owned(),
            "--load-gate-wait-ms".to_owned(),
            "30000".to_owned(),
            "--load-gate-poll-ms=500".to_owned(),
            "--only-sqlx".to_owned(),
        ];

        let filtered = prepared_update_args_without_samples(&args);

        assert_eq!(
            filtered,
            vec![
                "--only-sqlx".to_owned(),
                "--samples".to_owned(),
                "1".to_owned()
            ]
        );
    }

    #[test]
    fn host_load_gate_rejects_busy_top_process() {
        let gate = SampledHostLoadGate {
            max_load_per_logical_cpu: Some(0.8),
            max_top_cpu_percent: Some(50.0),
            max_sample_attempts: None,
            pre_sample_wait_timeout: None,
            pre_sample_poll_interval: Duration::from_millis(100),
        };
        let host_load = serde_json::json!({
            "loadPerLogicalCpu1m": 0.42,
            "topCpuProcesses": [
                {"pid": 1, "cpuPercent": 78.5, "command": "spindump"}
            ]
        });

        let reason = host_load_reject_reason(Some(&host_load), &gate).unwrap();

        assert!(reason.contains("top process CPU 78.5% exceeded gate 50.0%"));
    }

    #[test]
    fn prepared_read_perf_stats_flags_are_not_forwarded_to_child() {
        let args = vec![
            "--only-sqlx".to_owned(),
            "--ids".to_owned(),
            "param_echo".to_owned(),
            "--wasix-perf-stats".to_owned(),
            "--wasix-perf-stats-log".to_owned(),
            "target/perf/trace.log".to_owned(),
            "--wasix-perf-stats-summary-prefix=target/perf/trace-summary".to_owned(),
            "--wasix-perf-stats-bin".to_owned(),
            "target/perf/bin/wasmer".to_owned(),
            "--rows=1000".to_owned(),
        ];

        let filtered = prepared_read_args_without_wasix_perf_stats(&args).unwrap();

        assert_eq!(
            filtered,
            vec![
                "--only-sqlx".to_owned(),
                "--ids".to_owned(),
                "param_echo".to_owned(),
                "--rows=1000".to_owned(),
            ]
        );
    }

    #[test]
    fn prepared_read_perf_stats_log_defaults_summary_prefix() {
        let args = vec![
            "--wasix-perf-stats-log".to_owned(),
            "target/perf/trace.log".to_owned(),
        ];

        let options = prepared_read_wasix_perf_stats_options(&args)
            .unwrap()
            .unwrap();

        assert_eq!(options.log, PathBuf::from("target/perf/trace.log"));
        assert_eq!(options.summary_prefix, PathBuf::from("target/perf/trace"));
        assert_eq!(options.wasmer_bin, None);
    }

    #[test]
    fn prepared_read_perf_stats_rejects_missing_values() {
        let args = vec!["--wasix-perf-stats-bin".to_owned()];

        let err = prepared_read_wasix_perf_stats_options(&args).unwrap_err();

        assert!(err.to_string().contains("requires a value"));
    }

    #[test]
    fn sample_stability_reports_spread_gate_violations() {
        let test = PreparedUpdateSampledRunTestAccumulator {
            mode: "native_postgres_sqlx".to_owned(),
            id: "indexed_range_select".to_owned(),
            label: "indexed read".to_owned(),
            operation_count_samples: vec![5000, 5000, 5000],
            elapsed_micros_samples: vec![300_000, 315_000, 390_000],
        }
        .finish();
        let summaries = vec![PreparedUpdateSampledRunSummary {
            mode: "native_postgres_sqlx".to_owned(),
            tests: vec![test],
        }];
        let gate = SampledStabilityGate {
            max_elapsed_spread_ratio: Some(1.20),
        };

        let stability = summarize_sample_stability(&summaries, &gate).unwrap();

        assert!(!stability.stable);
        assert_eq!(stability.violations.len(), 1);
        assert_eq!(stability.violations[0].id, "indexed_range_select");
        assert!(stability.violations[0].elapsed_spread_ratio > 1.20);
        assert!(
            sample_stability_reject_reason(Some(&stability))
                .unwrap()
                .contains("sample stability gate rejected")
        );
    }

    #[test]
    fn sample_stability_gate_defaults_to_strict_p90_spread() {
        let gate = sampled_stability_gate_arg(&[]).unwrap();

        assert_eq!(gate.max_elapsed_spread_ratio, Some(1.15));
    }

    #[test]
    fn sample_stability_gate_can_be_disabled() {
        let args = vec!["--max-sample-spread-ratio=off".to_owned()];
        let gate = sampled_stability_gate_arg(&args).unwrap();

        assert_eq!(gate.max_elapsed_spread_ratio, None);
    }

    #[test]
    fn no_tty_runtime_set_maps_to_server_runtime_config() {
        let set = named_wasmer_runtime_config_set("no-tty").unwrap();

        assert_eq!(set.report().wasmer_no_tty, Some(true));
        assert!(set.runtime_config().is_some());
    }

    #[test]
    fn fresh_sql_case8_repeats_use_int4_safe_update_shape_after_first_repeat() {
        let target_sql = speed_update_t1(2);
        let target = SpeedCase {
            id: "8",
            label: "case 8".to_owned(),
            sql: target_sql.clone(),
            operation_count: 2,
        };
        let options = DiagnosticOptions {
            target_repeats: 3,
            target_repeat_mode: TargetRepeatMode::FreshSql,
            ..DiagnosticOptions::default()
        };

        let sqls = target_sqls_for_repeats(&target, &options).unwrap();

        assert_eq!(sqls.len(), 3);
        assert_eq!(sqls[0], target_sql);
        assert!(sqls[1].contains("UPDATE t1 SET b = b * -1"));
        assert!(sqls[2].contains("UPDATE t1 SET b = b * -1"));
        assert!(!sqls[1].contains("b * 2"));
        assert!(!sqls[2].contains("b * 2"));
    }

    #[test]
    fn same_sql_case8_rejects_repeat_counts_that_can_overflow_int4() {
        let target = SpeedCase {
            id: "8",
            label: "case 8".to_owned(),
            sql: speed_update_t1(2),
            operation_count: 2,
        };
        let options = DiagnosticOptions {
            target_repeats: SAME_SQL_CASE8_MAX_REPEAT_COUNT + 1,
            target_repeat_mode: TargetRepeatMode::SameSql,
            ..DiagnosticOptions::default()
        };

        let err = target_sqls_for_repeats(&target, &options).unwrap_err();

        assert!(err.to_string().contains("b=b*2"));
        assert!(err.to_string().contains("fresh-sql"));
    }

    #[test]
    fn btree_deduplicate_items_variant_rewrites_benchmark_indexes() {
        let sql = "CREATE INDEX i2a ON t2(a);\nSELECT 1;\nCREATE INDEX i2b ON t2(b);\n";
        let options = DiagnosticOptions {
            btree_deduplicate_items: Some(false),
            ..DiagnosticOptions::default()
        };

        let rewritten = apply_diagnostic_sql_variants(sql, &options);

        assert!(rewritten.contains("CREATE INDEX i2a ON t2(a) WITH (deduplicate_items=off);"));
        assert!(rewritten.contains("CREATE INDEX i2b ON t2(b) WITH (deduplicate_items=off);"));
        assert!(rewritten.contains("SELECT 1;"));
    }

    #[test]
    fn btree_deduplicate_items_variant_applies_to_fresh_case6_repeats() {
        let target = SpeedCase {
            id: "6",
            label: "case 6".to_owned(),
            sql: "CREATE INDEX i2a ON t2(a);\nCREATE INDEX i2b ON t2(b);\n".to_owned(),
            operation_count: 2,
        };
        let options = DiagnosticOptions {
            target_repeats: 2,
            target_repeat_mode: TargetRepeatMode::FreshSql,
            btree_deduplicate_items: Some(true),
            ..DiagnosticOptions::default()
        };

        let sqls = target_sqls_for_repeats(&target, &options).unwrap();

        assert_eq!(sqls.len(), 2);
        assert!(sqls[0].contains("WITH (deduplicate_items=on);"));
        assert!(
            sqls[1]
                .contains("CREATE INDEX __pgo_i2a_repeat_2 ON t2(a) WITH (deduplicate_items=on);")
        );
        assert!(
            sqls[1]
                .contains("CREATE INDEX __pgo_i2b_repeat_2 ON t2(b) WITH (deduplicate_items=on);")
        );
    }

    #[test]
    fn lookup_only_t2_index_shape_removes_value_index() {
        let target = SpeedCase {
            id: "6",
            label: "case 6".to_owned(),
            sql: "CREATE INDEX i2a ON t2(a);\nCREATE INDEX i2b ON t2(b);\n".to_owned(),
            operation_count: 2,
        };
        let options = DiagnosticOptions {
            target_repeats: 2,
            target_repeat_mode: TargetRepeatMode::FreshSql,
            t2_index_shape: DiagnosticT2IndexShape::LookupOnly,
            ..DiagnosticOptions::default()
        };

        let sqls = target_sqls_for_repeats(&target, &options).unwrap();

        assert!(sqls[0].contains("CREATE INDEX i2a ON t2(a);"));
        assert!(!sqls[0].contains("CREATE INDEX i2b ON t2(b);"));
        assert!(sqls[1].contains("CREATE INDEX __pgo_i2a_repeat_2 ON t2(a);"));
        assert!(!sqls[1].contains("__pgo_i2b_repeat_2"));
    }

    #[test]
    fn prepared_update_passes_perturb_later_values() {
        let numeric = repeated_numeric_updates(&[(1, 10), (2, 20)], 3).unwrap();
        assert_eq!(
            numeric,
            vec![(1, 10), (2, 20), (1, 11), (2, 21), (1, 12), (2, 22)]
        );

        let text = repeated_text_updates(&[(7, "seven".to_owned())], 3).unwrap();
        assert_eq!(
            text,
            vec![
                (7, "seven".to_owned()),
                (7, "seven #1".to_owned()),
                (7, "seven #2".to_owned())
            ]
        );
    }

    #[test]
    fn prepared_insert_execute_batch_uses_server_prepare_and_escapes_literals() {
        let rows = vec![(1, 2, "plain".to_owned()), (2, 3, "has ' quote".to_owned())];

        let sql = prepared_insert_execute_batch_sql("__pgo_insert_exec", &rows);

        assert!(sql.starts_with(
            "PREPARE __pgo_insert_row(int4, int4, text) AS INSERT INTO __pgo_insert_exec"
        ));
        assert!(sql.contains("BEGIN;\n"));
        assert!(sql.contains("EXECUTE __pgo_insert_row(1, 2, 'plain');"));
        assert!(sql.contains("EXECUTE __pgo_insert_row(2, 3, 'has '' quote');"));
        assert!(sql.ends_with("COMMIT;\nDEALLOCATE __pgo_insert_row;\n"));
    }

    #[test]
    fn prepared_insert_selection_rejects_unknown_ids() {
        let ids = HashSet::from(["missing".to_owned()]);

        let err = validate_prepared_insert_selection(Some(&ids)).unwrap_err();

        assert!(err.to_string().contains("unknown prepared-insert id"));
        assert!(err.to_string().contains("sqlx_prepared_transaction"));
    }

    #[test]
    fn prepared_read_roundtrip_decomposition_splits_sqlx_and_pipelined_gaps() {
        let reports = vec![
            serde_json::json!({
                "runs": [
                    {"mode": "pglite_server_sqlx", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 2000, "operationCount": 100}
                    ]},
                    {"mode": "native_postgres_sqlx", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 1000, "operationCount": 100}
                    ]},
                    {"mode": "pglite_server_tcp_tokio_postgres_pipelined_prepared", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 500, "operationCount": 100}
                    ]},
                    {"mode": "native_tokio_postgres_pipelined_prepared", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 300, "operationCount": 100}
                    ]}
                ]
            }),
            serde_json::json!({
                "runs": [
                    {"mode": "pglite_server_sqlx", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 3000, "operationCount": 100}
                    ]},
                    {"mode": "native_postgres_sqlx", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 1500, "operationCount": 100}
                    ]},
                    {"mode": "pglite_server_tcp_tokio_postgres_pipelined_prepared", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 700, "operationCount": 100}
                    ]},
                    {"mode": "native_tokio_postgres_pipelined_prepared", "tests": [
                        {"id": "param_echo", "label": "Parameterized echo", "elapsedMicros": 400, "operationCount": 100}
                    ]}
                ]
            }),
        ];

        let decomposition = summarize_prepared_read_roundtrip_decomposition(&reports).unwrap();
        let test = &decomposition.tests[0];

        assert_eq!(test.id, "param_echo");
        assert_eq!(test.sqlx_gap_p90_micros_per_op, 15.0);
        assert_eq!(test.pipelined_gap_p90_micros_per_op, 3.0);
        assert_eq!(test.inferred_roundtrip_gap_p90_micros_per_op, 12.0);
        assert_eq!(test.server_sqlx_over_pipelined_p90_micros_per_op, 23.0);
        assert_eq!(test.native_sqlx_over_pipelined_p90_micros_per_op, 11.0);
    }

    #[test]
    fn parses_wasix_profile_symbol_offsets() {
        let parsed =
            parse_profile_symbol_offset("module_5C85D4A6::heap_index_delete_tuples+0x180/0x25c0")
                .unwrap();

        assert_eq!(
            parsed,
            ProfileSymbolOffset {
                symbol: "heap_index_delete_tuples".to_owned(),
                offset: 0x180,
                function_size: Some(0x25c0),
            }
        );
        assert!(parse_profile_symbol_offset("module_5C85D4A6::function_123").is_none());
        assert!(parse_profile_symbol_offset("???  (in <unknown binary>)").is_none());
    }

    #[test]
    fn aggregates_profile_offset_hotspots() {
        let hotspots = profile_offset_hotspots(
            &[
                CpuProfileTopStackEntry {
                    samples: 10,
                    frame: "module_5C85D4A6::heap_index_delete_tuples+0x180/0x25c0".to_owned(),
                },
                CpuProfileTopStackEntry {
                    samples: 5,
                    frame: "module_5C85D4A6::heap_index_delete_tuples+0x180/0x25c0".to_owned(),
                },
                CpuProfileTopStackEntry {
                    samples: 3,
                    frame: "module_5C85D4A6::heap_index_delete_tuples+0x1d8/0x25c0".to_owned(),
                },
                CpuProfileTopStackEntry {
                    samples: 2,
                    frame: "module_5C85D4A6::_bt_compare+0x2f4/0x564".to_owned(),
                },
            ],
            8,
            8,
        );

        assert_eq!(hotspots[0].symbol, "heap_index_delete_tuples");
        assert_eq!(hotspots[0].samples, 18);
        assert_eq!(hotspots[0].offsets[0].offset, 0x180);
        assert_eq!(hotspots[0].offsets[0].samples, 15);
        assert_eq!(hotspots[0].offsets[1].offset, 0x1d8);
        assert_eq!(hotspots[1].symbol, "_bt_compare");
    }

    #[test]
    fn parses_symbolized_sample_call_graph_frames() {
        let frame = parse_profile_call_graph_frame(
            "  : | + 8 ???  (in <unknown binary>)  [0x113823f44]    # 0x113823f44=>module_5C85D4A6::_bt_compare+0x114/0x564",
        )
        .unwrap();

        assert_eq!(frame.samples, 8);
        assert_eq!(frame.symbol, "_bt_compare");
        assert_eq!(frame.frame, "module_5C85D4A6::_bt_compare+0x114/0x564");
    }

    #[test]
    fn aggregates_profile_callsite_hotspots() {
        let sample = "\
Call graph:
100 module_5C85D4A6::PostgresMain+0x10/0x20
  50 module_5C85D4A6::_bt_search+0x20/0x44c
    12 module_5C85D4A6::_bt_compare+0x114/0x564
    8 module_5C85D4A6::_bt_compare+0x2f4/0x564
  30 module_5C85D4A6::_bt_binsrch_insert+0x194/0x3c4
    7 module_5C85D4A6::_bt_compare+0x114/0x564
Sort by top of stack:
module_5C85D4A6::_bt_compare+0x114/0x564 27
";
        let targets = vec!["_bt_compare".to_owned()];
        let top_entries = vec![CpuProfileTopStackEntry {
            samples: 27,
            frame: "module_5C85D4A6::_bt_compare+0x114/0x564".to_owned(),
        }];

        let hotspots = profile_callsite_hotspots_from_text(&sample, &targets, &top_entries, 8, 8);

        assert_eq!(hotspots.len(), 1);
        assert_eq!(hotspots[0].symbol, "_bt_compare");
        assert_eq!(hotspots[0].samples, 27);
        assert_eq!(hotspots[0].callers[0].caller_symbol, "_bt_search");
        assert_eq!(hotspots[0].callers[0].samples, 20);
        assert_eq!(hotspots[0].callers[1].caller_symbol, "_bt_binsrch_insert");
        assert_eq!(hotspots[0].callers[1].samples, 7);
    }
}
