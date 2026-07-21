use std::error::Error;
use std::fmt;

use serde_json::Value;

use crate::oliphaunt::interface::QueryOptions;
use crate::protocol::messages::DatabaseError;

/// Rich error type that mirrors the TypeScript `OliphauntError` by carrying the
/// original database error along with query context.
pub struct OliphauntError {
    source: DatabaseError,
    query: String,
    params: Vec<Value>,
    query_options: Option<QueryOptions>,
}

impl OliphauntError {
    pub fn new(
        source: DatabaseError,
        query: impl Into<String>,
        params: Vec<Value>,
        query_options: Option<QueryOptions>,
    ) -> Self {
        Self {
            source,
            query: query.into(),
            params,
            query_options,
        }
    }

    pub fn database_error(&self) -> &DatabaseError {
        &self.source
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn params(&self) -> &[Value] {
        &self.params
    }

    pub fn query_options(&self) -> Option<&QueryOptions> {
        self.query_options.as_ref()
    }
}

impl fmt::Display for OliphauntError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.source)
    }
}

impl fmt::Debug for OliphauntError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OliphauntError")
            .field("source", &self.source)
            .field("query", &self.query)
            .field("params", &self.params)
            .field("has_query_options", &self.query_options.is_some())
            .finish()
    }
}

impl Error for OliphauntError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}
