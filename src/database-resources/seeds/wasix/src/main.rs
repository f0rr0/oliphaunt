use std::path::PathBuf;

use anyhow::{Result, bail};
use oliphaunt_wasix_seed_producer::{
    CatalogProfile, clean_generated_cluster_seed, run_wasix_initdb_cluster_seed,
};

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let runtime = args.next().map(PathBuf::from);
    let output = args.next().map(PathBuf::from);
    let profile = match args.next().as_deref().and_then(|arg| arg.to_str()) {
        Some("standard") => CatalogProfile::Standard,
        Some("icu") => CatalogProfile::Icu,
        _ => bail!(
            "usage: oliphaunt-wasix-seed-producer RUNTIME_DIR WORK_DIR standard|icu [ICU_DATA_DIR]"
        ),
    };
    let icu = args.next().map(PathBuf::from);
    let (Some(runtime), Some(output)) = (runtime, output) else {
        bail!("runtime and work directories are required")
    };
    if args.next().is_some() || output.exists() {
        bail!("work directory must be new; no extra arguments are accepted");
    }
    run_wasix_initdb_cluster_seed(&runtime, &output, profile, icu.as_deref())?;
    clean_generated_cluster_seed(&output.join("pgdata"))
}
