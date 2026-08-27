//! Dedicated owner-thread native API.
//!
//! This module preserves the cloneable asynchronous execution model. Opening a
//! database creates one owner thread, constructs the selected runtime session
//! there, and serializes every operation through its bounded FIFO. Database
//! topology remains independently selectable with `.direct()` or `.broker()`.

pub use crate::builder::OliphauntBuilder;
pub use crate::database::{Oliphaunt, OliphauntServer, Sql, Transaction};
