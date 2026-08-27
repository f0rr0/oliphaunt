use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use crate::engine::EngineSession;
use crate::error::{Error, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query::{ReadyStatus, parse_simple_command_response, response_ready_status};

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

    pub(crate) fn fail(&self, error: Error) {
        self.state.store(TRANSACTION_FAILED, Ordering::SeqCst);
        if let Ok(mut terminal_error) = self.terminal_error.lock()
            && terminal_error.is_none()
        {
            *terminal_error = Some(error);
        }
    }
}

pub(crate) fn begin_transaction(
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

pub(crate) fn execute_structured_operation(
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

pub(crate) fn execute_transaction_structured_operation(
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

pub(crate) fn inactive_transaction_error() -> Error {
    Error::Engine("transaction is no longer active".to_owned())
}
