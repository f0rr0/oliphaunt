use oliphaunt_broker::{
    exchange,
    ipc::{self, RequestFrame, ResponseFrame},
    pgwire,
};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Broker {
    child: Child,
    root: PathBuf,
    sql: String,
    control: String,
}
impl Broker {
    fn start(handshake_timeout_ms: Option<u32>) -> Self {
        Self::start_with_capacity(
            handshake_timeout_ms,
            oliphaunt_broker::config::DEFAULT_MAX_PENDING_HANDSHAKES as u32,
        )
    }

    fn start_with_capacity(handshake_timeout_ms: Option<u32>, capacity: u32) -> Self {
        for key in ["LIBOLIPHAUNT_PATH", "OLIPHAUNT_INSTALL_DIR"] {
            std::env::var_os(key).unwrap_or_else(|| panic!("{key} is required"));
        }
        let root = std::env::temp_dir().join(format!(
            "broker-pgwire-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let executable = std::env::var_os("OLIPHAUNT_BROKER")
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_oliphaunt-broker").into());
        let mut command = Command::new(executable);
        command
            .args([
                "--root",
                root.to_str().unwrap(),
                "--listen",
                "127.0.0.1:0",
                "--control-listen",
                "127.0.0.1:0",
                "--startup-guc",
                "application_name=broker-default",
            ])
            .env("OLIPHAUNT_BROKER_AUTH_TOKEN", "actual-consumer-test-secret")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(timeout) = handshake_timeout_ms {
            command.args(["--handshake-timeout-ms", &timeout.to_string()]);
        }
        command.args(["--max-pending-handshakes", &capacity.to_string()]);
        let mut child = command.spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let mut parts = ready
            .trim()
            .strip_prefix("OLIPHAUNT_BROKER_READY ")
            .expect(&ready)
            .split_whitespace();
        let sql = parts
            .next()
            .unwrap()
            .strip_prefix("tcp:")
            .unwrap()
            .to_owned();
        let control = parts
            .next()
            .unwrap()
            .strip_prefix("control=tcp:")
            .unwrap()
            .to_owned();
        Self {
            child,
            root,
            sql,
            control,
        }
    }
    fn owner(&self) -> TcpStream {
        let mut stream = connect(&self.control);
        ipc::write_request(
            &mut stream,
            RequestFrame::Authenticate("actual-consumer-test-secret".into()),
        )
        .unwrap();
        assert_eq!(
            ipc::read_response(&mut stream).unwrap(),
            ResponseFrame::Ok(Vec::new())
        );
        stream
    }
    fn client(&self) -> (TcpStream, [u8; 8]) {
        let mut stream = connect(&self.sql);
        let key = pgwire::authenticate(
            &mut stream,
            "postgres",
            "postgres",
            "actual-consumer-test-secret",
        )
        .unwrap();
        (stream, key)
    }
    fn exchange_client(&self) -> (TcpStream, exchange::Epoch) {
        let mut stream = connect(&self.sql);
        let epoch = pgwire::authenticate_exchange(
            &mut stream,
            "postgres",
            "postgres",
            "actual-consumer-test-secret",
        )
        .unwrap();
        (stream, epoch)
    }
    fn reconnect(&self) -> (TcpStream, [u8; 8]) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let mut socket = connect(&self.sql);
            match pgwire::authenticate(
                &mut socket,
                "postgres",
                "postgres",
                "actual-consumer-test-secret",
            ) {
                Ok(key) => return (socket, key),
                Err(error)
                    if error
                        .to_string()
                        .contains("already has an active SQL connection")
                        && std::time::Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("reconnect failed: {error}"),
            }
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn connect(address: &str) -> TcpStream {
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
}

fn raw_exchange(
    stream: &mut TcpStream,
    epoch: exchange::Epoch,
    request: u64,
    bytes: &[u8],
) -> Vec<u8> {
    let mut output = Vec::new();
    let (completion, callback_error) =
        exchange::exchange(stream, epoch, request, bytes, &mut |bytes| {
            output.extend_from_slice(bytes);
            Ok::<_, ()>(())
        })
        .unwrap();
    assert_eq!(completion, exchange::Completion::success());
    assert_eq!(callback_error, None);
    output
}

fn extended_copy(sql: &str) -> Vec<u8> {
    let mut parse = vec![0];
    parse.extend_from_slice(sql.as_bytes());
    parse.extend_from_slice(&[0, 0, 0]);
    let mut bytes = frame(b'P', &parse);
    bytes.extend(frame(b'B', &[0; 8]));
    bytes.extend(frame(b'E', &[0; 5]));
    bytes.extend(frame(b'S', b""));
    bytes
}

fn ready_count(mut bytes: &[u8]) -> usize {
    let mut count = 0;
    while !bytes.is_empty() {
        let length = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize + 1;
        if bytes[0] == b'Z' {
            count += 1;
        }
        bytes = &bytes[length..];
    }
    count
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn framed_exchanges_follow_actual_copy_boundaries_and_scope_cancellation() {
    let broker = Broker::start(None);
    let mut owner = broker.owner();
    let (mut client, epoch) = broker.exchange_client();
    raw_exchange(
        &mut client,
        epoch,
        1,
        &oliphaunt_query::simple_query("CREATE TABLE framed_copy(value integer)").unwrap(),
    );

    let mut copy = oliphaunt_query::simple_query("COPY framed_copy FROM STDIN").unwrap();
    copy.extend(frame(b'S', b""));
    copy.extend(frame(b'H', b""));
    copy.extend(frame(b'd', b"7\n8\n"));
    copy.extend(frame(b'c', b""));
    assert_eq!(ready_count(&raw_exchange(&mut client, epoch, 2, &copy)), 1);

    let mut copy = extended_copy("COPY framed_copy FROM STDIN");
    copy.extend(frame(b'd', b"9\n"));
    copy.extend(frame(b'c', b""));
    copy.extend(frame(b'S', b""));
    assert_eq!(ready_count(&raw_exchange(&mut client, epoch, 3, &copy)), 1);

    // The same Sync is a real boundary when COPY failed before entering its reader.
    let mut failed = oliphaunt_query::simple_query("COPY missing_framed_copy FROM STDIN").unwrap();
    failed.extend(frame(b'S', b""));
    failed.extend(frame(b'd', b"1\n"));
    failed.extend(frame(b'c', b""));
    let failed = raw_exchange(&mut client, epoch, 4, &failed);
    assert!(oliphaunt_query::wire::response_contains_error(&failed));
    assert_eq!(ready_count(&failed), 2);

    let mut failed = extended_copy("COPY missing_framed_copy FROM STDIN");
    failed.extend(frame(b'd', b"1\n"));
    failed.extend(frame(b'c', b""));
    failed.extend(frame(b'S', b""));
    let failed = raw_exchange(&mut client, epoch, 5, &failed);
    assert!(oliphaunt_query::wire::response_contains_error(&failed));
    assert_eq!(ready_count(&failed), 2);

    let mut pipeline = oliphaunt_query::simple_query("SELECT repeat('x',6000000)").unwrap();
    pipeline.extend(
        oliphaunt_query::extended_statement(
            "SELECT length($1::text)",
            &[oliphaunt_query::Parameter::text(
                "x".repeat(5 * 1024 * 1024),
            )],
            0,
        )
        .unwrap(),
    );
    let original = std::sync::Arc::new(());
    let (completion, callback_error) =
        exchange::exchange(&mut client, epoch, 6, &pipeline, &mut |_| {
            Err(std::sync::Arc::clone(&original))
        })
        .unwrap();
    assert_eq!(completion, exchange::Completion::success());
    assert!(std::sync::Arc::ptr_eq(&original, &callback_error.unwrap()));
    let sum = raw_exchange(
        &mut client,
        epoch,
        7,
        &oliphaunt_query::simple_query("SELECT sum(value) FROM framed_copy").unwrap(),
    );
    assert!(String::from_utf8_lossy(&sum).contains("24"));

    let address = broker.control.clone();
    let cancellation = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        let mut control = connect(&address);
        ipc::write_request(
            &mut control,
            RequestFrame::Cancel {
                token: "actual-consumer-test-secret".into(),
                epoch,
                request: 8,
            },
        )
        .unwrap();
        assert_eq!(
            ipc::read_response(&mut control).unwrap(),
            ResponseFrame::Ok(Vec::new())
        );
    });
    let cancelled = raw_exchange(
        &mut client,
        epoch,
        8,
        &oliphaunt_query::simple_query("SELECT pg_sleep(60)").unwrap(),
    );
    cancellation.join().unwrap();
    assert!(oliphaunt_query::wire::response_contains_error(&cancelled));

    let mut stale = connect(&broker.control);
    ipc::write_request(
        &mut stale,
        RequestFrame::Cancel {
            token: "actual-consumer-test-secret".into(),
            epoch,
            request: 8,
        },
    )
    .unwrap();
    assert_eq!(
        ipc::read_response(&mut stale).unwrap(),
        ResponseFrame::Ok(Vec::new())
    );
    let fresh = raw_exchange(
        &mut client,
        epoch,
        9,
        &oliphaunt_query::simple_query("SELECT pg_sleep(0.1)").unwrap(),
    );
    assert!(!oliphaunt_query::wire::response_contains_error(&fresh));
    // Cancellation from a callback must acknowledge delivery without waiting
    // for this callback to release output backpressure.
    let mut sent = false;
    let (completion, callback_error) = exchange::exchange(
        &mut client,
        epoch,
        10,
        &oliphaunt_query::simple_query("SELECT generate_series(1, 1000000)").unwrap(),
        &mut |_| {
            if !sent {
                sent = true;
                let mut control = connect(&broker.control);
                ipc::write_request(
                    &mut control,
                    RequestFrame::Cancel {
                        token: "actual-consumer-test-secret".into(),
                        epoch,
                        request: 10,
                    },
                )
                .unwrap();
                assert_eq!(
                    ipc::read_response(&mut control).unwrap(),
                    ResponseFrame::Ok(Vec::new())
                );
            }
            Ok::<_, ()>(())
        },
    )
    .unwrap();
    assert_eq!(completion, exchange::Completion::success());
    assert_eq!(callback_error, None);
    assert!(sent);
    let next = raw_exchange(
        &mut client,
        epoch,
        11,
        &oliphaunt_query::simple_query("SELECT 42").unwrap(),
    );
    assert!(!oliphaunt_query::wire::response_contains_error(&next));
    ipc::write_request(&mut owner, RequestFrame::Close).unwrap();
    assert_eq!(
        ipc::read_response(&mut owner).unwrap(),
        ResponseFrame::Ok(Vec::new())
    );
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn an_exhausted_exchange_without_sync_reports_unknown_and_cannot_be_reused() {
    let broker = Broker::start(None);
    let _owner = broker.owner();
    let (mut client, epoch) = broker.exchange_client();
    let mut bytes = frame(b'P', b"\0SELECT 1\0\0\0");
    bytes.extend(frame(b'H', b""));
    let (completion, _) =
        exchange::exchange(&mut client, epoch, 1, &bytes, &mut |_| Ok::<_, ()>(())).unwrap();
    assert_eq!(completion.execution, exchange::Execution::Unknown);
    assert!(completion.requires_reopen);
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn fragmented_exchange_input_streams_output_and_waits_for_a_late_end() {
    let broker = Broker::start(None);
    let _owner = broker.owner();
    let (mut client, epoch) = broker.exchange_client();
    client.set_nodelay(true).unwrap();
    let query = oliphaunt_query::simple_query("SELECT 1").unwrap();
    let mut begin = [0; 16];
    begin[..8].copy_from_slice(&(query.len() as u64).to_be_bytes());
    let mut records = Vec::new();
    exchange::write_frame(&mut records, exchange::Kind::Query, epoch, 1, &begin).unwrap();
    for fragment in query.chunks(3) {
        exchange::write_frame(&mut records, exchange::Kind::Data, epoch, 1, fragment).unwrap();
    }
    for byte in records {
        client.write_all(&[byte]).unwrap();
    }
    let mut output = Vec::new();
    while !output.ends_with(b"Z\0\0\0\x05I") {
        let record = exchange::read_frame(&mut client).unwrap();
        assert_eq!(record.kind, exchange::Kind::Data);
        assert_eq!((record.epoch, record.request), (epoch, 1));
        output.extend(record.payload);
    }
    client
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    assert!(matches!(
        client.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ));
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    exchange::write_frame(&mut client, exchange::Kind::End, epoch, 1, &[]).unwrap();
    let terminal = exchange::read_frame(&mut client).unwrap();
    assert_eq!(terminal.kind, exchange::Kind::Terminal);
    assert_eq!(
        exchange::Completion::decode(&terminal.payload).unwrap(),
        exchange::Completion::success()
    );
    let next = raw_exchange(
        &mut client,
        epoch,
        2,
        &oliphaunt_query::simple_query("SELECT 42").unwrap(),
    );
    assert!(String::from_utf8_lossy(&next).contains("42"));
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn pending_login_capacity_preserves_management_and_releases_after_authentication() {
    let broker = Broker::start_with_capacity(Some(10_000), 1);
    let idle = connect(&broker.sql);
    thread::sleep(Duration::from_millis(20));
    let mut excess = connect(&broker.sql);
    assert_eq!(excess.read(&mut [0]).unwrap(), 0);
    let mut owner = broker.owner();
    drop(idle);
    let (client, _) = broker.reconnect();
    let mut pending = connect(&broker.sql);
    pending
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let error = pending.read(&mut [0]).unwrap_err();
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ));
    drop(pending);
    drop(client);
    ipc::write_request(&mut owner, RequestFrame::Close).unwrap();
    assert_eq!(
        ipc::read_response(&mut owner).unwrap(),
        ResponseFrame::Ok(Vec::new())
    );
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn handshake_deadline_expires_idle_logins_but_not_queries_or_slow_backups() {
    let broker = Broker::start(Some(500));
    for endpoint in [&broker.control, &broker.sql] {
        let mut idle = connect(endpoint);
        idle.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        assert_eq!(idle.read(&mut [0]).unwrap(), 0, "idle login did not expire");
    }
    let mut owner = broker.owner();
    // Keep the backend in a backup write while a new SQL login asks it for startup metadata.
    ipc::write_request(&mut owner, RequestFrame::BackupStream).unwrap();
    assert_eq!(owner.peek(&mut [0]).unwrap(), 1);
    let mut pending_login = connect(&broker.sql);
    pending_login
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let start = std::time::Instant::now();
    assert!(
        pgwire::authenticate(
            &mut pending_login,
            "postgres",
            "postgres",
            "actual-consumer-test-secret"
        )
        .is_err()
    );
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "login waited beyond its budget for the stalled backend"
    );
    let (completion, failure) =
        ipc::read_backup_response(&mut owner, &mut std::io::sink()).unwrap();
    assert_eq!(completion, ResponseFrame::Ok(Vec::new()));
    assert!(failure.is_none());
    let (mut sql, _) = broker.reconnect();
    let result = query(&mut sql, "SELECT pg_sleep(1), 42 AS answer");
    assert!(result.windows(2).any(|bytes| bytes == b"42"));

    struct SlowDestination {
        bytes: usize,
        paused: bool,
    }
    impl Write for SlowDestination {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if !self.paused {
                self.paused = true;
                thread::sleep(Duration::from_secs(1));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    ipc::write_request(&mut owner, RequestFrame::BackupStream).unwrap();
    let mut destination = SlowDestination {
        bytes: 0,
        paused: false,
    };
    let (completion, failure) = ipc::read_backup_response(&mut owner, &mut destination).unwrap();
    assert_eq!(completion, ResponseFrame::Ok(Vec::new()));
    assert!(failure.is_none());
    assert!(destination.bytes > 1024 * 1024);
    assert!(
        query(&mut sql, "SELECT 43 AS answer")
            .windows(2)
            .any(|bytes| bytes == b"43")
    );
}
fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
fn response(stream: &mut TcpStream) -> Vec<u8> {
    let mut header = [0; 5];
    stream.read_exact(&mut header).unwrap();
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    let mut bytes = header.to_vec();
    bytes.resize(length + 1, 0);
    stream.read_exact(&mut bytes[5..]).unwrap();
    bytes
}
fn query(stream: &mut TcpStream, sql: &str) -> Vec<u8> {
    let mut result = Vec::new();
    assert!(
        ordinary::exchange(
            stream,
            1,
            &oliphaunt_query::simple_query(sql).unwrap(),
            &mut |chunk| {
                result.extend_from_slice(chunk);
                Ok::<_, ()>(())
            }
        )
        .unwrap()
        .is_none()
    );
    result
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn function_call_batches_preserve_each_completion_boundary() {
    let broker = Broker::start(None);
    let _owner = broker.owner();
    let (mut client, _) = broker.client();
    let metadata = oliphaunt_query::parse_query_response(
        &query(
            &mut client,
            "SELECT oid FROM pg_proc WHERE proname = 'pg_sleep'",
        ),
        oliphaunt_query::ExpectedProtocol::Simple,
    )
    .unwrap();
    let oid = metadata
        .get_text(0, "oid")
        .unwrap()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let mut body = oid.to_be_bytes().to_vec();
    // One binary double argument, with a text-format void result.
    for value in [1_i16, 1, 1] {
        body.extend_from_slice(&value.to_be_bytes());
    }
    body.extend_from_slice(&8_i32.to_be_bytes());
    body.extend_from_slice(&0.05_f64.to_be_bytes());
    body.extend_from_slice(&0_i16.to_be_bytes());
    let call = frame(b'F', &body);
    for next in [
        oliphaunt_query::simple_query("SELECT 42").unwrap(),
        call.clone(),
    ] {
        let mut request = call.clone();
        request.extend(next);
        let mut bytes = Vec::new();
        assert!(
            ordinary::exchange(&mut client, 2, &request, &mut |chunk| {
                bytes.extend_from_slice(chunk);
                Ok::<_, ()>(())
            })
            .unwrap()
            .is_none()
        );
        let mut remaining = bytes.as_slice();
        let mut ready = 0;
        while !remaining.is_empty() {
            let (tag, _, rest) = oliphaunt_query::read_backend_message(remaining).unwrap();
            assert_ne!(tag, b'E');
            ready += usize::from(tag == b'Z');
            remaining = rest;
        }
        assert_eq!(ready, 2);
        assert!(String::from_utf8_lossy(&query(&mut client, "SELECT 43")).contains("43"));
    }
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn startup_application_name_distinguishes_omission_from_empty() {
    for application in [None, Some(""), Some("client-application")] {
        let broker = Broker::start(None);
        let _owner = broker.owner();
        let mut client = connect(&broker.sql);
        let mut startup = oliphaunt_query::wire::PROTOCOL_3.to_be_bytes().to_vec();
        startup.extend_from_slice(b"user\0postgres\0database\0postgres\0");
        if let Some(value) = application {
            startup.extend_from_slice(format!("application_name\0{value}\0").as_bytes());
        }
        startup.push(0);
        client
            .write_all(&((startup.len() + 4) as u32).to_be_bytes())
            .unwrap();
        client.write_all(&startup).unwrap();
        assert_eq!(response(&mut client), frame(b'R', &3_i32.to_be_bytes()));
        client
            .write_all(&frame(b'p', b"actual-consumer-test-secret\0"))
            .unwrap();
        loop {
            let message = response(&mut client);
            assert_ne!(message[0], b'E', "startup failed: {message:?}");
            if message[0] == b'Z' {
                break;
            }
        }
        let result = oliphaunt_query::parse_query_response(
            &query(&mut client, "SHOW application_name"),
            oliphaunt_query::ExpectedProtocol::Simple,
        )
        .unwrap();
        assert_eq!(
            result.get_text(0, "application_name").unwrap(),
            Some(application.unwrap_or("broker-default")),
        );
    }
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn postgres_protocol_and_management_are_independent() {
    let mut broker = Broker::start(None);
    let mut owner = broker.owner();
    let (mut client, first_key) = broker.client();
    assert!(String::from_utf8_lossy(&query(&mut client, "SELECT 42")).contains("42"));
    let mut other = connect(&broker.sql);
    assert!(
        pgwire::authenticate(
            &mut other,
            "postgres",
            "postgres",
            "actual-consumer-test-secret"
        )
        .is_err()
    );
    drop(other);

    // Parse without Flush keeps native input open without producing output.
    client
        .write_all(&frame(b'P', b"\0SELECT length($1::text)\0\0\0"))
        .unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let error = client.read(&mut [0]).unwrap_err();
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ));
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    // A later Flush produces ParseComplete before the parameter even exists.
    client.write_all(&frame(b'H', b"")).unwrap();
    assert_eq!(response(&mut client)[0], b'1');
    let parameter = vec![b'x'; 5 * 1024 * 1024];
    let mut bind = b"\0\0\0\0\0\x01".to_vec();
    bind.extend_from_slice(&(parameter.len() as u32).to_be_bytes());
    bind.extend(parameter);
    bind.extend_from_slice(&[0, 0]);
    let mut rest = frame(b'B', &bind);
    rest.extend(frame(b'E', &[0, 0, 0, 0, 0]));
    rest.extend(frame(b'S', b""));
    let mut result = Vec::new();
    ordinary::exchange(&mut client, 1, &rest, &mut |chunk| {
        result.extend_from_slice(chunk);
        Ok::<_, ()>(())
    })
    .unwrap();
    assert!(String::from_utf8_lossy(&result).contains("5242880"));

    // Neither socket direction may depend on the other being fully drained.
    let mut pipeline = oliphaunt_query::simple_query("SELECT repeat('x', 6000000)").unwrap();
    pipeline.extend(
        oliphaunt_query::extended_statement(
            "SELECT length($1::text)",
            &[oliphaunt_query::Parameter::text(
                "x".repeat(5 * 1024 * 1024),
            )],
            0,
        )
        .unwrap(),
    );
    let failure = std::sync::Arc::new(());
    let retained = ordinary::exchange(&mut client, 2, &pipeline, &mut |_| {
        Err(std::sync::Arc::clone(&failure))
    })
    .unwrap()
    .unwrap();
    assert!(std::sync::Arc::ptr_eq(&failure, &retained));
    assert!(String::from_utf8_lossy(&query(&mut client, "SELECT 42")).contains("42"));

    query(&mut client, "CREATE TABLE copy_input(value integer)");
    let mut copy = oliphaunt_query::simple_query("COPY copy_input FROM STDIN").unwrap();
    copy.extend(frame(b'd', b"7\n8\n"));
    copy.extend(frame(b'c', b""));
    ordinary::exchange(&mut client, 1, &copy, &mut |_| Ok::<_, ()>(())).unwrap();
    assert!(
        String::from_utf8_lossy(&query(&mut client, "SELECT sum(value) FROM copy_input"))
            .contains("15")
    );

    // Ordinary clients may send Flush and Sync while COPY owns the reader.
    client
        .write_all(&oliphaunt_query::simple_query("COPY copy_input FROM STDIN").unwrap())
        .unwrap();
    loop {
        let bytes = response(&mut client);
        assert_ne!(bytes[0], b'E');
        if bytes[0] == b'G' {
            break;
        }
    }
    let mut input = frame(b'S', b"");
    input.extend(frame(b'H', b""));
    input.extend(frame(b'd', b"10\n"));
    input.extend(frame(b'c', b""));
    client.write_all(&input).unwrap();
    while response(&mut client)[0] != b'Z' {}

    client
        .write_all(&extended_copy("COPY copy_input FROM STDIN"))
        .unwrap();
    loop {
        let bytes = response(&mut client);
        assert_ne!(bytes[0], b'E');
        if bytes[0] == b'G' {
            break;
        }
    }
    let mut input = frame(b'H', b"");
    input.extend(frame(b'd', b"11\n"));
    input.extend(frame(b'c', b""));
    input.extend(frame(b'S', b""));
    client.write_all(&input).unwrap();
    while response(&mut client)[0] != b'Z' {}
    assert!(!oliphaunt_query::wire::response_contains_error(&query(
        &mut client,
        "SELECT 42"
    )));

    let address = broker.sql.clone();
    let cancel = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        pgwire::cancel(&mut connect(&address), &first_key).unwrap();
    });
    let cancelled = query(&mut client, "SELECT pg_sleep(60)");
    cancel.join().unwrap();
    assert!(oliphaunt_query::wire::response_contains_error(&cancelled));
    assert!(String::from_utf8_lossy(&query(&mut client, "SELECT 42")).contains("42"));

    query(&mut client, "CREATE TEMP TABLE transient(value integer)");
    query(&mut client, "BEGIN");
    client.write_all(&frame(b'X', b"")).unwrap();
    drop(client);
    // Reconnect retries only the documented single-client admission window.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let (mut client, second_key) = loop {
        let mut socket = connect(&broker.sql);
        match pgwire::authenticate(
            &mut socket,
            "postgres",
            "postgres",
            "actual-consumer-test-secret",
        ) {
            Ok(key) => break (socket, key),
            Err(_) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("reconnect failed: {error}"),
        }
    };
    assert_ne!(first_key, second_key);
    pgwire::cancel(&mut connect(&broker.sql), &first_key).unwrap();
    assert!(!oliphaunt_query::wire::response_contains_error(&query(
        &mut client,
        "SELECT pg_sleep(0.1)"
    )));
    assert!(oliphaunt_query::wire::response_contains_error(&query(
        &mut client,
        "SELECT * FROM transient"
    )));
    ipc::write_request(&mut owner, RequestFrame::Backup).unwrap();
    assert!(
        matches!(ipc::read_response(&mut owner).unwrap(), ResponseFrame::Ok(bytes) if !bytes.is_empty())
    );
    ipc::write_request(&mut owner, RequestFrame::Close).unwrap();
    assert_eq!(
        ipc::read_response(&mut owner).unwrap(),
        ResponseFrame::Ok(Vec::new())
    );
    assert!(broker.child.wait().unwrap().success());
}

#[test]
#[ignore = "requires a prepared native runtime; runs the actual broker executable"]
fn disconnect_and_parent_death_drain_active_native_work() {
    let mut broker = Broker::start(None);
    let owner = broker.owner();
    let (mut client, _) = broker.client();
    client
        .write_all(
            &oliphaunt_query::simple_query(
                "SELECT repeat('x', 10000) FROM generate_series(1, 1000000)",
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(response(&mut client)[0], b'T');
    drop(client);
    let (mut client, _) = broker.reconnect();
    assert!(String::from_utf8_lossy(&query(&mut client, "SELECT 42")).contains("42"));
    client
        .write_all(&oliphaunt_query::simple_query("SELECT pg_sleep(60)").unwrap())
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    drop(owner);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = broker.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owner death did not stop active native work"
        );
        thread::sleep(Duration::from_millis(5));
    }

    let mut incomplete = Broker::start(None);
    let _owner = incomplete.owner();
    let (mut client, _) = incomplete.client();
    let mut partial = frame(b'P', b"\0SELECT 42\0\0\0");
    partial.extend(frame(b'H', b""));
    client.write_all(&partial).unwrap();
    assert_eq!(response(&mut client)[0], b'1');
    drop(client);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = incomplete.child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "abandoned partial protocol must retire the helper"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

// Ordinary-driver fixtures below have explicitly counted readiness boundaries.
mod ordinary {
    use oliphaunt_broker::pgwire::Connection;
    use oliphaunt_query::wire::MAX_FRONTEND_MESSAGE;
    use std::io::{self, Read, Write};
    fn invalid(message: impl Into<String>) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, message.into())
    }
    /// Forward raw backend frames, retaining the first callback error while draining
    /// all promised ReadyForQuery boundaries. A transport error supersedes a callback
    /// error because recovery could not be established.
    pub fn exchange<E>(
        stream: &mut (impl Connection + ?Sized),
        boundaries: usize,
        request: &[u8],
        callback: &mut impl FnMut(&[u8]) -> Result<(), E>,
    ) -> io::Result<Option<E>> {
        let mut writer = stream.clone_connection()?;
        std::thread::scope(|scope| {
            let writing = scope.spawn(|| {
                let result = writer.write_all(request);
                if result.is_err() {
                    writer.shutdown();
                }
                result
            });
            let reading = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                receive(stream, boundaries, callback)
            }));
            if !matches!(&reading, Ok(Ok(_))) {
                stream.shutdown();
            }
            let written = writing.join();
            match reading {
                Err(payload) => std::panic::resume_unwind(payload),
                Ok(Err(error)) => Err(error),
                Ok(Ok(callback_error)) => {
                    written.map_err(|_| invalid("broker request writer panicked"))??;
                    Ok(callback_error)
                }
            }
        })
    }

    fn receive<E>(
        stream: &mut (impl Read + ?Sized),
        mut boundaries: usize,
        callback: &mut impl FnMut(&[u8]) -> Result<(), E>,
    ) -> io::Result<Option<E>> {
        let mut callback_error = None;
        while boundaries != 0 {
            let mut header = [0; 5];
            stream.read_exact(&mut header)?;
            let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
            if !(4..MAX_FRONTEND_MESSAGE).contains(&length) {
                return Err(invalid("invalid backend message length"));
            }
            if header[0] == b'Z' {
                if length != 5 {
                    return Err(invalid("invalid ReadyForQuery frame"));
                }
                let mut ready = [0; 6];
                ready[..5].copy_from_slice(&header);
                stream.read_exact(&mut ready[5..])?;
                if !matches!(ready[5], b'I' | b'T' | b'E') {
                    return Err(invalid("invalid ReadyForQuery frame"));
                }
                if callback_error.is_none() {
                    callback_error = callback(&ready).err();
                }
                boundaries -= 1;
                continue;
            }
            if callback_error.is_none() {
                callback_error = callback(&header).err();
            }
            let mut remaining = length - 4;
            let mut chunk = [0; 64 * 1024];
            while remaining != 0 {
                let count = remaining.min(chunk.len());
                stream.read_exact(&mut chunk[..count])?;
                if callback_error.is_none() {
                    callback_error = callback(&chunk[..count]).err();
                }
                remaining -= count;
            }
        }
        Ok(callback_error)
    }
}
