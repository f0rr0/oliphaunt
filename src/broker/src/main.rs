use std::env;
use std::error::Error as StdError;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::process;

use liboliphaunt_native_bindings::Extension;
mod server;

const ENV_BROKER_AUTH_TOKEN: &str = "OLIPHAUNT_BROKER_AUTH_TOKEN";
const DEFAULT_USERNAME: &str = "postgres";
const DEFAULT_DATABASE: &str = "postgres";

type BrokerResult<T> = std::result::Result<T, BrokerError>;

#[derive(Debug)]
enum BrokerError {
    Configuration(String),
    Runtime(String),
    Oliphaunt(liboliphaunt_native_bindings::Error),
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

impl From<liboliphaunt_native_bindings::Error> for BrokerError {
    fn from(error: liboliphaunt_native_bindings::Error) -> Self {
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
    let args = BrokerArgs::parse(env::args_os().skip(1).collect())?;
    server::serve(args).map_err(|error| BrokerError::runtime(error.to_string()))
}

struct BrokerArgs {
    root: std::path::PathBuf,
    endpoint: BrokerListenEndpoint,
    control_endpoint: BrokerListenEndpoint,
    startup_gucs: Vec<(String, String)>,
    username: String,
    database: String,
    extensions: Vec<Extension>,
    auth_token: String,
    seed: Option<liboliphaunt_native_bindings::NativeResourceDirectory>,
    icu_data: Option<liboliphaunt_native_bindings::NativeResourceDirectory>,
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
        let mut control_endpoint = BrokerListenEndpoint::Tcp("127.0.0.1:0".to_owned());
        let mut startup_gucs = Vec::new();
        let mut username = DEFAULT_USERNAME.to_owned();
        let mut database = DEFAULT_DATABASE.to_owned();
        let mut extensions = Vec::new();
        let mut seed_directory = None;
        let mut seed_manifest = None;
        let mut icu_directory = None;
        let mut icu_manifest = None;
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            let arg = arg.into_string().map_err(|_| {
                BrokerError::configuration("broker argument names must be valid UTF-8")
            })?;
            match arg.as_str() {
                "--seed-directory" => {
                    seed_directory =
                        Some(next_broker_arg(&mut iter, &arg, "a filesystem path")?.into())
                }
                "--seed-manifest" => {
                    seed_manifest =
                        Some(next_broker_arg(&mut iter, &arg, "a filesystem path")?.into())
                }
                "--icu-data-directory" => {
                    icu_directory =
                        Some(next_broker_arg(&mut iter, &arg, "a filesystem path")?.into())
                }
                "--icu-data-manifest" => {
                    icu_manifest =
                        Some(next_broker_arg(&mut iter, &arg, "a filesystem path")?.into())
                }
                "--root" => {
                    root = Some(next_broker_arg(&mut iter, "--root", "a filesystem path")?.into())
                }
                "--listen" => {
                    let listen = next_utf8_broker_arg(&mut iter, "--listen", "an address")?;
                    endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--control-listen" => {
                    let listen = next_utf8_broker_arg(&mut iter, "--control-listen", "an address")?;
                    control_endpoint = BrokerListenEndpoint::Tcp(listen);
                }
                "--socket" => {
                    let socket = next_broker_arg(&mut iter, "--socket", "a filesystem path")?;
                    endpoint = BrokerListenEndpoint::unix(socket)?;
                }
                "--control-socket" => {
                    let socket =
                        next_broker_arg(&mut iter, "--control-socket", "a filesystem path")?;
                    control_endpoint = BrokerListenEndpoint::unix(socket)?;
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
            control_endpoint,
            startup_gucs,
            username,
            database,
            extensions,
            auth_token,
            seed: resource_directory(seed_directory, seed_manifest, "seed")?,
            icu_data: resource_directory(icu_directory, icu_manifest, "ICU data")?,
        })
    }
}

fn resource_directory(
    directory: Option<std::path::PathBuf>,
    manifest: Option<std::path::PathBuf>,
    name: &str,
) -> BrokerResult<Option<liboliphaunt_native_bindings::NativeResourceDirectory>> {
    match (directory, manifest) {
        (None, None) => Ok(None),
        (Some(directory), Some(manifest)) => Ok(Some(
            liboliphaunt_native_bindings::NativeResourceDirectory {
                directory,
                manifest,
            },
        )),
        _ => Err(BrokerError::configuration(format!(
            "{name} requires both directory and manifest paths"
        ))),
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

    fn accept(&self) -> io::Result<server::Socket> {
        match self {
            Self::Tcp(listener) => listener
                .accept()
                .map(|(stream, _)| server::Socket::Tcp(stream)),
            #[cfg(unix)]
            Self::Unix { listener, .. } => listener
                .accept()
                .map(|(stream, _)| server::Socket::Unix(stream)),
        }
    }

    fn nonblocking(&self) -> io::Result<()> {
        match self {
            Self::Tcp(listener) => listener.set_nonblocking(true),
            #[cfg(unix)]
            Self::Unix { listener, .. } => listener.set_nonblocking(true),
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
