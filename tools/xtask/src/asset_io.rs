use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};

use super::*;

pub(super) fn download_assets(args: &[String]) -> Result<()> {
    let targets = asset_download_targets(args)?;
    let required_job = value_after(args, "--required-job");
    if args.iter().any(|arg| arg == "--release") {
        let tag = value_after(args, "--release").context("--release requires a tag")?;
        ensure!(
            value_after(args, "--run-id").is_none()
                && value_after(args, "--sha").is_none()
                && !args.iter().any(|arg| arg == "--latest-compatible")
                && required_job.is_none(),
            "assets download accepts only one of --run-id, --sha, --latest-compatible, or --release; --required-job applies only to workflow-run downloads"
        );
        download_assets_from_release(tag, &targets)?;
        let target_list = targets.join(", ");
        println!("downloaded and installed release assets from {tag} / {target_list}");
        return Ok(());
    }

    let candidates = asset_download_run_candidates(args, required_job)?;
    let mut last_error = None;

    let candidate_count = candidates.len();
    for (index, run_id) in candidates.into_iter().enumerate() {
        match download_assets_from_run(&run_id, &targets) {
            Ok(()) => {
                let target_list = targets.join(", ");
                println!(
                    "downloaded and installed CI workflow runtime artifacts from run {run_id} / {target_list}"
                );
                return Ok(());
            }
            Err(error) => {
                if index + 1 < candidate_count {
                    eprintln!(
                        "CI workflow run {run_id} does not contain compatible runtime artifacts: {error:#}"
                    );
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }

    if let Some(error) = last_error {
        Err(error).context("no compatible CI workflow runtime artifact found")
    } else {
        bail!("no CI workflow runtime artifact found")
    }
}

fn asset_download_targets(args: &[String]) -> Result<Vec<String>> {
    let all_targets = args.iter().any(|arg| arg == "--all-targets");
    let explicit_target =
        value_after(args, "--target").or_else(|| value_after(args, "--target-triple"));
    if all_targets && explicit_target.is_some() {
        bail!("assets download accepts either --all-targets or --target/--target-triple, not both");
    }
    if all_targets {
        Ok(supported_aot_targets()
            .iter()
            .map(|target| (*target).to_owned())
            .collect())
    } else {
        let target = explicit_target
            .map(aot_triple_for_target_selector)
            .transpose()?
            .unwrap_or(host_target_triple());
        ensure_supported_aot_target(target)?;
        Ok(vec![target.to_owned()])
    }
}

fn asset_download_run_candidates(
    args: &[String],
    required_job: Option<&str>,
) -> Result<Vec<String>> {
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
        return filter_runs_by_required_job(vec![run_id.to_owned()], required_job);
    }

    if let Some(sha) = sha {
        let output = command_output(
            "gh",
            &[
                "run",
                "list",
                "--workflow",
                "CI",
                "--commit",
                sha,
                "--limit",
                "20",
                "--json",
                "databaseId,status",
                "--jq",
                ".[].databaseId",
            ],
            Path::new("."),
        )
        .with_context(|| format!("find CI workflow run for SHA {sha}"))?;
        return filter_runs_by_required_job(parse_gh_run_ids(&output)?, required_job);
    }

    let branch = value_after(args, "--branch").unwrap_or("main");
    let output = command_output(
        "gh",
        &[
            "run",
            "list",
            "--workflow",
            "CI",
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
    .with_context(|| format!("find latest successful CI workflow runs on {branch}"))?;
    filter_runs_by_required_job(parse_gh_run_ids(&output)?, required_job)
}

fn parse_gh_run_ids(output: &str) -> Result<Vec<String>> {
    let runs = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "null")
        .map(str::to_owned)
        .collect::<Vec<_>>();
    ensure!(!runs.is_empty(), "no CI workflow artifact found");
    Ok(runs)
}

fn filter_runs_by_required_job(
    run_ids: Vec<String>,
    required_job: Option<&str>,
) -> Result<Vec<String>> {
    let Some(required_job) = required_job else {
        return Ok(run_ids);
    };

    let mut matched = Vec::new();
    for run_id in run_ids {
        if run_has_required_job_success(&run_id, required_job)? {
            matched.push(run_id);
        }
    }
    ensure!(
        !matched.is_empty(),
        "no CI workflow artifact run has required job '{required_job}' with conclusion 'success'"
    );
    Ok(matched)
}

fn run_has_required_job_success(run_id: &str, required_job: &str) -> Result<bool> {
    let output = command_output(
        "gh",
        &["run", "view", run_id, "--json", "jobs"],
        Path::new("."),
    )
    .with_context(|| format!("inspect CI workflow run {run_id}"))?;
    let value: serde_json::Value = serde_json::from_str(&output)
        .with_context(|| format!("parse CI workflow run {run_id} job JSON"))?;
    let conclusion = value
        .get("jobs")
        .and_then(serde_json::Value::as_array)
        .and_then(|jobs| {
            jobs.iter().find(|job| {
                job.get("name").and_then(serde_json::Value::as_str) == Some(required_job)
            })
        })
        .and_then(|job| job.get("conclusion"))
        .and_then(serde_json::Value::as_str);
    Ok(conclusion == Some("success"))
}

fn download_assets_from_run(run_id: &str, targets: &[String]) -> Result<()> {
    let download_dir = Path::new("target/oliphaunt-wasix/downloads").join(run_id);
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
            "liboliphaunt-wasix-runtime-portable",
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
                &aot_artifact_name(target),
                "--dir",
                target_download_dir.to_str().expect("download dir is utf-8"),
            ],
        )?;
        normalize_downloaded_aot_artifact(target, &target_download_dir)?;
    }
    verify_downloaded_asset_fingerprint(&download_dir)?;
    install_downloaded_artifacts(&download_dir, targets)?;
    for target in targets {
        install_local_assets_for_target(target)?;
    }
    Ok(())
}

fn normalize_downloaded_aot_artifact(target: &str, artifact_dir: &Path) -> Result<()> {
    let marker = artifact_dir.join("target-triple.txt");
    let files = artifact_dir.join("files");
    if !marker.exists() && !files.exists() {
        return Ok(());
    }

    ensure_file(&marker)?;
    ensure!(
        files.is_dir(),
        "downloaded AOT artifact envelope is missing files directory: {}",
        files.display()
    );
    let actual = fs::read_to_string(&marker)
        .with_context(|| format!("read {}", marker.display()))?
        .trim()
        .to_owned();
    ensure_eq(
        &actual,
        target,
        "downloaded AOT artifact target-triple marker",
    )?;

    let normalized = artifact_dir.with_extension("normalized");
    if normalized.exists() {
        fs::remove_dir_all(&normalized)
            .with_context(|| format!("remove {}", normalized.display()))?;
    }
    copy_dir_all(&files, &normalized)?;
    fs::remove_dir_all(artifact_dir)
        .with_context(|| format!("remove {}", artifact_dir.display()))?;
    fs::rename(&normalized, artifact_dir).with_context(|| {
        format!(
            "rename normalized AOT artifact {} -> {}",
            normalized.display(),
            artifact_dir.display()
        )
    })?;
    Ok(())
}

fn download_assets_from_release(tag: &str, targets: &[String]) -> Result<()> {
    let download_dir = Path::new("target/oliphaunt-wasix/downloads").join(format!("release-{tag}"));
    if download_dir.exists() {
        fs::remove_dir_all(&download_dir)
            .with_context(|| format!("remove {}", download_dir.display()))?;
    }
    fs::create_dir_all(&download_dir)
        .with_context(|| format!("create {}", download_dir.display()))?;

    download_and_extract_release_asset(
        tag,
        &format!(
            "liboliphaunt-wasix-{}-runtime-portable.tar.zst",
            wasm_release_version_from_tag(tag)
        ),
        &download_dir,
    )?;
    for target in targets {
        download_and_extract_release_asset(
            tag,
            &format!(
                "liboliphaunt-wasix-{}-runtime-aot-{}.tar.zst",
                wasm_release_version_from_tag(tag),
                aot_target_id_for_triple(target)?
            ),
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
    let url = format!("https://github.com/f0rr0/oliphaunt/releases/download/{tag}/{asset}");
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

fn wasm_release_version_from_tag(tag: &str) -> String {
    tag.rsplit_once("-v")
        .map(|(_, version)| version)
        .filter(|version| !version.is_empty())
        .unwrap_or(tag)
        .to_owned()
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
    let downloaded_manifest = read_asset_manifest_from(&downloaded_assets)?;
    ensure_packaged_asset_matches_source_lane(&downloaded_manifest, DEFAULT_SOURCE_LANE)?;

    for target in targets {
        let downloaded_aot = download_dir.join("target/oliphaunt-wasix/aot").join(target);
        ensure_file(&downloaded_aot.join("manifest.json"))?;
        ensure_aot_manifest_matches_source_lane(
            &downloaded_aot.join("manifest.json"),
            target,
            DEFAULT_SOURCE_LANE,
        )?;
    }

    copy_dir_all(&downloaded_assets, Path::new(GENERATED_ASSETS_DIR))?;
    for target in targets {
        let downloaded_aot = download_dir.join("target/oliphaunt-wasix/aot").join(target);
        copy_dir_all(&downloaded_aot, &generated_aot_dir(target))?;
    }
    Ok(())
}

pub(super) fn ensure_aot_manifest_matches_source_lane(
    manifest_path: &Path,
    target: &str,
    source_lane: &str,
) -> Result<()> {
    let expected = canonical_source_lane(source_lane)?;
    let text = fs::read_to_string(manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: AotManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse {}", manifest_path.display()))?;
    let actual = manifest.source_lane.as_deref().unwrap_or("<missing>");
    ensure_eq(actual, expected, "AOT manifest source-lane")?;
    ensure_eq(
        &manifest.target_triple,
        target,
        "AOT manifest target-triple",
    )?;
    let sources = load_wasix_toolchain_manifest()?;
    ensure_eq(
        &manifest.wasmer_version,
        &sources.toolchain.wasmer,
        "AOT manifest wasmer-version",
    )?;
    ensure_eq(
        &manifest.wasmer_wasix_version,
        &sources.toolchain.wasmer_wasix,
        "AOT manifest wasmer-wasix-version",
    )?;
    ensure!(
        !manifest.artifacts.is_empty(),
        "AOT manifest {} contains no artifacts",
        manifest_path.display()
    );
    match expected {
        "stable" => {
            ensure_postgres_source_fingerprint_matches_current(
                manifest.source_fingerprint.as_deref(),
                "PG18 AOT manifest source-fingerprint",
            )?;
            if let Some(postgres_version) = manifest.postgres_version.as_deref() {
                ensure!(
                    postgres_version.starts_with("18."),
                    "AOT manifest is PostgreSQL {postgres_version}, not the PG18 WASIX runtime"
                );
            }
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
    Ok(())
}

pub(super) fn install_local_assets(args: &[String]) -> Result<()> {
    let target = value_after(args, "--target-triple").unwrap_or(host_target_triple());
    install_local_assets_for_target(target)
}

fn install_local_assets_for_target(target: &str) -> Result<()> {
    ensure_supported_aot_target(target)?;
    let generated_assets = Path::new(GENERATED_ASSETS_DIR);
    ensure_file(&generated_assets.join("manifest.json"))?;
    let generated_manifest = read_asset_manifest_from(generated_assets)?;
    ensure_packaged_asset_matches_source_lane(&generated_manifest, DEFAULT_SOURCE_LANE)?;
    check_canonical_asset_layout(true)?;
    check_generated_manifest_for_aot(&load_sources_manifest()?, true)?;
    verify_asset_manifest_hashes()?;
    verify_generated_extension_surface()?;

    find_aot_artifact_dir(target)?;
    check_aot_package_manifest(target, DEFAULT_SOURCE_LANE)?;
    println!("local generated assets are installed for {target}");
    Ok(())
}

pub(super) fn run_asset_smoke_tests(args: &[String]) -> Result<()> {
    let mode = match args {
        [] => "smoke",
        [arg] if arg == "--core-only" => "core-smoke",
        [arg] => bail!("unknown assets smoke flag: {arg}"),
        _ => bail!("assets smoke accepts at most one flag"),
    };
    if mode == "smoke" {
        run(
            "src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh",
            &[],
        )
    } else {
        run(
            "src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh",
            &[mode],
        )
    }
}
