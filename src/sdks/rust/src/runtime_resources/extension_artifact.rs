use super::*;
use std::path::Component;

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
    if loaded.sql_name != options.sql_name {
        return Err(Error::Engine(format!(
            "created prebuilt extension artifact for '{}', expected '{}'",
            loaded.sql_name, options.sql_name
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
    for dependency in &options.dependencies {
        validate_portable_id(dependency, "prebuilt extension dependency")?;
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
    }
    copy_mobile_static_archives_to_artifact(artifact_root, options, &extension)?;
    copy_mobile_static_dependency_archives_to_artifact(artifact_root, options, &extension)?;
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
        creates_extension: options.creates_extension,
        native_module_stem: options.native_module_stem.clone(),
        native_module_file,
        native_target: options.native_target.clone(),
        dependencies: sorted_deduped_strings(&options.dependencies),
        data_files: sorted_deduped_paths(&options.data_files),
        shared_preload_libraries: sorted_deduped_strings(&options.shared_preload_libraries),
        mobile_prebuilt: artifact_mobile_prebuilt(options),
        mobile_static_archives: mobile_static_archives_for_artifact_options(options),
        mobile_static_dependency_archives: mobile_static_dependency_archives_for_artifact_options(
            options,
        )?,
        static_symbol_prefix: options.static_symbol_prefix.clone(),
        static_symbol_aliases: sorted_static_symbol_aliases(&options.static_symbol_aliases),
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
        if !extension_sql_file_belongs(&extension.sql_name, &file_name) {
            continue;
        }
        copied += 1;
        if file_name == format!("{}.control", extension.sql_name) {
            copied_control = true;
        } else if file_name.ends_with(".sql") {
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
    let text = format!(
        "packageLayout={EXTENSION_ARTIFACT_LAYOUT}\npgMajor=18\nsqlName={}\ncreatesExtension={}\nnativeModuleStem={}\nnativeModuleFile={}\nnativeTarget={}\ndependencies={}\ndataFiles={}\nsharedPreloadLibraries={}\nmobilePrebuilt={}\nmobileStaticArchives={}\nmobileStaticDependencyArchives={}\nstaticSymbolPrefix={}\nstaticSymbolAliases={}\nfiles=files\n",
        extension.sql_name,
        yes_no_manifest(options.creates_extension),
        extension.native_module_stem.as_deref().unwrap_or(""),
        extension.native_module_file.as_deref().unwrap_or(""),
        extension.native_target.as_deref().unwrap_or(""),
        extension.dependencies.join(","),
        extension
            .data_files
            .iter()
            .map(|path| path.to_string_lossy())
            .collect::<Vec<_>>()
            .join(","),
        extension.shared_preload_libraries.join(","),
        yes_no_manifest(extension.mobile_prebuilt),
        mobile_static_archive_manifest_value(&extension.mobile_static_archives),
        mobile_static_dependency_archive_manifest_value(
            &extension.mobile_static_dependency_archives
        ),
        extension.static_symbol_prefix.as_deref().unwrap_or(""),
        static_symbol_alias_manifest_value(&extension.static_symbol_aliases),
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

fn mobile_static_archive_manifest_value(archives: &[MobileStaticArchive]) -> String {
    archives
        .iter()
        .map(|archive| {
            format!(
                "{}:{}",
                archive.target,
                archive.relative_path.to_string_lossy()
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn mobile_static_dependency_archive_manifest_value(
    archives: &[MobileStaticDependencyArchive],
) -> String {
    archives
        .iter()
        .map(|archive| {
            format!(
                "{}:{}:{}",
                archive.target,
                archive.name,
                archive.relative_path.to_string_lossy()
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn yes_no_manifest(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn write_prebuilt_extension_artifact_archive(
    artifact_root: &Path,
    output: &Path,
    format: NativeExtensionArtifactFormat,
) -> Result<()> {
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
    }
}

fn write_prebuilt_extension_artifact_tar<W: io::Write>(
    writer: W,
    artifact_root: &Path,
) -> Result<W> {
    let mut archive = tar::Builder::new(writer);
    append_artifact_files_to_tar(&mut archive, artifact_root, artifact_root)?;
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

fn append_artifact_files_to_tar<W: io::Write>(
    archive: &mut tar::Builder<W>,
    artifact_root: &Path,
    current: &Path,
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
            append_artifact_files_to_tar(archive, artifact_root, &path)?;
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
        let mut header = tar::Header::new_gnu();
        header.set_size(metadata.len());
        header.set_mode(portable_tar_mode(&metadata));
        header.set_mtime(0);
        header.set_cksum();
        let mut file = File::open(&path)
            .map_err(|err| Error::Engine(format!("open {}: {err}", path.display())))?;
        archive
            .append_data(&mut header, relative, &mut file)
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
    if archive_is_tar_zst(archive_path) {
        let decoder = zstd::stream::read::Decoder::new(file).map_err(|err| {
            Error::InvalidConfig(format!(
                "open zstd prebuilt extension artifact archive {}: {err}",
                archive_path.display()
            ))
        })?;
        extract_prebuilt_extension_tar(archive_path, decoder, destination)?;
    } else if archive_is_tar_gz(archive_path) {
        let decoder = flate2::read::GzDecoder::new(file);
        extract_prebuilt_extension_tar(archive_path, decoder, destination)?;
    } else if archive_is_tar(archive_path) {
        extract_prebuilt_extension_tar(archive_path, file, destination)?;
    } else {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact archive {} must end in .tar, .tar.gz, or .tar.zst",
            archive_path.display()
        )));
    }
    extracted_extension_artifact_root(destination)
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
) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive.entries().map_err(|err| {
        Error::InvalidConfig(format!(
            "read prebuilt extension artifact archive {}: {err}",
            archive_path.display()
        ))
    })?;
    let mut seen_files = BTreeSet::new();
    let mut seen_dirs = BTreeSet::new();
    for entry in entries {
        let mut entry = entry.map_err(|err| {
            Error::InvalidConfig(format!(
                "read prebuilt extension artifact archive entry in {}: {err}",
                archive_path.display()
            ))
        })?;
        let relative = entry.path().map_err(|err| {
            Error::InvalidConfig(format!(
                "read prebuilt extension artifact archive path in {}: {err}",
                archive_path.display()
            ))
        })?;
        let relative = relative.into_owned();
        validate_relative_artifact_path(archive_path, "archive entry", &relative)?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            validate_archive_entry_plan(&relative, true, &mut seen_files, &mut seen_dirs)?;
            fs::create_dir_all(destination.join(&relative)).map_err(|err| {
                Error::Engine(format!(
                    "create prebuilt extension artifact archive dir {}: {err}",
                    destination.join(&relative).display()
                ))
            })?;
        } else if entry_type.is_file() {
            validate_archive_entry_plan(&relative, false, &mut seen_files, &mut seen_dirs)?;
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
    Ok(())
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
    let nested = children
        .iter()
        .filter(|entry| entry.path().join("manifest.properties").is_file())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    if nested.len() == 1 {
        return Ok(nested[0].clone());
    }
    Err(Error::InvalidConfig(format!(
        "prebuilt extension artifact archive extracted to {} but did not contain manifest.properties at archive root or under one top-level directory",
        destination.display()
    )))
}
