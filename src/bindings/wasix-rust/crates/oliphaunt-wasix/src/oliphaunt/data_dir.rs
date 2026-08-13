use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use cap_fs_ext::{
    DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt, OpenOptionsSyncExt,
};
use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapDir, File as CapFile, OpenOptions as CapOpenOptions};
use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use tar::{Archive, Builder, EntryType, Header};
use wasmer_wasix::virtual_fs::FileSystem as VirtualFileSystem;

#[cfg(test)]
use crate::oliphaunt::storage::vfs_file_exists;
use crate::oliphaunt::storage::{vfs_create_dir_all, vfs_read, vfs_write};

const PGDATA_OVERLAY_MANIFEST_NAME: &str = ".oliphaunt-wasix-pgdata-overlay.json";
const RUNTIME_STATE_FILES: &[&str] = &["postmaster.pid", "postmaster.opts"];
const OVERLAY_WHITEOUT_PREFIX: &str = ".wh.";
const TAR_BLOCK_BYTES: usize = 512;
const TAR_END_BYTES: usize = TAR_BLOCK_BYTES * 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PhysicalArchiveEncoding {
    Tar,
    TarGz,
}

enum HostTreeEntry {
    Whiteout(PathBuf),
    Directory,
    File { file: CapFile, size: u64 },
}

#[derive(Debug, Clone)]
enum VirtualEntrySource {
    Directory,
    File(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArchiveEntryPlan {
    relative: PathBuf,
    kind: ArchiveEntryKind,
    mode: u32,
    size: usize,
}

struct FramedArchiveReader<R> {
    inner: R,
    total: usize,
    tail: Vec<u8>,
}

impl<R> FramedArchiveReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            total: 0,
            tail: Vec::with_capacity(TAR_END_BYTES),
        }
    }

    fn validate_framing(&self) -> Result<()> {
        if self.total < TAR_END_BYTES
            || !self.total.is_multiple_of(TAR_BLOCK_BYTES)
            || self.tail.len() != TAR_END_BYTES
            || self.tail.iter().any(|byte| *byte != 0)
        {
            bail!("PGDATA archive has invalid tar framing");
        }
        Ok(())
    }
}

impl<R: Read> Read for FramedArchiveReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.total = self
            .total
            .checked_add(read)
            .ok_or_else(|| io::Error::other("PGDATA archive expanded size overflow"))?;
        if read >= TAR_END_BYTES {
            self.tail.clear();
            self.tail
                .extend_from_slice(&buffer[read - TAR_END_BYTES..read]);
        } else if read != 0 {
            let overflow = self
                .tail
                .len()
                .saturating_add(read)
                .saturating_sub(TAR_END_BYTES);
            self.tail.drain(..overflow);
            self.tail.extend_from_slice(&buffer[..read]);
        }
        Ok(read)
    }
}

pub(crate) fn dump_pgdata_archive(
    pgdata_upper: &Path,
    pgdata_lower: Option<&Path>,
    format: PhysicalArchiveEncoding,
) -> Result<Vec<u8>> {
    let materialized = materialize_pgdata_view(pgdata_upper, pgdata_lower)?;
    dump_materialized_pgdata_archive(materialized.path(), format)
}

pub(crate) fn dump_virtual_pgdata_archive(
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
    format: PhysicalArchiveEncoding,
) -> Result<Vec<u8>> {
    let mut entries = BTreeMap::<PathBuf, VirtualEntrySource>::new();
    collect_virtual_pgdata_entries(filesystem, Path::new("/"), Path::new("/"), &mut entries)?;

    let mut tar_bytes = Vec::new();
    {
        let mut builder = Builder::new(&mut tar_bytes);
        for (relative, source) in entries {
            let archive_path = archive_path(&relative);
            match source {
                VirtualEntrySource::Directory => {
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Directory);
                    header.set_mode(0o755);
                    header.set_mtime(0);
                    header.set_size(0);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, archive_path, Cursor::new(Vec::<u8>::new()))
                        .context("append virtual PGDATA directory to archive")?;
                }
                VirtualEntrySource::File(bytes) => {
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Regular);
                    header.set_mode(0o644);
                    header.set_mtime(0);
                    header.set_size(bytes.len() as u64);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, archive_path, Cursor::new(bytes))
                        .context("append virtual PGDATA file to archive")?;
                }
            }
        }
        builder
            .finish()
            .context("finish virtual PGDATA tar archive")?;
    }

    compress_archive(tar_bytes, format)
}

fn dump_materialized_pgdata_archive(
    pgdata: &Path,
    format: PhysicalArchiveEncoding,
) -> Result<Vec<u8>> {
    dump_materialized_pgdata_archive_with_hook(pgdata, format, &mut |_| Ok(()))
}

fn dump_materialized_pgdata_archive_with_hook<F>(
    pgdata: &Path,
    format: PhysicalArchiveEncoding,
    before_open: &mut F,
) -> Result<Vec<u8>>
where
    F: FnMut(&Path) -> Result<()>,
{
    let root = open_host_tree_root(pgdata)?
        .with_context(|| format!("PGDATA directory {} does not exist", pgdata.display()))?;

    let mut tar_bytes = Vec::new();
    {
        let mut builder = Builder::new(&mut tar_bytes);
        walk_host_tree(
            &root,
            Path::new(""),
            pgdata,
            before_open,
            &mut |relative, source| {
                let archive_path = archive_path(relative);
                match source {
                    HostTreeEntry::Whiteout(_) => {}
                    HostTreeEntry::Directory => {
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
                    HostTreeEntry::File { mut file, size } => {
                        let mut header = Header::new_gnu();
                        header.set_entry_type(EntryType::Regular);
                        header.set_mode(0o644);
                        header.set_mtime(0);
                        header.set_size(size);
                        header.set_cksum();
                        builder
                            .append_data(&mut header, archive_path, &mut file)
                            .with_context(|| format!("append {}", relative.display()))?;
                    }
                }
                Ok(())
            },
        )?;
        builder.finish().context("finish PGDATA tar archive")?;
    }

    compress_archive(tar_bytes, format)
}

fn compress_archive(tar_bytes: Vec<u8>, format: PhysicalArchiveEncoding) -> Result<Vec<u8>> {
    match format {
        PhysicalArchiveEncoding::Tar => Ok(tar_bytes),
        PhysicalArchiveEncoding::TarGz => {
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
        copy_pgdata_tree(lower, temp.path(), false)?;
    }
    copy_pgdata_tree(pgdata_upper, temp.path(), true)?;
    Ok(temp)
}

pub(crate) fn unpack_pgdata_archive(bytes: &[u8], destination: &Path) -> Result<()> {
    let plans = validate_pgdata_archive(bytes)?;
    apply_validated_pgdata_archive(bytes, &plans, |entry, plan| {
        if should_skip_relative(&plan.relative) {
            return Ok(());
        }

        let destination = destination.join(&plan.relative);
        if plan.kind == ArchiveEntryKind::Directory {
            fs::create_dir_all(&destination)
                .with_context(|| format!("create PGDATA directory {}", destination.display()))?;
            apply_restored_permissions(&destination, plan.mode, 0o700)?;
            return Ok(());
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create PGDATA directory {}", parent.display()))?;
        }
        let mut file = File::create(&destination)
            .with_context(|| format!("create PGDATA file {}", destination.display()))?;
        let copied = io::copy(entry, &mut file)
            .with_context(|| format!("write PGDATA file {}", destination.display()))?;
        ensure_archive_entry_size(plan, copied)?;
        apply_restored_permissions(&destination, plan.mode, 0o600)
    })
}

pub(crate) fn unpack_virtual_pgdata_archive(
    bytes: &[u8],
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<()> {
    let plans = validate_pgdata_archive(bytes)?;
    apply_validated_pgdata_archive(bytes, &plans, |entry, plan| {
        if should_skip_relative(&plan.relative) {
            return Ok(());
        }

        let destination = Path::new("/").join(&plan.relative);
        if plan.kind == ArchiveEntryKind::Directory {
            vfs_create_dir_all(filesystem, &destination)?;
            return Ok(());
        }

        let mut contents = Vec::new();
        contents
            .try_reserve_exact(plan.size)
            .context("reserve PGDATA archive entry buffer")?;
        let copied = io::copy(entry, &mut contents)
            .with_context(|| format!("read PGDATA archive entry {}", plan.relative.display()))?;
        ensure_archive_entry_size(plan, copied)?;
        vfs_write(filesystem, &destination, &contents)
    })
}

fn validate_pgdata_archive(bytes: &[u8]) -> Result<Vec<ArchiveEntryPlan>> {
    let mut archive = open_pgdata_archive(bytes);
    let entries = archive.entries().context("read PGDATA archive entries")?;
    let mut plans = Vec::new();
    let mut seen_paths = BTreeSet::new();
    let mut seen_file_paths = BTreeSet::new();
    let mut seen_entry_ancestors = BTreeSet::new();
    let mut expanded_size = 0usize;

    for entry in entries {
        let mut entry = entry.context("read PGDATA archive entry")?;
        let plan = archive_entry_plan(&entry)?;
        if !seen_paths.insert(plan.relative.clone()) {
            bail!(
                "PGDATA archive contains duplicate entry {}",
                plan.relative.display()
            );
        }
        validate_archive_tree_shape(&plan, &seen_file_paths, &seen_entry_ancestors)?;
        remember_archive_tree_shape(&plan, &mut seen_file_paths, &mut seen_entry_ancestors);
        expanded_size = expanded_size
            .checked_add(plan.size)
            .context("PGDATA archive expanded size exceeds this platform's limit")?;

        let copied = io::copy(&mut entry, &mut io::sink()).with_context(|| {
            format!("validate PGDATA archive entry {}", plan.relative.display())
        })?;
        ensure_archive_entry_size(&plan, copied)?;
        plans
            .try_reserve(1)
            .context("PGDATA archive contains too many entries")?;
        plans.push(plan);
    }
    let mut reader = archive.into_inner();
    io::copy(&mut reader, &mut io::sink()).context("finish reading PGDATA archive")?;
    reader.validate_framing()?;
    Ok(plans)
}

fn apply_validated_pgdata_archive<F>(
    bytes: &[u8],
    plans: &[ArchiveEntryPlan],
    mut apply: F,
) -> Result<()>
where
    F: FnMut(&mut dyn Read, &ArchiveEntryPlan) -> Result<()>,
{
    let mut archive = open_pgdata_archive(bytes);
    let entries = archive.entries().context("read PGDATA archive entries")?;
    let mut plans = plans.iter();

    for entry in entries {
        let mut entry = entry.context("read PGDATA archive entry")?;
        let expected = plans
            .next()
            .context("PGDATA archive has more entries than its validated plan")?;
        let actual = archive_entry_plan(&entry)?;
        if &actual != expected {
            bail!(
                "PGDATA archive entry {} does not match its validated plan",
                actual.relative.display()
            );
        }
        apply(&mut entry, expected)?;
    }
    if plans.next().is_some() {
        bail!("PGDATA archive ended before its validated plan");
    }
    let mut reader = archive.into_inner();
    io::copy(&mut reader, &mut io::sink()).context("finish reading PGDATA archive")?;
    reader.validate_framing()?;
    Ok(())
}

fn open_pgdata_archive(bytes: &[u8]) -> Archive<FramedArchiveReader<Box<dyn Read + '_>>> {
    let reader: Box<dyn Read> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(MultiGzDecoder::new(Cursor::new(bytes)))
    } else {
        Box::new(Cursor::new(bytes))
    };
    let mut archive = Archive::new(FramedArchiveReader::new(reader));
    archive.set_ignore_zeros(true);
    archive
}

fn archive_entry_plan<R: Read>(entry: &tar::Entry<'_, R>) -> Result<ArchiveEntryPlan> {
    let path = entry
        .path()
        .context("read PGDATA archive entry path")?
        .into_owned();
    let relative = normalize_archive_path(&path)?;
    if relative.as_os_str().is_empty() {
        bail!("PGDATA archive entry {} is not relative", path.display());
    }

    let entry_type = entry.header().entry_type();
    let kind = if entry_type.is_dir() {
        ArchiveEntryKind::Directory
    } else if entry_type.is_file() {
        ArchiveEntryKind::File
    } else {
        bail!(
            "PGDATA archive entry {} has unsupported type {:?}",
            relative.display(),
            entry_type
        );
    };
    if let Some(link_name) = entry
        .link_name()
        .context("read PGDATA archive entry link target")?
    {
        bail!(
            "PGDATA archive entry {} has unexpected link target {}",
            relative.display(),
            link_name.display()
        );
    }

    let size = entry
        .header()
        .size()
        .context("read PGDATA archive entry size")?;
    let size = usize::try_from(size).with_context(|| {
        format!(
            "PGDATA archive entry {} is too large for this platform",
            relative.display()
        )
    })?;
    if kind == ArchiveEntryKind::Directory && size != 0 {
        bail!(
            "PGDATA archive directory entry {} has non-zero size",
            relative.display()
        );
    }
    let mode = entry
        .header()
        .mode()
        .context("read PGDATA archive entry mode")?;

    Ok(ArchiveEntryPlan {
        relative,
        kind,
        mode,
        size,
    })
}

#[cfg(unix)]
fn apply_restored_permissions(path: &Path, mode: u32, default_mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if mode == 0 { default_mode } else { mode };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("set restored PGDATA permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn apply_restored_permissions(_path: &Path, _mode: u32, _default_mode: u32) -> Result<()> {
    Ok(())
}

fn validate_archive_tree_shape(
    plan: &ArchiveEntryPlan,
    seen_file_paths: &BTreeSet<PathBuf>,
    seen_entry_ancestors: &BTreeSet<PathBuf>,
) -> Result<()> {
    if let Some(ancestor) = archive_path_ancestors(&plan.relative)
        .into_iter()
        .find(|ancestor| seen_file_paths.contains(ancestor))
    {
        bail!(
            "PGDATA archive entry {} is nested under file entry {}",
            plan.relative.display(),
            ancestor.display()
        );
    }
    if plan.kind == ArchiveEntryKind::File && seen_entry_ancestors.contains(&plan.relative) {
        bail!(
            "PGDATA archive file entry {} conflicts with existing child entries",
            plan.relative.display()
        );
    }
    Ok(())
}

fn remember_archive_tree_shape(
    plan: &ArchiveEntryPlan,
    seen_file_paths: &mut BTreeSet<PathBuf>,
    seen_entry_ancestors: &mut BTreeSet<PathBuf>,
) {
    if plan.kind == ArchiveEntryKind::File {
        seen_file_paths.insert(plan.relative.clone());
    }
    seen_entry_ancestors.extend(archive_path_ancestors(&plan.relative));
}

fn archive_path_ancestors(path: &Path) -> Vec<PathBuf> {
    let mut ancestors = Vec::new();
    let mut ancestor = PathBuf::new();
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        ancestor.push(component.as_os_str());
        ancestors.push(ancestor.clone());
    }
    ancestors
}

fn ensure_archive_entry_size(plan: &ArchiveEntryPlan, copied: u64) -> Result<()> {
    if copied == plan.size as u64 {
        return Ok(());
    }
    bail!(
        "PGDATA archive entry {} contained {copied} bytes, expected {}",
        plan.relative.display(),
        plan.size
    )
}

fn collect_virtual_pgdata_entries(
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
    root: &Path,
    current: &Path,
    entries: &mut BTreeMap<PathBuf, VirtualEntrySource>,
) -> Result<()> {
    let mut children = filesystem
        .read_dir(current)
        .with_context(|| format!("read virtual PGDATA directory {}", current.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("read virtual PGDATA entries {}", current.display()))?;
    children.sort_by_key(|entry| entry.path());

    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("strip virtual PGDATA root {}", root.display()))?
            .to_path_buf();
        if relative.as_os_str().is_empty() || should_skip_relative(&relative) {
            continue;
        }
        let metadata = child
            .metadata()
            .with_context(|| format!("stat virtual PGDATA entry {}", path.display()))?;
        if metadata.is_dir() {
            entries.insert(relative.clone(), VirtualEntrySource::Directory);
            collect_virtual_pgdata_entries(filesystem, root, &path, entries)?;
        } else if metadata.is_file() {
            entries.insert(
                relative,
                VirtualEntrySource::File(vfs_read(filesystem, &path)?),
            );
        } else {
            bail!(
                "virtual PGDATA entry {} has unsupported type",
                path.display()
            );
        }
    }
    Ok(())
}

fn copy_pgdata_tree(
    source_root: &Path,
    destination_root: &Path,
    apply_whiteouts: bool,
) -> Result<()> {
    copy_pgdata_tree_with_hook(source_root, destination_root, apply_whiteouts, &mut |_| {
        Ok(())
    })
}

fn copy_pgdata_tree_with_hook<F>(
    source_root: &Path,
    destination_root: &Path,
    apply_whiteouts: bool,
    before_open: &mut F,
) -> Result<()>
where
    F: FnMut(&Path) -> Result<()>,
{
    let Some(root) = open_host_tree_root(source_root)? else {
        return Ok(());
    };

    walk_host_tree(
        &root,
        Path::new(""),
        source_root,
        before_open,
        &mut |relative, source| {
            match source {
                HostTreeEntry::Whiteout(target) => {
                    if apply_whiteouts {
                        remove_materialized_entry(&destination_root.join(target))?;
                    }
                }
                HostTreeEntry::Directory => {
                    let destination = destination_root.join(relative);
                    fs::create_dir_all(&destination).with_context(|| {
                        format!(
                            "create materialized PGDATA directory {}",
                            destination.display()
                        )
                    })?;
                }
                HostTreeEntry::File { mut file, size } => {
                    let destination = destination_root.join(relative);
                    if let Some(parent) = destination.parent() {
                        fs::create_dir_all(parent).with_context(|| {
                            format!("create materialized PGDATA directory {}", parent.display())
                        })?;
                    }
                    let mut output = File::create(&destination).with_context(|| {
                        format!("create materialized PGDATA file {}", destination.display())
                    })?;
                    let copied = io::copy(&mut file, &mut output).with_context(|| {
                        format!(
                            "copy PGDATA archive file {} -> {}",
                            relative.display(),
                            destination.display()
                        )
                    })?;
                    if copied != size {
                        bail!(
                            "PGDATA entry {} changed size while being copied: expected {size} bytes, copied {copied}",
                            relative.display()
                        );
                    }
                }
            }
            Ok(())
        },
    )
}

fn open_host_tree_root(root: &Path) -> Result<Option<CapDir>> {
    let name = root
        .file_name()
        .with_context(|| format!("PGDATA root {} has no directory name", root.display()))?;
    let parent = root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = match CapDir::open_ambient_dir(parent, ambient_authority()) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("open PGDATA parent directory {}", parent.display()));
        }
    };
    match parent.open_dir_nofollow(name) {
        Ok(root) => Ok(Some(root)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| {
            format!(
                "open PGDATA root {} without following symbolic links",
                root.display()
            )
        }),
    }
}

fn walk_host_tree<F, V>(
    directory: &CapDir,
    relative_directory: &Path,
    display_root: &Path,
    before_open: &mut F,
    visit: &mut V,
) -> Result<()>
where
    F: FnMut(&Path) -> Result<()>,
    V: FnMut(&Path, HostTreeEntry) -> Result<()>,
{
    let mut names = directory
        .entries()
        .with_context(|| {
            format!(
                "read PGDATA directory {}",
                display_root.join(relative_directory).display()
            )
        })?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()
        .with_context(|| {
            format!(
                "read PGDATA directory entries {}",
                display_root.join(relative_directory).display()
            )
        })?;
    names.sort();

    for name in names {
        let relative = relative_directory.join(&name);
        let whiteout_target = whiteout_target_relative(&relative);
        if whiteout_target.is_none() && should_skip_relative(&relative) {
            continue;
        }

        before_open(&relative)?;
        let mut options = CapOpenOptions::new();
        options
            .read(true)
            .follow(FollowSymlinks::No)
            .maybe_dir(true)
            .nonblock(true);
        let opened = match directory.open_with(&name, &options) {
            Ok(opened) => opened,
            Err(error) => {
                if directory
                    .symlink_metadata(&name)
                    .is_ok_and(|metadata| !metadata.is_dir() && !metadata.is_file())
                {
                    bail!(
                        "PGDATA entry {} has unsupported type",
                        display_root.join(&relative).display()
                    );
                }
                return Err(error).with_context(|| {
                    format!(
                        "open PGDATA entry {} without following symbolic links",
                        display_root.join(&relative).display()
                    )
                });
            }
        };
        let metadata = opened.metadata().with_context(|| {
            format!(
                "stat opened PGDATA entry {}",
                display_root.join(&relative).display()
            )
        })?;

        if let Some(target) = whiteout_target {
            if !metadata.is_file() || metadata.len() != 0 {
                bail!(
                    "PGDATA whiteout {} must be an empty regular file",
                    display_root.join(&relative).display()
                );
            }
            visit(&relative, HostTreeEntry::Whiteout(target))?;
            continue;
        }

        if metadata.is_dir() {
            visit(&relative, HostTreeEntry::Directory)?;
            let child = CapDir::from_std_file(opened.into_std());
            walk_host_tree(&child, &relative, display_root, before_open, visit)?;
        } else if metadata.is_file() {
            visit(
                &relative,
                HostTreeEntry::File {
                    file: opened,
                    size: metadata.len(),
                },
            )?;
        } else {
            bail!(
                "PGDATA entry {} has unsupported type",
                display_root.join(&relative).display()
            );
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
            Component::CurDir => {}
            Component::Normal(part) => dest.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("unsafe PGDATA archive path {}", path.display())
            }
        }
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

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

        let archive = dump_pgdata_archive(&upper, Some(&lower), PhysicalArchiveEncoding::Tar)?;
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

        let archive = dump_pgdata_archive(&upper, Some(&lower), PhysicalArchiveEncoding::Tar)?;
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

    #[cfg(unix)]
    #[test]
    fn pgdata_archive_rejects_symbolic_link_whiteouts() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let lower = temp.path().join("lower");
        let upper = temp.path().join("upper");
        fs::create_dir_all(lower.join("base/1"))?;
        fs::create_dir_all(upper.join("base/1"))?;
        fs::write(lower.join("base/1/value"), b"lower")?;
        symlink("value", upper.join("base/1/.wh.value"))?;

        let error =
            dump_pgdata_archive(&upper, Some(&lower), PhysicalArchiveEncoding::Tar).unwrap_err();

        assert!(
            error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[test]
    fn pgdata_archive_rejects_nonempty_whiteouts() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let lower = temp.path().join("lower");
        let upper = temp.path().join("upper");
        fs::create_dir_all(lower.join("base/1"))?;
        fs::create_dir_all(upper.join("base/1"))?;
        fs::write(lower.join("base/1/value"), b"lower")?;
        fs::write(upper.join("base/1/.wh.value"), b"not a marker")?;

        let error =
            dump_pgdata_archive(&upper, Some(&lower), PhysicalArchiveEncoding::Tar).unwrap_err();

        assert!(
            error.to_string().contains("must be an empty regular file"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_archive_rejects_symbolic_links() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        fs::create_dir_all(pgdata.join("pg_tblspc"))?;
        symlink("/external/tablespace", pgdata.join("pg_tblspc/16384"))?;

        let error = dump_pgdata_archive(&pgdata, None, PhysicalArchiveEncoding::Tar).unwrap_err();

        assert!(
            error.to_string().contains("PGDATA entry")
                && error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_archive_rejects_special_files() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        fs::create_dir_all(&pgdata)?;
        let socket = pgdata.join("unexpected.sock");
        let _listener = UnixListener::bind(&socket)?;

        let error = dump_pgdata_archive(&pgdata, None, PhysicalArchiveEncoding::Tar).unwrap_err();

        assert!(
            error.to_string().contains("unexpected.sock")
                && error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn materialized_pgdata_archiver_independently_rejects_symbolic_links() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        fs::create_dir_all(&pgdata)?;
        symlink("target", pgdata.join("link"))?;

        let error =
            dump_materialized_pgdata_archive(&pgdata, PhysicalArchiveEncoding::Tar).unwrap_err();

        assert!(
            error.to_string().contains("link") && error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_tree_copy_rejects_symbolic_links() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        let clone = temp.path().join("clone");
        fs::create_dir_all(&pgdata)?;
        fs::create_dir_all(&clone)?;
        symlink("target", pgdata.join("link"))?;

        let error = copy_pgdata_tree(&pgdata, &clone, false).unwrap_err();

        assert!(
            error.to_string().contains("link") && error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_archiver_rejects_file_swapped_to_symlink_before_open() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("value"), b"inside")?;
        fs::write(&outside, b"outside")?;

        let mut swapped = false;
        let error = dump_materialized_pgdata_archive_with_hook(
            &pgdata,
            PhysicalArchiveEncoding::Tar,
            &mut |relative| {
                if relative == Path::new("value") {
                    fs::remove_file(pgdata.join(relative))?;
                    symlink(&outside, pgdata.join(relative))?;
                    swapped = true;
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert!(swapped, "the test seam must replace the enumerated file");
        assert!(
            error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_tree_copy_rejects_file_swapped_to_symlink_before_open() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        let destination = temp.path().join("destination");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&pgdata)?;
        fs::create_dir_all(&destination)?;
        fs::write(pgdata.join("value"), b"inside")?;
        fs::write(&outside, b"outside")?;

        let error = copy_pgdata_tree_with_hook(&pgdata, &destination, false, &mut |relative| {
            if relative == Path::new("value") {
                fs::remove_file(pgdata.join(relative))?;
                symlink(&outside, pgdata.join(relative))?;
            }
            Ok(())
        })
        .unwrap_err();

        assert!(
            error.to_string().contains("unsupported type"),
            "unexpected error: {error:#}"
        );
        assert!(!destination.join("value").exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn host_tree_walker_reads_the_opened_file_after_path_replacement() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&pgdata)?;
        fs::write(pgdata.join("value"), b"opened")?;
        fs::write(&outside, b"outside")?;
        let root = open_host_tree_root(&pgdata)?.context("open test PGDATA")?;
        let mut observed = Vec::new();

        walk_host_tree(
            &root,
            Path::new(""),
            &pgdata,
            &mut |_| Ok(()),
            &mut |relative, source| {
                if let HostTreeEntry::File { mut file, .. } = source {
                    fs::rename(pgdata.join(relative), pgdata.join("opened-value"))?;
                    symlink(&outside, pgdata.join(relative))?;
                    file.read_to_end(&mut observed)?;
                }
                Ok(())
            },
        )?;

        assert_eq!(observed, b"opened");
        Ok(())
    }

    #[test]
    fn virtual_pgdata_archive_round_trips_and_drops_runtime_state() -> Result<()> {
        let source = virtual_fs::mem_fs::FileSystem::default();
        vfs_write(&source, Path::new("/PG_VERSION"), b"18\n")?;
        vfs_write(&source, Path::new("/global/pg_control"), b"control")?;
        vfs_write(&source, Path::new("/base/1/value"), b"kept")?;
        vfs_write(&source, Path::new("/postmaster.pid"), b"stale")?;

        let archive = dump_virtual_pgdata_archive(&source, PhysicalArchiveEncoding::TarGz)?;
        let restored = virtual_fs::mem_fs::FileSystem::default();
        unpack_virtual_pgdata_archive(&archive, &restored)?;

        assert_eq!(vfs_read(&restored, Path::new("/PG_VERSION"))?, b"18\n");
        assert_eq!(
            vfs_read(&restored, Path::new("/global/pg_control"))?,
            b"control"
        );
        assert_eq!(vfs_read(&restored, Path::new("/base/1/value"))?, b"kept");
        assert!(!vfs_file_exists(&restored, Path::new("/postmaster.pid")));
        Ok(())
    }

    #[test]
    fn invalid_duplicate_archive_does_not_mutate_host_destination() -> Result<()> {
        let archive = test_archive(&[
            ("base/value", ArchiveEntryKind::File, b"first"),
            ("./base/value", ArchiveEntryKind::File, b"second"),
        ])?;
        let temp = tempfile::TempDir::new()?;
        let destination = temp.path().join("destination");
        fs::create_dir_all(&destination)?;
        fs::write(destination.join("sentinel"), b"unchanged")?;

        let error = unpack_pgdata_archive(&archive, &destination).unwrap_err();

        assert!(
            error.to_string().contains("duplicate entry"),
            "unexpected error: {error:#}"
        );
        assert_eq!(fs::read(destination.join("sentinel"))?, b"unchanged");
        assert!(!destination.join("base").exists());
        Ok(())
    }

    #[test]
    fn invalid_tree_shape_does_not_mutate_virtual_destination() -> Result<()> {
        let archive = test_archive(&[
            ("base/value", ArchiveEntryKind::File, b"child"),
            ("base", ArchiveEntryKind::File, b"parent"),
        ])?;
        let destination = virtual_fs::mem_fs::FileSystem::default();
        vfs_write(&destination, Path::new("/sentinel"), b"unchanged")?;

        let error = unpack_virtual_pgdata_archive(&archive, &destination).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("conflicts with existing child entries"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            vfs_read(&destination, Path::new("/sentinel"))?,
            b"unchanged"
        );
        assert!(!vfs_file_exists(&destination, Path::new("/base/value")));
        Ok(())
    }

    #[test]
    fn archive_rejects_entries_nested_below_files() -> Result<()> {
        let archive = test_archive(&[
            ("base", ArchiveEntryKind::File, b"parent"),
            ("base/value", ArchiveEntryKind::File, b"child"),
        ])?;

        let error = validate_pgdata_archive(&archive).unwrap_err();

        assert!(
            error.to_string().contains("nested under file entry"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[test]
    fn truncated_archive_does_not_mutate_host_destination() -> Result<()> {
        let mut archive = test_archive(&[("base/value", ArchiveEntryKind::File, b"value")])?;
        archive.truncate(archive.len() - TAR_BLOCK_BYTES);
        let temp = tempfile::TempDir::new()?;
        let destination = temp.path().join("destination");
        fs::create_dir_all(&destination)?;
        fs::write(destination.join("sentinel"), b"unchanged")?;

        let error = unpack_pgdata_archive(&archive, &destination).unwrap_err();

        assert!(
            error.to_string().contains("invalid tar framing"),
            "unexpected error: {error:#}"
        );
        assert_eq!(fs::read(destination.join("sentinel"))?, b"unchanged");
        assert!(!destination.join("base").exists());
        Ok(())
    }

    #[test]
    fn invalid_gzip_checksum_does_not_mutate_virtual_destination() -> Result<()> {
        let archive = test_archive(&[("base/value", ArchiveEntryKind::File, b"value")])?;
        let mut archive = compress_archive(archive, PhysicalArchiveEncoding::TarGz)?;
        let checksum = archive
            .len()
            .checked_sub(8)
            .context("gzip archive has no footer")?;
        archive[checksum] ^= 0xff;
        let destination = virtual_fs::mem_fs::FileSystem::default();
        vfs_write(&destination, Path::new("/sentinel"), b"unchanged")?;

        let error = unpack_virtual_pgdata_archive(&archive, &destination).unwrap_err();

        assert!(
            error.to_string().contains("PGDATA archive"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            vfs_read(&destination, Path::new("/sentinel"))?,
            b"unchanged"
        );
        assert!(!vfs_file_exists(&destination, Path::new("/base/value")));
        Ok(())
    }

    #[test]
    fn archive_rejects_absolute_paths() -> Result<()> {
        let archive = test_archive_with_raw_path(b"/base/value", b"value")?;

        let error = validate_pgdata_archive(&archive).unwrap_err();

        assert!(
            error.to_string().contains("unsafe PGDATA archive path"),
            "unexpected error: {error:#}"
        );
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

    fn test_archive(entries: &[(&str, ArchiveEntryKind, &[u8])]) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut builder = Builder::new(&mut bytes);
            for (path, kind, contents) in entries {
                let mut header = Header::new_gnu();
                header.set_entry_type(match kind {
                    ArchiveEntryKind::Directory => EntryType::Directory,
                    ArchiveEntryKind::File => EntryType::Regular,
                });
                header.set_mode(0o700);
                header.set_mtime(0);
                header.set_size(contents.len() as u64);
                header.set_cksum();
                builder.append_data(&mut header, path, Cursor::new(*contents))?;
            }
            builder.finish()?;
        }
        Ok(bytes)
    }

    fn test_archive_with_raw_path(path: &[u8], contents: &[u8]) -> Result<Vec<u8>> {
        assert!(path.len() <= 100);
        let mut bytes = Vec::new();
        {
            let mut builder = Builder::new(&mut bytes);
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(0o700);
            header.set_mtime(0);
            header.set_size(contents.len() as u64);
            header.set_path("placeholder")?;
            header.as_mut_bytes()[..100].fill(0);
            header.as_mut_bytes()[..path.len()].copy_from_slice(path);
            header.set_cksum();
            builder.append(&header, Cursor::new(contents))?;
            builder.finish()?;
        }
        Ok(bytes)
    }
}
