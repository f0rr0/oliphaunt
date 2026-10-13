use std::path::PathBuf;

use anyhow::{Result, bail};
use oliphaunt_wasix_seed_producer::{
    CatalogProfile, bootstrap_recipe, clean_generated_cluster_seed, run_wasix_initdb_cluster_seed,
    verify_wasix_cluster_seed,
};

fn catalog_profile(argument: Option<std::ffi::OsString>) -> Result<CatalogProfile> {
    match argument.as_deref().and_then(|arg| arg.to_str()) {
        Some("standard") => Ok(CatalogProfile::Standard),
        Some("icu") => Ok(CatalogProfile::Icu),
        _ => bail!(
            "usage: oliphaunt-wasix-seed-producer RUNTIME_DIR WORK_DIR standard|icu [ICU_DATA_DIR]\n       oliphaunt-wasix-seed-producer verify RUNTIME_DIR WORK_DIR standard|icu PGDATA_DIR [ICU_DATA_DIR]\n       oliphaunt-wasix-seed-producer recipe standard|icu"
        ),
    }
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref().and_then(|arg| arg.to_str()) == Some("recipe") {
        let profile = catalog_profile(args.next())?;
        if args.next().is_some() {
            bail!("recipe description accepts only its catalog profile");
        }
        println!("{}", serde_json::to_string(&bootstrap_recipe(profile))?);
        return Ok(());
    }
    let verify = first.as_deref().and_then(|arg| arg.to_str()) == Some("verify");
    let runtime = if verify { args.next() } else { first }.map(PathBuf::from);
    let output = args.next().map(PathBuf::from);
    let profile = catalog_profile(args.next())?;
    let pgdata = if verify {
        args.next().map(PathBuf::from)
    } else {
        None
    };
    let icu = args.next().map(PathBuf::from);
    let (Some(runtime), Some(output)) = (runtime, output) else {
        bail!("runtime and work directories are required")
    };
    if args.next().is_some() || output.exists() {
        bail!("work directory must be new; no extra arguments are accepted");
    }
    if verify {
        let Some(pgdata) = pgdata else {
            bail!("verification requires a source PGDATA directory")
        };
        verify_wasix_cluster_seed(&runtime, &output, profile, &pgdata, icu.as_deref())
    } else {
        run_wasix_initdb_cluster_seed(&runtime, &output, profile, icu.as_deref())?;
        clean_generated_cluster_seed(&output.join("pgdata"))
    }
}
