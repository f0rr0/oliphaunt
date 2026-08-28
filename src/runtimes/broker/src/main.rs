use std::env;
use std::error::Error as StdError;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::process;
use std::thread;

use oliphaunt::{__private as broker_support, Extension};

const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";
const DEFAULT_USERNAME: &str = "postgres";
const DEFAULT_DATABASE: &str = "postgres";

type BrokerResult<T> = std::result::Result<T, BrokerError>;

#[derive(Debug)]
enum BrokerError {
    Configuration(String),
    Runtime(String),
    Oliphaunt(oliphaunt::Error),
}

impl BrokerError {
    fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration(message.into())
    }

    fn runtime(message: impl Into<String>) -> Self {
        Self::Runtime(message.into())
    }
}

impl fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) | Self::Runtime(message) => formatter.write_str(message),
            Self::Oliphaunt(error) => error.fmt(formatter),
        }
    }
}

impl StdError for BrokerError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Oliphaunt(error) => Some(error),
            Self::Configuration(_) | Self::Runtime(_) => None,
        }
    }
}

impl From<oliphaunt::Error> for BrokerError {
    fn from(error: oliphaunt::Error) -> Self {
        Self::Oliphaunt(error)
    }
}

fn main() {
    if let Err(error) = run() {
        println!("OLIPHAUNT_BROKER_ERROR {error}");
        process::exit(2);
    }
}

fn run() -> BrokerResult<()> {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let args = BrokerArgs::parse(args)?;
    let mut session = broker_support::open(
        args.root,
        args.startup_gucs,
        Some(args.username),
        Some(args.database),
        args.extensions,
    )?;
    let cancel = session.cancel_handle()?;
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
        .map_err(|err| BrokerError::runtime(format!("flush broker ready line: {err}")))?;

    let mut stream = listener.accept()?;
    authenticate_client(&mut stream, &args.auth_token)?;
    loop {
        let request = broker_support::broker_ipc_read_request(&mut stream)?;
        match request {
            broker_support::BrokerIpcRequest::Authenticate(_) => {
                broker_support::broker_ipc_write_error(
                    &mut stream,
                    "broker client is already authenticated".to_owned(),
                )?;
                break;
            }
            broker_support::BrokerIpcRequest::ExecProtocol(bytes) => {
                write_broker_response(&mut stream, session.exec_protocol_raw(bytes))?;
            }
            broker_support::BrokerIpcRequest::ExecProtocolStream(bytes) => {
                let result = session.exec_protocol_raw_stream(bytes, &mut |chunk| {
                    broker_support::broker_ipc_write_chunk(&mut stream, chunk)
                });
                match result {
                    broker_support::BrokerStreamOutcome::ReadyForQuery(Ok(())) => {
                        broker_support::broker_ipc_write_ok(&mut stream, Vec::new())?
                    }
                    broker_support::BrokerStreamOutcome::ReadyForQuery(Err(error)) => {
                        broker_support::broker_ipc_write_stream_callback_aborted(
                            &mut stream,
                            error.to_string(),
                        )?
                    }
                    broker_support::BrokerStreamOutcome::SessionStateUnknown(error) => {
                        broker_support::broker_ipc_write_error(&mut stream, error.to_string())?
                    }
                }
            }
            broker_support::BrokerIpcRequest::ExecSimpleQuery(sql) => {
                write_broker_response(&mut stream, session.execute(&sql))?;
            }
            broker_support::BrokerIpcRequest::Backup => {
                write_broker_response(&mut stream, session.backup())?;
            }
            broker_support::BrokerIpcRequest::Cancel => {
                broker_support::broker_ipc_write_error(
                    &mut stream,
                    "broker cancellation must use the cancel endpoint".to_owned(),
                )?;
            }
            broker_support::BrokerIpcRequest::Close => {
                let result = session.close().map(|()| Vec::new());
                write_broker_response(&mut stream, result)?;
                break;
            }
        }
    }
    Ok(())
}

fn start_cancel_listener(
    listener: BrokerListener,
    cancel: broker_support::BrokerCancel,
    expected_token: String,
) {
    thread::Builder::new()
        .name("oliphaunt-broker-cancel".to_owned())
        .spawn(move || {
            loop {
                match listener.accept() {
                    Ok(mut stream) => {
                        if let Err(error) =
                            handle_cancel_client(&mut stream, &cancel, &expected_token)
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
    cancel: &broker_support::BrokerCancel,
    expected_token: &str,
) -> BrokerResult<()> {
    authenticate_client(stream, expected_token)?;
    match broker_support::broker_ipc_read_request(stream)? {
        broker_support::BrokerIpcRequest::Cancel => {
            write_broker_response(stream, cancel.cancel().map(|()| Vec::new()))?
        }
        broker_support::BrokerIpcRequest::Authenticate(_) => {
            broker_support::broker_ipc_write_error(
                stream,
                "broker cancel client is already authenticated".to_owned(),
            )?
        }
        _ => broker_support::broker_ipc_write_error(
            stream,
            "broker cancel endpoint only accepts cancellation requests".to_owned(),
        )?,
    }
    Ok(())
}

fn authenticate_client(
    stream: &mut Box<dyn BrokerTransport>,
    expected_token: &str,
) -> BrokerResult<()> {
    match broker_support::broker_ipc_read_request(stream)? {
        broker_support::BrokerIpcRequest::Authenticate(token) if token == expected_token => {
            broker_support::broker_ipc_write_ok(stream, Vec::new())?;
            Ok(())
        }
        broker_support::BrokerIpcRequest::Authenticate(_) => {
            broker_support::broker_ipc_write_error(
                stream,
                "invalid broker authentication token".to_owned(),
            )?;
            Err(BrokerError::runtime("invalid broker authentication token"))
        }
        _ => {
            broker_support::broker_ipc_write_error(
                stream,
                "broker client must authenticate before sending requests".to_owned(),
            )?;
            Err(BrokerError::runtime("broker client did not authenticate"))
        }
    }
}

fn write_broker_response(
    stream: &mut impl Write,
    result: oliphaunt::Result<Vec<u8>>,
) -> BrokerResult<()> {
    match result {
        Ok(bytes) => broker_support::broker_ipc_write_ok(stream, bytes)?,
        Err(error) => broker_support::broker_ipc_write_error(stream, error.to_string())?,
    }
    Ok(())
}

struct BrokerArgs {
    root: std::path::PathBuf,
    endpoint: BrokerListenEndpoint,
    cancel_endpoint: BrokerListenEndpoint,
    startup_gucs: Vec<(String, String)>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
    auth_token: String,
}

impl BrokerArgs {
    fn parse(args: Vec<OsString>) -> BrokerResult<Self> {
        let auth_token = env::var(ENV_BROKER_AUTH_TOKEN).map_err(|_| {
            BrokerError::configuration(format!("{ENV_BROKER_AUTH_TOKEN} is required"))
        })?;
        Self::parse_with_auth_token(args, auth_token)
    }

    fn parse_with_auth_token(args: Vec<OsString>, auth_token: String) -> BrokerResult<Self> {
        let mut root = None;
        let mut endpoint = BrokerListenEndpoint::Tcp("127.0.0.1:0".to_owned());
        let mut cancel_endpoint = BrokerListenEndpoint::Tcp("127.0.0.1:0".to_owned());
        let mut startup_gucs = Vec::new();
        let mut username = DEFAULT_USERNAME.to_owned();
        let mut database = DEFAULT_DATABASE.to_owned();
        let mut extensions = Vec::new();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            let arg = arg.into_string().map_err(|_| {
                BrokerError::configuration("broker argument names must be valid UTF-8")
            })?;
            match arg.as_str() {
                "--root" => {
                    root = Some(next_broker_arg(&mut iter, "--root", "a filesystem path")?.into())
                }
                "--listen" => {
                    let listen = next_utf8_broker_arg(&mut iter, "--listen", "an address")?;
                    endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--cancel-listen" => {
                    let listen = next_utf8_broker_arg(&mut iter, "--cancel-listen", "an address")?;
                    cancel_endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--socket" => {
                    let socket = next_broker_arg(&mut iter, "--socket", "a filesystem path")?;
                    endpoint = BrokerListenEndpoint::unix(socket)?;
                }
                "--cancel-socket" => {
                    let socket =
                        next_broker_arg(&mut iter, "--cancel-socket", "a filesystem path")?;
                    cancel_endpoint = BrokerListenEndpoint::unix(socket)?;
                }
                "--startup-guc" => {
                    let assignment =
                        next_utf8_broker_arg(&mut iter, "--startup-guc", "name=value")?;
                    startup_gucs.push(parse_startup_guc(&assignment)?);
                }
                "--username" => {
                    username = next_utf8_broker_arg(&mut iter, "--username", "a PostgreSQL role")?;
                }
                "--database" => {
                    database = next_utf8_broker_arg(
                        &mut iter,
                        "--database",
                        "a PostgreSQL database name",
                    )?;
                }
                "--extension" => {
                    let sql_name =
                        next_utf8_broker_arg(&mut iter, "--extension", "a SQL extension name")?;
                    let extension = Extension::by_sql_name(&sql_name).ok_or_else(|| {
                        BrokerError::configuration(format!(
                            "unsupported native extension '{sql_name}'"
                        ))
                    })?;
                    extensions.push(extension);
                }
                _ => {
                    return Err(BrokerError::configuration(format!(
                        "unknown broker argument '{arg}'"
                    )));
                }
            }
        }
        if auth_token.is_empty() {
            return Err(BrokerError::configuration(format!(
                "{ENV_BROKER_AUTH_TOKEN} must not be empty"
            )));
        }

        Ok(Self {
            root: root.ok_or_else(|| BrokerError::configuration("--root is required"))?,
            endpoint,
            cancel_endpoint,
            startup_gucs,
            username,
            database,
            extensions,
            auth_token,
        })
    }
}

fn next_broker_arg(
    iter: &mut impl Iterator<Item = OsString>,
    option: &str,
    expected: &str,
) -> BrokerResult<OsString> {
    iter.next()
        .ok_or_else(|| BrokerError::configuration(format!("{option} requires {expected}")))
}

fn next_utf8_broker_arg(
    iter: &mut impl Iterator<Item = OsString>,
    option: &str,
    expected: &str,
) -> BrokerResult<String> {
    next_broker_arg(iter, option, expected)?
        .into_string()
        .map_err(|_| {
            BrokerError::configuration(format!(
                "{option} requires {expected} encoded as valid UTF-8"
            ))
        })
}

fn parse_startup_guc(value: &str) -> BrokerResult<(String, String)> {
    let Some((name, guc_value)) = value.split_once('=') else {
        return Err(BrokerError::configuration(
            "--startup-guc requires name=value",
        ));
    };
    Ok((name.to_owned(), guc_value.to_owned()))
}

enum BrokerListenEndpoint {
    Tcp(String),
    #[cfg(unix)]
    Unix(std::path::PathBuf),
}

impl BrokerListenEndpoint {
    #[cfg(unix)]
    fn unix(path: impl Into<std::path::PathBuf>) -> BrokerResult<Self> {
        Ok(Self::Unix(path.into()))
    }

    #[cfg(not(unix))]
    fn unix(_path: impl Into<std::path::PathBuf>) -> BrokerResult<Self> {
        Err(BrokerError::configuration(
            "Unix-domain broker sockets are not supported on this platform",
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
    fn bind(endpoint: BrokerListenEndpoint) -> BrokerResult<Self> {
        match endpoint {
            BrokerListenEndpoint::Tcp(listen) => {
                TcpListener::bind(&listen).map(Self::Tcp).map_err(|err| {
                    BrokerError::runtime(format!("bind broker TCP listener {listen}: {err}"))
                })
            }
            #[cfg(unix)]
            BrokerListenEndpoint::Unix(path) => {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(|err| {
                        BrokerError::runtime(format!(
                            "remove stale broker socket {}: {err}",
                            path.display()
                        ))
                    })?;
                }
                UnixListener::bind(&path)
                    .map(|listener| Self::Unix { listener, path })
                    .map_err(|err| BrokerError::runtime(format!("bind broker Unix socket: {err}")))
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

    fn accept(&self) -> BrokerResult<Box<dyn BrokerTransport>> {
        match self {
            Self::Tcp(listener) => listener
                .accept()
                .map(|(stream, _)| Box::new(stream) as Box<dyn BrokerTransport>)
                .map_err(|err| BrokerError::runtime(format!("accept broker TCP client: {err}"))),
            #[cfg(unix)]
            Self::Unix { listener, path } => listener
                .accept()
                .map(|(stream, _)| Box::new(stream) as Box<dyn BrokerTransport>)
                .map_err(|err| {
                    BrokerError::runtime(format!(
                        "accept broker Unix client on {}: {err}",
                        path.display()
                    ))
                }),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::ffi::OsStringExt;
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn broker_arguments_preserve_non_utf8_database_roots() {
        let root = PathBuf::from(OsString::from_vec(
            b"/tmp/oliphaunt-broker-root-\xff".to_vec(),
        ));
        let args = vec![OsString::from("--root"), root.clone().into_os_string()];

        let parsed = BrokerArgs::parse_with_auth_token(args, "test-token".to_owned())
            .expect("non-UTF-8 filesystem paths remain valid broker roots");

        assert_eq!(parsed.root, root);
    }
}
