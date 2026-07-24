use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use oliphaunt::{
    NativeExtensionArtifactIndexCreateOptions, NativeExtensionArtifactIndexSigningOptions,
    create_prebuilt_extension_artifact_index, sign_prebuilt_extension_artifact_index,
};

fn main() {
    match run() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("oliphaunt-extension-index: {error}");
            process::exit(2);
        }
    }
}

fn run() -> oliphaunt::Result<()> {
    let args = IndexArgs::parse(env::args().skip(1))?;
    if args.help {
        print_help();
        return Ok(());
    }
    let output = args.output.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --output <index.toml>".to_owned())
    })?;
    let target = args.target.ok_or_else(|| {
        oliphaunt::Error::InvalidConfig("missing required --target <artifact-target>".to_owned())
    })?;
    let index = create_prebuilt_extension_artifact_index(
        NativeExtensionArtifactIndexCreateOptions::new(output, target)
            .artifacts(args.artifacts)
            .maybe_artifact_base_url(args.base_url)
            .replace_existing(args.force),
    )?;
    println!("path={}", index.path.display());
    println!("target={}", index.target);
    println!(
        "extensions={}",
        index
            .artifacts
            .iter()
            .map(|artifact| artifact.sql_name.as_str())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!(
        "artifacts={}",
        index
            .artifacts
            .iter()
            .map(|artifact| format!(
                "{}:{}:{}",
                artifact.sql_name,
                artifact.path.display(),
                artifact.sha256
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    if let Some((key_id, signing_key_hex)) = args.signing_key {
        let signature = sign_prebuilt_extension_artifact_index(
            NativeExtensionArtifactIndexSigningOptions::new(&index.path, key_id, signing_key_hex)
                .maybe_signature_path(args.signature)
                .replace_existing(args.force),
        )?;
        println!("signature={}", signature.path.display());
        println!("signatureKeyId={}", signature.key_id);
        println!("signaturePublicKey={}", signature.public_key_hex);
    }
    Ok(())
}

struct IndexArgs {
    output: Option<PathBuf>,
    target: Option<String>,
    artifacts: Vec<PathBuf>,
    base_url: Option<String>,
    signing_key: Option<(String, String)>,
    signature: Option<PathBuf>,
    force: bool,
    help: bool,
}

impl IndexArgs {
    fn parse(args: impl IntoIterator<Item = String>) -> oliphaunt::Result<Self> {
        let mut parsed = Self {
            output: None,
            target: None,
            artifacts: Vec::new(),
            base_url: None,
            signing_key: None,
            signature: None,
            force: false,
            help: false,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-h" | "--help" => parsed.help = true,
                "--force" => parsed.force = true,
                "--output" | "-o" => {
                    parsed.output = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--target" | "--extension-target" | "--artifact-target" => {
                    parsed.target = Some(next_value(&mut args, &arg)?);
                }
                "--artifact" | "--extension-artifact" => {
                    parsed
                        .artifacts
                        .push(PathBuf::from(next_value(&mut args, &arg)?));
                }
                "--base-url" | "--artifact-base-url" => {
                    parsed.base_url = Some(next_value(&mut args, &arg)?);
                }
                "--signing-key" => {
                    parsed.signing_key = Some(parse_key_value(&next_value(&mut args, &arg)?)?);
                }
                "--signing-key-file" => {
                    parsed.signing_key = Some(read_key_file_value(&next_value(&mut args, &arg)?)?);
                }
                "--signature" | "--signature-output" => {
                    parsed.signature = Some(PathBuf::from(next_value(&mut args, &arg)?));
                }
                value if value.starts_with("--output=") => {
                    parsed.output = Some(PathBuf::from(value_without_prefix(value, "--output=")));
                }
                value if value.starts_with("--target=") => {
                    parsed.target = Some(value_without_prefix(value, "--target=").to_owned());
                }
                value if value.starts_with("--extension-target=") => {
                    parsed.target =
                        Some(value_without_prefix(value, "--extension-target=").to_owned());
                }
                value if value.starts_with("--artifact-target=") => {
                    parsed.target =
                        Some(value_without_prefix(value, "--artifact-target=").to_owned());
                }
                value if value.starts_with("--artifact=") => {
                    parsed
                        .artifacts
                        .push(PathBuf::from(value_without_prefix(value, "--artifact=")));
                }
                value if value.starts_with("--extension-artifact=") => {
                    parsed.artifacts.push(PathBuf::from(value_without_prefix(
                        value,
                        "--extension-artifact=",
                    )));
                }
                value if value.starts_with("--base-url=") => {
                    parsed.base_url = Some(value_without_prefix(value, "--base-url=").to_owned());
                }
                value if value.starts_with("--artifact-base-url=") => {
                    parsed.base_url =
                        Some(value_without_prefix(value, "--artifact-base-url=").to_owned());
                }
                value if value.starts_with("--signing-key=") => {
                    parsed.signing_key = Some(parse_key_value(value_without_prefix(
                        value,
                        "--signing-key=",
                    ))?);
                }
                value if value.starts_with("--signing-key-file=") => {
                    parsed.signing_key = Some(read_key_file_value(value_without_prefix(
                        value,
                        "--signing-key-file=",
                    ))?);
                }
                value if value.starts_with("--signature=") => {
                    parsed.signature =
                        Some(PathBuf::from(value_without_prefix(value, "--signature=")));
                }
                value if value.starts_with("--signature-output=") => {
                    parsed.signature = Some(PathBuf::from(value_without_prefix(
                        value,
                        "--signature-output=",
                    )));
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
        oliphaunt::Error::InvalidConfig(format!("read signing key file {path}: {err}"))
    })?;
    Ok((key_id.to_owned(), text.trim().to_owned()))
}

fn print_help() {
    println!(
        "\
Create a verified Oliphaunt extension artifact index for one target.

Usage:
  oliphaunt-extension-index --output <index.toml> --target <artifact-target> --artifact <artifact-archive> [--artifact <artifact-archive> ...] [--base-url <https-url>] [--signing-key-file <key-id>:<path>] [--signature <index.toml.sig>] [--force]

The index writer validates every artifact manifest, rejects built-in extension
name overrides, computes byte counts and SHA-256 digests, and records relative
artifact paths plus dependency, preload, native-module, and mobile-prebuilt
metadata for catalog discovery. Artifact archives may use .tar, .tar.gz, or
.tar.zst. Put the index next to the artifact archives,
then use oliphaunt-resources --extension <sql-name> --extension-index <index.toml>.
Pass --base-url when publishing artifacts through an HTTPS release URL;
consumers can then use oliphaunt-resources --extension-cache <dir> to download
and verify missing sidecar artifacts without building extension source.
Pass --signing-key-file to write an Ed25519 detached signature sidecar for the
exact index bytes. The file must contain a hex-encoded 32-byte Ed25519 signing
key. For local automation only, --signing-key <key-id>:<hex-key> is also
accepted.
"
    );
}
