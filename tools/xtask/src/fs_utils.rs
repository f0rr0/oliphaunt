use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zstd::stream::write::Encoder as ZstdEncoder;

pub(crate) fn archive_entry_bytes(archive_path: &Path, entry_name: &str) -> Result<Vec<u8>> {
    let file =
        fs::File::open(archive_path).with_context(|| format!("open {}", archive_path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", archive_path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .with_context(|| format!("read {}", archive_path.display()))?
    {
        let mut entry =
            entry.with_context(|| format!("read entry from {}", archive_path.display()))?;
        let path = entry
            .path()
            .with_context(|| format!("read path from {}", archive_path.display()))?
            .to_string_lossy()
            .trim_start_matches("./")
            .to_owned();
        if path == entry_name {
            let mut bytes = Vec::new();
            io::copy(&mut entry, &mut bytes)
                .with_context(|| format!("read {entry_name} from {}", archive_path.display()))?;
            return Ok(bytes);
        }
    }
    bail!(
        "{} is missing archive entry {entry_name}",
        archive_path.display()
    )
}

pub(crate) fn archive_entries(path: &Path) -> Result<HashSet<String>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decode {}", path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = HashSet::new();
    for entry in archive
        .entries()
        .with_context(|| format!("read entries from {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("read entry from {}", path.display()))?;
        let entry_path = entry
            .path()
            .with_context(|| format!("read entry path from {}", path.display()))?;
        let entry = entry_path
            .to_str()
            .ok_or_else(|| anyhow!("archive {} has non-UTF-8 path", path.display()))?
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if !entry.is_empty() {
            entries.insert(entry);
        }
    }
    Ok(entries)
}

pub(crate) fn write_bytes_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

pub(crate) fn deterministic_tar_zst(
    source_root: &Path,
    archive_root: &Path,
    output: &Path,
) -> Result<()> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    let encoder =
        ZstdEncoder::new(file, 19).with_context(|| format!("create zstd {}", output.display()))?;
    let mut builder = tar::Builder::new(encoder);
    append_tree(&mut builder, source_root, source_root, archive_root)?;
    let encoder = builder.into_inner().context("finish tar stream")?;
    encoder
        .finish()
        .with_context(|| format!("finish {}", output.display()))?;
    Ok(())
}

pub(crate) fn archive_file_list(path: &Path) -> Result<Vec<String>> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let raw = if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        let mut decoder = zstd::stream::read::Decoder::new(std::io::Cursor::new(bytes))
            .with_context(|| format!("create zstd decoder for {}", path.display()))?;
        let mut raw = Vec::new();
        io::copy(&mut decoder, &mut raw)
            .with_context(|| format!("decompress {}", path.display()))?;
        raw
    } else {
        bytes
    };
    let mut archive = tar::Archive::new(std::io::Cursor::new(raw));
    let mut files = Vec::new();
    for entry in archive
        .entries()
        .with_context(|| format!("read tar entries from {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("read tar entry from {}", path.display()))?;
        if entry.header().entry_type().is_file() {
            files.push(
                entry
                    .path()
                    .with_context(|| format!("read tar path from {}", path.display()))?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    files.sort();
    Ok(files)
}

fn append_tree<W: io::Write>(
    builder: &mut tar::Builder<W>,
    root: &Path,
    current: &Path,
    archive_root: &Path,
) -> Result<()> {
    let relative = current
        .strip_prefix(root)
        .with_context(|| format!("strip {} from {}", root.display(), current.display()))?;
    let archive_path = if relative.as_os_str().is_empty() {
        archive_root.to_path_buf()
    } else {
        archive_root.join(relative)
    };

    if !archive_path.as_os_str().is_empty() {
        let mut header = tar::Header::new_gnu();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_username("root").ok();
        header.set_groupname("root").ok();
        if current.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, io::empty())
                .with_context(|| format!("append directory {}", archive_path.display()))?;
        } else if current.is_file() {
            let bytes = fs::read(current).with_context(|| format!("read {}", current.display()))?;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(if is_executable(current) { 0o755 } else { 0o644 });
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, &archive_path, bytes.as_slice())
                .with_context(|| format!("append file {}", archive_path.display()))?;
        }
    }

    if current.is_dir() {
        for child in sorted_children(current)? {
            append_tree(builder, root, &child, archive_root)?;
        }
    }
    Ok(())
}

pub(crate) fn copy_tree_filtered(
    source: &Path,
    destination: &Path,
    skip_names: Option<&[&str]>,
) -> Result<()> {
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in sorted_files(source)? {
        let relative = entry
            .strip_prefix(source)
            .with_context(|| format!("strip {} from {}", source.display(), entry.display()))?;
        if let Some(file_name) = relative.file_name().and_then(|name| name.to_str())
            && skip_names
                .map(|names| names.contains(&file_name))
                .unwrap_or(false)
        {
            continue;
        }
        copy_file(&entry, &destination.join(relative))?;
    }
    Ok(())
}

pub(crate) fn sorted_children(path: &Path) -> Result<Vec<PathBuf>> {
    let mut children = fs::read_dir(path)
        .with_context(|| format!("read directory {}", path.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("read child in {}", path.display()))?;
    children.sort();
    Ok(children)
}

pub(crate) fn sorted_files(path: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.with_context(|| format!("walk {}", path.display()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

pub(crate) fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    ensure_file(source)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::copy(source, destination)
        .with_context(|| format!("copy {} -> {}", source.display(), destination.display()))?;
    Ok(())
}

pub(crate) fn copy_dir_all(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("remove {}", destination.display()))?;
    }
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in WalkDir::new(source) {
        let entry = entry.with_context(|| format!("walk {}", source.display()))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(source)
            .with_context(|| format!("strip {} from {}", source.display(), path.display()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&output).with_context(|| format!("create {}", output.display()))?;
        } else if entry.file_type().is_file() {
            copy_file(path, &output)?;
        }
    }
    Ok(())
}

pub(crate) fn ensure_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!("expected file missing: {}", path.display());
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(sha256_bytes(&bytes))
}

pub(crate) fn sha256_text_file_lf(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    Ok(sha256_bytes(text.replace("\r\n", "\n").as_bytes()))
}

pub(crate) fn decode_zstd_file(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("create zstd decoder for {}", path.display()))?;
    let mut raw = Vec::new();
    io::copy(&mut decoder, &mut raw).with_context(|| format!("decompress {}", path.display()))?;
    Ok(raw)
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_text_file_lf_is_independent_of_crlf_checkout() {
        let path = std::env::temp_dir().join(format!(
            "oliphaunt-xtask-crlf-hash-{}.txt",
            std::process::id()
        ));
        fs::write(&path, "alpha\r\nbeta\r\n").expect("write CRLF fixture");
        let actual = sha256_text_file_lf(&path).expect("hash normalized text");
        fs::remove_file(&path).ok();

        assert_eq!(actual, sha256_bytes(b"alpha\nbeta\n"));
    }
}
