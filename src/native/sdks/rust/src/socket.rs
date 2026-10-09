//! Private local sockets with deadlines confined to lifecycle control phases.
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

pub(crate) struct LocalSocket {
    socket: Socket,
    deadline: Option<Instant>,
}

enum Socket {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

macro_rules! socket_call {
    ($this:expr, $method:ident $(, $arg:expr)*) => {
        match &$this.socket {
            Socket::Tcp(socket) => socket.$method($($arg),*),
            #[cfg(unix)]
            Socket::Unix(socket) => socket.$method($($arg),*),
        }
    };
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "local socket deadline exceeded",
        ))
    } else {
        Ok(remaining)
    }
}

impl LocalSocket {
    pub(crate) fn tcp(address: SocketAddr, deadline: Instant) -> io::Result<Self> {
        let socket = TcpStream::connect_timeout(&address, remaining(deadline)?)?;
        socket.set_nodelay(true)?;
        Ok(Self {
            socket: Socket::Tcp(socket),
            deadline: Some(deadline),
        })
    }

    #[cfg(unix)]
    pub(crate) fn unix(path: &std::path::Path, deadline: Instant) -> io::Result<Self> {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::os::unix::ffi::OsStrExt;

        let bytes = path.as_os_str().as_bytes();
        // The OS address contains an inline, NUL-terminated path.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Unix socket path",
            ));
        }
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (out, byte) in address.sun_path.iter_mut().zip(bytes) {
            *out = *byte as _;
        }
        let length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            address.sun_len = length as u8;
        }
        remaining(deadline)?;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let kind = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let kind = libc::SOCK_STREAM;
        let raw = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            // Match std socket construction: broken writes must not raise SIGPIPE.
            let enabled: libc::c_int = 1;
            if unsafe {
                libc::setsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    (&enabled as *const libc::c_int).cast(),
                    size_of::<libc::c_int>() as libc::socklen_t,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let socket = UnixStream::from(fd);
        socket.set_nonblocking(true)?;
        loop {
            remaining(deadline)?;
            let result = unsafe {
                libc::connect(
                    socket.as_raw_fd(),
                    (&address as *const libc::sockaddr_un).cast(),
                    length as libc::socklen_t,
                )
            };
            if result == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EISCONN) => break,
                Some(libc::EAGAIN) => {
                    // A full Unix listener backlog requires a fresh connect attempt.
                    std::thread::sleep(remaining(deadline)?.min(Duration::from_millis(5)));
                }
                Some(libc::EINTR) => continue,
                Some(libc::EINPROGRESS) | Some(libc::EALREADY) => {
                    let mut poll = libc::pollfd {
                        fd: socket.as_raw_fd(),
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    loop {
                        let millis = remaining(deadline)?
                            .as_millis()
                            .saturating_add(1)
                            .min(i32::MAX as u128) as i32;
                        let result = unsafe { libc::poll(&mut poll, 1, millis) };
                        if result > 0 {
                            if let Some(error) = socket.take_error()? {
                                return Err(error);
                            }
                            socket.peer_addr()?;
                            break;
                        }
                        if result < 0
                            && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                        {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    break;
                }
                _ => return Err(error),
            }
        }
        socket.set_nonblocking(false)?;
        Ok(Self {
            socket: Socket::Unix(socket),
            deadline: Some(deadline),
        })
    }

    pub(crate) fn set_deadline(&mut self, deadline: Option<Instant>) -> io::Result<()> {
        self.deadline = deadline;
        if deadline.is_none() {
            socket_call!(self, set_read_timeout, None)?;
            socket_call!(self, set_write_timeout, None)?;
        }
        Ok(())
    }
}

impl Read for LocalSocket {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if let Some(deadline) = self.deadline {
            socket_call!(self, set_read_timeout, Some(remaining(deadline)?))?;
        }
        match &mut self.socket {
            Socket::Tcp(socket) => socket.read(bytes),
            #[cfg(unix)]
            Socket::Unix(socket) => socket.read(bytes),
        }
    }
}

impl Write for LocalSocket {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(deadline) = self.deadline {
            socket_call!(self, set_write_timeout, Some(remaining(deadline)?))?;
        }
        match &mut self.socket {
            Socket::Tcp(socket) => socket.write(bytes),
            #[cfg(unix)]
            Socket::Unix(socket) => socket.write(bytes),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl oliphaunt_broker::pgwire::Connection for LocalSocket {
    fn clone_connection(&self) -> io::Result<Box<dyn oliphaunt_broker::pgwire::Connection>> {
        let socket = match &self.socket {
            Socket::Tcp(socket) => Socket::Tcp(socket.try_clone()?),
            #[cfg(unix)]
            Socket::Unix(socket) => Socket::Unix(socket.try_clone()?),
        };
        Ok(Box::new(Self {
            socket,
            deadline: self.deadline,
        }))
    }
    fn shutdown(&self) {
        let _ = socket_call!(self, shutdown, std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn reads_share_one_deadline_even_when_peer_makes_progress() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = LocalSocket::tcp(
            listener.local_addr().unwrap(),
            Instant::now() + Duration::from_millis(60),
        )
        .unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..20 {
                if peer.write_all(&[1]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let start = Instant::now();
        let error = client.read_exact(&mut [0; 20]).unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(client);
        writer.join().unwrap();
    }

    #[test]
    fn clearing_deadline_restores_ordinary_query_io() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = LocalSocket::tcp(
            listener.local_addr().unwrap(),
            Instant::now() + Duration::from_millis(30),
        )
        .unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        peer.write_all(&[1]).unwrap();
        client.read_exact(&mut [0]).unwrap();
        client.set_deadline(None).unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            peer.write_all(&[2]).unwrap();
        });
        let mut value = [0];
        client.read_exact(&mut value).unwrap();
        assert_eq!(value, [2]);
        writer.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn blocked_writes_obey_deadline() {
        let (socket, _peer) = UnixStream::pair().unwrap();
        let mut client = LocalSocket {
            socket: Socket::Unix(socket),
            deadline: Some(Instant::now() + Duration::from_millis(30)),
        };
        let start = Instant::now();
        let error = client.write_all(&vec![0; 1024 * 1024]).unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unix_connect_with_full_backlog_obeys_deadline() {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixListener;
        let path =
            std::env::temp_dir().join(format!("oliphaunt-backlog-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        // Linux permits backlog + 1 pending connections.
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
        let _pending = UnixStream::connect(&path).unwrap();
        let start = Instant::now();
        let result = LocalSocket::unix(&path, start + Duration::from_millis(30));
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(1));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn expired_deadline_prevents_io() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = LocalSocket::tcp(
            listener.local_addr().unwrap(),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let (_peer, _) = listener.accept().unwrap();
        client.set_deadline(Some(Instant::now())).unwrap();
        assert_eq!(
            client.write(&[1]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            client.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_control_reads_obey_deadline() {
        let (socket, _peer) = UnixStream::pair().unwrap();
        let mut client = LocalSocket {
            socket: Socket::Unix(socket),
            deadline: Some(Instant::now() + Duration::from_millis(30)),
        };
        let start = Instant::now();
        let error = client.read_exact(&mut [0]).unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
