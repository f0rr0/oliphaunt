use std::env;
use std::path::PathBuf;
use std::process;

use oliphaunt::{
    NativeExtensionArtifactFormat, NativeExtensionArtifactLegalContract,
    NativeExtensionArtifactLicenseProfile, NativeExtensionArtifactOptions,
    NativeExtensionMobileStaticArchive, NativeExtensionMobileStaticDependencyArchive,
    NativeExtensionStaticSymbolAlias, create_prebuilt_extension_artifact,
};

fn main() {
    match run() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("oliphaunt-extension-artifact: {error}");
            process::exit(2);
        }
    }
}

fn run() -> oliphaunt::Result<()> {
    let args = ArtifactArgs::parse(env::args().skip(1))?;
    if args.help {
        print_help();
        return Ok(());
    }
    let output = args.output.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --output <path>".to_owned())
    })?;
    let runtime = args.runtime.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --runtime <directory>".to_owned())
    })?;
    let sql_name = args.sql_name.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --sql-name <extension>".to_owned())
    })?;
    let native_runtime_version = args.native_runtime_version.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "missing required --native-runtime-version <X.Y.Z> (or OLIPHAUNT_LIBOLIPHAUNT_VERSION)"
                .to_owned(),
        )
    })?;
    let license_profile = args.license_profile.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --license-profile <profile>".to_owned())
    })?;
    let legal_files_root = args.legal_files_root.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "missing required --legal-files-root <directory>".to_owned(),
        )
    })?;
    let legal_contract =
        NativeExtensionArtifactLegalContract::new(license_profile, legal_files_root)
            .license_files(args.license_files);

    let mut options =
        NativeExtensionArtifactOptions::new(output, runtime, sql_name, native_runtime_version)
            .creates_extension(args.creates_extension)
            .format(args.format)
            .replace_existing(args.force)
            .dependencies(args.dependencies)
            .data_files(args.data_files)
            .extension_sql_file_names(args.extension_sql_file_names)
            .extension_sql_file_prefixes(args.extension_sql_file_prefixes)
            .shared_preload_libraries(args.shared_preload_libraries)
            .mobile_prebuilt(args.mobile_prebuilt)
            .mobile_static_archives(args.mobile_static_archives)
            .mobile_static_dependency_archives(args.mobile_static_dependency_archives)
            .static_symbol_aliases(args.static_symbol_aliases)
            .legal_contract(legal_contract);
    if let Some(stem) = args.native_module_stem {
        options = options.native_module_stem(stem);
    }
    if let Some(file) = args.native_module_file {
        options = options.native_module_file(file);
    }
    if let Some(target) = args.native_target {
        options = options.native_target(target);
    }
    if let Some(root) = args.embedded_module_root {
        options = options.embedded_module_root(root);
    }
    if let Some(prefix) = args.static_symbol_prefix {
        options = options.static_symbol_prefix(prefix);
    }

    let artifact = create_prebuilt_extension_artifact(options)?;
    println!("path={}", artifact.path.display());
    println!("sqlName={}", artifact.sql_name);
    println!("format={}", artifact_format_label(artifact.format));
    println!(
        "manifest={}",
        artifact
            .manifest_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    );
    Ok(())
}

struct ArtifactArgs {
    output: Option<PathBuf>,
    runtime: Option<PathBuf>,
    sql_name: Option<String>,
    native_runtime_version: Option<String>,
    license_profile: Option<NativeExtensionArtifactLicenseProfile>,
    legal_files_root: Option<PathBuf>,
    license_files: Vec<PathBuf>,
    creates_extension: bool,
    native_module_stem: Option<String>,
    native_module_file: Option<String>,
    native_target: Option<String>,
    embedded_module_root: Option<PathBuf>,
    dependencies: Vec<String>,
    data_files: Vec<PathBuf>,
    extension_sql_file_names: Vec<String>,
    extension_sql_file_prefixes: Vec<String>,
    shared_preload_libraries: Vec<String>,
    mobile_prebuilt: bool,
    mobile_static_archives: Vec<NativeExtensionMobileStaticArchive>,
    mobile_static_dependency_archives: Vec<NativeExtensionMobileStaticDependencyArchive>,
    static_symbol_prefix: Option<String>,
    static_symbol_aliases: Vec<NativeExtensionStaticSymbolAlias>,
    format: NativeExtensionArtifactFormat,
    force: bool,
    help: bool,
}

impl ArtifactArgs {
    fn parse(args: impl IntoIterator<Item = String>) -> oliphaunt::Result<Self> {
        let mut parsed = Self {
            output: None,
            runtime: None,
            sql_name: None,
            native_runtime_version: env::var("OLIPHAUNT_LIBOLIPHAUNT_VERSION")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            license_profile: None,
            legal_files_root: None,
            license_files: Vec::new(),
            creates_extension: true,
            native_module_stem: None,
            native_module_file: None,
            native_target: None,
            embedded_module_root: None,
            dependencies: Vec::new(),
            data_files: Vec::new(),
            extension_sql_file_names: Vec::new(),
            extension_sql_file_prefixes: Vec::new(),
            shared_preload_libraries: Vec::new(),
            mobile_prebuilt: false,
            mobile_static_archives: Vec::new(),
            mobile_static_dependency_archives: Vec::new(),
            static_symbol_prefix: None,
            static_symbol_aliases: Vec::new(),
            format: NativeExtensionArtifactFormat::Directory,
            force: false,
            help: false,
        };

        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-h" | "--help" => parsed.help = true,
                "--force" => parsed.force = true,
                "--no-create-extension" => parsed.creates_extension = false,
                "--mobile-prebuilt" => parsed.mobile_prebuilt = true,
                "--no-mobile-prebuilt" => parsed.mobile_prebuilt = false,
                "--output" | "-o" => {
                    parsed.output = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--runtime" => {
                    parsed.runtime = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--sql-name" => {
                    parsed.sql_name = Some(next_value(&mut args, &arg)?);
                }
                "--native-runtime-version" | "--liboliphaunt-native-version" => {
                    parsed.native_runtime_version = Some(next_value(&mut args, &arg)?);
                }
                "--license-profile" => {
                    parsed.license_profile = Some(NativeExtensionArtifactLicenseProfile::parse(
                        &next_value(&mut args, &arg)?,
                    )?);
                }
                "--legal-files-root" => {
                    parsed.legal_files_root = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--license-file" | "--license-files" => {
                    push_paths(&mut parsed.license_files, &next_value(&mut args, &arg)?);
                }
                "--format" => {
                    parsed.format = parse_format(&next_value(&mut args, &arg)?)?;
                }
                "--creates-extension" => {
                    parsed.creates_extension = parse_bool(&next_value(&mut args, &arg)?)?;
                }
                "--native-module-stem" => {
                    parsed.native_module_stem = Some(next_value(&mut args, &arg)?);
                }
                "--native-module-file" => {
                    parsed.native_module_file = Some(next_value(&mut args, &arg)?);
                }
                "--native-target" | "--target" => {
                    parsed.native_target = Some(next_value(&mut args, &arg)?);
                }
                "--embedded-module-root" => {
                    parsed.embedded_module_root = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--dependency" | "--dependencies" => {
                    push_strings(&mut parsed.dependencies, &next_value(&mut args, &arg)?);
                }
                "--data-file" | "--data-files" => {
                    push_paths(&mut parsed.data_files, &next_value(&mut args, &arg)?);
                }
                "--extension-sql-file-name" | "--extension-sql-file-names" => {
                    push_strings(
                        &mut parsed.extension_sql_file_names,
                        &next_value(&mut args, &arg)?,
                    );
                }
                "--extension-sql-file-prefix" | "--extension-sql-file-prefixes" => {
                    push_strings(
                        &mut parsed.extension_sql_file_prefixes,
                        &next_value(&mut args, &arg)?,
                    );
                }
                "--shared-preload-library" | "--shared-preload-libraries" => {
                    push_strings(
                        &mut parsed.shared_preload_libraries,
                        &next_value(&mut args, &arg)?,
                    );
                }
                "--mobile-static-archive" | "--mobile-static-archives" => {
                    push_mobile_static_archives(
                        &mut parsed.mobile_static_archives,
                        &next_value(&mut args, &arg)?,
                    )?;
                }
                "--mobile-static-dependency-archive" | "--mobile-static-dependency-archives" => {
                    push_mobile_static_dependency_archives(
                        &mut parsed.mobile_static_dependency_archives,
                        &next_value(&mut args, &arg)?,
                    )?;
                }
                "--static-symbol-prefix" => {
                    parsed.static_symbol_prefix = Some(next_value(&mut args, &arg)?);
                }
                "--static-symbol-alias" | "--static-symbol-aliases" => {
                    push_static_symbol_aliases(
                        &mut parsed.static_symbol_aliases,
                        &next_value(&mut args, &arg)?,
                    )?;
                }
                value if value.starts_with("--output=") => {
                    parsed.output = Some(PathBuf::from(value_without_prefix(value, "--output=")));
                }
                value if value.starts_with("--runtime=") => {
                    parsed.runtime = Some(PathBuf::from(value_without_prefix(value, "--runtime=")));
                }
                value if value.starts_with("--sql-name=") => {
                    parsed.sql_name = Some(value_without_prefix(value, "--sql-name=").to_owned());
                }
                value if value.starts_with("--native-runtime-version=") => {
                    parsed.native_runtime_version =
                        Some(value_without_prefix(value, "--native-runtime-version=").to_owned());
                }
                value if value.starts_with("--liboliphaunt-native-version=") => {
                    parsed.native_runtime_version = Some(
                        value_without_prefix(value, "--liboliphaunt-native-version=").to_owned(),
                    );
                }
                value if value.starts_with("--license-profile=") => {
                    parsed.license_profile = Some(NativeExtensionArtifactLicenseProfile::parse(
                        value_without_prefix(value, "--license-profile="),
                    )?);
                }
                value if value.starts_with("--legal-files-root=") => {
                    parsed.legal_files_root = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--legal-files-root=",
                    )));
                }
                value if value.starts_with("--license-file=") => {
                    push_paths(
                        &mut parsed.license_files,
                        value_without_prefix(value, "--license-file="),
                    );
                }
                value if value.starts_with("--license-files=") => {
                    push_paths(
                        &mut parsed.license_files,
                        value_without_prefix(value, "--license-files="),
                    );
                }
                value if value.starts_with("--format=") => {
                    parsed.format = parse_format(value_without_prefix(value, "--format="))?;
                }
                value if value.starts_with("--creates-extension=") => {
                    parsed.creates_extension =
                        parse_bool(value_without_prefix(value, "--creates-extension="))?;
                }
                value if value.starts_with("--native-module-stem=") => {
                    parsed.native_module_stem =
                        Some(value_without_prefix(value, "--native-module-stem=").to_owned());
                }
                value if value.starts_with("--native-module-file=") => {
                    parsed.native_module_file =
                        Some(value_without_prefix(value, "--native-module-file=").to_owned());
                }
                value if value.starts_with("--native-target=") => {
                    parsed.native_target =
                        Some(value_without_prefix(value, "--native-target=").to_owned());
                }
                value if value.starts_with("--target=") => {
                    parsed.native_target =
                        Some(value_without_prefix(value, "--target=").to_owned());
                }
                value if value.starts_with("--embedded-module-root=") => {
                    parsed.embedded_module_root = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--embedded-module-root=",
                    )));
                }
                value if value.starts_with("--dependency=") => {
                    push_strings(
                        &mut parsed.dependencies,
                        value_without_prefix(value, "--dependency="),
                    );
                }
                value if value.starts_with("--dependencies=") => {
                    push_strings(
                        &mut parsed.dependencies,
                        value_without_prefix(value, "--dependencies="),
                    );
                }
                value if value.starts_with("--data-file=") => {
                    push_paths(
                        &mut parsed.data_files,
                        value_without_prefix(value, "--data-file="),
                    );
                }
                value if value.starts_with("--data-files=") => {
                    push_paths(
                        &mut parsed.data_files,
                        value_without_prefix(value, "--data-files="),
                    );
                }
                value if value.starts_with("--extension-sql-file-name=") => {
                    push_strings(
                        &mut parsed.extension_sql_file_names,
                        value_without_prefix(value, "--extension-sql-file-name="),
                    );
                }
                value if value.starts_with("--extension-sql-file-names=") => {
                    push_strings(
                        &mut parsed.extension_sql_file_names,
                        value_without_prefix(value, "--extension-sql-file-names="),
                    );
                }
                value if value.starts_with("--extension-sql-file-prefix=") => {
                    push_strings(
                        &mut parsed.extension_sql_file_prefixes,
                        value_without_prefix(value, "--extension-sql-file-prefix="),
                    );
                }
                value if value.starts_with("--extension-sql-file-prefixes=") => {
                    push_strings(
                        &mut parsed.extension_sql_file_prefixes,
                        value_without_prefix(value, "--extension-sql-file-prefixes="),
                    );
                }
                value if value.starts_with("--shared-preload-library=") => {
                    push_strings(
                        &mut parsed.shared_preload_libraries,
                        value_without_prefix(value, "--shared-preload-library="),
                    );
                }
                value if value.starts_with("--shared-preload-libraries=") => {
                    push_strings(
                        &mut parsed.shared_preload_libraries,
                        value_without_prefix(value, "--shared-preload-libraries="),
                    );
                }
                value if value.starts_with("--mobile-prebuilt=") => {
                    parsed.mobile_prebuilt =
                        parse_bool(value_without_prefix(value, "--mobile-prebuilt="))?;
                }
                value if value.starts_with("--mobile-static-archive=") => {
                    push_mobile_static_archives(
                        &mut parsed.mobile_static_archives,
                        value_without_prefix(value, "--mobile-static-archive="),
                    )?;
                }
                value if value.starts_with("--mobile-static-archives=") => {
                    push_mobile_static_archives(
                        &mut parsed.mobile_static_archives,
                        value_without_prefix(value, "--mobile-static-archives="),
                    )?;
                }
                value if value.starts_with("--mobile-static-dependency-archive=") => {
                    push_mobile_static_dependency_archives(
                        &mut parsed.mobile_static_dependency_archives,
                        value_without_prefix(value, "--mobile-static-dependency-archive="),
                    )?;
                }
                value if value.starts_with("--mobile-static-dependency-archives=") => {
                    push_mobile_static_dependency_archives(
                        &mut parsed.mobile_static_dependency_archives,
                        value_without_prefix(value, "--mobile-static-dependency-archives="),
                    )?;
                }
                value if value.starts_with("--static-symbol-prefix=") => {
                    parsed.static_symbol_prefix =
                        Some(value_without_prefix(value, "--static-symbol-prefix=").to_owned());
                }
                value if value.starts_with("--static-symbol-alias=") => {
                    push_static_symbol_aliases(
                        &mut parsed.static_symbol_aliases,
                        value_without_prefix(value, "--static-symbol-alias="),
                    )?;
                }
                value if value.starts_with("--static-symbol-aliases=") => {
                    push_static_symbol_aliases(
                        &mut parsed.static_symbol_aliases,
                        value_without_prefix(value, "--static-symbol-aliases="),
                    )?;
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

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> oliphaunt::Result<String> {
    args.next()
        .ok_or_else(|| oliphaunt::Error::InvalidConfig(format!("{flag} requires a value")))
}

fn value_without_prefix<'a>(value: &'a str, prefix: &str) -> &'a str {
    value.strip_prefix(prefix).expect("prefix was checked")
}

fn parse_format(value: &str) -> oliphaunt::Result<NativeExtensionArtifactFormat> {
    match value {
        "directory" | "dir" => Ok(NativeExtensionArtifactFormat::Directory),
        "tar" => Ok(NativeExtensionArtifactFormat::Tar),
        "tar-gz" | "tar.gz" | "tgz" | "gz" => Ok(NativeExtensionArtifactFormat::TarGz),
        "tar-zst" | "tar.zst" | "zst" => Ok(NativeExtensionArtifactFormat::TarZst),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown extension artifact format '{value}'"
        ))),
    }
}

fn parse_bool(value: &str) -> oliphaunt::Result<bool> {
    match value {
        "true" | "yes" | "1" => Ok(true),
        "false" | "no" | "0" => Ok(false),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "expected true/false, got '{value}'"
        ))),
    }
}

fn push_strings(target: &mut Vec<String>, value: &str) {
    for item in split_csv(value) {
        target.push(item.to_owned());
    }
}

fn push_paths(target: &mut Vec<PathBuf>, value: &str) {
    for item in split_csv(value) {
        target.push(PathBuf::from(item));
    }
}

fn push_mobile_static_archives(
    target: &mut Vec<NativeExtensionMobileStaticArchive>,
    value: &str,
) -> oliphaunt::Result<()> {
    for item in split_csv(value) {
        target.push(parse_mobile_static_archive(item)?);
    }
    Ok(())
}

fn parse_mobile_static_archive(
    value: &str,
) -> oliphaunt::Result<NativeExtensionMobileStaticArchive> {
    let separator = value.find('=').or_else(|| value.find(':')).ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "--mobile-static-archive values must use <target>:<archive> or <target>=<archive>"
                .to_owned(),
        )
    })?;
    let (target, archive) = value.split_at(separator);
    let archive = &archive[1..];
    if target.trim().is_empty() || archive.trim().is_empty() {
        return Err(oliphaunt::Error::InvalidConfig(
            "--mobile-static-archive values must include both target and archive path".to_owned(),
        ));
    }
    Ok(NativeExtensionMobileStaticArchive::new(
        target.trim(),
        PathBuf::from(archive.trim()),
    ))
}

fn push_mobile_static_dependency_archives(
    target: &mut Vec<NativeExtensionMobileStaticDependencyArchive>,
    value: &str,
) -> oliphaunt::Result<()> {
    for item in split_csv(value) {
        target.push(parse_mobile_static_dependency_archive(item)?);
    }
    Ok(())
}

fn parse_mobile_static_dependency_archive(
    value: &str,
) -> oliphaunt::Result<NativeExtensionMobileStaticDependencyArchive> {
    let (target_and_name, archive) = if let Some(separator) = value.find('=') {
        let (left, right) = value.split_at(separator);
        (left, &right[1..])
    } else {
        let mut parts = value.splitn(3, ':');
        let target = parts.next().unwrap_or_default();
        let name = parts.next().unwrap_or_default();
        let archive = parts.next().unwrap_or_default();
        if target.trim().is_empty() || name.trim().is_empty() || archive.trim().is_empty() {
            return Err(oliphaunt::Error::InvalidConfig(
                "--mobile-static-dependency-archive values must use <target>:<name>:<archive> or <target>:<name>=<archive>".to_owned(),
            ));
        }
        return Ok(NativeExtensionMobileStaticDependencyArchive::new(
            target.trim(),
            name.trim(),
            PathBuf::from(archive.trim()),
        ));
    };
    let Some((target, name)) = target_and_name.split_once(':') else {
        return Err(oliphaunt::Error::InvalidConfig(
            "--mobile-static-dependency-archive values must use <target>:<name>:<archive> or <target>:<name>=<archive>".to_owned(),
        ));
    };
    if target.trim().is_empty() || name.trim().is_empty() || archive.trim().is_empty() {
        return Err(oliphaunt::Error::InvalidConfig(
            "--mobile-static-dependency-archive values must include target, name, and archive path"
                .to_owned(),
        ));
    }
    Ok(NativeExtensionMobileStaticDependencyArchive::new(
        target.trim(),
        name.trim(),
        PathBuf::from(archive.trim()),
    ))
}

fn push_static_symbol_aliases(
    target: &mut Vec<NativeExtensionStaticSymbolAlias>,
    value: &str,
) -> oliphaunt::Result<()> {
    for item in split_csv(value) {
        target.push(parse_static_symbol_alias(item)?);
    }
    Ok(())
}

fn parse_static_symbol_alias(value: &str) -> oliphaunt::Result<NativeExtensionStaticSymbolAlias> {
    let separator = value.find('=').or_else(|| value.find(':')).ok_or_else(|| {
        oliphaunt::Error::InvalidConfig(
            "--static-symbol-alias values must use <sql-symbol>:<linked-symbol> or <sql-symbol>=<linked-symbol>".to_owned(),
        )
    })?;
    let (sql_symbol, linked_symbol) = value.split_at(separator);
    let linked_symbol = &linked_symbol[1..];
    if sql_symbol.trim().is_empty() || linked_symbol.trim().is_empty() {
        return Err(oliphaunt::Error::InvalidConfig(
            "--static-symbol-alias values must include both SQL and linked C symbols".to_owned(),
        ));
    }
    Ok(NativeExtensionStaticSymbolAlias::new(
        sql_symbol.trim(),
        linked_symbol.trim(),
    ))
}

fn split_csv(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn artifact_format_label(format: NativeExtensionArtifactFormat) -> &'static str {
    match format {
        NativeExtensionArtifactFormat::Directory => "directory",
        NativeExtensionArtifactFormat::Tar => "tar",
        NativeExtensionArtifactFormat::TarGz => "tar-gz",
        NativeExtensionArtifactFormat::TarZst => "tar-zst",
    }
}

fn print_help() {
    println!(
        "\
Create one exact prebuilt Oliphaunt extension artifact from already-built PostgreSQL runtime files.

Usage:
  oliphaunt-extension-artifact --runtime <runtime-files-dir> --sql-name <extension> --native-runtime-version <X.Y.Z> --license-profile <profile> --legal-files-root <dir> --output <path> [--format directory|tar|tar-gz|tar-zst] [options]

Options:
  --native-runtime-version <X.Y.Z> Exact stable liboliphaunt-native version
  --license-profile <profile>      contrib-native, contrib-native-openssl,
                                    or external-native
  --legal-files-root <dir>         Exact profile notices and license sources
  --license-file <path[,path]>     External license leaves below share/licenses
  --native-module-stem <stem>       Native module stem used by extension SQL
  --native-module-file <file>       Target-specific file under lib/postgresql
  --target <target>                 Public target id that built the module
  --embedded-module-root <dir>      Native-direct desktop modules directory
  --dependency <name[,name]>        Exact extension dependencies
  --data-file <path[,path]>         Extra files relative to share/postgresql
  --extension-sql-file-name <name>  Exact ancillary extension SQL basename
  --extension-sql-file-prefix <pfx> Exact ancillary extension SQL prefix
  --shared-preload-library <name>   Required shared_preload_libraries entry
  --mobile-static-archive <target>:<archive>
                                    Include a selected prebuilt iOS/Android .a
  --mobile-static-dependency-archive <target>:<name>:<archive>
                                    Include a static dependency archive linked
                                    with selected mobile extension archives
  --mobile-prebuilt[=yes|no]        Require carried mobile static archives
  --static-symbol-prefix <prefix>   C symbol prefix for mobile static artifacts
  --static-symbol-alias <sql>:<linked>
                                    Map a SQL C symbol to a linked archive symbol
  --creates-extension <yes|no>      Whether control/SQL files are required
  --no-create-extension             Alias for --creates-extension no
  --force                           Replace an existing output path

The command copies only files declared by the exact SQL extension name and the
explicit metadata above. It never builds PostgreSQL or extension source in an
app project. The resulting directory, .tar, .tar.gz, or .tar.zst can be passed
to oliphaunt-resources --prebuilt-extension. Passing --mobile-static-archive
marks the artifact mobile-prebuilt and stores the static archive inside the artifact.
Dependency archives are copied alongside selected mobile static archives and
linked by SDK builds when present. Native-module artifacts must declare a
target so consumers cannot install a module built for a different platform.
Every v1 manifest records nativeRuntimeProduct=liboliphaunt-native, the
selected stable nativeRuntimeVersion, and the exact ancillary SQL
names/prefixes copied into the carrier. The manifest also freezes the exact
licenseProfile and sorted licenseFiles inventory; missing, extra, unsafe, or
profile-inconsistent legal leaves are rejected by both producer and consumer.
OLIPHAUNT_LIBOLIPHAUNT_VERSION is the environment equivalent of
--native-runtime-version.
"
    );
}

#[cfg(test)]
mod tests {
    use super::ArtifactArgs;

    #[test]
    fn ancillary_sql_flags_accept_repeated_and_csv_forms() {
        let parsed = ArtifactArgs::parse([
            "--extension-sql-file-name".to_owned(),
            "uninstall_acme.sql".to_owned(),
            "--extension-sql-file-names=acme_aux.sql,acme_data.sql".to_owned(),
            "--extension-sql-file-prefix".to_owned(),
            "acme_aux--".to_owned(),
            "--extension-sql-file-prefixes=acme_data--,acme_geo--".to_owned(),
        ])
        .unwrap();

        assert_eq!(
            parsed.extension_sql_file_names,
            ["uninstall_acme.sql", "acme_aux.sql", "acme_data.sql"]
        );
        assert_eq!(
            parsed.extension_sql_file_prefixes,
            ["acme_aux--", "acme_data--", "acme_geo--"]
        );
    }

    #[test]
    fn embedded_module_root_accepts_separate_and_equals_forms() {
        let separate = ArtifactArgs::parse([
            "--embedded-module-root".to_owned(),
            "/tmp/embedded-modules".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            separate.embedded_module_root,
            Some("/tmp/embedded-modules".into())
        );

        let equals =
            ArtifactArgs::parse(["--embedded-module-root=/tmp/embedded-modules-equals".to_owned()])
                .unwrap();
        assert_eq!(
            equals.embedded_module_root,
            Some("/tmp/embedded-modules-equals".into())
        );
    }
}
