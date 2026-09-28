//! Internal mobile broker bridge. Native adapters own process discovery and
//! descriptor transfer; database execution stays on the existing SDK owner.
#![allow(missing_docs)]

mod client;
mod watchdog;
mod worker;

pub use client::{Connection, connect, restore};
pub use oliphaunt_broker::mobile::{Completion, Epoch, Execution, Reason};
pub use worker::{Ready, Retirement, Worker};

use crate::{Error, Result};
use std::sync::Arc;

/// Atomically publish a staged archive without replacing an existing destination.
pub fn publish_backup(staging: &str, destination: &str) -> Result<()> {
    #[cfg(any(target_os = "android", target_os = "linux"))]
    let result = (|| -> std::io::Result<()> {
        let staging = std::ffi::CString::new(staging)?;
        let destination = std::ffi::CString::new(destination)?;
        // Android SELinux denies hard links in app storage. The syscall also
        // supports API levels predating Bionic's renameat2 wrapper (API 30).
        // SAFETY: both paths are valid C strings for the duration of the call.
        let status = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                staging.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    })();
    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    let result = std::fs::hard_link(staging, destination);
    result.map_err(|error| Error::InvalidConfig(format!("publish backup: {error}")))
}

#[test]
fn backup_publication_preserves_existing_destination() {
    let root = std::env::temp_dir().join(format!(
        "oliphaunt-backup-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let staging = root.join("staging");
    let destination = root.join("backup");
    std::fs::write(&staging, b"complete archive").unwrap();
    publish_backup(staging.to_str().unwrap(), destination.to_str().unwrap()).unwrap();
    std::fs::remove_file(&staging).ok();
    std::fs::write(&staging, b"replacement").unwrap();
    assert!(publish_backup(staging.to_str().unwrap(), destination.to_str().unwrap()).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete archive");
    assert_eq!(std::fs::read(&staging).unwrap(), b"replacement");
    std::fs::remove_dir_all(root).unwrap();
}

/// Duplicate a native adapter's borrowed descriptor before retaining it across
/// an async boundary. Invalid descriptors fail without acquiring ownership.
pub fn duplicate_fd(fd: i32) -> Result<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;
    // SAFETY: fcntl validates the descriptor and creates independent ownership.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(Error::InvalidConfig(format!(
            "invalid broker descriptor: {}",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: a successful fcntl returned a fresh descriptor owned by this call.
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicate) })
}

/// Import an adapter socket without allowing a disconnected peer to kill the host.
pub fn duplicate_socket(fd: i32) -> Result<std::os::unix::net::UnixStream> {
    let socket = std::os::unix::net::UnixStream::from(duplicate_fd(fd)?);
    // Rust configures sockets it creates, but From<OwnedFd> adopts an existing
    // descriptor as-is. Darwin needs SO_NOSIGPIPE; Linux writes use MSG_NOSIGNAL.
    #[cfg(target_vendor = "apple")]
    {
        use std::os::fd::AsRawFd;
        let enabled: libc::c_int = 1;
        // SAFETY: a live socket and a correctly sized integer option.
        if unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        } != 0
        {
            return Err(Error::InvalidConfig(format!(
                "configure broker socket: {}",
                std::io::Error::last_os_error()
            )));
        }
    }
    Ok(socket)
}

#[test]
#[cfg(target_vendor = "apple")]
fn imported_socket_disables_sigpipe() {
    use std::os::fd::AsRawFd;
    let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
    let mut enabled: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&enabled) as libc::socklen_t;
    // SAFETY: valid descriptor and integer option buffer. Clear Rust's default
    // to reproduce socketpair descriptors supplied by the Swift adapter.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&enabled as *const libc::c_int).cast(),
                length,
            )
        },
        0
    );
    let imported = duplicate_socket(socket.as_raw_fd()).unwrap();
    // SAFETY: valid descriptor, output buffer, and length pointer.
    assert_eq!(
        unsafe {
            libc::getsockopt(
                imported.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&mut enabled as *mut libc::c_int).cast(),
                &mut length,
            )
        },
        0
    );
    assert_eq!(enabled, 1);
}

/// Implemented by XPC or Binder. Calls only enqueue small control messages.
pub trait Control: Send + Sync + 'static {
    fn cancel(&self, epoch: Epoch, request: u64) -> Result<()>;
    fn close(&self, epoch: Epoch) -> Result<()>;
}

fn failure(
    reason: Reason,
    execution: Execution,
    requires_reopen: bool,
    detail: impl ToString,
) -> Error {
    Error::broker(Completion {
        reason,
        execution,
        requires_reopen,
        detail: detail.to_string(),
    })
}

// An owned background thread polls the existing SDK's executor futures; this
// bridge does not install a second async runtime in either mobile application.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    struct Wake(std::thread::Thread);
    impl std::task::Wake for Wake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Wake(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(result) => return result,
            std::task::Poll::Pending => std::thread::park(),
        }
    }
}
