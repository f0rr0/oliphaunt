use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::thread;

use anyhow::{Context, Result, bail};
use oliphaunt_wasix::{AsyncOliphauntServer, DatabaseStorage, Extension};
#[cfg(test)]
use oliphaunt_wasix::{Oliphaunt, tools};
use serde_json::json;

fn main() -> Result<()> {
    let directory = parse_directory()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build WASIX sidecar Tokio runtime")?;
    let server = runtime.block_on(start_server(directory))?;
    println!("{}", json!({ "databaseUrl": server.connection_string() }));
    io::stdout().flush()?;
    let _server = server;
    loop {
        thread::park();
    }
}

async fn start_server(directory: PathBuf) -> Result<AsyncOliphauntServer> {
    let server = AsyncOliphauntServer::builder()
        .storage(DatabaseStorage::Directory(directory))
        .extensions([
            Extension::HSTORE,
            Extension::PG_TRGM,
            Extension::UNACCENT,
        ])
        .start()
        .await
        .context("start oliphaunt-wasix server")?;
    Ok(server)
}

#[cfg(test)]
fn validate_wasix_tools() -> Result<()> {
    let mut database = Oliphaunt::open()?;
    let dump = database.pg_dump(tools::PgDumpOptions::new().arg("--schema-only"))?;
    anyhow::ensure!(
        dump.contains("PostgreSQL database dump"),
        "pg_dump SQL backup smoke did not look like a PostgreSQL dump"
    );
    let psql = database.psql(tools::PsqlOptions::new().arg("-tA").command("SELECT 1"))?;
    anyhow::ensure!(
        psql.lines().any(|line| line.trim() == "1"),
        "psql smoke did not return SELECT 1 output"
    );
    database.close()?;
    Ok(())
}

fn parse_directory() -> Result<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--directory" {
            let value = args.next().context("--directory requires a path")?;
            return Ok(PathBuf::from(value));
        }
    }
    bail!("usage: oliphaunt-electron-wasix-sidecar --directory <path>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_smoke_runs_split_wasix_tools() {
        let directory = std::env::temp_dir().join(format!(
            "oliphaunt-electron-wasix-sidecar-smoke-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build WASIX sidecar smoke runtime");
        validate_wasix_tools().expect("run explicit split WASIX tools smoke");
        let server = runtime
            .block_on(start_server(directory.clone()))
            .expect("start sidecar server after split WASIX tools smoke");
        drop(server);
        let _ = std::fs::remove_dir_all(directory);
    }
}
