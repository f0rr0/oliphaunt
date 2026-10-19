use std::io::{self, Cursor, SeekFrom};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll};

use anyhow::Result;
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use wasmer_wasix::virtual_fs::{self, VirtualFile};

use super::base::{DatabasePlan, prepare_database};
use super::config::{PostgresConfig, StartupConfig};
use super::storage::{DatabaseStorage, vfs_read};
use super::{CatalogProfile, Oliphaunt};

#[derive(Debug)]
struct CheckpointFile {
    bytes: Cursor<Vec<u8>>,
    fail_next_write: Arc<AtomicBool>,
    failures: Arc<AtomicUsize>,
}

impl AsyncRead for CheckpointFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.bytes).poll_read(cx, buf)
    }
}

impl AsyncWrite for CheckpointFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.fail_next_write.swap(false, Ordering::SeqCst) {
            self.failures.fetch_add(1, Ordering::SeqCst);
            return Poll::Ready(Err(io::Error::other("injected checkpoint write failure")));
        }
        Pin::new(&mut self.bytes).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.bytes).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.bytes).poll_shutdown(cx)
    }
}

impl AsyncSeek for CheckpointFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.bytes).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.bytes).poll_complete(cx)
    }
}

impl VirtualFile for CheckpointFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.bytes.get_ref().len() as u64
    }

    fn set_len(&mut self, len: u64) -> virtual_fs::Result<()> {
        self.bytes.get_mut().resize(len as usize, 0);
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(self.bytes.get_ref().len()))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(usize::MAX))
    }
}

#[test]
#[ignore = "requires the rebuilt guest; selected by runtime-smoke.sh"]
fn deferred_checkpoint_write_error_recovers_and_retries_before_ready() -> Result<()> {
    let (finished, result) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let _ = finished.send(checkpoint_write_error_recovers());
    });
    let result = result
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("checkpoint error recovery must not leave a held lock");
    worker.join().expect("checkpoint recovery worker panicked");
    result
}

fn checkpoint_write_error_recovers() -> Result<()> {
    let prepared = prepare_database(
        DatabasePlan::new(DatabaseStorage::Memory, CatalogProfile::Standard),
        "postgres",
    )?;
    let filesystem = prepared
        .outcome
        .pgdata_storage
        .memory_filesystem()
        .expect("memory database")
        .as_ref();
    let memory = filesystem
        .upcast_any_ref()
        .downcast_ref::<virtual_fs::mem_fs::FileSystem>()
        .expect("memory filesystem");
    let path = Path::new("/pg_xact/0000");
    let fail_next_write = Arc::new(AtomicBool::new(false));
    let failures = Arc::new(AtomicUsize::new(0));
    memory.insert_device_file(
        path.to_owned(),
        Box::new(CheckpointFile {
            bytes: Cursor::new(vfs_read(filesystem, path)?),
            fail_next_write: fail_next_write.clone(),
            failures: failures.clone(),
        }),
    )?;

    let mut config = PostgresConfig::default();
    config.insert("max_wal_size", "64MB");
    config.insert("min_wal_size", "32MB");
    #[cfg(not(feature = "extensions"))]
    let mut database =
        Oliphaunt::new_prepared_with_config(prepared.outcome, config, StartupConfig::default())?;
    #[cfg(feature = "extensions")]
    let mut database = Oliphaunt::new_prepared_with_config_and_extension_preload(
        prepared.outcome,
        config,
        StartupConfig::default(),
        &[],
    )?;
    database.execute("CHECKPOINT")?;
    let before =
        database.query("SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()")?;

    // Commit status stays buffered until checkpoint, after this transaction commits.
    fail_next_write.store(true, Ordering::SeqCst);
    let error = database
        .execute(&super::test_fixtures::text(
            "postgres/checkpoint-pressure.sql",
        ))
        .expect_err("checkpoint must report the injected file write error");
    assert_eq!(failures.load(Ordering::SeqCst), 1);
    assert_eq!(
        error
            .postgres_error()
            .and_then(|error| error.sqlstate.as_deref()),
        Some("58030"),
        "{error}",
    );
    assert!(
        !database.is_closed(),
        "checkpoint ERROR must preserve the session"
    );

    assert_eq!(
        database
            .query("SELECT count(*)::text AS rows FROM checkpoint_pressure")?
            .get_text(0, "rows")?,
        Some("1280"),
        "checkpoint failure must not repeat or discard the committed transaction",
    );
    let after =
        database.query("SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()")?;
    assert_ne!(before.get_text(0, "lsn")?, after.get_text(0, "lsn")?);
    database.close()?;
    Ok(())
}
