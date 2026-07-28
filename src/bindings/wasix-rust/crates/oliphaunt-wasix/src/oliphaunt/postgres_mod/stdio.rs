use std::collections::VecDeque;
use std::fmt;
use std::io::{self, Read, Write};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};

use anyhow::{Result, ensure};
use tokio::io::ReadBuf;
use wasmer_wasix::virtual_fs;

pub(crate) trait ProtocolStream: Read + Write + Send {
    fn read_ready(&mut self) -> io::Result<bool>;
}

#[derive(Debug, Default)]
struct TailCaptureState {
    bytes: VecDeque<u8>,
}

#[derive(Debug, Clone)]
pub(super) struct TailCaptureFile {
    inner: Arc<Mutex<TailCaptureState>>,
    limit: usize,
}

#[derive(Debug, Clone)]
pub(super) struct TailCaptureHandle {
    inner: Arc<Mutex<TailCaptureState>>,
}

impl TailCaptureFile {
    pub(super) fn new(limit: usize) -> (Self, TailCaptureHandle) {
        let inner = Arc::new(Mutex::new(TailCaptureState::default()));
        (
            Self {
                inner: inner.clone(),
                limit,
            },
            TailCaptureHandle { inner },
        )
    }

    fn push_tail(&self, bytes: &[u8]) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        for byte in bytes {
            state.bytes.push_back(*byte);
            while state.bytes.len() > self.limit {
                state.bytes.pop_front();
            }
        }
    }
}

impl TailCaptureHandle {
    pub(super) fn text(&self) -> String {
        let Ok(state) = self.inner.lock() else {
            return "<split initdb output capture lock poisoned>".to_owned();
        };
        let bytes = state.bytes.iter().copied().collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl virtual_fs::AsyncSeek for TailCaptureFile {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl virtual_fs::AsyncRead for TailCaptureFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl virtual_fs::AsyncWrite for TailCaptureFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.push_tail(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let mut total = 0;
        for buf in bufs {
            self.push_tail(buf);
            total += buf.len();
        }
        Poll::Ready(Ok(total))
    }

    fn is_write_vectored(&self) -> bool {
        true
    }
}

#[async_trait::async_trait]
impl virtual_fs::VirtualFile for TailCaptureFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.inner
            .lock()
            .map(|state| state.bytes.len() as u64)
            .unwrap_or(0)
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(self.limit))
    }
}

#[derive(Clone)]
pub(super) struct ProtocolStdioFile {
    state: Arc<ProtocolStdioState>,
}

struct ProtocolStdioState {
    inner: Mutex<ProtocolStdioInner>,
}

#[derive(Default)]
struct ProtocolStdioInner {
    stream: Option<Box<dyn ProtocolStream>>,
    prefix: Vec<u8>,
    prefix_offset: usize,
}

pub(super) struct ProtocolStdioAttachment {
    file: ProtocolStdioFile,
}

impl ProtocolStdioFile {
    pub(super) fn new() -> Self {
        Self {
            state: Arc::new(ProtocolStdioState {
                inner: Mutex::new(ProtocolStdioInner::default()),
            }),
        }
    }

    pub(super) fn attach<S>(&self, stream: S) -> Result<ProtocolStdioAttachment>
    where
        S: ProtocolStream + 'static,
    {
        let mut guard = self
            .state
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("protocol stdio lock poisoned"))?;
        ensure!(
            guard.stream.is_none(),
            "WASIX protocol stdio stream is already attached"
        );
        guard.stream = Some(Box::new(stream));
        guard.prefix.clear();
        guard.prefix_offset = 0;
        Ok(ProtocolStdioAttachment { file: self.clone() })
    }

    fn detach(&self) {
        if let Ok(mut guard) = self.state.inner.lock() {
            guard.stream = None;
            guard.prefix.clear();
            guard.prefix_offset = 0;
        }
    }

    pub(super) fn set_prefix(&self, prefix: Vec<u8>) -> Result<()> {
        let mut guard = self
            .state
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("protocol stdio lock poisoned"))?;
        guard.prefix = prefix;
        guard.prefix_offset = 0;
        Ok(())
    }

    pub(super) fn clear_prefix(&self) -> Result<()> {
        self.set_prefix(Vec::new())
    }

    fn with_inner<R>(
        &self,
        f: impl FnOnce(&mut ProtocolStdioInner) -> io::Result<R>,
    ) -> io::Result<R> {
        let mut guard = self
            .state
            .inner
            .lock()
            .map_err(|_| io::Error::other("protocol stdio lock poisoned"))?;
        f(&mut guard)
    }
}

impl Drop for ProtocolStdioAttachment {
    fn drop(&mut self) {
        self.file.detach();
    }
}

impl fmt::Debug for ProtocolStdioFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProtocolStdioFile").finish_non_exhaustive()
    }
}

impl virtual_fs::VirtualFile for ProtocolStdioFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(virtual_fs::FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.state
            .inner
            .lock()
            .map(|inner| inner.stream.is_some())
            .unwrap_or(false)
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        match self.with_inner(|inner| {
            if inner.prefix_offset < inner.prefix.len() {
                return Ok(true);
            }
            let stream = inner.stream.as_mut().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "WASIX protocol stdio stream is not attached",
                )
            })?;
            stream.read_ready()
        }) {
            Ok(true) => Poll::Ready(Ok(1)),
            Ok(false) => Poll::Pending,
            Err(err) => Poll::Ready(Err(err)),
        }
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        match self.with_inner(|inner| {
            if inner.stream.is_some() {
                Ok(8192)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "WASIX protocol stdio stream is not attached",
                ))
            }
        }) {
            Ok(ready) => Poll::Ready(Ok(ready)),
            Err(err) => Poll::Ready(Err(err)),
        }
    }
}

impl virtual_fs::AsyncRead for ProtocolStdioFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let read = self.with_inner(|inner| {
            let unfilled = buf.initialize_unfilled();
            if inner.prefix_offset < inner.prefix.len() {
                let remaining = &inner.prefix[inner.prefix_offset..];
                let read = remaining.len().min(unfilled.len());
                unfilled[..read].copy_from_slice(&remaining[..read]);
                inner.prefix_offset += read;
                if inner.prefix_offset == inner.prefix.len() {
                    inner.prefix.clear();
                    inner.prefix_offset = 0;
                }
                return Ok(read);
            }
            let stream = inner.stream.as_mut().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "WASIX protocol stdio stream is not attached",
                )
            })?;
            stream.read(unfilled)
        });
        match read {
            Ok(read) => {
                buf.advance(read);
                Poll::Ready(Ok(()))
            }
            Err(err) => Poll::Ready(Err(err)),
        }
    }
}

impl virtual_fs::AsyncWrite for ProtocolStdioFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = self
            .state
            .inner
            .lock()
            .map_err(|_| io::Error::other("protocol stdio lock poisoned"))
            .and_then(|mut inner| match inner.stream.as_mut() {
                Some(stream) => stream.write(buf),
                None => Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "WASIX protocol stdio stream is not attached",
                )),
            });
        Poll::Ready(written)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let flushed = self
            .state
            .inner
            .lock()
            .map_err(|_| io::Error::other("protocol stdio lock poisoned"))
            .and_then(|mut inner| match inner.stream.as_mut() {
                Some(stream) => stream.flush(),
                None => Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "WASIX protocol stdio stream is not attached",
                )),
            });
        Poll::Ready(flushed)
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl virtual_fs::AsyncSeek for ProtocolStdioFile {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}
