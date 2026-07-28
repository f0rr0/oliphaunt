use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::thread;

use oliphaunt::{
    BackupArtifact, BackupFormat, BootstrapStrategy, DEFAULT_DATABASE, DEFAULT_USERNAME,
    DatabaseRoot, DurabilityProfile, EngineCancel, EngineMode, Extension, NativeDirectConfig,
    NativeRuntime, Oliphaunt, OliphauntRuntime, OpenConfig, PostgresStartupGuc, RestoreRequest,
    RootLockPolicy, RuntimeFootprintProfile, StorageConfig,
};

const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";

fn main() {
    if let Err(error) = run() {
        println!("OLIPHAUNT_BROKER_ERROR {error}");
        process::exit(2);
    }
}

fn run() -> oliphaunt::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("restore")) {
        return RestoreArgs::parse(args.into_iter().skip(1).collect())?.run();
    }
    let args = BrokerArgs::parse(args)?;
    let config = OpenConfig {
        mode: EngineMode::NativeDirect,
        storage: StorageConfig {
            root: DatabaseRoot::Path(args.root),
            bootstrap: args.bootstrap,
            lock_policy: RootLockPolicy::ExclusiveProcess,
        },
        direct: NativeDirectConfig::default(),
        broker: Default::default(),
        server: Default::default(),
        durability: args.durability,
        runtime_footprint: args.runtime_footprint,
        startup_gucs: args.startup_gucs,
        username: args.username,
        database: args.database,
        extensions: args.extensions,
    };
    config.validate()?;
    let mut session = OliphauntRuntime::from_env().open(config)?;
    let cancel = session.cancel_handle().ok_or_else(|| {
        oliphaunt::Error::Engine(
            "native broker direct session does not expose cancellation".to_owned(),
        )
    })?;
    let listener = BrokerListener::bind(args.endpoint)?;
    let cancel_listener = BrokerListener::bind(args.cancel_endpoint)?;
    let cancel_ready_endpoint = cancel_listener.ready_endpoint();
    start_cancel_listener(cancel_listener, cancel, args.auth_token.clone());
    println!(
        "OLIPHAUNT_BROKER_READY {} cancel={}",
        listener.ready_endpoint(),
        cancel_ready_endpoint
    );
    io::stdout()
        .flush()
        .map_err(|err| oliphaunt::Error::Engine(format!("flush broker ready line: {err}")))?;

    let mut stream = listener.accept()?;
    authenticate_client(&mut stream, &args.auth_token)?;
    loop {
        let request = oliphaunt::broker_ipc_read_request(&mut stream)?;
        match request {
            oliphaunt::BrokerIpcRequest::Authenticate(_) => {
                oliphaunt::broker_ipc_write_error(
                    &mut stream,
                    "broker client is already authenticated".to_owned(),
                )?;
                break;
            }
            oliphaunt::BrokerIpcRequest::ExecProtocol(bytes) => {
                let response = session.exec_protocol_raw(bytes.into());
                write_broker_response(&mut stream, response.map(|response| response.into_bytes()))?;
            }
            oliphaunt::BrokerIpcRequest::ExecSimpleQuery(sql) => {
                let response = session.exec_simple_query(&sql);
                write_broker_response(&mut stream, response.map(|response| response.into_bytes()))?;
            }
            oliphaunt::BrokerIpcRequest::ExecProtocolStream(bytes) => {
                let result = session.exec_protocol_stream(bytes.into(), &mut |chunk| {
                    oliphaunt::broker_ipc_write_chunk(&mut stream, chunk)
                });
                match result {
                    Ok(()) => oliphaunt::broker_ipc_write_ok(&mut stream, Vec::new())?,
                    Err(error) => {
                        oliphaunt::broker_ipc_write_error(&mut stream, error.to_string())?
                    }
                }
            }
            oliphaunt::BrokerIpcRequest::Checkpoint => {
                write_broker_response(&mut stream, session.checkpoint().map(|()| Vec::new()))?;
            }
            oliphaunt::BrokerIpcRequest::Backup(request) => {
                write_broker_response(
                    &mut stream,
                    session.backup(request).map(|artifact| artifact.bytes),
                )?;
            }
            oliphaunt::BrokerIpcRequest::Cancel => {
                write_broker_response(
                    &mut stream,
                    Err(oliphaunt::Error::Engine(
                        "broker cancellation must use the cancel endpoint".to_owned(),
                    )),
                )?;
            }
            oliphaunt::BrokerIpcRequest::Close => {
                let result = session.close().map(|()| Vec::new());
                write_broker_response(&mut stream, result)?;
                break;
            }
        }
    }
    Ok(())
}

struct RestoreArgs {
    root: PathBuf,
    artifact: PathBuf,
    replace_existing: bool,
}

impl RestoreArgs {
    fn parse(args: Vec<String>) -> oliphaunt::Result<Self> {
        let mut root = None;
        let mut artifact = None;
        let mut replace_existing = false;
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--root" => {
                    root = Some(iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "restore --root requires a filesystem path".to_owned(),
                        )
                    })?);
                }
                "--artifact" => {
                    artifact = Some(iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "restore --artifact requires a physical archive path".to_owned(),
                        )
                    })?);
                }
                "--replace-existing" => replace_existing = true,
                _ => {
                    return Err(oliphaunt::Error::InvalidConfig(format!(
                        "unknown broker restore argument '{arg}'"
                    )));
                }
            }
        }

        Ok(Self {
            root: root
                .ok_or_else(|| {
                    oliphaunt::Error::InvalidConfig("restore --root is required".to_owned())
                })?
                .into(),
            artifact: artifact
                .ok_or_else(|| {
                    oliphaunt::Error::InvalidConfig("restore --artifact is required".to_owned())
                })?
                .into(),
            replace_existing,
        })
    }

    fn run(self) -> oliphaunt::Result<()> {
        let bytes = fs::read(&self.artifact).map_err(|err| {
            oliphaunt::Error::Engine(format!(
                "read restore artifact {}: {err}",
                self.artifact.display()
            ))
        })?;
        let artifact = BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        };
        let mut request = RestoreRequest::physical_archive(self.root, artifact);
        if self.replace_existing {
            request = request.replace_existing();
        }
        Oliphaunt::restore_blocking(request)?;
        Ok(())
    }
}

fn start_cancel_listener(
    listener: BrokerListener,
    cancel: Arc<dyn EngineCancel>,
    expected_token: String,
) {
    thread::Builder::new()
        .name("oliphaunt-broker-cancel".to_owned())
        .spawn(move || {
            loop {
                match listener.accept() {
                    Ok(mut stream) => {
                        if let Err(error) =
                            handle_cancel_client(&mut stream, cancel.as_ref(), &expected_token)
                        {
                            eprintln!("OLIPHAUNT_BROKER_CANCEL_ERROR {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("OLIPHAUNT_BROKER_CANCEL_ERROR {error}");
                        break;
                    }
                }
            }
        })
        .expect("spawn native broker cancel listener");
}

fn handle_cancel_client(
    stream: &mut Box<dyn BrokerTransport>,
    cancel: &dyn EngineCancel,
    expected_token: &str,
) -> oliphaunt::Result<()> {
    authenticate_client(stream, expected_token)?;
    match oliphaunt::broker_ipc_read_request(stream)? {
        oliphaunt::BrokerIpcRequest::Cancel => {
            write_broker_response(stream, cancel.cancel().map(|()| Vec::new()))
        }
        oliphaunt::BrokerIpcRequest::Authenticate(_) => oliphaunt::broker_ipc_write_error(
            stream,
            "broker cancel client is already authenticated".to_owned(),
        ),
        _ => oliphaunt::broker_ipc_write_error(
            stream,
            "broker cancel endpoint only accepts cancellation requests".to_owned(),
        ),
    }
}

fn authenticate_client(
    stream: &mut Box<dyn BrokerTransport>,
    expected_token: &str,
) -> oliphaunt::Result<()> {
    match oliphaunt::broker_ipc_read_request(stream)? {
        oliphaunt::BrokerIpcRequest::Authenticate(token) if token == expected_token => {
            oliphaunt::broker_ipc_write_ok(stream, Vec::new())
        }
        oliphaunt::BrokerIpcRequest::Authenticate(_) => {
            oliphaunt::broker_ipc_write_error(
                stream,
                "invalid broker authentication token".to_owned(),
            )?;
            Err(oliphaunt::Error::Engine(
                "invalid broker authentication token".to_owned(),
            ))
        }
        _ => {
            oliphaunt::broker_ipc_write_error(
                stream,
                "broker client must authenticate before sending requests".to_owned(),
            )?;
            Err(oliphaunt::Error::Engine(
                "broker client did not authenticate".to_owned(),
            ))
        }
    }
}

fn write_broker_response(
    stream: &mut impl Write,
    result: oliphaunt::Result<Vec<u8>>,
) -> oliphaunt::Result<()> {
    match result {
        Ok(bytes) => oliphaunt::broker_ipc_write_ok(stream, bytes),
        Err(error) => oliphaunt::broker_ipc_write_error(stream, error.to_string()),
    }
}

struct BrokerArgs {
    root: std::path::PathBuf,
    endpoint: BrokerListenEndpoint,
    cancel_endpoint: BrokerListenEndpoint,
    bootstrap: BootstrapStrategy,
    durability: DurabilityProfile,
    runtime_footprint: RuntimeFootprintProfile,
    startup_gucs: Vec<PostgresStartupGuc>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
    auth_token: String,
}

impl BrokerArgs {
    fn parse(args: Vec<String>) -> oliphaunt::Result<Self> {
        let mut root = None;
        let mut endpoint = BrokerListenEndpoint::Tcp("127.0.0.1:0".to_owned());
        let mut cancel_endpoint = BrokerListenEndpoint::Tcp("127.0.0.1:0".to_owned());
        let mut bootstrap = "packaged-template".to_owned();
        let mut initdb = None;
        let mut durability = DurabilityProfile::Safe;
        let mut runtime_footprint = RuntimeFootprintProfile::Throughput;
        let mut startup_gucs = Vec::new();
        let mut username = DEFAULT_USERNAME.to_owned();
        let mut database = DEFAULT_DATABASE.to_owned();
        let mut extensions = Vec::new();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--root" => root = iter.next().map(Into::into),
                "--listen" => {
                    let listen = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig("--listen requires an address".to_owned())
                    })?;
                    endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--cancel-listen" => {
                    let listen = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--cancel-listen requires an address".to_owned(),
                        )
                    })?;
                    cancel_endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--socket" => {
                    let socket = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--socket requires a filesystem path".to_owned(),
                        )
                    })?;
                    endpoint = BrokerListenEndpoint::unix(socket)?;
                }
                "--cancel-socket" => {
                    let socket = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--cancel-socket requires a filesystem path".to_owned(),
                        )
                    })?;
                    cancel_endpoint = BrokerListenEndpoint::unix(socket)?;
                }
                "--bootstrap" => {
                    bootstrap = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig("--bootstrap requires a value".to_owned())
                    })?;
                }
                "--initdb" => {
                    initdb = Some(iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--initdb requires a filesystem path".to_owned(),
                        )
                    })?);
                }
                "--durability" => {
                    durability = parse_durability(&iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig("--durability requires a value".to_owned())
                    })?)?;
                }
                "--runtime-footprint" => {
                    runtime_footprint =
                        parse_runtime_footprint(&iter.next().ok_or_else(|| {
                            oliphaunt::Error::InvalidConfig(
                                "--runtime-footprint requires a value".to_owned(),
                            )
                        })?)?;
                }
                "--startup-guc" => {
                    let assignment = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--startup-guc requires name=value".to_owned(),
                        )
                    })?;
                    startup_gucs.push(parse_startup_guc(&assignment)?);
                }
                "--username" => {
                    username = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--username requires a PostgreSQL role".to_owned(),
                        )
                    })?;
                }
                "--database" => {
                    database = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--database requires a PostgreSQL database name".to_owned(),
                        )
                    })?;
                }
                "--extension" => {
                    let sql_name = iter.next().ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(
                            "--extension requires a SQL extension name".to_owned(),
                        )
                    })?;
                    let extension = Extension::by_sql_name(&sql_name).ok_or_else(|| {
                        oliphaunt::Error::InvalidConfig(format!(
                            "unsupported native extension '{sql_name}'"
                        ))
                    })?;
                    extensions.push(extension);
                }
                _ => {
                    return Err(oliphaunt::Error::InvalidConfig(format!(
                        "unknown broker argument '{arg}'"
                    )));
                }
            }
        }
        let bootstrap = parse_bootstrap(&bootstrap, initdb)?;
        let auth_token = env::var(ENV_BROKER_AUTH_TOKEN).map_err(|_| {
            oliphaunt::Error::InvalidConfig(format!("{ENV_BROKER_AUTH_TOKEN} is required"))
        })?;
        if auth_token.is_empty() {
            return Err(oliphaunt::Error::InvalidConfig(format!(
                "{ENV_BROKER_AUTH_TOKEN} must not be empty"
            )));
        }

        Ok(Self {
            root: root
                .ok_or_else(|| oliphaunt::Error::InvalidConfig("--root is required".to_owned()))?,
            endpoint,
            cancel_endpoint,
            bootstrap,
            durability,
            runtime_footprint,
            startup_gucs,
            username,
            database,
            extensions,
            auth_token,
        })
    }
}

fn parse_bootstrap(value: &str, initdb: Option<String>) -> oliphaunt::Result<BootstrapStrategy> {
    match value {
        "packaged-template" => {
            if initdb.is_some() {
                return Err(oliphaunt::Error::InvalidConfig(
                    "--initdb is only valid with --bootstrap initdb-tooling-only".to_owned(),
                ));
            }
            Ok(BootstrapStrategy::PackagedTemplate)
        }
        "existing-only" => {
            if initdb.is_some() {
                return Err(oliphaunt::Error::InvalidConfig(
                    "--initdb is only valid with --bootstrap initdb-tooling-only".to_owned(),
                ));
            }
            Ok(BootstrapStrategy::ExistingOnly)
        }
        "initdb-tooling-only" => {
            let initdb = initdb.ok_or_else(|| {
                oliphaunt::Error::InvalidConfig(
                    "--bootstrap initdb-tooling-only requires --initdb".to_owned(),
                )
            })?;
            Ok(BootstrapStrategy::InitdbToolingOnly {
                initdb: initdb.into(),
            })
        }
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown bootstrap strategy '{value}'"
        ))),
    }
}

fn parse_durability(value: &str) -> oliphaunt::Result<DurabilityProfile> {
    match value {
        "safe" => Ok(DurabilityProfile::Safe),
        "balanced" => Ok(DurabilityProfile::Balanced),
        "fast-dev" => Ok(DurabilityProfile::FastDev),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown durability profile '{value}'"
        ))),
    }
}

fn parse_runtime_footprint(value: &str) -> oliphaunt::Result<RuntimeFootprintProfile> {
    match value {
        "throughput" => Ok(RuntimeFootprintProfile::Throughput),
        "balanced-mobile" => Ok(RuntimeFootprintProfile::BalancedMobile),
        "small-mobile" => Ok(RuntimeFootprintProfile::SmallMobile),
        _ => Err(oliphaunt::Error::InvalidConfig(format!(
            "unknown runtime footprint profile '{value}'"
        ))),
    }
}

fn parse_startup_guc(value: &str) -> oliphaunt::Result<PostgresStartupGuc> {
    let Some((name, guc_value)) = value.split_once('=') else {
        return Err(oliphaunt::Error::InvalidConfig(
            "--startup-guc requires name=value".to_owned(),
        ));
    };
    Ok(PostgresStartupGuc::new(name, guc_value))
}

enum BrokerListenEndpoint {
    Tcp(String),
    #[cfg(unix)]
    Unix(std::path::PathBuf),
}

impl BrokerListenEndpoint {
    #[cfg(unix)]
    fn unix(path: impl Into<std::path::PathBuf>) -> oliphaunt::Result<Self> {
        Ok(Self::Unix(path.into()))
    }

    #[cfg(not(unix))]
    fn unix(_path: impl Into<std::path::PathBuf>) -> oliphaunt::Result<Self> {
        Err(oliphaunt::Error::InvalidConfig(
            "Unix-domain broker sockets are not supported on this platform".to_owned(),
        ))
    }
}

trait BrokerTransport: Read + Write {}

impl<T> BrokerTransport for T where T: Read + Write {}

enum BrokerListener {
    Tcp(TcpListener),
    #[cfg(unix)]
    Unix {
        listener: UnixListener,
        path: std::path::PathBuf,
    },
}

impl BrokerListener {
    fn bind(endpoint: BrokerListenEndpoint) -> oliphaunt::Result<Self> {
        match endpoint {
            BrokerListenEndpoint::Tcp(listen) => {
                TcpListener::bind(&listen).map(Self::Tcp).map_err(|err| {
                    oliphaunt::Error::Engine(format!("bind broker TCP listener {listen}: {err}"))
                })
            }
            #[cfg(unix)]
            BrokerListenEndpoint::Unix(path) => {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(|err| {
                        oliphaunt::Error::Engine(format!(
                            "remove stale broker socket {}: {err}",
                            path.display()
                        ))
                    })?;
                }
                UnixListener::bind(&path)
                    .map(|listener| Self::Unix { listener, path })
                    .map_err(|err| {
                        oliphaunt::Error::Engine(format!("bind broker Unix socket: {err}"))
                    })
            }
        }
    }

    fn ready_endpoint(&self) -> String {
        match self {
            Self::Tcp(listener) => listener
                .local_addr()
                .map(|addr| format!("tcp:{addr}"))
                .unwrap_or_else(|_| "tcp:<unknown>".to_owned()),
            #[cfg(unix)]
            Self::Unix { path, .. } => format!("unix:{}", path.display()),
        }
    }

    fn accept(&self) -> oliphaunt::Result<Box<dyn BrokerTransport>> {
        match self {
            Self::Tcp(listener) => listener
                .accept()
                .map(|(stream, _)| Box::new(stream) as Box<dyn BrokerTransport>)
                .map_err(|err| {
                    oliphaunt::Error::Engine(format!("accept broker TCP client: {err}"))
                }),
            #[cfg(unix)]
            Self::Unix { listener, path } => listener
                .accept()
                .map(|(stream, _)| Box::new(stream) as Box<dyn BrokerTransport>)
                .map_err(|err| {
                    oliphaunt::Error::Engine(format!(
                        "accept broker Unix client on {}: {err}",
                        path.display()
                    ))
                }),
        }
    }
}
