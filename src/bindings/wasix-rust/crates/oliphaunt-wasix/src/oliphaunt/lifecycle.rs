use std::mem::ManuallyDrop;
use std::ops::{Deref, DerefMut};
use std::panic::{AssertUnwindSafe, catch_unwind};

use anyhow::Result;

use crate::Error;

pub(crate) type TerminalCloseResult = crate::Result<()>;

/// Ownership which may only be released after teardown is known to have
/// succeeded.
///
/// Dropping this wrapper deliberately does not run `T`'s destructor. This is
/// the conservative terminal-failure path: once destructive PostgreSQL
/// teardown has started and returned an error, running ordinary Rust
/// destructors could release a managed-root lock or partially destroy a WASIX
/// backend whose state is no longer known. [`Self::release`] is therefore the
/// only way to destroy the value, and callers invoke it only after successful
/// teardown.
#[derive(Debug)]
pub(crate) struct TeardownOwnership<T> {
    value: Option<ManuallyDrop<T>>,
}

impl<T> TeardownOwnership<T> {
    pub(crate) fn new(value: T) -> Self {
        Self {
            value: Some(ManuallyDrop::new(value)),
        }
    }

    /// Release this ownership exactly once after successful teardown.
    pub(crate) fn release(&mut self) {
        if let Some(value) = self.value.take() {
            // `take` gives this call the sole remaining path to the value.
            // Leaving `None` makes repeated release safe.
            drop(ManuallyDrop::into_inner(value));
        }
    }

    #[cfg(test)]
    pub(crate) fn is_released(&self) -> bool {
        self.value.is_none()
    }
}

impl<T> Deref for TeardownOwnership<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.value
            .as_deref()
            .expect("teardown ownership was already released")
    }
}

impl<T> DerefMut for TeardownOwnership<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.value
            .as_deref_mut()
            .expect("teardown ownership was already released")
    }
}

/// Run a destructive close boundary once and retain its exact public outcome.
pub(crate) fn terminal_close(
    outcome: &mut Option<TerminalCloseResult>,
    owner: &'static str,
    close: impl FnOnce() -> Result<()>,
) -> TerminalCloseResult {
    if let Some(outcome) = outcome {
        return outcome.clone();
    }
    let result = teardown_result(owner, close);
    *outcome = Some(result.clone());
    result
}

/// Contain teardown panics at the ownership boundary. A panic means teardown
/// began without proving completion, so callers quarantine ownership just as
/// they do for an ordinary returned error.
pub(crate) fn teardown_result(
    owner: &'static str,
    close: impl FnOnce() -> Result<()>,
) -> TerminalCloseResult {
    match catch_unwind(AssertUnwindSafe(close)) {
        Ok(result) => result.map_err(Error::from_anyhow),
        Err(panic) => Err(Error::message(format!(
            "{owner} panicked during teardown: {}",
            panic_message(panic.as_ref())
        ))),
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&'static str>().copied())
        .unwrap_or("unknown panic payload")
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;

    #[test]
    fn terminal_failure_is_executed_once_and_replayed_exactly() {
        let calls = Cell::new(0);
        let mut outcome = None;

        for _ in 0..2 {
            let result = terminal_close(&mut outcome, "test owner", || {
                calls.set(calls.get() + 1);
                anyhow::bail!("injected teardown failure")
            });
            assert_eq!(
                result.expect_err("teardown fails").to_string(),
                "injected teardown failure"
            );
        }
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn terminal_panic_is_contained_and_replayed_without_retry() {
        let calls = Cell::new(0);
        let mut outcome = None;

        for _ in 0..2 {
            let error = terminal_close(&mut outcome, "test owner", || {
                calls.set(calls.get() + 1);
                panic!("injected teardown panic")
            })
            .expect_err("teardown panic becomes a terminal error");
            assert_eq!(
                error.to_string(),
                "test owner panicked during teardown: injected teardown panic"
            );
        }
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn teardown_ownership_releases_only_on_explicit_success_path() {
        struct DropProbe(Rc<Cell<usize>>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.set(self.0.get() + 1);
            }
        }

        let successful_drops = Rc::new(Cell::new(0));
        {
            let mut successful = TeardownOwnership::new(DropProbe(Rc::clone(&successful_drops)));
            successful.release();
            successful.release();
        }
        assert_eq!(successful_drops.get(), 1);

        let quarantined_drops = Rc::new(Cell::new(0));
        {
            let _quarantined = TeardownOwnership::new(DropProbe(Rc::clone(&quarantined_drops)));
        }
        assert_eq!(quarantined_drops.get(), 0);
    }
}
