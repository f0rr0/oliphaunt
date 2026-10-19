use liboliphaunt_native_bindings::NativeOpenOptions;
use std::sync::Arc;

#[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
mod broker;

uniffi::setup_scaffolding!();

#[uniffi::export]
pub async fn restore(
    library_path: Option<String>,
    destination: String,
    bytes: Vec<u8>,
) -> Result<(), NativeError> {
    Ok(oliphaunt::mobile::restore(library_path.map(Into::into), destination.into(), bytes).await?)
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeError {
    #[error("request was not submitted")]
    NotSubmitted,
    #[error("{detail}")]
    Database { detail: String },
    #[error("stream callback stopped delivery")]
    Callback,
    #[error("{detail}")]
    Broker {
        reason: BrokerReason,
        execution: BrokerExecution,
        requires_reopen: bool,
        detail: String,
    },
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum BrokerExecution {
    NotStarted,
    Completed,
    Unknown,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum BrokerReason {
    InvalidRequest,
    Cancelled,
    Deadline,
    WorkerInterrupted,
    Transport,
    Database,
    Callback,
}

impl From<oliphaunt::Error> for NativeError {
    fn from(error: oliphaunt::Error) -> Self {
        if let Some(failure) = error.broker_failure() {
            use oliphaunt::mobile::{Execution, Reason};
            return Self::Broker {
                reason: match failure.reason {
                    Reason::InvalidRequest => BrokerReason::InvalidRequest,
                    Reason::Cancelled => BrokerReason::Cancelled,
                    Reason::Deadline => BrokerReason::Deadline,
                    Reason::WorkerInterrupted => BrokerReason::WorkerInterrupted,
                    Reason::Transport => BrokerReason::Transport,
                    Reason::Database | Reason::Success => BrokerReason::Database,
                    Reason::Callback => BrokerReason::Callback,
                },
                execution: match failure.execution {
                    Execution::NotStarted => BrokerExecution::NotStarted,
                    Execution::Completed => BrokerExecution::Completed,
                    Execution::Unknown => BrokerExecution::Unknown,
                },
                requires_reopen: failure.requires_reopen,
                detail: failure.detail.clone(),
            };
        }
        Self::Database {
            detail: error.to_string(),
        }
    }
}

#[derive(uniffi::Record)]
pub struct OpenOptions {
    pub library_path: Option<String>,
    pub pgdata: String,
    pub runtime_directory: Option<String>,
    pub module_directory: Option<String>,
    pub icu_data_directory: Option<String>,
    pub username: String,
    pub database: String,
    pub startup_args: Vec<String>,
}

#[uniffi::export(callback_interface)]
pub trait ChunkSink: Send + Sync {
    fn on_chunk(&self, bytes: Vec<u8>) -> bool;
}

#[derive(uniffi::Object)]
pub struct NativeDatabase {
    database: oliphaunt::AsyncOliphaunt,
    #[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
    connection: Option<Arc<oliphaunt::mobile::broker::Connection>>,
}

#[uniffi::export]
impl NativeDatabase {
    #[uniffi::constructor]
    pub async fn open(options: OpenOptions) -> Result<Arc<Self>, NativeError> {
        let database = oliphaunt::mobile::open(NativeOpenOptions {
            library_path: options.library_path.map(Into::into),
            pgdata: options.pgdata.into(),
            runtime_directory: options.runtime_directory.map(Into::into),
            module_directory: options.module_directory.map(Into::into),
            icu_data_directory: options.icu_data_directory.map(Into::into),
            username: options.username,
            database: options.database,
            startup_args: options.startup_args,
        })
        .await?;
        Ok(Arc::new(Self {
            database,
            #[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
            connection: None,
        }))
    }

    pub fn request(&self) -> Arc<NativeRequest> {
        Arc::new(NativeRequest {
            request: oliphaunt::mobile::Request::new(&self.database),
        })
    }

    pub async fn cancel(&self) -> Result<(), NativeError> {
        Ok(self.database.cancel().await?)
    }
    pub async fn detach(&self) -> Result<(), NativeError> {
        Ok(self.database.close().await?)
    }

    pub fn is_closed(&self) -> bool {
        self.database.is_closed()
    }
}

#[derive(uniffi::Object)]
pub struct NativeRequest {
    request: oliphaunt::mobile::Request,
}

#[uniffi::export]
impl NativeRequest {
    pub async fn backup(&self) -> Result<Vec<u8>, NativeError> {
        self.request
            .backup()
            .await
            .map_err(|error| self.failure(error))
            .and_then(limit_buffered_response)
    }

    pub async fn execute(&self, bytes: Vec<u8>) -> Result<Vec<u8>, NativeError> {
        self.request
            .execute(bytes)
            .await
            .map_err(|error| self.failure(error))
            .and_then(limit_buffered_response)
    }

    pub async fn stream(
        &self,
        bytes: Vec<u8>,
        sink: Box<dyn ChunkSink>,
    ) -> Result<(), NativeError> {
        self.request
            .stream(bytes, move |chunk| {
                if sink.on_chunk(chunk.to_vec()) {
                    Ok(())
                } else {
                    Err(NativeError::Callback)
                }
            })
            .await
            .map_err(|error| {
                let broker_failure = match &error {
                    oliphaunt::RawStreamError::Database(error)
                    | oliphaunt::RawStreamError::CallbackPanicked(error) => {
                        error.broker_failure().is_some()
                    }
                    _ => false,
                };
                if !broker_failure && self.request.was_cancelled() && !self.request.was_submitted()
                {
                    NativeError::NotSubmitted
                } else {
                    match error {
                        oliphaunt::RawStreamError::Callback(error) => error,
                        oliphaunt::RawStreamError::Database(error)
                        | oliphaunt::RawStreamError::CallbackPanicked(error) => error.into(),
                        other => NativeError::Database {
                            detail: other.to_string(),
                        },
                    }
                }
            })
    }

    pub fn cancel(&self) -> Result<(), NativeError> {
        Ok(self.request.cancel()?)
    }
}

impl NativeRequest {
    fn failure(&self, error: oliphaunt::Error) -> NativeError {
        if error.broker_failure().is_none()
            && self.request.was_cancelled()
            && !self.request.was_submitted()
        {
            NativeError::NotSubmitted
        } else {
            error.into()
        }
    }
}

// UniFFI prefixes a byte sequence with i32 length; JNA's ByteBuffer capacity
// must also fit that prefix. This is a bridge limit, not a native memory quota.
fn check_buffered_response_length(length: usize) -> Result<(), NativeError> {
    if length > i32::MAX as usize - size_of::<i32>() {
        return Err(NativeError::Database {
            detail: "buffered response exceeds the mobile byte-array limit; use raw streaming or file backup".to_owned(),
        });
    }
    Ok(())
}

fn limit_buffered_response(bytes: Vec<u8>) -> Result<Vec<u8>, NativeError> {
    check_buffered_response_length(bytes.len())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffered_response_limit_includes_uniffi_length_prefix() {
        let limit = i32::MAX as usize - size_of::<i32>();
        for length in [0, 1, limit] {
            check_buffered_response_length(length).unwrap();
        }
        for length in [limit + 1, i32::MAX as usize, usize::MAX] {
            assert!(matches!(
                check_buffered_response_length(length),
                Err(NativeError::Database { .. })
            ));
        }
        assert_eq!(limit_buffered_response(vec![1, 2, 3]).unwrap(), [1, 2, 3]);
    }
}
