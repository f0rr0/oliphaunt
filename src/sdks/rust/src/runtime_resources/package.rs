use super::*;

pub(super) fn prepare_output_root(root: &Path, replace_existing: bool) -> Result<()> {
    if root.exists() {
        if !replace_existing {
            return Err(Error::InvalidConfig(format!(
                "native runtime-resource output {} already exists; pass --force or replace_existing(true)",
                root.display()
            )));
        }
        fs::remove_dir_all(root)
            .map_err(|err| Error::Engine(format!("remove {}: {err}", root.display())))?;
    }
    fs::create_dir_all(root)
        .map_err(|err| Error::Engine(format!("create {}: {err}", root.display())))
}

pub(super) fn write_runtime_resource_tree(
    root: &Path,
    mode: EngineMode,
    materialized: &MaterializedNativeResources,
    extensions: &[RuntimeResourceExtension],
    shared_preload_libraries: &[String],
    mobile_static_registry: &MobileStaticRegistryMetadata,
    extension_target: Option<&str>,
) -> Result<()> {
    let runtime_package = root.join("runtime");
    let runtime_files = runtime_package.join("files");
    copy_portable_tree(&materialized.runtime_dir, &runtime_files)?;
    prune_unselected_built_in_extension_artifacts(
        &runtime_files,
        extensions,
        extension_target,
        mobile_static_registry,
    )?;
    copy_prebuilt_extension_artifacts(
        &runtime_files,
        extensions,
        extension_target,
        mobile_static_registry,
    )?;
    write_manifest(
        &runtime_package,
        &RuntimeResourceManifest {
            cache_key: &materialized.runtime_cache_key,
            layout: RUNTIME_FILES_LAYOUT,
            mode,
            extensions,
            shared_preload_libraries,
            mobile_static_registry,
        },
    )?;

    let template_mobile_static_registry = mobile_static_registry_metadata(&[], &[])?;
    let template_package = root.join("template-pgdata");
    let template_files = template_package.join("files");
    copy_portable_tree(&materialized.template_pgdata, &template_files)?;
    write_manifest(
        &template_package,
        &RuntimeResourceManifest {
            cache_key: &materialized.template_cache_key,
            layout: TEMPLATE_PGDATA_LAYOUT,
            mode,
            extensions: &[],
            shared_preload_libraries: &[],
            mobile_static_registry: &template_mobile_static_registry,
        },
    )?;
    write_static_registry_package(root, &runtime_files, extensions, mobile_static_registry)?;
    Ok(())
}

fn prune_unselected_built_in_extension_artifacts(
    runtime_files: &Path,
    extensions: &[RuntimeResourceExtension],
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<()> {
    let selected_built_in = extensions
        .iter()
        .filter_map(|extension| match extension.source {
            RuntimeResourceExtensionSource::BuiltIn(_) => Some(extension),
            RuntimeResourceExtensionSource::Prebuilt { .. } => None,
        })
        .collect::<Vec<_>>();
    prune_built_in_extension_sql_files(runtime_files, &selected_built_in)?;
    prune_built_in_extension_data_files(runtime_files, &selected_built_in)?;
    prune_built_in_extension_module_files(
        runtime_files,
        &selected_built_in,
        extension_target,
        mobile_static_registry,
    )?;
    prune_prebuilt_extension_base_artifact_paths(runtime_files, extensions)?;
    Ok(())
}

fn prune_built_in_extension_sql_files(
    runtime_files: &Path,
    selected_built_in: &[&RuntimeResourceExtension],
) -> Result<()> {
    let extension_dir = runtime_files.join("share/postgresql/extension");
    if !extension_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&extension_dir)
        .map_err(|err| Error::Engine(format!("read {}: {err}", extension_dir.display())))?
    {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", extension_dir.display()))
        })?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let keep = selected_built_in
            .iter()
            .any(|extension| extension_sql_file_belongs(&extension.sql_name, &file_name));
        if !keep {
            fs::remove_file(&path)
                .map_err(|err| Error::Engine(format!("remove {}: {err}", path.display())))?;
        }
    }
    Ok(())
}

fn prune_built_in_extension_data_files(
    runtime_files: &Path,
    selected_built_in: &[&RuntimeResourceExtension],
) -> Result<()> {
    let selected_data_files = selected_built_in
        .iter()
        .flat_map(|extension| extension.data_files.iter().cloned())
        .collect::<BTreeSet<_>>();
    for extension in Extension::ALL_PG18_SUPPORTED {
        for relative in extension_data_paths(*extension) {
            if selected_data_files.contains(&relative) {
                continue;
            }
            remove_runtime_file_if_present(
                runtime_files,
                &PathBuf::from("share/postgresql").join(relative),
            )?;
        }
    }
    Ok(())
}

fn prune_built_in_extension_module_files(
    runtime_files: &Path,
    selected_built_in: &[&RuntimeResourceExtension],
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<()> {
    let mut selected_modules = BTreeSet::new();
    for extension in selected_built_in {
        if extension_dynamic_module_required(extension, extension_target, mobile_static_registry)? {
            if let Some(module) = &extension.native_module_file {
                selected_modules.insert(module.clone());
            }
        }
    }
    for extension in Extension::ALL_PG18_SUPPORTED {
        let Some(module) = extension.native_module_file() else {
            continue;
        };
        if selected_modules.contains(&module) {
            continue;
        }
        remove_runtime_file_if_present(
            runtime_files,
            &PathBuf::from("lib/postgresql").join(module),
        )?;
    }
    Ok(())
}

fn remove_runtime_file_if_present(runtime_files: &Path, relative: &Path) -> Result<()> {
    let path = runtime_files.join(relative);
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() {
        return fs::remove_file(&path)
            .map_err(|err| Error::Engine(format!("remove {}: {err}", path.display())));
    }
    Err(Error::InvalidConfig(format!(
        "expected extension runtime asset {} to be a regular file",
        path.display()
    )))
}

fn prune_prebuilt_extension_base_artifact_paths(
    runtime_files: &Path,
    extensions: &[RuntimeResourceExtension],
) -> Result<()> {
    for extension in extensions {
        let RuntimeResourceExtensionSource::Prebuilt { .. } = &extension.source else {
            continue;
        };
        for relative in &extension.data_files {
            remove_runtime_file_if_present(
                runtime_files,
                &PathBuf::from("share/postgresql").join(relative),
            )?;
        }
        if let Some(module) = &extension.native_module_file {
            remove_runtime_file_if_present(
                runtime_files,
                &PathBuf::from("lib/postgresql").join(module),
            )?;
        }
    }
    Ok(())
}

pub(super) fn copy_prebuilt_extension_artifacts(
    runtime_files: &Path,
    extensions: &[RuntimeResourceExtension],
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<()> {
    for extension in extensions {
        let RuntimeResourceExtensionSource::Prebuilt { root, files_root } = &extension.source
        else {
            continue;
        };
        copy_prebuilt_extension_sql_files(root, files_root, runtime_files, extension)?;
        for relative in &extension.data_files {
            copy_artifact_runtime_file(
                files_root,
                runtime_files,
                &PathBuf::from("share/postgresql").join(relative),
            )?;
        }
        if prebuilt_extension_dynamic_module_required(
            extension,
            extension_target,
            mobile_static_registry,
        )? {
            let Some(module) = &extension.native_module_file else {
                continue;
            };
            copy_artifact_runtime_file(
                files_root,
                runtime_files,
                &PathBuf::from("lib/postgresql").join(module),
            )?;
        }
    }
    Ok(())
}

fn copy_prebuilt_extension_sql_files(
    artifact_root: &Path,
    files_root: &Path,
    runtime_files: &Path,
    extension: &RuntimeResourceExtension,
) -> Result<()> {
    let source_dir = files_root.join("share/postgresql/extension");
    let target_dir = runtime_files.join("share/postgresql/extension");
    if !source_dir.is_dir() {
        if extension.creates_extension {
            return Err(Error::InvalidConfig(format!(
                "prebuilt extension artifact {} is missing files/share/postgresql/extension for '{}'",
                artifact_root.display(),
                extension.sql_name
            )));
        }
        return Ok(());
    }

    let mut copied_control = false;
    let mut copied_sql = false;
    let mut copied = 0usize;
    for entry in fs::read_dir(&source_dir)
        .map_err(|err| Error::Engine(format!("read {}: {err}", source_dir.display())))?
    {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", source_dir.display()))
        })?;
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
        copy_portable_tree(&entry.path(), &target_dir.join(file_name))?;
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

fn copy_artifact_runtime_file(
    source_root: &Path,
    runtime_files: &Path,
    relative: &Path,
) -> Result<()> {
    validate_relative_artifact_path(source_root, "runtime file", relative)?;
    let source = source_root.join(relative);
    if !source.is_file() {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact is missing declared file {}",
            source.display()
        )));
    }
    copy_portable_tree(&source, &runtime_files.join(relative))
}

pub(super) fn runtime_resource_size_report(
    root: &Path,
    selected_extensions: &[RuntimeResourceExtension],
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<NativeRuntimeResourceSizeReport> {
    let runtime_files = root.join("runtime/files");
    let template_pgdata_files = root.join("template-pgdata/files");
    let static_registry = root.join("static-registry");
    let selected_extension_paths = extension_asset_paths(
        &runtime_files,
        selected_extensions,
        extension_target,
        mobile_static_registry,
    )?;

    let mut extension_reports = Vec::new();
    for extension in selected_extensions {
        let extension_paths = extension_asset_paths(
            &runtime_files,
            std::slice::from_ref(extension),
            extension_target,
            mobile_static_registry,
        )?;
        extension_reports.push(ExtensionSizeReport {
            name: extension.sql_name.clone(),
            file_count: extension_paths.len(),
            bytes: byte_sum(&runtime_files, &extension_paths)?,
        });
    }
    extension_reports.sort_by(|left, right| left.name.cmp(&right.name));

    let runtime_bytes = tree_size(&runtime_files)?;
    let template_pgdata_bytes = tree_size(&template_pgdata_files)?;
    let static_registry_bytes = tree_size(&static_registry)?;
    Ok(NativeRuntimeResourceSizeReport {
        path: root.join("package-size.tsv"),
        package_bytes: runtime_bytes + template_pgdata_bytes + static_registry_bytes,
        runtime_bytes,
        template_pgdata_bytes,
        static_registry_bytes,
        selected_extension_bytes: byte_sum(&runtime_files, &selected_extension_paths)?,
        extensions: extension_reports,
    })
}

pub(super) fn write_runtime_resource_size_report(
    report: &NativeRuntimeResourceSizeReport,
) -> Result<()> {
    let mut lines = vec![
        "kind\tid\textensions\tfiles\tbytes".to_owned(),
        format!("package\ttotal\t-\t-\t{}", report.package_bytes),
        format!("package\truntime\t-\t-\t{}", report.runtime_bytes),
        format!(
            "package\ttemplate-pgdata\t-\t-\t{}",
            report.template_pgdata_bytes
        ),
        format!(
            "package\tstatic-registry\t-\t-\t{}",
            report.static_registry_bytes
        ),
        format!(
            "extensions\tselected\t-\t-\t{}",
            report.selected_extension_bytes
        ),
    ];
    for extension in &report.extensions {
        lines.push(format!(
            "extension\t{}\t-\t{}\t{}",
            extension.name, extension.file_count, extension.bytes
        ));
    }
    let text = format!("{}\n", lines.join("\n"));
    fs::write(&report.path, text).map_err(|err| {
        Error::Engine(format!(
            "write native runtime resource size report {}: {err}",
            report.path.display()
        ))
    })
}

fn extension_asset_paths(
    runtime_files: &Path,
    extensions: &[RuntimeResourceExtension],
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<BTreeSet<PathBuf>> {
    let mut paths = BTreeSet::new();
    for extension in extensions {
        if extension.creates_extension {
            let extension_dir = runtime_files.join("share/postgresql/extension");
            let mut matched_sql = false;
            for entry in fs::read_dir(&extension_dir)
                .map_err(|err| Error::Engine(format!("read {}: {err}", extension_dir.display())))?
            {
                let entry = entry.map_err(|err| {
                    Error::Engine(format!("read entry in {}: {err}", extension_dir.display()))
                })?;
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if extension_sql_file_belongs(&extension.sql_name, &file_name) {
                    let relative = PathBuf::from("share/postgresql/extension").join(&file_name);
                    require_report_file(runtime_files, &relative)?;
                    if file_name.ends_with(".sql") {
                        matched_sql = true;
                    }
                    paths.insert(relative);
                }
            }
            if !matched_sql {
                return Err(Error::Engine(format!(
                    "native runtime resource size report could not find SQL assets for selected extension '{}'",
                    extension.sql_name
                )));
            }
        }
        for relative in &extension.data_files {
            let relative = PathBuf::from("share/postgresql").join(relative);
            require_report_file(runtime_files, &relative)?;
            paths.insert(relative);
        }
        if extension_dynamic_module_required(extension, extension_target, mobile_static_registry)? {
            let Some(module) = &extension.native_module_file else {
                continue;
            };
            let relative = PathBuf::from("lib/postgresql").join(module);
            require_report_file(runtime_files, &relative)?;
            paths.insert(relative);
        }
    }
    Ok(paths)
}

fn extension_dynamic_module_required(
    extension: &RuntimeResourceExtension,
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<bool> {
    let Some(stem) = extension.native_module_stem.as_deref() else {
        return Ok(false);
    };
    if mobile_static_registry.state == MobileStaticRegistryState::Complete
        && mobile_static_registry
            .native_module_stems
            .iter()
            .any(|registered| registered == stem)
    {
        return Ok(false);
    }
    if let RuntimeResourceExtensionSource::Prebuilt { .. } = &extension.source {
        validate_prebuilt_extension_target(extension, extension_target)?;
    }
    Ok(extension.native_module_file.is_some())
}

fn prebuilt_extension_dynamic_module_required(
    extension: &RuntimeResourceExtension,
    extension_target: Option<&str>,
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<bool> {
    debug_assert!(matches!(
        extension.source,
        RuntimeResourceExtensionSource::Prebuilt { .. }
    ));
    extension_dynamic_module_required(extension, extension_target, mobile_static_registry)
}

fn validate_prebuilt_extension_target(
    extension: &RuntimeResourceExtension,
    extension_target: Option<&str>,
) -> Result<()> {
    let Some(native_target) = extension.native_target.as_deref() else {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact for '{}' declares a native module but no nativeTarget",
            extension.sql_name
        )));
    };
    let Some(extension_target) = extension_target else {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact for '{}' targets '{}', but runtime packaging did not declare --extension-target",
            extension.sql_name, native_target
        )));
    };
    if native_target != extension_target {
        return Err(Error::InvalidConfig(format!(
            "prebuilt extension artifact for '{}' targets '{}', but runtime packaging target is '{}'",
            extension.sql_name, native_target, extension_target
        )));
    }
    Ok(())
}

fn require_report_file(root: &Path, relative: &Path) -> Result<()> {
    let path = root.join(relative);
    if path.is_file() {
        return Ok(());
    }
    Err(Error::Engine(format!(
        "native runtime resource size report expected file {}",
        path.display()
    )))
}

fn byte_sum(root: &Path, relative_paths: &BTreeSet<PathBuf>) -> Result<u64> {
    relative_paths.iter().try_fold(0u64, |total, relative| {
        fs::metadata(root.join(relative))
            .map(|metadata| total + metadata.len())
            .map_err(|err| {
                Error::Engine(format!(
                    "stat native runtime resource size report file {}: {err}",
                    root.join(relative).display()
                ))
            })
    })
}

fn tree_size(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path).map_err(|err| {
        Error::Engine(format!(
            "stat {} for package size report: {err}",
            path.display()
        ))
    })?;
    let file_type = metadata.file_type();
    if file_type.is_file() {
        return Ok(metadata.len());
    }
    if file_type.is_symlink() {
        return Err(Error::Engine(format!(
            "native runtime resource size report does not support symlinks: {}",
            path.display()
        )));
    }
    if !file_type.is_dir() {
        return Err(Error::Engine(format!(
            "native runtime resource size report only supports files and directories: {}",
            path.display()
        )));
    }
    let mut total = 0u64;
    let mut entries = fs::read_dir(path)
        .map_err(|err| {
            Error::Engine(format!(
                "read {} for package size report: {err}",
                path.display()
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| {
            Error::Engine(format!(
                "read entry in {} for package size report: {err}",
                path.display()
            ))
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        total += tree_size(&entry.path())?;
    }
    Ok(total)
}

pub(super) struct RuntimeResourceManifest<'a> {
    pub(super) cache_key: &'a str,
    pub(super) layout: &'a str,
    pub(super) mode: EngineMode,
    pub(super) extensions: &'a [RuntimeResourceExtension],
    pub(super) shared_preload_libraries: &'a [String],
    pub(super) mobile_static_registry: &'a MobileStaticRegistryMetadata,
}

fn write_manifest(package_dir: &Path, manifest: &RuntimeResourceManifest<'_>) -> Result<()> {
    fs::create_dir_all(package_dir)
        .map_err(|err| Error::Engine(format!("create {}: {err}", package_dir.display())))?;
    fs::write(
        package_dir.join("manifest.properties"),
        manifest_text(manifest),
    )
    .map_err(|err| {
        Error::Engine(format!(
            "write native resource manifest {}: {err}",
            package_dir.join("manifest.properties").display()
        ))
    })
}

pub(super) fn manifest_text(manifest: &RuntimeResourceManifest<'_>) -> String {
    format!(
        "schema={RUNTIME_RESOURCES_SCHEMA}\nlayout={}\nmode={}\ncacheKey={}\nextensions={}\nsharedPreloadLibraries={}\nmobileStaticRegistryState={}\nmobileStaticRegistryRegistered={}\nmobileStaticRegistryPending={}\nnativeModuleStems={}\nmobileStaticRegistrySource={}\n",
        manifest.layout,
        manifest.mode,
        manifest.cache_key,
        selected_extension_names(manifest.extensions).join(","),
        manifest.shared_preload_libraries.join(","),
        manifest.mobile_static_registry.state.as_manifest_value(),
        manifest
            .mobile_static_registry
            .registered_extensions
            .join(","),
        manifest.mobile_static_registry.pending_extensions.join(","),
        manifest
            .mobile_static_registry
            .native_module_stems
            .join(","),
        mobile_static_registry_source_value(manifest.mobile_static_registry),
    )
}

pub(super) fn copy_portable_tree(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", source.display())))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(Error::Engine(format!(
            "native runtime resources do not support symlinks: {}",
            source.display()
        )));
    }
    if file_type.is_file() {
        copy_portable_file(source, destination, &metadata)?;
        return Ok(());
    }
    if !file_type.is_dir() {
        return Err(Error::Engine(format!(
            "native runtime resources only support files and directories: {}",
            source.display()
        )));
    }

    fs::create_dir_all(destination)
        .map_err(|err| Error::Engine(format!("create {}: {err}", destination.display())))?;
    fs::set_permissions(destination, metadata.permissions()).map_err(|err| {
        Error::Engine(format!(
            "set permissions on {}: {err}",
            destination.display()
        ))
    })?;

    let mut entries = fs::read_dir(source)
        .map_err(|err| Error::Engine(format!("read directory {}: {err}", source.display())))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| {
            Error::Engine(format!(
                "read directory entry in {}: {err}",
                source.display()
            ))
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        copy_portable_tree(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

pub(super) fn copy_portable_file(
    source: &Path,
    destination: &Path,
    metadata: &fs::Metadata,
) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    fs::copy(source, destination).map_err(|err| {
        Error::Engine(format!(
            "copy {} -> {}: {err}",
            source.display(),
            destination.display()
        ))
    })?;
    fs::set_permissions(destination, metadata.permissions()).map_err(|err| {
        Error::Engine(format!(
            "set permissions on {}: {err}",
            destination.display()
        ))
    })
}
