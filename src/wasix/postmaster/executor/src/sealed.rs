//! Exact-five sealed carrier admission and immutable lazy AOT activation.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::{Context, Error, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasmer::{
    Engine, Module,
    sys::{NativeEngineExt, PendingModuleActivation},
};
use wasmer_types::{ModuleHash, target::Target};
use wasmer_wasix::{
    IntrinsicFileImmutability, intrinsic_file_immutability,
    runtime::{
        module_cache::{CacheError, ModuleCache},
        sealed_loader_audit::{
            FileAdviceAudit, FileResidencyAudit, advise_file_away, advise_file_for_one_shot_read,
            file_residency,
        },
    },
};

use crate::SEALED_MODULE_TRANSFORMATION_ID;
#[cfg(feature = "memory-profile-core")]
use crate::memory_profile::validate_serialized_memory_plans;

const MANIFEST_SCHEMA: &str = "oliphaunt.wasix-postmaster.sealed-aot.v5";
const MANIFEST_FORMAT_VERSION: u32 = 6;
const ARTIFACT_ABI_VERSION: u32 = 21;
const LINEAR_MEMORY_INSTALL_RECEIPT_SCHEMA: &str =
    "oliphaunt.wasix-postmaster.linear-memory-install.v1";
const SEALED_EXPORT_RECEIPT_PATH: &str =
    "share/postgresql/wasix-postmaster.sealed-export.structure.receipt";
const SEALED_EXPORT_SEED_PROOF_PATH: &str =
    "share/postgresql/wasix-postmaster.sealed-export.seed-proof.json";
const SEALED_EXPORT_FINAL_PROOF_PATH: &str =
    "share/postgresql/wasix-postmaster.sealed-export.final-proof.json";
const SEALED_EXPORT_ALLOWLIST_PATH: &str =
    "share/postgresql/wasix-postmaster.sealed-export.allowlist";
const SEALED_EXPORT_RECEIPT_SCHEMA: &str = "oliphaunt.wasix-postmaster.sealed-export-structure.v1";
const SEALED_EXPORT_PROOF_SCHEMA: &str =
    "oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2";
const SEALED_EXPORT_POLICY_ID: &str = "oliphaunt.wasix-postmaster.sealed-export-closure.v1";
const SEALED_EXPORT_MANDATORY_POLICY_SHA256: &str =
    "a129bd8c380dfd148bfcd96ca4f008ac1db7976b2565bae43fea382b249f4575";
const SEALED_EXPORT_DLSYM_POLICY_SHA256: &str =
    "b695f84830efdf23cb0cc2b025dc6d0e59645139272063f4e717303c201b1637";
const SEALED_EXPORT_SIDE_MANIFEST_SHA256: &str =
    "d2759bb82f0b17f6d6314fd72b500d92a7b7c2fc5f3755fffa277038ed515b55";
const LINEAR_MEMORY_PROFILE_ID: &str =
    "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1";
const LINEAR_MEMORY_MAXIMUM_PAGES: u32 = 4_096;
const LINEAR_MEMORY_MAXIMUM_BYTES: u64 = 268_435_456;
const LINEAR_MEMORY_STATIC_BOUND_PAGES: u32 = 65_536;
const LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES: u64 = 2_147_483_648;
const MAX_LINEAR_MEMORY_RECEIPT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SEALED_EXPORT_PROOF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const SEALED_EXPORT_SIDE_PATHS: [&str; 27] = [
    "lib/libpq.so.5.18",
    "lib/postgresql/cyrillic_and_mic.so",
    "lib/postgresql/dict_snowball.so",
    "lib/postgresql/euc2004_sjis2004.so",
    "lib/postgresql/euc_cn_and_mic.so",
    "lib/postgresql/euc_jp_and_sjis.so",
    "lib/postgresql/euc_kr_and_mic.so",
    "lib/postgresql/euc_tw_and_big5.so",
    "lib/postgresql/latin2_and_win1250.so",
    "lib/postgresql/latin_and_mic.so",
    "lib/postgresql/plpgsql.so",
    "lib/postgresql/utf8_and_big5.so",
    "lib/postgresql/utf8_and_cyrillic.so",
    "lib/postgresql/utf8_and_euc2004.so",
    "lib/postgresql/utf8_and_euc_cn.so",
    "lib/postgresql/utf8_and_euc_jp.so",
    "lib/postgresql/utf8_and_euc_kr.so",
    "lib/postgresql/utf8_and_euc_tw.so",
    "lib/postgresql/utf8_and_gb18030.so",
    "lib/postgresql/utf8_and_gbk.so",
    "lib/postgresql/utf8_and_iso8859.so",
    "lib/postgresql/utf8_and_iso8859_1.so",
    "lib/postgresql/utf8_and_johab.so",
    "lib/postgresql/utf8_and_sjis.so",
    "lib/postgresql/utf8_and_sjis2004.so",
    "lib/postgresql/utf8_and_uhc.so",
    "lib/postgresql/utf8_and_win.so",
];
const EXPECTED_WASM_FEATURES: [&str; 2] = ["exceptions", "threads"];
const WASIX_POSTMASTER_SOURCE_LANE: &str = "wasix-postmaster";
const WASIX_POSTMASTER_ENTRYPOINT: &str = "runtime:postgres";
const REQUIRE_ZERO_WRITE_AOT_ENV: &str = "OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT";
const SEALED_LOADER_AUDIT_FILE_ENV: &str = "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CODE_MEMORY_STATE_DIRECTORY: &str = ".oliphaunt-wasix-postmaster-code-memory-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SealedActivationPolicy {
    Compatibility,
    RequireDirectImmutable,
}

impl SealedActivationPolicy {
    fn from_environment() -> Result<Self, Error> {
        match std::env::var_os(REQUIRE_ZERO_WRITE_AOT_ENV) {
            None => Ok(Self::Compatibility),
            Some(value) if value == "0" => Ok(Self::Compatibility),
            Some(value) if value == "1" => Ok(Self::RequireDirectImmutable),
            Some(value) => bail!(
                "{REQUIRE_ZERO_WRITE_AOT_ENV} must be exactly 0 or 1, got {:?}",
                value
            ),
        }
    }

    const fn requires_direct_immutable(self) -> bool {
        matches!(self, Self::RequireDirectImmutable)
    }
}

/// Product executable selected from the exact sealed closure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealedRuntimeIdentity {
    /// The carrier's `bin/initdb` executable.
    WasixPostmasterInitdb,
    /// The carrier's `bin/postgres` executable.
    WasixPostmasterPostgres,
}

impl SealedRuntimeIdentity {
    /// Stable workload identity used by product-owned runtime policy.
    pub const fn workload_id(self) -> &'static str {
        match self {
            Self::WasixPostmasterInitdb => "runtime:initdb",
            Self::WasixPostmasterPostgres => "runtime:postgres",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ExpectedWasixPostmasterArtifact {
    kind: &'static str,
    module_path: &'static str,
    exec_aliases: &'static [&'static str],
    executable: Option<SealedRuntimeIdentity>,
}

const EXPECTED_WASIX_POSTMASTER_EXECUTABLES: [ExpectedWasixPostmasterArtifact; 2] = [
    ExpectedWasixPostmasterArtifact {
        kind: "executable",
        module_path: "bin/initdb",
        exec_aliases: &["/bin/initdb"],
        executable: Some(SealedRuntimeIdentity::WasixPostmasterInitdb),
    },
    ExpectedWasixPostmasterArtifact {
        kind: "executable",
        module_path: "bin/postgres",
        exec_aliases: &["/bin/postgres"],
        executable: Some(SealedRuntimeIdentity::WasixPostmasterPostgres),
    },
];

/// Activated entrypoint plus the still-lazy authoritative carrier closure.
#[derive(Debug)]
pub struct LoadedSealedModules {
    /// Selected compiler-free entrypoint module.
    pub module: Module,
    /// Hash of the selected entrypoint's raw Wasm module.
    pub module_hash: ModuleHash,
    /// Exact host spelling of the selected carrier executable.
    pub path: PathBuf,
    /// Closed executable alias registry shared by all fresh EXEC_BACKEND environments.
    pub executables: Vec<(String, ModuleHash)>,
    /// Authoritative, immutable full-closure AOT cache.
    pub module_cache: Arc<SealedModuleCache>,
}

/// The manifest and path identities captured by the single authoritative read.
#[derive(Debug)]
pub struct PreparedSealedManifest {
    manifest: SealedManifest,
    carrier_root: PathBuf,
    input_path: PathBuf,
    input_canonical: PathBuf,
    runtime_identity: Option<SealedRuntimeIdentity>,
}

impl PreparedSealedManifest {
    /// Return the exact initdb/postgres identity selected by the input path.
    pub const fn runtime_identity(&self) -> Option<SealedRuntimeIdentity> {
        self.runtime_identity
    }

    /// Create or validate the product-owned strict code-memory state directory.
    ///
    /// The exact admitted carrier root is already canonical. The state directory
    /// is one deterministic sibling beneath its owned carrier parent;
    /// there is no environment lookup, temporary-directory search, or fallback.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub fn strict_code_memory_directory(&self) -> Result<(PathBuf, u64, u64), Error> {
        strict_code_memory_directory_for_carrier(&self.carrier_root)
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn strict_code_memory_directory_for_carrier(
    carrier_root: &Path,
) -> Result<(PathBuf, u64, u64), Error> {
    use std::os::unix::{fs::DirBuilderExt, fs::MetadataExt};

    let carrier_parent = carrier_root
        .parent()
        .context("sealed carrier root must have a parent directory")?;
    let parent_metadata = fs::metadata(carrier_parent).with_context(|| {
        format!(
            "inspect strict code-memory parent {}",
            carrier_parent.display()
        )
    })?;
    ensure!(
        parent_metadata.is_dir(),
        "strict code-memory parent is not a directory: {}",
        carrier_parent.display()
    );
    ensure!(
        parent_metadata.uid() == unsafe { libc::geteuid() },
        "strict code-memory parent is not owned by the effective user: {}",
        carrier_parent.display()
    );

    let directory = carrier_parent.join(CODE_MEMORY_STATE_DIRECTORY);
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    match builder.create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "create strict code-memory directory {}",
                    directory.display()
                )
            });
        }
    }

    // lstat rejects a path substitution before the engine independently opens
    // and pins its O_DIRECTORY descriptor. The engine repeats the owner/mode
    // checks on that descriptor to close the validation/open race rather than
    // trusting these path-based observations alone.
    let metadata = fs::symlink_metadata(&directory).with_context(|| {
        format!(
            "inspect strict code-memory directory {}",
            directory.display()
        )
    })?;
    ensure!(
        !metadata.file_type().is_symlink() && metadata.is_dir(),
        "strict code-memory path must be a non-symlink directory: {}",
        directory.display()
    );
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() },
        "strict code-memory directory is not owned by the effective user: {}",
        directory.display()
    );
    ensure!(
        metadata.mode() & 0o7777 == 0o700,
        "strict code-memory directory must have exact mode 0700: {}",
        directory.display()
    );
    ensure!(
        metadata.dev() == parent_metadata.dev(),
        "strict code-memory directory changed filesystem device: {}",
        directory.display()
    );
    Ok((directory, parent_metadata.dev(), metadata.ino()))
}

/// The exact, immutable AOT closure admitted by a sealed carrier.
#[derive(Debug)]
pub struct SealedModuleCache {
    engine_id: wasmer::EngineId,
    engine_kind: String,
    artifacts: HashMap<ModuleHash, Arc<LazySealedArtifact>>,
}

impl SealedModuleCache {
    fn new(engine: &Engine, artifacts: HashMap<ModuleHash, Arc<LazySealedArtifact>>) -> Self {
        Self {
            engine_id: engine.id(),
            engine_kind: engine.deterministic_id(),
            artifacts,
        }
    }

    fn load_exact(&self, key: ModuleHash, engine: &Engine) -> Result<Module, CacheError> {
        if engine.id() != self.engine_id {
            return Err(sealed_cache_error(format!(
                "sealed module cache engine mismatch: cache={:?}/{} requested={:?}/{}",
                self.engine_id,
                self.engine_kind,
                engine.id(),
                engine.deterministic_id(),
            )));
        }
        self.artifacts
            .get(&key)
            .ok_or(CacheError::NotFound)?
            .activate(engine)
    }
}

#[async_trait::async_trait]
impl ModuleCache for SealedModuleCache {
    fn is_authoritative(&self) -> bool {
        true
    }

    async fn load(&self, key: ModuleHash, engine: &Engine) -> Result<Module, CacheError> {
        self.load_exact(key, engine)
    }

    async fn contains(&self, key: ModuleHash, engine: &Engine) -> Result<bool, CacheError> {
        if engine.id() != self.engine_id {
            return Err(sealed_cache_error(format!(
                "sealed module cache engine mismatch: cache={:?}/{} requested={:?}/{}",
                self.engine_id,
                self.engine_kind,
                engine.id(),
                engine.deterministic_id(),
            )));
        }
        Ok(self.artifacts.contains_key(&key))
    }

    async fn save(
        &self,
        key: ModuleHash,
        _engine: &Engine,
        _module: &Module,
    ) -> Result<(), CacheError> {
        Err(sealed_cache_error(format!(
            "sealed module cache is immutable; refusing save for {key}"
        )))
    }
}

fn sealed_cache_error(message: impl Into<String>) -> CacheError {
    CacheError::other(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        message.into(),
    ))
}

struct LazySealedArtifact {
    module_hash: ModuleHash,
    expected_digest: [u8; 32],
    policy: SealedActivationPolicy,
    source: Mutex<Option<SealedArtifactSource>>,
    activation: OnceLock<Result<Module, Arc<str>>>,
    #[cfg(test)]
    activation_attempts: std::sync::atomic::AtomicUsize,
}

impl fmt::Debug for LazySealedArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LazySealedArtifact")
            .field("module_hash", &self.module_hash)
            .field("activated", &self.activation.get().is_some())
            .finish_non_exhaustive()
    }
}

impl LazySealedArtifact {
    fn new(
        module_hash: ModuleHash,
        expected_digest: [u8; 32],
        source: SealedArtifactSource,
        policy: SealedActivationPolicy,
    ) -> Self {
        Self {
            module_hash,
            expected_digest,
            policy,
            source: Mutex::new(Some(source)),
            activation: OnceLock::new(),
            #[cfg(test)]
            activation_attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn activate(&self, engine: &Engine) -> Result<Module, CacheError> {
        self.activate_with_audit(engine, emit_loader_audit)
    }

    fn activate_with_audit(
        &self,
        engine: &Engine,
        emit_audit: impl FnOnce(LoaderAuditRecord) -> Result<(), Error>,
    ) -> Result<Module, CacheError> {
        self.activation
            .get_or_init(|| {
                #[cfg(test)]
                self.activation_attempts
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                let source = self
                    .source
                    .lock()
                    .map_err(|_| Arc::<str>::from("sealed artifact source lock poisoned"))?
                    .take()
                    .ok_or_else(|| Arc::<str>::from("sealed artifact source already consumed"))?;
                let snapshot = immutable_artifact_snapshot(source, self.policy).map_err(|error| {
                    Arc::<str>::from(format!("snapshot sealed AOT artifact: {error:#}"))
                })?;
                let read_advice = snapshot.advise_for_one_shot_read();
                let audit = snapshot.audit;
                let activation = (|| -> Result<
                    (
                        PendingModuleActivation,
                        FileResidencyAudit,
                        FileResidencyAudit,
                    ),
                    Arc<str>,
                > {
                    let mapping = snapshot.mapping().map_err(|error| {
                        Arc::<str>::from(format!(
                            "map immutable sealed artifact snapshot: {error:#}"
                        ))
                    })?;

                    let actual_digest: [u8; 32] = Sha256::digest(mapping.as_slice()).into();
                    if actual_digest != self.expected_digest {
                        return Err(Arc::<str>::from(format!(
                            "sealed AOT artifact SHA-256 mismatch: expected={} actual={}",
                            hex::encode(self.expected_digest),
                            hex::encode(actual_digest)
                        )));
                    }
                    let inspected_hash = engine
                        .inspect_serialized_artifact(&mapping)
                        .map_err(|error| {
                            Arc::<str>::from(format!("inspect sealed AOT artifact: {error}"))
                        })?;
                    if inspected_hash != self.module_hash {
                        return Err(Arc::<str>::from(format!(
                            "sealed AOT artifact embedded hash mismatch: expected={} actual={inspected_hash}",
                            self.module_hash
                        )));
                    }
                    let residency_after_hash_inspect =
                        snapshot.residency();

                    // SAFETY: this exact immutable mapping was just hashed and
                    // inspected. The checked deserializer consumes that same
                    // mapping; no path is reopened between verification/use.
                    let pending = unsafe {
                        engine.deserialize_from_mmapped_buffer_detached_pending(mapping)
                    }
                    .map_err(|error| {
                        Arc::<str>::from(format!("activate sealed AOT artifact: {error}"))
                    })?;
                    // The detached deserializer consumed and released the
                    // archive mapping before returning. This descriptor-only
                    // mincore probe cannot touch executable or payload bytes.
                    let residency_after_archive_release = snapshot.residency();
                    let embedded_hash = pending.module_hash().ok_or_else(|| {
                        Arc::<str>::from("activated sealed artifact has no embedded module hash")
                    })?;
                    if embedded_hash != self.module_hash {
                        return Err(Arc::<str>::from(format!(
                            "activated sealed artifact hash mismatch: expected={} actual={embedded_hash}",
                            self.module_hash
                        )));
                    }
                    #[cfg(feature = "memory-profile-core")]
                    validate_serialized_memory_plans(&pending.linear_memory_plans()).map_err(
                        |error| {
                            Arc::<str>::from(format!(
                                "activated sealed artifact linear-memory profile mismatch: {error:#}"
                            ))
                        },
                    )?;
                    Ok((
                        pending,
                        residency_after_hash_inspect,
                        residency_after_archive_release,
                    ))
                })();
                let source_residency_before_eviction = snapshot.source_residency();
                let source_cache_eviction = snapshot.advise_source_away();
                let source_residency_after_eviction = snapshot.source_residency();
                let snapshot_cache_eviction = snapshot.advise_snapshot_away();
                let residency_after_eviction = snapshot.residency();
                let (pending, residency_after_hash_inspect, residency_after_archive_release) =
                    activation?;
                tracing::debug!(
                    target: "wasmer_cli::sealed_loader_audit",
                    audit_schema = "oliphaunt.wasix-postmaster.sealed-loader-audit.v2",
                    artifact_kind = "aot",
                    module_sha256 = %self.module_hash,
                    activation_state = "active",
                    snapshot_mode = audit.mode.as_str(),
                    logical_bytes = audit.logical_bytes,
                    source_bytes_read = audit.source_bytes_read,
                    snapshot_bytes_written = audit.snapshot_bytes_written,
                    source_bytes_written = 0_u64,
                    mapping_bytes_hashed = audit.mapping_bytes_hashed,
                    sync_calls = audit.sync_calls,
                    read_advice_calls = read_advice.calls,
                    read_advice_successes = read_advice.successes,
                    read_advice_first_errno = read_advice.first_errno,
                    source_cache_eviction_supported = source_cache_eviction.supported,
                    source_cache_eviction_calls = source_cache_eviction.calls,
                    source_cache_eviction_successes = source_cache_eviction.successes,
                    source_cache_eviction_errno = source_cache_eviction.first_errno,
                    snapshot_cache_eviction_applicable = snapshot.has_distinct_source(),
                    snapshot_cache_eviction_supported = snapshot_cache_eviction.supported,
                    snapshot_cache_eviction_calls = snapshot_cache_eviction.calls,
                    snapshot_cache_eviction_successes = snapshot_cache_eviction.successes,
                    snapshot_cache_eviction_errno = snapshot_cache_eviction.first_errno,
                    residency_after_hash_inspect_state = residency_after_hash_inspect.state.as_str(),
                    residency_after_hash_inspect_pages = residency_after_hash_inspect.resident_pages,
                    residency_after_archive_release_state = residency_after_archive_release.state.as_str(),
                    residency_after_archive_release_pages = residency_after_archive_release.resident_pages,
                    residency_after_eviction_state = residency_after_eviction.state.as_str(),
                    residency_after_eviction_pages = residency_after_eviction.resident_pages,
                    write_policy = audit.mode.write_policy(),
                    "activated sealed artifact"
                );
                emit_audit(LoaderAuditRecord {
                    artifact_kind: "aot",
                    module_sha256: canonical_module_sha256(self.module_hash),
                    snapshot_mode: audit.mode.as_str(),
                    logical_bytes: audit.logical_bytes,
                    source_bytes_read: audit.source_bytes_read,
                    source_bytes_written: 0,
                    snapshot_bytes_written: audit.snapshot_bytes_written,
                    mapping_bytes_hashed: audit.mapping_bytes_hashed,
                    sync_calls: audit.sync_calls,
                    read_advice_applicable: true,
                    read_advice_supported: read_advice.supported,
                    read_advice_calls: read_advice.calls,
                    read_advice_successes: read_advice.successes,
                    read_advice_first_errno: read_advice.first_errno,
                    source_cache_eviction_applicable: true,
                    source_cache_eviction_supported: source_cache_eviction.supported,
                    source_cache_eviction_calls: source_cache_eviction.calls,
                    source_cache_eviction_successes: source_cache_eviction.successes,
                    source_cache_eviction_errno: source_cache_eviction.first_errno,
                    snapshot_cache_eviction_applicable: snapshot.has_distinct_source(),
                    snapshot_cache_eviction_supported: snapshot_cache_eviction.supported,
                    snapshot_cache_eviction_calls: snapshot_cache_eviction.calls,
                    snapshot_cache_eviction_successes: snapshot_cache_eviction.successes,
                    snapshot_cache_eviction_errno: snapshot_cache_eviction.first_errno,
                    mapping_cache_eviction_applicable: false,
                    mapping_cache_eviction_supported: true,
                    mapping_cache_eviction_calls: 0,
                    mapping_cache_eviction_successes: 0,
                    mapping_cache_eviction_errno: None,
                    residency_after_hash_inspect: residency_after_hash_inspect.into(),
                    residency_after_archive_release: residency_after_archive_release.into(),
                    source_residency_before_eviction: source_residency_before_eviction.into(),
                    source_residency_after_eviction: source_residency_after_eviction.into(),
                    residency_after_eviction: residency_after_eviction.into(),
                    write_policy: audit.mode.write_policy(),
                })
                .map_err(|error| {
                    Arc::<str>::from(format!("write sealed loader audit receipt: {error:#}"))
                })?;
                Ok(pending.commit())
            })
            .clone()
            .map_err(|message| sealed_cache_error(message.to_string()))
    }
}

struct SealedArtifactSource {
    file: File,
    path: PathBuf,
    carrier_root: PathBuf,
    expected_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactSnapshotMode {
    DirectIntrinsic(IntrinsicFileImmutability),
    Reflink,
    StreamedCopy,
}

impl ArtifactSnapshotMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::DirectIntrinsic(IntrinsicFileImmutability::ReadOnlyFilesystem) => {
                "direct-read-only-filesystem"
            }
            Self::DirectIntrinsic(IntrinsicFileImmutability::ImmutableInode) => {
                "direct-immutable-inode"
            }
            Self::Reflink => "reflink",
            Self::StreamedCopy => "streamed-copy",
        }
    }

    const fn write_policy(self) -> &'static str {
        match self {
            Self::DirectIntrinsic(_) => "none-immutable-source",
            Self::Reflink => "private-reflink-no-userspace-payload-write",
            Self::StreamedCopy => "private-streamed-copy-no-sync",
        }
    }
}

#[derive(Debug, Serialize)]
struct LoaderAuditRecord {
    artifact_kind: &'static str,
    module_sha256: String,
    snapshot_mode: &'static str,
    logical_bytes: u64,
    source_bytes_read: u64,
    source_bytes_written: u64,
    snapshot_bytes_written: u64,
    mapping_bytes_hashed: u64,
    sync_calls: u64,
    read_advice_applicable: bool,
    read_advice_supported: bool,
    read_advice_calls: u64,
    read_advice_successes: u64,
    read_advice_first_errno: Option<i32>,
    source_cache_eviction_applicable: bool,
    source_cache_eviction_supported: bool,
    source_cache_eviction_calls: u64,
    source_cache_eviction_successes: u64,
    source_cache_eviction_errno: Option<i32>,
    snapshot_cache_eviction_applicable: bool,
    snapshot_cache_eviction_supported: bool,
    snapshot_cache_eviction_calls: u64,
    snapshot_cache_eviction_successes: u64,
    snapshot_cache_eviction_errno: Option<i32>,
    mapping_cache_eviction_applicable: bool,
    mapping_cache_eviction_supported: bool,
    mapping_cache_eviction_calls: u64,
    mapping_cache_eviction_successes: u64,
    mapping_cache_eviction_errno: Option<i32>,
    residency_after_hash_inspect: LoaderResidencyRecord,
    residency_after_archive_release: LoaderResidencyRecord,
    source_residency_before_eviction: LoaderResidencyRecord,
    source_residency_after_eviction: LoaderResidencyRecord,
    residency_after_eviction: LoaderResidencyRecord,
    write_policy: &'static str,
}

fn canonical_module_sha256(module_hash: ModuleHash) -> String {
    hex::encode(module_hash.as_bytes())
}

#[derive(Debug, Serialize)]
struct LoaderResidencyRecord {
    state: &'static str,
    page_size: Option<u64>,
    total_pages: Option<u64>,
    resident_pages: Option<u64>,
    resident_bytes: Option<u64>,
    errno: Option<i32>,
}

impl From<FileResidencyAudit> for LoaderResidencyRecord {
    fn from(audit: FileResidencyAudit) -> Self {
        Self {
            state: audit.state.as_str(),
            page_size: audit.page_size,
            total_pages: audit.total_pages,
            resident_pages: audit.resident_pages,
            resident_bytes: audit.resident_bytes,
            errno: audit.errno,
        }
    }
}

#[derive(Serialize)]
struct LoaderAuditEnvelope<'a> {
    schema: &'static str,
    pid: u32,
    #[serde(flatten)]
    record: &'a LoaderAuditRecord,
}

fn emit_loader_audit(record: LoaderAuditRecord) -> Result<(), Error> {
    let Some(path) = std::env::var_os(SEALED_LOADER_AUDIT_FILE_ENV) else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    ensure!(
        !path.as_os_str().is_empty(),
        "{SEALED_LOADER_AUDIT_FILE_ENV} must not be empty"
    );
    emit_loader_audit_to_path(&path, &record)
}

#[cfg(unix)]
fn emit_loader_audit_to_path(path: &Path, record: &LoaderAuditRecord) -> Result<(), Error> {
    let envelope = LoaderAuditEnvelope {
        schema: "oliphaunt.wasix-postmaster.sealed-loader-receipt.v2",
        pid: std::process::id(),
        record,
    };
    append_sealed_loader_audit_record(path, &envelope)
}

#[cfg(unix)]
fn append_sealed_loader_audit_record(path: &Path, record: &impl Serialize) -> Result<(), Error> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    };

    let mut options = OpenOptions::new();
    options
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .with_context(|| format!("open sealed loader audit receipt {}", path.display()))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "sealed loader audit receipt is not a regular file"
    );
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() },
        "sealed loader audit receipt is not owned by the runtime uid"
    );
    ensure!(
        metadata.nlink() == 1,
        "sealed loader audit receipt must have exactly one link"
    );
    ensure!(
        metadata.mode() & 0o077 == 0,
        "sealed loader audit receipt exposes group/other permissions"
    );

    let mut line = serde_json::to_vec(record).context("encode sealed loader audit record")?;
    line.push(b'\n');
    ensure!(
        line.len() <= 4096,
        "sealed loader audit record exceeds atomic-write bound"
    );
    // SAFETY: the buffer remains live for this single O_APPEND write. One
    // syscall keeps concurrent process records contiguous; short writes fail
    // activation so qualification cannot accept a partial receipt.
    let written = unsafe { libc::write(file.as_raw_fd(), line.as_ptr().cast(), line.len()) };
    if written < 0 {
        return Err(std::io::Error::last_os_error()).context("append sealed loader audit record");
    }
    ensure!(
        usize::try_from(written).ok() == Some(line.len()),
        "short sealed loader audit write: expected={} actual={written}",
        line.len()
    );
    Ok(())
}

#[cfg(not(unix))]
fn emit_loader_audit_to_path(_path: &Path, _record: &LoaderAuditRecord) -> Result<(), Error> {
    bail!("sealed loader audit receipts require Unix O_APPEND/O_NOFOLLOW semantics")
}

#[cfg(not(unix))]
fn append_sealed_loader_audit_record(_path: &Path, _record: &impl Serialize) -> Result<(), Error> {
    bail!("sealed loader audit receipts require Unix O_APPEND/O_NOFOLLOW semantics")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ArtifactSnapshotAudit {
    mode: ArtifactSnapshotMode,
    logical_bytes: u64,
    source_bytes_read: u64,
    snapshot_bytes_written: u64,
    mapping_bytes_hashed: u64,
    sync_calls: u64,
}

struct ImmutableArtifactSnapshot {
    file: File,
    /// Retained only when activation uses a private reflink/streamed snapshot.
    /// This is the exact already-open carrier source, never a reopened path.
    source_file: Option<File>,
    len: u64,
    audit: ArtifactSnapshotAudit,
}

impl fmt::Debug for ImmutableArtifactSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImmutableArtifactSnapshot")
            .field("len", &self.len)
            .field("has_distinct_source", &self.source_file.is_some())
            .finish_non_exhaustive()
    }
}

impl ImmutableArtifactSnapshot {
    fn mapping(&self) -> Result<wasmer::sys::OwnedBuffer, Error> {
        let mapping = wasmer::sys::OwnedBuffer::from_file(&self.file)
            .context("memory-map immutable sealed artifact snapshot")?;
        ensure!(
            u64::try_from(mapping.len()).ok() == Some(self.len),
            "immutable sealed artifact snapshot changed size"
        );
        Ok(mapping)
    }

    fn advise_for_one_shot_read(&self) -> FileAdviceAudit {
        advise_file_for_one_shot_read(&self.file)
    }

    fn advise_source_away(&self) -> FileAdviceAudit {
        advise_file_away(self.source_file.as_ref().unwrap_or(&self.file))
    }

    fn advise_snapshot_away(&self) -> FileAdviceAudit {
        self.source_file
            .as_ref()
            .map_or_else(FileAdviceAudit::not_applicable, |_| {
                advise_file_away(&self.file)
            })
    }

    fn residency(&self) -> FileResidencyAudit {
        file_residency(&self.file, self.len)
    }

    fn source_residency(&self) -> FileResidencyAudit {
        file_residency(self.source_file.as_ref().unwrap_or(&self.file), self.len)
    }

    fn has_distinct_source(&self) -> bool {
        self.source_file.is_some()
    }
}

enum WritableArtifactSnapshot {
    #[cfg(target_os = "linux")]
    Anonymous(File),
    Named {
        temp_dir: tempfile::TempDir,
        file: tempfile::NamedTempFile,
    },
}

impl WritableArtifactSnapshot {
    fn file_mut(&mut self) -> &mut File {
        match self {
            #[cfg(target_os = "linux")]
            Self::Anonymous(file) => file,
            Self::Named { file, .. } => file.as_file_mut(),
        }
    }

    fn finalize(
        self,
        expected_size: u64,
        audit: ArtifactSnapshotAudit,
    ) -> Result<ImmutableArtifactSnapshot, Error> {
        match self {
            #[cfg(target_os = "linux")]
            Self::Anonymous(file) => finalize_anonymous_snapshot(file, expected_size, audit),
            Self::Named { temp_dir, file } => {
                finalize_named_snapshot(temp_dir, file, expected_size, audit)
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SealedManifest {
    format_version: u32,
    schema: String,
    source_lane: String,
    source_fingerprint: String,
    core_profile: String,
    guest_build_recipe_sha256: String,
    postgres_version: String,
    target_triple: String,
    host_abi: String,
    engine: String,
    compiler_config: String,
    cpu_policy: String,
    cpu_features: Vec<String>,
    wasmer_version: String,
    wasmer_wasix_version: String,
    wasmer_source_commit: String,
    wasmer_patch_sha256: String,
    wasmer_cargo_lock_sha256: String,
    artifact_abi_version: u32,
    runtime_abi_id: String,
    producer_recipe_sha256: String,
    executor_engine: String,
    executor_sha256: String,
    executor_size: u64,
    linear_memory_profile: SealedLinearMemoryProfile,
    wasm_features: Vec<String>,
    entrypoint: String,
    artifacts: Vec<SealedArtifact>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SealedLinearMemoryProfile {
    id: String,
    address_width: String,
    supported_host_pointer_width: String,
    maximum_pages: u32,
    maximum_bytes: u64,
    static_bound_pages: u32,
    static_offset_guard_bytes: u64,
    static_access_lowering: String,
    install_receipt_path: String,
    install_receipt_sha256: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SealedArtifact {
    name: String,
    kind: String,
    path: String,
    module_path: String,
    sha256: String,
    raw_sha256: String,
    raw_size: u64,
    module_sha256: String,
    module_size: u64,
    linear_memory: SealedArtifactLinearMemory,
    compressed: bool,
    exec_aliases: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SealedArtifactLinearMemory {
    profile_id: String,
    source_module_sha256: String,
    install_receipt_sha256: String,
}

/// Read and structurally admit an exact sealed manifest for one local executable.
pub fn prepare(manifest_path: &Path, input_path: &Path) -> Result<PreparedSealedManifest, Error> {
    let manifest = read_manifest(manifest_path)?;
    ensure!(
        has_exact_wasix_postmaster_identity(&manifest),
        "sealed manifest is not the exact WASIX-postmaster artifact closure"
    );
    let carrier_root = manifest_path
        .parent()
        .context("sealed manifest must have a parent directory")?
        .canonicalize()
        .with_context(|| format!("resolve carrier root for {}", manifest_path.display()))?;
    validate_linear_memory_install_receipt(&manifest, &carrier_root)?;
    let input_canonical = input_path
        .canonicalize()
        .with_context(|| format!("resolve sealed executable input {}", input_path.display()))?;
    let runtime_identity = EXPECTED_WASIX_POSTMASTER_EXECUTABLES
        .iter()
        .filter_map(|artifact| artifact.executable.map(|identity| (artifact, identity)))
        .find_map(|(artifact, identity)| {
            let expected_path = carrier_root
                .join(artifact.module_path)
                .canonicalize()
                .ok()?;
            (expected_path == input_canonical).then_some(identity)
        });
    ensure!(
        runtime_identity.is_some(),
        "input '{}' is not an executable in the exact WASIX-postmaster closure",
        input_path.display()
    );
    Ok(PreparedSealedManifest {
        manifest,
        carrier_root,
        input_path: input_path.to_path_buf(),
        input_canonical,
        runtime_identity,
    })
}

fn validate_linear_memory_profile(profile: &SealedLinearMemoryProfile) -> Result<(), Error> {
    ensure!(
        profile.id == LINEAR_MEMORY_PROFILE_ID
            && profile.address_width == "wasm32"
            && profile.supported_host_pointer_width == "u64"
            && profile.maximum_pages == LINEAR_MEMORY_MAXIMUM_PAGES
            && profile.maximum_bytes == LINEAR_MEMORY_MAXIMUM_BYTES
            && profile.static_bound_pages == LINEAR_MEMORY_STATIC_BOUND_PAGES
            && profile.static_offset_guard_bytes == LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES
            && profile.static_access_lowering == "wasmer-llvm-unchecked-reservation-and-guard-v1",
        "sealed manifest linear-memory profile does not match the exact trap-preserving product profile"
    );
    ensure_nonempty(
        "linear-memory-profile.install-receipt-path",
        &profile.install_receipt_path,
    )?;
    parse_sha256(
        "linear-memory-profile.install-receipt-sha256",
        &profile.install_receipt_sha256,
    )?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct LinearMemoryInstallReceipt {
    schema: String,
    profile_id: String,
    address_width: String,
    supported_host_pointer_width: String,
    maximum_pages: u32,
    maximum_bytes: u64,
    static_bound_pages: u32,
    static_offset_guard_bytes: u64,
    static_access_lowering: String,
    requires_shared: bool,
    requires_import: String,
    excludes_wasm32_end_wrap: bool,
    predecessor_export_closure_receipt: String,
    predecessor_export_closure_receipt_sha256: String,
    source_module_closure_sha256: String,
    module_closure_sha256: String,
    module_count: usize,
    modules: Vec<LinearMemoryInstallModule>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct LinearMemoryInstallModule {
    path: String,
    source_module_sha256: String,
    module_sha256: String,
    initial_pages: u64,
    maximum_pages: u64,
    maximum_bytes: u64,
    shared: bool,
    import_module: String,
    import_name: String,
    transformation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
#[allow(dead_code)] // Receipt schema fields are authenticated even when not consumed at runtime.
struct SealedExportSnapshot {
    sha256: String,
    bytes: usize,
    exports: usize,
    local_functions: u32,
    local_globals: u32,
    element_function_entries: u32,
    element_unique_function_indices: u32,
    start_function_index: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SealedExportSideIdentity {
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
#[allow(dead_code)] // Receipt schema fields are authenticated even when not consumed at runtime.
struct SealedExportStructureReceipt {
    schema: String,
    policy_id: String,
    analyzer_version: String,
    analyzer_binary_sha256: String,
    dce_tool_sha256: String,
    dce_tool_version: String,
    dce_passes: Vec<String>,
    mandatory_policy_sha256: String,
    declared_main_dlsym_policy_sha256: String,
    side_manifest_sha256: String,
    allowlist_sha256: String,
    seed_proof_sha256: String,
    final_proof_sha256: String,
    seed: SealedExportSnapshot,
    final_module: SealedExportSnapshot,
    sides: Vec<SealedExportSideIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
#[allow(dead_code)] // Proof schema fields are authenticated even when not consumed at runtime.
struct SealedExportProofModule {
    path: String,
    sha256: String,
    bytes: usize,
    non_export_sections_sha256: String,
    dylink_needed: Vec<String>,
    imported_functions: u32,
    local_functions: u32,
    imported_globals: u32,
    local_globals: u32,
    imported_tables: u32,
    local_tables: u32,
    element_function_entries: u32,
    element_unique_function_indices: u32,
    element_max_function_index: Option<u32>,
    start_function_index: Option<u32>,
    imports: Vec<serde_json::Value>,
    export_counts: BTreeMap<String, u32>,
    exported_global_type_counts: BTreeMap<String, u32>,
    exported_immutable_i32_globals: u32,
    exported_local_functions: u32,
    exported_imported_functions: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
#[allow(dead_code)] // Proof schema fields are authenticated even when not consumed at runtime.
struct SealedExportClosureProof {
    schema: String,
    policy_id: String,
    analyzer_version: String,
    mandatory_policy_sha256: String,
    declared_main_dlsym_policy_sha256: String,
    main: SealedExportProofModule,
    sides: Vec<SealedExportProofModule>,
    mandatory_runtime_exports: Vec<String>,
    declared_main_dlsym_exports: Vec<String>,
    side_dynamic_imports: Vec<serde_json::Value>,
    retained_main_exports: Vec<String>,
    retained_main_export_descriptors: Vec<serde_json::Value>,
    removed_main_export_count: usize,
    removed_main_export_names_sha256: String,
    unresolved_main_requirements: Vec<String>,
    mismatched_main_requirements: Vec<String>,
    unresolved_side_dependencies: Vec<String>,
    retained_counts: BTreeMap<String, u32>,
    removed_counts: BTreeMap<String, u32>,
}

fn update_framed(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn linear_memory_closure_sha256(modules: &[LinearMemoryInstallModule], hash_field: &str) -> String {
    let mut digest = Sha256::new();
    update_framed(
        &mut digest,
        "oliphaunt.wasix-postmaster.linear-memory-install-closure.v1",
    );
    update_framed(&mut digest, hash_field);
    for module in modules {
        update_framed(&mut digest, &module.path);
        update_framed(
            &mut digest,
            if hash_field == "source-module-sha256" {
                &module.source_module_sha256
            } else {
                &module.module_sha256
            },
        );
    }
    hex::encode(digest.finalize())
}

fn validate_sealed_export_proof(
    proof: &SealedExportClosureProof,
    label: &str,
    receipt: &SealedExportStructureReceipt,
    expected_main_sha256: &str,
) -> Result<(), Error> {
    ensure!(
        proof.schema == SEALED_EXPORT_PROOF_SCHEMA
            && proof.policy_id == SEALED_EXPORT_POLICY_ID
            && proof.analyzer_version == receipt.analyzer_version
            && proof.mandatory_policy_sha256 == receipt.mandatory_policy_sha256
            && proof.declared_main_dlsym_policy_sha256 == receipt.declared_main_dlsym_policy_sha256,
        "{label} schema/policy identity differs"
    );
    ensure!(
        proof.main.path == "bin/postgres" && proof.main.sha256 == expected_main_sha256,
        "{label} main module identity differs"
    );
    ensure!(
        proof.sides.len() == receipt.sides.len(),
        "{label} side-module count differs"
    );
    for (module, expected) in proof.sides.iter().zip(&receipt.sides) {
        ensure!(
            module.path == expected.path && module.sha256 == expected.sha256,
            "{label} side-module identity differs for '{}'",
            expected.path
        );
    }
    ensure!(
        proof.unresolved_main_requirements.is_empty()
            && proof.mismatched_main_requirements.is_empty()
            && proof.unresolved_side_dependencies.is_empty(),
        "{label} does not prove a closed export graph"
    );
    parse_sha256(
        &format!("{label} removed export names"),
        &proof.removed_main_export_names_sha256,
    )?;
    ensure_nonempty(
        &format!("{label} analyzer version"),
        &proof.analyzer_version,
    )?;
    Ok(())
}

fn validate_sealed_export_predecessor(
    carrier_root: &Path,
    linear_receipt: &LinearMemoryInstallReceipt,
) -> Result<(), Error> {
    ensure!(
        linear_receipt.predecessor_export_closure_receipt == SEALED_EXPORT_RECEIPT_PATH,
        "linear-memory predecessor must be the canonical sealed-export receipt"
    );
    let source_modules = linear_receipt
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module.source_module_sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let receipt_path = carrier_file_path(carrier_root, SEALED_EXPORT_RECEIPT_PATH)?;
    let receipt_bytes = read_small_regular_file(&receipt_path, MAX_SEALED_EXPORT_PROOF_BYTES)?;
    ensure!(
        hex::encode(Sha256::digest(&receipt_bytes))
            == linear_receipt.predecessor_export_closure_receipt_sha256,
        "linear-memory predecessor sealed-export receipt SHA-256 differs"
    );
    let receipt: SealedExportStructureReceipt =
        serde_json::from_slice(&receipt_bytes).context("parse sealed-export structural receipt")?;
    ensure!(
        receipt.schema == SEALED_EXPORT_RECEIPT_SCHEMA
            && receipt.policy_id == SEALED_EXPORT_POLICY_ID
            && receipt.dce_passes == ["--remove-unused-module-elements"]
            && receipt.mandatory_policy_sha256 == SEALED_EXPORT_MANDATORY_POLICY_SHA256
            && receipt.declared_main_dlsym_policy_sha256 == SEALED_EXPORT_DLSYM_POLICY_SHA256
            && receipt.side_manifest_sha256 == SEALED_EXPORT_SIDE_MANIFEST_SHA256,
        "sealed-export structural receipt policy differs"
    );
    for (label, value) in [
        ("analyzer binary", receipt.analyzer_binary_sha256.as_str()),
        ("DCE tool", receipt.dce_tool_sha256.as_str()),
        ("allowlist", receipt.allowlist_sha256.as_str()),
        ("seed proof", receipt.seed_proof_sha256.as_str()),
        ("final proof", receipt.final_proof_sha256.as_str()),
        ("seed module", receipt.seed.sha256.as_str()),
        ("final module", receipt.final_module.sha256.as_str()),
    ] {
        parse_sha256(&format!("sealed-export {label}"), value)?;
    }
    ensure_nonempty("sealed-export analyzer version", &receipt.analyzer_version)?;
    ensure_nonempty("sealed-export DCE tool version", &receipt.dce_tool_version)?;
    ensure!(
        source_modules.get("bin/postgres").copied() == Some(receipt.final_module.sha256.as_str()),
        "sealed-export final module is not bin/postgres's linear-memory predecessor"
    );
    ensure!(
        receipt.sides.len() == SEALED_EXPORT_SIDE_PATHS.len(),
        "sealed-export structural receipt side count differs"
    );
    for (side, expected_path) in receipt.sides.iter().zip(SEALED_EXPORT_SIDE_PATHS) {
        parse_sha256("sealed-export side module", &side.sha256)?;
        ensure!(
            side.path == expected_path
                && source_modules.get(expected_path).copied() == Some(side.sha256.as_str()),
            "sealed-export side is not the linear-memory predecessor for '{expected_path}'"
        );
    }

    let read_bound = |relative: &str, expected: &str| -> Result<Vec<u8>, Error> {
        let path = carrier_file_path(carrier_root, relative)?;
        let bytes = read_small_regular_file(&path, MAX_SEALED_EXPORT_PROOF_BYTES)?;
        ensure!(
            hex::encode(Sha256::digest(&bytes)) == expected,
            "sealed-export installed proof differs: {relative}"
        );
        Ok(bytes)
    };
    let _allowlist = read_bound(SEALED_EXPORT_ALLOWLIST_PATH, &receipt.allowlist_sha256)?;
    let seed_bytes = read_bound(SEALED_EXPORT_SEED_PROOF_PATH, &receipt.seed_proof_sha256)?;
    let final_bytes = read_bound(SEALED_EXPORT_FINAL_PROOF_PATH, &receipt.final_proof_sha256)?;
    let seed: SealedExportClosureProof =
        serde_json::from_slice(&seed_bytes).context("parse sealed-export seed proof")?;
    let final_proof: SealedExportClosureProof =
        serde_json::from_slice(&final_bytes).context("parse sealed-export final proof")?;
    validate_sealed_export_proof(
        &seed,
        "sealed-export seed proof",
        &receipt,
        &receipt.seed.sha256,
    )?;
    validate_sealed_export_proof(
        &final_proof,
        "sealed-export final proof",
        &receipt,
        &receipt.final_module.sha256,
    )?;
    Ok(())
}

fn validate_linear_memory_install_receipt(
    manifest: &SealedManifest,
    carrier_root: &Path,
) -> Result<(), Error> {
    let profile = &manifest.linear_memory_profile;
    validate_linear_memory_profile(profile)?;
    let receipt_path = carrier_file_path(carrier_root, &profile.install_receipt_path)?;
    let bytes = read_small_regular_file(&receipt_path, MAX_LINEAR_MEMORY_RECEIPT_BYTES)
        .with_context(|| {
            format!(
                "read linear-memory install receipt {}",
                receipt_path.display()
            )
        })?;
    let actual_sha256 = hex::encode(Sha256::digest(&bytes));
    ensure!(
        actual_sha256.eq_ignore_ascii_case(&profile.install_receipt_sha256),
        "linear-memory install receipt SHA-256 mismatch"
    );
    let receipt: LinearMemoryInstallReceipt =
        serde_json::from_slice(&bytes).context("parse linear-memory install receipt")?;
    ensure!(
        receipt.schema == LINEAR_MEMORY_INSTALL_RECEIPT_SCHEMA
            && receipt.profile_id == profile.id
            && receipt.address_width == profile.address_width
            && receipt.supported_host_pointer_width == profile.supported_host_pointer_width
            && receipt.maximum_pages == profile.maximum_pages
            && receipt.maximum_bytes == profile.maximum_bytes
            && receipt.static_bound_pages == profile.static_bound_pages
            && receipt.static_offset_guard_bytes == profile.static_offset_guard_bytes
            && receipt.static_access_lowering == profile.static_access_lowering
            && receipt.requires_shared
            && receipt.requires_import == "env.memory"
            && receipt.excludes_wasm32_end_wrap,
        "linear-memory install receipt profile differs from sealed manifest"
    );
    ensure!(
        receipt.module_count == receipt.modules.len() && receipt.module_count > 0,
        "linear-memory install receipt module count is invalid"
    );
    parse_sha256(
        "linear-memory predecessor export receipt",
        &receipt.predecessor_export_closure_receipt_sha256,
    )?;
    ensure_nonempty(
        "linear-memory predecessor export receipt path",
        &receipt.predecessor_export_closure_receipt,
    )?;
    parse_sha256(
        "linear-memory source closure",
        &receipt.source_module_closure_sha256,
    )?;
    parse_sha256(
        "linear-memory sealed closure",
        &receipt.module_closure_sha256,
    )?;

    let mut paths = BTreeSet::new();
    let mut previous = None;
    for module in &receipt.modules {
        ensure!(
            previous.is_none_or(|path: &str| path < module.path.as_str()),
            "linear-memory install receipt modules are not strictly path-sorted"
        );
        previous = Some(module.path.as_str());
        ensure!(
            paths.insert(module.path.as_str()),
            "duplicate linear-memory module path"
        );
        parse_sha256("linear-memory source module", &module.source_module_sha256)?;
        parse_sha256("linear-memory sealed module", &module.module_sha256)?;
        ensure!(
            module.initial_pages <= u64::from(LINEAR_MEMORY_MAXIMUM_PAGES)
                && module.maximum_pages == u64::from(LINEAR_MEMORY_MAXIMUM_PAGES)
                && module.maximum_bytes == LINEAR_MEMORY_MAXIMUM_BYTES
                && module.shared
                && module.import_module == "env"
                && module.import_name == "memory"
                && module.transformation == SEALED_MODULE_TRANSFORMATION_ID,
            "linear-memory install module '{}' has a noncanonical contract",
            module.path
        );
    }
    ensure!(
        linear_memory_closure_sha256(&receipt.modules, "source-module-sha256")
            == receipt.source_module_closure_sha256
            && linear_memory_closure_sha256(&receipt.modules, "module-sha256")
                == receipt.module_closure_sha256,
        "linear-memory install receipt closure hash mismatch"
    );
    validate_sealed_export_predecessor(carrier_root, &receipt)?;

    for artifact in &manifest.artifacts {
        let module = receipt
            .modules
            .iter()
            .find(|module| module.path == artifact.module_path)
            .with_context(|| {
                format!(
                    "linear-memory install receipt has no record for '{}'",
                    artifact.module_path
                )
            })?;
        ensure!(
            artifact.linear_memory.profile_id == profile.id
                && artifact.linear_memory.install_receipt_sha256 == profile.install_receipt_sha256
                && artifact.linear_memory.source_module_sha256 == module.source_module_sha256
                && artifact
                    .module_sha256
                    .eq_ignore_ascii_case(&module.module_sha256),
            "sealed artifact '{}' linear-memory binding differs from install receipt",
            artifact.name
        );
    }
    Ok(())
}

fn read_manifest(manifest_path: &Path) -> Result<SealedManifest, Error> {
    let manifest_bytes = read_small_regular_file(manifest_path, MAX_MANIFEST_BYTES)
        .with_context(|| format!("read sealed manifest {}", manifest_path.display()))?;
    serde_json::from_slice(&manifest_bytes)
        .with_context(|| format!("parse sealed manifest {}", manifest_path.display()))
}

fn has_exact_wasix_postmaster_identity(manifest: &SealedManifest) -> bool {
    if manifest.format_version != MANIFEST_FORMAT_VERSION
        || manifest.schema != MANIFEST_SCHEMA
        || manifest.source_lane != WASIX_POSTMASTER_SOURCE_LANE
        || !matches!(manifest.core_profile.as_str(), "release-o3" | "safe-o2")
        || parse_sha256(
            "guest-build-recipe-sha256",
            &manifest.guest_build_recipe_sha256,
        )
        .is_err()
        || validate_linear_memory_profile(&manifest.linear_memory_profile).is_err()
        || manifest.entrypoint != WASIX_POSTMASTER_ENTRYPOINT
        || manifest.wasm_features.len() != EXPECTED_WASM_FEATURES.len()
        || EXPECTED_WASM_FEATURES.iter().any(|expected| {
            !manifest
                .wasm_features
                .iter()
                .any(|actual| actual == expected)
        })
        || manifest.artifacts.len()
            != EXPECTED_WASIX_POSTMASTER_EXECUTABLES.len() + SEALED_EXPORT_SIDE_PATHS.len()
    {
        return false;
    }

    let mut names = HashSet::new();
    let mut module_paths = HashSet::new();
    let mut artifact_paths = HashSet::new();
    for (index, artifact) in manifest.artifacts.iter().enumerate() {
        let (kind, module_path, exec_aliases, _executable) =
            if let Some(expected) = EXPECTED_WASIX_POSTMASTER_EXECUTABLES.get(index) {
                (
                    expected.kind,
                    expected.module_path,
                    expected.exec_aliases,
                    expected.executable,
                )
            } else {
                let side_index = index - EXPECTED_WASIX_POSTMASTER_EXECUTABLES.len();
                (
                    "side-module",
                    SEALED_EXPORT_SIDE_PATHS[side_index],
                    &[] as &[&str],
                    None,
                )
            };
        let expected_name = format!(
            "runtime:{}",
            module_path
                .rsplit_once('/')
                .map_or(module_path, |(_, basename)| basename)
        );
        let expected_aliases = exec_aliases.iter().copied();
        let module_digest_is_valid = parse_sha256("module-sha256", &artifact.module_sha256).is_ok();
        let expected_artifact_path =
            format!("aot/{}.bin", artifact.module_sha256.to_ascii_uppercase());
        if artifact.name != expected_name
            || artifact.kind != kind
            || artifact.module_path != module_path
            || artifact
                .exec_aliases
                .iter()
                .map(String::as_str)
                .ne(expected_aliases)
            || artifact.compressed
            || artifact.linear_memory.profile_id != manifest.linear_memory_profile.id
            || artifact.linear_memory.install_receipt_sha256
                != manifest.linear_memory_profile.install_receipt_sha256
            || parse_sha256(
                "linear-memory-source-module-sha256",
                &artifact.linear_memory.source_module_sha256,
            )
            .is_err()
            || !module_digest_is_valid
            || artifact.path != expected_artifact_path
            || !names.insert(artifact.name.as_str())
            || !module_paths.insert(artifact.module_path.as_str())
            || !artifact_paths.insert(artifact.path.as_str())
        {
            return false;
        }
    }
    true
}

/// Activate only the selected AOT entrypoint and retain the remaining exact closure lazily.
pub fn load(
    prepared: PreparedSealedManifest,
    engine: &Engine,
) -> Result<LoadedSealedModules, Error> {
    let PreparedSealedManifest {
        manifest,
        carrier_root,
        input_path,
        input_canonical,
        runtime_identity: _,
    } = prepared;
    validate_manifest_identity(&manifest, engine)?;
    let activation_policy = SealedActivationPolicy::from_environment()?;
    audit_executor_trust_boundary(&manifest);

    ensure!(
        !manifest.artifacts.is_empty(),
        "sealed manifest has no artifacts"
    );
    let mut names = HashSet::new();
    let mut aliases = HashMap::<String, ModuleHash>::new();
    let mut artifact_paths = HashSet::new();
    let mut module_paths = HashSet::new();
    let mut executables = Vec::new();
    let mut artifacts = HashMap::new();
    let mut declared_entrypoint = false;
    let mut selected: Option<ModuleHash> = None;
    let input_name = input_path.to_string_lossy();

    for artifact in &manifest.artifacts {
        ensure!(
            names.insert(artifact.name.as_str()),
            "sealed manifest contains duplicate artifact name '{}'",
            artifact.name
        );
        ensure!(
            matches!(artifact.kind.as_str(), "executable" | "side-module"),
            "sealed artifact '{}' has unsupported kind '{}'",
            artifact.name,
            artifact.kind
        );
        ensure!(
            !artifact.compressed,
            "sealed artifact '{}' must be an uncompressed, directly mappable AOT file",
            artifact.name
        );
        ensure!(
            artifact.sha256.eq_ignore_ascii_case(&artifact.raw_sha256),
            "sealed artifact '{}' must use the same packaged and raw digest when uncompressed",
            artifact.name
        );
        if artifact.kind == "executable" {
            ensure!(
                !artifact.exec_aliases.is_empty(),
                "sealed executable '{}' has no aliases",
                artifact.name
            );
        } else {
            ensure!(
                artifact.exec_aliases.is_empty(),
                "sealed side module '{}' must not declare executable aliases",
                artifact.name
            );
        }

        let module_path = carrier_file_path(&carrier_root, &artifact.module_path)?;
        ensure!(
            module_paths.insert(module_path.clone()),
            "sealed manifest contains duplicate module path '{}'",
            artifact.module_path
        );
        // Raw module bytes do not authorize execution. Executables resolve
        // directly to the manifest hash, and guest-loaded side modules are
        // hashed by the loader before the authoritative cache lookup. A
        // changed raw module therefore resolves to NotFound. Avoid faulting
        // every inactive raw module into the cold-start cgroup here; validate
        // only its path/type/size and derive the admitted key from the strict
        // manifest. The AOT activation independently hashes its immutable
        // snapshot and checks the archive's embedded module hash.
        let raw_module = open_regular(&module_path)?;
        let raw_module_size = raw_module.metadata()?.len();
        ensure!(
            raw_module_size == artifact.module_size,
            "size mismatch for {}: manifest={} actual={}",
            module_path.display(),
            artifact.module_size,
            raw_module_size
        );
        let module_digest = parse_sha256("module-sha256", &artifact.module_sha256)?;
        let module_hash = ModuleHash::from_bytes(module_digest);
        tracing::debug!(
            target: "wasmer_cli::sealed_loader_audit",
            audit_schema = "oliphaunt.wasix-postmaster.sealed-loader-audit.v1",
            artifact_name = artifact.name.as_str(),
            artifact_kind = "raw-module",
            module_sha256 = %module_hash,
            activation_state = "inactive",
            snapshot_mode = "metadata-only-authoritative-on-use",
            logical_bytes = artifact.module_size,
            source_bytes_read = 0_u64,
            snapshot_bytes_written = 0_u64,
            mapping_bytes_hashed = 0_u64,
            sync_calls = 0_u64,
            write_policy = "none",
            "prepared sealed raw module identity"
        );
        drop(raw_module);

        let artifact_path = carrier_file_path(&carrier_root, &artifact.path)?;
        ensure!(
            artifact_paths.insert(artifact_path.clone()),
            "sealed manifest contains duplicate AOT artifact path '{}'",
            artifact.path
        );
        ensure!(
            !artifacts.contains_key(&module_hash),
            "sealed manifest contains duplicate module hash {module_hash} for '{}'",
            artifact.name
        );
        ensure!(
            usize::try_from(artifact.raw_size).is_ok(),
            "AOT artifact '{}' is too large to map on this host",
            artifact.name
        );
        let artifact_source = open_regular(&artifact_path)?;
        ensure!(
            artifact_source.metadata()?.len() == artifact.raw_size,
            "size mismatch for {}: manifest={} actual={}",
            artifact_path.display(),
            artifact.raw_size,
            artifact_source.metadata()?.len()
        );
        let expected_artifact_digest = parse_sha256("raw-sha256", &artifact.raw_sha256)?;
        tracing::debug!(
            target: "wasmer_cli::sealed_loader_audit",
            audit_schema = "oliphaunt.wasix-postmaster.sealed-loader-audit.v1",
            artifact_name = artifact.name.as_str(),
            artifact_kind = "aot",
            module_sha256 = %module_hash,
            activation_state = "inactive",
            snapshot_mode = "deferred-open-fd",
            logical_bytes = artifact.raw_size,
            source_bytes_read = 0_u64,
            snapshot_bytes_written = 0_u64,
            mapping_bytes_hashed = 0_u64,
            sync_calls = 0_u64,
            write_policy = "none",
            "prepared sealed artifact descriptor"
        );

        let input_matches = artifact.kind == "executable" && module_path == input_canonical;
        if artifact.kind == "executable" {
            let carrier_exec_path = module_path.to_string_lossy().into_owned();
            ensure!(
                aliases
                    .insert(carrier_exec_path.clone(), module_hash)
                    .is_none(),
                "sealed manifest contains duplicate executable alias '{carrier_exec_path}'"
            );
            executables.push((carrier_exec_path, module_hash));
        }
        for alias in &artifact.exec_aliases {
            validate_guest_alias(alias)?;
            ensure!(
                aliases.insert(alias.clone(), module_hash).is_none(),
                "sealed manifest contains duplicate executable alias '{alias}'"
            );
            executables.push((alias.clone(), module_hash));
        }

        // The host input path selects an executable by its carrier-relative
        // module-path. Guest aliases remain Unix-style WASIX paths and are not
        // overloaded with host path syntax, which keeps the manifest portable
        // across Linux, macOS, and Windows hosts. Register the exact argv[0]
        // spelling as well so an EXEC_BACKEND using that path remains sealed.
        if input_matches {
            match aliases.get(input_name.as_ref()) {
                Some(existing_hash) => ensure!(
                    *existing_hash == module_hash,
                    "selected executable spelling '{}' belongs to a different sealed artifact",
                    input_name
                ),
                None => {
                    aliases.insert(input_name.to_string(), module_hash);
                    executables.push((input_name.to_string(), module_hash));
                }
            }
        }

        artifacts.insert(
            module_hash,
            Arc::new(LazySealedArtifact::new(
                module_hash,
                expected_artifact_digest,
                SealedArtifactSource {
                    file: artifact_source,
                    path: artifact_path,
                    carrier_root: carrier_root.clone(),
                    expected_size: artifact.raw_size,
                },
                activation_policy,
            )),
        );

        if artifact.name == manifest.entrypoint {
            ensure!(
                artifact.kind == "executable",
                "sealed manifest entrypoint '{}' is not executable",
                manifest.entrypoint
            );
            declared_entrypoint = true;
        }

        if input_matches {
            ensure!(
                selected.is_none(),
                "input '{}' matches more than one sealed executable",
                input_path.display()
            );
            selected = Some(module_hash);
        }
    }

    ensure!(
        declared_entrypoint,
        "sealed manifest entrypoint '{}' is not present in artifacts",
        manifest.entrypoint
    );
    let module_hash = selected.with_context(|| {
        format!(
            "input '{}' is not an alias of any sealed executable",
            input_path.display()
        )
    })?;
    let module_cache = Arc::new(SealedModuleCache::new(engine, artifacts));
    // The selected executable is the only artifact activated at startup. All
    // remaining executable and side-module descriptors stay file-backed and
    // cold until an exact alias/hash lookup reaches the authoritative cache.
    let module = module_cache
        .load_exact(module_hash, engine)
        .with_context(|| format!("activate selected sealed executable {module_hash}"))?;

    Ok(LoadedSealedModules {
        module,
        module_hash,
        path: input_path.clone(),
        executables,
        module_cache,
    })
}

fn validate_manifest_identity(manifest: &SealedManifest, engine: &Engine) -> Result<(), Error> {
    ensure!(
        manifest.format_version == MANIFEST_FORMAT_VERSION,
        "sealed manifest format mismatch: manifest={} runtime={MANIFEST_FORMAT_VERSION}",
        manifest.format_version
    );
    ensure!(
        manifest.schema == MANIFEST_SCHEMA,
        "sealed manifest schema mismatch: manifest={} runtime={MANIFEST_SCHEMA}",
        manifest.schema
    );
    ensure!(
        manifest.source_lane == "wasix-postmaster",
        "sealed manifest source lane must be 'wasix-postmaster'"
    );
    ensure_nonempty("source-fingerprint", &manifest.source_fingerprint)?;
    ensure!(
        matches!(manifest.core_profile.as_str(), "release-o3" | "safe-o2"),
        "sealed manifest core-profile must be release-o3 candidate or safe-o2 control"
    );
    ensure_nonempty("postgres-version", &manifest.postgres_version)?;
    ensure_nonempty("host-abi", &manifest.host_abi)?;
    ensure!(
        manifest.target_triple == Target::default().triple().to_string(),
        "sealed manifest target mismatch: manifest={} runtime={}",
        manifest.target_triple,
        Target::default().triple()
    );
    ensure!(
        manifest.engine == "llvm-opta",
        "sealed manifest producer engine must be 'llvm-opta'"
    );
    ensure_nonempty("compiler-config", &manifest.compiler_config)?;
    ensure!(
        manifest.cpu_policy == "generic-baseline" && manifest.cpu_features.is_empty(),
        "sealed manifest currently requires generic-baseline CPU policy with no host-specific features"
    );
    ensure!(
        manifest.wasmer_version == env!("CARGO_PKG_VERSION"),
        "sealed manifest Wasmer version mismatch: manifest={} runtime={}",
        manifest.wasmer_version,
        env!("CARGO_PKG_VERSION")
    );
    ensure!(
        manifest.wasmer_wasix_version == wasmer_wasix::VERSION,
        "sealed manifest wasmer-wasix version mismatch: manifest={} runtime={}",
        manifest.wasmer_wasix_version,
        wasmer_wasix::VERSION
    );
    ensure!(
        manifest.artifact_abi_version == ARTIFACT_ABI_VERSION,
        "sealed manifest artifact ABI mismatch: manifest={} runtime={ARTIFACT_ABI_VERSION}",
        manifest.artifact_abi_version
    );
    let runtime_abi_id = option_env!("OLIPHAUNT_WASIX_RUNTIME_ABI_ID").context(
        "this headless executor was not built with OLIPHAUNT_WASIX_RUNTIME_ABI_ID and cannot load sealed carriers",
    )?;
    ensure!(
        manifest.runtime_abi_id.eq_ignore_ascii_case(runtime_abi_id),
        "sealed manifest runtime ABI mismatch: manifest={} runtime={runtime_abi_id}",
        manifest.runtime_abi_id
    );
    ensure!(
        engine.deterministic_id() == manifest.executor_engine,
        "sealed manifest executor mismatch: manifest={} runtime={}",
        manifest.executor_engine,
        engine.deterministic_id()
    );
    ensure!(
        manifest.executor_engine == "engine-headless",
        "sealed modules require the compiler-free headless executor"
    );
    validate_linear_memory_profile(&manifest.linear_memory_profile)?;

    validate_git_sha1("wasmer-source-commit", &manifest.wasmer_source_commit)?;
    for (field, value) in [
        ("wasmer-patch-sha256", manifest.wasmer_patch_sha256.as_str()),
        (
            "wasmer-cargo-lock-sha256",
            manifest.wasmer_cargo_lock_sha256.as_str(),
        ),
        (
            "producer-recipe-sha256",
            manifest.producer_recipe_sha256.as_str(),
        ),
        (
            "guest-build-recipe-sha256",
            manifest.guest_build_recipe_sha256.as_str(),
        ),
        ("runtime-abi-id", manifest.runtime_abi_id.as_str()),
        ("executor-sha256", manifest.executor_sha256.as_str()),
    ] {
        parse_sha256(field, value)?;
    }
    ensure!(
        manifest.executor_size > 0,
        "sealed manifest executor-size must be positive"
    );
    let mut features = BTreeSet::new();
    for feature in &manifest.wasm_features {
        ensure!(
            features.insert(feature.as_str()),
            "sealed manifest contains duplicate Wasm feature '{feature}'"
        );
    }
    for expected in EXPECTED_WASM_FEATURES {
        ensure!(
            features.contains(expected),
            "sealed manifest is missing required Wasm feature '{expected}'"
        );
    }
    ensure!(
        features.len() == EXPECTED_WASM_FEATURES.len(),
        "sealed manifest Wasm feature set must be exact: expected={:?} actual={:?}",
        EXPECTED_WASM_FEATURES,
        features
    );
    Ok(())
}

fn audit_executor_trust_boundary(manifest: &SealedManifest) {
    // The executor digest comes from the same manifest and therefore cannot
    // authenticate that manifest or the running executable. The carrier's
    // external verifier/install boundary binds these bytes; compile-time ABI
    // and deterministic engine checks above enforce runtime compatibility.
    // Re-reading /proc/self/exe here would fault the whole executor into the
    // embedded cgroup without adding a cryptographic trust anchor.
    tracing::debug!(
        target: "wasmer_cli::sealed_loader_audit",
        audit_schema = "oliphaunt.wasix-postmaster.sealed-loader-audit.v1",
        artifact_kind = "headless-executor",
        activation_state = "external-verifier-trust-boundary",
        snapshot_mode = "metadata-only-no-runtime-read",
        logical_bytes = manifest.executor_size,
        source_bytes_read = 0_u64,
        source_bytes_written = 0_u64,
        snapshot_bytes_written = 0_u64,
        mapping_bytes_hashed = 0_u64,
        sync_calls = 0_u64,
        write_policy = "none",
        trust_binding = "external-carrier-verifier-plus-compile-time-runtime-abi",
        "accepted externally verified headless executor identity"
    );
}

fn read_small_regular_file(path: &Path, max_size: u64) -> Result<Vec<u8>, Error> {
    let file = open_regular(path)?;
    let len = file.metadata()?.len();
    ensure!(len <= max_size, "file exceeds {max_size} byte limit");
    let read_limit = max_size
        .checked_add(1)
        .context("small regular file limit overflow")?;
    let capacity = usize::try_from(len.min(read_limit))
        .context("small regular file exceeds host address width")?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(read_limit).read_to_end(&mut bytes)?;
    ensure!(
        u64::try_from(bytes.len())
            .ok()
            .is_some_and(|len| len <= max_size),
        "file grew beyond {max_size} byte limit while being read"
    );
    Ok(bytes)
}

fn immutable_artifact_snapshot(
    source: SealedArtifactSource,
    policy: SealedActivationPolicy,
) -> Result<ImmutableArtifactSnapshot, Error> {
    let expected_size = source.expected_size;
    ensure!(
        usize::try_from(expected_size).is_ok(),
        "AOT artifact is too large to map on this host"
    );
    let metadata = source.file.metadata()?;
    ensure!(
        metadata.len() == expected_size,
        "size mismatch for {}: manifest={} actual={}",
        source.path.display(),
        expected_size,
        metadata.len()
    );

    #[cfg(windows)]
    bail!(
        "sealed AOT activation is disabled on Windows until a pathless, deny-write snapshot lifecycle is implemented"
    );

    #[cfg(target_os = "linux")]
    if let Ok(snapshot) = direct_immutable_artifact_snapshot(&source) {
        return Ok(snapshot);
    }

    if policy.requires_direct_immutable() {
        bail!(
            "{REQUIRE_ZERO_WRITE_AOT_ENV}=1 requires direct activation from a SquashFS/EROFS or immutable-inode AOT source; refusing reflink and streamed-copy compatibility modes for {}",
            source.path.display()
        );
    }

    #[cfg(target_os = "linux")]
    if let Ok(snapshot) = reflink_artifact_snapshot(&source) {
        return Ok(snapshot);
    }

    streamed_artifact_snapshot(source)
}

#[cfg(target_os = "linux")]
fn direct_immutable_artifact_snapshot(
    source: &SealedArtifactSource,
) -> Result<ImmutableArtifactSnapshot, Error> {
    let immutable = intrinsic_file_immutability(&source.file).map_err(Error::msg)?;
    direct_artifact_snapshot_from_proof(source, immutable)
}

#[cfg(target_os = "linux")]
fn direct_artifact_snapshot_from_proof(
    source: &SealedArtifactSource,
    immutable: IntrinsicFileImmutability,
) -> Result<ImmutableArtifactSnapshot, Error> {
    let file = source
        .file
        .try_clone()
        .context("duplicate direct immutable AOT descriptor")?;
    ensure!(
        file.metadata()?.len() == source.expected_size,
        "direct immutable AOT artifact changed size"
    );
    Ok(ImmutableArtifactSnapshot {
        file,
        source_file: None,
        len: source.expected_size,
        audit: ArtifactSnapshotAudit {
            mode: ArtifactSnapshotMode::DirectIntrinsic(immutable),
            logical_bytes: source.expected_size,
            // The digest walks the source-backed mapping exactly once.
            source_bytes_read: source.expected_size,
            snapshot_bytes_written: 0,
            mapping_bytes_hashed: source.expected_size,
            sync_calls: 0,
        },
    })
}

fn streamed_artifact_snapshot(
    mut source: SealedArtifactSource,
) -> Result<ImmutableArtifactSnapshot, Error> {
    let expected_size = source.expected_size;
    let mut snapshot = create_disk_backed_snapshot_file(&source.carrier_root)?;
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = source.file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .context("AOT artifact size overflow while creating immutable snapshot")?;
        ensure!(
            copied <= expected_size,
            "size mismatch for {}: manifest={} actual exceeds manifest size",
            source.path.display(),
            expected_size
        );
        snapshot.file_mut().write_all(&buffer[..count])?;
    }
    ensure!(
        copied == expected_size,
        "size mismatch for {}: manifest={} copied={copied}",
        source.path.display(),
        expected_size
    );
    let mut finalized = snapshot.finalize(
        expected_size,
        ArtifactSnapshotAudit {
            mode: ArtifactSnapshotMode::StreamedCopy,
            logical_bytes: expected_size,
            source_bytes_read: copied,
            snapshot_bytes_written: copied,
            mapping_bytes_hashed: expected_size,
            sync_calls: 0,
        },
    )?;
    finalized.source_file = Some(source.file);
    Ok(finalized)
}

#[cfg(target_os = "linux")]
fn reflink_artifact_snapshot(
    source: &SealedArtifactSource,
) -> Result<ImmutableArtifactSnapshot, Error> {
    use std::os::fd::AsRawFd;

    let mut candidates = vec![
        source
            .path
            .parent()
            .context("sealed AOT artifact must have a parent directory")?
            .to_path_buf(),
    ];
    candidates.extend(artifact_snapshot_directories(&source.carrier_root));
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for directory in candidates {
        if !seen.insert(directory.clone()) || !directory.is_dir() {
            continue;
        }
        let attempt = (|| -> Result<_, Error> {
            let destination = create_anonymous_snapshot_file(&directory)?;
            // SAFETY: both descriptors remain live for the ioctl. FICLONE
            // creates a copy-on-write clone and does not share later writes.
            // The kernel also rejects a destination on a different filesystem.
            let result = unsafe {
                libc::ioctl(
                    destination.as_raw_fd(),
                    libc::FICLONE,
                    source.file.as_raw_fd(),
                )
            };
            if result != 0 {
                return Err(std::io::Error::last_os_error()).context("reflink sealed AOT artifact");
            }
            ensure!(
                destination.metadata()?.len() == source.expected_size,
                "reflinked AOT artifact size mismatch"
            );
            let mut snapshot = WritableArtifactSnapshot::Anonymous(destination).finalize(
                source.expected_size,
                ArtifactSnapshotAudit {
                    mode: ArtifactSnapshotMode::Reflink,
                    logical_bytes: source.expected_size,
                    source_bytes_read: 0,
                    snapshot_bytes_written: 0,
                    mapping_bytes_hashed: source.expected_size,
                    sync_calls: 0,
                },
            )?;
            snapshot.source_file = Some(
                source
                    .file
                    .try_clone()
                    .context("duplicate reflink AOT source descriptor")?,
            );
            Ok(snapshot)
        })();
        match attempt {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => failures.push(format!("{}: {error:#}", directory.display())),
        }
    }
    bail!(
        "no writable same-filesystem O_TMPFILE destination accepted FICLONE{}",
        if failures.is_empty() {
            String::new()
        } else {
            format!(": {}", failures.join("; "))
        }
    )
}

fn artifact_snapshot_directories(carrier_root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("OLIPHAUNT_WASIX_ARTIFACT_SNAPSHOT_DIR") {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.push(carrier_root.to_path_buf());
    #[cfg(unix)]
    candidates.push(PathBuf::from("/var/tmp"));
    candidates.push(std::env::temp_dir());
    #[cfg(feature = "compat-cache-dir")]
    {
        if let Some(cache_dir) = dirs::cache_dir() {
            candidates.push(cache_dir);
        }
    }
    candidates
}

fn create_disk_backed_snapshot_file(
    carrier_root: &Path,
) -> Result<WritableArtifactSnapshot, Error> {
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for candidate in artifact_snapshot_directories(carrier_root) {
        if !seen.insert(candidate.clone()) || !candidate.is_dir() {
            continue;
        }
        #[cfg(target_os = "linux")]
        match create_anonymous_snapshot_file(&candidate) {
            Ok(file) => return Ok(WritableArtifactSnapshot::Anonymous(file)),
            Err(error) => failures.push(format!("{} (O_TMPFILE): {error:#}", candidate.display())),
        }
        let attempt = (|| -> Result<_, Error> {
            let temp_dir = tempfile::Builder::new()
                .prefix(".wasmer-sealed-aot-")
                .tempdir_in(&candidate)
                .with_context(|| {
                    format!(
                        "create private snapshot directory in {}",
                        candidate.display()
                    )
                })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(temp_dir.path(), fs::Permissions::from_mode(0o700))?;
            }
            let snapshot = tempfile::Builder::new()
                .prefix("artifact-")
                .tempfile_in(temp_dir.path())
                .context("create private snapshot file")?;
            ensure_disk_backed(snapshot.as_file())?;
            Ok(WritableArtifactSnapshot::Named {
                temp_dir,
                file: snapshot,
            })
        })();
        match attempt {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => failures.push(format!("{}: {error:#}", candidate.display())),
        }
    }

    bail!(
        "unable to create a private disk-backed AOT snapshot{}",
        if failures.is_empty() {
            String::new()
        } else {
            format!(": {}", failures.join("; "))
        }
    )
}

#[cfg(target_os = "linux")]
fn create_anonymous_snapshot_file(directory: &Path) -> Result<File, Error> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_TMPFILE | libc::O_CLOEXEC);
    let file = options
        .open(directory)
        .with_context(|| format!("create anonymous snapshot in {}", directory.display()))?;
    ensure_disk_backed(&file)?;

    // Verify up front that this host exposes a safe way to downgrade the
    // anonymous inode to a read-only descriptor after the copy. If /proc is
    // unavailable, the caller will use the private named/unlink fallback.
    let probe = reopen_anonymous_snapshot_read_only(&file)?;
    verify_same_unix_file(&file, &probe)?;
    Ok(file)
}

#[cfg(target_os = "linux")]
fn reopen_anonymous_snapshot_read_only(file: &File) -> Result<File, Error> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};

    let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(libc::O_CLOEXEC);
    options.open(&descriptor_path).with_context(|| {
        format!(
            "reopen anonymous snapshot via {}",
            descriptor_path.display()
        )
    })
}

#[cfg(target_os = "linux")]
fn verify_same_unix_file(first: &File, second: &File) -> Result<(), Error> {
    use std::os::unix::fs::MetadataExt;

    let first = first.metadata()?;
    let second = second.metadata()?;
    ensure!(
        first.dev() == second.dev() && first.ino() == second.ino(),
        "private snapshot changed identity while being sealed"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_disk_backed(file: &File) -> Result<(), Error> {
    use std::os::fd::AsRawFd;

    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `stat` points to writable storage and the file descriptor remains
    // open for the duration of the call.
    let result = unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error()).context("identify snapshot filesystem");
    }
    // SAFETY: a successful fstatfs initialized the structure.
    let filesystem_type = unsafe { stat.assume_init() }.f_type as u64;
    const TMPFS_MAGIC: u64 = 0x0102_1994;
    const RAMFS_MAGIC: u64 = 0x8584_58f6;
    const HUGETLBFS_MAGIC: u64 = 0x9584_58f6;
    ensure!(
        !matches!(filesystem_type, TMPFS_MAGIC | RAMFS_MAGIC | HUGETLBFS_MAGIC),
        "snapshot filesystem is memory-backed (type 0x{filesystem_type:x})"
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn ensure_disk_backed(_file: &File) -> Result<(), Error> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn finalize_anonymous_snapshot(
    snapshot: File,
    expected_size: u64,
    audit: ArtifactSnapshotAudit,
) -> Result<ImmutableArtifactSnapshot, Error> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    snapshot.set_permissions(fs::Permissions::from_mode(0o400))?;
    let read_only = reopen_anonymous_snapshot_read_only(&snapshot)?;
    verify_same_unix_file(&snapshot, &read_only)?;
    ensure!(
        read_only.metadata()?.len() == expected_size,
        "anonymous snapshot changed size while being sealed"
    );
    ensure!(
        read_only.metadata()?.nlink() == 0,
        "anonymous snapshot unexpectedly acquired a filesystem path"
    );
    drop(snapshot);
    advise_file_away(&read_only);
    Ok(ImmutableArtifactSnapshot {
        file: read_only,
        source_file: None,
        len: expected_size,
        audit,
    })
}

#[cfg(unix)]
fn finalize_named_snapshot(
    temp_dir: tempfile::TempDir,
    snapshot: tempfile::NamedTempFile,
    expected_size: u64,
    audit: ArtifactSnapshotAudit,
) -> Result<ImmutableArtifactSnapshot, Error> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    snapshot
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o400))?;
    let writer_metadata = snapshot.as_file().metadata()?;
    let path = snapshot.path().to_path_buf();
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let read_only = options
        .open(&path)
        .with_context(|| format!("reopen immutable snapshot {} read-only", path.display()))?;
    let reader_metadata = read_only.metadata()?;
    ensure!(
        writer_metadata.dev() == reader_metadata.dev()
            && writer_metadata.ino() == reader_metadata.ino(),
        "private snapshot changed identity while being sealed"
    );
    ensure!(
        reader_metadata.len() == expected_size,
        "private snapshot changed size while being sealed"
    );

    fs::remove_file(&path)
        .with_context(|| format!("unlink immutable snapshot {}", path.display()))?;
    drop(snapshot);
    drop(temp_dir);

    #[cfg(target_os = "linux")]
    ensure!(
        read_only.metadata()?.nlink() == 0,
        "immutable snapshot remained reachable by a filesystem path"
    );
    advise_file_away(&read_only);
    Ok(ImmutableArtifactSnapshot {
        file: read_only,
        source_file: None,
        len: expected_size,
        audit,
    })
}

#[cfg(windows)]
fn finalize_named_snapshot(
    _temp_dir: tempfile::TempDir,
    _snapshot: tempfile::NamedTempFile,
    _expected_size: u64,
    _audit: ArtifactSnapshotAudit,
) -> Result<ImmutableArtifactSnapshot, Error> {
    bail!(
        "Windows named-temp AOT snapshots are disabled: the prior close/reopen lifecycle could delete the path before establishing the final deny-write handle"
    )
}

#[cfg(not(any(unix, windows)))]
fn finalize_named_snapshot(
    _temp_dir: tempfile::TempDir,
    _snapshot: tempfile::NamedTempFile,
    _expected_size: u64,
    _audit: ArtifactSnapshotAudit,
) -> Result<ImmutableArtifactSnapshot, Error> {
    bail!("immutable sealed AOT snapshots are not implemented on this host")
}

fn open_regular(path: &Path) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        // Keep the exact carrier inode stable for the duration of validation:
        // other handles may read it, but cannot obtain write/delete sharing.
        options.share_mode(FILE_SHARE_READ);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open regular file {}", path.display()))?;
    ensure!(
        file.metadata()?.is_file(),
        "carrier path is not a regular file: {}",
        path.display()
    );
    Ok(file)
}

fn carrier_file_path(root: &Path, relative: &str) -> Result<PathBuf, Error> {
    ensure_nonempty("carrier file path", relative)?;
    let relative_path = Path::new(relative);
    ensure!(
        relative_path
            .components()
            .all(|component| matches!(component, Component::Normal(_))),
        "carrier file path must be a normalized relative path: {relative}"
    );
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("resolve carrier root {}", root.display()))?;
    let path = canonical_root.join(relative_path);
    let canonical = path
        .canonicalize()
        .with_context(|| format!("resolve carrier file {}", path.display()))?;
    ensure!(
        canonical.starts_with(&canonical_root),
        "carrier file escapes carrier root: {relative}"
    );
    Ok(canonical)
}

fn validate_guest_alias(alias: &str) -> Result<(), Error> {
    ensure!(
        alias.starts_with('/'),
        "guest executable alias must be absolute: {alias}"
    );
    ensure!(
        !alias.contains('\\')
            && alias
                .split('/')
                .skip(1)
                .all(|component| !component.is_empty() && component != "." && component != ".."),
        "guest executable alias must be normalized: {alias}"
    );
    Ok(())
}

fn ensure_nonempty(field: &str, value: &str) -> Result<(), Error> {
    ensure!(
        !value.trim().is_empty(),
        "sealed manifest field '{field}' is empty"
    );
    Ok(())
}

fn parse_sha256(field: &str, value: &str) -> Result<[u8; 32], Error> {
    ensure!(
        value.len() == 64,
        "sealed manifest field '{field}' is not a SHA-256 digest"
    );
    let mut digest = [0_u8; 32];
    hex::decode_to_slice(value, &mut digest)
        .with_context(|| format!("sealed manifest field '{field}' is not hexadecimal"))?;
    Ok(digest)
}

fn validate_git_sha1(field: &str, value: &str) -> Result<(), Error> {
    ensure!(
        value.len() == 40,
        "sealed manifest field '{field}' is not a Git SHA-1"
    );
    ensure!(
        value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "sealed manifest field '{field}' is not hexadecimal"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_artifact(expected: ExpectedWasixPostmasterArtifact, digest_byte: u8) -> SealedArtifact {
        let module_sha256 = format!("{digest_byte:02x}").repeat(32);
        let artifact_sha256 = format!("{:02x}", digest_byte.wrapping_add(32)).repeat(32);
        SealedArtifact {
            name: format!(
                "runtime:{}",
                expected
                    .module_path
                    .rsplit_once('/')
                    .map_or(expected.module_path, |(_, basename)| basename)
            ),
            kind: expected.kind.to_string(),
            path: format!("aot/{}.bin", module_sha256.to_ascii_uppercase()),
            module_path: expected.module_path.to_string(),
            sha256: artifact_sha256.clone(),
            raw_sha256: artifact_sha256,
            raw_size: 1,
            module_sha256,
            module_size: 1,
            linear_memory: SealedArtifactLinearMemory {
                profile_id: LINEAR_MEMORY_PROFILE_ID.to_string(),
                source_module_sha256: format!("{:02x}", digest_byte.wrapping_add(96)).repeat(32),
                install_receipt_sha256: "8".repeat(64),
            },
            compressed: false,
            exec_aliases: expected
                .exec_aliases
                .iter()
                .map(|alias| (*alias).to_string())
                .collect(),
        }
    }

    fn test_wasix_postmaster_manifest() -> SealedManifest {
        SealedManifest {
            format_version: MANIFEST_FORMAT_VERSION,
            schema: MANIFEST_SCHEMA.to_string(),
            source_lane: WASIX_POSTMASTER_SOURCE_LANE.to_string(),
            source_fingerprint: "source-fingerprint".to_string(),
            core_profile: "release-o3".to_string(),
            guest_build_recipe_sha256: "7".repeat(64),
            postgres_version: "18.4".to_string(),
            target_triple: "test-target".to_string(),
            host_abi: "test-abi".to_string(),
            engine: "llvm-opta".to_string(),
            compiler_config: "test-compiler".to_string(),
            cpu_policy: "generic-baseline".to_string(),
            cpu_features: Vec::new(),
            wasmer_version: "test-wasmer".to_string(),
            wasmer_wasix_version: "test-wasmer-wasix".to_string(),
            wasmer_source_commit: "1".repeat(40),
            wasmer_patch_sha256: "2".repeat(64),
            wasmer_cargo_lock_sha256: "3".repeat(64),
            artifact_abi_version: ARTIFACT_ABI_VERSION,
            runtime_abi_id: "4".repeat(64),
            producer_recipe_sha256: "5".repeat(64),
            executor_engine: "engine-headless".to_string(),
            executor_sha256: "6".repeat(64),
            executor_size: 1,
            linear_memory_profile: SealedLinearMemoryProfile {
                id: LINEAR_MEMORY_PROFILE_ID.to_string(),
                address_width: "wasm32".to_string(),
                supported_host_pointer_width: "u64".to_string(),
                maximum_pages: LINEAR_MEMORY_MAXIMUM_PAGES,
                maximum_bytes: LINEAR_MEMORY_MAXIMUM_BYTES,
                static_bound_pages: LINEAR_MEMORY_STATIC_BOUND_PAGES,
                static_offset_guard_bytes: LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES,
                static_access_lowering: "wasmer-llvm-unchecked-reservation-and-guard-v1"
                    .to_string(),
                install_receipt_path: "receipts/linear-memory-profile.json".to_string(),
                install_receipt_sha256: "8".repeat(64),
            },
            wasm_features: EXPECTED_WASM_FEATURES
                .iter()
                .map(|feature| (*feature).to_string())
                .collect(),
            entrypoint: WASIX_POSTMASTER_ENTRYPOINT.to_string(),
            artifacts: EXPECTED_WASIX_POSTMASTER_EXECUTABLES
                .iter()
                .copied()
                .enumerate()
                .map(|(index, expected)| test_artifact(expected, index as u8 + 1))
                .chain(
                    SEALED_EXPORT_SIDE_PATHS
                        .iter()
                        .enumerate()
                        .map(|(index, module_path)| {
                            test_artifact(
                                ExpectedWasixPostmasterArtifact {
                                    kind: "side-module",
                                    module_path,
                                    exec_aliases: &[],
                                    executable: None,
                                },
                                index as u8 + 3,
                            )
                        }),
                )
                .collect(),
        }
    }

    fn write_test_manifest(root: &Path) -> PathBuf {
        let mut manifest = test_wasix_postmaster_manifest();
        let mut modules: Vec<_> = manifest
            .artifacts
            .iter()
            .map(|artifact| LinearMemoryInstallModule {
                path: artifact.module_path.clone(),
                source_module_sha256: artifact.linear_memory.source_module_sha256.clone(),
                module_sha256: artifact.module_sha256.clone(),
                initial_pages: 1,
                maximum_pages: u64::from(LINEAR_MEMORY_MAXIMUM_PAGES),
                maximum_bytes: LINEAR_MEMORY_MAXIMUM_BYTES,
                shared: true,
                import_module: "env".to_string(),
                import_name: "memory".to_string(),
                transformation: SEALED_MODULE_TRANSFORMATION_ID.to_string(),
            })
            .collect();
        for (index, path) in SEALED_EXPORT_SIDE_PATHS.iter().enumerate() {
            if modules.iter().any(|module| module.path == *path) {
                continue;
            }
            modules.push(LinearMemoryInstallModule {
                path: (*path).to_string(),
                source_module_sha256: format!("{:02x}", 0x80 + index as u8).repeat(32),
                module_sha256: format!("{:02x}", 0xa0 + index as u8).repeat(32),
                initial_pages: 1,
                maximum_pages: u64::from(LINEAR_MEMORY_MAXIMUM_PAGES),
                maximum_bytes: LINEAR_MEMORY_MAXIMUM_BYTES,
                shared: true,
                import_module: "env".to_string(),
                import_name: "memory".to_string(),
                transformation: SEALED_MODULE_TRANSFORMATION_ID.to_string(),
            });
        }
        modules.sort_by(|left, right| left.path.cmp(&right.path));
        let source_sha256 = |path: &str| {
            modules
                .iter()
                .find(|module| module.path == path)
                .unwrap()
                .source_module_sha256
                .clone()
        };
        let side_identities = SEALED_EXPORT_SIDE_PATHS
            .iter()
            .map(|path| serde_json::json!({"path": path, "sha256": source_sha256(path)}))
            .collect::<Vec<_>>();
        let proof_module = |path: &str, sha256: String| {
            serde_json::json!({
                "path": path,
                "sha256": sha256,
                "bytes": 1,
                "non-export-sections-sha256": "b".repeat(64),
                "dylink-needed": [],
                "imported-functions": 0,
                "local-functions": 1,
                "imported-globals": 0,
                "local-globals": 0,
                "imported-tables": 0,
                "local-tables": 1,
                "element-function-entries": 1,
                "element-unique-function-indices": 1,
                "element-max-function-index": 0,
                "start-function-index": 0,
                "imports": [],
                "export-counts": {},
                "exported-global-type-counts": {},
                "exported-immutable-i32-globals": 0,
                "exported-local-functions": 0,
                "exported-imported-functions": 0
            })
        };
        let proof = |main_sha256: String| {
            serde_json::json!({
                "schema": SEALED_EXPORT_PROOF_SCHEMA,
                "policy-id": SEALED_EXPORT_POLICY_ID,
                "analyzer-version": "fixture",
                "mandatory-policy-sha256": SEALED_EXPORT_MANDATORY_POLICY_SHA256,
                "declared-main-dlsym-policy-sha256": SEALED_EXPORT_DLSYM_POLICY_SHA256,
                "main": proof_module("bin/postgres", main_sha256),
                "sides": SEALED_EXPORT_SIDE_PATHS.iter().map(|path| {
                    proof_module(path, source_sha256(path))
                }).collect::<Vec<_>>(),
                "mandatory-runtime-exports": [],
                "declared-main-dlsym-exports": [],
                "side-dynamic-imports": [],
                "retained-main-exports": [],
                "retained-main-export-descriptors": [],
                "removed-main-export-count": 1,
                "removed-main-export-names-sha256": "c".repeat(64),
                "unresolved-main-requirements": [],
                "mismatched-main-requirements": [],
                "unresolved-side-dependencies": [],
                "retained-counts": {},
                "removed-counts": {"function": 1}
            })
        };
        let seed_sha256 = "d".repeat(64);
        let final_sha256 = source_sha256("bin/postgres");
        let seed_proof_bytes = serde_json::to_vec(&proof(seed_sha256.clone())).unwrap();
        let final_proof_bytes = serde_json::to_vec(&proof(final_sha256.clone())).unwrap();
        let allowlist_bytes = b"fixture-export\n";
        let share = root.join("share/postgresql");
        fs::create_dir_all(&share).unwrap();
        fs::write(root.join(SEALED_EXPORT_SEED_PROOF_PATH), &seed_proof_bytes).unwrap();
        fs::write(
            root.join(SEALED_EXPORT_FINAL_PROOF_PATH),
            &final_proof_bytes,
        )
        .unwrap();
        fs::write(root.join(SEALED_EXPORT_ALLOWLIST_PATH), allowlist_bytes).unwrap();
        let snapshot = |sha256: String| {
            serde_json::json!({
                "sha256": sha256,
                "bytes": 1,
                "exports": 0,
                "local-functions": 1,
                "local-globals": 0,
                "element-function-entries": 1,
                "element-unique-function-indices": 1,
                "start-function-index": 0
            })
        };
        let export_receipt = serde_json::json!({
            "schema": SEALED_EXPORT_RECEIPT_SCHEMA,
            "policy-id": SEALED_EXPORT_POLICY_ID,
            "analyzer-version": "fixture",
            "analyzer-binary-sha256": "e".repeat(64),
            "dce-tool-sha256": "f".repeat(64),
            "dce-tool-version": "fixture-wasm-opt",
            "dce-passes": ["--remove-unused-module-elements"],
            "mandatory-policy-sha256": SEALED_EXPORT_MANDATORY_POLICY_SHA256,
            "declared-main-dlsym-policy-sha256": SEALED_EXPORT_DLSYM_POLICY_SHA256,
            "side-manifest-sha256": SEALED_EXPORT_SIDE_MANIFEST_SHA256,
            "allowlist-sha256": hex::encode(Sha256::digest(allowlist_bytes)),
            "seed-proof-sha256": hex::encode(Sha256::digest(&seed_proof_bytes)),
            "final-proof-sha256": hex::encode(Sha256::digest(&final_proof_bytes)),
            "seed": snapshot(seed_sha256),
            "final-module": snapshot(final_sha256),
            "sides": side_identities
        });
        let export_receipt_bytes = serde_json::to_vec(&export_receipt).unwrap();
        fs::write(root.join(SEALED_EXPORT_RECEIPT_PATH), &export_receipt_bytes).unwrap();
        let receipt = LinearMemoryInstallReceipt {
            schema: LINEAR_MEMORY_INSTALL_RECEIPT_SCHEMA.to_string(),
            profile_id: LINEAR_MEMORY_PROFILE_ID.to_string(),
            address_width: "wasm32".to_string(),
            supported_host_pointer_width: "u64".to_string(),
            maximum_pages: LINEAR_MEMORY_MAXIMUM_PAGES,
            maximum_bytes: LINEAR_MEMORY_MAXIMUM_BYTES,
            static_bound_pages: LINEAR_MEMORY_STATIC_BOUND_PAGES,
            static_offset_guard_bytes: LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES,
            static_access_lowering: "wasmer-llvm-unchecked-reservation-and-guard-v1".to_string(),
            requires_shared: true,
            requires_import: "env.memory".to_string(),
            excludes_wasm32_end_wrap: true,
            predecessor_export_closure_receipt: SEALED_EXPORT_RECEIPT_PATH.to_string(),
            predecessor_export_closure_receipt_sha256: hex::encode(Sha256::digest(
                &export_receipt_bytes,
            )),
            source_module_closure_sha256: linear_memory_closure_sha256(
                &modules,
                "source-module-sha256",
            ),
            module_closure_sha256: linear_memory_closure_sha256(&modules, "module-sha256"),
            module_count: modules.len(),
            modules,
        };
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        let receipt_sha256 = hex::encode(Sha256::digest(&receipt_bytes));
        manifest.linear_memory_profile.install_receipt_sha256 = receipt_sha256.clone();
        for artifact in &mut manifest.artifacts {
            artifact.linear_memory.install_receipt_sha256 = receipt_sha256.clone();
        }
        let receipt_path = root.join(&manifest.linear_memory_profile.install_receipt_path);
        fs::create_dir_all(receipt_path.parent().unwrap()).unwrap();
        fs::write(receipt_path, receipt_bytes).unwrap();
        let manifest_path = root.join("manifest.json");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        manifest_path
    }

    fn source_from_bytes(carrier_root: &Path, name: &str, bytes: &[u8]) -> SealedArtifactSource {
        let path = carrier_root.join(name);
        fs::write(&path, bytes).unwrap();
        SealedArtifactSource {
            file: open_regular(&path).unwrap(),
            path,
            carrier_root: carrier_root.to_path_buf(),
            expected_size: bytes.len() as u64,
        }
    }

    fn snapshot_from_bytes(
        carrier_root: &Path,
        name: &str,
        bytes: &[u8],
    ) -> ImmutableArtifactSnapshot {
        immutable_artifact_snapshot(
            source_from_bytes(carrier_root, name, bytes),
            SealedActivationPolicy::Compatibility,
        )
        .unwrap()
    }

    fn lazy_artifact_from_bytes(
        carrier_root: &Path,
        name: &str,
        bytes: &[u8],
        module_hash: ModuleHash,
    ) -> LazySealedArtifact {
        LazySealedArtifact::new(
            module_hash,
            Sha256::digest(bytes).into(),
            source_from_bytes(carrier_root, name, bytes),
            SealedActivationPolicy::Compatibility,
        )
    }

    #[test]
    fn runtime_policy_identity_requires_the_exact_postmaster_closure() {
        assert!(has_exact_wasix_postmaster_identity(
            &test_wasix_postmaster_manifest()
        ));

        let mut missing = test_wasix_postmaster_manifest();
        missing.artifacts.pop();
        assert!(!has_exact_wasix_postmaster_identity(&missing));

        let mut duplicate_path = test_wasix_postmaster_manifest();
        duplicate_path.artifacts[1].module_path = duplicate_path.artifacts[0].module_path.clone();
        assert!(!has_exact_wasix_postmaster_identity(&duplicate_path));

        let mut reordered = test_wasix_postmaster_manifest();
        reordered.artifacts.swap(0, 1);
        assert!(!has_exact_wasix_postmaster_identity(&reordered));

        let mut extra_feature = test_wasix_postmaster_manifest();
        extra_feature.wasm_features.push("simd".to_string());
        assert!(!has_exact_wasix_postmaster_identity(&extra_feature));

        let mut unsupported_profile = test_wasix_postmaster_manifest();
        unsupported_profile.core_profile = "o3".to_string();
        assert!(!has_exact_wasix_postmaster_identity(&unsupported_profile));

        let mut invalid_guest_recipe = test_wasix_postmaster_manifest();
        invalid_guest_recipe.guest_build_recipe_sha256 = "not-a-digest".to_string();
        assert!(!has_exact_wasix_postmaster_identity(&invalid_guest_recipe));

        let mut superseded_schema = test_wasix_postmaster_manifest();
        superseded_schema.format_version = 5;
        superseded_schema.schema = "oliphaunt.wasix-postmaster.sealed-aot.v4".to_string();
        assert!(!has_exact_wasix_postmaster_identity(&superseded_schema));
    }

    #[test]
    fn runtime_policy_identity_parser_rejects_unknown_manifest_fields() {
        let mut manifest = serde_json::to_value(test_wasix_postmaster_manifest()).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .insert("runtime-policy".to_string(), serde_json::json!("unknown"));
        assert!(serde_json::from_value::<SealedManifest>(manifest).is_err());

        let mut artifact_manifest = serde_json::to_value(test_wasix_postmaster_manifest()).unwrap();
        artifact_manifest["artifacts"][0]
            .as_object_mut()
            .unwrap()
            .insert("identity-extension".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<SealedManifest>(artifact_manifest).is_err());
    }

    #[test]
    fn small_regular_file_read_enforces_a_hard_stream_limit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bounded");
        fs::write(&path, b"12345678").unwrap();
        assert_eq!(read_small_regular_file(&path, 8).unwrap(), b"12345678");

        fs::write(&path, b"123456789").unwrap();
        assert!(read_small_regular_file(&path, 8).is_err());
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn strict_code_memory_state_directory_is_deterministic_private_and_deny_symlink() {
        use std::os::unix::{fs::MetadataExt, fs::PermissionsExt, fs::symlink};

        let parent = tempfile::Builder::new()
            .prefix("oliphaunt-code-memory-state-test-")
            .tempdir_in("/var/tmp")
            .unwrap();
        let carrier = parent.path().join("immutable-carrier");
        fs::create_dir(&carrier).unwrap();

        let (directory, device, inode) =
            strict_code_memory_directory_for_carrier(&carrier).unwrap();
        assert_eq!(directory, parent.path().join(CODE_MEMORY_STATE_DIRECTORY));
        let metadata = fs::symlink_metadata(&directory).unwrap();
        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(metadata.mode() & 0o7777, 0o700);
        assert_eq!(metadata.dev(), device);
        assert_eq!(metadata.ino(), inode);
        assert_eq!(
            strict_code_memory_directory_for_carrier(&carrier)
                .unwrap()
                .0,
            directory
        );

        fs::remove_dir(&directory).unwrap();
        let redirect = parent.path().join("redirect");
        fs::create_dir(&redirect).unwrap();
        fs::set_permissions(&redirect, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&redirect, &directory).unwrap();
        let error = strict_code_memory_directory_for_carrier(&carrier).unwrap_err();
        assert!(error.to_string().contains("non-symlink"));
    }

    #[test]
    fn runtime_policy_identity_selects_only_product_executables() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("bin")).unwrap();
        let initdb = root.path().join("bin/initdb");
        let postgres = root.path().join("bin/postgres");
        let unrelated = root.path().join("bin/unrelated");
        fs::write(&initdb, b"initdb").unwrap();
        fs::write(&postgres, b"postgres").unwrap();
        fs::write(&unrelated, b"unrelated").unwrap();
        let manifest_path = write_test_manifest(root.path());

        let prepared_initdb = prepare(&manifest_path, &initdb).unwrap();
        assert_eq!(
            prepared_initdb.runtime_identity(),
            Some(SealedRuntimeIdentity::WasixPostmasterInitdb)
        );
        let prepared_postgres = prepare(&manifest_path, &postgres).unwrap();
        assert_eq!(
            prepared_postgres.runtime_identity(),
            Some(SealedRuntimeIdentity::WasixPostmasterPostgres)
        );
        assert!(prepare(&manifest_path, &unrelated).is_err());

        fs::write(&manifest_path, b"{").unwrap();
        assert!(prepare(&manifest_path, &root.path().join("bin/postgres")).is_err());
    }

    #[test]
    fn carrier_paths_are_relative_and_normalized() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("artifact.bin"), b"artifact").unwrap();
        assert!(carrier_file_path(root.path(), "artifact.bin").is_ok());
        assert!(carrier_file_path(root.path(), "../artifact.bin").is_err());
        assert!(carrier_file_path(root.path(), "/artifact.bin").is_err());
        assert!(carrier_file_path(root.path(), "a/../artifact.bin").is_err());
    }

    #[test]
    fn guest_aliases_are_absolute_and_normalized() {
        assert!(validate_guest_alias("/bin/postgres").is_ok());
        assert!(validate_guest_alias("bin/postgres").is_err());
        assert!(validate_guest_alias("/bin/../postgres").is_err());
        assert!(validate_guest_alias("/bin//postgres").is_err());
    }

    #[test]
    fn sha256_fields_are_exact() {
        assert!(parse_sha256("digest", &"ab".repeat(32)).is_ok());
        assert!(parse_sha256("digest", &"ab".repeat(31)).is_err());
        assert!(parse_sha256("digest", &"zz".repeat(32)).is_err());
    }

    #[test]
    fn artifact_snapshot_is_pathless_read_only_and_stable() {
        let root = tempfile::tempdir().unwrap();
        let original = b"verified artifact bytes";
        let snapshot = snapshot_from_bytes(root.path(), "artifact.bin", original);

        assert_eq!(snapshot.audit.logical_bytes, original.len() as u64);
        assert_eq!(snapshot.audit.mapping_bytes_hashed, original.len() as u64);
        assert_eq!(snapshot.audit.sync_calls, 0);
        match snapshot.audit.mode {
            ArtifactSnapshotMode::DirectIntrinsic(_) => {
                assert_eq!(snapshot.audit.source_bytes_read, original.len() as u64);
                assert_eq!(snapshot.audit.snapshot_bytes_written, 0);
            }
            ArtifactSnapshotMode::Reflink => {
                assert_eq!(snapshot.audit.source_bytes_read, 0);
                assert_eq!(snapshot.audit.snapshot_bytes_written, 0);
            }
            ArtifactSnapshotMode::StreamedCopy => {
                assert_eq!(snapshot.audit.source_bytes_read, original.len() as u64);
                assert_eq!(snapshot.audit.snapshot_bytes_written, original.len() as u64);
            }
        }

        fs::write(root.path().join("artifact.bin"), b"mutated artifact bytes!").unwrap();
        assert_eq!(snapshot.mapping().unwrap().as_slice(), original);

        #[cfg(target_os = "linux")]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            assert_eq!(snapshot.file.metadata().unwrap().nlink(), 0);
            let flags = unsafe { libc::fcntl(snapshot.file.as_raw_fd(), libc::F_GETFL) };
            assert_ne!(flags, -1);
            assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
        }
    }

    #[test]
    fn streamed_snapshot_fallback_accounts_copy_without_sync() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"forced streamed snapshot bytes";
        let snapshot =
            streamed_artifact_snapshot(source_from_bytes(root.path(), "streamed.aot", bytes))
                .unwrap();

        assert_eq!(snapshot.audit.mode, ArtifactSnapshotMode::StreamedCopy);
        assert_eq!(snapshot.audit.logical_bytes, bytes.len() as u64);
        assert_eq!(snapshot.audit.source_bytes_read, bytes.len() as u64);
        assert_eq!(snapshot.audit.snapshot_bytes_written, bytes.len() as u64);
        assert_eq!(snapshot.audit.mapping_bytes_hashed, bytes.len() as u64);
        assert_eq!(snapshot.audit.sync_calls, 0);
        assert_eq!(snapshot.mapping().unwrap().as_slice(), bytes);
        assert!(snapshot.has_distinct_source());

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;

            let source = snapshot.source_file.as_ref().unwrap().metadata().unwrap();
            let private = snapshot.file.metadata().unwrap();
            assert_ne!((source.dev(), source.ino()), (private.dev(), private.ino()));
            let source_advice = snapshot.advise_source_away();
            let snapshot_advice = snapshot.advise_snapshot_away();
            assert_eq!(source_advice.calls, 1);
            assert_eq!(source_advice.successes, 1);
            assert_eq!(snapshot_advice.calls, 1);
            assert_eq!(snapshot_advice.successes, 1);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn direct_snapshot_accounts_no_payload_writes() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"direct immutable snapshot bytes";
        let source = source_from_bytes(root.path(), "direct.aot", bytes);
        // The kernel-proof classifier is covered in wasmer-wasix. Supplying a
        // proof here isolates accounting and live-FD mapping behavior.
        let snapshot =
            direct_artifact_snapshot_from_proof(&source, IntrinsicFileImmutability::ImmutableInode)
                .unwrap();

        assert_eq!(
            snapshot.audit.mode,
            ArtifactSnapshotMode::DirectIntrinsic(IntrinsicFileImmutability::ImmutableInode)
        );
        assert_eq!(snapshot.audit.source_bytes_read, bytes.len() as u64);
        assert_eq!(snapshot.audit.snapshot_bytes_written, 0);
        assert_eq!(snapshot.audit.sync_calls, 0);
        assert_eq!(snapshot.mapping().unwrap().as_slice(), bytes);
        assert!(!snapshot.has_distinct_source());
        assert_eq!(
            snapshot.advise_snapshot_away(),
            FileAdviceAudit::not_applicable()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn required_zero_write_rejects_mutable_source_before_compatibility_copy() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"mutable AOT bytes";
        let source = source_from_bytes(root.path(), "mutable.aot", bytes);
        let error =
            immutable_artifact_snapshot(source, SealedActivationPolicy::RequireDirectImmutable)
                .unwrap_err();

        assert!(error.to_string().contains("requires direct activation"));
        assert_eq!(fs::read(root.path().join("mutable.aot")).unwrap(), bytes);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn loader_audit_receipt_is_owned_compact_jsonl() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("loader.jsonl");
        let record = LoaderAuditRecord {
            artifact_kind: "aot",
            module_sha256: "ab".repeat(32),
            snapshot_mode: "direct-immutable-inode",
            logical_bytes: 17,
            source_bytes_read: 0,
            source_bytes_written: 0,
            snapshot_bytes_written: 0,
            mapping_bytes_hashed: 17,
            sync_calls: 0,
            read_advice_applicable: true,
            read_advice_supported: true,
            read_advice_calls: 2,
            read_advice_successes: 2,
            read_advice_first_errno: None,
            source_cache_eviction_applicable: true,
            source_cache_eviction_supported: true,
            source_cache_eviction_calls: 1,
            source_cache_eviction_successes: 1,
            source_cache_eviction_errno: None,
            snapshot_cache_eviction_applicable: false,
            snapshot_cache_eviction_supported: true,
            snapshot_cache_eviction_calls: 0,
            snapshot_cache_eviction_successes: 0,
            snapshot_cache_eviction_errno: None,
            mapping_cache_eviction_applicable: false,
            mapping_cache_eviction_supported: true,
            mapping_cache_eviction_calls: 0,
            mapping_cache_eviction_successes: 0,
            mapping_cache_eviction_errno: None,
            residency_after_hash_inspect: LoaderResidencyRecord {
                state: "measured",
                page_size: Some(4096),
                total_pages: Some(1),
                resident_pages: Some(1),
                resident_bytes: Some(17),
                errno: None,
            },
            residency_after_archive_release: LoaderResidencyRecord {
                state: "measured",
                page_size: Some(4096),
                total_pages: Some(1),
                resident_pages: Some(1),
                resident_bytes: Some(17),
                errno: None,
            },
            source_residency_before_eviction: LoaderResidencyRecord {
                state: "measured",
                page_size: Some(4096),
                total_pages: Some(1),
                resident_pages: Some(1),
                resident_bytes: Some(17),
                errno: None,
            },
            source_residency_after_eviction: LoaderResidencyRecord {
                state: "measured",
                page_size: Some(4096),
                total_pages: Some(1),
                resident_pages: Some(0),
                resident_bytes: Some(0),
                errno: None,
            },
            residency_after_eviction: LoaderResidencyRecord {
                state: "measured",
                page_size: Some(4096),
                total_pages: Some(1),
                resident_pages: Some(0),
                resident_bytes: Some(0),
                errno: None,
            },
            write_policy: "none-immutable-source",
        };
        emit_loader_audit_to_path(&path, &record).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(
            parsed["schema"],
            "oliphaunt.wasix-postmaster.sealed-loader-receipt.v2"
        );
        assert_eq!(parsed["snapshot_mode"], "direct-immutable-inode");
        assert_eq!(parsed["source_bytes_written"], 0);
        assert_eq!(parsed["snapshot_bytes_written"], 0);
        assert_eq!(parsed["sync_calls"], 0);
        assert_eq!(parsed["read_advice_calls"], 2);
        assert_eq!(parsed["source_cache_eviction_successes"], 1);
        assert_eq!(parsed["snapshot_cache_eviction_applicable"], false);
        assert_eq!(parsed["mapping_cache_eviction_applicable"], false);
        assert_eq!(parsed["residency_after_eviction"]["resident_pages"], 0);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn loader_audit_module_hash_is_canonical_lowercase_sha256() {
        let module_hash = ModuleHash::from_bytes([0xab; 32]);
        assert_eq!(canonical_module_sha256(module_hash), "ab".repeat(32));
    }

    #[test]
    fn failed_activation_is_single_flight_and_stable() {
        use std::sync::{Barrier, atomic::Ordering};

        let root = tempfile::tempdir().unwrap();
        let module_hash = ModuleHash::from_bytes([0x11; 32]);
        let artifact = Arc::new(lazy_artifact_from_bytes(
            root.path(),
            "invalid.aot",
            b"not a Wasmer artifact",
            module_hash,
        ));
        let engine = Engine::headless();
        let cache = Arc::new(SealedModuleCache::new(
            &engine,
            HashMap::from([(module_hash, artifact.clone())]),
        ));
        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                let cache = cache.clone();
                let engine = engine.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    cache
                        .load_exact(module_hash, &engine)
                        .unwrap_err()
                        .to_string()
                })
            })
            .collect::<Vec<_>>();
        let errors = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert!(errors.iter().all(|error| error == &errors[0]));
        assert_eq!(artifact.activation_attempts.load(Ordering::Relaxed), 1);
        assert!(matches!(
            cache.load_exact(ModuleHash::from_bytes([0x22; 32]), &engine),
            Err(CacheError::NotFound)
        ));
        let different_engine = Engine::headless();
        let engine_mismatch = cache
            .load_exact(module_hash, &different_engine)
            .unwrap_err();
        assert!(engine_mismatch.to_string().contains("engine mismatch"));

        let fallback_error = futures::executor::block_on(wasmer_wasix::runtime::load_module(
            &engine,
            cache.as_ref(),
            wasmer_wasix::runtime::ModuleInput::Bytes(std::borrow::Cow::Borrowed(
                b"\0asm\x01\0\0\0",
            )),
            None,
        ))
        .unwrap_err();
        assert!(matches!(
            fallback_error,
            wasmer_wasix::SpawnError::CacheError(CacheError::NotFound)
        ));
    }

    #[cfg(all(feature = "cranelift", feature = "wat"))]
    fn serialized_artifact(wat: &str) -> (Vec<u8>, ModuleHash) {
        let compiler_engine = Engine::new(
            Box::new(wasmer_compiler_cranelift::Cranelift::default()),
            Target::default(),
            wasmer_types::Features::default(),
        );
        let wasm = wasmer::wat2wasm(wat.as_bytes()).unwrap();
        let module_hash = ModuleHash::new(wasm.as_ref());
        let module = Module::new(&compiler_engine, wasm.as_ref()).unwrap();
        (module.serialize().unwrap().to_vec(), module_hash)
    }

    #[cfg(all(
        feature = "cranelift",
        feature = "wat",
        target_os = "linux",
        target_arch = "x86_64"
    ))]
    #[test]
    fn post_publication_audit_failure_rolls_back_strict_code_memory() {
        use std::os::unix::fs::PermissionsExt;

        let carrier_root = tempfile::tempdir().unwrap();
        let (bytes, module_hash) =
            serialized_artifact("(module (memory 1 4096 shared) (func (export \"selected\")))");
        let artifact =
            lazy_artifact_from_bytes(carrier_root.path(), "selected.aot", &bytes, module_hash);

        let code_root = tempfile::Builder::new()
            .prefix("wasmer-sealed-pending-code-memory-test-")
            .tempdir_in("/var/tmp")
            .unwrap();
        fs::set_permissions(code_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let policy =
            wasmer::sys::CodeMemoryPolicy::strict_linux_x86_64_file_backed(code_root.path())
                .unwrap();
        let mut engine = Engine::headless();
        engine.set_code_memory_policy(policy).unwrap();
        let baseline = engine.as_sys().code_memory_allocation_count();

        let error = artifact
            .activate_with_audit(&engine, |_| {
                assert_eq!(
                    engine.as_sys().code_memory_allocation_count(),
                    baseline + 1,
                    "published code must remain transaction-owned during audit"
                );
                Err(anyhow::anyhow!("injected post-publication audit failure"))
            })
            .unwrap_err();
        assert!(
            error.to_string().contains("post-publication audit failure"),
            "unexpected activation failure: {error}"
        );
        assert_eq!(
            engine.as_sys().code_memory_allocation_count(),
            baseline,
            "failed admission must deregister and unmap its exact allocation"
        );
    }

    #[cfg(all(feature = "cranelift", feature = "wat"))]
    #[test]
    fn selected_only_activation_and_success_are_single_flight() {
        use std::sync::{Barrier, atomic::Ordering};

        let root = tempfile::tempdir().unwrap();
        let (selected_bytes, selected_hash) =
            serialized_artifact("(module (memory 1 4096 shared) (func (export \"selected\")))");
        let (cold_bytes, cold_hash) =
            serialized_artifact("(module (memory 1 4096 shared) (func (export \"cold\")))");
        let selected = Arc::new(lazy_artifact_from_bytes(
            root.path(),
            "selected.aot",
            &selected_bytes,
            selected_hash,
        ));
        let cold = Arc::new(lazy_artifact_from_bytes(
            root.path(),
            "cold.aot",
            &cold_bytes,
            cold_hash,
        ));
        let engine = Engine::headless();
        let cache = Arc::new(SealedModuleCache::new(
            &engine,
            HashMap::from([(selected_hash, selected.clone()), (cold_hash, cold.clone())]),
        ));

        let selected_module = cache.load_exact(selected_hash, &engine).unwrap();
        assert_eq!(selected.activation_attempts.load(Ordering::Relaxed), 1);
        assert_eq!(cold.activation_attempts.load(Ordering::Relaxed), 0);

        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                let cache = cache.clone();
                let engine = engine.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    cache.load_exact(selected_hash, &engine).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(selected.activation_attempts.load(Ordering::Relaxed), 1);
        assert_eq!(cold.activation_attempts.load(Ordering::Relaxed), 0);

        cache.load_exact(cold_hash, &engine).unwrap();
        assert_eq!(cold.activation_attempts.load(Ordering::Relaxed), 1);
        drop(selected_module);
    }
}
