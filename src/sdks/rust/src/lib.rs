#![deny(unsafe_op_in_unsafe_fn)]
#![forbid(missing_docs)]
//! Native-first Rust SDK surface for embedded Oliphaunt.
//!
//! This crate is deliberately native-only. It does not expose a WASIX engine
//! and it does not depend on the current `oliphaunt-wasix` runtime layout.

mod backup;
mod broker;
mod build_resources;
mod builder;
mod config;
mod database;
mod engine;
mod error;
mod executor;
mod extension;
mod ipc;
#[allow(unsafe_code)]
mod liboliphaunt;
mod lifecycle;
mod performance;
mod pgwire;
mod protocol;
mod query;
mod reply;
mod runtime_resources;
mod server;
mod storage;

pub use broker::NativeBrokerRuntime;
pub use build_resources::register_build_resources_dir;
pub use builder::OliphauntBuilder;
pub use config::{
    DEFAULT_DATABASE, DEFAULT_USERNAME, DurabilityProfile, EngineMode, NativeBrokerConfig,
    NativeDirectConfig, NativeServerConfig, OpenConfig, PostgresStartupGuc,
    RuntimeFootprintProfile,
};
pub use database::{Oliphaunt, SessionPin, Transaction};
pub use engine::{
    EngineCancel, EngineCapabilities, EngineModeSupport, EngineSession, NativeRuntime,
    RuntimeUnavailable, SessionConcurrency,
};
pub use error::{Error, PostgresError, PostgresErrorField, Result};
pub use extension::{
    Extension, ExtensionArtifactPolicy, ExtensionCoverage, ExtensionManifestEntry,
    ExtensionModuleAsset, ExtensionRedistribution, ExtensionSmokeCoverage, ExtensionSmokePlan,
    ExtensionSourceKind, ExtensionSqlAsset, MobileStaticLinkStatus, NATIVE_EXTENSION_MANIFEST,
    required_shared_preload_libraries, resolve_extension_selection,
};
#[doc(hidden)]
pub use ipc::{
    BrokerIpcRequest, broker_ipc_read_request, broker_ipc_write_chunk, broker_ipc_write_error,
    broker_ipc_write_ok,
};
pub use liboliphaunt::{OliphauntRuntime, OliphauntRuntimeSource};
pub use lifecycle::{
    BackgroundCheckpointSkipReason, BackgroundPreparationOptions, BackgroundPreparationResult,
};
pub use performance::{
    BenchmarkMetric, BenchmarkTarget, PerformanceGate, PerformanceGateSet, PerformanceOperator,
};
pub use protocol::{ProtocolRequest, ProtocolResponse};
pub use query::{QueryField, QueryFormat, QueryParam, QueryResult, QueryRow, parse_query_response};
pub use runtime_resources::{
    ExtensionSizeReport, MobileStaticRegistryMetadata, MobileStaticRegistryState,
    NativeExtensionArtifact, NativeExtensionArtifactFormat, NativeExtensionArtifactIndex,
    NativeExtensionArtifactIndexArtifact, NativeExtensionArtifactIndexCatalog,
    NativeExtensionArtifactIndexCatalogEntry, NativeExtensionArtifactIndexCreateOptions,
    NativeExtensionArtifactIndexOptions, NativeExtensionArtifactIndexResolution,
    NativeExtensionArtifactIndexSignature, NativeExtensionArtifactIndexSigningOptions,
    NativeExtensionArtifactIndexTrustRoot, NativeExtensionArtifactOptions,
    NativeExtensionMobileStaticArchive, NativeExtensionMobileStaticDependencyArchive,
    NativeExtensionStaticSymbolAlias, NativePrebuiltExtensionArtifact, NativeRuntimeFeature,
    NativeRuntimeResourceOptions, NativeRuntimeResourceSizeReport, NativeRuntimeResources,
    build_native_runtime_resources, create_prebuilt_extension_artifact,
    create_prebuilt_extension_artifact_index, list_prebuilt_extension_artifact_index_catalog,
    resolve_prebuilt_extension_artifacts_from_indexes, sign_prebuilt_extension_artifact_index,
};
pub use server::NativeServerRuntime;
pub use storage::{
    BackupArtifact, BackupFormat, BackupRequest, BootstrapStrategy, DatabaseRoot, RestoreRequest,
    RestoreTargetPolicy, RootLockPolicy, StorageConfig,
};
