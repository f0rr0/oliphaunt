#![deny(unsafe_op_in_unsafe_fn)]
#![forbid(missing_docs)]
//! Native-first Rust SDK surface for embedded Oliphaunt.
//!
//! This crate is deliberately native-only. It does not expose a WASIX engine
//! and it does not depend on the current `oliphaunt-wasix` runtime layout.

mod broker;
#[cfg(feature = "broker-helper")]
#[doc(hidden)]
pub mod broker_support;
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
mod pgwire;
mod protocol;
mod query;
mod reply;
mod server;
mod storage;
#[cfg(test)]
mod test_fixtures;

pub use build_resources::register_build_resources_dir;
pub use builder::OliphauntBuilder;
pub use config::ServerListen;
pub use database::{Oliphaunt, OliphauntServer, Transaction};
pub use error::{Error, PostgresError, PostgresErrorField, Result};
pub use extension::Extension;
#[doc(hidden)]
pub use ipc::{
    BrokerIpcRequest, broker_ipc_read_request, broker_ipc_write_chunk, broker_ipc_write_error,
    broker_ipc_write_ok,
};
#[cfg(feature = "internal-native-packaging")]
#[doc(hidden)]
pub use liboliphaunt::{
    NativePackagingCatalogProfile, NativePackagingResources, NativePackagingRuntime,
    materialize_native_packaging_resources,
};
pub use query::{CommandResult, QueryField, QueryFormat, QueryParam, QueryResult, QueryRow};
pub use storage::DatabaseStorage;
