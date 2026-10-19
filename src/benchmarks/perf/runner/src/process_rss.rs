use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result};

pub(crate) struct ProcessTreeRssSampler {
    root_pid: u32,
    peak_bytes: u64,
    warned: bool,
}

impl ProcessTreeRssSampler {
    pub(crate) fn new(root_pid: u32) -> Self {
        Self {
            root_pid,
            peak_bytes: 0,
            warned: false,
        }
    }

    pub(crate) fn sample(&mut self) {
        match process_tree_rss_bytes(self.root_pid) {
            Ok(Some(bytes)) => {
                self.peak_bytes = self.peak_bytes.max(bytes);
            }
            Ok(None) => {}
            Err(err) => {
                if !self.warned {
                    eprintln!(
                        "warning: failed to sample native Postgres server RSS for pid {}: {err}",
                        self.root_pid
                    );
                    self.warned = true;
                }
            }
        }
    }

    pub(crate) fn peak_bytes(&self) -> Option<u64> {
        (self.peak_bytes > 0).then_some(self.peak_bytes)
    }
}

pub(crate) struct NativeLiboliphauntChildRssSampler {
    parent_pid: u32,
    peak_bytes: u64,
    warned: bool,
}

impl NativeLiboliphauntChildRssSampler {
    pub(crate) fn new() -> Self {
        Self {
            parent_pid: std::process::id(),
            peak_bytes: 0,
            warned: false,
        }
    }

    pub(crate) fn sample(&mut self) {
        match process_descendants_rss_bytes(self.parent_pid) {
            Ok(Some(bytes)) => {
                self.peak_bytes = self.peak_bytes.max(bytes);
            }
            Ok(None) => {}
            Err(err) => {
                if !self.warned {
                    eprintln!(
                        "warning: failed to sample native liboliphaunt child RSS for parent pid {}: {err}",
                        self.parent_pid
                    );
                    self.warned = true;
                }
            }
        }
    }

    pub(crate) fn peak_bytes(&self) -> Option<u64> {
        (self.peak_bytes > 0).then_some(self.peak_bytes)
    }
}

fn process_tree_rss_bytes(root_pid: u32) -> Result<Option<u64>> {
    let process_table = sample_process_table()?;
    if !process_table.rss_by_pid.contains_key(&root_pid) {
        return Ok(None);
    }

    Ok(Some(sum_process_tree_rss(&process_table, vec![root_pid])))
}

fn process_descendants_rss_bytes(parent_pid: u32) -> Result<Option<u64>> {
    let process_table = sample_process_table()?;
    let Some(children) = process_table.children_by_parent.get(&parent_pid) else {
        return Ok(None);
    };

    let total = sum_process_tree_rss(&process_table, children.clone());
    Ok((total > 0).then_some(total))
}

fn sum_process_tree_rss(process_table: &ProcessTable, roots: Vec<u32>) -> u64 {
    let mut total = 0u64;
    let mut stack = roots;
    let mut seen = HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        total = total.saturating_add(
            process_table
                .rss_by_pid
                .get(&pid)
                .copied()
                .unwrap_or_default(),
        );
        if let Some(children) = process_table.children_by_parent.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }
    total
}

struct ProcessTable {
    rss_by_pid: HashMap<u32, u64>,
    children_by_parent: HashMap<u32, Vec<u32>>,
}

fn sample_process_table() -> Result<ProcessTable> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss="])
        .output()
        .context("sample process RSS with ps")?;
    if !output.status.success() {
        return Ok(ProcessTable {
            rss_by_pid: HashMap::new(),
            children_by_parent: HashMap::new(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rss_by_pid = HashMap::<u32, u64>::new();
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(parent_pid), Some(rss_kb)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(parent_pid), Ok(rss_kb)) = (
            pid.parse::<u32>(),
            parent_pid.parse::<u32>(),
            rss_kb.parse::<u64>(),
        ) else {
            continue;
        };
        rss_by_pid.insert(pid, rss_kb.saturating_mul(1024));
        children_by_parent.entry(parent_pid).or_default().push(pid);
    }
    Ok(ProcessTable {
        rss_by_pid,
        children_by_parent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_root_process_and_descendants() {
        let process_table = ProcessTable {
            rss_by_pid: HashMap::from([(1, 100), (2, 20), (3, 30), (4, 4), (9, 900)]),
            children_by_parent: HashMap::from([(1, vec![2, 3]), (3, vec![4]), (9, vec![])]),
        };

        assert_eq!(sum_process_tree_rss(&process_table, vec![1]), 154);
    }

    #[test]
    fn sums_multiple_roots_without_double_counting_cycles() {
        let process_table = ProcessTable {
            rss_by_pid: HashMap::from([(1, 10), (2, 20), (3, 30)]),
            children_by_parent: HashMap::from([(1, vec![2, 3]), (2, vec![3]), (3, vec![1])]),
        };

        assert_eq!(sum_process_tree_rss(&process_table, vec![1, 2]), 60);
    }
}
