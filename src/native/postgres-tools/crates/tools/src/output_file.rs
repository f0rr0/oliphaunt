use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{CapturedOutput, PostgresToolError, PostgresToolSummary, io_failure};

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) fn write(
    tool: &'static str,
    destination: &Path,
    run: impl FnOnce(&mut File) -> Result<PostgresToolSummary, PostgresToolError>,
) -> Result<PostgresToolSummary, PostgresToolError> {
    let failure = |error| io_failure(tool, None, CapturedOutput::default(), error);
    let parent = destination.parent().unwrap_or(Path::new("."));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let (staging, mut file) = loop {
        let path = parent.join(format!(
            ".oliphaunt-tool-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        match options.open(&path) {
            Ok(file) => break (Staging(path), file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(failure(error)),
        }
    };
    let output = run(&mut file)?;
    let failure = |error| {
        io_failure(
            tool,
            Some(0),
            CapturedOutput {
                stderr: output.stderr.as_bytes().to_vec(),
                stderr_truncated: output.stderr_truncated,
                ..CapturedOutput::default()
            },
            error,
        )
    };
    file.flush().map_err(failure)?;
    drop(file);
    // A hard link atomically creates the destination without replacing any file.
    fs::hard_link(&staging.0, destination).map_err(failure)?;
    fs::remove_file(&staging.0).map_err(|error| {
        failure(std::io::Error::new(
            error.kind(),
            format!(
                "output was published to {}; could not remove staging file {}: {error}",
                destination.display(),
                staging.0.display()
            ),
        ))
    })?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_publication_is_create_only_and_failure_leaves_no_partial_destination() {
        let root = std::env::temp_dir().join(format!(
            "oliphaunt-tool-output-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let destination = root.join("dump.sql");
        let run = |file: &mut File| {
            file.write_all(b"complete").unwrap();
            Ok(PostgresToolSummary {
                stdout_bytes: 8,
                stderr: String::new(),
                stderr_truncated: false,
            })
        };
        write("pg_dump", &destination, run).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(write("pg_dump", &destination, run).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"complete");
        let failed = root.join("failed.sql");
        assert!(
            write("psql", &failed, |file| {
                file.write_all(b"partial").unwrap();
                Err(crate::configuration_error("psql", "tool failed"))
            })
            .is_err()
        );
        assert!(!failed.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
