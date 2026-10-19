use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::{Error, Result};

pub(super) const SETTLEMENT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
pub(super) enum Expiry {
    Cancel,
    Retire,
}

struct State {
    deadline: Option<(u64, Duration, Expiry)>,
    stopped: bool,
}

pub(super) struct Watchdog {
    shared: Arc<(Mutex<State>, Condvar)>,
}

impl Watchdog {
    pub(super) fn new(expired: impl Fn(u64, Expiry) + Send + 'static) -> Result<Self> {
        let shared = Arc::new((
            Mutex::new(State {
                deadline: None,
                stopped: false,
            }),
            Condvar::new(),
        ));
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("oliphaunt-broker-watchdog".into())
            .spawn(move || {
                let (lock, changed) = &*worker;
                let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if state.stopped {
                        return;
                    }
                    match state.deadline {
                        None => state = changed.wait(state).unwrap_or_else(|e| e.into_inner()),
                        Some((request, at, action)) => {
                            let now = continuous_time();
                            if now >= at {
                                state.deadline = None;
                                drop(state);
                                expired(request, action);
                                state = lock.lock().unwrap_or_else(|e| e.into_inner());
                            } else {
                                // Condvar waits need not include sleep on every OS.
                                // Recheck a continuous clock while a budget is armed;
                                // an idle connection has no polling or heartbeat.
                                state = changed
                                    .wait_timeout(state, (at - now).min(Duration::from_millis(100)))
                                    .unwrap_or_else(|e| e.into_inner())
                                    .0;
                            }
                        }
                    }
                }
            })
            .map_err(|e| Error::Engine(format!("cannot start broker supervision: {e}")))?;
        Ok(Self { shared })
    }

    pub(super) fn arm(&self, request: u64, budget: Duration, action: Expiry) {
        let (lock, changed) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        if !state.stopped {
            state.deadline = Some((request, continuous_time().saturating_add(budget), action));
            changed.notify_one();
        }
    }

    pub(super) fn clear(&self, request: u64) {
        let (lock, changed) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        if state.deadline.is_some_and(|(id, _, _)| id == request) {
            state.deadline = None;
            changed.notify_one();
        }
    }

    pub(super) fn stop(&self) {
        let (lock, changed) = &*self.shared;
        lock.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        changed.notify_one();
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_vendor = "apple")]
pub(super) fn continuous_time() -> Duration {
    unsafe extern "C" {
        fn mach_continuous_time() -> u64;
    }
    static TIMEBASE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    let &(numer, denom) = TIMEBASE.get_or_init(|| {
        let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: Darwin writes the caller-owned timebase record.
        let rc = unsafe { libc::mach_timebase_info(&mut info) };
        assert!(rc == 0 && info.denom != 0, "continuous clock unavailable");
        (info.numer, info.denom)
    });
    // SAFETY: the process-independent Darwin continuous clock has no arguments.
    let ticks = unsafe { mach_continuous_time() } as u128;
    let nanos = ticks * u128::from(numer) / u128::from(denom);
    Duration::new(
        (nanos / 1_000_000_000) as u64,
        (nanos % 1_000_000_000) as u32,
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub(super) fn continuous_time() -> Duration {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: the kernel writes one initialized timespec. CLOCK_BOOTTIME
    // includes suspend, unlike CLOCK_MONOTONIC / Rust Instant on these OSes.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut time) };
    assert_eq!(rc, 0, "continuous clock unavailable");
    Duration::new(time.tv_sec as u64, time.tv_nsec as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_current_budget_expires_and_cleared_requests_do_not_retire() {
        let (send, receive) = std::sync::mpsc::channel();
        let watchdog = Watchdog::new(move |id, _| {
            send.send(id).unwrap();
        })
        .unwrap();
        watchdog.arm(1, Duration::from_secs(10), Expiry::Cancel);
        watchdog.arm(2, Duration::from_millis(1), Expiry::Retire);
        watchdog.clear(1);
        assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
        watchdog.arm(3, Duration::from_secs(10), Expiry::Retire);
        watchdog.clear(3);
        assert!(receive.recv_timeout(Duration::from_millis(20)).is_err());
    }
}
