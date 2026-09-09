//! Loads installed extension dependencies. These packages are trusted native
//! dependencies, like the addon itself; this is not a loader for remote or
//! caller-supplied serialized code. Artifact hashes come from the installed
//! package manifests, never from the database's configuration or stored files.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use napi::{Error, Result};
use napi_derive::napi;
use oliphaunt_wasix::{Extension, ExtensionPackage};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[napi(object)]
pub struct NativeExtensionPackage {
    pub sql_name: String,
    pub product: String,
    pub version: String,
    pub package_json: String,
    pub aot_package_json: Option<String>,
}

#[napi(object)]
pub struct NativeToolPackage {
    pub package_json: String,
    pub aot_package_json: String,
}

#[cfg(feature = "tools")]
#[napi(js_name = "registerTools", catch_unwind)]
pub fn register_tools(selection: NativeToolPackage) -> Result<()> {
    let (root, manifest) = package(&selection.package_json)?;
    let metadata = &manifest["oliphaunt"];
    let version = string(&manifest, "version")?;
    let name = "@oliphaunt/liboliphaunt-wasix-tools";
    if string(&manifest, "name")? != name
        || version != super::RUNTIME_VERSION
        || string(metadata, "kind")? != "wasix-tools"
        || string(metadata, "runtimeVersion")? != super::RUNTIME_VERSION
    {
        return Err(fail("installed tools package does not match the runtime"));
    }
    let mut modules = Vec::new();
    for name in ["pg_dump", "psql"] {
        let module = &metadata["tools"][name];
        let hash = string(module, "sha256")?;
        let bytes = payload(&root, string(module, "path")?, hash)?;
        if module["size"].as_u64() != Some(bytes.len() as u64) {
            return Err(fail("installed tool module size mismatch"));
        }
        modules.push((name, bytes, hash.to_owned()));
    }
    let expected_name = format!("{name}-{}", target());
    let (aot_root, aot_package) = package(&selection.aot_package_json)?;
    let aot_metadata = &aot_package["oliphaunt"];
    if string(&aot_package, "name")? != expected_name
        || string(&aot_package, "version")? != version
        || string(aot_metadata, "kind")? != "wasix-tools-aot"
        || string(aot_metadata, "target")? != target()
        || string(aot_metadata, "runtimeVersion")? != super::RUNTIME_VERSION
        || manifest["optionalDependencies"][&expected_name].as_str() != Some(version)
    {
        return Err(fail(
            "installed tools AOT package does not match its owner or host",
        ));
    }
    let manifest_bytes = payload(
        &aot_root,
        "aot-manifest.json",
        string(aot_metadata, "manifestSha256")?,
    )?;
    let aot = json(&manifest_bytes)?;
    let mut artifacts = Vec::new();
    for artifact in aot["artifacts"]
        .as_array()
        .ok_or_else(|| fail("tools AOT artifacts missing"))?
    {
        let name = string(artifact, "name")?;
        if !["tool:pg_dump", "tool:psql"].contains(&name) {
            return Err(fail("tools AOT contains unrelated code"));
        }
        artifacts.push((
            name.to_owned(),
            payload(
                &aot_root,
                string(artifact, "path")?,
                string(artifact, "sha256")?,
            )?,
        ));
    }
    let key = format!(
        "tools@{version}:{:x}:{}",
        Sha256::digest(&manifest_bytes),
        modules
            .iter()
            .map(|(_, _, hash)| hash.as_str())
            .collect::<Vec<_>>()
            .join(":")
    );
    let mut packages = PACKAGES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| fail("package cache poisoned"))?;
    let package = if let Some(package) = packages.get(&key) {
        **package
    } else {
        let modules = Box::leak(
            modules
                .into_iter()
                .map(|(name, bytes, hash)| {
                    (
                        name,
                        &*Box::leak(bytes.into_boxed_slice()),
                        &*Box::leak(hash.into_boxed_str()),
                    )
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let artifacts = Box::leak(
            artifacts
                .into_iter()
                .map(|(name, bytes)| {
                    (
                        &*Box::leak(name.into_boxed_str()),
                        &*Box::leak(bytes.into_boxed_slice()),
                    )
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        // SAFETY: the host explicitly imports these installed native dependencies.
        // Validate exact package ownership and all file identities before handing
        // the trusted artifacts to the runtime's engine and module checks.
        let package = unsafe {
            ExtensionPackage::from_trusted_release(
                "oliphaunt-wasix-tools",
                Box::leak(version.to_owned().into_boxed_str()),
                super::RUNTIME_VERSION,
                modules,
                Box::leak(
                    String::from_utf8(manifest_bytes)
                        .map_err(|_| fail("invalid tools AOT UTF-8"))?
                        .into_boxed_str(),
                ),
                artifacts,
            )
        };
        packages.insert(key, Box::leak(Box::new(package)));
        package
    };
    oliphaunt_wasix::tools::register_installed_package(package)
        .map_err(|error| fail(error.to_string()))
}

static PACKAGES: OnceLock<Mutex<BTreeMap<String, &'static ExtensionPackage>>> = OnceLock::new();

fn fail(message: impl Into<String>) -> Error {
    super::invalid_argument(message)
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| fail(format!("installed extension manifest is missing {key}")))
}

fn json(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice(bytes)
        .map_err(|error| fail(format!("invalid installed extension manifest: {error}")))
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|error| {
        fail(format!(
            "read installed extension {}: {error}",
            path.display()
        ))
    })
}

fn package(path: &str) -> Result<(PathBuf, Value)> {
    let path = Path::new(path);
    if !path.is_absolute() || path.file_name().is_none_or(|name| name != "package.json") {
        return Err(fail(
            "extension package must identify an installed absolute package.json path",
        ));
    }
    let path = fs::canonicalize(path)
        .map_err(|error| fail(format!("resolve installed extension package: {error}")))?;
    let root = path
        .parent()
        .ok_or_else(|| fail("extension package has no root"))?
        .to_owned();
    Ok((root, json(&read(&path)?)?))
}

fn payload(root: &Path, relative: &str, expected: &str) -> Result<Vec<u8>> {
    let path = Path::new(relative);
    if relative.contains('\\')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(fail("extension package contains an unsafe payload path"));
    }
    let path = fs::canonicalize(root.join(path))
        .map_err(|error| fail(format!("resolve extension payload: {error}")))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(fail("extension payload escapes its installed package"));
    }
    let bytes = read(&path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(fail(format!(
            "installed extension payload hash mismatch: {relative}"
        )));
    }
    Ok(bytes)
}

fn target() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "linux-x64-gnu";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "linux-arm64-gnu";
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "macos-arm64";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x64-msvc";
    }
    #[allow(unreachable_code)]
    "unsupported"
}

pub(super) fn load(selection: NativeExtensionPackage) -> Result<Extension> {
    let extension = Extension::by_sql_name(&selection.sql_name)
        .ok_or_else(|| fail("unknown selected WASIX extension"))?;
    let expected_product = format!(
        "oliphaunt-extension-{}",
        selection.sql_name.replace('_', "-")
    );
    if selection.product != expected_product {
        return Err(fail(
            "external extension descriptor has the wrong release product",
        ));
    }
    let expected_package = format!(
        "@oliphaunt/{}-wasix",
        &selection.product["oliphaunt-".len()..]
    );
    let (root, manifest) = package(&selection.package_json)?;
    let metadata = &manifest["oliphaunt"];
    if string(&manifest, "name")? != expected_package
        || string(&manifest, "version")? != selection.version
        || string(metadata, "product")? != selection.product
        || string(metadata, "kind")? != "exact-extension-wasix"
        || string(metadata, "runtime")? != "wasix"
        || string(metadata, "wasixRuntimeProduct")? != "liboliphaunt-wasix"
        || string(metadata, "wasixRuntimeVersion")? != super::RUNTIME_VERSION
    {
        return Err(fail(
            "selected extension does not match its installed package or runtime",
        ));
    }
    let carrier = &metadata["carriers"][&selection.sql_name];
    let archive_hash = string(carrier, "sha256")?;
    let archive = payload(&root, string(carrier, "path")?, archive_hash)?;
    if carrier["size"].as_u64() != Some(archive.len() as u64) {
        return Err(fail("installed extension archive size mismatch"));
    }
    let needs_aot = carrier["requiresAot"]
        .as_bool()
        .ok_or_else(|| fail("extension carrier is missing requiresAot"))?;
    let mut aot_manifest = String::new();
    let mut artifacts = Vec::new();
    if needs_aot {
        let (aot_root, aot_package) = package(
            selection
                .aot_package_json
                .as_deref()
                .ok_or_else(|| fail("selected extension is missing its host AOT package"))?,
        )?;
        let expected_aot_package = format!("{expected_package}-{}", target());
        let aot_metadata = &aot_package["oliphaunt"];
        if string(&aot_package, "name")? != expected_aot_package
            || string(&aot_package, "version")? != selection.version
            || string(aot_metadata, "product")? != selection.product
            || string(aot_metadata, "kind")? != "wasix-extension-aot"
            || string(aot_metadata, "target")? != target()
            || string(aot_metadata, "runtimeVersion")? != super::RUNTIME_VERSION
            || manifest["optionalDependencies"][&expected_aot_package].as_str()
                != Some(selection.version.as_str())
        {
            return Err(fail(
                "extension AOT package does not match its owner, version, runtime, or host",
            ));
        }
        let bytes = payload(
            &aot_root,
            "aot-manifest.json",
            string(aot_metadata, "manifestSha256")?,
        )?;
        let aot = json(&bytes)?;
        for artifact in aot["artifacts"]
            .as_array()
            .ok_or_else(|| fail("extension AOT artifacts missing"))?
        {
            let name = string(artifact, "name")?;
            let prefix = format!("extension:{}", selection.sql_name);
            if name != prefix && !name.starts_with(&format!("{prefix}:")) {
                return Err(fail(
                    "extension AOT package contains another extension's code",
                ));
            }
            artifacts.push((
                name.to_owned(),
                payload(
                    &aot_root,
                    string(artifact, "path")?,
                    string(artifact, "sha256")?,
                )?,
            ));
        }
        aot_manifest =
            String::from_utf8(bytes).map_err(|_| fail("extension AOT manifest is not UTF-8"))?;
    } else if selection.aot_package_json.is_some() {
        return Err(fail("SQL-only extension must not supply an AOT package"));
    }
    let key = format!(
        "{}@{}:{archive_hash}:{:x}",
        selection.product,
        selection.version,
        Sha256::digest(aot_manifest.as_bytes())
    );
    let mut packages = PACKAGES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| fail("extension package cache poisoned"))?;
    if let Some(package) = packages.get(&key) {
        return Ok(extension.with_package(package));
    }
    // Match the lifetime of imported native modules. Only validated packages
    // are retained, once per exact content identity, across worker environments.
    let archives = Box::leak(
        vec![(
            &*Box::leak(selection.sql_name.into_boxed_str()),
            &*Box::leak(archive.into_boxed_slice()),
            &*Box::leak(archive_hash.to_owned().into_boxed_str()),
        )]
        .into_boxed_slice(),
    );
    let artifacts = Box::leak(
        artifacts
            .into_iter()
            .map(|(name, bytes)| {
                (
                    &*Box::leak(name.into_boxed_str()),
                    &*Box::leak(bytes.into_boxed_slice()),
                )
            })
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    // SAFETY: this FFI loader accepts installed native package dependencies from
    // the host package resolver, under the same trust as importing their code.
    // It never accepts remote assets or a caller's executable bytes/digest pair.
    // Owner, exact version, host, runtime and all package-owned file identities
    // have been checked above; the runtime additionally validates AOT engine,
    // source fingerprint, raw bytes and WebAssembly identity before deserializing.
    let package = unsafe {
        ExtensionPackage::from_trusted_release(
            Box::leak(selection.product.into_boxed_str()),
            Box::leak(selection.version.into_boxed_str()),
            super::RUNTIME_VERSION,
            archives,
            Box::leak(aot_manifest.into_boxed_str()),
            artifacts,
        )
    };
    let package = Box::leak(Box::new(package));
    packages.insert(key, package);
    Ok(extension.with_package(package))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_package_checks_owner_version_hash_and_containment() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-installed-extension-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("extensions/pgtap")).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let mut manifest = serde_json::json!({
            "name": "@oliphaunt/extension-pgtap-wasix", "version": "1.3.4",
            "oliphaunt": { "product": "oliphaunt-extension-pgtap", "kind": "exact-extension-wasix",
                "runtime": "wasix", "wasixRuntimeProduct": "liboliphaunt-wasix", "wasixRuntimeVersion": super::super::RUNTIME_VERSION,
                "carriers": { "pgtap": { "path": "extensions/pgtap/extension.tar.zst", "sha256": hash, "size": 7, "requiresAot": false } } }
        });
        let package_file = root.join("package.json");
        let selection = || NativeExtensionPackage {
            sql_name: "pgtap".into(),
            product: "oliphaunt-extension-pgtap".into(),
            version: "1.3.4".into(),
            package_json: package_file.to_str().unwrap().into(),
            aot_package_json: None,
        };
        fs::write(root.join("extensions/pgtap/extension.tar.zst"), b"fixture").unwrap();
        fs::write(&package_file, manifest.to_string()).unwrap();
        assert_eq!(load(selection()).unwrap().sql_name(), "pgtap");
        #[cfg(feature = "tools")]
        assert!(
            register_tools(NativeToolPackage {
                package_json: package_file.to_str().unwrap().into(),
                aot_package_json: package_file.to_str().unwrap().into(),
            })
            .unwrap_err()
            .to_string()
            .contains("does not match")
        );
        fs::write(root.join("extensions/pgtap/extension.tar.zst"), b"corrupt").unwrap();
        assert!(
            load(selection())
                .unwrap_err()
                .to_string()
                .contains("hash mismatch")
        );
        manifest["version"] = "1.3.5".into();
        fs::write(&package_file, manifest.to_string()).unwrap();
        assert!(
            load(selection())
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        assert!(
            payload(&root, "../package.json", &hash)
                .unwrap_err()
                .to_string()
                .contains("unsafe payload path")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
