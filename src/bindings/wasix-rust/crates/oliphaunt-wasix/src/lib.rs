#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod error;
mod oliphaunt;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions;

pub use error::{Error, Result};
#[cfg(feature = "tools")]
pub use oliphaunt::tools;
pub use oliphaunt::{
    CommandResult, DatabaseStorage, Oliphaunt, OliphauntBuilder, OliphauntServer,
    OliphauntServerBuilder, PostgresError, PostgresErrorField, QueryField, QueryFormat, QueryParam,
    QueryResult, QueryRow, ServerListen, Transaction,
};
