//! Configuration shared by the desktop helper and SDK launchers.

use std::time::Duration;

/// Default deadline for each accepted connection to finish its login handshake.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Grace for a cancelled/disconnected operation to settle before owner retirement.
pub const DEFAULT_RECOVERY_TIMEOUT: Duration = Duration::from_secs(3);
/// Pending logins per endpoint. Management has its own allowance so SQL cannot exhaust it.
pub const DEFAULT_MAX_PENDING_HANDSHAKES: usize = 16;

/// Mobile broker cleanup budgets, shared by the client and dedicated worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrokerTimeouts {
    /// Time to receive a terminal result after cancellation or worker interruption.
    pub recovery_timeout: Duration,
    /// Time from starting destructive close until forced retirement.
    pub shutdown_timeout: Duration,
}

impl Default for BrokerTimeouts {
    fn default() -> Self {
        Self {
            recovery_timeout: DEFAULT_RECOVERY_TIMEOUT,
            shutdown_timeout: DEFAULT_RECOVERY_TIMEOUT,
        }
    }
}

impl BrokerTimeouts {
    /// Reject invalid portable timer durations before starting either owner.
    pub fn validate(self) -> Result<(), &'static str> {
        timeout_millis(self.recovery_timeout)?;
        timeout_millis(self.shutdown_timeout)?;
        Ok(())
    }
}

/// Positive portable timer duration, rounded up to whole milliseconds.
pub fn timeout_millis(timeout: Duration) -> Result<u32, &'static str> {
    let millis = timeout.as_nanos().div_ceil(1_000_000);
    if millis == 0 || millis > i32::MAX as u128 {
        return Err("timeout must be between 1 and 2147483647 milliseconds");
    }
    Ok(millis as u32)
}

/// Encode a positive duration as whole milliseconds, rounding up by less than 1 ms.
/// The common signed 32-bit ceiling also fits JavaScript timers and OS socket APIs.
pub fn handshake_timeout_millis(timeout: Duration) -> Result<u32, &'static str> {
    timeout_millis(timeout)
        .map_err(|_| "broker handshake timeout must be between 1 and 2147483647 milliseconds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_timeout_has_one_portable_encoding() {
        assert_eq!(
            handshake_timeout_millis(DEFAULT_HANDSHAKE_TIMEOUT),
            Ok(5_000)
        );
        assert_eq!(handshake_timeout_millis(Duration::from_nanos(1)), Ok(1));
        assert_eq!(
            handshake_timeout_millis(Duration::from_micros(1_001)),
            Ok(2)
        );
        assert_eq!(
            handshake_timeout_millis(Duration::from_millis(i32::MAX as u64)),
            Ok(i32::MAX as u32)
        );
        for timeout in [Duration::ZERO, Duration::from_millis(i32::MAX as u64 + 1)] {
            assert!(handshake_timeout_millis(timeout).is_err());
        }
    }
}
