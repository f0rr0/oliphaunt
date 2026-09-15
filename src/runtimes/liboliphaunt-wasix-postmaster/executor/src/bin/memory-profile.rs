use std::{env, ffi::OsString, path::PathBuf};

use anyhow::{Context, Result, bail, ensure};
use oliphaunt_wasix_postmaster_executor::memory_profile::{
    profile_json, seal_module, verify_module,
};

const USAGE: &str = "usage: oliphaunt-wasix-memory-profile --profile-json\n       oliphaunt-wasix-memory-profile verify MODULE\n       oliphaunt-wasix-memory-profile seal --output SEALED --receipt RECEIPT MODULE";

fn take_path(arguments: &mut impl Iterator<Item = OsString>, name: &str) -> Result<PathBuf> {
    arguments
        .next()
        .map(PathBuf::from)
        .with_context(|| format!("missing {name}; {USAGE}"))
}

fn main() -> Result<()> {
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next().with_context(|| USAGE.to_owned())?;
    if command == "--profile-json" {
        ensure!(arguments.next().is_none(), "{USAGE}");
        println!("{}", profile_json()?);
        return Ok(());
    }
    if command == "verify" {
        let module = take_path(&mut arguments, "MODULE")?;
        ensure!(arguments.next().is_none(), "{USAGE}");
        println!("{}", verify_module(&module)?);
        return Ok(());
    }
    if command == "seal" {
        ensure!(
            arguments.next().as_deref() == Some("--output".as_ref()),
            "{USAGE}"
        );
        let output = take_path(&mut arguments, "SEALED")?;
        ensure!(
            arguments.next().as_deref() == Some("--receipt".as_ref()),
            "{USAGE}"
        );
        let receipt = take_path(&mut arguments, "RECEIPT")?;
        let module = take_path(&mut arguments, "MODULE")?;
        ensure!(arguments.next().is_none(), "{USAGE}");
        seal_module(&module, &output, &receipt)?;
        return Ok(());
    }
    bail!("unknown command '{}'; {USAGE}", command.to_string_lossy())
}
