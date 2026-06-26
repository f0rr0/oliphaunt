use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::thread;

use anyhow::{bail, Context, Result};
use oliphaunt_wasix::{extensions, OliphauntServer, PgDumpOptions, PsqlOptions};
use serde_json::json;

fn main() -> Result<()> {
    let root = parse_root()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build WASIX sidecar Tokio runtime")?;
    let _runtime_context = runtime.enter();
    let server = start_server(root)?;
    println!("{}", json!({ "databaseUrl": server.connection_uri() }));
    io::stdout().flush()?;
    let _server = server;
    loop {
        thread::park();
    }
}

fn start_server(root: PathBuf) -> Result<OliphauntServer> {
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
    Ok(server)
}

fn validate_wasix_tools(server: &OliphauntServer) -> Result<()> {
    server
        .preflight_tools()
        .context("preflight split WASIX pg_dump and psql tools")?;
    let dump = server.dump_sql(PgDumpOptions::new().arg("--schema-only"))?;
    anyhow::ensure!(
        dump.contains("PostgreSQL database dump"),
        "pg_dump SQL backup smoke did not look like a PostgreSQL dump"
    );
    let psql = server.psql(PsqlOptions::new().arg("-tA").command("SELECT 1"))?;
    anyhow::ensure!(
        psql.lines().any(|line| line.trim() == "1"),
        "psql smoke did not return SELECT 1 output"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_smoke_runs_split_wasix_tools() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-electron-wasix-sidecar-smoke-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build WASIX sidecar smoke runtime");
        let _runtime_context = runtime.enter();
        let server = start_server(root.clone())
            .expect("start sidecar server and run split WASIX pg_dump tool");
        drop(server);
        let _ = std::fs::remove_dir_all(root);
    }
}
