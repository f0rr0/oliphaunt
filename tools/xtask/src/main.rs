use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

mod aot_serializer;
mod asset_checks;
mod asset_fingerprint;
mod asset_io;
mod asset_manifest;
mod asset_pipeline;
mod extension_catalog;
mod fs_utils;
mod postgres_guard;
mod release_workspace;
mod source_spine;
mod template_runner;

use crate::aot_serializer::aot_serializer;
use crate::asset_checks::*;
#[cfg(test)]
use crate::asset_io::ensure_aot_manifest_matches_source_lane;
use crate::asset_io::{download_assets, install_local_assets, run_asset_smoke_tests};
use crate::asset_manifest::*;
use crate::asset_pipeline::*;
use crate::fs_utils::*;
use crate::postgres_guard::{
    check_postgres_source_spine, check_prepared_postgres_source, check_rust_startup_abi_boundary,
    check_source_lane_isolation, check_wasix_shell_script_syntax, postgres_default_source_dir,
    postgres_expected_source_fingerprint,
};
use crate::release_workspace::{
    package_release_assets, run_in_release_workspace, stage_release_workspace,
};
use crate::source_spine::{
    SourceFetchScope, check_source_spine_for_source_lane, check_sources_manifest,
    check_sources_manifest_for_asset_build, fetch_pinned_sources_for_source_lane,
    load_sources_manifest, load_wasix_toolchain_manifest, validate_sources_manifest,
};

const WASIX_BUILD_SOURCE_ROOT: &str = "src/runtimes/liboliphaunt/wasix/assets/build";
const WASIX_GENERATED_BUILD_DIR: &str = "target/oliphaunt-wasix/wasix-build/build";
const WASIX_GENERATED_WORK_DIR: &str = "target/oliphaunt-wasix/wasix-build/work";
const WASIX_DOCKER_BUILD_DIR: &str = "target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt";
const WASIX_POSTGRES_WORK_DIR: &str = "target/oliphaunt-wasix/wasix-build";
const WASIX_POSTGRES_GENERATED_BUILD_DIR: &str = WASIX_GENERATED_BUILD_DIR;
const WASIX_POSTGRES_DOCKER_BUILD_DIR: &str = WASIX_DOCKER_BUILD_DIR;
const WASIX_PATCHED_SOURCE_DIR: &str =
    "target/oliphaunt-wasix/wasix-build/work/postgres18-wasix-src";
const WASIX_BUILD_MANIFEST_PATH: &str = "target/oliphaunt-wasix/wasix-build/build/outputs.json";
const WASIX_POSTGRES_BUILD_MANIFEST_PATH: &str = WASIX_BUILD_MANIFEST_PATH;
const WASIX_BRIDGE_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge.c";
const POSTGRES_SOURCE_MANIFEST_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/postgres/source.toml";
const POSTGRES_SHARED_SOURCE_MANIFEST_PATH: &str = "src/postgres/versions/18/source.toml";
const POSTGRES_PATCH_DIR: &str = "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches";
const POSTGRES_PATCH_SERIES_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/series";
const POSTGRES_EXPERIMENT_DISPOSITION_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/postgres/experiment-patch-disposition.toml";
const POSTGRES_PREPARE_SCRIPT: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh";
const DEFAULT_SOURCE_LANE: &str = "stable";
const DEFAULT_ASSET_BUILD_PROFILE: &str = "release";
const SOURCE_CHECKOUT_ROOT: &str = "target/oliphaunt-sources/checkouts";
const ASSET_INPUT_FINGERPRINT_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256";
const GENERATED_ASSETS_DIR: &str = "target/oliphaunt-wasix/assets";
const GENERATED_AOT_DIR: &str = "target/oliphaunt-wasix/aot";
const ASSET_CRATE_PAYLOAD_DIR: &str = "src/runtimes/liboliphaunt/wasix/crates/assets/payload";
const RELEASE_STAGE_DIR: &str = "target/oliphaunt-wasix/release";
const RELEASE_ASSET_BUNDLE_DIR: &str = "target/oliphaunt-wasix/release-assets";
const LEGACY_STATIC_WASI_ARCHIVE: &str = concat!("assets/", "oliphaunt-", "wasi.tar.zst");
const RUST_HOST_REQUIRED_RUNTIME_EXPORTS: &[&str] = &[
    "_start",
    "oliphaunt_wasix_set_active",
    "oliphaunt_wasix_start",
    "oliphaunt_wasix_get_proc_port",
    "ProcessStartupPacket",
    "oliphaunt_wasix_send_conn_data",
    "oliphaunt_wasix_pq_flush",
    "pq_buffer_remaining_data",
    "PostgresMainLoopOnce",
    "PostgresSendReadyForQueryIfNecessary",
    "PostgresMainLongJmp",
    "oliphaunt_wasix_protocol_stream_active",
    "oliphaunt_wasix_input_reset",
    "oliphaunt_wasix_input_write",
    "oliphaunt_wasix_input_available",
    "oliphaunt_wasix_output_reset",
    "oliphaunt_wasix_output_len",
    "oliphaunt_wasix_output_read",
];
const RUST_HOST_OPTIONAL_RUNTIME_EXPORTS: &[&str] = &[
    "oliphaunt_wasix_set_force_host_error_recovery",
    "oliphaunt_wasix_run_atexit_funcs",
    "oliphaunt_wasix_backend_timing_reset",
    "oliphaunt_wasix_backend_timing_elapsed_us",
    "oliphaunt_wasix_set_protocol_transport",
];
const RUNTIME_EXPORT_LIST_COMPAT_EXPORTS: &[&str] = &[
    "oliphaunt_wasix_set_protocol_stdio",
    "oliphaunt_wasix_set_force_host_error_recovery",
    "oliphaunt_wasix_set_protocol_transport",
];
const PG18_POSTGRES_HOST_EXPORTS: &[&str] = &[
    "ProcessStartupPacket",
    "oliphaunt_wasix_start",
    "oliphaunt_wasix_pq_flush",
    "oliphaunt_wasix_get_proc_port",
    "oliphaunt_wasix_send_conn_data",
    "PostgresSendReadyForQueryIfNecessary",
    "PostgresMainLongJmp",
    "PostgresMainLoopOnce",
];

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("assets") => assets(args.collect()),
        Some("extensions") => extension_catalog::extensions(args.collect()),
        Some("release") => release(args.collect()),
        Some("package-size") => package_size(args.collect()),
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
            check_postgres_source_spine()?;
            check_source_lane_isolation()?;
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
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            generate_pgdata_template_asset(&manifest, source_lane)
        }
        Some("fetch") => {
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            let prepare_postgres_source = !args.iter().any(|arg| arg == "--skip-postgres-prepare");
            let source_scope =
                SourceFetchScope::parse(value_after(&args, "--scope").unwrap_or("all"))?;
            fetch_pinned_sources_for_source_lane(
                &manifest,
                source_lane,
                prepare_postgres_source,
                source_scope,
            )
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
        Some("update-root-metadata") => update_staged_root_asset_metadata(Path::new(".")),
        Some("ci-matrix") => print_aot_ci_matrix(&args),
        Some("ci-artifacts") => print_ci_artifact_names(),
        Some("aot-targets") => print_supported_aot_targets(),
        Some("internal-packages") => print_internal_asset_packages(),
        Some("package") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            if args.iter().any(|arg| arg == "--skip-aot") {
                package_assets_without_aot(&manifest, source_lane)
            } else {
                package_assets(&manifest, target, source_lane)
            }
        }
        Some("package-aot") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            package_aot_only(&manifest, target, source_lane)
        }
        Some("package-extension-aot") => {
            let manifest = check_sources_manifest(false)?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            package_extension_aot_artifacts(&manifest, target, source_lane)
        }
        Some("check-aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            check_aot_package_manifest(target, source_lane)
        }
        Some("export-list") => {
            let write = args.iter().any(|arg| arg == "--write");
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            generate_wasix_export_list(write, source_lane)
        }
        Some("input-fingerprint") => {
            let write = args.iter().any(|arg| arg == "--write");
            check_or_write_asset_input_fingerprint(write)
        }
        Some("aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            generate_aot_artifacts(target, source_lane)
        }
        Some("source-spine") => {
            let check_patch = args.iter().any(|arg| arg == "--check-patch-applies");
            let source_lane = canonical_source_lane(
                value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE),
            )?;
            let manifest = load_sources_manifest()?;
            validate_sources_manifest(&manifest)?;
            println!(
                "validated {} pinned asset sources for {source_lane}",
                manifest.sources.len()
            );
            let strict_local = source_lane == DEFAULT_SOURCE_LANE
                || args.iter().any(|arg| arg == "--strict-local");
            check_source_spine_for_source_lane(&manifest, source_lane, strict_local, check_patch)
        }
        Some("smoke") => run_asset_smoke_tests(&args[1..]),
        Some(other) => bail!("unknown assets subcommand: {other}"),
        None => {
            bail!(
                "usage: cargo run -p xtask -- assets <check|verify-committed|audit-upstream|source-spine|fetch|build|template|build-host|release-build|download|install-local|update-root-metadata|ci-matrix|ci-artifacts|aot-targets|internal-packages|package|package-aot|check-aot|smoke>"
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
            run_in_release_workspace(
                "cargo",
                &["run", "-p", "xtask", "--", "release", "package-assets"],
            )
        }
        Some("publish") => {
            stage_release_workspace()?;
            run_in_release_workspace(
                "cargo",
                &["run", "-p", "xtask", "--", "release", "package-assets"],
            )?;
            bail!(
                "xtask release publish staged and validated the release workspace; publishing belongs to the protected Release workflow"
            )
        }
        Some(other) => bail!("unknown release subcommand: {other}"),
        None => {
            bail!("usage: cargo run -p xtask -- release <stage|package-assets|dry-run|publish>")
        }
    }
}

fn package_size(args: Vec<String>) -> Result<()> {
    let enforce = args.iter().any(|arg| arg == "--enforce");
    let source_lane =
        canonical_source_lane(value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE))?;
    ensure!(
        source_lane == DEFAULT_SOURCE_LANE,
        "package-size checks publishable crate tarballs for the stable source lane only; source lane {source_lane:?} is legacy-only"
    );
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

fn enforce_package_size_for_source_lane(source_lane: &str) -> Result<()> {
    package_size(vec![
        "--enforce".to_owned(),
        "--source-lane".to_owned(),
        source_lane.to_owned(),
    ])
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

pub(crate) fn value_after<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn run(command: &str, args: &[&str]) -> Result<()> {
    let mut command = command_for_host(command);
    command.args(args);
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
    eprintln!(
        "  cargo run -p xtask -- assets source-spine [--strict-local] [--check-patch-applies]"
    );
    eprintln!(
        "  cargo run -p xtask -- assets fetch [--skip-postgres-prepare] [--scope all|native-runtime|wasix-runtime|extensions]"
    );
    eprintln!("  cargo run -p xtask --features aot-serializer -- assets build-host");
    eprintln!(
        "  cargo run -p xtask -- assets download --sha <sha> [--required-job <job-name>] --target <target-id>"
    );
    eprintln!("  cargo run -p xtask -- assets download --run-id <id> --all-targets");
    eprintln!("  cargo run -p xtask -- assets download --latest-compatible --target <target-id>");
    eprintln!("  cargo run -p xtask -- assets download --release <tag> --target <target-id>");
    eprintln!("  cargo run -p xtask -- assets install-local --target-triple <triple>");
    eprintln!(
        "  cargo run -p xtask -- assets ci-matrix [--target <all|target-id>] [--github-output]"
    );
    eprintln!("  cargo run -p xtask -- assets ci-artifacts");
    eprintln!("  cargo run -p xtask -- assets aot-targets");
    eprintln!("  cargo run -p xtask -- assets internal-packages");
    eprintln!("  cargo run -p xtask -- assets input-fingerprint --write");
    eprintln!(
        "  cargo run -p xtask -- assets build --profile release --target-triple <triple> [--execute]"
    );
    eprintln!("  cargo run -p xtask --features template-runner -- assets template");
    eprintln!(
        "  cargo run -p xtask --features template-runner -- assets release-build --profile release --target-triple <triple> [--fetch]"
    );
    eprintln!("  cargo run -p xtask -- assets aot --target-triple <triple>");
    eprintln!(
        "  cargo run -p xtask --features aot-serializer -- assets package [--target-triple <triple>] [--skip-aot]"
    );
    eprintln!("  cargo run -p xtask -- assets package-aot [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets package-extension-aot [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets check-aot [--target-triple <triple>]");
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
    eprintln!("  cargo run -p oliphaunt-perf -- bench");
    eprintln!("  cargo run -p oliphaunt-perf -- native-liboliphaunt --engine direct --suite rtt");
    eprintln!("  cargo run -p oliphaunt-perf -- native-postgres --suite rtt");
}
