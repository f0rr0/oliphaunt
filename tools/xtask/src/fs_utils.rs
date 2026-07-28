use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail, ensure};
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
    let metadata = fs::symlink_metadata(current)
        .with_context(|| format!("inspect archive input {}", current.display()))?;
    let file_type = metadata.file_type();
    ensure_archive_input_type(current, &file_type)?;
    let relative = current
        .strip_prefix(root)
        .with_context(|| format!("strip {} from {}", root.display(), current.display()))?;
    let archive_path = if relative.as_os_str().is_empty() {
        archive_root.to_path_buf()
    } else {
        archive_root.join(relative)
    };

    if !archive_path.as_os_str().is_empty() {
        // The release verifier accepts only self-contained ustar members. A
        // GNU header can silently add LongLink pseudo-members once a path is
        // longer than 100 bytes, even when the same path fits in ustar's
        // portable prefix/name fields.
        let mut header = tar::Header::new_ustar();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_username("root").ok();
        header.set_groupname("root").ok();
        if file_type.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            // Keep the path marker and the authoritative tar type flag in
            // agreement. The marker is significant to portable extractors and
            // to tools/release/portable-archive.mjs on every host OS.
            let directory_archive_path = archive_path.join("");
            builder
                .append_data(&mut header, &directory_archive_path, io::empty())
                .with_context(|| format!("append directory {}", archive_path.display()))?;
        } else if file_type.is_file() {
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

    if file_type.is_dir() {
        for child in sorted_children(current)? {
            append_tree(builder, root, &child, archive_root)?;
        }
    }
    Ok(())
}

fn ensure_archive_input_type(path: &Path, file_type: &fs::FileType) -> Result<()> {
    if file_type.is_symlink() {
        bail!(
            "deterministic archive input must not contain a symbolic link: {}",
            path.display()
        );
    }
    ensure!(
        file_type.is_file() || file_type.is_dir(),
        "deterministic archive input must contain only regular files and directories: {}",
        path.display()
    );
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

    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock after Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "oliphaunt-xtask-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[derive(Debug, Eq, PartialEq)]
    struct TarMember {
        is_directory: bool,
        mode: u32,
        size: u64,
    }

    fn tar_zst_members(path: &Path) -> BTreeMap<String, TarMember> {
        let file = fs::File::open(path).expect("open test archive");
        let decoder = zstd::stream::read::Decoder::new(file).expect("decode test archive");
        let mut archive = tar::Archive::new(decoder);
        archive
            .entries()
            .expect("read test archive entries")
            .map(|entry| {
                let entry = entry.expect("read test archive entry");
                let header = entry.header();
                let name = String::from_utf8(header.path_bytes().into_owned())
                    .expect("portable UTF-8 archive path");
                assert_eq!(header.uid().expect("member uid"), 0, "{name}");
                assert_eq!(header.gid().expect("member gid"), 0, "{name}");
                assert_eq!(header.mtime().expect("member mtime"), 0, "{name}");
                assert_eq!(
                    header.username().expect("member username"),
                    Some("root"),
                    "{name}"
                );
                assert_eq!(
                    header.groupname().expect("member groupname"),
                    Some("root"),
                    "{name}"
                );
                let is_directory = header.entry_type().is_dir();
                assert_eq!(name.ends_with('/'), is_directory, "{name}");
                (
                    name,
                    TarMember {
                        is_directory,
                        mode: header.mode().expect("member mode"),
                        size: header.size().expect("member size"),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn deterministic_tar_zst_emits_portable_type_markers_and_ustar_paths() {
        let fixture = TestDirectory::new("portable-tar");
        let source = fixture.0.join("source");
        let licenses = source.join("THIRD_PARTY_LICENSES");
        let long_parent = source
            .join("a-very-long-portable-directory-segment-used-to-cross-the-old-gnu-name-limit")
            .join("another-portable-directory-segment");
        fs::create_dir_all(&licenses).expect("create license fixture");
        fs::create_dir_all(&long_parent).expect("create long-path fixture");
        fs::write(licenses.join("PostgreSQL-COPYRIGHT"), b"license\n")
            .expect("write license fixture");
        fs::write(long_parent.join("payload.txt"), b"payload\n").expect("write long-path fixture");

        let first = fixture.0.join("first.tar.zst");
        let second = fixture.0.join("second.tar.zst");
        deterministic_tar_zst(&source, Path::new(""), &first).expect("write first archive");
        deterministic_tar_zst(&source, Path::new(""), &second).expect("write second archive");
        assert_eq!(
            fs::read(&first).expect("read first archive"),
            fs::read(&second).expect("read second archive"),
            "the same tree must produce byte-identical archives",
        );

        let members = tar_zst_members(&first);
        assert_eq!(
            members.get("THIRD_PARTY_LICENSES/"),
            Some(&TarMember {
                is_directory: true,
                mode: 0o755,
                size: 0,
            })
        );
        assert_eq!(
            members.get("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT"),
            Some(&TarMember {
                is_directory: false,
                mode: 0o644,
                size: 8,
            })
        );
        let long_file = members
            .iter()
            .find(|(name, member)| name.ends_with("/payload.txt") && !member.is_directory)
            .expect("long ustar file member");
        assert!(
            long_file.0.len() > 100,
            "long path must exercise ustar prefix splitting"
        );
        assert_eq!(long_file.1.mode, 0o644);

        let prefixed = fixture.0.join("prefixed.tar.zst");
        deterministic_tar_zst(&source, Path::new("carrier"), &prefixed)
            .expect("write prefixed archive");
        let prefixed_members = tar_zst_members(&prefixed);
        assert_eq!(
            prefixed_members.get("carrier/"),
            Some(&TarMember {
                is_directory: true,
                mode: 0o755,
                size: 0,
            })
        );
        assert!(prefixed_members.contains_key("carrier/THIRD_PARTY_LICENSES/"));
        assert!(prefixed_members.contains_key("carrier/THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT"));
        assert!(prefixed_members.keys().all(|name| {
            let directory = prefixed_members[name].is_directory;
            name.ends_with('/') == directory && !name.contains('\\')
        }));
    }

    #[cfg(unix)]
    #[test]
    fn deterministic_tar_zst_rejects_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let fixture = TestDirectory::new("portable-tar-symlinks");
        let outside_file = fixture.0.join("outside.txt");
        let outside_directory = fixture.0.join("outside-directory");
        fs::write(&outside_file, b"outside\n").expect("write external file");
        fs::create_dir(&outside_directory).expect("create external directory");
        fs::write(outside_directory.join("payload"), b"outside\n")
            .expect("write external directory payload");

        for (name, target) in [
            ("linked-file", outside_file.as_path()),
            ("linked-directory", outside_directory.as_path()),
        ] {
            let source = fixture.0.join(format!("source-{name}"));
            fs::create_dir(&source).expect("create symlink source");
            symlink(target, source.join(name)).expect("create archive-input symlink");
            let output = fixture.0.join(format!("{name}.tar.zst"));
            let error = deterministic_tar_zst(&source, Path::new(""), &output)
                .expect_err("archive-input symlinks must fail");
            assert!(
                error
                    .to_string()
                    .contains("must not contain a symbolic link")
            );
            assert!(error.to_string().contains(name));
        }
    }

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
