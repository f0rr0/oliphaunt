use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
            run_hardened_source_fetch(source_scope)?;
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

    fn as_arg(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::NativeRuntime => "native-runtime",
            Self::WasixRuntime => "wasix-runtime",
            Self::Extensions => "extensions",
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

fn run_hardened_source_fetch(scope: SourceFetchScope) -> Result<()> {
    let mut command = Command::new("tools/dev/bun.sh");
    command.args(["tools/policy/fetch-sources.mjs", scope.as_arg(), "--force"]);
    run_command(&mut command).with_context(|| {
        format!(
            "materialize {} sources through the hardened source acquisition spine",
            scope.as_arg()
        )
    })
}

fn archive_sha256(source: &SourcePin) -> Result<String> {
    let sha256 = source
        .sha256
        .as_deref()
        .ok_or_else(|| anyhow!("archive source '{}' is missing sha256", source.name))?;
    ensure!(
        sha256.len() == 64
            && sha256
                .chars()
                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)),
        "archive source '{}' has invalid lowercase sha256 {}",
        source.name,
        sha256
    );
    Ok(sha256.to_owned())
}

fn archive_strip_prefix(source: &SourcePin) -> Result<&str> {
    source
        .strip_prefix
        .as_deref()
        .filter(|prefix| {
            !prefix.is_empty()
                && !prefix.contains("..")
                && prefix
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_alphanumeric())
                && prefix
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+'))
        })
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

fn valid_https_source_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    if rest.is_empty()
        || rest.contains('#')
        || rest.contains('\\')
        || rest.chars().any(char::is_whitespace)
    {
        return false;
    }
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, valid_port) = match authority.rsplit_once(':') {
        Some((host, port)) => (
            host,
            !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()),
        ),
        None => (authority, true),
    };
    valid_port
        && !host.is_empty()
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.'))
}

fn valid_git_branch_name(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with(['-', '/'])
        && !branch.ends_with(['/', '.'])
        && !branch.contains("..")
        && !branch.contains("@{")
        && !branch.chars().any(|ch| {
            ch.is_ascii_control()
                || ch.is_ascii_whitespace()
                || matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
        && branch
            .split('/')
            .all(|part| !part.is_empty() && !part.ends_with(".lock"))
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
        builder: wasix.builder,
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
    ensure_eq(
        &manifest.toolchain.wasmer_llvm,
        "22.1",
        "toolchain.wasmer_llvm",
    )?;
    ensure_eq(
        &manifest.toolchain.wasixcc.version,
        "0.4.3",
        "toolchain.wasixcc.version",
    )?;
    ensure_eq(
        &manifest.toolchain.wasixcc.target,
        "x86_64-unknown-linux-gnu",
        "toolchain.wasixcc.target",
    )?;
    ensure_eq(
        &manifest.toolchain.sysroots.version,
        "2026-03-02.1",
        "toolchain.sysroots.version",
    )?;
    ensure_eq(
        &manifest.toolchain.llvm.release,
        "21.1.204",
        "toolchain.llvm.release",
    )?;
    ensure_eq(
        &manifest.toolchain.llvm.reported_version,
        "21.1.2",
        "toolchain.llvm.reported_version",
    )?;
    ensure_eq(
        &manifest.toolchain.binaryen.release,
        "version_130",
        "toolchain.binaryen.release",
    )?;
    ensure_eq(
        &manifest.toolchain.binaryen.reported_version,
        "130",
        "toolchain.binaryen.reported_version",
    )?;
    ensure_eq(
        &manifest.toolchain.assets_manifest,
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/pinned-wasixcc-assets.tsv",
        "toolchain.assets_manifest",
    )?;
    if !manifest
        .toolchain
        .assets_manifest_sha256
        .chars()
        .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        || manifest.toolchain.assets_manifest_sha256.len() != 64
    {
        bail!(
            "toolchain.assets_manifest_sha256 must be a lowercase sha256 digest, got {}",
            manifest.toolchain.assets_manifest_sha256
        );
    }
    let assets_manifest_path = Path::new(&manifest.toolchain.assets_manifest);
    ensure_eq(
        &sha256_file(assets_manifest_path)?,
        &manifest.toolchain.assets_manifest_sha256,
        "toolchain assets manifest SHA-256",
    )?;
    let assets_manifest = fs::read_to_string(assets_manifest_path)
        .with_context(|| format!("read {}", assets_manifest_path.display()))?;
    for (asset, digest) in [
        (
            manifest.toolchain.wasixcc.asset.as_str(),
            manifest.toolchain.wasixcc.sha256.as_str(),
        ),
        (
            "sysroot.tar.gz",
            manifest.toolchain.sysroots.sysroot_sha256.as_str(),
        ),
        (
            "sysroot-eh.tar.gz",
            manifest.toolchain.sysroots.sysroot_eh_sha256.as_str(),
        ),
        (
            "sysroot-ehpic.tar.gz",
            manifest.toolchain.sysroots.sysroot_ehpic_sha256.as_str(),
        ),
        (
            "sysroot-exnref-eh.tar.gz",
            manifest
                .toolchain
                .sysroots
                .sysroot_exnref_eh_sha256
                .as_str(),
        ),
        (
            "sysroot-exnref-ehpic.tar.gz",
            manifest
                .toolchain
                .sysroots
                .sysroot_exnref_ehpic_sha256
                .as_str(),
        ),
        (
            manifest.toolchain.llvm.asset.as_str(),
            manifest.toolchain.llvm.sha256.as_str(),
        ),
        (
            manifest.toolchain.binaryen.asset.as_str(),
            manifest.toolchain.binaryen.sha256.as_str(),
        ),
    ] {
        if !assets_manifest.lines().any(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            fields.len() == 5 && fields[1] == asset && fields[3] == digest
        }) {
            bail!("toolchain assets manifest does not bind {asset} to metadata digest {digest}");
        }
    }
    ensure_eq(
        &manifest.builder.base_image,
        "ubuntu:24.04",
        "builder.base_image",
    )?;
    if !manifest
        .builder
        .base_image_digest
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit()))
    {
        bail!(
            "builder.base_image_digest must pin a concrete sha256 digest, got {}",
            manifest.builder.base_image_digest
        );
    }
    if manifest.builder.apt_snapshot.len() != 16
        || !manifest.builder.apt_snapshot.ends_with('Z')
        || manifest.builder.apt_snapshot.as_bytes()[8] != b'T'
        || !manifest
            .builder
            .apt_snapshot
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || index == 15 || byte.is_ascii_digit())
    {
        bail!(
            "builder.apt_snapshot must be a fixed YYYYMMDDTHHMMSSZ timestamp, got {}",
            manifest.builder.apt_snapshot
        );
    }
    if manifest.builder.apt_snapshot_retention.trim().is_empty() {
        bail!("builder.apt_snapshot_retention must document the snapshot retention boundary");
    }
    let dockerfile_frontend = manifest
        .builder
        .dockerfile_frontend
        .strip_prefix("docker/dockerfile:")
        .and_then(|frontend| frontend.split_once("@sha256:"));
    if !dockerfile_frontend.is_some_and(|(version, digest)| {
        !version.is_empty()
            && version != "latest"
            && version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        bail!(
            "builder.dockerfile_frontend must pin docker/dockerfile by lowercase sha256 digest, got {}",
            manifest.builder.dockerfile_frontend
        );
    }
    ensure_eq(
        &manifest.builder.snapshot_tls_root,
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/isrg-root-x1.pem",
        "builder.snapshot_tls_root",
    )?;
    if manifest.builder.snapshot_tls_root_sha256.len() != 64
        || !manifest
            .builder
            .snapshot_tls_root_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!(
            "builder.snapshot_tls_root_sha256 must be a lowercase sha256 digest, got {}",
            manifest.builder.snapshot_tls_root_sha256
        );
    }
    let tls_root_not_after = manifest.builder.snapshot_tls_root_not_after.as_bytes();
    if tls_root_not_after.len() != 20
        || !tls_root_not_after.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) && *byte == b'-'
                || index == 10 && *byte == b'T'
                || matches!(index, 13 | 16) && *byte == b':'
                || index == 19 && *byte == b'Z'
                || !matches!(index, 4 | 7 | 10 | 13 | 16 | 19) && byte.is_ascii_digit()
        })
    {
        bail!(
            "builder.snapshot_tls_root_not_after must be a UTC YYYY-MM-DDTHH:MM:SSZ timestamp, got {}",
            manifest.builder.snapshot_tls_root_not_after
        );
    }
    ensure_eq(
        &sha256_file(Path::new(&manifest.builder.snapshot_tls_root))?,
        &manifest.builder.snapshot_tls_root_sha256,
        "builder snapshot TLS root SHA-256",
    )?;
    let dockerfile =
        fs::read_to_string("src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile")
            .context("read WASIX build Dockerfile")?;
    let apt_installer = fs::read_to_string(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.sh",
    )
    .context("read WASIX pinned APT installer")?;
    if !dockerfile.contains(&format!(
        "FROM {}@{}",
        manifest.builder.base_image, manifest.builder.base_image_digest
    )) {
        bail!(
            "WASIX build Dockerfile must pin the same builder base image digest as src/sources/toolchains/wasix.toml"
        );
    }
    if dockerfile.lines().next()
        != Some(format!("# syntax={}", manifest.builder.dockerfile_frontend).as_str())
    {
        bail!("WASIX build Dockerfile must pin the declared Dockerfile frontend digest");
    }
    if !dockerfile.contains(&format!(
        "OLIPHAUNT_WASIXCC_ASSET_MANIFEST_SHA256={}",
        manifest.toolchain.assets_manifest_sha256
    )) {
        bail!("WASIX build Dockerfile must pin the toolchain asset manifest SHA-256");
    }
    if !dockerfile.contains(&format!(
        "OLIPHAUNT_UBUNTU_APT_SNAPSHOT={}",
        manifest.builder.apt_snapshot
    )) || !dockerfile.contains("COPY --chmod=0555 install-pinned-apt-packages.sh")
        || !dockerfile.contains("--snapshot \"$OLIPHAUNT_UBUNTU_APT_SNAPSHOT\"")
    {
        bail!(
            "WASIX build Dockerfile must pass the declared Ubuntu snapshot to the pinned APT installer"
        );
    }
    if !dockerfile.contains(&format!(
        "OLIPHAUNT_UBUNTU_SNAPSHOT_TLS_ROOT_SHA256={}",
        manifest.builder.snapshot_tls_root_sha256
    )) || !dockerfile
        .contains("COPY --chmod=0444 isrg-root-x1.pem /usr/local/share/oliphaunt/isrg-root-x1.pem")
        || !dockerfile.contains("/etc/ssl/certs/ca-certificates.crt")
        || !dockerfile.contains("sha256sum --check --strict")
    {
        bail!("WASIX build Dockerfile must verify and install the declared snapshot TLS root");
    }
    if dockerfile.contains("Verify-Peer=false") || apt_installer.contains("Verify-Peer=false") {
        bail!("WASIX snapshot acquisition must not disable TLS peer verification");
    }
    for forbidden in ["raw.githubusercontent.com/wasix-org/wasixcc", "latest"] {
        if dockerfile.contains(forbidden) {
            bail!(
                "WASIX build Dockerfile contains forbidden mutable installer input {forbidden:?}"
            );
        }
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
        validate_source_pin(source)?;
    }
    Ok(())
}

fn validate_source_pin(source: &SourcePin) -> Result<()> {
    if !valid_source_name_component(&source.name)
        || !valid_https_source_url(&source.url)
        || source
            .mirror_url
            .as_deref()
            .is_some_and(|url| !valid_https_source_url(url))
        || !valid_git_branch_name(&source.branch)
    {
        bail!("invalid source pin in source metadata: {source:?}");
    }
    if source
        .source_date_epoch
        .is_some_and(|epoch| epoch == 0 || epoch > 253_402_300_799)
    {
        bail!(
            "source '{}' source_date_epoch must be within the portable UTC range 1..=253402300799",
            source.name
        );
    }
    if source.name == "postgis" && source.source_date_epoch.is_none() {
        bail!("PostGIS source metadata must pin source_date_epoch");
    }
    match source.kind {
        SourceKind::Git => {
            if source.commit.len() != 40
                || !source
                    .commit
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
            {
                bail!(
                    "git source '{}' must pin an exact lowercase 40-hex commit",
                    source.name
                );
            }
            if source.sha256.is_some() || source.strip_prefix.is_some() {
                bail!(
                    "git source '{}' must not set sha256 or strip-prefix",
                    source.name
                );
            }
            if source.mirror_url.as_deref() == Some(source.url.as_str()) {
                bail!(
                    "git source '{}' mirror URL must differ from its primary URL",
                    source.name
                );
            }
        }
        SourceKind::Archive => {
            if source.mirror_url.is_some() {
                bail!("archive source '{}' must not set mirror_url", source.name);
            }
            let sha256 = archive_sha256(source)?;
            archive_strip_prefix(source)?;
            ensure_eq(
                &source.commit,
                &sha256,
                &format!("{} archive commit must equal archive sha256", source.name),
            )?;
            let url_path = source.url.split('?').next().unwrap_or_default();
            if !url_path.ends_with(".tar.gz") && !url_path.ends_with(".tgz") {
                bail!(
                    "archive source '{}' must point at a .tar.gz or .tgz URL",
                    source.name
                );
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

    use super::{
        SourceFetchScope, source_checkout_path, valid_git_branch_name, valid_https_source_url,
        validate_source_pin,
    };
    use crate::{SOURCE_CHECKOUT_ROOT, SourceKind, SourceOrigin, SourcePin};

    fn git_source(mirror_url: Option<&str>) -> SourcePin {
        SourcePin {
            name: "libxml2".to_owned(),
            kind: SourceKind::Git,
            url: "https://gitlab.gnome.org/GNOME/libxml2.git".to_owned(),
            mirror_url: mirror_url.map(str::to_owned),
            branch: "v2.14.6".to_owned(),
            commit: "d23960a130c5bb82779c9405fbbf85e65fb3c57c".to_owned(),
            source_date_epoch: None,
            sha256: None,
            strip_prefix: None,
            origin: SourceOrigin::Extension,
        }
    }

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
    fn rust_fetch_scopes_delegate_to_the_authoritative_fetcher() {
        assert_eq!(SourceFetchScope::All.as_arg(), "all");
        assert_eq!(SourceFetchScope::NativeRuntime.as_arg(), "native-runtime");
        assert_eq!(SourceFetchScope::WasixRuntime.as_arg(), "wasix-runtime");
        assert_eq!(SourceFetchScope::Extensions.as_arg(), "extensions");
    }

    #[test]
    fn source_transport_and_branch_validation_reject_unsafe_inputs() {
        assert!(valid_https_source_url(
            "https://github.com/example/source.git"
        ));
        assert!(valid_https_source_url(
            "https://example.test:8443/source.tgz?mirror=1"
        ));
        for url in [
            "http://github.com/example/source.git",
            "ssh://git@github.com/example/source.git",
            "https://user:secret@example.test/source.git",
            "https://example.test/source.git#mutable",
            "https://example.test\\source.git",
        ] {
            assert!(!valid_https_source_url(url), "unexpectedly accepted {url}");
        }

        assert!(valid_git_branch_name("oliphaunt/pinned-source"));
        for branch in ["", "-force", "../main", "main.lock", "main~1", "bad name"] {
            assert!(
                !valid_git_branch_name(branch),
                "unexpectedly accepted {branch}"
            );
        }
    }

    #[test]
    fn git_source_mirror_must_be_a_distinct_canonical_https_url() {
        validate_source_pin(&git_source(Some("https://github.com/GNOME/libxml2.git")))
            .expect("valid HTTPS mirror");

        for mirror_url in [
            "http://github.com/GNOME/libxml2.git",
            "https://user:secret@github.com/GNOME/libxml2.git",
            "https://github.com/GNOME/libxml2.git#mutable",
        ] {
            let error = validate_source_pin(&git_source(Some(mirror_url)))
                .expect_err("unsafe mirror URL must fail");
            assert!(
                error.to_string().contains("invalid source pin"),
                "unexpected error for {mirror_url}: {error:#}"
            );
        }

        let primary = "https://gitlab.gnome.org/GNOME/libxml2.git";
        let error = validate_source_pin(&git_source(Some(primary)))
            .expect_err("primary URL reused as mirror must fail");
        assert!(
            error
                .to_string()
                .contains("mirror URL must differ from its primary URL"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn postgis_requires_one_portable_source_date_epoch() {
        let mut source = git_source(None);
        source.name = "postgis".to_owned();
        source.url = "https://github.com/postgis/postgis.git".to_owned();
        source.branch = "3.6.3".to_owned();
        source.commit = "3d12666588a84b23a3147618eaa9b40b0fe5e796".to_owned();

        let error = validate_source_pin(&source).expect_err("missing epoch must fail");
        assert!(
            error
                .to_string()
                .contains("PostGIS source metadata must pin source_date_epoch"),
            "unexpected error: {error:#}"
        );

        for invalid_epoch in [0, 253_402_300_800] {
            source.source_date_epoch = Some(invalid_epoch);
            let error = validate_source_pin(&source).expect_err("invalid epoch must fail");
            assert!(
                error
                    .to_string()
                    .contains("source_date_epoch must be within the portable UTC range"),
                "unexpected error for {invalid_epoch}: {error:#}"
            );
        }

        source.source_date_epoch = Some(1_776_193_981);
        validate_source_pin(&source).expect("canonical PostGIS epoch must pass");
    }

    #[test]
    fn archive_sources_reject_git_mirror_metadata() {
        let sha256 = "88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6";
        let source = SourcePin {
            name: "libiconv".to_owned(),
            kind: SourceKind::Archive,
            url: "https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz".to_owned(),
            mirror_url: Some("https://example.test/libiconv-1.19.tar.gz".to_owned()),
            branch: "1.19".to_owned(),
            commit: sha256.to_owned(),
            source_date_epoch: None,
            sha256: Some(sha256.to_owned()),
            strip_prefix: Some("libiconv-1.19".to_owned()),
            origin: SourceOrigin::Extension,
        };

        let error = validate_source_pin(&source).expect_err("archive mirror metadata must fail");
        assert!(
            error
                .to_string()
                .contains("archive source 'libiconv' must not set mirror_url"),
            "unexpected error: {error:#}"
        );
    }
}
