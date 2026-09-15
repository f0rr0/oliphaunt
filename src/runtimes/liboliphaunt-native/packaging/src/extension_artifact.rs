pub(super) fn mobile_static_dependency_archive_artifact_relative_path(
    target: &str,
    name: &str,
    file_name: &str,
) -> PathBuf {
    PathBuf::from("mobile-static")
        .join(target)
        .join("dependencies")
        .join(name)
        .join(file_name)
}

pub(super) fn mobile_static_archive_artifact_relative_path(target: &str, stem: &str) -> PathBuf {
    PathBuf::from("mobile-static")
        .join(target)
        .join("extensions")
        .join(stem)
        .join(format!("liboliphaunt_extension_{stem}.a"))
}

use super::*;
use std::path::Component;

const EXTENSION_ARTIFACT_ARCHIVE_POLICY: &str =
    include_str!("../../../../extensions/contracts/extension-artifact-archive-policy.properties");
const EXTENSION_ARTIFACT_ARCHIVE_POLICY_SCHEMA: &str =
    "oliphaunt-extension-artifact-archive-policy-v1";
const DESKTOP_NATIVE_TARGETS: [&str; 4] = [
    "linux-x64-gnu",
    "linux-arm64-gnu",
    "macos-arm64",
    "windows-x64-msvc",
];
const EXTENSION_ARTIFACT_BASE_LEGAL_MEMBERS: [&str; 2] = ["LICENSE", "THIRD_PARTY_NOTICES.md"];
pub(super) const EXTENSION_ARTIFACT_POSTGRESQL_LICENSE: &str =
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT";
pub(super) const EXTENSION_ARTIFACT_OPENSSL_LICENSE: &str =
    "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt";

fn extension_artifact_legal_members(
    profile: NativeExtensionArtifactLicenseProfile,
) -> Vec<PathBuf> {
    let mut members = EXTENSION_ARTIFACT_BASE_LEGAL_MEMBERS
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    match profile {
        NativeExtensionArtifactLicenseProfile::ContribNative => {
            members.push(PathBuf::from(EXTENSION_ARTIFACT_POSTGRESQL_LICENSE));
        }
        NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl => {
            members.push(PathBuf::from(EXTENSION_ARTIFACT_POSTGRESQL_LICENSE));
            members.push(PathBuf::from(EXTENSION_ARTIFACT_OPENSSL_LICENSE));
        }
        NativeExtensionArtifactLicenseProfile::ExternalNative => {}
    }
    members.sort();
    members
}

pub(super) fn validate_extension_artifact_license_paths(
    manifest_path: &Path,
    license_files: &[PathBuf],
) -> Result<()> {
    for relative in license_files {
        let mut components = relative.components();
        let in_license_namespace = matches!(components.next(), Some(Component::Normal(value)) if value == "share")
            && matches!(components.next(), Some(Component::Normal(value)) if value == "licenses")
            && components.next().is_some();
        if !in_license_namespace {
            return Err(Error::InvalidConfig(format!(
                "manifest {} licenseFiles entry '{}' must be an exact leaf below share/licenses/",
                manifest_path.display(),
                relative.display()
            )));
        }
    }
    Ok(())
}

pub(super) fn validate_extension_artifact_license_profile(
    manifest_path: &Path,
    sql_name: &str,
    native_target: Option<&str>,
    mobile_static_dependency_archives: &[MobileStaticDependencyArchive],
    profile: NativeExtensionArtifactLicenseProfile,
    license_files: &[PathBuf],
) -> Result<()> {
    let external = catalog::by_sql_name(sql_name)
        .and_then(|extension| extension.artifact_product.as_deref())
        .is_none_or(|product| product != "oliphaunt-extension-contrib-pg18");
    let embeds_openssl = !external
        && sql_name == "pgcrypto"
        && (matches!(native_target, Some("macos-arm64" | "windows-x64-msvc"))
            || mobile_static_dependency_archives
                .iter()
                .any(|archive| archive.name == "openssl"));
    let expected = if external {
        NativeExtensionArtifactLicenseProfile::ExternalNative
    } else if embeds_openssl {
        NativeExtensionArtifactLicenseProfile::ContribNativeOpenSsl
    } else {
        NativeExtensionArtifactLicenseProfile::ContribNative
    };
    if profile != expected {
        return Err(Error::InvalidConfig(format!(
            "manifest {} has licenseProfile='{}' for extension '{}' and target '{}', expected '{}'",
            manifest_path.display(),
            profile.as_str(),
            sql_name,
            native_target.unwrap_or(""),
            expected.as_str()
        )));
    }
    if external && license_files.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} external-native profile must declare at least one exact licenseFiles leaf",
            manifest_path.display()
        )));
    }
    if !external && !license_files.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "manifest {} contrib profile must not declare upstream licenseFiles leaves",
            manifest_path.display()
        )));
    }
    Ok(())
}

pub(super) fn validate_prebuilt_extension_leaf_inventory(
    root: &Path,
    manifest_path: &Path,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    let profile = extension.license_profile.ok_or_else(|| {
        Error::Engine(format!(
            "internal error: prebuilt extension {} has no legal profile",
            manifest_path.display()
        ))
    })?;
    let actual = extension_artifact_leaf_inventory(root)?;
    let mut expected = BTreeSet::from([PathBuf::from("manifest.properties")]);
    let mut legal_members = BTreeSet::new();
    for member in extension_artifact_legal_members(profile) {
        legal_members.insert(member.clone());
        expected.insert(member);
    }
    for relative in &extension.license_files {
        let member = PathBuf::from("files").join(relative);
        legal_members.insert(member.clone());
        expected.insert(member);
    }

    let extension_prefix = Path::new("files/share/postgresql/extension");
    let mut has_control = false;
    let mut has_install_sql = false;
    for relative in &actual {
        let Ok(file_name) = relative.strip_prefix(extension_prefix) else {
            continue;
        };
        if file_name.components().count() != 1 {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact {} contains undeclared extension SQL/control file {}",
                root.display(),
                relative.display()
            )));
        }
        let file_name = file_name.to_str().ok_or_else(|| {
            Error::InvalidConfig(format!(
                "prebuilt extension artifact {} has a non-UTF-8 extension SQL/control file {}",
                root.display(),
                relative.display()
            ))
        })?;
        if !runtime_extension_sql_file_belongs(extension, file_name) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact {} contains undeclared extension SQL/control file {}",
                root.display(),
                relative.display()
            )));
        }
        expected.insert(relative.clone());
        has_control |= file_name == format!("{}.control", extension.sql_name);
        has_install_sql |= extension_install_sql_file_belongs(&extension.sql_name, file_name);
    }
    if extension.creates_extension && (!has_control || !has_install_sql) {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} for '{}' must include its control file and at least one canonical base install SQL file",
            root.display(),
            extension.sql_name
        )));
    }
    for relative in &extension.data_files {
        expected.insert(PathBuf::from("files/share/postgresql").join(relative));
    }
    if let Some(module) = &extension.native_module_file {
        expected.insert(PathBuf::from("files/lib/postgresql").join(module));
        let embedded = PathBuf::from("files/lib/modules").join(module);
        if extension
            .native_target
            .as_deref()
            .is_some_and(|target| DESKTOP_NATIVE_TARGETS.contains(&target))
            || actual.contains(&embedded)
        {
            expected.insert(embedded);
        }
    }
    for archive in &extension.mobile_static_archives {
        expected.insert(archive.relative_path.clone());
    }
    for archive in &extension.mobile_static_dependency_archives {
        expected.insert(archive.relative_path.clone());
    }

    if actual != expected {
        let undeclared = actual
            .difference(&expected)
            .map(|path| path.display().to_string());
        let missing = expected
            .difference(&actual)
            .map(|path| path.display().to_string());
        let undeclared = undeclared.collect::<Vec<_>>();
        let missing = missing.collect::<Vec<_>>();
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} leaf inventory mismatch{}{}",
            root.display(),
            if undeclared.is_empty() {
                String::new()
            } else {
                format!("; undeclared: {}", undeclared.join(","))
            },
            if missing.is_empty() {
                String::new()
            } else {
                format!("; missing: {}", missing.join(","))
            }
        )));
    }
    for relative in legal_members {
        validate_extension_artifact_legal_leaf(root, &relative)?;
    }
    Ok(())
}

fn extension_artifact_leaf_inventory(root: &Path) -> Result<BTreeSet<PathBuf>> {
    fn walk(root: &Path, current: &Path, out: &mut BTreeSet<PathBuf>) -> Result<()> {
        let mut entries = fs::read_dir(current)
            .map_err(|err| Error::InvalidConfig(format!("read {}: {err}", current.display())))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|err| {
                Error::InvalidConfig(format!("read entry in {}: {err}", current.display()))
            })?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|err| {
                Error::InvalidConfig(format!("inspect artifact member {}: {err}", path.display()))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact {} contains unsafe symlink {}",
                    root.display(),
                    path.display()
                )));
            }
            if metadata.is_dir() {
                walk(root, &path, out)?;
                continue;
            }
            if !metadata.is_file() {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact {} contains non-file member {}",
                    root.display(),
                    path.display()
                )));
            }
            let relative = path.strip_prefix(root).map_err(|err| {
                Error::Engine(format!(
                    "derive artifact member path {}: {err}",
                    path.display()
                ))
            })?;
            validate_relative_artifact_path(root, "artifact member", relative)?;
            for component in relative.components() {
                let Component::Normal(component) = component else {
                    continue;
                };
                let component = component.to_str().ok_or_else(|| {
                    Error::InvalidConfig(format!(
                        "prebuilt extension artifact {} member {} must use UTF-8 path text",
                        root.display(),
                        relative.display()
                    ))
                })?;
                if component.contains('\\') {
                    return Err(Error::InvalidConfig(format!(
                        "prebuilt extension artifact {} member {} contains a literal backslash",
                        root.display(),
                        relative.display()
                    )));
                }
            }
            if !out.insert(relative.to_path_buf()) {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact {} repeats leaf {}",
                    root.display(),
                    relative.display()
                )));
            }
        }
        Ok(())
    }

    let metadata = fs::symlink_metadata(root).map_err(|err| {
        Error::InvalidConfig(format!(
            "inspect prebuilt extension artifact {}: {err}",
            root.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} must be a real directory after extraction",
            root.display()
        )));
    }
    let mut out = BTreeSet::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn validate_extension_artifact_legal_leaf(root: &Path, relative: &Path) -> Result<()> {
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|err| {
        Error::InvalidConfig(format!("inspect legal member {}: {err}", path.display()))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact legal member {} must be a non-empty regular non-symlink file",
            relative.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o644 {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact legal member {} must have mode 0644",
                relative.display()
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ExtensionArtifactArchivePolicy {
    pub(super) max_compressed_bytes: u64,
    pub(super) max_expanded_bytes: u64,
    pub(super) max_member_bytes: u64,
    pub(super) max_members: usize,
}

pub(super) fn extension_artifact_archive_policy() -> Result<ExtensionArtifactArchivePolicy> {
    if EXTENSION_ARTIFACT_ARCHIVE_POLICY.contains('\r')
        || !EXTENSION_ARTIFACT_ARCHIVE_POLICY.ends_with('\n')
        || EXTENSION_ARTIFACT_ARCHIVE_POLICY.ends_with("\n\n")
    {
        return Err(Error::Engine(
            "embedded extension artifact archive policy must use LF lines and one final newline"
                .to_owned(),
        ));
    }
    let expected_keys = [
        "schema",
        "maxCompressedBytes",
        "maxExpandedBytes",
        "maxMemberBytes",
        "maxMembers",
    ];
    let lines = EXTENSION_ARTIFACT_ARCHIVE_POLICY
        .trim_end_matches('\n')
        .lines()
        .collect::<Vec<_>>();
    if lines.len() != expected_keys.len() {
        return Err(Error::Engine(
            "embedded extension artifact archive policy has the wrong property count".to_owned(),
        ));
    }
    let mut values = BTreeMap::new();
    for (index, line) in lines.iter().enumerate() {
        let (key, value) = line.split_once('=').ok_or_else(|| {
            Error::Engine(format!(
                "embedded extension artifact archive policy line {} is not key=value",
                index + 1
            ))
        })?;
        if key != expected_keys[index] || value.is_empty() || values.insert(key, value).is_some() {
            return Err(Error::Engine(format!(
                "embedded extension artifact archive policy property {} must be {}",
                index + 1,
                expected_keys[index]
            )));
        }
    }
    if values.get("schema").copied() != Some(EXTENSION_ARTIFACT_ARCHIVE_POLICY_SCHEMA) {
        return Err(Error::Engine(format!(
            "embedded extension artifact archive policy schema must be {EXTENSION_ARTIFACT_ARCHIVE_POLICY_SCHEMA}"
        )));
    }
    let positive_u64 = |key: &str| -> Result<u64> {
        let raw = values.get(key).copied().unwrap_or_default();
        let value = raw.parse::<u64>().map_err(|err| {
            Error::Engine(format!(
                "embedded extension artifact archive policy {key} is invalid: {err}"
            ))
        })?;
        if value == 0 || value.to_string() != raw {
            return Err(Error::Engine(format!(
                "embedded extension artifact archive policy {key} must be a canonical positive integer"
            )));
        }
        Ok(value)
    };
    let max_members_u64 = positive_u64("maxMembers")?;
    let max_members = usize::try_from(max_members_u64).map_err(|err| {
        Error::Engine(format!(
            "embedded extension artifact archive policy maxMembers does not fit usize: {err}"
        ))
    })?;
    let policy = ExtensionArtifactArchivePolicy {
        max_compressed_bytes: positive_u64("maxCompressedBytes")?,
        max_expanded_bytes: positive_u64("maxExpandedBytes")?,
        max_member_bytes: positive_u64("maxMemberBytes")?,
        max_members,
    };
    if policy.max_member_bytes > policy.max_expanded_bytes {
        return Err(Error::Engine(
            "embedded extension artifact archive policy maxMemberBytes must not exceed maxExpandedBytes"
                .to_owned(),
        ));
    }
    Ok(policy)
}

pub(super) fn unique_extension_extraction_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "oliphaunt-extension-artifacts-{}-{nanos}",
        std::process::id()
    ))
}

pub(super) fn extract_prebuilt_extension_archive(
    archive_path: &Path,
    destination: &Path,
) -> Result<PathBuf> {
    let policy = extension_artifact_archive_policy()?;
    let archive_metadata = fs::symlink_metadata(archive_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "inspect prebuilt extension artifact archive {}: {err}",
            archive_path.display()
        ))
    })?;
    if archive_metadata.file_type().is_symlink() || !archive_metadata.is_file() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact archive {} must be a regular non-symlink file",
            archive_path.display()
        )));
    }
    let compressed = archive_is_tar_zst(archive_path) || archive_is_tar_gz(archive_path);
    let archive_limit = if compressed {
        policy.max_compressed_bytes
    } else {
        policy.max_expanded_bytes
    };
    if archive_metadata.len() == 0 || archive_metadata.len() > archive_limit {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact archive {} must contain between 1 and {archive_limit} bytes",
            archive_path.display()
        )));
    }
    fs::create_dir_all(destination).map_err(|err| {
        Error::Engine(format!(
            "create prebuilt extension artifact extraction dir {}: {err}",
            destination.display()
        ))
    })?;
    let file = File::open(archive_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "open prebuilt extension artifact archive {}: {err}",
            archive_path.display()
        ))
    })?;
    let file_modes = if archive_is_tar_zst(archive_path) {
        let decoder = zstd::stream::read::Decoder::new(file).map_err(|err| {
            Error::InvalidConfig(format!(
                "open zstd prebuilt extension artifact archive {}: {err}",
                archive_path.display()
            ))
        })?;
        extract_prebuilt_extension_tar(archive_path, decoder, destination, policy)?
    } else if archive_is_tar_gz(archive_path) {
        let decoder = flate2::read::GzDecoder::new(file);
        extract_prebuilt_extension_tar(archive_path, decoder, destination, policy)?
    } else if archive_is_tar(archive_path) {
        extract_prebuilt_extension_tar(archive_path, file, destination, policy)?
    } else {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact archive {} must end in .tar, .tar.gz, or .tar.zst",
            archive_path.display()
        )));
    };
    let root = extracted_extension_artifact_root(destination)?;
    validate_extension_artifact_archive_legal_modes(archive_path, destination, &root, &file_modes)?;
    Ok(root)
}

fn archive_is_tar(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar"))
}

fn archive_is_tar_zst(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.zst"))
}

fn archive_is_tar_gz(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.gz") || name.ends_with(".tgz"))
}

fn extract_prebuilt_extension_tar(
    archive_path: &Path,
    reader: impl io::Read,
    destination: &Path,
    policy: ExtensionArtifactArchivePolicy,
) -> Result<BTreeMap<PathBuf, u32>> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive.entries().map_err(|err| {
        Error::InvalidConfig(format!(
            "read prebuilt extension artifact archive {}: {err}",
            archive_path.display()
        ))
    })?;
    let mut seen_files = BTreeSet::new();
    let mut seen_dirs = BTreeSet::new();
    let mut file_modes = BTreeMap::new();
    let mut member_count = 0usize;
    // The canonical archive policy includes the two 512-byte tar end-marker
    // blocks in the expanded byte budget. `tar::Archive::entries` stops before
    // those blocks, so account for them up front just as the JS producer,
    // release inventory, and Android consumer do.
    let mut expanded_bytes = 1024u64;
    for entry in entries {
        let mut entry = entry.map_err(|err| {
            Error::InvalidConfig(format!(
                "read prebuilt extension artifact archive entry in {}: {err}",
                archive_path.display()
            ))
        })?;
        member_count += 1;
        if member_count > policy.max_members {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} contains more than {} members",
                archive_path.display(),
                policy.max_members
            )));
        }
        let member_bytes = entry.size();
        if member_bytes > policy.max_member_bytes {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} contains a member larger than {} bytes",
                archive_path.display(),
                policy.max_member_bytes
            )));
        }
        let padded_member_bytes = member_bytes
            .checked_add(511)
            .map(|value| value / 512 * 512)
            .ok_or_else(|| {
                Error::InvalidConfig(format!(
                    "prebuilt extension artifact archive {} has an overflowing member size",
                    archive_path.display()
                ))
            })?;
        expanded_bytes = expanded_bytes
            .checked_add(512)
            .and_then(|value| value.checked_add(padded_member_bytes))
            .ok_or_else(|| {
                Error::InvalidConfig(format!(
                    "prebuilt extension artifact archive {} has an overflowing expanded size",
                    archive_path.display()
                ))
            })?;
        if expanded_bytes > policy.max_expanded_bytes {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} expands beyond {} bytes",
                archive_path.display(),
                policy.max_expanded_bytes
            )));
        }
        let entry_type = entry.header().entry_type();
        let raw_relative = entry.path_bytes();
        let raw_relative = std::str::from_utf8(raw_relative.as_ref()).map_err(|err| {
            Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} contains a non-UTF-8 path: {err}",
                archive_path.display()
            ))
        })?;
        let raw_relative = if entry_type.is_dir() {
            raw_relative.strip_suffix('/').unwrap_or(raw_relative)
        } else {
            raw_relative
        };
        let relative =
            parse_portable_artifact_path_text(archive_path, "archive entry", raw_relative)?;
        if entry_type.is_dir() {
            if member_bytes != 0 {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact archive {} directory {} must have size zero",
                    archive_path.display(),
                    relative.display()
                )));
            }
            validate_archive_entry_plan(&relative, true, &mut seen_files, &mut seen_dirs)?;
            fs::create_dir_all(destination.join(&relative)).map_err(|err| {
                Error::Engine(format!(
                    "create prebuilt extension artifact archive dir {}: {err}",
                    destination.join(&relative).display()
                ))
            })?;
        } else if entry_type.is_file() {
            validate_archive_entry_plan(&relative, false, &mut seen_files, &mut seen_dirs)?;
            let mode = entry.header().mode().map_err(|err| {
                Error::InvalidConfig(format!(
                    "read prebuilt extension artifact archive mode for {} in {}: {err}",
                    relative.display(),
                    archive_path.display()
                ))
            })?;
            file_modes.insert(relative.clone(), mode);
            if let Some(parent) = destination.join(&relative).parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    Error::Engine(format!(
                        "create prebuilt extension artifact archive parent {}: {err}",
                        parent.display()
                    ))
                })?;
            }
            entry.unpack(destination.join(&relative)).map_err(|err| {
                Error::Engine(format!(
                    "extract prebuilt extension artifact archive entry {} from {}: {err}",
                    relative.display(),
                    archive_path.display()
                ))
            })?;
        } else {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} entry {} must be a regular file or directory, not {:?}",
                archive_path.display(),
                relative.display(),
                entry_type
            )));
        }
    }
    Ok(file_modes)
}

fn validate_extension_artifact_archive_legal_modes(
    archive_path: &Path,
    destination: &Path,
    artifact_root: &Path,
    file_modes: &BTreeMap<PathBuf, u32>,
) -> Result<()> {
    let wrapper = artifact_root.strip_prefix(destination).map_err(|err| {
        Error::Engine(format!(
            "derive prebuilt extension artifact wrapper path for {}: {err}",
            artifact_root.display()
        ))
    })?;
    for (archive_member, mode) in file_modes {
        let relative = if wrapper.as_os_str().is_empty() {
            archive_member.as_path()
        } else {
            archive_member.strip_prefix(wrapper).map_err(|_| {
                Error::InvalidConfig(format!(
                    "prebuilt extension artifact archive {} contains top-level member {} outside wrapper {}",
                    archive_path.display(),
                    archive_member.display(),
                    wrapper.display()
                ))
            })?
        };
        if extension_artifact_archive_member_is_legal(relative) && *mode != 0o644 {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive {} legal member {} must have exact tar header mode 0644, got {:04o}",
                archive_path.display(),
                archive_member.display(),
                mode
            )));
        }
    }
    Ok(())
}

fn extension_artifact_archive_member_is_legal(relative: &Path) -> bool {
    relative == Path::new("LICENSE")
        || relative == Path::new("THIRD_PARTY_NOTICES.md")
        || relative.starts_with("THIRD_PARTY_LICENSES")
        || relative.starts_with("files/share/licenses")
}

fn validate_archive_entry_plan(
    relative: &Path,
    is_dir: bool,
    seen_files: &mut BTreeSet<PathBuf>,
    seen_dirs: &mut BTreeSet<PathBuf>,
) -> Result<()> {
    let mut ancestors = relative.ancestors();
    let _ = ancestors.next();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        if seen_files.contains(ancestor) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive entry {} is nested under file entry {}",
                relative.display(),
                ancestor.display()
            )));
        }
    }
    if is_dir {
        if seen_files.contains(relative) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive has both file and directory entries for {}",
                relative.display()
            )));
        }
        if !seen_dirs.insert(relative.to_path_buf()) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive repeats directory entry {}",
                relative.display()
            )));
        }
    } else {
        if seen_dirs.contains(relative) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive has both directory and file entries for {}",
                relative.display()
            )));
        }
        if !seen_files.insert(relative.to_path_buf()) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact archive repeats file entry {}",
                relative.display()
            )));
        }
    }
    Ok(())
}

fn extracted_extension_artifact_root(destination: &Path) -> Result<PathBuf> {
    if destination.join("manifest.properties").is_file() {
        return Ok(destination.to_path_buf());
    }
    let mut children = fs::read_dir(destination)
        .map_err(|err| {
            Error::Engine(format!(
                "read prebuilt extension artifact extraction dir {}: {err}",
                destination.display()
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| {
            Error::Engine(format!(
                "read entry in prebuilt extension artifact extraction dir {}: {err}",
                destination.display()
            ))
        })?;
    children.sort_by_key(|entry| entry.file_name());
    if let [nested] = children.as_slice() {
        let file_type = nested.file_type().map_err(|err| {
            Error::Engine(format!(
                "inspect top-level prebuilt extension artifact archive entry {}: {err}",
                nested.path().display()
            ))
        })?;
        if file_type.is_dir() && nested.path().join("manifest.properties").is_file() {
            return Ok(nested.path());
        }
    }
    Err(Error::InvalidConfig(format!(
        "prebuilt extension artifact archive extracted to {} but did not contain manifest.properties at archive root or under exactly one top-level directory with no sibling entries",
        destination.display()
    )))
}
