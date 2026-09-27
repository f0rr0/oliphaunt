use std::io::{self, Read, Seek, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use oliphaunt_broker::mobile::{self as wire, Kind};

use super::watchdog::{Expiry, SETTLEMENT, Watchdog};
use super::{Completion, Control, Epoch, Execution, Reason, failure};
use crate::engine::{EngineCancel, EngineSession, ProtocolStreamOutcome};
use crate::executor::EngineExecutor;
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::{AsyncOliphaunt, Error, Result};

#[derive(Default)]
struct State {
    next: u64,
    active: u64,
    cancellation_sent: bool,
    failed: bool,
    closing: bool,
    reason: Option<Reason>,
    operation_deadline: Option<Duration>,
    close_deadline: Option<Duration>,
}

pub struct Connection {
    epoch: Epoch,
    control: Arc<dyn Control>,
    socket: UnixStream,
    state: Mutex<State>,
    watchdog: OnceLock<Watchdog>,
}

impl Connection {
    /// Native death invalidates future work. Leave already received bulk bytes
    /// available briefly so a racing terminal result can still settle the call.
    pub fn interrupted(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.failed = true;
        state.reason = Some(Reason::WorkerInterrupted);
        if state.active != 0 {
            self.watchdog
                .get()
                .unwrap()
                .arm(state.active, SETTLEMENT, Expiry::Retire);
        } else {
            let _ = self.socket.shutdown(Shutdown::Both);
        }
    }

    pub fn is_usable(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        !state.failed && !state.closing
    }

    fn cancel_request(&self, request: u64, reason: Reason) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.active != request || request == 0 || state.cancellation_sent {
            return Ok(());
        }
        state.cancellation_sent = true;
        state.reason = Some(reason);
        self.watchdog
            .get()
            .unwrap()
            .arm(request, SETTLEMENT, Expiry::Retire);
        drop(state);
        self.control.cancel(self.epoch, request)
    }

    fn expired(&self, request: u64, action: Expiry) {
        match action {
            Expiry::Cancel => {
                let _ = self.cancel_request(request, Reason::Deadline);
            }
            Expiry::Retire => {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.active != request || (request == 0 && !state.closing) {
                    return;
                }
                state.failed = true;
                state.reason.get_or_insert(Reason::Deadline);
                let _ = self.socket.shutdown(Shutdown::Both);
                drop(state);
                let _ = self.control.close(self.epoch);
            }
        }
    }

    pub fn set_operation_budget(&self, budget: Option<Duration>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .operation_deadline =
            budget.map(|budget| super::watchdog::continuous_time().saturating_add(budget));
    }

    pub fn begin_close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing {
            return;
        }
        state.closing = true;
        state.close_deadline = Some(super::watchdog::continuous_time().saturating_add(SETTLEMENT));
        self.watchdog
            .get()
            .unwrap()
            .arm(state.active, SETTLEMENT, Expiry::Retire);
        drop(state);
        let _ = self.control.close(self.epoch);
    }

    fn start(&self, timeout: Option<Duration>) -> Result<u64> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.failed || state.closing {
            return Err(failure(
                state.reason.unwrap_or(if state.closing {
                    Reason::Cancelled
                } else {
                    Reason::WorkerInterrupted
                }),
                Execution::NotStarted,
                true,
                "broker connection requires reopen",
            ));
        }
        let now = super::watchdog::continuous_time();
        let deadline = state
            .operation_deadline
            .or_else(|| timeout.map(|budget| now.saturating_add(budget)));
        if deadline.is_some_and(|deadline| deadline <= now) {
            return Err(failure(
                Reason::Deadline,
                Execution::NotStarted,
                false,
                "operation deadline exceeded before dispatch",
            ));
        }
        state.operation_deadline = deadline;
        state.next = state.next.checked_add(1).ok_or_else(|| {
            failure(
                Reason::Transport,
                Execution::NotStarted,
                true,
                "request ids exhausted",
            )
        })?;
        state.active = state.next;
        state.reason = None;
        state.cancellation_sent = false;
        if let Some(deadline) = deadline {
            self.watchdog
                .get()
                .unwrap()
                .arm(state.active, deadline - now, Expiry::Cancel);
        }
        Ok(state.active)
    }

    fn finish(&self, request: u64, requires_reopen: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.active == request {
            state.active = 0;
        }
        state.failed |= requires_reopen;
        self.watchdog.get().unwrap().clear(request);
        if let Some(deadline) = state.close_deadline {
            self.watchdog.get().unwrap().arm(
                0,
                deadline.saturating_sub(super::watchdog::continuous_time()),
                Expiry::Retire,
            );
        }
        state.operation_deadline = None;
    }

    fn transport_error(&self, error: impl ToString) -> Error {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        failure(
            state.reason.unwrap_or(Reason::Transport),
            Execution::Unknown,
            true,
            error,
        )
    }
}

impl EngineCancel for Connection {
    fn cancel(&self) -> Result<()> {
        let request = self.state.lock().unwrap_or_else(|e| e.into_inner()).active;
        self.cancel_request(request, Reason::Cancelled)
    }
}

pub async fn connect(
    socket: UnixStream,
    epoch: Epoch,
    control: Arc<dyn Control>,
    timeout: Option<Duration>,
) -> Result<(AsyncOliphaunt, Arc<Connection>)> {
    let shutdown = socket
        .try_clone()
        .map_err(|e| failure(Reason::Transport, Execution::NotStarted, true, e))?;
    let connection = Arc::new(Connection {
        epoch,
        control,
        socket: shutdown,
        state: Mutex::new(State::default()),
        watchdog: OnceLock::new(),
    });
    let weak = Arc::downgrade(&connection);
    let watchdog = Watchdog::new(move |request, action| {
        if let Some(connection) = weak.upgrade() {
            connection.expired(request, action);
        }
    })?;
    connection
        .watchdog
        .set(watchdog)
        .ok()
        .expect("watchdog installed once");
    let session = Session {
        socket,
        connection: connection.clone(),
        timeout,
    };
    let (executor, ()) = EngineExecutor::open("oliphaunt-broker-client", move || {
        Ok((Box::new(session), ()))
    })
    .await?;
    Ok((AsyncOliphaunt::from_executor(executor), connection))
}

pub async fn restore(
    socket: UnixStream,
    epoch: Epoch,
    control: Arc<dyn Control>,
    timeout: Option<Duration>,
    mut input: std::fs::File,
) -> Result<()> {
    let (_database, connection) = connect(
        socket
            .try_clone()
            .map_err(|e| Error::Engine(e.to_string()))?,
        epoch,
        control,
        timeout,
    )
    .await?;
    crate::executor::run_off_thread("oliphaunt-broker-archive-upload", move || {
        let _database = _database;
        let mut socket = socket;
        let request = connection.start(timeout)?;
        let result = (|| -> Result<()> {
            input.rewind().map_err(|e| Error::Engine(e.to_string()))?;
            let length = input
                .metadata()
                .map_err(|e| Error::Engine(e.to_string()))?
                .len();
            let mut begin = [0; 16];
            begin[..8].copy_from_slice(&length.to_be_bytes());
            begin[8..].copy_from_slice(
                &timeout
                    .map(|t| t.as_millis().min(u64::MAX as u128) as u64)
                    .unwrap_or(0)
                    .to_be_bytes(),
            );
            let uploaded = (|| -> io::Result<()> {
                wire::write_frame(&mut socket, Kind::Restore, epoch, request, &begin)?;
                let mut buffer = vec![0; wire::CHUNK_BYTES];
                loop {
                    let count = input.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    wire::write_frame(&mut socket, Kind::Data, epoch, request, &buffer[..count])?;
                }
                wire::write_frame(&mut socket, Kind::End, epoch, request, &[])
            })();
            if uploaded.is_err() {
                let _ = socket.shutdown(Shutdown::Write);
            }
            let frame = wire::read_frame(&mut socket).map_err(|e| connection.transport_error(e))?;
            if frame.epoch != epoch || frame.request != request || frame.kind != Kind::Terminal {
                return Err(connection.transport_error("invalid restore completion"));
            }
            let completion =
                Completion::decode(&frame.payload).map_err(|e| connection.transport_error(e))?;
            if completion.reason != Reason::Success {
                return Err(Error::broker(completion));
            }
            uploaded.map_err(|e| connection.transport_error(e))
        })();
        connection.finish(request, true);
        connection.watchdog.get().unwrap().stop();
        let _ = socket.shutdown(Shutdown::Both);
        result
    })
    .await
}

struct Session {
    socket: UnixStream,
    connection: Arc<Connection>,
    timeout: Option<Duration>,
}

impl Session {
    fn exchange(
        &mut self,
        kind: Kind,
        input: &[u8],
        callback: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        if kind == Kind::Query
            && let Err(error) = wire::validate_request(input)
        {
            return ProtocolStreamOutcome::ReadyForQuery(Err(failure(
                Reason::InvalidRequest,
                Execution::NotStarted,
                false,
                error,
            )));
        }
        let request = match self.connection.start(self.timeout) {
            Ok(request) => request,
            Err(error) => {
                return if error.requires_reopen() {
                    ProtocolStreamOutcome::SessionStateUnknown(error)
                } else {
                    ProtocolStreamOutcome::ReadyForQuery(Err(error))
                };
            }
        };
        let result = self.transfer(kind, request, input, callback);
        let outcome = match result {
            Ok(result) => result,
            Err(error) => {
                ProtocolStreamOutcome::SessionStateUnknown(self.connection.transport_error(error))
            }
        };
        self.connection.finish(
            request,
            matches!(outcome, ProtocolStreamOutcome::SessionStateUnknown(_)),
        );
        outcome
    }

    fn transfer(
        &mut self,
        kind: Kind,
        request: u64,
        input: &[u8],
        callback: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> io::Result<ProtocolStreamOutcome> {
        let epoch = self.connection.epoch;
        let mut begin = [0; 16];
        begin[..8].copy_from_slice(&(input.len() as u64).to_be_bytes());
        let timeout = self
            .connection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .operation_deadline
            .map(|deadline| {
                deadline
                    .saturating_sub(super::watchdog::continuous_time())
                    .as_millis()
                    .max(1)
                    .min(u64::MAX as u128) as u64
            })
            .unwrap_or(0);
        begin[8..].copy_from_slice(&timeout.to_be_bytes());
        wire::write_frame(&mut self.socket, kind, epoch, request, &begin)?;
        for chunk in input.chunks(wire::CHUNK_BYTES) {
            wire::write_frame(&mut self.socket, Kind::Data, epoch, request, chunk)?;
        }
        wire::write_frame(&mut self.socket, Kind::End, epoch, request, &[])?;
        let mut callback_error = None;
        loop {
            let frame = wire::read_frame(&mut self.socket)?;
            if frame.epoch != epoch || frame.request != request {
                return Err(wire::invalid("stale broker response"));
            }
            match frame.kind {
                Kind::Data => {
                    if callback_error.is_none()
                        && let Err(error) = callback(&frame.payload)
                    {
                        callback_error = Some(error);
                        let _ = self.connection.cancel_request(request, Reason::Callback);
                    }
                }
                Kind::Terminal => {
                    let completion = Completion::decode(&frame.payload)?;
                    if completion.requires_reopen {
                        return Ok(ProtocolStreamOutcome::SessionStateUnknown(Error::broker(
                            completion,
                        )));
                    }
                    if completion.reason != Reason::Success {
                        return Ok(ProtocolStreamOutcome::ReadyForQuery(Err(Error::broker(
                            completion,
                        ))));
                    }
                    return Ok(ProtocolStreamOutcome::ReadyForQuery(
                        callback_error.map_or(Ok(()), Err),
                    ));
                }
                _ => return Err(wire::invalid("unexpected broker response")),
            }
        }
    }
}

impl EngineSession for Session {
    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        Some(self.connection.clone())
    }
    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let mut bytes = Vec::new();
        match self.exchange(Kind::Query, request.as_bytes(), &mut |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        }) {
            ProtocolStreamOutcome::ReadyForQuery(result) => {
                result.map(|()| ProtocolResponse::new(bytes))
            }
            ProtocolStreamOutcome::SessionStateUnknown(error) => Err(error),
        }
    }
    fn exec_protocol_raw_stream(
        &mut self,
        request: ProtocolRequest,
        callback: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> ProtocolStreamOutcome {
        self.exchange(Kind::Query, request.as_bytes(), callback)
    }
    fn backup(&mut self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.backup_to(&mut bytes)?;
        Ok(bytes)
    }
    fn backup_to(&mut self, writer: &mut dyn Write) -> Result<()> {
        match self.exchange(Kind::Backup, &[], &mut |chunk| {
            writer
                .write_all(chunk)
                .map_err(|e| Error::Engine(e.to_string()))
        }) {
            ProtocolStreamOutcome::ReadyForQuery(result) => result,
            ProtocolStreamOutcome::SessionStateUnknown(error) => Err(error),
        }
    }
    fn close(&mut self) -> Result<()> {
        self.connection.begin_close();
        let result = self
            .connection
            .control
            .close(self.connection.epoch)
            .and_then(|()| {
                let frame = wire::read_frame(&mut self.socket)
                    .map_err(|e| self.connection.transport_error(e))?;
                if frame.epoch != self.connection.epoch
                    || frame.request != 0
                    || frame.kind != Kind::Terminal
                {
                    return Err(failure(
                        Reason::Transport,
                        Execution::Unknown,
                        true,
                        "invalid broker close result",
                    ));
                }
                let completion = Completion::decode(&frame.payload)
                    .map_err(|e| self.connection.transport_error(e))?;
                if completion.reason == Reason::Success {
                    Ok(())
                } else {
                    Err(Error::broker(completion))
                }
            });
        self.connection.watchdog.get().unwrap().stop();
        let _ = self.socket.shutdown(Shutdown::Both);
        result
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.connection.watchdog.get().unwrap().stop();
        let _ = self.connection.control.close(self.connection.epoch);
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::super::block_on;
    use super::*;
    use crate::mobile::Request;

    struct Platform(std::sync::mpsc::Sender<()>);
    impl Control for Platform {
        fn cancel(&self, _: Epoch, _: u64) -> Result<()> {
            Ok(())
        }
        fn close(&self, _: Epoch) -> Result<()> {
            let _ = self.0.send(());
            Ok(())
        }
    }

    #[test]
    fn local_rejection_preserves_session_and_close_waits_for_worker_release() {
        let (socket, mut worker) = UnixStream::pair().unwrap();
        let (closed, receive) = std::sync::mpsc::channel();
        let (database, connection) =
            block_on(connect(socket, [1; 16], Arc::new(Platform(closed)), None)).unwrap();
        let server = std::thread::spawn(move || {
            let begin = wire::read_frame(&mut worker).unwrap();
            while wire::read_frame(&mut worker).unwrap().kind != Kind::End {}
            wire::write_frame(
                &mut worker,
                Kind::Data,
                begin.epoch,
                begin.request,
                b"Z\0\0\0\x05I",
            )
            .unwrap();
            wire::write_frame(
                &mut worker,
                Kind::Terminal,
                begin.epoch,
                begin.request,
                &Completion::success().encode(),
            )
            .unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap();
            wire::write_frame(
                &mut worker,
                Kind::Terminal,
                begin.epoch,
                0,
                &Completion::success().encode(),
            )
            .unwrap();
        });
        let error = block_on(Request::new(&database).execute(b"X\0\0\0\x04".to_vec())).unwrap_err();
        assert_eq!(
            error.broker_failure().unwrap().execution,
            Execution::NotStarted
        );
        assert!(connection.is_usable());
        assert_eq!(
            block_on(Request::new(&database).execute(b"Q\0\0\0\rSELECT 1\0".to_vec())).unwrap(),
            b"Z\0\0\0\x05I"
        );
        block_on(database.close()).unwrap();
        assert!(!connection.is_usable());
        server.join().unwrap();
    }

    #[test]
    fn lost_terminal_is_unknown_and_following_request_is_unstarted() {
        let (socket, mut worker) = UnixStream::pair().unwrap();
        let (closed, _) = std::sync::mpsc::channel();
        let (database, _) =
            block_on(connect(socket, [2; 16], Arc::new(Platform(closed)), None)).unwrap();
        let server = std::thread::spawn(move || {
            let _ = wire::read_frame(&mut worker).unwrap();
            while wire::read_frame(&mut worker).unwrap().kind != Kind::End {}
            // PostgreSQL might have committed here; no terminal receipt exists.
        });
        let error =
            block_on(Request::new(&database).execute(b"Q\0\0\0\rSELECT 1\0".to_vec())).unwrap_err();
        assert_eq!(
            error.broker_failure().unwrap().execution,
            Execution::Unknown
        );
        assert!(error.broker_failure().unwrap().requires_reopen);
        let error =
            block_on(Request::new(&database).execute(b"Q\0\0\0\rSELECT 1\0".to_vec())).unwrap_err();
        assert_eq!(
            error.broker_failure().unwrap().execution,
            Execution::NotStarted
        );
        assert!(error.broker_failure().unwrap().requires_reopen);
        server.join().unwrap();
    }
}
