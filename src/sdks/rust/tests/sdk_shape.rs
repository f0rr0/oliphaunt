use std::future::Future;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use oliphaunt::{
    BackgroundCheckpointSkipReason, BackgroundPreparationOptions, BackgroundPreparationResult,
    BackupArtifact, BackupFormat, BackupRequest, DatabaseRoot, EngineCancel, EngineCapabilities,
    EngineMode, EngineSession, Error, NativeRuntime, Oliphaunt, ProtocolRequest, ProtocolResponse,
    RestoreRequest, RestoreTargetPolicy, Result,
};

#[test]
fn restore_physical_archive_materializes_pgdata_layout() {
    let root = unique_temp_root("oliphaunt-restore-api");
    let restored = block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &root,
        minimal_physical_archive(),
    )))
    .unwrap();

    assert_eq!(restored, root);
    assert!(root.join("pgdata/PG_VERSION").is_file());
    assert!(root.join("pgdata/global/pg_control").is_file());
    assert!(root.join("pgdata/backup_label").is_file());
    assert!(root.join("manifest.properties").is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn restore_physical_archive_can_publish_into_empty_existing_directory() {
    let root = unique_temp_root("oliphaunt-restore-empty-existing");
    std::fs::create_dir_all(&root).unwrap();

    let restored = block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &root,
        minimal_physical_archive(),
    )))
    .unwrap();

    assert_eq!(restored, root);
    assert!(root.join("pgdata/PG_VERSION").is_file());
    assert!(!root.join(".oliphaunt.lock").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn restore_physical_archive_rejects_symlink_targets() {
    let parent = unique_temp_root("oliphaunt-restore-symlink");
    let real = parent.join("real-root");
    let link = parent.join("link-root");
    std::fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let error = block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &link,
        minimal_physical_archive(),
    )))
    .unwrap_err();
    assert!(
        error.to_string().contains("symlink target"),
        "unexpected restore symlink error: {error}"
    );
    assert!(
        link.symlink_metadata().unwrap().file_type().is_symlink(),
        "restore modified the symlink target"
    );
    assert!(std::fs::read_dir(&real).unwrap().next().is_none());
    let _ = std::fs::remove_dir_all(parent);
}

#[test]
fn restore_physical_archive_rejects_non_empty_targets_by_default() {
    let root = unique_temp_root("oliphaunt-restore-non-empty");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("sentinel"), b"existing").unwrap();

    let error = block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &root,
        minimal_physical_archive(),
    )))
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("refusing to restore into non-empty target"),
        "unexpected restore error: {error}"
    );
    assert_eq!(std::fs::read(root.join("sentinel")).unwrap(), b"existing");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn restore_physical_archive_can_replace_existing_roots() {
    let root = unique_temp_root("oliphaunt-restore-replace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("sentinel"), b"existing").unwrap();

    let restored = block_on(Oliphaunt::restore(
        RestoreRequest::physical_archive(&root, minimal_physical_archive()).replace_existing(),
    ))
    .unwrap();

    assert_eq!(restored, root);
    assert!(!root.join("sentinel").exists());
    assert!(root.join("pgdata/PG_VERSION").is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn restore_rejects_unsupported_formats_before_materializing_target() {
    let root = unique_temp_root("oliphaunt-restore-sql-reject");
    let error = block_on(Oliphaunt::restore(RestoreRequest {
        artifact: BackupArtifact {
            format: BackupFormat::Sql,
            bytes: b"sql-backup".to_vec(),
        },
        target: DatabaseRoot::Path(root.clone()),
        target_policy: RestoreTargetPolicy::FailIfExists,
    }))
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("restore currently requires a physical archive artifact, got Sql"),
        "unexpected restore format error: {error}"
    );
    assert!(
        !root.exists(),
        "unsupported restore format should not materialize the target root"
    );
}

#[test]
fn opened_handle_exposes_backup_restore_format_helpers() {
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-format-helper")
            .native_server()
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    assert!(db.supports_backup_format(BackupFormat::Sql));
    assert!(db.supports_backup_format(BackupFormat::PhysicalArchive));
    assert!(!db.supports_backup_format(BackupFormat::OliphauntArchive));
    assert!(db.supports_restore_format(BackupFormat::PhysicalArchive));
    assert!(!db.supports_restore_format(BackupFormat::Sql));

    block_on(db.close()).unwrap();
}

#[test]
fn opened_handle_rejects_unsupported_backup_formats_before_engine_call() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-format-helper-reject")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let error = block_on(db.backup(BackupRequest::sql())).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Sql backup is not supported by native-direct"),
        "unexpected backup format error: {error}"
    );
    assert!(
        calls.lock().unwrap().is_empty(),
        "unsupported backup format crossed into the engine"
    );

    block_on(db.close()).unwrap();
}

#[test]
fn cloned_handles_share_one_serial_owner_executor() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let cancels = Arc::new(AtomicUsize::new(0));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::clone(&cancels),
            })
            .open(),
    )
    .unwrap();

    let left = db.clone();
    let right = db.clone();
    let left = thread::spawn(move || block_on(left.exec_protocol_raw(vec![b'a'])).unwrap());
    let right = thread::spawn(move || block_on(right.exec_protocol_raw(vec![b'b'])).unwrap());

    let responses = [
        left.join().unwrap().into_bytes(),
        right.join().unwrap().into_bytes(),
    ];
    let mut sequence_numbers = responses
        .iter()
        .map(|response| response[0])
        .collect::<Vec<_>>();
    sequence_numbers.sort();
    let mut payloads = responses
        .iter()
        .map(|response| response[1])
        .collect::<Vec<_>>();
    payloads.sort();

    assert_eq!(sequence_numbers, vec![1, 2]);
    assert_eq!(payloads, vec![b'a', b'b']);
    assert_eq!(calls.lock().unwrap().len(), 2);
    db.cancel().unwrap();
    assert_eq!(cancels.load(Ordering::SeqCst), 1);
}

#[test]
fn cloned_handles_share_pin_and_close_state_for_every_sdk_mode() {
    for mode in EngineMode::all() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let db = block_on(
            builder_for_mode(mode, format!("target/test-roots/{mode}-clone-state"))
                .runtime(MockRuntime {
                    calls: Arc::clone(&calls),
                    cancels: Arc::new(AtomicUsize::new(0)),
                })
                .open(),
        )
        .unwrap();

        let owner = db.clone();
        let peer = db.clone();
        let pin = block_on(owner.pin_session()).unwrap();
        assert_eq!(
            block_on(peer.execute("SELECT outside cloned pin")).unwrap_err(),
            Error::SessionPinned,
            "{mode} clone executed unpinned work while another clone owned the session pin"
        );
        assert_eq!(
            block_on(pin.exec_protocol_raw(vec![b'p']))
                .unwrap()
                .into_bytes(),
            vec![1, b'p'],
            "{mode} pinned work did not use the shared owner executor"
        );
        block_on(pin.release()).unwrap();
        block_on(peer.execute("SELECT after cloned pin")).unwrap();

        block_on(owner.close()).unwrap();
        assert_eq!(
            block_on(peer.execute("SELECT after cloned close")).unwrap_err(),
            Error::EngineStopped,
            "{mode} close through one clone did not stop the shared executor"
        );

        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"SELECT after cloned pin")),
            "{mode} did not release the cloned session pin for later work: {calls:?}"
        );
        assert!(
            !calls
                .iter()
                .any(|call| raw_message_contains(call, b"SELECT after cloned close")),
            "{mode} executed work after clone-shared close: {calls:?}"
        );
    }
}

#[test]
fn cloned_handles_queue_fifo_on_one_owner_executor_for_every_sdk_mode() {
    for mode in EngineMode::all() {
        let state = Arc::new(BlockingState::default());
        let db = block_on(
            builder_for_mode(mode, format!("target/test-roots/{mode}-fifo-queue"))
                .runtime(BlockingRuntime {
                    state: Arc::clone(&state),
                })
                .open(),
        )
        .unwrap();

        let active = db.clone();
        let active_worker = thread::spawn(move || block_on(active.exec_protocol_raw(vec![b'L'])));
        state.wait_until_active();

        let first_handle = db.clone();
        let second_handle = db.clone();
        let mut first = Box::pin(first_handle.exec_protocol_raw(vec![b'1']));
        let mut second = Box::pin(second_handle.exec_protocol_raw(vec![b'2']));
        poll_once_pending(&mut first);
        poll_once_pending(&mut second);

        state.release();
        assert_eq!(
            active_worker.join().unwrap().unwrap().into_bytes(),
            b"finished".to_vec(),
            "{mode} active owner work did not finish cleanly"
        );
        assert_eq!(
            block_on_pinned(first).unwrap().into_bytes(),
            b"finished".to_vec(),
            "{mode} first queued operation failed"
        );
        assert_eq!(
            block_on_pinned(second).unwrap().into_bytes(),
            b"finished".to_vec(),
            "{mode} second queued operation failed"
        );
        block_on(db.close()).unwrap();

        assert_eq!(
            state.calls(),
            vec![vec![b'L'], vec![b'1'], vec![b'2']],
            "{mode} cloned handles did not preserve FIFO owner-executor order"
        );
    }
}

#[test]
fn raw_streaming_uses_the_same_owner_executor() {
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    block_on(db.exec_protocol_raw_stream(vec![b's'], move |chunk| {
        streamed_for_callback
            .lock()
            .unwrap()
            .extend_from_slice(chunk);
        Ok(())
    }))
    .unwrap();

    assert_eq!(*streamed.lock().unwrap(), vec![1, b's']);
}

#[test]
fn streaming_cancel_uses_out_of_band_cancel_and_releases_owner() {
    let state = Arc::new(StreamingCancelState::default());
    let cancels = Arc::new(AtomicUsize::new(0));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(StreamingCancelRuntime {
                state: Arc::clone(&state),
                cancels: Arc::clone(&cancels),
            })
            .open(),
    )
    .unwrap();

    let streamed_bytes = Arc::new(AtomicUsize::new(0));
    let streamed_for_callback = Arc::clone(&streamed_bytes);
    let streaming = db.clone();
    let worker = thread::spawn(move || {
        block_on(
            streaming.exec_protocol_raw_stream(vec![b'L'], move |chunk| {
                streamed_for_callback.fetch_add(chunk.len(), Ordering::SeqCst);
                Ok(())
            }),
        )
    });

    state.wait_until_streaming();
    let started = Instant::now();
    db.cancel().unwrap();
    let result = worker.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "streaming cancel was queued behind active owner work"
    );
    result.unwrap();
    assert_eq!(cancels.load(Ordering::SeqCst), 1);
    assert!(
        streamed_bytes.load(Ordering::SeqCst) >= 128 * 1024,
        "streaming fixture did not exercise a large response path"
    );
    assert!(state.was_stream_cancelled());

    let recovered = block_on(db.exec_protocol_raw(vec![b'r'])).unwrap();
    assert_eq!(
        recovered.into_bytes(),
        b"recovered-after-stream-cancel".to_vec()
    );
}

#[test]
fn execute_uses_the_engine_simple_query_path() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    // OLIPHAUNT_DOCS_SNIPPET rust-quickstart
    let response = block_on(db.execute("SELECT simple_query_path")).unwrap();
    let expected = b"\x01SSELECT simple_query_path".to_vec();
    assert_eq!(response.into_bytes(), expected);
    assert_eq!(*calls.lock().unwrap(), vec![expected]);
}

#[test]
fn session_pin_prevents_unpinned_interleaving() {
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let pin = block_on(db.pin_session()).unwrap();
    let error = block_on(db.exec_protocol_raw(vec![b'x'])).unwrap_err();
    assert_eq!(error, Error::SessionPinned);
    let checkpoint_error = block_on(db.checkpoint()).unwrap_err();
    assert_eq!(checkpoint_error, Error::SessionPinned);
    let backup_error = block_on(db.backup(BackupRequest::physical_archive())).unwrap_err();
    assert_eq!(backup_error, Error::SessionPinned);

    let pinned_response = block_on(pin.exec_protocol_raw(vec![b'p'])).unwrap();
    assert_eq!(pinned_response.into_bytes(), vec![1, b'p']);

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    block_on(pin.exec_protocol_raw_stream(vec![b's'], move |chunk| {
        streamed_for_callback
            .lock()
            .unwrap()
            .extend_from_slice(chunk);
        Ok(())
    }))
    .unwrap();
    assert_eq!(*streamed.lock().unwrap(), vec![2, b's']);

    block_on(pin.release()).unwrap();
    let unpinned_response = block_on(db.exec_protocol_raw(vec![b'u'])).unwrap();
    assert_eq!(unpinned_response.into_bytes(), vec![3, b'u']);
}

#[test]
fn lifecycle_prepare_for_background_checkpoints_when_idle_and_resume_probes_session() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct-lifecycle-idle")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let prepared =
        block_on(db.prepare_for_background(BackgroundPreparationOptions::default())).unwrap();
    assert_eq!(
        prepared,
        BackgroundPreparationResult {
            cancelled_active_work: false,
            checkpointed: true,
            skipped_checkpoint_reason: None,
        }
    );
    block_on(db.resume_from_background()).unwrap();

    let calls = calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .any(|call| raw_message_contains(call, b"CHECKPOINT")),
        "background preparation did not checkpoint when idle: {calls:?}"
    );
    assert!(
        calls
            .iter()
            .any(|call| raw_message_contains(call, b"SELECT 1")),
        "foreground resume did not probe the session: {calls:?}"
    );
}

#[test]
fn lifecycle_prepare_for_background_cancels_active_work_without_checkpointing() {
    let state = Arc::new(BlockingState::default());
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct-lifecycle-active")
            .runtime(BlockingRuntime {
                state: Arc::clone(&state),
            })
            .open(),
    )
    .unwrap();

    let active = db.clone();
    let worker = thread::spawn(move || block_on(active.exec_protocol_raw(vec![b'L'])));
    state.wait_until_active();

    let prepared =
        block_on(db.prepare_for_background(BackgroundPreparationOptions::default())).unwrap();
    assert_eq!(
        prepared,
        BackgroundPreparationResult {
            cancelled_active_work: true,
            checkpointed: false,
            skipped_checkpoint_reason: Some(BackgroundCheckpointSkipReason::ActiveWork),
        }
    );
    assert!(state.was_cancelled());
    assert_eq!(worker.join().unwrap().unwrap().into_bytes(), b"cancelled");
}

#[test]
fn lifecycle_prepare_for_background_skips_checkpoint_when_session_is_pinned() {
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct-lifecycle-pinned")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let pin = block_on(db.pin_session()).unwrap();
    let prepared =
        block_on(db.prepare_for_background(BackgroundPreparationOptions::default())).unwrap();
    assert_eq!(
        prepared,
        BackgroundPreparationResult {
            cancelled_active_work: false,
            checkpointed: false,
            skipped_checkpoint_reason: Some(BackgroundCheckpointSkipReason::SessionPinned),
        }
    );
    block_on(pin.release()).unwrap();
}

#[test]
fn transaction_pins_and_releases_the_direct_session() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
    )
    .unwrap();

    let tx = block_on(db.transaction()).unwrap();
    let error = block_on(db.execute("SELECT outside")).unwrap_err();
    assert_eq!(error, Error::SessionPinned);
    block_on(tx.execute("SELECT inside")).unwrap();
    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    block_on(tx.exec_protocol_raw_stream(vec![b't'], move |chunk| {
        streamed_for_callback
            .lock()
            .unwrap()
            .extend_from_slice(chunk);
        Ok(())
    }))
    .unwrap();
    assert_eq!(*streamed.lock().unwrap(), vec![3, b't']);
    block_on(tx.commit()).unwrap();
    block_on(db.execute("SELECT after")).unwrap();

    let calls = calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .any(|call| raw_message_contains(call, b"COMMIT")),
        "committed transaction did not send COMMIT: {calls:?}"
    );
    assert!(
        !calls
            .iter()
            .any(|call| raw_message_contains(call, b"ROLLBACK")),
        "committed transaction unexpectedly sent ROLLBACK: {calls:?}"
    );
}

#[test]
fn with_transaction_commits_rolls_back_and_rejects_unpinned_interleaving() {
    for mode in [EngineMode::NativeDirect, EngineMode::NativeBroker] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let db = block_on(
            builder_for_mode(
                mode,
                format!("target/test-roots/{mode}-closure-transaction"),
            )
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
        )
        .unwrap();

        let committed = block_on(db.with_transaction(async |tx| {
            let error = db.execute("SELECT outside closure").await.unwrap_err();
            assert_eq!(error, Error::SessionPinned);
            tx.execute("INSERT INTO rust_tx_scope VALUES (1)").await?;
            Ok::<_, Error>(11)
        }))
        .unwrap();
        assert_eq!(committed, 11);

        let failed = block_on(db.with_transaction(async |tx| {
            tx.execute("INSERT INTO rust_tx_scope VALUES (2)").await?;
            Err::<(), Error>(Error::Engine("closure failed".to_owned()))
        }))
        .unwrap_err();
        assert_eq!(failed, Error::Engine("closure failed".to_owned()));

        block_on(db.execute("SELECT after closure transaction")).unwrap();

        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"INSERT INTO rust_tx_scope VALUES (1)")),
            "{mode} committed closure transaction did not execute its body: {calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"COMMIT")),
            "{mode} successful closure transaction did not send COMMIT: {calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"ROLLBACK")),
            "{mode} failed closure transaction did not send ROLLBACK: {calls:?}"
        );
        assert!(
            raw_message_contains(calls.last().unwrap(), b"SELECT after closure transaction"),
            "{mode} session was not released after closure transaction failure: {calls:?}"
        );
    }
}

#[test]
fn transaction_commit_and_rollback_failures_release_serial_session() {
    for mode in [EngineMode::NativeDirect, EngineMode::NativeBroker] {
        assert_commit_failure_rolls_back_and_releases(mode);
        assert_rollback_failure_releases(mode);
        assert_body_failure_preserves_error_when_rollback_fails(mode);
    }
}

#[test]
fn close_during_transaction_stops_session_and_rejects_pinned_work() {
    for mode in [EngineMode::NativeDirect, EngineMode::NativeBroker] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let db = block_on(
            builder_for_mode(mode, format!("target/test-roots/{mode}-close-transaction"))
                .runtime(MockRuntime {
                    calls: Arc::clone(&calls),
                    cancels: Arc::new(AtomicUsize::new(0)),
                })
                .open(),
        )
        .unwrap();

        let error = block_on(db.with_transaction(async |tx| {
            db.close().await?;
            tx.execute("SELECT after close").await?;
            Ok::<_, Error>(())
        }))
        .unwrap_err();
        assert_eq!(error, Error::EngineStopped);
        assert_eq!(
            block_on(db.execute("SELECT after closed transaction")).unwrap_err(),
            Error::EngineStopped
        );

        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"BEGIN")),
            "{mode} transaction did not begin before close: {calls:?}"
        );
        assert!(
            !calls
                .iter()
                .any(|call| raw_message_contains(call, b"SELECT after close")),
            "{mode} pinned work ran after close: {calls:?}"
        );
        assert!(
            !calls
                .iter()
                .any(|call| raw_message_contains(call, b"COMMIT")),
            "{mode} transaction committed after close: {calls:?}"
        );
    }
}

#[test]
fn dropped_transaction_rolls_back_and_releases_the_direct_session() {
    for mode in [EngineMode::NativeDirect, EngineMode::NativeBroker] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let db = block_on(
            builder_for_mode(
                mode,
                format!("target/test-roots/{mode}-dropped-transaction"),
            )
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
            .open(),
        )
        .unwrap();

        {
            let tx = block_on(db.transaction()).unwrap();
            block_on(tx.execute("INSERT INTO dropped_transaction VALUES (1)")).unwrap();
        }

        block_on(db.execute("SELECT after dropped transaction")).unwrap();
        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| raw_message_contains(call, b"ROLLBACK")),
            "{mode} dropped transaction did not send ROLLBACK: {calls:?}"
        );
        assert!(
            raw_message_contains(calls.last().unwrap(), b"SELECT after dropped transaction"),
            "{mode} session was not released for work after dropped transaction: {calls:?}"
        );
    }
}

#[test]
fn close_waits_for_active_owner_work_before_shutdown() {
    let state = Arc::new(BlockingState::default());
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(BlockingRuntime {
                state: Arc::clone(&state),
            })
            .open(),
    )
    .unwrap();

    let active = db.clone();
    let worker = thread::spawn(move || block_on(active.execute("SELECT pg_sleep(5)")));
    state.wait_until_active();

    let closing = db.clone();
    let close_worker = thread::spawn(move || block_on(closing.close()));
    thread::sleep(Duration::from_millis(50));
    assert!(
        !state.was_closed(),
        "close returned before active work finished"
    );
    state.release();
    close_worker.join().unwrap().unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap().into_bytes(),
        b"finished".to_vec()
    );
    assert!(state.was_closed());
    assert!(
        !state.was_cancelled(),
        "close must not issue an implicit cancel"
    );
    assert_eq!(
        block_on(db.execute("SELECT after close")).unwrap_err(),
        Error::EngineStopped
    );
}

#[test]
fn close_rejects_work_already_queued_behind_active_query() {
    let state = Arc::new(BlockingState::default());
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(BlockingRuntime {
                state: Arc::clone(&state),
            })
            .open(),
    )
    .unwrap();

    let active = db.clone();
    let active_worker = thread::spawn(move || block_on(active.execute("SELECT active")));
    state.wait_until_active();

    let queued = db.clone();
    let queued_worker = thread::spawn(move || block_on(queued.execute("SELECT queued")));
    thread::sleep(Duration::from_millis(20));

    let closing = db.clone();
    let close_worker = thread::spawn(move || block_on(closing.close()));
    thread::sleep(Duration::from_millis(50));
    state.release();
    close_worker.join().unwrap().unwrap();
    assert_eq!(
        active_worker.join().unwrap().unwrap().into_bytes(),
        b"finished".to_vec()
    );
    assert_eq!(
        queued_worker.join().unwrap().unwrap_err(),
        Error::EngineStopped
    );
    assert!(state.was_closed());
    assert!(
        !state.was_cancelled(),
        "close must not issue an implicit cancel"
    );
}

#[test]
fn idle_close_does_not_issue_spurious_cancel() {
    let cancels = Arc::new(AtomicUsize::new(0));
    let db = block_on(
        Oliphaunt::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
                cancels: Arc::clone(&cancels),
            })
            .open(),
    )
    .unwrap();

    block_on(db.close()).unwrap();
    assert_eq!(cancels.load(Ordering::SeqCst), 0);
}

struct MockRuntime {
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    cancels: Arc<AtomicUsize>,
}

impl NativeRuntime for MockRuntime {
    fn open(&self, config: oliphaunt::OpenConfig) -> Result<Box<dyn EngineSession>> {
        Ok(Box::new(MockSession {
            mode: config.mode,
            calls: Arc::clone(&self.calls),
            cancels: Arc::clone(&self.cancels),
            count: 0,
        }))
    }
}

struct MockSession {
    mode: EngineMode,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    cancels: Arc<AtomicUsize>,
    count: u8,
}

struct MockCancel {
    cancels: Arc<AtomicUsize>,
}

impl EngineCancel for MockCancel {
    fn cancel(&self) -> Result<()> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

impl EngineSession for MockSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::for_mode(self.mode)
    }

    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = Arc::new(MockCancel {
            cancels: Arc::clone(&self.cancels),
        });
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        self.count += 1;
        let mut response = vec![self.count];
        response.extend_from_slice(request.as_bytes());
        self.calls.lock().unwrap().push(response.clone());
        Ok(ProtocolResponse::new(response))
    }

    fn exec_simple_query(&mut self, sql: &str) -> Result<ProtocolResponse> {
        self.count += 1;
        let mut response = vec![self.count, b'S'];
        response.extend_from_slice(sql.as_bytes());
        self.calls.lock().unwrap().push(response.clone());
        Ok(ProtocolResponse::new(response))
    }

    fn checkpoint(&mut self) -> Result<()> {
        self.count += 1;
        let mut response = vec![self.count, b'S'];
        response.extend_from_slice(b"CHECKPOINT");
        self.calls.lock().unwrap().push(response);
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum ScriptedTransactionFailure {
    Commit,
    Rollback,
}

struct ScriptedTransactionRuntime {
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    failure: ScriptedTransactionFailure,
}

impl NativeRuntime for ScriptedTransactionRuntime {
    fn open(&self, config: oliphaunt::OpenConfig) -> Result<Box<dyn EngineSession>> {
        Ok(Box::new(ScriptedTransactionSession {
            mode: config.mode,
            calls: Arc::clone(&self.calls),
            failure: self.failure,
        }))
    }
}

struct ScriptedTransactionSession {
    mode: EngineMode,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    failure: ScriptedTransactionFailure,
}

impl EngineSession for ScriptedTransactionSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::for_mode(self.mode)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let bytes = request.into_bytes();
        self.calls.lock().unwrap().push(bytes.clone());
        match self.failure {
            ScriptedTransactionFailure::Commit if raw_message_contains(&bytes, b"COMMIT") => {
                Err(Error::Engine("scripted COMMIT failure".to_owned()))
            }
            ScriptedTransactionFailure::Rollback if raw_message_contains(&bytes, b"ROLLBACK") => {
                Err(Error::Engine("scripted ROLLBACK failure".to_owned()))
            }
            _ => Ok(ProtocolResponse::new(bytes)),
        }
    }
}

#[derive(Default)]
struct BlockingState {
    inner: Mutex<BlockingStateInner>,
    condvar: Condvar,
}

#[derive(Default)]
struct BlockingStateInner {
    active: bool,
    released: bool,
    cancelled: bool,
    closed: bool,
    calls: Vec<Vec<u8>>,
}

impl BlockingState {
    fn wait_until_active(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut guard = self.inner.lock().unwrap();
        while !guard.active {
            let now = Instant::now();
            assert!(now < deadline, "blocking runtime did not become active");
            let timeout = deadline.saturating_duration_since(now);
            let (next_guard, _) = self.condvar.wait_timeout(guard, timeout).unwrap();
            guard = next_guard;
        }
    }

    fn was_closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    fn was_cancelled(&self) -> bool {
        self.inner.lock().unwrap().cancelled
    }

    fn calls(&self) -> Vec<Vec<u8>> {
        self.inner.lock().unwrap().calls.clone()
    }

    fn release(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard.released = true;
        self.condvar.notify_all();
    }
}

struct BlockingRuntime {
    state: Arc<BlockingState>,
}

impl NativeRuntime for BlockingRuntime {
    fn open(&self, config: oliphaunt::OpenConfig) -> Result<Box<dyn EngineSession>> {
        Ok(Box::new(BlockingSession {
            mode: config.mode,
            state: Arc::clone(&self.state),
        }))
    }
}

struct BlockingSession {
    mode: EngineMode,
    state: Arc<BlockingState>,
}

struct BlockingCancel {
    state: Arc<BlockingState>,
}

impl EngineCancel for BlockingCancel {
    fn cancel(&self) -> Result<()> {
        let mut guard = self.state.inner.lock().unwrap();
        guard.cancelled = true;
        self.state.condvar.notify_all();
        Ok(())
    }
}

impl EngineSession for BlockingSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::for_mode(self.mode)
    }

    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = Arc::new(BlockingCancel {
            state: Arc::clone(&self.state),
        });
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut guard = self.state.inner.lock().unwrap();
        guard.calls.push(request.as_bytes().to_vec());
        guard.active = true;
        self.state.condvar.notify_all();
        while !guard.cancelled && !guard.released {
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Engine(
                    "blocking runtime query was not released".to_owned(),
                ));
            }
            let timeout = deadline.saturating_duration_since(now);
            let (next_guard, _) = self.state.condvar.wait_timeout(guard, timeout).unwrap();
            guard = next_guard;
        }
        if guard.cancelled {
            Ok(ProtocolResponse::new(b"cancelled".to_vec()))
        } else {
            Ok(ProtocolResponse::new(b"finished".to_vec()))
        }
    }

    fn close(&mut self) -> Result<()> {
        let mut guard = self.state.inner.lock().unwrap();
        guard.closed = true;
        self.state.condvar.notify_all();
        Ok(())
    }
}

#[derive(Default)]
struct StreamingCancelState {
    inner: Mutex<StreamingCancelStateInner>,
    condvar: Condvar,
}

#[derive(Default)]
struct StreamingCancelStateInner {
    streaming: bool,
    cancelled: bool,
}

impl StreamingCancelState {
    fn wait_until_streaming(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut guard = self.inner.lock().unwrap();
        while !guard.streaming {
            let now = Instant::now();
            assert!(now < deadline, "streaming runtime did not become active");
            let timeout = deadline.saturating_duration_since(now);
            let (next_guard, _) = self.condvar.wait_timeout(guard, timeout).unwrap();
            guard = next_guard;
        }
    }

    fn was_stream_cancelled(&self) -> bool {
        self.inner.lock().unwrap().cancelled
    }
}

struct StreamingCancelRuntime {
    state: Arc<StreamingCancelState>,
    cancels: Arc<AtomicUsize>,
}

impl NativeRuntime for StreamingCancelRuntime {
    fn open(&self, config: oliphaunt::OpenConfig) -> Result<Box<dyn EngineSession>> {
        Ok(Box::new(StreamingCancelSession {
            mode: config.mode,
            state: Arc::clone(&self.state),
            cancels: Arc::clone(&self.cancels),
        }))
    }
}

struct StreamingCancelSession {
    mode: EngineMode,
    state: Arc<StreamingCancelState>,
    cancels: Arc<AtomicUsize>,
}

struct StreamingCancelHandle {
    state: Arc<StreamingCancelState>,
    cancels: Arc<AtomicUsize>,
}

impl EngineCancel for StreamingCancelHandle {
    fn cancel(&self) -> Result<()> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        let mut guard = self.state.inner.lock().unwrap();
        guard.cancelled = true;
        self.state.condvar.notify_all();
        Ok(())
    }
}

impl EngineSession for StreamingCancelSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::for_mode(self.mode)
    }

    fn cancel_handle(&self) -> Option<Arc<dyn EngineCancel>> {
        let cancel: Arc<dyn EngineCancel> = Arc::new(StreamingCancelHandle {
            state: Arc::clone(&self.state),
            cancels: Arc::clone(&self.cancels),
        });
        Some(cancel)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        if request.as_bytes() == [b'r'] {
            Ok(ProtocolResponse::new(
                b"recovered-after-stream-cancel".to_vec(),
            ))
        } else {
            Ok(ProtocolResponse::new(request.into_bytes()))
        }
    }

    fn exec_protocol_stream(
        &mut self,
        _request: ProtocolRequest,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let chunk = vec![b'x'; 128 * 1024];
        on_chunk(&chunk)?;

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut guard = self.state.inner.lock().unwrap();
        guard.streaming = true;
        self.state.condvar.notify_all();
        while !guard.cancelled {
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Engine(
                    "streaming runtime was not cancelled".to_owned(),
                ));
            }
            let timeout = deadline.saturating_duration_since(now);
            let (next_guard, _) = self.state.condvar.wait_timeout(guard, timeout).unwrap();
            guard = next_guard;
        }
        drop(guard);

        on_chunk(b"cancelled")?;
        Ok(())
    }
}

fn builder_for_mode(mode: EngineMode, path: impl Into<PathBuf>) -> oliphaunt::OliphauntBuilder {
    let builder = Oliphaunt::builder().path(path);
    match mode {
        EngineMode::NativeDirect => builder.native_direct(),
        EngineMode::NativeBroker => builder.native_broker(),
        EngineMode::NativeServer => builder.native_server(),
    }
}

fn open_scripted_transaction_db(
    mode: EngineMode,
    label: &str,
    failure: ScriptedTransactionFailure,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
) -> Oliphaunt {
    block_on(
        builder_for_mode(mode, format!("target/test-roots/{mode}-{label}"))
            .runtime(ScriptedTransactionRuntime { calls, failure })
            .open(),
    )
    .unwrap()
}

fn assert_commit_failure_rolls_back_and_releases(mode: EngineMode) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = open_scripted_transaction_db(
        mode,
        "commit-failure-transaction",
        ScriptedTransactionFailure::Commit,
        Arc::clone(&calls),
    );

    let tx = block_on(db.transaction()).unwrap();
    block_on(tx.execute("INSERT INTO commit_failure VALUES (1)")).unwrap();
    let error = block_on(tx.commit()).unwrap_err();
    assert!(
        error.to_string().contains("scripted COMMIT failure"),
        "{mode} returned unexpected commit failure: {error}"
    );
    block_on(db.execute("SELECT after failed commit")).unwrap();

    let calls = calls.lock().unwrap();
    assert_call_order(
        &calls,
        &[
            b"BEGIN".as_slice(),
            b"INSERT INTO commit_failure VALUES (1)",
            b"COMMIT",
            b"ROLLBACK",
            b"SELECT after failed commit",
        ],
        &format!("{mode} commit failure cleanup"),
    );
}

fn assert_rollback_failure_releases(mode: EngineMode) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = open_scripted_transaction_db(
        mode,
        "rollback-failure-transaction",
        ScriptedTransactionFailure::Rollback,
        Arc::clone(&calls),
    );

    let tx = block_on(db.transaction()).unwrap();
    block_on(tx.execute("INSERT INTO rollback_failure VALUES (1)")).unwrap();
    let error = block_on(tx.rollback()).unwrap_err();
    assert!(
        error.to_string().contains("scripted ROLLBACK failure"),
        "{mode} returned unexpected rollback failure: {error}"
    );
    block_on(db.execute("SELECT after failed rollback")).unwrap();

    let calls = calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .filter(|call| raw_message_contains(call, b"ROLLBACK"))
            .count()
            >= 2,
        "{mode} failed rollback did not trigger best-effort cleanup rollback: {calls:?}"
    );
    assert!(
        raw_message_contains(calls.last().unwrap(), b"SELECT after failed rollback"),
        "{mode} session was not released after rollback failure: {calls:?}"
    );
}

fn assert_body_failure_preserves_error_when_rollback_fails(mode: EngineMode) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = open_scripted_transaction_db(
        mode,
        "body-and-rollback-failure-transaction",
        ScriptedTransactionFailure::Rollback,
        Arc::clone(&calls),
    );

    let error = block_on(db.with_transaction(async |tx| {
        tx.execute("INSERT INTO body_failure VALUES (1)").await?;
        Err::<(), Error>(Error::Engine("body failed".to_owned()))
    }))
    .unwrap_err();
    assert_eq!(error, Error::Engine("body failed".to_owned()));
    block_on(db.execute("SELECT after body failure")).unwrap();

    let calls = calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .any(|call| raw_message_contains(call, b"ROLLBACK")),
        "{mode} body failure did not attempt rollback: {calls:?}"
    );
    assert!(
        raw_message_contains(calls.last().unwrap(), b"SELECT after body failure"),
        "{mode} session was not released after body and rollback failure: {calls:?}"
    );
}

fn assert_call_order(calls: &[Vec<u8>], needles: &[&[u8]], context: &str) {
    let mut next_index = 0;
    for needle in needles {
        let Some(relative_index) = calls[next_index..]
            .iter()
            .position(|call| raw_message_contains(call, needle))
        else {
            panic!(
                "{context} did not find call containing {} after index {next_index}: {calls:?}",
                String::from_utf8_lossy(needle)
            );
        };
        next_index += relative_index + 1;
    }
}

fn unique_temp_root(prefix: &str) -> PathBuf {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    for attempt in 0..100_u32 {
        let path = parent.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
        if !path.exists() {
            return path;
        }
    }
    panic!("failed to allocate a unique temp root for {prefix}");
}

fn minimal_physical_archive() -> oliphaunt::BackupArtifact {
    let mut bytes = Vec::new();
    {
        let mut archive = tar::Builder::new(&mut bytes);
        append_test_archive_file(&mut archive, "pgdata/PG_VERSION", b"18\n");
        append_test_archive_file(&mut archive, "pgdata/global/pg_control", b"control");
        append_test_archive_file(&mut archive, "pgdata/backup_label", b"label");
        archive.finish().unwrap();
    }
    oliphaunt::BackupArtifact {
        format: BackupFormat::PhysicalArchive,
        bytes,
    }
}

fn append_test_archive_file(
    archive: &mut tar::Builder<&mut Vec<u8>>,
    path: &str,
    bytes: &'static [u8],
) {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive
        .append_data(&mut header, path, Cursor::new(bytes))
        .unwrap();
}

fn raw_message_contains(bytes: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && bytes.windows(needle.len()).any(|window| window == needle)
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);

    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}

fn block_on_pinned<F: Future>(mut future: std::pin::Pin<Box<F>>) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut context = Context::from_waker(&waker);

    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_millis(1)),
        }
    }
}

fn poll_once_pending<F: Future>(future: &mut std::pin::Pin<Box<F>>) {
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut context = Context::from_waker(&waker);
    if future.as_mut().poll(&mut context).is_ready() {
        panic!("future completed before the owner executor became available");
    }
}

struct ThreadWaker(thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
