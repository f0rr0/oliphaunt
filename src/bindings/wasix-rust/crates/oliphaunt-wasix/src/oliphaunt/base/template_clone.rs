use std::ffi::OsStr;
use std::fs;
use std::path::Path;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Command;

use anyhow::{Context, Result};

use super::TEMPLATE_RUNTIME_STATE_FILES;

pub(super) fn clone_pgdata_template_dir(source_pgdata: &Path, dest_pgdata: &Path) -> Result<()> {
    if try_clone_dir(source_pgdata, dest_pgdata)? {
        return Ok(());
    }
    copy_pgdata_template_dir_inner(source_pgdata, dest_pgdata)
}

fn copy_pgdata_template_dir_inner(source_pgdata: &Path, dest_pgdata: &Path) -> Result<()> {
    fs::create_dir_all(dest_pgdata)
        .with_context(|| format!("create directory {}", dest_pgdata.display()))?;

    for entry in fs::read_dir(source_pgdata)
        .with_context(|| format!("read directory {}", source_pgdata.display()))?
    {
        let entry =
            entry.with_context(|| format!("read entry under {}", source_pgdata.display()))?;
        let file_name = entry.file_name();
        if should_skip_template_entry(&file_name) {
            continue;
        }

        let src_path = entry.path();
        let dest_path = dest_pgdata.join(&file_name);
        let file_type = entry
            .file_type()
            .with_context(|| format!("stat {}", src_path.display()))?;

        if file_type.is_dir() {
            copy_pgdata_template_dir_inner(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("create directory {}", parent.display()))?;
            }
            clone_mutable_template_file(&src_path, &dest_path)?;
        } else if file_type.is_symlink() {
            copy_symlink(&src_path, &dest_path)?;
        }
    }

    Ok(())
}

fn clone_mutable_template_file(src: &Path, dest: &Path) -> Result<()> {
    if std::env::var_os("OLIPHAUNT_WASM_TEMPLATE_REFLINK").is_some() && try_reflink_file(src, dest)?
    {
        return Ok(());
    }
    copy_template_file(src, dest)
}

fn try_clone_dir(src: &Path, dest: &Path) -> Result<bool> {
    if dest.exists() {
        fs::remove_dir_all(dest).with_context(|| format!("remove {}", dest.display()))?;
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let status = clone_dir_command(src, dest);
    match status {
        Ok(status) if status.success() && dest.exists() => Ok(true),
        Ok(_) | Err(_) => {
            if dest.exists() {
                fs::remove_dir_all(dest).with_context(|| {
                    format!("remove failed cloned directory {}", dest.display())
                })?;
            }
            Ok(false)
        }
    }
}

#[cfg(target_os = "linux")]
fn clone_dir_command(src: &Path, dest: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new("cp")
        .arg("-a")
        .arg("--reflink=auto")
        .arg("--")
        .arg(src)
        .arg(dest)
        .status()
}

#[cfg(target_os = "macos")]
fn clone_dir_command(src: &Path, dest: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new("cp").arg("-cR").arg(src).arg(dest).status()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn clone_dir_command(_src: &Path, _dest: &Path) -> std::io::Result<std::process::ExitStatus> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "directory clone is unsupported on this platform",
    ))
}

fn copy_template_file(src: &Path, dest: &Path) -> Result<()> {
    fs::copy(src, dest).with_context(|| format!("copy {} to {}", src.display(), dest.display()))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn try_reflink_file(src: &Path, dest: &Path) -> Result<bool> {
    let status = Command::new("cp")
        .arg("--reflink=always")
        .arg("--")
        .arg(src)
        .arg(dest)
        .status();
    match status {
        Ok(status) if status.success() && dest.exists() => Ok(true),
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(dest);
            Ok(false)
        }
    }
}

#[cfg(target_os = "macos")]
fn try_reflink_file(src: &Path, dest: &Path) -> Result<bool> {
    let status = Command::new("cp").arg("-c").arg(src).arg(dest).status();
    match status {
        Ok(status) if status.success() && dest.exists() => Ok(true),
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(dest);
            Ok(false)
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn try_reflink_file(_src: &Path, _dest: &Path) -> Result<bool> {
    Ok(false)
}

fn should_skip_template_entry(file_name: &OsStr) -> bool {
    let name = file_name.to_string_lossy();
    name.starts_with(".s.PGSQL.") || TEMPLATE_RUNTIME_STATE_FILES.contains(&name.as_ref())
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory {}", parent.display()))?;
    }
    let target = fs::read_link(src).with_context(|| format!("read symlink {}", src.display()))?;
    std::os::unix::fs::symlink(&target, dest)
        .with_context(|| format!("create symlink {} -> {}", dest.display(), target.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_symlink(src: &Path, dest: &Path) -> Result<()> {
    let target = fs::read_link(src).with_context(|| format!("read symlink {}", src.display()))?;
    let target_path = if target.is_absolute() {
        target
    } else {
        src.parent().unwrap_or_else(|| Path::new(".")).join(target)
    };

    if target_path.is_dir() {
        copy_pgdata_template_dir_inner(&target_path, dest)
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create directory {}", parent.display()))?;
        }
        fs::copy(&target_path, dest)
            .with_context(|| format!("copy {} to {}", target_path.display(), dest.display()))?;
        Ok(())
    }
}

#[cfg(test)]
fn copy_template_pgdata(template_root: &Path, dest_root: &Path) -> Result<()> {
    let source_pgdata = template_root.join("tmp/oliphaunt/base");
    clone_pgdata_template_dir(&source_pgdata, &dest_root.join("tmp/oliphaunt/base"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn template_copy_keeps_cluster_files_and_skips_runtime_state() -> Result<()> {
        let source = TempDir::new()?;
        let pgdata = source.path().join("tmp/oliphaunt/base");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("PG_VERSION"), b"17\n")?;
        fs::write(pgdata.join("postmaster.pid"), b"stale pid")?;
        fs::write(pgdata.join("postmaster.opts"), b"stale opts")?;
        fs::write(pgdata.join(".s.PGSQL.5432"), b"socket")?;
        fs::write(pgdata.join(".s.PGSQL.5432.lock"), b"lock")?;

        let dest = TempDir::new()?;
        let dest_pgdata = dest.path().join("tmp/oliphaunt/base");
        copy_pgdata_template_dir_inner(&pgdata, &dest_pgdata)?;

        assert!(
            dest_pgdata.join("PG_VERSION").exists(),
            "destination entries: {}",
            list_test_entries(dest.path())?
        );
        assert!(!dest_pgdata.join("postmaster.pid").exists());
        assert!(!dest_pgdata.join("postmaster.opts").exists());
        assert!(!dest_pgdata.join(".s.PGSQL.5432").exists());
        assert!(!dest_pgdata.join(".s.PGSQL.5432.lock").exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn template_clone_does_not_hardlink_mutable_pgdata_files() -> Result<()> {
        use std::os::unix::fs::MetadataExt;

        let source = TempDir::new()?;
        let pgdata = source.path().join("tmp/oliphaunt/base");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("PG_VERSION"), b"17\n")?;

        let dest = TempDir::new()?;
        let dest_pgdata = dest.path().join("tmp/oliphaunt/base");
        copy_pgdata_template_dir_inner(&pgdata, &dest_pgdata)?;

        let source_pg_version = pgdata.join("PG_VERSION");
        let dest_pg_version = dest_pgdata.join("PG_VERSION");
        assert!(
            source_pg_version.exists(),
            "source PG_VERSION should exist at {}",
            source_pg_version.display()
        );
        assert!(
            dest_pg_version.exists(),
            "cloned PG_VERSION should exist at {}; destination entries: {}",
            dest_pg_version.display(),
            list_test_entries(dest.path())?
        );
        let source_meta = fs::metadata(&source_pg_version)?;
        let dest_meta = fs::metadata(&dest_pg_version)?;
        assert_ne!(
            (source_meta.dev(), source_meta.ino()),
            (dest_meta.dev(), dest_meta.ino()),
            "mutable PGDATA template files must be copied or reflinked, not hardlinked"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn fallback_template_pgdata_copy_does_not_hardlink_mutable_files() -> Result<()> {
        use std::os::unix::fs::MetadataExt;

        let source = TempDir::new()?;
        let pgdata = source.path().join("tmp/oliphaunt/base");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("PG_VERSION"), b"17\n")?;

        let dest = TempDir::new()?;
        copy_template_pgdata(source.path(), dest.path())?;

        let source_pg_version = pgdata.join("PG_VERSION");
        let dest_pg_version = dest.path().join("tmp/oliphaunt/base/PG_VERSION");
        assert!(dest_pg_version.exists());
        let source_meta = fs::metadata(&source_pg_version)?;
        let dest_meta = fs::metadata(&dest_pg_version)?;
        assert_ne!(
            (source_meta.dev(), source_meta.ino()),
            (dest_meta.dev(), dest_meta.ino()),
            "fallback PGDATA template copy must not hardlink mutable files"
        );
        Ok(())
    }

    #[test]
    fn fallback_template_pgdata_copy_does_not_share_mutable_files() -> Result<()> {
        let source = TempDir::new()?;
        let pgdata = source.path().join("base");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("PG_VERSION"), b"17\n")?;

        let dest = TempDir::new()?;
        let cloned = dest.path().join("base");
        copy_pgdata_template_dir_inner(&pgdata, &cloned)?;
        fs::write(cloned.join("PG_VERSION"), b"changed\n")?;

        assert_eq!(
            fs::read(pgdata.join("PG_VERSION"))?,
            b"17\n",
            "fallback PGDATA template copy must not share mutable file storage with the source"
        );
        Ok(())
    }

    fn list_test_entries(root: &Path) -> Result<String> {
        let mut entries = Vec::new();
        collect_test_entries(root, root, &mut entries)?;
        entries.sort();
        Ok(entries.join(", "))
    }

    fn collect_test_entries(root: &Path, current: &Path, entries: &mut Vec<String>) -> Result<()> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path);
            entries.push(relative.display().to_string());
            if entry.file_type()?.is_dir() {
                collect_test_entries(root, &path, entries)?;
            }
        }
        Ok(())
    }
}
