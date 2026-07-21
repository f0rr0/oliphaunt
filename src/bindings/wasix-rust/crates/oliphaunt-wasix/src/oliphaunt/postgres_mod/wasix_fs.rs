use std::fmt;
use std::fs;
use std::future::Future;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tokio::io::ReadBuf;
use wasmer_wasix::virtual_fs;

use super::super::sync_host_fs::SyncHostFileSystem;

const WASIX_DEVICE_FILES: &[&str] = &[
    "null", "zero", "urandom", "stdin", "stdout", "stderr", "tty",
];

static FS_TRACE: FsTraceState = FsTraceState::new();

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsTraceSnapshot {
    enabled: bool,
    open_count: u64,
    read_count: u64,
    read_bytes: u64,
    write_count: u64,
    write_bytes: u64,
    seek_count: u64,
    metadata_count: u64,
    read_dir_count: u64,
    create_dir_count: u64,
    remove_file_count: u64,
    remove_dir_count: u64,
    rename_count: u64,
    set_len_count: u64,
    unlink_count: u64,
    total_elapsed_micros: u64,
    read_elapsed_micros: u64,
    write_elapsed_micros: u64,
    seek_elapsed_micros: u64,
}

struct FsTraceState {
    open_count: AtomicU64,
    read_count: AtomicU64,
    read_bytes: AtomicU64,
    write_count: AtomicU64,
    write_bytes: AtomicU64,
    seek_count: AtomicU64,
    metadata_count: AtomicU64,
    read_dir_count: AtomicU64,
    create_dir_count: AtomicU64,
    remove_file_count: AtomicU64,
    remove_dir_count: AtomicU64,
    rename_count: AtomicU64,
    set_len_count: AtomicU64,
    unlink_count: AtomicU64,
    total_elapsed_micros: AtomicU64,
    read_elapsed_micros: AtomicU64,
    write_elapsed_micros: AtomicU64,
    seek_elapsed_micros: AtomicU64,
}

impl FsTraceState {
    const fn new() -> Self {
        Self {
            open_count: AtomicU64::new(0),
            read_count: AtomicU64::new(0),
            read_bytes: AtomicU64::new(0),
            write_count: AtomicU64::new(0),
            write_bytes: AtomicU64::new(0),
            seek_count: AtomicU64::new(0),
            metadata_count: AtomicU64::new(0),
            read_dir_count: AtomicU64::new(0),
            create_dir_count: AtomicU64::new(0),
            remove_file_count: AtomicU64::new(0),
            remove_dir_count: AtomicU64::new(0),
            rename_count: AtomicU64::new(0),
            set_len_count: AtomicU64::new(0),
            unlink_count: AtomicU64::new(0),
            total_elapsed_micros: AtomicU64::new(0),
            read_elapsed_micros: AtomicU64::new(0),
            write_elapsed_micros: AtomicU64::new(0),
            seek_elapsed_micros: AtomicU64::new(0),
        }
    }

    fn reset(&self) {
        for counter in [
            &self.open_count,
            &self.read_count,
            &self.read_bytes,
            &self.write_count,
            &self.write_bytes,
            &self.seek_count,
            &self.metadata_count,
            &self.read_dir_count,
            &self.create_dir_count,
            &self.remove_file_count,
            &self.remove_dir_count,
            &self.rename_count,
            &self.set_len_count,
            &self.unlink_count,
            &self.total_elapsed_micros,
            &self.read_elapsed_micros,
            &self.write_elapsed_micros,
            &self.seek_elapsed_micros,
        ] {
            counter.store(0, Ordering::Relaxed);
        }
    }

    fn record_total(&self, elapsed: Duration) {
        self.total_elapsed_micros.fetch_add(
            elapsed.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }

    fn snapshot(&self) -> FsTraceSnapshot {
        FsTraceSnapshot {
            enabled: fs_trace_enabled(),
            open_count: self.open_count.load(Ordering::Relaxed),
            read_count: self.read_count.load(Ordering::Relaxed),
            read_bytes: self.read_bytes.load(Ordering::Relaxed),
            write_count: self.write_count.load(Ordering::Relaxed),
            write_bytes: self.write_bytes.load(Ordering::Relaxed),
            seek_count: self.seek_count.load(Ordering::Relaxed),
            metadata_count: self.metadata_count.load(Ordering::Relaxed),
            read_dir_count: self.read_dir_count.load(Ordering::Relaxed),
            create_dir_count: self.create_dir_count.load(Ordering::Relaxed),
            remove_file_count: self.remove_file_count.load(Ordering::Relaxed),
            remove_dir_count: self.remove_dir_count.load(Ordering::Relaxed),
            rename_count: self.rename_count.load(Ordering::Relaxed),
            set_len_count: self.set_len_count.load(Ordering::Relaxed),
            unlink_count: self.unlink_count.load(Ordering::Relaxed),
            total_elapsed_micros: self.total_elapsed_micros.load(Ordering::Relaxed),
            read_elapsed_micros: self.read_elapsed_micros.load(Ordering::Relaxed),
            write_elapsed_micros: self.write_elapsed_micros.load(Ordering::Relaxed),
            seek_elapsed_micros: self.seek_elapsed_micros.load(Ordering::Relaxed),
        }
    }
}

pub fn reset_fs_trace() {
    FS_TRACE.reset();
}

pub fn fs_trace_snapshot() -> FsTraceSnapshot {
    FS_TRACE.snapshot()
}

pub(super) fn wasi_root_with_devices(
    root: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
) -> virtual_fs::Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let devices: Arc<dyn virtual_fs::FileSystem + Send + Sync> =
        Arc::new(virtual_fs::RootFileSystemBuilder::default().build_tmp_ext(&[]));
    let root_with_default_dirs: Arc<dyn virtual_fs::FileSystem + Send + Sync> =
        Arc::new(virtual_fs::OverlayFileSystem::new(
            virtual_fs::ArcFileSystem::new(root),
            [virtual_fs::ArcFileSystem::new(devices.clone())],
        ));
    let mount = virtual_fs::MountFileSystem::new();
    mount.mount(Path::new("/"), root_with_default_dirs)?;
    for name in WASIX_DEVICE_FILES {
        let path = Path::new("/dev").join(name);
        mount.mount_with_source(&path, &path, devices.clone())?;
    }
    Ok(Arc::new(mount))
}

pub(super) struct EagerCopyOverlayFileSystem {
    upper_root: PathBuf,
    lower_root: PathBuf,
    overlay:
        virtual_fs::OverlayFileSystem<virtual_fs::ArcFileSystem, [virtual_fs::ArcFileSystem; 1]>,
}

impl fmt::Debug for EagerCopyOverlayFileSystem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EagerCopyOverlayFileSystem")
            .field("upper_root", &self.upper_root)
            .field("lower_root", &self.lower_root)
            .finish_non_exhaustive()
    }
}

impl EagerCopyOverlayFileSystem {
    pub(super) fn new(upper_root: PathBuf, lower_root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&upper_root)
            .with_context(|| format!("create PGDATA overlay upper {}", upper_root.display()))?;
        let upper_root = upper_root.canonicalize().with_context(|| {
            format!("canonicalize PGDATA overlay upper {}", upper_root.display())
        })?;
        let lower_root = lower_root.canonicalize().with_context(|| {
            format!("canonicalize PGDATA overlay lower {}", lower_root.display())
        })?;
        let upper = virtual_fs::ArcFileSystem::new(host_filesystem(&upper_root)?);
        let lower = virtual_fs::ArcFileSystem::new(host_filesystem(&lower_root)?);
        Ok(Self {
            upper_root,
            lower_root,
            overlay: virtual_fs::OverlayFileSystem::new(upper, [lower]),
        })
    }

    fn ensure_upper_copy(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<()> {
        let Some(relative) = normalize_overlay_path(path)? else {
            return Ok(());
        };

        let upper = self.upper_root.join(&relative);
        if upper.exists() {
            return Ok(());
        }

        let lower = self.lower_root.join(&relative);
        let metadata = match fs::symlink_metadata(&lower) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if conf.create || conf.create_new {
                    self.ensure_upper_parent(&relative)?;
                }
                return Ok(());
            }
            Err(err) => return Err(err.into()),
        };

        if conf.create_new {
            return Err(virtual_fs::FsError::AlreadyExists);
        }
        if metadata.is_dir() {
            return Ok(());
        }
        if !metadata.is_file() {
            return Err(virtual_fs::FsError::Unsupported);
        }

        if let Some(parent) = upper.parent() {
            fs::create_dir_all(parent).map_err(virtual_fs::FsError::from)?;
        }
        if conf.truncate && !conf.read && !conf.append {
            fs::File::create(&upper).map_err(virtual_fs::FsError::from)?;
        } else {
            fs::copy(&lower, &upper).map_err(virtual_fs::FsError::from)?;
        }
        Ok(())
    }

    fn ensure_upper_parent(&self, relative: &Path) -> virtual_fs::Result<()> {
        let Some(parent) = relative.parent() else {
            return Ok(());
        };
        if parent.as_os_str().is_empty() {
            return Ok(());
        }

        let upper_parent = self.upper_root.join(parent);
        if upper_parent.is_dir() {
            return Ok(());
        }

        let lower_parent = self.lower_root.join(parent);
        let metadata = match fs::symlink_metadata(&lower_parent) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(virtual_fs::FsError::EntryNotFound);
            }
            Err(err) => return Err(err.into()),
        };
        if !metadata.is_dir() {
            return Err(virtual_fs::FsError::BaseNotDirectory);
        }

        fs::create_dir_all(upper_parent).map_err(virtual_fs::FsError::from)
    }
}

impl virtual_fs::FileSystem for EagerCopyOverlayFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.overlay.readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.overlay.read_dir(path)
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if let Some(relative) = normalize_overlay_path(path)? {
            self.ensure_upper_parent(&relative)?;
        }
        self.overlay.create_dir(path)
    }

    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        if let Some(relative) = normalize_overlay_path(target)? {
            self.ensure_upper_parent(&relative)?;
        }
        self.overlay.create_symlink(source, target)
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.overlay.remove_dir(path)
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.ensure_upper_copy(from, &mutating_open_config())?;
            if let Some(relative) = normalize_overlay_path(to)? {
                self.ensure_upper_parent(&relative)?;
            }
            self.overlay.rename(from, to).await
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.overlay.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.overlay.symlink_metadata(path)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.overlay.remove_file(path)
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for EagerCopyOverlayFileSystem {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        if conf.would_mutate() {
            self.ensure_upper_copy(path, conf)?;
        }
        virtual_fs::FileSystem::new_open_options(&self.overlay)
            .options(conf.clone())
            .open(path)
    }
}

fn normalize_overlay_path(path: &Path) -> virtual_fs::Result<Option<PathBuf>> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::Prefix(_) => {
                return Err(virtual_fs::FsError::PermissionDenied);
            }
        }
    }
    if relative.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(relative))
    }
}

fn mutating_open_config() -> virtual_fs::OpenOptionsConfig {
    virtual_fs::OpenOptionsConfig {
        read: true,
        write: true,
        create_new: false,
        create: false,
        append: false,
        truncate: false,
    }
}

pub(super) fn host_filesystem(
    host_path: &Path,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let host_fs = SyncHostFileSystem::new(host_path)
        .with_context(|| format!("create host fs rooted at {}", host_path.display()))?;
    Ok(Arc::new(host_fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>)
}

fn fs_trace_enabled() -> bool {
    env_flag_enabled("OLIPHAUNT_WASM_WASIX_FS_TRACE")
}

fn env_flag_enabled(name: &str) -> bool {
    let Some(value) = std::env::var_os(name) else {
        return false;
    };
    !matches!(
        value.to_string_lossy().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "off" | "no"
    )
}

pub(super) fn maybe_trace_filesystem(
    inner: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
) -> Arc<dyn virtual_fs::FileSystem + Send + Sync> {
    if fs_trace_enabled() {
        Arc::new(TracedFileSystem { inner }) as Arc<dyn virtual_fs::FileSystem + Send + Sync>
    } else {
        inner
    }
}

#[derive(Debug)]
struct TracedFileSystem {
    inner: Arc<dyn virtual_fs::FileSystem + Send + Sync>,
}

impl TracedFileSystem {
    fn record<T>(&self, counter: &AtomicU64, operation: impl FnOnce() -> T) -> T {
        counter.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = operation();
        FS_TRACE.record_total(started.elapsed());
        result
    }
}

impl virtual_fs::FileSystem for TracedFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.record(&FS_TRACE.metadata_count, || self.inner.readlink(path))
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.record(&FS_TRACE.read_dir_count, || self.inner.read_dir(path))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.create_dir_count, || self.inner.create_dir(path))
    }

    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.create_dir_count, || {
            self.inner.create_symlink(source, target)
        })
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.remove_dir_count, || self.inner.remove_dir(path))
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        FS_TRACE.rename_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            let started = Instant::now();
            let result = self.inner.rename(from, to).await;
            FS_TRACE.record_total(started.elapsed());
            result
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.record(&FS_TRACE.metadata_count, || self.inner.metadata(path))
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.record(&FS_TRACE.metadata_count, || {
            self.inner.symlink_metadata(path)
        })
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.record(&FS_TRACE.remove_file_count, || self.inner.remove_file(path))
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for TracedFileSystem {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        FS_TRACE.open_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let file = virtual_fs::FileSystem::new_open_options(&self.inner)
            .options(conf.clone())
            .open(path);
        FS_TRACE.record_total(started.elapsed());
        file.map(|inner| Box::new(TracedVirtualFile { inner }) as _)
    }
}

#[derive(Debug)]
struct TracedVirtualFile {
    inner: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
}

impl virtual_fs::VirtualFile for TracedVirtualFile {
    fn last_accessed(&self) -> u64 {
        self.inner.last_accessed()
    }

    fn last_modified(&self) -> u64 {
        self.inner.last_modified()
    }

    fn created_time(&self) -> u64 {
        self.inner.created_time()
    }

    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.inner.set_times(atime, mtime)
    }

    fn size(&self) -> u64 {
        self.inner.size()
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        FS_TRACE.set_len_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = self.inner.set_len(new_size);
        FS_TRACE.record_total(started.elapsed());
        result
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        FS_TRACE.unlink_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = self.inner.unlink();
        FS_TRACE.record_total(started.elapsed());
        result
    }

    fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.inner.get_special_fd()
    }

    fn write_from_mmap(&mut self, offset: u64, len: u64) -> io::Result<()> {
        self.inner.write_from_mmap(offset, len)
    }

    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_read_ready(cx)
    }

    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_write_ready(cx)
    }
}

impl virtual_fs::AsyncRead for TracedVirtualFile {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            let bytes = buf.filled().len().saturating_sub(before) as u64;
            FS_TRACE.read_count.fetch_add(1, Ordering::Relaxed);
            FS_TRACE.read_bytes.fetch_add(bytes, Ordering::Relaxed);
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.read_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }
}

impl virtual_fs::AsyncWrite for TracedVirtualFile {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(bytes)) = &result {
            FS_TRACE.write_count.fetch_add(1, Ordering::Relaxed);
            FS_TRACE
                .write_bytes
                .fetch_add(*bytes as u64, Ordering::Relaxed);
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.write_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_shutdown(cx)
    }
}

impl virtual_fs::AsyncSeek for TracedVirtualFile {
    fn start_seek(self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        let this = self.get_mut();
        FS_TRACE.seek_count.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).start_seek(position);
        let elapsed = started.elapsed();
        FS_TRACE.record_total(elapsed);
        FS_TRACE.seek_elapsed_micros.fetch_add(
            elapsed.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        result
    }

    fn poll_complete(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        let this = self.get_mut();
        let started = Instant::now();
        let result = Pin::new(&mut *this.inner).poll_complete(cx);
        if let Poll::Ready(Ok(_)) = &result {
            let elapsed = started.elapsed();
            FS_TRACE.record_total(elapsed);
            FS_TRACE.seek_elapsed_micros.fetch_add(
                elapsed.as_micros().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        result
    }
}
