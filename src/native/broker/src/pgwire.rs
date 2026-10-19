//! Raw PostgreSQL transport for the broker's embedded backend.
use oliphaunt_query::wire::{CANCEL_REQUEST_CODE, MAX_FRONTEND_MESSAGE, PROTOCOL_3};
use std::io::{self, Read, Write};

pub use crate::exchange::Connection;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}

/// Perform startup with the broker's per-process password and retain the fresh
/// BackendKeyData for independent CancelRequest connections.
pub fn authenticate(
    stream: &mut (impl Read + Write),
    username: &str,
    database: &str,
    password: &str,
) -> io::Result<[u8; 8]> {
    authenticate_inner(stream, username, database, password, false)
}

/// Negotiate the private framed exchange after ordinary PostgreSQL authentication.
pub fn authenticate_exchange(
    stream: &mut (impl Read + Write),
    username: &str,
    database: &str,
    password: &str,
) -> io::Result<crate::exchange::Epoch> {
    authenticate_inner(stream, username, database, password, true)?;
    crate::exchange::read_ready(stream)
}

fn authenticate_inner(
    stream: &mut (impl Read + Write),
    username: &str,
    database: &str,
    password: &str,
    exchange: bool,
) -> io::Result<[u8; 8]> {
    if [username, database, password]
        .iter()
        .any(|value| value.contains('\0'))
    {
        return Err(invalid("PostgreSQL startup values must not contain NUL"));
    }
    let mut startup = PROTOCOL_3.to_be_bytes().to_vec();
    startup.extend_from_slice(
        format!("user\0{username}\0database\0{database}\0client_encoding\0UTF8\0\0").as_bytes(),
    );
    if exchange {
        startup.pop();
        startup.extend_from_slice(crate::exchange::STARTUP_PARAMETER.as_bytes());
        startup.extend_from_slice(b"\x001\0\0");
    }
    stream.write_all(&((startup.len() + 4) as u32).to_be_bytes())?;
    stream.write_all(&startup)?;
    let mut key = None;
    let mut authenticated = false;
    let mut password_sent = false;
    loop {
        let bytes = read_backend(stream)?;
        let body = &bytes[5..];
        match bytes[0] {
            b'R' if body == 3_i32.to_be_bytes() && !password_sent => {
                stream.write_all(&frame(b'p', format!("{password}\0").as_bytes()))?;
                password_sent = true;
            }
            b'R' if body == 0_i32.to_be_bytes() && password_sent => authenticated = true,
            b'R' => return Err(invalid("unsupported broker authentication request")),
            b'K' if body.len() == 8 => key = Some(body.try_into().unwrap()),
            b'E' => {
                let fields = oliphaunt_query::parse_diagnostic_fields(body, "ErrorResponse")
                    .map_err(|error| invalid(error.to_string()))?;
                return Err(invalid(
                    oliphaunt_query::diagnostic(fields, "broker startup failed").message,
                ));
            }
            b'Z' if body == b"I" && authenticated => {
                return key.ok_or_else(|| invalid("broker omitted BackendKeyData"));
            }
            b'Z' => {
                return Err(invalid(
                    "broker became ready before authentication completed",
                ));
            }
            b'S' | b'N' => {}
            _ => return Err(invalid("unexpected broker startup frame")),
        }
    }
}

/// Send the standard independent cancellation packet. PostgreSQL sends no reply.
pub fn cancel(stream: &mut impl Write, key: &[u8; 8]) -> io::Result<()> {
    stream.write_all(&16_i32.to_be_bytes())?;
    stream.write_all(&CANCEL_REQUEST_CODE.to_be_bytes())?;
    stream.write_all(key)
}

fn read_backend(reader: &mut (impl Read + ?Sized)) -> io::Result<Vec<u8>> {
    let mut header = [0; 5];
    reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if !(4..MAX_FRONTEND_MESSAGE).contains(&length) {
        return Err(invalid("invalid backend message length"));
    }
    let mut bytes = vec![0; length + 1];
    bytes[..5].copy_from_slice(&header);
    reader.read_exact(&mut bytes[5..])?;
    Ok(bytes)
}
