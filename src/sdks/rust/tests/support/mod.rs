use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::Path;
use std::time::Duration;

#[allow(dead_code)]
pub(crate) fn fixture_text(source_relative: &str, packaged_relative: &str) -> String {
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        package_root.join("../..").join(source_relative),
        package_root.join("../..").join("src").join(source_relative),
        package_root.join(packaged_relative),
    ];
    for candidate in &candidates {
        if let Ok(value) = fs::read_to_string(candidate) {
            return value;
        }
    }
    panic!(
        "missing canonical test fixture {source_relative}; checked {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

/// Execute a raw frontend-protocol request through the public server endpoint.
///
/// Native server handles intentionally expose lifecycle and endpoint state only;
/// integration tests use this tiny external client to exercise the same wire
/// boundary that PostgreSQL drivers and ORMs use.
pub(crate) fn external_raw_query(
    connection_string: &str,
    request: impl AsRef<[u8]>,
) -> io::Result<Vec<u8>> {
    let (address, user, database) = parse_tcp_connection_string(connection_string)?;
    let mut stream = TcpStream::connect(&address).map_err(|error| {
        io::Error::other(format!(
            "connect external test client to {address}: {error}"
        ))
    })?;
    let timeout = Some(Duration::from_secs(30));
    stream
        .set_read_timeout(timeout)
        .and_then(|()| stream.set_write_timeout(timeout))
        .map_err(|error| io::Error::other(format!("configure external test client: {error}")))?;

    write_startup(&mut stream, &user, &database)?;
    read_until_ready(&mut stream, false, true)?;
    stream
        .write_all(request.as_ref())
        .and_then(|()| stream.flush())
        .map_err(|error| io::Error::other(format!("write external test request: {error}")))?;
    let response = read_until_ready(&mut stream, true, false)?;
    let _ = stream.write_all(&[b'X', 0, 0, 0, 4]);
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
    Ok(response)
}

#[allow(dead_code)]
pub(crate) fn first_data_row_text_values(mut bytes: &[u8]) -> Vec<String> {
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let length = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if length < 4 {
            return Vec::new();
        }
        let total = 1 + length as usize;
        if bytes.len() < total {
            return Vec::new();
        }
        if tag == b'D' {
            return parse_data_row_text_values(&bytes[5..total]);
        }
        bytes = &bytes[total..];
    }
    Vec::new()
}

#[allow(dead_code)]
fn parse_data_row_text_values(payload: &[u8]) -> Vec<String> {
    if payload.len() < 2 {
        return Vec::new();
    }
    let columns = i16::from_be_bytes([payload[0], payload[1]]);
    if columns < 0 {
        return Vec::new();
    }
    let mut offset = 2;
    let mut values = Vec::with_capacity(columns as usize);
    for _ in 0..columns {
        if payload.len().saturating_sub(offset) < 4 {
            return Vec::new();
        }
        let length = i32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]);
        offset += 4;
        if length == -1 {
            values.push("NULL".to_owned());
            continue;
        }
        if length < 0 {
            return Vec::new();
        }
        let length = length as usize;
        if payload.len().saturating_sub(offset) < length {
            return Vec::new();
        }
        values.push(String::from_utf8_lossy(&payload[offset..offset + length]).into_owned());
        offset += length;
    }
    values
}

fn parse_tcp_connection_string(connection_string: &str) -> io::Result<(String, String, String)> {
    let target = connection_string
        .strip_prefix("postgresql://")
        .ok_or_else(|| io::Error::other("external test connection string is not PostgreSQL TCP"))?;
    let (user, target) = target
        .split_once('@')
        .ok_or_else(|| io::Error::other("external test connection string omitted user"))?;
    let (address, database) = target
        .split_once('/')
        .ok_or_else(|| io::Error::other("external test connection string omitted database"))?;
    if !address.contains(':') || address.starts_with('/') {
        return Err(io::Error::other(
            "external test client requires a TCP server listener",
        ));
    }
    let database = database.split('?').next().unwrap_or(database);
    Ok((address.to_owned(), user.to_owned(), database.to_owned()))
}

fn write_startup(stream: &mut TcpStream, user: &str, database: &str) -> io::Result<()> {
    let mut body = 196_608_i32.to_be_bytes().to_vec();
    for value in ["user", user, "database", database] {
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let length = i32::try_from(body.len() + 4)
        .map_err(|_| io::Error::other("external test startup packet is too large"))?;
    stream
        .write_all(&length.to_be_bytes())
        .and_then(|()| stream.write_all(&body))
        .and_then(|()| stream.flush())
        .map_err(|error| io::Error::other(format!("write external test startup: {error}")))
}

fn read_until_ready(
    stream: &mut TcpStream,
    capture: bool,
    error_is_fatal: bool,
) -> io::Result<Vec<u8>> {
    let mut response = Vec::new();
    loop {
        let mut header = [0_u8; 5];
        stream.read_exact(&mut header).map_err(|error| {
            io::Error::other(format!("read external test response header: {error}"))
        })?;
        let length = i32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        if length < 4 {
            return Err(io::Error::other(format!(
                "external test server returned invalid frame length {length}"
            )));
        }
        let body_length = usize::try_from(length - 4)
            .map_err(|_| io::Error::other("external test frame length overflowed"))?;
        let mut body = vec![0_u8; body_length];
        stream.read_exact(&mut body).map_err(|error| {
            io::Error::other(format!("read external test response body: {error}"))
        })?;
        if capture {
            response.extend_from_slice(&header);
            response.extend_from_slice(&body);
        }
        if header[0] == b'E' && error_is_fatal {
            return Err(io::Error::other(
                "external test client startup received ErrorResponse",
            ));
        }
        if header[0] == b'Z' {
            return Ok(response);
        }
    }
}
