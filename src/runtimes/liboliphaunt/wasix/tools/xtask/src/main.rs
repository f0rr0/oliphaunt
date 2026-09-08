use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail, ensure};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

mod aot_serializer;
mod asset_checks;
mod asset_io;
mod asset_manifest;
mod asset_pipeline;
mod cluster_seed_runner;
mod extension_catalog;
mod fs_utils;
mod postgres_guard;
mod source_spine;

use crate::aot_serializer::aot_serializer;
use crate::asset_checks::*;
#[cfg(test)]
use crate::asset_io::ensure_aot_manifest_matches_source_lane;
use crate::asset_io::{import_downloaded_assets, install_local_assets, unpack_downloaded_archive};
use crate::asset_manifest::*;
use crate::asset_pipeline::*;
use crate::fs_utils::*;
use crate::postgres_guard::{
    check_postgres_source_spine, check_prepared_postgres_source, postgres_default_source_dir,
    postgres_expected_source_fingerprint,
};
use crate::source_spine::{
    check_sources_manifest, load_sources_manifest, load_wasix_toolchain_manifest,
};

const WASIX_GENERATED_BUILD_DIR: &str = "target/oliphaunt-wasix/wasix-build/build";
const WASIX_GENERATED_WORK_DIR: &str = "target/oliphaunt-wasix/wasix-build/work";
const WASIX_DOCKER_BUILD_DIR: &str = "target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt";
const WASIX_POSTGRES_WORK_DIR: &str = "target/oliphaunt-wasix/wasix-build";
const WASIX_POSTGRES_GENERATED_BUILD_DIR: &str = WASIX_GENERATED_BUILD_DIR;
const WASIX_POSTGRES_DOCKER_BUILD_DIR: &str = WASIX_DOCKER_BUILD_DIR;
const WASIX_BUILD_MANIFEST_PATH: &str = "target/oliphaunt-wasix/wasix-build/build/outputs.json";
const WASIX_POSTGRES_BUILD_MANIFEST_PATH: &str = WASIX_BUILD_MANIFEST_PATH;
const POSTGRES_SHARED_SOURCE_MANIFEST_PATH: &str = "src/postgres/versions/18/source.toml";
const POSTGRES_PATCH_DIR: &str = "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches";
const POSTGRES_PATCH_SERIES_PATH: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/series";
const POSTGRES_PREPARE_SCRIPT: &str =
    "src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh";
const DEFAULT_SOURCE_LANE: &str = "stable";
const GENERATED_ASSETS_DIR: &str = "target/oliphaunt-wasix/assets";
const GENERATED_AOT_DIR: &str = "target/oliphaunt-wasix/aot";
const RUNTIME_MODULE_ARCHIVE_MEMBER: &str = "oliphaunt/bin/postgres";
const REQUIRED_RUNTIME_ABI_EXPORTS: &[&str] = &[
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
    "oliphaunt_wasix_set_force_host_error_recovery",
    "oliphaunt_wasix_protocol_stream_active",
    "oliphaunt_wasix_input_reset",
    "oliphaunt_wasix_input_reserve",
    "oliphaunt_wasix_input_commit",
    "oliphaunt_wasix_input_available",
    "oliphaunt_wasix_output_reset",
    "oliphaunt_wasix_output_len",
    "oliphaunt_wasix_output_data",
    "oliphaunt_wasix_output_contains_error",
    "oliphaunt_wasix_set_protocol_transport",
];
fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("assets") => assets(args.collect()),
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
            let strict_generated = args.iter().any(|arg| arg == "--strict-generated");
            let manifest = check_sources_manifest()?;
            check_postgres_source_spine()?;

            check_canonical_asset_layout(strict_generated)?;
            check_generated_manifest(&manifest, strict_generated)?;
            if strict_generated {
                verify_asset_manifest_hashes()?;
                verify_generated_extension_surface()?;
            }
            check_generated_wasix_export_list(strict_generated)
        }
        Some("cluster-seeds") => {
            let manifest = check_sources_manifest()?;
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            generate_cluster_seed_assets(&manifest, source_lane)
        }
        Some("import-download") => import_downloaded_assets(&args),
        Some("unpack") => unpack_downloaded_archive(&args),
        Some("install-local") => install_local_assets(&args),
        Some("package") => {
            let manifest = check_sources_manifest()?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            if args.iter().any(|arg| arg == "--skip-aot") {
                package_assets_without_aot(&manifest, source_lane)
            } else {
                package_assets(&manifest, target, source_lane)
            }
        }
        Some("package-aot") => {
            let manifest = check_sources_manifest()?;
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            package_aot_only(&manifest, target, source_lane)
        }
        Some("package-extension-aot") => {
            let manifest = check_sources_manifest()?;
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
        Some("prepare-aot") => {
            let target = value_after(&args, "--target-triple").unwrap_or(host_target_triple());
            let source_lane = value_after(&args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE);
            prepare_aot_artifacts(target, source_lane)
        }
        Some(other) => bail!("unknown assets subcommand: {other}"),
        None => {
            bail!(
                "usage: cargo run -p xtask -- assets <check|cluster-seeds|import-download|unpack|install-local|package|package-aot|check-aot>"
            )
        }
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

fn ensure_eq(actual: &str, expected: &str, field: &str) -> Result<()> {
    if actual != expected {
        bail!("{field} must be '{expected}', got '{actual}'");
    }
    Ok(())
}

pub(crate) fn value_after<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn print_usage() {
    eprintln!("usage:");
    eprintln!("  cargo run -p xtask -- assets check [--strict-generated]");
    eprintln!("  cargo run -p xtask -- assets install-local --target-triple <triple>");
    eprintln!("  cargo run -p xtask --features cluster-seed-runner -- assets cluster-seeds");
    eprintln!(
        "  bash src/runtimes/liboliphaunt/wasix/tools/serialize-aot.sh --target-triple <triple>"
    );
    eprintln!(
        "  cargo run -p xtask --features aot-serializer -- assets package [--target-triple <triple>] [--skip-aot]"
    );
    eprintln!("  cargo run -p xtask -- assets package-aot [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets package-extension-aot [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets check-aot [--target-triple <triple>]");
    eprintln!("  cargo run -p xtask -- assets export-list [--write]");
}
