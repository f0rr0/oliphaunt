#![cfg(feature = "extensions")]

use anyhow::Result;
use pglite_oxide::PgliteServer;
use pglite_oxide::extensions;
use pglite_oxide::{Pglite, capture_phase_timings};
use serde_json::json;
use std::time::Instant;

fn first_int(result: &pglite_oxide::Results, column: &str) -> i64 {
    result.rows[0][column].as_i64().expect("integer result")
}

fn phase_elapsed_micros(phases: &[pglite_oxide::PhaseTiming], name: &str) -> Option<u128> {
    phases
        .iter()
        .find(|phase| phase.name == name)
        .map(|phase| phase.elapsed_micros)
}

fn assert_startup_xlog_fast_if_instrumented(phases: &[pglite_oxide::PhaseTiming], context: &str) {
    let Some(startup_xlog) = phase_elapsed_micros(phases, "postgres.backend.c.startup_xlog") else {
        eprintln!(
            "{context}: C backend timing is not present; rebuild assets with \
             PGLITE_OXIDE_WASIX_BACKEND_TIMING=1 to assert StartupXLOG directly"
        );
        return;
    };
    assert!(
        startup_xlog < 200_000,
        "{context} should not require slow StartupXLOG recovery; \
         saw {startup_xlog}us in phases: {phases:#?}"
    );
}

#[test]
fn preload_runtime_then_open_smoke() -> Result<()> {
    let preload_started = Instant::now();
    Pglite::preload()?;
    let preload_elapsed = preload_started.elapsed();

    let open_started = Instant::now();
    let mut db = Pglite::builder().temporary().open()?;
    let open_elapsed = open_started.elapsed();

    let result = db.query("SELECT $1::int + 1 AS answer", &[json!(41)], None)?;
    assert_eq!(first_int(&result, "answer"), 42);
    db.close()?;

    eprintln!(
        "preload_runtime_then_open_smoke preload_ms={} open_ms={}",
        preload_elapsed.as_millis(),
        open_elapsed.as_millis()
    );
    Ok(())
}

#[test]
fn scalar_open_does_not_scan_array_catalog() -> Result<()> {
    let (result, phases) = capture_phase_timings(|| {
        let mut db = Pglite::builder().temporary().open()?;
        let result = db.query("SELECT $1::int + 1 AS answer", &[json!(41)], None)?;
        assert_eq!(first_int(&result, "answer"), 42);
        db.close()
    });
    result?;

    assert!(
        !phases
            .iter()
            .any(|phase| phase.name == "pglite.array_type_catalog_query"),
        "scalar open/query should not scan pg_type for array mappings: {phases:#?}"
    );
    Ok(())
}

#[test]
fn preload_reuses_process_aot_module_cache() -> Result<()> {
    let (first, first_phases) = capture_phase_timings(Pglite::preload);
    first?;
    let (second, second_phases) = capture_phase_timings(Pglite::preload);
    second?;

    let first_deserialized = first_phases
        .iter()
        .any(|phase| phase.name == "aot.deserialize");
    let second_deserialized = second_phases
        .iter()
        .any(|phase| phase.name == "aot.deserialize");

    if first_deserialized {
        assert!(
            !second_deserialized,
            "second preload should reuse the process module cache instead of deserializing again"
        );
    }
    Ok(())
}

#[test]
fn shared_runtime_does_not_share_database_state_between_instances() -> Result<()> {
    Pglite::preload()?;

    let mut first = Pglite::builder().temporary().open()?;
    first.exec(
        "CREATE TABLE process_cache_isolation(value int); \
         INSERT INTO process_cache_isolation VALUES (42);",
        None,
    )?;

    let mut second = Pglite::builder().temporary().open()?;
    let missing = second
        .query("SELECT value FROM process_cache_isolation", &[], None)
        .expect_err("temporary database state must not leak across instances");
    assert!(
        missing.to_string().contains("process_cache_isolation")
            || missing.to_string().contains("does not exist"),
        "unexpected isolation error: {missing:#}"
    );

    first.close()?;
    second.close()?;
    Ok(())
}

#[test]
fn persistent_direct_close_avoids_startup_xlog_recovery() -> Result<()> {
    let root = tempfile::TempDir::new()?;
    {
        let mut db = Pglite::builder().path(root.path()).open()?;
        db.exec(
            "CREATE TABLE clean_shutdown(value int); \
             INSERT INTO clean_shutdown VALUES (42);",
            None,
        )?;
        db.close()?;
    }

    let (result, phases) = capture_phase_timings(|| -> Result<()> {
        let mut db = Pglite::open(root.path())?;
        let row = db.query("SELECT value FROM clean_shutdown", &[], None)?;
        assert_eq!(first_int(&row, "value"), 42);
        db.close()
    });
    result?;

    assert_startup_xlog_fast_if_instrumented(&phases, "persistent direct close");
    Ok(())
}

#[cfg(feature = "extensions")]
#[test]
fn preload_extensions_reuses_extension_side_module_cache() -> Result<()> {
    let (first, first_phases) =
        capture_phase_timings(|| Pglite::preload_extensions([extensions::VECTOR]));
    first?;
    let (second, second_phases) =
        capture_phase_timings(|| Pglite::preload_extensions([extensions::VECTOR]));
    second?;

    let first_deserialized = first_phases
        .iter()
        .any(|phase| phase.name == "aot.deserialize");
    let second_deserialized = second_phases
        .iter()
        .any(|phase| phase.name == "aot.deserialize");

    if first_deserialized {
        assert!(
            !second_deserialized,
            "second extension preload should reuse the process side-module cache"
        );
    }
    Ok(())
}

#[cfg(feature = "extensions")]
#[test]
fn persistent_extension_server_reopen_uses_single_clean_backend() -> Result<()> {
    Pglite::preload_extensions([extensions::VECTOR])?;
    let root = tempfile::TempDir::new()?;

    {
        let mut db = Pglite::builder()
            .path(root.path())
            .extension(extensions::VECTOR)
            .open()?;
        db.query(
            "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
            &[],
            None,
        )?;
        db.close()?;
    }

    let (result, phases) = capture_phase_timings(|| -> Result<()> {
        let server = PgliteServer::builder()
            .path(root.path())
            .extension(extensions::VECTOR)
            .start()?;
        let url = server.database_url();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await?;
            let (distance,): (f64,) =
                sqlx::query_as("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector")
                    .fetch_one(&pool)
                    .await?;
            assert_eq!(distance, 1.0);
            pool.close().await;
            Ok::<_, anyhow::Error>(())
        })?;
        server.shutdown()
    });
    result?;

    let backend_starts = phases
        .iter()
        .filter(|phase| phase.name == "postgres.backend_start")
        .count();
    assert_eq!(
        backend_starts, 1,
        "extension server startup should not use a second setup backend: {phases:#?}"
    );
    assert_startup_xlog_fast_if_instrumented(&phases, "extension server reopen");
    Ok(())
}

#[cfg(feature = "extensions")]
#[test]
fn cached_extension_template_opens_without_startup_xlog_recovery() -> Result<()> {
    Pglite::preload_extensions([extensions::VECTOR])?;

    {
        let mut db = Pglite::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .open()?;
        db.query(
            "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
            &[],
            None,
        )?;
        db.close()?;
    }

    let (result, phases) = capture_phase_timings(|| -> Result<()> {
        let mut db = Pglite::builder()
            .temporary()
            .extension(extensions::VECTOR)
            .open()?;
        db.query(
            "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
            &[],
            None,
        )?;
        db.close()
    });
    result?;

    assert!(
        !phases
            .iter()
            .any(|phase| phase.name == "pgdata.extension_template_build"),
        "second extension open should reuse the cached extension template: {phases:#?}"
    );
    assert_startup_xlog_fast_if_instrumented(&phases, "cached extension template");
    Ok(())
}
