use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Runtime;
use wasmer_wasix::virtual_fs::{self, FileSystem};

/// The storage used for PostgreSQL's mutable database files.
///
/// Storage and initialization are deliberately independent. For example, a
/// memory database can be initialized from the packaged template or from an
/// archive, while a directory can be initialized with `initdb`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DatabaseStorage {
    /// A true in-memory WASIX filesystem. No host PGDATA directory is created.
    #[default]
    Memory,
    /// A caller-owned host directory retained after the database closes.
    Directory(PathBuf),
}

/// How a database is initialized when its storage does not contain a cluster.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DatabaseInitialization {
    /// Install the PostgreSQL cluster template packaged with this runtime.
    #[default]
    PackagedTemplate,
    /// Run the packaged WASIX `initdb` tool.
    FreshInitdb,
    /// Initialize from a same-version physical backup produced by
    /// [`Oliphaunt::backup`](crate::Oliphaunt::backup).
    PhysicalArchive(Vec<u8>),
}

#[derive(Debug, Clone)]
pub(crate) enum StorageRoot {
    HostDirectory(PathBuf),
    Memory(Arc<dyn FileSystem + Send + Sync>),
}

impl StorageRoot {
    pub(crate) fn host_directory(path: impl Into<PathBuf>) -> Self {
        Self::HostDirectory(path.into())
    }

    pub(crate) fn memory() -> Self {
        Self::Memory(Arc::new(virtual_fs::mem_fs::FileSystem::default()))
    }

    pub(crate) fn memory_filesystem(&self) -> Option<&Arc<dyn FileSystem + Send + Sync>> {
        match self {
            Self::HostDirectory(_) => None,
            Self::Memory(filesystem) => Some(filesystem),
        }
    }

    pub(crate) fn is_durable_host_directory(&self) -> bool {
        matches!(self, Self::HostDirectory(_))
    }

    #[cfg(all(test, feature = "extensions"))]
    pub(crate) fn host_path(&self) -> Option<&Path> {
        match self {
            Self::HostDirectory(path) => Some(path),
            Self::Memory(_) => None,
        }
    }

    pub(crate) fn create_dir_all(&self, path: &Path) -> Result<()> {
        match self {
            Self::HostDirectory(root) => {
                let path = storage_host_path(root, path)?;
                std::fs::create_dir_all(&path)
                    .with_context(|| format!("create storage directory {}", path.display()))
            }
            Self::Memory(filesystem) => vfs_create_dir_all(filesystem.as_ref(), path),
        }
    }

    pub(crate) fn write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        match self {
            Self::HostDirectory(root) => {
                let path = storage_host_path(root, path)?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).with_context(|| {
                        format!("create storage directory {}", parent.display())
                    })?;
                }
                std::fs::write(&path, bytes)
                    .with_context(|| format!("write storage file {}", path.display()))
            }
            Self::Memory(filesystem) => vfs_write(filesystem.as_ref(), path, bytes),
        }
    }

    #[cfg(feature = "extensions")]
    pub(crate) fn read(&self, path: &Path) -> Result<Vec<u8>> {
        match self {
            Self::HostDirectory(root) => {
                let path = storage_host_path(root, path)?;
                std::fs::read(&path)
                    .with_context(|| format!("read storage file {}", path.display()))
            }
            Self::Memory(filesystem) => vfs_read(filesystem.as_ref(), path),
        }
    }

    pub(crate) fn read_optional(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        match self {
            Self::HostDirectory(root) => {
                let path = storage_host_path(root, path)?;
                match std::fs::read(&path) {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(error) => {
                        Err(error).with_context(|| format!("read storage file {}", path.display()))
                    }
                }
            }
            Self::Memory(filesystem) => match filesystem.metadata(path) {
                Ok(metadata) if metadata.is_file() => vfs_read(filesystem.as_ref(), path).map(Some),
                Ok(_) | Err(virtual_fs::FsError::EntryNotFound) => Ok(None),
                Err(error) => {
                    Err(error).with_context(|| format!("stat virtual file {}", path.display()))
                }
            },
        }
    }

    pub(crate) fn remove_file_if_exists(&self, path: &Path) -> Result<()> {
        match self {
            Self::HostDirectory(root) => {
                let path = storage_host_path(root, path)?;
                match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error)
                        .with_context(|| format!("remove storage file {}", path.display())),
                }
            }
            Self::Memory(filesystem) => vfs_remove_file_if_exists(filesystem.as_ref(), path),
        }
    }

    pub(crate) fn is_dir(&self, path: &Path) -> bool {
        match self {
            Self::HostDirectory(root) => {
                storage_host_path(root, path).is_ok_and(|path| path.is_dir())
            }
            Self::Memory(filesystem) => filesystem
                .metadata(path)
                .is_ok_and(|metadata| metadata.is_dir()),
        }
    }

    pub(crate) fn is_file(&self, path: &Path) -> bool {
        match self {
            Self::HostDirectory(root) => {
                storage_host_path(root, path).is_ok_and(|path| path.is_file())
            }
            Self::Memory(filesystem) => filesystem
                .metadata(path)
                .is_ok_and(|metadata| metadata.is_file()),
        }
    }
}

pub(crate) type PgDataStorage = StorageRoot;

fn storage_host_path(root: &Path, path: &Path) -> Result<PathBuf> {
    let mut destination = root.to_path_buf();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => destination.push(part),
            _ => bail!("storage path must stay below its root: {}", path.display()),
        }
    }
    Ok(destination)
}

static VFS_IO_RUNTIME: OnceLock<Runtime> = OnceLock::new();

fn vfs_io_runtime() -> &'static Runtime {
    VFS_IO_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .thread_name("oliphaunt-wasix-vfs")
            .build()
            .expect("create Oliphaunt WASIX VFS runtime")
    })
}

fn block_on_vfs<F, T>(future: F) -> T
where
    F: Future<Output = T> + Send,
    T: Send,
{
    let runtime = vfs_io_runtime();
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::scope(|scope| {
            scope
                .spawn(move || runtime.block_on(future))
                .join()
                .unwrap_or_else(|payload| std::panic::resume_unwind(payload))
        });
    }
    runtime.block_on(future)
}

pub(crate) fn vfs_create_dir_all(
    filesystem: &(dyn FileSystem + Send + Sync),
    path: &Path,
) -> Result<()> {
    virtual_fs::create_dir_all(filesystem, path)
        .with_context(|| format!("create virtual directory {}", path.display()))
}

pub(crate) fn vfs_write(
    filesystem: &(dyn FileSystem + Send + Sync),
    path: &Path,
    bytes: &[u8],
) -> Result<()> {
    if let Some(parent) = path.parent() {
        vfs_create_dir_all(filesystem, parent)?;
    }
    let mut file = filesystem
        .new_open_options()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .with_context(|| format!("open virtual file {} for writing", path.display()))?;
    block_on_vfs(async {
        file.write_all(bytes).await?;
        file.flush().await
    })
    .with_context(|| format!("write virtual file {}", path.display()))
}

pub(crate) fn vfs_read(
    filesystem: &(dyn FileSystem + Send + Sync),
    path: &Path,
) -> Result<Vec<u8>> {
    let mut file = filesystem
        .new_open_options()
        .read(true)
        .open(path)
        .with_context(|| format!("open virtual file {} for reading", path.display()))?;
    let mut bytes = Vec::new();
    block_on_vfs(file.read_to_end(&mut bytes))
        .with_context(|| format!("read virtual file {}", path.display()))?;
    Ok(bytes)
}

pub(crate) fn vfs_file_exists(filesystem: &(dyn FileSystem + Send + Sync), path: &Path) -> bool {
    filesystem
        .metadata(path)
        .is_ok_and(|metadata| metadata.is_file())
}

pub(crate) fn vfs_remove_file_if_exists(
    filesystem: &(dyn FileSystem + Send + Sync),
    path: &Path,
) -> Result<()> {
    match filesystem.remove_file(path) {
        Ok(()) | Err(virtual_fs::FsError::EntryNotFound) => Ok(()),
        Err(err) => Err(err).with_context(|| format!("remove virtual file {}", path.display())),
    }
}
