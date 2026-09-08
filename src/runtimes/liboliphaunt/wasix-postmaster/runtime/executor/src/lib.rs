//! Closed, compiler-free executor for Oliphaunt's WASIX PostgreSQL product.
//!
//! This crate deliberately does not depend on `wasmer-cli`. Its public API is
//! the complete product boundary: an exact sealed carrier, host filesystem
//! mappings, required host networking, and PostgreSQL guest arguments.

#![deny(missing_docs, unsafe_op_in_unsafe_fn)]

pub mod args;
#[cfg(feature = "product-executor")]
mod execute;
#[cfg(feature = "memory-profile-core")]
pub mod memory_profile;
#[cfg(feature = "product-executor")]
mod runtime;
pub mod sealed;

#[cfg(feature = "product-executor")]
pub use execute::{execute, exit_code_for_result, run_from_env};

/// Exact receipt identity for the reversible bounded memory-maximum rewrite.
pub(crate) const SEALED_MODULE_TRANSFORMATION_ID: &str =
    "pinned-wasixcc-65536-to-embedded-4096-reversible-v1";

/// Exact product executor version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
