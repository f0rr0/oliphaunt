//! Raw PostgreSQL transport for the broker's embedded backend.
use oliphaunt_query::wire::{CANCEL_REQUEST_CODE, MAX_FRONTEND_MESSAGE, PROTOCOL_3};
use std::io::{self, Read, Write};

/// A local SQL socket whose write half can progress while results are drained.
pub trait Connection: Read + Write + Send {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>>;
    fn shutdown(&self);
}

impl Connection for std::net::TcpStream {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
}
#[cfg(unix)]
impl Connection for std::os::unix::net::UnixStream {
    fn clone_connection(&self) -> io::Result<Box<dyn Connection>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
}

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

/// Count actual ReadyForQuery boundaries before any bytes are written. An
/// incomplete batch cannot be submitted to this complete-request API.
pub fn completion_count(request: &[u8]) -> io::Result<usize> {
    if request.len() > MAX_FRONTEND_MESSAGE {
        return Err(invalid("broker request exceeds size limit"));
    }
    let mut remaining = request;
    let mut count = 0;
    let mut last = 0;
    while !remaining.is_empty() {
        if remaining.len() < 5 {
            return Err(invalid("truncated frontend frame"));
        }
        let length = u32::from_be_bytes(remaining[1..5].try_into().unwrap()) as usize;
        if length < 4 || length >= remaining.len() {
            return Err(invalid("invalid frontend frame length"));
        }
        last = remaining[0];
        if matches!(last, b'Q' | b'S') {
            count += 1;
        }
        if matches!(last, b'X' | b'p') {
            return Err(invalid("connection control is not a query request"));
        }
        remaining = &remaining[length + 1..];
    }
    if count == 0 || !matches!(last, b'Q' | b'S' | b'c' | b'f') {
        return Err(invalid(
            "broker request must include a complete Query or Sync boundary",
        ));
    }
    Ok(count)
}

/// Forward raw backend frames, retaining the first callback error while draining
/// all promised ReadyForQuery boundaries. A transport error supersedes a callback
/// error because recovery could not be established.
pub fn exchange<E>(
    stream: &mut (impl Connection + ?Sized),
    request: &[u8],
    callback: &mut impl FnMut(&[u8]) -> Result<(), E>,
) -> io::Result<Option<E>> {
    let boundaries = completion_count(request)?;
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
        let bytes = read_backend(stream)?;
        if callback_error.is_none() {
            callback_error = callback(&bytes).err();
        }
        if bytes[0] == b'Z' {
            if bytes.len() != 6 || !matches!(bytes[5], b'I' | b'T' | b'E') {
                return Err(invalid("invalid ReadyForQuery frame"));
            }
            boundaries -= 1;
        }
    }
    Ok(callback_error)
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_batches_preserve_every_ready_boundary() {
        let mut bytes = oliphaunt_query::simple_query("SELECT 1").unwrap();
        bytes.extend(oliphaunt_query::simple_query("SELECT 2").unwrap());
        assert_eq!(completion_count(&bytes).unwrap(), 2);
        assert!(completion_count(&frame(b'H', b"")).is_err());
        bytes.pop();
        assert!(completion_count(&bytes).is_err());
    }
}
