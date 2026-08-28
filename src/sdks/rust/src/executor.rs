use std::any::Any;
use std::collections::VecDeque;
use std::future::poll_fn;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::thread;

use crate::cancellation::CancellationGate;
use crate::engine::{EngineSession, ProtocolStreamOutcome};
use crate::error::{Error, Result, SESSION_STATE_UNKNOWN};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{ReadyStatus, parse_simple_command_response};
use crate::reply;
use crate::session::{
    TransactionGuard, begin_transaction, execute_structured_operation,
    execute_transaction_structured_operation, inactive_transaction_error,
};

type ProtocolChunkCallback = Box<dyn FnMut(&[u8]) -> Result<()> + Send>;

pub(crate) enum ExecutorStreamOutcome {
    ReadyForQuery(Result<()>),
    CallbackPanicked(Error),
    SessionStateUnknown(Error),
}

impl ExecutorStreamOutcome {
    #[cfg(test)]
    fn into_result(self) -> Result<()> {
        match self {
            Self::ReadyForQuery(result) => result,
            Self::CallbackPanicked(error) | Self::SessionStateUnknown(error) => Err(error),
        }
    }
}

/// Ordinary application work is bounded. Lifecycle and transaction-recovery
/// commands share the same FIFO but do not consume this capacity, so cleanup
/// can always be admitted without inventing a public queue-tuning surface.
const ORDINARY_QUEUE_CAPACITY: usize = 256;

pub(crate) struct EngineExecutor {
    shared: Arc<ExecutorShared>,
}

struct ExecutorShared {
    queue: CommandQueue,
    // SQL admission and the owner-side transition into teardown share this
    // lock. Out-of-band cancellation has its own counted lifecycle gate.
    admission: Mutex<()>,
    cancellation: Arc<CancellationGate>,
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
            cancellation: CancellationGate::pending(),
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
    admission_waiters: VecDeque<AdmissionWaiter>,
    stopped: bool,
}

struct AdmissionWaiter {
    token: Arc<AdmissionToken>,
    waker: Waker,
}

struct AdmissionToken {
    rejected: AtomicBool,
}

struct AdmissionRegistration<'queue> {
    queue: &'queue CommandQueue,
    // The uncontended path does not allocate. A stable token is created only
    // if this operation actually has to join the capacity-waiter FIFO.
    token: Option<Arc<AdmissionToken>>,
}

impl<'queue> AdmissionRegistration<'queue> {
    fn new(queue: &'queue CommandQueue) -> Self {
        Self { queue, token: None }
    }
}

impl Drop for AdmissionRegistration<'_> {
    fn drop(&mut self) {
        if let Some(token) = &self.token {
            self.queue.cancel_admission(token);
        }
    }
}

impl CommandQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(CommandQueueState {
                commands: VecDeque::new(),
                ordinary_count: 0,
                admission_waiters: VecDeque::new(),
                stopped: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn send_control(&self, command: Command) -> Result<()> {
        debug_assert!(!command.is_ordinary());
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(Error::EngineStopped);
        }
        state.commands.push_back(command);
        self.ready.notify_one();
        Ok(())
    }

    fn poll_send_ordinary(
        &self,
        token: &mut Option<Arc<AdmissionToken>>,
        command: &mut Option<Command>,
        cx: &mut Context<'_>,
    ) -> (Poll<Result<()>>, Option<Waker>) {
        debug_assert!(command.as_ref().is_some_and(Command::is_ordinary));
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped
            || token
                .as_ref()
                .is_some_and(|token| token.rejected.load(Ordering::SeqCst))
        {
            return (Poll::Ready(Err(Error::EngineStopped)), None);
        }

        let position = token.as_ref().and_then(|token| {
            state
                .admission_waiters
                .iter()
                .position(|waiter| Arc::ptr_eq(&waiter.token, token))
        });
        let is_next = match position {
            Some(0) => true,
            Some(_) => false,
            None => state.admission_waiters.is_empty(),
        };
        if state.ordinary_count < ORDINARY_QUEUE_CAPACITY && is_next {
            if position.is_some() {
                state.admission_waiters.pop_front();
            }
            state.ordinary_count += 1;
            state
                .commands
                .push_back(command.take().expect("ordinary command is admitted once"));
            let next = (state.ordinary_count < ORDINARY_QUEUE_CAPACITY)
                .then(|| {
                    state
                        .admission_waiters
                        .front()
                        .map(|waiter| waiter.waker.clone())
                })
                .flatten();
            self.ready.notify_one();
            return (Poll::Ready(Ok(())), next);
        }

        let token = token.get_or_insert_with(|| {
            Arc::new(AdmissionToken {
                rejected: AtomicBool::new(false),
            })
        });
        match position {
            Some(position) => {
                let waiter = &mut state.admission_waiters[position];
                if !waiter.waker.will_wake(cx.waker()) {
                    waiter.waker = cx.waker().clone();
                }
            }
            None => state.admission_waiters.push_back(AdmissionWaiter {
                token: Arc::clone(token),
                waker: cx.waker().clone(),
            }),
        }
        (Poll::Pending, None)
    }

    fn cancel_admission(&self, token: &Arc<AdmissionToken>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(position) = state
            .admission_waiters
            .iter()
            .position(|waiter| Arc::ptr_eq(&waiter.token, token))
        else {
            return;
        };
        let was_next = position == 0;
        state.admission_waiters.remove(position);
        let next = (was_next && state.ordinary_count < ORDINARY_QUEUE_CAPACITY)
            .then(|| {
                state
                    .admission_waiters
                    .front()
                    .map(|waiter| waiter.waker.clone())
            })
            .flatten();
        drop(state);
        if let Some(waker) = next {
            waker.wake();
        }
    }

    fn reject_admissions(&self) -> Vec<Waker> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state
            .admission_waiters
            .drain(..)
            .map(|waiter| {
                waiter.token.rejected.store(true, Ordering::SeqCst);
                waiter.waker
            })
            .collect()
    }

    fn receive(&self) -> Option<Command> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(command) = state.commands.pop_front() {
                if command.is_ordinary() {
                    state.ordinary_count -= 1;
                }
                let next = state
                    .admission_waiters
                    .front()
                    .map(|waiter| waiter.waker.clone());
                drop(state);
                if let Some(waker) = next {
                    waker.wake();
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
        let wakers = state
            .admission_waiters
            .drain(..)
            .map(|waiter| {
                waiter.token.rejected.store(true, Ordering::SeqCst);
                waiter.waker
            })
            .collect::<Vec<_>>();
        self.ready.notify_all();
        drop(state);
        for waker in wakers {
            waker.wake();
        }
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
        // `closing` is only an ordinary-work cutoff. Cancellation is
        // out-of-band and remains useful while already-admitted SQL drains.
        // The counted cancellation gate orders this request exactly before or
        // after destructive teardown and lets close wait for admitted calls.
        let cancellation = self.shared.cancellation.admit()?;
        run_off_thread("oliphaunt-cancel", move || cancellation.cancel()).await
    }

    pub(crate) async fn exec_protocol_raw(
        &self,
        request: ProtocolRequest,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Exec { request, reply }).await?;
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
        })
        .await?;
        receiver.await
    }

    pub(crate) async fn pinned_exec_protocol_control(
        &self,
        token: u64,
        request: ProtocolRequest,
        guard: Arc<TransactionGuard>,
    ) -> Result<ProtocolResponse> {
        let (reply, receiver) = reply::channel();
        let command = Command::PinnedExec {
            token,
            request,
            guard,
            reply,
        };
        self.send_transaction_settlement(command)?;
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
        })
        .await?;
        receiver.await
    }

    #[cfg(test)]
    pub(crate) async fn exec_protocol_raw_stream<F>(
        &self,
        request: ProtocolRequest,
        on_chunk: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        self.exec_protocol_raw_stream_outcome(request, on_chunk)
            .await?
            .into_result()
    }

    pub(crate) async fn exec_protocol_raw_stream_outcome<F>(
        &self,
        request: ProtocolRequest,
        on_chunk: F,
    ) -> Result<ExecutorStreamOutcome>
    where
        F: FnMut(&[u8]) -> Result<()> + Send + 'static,
    {
        let (reply, receiver) = reply::channel();
        self.send(Command::Stream {
            request,
            on_chunk: Box::new(on_chunk),
            reply,
        })
        .await?;
        receiver.await
    }

    pub(crate) async fn begin_transaction(&self) -> Result<u64> {
        let (reply, receiver) = reply::channel();
        self.send(Command::Begin { reply }).await?;
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
        self.send(Command::Backup { reply }).await?;
        receiver.await
    }

    pub(crate) async fn close(&self) -> Result<()> {
        self.ensure_not_owner_thread()?;
        let (reply, receiver) = reply::channel();
        let mut rejected_admissions = Vec::new();
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
                // Mark every already-registered capacity waiter while the
                // admission cutoff is held. Waking is deferred until after the
                // lock is released so even a synchronous waker cannot deadlock.
                rejected_admissions = self.shared.queue.reject_admissions();
                if let Err(error) = self.shared.queue.send_control(Command::Close) {
                    drop(close);
                    complete_terminal_close(&self.shared, Err(error));
                }
            }
        }
        for waker in rejected_admissions {
            waker.wake();
        }
        receiver.await
    }

    async fn send(&self, command: Command) -> Result<()> {
        debug_assert!(command.is_ordinary());
        let mut registration = AdmissionRegistration::new(&self.shared.queue);
        let mut command = Some(command);
        poll_fn(|cx| {
            if let Err(error) = self.ensure_not_owner_thread() {
                return Poll::Ready(Err(error));
            }
            let (poll, next) = {
                let _admission = match self.shared.admission.lock() {
                    Ok(admission) => admission,
                    Err(_) => {
                        return Poll::Ready(Err(Error::Engine(
                            "database command admission lock was poisoned".to_owned(),
                        )));
                    }
                };
                if self.shared.closed.load(Ordering::SeqCst)
                    || self.shared.closing.load(Ordering::SeqCst)
                {
                    return Poll::Ready(Err(Error::EngineStopped));
                }
                if self.shared.transaction_poisoned.load(Ordering::SeqCst) {
                    return Poll::Ready(Err(Error::Engine(SESSION_STATE_UNKNOWN.to_owned())));
                }
                self.shared
                    .queue
                    .poll_send_ordinary(&mut registration.token, &mut command, cx)
            };
            if let Some(waker) = next {
                waker.wake();
            }
            poll
        })
        .await
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
        self.shared.queue.send_control(command)
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
        self.shared.queue.send_control(command)
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
        guard: Arc<TransactionGuard>,
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
        reply: reply::Sender<ExecutorStreamOutcome>,
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
            Self::PinnedExec { .. }
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
            Self::Stream { reply, .. } => reply.is_abandoned(),
            Self::Begin { reply } => reply.is_abandoned(),
            Self::Backup { reply } => reply.is_abandoned(),
            Self::PinnedExec { .. }
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
    if let Err(error) = shared.cancellation.install_target(cancel) {
        opened.send(Err(error));
        dispose_session_after_owner_failure(session);
        stop_owner(&shared);
        return;
    }
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
                shared.cancellation.stop_and_wait();
                dispose_session_after_owner_failure(session.take().expect("owner session exists"));
                stop_owner(&shared);
                return;
            }
        }
    }
    if let Some(session) = session.take() {
        shared.cancellation.stop_and_wait();
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
                run_active_work(&shared.active_work, || {
                    execute_raw_operation(session, request, &shared.transaction_poisoned, None)
                })
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
            reply,
        } => {
            let result = if owner.active_pin != Some(token) {
                Err(inactive_transaction_error())
            } else if shared.transaction_poisoned.load(Ordering::SeqCst) {
                Err(transaction_terminal_error(&guard)
                    .unwrap_or_else(|| Error::Engine(SESSION_STATE_UNKNOWN.to_owned())))
            } else {
                run_active_work(&shared.active_work, || {
                    execute_raw_operation(session, request, &shared.transaction_poisoned, None)
                })
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
                    execute_transaction_structured_operation(
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
                Ok(run_active_work(&shared.active_work, || {
                    execute_stream(session, request, on_chunk, &shared.transaction_poisoned)
                }))
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
            // `closing` has so far rejected only new ordinary work. Establish
            // the destructive boundary while SQL admission is excluded, then
            // release every lock and wait for out-of-band cancellations which
            // crossed their own gate first.
            let (admission, admission_poisoned) = match shared.admission.lock() {
                Ok(admission) => (admission, false),
                Err(error) => (error.into_inner(), true),
            };
            let cancellation_target = shared.cancellation.stop_accepting();
            shared.teardown_started.store(true, Ordering::SeqCst);
            drop(admission);
            drop(cancellation_target);
            shared.cancellation.wait_for_idle();
            if admission_poisoned {
                return OwnerAction::TerminalClose(Err(Error::Engine(
                    "database command admission lock was poisoned".to_owned(),
                )));
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

fn rollback_active_pin(
    session: &mut dyn EngineSession,
    shared: &ExecutorShared,
    owner: &mut OwnerState,
    token: u64,
) {
    if owner.active_pin != Some(token) {
        return;
    }
    if shared.transaction_poisoned.load(Ordering::SeqCst) {
        // The physical transaction boundary is unknown. Releasing the SDK pin
        // is safe, but sending ROLLBACK could act on a different protocol state
        // and would falsely imply recovery.
        owner.active_pin = None;
        shared.session_pinned.store(false, Ordering::SeqCst);
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

fn transaction_terminal_error(guard: &TransactionGuard) -> Option<Error> {
    guard
        .terminal_error
        .lock()
        .ok()
        .and_then(|error| error.as_ref().cloned())
}

fn execute_raw_operation(
    session: &mut dyn EngineSession,
    request: ProtocolRequest,
    transaction_poisoned: &AtomicBool,
    guard: Option<&TransactionGuard>,
) -> Result<ProtocolResponse> {
    let result = session.exec_protocol_raw(request);
    if let Err(error) = &result {
        // Unlike a returned ErrorResponse byte stream, an engine error does
        // not prove a terminal ReadyForQuery boundary for this raw exchange.
        transaction_poisoned.store(true, Ordering::SeqCst);
        if let Some(guard) = guard {
            guard.fail(error.clone());
        }
    }
    result
}

fn execute_stream(
    session: &mut dyn EngineSession,
    request: ProtocolRequest,
    mut on_chunk: ProtocolChunkCallback,
    transaction_poisoned: &AtomicBool,
) -> ExecutorStreamOutcome {
    let mut callback_panic = None;
    let outcome = {
        let mut guarded = |chunk: &[u8]| {
            catch_unwind(AssertUnwindSafe(|| on_chunk(chunk))).unwrap_or_else(|panic| {
                let error = Error::Engine(format!(
                    "raw protocol stream callback panicked: {}",
                    panic_message(panic.as_ref())
                ));
                callback_panic = Some(error.clone());
                Err(error)
            })
        };
        session.exec_protocol_raw_stream(request, &mut guarded)
    };
    match outcome {
        ProtocolStreamOutcome::ReadyForQuery(_) if callback_panic.is_some() => {
            ExecutorStreamOutcome::CallbackPanicked(
                callback_panic.expect("callback panic was checked"),
            )
        }
        ProtocolStreamOutcome::ReadyForQuery(result) => {
            ExecutorStreamOutcome::ReadyForQuery(result)
        }
        ProtocolStreamOutcome::SessionStateUnknown(error) => {
            transaction_poisoned.store(true, Ordering::SeqCst);
            ExecutorStreamOutcome::SessionStateUnknown(error)
        }
    }
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
            shared.queue.send_control(Command::Close).err()
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
    shared.cancellation.stop_and_wait();
    shared.teardown_started.store(true, Ordering::SeqCst);
    shared.session_pinned.store(false, Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Weak, mpsc};
    use std::task::{Context, Poll, Wake, Waker};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::engine::EngineCancel;
    use crate::error::ErrorKind;

    struct ThreadWake(thread::Thread);

    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    struct WakeCounter(AtomicUsize);

    impl Wake for WakeCounter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct GateWake {
        gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    }

    struct AdmissionLockProbe {
        shared: Weak<ExecutorShared>,
        woke: AtomicBool,
        admission_was_unlocked: AtomicBool,
    }

    impl Wake for AdmissionLockProbe {
        fn wake(self: Arc<Self>) {
            self.woke.store(true, Ordering::SeqCst);
            let admission_was_unlocked = self
                .shared
                .upgrade()
                .is_some_and(|shared| shared.admission.try_lock().is_ok());
            self.admission_was_unlocked
                .store(admission_was_unlocked, Ordering::SeqCst);
        }
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

    fn assert_error_value(error: &Error, kind: ErrorKind, message: &str) {
        assert_eq!(error.kind(), kind);
        assert_eq!(error.to_string(), message);
    }

    fn assert_error_result<T>(result: Result<T>, kind: ErrorKind, message: &str) {
        let error = result.err().expect("operation must fail");
        assert_error_value(&error, kind, message);
    }

    fn assert_poll_error<T>(poll: Poll<Result<T>>, kind: ErrorKind, message: &str) {
        match poll {
            Poll::Ready(Err(error)) => assert_error_value(&error, kind, message),
            Poll::Ready(Ok(_)) => panic!("operation unexpectedly succeeded"),
            Poll::Pending => panic!("operation unexpectedly remained pending"),
        }
    }

    fn abandoned_ordinary_command(value: u8) -> Command {
        let (reply, receiver) = reply::channel();
        drop(receiver);
        Command::Exec {
            request: ProtocolRequest::new([value]),
            reply,
        }
    }

    fn poll_queue_send(
        queue: &CommandQueue,
        registration: &mut AdmissionRegistration<'_>,
        command: &mut Option<Command>,
        context: &mut Context<'_>,
    ) -> Poll<Result<()>> {
        let (poll, next) = queue.poll_send_ordinary(&mut registration.token, command, context);
        if let Some(waker) = next {
            waker.wake();
        }
        poll
    }

    fn fill_ordinary_queue(queue: &CommandQueue) {
        for value in 0..ORDINARY_QUEUE_CAPACITY {
            let mut registration = AdmissionRegistration::new(queue);
            let mut command = Some(abandoned_ordinary_command(
                u8::try_from(value).expect("queue fixture fits in one byte"),
            ));
            assert!(matches!(
                poll_queue_send(
                    queue,
                    &mut registration,
                    &mut command,
                    &mut Context::from_waker(Waker::noop()),
                ),
                Poll::Ready(Ok(()))
            ));
        }
    }

    #[test]
    fn cancelling_the_next_capacity_waiter_does_not_strand_its_fifo_successor() {
        let queue = CommandQueue::new();
        fill_ordinary_queue(&queue);

        let first_wake = Arc::new(WakeCounter(AtomicUsize::new(0)));
        let first_waker = Waker::from(Arc::clone(&first_wake));
        let mut first = AdmissionRegistration::new(&queue);
        let mut first_command = Some(abandoned_ordinary_command(1));
        assert!(
            poll_queue_send(
                &queue,
                &mut first,
                &mut first_command,
                &mut Context::from_waker(&first_waker),
            )
            .is_pending()
        );

        let second_wake = Arc::new(WakeCounter(AtomicUsize::new(0)));
        let second_waker = Waker::from(Arc::clone(&second_wake));
        let mut second = AdmissionRegistration::new(&queue);
        let mut second_command = Some(abandoned_ordinary_command(2));
        assert!(
            poll_queue_send(
                &queue,
                &mut second,
                &mut second_command,
                &mut Context::from_waker(&second_waker),
            )
            .is_pending()
        );

        drop(first);
        assert_eq!(second_wake.0.load(Ordering::SeqCst), 0);
        drop(queue.receive().expect("free one ordinary queue slot"));
        assert_eq!(second_wake.0.load(Ordering::SeqCst), 1);
        assert_eq!(first_wake.0.load(Ordering::SeqCst), 0);
        assert!(matches!(
            poll_queue_send(
                &queue,
                &mut second,
                &mut second_command,
                &mut Context::from_waker(&second_waker),
            ),
            Poll::Ready(Ok(()))
        ));
        drop(second);
        drop(queue.stop());
    }

    #[test]
    fn rejected_capacity_waiter_cannot_cross_a_reopened_close_cutoff() {
        let queue = CommandQueue::new();
        fill_ordinary_queue(&queue);
        let mut registration = AdmissionRegistration::new(&queue);
        let mut command = Some(abandoned_ordinary_command(3));
        assert!(
            poll_queue_send(
                &queue,
                &mut registration,
                &mut command,
                &mut Context::from_waker(Waker::noop()),
            )
            .is_pending()
        );

        drop(queue.reject_admissions());
        drop(queue.receive().expect("capacity becomes available later"));
        assert_poll_error(
            poll_queue_send(
                &queue,
                &mut registration,
                &mut command,
                &mut Context::from_waker(Waker::noop()),
            ),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        drop(queue.stop());
    }

    #[test]
    fn capacity_successor_is_woken_after_releasing_admission() {
        let shared = Arc::new(ExecutorShared::new());
        let executor = EngineExecutor {
            shared: Arc::clone(&shared),
        };
        fill_ordinary_queue(&shared.queue);

        let mut first = Box::pin(executor.send(abandoned_ordinary_command(1)));
        assert!(poll_once(first.as_mut()).is_pending());

        let probe = Arc::new(AdmissionLockProbe {
            shared: Arc::downgrade(&shared),
            woke: AtomicBool::new(false),
            admission_was_unlocked: AtomicBool::new(false),
        });
        let probe_waker = Waker::from(Arc::clone(&probe));
        let mut second = Box::pin(executor.send(abandoned_ordinary_command(2)));
        assert!(
            second
                .as_mut()
                .poll(&mut Context::from_waker(&probe_waker))
                .is_pending()
        );

        {
            let mut state = shared
                .queue
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for _ in 0..2 {
                drop(state.commands.pop_front().expect("free saturated slot"));
                state.ordinary_count -= 1;
            }
        }

        assert!(matches!(poll_once(first.as_mut()), Poll::Ready(Ok(()))));
        assert!(probe.woke.load(Ordering::SeqCst));
        assert!(
            probe.admission_was_unlocked.load(Ordering::SeqCst),
            "a synchronous successor waker must never run under the admission lock"
        );

        drop(second);
        drop(first);
        drop(shared.queue.stop());
        shared.closed.store(true, Ordering::SeqCst);
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

        assert_error_value(
            &error,
            ErrorKind::Other,
            "oliphaunt-owner-open-panic-test panicked while opening: open panic probe",
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
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([2]))),
            ErrorKind::Lifecycle,
            "native database session has stopped",
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
    fn bounded_fifo_awaits_capacity_then_close_rejects_later_work() {
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
        assert!(
            poll_once(overflow.as_mut()).is_pending(),
            "queue saturation applies asynchronous backpressure"
        );

        // Free one queue slot. The owner immediately occupies itself with the
        // next operation, while the overflow future can now acquire the slot.
        release.send(()).expect("release active operation");
        assert_eq!(
            block_on(active).expect("active work drains").as_bytes(),
            &[1]
        );
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("next operation reaches owner");
        assert!(poll_once(overflow.as_mut()).is_pending());
        {
            let queue = executor
                .shared
                .queue
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert_eq!(queue.ordinary_count, ORDINARY_QUEUE_CAPACITY);
            assert!(queue.admission_waiters.is_empty());
        }

        let mut cutoff_waiter =
            Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([8, 8, 8])));
        assert!(poll_once(cutoff_waiter.as_mut()).is_pending());

        // Close is a control command and still enters the same FIFO after all
        // already-admitted ordinary work.
        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert_poll_error(
            poll_once(cutoff_waiter.as_mut()),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        let mut after_cutoff = Box::pin(executor.exec_protocol_raw(ProtocolRequest::new([7, 7])));
        assert_poll_error(
            poll_once(after_cutoff.as_mut()),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );

        // The remaining permits may be buffered, allowing every pre-cutoff
        // command to run without depending on scheduler timing in this test.
        for _ in 0..=ORDINARY_QUEUE_CAPACITY {
            release.send(()).expect("release admitted operation");
        }
        for operation in queued {
            block_on(operation).expect("pre-cutoff queued work drains");
        }
        block_on(overflow).expect("capacity waiter is admitted before close");
        block_on(close).expect("reserved close command completes");
        assert_eq!(calls.load(Ordering::SeqCst), ORDINARY_QUEUE_CAPACITY + 2);
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
        assert_poll_error(
            poll_once(later_begin.as_mut()),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );

        release.send(()).expect("release first operation");
        block_on(active).expect("active operation drains");
        let token = block_on(begin).expect("pre-cutoff BEGIN runs");
        assert_error_result(
            block_on(close),
            ErrorKind::TransactionActive,
            "a transaction is active; use the active transaction handle",
        );
        assert!(!executor.is_closed());
        assert!(executor.session_is_pinned());

        let rollback = block_on(executor.pinned_exec_protocol_control(
            token,
            ProtocolRequest::simple_query("ROLLBACK").expect("rollback request"),
            TransactionGuard::active(),
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
        use crate::database::AsyncOliphaunt;

        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let executor = EngineExecutor::spawn(Box::new(PreCutoffSettlementSession {
            settlement_tag,
            calls: Arc::clone(&calls),
            started,
            release: release_rx,
        }));
        let database = AsyncOliphaunt::from_executor(Arc::clone(&executor));

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
            Ok::<(), Error>(())
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
                Some(Command::PinnedExec { .. })
            ));
        }
        release_owner
            .send(())
            .expect("release owner after settlement admission");

        block_on(transaction).expect("callback transaction settles");
        assert_error_result(
            block_on(close),
            ErrorKind::TransactionActive,
            "a transaction is active; use the active transaction handle",
        );
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
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(command_response("BEGIN", b'T')),
                1 => {
                    self.started.send(()).expect("announce pinned work");
                    self.release.recv().expect("release pinned work");
                    Ok(command_response("SELECT", b'T'))
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
        let mut pinned = Box::pin(executor.pinned_exec_structured(
            token,
            ProtocolRequest::simple_query("SELECT 1").expect("query request"),
            "transaction test",
            Arc::clone(&guard),
        ));
        assert!(poll_once(pinned.as_mut()).is_pending());
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("pinned operation reaches owner");

        let mut rollback = Box::pin(executor.pinned_exec_protocol_control(
            token,
            ProtocolRequest::simple_query("ROLLBACK").expect("rollback request"),
            guard,
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
        assert_error_result(
            block_on(close),
            ErrorKind::TransactionActive,
            "a transaction is active; use the active transaction handle",
        );
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
                call => panic!("unexpected failed-begin session call {call}"),
            }
        }
    }

    #[test]
    fn failed_pre_cutoff_begin_transport_does_not_send_blind_rollback() {
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
        assert_error_result(block_on(begin), ErrorKind::Other, "injected BEGIN failure");
        block_on(close).expect("unknown BEGIN failure remains closeable");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
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
        ) -> ProtocolStreamOutcome {
            ProtocolStreamOutcome::ReadyForQuery(on_chunk(&[1, 2, 3]))
        }
    }

    struct FailedRawSession {
        calls: Arc<AtomicUsize>,
    }

    impl EngineSession for FailedRawSession {
        fn exec_protocol_raw(&mut self, _request: ProtocolRequest) -> Result<ProtocolResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(Error::Engine(
                "raw transport failed before ReadyForQuery".to_owned(),
            ))
        }
    }

    #[test]
    fn raw_transport_failure_poisons_without_a_second_owner_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let executor = EngineExecutor::spawn(Box::new(FailedRawSession {
            calls: Arc::clone(&calls),
        }));

        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            ErrorKind::Other,
            "raw transport failed before ReadyForQuery",
        );
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([2]))),
            ErrorKind::Other,
            SESSION_STATE_UNKNOWN,
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        block_on(executor.close()).expect("close poisoned raw session");
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
        assert_eq!(error.kind(), ErrorKind::Other);
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

    struct FailedRecoveryStreamSession;

    impl EngineSession for FailedRecoveryStreamSession {
        fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
            Ok(ProtocolResponse::new(request.as_bytes()))
        }

        fn exec_protocol_raw_stream(
            &mut self,
            _request: ProtocolRequest,
            on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
        ) -> ProtocolStreamOutcome {
            let _ = on_chunk(&[1, 2, 3]);
            ProtocolStreamOutcome::SessionStateUnknown(Error::Engine(
                "stream transport failed before ReadyForQuery".to_owned(),
            ))
        }
    }

    #[test]
    fn recovery_failure_overrides_callback_panic_and_poisons_the_session() {
        let executor = EngineExecutor::spawn(Box::new(FailedRecoveryStreamSession));

        assert_error_result(
            block_on(
                executor.exec_protocol_raw_stream(ProtocolRequest::new([1]), |_| {
                    panic!("callback panic probe")
                }),
            ),
            ErrorKind::Other,
            "stream transport failed before ReadyForQuery",
        );
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([7]))),
            ErrorKind::Other,
            SESSION_STATE_UNKNOWN,
        );
        block_on(executor.close()).expect("close failed-recovery stream session");
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
                    TransactionGuard::active(),
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

    #[test]
    fn close_waits_for_admitted_cancellation_and_rejects_later_calls() {
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
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancellation reaches its engine target");

        let mut close = Box::pin(executor.close());
        assert!(poll_once(close.as_mut()).is_pending());
        assert!(
            executor
                .shared
                .cancellation
                .wait_for_cutoff(Duration::from_secs(2)),
            "close establishes its destructive cancellation cutoff"
        );
        assert_eq!(executor.shared.cancellation.active_cancellations(), 1);
        assert_error_result(
            block_on(executor.cancel()),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        assert!(poll_once(close.as_mut()).is_pending());

        release.send(()).expect("finish admitted cancellation");
        block_on(cancel).expect("admitted cancellation settles");
        block_on(close).expect("close proceeds after cancellation settles");
        assert_eq!(executor.shared.cancellation.active_cancellations(), 0);
        assert!(executor.is_closed());
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
        assert_error_result(
            block_on(executor.cancel()),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
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
        let expected = format!("injected {topology} teardown failure");
        assert_error_result(block_on(executor.close()), ErrorKind::Other, &expected);
        assert!(executor.is_closed());
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([4]))),
            ErrorKind::Lifecycle,
            "native database session has stopped",
        );
        assert_error_result(block_on(executor.close()), ErrorKind::Other, &expected);
        assert_error_result(block_on(executor.close()), ErrorKind::Other, &expected);
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
        let expected = "native engine session panicked during close: injected close panic";

        assert_error_result(block_on(executor.close()), ErrorKind::Other, expected);
        assert!(executor.is_closed());
        assert_error_result(block_on(executor.close()), ErrorKind::Other, expected);
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            ErrorKind::Lifecycle,
            "native database session has stopped",
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
        let expected = "native engine session destructor panicked after close: injected session destructor panic";
        assert_error_result(block_on(executor.close()), ErrorKind::Other, expected);
        assert!(executor.is_closed());
        assert_error_result(block_on(executor.close()), ErrorKind::Other, expected);
        assert_error_result(
            block_on(executor.exec_protocol_raw(ProtocolRequest::new([1]))),
            ErrorKind::Lifecycle,
            "native database session has stopped",
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
        let expected = "injected concurrent teardown failure";

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

        assert_error_result(
            first.join().expect("join first close"),
            ErrorKind::Other,
            expected,
        );
        assert_error_result(
            second.join().expect("join second close"),
            ErrorKind::Other,
            expected,
        );
        assert!(executor.is_closed());
        assert_error_result(block_on(executor.close()), ErrorKind::Other, expected);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
