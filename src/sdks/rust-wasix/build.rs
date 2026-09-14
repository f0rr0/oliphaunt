use std::collections::BTreeMap;
use std::env;

const ARTIFACT_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const ARTIFACT_ENV_SUFFIX: &str = "_MANIFEST";
const RELAY_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_WASIX_RELAY_";

fn main() {
    match relay_manifest_instructions(env::vars()) {
        Ok(instructions) => {
            for instruction in instructions {
                println!("{instruction}");
            }
        }
        Err(error) => {
            println!("cargo::error={error}");
            panic!("oliphaunt-wasix artifact relay failed: {error}");
        }
    }
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

    #[test]
    fn re_emits_runtime_and_aot_manifests() {
        let instructions = relay_manifest_instructions([
            (
                "DEP_OLIPHAUNT_ARTIFACT_LIBOLIPHAUNT_WASIX_RUNTIME_MANIFEST".to_owned(),
                "/tmp/runtime.toml".to_owned(),
            ),
            (
                "DEP_OLIPHAUNT_ARTIFACT_LIBOLIPHAUNT_WASIX_AOT_LINUX_X64_GNU_MANIFEST".to_owned(),
                "/tmp/aot.toml".to_owned(),
            ),
        ])
        .unwrap();
        assert!(instructions.contains(
            &"cargo::metadata=liboliphaunt_wasix_runtime_manifest=/tmp/runtime.toml".to_owned()
        ));
        assert!(
            instructions.contains(
                &"cargo::metadata=liboliphaunt_wasix_aot_linux_x64_gnu_manifest=/tmp/aot.toml"
                    .to_owned()
            )
        );
    }

    #[test]
    fn ignores_own_downstream_metadata() {
        let instructions = relay_manifest_instructions([(
            "DEP_OLIPHAUNT_ARTIFACT_WASIX_RELAY_LIBOLIPHAUNT_WASIX_RUNTIME_MANIFEST".to_owned(),
            "/tmp/runtime.toml".to_owned(),
        )])
        .unwrap();
        assert!(instructions.is_empty());
    }
}
