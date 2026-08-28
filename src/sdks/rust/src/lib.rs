#![deny(unsafe_op_in_unsafe_fn)]
#![forbid(missing_docs)]
//! Native-first Rust SDK surface for embedded Oliphaunt.
//!
//! This crate is deliberately native-only. It does not expose a WASIX engine
//! and it does not depend on the current `oliphaunt-wasix` runtime layout.

mod broker;
#[cfg(any(
    feature = "__internal-broker-helper",
    feature = "internal-native-packaging"
))]
#[doc(hidden)]
pub mod __private {
    #[cfg(feature = "__internal-broker-helper")]
    // This is a version-locked cross-package seam for the separately built
    // Oliphaunt broker executable. It is not an application SDK surface.
    include!("broker_support.rs");

    #[cfg(feature = "__internal-broker-helper")]
    #[doc(hidden)]
    pub use crate::ipc::{
        BrokerIpcRequest, broker_ipc_read_request, broker_ipc_write_chunk, broker_ipc_write_error,
        broker_ipc_write_ok, broker_ipc_write_stream_callback_aborted,
    };

    /// Version-locked bridge for the unpublished native packaging workspace tool.
    #[cfg(feature = "internal-native-packaging")]
    #[doc(hidden)]
    pub mod packaging {
        #[doc(hidden)]
        pub use crate::liboliphaunt::{
            NativePackagingCatalogProfile, NativePackagingResources, NativePackagingRuntime,
            materialize_native_packaging_resources,
        };
    }
}
mod build_resources;
mod builder;
mod cancellation;
mod child_process;
mod config;
mod database;
mod direct;
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
mod query_core {
    include!(env!("OLIPHAUNT_QUERY_CORE_RS"));
}
mod reply;
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
pub use query::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresNotice,
    QueryField, QueryFormat, QueryResult, QueryRow, RowIndex, StatementDescription,
    StatementResult, TypeOid, ValueFormat, ValueRef,
};
pub use storage::DatabaseStorage;
