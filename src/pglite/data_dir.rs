use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use tar::{Archive, Builder, EntryType, Header};

const PGDATA_OVERLAY_MANIFEST_NAME: &str = ".pglite-oxide-pgdata-overlay.json";
const RUNTIME_STATE_FILES: &[&str] = &["postmaster.pid", "postmaster.opts"];
const OVERLAY_WHITEOUT_PREFIX: &str = ".wh.";

/// Compression format for physical PGDATA archives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirArchiveFormat {
    Tar,
    TarGz,
}

#[derive(Debug, Clone)]
enum EntrySource {
    Directory,
    File(PathBuf),
}

pub(crate) fn dump_pgdata_archive(
    pgdata_upper: &Path,
    pgdata_lower: Option<&Path>,
    format: DataDirArchiveFormat,
) -> Result<Vec<u8>> {
    let materialized = materialize_pgdata_view(pgdata_upper, pgdata_lower)?;
    dump_materialized_pgdata_archive(materialized.path(), format)
}

fn dump_materialized_pgdata_archive(
    pgdata: &Path,
    format: DataDirArchiveFormat,
) -> Result<Vec<u8>> {
    let mut entries = BTreeMap::<PathBuf, EntrySource>::new();
    collect_pgdata_entries(pgdata, pgdata, &mut entries)?;

    let mut tar_bytes = Vec::new();
    {
        let mut builder = Builder::new(&mut tar_bytes);
        for (relative, source) in entries {
            let archive_path = archive_path(&relative);
            match source {
                EntrySource::Directory => {
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Directory);
                    header.set_mode(0o755);
                    header.set_mtime(0);
                    header.set_size(0);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, archive_path, Cursor::new(Vec::<u8>::new()))
                        .context("append PGDATA directory to archive")?;
                }
                EntrySource::File(path) => {
                    let mut file =
                        File::open(&path).with_context(|| format!("open {}", path.display()))?;
                    let size = file
                        .metadata()
                        .with_context(|| format!("stat {}", path.display()))?
                        .len();
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Regular);
                    header.set_mode(0o644);
                    header.set_mtime(0);
                    header.set_size(size);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, archive_path, &mut file)
                        .with_context(|| format!("append {}", path.display()))?;
                }
            }
        }
        builder.finish().context("finish PGDATA tar archive")?;
    }

    match format {
        DataDirArchiveFormat::Tar => Ok(tar_bytes),
        DataDirArchiveFormat::TarGz => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder
                .write_all(&tar_bytes)
                .context("gzip PGDATA archive")?;
            encoder.finish().context("finish gzipped PGDATA archive")
        }
    }
}

fn materialize_pgdata_view(
    pgdata_upper: &Path,
    pgdata_lower: Option<&Path>,
) -> Result<tempfile::TempDir> {
    let temp = tempfile::TempDir::new().context("create materialized PGDATA archive view")?;
    if let Some(lower) = pgdata_lower {
        copy_pgdata_tree(lower, lower, temp.path(), false)?;
    }
    copy_pgdata_tree(pgdata_upper, pgdata_upper, temp.path(), true)?;
    Ok(temp)
}

pub(crate) fn unpack_pgdata_archive(bytes: &[u8], destination: &Path) -> Result<()> {
    let reader: Box<dyn Read> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(GzDecoder::new(Cursor::new(bytes)))
    } else {
        Box::new(Cursor::new(bytes))
    };
    let mut archive = Archive::new(reader);
    for entry in archive.entries().context("read PGDATA archive entries")? {
        let mut entry = entry.context("read PGDATA archive entry")?;
        let path = entry
            .path()
            .context("read PGDATA archive entry path")?
            .into_owned();
        let relative = normalize_archive_path(&path)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if should_skip_relative(&relative) {
            continue;
        }
        let dest = destination.join(&relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            fs::create_dir_all(&dest)
                .with_context(|| format!("create PGDATA directory {}", dest.display()))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "PGDATA archive entry {} has unsupported type {:?}",
                path.display(),
                entry_type
            );
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create PGDATA directory {}", parent.display()))?;
        }
        entry
            .unpack(&dest)
            .with_context(|| format!("unpack PGDATA archive entry {}", path.display()))?;
    }
    Ok(())
}

fn collect_pgdata_entries(
    root: &Path,
    current: &Path,
    entries: &mut BTreeMap<PathBuf, EntrySource>,
) -> Result<()> {
    if !current.exists() {
        return Ok(());
    }
    let mut children = fs::read_dir(current)
        .with_context(|| format!("read PGDATA directory {}", current.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("read PGDATA directory entries {}", current.display()))?;
    children.sort_by_key(|entry| entry.path());

    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("strip PGDATA root {}", root.display()))?
            .to_path_buf();
        if should_skip_relative(&relative) {
            continue;
        }
        let file_type = child
            .file_type()
            .with_context(|| format!("stat {}", path.display()))?;
        if file_type.is_dir() {
            entries.insert(relative.clone(), EntrySource::Directory);
            collect_pgdata_entries(root, &path, entries)?;
        } else if file_type.is_file() {
            entries.insert(relative, EntrySource::File(path));
        }
    }
    Ok(())
}

fn copy_pgdata_tree(
    root: &Path,
    current: &Path,
    destination_root: &Path,
    apply_whiteouts: bool,
) -> Result<()> {
    if !current.exists() {
        return Ok(());
    }
    let mut children = fs::read_dir(current)
        .with_context(|| format!("read PGDATA directory {}", current.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("read PGDATA directory entries {}", current.display()))?;
    children.sort_by_key(|entry| entry.path());

    for child in children {
        let src = child.path();
        let relative = src
            .strip_prefix(root)
            .with_context(|| format!("strip PGDATA root {}", root.display()))?
            .to_path_buf();
        if apply_whiteouts && let Some(target) = whiteout_target_relative(&relative) {
            let dest = destination_root.join(target);
            remove_materialized_entry(&dest)?;
            continue;
        }
        if should_skip_relative(&relative) {
            continue;
        }

        let dest = destination_root.join(&relative);
        let file_type = child
            .file_type()
            .with_context(|| format!("stat {}", src.display()))?;
        if file_type.is_dir() {
            fs::create_dir_all(&dest).with_context(|| {
                format!("create materialized PGDATA directory {}", dest.display())
            })?;
            copy_pgdata_tree(root, &src, destination_root, apply_whiteouts)?;
        } else if file_type.is_file() {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("create materialized PGDATA directory {}", parent.display())
                })?;
            }
            fs::copy(&src, &dest).with_context(|| {
                format!(
                    "copy PGDATA archive file {} -> {}",
                    src.display(),
                    dest.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_materialized_entry(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .with_context(|| format!("remove materialized whiteout directory {}", path.display())),
        Ok(_) => fs::remove_file(path)
            .with_context(|| format!("remove materialized whiteout file {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err)
            .with_context(|| format!("stat materialized whiteout target {}", path.display())),
    }
}

fn should_skip_relative(relative: &Path) -> bool {
    relative == Path::new(PGDATA_OVERLAY_MANIFEST_NAME)
        || whiteout_target_relative(relative).is_some()
        || RUNTIME_STATE_FILES
            .iter()
            .any(|name| relative == Path::new(name))
}

fn whiteout_target_relative(relative: &Path) -> Option<PathBuf> {
    let file_name = relative.file_name()?.to_string_lossy();
    let target_file_name = file_name.strip_prefix(OVERLAY_WHITEOUT_PREFIX)?;
    let mut target = relative.to_path_buf();
    target.set_file_name(target_file_name);
    Some(target)
}

fn archive_path(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

fn normalize_archive_path(path: &Path) -> Result<PathBuf> {
    let mut dest = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => dest.push(part),
            Component::ParentDir | Component::Prefix(_) => {
                bail!("unsafe PGDATA archive path {}", path.display())
            }
        }
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn pgdata_archive_applies_overlay_whiteouts() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let lower = temp.path().join("lower");
        let upper = temp.path().join("upper");
        fs::create_dir_all(lower.join("base/1/tree"))?;
        fs::create_dir_all(upper.join("base/1"))?;
        fs::write(lower.join("base/1/deleted"), b"lower-deleted")?;
        fs::write(lower.join("base/1/kept"), b"lower-kept")?;
        fs::write(lower.join("base/1/tree/child"), b"lower-child")?;
        fs::write(upper.join("base/1/.wh.deleted"), b"")?;
        fs::write(upper.join("base/1/.wh.tree"), b"")?;

        let archive = dump_pgdata_archive(&upper, Some(&lower), DataDirArchiveFormat::Tar)?;
        let entries = archive_entries(&archive)?;

        assert!(entries.contains("base/1/kept"));
        assert!(!entries.contains("base/1/deleted"));
        assert!(!entries.contains("base/1/tree"));
        assert!(!entries.contains("base/1/tree/child"));
        assert!(!entries.iter().any(|entry| entry.contains(".wh.")));
        Ok(())
    }

    #[test]
    fn pgdata_archive_keeps_upper_file_recreated_after_whiteout() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let lower = temp.path().join("lower");
        let upper = temp.path().join("upper");
        fs::create_dir_all(lower.join("base/1"))?;
        fs::create_dir_all(upper.join("base/1"))?;
        fs::write(lower.join("base/1/recreated"), b"lower")?;
        fs::write(upper.join("base/1/.wh.recreated"), b"")?;
        fs::write(upper.join("base/1/recreated"), b"upper")?;

        let archive = dump_pgdata_archive(&upper, Some(&lower), DataDirArchiveFormat::Tar)?;
        let mut unpacked = Archive::new(Cursor::new(archive));
        let mut found = false;
        for entry in unpacked.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if normalize_archive_path(&path)? == Path::new("base/1/recreated") {
                let mut contents = Vec::new();
                entry.read_to_end(&mut contents)?;
                assert_eq!(contents, b"upper");
                found = true;
            }
        }
        assert!(found, "expected recreated upper file in archive");
        Ok(())
    }

    fn archive_entries(bytes: &[u8]) -> Result<BTreeSet<String>> {
        let mut archive = Archive::new(Cursor::new(bytes));
        let mut paths = BTreeSet::new();
        for entry in archive.entries()? {
            let entry = entry?;
            let path = entry.path()?.into_owned();
            paths.insert(archive_path(&normalize_archive_path(&path)?));
        }
        Ok(paths)
    }
}
