use anyhow::Result;
#[cfg(feature = "extensions")]
use pglite_oxide::{PgDumpOptions, PgliteServer};
#[cfg(feature = "extensions")]
use std::env;
#[cfg(feature = "extensions")]
use std::path::PathBuf;

#[cfg(feature = "extensions")]
#[derive(Debug)]
struct Args {
    root: PathBuf,
    passthrough: Vec<String>,
}

fn main() -> Result<()> {
    #[cfg(not(feature = "extensions"))]
    {
        anyhow::bail!("pglite-dump requires the `extensions` feature");
    }
    #[cfg(feature = "extensions")]
    {
        let Args { root, passthrough } = parse_args()?;
        let server = PgliteServer::builder().path(root).start()?;
        let sql = server.dump_sql(PgDumpOptions::new().args(passthrough))?;
        print!("{sql}");
        server.shutdown()?;
        Ok(())
    }
}

#[cfg(feature = "extensions")]
fn parse_args() -> Result<Args> {
    let mut root = PathBuf::from("./.pglite");
    let mut passthrough = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                root = PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--root requires a path"))?,
                );
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--" => {
                passthrough.extend(args);
                break;
            }
            other => passthrough.push(other.to_string()),
        }
    }
    Ok(Args { root, passthrough })
}

#[cfg(feature = "extensions")]
fn print_usage() {
    eprintln!("Usage: pglite-dump --root PATH -- [pg_dump args]");
    eprintln!("Example: pglite-dump --root ./.pglite -- --schema-only");
}
