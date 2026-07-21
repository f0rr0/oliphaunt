use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

pub(crate) const ROOT_MANIFEST_FILE: &str = "manifest.properties";
const ROOT_MANIFEST_LAYOUT: &str = "oliphaunt-root-v1";
const ROOT_MANIFEST_PRODUCT: &str = "oliphaunt";
const ROOT_POSTGRES_MAJOR: &str = "18";
const ROOT_PGDATA_RELATIVE: &str = "pgdata";
const ROOT_PGDATA_UNINITIALIZED: &str = "uninitialized";

pub(crate) fn ensure_root_manifest(root: &Path, pgdata: &Path) -> Result<()> {
    let pgdata_version = read_pgdata_version(pgdata)?;
    if let Some(version) = pgdata_version.as_deref()
        && version != ROOT_POSTGRES_MAJOR
    {
        return Err(Error::Engine(format!(
            "native root {} contains PostgreSQL {version} PGDATA; oliphaunt currently supports PostgreSQL {ROOT_POSTGRES_MAJOR} roots",
            root.display()
        )));
    }

    let manifest_path = root.join(ROOT_MANIFEST_FILE);
    let desired_manifest = root_manifest_text(pgdata_version.as_deref());
    match fs::read_to_string(&manifest_path) {
        Ok(text) => {
            validate_root_manifest_text(&manifest_path, &text, pgdata_version.as_deref())?;
            if text == desired_manifest {
                return Ok(());
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(Error::Engine(format!(
                "read native root manifest {}: {err}",
                manifest_path.display()
            )));
        }
    }

    write_root_manifest(root, desired_manifest)
}

fn read_pgdata_version(pgdata: &Path) -> Result<Option<String>> {
    let version_path = pgdata.join("PG_VERSION");
    match fs::read_to_string(&version_path) {
        Ok(text) => {
            let version = text.trim();
            if version.is_empty() {
                return Err(Error::Engine(format!(
                    "native PGDATA version file {} is empty",
                    version_path.display()
                )));
            }
            Ok(Some(version.to_owned()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(Error::Engine(format!(
            "read native PGDATA version file {}: {err}",
            version_path.display()
        ))),
    }
}

pub(crate) fn validate_root_manifest_text(
    manifest_path: &Path,
    text: &str,
    pgdata_version: Option<&str>,
) -> Result<()> {
    let properties = parse_manifest_properties(manifest_path, text)?;
    require_manifest_value(manifest_path, &properties, "layout", ROOT_MANIFEST_LAYOUT)?;
    require_manifest_value(manifest_path, &properties, "product", ROOT_MANIFEST_PRODUCT)?;
    require_manifest_value(
        manifest_path,
        &properties,
        "postgresMajor",
        ROOT_POSTGRES_MAJOR,
    )?;
    require_manifest_value(manifest_path, &properties, "pgdata", ROOT_PGDATA_RELATIVE)?;

    let manifest_pgdata_version = manifest_property(manifest_path, &properties, "pgdataVersion")?;
    match pgdata_version {
        Some(_) if manifest_pgdata_version == ROOT_PGDATA_UNINITIALIZED => Ok(()),
        Some(version) if manifest_pgdata_version == version => Ok(()),
        Some(version) => Err(Error::Engine(format!(
            "native root manifest {} declares PGDATA version '{}', but {} contains PostgreSQL {version}",
            manifest_path.display(),
            manifest_pgdata_version,
            manifest_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(ROOT_PGDATA_RELATIVE)
                .join("PG_VERSION")
                .display()
        ))),
        None if manifest_pgdata_version == ROOT_PGDATA_UNINITIALIZED => Ok(()),
        None => Err(Error::Engine(format!(
            "native root manifest {} declares initialized PGDATA version '{}', but PG_VERSION is missing",
            manifest_path.display(),
            manifest_pgdata_version
        ))),
    }
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
                "native root manifest {} line {} must use key=value syntax",
                manifest_path.display(),
                index + 1
            )));
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Err(Error::Engine(format!(
                "native root manifest {} line {} must not use empty keys or values",
                manifest_path.display(),
                index + 1
            )));
        }
        if properties
            .insert(key.to_owned(), value.to_owned())
            .is_some()
        {
            return Err(Error::Engine(format!(
                "native root manifest {} repeats key '{key}'",
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
        "native root manifest {} has {key}='{actual}', expected '{expected}'",
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
            "native root manifest {} is missing required key '{key}'",
            manifest_path.display()
        ))
    })
}

pub(crate) fn root_manifest_text(pgdata_version: Option<&str>) -> String {
    let pgdata_version = pgdata_version.unwrap_or(ROOT_PGDATA_UNINITIALIZED);
    format!(
        "layout={ROOT_MANIFEST_LAYOUT}\nproduct={ROOT_MANIFEST_PRODUCT}\npostgresMajor={ROOT_POSTGRES_MAJOR}\npgdata={ROOT_PGDATA_RELATIVE}\npgdataVersion={pgdata_version}\n"
    )
}

fn write_root_manifest(root: &Path, text: String) -> Result<()> {
    let manifest_path = root.join(ROOT_MANIFEST_FILE);
    let staging = root.join(format!(
        ".{ROOT_MANIFEST_FILE}.tmp-{}-{}",
        std::process::id(),
        temporary_file_nonce()?
    ));
    let write_result = fs::write(&staging, text)
        .map_err(|err| {
            Error::Engine(format!(
                "write native root manifest staging file {}: {err}",
                staging.display()
            ))
        })
        .and_then(|()| {
            publish_root_manifest(&staging, &manifest_path).map_err(|err| {
                Error::Engine(format!(
                    "publish native root manifest {}: {err}",
                    manifest_path.display()
                ))
            })
        });
    if write_result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    write_result
}

fn publish_root_manifest(staging: &Path, manifest_path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if manifest_path.exists() {
        fs::remove_file(manifest_path)?;
    }
    fs::rename(staging, manifest_path)
}

fn temporary_file_nonce() -> Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|err| Error::Engine(format!("system clock before epoch: {err}")))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn native_root_manifest_adopts_pg18_roots_and_rejects_incompatible_versions() {
        let root = unique_temp_root("native-root-manifest-adopt");
        let pgdata = root.join(ROOT_PGDATA_RELATIVE);
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();

        ensure_root_manifest(&root, &pgdata).unwrap();
        let manifest = fs::read_to_string(root.join(ROOT_MANIFEST_FILE)).unwrap();
        assert!(manifest.contains("layout=oliphaunt-root-v1\n"));
        assert!(manifest.contains("product=oliphaunt\n"));
        assert!(manifest.contains("postgresMajor=18\n"));
        assert!(manifest.contains("pgdata=pgdata\n"));
        assert!(manifest.contains("pgdataVersion=18\n"));

        fs::write(
            root.join(ROOT_MANIFEST_FILE),
            b"layout=oliphaunt-root-v1\nproduct=oliphaunt\npostgresMajor=17\npgdata=pgdata\npgdataVersion=18\n",
        )
        .unwrap();
        let manifest_error = ensure_root_manifest(&root, &pgdata).unwrap_err();
        assert!(
            manifest_error
                .to_string()
                .contains("postgresMajor='17', expected '18'"),
            "unexpected manifest-version error: {manifest_error}"
        );

        fs::remove_file(root.join(ROOT_MANIFEST_FILE)).unwrap();
        fs::write(pgdata.join("PG_VERSION"), b"17\n").unwrap();
        let pgdata_error = ensure_root_manifest(&root, &pgdata).unwrap_err();
        assert!(
            pgdata_error
                .to_string()
                .contains("contains PostgreSQL 17 PGDATA"),
            "unexpected PGDATA-version error: {pgdata_error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_root_manifest_tracks_uninitialized_then_initialized_pgdata() {
        let root = unique_temp_root("native-root-manifest-uninitialized");
        let pgdata = root.join(ROOT_PGDATA_RELATIVE);
        fs::create_dir_all(&pgdata).unwrap();

        ensure_root_manifest(&root, &pgdata).unwrap();
        let pending_manifest = fs::read_to_string(root.join(ROOT_MANIFEST_FILE)).unwrap();
        assert!(pending_manifest.contains("pgdataVersion=uninitialized\n"));

        fs::write(pgdata.join("PG_VERSION"), b"18\n").unwrap();
        ensure_root_manifest(&root, &pgdata).unwrap();
        let initialized_manifest = fs::read_to_string(root.join(ROOT_MANIFEST_FILE)).unwrap();
        assert!(initialized_manifest.contains("pgdataVersion=18\n"));
        assert!(!initialized_manifest.contains("pgdataVersion=uninitialized\n"));

        let _ = fs::remove_dir_all(root);
    }

    fn unique_temp_root(prefix: &str) -> PathBuf {
        let parent = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = temporary_file_nonce().unwrap();
        for attempt in 0..100_u32 {
            let path = parent.join(format!("oliphaunt-{prefix}-{pid}-{nanos}-{attempt}"));
            if fs::create_dir(&path).is_ok() {
                return path;
            }
        }
        panic!("failed to allocate a unique temp root for {prefix}");
    }
}
