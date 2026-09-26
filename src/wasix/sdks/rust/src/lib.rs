#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod async_api;
mod error;
mod oliphaunt;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions::Extension;

pub use async_api::{AsyncOliphaunt, AsyncOliphauntBuilder, AsyncSql, AsyncTransaction};
pub use error::{
    Error, ErrorKind, RawStreamCallbackOutput, RawStreamError, RawStreamResult, Result,
    StorageCommitState, StorageErrorCode, StorageErrorDetails, StorageErrorPhase, TransactionError,
    TransactionResult,
};
pub use oliphaunt::{CatalogProfile, ClusterSeed, IcuData};
pub use oliphaunt::{
    CommandResult, DatabaseStorage, DecodeError, ExecResult, FromSql, IntoParameter, Oliphaunt,
    OliphauntBuilder, Parameter, PostgresError, PostgresErrorField, PostgresNotice, QueryField,
    QueryFormat, QueryResult, QueryRow, RowIndex, Sql, StatementDescription, StatementResult,
    Transaction, TypeOid, ValueFormat, ValueRef,
};

/// Options and structured errors for packaged PostgreSQL frontend programs.
#[cfg(feature = "tools-execution")]
pub mod tools {
    pub use crate::oliphaunt::tools::{
        PgDumpOptions, PostgresToolError, PostgresToolOutput, PsqlOptions, ToolAssets,
    };
}

pub mod session;
