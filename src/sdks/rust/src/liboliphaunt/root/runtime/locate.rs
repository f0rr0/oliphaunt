use std::path::{Path, PathBuf};

use super::super::super::ffi::{
    ENV_EMBEDDED_MODULE_DIR, ENV_INITDB, ENV_INSTALL_DIR, ENV_POSTGRES, env_path_candidates,
    resolve_library_path_candidates,
};
use crate::build_resources::registered_build_resources_dir;
use crate::error::{Error, Result};

const ENV_RESOURCES_DIR: &str = "OLIPHAUNT_RESOURCES_DIR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocatedIcuData {
    pub(super) directory: PathBuf,
    pub(super) package_resources_root: Option<PathBuf>,
    pub(super) tree_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocatedClusterSeed {
    pub(super) directory: PathBuf,
    pub(super) target: String,
    pub(super) icu_data_tree_sha256: Option<String>,
}

pub(super) fn locate_native_install_dir() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(env_path_candidates([ENV_INSTALL_DIR]));
    for path in resources_dir_candidates() {
        candidates.push(path.join("native-runtime/liboliphaunt-native/runtime"));
    }
    for env_name in [ENV_POSTGRES, ENV_INITDB] {
        if let Some(path) = std::env::var_os(env_name) {
            let path = PathBuf::from(path);
            if let Some(install_dir) = path.parent().and_then(Path::parent) {
                candidates.push(install_dir.to_path_buf());
            }
        }
    }
    for path in resolve_library_path_candidates() {
        if let Some(work_root) = path.parent().and_then(Path::parent) {
            candidates.push(work_root.join("install"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/liboliphaunt-pg18/install"));
        candidates.push(cwd.join("target/native-liboliphaunt-pg18/install"));
        if let Some(target_id) = native_host_target_id() {
            candidates.push(cwd.join(format!("target/liboliphaunt-pg18-{target_id}/install")));
        }
    }

    for candidate in candidates {
        if native_install_dir_is_valid(&candidate) {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(format!(
        "could not locate native PostgreSQL 18 install tree; set {ENV_INSTALL_DIR} or {ENV_POSTGRES}"
    )))
}

pub(super) fn locate_native_extension_artifact_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for resources_dir in resources_dir_candidates() {
        let extension_root = resources_dir.join("extension");
        let Ok(entries) = std::fs::read_dir(extension_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

pub(super) fn locate_native_embedded_modules_dir(install_dir: &Path) -> Result<PathBuf> {
    locate_native_embedded_modules_dir_from_libraries(
        install_dir,
        resolve_library_path_candidates(),
    )
}

fn locate_native_embedded_modules_dir_from_libraries(
    install_dir: &Path,
    library_paths: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(env_path_candidates([ENV_EMBEDDED_MODULE_DIR]));
    for path in library_paths {
        if let Some(out_dir) = path.parent() {
            candidates.push(out_dir.join("modules"));
        }
        if let Some(release_root) = path.parent().and_then(Path::parent) {
            candidates.push(release_root.join("lib/modules"));
        }
    }
    if let Some(work_root) = install_dir.parent() {
        candidates.push(work_root.join("out/modules"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target/liboliphaunt-pg18/out/modules"));
        candidates.push(cwd.join("target/native-liboliphaunt-pg18/out/modules"));
        if let Some(target_id) = native_host_target_id() {
            candidates.push(cwd.join(format!("target/liboliphaunt-pg18-{target_id}/out/modules")));
        }
    }

    for candidate in candidates {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    Err(Error::Engine(
        "could not locate native embedded PostgreSQL 18 module artifacts; build native liboliphaunt first"
            .to_owned(),
    ))
}

fn native_install_dir_is_valid(path: &Path) -> bool {
    native_tool_is_file(path, "postgres")
        && native_tool_is_file(path, "initdb")
        && native_tool_is_file(path, "pg_ctl")
        && path
            .join("share/postgresql/postgresql.conf.sample")
            .is_file()
        && path.join("lib/postgresql").is_dir()
}

fn native_tool_is_file(path: &Path, tool: &str) -> bool {
    path.join("bin").join(tool).is_file() || path.join("bin").join(format!("{tool}.exe")).is_file()
}

pub(super) fn resources_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = registered_build_resources_dir() {
        candidates.push(path);
    }
    if let Some(path) = std::env::var_os(ENV_RESOURCES_DIR) {
        candidates.push(PathBuf::from(path));
    }
    candidates
}

pub(super) fn locate_native_icu_data() -> Result<Option<LocatedIcuData>> {
    for resources_dir in resources_dir_candidates() {
        let directory = resources_dir.join("icu-data/oliphaunt-icu/share/icu");
        if !icu_data_dir_is_valid(&directory) {
            continue;
        }
        let receipt = resources_dir.join("icu-data/oliphaunt-icu/manifest.properties");
        let tree_sha256 = read_icu_data_receipt(&receipt)?;
        return Ok(Some(LocatedIcuData {
            directory,
            package_resources_root: Some(resources_dir),
            tree_sha256: Some(tree_sha256),
        }));
    }
    if let Some(path) = std::env::var_os("OLIPHAUNT_ICU_DATA_DIR") {
        let directory = PathBuf::from(path);
        if icu_data_dir_is_valid(&directory) {
            return Ok(Some(LocatedIcuData {
                directory,
                package_resources_root: None,
                tree_sha256: None,
            }));
        }
    }
    Ok(None)
}

pub(super) fn locate_native_cluster_seed(
    resources_dir: &Path,
    profile: super::super::NativeCatalogProfile,
) -> Result<Option<LocatedClusterSeed>> {
    let payload = resources_dir.join("native-runtime/liboliphaunt-native");
    let carrier_target = read_native_runtime_carrier(&payload.join("manifest.properties"))?;
    let relative = match profile {
        super::super::NativeCatalogProfile::Standard => "cluster-seed",
        super::super::NativeCatalogProfile::Icu => "cluster-seed-icu",
    };
    let directory = payload.join(relative);
    if !directory.is_dir() {
        return Ok(None);
    }
    let seed = parse_native_cluster_seed(&directory, profile)?;
    if seed.target != carrier_target {
        return Err(Error::Engine(format!(
            "native runtime carrier target {} does not match {} cluster seed target {}",
            carrier_target,
            profile.id(),
            seed.target
        )));
    }
    Ok(Some(seed))
}

pub(super) fn package_resources_root_for_install(install_dir: &Path) -> Option<PathBuf> {
    resources_dir_candidates()
        .into_iter()
        .find(|resources_dir| {
            paths_identical(
                install_dir,
                &resources_dir.join("native-runtime/liboliphaunt-native/runtime"),
            )
        })
}

fn parse_native_cluster_seed(
    path: &Path,
    profile: super::super::NativeCatalogProfile,
) -> Result<LocatedClusterSeed> {
    if !path.join("files/PG_VERSION").is_file() || !path.join("files/global/pg_control").is_file() {
        return Err(Error::Engine(format!(
            "native {} cluster seed is incomplete: {}",
            profile.id(),
            path.display()
        )));
    }
    let manifest_path = path.join("manifest.properties");
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|err| {
        Error::Engine(format!(
            "read native cluster seed manifest {}: {err}",
            manifest_path.display()
        ))
    })?;
    let fields = parse_properties(&manifest, &manifest_path)?;
    let expected_role = format!("cluster-seed-{}", profile.id());
    let expected_features = if profile == super::super::NativeCatalogProfile::Icu {
        "icu"
    } else {
        ""
    };
    const CLUSTER_SEED_FIELDS: [&str; 14] = [
        "schema",
        "layout",
        "artifactRole",
        "catalogProfile",
        "target",
        "postgresMajor",
        "physicalFormat",
        "compatibilityKey",
        "initialSuperuser",
        "icuDataVersion",
        "icuDataForm",
        "icuDataTreeSha256",
        "runtimeFeatures",
        "cacheKey",
    ];
    let target = fields.get("target").filter(|value| valid_identity(value));
    if fields.len() != CLUSTER_SEED_FIELDS.len()
        || CLUSTER_SEED_FIELDS
            .iter()
            .any(|key| !fields.contains_key(*key))
        || fields.get("schema").map(String::as_str) != Some("oliphaunt-runtime-resources-v1")
        || fields.get("layout").map(String::as_str) != Some("oliphaunt-cluster-seed-v1")
        || fields.get("artifactRole").map(String::as_str) != Some(expected_role.as_str())
        || fields.get("catalogProfile").map(String::as_str) != Some(profile.id())
        || fields.get("postgresMajor").map(String::as_str) != Some("18")
        || fields.get("physicalFormat").map(String::as_str) != Some("native-pg18-v1")
        || target.is_none()
        || fields.get("compatibilityKey").map(String::as_str)
            != target
                .map(|value| format!("native-pg18-{value}-v1"))
                .as_deref()
        || fields.get("initialSuperuser").map(String::as_str) != Some("postgres")
        || fields.get("runtimeFeatures").map(String::as_str) != Some(expected_features)
        || !fields
            .get("cacheKey")
            .is_some_and(|value| valid_seed_cache_key(value))
    {
        return Err(Error::Engine(format!(
            "native cluster seed manifest {} does not declare the {} target-qualified contract",
            manifest_path.display(),
            profile.id()
        )));
    }
    let icu_data_tree_sha256 = match profile {
        super::super::NativeCatalogProfile::Standard => {
            if fields.get("icuDataVersion").is_some_and(String::is_empty)
                && fields.get("icuDataForm").is_some_and(String::is_empty)
                && fields
                    .get("icuDataTreeSha256")
                    .is_some_and(String::is_empty)
            {
                None
            } else {
                return Err(Error::Engine(format!(
                    "native standard cluster seed manifest {} must not identify ICU data",
                    manifest_path.display()
                )));
            }
        }
        super::super::NativeCatalogProfile::Icu => {
            let digest = fields.get("icuDataTreeSha256");
            if fields.get("icuDataVersion").map(String::as_str) == Some("76.1")
                && fields.get("icuDataForm").map(String::as_str) == Some("files-le")
                && digest.is_some_and(|value| valid_sha256(value))
            {
                digest.cloned()
            } else {
                return Err(Error::Engine(format!(
                    "native ICU cluster seed manifest {} does not bind canonical ICU data",
                    manifest_path.display()
                )));
            }
        }
    };
    Ok(LocatedClusterSeed {
        directory: path.to_path_buf(),
        target: target.expect("target validated above").clone(),
        icu_data_tree_sha256,
    })
}

fn read_icu_data_receipt(path: &Path) -> Result<String> {
    let manifest = std::fs::read_to_string(path).map_err(|err| {
        Error::Engine(format!(
            "read native ICU data receipt {}: {err}",
            path.display()
        ))
    })?;
    let fields = parse_properties(&manifest, path)?;
    let digest = fields.get("icuDataTreeSha256");
    if fields.len() != 5
        || fields.get("schema").map(String::as_str) != Some("oliphaunt-icu-data-v1")
        || fields.get("artifactRole").map(String::as_str) != Some("icu-data")
        || fields.get("icuDataVersion").map(String::as_str) != Some("76.1")
        || fields.get("icuDataForm").map(String::as_str) != Some("files-le")
        || !digest.is_some_and(|value| valid_sha256(value))
    {
        return Err(Error::Engine(format!(
            "native ICU data receipt {} is invalid",
            path.display()
        )));
    }
    Ok(digest.expect("digest validated above").clone())
}

fn read_native_runtime_carrier(path: &Path) -> Result<String> {
    let manifest = std::fs::read_to_string(path).map_err(|err| {
        Error::Engine(format!(
            "read native runtime carrier receipt {}: {err}",
            path.display()
        ))
    })?;
    let fields = parse_properties(&manifest, path)?;
    let target = fields.get("clusterSeedTarget");
    let expected_target = native_host_target_id().ok_or_else(|| {
        Error::Engine(format!(
            "native runtime carrier {} is not supported on {}/{}",
            path.display(),
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    })?;
    if fields.len() != 4
        || fields.get("schema").map(String::as_str) != Some("oliphaunt-native-runtime-carrier-v1")
        || target.map(String::as_str) != Some(expected_target)
        || fields.get("clusterSeedRelativePath").map(String::as_str) != Some("cluster-seed")
        || fields.get("icuClusterSeedRelativePath").map(String::as_str) != Some("cluster-seed-icu")
    {
        return Err(Error::Engine(format!(
            "native runtime carrier receipt {} must be the exact {} cluster-seed carrier contract",
            path.display(),
            expected_target
        )));
    }
    Ok(target.expect("target validated above").clone())
}

fn parse_properties(
    contents: &str,
    path: &Path,
) -> Result<std::collections::BTreeMap<String, String>> {
    let mut fields = std::collections::BTreeMap::new();
    for line in contents.lines().filter(|line| !line.is_empty()) {
        let Some((key, value)) = line.split_once('=') else {
            return Err(Error::Engine(format!(
                "manifest {} contains malformed properties",
                path.display()
            )));
        };
        if key.is_empty() || fields.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(Error::Engine(format!(
                "manifest {} contains duplicate properties",
                path.display()
            )));
        }
    }
    Ok(fields)
}

fn paths_identical(left: &Path, right: &Path) -> bool {
    left.canonicalize().unwrap_or_else(|_| left.to_path_buf())
        == right.canonicalize().unwrap_or_else(|_| right.to_path_buf())
}

fn valid_identity(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_seed_cache_key(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn icu_data_dir_is_valid(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        (path.is_file() && name.starts_with("icudt") && name.ends_with(".dat"))
            || (path.is_dir()
                && name.starts_with("icudt")
                && std::fs::read_dir(path)
                    .ok()
                    .into_iter()
                    .flatten()
                    .flatten()
                    .any(|child| child.path().is_file()))
    })
}

fn native_host_target_id() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("linux", "x86_64") => Some("linux-x64-gnu"),
        ("linux", "aarch64") => Some("linux-arm64-gnu"),
        ("windows", "x86_64") => Some("windows-x64-msvc"),
        ("android", "aarch64" | "x86_64") => Some("android-datum64"),
        ("ios", "aarch64" | "x86_64") => Some("ios-datum64"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::liboliphaunt::root::NativeCatalogProfile;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[test]
    fn embedded_modules_locator_accepts_release_lib_modules_next_to_dll() {
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let previous = std::env::var_os(ENV_EMBEDDED_MODULE_DIR);
        unsafe {
            std::env::remove_var(ENV_EMBEDDED_MODULE_DIR);
        }
        let temp = TempTree::new("release-lib-modules");
        let release_root = temp.path().join("liboliphaunt-0.0.0-windows-x64-msvc");
        let install_dir = release_root.join("runtime");
        let modules_dir = release_root.join("lib/modules");
        fs::create_dir_all(release_root.join("bin")).expect("create release bin");
        fs::create_dir_all(&modules_dir).expect("create release modules");
        fs::create_dir_all(&install_dir).expect("create release runtime");

        let located = locate_native_embedded_modules_dir_from_libraries(
            &install_dir,
            [release_root.join("bin/oliphaunt.dll")],
        )
        .expect("locate release modules");

        restore_env(ENV_EMBEDDED_MODULE_DIR, previous);
        assert_eq!(located, modules_dir);
    }

    #[test]
    fn embedded_modules_locator_prefers_explicit_environment_dir() {
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let temp = TempTree::new("explicit-env-modules");
        let install_dir = temp.path().join("runtime");
        let modules_dir = temp.path().join("registry/modules");
        fs::create_dir_all(&install_dir).expect("create runtime");
        fs::create_dir_all(&modules_dir).expect("create modules");
        let previous = std::env::var_os(ENV_EMBEDDED_MODULE_DIR);
        unsafe {
            std::env::set_var(ENV_EMBEDDED_MODULE_DIR, &modules_dir);
        }

        let located = locate_native_embedded_modules_dir_from_libraries(
            &install_dir,
            [temp.path().join("lib/liboliphaunt.so")],
        )
        .expect("locate env modules");

        restore_env(ENV_EMBEDDED_MODULE_DIR, previous);
        assert_eq!(located, modules_dir);
    }

    #[test]
    fn cluster_seed_manifest_accepts_shared_standard_and_icu_fixtures() {
        let temp = TempTree::new("target-qualified-seed");
        let seed = temp.path().join("cluster-seed");
        write_cluster_seed_fixture(&seed, "native-standard.valid.properties");

        let located = parse_native_cluster_seed(&seed, NativeCatalogProfile::Standard)
            .expect("accept target-qualified cluster seed");
        assert_eq!(located.target, "linux-x64-gnu");

        write_cluster_seed_fixture(&seed, "native-icu.valid.properties");
        let located = parse_native_cluster_seed(&seed, NativeCatalogProfile::Icu)
            .expect("accept ICU cluster seed");
        assert_eq!(
            located.icu_data_tree_sha256.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn cluster_seed_manifest_rejects_shared_invalid_vectors() {
        let temp = TempTree::new("invalid-seed-manifests");
        let seed = temp.path().join("cluster-seed");
        for fixture in [
            "native-malformed.invalid.properties",
            "native-whitespace.invalid.properties",
            "native-cache-key.invalid.properties",
            "native-dot-cache-key.invalid.properties",
            "native-dotdot-cache-key.invalid.properties",
            "native-extra-field.invalid.properties",
            "native-target-mismatch.invalid.properties",
            "native-profile-mismatch.invalid.properties",
        ] {
            write_cluster_seed_fixture(&seed, fixture);
            assert!(
                parse_native_cluster_seed(&seed, NativeCatalogProfile::Standard).is_err(),
                "accepted invalid fixture {fixture}"
            );
        }
    }

    #[test]
    fn icu_receipt_is_an_exact_canonical_identity() {
        let temp = TempTree::new("icu-receipt");
        let receipt = temp.path().join("manifest.properties");
        let digest = "a".repeat(64);
        fs::write(
            &receipt,
            format!(
                "schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256={digest}\n"
            ),
        )
        .expect("write ICU receipt");
        assert_eq!(read_icu_data_receipt(&receipt).unwrap(), digest);

        fs::write(
            &receipt,
            format!(
                "schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256={digest}\nextra=value\n"
            ),
        )
        .expect("write invalid ICU receipt");
        assert!(read_icu_data_receipt(&receipt).is_err());
    }

    #[test]
    fn runtime_carrier_receipt_is_exact_and_host_bound() {
        let Some(target) = native_host_target_id() else {
            return;
        };
        let temp = TempTree::new("runtime-carrier-receipt");
        let receipt = temp.path().join("manifest.properties");

        write_runtime_carrier_receipt(&receipt, target, "cluster-seed", "cluster-seed-icu", "");
        assert_eq!(read_native_runtime_carrier(&receipt).unwrap(), target);

        write_runtime_carrier_receipt(
            &receipt,
            target,
            "nested/cluster-seed",
            "cluster-seed-icu",
            "",
        );
        assert!(read_native_runtime_carrier(&receipt).is_err());

        write_runtime_carrier_receipt(
            &receipt,
            target,
            "cluster-seed",
            "cluster-seed-icu",
            "extra=value\n",
        );
        assert!(read_native_runtime_carrier(&receipt).is_err());

        write_runtime_carrier_receipt(
            &receipt,
            "other-target",
            "cluster-seed",
            "cluster-seed-icu",
            "",
        );
        assert!(read_native_runtime_carrier(&receipt).is_err());
    }

    fn write_runtime_carrier_receipt(
        path: &Path,
        target: &str,
        standard_path: &str,
        icu_path: &str,
        extra: &str,
    ) {
        fs::write(
            path,
            format!(
                "schema=oliphaunt-native-runtime-carrier-v1\nclusterSeedTarget={target}\nclusterSeedRelativePath={standard_path}\nicuClusterSeedRelativePath={icu_path}\n{extra}"
            ),
        )
        .expect("write runtime carrier receipt");
    }

    fn write_cluster_seed_fixture(path: &Path, fixture: &str) {
        fs::create_dir_all(path.join("files/global")).expect("create cluster seed tree");
        fs::write(path.join("files/PG_VERSION"), b"18\n").expect("write PG_VERSION");
        fs::write(path.join("files/global/pg_control"), b"control").expect("write pg_control");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../shared/cluster-seed-contract/fixtures")
            .join(fixture);
        fs::copy(fixture, path.join("manifest.properties"))
            .expect("copy shared cluster seed fixture");
    }

    fn restore_env(name: &str, previous: Option<std::ffi::OsString>) {
        match previous {
            Some(value) => unsafe {
                std::env::set_var(name, value);
            },
            None => unsafe {
                std::env::remove_var(name);
            },
        }
    }

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "oliphaunt-locate-test-{name}-{nanos}-{}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp tree");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
