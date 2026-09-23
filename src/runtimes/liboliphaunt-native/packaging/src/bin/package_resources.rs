use std::env;
use std::path::PathBuf;
use std::process;

use liboliphaunt_native_bindings::Extension;
use oliphaunt_native_packaging::{
    Error, MobileStaticRegistryState, NativePrebuiltExtensionArtifact, NativeRuntimeFeature,
    NativeRuntimeResourceOptions, Result, build_native_runtime_resources,
};

fn main() {
    match run() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("oliphaunt-resources: {error}");
            process::exit(2);
        }
    }
}

fn run() -> Result<()> {
    let args = PackageArgs::parse(env::args().skip(1))?;
    run_with_package_args(args)
}

fn run_with_package_args(args: PackageArgs) -> Result<()> {
    if args.help {
        print_help();
        return Ok(());
    }
    let output_dir = args
        .output_dir
        .ok_or_else(|| Error::InvalidConfig("missing required --output <directory>".to_owned()))?;
    let extension_target = args
        .extension_target
        .clone()
        .unwrap_or_else(default_extension_artifact_target);

    let mut options = NativeRuntimeResourceOptions::new(output_dir)
        .runtime_features(args.runtime_features)
        .replace_existing(args.force)
        .require_mobile_static_registry(args.require_mobile_static_registry)
        .mobile_static_module_stems(args.mobile_static_module_stems)
        .extension_target(extension_target);
    if let Some(version) = args.liboliphaunt_version {
        options = options.native_runtime_version(version);
    }
    for name in args.extensions {
        let extension = Extension::by_sql_name(&name).ok_or_else(|| Error::InvalidConfig(format!("unknown built-in extension {name}; supply external artifacts with --prebuilt-extension")))?;
        options = options.extension(extension);
    }
    for artifact in args.prebuilt_extensions {
        options = options.prebuilt_extension(artifact.root);
    }

    let package = build_native_runtime_resources(options)?;
    println!("root={}", package.root.display());
    println!("runtimeFiles={}", package.runtime_files.display());
    println!("runtimeCacheKey={}", package.runtime_cache_key);
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
            MobileStaticRegistryState::NotRequired => "not-required",
            MobileStaticRegistryState::Complete => "complete",
            MobileStaticRegistryState::Pending => "pending",
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
    extensions: Vec<String>,
    runtime_features: Vec<NativeRuntimeFeature>,
    extension_target: Option<String>,
    prebuilt_extensions: Vec<NativePrebuiltExtensionArtifact>,
    mobile_static_module_stems: Vec<String>,
    force: bool,
    require_mobile_static_registry: bool,
    liboliphaunt_version: Option<String>,
    help: bool,
}
impl PackageArgs {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self> {
        Self::parse_with_native_runtime_version(
            args,
            env::var("OLIPHAUNT_LIBOLIPHAUNT_VERSION")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        )
    }
    fn parse_with_native_runtime_version(
        args: impl IntoIterator<Item = String>,
        native_runtime_version: Option<String>,
    ) -> Result<Self> {
        let mut parsed = Self {
            output_dir: None,
            extensions: Vec::new(),
            runtime_features: Vec::new(),
            extension_target: None,
            prebuilt_extensions: Vec::new(),
            mobile_static_module_stems: Vec::new(),
            force: false,
            require_mobile_static_registry: false,
            liboliphaunt_version: native_runtime_version,
            help: false,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let (flag, inline) = arg
                .split_once('=')
                .filter(|(flag, _)| flag.starts_with("--"))
                .map_or((arg.as_str(), None), |(flag, value)| (flag, Some(value)));
            if inline.is_some()
                && matches!(
                    flag,
                    "--help" | "--force" | "--require-mobile-static-registry"
                )
            {
                return Err(Error::InvalidConfig(format!("unknown argument '{arg}'")));
            }
            let mut value = || {
                inline
                    .map(str::to_owned)
                    .map(Ok)
                    .unwrap_or_else(|| next_value(&mut args, &arg))
            };
            match flag {
                "-h" | "--help" => parsed.help = true,
                "--force" => parsed.force = true,
                "--require-mobile-static-registry" => parsed.require_mobile_static_registry = true,
                "--output" | "-o" => parsed.output_dir = Some(PathBuf::from(value()?)),
                "--liboliphaunt-native-version" => parsed.liboliphaunt_version = Some(value()?),
                "--extension" => push_extension_names(&mut parsed.extensions, &value()?),
                "--runtime-feature" | "--runtime-features" => {
                    push_runtime_feature_names(&mut parsed.runtime_features, &value()?)?
                }
                "--extension-target" | "--artifact-target" => {
                    parsed.extension_target = Some(value()?)
                }
                "--prebuilt-extension" | "--prebuilt-extension-artifact" => parsed
                    .prebuilt_extensions
                    .push(NativePrebuiltExtensionArtifact::new(
                        PathBuf::from(value()?),
                    )),
                "--mobile-static-module" | "--mobile-static-registry-module" => {
                    push_mobile_static_module_stems(
                        &mut parsed.mobile_static_module_stems,
                        &value()?,
                    )
                }
                _ => return Err(Error::InvalidConfig(format!("unknown argument '{arg}'"))),
            }
        }
        Ok(parsed)
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next()
        .ok_or_else(|| Error::InvalidConfig(format!("{flag} requires a value")))
}

fn push_extension_names(target: &mut Vec<String>, value: &str) {
    for extension in split_csv(value) {
        target.push(extension.to_owned());
    }
}

fn push_runtime_feature_names(target: &mut Vec<NativeRuntimeFeature>, value: &str) -> Result<()> {
    for feature in split_csv(value) {
        target.push(parse_runtime_feature(feature)?);
    }
    Ok(())
}

fn parse_runtime_feature(value: &str) -> Result<NativeRuntimeFeature> {
    match value {
        "icu" => Ok(NativeRuntimeFeature::Icu),
        _ => Err(Error::InvalidConfig(format!(
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
        "oliphaunt-resources --output <dir> [--runtime-feature icu] [--extension name] [--prebuilt-extension artifact] [--liboliphaunt-native-version version] [--extension-target target] [--mobile-static-module module] [--require-mobile-static-registry] [--force]"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    #[cfg(unix)]
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[test]
    fn value_options_preserve_equals_and_flags_reject_values() {
        for args in [
            vec![
                "--output",
                "resources=with spaces",
                "--extension",
                "hstore,vector",
            ],
            vec![
                "--output=resources=with spaces",
                "--extension=hstore,vector",
            ],
        ] {
            let parsed = PackageArgs::parse_with_native_runtime_version(
                args.into_iter().map(str::to_owned),
                None,
            )
            .unwrap();
            assert_eq!(parsed.output_dir, Some("resources=with spaces".into()));
            assert_eq!(parsed.extensions, ["hstore", "vector"]);
        }
        assert!(PackageArgs::parse(["--force=false".to_owned()]).is_err());
        assert!(PackageArgs::parse(["--output".to_owned()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn direct_prebuilt_cli_packages_matching_native_runtime_version() {
        let _lock = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = test_temp_root("direct-positive-version-binding");
        let install = temp.join("install");
        let artifact = temp.join("acme_ext");
        let output = temp.join("output");
        write_test_native_install(&install);
        write_test_extension_artifact(&artifact, "1.2.3");
        let _env = TestEnvironment::replace([
            ("OLIPHAUNT_INSTALL_DIR", Some(install.as_os_str())),
            (
                "OLIPHAUNT_RUNTIME_CACHE_DIR",
                Some(temp.join("runtime-cache").as_os_str()),
            ),
            ("OLIPHAUNT_RESOURCES_DIR", None),
            ("OLIPHAUNT_POSTGRES", None),
            ("OLIPHAUNT_INITDB", None),
        ]);

        let args = PackageArgs::parse_with_native_runtime_version(
            strings([
                "--output",
                output.to_str().unwrap(),
                "--prebuilt-extension",
                artifact.to_str().unwrap(),
                "--extension-target",
                "test-target",
                "--liboliphaunt-native-version",
                "1.2.3",
            ]),
            None,
        )
        .unwrap();
        run_with_package_args(args).unwrap();

        let manifest =
            fs::read_to_string(output.join("oliphaunt/runtime/manifest.properties")).unwrap();
        assert!(
            manifest
                .lines()
                .any(|line| line == "selectedExtensions=acme_ext"),
            "selected prebuilt extension missing from selectedExtensions domain:\n{manifest}"
        );
        assert!(
            manifest.lines().any(|line| line == "extensions="),
            "non-createable prebuilt extension leaked into createable extensions domain:\n{manifest}"
        );
        assert!(!output.join("oliphaunt/cluster-seed").exists());
        for executable in ["postgres", "pg_ctl"] {
            assert!(
                output
                    .join("oliphaunt/runtime/files/bin")
                    .join(executable)
                    .is_file(),
                "packaged native server runtime is missing {executable}"
            );
        }
        for tool in ["pg_basebackup", "pg_dump", "psql"] {
            assert!(
                !output
                    .join("oliphaunt/runtime/files/bin")
                    .join(tool)
                    .exists(),
                "optional PostgreSQL tool leaked into the core runtime: {tool}"
            );
        }

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn direct_prebuilt_cli_requires_and_binds_selected_native_runtime_version() {
        let temp = test_temp_root("direct-version-binding");
        let artifact = temp.join("acme_ext");
        let output = temp.join("missing-version-output");
        write_test_extension_artifact(&artifact, "1.2.3");

        let args = PackageArgs::parse_with_native_runtime_version(
            strings([
                "--output",
                output.to_str().unwrap(),
                "--prebuilt-extension",
                artifact.to_str().unwrap(),
                "--extension-target",
                "test-target",
            ]),
            None,
        )
        .unwrap();
        let error = run_with_package_args(args).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires an exact stable liboliphaunt-native version"),
            "unexpected missing-version error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let output = temp.join("wrong-version-output");
        let args = PackageArgs::parse_with_native_runtime_version(
            strings([
                "--output",
                output.to_str().unwrap(),
                "--prebuilt-extension",
                artifact.to_str().unwrap(),
                "--extension-target",
                "test-target",
                "--liboliphaunt-native-version",
                "1.2.4",
            ]),
            None,
        )
        .unwrap();
        let error = run_with_package_args(args).unwrap_err();
        assert!(
            error.to_string().contains(
                "requires liboliphaunt-native version '1.2.3', but runtime packaging selected '1.2.4'"
            ),
            "unexpected bound-version error: {error}"
        );
        assert!(!output.exists(), "validation must precede materialization");

        let _ = fs::remove_dir_all(temp);
    }

    fn write_test_extension_artifact(root: &Path, native_runtime_version: &str) {
        fs::create_dir_all(root.join("files/share/licenses/acme_ext")).unwrap();
        fs::write(
            root.join("manifest.properties"),
            format!(
                "packageLayout=oliphaunt-extension-artifact-v1\npgMajor=18\nsqlName=acme_ext\ncreatesExtension=no\nnativeModuleStem=\nnativeModuleFile=\nnativeTarget=\nnativeRuntimeProduct=liboliphaunt-native\nnativeRuntimeVersion={native_runtime_version}\ndependencies=\ndataFiles=\nextensionSqlFileNames=\nextensionSqlFilePrefixes=\nsharedPreloadLibraries=\nmobilePrebuilt=no\nmobileStaticArchives=\nmobileStaticDependencyArchives=\nstaticSymbolPrefix=\nstaticSymbolAliases=\nlicenseFiles=share/licenses/acme_ext/LICENSE\nlicenseProfile=external-native\nfiles=files\n"
            ),
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "fixture license\n").unwrap();
        fs::write(
            root.join("THIRD_PARTY_NOTICES.md"),
            "fixture third-party notices\n",
        )
        .unwrap();
        fs::write(
            root.join("files/share/licenses/acme_ext/LICENSE"),
            "fixture upstream license\n",
        )
        .unwrap();
        #[cfg(unix)]
        for legal in [
            root.join("LICENSE"),
            root.join("THIRD_PARTY_NOTICES.md"),
            root.join("files/share/licenses/acme_ext/LICENSE"),
        ] {
            fs::set_permissions(legal, fs::Permissions::from_mode(0o644)).unwrap();
        }
    }

    #[cfg(unix)]
    fn write_test_native_install(root: &Path) {
        for tool in ["postgres", "pg_ctl", "pg_basebackup", "pg_dump", "psql"] {
            write_test_file(&root.join("bin").join(tool), tool.as_bytes());
        }
        let initdb = root.join("bin/initdb");
        write_test_file(&initdb, b"#!/bin/sh\nexit 99\n");
        fs::set_permissions(&initdb, fs::Permissions::from_mode(0o755)).unwrap();
        write_test_file(
            &root.join("share/postgresql/postgresql.conf.sample"),
            b"# sample\n",
        );
        write_test_file(
            &root.join("share/postgresql/extension/plpgsql.control"),
            b"comment = 'PL/pgSQL'\n",
        );
        write_test_file(
            &root.join("share/postgresql/extension/plpgsql--1.0.sql"),
            b"select 'plpgsql install';\n",
        );
        fs::create_dir_all(root.join("lib/postgresql")).unwrap();
        for module in ["dict_snowball", "plpgsql"] {
            write_test_file(
                &root
                    .parent()
                    .unwrap()
                    .join("out/modules")
                    .join(format!("{module}{}", std::env::consts::DLL_SUFFIX)),
                b"embedded module fixture",
            );
        }
    }

    #[cfg(unix)]
    fn write_test_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[cfg(unix)]
    struct TestEnvironment {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    #[cfg(unix)]
    impl TestEnvironment {
        fn replace<const N: usize>(values: [(&'static str, Option<&std::ffi::OsStr>); N]) -> Self {
            let previous = values
                .iter()
                .map(|(name, _)| (*name, env::var_os(name)))
                .collect();
            for (name, value) in values {
                unsafe {
                    match value {
                        Some(value) => env::set_var(name, value),
                        None => env::remove_var(name),
                    }
                }
            }
            Self { previous }
        }
    }

    #[cfg(unix)]
    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..).rev() {
                unsafe {
                    match value {
                        Some(value) => env::set_var(name, value),
                        None => env::remove_var(name),
                    }
                }
            }
        }
    }

    fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
        values.into_iter().map(str::to_owned).collect()
    }

    fn test_temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        env::temp_dir().join(format!(
            "oliphaunt-package-resources-{label}-{}-{nanos}",
            process::id()
        ))
    }
}
