use anyhow::{Result, bail};
#[cfg(feature = "extensions")]
use oliphaunt_wasix::Extension;
use oliphaunt_wasix::{DatabaseStorage, OliphauntServer, ServerListen};
use std::env;
use std::path::PathBuf;

#[derive(Debug)]
enum Bind {
    Tcp(u16),
    #[cfg(unix)]
    Unix {
        directory: PathBuf,
        port: u16,
    },
}

#[derive(Debug)]
struct Args {
    storage: DatabaseStorage,
    bind: Bind,
    print_uri: bool,
    postgres_config: Vec<(String, String)>,
    extensions: Vec<String>,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mut builder = OliphauntServer::builder().storage(args.storage);

    builder = match args.bind {
        Bind::Tcp(0) => builder.listen(ServerListen::tcp()),
        Bind::Tcp(port) => builder.listen(ServerListen::tcp_port(port)),
        #[cfg(unix)]
        Bind::Unix { directory, port } => builder.listen(ServerListen::unix_port(directory, port)),
    };
    builder = builder.startup_gucs(args.postgres_config);

    #[cfg(feature = "extensions")]
    {
        for name in &args.extensions {
            let extension = Extension::by_sql_name(name)
                .ok_or_else(|| anyhow::anyhow!("unknown extension: {name}"))?;
            builder = builder.extension(extension);
        }
    }
    #[cfg(not(feature = "extensions"))]
    if !args.extensions.is_empty() {
        bail!("this oliphaunt-wasix-proxy build was compiled without extension support");
    }

    let server = builder.start()?;
    if args.print_uri {
        println!("{}", server.connection_string());
    } else {
        eprintln!("listening: {}", server.connection_string());
    }

    loop {
        std::thread::park();
    }
}

fn parse_args() -> Result<Args> {
    let mut storage = DatabaseStorage::Memory;
    let mut print_uri = false;
    let mut postgres_config = Vec::new();
    let mut extensions = Vec::new();
    let mut bind = Bind::Tcp(0);

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--memory" => storage = DatabaseStorage::Memory,
            "--directory" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--directory requires a path"))?;
                storage = DatabaseStorage::Directory(PathBuf::from(value));
            }
            "--tcp" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--tcp requires a port"))?;
                bind = Bind::Tcp(parse_port("--tcp", &value)?);
            }
            #[cfg(unix)]
            "--unix" | "--uds" => {
                let directory = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--unix requires a directory"))?;
                bind = Bind::Unix {
                    directory: PathBuf::from(directory),
                    port: 5432,
                };
            }
            "--print-uri" => print_uri = true,
            "--startup-guc" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--startup-guc requires name=value"))?;
                let (name, value) = value
                    .split_once('=')
                    .ok_or_else(|| anyhow::anyhow!("--startup-guc requires name=value"))?;
                postgres_config.push((name.to_owned(), value.to_owned()));
            }
            "--extension" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--extension requires a name"))?;
                extensions.push(value);
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    Ok(Args {
        storage,
        bind,
        print_uri,
        postgres_config,
        extensions,
    })
}

fn parse_port(flag: &str, value: &str) -> Result<u16> {
    let port = value
        .parse::<u16>()
        .map_err(|_| anyhow::anyhow!("{flag} requires a port in the range 1..=65535"))?;
    if port == 0 {
        bail!("{flag} requires a port in the range 1..=65535");
    }
    Ok(port)
}

fn print_usage() {
    eprintln!(
        "Usage: oliphaunt-wasix-proxy [--memory | --directory PATH] [--tcp PORT | --unix DIRECTORY] [--print-uri] [--startup-guc NAME=VALUE] [--extension NAME]"
    );
    eprintln!("  --memory          Store PGDATA in memory. This is the default");
    eprintln!("  --directory PATH  Store PGDATA in a retained host directory");
    eprintln!("  --tcp PORT        Listen on IPv4 loopback using PORT");
    #[cfg(unix)]
    eprintln!("  --unix DIRECTORY  Listen on DIRECTORY/.s.PGSQL.5432");
    eprintln!("  --print-uri       Print the PostgreSQL connection URI to stdout");
    eprintln!("  --startup-guc NAME=VALUE");
    eprintln!("                    Set a PostgreSQL startup GUC on the embedded backend");
    eprintln!("  --extension NAME  Select an extension artifact by SQL name");
}
