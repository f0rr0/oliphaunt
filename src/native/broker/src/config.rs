//! Configuration shared by the desktop helper and SDK launchers.

use std::time::Duration;

/// Default deadline for each accepted connection to finish its login handshake.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Encode a positive duration as whole milliseconds, rounding up by less than 1 ms.
/// The common signed 32-bit ceiling also fits JavaScript timers and OS socket APIs.
pub fn handshake_timeout_millis(timeout: Duration) -> Result<u32, &'static str> {
    let millis = timeout.as_nanos().div_ceil(1_000_000);
    if millis == 0 || millis > i32::MAX as u128 {
        return Err("broker handshake timeout must be between 1 and 2147483647 milliseconds");
    }
    Ok(millis as u32)
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
