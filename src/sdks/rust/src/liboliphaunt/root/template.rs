use std::ffi::OsString;
use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use fs2::FileExt;

use super::NativeRuntimeProfile;
use super::files::{
    copy_directory_tree, directory_is_empty, pgdata_template_copy_mode, remove_file_if_exists,
};
use super::fingerprint::{hash_path, hash_str, new_state};
use super::runtime::{materialize_runtime, monotonic_cache_nonce, runtime_cache_root};
use crate::error::{Error, Result};
use crate::storage::BootstrapStrategy;

const PGDATA_TEMPLATE_VERSION: &str = "pg18-pgdata-template-v3";

pub(super) fn bootstrap_pgdata_if_needed(
    profile: NativeRuntimeProfile,
    pgdata: &Path,
    strategy: &BootstrapStrategy,
) -> Result<()> {
    if pgdata.join("PG_VERSION").is_file() {
        return Ok(());
    }

    match strategy {
        BootstrapStrategy::PackagedTemplate => restore_pgdata_template(profile, pgdata),
        BootstrapStrategy::ExistingOnly => Err(Error::Engine(format!(
            "native PGDATA at {} has not been bootstrapped",
            pgdata.display()
        ))),
        BootstrapStrategy::InitdbToolingOnly { .. } => Ok(()),
    }
}

fn restore_pgdata_template(profile: NativeRuntimeProfile, pgdata: &Path) -> Result<()> {
    let template_pgdata = materialize_pgdata_template(profile)?;
    copy_pgdata_template(&template_pgdata, pgdata)
}

pub(super) fn materialize_pgdata_template(_profile: NativeRuntimeProfile) -> Result<PathBuf> {
    let bootstrap_runtime = materialize_runtime(NativeRuntimeProfile::PostgresServer, &[])?;
    let key = pgdata_template_key(&bootstrap_runtime)?;
    let cache_root = runtime_cache_root()?.join("pgdata-templates");
    fs::create_dir_all(&cache_root).map_err(|err| {
        Error::Engine(format!(
            "create native PGDATA template cache root {}: {err}",
            cache_root.display()
        ))
    })?;
    #[cfg(unix)]
    fs::set_permissions(&cache_root, fs::Permissions::from_mode(0o700)).map_err(|err| {
        Error::Engine(format!(
            "set permissions on native PGDATA template cache root {}: {err}",
            cache_root.display()
        ))
    })?;

    let template_dir = cache_root.join(&key);
    let lock_path = cache_root.join(format!("{key}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(&lock_path)
        .map_err(|err| {
            Error::Engine(format!(
                "open native PGDATA template lock {}: {err}",
                lock_path.display()
            ))
        })?;
    lock.lock_exclusive().map_err(|err| {
        Error::Engine(format!(
            "lock native PGDATA template {}: {err}",
            lock_path.display()
        ))
    })?;

    if !pgdata_template_is_valid(&template_dir, &key) {
        let build_dir = cache_root.join(format!(
            ".build-{}-{}",
            std::process::id(),
            monotonic_cache_nonce()?
        ));
        if build_dir.exists() {
            fs::remove_dir_all(&build_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove stale native PGDATA template build dir {}: {err}",
                    build_dir.display()
                ))
            })?;
        }
        fs::create_dir_all(&build_dir).map_err(|err| {
            Error::Engine(format!(
                "create native PGDATA template build dir {}: {err}",
                build_dir.display()
            ))
        })?;

        let pgdata = build_dir.join("pgdata");
        let build_result = run_template_initdb(&bootstrap_runtime, &pgdata)
            .and_then(|()| clean_pgdata_template(&pgdata))
            .and_then(|()| {
                fs::write(build_dir.join(".manifest"), pgdata_template_manifest(&key)).map_err(
                    |err| {
                        Error::Engine(format!(
                            "write native PGDATA template manifest {}: {err}",
                            build_dir.display()
                        ))
                    },
                )
            })
            .and_then(|()| {
                fs::write(build_dir.join(".complete"), b"ok\n").map_err(|err| {
                    Error::Engine(format!(
                        "write native PGDATA template completion marker {}: {err}",
                        build_dir.display()
                    ))
                })
            });

        if let Err(error) = build_result {
            let _ = fs::remove_dir_all(&build_dir);
            return Err(error);
        }
        if template_dir.exists() {
            fs::remove_dir_all(&template_dir).map_err(|err| {
                Error::Engine(format!(
                    "remove invalid native PGDATA template {}: {err}",
                    template_dir.display()
                ))
            })?;
        }
        fs::rename(&build_dir, &template_dir).map_err(|err| {
            Error::Engine(format!(
                "publish native PGDATA template {} -> {}: {err}",
                build_dir.display(),
                template_dir.display()
            ))
        })?;
    }

    lock.unlock().map_err(|err| {
        Error::Engine(format!(
            "unlock native PGDATA template {}: {err}",
            lock_path.display()
        ))
    })?;
    Ok(template_dir.join("pgdata"))
}

fn pgdata_template_key(bootstrap_runtime: &Path) -> Result<String> {
    let runtime_manifest =
        fs::read_to_string(bootstrap_runtime.join(".manifest")).map_err(|err| {
            Error::Engine(format!(
                "read native runtime manifest {}: {err}",
                bootstrap_runtime.join(".manifest").display()
            ))
        })?;
    let mut state = new_state();
    hash_str(&mut state, PGDATA_TEMPLATE_VERSION);
    hash_path(&mut state, bootstrap_runtime);
    hash_str(&mut state, &runtime_manifest);
    Ok(format!("{state:016x}"))
}

fn pgdata_template_manifest(key: &str) -> String {
    format!("version={PGDATA_TEMPLATE_VERSION}\nkey={key}\n")
}

fn pgdata_template_is_valid(template_dir: &Path, key: &str) -> bool {
    if !template_dir.join(".complete").is_file()
        || !template_dir.join("pgdata/PG_VERSION").is_file()
        || !template_dir.join("pgdata/global/pg_control").is_file()
    {
        return false;
    }
    let Ok(manifest) = fs::read_to_string(template_dir.join(".manifest")) else {
        return false;
    };
    manifest
        .lines()
        .any(|line| line == format!("version={PGDATA_TEMPLATE_VERSION}"))
        && manifest.lines().any(|line| line == format!("key={key}"))
}

fn run_template_initdb(runtime_dir: &Path, pgdata: &Path) -> Result<()> {
    let initdb = runtime_dir.join("bin/initdb");
    if !initdb.is_file() {
        return Err(Error::Engine(format!(
            "native PGDATA template bootstrap requires initdb at {}",
            initdb.display()
        )));
    }
    let output = Command::new(&initdb)
        .args(template_initdb_args(runtime_dir, pgdata))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| Error::Engine(format!("run native PGDATA template initdb: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(Error::Engine(format!(
        "native PGDATA template initdb failed with status {}: {}",
        output.status,
        stderr.trim()
    )))
}

fn template_initdb_args(runtime_dir: &Path, pgdata: &Path) -> Vec<OsString> {
    vec![
        "-D".into(),
        pgdata.as_os_str().to_owned(),
        "-U".into(),
        "postgres".into(),
        "--auth=trust".into(),
        "--no-sync".into(),
        "--locale=C".into(),
        "--encoding=UTF8".into(),
        "-L".into(),
        runtime_dir.join("share/postgresql").into_os_string(),
    ]
}

fn clean_pgdata_template(pgdata: &Path) -> Result<()> {
    for relative in ["postmaster.pid", "postmaster.opts"] {
        remove_file_if_exists(&pgdata.join(relative))?;
    }
    normalize_pgdata_template_conf(pgdata)?;
    Ok(())
}

fn normalize_pgdata_template_conf(pgdata: &Path) -> Result<()> {
    let conf = pgdata.join("postgresql.conf");
    if !conf.is_file() {
        return Ok(());
    }
    let contents = fs::read_to_string(&conf).map_err(|err| {
        Error::Engine(format!(
            "read native PGDATA template config {}: {err}",
            conf.display()
        ))
    })?;
    let settings = [
        ("dynamic_shared_memory_type", "mmap"),
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
                "write native PGDATA template config {}: {err}",
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

fn copy_pgdata_template(template_pgdata: &Path, pgdata: &Path) -> Result<()> {
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

    let copy_result = copy_directory_tree(template_pgdata, &staging, pgdata_template_copy_mode());
    if let Err(error) = copy_result {
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
    use std::path::Path;

    use super::{normalize_pgdata_template_conf, template_initdb_args};

    #[test]
    fn template_initdb_forces_mobile_safe_locale() {
        let args = template_initdb_args(Path::new("/runtime"), Path::new("/cache/template/pgdata"));

        assert!(args.iter().any(|arg| arg == OsStr::new("--locale=C")));
        assert!(args.iter().any(|arg| arg == OsStr::new("--encoding=UTF8")));
    }

    #[test]
    fn template_config_normalization_forces_mobile_safe_values() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-template-normalize-{}-{}",
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

        normalize_pgdata_template_conf(&root).unwrap();

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
}
