use std::sync::Arc;

use anyhow::Result;

pub(crate) type TerminalCloseResult = std::result::Result<(), Arc<str>>;

/// Run a destructive close boundary once and retain its exact public outcome.
pub(crate) fn terminal_close(
    outcome: &mut Option<TerminalCloseResult>,
    close: impl FnOnce() -> Result<()>,
) -> TerminalCloseResult {
    if let Some(outcome) = outcome {
        return outcome.clone();
    }
    let result = close().map_err(|error| Arc::<str>::from(error.to_string()));
    *outcome = Some(result.clone());
    result
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn terminal_failure_is_executed_once_and_replayed_exactly() {
        let calls = Cell::new(0);
        let mut outcome = None;

        for _ in 0..2 {
            let result = terminal_close(&mut outcome, || {
                calls.set(calls.get() + 1);
                anyhow::bail!("injected teardown failure")
            });
            assert_eq!(
                result.expect_err("teardown fails").as_ref(),
                "injected teardown failure"
            );
        }
        assert_eq!(calls.get(), 1);
    }
}
