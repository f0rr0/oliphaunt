use std::fs::{self, File};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::files::sorted_read_dir;
use crate::error::{Error, Result};
use crate::extension::extension_sql_file_belongs;

const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

pub(super) fn new_state() -> u64 {
    FNV_OFFSET_BASIS
}

pub(super) fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn fingerprint_directory_filtered(
    state: &mut u64,
    source_root: &Path,
    current: &Path,
    should_include_file: fn(&Path) -> bool,
) -> Result<()> {
    for entry in sorted_read_dir(current)? {
        let source = entry.path();
        let relative = source.strip_prefix(source_root).map_err(|err| {
            Error::Engine(format!(
                "strip source prefix {} from {}: {err}",
                source_root.display(),
                source.display()
            ))
        })?;
        if source.is_dir() {
            fingerprint_directory_filtered(state, source_root, &source, should_include_file)?;
        } else if source.is_file() && should_include_file(relative) {
            fingerprint_file(state, source_root, &source)?;
        }
    }
    Ok(())
}

pub(super) fn fingerprint_named_extension_sql_files(
    state: &mut u64,
    source_share: &Path,
    sql_name: &str,
) -> Result<()> {
    let source_dir = source_share.join("extension");
    for entry in sorted_read_dir(&source_dir)? {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if extension_sql_file_belongs(sql_name, &file_name) {
            fingerprint_file(state, source_share, &entry.path())?;
        }
    }
    Ok(())
}

pub(super) fn fingerprint_optional_file(
    state: &mut u64,
    source_root: &Path,
    path: &Path,
) -> Result<()> {
    if path.is_file() {
        fingerprint_file(state, source_root, path)
    } else {
        hash_str(state, "missing");
        hash_path(state, path);
        Ok(())
    }
}

pub(super) fn fingerprint_file(state: &mut u64, source_root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(source_root).unwrap_or(path);
    hash_path(state, relative);
    let metadata = fs::metadata(path)
        .map_err(|err| Error::Engine(format!("stat {}: {err}", path.display())))?;
    hash_u64(state, metadata.len());
    #[cfg(unix)]
    hash_u64(state, u64::from(metadata.permissions().mode()));
    let mut file = File::open(path).map_err(|err| {
        Error::Engine(format!("open {} for fingerprinting: {err}", path.display()))
    })?;
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| {
            Error::Engine(format!("read {} for fingerprinting: {err}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        hash_bytes(state, &buffer[..read]);
    }
    Ok(())
}

pub(super) fn hash_path(state: &mut u64, path: &Path) {
    hash_str(state, &path.to_string_lossy());
}

pub(super) fn hash_str(state: &mut u64, value: &str) {
    hash_bytes(state, value.as_bytes());
    hash_bytes(state, &[0]);
}

fn hash_u64(state: &mut u64, value: u64) {
    hash_bytes(state, &value.to_be_bytes());
}

fn hash_bytes(state: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *state ^= u64::from(*byte);
        *state = state.wrapping_mul(FNV_PRIME);
    }
}
