//! Strict command-line contract for the sealed PostgreSQL executor.

use std::{collections::HashSet, ffi::OsString, path::PathBuf};

use anyhow::{Context, Error, bail, ensure};

/// Parsed top-level product command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Print the executor version without initializing a runtime.
    Version,
    /// Execute one member of an exact sealed PostgreSQL carrier.
    Run(RunOptions),
}

/// One explicit host-to-guest directory mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeSpec {
    /// Host directory, canonicalized immediately before execution.
    pub host: PathBuf,
    /// Absolute normalized Unix-style guest path.
    pub guest: String,
}

/// Complete, closed execution request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOptions {
    /// Suppress executor-owned informational output.
    pub quiet: bool,
    /// Exact sealed carrier manifest.
    pub manifest: PathBuf,
    /// Wasmer host stack allocation requested by the carrier recipe.
    pub stack_size: usize,
    /// Explicit host filesystem mappings.
    pub volumes: Vec<VolumeSpec>,
    /// Selected `bin/initdb` or `bin/postgres` carrier member.
    pub input: PathBuf,
    /// Arguments passed to the selected PostgreSQL executable.
    pub guest_args: Vec<String>,
}

#[derive(Default)]
struct SeenOptions {
    quiet: bool,
    disable_cache: bool,
    manifest: bool,
    stack_size: bool,
    exceptions: bool,
    threads: bool,
    networking: bool,
}

impl SeenOptions {
    fn once(slot: &mut bool, option: &str) -> Result<(), Error> {
        ensure!(!*slot, "duplicate product executor option '{option}'");
        *slot = true;
        Ok(())
    }
}

/// Parse the exact product command from an argv sequence, including argv[0].
pub fn parse_from<I, S>(arguments: I) -> Result<Command, Error>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let arguments = arguments.into_iter().map(Into::into).collect::<Vec<_>>();
    ensure!(!arguments.is_empty(), "product executor argv is empty");
    let tail = &arguments[1..];

    if tail == [OsString::from("--version")] {
        return Ok(Command::Version);
    }
    ensure!(
        tail.first().is_some_and(|value| value == "run"),
        "expected exactly 'run' or '--version'"
    );

    parse_run(&tail[1..]).map(Command::Run)
}

fn parse_run(arguments: &[OsString]) -> Result<RunOptions, Error> {
    let mut seen = SeenOptions::default();
    let mut manifest = None;
    let mut stack_size = None;
    let mut volumes = Vec::new();
    let mut input = None;
    let mut index = 0;

    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--" {
            bail!("guest argument separator '--' appeared before the carrier executable");
        }

        let Some(text) = argument.to_str() else {
            input = Some(PathBuf::from(argument));
            index += 1;
            break;
        };
        if !text.starts_with("--") {
            input = Some(PathBuf::from(argument));
            index += 1;
            break;
        }

        let (name, inline_value) = text
            .split_once('=')
            .map_or((text, None), |(name, value)| (name, Some(value)));
        match name {
            "--quiet" => {
                reject_inline_value(name, inline_value)?;
                SeenOptions::once(&mut seen.quiet, name)?;
            }
            "--disable-cache" => {
                reject_inline_value(name, inline_value)?;
                SeenOptions::once(&mut seen.disable_cache, name)?;
            }
            "--enable-exceptions" => {
                reject_inline_value(name, inline_value)?;
                SeenOptions::once(&mut seen.exceptions, name)?;
            }
            "--enable-threads" => {
                reject_inline_value(name, inline_value)?;
                SeenOptions::once(&mut seen.threads, name)?;
            }
            "--net" => {
                reject_inline_value(name, inline_value)?;
                SeenOptions::once(&mut seen.networking, name)?;
            }
            "--sealed-module-manifest" => {
                SeenOptions::once(&mut seen.manifest, name)?;
                manifest = Some(PathBuf::from(take_os_value(
                    arguments,
                    &mut index,
                    name,
                    inline_value,
                )?));
            }
            "--stack-size" => {
                SeenOptions::once(&mut seen.stack_size, name)?;
                let value = take_utf8_value(arguments, &mut index, name, inline_value)?;
                let parsed = value
                    .parse::<usize>()
                    .with_context(|| format!("invalid value for {name}: '{value}'"))?;
                ensure!(parsed > 0, "{name} must be greater than zero");
                stack_size = Some(parsed);
            }
            "--volume" => {
                let value = take_utf8_value(arguments, &mut index, name, inline_value)?;
                volumes.push(parse_volume(&value)?);
            }
            _ => bail!("unsupported product executor option '{name}'"),
        }
        index += 1;
    }

    let input = input.context("sealed carrier executable is required")?;
    let guest_args = if index == arguments.len() {
        Vec::new()
    } else {
        ensure!(
            arguments[index] == "--",
            "arguments after the carrier executable require the '--' separator"
        );
        arguments[index + 1..]
            .iter()
            .map(|argument| {
                argument
                    .to_str()
                    .map(ToOwned::to_owned)
                    .context("PostgreSQL guest arguments must be valid UTF-8")
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    ensure!(
        seen.disable_cache,
        "--disable-cache is required by the sealed executor contract"
    );
    ensure!(
        seen.exceptions,
        "--enable-exceptions is required by the sealed carrier ABI"
    );
    ensure!(
        seen.threads,
        "--enable-threads is required by the sealed carrier ABI"
    );
    ensure!(
        seen.networking,
        "--net is required by the PostgreSQL postmaster contract"
    );
    ensure!(
        !volumes.is_empty(),
        "at least one explicit --volume is required"
    );

    let manifest = manifest.context("--sealed-module-manifest is required")?;
    let stack_size = stack_size.context("--stack-size is required")?;
    let mut guest_mounts = HashSet::new();
    for volume in &volumes {
        ensure!(
            guest_mounts.insert(volume.guest.as_str()),
            "duplicate guest volume mount '{}'",
            volume.guest
        );
    }

    Ok(RunOptions {
        quiet: seen.quiet,
        manifest,
        stack_size,
        volumes,
        input,
        guest_args,
    })
}

fn reject_inline_value(option: &str, value: Option<&str>) -> Result<(), Error> {
    ensure!(value.is_none(), "flag '{option}' does not accept a value");
    Ok(())
}

fn take_os_value(
    arguments: &[OsString],
    index: &mut usize,
    option: &str,
    inline_value: Option<&str>,
) -> Result<OsString, Error> {
    if let Some(value) = inline_value {
        ensure!(!value.is_empty(), "{option} requires a non-empty value");
        return Ok(OsString::from(value));
    }
    *index = index.checked_add(1).context("argument index overflow")?;
    let value = arguments
        .get(*index)
        .with_context(|| format!("{option} requires a value"))?;
    ensure!(!value.is_empty(), "{option} requires a non-empty value");
    Ok(value.clone())
}

fn take_utf8_value(
    arguments: &[OsString],
    index: &mut usize,
    option: &str,
    inline_value: Option<&str>,
) -> Result<String, Error> {
    let value = take_os_value(arguments, index, option, inline_value)?;
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("{option} requires a valid UTF-8 value"))
}

fn parse_volume(value: &str) -> Result<VolumeSpec, Error> {
    let (host, guest) = value
        .rsplit_once(':')
        .context("--volume requires an explicit HOST_DIR:GUEST_DIR mapping")?;
    ensure!(
        !host.is_empty(),
        "--volume host directory must not be empty"
    );
    validate_guest_path(guest)?;
    Ok(VolumeSpec {
        host: PathBuf::from(host),
        guest: guest.to_owned(),
    })
}

pub(crate) fn validate_guest_path(path: &str) -> Result<(), Error> {
    ensure!(
        path.starts_with('/'),
        "--volume guest path must be absolute"
    );
    ensure!(
        path == "/" || !path.ends_with('/'),
        "--volume guest path must be normalized"
    );
    ensure!(
        !path.contains("//"),
        "--volume guest path must be normalized"
    );
    ensure!(
        path.split('/')
            .all(|component| component != "." && component != ".."),
        "--volume guest path must not contain '.' or '..' components"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_args() -> Vec<OsString> {
        [
            "executor",
            "run",
            "--quiet",
            "--disable-cache",
            "--stack-size",
            "33554432",
            "--sealed-module-manifest",
            "/carrier/manifest.json",
            "--enable-exceptions",
            "--enable-threads",
            "--net",
            "--volume",
            "/carrier:/carrier",
            "--volume=/runtime/lib:/lib",
            "/carrier/bin/postgres",
            "--",
            "-D",
            "/pgdata",
        ]
        .into_iter()
        .map(OsString::from)
        .collect()
    }

    #[test]
    fn parses_the_complete_closed_product_contract() {
        let command = parse_from(valid_args()).unwrap();
        let Command::Run(run) = command else {
            panic!("expected run command");
        };
        assert!(run.quiet);
        assert_eq!(run.stack_size, 33_554_432);
        assert_eq!(run.manifest, PathBuf::from("/carrier/manifest.json"));
        assert_eq!(run.input, PathBuf::from("/carrier/bin/postgres"));
        assert_eq!(run.guest_args, ["-D", "/pgdata"]);
        assert_eq!(run.volumes.len(), 2);
    }

    #[test]
    fn version_is_the_only_non_run_surface() {
        assert_eq!(
            parse_from(["executor", "--version"]).unwrap(),
            Command::Version
        );
        assert!(parse_from(["executor", "--help"]).is_err());
        assert!(parse_from(["executor", "package", "list"]).is_err());
        assert!(parse_from(["executor", "--version", "extra"]).is_err());
    }

    #[test]
    fn denies_unknown_generic_wasmer_options() {
        for denied in [
            "--llvm",
            "--cranelift",
            "--singlepass",
            "--use",
            "--include-webc",
            "--map-command",
            "--env",
            "--http-client",
            "--invoke",
            "--entrypoint",
            "--enable-simd",
            "--net=ipv4:allow=127.0.0.1:*",
        ] {
            let mut args = valid_args();
            args.insert(2, OsString::from(denied));
            assert!(parse_from(args).is_err(), "accepted denied option {denied}");
        }
    }

    #[test]
    fn required_abi_and_cache_assertions_fail_closed() {
        for required in [
            "--disable-cache",
            "--enable-exceptions",
            "--enable-threads",
            "--net",
            "--stack-size",
            "--sealed-module-manifest",
        ] {
            let mut args = valid_args();
            let index = args.iter().position(|arg| arg == required).unwrap();
            args.remove(index);
            if matches!(required, "--stack-size" | "--sealed-module-manifest") {
                args.remove(index);
            }
            assert!(
                parse_from(args).is_err(),
                "accepted request without {required}"
            );
        }
    }

    #[test]
    fn duplicate_scalar_options_and_guest_mounts_are_rejected() {
        let mut duplicate_flag = valid_args();
        duplicate_flag.insert(2, OsString::from("--enable-threads"));
        assert!(parse_from(duplicate_flag).is_err());

        let mut duplicate_mount = valid_args();
        duplicate_mount.splice(
            2..2,
            [OsString::from("--volume"), OsString::from("/other:/lib")],
        );
        assert!(parse_from(duplicate_mount).is_err());
    }

    #[test]
    fn executable_and_guest_arguments_have_an_unambiguous_boundary() {
        let mut missing_separator = valid_args();
        let separator = missing_separator
            .iter()
            .position(|arg| arg == "--")
            .unwrap();
        missing_separator.remove(separator);
        assert!(parse_from(missing_separator).is_err());

        let mut separator_before_input = valid_args();
        let input = separator_before_input
            .iter()
            .position(|arg| arg == "/carrier/bin/postgres")
            .unwrap();
        separator_before_input.insert(input, OsString::from("--"));
        assert!(parse_from(separator_before_input).is_err());
    }

    #[test]
    fn volumes_require_normalized_absolute_guest_paths() {
        for invalid in [
            "/host:relative",
            "/host:/a/../b",
            "/host:/a//b",
            "/host:/a/",
            ":/guest",
        ] {
            assert!(parse_volume(invalid).is_err(), "accepted {invalid}");
        }
        assert_eq!(parse_volume("C:\\data:/data").unwrap().guest, "/data");
    }
}
