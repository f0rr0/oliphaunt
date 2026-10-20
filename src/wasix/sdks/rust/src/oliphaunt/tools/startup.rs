use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use wasmer_wasix::os::task::process::WasiProcess;
use wasmer_wasix::wasmer_wasix_types::types::Signal;

pub(super) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn validate_timeout(timeout: Duration) -> Result<()> {
    if timeout.is_zero() || timeout.as_nanos().div_ceil(1_000_000) > i32::MAX as u128 {
        return Err(crate::error::invalid_configuration(
            "tool startup timeout must be 1..=2147483647 milliseconds",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct State {
    connected: bool,
    expired: bool,
    process: Option<WasiProcess>,
}

pub(super) struct Startup {
    deadline: Instant,
    state: Mutex<State>,
}

impl Startup {
    pub(super) fn new(timeout: Duration, deadline: Option<Instant>) -> Result<Self> {
        validate_timeout(timeout)?;
        Ok(Self {
            deadline: deadline.unwrap_or_else(|| Instant::now() + timeout),
            state: Mutex::new(State::default()),
        })
    }

    pub(super) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub(super) fn check(&self) -> Result<()> {
        if self.remaining().is_zero() && self.expire() {
            bail!("WASIX tool startup deadline exceeded before protocol connection");
        }
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).expired {
            bail!("WASIX tool startup deadline exceeded before protocol connection");
        }
        Ok(())
    }

    pub(super) fn register(&self, process: WasiProcess) -> Result<()> {
        self.check()?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.expired {
            bail!("WASIX tool startup deadline exceeded");
        }
        if !state.connected && state.process.is_none() {
            state.process = Some(process);
        }
        Ok(())
    }

    pub(super) fn connected(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.expired || self.remaining().is_zero() {
            bail!("WASIX tool startup deadline exceeded before protocol connection");
        }
        state.connected = true;
        state.process = None;
        Ok(())
    }

    pub(super) fn expire(&self) -> bool {
        let process = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.connected {
                return false;
            }
            state.expired = true;
            state.process.take()
        };
        // Stop the owned guest before joining its runner; abandoning a JoinHandle
        // would leave mutable execution and destinations alive after failure.
        if let Some(process) = process {
            process.signal_process(Signal::Sigkill);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_and_expiry_cannot_reclassify_each_other() {
        let ready = Startup::new(Duration::from_secs(1), None).unwrap();
        ready.connected().unwrap();
        assert!(!ready.expire());
        ready.check().unwrap();
        let expired = Startup::new(Duration::from_secs(1), None).unwrap();
        assert!(expired.expire());
        assert!(expired.connected().is_err());
        assert!(expired.check().is_err());
        assert!(Startup::new(Duration::ZERO, None).is_err());
    }
}
