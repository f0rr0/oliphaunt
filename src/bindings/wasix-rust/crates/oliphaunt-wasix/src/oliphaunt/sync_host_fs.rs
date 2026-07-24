use std::fs;
use std::future::Future;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use wasmer_wasix::virtual_fs::{
    self, DirEntry, FileType, FsError, Metadata, OpenOptions, OpenOptionsConfig, ReadDir,
    VirtualFile,
};

#[derive(Debug, Clone)]
pub(crate) struct SyncHostFileSystem {
    root: PathBuf,
}

impl SyncHostFileSystem {
    pub(crate) fn new(root: impl Into<PathBuf>) -> virtual_fs::Result<Self> {
        let root = root.into();
        if !root.exists() {
            return Err(FsError::InvalidInput);
        }
        let root = dunce::canonicalize(root).map_err(FsError::from)?;
        Ok(Self { root })
    }

    fn prepare_path(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        let path = normalize_path(path);

        if matches!(path.components().next(), Some(Component::Prefix(..))) {
            return Err(FsError::InvalidInput);
        }

        if self.root != Path::new("/") && path.starts_with(&self.root) {
            return Err(FsError::InvalidInput);
        }

        let path = path.strip_prefix("/").unwrap_or(&path);
        let path = self.root.join(path);

        debug_assert!(path.starts_with(&self.root));
        Ok(path)
    }
}

impl virtual_fs::FileSystem for SyncHostFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        fs::read_link(self.prepare_path(path)?).map_err(FsError::from)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        let path = self.prepare_path(path)?;
        let mut data = fs::read_dir(path)?
            .map(|entry| {
                let entry = entry?;
                let path = entry
                    .path()
                    .strip_prefix(&self.root)
                    .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?
                    .to_owned();
                let path = Path::new("/").join(path);
                Ok(DirEntry {
                    path,
                    metadata: entry
                        .metadata()
                        .map(metadata_from_std)
                        .map_err(FsError::from),
                })
            })
            .collect::<std::result::Result<Vec<_>, io::Error>>()?;
        data.sort_by(|a, b| a.path.file_name().cmp(&b.path.file_name()));
        Ok(ReadDir::new(data))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        let path = self.prepare_path(path)?;
        if path.parent().is_none() {
            return Err(FsError::BaseNotDirectory);
        }
        fs::create_dir(path).map_err(FsError::from)
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        let path = self.prepare_path(path)?;
        if path.parent().is_none() {
            return Err(FsError::BaseNotDirectory);
        }
        if path.is_dir()
            && fs::read_dir(&path)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
        {
            return Err(FsError::DirectoryNotEmpty);
        }
        fs::remove_dir(path).map_err(FsError::from)
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let norm_from = normalize_path(from);
            let norm_to = normalize_path(to);

            if norm_from.parent().is_none() || norm_to.parent().is_none() {
                return Err(FsError::BaseNotDirectory);
            }

            let from = self.prepare_path(from)?;
            let to = self.prepare_path(to)?;

            if !from.exists() {
                return Err(FsError::EntryNotFound);
            }
            if !from.parent().is_some_and(Path::exists) || !to.parent().is_some_and(Path::exists) {
                return Err(FsError::EntryNotFound);
            }

            fs::rename(from, to).map_err(FsError::from)
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        fs::metadata(self.prepare_path(path)?)
            .map(metadata_from_std)
            .map_err(FsError::from)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        fs::symlink_metadata(self.prepare_path(path)?)
            .map(metadata_from_std)
            .map_err(FsError::from)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        let path = self.prepare_path(path)?;
        if path.parent().is_none() {
            return Err(FsError::BaseNotDirectory);
        }
        fs::remove_file(path).map_err(FsError::from)
    }

    fn new_open_options(&self) -> OpenOptions<'_> {
        OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for SyncHostFileSystem {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let path = self.prepare_path(path)?;
        let append = conf.append() && !conf.truncate();
        let file = fs::OpenOptions::new()
            .read(conf.read())
            .write(conf.write())
            .create_new(conf.create_new())
            .create(conf.create())
            .append(append)
            .truncate(conf.truncate())
            .open(&path)
            .map_err(FsError::from)?;

        Ok(Box::new(SyncHostFile::new(file, path)) as Box<dyn VirtualFile + Send + Sync + 'static>)
    }
}

#[derive(Debug)]
struct SyncHostFile {
    file: fs::File,
    position: u64,
    host_path: PathBuf,
}

impl SyncHostFile {
    fn new(file: fs::File, host_path: PathBuf) -> Self {
        Self {
            file,
            position: 0,
            host_path,
        }
    }

    fn metadata(&self) -> io::Result<fs::Metadata> {
        self.file.metadata()
    }
}

impl VirtualFile for SyncHostFile {
    fn last_accessed(&self) -> u64 {
        self.metadata()
            .ok()
            .and_then(|metadata| metadata.accessed().ok())
            .map(system_time_nanos)
            .unwrap_or(0)
    }

    fn last_modified(&self) -> u64 {
        self.metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(system_time_nanos)
            .unwrap_or(0)
    }

    fn created_time(&self) -> u64 {
        self.metadata()
            .ok()
            .and_then(|metadata| metadata.created().ok())
            .map(system_time_nanos)
            .unwrap_or(0)
    }

    fn size(&self) -> u64 {
        self.metadata().map(|metadata| metadata.len()).unwrap_or(0)
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        self.file.set_len(new_size).map_err(FsError::from)
    }

    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        let atime = atime.map(nanos_to_file_time);
        let mtime = mtime.map(nanos_to_file_time);
        filetime::set_file_handle_times(&self.file, atime, mtime).map_err(|_| FsError::IOError)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        fs::remove_file(&self.host_path).map_err(FsError::from)
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let file = self.get_mut();
        Poll::Ready(
            file.file
                .metadata()
                .map(|metadata| metadata.len().saturating_sub(file.position) as usize),
        )
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}

impl AsyncRead for SyncHostFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let file = self.get_mut();
        let result = read_at(&file.file, buf.initialize_unfilled(), file.position).map(|read| {
            file.position = file.position.saturating_add(read as u64);
            buf.advance(read);
        });
        Poll::Ready(result)
    }
}

impl AsyncWrite for SyncHostFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let file = self.get_mut();
        let result = write_at(&file.file, buf, file.position).inspect(|written| {
            file.position = file.position.saturating_add(*written as u64);
        });
        Poll::Ready(result)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(self.get_mut().file.flush())
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(self.get_mut().file.flush())
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let file = self.get_mut();
        let mut total = 0usize;
        for buf in bufs.iter().filter(|buf| !buf.is_empty()) {
            match write_at(&file.file, buf, file.position) {
                Ok(written) => {
                    file.position = file.position.saturating_add(written as u64);
                    total += written;
                    if written != buf.len() {
                        break;
                    }
                }
                Err(_) if total > 0 => break,
                Err(err) => return Poll::Ready(Err(err)),
            }
        }
        Poll::Ready(Ok(total))
    }

    fn is_write_vectored(&self) -> bool {
        true
    }
}

impl AsyncSeek for SyncHostFile {
    fn start_seek(self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        let file = self.get_mut();
        let current = file.position as i128;
        let target = match position {
            io::SeekFrom::Start(offset) => offset as i128,
            io::SeekFrom::Current(delta) => current + delta as i128,
            io::SeekFrom::End(delta) => file.file.metadata()?.len() as i128 + delta as i128,
        };
        if target < 0 || target > u64::MAX as i128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid seek before start or past u64::MAX",
            ));
        }
        file.position = target as u64;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.get_mut().position))
    }
}

#[cfg(unix)]
fn read_at(file: &fs::File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buf, offset)
}

#[cfg(windows)]
fn read_at(file: &fs::File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buf, offset)
}

#[cfg(not(any(unix, windows)))]
fn read_at(file: &fs::File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::io::{Read as _, Seek as _};

    let mut file = file.try_clone()?;
    file.seek(io::SeekFrom::Start(offset))?;
    file.read(buf)
}

#[cfg(unix)]
fn write_at(file: &fs::File, buf: &[u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.write_at(buf, offset)
}

#[cfg(windows)]
fn write_at(file: &fs::File, buf: &[u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_write(buf, offset)
}

#[cfg(not(any(unix, windows)))]
fn write_at(file: &fs::File, buf: &[u8], offset: u64) -> io::Result<usize> {
    use std::io::{Seek as _, Write as _};

    let mut file = file.try_clone()?;
    file.seek(io::SeekFrom::Start(offset))?;
    file.write(buf)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();
    let mut normalized = if let Some(Component::Prefix(prefix)) = components.peek().cloned() {
        components.next();
        PathBuf::from(prefix.as_os_str())
    } else {
        PathBuf::new()
    };

    for component in components {
        match component {
            Component::Prefix(_) => unreachable!(),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    normalized
}

fn metadata_from_std(metadata: fs::Metadata) -> Metadata {
    let filetype = metadata.file_type();
    let (char_device, block_device, socket, fifo) = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            (
                filetype.is_char_device(),
                filetype.is_block_device(),
                filetype.is_socket(),
                filetype.is_fifo(),
            )
        }
        #[cfg(not(unix))]
        {
            (false, false, false, false)
        }
    };

    Metadata {
        ft: FileType {
            dir: filetype.is_dir(),
            file: filetype.is_file(),
            symlink: filetype.is_symlink(),
            char_device,
            block_device,
            socket,
            fifo,
        },
        accessed: metadata.accessed().map(system_time_nanos).unwrap_or(0),
        created: metadata.created().map(system_time_nanos).unwrap_or(0),
        modified: metadata.modified().map(system_time_nanos).unwrap_or(0),
        len: metadata.len(),
    }
}

fn system_time_nanos(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

fn nanos_to_file_time(nanos: u64) -> filetime::FileTime {
    filetime::FileTime::from_unix_time(
        (nanos / 1_000_000_000) as i64,
        (nanos % 1_000_000_000) as u32,
    )
}
