use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use super::assets;
use crate::{StorageCommitState, StorageErrorCode, StorageErrorPhase};

pub(crate) const DESCRIPTOR_FILE: &str = ".oliphaunt.json";
pub(crate) const PGDATA_DIRECTORY: &str = "pgdata";
const DESCRIPTOR_SCHEMA: &str = "oliphaunt-database-root-v1";
pub(crate) use liboliphaunt_wasix_portable::{PHYSICAL_FORMAT, POSTGRES_MAJOR};
const DESCRIPTOR_WRITE_TEMP_PREFIX: &str = ".oliphaunt.json.oliphaunt-write-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectoryState {
    New,
    Existing,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct DatabaseRootDescriptor {
    schema: String,
    engine_family: String,
    pgdata: String,
    postgres_major: u32,
    physical_format: String,
}

pub(crate) fn inspect_directory_root(root: &Path) -> Result<DirectoryState> {
    let mut has_descriptor = false;
    let mut has_pgdata = false;
    let mut unexpected = None;

    for entry in fs::read_dir(root)
        .with_context(|| format!("read database root {}", root.display()))
        .map_err(open_unavailable)?
    {
        let entry = entry.map_err(|error| open_unavailable(error.into()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        match name.as_ref() {
            DESCRIPTOR_FILE => has_descriptor = true,
            PGDATA_DIRECTORY => has_pgdata = true,
            _ => unexpected = Some(name.into_owned()),
        }
    }

    if let Some(name) = unexpected {
        return Err(open_storage_message(
            format!(
                "database root {} contains unexpected entry {name:?}",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    match (has_descriptor, has_pgdata) {
        (false, false) => Ok(DirectoryState::New),
        (true, false) => Err(open_storage_message(
            format!(
                "database root {} contains {DESCRIPTOR_FILE} without {PGDATA_DIRECTORY}",
                root.display()
            ),
            StorageErrorCode::Incomplete,
        )),
        (false, true) => Err(open_storage_message(
            format!(
                "database root {} contains PGDATA without {DESCRIPTOR_FILE}; refusing to adopt unverified data",
                root.display()
            ),
            StorageErrorCode::Incomplete,
        )),
        (true, true) => {
            read_validated_directory(root)?;
            Ok(DirectoryState::Existing)
        }
    }
}

fn read_validated_directory(root: &Path) -> Result<DatabaseRootDescriptor> {
    let pgdata = root.join(PGDATA_DIRECTORY);
    let metadata = required_open_metadata(&pgdata, "PGDATA")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe pgdata entry",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    let descriptor = read_descriptor(root)?;
    validate_descriptor(root, &descriptor)?;
    validate_complete_pgdata(root, &pgdata)?;
    Ok(descriptor)
}

fn validate_descriptor(root: &Path, descriptor: &DatabaseRootDescriptor) -> Result<()> {
    if !(descriptor.schema == DESCRIPTOR_SCHEMA
        && descriptor.pgdata == PGDATA_DIRECTORY
        && descriptor.postgres_major == POSTGRES_MAJOR
        && matches!(
            (
                descriptor.engine_family.as_str(),
                descriptor.physical_format.as_str()
            ),
            ("native", "native-pg18-v1") | ("wasix", PHYSICAL_FORMAT)
        ))
    {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsupported database-root descriptor",
                root.display()
            ),
            StorageErrorCode::Incompatible,
        ));
    }
    Ok(())
}

fn validate_complete_pgdata(root: &Path, pgdata: &Path) -> Result<()> {
    let pg_version = pgdata.join("PG_VERSION");
    let version_metadata = required_open_metadata(&pg_version, "PG_VERSION")?;
    if !version_metadata.is_file() || version_metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe or incomplete PG_VERSION",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    let version = fs::read(&pg_version)
        .with_context(|| format!("read {}", pg_version.display()))
        .map_err(open_unavailable)?;
    let version = std::str::from_utf8(&version).map_err(|error| {
        open_storage_message(
            format!(
                "database root {} has a non-UTF-8 PG_VERSION: {error}",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        )
    })?;
    if version.trim() != POSTGRES_MAJOR.to_string() {
        return Err(open_storage_message(
            format!(
                "database root {} has PostgreSQL {}, expected {POSTGRES_MAJOR}",
                root.display(),
                version.trim()
            ),
            StorageErrorCode::Incompatible,
        ));
    }

    let global = pgdata.join("global");
    let global_metadata = required_open_metadata(&global, "global directory")?;
    if !global_metadata.is_dir() || global_metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe or incomplete global directory",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    let control = global.join("pg_control");
    let control_metadata = required_open_metadata(&control, "global/pg_control")?;
    if !control_metadata.is_file() || control_metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe global/pg_control",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    if control_metadata.len() == 0 {
        return Err(open_storage_message(
            format!(
                "database root {} has an incomplete global/pg_control",
                root.display()
            ),
            StorageErrorCode::Incomplete,
        ));
    }

    let pg_wal = pgdata.join("pg_wal");
    let wal_metadata = required_open_metadata(&pg_wal, "pg_wal")?;
    if !wal_metadata.is_dir() || wal_metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe or incomplete pg_wal",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    Ok(())
}

fn required_open_metadata(path: &Path, label: &str) -> Result<fs::Metadata> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(open_storage_message(
            format!(
                "managed database is missing required {label} at {}",
                path.display()
            ),
            StorageErrorCode::Incomplete,
        )),
        Err(error) => Err(open_unavailable(
            anyhow::Error::new(error).context(format!("inspect {}", path.display())),
        )),
    }
}

fn open_storage_message(message: String, code: StorageErrorCode) -> anyhow::Error {
    crate::error::storage_message(
        message,
        code,
        StorageCommitState::Unchanged,
        StorageErrorPhase::Open,
    )
}

fn open_unavailable(error: anyhow::Error) -> anyhow::Error {
    crate::error::storage_error(
        error,
        StorageErrorCode::Unavailable,
        StorageCommitState::Unchanged,
        StorageErrorPhase::Open,
    )
}

pub(crate) fn write_database_root_descriptor(root: &Path) -> Result<()> {
    let descriptor = DatabaseRootDescriptor {
        schema: DESCRIPTOR_SCHEMA.to_owned(),
        engine_family: "wasix".to_owned(),
        pgdata: PGDATA_DIRECTORY.to_owned(),
        postgres_major: current_postgres_major()?,
        physical_format: PHYSICAL_FORMAT.to_owned(),
    };
    let bytes = serde_json::to_vec(&descriptor)?;
    let target = root.join(DESCRIPTOR_FILE);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = root.join(format!("{DESCRIPTOR_WRITE_TEMP_PREFIX}{nonce}"));
    let result = (|| -> Result<()> {
        let mut file = open_private_descriptor(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &target).with_context(|| format!("publish {}", target.display()))?;
        sync_directory(root)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn open_private_descriptor(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_private_descriptor(path: &Path) -> std::io::Result<fs::File> {
    OpenOptions::new().create_new(true).write(true).open(path)
}

fn read_descriptor(root: &Path) -> Result<DatabaseRootDescriptor> {
    let path = root.join(DESCRIPTOR_FILE);
    let metadata = required_open_metadata(&path, DESCRIPTOR_FILE)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(open_storage_message(
            format!(
                "database root {} has an unsafe {DESCRIPTOR_FILE} entry",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        ));
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("read {}", path.display()))
        .map_err(open_unavailable)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        open_storage_message(
            format!(
                "database root {} has a malformed {DESCRIPTOR_FILE}: {error}",
                root.display()
            ),
            StorageErrorCode::Corrupt,
        )
    })
}

fn current_postgres_major() -> Result<u32> {
    if !liboliphaunt_wasix_portable::HAS_EMBEDDED_ASSETS {
        return Ok(POSTGRES_MAJOR);
    }
    let metadata = assets::asset_manifest_metadata()?;
    let postgres_major = metadata
        .postgres_version
        .trim()
        .split('.')
        .next()
        .context("WASIX runtime PostgreSQL version is unavailable")?
        .parse::<u32>()
        .context("WASIX runtime PostgreSQL major is invalid")?;
    ensure!(
        postgres_major == POSTGRES_MAJOR,
        "WASIX physical format {PHYSICAL_FORMAT} requires PostgreSQL {POSTGRES_MAJOR}"
    );
    Ok(postgres_major)
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) -> Result<()> {
    // Directory fsync is not portable off Unix. On Windows, flushing a
    // directory handle fails with ERROR_ACCESS_DENIED even though regular file
    // contents have already been flushed.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn managed_layout_matches_runtime_contract() -> Result<()> {
        let fixture_text = crate::oliphaunt::test_fixtures::text(
            "storage/database-root.json",
            "database-root.json",
        );
        let fixture: serde_json::Value = serde_json::from_str(&fixture_text)?;
        assert_eq!(fixture["descriptor"], DESCRIPTOR_FILE);
        assert_eq!(fixture["schema"], DESCRIPTOR_SCHEMA);
        assert_eq!(fixture["pgdata"], PGDATA_DIRECTORY);
        assert_eq!(fixture["postgresMajor"], POSTGRES_MAJOR);
        assert_eq!(
            fixture["families"]["native"]["physicalFormat"],
            "native-pg18-v1"
        );
        assert_eq!(
            fixture["families"]["wasix"]["physicalFormat"],
            PHYSICAL_FORMAT
        );
        Ok(())
    }

    #[test]
    fn shared_invalid_and_malformed_descriptors_are_rejected() -> Result<()> {
        let fixture_text = crate::oliphaunt::test_fixtures::text(
            "storage/database-root.json",
            "database-root.json",
        );
        let fixture: serde_json::Value = serde_json::from_str(&fixture_text)?;
        let root = TempDir::new()?;
        let descriptor = root.path().join(DESCRIPTOR_FILE);
        for case in fixture["invalidDescriptors"].as_array().unwrap() {
            fs::write(&descriptor, serde_json::to_vec(&case["value"])?)?;
            let result = read_descriptor(root.path())
                .and_then(|parsed| validate_descriptor(root.path(), &parsed));
            assert!(
                result.is_err(),
                "accepted invalid descriptor {}",
                case["case"]
            );
        }
        for case in fixture["malformedJson"].as_array().unwrap() {
            fs::write(&descriptor, case["value"].as_str().unwrap())?;
            assert!(
                read_descriptor(root.path()).is_err(),
                "accepted malformed descriptor {}",
                case["case"]
            );
        }
        Ok(())
    }

    #[test]
    fn raw_pgdata_is_an_unexpected_managed_root_entry() -> Result<()> {
        let root = TempDir::new()?;
        fs::write(root.path().join("PG_VERSION"), b"18\n")?;
        let error = inspect_directory_root(root.path()).expect_err("raw PGDATA must be rejected");
        assert!(format!("{error:#}").contains("unexpected entry"));
        Ok(())
    }

    #[test]
    fn native_managed_root_is_outside_cross_family_validation() -> Result<()> {
        let root = TempDir::new()?;
        let native = DatabaseRootDescriptor {
            schema: DESCRIPTOR_SCHEMA.to_owned(),
            engine_family: "native".to_owned(),
            pgdata: PGDATA_DIRECTORY.to_owned(),
            postgres_major: POSTGRES_MAJOR,
            physical_format: "native-pg18-v1".to_owned(),
        };
        fs::write(
            root.path().join(DESCRIPTOR_FILE),
            serde_json::to_vec(&native)?,
        )?;
        write_complete_pgdata(root.path())?;
        assert_eq!(
            inspect_directory_root(root.path())?,
            DirectoryState::Existing
        );
        Ok(())
    }

    #[test]
    fn non_file_descriptor_is_rejected() -> Result<()> {
        let root = TempDir::new()?;
        fs::create_dir(root.path().join(DESCRIPTOR_FILE))?;
        fs::create_dir(root.path().join(PGDATA_DIRECTORY))?;
        let error = inspect_directory_root(root.path())
            .expect_err("non-file WASIX descriptor must be rejected");
        assert!(
            format!("{error:#}").contains("unsafe .oliphaunt.json entry"),
            "{error:#}"
        );
        Ok(())
    }

    #[test]
    fn incomplete_existing_pgdata_is_rejected_without_mutation() -> Result<()> {
        let root = TempDir::new()?;
        let descriptor = DatabaseRootDescriptor {
            schema: DESCRIPTOR_SCHEMA.to_owned(),
            engine_family: "wasix".to_owned(),
            pgdata: PGDATA_DIRECTORY.to_owned(),
            postgres_major: POSTGRES_MAJOR,
            physical_format: PHYSICAL_FORMAT.to_owned(),
        };
        fs::write(
            root.path().join(DESCRIPTOR_FILE),
            serde_json::to_vec(&descriptor)?,
        )?;
        fs::create_dir(root.path().join(PGDATA_DIRECTORY))?;
        fs::write(root.path().join(PGDATA_DIRECTORY).join("sentinel"), b"keep")?;

        let error = inspect_directory_root(root.path()).expect_err("incomplete PGDATA must fail");

        assert!(format!("{error:#}").contains("PG_VERSION"), "{error:#}");
        let error = crate::Error::from_anyhow(error);
        let details = error
            .storage_error()
            .expect("incomplete PGDATA must remain structurally tagged");
        assert_eq!(details.code(), StorageErrorCode::Incomplete);
        assert_eq!(details.commit_state(), StorageCommitState::Unchanged);
        assert_eq!(details.phase(), StorageErrorPhase::Open);
        assert_eq!(
            fs::read(root.path().join(PGDATA_DIRECTORY).join("sentinel"))?,
            b"keep"
        );
        Ok(())
    }

    fn write_complete_pgdata(root: &Path) -> Result<()> {
        let pgdata = root.join(PGDATA_DIRECTORY);
        fs::create_dir_all(pgdata.join("global"))?;
        fs::create_dir(pgdata.join("pg_wal"))?;
        fs::write(pgdata.join("PG_VERSION"), b"18\n")?;
        fs::write(pgdata.join("global/pg_control"), b"control")?;
        Ok(())
    }

    #[test]
    fn physical_format_must_match() -> Result<()> {
        let root = TempDir::new()?;
        fs::create_dir(root.path().join(PGDATA_DIRECTORY))?;
        let descriptor = DatabaseRootDescriptor {
            schema: DESCRIPTOR_SCHEMA.to_owned(),
            engine_family: "wasix".to_owned(),
            pgdata: PGDATA_DIRECTORY.to_owned(),
            postgres_major: POSTGRES_MAJOR,
            physical_format: "wasix-pg18-v2".to_owned(),
        };
        fs::write(
            root.path().join(DESCRIPTOR_FILE),
            serde_json::to_vec(&descriptor)?,
        )?;

        let error = inspect_directory_root(root.path())
            .expect_err("different physical format must be rejected");
        assert!(
            format!("{error:#}").contains("unsupported database-root descriptor"),
            "{error:#}"
        );
        let error = crate::Error::from_anyhow(error);
        let details = error
            .storage_error()
            .expect("incompatible root must remain structurally tagged");
        assert_eq!(details.code(), StorageErrorCode::Incompatible);
        assert_eq!(details.commit_state(), StorageCommitState::Unchanged);
        assert_eq!(details.phase(), StorageErrorPhase::Open);
        Ok(())
    }
}
