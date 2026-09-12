use std::sync::{Arc, Condvar, Mutex, MutexGuard};
#[cfg(test)]
use std::time::Duration;

use crate::engine::EngineCancel;
use crate::error::{Error, Result};

pub(crate) struct CancellationGate {
    state: Mutex<CancellationState>,
    changed: Condvar,
}

struct CancellationState {
    accepting: bool,
    active_cancellations: usize,
    target: CancellationTarget,
}

enum CancellationTarget {
    Uninitialized,
    Unsupported,
    Available(Arc<dyn EngineCancel>),
}

impl CancellationGate {
    pub(crate) fn with_target(target: Option<Arc<dyn EngineCancel>>) -> Arc<Self> {
        Arc::new(Self::new(CancellationTarget::from(target)))
    }

    pub(crate) fn pending() -> Arc<Self> {
        Arc::new(Self::new(CancellationTarget::Uninitialized))
    }

    fn new(target: CancellationTarget) -> Self {
        Self {
            state: Mutex::new(CancellationState {
                accepting: true,
                active_cancellations: 0,
                target,
            }),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn install_target(&self, target: Option<Arc<dyn EngineCancel>>) -> Result<()> {
        let mut state = self.lock_state();
        if !state.accepting {
            return Err(Error::EngineStopped);
        }
        if !matches!(state.target, CancellationTarget::Uninitialized) {
            return Err(Error::Engine(
                "database cancellation target was initialized more than once".to_owned(),
            ));
        }
        state.target = CancellationTarget::from(target);
        Ok(())
    }

    pub(crate) fn ensure_supported(&self) -> Result<()> {
        let state = self.lock_state();
        if !state.accepting {
            return Err(Error::EngineStopped);
        }
        match state.target {
            CancellationTarget::Available(_) => Ok(()),
            CancellationTarget::Unsupported => Err(cancellation_not_supported_error()),
            CancellationTarget::Uninitialized => Err(Error::Engine(
                "database cancellation target is not initialized".to_owned(),
            )),
        }
    }

    pub(crate) fn admit(self: &Arc<Self>) -> Result<CancellationAdmission> {
        let mut state = self.lock_state();
        if !state.accepting {
            return Err(Error::EngineStopped);
        }
        let active_cancellations = state
            .active_cancellations
            .checked_add(1)
            .ok_or_else(|| Error::Engine("too many concurrent cancellation requests".to_owned()))?;
        let target = match &state.target {
            CancellationTarget::Available(target) => Arc::clone(target),
            CancellationTarget::Unsupported => return Err(cancellation_not_supported_error()),
            CancellationTarget::Uninitialized => {
                return Err(Error::Engine(
                    "database cancellation target is not initialized".to_owned(),
                ));
            }
        };
        state.active_cancellations = active_cancellations;
        Ok(CancellationAdmission {
            gate: Arc::clone(self),
            target: Some(target),
        })
    }

    /// Establish the terminal admission cutoff and return transport ownership
    /// so callers can release it after dropping any surrounding lifecycle lock.
    pub(crate) fn stop_accepting(&self) -> Option<Arc<dyn EngineCancel>> {
        let mut state = self.lock_state();
        if !state.accepting {
            return None;
        }
        state.accepting = false;
        let target = match std::mem::replace(&mut state.target, CancellationTarget::Unsupported) {
            CancellationTarget::Available(target) => Some(target),
            CancellationTarget::Uninitialized | CancellationTarget::Unsupported => None,
        };
        self.changed.notify_all();
        target
    }

    pub(crate) fn wait_for_idle(&self) {
        let mut state = self.lock_state();
        while state.active_cancellations != 0 {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    pub(crate) fn stop_and_wait(&self) {
        // Engine transport destructors are not part of this synchronization
        // protocol and must never run under the lifecycle mutex.
        drop(self.stop_accepting());
        self.wait_for_idle();
    }

    fn lock_state(&self) -> MutexGuard<'_, CancellationState> {
        // No engine or user callback runs while this lock is held. Recovering a
        // poisoned guard keeps terminal teardown from stranding native state.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn wait_for_cutoff(&self, timeout: Duration) -> bool {
        let state = self.lock_state();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, timeout, |state| state.accepting)
            .unwrap_or_else(|error| error.into_inner());
        !timeout.timed_out() || !state.accepting
    }

    #[cfg(test)]
    pub(crate) fn active_cancellations(&self) -> usize {
        self.lock_state().active_cancellations
    }
}

impl From<Option<Arc<dyn EngineCancel>>> for CancellationTarget {
    fn from(target: Option<Arc<dyn EngineCancel>>) -> Self {
        match target {
            Some(target) => Self::Available(target),
            None => Self::Unsupported,
        }
    }
}

pub(crate) struct CancellationAdmission {
    gate: Arc<CancellationGate>,
    target: Option<Arc<dyn EngineCancel>>,
}

impl CancellationAdmission {
    pub(crate) fn cancel(&self) -> Result<()> {
        self.target
            .as_deref()
            .expect("admitted cancellation retains its engine target")
            .cancel()
    }
}

impl Drop for CancellationAdmission {
    fn drop(&mut self) {
        // Release target-owned transport state before declaring this call
        // settled. This drop intentionally runs without the lifecycle lock.
        drop(self.target.take());
        let mut state = self.gate.lock_state();
        debug_assert!(state.active_cancellations > 0);
        if state.active_cancellations > 0 {
            state.active_cancellations -= 1;
        }
        if state.active_cancellations == 0 {
            self.gate.changed.notify_all();
        }
    }
}

pub(crate) fn cancellation_not_supported_error() -> Error {
    Error::Engine("query cancellation is not supported by this engine".to_owned())
}
