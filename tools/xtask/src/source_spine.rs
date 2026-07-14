use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

use crate::postgres_guard::{
    check_postgres_source_spine, check_prepared_postgres_source, check_source_lane_isolation,
    postgres_work_root_for_source,
};

use super::*;

pub(super) fn check_sources_manifest(strict_local: bool) -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    if strict_local {
        check_source_spine_for_source_lane(&manifest, DEFAULT_SOURCE_LANE, true, false)?;
    }
    println!("validated {} pinned asset sources", manifest.sources.len());
    Ok(manifest)
}

pub(super) fn check_sources_manifest_for_asset_build(args: &[String]) -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    let source_lane =
        canonical_source_lane(value_after(args, "--source-lane").unwrap_or(DEFAULT_SOURCE_LANE))?;
    if args.iter().any(|arg| arg == "--fetch") {
        fetch_pinned_sources_for_source_lane(&manifest, source_lane, true, SourceFetchScope::All)?;
    } else {
        check_source_spine_for_source_lane(&manifest, source_lane, true, false)?;
    }
    println!(
        "validated {} pinned asset sources for {source_lane}",
        manifest.sources.len()
    );
    Ok(manifest)
}

pub(super) fn fetch_pinned_sources_for_source_lane(
    manifest: &SourcesManifest,
    source_lane: &str,
    prepare_postgres_source: bool,
    source_scope: SourceFetchScope,
) -> Result<()> {
    match canonical_source_lane(source_lane)? {
        "stable" => {
            fetch_manifest_sources_filtered(manifest, |source| {
                source_scope.includes(source.origin)
            })?;
            if prepare_postgres_source {
                prepare_postgres_source_tree()?;
            }
            check_source_spine_for_source_lane_filtered(manifest, "stable", true, false, |source| {
                source_scope.includes(source.origin)
            })
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceFetchScope {
    All,
    NativeRuntime,
    WasixRuntime,
    Extensions,
}

impl SourceFetchScope {
    pub(super) fn parse(value: &str) -> Result<Self> {
        match value {
            "all" => Ok(Self::All),
            "native-runtime" => Ok(Self::NativeRuntime),
            "wasix-runtime" => Ok(Self::WasixRuntime),
            "extensions" => Ok(Self::Extensions),
            other => bail!(
                "unsupported source fetch scope {other:?}; expected one of: all, native-runtime, wasix-runtime, extensions"
            ),
        }
    }

    fn includes(self, origin: SourceOrigin) -> bool {
        match self {
            Self::All => true,
            Self::NativeRuntime => matches!(
                origin,
                SourceOrigin::SharedThirdParty
                    | SourceOrigin::NativeThirdParty
                    | SourceOrigin::Extension
            ),
            Self::WasixRuntime => matches!(
                origin,
                SourceOrigin::SharedThirdParty
                    | SourceOrigin::WasixThirdParty
                    | SourceOrigin::Extension
            ),
            Self::Extensions => matches!(origin, SourceOrigin::Extension),
        }
    }
}

fn fetch_manifest_sources_filtered<F>(manifest: &SourcesManifest, include: F) -> Result<()>
where
    F: Fn(&SourcePin) -> bool,
{
    for source in &manifest.sources {
        if !include(source) {
            eprintln!("skipping source '{}' for selected source lane", source.name);
            continue;
        }
        let Some(path) = source_checkout_path(source.name.as_str()) else {
            eprintln!(
                "warning: source '{}' has no configured checkout path; skipping fetch",
                source.name
            );
            continue;
        };
        if source.kind == SourceKind::Archive {
            fetch_archive_source(source, &path)?;
            continue;
        }
        if !path.exists() || !path.join(".git").exists() {
            init_source_checkout(source, &path)?;
        }
        ensure_clean_checkout(source, &path)?;
        ensure_source_remote(&path, source)?;
        fetch_git_source_with_retries(source, &path)?;
        let mut checkout = Command::new("git");
        checkout
            .args(["checkout", "-B", &source.branch, &source.commit])
            .current_dir(&path);
        run_command(&mut checkout).with_context(|| {
            format!(
                "checkout {} at {} in {}",
                source.name,
                source.commit,
                path.display()
            )
        })?;
    }
    Ok(())
}

fn fetch_git_source_with_retries(source: &SourcePin, path: &Path) -> Result<()> {
    const ATTEMPTS: u32 = 5;
    for attempt in 1..=ATTEMPTS {
        let mut fetch = Command::new("git");
        fetch
            .args([
                "fetch",
                "--no-tags",
                "--depth",
                "1",
                "origin",
                &source.commit,
            ])
            .current_dir(path);
        match run_command(&mut fetch) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < ATTEMPTS => {
                let delay = Duration::from_secs(u64::from(attempt) * 5);
                eprintln!(
                    "fetch {} failed on attempt {attempt}/{ATTEMPTS}: {error}; retrying in {}s",
                    source.name,
                    delay.as_secs()
                );
                thread::sleep(delay);
            }
            Err(error) => {
                return Err(error).with_context(|| format!("fetch {}", source.name));
            }
        }
    }
    unreachable!("fetch retry loop should return on success or final failure")
}

fn fetch_archive_source(source: &SourcePin, path: &Path) -> Result<()> {
    if archive_source_ready(source, path)? {
        return Ok(());
    }

    if path.exists() {
        if path.join(".git").exists() {
            let status = source_checkout_status_for_source(source.name.as_str(), path)
                .with_context(|| format!("read status for {}", path.display()))?;
            if !status.trim().is_empty() {
                bail!(
                    "archive source path {} ({}) is a dirty git checkout; preserve it before replacing it with an archive source",
                    path.display(),
                    source.name
                );
            }
        }
        fs::remove_dir_all(path)
            .with_context(|| format!("replace stale archive source {}", path.display()))?;
    }

    let archive = fetch_source_archive(source)?;
    let extract_root = path.with_file_name(format!(".{}-extracting", source.name));
    if extract_root.exists() {
        fs::remove_dir_all(&extract_root)
            .with_context(|| format!("remove stale {}", extract_root.display()))?;
    }
    fs::create_dir_all(&extract_root)
        .with_context(|| format!("create {}", extract_root.display()))?;

    let mut extract = Command::new("tar");
    extract
        .args([
            "-xzf",
            archive.to_str().expect("archive path is utf-8"),
            "-C",
        ])
        .arg(&extract_root);
    run_command(&mut extract).with_context(|| format!("extract {}", archive.display()))?;

    let strip_prefix = archive_strip_prefix(source)?;
    let extracted = extract_root.join(strip_prefix);
    ensure!(
        extracted.is_dir(),
        "archive source '{}' did not contain expected root {}",
        source.name,
        extracted.display()
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::rename(&extracted, path).with_context(|| {
        format!(
            "move extracted archive source {} to {}",
            extracted.display(),
            path.display()
        )
    })?;
    fs::remove_dir_all(&extract_root)
        .with_context(|| format!("remove {}", extract_root.display()))?;
    fs::write(archive_source_stamp_path(path), source.archive_stamp())
        .with_context(|| format!("write archive source stamp for {}", path.display()))?;
    Ok(())
}

fn fetch_source_archive(source: &SourcePin) -> Result<PathBuf> {
    let sha256 = archive_sha256(source)?;
    let archive_dir = Path::new("target/oliphaunt-sources/archives");
    fs::create_dir_all(archive_dir).with_context(|| format!("create {}", archive_dir.display()))?;
    let archive = archive_dir.join(format!("{}-{sha256}.tar.gz", source.name));
    if archive.exists() {
        let actual = sha256_file(&archive)?;
        if actual == sha256 {
            return Ok(archive);
        }
        fs::remove_file(&archive)
            .with_context(|| format!("remove sha-mismatched {}", archive.display()))?;
    }

    let tmp_archive = archive.with_extension("tar.gz.tmp");
    if tmp_archive.exists() {
        fs::remove_file(&tmp_archive)
            .with_context(|| format!("remove stale {}", tmp_archive.display()))?;
    }
    let mut download = Command::new("curl");
    download.args([
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry",
        "8",
        "--retry-all-errors",
        "--retry-delay",
        "5",
        "--connect-timeout",
        "20",
        &source.url,
        "-o",
        tmp_archive.to_str().expect("archive path is utf-8"),
    ]);
    run_command(&mut download).with_context(|| format!("download {}", source.name))?;
    let actual = sha256_file(&tmp_archive)?;
    ensure_eq(&actual, &sha256, &format!("{} archive sha256", source.name))?;
    fs::rename(&tmp_archive, &archive).with_context(|| {
        format!(
            "promote downloaded archive {} to {}",
            tmp_archive.display(),
            archive.display()
        )
    })?;
    Ok(archive)
}

fn archive_source_ready(source: &SourcePin, path: &Path) -> Result<bool> {
    if !path.is_dir() {
        return Ok(false);
    }
    let stamp = archive_source_stamp_path(path);
    if !stamp.is_file() {
        return Ok(false);
    }
    let actual = fs::read_to_string(&stamp).with_context(|| format!("read {}", stamp.display()))?;
    Ok(actual == source.archive_stamp())
}

fn archive_source_stamp_path(path: &Path) -> PathBuf {
    path.join(".oliphaunt-source-pin")
}

fn archive_sha256(source: &SourcePin) -> Result<String> {
    let sha256 = source
        .sha256
        .as_deref()
        .ok_or_else(|| anyhow!("archive source '{}' is missing sha256", source.name))?;
    ensure!(
        sha256.len() == 64 && sha256.chars().all(|ch| ch.is_ascii_hexdigit()),
        "archive source '{}' has invalid sha256 {}",
        source.name,
        sha256
    );
    Ok(sha256.to_owned())
}

fn archive_strip_prefix(source: &SourcePin) -> Result<&str> {
    source
        .strip_prefix
        .as_deref()
        .filter(|prefix| !prefix.is_empty() && !prefix.contains("..") && !prefix.starts_with('/'))
        .ok_or_else(|| anyhow!("archive source '{}' has invalid strip-prefix", source.name))
}

pub(super) fn check_source_spine_for_source_lane(
    manifest: &SourcesManifest,
    source_lane: &str,
    strict_local: bool,
    check_patch_applies: bool,
) -> Result<()> {
    match canonical_source_lane(source_lane)? {
        "stable" => {
            check_source_free_repo()?;
            check_manifest_source_checkouts_filtered(manifest, strict_local, |_| true)?;
            check_postgres_source_spine()?;
            if check_patch_applies {
                prepare_postgres_source_tree()?;
            }
            check_source_lane_isolation()?;
            Ok(())
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

fn check_source_spine_for_source_lane_filtered<F>(
    manifest: &SourcesManifest,
    source_lane: &str,
    strict_local: bool,
    check_patch_applies: bool,
    include: F,
) -> Result<()>
where
    F: Fn(&SourcePin) -> bool,
{
    match canonical_source_lane(source_lane)? {
        "stable" => {
            check_source_free_repo()?;
            check_manifest_source_checkouts_filtered(manifest, strict_local, include)?;
            check_postgres_source_spine()?;
            if check_patch_applies {
                prepare_postgres_source_tree()?;
            }
            check_source_lane_isolation()?;
            Ok(())
        }
        _ => unreachable!("canonical_source_lane returned an unsupported lane"),
    }
}

fn prepare_postgres_source_tree() -> Result<PathBuf> {
    let output = command_output("bash", &[POSTGRES_PREPARE_SCRIPT], Path::new("."))?;
    let source = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| anyhow!("{POSTGRES_PREPARE_SCRIPT} did not print a source path"))?;
    let source = PathBuf::from(source);
    ensure!(
        source.join(".oliphaunt-wasix-source-fingerprint").is_file(),
        "PG18 source-prep script did not produce a fingerprinted source tree at {}",
        source.display()
    );
    ensure_file(&source.join(".oliphaunt-wasix-postgres-version"))?;
    let manifest = load_postgres_source_manifest()?;
    let work_root = postgres_work_root_for_source(&source)?;
    check_prepared_postgres_source(&manifest, &source, &work_root)?;
    Ok(source)
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

pub(super) fn source_checkout_path(name: &str) -> Option<PathBuf> {
    if !valid_source_name_component(name) {
        return None;
    }
    Some(Path::new(SOURCE_CHECKOUT_ROOT).join(name))
}

fn valid_source_name_component(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
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

pub(super) fn load_wasix_toolchain_manifest() -> Result<WasixToolchainManifest> {
    let toolchain_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("src/sources/toolchains/wasix.toml");
    let toolchain_text = fs::read_to_string(&toolchain_path)
        .with_context(|| format!("read {}", toolchain_path.display()))?;
    toml::from_str(&toolchain_text).with_context(|| format!("parse {}", toolchain_path.display()))
}

pub(super) fn load_sources_manifest() -> Result<SourcesManifest> {
    let wasix = load_wasix_toolchain_manifest()?;

    let mut sources = Vec::new();
    let mut names = BTreeSet::new();
    let sources_root = Path::new("src/sources/third-party");
    for domain in ["shared", "native", "wasix"] {
        let domain_dir = sources_root.join(domain);
        if !domain_dir.exists() {
            continue;
        }
        let mut entries = fs::read_dir(&domain_dir)
            .with_context(|| format!("read {}", domain_dir.display()))?
            .collect::<std::io::Result<Vec<_>>>()
            .with_context(|| format!("list {}", domain_dir.display()))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("toml") {
                continue;
            }
            let origin = match domain {
                "shared" => SourceOrigin::SharedThirdParty,
                "native" => SourceOrigin::NativeThirdParty,
                "wasix" => SourceOrigin::WasixThirdParty,
                _ => unreachable!("source domain list is closed"),
            };
            push_source_pin(&mut sources, &mut names, &path, origin)?;
        }
    }
    for path in extension_source_pin_paths()? {
        push_source_pin(&mut sources, &mut names, &path, SourceOrigin::Extension)?;
    }

    Ok(SourcesManifest {
        toolchain: wasix.toolchain,
        build: wasix.build,
        sources,
    })
}

pub(super) fn validate_sources_manifest(manifest: &SourcesManifest) -> Result<()> {
    if manifest.sources.is_empty() {
        bail!("source metadata must contain at least one source pin");
    }
    ensure_eq(&manifest.toolchain.wasmer, "7.2.0", "toolchain.wasmer")?;
    ensure_eq(
        &manifest.toolchain.wasmer_wasix,
        "0.702.0",
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
    let dockerfile =
        fs::read_to_string("src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile")
            .context("read WASIX build Dockerfile")?;
    if !dockerfile.contains(&format!(
        "FROM ubuntu:24.04@{}",
        manifest.toolchain.docker_image_digest
    )) {
        bail!(
            "WASIX build Dockerfile must pin the same base image digest as src/sources/toolchains/wasix.toml"
        );
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
        if !valid_source_name_component(&source.name)
            || source.url.trim().is_empty()
            || source.branch.trim().is_empty()
            || source.commit.len() < 40
        {
            bail!("invalid source pin in source metadata: {source:?}");
        }
        match source.kind {
            SourceKind::Git => {
                if source.sha256.is_some() || source.strip_prefix.is_some() {
                    bail!(
                        "git source '{}' must not set sha256 or strip-prefix",
                        source.name
                    );
                }
            }
            SourceKind::Archive => {
                let sha256 = archive_sha256(source)?;
                archive_strip_prefix(source)?;
                ensure_eq(
                    &source.commit,
                    &sha256,
                    &format!("{} archive commit must equal archive sha256", source.name),
                )?;
                if !source.url.ends_with(".tar.gz") && !source.url.ends_with(".tgz") {
                    bail!(
                        "archive source '{}' must point at a .tar.gz or .tgz URL",
                        source.name
                    );
                }
            }
        }
    }
    Ok(())
}

fn extension_source_pin_paths() -> Result<Vec<PathBuf>> {
    let root = Path::new("src/extensions/external");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    collect_extension_source_pin_paths(root, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn collect_extension_source_pin_paths(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    let mut entries = fs::read_dir(dir)
        .with_context(|| format!("read {}", dir.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("list {}", dir.display()))?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_extension_source_pin_paths(&path, paths)?;
        } else if path.file_name().and_then(|name| name.to_str()) == Some("source.toml") {
            paths.push(path);
        }
    }
    Ok(())
}

fn push_source_pin(
    sources: &mut Vec<SourcePin>,
    names: &mut BTreeSet<String>,
    path: &Path,
    origin: SourceOrigin,
) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut source: SourcePin =
        toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    source.origin = origin;
    if !names.insert(source.name.clone()) {
        bail!("duplicate source pin '{}' in source metadata", source.name);
    }
    sources.push(source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{SourceFetchScope, source_checkout_path};
    use crate::SOURCE_CHECKOUT_ROOT;
    use crate::asset_manifest::SourceOrigin;

    #[test]
    fn source_checkout_path_is_derived_from_portable_source_name() {
        assert_eq!(
            source_checkout_path("postgis").expect("valid source"),
            Path::new(SOURCE_CHECKOUT_ROOT).join("postgis")
        );
        assert_eq!(
            source_checkout_path("json-c").expect("valid source"),
            Path::new(SOURCE_CHECKOUT_ROOT).join("json-c")
        );

        assert!(source_checkout_path("").is_none());
        assert!(source_checkout_path("../postgis").is_none());
        assert!(source_checkout_path("nested/postgis").is_none());
        assert!(source_checkout_path("nested\\postgis").is_none());
    }

    #[test]
    fn runtime_fetch_scopes_include_extension_source_pins() {
        assert!(SourceFetchScope::NativeRuntime.includes(SourceOrigin::Extension));
        assert!(SourceFetchScope::WasixRuntime.includes(SourceOrigin::Extension));
        assert!(SourceFetchScope::Extensions.includes(SourceOrigin::Extension));
    }
}
