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
    reap_child_process_until(
        child,
        Instant::now() + graceful_timeout,
        forced_timeout,
        label,
    )
}

pub(crate) fn reap_child_process_until(
    child: &mut impl ChildProcessReaper,
    graceful_deadline: Instant,
    forced_timeout: Duration,
    label: &str,
) -> ChildReapOutcome {
    reap_child_processes_until(&mut [(child, label)], graceful_deadline, forced_timeout)
        .pop()
        .expect("one child has one reap outcome")
}

/// Escalate every unresolved owner before spending the shared forced-reap budget.
pub(crate) fn reap_child_processes_until(
    children: &mut [(&mut dyn ChildProcessReaper, &str)],
    graceful_deadline: Instant,
    forced_timeout: Duration,
) -> Vec<ChildReapOutcome> {
    let mut outcomes: Vec<_> = children
        .iter()
        .map(|_| ChildReapOutcome {
            reaped: false,
            exit_success: None,
            failures: Vec::new(),
        })
        .collect();
    let graceful_failed = wait_for_children_exit(children, &mut outcomes, graceful_deadline, false);
    let forced_deadline = Instant::now() + forced_timeout;
    for (index, (child, label)) in children.iter_mut().enumerate() {
        let outcome = &mut outcomes[index];
        if outcome.reaped {
            continue;
        }
        if !graceful_failed[index] {
            outcome
                .failures
                .push(format!("{label} did not stop before the shutdown deadline"));
        }
        if let Err(error) = child.kill_process() {
            outcome.failures.push(format!(
                "kill {label} after failed graceful shutdown: {error}"
            ));
        }
    }
    let forced_failed = wait_for_children_exit(children, &mut outcomes, forced_deadline, true);
    for (index, (_, label)) in children.iter().enumerate() {
        if !outcomes[index].reaped && !forced_failed[index] {
            outcomes[index].failures.push(format!(
                "{label} reap remained unconfirmed {}ms after kill",
                forced_timeout.as_millis()
            ));
        }
    }
    outcomes
}

fn wait_for_children_exit(
    children: &mut [(&mut dyn ChildProcessReaper, &str)],
    outcomes: &mut [ChildReapOutcome],
    deadline: Instant,
    after_kill: bool,
) -> Vec<bool> {
    let mut failed = vec![false; children.len()];
    loop {
        for (index, (child, label)) in children.iter_mut().enumerate() {
            if outcomes[index].reaped || failed[index] {
                continue;
            }
            match child.try_exit_status() {
                Ok(Some(success)) => {
                    outcomes[index].reaped = true;
                    outcomes[index].exit_success = Some(success);
                }
                Ok(None) => {}
                Err(error) => {
                    failed[index] = true;
                    outcomes[index].failures.push(if after_kill {
                        format!("poll {label} after kill: {error}")
                    } else {
                        format!("wait for {label}: {error}")
                    });
                }
            }
        }
        if outcomes
            .iter()
            .enumerate()
            .all(|(index, outcome)| outcome.reaped || failed[index])
            || Instant::now() >= deadline
        {
            return failed;
        }
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escalates_all_children_before_reaping_any_forced_exit() {
        use std::cell::RefCell;
        use std::rc::Rc;

        struct Child {
            killed: bool,
            kills: Rc<RefCell<usize>>,
        }
        impl ChildProcessReaper for Child {
            fn try_exit_status(&mut self) -> std::io::Result<Option<bool>> {
                if self.killed {
                    assert_eq!(
                        *self.kills.borrow(),
                        2,
                        "all owners must be escalated before forced reap"
                    );
                    Ok(Some(true))
                } else {
                    Ok(None)
                }
            }
            fn kill_process(&mut self) -> std::io::Result<()> {
                self.killed = true;
                *self.kills.borrow_mut() += 1;
                Ok(())
            }
        }
        let kills = Rc::new(RefCell::new(0));
        let mut command = Child {
            killed: false,
            kills: kills.clone(),
        };
        let mut server = Child {
            killed: false,
            kills,
        };
        let outcomes = reap_child_processes_until(
            &mut [(&mut command, "command"), (&mut server, "server")],
            Instant::now(),
            Duration::ZERO,
        );
        assert!(
            outcomes
                .iter()
                .all(|outcome| outcome.reaped && outcome.failures.len() == 1)
        );
    }

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
