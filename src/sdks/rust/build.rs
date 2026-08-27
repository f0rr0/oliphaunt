use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const ARTIFACT_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const ARTIFACT_ENV_SUFFIX: &str = "_MANIFEST";
const RELAY_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_RELAY_";
const QUERY_CORE_ENV: &str = "OLIPHAUNT_QUERY_CORE_RS";
const QUERY_CORE_OUTPUT: &str = "query_core.rs";
const PACKAGED_QUERY_CORE: &str = "src/query_core.rs";
const CHECKOUT_QUERY_CORE: &str = "../../shared/rust-query-core/query_core.rs";

fn main() {
    match build_instructions(env::vars()) {
        Ok(instructions) => {
            for instruction in instructions {
                println!("{instruction}");
            }
        }
        Err(error) => {
            println!("cargo::error={error}");
            panic!("oliphaunt artifact relay failed: {error}");
        }
    }
}

fn build_instructions<I>(vars: I) -> Result<Vec<String>, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let vars = vars.into_iter().collect::<BTreeMap<_, _>>();
    let manifest_dir = required_path(&vars, "CARGO_MANIFEST_DIR")?;
    let out_dir = required_path(&vars, "OUT_DIR")?;
    let mut instructions = relay_manifest_instructions(vars)?;
    instructions.extend(stage_query_core(&manifest_dir, &out_dir)?);
    Ok(instructions)
}

fn required_path(vars: &BTreeMap<String, String>, name: &str) -> Result<PathBuf, String> {
    vars.get(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("Cargo did not provide {name}"))
}

fn stage_query_core(manifest_dir: &Path, out_dir: &Path) -> Result<Vec<String>, String> {
    let packaged = manifest_dir.join(PACKAGED_QUERY_CORE);
    let checkout = manifest_dir.join(CHECKOUT_QUERY_CORE);
    let packaged_exists = packaged.is_file();
    let checkout_exists = checkout.is_file();
    let source = match (packaged_exists, checkout_exists) {
        (true, true) => {
            let packaged_bytes = fs::read(&packaged).map_err(|error| {
                format!(
                    "read packaged Rust query core {}: {error}",
                    packaged.display()
                )
            })?;
            let checkout_bytes = fs::read(&checkout).map_err(|error| {
                format!(
                    "read canonical Rust query core {}: {error}",
                    checkout.display()
                )
            })?;
            if packaged_bytes != checkout_bytes {
                return Err(format!(
                    "packaged Rust query core {} is stale relative to {}",
                    packaged.display(),
                    checkout.display()
                ));
            }
            packaged.as_path()
        }
        (true, false) => packaged.as_path(),
        (false, true) => checkout.as_path(),
        (false, false) => {
            return Err(format!(
                "missing canonical Rust query core; checked {} and {}",
                packaged.display(),
                checkout.display()
            ));
        }
    };
    let source = fs::canonicalize(source)
        .map_err(|error| format!("resolve Rust query core {}: {error}", source.display()))?;
    let output = out_dir.join(QUERY_CORE_OUTPUT);
    fs::copy(&source, &output).map_err(|error| {
        format!(
            "stage Rust query core {} at {}: {error}",
            source.display(),
            output.display()
        )
    })?;
    let mut instructions = [(&packaged, packaged_exists), (&checkout, checkout_exists)]
        .into_iter()
        .filter(|(_, exists)| *exists)
        .map(|(candidate, _)| {
            fs::canonicalize(candidate)
                .map(|candidate| format!("cargo::rerun-if-changed={}", candidate.display()))
                .map_err(|error| {
                    format!(
                        "resolve watched Rust query core {}: {error}",
                        candidate.display()
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    instructions.push(format!(
        "cargo::rustc-env={QUERY_CORE_ENV}={}",
        output.display()
    ));
    Ok(instructions)
}

fn relay_manifest_instructions<I>(vars: I) -> Result<Vec<String>, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut manifests = BTreeMap::new();
    let mut instructions = Vec::new();
    for (key, value) in vars {
        let Some(metadata_key) = relay_metadata_key(&key) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if let Some(existing) = manifests.insert(metadata_key.clone(), value.clone())
            && existing != value
        {
            return Err(format!(
                "conflicting Cargo artifact manifests for metadata key {metadata_key}: {existing} and {value}"
            ));
        }
        instructions.push(format!("cargo::rerun-if-changed={value}"));
    }
    for (metadata_key, manifest) in manifests {
        instructions.push(format!("cargo::metadata={metadata_key}={manifest}"));
    }
    Ok(instructions)
}

fn relay_metadata_key(env_key: &str) -> Option<String> {
    if env_key.starts_with(RELAY_ENV_PREFIX) {
        return None;
    }
    let stem = env_key
        .strip_prefix(ARTIFACT_ENV_PREFIX)?
        .strip_suffix(ARTIFACT_ENV_SUFFIX)?;
    if stem.is_empty() {
        return None;
    }
    Some(format!("{}_manifest", stem.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_core_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-native-query-core-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manifest = root.join("src/sdks/rust");
        let canonical = root.join("src/shared/rust-query-core/query_core.rs");
        let out = root.join("out");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        fs::create_dir_all(manifest.join("src")).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(&canonical, b"canonical query core\n").unwrap();
        (root, manifest, out)
    }

    #[test]
    fn ignores_unrelated_and_empty_vars() {
        let instructions = relay_manifest_instructions([
            ("TARGET".to_owned(), "x86_64-unknown-linux-gnu".to_owned()),
            (
                "DEP_OLIPHAUNT_ARTIFACT_BROKER_LINUX_X64_GNU_MANIFEST".to_owned(),
                String::new(),
            ),
        ])
        .unwrap();
        assert!(instructions.is_empty());
    }

    #[test]
    fn re_emits_multiple_artifact_manifests() {
        let instructions = relay_manifest_instructions([
            (
                "DEP_OLIPHAUNT_ARTIFACT_BROKER_LINUX_X64_GNU_MANIFEST".to_owned(),
                "/tmp/broker.toml".to_owned(),
            ),
            (
                "DEP_OLIPHAUNT_ARTIFACT_NATIVE_LINUX_X64_GNU_MANIFEST".to_owned(),
                "/tmp/native.toml".to_owned(),
            ),
        ])
        .unwrap();
        assert!(instructions.contains(&"cargo::rerun-if-changed=/tmp/broker.toml".to_owned()));
        assert!(instructions.contains(
            &"cargo::metadata=broker_linux_x64_gnu_manifest=/tmp/broker.toml".to_owned()
        ));
        assert!(instructions.contains(
            &"cargo::metadata=native_linux_x64_gnu_manifest=/tmp/native.toml".to_owned()
        ));
    }

    #[test]
    fn does_not_relay_its_own_downstream_metadata() {
        let instructions = relay_manifest_instructions([(
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_BROKER_HELPER_MANIFEST".to_owned(),
            "/tmp/broker.toml".to_owned(),
        )])
        .unwrap();
        assert!(instructions.is_empty());
    }

    #[test]
    fn rejects_conflicting_duplicate_keys() {
        let error = relay_manifest_instructions([
            (
                "DEP_OLIPHAUNT_ARTIFACT_BROKER_MANIFEST".to_owned(),
                "/tmp/one.toml".to_owned(),
            ),
            (
                "DEP_OLIPHAUNT_ARTIFACT_BROKER_MANIFEST".to_owned(),
                "/tmp/two.toml".to_owned(),
            ),
        ])
        .expect_err("conflicting duplicate metadata keys must fail");
        assert!(error.contains("conflicting Cargo artifact manifests"));
    }

    #[test]
    fn stages_checkout_query_core_and_rejects_a_stale_packaged_copy() {
        let (root, manifest, out) = query_core_fixture();
        let instructions = stage_query_core(&manifest, &out).unwrap();
        assert_eq!(
            fs::read(out.join(QUERY_CORE_OUTPUT)).unwrap(),
            b"canonical query core\n"
        );
        assert!(
            instructions
                .iter()
                .any(|line| line.starts_with("cargo::rerun-if-changed="))
        );
        assert!(
            instructions
                .iter()
                .any(|line| line.starts_with(&format!("cargo::rustc-env={QUERY_CORE_ENV}=")))
        );

        let packaged = manifest.join(PACKAGED_QUERY_CORE);
        let checkout = manifest.join(CHECKOUT_QUERY_CORE);
        fs::write(&packaged, b"canonical query core\n").unwrap();
        let instructions = stage_query_core(&manifest, &out).unwrap();
        for candidate in [&packaged, &checkout] {
            let candidate = fs::canonicalize(candidate).unwrap();
            assert!(
                instructions.contains(&format!("cargo::rerun-if-changed={}", candidate.display()))
            );
        }

        fs::write(packaged, b"stale query core\n").unwrap();
        let error = stage_query_core(&manifest, &out).unwrap_err();
        assert!(error.contains("is stale relative to"));
        fs::remove_dir_all(root).unwrap();
    }
}
