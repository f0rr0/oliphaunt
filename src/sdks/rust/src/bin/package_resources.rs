use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use oliphaunt::{
    EngineMode, Extension, ExtensionArtifactPolicy, ExtensionModuleAsset,
    NativeExtensionArtifactIndexOptions, NativeExtensionArtifactIndexTrustRoot,
    NativePrebuiltExtensionArtifact, NativeRuntimeFeature, NativeRuntimeResourceOptions,
    build_native_runtime_resources, list_prebuilt_extension_artifact_index_catalog,
    resolve_prebuilt_extension_artifacts_from_indexes,
};
use sha2::{Digest, Sha256};

fn main() {
    match run() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("oliphaunt-resources: {error}");
            process::exit(2);
        }
    }
}

fn run() -> oliphaunt::Result<()> {
    let args = PackageArgs::parse(env::args().skip(1))?;
    if args.help {
        print_help();
        return Ok(());
    }
    if args.list_extensions {
        print_extension_catalog(&args)?;
        return Ok(());
    }
    if args.resolve_broker_release_assets {
        resolve_broker_release_assets(&args)?;
        return Ok(());
    }
    if args.resolve_release_assets {
        resolve_release_assets(&args)?;
        return Ok(());
    }
    let output_dir = args.output_dir.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --output <directory>".to_owned())
    })?;
    let extension_target = args
        .extension_target
        .clone()
        .unwrap_or_else(default_extension_artifact_target);

    let mut built_in_extensions = Vec::new();
    let mut indexed_extensions = Vec::new();
    for extension in args.extensions {
        if let Some(extension) = Extension::by_release_ready_sql_name(&extension) {
            built_in_extensions.push(extension);
        } else {
            indexed_extensions.push(extension);
        }
    }
    let mut prebuilt_extensions = args.prebuilt_extensions;
    if !indexed_extensions.is_empty() {
        let resolution = resolve_prebuilt_extension_artifacts_from_indexes(
            NativeExtensionArtifactIndexOptions::new(extension_target.clone())
                .indexes(args.extension_indexes)
                .maybe_artifact_cache_dir(args.extension_cache_dir)
                .trusted_signing_keys(args.trusted_extension_index_keys)
                .require_signatures(args.require_signed_extension_indexes)
                .extensions(indexed_extensions),
        )?;
        prebuilt_extensions.extend(resolution.artifacts);
    }

    let mut options = NativeRuntimeResourceOptions::new(output_dir)
        .mode(args.mode)
        .runtime_features(args.runtime_features)
        .replace_existing(args.force)
        .require_mobile_static_registry(args.require_mobile_static_registry)
        .mobile_static_module_stems(args.mobile_static_module_stems)
        .extension_target(extension_target);
    for extension in built_in_extensions {
        options = options.extension(extension);
    }
    for artifact in prebuilt_extensions {
        options = options.prebuilt_extension(artifact.root);
    }

    let package = build_native_runtime_resources(options)?;
    println!("root={}", package.root.display());
    println!("runtimeFiles={}", package.runtime_files.display());
    println!(
        "templatePgdataFiles={}",
        package.template_pgdata_files.display()
    );
    println!("runtimeCacheKey={}", package.runtime_cache_key);
    println!("templateCacheKey={}", package.template_cache_key);
    println!("extensions={}", package.extension_names.join(","));
    println!(
        "runtimeFeatures={}",
        package
            .runtime_features
            .iter()
            .map(|feature| feature.as_str())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!(
        "mobileStaticRegistryState={}",
        match package.mobile_static_registry.state {
            oliphaunt::MobileStaticRegistryState::NotRequired => "not-required",
            oliphaunt::MobileStaticRegistryState::Complete => "complete",
            oliphaunt::MobileStaticRegistryState::Pending => "pending",
        }
    );
    println!(
        "mobileStaticRegistryPending={}",
        package.mobile_static_registry.pending_extensions.join(",")
    );
    println!(
        "mobileStaticRegistryRegistered={}",
        package
            .mobile_static_registry
            .registered_extensions
            .join(",")
    );
    println!(
        "sharedPreloadLibraries={}",
        package.shared_preload_libraries.join(",")
    );
    println!(
        "nativeModuleStems={}",
        package.mobile_static_registry.native_module_stems.join(",")
    );
    println!(
        "staticRegistryManifest={}",
        package.static_registry_manifest.display()
    );
    println!(
        "staticRegistrySource={}",
        package
            .static_registry_source
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    );
    println!("packageSizeReport={}", package.size_report.path.display());
    println!("packageBytes={}", package.size_report.package_bytes);
    println!("runtimeBytes={}", package.size_report.runtime_bytes);
    println!(
        "templatePgdataBytes={}",
        package.size_report.template_pgdata_bytes
    );
    println!(
        "staticRegistryBytes={}",
        package.size_report.static_registry_bytes
    );
    println!(
        "selectedExtensionBytes={}",
        package.size_report.selected_extension_bytes
    );
    println!(
        "extensionBytes={}",
        package
            .size_report
            .extensions
            .iter()
            .map(|extension| format!("{}:{}", extension.name, extension.bytes))
            .collect::<Vec<_>>()
            .join(",")
    );
    Ok(())
}

struct PackageArgs {
    output_dir: Option<PathBuf>,
    mode: EngineMode,
    extensions: Vec<String>,
    runtime_features: Vec<NativeRuntimeFeature>,
    extension_indexes: Vec<PathBuf>,
    extension_target: Option<String>,
    extension_cache_dir: Option<PathBuf>,
    trusted_extension_index_keys: Vec<NativeExtensionArtifactIndexTrustRoot>,
    require_signed_extension_indexes: bool,
    prebuilt_extensions: Vec<NativePrebuiltExtensionArtifact>,
    mobile_static_module_stems: Vec<String>,
    force: bool,
    require_mobile_static_registry: bool,
    resolve_release_assets: bool,
    liboliphaunt_version: Option<String>,
    release_asset_base_url: Option<String>,
    release_asset_cache_dir: Option<PathBuf>,
    release_asset_target: Option<String>,
    release_assets: Vec<String>,
    resolve_broker_release_assets: bool,
    broker_version: Option<String>,
    broker_release_asset_base_url: Option<String>,
    broker_release_asset_cache_dir: Option<PathBuf>,
    broker_release_asset_target: Option<String>,
    list_extensions: bool,
    help: bool,
}

impl PackageArgs {
    fn parse(args: impl IntoIterator<Item = String>) -> oliphaunt::Result<Self> {
        let mut parsed = Self {
            output_dir: None,
            mode: EngineMode::NativeDirect,
            extensions: Vec::new(),
            runtime_features: Vec::new(),
            extension_indexes: Vec::new(),
            extension_target: None,
            extension_cache_dir: None,
            trusted_extension_index_keys: Vec::new(),
            require_signed_extension_indexes: false,
            prebuilt_extensions: Vec::new(),
            mobile_static_module_stems: Vec::new(),
            force: false,
            require_mobile_static_registry: false,
            resolve_release_assets: false,
            liboliphaunt_version: env::var("OLIPHAUNT_LIBOLIPHAUNT_VERSION")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            release_asset_base_url: env::var("OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSET_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            release_asset_cache_dir: env::var("OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSET_CACHE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from),
            release_asset_target: env::var("OLIPHAUNT_LIBOLIPHAUNT_RELEASE_TARGET")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            release_assets: Vec::new(),
            resolve_broker_release_assets: false,
            broker_version: env::var("OLIPHAUNT_BROKER_VERSION")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            broker_release_asset_base_url: env::var("OLIPHAUNT_BROKER_RELEASE_ASSET_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            broker_release_asset_cache_dir: env::var("OLIPHAUNT_BROKER_RELEASE_ASSET_CACHE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from),
            broker_release_asset_target: env::var("OLIPHAUNT_BROKER_RELEASE_TARGET")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            list_extensions: false,
            help: false,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-h" | "--help" => parsed.help = true,
                "--list-extensions" => parsed.list_extensions = true,
                "--resolve-release-assets" | "--resolve-liboliphaunt-release" => {
                    parsed.resolve_release_assets = true;
                }
                "--resolve-broker-release-assets" | "--resolve-oliphaunt-broker-release" => {
                    parsed.resolve_broker_release_assets = true;
                }
                "--force" => parsed.force = true,
                "--require-mobile-static-registry" => {
                    parsed.require_mobile_static_registry = true;
                }
                "--mobile-static-module" | "--mobile-static-registry-module" => {
                    let value = next_value(&mut args, &arg)?;
                    push_mobile_static_module_stems(&mut parsed.mobile_static_module_stems, &value);
                }
                "--output" | "-o" => {
                    let value = next_value(&mut args, &arg)?;
                    parsed.output_dir = Some(PathBuf::from(value));
                }
                "--liboliphaunt-native-version" => {
                    parsed.liboliphaunt_version = Some(next_value(&mut args, &arg)?);
                }
                "--broker-version" | "--oliphaunt-broker-version" => {
                    parsed.broker_version = Some(next_value(&mut args, &arg)?);
                }
                "--release-asset-base-url" => {
                    parsed.release_asset_base_url = Some(next_value(&mut args, &arg)?);
                }
                "--broker-release-asset-base-url" => {
                    parsed.broker_release_asset_base_url = Some(next_value(&mut args, &arg)?);
                }
                "--release-asset-cache" | "--release-asset-cache-dir" => {
                    parsed.release_asset_cache_dir =
                        Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--broker-release-asset-cache" | "--broker-release-asset-cache-dir" => {
                    parsed.broker_release_asset_cache_dir =
                        Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--release-asset-target" | "--release-target" => {
                    parsed.release_asset_target = Some(next_value(&mut args, &arg)?);
                }
                "--broker-release-target" | "--broker-release-asset-target" => {
                    parsed.broker_release_asset_target = Some(next_value(&mut args, &arg)?);
                }
                "--release-asset" => {
                    parsed.release_assets.push(next_value(&mut args, &arg)?);
                    parsed.resolve_release_assets = true;
                }
                "--mode" => {
                    let value = next_value(&mut args, &arg)?;
                    parsed.mode = parse_mode(&value)?;
                }
                "--extension" => {
                    let value = next_value(&mut args, &arg)?;
                    push_extension_names(&mut parsed.extensions, &value);
                }
                "--runtime-feature" | "--runtime-features" => {
                    let value = next_value(&mut args, &arg)?;
                    push_runtime_feature_names(&mut parsed.runtime_features, &value)?;
                }
                "--extension-index" | "--external-extension-index" => {
                    let value = next_value(&mut args, &arg)?;
                    parsed.extension_indexes.push(PathBuf::from(value));
                }
                "--extension-target" | "--artifact-target" => {
                    parsed.extension_target = Some(next_value(&mut args, &arg)?);
                }
                "--extension-cache" | "--extension-artifact-cache" => {
                    parsed.extension_cache_dir = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--trusted-extension-index-key" => {
                    let (key_id, key) = parse_key_value(&next_value(&mut args, &arg)?)?;
                    parsed
                        .trusted_extension_index_keys
                        .push(NativeExtensionArtifactIndexTrustRoot::new(key_id, key));
                    parsed.require_signed_extension_indexes = true;
                }
                "--trusted-extension-index-key-file" => {
                    let (key_id, key) = read_key_file_value(&next_value(&mut args, &arg)?)?;
                    parsed
                        .trusted_extension_index_keys
                        .push(NativeExtensionArtifactIndexTrustRoot::new(key_id, key));
                    parsed.require_signed_extension_indexes = true;
                }
                "--require-signed-extension-index" | "--require-signed-extension-indexes" => {
                    parsed.require_signed_extension_indexes = true;
                }
                "--prebuilt-extension" | "--prebuilt-extension-artifact" => {
                    let value = next_value(&mut args, &arg)?;
                    parsed
                        .prebuilt_extensions
                        .push(NativePrebuiltExtensionArtifact::new(PathBuf::from(value)));
                }
                value if value.starts_with("--output=") => {
                    parsed.output_dir =
                        Some(PathBuf::from(value_without_prefix(value, "--output=")));
                }
                value if value.starts_with("--liboliphaunt-native-version=") => {
                    parsed.liboliphaunt_version = Some(
                        value_without_prefix(value, "--liboliphaunt-native-version=").to_owned(),
                    );
                }
                value if value.starts_with("--broker-version=") => {
                    parsed.broker_version =
                        Some(value_without_prefix(value, "--broker-version=").to_owned());
                }
                value if value.starts_with("--oliphaunt-broker-version=") => {
                    parsed.broker_version =
                        Some(value_without_prefix(value, "--oliphaunt-broker-version=").to_owned());
                }
                value if value.starts_with("--release-asset-base-url=") => {
                    parsed.release_asset_base_url =
                        Some(value_without_prefix(value, "--release-asset-base-url=").to_owned());
                }
                value if value.starts_with("--broker-release-asset-base-url=") => {
                    parsed.broker_release_asset_base_url = Some(
                        value_without_prefix(value, "--broker-release-asset-base-url=").to_owned(),
                    );
                }
                value if value.starts_with("--release-asset-cache=") => {
                    parsed.release_asset_cache_dir = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--release-asset-cache=",
                    )));
                }
                value if value.starts_with("--release-asset-cache-dir=") => {
                    parsed.release_asset_cache_dir = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--release-asset-cache-dir=",
                    )));
                }
                value if value.starts_with("--broker-release-asset-cache=") => {
                    parsed.broker_release_asset_cache_dir = Some(PathBuf::from(
                        value_without_prefix(value, "--broker-release-asset-cache="),
                    ));
                }
                value if value.starts_with("--broker-release-asset-cache-dir=") => {
                    parsed.broker_release_asset_cache_dir = Some(PathBuf::from(
                        value_without_prefix(value, "--broker-release-asset-cache-dir="),
                    ));
                }
                value if value.starts_with("--release-asset-target=") => {
                    parsed.release_asset_target =
                        Some(value_without_prefix(value, "--release-asset-target=").to_owned());
                }
                value if value.starts_with("--release-target=") => {
                    parsed.release_asset_target =
                        Some(value_without_prefix(value, "--release-target=").to_owned());
                }
                value if value.starts_with("--broker-release-target=") => {
                    parsed.broker_release_asset_target =
                        Some(value_without_prefix(value, "--broker-release-target=").to_owned());
                }
                value if value.starts_with("--broker-release-asset-target=") => {
                    parsed.broker_release_asset_target = Some(
                        value_without_prefix(value, "--broker-release-asset-target=").to_owned(),
                    );
                }
                value if value.starts_with("--release-asset=") => {
                    parsed
                        .release_assets
                        .push(value_without_prefix(value, "--release-asset=").to_owned());
                    parsed.resolve_release_assets = true;
                }
                value if value.starts_with("--mode=") => {
                    parsed.mode = parse_mode(value_without_prefix(value, "--mode="))?;
                }
                value if value.starts_with("--extension=") => {
                    push_extension_names(
                        &mut parsed.extensions,
                        value_without_prefix(value, "--extension="),
                    );
                }
                value if value.starts_with("--runtime-feature=") => {
                    push_runtime_feature_names(
                        &mut parsed.runtime_features,
                        value_without_prefix(value, "--runtime-feature="),
                    )?;
                }
                value if value.starts_with("--runtime-features=") => {
                    push_runtime_feature_names(
                        &mut parsed.runtime_features,
                        value_without_prefix(value, "--runtime-features="),
                    )?;
                }
                value if value.starts_with("--extension-index=") => {
                    parsed
                        .extension_indexes
                        .push(PathBuf::from(value_without_prefix(
                            value,
                            "--extension-index=",
                        )));
                }
                value if value.starts_with("--external-extension-index=") => {
                    parsed
                        .extension_indexes
                        .push(PathBuf::from(value_without_prefix(
                            value,
                            "--external-extension-index=",
                        )));
                }
                value if value.starts_with("--extension-target=") => {
                    parsed.extension_target =
                        Some(value_without_prefix(value, "--extension-target=").to_owned());
                }
                value if value.starts_with("--artifact-target=") => {
                    parsed.extension_target =
                        Some(value_without_prefix(value, "--artifact-target=").to_owned());
                }
                value if value.starts_with("--extension-cache=") => {
                    parsed.extension_cache_dir = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--extension-cache=",
                    )));
                }
                value if value.starts_with("--extension-artifact-cache=") => {
                    parsed.extension_cache_dir = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--extension-artifact-cache=",
                    )));
                }
                value if value.starts_with("--trusted-extension-index-key=") => {
                    let (key_id, key) = parse_key_value(value_without_prefix(
                        value,
                        "--trusted-extension-index-key=",
                    ))?;
                    parsed
                        .trusted_extension_index_keys
                        .push(NativeExtensionArtifactIndexTrustRoot::new(key_id, key));
                    parsed.require_signed_extension_indexes = true;
                }
                value if value.starts_with("--trusted-extension-index-key-file=") => {
                    let (key_id, key) = read_key_file_value(value_without_prefix(
                        value,
                        "--trusted-extension-index-key-file=",
                    ))?;
                    parsed
                        .trusted_extension_index_keys
                        .push(NativeExtensionArtifactIndexTrustRoot::new(key_id, key));
                    parsed.require_signed_extension_indexes = true;
                }
                value if value.starts_with("--prebuilt-extension=") => {
                    parsed
                        .prebuilt_extensions
                        .push(NativePrebuiltExtensionArtifact::new(PathBuf::from(
                            value_without_prefix(value, "--prebuilt-extension="),
                        )));
                }
                value if value.starts_with("--prebuilt-extension-artifact=") => {
                    parsed
                        .prebuilt_extensions
                        .push(NativePrebuiltExtensionArtifact::new(PathBuf::from(
                            value_without_prefix(value, "--prebuilt-extension-artifact="),
                        )));
                }
                value if value.starts_with("--mobile-static-module=") => {
                    push_mobile_static_module_stems(
                        &mut parsed.mobile_static_module_stems,
                        value_without_prefix(value, "--mobile-static-module="),
                    );
                }
                value if value.starts_with("--mobile-static-registry-module=") => {
                    push_mobile_static_module_stems(
                        &mut parsed.mobile_static_module_stems,
                        value_without_prefix(value, "--mobile-static-registry-module="),
                    );
                }
                _ => {
                    return Err(oliphaunt::Error::InvalidConfig(format!(
                        "unknown argument '{arg}'"
                    )));
                }
            }
        }
        Ok(parsed)
    }
}

fn resolve_release_assets(args: &PackageArgs) -> oliphaunt::Result<()> {
    let version = args.liboliphaunt_version.as_deref().ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "--resolve-release-assets requires --liboliphaunt-native-version <version>".to_owned(),
        )
    })?;
    validate_release_version(version, "liboliphaunt")?;
    let base_url = args.release_asset_base_url.clone().unwrap_or_else(|| {
        format!(
            "https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v{version}"
        )
    });
    let cache_dir = args
        .release_asset_cache_dir
        .clone()
        .unwrap_or_else(default_release_asset_cache_dir)
        .join(version);
    fs::create_dir_all(&cache_dir).map_err(|err| {
        oliphaunt::Error::Engine(format!(
            "create liboliphaunt release asset cache {}: {err}",
            cache_dir.display()
        ))
    })?;

    let checksum_name = format!("liboliphaunt-{version}-release-assets.sha256");
    let checksum_path =
        download_release_asset(&base_url, &checksum_name, &cache_dir, "liboliphaunt")?;
    let checksums = parse_release_checksum_file(&checksum_path, "liboliphaunt")?;
    let release_target = args
        .release_asset_target
        .clone()
        .unwrap_or_else(|| default_release_asset_target().to_owned());
    let mut assets = release_asset_names_for_target(version, &release_target)?;
    assets.extend(args.release_assets.iter().cloned());
    assets.sort();
    assets.dedup();
    for asset in &assets {
        let path = download_release_asset(&base_url, asset, &cache_dir, "liboliphaunt")?;
        verify_release_asset_checksum(&checksums, asset, &path, "liboliphaunt")?;
    }
    verify_release_asset_checksum(&checksums, &checksum_name, &checksum_path, "liboliphaunt").ok();

    if let Some(output_dir) = &args.output_dir {
        let runtime_asset = format!("liboliphaunt-{version}-runtime-resources.tar.gz");
        let runtime_path = cache_dir.join(&runtime_asset);
        if runtime_path.is_file() {
            extract_runtime_resources_archive(&runtime_path, output_dir, args.force)?;
        }
    }

    println!("liboliphauntReleaseVersion={version}");
    println!("liboliphauntReleaseAssetBaseUrl={base_url}");
    println!("liboliphauntReleaseAssetCache={}", cache_dir.display());
    println!("liboliphauntReleaseAssets={}", assets.join(","));
    Ok(())
}

fn resolve_broker_release_assets(args: &PackageArgs) -> oliphaunt::Result<()> {
    let version = args.broker_version.as_deref().ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "--resolve-broker-release-assets requires --broker-version <version>".to_owned(),
        )
    })?;
    validate_release_version(version, "oliphaunt-broker")?;
    let base_url = args
        .broker_release_asset_base_url
        .clone()
        .or_else(|| args.release_asset_base_url.clone())
        .unwrap_or_else(|| {
            format!(
                "https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-broker-v{version}"
            )
        });
    let cache_dir = args
        .broker_release_asset_cache_dir
        .clone()
        .or_else(|| args.release_asset_cache_dir.clone())
        .unwrap_or_else(default_broker_release_asset_cache_dir)
        .join(version);
    fs::create_dir_all(&cache_dir).map_err(|err| {
        oliphaunt::Error::Engine(format!(
            "create oliphaunt-broker release asset cache {}: {err}",
            cache_dir.display()
        ))
    })?;

    let checksum_name = format!("oliphaunt-broker-{version}-release-assets.sha256");
    let checksum_path =
        download_release_asset(&base_url, &checksum_name, &cache_dir, "oliphaunt-broker")?;
    let checksums = parse_release_checksum_file(&checksum_path, "oliphaunt-broker")?;
    let release_target = args
        .broker_release_asset_target
        .clone()
        .or_else(|| args.release_asset_target.clone())
        .unwrap_or_else(default_broker_release_asset_target);
    let asset = broker_release_asset_name_for_target(version, &release_target)?;
    let asset_path = download_release_asset(&base_url, &asset, &cache_dir, "oliphaunt-broker")?;
    verify_release_asset_checksum(&checksums, &asset, &asset_path, "oliphaunt-broker")?;

    if let Some(output_dir) = &args.output_dir {
        extract_broker_release_archive(&asset_path, output_dir, args.force)?;
    }

    println!("oliphauntBrokerReleaseVersion={version}");
    println!("oliphauntBrokerReleaseAssetBaseUrl={base_url}");
    println!("oliphauntBrokerReleaseAssetCache={}", cache_dir.display());
    println!("oliphauntBrokerReleaseAssets={asset}");
    Ok(())
}

fn validate_release_version(version: &str, product_label: &str) -> oliphaunt::Result<()> {
    let valid = version
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    if !valid || version.is_empty() {
        return Err(oliphaunt::Error::InvalidConfig(format!(
            "invalid {product_label} release version '{version}'"
        )));
    }
    Ok(())
}

fn default_release_asset_cache_dir() -> PathBuf {
    if let Ok(value) = env::var("XDG_CACHE_HOME")
        && !value.trim().is_empty()
    {
        return PathBuf::from(value).join("oliphaunt/release-assets/liboliphaunt");
    }
    if let Ok(value) = env::var("HOME")
        && !value.trim().is_empty()
    {
        return PathBuf::from(value).join(".cache/oliphaunt/release-assets/liboliphaunt");
    }
    env::temp_dir().join("oliphaunt/release-assets/liboliphaunt")
}

fn default_broker_release_asset_cache_dir() -> PathBuf {
    if let Ok(value) = env::var("XDG_CACHE_HOME")
        && !value.trim().is_empty()
    {
        return PathBuf::from(value).join("oliphaunt/release-assets/oliphaunt-broker");
    }
    if let Ok(value) = env::var("HOME")
        && !value.trim().is_empty()
    {
        return PathBuf::from(value).join(".cache/oliphaunt/release-assets/oliphaunt-broker");
    }
    env::temp_dir().join("oliphaunt/release-assets/oliphaunt-broker")
}

fn default_release_asset_target() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("linux", "x86_64") => "linux-x64-gnu",
        ("linux", "aarch64") => "linux-arm64-gnu",
        ("windows", "x86_64") => "windows-x64-msvc",
        ("ios", _) => "ios-xcframework",
        ("android", "aarch64") => "android-arm64-v8a",
        ("android", "x86_64") => "android-x86_64",
        _ => "runtime-resources",
    }
}

fn default_broker_release_asset_target() -> String {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("linux", "x86_64") => "linux-x64-gnu",
        ("linux", "aarch64") => "linux-arm64-gnu",
        ("windows", "x86_64") => "windows-x64-msvc",
        _ => "unsupported",
    }
    .to_owned()
}

fn release_asset_names_for_target(version: &str, target: &str) -> oliphaunt::Result<Vec<String>> {
    let mut assets = vec![format!("liboliphaunt-{version}-runtime-resources.tar.gz")];
    match target {
        "runtime-resources" | "runtime-only" => {}
        "macos-arm64" => {
            assets.push(format!("liboliphaunt-{version}-macos-arm64.tar.gz"));
            assets.push(format!("oliphaunt-tools-{version}-macos-arm64.tar.gz"));
        }
        "linux-x64-gnu" => {
            assets.push(format!("liboliphaunt-{version}-linux-x64-gnu.tar.gz"));
            assets.push(format!("oliphaunt-tools-{version}-linux-x64-gnu.tar.gz"));
        }
        "linux-arm64-gnu" => {
            assets.push(format!("liboliphaunt-{version}-linux-arm64-gnu.tar.gz"));
            assets.push(format!("oliphaunt-tools-{version}-linux-arm64-gnu.tar.gz"));
        }
        "windows-x64-msvc" => {
            assets.push(format!("liboliphaunt-{version}-windows-x64-msvc.zip"));
            assets.push(format!("oliphaunt-tools-{version}-windows-x64-msvc.zip"));
        }
        "ios-xcframework" | "ios" => {
            assets.push(format!("liboliphaunt-{version}-ios-xcframework.tar.gz"));
        }
        "android-arm64-v8a" | "arm64-v8a" => {
            assets.push(format!("liboliphaunt-{version}-android-arm64-v8a.tar.gz"));
        }
        "android-x86_64" | "x86_64" => {
            assets.push(format!("liboliphaunt-{version}-android-x86_64.tar.gz"));
        }
        value => {
            return Err(oliphaunt::Error::InvalidConfig(format!(
                "unsupported liboliphaunt release asset target '{value}'"
            )));
        }
    }
    Ok(assets)
}

fn broker_release_asset_name_for_target(version: &str, target: &str) -> oliphaunt::Result<String> {
    match target {
        "macos-arm64" => Ok(format!("oliphaunt-broker-{version}-macos-arm64.tar.gz")),
        "linux-x64-gnu" => Ok(format!("oliphaunt-broker-{version}-linux-x64-gnu.tar.gz")),
        "linux-arm64-gnu" => Ok(format!("oliphaunt-broker-{version}-linux-arm64-gnu.tar.gz")),
        "windows-x64-msvc" => Ok(format!("oliphaunt-broker-{version}-windows-x64-msvc.zip")),
        value => Err(oliphaunt::Error::InvalidConfig(format!(
            "unsupported oliphaunt-broker release asset target '{value}'"
        ))),
    }
}

fn download_release_asset(
    base_url: &str,
    asset: &str,
    cache_dir: &Path,
    product_label: &str,
) -> oliphaunt::Result<PathBuf> {
    if asset.contains('/') || asset.contains('\\') || asset == "." || asset == ".." {
        return Err(oliphaunt::Error::InvalidConfig(format!(
            "release asset name must be a plain file name: {asset}"
        )));
    }
    let output = cache_dir.join(asset);
    if output.is_file() {
        return Ok(output);
    }
    let tmp_path = cache_dir.join(format!(".{asset}.{}.tmp", unique_timestamp_suffix()));
    let url = format!("{}/{}", base_url.trim_end_matches('/'), asset);
    let result = download_release_asset_url(&url, &tmp_path);
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    fs::rename(&tmp_path, &output).map_err(|err| {
        oliphaunt::Error::Engine(format!(
            "publish downloaded {product_label} release asset {} to {}: {err}",
            url,
            output.display()
        ))
    })?;
    Ok(output)
}

fn download_release_asset_url(url: &str, output: &Path) -> oliphaunt::Result<()> {
    if let Some(path) = url.strip_prefix("file://") {
        let source = PathBuf::from(path);
        fs::copy(&source, output).map_err(|err| {
            oliphaunt::Error::InvalidConfig(format!(
                "copy release asset URL {} to {}: {err}",
                url,
                output.display()
            ))
        })?;
        return Ok(());
    }
    download_release_asset_https_url(url, output)
}

#[cfg(feature = "extension-download")]
fn download_release_asset_https_url(url: &str, output: &Path) -> oliphaunt::Result<()> {
    let response = ureq::get(url).call().map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "download liboliphaunt release asset URL {url}: {err}"
        ))
    })?;
    let mut reader = response.into_reader();
    let mut file = File::create(output)
        .map_err(|err| oliphaunt::Error::Engine(format!("create {}: {err}", output.display())))?;
    std::io::copy(&mut reader, &mut file).map_err(|err| {
        oliphaunt::Error::Engine(format!(
            "write downloaded liboliphaunt release asset URL {} to {}: {err}",
            url,
            output.display()
        ))
    })?;
    Ok(())
}

#[cfg(not(feature = "extension-download"))]
fn download_release_asset_https_url(url: &str, _output: &Path) -> oliphaunt::Result<()> {
    Err(oliphaunt::Error::InvalidConfig(format!(
        "liboliphaunt release asset URL {url} requires an oliphaunt-resources binary built with the extension-download feature"
    )))
}

fn parse_release_checksum_file(
    path: &Path,
    product_label: &str,
) -> oliphaunt::Result<Vec<(String, String)>> {
    let text = fs::read_to_string(path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "read {product_label} release checksum file {}: {err}",
            path.display()
        ))
    })?;
    let mut checksums = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let digest = parts.next().unwrap_or_default();
        let filename = parts.next().unwrap_or_default();
        if parts.next().is_some() || !filename.starts_with("./") {
            return Err(oliphaunt::Error::InvalidConfig(format!(
                "malformed {product_label} release checksum line {} in {}: {line}",
                index + 1,
                path.display()
            )));
        }
        checksums.push((filename[2..].to_owned(), digest.to_owned()));
    }
    Ok(checksums)
}

fn verify_release_asset_checksum(
    checksums: &[(String, String)],
    asset: &str,
    path: &Path,
    product_label: &str,
) -> oliphaunt::Result<()> {
    let expected = checksums
        .iter()
        .find_map(|(name, digest)| (name == asset).then_some(digest))
        .ok_or_else(|| {
            oliphaunt::Error::InvalidConfig(format!(
                "{product_label} release checksum manifest does not cover {asset}"
            ))
        })?;
    let actual = sha256_file(path)?;
    if expected != &actual {
        return Err(oliphaunt::Error::InvalidConfig(format!(
            "{product_label} release asset checksum mismatch for {asset}: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> oliphaunt::Result<String> {
    let mut file = File::open(path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!("open {}: {err}", path.display()))
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let read = file.read(&mut buffer).map_err(|err| {
            oliphaunt::Error::InvalidConfig(format!("hash {}: {err}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn extract_runtime_resources_archive(
    archive_path: &Path,
    output_dir: &Path,
    replace_existing: bool,
) -> oliphaunt::Result<()> {
    let resource_root = output_dir.join("oliphaunt");
    if resource_root.exists() {
        if !replace_existing {
            return Err(oliphaunt::Error::InvalidConfig(format!(
                "runtime-resource output already exists at {}; pass --force to replace it",
                resource_root.display()
            )));
        }
        fs::remove_dir_all(&resource_root).map_err(|err| {
            oliphaunt::Error::Engine(format!("remove {}: {err}", resource_root.display()))
        })?;
    }
    fs::create_dir_all(output_dir).map_err(|err| {
        oliphaunt::Error::Engine(format!("create {}: {err}", output_dir.display()))
    })?;
    let file = File::open(archive_path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!("open {}: {err}", archive_path.display()))
    })?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(output_dir).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "extract liboliphaunt runtime resources {} into {}: {err}",
            archive_path.display(),
            output_dir.display()
        ))
    })?;
    Ok(())
}

fn extract_broker_release_archive(
    archive_path: &Path,
    output_dir: &Path,
    replace_existing: bool,
) -> oliphaunt::Result<()> {
    prepare_archive_output_dir(output_dir, replace_existing, "oliphaunt-broker")?;
    if archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.gz"))
    {
        extract_tar_gz_archive(archive_path, output_dir, "oliphaunt-broker")?;
    } else if archive_path.extension().and_then(|value| value.to_str()) == Some("zip") {
        extract_zip_archive(archive_path, output_dir, "oliphaunt-broker")?;
    } else {
        return Err(oliphaunt::Error::InvalidConfig(format!(
            "unsupported oliphaunt-broker release archive {}",
            archive_path.display()
        )));
    }
    Ok(())
}

fn prepare_archive_output_dir(
    output_dir: &Path,
    replace_existing: bool,
    product_label: &str,
) -> oliphaunt::Result<()> {
    if output_dir.exists() {
        let has_entries = fs::read_dir(output_dir)
            .map_err(|err| {
                oliphaunt::Error::Engine(format!("read {}: {err}", output_dir.display()))
            })?
            .next()
            .transpose()
            .map_err(|err| {
                oliphaunt::Error::Engine(format!("read {}: {err}", output_dir.display()))
            })?
            .is_some();
        if has_entries {
            if !replace_existing {
                return Err(oliphaunt::Error::InvalidConfig(format!(
                    "{product_label} release output already exists at {}; pass --force to replace it",
                    output_dir.display()
                )));
            }
            fs::remove_dir_all(output_dir).map_err(|err| {
                oliphaunt::Error::Engine(format!("remove {}: {err}", output_dir.display()))
            })?;
        }
    }
    fs::create_dir_all(output_dir)
        .map_err(|err| oliphaunt::Error::Engine(format!("create {}: {err}", output_dir.display())))
}

fn extract_tar_gz_archive(
    archive_path: &Path,
    output_dir: &Path,
    product_label: &str,
) -> oliphaunt::Result<()> {
    let file = File::open(archive_path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!("open {}: {err}", archive_path.display()))
    })?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(output_dir).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "extract {product_label} release archive {} into {}: {err}",
            archive_path.display(),
            output_dir.display()
        ))
    })
}

fn extract_zip_archive(
    archive_path: &Path,
    output_dir: &Path,
    product_label: &str,
) -> oliphaunt::Result<()> {
    let file = File::open(archive_path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!("open {}: {err}", archive_path.display()))
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "open {product_label} release zip archive {}: {err}",
            archive_path.display()
        ))
    })?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| {
            oliphaunt::Error::InvalidConfig(format!(
                "read {product_label} release zip entry {index} from {}: {err}",
                archive_path.display()
            ))
        })?;
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            oliphaunt::Error::InvalidConfig(format!(
                "{product_label} release zip entry {} is not safely relative",
                entry.name()
            ))
        })?;
        let output_path = output_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|err| {
                oliphaunt::Error::Engine(format!("create {}: {err}", output_path.display()))
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                oliphaunt::Error::Engine(format!("create {}: {err}", parent.display()))
            })?;
        }
        let mut output = File::create(&output_path).map_err(|err| {
            oliphaunt::Error::Engine(format!("create {}: {err}", output_path.display()))
        })?;
        std::io::copy(&mut entry, &mut output).map_err(|err| {
            oliphaunt::Error::Engine(format!("extract {}: {err}", output_path.display()))
        })?;
    }
    Ok(())
}

fn unique_timestamp_suffix() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

fn print_extension_catalog(args: &PackageArgs) -> oliphaunt::Result<()> {
    println!(
        "sql_name\tpg_major\tcreates_extension\tnative_module_stem\tdependencies\tshared_preload\tdesktop_prebuilt\tmobile_prebuilt\tmobile_static_registry_required\tmobile_static_archive_targets\tdata_files\tartifact"
    );
    for entry in oliphaunt::NATIVE_EXTENSION_MANIFEST
        .iter()
        .filter(|entry| entry.first_party_artifact())
    {
        let module_stem = match entry.module {
            ExtensionModuleAsset::SqlOnly => "-",
            ExtensionModuleAsset::NativeModule { stem } => stem,
        };
        let dependencies = entry
            .dependencies
            .iter()
            .map(|extension| extension.sql_name())
            .collect::<Vec<_>>()
            .join(",");
        let shared_preload = entry
            .extension
            .required_shared_preload_library()
            .unwrap_or("-");
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t-\t{}\t{}",
            entry.sql_name,
            entry.pg_major,
            yes_no(entry.creates_extension),
            module_stem,
            empty_as_dash(&dependencies),
            shared_preload,
            yes_no(entry.extension.desktop_release_ready()),
            yes_no(entry.extension.mobile_release_ready()),
            yes_no(entry.extension.requires_mobile_static_registry()),
            empty_as_dash(&entry.data_files.join(",")),
            artifact_label(entry.artifact_policy),
        );
    }
    if !args.extension_indexes.is_empty() {
        let catalog = list_prebuilt_extension_artifact_index_catalog(
            NativeExtensionArtifactIndexOptions::new(
                args.extension_target
                    .clone()
                    .unwrap_or_else(default_extension_artifact_target),
            )
            .indexes(args.extension_indexes.clone())
            .trusted_signing_keys(args.trusted_extension_index_keys.clone())
            .require_signatures(args.require_signed_extension_indexes),
        )?;
        for entry in catalog.extensions {
            println!(
                "{}\t18\t{}\t{}\t{}\t{}\tyes\t{}\t{}\t{}\t-\texternal-index:{}",
                entry.sql_name,
                yes_no(entry.creates_extension),
                empty_as_dash(entry.native_module_stem.as_deref().unwrap_or("-")),
                empty_as_dash(&entry.dependencies.join(",")),
                empty_as_dash(&entry.shared_preload_libraries.join(",")),
                yes_no(entry.mobile_prebuilt),
                yes_no(entry.native_module_stem.is_some()),
                empty_as_dash(&entry.mobile_static_archive_targets.join(",")),
                entry.target,
            );
        }
    }
    Ok(())
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn empty_as_dash(value: &str) -> &str {
    if value.is_empty() { "-" } else { value }
}

fn artifact_label(policy: ExtensionArtifactPolicy) -> &'static str {
    match policy {
        ExtensionArtifactPolicy::FirstParty => "first-party",
        ExtensionArtifactPolicy::External { .. } => "external",
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> oliphaunt::Result<String> {
    args.next()
        .ok_or_else(|| oliphaunt::Error::InvalidConfig(format!("{flag} requires a value")))
}

fn value_without_prefix<'a>(value: &'a str, prefix: &str) -> &'a str {
    value.strip_prefix(prefix).expect("prefix was checked")
}

fn parse_key_value(value: &str) -> oliphaunt::Result<(String, String)> {
    let Some((key_id, hex)) = value.split_once(':') else {
        return Err(oliphaunt::Error::InvalidConfig(
            "key values must use <key-id>:<hex-key>".to_owned(),
        ));
    };
    Ok((key_id.to_owned(), hex.trim().to_owned()))
}

fn read_key_file_value(value: &str) -> oliphaunt::Result<(String, String)> {
    let Some((key_id, path)) = value.split_once(':') else {
        return Err(oliphaunt::Error::InvalidConfig(
            "key file values must use <key-id>:<path>".to_owned(),
        ));
    };
    let text = fs::read_to_string(path).map_err(|err| {
        oliphaunt::Error::InvalidConfig(format!(
            "read trusted extension index key file {path}: {err}"
        ))
    })?;
    Ok((key_id.to_owned(), text.trim().to_owned()))
}

fn parse_mode(value: &str) -> oliphaunt::Result<EngineMode> {
    match value {
        "native-direct" | "direct" => Ok(EngineMode::NativeDirect),
        "native-broker" | "broker" => Ok(EngineMode::NativeBroker),
        "native-server" | "server" => Ok(EngineMode::NativeServer),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown native runtime-resource mode '{value}'"
        ))),
    }
}

fn push_extension_names(target: &mut Vec<String>, value: &str) {
    for extension in split_csv(value) {
        target.push(extension.to_owned());
    }
}

fn push_runtime_feature_names(
    target: &mut Vec<NativeRuntimeFeature>,
    value: &str,
) -> oliphaunt::Result<()> {
    for feature in split_csv(value) {
        target.push(parse_runtime_feature(feature)?);
    }
    Ok(())
}

fn parse_runtime_feature(value: &str) -> oliphaunt::Result<NativeRuntimeFeature> {
    match value {
        "icu" => Ok(NativeRuntimeFeature::Icu),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown native runtime feature '{value}'; supported values: icu"
        ))),
    }
}

fn push_mobile_static_module_stems(target: &mut Vec<String>, value: &str) {
    for stem in split_csv(value) {
        target.push(stem.to_owned());
    }
}

fn split_csv(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn default_extension_artifact_target() -> String {
    if let Ok(target) = env::var("OLIPHAUNT_EXTENSION_TARGET")
        && !target.trim().is_empty()
    {
        return target;
    }
    match (env::consts::ARCH, env::consts::OS) {
        ("aarch64", "macos") => "macos-arm64",
        ("x86_64", "macos") => "macos-x64",
        ("aarch64", "linux") => "linux-arm64-gnu",
        ("x86_64", "linux") => "linux-x64-gnu",
        ("x86_64", "windows") => "windows-x64-msvc",
        _ => "host",
    }
    .to_owned()
}

fn print_help() {
    println!(
        "\
Build portable Oliphaunt runtime resources from the Rust SDK for Swift, Kotlin, and React Native.

Usage:
  oliphaunt-resources --output <dir> [--mode direct|broker|server] [--runtime-feature icu] [--extension hstore,vector] [--extension-index <index.toml>] [--extension-target <target>] [--extension-cache <dir>] [--trusted-extension-index-key-file <key-id>:<path>] [--prebuilt-extension <artifact>] [--mobile-static-module vector] [--force] [--require-mobile-static-registry]
  oliphaunt-resources --resolve-release-assets --liboliphaunt-native-version <version> [--output <dir>] [--release-target macos-arm64|linux-x64-gnu|linux-arm64-gnu|windows-x64-msvc|ios-xcframework|android-arm64-v8a|android-x86_64|runtime-resources] [--release-asset-cache <dir>] [--release-asset-base-url <url>] [--force]
  oliphaunt-resources --resolve-broker-release-assets --broker-version <version> [--output <dir>] [--broker-release-target macos-arm64|linux-x64-gnu|linux-arm64-gnu|windows-x64-msvc] [--broker-release-asset-cache <dir>] [--broker-release-asset-base-url <url>] [--force]
  oliphaunt-resources --list-extensions [--extension-index <index.toml>] [--extension-target <target>] [--trusted-extension-index-key-file <key-id>:<path>]

The output directory receives:
  oliphaunt/runtime/manifest.properties
  oliphaunt/runtime/files/...
  oliphaunt/template-pgdata/manifest.properties
  oliphaunt/template-pgdata/files/...
  oliphaunt/static-registry/manifest.properties
  oliphaunt/static-registry/oliphaunt_static_registry.c when mobile-ready
  oliphaunt/package-size.tsv

Use --require-mobile-static-registry for iOS/Android release resources. It
fails when selected native-module extensions still need static registry rows.
Pass --mobile-static-module <module-stem> only from platform packaging that has
actually linked that module for static loading. Mobile-ready packages emit a
C registry source that platform builds compile and call before oliphaunt_init.
Extensions are selected by exact PostgreSQL SQL name. App bundles receive only
the selected extension files plus mandatory extension dependencies.
Runtime features are selected separately from SQL extensions. Use
--runtime-feature icu to include ICU collation/locale data from the installed
oliphaunt-icu package or OLIPHAUNT_ICU_DATA_DIR.
Use --prebuilt-extension <artifact> for exact third-party extensions that were
built outside the app project. The artifact can be an unpacked directory, .tar,
or .tar.zst. It must contain manifest.properties with
packageLayout=oliphaunt-extension-artifact-v1 and a files/ runtime tree; the app
build consumes binary artifacts only.
Use --extension-index <index.toml> to resolve external --extension names through
a local oliphaunt-extension-artifact-index-v1 file. The command verifies
artifact byte counts and sha256 digests before consuming each artifact. The
target defaults to OLIPHAUNT_EXTENSION_TARGET or the current host target; pass
--extension-target for iOS, Android, or cross-compiled artifact indexes.
If an index row has a URL and the sidecar artifact file is missing, pass
--extension-cache <dir> to download the artifact into a deterministic cache
location before byte-count, sha256, and manifest verification. HTTPS downloads
require an oliphaunt-resources binary built with the extension-download feature.
For release consumption, pass --trusted-extension-index-key-file <key-id>:<path>
to require and verify an Ed25519 detached signature sidecar at <index>.sig
before any indexed artifact is used. The key file must contain a hex-encoded
32-byte Ed25519 public key. For local automation only,
--trusted-extension-index-key <key-id>:<hex-key> is also accepted.
package-size.tsv records the runtime/template/static-registry byte footprint,
the de-duplicated selected extension asset bytes, and each selected extension's
asset bytes.

Use --list-extensions to print the release-ready exact extension catalog
without requiring a local PostgreSQL build. When --extension-index is also
provided, signed external index metadata is listed for --extension-target
without downloading artifacts or building extension source. desktop_prebuilt=yes
means the extension is available to Rust/Tauri and desktop SDK resource
artifacts. mobile_prebuilt=yes means iOS/Android app bundles can include it from
Oliphaunt prebuilt mobile artifacts without compiling extension source; the
mobile_static_archive_targets column lists carried static archive targets for
external native-module artifacts. data_files lists extra files relative to
share/postgresql that are shipped only when the exact extension is selected.

Use --resolve-release-assets for app-developer installs from a published
liboliphaunt-native-v<version> GitHub release. The resolver downloads
liboliphaunt-<version>-release-assets.sha256, verifies each selected asset
against it, caches the exact artifacts, and unpacks
liboliphaunt-<version>-runtime-resources.tar.gz into --output when provided.
The default base URL is
https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v<version>.
HTTPS downloads require the extension-download feature; file:// release asset
URLs are supported for clean local release verification without network access.
Use --resolve-broker-release-assets for broker-mode Rust installs from a
published oliphaunt-broker-v<version> GitHub release. The resolver downloads
and verifies oliphaunt-broker-<version>-release-assets.sha256, selects the
current or requested desktop helper target, and unpacks it into --output. Point
OLIPHAUNT_BROKER_ASSET_DIR at that output directory when using NativeBroker
without placing oliphaunt-broker next to the application executable.
"
    );
}
