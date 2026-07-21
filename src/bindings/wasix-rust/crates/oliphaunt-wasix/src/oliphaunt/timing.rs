use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

thread_local! {
    static ACTIVE_RECORDER: RefCell<Option<Arc<Mutex<Vec<PhaseTiming>>>>> =
        const { RefCell::new(None) };
}

pub(crate) type PhaseRecorder = Arc<Mutex<Vec<PhaseTiming>>>;

/// One measured runtime phase captured during a cold-start operation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTiming {
    pub name: &'static str,
    pub elapsed_micros: u128,
}

impl PhaseTiming {
    pub fn elapsed(&self) -> Duration {
        Duration::from_micros(self.elapsed_micros.min(u64::MAX as u128) as u64)
    }
}

pub(crate) struct PhaseGuard {
    name: &'static str,
    started: Option<Instant>,
    recorder: Option<Arc<Mutex<Vec<PhaseTiming>>>>,
}

pub(crate) fn phase(name: &'static str) -> PhaseGuard {
    let recorder = ACTIVE_RECORDER.with(|active| active.borrow().clone());
    let started = recorder.as_ref().map(|_| Instant::now());
    PhaseGuard {
        name,
        started,
        recorder,
    }
}

#[doc(hidden)]
pub fn measure_phase<T>(name: &'static str, operation: impl FnOnce() -> T) -> T {
    let _phase = phase(name);
    operation()
}

#[doc(hidden)]
pub fn record_phase_timing(name: &'static str, elapsed: Duration) {
    let recorder = ACTIVE_RECORDER.with(|active| active.borrow().clone());
    if let Some(recorder) = recorder {
        recorder
            .lock()
            .expect("phase timing recorder poisoned")
            .push(PhaseTiming {
                name,
                elapsed_micros: elapsed.as_micros(),
            });
    }
}

pub(crate) fn current_recorder() -> Option<PhaseRecorder> {
    ACTIVE_RECORDER.with(|active| active.borrow().clone())
}

pub(crate) fn with_recorder<T>(
    recorder: Option<PhaseRecorder>,
    operation: impl FnOnce() -> T,
) -> T {
    let previous = ACTIVE_RECORDER.with(|active| active.replace(recorder));
    let result = operation();
    ACTIVE_RECORDER.with(|active| {
        active.replace(previous);
    });
    result
}

/// Run `operation` while collecting internal cold-start phase timings.
///
/// This is hidden from normal docs because the exact phase names are diagnostic
/// surface, not a compatibility contract.
#[doc(hidden)]
pub fn capture_phase_timings<T>(operation: impl FnOnce() -> T) -> (T, Vec<PhaseTiming>) {
    let recorder = Arc::new(Mutex::new(Vec::new()));
    let result = with_recorder(Some(recorder.clone()), operation);

    let timings = recorder
        .lock()
        .expect("phase timing recorder poisoned")
        .clone();
    (result, timings)
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        if let (Some(recorder), Some(started)) = (&self.recorder, self.started) {
            recorder
                .lock()
                .expect("phase timing recorder poisoned")
                .push(PhaseTiming {
                    name: self.name,
                    elapsed_micros: started.elapsed().as_micros(),
                });
        }
    }
}
