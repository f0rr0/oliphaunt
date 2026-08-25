use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use crossbeam_channel::{Sender, unbounded};

use crate::engine::{EngineCancel, EngineSession};
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::reply;

type ProtocolChunkCallback = Box<dyn FnMut(&[u8]) -> Result<()> + Send>;

pub(crate) struct EngineExecutor {
    sender: Sender<Command>,
    admission: Mutex<()>,
    cancel: Option<Arc<dyn EngineCancel>>,
    active_work: Arc<AtomicBool>,
    session_pinned: Arc<AtomicBool>,
    transaction_poisoned: AtomicBool,
    closing: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    owner: Option<JoinHandle<()>>,
}

impl EngineExecutor {
    pub(crate) fn spawn(mut session: Box<dyn EngineSession>) -> Arc<Self> {
        let cancel = session.cancel_handle();
        let active_work = Arc::new(AtomicBool::new(false));
        let owner_active_work = Arc::clone(&active_work);
        let session_pinned = Arc::new(AtomicBool::new(false));
        let owner_session_pinned = Arc::clone(&session_pinned);
        let closing = Arc::new(AtomicBool::new(false));
        let owner_closing = Arc::clone(&closing);
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
                    // A close request is a queue barrier, not merely another
                    // FIFO item. Work already waiting behind the active owner
                    // operation must not extend the database lifetime after
                    // close begins. Internal pin cleanup is still admitted so
                    // a failed close leaves the retained session recoverable.
                    if owner_closing.load(Ordering::SeqCst) && command.reject_when_closing() {
                        command.reply_engine_stopped();
                        continue;
                    }
                    match command {
                        Command::Exec { request, reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::TransactionActive)
                            } else {
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_raw(request)
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
                                Err(inactive_transaction_error())
                            };
                            reply.send(result);
                        }
                        Command::Stream {
                            request,
                            mut on_chunk,
                            reply,
                        } => {
                            let result = if active_pin.is_some() {
                                Err(Error::TransactionActive)
                            } else {
                                run_active_work(&owner_active_work, || {
                                    session.exec_protocol_stream(request, &mut on_chunk)
                                })
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
                                Err(inactive_transaction_error())
                            };
                            reply.send(result);
                        }
                        Command::Pin { reply } => {
                            if active_pin.is_some() {
                                reply.send(Err(Error::TransactionActive));
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
                                Err(inactive_transaction_error())
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
                        Command::Backup { reply } => {
                            let result = if active_pin.is_some() {
                                Err(Error::TransactionActive)
                            } else {
                                run_active_work(&owner_active_work, || session.backup())
                            };
                            reply.send(result);
                        }
                        Command::Close { reply } => {
                            if active_pin.is_some() {
                                owner_closing.store(false, Ordering::SeqCst);
                                if let Some(reply) = reply {
                                    reply.send(Err(Error::TransactionActive));
                                }
                                continue;
                            }
                            let terminal_drop = reply.is_none();
                            let result = session.close();
                            if result.is_ok() {
                                owner_closed.store(true, Ordering::SeqCst);
                                owner_session_pinned.store(false, Ordering::SeqCst);
                                owner_closing.store(false, Ordering::SeqCst);
                                // Successful close includes releasing every
                                // session-owned root lock. Do that before
                                // waking a caller that may immediately reopen.
                                drop(session);
                                if let Some(reply) = reply {
                                    reply.send(result);
                                }
                                return;
                            }
                            owner_closing.store(false, Ordering::SeqCst);
                            if let Some(reply) = reply {
                                reply.send(result);
                            }
                            if terminal_drop {
                                // The public executor no longer exists, but the
                                // native session still owns process-resident
                                // code, locks, and possibly temporary storage.
                                // Preserve that ownership through process exit
                                // instead of dropping it after a failed detach.
                                std::mem::forget(session);
                                return;
                            }
                        }
                    }
                }
            })
            .expect("spawn oliphaunt owner thread");

        Arc::new(Self {
            sender,
            admission: Mutex::new(()),
            cancel,
            active_work,
            session_pinned,
            transaction_poisoned: AtomicBool::new(false),
            closing,
            closed,
            owner: Some(owner),
        })
    }

    pub(crate) fn cancel(&self) -> Result<()> {
        let _admission = self.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.closed.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        self.cancel_unchecked()
    }

    fn cancel_unchecked(&self) -> Result<()> {
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
        self.send_cleanup(Command::ReleasePin {
            token,
            reply: Some(reply),
        })?;
        receiver.await
    }

    pub(crate) fn release_pin_best_effort(&self, token: u64) {
        let _ = self.send_cleanup(Command::ReleasePin { token, reply: None });
    }

    pub(crate) fn rollback_and_release_pin_best_effort(&self, token: u64) {
        let _ = self.send_cleanup(Command::RollbackAndReleasePin { token });
    }

    pub(crate) fn poison_transaction_state(&self) {
        self.transaction_poisoned.store(true, Ordering::SeqCst);
    }

    pub(crate) async fn backup(&self) -> Result<Vec<u8>> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Backup { reply })?;
        receiver.await
    }

    pub(crate) async fn close(&self) -> Result<()> {
        let (reply, receiver) = reply::channel();
        {
            // The admission lock makes the state transition and close enqueue
            // indivisible with respect to every public command submission.
            // Commands either enter the queue before Close or observe closing.
            let _admission = self.admission.lock().map_err(|_| {
                Error::Engine("database command admission lock was poisoned".to_owned())
            })?;
            if self.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            if self.session_pinned.load(Ordering::SeqCst) {
                return Err(Error::TransactionActive);
            }
            self.closing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| Error::Engine("database close is already in progress".to_owned()))?;
            if self
                .sender
                .send(Command::Close { reply: Some(reply) })
                .is_err()
            {
                self.closing.store(false, Ordering::SeqCst);
                return Err(Error::EngineStopped);
            }
        }
        let result = receiver.await;
        if result.is_ok() {
            self.closed.store(true, Ordering::SeqCst);
        }
        result
    }

    fn send(&self, command: Command) -> Result<()> {
        let _admission = self.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.closed.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        if self.transaction_poisoned.load(Ordering::SeqCst) {
            return Err(Error::Engine(
                "transaction state is unknown; close the database".to_owned(),
            ));
        }
        self.sender.send(command).map_err(|_| Error::EngineStopped)
    }

    /// Admit pin cleanup even after transaction state is poisoned. Cleanup is
    /// the only safe operation before close and must not strand the owner on an
    /// active pin.
    fn send_cleanup(&self, command: Command) -> Result<()> {
        let _admission = self.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        self.sender.send(command).map_err(|_| Error::EngineStopped)
    }

    fn cancel_active_work_best_effort(&self) {
        if !self.active_work.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.cancel_unchecked();
    }
}

impl Drop for EngineExecutor {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.closing.store(true, Ordering::SeqCst);
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
    PinnedExec {
        token: u64,
        request: ProtocolRequest,
        reply: reply::Sender<Result<ProtocolResponse>>,
    },
    Stream {
        request: ProtocolRequest,
        on_chunk: ProtocolChunkCallback,
        reply: reply::Sender<Result<()>>,
    },
    PinnedStream {
        token: u64,
        request: ProtocolRequest,
        on_chunk: ProtocolChunkCallback,
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
    Backup {
        reply: reply::Sender<Result<Vec<u8>>>,
    },
    Close {
        reply: Option<reply::Sender<Result<()>>>,
    },
}

impl Command {
    fn is_close(&self) -> bool {
        matches!(self, Self::Close { .. })
    }

    fn reject_when_closing(&self) -> bool {
        matches!(
            self,
            Self::Exec { .. }
                | Self::PinnedExec { .. }
                | Self::Stream { .. }
                | Self::PinnedStream { .. }
                | Self::Pin { .. }
                | Self::Backup { .. }
        )
    }

    fn reply_engine_stopped(self) {
        match self {
            Self::Exec { reply, .. } | Self::PinnedExec { reply, .. } => {
                reply.send(Err(Error::EngineStopped));
            }
            Self::Stream { reply, .. } | Self::PinnedStream { reply, .. } => {
                reply.send(Err(Error::EngineStopped));
            }
            Self::Pin { reply } => reply.send(Err(Error::EngineStopped)),
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

fn inactive_transaction_error() -> Error {
    Error::Engine("transaction is no longer active".to_owned())
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::*;
    use crossbeam_channel::{Receiver, Sender};

    struct FailOnceCloseSession {
        close_attempts: Arc<AtomicUsize>,
    }

    impl EngineSession for FailOnceCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            if self.close_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(Error::Engine("injected detach failure".to_owned()))
            } else {
                Ok(())
            }
        }
    }

    struct DropObservedSession {
        dropped: Arc<AtomicBool>,
    }

    impl EngineSession for DropObservedSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    impl Drop for DropObservedSession {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn successful_close_releases_the_session_before_it_resolves() {
        let dropped = Arc::new(AtomicBool::new(false));
        let executor = EngineExecutor::spawn(Box::new(DropObservedSession {
            dropped: Arc::clone(&dropped),
        }));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime");

        runtime.block_on(executor.close()).expect("close session");
        assert!(
            dropped.load(Ordering::SeqCst),
            "close must not resolve while the session still owns its root lock"
        );
    }

    #[test]
    fn failed_close_keeps_the_session_usable_and_retryable() {
        let close_attempts = Arc::new(AtomicUsize::new(0));
        let executor = EngineExecutor::spawn(Box::new(FailOnceCloseSession {
            close_attempts: Arc::clone(&close_attempts),
        }));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime");

        let first_error = runtime.block_on(executor.close()).unwrap_err();
        assert_eq!(
            first_error,
            Error::Engine("injected detach failure".to_owned())
        );
        let response = runtime
            .block_on(executor.exec_protocol_raw(ProtocolRequest::new([1, 2, 3])))
            .expect("session remains usable after failed close");
        assert_eq!(response.as_bytes(), &[1, 2, 3]);

        runtime
            .block_on(executor.close())
            .expect("second close retries the same session");
        runtime
            .block_on(executor.close())
            .expect("close is idempotent after success");
        assert_eq!(close_attempts.load(Ordering::SeqCst), 2);
    }

    struct FailThenBlockCloseSession {
        close_attempts: Arc<AtomicUsize>,
        second_started: Sender<()>,
        release_second: Receiver<()>,
    }

    impl EngineSession for FailThenBlockCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            if self.close_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(Error::Engine("injected first detach failure".to_owned()));
            }
            self.second_started
                .send(())
                .expect("announce second close attempt");
            self.release_second
                .recv()
                .expect("release second close attempt");
            Ok(())
        }
    }

    #[test]
    fn retrying_close_retains_its_admission_barrier_until_the_owner_finishes() {
        let close_attempts = Arc::new(AtomicUsize::new(0));
        let (second_started, second_started_rx) = unbounded();
        let (release_second, release_second_rx) = unbounded();
        let executor = EngineExecutor::spawn(Box::new(FailThenBlockCloseSession {
            close_attempts: Arc::clone(&close_attempts),
            second_started,
            release_second: release_second_rx,
        }));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread test runtime");

        assert_eq!(
            runtime.block_on(executor.close()).unwrap_err(),
            Error::Engine("injected first detach failure".to_owned())
        );

        let retry_executor = Arc::clone(&executor);
        let retry = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("build retry runtime");
            runtime.block_on(retry_executor.close())
        });
        second_started_rx
            .recv()
            .expect("second close reaches the retained session");

        assert_eq!(
            runtime
                .block_on(executor.exec_protocol_raw(ProtocolRequest::new([9])))
                .unwrap_err(),
            Error::EngineStopped
        );
        release_second.send(()).expect("finish second close");
        retry
            .join()
            .expect("join retry close")
            .expect("retry closes");
        assert_eq!(close_attempts.load(Ordering::SeqCst), 2);
    }

    struct DrainBeforeCloseSession {
        work_started: Sender<()>,
        release_work: Receiver<()>,
        close_started: Sender<()>,
    }

    impl EngineSession for DrainBeforeCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.work_started.send(()).expect("announce active work");
            self.release_work.recv().expect("release active work");
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            self.close_started.send(()).expect("announce close");
            Ok(())
        }
    }

    #[test]
    fn close_drains_active_work_and_rejects_new_admission() {
        let (work_started, work_started_rx) = unbounded();
        let (release_work, release_work_rx) = unbounded();
        let (close_started, close_started_rx) = unbounded();
        let executor = EngineExecutor::spawn(Box::new(DrainBeforeCloseSession {
            work_started,
            release_work: release_work_rx,
            close_started,
        }));

        let work_executor = Arc::clone(&executor);
        let work = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("build active-work runtime");
            runtime.block_on(work_executor.exec_protocol_raw(ProtocolRequest::new([6])))
        });
        work_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("work reaches the owner");

        let close_executor = Arc::clone(&executor);
        let close = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("build close runtime");
            runtime.block_on(close_executor.close())
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !executor.closing.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::yield_now();
        }
        let barrier_established = executor.closing.load(Ordering::SeqCst);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build admission test runtime");
        let admission = barrier_established.then(|| {
            runtime
                .block_on(executor.exec_protocol_raw(ProtocolRequest::new([7])))
                .expect_err("new work is rejected while close drains")
        });
        let close_waited_for_work = close_started_rx.try_recv().is_err();

        release_work.send(()).expect("finish active work");
        assert_eq!(
            work.join()
                .expect("join active work")
                .expect("active work completes")
                .as_bytes(),
            &[6]
        );
        close_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("session closes after active work");
        close.join().expect("join close").expect("close completes");
        assert!(
            barrier_established,
            "close establishes its admission barrier"
        );
        assert_eq!(admission, Some(Error::EngineStopped));
        assert!(
            close_waited_for_work,
            "session close must wait for active work"
        );
    }
}
