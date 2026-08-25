use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::error::{Error, Result};

pub(super) const ROOT_DESCRIPTOR_FILE: &str = ".oliphaunt.json";
const ROOT_POSTGRES_MAJOR: &str = "18";
const NATIVE_ROOT_DESCRIPTOR: &str = "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootDescriptor {
    schema: String,
    engine_family: String,
    pgdata: String,
    postgres_major: u32,
    physical_format: String,
}

/// Classify a managed root before any PGDATA mutation.
pub(super) fn validate_root_for_open(root: &Path) -> Result<bool> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|err| Error::Engine(format!("inspect native root {}: {err}", root.display())))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(Error::Engine(format!(
            "native root {} must be a real directory",
            root.display()
        )));
    }
    let entries = fs::read_dir(root)
        .map_err(|err| Error::Engine(format!("inspect native root {}: {err}", root.display())))?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|err| Error::Engine(format!("inspect native root {}: {err}", root.display())))?;
    if entries.is_empty() {
        return Ok(false);
    }

    let descriptor_path = root.join(ROOT_DESCRIPTOR_FILE);
    if !entries.iter().any(|name| name == ROOT_DESCRIPTOR_FILE) {
        return Err(Error::Engine(format!(
            "native root {} is nonempty but has no {ROOT_DESCRIPTOR_FILE} descriptor",
            root.display()
        )));
    }
    if entries
        .iter()
        .any(|name| name != ROOT_DESCRIPTOR_FILE && name != "pgdata")
    {
        return Err(Error::Engine(format!(
            "native root {} contains files outside the managed descriptor and pgdata directory",
            root.display()
        )));
    }

    validate_descriptor_file(&descriptor_path)?;
    let pgdata = root.join("pgdata");
    let metadata = fs::symlink_metadata(&pgdata).map_err(|err| {
        Error::Engine(format!("inspect native PGDATA {}: {err}", pgdata.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Engine(format!(
            "native PGDATA {} is not a regular directory",
            pgdata.display()
        )));
    }
    validate_pgdata_version(&pgdata)?;
    Ok(true)
}

pub(super) fn validate_existing_root(root: &Path) -> Result<()> {
    if validate_root_for_open(root)? {
        Ok(())
    } else {
        Err(Error::Engine(format!(
            "native root {} has not been initialized",
            root.display()
        )))
    }
}

pub(super) fn publish_native_root_descriptor(root: &Path) -> Result<()> {
    validate_pgdata_version(&root.join("pgdata"))?;
    let descriptor_path = root.join(ROOT_DESCRIPTOR_FILE);
    let staging = root.join(format!(
        "{ROOT_DESCRIPTOR_FILE}.tmp-{}-{}",
        std::process::id(),
        temporary_file_nonce()?
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .map_err(|err| {
                Error::Engine(format!(
                    "create root descriptor {}: {err}",
                    staging.display()
                ))
            })?;
        file.write_all(NATIVE_ROOT_DESCRIPTOR.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|err| {
                Error::Engine(format!(
                    "write root descriptor {}: {err}",
                    staging.display()
                ))
            })?;
        publish_descriptor(&staging, &descriptor_path).map_err(|err| {
            Error::Engine(format!(
                "publish root descriptor {}: {err}",
                descriptor_path.display()
            ))
        })?;
        sync_directory(root)
    })();
    if let Err(error) = result {
        return match fs::remove_file(&staging) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(Error::Engine(format!(
                "{error}; additionally failed to remove staged root descriptor {}: {cleanup}",
                staging.display()
            ))),
        };
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_descriptor(staging: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(staging, destination)
}

#[cfg(windows)]
fn publish_descriptor(staging: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let staging = staging
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            staging.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn validate_descriptor_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|err| {
        Error::Engine(format!("inspect root descriptor {}: {err}", path.display()))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Engine(format!(
            "root descriptor {} is not a regular file",
            path.display()
        )));
    }
    let text = fs::read_to_string(path)
        .map_err(|err| Error::Engine(format!("read root descriptor {}: {err}", path.display())))?;
    let descriptor: RootDescriptor = serde_json::from_str(&text).map_err(|err| {
        Error::Engine(format!(
            "root descriptor {} is invalid: {err}",
            path.display()
        ))
    })?;
    let family_format = match descriptor.engine_family.as_str() {
        "native" => "native-pg18-v1",
        "wasix" => "wasix-pg18-v1",
        _ => "",
    };
    if descriptor.schema != "oliphaunt-database-root-v1"
        || descriptor.pgdata != "pgdata"
        || descriptor.postgres_major != 18
        || descriptor.physical_format != family_format
    {
        return Err(Error::Engine(format!(
            "root descriptor {} is unsupported",
            path.display()
        )));
    }
    Ok(())
}

fn validate_pgdata_version(pgdata: &Path) -> Result<()> {
    let path = pgdata.join("PG_VERSION");
    require_regular_file(&path, false)?;
    let version = fs::read_to_string(&path).map_err(|err| {
        Error::Engine(format!(
            "read native PGDATA version {}: {err}",
            path.display()
        ))
    })?;
    if version.trim() != ROOT_POSTGRES_MAJOR {
        return Err(Error::Engine(format!(
            "native root contains PostgreSQL {} PGDATA; oliphaunt supports PostgreSQL {ROOT_POSTGRES_MAJOR}",
            version.trim()
        )));
    }
    require_real_directory(&pgdata.join("global"), "global")?;
    require_regular_file(&pgdata.join("global").join("pg_control"), true)?;
    require_real_directory(&pgdata.join("pg_wal"), "pg_wal")?;
    Ok(())
}

fn require_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|err| {
        Error::Engine(format!("inspect native {label} {}: {err}", path.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Engine(format!(
            "native {label} {} must be a real directory",
            path.display()
        )));
    }
    Ok(())
}

fn require_regular_file(path: &Path, nonempty: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|err| {
        Error::Engine(format!(
            "inspect native PGDATA file {}: {err}",
            path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || (nonempty && metadata.len() == 0)
    {
        return Err(Error::Engine(format!(
            "native PGDATA file {} must be a{} regular file",
            path.display(),
            if nonempty { " nonempty" } else { "" }
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| Error::Engine(format!("sync native root {}: {err}", path.display())))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn temporary_file_nonce() -> Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_database_root_descriptors_define_the_native_contract() {
        let source =
            crate::test_fixtures::text("storage/database-root.json", "testdata/database-root.json");
        let fixture: serde_json::Value = serde_json::from_str(&source).unwrap();
        assert_eq!(fixture["descriptor"], ROOT_DESCRIPTOR_FILE);
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-root-descriptor-test-{}-{}",
            std::process::id(),
            temporary_file_nonce().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let descriptor = root.join(ROOT_DESCRIPTOR_FILE);

        for value in fixture["validDescriptors"].as_array().unwrap() {
            fs::write(&descriptor, serde_json::to_vec(value).unwrap()).unwrap();
            validate_descriptor_file(&descriptor).unwrap();
        }
        for case in fixture["invalidDescriptors"].as_array().unwrap() {
            fs::write(&descriptor, serde_json::to_vec(&case["value"]).unwrap()).unwrap();
            assert!(
                validate_descriptor_file(&descriptor).is_err(),
                "accepted invalid descriptor {}",
                case["case"]
            );
        }
        for case in fixture["malformedJson"].as_array().unwrap() {
            fs::write(&descriptor, case["value"].as_str().unwrap()).unwrap();
            assert!(
                validate_descriptor_file(&descriptor).is_err(),
                "accepted malformed descriptor {}",
                case["case"]
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
