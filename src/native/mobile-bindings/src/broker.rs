use std::sync::Arc;
use std::time::Duration;

use liboliphaunt_native_bindings::NativeOpenOptions;
use oliphaunt::mobile::broker::{self, Epoch};

use crate::{NativeDatabase, NativeError, NativeRequest, OpenOptions};

#[uniffi::export]
pub fn publish_backup(staging: String, destination: String) -> Result<(), NativeError> {
    Ok(broker::publish_backup(&staging, &destination)?)
}

#[uniffi::export(callback_interface)]
pub trait BrokerControl: Send + Sync {
    fn cancel_request(&self, epoch: Vec<u8>, request: u64) -> bool;
    fn close_worker(&self, epoch: Vec<u8>) -> bool;
}

#[uniffi::export(callback_interface)]
pub trait BrokerRetirement: Send + Sync {
    fn retire(&self);
}

struct Control(Box<dyn BrokerControl>);
impl broker::Control for Control {
    fn cancel(&self, epoch: Epoch, request: u64) -> oliphaunt::Result<()> {
        if self.0.cancel_request(epoch.to_vec(), request) {
            Ok(())
        } else {
            Err(control_error())
        }
    }
    fn close(&self, epoch: Epoch) -> oliphaunt::Result<()> {
        if self.0.close_worker(epoch.to_vec()) {
            Ok(())
        } else {
            Err(control_error())
        }
    }
}

fn control_error() -> oliphaunt::Error {
    // Reuse a normal SDK conversion; host supervision independently bounds a
    // failed control send and preserves the operation's execution certainty.
    liboliphaunt_native_bindings::Error::Engine("broker control connection failed".into()).into()
}

struct Retirement(Box<dyn BrokerRetirement>);
impl broker::Retirement for Retirement {
    fn retire(&self) {
        self.0.retire();
    }
}

fn epoch(bytes: Vec<u8>) -> Result<Epoch, NativeError> {
    bytes.try_into().map_err(|_| NativeError::Database {
        detail: "invalid worker generation".into(),
    })
}

#[uniffi::export]
impl NativeDatabase {
    /// The adapter retains its descriptor through this call; Rust duplicates it.
    #[uniffi::constructor]
    pub async fn connect_broker(
        fd: i32,
        generation: Vec<u8>,
        control: Box<dyn BrokerControl>,
        operation_timeout_ms: Option<u64>,
    ) -> Result<Arc<Self>, NativeError> {
        let socket = broker::duplicate_socket(fd)?;
        let (database, connection) = broker::connect(
            socket,
            epoch(generation)?,
            Arc::new(Control(control)),
            operation_timeout_ms.map(Duration::from_millis),
        )
        .await?;
        Ok(Arc::new(Self {
            database,
            connection: Some(connection),
        }))
    }

    pub fn broker_operation_budget(&self, remaining_ms: Option<u64>) {
        if let Some(connection) = &self.connection {
            connection.set_operation_budget(remaining_ms.map(Duration::from_millis));
        }
    }

    pub fn broker_begin_close(&self) {
        if let Some(connection) = &self.connection {
            connection.begin_close();
        }
    }

    pub fn broker_interrupted(&self) {
        if let Some(connection) = &self.connection {
            connection.interrupted();
        }
    }

    pub fn broker_is_usable(&self) -> bool {
        self.connection
            .as_ref()
            .is_none_or(|connection| connection.is_usable())
    }
}

#[derive(uniffi::Record)]
pub struct BrokerReady {
    pub generation: Vec<u8>,
    pub abi: u32,
    pub runtime_version: String,
}

#[derive(uniffi::Object)]
pub struct NativeBrokerWorker {
    worker: Arc<broker::Worker>,
}

#[uniffi::export]
impl NativeBrokerWorker {
    /// Only the verified dedicated extension/service installs process retirement.
    #[uniffi::constructor]
    pub fn create(
        fd: i32,
        retirement: Box<dyn BrokerRetirement>,
        startup_timeout_ms: u64,
    ) -> Result<Arc<Self>, NativeError> {
        let socket = broker::duplicate_socket(fd)?;
        Ok(Arc::new(Self {
            worker: broker::Worker::new(
                socket,
                Arc::new(Retirement(retirement)),
                Duration::from_millis(startup_timeout_ms),
            )?,
        }))
    }

    pub fn generation(&self) -> Vec<u8> {
        self.worker.epoch().to_vec()
    }

    pub async fn open(&self, options: OpenOptions) -> Result<BrokerReady, NativeError> {
        let ready = self
            .worker
            .open(NativeOpenOptions {
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
        Ok(BrokerReady {
            generation: ready.epoch.to_vec(),
            abi: ready.abi,
            runtime_version: ready.runtime_version,
        })
    }

    pub async fn restore(
        &self,
        library_path: Option<String>,
        destination: String,
    ) -> Result<(), NativeError> {
        Ok(self
            .worker
            .clone()
            .restore(library_path.map(Into::into), destination.into())
            .await?)
    }

    pub async fn serve(&self) -> Result<(), NativeError> {
        Ok(self.worker.clone().serve().await?)
    }
    pub fn cancel_request(&self, generation: Vec<u8>, request: u64) -> Result<(), NativeError> {
        self.worker.cancel(epoch(generation)?, request);
        Ok(())
    }
    pub fn close(&self, generation: Vec<u8>) -> Result<(), NativeError> {
        self.worker.close(epoch(generation)?);
        Ok(())
    }
    pub fn retire(&self) {
        self.worker.retire();
    }
}

#[uniffi::export]
pub async fn broker_restore(
    fd: i32,
    generation: Vec<u8>,
    control: Box<dyn BrokerControl>,
    operation_timeout_ms: Option<u64>,
    source_fd: i32,
) -> Result<(), NativeError> {
    let socket = broker::duplicate_socket(fd)?;
    let source = std::fs::File::from(broker::duplicate_fd(source_fd)?);
    Ok(broker::restore(
        socket,
        epoch(generation)?,
        Arc::new(Control(control)),
        operation_timeout_ms.map(Duration::from_millis),
        source,
    )
    .await?)
}

#[uniffi::export]
impl NativeRequest {
    pub async fn backup_to_fd(&self, fd: i32) -> Result<(), NativeError> {
        let output = std::fs::File::from(broker::duplicate_fd(fd)?);
        self.request
            .backup_to(output)
            .await
            .map_err(|error| self.failure(error))
    }
}
