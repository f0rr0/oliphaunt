#![cfg(feature = "extensions")]

use anyhow::{Context, Result, bail, ensure};
use oliphaunt_wasix::{OliphauntServer, ServerListen};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::Path;
use std::thread;
use std::time::Duration;

const SSL_REQUEST_CODE: i32 = 80_877_103;
const GSSENC_REQUEST_CODE: i32 = 80_877_104;
const CANCEL_REQUEST_CODE: i32 = 80_877_102;
const PROTOCOL_3: i32 = 196_608;

#[test]
fn tcp_proxy_handles_psql_style_and_fragmented_connections() -> Result<()> {
    let server = OliphauntServer::builder().start()?;
    let addr = server.tcp_addr().context("TCP server address")?;

    let first = query_proxy(addr, false, "SELECT 1 AS one")?;
    assert_eq!(first, vec!["1"]);

    let second = query_proxy(addr, true, "SELECT 2 AS two")?;
    assert_eq!(second, vec!["2"]);

    let fragmented = query_proxy_fragmented(addr, "SELECT 3 AS three")?;
    assert_eq!(fragmented, vec!["3"]);

    server.close()?;
    Ok(())
}

#[test]
fn tcp_proxy_survives_a_malformed_client() -> Result<()> {
    let server = OliphauntServer::builder().start()?;
    let addr = server.tcp_addr().context("TCP server address")?;

    let mut malformed = TcpStream::connect(addr)?;
    malformed.set_read_timeout(Some(Duration::from_secs(30)))?;
    malformed.write_all(&startup_message())?;
    read_until_ready(&mut malformed)?;
    malformed.write_all(&simple_query_message(
        "BEGIN; CREATE TABLE must_rollback_on_disconnect(value integer)",
    ))?;
    assert!(read_query_values(&mut malformed)?.is_empty());
    malformed.write_all(&[b'Q', 0, 0, 0, 3])?;
    drop(malformed);
    thread::sleep(Duration::from_millis(25));

    assert_eq!(
        query_proxy(
            addr,
            false,
            "SELECT to_regclass('public.must_rollback_on_disconnect') IS NULL",
        )?,
        vec!["t"],
    );
    server.close()?;
    Ok(())
}

#[test]
fn tcp_proxy_contains_each_startup_and_control_failure() -> Result<()> {
    let server = OliphauntServer::builder().start()?;
    let addr = server.tcp_addr().context("TCP server address")?;

    malformed_then_recover(addr, "malformed startup", |stream| {
        let mut message = Vec::from(12_i32.to_be_bytes());
        message.extend_from_slice(&PROTOCOL_3.to_be_bytes());
        message.extend_from_slice(b"user");
        stream.write_all(&message)?;
        Ok(())
    })?;
    malformed_then_recover(addr, "invalid length", |stream| {
        stream.write_all(&[b'Q', 0, 0, 0, 3])?;
        Ok(())
    })?;
    malformed_then_recover(addr, "protocol before startup", |stream| {
        stream.write_all(&simple_query_message("SELECT 1"))?;
        Ok(())
    })?;
    malformed_then_recover(addr, "second startup", |stream| {
        stream.write_all(&startup_message())?;
        read_until_ready(stream)?;
        stream.write_all(&startup_message())?;
        Ok(())
    })?;
    malformed_then_recover(addr, "disconnect after backend open", |stream| {
        stream.write_all(&startup_message())?;
        read_until_ready(stream)?;
        stream.write_all(&simple_query_message("BEGIN"))?;
        read_query_values(stream)?;
        Ok(())
    })?;

    for code in [SSL_REQUEST_CODE, GSSENC_REQUEST_CODE] {
        negotiation_then_recover(addr, code)?;
    }
    malformed_then_recover(addr, "cancel request", |stream| {
        stream.write_all(&cancel_request())?;
        Ok(())
    })?;

    server.close()?;
    Ok(())
}

#[test]
fn tcp_proxy_accepts_a_fragmented_message_larger_than_64_kib() -> Result<()> {
    let server = OliphauntServer::builder().start()?;
    let addr = server.tcp_addr().context("TCP server address")?;
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    write_fragmented(&mut stream, &startup_message())?;
    read_until_ready(&mut stream)?;
    let sql = format!("SELECT 5 /*{}*/", "x".repeat(70 * 1024));
    write_in_chunks(&mut stream, &simple_query_message(&sql), 1024)?;
    assert_eq!(read_query_values(&mut stream)?, vec!["5"]);
    stream.write_all(&terminate_message())?;
    server.close()?;
    Ok(())
}

#[test]
fn tcp_server_close_interrupts_an_active_client() -> Result<()> {
    let server = OliphauntServer::builder().start()?;
    let addr = server.tcp_addr().context("TCP server address")?;
    let mut client = TcpStream::connect(addr)?;
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    client.write_all(&startup_message())?;
    read_until_ready(&mut client)?;

    let (closed_tx, closed_rx) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = closed_tx.send(server.close());
    });
    closed_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| anyhow::anyhow!("server close remained blocked on its active client"))??;
    Ok(())
}

#[cfg(unix)]
#[test]
fn unix_proxy_survives_a_malformed_client() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let socket = directory.path().join(".s.PGSQL.5432");
    let server = OliphauntServer::builder()
        .listen(ServerListen::unix(directory.path()))
        .start()?;

    let mut malformed = UnixStream::connect(&socket)?;
    malformed.write_all(&3_i32.to_be_bytes())?;
    drop(malformed);
    thread::sleep(Duration::from_millis(25));

    assert_eq!(query_unix_proxy(&socket, "SELECT 4 AS four")?, vec!["4"]);
    server.close()?;
    Ok(())
}

fn query_proxy(addr: SocketAddr, request_ssl: bool, sql: &str) -> Result<Vec<String>> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;

    if request_ssl {
        stream.write_all(&ssl_request())?;
        let mut response = [0u8; 1];
        stream.read_exact(&mut response)?;
        ensure!(response[0] == b'N', "expected SSL refusal");
    }

    stream.write_all(&startup_message())?;
    read_until_ready(&mut stream)?;

    stream.write_all(&simple_query_message(sql))?;
    let values = read_query_values(&mut stream)?;

    stream.write_all(&terminate_message())?;
    Ok(values)
}

fn query_proxy_fragmented(addr: SocketAddr, sql: &str) -> Result<Vec<String>> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;

    write_fragmented(&mut stream, &startup_message())?;
    read_until_ready(&mut stream)?;
    write_fragmented(&mut stream, &simple_query_message(sql))?;
    let values = read_query_values(&mut stream)?;
    write_fragmented(&mut stream, &terminate_message())?;
    Ok(values)
}

fn write_fragmented(stream: &mut impl Write, message: &[u8]) -> Result<()> {
    let (first, rest) = message.split_at(1);
    stream.write_all(first)?;
    stream.flush()?;
    thread::sleep(Duration::from_millis(10));
    for chunk in rest.chunks(2) {
        stream.write_all(chunk)?;
    }
    Ok(())
}

fn write_in_chunks(stream: &mut impl Write, message: &[u8], chunk_size: usize) -> Result<()> {
    for chunk in message.chunks(chunk_size) {
        stream.write_all(chunk)?;
    }
    Ok(())
}

fn malformed_then_recover(
    addr: SocketAddr,
    label: &str,
    send: impl FnOnce(&mut TcpStream) -> Result<()>,
) -> Result<()> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    send(&mut stream).with_context(|| format!("send {label}"))?;
    drop(stream);
    thread::sleep(Duration::from_millis(25));
    ensure!(
        query_proxy(addr, false, "SELECT 1")? == vec!["1"],
        "valid client failed after {label}"
    );
    Ok(())
}

fn negotiation_then_recover(addr: SocketAddr, code: i32) -> Result<()> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.write_all(&negotiation_request(code))?;
    let mut response = [0u8; 1];
    stream.read_exact(&mut response)?;
    ensure!(
        response == [b'N'],
        "expected negotiation refusal for code {code}"
    );
    drop(stream);
    thread::sleep(Duration::from_millis(25));
    ensure!(
        query_proxy(addr, false, "SELECT 1")? == vec!["1"],
        "valid client failed after negotiation code {code}"
    );
    Ok(())
}

#[cfg(unix)]
fn query_unix_proxy(path: &Path, sql: &str) -> Result<Vec<String>> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    stream.write_all(&startup_message())?;
    read_until_ready(&mut stream)?;
    stream.write_all(&simple_query_message(sql))?;
    let values = read_query_values(&mut stream)?;
    stream.write_all(&terminate_message())?;
    Ok(values)
}

fn read_until_ready(stream: &mut impl Read) -> Result<()> {
    loop {
        let (tag, body) = read_backend_message(stream)?;
        match tag {
            b'R' => {
                ensure!(body.len() >= 4, "authentication message too short");
                let code = i32::from_be_bytes(body[0..4].try_into().unwrap());
                ensure!(code == 0, "unexpected authentication code {code}");
            }
            b'E' => bail!("startup error: {}", error_message(&body)),
            b'Z' => return Ok(()),
            _ => {}
        }
    }
}

fn read_query_values(stream: &mut impl Read) -> Result<Vec<String>> {
    let mut values = Vec::new();
    loop {
        let (tag, body) = read_backend_message(stream)?;
        match tag {
            b'D' => values.extend(data_row_values(&body)?),
            b'E' => bail!("query error: {}", error_message(&body)),
            b'Z' => return Ok(values),
            _ => {}
        }
    }
}

fn read_backend_message(stream: &mut impl Read) -> Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    stream.read_exact(&mut header)?;
    let len = i32::from_be_bytes(header[1..5].try_into().unwrap());
    ensure!(len >= 4, "invalid backend message length {len}");
    let mut body = vec![0u8; len as usize - 4];
    stream.read_exact(&mut body)?;
    Ok((header[0], body))
}

fn data_row_values(body: &[u8]) -> Result<Vec<String>> {
    ensure!(body.len() >= 2, "data row too short");
    let count = i16::from_be_bytes(body[0..2].try_into().unwrap()) as usize;
    let mut offset = 2usize;
    let mut values = Vec::with_capacity(count);

    for _ in 0..count {
        ensure!(offset + 4 <= body.len(), "data row field length missing");
        let len = i32::from_be_bytes(body[offset..offset + 4].try_into().unwrap());
        offset += 4;
        if len < 0 {
            values.push(String::new());
            continue;
        }
        let len = len as usize;
        ensure!(
            offset + len <= body.len(),
            "data row field overruns message"
        );
        values.push(std::str::from_utf8(&body[offset..offset + len])?.to_string());
        offset += len;
    }

    Ok(values)
}

fn error_message(body: &[u8]) -> String {
    let mut offset = 0usize;
    while offset < body.len() {
        let code = body[offset];
        if code == 0 {
            break;
        }
        offset += 1;
        let Some(end) = body[offset..].iter().position(|byte| *byte == 0) else {
            break;
        };
        if code == b'M' {
            return String::from_utf8_lossy(&body[offset..offset + end]).to_string();
        }
        offset += end + 1;
    }
    String::from_utf8_lossy(body).to_string()
}

fn ssl_request() -> Vec<u8> {
    negotiation_request(SSL_REQUEST_CODE)
}

fn negotiation_request(code: i32) -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(&8_i32.to_be_bytes());
    message.extend_from_slice(&code.to_be_bytes());
    message
}

fn cancel_request() -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(&16_i32.to_be_bytes());
    message.extend_from_slice(&CANCEL_REQUEST_CODE.to_be_bytes());
    message.extend_from_slice(&1_i32.to_be_bytes());
    message.extend_from_slice(&2_i32.to_be_bytes());
    message
}

fn startup_message() -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(&0_i32.to_be_bytes());
    message.extend_from_slice(&PROTOCOL_3.to_be_bytes());
    for (key, value) in [
        ("user", "postgres"),
        ("database", "postgres"),
        ("application_name", "oliphaunt-wasix-test"),
    ] {
        message.extend_from_slice(key.as_bytes());
        message.push(0);
        message.extend_from_slice(value.as_bytes());
        message.push(0);
    }
    message.push(0);
    let len = message.len() as i32;
    message[0..4].copy_from_slice(&len.to_be_bytes());
    message
}

fn simple_query_message(sql: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(sql.len() + 6);
    message.push(b'Q');
    message.extend_from_slice(&((sql.len() + 5) as i32).to_be_bytes());
    message.extend_from_slice(sql.as_bytes());
    message.push(0);
    message
}

fn terminate_message() -> Vec<u8> {
    let mut message = Vec::new();
    message.push(b'X');
    message.extend_from_slice(&4_i32.to_be_bytes());
    message
}
