#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod async_api;
mod error;
mod oliphaunt;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions;

pub use async_api::{
    Oliphaunt, OliphauntBuilder, OliphauntServer, OliphauntServerBuilder, Sql, Transaction,
};
pub use error::{Error, Result, TransactionRollbackError};
pub use oliphaunt::{
    CommandResult, DatabaseStorage, DecodeError, ExecResult, FromSql, IntoParameter, Parameter,
    PostgresError, PostgresErrorField, PostgresNotice, QueryField, QueryFormat, QueryParam,
    QueryResult, QueryRow, RowIndex, ServerListen, StatementDescription, StatementResult, TypeOid,
    ValueFormat, ValueRef,
};

/// Explicit synchronous, caller-thread WASIX API.
///
/// This module contains the original no-hop direct database API. Its database
/// handle is deliberately exclusive (`&mut self`) and does not pretend to be
/// an async, shareable owner-thread handle. The local server still owns its
/// listener thread while exposing synchronous start and close operations.
pub mod blocking {
    pub use crate::oliphaunt::{
        Oliphaunt, OliphauntBuilder, OliphauntServer, OliphauntServerBuilder, Sql, Transaction,
    };

    #[cfg(feature = "tools")]
    pub mod tools {
        pub use crate::oliphaunt::tools::{
            PgDumpOptions, PostgresToolError, PsqlOptions, pg_dump, psql,
        };
    }
}

/// Packaged PostgreSQL frontend programs executed on the database owner.
#[cfg(feature = "tools")]
pub mod tools {
    pub use crate::oliphaunt::tools::{PgDumpOptions, PostgresToolError, PsqlOptions};

    /// Run packaged `pg_dump` against an asynchronous owner-thread database.
    pub async fn pg_dump(
        database: &crate::Oliphaunt,
        options: PgDumpOptions,
    ) -> crate::Result<String> {
        database.pg_dump(options).await
    }

    /// Run packaged non-interactive `psql` against an asynchronous owner-thread database.
    pub async fn psql(database: &crate::Oliphaunt, options: PsqlOptions) -> crate::Result<String> {
        database.psql(options).await
    }
}
