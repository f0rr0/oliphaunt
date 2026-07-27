#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::fs;
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use crate::error::{Error, Result};

const ENV_PGDATA_COPY_MODE: &str = "OLIPHAUNT_PGDATA_COPY_MODE";

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn clonefile(src: *const c_char, dst: *const c_char, flags: u32) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CopyMode {
    PreferClone,
    ByteCopy,
}

pub(super) fn pgdata_template_copy_mode() -> CopyMode {
    match std::env::var(ENV_PGDATA_COPY_MODE) {
        Ok(value) if matches!(value.as_str(), "clone" | "prefer-clone" | "prefer_clone") => {
            CopyMode::PreferClone
        }
        Ok(value)
            if matches!(
                value.as_str(),
                "copy" | "byte-copy" | "byte_copy" | "physical-copy" | "physical_copy"
            ) =>
        {
            CopyMode::ByteCopy
        }
        _ => CopyMode::ByteCopy,
    }
}

pub(super) fn copy_directory_filtered(
    source: &Path,
    destination: &Path,
    should_copy_file: fn(&Path) -> bool,
) -> Result<()> {
    fn walk(
        source_root: &Path,
        current: &Path,
        destination: &Path,
        should_copy_file: fn(&Path) -> bool,
    ) -> Result<()> {
        for entry in fs::read_dir(current)
            .map_err(|err| Error::Engine(format!("read directory {}: {err}", current.display())))?
        {
            let entry =
                entry.map_err(|err| Error::Engine(format!("read directory entry: {err}")))?;
            let source_path = entry.path();
            let relative = source_path.strip_prefix(source_root).map_err(|err| {
                Error::Engine(format!(
                    "strip source prefix {} from {}: {err}",
                    source_root.display(),
                    source_path.display()
                ))
            })?;
            let target_path = destination.join(relative);
            if source_path.is_dir() {
                fs::create_dir_all(&target_path).map_err(|err| {
                    Error::Engine(format!("create directory {}: {err}", target_path.display()))
                })?;
                walk(source_root, &source_path, destination, should_copy_file)?;
            } else if source_path.is_file() && should_copy_file(relative) {
                copy_file_preserving_permissions(&source_path, &target_path)?;
            }
        }
        Ok(())
    }

    fs::create_dir_all(destination).map_err(|err| {
        Error::Engine(format!("create directory {}: {err}", destination.display()))
    })?;
    walk(source, source, destination, should_copy_file)
}

pub(super) fn copy_directory_tree(source: &Path, destination: &Path, mode: CopyMode) -> Result<()> {
    let metadata = fs::metadata(source)
        .map_err(|err| Error::Engine(format!("stat directory {}: {err}", source.display())))?;
    fs::create_dir_all(destination).map_err(|err| {
        Error::Engine(format!("create directory {}: {err}", destination.display()))
    })?;
    fs::set_permissions(destination, metadata.permissions()).map_err(|err| {
        Error::Engine(format!(
            "set permissions on directory {}: {err}",
            destination.display()
        ))
    })?;

    for entry in sorted_read_dir(source)? {
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|err| {
            Error::Engine(format!(
                "read file type for {}: {err}",
                source_path.display()
            ))
        })?;
        if file_type.is_dir() {
            copy_directory_tree(&source_path, &target_path, mode)?;
        } else if file_type.is_file() {
            copy_file_with_mode(&source_path, &target_path, mode)?;
        } else if file_type.is_symlink() {
            copy_symlink(&source_path, &target_path)?;
        }
    }
    Ok(())
}

pub(super) fn copy_file_preserving_permissions(source: &Path, destination: &Path) -> Result<()> {
    copy_file_with_mode(source, destination, CopyMode::PreferClone)
}

fn copy_file_with_mode(source: &Path, destination: &Path, mode: CopyMode) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    let permissions = fs::metadata(source)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", source.display())))?
        .permissions();
    if mode != CopyMode::PreferClone || try_clone_file(source, destination).is_err() {
        fs::copy(source, destination).map_err(|err| {
            Error::Engine(format!(
                "copy {} -> {}: {err}",
                source.display(),
                destination.display()
            ))
        })?;
    }
    fs::set_permissions(destination, permissions).map_err(|err| {
        Error::Engine(format!(
            "set permissions on {}: {err}",
            destination.display()
        ))
    })
}

#[cfg(target_os = "macos")]
fn try_clone_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let rc = unsafe { clonefile(source.as_ptr(), destination.as_ptr(), 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn try_clone_file(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "copy-on-write clone is not available on this platform",
    ))
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<()> {
    let target = fs::read_link(source)
        .map_err(|err| Error::Engine(format!("read symlink {}: {err}", source.display())))?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    std::os::unix::fs::symlink(&target, destination).map_err(|err| {
        Error::Engine(format!(
            "copy symlink {} -> {}: {err}",
            source.display(),
            destination.display()
        ))
    })
}

#[cfg(not(unix))]
fn copy_symlink(source: &Path, _destination: &Path) -> Result<()> {
    Err(Error::Engine(format!(
        "cannot copy symlink {} on this platform",
        source.display()
    )))
}

pub(super) fn sorted_read_dir(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .map_err(|err| Error::Engine(format!("read directory {}: {err}", path.display())))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| {
            Error::Engine(format!("read directory entry in {}: {err}", path.display()))
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

pub(super) fn directory_is_empty(path: &Path) -> Result<bool> {
    let mut entries = fs::read_dir(path)
        .map_err(|err| Error::Engine(format!("read directory {}: {err}", path.display())))?;
    entries
        .next()
        .transpose()
        .map(|entry| entry.is_none())
        .map_err(|err| Error::Engine(format!("read directory entry in {}: {err}", path.display())))
}

pub(super) fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::Engine(format!("remove {}: {err}", path.display()))),
    }
}
