//! PostgreSQL wire server with a separately selectable WASIX backend.

/// Runtime-independent PostgreSQL connection framing.
pub use oliphaunt_query::wire;

#[cfg(feature = "wasix")]
mod async_server;
#[cfg(feature = "wasix")]
mod error;
#[cfg(feature = "wasix")]
mod lifecycle;
#[cfg(feature = "wasix")]
mod proxy;
#[cfg(feature = "wasix")]
mod server;
#[cfg(feature = "wasix")]
pub use async_server::{AsyncOliphauntServer, AsyncOliphauntServerBuilder};
#[cfg(feature = "wasix")]
pub use oliphaunt_wasix::{DatabaseStorage, Error, ErrorKind, Result};
#[cfg(feature = "wasix")]
pub use server::{OliphauntServer, OliphauntServerBuilder, ServerListen};
