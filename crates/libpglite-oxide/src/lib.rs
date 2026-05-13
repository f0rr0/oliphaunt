#![deny(unsafe_op_in_unsafe_fn)]
#![forbid(missing_docs)]
//! Native-first Rust SDK surface for embedded PGlite.
//!
//! This crate is deliberately native-only. It does not expose a WASIX engine
//! and it does not depend on the current `pglite-oxide` runtime layout.

mod broker;
mod builder;
mod config;
mod database;
mod engine;
mod error;
mod executor;
mod extension;
#[allow(unsafe_code)]
mod libpglite;
mod performance;
mod protocol;
mod reply;
mod server;
mod storage;

pub use broker::NativeBrokerRuntime;
pub use builder::PgliteBuilder;
pub use config::{
    DurabilityProfile, EngineMode, NativeBrokerConfig, NativeDirectConfig, NativeServerConfig,
    OpenConfig,
};
pub use database::{Pglite, SessionPin, Transaction};
pub use engine::{
    EngineCapabilities, EngineSession, NativeRuntime, RuntimeUnavailable, SessionConcurrency,
};
pub use error::{Error, Result};
pub use extension::{
    Extension, ExtensionLoading, ExtensionPack, ExtensionPackId, ExtensionPackSource,
};
pub use libpglite::{LibPgliteRuntime, LibPgliteRuntimeSource};
pub use performance::{
    BenchmarkMetric, BenchmarkTarget, PerformanceGate, PerformanceGateSet, PerformanceOperator,
};
pub use protocol::{ProtocolRequest, ProtocolResponse};
pub use server::NativeServerRuntime;
pub use storage::{
    BackupArtifact, BackupFormat, BackupRequest, BootstrapStrategy, DatabaseRoot, RootLockPolicy,
    StorageConfig,
};
