use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
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
    /// A host directory allocated for this database and removed with it.
    TemporaryDirectory,
    /// A caller-owned host directory retained after the database closes.
    Directory(PathBuf),
    /// A retained directory resolved from the platform application-data path.
    ApplicationData(ApplicationData),
}

/// A platform application-data identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationData {
    qualifier: String,
    organization: String,
    application: String,
}

impl ApplicationData {
    pub fn new(
        qualifier: impl Into<String>,
        organization: impl Into<String>,
        application: impl Into<String>,
    ) -> Self {
        Self {
            qualifier: qualifier.into(),
            organization: organization.into(),
            application: application.into(),
        }
    }

    pub fn qualifier(&self) -> &str {
        &self.qualifier
    }

    pub fn organization(&self) -> &str {
        &self.organization
    }

    pub fn application(&self) -> &str {
        &self.application
    }
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
pub(crate) enum PgDataStorage {
    HostDirectory,
    Memory(Arc<dyn FileSystem + Send + Sync>),
}

impl PgDataStorage {
    pub(crate) fn memory() -> Self {
        Self::Memory(Arc::new(virtual_fs::mem_fs::FileSystem::default()))
    }

    pub(crate) fn memory_filesystem(&self) -> Option<&Arc<dyn FileSystem + Send + Sync>> {
        match self {
            Self::HostDirectory => None,
            Self::Memory(filesystem) => Some(filesystem),
        }
    }
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
