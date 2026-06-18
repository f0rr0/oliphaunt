use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tar::{Builder, EntryType, Header};

use crate::error::{Error, Result};
use crate::extension::Extension;
use crate::liboliphaunt::{
    NATIVE_ROOT_MANIFEST_FILE, NativeRootLock, ensure_native_root_manifest,
    native_root_manifest_text, validate_native_root_manifest_text,
};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::storage::{
    BackupArtifact, BackupFormat, DatabaseRoot, RestoreRequest, RestoreTargetPolicy,
    path_contains_nul,
};

const BACKUP_LABEL: &str = "oliphaunt physical archive";
pub(crate) const PHYSICAL_ARCHIVE_MANIFEST_PATH: &str = ".oliphaunt/backup-manifest.properties";
const PHYSICAL_ARCHIVE_MANIFEST_LAYOUT: &str = "oliphaunt-physical-archive-v1";
const PHYSICAL_ARCHIVE_POSTGRES_MAJOR: &str = "18";
const PHYSICAL_ARCHIVE_METADATA_MAX_BYTES: usize = 64 * 1024;
const TRANSIENT_CONTENT_DIRS: &[&str] = &[
    "pg_dynshmem",
    "pg_notify",
    "pg_serial",
    "pg_snapshots",
    "pg_stat_tmp",
    "pg_subtrans",
];

pub(crate) fn annotate_physical_archive_backup(
    artifact: BackupArtifact,
    pgdata: &Path,
    selected_extensions: &[Extension],
    mut exec_sql: impl FnMut(ProtocolRequest) -> Result<ProtocolResponse>,
) -> Result<BackupArtifact> {
    if artifact.format != BackupFormat::PhysicalArchive {
        return Err(Error::Engine(format!(
            "physical archive annotation requires a PhysicalArchive artifact, got {:?}",
            artifact.format
        )));
    }

    let metadata_files =
        physical_archive_metadata_files(pgdata, selected_extensions, &mut exec_sql)?;
    let bytes = append_physical_archive_metadata(
        artifact.bytes.as_slice(),
        metadata_files.root_manifest,
        metadata_files.backup_manifest,
    )?;
    Ok(BackupArtifact {
        format: BackupFormat::PhysicalArchive,
        bytes,
    })
}

pub(crate) struct PhysicalArchiveMetadataFiles {
    pub(crate) root_manifest: String,
    pub(crate) backup_manifest: String,
}

pub(crate) fn physical_archive_metadata_files(
    pgdata: &Path,
    selected_extensions: &[Extension],
    mut exec_sql: impl FnMut(ProtocolRequest) -> Result<ProtocolResponse>,
) -> Result<PhysicalArchiveMetadataFiles> {
    let metadata = collect_physical_archive_metadata(pgdata, selected_extensions, &mut exec_sql)?;
    Ok(PhysicalArchiveMetadataFiles {
        root_manifest: native_root_manifest_text(Some(&metadata.pgdata_version)),
        backup_manifest: physical_archive_manifest_text(&metadata),
    })
}

pub(crate) fn physical_archive_backup(
    pgdata: &Path,
    mut exec_sql: impl FnMut(ProtocolRequest) -> Result<ProtocolResponse>,
) -> Result<BackupArtifact> {
    let start_backup = ProtocolRequest::simple_query(&format!(
        "SELECT pg_backup_start(label => '{}', fast => true)",
        BACKUP_LABEL
    ))?;
    ensure_simple_query_ok(exec_sql(start_backup)?, "start physical backup")?;

    let mut bytes = Vec::new();
    let mut backup_stopped = false;
    let archive_result = {
        let mut archive = Builder::new(&mut bytes);
        append_pgdata_tree(&mut archive, pgdata).and_then(|()| {
            let stop_files = stop_physical_backup(&mut exec_sql)?;
            backup_stopped = true;
            append_pg_wal_tree(&mut archive, pgdata)?;
            append_generated_file(&mut archive, "pgdata/backup_label", stop_files.backup_label)?;
            if let Some(tablespace_map) = stop_files.tablespace_map
                && !tablespace_map.is_empty()
            {
                append_generated_file(&mut archive, "pgdata/tablespace_map", tablespace_map)?;
            }
            archive
                .finish()
                .map_err(|err| Error::Engine(format!("finish physical backup archive: {err}")))
        })
    };

    match archive_result {
        Ok(()) => Ok(BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }),
        Err(error) => {
            if backup_stopped {
                Err(error)
            } else {
                let stop_error = stop_physical_backup(&mut exec_sql).err();
                match stop_error {
                    Some(stop_error) => Err(Error::Engine(format!(
                        "{error}; also failed to leave PostgreSQL backup mode cleanly: {stop_error}"
                    ))),
                    None => Err(error),
                }
            }
        }
    }
}

struct PhysicalArchiveMetadata {
    pgdata_version: String,
    postgres_version_num: String,
    server_encoding: String,
    lc_collate: String,
    lc_ctype: String,
    data_checksums: String,
    shared_preload_libraries: String,
    required_preload_libraries: Vec<String>,
    selected_extensions: Vec<String>,
    installed_extensions: String,
}

fn collect_physical_archive_metadata(
    pgdata: &Path,
    selected_extensions: &[Extension],
    exec_sql: &mut impl FnMut(ProtocolRequest) -> Result<ProtocolResponse>,
) -> Result<PhysicalArchiveMetadata> {
    let pgdata_version = read_pgdata_version(pgdata)?;
    if pgdata_version != PHYSICAL_ARCHIVE_POSTGRES_MAJOR {
        return Err(Error::Engine(format!(
            "physical archive metadata requires PostgreSQL {PHYSICAL_ARCHIVE_POSTGRES_MAJOR} PGDATA, got {pgdata_version}"
        )));
    }

    let metadata_query = ProtocolRequest::simple_query(
        "SELECT \
         current_setting('server_version_num'), \
         current_setting('server_encoding'), \
         datcollate, \
         datctype, \
         current_setting('data_checksums'), \
         current_setting('shared_preload_libraries'), \
         COALESCE((SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension), '') \
         FROM pg_database WHERE datname = current_database()",
    )?;
    let row = first_data_row(
        exec_sql(metadata_query)?,
        "collect physical archive metadata",
    )?;
    if row.len() != 7 {
        return Err(Error::Engine(format!(
            "physical archive metadata query returned {} columns, expected 7",
            row.len()
        )));
    }

    let mut selected_extension_names = selected_extensions
        .iter()
        .map(|extension| extension.sql_name().to_owned())
        .collect::<Vec<_>>();
    selected_extension_names.sort();
    selected_extension_names.dedup();
    let mut required_preload_libraries = selected_extensions
        .iter()
        .filter_map(|extension| extension.required_shared_preload_library())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    required_preload_libraries.sort();
    required_preload_libraries.dedup();
    Ok(PhysicalArchiveMetadata {
        pgdata_version,
        postgres_version_num: required_utf8_column(&row, 0, "server_version_num")?,
        server_encoding: required_utf8_column(&row, 1, "server_encoding")?,
        lc_collate: required_utf8_column(&row, 2, "lc_collate")?,
        lc_ctype: required_utf8_column(&row, 3, "lc_ctype")?,
        data_checksums: required_utf8_column(&row, 4, "data_checksums")?,
        shared_preload_libraries: required_utf8_column(&row, 5, "shared_preload_libraries")?,
        installed_extensions: required_utf8_column(&row, 6, "installed_extensions")?,
        required_preload_libraries,
        selected_extensions: selected_extension_names,
    })
}

fn physical_archive_manifest_text(metadata: &PhysicalArchiveMetadata) -> String {
    format!(
        "archiveLayout={PHYSICAL_ARCHIVE_MANIFEST_LAYOUT}\n\
         product=oliphaunt\n\
         postgresMajor={PHYSICAL_ARCHIVE_POSTGRES_MAJOR}\n\
         pgdataVersion={}\n\
         postgresVersionNum={}\n\
         serverEncoding={}\n\
         lcCollate={}\n\
         lcCtype={}\n\
         dataChecksums={}\n\
         sharedPreloadLibraries={}\n\
         requiredPreloadLibraries={}\n\
         selectedExtensions={}\n\
         installedExtensions={}\n",
        manifest_value(&metadata.pgdata_version),
        manifest_value(&metadata.postgres_version_num),
        manifest_value(&metadata.server_encoding),
        manifest_value(&metadata.lc_collate),
        manifest_value(&metadata.lc_ctype),
        manifest_value(&metadata.data_checksums),
        manifest_value(&metadata.shared_preload_libraries),
        manifest_value(&metadata.required_preload_libraries.join(",")),
        manifest_value(&metadata.selected_extensions.join(",")),
        manifest_value(&metadata.installed_extensions)
    )
}

fn manifest_value(value: &str) -> String {
    value.replace(['\n', '\r'], " ").trim().to_owned()
}

fn required_utf8_column(row: &[Option<Vec<u8>>], index: usize, label: &str) -> Result<String> {
    let bytes = row
        .get(index)
        .ok_or_else(|| Error::Engine(format!("metadata row is missing column {label}")))?
        .as_ref()
        .ok_or_else(|| Error::Engine(format!("metadata column {label} was null")))?;
    String::from_utf8(bytes.clone())
        .map_err(|err| Error::Engine(format!("metadata column {label} is not UTF-8: {err}")))
}

fn read_pgdata_version(pgdata: &Path) -> Result<String> {
    let version_path = pgdata.join("PG_VERSION");
    let version = fs::read_to_string(&version_path).map_err(|err| {
        Error::Engine(format!(
            "read native PGDATA version file {}: {err}",
            version_path.display()
        ))
    })?;
    let version = version.trim();
    if version.is_empty() {
        return Err(Error::Engine(format!(
            "native PGDATA version file {} is empty",
            version_path.display()
        )));
    }
    Ok(version.to_owned())
}

fn stop_physical_backup(
    exec_sql: &mut impl FnMut(ProtocolRequest) -> Result<ProtocolResponse>,
) -> Result<BackupStopFiles> {
    let stop_backup = ProtocolRequest::simple_query(
        "SELECT labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)",
    )?;
    let response = exec_sql(stop_backup)?;
    let row = first_data_row(response, "stop physical backup")?;
    if row.len() != 2 {
        return Err(Error::Engine(format!(
            "stop physical backup returned {} columns, expected 2",
            row.len()
        )));
    }
    let backup_label = row[0]
        .clone()
        .ok_or_else(|| Error::Engine("pg_backup_stop returned a null backup label".to_owned()))?;
    let tablespace_map = row[1].clone();
    Ok(BackupStopFiles {
        backup_label: String::from_utf8(backup_label)
            .map_err(|err| Error::Engine(format!("backup label is not UTF-8: {err}")))?,
        tablespace_map: tablespace_map
            .map(String::from_utf8)
            .transpose()
            .map_err(|err| Error::Engine(format!("tablespace map is not UTF-8: {err}")))?,
    })
}

pub(crate) fn sql_backup_with_pg_dump(
    pg_dump: &Path,
    connection_string: &str,
) -> Result<BackupArtifact> {
    if !pg_dump.is_file() {
        return Err(Error::Engine(format!(
            "logical SQL backup requires pg_dump at {}",
            pg_dump.display()
        )));
    }
    let output = std::process::Command::new(pg_dump)
        .arg("--dbname")
        .arg(connection_string)
        .arg("--format=plain")
        .arg("--no-password")
        .output()
        .map_err(|err| Error::Engine(format!("run pg_dump for logical SQL backup: {err}")))?;
    if output.status.success() {
        Ok(BackupArtifact {
            format: BackupFormat::Sql,
            bytes: output.stdout,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(Error::Engine(format!(
            "pg_dump failed with status {}: {}",
            output.status,
            stderr.trim()
        )))
    }
}

pub(crate) fn restore_backup(request: RestoreRequest) -> Result<PathBuf> {
    if request.artifact.format != BackupFormat::PhysicalArchive {
        return Err(Error::Engine(format!(
            "restore currently requires a physical archive artifact, got {:?}",
            request.artifact.format
        )));
    }

    let DatabaseRoot::Path(target_root) = request.target else {
        return Err(Error::Engine(
            "restore requires an explicit persistent target root".to_owned(),
        ));
    };

    restore_physical_archive(&target_root, &request.artifact, request.target_policy)
}

fn restore_physical_archive(
    target_root: &Path,
    artifact: &BackupArtifact,
    target_policy: RestoreTargetPolicy,
) -> Result<PathBuf> {
    let target_root = normalize_restore_target(target_root)?;
    let parent = target_root.parent().ok_or_else(|| {
        Error::Engine(format!(
            "restore target {} has no parent directory",
            target_root.display()
        ))
    })?;
    fs::create_dir_all(parent).map_err(|err| {
        Error::Engine(format!(
            "create restore parent directory {}: {err}",
            parent.display()
        ))
    })?;
    let _target_lock = acquire_restore_target_lock(&target_root)?;

    let staging_root = unique_sibling_path(&target_root, "restore-staging");
    let cleanup_staging = CleanupDir::new(staging_root.clone());
    fs::create_dir(&staging_root).map_err(|err| {
        Error::Engine(format!(
            "create restore staging directory {}: {err}",
            staging_root.display()
        ))
    })?;

    unpack_physical_archive(artifact, &staging_root)?;
    validate_restored_pgdata(&staging_root)?;
    publish_restored_root(&staging_root, &target_root, target_policy)?;
    cleanup_staging.disarm();
    Ok(target_root)
}

fn normalize_restore_target(target_root: &Path) -> Result<PathBuf> {
    if target_root.as_os_str().is_empty() {
        return Err(Error::Engine("restore target root is empty".to_owned()));
    }
    if path_contains_nul(target_root) {
        return Err(Error::Engine(
            "restore target root must not contain NUL bytes".to_owned(),
        ));
    }
    if target_root == Path::new("/") {
        return Err(Error::Engine(
            "refusing to restore over filesystem root".to_owned(),
        ));
    }
    if fs::symlink_metadata(target_root)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(Error::Engine(format!(
            "refusing to restore over symlink target {}; choose the real database root path",
            target_root.display()
        )));
    }
    Ok(target_root.to_path_buf())
}

fn unpack_physical_archive(artifact: &BackupArtifact, staging_root: &Path) -> Result<()> {
    validate_physical_archive_framing(artifact.bytes.as_slice())?;
    let entries = validate_physical_archive_entries(artifact.bytes.as_slice())?;
    validate_physical_archive_compatibility_metadata(artifact.bytes.as_slice(), &entries)?;
    restore_physical_archive_entries(artifact.bytes.as_slice(), staging_root, &entries)
}

fn append_physical_archive_metadata(
    bytes: &[u8],
    root_manifest: String,
    backup_manifest: String,
) -> Result<Vec<u8>> {
    validate_physical_archive_framing(bytes)?;
    let entries = validate_physical_archive_entries(bytes)?;
    let mut output = if entries
        .iter()
        .any(|entry| archive_path_is_metadata(&entry.canonical_path))
    {
        physical_archive_without_metadata(bytes, &entries)?
    } else {
        let end = physical_archive_data_end_offset(bytes)?;
        bytes[..end].to_vec()
    };
    {
        let mut archive = Builder::new(&mut output);
        append_generated_file(&mut archive, NATIVE_ROOT_MANIFEST_FILE, root_manifest)?;
        append_generated_file(
            &mut archive,
            PHYSICAL_ARCHIVE_MANIFEST_PATH,
            backup_manifest,
        )?;
        archive
            .finish()
            .map_err(|err| Error::Engine(format!("finish annotated physical archive: {err}")))?;
    }
    Ok(output)
}

#[cfg(test)]
fn archive_contains_path(entries: &[ArchiveEntryPlan], path: &Path) -> bool {
    entries.iter().any(|entry| entry.canonical_path == path)
}

fn archive_path_is_metadata(path: &Path) -> bool {
    path == Path::new(NATIVE_ROOT_MANIFEST_FILE)
        || path == Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH)
}

fn physical_archive_without_metadata(
    bytes: &[u8],
    entry_plans: &[ArchiveEntryPlan],
) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(bytes.len());
    {
        let mut output_archive = Builder::new(&mut output);
        let mut input_archive = tar::Archive::new(Cursor::new(bytes));
        let entries = input_archive
            .entries()
            .map_err(|err| Error::Engine(format!("read physical archive entries: {err}")))?;
        let mut plans = entry_plans.iter();
        for entry in entries {
            let mut entry = entry
                .map_err(|err| Error::Engine(format!("read physical archive entry: {err}")))?;
            let plan = plans.next().ok_or_else(|| {
                Error::Engine("physical archive entry plan ended before archive entries".to_owned())
            })?;
            if archive_path_is_metadata(&plan.canonical_path) {
                continue;
            }
            let header = entry.header().clone();
            output_archive.append(&header, &mut entry).map_err(|err| {
                Error::Engine(format!(
                    "copy physical archive entry {} while refreshing metadata: {err}",
                    plan.canonical_path.display()
                ))
            })?;
        }
        if plans.next().is_some() {
            return Err(Error::Engine(
                "physical archive ended before validated entry plan".to_owned(),
            ));
        }
        output_archive.finish().map_err(|err| {
            Error::Engine(format!(
                "finish physical archive while refreshing metadata: {err}"
            ))
        })?;
    }
    if output.len() >= 1024 {
        output.truncate(output.len() - 1024);
    }
    Ok(output)
}

fn validate_physical_archive_compatibility_metadata(
    bytes: &[u8],
    entries: &[ArchiveEntryPlan],
) -> Result<()> {
    let pgdata_version = archive_text_file(bytes, entries, Path::new("pgdata/PG_VERSION"))?
        .map(|version| version.trim().to_owned());
    if let Some(version) = pgdata_version.as_deref()
        && version != PHYSICAL_ARCHIVE_POSTGRES_MAJOR
    {
        return Err(Error::Engine(format!(
            "physical archive contains PostgreSQL {version} PGDATA; oliphaunt currently supports PostgreSQL {PHYSICAL_ARCHIVE_POSTGRES_MAJOR} restores"
        )));
    }

    if let Some(root_manifest) =
        archive_text_file(bytes, entries, Path::new(NATIVE_ROOT_MANIFEST_FILE))?
    {
        validate_native_root_manifest_text(
            Path::new(NATIVE_ROOT_MANIFEST_FILE),
            &root_manifest,
            pgdata_version.as_deref(),
        )?;
    }

    if let Some(backup_manifest) =
        archive_text_file(bytes, entries, Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH))?
    {
        validate_physical_archive_manifest_text(
            Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH),
            &backup_manifest,
            pgdata_version.as_deref(),
        )?;
    }

    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArchiveEntryKind {
    File,
    Directory,
}

struct ArchiveEntryPlan {
    canonical_path: PathBuf,
    kind: ArchiveEntryKind,
    mode: usize,
    size: usize,
}

fn validate_physical_archive_entries(bytes: &[u8]) -> Result<Vec<ArchiveEntryPlan>> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let entries = archive
        .entries()
        .map_err(|err| Error::Engine(format!("read physical archive entries: {err}")))?;
    let mut seen_paths = HashSet::new();
    let mut seen_file_paths = HashSet::new();
    let mut seen_entry_ancestors = HashSet::new();
    let mut plans = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|err| Error::Engine(format!("read physical archive entry: {err}")))?;
        validate_archive_header_format(entry.header())?;
        validate_archive_numeric_fields(entry.header())?;
        let path = entry
            .path()
            .map_err(|err| Error::Engine(format!("read physical archive entry path: {err}")))?
            .into_owned();
        let canonical_path = canonical_archive_path(&path)?;
        if !seen_paths.insert(canonical_path.clone()) {
            return Err(Error::Engine(format!(
                "physical archive contains duplicate entry {}",
                canonical_path.display()
            )));
        }
        let entry_type = entry.header().entry_type();
        let kind = validate_archive_entry_type(entry_type, &canonical_path)?;
        if let Some(link_name) = entry
            .link_name()
            .map_err(|err| Error::Engine(format!("read archive link target: {err}")))?
        {
            return Err(Error::Engine(format!(
                "physical archive entry {} has an unexpected link target {}; liboliphaunt physical archives must contain concrete root files",
                canonical_path.display(),
                link_name.display()
            )));
        }
        let (mode, size) = archive_entry_mode_and_size(entry.header())?;
        validate_archive_tree_shape(
            &canonical_path,
            kind,
            size,
            &seen_file_paths,
            &seen_entry_ancestors,
        )?;
        remember_archive_tree_shape(
            &canonical_path,
            kind,
            &mut seen_file_paths,
            &mut seen_entry_ancestors,
        );
        plans.push(ArchiveEntryPlan {
            canonical_path,
            kind,
            mode,
            size,
        });
    }
    Ok(plans)
}

fn restore_physical_archive_entries(
    bytes: &[u8],
    staging_root: &Path,
    entry_plans: &[ArchiveEntryPlan],
) -> Result<()> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let entries = archive
        .entries()
        .map_err(|err| Error::Engine(format!("read physical archive entries: {err}")))?;
    let mut plans = entry_plans.iter();
    for entry in entries {
        let mut entry =
            entry.map_err(|err| Error::Engine(format!("read physical archive entry: {err}")))?;
        let plan = plans.next().ok_or_else(|| {
            Error::Engine("physical archive entry plan ended before archive entries".to_owned())
        })?;
        restore_archive_entry(&mut entry, staging_root, plan)?;
    }
    if plans.next().is_some() {
        return Err(Error::Engine(
            "physical archive ended before validated entry plan".to_owned(),
        ));
    }
    Ok(())
}

fn archive_entry_mode_and_size(header: &Header) -> Result<(usize, usize)> {
    let bytes = header.as_bytes();
    Ok((
        parse_tar_octal_field(&bytes[100..108], "mode", false)?,
        parse_tar_octal_field(&bytes[124..136], "size", false)?,
    ))
}

fn validate_archive_tree_shape(
    canonical_path: &Path,
    kind: ArchiveEntryKind,
    size: usize,
    seen_file_paths: &HashSet<PathBuf>,
    seen_entry_ancestors: &HashSet<PathBuf>,
) -> Result<()> {
    if kind == ArchiveEntryKind::Directory && size != 0 {
        return Err(Error::Engine(format!(
            "physical archive directory entry {} has non-zero size",
            canonical_path.display()
        )));
    }
    if let Some(ancestor) = archive_file_ancestor(canonical_path, seen_file_paths) {
        return Err(Error::Engine(format!(
            "physical archive entry {} is nested under file entry {}",
            canonical_path.display(),
            ancestor.display()
        )));
    }
    if kind == ArchiveEntryKind::File && seen_entry_ancestors.contains(canonical_path) {
        return Err(Error::Engine(format!(
            "physical archive file entry {} conflicts with existing child entries",
            canonical_path.display()
        )));
    }
    Ok(())
}

fn remember_archive_tree_shape(
    canonical_path: &Path,
    kind: ArchiveEntryKind,
    seen_file_paths: &mut HashSet<PathBuf>,
    seen_entry_ancestors: &mut HashSet<PathBuf>,
) {
    if kind == ArchiveEntryKind::File {
        seen_file_paths.insert(canonical_path.to_path_buf());
    }
    for ancestor in archive_path_ancestors(canonical_path) {
        seen_entry_ancestors.insert(ancestor);
    }
}

fn archive_file_ancestor(path: &Path, seen_file_paths: &HashSet<PathBuf>) -> Option<PathBuf> {
    archive_path_ancestors(path)
        .into_iter()
        .find(|ancestor| seen_file_paths.contains(ancestor))
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

fn restore_archive_entry<R: io::Read>(
    entry: &mut tar::Entry<'_, R>,
    staging_root: &Path,
    plan: &ArchiveEntryPlan,
) -> Result<()> {
    let destination = staging_root.join(&plan.canonical_path);
    if plan.kind == ArchiveEntryKind::Directory {
        if plan.size != 0 {
            return Err(Error::Engine(format!(
                "physical archive directory entry {} has non-zero size",
                plan.canonical_path.display()
            )));
        }
        fs::create_dir_all(&destination).map_err(|err| {
            Error::Engine(format!(
                "create restored directory {}: {err}",
                destination.display()
            ))
        })?;
        apply_restored_permissions(&destination, plan.mode, 0o700)?;
        return Ok(());
    }

    let parent = destination.parent().ok_or_else(|| {
        Error::Engine(format!(
            "restore physical archive entry {} has no parent directory",
            plan.canonical_path.display()
        ))
    })?;
    fs::create_dir_all(parent).map_err(|err| {
        Error::Engine(format!(
            "create restored parent directory {}: {err}",
            parent.display()
        ))
    })?;
    let mut file = File::create(&destination).map_err(|err| {
        Error::Engine(format!(
            "create restored file {}: {err}",
            destination.display()
        ))
    })?;
    let copied = io::copy(entry, &mut file).map_err(|err| {
        Error::Engine(format!(
            "write restored file {}: {err}",
            destination.display()
        ))
    })?;
    if copied != plan.size as u64 {
        return Err(Error::Engine(format!(
            "physical archive entry {} restored {} bytes, expected {}",
            plan.canonical_path.display(),
            copied,
            plan.size
        )));
    }
    apply_restored_permissions(&destination, plan.mode, 0o600)
}

#[cfg(unix)]
fn apply_restored_permissions(path: &Path, mode: usize, default_mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let effective_mode = if mode == 0 { default_mode } else { mode as u32 };
    fs::set_permissions(path, fs::Permissions::from_mode(effective_mode)).map_err(|err| {
        Error::Engine(format!(
            "set restored permissions on {}: {err}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn apply_restored_permissions(path: &Path, mode: usize, default_mode: u32) -> Result<()> {
    let _ = (path, mode, default_mode);
    Ok(())
}

fn validate_physical_archive_framing(bytes: &[u8]) -> Result<()> {
    physical_archive_data_end_offset(bytes).map(|_| ())
}

fn physical_archive_data_end_offset(bytes: &[u8]) -> Result<usize> {
    if bytes.len() < 1024 || !bytes.len().is_multiple_of(512) {
        return Err(Error::Engine(
            "physical archive has invalid tar block framing".to_owned(),
        ));
    }
    if !tar_block_is_zero(&bytes[bytes.len() - 1024..bytes.len() - 512])
        || !tar_block_is_zero(&bytes[bytes.len() - 512..])
    {
        return Err(Error::Engine(
            "physical archive ended before final tar zero block".to_owned(),
        ));
    }

    let mut offset = 0usize;
    while offset + 512 <= bytes.len() {
        let header = &bytes[offset..offset + 512];
        offset += 512;
        if tar_block_is_zero(header) {
            if offset + 512 > bytes.len() {
                return Err(Error::Engine(
                    "physical archive ended before final tar zero block".to_owned(),
                ));
            }
            if !tar_block_is_zero(&bytes[offset..offset + 512]) {
                return Err(Error::Engine(
                    "physical archive has trailing data after tar terminator".to_owned(),
                ));
            }
            offset += 512;
            for block in bytes[offset..].chunks_exact(512) {
                if !tar_block_is_zero(block) {
                    return Err(Error::Engine(
                        "physical archive has trailing data after tar terminator".to_owned(),
                    ));
                }
            }
            return Ok(offset - 1024);
        }

        validate_tar_header_checksum(header)?;
        validate_tar_header_numeric_fields(header)?;
        validate_tar_header_string_fields(header)?;
        let size = parse_tar_octal_field(&header[124..136], "size", false)?;
        let padded = size
            .checked_add(511)
            .map(|size| size & !511)
            .ok_or_else(|| Error::Engine("physical archive entry size overflows".to_owned()))?;
        if padded > bytes.len().saturating_sub(offset) {
            return Err(Error::Engine(
                "physical archive entry is truncated".to_owned(),
            ));
        }
        offset += padded;
    }

    Err(Error::Engine(
        "physical archive ended before final tar zero block".to_owned(),
    ))
}

fn archive_text_file(
    bytes: &[u8],
    entry_plans: &[ArchiveEntryPlan],
    target_path: &Path,
) -> Result<Option<String>> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let entries = archive
        .entries()
        .map_err(|err| Error::Engine(format!("read physical archive entries: {err}")))?;
    let mut plans = entry_plans.iter();
    for entry in entries {
        let mut entry =
            entry.map_err(|err| Error::Engine(format!("read physical archive entry: {err}")))?;
        let plan = plans.next().ok_or_else(|| {
            Error::Engine("physical archive entry plan ended before archive entries".to_owned())
        })?;
        if plan.canonical_path != target_path {
            continue;
        }
        if plan.kind != ArchiveEntryKind::File {
            return Err(Error::Engine(format!(
                "physical archive metadata entry {} must be a regular file",
                target_path.display()
            )));
        }
        if plan.size > PHYSICAL_ARCHIVE_METADATA_MAX_BYTES {
            return Err(Error::Engine(format!(
                "physical archive metadata entry {} is too large",
                target_path.display()
            )));
        }
        let mut bytes = Vec::with_capacity(plan.size);
        entry.read_to_end(&mut bytes).map_err(|err| {
            Error::Engine(format!(
                "read physical archive metadata entry {}: {err}",
                target_path.display()
            ))
        })?;
        return String::from_utf8(bytes).map(Some).map_err(|err| {
            Error::Engine(format!(
                "physical archive metadata entry {} is not UTF-8: {err}",
                target_path.display()
            ))
        });
    }
    Ok(None)
}

fn validate_physical_archive_manifest_text(
    manifest_path: &Path,
    text: &str,
    pgdata_version: Option<&str>,
) -> Result<()> {
    let properties = parse_manifest_properties(manifest_path, text)?;
    require_manifest_value(
        manifest_path,
        &properties,
        "archiveLayout",
        PHYSICAL_ARCHIVE_MANIFEST_LAYOUT,
    )?;
    require_manifest_value(manifest_path, &properties, "product", "oliphaunt")?;
    require_manifest_value(
        manifest_path,
        &properties,
        "postgresMajor",
        PHYSICAL_ARCHIVE_POSTGRES_MAJOR,
    )?;
    let manifest_pgdata_version = manifest_property(manifest_path, &properties, "pgdataVersion")?;
    if let Some(version) = pgdata_version
        && manifest_pgdata_version != version
    {
        return Err(Error::Engine(format!(
            "physical archive manifest {} declares PGDATA version '{}', but pgdata/PG_VERSION contains PostgreSQL {version}",
            manifest_path.display(),
            manifest_pgdata_version
        )));
    }
    let version_num = manifest_property(manifest_path, &properties, "postgresVersionNum")?;
    if !version_num.starts_with(PHYSICAL_ARCHIVE_POSTGRES_MAJOR) {
        return Err(Error::Engine(format!(
            "physical archive manifest {} declares PostgreSQL version number '{}', expected major {PHYSICAL_ARCHIVE_POSTGRES_MAJOR}",
            manifest_path.display(),
            version_num
        )));
    }
    for key in [
        "serverEncoding",
        "lcCollate",
        "lcCtype",
        "dataChecksums",
        "sharedPreloadLibraries",
        "requiredPreloadLibraries",
        "selectedExtensions",
        "installedExtensions",
    ] {
        let _ = manifest_property(manifest_path, &properties, key)?;
    }
    Ok(())
}

fn parse_manifest_properties(
    manifest_path: &Path,
    text: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    let mut properties = std::collections::BTreeMap::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(Error::Engine(format!(
                "physical archive manifest {} line {} must use key=value syntax",
                manifest_path.display(),
                index + 1
            )));
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() {
            return Err(Error::Engine(format!(
                "physical archive manifest {} line {} must not use an empty key",
                manifest_path.display(),
                index + 1
            )));
        }
        if properties
            .insert(key.to_owned(), value.to_owned())
            .is_some()
        {
            return Err(Error::Engine(format!(
                "physical archive manifest {} repeats key '{key}'",
                manifest_path.display()
            )));
        }
    }
    Ok(properties)
}

fn require_manifest_value(
    manifest_path: &Path,
    properties: &std::collections::BTreeMap<String, String>,
    key: &str,
    expected: &str,
) -> Result<()> {
    let actual = manifest_property(manifest_path, properties, key)?;
    if actual == expected {
        return Ok(());
    }
    Err(Error::Engine(format!(
        "physical archive manifest {} has {key}='{actual}', expected '{expected}'",
        manifest_path.display()
    )))
}

fn manifest_property<'a>(
    manifest_path: &Path,
    properties: &'a std::collections::BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str> {
    properties.get(key).map(String::as_str).ok_or_else(|| {
        Error::Engine(format!(
            "physical archive manifest {} is missing required key '{key}'",
            manifest_path.display()
        ))
    })
}

fn tar_block_is_zero(block: &[u8]) -> bool {
    block.iter().all(|byte| *byte == 0)
}

fn tar_header_checksum(header: &[u8]) -> usize {
    header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                usize::from(b' ')
            } else {
                usize::from(*byte)
            }
        })
        .sum()
}

fn parse_tar_octal_field(field: &[u8], label: &str, allow_empty: bool) -> Result<usize> {
    let mut value = 0usize;
    let mut saw_digit = false;
    let mut index = 0usize;
    while index < field.len() && (field[index] == b' ' || field[index] == 0) {
        index += 1;
    }
    while index < field.len() {
        let byte = field[index];
        match byte {
            b'0'..=b'7' => {
                saw_digit = true;
                value = value
                    .checked_mul(8)
                    .and_then(|current| current.checked_add(usize::from(byte - b'0')))
                    .ok_or_else(|| {
                        Error::Engine("physical archive entry size overflows".to_owned())
                    })?;
            }
            b' ' | 0 => break,
            _ => {
                return Err(Error::Engine(format!(
                    "physical archive entry has invalid tar {label} field"
                )));
            }
        }
        index += 1;
    }
    while index < field.len() {
        if field[index] != b' ' && field[index] != 0 {
            return Err(Error::Engine(format!(
                "physical archive entry has invalid tar {label} field"
            )));
        }
        index += 1;
    }
    if !saw_digit {
        if allow_empty {
            return Ok(0);
        }
        return Err(Error::Engine(format!(
            "physical archive entry has invalid tar {label} field"
        )));
    }
    Ok(value)
}

fn validate_tar_header_checksum(bytes: &[u8]) -> Result<()> {
    let stored = parse_tar_octal_field(&bytes[148..156], "checksum", false)?;
    if stored != tar_header_checksum(bytes) {
        return Err(Error::Engine(
            "physical archive entry has invalid tar checksum".to_owned(),
        ));
    }
    Ok(())
}

fn validate_archive_numeric_fields(header: &Header) -> Result<()> {
    validate_tar_header_numeric_fields(header.as_bytes())
}

fn validate_tar_header_numeric_fields(bytes: &[u8]) -> Result<()> {
    parse_tar_octal_field(&bytes[100..108], "mode", false)?;
    parse_tar_octal_field(&bytes[108..116], "uid", true)?;
    parse_tar_octal_field(&bytes[116..124], "gid", true)?;
    parse_tar_octal_field(&bytes[124..136], "size", false)?;
    parse_tar_octal_field(&bytes[136..148], "mtime", true)?;
    parse_tar_octal_field(&bytes[148..156], "checksum", false)?;
    Ok(())
}

fn validate_tar_header_string_fields(bytes: &[u8]) -> Result<()> {
    validate_tar_string_field(&bytes[0..100], "name", false)?;
    validate_tar_string_field(&bytes[157..257], "linkname", true)?;
    validate_tar_string_field(&bytes[345..500], "prefix", true)?;
    Ok(())
}

fn validate_tar_string_field(field: &[u8], label: &str, allow_empty: bool) -> Result<()> {
    let terminator = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    if terminator == 0 && !allow_empty {
        return Err(Error::Engine(format!(
            "physical archive entry has invalid tar {label} field"
        )));
    }
    if terminator == field.len() {
        return Ok(());
    }
    if field[terminator + 1..].iter().any(|byte| *byte != 0) {
        return Err(Error::Engine(format!(
            "physical archive entry has invalid tar {label} field"
        )));
    }
    Ok(())
}

fn validate_archive_header_format(header: &Header) -> Result<()> {
    if header.as_ustar().is_some() || header.as_gnu().is_some() {
        return Ok(());
    }
    Err(Error::Engine(
        "physical archive entry has unsupported tar header format".to_owned(),
    ))
}

fn validate_archive_entry_type(entry_type: EntryType, path: &Path) -> Result<ArchiveEntryKind> {
    if entry_type.is_file() {
        return Ok(ArchiveEntryKind::File);
    }
    if entry_type.is_dir() {
        return Ok(ArchiveEntryKind::Directory);
    }
    if entry_type.is_symlink() || entry_type.is_hard_link() {
        return Err(Error::Engine(format!(
            "physical archive entry {} is a link; liboliphaunt physical archives must contain concrete root files",
            path.display()
        )));
    }
    Err(Error::Engine(format!(
        "physical archive entry {} has unsupported tar entry type {:?}; liboliphaunt physical archives only support regular files and directories",
        path.display(),
        entry_type
    )))
}

fn canonical_archive_path(path: &Path) -> Result<PathBuf> {
    let mut canonical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => canonical.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::Engine(format!(
                    "physical archive entry {} contains an unsafe path component",
                    path.display()
                )));
            }
        }
    }
    if canonical.as_os_str().is_empty() {
        return Err(Error::Engine(format!(
            "physical archive entry {} is not relative",
            path.display()
        )));
    }
    if !archive_path_is_allowed(&canonical) {
        return Err(Error::Engine(format!(
            "physical archive entry {} is outside supported liboliphaunt archive paths",
            path.display()
        )));
    }
    Ok(canonical)
}

fn archive_path_is_allowed(path: &Path) -> bool {
    path == Path::new(NATIVE_ROOT_MANIFEST_FILE)
        || path == Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH)
        || path == Path::new("pgdata")
        || path.starts_with("pgdata/")
}

fn validate_restored_pgdata(root: &Path) -> Result<()> {
    for required in [
        "pgdata/PG_VERSION",
        "pgdata/global/pg_control",
        "pgdata/backup_label",
    ] {
        let path = root.join(required);
        if !path.is_file() {
            return Err(Error::Engine(format!(
                "physical archive is missing required file {required}"
            )));
        }
    }
    ensure_native_root_manifest(root, &root.join("pgdata"))
}

fn publish_restored_root(
    staging_root: &Path,
    target_root: &Path,
    target_policy: RestoreTargetPolicy,
) -> Result<()> {
    match target_policy {
        RestoreTargetPolicy::FailIfExists => {
            publish_restore_without_replacement(staging_root, target_root)
        }
        RestoreTargetPolicy::ReplaceExisting => {
            publish_restore_with_replacement(staging_root, target_root)
        }
    }
}

fn publish_restore_without_replacement(staging_root: &Path, target_root: &Path) -> Result<()> {
    if target_root.exists() {
        if !target_root.is_dir() {
            return Err(Error::Engine(format!(
                "refusing to restore over non-directory target {}",
                target_root.display()
            )));
        }
        if !directory_is_empty(target_root)? {
            return Err(Error::Engine(format!(
                "refusing to restore into non-empty target {}; use replace_existing() to replace it",
                target_root.display()
            )));
        }
        fs::remove_dir(target_root).map_err(|err| {
            Error::Engine(format!(
                "remove empty restore target {} before publish: {err}",
                target_root.display()
            ))
        })?;
    }
    rename_dir(staging_root, target_root, "publish restored root")
}

fn publish_restore_with_replacement(staging_root: &Path, target_root: &Path) -> Result<()> {
    if !target_root.exists() {
        return rename_dir(staging_root, target_root, "publish restored root");
    }
    if !target_root.is_dir() {
        return Err(Error::Engine(format!(
            "refusing to replace non-directory restore target {}",
            target_root.display()
        )));
    }

    let displaced_root = unique_sibling_path(target_root, "restore-replaced");
    rename_dir(
        target_root,
        &displaced_root,
        "move existing root aside for restore",
    )?;
    if let Err(error) = rename_dir(staging_root, target_root, "publish restored root") {
        let _ = rename_dir(
            &displaced_root,
            target_root,
            "restore previous root after failure",
        );
        return Err(error);
    }
    fs::remove_dir_all(&displaced_root).map_err(|err| {
        Error::Engine(format!(
            "remove replaced restore target {}: {err}",
            displaced_root.display()
        ))
    })
}

fn acquire_restore_target_lock(target_root: &Path) -> Result<NativeRootLock> {
    NativeRootLock::reserve_path(target_root, "restore target")
}

fn directory_is_empty(path: &Path) -> Result<bool> {
    let mut entries = fs::read_dir(path)
        .map_err(|err| Error::Engine(format!("read directory {}: {err}", path.display())))?;
    Ok(entries.next().is_none())
}

fn rename_dir(source: &Path, destination: &Path, context: &str) -> Result<()> {
    fs::rename(source, destination).map_err(|err| {
        Error::Engine(format!(
            "{context}: rename {} to {}: {err}",
            source.display(),
            destination.display()
        ))
    })
}

fn unique_sibling_path(target_root: &Path, suffix: &str) -> PathBuf {
    let parent = target_root.parent().unwrap_or_else(|| Path::new("."));
    let name = target_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("root");
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    for attempt in 0..100_u32 {
        let candidate = parent.join(format!(".{name}-{suffix}-{pid}-{nanos}-{attempt}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!(".{name}-{suffix}-{pid}-{nanos}-fallback"))
}

struct CleanupDir {
    path: PathBuf,
    armed: std::cell::Cell<bool>,
}

impl CleanupDir {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            armed: std::cell::Cell::new(true),
        }
    }

    fn disarm(&self) {
        self.armed.set(false);
    }
}

impl Drop for CleanupDir {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn append_pgdata_tree(archive: &mut Builder<&mut Vec<u8>>, pgdata: &Path) -> Result<()> {
    append_directory(archive, pgdata, Path::new("pgdata"))?;
    for entry in sorted_read_dir(pgdata)? {
        append_pgdata_entry(archive, pgdata, &entry.path(), false)?;
    }
    Ok(())
}

fn append_pg_wal_tree(archive: &mut Builder<&mut Vec<u8>>, pgdata: &Path) -> Result<()> {
    let pg_wal = pgdata.join("pg_wal");
    if !pg_wal.is_dir() {
        return Ok(());
    }
    for entry in sorted_read_dir(&pg_wal)? {
        append_pgdata_entry(archive, pgdata, &entry.path(), true)?;
    }
    Ok(())
}

fn append_pgdata_entry(
    archive: &mut Builder<&mut Vec<u8>>,
    pgdata: &Path,
    source: &Path,
    include_wal_contents: bool,
) -> Result<()> {
    let relative = source.strip_prefix(pgdata).map_err(|err| {
        Error::Engine(format!(
            "strip PGDATA prefix {} from {}: {err}",
            pgdata.display(),
            source.display()
        ))
    })?;
    if should_skip_pgdata_entry(relative, include_wal_contents) {
        return Ok(());
    }

    let archive_path = Path::new("pgdata").join(relative);
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| Error::Engine(format!("stat {} for backup: {err}", source.display())))?;
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        append_directory(archive, source, &archive_path)?;
        for entry in sorted_read_dir(source)? {
            append_pgdata_entry(archive, pgdata, &entry.path(), include_wal_contents)?;
        }
    } else if file_type.is_file() {
        append_file(archive, source, &archive_path)?;
    } else if file_type.is_symlink() {
        return Err(Error::Engine(format!(
            "physical archive does not support symlinked PGDATA entry {}; external tablespaces and linked WAL directories are not portable in liboliphaunt archives",
            archive_path.display()
        )));
    } else {
        return Err(Error::Engine(format!(
            "physical archive does not support non-regular PGDATA entry {}; liboliphaunt archives only support regular files and directories",
            archive_path.display()
        )));
    }
    Ok(())
}

fn should_skip_pgdata_entry(relative: &Path, include_wal_contents: bool) -> bool {
    if relative == Path::new("postmaster.pid") || relative == Path::new("postmaster.opts") {
        return true;
    }
    if relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "pg_internal.init" || name.starts_with("pgsql_tmp"))
    {
        return true;
    }
    let mut components = relative.components();
    let Some(Component::Normal(first)) = components.next() else {
        return false;
    };
    let has_child = components.next().is_some();
    if !has_child {
        return false;
    }
    first.to_str().is_some_and(|name| {
        TRANSIENT_CONTENT_DIRS.contains(&name) || (name == "pg_wal" && !include_wal_contents)
    })
}

fn append_directory(
    archive: &mut Builder<&mut Vec<u8>>,
    source: &Path,
    archive_path: &Path,
) -> Result<()> {
    archive
        .append_dir(archive_path, source)
        .map_err(|err| Error::Engine(format!("archive directory {}: {err}", source.display())))
}

fn append_file(
    archive: &mut Builder<&mut Vec<u8>>,
    source: &Path,
    archive_path: &Path,
) -> Result<()> {
    let mut file = File::open(source)
        .map_err(|err| Error::Engine(format!("open {} for backup: {err}", source.display())))?;
    archive
        .append_file(archive_path, &mut file)
        .map_err(|err| Error::Engine(format!("archive file {}: {err}", source.display())))
}

fn append_generated_file(
    archive: &mut Builder<&mut Vec<u8>>,
    archive_path: &str,
    contents: String,
) -> Result<()> {
    let bytes = contents.into_bytes();
    let mut header = Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive
        .append_data(&mut header, archive_path, Cursor::new(bytes))
        .map_err(|err| Error::Engine(format!("archive generated file {archive_path}: {err}")))
}

fn ensure_simple_query_ok(response: ProtocolResponse, context: &str) -> Result<()> {
    for message in BackendMessages::new(response.as_bytes()) {
        let (tag, body) = message?;
        if tag == b'E' {
            return Err(Error::Engine(format!(
                "{context} failed: {}",
                postgres_error_message(body)
            )));
        }
    }
    Ok(())
}

fn first_data_row(response: ProtocolResponse, context: &str) -> Result<Vec<Option<Vec<u8>>>> {
    for message in BackendMessages::new(response.as_bytes()) {
        let (tag, body) = message?;
        match tag {
            b'D' => return parse_data_row(body),
            b'E' => {
                return Err(Error::Engine(format!(
                    "{context} failed: {}",
                    postgres_error_message(body)
                )));
            }
            _ => {}
        }
    }
    Err(Error::Engine(format!("{context} returned no data row")))
}

fn parse_data_row(mut body: &[u8]) -> Result<Vec<Option<Vec<u8>>>> {
    let columns = read_i16(&mut body)? as usize;
    let mut values = Vec::with_capacity(columns);
    for _ in 0..columns {
        let len = read_i32(&mut body)?;
        if len == -1 {
            values.push(None);
        } else if len < 0 {
            return Err(Error::Engine(format!(
                "invalid DataRow column length {len}"
            )));
        } else {
            let len = len as usize;
            if body.len() < len {
                return Err(Error::Engine("truncated DataRow column value".to_owned()));
            }
            values.push(Some(body[..len].to_vec()));
            body = &body[len..];
        }
    }
    Ok(values)
}

fn postgres_error_message(mut body: &[u8]) -> String {
    let mut severity = None;
    let mut message = None;
    while let Some((&field_type, rest)) = body.split_first() {
        if field_type == 0 {
            break;
        }
        let Some(end) = rest.iter().position(|byte| *byte == 0) else {
            break;
        };
        let value = String::from_utf8_lossy(&rest[..end]).into_owned();
        match field_type {
            b'S' | b'V' if severity.is_none() => severity = Some(value),
            b'M' => message = Some(value),
            _ => {}
        }
        body = &rest[end + 1..];
    }
    match (severity, message) {
        (Some(severity), Some(message)) => format!("{severity}: {message}"),
        (None, Some(message)) => message,
        _ => "PostgreSQL ErrorResponse".to_owned(),
    }
}

struct BackendMessages<'a> {
    bytes: &'a [u8],
}

impl<'a> BackendMessages<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

impl<'a> Iterator for BackendMessages<'a> {
    type Item = Result<(u8, &'a [u8])>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.bytes.is_empty() {
            return None;
        }
        if self.bytes.len() < 5 {
            self.bytes = &[];
            return Some(Err(Error::Engine(
                "truncated PostgreSQL backend message header".to_owned(),
            )));
        }
        let tag = self.bytes[0];
        let len = i32::from_be_bytes([self.bytes[1], self.bytes[2], self.bytes[3], self.bytes[4]]);
        if len < 4 {
            self.bytes = &[];
            return Some(Err(Error::Engine(format!(
                "invalid PostgreSQL backend message length {len}"
            ))));
        }
        let total_len = 1 + len as usize;
        if self.bytes.len() < total_len {
            self.bytes = &[];
            return Some(Err(Error::Engine(
                "truncated PostgreSQL backend message body".to_owned(),
            )));
        }
        let body = &self.bytes[5..total_len];
        self.bytes = &self.bytes[total_len..];
        Some(Ok((tag, body)))
    }
}

fn read_i16(bytes: &mut &[u8]) -> Result<i16> {
    if bytes.len() < 2 {
        return Err(Error::Engine("truncated PostgreSQL int16".to_owned()));
    }
    let value = i16::from_be_bytes([bytes[0], bytes[1]]);
    *bytes = &bytes[2..];
    Ok(value)
}

fn read_i32(bytes: &mut &[u8]) -> Result<i32> {
    if bytes.len() < 4 {
        return Err(Error::Engine("truncated PostgreSQL int32".to_owned()));
    }
    let value = i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    *bytes = &bytes[4..];
    Ok(value)
}

fn sorted_read_dir(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .map_err(|err| Error::Engine(format!("read directory {}: {err}", path.display())))?
        .collect::<io::Result<Vec<_>>>()
        .map_err(|err| {
            Error::Engine(format!("read directory entry in {}: {err}", path.display()))
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

struct BackupStopFiles {
    backup_label: String,
    tablespace_map: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_rejects_symlink_archive_entries() {
        let artifact = archive_with_link_entry(EntryType::symlink());
        let root = unique_temp_root("liboliphaunt-restore-symlink-entry");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("is a link"),
            "unexpected symlink-entry restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_hardlink_archive_entries() {
        let artifact = archive_with_link_entry(EntryType::hard_link());
        let root = unique_temp_root("liboliphaunt-restore-hardlink-entry");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("is a link"),
            "unexpected hardlink-entry restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_fifo_archive_entries() {
        let artifact = archive_with_special_entry(EntryType::fifo());
        let root = unique_temp_root("liboliphaunt-restore-fifo-entry");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported tar entry type Fifo"),
            "unexpected fifo-entry restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_directory_entries_with_payload() {
        let artifact = archive_with_nonzero_directory_entry();
        let root = unique_temp_root("liboliphaunt-restore-nonzero-dir");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("directory entry pgdata/base/nonzero-dir has non-zero size"),
            "unexpected nonzero-dir restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_checksum() {
        let artifact = archive_with_invalid_header_checksum();
        let root = unique_temp_root("liboliphaunt-restore-invalid-checksum");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("invalid tar checksum"),
            "unexpected checksum restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_checksum_field() {
        let artifact = archive_with_invalid_checksum_field();
        let root = unique_temp_root("liboliphaunt-restore-invalid-checksum-field");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("invalid tar checksum field"),
            "unexpected checksum-field restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_magic() {
        let artifact = archive_with_invalid_header_magic();
        let root = unique_temp_root("liboliphaunt-restore-invalid-magic");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("unsupported tar header format"),
            "unexpected tar-format restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_size_field() {
        let artifact = archive_with_invalid_numeric_header_field(124);
        let root = unique_temp_root("liboliphaunt-restore-invalid-size-field");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("invalid tar size field"),
            "unexpected tar-size restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_mode_field() {
        let artifact = archive_with_invalid_numeric_header_field(100);
        let root = unique_temp_root("liboliphaunt-restore-invalid-mode-field");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("invalid tar mode field"),
            "unexpected tar-mode restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_invalid_tar_ignored_metadata_fields() {
        for (field_offset, label) in [(108, "uid"), (116, "gid"), (136, "mtime")] {
            let artifact = archive_with_invalid_numeric_header_field(field_offset);
            let root = unique_temp_root(&format!("liboliphaunt-restore-invalid-{label}-field"));
            let error =
                restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains(&format!("invalid tar {label} field")),
                "unexpected tar-{label} restore error: {error}"
            );
            assert!(!root.exists());
        }
    }

    #[test]
    fn restore_rejects_invalid_tar_string_fields() {
        for (field_offset, label) in [
            ("pgdata/PG_VERSION".len() + 1, "name"),
            (158, "linkname"),
            (346, "prefix"),
        ] {
            let artifact = archive_with_invalid_string_header_field(field_offset);
            let root = unique_temp_root(&format!("liboliphaunt-restore-invalid-{label}-field"));
            let error =
                restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains(&format!("invalid tar {label} field")),
                "unexpected tar-{label} restore error: {error}"
            );
            assert!(!root.exists());
        }
    }

    #[test]
    fn restore_rejects_truncated_tar_terminator() {
        let artifact = archive_with_truncated_terminator();
        let root = unique_temp_root("liboliphaunt-restore-truncated-terminator");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("final tar zero block"),
            "unexpected truncated-terminator restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_trailing_data_after_tar_terminator() {
        let artifact = archive_with_trailing_data_after_terminator();
        let root = unique_temp_root("liboliphaunt-restore-trailing-data");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("trailing data after tar terminator"),
            "unexpected trailing-data restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_duplicate_archive_entries() {
        let artifact = archive_with_duplicate_entry("pgdata/PG_VERSION");
        let root = unique_temp_root("liboliphaunt-restore-duplicate-entry");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("duplicate entry pgdata/PG_VERSION"),
            "unexpected duplicate-entry restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_duplicate_canonical_archive_entries() {
        let artifact = archive_with_duplicate_entry("pgdata/./PG_VERSION");
        let root = unique_temp_root("liboliphaunt-restore-duplicate-canonical-entry");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("duplicate entry pgdata/PG_VERSION"),
            "unexpected canonical duplicate-entry restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_archive_entries_nested_under_file_entries() {
        let artifact = archive_with_file_tree_collision(true);
        let root = unique_temp_root("liboliphaunt-restore-file-ancestor-collision");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("entry pgdata/base/child is nested under file entry pgdata/base"),
            "unexpected file-ancestor collision restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_file_entries_that_replace_seen_subtrees() {
        let artifact = archive_with_file_tree_collision(false);
        let root = unique_temp_root("liboliphaunt-restore-file-child-collision");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("file entry pgdata/base conflicts with existing child entries"),
            "unexpected file-child collision restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_writes_to_canonical_archive_paths() {
        let artifact = archive_with_canonicalized_required_path();
        let root = unique_temp_root("liboliphaunt-restore-canonical-output");
        let restored = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap();
        assert_eq!(restored, root);
        assert_eq!(
            fs::read(root.join("pgdata/global/pg_control")).unwrap(),
            b"control"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_rejects_regular_file_with_link_metadata() {
        let artifact = archive_with_regular_file_link_metadata();
        let root = unique_temp_root("liboliphaunt-restore-regular-link-metadata");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error.to_string().contains("unexpected link target"),
            "unexpected regular-file link metadata restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn annotated_physical_archive_includes_root_and_backup_manifests() {
        let root = unique_temp_root("liboliphaunt-backup-metadata");
        let pgdata = root.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();

        let annotated = annotate_physical_archive_backup(
            valid_test_archive(),
            &pgdata,
            &[Extension::Hstore, Extension::Vector],
            |_request| Ok(metadata_response()),
        )
        .unwrap();
        let entries = validate_physical_archive_entries(annotated.bytes.as_slice()).unwrap();
        assert!(archive_contains_path(
            &entries,
            Path::new(NATIVE_ROOT_MANIFEST_FILE)
        ));
        assert!(archive_contains_path(
            &entries,
            Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH)
        ));

        let backup_manifest = archive_text_file(
            annotated.bytes.as_slice(),
            &entries,
            Path::new(PHYSICAL_ARCHIVE_MANIFEST_PATH),
        )
        .unwrap()
        .unwrap();
        assert!(backup_manifest.contains("archiveLayout=oliphaunt-physical-archive-v1\n"));
        assert!(backup_manifest.contains("postgresMajor=18\n"));
        assert!(backup_manifest.contains("postgresVersionNum=180000\n"));
        assert!(backup_manifest.contains("serverEncoding=UTF8\n"));
        assert!(backup_manifest.contains("selectedExtensions=hstore,vector\n"));
        assert!(backup_manifest.contains("installedExtensions=plpgsql,vector\n"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_rejects_incompatible_root_manifest_before_materializing_target() {
        let artifact = archive_with_root_manifest(
            b"layout=oliphaunt-root-v1\nproduct=oliphaunt\npostgresMajor=17\npgdata=pgdata\npgdataVersion=18\n",
        );
        let root = unique_temp_root("liboliphaunt-restore-incompatible-root-manifest");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("postgresMajor='17', expected '18'"),
            "unexpected incompatible root-manifest restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[test]
    fn restore_rejects_incompatible_backup_manifest_before_materializing_target() {
        let artifact = archive_with_backup_manifest(
            b"archiveLayout=oliphaunt-physical-archive-v1\nproduct=oliphaunt\npostgresMajor=17\npgdataVersion=18\npostgresVersionNum=170000\nserverEncoding=UTF8\nlcCollate=C\nlcCtype=C\ndataChecksums=off\nsharedPreloadLibraries=\nrequiredPreloadLibraries=\nselectedExtensions=\ninstalledExtensions=plpgsql\n",
        );
        let root = unique_temp_root("liboliphaunt-restore-incompatible-backup-manifest");
        let error = restore_backup(RestoreRequest::physical_archive(&root, artifact)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("postgresMajor='17', expected '18'"),
            "unexpected incompatible backup-manifest restore error: {error}"
        );
        assert!(!root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn physical_archive_rejects_symlinked_pgdata_entries() {
        let root = unique_temp_root("liboliphaunt-backup-symlink-entry");
        let pgdata = root.join("pgdata");
        fs::create_dir_all(pgdata.join("pg_tblspc")).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();
        std::os::unix::fs::symlink(
            root.join("external-tablespace"),
            pgdata.join("pg_tblspc/16384"),
        )
        .unwrap();

        let mut calls = 0usize;
        let error = physical_archive_backup(&pgdata, |request| {
            calls += 1;
            let sql = String::from_utf8_lossy(request.as_bytes());
            if sql.contains("pg_backup_stop") {
                Ok(stop_backup_response())
            } else {
                Ok(ProtocolResponse::new(Vec::new()))
            }
        })
        .unwrap_err();

        assert!(
            error.to_string().contains("symlinked PGDATA entry"),
            "unexpected backup symlink error: {error}"
        );
        assert!(
            calls >= 2,
            "backup failure should still attempt to leave PostgreSQL backup mode"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn physical_archive_rejects_non_regular_pgdata_entries() {
        let root = unique_short_temp_root("lp-bu-sock");
        let pgdata = root.join("pgdata");
        fs::create_dir_all(pgdata.join("base")).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();
        let socket_path = pgdata.join("base/socket-entry");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();

        let mut calls = 0usize;
        let error = physical_archive_backup(&pgdata, |request| {
            calls += 1;
            let sql = String::from_utf8_lossy(request.as_bytes());
            if sql.contains("pg_backup_stop") {
                Ok(stop_backup_response())
            } else {
                Ok(ProtocolResponse::new(Vec::new()))
            }
        })
        .unwrap_err();

        assert!(
            error.to_string().contains("non-regular PGDATA entry"),
            "unexpected backup non-regular-entry error: {error}"
        );
        assert!(
            calls >= 2,
            "backup failure should still attempt to leave PostgreSQL backup mode"
        );
        drop(listener);
        let _ = fs::remove_dir_all(root);
    }

    fn archive_with_link_entry(entry_type: EntryType) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            let mut header = Header::new_gnu();
            header.set_entry_type(entry_type);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            archive
                .append_link(&mut header, "pgdata/base/link-entry", "pgdata/PG_VERSION")
                .unwrap();
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_special_entry(entry_type: EntryType) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            let mut header = Header::new_gnu();
            header.set_entry_type(entry_type);
            header.set_size(0);
            header.set_mode(0o600);
            header.set_cksum();
            archive
                .append_data(&mut header, "pgdata/base/special-entry", Cursor::new([]))
                .unwrap();
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_nonzero_directory_entry() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::dir());
            header.set_size(1);
            header.set_mode(0o700);
            header.set_cksum();
            archive
                .append_data(&mut header, "pgdata/base/nonzero-dir", Cursor::new([b'x']))
                .unwrap();
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_regular_file_link_metadata() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::file());
            header.set_size(0);
            header.set_mode(0o600);
            header.set_link_name("pgdata/PG_VERSION").unwrap();
            header.set_cksum();
            archive
                .append_data(
                    &mut header,
                    "pgdata/base/regular-link-metadata",
                    Cursor::new([]),
                )
                .unwrap();
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_invalid_header_checksum() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            archive.finish().unwrap();
        }
        assert!(bytes.len() >= 512, "test archive must contain a tar header");
        bytes[148] = if bytes[148] == b'0' { b'1' } else { b'0' };
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_invalid_checksum_field() -> BackupArtifact {
        let mut artifact = valid_test_archive();
        assert!(
            artifact.bytes.len() >= 512,
            "test archive must contain a tar header"
        );
        artifact.bytes[148] = b'x';
        artifact
    }

    fn archive_with_invalid_header_magic() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            archive.finish().unwrap();
        }
        assert!(bytes.len() >= 512, "test archive must contain a tar header");
        bytes[257] = if bytes[257] == b'u' { b'x' } else { b'u' };
        rewrite_tar_checksum(&mut bytes[..512]);
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_invalid_numeric_header_field(field_offset: usize) -> BackupArtifact {
        let mut artifact = valid_test_archive();
        assert!(
            artifact.bytes.len() >= 512,
            "test archive must contain a tar header"
        );
        artifact.bytes[field_offset] = b'x';
        rewrite_tar_checksum(&mut artifact.bytes[..512]);
        artifact
    }

    fn archive_with_invalid_string_header_field(field_offset: usize) -> BackupArtifact {
        let mut artifact = valid_test_archive();
        assert!(
            artifact.bytes.len() >= 512,
            "test archive must contain a tar header"
        );
        artifact.bytes[field_offset] = b'x';
        rewrite_tar_checksum(&mut artifact.bytes[..512]);
        artifact
    }

    fn archive_with_truncated_terminator() -> BackupArtifact {
        let mut artifact = valid_test_archive();
        let len = artifact.bytes.len();
        artifact.bytes.truncate(len - 512);
        artifact
    }

    fn archive_with_trailing_data_after_terminator() -> BackupArtifact {
        let valid = valid_test_archive();
        let len = valid.bytes.len();
        let mut bytes = Vec::with_capacity(len + 1024);
        bytes.extend_from_slice(&valid.bytes[..len - 512]);
        bytes.extend_from_slice(&[b'x'; 512]);
        bytes.extend_from_slice(&valid.bytes[len - 512..]);
        bytes.extend_from_slice(&[0; 512]);
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn valid_test_archive() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_root_manifest(manifest: &'static [u8]) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            append_test_file(&mut archive, NATIVE_ROOT_MANIFEST_FILE, manifest);
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_backup_manifest(manifest: &'static [u8]) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            append_test_file(&mut archive, PHYSICAL_ARCHIVE_MANIFEST_PATH, manifest);
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_canonicalized_required_path() -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_test_file(&mut archive, "pgdata/PG_VERSION", b"18\n");
            append_test_file(&mut archive, "pgdata/./global/pg_control", b"control");
            append_test_file(&mut archive, "pgdata/backup_label", b"label");
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_duplicate_entry(path: &str) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            append_test_file(&mut archive, path, b"duplicate");
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn archive_with_file_tree_collision(parent_first: bool) -> BackupArtifact {
        let mut bytes = Vec::new();
        {
            let mut archive = Builder::new(&mut bytes);
            append_required_test_files(&mut archive);
            if parent_first {
                append_test_file(&mut archive, "pgdata/base", b"parent-file");
                append_test_file(&mut archive, "pgdata/base/child", b"child-file");
            } else {
                append_test_file(&mut archive, "pgdata/base/child", b"child-file");
                append_test_file(&mut archive, "pgdata/base", b"parent-file");
            }
            archive.finish().unwrap();
        }
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes,
        }
    }

    fn rewrite_tar_checksum(header: &mut [u8]) {
        assert!(
            header.len() >= 512,
            "test archive header must be at least one tar block"
        );
        header[148..156].fill(b' ');
        let checksum = header[..512]
            .iter()
            .fold(0_u32, |sum, byte| sum + u32::from(*byte));
        let encoded = format!("{checksum:06o}");
        header[148..154].copy_from_slice(encoded.as_bytes());
        header[154] = 0;
        header[155] = b' ';
    }

    fn append_required_test_files(archive: &mut Builder<&mut Vec<u8>>) {
        append_test_file(archive, "pgdata/PG_VERSION", b"18\n");
        append_test_file(archive, "pgdata/global/pg_control", b"control");
        append_test_file(archive, "pgdata/backup_label", b"label");
    }

    fn append_test_file(archive: &mut Builder<&mut Vec<u8>>, path: &str, bytes: &'static [u8]) {
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive
            .append_data(&mut header, path, Cursor::new(bytes))
            .unwrap();
    }

    fn stop_backup_response() -> ProtocolResponse {
        let label = b"START WAL LOCATION: 0/1\n";
        let mut row = Vec::new();
        row.extend_from_slice(&2_i16.to_be_bytes());
        row.extend_from_slice(&(label.len() as i32).to_be_bytes());
        row.extend_from_slice(label);
        row.extend_from_slice(&(-1_i32).to_be_bytes());
        ProtocolResponse::new(protocol_frame(b'D', &row))
    }

    fn metadata_response() -> ProtocolResponse {
        let columns = ["180000", "UTF8", "C", "C", "off", "", "plpgsql,vector"];
        let mut row = Vec::new();
        row.extend_from_slice(&(columns.len() as i16).to_be_bytes());
        for column in columns {
            row.extend_from_slice(&(column.len() as i32).to_be_bytes());
            row.extend_from_slice(column.as_bytes());
        }
        ProtocolResponse::new(protocol_frame(b'D', &row))
    }

    fn protocol_frame(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(1 + 4 + body.len());
        frame.push(tag);
        frame.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        frame.extend_from_slice(body);
        frame
    }

    fn unique_temp_root(prefix: &str) -> PathBuf {
        let parent = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        for attempt in 0..100_u32 {
            let path = parent.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
            if !path.exists() {
                return path;
            }
        }
        panic!("failed to allocate temp root for {prefix}");
    }

    #[cfg(unix)]
    fn unique_short_temp_root(prefix: &str) -> PathBuf {
        let parent = Path::new("/tmp");
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        for attempt in 0..100_u32 {
            let path = parent.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
            if !path.exists() {
                return path;
            }
        }
        panic!("failed to allocate short temp root for {prefix}");
    }
}
