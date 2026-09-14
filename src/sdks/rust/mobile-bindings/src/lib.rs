use liboliphaunt_native_bindings::NativeOpenOptions;
use std::sync::Arc;

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
}

impl From<oliphaunt::Error> for NativeError {
    fn from(error: oliphaunt::Error) -> Self {
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
        Ok(Arc::new(Self { database }))
    }

    pub fn request(&self) -> Arc<NativeRequest> {
        Arc::new(NativeRequest {
            request: oliphaunt::mobile::Request::new(&self.database),
        })
    }

    pub async fn cancel(&self) -> Result<(), NativeError> {
        Ok(self.database.cancel().await?)
    }
    pub async fn backup(&self) -> Result<Vec<u8>, NativeError> {
        Ok(self.database.backup().await?)
    }
    pub async fn detach(&self) -> Result<(), NativeError> {
        Ok(self.database.close().await?)
    }
}

#[derive(uniffi::Object)]
pub struct NativeRequest {
    request: oliphaunt::mobile::Request,
}

#[uniffi::export]
impl NativeRequest {
    pub async fn execute(&self, bytes: Vec<u8>) -> Result<Vec<u8>, NativeError> {
        self.request.execute(bytes).await.map_err(|error| {
            if self.request.was_cancelled() && !self.request.was_submitted() {
                NativeError::NotSubmitted
            } else {
                error.into()
            }
        })
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
                if self.request.was_cancelled() && !self.request.was_submitted() {
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
