//! Asynchronous owner-thread API for applications that must keep their calling
//! executor responsive while PostgreSQL runs synchronously on another thread.
//!
//! Each [`AsyncOliphaunt`] owns one database thread and one FIFO command queue. The
//! handle is cloneable and asynchronous; the direct caller-thread API remains
//! available from the crate root. Storage, query/result, error, extension, and
//! listener configuration types are shared by both APIs and also live at the
//! crate root.

use std::borrow::Cow;
use std::cell::Cell;
use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, oneshot};

use crate::oliphaunt::builder::OliphauntBuilder as DirectOliphauntBuilder;
use crate::oliphaunt::client::Oliphaunt as DirectOliphaunt;
#[cfg(feature = "extensions")]
use crate::oliphaunt::extensions::Extension;
use crate::oliphaunt::query::{
    CommandResult, ExecResult, IntoParameter, Parameter, QueryResult, StatementDescription,
    ValueFormat,
};
use crate::oliphaunt::server::{
    OliphauntServer as DirectOliphauntServer,
    OliphauntServerBuilder as DirectOliphauntServerBuilder, ServerListen,
};
use crate::{
    DatabaseStorage, Error, RawStreamCallbackOutput, RawStreamError, RawStreamResult, Result,
    TransactionError, TransactionResult,
};

const OWNER_QUEUE_CAPACITY: usize = 64;
const OWNER_OPEN: u8 = 0;
const OWNER_CLOSED: u8 = 1;
const OWNER_STOPPED: u8 = 2;
const OWNER_CLOSING: u8 = 3;
const TRANSACTION_ACTIVE: u8 = 0;
const TRANSACTION_FINISHING: u8 = 1;
const TRANSACTION_ROLLED_BACK: u8 = 2;
const TRANSACTION_COMMITTED: u8 = 3;
const TRANSACTION_FAILED: u8 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransactionDropAction {
    Rollback,
    AbandonFailed,
    None,
}

fn claim_transaction_for_drop(state: &AtomicU8) -> TransactionDropAction {
    match state.compare_exchange(
        TRANSACTION_ACTIVE,
        TRANSACTION_FINISHING,
        Ordering::SeqCst,
        Ordering::SeqCst,
    ) {
        Ok(_) => TransactionDropAction::Rollback,
        Err(TRANSACTION_FAILED) => TransactionDropAction::AbandonFailed,
        Err(_) => TransactionDropAction::None,
    }
}

struct TransactionOutcomeGuard {
    state: AtomicU8,
    terminal_error: Mutex<Option<Error>>,
    terminal_failure_was_rollback: AtomicU8,
    settlement_started: AtomicU8,
    settlement_observed: AtomicU8,
}

impl TransactionOutcomeGuard {
    fn active() -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(TRANSACTION_ACTIVE),
            terminal_error: Mutex::new(None),
            terminal_failure_was_rollback: AtomicU8::new(0),
            settlement_started: AtomicU8::new(0),
            settlement_observed: AtomicU8::new(0),
        })
    }

    fn retain_failure(&self, error: Error, rollback_was_attempted: bool) {
        if let Ok(mut terminal) = self.terminal_error.lock()
            && terminal.is_none()
        {
            *terminal = Some(error);
            self.terminal_failure_was_rollback
                .store(u8::from(rollback_was_attempted), Ordering::SeqCst);
        }
        self.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
    }

    fn retained_error(&self) -> Error {
        self.terminal_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
            .unwrap_or_else(|| Error::message("transaction failed"))
    }
}

type OwnerAction = Box<dyn FnOnce(&mut DirectOliphaunt, Result<()>) + Send + 'static>;
type SharedCloseResult = Result<()>;
type CloseWaiter = oneshot::Sender<SharedCloseResult>;

fn owner_is_terminal(state: &AtomicU8) -> bool {
    matches!(state.load(Ordering::SeqCst), OWNER_CLOSED | OWNER_STOPPED)
}

#[derive(Default)]
struct CloseAttempt {
    completion: Mutex<CloseCompletion>,
}

#[derive(Default)]
struct CloseCompletion {
    result: Option<SharedCloseResult>,
    waiters: Vec<CloseWaiter>,
}

enum CloseAdmission {
    Closed,
    Start(Arc<CloseAttempt>),
    Join(Arc<CloseAttempt>),
}

#[derive(Clone, Copy)]
enum CloseDisposition {
    /// Validation rejected close before shutdown began. Publish the result,
    /// then reopen admission for a distinct explicit attempt.
    Retryable,
    /// Shutdown began (or the owner was lost). The handle is permanently
    /// retired and every later close replays this attempt's result.
    Terminal,
}

impl CloseAttempt {
    async fn wait(&self, owner: &'static str) -> Result<()> {
        let receiver = {
            let mut completion = self
                .completion
                .lock()
                .map_err(|_| Error::message(format!("{owner} close completion lock poisoned")))?;
            if let Some(result) = completion.result.clone() {
                return shared_close_result(result);
            }
            let (waiter, receiver) = oneshot::channel();
            completion.waiters.push(waiter);
            receiver
        };
        let result = receiver
            .await
            .map_err(|_| Error::lifecycle(format!("{owner} stopped while closing")))?;
        shared_close_result(result)
    }

    fn complete(&self, result: SharedCloseResult) {
        let waiters = {
            let mut completion = self
                .completion
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if completion.result.is_some() {
                return;
            }
            completion.result = Some(result.clone());
            std::mem::take(&mut completion.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
    }

    #[cfg(test)]
    fn waiter_count(&self) -> usize {
        self.completion
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .waiters
            .len()
    }
}

struct OwnerCommand {
    transaction: Option<u64>,
    action: OwnerAction,
}

struct OwnerMessage {
    // Ordinary work and transaction begin consume bounded admission. Lifecycle
    // controls omit the permit so close/rollback can always enter the same
    // ordered queue without overtaking already-admitted work.
    _permit: Option<OwnedSemaphorePermit>,
    operation: OwnerOperation,
}

enum OwnerOperation {
    Command(OwnerCommand),
    Control(OwnerControl),
}

enum OwnerControl {
    Begin {
        token: u64,
        reply: oneshot::Sender<Result<()>>,
    },
    Finish {
        token: u64,
        commit: bool,
        guard: Arc<TransactionOutcomeGuard>,
        reply: oneshot::Sender<TransactionFinishOutcome>,
    },
    FinishObserved {
        token: u64,
    },
    FinishAbandoned {
        token: u64,
        guard: Arc<TransactionOutcomeGuard>,
    },
    RollbackBestEffort {
        token: u64,
        guard: Arc<TransactionOutcomeGuard>,
    },
    AbandonFailed {
        token: u64,
        reply: Option<oneshot::Sender<Result<()>>>,
    },
    Close {
        attempt: Arc<CloseAttempt>,
    },
    Shutdown,
}

enum TransactionFinishOutcome {
    Attempted(Result<()>),
    NotAttempted(Error),
}

#[derive(Clone)]
struct DatabaseOwner {
    inner: Arc<DatabaseOwnerInner>,
}

struct DatabaseOwnerInner {
    // Every send, including the open -> closing cutoff, is serialized by
    // `admission`. The single receiver is therefore the total admission order.
    queue: mpsc::Sender<OwnerMessage>,
    admission: Arc<Mutex<()>>,
    ordinary_order: Arc<AsyncMutex<()>>,
    ordinary_capacity: Arc<Semaphore>,
    state: Arc<AtomicU8>,
    close_epoch: AtomicU64,
    close_attempt: Arc<Mutex<Option<Arc<CloseAttempt>>>>,
    owner_thread: thread::ThreadId,
    next_transaction: AtomicU64,
}

impl Drop for DatabaseOwnerInner {
    fn drop(&mut self) {
        let _admission = self.admission.lock().ok();
        let _ = self.queue.send(OwnerMessage {
            _permit: None,
            operation: OwnerOperation::Control(OwnerControl::Shutdown),
        });
    }
}

impl DatabaseOwner {
    async fn open(builder: DirectOliphauntBuilder) -> Result<Self> {
        let (queue, queue_rx) = mpsc::channel();
        let (open_tx, open_rx) = oneshot::channel();
        let state = Arc::new(AtomicU8::new(OWNER_OPEN));
        let ordinary_order = Arc::new(AsyncMutex::new(()));
        let ordinary_capacity = Arc::new(Semaphore::new(OWNER_QUEUE_CAPACITY));
        let admission = Arc::new(Mutex::new(()));
        let close_attempt = Arc::new(Mutex::new(None));
        let thread_state = Arc::clone(&state);
        let thread_admission = Arc::clone(&admission);
        let thread_close_attempt = Arc::clone(&close_attempt);
        thread::Builder::new()
            .name("oliphaunt-wasix-owner".to_owned())
            .spawn(move || {
                let opened =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| builder.open()));
                let database = match opened {
                    Ok(Ok(database)) => {
                        let _ = open_tx.send(Ok(thread::current().id()));
                        database
                    }
                    Ok(Err(error)) => {
                        let _ = open_tx.send(Err(error));
                        thread_state.store(OWNER_STOPPED, Ordering::SeqCst);
                        return;
                    }
                    Err(_) => {
                        let _ = open_tx.send(Err(Error::message(
                            "WASIX database owner panicked while opening PostgreSQL",
                        )));
                        thread_state.store(OWNER_STOPPED, Ordering::SeqCst);
                        return;
                    }
                };

                let owner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_database_owner(
                        database,
                        queue_rx,
                        &thread_state,
                        &thread_admission,
                        &thread_close_attempt,
                    )
                }));
                if owner.is_err() {
                    stop_close_owner(
                        &thread_admission,
                        &thread_state,
                        &thread_close_attempt,
                        "WASIX database owner panicked while closing",
                    );
                }
            })
            .map_err(|error| Error::message(format!("spawn WASIX database owner: {error}")))?;
        let owner_thread = open_rx.await.map_err(|_| {
            Error::lifecycle("WASIX database owner stopped before open completed")
        })??;
        Ok(Self {
            inner: Arc::new(DatabaseOwnerInner {
                queue,
                admission,
                ordinary_order,
                ordinary_capacity,
                state,
                close_epoch: AtomicU64::new(0),
                close_attempt,
                owner_thread,
                next_transaction: AtomicU64::new(1),
            }),
        })
    }

    fn is_closed(&self) -> bool {
        owner_is_terminal(&self.inner.state)
    }

    fn ensure_open(&self) -> Result<()> {
        match self.inner.state.load(Ordering::SeqCst) {
            OWNER_OPEN => Ok(()),
            OWNER_CLOSED => Err(Error::lifecycle("AsyncOliphaunt is closed")),
            OWNER_STOPPED => Err(Error::lifecycle("WASIX database owner has stopped")),
            OWNER_CLOSING => Err(Error::lifecycle("AsyncOliphaunt is closing")),
            _ => Err(Error::message("WASIX database owner has invalid state")),
        }
    }

    fn ensure_not_owner_thread(&self) -> Result<()> {
        if thread::current().id() == self.inner.owner_thread {
            Err(Error::message(
                "reentrant WASIX database work from an owner-thread callback is not allowed",
            ))
        } else {
            Ok(())
        }
    }

    fn lock_admission(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.inner
            .admission
            .lock()
            .map_err(|_| Error::message("WASIX database admission lock poisoned"))
    }

    async fn enqueue_ordinary(&self, operation: OwnerOperation) -> Result<()> {
        let epoch = {
            let _admission = self.lock_admission()?;
            self.ensure_open()?;
            self.inner.close_epoch.load(Ordering::SeqCst)
        };
        let _order = self.inner.ordinary_order.lock().await;
        let permit = Arc::clone(&self.inner.ordinary_capacity)
            .acquire_owned()
            .await
            .map_err(|_| Error::lifecycle("WASIX database owner admission has stopped"))?;
        let _admission = self.lock_admission()?;
        self.ensure_open()?;
        if self.inner.close_epoch.load(Ordering::SeqCst) != epoch {
            return Err(Error::lifecycle(
                "operation was not admitted before the AsyncOliphaunt close cutoff",
            ));
        }
        self.inner
            .queue
            .send(OwnerMessage {
                _permit: Some(permit),
                operation,
            })
            .map_err(|_| Error::lifecycle("WASIX database owner has stopped"))
    }

    fn enqueue_control(&self, control: OwnerControl) -> Result<()> {
        let _admission = self.lock_admission()?;
        self.inner
            .queue
            .send(OwnerMessage {
                _permit: None,
                operation: OwnerOperation::Control(control),
            })
            .map_err(|_| Error::lifecycle("WASIX database owner has stopped"))
    }

    async fn call<T, F>(&self, transaction: Option<u64>, action: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut DirectOliphaunt) -> Result<T> + Send + 'static,
    {
        self.call_with_guard(transaction, None, action).await
    }

    async fn call_transaction<T, F>(
        &self,
        token: u64,
        guard: Arc<TransactionOutcomeGuard>,
        action: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut DirectOliphaunt) -> Result<T> + Send + 'static,
    {
        self.call_with_guard(Some(token), Some(guard), action).await
    }

    async fn call_with_guard<T, F>(
        &self,
        transaction: Option<u64>,
        transaction_guard: Option<Arc<TransactionOutcomeGuard>>,
        action: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut DirectOliphaunt) -> Result<T> + Send + 'static,
    {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = oneshot::channel();
        let command = OwnerCommand {
            transaction,
            action: Box::new(move |database, admission| {
                // Ordinary work which has not started may be abandoned without
                // changing PostgreSQL state. Once the action begins it always
                // runs to its protocol readiness boundary.
                if reply.is_closed() {
                    return;
                }
                let result = admission.and_then(|()| action(database));
                if database.owner_transaction_outcome_unknown()
                    && let Err(error) = &result
                    && let Some(guard) = transaction_guard.as_deref()
                {
                    guard.retain_failure(error.clone(), false);
                }
                let _ = reply.send(result);
            }),
        };
        self.enqueue_ordinary(OwnerOperation::Command(command))
            .await?;
        receiver.await.map_err(|_| {
            Error::lifecycle("WASIX database owner stopped while running an operation")
        })?
    }

    async fn begin_transaction(&self) -> Result<u64> {
        self.ensure_not_owner_thread()?;
        let token = self.inner.next_transaction.fetch_add(1, Ordering::Relaxed);
        let token = if token == 0 {
            self.inner.next_transaction.fetch_add(1, Ordering::Relaxed)
        } else {
            token
        };
        let (reply, receiver) = oneshot::channel();
        self.enqueue_ordinary(OwnerOperation::Control(OwnerControl::Begin {
            token,
            reply,
        }))
        .await?;
        receiver.await.map_err(|_| {
            Error::lifecycle("WASIX database owner stopped while beginning a transaction")
        })??;
        Ok(token)
    }

    async fn finish_transaction(
        &self,
        token: u64,
        commit: bool,
        guard: Arc<TransactionOutcomeGuard>,
    ) -> Result<TransactionFinishOutcome> {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = oneshot::channel();
        if let Err(error) = self.enqueue_control(OwnerControl::Finish {
            token,
            commit,
            guard: Arc::clone(&guard),
            reply,
        }) {
            guard.settlement_observed.store(1, Ordering::SeqCst);
            return Err(error);
        }
        let outcome = receiver.await.map_err(|_| {
            Error::lifecycle("WASIX database owner stopped while settling a transaction")
        });
        guard.settlement_observed.store(1, Ordering::SeqCst);
        if outcome.is_ok() {
            self.enqueue_control(OwnerControl::FinishObserved { token })?;
        }
        outcome
    }

    fn abandon_unobserved_finish(&self, token: u64, guard: Arc<TransactionOutcomeGuard>) {
        let _ = self.enqueue_control(OwnerControl::FinishAbandoned { token, guard });
    }

    fn rollback_best_effort(&self, token: u64, guard: Arc<TransactionOutcomeGuard>) {
        let _ = self.enqueue_control(OwnerControl::RollbackBestEffort { token, guard });
    }

    async fn abandon_failed_transaction(&self, token: u64) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue_control(OwnerControl::AbandonFailed {
            token,
            reply: Some(reply),
        })?;
        receiver.await.map_err(|_| {
            Error::lifecycle("WASIX database owner stopped while retiring a failed transaction")
        })?
    }

    fn abandon_failed_best_effort(&self, token: u64) {
        let _ = self.enqueue_control(OwnerControl::AbandonFailed { token, reply: None });
    }

    async fn close(&self) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let attempt = {
            // The state cutoff and Close enqueue share the same lock as every
            // ordinary admission. Only work which already acquired capacity
            // and entered the owner queue drains ahead of Close. Capacity
            // waiters are not admitted; they observe this cutoff and fail.
            let _admission = self.lock_admission()?;
            match admit_close(
                &self.inner.state,
                &self.inner.close_attempt,
                "WASIX database owner",
            )? {
                CloseAdmission::Closed => return Ok(()),
                CloseAdmission::Join(attempt) => attempt,
                CloseAdmission::Start(attempt) => {
                    self.inner.close_epoch.fetch_add(1, Ordering::SeqCst);
                    if self
                        .inner
                        .queue
                        .send(OwnerMessage {
                            _permit: None,
                            operation: OwnerOperation::Control(OwnerControl::Close {
                                attempt: Arc::clone(&attempt),
                            }),
                        })
                        .is_err()
                    {
                        complete_close_attempt_locked(
                            &self.inner.state,
                            &self.inner.close_attempt,
                            &attempt,
                            Err(Error::lifecycle("WASIX database owner has stopped")),
                            CloseDisposition::Terminal,
                        );
                    }
                    attempt
                }
            }
        };
        attempt.wait("WASIX database owner").await
    }
}

fn shared_close_result(result: SharedCloseResult) -> Result<()> {
    result
}

async fn exec_protocol_raw_stream_on_owner<F, O>(
    owner: &DatabaseOwner,
    request: Vec<u8>,
    mut on_chunk: F,
) -> RawStreamResult<(), O::Error>
where
    F: FnMut(&[u8]) -> O + Send + 'static,
    O: RawStreamCallbackOutput,
    O::Error: Send + 'static,
{
    let callback_error = Arc::new(Mutex::new(None));
    let callback_error_for_owner = Arc::clone(&callback_error);
    let callback_recovered = Arc::new(AtomicU8::new(0));
    let callback_recovered_on_owner = Arc::clone(&callback_recovered);
    let callback_panicked = Arc::new(AtomicU8::new(0));
    let callback_panicked_on_owner = Arc::clone(&callback_panicked);
    let session_unknown = Arc::new(AtomicU8::new(0));
    let session_unknown_on_owner = Arc::clone(&session_unknown);
    let outcome = owner
        .call(None, move |database| {
            let result = database.exec_protocol_raw_stream_on_owner(request, move |chunk| {
                match on_chunk(chunk).into_raw_stream_callback_result() {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        *callback_error_for_owner
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
                        Err(Error::message(
                            "raw protocol stream callback stopped delivery",
                        ))
                    }
                }
            });
            if database.owner_transaction_outcome_unknown() {
                session_unknown_on_owner.store(1, Ordering::SeqCst);
            }
            match result {
                Ok(()) => Ok(()),
                Err(RawStreamError::Database(error)) => Err(error),
                Err(RawStreamError::Callback(error)) => {
                    callback_recovered_on_owner.store(1, Ordering::SeqCst);
                    Err(error)
                }
                Err(RawStreamError::CallbackPanicked(error)) => {
                    callback_panicked_on_owner.store(1, Ordering::SeqCst);
                    Err(error)
                }
            }
        })
        .await;

    resolve_owner_stream_outcome(
        outcome,
        &callback_error,
        callback_recovered.load(Ordering::SeqCst) == 1,
        callback_panicked.load(Ordering::SeqCst) == 1,
        session_unknown.load(Ordering::SeqCst) == 1,
    )
}

fn resolve_owner_stream_outcome<E>(
    outcome: Result<()>,
    callback_error: &Mutex<Option<E>>,
    callback_recovered: bool,
    callback_panicked: bool,
    session_unknown: bool,
) -> RawStreamResult<(), E> {
    if session_unknown {
        return Err(RawStreamError::Database(outcome.err().unwrap_or_else(
            || Error::message("WASIX protocol recovery was lost without its error"),
        )));
    }
    if callback_recovered {
        let callback_error = callback_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        return match callback_error {
            Some(error) => Err(RawStreamError::Callback(error)),
            None => Err(RawStreamError::Database(outcome.err().unwrap_or_else(
                || Error::message("WASIX protocol callback recovery lost its typed error"),
            ))),
        };
    }
    if callback_panicked {
        return Err(RawStreamError::CallbackPanicked(
            outcome
                .err()
                .unwrap_or_else(|| Error::message("WASIX protocol callback panic lost its error")),
        ));
    }
    outcome.map_err(RawStreamError::Database)
}

fn admit_close(
    state: &AtomicU8,
    current: &Mutex<Option<Arc<CloseAttempt>>>,
    owner: &'static str,
) -> Result<CloseAdmission> {
    match state.load(Ordering::SeqCst) {
        OWNER_OPEN => {
            let mut current = current
                .lock()
                .map_err(|_| Error::message(format!("{owner} close attempt lock poisoned")))?;
            if current.is_some() {
                return Err(Error::message(format!(
                    "{owner} has a close attempt while open"
                )));
            }
            let attempt = Arc::new(CloseAttempt::default());
            *current = Some(Arc::clone(&attempt));
            state.store(OWNER_CLOSING, Ordering::SeqCst);
            Ok(CloseAdmission::Start(attempt))
        }
        OWNER_CLOSING => {
            let attempt = current
                .lock()
                .map_err(|_| Error::message(format!("{owner} close attempt lock poisoned")))?
                .clone()
                .ok_or_else(|| Error::message(format!("{owner} lost its active close attempt")))?;
            Ok(CloseAdmission::Join(attempt))
        }
        OWNER_CLOSED => {
            let attempt = current
                .lock()
                .map_err(|_| Error::message(format!("{owner} close attempt lock poisoned")))?
                .clone();
            Ok(match attempt {
                Some(attempt) => CloseAdmission::Join(attempt),
                None => CloseAdmission::Closed,
            })
        }
        OWNER_STOPPED => Err(Error::lifecycle(format!("{owner} has stopped"))),
        _ => Err(Error::message(format!("{owner} has invalid state"))),
    }
}

fn complete_close_attempt_locked(
    state: &AtomicU8,
    current: &Mutex<Option<Arc<CloseAttempt>>>,
    attempt: &Arc<CloseAttempt>,
    result: SharedCloseResult,
    disposition: CloseDisposition,
) -> bool {
    let terminal = matches!(disposition, CloseDisposition::Terminal);
    state.store(
        if terminal { OWNER_CLOSED } else { OWNER_OPEN },
        Ordering::SeqCst,
    );
    attempt.complete(result);
    if !terminal {
        let mut current = current.lock().unwrap_or_else(|error| error.into_inner());
        if current
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, attempt))
        {
            current.take();
        }
    }
    terminal
}

fn complete_close_attempt(
    admission: &Mutex<()>,
    state: &AtomicU8,
    current: &Mutex<Option<Arc<CloseAttempt>>>,
    attempt: &Arc<CloseAttempt>,
    result: Result<()>,
    disposition: CloseDisposition,
) -> bool {
    let _admission = admission.lock().unwrap_or_else(|error| error.into_inner());
    complete_close_attempt_locked(state, current, attempt, result, disposition)
}

fn stop_close_owner(
    admission: &Mutex<()>,
    state: &AtomicU8,
    current: &Mutex<Option<Arc<CloseAttempt>>>,
    message: &'static str,
) {
    let _admission = admission.lock().unwrap_or_else(|error| error.into_inner());
    let attempt = current
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if let Some(attempt) = attempt {
        complete_close_attempt_locked(
            state,
            current,
            &attempt,
            Err(Error::message(message)),
            CloseDisposition::Terminal,
        );
    } else {
        state.store(OWNER_STOPPED, Ordering::SeqCst);
    }
}

fn complete_owner_shutdown(
    admission: &Mutex<()>,
    state: &AtomicU8,
    current: &Mutex<Option<Arc<CloseAttempt>>>,
    result: Result<()>,
) {
    let _admission = admission.lock().unwrap_or_else(|error| error.into_inner());
    let attempt = current
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if let Some(attempt) = attempt {
        complete_close_attempt_locked(state, current, &attempt, result, CloseDisposition::Terminal);
    } else {
        state.store(
            if result.is_ok() {
                OWNER_CLOSED
            } else {
                OWNER_STOPPED
            },
            Ordering::SeqCst,
        );
    }
}

fn run_database_owner(
    mut database: DirectOliphaunt,
    queue: Receiver<OwnerMessage>,
    state: &AtomicU8,
    admission: &Mutex<()>,
    close_attempt: &Mutex<Option<Arc<CloseAttempt>>>,
) {
    let mut active_transaction = None;
    loop {
        match queue.recv() {
            Ok(OwnerMessage {
                _permit,
                operation: OwnerOperation::Control(message),
            }) => {
                // Release bounded admission when the message leaves the queue,
                // before potentially long PostgreSQL work begins.
                drop(_permit);
                match message {
                    OwnerControl::Close { attempt } if active_transaction.is_none() => {
                        let result = database.close();
                        // Direct teardown ownership is released only on Ok;
                        // dropping after Err preserves its process-lifetime quarantine.
                        drop(database);
                        complete_close_attempt(
                            admission,
                            state,
                            close_attempt,
                            &attempt,
                            result,
                            CloseDisposition::Terminal,
                        );
                        return;
                    }
                    OwnerControl::Close { attempt } => {
                        complete_close_attempt(
                            admission,
                            state,
                            close_attempt,
                            &attempt,
                            Err(Error::transaction_active(
                                "cannot close while a transaction is active",
                            )),
                            CloseDisposition::Retryable,
                        );
                    }
                    OwnerControl::Shutdown => {
                        let _ = rollback_active(&mut database, &mut active_transaction);
                        let result = database.close();
                        // Direct teardown ownership is released only on Ok;
                        // dropping after Err preserves its process-lifetime quarantine.
                        drop(database);
                        complete_owner_shutdown(admission, state, close_attempt, result);
                        return;
                    }
                    message => {
                        handle_database_control(&mut database, message, &mut active_transaction);
                    }
                }
            }
            Ok(OwnerMessage {
                _permit,
                operation: OwnerOperation::Command(command),
            }) => {
                drop(_permit);
                let admission = match (command.transaction, active_transaction) {
                    (None, None) => Ok(()),
                    (None, Some(_)) => Err(Error::transaction_active(
                        "a callback transaction is active; use its transaction handle",
                    )),
                    (Some(expected), Some(active)) if expected == active => Ok(()),
                    (Some(_), _) => Err(Error::message("transaction is no longer active")),
                };
                (command.action)(&mut database, admission);
            }
            Err(_) => {
                let _ = rollback_active(&mut database, &mut active_transaction);
                let result = database.close();
                // Direct teardown ownership is released only on Ok; dropping
                // after Err preserves its process-lifetime quarantine.
                drop(database);
                complete_owner_shutdown(admission, state, close_attempt, result);
                return;
            }
        }
    }
}

fn handle_database_control(
    database: &mut DirectOliphaunt,
    message: OwnerControl,
    active_transaction: &mut Option<u64>,
) {
    match message {
        OwnerControl::Begin { token, reply } => {
            if reply.is_closed() {
                return;
            }
            let mut result = if active_transaction.is_some() {
                Err(Error::transaction_active("a transaction is already active"))
            } else {
                database.owner_begin_transaction()
            };
            if result.is_ok() {
                *active_transaction = Some(token);
            }
            if reply.send(result).is_err() && *active_transaction == Some(token) {
                result = database.owner_rollback_transaction();
                *active_transaction = None;
                if let Err(error) = result {
                    tracing::warn!(
                        "rollback after an abandoned WASIX transaction begin failed: {error:#}"
                    );
                }
            }
        }
        OwnerControl::Finish {
            token,
            commit,
            guard,
            reply,
        } => {
            if reply.is_closed() {
                abandon_unobserved_finish(database, active_transaction, token, &guard);
                return;
            }
            let outcome = if *active_transaction != Some(token) {
                let error = Error::message("transaction is no longer active");
                guard.retain_failure(error.clone(), false);
                TransactionFinishOutcome::NotAttempted(error)
            } else if database.owner_transaction_outcome_unknown() {
                let error = guard.retained_error();
                let _ = database.owner_abandon_unknown_transaction();
                guard.retain_failure(error.clone(), false);
                TransactionFinishOutcome::NotAttempted(error)
            } else if commit {
                let result = database.owner_commit_transaction();
                match &result {
                    Ok(()) => guard.state.store(TRANSACTION_COMMITTED, Ordering::SeqCst),
                    Err(error) => guard.retain_failure(error.clone(), false),
                }
                TransactionFinishOutcome::Attempted(result)
            } else {
                let result = database.owner_rollback_transaction();
                match &result {
                    Ok(()) => guard.state.store(TRANSACTION_ROLLED_BACK, Ordering::SeqCst),
                    Err(error) => guard.retain_failure(error.clone(), true),
                }
                TransactionFinishOutcome::Attempted(result)
            };
            if reply.send(outcome).is_err() {
                abandon_unobserved_finish(database, active_transaction, token, &guard);
            }
        }
        OwnerControl::FinishObserved { token } => {
            if *active_transaction == Some(token) {
                *active_transaction = None;
            }
        }
        OwnerControl::FinishAbandoned { token, guard } => {
            abandon_unobserved_finish(database, active_transaction, token, &guard);
        }
        OwnerControl::RollbackBestEffort { token, guard } => {
            if *active_transaction == Some(token) {
                if database.owner_transaction_outcome_unknown() {
                    let error = guard.retained_error();
                    let _ = database.owner_abandon_unknown_transaction();
                    guard.retain_failure(error, false);
                } else {
                    match database.owner_rollback_transaction() {
                        Ok(()) => guard.state.store(TRANSACTION_ROLLED_BACK, Ordering::SeqCst),
                        Err(error) => guard.retain_failure(error, true),
                    }
                }
                *active_transaction = None;
            }
        }
        OwnerControl::AbandonFailed { token, reply } => {
            let result = if *active_transaction == Some(token) {
                database.owner_abandon_unknown_transaction()
            } else {
                Err(Error::message("transaction is no longer active"))
            };
            if *active_transaction == Some(token) {
                *active_transaction = None;
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }
        OwnerControl::Close { .. } | OwnerControl::Shutdown => {
            unreachable!("lifecycle controls are handled by the owner loop")
        }
    }
}

fn abandon_unobserved_finish(
    database: &mut DirectOliphaunt,
    active_transaction: &mut Option<u64>,
    token: u64,
    guard: &TransactionOutcomeGuard,
) {
    if *active_transaction != Some(token) {
        return;
    }
    let error = Error::message(
        "transaction settlement completed without being observed; close the database",
    );
    database.owner_poison_unobserved_transaction_settlement();
    guard.retain_failure(error, false);
    *active_transaction = None;
}

fn rollback_active(
    database: &mut DirectOliphaunt,
    active_transaction: &mut Option<u64>,
) -> Result<()> {
    if active_transaction.take().is_some() {
        database.owner_rollback_transaction()
    } else {
        Ok(())
    }
}

/// Asynchronous, owner-thread AsyncOliphaunt WASIX database handle.
///
/// Every clone refers to the same serialized PostgreSQL session. The Wasmer
/// store is constructed and remains on the package-owned thread.
#[derive(Clone)]
pub struct AsyncOliphaunt {
    owner: DatabaseOwner,
}

impl AsyncOliphaunt {
    /// Build an asynchronous WASIX database. The default storage is memory.
    pub fn builder() -> AsyncOliphauntBuilder {
        AsyncOliphauntBuilder::new()
    }

    /// Open an in-memory database on a newly owned thread.
    pub async fn open() -> Result<Self> {
        Self::builder().open().await
    }

    /// Restore a validated physical backup without blocking the caller's executor thread.
    pub async fn restore(destination: impl Into<PathBuf>, backup: impl AsRef<[u8]>) -> Result<()> {
        let destination = destination.into();
        let backup = backup.as_ref().to_vec();
        run_owned("oliphaunt-wasix-restore", move || {
            DirectOliphaunt::restore(destination, backup)
        })
        .await
    }

    /// Build a typed, fluent PostgreSQL statement.
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> AsyncSql<'db, 'q> {
        AsyncSql::database(self, sql)
    }

    /// Whether the database is permanently retired.
    ///
    /// This becomes `true` after terminal shutdown settles, even if cleanup
    /// reports an error, and when the owner stops unexpectedly. A close attempt
    /// which can still fail validation and reopen admission is not terminal.
    pub fn is_closed(&self) -> bool {
        self.owner.is_closed()
    }

    /// Execute exactly one PostgreSQL statement through the extended-query protocol.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute exactly one PostgreSQL statement with positional parameters.
    pub async fn execute_with_params<I, P>(&self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.execute().await
    }

    /// Execute one PostgreSQL statement and return its row-shaped result.
    ///
    /// Command-only SQL is accepted as an empty row set with its command tag
    /// and affected-row count retained.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query().await
    }

    /// Execute one parameterized statement and return its row-shaped result.
    ///
    /// Command-only SQL is accepted as an empty row set.
    pub async fn query_with_params<I, P>(&self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.query().await
    }

    /// Execute possibly multi-statement SQL through PostgreSQL's simple-query protocol.
    pub async fn exec(&self, sql: &str) -> Result<ExecResult> {
        let sql = sql.to_owned();
        self.owner
            .call(None, move |database| database.exec(&sql))
            .await
    }

    /// Parse and describe a statement without executing it.
    pub async fn describe(&self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Execute raw PostgreSQL frontend-protocol bytes and buffer the response.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        let request = request.as_ref().to_vec();
        self.owner
            .call(None, move |database| database.exec_protocol_raw(request))
            .await
    }

    /// Execute raw protocol bytes and synchronously receive bounded chunks on the owner thread.
    ///
    /// The callback and values it retains must be owned, `Send + 'static`; use
    /// `Arc<Mutex<_>>` when mutable state must outlive the call site. Each
    /// callback invocation finishes synchronously on the owner before the next
    /// chunk is pumped and before this future resolves.
    ///
    /// The callback must not await reentrant work on this database. A typed
    /// callback failure is returned as [`RawStreamError::Callback`] only after
    /// the guest pump confirms recovery; an independent pump failure is
    /// authoritative, is returned as [`RawStreamError::Database`], and poisons
    /// the session until close. A callback panic after confirmed recovery is
    /// [`RawStreamError::CallbackPanicked`] and leaves the session reusable.
    pub async fn exec_protocol_raw_stream<F, O>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> RawStreamResult<(), O::Error>
    where
        F: FnMut(&[u8]) -> O + Send + 'static,
        O: RawStreamCallbackOutput,
        O::Error: Send + 'static,
    {
        let request = request.as_ref().to_vec();
        exec_protocol_raw_stream_on_owner(&self.owner, request, on_chunk).await
    }

    /// Run an async callback in a transaction pinned to this physical session.
    ///
    /// Success commits, callback failure rolls back, and an explicit
    /// [`AsyncTransaction::rollback`] suppresses the later commit. Unpinned work on
    /// this database is rejected while the callback is active.
    /// The callback returns ordinary `Result<T, E>` with `E: From<Error>`;
    /// [`TransactionError`] keeps business, rollback, and independent database
    /// failures distinct.
    pub async fn transaction<T, E>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx mut AsyncTransaction) -> std::result::Result<T, E>,
    ) -> TransactionResult<T, E>
    where
        E: From<Error>,
    {
        let token = self
            .owner
            .begin_transaction()
            .await
            .map_err(TransactionError::Database)?;
        let mut transaction = AsyncTransaction::new(self.owner.clone(), token);
        let callback = body(&mut transaction).await;
        transaction.settle(callback).await
    }

    /// Create a session-preserving PostgreSQL online physical backup.
    pub async fn backup(&self) -> Result<Vec<u8>> {
        self.owner.call(None, DirectOliphaunt::backup).await
    }

    /// Run packaged `pg_dump` against this database on its owner thread.
    #[cfg(feature = "tools")]
    pub async fn pg_dump(&self, options: crate::oliphaunt::tools::PgDumpOptions) -> Result<String> {
        self.owner
            .call(None, move |database| {
                crate::error::public_result(database.run_pg_dump_tool(options))
            })
            .await
    }

    /// Run packaged non-interactive `psql` against this database on its owner thread.
    #[cfg(feature = "tools")]
    pub async fn psql(&self, options: crate::oliphaunt::tools::PsqlOptions) -> Result<String> {
        self.owner
            .call(None, move |database| {
                crate::error::public_result(database.run_psql_tool(options))
            })
            .await
    }

    /// Close the shared database and wait for PostgreSQL cleanup.
    ///
    /// Closing any clone closes the common session. Dropping the last clone
    /// initiates best-effort cleanup without joining the owner thread.
    /// Concurrent callers await the exact same attempt and receive the same
    /// success or failure. Validation before shutdown (for example, an active
    /// transaction) leaves the database open and may be retried. Once shutdown
    /// begins, the database is permanently retired and every later close
    /// replays that attempt's exact result. Successful teardown releases the
    /// backend and storage root; failed teardown retains that ownership until
    /// process exit.
    pub async fn close(&self) -> Result<()> {
        self.owner.close().await
    }
}

/// Builder for an owner-thread [`AsyncOliphaunt`] database.
#[derive(Debug, Clone)]
pub struct AsyncOliphauntBuilder {
    inner: DirectOliphauntBuilder,
}

impl Default for AsyncOliphauntBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AsyncOliphauntBuilder {
    /// Create a builder for an in-memory database.
    pub fn new() -> Self {
        Self {
            inner: DirectOliphauntBuilder::new(),
        }
    }

    /// Select memory or managed-directory storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.inner = self.inner.storage(storage);
        self
    }

    /// Set one PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner = self.inner.startup_guc(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs.
    pub fn startup_gucs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        self.inner = self.inner.startup_gucs(settings);
        self
    }

    /// Connect as an existing PostgreSQL role.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.inner = self.inner.username(username);
        self
    }

    /// Connect to an existing PostgreSQL database.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.inner = self.inner.database(database);
        self
    }

    #[cfg(feature = "extensions")]
    /// Make one bundled PostgreSQL extension artifact available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    #[cfg(feature = "extensions")]
    /// Make bundled PostgreSQL extension artifacts available to the database.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Construct the Wasmer runtime and PostgreSQL session on its permanent owner thread.
    pub async fn open(self) -> Result<AsyncOliphaunt> {
        Ok(AsyncOliphaunt {
            owner: DatabaseOwner::open(self.inner).await?,
        })
    }
}

enum SqlOwner<'a> {
    Database(&'a AsyncOliphaunt),
    AsyncTransaction(&'a mut AsyncTransaction),
}

/// Fluent asynchronous SQL statement bound to a database or transaction.
#[must_use = "a SQL statement does nothing until execute(), query(), or describe() is awaited"]
pub struct AsyncSql<'db, 'q> {
    owner: SqlOwner<'db>,
    sql: Cow<'q, str>,
    params: Vec<Parameter>,
    result_format: ValueFormat,
}

impl<'db, 'q> AsyncSql<'db, 'q> {
    fn database(database: &'db AsyncOliphaunt, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            owner: SqlOwner::Database(database),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    fn transaction(transaction: &'db mut AsyncTransaction, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            owner: SqlOwner::AsyncTransaction(transaction),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    /// Append one positional PostgreSQL parameter.
    pub fn bind(mut self, value: impl IntoParameter) -> Self {
        self.params.push(value.into_parameter());
        self
    }

    /// Append a pre-serialized positional PostgreSQL parameter.
    pub fn bind_parameter(mut self, value: Parameter) -> Self {
        self.params.push(value);
        self
    }

    /// Select text or binary format for returned columns.
    pub fn result_format(mut self, format: ValueFormat) -> Self {
        self.result_format = format;
        self
    }

    /// Execute this statement as a command.
    pub async fn execute(self) -> Result<CommandResult> {
        let sql = self.sql.into_owned();
        let params = self.params;
        let format = self.result_format;
        match self.owner {
            SqlOwner::Database(database) => {
                database
                    .owner
                    .call(None, move |owner| owner.owner_execute(&sql, params, format))
                    .await
            }
            SqlOwner::AsyncTransaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call_transaction(token, Arc::clone(&transaction.guard), move |owner| {
                        owner.owner_transaction_execute(&sql, params, format)
                    })
                    .await
            }
        }
    }

    /// Execute this statement and return its row-shaped result.
    ///
    /// A command-only statement produces empty fields and rows while retaining
    /// its command tag and affected-row count.
    pub async fn query(self) -> Result<QueryResult> {
        let sql = self.sql.into_owned();
        let params = self.params;
        let format = self.result_format;
        match self.owner {
            SqlOwner::Database(database) => {
                database
                    .owner
                    .call(None, move |owner| owner.owner_query(&sql, params, format))
                    .await
            }
            SqlOwner::AsyncTransaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call_transaction(token, Arc::clone(&transaction.guard), move |owner| {
                        owner.owner_transaction_query(&sql, params, format)
                    })
                    .await
            }
        }
    }

    /// Describe this statement without executing it.
    pub async fn describe(self) -> Result<StatementDescription> {
        let sql = self.sql.into_owned();
        let params = self.params;
        match self.owner {
            SqlOwner::Database(database) => {
                database
                    .owner
                    .call(None, move |owner| owner.owner_describe(&sql, params))
                    .await
            }
            SqlOwner::AsyncTransaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call_transaction(token, Arc::clone(&transaction.guard), move |owner| {
                        owner.owner_transaction_describe(&sql, params)
                    })
                    .await
            }
        }
    }
}

/// Callback-scoped asynchronous transaction pinned to the owner session.
pub struct AsyncTransaction {
    owner: DatabaseOwner,
    token: u64,
    guard: Arc<TransactionOutcomeGuard>,
    not_sync: PhantomData<Cell<()>>,
}

impl AsyncTransaction {
    fn new(owner: DatabaseOwner, token: u64) -> Self {
        Self {
            owner,
            token,
            guard: TransactionOutcomeGuard::active(),
            not_sync: PhantomData,
        }
    }

    /// Build a typed, fluent statement pinned to this transaction.
    pub fn sql<'db, 'q>(&'db mut self, sql: impl Into<Cow<'q, str>>) -> AsyncSql<'db, 'q> {
        AsyncSql::transaction(self, sql)
    }

    /// Whether the transaction handle has rolled back or begun settlement.
    pub fn is_closed(&self) -> bool {
        self.guard.state.load(Ordering::SeqCst) != TRANSACTION_ACTIVE
    }

    fn ensure_active(&self) -> Result<()> {
        if self.guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE {
            Ok(())
        } else {
            Err(Error::message("transaction is no longer active"))
        }
    }

    /// Execute exactly one command inside this transaction.
    pub async fn execute(&mut self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute one parameterized command inside this transaction.
    pub async fn execute_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<CommandResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.execute().await
    }

    /// Execute one statement and return its row-shaped result.
    ///
    /// Command-only SQL is accepted as an empty row set.
    pub async fn query(&mut self, sql: &str) -> Result<QueryResult> {
        self.sql(sql).query().await
    }

    /// Execute one parameterized statement and return its row-shaped result.
    ///
    /// Command-only SQL is accepted as an empty row set.
    pub async fn query_with_params<I, P>(&mut self, sql: &str, params: I) -> Result<QueryResult>
    where
        I: IntoIterator<Item = P>,
        P: IntoParameter,
    {
        let statement = params
            .into_iter()
            .fold(self.sql(sql), |statement, value| statement.bind(value));
        statement.query().await
    }

    /// Execute possibly multi-statement SQL inside this transaction.
    pub async fn exec(&mut self, sql: &str) -> Result<ExecResult> {
        self.ensure_active()?;
        let sql = sql.to_owned();
        let token = self.token;
        self.owner
            .call_transaction(token, Arc::clone(&self.guard), move |database| {
                database.owner_transaction_exec(&sql)
            })
            .await
    }

    /// Describe a statement inside this transaction without executing it.
    pub async fn describe(&mut self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Roll back immediately and expire this transaction handle.
    pub async fn rollback(&mut self) -> Result<()> {
        self.finish(false).await
    }

    async fn finish(&mut self, commit: bool) -> Result<()> {
        self.guard
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| Error::message("transaction is no longer active"))?;
        self.guard.settlement_started.store(1, Ordering::SeqCst);
        match self
            .owner
            .finish_transaction(self.token, commit, Arc::clone(&self.guard))
            .await
        {
            Ok(TransactionFinishOutcome::Attempted(result)) => result,
            Ok(TransactionFinishOutcome::NotAttempted(error)) | Err(error) => {
                self.retain_failure(error.clone());
                Err(error)
            }
        }
    }

    async fn settle<T, E>(
        &mut self,
        callback: std::result::Result<T, E>,
    ) -> TransactionResult<T, E> {
        match (self.guard.state.load(Ordering::SeqCst), callback) {
            (TRANSACTION_ACTIVE, Ok(value)) => {
                self.finish(true)
                    .await
                    .map_err(TransactionError::Database)?;
                Ok(value)
            }
            (TRANSACTION_ACTIVE, Err(callback)) => match self.finish(false).await {
                Ok(()) => Err(TransactionError::Callback(callback)),
                Err(database)
                    if self
                        .guard
                        .terminal_failure_was_rollback
                        .load(Ordering::SeqCst)
                        == 0 =>
                {
                    Err(TransactionError::CallbackAndDatabase { callback, database })
                }
                Err(rollback) => Err(TransactionError::CallbackAndRollback { callback, rollback }),
            },
            (TRANSACTION_ROLLED_BACK, callback) => callback.map_err(TransactionError::Callback),
            (TRANSACTION_FAILED, Ok(_)) => {
                let error = self.retained_error();
                self.retire_failed_owner_transaction().await;
                Err(TransactionError::Database(error))
            }
            (TRANSACTION_FAILED, Err(callback)) => {
                let database = self.retained_error();
                let rollback_was_attempted = self
                    .guard
                    .terminal_failure_was_rollback
                    .load(Ordering::SeqCst)
                    == 1;
                self.retire_failed_owner_transaction().await;
                if rollback_was_attempted {
                    Err(TransactionError::CallbackAndRollback {
                        callback,
                        rollback: database,
                    })
                } else {
                    Err(TransactionError::CallbackAndDatabase { callback, database })
                }
            }
            (_, _) => Err(TransactionError::Database(Error::message(
                "transaction settlement did not reach a valid terminal state",
            ))),
        }
    }

    fn retained_error(&self) -> Error {
        self.guard.retained_error()
    }

    fn retain_failure(&self, error: Error) {
        self.retain_failure_with_kind(error, false);
    }

    fn retain_failure_with_kind(&self, error: Error, rollback_was_attempted: bool) {
        self.guard.retain_failure(error, rollback_was_attempted);
    }

    async fn retire_failed_owner_transaction(&mut self) {
        // This owner control deliberately emits no PostgreSQL bytes. It clears
        // only host-side ownership after a proven unknown protocol boundary.
        let _ = self.owner.abandon_failed_transaction(self.token).await;
    }
}

impl Drop for AsyncTransaction {
    fn drop(&mut self) {
        if self.guard.settlement_started.load(Ordering::SeqCst) == 1
            && self.guard.settlement_observed.load(Ordering::SeqCst) == 0
        {
            self.owner
                .abandon_unobserved_finish(self.token, Arc::clone(&self.guard));
            return;
        }
        match claim_transaction_for_drop(&self.guard.state) {
            TransactionDropAction::Rollback => self
                .owner
                .rollback_best_effort(self.token, Arc::clone(&self.guard)),
            TransactionDropAction::AbandonFailed => {
                self.owner.abandon_failed_best_effort(self.token);
            }
            TransactionDropAction::None => {}
        }
    }
}

async fn run_owned<T, F>(name: &'static str, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let (reply, receiver) = oneshot::channel();
    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
                .map_err(|_| Error::message(format!("{name} thread panicked")))
                .and_then(|result| result);
            let _ = reply.send(result);
        })
        .map_err(|error| Error::message(format!("spawn {name}: {error}")))?;
    receiver
        .await
        .map_err(|_| Error::lifecycle(format!("{name} stopped before returning a result")))?
}

#[derive(Debug)]
struct ServerInfo {
    connection_string: String,
}

enum ServerControl {
    Close { attempt: Arc<CloseAttempt> },
    Shutdown,
}

struct ServerOwnerInner {
    control: mpsc::Sender<ServerControl>,
    admission: Arc<Mutex<()>>,
    state: Arc<AtomicU8>,
    close_attempt: Arc<Mutex<Option<Arc<CloseAttempt>>>>,
}

impl Drop for ServerOwnerInner {
    fn drop(&mut self) {
        let _admission = self.admission.lock().ok();
        let _ = self.control.send(ServerControl::Shutdown);
    }
}

/// Asynchronous handle for a local PostgreSQL wire server.
#[derive(Clone)]
pub struct AsyncOliphauntServer {
    owner: Arc<ServerOwnerInner>,
    info: Arc<ServerInfo>,
}

impl AsyncOliphauntServer {
    /// Build an asynchronous local PostgreSQL server.
    pub fn builder() -> AsyncOliphauntServerBuilder {
        AsyncOliphauntServerBuilder::new()
    }

    /// Return the standard PostgreSQL connection string.
    pub fn connection_string(&self) -> &str {
        &self.info.connection_string
    }

    /// Whether the server is permanently retired.
    ///
    /// This includes both a settled terminal close attempt and an unexpectedly
    /// stopped owner. A close attempt still in progress is not yet terminal.
    /// This is not an endpoint health check: `false` does not poll the proxy
    /// listener or prove that the published endpoint is reachable.
    pub fn is_closed(&self) -> bool {
        owner_is_terminal(&self.owner.state)
    }

    /// Stop the local server without blocking the calling executor thread.
    ///
    /// Concurrent callers await the exact same attempt and receive the same
    /// success or failure. Once server stop begins, the server is permanently
    /// retired and every later close replays that attempt's exact result.
    /// Successful teardown releases the managed root; failed teardown retains
    /// it until process exit.
    pub async fn close(&self) -> Result<()> {
        let attempt = {
            let _admission = self
                .owner
                .admission
                .lock()
                .map_err(|_| Error::message("WASIX server owner admission lock poisoned"))?;
            match admit_close(
                &self.owner.state,
                &self.owner.close_attempt,
                "WASIX server owner",
            )? {
                CloseAdmission::Closed => return Ok(()),
                CloseAdmission::Join(attempt) => attempt,
                CloseAdmission::Start(attempt) => {
                    if self
                        .owner
                        .control
                        .send(ServerControl::Close {
                            attempt: Arc::clone(&attempt),
                        })
                        .is_err()
                    {
                        complete_close_attempt_locked(
                            &self.owner.state,
                            &self.owner.close_attempt,
                            &attempt,
                            Err(Error::lifecycle("WASIX server owner has stopped")),
                            CloseDisposition::Terminal,
                        );
                    }
                    attempt
                }
            }
        };
        attempt.wait("WASIX server owner").await
    }
}

/// Builder for an asynchronous local PostgreSQL wire server.
#[derive(Debug, Clone)]
pub struct AsyncOliphauntServerBuilder {
    inner: DirectOliphauntServerBuilder,
}

impl Default for AsyncOliphauntServerBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AsyncOliphauntServerBuilder {
    /// Create a memory-backed server builder listening on loopback TCP.
    pub fn new() -> Self {
        Self {
            inner: DirectOliphauntServerBuilder::new(),
        }
    }

    /// Select memory or managed-directory storage.
    pub fn storage(mut self, storage: DatabaseStorage) -> Self {
        self.inner = self.inner.storage(storage);
        self
    }

    /// Select loopback TCP on any supported host or a PostgreSQL Unix-domain
    /// socket on a Unix host.
    pub fn listen(mut self, listen: ServerListen) -> Self {
        self.inner = self.inner.listen(listen);
        self
    }

    /// Set one PostgreSQL startup GUC.
    pub fn startup_guc(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner = self.inner.startup_guc(name, value);
        self
    }

    /// Set multiple PostgreSQL startup GUCs.
    pub fn startup_gucs<K, V>(mut self, settings: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        self.inner = self.inner.startup_gucs(settings);
        self
    }

    /// Set the default role encoded in the connection string.
    pub fn username(mut self, username: impl Into<String>) -> Self {
        self.inner = self.inner.username(username);
        self
    }

    /// Set the default database encoded in the connection string.
    pub fn database(mut self, database: impl Into<String>) -> Self {
        self.inner = self.inner.database(database);
        self
    }

    #[cfg(feature = "extensions")]
    /// Make one bundled PostgreSQL extension artifact available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    #[cfg(feature = "extensions")]
    /// Make bundled PostgreSQL extension artifacts available to clients.
    /// Database-local installation remains the application's migration concern.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Start the server and await its bound endpoint.
    pub async fn start(self) -> Result<AsyncOliphauntServer> {
        let (control, receiver) = mpsc::channel();
        let (open_tx, open_rx) = oneshot::channel();
        let state = Arc::new(AtomicU8::new(OWNER_OPEN));
        let admission = Arc::new(Mutex::new(()));
        let close_attempt = Arc::new(Mutex::new(None));
        let thread_state = Arc::clone(&state);
        let thread_admission = Arc::clone(&admission);
        let thread_close_attempt = Arc::clone(&close_attempt);
        thread::Builder::new()
            .name("oliphaunt-wasix-server-owner".to_owned())
            .spawn(move || {
                let opened =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.inner.start()));
                let server = match opened {
                    Ok(Ok(server)) => server,
                    Ok(Err(error)) => {
                        let _ = open_tx.send(Err(error));
                        thread_state.store(OWNER_STOPPED, Ordering::SeqCst);
                        return;
                    }
                    Err(_) => {
                        let _ = open_tx.send(Err(Error::message(
                            "WASIX server owner panicked while starting PostgreSQL",
                        )));
                        thread_state.store(OWNER_STOPPED, Ordering::SeqCst);
                        return;
                    }
                };
                let info = ServerInfo {
                    connection_string: server.connection_string().to_owned(),
                };
                if open_tx.send(Ok(info)).is_err() {
                    drop(server);
                    thread_state.store(OWNER_CLOSED, Ordering::SeqCst);
                    return;
                }
                let owner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_server_owner(
                        server,
                        receiver,
                        &thread_state,
                        &thread_admission,
                        &thread_close_attempt,
                    )
                }));
                if owner.is_err() {
                    stop_close_owner(
                        &thread_admission,
                        &thread_state,
                        &thread_close_attempt,
                        "WASIX server owner panicked while closing",
                    );
                }
            })
            .map_err(|error| Error::message(format!("spawn WASIX server owner: {error}")))?;
        let info = open_rx
            .await
            .map_err(|_| Error::lifecycle("WASIX server owner stopped before start completed"))??;
        Ok(AsyncOliphauntServer {
            owner: Arc::new(ServerOwnerInner {
                control,
                admission,
                state,
                close_attempt,
            }),
            info: Arc::new(info),
        })
    }
}

fn run_server_owner(
    mut server: DirectOliphauntServer,
    receiver: Receiver<ServerControl>,
    state: &AtomicU8,
    admission: &Mutex<()>,
    close_attempt: &Mutex<Option<Arc<CloseAttempt>>>,
) {
    match receiver.recv() {
        Ok(ServerControl::Close { attempt }) => {
            let result = server.owner_close();
            // The direct server releases its root only on Ok; dropping after
            // Err preserves its process-lifetime quarantine.
            drop(server);
            complete_close_attempt(
                admission,
                state,
                close_attempt,
                &attempt,
                result,
                CloseDisposition::Terminal,
            );
        }
        Ok(ServerControl::Shutdown) | Err(_) => {
            let result = server.owner_close();
            // The direct server releases its root only on Ok; dropping after
            // Err preserves its process-lifetime quarantine.
            drop(server);
            complete_owner_shutdown(admission, state, close_attempt, result);
        }
    }
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_send<T: Send>() {}
    assert_send_sync::<AsyncOliphaunt>();
    assert_send_sync::<AsyncOliphauntServer>();
    assert_send::<AsyncTransaction>();
};

#[cfg(test)]
mod raw_stream_outcome_tests {
    use super::*;

    #[test]
    fn recovered_typed_callback_error_remains_distinct_from_database_failure() {
        let callback = Mutex::new(Some("typed parser abort"));
        let result = resolve_owner_stream_outcome(
            Err(Error::message("callback sentinel")),
            &callback,
            true,
            false,
            false,
        );
        let error = result.expect_err("typed callback abort is returned");
        assert_eq!(error.callback_error(), Some(&"typed parser abort"));
        assert!(error.database_error().is_none());
    }

    #[test]
    fn recovered_owner_callback_panic_is_typed_and_does_not_retire_the_session() {
        let callback = Mutex::new(None::<()>);
        let result = resolve_owner_stream_outcome(
            Err(Error::message("WASIX protocol callback panicked")),
            &callback,
            false,
            true,
            false,
        );
        let error = result.expect_err("callback panic is returned");
        assert_eq!(
            error
                .callback_panic_error()
                .map(ToString::to_string)
                .as_deref(),
            Some("WASIX protocol callback panicked")
        );
        assert!(error.database_error().is_none());
    }

    #[test]
    fn failed_recovery_overrides_callback_error_and_panic_classification() {
        let callback = Mutex::new(Some("typed parser abort"));
        let result = resolve_owner_stream_outcome(
            Err(Error::message("pump failed before ReadyForQuery")),
            &callback,
            true,
            true,
            true,
        );
        let error = result.expect_err("recovery failure is authoritative");
        assert_eq!(
            error.database_error().map(ToString::to_string).as_deref(),
            Some("pump failed before ReadyForQuery")
        );
        assert!(error.callback_error().is_none());
        assert!(error.callback_panic_error().is_none());
    }
}

#[cfg(test)]
mod close_tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    use std::time::Duration;

    use super::*;
    use crate::oliphaunt::base::DirectoryLock;
    use crate::oliphaunt::server::server_with_worker_result_for_test;

    fn poll_once<F: Future>(future: std::pin::Pin<&mut F>) -> Poll<F::Output> {
        let mut context = Context::from_waker(Waker::noop());
        future.poll(&mut context)
    }

    fn detached_owner(
        capacity: usize,
        owner_thread: thread::ThreadId,
    ) -> (DatabaseOwner, mpsc::Receiver<OwnerMessage>) {
        let (queue, receiver) = mpsc::channel();
        (
            DatabaseOwner {
                inner: Arc::new(DatabaseOwnerInner {
                    queue,
                    admission: Arc::new(Mutex::new(())),
                    ordinary_order: Arc::new(AsyncMutex::new(())),
                    ordinary_capacity: Arc::new(Semaphore::new(capacity)),
                    state: Arc::new(AtomicU8::new(OWNER_OPEN)),
                    close_epoch: AtomicU64::new(0),
                    close_attempt: Arc::new(Mutex::new(None)),
                    owner_thread,
                    next_transaction: AtomicU64::new(1),
                }),
            },
            receiver,
        )
    }

    fn begin_operation(token: u64) -> OwnerOperation {
        let (reply, _receiver) = oneshot::channel();
        OwnerOperation::Control(OwnerControl::Begin { token, reply })
    }

    fn begin_token(message: OwnerMessage) -> u64 {
        match message.operation {
            OwnerOperation::Control(OwnerControl::Begin { token, .. }) => token,
            _ => panic!("expected transaction-begin admission probe"),
        }
    }

    #[test]
    fn failed_transaction_settlement_abandons_host_ownership_without_rollback_control() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut transaction = AsyncTransaction::new(owner, 77);
        transaction.retain_failure(Error::message("raw stream recovery failed"));
        assert!(transaction.is_closed());

        let mut settlement =
            Box::pin(transaction.settle(Err::<(), Error>(Error::message("business abort"))));
        assert!(poll_once(settlement.as_mut()).is_pending());
        let message = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("failed transaction retirement reaches its owner");
        let reply = match message.operation {
            OwnerOperation::Control(OwnerControl::AbandonFailed {
                token: 77,
                reply: Some(reply),
            }) => reply,
            OwnerOperation::Control(OwnerControl::Finish { .. }) => {
                panic!("unknown raw state must not request COMMIT or ROLLBACK")
            }
            _ => panic!("expected host-only failed transaction retirement"),
        };
        reply.send(Ok(())).expect("settlement future is waiting");
        let Poll::Ready(result) = poll_once(settlement.as_mut()) else {
            panic!("host-only retirement completion resolves settlement");
        };
        let error = result.expect_err("callback and independent database failure remain visible");
        assert_eq!(
            error.callback_error().map(ToString::to_string).as_deref(),
            Some("business abort")
        );
        assert_eq!(
            error.database_error().map(ToString::to_string).as_deref(),
            Some("raw stream recovery failed")
        );
        assert!(error.rollback_error().is_none());
    }

    #[test]
    fn drop_claim_uses_the_state_observed_by_compare_exchange() {
        let state = AtomicU8::new(TRANSACTION_ACTIVE);
        state.store(TRANSACTION_FAILED, Ordering::SeqCst);

        assert_eq!(
            claim_transaction_for_drop(&state),
            TransactionDropAction::AbandonFailed
        );
        assert_eq!(state.load(Ordering::SeqCst), TRANSACTION_FAILED);
    }

    #[test]
    fn dropping_a_failed_transaction_enqueues_only_host_retirement() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let transaction = AsyncTransaction::new(owner.clone(), 78);
        transaction.retain_failure(Error::message("raw stream recovery failed"));
        drop(transaction);

        let message = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("failed transaction retirement reaches its owner");
        assert!(matches!(
            message.operation,
            OwnerOperation::Control(OwnerControl::AbandonFailed {
                token: 78,
                reply: None
            })
        ));
        assert!(receiver.try_recv().is_err());
        drop(owner);
    }

    #[test]
    fn dropping_an_unobserved_finish_enqueues_close_only_retirement() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let transaction = AsyncTransaction::new(owner.clone(), 91);
        transaction
            .guard
            .state
            .store(TRANSACTION_FINISHING, Ordering::SeqCst);
        transaction
            .guard
            .settlement_started
            .store(1, Ordering::SeqCst);
        drop(transaction);

        let message = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("unobserved settlement reaches its owner");
        assert!(matches!(
            message.operation,
            OwnerOperation::Control(OwnerControl::FinishAbandoned { token: 91, .. })
        ));
        drop(owner);
    }

    #[test]
    fn observed_finish_does_not_enqueue_abandonment() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let transaction = AsyncTransaction::new(owner.clone(), 92);
        transaction
            .guard
            .state
            .store(TRANSACTION_COMMITTED, Ordering::SeqCst);
        transaction
            .guard
            .settlement_started
            .store(1, Ordering::SeqCst);
        transaction
            .guard
            .settlement_observed
            .store(1, Ordering::SeqCst);
        drop(transaction);

        assert!(receiver.try_recv().is_err());
        drop(owner);
    }

    #[test]
    fn ordinary_admission_waits_at_capacity_and_preserves_fifo() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut first = Box::pin(owner.enqueue_ordinary(begin_operation(1)));
        let mut second = Box::pin(owner.enqueue_ordinary(begin_operation(2)));
        let mut third = Box::pin(owner.enqueue_ordinary(begin_operation(3)));

        assert!(matches!(poll_once(first.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(second.as_mut()).is_pending());
        assert!(poll_once(third.as_mut()).is_pending());
        assert_eq!(
            begin_token(receiver.recv().expect("first admitted message")),
            1
        );

        assert!(matches!(poll_once(second.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(third.as_mut()).is_pending());
        assert_eq!(
            begin_token(receiver.recv().expect("second admitted message")),
            2
        );

        assert!(matches!(poll_once(third.as_mut()), Poll::Ready(Ok(()))));
        assert_eq!(
            begin_token(receiver.recv().expect("third admitted message")),
            3
        );
    }

    #[test]
    fn cancelled_capacity_waiter_never_enters_the_owner_queue() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut first = Box::pin(owner.enqueue_ordinary(begin_operation(1)));
        let mut cancelled = Box::pin(owner.enqueue_ordinary(begin_operation(2)));
        let mut next = Box::pin(owner.enqueue_ordinary(begin_operation(3)));

        assert!(matches!(poll_once(first.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(cancelled.as_mut()).is_pending());
        assert!(poll_once(next.as_mut()).is_pending());
        drop(cancelled);
        assert_eq!(
            begin_token(receiver.recv().expect("first admitted message")),
            1
        );
        assert!(matches!(poll_once(next.as_mut()), Poll::Ready(Ok(()))));
        assert_eq!(
            begin_token(receiver.recv().expect("next admitted message")),
            3
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn owner_stop_drops_queued_permits_and_wakes_capacity_waiters() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut admitted = Box::pin(owner.enqueue_ordinary(begin_operation(1)));
        let mut first_waiter = Box::pin(owner.enqueue_ordinary(begin_operation(2)));
        let mut second_waiter = Box::pin(owner.enqueue_ordinary(begin_operation(3)));

        assert!(matches!(poll_once(admitted.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(first_waiter.as_mut()).is_pending());
        assert!(poll_once(second_waiter.as_mut()).is_pending());

        owner.inner.state.store(OWNER_STOPPED, Ordering::SeqCst);
        drop(receiver);

        for waiter in [&mut first_waiter, &mut second_waiter] {
            let Poll::Ready(result) = poll_once(waiter.as_mut()) else {
                panic!("owner stop must wake every capacity waiter");
            };
            assert_eq!(
                result
                    .expect_err("stopped owner rejects waiter")
                    .to_string(),
                "WASIX database owner has stopped"
            );
        }
        assert_eq!(owner.inner.ordinary_capacity.available_permits(), 1);
    }

    #[test]
    fn close_rejects_a_capacity_waiter_without_putting_it_after_close() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut admitted = Box::pin(owner.enqueue_ordinary(begin_operation(1)));
        let mut waiting = Box::pin(owner.enqueue_ordinary(begin_operation(2)));
        assert!(matches!(poll_once(admitted.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(waiting.as_mut()).is_pending());

        let mut close = Box::pin(owner.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert_eq!(
            begin_token(receiver.recv().expect("work admitted before close")),
            1
        );
        let close_message = receiver.recv().expect("close follows admitted work");
        assert!(matches!(
            close_message.operation,
            OwnerOperation::Control(OwnerControl::Close { .. })
        ));
        let Poll::Ready(result) = poll_once(waiting.as_mut()) else {
            panic!("capacity waiter must observe the close cutoff");
        };
        assert!(
            result
                .expect_err("waiter is rejected")
                .to_string()
                .contains("closing")
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn retryable_close_does_not_resurrect_a_pre_cutoff_waiter() {
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let (owner, receiver) = detached_owner(1, owner_thread);
        let mut admitted = Box::pin(owner.enqueue_ordinary(begin_operation(1)));
        let mut stale = Box::pin(owner.enqueue_ordinary(begin_operation(2)));
        assert!(matches!(poll_once(admitted.as_mut()), Poll::Ready(Ok(()))));
        assert!(poll_once(stale.as_mut()).is_pending());

        let mut close = Box::pin(owner.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert_eq!(
            begin_token(receiver.recv().expect("work admitted before close")),
            1
        );
        let close_message = receiver.recv().expect("retryable close message");
        let OwnerOperation::Control(OwnerControl::Close { attempt }) = close_message.operation
        else {
            panic!("expected close control");
        };
        complete_close_attempt(
            &owner.inner.admission,
            &owner.inner.state,
            &owner.inner.close_attempt,
            &attempt,
            Err(Error::message("injected retryable close")),
            CloseDisposition::Retryable,
        );
        assert!(matches!(poll_once(close.as_mut()), Poll::Ready(Err(_))));

        let Poll::Ready(stale_result) = poll_once(stale.as_mut()) else {
            panic!("stale waiter must settle after capacity is released");
        };
        assert!(
            stale_result
                .expect_err("pre-cutoff waiter stays rejected")
                .to_string()
                .contains("close cutoff")
        );

        let mut fresh = Box::pin(owner.enqueue_ordinary(begin_operation(3)));
        assert!(matches!(poll_once(fresh.as_mut()), Poll::Ready(Ok(()))));
        assert_eq!(
            begin_token(receiver.recv().expect("fresh post-retry work")),
            3
        );
    }

    #[test]
    fn reentrant_work_fails_before_waiting_for_capacity() {
        let (owner, _receiver) = detached_owner(0, thread::current().id());
        let mut call = Box::pin(owner.call(None, |_| Ok(())));
        let Poll::Ready(result) = poll_once(call.as_mut()) else {
            panic!("owner-thread reentrancy must not wait for capacity");
        };
        assert!(
            result
                .expect_err("reentrant work is rejected")
                .to_string()
                .contains("reentrant WASIX database work")
        );
    }

    struct DatabaseCloseHarness {
        owner: DatabaseOwner,
        started: mpsc::Receiver<usize>,
        completion: mpsc::Sender<FakeCloseCompletion>,
    }

    struct FakeCloseCompletion {
        result: SharedCloseResult,
        disposition: CloseDisposition,
    }

    fn database_close_harness() -> DatabaseCloseHarness {
        let (queue, receiver) = mpsc::channel::<OwnerMessage>();
        let (owner_id, owner_id_rx) = mpsc::channel();
        let (started, started_rx) = mpsc::channel();
        let (completion, completion_rx) = mpsc::channel::<FakeCloseCompletion>();
        let state = Arc::new(AtomicU8::new(OWNER_OPEN));
        let admission = Arc::new(Mutex::new(()));
        let close_attempt = Arc::new(Mutex::new(None));
        let thread_state = Arc::clone(&state);
        let thread_admission = Arc::clone(&admission);
        let thread_close_attempt = Arc::clone(&close_attempt);
        thread::spawn(move || {
            owner_id
                .send(thread::current().id())
                .expect("publish fake database owner id");
            let mut close_index = 0;
            while let Ok(message) = receiver.recv() {
                match message.operation {
                    OwnerOperation::Control(OwnerControl::Close { attempt }) => {
                        started
                            .send(close_index)
                            .expect("announce fake database close");
                        let completion =
                            completion_rx.recv().expect("complete fake database close");
                        close_index += 1;
                        let _admission = thread_admission
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        if complete_close_attempt_locked(
                            &thread_state,
                            &thread_close_attempt,
                            &attempt,
                            completion.result,
                            completion.disposition,
                        ) {
                            return;
                        }
                    }
                    OwnerOperation::Control(OwnerControl::Shutdown) => return,
                    _ => panic!("unexpected command sent to fake database owner"),
                }
            }
        });
        DatabaseCloseHarness {
            owner: DatabaseOwner {
                inner: Arc::new(DatabaseOwnerInner {
                    queue,
                    admission,
                    ordinary_order: Arc::new(AsyncMutex::new(())),
                    ordinary_capacity: Arc::new(Semaphore::new(OWNER_QUEUE_CAPACITY)),
                    state,
                    close_epoch: AtomicU64::new(0),
                    close_attempt,
                    owner_thread: owner_id_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("fake database owner starts"),
                    next_transaction: AtomicU64::new(1),
                }),
            },
            started: started_rx,
            completion,
        }
    }

    #[test]
    fn database_close_cutoff_preserves_admission_order() {
        let (queue, receiver) = mpsc::channel::<OwnerMessage>();
        let owner_thread = thread::spawn(|| thread::current().id())
            .join()
            .expect("capture a distinct fake owner thread id");
        let owner = DatabaseOwner {
            inner: Arc::new(DatabaseOwnerInner {
                queue,
                admission: Arc::new(Mutex::new(())),
                ordinary_order: Arc::new(AsyncMutex::new(())),
                ordinary_capacity: Arc::new(Semaphore::new(OWNER_QUEUE_CAPACITY)),
                state: Arc::new(AtomicU8::new(OWNER_OPEN)),
                close_epoch: AtomicU64::new(0),
                close_attempt: Arc::new(Mutex::new(None)),
                owner_thread,
                next_transaction: AtomicU64::new(1),
            }),
        };

        let mut admitted = Box::pin(owner.call(None, |_| Ok(())));
        assert!(poll_once(admitted.as_mut()).is_pending());

        let mut close = Box::pin(owner.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert_eq!(owner.inner.state.load(Ordering::SeqCst), OWNER_CLOSING);
        assert!(
            !owner.is_closed(),
            "a close which can still fail validation is not terminal"
        );

        let mut rejected = Box::pin(owner.call(None, |_| Ok(())));
        let Poll::Ready(rejected) = poll_once(rejected.as_mut()) else {
            panic!("work polled after the close cutoff must be rejected at admission");
        };
        assert_eq!(
            rejected
                .expect_err("post-cutoff work must fail")
                .to_string(),
            "AsyncOliphaunt is closing"
        );

        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("receive work admitted before close")
                .operation,
            OwnerOperation::Command(_)
        ));
        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("receive close after admitted work")
                .operation,
            OwnerOperation::Control(OwnerControl::Close { .. })
        ));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn stopped_database_owner_is_terminal() {
        let harness = database_close_harness();
        harness
            .owner
            .inner
            .state
            .store(OWNER_STOPPED, Ordering::SeqCst);

        assert!(harness.owner.is_closed());
        assert_eq!(
            harness.owner.ensure_open().unwrap_err().to_string(),
            "WASIX database owner has stopped"
        );
    }

    #[tokio::test]
    async fn database_close_validation_failure_is_retryable() {
        let harness = database_close_harness();
        let mut first = Box::pin(harness.owner.close());
        assert!(poll_once(first.as_mut()).is_pending());
        assert_eq!(
            harness
                .started
                .recv_timeout(Duration::from_secs(2))
                .expect("first database close starts"),
            0
        );
        let first_attempt = harness
            .owner
            .inner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("database close attempt is installed");
        harness
            .completion
            .send(FakeCloseCompletion {
                result: Err(Error::message("cannot close while a transaction is active")),
                disposition: CloseDisposition::Retryable,
            })
            .expect("reject database close before shutdown");
        assert_eq!(
            first
                .await
                .expect_err("validation rejects close")
                .to_string(),
            "cannot close while a transaction is active"
        );
        assert!(!harness.owner.is_closed());
        harness
            .owner
            .ensure_open()
            .expect("validation keeps admission open");
        assert_eq!(harness.owner.inner.state.load(Ordering::SeqCst), OWNER_OPEN);
        assert!(
            harness
                .owner
                .inner
                .close_attempt
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_none()
        );

        let mut retry = Box::pin(harness.owner.close());
        assert!(poll_once(retry.as_mut()).is_pending());
        assert_eq!(
            harness
                .started
                .recv_timeout(Duration::from_secs(2))
                .expect("database retry starts"),
            1
        );
        let retry_attempt = harness
            .owner
            .inner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("database retry attempt is installed");
        assert!(!Arc::ptr_eq(&first_attempt, &retry_attempt));
        harness
            .completion
            .send(FakeCloseCompletion {
                result: Ok(()),
                disposition: CloseDisposition::Terminal,
            })
            .expect("finish database close retry");
        retry.await.expect("database retry succeeds");
        assert!(harness.owner.is_closed());
        harness
            .owner
            .close()
            .await
            .expect("successful database close is idempotent");
    }

    #[tokio::test]
    async fn database_teardown_failure_is_terminal_and_replayed() {
        let harness = database_close_harness();
        let mut first = Box::pin(harness.owner.close());
        assert!(poll_once(first.as_mut()).is_pending());
        assert_eq!(
            harness
                .started
                .recv_timeout(Duration::from_secs(2))
                .expect("database teardown starts"),
            0
        );
        let first_attempt = harness
            .owner
            .inner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("database teardown attempt is installed");

        let mut second = Box::pin(harness.owner.close());
        assert!(poll_once(second.as_mut()).is_pending());
        assert_eq!(first_attempt.waiter_count(), 2);
        harness
            .completion
            .send(FakeCloseCompletion {
                result: Err(Error::message("injected database shutdown failure")),
                disposition: CloseDisposition::Terminal,
            })
            .expect("fail database teardown");

        let (first, second) = tokio::join!(first, second);
        for result in [first, second] {
            assert_eq!(
                result.expect_err("database teardown fails").to_string(),
                "injected database shutdown failure"
            );
        }
        assert!(harness.owner.is_closed());
        assert_eq!(
            harness.owner.ensure_open().unwrap_err().to_string(),
            "AsyncOliphaunt is closed"
        );
        let retained_attempt = harness
            .owner
            .inner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("terminal database close result is retained");
        assert!(Arc::ptr_eq(&first_attempt, &retained_attempt));
        assert_eq!(
            harness
                .owner
                .close()
                .await
                .expect_err("later close replays teardown failure")
                .to_string(),
            "injected database shutdown failure"
        );
        assert!(matches!(
            harness.started.try_recv(),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected)
        ));
    }

    struct ServerCloseHarness {
        server: AsyncOliphauntServer,
        started: mpsc::Receiver<usize>,
        completion: mpsc::Sender<FakeCloseCompletion>,
    }

    fn server_close_harness() -> ServerCloseHarness {
        let (control, receiver) = mpsc::channel::<ServerControl>();
        let (started, started_rx) = mpsc::channel();
        let (completion, completion_rx) = mpsc::channel::<FakeCloseCompletion>();
        let state = Arc::new(AtomicU8::new(OWNER_OPEN));
        let admission = Arc::new(Mutex::new(()));
        let close_attempt = Arc::new(Mutex::new(None));
        let thread_state = Arc::clone(&state);
        let thread_admission = Arc::clone(&admission);
        let thread_close_attempt = Arc::clone(&close_attempt);
        thread::spawn(move || {
            let mut close_index = 0;
            while let Ok(control) = receiver.recv() {
                match control {
                    ServerControl::Close { attempt } => {
                        started
                            .send(close_index)
                            .expect("announce fake server close");
                        let completion = completion_rx.recv().expect("complete fake server close");
                        close_index += 1;
                        let _admission = thread_admission
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        if complete_close_attempt_locked(
                            &thread_state,
                            &thread_close_attempt,
                            &attempt,
                            completion.result,
                            completion.disposition,
                        ) {
                            return;
                        }
                    }
                    ServerControl::Shutdown => return,
                }
            }
        });
        ServerCloseHarness {
            server: AsyncOliphauntServer {
                owner: Arc::new(ServerOwnerInner {
                    control,
                    admission,
                    state,
                    close_attempt,
                }),
                info: Arc::new(ServerInfo {
                    connection_string: "postgresql://fake".to_owned(),
                }),
            },
            started: started_rx,
            completion,
        }
    }

    fn server_owner_for_direct(server: DirectOliphauntServer) -> AsyncOliphauntServer {
        let (control, receiver) = mpsc::channel();
        let state = Arc::new(AtomicU8::new(OWNER_OPEN));
        let admission = Arc::new(Mutex::new(()));
        let close_attempt = Arc::new(Mutex::new(None));
        let thread_state = Arc::clone(&state);
        let thread_admission = Arc::clone(&admission);
        let thread_close_attempt = Arc::clone(&close_attempt);
        thread::spawn(move || {
            run_server_owner(
                server,
                receiver,
                &thread_state,
                &thread_admission,
                &thread_close_attempt,
            );
        });
        AsyncOliphauntServer {
            owner: Arc::new(ServerOwnerInner {
                control,
                admission,
                state,
                close_attempt,
            }),
            info: Arc::new(ServerInfo {
                connection_string: "postgresql://fake".to_owned(),
            }),
        }
    }

    #[tokio::test]
    async fn failed_async_server_close_cannot_release_managed_root_ownership() {
        let parent = tempfile::TempDir::new().expect("create test root parent");
        let root = parent.path().join("failed-async-server-root");
        let lock = DirectoryLock::acquire(&root).expect("own managed root");
        let direct = server_with_worker_result_for_test(
            Err(anyhow::anyhow!("injected async server stop failure")),
            Some(lock),
        );
        let server = server_owner_for_direct(direct);

        let error = server.close().await.expect_err("server teardown fails");
        assert!(
            error
                .to_string()
                .contains("injected async server stop failure")
        );
        drop(server);

        let reopen = DirectoryLock::acquire(&root)
            .expect_err("async owner drop must not release a failed server root");
        assert!(format!("{reopen:#}").contains("database root is already in use"));
    }

    #[tokio::test]
    async fn server_stop_failure_is_terminal_and_replayed() {
        let harness = server_close_harness();
        let mut first = Box::pin(harness.server.close());
        assert!(poll_once(first.as_mut()).is_pending());
        assert!(!harness.server.is_closed());
        assert_eq!(
            harness
                .started
                .recv_timeout(Duration::from_secs(2))
                .expect("first server close starts"),
            0
        );
        let first_attempt = harness
            .server
            .owner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("server close attempt is installed");

        let mut second = Box::pin(harness.server.close());
        assert!(poll_once(second.as_mut()).is_pending());
        let joined_attempt = harness
            .server
            .owner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("server close attempt remains installed");
        assert!(Arc::ptr_eq(&first_attempt, &joined_attempt));
        assert_eq!(first_attempt.waiter_count(), 2);
        assert!(matches!(
            harness.started.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        harness
            .completion
            .send(FakeCloseCompletion {
                result: Err(Error::message("injected server stop failure")),
                disposition: CloseDisposition::Terminal,
            })
            .expect("finish failed server close");
        let (first, second) = tokio::join!(first, second);
        assert_eq!(
            first.expect_err("first server close fails").to_string(),
            "injected server stop failure"
        );
        assert_eq!(
            second.expect_err("joined server close fails").to_string(),
            "injected server stop failure"
        );
        assert!(harness.server.is_closed());
        let retained_attempt = harness
            .server
            .owner
            .close_attempt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("terminal server close result is retained");
        assert!(Arc::ptr_eq(&first_attempt, &retained_attempt));
        assert_eq!(
            harness
                .server
                .close()
                .await
                .expect_err("later close replays server stop failure")
                .to_string(),
            "injected server stop failure"
        );
        assert!(matches!(
            harness.started.try_recv(),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn stopped_server_owner_is_terminal() {
        let harness = server_close_harness();
        harness
            .server
            .owner
            .state
            .store(OWNER_STOPPED, Ordering::SeqCst);

        assert!(harness.server.is_closed());
    }
}
