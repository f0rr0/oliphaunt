use super::*;

pub(crate) const ASSET_INPUT_PATHS: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".github/actions/setup-wasmer-llvm",
    "src/postgres/versions/18",
    "src/sources/third-party",
    "src/sources/toolchains/wasix.toml",
    "src/shared/extension-runtime-contract",
    "src/extensions/catalog/extensions.promoted.toml",
    "src/extensions/contrib",
    "src/extensions/external",
    WASIX_BUILD_SOURCE_ROOT,
    "src/runtimes/liboliphaunt/native/portable-uuid",
    "src/runtimes/liboliphaunt/wasix/moon.yml",
    "src/runtimes/liboliphaunt/wasix/tools",
    "src/runtimes/liboliphaunt/wasix/crates/assets",
    "src/runtimes/liboliphaunt/wasix/crates/aot",
    "src/runtimes/liboliphaunt/wasix/crates/tools",
    "src/runtimes/liboliphaunt/wasix/crates/tools-aot",
];

pub(crate) const WASIX_XTASK_BINARY_PRODUCER_INPUTS: &[&str] = &[
    "tools/xtask/Cargo.toml",
    "tools/xtask/src/aot_serializer.rs",
    "tools/xtask/src/asset_fingerprint.rs",
    "tools/xtask/src/asset_manifest.rs",
    "tools/xtask/src/asset_pipeline.rs",
    "tools/xtask/src/extension_catalog.rs",
    "tools/xtask/src/fs_utils.rs",
    "tools/xtask/src/main.rs",
    "tools/xtask/src/postgres_guard.rs",
    "tools/xtask/src/template_runner.rs",
];

pub(crate) fn asset_input_fingerprint() -> Result<String> {
    let mut git_arguments = vec!["ls-files", "--cached", "--others", "--exclude-standard"];
    git_arguments.extend_from_slice(ASSET_INPUT_PATHS);
    git_arguments.extend_from_slice(WASIX_XTASK_BINARY_PRODUCER_INPUTS);
    let tracked = command_output("git", &git_arguments, Path::new("."))?;
    let mut files = tracked
        .lines()
        .filter(|line| {
            Path::new(line).exists()
                && is_asset_binary_semantic_input(line)
                && !line.starts_with("src/runtimes/liboliphaunt/wasix/assets/build/build/")
                && !line.starts_with("src/runtimes/liboliphaunt/wasix/assets/build/work/")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    if files.is_empty() {
        bail!("no tracked asset input files found");
    }

    let mut hasher = Sha256::new();
    for file in files {
        let bytes = asset_input_fingerprint_bytes(&file)?;
        hasher.update(file.as_bytes());
        hasher.update([0]);
        hasher.update(sha256_bytes(&bytes).as_bytes());
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Return whether a tracked candidate can change the produced WASIX binary bytes.
///
/// Product versions, changelogs, registry coordinates, package descriptions,
/// legal-data envelopes, and smoke-test expectations are intentionally excluded
/// from the expensive portable/AOT build fingerprint. Source pins, patches,
/// build recipes, compiler/toolchain inputs, and exact byte producers remain.
pub(crate) fn is_asset_binary_semantic_input(file: &str) -> bool {
    if file.starts_with("tools/xtask/") {
        return WASIX_XTASK_BINARY_PRODUCER_INPUTS.contains(&file);
    }
    if file == "src/runtimes/liboliphaunt/wasix/moon.yml" {
        return true;
    }
    if file.starts_with("src/sources/toolchains/") && file != "src/sources/toolchains/wasix.toml" {
        return false;
    }
    if file.contains("/testdata/") || file.ends_with(".test.sh") || file.ends_with(".test.mjs") {
        return false;
    }

    let name = Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    !matches!(
        name,
        ".release-semantic-inputs.json"
            | "CHANGELOG.md"
            | "VERSION"
            | "artifacts.toml"
            | "publication-blocker.toml"
            | "release.toml"
            | "README.md"
            | "moon.yml"
            | "smoke.sql"
            | "regression.sql"
            | "blockers.toml"
            | "upstream-license-data.json"
    )
}

fn asset_input_fingerprint_bytes(file: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(file).with_context(|| format!("read {file}"))?;
    if file == "Cargo.lock" {
        let text = String::from_utf8(bytes).context("read Cargo.lock as UTF-8")?;
        return Ok(normalize_workspace_lockfile(&text).into_bytes());
    }
    if !file.ends_with("/Cargo.toml") && file != "Cargo.toml" {
        return Ok(bytes);
    }

    let text = String::from_utf8(bytes).with_context(|| format!("read {file} as UTF-8"))?;
    Ok(normalize_internal_asset_package_manifest(&text).into_bytes())
}

pub(crate) fn normalize_internal_asset_package_manifest(text: &str) -> String {
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

pub(crate) fn normalize_workspace_lockfile(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut chunks = text.split("[[package]]");
    normalized.push_str(chunks.next().unwrap_or_default());
    for chunk in chunks {
        normalized.push_str("[[package]]");
        if chunk.lines().any(|line| is_toml_key(line, "source")) {
            normalized.push_str(chunk);
            continue;
        }

        for line in chunk.split_inclusive('\n') {
            let logical = line
                .strip_suffix('\n')
                .unwrap_or(line)
                .strip_suffix('\r')
                .unwrap_or_else(|| line.strip_suffix('\n').unwrap_or(line));
            if is_toml_key(logical, "version") {
                let indent_len = logical.len() - logical.trim_start().len();
                normalized.push_str(&logical[..indent_len]);
                normalized.push_str("version = \"<release-version>\"");
                if line.ends_with("\r\n") {
                    normalized.push('\r');
                }
                if line.ends_with('\n') {
                    normalized.push('\n');
                }
            } else {
                normalized.push_str(line);
            }
        }
    }
    normalized
}

fn is_toml_key(line: &str, key: &str) -> bool {
    line.trim_start()
        .strip_prefix(key)
        .is_some_and(|rest| rest.trim_start().starts_with('='))
}
