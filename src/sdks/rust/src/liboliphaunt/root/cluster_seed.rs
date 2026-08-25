use std::ffi::OsString;
use std::fs;
#[cfg(feature = "internal-native-packaging")]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
#[cfg(feature = "internal-native-packaging")]
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(feature = "internal-native-packaging")]
use fs2::FileExt;

use super::files::{cluster_seed_copy_mode, copy_directory_tree, directory_is_empty};
#[cfg(feature = "internal-native-packaging")]
use super::files::{remove_file_if_exists, sync_directory, sync_directory_tree};
#[cfg(feature = "internal-native-packaging")]
use super::fingerprint::{hash_path, hash_str, new_state};
use super::runtime::monotonic_cache_nonce;
#[cfg(feature = "internal-native-packaging")]
use super::runtime::runtime_cache_root;
use super::{
    NativeCatalogProfile, NativeRuntimeProfile, configure_native_tool_env, native_tool_path,
};
use crate::error::{Error, Result};

#[cfg(feature = "internal-native-packaging")]
const CLUSTER_SEED_CACHE_VERSION: &str = "pg18-cluster-seed-v6";
const SKIP_SYSTEM_COLLATION_DISCOVERY_ENV: &str =
    "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY";
const SKIP_ICU_COLLATION_DISCOVERY_ENV: &str = "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path, context: &str) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|err| {
        Error::Engine(format!(
            "set permissions on {context} {}: {err}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path, _context: &str) -> Result<()> {
    Ok(())
}

pub(super) fn bootstrap_pgdata_if_needed(
    profile: NativeRuntimeProfile,
    runtime_dir: &Path,
    initdb_runtime_dir: &Path,
    catalog_profile: super::NativeCatalogProfile,
    packaged_cluster_seed: Option<&Path>,
    pgdata: &Path,
) -> Result<()> {
    if pgdata.join("PG_VERSION").is_file() {
        return Ok(());
    }

    if profile == NativeRuntimeProfile::PostgresServer || packaged_cluster_seed.is_none() {
        return run_initdb(
            initdb_runtime_dir,
            runtime_dir,
            catalog_profile,
            pgdata,
            "database",
            false,
        );
    }
    restore_cluster_seed(
        packaged_cluster_seed.expect("packaged cluster seed checked above"),
        pgdata,
    )
}

fn run_initdb(
    initdb_runtime_dir: &Path,
    runtime_dir: &Path,
    catalog_profile: NativeCatalogProfile,
    pgdata: &Path,
    context: &str,
    skip_system_collation_discovery: bool,
) -> Result<()> {
    let initdb = native_tool_path(initdb_runtime_dir, "initdb");
    if !initdb.is_file() {
        return Err(Error::Engine(format!(
            "native {context} initialization requires initdb at {}",
            initdb.display()
        )));
    }
    let mut command = Command::new(&initdb);
    configure_cluster_seed_runtime_env(
        &mut command,
        initdb_runtime_dir,
        runtime_dir,
        catalog_profile,
        skip_system_collation_discovery,
    );
    let output = command
        .args(initdb_args(initdb_runtime_dir, pgdata))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            Error::Engine(format!(
                "run native {context} initdb {}: {err}",
                initdb.display()
            ))
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(Error::Engine(format!(
        "native {context} initdb {} failed with status {}: {}",
        initdb.display(),
        output.status,
        stderr.trim()
    )))
}

fn initdb_args(runtime_dir: &Path, pgdata: &Path) -> Vec<OsString> {
    vec![
        "-D".into(),
        pgdata.as_os_str().to_owned(),
        "-U".into(),
        "postgres".into(),
        "--auth=trust".into(),
        "--locale-provider=libc".into(),
        "--locale=C".into(),
        "--encoding=UTF8".into(),
        "-L".into(),
        runtime_dir.join("share/postgresql").into_os_string(),
    ]
}

fn restore_cluster_seed(packaged_cluster_seed: &Path, pgdata: &Path) -> Result<()> {
    let cluster_seed = packaged_cluster_seed.join("files");
    copy_cluster_seed(&cluster_seed, pgdata)
}

#[cfg(feature = "internal-native-packaging")]
pub(super) fn materialize_cluster_seed(
    _profile: NativeRuntimeProfile,
    runtime_dir: &Path,
    initdb_runtime_dir: &Path,
    catalog_profile: super::NativeCatalogProfile,
) -> Result<PathBuf> {
    let skip_system_collation_discovery = distributed_seed_requested();
    let key = cluster_seed_key(
        runtime_dir,
        catalog_profile,
        skip_system_collation_discovery,
    )?;
    let cache_root = runtime_cache_root()?.join("cluster-seeds");
    fs::create_dir_all(&cache_root).map_err(|err| {
        Error::Engine(format!(
            "create native PGDATA cluster seed cache root {}: {err}",
            cache_root.display()
        ))
    })?;
    set_private_directory_permissions(&cache_root, "native PGDATA cluster seed cache root")?;

    let seed_dir = cache_root.join(&key);
    let lock_path = cache_root.join(format!("{key}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(&lock_path)
        .map_err(|err| {
            Error::Engine(format!(
                "open native cluster-seed lock {}: {err}",
                lock_path.display()
            ))
        })?;
    lock.lock_exclusive().map_err(|err| {
        Error::Engine(format!(
            "lock native cluster seed {}: {err}",
            lock_path.display()
        ))
    })?;

    if !cluster_seed_is_valid(&seed_dir, &key) {
        let build_dir = cache_root.join(format!(
            ".build-{}-{}",
            std::process::id(),
            monotonic_cache_nonce()?
        ));
        if build_dir.exists() {
            fs::remove_dir_all(&build_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove stale native cluster-seed build dir {}: {err}",
                    build_dir.display()
                ))
            })?;
        }
        fs::create_dir_all(&build_dir).map_err(|err| {
            Error::Engine(format!(
                "create native cluster-seed build dir {}: {err}",
                build_dir.display()
            ))
        })?;

        let pgdata = build_dir.join("pgdata");
        let build_result = run_cluster_seed_initdb(
            initdb_runtime_dir,
            runtime_dir,
            catalog_profile,
            &pgdata,
            skip_system_collation_discovery,
        )
        .and_then(|()| clean_cluster_seed(&pgdata, native_dynamic_shared_memory_type()))
        .and_then(|()| {
            fs::write(build_dir.join(".manifest"), cluster_seed_manifest(&key)).map_err(|err| {
                Error::Engine(format!(
                    "write native cluster-seed manifest {}: {err}",
                    build_dir.display()
                ))
            })
        })
        .and_then(|()| {
            fs::write(build_dir.join(".complete"), b"ok\n").map_err(|err| {
                Error::Engine(format!(
                    "write native cluster-seed completion marker {}: {err}",
                    build_dir.display()
                ))
            })
        })
        .and_then(|()| sync_directory_tree(&build_dir));

        if let Err(error) = build_result {
            let _ = fs::remove_dir_all(&build_dir);
            return Err(error);
        }
        if seed_dir.exists() {
            fs::remove_dir_all(&seed_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove invalid native cluster seed {}: {err}",
                    seed_dir.display()
                ))
            })?;
        }
        fs::rename(&build_dir, &seed_dir).map_err(|err| {
            Error::Engine(format!(
                "publish native cluster seed {} -> {}: {err}",
                build_dir.display(),
                seed_dir.display()
            ))
        })?;
        sync_directory(&cache_root)?;
    }

    lock.unlock().map_err(|err| {
        Error::Engine(format!(
            "unlock native cluster seed {}: {err}",
            lock_path.display()
        ))
    })?;
    Ok(seed_dir.join("pgdata"))
}

#[cfg(feature = "internal-native-packaging")]
fn cluster_seed_key(
    bootstrap_runtime: &Path,
    catalog_profile: super::NativeCatalogProfile,
    skip_system_collation_discovery: bool,
) -> Result<String> {
    let runtime_manifest =
        fs::read_to_string(bootstrap_runtime.join(".manifest")).map_err(|err| {
            Error::Engine(format!(
                "read native runtime manifest {}: {err}",
                bootstrap_runtime.join(".manifest").display()
            ))
        })?;
    let mut state = new_state();
    hash_str(&mut state, CLUSTER_SEED_CACHE_VERSION);
    hash_str(&mut state, catalog_profile.id());
    hash_str(
        &mut state,
        if skip_system_collation_discovery {
            "distributed"
        } else {
            "host"
        },
    );
    hash_path(&mut state, bootstrap_runtime);
    hash_str(&mut state, &runtime_manifest);
    Ok(format!("{state:016x}"))
}

#[cfg(feature = "internal-native-packaging")]
fn cluster_seed_manifest(key: &str) -> String {
    format!("version={CLUSTER_SEED_CACHE_VERSION}\nkey={key}\n")
}

#[cfg(feature = "internal-native-packaging")]
fn cluster_seed_is_valid(seed_dir: &Path, key: &str) -> bool {
    if !seed_dir.join(".complete").is_file()
        || !seed_dir.join("pgdata/PG_VERSION").is_file()
        || !seed_dir.join("pgdata/global/pg_control").is_file()
    {
        return false;
    }
    let Ok(manifest) = fs::read_to_string(seed_dir.join(".manifest")) else {
        return false;
    };
    manifest
        .lines()
        .any(|line| line == format!("version={CLUSTER_SEED_CACHE_VERSION}"))
        && manifest.lines().any(|line| line == format!("key={key}"))
}

#[cfg(feature = "internal-native-packaging")]
fn run_cluster_seed_initdb(
    initdb_runtime_dir: &Path,
    runtime_dir: &Path,
    catalog_profile: super::NativeCatalogProfile,
    pgdata: &Path,
    skip_system_collation_discovery: bool,
) -> Result<()> {
    run_initdb(
        initdb_runtime_dir,
        runtime_dir,
        catalog_profile,
        pgdata,
        "cluster seed",
        skip_system_collation_discovery,
    )
}

#[cfg(feature = "internal-native-packaging")]
fn distributed_seed_requested() -> bool {
    std::env::var_os(SKIP_SYSTEM_COLLATION_DISCOVERY_ENV).is_some_and(|value| value == "1")
}

fn configure_cluster_seed_runtime_env(
    command: &mut Command,
    initdb_runtime_dir: &Path,
    runtime_dir: &Path,
    catalog_profile: super::NativeCatalogProfile,
    skip_system_collation_discovery: bool,
) {
    configure_native_tool_env(command, initdb_runtime_dir);
    command.env_remove("ICU_DATA");
    command.env_remove("OLIPHAUNT_INTERNAL_ICU_READY");
    command.env_remove(SKIP_SYSTEM_COLLATION_DISCOVERY_ENV);
    command.env_remove(SKIP_ICU_COLLATION_DISCOVERY_ENV);
    if skip_system_collation_discovery {
        command.env(SKIP_SYSTEM_COLLATION_DISCOVERY_ENV, "1");
    }
    if catalog_profile == super::NativeCatalogProfile::Standard {
        command.env(SKIP_ICU_COLLATION_DISCOVERY_ENV, "1");
    }
    let icu_data = runtime_dir.join("share/icu");
    if catalog_profile == super::NativeCatalogProfile::Icu && icu_data.is_dir() {
        command.env("ICU_DATA", icu_data);
        command.env("OLIPHAUNT_INTERNAL_ICU_READY", "1");
    }
}

const fn native_dynamic_shared_memory_type() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "mmap"
    }
}

#[cfg(feature = "internal-native-packaging")]
fn clean_cluster_seed(pgdata: &Path, dynamic_shared_memory_type: &str) -> Result<()> {
    for relative in ["postmaster.pid", "postmaster.opts"] {
        remove_file_if_exists(&pgdata.join(relative))?;
    }
    normalize_cluster_seed_conf(pgdata, dynamic_shared_memory_type)?;
    Ok(())
}

fn normalize_cluster_seed_conf(pgdata: &Path, dynamic_shared_memory_type: &str) -> Result<()> {
    let conf = pgdata.join("postgresql.conf");
    if !conf.is_file() {
        return Ok(());
    }
    let contents = fs::read_to_string(&conf).map_err(|err| {
        Error::Engine(format!(
            "read native cluster-seed config {}: {err}",
            conf.display()
        ))
    })?;
    let settings = [
        ("shared_memory_type", dynamic_shared_memory_type),
        ("dynamic_shared_memory_type", dynamic_shared_memory_type),
        ("log_timezone", "'UTC'"),
        ("timezone", "'UTC'"),
        ("lc_messages", "'C'"),
        ("lc_monetary", "'C'"),
        ("lc_numeric", "'C'"),
        ("lc_time", "'C'"),
    ];
    let mut seen = vec![false; settings.len()];
    let mut normalized = String::with_capacity(contents.len());
    for line in contents.lines() {
        if let Some(index) = settings
            .iter()
            .position(|(key, _)| active_config_key(line) == Some(*key))
        {
            let (key, value) = settings[index];
            normalized.push_str(key);
            normalized.push_str(" = ");
            normalized.push_str(value);
            seen[index] = true;
        } else {
            normalized.push_str(line);
        }
        normalized.push('\n');
    }
    for (index, (key, value)) in settings.iter().enumerate() {
        if !seen[index] {
            normalized.push_str(key);
            normalized.push_str(" = ");
            normalized.push_str(value);
            normalized.push('\n');
        }
    }
    if normalized != contents {
        fs::write(&conf, normalized).map_err(|err| {
            Error::Engine(format!(
                "write native cluster-seed config {}: {err}",
                conf.display()
            ))
        })?;
    }
    Ok(())
}

fn active_config_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return None;
    }
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim_end();
    (!key.is_empty()).then_some(key)
}

fn copy_cluster_seed(cluster_seed: &Path, pgdata: &Path) -> Result<()> {
    if pgdata.join("PG_VERSION").is_file() {
        return Ok(());
    }
    if pgdata.exists() {
        if !directory_is_empty(pgdata)? {
            return Err(Error::Engine(format!(
                "refusing to bootstrap non-empty native PGDATA without PG_VERSION at {}",
                pgdata.display()
            )));
        }
        fs::remove_dir_all(pgdata).map_err(|err| {
            Error::Engine(format!("remove empty PGDATA {}: {err}", pgdata.display()))
        })?;
    }
    let parent = pgdata.parent().ok_or_else(|| {
        Error::Engine(format!(
            "native PGDATA {} does not have a parent directory",
            pgdata.display()
        ))
    })?;
    let staging = parent.join(format!(
        ".pgdata-bootstrap-{}-{}",
        std::process::id(),
        monotonic_cache_nonce()?
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|err| {
            Error::Engine(format!(
                "remove stale PGDATA bootstrap staging dir {}: {err}",
                staging.display()
            ))
        })?;
    }

    let copy_result = copy_directory_tree(cluster_seed, &staging, cluster_seed_copy_mode())
        .and_then(|()| {
            set_private_directory_permissions(&staging, "native PGDATA bootstrap directory")
        });
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::create_dir_all(pgdata);
        return Err(error);
    }
    if let Err(error) = normalize_cluster_seed_conf(&staging, native_dynamic_shared_memory_type()) {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::create_dir_all(pgdata);
        return Err(error);
    }
    fs::rename(&staging, pgdata).map_err(|err| {
        let _ = fs::remove_dir_all(&staging);
        Error::Engine(format!(
            "publish native PGDATA bootstrap {} -> {}: {err}",
            staging.display(),
            pgdata.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    #[cfg(unix)]
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        SKIP_ICU_COLLATION_DISCOVERY_ENV, SKIP_SYSTEM_COLLATION_DISCOVERY_ENV,
        configure_cluster_seed_runtime_env, copy_cluster_seed, initdb_args,
        native_dynamic_shared_memory_type, normalize_cluster_seed_conf,
    };
    use crate::liboliphaunt::root::NativeCatalogProfile;

    #[test]
    fn cluster_seed_initdb_forces_mobile_safe_locale() {
        let args = initdb_args(
            Path::new("/runtime"),
            Path::new("/cache/cluster-seed/pgdata"),
        );

        assert!(args.iter().any(|arg| arg == OsStr::new("--locale=C")));
        assert!(
            args.iter()
                .any(|arg| arg == OsStr::new("--locale-provider=libc"))
        );
        assert!(args.iter().any(|arg| arg == OsStr::new("--encoding=UTF8")));
    }

    #[test]
    fn fresh_initdb_uses_fixed_bootstrap_identity_and_packaged_storage() {
        let args = initdb_args(Path::new("/runtime"), Path::new("/app/database/pgdata"));

        assert_eq!(args[0], OsStr::new("-D"));
        assert_eq!(args[1], OsStr::new("/app/database/pgdata"));
        assert_eq!(args[2], OsStr::new("-U"));
        assert_eq!(args[3], OsStr::new("postgres"));
        assert!(args.iter().any(|arg| arg == OsStr::new("--auth=trust")));
        assert!(!args.iter().any(|arg| arg == OsStr::new("--no-sync")));
        assert!(
            args.iter()
                .any(|arg| arg == OsStr::new("/runtime/share/postgresql"))
        );
    }

    #[test]
    fn cluster_seed_initdb_sets_icu_data_when_materialized() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-cluster-seed-icu-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        let runtime = root.join("runtime");
        let icu_data = runtime.join("share/icu");
        fs::create_dir_all(&icu_data).unwrap();

        let mut command = std::process::Command::new("initdb");
        configure_cluster_seed_runtime_env(
            &mut command,
            &runtime,
            &runtime,
            NativeCatalogProfile::Icu,
            false,
        );

        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("ICU_DATA"))
                .and_then(|(_, value)| value)
                .map(std::path::PathBuf::from),
            Some(icu_data)
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("OLIPHAUNT_INTERNAL_ICU_READY"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("1"))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn standard_seed_clears_ambient_icu_selection() {
        let mut command = std::process::Command::new("initdb");
        command.env("ICU_DATA", "/ambient/icu");
        command.env("OLIPHAUNT_INTERNAL_ICU_READY", "1");
        configure_cluster_seed_runtime_env(
            &mut command,
            Path::new("/runtime"),
            Path::new("/runtime"),
            NativeCatalogProfile::Standard,
            false,
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("ICU_DATA"))
                .and_then(|(_, value)| value),
            None
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(SKIP_SYSTEM_COLLATION_DISCOVERY_ENV))
                .and_then(|(_, value)| value),
            None
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(SKIP_ICU_COLLATION_DISCOVERY_ENV))
                .and_then(|(_, value)| value),
            Some(OsStr::new("1"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("OLIPHAUNT_INTERNAL_ICU_READY"))
                .and_then(|(_, value)| value),
            None
        );
    }

    #[test]
    fn distributed_icu_seed_suppresses_only_host_locale_discovery() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-cluster-seed-mobile-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        let runtime = root.join("runtime");
        fs::create_dir_all(runtime.join("share/icu")).unwrap();

        let mut command = std::process::Command::new("initdb");
        configure_cluster_seed_runtime_env(
            &mut command,
            &runtime,
            &runtime,
            NativeCatalogProfile::Icu,
            true,
        );

        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(SKIP_SYSTEM_COLLATION_DISCOVERY_ENV))
                .and_then(|(_, value)| value),
            Some(OsStr::new("1"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(SKIP_ICU_COLLATION_DISCOVERY_ENV))
                .and_then(|(_, value)| value),
            None
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("OLIPHAUNT_INTERNAL_ICU_READY"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("1"))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn distributed_standard_seed_suppresses_host_and_icu_discovery() {
        let mut command = std::process::Command::new("initdb");
        configure_cluster_seed_runtime_env(
            &mut command,
            Path::new("/runtime"),
            Path::new("/runtime"),
            NativeCatalogProfile::Standard,
            true,
        );
        for key in [
            SKIP_SYSTEM_COLLATION_DISCOVERY_ENV,
            SKIP_ICU_COLLATION_DISCOVERY_ENV,
        ] {
            assert_eq!(
                command
                    .get_envs()
                    .find(|(candidate, _)| *candidate == OsStr::new(key))
                    .and_then(|(_, value)| value),
                Some(OsStr::new("1"))
            );
        }
    }

    #[test]
    fn cluster_seed_config_normalization_forces_posix_host_values() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-cluster-seed-normalize-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let conf = root.join("postgresql.conf");
        fs::write(
            &conf,
            [
                "# dynamic_shared_memory_type = posix",
                "dynamic_shared_memory_type = posix",
                "log_timezone = 'America/Los_Angeles'",
                "timezone = 'America/Los_Angeles'",
                "lc_messages = 'en_US.UTF-8'",
                "lc_monetary = 'en_US.UTF-8'",
                "lc_numeric = 'en_US.UTF-8'",
                "lc_time = 'en_US.UTF-8'",
            ]
            .join("\n"),
        )
        .unwrap();

        normalize_cluster_seed_conf(&root, "mmap").unwrap();

        let normalized = fs::read_to_string(&conf).unwrap();
        assert!(normalized.contains("# dynamic_shared_memory_type = posix"));
        assert!(normalized.contains("dynamic_shared_memory_type = mmap"));
        assert!(normalized.contains("log_timezone = 'UTC'"));
        assert!(normalized.contains("timezone = 'UTC'"));
        assert!(normalized.contains("lc_messages = 'C'"));
        assert!(normalized.contains("lc_monetary = 'C'"));
        assert!(normalized.contains("lc_numeric = 'C'"));
        assert!(normalized.contains("lc_time = 'C'"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cluster_seed_config_normalization_uses_windows_dsm_on_windows() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-cluster-seed-normalize-windows-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let conf = root.join("postgresql.conf");
        fs::write(
            &conf,
            [
                "# dynamic_shared_memory_type = windows",
                "dynamic_shared_memory_type = posix",
            ]
            .join("\n"),
        )
        .unwrap();

        normalize_cluster_seed_conf(&root, "windows").unwrap();

        let normalized = fs::read_to_string(&conf).unwrap();
        assert!(normalized.contains("# dynamic_shared_memory_type = windows"));
        assert!(normalized.contains("dynamic_shared_memory_type = windows"));
        assert!(!normalized.contains("dynamic_shared_memory_type = mmap"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn native_dsm_type_matches_the_compiled_host() {
        assert_eq!(
            native_dynamic_shared_memory_type(),
            if cfg!(target_os = "windows") {
                "windows"
            } else {
                "mmap"
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn copied_cluster_seed_publishes_private_pgdata() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-cluster-seed-permissions-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("source");
        let pgdata = root.join("database/pgdata");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(pgdata.parent().unwrap()).unwrap();
        fs::write(source.join("PG_VERSION"), "18\n").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();

        copy_cluster_seed(&source, &pgdata).unwrap();

        assert_eq!(
            fs::metadata(&pgdata).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::read_to_string(pgdata.join("PG_VERSION")).unwrap(),
            "18\n"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
