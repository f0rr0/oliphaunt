use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, bail, ensure};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasmer::sys::{EngineBuilder, Features, NativeEngineExt};
use wasmer::{Engine, Module};
use zstd::stream::read::Decoder as ZstdDecoder;

#[cfg(feature = "extensions")]
use super::extensions::Extension;
use super::timing;

const RUNTIME_ARTIFACT: &str = "runtime:pglite";
const EXPECTED_AOT_ENGINE: &str = "llvm-opta";
const EXPECTED_WASMER_VERSION: &str = "7.2.0-alpha.2";
const EXPECTED_WASMER_WASIX_VERSION: &str = "0.702.0-alpha.2";
const AOT_ENGINE_ID: &str = concat!(
    "engine=",
    "llvm-opta",
    ";wasmer=",
    "7.2.0-alpha.2",
    ";wasmer-wasix=",
    "0.702.0-alpha.2",
    ";cpu=generic-baseline"
);
const ZSTD_MAGIC: &[u8] = &[0x28, 0xb5, 0x2f, 0xfd];
const CACHE_RECEIPT_FORMAT_VERSION: u32 = 1;
static AOT_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HEADLESS_ENGINE: OnceLock<Engine> = OnceLock::new();
static INSTALLED_ARTIFACTS: OnceLock<Mutex<HashMap<String, InstalledArtifact>>> = OnceLock::new();
static MODULE_CACHE: OnceLock<Mutex<HashMap<String, Module>>> = OnceLock::new();

#[derive(Debug, Clone)]
struct InstalledArtifact {
    path: PathBuf,
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AotVerifyMode {
    Fast,
    Full,
}

pub(crate) fn headless_engine() -> Engine {
    HEADLESS_ENGINE
        .get_or_init(|| {
            let _phase = timing::phase("wasmer.headless_engine");
            let mut features = Features::new();
            features.exceptions(true);
            EngineBuilder::headless()
                .set_features(Some(features))
                .engine()
                .into()
        })
        .clone()
}

pub(crate) fn load_runtime_module() -> Result<(Engine, Module)> {
    let engine = headless_engine();
    let module = load_artifact_module(&engine, RUNTIME_ARTIFACT)?;
    Ok((engine, module))
}

pub(crate) fn engine_identity() -> &'static str {
    AOT_ENGINE_ID
}

pub(crate) fn preload_runtime_artifact() -> Result<()> {
    let _ = load_runtime_module()?;
    Ok(())
}

#[cfg(feature = "extensions")]
pub(crate) fn preload_extension_artifact(extension: Extension) -> Result<()> {
    let engine = headless_engine();
    let _ = load_extension_module(&engine, extension)?;
    Ok(())
}

#[cfg(feature = "extensions")]
pub(crate) fn load_extension_module(
    engine: &Engine,
    extension: Extension,
) -> Result<Option<Module>> {
    let Some(aot_name) = extension.aot_name() else {
        return Ok(None);
    };
    load_artifact_module(engine, aot_name).map(Some)
}

pub(crate) fn load_artifact_module(engine: &Engine, artifact_name: &str) -> Result<Module> {
    let artifact = install_artifact(artifact_name)?;
    let cache_key = format!("{artifact_name}:{}", artifact.sha256);
    let module_cache = MODULE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut modules = module_cache.lock().expect("AOT module cache poisoned");
    if let Some(module) = modules.get(&cache_key) {
        return Ok(module.clone());
    }

    let module = match deserialize_headless(engine, &artifact.path) {
        Ok(module) => module,
        Err(err) if aot_verify_mode()? == AotVerifyMode::Fast => {
            let _phase = timing::phase("aot.rebuild_after_deserialize_failure");
            forget_installed_artifact(artifact_name);
            remove_cached_artifact(&artifact.path)?;
            let artifact = rebuild_artifact(artifact_name).with_context(|| {
                format!("rebuild AOT artifact '{artifact_name}' after deserialize failure")
            })?;
            deserialize_headless(engine, &artifact.path).with_context(|| {
                format!(
                    "deserialize rebuilt Wasmer AOT artifact '{}' after initial failure: {err:#}",
                    artifact.path.display()
                )
            })?
        }
        Err(err) => return Err(err),
    };
    modules.insert(cache_key, module.clone());
    Ok(module)
}

#[cfg(feature = "extensions")]
pub(crate) fn load_pg_dump_module(engine: &Engine) -> Result<Module> {
    load_artifact_module(engine, "tool:pg_dump")
}

#[cfg(feature = "extensions")]
#[allow(dead_code)]
pub(crate) fn load_initdb_module(engine: &Engine) -> Result<Module> {
    load_artifact_module(engine, "tool:initdb")
}

pub(crate) fn install_external_artifact(name: &str, artifact_path: &Path) -> Result<String> {
    ensure!(
        !name.is_empty(),
        "external AOT artifact name must not be empty"
    );
    let hash = sha256_file(artifact_path)?;
    let cache_path = cache_path(name, &hash)?;

    let _guard = AOT_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("AOT install lock poisoned");

    if !cache_path.exists() {
        if let Some(parent) = cache_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create AOT cache directory {}", parent.display()))?;
        }
        let tmp_path =
            cache_path.with_extension(format!("bin.{}.{}.tmp", std::process::id(), tmp_suffix()));
        copy_file_atomic(artifact_path, &tmp_path, &cache_path)?;
    }

    remember_installed_artifact(
        name,
        InstalledArtifact {
            path: cache_path,
            sha256: hash.clone(),
        },
    );
    Ok(hash)
}

fn install_artifact(name: &str) -> Result<InstalledArtifact> {
    if let Some(artifact) = installed_artifact(name) {
        return Ok(artifact);
    }

    let _guard = AOT_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("AOT install lock poisoned");
    if let Some(artifact) = installed_artifact(name) {
        return Ok(artifact);
    }

    let manifest_artifact = {
        let _phase = timing::phase("aot.manifest_validation");
        target_manifest_artifact(name)?
    };
    let verify_mode = aot_verify_mode()?;

    if let Some(artifact) = cached_raw_artifact(name, &manifest_artifact, verify_mode)? {
        remember_installed_artifact(name, artifact.clone());
        return Ok(artifact);
    }

    let artifact = materialize_artifact(name, &manifest_artifact, verify_mode)?;
    remember_installed_artifact(name, artifact.clone());
    Ok(artifact)
}

fn rebuild_artifact(name: &str) -> Result<InstalledArtifact> {
    let _guard = AOT_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("AOT install lock poisoned");
    forget_installed_artifact(name);
    let manifest_artifact = {
        let _phase = timing::phase("aot.manifest_validation");
        target_manifest_artifact(name)?
    };
    let artifact = materialize_artifact(name, &manifest_artifact, aot_verify_mode()?)?;
    remember_installed_artifact(name, artifact.clone());
    Ok(artifact)
}

fn materialize_artifact(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    verify_mode: AotVerifyMode,
) -> Result<InstalledArtifact> {
    let _phase = timing::phase("aot.materialize");
    let raw = artifact_raw_bytes(name, manifest_artifact, verify_mode)?;
    let hash = expected_raw_hash(name, manifest_artifact, &raw, verify_mode)?;
    let cache_path = cache_path(name, &hash)?;
    remove_cached_artifact(&cache_path)?;

    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create AOT cache directory {}", parent.display()))?;
    }
    let tmp_path =
        cache_path.with_extension(format!("bin.{}.{}.tmp", std::process::id(), tmp_suffix()));
    fs::write(&tmp_path, raw)
        .with_context(|| format!("write AOT artifact {}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, &cache_path) {
        remove_file_if_exists(&tmp_path).ok();
        return Err(err).with_context(|| {
            format!(
                "promote AOT artifact {} -> {}",
                tmp_path.display(),
                cache_path.display()
            )
        });
    }

    write_cache_receipt(name, manifest_artifact, &cache_path, &hash)?;
    Ok(InstalledArtifact {
        path: cache_path,
        sha256: hash,
    })
}

fn cached_raw_artifact(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    verify_mode: AotVerifyMode,
) -> Result<Option<InstalledArtifact>> {
    let Some(raw_sha256) = manifest_artifact.raw_sha256.as_deref() else {
        return Ok(None);
    };
    let cache_path = cache_path(name, raw_sha256)?;
    if !cache_path.exists() {
        return Ok(None);
    }

    match verify_mode {
        AotVerifyMode::Fast => {
            let _phase = timing::phase("aot.cache_receipt_verify");
            if !cache_receipt_matches(name, manifest_artifact, &cache_path, raw_sha256)? {
                remove_cached_artifact(&cache_path)?;
                return Ok(None);
            }
        }
        AotVerifyMode::Full => {
            let _phase = timing::phase("aot.raw_cache_verify");
            let (actual, actual_size) = sha256_file_with_len(&cache_path)?;
            if !actual.eq_ignore_ascii_case(raw_sha256) {
                remove_cached_artifact(&cache_path)?;
                return Ok(None);
            }
            if let Some(raw_size) = manifest_artifact.raw_size {
                ensure!(
                    actual_size == raw_size,
                    "cached AOT artifact '{name}' raw size mismatch: manifest={raw_size} actual={}",
                    actual_size
                );
            }
        }
    }
    Ok(Some(InstalledArtifact {
        path: cache_path,
        sha256: raw_sha256.to_owned(),
    }))
}

fn installed_artifact(name: &str) -> Option<InstalledArtifact> {
    INSTALLED_ARTIFACTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("installed AOT artifact cache poisoned")
        .get(name)
        .filter(|artifact| artifact.path.exists())
        .cloned()
}

fn remember_installed_artifact(name: &str, artifact: InstalledArtifact) {
    INSTALLED_ARTIFACTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("installed AOT artifact cache poisoned")
        .insert(name.to_string(), artifact);
}

fn forget_installed_artifact(name: &str) {
    INSTALLED_ARTIFACTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("installed AOT artifact cache poisoned")
        .remove(name);
}

fn remove_cached_artifact(path: &Path) -> Result<()> {
    remove_file_if_exists(path)?;
    remove_file_if_exists(&receipt_path(path))
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("remove {}", path.display())),
    }
}

fn copy_file_atomic(source: &Path, tmp_path: &Path, target: &Path) -> Result<()> {
    let mut input = fs::File::open(source).with_context(|| format!("open {}", source.display()))?;
    let mut output =
        fs::File::create(tmp_path).with_context(|| format!("create {}", tmp_path.display()))?;
    std::io::copy(&mut input, &mut output)
        .with_context(|| format!("copy {} to {}", source.display(), tmp_path.display()))?;
    output
        .flush()
        .with_context(|| format!("flush {}", tmp_path.display()))?;
    if let Err(err) = fs::rename(tmp_path, target) {
        remove_file_if_exists(tmp_path).ok();
        return Err(err).with_context(|| {
            format!(
                "promote AOT artifact {} -> {}",
                tmp_path.display(),
                target.display()
            )
        });
    }
    Ok(())
}

fn tmp_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn artifact_raw_bytes(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    verify_mode: AotVerifyMode,
) -> Result<Vec<u8>> {
    let Some(bytes) = target_artifact_bytes(name) else {
        bail!(
            "no Wasmer LLVM AOT artifact named '{name}' is available for target {}; rebuild assets or disable this unsupported target",
            target_triple()
        );
    };
    if verify_mode == AotVerifyMode::Full {
        validate_compressed_artifact_manifest(name, manifest_artifact, bytes)?;
    }

    if bytes.starts_with(ZSTD_MAGIC) {
        let _phase = timing::phase("aot.decompress");
        let mut decoder = ZstdDecoder::new(Cursor::new(bytes))
            .with_context(|| format!("decode compressed AOT artifact '{name}'"))?;
        let mut raw = Vec::new();
        decoder
            .read_to_end(&mut raw)
            .with_context(|| format!("decompress AOT artifact '{name}'"))?;
        ensure!(
            !raw.is_empty(),
            "AOT artifact '{name}' decompressed to zero bytes"
        );
        Ok(raw)
    } else {
        Ok(bytes.to_vec())
    }
}

fn expected_raw_hash(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    raw: &[u8],
    verify_mode: AotVerifyMode,
) -> Result<String> {
    if let Some(raw_size) = manifest_artifact.raw_size {
        ensure!(
            raw.len() as u64 == raw_size,
            "AOT artifact '{name}' raw size mismatch: manifest={raw_size} actual={}",
            raw.len()
        );
    }

    let Some(raw_sha256) = &manifest_artifact.raw_sha256 else {
        ensure!(
            verify_mode == AotVerifyMode::Full,
            "AOT artifact '{name}' is missing raw-sha256 metadata; rebuild assets or set PGLITE_OXIDE_AOT_VERIFY=full for strict hash-derived cache keys"
        );
        return Ok(sha256_hex(raw));
    };
    if verify_mode == AotVerifyMode::Full {
        let actual = sha256_hex(raw);
        ensure!(
            actual.eq_ignore_ascii_case(raw_sha256),
            "AOT artifact '{name}' raw hash mismatch: manifest={raw_sha256} actual={actual}"
        );
    }
    Ok(raw_sha256.clone())
}

fn target_manifest_artifact(name: &str) -> Result<AotManifestArtifact> {
    let manifest = target_aot_manifest()?;
    ensure!(
        manifest.target_triple == target_triple(),
        "AOT manifest target mismatch: manifest={} actual={}",
        manifest.target_triple,
        target_triple()
    );
    ensure!(
        manifest.engine == EXPECTED_AOT_ENGINE,
        "AOT manifest engine mismatch: manifest={} expected={EXPECTED_AOT_ENGINE}",
        manifest.engine
    );
    ensure!(
        manifest.wasmer_version == EXPECTED_WASMER_VERSION,
        "AOT manifest Wasmer version mismatch: manifest={} expected={EXPECTED_WASMER_VERSION}",
        manifest.wasmer_version
    );
    ensure!(
        manifest.wasmer_wasix_version == EXPECTED_WASMER_WASIX_VERSION,
        "AOT manifest wasmer-wasix version mismatch: manifest={} expected={EXPECTED_WASMER_WASIX_VERSION}",
        manifest.wasmer_wasix_version
    );

    let artifact = manifest
        .artifacts
        .into_iter()
        .find(|artifact| artifact.name == name)
        .ok_or_else(|| anyhow::anyhow!("AOT manifest does not list artifact '{name}'"))?;
    #[cfg(feature = "bundled")]
    {
        let expected_module = super::assets::expected_module_sha256(name)?;
        ensure!(
            expected_module.eq_ignore_ascii_case(&artifact.module_sha256),
            "AOT artifact '{name}' source module hash mismatch: manifest={} assets={expected_module}",
            artifact.module_sha256
        );
    }

    Ok(artifact)
}

fn validate_compressed_artifact_manifest(
    name: &str,
    artifact: &AotManifestArtifact,
    bytes: &[u8],
) -> Result<()> {
    let actual_hash = sha256_hex(bytes);
    ensure!(
        actual_hash.eq_ignore_ascii_case(&artifact.sha256),
        "AOT artifact '{name}' hash mismatch: manifest={} actual={actual_hash}",
        artifact.sha256
    );
    Ok(())
}

fn target_aot_manifest() -> Result<AotManifest> {
    let Some(json) = target_aot_manifest_json() else {
        bail!(
            "no Wasmer LLVM AOT manifest is available for target {}; rebuild assets or disable this unsupported target",
            target_triple()
        );
    };
    serde_json::from_str(json).context("parse bundled AOT manifest")
}

fn cache_path(name: &str, hash: &str) -> Result<PathBuf> {
    let safe_name = name.replace([':', '/', '\\'], "-");
    let dirs = ProjectDirs::from("dev", "pglite-oxide", "pglite-oxide")
        .context("could not resolve pglite-oxide cache directory")?;
    Ok(dirs
        .cache_dir()
        .join("wasmer-aot")
        .join(target_triple())
        .join(format!("{safe_name}-{hash}.bin")))
}

fn receipt_path(cache_path: &Path) -> PathBuf {
    cache_path.with_extension("receipt.json")
}

fn cache_receipt_matches(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    cache_path: &Path,
    raw_sha256: &str,
) -> Result<bool> {
    let Some(raw_size) = manifest_artifact.raw_size else {
        return Ok(false);
    };
    let metadata = match fs::metadata(cache_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err).with_context(|| format!("stat {}", cache_path.display())),
    };
    if metadata.len() != raw_size {
        return Ok(false);
    }

    let receipt_path = receipt_path(cache_path);
    let receipt = match fs::read(&receipt_path) {
        Ok(bytes) => match serde_json::from_slice::<AotCacheReceipt>(&bytes) {
            Ok(receipt) => receipt,
            Err(_) => return Ok(false),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err).with_context(|| format!("read {}", receipt_path.display())),
    };

    Ok(receipt.format_version == CACHE_RECEIPT_FORMAT_VERSION
        && receipt.artifact_name == name
        && receipt.target_triple == target_triple()
        && receipt.engine == EXPECTED_AOT_ENGINE
        && receipt.wasmer_version == EXPECTED_WASMER_VERSION
        && receipt.wasmer_wasix_version == EXPECTED_WASMER_WASIX_VERSION
        && receipt.raw_sha256.eq_ignore_ascii_case(raw_sha256)
        && receipt.raw_size == raw_size
        && receipt
            .compressed_sha256
            .eq_ignore_ascii_case(&manifest_artifact.sha256)
        && receipt
            .module_sha256
            .eq_ignore_ascii_case(&manifest_artifact.module_sha256))
}

fn write_cache_receipt(
    name: &str,
    manifest_artifact: &AotManifestArtifact,
    cache_path: &Path,
    raw_sha256: &str,
) -> Result<()> {
    let Some(raw_size) = manifest_artifact.raw_size else {
        return Ok(());
    };
    let receipt = AotCacheReceipt {
        format_version: CACHE_RECEIPT_FORMAT_VERSION,
        artifact_name: name.to_owned(),
        target_triple: target_triple().to_owned(),
        engine: EXPECTED_AOT_ENGINE.to_owned(),
        wasmer_version: EXPECTED_WASMER_VERSION.to_owned(),
        wasmer_wasix_version: EXPECTED_WASMER_WASIX_VERSION.to_owned(),
        raw_sha256: raw_sha256.to_owned(),
        raw_size,
        compressed_sha256: manifest_artifact.sha256.clone(),
        module_sha256: manifest_artifact.module_sha256.clone(),
    };

    let path = receipt_path(cache_path);
    let tmp_path = path.with_extension(format!(
        "receipt.{}.{}.tmp",
        std::process::id(),
        tmp_suffix()
    ));
    let bytes = serde_json::to_vec(&receipt).context("serialize AOT cache receipt")?;
    fs::write(&tmp_path, bytes).with_context(|| format!("write {}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        remove_file_if_exists(&tmp_path).ok();
        return Err(err).with_context(|| format!("promote AOT cache receipt {}", path.display()));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    sha256_file_with_len(path).map(|(hash, _)| hash)
}

fn sha256_file_with_len(path: &Path) -> Result<(String, u64)> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut len = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        len += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), len))
}

fn aot_verify_mode() -> Result<AotVerifyMode> {
    let Some(value) = std::env::var_os("PGLITE_OXIDE_AOT_VERIFY") else {
        return Ok(AotVerifyMode::Fast);
    };
    let value = value.to_string_lossy().to_ascii_lowercase();
    match value.as_str() {
        "" | "fast" | "metadata" | "receipt" | "0" | "false" | "off" => Ok(AotVerifyMode::Fast),
        "full" | "sha" | "sha256" | "strict" | "1" | "true" | "on" => Ok(AotVerifyMode::Full),
        other => bail!("unsupported PGLITE_OXIDE_AOT_VERIFY={other}; use `fast` or `full`"),
    }
}

#[allow(unsafe_code)]
fn deserialize_headless(engine: &Engine, path: &Path) -> Result<Module> {
    let _phase = timing::phase("aot.deserialize");
    deserialize_headless_mmap(engine, path)
}

#[allow(unsafe_code)]
fn deserialize_headless_mmap(engine: &Engine, path: &Path) -> Result<Module> {
    let _phase = timing::phase("aot.deserialize.mmap");
    // SAFETY: same artifact ownership and cache-key constraints as the file
    // deserializer below. This path avoids reading the complete native artifact
    // into a Rust Vec before Wasmer deserializes it.
    unsafe {
        engine
            .deserialize_from_mmapped_file(path)
            .with_context(|| format!("mmap-deserialize Wasmer AOT artifact {}", path.display()))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unsupported"
}

fn target_artifact_bytes(_name: &str) -> Option<&'static [u8]> {
    #[cfg(all(feature = "bundled", target_os = "macos", target_arch = "aarch64"))]
    {
        return pglite_oxide_aot_aarch64_apple_darwin::artifact_bytes(_name);
    }
    #[cfg(all(feature = "bundled", target_os = "linux", target_arch = "x86_64"))]
    {
        return pglite_oxide_aot_x86_64_unknown_linux_gnu::artifact_bytes(_name);
    }
    #[cfg(all(feature = "bundled", target_os = "linux", target_arch = "aarch64"))]
    {
        return pglite_oxide_aot_aarch64_unknown_linux_gnu::artifact_bytes(_name);
    }
    #[cfg(all(feature = "bundled", target_os = "windows", target_arch = "x86_64"))]
    {
        return pglite_oxide_aot_x86_64_pc_windows_msvc::artifact_bytes(_name);
    }
    #[allow(unreachable_code)]
    None
}

fn target_aot_manifest_json() -> Option<&'static str> {
    #[cfg(all(feature = "bundled", target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(pglite_oxide_aot_aarch64_apple_darwin::MANIFEST_JSON);
    }
    #[cfg(all(feature = "bundled", target_os = "linux", target_arch = "x86_64"))]
    {
        return Some(pglite_oxide_aot_x86_64_unknown_linux_gnu::MANIFEST_JSON);
    }
    #[cfg(all(feature = "bundled", target_os = "linux", target_arch = "aarch64"))]
    {
        return Some(pglite_oxide_aot_aarch64_unknown_linux_gnu::MANIFEST_JSON);
    }
    #[cfg(all(feature = "bundled", target_os = "windows", target_arch = "x86_64"))]
    {
        return Some(pglite_oxide_aot_x86_64_pc_windows_msvc::MANIFEST_JSON);
    }
    #[allow(unreachable_code)]
    None
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifest {
    target_triple: String,
    engine: String,
    wasmer_version: String,
    wasmer_wasix_version: String,
    artifacts: Vec<AotManifestArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct AotManifestArtifact {
    name: String,
    sha256: String,
    #[allow(dead_code)]
    module_sha256: String,
    raw_sha256: Option<String>,
    raw_size: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
struct AotCacheReceipt {
    format_version: u32,
    artifact_name: String,
    target_triple: String,
    engine: String,
    wasmer_version: String,
    wasmer_wasix_version: String,
    raw_sha256: String,
    raw_size: u64,
    compressed_sha256: String,
    module_sha256: String,
}
