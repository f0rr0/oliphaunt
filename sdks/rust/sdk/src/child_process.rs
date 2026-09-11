use std::process::Child;
use std::thread;
use std::time::{Duration, Instant};

pub(crate) trait ChildProcessReaper {
    fn try_exit_status(&mut self) -> std::io::Result<Option<bool>>;
    fn kill_process(&mut self) -> std::io::Result<()>;
}

impl ChildProcessReaper for Child {
    fn try_exit_status(&mut self) -> std::io::Result<Option<bool>> {
        self.try_wait()
            .map(|status| status.map(|status| status.success()))
    }

    fn kill_process(&mut self) -> std::io::Result<()> {
        self.kill()
    }
}

pub(crate) struct ChildReapOutcome {
    pub(crate) reaped: bool,
    pub(crate) exit_success: Option<bool>,
    pub(crate) failures: Vec<String>,
}

pub(crate) fn reap_child_process(
    child: &mut impl ChildProcessReaper,
    graceful_timeout: Duration,
    forced_timeout: Duration,
    label: &str,
) -> ChildReapOutcome {
    let mut failures = Vec::new();
    match wait_for_child_exit(child, graceful_timeout) {
        Ok(Some(exit_success)) => {
            return ChildReapOutcome {
                reaped: true,
                exit_success: Some(exit_success),
                failures,
            };
        }
        Ok(None) => failures.push(format!(
            "{label} did not stop within {}ms",
            graceful_timeout.as_millis()
        )),
        Err(error) => failures.push(format!("wait for {label}: {error}")),
    }

    if let Err(error) = child.kill_process() {
        failures.push(format!(
            "kill {label} after failed graceful shutdown: {error}"
        ));
    }
    match wait_for_child_exit(child, forced_timeout) {
        Ok(Some(exit_success)) => ChildReapOutcome {
            reaped: true,
            exit_success: Some(exit_success),
            failures,
        },
        Ok(None) => {
            failures.push(format!(
                "{label} reap remained unconfirmed {}ms after kill",
                forced_timeout.as_millis()
            ));
            ChildReapOutcome {
                reaped: false,
                exit_success: None,
                failures,
            }
        }
        Err(error) => {
            failures.push(format!("poll {label} after kill: {error}"));
            ChildReapOutcome {
                reaped: false,
                exit_success: None,
                failures,
            }
        }
    }
}

fn wait_for_child_exit(
    child: &mut impl ChildProcessReaper,
    timeout: Duration,
) -> std::io::Result<Option<bool>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(success) = child.try_exit_status()? {
            return Ok(Some(success));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FailingChildReaper {
        exited: bool,
        try_errors: usize,
        kill_error: bool,
        try_calls: usize,
        kill_calls: usize,
    }

    impl ChildProcessReaper for FailingChildReaper {
        fn try_exit_status(&mut self) -> std::io::Result<Option<bool>> {
            self.try_calls += 1;
            if self.try_errors > 0 {
                self.try_errors -= 1;
                Err(std::io::Error::other("fixture child poll failed"))
            } else {
                Ok(self.exited.then_some(true))
            }
        }

        fn kill_process(&mut self) -> std::io::Result<()> {
            self.kill_calls += 1;
            if self.kill_error {
                Err(std::io::Error::other("fixture child kill failed"))
            } else {
                self.exited = true;
                Ok(())
            }
        }
    }

    #[test]
    fn retains_ownership_when_kill_or_reap_is_unconfirmed() {
        let mut kill_and_reap_failure = FailingChildReaper {
            try_errors: 2,
            kill_error: true,
            ..FailingChildReaper::default()
        };
        let outcome = reap_child_process(
            &mut kill_and_reap_failure,
            Duration::ZERO,
            Duration::ZERO,
            "fixture process",
        );
        assert!(!outcome.reaped);
        assert_eq!(kill_and_reap_failure.try_calls, 2);
        assert_eq!(kill_and_reap_failure.kill_calls, 1);
        assert_eq!(outcome.failures.len(), 3);
        assert!(outcome.failures[0].contains("fixture child poll failed"));
        assert!(outcome.failures[1].contains("fixture child kill failed"));
        assert!(outcome.failures[2].contains("fixture child poll failed"));

        let mut reap_failure = FailingChildReaper {
            kill_error: true,
            ..FailingChildReaper::default()
        };
        let outcome = reap_child_process(
            &mut reap_failure,
            Duration::ZERO,
            Duration::ZERO,
            "fixture process",
        );
        assert!(!outcome.reaped);
        assert_eq!(reap_failure.kill_calls, 1);
        assert_eq!(outcome.failures.len(), 3);
        assert!(outcome.failures[0].contains("did not stop"));
        assert!(outcome.failures[1].contains("fixture child kill failed"));
        assert!(outcome.failures[2].contains("reap remained unconfirmed"));
    }

    #[test]
    fn releases_ownership_after_a_forced_reap() {
        let mut child = FailingChildReaper::default();
        let outcome = reap_child_process(
            &mut child,
            Duration::ZERO,
            Duration::ZERO,
            "fixture process",
        );
        assert!(outcome.reaped);
        assert_eq!(child.kill_calls, 1);
        assert_eq!(outcome.failures.len(), 1);
        assert!(outcome.failures[0].contains("did not stop"));

        let mut exited_between_kill_and_wait = FailingChildReaper {
            try_errors: 1,
            ..FailingChildReaper::default()
        };
        let outcome = reap_child_process(
            &mut exited_between_kill_and_wait,
            Duration::ZERO,
            Duration::ZERO,
            "fixture process",
        );
        assert!(outcome.reaped);
        assert_eq!(exited_between_kill_and_wait.kill_calls, 1);
        assert_eq!(outcome.failures.len(), 1);
        assert!(outcome.failures[0].contains("fixture child poll failed"));
    }
}
