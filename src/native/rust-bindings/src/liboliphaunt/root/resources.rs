use super::NativeCatalogProfile;
use crate::{Error, NativeClusterSeed, NativeResourceDirectory, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

const MAX_RESOURCE_BYTES: u64 = 1024 * 1024 * 1024;

fn resource_error(error: impl std::fmt::Display) -> Error {
    Error::InvalidConfig(format!("invalid native resource: {error}"))
}

pub(super) fn logical_tree_sha256(root: &Path) -> Result<String> {
    fn visit(root: &Path, path: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
        let metadata = fs::symlink_metadata(path).map_err(resource_error)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error("resource contains a symbolic link"));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(resource_error)? {
                visit(root, &entry.map_err(resource_error)?.path(), files)?;
            }
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(resource_error)?;
            let relative = relative
                .to_str()
                .ok_or_else(|| resource_error("resource path is not UTF-8"))?
                .replace('\\', "/");
            files.push((relative, path.to_path_buf()));
            if files.len() > 8192 {
                return Err(resource_error("too many resource files"));
            }
        } else {
            return Err(resource_error("resource contains a special file"));
        }
        Ok(())
    }
    if !fs::symlink_metadata(root).map_err(resource_error)?.is_dir() {
        return Err(resource_error("resource must be a directory"));
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    let mut total = 0;
    let mut buffer = [0_u8; 65536];
    for (relative, path) in files {
        let mut file = fs::File::open(path).map_err(resource_error)?;
        let length = file.metadata().map_err(resource_error)?.len();
        total += length;
        if total > MAX_RESOURCE_BYTES {
            return Err(resource_error("resource exceeds 1 GiB"));
        }
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(length.to_string().as_bytes());
        digest.update([0]);
        loop {
            let read = file.read(&mut buffer).map_err(resource_error)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        digest.update(b"\n");
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(in crate::liboliphaunt) fn validate_icu_data(
    resource: &NativeResourceDirectory,
) -> Result<String> {
    let text = fs::read_to_string(&resource.manifest).map_err(resource_error)?;
    let mut fields = std::collections::BTreeMap::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| resource_error("invalid ICU manifest property"))?;
        if fields.insert(key, value).is_some() {
            return Err(resource_error("duplicate ICU manifest property"));
        }
    }
    if fields.len() != 5
        || fields.get("schema") != Some(&"oliphaunt-icu-data-v1")
        || fields.get("artifactRole") != Some(&"icu-data")
        || fields.get("icuDataVersion") != Some(&"76.1")
        || fields.get("icuDataForm") != Some(&"files-le")
    {
        return Err(resource_error("incompatible ICU manifest"));
    }
    let digest = logical_tree_sha256(&resource.directory)?;
    if fields.get("icuDataTreeSha256") != Some(&digest.as_str()) {
        return Err(resource_error("ICU data does not match its manifest"));
    }
    Ok(digest)
}

pub(super) enum ValidatedSeed<'a> {
    Archive(Vec<u8>),
    Directory(&'a Path, Vec<PathBuf>),
}

pub(super) fn validate_seed<'a>(
    seed: &'a NativeClusterSeed,
    profile: NativeCatalogProfile,
    icu_hash: Option<&str>,
) -> Result<ValidatedSeed<'a>> {
    let manifest_bytes = match seed {
        NativeClusterSeed::Archive { manifest, .. } => manifest.to_vec(),
        NativeClusterSeed::Directory(resource) => {
            fs::read(&resource.manifest).map_err(resource_error)?
        }
    };
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).map_err(resource_error)?;
    let target = super::runtime::native_host_target_id()
        .ok_or_else(|| resource_error("unsupported native seed target"))?;
    let runtime = &manifest["runtime"];
    if manifest["schema"] != "oliphaunt-cluster-seed-v1"
        || manifest["catalogProfile"] != profile.id()
        || manifest["artifactRole"] != format!("cluster-seed-{}", profile.id())
        || runtime["product"] != "liboliphaunt-native"
        || runtime["engineFamily"] != "native"
        || runtime["target"] != target
        || runtime["postgresMajor"] != 18
        || runtime["physicalFormat"] != "native-pg18-v1"
        || runtime["compatibilityKey"] != format!("native-pg18-{target}-v1")
    {
        return Err(resource_error(
            "seed has incompatible runtime, physical format, target or catalog profile",
        ));
    }
    match profile {
        NativeCatalogProfile::Icu
            if icu_hash.is_some()
                && manifest["icu"]["dataVersion"] == "76.1"
                && manifest["icu"]["dataForm"] == "files-le"
                && manifest["icu"]["dataTreeSha256"].as_str() == icu_hash => {}
        NativeCatalogProfile::Standard if manifest["icu"].is_null() && icu_hash.is_none() => {}
        _ => {
            return Err(resource_error(
                "seed requires matching explicitly selected ICU data",
            ));
        }
    }
    match seed {
        NativeClusterSeed::Directory(resource) => {
            let relative = manifest["directory"]["path"]
                .as_str()
                .ok_or_else(|| resource_error("seed directory manifest is missing"))?;
            let expected_path = resource
                .manifest
                .parent()
                .unwrap_or(Path::new("."))
                .join(relative);
            if fs::canonicalize(expected_path).map_err(resource_error)?
                != fs::canonicalize(&resource.directory).map_err(resource_error)?
                || manifest["directory"]["treeSha256"] != logical_tree_sha256(&resource.directory)?
            {
                return Err(resource_error("seed directory does not match its manifest"));
            }
            if fs::read_to_string(resource.directory.join("PG_VERSION"))
                .map_err(resource_error)?
                .trim()
                != "18"
                || !resource.directory.join("global/pg_control").is_file()
            {
                return Err(resource_error("seed lacks PostgreSQL control files"));
            }
            let inventory = manifest["directory"]["emptyDirectories"]
                .as_array()
                .ok_or_else(|| resource_error("seed lacks an empty-directory inventory"))?;
            if inventory.len() > 8192 {
                return Err(resource_error("too many seed directories"));
            }
            let mut directories = std::collections::BTreeSet::new();
            for value in inventory {
                let name = value
                    .as_str()
                    .ok_or_else(|| resource_error("invalid seed directory path"))?;
                if name.contains(['\\', ':', '\0'])
                    || name
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                {
                    return Err(resource_error("unsafe seed directory path"));
                }
                let relative = PathBuf::from(name);
                if !directories.insert(relative.clone()) {
                    return Err(resource_error("duplicate seed directory"));
                }
                let mut parent = resource.directory.clone();
                for part in relative.components() {
                    parent.push(part.as_os_str());
                    match fs::symlink_metadata(&parent) {
                        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        _ => return Err(resource_error("seed directory overlaps a file or link")),
                    }
                }
            }
            Ok(ValidatedSeed::Directory(
                &resource.directory,
                directories.into_iter().collect(),
            ))
        }
        NativeClusterSeed::Archive { archive, .. } => {
            if archive.len() as u64 > MAX_RESOURCE_BYTES
                || manifest["archive"]["compressedBytes"].as_u64() != Some(archive.len() as u64)
                || manifest["archive"]["sha256"] != format!("{:x}", Sha256::digest(archive))
            {
                return Err(resource_error("seed archive checksum/size mismatch"));
            }
            let decoder = zstd::stream::read::Decoder::new(Cursor::new(archive.as_ref()))
                .map_err(resource_error)?;
            let mut bytes = Vec::new();
            decoder
                .take(MAX_RESOURCE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(resource_error)?;
            if bytes.len() as u64 > MAX_RESOURCE_BYTES {
                return Err(resource_error("expanded seed exceeds 1 GiB"));
            }
            let mut files = 0_u64;
            let mut expanded = 0_u64;
            let mut control = false;
            let mut version = false;
            for entry in tar::Archive::new(Cursor::new(&bytes))
                .entries()
                .map_err(resource_error)?
            {
                let mut entry = entry.map_err(resource_error)?;
                let path = entry.path().map_err(resource_error)?.into_owned();
                if path.is_absolute()
                    || path
                        .components()
                        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
                {
                    return Err(resource_error("seed archive contains an unsafe path"));
                }
                let kind = entry.header().entry_type();
                if kind.is_file() {
                    files += 1;
                    expanded += entry.size();
                    if files > 8192 || expanded > MAX_RESOURCE_BYTES {
                        return Err(resource_error("seed archive is too large"));
                    }
                    if path == Path::new("PG_VERSION") {
                        let mut value = String::new();
                        entry.read_to_string(&mut value).map_err(resource_error)?;
                        version = value.trim() == "18";
                    }
                    if path == Path::new("global/pg_control") {
                        control = entry.size() > 0;
                    }
                } else if !kind.is_dir() {
                    return Err(resource_error(
                        "seed archive contains links or special entries",
                    ));
                }
            }
            if !version
                || !control
                || manifest["archive"]["regularFiles"].as_u64() != Some(files)
                || manifest["archive"]["expandedBytes"].as_u64() != Some(expanded)
            {
                return Err(resource_error(
                    "seed archive has invalid control files or content counts",
                ));
            }
            Ok(ValidatedSeed::Archive(bytes))
        }
    }
}

pub(super) fn restore_seed(seed: ValidatedSeed<'_>, destination: &Path) -> Result<()> {
    match seed {
        ValidatedSeed::Directory(directory, empty_directories) => {
            super::files::copy_directory_tree(
                directory,
                destination,
                super::files::cluster_seed_copy_mode(),
            )?;
            for path in empty_directories {
                fs::create_dir_all(destination.join(path)).map_err(resource_error)?;
            }
        }
        ValidatedSeed::Archive(bytes) => {
            for entry in tar::Archive::new(Cursor::new(bytes))
                .entries()
                .map_err(resource_error)?
            {
                let mut entry = entry.map_err(resource_error)?;
                entry.set_preserve_permissions(false);
                if !entry.unpack_in(destination).map_err(resource_error)? {
                    return Err(resource_error("seed path escaped its destination"));
                }
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
            .map_err(resource_error)?;
    }
    super::cluster_seed::normalize_cluster_seed_conf(
        destination,
        super::cluster_seed::native_dynamic_shared_memory_type(),
    )
}
