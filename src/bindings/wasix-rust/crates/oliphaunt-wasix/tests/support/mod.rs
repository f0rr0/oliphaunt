use anyhow::Context;
use std::io::{BufReader, Read};
use std::process::Child;
use std::thread::JoinHandle;

pub(crate) struct TestTrace {
    name: &'static str,
}

impl TestTrace {
    pub(crate) fn new(name: &'static str) -> Self {
        eprintln!("{name} start");
        Self { name }
    }
}

impl Drop for TestTrace {
    fn drop(&mut self) {
        eprintln!("{} end", self.name);
    }
}

pub(crate) fn trace_step(label: &str) {
    eprintln!("{label}");
}

pub(crate) struct ChildGuard {
    child: Child,
    stderr: Option<JoinHandle<String>>,
}

impl ChildGuard {
    pub(crate) fn new(mut child: Child, name: &'static str) -> anyhow::Result<Self> {
        let stderr = child
            .stderr
            .take()
            .with_context(|| format!("{name} stderr pipe"))?;
        let stderr = std::thread::spawn(move || {
            let mut output = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut output);
            output
        });
        Ok(Self {
            child,
            stderr: Some(stderr),
        })
    }

    pub(crate) fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    pub(crate) fn collect_stderr(&mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stderr
            .take()
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.collect_stderr();
    }
}
