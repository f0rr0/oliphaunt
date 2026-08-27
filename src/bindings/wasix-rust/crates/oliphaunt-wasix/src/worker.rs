//! Dedicated owner-thread API for applications that must keep their calling
//! executor responsive while PostgreSQL runs synchronously on another thread.
//!
//! Each [`Oliphaunt`] owns one worker thread and one FIFO command queue. The
//! handle is cloneable and asynchronous; the direct caller-thread API remains
//! available from the crate root. Storage, query/result, error, extension, and
//! listener configuration types are shared by both APIs and also live at the
//! crate root.

use std::borrow::Cow;
use std::net::SocketAddr;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

use tokio::sync::oneshot;

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
use crate::{DatabaseStorage, Error, PostgresError, Result};

/// Packaged PostgreSQL frontend programs queued on the database worker.
#[cfg(feature = "tools")]
pub mod tools {
    pub use crate::oliphaunt::tools::{PgDumpOptions, PostgresToolError, PsqlOptions};

    /// Run packaged `pg_dump` on the database worker.
    pub async fn pg_dump(
        database: &super::Oliphaunt,
        options: PgDumpOptions,
    ) -> crate::Result<String> {
        database.pg_dump(options).await
    }

    /// Run packaged non-interactive `psql` on the database worker.
    pub async fn psql(database: &super::Oliphaunt, options: PsqlOptions) -> crate::Result<String> {
        database.psql(options).await
    }
}

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

type OwnerAction = Box<dyn FnOnce(&mut DirectOliphaunt, Result<()>) + Send + 'static>;
type SharedCloseResult = std::result::Result<(), Arc<str>>;
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
            .map_err(|_| Error::message(format!("{owner} stopped while closing")))?;
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
    _permit: Option<OrdinaryPermit>,
    operation: OwnerOperation,
}

enum OwnerOperation {
    Command(OwnerCommand),
    Control(OwnerControl),
}

struct OrdinaryPermit {
    queued: Arc<AtomicUsize>,
}

impl Drop for OrdinaryPermit {
    fn drop(&mut self) {
        self.queued.fetch_sub(1, Ordering::SeqCst);
    }
}

enum OwnerControl {
    Begin {
        token: u64,
        reply: oneshot::Sender<Result<()>>,
    },
    Finish {
        token: u64,
        commit: bool,
        reply: oneshot::Sender<Result<()>>,
    },
    RollbackBestEffort {
        token: u64,
    },
    Close {
        attempt: Arc<CloseAttempt>,
    },
    Shutdown,
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
    queued_ordinary: Arc<AtomicUsize>,
    state: Arc<AtomicU8>,
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
        let queued_ordinary = Arc::new(AtomicUsize::new(0));
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
                let mut database = match opened {
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

                let worker = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_database_owner(
                        &mut database,
                        queue_rx,
                        &thread_state,
                        &thread_admission,
                        &thread_close_attempt,
                    )
                }));
                if worker.is_err() {
                    stop_close_owner(
                        &thread_admission,
                        &thread_state,
                        &thread_close_attempt,
                        "WASIX database owner panicked while closing",
                    );
                }
            })
            .map_err(|error| Error::message(format!("spawn WASIX database owner: {error}")))?;
        let owner_thread = open_rx
            .await
            .map_err(|_| Error::message("WASIX database owner stopped before open completed"))??;
        Ok(Self {
            inner: Arc::new(DatabaseOwnerInner {
                queue,
                admission,
                queued_ordinary,
                state,
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
            OWNER_CLOSED => Err(Error::message("Oliphaunt is closed")),
            OWNER_STOPPED => Err(Error::message("WASIX database owner has stopped")),
            OWNER_CLOSING => Err(Error::message("Oliphaunt is closing")),
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

    fn enqueue_ordinary(&self, operation: OwnerOperation) -> Result<()> {
        let _admission = self.lock_admission()?;
        self.ensure_open()?;
        if self.inner.queued_ordinary.load(Ordering::SeqCst) >= OWNER_QUEUE_CAPACITY {
            return Err(Error::message(format!(
                "WASIX database owner queue is full (capacity {OWNER_QUEUE_CAPACITY})"
            )));
        }
        self.inner.queued_ordinary.fetch_add(1, Ordering::SeqCst);
        self.inner
            .queue
            .send(OwnerMessage {
                _permit: Some(OrdinaryPermit {
                    queued: Arc::clone(&self.inner.queued_ordinary),
                }),
                operation,
            })
            .map_err(|_| Error::message("WASIX database owner has stopped"))
    }

    fn enqueue_control(&self, control: OwnerControl) -> Result<()> {
        let _admission = self.lock_admission()?;
        self.inner
            .queue
            .send(OwnerMessage {
                _permit: None,
                operation: OwnerOperation::Control(control),
            })
            .map_err(|_| Error::message("WASIX database owner has stopped"))
    }

    async fn call<T, F>(&self, transaction: Option<u64>, action: F) -> Result<T>
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
                let _ = reply.send(result);
            }),
        };
        self.enqueue_ordinary(OwnerOperation::Command(command))?;
        receiver.await.map_err(|_| {
            Error::message("WASIX database owner stopped while running an operation")
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
        }))?;
        receiver.await.map_err(|_| {
            Error::message("WASIX database owner stopped while beginning a transaction")
        })??;
        Ok(token)
    }

    async fn finish_transaction(&self, token: u64, commit: bool) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue_control(OwnerControl::Finish {
            token,
            commit,
            reply,
        })?;
        receiver.await.map_err(|_| {
            Error::message("WASIX database owner stopped while settling a transaction")
        })?
    }

    fn rollback_best_effort(&self, token: u64) {
        let _ = self.enqueue_control(OwnerControl::RollbackBestEffort { token });
    }

    async fn close(&self) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let attempt = {
            // The state cutoff and Close enqueue share the same lock as every
            // ordinary admission. Work before this critical section is ahead
            // of Close; work after it observes CLOSING and is rejected.
            let _admission = self.lock_admission()?;
            match admit_close(
                &self.inner.state,
                &self.inner.close_attempt,
                "WASIX database owner",
            )? {
                CloseAdmission::Closed => return Ok(()),
                CloseAdmission::Join(attempt) => attempt,
                CloseAdmission::Start(attempt) => {
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
                            Err(Arc::from("WASIX database owner has stopped")),
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
    result.map_err(Error::message)
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
        OWNER_STOPPED => Err(Error::message(format!("{owner} has stopped"))),
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
    let result = result.map_err(|error| Arc::<str>::from(error.to_string()));
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
            Err(Arc::from(message)),
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
    let result = result.map_err(|error| Arc::<str>::from(error.to_string()));
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
    database: &mut DirectOliphaunt,
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
                if handle_database_control(
                    database,
                    message,
                    &mut active_transaction,
                    state,
                    admission,
                    close_attempt,
                ) {
                    return;
                }
            }
            Ok(OwnerMessage {
                _permit,
                operation: OwnerOperation::Command(command),
            }) => {
                drop(_permit);
                let admission = match (command.transaction, active_transaction) {
                    (None, None) => Ok(()),
                    (None, Some(_)) => Err(Error::message(
                        "a callback transaction is active; use its transaction handle",
                    )),
                    (Some(expected), Some(active)) if expected == active => Ok(()),
                    (Some(_), _) => Err(Error::message("transaction is no longer active")),
                };
                (command.action)(database, admission);
            }
            Err(_) => {
                let _ = rollback_active(database, &mut active_transaction);
                complete_owner_shutdown(admission, state, close_attempt, database.close());
                return;
            }
        }
    }
}

fn handle_database_control(
    database: &mut DirectOliphaunt,
    message: OwnerControl,
    active_transaction: &mut Option<u64>,
    state: &AtomicU8,
    admission: &Mutex<()>,
    close_attempt: &Mutex<Option<Arc<CloseAttempt>>>,
) -> bool {
    match message {
        OwnerControl::Begin { token, reply } => {
            if reply.is_closed() {
                return false;
            }
            let mut result = if active_transaction.is_some() {
                Err(Error::message("a transaction is already active"))
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
            false
        }
        OwnerControl::Finish {
            token,
            commit,
            reply,
        } => {
            let result = if *active_transaction != Some(token) {
                Err(Error::message("transaction is no longer active"))
            } else if commit {
                database.owner_commit_transaction()
            } else {
                database.owner_rollback_transaction()
            };
            if *active_transaction == Some(token) {
                *active_transaction = None;
            }
            let _ = reply.send(result);
            false
        }
        OwnerControl::RollbackBestEffort { token } => {
            if *active_transaction == Some(token) {
                let _ = database.owner_rollback_transaction();
                *active_transaction = None;
            }
            false
        }
        OwnerControl::Close { attempt } => {
            let (result, disposition) = if active_transaction.is_some() {
                (
                    Err(Error::message("cannot close while a transaction is active")),
                    CloseDisposition::Retryable,
                )
            } else {
                (database.close(), CloseDisposition::Terminal)
            };
            complete_close_attempt(
                admission,
                state,
                close_attempt,
                &attempt,
                result,
                disposition,
            )
        }
        OwnerControl::Shutdown => {
            let _ = rollback_active(database, active_transaction);
            complete_owner_shutdown(admission, state, close_attempt, database.close());
            true
        }
    }
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

/// Asynchronous, owner-thread Oliphaunt WASIX database handle.
///
/// Every clone refers to the same serialized PostgreSQL session. The Wasmer
/// store is constructed and remains on the package-owned thread.
#[derive(Clone)]
pub struct Oliphaunt {
    owner: DatabaseOwner,
}

impl Oliphaunt {
    /// Build an asynchronous WASIX database. The default storage is memory.
    pub fn builder() -> OliphauntBuilder {
        OliphauntBuilder::new()
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
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::database(self, sql)
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
    /// The callback must not await reentrant work on this database.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        let request = request.as_ref().to_vec();
        self.owner
            .call(None, move |database| {
                database.exec_protocol_raw_stream(request, on_chunk)
            })
            .await
    }

    /// Run an async callback in a transaction pinned to this physical session.
    ///
    /// Success commits, callback failure rolls back, and an explicit
    /// [`Transaction::rollback`] suppresses the later commit. Unpinned work on
    /// this database is rejected while the callback is active.
    pub async fn transaction<T>(
        &self,
        body: impl for<'tx> AsyncFnOnce(&'tx Transaction) -> Result<T>,
    ) -> Result<T> {
        let token = self.owner.begin_transaction().await?;
        let transaction = Transaction::new(self.owner.clone(), token);
        let callback = body(&transaction).await;
        transaction.settle(callback).await
    }

    /// Create a session-preserving PostgreSQL online physical backup.
    pub async fn backup(&self) -> Result<Vec<u8>> {
        self.owner.call(None, DirectOliphaunt::backup).await
    }

    #[cfg(feature = "tools")]
    pub(crate) async fn pg_dump(
        &self,
        options: crate::oliphaunt::tools::PgDumpOptions,
    ) -> Result<String> {
        self.owner
            .call(None, move |database| {
                crate::error::public_result(database.run_pg_dump_tool(options))
            })
            .await
    }

    #[cfg(feature = "tools")]
    pub(crate) async fn psql(
        &self,
        options: crate::oliphaunt::tools::PsqlOptions,
    ) -> Result<String> {
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
    /// replays that attempt's exact result.
    pub async fn close(&self) -> Result<()> {
        self.owner.close().await
    }
}

/// Builder for an owner-thread [`Oliphaunt`] database.
#[derive(Debug, Clone)]
pub struct OliphauntBuilder {
    inner: DirectOliphauntBuilder,
}

impl Default for OliphauntBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl OliphauntBuilder {
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
    /// Enable one bundled extension before returning the database.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    #[cfg(feature = "extensions")]
    /// Enable bundled extensions before returning the database.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Construct the Wasmer runtime and PostgreSQL session on its permanent owner thread.
    pub async fn open(self) -> Result<Oliphaunt> {
        Ok(Oliphaunt {
            owner: DatabaseOwner::open(self.inner).await?,
        })
    }
}

enum SqlOwner<'a> {
    Database(&'a Oliphaunt),
    Transaction(&'a Transaction),
}

/// Fluent asynchronous SQL statement bound to a database or transaction.
#[must_use = "a SQL statement does nothing until execute(), query(), or describe() is awaited"]
pub struct Sql<'db, 'q> {
    owner: SqlOwner<'db>,
    sql: Cow<'q, str>,
    params: Vec<Parameter>,
    result_format: ValueFormat,
}

impl<'db, 'q> Sql<'db, 'q> {
    fn database(database: &'db Oliphaunt, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            owner: SqlOwner::Database(database),
            sql: sql.into(),
            params: Vec::new(),
            result_format: ValueFormat::Text,
        }
    }

    fn transaction(transaction: &'db Transaction, sql: impl Into<Cow<'q, str>>) -> Self {
        Self {
            owner: SqlOwner::Transaction(transaction),
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
            SqlOwner::Transaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call(Some(token), move |owner| {
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
            SqlOwner::Transaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call(Some(token), move |owner| {
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
            SqlOwner::Transaction(transaction) => {
                transaction.ensure_active()?;
                let token = transaction.token;
                transaction
                    .owner
                    .call(Some(token), move |owner| {
                        owner.owner_transaction_describe(&sql, params)
                    })
                    .await
            }
        }
    }
}

/// Callback-scoped asynchronous transaction pinned to the owner session.
pub struct Transaction {
    owner: DatabaseOwner,
    token: u64,
    state: AtomicU8,
    terminal_error: Mutex<Option<ErrorSnapshot>>,
}

#[derive(Clone)]
struct ErrorSnapshot {
    report: String,
    postgres: Option<PostgresError>,
}

impl ErrorSnapshot {
    fn capture(error: &Error) -> Self {
        Self {
            report: format!("{error:#}"),
            postgres: error.postgres_error().cloned(),
        }
    }

    fn to_error(&self) -> Error {
        match &self.postgres {
            Some(postgres) if self.report == postgres.to_string() => {
                Error::from_anyhow(anyhow::Error::new(postgres.clone()))
            }
            Some(postgres) => Error::from_anyhow(
                anyhow::Error::new(postgres.clone()).context(self.report.clone()),
            ),
            None => Error::message(self.report.clone()),
        }
    }
}

impl Transaction {
    fn new(owner: DatabaseOwner, token: u64) -> Self {
        Self {
            owner,
            token,
            state: AtomicU8::new(TRANSACTION_ACTIVE),
            terminal_error: Mutex::new(None),
        }
    }

    /// Build a typed, fluent statement pinned to this transaction.
    pub fn sql<'db, 'q>(&'db self, sql: impl Into<Cow<'q, str>>) -> Sql<'db, 'q> {
        Sql::transaction(self, sql)
    }

    /// Whether the transaction handle has rolled back or begun settlement.
    pub fn is_closed(&self) -> bool {
        self.state.load(Ordering::SeqCst) != TRANSACTION_ACTIVE
    }

    fn ensure_active(&self) -> Result<()> {
        if self.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE {
            Ok(())
        } else {
            Err(Error::message("transaction is no longer active"))
        }
    }

    /// Execute exactly one command inside this transaction.
    pub async fn execute(&self, sql: &str) -> Result<CommandResult> {
        self.sql(sql).execute().await
    }

    /// Execute one parameterized command inside this transaction.
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

    /// Execute one statement and return its row-shaped result.
    ///
    /// Command-only SQL is accepted as an empty row set.
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

    /// Execute possibly multi-statement SQL inside this transaction.
    pub async fn exec(&self, sql: &str) -> Result<ExecResult> {
        self.ensure_active()?;
        let sql = sql.to_owned();
        let token = self.token;
        self.owner
            .call(Some(token), move |database| {
                database.owner_transaction_exec(&sql)
            })
            .await
    }

    /// Describe a statement inside this transaction without executing it.
    pub async fn describe(&self, sql: &str) -> Result<StatementDescription> {
        self.sql(sql).describe().await
    }

    /// Execute raw protocol bytes while retaining this transaction's session pin.
    pub async fn exec_protocol_raw(&self, request: impl AsRef<[u8]>) -> Result<Vec<u8>> {
        self.ensure_active()?;
        let request = request.as_ref().to_vec();
        let token = self.token;
        self.owner
            .call(Some(token), move |database| {
                database.exec_protocol_raw(request)
            })
            .await
    }

    /// Execute raw protocol bytes with a synchronous owner-thread callback.
    pub async fn exec_protocol_raw_stream<F>(
        &self,
        request: impl AsRef<[u8]>,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.ensure_active()?;
        let request = request.as_ref().to_vec();
        let token = self.token;
        self.owner
            .call(Some(token), move |database| {
                database.exec_protocol_raw_stream(request, on_chunk)
            })
            .await
    }

    /// Roll back immediately and expire this transaction handle.
    pub async fn rollback(&self) -> Result<()> {
        self.finish(false).await
    }

    async fn finish(&self, commit: bool) -> Result<()> {
        self.state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| Error::message("transaction is no longer active"))?;
        let result = self.owner.finish_transaction(self.token, commit).await;
        match &result {
            Ok(()) => self.state.store(
                if commit {
                    TRANSACTION_COMMITTED
                } else {
                    TRANSACTION_ROLLED_BACK
                },
                Ordering::SeqCst,
            ),
            Err(error) => {
                if let Ok(mut terminal) = self.terminal_error.lock() {
                    *terminal = Some(ErrorSnapshot::capture(error));
                }
                self.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
            }
        }
        result
    }

    async fn settle<T>(&self, callback: Result<T>) -> Result<T> {
        match (self.state.load(Ordering::SeqCst), callback) {
            (TRANSACTION_ACTIVE, Ok(value)) => {
                self.finish(true).await?;
                Ok(value)
            }
            (TRANSACTION_ACTIVE, Err(callback)) => match self.finish(false).await {
                Ok(()) => Err(callback),
                Err(rollback) => Err(Error::transaction_rollback(callback, rollback)),
            },
            (TRANSACTION_ROLLED_BACK, callback) => callback,
            (TRANSACTION_FAILED, Ok(_)) => Err(self.retained_error()),
            (TRANSACTION_FAILED, Err(callback)) => {
                Err(Error::transaction_rollback(callback, self.retained_error()))
            }
            (_, _) => Err(Error::message(
                "transaction settlement did not reach a valid terminal state",
            )),
        }
    }

    fn retained_error(&self) -> Error {
        self.terminal_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
            .map_or_else(
                || Error::message("transaction failed"),
                |error| error.to_error(),
            )
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        if self
            .state
            .compare_exchange(
                TRANSACTION_ACTIVE,
                TRANSACTION_FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.owner.rollback_best_effort(self.token);
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
                .map_err(|_| Error::message(format!("{name} worker panicked")))
                .and_then(|result| result);
            let _ = reply.send(result);
        })
        .map_err(|error| Error::message(format!("spawn {name}: {error}")))?;
    receiver
        .await
        .map_err(|_| Error::message(format!("{name} stopped before returning a result")))?
}

#[derive(Debug)]
struct ServerInfo {
    tcp_addr: Option<SocketAddr>,
    #[cfg(unix)]
    socket_path: Option<PathBuf>,
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
pub struct OliphauntServer {
    owner: Arc<ServerOwnerInner>,
    info: Arc<ServerInfo>,
}

impl OliphauntServer {
    /// Build an asynchronous local PostgreSQL server.
    pub fn builder() -> OliphauntServerBuilder {
        OliphauntServerBuilder::new()
    }

    /// Return the bound TCP address, when using TCP.
    pub fn tcp_addr(&self) -> Option<SocketAddr> {
        self.info.tcp_addr
    }

    #[cfg(unix)]
    /// Return the PostgreSQL Unix-domain socket path, when using UDS.
    pub fn socket_path(&self) -> Option<&Path> {
        self.info.socket_path.as_deref()
    }

    /// Return the standard PostgreSQL connection string.
    pub fn connection_string(&self) -> &str {
        &self.info.connection_string
    }

    /// Whether the server is permanently retired.
    ///
    /// This includes both a settled terminal close attempt and an unexpectedly
    /// stopped owner. A close attempt still in progress is not yet terminal.
    pub fn is_closed(&self) -> bool {
        owner_is_terminal(&self.owner.state)
    }

    /// Stop the local server without blocking the calling executor thread.
    ///
    /// Concurrent callers await the exact same attempt and receive the same
    /// success or failure. Once server stop begins, the server is permanently
    /// retired and every later close replays that attempt's exact result.
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
                            Err(Arc::from("WASIX server owner has stopped")),
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
pub struct OliphauntServerBuilder {
    inner: DirectOliphauntServerBuilder,
}

impl Default for OliphauntServerBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl OliphauntServerBuilder {
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

    /// Select loopback TCP or a PostgreSQL Unix-domain socket.
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
    /// Enable one bundled extension before serving connections.
    pub fn extension(mut self, extension: Extension) -> Self {
        self.inner = self.inner.extension(extension);
        self
    }

    #[cfg(feature = "extensions")]
    /// Enable bundled extensions before serving connections.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = Extension>) -> Self {
        self.inner = self.inner.extensions(extensions);
        self
    }

    /// Start the server and await its bound endpoint.
    pub async fn start(self) -> Result<OliphauntServer> {
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
                    tcp_addr: server.tcp_addr(),
                    #[cfg(unix)]
                    socket_path: server.socket_path().map(Path::to_path_buf),
                    connection_string: server.connection_string(),
                };
                if open_tx.send(Ok(info)).is_err() {
                    drop(server);
                    thread_state.store(OWNER_CLOSED, Ordering::SeqCst);
                    return;
                }
                let worker = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_server_owner(
                        server,
                        receiver,
                        &thread_state,
                        &thread_admission,
                        &thread_close_attempt,
                    )
                }));
                if worker.is_err() {
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
            .map_err(|_| Error::message("WASIX server owner stopped before start completed"))??;
        Ok(OliphauntServer {
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
    loop {
        match receiver.recv() {
            Ok(ServerControl::Close { attempt }) => {
                let result = server.owner_close();
                if complete_close_attempt(
                    admission,
                    state,
                    close_attempt,
                    &attempt,
                    result,
                    CloseDisposition::Terminal,
                ) {
                    return;
                }
            }
            Ok(ServerControl::Shutdown) | Err(_) => {
                complete_owner_shutdown(admission, state, close_attempt, server.owner_close());
                return;
            }
        }
    }
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Oliphaunt>();
    assert_send_sync::<OliphauntServer>();
    assert_send_sync::<Transaction>();
};

#[cfg(test)]
mod close_tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    use std::time::Duration;

    use super::*;

    fn poll_once<F: Future>(future: std::pin::Pin<&mut F>) -> Poll<F::Output> {
        let mut context = Context::from_waker(Waker::noop());
        future.poll(&mut context)
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
                    queued_ordinary: Arc::new(AtomicUsize::new(0)),
                    state,
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
                queued_ordinary: Arc::new(AtomicUsize::new(0)),
                state: Arc::new(AtomicU8::new(OWNER_OPEN)),
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
            "Oliphaunt is closing"
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
                result: Err(Arc::from("cannot close while a transaction is active")),
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
                result: Err(Arc::from("injected database shutdown failure")),
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
            "Oliphaunt is closed"
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
        server: OliphauntServer,
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
            server: OliphauntServer {
                owner: Arc::new(ServerOwnerInner {
                    control,
                    admission,
                    state,
                    close_attempt,
                }),
                info: Arc::new(ServerInfo {
                    tcp_addr: None,
                    #[cfg(unix)]
                    socket_path: None,
                    connection_string: "postgresql://fake".to_owned(),
                }),
            },
            started: started_rx,
            completion,
        }
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
                result: Err(Arc::from("injected server stop failure")),
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
