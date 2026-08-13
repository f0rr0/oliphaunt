use anyhow::{Context, Result, bail};
#[cfg(feature = "extensions")]
use oliphaunt_wasix::extensions;
use oliphaunt_wasix::{ApplicationData, DatabaseInitialization, DatabaseStorage, OliphauntServer};
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug)]
enum Bind {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

#[derive(Debug)]
struct Args {
    storage: DatabaseStorage,
    initialization: DatabaseInitialization,
    bind: Bind,
    print_uri: bool,
    postgres_config: Vec<(String, String)>,
    extensions: Vec<String>,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mut builder = OliphauntServer::builder()
        .storage(args.storage)
        .initialization(args.initialization);

    builder = match args.bind {
        Bind::Tcp(addr) => builder.tcp(addr),
        #[cfg(unix)]
        Bind::Unix(path) => builder.unix(path),
    };
    builder = builder.postgres_configs(args.postgres_config);

    #[cfg(feature = "extensions")]
    {
        for name in &args.extensions {
            let extension = extensions::by_sql_name(name)
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
        println!("{}", server.connection_uri());
    } else {
        eprintln!("listening: {}", server.connection_uri());
    }

    loop {
        std::thread::park();
    }
}

fn parse_args() -> Result<Args> {
    let mut storage = DatabaseStorage::Memory;
    let mut initialization = DatabaseInitialization::PackagedTemplate;
    let mut print_uri = false;
    let mut postgres_config = Vec::new();
    let mut extensions = Vec::new();
    let mut bind = Bind::Tcp("127.0.0.1:5432".parse().expect("valid default TCP addr"));

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--memory" => storage = DatabaseStorage::Memory,
            "--temporary-directory" => storage = DatabaseStorage::TemporaryDirectory,
            "--directory" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--directory requires a path"))?;
                storage = DatabaseStorage::Directory(PathBuf::from(value));
            }
            "--application-data" => {
                let qualifier = args.next().ok_or_else(|| {
                    anyhow::anyhow!(
                        "--application-data requires QUALIFIER ORGANIZATION APPLICATION"
                    )
                })?;
                let organization = args.next().ok_or_else(|| {
                    anyhow::anyhow!(
                        "--application-data requires QUALIFIER ORGANIZATION APPLICATION"
                    )
                })?;
                let application = args.next().ok_or_else(|| {
                    anyhow::anyhow!(
                        "--application-data requires QUALIFIER ORGANIZATION APPLICATION"
                    )
                })?;
                storage = DatabaseStorage::ApplicationData(ApplicationData::new(
                    qualifier,
                    organization,
                    application,
                ));
            }
            "--packaged-template" => {
                initialization = DatabaseInitialization::PackagedTemplate;
            }
            "--fresh-initdb" => initialization = DatabaseInitialization::FreshInitdb,
            "--physical-archive" => {
                let path = PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--physical-archive requires a path"))?,
                );
                let bytes = std::fs::read(&path)
                    .with_context(|| format!("read database archive {}", path.display()))?;
                initialization = DatabaseInitialization::PhysicalArchive(bytes);
            }
            "--tcp" => {
                let value = args.next().unwrap_or_else(|| "127.0.0.1:5432".to_string());
                bind = Bind::Tcp(
                    value
                        .parse()
                        .with_context(|| format!("parse TCP bind address {value}"))?,
                );
            }
            #[cfg(unix)]
            "--unix" | "--uds" => {
                let value = args
                    .next()
                    .unwrap_or_else(|| "/tmp/.s.PGSQL.5432".to_string());
                bind = Bind::Unix(PathBuf::from(value));
            }
            "--print-uri" => print_uri = true,
            "--postgres-config" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--postgres-config requires name=value"))?;
                let (name, value) = value
                    .split_once('=')
                    .ok_or_else(|| anyhow::anyhow!("--postgres-config requires name=value"))?;
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
        initialization,
        bind,
        print_uri,
        postgres_config,
        extensions,
    })
}

fn print_usage() {
    eprintln!(
        "Usage: oliphaunt-wasix-proxy [--memory | --temporary-directory | --directory PATH | --application-data QUALIFIER ORGANIZATION APPLICATION] [--packaged-template | --fresh-initdb | --physical-archive PATH] [--tcp ADDR | --unix PATH] [--print-uri] [--postgres-config NAME=VALUE] [--extension NAME]"
    );
    eprintln!("  --memory          Store PGDATA in memory. This is the default");
    eprintln!("  --temporary-directory");
    eprintln!("                    Store PGDATA in a host directory removed on exit");
    eprintln!("  --directory PATH  Store PGDATA in a retained host directory");
    eprintln!("  --application-data QUALIFIER ORGANIZATION APPLICATION");
    eprintln!("                    Store PGDATA in the platform application-data directory");
    eprintln!("  --packaged-template  Initialize an empty database from the packaged template");
    eprintln!("  --fresh-initdb       Initialize an empty database with WASIX initdb");
    eprintln!("  --physical-archive PATH  Initialize empty storage from a physical backup");
    eprintln!("  --tcp ADDR        Listen on TCP. Use 127.0.0.1:0 for a random port");
    #[cfg(unix)]
    eprintln!("  --unix PATH       Listen on a PostgreSQL .s.PGSQL.<port> socket path");
    eprintln!("  --print-uri       Print the PostgreSQL connection URI to stdout");
    eprintln!("  --postgres-config NAME=VALUE");
    eprintln!("                    Set a PostgreSQL startup GUC on the embedded backend");
    eprintln!("  --extension NAME  Enable an installed extension by SQL name");
}
