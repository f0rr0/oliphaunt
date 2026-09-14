#![deny(unsafe_op_in_unsafe_fn)]
#![forbid(missing_docs)]
//! Native-first Rust SDK surface for embedded Oliphaunt.
//!
//! This crate is deliberately native-only. It does not expose a WASIX engine
//! and it does not depend on the current `oliphaunt-wasix` runtime layout.

#[cfg(feature = "desktop")]
mod broker;
mod build_resources;
mod builder;
mod cancellation;
#[cfg(feature = "desktop")]
mod child_process;
mod config;
mod database;
mod direct;
mod engine;
mod error;
mod executor;
mod extension;
#[cfg(feature = "desktop")]
mod ipc;
#[allow(unsafe_code)]
mod liboliphaunt;
#[cfg(feature = "mobile-bindings")]
#[doc(hidden)]
pub mod mobile;
#[cfg(feature = "desktop")]
mod pgwire;
mod protocol;
mod query;
pub(crate) use oliphaunt_query as query_core;
mod reply;
#[cfg(feature = "desktop")]
mod server;
mod session;
mod storage;
#[cfg(test)]
mod test_fixtures;
pub use build_resources::register_build_resources_dir;
pub use builder::{AsyncOliphauntBuilder, AsyncOliphauntServerBuilder};
pub use config::ServerListen;
pub use database::{AsyncOliphaunt, AsyncOliphauntServer, AsyncSql, AsyncTransaction};
pub use direct::{
    CancelHandle, Oliphaunt, OliphauntBuilder, OliphauntServer, OliphauntServerBuilder, Sql,
    Transaction,
};
pub use error::{
    Error, ErrorKind, PostgresError, PostgresErrorField, RawStreamCallbackOutput, RawStreamError,
    RawStreamResult, Result, TransactionError, TransactionResult,
};
pub use extension::Extension;
pub use liboliphaunt_native_bindings::{NativeClusterSeed, NativeResourceDirectory};
pub use query::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresNotice,
    QueryField, QueryFormat, QueryResult, QueryRow, RowIndex, StatementDescription,
    StatementResult, TypeOid, ValueFormat, ValueRef,
};
pub use storage::DatabaseStorage;
