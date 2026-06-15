use std::path::{Path, PathBuf};

use super::super::super::ffi::{
    ENV_INITDB, ENV_INSTALL_DIR, ENV_POSTGRES, env_path_candidates, resolve_library_path_candidates,
};
use crate::error::{Error, Result};

pub(super) fn locate_native_install_dir() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(env_path_candidates([ENV_INSTALL_DIR]));
    for env_name in [ENV_POSTGRES, ENV_INITDB] {
        if let Some(path) = std::env::var_os(env_name) {
            let path = PathBuf::from(path);
            if let Some(install_dir) = path.parent().and_then(Path::parent) {
                candidates.push(install_dir.to_path_buf());
            }
        }
    }
    for path in resolve_library_path_candidates() {
        if let Some(work_root) = path.parent().and_then(Path::parent) {
            candidates.push(work_root.join("install"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/liboliphaunt-pg18/install"));
        candidates.push(cwd.join("target/native-liboliphaunt-pg18/install"));
        if let Some(target_id) = native_host_target_id() {
            candidates.push(cwd.join(format!("target/liboliphaunt-pg18-{target_id}/install")));
        }
    }

    for candidate in candidates {
        if native_install_dir_is_valid(&candidate) {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(format!(
        "could not locate native PostgreSQL 18 install tree; set {ENV_INSTALL_DIR} or {ENV_POSTGRES}"
    )))
}

pub(super) fn locate_native_embedded_modules_dir(install_dir: &Path) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for path in resolve_library_path_candidates() {
        if let Some(out_dir) = path.parent() {
            candidates.push(out_dir.join("modules"));
        }
    }
    if let Some(work_root) = install_dir.parent() {
        candidates.push(work_root.join("out/modules"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/liboliphaunt-pg18/out/modules"));
        candidates.push(cwd.join("target/native-liboliphaunt-pg18/out/modules"));
        if let Some(target_id) = native_host_target_id() {
            candidates.push(cwd.join(format!("target/liboliphaunt-pg18-{target_id}/out/modules")));
        }
    }

    for candidate in candidates {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(
        "could not locate native embedded PostgreSQL 18 module artifacts; build native liboliphaunt first"
            .to_owned(),
    ))
}

fn native_install_dir_is_valid(path: &Path) -> bool {
    native_tool_is_file(path, "postgres")
        && path
            .join("share/postgresql/postgresql.conf.sample")
            .is_file()
        && path.join("lib/postgresql").is_dir()
}

fn native_tool_is_file(path: &Path, tool: &str) -> bool {
    path.join("bin").join(tool).is_file() || path.join("bin").join(format!("{tool}.exe")).is_file()
}

fn native_host_target_id() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("linux", "x86_64") => Some("linux-x64-gnu"),
        ("linux", "aarch64") => Some("linux-arm64-gnu"),
        ("windows", "x86_64") => Some("windows-x64-msvc"),
        _ => None,
    }
}
