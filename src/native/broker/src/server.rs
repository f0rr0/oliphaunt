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
use std::time::{Duration, Instant};

use liboliphaunt_native_bindings::{
    DatabaseStorage, NativeConfig, NativeProtocolInput, NativeSession, PostgresStartupGuc,
    ProtocolInputStatus, ProtocolStreamOutcome,
};
use oliphaunt_broker::exchange::{self as framed, Completion, Epoch, Execution, Kind, Reason};
use oliphaunt_broker::ipc::{self, RequestFrame, ResponseFrame};
use oliphaunt_query::{ExpectedProtocol, parse_query_response, wire};

use crate::{BrokerArgs, BrokerListener};

pub(super) struct Socket {
    inner: SocketStream,
    deadline: Option<Instant>,
    handshake: Option<PendingHandshake>,
}

struct PendingHandshake(Arc<AtomicUsize>);

impl PendingHandshake {
    fn acquire(count: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < limit).then_some(value + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(count)))
    }
}

impl Drop for PendingHandshake {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

enum SocketStream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

macro_rules! socket_call {
    ($self:expr, $method:ident $(, $arg:expr)*) => {
        match &$self.inner {
            SocketStream::Tcp(stream) => stream.$method($($arg),*),
            #[cfg(unix)]
            SocketStream::Unix(stream) => stream.$method($($arg),*),
        }
    };
}

impl Socket {
    pub(super) fn tcp(stream: TcpStream) -> Self {
        Self {
            inner: SocketStream::Tcp(stream),
            deadline: None,
            handshake: None,
        }
    }

    #[cfg(unix)]
    pub(super) fn unix(stream: UnixStream) -> Self {
        Self {
            inner: SocketStream::Unix(stream),
            deadline: None,
            handshake: None,
        }
    }

    fn clone_socket(&self) -> io::Result<Self> {
        let inner = match &self.inner {
            SocketStream::Tcp(stream) => SocketStream::Tcp(stream.try_clone()?),
            #[cfg(unix)]
            SocketStream::Unix(stream) => SocketStream::Unix(stream.try_clone()?),
        };
        Ok(Self {
            inner,
            deadline: self.deadline,
            handshake: None,
        })
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

    fn set_deadline(&mut self, deadline: Option<Instant>) -> io::Result<()> {
        if deadline.is_none() {
            self.read_timeout(None)?;
            self.write_timeout(None)?;
            self.handshake.take();
        }
        self.deadline = deadline;
        Ok(())
    }

    fn remaining(deadline: Instant) -> io::Result<Duration> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "broker handshake deadline exceeded",
            ))
        } else {
            Ok(remaining)
        }
    }
}

#[cfg(all(test, unix))]
impl std::os::fd::AsRawFd for Socket {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        socket_call!(self, as_raw_fd)
    }
}
impl Read for Socket {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if let Some(deadline) = self.deadline {
            self.read_timeout(Some(Self::remaining(deadline)?))?;
        }
        match &mut self.inner {
            SocketStream::Tcp(stream) => stream.read(bytes),
            #[cfg(unix)]
            SocketStream::Unix(stream) => stream.read(bytes),
        }
    }
}
impl Write for Socket {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(deadline) = self.deadline {
            self.write_timeout(Some(Self::remaining(deadline)?))?;
        }
        match &mut self.inner {
            SocketStream::Tcp(stream) => stream.write(bytes),
            #[cfg(unix)]
            SocketStream::Unix(stream) => stream.write(bytes),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

type Reply<T> = mpsc::Sender<io::Result<T>>;
enum Command {
    Startup(Option<String>, Reply<Vec<u8>>),
    Execute(Vec<u8>, Socket, mpsc::Sender<io::Result<u64>>, Reply<()>),
    Exchange {
        input_len: usize,
        epoch: Epoch,
        request: u64,
        socket: Socket,
        input_done: mpsc::Receiver<io::Result<()>>,
        started: mpsc::Sender<io::Result<u64>>,
        finished: Arc<AtomicBool>,
        reply: Reply<()>,
    },
    Reset(Reply<()>),
    Backup(Reply<Vec<u8>>),
    BackupStream(Socket, Reply<()>),
    Shutdown(Reply<()>),
}

struct FramedSession {
    epoch: Epoch,
    completed: u64,
    active: Option<u64>,
    native_started: bool,
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
    recovery_timeout: Duration,
    active: Mutex<Option<(Socket, [u8; 8])>>,
    framed: Mutex<Option<FramedSession>>,
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
        recovery_timeout: args.recovery_timeout,
        active: Mutex::new(None),
        framed: Mutex::new(None),
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
    let sql_handshakes = Arc::new(AtomicUsize::new(0));
    let control_handshakes = Arc::new(AtomicUsize::new(0));
    while !shared.stopping.load(Ordering::Acquire) {
        for (listener, management) in [(&control, true), (&sql, false)] {
            match listener.accept() {
                Ok(mut socket) => {
                    socket.set_deadline(Some(Instant::now() + args.handshake_timeout))?;
                    let count = if management {
                        &control_handshakes
                    } else {
                        &sql_handshakes
                    };
                    let Some(permit) =
                        PendingHandshake::acquire(count, args.max_pending_handshakes)
                    else {
                        socket.shutdown();
                        continue;
                    };
                    socket.handshake = Some(permit);
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
                let _ = reply.send(startup_parameters(&mut session, application.as_deref()));
            }
            Command::Execute(request, mut socket, started, reply) => {
                if shared.closing.load(Ordering::Acquire) {
                    shared.executing.store(false, Ordering::Release);
                    let _ = reply.send(Err(other("broker is closing")));
                    continue;
                }
                let mut started = Some(started);
                let outcome = session.exec_protocol_raw_stream_started(
                    &request,
                    &mut |token| {
                        started.take().unwrap().send(Ok(token)).map_err(|_| {
                            liboliphaunt_native_bindings::Error::Engine(
                                "protocol input reader stopped".into(),
                            )
                        })
                    },
                    &mut |bytes| {
                        socket.write_all(bytes).map_err(|error| {
                            liboliphaunt_native_bindings::Error::Engine(error.to_string())
                        })
                    },
                );
                if let Some(started) = started {
                    let _ = started.send(Err(other("native protocol stream did not start")));
                }
                let result = match outcome {
                    ProtocolStreamOutcome::ReadyForQuery(Ok(())) => Ok(()),
                    ProtocolStreamOutcome::ReadyForQuery(Err(error))
                    | ProtocolStreamOutcome::SessionStateUnknown(error) => Err(other(error)),
                };
                shared.executing.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
            Command::Exchange {
                input_len,
                epoch,
                request,
                mut socket,
                input_done,
                started,
                finished,
                reply,
            } => {
                {
                    let state = shared.framed.lock().unwrap();
                    let state = state
                        .as_ref()
                        .ok_or_else(|| other("exchange session disappeared"))?;
                    if state.epoch != epoch || state.active != Some(request) {
                        return Err(other("stale exchange command"));
                    }
                    shared.executing.store(true, Ordering::Release);
                }
                let mut started = Some(started);
                let completion = if shared.closing.load(Ordering::Acquire) {
                    Completion {
                        reason: Reason::WorkerInterrupted,
                        execution: Execution::NotStarted,
                        requires_reopen: true,
                        detail: "broker is closing".into(),
                    }
                } else {
                    match session.exec_protocol_exchange(
                        input_len,
                        &mut |token| {
                            {
                                let mut state = shared.framed.lock().unwrap();
                                let state = state.as_mut().ok_or_else(|| {
                                    liboliphaunt_native_bindings::Error::Engine(
                                        "exchange session disappeared".into(),
                                    )
                                })?;
                                if state.epoch != epoch || state.active != Some(request) {
                                    return Err(liboliphaunt_native_bindings::Error::Engine(
                                        "stale exchange startup".into(),
                                    ));
                                }
                                state.native_started = true;
                            }
                            started.take().unwrap().send(Ok(token)).map_err(|_| {
                                liboliphaunt_native_bindings::Error::Engine(
                                    "exchange input reader stopped".into(),
                                )
                            })
                        },
                        &mut |bytes: &[u8]| {
                            for chunk in bytes.chunks(framed::CHUNK_BYTES) {
                                if let Err(error) = framed::write_frame(
                                    &mut socket,
                                    Kind::Data,
                                    epoch,
                                    request,
                                    chunk,
                                ) {
                                    // No terminal record can repair a partial Data record.
                                    socket.shutdown();
                                    return Err(liboliphaunt_native_bindings::Error::Engine(
                                        error.to_string(),
                                    ));
                                }
                            }
                            Ok(())
                        },
                    ) {
                        ProtocolStreamOutcome::ReadyForQuery(Ok(())) => Completion::success(),
                        ProtocolStreamOutcome::ReadyForQuery(Err(error)) => Completion {
                            reason: Reason::Database,
                            execution: Execution::Completed,
                            requires_reopen: false,
                            detail: error.to_string(),
                        },
                        ProtocolStreamOutcome::SessionStateUnknown(error) => Completion {
                            reason: Reason::Database,
                            execution: Execution::Unknown,
                            requires_reopen: true,
                            detail: error.to_string(),
                        },
                    }
                };
                if let Some(started) = started {
                    let _ = started.send(Err(other(&completion.detail)));
                }
                finished.store(true, Ordering::Release);
                let result = input_done
                    .recv()
                    .map_err(other)
                    .and_then(|result| result)
                    .and_then(|()| {
                        let mut state = shared.framed.lock().unwrap();
                        if let Some(state) = state.as_mut() {
                            state.completed = request;
                            state.active = None;
                            state.native_started = false;
                        }
                        drop(state);
                        shared.executing.store(false, Ordering::Release);
                        framed::write_frame(
                            &mut socket,
                            Kind::Terminal,
                            epoch,
                            request,
                            &completion.encode(),
                        )
                    });
                if result.is_err() || completion.requires_reopen {
                    socket.shutdown();
                }
                let terminal = result.and_then(|()| {
                    if completion.requires_reopen {
                        Err(other("native exchange requires reopening the database"))
                    } else {
                        Ok(())
                    }
                });
                let _ = reply.send(terminal);
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
            Command::BackupStream(mut socket, reply) => {
                let _ = reply.send(
                    session
                        .backup_to(&mut BackupWriter(&mut socket))
                        .map_err(other),
                );
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

fn startup_parameters(
    session: &mut NativeSession,
    application: Option<&str>,
) -> io::Result<Vec<u8>> {
    // Omission preserves PostgreSQL's configured default; an explicit empty
    // string is still a client override, just like any other supplied value.
    if let Some(application) = application {
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
    }
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

struct BackupWriter<'a>(&'a mut Socket);

impl Write for BackupWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        ipc::write_backup_chunk(self.0, bytes).map_err(|error| {
            // A partial frame cannot be followed by a terminal response frame.
            self.0.shutdown();
            other(error)
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

fn management_client(mut socket: Socket, shared: &Shared) -> io::Result<()> {
    match ipc::read_request(&mut socket).map_err(other)? {
        RequestFrame::Cancel {
            token,
            epoch,
            request,
        } if token == shared.password => {
            socket.set_deadline(None)?;
            cancel_exchange(shared, epoch, request)?;
            return ipc::write_response(&mut socket, ResponseFrame::Ok(Vec::new())).map_err(other);
        }
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
        socket.set_deadline(None)?;
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
                RequestFrame::BackupStream => {
                    let (reply, done) = mpsc::channel();
                    shared
                        .commands
                        .send(Command::BackupStream(socket.clone_socket()?, reply))
                        .map_err(other)?;
                    let response = match done.recv().map_err(other)? {
                        Ok(()) => ResponseFrame::Ok(Vec::new()),
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
            "user"
                | "database"
                | "application_name"
                | "client_encoding"
                | framed::STARTUP_PARAMETER
        ) || (*key == framed::STARTUP_PARAMETER && *value != "1")
            || (*key == "client_encoding"
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
        parameters.get("application_name").copied(),
        parameters.contains_key(framed::STARTUP_PARAMETER),
    );
    if result.is_err() {
        socket.shutdown();
    }
    shared.active.lock().unwrap().take();
    shared.framed.lock().unwrap().take();
    let (reply, done) = mpsc::channel();
    if shared.commands.send(Command::Reset(reply)).is_ok() {
        let _ = done.recv();
    }
    shared.occupied.store(false, Ordering::Release);
    result
}

fn connected_sql(
    socket: &mut Socket,
    shared: &Shared,
    application: Option<&str>,
    private_exchange: bool,
) -> io::Result<()> {
    let (reply, done) = mpsc::channel();
    let deadline = socket
        .deadline
        .ok_or_else(|| other("missing broker handshake deadline"))?;
    let mut command = Command::Startup(application.map(str::to_owned), reply);
    loop {
        let remaining = Socket::remaining(deadline)?;
        match shared.commands.try_send(command) {
            Ok(()) => break,
            Err(mpsc::TrySendError::Full(pending)) => {
                command = pending;
                // Only a contended login polls; ordinary SQL retains its blocking handoff.
                thread::sleep(remaining.min(Duration::from_millis(1)));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return Err(other("native worker stopped")),
        }
    }
    let mut response =
        done.recv_timeout(Socket::remaining(deadline)?)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => io::Error::new(
                    io::ErrorKind::TimedOut,
                    "broker handshake deadline exceeded",
                ),
                mpsc::RecvTimeoutError::Disconnected => other("native worker stopped"),
            })??;
    let mut key = [0; 8];
    key[..4].copy_from_slice(&std::process::id().to_be_bytes());
    getrandom::fill(&mut key[4..]).map_err(other)?;
    response.extend(backend_frame(b'K', &key));
    response.extend(backend_frame(b'Z', b"I"));
    *shared.active.lock().unwrap() = Some((socket.clone_socket()?, key));
    socket.write_all(&response)?;
    let epoch = if private_exchange {
        let epoch = framed::new_epoch()?;
        *shared.framed.lock().unwrap() = Some(FramedSession {
            epoch,
            completed: 0,
            active: None,
            native_started: false,
        });
        framed::write_frame(
            socket,
            Kind::Terminal,
            epoch,
            0,
            &Completion::success().encode(),
        )?;
        Some(epoch)
    } else {
        None
    };
    socket.set_deadline(None)?;
    let result = if let Some(epoch) = epoch {
        framed_exchange(socket, shared, epoch)
    } else {
        exchange(socket, shared)
    };
    if result.is_err() {
        cancel_execution(shared);
    }
    result
}

fn cancel_exchange(shared: &Shared, epoch: Epoch, request: u64) -> io::Result<()> {
    if request == 0 {
        return Err(other("invalid exchange cancellation request"));
    }
    let deadline = Instant::now() + shared.recovery_timeout;
    loop {
        {
            let mut state = shared.framed.lock().unwrap();
            let Some(state) = state.as_mut().filter(|state| state.epoch == epoch) else {
                return Ok(());
            };
            if request <= state.completed {
                return Ok(());
            }
            if state.active != Some(request) {
                if state.active.is_some() || state.completed.checked_add(1) != Some(request) {
                    return Ok(());
                }
            } else {
                // Keep identity validation and delivery under the admission lock:
                // a delayed cancellation must never reach the next exchange.
                if state.native_started {
                    let cancel = shared.native.lock().unwrap().0.clone();
                    cancel.cancel().map_err(other)?;
                    return Ok(());
                }
            }
        }
        if Instant::now() >= deadline || shared.stopping.load(Ordering::Acquire) {
            stop(shared);
            return Err(other(
                "exchange cancellation did not settle; reopen the database",
            ));
        }
        // Only cancellation retries; ordinary input waits on native capacity.
        thread::sleep(Duration::from_millis(10));
    }
}

fn framed_exchange(socket: &mut Socket, shared: &Shared, epoch: Epoch) -> io::Result<()> {
    loop {
        let begin = framed::read_frame(socket)?;
        if begin.kind != Kind::Query || begin.epoch != epoch || begin.payload[8..] != [0; 8] {
            return Err(other("invalid broker exchange start"));
        }
        let length = u64::from_be_bytes(begin.payload[..8].try_into().unwrap());
        if length == 0 || length > framed::INPUT_BYTES as u64 {
            return Err(other("invalid broker exchange input length"));
        }
        {
            let mut state = shared.framed.lock().unwrap();
            let state = state
                .as_mut()
                .ok_or_else(|| other("exchange session disappeared"))?;
            if state.epoch != epoch
                || state.active.is_some()
                || state.completed.checked_add(1) != Some(begin.request)
            {
                return Err(other("out-of-order broker exchange"));
            }
            state.active = Some(begin.request);
            state.native_started = false;
        }
        let (reply, done) = mpsc::channel();
        let (input_done, input_end) = mpsc::channel();
        let (started, start) = mpsc::channel();
        let finished = Arc::new(AtomicBool::new(false));
        shared
            .commands
            .send(Command::Exchange {
                input_len: length as usize,
                epoch,
                request: begin.request,
                socket: socket.clone_socket()?,
                input_done: input_end,
                started,
                finished: Arc::clone(&finished),
                reply,
            })
            .map_err(other)?;
        let input = shared.native.lock().unwrap().1.clone();
        let mut token = None;
        let mut started = false;
        let received = (|| {
            let mut remaining = length;
            let mut feeding = true;
            let mut frame = framed::Frame::default();
            loop {
                framed::read_frame_into(socket, &mut frame)?;
                if frame.epoch != epoch || frame.request != begin.request {
                    return Err(other("stale broker exchange input"));
                }
                match frame.kind {
                    Kind::Data if frame.payload.len() as u64 <= remaining => {
                        remaining -= frame.payload.len() as u64;
                        if feeding {
                            if !started {
                                token = start.recv().map_err(other)?.ok();
                                started = true;
                            }
                            if let Some(token) = token {
                                feeding = input.feed_exchange(token, &frame.payload).is_ok();
                            }
                        }
                    }
                    Kind::End if remaining == 0 => {
                        if let Some(token) = token
                            && !finished.load(Ordering::Acquire)
                        {
                            let _ = input.finish_exchange(token);
                        }
                        return Ok(());
                    }
                    _ => return Err(other("incomplete or oversized broker exchange input")),
                }
            }
        })();
        if received.is_err() {
            if let Some(token) = token {
                let _ = input.finish_exchange(token);
            }
            socket.shutdown();
            cancel_execution(shared);
        }
        let failed = received.is_err();
        let _ = input_done.send(received);
        if failed {
            match done.recv_timeout(shared.recovery_timeout) {
                Ok(result) => result?,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    eprintln!("OLIPHAUNT_BROKER_ERROR exchange did not drain; reopen the database");
                    std::process::exit(2);
                }
                Err(error) => return Err(other(error)),
            }
        } else {
            done.recv().map_err(other)??;
        }
    }
}

struct RunningStream {
    done: mpsc::Receiver<io::Result<()>>,
    started: mpsc::Receiver<io::Result<u64>>,
    token: Option<u64>,
}

fn exchange(socket: &mut Socket, shared: &Shared) -> io::Result<()> {
    let mut running: Option<RunningStream> = None;
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
            if let Some(current) = running.as_ref() {
                match current.done.try_recv() {
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
            loop {
                if running.is_none() {
                    let (reply, done) = mpsc::channel();
                    let (started, start) = mpsc::channel();
                    shared.executing.store(true, Ordering::Release);
                    shared
                        .commands
                        .send(Command::Execute(
                            frame,
                            socket.clone_socket()?,
                            started,
                            reply,
                        ))
                        .map_err(other)?;
                    running = Some(RunningStream {
                        done,
                        started: start,
                        token: None,
                    });
                    break;
                }
                if shared.stopping.load(Ordering::Acquire) {
                    return Err(other("broker shutting down"));
                }
                let current = running.as_mut().unwrap();
                let token = match current.token {
                    Some(token) => token,
                    None => {
                        let token = current.started.recv().map_err(other)??;
                        current.token = Some(token);
                        token
                    }
                };
                let input = shared.native.lock().unwrap().1.clone();
                match input.feed_wait(token, &frame).map_err(other)? {
                    ProtocolInputStatus::Accepted => break,
                    ProtocolInputStatus::Finished => {
                        running.take().unwrap().done.recv().map_err(other)??;
                    }
                }
            }
        }
    })();
    if let Some(current) = running {
        cancel_execution(shared);
        socket.shutdown();
        if matches!(
            current.done.recv_timeout(shared.recovery_timeout),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn pair() -> (Socket, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        (Socket::tcp(stream), peer)
    }

    #[test]
    fn handshake_reads_share_one_deadline_despite_peer_progress() {
        let (mut socket, mut peer) = pair();
        socket
            .set_deadline(Some(Instant::now() + Duration::from_millis(60)))
            .unwrap();
        let writer = thread::spawn(move || {
            for _ in 0..30 {
                if peer.write_all(&[1]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let error = socket.read_exact(&mut [0; 30]).unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        socket.shutdown();
        writer.join().unwrap();
    }

    #[test]
    fn completing_handshake_clears_read_and_write_timeouts_on_clones() {
        let (mut socket, mut peer) = pair();
        socket
            .set_deadline(Some(Instant::now() + Duration::from_millis(100)))
            .unwrap();
        peer.write_all(&[1]).unwrap();
        socket.read_exact(&mut [0]).unwrap();
        socket.write_all(&[2]).unwrap();
        socket.set_deadline(None).unwrap();
        assert!(socket_call!(socket, read_timeout).unwrap().is_none());
        assert!(socket_call!(socket, write_timeout).unwrap().is_none());
        let mut cloned = socket.clone_socket().unwrap();
        assert!(cloned.deadline.is_none());
        thread::sleep(Duration::from_millis(120));
        cloned.write_all(&[3]).unwrap();
        peer.write_all(&[4]).unwrap();
        cloned.read_exact(&mut [0]).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_backup_frame_closes_the_transport_before_a_terminal_response() {
        use std::os::fd::AsRawFd;
        let (mut socket, mut peer) = pair();
        let capacity: libc::c_int = 4096;
        // Bound the kernel buffers so a stalled reader interrupts a chunk payload.
        for (fd, option) in [
            (socket.as_raw_fd(), libc::SO_SNDBUF),
            (peer.as_raw_fd(), libc::SO_RCVBUF),
        ] {
            // SAFETY: both descriptors and the integer option remain valid for setsockopt.
            assert_eq!(
                unsafe {
                    libc::setsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        option,
                        (&capacity as *const libc::c_int).cast(),
                        size_of::<libc::c_int>() as libc::socklen_t,
                    )
                },
                0
            );
        }
        socket
            .write_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        assert!(
            BackupWriter(&mut socket)
                .write_all(&vec![7; 1024 * 1024])
                .is_err()
        );
        assert!(
            ipc::write_response(&mut socket, ResponseFrame::Error("write failed".into())).is_err()
        );
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut received = Vec::new();
        peer.read_to_end(&mut received).unwrap();
        assert!(!received.is_empty());
        assert!(ipc::read_backup_response(&mut received.as_slice(), &mut Vec::new()).is_err());
    }
}
