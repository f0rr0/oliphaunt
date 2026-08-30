use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use cap_fs_ext::{
    DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt, OpenOptionsSyncExt,
};
use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapDir, File as CapFile, OpenOptions as CapOpenOptions};
use tar::{Archive, Builder, EntryType, Header};
use wasmer_wasix::virtual_fs::FileSystem as VirtualFileSystem;

use super::base::DirectoryLock;
use super::database_root_descriptor::{
    PGDATA_DIRECTORY, PHYSICAL_FORMAT, POSTGRES_MAJOR, write_database_root_descriptor,
};
use crate::oliphaunt::storage::{PgDataStorage, vfs_read};
use crate::{StorageCommitState, StorageErrorCode, StorageErrorPhase};

const PHYSICAL_ARCHIVE_MANIFEST_NAME: &str = ".oliphaunt/backup-manifest.properties";
const PHYSICAL_ARCHIVE_LAYOUT: &str = "oliphaunt-physical-archive-v1";
const TRANSIENT_ROOT_FILES: &[&str] = &[
    "postmaster.pid",
    "postmaster.opts",
    "postgresql.auto.conf.tmp",
    "current_logfiles.tmp",
    "backup_manifest",
];
const TRANSIENT_STATE_DIRECTORIES: &[&str] = &[
    "pg_dynshmem",
    "pg_notify",
    "pg_replslot",
    "pg_serial",
    "pg_snapshots",
    "pg_stat_tmp",
    "pg_subtrans",
];
const TAR_BLOCK_BYTES: usize = 512;
const TAR_END_BYTES: usize = TAR_BLOCK_BYTES * 2;

enum HostTreeEntry {
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

fn dump_materialized_pgdata_archive(pgdata: &Path) -> Result<Vec<u8>> {
    dump_materialized_pgdata_archive_with_hook(pgdata, &mut |_| Ok(()))
}

fn dump_materialized_pgdata_archive_with_hook<F>(
    pgdata: &Path,
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
            &should_skip_backup_entry,
            before_open,
            &mut |relative, source| {
                let archive_path = archive_path(relative)?;
                match source {
                    HostTreeEntry::Directory => {
                        let mut header = Header::new_ustar();
                        header.set_entry_type(EntryType::Directory);
                        header.set_mode(0o700);
                        header.set_mtime(0);
                        header.set_size(0);
                        header.set_cksum();
                        builder
                            .append_data(&mut header, archive_path, Cursor::new(Vec::<u8>::new()))
                            .context("append PGDATA directory to archive")?;
                    }
                    HostTreeEntry::File { mut file, size } => {
                        let mut header = Header::new_ustar();
                        header.set_entry_type(EntryType::Regular);
                        header.set_mode(0o600);
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
        append_physical_archive_manifest(&mut builder)?;
        builder.finish().context("finish PGDATA tar archive")?;
    }

    Ok(tar_bytes)
}

fn append_physical_archive_manifest<W: Write>(builder: &mut Builder<W>) -> Result<()> {
    let bytes = physical_archive_manifest_text().into_bytes();
    let mut header = Header::new_ustar();
    header.set_entry_type(EntryType::Regular);
    header.set_mode(0o600);
    header.set_mtime(0);
    header.set_size(bytes.len() as u64);
    header.set_cksum();
    builder
        .append_data(
            &mut header,
            PHYSICAL_ARCHIVE_MANIFEST_NAME,
            Cursor::new(bytes),
        )
        .context("append WASIX physical archive manifest")
}

fn physical_archive_manifest_text() -> String {
    format!(
        "archiveLayout={PHYSICAL_ARCHIVE_LAYOUT}\n\
         product=oliphaunt\n\
         engineFamily=wasix\n\
         physicalFormat={PHYSICAL_FORMAT}\n\
         postgresMajor={POSTGRES_MAJOR}\n"
    )
}

pub(crate) fn materialize_pgdata(pgdata: &Path) -> Result<tempfile::TempDir> {
    let temp = tempfile::TempDir::new().context("create materialized PGDATA archive view")?;
    copy_pgdata_tree(pgdata, temp.path())?;
    Ok(temp)
}

pub(crate) fn materialize_virtual_pgdata_view(
    filesystem: &(dyn VirtualFileSystem + Send + Sync),
) -> Result<tempfile::TempDir> {
    let temp = tempfile::TempDir::new().context("create materialized virtual PGDATA view")?;
    let mut entries = BTreeMap::<PathBuf, VirtualEntrySource>::new();
    collect_virtual_pgdata_entries(filesystem, Path::new("/"), Path::new("/"), &mut entries)?;
    for (relative, source) in entries {
        let destination = temp.path().join(relative);
        match source {
            VirtualEntrySource::Directory => fs::create_dir_all(&destination)
                .with_context(|| format!("create {}", destination.display()))?,
            VirtualEntrySource::File(bytes) => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&destination, bytes)
                    .with_context(|| format!("write {}", destination.display()))?;
            }
        }
    }
    Ok(temp)
}

pub(crate) fn refresh_materialized_pg_control(
    storage: &PgDataStorage,
    materialized: &Path,
) -> Result<()> {
    let relative = Path::new("global/pg_control");
    let bytes = match storage {
        PgDataStorage::HostDirectory(pgdata) => fs::read(pgdata.join(relative))
            .context("read final PGDATA global/pg_control for physical backup")?,
        PgDataStorage::Memory(filesystem) => {
            vfs_read(filesystem.as_ref(), &Path::new("/").join(relative))
                .context("read final virtual PGDATA global/pg_control for physical backup")?
        }
    };
    ensure!(!bytes.is_empty(), "final PGDATA global/pg_control is empty");
    fs::write(materialized.join(relative), bytes)
        .context("refresh final PGDATA global/pg_control for physical backup")
}

pub(crate) fn finish_online_physical_archive(
    before_stop: tempfile::TempDir,
    storage: &PgDataStorage,
    start_wal: &str,
    stop_wal: &str,
    wal_segment_size: u64,
    backup_label: &str,
    tablespace_map: Option<&str>,
) -> Result<Vec<u8>> {
    ensure!(
        !backup_label.is_empty(),
        "pg_backup_stop returned an empty backup label"
    );
    for path in ["pg_wal", "backup_label", "tablespace_map"] {
        remove_materialized_entry(&before_stop.path().join(path))?;
    }
    let destination_wal = before_stop.path().join("pg_wal");
    fs::create_dir_all(&destination_wal)?;
    let wal_names = required_backup_wal_names(start_wal, stop_wal, wal_segment_size)?;
    copy_required_wal_segments(storage, &destination_wal, &wal_names, wal_segment_size)?;
    fs::write(before_stop.path().join("backup_label"), backup_label)
        .context("write generated backup_label")?;
    if let Some(tablespace_map) = tablespace_map.filter(|value| !value.is_empty()) {
        fs::write(before_stop.path().join("tablespace_map"), tablespace_map)
            .context("write generated tablespace_map")?;
    }
    dump_materialized_pgdata_archive(before_stop.path())
}

fn copy_required_wal_segments(
    storage: &PgDataStorage,
    destination: &Path,
    names: &[String],
    segment_size: u64,
) -> Result<()> {
    match storage {
        PgDataStorage::HostDirectory(pgdata) => {
            let root = open_host_tree_root(pgdata)?
                .context("PGDATA disappeared while collecting physical backup WAL")?;
            let wal = root
                .open_dir_nofollow("pg_wal")
                .context("open final PGDATA pg_wal without following symbolic links")?;
            for name in names {
                let mut options = CapOpenOptions::new();
                options.read(true).follow(FollowSymlinks::No).nonblock(true);
                let mut source = wal
                    .open_with(name, &options)
                    .with_context(|| format!("physical backup is missing WAL segment {name}"))?;
                let metadata = source
                    .metadata()
                    .with_context(|| format!("stat physical backup WAL segment {name}"))?;
                ensure!(
                    metadata.is_file() && metadata.len() == segment_size,
                    "physical backup WAL segment {name} has the wrong size"
                );
                let mut output = File::create(destination.join(name))
                    .with_context(|| format!("create physical backup WAL segment {name}"))?;
                let copied = io::copy(&mut source, &mut output)
                    .with_context(|| format!("copy physical backup WAL segment {name}"))?;
                ensure!(
                    copied == segment_size,
                    "physical backup WAL segment {name} changed size while being copied"
                );
            }
        }
        PgDataStorage::Memory(filesystem) => {
            for name in names {
                let bytes = vfs_read(filesystem.as_ref(), &Path::new("/pg_wal").join(name))
                    .with_context(|| format!("physical backup is missing WAL segment {name}"))?;
                ensure!(
                    bytes.len() as u64 == segment_size,
                    "physical backup WAL segment {name} has the wrong size"
                );
                fs::write(destination.join(name), bytes)
                    .with_context(|| format!("write physical backup WAL segment {name}"))?;
            }
        }
    }
    Ok(())
}

fn required_backup_wal_names(
    start_name: &str,
    stop_name: &str,
    segment_size: u64,
) -> Result<Vec<String>> {
    ensure!(
        (1024 * 1024..=1024 * 1024 * 1024).contains(&segment_size)
            && segment_size.is_power_of_two(),
        "PostgreSQL returned an invalid WAL segment size"
    );
    let start = parse_wal_name(start_name, segment_size)?;
    let stop = parse_wal_name(stop_name, segment_size)?;
    ensure!(
        start.0 == stop.0,
        "physical backup WAL range crosses timelines"
    );
    ensure!(start.1 <= stop.1, "physical backup WAL range is reversed");
    let segments_per_log = (u32::MAX as u64 + 1) / segment_size;
    let count = stop.1 - start.1 + 1;
    let mut names = Vec::new();
    names
        .try_reserve_exact(
            usize::try_from(count).context("physical backup WAL range is too large")?,
        )
        .context("physical backup WAL range is too large")?;
    for segment in start.1..=stop.1 {
        let log = segment / segments_per_log;
        let index = segment % segments_per_log;
        names.push(format!("{:08X}{:08X}{:08X}", start.0, log, index));
    }
    Ok(names)
}

fn parse_wal_name(name: &str, segment_size: u64) -> Result<(u32, u64)> {
    ensure!(
        name.len() == 24
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte)),
        "PostgreSQL returned an invalid WAL filename {name:?}"
    );
    let timeline = u32::from_str_radix(&name[0..8], 16)
        .with_context(|| format!("PostgreSQL returned an invalid WAL filename {name:?}"))?;
    let log = u32::from_str_radix(&name[8..16], 16)
        .with_context(|| format!("PostgreSQL returned an invalid WAL filename {name:?}"))?;
    let index = u32::from_str_radix(&name[16..24], 16)
        .with_context(|| format!("PostgreSQL returned an invalid WAL filename {name:?}"))?;
    let segments_per_log = (u32::MAX as u64 + 1) / segment_size;
    ensure!(
        u64::from(index) < segments_per_log,
        "PostgreSQL returned an invalid WAL filename {name:?}"
    );
    Ok((
        timeline,
        u64::from(log) * segments_per_log + u64::from(index),
    ))
}

pub(crate) fn unpack_pgdata_archive(bytes: &[u8], destination: &Path) -> Result<()> {
    let plans = validate_pgdata_archive(bytes)?;
    create_private_directory_tree(destination, destination)?;
    let destination_root = destination;
    apply_validated_pgdata_archive(bytes, &plans, |entry, plan| {
        if should_skip_restore_entry(&plan.relative) {
            return Ok(());
        }

        let entry_destination = destination_root.join(&plan.relative);
        if plan.kind == ArchiveEntryKind::Directory {
            create_private_directory_tree(destination_root, &entry_destination)?;
            return Ok(());
        }

        if let Some(parent) = entry_destination.parent() {
            create_private_directory_tree(destination_root, parent)?;
        }
        let mut file = create_private_file(&entry_destination)
            .with_context(|| format!("create PGDATA file {}", entry_destination.display()))?;
        let copied = io::copy(entry, &mut file)
            .with_context(|| format!("write PGDATA file {}", entry_destination.display()))?;
        ensure_archive_entry_size(plan, copied)?;
        apply_private_permissions(&entry_destination, 0o600)
    })
}

pub(crate) fn restore_physical_archive(destination: &Path, bytes: &[u8]) -> Result<()> {
    let _directory_lock =
        DirectoryLock::acquire_for_phase(destination, StorageErrorPhase::RestoreValidation)?;
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("create restore parent {}", parent.display()))
        .map_err(|error| {
            restore_error(
                error,
                StorageErrorCode::Unavailable,
                StorageCommitState::Unchanged,
                StorageErrorPhase::RestoreValidation,
            )
        })?;

    let destination_existed = match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(restore_message(
                    format!(
                        "physical restore destination {} is not a real directory",
                        destination.display()
                    ),
                    StorageErrorCode::Incomplete,
                    StorageCommitState::Unchanged,
                    StorageErrorPhase::RestoreValidation,
                ));
            }
            let empty = fs::read_dir(destination)
                .and_then(|mut entries| entries.next().transpose())
                .map_err(|error| {
                    restore_error(
                        anyhow::Error::new(error).context(format!(
                            "inspect restore destination {}",
                            destination.display()
                        )),
                        StorageErrorCode::Unavailable,
                        StorageCommitState::Unchanged,
                        StorageErrorPhase::RestoreValidation,
                    )
                })?
                .is_none();
            if !empty {
                return Err(restore_message(
                    format!(
                        "physical restore destination {} is not empty",
                        destination.display()
                    ),
                    StorageErrorCode::Incomplete,
                    StorageCommitState::Unchanged,
                    StorageErrorPhase::RestoreValidation,
                ));
            }
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(restore_error(
                anyhow::Error::new(error).context(format!(
                    "inspect restore destination {}",
                    destination.display()
                )),
                StorageErrorCode::Unavailable,
                StorageCommitState::Unchanged,
                StorageErrorPhase::RestoreValidation,
            ));
        }
    };

    let staging = tempfile::Builder::new()
        .prefix(".oliphaunt-restore-")
        .tempdir_in(parent)
        .with_context(|| format!("create restore staging directory in {}", parent.display()))
        .map_err(|error| {
            restore_error(
                error,
                StorageErrorCode::Unavailable,
                StorageCommitState::Unchanged,
                StorageErrorPhase::RestoreStaging,
            )
        })?;
    let pgdata = staging.path().join(PGDATA_DIRECTORY);
    unpack_pgdata_archive(bytes, &pgdata).map_err(|error| {
        let code = restore_payload_error_code(&error);
        restore_error(
            error,
            code,
            StorageCommitState::Unchanged,
            if code == StorageErrorCode::Corrupt {
                StorageErrorPhase::RestoreValidation
            } else {
                StorageErrorPhase::RestoreStaging
            },
        )
    })?;
    write_database_root_descriptor(staging.path()).map_err(|error| {
        restore_error(
            error,
            StorageErrorCode::Unavailable,
            StorageCommitState::Unchanged,
            StorageErrorPhase::RestoreStaging,
        )
    })?;

    if destination_existed {
        fs::remove_dir(destination)
            .with_context(|| {
                format!(
                    "replace empty restore destination {}",
                    destination.display()
                )
            })
            .map_err(|error| {
                restore_error(
                    error,
                    StorageErrorCode::PublicationFailed,
                    StorageCommitState::Unknown,
                    StorageErrorPhase::RestorePublication,
                )
            })?;
    }
    if let Err(error) = fs::rename(staging.path(), destination) {
        if destination_existed {
            let recovery = fs::create_dir(destination);
            let commit_state = if recovery.is_ok() {
                StorageCommitState::Unchanged
            } else {
                StorageCommitState::Unknown
            };
            let source = match recovery {
                Ok(()) => anyhow::Error::new(error),
                Err(recovery) => anyhow::Error::new(error).context(format!(
                    "restore publication recovery also failed: {recovery}"
                )),
            };
            return Err(restore_error(
                source.context(format!(
                    "publish restored database root {}",
                    destination.display()
                )),
                StorageErrorCode::PublicationFailed,
                commit_state,
                StorageErrorPhase::RestorePublication,
            ));
        }
        return Err(restore_error(
            anyhow::Error::new(error).context(format!(
                "publish restored database root {}",
                destination.display()
            )),
            StorageErrorCode::PublicationFailed,
            StorageCommitState::Unchanged,
            StorageErrorPhase::RestorePublication,
        ));
    }
    sync_parent_directory(parent).map_err(|error| {
        restore_error(
            error,
            StorageErrorCode::PublicationFailed,
            StorageCommitState::Unknown,
            StorageErrorPhase::RestoreDurability,
        )
    })?;
    Ok(())
}

fn restore_payload_error_code(error: &anyhow::Error) -> StorageErrorCode {
    let mut saw_io = false;
    for cause in error.chain() {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            if matches!(
                io.kind(),
                std::io::ErrorKind::InvalidData | std::io::ErrorKind::UnexpectedEof
            ) {
                return StorageErrorCode::Corrupt;
            }
            saw_io = true;
        }
    }
    if saw_io {
        StorageErrorCode::Unavailable
    } else {
        StorageErrorCode::Corrupt
    }
}

fn restore_error(
    error: anyhow::Error,
    code: StorageErrorCode,
    commit_state: StorageCommitState,
    phase: StorageErrorPhase,
) -> anyhow::Error {
    crate::error::storage_error(error, code, commit_state, phase)
}

fn restore_message(
    message: String,
    code: StorageErrorCode,
    commit_state: StorageCommitState,
    phase: StorageErrorPhase,
) -> anyhow::Error {
    crate::error::storage_message(message, code, commit_state, phase)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn validate_pgdata_archive(bytes: &[u8]) -> Result<Vec<ArchiveEntryPlan>> {
    validate_raw_tar_structure(bytes)?;
    let mut archive = open_pgdata_archive(bytes);
    let entries = archive.entries().context("read PGDATA archive entries")?;
    let mut plans = Vec::new();
    let mut seen_paths = BTreeSet::new();
    let mut seen_file_paths = BTreeSet::new();
    let mut seen_entry_ancestors = BTreeSet::new();
    let mut expanded_size = 0usize;
    let mut has_manifest = false;
    let mut has_pg_version = false;
    let mut has_pg_control = false;
    let mut has_backup_label = false;
    let mut has_base = false;
    let mut has_pg_wal = false;

    for entry in entries {
        let mut entry = entry.context("read PGDATA archive entry")?;
        let plan = archive_entry_plan(&entry)?;
        ensure!(
            plan.relative != Path::new("postmaster.pid")
                && plan.relative != Path::new("postmaster.opts"),
            "WASIX physical archive must not contain PostgreSQL process state {}",
            plan.relative.display()
        );
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

        let copied = if plan.relative == Path::new(PHYSICAL_ARCHIVE_MANIFEST_NAME) {
            ensure!(
                plan.kind == ArchiveEntryKind::File,
                "WASIX physical archive manifest must be a file"
            );
            has_manifest = true;
            let mut contents = Vec::new();
            contents
                .try_reserve_exact(plan.size)
                .context("reserve WASIX physical archive manifest")?;
            let copied = io::copy(&mut entry, &mut contents)
                .context("read WASIX physical archive manifest")?;
            ensure!(
                contents == physical_archive_manifest_text().as_bytes(),
                "WASIX physical archive has incompatible compatibility metadata"
            );
            copied
        } else if plan.relative == Path::new("PG_VERSION") {
            ensure!(
                plan.kind == ArchiveEntryKind::File,
                "WASIX physical archive pgdata/PG_VERSION must be a regular file"
            );
            let mut contents = Vec::new();
            contents
                .try_reserve_exact(plan.size)
                .context("reserve PGDATA archive PG_VERSION")?;
            let copied =
                io::copy(&mut entry, &mut contents).context("read PGDATA archive PG_VERSION")?;
            let version =
                std::str::from_utf8(&contents).context("PGDATA archive PG_VERSION is not UTF-8")?;
            ensure!(
                version.trim() == POSTGRES_MAJOR.to_string(),
                "PGDATA archive PG_VERSION must contain PostgreSQL {POSTGRES_MAJOR}"
            );
            has_pg_version = true;
            copied
        } else {
            if plan.relative == Path::new("global/pg_control") {
                ensure!(
                    plan.kind == ArchiveEntryKind::File && plan.size > 0,
                    "WASIX physical archive pgdata/global/pg_control must be a non-empty regular file"
                );
                has_pg_control = true;
            }
            if plan.relative == Path::new("backup_label") {
                ensure!(
                    plan.kind == ArchiveEntryKind::File && plan.size > 0,
                    "WASIX physical archive pgdata/backup_label must be a non-empty regular file"
                );
                has_backup_label = true;
            }
            has_base |=
                plan.relative == Path::new("base") && plan.kind == ArchiveEntryKind::Directory;
            has_pg_wal |=
                plan.relative == Path::new("pg_wal") && plan.kind == ArchiveEntryKind::Directory;
            io::copy(&mut entry, &mut io::sink()).with_context(|| {
                format!("validate PGDATA archive entry {}", plan.relative.display())
            })?
        };
        ensure_archive_entry_size(&plan, copied)?;
        plans
            .try_reserve(1)
            .context("PGDATA archive contains too many entries")?;
        plans.push(plan);
    }
    let mut reader = archive.into_inner();
    io::copy(&mut reader, &mut io::sink()).context("finish reading PGDATA archive")?;
    reader.validate_framing()?;
    ensure!(
        has_manifest,
        "WASIX physical archive is missing its compatibility manifest"
    );
    ensure!(
        has_pg_version,
        "WASIX physical archive is missing pgdata/PG_VERSION"
    );
    ensure!(
        has_pg_control,
        "WASIX physical archive is missing pgdata/global/pg_control"
    );
    ensure!(has_base, "WASIX physical archive is missing pgdata/base");
    ensure!(
        has_pg_wal,
        "WASIX physical archive is missing pgdata/pg_wal"
    );
    ensure!(
        has_backup_label,
        "WASIX physical archive is missing pgdata/backup_label"
    );
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

fn open_pgdata_archive(bytes: &[u8]) -> Archive<FramedArchiveReader<Cursor<&[u8]>>> {
    Archive::new(FramedArchiveReader::new(Cursor::new(bytes)))
}

fn validate_raw_tar_structure(bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() >= TAR_END_BYTES && bytes.len().is_multiple_of(TAR_BLOCK_BYTES),
        "PGDATA archive has invalid tar framing"
    );
    let mut offset = 0usize;
    while offset + TAR_BLOCK_BYTES <= bytes.len() {
        let header = &bytes[offset..offset + TAR_BLOCK_BYTES];
        if header.iter().all(|byte| *byte == 0) {
            ensure!(
                bytes.len() - offset >= TAR_END_BYTES
                    && bytes[offset..].iter().all(|byte| *byte == 0),
                "PGDATA archive has trailing data after its tar terminator"
            );
            return Ok(());
        }
        let supported_header = (&header[257..263] == b"ustar\0" && &header[263..265] == b"00")
            || (&header[257..263] == b"ustar " && &header[263..265] == b" \0");
        ensure!(
            supported_header,
            "PGDATA archive entry does not use a supported ustar header"
        );
        ensure!(
            header[157..257].iter().all(|byte| *byte == 0),
            "PGDATA archive entry has a non-empty link target"
        );
        ensure!(
            matches!(header[156], 0 | b'0' | b'5'),
            "PGDATA archive entry has an unsupported type"
        );
        let mode = parse_raw_tar_octal(&header[100..108], "mode", false)?;
        parse_raw_tar_octal(&header[108..116], "uid", true)?;
        parse_raw_tar_octal(&header[116..124], "gid", true)?;
        let size = parse_raw_tar_octal(&header[124..136], "size", false)?;
        parse_raw_tar_octal(&header[136..148], "mtime", true)?;
        ensure!(
            mode & !0o777 == 0,
            "PGDATA archive entry mode contains unsupported permission bits"
        );
        let size =
            usize::try_from(size).context("PGDATA archive tar size exceeds this platform")?;
        if header[156] == b'5' {
            ensure!(
                size == 0,
                "PGDATA archive directory entry has non-zero size"
            );
        }
        let padded = size
            .checked_add(TAR_BLOCK_BYTES - 1)
            .context("PGDATA archive entry size overflow")?
            / TAR_BLOCK_BYTES
            * TAR_BLOCK_BYTES;
        offset = offset
            .checked_add(TAR_BLOCK_BYTES)
            .and_then(|value| value.checked_add(padded))
            .context("PGDATA archive entry offset overflow")?;
        ensure!(
            offset <= bytes.len(),
            "PGDATA archive ended in the middle of an entry"
        );
    }
    bail!("PGDATA archive is missing its tar terminator")
}

fn parse_raw_tar_octal(field: &[u8], label: &str, allow_empty: bool) -> Result<u64> {
    let mut value = 0_u64;
    let mut saw_digit = false;
    let mut ended = false;
    for byte in field {
        match byte {
            b'0'..=b'7' if !ended => {
                saw_digit = true;
                value = value
                    .checked_mul(8)
                    .and_then(|value| value.checked_add(u64::from(byte - b'0')))
                    .with_context(|| format!("PGDATA archive tar {label} field overflows"))?;
            }
            b' ' | 0 if !saw_digit => {}
            b' ' | 0 => ended = true,
            _ => bail!("PGDATA archive entry has invalid tar {label} field"),
        }
    }
    ensure!(
        saw_digit || allow_empty,
        "PGDATA archive entry has invalid tar {label} field"
    );
    Ok(value)
}

fn archive_entry_plan<R: Read>(entry: &tar::Entry<'_, R>) -> Result<ArchiveEntryPlan> {
    let header = entry.header().as_bytes();
    let supported_header = (&header[257..263] == b"ustar\0" && &header[263..265] == b"00")
        || (&header[257..263] == b"ustar " && &header[263..265] == b" \0");
    ensure!(
        supported_header,
        "PGDATA archive entry does not use a supported ustar header"
    );
    let path_bytes = entry.path_bytes();
    let path_text = std::str::from_utf8(path_bytes.as_ref())
        .context("PGDATA archive entry path is not UTF-8")?;
    ensure!(
        !path_text.contains('\\'),
        "PGDATA archive entry path contains a backslash"
    );
    let path = PathBuf::from(path_text);
    let archive_relative = normalize_archive_path(&path)?;
    if archive_relative.as_os_str().is_empty() {
        bail!("PGDATA archive entry {} is not relative", path.display());
    }
    let relative = if archive_relative == Path::new(PHYSICAL_ARCHIVE_MANIFEST_NAME) {
        archive_relative
    } else {
        archive_relative
            .strip_prefix("pgdata")
            .with_context(|| {
                format!(
                    "PGDATA archive contains unexpected top-level entry {}",
                    archive_relative.display()
                )
            })?
            .to_path_buf()
    };
    ensure!(
        relative != Path::new(".oliphaunt.json"),
        "PGDATA archive contains destination-owned database-root metadata"
    );

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
    Ok(ArchiveEntryPlan {
        relative,
        kind,
        size,
    })
}

#[cfg(unix)]
fn apply_private_permissions(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("set restored PGDATA permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn apply_private_permissions(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

fn create_private_directory_tree(root: &Path, directory: &Path) -> Result<()> {
    let relative = directory.strip_prefix(root).with_context(|| {
        format!(
            "PGDATA directory {} is outside its root",
            directory.display()
        )
    })?;
    let mut current = root.to_path_buf();
    create_private_directory(&current)?;
    for component in relative.components() {
        current.push(component);
        create_private_directory(&current)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error.into()),
    }
    apply_private_permissions(path, 0o700)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
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
        if relative.as_os_str().is_empty() || should_skip_bulk_backup_entry(&relative) {
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

fn copy_pgdata_tree(source_root: &Path, destination_root: &Path) -> Result<()> {
    copy_pgdata_tree_with_hook(source_root, destination_root, &mut |_| Ok(()))
}

fn copy_pgdata_tree_with_hook<F>(
    source_root: &Path,
    destination_root: &Path,
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
        &should_skip_bulk_backup_entry,
        before_open,
        &mut |relative, source| {
            match source {
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

fn walk_host_tree<F, V, S>(
    directory: &CapDir,
    relative_directory: &Path,
    display_root: &Path,
    should_skip: &S,
    before_open: &mut F,
    visit: &mut V,
) -> Result<()>
where
    F: FnMut(&Path) -> Result<()>,
    V: FnMut(&Path, HostTreeEntry) -> Result<()>,
    S: Fn(&Path) -> bool,
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
        if should_skip(&relative) {
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

        if metadata.is_dir() {
            visit(&relative, HostTreeEntry::Directory)?;
            let child = CapDir::from_std_file(opened.into_std());
            walk_host_tree(
                &child,
                &relative,
                display_root,
                should_skip,
                before_open,
                visit,
            )?;
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
            .with_context(|| format!("remove materialized PGDATA directory {}", path.display())),
        Ok(_) => fs::remove_file(path)
            .with_context(|| format!("remove materialized PGDATA file {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => {
            Err(err).with_context(|| format!("stat materialized PGDATA entry {}", path.display()))
        }
    }
}

fn should_skip_restore_entry(relative: &Path) -> bool {
    relative == Path::new(PHYSICAL_ARCHIVE_MANIFEST_NAME)
}

fn should_skip_backup_entry(relative: &Path) -> bool {
    if relative == Path::new(PHYSICAL_ARCHIVE_MANIFEST_NAME)
        || TRANSIENT_ROOT_FILES
            .iter()
            .any(|name| relative == Path::new(name))
    {
        return true;
    }
    let Some(name) = relative.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name == ".DS_Store" || name.starts_with("pg_internal.init") || name.starts_with("pgsql_tmp")
    {
        return true;
    }
    let mut components = relative.components();
    let first = components.next().and_then(|component| match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    });
    components.next().is_some()
        && first.is_some_and(|first| TRANSIENT_STATE_DIRECTORIES.contains(&first))
}

fn should_skip_bulk_backup_entry(relative: &Path) -> bool {
    if should_skip_backup_entry(relative) {
        return true;
    }
    let mut components = relative.components();
    let first = components.next().and_then(|component| match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    });
    first == Some("pg_wal") && components.next().is_some()
}

fn archive_path(relative: &Path) -> Result<String> {
    let relative = relative
        .to_str()
        .with_context(|| format!("PGDATA archive path is not UTF-8: {}", relative.display()))?;
    ensure!(
        !relative.contains('\\'),
        "PGDATA archive path contains a backslash: {relative:?}"
    );
    let path = format!("pgdata/{relative}");
    ensure_ustar_path(&path)?;
    Ok(path)
}

fn ensure_ustar_path(path: &str) -> Result<()> {
    if path.len() <= 100 {
        return Ok(());
    }
    let representable = path
        .rmatch_indices('/')
        .any(|(slash, _)| slash <= 155 && path.len().saturating_sub(slash + 1) <= 100);
    ensure!(
        representable,
        "physical archive path cannot be represented by ustar: {path}"
    );
    Ok(())
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
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

    #[test]
    fn wal_range_matches_shared_vectors() -> Result<()> {
        let fixture = crate::oliphaunt::test_fixtures::text(
            "storage/physical-backup-wal-range-v1.properties",
            "physical-backup-wal-range-v1.properties",
        );
        let values = fixture
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            values.get("schema").copied(),
            Some("oliphaunt-physical-backup-wal-range-v1")
        );
        let ids = values
            .keys()
            .filter_map(|key| {
                key.strip_prefix("case.")?
                    .split_once('.')
                    .map(|value| value.0)
            })
            .collect::<BTreeSet<_>>();
        for id in ids {
            let value = |field: &str| values[format!("case.{id}.{field}").as_str()];
            let segment_size = value("segmentSizeBytes").parse::<u64>()?;
            let result = required_backup_wal_names(value("start"), value("stop"), segment_size);
            if let Some(expected) = values.get(format!("case.{id}.expected").as_str()) {
                assert_eq!(
                    result?,
                    expected.split(',').collect::<Vec<_>>(),
                    "case {id}"
                );
            } else {
                let error_id = value("error");
                let message = match error_id {
                    "reversed-range" => "WAL range is reversed",
                    "timeline-change" => "WAL range crosses timelines",
                    "segment-index-out-of-range" | "malformed-wal-filename" => {
                        "invalid WAL filename"
                    }
                    _ => panic!("unknown shared WAL-range error {error_id:?}"),
                };
                let error = result.expect_err(&format!("case {id} must fail"));
                assert!(
                    error.to_string().contains(message),
                    "case {id} returned unexpected error: {error:#}"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn wal_range_requires_every_full_segment() -> Result<()> {
        let size = 1024 * 1024;
        let start = "00000001000000000000000A";
        let stop = "00000001000000000000000B";
        let pgdata = tempfile::tempdir()?;
        let wal = pgdata.path().join("pg_wal");
        fs::create_dir(&wal)?;
        fs::File::create(wal.join(start))?.set_len(size)?;
        let destination = tempfile::tempdir()?;
        let storage = PgDataStorage::HostDirectory(pgdata.path().to_path_buf());
        let names = required_backup_wal_names(start, stop, size)?;
        let error =
            copy_required_wal_segments(&storage, destination.path(), &names, size).unwrap_err();
        assert!(error.to_string().contains("missing WAL segment"));

        fs::File::create(wal.join(stop))?.set_len(size - 1)?;
        let error =
            copy_required_wal_segments(&storage, destination.path(), &names, size).unwrap_err();
        assert!(error.to_string().contains("wrong size"));

        fs::File::create(wal.join(stop))?.set_len(size)?;
        copy_required_wal_segments(&storage, destination.path(), &names, size)
    }

    #[test]
    fn online_backup_copies_only_required_wal_segments() -> Result<()> {
        let size = 1024 * 1024;
        let required = "00000001000000000000000A";
        let unrelated = "00000001000000000000000B";
        let pgdata = tempfile::tempdir()?;
        fs::create_dir(pgdata.path().join("pg_wal"))?;
        fs::File::create(pgdata.path().join("pg_wal").join(required))?.set_len(size)?;
        fs::File::create(pgdata.path().join("pg_wal").join(unrelated))?.set_len(size)?;
        let before_stop = tempfile::tempdir()?;
        let storage = PgDataStorage::HostDirectory(pgdata.path().to_path_buf());

        let bytes = finish_online_physical_archive(
            before_stop,
            &storage,
            required,
            required,
            size,
            "label",
            None,
        )?;
        let mut archive = Archive::new(Cursor::new(bytes));
        let paths = archive
            .entries()?
            .map(|entry| Ok(entry?.path()?.into_owned()))
            .collect::<Result<Vec<_>>>()?;
        assert!(paths.contains(&PathBuf::from(format!("pgdata/pg_wal/{required}"))));
        assert!(!paths.contains(&PathBuf::from(format!("pgdata/pg_wal/{unrelated}"))));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn pgdata_archive_rejects_symbolic_links() -> Result<()> {
        let temp = tempfile::TempDir::new()?;
        let pgdata = temp.path().join("pgdata");
        fs::create_dir_all(pgdata.join("pg_tblspc"))?;
        symlink("/external/tablespace", pgdata.join("pg_tblspc/16384"))?;

        let error = dump_materialized_pgdata_archive(&pgdata).unwrap_err();

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

        let error = dump_materialized_pgdata_archive(&pgdata).unwrap_err();

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

        let error = dump_materialized_pgdata_archive(&pgdata).unwrap_err();

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

        let error = copy_pgdata_tree(&pgdata, &clone).unwrap_err();

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
        let error = dump_materialized_pgdata_archive_with_hook(&pgdata, &mut |relative| {
            if relative == Path::new("value") {
                fs::remove_file(pgdata.join(relative))?;
                symlink(&outside, pgdata.join(relative))?;
                swapped = true;
            }
            Ok(())
        })
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

        let error = copy_pgdata_tree_with_hook(&pgdata, &destination, &mut |relative| {
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
            &should_skip_backup_entry,
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
    fn archive_rejects_incompatible_physical_metadata() -> Result<()> {
        let archive = test_archive(&[(
            PHYSICAL_ARCHIVE_MANIFEST_NAME,
            ArchiveEntryKind::File,
            b"archiveLayout=oliphaunt-physical-archive-v1\nproduct=oliphaunt\nengineFamily=wasix\nphysicalFormat=wasix-pg18-v2\npostgresMajor=18\n",
        )])?;

        let error = validate_pgdata_archive(&archive).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("incompatible compatibility metadata"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[test]
    fn physical_archive_writer_rejects_paths_outside_ustar() -> Result<()> {
        let source = tempfile::tempdir()?;
        let long_name = "x".repeat(101);
        fs::create_dir(source.path().join("base"))?;
        fs::write(source.path().join("base").join(long_name), b"value")?;

        let error = dump_materialized_pgdata_archive(source.path())
            .expect_err("writer must not emit GNU long-name records");

        assert!(
            format!("{error:#}").contains("cannot be represented by ustar"),
            "unexpected error: {error:#}"
        );
        Ok(())
    }

    #[test]
    fn extended_tar_metadata_does_not_publish_a_restore() -> Result<()> {
        for (entry_type, contents) in [
            (EntryType::XHeader, b"20 comment=accepted\n".as_slice()),
            (EntryType::GNULongName, b"pgdata/PG_VERSION\0".as_slice()),
        ] {
            let archive = test_archive_with_leading_metadata(entry_type, contents)?;
            assert_invalid_restore_preserves_destinations(&archive, "unsupported type")?;
        }
        Ok(())
    }

    #[test]
    fn physical_archive_writer_uses_private_portable_modes() -> Result<()> {
        let source = tempfile::tempdir()?;
        fs::create_dir(source.path().join("base"))?;
        fs::write(source.path().join("base/value"), b"value")?;

        let bytes = dump_materialized_pgdata_archive(source.path())?;
        let mut archive = Archive::new(Cursor::new(bytes));
        for entry in archive.entries()? {
            let entry = entry?;
            let path = entry.path()?.into_owned();
            let expected = if entry.header().entry_type().is_dir() {
                0o700
            } else {
                0o600
            };
            assert_eq!(
                entry.header().mode()?,
                expected,
                "archive entry {} must use a private mode",
                path.display()
            );
        }
        Ok(())
    }

    #[test]
    fn physical_archive_writer_excludes_only_standard_transient_contents() -> Result<()> {
        let source = tempfile::tempdir()?;
        for file in TRANSIENT_ROOT_FILES {
            fs::write(source.path().join(file), b"transient")?;
        }
        fs::write(source.path().join("backup_label"), b"label")?;
        fs::write(source.path().join("tablespace_map"), b"map")?;
        fs::create_dir(source.path().join("base"))?;
        fs::write(source.path().join("base/pg_internal.init.1"), b"transient")?;
        fs::write(source.path().join("base/pgsql_tmp123"), b"transient")?;
        fs::write(source.path().join("base/.DS_Store"), b"transient")?;
        fs::write(source.path().join("base/kept"), b"kept")?;
        for directory in TRANSIENT_STATE_DIRECTORIES {
            fs::create_dir(source.path().join(directory))?;
            fs::write(source.path().join(directory).join("state"), b"transient")?;
        }
        fs::create_dir(source.path().join("pg_wal"))?;
        fs::write(source.path().join("pg_wal/segment"), b"wal")?;

        let bytes = dump_materialized_pgdata_archive(source.path())?;
        let mut archive = Archive::new(Cursor::new(bytes));
        let paths = archive
            .entries()?
            .map(|entry| Ok(entry?.path()?.into_owned()))
            .collect::<Result<Vec<_>>>()?;

        assert!(paths.contains(&PathBuf::from("pgdata/base/kept")));
        assert!(paths.contains(&PathBuf::from("pgdata/pg_wal/segment")));
        assert!(paths.contains(&PathBuf::from("pgdata/backup_label")));
        assert!(paths.contains(&PathBuf::from("pgdata/tablespace_map")));
        for directory in TRANSIENT_STATE_DIRECTORIES {
            assert!(paths.contains(&PathBuf::from(format!("pgdata/{directory}"))));
            assert!(!paths.contains(&PathBuf::from(format!("pgdata/{directory}/state"))));
        }
        assert!(!paths.contains(&PathBuf::from("pgdata/base/pg_internal.init.1")));
        assert!(!paths.contains(&PathBuf::from("pgdata/base/pgsql_tmp123")));
        assert!(!paths.contains(&PathBuf::from("pgdata/base/.DS_Store")));
        for file in TRANSIENT_ROOT_FILES {
            assert!(!paths.contains(&PathBuf::from(format!("pgdata/{file}"))));
        }
        Ok(())
    }

    #[test]
    fn bulk_backup_does_not_open_pre_stop_wal_or_transient_files() -> Result<()> {
        let source = tempfile::tempdir()?;
        fs::create_dir(source.path().join("pg_wal"))?;
        fs::write(source.path().join("pg_wal/segment"), b"transient")?;
        fs::create_dir(source.path().join("pg_stat_tmp"))?;
        fs::write(source.path().join("pg_stat_tmp/state"), b"transient")?;
        fs::create_dir(source.path().join("base"))?;
        fs::write(source.path().join("base/.DS_Store"), b"transient")?;
        fs::write(source.path().join("base/kept"), b"kept")?;
        fs::write(source.path().join("postmaster.pid"), b"transient")?;
        let destination = tempfile::tempdir()?;

        copy_pgdata_tree_with_hook(source.path(), destination.path(), &mut |path| {
            ensure!(
                !should_skip_bulk_backup_entry(path),
                "bulk backup attempted to open excluded path {}",
                path.display()
            );
            Ok(())
        })?;

        assert_eq!(fs::read(destination.path().join("base/kept"))?, b"kept");
        assert!(destination.path().join("pg_wal").is_dir());
        assert!(destination.path().join("pg_stat_tmp").is_dir());
        assert!(!destination.path().join("pg_wal/segment").exists());
        assert!(!destination.path().join("pg_stat_tmp/state").exists());
        assert!(!destination.path().join("base/.DS_Store").exists());
        assert!(!destination.path().join("postmaster.pid").exists());
        Ok(())
    }

    #[test]
    fn final_pg_control_refresh_replaces_the_bulk_snapshot() -> Result<()> {
        let source = tempfile::tempdir()?;
        fs::create_dir(source.path().join("global"))?;
        fs::write(source.path().join("global/pg_control"), b"final")?;
        let materialized = tempfile::tempdir()?;
        fs::create_dir(materialized.path().join("global"))?;
        fs::write(materialized.path().join("global/pg_control"), b"bulk")?;

        refresh_materialized_pg_control(
            &PgDataStorage::HostDirectory(source.path().to_path_buf()),
            materialized.path(),
        )?;

        assert_eq!(
            fs::read(materialized.path().join("global/pg_control"))?,
            b"final"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn restore_ignores_accepted_archive_modes_and_keeps_manifest_private() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let mut archive = test_archive(&[])?;
        rewrite_test_tar_field(&mut archive, 100, 8, b"0000777\0");
        let parent = tempfile::tempdir()?;
        let destination = parent.path().join("database");

        restore_physical_archive(&destination, &archive)?;

        let pgdata = destination.join(PGDATA_DIRECTORY);
        assert_eq!(fs::metadata(&pgdata)?.permissions().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(pgdata.join("PG_VERSION"))?
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(!pgdata.join(".oliphaunt").exists());
        assert_eq!(
            fs::metadata(
                destination.join(crate::oliphaunt::database_root_descriptor::DESCRIPTOR_FILE)
            )?
            .permissions()
            .mode()
                & 0o777,
            0o600
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
            error
                .to_string()
                .contains("trailing data after its tar terminator"),
            "unexpected error: {error:#}"
        );
        assert_eq!(fs::read(destination.join("sentinel"))?, b"unchanged");
        assert!(!destination.join("base").exists());
        Ok(())
    }

    #[test]
    fn invalid_restore_preserves_an_absent_destination() -> Result<()> {
        let parent = tempfile::TempDir::new()?;
        let destination = parent.path().join("database");

        let error = restore_physical_archive(&destination, b"not a tar")
            .expect_err("invalid restore input must fail");
        let error = crate::Error::from_anyhow(error);
        let details = error
            .storage_error()
            .expect("invalid restore input must remain structurally tagged");
        assert_eq!(details.code(), StorageErrorCode::Corrupt);
        assert_eq!(details.commit_state(), StorageCommitState::Unchanged);
        assert_eq!(details.phase(), StorageErrorPhase::RestoreValidation);

        assert!(!destination.exists());
        Ok(())
    }

    #[test]
    fn invalid_required_pgdata_files_do_not_publish_a_restore() -> Result<()> {
        for (entries, expected) in [
            (
                vec![("PG_VERSION", ArchiveEntryKind::File, b"17\n".as_slice())],
                "PG_VERSION must contain PostgreSQL 18",
            ),
            (
                vec![("PG_VERSION", ArchiveEntryKind::File, b"\xff".as_slice())],
                "PG_VERSION is not UTF-8",
            ),
            (
                vec![("global/pg_control", ArchiveEntryKind::File, b"".as_slice())],
                "pg_control must be a non-empty regular file",
            ),
            (
                vec![("backup_label", ArchiveEntryKind::File, b"".as_slice())],
                "backup_label must be a non-empty regular file",
            ),
            (
                vec![(
                    "base",
                    ArchiveEntryKind::File,
                    b"not-a-directory".as_slice(),
                )],
                "missing pgdata/base",
            ),
        ] {
            let archive = test_archive(&entries)?;
            assert_invalid_restore_preserves_destinations(&archive, expected)?;
        }
        Ok(())
    }

    #[test]
    fn process_state_entries_do_not_publish_a_restore() -> Result<()> {
        for path in ["postmaster.pid", "postmaster.opts"] {
            let archive = test_archive(&[(path, ArchiveEntryKind::File, b"stale")])?;
            assert_invalid_restore_preserves_destinations(
                &archive,
                "must not contain PostgreSQL process state",
            )?;
        }
        Ok(())
    }

    #[test]
    fn invalid_ustar_numeric_metadata_does_not_publish_a_restore() -> Result<()> {
        for (offset, width, value, expected) in [
            (
                100,
                8,
                b"0004755\0".as_slice(),
                "unsupported permission bits",
            ),
            (100, 8, b"00008\0".as_slice(), "invalid tar mode field"),
            (108, 8, b"8".as_slice(), "invalid tar uid field"),
            (116, 8, b"8".as_slice(), "invalid tar gid field"),
            (136, 12, b"8".as_slice(), "invalid tar mtime field"),
        ] {
            let mut archive = test_archive(&[])?;
            rewrite_test_tar_field(&mut archive, offset, width, value);
            assert_invalid_restore_preserves_destinations(&archive, expected)?;
        }
        Ok(())
    }

    #[test]
    fn empty_ustar_identity_and_time_fields_are_zero() -> Result<()> {
        let mut archive = test_archive(&[])?;
        for (offset, width) in [(108, 8), (116, 8), (136, 12)] {
            rewrite_test_tar_field(&mut archive, offset, width, b"");
        }
        validate_pgdata_archive(&archive)?;
        Ok(())
    }

    #[test]
    fn restore_uses_the_same_stable_binding_local_lock_as_open() -> Result<()> {
        let parent = tempfile::TempDir::new()?;
        let destination = parent.path().join("database");
        let _owner = DirectoryLock::acquire(&destination)?;

        let error = restore_physical_archive(&destination, b"not a tar")
            .expect_err("a concurrent owner must exclude restore");

        assert!(
            format!("{error:#}").contains("already in use"),
            "unexpected error: {error:#}"
        );
        let error = crate::Error::from_anyhow(error);
        let details = error
            .storage_error()
            .expect("restore ownership must remain structurally tagged");
        assert_eq!(details.code(), StorageErrorCode::Busy);
        assert_eq!(details.commit_state(), StorageCommitState::Unchanged);
        assert_eq!(details.phase(), StorageErrorPhase::RestoreValidation);
        assert!(!destination.exists());
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

    #[test]
    fn archive_rejects_non_utf8_and_backslash_paths() -> Result<()> {
        let non_utf8 = test_archive_with_raw_path(b"pgdata/base/\xff", b"value")?;
        assert!(
            validate_pgdata_archive(&non_utf8)
                .unwrap_err()
                .to_string()
                .contains("not UTF-8")
        );

        let backslash = test_archive_with_raw_path(b"pgdata\\base\\value", b"value")?;
        assert!(
            validate_pgdata_archive(&backslash)
                .unwrap_err()
                .to_string()
                .contains("backslash")
        );
        Ok(())
    }

    #[test]
    fn physical_archive_manifest_matches_shared_fixture_exactly() {
        let fixture = crate::oliphaunt::test_fixtures::text(
            "storage/physical-archive-wasix-v1.properties",
            "physical-archive-wasix-v1.properties",
        );
        assert_eq!(physical_archive_manifest_text(), fixture);
    }

    fn test_archive(entries: &[(&str, ArchiveEntryKind, &[u8])]) -> Result<Vec<u8>> {
        let has_manifest = entries
            .iter()
            .any(|(path, _, _)| *path == PHYSICAL_ARCHIVE_MANIFEST_NAME);
        let mut bytes = Vec::new();
        {
            let mut builder = Builder::new(&mut bytes);
            for (path, kind, contents) in [
                ("PG_VERSION", ArchiveEntryKind::File, b"18\n".as_slice()),
                ("base", ArchiveEntryKind::Directory, b"".as_slice()),
                (
                    "global/pg_control",
                    ArchiveEntryKind::File,
                    b"control".as_slice(),
                ),
                ("pg_wal", ArchiveEntryKind::Directory, b"".as_slice()),
                ("backup_label", ArchiveEntryKind::File, b"label".as_slice()),
            ] {
                if entries.iter().any(|(candidate, _, _)| *candidate == path) {
                    continue;
                }
                append_test_entry(&mut builder, &format!("pgdata/{path}"), kind, contents)?;
            }
            for (path, kind, contents) in entries {
                let archive_path = if *path == PHYSICAL_ARCHIVE_MANIFEST_NAME {
                    (*path).to_owned()
                } else {
                    format!("pgdata/{path}")
                };
                append_test_entry(&mut builder, &archive_path, *kind, contents)?;
            }
            if !has_manifest {
                append_test_entry(
                    &mut builder,
                    PHYSICAL_ARCHIVE_MANIFEST_NAME,
                    ArchiveEntryKind::File,
                    physical_archive_manifest_text().as_bytes(),
                )?;
            }
            builder.finish()?;
        }
        Ok(bytes)
    }

    fn append_test_entry<W: Write>(
        builder: &mut Builder<W>,
        path: &str,
        kind: ArchiveEntryKind,
        contents: &[u8],
    ) -> Result<()> {
        let mut header = Header::new_gnu();
        header.set_entry_type(match kind {
            ArchiveEntryKind::Directory => EntryType::Directory,
            ArchiveEntryKind::File => EntryType::Regular,
        });
        header.set_mode(0o700);
        header.set_mtime(0);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, path, Cursor::new(contents))?;
        Ok(())
    }

    fn assert_invalid_restore_preserves_destinations(archive: &[u8], expected: &str) -> Result<()> {
        let parent = tempfile::tempdir()?;
        let absent = parent.path().join("absent");
        let error = restore_physical_archive(&absent, archive)
            .expect_err("invalid archive must not publish an absent destination");
        assert!(
            format!("{error:#}").contains(expected),
            "unexpected error: {error:#}"
        );
        assert!(!absent.exists());

        let empty = parent.path().join("empty");
        fs::create_dir(&empty)?;
        let error = restore_physical_archive(&empty, archive)
            .expect_err("invalid archive must not replace an existing empty destination");
        assert!(
            format!("{error:#}").contains(expected),
            "unexpected error: {error:#}"
        );
        assert!(empty.is_dir());
        assert!(fs::read_dir(&empty)?.next().is_none());
        Ok(())
    }

    fn rewrite_test_tar_field(archive: &mut [u8], offset: usize, width: usize, value: &[u8]) {
        assert!(offset + width <= TAR_BLOCK_BYTES);
        assert!(value.len() <= width);
        archive[offset..offset + width].fill(0);
        archive[offset..offset + value.len()].copy_from_slice(value);
        archive[148..156].fill(b' ');
        let checksum: u32 = archive[..TAR_BLOCK_BYTES]
            .iter()
            .map(|byte| u32::from(*byte))
            .sum();
        let checksum = format!("{checksum:06o}\0 ");
        archive[148..156].copy_from_slice(checksum.as_bytes());
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

    fn test_archive_with_leading_metadata(
        entry_type: EntryType,
        contents: &[u8],
    ) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut builder = Builder::new(&mut bytes);
            let mut header = Header::new_gnu();
            header.set_entry_type(entry_type);
            header.set_mode(0o600);
            header.set_mtime(0);
            header.set_size(contents.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, "././@LongLink", Cursor::new(contents))?;
            builder.finish()?;
        }
        ensure!(
            bytes.len() >= TAR_END_BYTES
                && bytes[bytes.len() - TAR_END_BYTES..]
                    .iter()
                    .all(|byte| *byte == 0),
            "test metadata archive is missing its tar terminator"
        );
        bytes.truncate(bytes.len() - TAR_END_BYTES);
        bytes.extend_from_slice(&test_archive(&[])?);
        Ok(bytes)
    }
}
