use oliphaunt_broker::{
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
    fn start() -> Self {
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
        let mut child = Command::new(executable)
            .args([
                "--root",
                root.to_str().unwrap(),
                "--listen",
                "127.0.0.1:0",
                "--control-listen",
                "127.0.0.1:0",
            ])
            .env("OLIPHAUNT_BROKER_AUTH_TOKEN", "actual-consumer-test-secret")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
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
        pgwire::exchange(
            stream,
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
fn postgres_protocol_and_management_are_independent() {
    let mut broker = Broker::start();
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

    // Flush produces ParseComplete before the large parameter even exists.
    let mut parse = frame(b'P', b"\0SELECT length($1::text)\0\0\0");
    parse.extend(frame(b'H', b""));
    client.write_all(&parse).unwrap();
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
    pgwire::exchange(&mut client, &rest, &mut |chunk| {
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
    let retained = pgwire::exchange(&mut client, &pipeline, &mut |_| {
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
    pgwire::exchange(&mut client, &copy, &mut |_| Ok::<_, ()>(())).unwrap();
    assert!(
        String::from_utf8_lossy(&query(&mut client, "SELECT sum(value) FROM copy_input"))
            .contains("15")
    );

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
    let mut broker = Broker::start();
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

    let mut incomplete = Broker::start();
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
