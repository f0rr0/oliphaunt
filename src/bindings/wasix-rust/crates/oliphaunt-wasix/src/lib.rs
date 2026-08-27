#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod error;
mod oliphaunt;
pub mod worker;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions;

pub use error::{Error, Result, TransactionRollbackError};
pub use oliphaunt::{
    CommandResult, DatabaseStorage, DecodeError, ExecResult, FromSql, IntoParameter, Oliphaunt,
    OliphauntBuilder, OliphauntServer, OliphauntServerBuilder, Parameter, PostgresError,
    PostgresErrorField, PostgresNotice, QueryField, QueryFormat, QueryParam, QueryResult, QueryRow,
    RowIndex, ServerListen, Sql, StatementDescription, StatementResult, Transaction, TypeOid,
    ValueFormat, ValueRef,
};

/// Packaged PostgreSQL frontend programs executed directly against the
/// caller-thread database.
#[cfg(feature = "tools")]
pub mod tools {
    pub use crate::oliphaunt::tools::{
        PgDumpOptions, PostgresToolError, PsqlOptions, pg_dump, psql,
    };
}
