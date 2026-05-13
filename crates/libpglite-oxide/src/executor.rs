use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};

use crate::engine::{EngineCapabilities, EngineSession};
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::reply;
use crate::storage::{BackupArtifact, BackupRequest};

type StreamSink = Box<dyn FnMut(&[u8]) -> Result<()> + Send>;

pub(crate) struct EngineExecutor {
    sender: Sender<Command>,
    capabilities: EngineCapabilities,
    closed: AtomicBool,
    owner: Option<JoinHandle<()>>,
}

impl EngineExecutor {
    pub(crate) fn spawn(mut session: Box<dyn EngineSession>) -> Arc<Self> {
        let capabilities = session.capabilities();
        let (sender, receiver) = mpsc::channel::<Command>();
        let owner = thread::Builder::new()
            .name("libpglite-oxide-owner".to_owned())
            .spawn(move || {
                let mut active_pin = None;
                let mut next_pin = 1_u64;
                for command in receiver {
                    match command {
                        Command::Exec { request, reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                session.exec_protocol_raw(request)
                            };
                            reply.send(result);
                        }
                        Command::PinnedExec {
                            token,
                            request,
                            reply,
                        } => {
                            let result = if active_pin == Some(token) {
                                session.exec_protocol_raw(request)
                            } else {
                                Err(Error::InvalidSessionPin)
                            };
                            reply.send(result);
                        }
                        Command::Stream {
                            request,
                            mut on_chunk,
                            reply,
                        } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                session.exec_protocol_stream(request, &mut on_chunk)
                            };
                            reply.send(result);
                        }
                        Command::Pin { reply } => {
                            if active_pin.is_some() {
                                reply.send(Err(Error::SessionPinned));
                            } else {
                                let token = next_pin;
                                next_pin = next_pin.saturating_add(1);
                                active_pin = Some(token);
                                reply.send(Ok(token));
                            }
                        }
                        Command::ReleasePin { token, reply } => {
                            let result = if active_pin == Some(token) {
                                active_pin = None;
                                Ok(())
                            } else {
                                Err(Error::InvalidSessionPin)
                            };
                            if let Some(reply) = reply {
                                reply.send(result);
                            }
                        }
                        Command::Checkpoint { reply } => {
                            reply.send(session.checkpoint());
                        }
                        Command::Backup { request, reply } => {
                            reply.send(session.backup(request));
                        }
                        Command::Close { reply } => {
                            let result = session.close();
                            if let Some(reply) = reply {
                                reply.send(result);
                            }
                            break;
                        }
                    }
                }
            })
            .expect("spawn libpglite-oxide owner thread");

        Arc::new(Self {
            sender,
            capabilities,
            closed: AtomicBool::new(false),
            owner: Some(owner),
        })
    }

    pub(crate) fn capabilities(&self) -> EngineCapabilities {
        self.capabilities.clone()
    }

    pub(crate) async fn exec_protocol_raw(
        &self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Exec { request, reply })?;
        receiver.await
    }

    pub(crate) async fn pinned_exec_protocol_raw(
        &self,
        token: u64,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::PinnedExec {
            token,
            request,
            reply,
        })?;
        receiver.await
    }

    pub(crate) async fn exec_protocol_stream<F>(
        &self,
        request: ProtocolRequest,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        let (reply, receiver) = reply::channel();
        self.send(Command::Stream {
            request,
            on_chunk: Box::new(on_chunk),
            reply,
        })?;
        receiver.await
    }

    pub(crate) async fn pin_session(&self) -> Result<u64> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Pin { reply })?;
        receiver.await
    }

    pub(crate) async fn release_pin(&self, token: u64) -> Result<()> {
        let (reply, receiver) = reply::channel();
        self.send(Command::ReleasePin {
            token,
            reply: Some(reply),
        })?;
        receiver.await
    }

    pub(crate) fn release_pin_best_effort(&self, token: u64) {
        let _ = self.sender.send(Command::ReleasePin { token, reply: None });
    }

    pub(crate) async fn checkpoint(&self) -> Result<()> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Checkpoint { reply })?;
        receiver.await
    }

    pub(crate) async fn backup(&self, request: BackupRequest) -> Result<BackupArtifact> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Backup { request, reply })?;
        receiver.await
    }

    pub(crate) async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let (reply, receiver) = reply::channel();
        self.sender
            .send(Command::Close { reply: Some(reply) })
            .map_err(|_| Error::EngineStopped)?;
        receiver.await
    }

    fn send(&self, command: Command) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        self.sender.send(command).map_err(|_| Error::EngineStopped)
    }
}

impl Drop for EngineExecutor {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.sender.send(Command::Close { reply: None });
        }
        if let Some(owner) = self.owner.take() {
            let _ = owner.join();
        }
    }
}

enum Command {
    Exec {
        request: ProtocolRequest,
        reply: reply::Sender<Result<ProtocolResponse>>,
    },
    PinnedExec {
        token: u64,
        request: ProtocolRequest,
        reply: reply::Sender<Result<ProtocolResponse>>,
    },
    Stream {
        request: ProtocolRequest,
        on_chunk: StreamSink,
        reply: reply::Sender<Result<()>>,
    },
    Pin {
        reply: reply::Sender<Result<u64>>,
    },
    ReleasePin {
        token: u64,
        reply: Option<reply::Sender<Result<()>>>,
    },
    Checkpoint {
        reply: reply::Sender<Result<()>>,
    },
    Backup {
        request: BackupRequest,
        reply: reply::Sender<Result<BackupArtifact>>,
    },
    Close {
        reply: Option<reply::Sender<Result<()>>>,
    },
}
