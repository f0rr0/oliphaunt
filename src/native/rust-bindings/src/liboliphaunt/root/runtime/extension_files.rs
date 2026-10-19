use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};
use crate::extension::{Extension, extension_data_files};

pub(super) struct ExtensionFiles {
    pub sql_members: Vec<String>,
    pub module_files: Vec<String>,
    pub data_files: Vec<String>,
}

pub(super) fn manifest_path(root: &Path, extension: Extension) -> PathBuf {
    root.join(".oliphaunt/extensions")
        .join(format!("{}.properties", extension.sql_name()))
}

pub(super) fn extension_files(
    install_dir: &Path,
    root: &Path,
    extension: Extension,
) -> Result<ExtensionFiles> {
    let manifest = manifest_path(root, extension);
    match fs::read_to_string(&manifest) {
        Ok(text) => parse(&text, extension),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let current = root == install_dir;
            Ok(ExtensionFiles {
                sql_members: if current {
                    extension
                        .sql_members()
                        .iter()
                        .map(|value| (*value).to_owned())
                        .collect()
                } else if extension.creates_extension() {
                    vec![extension.sql_name().to_owned()]
                } else {
                    Vec::new()
                },
                module_files: if current {
                    extension.native_module_files()
                } else {
                    extension.native_module_file().into_iter().collect()
                },
                data_files: if current {
                    extension_data_files(extension)
                } else {
                    legacy_data_files(extension)
                }
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            })
        }
        Err(error) => Err(Error::Engine(format!(
            "read extension manifest {}: {error}",
            manifest.display()
        ))),
    }
}

// Independent packages predating frozen manifests shipped core PostGIS and
// PROJ only. Keep their data contract independent of newly added raster assets.
fn legacy_data_files(extension: Extension) -> &'static [&'static str] {
    if extension.sql_name() == "postgis" {
        &[
            "contrib/postgis-3.6/legacy.sql",
            "contrib/postgis-3.6/legacy_gist.sql",
            "contrib/postgis-3.6/legacy_minimal.sql",
            "contrib/postgis-3.6/postgis.sql",
            "contrib/postgis-3.6/postgis_upgrade.sql",
            "contrib/postgis-3.6/spatial_ref_sys.sql",
            "contrib/postgis-3.6/uninstall_legacy.sql",
            "contrib/postgis-3.6/uninstall_postgis.sql",
            "proj/proj.db",
        ]
    } else {
        extension_data_files(extension)
    }
}

fn parse(text: &str, extension: Extension) -> Result<ExtensionFiles> {
    let invalid = || {
        Error::Engine(format!(
            "invalid native extension file manifest for {}",
            extension.sql_name()
        ))
    };
    let mut fields = BTreeMap::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=').ok_or_else(invalid)?;
        if fields.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    if fields.get("sqlName") != Some(&extension.sql_name())
        || fields.contains_key("sqlMembers") != fields.contains_key("nativeModuleStems")
    {
        return Err(invalid());
    }
    let csv = |key: &str, fallback: Vec<String>| -> Result<Vec<String>> {
        let Some(value) = fields.get(key) else {
            return Ok(fallback);
        };
        if value.is_empty() {
            return Ok(Vec::new());
        }
        let values = value.split(',').map(str::to_owned).collect::<Vec<_>>();
        if values.iter().any(String::is_empty)
            || values.iter().collect::<BTreeSet<_>>().len() != values.len()
        {
            return Err(invalid());
        }
        Ok(values)
    };
    let portable = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    let sql_members = csv(
        "sqlMembers",
        if extension.creates_extension() {
            vec![extension.sql_name().to_owned()]
        } else {
            Vec::new()
        },
    )?;
    let stems = csv(
        "nativeModuleStems",
        extension
            .native_module_stem()
            .map(str::to_owned)
            .into_iter()
            .collect(),
    )?;
    if sql_members
        .iter()
        .chain(&stems)
        .any(|value| !portable(value))
        || (extension.creates_extension()
            && !sql_members.iter().any(|name| name == extension.sql_name()))
        || extension
            .native_module_stem()
            .is_some_and(|primary| !stems.iter().any(|stem| stem == primary))
    {
        return Err(invalid());
    }
    let data_files = csv(
        "dataFiles",
        if fields.contains_key("sqlMembers") {
            extension_data_files(extension)
        } else {
            legacy_data_files(extension)
        }
        .iter()
        .map(|value| (*value).to_owned())
        .collect(),
    )?;
    if data_files.iter().any(|file| {
        file.contains(['\\', ':'])
            || Path::new(file)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
    }) {
        return Err(invalid());
    }
    Ok(ExtensionFiles {
        sql_members,
        module_files: stems
            .into_iter()
            .map(|stem| format!("{stem}{}", std::env::consts::DLL_SUFFIX))
            .collect(),
        data_files,
    })
}

pub(super) fn cache_extension_files(root: &Path, extension: Extension) -> Result<ExtensionFiles> {
    let path = manifest_path(root, extension);
    let text = fs::read_to_string(&path).map_err(|error| {
        Error::Engine(format!(
            "read cached extension manifest {}: {error}",
            path.display()
        ))
    })?;
    parse(&text, extension)
}

pub(super) fn write_cache_extension_files(
    root: &Path,
    extension: Extension,
    files: &ExtensionFiles,
) -> Result<()> {
    let path = manifest_path(root, extension);
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| {
        Error::Engine(format!(
            "create cached extension manifest directory: {error}"
        ))
    })?;
    let stems = files
        .module_files
        .iter()
        .map(|file| file.strip_suffix(std::env::consts::DLL_SUFFIX).unwrap())
        .collect::<Vec<_>>();
    fs::write(
        &path,
        format!(
            "sqlName={}\nsqlMembers={}\nnativeModuleStems={}\ndataFiles={}\n",
            extension.sql_name(),
            files.sql_members.join(","),
            stems.join(","),
            files.data_files.join(",")
        ),
    )
    .map_err(|error| {
        Error::Engine(format!(
            "write cached extension manifest {}: {error}",
            path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_extension_contract_rejects_incomplete_or_unsafe_metadata() {
        for fields in [
            "sqlMembers=postgis\n",
            "sqlMembers=postgis\nnativeModuleStems=../../postgis-3\n",
            "sqlMembers=postgis,postgis\nnativeModuleStems=postgis-3\n",
            "sqlMembers=postgis_topology\nnativeModuleStems=postgis-3\n",
            "sqlMembers=postgis\nnativeModuleStems=postgis_topology-3\n",
            "sqlMembers=postgis\nnativeModuleStems=postgis-3\ndataFiles=../outside\n",
            "sqlMembers=postgis\nnativeModuleStems=postgis-3\nsqlMembers=postgis\n",
        ] {
            assert!(
                parse(&format!("sqlName=postgis\n{fields}"), Extension::POSTGIS).is_err(),
                "accepted {fields}"
            );
        }
    }
}
