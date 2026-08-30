pub(crate) mod aot;
pub(crate) mod assets;
pub(crate) mod backend;
pub(crate) mod base;
pub(crate) mod builder;
pub(crate) mod client;
pub(crate) mod config;
pub(crate) mod data_dir;
pub(crate) mod database_root_descriptor;
#[cfg(feature = "extensions")]
pub(crate) mod extensions;
pub(crate) mod lifecycle;
pub(crate) mod postgres_mod;
pub(crate) mod proxy;
pub(crate) mod query;
pub(crate) mod query_core {
    include!(env!("OLIPHAUNT_QUERY_CORE_RS"));
}
pub(crate) mod server;
pub(crate) mod sql;
pub(crate) mod storage;
pub(crate) mod sync_host_fs;
#[cfg(test)]
pub(crate) mod test_fixtures;
#[cfg(feature = "tools")]
pub mod tools;
pub(crate) mod transport;
pub(crate) mod wire;

#[cfg(any(feature = "__internal-napi", test))]
pub use assets::CatalogProfile;
pub use builder::OliphauntBuilder;
pub use client::{Oliphaunt, Sql, Transaction};
pub use query::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresError,
    PostgresErrorField, PostgresNotice, QueryField, QueryFormat, QueryResult, QueryRow, RowIndex,
    StatementDescription, StatementResult, TypeOid, ValueFormat, ValueRef,
};
pub use server::{OliphauntServer, OliphauntServerBuilder, ServerListen};
pub use storage::DatabaseStorage;
