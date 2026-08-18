use anyhow::Result;
#[cfg(feature = "tools")]
use oliphaunt_wasix::{DatabaseStorage, OliphauntServer, PgDumpOptions};
#[cfg(feature = "tools")]
use std::env;
#[cfg(feature = "tools")]
use std::path::PathBuf;

#[cfg(feature = "tools")]
#[derive(Debug)]
struct Args {
    directory: PathBuf,
    passthrough: Vec<String>,
}

fn main() -> Result<()> {
    #[cfg(not(feature = "tools"))]
    {
        anyhow::bail!("oliphaunt-wasix-dump requires the `tools` feature");
    }
    #[cfg(feature = "tools")]
    {
        let Args {
            directory,
            passthrough,
        } = parse_args()?;
        let server = OliphauntServer::builder()
            .storage(DatabaseStorage::Directory(directory))
            .start()?;
        let sql = server.dump_sql(PgDumpOptions::new().args(passthrough))?;
        print!("{sql}");
        server.shutdown()?;
        Ok(())
    }
}

#[cfg(feature = "tools")]
fn parse_args() -> Result<Args> {
    let mut directory = PathBuf::from("./.oliphaunt");
    let mut passthrough = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--directory" => {
                directory = PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--directory requires a path"))?,
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
    Ok(Args {
        directory,
        passthrough,
    })
}

#[cfg(feature = "tools")]
fn print_usage() {
    eprintln!("Usage: oliphaunt-wasix-dump --directory PATH -- [pg_dump args]");
    eprintln!("Example: oliphaunt-wasix-dump --directory ./.oliphaunt -- --schema-only");
}
