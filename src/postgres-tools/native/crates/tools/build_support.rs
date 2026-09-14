use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const ARTIFACT_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const ARTIFACT_ENV_SUFFIX: &str = "_MANIFEST";
const RELAY_ENV_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_OLIPHAUNT_TOOLS_RELAY_";

pub(crate) fn packaged_tools_dir(
    variables: &[(String, String)],
) -> Result<Option<PathBuf>, String> {
    let mut resolved: Option<PathBuf> = None;
    for (key, manifest) in variables {
        if !key.starts_with(ARTIFACT_ENV_PREFIX)
            || !key.ends_with(ARTIFACT_ENV_SUFFIX)
            || key.starts_with(RELAY_ENV_PREFIX)
            || !key.contains("_OLIPHAUNT_TOOLS_")
            || manifest.is_empty()
        {
            continue;
        }
        let manifest = Path::new(manifest);
        let directory = manifest
            .parent()
            .ok_or_else(|| {
                format!(
                    "native tools artifact manifest has no parent directory: {}",
                    manifest.display()
                )
            })?
            .join("payload/runtime");
        if !is_tool_executable_file(&directory, "pg_dump")
            || !is_tool_executable_file(&directory, "psql")
            || !is_tool_executable_file(&directory, "pg_basebackup")
        {
            return Err(format!(
                "native tools artifact has no complete pg_dump/psql/pg_basebackup runtime: {}",
                directory.display()
            ));
        }
        if let Some(previous) = &resolved
            && previous != &directory
        {
            return Err(format!(
                "conflicting native tools artifact roots: {} and {}",
                previous.display(),
                directory.display()
            ));
        }
        resolved = Some(directory);
    }
    Ok(resolved)
}

fn is_tool_executable_file(runtime: &Path, name: &str) -> bool {
    let bin = runtime.join("bin");
    bin.join(name).is_file() || bin.join(format!("{name}.exe")).is_file()
}

pub(crate) fn relay_manifest_instructions<I>(vars: I) -> Result<Vec<String>, String>
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
    fn re_emits_target_tool_manifest() {
        let instructions = relay_manifest_instructions([(
            "DEP_OLIPHAUNT_ARTIFACT_OLIPHAUNT_TOOLS_LINUX_X64_GNU_MANIFEST".to_owned(),
            "/tmp/tools.toml".to_owned(),
        )])
        .unwrap();
        assert!(instructions.contains(&"cargo::rerun-if-changed=/tmp/tools.toml".to_owned()));
        assert!(instructions.contains(
            &"cargo::metadata=oliphaunt_tools_linux_x64_gnu_manifest=/tmp/tools.toml".to_owned()
        ));
    }

    #[test]
    fn ignores_own_downstream_metadata() {
        let instructions = relay_manifest_instructions([(
            "DEP_OLIPHAUNT_ARTIFACT_OLIPHAUNT_TOOLS_RELAY_MANIFEST".to_owned(),
            "/tmp/tools.toml".to_owned(),
        )])
        .unwrap();
        assert!(instructions.is_empty());
    }

    #[test]
    fn locates_complete_runtime_beside_the_dependency_manifest() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-tools-build-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manifest = root.join("out/oliphaunt-artifact.toml");
        let runtime = root.join("out/payload/runtime");
        std::fs::create_dir_all(runtime.join("bin")).unwrap();
        std::fs::write(&manifest, "product = \"oliphaunt-tools\"\n").unwrap();
        for tool in ["pg_dump", "psql", "pg_basebackup"] {
            std::fs::write(runtime.join("bin").join(tool), b"fixture").unwrap();
        }

        let variables = vec![(
            "DEP_OLIPHAUNT_ARTIFACT_OLIPHAUNT_TOOLS_LINUX_X64_GNU_MANIFEST".to_owned(),
            manifest.display().to_string(),
        )];
        assert_eq!(packaged_tools_dir(&variables).unwrap(), Some(runtime));
        std::fs::remove_dir_all(root).unwrap();
    }
}
