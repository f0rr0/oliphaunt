#![deny(unsafe_op_in_unsafe_fn)]
//! Shared native liboliphaunt execution and resource ownership.
mod build_resources;
pub mod config;
pub mod error;
pub mod extension;
mod liboliphaunt;
pub mod storage;
#[cfg(test)]
mod test_fixtures;
pub use build_resources::register_build_resources_dir;
pub use config::{NativeClusterSeed, NativeConfig, NativeResourceDirectory, PostgresStartupGuc};
pub use error::{Error, Result};
pub use extension::Extension;
pub use liboliphaunt::root::{PreparedNativeRoot, configure_native_tool_env, native_root_key};
pub use liboliphaunt::{
    NativeCancel, NativeOpenOptions, NativeProtocolInput, NativeSession, ProtocolStreamOutcome,
};
#[cfg(feature = "internal-native-packaging")]
pub use liboliphaunt::{
    NativePackagingCatalogProfile, NativePackagingResources, materialize_native_packaging_resources,
};
pub use storage::DatabaseStorage;
