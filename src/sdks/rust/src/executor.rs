use std::any::Any;
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;

use crate::engine::{EngineCancel, EngineSession};
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{ReadyStatus, parse_simple_command_response, response_ready_status};
use crate::reply;

type ProtocolChunkCallback = Box<dyn FnMut(&[u8]) -> Result<()> + Send>;

/// Ordinary application work is bounded. Lifecycle and transaction-recovery
/// commands share the same FIFO but do not consume this capacity, so cleanup
/// can always be admitted without inventing a public queue-tuning surface.
const ORDINARY_QUEUE_CAPACITY: usize = 256;

pub(crate) const TRANSACTION_ACTIVE: u8 = 0;
pub(crate) const TRANSACTION_FINISHING: u8 = 1;
pub(crate) const TRANSACTION_ROLLED_BACK: u8 = 2;
pub(crate) const TRANSACTION_FAILED: u8 = 3;
pub(crate) const TRANSACTION_RELEASED: u8 = 4;

pub(crate) struct TransactionGuard {
    pub(crate) state: AtomicU8,
    pub(crate) terminal_error: Mutex<Option<Error>>,
}

impl TransactionGuard {
    pub(crate) fn active() -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(TRANSACTION_ACTIVE),
            terminal_error: Mutex::new(None),
        })
    }

    fn fail(&self, error: Error) {
        self.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
        if let Ok(mut terminal_error) = self.terminal_error.lock()
            && terminal_error.is_none()
        {
            *terminal_error = Some(error);
        }
    }
}

pub(crate) struct EngineExecutor {
    shared: Arc<ExecutorShared>,
}

struct ExecutorShared {
    queue: CommandQueue,
    // SQL/close/cancel admission and the owner-side transition into teardown
    // share this lock. That makes "cancel is accepted until teardown starts"
    // an exact boundary instead of an atomic-check race.
    admission: Mutex<()>,
    cancel: Mutex<Option<Arc<dyn EngineCancel>>>,
    active_work: AtomicBool,
    session_pinned: AtomicBool,
    transaction_poisoned: AtomicBool,
    // This is an admission cutoff, not an owner-side execution predicate.
    // Commands already ahead of `Command::Close` must run even while it is set.
    closing: AtomicBool,
    teardown_started: AtomicBool,
    closed: AtomicBool,
    terminal_drop: AtomicBool,
    close_state: Mutex<CloseState>,
    owner_thread: OnceLock<thread::ThreadId>,
}

impl ExecutorShared {
    fn new() -> Self {
        Self {
            queue: CommandQueue::new(),
            admission: Mutex::new(()),
            cancel: Mutex::new(None),
            active_work: AtomicBool::new(false),
            session_pinned: AtomicBool::new(false),
            transaction_poisoned: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            teardown_started: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            terminal_drop: AtomicBool::new(false),
            close_state: Mutex::new(CloseState::default()),
            owner_thread: OnceLock::new(),
        }
    }
}

#[derive(Default)]
struct CloseState {
    in_progress: bool,
    terminal_result: Option<Result<()>>,
    waiters: Vec<reply::Sender<()>>,
}

struct CommandQueue {
    state: Mutex<CommandQueueState>,
    ready: Condvar,
}

struct CommandQueueState {
    commands: VecDeque<Command>,
    ordinary_count: usize,
    stopped: bool,
}

impl CommandQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(CommandQueueState {
                commands: VecDeque::new(),
                ordinary_count: 0,
                stopped: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn send(&self, command: Command) -> Result<()> {
        let ordinary = command.is_ordinary();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(Error::EngineStopped);
        }
        if ordinary && state.ordinary_count >= ORDINARY_QUEUE_CAPACITY {
            return Err(Error::Engine(format!(
                "native engine command queue is full (capacity {ORDINARY_QUEUE_CAPACITY})"
            )));
        }
        if ordinary {
            state.ordinary_count += 1;
        }
        state.commands.push_back(command);
        self.ready.notify_one();
        Ok(())
    }

    fn receive(&self) -> Option<Command> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(command) = state.commands.pop_front() {
                if command.is_ordinary() {
                    state.ordinary_count -= 1;
                }
                return Some(command);
            }
            if state.stopped {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    fn stop(&self) -> Vec<Command> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        state.ordinary_count = 0;
        let pending = state.commands.drain(..).collect();
        self.ready.notify_all();
        pending
    }
}

impl EngineExecutor {
    /// Construct a runtime session on the thread which permanently owns it.
    pub(crate) async fn open<M, F>(
        thread_name: &'static str,
        operation: F,
    ) -> Result<(Arc<Self>, M)>
    where
        M: Send + 'static,
        F: FnOnce() -> Result<(Box<dyn EngineSession>, M)> + Send + 'static,
    {
        let (executor, opened) = Self::start_owner(thread_name, operation)?;
        let metadata = opened.await?;
        Ok((executor, metadata))
    }

    fn start_owner<M, F>(
        thread_name: &'static str,
        operation: F,
    ) -> Result<(Arc<Self>, reply::Receiver<M>)>
    where
        M: Send + 'static,
        F: FnOnce() -> Result<(Box<dyn EngineSession>, M)> + Send + 'static,
    {
        let shared = Arc::new(ExecutorShared::new());
        let executor = Arc::new(Self {
            shared: Arc::clone(&shared),
        });
        let (opened, receiver) = reply::channel();
        thread::Builder::new()
            .name(thread_name.to_owned())
            .spawn(move || owner_thread(shared, opened, operation, thread_name))
            .map_err(|error| Error::Engine(format!("failed to start {thread_name}: {error}")))?;
        Ok((executor, receiver))
    }

    #[cfg(test)]
    pub(crate) fn spawn(session: Box<dyn EngineSession>) -> Arc<Self> {
        use std::future::Future;
        use std::task::{Context, Poll, Wake, Waker};

        struct ThreadWake(thread::Thread);

        impl Wake for ThreadWake {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }

        let (executor, opened) =
            Self::start_owner("oliphaunt-test-owner", move || Ok((session, ())))
                .expect("spawn test owner thread");
        let mut opened = std::pin::pin!(opened);
        let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
        let mut context = Context::from_waker(&waker);
        loop {
            match opened.as_mut().poll(&mut context) {
                Poll::Ready(result) => {
                    result.expect("test owner opens");
                    break;
                }
                Poll::Pending => thread::park(),
            }
        }
        executor
    }

    pub(crate) async fn cancel(&self) -> Result<()> {
        let admission = self.shared.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        // `closing` is only an ordinary-work cutoff. Cancellation is
        // out-of-band and remains useful while already-admitted SQL drains.
        // The owner takes this same lock before beginning destructive
        // teardown, so cancellation admission is ordered exactly before or
        // after that transition.
        if self.shared.closed.load(Ordering::SeqCst)
            || self.shared.teardown_started.load(Ordering::SeqCst)
        {
            return Err(Error::EngineStopped);
        }
        let cancel = self
            .shared
            .cancel
            .lock()
            .map_err(|_| Error::Engine("database cancellation lock was poisoned".to_owned()))?
            .clone()
            .ok_or_else(|| {
                Error::Engine("query cancellation is not supported by this engine".to_owned())
            })?;
        drop(admission);
        run_off_thread("oliphaunt-cancel", move || cancel.cancel()).await
    }

    pub(crate) async fn exec_protocol_raw(
        &self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Exec { request, reply })?;
        receiver.await
    }

    pub(crate) async fn exec_structured(
        &self,
        request: ProtocolRequest,
        operation: impl Into<String>,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::StructuredExec {
            request,
            operation: operation.into(),
            reply,
        })?;
        receiver.await
    }

    pub(crate) async fn pinned_exec_protocol_control(
        &self,
        token: u64,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        self.pinned_exec(token, request, None, true).await
    }

    pub(crate) async fn pinned_exec_protocol_raw_guarded(
        &self,
        token: u64,
        request: ProtocolRequest,
        guard: Arc<TransactionGuard>,
    ) -> Result<ProtocolResponse> {
        self.pinned_exec(token, request, Some(guard), false).await
    }

    async fn pinned_exec(
        &self,
        token: u64,
        request: ProtocolRequest,
        guard: Option<Arc<TransactionGuard>>,
        must_run: bool,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        let command = Command::PinnedExec {
            token,
            request,
            guard,
            must_run,
            reply,
        };
        if must_run {
            self.send_transaction_settlement(command)?;
        } else {
            self.send(command)?;
        }
        receiver.await
    }

    pub(crate) async fn pinned_exec_structured(
        &self,
        token: u64,
        request: ProtocolRequest,
        operation: impl Into<String>,
        guard: Arc<TransactionGuard>,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::PinnedStructuredExec {
            token,
            request,
            operation: operation.into(),
            guard,
            reply,
        })?;
        receiver.await
    }

    pub(crate) async fn exec_protocol_raw_stream<F>(
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

    pub(crate) async fn pinned_exec_protocol_raw_stream<F>(
        &self,
        token: u64,
        request: ProtocolRequest,
        guard: Option<Arc<TransactionGuard>>,
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
            guard,
            reply,
        })?;
        receiver.await
    }

    pub(crate) async fn begin_transaction(&self) -> Result<u64> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Begin { reply })?;
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
        self.shared
            .transaction_poisoned
            .store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn session_is_pinned(&self) -> bool {
        self.shared.session_pinned.load(Ordering::SeqCst)
    }

    pub(crate) async fn backup(&self) -> Result<Vec<u8>> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Backup { reply })?;
        receiver.await
    }

    pub(crate) async fn close(&self) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = reply::channel();
        {
            // Setting the cutoff and appending Close happen under the same
            // admission lock used by every command submission. Commands that
            // acquired admission first are ahead of Close and drain; commands
            // that acquire it later observe `closing` and are rejected.
            let _admission = self.shared.admission.lock().map_err(|_| {
                Error::Engine("database command admission lock was poisoned".to_owned())
            })?;
            let mut close = self
                .shared
                .close_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(result) = &close.terminal_result {
                return result.clone();
            }
            if close.in_progress {
                close.waiters.push(reply);
            } else {
                close.in_progress = true;
                close.waiters.push(reply);
                self.shared.closing.store(true, Ordering::SeqCst);
                if let Err(error) = self.shared.queue.send(Command::Close) {
                    drop(close);
                    complete_terminal_close(&self.shared, Err(error));
                }
            }
        }
        receiver.await
    }

    fn send(&self, command: Command) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let _admission = self.shared.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.shared.closed.load(Ordering::SeqCst) || self.shared.closing.load(Ordering::SeqCst) {
            return Err(Error::EngineStopped);
        }
        if self.shared.transaction_poisoned.load(Ordering::SeqCst) {
            return Err(Error::Engine(
                "transaction state is unknown; close the database".to_owned(),
            ));
        }
        self.shared.queue.send(command)
    }

    /// COMMIT and ROLLBACK are required settlement for an existing pin, not
    /// new application work. A transaction whose BEGIN was admitted before a
    /// close cutoff must still be able to enqueue that settlement behind the
    /// cutoff. The owner validates the pin token when the command reaches it.
    fn send_transaction_settlement(&self, command: Command) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let _admission = self.shared.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.shared.closed.load(Ordering::SeqCst)
            || self.shared.teardown_started.load(Ordering::SeqCst)
        {
            return Err(Error::EngineStopped);
        }
        self.shared.queue.send(command)
    }

    /// Cleanup stays admissible after poisoning or a close cutoff and does not
    /// consume ordinary queue capacity. It retains FIFO order with
    /// already-admitted SQL and Close; the owner decides whether Close can
    /// proceed before later transaction cleanup.
    fn send_cleanup(&self, command: Command) -> Result<()> {
        let _admission = self.shared.admission.lock().map_err(|_| {
            Error::Engine("database command admission lock was poisoned".to_owned())
        })?;
        if self.shared.closed.load(Ordering::SeqCst)
            || self.shared.teardown_started.load(Ordering::SeqCst)
        {
            return Err(Error::EngineStopped);
        }
        self.shared.queue.send(command)
    }

    fn ensure_not_owner_thread(&self) -> Result<()> {
        if self
            .shared
            .owner_thread
            .get()
            .is_some_and(|owner| *owner == thread::current().id())
        {
            return Err(Error::Engine(
                "reentrant database work from a raw-stream callback is not supported".to_owned(),
            ));
        }
        Ok(())
    }
}

impl Drop for EngineExecutor {
    fn drop(&mut self) {
        if self.shared.closed.load(Ordering::SeqCst) {
            return;
        }
        // Dropping JoinHandle detaches in Rust; this executor intentionally
        // owns no handle to join. Final drop only establishes a terminal close
        // request and returns immediately.
        self.shared.terminal_drop.store(true, Ordering::SeqCst);
        schedule_terminal_drop_close(&self.shared);
    }
}

enum Command {
    Exec {
        request: ProtocolRequest,
        reply: reply::Sender<ProtocolResponse>,
    },
    StructuredExec {
        request: ProtocolRequest,
        operation: String,
        reply: reply::Sender<ProtocolResponse>,
    },
    PinnedExec {
        token: u64,
        request: ProtocolRequest,
        guard: Option<Arc<TransactionGuard>>,
        must_run: bool,
        reply: reply::Sender<ProtocolResponse>,
    },
    PinnedStructuredExec {
        token: u64,
        request: ProtocolRequest,
        operation: String,
        guard: Arc<TransactionGuard>,
        reply: reply::Sender<ProtocolResponse>,
    },
    Stream {
        request: ProtocolRequest,
        on_chunk: ProtocolChunkCallback,
        reply: reply::Sender<()>,
    },
    PinnedStream {
        token: u64,
        request: ProtocolRequest,
        on_chunk: ProtocolChunkCallback,
        guard: Option<Arc<TransactionGuard>>,
        reply: reply::Sender<()>,
    },
    Begin {
        reply: reply::Sender<u64>,
    },
    ReleasePin {
        token: u64,
        reply: Option<reply::Sender<()>>,
    },
    RollbackAndReleasePin {
        token: u64,
    },
    Backup {
        reply: reply::Sender<Vec<u8>>,
    },
    Close,
}

impl Command {
    fn is_ordinary(&self) -> bool {
        !matches!(
            self,
            Self::PinnedExec { must_run: true, .. }
                | Self::ReleasePin { .. }
                | Self::RollbackAndReleasePin { .. }
                | Self::Close
        )
    }

    fn is_abandoned(&self) -> bool {
        match self {
            Self::Exec { reply, .. }
            | Self::StructuredExec { reply, .. }
            | Self::PinnedStructuredExec { reply, .. } => reply.is_abandoned(),
            Self::PinnedExec {
                must_run: false,
                reply,
                ..
            } => reply.is_abandoned(),
            Self::Stream { reply, .. } | Self::PinnedStream { reply, .. } => reply.is_abandoned(),
            Self::Begin { reply } => reply.is_abandoned(),
            Self::Backup { reply } => reply.is_abandoned(),
            Self::PinnedExec { must_run: true, .. }
            | Self::ReleasePin { .. }
            | Self::RollbackAndReleasePin { .. }
            | Self::Close => false,
        }
    }
}

struct OwnerState {
    active_pin: Option<u64>,
    next_pin: u64,
}

enum OwnerAction {
    Continue,
    RetryableClose(Error),
    TerminalClose(Result<()>),
}

fn owner_thread<M, F>(
    shared: Arc<ExecutorShared>,
    opened: reply::Sender<M>,
    operation: F,
    thread_name: &'static str,
) where
    M: Send + 'static,
    F: FnOnce() -> Result<(Box<dyn EngineSession>, M)>,
{
    let _ = shared.owner_thread.set(thread::current().id());
    let opened_session = catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|panic| {
        Err(Error::Engine(format!(
            "{thread_name} panicked while opening: {}",
            panic_message(panic.as_ref())
        )))
    });
    let (session, metadata) = match opened_session {
        Ok(opened_session) => opened_session,
        Err(error) => {
            opened.send(Err(error));
            stop_owner(&shared);
            return;
        }
    };
    let cancel = match catch_unwind(AssertUnwindSafe(|| session.cancel_handle())) {
        Ok(cancel) => cancel,
        Err(panic) => {
            opened.send(Err(Error::Engine(format!(
                "{thread_name} panicked while obtaining its cancellation handle: {}",
                panic_message(panic.as_ref())
            ))));
            dispose_session_after_owner_failure(session);
            stop_owner(&shared);
            return;
        }
    };
    *shared
        .cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = cancel;
    let mut session = Some(session);
    if !opened.send(Ok(metadata)) {
        dispose_session_after_owner_failure(session.take().expect("opened session"));
        stop_owner(&shared);
        return;
    }

    let mut owner = OwnerState {
        active_pin: None,
        next_pin: 1,
    };
    while let Some(command) = shared.queue.receive() {
        if command.is_abandoned() {
            continue;
        }
        let action = catch_unwind(AssertUnwindSafe(|| {
            execute_command(
                session.as_mut().expect("owner session exists").as_mut(),
                &shared,
                &mut owner,
                command,
            )
        }));
        match action {
            Ok(OwnerAction::Continue) => {}
            Ok(OwnerAction::RetryableClose(error)) => {
                complete_retryable_close(&shared, error);
                // Final EngineExecutor drop may race with validation after the
                // owner has already observed `terminal_drop == false`. Recheck
                // after reopening the attempt so the last handle cannot leave
                // an owner thread and transaction pin stranded.
                schedule_terminal_drop_close(&shared);
            }
            Ok(OwnerAction::TerminalClose(result)) => {
                shared.session_pinned.store(false, Ordering::SeqCst);
                *shared
                    .cancel
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                let result = match result {
                    Ok(()) => {
                        // Drop the session and its root lock before resolving
                        // close. A destructor panic is still one terminal close
                        // outcome and must not strand or reopen the handle.
                        match catch_unwind(AssertUnwindSafe(|| drop(session.take()))) {
                            Ok(()) => Ok(()),
                            Err(panic) => Err(Error::Engine(format!(
                                "native engine session destructor panicked after close: {}",
                                panic_message(panic.as_ref())
                            ))),
                        }
                    }
                    Err(error) => {
                        // Teardown has already started, so the session cannot
                        // safely return to service. Retain any native ownership
                        // that its failed close may still hold through process
                        // exit instead of running a second implicit teardown.
                        std::mem::forget(session.take().expect("owner session exists"));
                        Err(error)
                    }
                };
                let pending = shared.queue.stop();
                drop(pending);
                complete_terminal_close(&shared, result);
                return;
            }
            Err(_) => {
                dispose_session_after_owner_failure(session.take().expect("owner session exists"));
                stop_owner(&shared);
                return;
            }
        }
    }
    if let Some(session) = session.take() {
        dispose_session_after_owner_failure(session);
    }
    stop_owner(&shared);
}

fn execute_command(
    session: &mut dyn EngineSession,
    shared: &ExecutorShared,
    owner: &mut OwnerState,
    command: Command,
) -> OwnerAction {
    match command {
        Command::Exec { request, reply } => {
            let result = if owner.active_pin.is_some() {
                Err(Error::TransactionActive)
            } else {
                run_active_work(&shared.active_work, || session.exec_protocol_raw(request))
            };
            reply.send(result);
        }
        Command::StructuredExec {
            request,
            operation,
            reply,
        } => {
            let result = if owner.active_pin.is_some() {
                Err(Error::TransactionActive)
            } else {
                run_active_work(&shared.active_work, || {
                    execute_structured_operation(
                        session,
                        &shared.transaction_poisoned,
                        request,
                        &operation,
                    )
                })
            };
            reply.send(result);
        }
        Command::PinnedExec {
            token,
            request,
            guard,
            must_run: _,
            reply,
        } => {
            let result = if owner.active_pin == Some(token)
                && guard
                    .as_ref()
                    .is_none_or(|guard| guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE)
            {
                run_active_work(&shared.active_work, || session.exec_protocol_raw(request))
            } else {
                Err(inactive_transaction_error())
            };
            reply.send(result);
        }
        Command::PinnedStructuredExec {
            token,
            request,
            operation,
            guard,
            reply,
        } => {
            let result = if owner.active_pin == Some(token) {
                run_active_work(&shared.active_work, || {
                    execute_pinned_structured_operation(
                        session,
                        &shared.transaction_poisoned,
                        &guard,
                        request,
                        &operation,
                    )
                })
            } else {
                Err(inactive_transaction_error())
            };
            reply.send(result);
        }
        Command::Stream {
            request,
            on_chunk,
            reply,
        } => {
            let result = if owner.active_pin.is_some() {
                Err(Error::TransactionActive)
            } else {
                run_active_work(&shared.active_work, || {
                    execute_stream(session, request, on_chunk)
                })
            };
            reply.send(result);
        }
        Command::PinnedStream {
            token,
            request,
            on_chunk,
            guard,
            reply,
        } => {
            let result = if owner.active_pin == Some(token)
                && guard
                    .as_ref()
                    .is_none_or(|guard| guard.state.load(Ordering::SeqCst) == TRANSACTION_ACTIVE)
            {
                run_active_work(&shared.active_work, || {
                    execute_stream(session, request, on_chunk)
                })
            } else {
                Err(inactive_transaction_error())
            };
            reply.send(result);
        }
        Command::Begin { reply } => {
            if owner.active_pin.is_some() {
                reply.send(Err(Error::TransactionActive));
            } else {
                let result = allocate_pin(owner).and_then(|token| {
                    begin_transaction(session, &shared.transaction_poisoned).map(|()| token)
                });
                match result {
                    Ok(token) => {
                        owner.active_pin = Some(token);
                        shared.session_pinned.store(true, Ordering::SeqCst);
                        if !reply.send(Ok(token)) {
                            rollback_active_pin(session, shared, owner, token);
                        }
                    }
                    Err(error) => {
                        reply.send(Err(error));
                    }
                }
            }
        }
        Command::ReleasePin { token, reply } => {
            let result = if owner.active_pin == Some(token) {
                owner.active_pin = None;
                shared.session_pinned.store(false, Ordering::SeqCst);
                Ok(())
            } else {
                Err(inactive_transaction_error())
            };
            if let Some(reply) = reply {
                reply.send(result);
            }
        }
        Command::RollbackAndReleasePin { token } => {
            rollback_active_pin(session, shared, owner, token);
        }
        Command::Backup { reply } => {
            let result = if owner.active_pin.is_some() {
                Err(Error::TransactionActive)
            } else {
                run_active_work(&shared.active_work, || session.backup())
            };
            reply.send(result);
        }
        Command::Close => {
            if let Some(token) = owner.active_pin {
                if shared.terminal_drop.load(Ordering::SeqCst) {
                    rollback_active_pin(session, shared, owner, token);
                } else {
                    return OwnerAction::RetryableClose(Error::TransactionActive);
                }
            }
            // Cancellation is out of band, so the close command must establish
            // its destructive boundary under the same admission lock used by
            // cancel(). Before this point `closing` rejects only new ordinary
            // work; after it, both cancellation and ordinary work are terminal.
            {
                let _admission = match shared.admission.lock() {
                    Ok(admission) => admission,
                    Err(_) => {
                        return OwnerAction::TerminalClose(Err(Error::Engine(
                            "database command admission lock was poisoned".to_owned(),
                        )));
                    }
                };
                shared.teardown_started.store(true, Ordering::SeqCst);
            }
            let result = run_active_work(&shared.active_work, || {
                catch_unwind(AssertUnwindSafe(|| session.close())).unwrap_or_else(|panic| {
                    Err(Error::Engine(format!(
                        "native engine session panicked during close: {}",
                        panic_message(panic.as_ref())
                    )))
                })
            });
            return OwnerAction::TerminalClose(result);
        }
    }
    OwnerAction::Continue
}

fn allocate_pin(owner: &mut OwnerState) -> Result<u64> {
    let token = owner.next_pin;
    owner.next_pin = owner
        .next_pin
        .checked_add(1)
        .ok_or_else(|| Error::Engine("native transaction token space is exhausted".to_owned()))?;
    Ok(token)
}

fn begin_transaction(
    session: &mut dyn EngineSession,
    transaction_poisoned: &AtomicBool,
) -> Result<()> {
    let result = ProtocolRequest::simple_query("BEGIN")
        .and_then(|request| session.exec_protocol_raw(request))
        .and_then(|response| parse_simple_command_response(&response))
        .and_then(|result| {
            if result.command_tag() == Some("BEGIN")
                && result.ready_status() == ReadyStatus::InTransaction
            {
                Ok(())
            } else {
                Err(Error::Engine(format!(
                    "PostgreSQL transaction command expected BEGIN with InTransaction readiness, got {} with {:?}",
                    result.command_tag().unwrap_or("no command tag"),
                    result.ready_status()
                )))
            }
        });
    if result.is_ok() {
        return result;
    }
    let recovery = ProtocolRequest::simple_query("ROLLBACK")
        .and_then(|request| session.exec_protocol_raw(request))
        .and_then(|response| parse_simple_command_response(&response));
    let recovered = recovery.is_ok_and(|result| {
        result.command_tag() == Some("ROLLBACK") && result.ready_status() == ReadyStatus::Idle
    });
    if !recovered {
        transaction_poisoned.store(true, Ordering::SeqCst);
    }
    result
}

fn rollback_active_pin(
    session: &mut dyn EngineSession,
    shared: &ExecutorShared,
    owner: &mut OwnerState,
    token: u64,
) {
    if owner.active_pin != Some(token) {
        return;
    }
    let rollback = run_active_work(&shared.active_work, || {
        ProtocolRequest::simple_query("ROLLBACK")
            .and_then(|request| session.exec_protocol_raw(request))
            .and_then(|response| parse_simple_command_response(&response))
    });
    let confirmed = rollback.is_ok_and(|result| {
        result.command_tag() == Some("ROLLBACK") && result.ready_status() == ReadyStatus::Idle
    });
    if !confirmed {
        shared.transaction_poisoned.store(true, Ordering::SeqCst);
    }
    owner.active_pin = None;
    shared.session_pinned.store(false, Ordering::SeqCst);
}

fn execute_stream(
    session: &mut dyn EngineSession,
    request: ProtocolRequest,
    mut on_chunk: ProtocolChunkCallback,
) -> Result<()> {
    let mut guarded = |chunk: &[u8]| {
        catch_unwind(AssertUnwindSafe(|| on_chunk(chunk))).unwrap_or_else(|panic| {
            Err(Error::Engine(format!(
                "raw protocol stream callback panicked: {}",
                panic_message(panic.as_ref())
            )))
        })
    };
    session.exec_protocol_raw_stream(request, &mut guarded)
}

fn complete_retryable_close(shared: &ExecutorShared, error: Error) {
    let waiters = {
        let mut close = shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        close.in_progress = false;
        shared.closing.store(false, Ordering::SeqCst);
        std::mem::take(&mut close.waiters)
    };
    for waiter in waiters {
        waiter.send(Err(error.clone()));
    }
}

fn complete_terminal_close(shared: &ExecutorShared, result: Result<()>) {
    let (result, waiters) = {
        let mut close = shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let result = close
            .terminal_result
            .get_or_insert_with(|| result.clone())
            .clone();
        close.in_progress = false;
        shared.closing.store(false, Ordering::SeqCst);
        shared.closed.store(true, Ordering::SeqCst);
        (result, std::mem::take(&mut close.waiters))
    };
    for waiter in waiters {
        waiter.send(result.clone());
    }
}

fn schedule_terminal_drop_close(shared: &ExecutorShared) {
    if !shared.terminal_drop.load(Ordering::SeqCst) {
        return;
    }
    let send_error = {
        let mut close = shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if close.terminal_result.is_none() && !close.in_progress {
            close.in_progress = true;
            shared.closing.store(true, Ordering::SeqCst);
            shared.queue.send(Command::Close).err()
        } else {
            None
        }
    };
    if let Some(error) = send_error {
        complete_terminal_close(shared, Err(error));
    }
}

fn stop_owner(shared: &ExecutorShared) {
    shared.active_work.store(false, Ordering::SeqCst);
    shared.teardown_started.store(true, Ordering::SeqCst);
    shared.session_pinned.store(false, Ordering::SeqCst);
    *shared
        .cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    let pending = shared.queue.stop();
    drop(pending);
    complete_terminal_close(shared, Err(Error::EngineStopped));
}

fn dispose_session_after_owner_failure(mut session: Box<dyn EngineSession>) {
    let closed =
        catch_unwind(AssertUnwindSafe(|| session.close())).is_ok_and(|result| result.is_ok());
    if closed {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(session)));
    } else {
        std::mem::forget(session);
    }
}

pub(crate) async fn run_off_thread<T, F>(thread_name: &'static str, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let (reply, receiver) = reply::channel();
    thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|panic| {
                Err(Error::Engine(format!(
                    "{thread_name} panicked: {}",
                    panic_message(panic.as_ref())
                )))
            });
            reply.send(result);
        })
        .map_err(|error| Error::Engine(format!("failed to start {thread_name}: {error}")))?;
    receiver.await
}

fn panic_message(panic: &(dyn Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = panic.downcast_ref::<&'static str>() {
        (*message).to_owned()
    } else {
        "unknown panic payload".to_owned()
    }
}

fn execute_structured_operation(
    session: &mut dyn EngineSession,
    transaction_poisoned: &AtomicBool,
    request: ProtocolRequest,
    operation: &str,
) -> Result<ProtocolResponse> {
    let response = match session.exec_protocol_raw(request) {
        Ok(response) => response,
        Err(error) => {
            transaction_poisoned.store(true, Ordering::SeqCst);
            return Err(error);
        }
    };
    let status = match response_ready_status(&response) {
        Ok(status) => status,
        Err(error) => {
            transaction_poisoned.store(true, Ordering::SeqCst);
            return Err(Error::Engine(format!(
                "{operation} returned an invalid readiness boundary and the embedded session is now unusable: {error}"
            )));
        }
    };
    if status == ReadyStatus::Idle {
        return Ok(response);
    }

    let recovery = ProtocolRequest::simple_query("ROLLBACK")
        .and_then(|rollback| session.exec_protocol_raw(rollback))
        .and_then(|response| parse_simple_command_response(&response));
    let recovered = recovery.as_ref().is_ok_and(|result| {
        result.command_tag() == Some("ROLLBACK") && result.ready_status() == ReadyStatus::Idle
    });
    if recovered {
        Ok(response)
    } else {
        transaction_poisoned.store(true, Ordering::SeqCst);
        Err(Error::Engine(format!(
            "{operation} left the embedded session in a transaction and rollback recovery failed: {}",
            recovery
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unexpected ROLLBACK response".to_owned())
        )))
    }
}

fn execute_pinned_structured_operation(
    session: &mut dyn EngineSession,
    transaction_poisoned: &AtomicBool,
    guard: &TransactionGuard,
    request: ProtocolRequest,
    operation: &str,
) -> Result<ProtocolResponse> {
    if guard.state.load(Ordering::SeqCst) != TRANSACTION_ACTIVE {
        return Err(inactive_transaction_error());
    }

    let response = match session.exec_protocol_raw(request) {
        Ok(response) => response,
        Err(error) => {
            fail_transaction_guard(guard, transaction_poisoned, error.clone());
            return Err(error);
        }
    };
    let status = match response_ready_status(&response) {
        Ok(status) => status,
        Err(error) => {
            let terminal = Error::Engine(format!(
                "{operation} returned an invalid readiness boundary and the transaction state is now unknown: {error}"
            ));
            fail_transaction_guard(guard, transaction_poisoned, terminal.clone());
            return Err(terminal);
        }
    };
    match status {
        ReadyStatus::InTransaction | ReadyStatus::FailedTransaction => Ok(response),
        ReadyStatus::Idle => {
            let terminal = Error::Engine(format!(
                "{operation} ended the callback transaction outside Transaction::rollback(); the session is now unusable"
            ));
            fail_transaction_guard(guard, transaction_poisoned, terminal.clone());
            Err(terminal)
        }
    }
}

fn fail_transaction_guard(
    guard: &TransactionGuard,
    transaction_poisoned: &AtomicBool,
    error: Error,
) {
    guard.fail(error);
    transaction_poisoned.store(true, Ordering::SeqCst);
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
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::task::{Context, Poll, Wake, Waker};
    use std::time::{Duration, Instant};

    use super::*;

    struct ThreadWake(thread::Thread);

    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    struct GateWake {
        gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    }

    impl GateWake {
        fn block_owner_once(&self) {
            let gate = self
                .gate
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some((started, release)) = gate {
                started.send(()).expect("announce gated wake");
                release.recv().expect("release gated wake");
            }
        }
    }

    impl Wake for GateWake {
        fn wake(self: Arc<Self>) {
            self.block_owner_once();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.block_owner_once();
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
        let mut context = Context::from_waker(&waker);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => thread::park(),
            }
        }
    }

    fn poll_once<F: Future>(future: std::pin::Pin<&mut F>) -> Poll<F::Output> {
        let mut context = Context::from_waker(Waker::noop());
        future.poll(&mut context)
    }

    fn command_response(tag: &str, ready: u8) -> ProtocolResponse {
        let mut bytes = Vec::new();
        let mut body = tag.as_bytes().to_vec();
        body.push(0);
        push_backend_message(&mut bytes, b'C', &body);
        push_backend_message(&mut bytes, b'Z', &[ready]);
        ProtocolResponse::new(bytes)
    }

    fn push_backend_message(bytes: &mut Vec<u8>, tag: u8, body: &[u8]) {
        bytes.push(tag);
        bytes.extend_from_slice(&i32::try_from(body.len() + 4).unwrap().to_be_bytes());
        bytes.extend_from_slice(body);
    }

    struct EchoSession;

    impl EngineSession for EchoSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    #[test]
    fn open_constructs_the_session_on_its_permanent_owner_thread() {
        let caller = thread::current().id();
        let (executor, constructed_on) = block_on(EngineExecutor::open(
            "oliphaunt-owner-construction-test",
            || {
                Ok((
                    Box::new(EchoSession) as Box<dyn EngineSession>,
                    thread::current().id(),
                ))
            },
        ))
        .expect("owner opens");

        assert_ne!(caller, constructed_on);
        assert_eq!(executor.shared.owner_thread.get(), Some(&constructed_on));
        block_on(executor.close()).expect("owner closes");
    }

    #[test]
    fn open_panic_is_an_error_instead_of_a_stranded_future() {
        let error = block_on(EngineExecutor::open::<(), _>(
            "oliphaunt-owner-open-panic-test",
            || panic!("open panic probe"),
        ))
        .err()
        .expect("open panic is reported");

        assert_eq!(
            error,
            Error::Engine(
                "oliphaunt-owner-open-panic-test panicked while opening: open panic probe"
                    .to_owned()
            )
        );
    }

    struct DropSignalSession(Option<mpsc::Sender<()>>);

    impl EngineSession for DropSignalSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    impl Drop for DropSignalSession {
        fn drop(&mut self) {
            if let Some(dropped) = self.0.take() {
                let _ = dropped.send(());
            }
        }
    }

    #[test]
    fn abandoned_open_closes_a_session_that_finishes_late() {
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (dropped, dropped_rx) = mpsc::channel();
        let mut open = Box::pin(EngineExecutor::open(
            "oliphaunt-owner-abandoned-open-test",
            move || {
                started.send(()).expect("announce open");
                release_rx.recv().expect("release open");
                Ok((
                    Box::new(DropSignalSession(Some(dropped))) as Box<dyn EngineSession>,
                    (),
                ))
            },
        ));
        assert!(poll_once(open.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("open reaches owner");
        drop(open);
        release.send(()).expect("finish abandoned open");
        dropped_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("late session is closed and dropped");
    }

    struct PanickingSession;

    impl EngineSession for PanickingSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            panic!("injected owner command panic")
        }
    }

    #[test]
    fn owner_panic_wakes_active_and_future_operations() {
        let executor = EngineExecutor::spawn(Box::new(PanickingSession));
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            Err(Error::EngineStopped)
        );
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([2]))),
            Err(Error::EngineStopped)
        );
    }

    struct BlockingSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        dropped: Option<mpsc::Sender<()>>,
    }

    impl EngineSession for BlockingSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.send(()).expect("announce active owner work");
            self.release.recv().expect("release active owner work");
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    impl Drop for BlockingSession {
        fn drop(&mut self) {
            if let Some(dropped) = self.dropped.take() {
                let _ = dropped.send(());
            }
        }
    }

    #[test]
    fn close_cutoff_drains_the_bounded_fifo_and_rejects_later_work() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(BlockingSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
            dropped: None,
        }));

        let mut active = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([1])));
        assert!(poll_once(active.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first operation reaches owner");

        let mut queued = Vec::with_capacity(ORDINARY_QUEUE_CAPACITY);
        for value in 0..ORDINARY_QUEUE_CAPACITY {
            let mut future =
                Box::pin(executor.exec_protocol_raw(ProtocolRequest::new(value.to_le_bytes())));
            assert!(poll_once(future.as_mut()).is_pending());
            queued.push(future);
        }
        let mut overflow = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([9, 9, 9])));
        let Poll::Ready(Err(Error::Engine(message))) = poll_once(overflow.as_mut()) else {
            panic!("the bounded queue must reject excess ordinary work");
        };
        assert!(message.contains("command queue is full"));

        // Close is a control command and still enters the same FIFO after all
        // already-admitted ordinary work.
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());
        let mut after_cutoff = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([7, 7])));
        assert_eq!(
            poll_once(after_cutoff.as_mut()),
            Poll::Ready(Err(Error::EngineStopped))
        );

        // The first permit releases active work. The remaining permits may be
        // buffered, allowing every pre-cutoff command to run without depending
        // on scheduler timing in this test.
        for _ in 0..=ORDINARY_QUEUE_CAPACITY {
            release.send(()).expect("release admitted operation");
        }
        assert_eq!(
            block_on(active).expect("active work drains").as_bytes(),
            &[1]
        );
        for operation in queued {
            block_on(operation).expect("pre-cutoff queued work drains");
        }
        block_on(close).expect("reserved close command completes");
        assert_eq!(calls.load(Ordering::SeqCst), ORDINARY_QUEUE_CAPACITY + 1);
    }

    struct BlockingTransactionSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for BlockingTransactionSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    self.started.send(()).expect("announce blocking work");
                    self.release.recv().expect("release blocking work");
                    Ok(ProtocolResponse::new(request.as_bytes()))
                }
                1 => Ok(command_response("BEGIN", b'T')),
                2 => Ok(command_response("ROLLBACK", b'I')),
                call => panic!("unexpected transaction session call {call}"),
            }
        }
    }

    #[test]
    fn begin_admitted_before_close_runs_and_close_observes_its_pin() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(BlockingTransactionSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));

        let mut active = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([1])));
        assert!(poll_once(active.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first operation reaches owner");

        let mut begin = Box::pin(executor.begin_transaction());
        assert!(poll_once(begin.as_mut()).is_pending());
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());
        let mut later_begin = Box::pin(executor.begin_transaction());
        assert_eq!(
            poll_once(later_begin.as_mut()),
            Poll::Ready(Err(Error::EngineStopped))
        );

        release.send(()).expect("release first operation");
        block_on(active).expect("active operation drains");
        let token = block_on(begin).expect("pre-cutoff BEGIN runs");
        assert_eq!(block_on(close), Err(Error::TransactionActive));
        assert!(!executor.is_closed());
        assert!(executor.session_is_pinned());

        let rollback = block_on(executor.pinned_exec_protocol_control(
            token,
            ProtocolRequest::simple_query("ROLLBACK").expect("rollback request"),
        ))
        .expect("rollback after failed close");
        assert_eq!(
            parse_simple_command_response(&rollback)
                .expect("rollback response")
                .ready_status(),
            ReadyStatus::Idle
        );
        block_on(executor.release_pin(token)).expect("release transaction pin");
        block_on(executor.close()).expect("retry closes after transaction cleanup");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    struct PreCutoffSettlementSession {
        settlement_tag: &'static str,
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for PreCutoffSettlementSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    self.started.send(()).expect("announce blocking work");
                    self.release.recv().expect("release blocking work");
                    Ok(ProtocolResponse::new(request.as_bytes()))
                }
                1 => {
                    assert_eq!(
                        request.as_bytes(),
                        ProtocolRequest::simple_query("BEGIN")
                            .expect("BEGIN request")
                            .as_bytes()
                    );
                    Ok(command_response("BEGIN", b'T'))
                }
                2 => {
                    assert_eq!(
                        request.as_bytes(),
                        ProtocolRequest::simple_query(self.settlement_tag)
                            .expect("settlement request")
                            .as_bytes()
                    );
                    Ok(command_response(self.settlement_tag, b'I'))
                }
                call => panic!("unexpected pre-cutoff settlement call {call}"),
            }
        }
    }

    fn assert_pre_cutoff_begin_can_settle_after_close_cutoff(settlement_tag: &'static str) {
        use crate::database::Oliphaunt;

        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(PreCutoffSettlementSession {
            settlement_tag,
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));
        let database = Oliphaunt::from_executor(Arc::clone(&executor));

        let mut active = Box::pin(database.exec_protocol_raw([1]));
        assert!(poll_once(active.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first operation reaches owner");

        // The owner's wake for the BEGIN reply is synchronous. Gate that first
        // wake so this thread can poll the real transaction future through its
        // COMMIT/ROLLBACK admission while the owner is still before Close.
        let (begin_woke, begin_woke_rx) = mpsc::channel();
        let (release_owner, release_owner_rx) = mpsc::channel();
        let gate_waker = Waker::from(Arc::new(GateWake {
            gate: Mutex::new(Some((begin_woke, release_owner_rx))),
        }));
        let mut transaction = Box::pin(database.transaction(async |transaction| {
            if settlement_tag == "ROLLBACK" {
                transaction.rollback().await?;
            }
            Ok(())
        }));
        let mut gate_context = Context::from_waker(&gate_waker);
        assert!(transaction.as_mut().poll(&mut gate_context).is_pending());

        let mut close = Box::pin(database.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert!(executor.shared.closing.load(Ordering::SeqCst));

        release.send(()).expect("release first operation");
        block_on(active).expect("active operation drains");
        begin_woke_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("BEGIN reply wakes the transaction future");
        assert!(
            transaction
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );

        {
            let queue = executor
                .shared
                .queue
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert_eq!(queue.commands.len(), 2);
            assert!(matches!(queue.commands.front(), Some(Command::Close)));
            assert!(matches!(
                queue.commands.back(),
                Some(Command::PinnedExec { must_run: true, .. })
            ));
        }
        release_owner
            .send(())
            .expect("release owner after settlement admission");

        block_on(transaction).expect("callback transaction settles");
        assert_eq!(block_on(close), Err(Error::TransactionActive));
        assert!(!executor.is_closed());
        block_on(database.close()).expect("retry closes settled session");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn pre_cutoff_begin_can_commit_after_close_cutoff_without_deadlock() {
        assert_pre_cutoff_begin_can_settle_after_close_cutoff("COMMIT");
    }

    #[test]
    fn pre_cutoff_begin_can_rollback_after_close_cutoff_without_deadlock() {
        assert_pre_cutoff_begin_can_settle_after_close_cutoff("ROLLBACK");
    }

    struct TransactionControlSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for TransactionControlSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(command_response("BEGIN", b'T')),
                1 => {
                    self.started.send(()).expect("announce pinned work");
                    self.release.recv().expect("release pinned work");
                    Ok(ProtocolResponse::new(request.as_bytes()))
                }
                2 => Ok(command_response("ROLLBACK", b'I')),
                call => panic!("unexpected transaction-control session call {call}"),
            }
        }
    }

    #[test]
    fn transaction_control_admitted_before_close_is_not_retroactively_rejected() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(TransactionControlSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));

        let token = block_on(executor.begin_transaction()).expect("transaction begins");
        let guard = TransactionGuard::active();
        let mut pinned = Box::pin(executor.pinned_exec_protocol_raw_guarded(
            token,
            ProtocolRequest::new([1]),
            guard,
        ));
        assert!(poll_once(pinned.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("pinned operation reaches owner");

        let mut rollback = Box::pin(executor.pinned_exec_protocol_control(
            token,
            ProtocolRequest::simple_query("ROLLBACK").expect("rollback request"),
        ));
        assert!(poll_once(rollback.as_mut()).is_pending());
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());

        release.send(()).expect("release pinned operation");
        block_on(pinned).expect("pinned operation drains");
        let rollback = block_on(rollback).expect("pre-cutoff rollback control runs");
        assert_eq!(
            parse_simple_command_response(&rollback)
                .expect("rollback response")
                .ready_status(),
            ReadyStatus::Idle
        );
        // The protocol transaction is idle, but the SDK pin is deliberately a
        // separate ownership boundary and is still active at Close.
        assert_eq!(block_on(close), Err(Error::TransactionActive));
        block_on(executor.release_pin(token)).expect("release transaction pin");
        block_on(executor.close()).expect("retry closes released session");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    struct FailedBeginAfterBlockSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for FailedBeginAfterBlockSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    self.started.send(()).expect("announce blocking work");
                    self.release.recv().expect("release blocking work");
                    Ok(ProtocolResponse::new(request.as_bytes()))
                }
                1 => Err(Error::Engine("injected BEGIN failure".to_owned())),
                2 => Ok(command_response("ROLLBACK", b'I')),
                call => panic!("unexpected failed-begin session call {call}"),
            }
        }
    }

    #[test]
    fn failed_pre_cutoff_begin_recovers_before_close_proceeds() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(FailedBeginAfterBlockSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));

        let mut active = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([1])));
        assert!(poll_once(active.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first operation reaches owner");
        let mut begin = Box::pin(executor.begin_transaction());
        assert!(poll_once(begin.as_mut()).is_pending());
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());

        release.send(()).expect("release first operation");
        block_on(active).expect("active operation drains");
        assert_eq!(
            block_on(begin),
            Err(Error::Engine("injected BEGIN failure".to_owned()))
        );
        block_on(close).expect("recovered BEGIN failure leaves close safe");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn abandoned_pre_cutoff_begin_is_skipped_before_close() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(BlockingTransactionSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));

        let mut active = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([1])));
        assert!(poll_once(active.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first operation reaches owner");
        let mut begin = Box::pin(executor.begin_transaction());
        assert!(poll_once(begin.as_mut()).is_pending());
        drop(begin);
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());

        release.send(()).expect("release first operation");
        block_on(active).expect("active operation drains");
        block_on(close).expect("abandoned BEGIN does not create a pin");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    struct BlockingBeginSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for BlockingBeginSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    self.started.send(()).expect("announce BEGIN execution");
                    self.release.recv().expect("release BEGIN execution");
                    Ok(command_response("BEGIN", b'T'))
                }
                1 => Ok(command_response("ROLLBACK", b'I')),
                call => panic!("unexpected blocking-begin session call {call}"),
            }
        }
    }

    #[test]
    fn begin_abandoned_during_execution_rolls_back_before_close() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(BlockingBeginSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));

        let mut begin = Box::pin(executor.begin_transaction());
        assert!(poll_once(begin.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("BEGIN reaches PostgreSQL");
        drop(begin);
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());

        release.send(()).expect("finish abandoned BEGIN");
        block_on(close).expect("owner rolls back abandoned BEGIN before close");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn final_drop_never_joins_a_blocked_owner() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (dropped, dropped_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(BlockingSession {
            calls,
            started,
            release: release_rx,
            dropped: Some(dropped),
        }));
        let mut operation = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([1, 2, 3])));
        assert!(poll_once(operation.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("owner operation starts");
        drop(operation);

        let started_drop = Instant::now();
        drop(executor);
        assert!(
            started_drop.elapsed() < Duration::from_millis(100),
            "final drop synchronously waited for the owner"
        );

        release.send(()).expect("release detached owner");
        dropped_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("detached owner eventually closed and dropped the session");
    }

    #[test]
    fn final_drop_racing_retryable_validation_requeues_terminal_cleanup() {
        let shared = ExecutorShared::new();
        shared.terminal_drop.store(true, Ordering::SeqCst);
        shared.closing.store(true, Ordering::SeqCst);
        shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .in_progress = true;

        // Model the owner having observed a non-terminal explicit close just
        // before the final handle marked terminal_drop. Completion must recheck
        // that bit and schedule a new close rather than leaving the owner idle.
        complete_retryable_close(&shared, Error::TransactionActive);
        schedule_terminal_drop_close(&shared);

        assert!(shared.closing.load(Ordering::SeqCst));
        assert!(
            shared
                .close_state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .in_progress
        );
        assert!(matches!(shared.queue.receive(), Some(Command::Close)));
    }

    struct StreamSession {
        calls: Arc<AtomicUsize>,
    }

    impl EngineSession for StreamSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn exec_protocol_raw_stream(
            &mut self,
            _request: ProtocolRequest,
            on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
        ) -> Result<()> {
            on_chunk(&[1, 2, 3])
        }
    }

    #[test]
    fn callback_panic_is_contained_and_the_session_remains_usable() {
        let calls = Arc::new(AtomicUsize::new(0));
        let executor = EngineExecutor::spawn(Box::new(StreamSession {
            calls: Arc::clone(&calls),
        }));

        let error = block_on(
            executor.exec_protocol_raw_stream(ProtocolRequest::new([1]), |_| {
                panic!("callback panic probe")
            }),
        )
        .expect_err("callback panic is returned");
        assert!(error.to_string().contains("stream callback panicked"));
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([7])))
                .expect("session remains usable")
                .as_bytes(),
            &[7]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        block_on(executor.close()).expect("close stream session");
    }

    #[test]
    fn callback_reentrancy_fails_immediately_instead_of_deadlocking() {
        let executor = EngineExecutor::spawn(Box::new(StreamSession {
            calls: Arc::new(AtomicUsize::new(0)),
        }));
        let reentrant = Arc::clone(&executor);
        block_on(
            executor.exec_protocol_raw_stream(ProtocolRequest::new([1]), move |_| {
                let error = block_on(reentrant.exec_protocol_raw(ProtocolRequest::new([2])))
                    .expect_err("reentrant owner work is rejected");
                assert!(error.to_string().contains("reentrant database work"));
                let error = block_on(reentrant.pinned_exec_protocol_control(
                    1,
                    ProtocolRequest::simple_query("COMMIT").expect("control request"),
                ))
                .expect_err("reentrant transaction settlement is rejected");
                assert!(error.to_string().contains("reentrant database work"));
                let error = block_on(reentrant.close())
                    .expect_err("reentrant pre-teardown close is rejected");
                assert!(error.to_string().contains("reentrant database work"));
                assert!(!reentrant.is_closed());
                Ok(())
            }),
        )
        .expect("outer stream remains usable");
        assert!(!executor.is_closed());
        block_on(executor.close()).expect("close stream session");
    }

    struct BlockingCancel {
        started: Mutex<Option<mpsc::Sender<thread::ThreadId>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl EngineCancel for BlockingCancel {
        fn cancel(&self) -> Result<()> {
            if let Some(started) = self
                .started
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                started
                    .send(thread::current().id())
                    .expect("announce cancellation thread");
            }
            self.release
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .recv()
                .expect("release cancellation");
            Ok(())
        }
    }

    struct CancellableSession {
        cancel: Arc<BlockingCancel>,
    }

    impl EngineSession for CancellableSession {
        fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
            let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
            Some(cancel)
        }

        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    #[test]
    fn cancellation_transport_work_is_async_and_out_of_band() {
        let caller = thread::current().id();
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(CancellableSession {
            cancel: Arc::new(BlockingCancel {
                started: Mutex::new(Some(started)),
                release: Mutex::new(release_rx),
            }),
        }));

        let mut cancel = Box::pin(executor.cancel());
        assert!(poll_once(cancel.as_mut()).is_pending());
        let cancellation_thread = started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancellation starts without blocking the poller");
        assert_ne!(caller, cancellation_thread);
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([8])))
                .expect("ordinary owner work is not queued behind cancellation")
                .as_bytes(),
            &[8]
        );
        release.send(()).expect("finish cancellation");
        block_on(cancel).expect("cancellation completes");
        block_on(executor.close()).expect("close cancellable session");
    }

    struct CountingCancel {
        calls: AtomicUsize,
    }

    impl EngineCancel for CountingCancel {
        fn cancel(&self) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct DrainingCancellableSession {
        cancel: Arc<CountingCancel>,
        query_started: mpsc::Sender<()>,
        query_release: mpsc::Receiver<()>,
    }

    impl EngineSession for DrainingCancellableSession {
        fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
            let cancel: Arc<dyn EngineCancel> = self.cancel.clone();
            Some(cancel)
        }

        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.query_started.send(()).expect("announce active query");
            self.query_release.recv().expect("release active query");
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    #[test]
    fn cancellation_remains_admissible_after_close_cutoff_while_query_drains() {
        let cancel = Arc::new(CountingCancel {
            calls: AtomicUsize::new(0),
        });
        let (query_started, query_started_rx) = mpsc::channel();
        let (query_release, query_release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(DrainingCancellableSession {
            cancel: Arc::clone(&cancel),
            query_started,
            query_release: query_release_rx,
        }));

        let mut query = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([8])));
        assert!(poll_once(query.as_mut()).is_pending());
        query_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("query reaches the owner");

        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert!(executor.shared.closing.load(Ordering::SeqCst));
        assert!(!executor.shared.teardown_started.load(Ordering::SeqCst));

        block_on(executor.cancel()).expect("cancel remains out of band after the close cutoff");
        assert_eq!(cancel.calls.load(Ordering::SeqCst), 1);

        query_release.send(()).expect("finish the active query");
        block_on(query).expect("pre-cutoff query drains");
        block_on(close).expect("close runs after the query");
        assert!(executor.shared.teardown_started.load(Ordering::SeqCst));
        assert_eq!(block_on(executor.cancel()), Err(Error::EngineStopped));
        assert_eq!(cancel.calls.load(Ordering::SeqCst), 1);
    }

    struct InjectedTopologyCloseFailureSession {
        topology: &'static str,
        close_attempts: Arc<AtomicUsize>,
    }

    impl EngineSession for InjectedTopologyCloseFailureSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            self.close_attempts.fetch_add(1, Ordering::SeqCst);
            Err(Error::Engine(format!(
                "injected {} teardown failure",
                self.topology
            )))
        }
    }

    fn assert_topology_close_failure_is_terminal(topology: &'static str) {
        // Direct, broker, and server sessions converge at this EngineSession
        // boundary. Inject each topology's teardown error here so the shared
        // lifecycle state machine is tested without native libraries or child
        // processes making the failure nondeterministic.
        let attempts = Arc::new(AtomicUsize::new(0));
        let executor = EngineExecutor::spawn(Box::new(InjectedTopologyCloseFailureSession {
            topology,
            close_attempts: Arc::clone(&attempts),
        }));
        let expected = Error::Engine(format!("injected {topology} teardown failure"));
        assert_eq!(block_on(executor.close()), Err(expected.clone()));
        assert!(executor.is_closed());
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([4]))),
            Err(Error::EngineStopped)
        );
        assert_eq!(block_on(executor.close()), Err(expected.clone()));
        assert_eq!(block_on(executor.close()), Err(expected));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn direct_teardown_failure_terminally_retires_the_handle() {
        assert_topology_close_failure_is_terminal("direct");
    }

    #[test]
    fn broker_teardown_failure_terminally_retires_the_handle() {
        assert_topology_close_failure_is_terminal("broker");
    }

    #[test]
    fn server_teardown_failure_terminally_retires_the_handle() {
        assert_topology_close_failure_is_terminal("server");
    }

    struct PanickingCloseSession;

    impl EngineSession for PanickingCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            panic!("injected close panic");
        }
    }

    #[test]
    fn close_panic_is_one_exact_terminal_outcome() {
        let executor = EngineExecutor::spawn(Box::new(PanickingCloseSession));
        let expected = Error::Engine(
            "native engine session panicked during close: injected close panic".to_owned(),
        );

        assert_eq!(block_on(executor.close()), Err(expected.clone()));
        assert!(executor.is_closed());
        assert_eq!(block_on(executor.close()), Err(expected));
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            Err(Error::EngineStopped)
        );
    }

    struct PanickingDropSession;

    impl EngineSession for PanickingDropSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }
    }

    impl Drop for PanickingDropSession {
        fn drop(&mut self) {
            panic!("injected session destructor panic");
        }
    }

    #[test]
    fn destructor_panic_fails_close_without_stranding_its_waiter() {
        let executor = EngineExecutor::spawn(Box::new(PanickingDropSession));
        let expected = Error::Engine(
            "native engine session destructor panicked after close: injected session destructor panic"
                .to_owned(),
        );
        assert_eq!(block_on(executor.close()), Err(expected.clone()));
        assert!(executor.is_closed());
        assert_eq!(block_on(executor.close()), Err(expected));
        assert_eq!(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            Err(Error::EngineStopped)
        );
    }

    struct CoalescingCloseSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        closed: Arc<AtomicBool>,
    }

    impl EngineSession for CoalescingCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.send(()).expect("announce close");
            self.release.recv().expect("release close");
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn concurrent_close_calls_coalesce_onto_one_definitive_attempt() {
        let calls = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(CoalescingCloseSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
            closed: Arc::clone(&closed),
        }));

        let first_executor = Arc::clone(&executor);
        let first = thread::spawn(move || block_on(first_executor.close()));
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first close reaches owner");
        let second_executor = Arc::clone(&executor);
        let second = thread::spawn(move || block_on(second_executor.close()));
        let deadline = Instant::now() + Duration::from_secs(2);
        while executor
            .shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .waiters
            .len()
            < 2
            && Instant::now() < deadline
        {
            thread::yield_now();
        }
        release.send(()).expect("finish close");

        first
            .join()
            .expect("join first close")
            .expect("first close");
        second
            .join()
            .expect("join second close")
            .expect("second close");
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    struct CoalescingFailedCloseSession {
        calls: Arc<AtomicUsize>,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EngineSession for CoalescingFailedCloseSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn close(&mut self) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.send(()).expect("announce failed close");
            self.release.recv().expect("release failed close");
            Err(Error::Engine(
                "injected concurrent teardown failure".to_owned(),
            ))
        }
    }

    #[test]
    fn concurrent_and_repeated_failed_closes_share_one_exact_terminal_outcome() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(CoalescingFailedCloseSession {
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));
        let expected = Error::Engine("injected concurrent teardown failure".to_owned());

        let first_executor = Arc::clone(&executor);
        let first = thread::spawn(move || block_on(first_executor.close()));
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first close reaches owner");
        let second_executor = Arc::clone(&executor);
        let second = thread::spawn(move || block_on(second_executor.close()));
        let deadline = Instant::now() + Duration::from_secs(2);
        while executor
            .shared
            .close_state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .waiters
            .len()
            < 2
            && Instant::now() < deadline
        {
            thread::yield_now();
        }
        assert_eq!(
            executor
                .shared
                .close_state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .waiters
                .len(),
            2,
            "second close must join the in-flight attempt before it resolves"
        );
        release.send(()).expect("finish failed close");

        assert_eq!(
            first.join().expect("join first close"),
            Err(expected.clone())
        );
        assert_eq!(
            second.join().expect("join second close"),
            Err(expected.clone())
        );
        assert!(executor.is_closed());
        assert_eq!(block_on(executor.close()), Err(expected));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
