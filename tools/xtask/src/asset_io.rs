use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};

use super::*;

const GITHUB_READ_HELPER: &str = "tools/release/github-read.mjs";
const DOWNLOAD_MAX_ATTEMPTS: usize = 4;
const DOWNLOAD_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(30 * 60);

#[derive(Debug)]
enum DownloadAttemptError {
    Permanent(anyhow::Error),
    Retryable(anyhow::Error),
}

impl DownloadAttemptError {
    fn retryable(error: impl Into<anyhow::Error>) -> Self {
        Self::Retryable(error.into())
    }

    fn permanent(error: impl Into<anyhow::Error>) -> Self {
        Self::Permanent(error.into())
    }
}

struct TemporaryDirectory {
    path: PathBuf,
    remove: bool,
}

impl TemporaryDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path, remove: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.remove = false;
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if self.remove {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[derive(Clone, Copy)]
struct DownloadRetryPolicy {
    base_delay: Duration,
    deadline: Duration,
    max_attempts: usize,
}

impl Default for DownloadRetryPolicy {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_secs(1),
            deadline: DOWNLOAD_DEADLINE,
            max_attempts: DOWNLOAD_MAX_ATTEMPTS,
        }
    }
}

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
        ensure!(
            sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "assets download --sha requires a full 40-character commit SHA"
        );
        let output = github_read_output(
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
                "databaseId,status,headSha",
            ],
            &format!("find CI workflow run for SHA {sha}"),
        )
        .with_context(|| format!("find CI workflow run for SHA {sha}"))?;
        return filter_runs_by_required_job(parse_exact_sha_run_ids(&output, sha)?, required_job);
    }

    let branch = value_after(args, "--branch").unwrap_or("main");
    let output = github_read_output(
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
        &format!("find latest successful CI workflow runs on {branch}"),
    )
    .with_context(|| format!("find latest successful CI workflow runs on {branch}"))?;
    filter_runs_by_required_job(parse_gh_run_ids(&output)?, required_job)
}

fn parse_gh_run_ids(output: &str) -> Result<Vec<String>> {
    let mut runs = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        ensure!(
            line.bytes().all(|byte| byte.is_ascii_digit()) && !line.starts_with('0'),
            "GitHub returned invalid workflow run id {line:?}"
        );
        runs.push(line.to_owned());
    }
    ensure!(!runs.is_empty(), "no CI workflow artifact found");
    Ok(runs)
}

fn parse_exact_sha_run_ids(output: &str, sha: &str) -> Result<Vec<String>> {
    let value: serde_json::Value =
        serde_json::from_str(output).context("parse exact-SHA CI workflow run search")?;
    let rows = value
        .as_array()
        .context("exact-SHA CI workflow run search must return a list")?;
    let mut runs = Vec::new();
    for row in rows {
        let head_sha = row
            .get("headSha")
            .and_then(serde_json::Value::as_str)
            .context("exact-SHA CI workflow run is missing headSha")?;
        ensure!(
            head_sha.eq_ignore_ascii_case(sha),
            "GitHub returned CI workflow run for {head_sha}, not requested SHA {sha}"
        );
        let run_id = row
            .get("databaseId")
            .and_then(serde_json::Value::as_u64)
            .filter(|run_id| *run_id > 0)
            .context("exact-SHA CI workflow run has invalid databaseId")?;
        runs.push(run_id.to_string());
    }
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
    let output = github_read_output(
        &["run", "view", run_id, "--json", "jobs"],
        &format!("inspect CI workflow run {run_id}"),
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

fn github_read_output(args: &[&str], label: &str) -> Result<String> {
    let output = Command::new("node")
        .arg(GITHUB_READ_HELPER)
        .arg("--label")
        .arg(label)
        .arg("--")
        .args(args)
        .output()
        .with_context(|| format!("start bounded GitHub read for {label}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        bail!(
            "bounded GitHub read for {label} failed{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    }
    String::from_utf8(output.stdout).context("GitHub read output was not valid UTF-8")
}

fn github_read_once(
    args: &[&str],
    label: &str,
    timeout: Duration,
) -> std::result::Result<(), DownloadAttemptError> {
    let timeout_ms = timeout.as_millis().clamp(1, u128::from(u64::MAX));
    let status = Command::new("node")
        .arg(GITHUB_READ_HELPER)
        .arg("--label")
        .arg(label)
        .arg("--")
        .args(args)
        .env("OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS", "1")
        .env(
            "OLIPHAUNT_GITHUB_READ_ATTEMPT_TIMEOUT_MS",
            timeout_ms.to_string(),
        )
        .env("OLIPHAUNT_GITHUB_READ_DEADLINE_MS", timeout_ms.to_string())
        .env("OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS", "0")
        .env("OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS", "0")
        .stdout(Stdio::null())
        .status()
        .map_err(|error| {
            DownloadAttemptError::retryable(anyhow!(
                "start bounded GitHub read for {label}: {error}"
            ))
        })?;
    match status.code() {
        Some(0) => Ok(()),
        Some(64) => Err(DownloadAttemptError::permanent(anyhow!(
            "GitHub permanently rejected {label}"
        ))),
        Some(75) => Err(DownloadAttemptError::retryable(anyhow!(
            "GitHub read budget was exhausted for {label}"
        ))),
        Some(code) => Err(DownloadAttemptError::permanent(anyhow!(
            "GitHub read helper failed for {label} with unexpected exit code {code}"
        ))),
        None => Err(DownloadAttemptError::retryable(anyhow!(
            "GitHub read helper was interrupted for {label}"
        ))),
    }
}

fn unique_sibling_directory(destination: &Path, label: &str) -> Result<PathBuf> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let basename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for sequence in 0..100_u32 {
        let candidate = parent.join(format!(
            ".{basename}.{label}-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", candidate.display()));
            }
        }
    }
    bail!(
        "could not allocate a unique sibling directory for {}",
        destination.display()
    )
}

fn promote_staged_directory(stage: &Path, destination: &Path) -> Result<()> {
    ensure!(
        stage.parent() == destination.parent(),
        "atomic stage {} must be a sibling of {}",
        stage.display(),
        destination.display()
    );
    let backup = unique_sibling_directory(destination, "previous")?;
    fs::remove_dir(&backup).with_context(|| format!("prepare backup {}", backup.display()))?;
    let had_destination = destination.exists();
    if had_destination {
        fs::rename(destination, &backup).with_context(|| {
            format!(
                "move existing directory {} -> {}",
                destination.display(),
                backup.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(stage, destination) {
        if had_destination {
            let _ = fs::rename(&backup, destination);
        }
        return Err(error).with_context(|| {
            format!(
                "promote staged directory {} -> {}",
                stage.display(),
                destination.display()
            )
        });
    }
    if had_destination {
        fs::remove_dir_all(&backup).with_context(|| format!("remove {}", backup.display()))?;
    }
    Ok(())
}

fn retry_delay(base: Duration, attempt: usize) -> Duration {
    if base.is_zero() {
        return Duration::ZERO;
    }
    let multiplier = 1_u32 << attempt.saturating_sub(1).min(3);
    let exponential = base.saturating_mul(multiplier);
    let entropy = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let jitter_percent = 80 + (entropy % 41);
    exponential.saturating_mul(jitter_percent) / 100
}

fn retry_staged_download<F>(
    destination: &Path,
    label: &str,
    policy: DownloadRetryPolicy,
    mut attempt_download: F,
) -> Result<()>
where
    F: FnMut(&Path, Instant) -> std::result::Result<(), DownloadAttemptError>,
{
    ensure!(
        policy.max_attempts > 0,
        "download retry policy must permit an attempt"
    );
    let deadline = Instant::now() + policy.deadline;
    let mut last_error = None;
    for attempt in 1..=policy.max_attempts {
        if Instant::now() >= deadline {
            break;
        }
        let mut stage = TemporaryDirectory::new(unique_sibling_directory(destination, "attempt")?);
        match attempt_download(stage.path(), deadline) {
            Ok(()) => {
                promote_staged_directory(stage.path(), destination)
                    .with_context(|| format!("atomically promote {label}"))?;
                stage.disarm();
                return Ok(());
            }
            Err(DownloadAttemptError::Permanent(error)) => {
                return Err(error).with_context(|| format!("permanent failure while {label}"));
            }
            Err(DownloadAttemptError::Retryable(error)) => {
                eprintln!("{label} attempt {attempt} failed transiently: {error:#}");
                last_error = Some(error);
            }
        }
        if attempt == policy.max_attempts {
            break;
        }
        let delay = retry_delay(policy.base_delay, attempt);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining <= delay {
            break;
        }
        thread::sleep(delay);
    }
    let context = format!(
        "{label} exhausted {} attempts or its {}s overall deadline",
        policy.max_attempts,
        policy.deadline.as_secs()
    );
    match last_error {
        Some(error) => Err(error).context(context),
        None => bail!(context),
    }
}

fn remaining_attempt_timeout(deadline: Instant, maximum: Duration) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    ensure!(!remaining.is_zero(), "download overall deadline exhausted");
    Ok(remaining.min(maximum))
}

fn download_assets_from_run(run_id: &str, targets: &[String]) -> Result<()> {
    let download_dir = Path::new("target/oliphaunt-wasix/downloads").join(run_id);
    retry_staged_download(
        &download_dir,
        &format!("download CI workflow runtime artifacts from run {run_id}"),
        DownloadRetryPolicy::default(),
        |stage, deadline| {
            let timeout = remaining_attempt_timeout(deadline, DOWNLOAD_ATTEMPT_TIMEOUT)
                .map_err(DownloadAttemptError::retryable)?;
            github_read_once(
                &[
                    "run",
                    "download",
                    run_id,
                    "--name",
                    "liboliphaunt-wasix-runtime-portable",
                    "--dir",
                    stage.to_str().expect("download stage is utf-8"),
                ],
                &format!("download portable runtime artifact from run {run_id}"),
                timeout,
            )?;
            for target in targets {
                let target_download_dir = stage.join(generated_aot_dir(target));
                fs::create_dir_all(&target_download_dir).map_err(|error| {
                    DownloadAttemptError::retryable(anyhow!(
                        "create {}: {error}",
                        target_download_dir.display()
                    ))
                })?;
                let artifact = aot_artifact_name(target);
                let timeout = remaining_attempt_timeout(deadline, DOWNLOAD_ATTEMPT_TIMEOUT)
                    .map_err(DownloadAttemptError::retryable)?;
                github_read_once(
                    &[
                        "run",
                        "download",
                        run_id,
                        "--name",
                        &artifact,
                        "--dir",
                        target_download_dir
                            .to_str()
                            .expect("target download stage is utf-8"),
                    ],
                    &format!("download {artifact} from run {run_id}"),
                    timeout,
                )?;
                normalize_downloaded_aot_artifact(target, &target_download_dir)
                    .map_err(DownloadAttemptError::retryable)?;
            }
            validate_downloaded_artifacts(stage, targets).map_err(DownloadAttemptError::retryable)
        },
    )?;
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
    ensure!(
        !tag.is_empty()
            && tag
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-._".contains(character)),
        "release tag contains unsupported URL characters"
    );
    let download_dir = Path::new("target/oliphaunt-wasix/downloads").join(format!("release-{tag}"));
    let version = wasm_release_version_from_tag(tag);
    let checksum_asset = format!("liboliphaunt-wasix-{version}-release-assets.sha256");
    let mut assets = vec![format!(
        "liboliphaunt-wasix-{version}-runtime-portable.tar.zst"
    )];
    for target in targets {
        assets.push(format!(
            "liboliphaunt-wasix-{version}-runtime-aot-{}.tar.zst",
            aot_target_id_for_triple(target)?
        ));
    }

    retry_staged_download(
        &download_dir,
        &format!("download release runtime artifacts from {tag}"),
        DownloadRetryPolicy::default(),
        |stage, deadline| {
            let timeout = remaining_attempt_timeout(deadline, DOWNLOAD_ATTEMPT_TIMEOUT)
                .map_err(DownloadAttemptError::retryable)?;
            let checksum_path = stage.join(&checksum_asset);
            curl_release_asset_once(tag, &checksum_asset, &checksum_path, timeout)?;
            let checksum_manifest = fs::read_to_string(&checksum_path).map_err(|error| {
                DownloadAttemptError::retryable(anyhow!(
                    "read release checksum manifest {}: {error}",
                    checksum_path.display()
                ))
            })?;
            for asset in &assets {
                let expected = release_asset_checksum(&checksum_manifest, asset)
                    .map_err(DownloadAttemptError::permanent)?;
                let archive = stage.join(asset);
                let timeout = remaining_attempt_timeout(deadline, DOWNLOAD_ATTEMPT_TIMEOUT)
                    .map_err(DownloadAttemptError::retryable)?;
                curl_release_asset_once(tag, asset, &archive, timeout)?;
                let actual = sha256_file(&archive).map_err(DownloadAttemptError::retryable)?;
                if actual != expected {
                    return Err(DownloadAttemptError::retryable(anyhow!(
                        "release asset {asset} checksum mismatch: expected {expected}, got {actual}"
                    )));
                }
                extract_tar_zst(&archive, stage).map_err(DownloadAttemptError::retryable)?;
            }
            validate_downloaded_artifacts(stage, targets).map_err(DownloadAttemptError::retryable)
        },
    )?;
    install_downloaded_artifacts(&download_dir, targets)?;
    for target in targets {
        install_local_assets_for_target(target)?;
    }
    Ok(())
}

fn curl_release_asset_once(
    tag: &str,
    asset: &str,
    destination: &Path,
    timeout: Duration,
) -> std::result::Result<(), DownloadAttemptError> {
    let url = format!("https://github.com/f0rr0/oliphaunt/releases/download/{tag}/{asset}");
    let timeout_seconds = timeout.as_secs().clamp(1, 10 * 60).to_string();
    let args = curl_release_asset_args(&url, destination, &timeout_seconds, cfg!(windows));
    let output = Command::new("curl").args(args).output().map_err(|error| {
        DownloadAttemptError::retryable(anyhow!(
            "start HTTPS download for release asset {asset}: {error}"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }
    let http_status = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let error = anyhow!(
        "HTTPS download for release asset {asset} failed (HTTP {}{})",
        if http_status.is_empty() {
            "unknown"
        } else {
            &http_status
        },
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    );
    let permanent = matches!(
        http_status.parse::<u16>(),
        Ok(400 | 401 | 404 | 405 | 410 | 422)
    );
    if permanent {
        Err(DownloadAttemptError::permanent(error))
    } else {
        Err(DownloadAttemptError::retryable(error))
    }
}

fn curl_release_asset_args(
    url: &str,
    destination: &Path,
    timeout_seconds: &str,
    windows: bool,
) -> Vec<String> {
    let mut args = [
        "--fail-with-body",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--connect-timeout",
        "20",
        "--max-time",
        timeout_seconds,
        "--speed-limit",
        "1024",
        "--speed-time",
        "60",
    ]
    .map(str::to_owned)
    .to_vec();
    if windows {
        // Windows curl uses Schannel. A temporarily unreachable revocation
        // distribution point must not make a verified release artifact
        // unavailable; this still rejects certificates known to be revoked.
        args.push("--ssl-revoke-best-effort".to_owned());
    }
    args.extend([
        "--output".to_owned(),
        destination
            .to_str()
            .expect("release download path is utf-8")
            .to_owned(),
        "--write-out".to_owned(),
        "%{http_code}".to_owned(),
        url.to_owned(),
    ]);
    args
}

fn release_asset_checksum(manifest: &str, asset: &str) -> Result<String> {
    let mut matches = Vec::new();
    for line in manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let mut fields = line.split_whitespace();
        let digest = fields.next().unwrap_or_default();
        let filename = fields.next().unwrap_or_default().trim_start_matches('*');
        ensure!(
            fields.next().is_none()
                && digest.len() == 64
                && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                && !filename.is_empty(),
            "release checksum manifest contains malformed line {line:?}"
        );
        if filename.trim_start_matches("./") == asset {
            matches.push(digest.to_ascii_lowercase());
        }
    }
    ensure!(
        matches.len() == 1,
        "release checksum manifest must contain exactly one entry for {asset}, found {}",
        matches.len()
    );
    Ok(matches.remove(0))
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

fn validate_downloaded_artifacts(download_dir: &Path, targets: &[String]) -> Result<()> {
    for entry in WalkDir::new(download_dir).follow_links(false) {
        let entry = entry.with_context(|| format!("walk {}", download_dir.display()))?;
        let file_type = entry.file_type();
        ensure!(
            file_type.is_dir() || file_type.is_file(),
            "downloaded artifact envelope contains a symbolic link or special file: {}",
            entry.path().display()
        );
    }
    verify_downloaded_asset_fingerprint(download_dir)?;
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
    Ok(())
}

struct PreparedPromotion {
    backup: Option<PathBuf>,
    destination: PathBuf,
    promoted: bool,
    stage: TemporaryDirectory,
}

fn promote_directories_transactionally(entries: &[(PathBuf, PathBuf)]) -> Result<()> {
    let mut prepared = Vec::new();
    for (source, destination) in entries {
        let stage_path = unique_sibling_directory(destination, "install")?;
        let stage = TemporaryDirectory::new(stage_path);
        copy_dir_all(source, stage.path()).with_context(|| {
            format!(
                "stage validated directory {} for {}",
                source.display(),
                destination.display()
            )
        })?;
        let backup = if destination.exists() {
            let backup = unique_sibling_directory(destination, "previous")?;
            fs::remove_dir(&backup).with_context(|| format!("prepare {}", backup.display()))?;
            Some(backup)
        } else {
            None
        };
        prepared.push(PreparedPromotion {
            backup,
            destination: destination.clone(),
            promoted: false,
            stage,
        });
    }

    for index in 0..prepared.len() {
        let destination = prepared[index].destination.clone();
        if let Some(backup) = prepared[index].backup.clone() {
            if let Err(error) = fs::rename(&destination, &backup) {
                rollback_promotions(&mut prepared, index);
                return Err(error).with_context(|| {
                    format!(
                        "move existing install {} -> {}",
                        destination.display(),
                        backup.display()
                    )
                });
            }
        }
        if let Err(error) = fs::rename(prepared[index].stage.path(), &destination) {
            if let Some(backup) = prepared[index].backup.take() {
                let _ = fs::rename(backup, &destination);
            }
            rollback_promotions(&mut prepared, index);
            return Err(error).with_context(|| {
                format!(
                    "promote validated install {} -> {}",
                    prepared[index].stage.path().display(),
                    destination.display()
                )
            });
        }
        prepared[index].stage.disarm();
        prepared[index].promoted = true;
    }
    for item in &mut prepared {
        if let Some(backup) = item.backup.take() {
            fs::remove_dir_all(&backup)
                .with_context(|| format!("remove prior install {}", backup.display()))?;
        }
    }
    Ok(())
}

fn rollback_promotions(prepared: &mut [PreparedPromotion], before: usize) {
    for item in prepared[..before].iter_mut().rev() {
        if !item.promoted {
            continue;
        }
        let _ = fs::remove_dir_all(&item.destination);
        if let Some(backup) = item.backup.take() {
            let _ = fs::rename(backup, &item.destination);
        }
        item.promoted = false;
    }
}

fn install_downloaded_artifacts(download_dir: &Path, targets: &[String]) -> Result<()> {
    validate_downloaded_artifacts(download_dir, targets)?;
    let mut entries = vec![(
        download_dir.join(GENERATED_ASSETS_DIR),
        PathBuf::from(GENERATED_ASSETS_DIR),
    )];
    for target in targets {
        entries.push((
            download_dir.join("target/oliphaunt-wasix/aot").join(target),
            generated_aot_dir(target),
        ));
    }
    promote_directories_transactionally(&entries)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-asset-io-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn staged_retry_uses_fresh_bytes_and_preserves_no_partial_result() {
        let root = test_root("retry");
        let destination = root.join("durable");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("old"), b"old").unwrap();
        let policy = DownloadRetryPolicy {
            base_delay: Duration::ZERO,
            deadline: Duration::from_secs(5),
            max_attempts: 2,
        };
        let mut attempts = 0;
        retry_staged_download(&destination, "test download", policy, |stage, _| {
            attempts += 1;
            assert!(
                !stage.join("partial").exists(),
                "retry inherited a prior partial file"
            );
            if attempts == 1 {
                fs::write(stage.join("partial"), b"truncated").unwrap();
                return Err(DownloadAttemptError::retryable(anyhow!("unexpected EOF")));
            }
            fs::write(stage.join("complete"), b"complete").unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(fs::read(destination.join("complete")).unwrap(), b"complete");
        assert!(!destination.join("partial").exists());
        assert!(!destination.join("old").exists());
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".durable.")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn permanent_staged_failure_preserves_existing_destination() {
        let root = test_root("permanent");
        let destination = root.join("durable");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("existing"), b"preserve").unwrap();
        let policy = DownloadRetryPolicy {
            base_delay: Duration::ZERO,
            deadline: Duration::from_secs(5),
            max_attempts: 4,
        };
        let error = retry_staged_download(&destination, "test download", policy, |stage, _| {
            fs::write(stage.join("partial"), b"partial").unwrap();
            Err(DownloadAttemptError::permanent(anyhow!("HTTP 404")))
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("HTTP 404"));
        assert_eq!(fs::read(destination.join("existing")).unwrap(), b"preserve");
        assert!(!destination.join("partial").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_staging_failure_cannot_partially_replace_destinations() {
        let root = test_root("transaction");
        let source = root.join("source");
        let missing = root.join("missing");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        fs::write(first.join("old-first"), b"old-first").unwrap();
        fs::write(second.join("old-second"), b"old-second").unwrap();
        assert!(
            promote_directories_transactionally(&[
                (source, first.clone()),
                (missing, second.clone())
            ])
            .is_err()
        );
        assert_eq!(fs::read(first.join("old-first")).unwrap(), b"old-first");
        assert_eq!(fs::read(second.join("old-second")).unwrap(), b"old-second");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checksum_manifest_requires_one_exact_asset_identity() {
        let digest = "a".repeat(64);
        let asset = "liboliphaunt-wasix-1.0.0-runtime-portable.tar.zst";
        let manifest = format!("{digest}  ./{asset}\n{digest}  ./{asset}-near-match\n");
        assert_eq!(release_asset_checksum(&manifest, asset).unwrap(), digest);
        let duplicate = format!("{manifest}{}  ./{asset}\n", "b".repeat(64));
        assert!(release_asset_checksum(&duplicate, asset).is_err());
        assert!(release_asset_checksum("not-a-digest  ./asset\n", "asset").is_err());
    }

    #[test]
    fn release_asset_curl_uses_https_only_and_schannel_best_effort_on_windows() {
        let destination = Path::new("release-asset.tar.zst");
        let windows = curl_release_asset_args(
            "https://github.com/f0rr0/oliphaunt/releases/download/product-v1.0.0/release-asset.tar.zst",
            destination,
            "600",
            true,
        );
        assert!(windows.windows(2).any(|pair| pair == ["--proto", "=https"]));
        assert!(
            windows
                .windows(2)
                .any(|pair| pair == ["--proto-redir", "=https"])
        );
        assert!(windows.iter().any(|arg| arg == "--ssl-revoke-best-effort"));
        assert!(!windows.iter().any(|arg| arg == "--insecure" || arg == "-k"));

        let unix = curl_release_asset_args(
            "https://github.com/f0rr0/oliphaunt/releases/download/product-v1.0.0/release-asset.tar.zst",
            destination,
            "600",
            false,
        );
        assert!(!unix.iter().any(|arg| arg == "--ssl-revoke-best-effort"));
    }

    #[test]
    fn exact_sha_run_inventory_rejects_mismatched_or_malformed_identity() {
        let sha = "a".repeat(40);
        let exact = format!(r#"[{{"databaseId":77,"status":"completed","headSha":"{sha}"}}]"#);
        assert_eq!(parse_exact_sha_run_ids(&exact, &sha).unwrap(), ["77"]);
        let mismatch = format!(
            r#"[{{"databaseId":77,"status":"completed","headSha":"{}"}}]"#,
            "b".repeat(40)
        );
        assert!(parse_exact_sha_run_ids(&mismatch, &sha).is_err());
        assert!(parse_exact_sha_run_ids(
            r#"[{"databaseId":"77","status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]"#,
            &sha
        )
        .is_err());
    }
}
