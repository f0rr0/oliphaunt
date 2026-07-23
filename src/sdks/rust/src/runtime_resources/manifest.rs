use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

use super::NativeExtensionStaticSymbolAlias;
use super::extension_artifact::{
    mobile_static_archive_artifact_relative_path,
    mobile_static_dependency_archive_artifact_relative_path,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MobileStaticArchive {
    pub(super) target: String,
    pub(super) relative_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MobileStaticDependencyArchive {
    pub(super) target: String,
    pub(super) name: String,
    pub(super) relative_path: PathBuf,
}

pub(super) fn parse_canonical_properties_manifest(
    path: &Path,
    text: &str,
    expected_keys: &[&str],
) -> Result<BTreeMap<String, String>> {
    if text.starts_with('\u{feff}')
        || text.contains('\r')
        || text.contains('\\')
        || !text.ends_with('\n')
        || text.ends_with("\n\n")
        || text
            .chars()
            .any(|value| (value < ' ' && value != '\n') || value == '\u{7f}')
    {
        return Err(Error::InvalidConfig(format!(
            "manifest {} must be canonical key=value text with LF lines and exactly one final newline",
            path.display()
        )));
    }
    let lines = text[..text.len() - 1].split('\n').collect::<Vec<_>>();
    let mut properties = BTreeMap::new();
    let mut parsed_keys = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let Some((key, value)) = line.split_once('=') else {
            return Err(Error::InvalidConfig(format!(
                "manifest {} line {} must use key=value syntax",
                path.display(),
                index + 1
            )));
        };
        if key.is_empty() || key.trim() != key || value.trim() != value || line.trim() != *line {
            return Err(Error::InvalidConfig(format!(
                "manifest {} line {} must be canonical key=value text without surrounding whitespace",
                path.display(),
                index + 1
            )));
        }
        if properties
            .insert(key.to_owned(), value.to_owned())
            .is_some()
        {
            return Err(Error::InvalidConfig(format!(
                "manifest {} repeats key '{key}'",
                path.display()
            )));
        }
        parsed_keys.push(key);
    }
    require_exact_manifest_keys(path, &properties, expected_keys)?;
    for (index, (actual_key, expected_key)) in parsed_keys.iter().zip(expected_keys).enumerate() {
        if actual_key != expected_key {
            return Err(Error::InvalidConfig(format!(
                "manifest {} line {} must be canonical field {}",
                path.display(),
                index + 1,
                expected_key
            )));
        }
    }
    Ok(properties)
}

pub(super) fn required_manifest_value<'a>(
    path: &Path,
    manifest: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str> {
    manifest
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            Error::InvalidConfig(format!("manifest {} is missing '{key}'", path.display()))
        })
}

pub(super) fn require_property(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
    expected: &str,
) -> Result<()> {
    let actual = required_manifest_value(path, manifest, key)?;
    if actual == expected {
        Ok(())
    } else {
        Err(Error::InvalidConfig(format!(
            "manifest {} has {key}='{actual}', expected '{expected}'",
            path.display()
        )))
    }
}

pub(super) fn require_exact_manifest_keys(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    expected_keys: &[&str],
) -> Result<()> {
    let expected = expected_keys.iter().copied().collect::<BTreeSet<_>>();
    let missing = expected
        .iter()
        .filter(|key| !manifest.contains_key(**key))
        .copied()
        .collect::<Vec<_>>();
    let unknown = manifest
        .keys()
        .map(String::as_str)
        .filter(|key| !expected.contains(key))
        .collect::<Vec<_>>();
    if missing.is_empty() && unknown.is_empty() {
        return Ok(());
    }
    Err(Error::InvalidConfig(format!(
        "manifest {} must contain the exact canonical field set; missing=[{}], unknown=[{}]",
        path.display(),
        missing.join(","),
        unknown.join(",")
    )))
}

pub(super) fn validate_stable_semver(value: &str, context: &str) -> Result<()> {
    let mut parts = value.split('.');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    };
    let valid = parts.next().is_some_and(valid_part)
        && parts.next().is_some_and(valid_part)
        && parts.next().is_some_and(valid_part)
        && parts.next().is_none();
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidConfig(format!(
            "{context} must be a stable semantic version in canonical X.Y.Z form, got '{value}'"
        )))
    }
}

pub(super) fn parse_manifest_bool(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
    default: bool,
) -> Result<bool> {
    let Some(value) = manifest.get(key) else {
        return Ok(default);
    };
    match value.trim() {
        "true" | "yes" => Ok(true),
        "false" | "no" => Ok(false),
        other => Err(Error::InvalidConfig(format!(
            "manifest {} has {key}='{other}', expected true/false",
            path.display()
        ))),
    }
}

pub(super) fn parse_manifest_yes_no(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<bool> {
    let value = required_manifest_value(path, manifest, key)?;
    if !matches!(value, "yes" | "no") {
        return Err(Error::InvalidConfig(format!(
            "manifest {} has {key}='{other}', expected canonical yes/no",
            path.display(),
            other = value
        )));
    }
    parse_manifest_bool(path, manifest, key, false)
}

pub(super) fn optional_manifest_id(
    _path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<String>> {
    let Some(value) = manifest.get(key).map(String::as_str).map(str::trim) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    validate_portable_id(value, key)?;
    Ok(Some(value.to_owned()))
}

pub(super) fn optional_manifest_c_identifier(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<String>> {
    let Some(value) = manifest.get(key).map(String::as_str).map(str::trim) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if !is_c_identifier(value) {
        return Err(Error::InvalidConfig(format!(
            "manifest {} has non-portable C identifier {key}='{value}'",
            path.display()
        )));
    }
    Ok(Some(value.to_owned()))
}

pub(super) fn parse_manifest_id_list(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<String>> {
    let out = canonical_manifest_list(path, manifest, key)?;
    for item in &out {
        validate_portable_id(item, key)?;
    }
    Ok(out)
}

pub(super) fn parse_manifest_relative_path_list(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for item in canonical_manifest_list(path, manifest, key)? {
        out.push(parse_portable_artifact_path_text(path, key, &item)?);
    }
    Ok(out)
}

fn canonical_manifest_list(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<String>> {
    let Some(value) = manifest.get(key) else {
        return Ok(Vec::new());
    };
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let values = value.split(',').map(str::to_owned).collect::<Vec<_>>();
    if values
        .iter()
        .any(|item| item.is_empty() || item.trim() != item)
    {
        return Err(Error::InvalidConfig(format!(
            "manifest {} {key} must be a canonical comma-separated list",
            path.display()
        )));
    }
    let mut canonical = values.clone();
    canonical.sort();
    canonical.dedup();
    if values != canonical {
        return Err(Error::InvalidConfig(format!(
            "manifest {} {key} must be sorted and unique",
            path.display()
        )));
    }
    Ok(values)
}

pub(super) fn parse_manifest_static_symbol_aliases(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<NativeExtensionStaticSymbolAlias>> {
    let Some(value) = manifest.get(key) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut sql_symbols = BTreeSet::new();
    for item in split_manifest_list(value) {
        let Some((sql_symbol, linked_symbol)) = item.split_once(':') else {
            return Err(Error::InvalidConfig(format!(
                "manifest {} {key} entry '{}' must use <sql-symbol>:<linked-symbol>",
                path.display(),
                item
            )));
        };
        if !is_c_identifier(sql_symbol) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} has non-portable static symbol alias source '{}'",
                path.display(),
                sql_symbol
            )));
        }
        if !is_c_identifier(linked_symbol) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} has non-portable static symbol alias target '{}'",
                path.display(),
                linked_symbol
            )));
        }
        if !sql_symbols.insert(sql_symbol.to_owned()) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} repeats static symbol alias for '{}'",
                path.display(),
                sql_symbol
            )));
        }
        out.push(NativeExtensionStaticSymbolAlias::new(
            sql_symbol,
            linked_symbol,
        ));
    }
    out.sort_by(|left, right| {
        left.sql_symbol
            .cmp(&right.sql_symbol)
            .then_with(|| left.linked_symbol.cmp(&right.linked_symbol))
    });
    Ok(out)
}

pub(super) fn parse_manifest_mobile_static_archives(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<MobileStaticArchive>> {
    let Some(value) = manifest.get(key) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut targets = BTreeSet::new();
    for item in split_manifest_list(value) {
        let Some((target, relative)) = item.split_once(':') else {
            return Err(Error::InvalidConfig(format!(
                "manifest {} {key} entry '{}' must use <target>:<relative-path>",
                path.display(),
                item
            )));
        };
        validate_portable_id(target, key)?;
        if !targets.insert(target.to_owned()) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} repeats mobile static archive target '{}'",
                path.display(),
                target
            )));
        }
        let relative_path = parse_portable_artifact_path_text(path, key, relative)?;
        out.push(MobileStaticArchive {
            target: target.to_owned(),
            relative_path,
        });
    }
    out.sort_by(|left, right| left.target.cmp(&right.target));
    Ok(out)
}

pub(super) fn parse_manifest_mobile_static_dependency_archives(
    path: &Path,
    manifest: &BTreeMap<String, String>,
    key: &str,
) -> Result<Vec<MobileStaticDependencyArchive>> {
    let Some(value) = manifest.get(key) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut keys = BTreeSet::new();
    for item in split_manifest_list(value) {
        let mut parts = item.splitn(3, ':');
        let target = parts.next().unwrap_or_default();
        let name = parts.next().unwrap_or_default();
        let relative = parts.next().unwrap_or_default();
        if target.is_empty() || name.is_empty() || relative.is_empty() {
            return Err(Error::InvalidConfig(format!(
                "manifest {} {key} entry '{}' must use <target>:<name>:<relative-path>",
                path.display(),
                item
            )));
        }
        validate_portable_id(target, key)?;
        validate_portable_id(name, key)?;
        let entry_key = (target.to_owned(), name.to_owned());
        if !keys.insert(entry_key) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} repeats mobile static dependency archive '{}' for target '{}'",
                path.display(),
                name,
                target
            )));
        }
        let relative_path = parse_portable_artifact_path_text(path, key, relative)?;
        out.push(MobileStaticDependencyArchive {
            target: target.to_owned(),
            name: name.to_owned(),
            relative_path,
        });
    }
    out.sort_by(|left, right| {
        left.target
            .cmp(&right.target)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(out)
}

pub(super) fn validate_prebuilt_extension_mobile_static_archives(
    root: &Path,
    manifest_path: &Path,
    native_module_stem: Option<&str>,
    mobile_prebuilt: bool,
    archives: &[MobileStaticArchive],
) -> Result<()> {
    if !archives.is_empty() && native_module_stem.is_none() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} declares mobileStaticArchives without nativeModuleStem",
            manifest_path.display()
        )));
    }
    if mobile_prebuilt && native_module_stem.is_some() && archives.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} has mobilePrebuilt=yes for a native module but no mobileStaticArchives",
            manifest_path.display()
        )));
    }
    let expected_relative_paths = native_module_stem.map(|stem| {
        archives
            .iter()
            .map(|archive| {
                (
                    archive.target.clone(),
                    mobile_static_archive_artifact_relative_path(&archive.target, stem),
                )
            })
            .collect::<BTreeMap<_, _>>()
    });
    for archive in archives {
        if let Some(expected_relative_paths) = &expected_relative_paths {
            let expected = expected_relative_paths
                .get(&archive.target)
                .expect("target was created from archive list");
            if &archive.relative_path != expected {
                return Err(Error::InvalidConfig(format!(
                    "mobile static archive {} from manifest {} must use {}",
                    archive.relative_path.display(),
                    manifest_path.display(),
                    expected.display()
                )));
            }
        }
        let path = root.join(&archive.relative_path);
        let metadata = fs::symlink_metadata(&path).map_err(|err| {
            Error::InvalidConfig(format!(
                "stat mobile static archive {} from manifest {}: {err}",
                path.display(),
                manifest_path.display()
            ))
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::InvalidConfig(format!(
                "mobile static archive {} from manifest {} must be a regular file",
                path.display(),
                manifest_path.display()
            )));
        }
    }
    Ok(())
}

pub(super) fn validate_prebuilt_extension_mobile_static_dependency_archives(
    root: &Path,
    manifest_path: &Path,
    extension_archives: &[MobileStaticArchive],
    dependency_archives: &[MobileStaticDependencyArchive],
) -> Result<()> {
    if dependency_archives.is_empty() {
        return Ok(());
    }
    if extension_archives.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} declares mobileStaticDependencyArchives without mobileStaticArchives",
            manifest_path.display()
        )));
    }
    let extension_targets = extension_archives
        .iter()
        .map(|archive| archive.target.as_str())
        .collect::<BTreeSet<_>>();
    for archive in dependency_archives {
        if !extension_targets.contains(archive.target.as_str()) {
            return Err(Error::InvalidConfig(format!(
                "manifest {} declares mobile static dependency '{}' for target '{}' without a matching mobileStaticArchives target",
                manifest_path.display(),
                archive.name,
                archive.target
            )));
        }
        let file_name = archive
            .relative_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                Error::InvalidConfig(format!(
                    "mobile static dependency archive {} from manifest {} must include a portable file name",
                    archive.relative_path.display(),
                    manifest_path.display()
                ))
            })?;
        validate_portable_id(file_name, "mobile static dependency archive file")?;
        let expected = mobile_static_dependency_archive_artifact_relative_path(
            &archive.target,
            &archive.name,
            file_name,
        );
        if archive.relative_path != expected {
            return Err(Error::InvalidConfig(format!(
                "mobile static dependency archive {} from manifest {} must use {}",
                archive.relative_path.display(),
                manifest_path.display(),
                expected.display()
            )));
        }
        let path = root.join(&archive.relative_path);
        let metadata = fs::symlink_metadata(&path).map_err(|err| {
            Error::InvalidConfig(format!(
                "stat mobile static dependency archive {} from manifest {}: {err}",
                path.display(),
                manifest_path.display()
            ))
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::InvalidConfig(format!(
                "mobile static dependency archive {} from manifest {} must be a regular file",
                path.display(),
                manifest_path.display()
            )));
        }
    }
    Ok(())
}

fn split_manifest_list(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn validate_portable_id(value: &str, label: &str) -> Result<()> {
    if is_portable_module_stem(value) {
        Ok(())
    } else {
        Err(Error::InvalidConfig(format!(
            "{label} '{value}' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'"
        )))
    }
}

pub(super) fn validate_relative_artifact_path(
    manifest_path: &Path,
    key: &str,
    relative: &Path,
) -> Result<()> {
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} {key} entry '{}' must be a relative path",
            manifest_path.display(),
            relative.display()
        )));
    }
    for component in relative.components() {
        match component {
            Component::Normal(component) => {
                let component = component.to_str().ok_or_else(|| {
                    Error::InvalidConfig(format!(
                        "manifest {} {key} entry '{}' must use UTF-8 path text",
                        manifest_path.display(),
                        relative.display()
                    ))
                })?;
                validate_portable_artifact_path_component(
                    component,
                    &format!(
                        "manifest {} {key} entry '{}'",
                        manifest_path.display(),
                        relative.display()
                    ),
                )?;
            }
            _ => {
                return Err(Error::InvalidConfig(format!(
                    "manifest {} {key} entry '{}' must not contain '.', '..', prefixes, or root components",
                    manifest_path.display(),
                    relative.display()
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn parse_portable_artifact_path_text(
    manifest_path: &Path,
    key: &str,
    value: &str,
) -> Result<PathBuf> {
    if value.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} {key} entry must be a non-empty relative POSIX path",
            manifest_path.display()
        )));
    }
    let context = format!("manifest {} {key} entry {value:?}", manifest_path.display());
    let mut relative = PathBuf::new();
    for component in value.split('/') {
        validate_portable_artifact_path_component(component, &context)?;
        relative.push(component);
    }
    validate_relative_artifact_path(manifest_path, key, &relative)?;
    Ok(relative)
}

pub(super) fn render_portable_artifact_path(path: &Path, label: &str) -> Result<String> {
    let mut components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(Error::InvalidConfig(format!(
                "{label} '{}' must be a canonical relative path",
                path.display()
            )));
        };
        let component = component.to_str().ok_or_else(|| {
            Error::InvalidConfig(format!(
                "{label} '{}' must use UTF-8 path text",
                path.display()
            ))
        })?;
        validate_portable_artifact_path_component(
            component,
            &format!("{label} '{}'", path.display()),
        )?;
        components.push(component);
    }
    if components.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "{label} '{}' must not be empty",
            path.display()
        )));
    }
    Ok(components.join("/"))
}

pub(super) fn validate_portable_artifact_path_component(
    component: &str,
    context: &str,
) -> Result<()> {
    let has_forbidden_character = component.chars().any(|value| {
        value < ' ' || matches!(value, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    });
    let device_stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_uppercase();
    let windows_device_name = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || numbered_windows_device_name(&device_stem, "COM")
        || numbered_windows_device_name(&device_stem, "LPT");
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.ends_with(' ')
        || component.ends_with('.')
        || has_forbidden_character
        || windows_device_name
    {
        return Err(Error::InvalidConfig(format!(
            "{context} contains path component {component:?} that is unsafe on supported build hosts"
        )));
    }
    Ok(())
}

fn numbered_windows_device_name(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| matches!(suffix.as_bytes(), [b'1'..=b'9']))
}

pub(super) fn is_c_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn is_portable_module_stem(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_relative_paths_reject_host_specific_components() {
        for component in [
            "payload:name.bin",
            "CON",
            "con.txt",
            "PrN.notice",
            "AUX",
            "nul.json",
            "COM1",
            "com9.dll",
            "LPT1",
            "lpt9.log",
            "trailing-dot.",
            "trailing-space ",
            "control-\u{1f}",
            "question?.txt",
            "star*.txt",
            "quote\".txt",
            "less<.txt",
            "greater>.txt",
            "pipe|.txt",
            "literal\\backslash.txt",
        ] {
            let error =
                validate_portable_artifact_path_component(component, "contract test").unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("unsafe on supported build hosts"),
                "unexpected portable-path error for {component:?}: {error}"
            );
        }
        for path in [
            "C:/payload.bin",
            "/absolute/payload.bin",
            "literal\\backslash.txt",
            "double//separator",
            "trailing/",
            "./dot",
            "../escape",
        ] {
            assert!(
                parse_portable_artifact_path_text(
                    Path::new("contract-test"),
                    "artifact path",
                    path,
                )
                .is_err(),
                "consumer accepted non-portable path text {path:?}"
            );
        }
    }

    #[test]
    fn artifact_relative_paths_accept_portable_unicode_and_ordinary_components() {
        for path in [
            "files/share/postgresql/extension/acme--1.0.sql",
            "mobile-static/android-arm64-v8a/extensions/acme/libacme.a",
            "licenses/donn\u{e9}es/\u{8bb8}\u{53ef}\u{8bc1}.txt",
            "devices/COM0/LPT10.txt",
        ] {
            let parsed = parse_portable_artifact_path_text(
                Path::new("contract-test"),
                "artifact path",
                path,
            )
            .unwrap_or_else(|error| panic!("portable path {path:?} was rejected: {error}"));
            assert_eq!(
                render_portable_artifact_path(&parsed, "contract test").unwrap(),
                path
            );
        }
    }
}
