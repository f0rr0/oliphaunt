use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;

use liboliphaunt_native_bindings::{
    DatabaseStorage, NativeConfig, NativeProtocolInput, NativeSession, PostgresStartupGuc,
    ProtocolStreamOutcome,
};
use oliphaunt_broker::ipc::{self, RequestFrame, ResponseFrame};
use oliphaunt_query::{ExpectedProtocol, parse_query_response, wire};

use crate::{BrokerArgs, BrokerListener};

pub(super) enum Socket {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

macro_rules! socket_call {
    ($self:expr, $method:ident $(, $arg:expr)*) => {
        match $self {
            Socket::Tcp(stream) => stream.$method($($arg),*),
            #[cfg(unix)]
            Socket::Unix(stream) => stream.$method($($arg),*),
        }
    };
}

impl Socket {
    fn clone_socket(&self) -> io::Result<Self> {
        match self {
            Self::Tcp(stream) => stream.try_clone().map(Self::Tcp),
            #[cfg(unix)]
            Self::Unix(stream) => stream.try_clone().map(Self::Unix),
        }
    }
    fn shutdown(&self) {
        let _ = socket_call!(self, shutdown, Shutdown::Both);
    }
    fn read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        socket_call!(self, set_read_timeout, timeout)
    }
    fn write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        socket_call!(self, set_write_timeout, timeout)
    }
}
impl Read for Socket {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        socket_call!(self, read, bytes)
    }
}
impl Write for Socket {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        socket_call!(self, write, bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        socket_call!(self, flush)
    }
}

type Reply<T> = mpsc::Sender<io::Result<T>>;
enum Command {
    Startup(String, Reply<Vec<u8>>),
    Execute(Vec<u8>, Socket, Reply<()>),
    Reset(Reply<()>),
    Backup(Reply<Vec<u8>>),
    Shutdown(Reply<()>),
}

struct Shared {
    commands: mpsc::SyncSender<Command>,
    native: Mutex<(
        liboliphaunt_native_bindings::NativeCancel,
        NativeProtocolInput,
    )>,
    closing: AtomicBool,
    executing: AtomicBool,
    stopping: AtomicBool,
    occupied: AtomicBool,
    owner_connected: AtomicBool,
    connection_count: AtomicUsize,
    active: Mutex<Option<(Socket, [u8; 8])>>,
    password: String,
    username: String,
    database: String,
}

fn other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

pub(super) fn serve(args: BrokerArgs) -> io::Result<()> {
    let config = NativeConfig {
        storage: DatabaseStorage::Directory(args.root),
        startup_gucs: args
            .startup_gucs
            .into_iter()
            .map(|(key, value)| PostgresStartupGuc::new(key, value))
            .collect(),
        username: args.username.clone(),
        database: args.database.clone(),
        extensions: args.extensions,
        seed: args
            .seed
            .map(liboliphaunt_native_bindings::NativeClusterSeed::Directory),
        icu_data: args.icu_data,
    };
    let session = NativeSession::open(config.clone()).map_err(other)?;
    let sql = BrokerListener::bind(args.endpoint).map_err(other)?;
    let control = BrokerListener::bind(args.control_endpoint).map_err(other)?;
    sql.nonblocking()?;
    control.nonblocking()?;
    let (commands, receiver) = mpsc::sync_channel(1);
    let shared = Arc::new(Shared {
        commands,
        native: Mutex::new((
            session.cancel_handle(),
            session.protocol_input().map_err(other)?,
        )),
        closing: AtomicBool::new(false),
        executing: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
        occupied: AtomicBool::new(false),
        owner_connected: AtomicBool::new(false),
        connection_count: AtomicUsize::new(0),
        active: Mutex::new(None),
        password: args.auth_token,
        username: args.username,
        database: args.database,
    });
    let worker_state = Arc::clone(&shared);
    let worker = thread::Builder::new()
        .name("oliphaunt-broker-backend".into())
        .spawn(move || run_backend(session, config, receiver, &worker_state))?;
    println!(
        "OLIPHAUNT_BROKER_READY {} control={}",
        sql.ready_endpoint(),
        control.ready_endpoint()
    );
    io::stdout().flush()?;
    while !shared.stopping.load(Ordering::Acquire) {
        for (listener, management) in [(&control, true), (&sql, false)] {
            match listener.accept() {
                Ok(socket) => {
                    if shared.connection_count.fetch_add(1, Ordering::AcqRel) >= 16 {
                        shared.connection_count.fetch_sub(1, Ordering::AcqRel);
                        socket.shutdown();
                        continue;
                    }
                    let state = Arc::clone(&shared);
                    thread::Builder::new()
                        .name("oliphaunt-broker-client".into())
                        .spawn(move || {
                            let result = if management {
                                management_client(socket, &state)
                            } else {
                                sql_client(socket, &state)
                            };
                            if let Err(error) = result
                                && !matches!(
                                    error.kind(),
                                    io::ErrorKind::UnexpectedEof
                                        | io::ErrorKind::ConnectionReset
                                        | io::ErrorKind::BrokenPipe
                                        | io::ErrorKind::ConnectionAborted
                                )
                            {
                                eprintln!("OLIPHAUNT_BROKER_CLIENT_ERROR {error}");
                            }
                            state.connection_count.fetch_sub(1, Ordering::AcqRel);
                        })?;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    stop(&shared);
                    return Err(error);
                }
            }
        }
        thread::sleep(Duration::from_millis(2));
    }
    stop(&shared);
    let (reply, done) = mpsc::channel();
    let _ = shared.commands.send(Command::Shutdown(reply));
    let _ = done.recv();
    worker
        .join()
        .map_err(|_| other("broker backend panicked"))?
}

fn stop(shared: &Shared) {
    shared.closing.store(true, Ordering::Release);
    shared.stopping.store(true, Ordering::Release);
    cancel_execution(shared);
    if let Some((socket, _)) = shared.active.lock().unwrap().as_ref() {
        socket.shutdown();
    }
}

fn cancel_execution(shared: &Shared) {
    if shared.executing.load(Ordering::Acquire) {
        let cancel = shared.native.lock().unwrap().0.clone();
        let _ = cancel.cancel();
    }
}

fn run_backend(
    mut session: NativeSession,
    config: NativeConfig,
    receiver: mpsc::Receiver<Command>,
    shared: &Shared,
) -> io::Result<()> {
    for command in receiver {
        match command {
            Command::Startup(application, reply) => {
                let _ = reply.send(startup_parameters(&mut session, &application));
            }
            Command::Execute(request, mut socket, reply) => {
                if shared.closing.load(Ordering::Acquire) {
                    shared.executing.store(false, Ordering::Release);
                    let _ = reply.send(Err(other("broker is closing")));
                    continue;
                }
                let outcome = session.exec_protocol_raw_stream(&request, &mut |bytes| {
                    socket.write_all(bytes).map_err(|error| {
                        liboliphaunt_native_bindings::Error::Engine(error.to_string())
                    })
                });
                let result = match outcome {
                    ProtocolStreamOutcome::ReadyForQuery(Ok(())) => Ok(()),
                    ProtocolStreamOutcome::ReadyForQuery(Err(error))
                    | ProtocolStreamOutcome::SessionStateUnknown(error) => Err(other(error)),
                };
                shared.executing.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
            Command::Reset(reply) => {
                if shared.closing.load(Ordering::Acquire) {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                let result = session
                    .close()
                    .and_then(|()| NativeSession::open(config.clone()))
                    .and_then(|next| {
                        *shared.native.lock().unwrap() =
                            (next.cancel_handle(), next.protocol_input()?);
                        session = next;
                        Ok(())
                    })
                    .map_err(other);
                if result.is_err() {
                    stop(shared);
                }
                let _ = reply.send(result);
            }
            Command::Backup(reply) => {
                let _ = reply.send(session.backup().map_err(other));
            }
            Command::Shutdown(reply) => {
                let result = session.close_terminal().map_err(other);
                let failed = result.is_err();
                let _ = reply.send(result);
                return if failed {
                    Err(other("native terminal shutdown failed"))
                } else {
                    Ok(())
                };
            }
        }
    }
    session.close_terminal().map_err(other)
}

fn startup_parameters(session: &mut NativeSession, application: &str) -> io::Result<Vec<u8>> {
    let request = oliphaunt_query::extended_statement(
        "SELECT set_config('application_name', $1, false)",
        &[oliphaunt_query::Parameter::text(application)],
        0,
    )
    .map_err(other)?;
    parse_query_response(
        &session.exec_protocol_raw(&request).map_err(other)?,
        ExpectedProtocol::Extended,
    )
    .map_err(other)?;
    let bytes = session.exec_simple_query("SELECT name, setting FROM pg_settings WHERE name IN ('server_version','server_encoding','client_encoding','application_name','DateStyle','IntervalStyle','TimeZone','integer_datetimes','standard_conforming_strings')").map_err(other)?;
    let result = parse_query_response(&bytes, ExpectedProtocol::Simple).map_err(other)?;
    let mut response = backend_frame(b'R', &0_i32.to_be_bytes());
    for index in 0..result.rows().len() {
        let name = result
            .get_text(index, "name")
            .map_err(other)?
            .ok_or_else(|| other("null parameter name"))?;
        let value = result
            .get_text(index, "setting")
            .map_err(other)?
            .ok_or_else(|| other("null parameter setting"))?;
        response.extend(backend_frame(b'S', format!("{name}\0{value}\0").as_bytes()));
    }
    Ok(response)
}

fn management_client(mut socket: Socket, shared: &Shared) -> io::Result<()> {
    socket.read_timeout(Some(Duration::from_secs(5)))?;
    socket.write_timeout(Some(Duration::from_secs(5)))?;
    match ipc::read_request(&mut socket).map_err(other)? {
        RequestFrame::Authenticate(token) if token == shared.password => {}
        _ => {
            ipc::write_response(
                &mut socket,
                ResponseFrame::Error("invalid broker authentication token".into()),
            )
            .map_err(other)?;
            return Ok(());
        }
    }
    if shared.owner_connected.swap(true, Ordering::AcqRel) {
        ipc::write_response(
            &mut socket,
            ResponseFrame::Error("broker already has an owner".into()),
        )
        .map_err(other)?;
        return Ok(());
    }
    let result = (|| {
        ipc::write_response(&mut socket, ResponseFrame::Ok(Vec::new())).map_err(other)?;
        socket.read_timeout(None)?;
        loop {
            let command = ipc::read_request(&mut socket).map_err(other)?;
            match command {
                RequestFrame::Backup => {
                    let (reply, done) = mpsc::channel();
                    shared
                        .commands
                        .send(Command::Backup(reply))
                        .map_err(other)?;
                    let response = match done.recv().map_err(other)? {
                        Ok(bytes) => ResponseFrame::Ok(bytes),
                        Err(error) => ResponseFrame::Error(error.to_string()),
                    };
                    ipc::write_response(&mut socket, response).map_err(other)?;
                }
                RequestFrame::Close => {
                    shared.closing.store(true, Ordering::Release);
                    cancel_execution(shared);
                    if let Some((active, _)) = shared.active.lock().unwrap().as_ref() {
                        active.shutdown();
                    }
                    let (reply, done) = mpsc::channel();
                    shared
                        .commands
                        .send(Command::Shutdown(reply))
                        .map_err(other)?;
                    let response = match done.recv().map_err(other)? {
                        Ok(()) => ResponseFrame::Ok(Vec::new()),
                        Err(error) => ResponseFrame::Error(error.to_string()),
                    };
                    ipc::write_response(&mut socket, response).map_err(other)?;
                    return Ok(());
                }
                _ => return Err(other("management accepts only backup or shutdown")),
            }
        }
    })();
    stop(shared);
    result
}

fn sql_client(mut socket: Socket, shared: &Shared) -> io::Result<()> {
    socket.read_timeout(Some(Duration::from_secs(5)))?;
    socket.write_timeout(Some(Duration::from_secs(5)))?;
    let mut startup = read_startup(&mut socket)?;
    while matches!(
        wire::classify_frontend_message(&startup)?,
        wire::FrontendFrameKind::SslOrGssRequest
    ) {
        if startup.len() != 8 {
            return Err(other("invalid encryption request"));
        }
        socket.write_all(b"N")?;
        startup = read_startup(&mut socket)?;
    }
    if wire::classify_frontend_message(&startup)? == wire::FrontendFrameKind::CancelRequest {
        if startup.len() != 16 {
            return Err(other("invalid CancelRequest length"));
        }
        let active = shared.active.lock().unwrap();
        if let Some((_, key)) = active.as_ref()
            && startup[8..] == *key
        {
            let cancel = shared.native.lock().unwrap().0.clone();
            if shared.executing.load(Ordering::Acquire) {
                cancel.cancel().map_err(other)?;
            }
        }
        return Ok(());
    }
    let parameters = wire::startup_parameters(&startup)?;
    if parameters.get("user").copied() != Some(shared.username.as_str())
        || parameters
            .get("database")
            .copied()
            .unwrap_or(&shared.username)
            != shared.database
    {
        socket.write_all(&wire::error_response(
            "FATAL",
            "28000",
            "broker user or database does not match",
        ))?;
        return Ok(());
    }
    for (key, value) in &parameters {
        if !matches!(
            *key,
            "user" | "database" | "application_name" | "client_encoding"
        ) || (*key == "client_encoding"
            && !value.eq_ignore_ascii_case("UTF8")
            && !value.eq_ignore_ascii_case("UTF-8"))
        {
            socket.write_all(&wire::error_response(
                "FATAL",
                "0A000",
                "unsupported broker startup parameter",
            ))?;
            return Ok(());
        }
    }
    socket.write_all(&backend_frame(b'R', &3_i32.to_be_bytes()))?;
    let password = read_frontend(&mut socket)?;
    if password.first() != Some(&b'p')
        || password.get(5..) != Some(format!("{}\0", shared.password).as_bytes())
    {
        socket.write_all(&wire::error_response(
            "FATAL",
            "28P01",
            "invalid broker password",
        ))?;
        return Ok(());
    }
    if shared.occupied.swap(true, Ordering::AcqRel) {
        socket.write_all(&wire::error_response(
            "FATAL",
            "53300",
            "broker already has an active SQL connection",
        ))?;
        return Ok(());
    }
    let result = connected_sql(
        &mut socket,
        shared,
        parameters.get("application_name").copied().unwrap_or(""),
    );
    shared.active.lock().unwrap().take();
    let (reply, done) = mpsc::channel();
    if shared.commands.send(Command::Reset(reply)).is_ok() {
        let _ = done.recv();
    }
    shared.occupied.store(false, Ordering::Release);
    result
}

fn connected_sql(socket: &mut Socket, shared: &Shared, application: &str) -> io::Result<()> {
    let (reply, done) = mpsc::channel();
    shared
        .commands
        .send(Command::Startup(application.to_owned(), reply))
        .map_err(other)?;
    let mut response = done.recv().map_err(other)??;
    let mut key = [0; 8];
    key[..4].copy_from_slice(&std::process::id().to_be_bytes());
    getrandom::fill(&mut key[4..]).map_err(other)?;
    response.extend(backend_frame(b'K', &key));
    response.extend(backend_frame(b'Z', b"I"));
    *shared.active.lock().unwrap() = Some((socket.clone_socket()?, key));
    socket.write_all(&response)?;
    socket.read_timeout(None)?;
    let result = exchange(socket, shared);
    if result.is_err() {
        cancel_execution(shared);
        socket.shutdown();
    }
    result
}

fn exchange(socket: &mut Socket, shared: &Shared) -> io::Result<()> {
    let mut running: Option<mpsc::Receiver<io::Result<()>>> = None;
    let mut closed_input = false;
    let result = (|| {
        loop {
            let frame = read_frontend(socket)?;
            let tag = frame[0];
            if tag == b'X' {
                if frame.len() != 5 {
                    return Err(other("invalid Terminate frame"));
                }
                return Ok(());
            }
            if let Some(done) = running.as_ref() {
                match done.try_recv() {
                    Ok(result) => {
                        result?;
                        running = None;
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(other("native worker stopped"));
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            if closed_input
                && !matches!(tag, b'd' | b'c' | b'f')
                && let Some(done) = running.take()
            {
                done.recv().map_err(other)??;
            }
            if running.is_none() {
                let (reply, done) = mpsc::channel();
                shared.executing.store(true, Ordering::Release);
                shared
                    .commands
                    .send(Command::Execute(frame, socket.clone_socket()?, reply))
                    .map_err(other)?;
                running = Some(done);
            } else {
                loop {
                    if shared.stopping.load(Ordering::Acquire) {
                        return Err(other("broker shutting down"));
                    }
                    let input = shared.native.lock().unwrap().1.clone();
                    if let Some(token) = input.active_token().map_err(other)?
                        && input.feed(token, &frame).map_err(other)?
                    {
                        break;
                    }
                    if let Some(done) = running.as_ref() {
                        match done.try_recv() {
                            Ok(result) => {
                                result?;
                                return Err(other(
                                    "protocol stream completed before input was accepted",
                                ));
                            }
                            Err(mpsc::TryRecvError::Disconnected) => {
                                return Err(other("native worker stopped"));
                            }
                            Err(mpsc::TryRecvError::Empty) => {}
                        }
                    }
                    thread::sleep(Duration::from_millis(1));
                }
            }
            closed_input = matches!(tag, b'Q' | b'S' | b'c' | b'f');
        }
    })();
    if let Some(done) = running {
        cancel_execution(shared);
        socket.shutdown();
        if matches!(
            done.recv_timeout(Duration::from_secs(3)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            // A disconnected peer can abandon Parse/Flush or COPY before its
            // completion frame. Cancellation cannot manufacture that missing
            // protocol input. Retire the helper instead of replaying a query,
            // inventing Sync, or leaving native close blocked indefinitely.
            eprintln!(
                "OLIPHAUNT_BROKER_ERROR disconnected protocol stream did not drain; reopen the database"
            );
            std::process::exit(2);
        }
    }
    result
}

fn read_startup(socket: &mut Socket) -> io::Result<Vec<u8>> {
    let mut header = [0; 4];
    socket.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if !(8..=10_000).contains(&length) {
        return Err(other("invalid PostgreSQL startup length"));
    }
    let mut frame = vec![0; length];
    frame[..4].copy_from_slice(&header);
    socket.read_exact(&mut frame[4..])?;
    Ok(frame)
}

fn read_frontend(socket: &mut Socket) -> io::Result<Vec<u8>> {
    let mut header = [0; 5];
    socket.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if !(4..wire::MAX_FRONTEND_MESSAGE).contains(&length) {
        return Err(other("invalid frontend frame length"));
    }
    let mut frame = vec![0; length + 1];
    frame[..5].copy_from_slice(&header);
    socket.read_exact(&mut frame[5..])?;
    Ok(frame)
}

fn backend_frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut frame = vec![tag];
    frame.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    frame.extend_from_slice(body);
    frame
}
