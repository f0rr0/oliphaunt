use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use crossbeam_channel::{Sender, unbounded};

use crate::engine::{EngineCancel, EngineCapabilities, EngineSession};
use crate::error::{Error, Result};
use crate::lifecycle::{
    BackgroundCheckpointSkipReason, BackgroundPreparationOptions, BackgroundPreparationResult,
};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::reply;
use crate::storage::{BackupArtifact, BackupRequest};

type StreamSink = Box<dyn FnMut(&[u8]) -> Result<()> + Send>;

pub(crate) struct EngineExecutor {
    sender: Sender<Command>,
    capabilities: EngineCapabilities,
    connection_string: Option<String>,
    cancel: Option<Arc<dyn EngineCancel>>,
    active_work: Arc<AtomicBool>,
    session_pinned: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    owner: Option<JoinHandle<()>>,
}

impl EngineExecutor {
    pub(crate) fn spawn(mut session: Box<dyn EngineSession>) -> Arc<Self> {
        let capabilities = session.capabilities();
        let connection_string = session.connection_string();
        let cancel = session.cancel_handle();
        let active_work = Arc::new(AtomicBool::new(false));
        let owner_active_work = Arc::clone(&active_work);
        let session_pinned = Arc::new(AtomicBool::new(false));
        let owner_session_pinned = Arc::clone(&session_pinned);
        let closed = Arc::new(AtomicBool::new(false));
        let owner_closed = Arc::clone(&closed);
        let (sender, receiver) = unbounded::<Command>();
        let owner = thread::Builder::new()
            .name("oliphaunt-owner".to_owned())
            .spawn(move || {
                let mut active_pin = None;
                let mut next_pin = 1_u64;
                for command in receiver {
                    if owner_closed.load(Ordering::SeqCst) && !command.is_close() {
                        command.reply_engine_stopped();
                        continue;
                    }
                    match command {
                        Command::Exec { request, reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_raw(request)
                                })
                            };
                            reply.send(result);
                        }
                        Command::SimpleQuery { sql, reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                run_active_work(&owner_active_work, || {
                                    session.exec_simple_query(&sql)
                                })
                            };
                            reply.send(result);
                        }
                        Command::PinnedExec {
                            token,
                            request,
                            reply,
                        } => {
                            let result = if active_pin == Some(token) {
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_raw(request)
                                })
                            } else {
                                Err(Error::InvalidSessionPin)
                            };
                            reply.send(result);
                        }
                        Command::PinnedStream {
                            token,
                            request,
                            mut on_chunk,
                            reply,
                        } => {
                            let result = if active_pin == Some(token) {
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_stream(request, &mut on_chunk)
                                })
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
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_stream(request, &mut on_chunk)
                                })
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
                                owner_session_pinned.store(true, Ordering::SeqCst);
                                reply.send(Ok(token));
                            }
                        }
                        Command::ReleasePin { token, reply } => {
                            let result = if active_pin == Some(token) {
                                active_pin = None;
                                owner_session_pinned.store(false, Ordering::SeqCst);
                                Ok(())
                            } else {
                                Err(Error::InvalidSessionPin)
                            };
                            if let Some(reply) = reply {
                                reply.send(result);
                            }
                        }
                        Command::RollbackAndReleasePin { token } => {
                            if active_pin == Some(token) {
                                let _ = run_active_work(&owner_active_work, || {
                                    let rollback = ProtocolRequest::simple_query("ROLLBACK")?;
                                    session.exec_protocol_raw(rollback)
                                });
                                active_pin = None;
                                owner_session_pinned.store(false, Ordering::SeqCst);
                            }
                        }
                        Command::Checkpoint { reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                run_active_work(&owner_active_work, || session.checkpoint())
                            };
                            reply.send(result);
                        }
                        Command::Backup { request, reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::SessionPinned)
                            } else {
                                run_active_work(&owner_active_work, || session.backup(request))
                            };
                            reply.send(result);
                        }
                        Command::Close { reply } => {
                            let result = session.close();
                            drop(session);
                            owner_session_pinned.store(false, Ordering::SeqCst);
                            if let Some(reply) = reply {
                                reply.send(result);
                            }
                            return;
                        }
                    }
                }
            })
            .expect("spawn oliphaunt owner thread");

        Arc::new(Self {
            sender,
            capabilities,
            connection_string,
            cancel,
            active_work,
            session_pinned,
            closed,
            owner: Some(owner),
        })
    }

    pub(crate) fn capabilities(&self) -> EngineCapabilities {
        self.capabilities.clone()
    }

    pub(crate) fn connection_string(&self) -> Option<String> {
        self.connection_string.clone()
    }

    pub(crate) fn cancel(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        let cancel = self.cancel.as_ref().ok_or_else(|| {
            Error::Engine("query cancellation is not supported by this engine".to_owned())
        })?;
        cancel.cancel()
    }

    pub(crate) async fn exec_protocol_raw(
        &self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Exec { request, reply })?;
        receiver.await
    }

    pub(crate) async fn exec_simple_query(&self, sql: String) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::SimpleQuery { sql, reply })?;
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

    pub(crate) async fn pinned_exec_protocol_stream<F>(
        &self,
        token: u64,
        request: ProtocolRequest,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        let (reply, receiver) = reply::channel();
        self.send(Command::PinnedStream {
            token,
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

    pub(crate) fn rollback_and_release_pin_best_effort(&self, token: u64) {
        let _ = self.sender.send(Command::RollbackAndReleasePin { token });
    }

    pub(crate) async fn checkpoint(&self) -> Result<()> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Checkpoint { reply })?;
        receiver.await
    }

    pub(crate) async fn prepare_for_background(
        &self,
        options: BackgroundPreparationOptions,
    ) -> Result<BackgroundPreparationResult> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }

        let had_active_work = self.active_work.load(Ordering::SeqCst);
        let cancelled_active_work = if options.cancel_active_work && had_active_work {
            self.cancel_active_work()?;
            true
        } else {
            false
        };

        if !options.checkpoint_when_idle {
            return Ok(BackgroundPreparationResult::skipped(
                cancelled_active_work,
                None,
            ));
        }
        if self.session_pinned.load(Ordering::SeqCst) {
            return Ok(BackgroundPreparationResult::skipped(
                cancelled_active_work,
                Some(BackgroundCheckpointSkipReason::SessionPinned),
            ));
        }
        if had_active_work || self.active_work.load(Ordering::SeqCst) {
            return Ok(BackgroundPreparationResult::skipped(
                cancelled_active_work,
                Some(BackgroundCheckpointSkipReason::ActiveWork),
            ));
        }

        match self.checkpoint().await {
            Ok(()) => Ok(BackgroundPreparationResult::checkpointed()),
            Err(Error::SessionPinned) => Ok(BackgroundPreparationResult::skipped(
                cancelled_active_work,
                Some(BackgroundCheckpointSkipReason::SessionPinned),
            )),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn resume_from_background(&self) -> Result<()> {
        self.exec_simple_query("SELECT 1".to_owned())
            .await
            .map(|_| ())
    }

    pub(crate) async fn backup(&self, request: BackupRequest) -> Result<BackupArtifact> {
        if !self.capabilities.supports_backup_format(request.format) {
            return Err(Error::Engine(format!(
                "{:?} backup is not supported by {}",
                request.format, self.capabilities.mode
            )));
        }
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

    fn cancel_active_work_best_effort(&self) {
        if !self.active_work.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.cancel_active_work();
    }

    fn cancel_active_work(&self) -> Result<()> {
        let cancel = self.cancel.as_ref().ok_or_else(|| {
            Error::Engine("query cancellation is not supported by this engine".to_owned())
        })?;
        cancel.cancel()
    }
}

impl Drop for EngineExecutor {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.cancel_active_work_best_effort();
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
    SimpleQuery {
        sql: String,
        reply: reply::Sender<Result<ProtocolResponse>>,
    },
    PinnedExec {
        token: u64,
        request: ProtocolRequest,
        reply: reply::Sender<Result<ProtocolResponse>>,
    },
    PinnedStream {
        token: u64,
        request: ProtocolRequest,
        on_chunk: StreamSink,
        reply: reply::Sender<Result<()>>,
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
    RollbackAndReleasePin {
        token: u64,
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

impl Command {
    fn is_close(&self) -> bool {
        matches!(self, Self::Close { .. })
    }

    fn reply_engine_stopped(self) {
        match self {
            Self::Exec { reply, .. }
            | Self::SimpleQuery { reply, .. }
            | Self::PinnedExec { reply, .. } => {
                reply.send(Err(Error::EngineStopped));
            }
            Self::PinnedStream { reply, .. } => reply.send(Err(Error::EngineStopped)),
            Self::Stream { reply, .. } => reply.send(Err(Error::EngineStopped)),
            Self::Pin { reply } => reply.send(Err(Error::EngineStopped)),
            Self::Checkpoint { reply } => reply.send(Err(Error::EngineStopped)),
            Self::Backup { reply, .. } => reply.send(Err(Error::EngineStopped)),
            Self::RollbackAndReleasePin { .. } => {}
            Self::ReleasePin { reply, .. } | Self::Close { reply } => {
                if let Some(reply) = reply {
                    reply.send(Err(Error::EngineStopped));
                }
            }
        }
    }
}

fn run_active_work<T>(active_work: &AtomicBool, work: impl FnOnce() -> T) -> T {
    let _guard = ActiveWorkGuard::new(active_work);
    work()
}

struct ActiveWorkGuard<'a> {
    active_work: &'a AtomicBool,
}

impl<'a> ActiveWorkGuard<'a> {
    fn new(active_work: &'a AtomicBool) -> Self {
        active_work.store(true, Ordering::SeqCst);
        Self { active_work }
    }
}

impl Drop for ActiveWorkGuard<'_> {
    fn drop(&mut self) {
        self.active_work.store(false, Ordering::SeqCst);
    }
}
