use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use super::{NativeCatalogProfile, configure_native_tool_env, native_tool_path};
use crate::error::{Error, Result};

const SKIP_SYSTEM_COLLATION_DISCOVERY_ENV: &str =
    "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY";
const SKIP_ICU_COLLATION_DISCOVERY_ENV: &str = "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY";

pub(super) fn bootstrap_pgdata_if_needed(
    runtime_dir: &Path,
    initdb_runtime_dir: &Path,
    catalog_profile: NativeCatalogProfile,
    pgdata: &Path,
) -> Result<()> {
    if pgdata.join("PG_VERSION").is_file() {
        return Ok(());
    }
    run_initdb(
        initdb_runtime_dir,
        runtime_dir,
        catalog_profile,
        pgdata,
        "database",
        false,
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

pub(super) const fn native_dynamic_shared_memory_type() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "mmap"
    }
}

pub(super) fn normalize_cluster_seed_conf(
    pgdata: &Path,
    dynamic_shared_memory_type: &str,
) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs;
    use std::path::Path;

    use super::{
        SKIP_ICU_COLLATION_DISCOVERY_ENV, SKIP_SYSTEM_COLLATION_DISCOVERY_ENV,
        configure_cluster_seed_runtime_env, initdb_args, normalize_cluster_seed_conf,
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
}
