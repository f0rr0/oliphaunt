use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::thread;

use anyhow::{Context, Result, bail};
use oliphaunt_wasix::{OliphauntServer, PgDumpOptions, extensions};
use serde_json::json;

fn main() -> Result<()> {
    let root = parse_root()?;
    let server = OliphauntServer::builder()
        .path(root)
        .extensions([
            extensions::HSTORE,
            extensions::PG_TRGM,
            extensions::UNACCENT,
        ])
        .start()
        .context("start oliphaunt-wasix server")?;
    validate_wasix_tools(&server)?;
    println!("{}", json!({ "databaseUrl": server.connection_uri() }));
    io::stdout().flush()?;
    let _server = server;
    loop {
        thread::park();
    }
}

fn validate_wasix_tools(server: &OliphauntServer) -> Result<()> {
    let dump = server.dump_sql(PgDumpOptions::new().arg("--schema-only"))?;
    anyhow::ensure!(
        dump.contains("PostgreSQL database dump"),
        "pg_dump SQL backup smoke did not look like a PostgreSQL dump"
    );
    Ok(())
}

fn parse_root() -> Result<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--root" {
            let value = args.next().context("--root requires a path")?;
            return Ok(PathBuf::from(value));
        }
    }
    bail!("usage: oliphaunt-electron-wasix-sidecar --root <path>")
}
