#![cfg(feature = "extensions")]

use pglite_oxide::{
    DataDirArchiveFormat, ExecProtocolOptions, Pglite, PgliteError, PgliteServer, QueryOptions,
    QueryTemplate, RowMode, format_query, quote_identifier,
};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

mod support;
use support::{ChildGuard, TestTrace, trace_step};

fn first_row(result: &pglite_oxide::Results) -> anyhow::Result<&serde_json::Map<String, Value>> {
    result
        .rows
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("expected first row object"))
}

fn assert_file_missing_or_without(path: &std::path::Path, needle: &str) -> anyhow::Result<()> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            assert!(
                !contents.contains(needle),
                "{} still contained stale marker {needle:?}: {contents:?}",
                path.display()
            );
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

fn raw_query_message(sql: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(sql.as_bytes());
    body.push(0);
    raw_tagged_message(b'Q', &body)
}

fn raw_tagged_message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(body.len() + 5);
    packet.push(tag);
    packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(body);
    packet
}

fn raw_message_tags(mut bytes: &[u8]) -> Vec<u8> {
    let mut tags = Vec::new();
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if len < 4 {
            break;
        }
        let total = 1 + len as usize;
        if bytes.len() < total {
            break;
        }
        tags.push(tag);
        bytes = &bytes[total..];
    }
    tags
}

fn raw_message_tags_ignoring_parameter_status(bytes: &[u8]) -> Vec<u8> {
    raw_message_tags(bytes)
        .into_iter()
        .filter(|tag| *tag != b'S')
        .collect()
}

fn raw_backend_message_name(message: &pglite_oxide::BackendMessage) -> &'static str {
    match message {
        pglite_oxide::BackendMessage::RowDescription(_) => "rowDescription",
        pglite_oxide::BackendMessage::DataRow(_) => "dataRow",
        pglite_oxide::BackendMessage::CommandComplete(_) => "commandComplete",
        pglite_oxide::BackendMessage::ReadyForQuery(_) => "readyForQuery",
        pglite_oxide::BackendMessage::Error(_) => "error",
        pglite_oxide::BackendMessage::ParseComplete { .. } => "parseComplete",
        pglite_oxide::BackendMessage::BindComplete { .. } => "bindComplete",
        _ => "other",
    }
}

fn assert_core_runtime_assets_stay_in_lower_mount(root: &std::path::Path) {
    let runtime = root.join("tmp/pglite");
    assert!(
        runtime.join(".pglite-oxide-mountfs-runtime").is_file(),
        "expected shared runtime overlay marker under {}",
        runtime.display()
    );
    assert!(
        !runtime.join("bin").exists(),
        "core binaries should be served from the lower cached runtime, not linked into {}",
        runtime.display()
    );
    assert!(
        !runtime.join("lib").exists(),
        "core runtime libraries should stay in the lower cached runtime"
    );
    assert!(
        !runtime.join("share").exists(),
        "core catalog, timezone, and extension metadata should stay in the lower cached runtime"
    );
}

#[test]
fn template_cache_false_runs_split_initdb() -> anyhow::Result<()> {
    let mut db = Pglite::builder().temporary().template_cache(false).open()?;
    let result = db.query("SELECT 1 AS value", &[], None)?;
    assert_eq!(first_row(&result)?["value"], json!(1));
    Ok(())
}

#[test]
fn gen_random_uuid_returns_fresh_values_across_queries() -> anyhow::Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    let mut ids = Vec::new();

    for _ in 0..4 {
        let result = db.query("SELECT gen_random_uuid()::text AS id", &[], None)?;
        ids.push(
            first_row(&result)?["id"]
                .as_str()
                .expect("uuid text result")
                .to_owned(),
        );
    }

    let unique = ids.iter().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        unique.len(),
        ids.len(),
        "expected gen_random_uuid() to produce unique values across queries, got {ids:?}"
    );
    Ok(())
}

#[test]
fn direct_transaction_commit_rollback_and_error_recovery() -> anyhow::Result<()> {
    let mut pg = Pglite::builder().temporary().open()?;
    pg.exec(
        "CREATE TABLE direct_tx_items(id int PRIMARY KEY, value text)",
        None,
    )?;

    let committed = pg.transaction(|tx| {
        let inserted = tx.query(
            "INSERT INTO direct_tx_items(id, value) VALUES ($1, $2) RETURNING value",
            &[json!(1), json!("committed")],
            None,
        )?;
        assert_eq!(
            first_row(&inserted)?.get("value"),
            Some(&json!("committed"))
        );
        Ok::<_, anyhow::Error>("commit-result")
    })?;
    assert_eq!(committed, "commit-result");

    let rollback: anyhow::Result<()> = pg.transaction(|tx| {
        tx.query(
            "INSERT INTO direct_tx_items(id, value) VALUES ($1, $2)",
            &[json!(2), json!("rolled back")],
            None,
        )?;
        Err(anyhow::anyhow!("force rollback"))
    });
    assert!(rollback.is_err());

    let failed: anyhow::Result<()> = pg.transaction(|tx| {
        tx.query(
            "INSERT INTO direct_tx_items(id, value) VALUES ($1, $2)",
            &[json!(3), json!("before failure")],
            None,
        )?;
        tx.query("SELECT 10 / $1::int4 AS impossible", &[json!(0)], None)?;
        Ok(())
    });
    let failed = failed.expect_err("transaction should return the SQL failure");
    let pg_err = failed
        .downcast_ref::<PgliteError>()
        .expect("transaction SQL error should preserve Postgres fields");
    assert_eq!(pg_err.database_error().code.as_deref(), Some("22012"));

    let count = pg.query(
        "SELECT count(*)::int AS count, string_agg(value, ',' ORDER BY id) AS values \
         FROM direct_tx_items",
        &[],
        None,
    )?;
    assert_eq!(first_row(&count)?.get("count"), Some(&json!(1)));
    assert_eq!(first_row(&count)?.get("values"), Some(&json!("committed")));

    let recovered = pg.query("SELECT 42::int AS recovered_after_tx_error", &[], None)?;
    assert_eq!(
        first_row(&recovered)?.get("recovered_after_tx_error"),
        Some(&json!(42))
    );

    pg.close()?;
    Ok(())
}

#[test]
fn direct_startup_postgres_config_uses_real_guc_handling() -> anyhow::Result<()> {
    let mut pg = Pglite::builder()
        .temporary()
        .postgres_config("synchronous_commit", "off")
        .postgres_config("work_mem", "8MB")
        .open()?;

    let result = pg.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit, \
                current_setting('work_mem') AS work_mem",
        &[],
        None,
    )?;
    let row = first_row(&result)?;
    assert_eq!(row.get("sync_commit"), Some(&json!("off")));
    assert_eq!(row.get("work_mem"), Some(&json!("8MB")));

    pg.exec("BEGIN", None)?;
    pg.exec("SET LOCAL synchronous_commit = on", None)?;
    let local = pg.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&local)?.get("sync_commit"),
        Some(&json!("on")),
        "SET LOCAL should still be handled by PostgreSQL itself"
    );
    pg.exec("COMMIT", None)?;

    let after_commit = pg.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&after_commit)?.get("sync_commit"),
        Some(&json!("off")),
        "startup GUC should remain the session default after SET LOCAL scope ends"
    );

    Ok(())
}

#[test]
fn invalid_postgres_config_is_rejected_before_backend_startup() -> anyhow::Result<()> {
    let err = match Pglite::builder()
        .temporary()
        .postgres_config("bad=name", "off")
        .open()
    {
        Ok(_) => anyhow::bail!("invalid startup config name should fail before opening"),
        Err(err) => err,
    };
    assert!(
        format!("{err:#}").contains("Postgres config name"),
        "unexpected error: {err:#}"
    );
    Ok(())
}

#[test]
fn direct_startup_identity_can_select_existing_user_and_database() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Pglite::builder().path(root.path()).open()?;
        db.exec("CREATE ROLE test_user LOGIN", None)?;
        db.exec("CREATE DATABASE test_db OWNER test_user", None)?;
        db.close()?;
    }

    let mut db = Pglite::builder()
        .path(root.path())
        .username("test_user")
        .database("test_db")
        .open()?;
    let result = db.query(
        "SELECT current_user, current_database(), current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    let row = first_row(&result)?;
    assert_eq!(row.get("current_user"), Some(&json!("test_user")));
    assert_eq!(row.get("current_database"), Some(&json!("test_db")));
    db.close()?;
    Ok(())
}

#[test]
fn relaxed_durability_uses_postgres_guc() -> anyhow::Result<()> {
    let mut db = Pglite::builder()
        .temporary()
        .relaxed_durability(true)
        .open()?;
    let result = db.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    assert_eq!(first_row(&result)?.get("sync_commit"), Some(&json!("off")));
    db.close()?;
    Ok(())
}

#[test]
fn relaxed_durability_is_idempotent_and_user_config_wins() -> anyhow::Result<()> {
    let mut disabled = Pglite::builder()
        .temporary()
        .relaxed_durability(true)
        .relaxed_durability(false)
        .open()?;
    let result = disabled.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    assert_eq!(first_row(&result)?.get("sync_commit"), Some(&json!("on")));
    disabled.close()?;

    let mut overridden = Pglite::builder()
        .temporary()
        .relaxed_durability(true)
        .postgres_config("synchronous_commit", "on")
        .open()?;
    let result = overridden.query(
        "SELECT current_setting('synchronous_commit') AS sync_commit",
        &[],
        None,
    )?;
    assert_eq!(first_row(&result)?.get("sync_commit"), Some(&json!("on")));
    overridden.close()?;
    Ok(())
}

#[test]
fn startup_args_are_passed_to_postgres() -> anyhow::Result<()> {
    let mut db = Pglite::builder()
        .temporary()
        .startup_args(["-c", "application_name=pglite-oxide-test"])
        .open()?;
    let result = db.query(
        "SELECT current_setting('application_name') AS app",
        &[],
        None,
    )?;
    assert_eq!(
        first_row(&result)?.get("app"),
        Some(&json!("pglite-oxide-test"))
    );
    db.close()?;
    Ok(())
}

#[test]
fn data_dir_dump_load_and_clone_round_trip() -> anyhow::Result<()> {
    let mut source = Pglite::builder().temporary().open()?;
    source.exec(
        "CREATE TABLE data_dir_items(id serial PRIMARY KEY, value text);
         INSERT INTO data_dir_items(value) VALUES ('alpha'), ('beta');",
        None,
    )?;

    let expected = source.query(
        "SELECT id, value FROM data_dir_items ORDER BY id",
        &[],
        None,
    )?;
    let archive = source.dump_data_dir_with_format(DataDirArchiveFormat::Tar)?;

    let mut loaded = Pglite::builder()
        .temporary()
        .load_data_dir_archive(archive)
        .open()?;
    let loaded_rows = loaded.query(
        "SELECT id, value FROM data_dir_items ORDER BY id",
        &[],
        None,
    )?;
    assert_eq!(loaded_rows.rows, expected.rows);

    let mut cloned = source.try_clone()?;
    cloned.exec(
        "INSERT INTO data_dir_items(value) VALUES ('clone-only')",
        None,
    )?;
    let source_count = source.query(
        "SELECT count(*)::int AS count FROM data_dir_items",
        &[],
        None,
    )?;
    let clone_count = cloned.query(
        "SELECT count(*)::int AS count FROM data_dir_items",
        &[],
        None,
    )?;
    assert_eq!(first_row(&source_count)?.get("count"), Some(&json!(2)));
    assert_eq!(first_row(&clone_count)?.get("count"), Some(&json!(3)));

    cloned.close()?;
    loaded.close()?;
    source.close()?;
    Ok(())
}

#[test]
fn direct_raw_protocol_api_matches_pglite_exec_protocol_cases() -> anyhow::Result<()> {
    let mut db = Pglite::builder().temporary().open()?;

    let simple = db.exec_protocol(
        &raw_query_message("SELECT 1"),
        ExecProtocolOptions::default(),
    )?;
    assert_eq!(
        raw_message_tags_ignoring_parameter_status(&simple.data),
        vec![b'T', b'D', b'C', b'Z']
    );
    assert_eq!(
        simple
            .messages
            .iter()
            .filter(|message| {
                !matches!(message, pglite_oxide::BackendMessage::ParameterStatus(_))
            })
            .map(raw_backend_message_name)
            .collect::<Vec<_>>(),
        vec![
            "rowDescription",
            "dataRow",
            "commandComplete",
            "readyForQuery"
        ]
    );

    let no_throw = db.exec_protocol(
        &raw_query_message("invalid sql"),
        ExecProtocolOptions {
            throw_on_error: false,
            ..ExecProtocolOptions::default()
        },
    )?;
    assert_eq!(
        raw_message_tags_ignoring_parameter_status(&no_throw.data),
        vec![b'E', b'Z']
    );

    let err = db
        .exec_protocol(
            &raw_query_message("invalid sql"),
            ExecProtocolOptions::default(),
        )
        .expect_err("throw_on_error should return the Postgres error");
    assert!(
        err.downcast_ref::<pglite_oxide::DatabaseError>().is_some(),
        "unexpected raw protocol error: {err:#}"
    );

    let mut streamed = Vec::new();
    db.exec_protocol_raw_stream(
        &raw_query_message("SELECT 2"),
        ExecProtocolOptions::default(),
        |chunk| {
            streamed.extend_from_slice(chunk);
            Ok(())
        },
    )?;
    assert_eq!(
        raw_message_tags_ignoring_parameter_status(&streamed),
        vec![b'T', b'D', b'C', b'Z']
    );

    let mut pipelined = raw_query_message("SELECT 3");
    pipelined.extend_from_slice(&raw_query_message("SELECT 4"));
    let mut chunks = Vec::new();
    db.exec_protocol_raw_stream(&pipelined, ExecProtocolOptions::default(), |chunk| {
        chunks.push(raw_message_tags_ignoring_parameter_status(chunk));
        Ok(())
    })?;
    assert_eq!(
        chunks,
        vec![vec![b'T', b'D', b'C', b'Z'], vec![b'T', b'D', b'C', b'Z']]
    );

    db.close()?;
    Ok(())
}

#[cfg(debug_assertions)]
#[test]
fn direct_protocol_bridge_guest_allocations_are_freed() -> anyhow::Result<()> {
    let mut db = Pglite::builder().temporary().open()?;
    let (allocations_before, frees_before) = db.guest_bridge_allocation_counts();
    assert_eq!(
        allocations_before, frees_before,
        "bridge allocations must be balanced before stress loop"
    );

    for _ in 0..128 {
        let mut output = Vec::new();
        db.exec_protocol_raw_stream(
            &raw_query_message("SELECT repeat('x', 4096)"),
            ExecProtocolOptions::default(),
            |chunk| {
                output.extend_from_slice(chunk);
                Ok(())
            },
        )?;
        assert_eq!(
            raw_message_tags_ignoring_parameter_status(&output),
            vec![b'T', b'D', b'C', b'Z']
        );
    }

    let (allocations_after, frees_after) = db.guest_bridge_allocation_counts();
    assert_eq!(
        allocations_after, frees_after,
        "each Rust-owned guest bridge allocation must be freed"
    );
    assert!(
        allocations_after > allocations_before,
        "stress loop should exercise bridge allocations"
    );

    db.close()?;
    Ok(())
}

#[test]
fn pure_mountfs_serves_core_runtime_assets_from_lower_cache() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    {
        let mut pg = Pglite::builder().path(root.path()).open()?;
        let result = pg.query(
            "SELECT count(*)::int AS utc_zones \
             FROM pg_timezone_names \
             WHERE name = 'UTC'",
            &[],
            None,
        )?;
        assert_eq!(first_row(&result)?.get("utc_zones"), Some(&json!(1)));
        pg.close()?;
    }

    assert_core_runtime_assets_stay_in_lower_mount(root.path());
    Ok(())
}

#[test]
fn server_drop_without_explicit_shutdown_releases_root() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    {
        let server = PgliteServer::builder().path(root.path()).start()?;
        assert!(server.tcp_addr().is_some());
    }

    let mut db = Pglite::builder().path(root.path()).open()?;
    let result = db.query("SELECT 1 AS value", &[], None)?;
    assert_eq!(first_row(&result)?.get("value"), Some(&json!(1)));
    db.close()?;
    Ok(())
}

#[test]
fn persistent_template_survives_restart_and_stale_state_files() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    {
        let mut pg = Pglite::builder().path(root.path()).open()?;
        pg.exec("CREATE TABLE template_restart(value TEXT)", None)?;
        pg.query(
            "INSERT INTO template_restart(value) VALUES ($1)",
            &[json!("boot-single-ok")],
            None,
        )?;
        pg.close()?;
    }

    let pgdata = root.path().join("tmp/pglite/base");
    std::fs::write(
        pgdata.join("postmaster.pid"),
        b"stale pid from interrupted run",
    )?;
    std::fs::write(
        pgdata.join("postmaster.opts"),
        b"stale opts from interrupted run",
    )?;

    let mut reopened = Pglite::builder().path(root.path()).open()?;
    let result = reopened.query("SELECT value FROM template_restart", &[], None)?;
    assert_eq!(
        first_row(&result)?.get("value"),
        Some(&json!("boot-single-ok"))
    );
    assert_file_missing_or_without(&pgdata.join("postmaster.pid"), "stale pid")?;
    assert_file_missing_or_without(&pgdata.join("postmaster.opts"), "stale opts")?;
    reopened.close()?;
    Ok(())
}

#[test]
fn persistent_template_recovers_interrupted_pgdata_without_marker() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let pgdata = root.path().join("tmp/pglite/base");
    std::fs::create_dir_all(&pgdata)?;
    std::fs::write(pgdata.join("postmaster.pid"), b"interrupted pid")?;
    std::fs::write(pgdata.join("partial-bootstrap.sql"), b"interrupted initdb")?;

    let mut pg = Pglite::builder().path(root.path()).open()?;
    let result = pg.query("SELECT 1::int AS one", &[], None)?;
    assert_eq!(first_row(&result)?.get("one"), Some(&json!(1)));
    assert!(pgdata.join("PG_VERSION").exists());
    assert!(!pgdata.join("partial-bootstrap.sql").exists());
    assert_file_missing_or_without(&pgdata.join("postmaster.pid"), "interrupted pid")?;
    pg.close()?;
    Ok(())
}

#[test]
fn persistent_template_recovers_interrupted_pgdata_with_incomplete_markers() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let pgdata = root.path().join("tmp/pglite/base");
    std::fs::create_dir_all(&pgdata)?;
    std::fs::write(pgdata.join("PG_VERSION"), b"17\n")?;
    std::fs::write(pgdata.join("partial-bootstrap.sql"), b"interrupted initdb")?;

    let mut pg = Pglite::builder().path(root.path()).open()?;
    let result = pg.query("SELECT 2::int AS two", &[], None)?;
    assert_eq!(first_row(&result)?.get("two"), Some(&json!(2)));
    assert!(pgdata.join("PG_VERSION").exists());
    assert!(pgdata.join("global/pg_control").exists());
    assert!(!pgdata.join("partial-bootstrap.sql").exists());
    pg.close()?;
    Ok(())
}

#[test]
fn persistent_root_lock_rejects_second_direct_open() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let mut first = Pglite::builder().path(root.path()).open()?;
    let err = match Pglite::builder().path(root.path()).open() {
        Ok(_) => anyhow::bail!("second open must fail while the root lock is held"),
        Err(err) => err,
    };
    assert!(format!("{err:#}").contains("PGlite root is already in use"));

    first.close()?;

    let mut reopened = Pglite::builder().path(root.path()).open()?;
    let result = reopened.query("SELECT 1::int AS one", &[], None)?;
    assert_eq!(first_row(&result)?.get("one"), Some(&json!(1)));
    reopened.close()?;
    Ok(())
}

#[test]
fn persistent_root_lock_rejects_second_server_open() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let server = PgliteServer::builder().path(root.path()).start()?;
    let err = match PgliteServer::builder().path(root.path()).start() {
        Ok(_) => anyhow::bail!("second server must fail while the root lock is held"),
        Err(err) => err,
    };
    assert!(format!("{err:#}").contains("PGlite root is already in use"));
    server.shutdown()?;
    Ok(())
}

#[test]
fn persistent_root_lock_rejects_direct_open_while_server_runs() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let server = PgliteServer::builder().path(root.path()).start()?;
    let err = match Pglite::builder().path(root.path()).open() {
        Ok(_) => anyhow::bail!("direct open must fail while the server owns the root lock"),
        Err(err) => err,
    };
    assert!(format!("{err:#}").contains("PGlite root is already in use"));
    server.shutdown()?;

    let mut reopened = Pglite::builder().path(root.path()).open()?;
    let result = reopened.query("SELECT 1::int AS one", &[], None)?;
    assert_eq!(first_row(&result)?.get("one"), Some(&json!(1)));
    reopened.close()?;
    Ok(())
}

#[test]
fn persistent_root_lock_rejects_cross_process_open() -> anyhow::Result<()> {
    let root = tempfile::TempDir::new()?;
    let child = Command::new(env!("CARGO_BIN_EXE_pglite-proxy"))
        .arg("--root")
        .arg(root.path())
        .args(["--tcp", "127.0.0.1:0", "--print-uri"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut child = ChildGuard::new(child, "pglite-proxy")?;

    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("missing pglite-proxy stdout"))?;
    let mut line = String::new();
    let read = BufReader::new(stdout).read_line(&mut line)?;
    if read == 0 {
        let stderr = child.collect_stderr();
        anyhow::bail!("pglite-proxy exited before printing URI\n\nstderr:\n{stderr}");
    }
    assert!(line.starts_with("postgresql://"), "{line:?}");

    let err = match Pglite::builder().path(root.path()).open() {
        Ok(mut db) => {
            let close = db.close();
            let stderr = child.collect_stderr();
            anyhow::bail!(
                "direct open unexpectedly succeeded while another process owns the root lock; close={close:?}\n\nstderr:\n{stderr}"
            );
        }
        Err(err) => err,
    };
    let message = format!("{err:#}");
    if !message.contains("PGlite root is already in use") {
        let stderr = child.collect_stderr();
        anyhow::bail!("unexpected cross-process root-lock error: {message}\n\nstderr:\n{stderr}");
    }
    Ok(())
}

#[test]
fn runtime_smoke() -> anyhow::Result<()> {
    let _trace = TestTrace::new("runtime_smoke");
    let mut pg = Pglite::builder().temporary().open()?;
    assert!(pg.paths().pgdata.join("PG_VERSION").exists());

    let version = pg.query(
        "SELECT current_setting('server_version_num')::int AS version_num",
        &[],
        None,
    )?;
    let version_num = first_row(&version)?
        .get("version_num")
        .and_then(Value::as_i64)
        .expect("version_num");
    assert!(
        version_num >= 170_000,
        "expected PostgreSQL 17+, got {version_num}"
    );

    let identity = pg.query(
        "SELECT current_user AS current_user, \
                session_user AS session_user, \
                current_database() AS database_name, \
                current_setting('TimeZone') AS timezone, \
                current_setting('search_path') AS search_path",
        &[],
        None,
    )?;
    let identity_row = first_row(&identity)?;
    assert_eq!(identity_row.get("current_user"), Some(&json!("postgres")));
    assert_eq!(identity_row.get("session_user"), Some(&json!("postgres")));
    assert_eq!(identity_row.get("database_name"), Some(&json!("template1")));
    assert_eq!(identity_row.get("timezone"), Some(&json!("UTC")));
    assert_eq!(identity_row.get("search_path"), Some(&json!("public")));

    pg.exec("SET TIME ZONE 'UTC'", None)?;
    let timezone_catalog = pg.query(
        "SELECT count(*)::int AS ny_zones, \
                EXTRACT(HOUR FROM TIMESTAMPTZ '2024-07-01 12:00:00+00' \
                    AT TIME ZONE 'America/New_York')::int AS ny_summer_hour, \
                EXTRACT(HOUR FROM TIMESTAMPTZ '2024-01-01 12:00:00+00' \
                    AT TIME ZONE 'America/New_York')::int AS ny_winter_hour \
         FROM pg_timezone_names \
         WHERE name = 'America/New_York'",
        &[],
        None,
    )?;
    let timezone_row = first_row(&timezone_catalog)?;
    assert_eq!(timezone_row.get("ny_zones"), Some(&json!(1)));
    assert_eq!(timezone_row.get("ny_summer_hour"), Some(&json!(8)));
    assert_eq!(timezone_row.get("ny_winter_hour"), Some(&json!(7)));

    trace_step("runtime_smoke expected-error invalid-timezone");
    pg.exec("SET TIME ZONE 'Missing/Zone'", None)
        .expect_err("invalid timezone should fail");
    let after_timezone_error = pg.query("SELECT 25::int AS recovered", &[], None)?;
    assert_eq!(
        first_row(&after_timezone_error)?.get("recovered"),
        Some(&json!(25))
    );
    pg.exec("SET TIME ZONE 'UTC'", None)?;

    pg.exec("CREATE TABLE items(value TEXT)", None)?;

    // COPY FROM '/dev/blob'
    let mut options = QueryOptions::default();
    let rows = b"alpha\nbeta\n";
    options.blob = Some(rows.to_vec());
    pg.exec("COPY items(value) FROM '/dev/blob'", Some(&options))?;

    // COPY TO '/dev/blob' and verify blob contents
    let results = pg.exec("COPY items TO '/dev/blob'", None)?;
    let blob = results
        .last()
        .and_then(|res| res.blob.as_ref())
        .expect("expected blob data from COPY TO");
    assert_eq!(std::str::from_utf8(blob)?.trim_end(), "alpha\nbeta");

    // Listen for notifications
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);
    let handle = pg.listen("test_channel", move |payload| {
        events_clone
            .lock()
            .expect("lock poisoning")
            .push(payload.to_string());
    })?;

    pg.exec("SELECT pg_notify('test_channel', 'hello world')", None)?;

    let recorded = events.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0], "hello world");
    drop(recorded);

    pg.unlisten(handle)?;

    let quoted_events = Arc::new(Mutex::new(Vec::new()));
    let quoted_events_clone = Arc::clone(&quoted_events);
    let quoted_channel = "Case Sensitive \"Channel\"";
    let quoted_handle = pg.listen(quoted_channel, move |payload| {
        quoted_events_clone
            .lock()
            .expect("lock poisoning")
            .push(payload.to_string());
    })?;
    pg.exec(
        "NOTIFY \"Case Sensitive \"\"Channel\"\"\", 'quoted listener'",
        None,
    )?;
    let recorded = quoted_events.lock().unwrap();
    assert_eq!(recorded.as_slice(), ["quoted listener"]);
    drop(recorded);
    pg.unlisten(quoted_handle)?;
    pg.unlisten_channel(quoted_channel)?;

    let formatted = format_query(&mut pg, "SELECT $1::int", &[json!(42)])?;
    assert_eq!(formatted, "SELECT '42'::int");

    let mut tpl = QueryTemplate::new();
    tpl.push_sql("SELECT ");
    tpl.push_identifier("items");
    tpl.push_sql(" WHERE value = ");
    tpl.push_param(json!("alpha"));
    let templated = tpl.build();
    assert_eq!(templated.query, "SELECT \"items\" WHERE value = $1");
    assert_eq!(templated.params[0], json!("alpha"));

    assert_eq!(quote_identifier("Test"), "\"Test\"");

    let typed_sql = "SELECT \
            ($1::int + 1) AS next_int, \
            $2::bool AS flag, \
            $3::jsonb AS doc, \
            $4::text[] AS labels, \
            $5::bytea AS bytes";
    let typed = pg.query(
        typed_sql,
        &[
            json!(41),
            json!(true),
            json!({"name": "pglite", "ok": true}),
            json!(["alpha", "beta,gamma"]),
            json!([0, 1, 2, 255]),
        ],
        None,
    )?;
    let typed_row = first_row(&typed)?;
    assert_eq!(typed_row.get("next_int"), Some(&json!(42)));
    assert_eq!(typed_row.get("flag"), Some(&json!(true)));
    assert_eq!(
        typed_row.get("doc").and_then(|value| value.get("name")),
        Some(&json!("pglite"))
    );
    assert_eq!(
        typed_row.get("labels"),
        Some(&json!(["alpha", "beta,gamma"]))
    );
    assert_eq!(typed_row.get("bytes"), Some(&json!([0, 1, 2, 255])));

    let array_options = QueryOptions {
        row_mode: Some(RowMode::Array),
        ..QueryOptions::default()
    };
    let array_result = pg.query(
        "SELECT 1::int AS one, 'two'::text AS two",
        &[],
        Some(&array_options),
    )?;
    assert_eq!(array_result.rows.first(), Some(&json!([1, "two"])));

    pg.exec(
        "CREATE TYPE mood AS ENUM ('sad', 'happy'); \
         CREATE TABLE mood_items(moods mood[])",
        None,
    )?;
    let mood_result = pg.query(
        "INSERT INTO mood_items(moods) VALUES ($1) RETURNING moods",
        &[json!(["sad", "happy"])],
        None,
    )?;
    assert_eq!(
        first_row(&mood_result)?.get("moods"),
        Some(&json!(["sad", "happy"]))
    );

    pg.exec(
        "CREATE TYPE weather AS ENUM ('rain', 'sun'); \
         CREATE TABLE weather_items(values weather[])",
        None,
    )?;
    pg.refresh_array_types()?;
    let weather_result = pg.query(
        "INSERT INTO weather_items(values) VALUES ($1) RETURNING values",
        &[json!(["rain", "sun"])],
        None,
    )?;
    assert_eq!(
        first_row(&weather_result)?.get("values"),
        Some(&json!(["rain", "sun"]))
    );

    pg.exec("CREATE TABLE tx_items(value TEXT)", None)?;
    pg.transaction(|tx| {
        tx.query(
            "INSERT INTO tx_items(value) VALUES ($1) RETURNING value",
            &[json!("committed")],
            None,
        )?;
        Ok(())
    })?;
    let rollback: anyhow::Result<()> = pg.transaction(|tx| {
        tx.exec("INSERT INTO tx_items(value) VALUES ('rolled back')", None)?;
        Err(anyhow::anyhow!("force rollback"))
    });
    assert!(rollback.is_err());
    let count = pg.query("SELECT count(*)::int AS count FROM tx_items", &[], None)?;
    assert_eq!(first_row(&count)?.get("count"), Some(&json!(1)));

    trace_step("runtime_smoke expected-error syntax");
    let syntax_err = pg
        .exec("SELECT +", None)
        .expect_err("syntax error should fail");
    let syntax_pg_err = syntax_err
        .downcast_ref::<PgliteError>()
        .expect("syntax error should preserve Postgres error fields");
    assert_eq!(syntax_pg_err.query(), "SELECT +");
    assert_eq!(
        syntax_pg_err.database_error().code.as_deref(),
        Some("42601")
    );

    trace_step("runtime_smoke expected-error missing-table");
    let missing_err = pg
        .query(
            "SELECT * FROM missing_table WHERE id = $1",
            &[json!(7)],
            None,
        )
        .expect_err("missing table should fail");
    let missing_pg_err = missing_err
        .downcast_ref::<PgliteError>()
        .expect("extended query error should preserve Postgres error fields");
    assert_eq!(
        missing_pg_err.query(),
        "SELECT * FROM missing_table WHERE id = $1"
    );
    assert_eq!(missing_pg_err.params(), &[json!(7)]);
    assert_eq!(
        missing_pg_err.database_error().code.as_deref(),
        Some("42P01")
    );

    trace_step("runtime_smoke expected-error invalid-bind");
    let invalid_bind = pg
        .query("SELECT $1::int4 AS value", &[json!("not_an_int")], None)
        .expect_err("invalid typed parameter should fail during extended-query bind");
    let invalid_bind_pg_err = invalid_bind
        .downcast_ref::<PgliteError>()
        .expect("bind error should preserve Postgres error fields");
    assert_eq!(invalid_bind_pg_err.query(), "SELECT $1::int4 AS value");
    assert_eq!(invalid_bind_pg_err.params(), &[json!("not_an_int")]);
    assert_eq!(
        invalid_bind_pg_err.database_error().code.as_deref(),
        Some("22P02")
    );

    trace_step("runtime_smoke expected-error wrong-param-count");
    let wrong_param_count = pg
        .query("SELECT $1::int4 + $2::int4 AS value", &[json!(1)], None)
        .expect_err("missing parameter should fail during extended-query bind");
    let wrong_param_count_pg_err = wrong_param_count
        .downcast_ref::<PgliteError>()
        .expect("parameter count error should preserve Postgres error fields");
    assert_eq!(
        wrong_param_count_pg_err.database_error().code.as_deref(),
        Some("08P01")
    );

    let after_error = pg.query("SELECT 99::int AS recovered", &[], None)?;
    assert_eq!(first_row(&after_error)?.get("recovered"), Some(&json!(99)));

    pg.close()?;
    assert!(pg.is_closed());

    let mut restarted = Pglite::temporary()?;
    let restarted_result = restarted.query("SELECT 42::int AS answer", &[], None)?;
    assert_eq!(
        first_row(&restarted_result)?.get("answer"),
        Some(&json!(42))
    );
    restarted.close()?;

    let persistent_dir = tempfile::TempDir::new()?;
    {
        let mut persisted = Pglite::builder().path(persistent_dir.path()).open()?;
        persisted.exec("CREATE TABLE persisted(value TEXT)", None)?;
        persisted.query(
            "INSERT INTO persisted(value) VALUES ($1)",
            &[json!("kept")],
            None,
        )?;
        persisted.close()?;
    }
    {
        let mut reopened = Pglite::open(persistent_dir.path())?;
        let persisted_result = reopened.query("SELECT value FROM persisted", &[], None)?;
        assert_eq!(
            first_row(&persisted_result)?.get("value"),
            Some(&json!("kept"))
        );
        reopened.close()?;
    }

    Ok(())
}
