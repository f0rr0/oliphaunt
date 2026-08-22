use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use wasmer_wasix::virtual_fs;

use super::super::sync_host_fs::SyncHostFileSystem;

const WASIX_DEVICE_FILES: &[&str] = &[
    "null", "zero", "urandom", "stdin", "stdout", "stderr", "tty",
];

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

pub(super) fn host_filesystem(
    host_path: &Path,
) -> Result<Arc<dyn virtual_fs::FileSystem + Send + Sync>> {
    let host_fs = SyncHostFileSystem::new(host_path)
        .with_context(|| format!("create host fs rooted at {}", host_path.display()))?;
    Ok(Arc::new(host_fs))
}
