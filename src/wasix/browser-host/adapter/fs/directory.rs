use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context as TaskContext, Poll},
};

use anyhow::Context;
use js_sys::{Array, Reflect};
use tracing::Instrument;
use virtual_fs::{
    AsyncRead, AsyncReadExt, AsyncSeek, AsyncWrite, AsyncWriteExt, FileSystem, FileType, ReadBuf,
    VirtualFile,
};
use virtual_mio::block_on;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use super::super::{StringOrBytes, utils::Error};

use super::SyncBridgeFileSystem;

/// A directory that can be mounted inside a WASIX instance.
#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct Directory {
    fs: Arc<dyn FileSystem>,
    changes: Arc<Mutex<BTreeSet<String>>>,
    track_changes: bool,
}

#[wasm_bindgen]
impl Directory {
    #[wasm_bindgen(js_name = "__getClassname")]
    pub fn js_classname(&self) -> String {
        "Directory".to_owned()
    }

    /// Mounts share the filesystem and journal without consuming the JS handle.
    #[wasm_bindgen(js_name = "__cloneForMount")]
    pub fn clone_for_mount(&self) -> Directory {
        self.clone()
    }
    /// Create a new {@link Directory}.
    #[wasm_bindgen(constructor)]
    pub fn new(init: Option<DirectoryInit>) -> Result<Directory, Error> {
        match init {
            Some(init) => {
                let fs = init.initialize()?;
                Ok(Directory::from_filesystem(fs))
            }
            None => Ok(Directory::default()),
        }
    }

    /// Create a directory whose filesystem is served synchronously by a
    /// caller-realm JavaScript backend. Oliphaunt uses this only from its
    /// single-backend worker, where OPFS synchronous access handles are legal.
    #[wasm_bindgen(js_name = "createSync")]
    pub fn create_sync(backend: JsValue, capacity: usize) -> Result<Directory, Error> {
        Ok(Directory::from_untracked_filesystem(Arc::new(
            SyncBridgeFileSystem::new(backend, capacity)?,
        )))
    }

    /// Read the contents of a directory.
    #[wasm_bindgen(js_name = "readDir")]
    pub async fn read_dir(&self, mut path: String) -> Result<ListOfDirEntry, Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        let contents = js_sys::Array::new();

        let ty = JsValue::from_str("type");
        let file = JsValue::from_str("file");
        let dir = JsValue::from_str("dir");
        let unknown = JsValue::from_str("unknown");
        let name = JsValue::from_str("name");

        for entry in FileSystem::read_dir(self, path.as_ref())? {
            let entry = entry?;

            let entry_name = entry.file_name().to_string_lossy().to_string();
            let entry_type = match entry.file_type() {
                Ok(FileType { dir: true, .. }) => &dir,
                Ok(FileType { file: true, .. }) => &file,
                _ => &unknown,
            };

            let dir_entry = js_sys::Object::new();
            Reflect::set(&dir_entry, &name, &JsValue::from(entry_name)).map_err(Error::js)?;
            Reflect::set(&dir_entry, &ty, entry_type).map_err(Error::js)?;

            contents.push(&dir_entry);
        }

        Ok(contents.unchecked_into())
    }

    /// Write to a file.
    ///
    /// If a string is provided, it is encoded as UTF-8.
    #[wasm_bindgen(js_name = "writeFile")]
    pub async fn write_file(&self, mut path: String, contents: StringOrBytes) -> Result<(), Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        let mut f = self
            .new_open_options()
            .write(true)
            .create(true)
            .open(&path)?;

        let contents = contents.as_bytes();
        f.write_all(&contents).await?;

        Ok(())
    }

    /// Read the contents of a file from this directory.
    ///
    /// Note that the path is relative to the directory's root.
    #[wasm_bindgen(js_name = "readFile")]
    pub async fn read_file(&self, path: String) -> Result<js_sys::Uint8Array, Error> {
        let buffer = self._read_file(path).await?;
        Ok(js_sys::Uint8Array::from(&buffer[..]))
    }

    /// Read the contents of a file from this directory as a UTF-8 string.
    ///
    /// Note that the path is relative to the directory's root.
    #[wasm_bindgen(js_name = "readTextFile")]
    pub async fn read_text_file(&self, path: String) -> Result<js_sys::JsString, Error> {
        let buffer = self._read_file(path).await?;
        let string = String::from_utf8(buffer)?;
        Ok(string.into())
    }

    /// Create a directory.
    #[wasm_bindgen(js_name = "createDir")]
    pub async fn create_dir(&self, mut path: String) -> Result<(), Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        FileSystem::create_dir(self, path.as_ref())?;

        Ok(())
    }

    /// Remove a directory.
    #[wasm_bindgen(js_name = "removeDir")]
    pub async fn remove_dir(&self, mut path: String) -> Result<(), Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        FileSystem::remove_dir(self, path.as_ref())?;

        Ok(())
    }

    /// Remove a file.
    #[wasm_bindgen(js_name = "removeFile")]
    pub async fn remove_file(&self, mut path: String) -> Result<(), Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        FileSystem::remove_file(self, path.as_ref())?;

        Ok(())
    }

    /// List paths changed through this directory since the last acknowledgement.
    ///
    /// The paths are relative to the directory root. A consumer treats each
    /// path's current state as authoritative, so the same compact journal
    /// represents file writes, creates, removes, and directory renames.
    #[wasm_bindgen(js_name = "changedPaths")]
    pub fn changed_paths(&self) -> Result<Array, Error> {
        let changes = self
            .changes
            .lock()
            .map_err(|_| anyhow::anyhow!("directory change journal is poisoned"))?;
        let values = Array::new();
        for path in changes.iter() {
            values.push(&JsValue::from(path));
        }
        Ok(values)
    }

    /// Discard the current change journal without changing directory contents.
    #[wasm_bindgen(js_name = "clearChanges")]
    pub fn clear_changes(&self) -> Result<(), Error> {
        self.changes
            .lock()
            .map_err(|_| anyhow::anyhow!("directory change journal is poisoned"))?
            .clear();
        Ok(())
    }

    /// Inspect one path without parsing exception text to distinguish a
    /// missing entry from a genuine storage failure.
    #[wasm_bindgen(js_name = "entryType")]
    pub fn entry_type(&self, mut path: String) -> Result<String, Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }
        match self.fs.metadata(Path::new(&path)) {
            Ok(metadata) if metadata.is_dir() => Ok("dir".to_owned()),
            Ok(metadata) if metadata.is_file() => Ok("file".to_owned()),
            Ok(_) => Ok("unknown".to_owned()),
            Err(virtual_fs::FsError::EntryNotFound) => Ok("missing".to_owned()),
            Err(error) => Err(error.into()),
        }
    }
}

impl Directory {
    fn from_filesystem(fs: Arc<dyn FileSystem>) -> Self {
        Self::from_filesystem_with_tracking(fs, true)
    }

    fn from_untracked_filesystem(fs: Arc<dyn FileSystem>) -> Self {
        Self::from_filesystem_with_tracking(fs, false)
    }

    fn from_filesystem_with_tracking(fs: Arc<dyn FileSystem>, track_changes: bool) -> Self {
        Self {
            fs,
            changes: Arc::new(Mutex::new(BTreeSet::new())),
            track_changes,
        }
    }

    fn record_change(&self, path: &Path) {
        if self.track_changes {
            record_change(&self.changes, path);
        }
    }

    async fn _read_file(&self, mut path: String) -> Result<Vec<u8>, Error> {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        let mut f = self.new_open_options().read(true).open(&path)?;
        let mut buffer = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buffer).await?;

        Ok(buffer)
    }
}

impl Default for Directory {
    fn default() -> Self {
        Directory::from_filesystem(Arc::new(virtual_fs::mem_fs::FileSystem::default()))
    }
}

impl FileSystem for Directory {
    #[tracing::instrument(level = "trace", skip(self))]
    fn read_dir(&self, path: &std::path::Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.fs.read_dir(path)
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn create_dir(&self, path: &std::path::Path) -> virtual_fs::Result<()> {
        self.fs.create_dir(path)?;
        self.record_change(path);
        Ok(())
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn remove_dir(&self, path: &std::path::Path) -> virtual_fs::Result<()> {
        self.fs.remove_dir(path)?;
        self.record_change(path);
        Ok(())
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn rename<'a>(
        &'a self,
        from: &'a std::path::Path,
        to: &'a std::path::Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        if !self.track_changes {
            return Box::pin(self.fs.rename(from, to).in_current_span());
        }
        let operation = self.fs.rename(from, to).in_current_span();
        let changes = self.changes.clone();
        let from = from.to_path_buf();
        let to = to.to_path_buf();
        Box::pin(async move {
            operation.await?;
            record_change(&changes, &from);
            record_change(&changes, &to);
            Ok(())
        })
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn metadata(&self, path: &std::path::Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.fs.metadata(path)
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn remove_file(&self, path: &std::path::Path) -> virtual_fs::Result<()> {
        self.fs.remove_file(path)?;
        self.record_change(path);
        Ok(())
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.fs.readlink(path)
    }

    #[tracing::instrument(level = "trace", skip(self))]
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.fs.symlink_metadata(path)
    }
}

impl virtual_fs::FileOpener for Directory {
    #[tracing::instrument(level = "trace", skip(self))]
    fn open(
        &self,
        path: &std::path::Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        if !self.track_changes {
            return self.fs.new_open_options().options(conf.clone()).open(path);
        }

        let existed = if conf.create && !conf.truncate && !conf.create_new {
            self.fs.metadata(path).is_ok()
        } else {
            true
        };
        let file = self
            .fs
            .new_open_options()
            .options(conf.clone())
            .open(path)?;
        if conf.write || conf.append || conf.truncate || conf.create || conf.create_new {
            if conf.truncate || conf.create_new || (conf.create && !existed) {
                self.record_change(path);
            }
            Ok(Box::new(ChangeTrackingFile {
                file,
                path: path.to_path_buf(),
                changes: self.changes.clone(),
            }))
        } else {
            Ok(file)
        }
    }
}

#[derive(Debug)]
struct ChangeTrackingFile {
    file: Box<dyn VirtualFile + Send + Sync + 'static>,
    path: PathBuf,
    changes: Arc<Mutex<BTreeSet<String>>>,
}

impl ChangeTrackingFile {
    fn record_change(&self) {
        record_change(&self.changes, &self.path);
    }
}

impl VirtualFile for ChangeTrackingFile {
    fn last_accessed(&self) -> u64 {
        self.file.last_accessed()
    }

    fn last_modified(&self) -> u64 {
        self.file.last_modified()
    }

    fn created_time(&self) -> u64 {
        self.file.created_time()
    }

    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.file.set_times(atime, mtime)
    }

    fn size(&self) -> u64 {
        self.file.size()
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        self.file.set_len(new_size)?;
        self.record_change();
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        self.file.unlink()?;
        self.record_change();
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.file.is_open()
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.file.get_special_fd()
    }

    fn write_from_mmap(&mut self, offset: u64, len: u64) -> std::io::Result<()> {
        self.file.write_from_mmap(offset, len)?;
        self.record_change();
        Ok(())
    }

    fn poll_read_ready(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.file).poll_read_ready(cx)
    }

    fn poll_write_ready(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.file).poll_write_ready(cx)
    }
}

impl AsyncRead for ChangeTrackingFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.file).poll_read(cx, buffer)
    }
}

impl AsyncWrite for ChangeTrackingFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut *self.file).poll_write(cx, buffer);
        if matches!(result, Poll::Ready(Ok(written)) if written > 0) {
            self.record_change();
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.file).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.file).poll_shutdown(cx)
    }
}

impl AsyncSeek for ChangeTrackingFile {
    fn start_seek(mut self: Pin<&mut Self>, position: std::io::SeekFrom) -> std::io::Result<()> {
        Pin::new(&mut *self.file).start_seek(position)
    }

    fn poll_complete(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<u64>> {
        Pin::new(&mut *self.file).poll_complete(cx)
    }
}

fn record_change(changes: &Mutex<BTreeSet<String>>, path: &Path) {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {}
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                relative.pop();
            }
            std::path::Component::Normal(part) => relative.push(part),
        }
    }
    if let Ok(mut journal) = changes.lock() {
        journal.insert(relative.to_string_lossy().replace('\\', "/"));
    }
}

#[wasm_bindgen(typescript_custom_section)]
const DIRENTRY_TYPE_DEF: &'static str = r#"
/**
 * An entry in a {@link Directory}.
 */
export type DirEntry = {
    /**
     * What type of entry is this?
     */
    type: "file" | "dir" | "unknown";
    /**
     * What is the item's name? (the last component in the path)
     */
    name: string;
};
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "DirEntry[]")]
    pub type ListOfDirEntry;
}

#[wasm_bindgen(typescript_custom_section)]
const DIRECTORY_INIT_TYPE_DEF: &'static str = r#"
/**
 * A mapping from file paths to their contents that can be used to initialize
 * a {@link Directory}.
 */
export type DirectoryInit = Record<string, string | Uint8Array>;
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "DirectoryInit", extends = js_sys::Object)]
    #[derive(Debug, Clone, PartialEq)]
    pub type DirectoryInit;
}

impl DirectoryInit {
    fn initialize(&self) -> Result<Arc<dyn FileSystem>, Error> {
        if let Some(record) = self.dyn_ref::<js_sys::Object>() {
            let fs = in_memory_filesystem(record)?;
            Ok(Arc::new(fs))
        } else {
            unreachable!()
        }
    }
}

/// Construct an in-memory [`FileSystem`] based on an object mapping paths to
/// their contents (`Record<string, string | Uint8Array>`).
fn in_memory_filesystem(record: &js_sys::Object) -> Result<virtual_fs::mem_fs::FileSystem, Error> {
    let fs = virtual_fs::mem_fs::FileSystem::default();

    for (key, contents) in super::super::utils::object_entries(record)? {
        let mut path = String::from(key);
        if !path.starts_with('/') {
            path.insert(0, '/');
        }
        let path = PathBuf::from(path);

        let contents: StringOrBytes = contents.unchecked_into();
        let contents = contents.as_bytes();

        if let Some(parent) = path.parent() {
            create_dir_all(&fs, parent)?;
        }

        tracing::trace!(
            path=%path.display(),
            file.length=contents.len(),
            "Adding file to directory",
        );
        block_on(async {
            let mut f = fs
                .new_open_options()
                .write(true)
                .create_new(true)
                .open(&path)?;
            f.write_all(&contents).await?;
            f.flush().await
        })
        .with_context(|| format!("Unable to write to \"{}\"", path.display()))?;
    }

    Ok(fs)
}

#[tracing::instrument(level = "trace", skip(fs))]
fn create_dir_all(fs: &dyn FileSystem, path: &Path) -> Result<(), anyhow::Error> {
    let ancestors: Vec<&Path> = path.ancestors().collect();

    for ancestor in ancestors.into_iter().rev() {
        if fs.read_dir(ancestor).is_ok() {
            continue;
        }

        fs.create_dir(ancestor).with_context(|| {
            format!("Unable to create the \"{}\" directory", ancestor.display())
        })?;
    }

    Ok(())
}
