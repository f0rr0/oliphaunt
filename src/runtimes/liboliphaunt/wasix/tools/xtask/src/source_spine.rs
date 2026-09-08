use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

use super::*;

pub(super) fn check_sources_manifest() -> Result<SourcesManifest> {
    let manifest = load_sources_manifest()?;
    validate_sources_manifest(&manifest)?;
    println!("validated {} pinned asset sources", manifest.sources.len());
    Ok(manifest)
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
            *prefix == "."
                || (!prefix.is_empty()
                    && !prefix.contains("..")
                    && prefix
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_ascii_alphanumeric())
                    && prefix.chars().all(|ch| {
                        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+')
                    }))
        })
        .ok_or_else(|| anyhow!("archive source '{}' has invalid strip-prefix", source.name))
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
        .join("../../../../../..")
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
            push_source_pin(&mut sources, &mut names, &path)?;
        }
    }
    for path in extension_source_pin_paths()? {
        push_source_pin(&mut sources, &mut names, &path)?;
    }

    Ok(SourcesManifest {
        toolchain: wasix.toolchain,
        sources,
    })
}

pub(super) fn validate_sources_manifest(manifest: &SourcesManifest) -> Result<()> {
    if manifest.sources.is_empty() {
        bail!("source metadata must contain at least one source pin");
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
            if !url_path.ends_with(".tar.gz")
                && !url_path.ends_with(".tgz")
                && !url_path.ends_with(".zip")
            {
                bail!(
                    "archive source '{}' must point at a .tar.gz, .tgz, or .zip URL",
                    source.name
                );
            }
            if source.strip_prefix.as_deref() == Some(".") && !url_path.ends_with(".zip") {
                bail!(
                    "archive source '{}' may use a rootless strip prefix only for ZIP releases",
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
) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let source: SourcePin =
        toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    if !names.insert(source.name.clone()) {
        bail!("duplicate source pin '{}' in source metadata", source.name);
    }
    sources.push(source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{valid_git_branch_name, valid_https_source_url, validate_source_pin};
    use crate::{SourceKind, SourcePin};

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
        }
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
        };

        let error = validate_source_pin(&source).expect_err("archive mirror metadata must fail");
        assert!(
            error
                .to_string()
                .contains("archive source 'libiconv' must not set mirror_url"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn rootless_zip_release_is_a_valid_pinned_archive_source() {
        let sha256 = "8577bb036a5c08204b1622a85485b92cdfaea521c251d22fd36899e99e426d9a";
        let mut source = SourcePin {
            name: "icu-data".to_owned(),
            kind: SourceKind::Archive,
            url: "https://github.com/unicode-org/icu/releases/download/release-76-1/icu4c-76_1-data-bin-l.zip".to_owned(),
            mirror_url: None,
            branch: "release-76-1".to_owned(),
            commit: sha256.to_owned(),
            source_date_epoch: None,
            sha256: Some(sha256.to_owned()),
            strip_prefix: Some(".".to_owned()),
        };
        validate_source_pin(&source).expect("pinned rootless ZIP release must pass");

        source.url = "https://example.test/icu-data.tar.gz".to_owned();
        let error = validate_source_pin(&source)
            .expect_err("rootless tar releases must remain unsupported");
        assert!(
            error
                .to_string()
                .contains("rootless strip prefix only for ZIP releases"),
            "unexpected error: {error:#}"
        );
    }
}
