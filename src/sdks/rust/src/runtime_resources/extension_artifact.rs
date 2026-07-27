use super::*;
use std::path::Component;

const EXTENSION_ARTIFACT_ARCHIVE_POLICY: &str =
    include_str!("../../extension-artifact-archive-policy.properties");
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
    let external = Extension::by_sql_name(sql_name)
        .and_then(Extension::release_product)
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

/// Create one exact prebuilt extension artifact from already-built PostgreSQL
/// runtime files.
///
/// This is the producer-side companion to `--prebuilt-extension`: it copies
/// only the selected extension's declared control, SQL, data, and native module
/// files into the portable artifact schema. It never builds PostgreSQL or
/// extension source.
pub fn create_prebuilt_extension_artifact(
    options: NativeExtensionArtifactOptions,
) -> Result<NativeExtensionArtifact> {
    validate_extension_artifact_options(&options)?;
    let legal_contract = options
        .legal_contract
        .as_ref()
        .expect("validated artifact options require a legal contract");
    let license_profile = legal_contract.profile;
    let license_files = sorted_deduped_paths(&legal_contract.license_files);

    let output = options.output.clone();
    let mut staging_root = None;
    let artifact_root = match options.format {
        NativeExtensionArtifactFormat::Directory => {
            prepare_output_root(&output, options.replace_existing)?;
            output.clone()
        }
        NativeExtensionArtifactFormat::Tar
        | NativeExtensionArtifactFormat::TarGz
        | NativeExtensionArtifactFormat::TarZst => {
            prepare_output_file(&output, options.replace_existing)?;
            let staging = RemoveOnDrop::create(unique_extension_artifact_staging_root())?;
            let path = staging.path.clone();
            staging_root = Some(staging);
            path
        }
    };

    write_prebuilt_extension_artifact_directory(&artifact_root, &options)?;
    let loaded = load_prebuilt_extension_artifact(&artifact_root)?;
    if loaded.sql_name != options.sql_name
        || loaded.native_runtime_version.as_deref() != Some(options.native_runtime_version.as_str())
    {
        return Err(Error::Engine(format!(
            "created prebuilt extension artifact for '{}'/liboliphaunt-native {}, expected '{}'/liboliphaunt-native {}",
            loaded.sql_name,
            loaded
                .native_runtime_version
                .as_deref()
                .unwrap_or("<missing>"),
            options.sql_name,
            options.native_runtime_version
        )));
    }

    if options.format != NativeExtensionArtifactFormat::Directory {
        write_prebuilt_extension_artifact_archive(&artifact_root, &output, options.format)?;
        if let Some(mut staging) = staging_root {
            staging.remove()?;
        }
    }

    Ok(NativeExtensionArtifact {
        path: output.clone(),
        manifest_path: (options.format == NativeExtensionArtifactFormat::Directory)
            .then(|| output.join("manifest.properties")),
        sql_name: options.sql_name,
        license_profile,
        license_files,
        format: options.format,
    })
}

pub(super) fn unique_timestamp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

pub(super) fn sha256_file_hex(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|err| {
        Error::InvalidConfig(format!("open {} for sha256: {err}", path.display()))
    })?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)
        .map_err(|err| Error::Engine(format!("hash {}: {err}", path.display())))?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug)]
struct RemoveOnDrop {
    path: PathBuf,
    removed: bool,
}

impl RemoveOnDrop {
    fn create(path: PathBuf) -> Result<Self> {
        fs::create_dir_all(&path).map_err(|err| {
            Error::Engine(format!(
                "create prebuilt extension artifact staging root {}: {err}",
                path.display()
            ))
        })?;
        Ok(Self {
            path,
            removed: false,
        })
    }

    fn remove(&mut self) -> Result<()> {
        if self.removed {
            return Ok(());
        }
        fs::remove_dir_all(&self.path).map_err(|err| {
            Error::Engine(format!(
                "remove prebuilt extension artifact staging root {}: {err}",
                self.path.display()
            ))
        })?;
        self.removed = true;
        Ok(())
    }
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn validate_extension_artifact_options(options: &NativeExtensionArtifactOptions) -> Result<()> {
    if options.output.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "prebuilt extension artifact output path must not be empty".to_owned(),
        ));
    }
    if options.runtime_files.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "prebuilt extension artifact runtime root must not be empty".to_owned(),
        ));
    }
    if !options.runtime_files.is_dir() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact runtime root {} must be an existing directory",
            options.runtime_files.display()
        )));
    }
    validate_portable_id(&options.sql_name, "prebuilt extension sqlName")?;
    validate_stable_semver(
        &options.native_runtime_version,
        "prebuilt extension nativeRuntimeVersion",
    )?;
    for dependency in &options.dependencies {
        validate_portable_id(dependency, "prebuilt extension dependency")?;
    }
    for file_name in &options.extension_sql_file_names {
        validate_portable_id(file_name, "prebuilt extension ancillary SQL filename")?;
        if !file_name.ends_with(".sql") {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension ancillary SQL filename '{file_name}' must be a SQL basename"
            )));
        }
    }
    for prefix in &options.extension_sql_file_prefixes {
        validate_portable_id(prefix, "prebuilt extension ancillary SQL prefix")?;
        if prefix.contains('.') {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension ancillary SQL prefix '{prefix}' must not contain '.'"
            )));
        }
    }
    for library in &options.shared_preload_libraries {
        validate_portable_id(library, "prebuilt extension shared preload library")?;
    }
    if let Some(stem) = &options.native_module_stem {
        validate_portable_id(stem, "prebuilt extension native module stem")?;
    }
    if let Some(file_name) = &options.native_module_file {
        validate_portable_id(file_name, "prebuilt extension native module file")?;
        if options.native_module_stem.is_none() {
            return Err(Error::InvalidConfig(
                "prebuilt extension nativeModuleFile requires nativeModuleStem".to_owned(),
            ));
        }
    }
    if let Some(target) = &options.native_target {
        validate_portable_id(target, "prebuilt extension native target")?;
    }
    if options.native_module_stem.is_some() && options.native_target.is_none() {
        return Err(Error::InvalidConfig(
            "prebuilt extension artifacts with nativeModuleStem must declare nativeTarget"
                .to_owned(),
        ));
    }
    let desktop_native_target = options
        .native_target
        .as_deref()
        .is_some_and(|target| DESKTOP_NATIVE_TARGETS.contains(&target));
    if options.native_module_stem.is_some()
        && desktop_native_target
        && options.embedded_module_root.is_none()
    {
        return Err(Error::InvalidConfig(
            "desktop prebuilt extension artifacts with nativeModuleStem must declare an embedded module root"
                .to_owned(),
        ));
    }
    if let Some(root) = &options.embedded_module_root {
        if options.native_module_stem.is_none() || !desktop_native_target {
            return Err(Error::InvalidConfig(
                "an embedded module root is only valid for desktop native extension artifacts"
                    .to_owned(),
            ));
        }
        if root.as_os_str().is_empty() || !root.is_dir() {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension embedded module root {} must be an existing directory",
                root.display()
            )));
        }
    }
    if let Some(prefix) = &options.static_symbol_prefix
        && !is_c_identifier(prefix)
    {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension static symbol prefix '{prefix}' must be a portable C identifier"
        )));
    }
    let mut alias_sql_symbols = BTreeSet::new();
    for alias in &options.static_symbol_aliases {
        if !is_c_identifier(&alias.sql_symbol) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension static symbol alias '{}' must use a portable C identifier",
                alias.sql_symbol
            )));
        }
        if !is_c_identifier(&alias.linked_symbol) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension static symbol alias target '{}' must use a portable C identifier",
                alias.linked_symbol
            )));
        }
        if !alias_sql_symbols.insert(alias.sql_symbol.clone()) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension repeats static symbol alias for '{}'",
                alias.sql_symbol
            )));
        }
    }
    if !options.mobile_static_archives.is_empty() && options.native_module_stem.is_none() {
        return Err(Error::InvalidConfig(
            "prebuilt extension mobile static archives require nativeModuleStem".to_owned(),
        ));
    }
    let mobile_prebuilt = artifact_mobile_prebuilt(options);
    if mobile_prebuilt
        && options.native_module_stem.is_some()
        && options.mobile_static_archives.is_empty()
    {
        return Err(Error::InvalidConfig(
            "mobilePrebuilt native-module artifacts must carry at least one mobile static archive"
                .to_owned(),
        ));
    }
    let mut mobile_targets = BTreeSet::new();
    for archive in &options.mobile_static_archives {
        validate_portable_id(
            &archive.target,
            "prebuilt extension mobile static archive target",
        )?;
        if !mobile_targets.insert(archive.target.clone()) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension mobile static archives repeat target '{}'",
                archive.target
            )));
        }
        if !archive.archive.is_file() {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension mobile static archive for target '{}' must be a file: {}",
                archive.target,
                archive.archive.display()
            )));
        }
    }
    let mut mobile_dependency_keys = BTreeSet::new();
    for archive in &options.mobile_static_dependency_archives {
        validate_portable_id(
            &archive.target,
            "prebuilt extension mobile static dependency archive target",
        )?;
        validate_portable_id(
            &archive.name,
            "prebuilt extension mobile static dependency archive name",
        )?;
        if !mobile_targets.contains(&archive.target) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension mobile static dependency archive '{}' for target '{}' requires a matching mobile static archive target",
                archive.name, archive.target
            )));
        }
        if !mobile_dependency_keys.insert((archive.target.clone(), archive.name.clone())) {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension mobile static dependency archives repeat '{}' for target '{}'",
                archive.name, archive.target
            )));
        }
        validate_mobile_static_dependency_archive_file_name(&archive.archive)?;
        if !archive.archive.is_file() {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension mobile static dependency archive '{}' for target '{}' must be a file: {}",
                archive.name,
                archive.target,
                archive.archive.display()
            )));
        }
    }
    for data_file in &options.data_files {
        validate_relative_artifact_path(&options.output, "data file", data_file)?;
        if data_file
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            == Some("extension")
        {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension data file '{}' must not be under share/postgresql/extension; control and SQL files are selected from sqlName",
                data_file.display()
            )));
        }
    }
    let legal_contract = options.legal_contract.as_ref().ok_or_else(|| {
        Error::InvalidConfig(
            "prebuilt extension artifact creation requires an exact legal contract".to_owned(),
        )
    })?;
    let legal_root_metadata = fs::symlink_metadata(&legal_contract.source_root).map_err(|err| {
        Error::InvalidConfig(format!(
            "inspect prebuilt extension artifact legal source root {}: {err}",
            legal_contract.source_root.display()
        ))
    })?;
    if legal_root_metadata.file_type().is_symlink() || !legal_root_metadata.is_dir() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact legal source root {} must be a real directory",
            legal_contract.source_root.display()
        )));
    }
    let canonical_license_files = sorted_deduped_paths(&legal_contract.license_files);
    if canonical_license_files.len() != legal_contract.license_files.len() {
        return Err(Error::InvalidConfig(
            "prebuilt extension artifact legal contract repeats a license file".to_owned(),
        ));
    }
    validate_extension_artifact_license_paths(&options.output, &canonical_license_files)?;
    validate_extension_artifact_license_profile(
        &options.output,
        &options.sql_name,
        options.native_target.as_deref(),
        &mobile_static_dependency_archives_for_artifact_options(options)?,
        legal_contract.profile,
        &canonical_license_files,
    )?;
    for relative in extension_artifact_legal_members(legal_contract.profile)
        .into_iter()
        .chain(canonical_license_files.iter().cloned())
    {
        validate_extension_artifact_legal_source(&legal_contract.source_root, &relative)?;
    }
    Ok(())
}

pub(super) fn prepare_output_file(path: &Path, replace_existing: bool) -> Result<()> {
    if path.exists() {
        if !replace_existing {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact output {} already exists; pass --force or replace_existing(true)",
                path.display()
            )));
        }
        if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
        .map_err(|err| Error::Engine(format!("remove {}: {err}", path.display())))?;
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    Ok(())
}

fn write_prebuilt_extension_artifact_directory(
    artifact_root: &Path,
    options: &NativeExtensionArtifactOptions,
) -> Result<()> {
    let extension = artifact_options_runtime_resource_extension(options, artifact_root)?;
    copy_extension_artifact_sql_files(
        artifact_root,
        &options.runtime_files,
        &artifact_root.join("files"),
        &extension,
    )?;
    for relative in &extension.data_files {
        copy_artifact_source_file(
            &options.runtime_files,
            &artifact_root.join("files"),
            &PathBuf::from("share/postgresql").join(relative),
        )?;
    }
    if let Some(module_file) = &extension.native_module_file {
        copy_artifact_source_file(
            &options.runtime_files,
            &artifact_root.join("files"),
            &PathBuf::from("lib/postgresql").join(module_file),
        )?;
        if let Some(embedded_module_root) = &options.embedded_module_root {
            copy_artifact_source_file(
                embedded_module_root,
                &artifact_root.join("files/lib/modules"),
                Path::new(module_file),
            )?;
        }
    }
    copy_mobile_static_archives_to_artifact(artifact_root, options, &extension)?;
    copy_mobile_static_dependency_archives_to_artifact(artifact_root, options, &extension)?;
    copy_extension_artifact_legal_files(artifact_root, options)?;
    write_prebuilt_extension_artifact_manifest(artifact_root, options, &extension)?;
    Ok(())
}

fn artifact_options_runtime_resource_extension(
    options: &NativeExtensionArtifactOptions,
    artifact_root: &Path,
) -> Result<RuntimeResourceExtension> {
    let native_module_file = options.native_module_stem.as_ref().map(|stem| {
        options
            .native_module_file
            .clone()
            .unwrap_or_else(|| format!("{}{}", stem, std::env::consts::DLL_SUFFIX))
    });
    Ok(RuntimeResourceExtension {
        sql_name: options.sql_name.clone(),
        native_runtime_version: Some(options.native_runtime_version.clone()),
        creates_extension: options.creates_extension,
        native_module_stem: options.native_module_stem.clone(),
        native_module_file,
        native_target: options.native_target.clone(),
        dependencies: sorted_deduped_strings(&options.dependencies),
        data_files: sorted_deduped_paths(&options.data_files),
        extension_sql_file_names: sorted_deduped_strings(&options.extension_sql_file_names),
        extension_sql_file_prefixes: sorted_deduped_strings(&options.extension_sql_file_prefixes),
        shared_preload_libraries: sorted_deduped_strings(&options.shared_preload_libraries),
        mobile_prebuilt: artifact_mobile_prebuilt(options),
        mobile_static_archives: mobile_static_archives_for_artifact_options(options),
        mobile_static_dependency_archives: mobile_static_dependency_archives_for_artifact_options(
            options,
        )?,
        static_symbol_prefix: options.static_symbol_prefix.clone(),
        static_symbol_aliases: sorted_static_symbol_aliases(&options.static_symbol_aliases),
        license_profile: options
            .legal_contract
            .as_ref()
            .map(|contract| contract.profile),
        license_files: options
            .legal_contract
            .as_ref()
            .map(|contract| sorted_deduped_paths(&contract.license_files))
            .unwrap_or_default(),
        source: RuntimeResourceExtensionSource::Prebuilt {
            root: artifact_root.to_path_buf(),
            files_root: artifact_root.join("files"),
        },
    })
}

fn artifact_mobile_prebuilt(options: &NativeExtensionArtifactOptions) -> bool {
    options.mobile_prebuilt || !options.mobile_static_archives.is_empty()
}

fn mobile_static_archives_for_artifact_options(
    options: &NativeExtensionArtifactOptions,
) -> Vec<MobileStaticArchive> {
    let Some(stem) = options.native_module_stem.as_deref() else {
        return Vec::new();
    };
    let mut archives = options
        .mobile_static_archives
        .iter()
        .map(|archive| MobileStaticArchive {
            target: archive.target.clone(),
            relative_path: mobile_static_archive_artifact_relative_path(&archive.target, stem),
        })
        .collect::<Vec<_>>();
    archives.sort_by(|left, right| left.target.cmp(&right.target));
    archives
}

pub(super) fn mobile_static_archive_artifact_relative_path(target: &str, stem: &str) -> PathBuf {
    PathBuf::from("mobile-static")
        .join(target)
        .join("extensions")
        .join(stem)
        .join(format!("liboliphaunt_extension_{stem}.a"))
}

fn mobile_static_dependency_archives_for_artifact_options(
    options: &NativeExtensionArtifactOptions,
) -> Result<Vec<MobileStaticDependencyArchive>> {
    let mut archives = Vec::new();
    for archive in &options.mobile_static_dependency_archives {
        let file_name = validate_mobile_static_dependency_archive_file_name(&archive.archive)?;
        archives.push(MobileStaticDependencyArchive {
            target: archive.target.clone(),
            name: archive.name.clone(),
            relative_path: mobile_static_dependency_archive_artifact_relative_path(
                &archive.target,
                &archive.name,
                &file_name,
            ),
        });
    }
    archives.sort_by(|left, right| {
        left.target
            .cmp(&right.target)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(archives)
}

fn sorted_static_symbol_aliases(
    aliases: &[NativeExtensionStaticSymbolAlias],
) -> Vec<NativeExtensionStaticSymbolAlias> {
    let mut aliases = aliases.to_vec();
    aliases.sort_by(|left, right| {
        left.sql_symbol
            .cmp(&right.sql_symbol)
            .then_with(|| left.linked_symbol.cmp(&right.linked_symbol))
    });
    aliases.dedup();
    aliases
}

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

fn validate_mobile_static_dependency_archive_file_name(path: &Path) -> Result<String> {
    let file_name = path.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
        Error::InvalidConfig(format!(
            "prebuilt extension mobile static dependency archive path {} must include a portable file name",
            path.display()
        ))
    })?;
    validate_portable_id(
        file_name,
        "prebuilt extension mobile static dependency archive file",
    )?;
    Ok(file_name.to_owned())
}

fn copy_mobile_static_archives_to_artifact(
    artifact_root: &Path,
    options: &NativeExtensionArtifactOptions,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    if options.mobile_static_archives.is_empty() {
        return Ok(());
    }
    let archive_by_target = options
        .mobile_static_archives
        .iter()
        .map(|archive| (archive.target.as_str(), archive.archive.as_path()))
        .collect::<BTreeMap<_, _>>();
    for archive in &extension.mobile_static_archives {
        let Some(source) = archive_by_target.get(archive.target.as_str()) else {
            return Err(Error::Engine(format!(
                "internal error: missing mobile static archive source for target '{}'",
                archive.target
            )));
        };
        copy_portable_tree(source, &artifact_root.join(&archive.relative_path))?;
    }
    Ok(())
}

fn copy_mobile_static_dependency_archives_to_artifact(
    artifact_root: &Path,
    options: &NativeExtensionArtifactOptions,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    if options.mobile_static_dependency_archives.is_empty() {
        return Ok(());
    }
    let archive_by_key = options
        .mobile_static_dependency_archives
        .iter()
        .map(|archive| {
            (
                (archive.target.as_str(), archive.name.as_str()),
                archive.archive.as_path(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for archive in &extension.mobile_static_dependency_archives {
        let Some(source) = archive_by_key.get(&(archive.target.as_str(), archive.name.as_str()))
        else {
            return Err(Error::Engine(format!(
                "internal error: missing mobile static dependency archive source for target '{}' dependency '{}'",
                archive.target, archive.name
            )));
        };
        copy_portable_tree(source, &artifact_root.join(&archive.relative_path))?;
    }
    Ok(())
}

fn copy_extension_artifact_legal_files(
    artifact_root: &Path,
    options: &NativeExtensionArtifactOptions,
) -> Result<()> {
    let contract = options
        .legal_contract
        .as_ref()
        .expect("validated artifact options require a legal contract");
    for relative in extension_artifact_legal_members(contract.profile) {
        copy_extension_artifact_legal_file(
            &contract.source_root,
            &relative,
            &artifact_root.join(&relative),
        )?;
    }
    for relative in sorted_deduped_paths(&contract.license_files) {
        copy_extension_artifact_legal_file(
            &contract.source_root,
            &relative,
            &artifact_root.join("files").join(&relative),
        )?;
    }
    Ok(())
}

fn copy_extension_artifact_legal_file(
    source_root: &Path,
    relative: &Path,
    destination: &Path,
) -> Result<()> {
    validate_relative_artifact_path(source_root, "legal file", relative)?;
    let source = source_root.join(relative);
    validate_extension_artifact_legal_source(source_root, relative)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    fs::copy(&source, destination).map_err(|err| {
        Error::Engine(format!(
            "copy legal file {} -> {}: {err}",
            source.display(),
            destination.display()
        ))
    })?;
    set_extension_artifact_legal_mode(destination)
}

fn validate_extension_artifact_legal_source(source_root: &Path, relative: &Path) -> Result<()> {
    validate_relative_artifact_path(source_root, "legal file", relative)?;
    let mut cursor = source_root.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact legal source path {} is unsafe",
                relative.display()
            )));
        };
        cursor.push(component);
        let metadata = fs::symlink_metadata(&cursor).map_err(|err| {
            Error::InvalidConfig(format!(
                "inspect prebuilt extension artifact legal source path {}: {err}",
                cursor.display()
            ))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact legal source path {} must not traverse a symlink",
                cursor.display()
            )));
        }
        if index + 1 == component_count {
            if !metadata.is_file() || metadata.len() == 0 {
                return Err(Error::InvalidConfig(format!(
                    "prebuilt extension artifact legal source file {} must be a non-empty regular non-symlink file",
                    cursor.display()
                )));
            }
        } else if !metadata.is_dir() {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact legal source parent {} must be a real directory",
                cursor.display()
            )));
        }
    }
    Ok(())
}

fn set_extension_artifact_legal_mode(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).map_err(|err| {
            Error::Engine(format!(
                "set canonical legal file permissions on {}: {err}",
                path.display()
            ))
        })?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|err| Error::Engine(format!("stat {}: {err}", path.display())))?
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).map_err(|err| {
            Error::Engine(format!(
                "set portable legal file permissions on {}: {err}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

pub(super) fn sorted_deduped_strings(values: &[String]) -> Vec<String> {
    values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn sorted_deduped_paths(values: &[PathBuf]) -> Vec<PathBuf> {
    values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn copy_extension_artifact_sql_files(
    artifact_root: &Path,
    runtime_files: &Path,
    artifact_files: &Path,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    let source_dir = runtime_files.join("share/postgresql/extension");
    let target_dir = artifact_files.join("share/postgresql/extension");
    if !source_dir.is_dir() {
        if extension.creates_extension {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact source runtime {} is missing share/postgresql/extension for '{}'",
                runtime_files.display(),
                extension.sql_name
            )));
        }
        return Ok(());
    }

    let mut copied_control = false;
    let mut copied_sql = false;
    let mut copied = 0usize;
    let mut entries = fs::read_dir(&source_dir)
        .map_err(|err| Error::Engine(format!("read {}: {err}", source_dir.display())))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| Error::Engine(format!("read entry in {}: {err}", source_dir.display())))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !runtime_extension_sql_file_belongs(extension, &file_name) {
            continue;
        }
        copied += 1;
        if file_name == format!("{}.control", extension.sql_name) {
            copied_control = true;
        } else if extension_install_sql_file_belongs(&extension.sql_name, &file_name) {
            copied_sql = true;
        }
        copy_extension_runtime_file(runtime_files, &entry.path(), &target_dir.join(file_name))?;
    }

    if extension.creates_extension && (!copied_control || !copied_sql) {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact {} for '{}' must include a control file and at least one SQL install file",
            artifact_root.display(),
            extension.sql_name
        )));
    }
    if !extension.creates_extension && copied == 0 {
        return Ok(());
    }
    Ok(())
}

fn copy_artifact_source_file(
    source_root: &Path,
    artifact_files: &Path,
    relative: &Path,
) -> Result<()> {
    validate_relative_artifact_path(source_root, "runtime file", relative)?;
    let source = source_root.join(relative);
    if !source.is_file() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact source runtime is missing declared file {}",
            source.display()
        )));
    }
    copy_extension_runtime_file(source_root, &source, &artifact_files.join(relative))
}

fn copy_extension_runtime_file(
    runtime_root: &Path,
    source: &Path,
    destination: &Path,
) -> Result<()> {
    let symlink_metadata = fs::symlink_metadata(source)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", source.display())))?;
    let file_metadata = if symlink_metadata.file_type().is_symlink() {
        let canonical_root = runtime_root.canonicalize().map_err(|err| {
            Error::Engine(format!(
                "canonicalize runtime root {}: {err}",
                runtime_root.display()
            ))
        })?;
        let canonical_source = source.canonicalize().map_err(|err| {
            Error::Engine(format!(
                "canonicalize selected extension runtime symlink {}: {err}",
                source.display()
            ))
        })?;
        if !canonical_source.starts_with(&canonical_root) {
            return Err(Error::InvalidConfig(format!(
                "selected extension runtime symlink {} resolves outside runtime root {}",
                source.display(),
                runtime_root.display()
            )));
        }
        fs::metadata(source).map_err(|err| {
            Error::Engine(format!(
                "stat selected extension runtime symlink target {}: {err}",
                source.display()
            ))
        })?
    } else {
        symlink_metadata
    };
    if !file_metadata.is_file() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact source runtime file {} must be a regular file",
            source.display()
        )));
    }
    copy_portable_file(source, destination, &file_metadata)
}

fn write_prebuilt_extension_artifact_manifest(
    artifact_root: &Path,
    options: &NativeExtensionArtifactOptions,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    fs::create_dir_all(artifact_root)
        .map_err(|err| Error::Engine(format!("create {}: {err}", artifact_root.display())))?;
    let legal_contract = options
        .legal_contract
        .as_ref()
        .expect("validated artifact options require a legal contract");
    let license_files = sorted_deduped_paths(&legal_contract.license_files)
        .iter()
        .map(|path| render_portable_artifact_path(path, "prebuilt extension license file"))
        .collect::<Result<Vec<_>>>()?
        .join(",");
    let data_files = extension
        .data_files
        .iter()
        .map(|path| render_portable_artifact_path(path, "prebuilt extension data file"))
        .collect::<Result<Vec<_>>>()?
        .join(",");
    let mobile_static_archives =
        mobile_static_archive_manifest_value(&extension.mobile_static_archives)?;
    let mobile_static_dependency_archives = mobile_static_dependency_archive_manifest_value(
        &extension.mobile_static_dependency_archives,
    )?;
    let text = format!(
        "packageLayout={EXTENSION_ARTIFACT_LAYOUT}\npgMajor=18\nsqlName={}\ncreatesExtension={}\nnativeModuleStem={}\nnativeModuleFile={}\nnativeTarget={}\nnativeRuntimeProduct={EXTENSION_ARTIFACT_NATIVE_RUNTIME_PRODUCT}\nnativeRuntimeVersion={}\ndependencies={}\ndataFiles={}\nextensionSqlFileNames={}\nextensionSqlFilePrefixes={}\nsharedPreloadLibraries={}\nmobilePrebuilt={}\nmobileStaticArchives={}\nmobileStaticDependencyArchives={}\nstaticSymbolPrefix={}\nstaticSymbolAliases={}\nlicenseFiles={}\nlicenseProfile={}\nfiles=files\n",
        extension.sql_name,
        yes_no_manifest(options.creates_extension),
        extension.native_module_stem.as_deref().unwrap_or(""),
        extension.native_module_file.as_deref().unwrap_or(""),
        extension.native_target.as_deref().unwrap_or(""),
        options.native_runtime_version,
        extension.dependencies.join(","),
        data_files,
        extension.extension_sql_file_names.join(","),
        extension.extension_sql_file_prefixes.join(","),
        extension.shared_preload_libraries.join(","),
        yes_no_manifest(extension.mobile_prebuilt),
        mobile_static_archives,
        mobile_static_dependency_archives,
        extension.static_symbol_prefix.as_deref().unwrap_or(""),
        static_symbol_alias_manifest_value(&extension.static_symbol_aliases),
        license_files,
        legal_contract.profile.as_str(),
    );
    fs::write(artifact_root.join("manifest.properties"), text).map_err(|err| {
        Error::Engine(format!(
            "write prebuilt extension artifact manifest {}: {err}",
            artifact_root.join("manifest.properties").display()
        ))
    })
}

fn static_symbol_alias_manifest_value(aliases: &[NativeExtensionStaticSymbolAlias]) -> String {
    aliases
        .iter()
        .map(|alias| format!("{}:{}", alias.sql_symbol, alias.linked_symbol))
        .collect::<Vec<_>>()
        .join(",")
}

fn mobile_static_archive_manifest_value(archives: &[MobileStaticArchive]) -> Result<String> {
    Ok(archives
        .iter()
        .map(|archive| {
            Ok(format!(
                "{}:{}",
                archive.target,
                render_portable_artifact_path(
                    &archive.relative_path,
                    "prebuilt extension mobile static archive",
                )?
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join(","))
}

fn mobile_static_dependency_archive_manifest_value(
    archives: &[MobileStaticDependencyArchive],
) -> Result<String> {
    Ok(archives
        .iter()
        .map(|archive| {
            Ok(format!(
                "{}:{}:{}",
                archive.target,
                archive.name,
                render_portable_artifact_path(
                    &archive.relative_path,
                    "prebuilt extension mobile static dependency archive",
                )?
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join(","))
}

fn yes_no_manifest(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn write_prebuilt_extension_artifact_archive(
    artifact_root: &Path,
    output: &Path,
    format: NativeExtensionArtifactFormat,
) -> Result<()> {
    let policy = extension_artifact_archive_policy()?;
    let file = File::create(output)
        .map_err(|err| Error::Engine(format!("create {}: {err}", output.display())))?;
    match format {
        NativeExtensionArtifactFormat::Directory => Ok(()),
        NativeExtensionArtifactFormat::Tar => {
            write_prebuilt_extension_artifact_tar(file, artifact_root).map(|_| ())
        }
        NativeExtensionArtifactFormat::TarGz => {
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let encoder = write_prebuilt_extension_artifact_tar(encoder, artifact_root)?;
            encoder.finish().map_err(|err| {
                Error::Engine(format!(
                    "finish gzip prebuilt extension artifact archive {}: {err}",
                    output.display()
                ))
            })?;
            Ok(())
        }
        NativeExtensionArtifactFormat::TarZst => {
            let encoder = zstd::stream::write::Encoder::new(file, 0).map_err(|err| {
                Error::Engine(format!(
                    "create zstd prebuilt extension artifact archive {}: {err}",
                    output.display()
                ))
            })?;
            let encoder = write_prebuilt_extension_artifact_tar(encoder, artifact_root)?;
            encoder.finish().map_err(|err| {
                Error::Engine(format!(
                    "finish zstd prebuilt extension artifact archive {}: {err}",
                    output.display()
                ))
            })?;
            Ok(())
        }
    }?;
    let output_bytes = fs::metadata(output)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", output.display())))?
        .len();
    let output_limit = if matches!(format, NativeExtensionArtifactFormat::Tar) {
        policy.max_expanded_bytes
    } else {
        policy.max_compressed_bytes
    };
    if output_bytes == 0 || output_bytes > output_limit {
        return Err(Error::Engine(format!(
            "created prebuilt extension artifact archive {} must contain between 1 and {output_limit} bytes",
            output.display()
        )));
    }
    Ok(())
}

fn write_prebuilt_extension_artifact_tar<W: io::Write>(
    writer: W,
    artifact_root: &Path,
) -> Result<W> {
    let policy = extension_artifact_archive_policy()?;
    let mut shape = ExtensionArtifactArchiveShape {
        member_count: 0,
        expanded_bytes: 1024,
    };
    let mut archive = tar::Builder::new(writer);
    append_artifact_files_to_tar(
        &mut archive,
        artifact_root,
        artifact_root,
        policy,
        &mut shape,
    )?;
    archive.finish().map_err(|err| {
        Error::Engine(format!(
            "finish prebuilt extension artifact tar from {}: {err}",
            artifact_root.display()
        ))
    })?;
    archive.into_inner().map_err(|err| {
        Error::Engine(format!(
            "finish prebuilt extension artifact tar writer from {}: {err}",
            artifact_root.display()
        ))
    })
}

#[derive(Debug)]
pub(super) struct ExtensionArtifactArchiveShape {
    pub(super) member_count: usize,
    pub(super) expanded_bytes: u64,
}

pub(super) fn record_extension_artifact_archive_member(
    artifact_root: &Path,
    relative: &Path,
    member_bytes: u64,
    policy: ExtensionArtifactArchivePolicy,
    shape: &mut ExtensionArtifactArchiveShape,
) -> Result<()> {
    shape.member_count = shape.member_count.checked_add(1).ok_or_else(|| {
        Error::Engine(format!(
            "prebuilt extension artifact {} member count overflows",
            artifact_root.display()
        ))
    })?;
    if shape.member_count > policy.max_members {
        return Err(Error::Engine(format!(
            "prebuilt extension artifact {} contains more than {} members",
            artifact_root.display(),
            policy.max_members
        )));
    }
    if member_bytes > policy.max_member_bytes {
        return Err(Error::Engine(format!(
            "prebuilt extension artifact {} member {} exceeds {} bytes",
            artifact_root.display(),
            relative.display(),
            policy.max_member_bytes
        )));
    }
    let padded_member_bytes = member_bytes
        .checked_add(511)
        .map(|value| value / 512 * 512)
        .ok_or_else(|| {
            Error::Engine(format!(
                "prebuilt extension artifact {} member {} size overflows",
                artifact_root.display(),
                relative.display()
            ))
        })?;
    shape.expanded_bytes = shape
        .expanded_bytes
        .checked_add(512)
        .and_then(|value| value.checked_add(padded_member_bytes))
        .ok_or_else(|| {
            Error::Engine(format!(
                "prebuilt extension artifact {} expanded size overflows",
                artifact_root.display()
            ))
        })?;
    if shape.expanded_bytes > policy.max_expanded_bytes {
        return Err(Error::Engine(format!(
            "prebuilt extension artifact {} expands beyond {} bytes",
            artifact_root.display(),
            policy.max_expanded_bytes
        )));
    }
    Ok(())
}

fn append_artifact_files_to_tar<W: io::Write>(
    archive: &mut tar::Builder<W>,
    artifact_root: &Path,
    current: &Path,
    policy: ExtensionArtifactArchivePolicy,
    shape: &mut ExtensionArtifactArchiveShape,
) -> Result<()> {
    let mut entries = fs::read_dir(current)
        .map_err(|err| Error::Engine(format!("read {}: {err}", current.display())))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| Error::Engine(format!("read entry in {}: {err}", current.display())))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|err| Error::Engine(format!("stat {}: {err}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(Error::Engine(format!(
                "prebuilt extension artifact archives do not support symlinks: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            append_artifact_files_to_tar(archive, artifact_root, &path, policy, shape)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(Error::Engine(format!(
                "prebuilt extension artifact archives only support files and directories: {}",
                path.display()
            )));
        }
        let relative = path.strip_prefix(artifact_root).map_err(|err| {
            Error::Engine(format!(
                "derive prebuilt extension artifact archive path for {}: {err}",
                path.display()
            ))
        })?;
        validate_relative_artifact_path(artifact_root, "archive file", relative)?;
        let portable_relative =
            render_portable_artifact_path(relative, "prebuilt extension archive file")?;
        record_extension_artifact_archive_member(
            artifact_root,
            relative,
            metadata.len(),
            policy,
            shape,
        )?;
        let mut header = tar::Header::new_gnu();
        header.set_size(metadata.len());
        header.set_mode(portable_tar_mode(&metadata));
        header.set_mtime(0);
        header.set_cksum();
        let mut file = File::open(&path)
            .map_err(|err| Error::Engine(format!("open {}: {err}", path.display())))?;
        archive
            .append_data(&mut header, portable_relative, &mut file)
            .map_err(|err| {
                Error::Engine(format!(
                    "append {} to prebuilt extension artifact archive: {err}",
                    relative.display()
                ))
            })?;
    }
    Ok(())
}

fn portable_tar_mode(metadata: &fs::Metadata) -> u32 {
    if metadata.is_dir() {
        return 0o755;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            0o755
        } else {
            0o644
        }
    }
    #[cfg(not(unix))]
    {
        0o644
    }
}

fn unique_extension_artifact_staging_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "oliphaunt-extension-artifact-create-{}-{nanos}",
        std::process::id()
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_manifest_path_fields_use_portable_component_separators() {
        let data_file = ["data", "nested", "acme.rules"]
            .into_iter()
            .collect::<PathBuf>();
        assert_eq!(
            render_portable_artifact_path(&data_file, "test data file").unwrap(),
            "data/nested/acme.rules"
        );

        let mobile_archive = MobileStaticArchive {
            target: "ios-simulator".to_owned(),
            relative_path: [
                "mobile-static",
                "ios-simulator",
                "extensions",
                "acme",
                "liboliphaunt_extension_acme.a",
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            mobile_static_archive_manifest_value(&[mobile_archive]).unwrap(),
            "ios-simulator:mobile-static/ios-simulator/extensions/acme/liboliphaunt_extension_acme.a"
        );

        let dependency_archive = MobileStaticDependencyArchive {
            target: "android-arm64-v8a".to_owned(),
            name: "openssl".to_owned(),
            relative_path: [
                "mobile-static",
                "android-arm64-v8a",
                "dependencies",
                "openssl",
                "libcrypto.a",
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            mobile_static_dependency_archive_manifest_value(&[dependency_archive]).unwrap(),
            "android-arm64-v8a:openssl:mobile-static/android-arm64-v8a/dependencies/openssl/libcrypto.a"
        );

        assert!(render_portable_artifact_path(Path::new("../escape"), "test escape").is_err());
        assert_eq!(
            render_portable_artifact_path(
                Path::new("licenses/donn\u{e9}es/\u{8bb8}\u{53ef}\u{8bc1}.txt"),
                "test Unicode path",
            )
            .unwrap(),
            "licenses/donn\u{e9}es/\u{8bb8}\u{53ef}\u{8bc1}.txt"
        );
        for path in [
            "C:/payload.bin",
            "payload:name.bin",
            "CON.txt",
            "com1.dll",
            "trailing.",
            "trailing ",
            "control-\u{1f}",
            "forbidden|name",
        ] {
            assert!(
                render_portable_artifact_path(Path::new(path), "test unsafe path").is_err(),
                "producer accepted non-portable manifest path {path:?}"
            );
        }
    }
}
