use std::future::Future;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use oliphaunt::{
    BackupFormat, BackupRequest, Error, Extension, NativeBrokerRuntime, NativeRuntime, Oliphaunt,
    OliphauntRuntime, QueryParam, RestoreRequest, Result,
};

// liboliphaunt-doc-example:rust-build-script
#[cfg(unix)]
const DIRECT_CRASH_ACTION_ENV: &str = "OLIPHAUNT_DIRECT_CRASH_ACTION";
#[cfg(unix)]
const DIRECT_CRASH_ROOT_ENV: &str = "OLIPHAUNT_DIRECT_CRASH_ROOT";
#[cfg(unix)]
const DIRECT_CRASH_MARKER_ENV: &str = "OLIPHAUNT_DIRECT_CRASH_MARKER";

#[test]
fn native_liboliphaunt_runtime_select_one_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native Oliphaunt runtime smoke: native runtime env is incomplete");
        return;
    }

    let root = unique_temp_root("oliphaunt-native-direct");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .extension(Extension::Vector)
            .runtime(OliphauntRuntime::from_env())
            .open(),
    )
    .unwrap();
    assert!(db.capabilities().query_cancel);
    assert!(db.capabilities().backup_restore);
    assert!(db.capabilities().simple_query);
    let response = block_on(db.exec_protocol_raw(raw_query_message("SELECT 1 AS value"))).unwrap();
    let tags = raw_message_tags(response.as_bytes());
    assert!(tags.contains(&b'T'), "missing RowDescription: {tags:?}");
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'C'), "missing CommandComplete: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    // liboliphaunt-doc-example:rust-basic-query
    let typed = block_on(db.query("SELECT 1::text AS value, NULL::text AS empty")).unwrap();
    assert_eq!(typed.fields()[0].name, "value");
    assert_eq!(typed.fields()[0].type_oid, 25);
    assert_eq!(typed.row_count(), 1);
    assert_eq!(typed.command_tag(), Some("SELECT 1"));
    assert_eq!(typed.get_text(0, "value").unwrap(), Some("1"));
    assert_eq!(typed.get_text(0, "empty").unwrap(), None);

    let query_error =
        block_on(db.query("SELECT * FROM liboliphaunt_query_missing_table")).unwrap_err();
    assert!(
        query_error
            .to_string()
            .contains("liboliphaunt_query_missing_table"),
        "typed query error lost PostgreSQL detail: {query_error}"
    );
    let recovered = block_on(db.query("SELECT 'ok'::text AS recovered")).unwrap();
    assert_eq!(recovered.get_text(0, "recovered").unwrap(), Some("ok"));

    let parameterized = block_on(db.query_params(
        "SELECT ($1::int4 + $2::int4)::text AS sum, $3::text AS maybe_null, $4::bool::text AS flag",
        [
            QueryParam::from(2_i32),
            QueryParam::from(40_i32),
            QueryParam::Null,
            QueryParam::from(true),
        ],
    ))
    .unwrap();
    assert_eq!(parameterized.get_text(0, "sum").unwrap(), Some("42"));
    assert_eq!(parameterized.get_text(0, "maybe_null").unwrap(), None);
    assert_eq!(parameterized.get_text(0, "flag").unwrap(), Some("true"));

    block_on(db.execute("CREATE TABLE tx_drop_smoke(value integer)")).unwrap();
    {
        let tx = block_on(db.transaction()).unwrap();
        block_on(tx.query_params("INSERT INTO tx_drop_smoke VALUES ($1)", [7_i32])).unwrap();
    }
    let rolled_back =
        block_on(db.query("SELECT count(*)::text AS count FROM tx_drop_smoke")).unwrap();
    assert_eq!(rolled_back.get_text(0, "count").unwrap(), Some("0"));

    let absent_extension =
        block_on(db.exec_protocol_raw(raw_query_message("CREATE EXTENSION hstore"))).unwrap();
    let tags = raw_message_tags(absent_extension.as_bytes());
    assert!(
        tags.contains(&b'E'),
        "unselected extension unexpectedly succeeded: {tags:?}"
    );
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let vector_response = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE EXTENSION vector; SELECT '[1,2,3]'::vector",
    )))
    .unwrap();
    let tags = raw_message_tags(vector_response.as_bytes());
    assert!(tags.contains(&b'C'), "missing CommandComplete: {tags:?}");
    assert!(tags.contains(&b'D'), "missing vector DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    assert!(db.capabilities().protocol_stream);

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let chunks = Arc::new(Mutex::new(0usize));
    let streamed_for_callback = Arc::clone(&streamed);
    let chunks_for_callback = Arc::clone(&chunks);
    block_on(db.exec_protocol_raw_stream(
        raw_query_message("SELECT repeat('x', 65536) AS value"),
        move |chunk| {
            *chunks_for_callback.lock().unwrap() += 1;
            streamed_for_callback
                .lock()
                .unwrap()
                .extend_from_slice(chunk);
            Ok(())
        },
    ))
    .unwrap();

    let bytes = streamed.lock().unwrap();
    let tags = raw_message_tags(&bytes);
    assert!(*chunks.lock().unwrap() >= 1);
    assert!(tags.contains(&b'T'), "missing RowDescription: {tags:?}");
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");
    drop(bytes);

    assert_streaming_cancel_recovers(&db, 15);
    assert_repeated_cancel_recovers(&db, 12);

    let archive = block_on(db.backup(BackupRequest::physical_archive())).unwrap();
    assert_physical_archive(&archive, "direct");

    assert_close_waits_for_active_query(&db);

    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .extension(Extension::Vector)
            .runtime(OliphauntRuntime::from_env())
            .open(),
    )
    .unwrap();
    let reopened_value =
        block_on(reopened.query("SELECT 42::text AS reopened_after_close")).unwrap();
    assert_eq!(
        reopened_value.get_text(0, "reopened_after_close").unwrap(),
        Some("42")
    );
    block_on(reopened.close()).unwrap();
}

#[cfg(unix)]
#[test]
fn native_direct_crash_consistency_survives_process_death_when_env_is_available() {
    if let Some(result) = run_direct_crash_child_from_env() {
        result.unwrap();
        return;
    }
    if native_runtime_env_is_unavailable() {
        eprintln!(
            "skipping native direct crash-consistency smoke: no native library env var is set"
        );
        return;
    }

    let root = unique_temp_root("oliphaunt-direct-crash-consistency");
    let committed_marker = root.with_extension("committed-ready");
    let uncommitted_marker = root.with_extension("uncommitted-ready");

    run_direct_crash_child_until_marker(DirectCrashAction::CommittedWait, &root, &committed_marker);
    run_direct_crash_child(DirectCrashAction::VerifyCommitted, &root);
    run_direct_crash_child_until_marker(
        DirectCrashAction::UncommittedWait,
        &root,
        &uncommitted_marker,
    );
    run_direct_crash_child(DirectCrashAction::VerifyUncommitted, &root);

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_file(committed_marker);
    let _ = std::fs::remove_file(uncommitted_marker);
}

#[test]
fn native_runtime_resources_generator_exports_platform_sdk_bundle_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!(
            "skipping native runtime resource generator smoke: no native library env var is set"
        );
        return;
    }
    let Some(resources_bin) = option_env!("CARGO_BIN_EXE_oliphaunt-resources") else {
        eprintln!(
            "skipping native runtime resource generator smoke: cargo did not provide runtime-resource generator binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-runtime-resources");
    let output_dir = root.join("bundle");
    let output = Command::new(resources_bin)
        .arg("--output")
        .arg(&output_dir)
        .arg("--extension")
        .arg("auto_explain,vector")
        .arg("--force")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "runtime resource generator failed with status {} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("packageSizeReport="));
    assert!(stdout.contains("selectedExtensionBytes="));
    assert!(stdout.contains("extensionBytes=auto_explain:"));
    assert!(stdout.contains("extensionBytes=vector:"));

    let resource_root = output_dir.join("oliphaunt");
    let runtime_manifest =
        std::fs::read_to_string(resource_root.join("runtime/manifest.properties")).unwrap();
    assert!(runtime_manifest.contains("schema=oliphaunt-runtime-resources-v1"));
    assert!(runtime_manifest.contains("layout=postgres-runtime-files-v1"));
    assert!(runtime_manifest.contains("mode=native-direct"));
    assert!(runtime_manifest.contains("selectedExtensions=auto_explain,vector\n"));
    assert!(runtime_manifest.contains("extensions=vector\n"));
    assert!(runtime_manifest.contains("sharedPreloadLibraries="));
    assert!(runtime_manifest.contains("mobileStaticRegistryState=pending"));
    assert!(runtime_manifest.contains("mobileStaticRegistryPending=auto_explain,vector"));
    assert!(runtime_manifest.contains("nativeModuleStems=auto_explain,vector"));
    assert!(runtime_manifest.contains("mobileStaticRegistrySource="));
    assert!(
        resource_root
            .join("runtime/files/share/postgresql/extension/plpgsql.control")
            .is_file()
    );
    assert!(
        resource_root
            .join("runtime/files/share/postgresql/extension/vector.control")
            .is_file()
    );
    assert!(
        !resource_root
            .join("runtime/files/share/postgresql/extension/hstore.control")
            .exists(),
        "unselected extension assets leaked into vector-only runtime resources"
    );
    let runtime_resource_size_report =
        std::fs::read_to_string(resource_root.join("package-size.tsv"))
            .expect("runtime resources should include package-size.tsv");
    assert!(runtime_resource_size_report.contains("kind\tid\textensions\tfiles\tbytes\n"));
    assert!(runtime_resource_size_report.contains("extensions\tselected\t"));
    assert!(runtime_resource_size_report.contains("extension\tauto_explain\t-\t"));
    assert!(runtime_resource_size_report.contains("extension\tvector\t-\t"));

    let template_manifest =
        std::fs::read_to_string(resource_root.join("template-pgdata/manifest.properties")).unwrap();
    assert!(template_manifest.contains("schema=oliphaunt-runtime-resources-v1"));
    assert!(template_manifest.contains("layout=postgres-template-pgdata-v1"));
    assert!(template_manifest.contains("selectedExtensions=\n"));
    assert!(template_manifest.contains("extensions=\n"));
    assert!(template_manifest.contains("sharedPreloadLibraries="));
    assert!(template_manifest.contains("mobileStaticRegistryState=not-required"));
    assert!(
        resource_root
            .join("template-pgdata/files/PG_VERSION")
            .is_file()
    );

    let mobile_ready_output_dir = root.join("mobile-ready-bundle");
    let mobile_ready = Command::new(resources_bin)
        .arg("--output")
        .arg(&mobile_ready_output_dir)
        .arg("--extension")
        .arg("auto_explain,vector")
        .arg("--mobile-static-module")
        .arg("auto_explain")
        .arg("--mobile-static-module")
        .arg("vector")
        .arg("--require-mobile-static-registry")
        .output()
        .unwrap();
    assert!(
        mobile_ready.status.success(),
        "mobile-ready runtime resource generator failed with status {} stdout={} stderr={}",
        mobile_ready.status,
        String::from_utf8_lossy(&mobile_ready.stdout),
        String::from_utf8_lossy(&mobile_ready.stderr)
    );
    let mobile_ready_manifest = std::fs::read_to_string(
        mobile_ready_output_dir.join("oliphaunt/runtime/manifest.properties"),
    )
    .unwrap();
    assert!(mobile_ready_manifest.contains("mobileStaticRegistryState=complete"));
    assert!(mobile_ready_manifest.contains("selectedExtensions=auto_explain,vector\n"));
    assert!(mobile_ready_manifest.contains("extensions=vector\n"));
    assert!(mobile_ready_manifest.contains("mobileStaticRegistryRegistered=auto_explain,vector"));
    assert!(mobile_ready_manifest.contains("mobileStaticRegistryPending="));
    assert!(
        mobile_ready_manifest
            .contains("mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c")
    );
    let static_registry_manifest = std::fs::read_to_string(
        mobile_ready_output_dir.join("oliphaunt/static-registry/manifest.properties"),
    )
    .unwrap();
    assert!(static_registry_manifest.contains("packageLayout=oliphaunt-static-registry-v1"));
    assert!(static_registry_manifest.contains("state=complete"));
    assert!(static_registry_manifest.contains("registeredExtensions=auto_explain,vector"));
    assert!(static_registry_manifest.contains("nativeModuleStems=auto_explain,vector"));
    assert!(
        static_registry_manifest
            .contains("module.auto_explain.symbolPrefix=oliphaunt_static_auto_explain")
    );
    assert!(
        static_registry_manifest.contains("module.vector.symbolPrefix=oliphaunt_static_vector")
    );
    let static_registry_source = std::fs::read_to_string(
        mobile_ready_output_dir.join("oliphaunt/static-registry/oliphaunt_static_registry.c"),
    )
    .unwrap();
    assert!(static_registry_source.contains("liboliphaunt_selected_static_extensions"));
    assert!(static_registry_source.contains("oliphaunt_static_vector_Pg_magic_func"));
    assert!(
        static_registry_source
            .contains("extern const void *oliphaunt_static_vector_Pg_magic_func(void);")
    );
    assert!(static_registry_source.contains("OLIPHAUNT_STATIC_OPTIONAL"));
    assert!(!static_registry_source.contains(&format!("OLIPHAUNT_STATIC_{}", "WEAK")));
    assert!(static_registry_source.contains("\"vector_in\""));
    assert!(static_registry_source.contains("\"pg_finfo_vector_in\""));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_runtime_select_one_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker smoke: no native library env var is set");
        return;
    }
    let Some(broker) = option_env!("CARGO_BIN_EXE_oliphaunt-broker") else {
        eprintln!("skipping native broker smoke: cargo did not provide broker binary path");
        return;
    };

    let db = block_on(
        Oliphaunt::builder()
            .temporary()
            .native_broker()
            .extension(Extension::Vector)
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    assert!(db.capabilities().process_isolated);
    assert!(db.capabilities().protocol_stream);
    assert!(db.capabilities().query_cancel);
    assert!(db.capabilities().backup_restore);
    assert!(db.capabilities().simple_query);
    let response = block_on(db.exec_protocol_raw(raw_query_message("SELECT 1 AS value"))).unwrap();
    let tags = raw_message_tags(response.as_bytes());
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let absent_extension =
        block_on(db.exec_protocol_raw(raw_query_message("CREATE EXTENSION hstore"))).unwrap();
    let tags = raw_message_tags(absent_extension.as_bytes());
    assert!(
        tags.contains(&b'E'),
        "broker allowed an unselected extension: {tags:?}"
    );
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let vector_response = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE EXTENSION vector; SELECT '[4,5,6]'::vector",
    )))
    .unwrap();
    let tags = raw_message_tags(vector_response.as_bytes());
    assert!(tags.contains(&b'D'), "missing vector DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    block_on(db.exec_protocol_raw_stream(
        raw_query_message("SELECT repeat('y', 65536) AS value"),
        move |chunk| {
            streamed_for_callback
                .lock()
                .unwrap()
                .extend_from_slice(chunk);
            Ok(())
        },
    ))
    .unwrap();
    let tags = raw_message_tags(&streamed.lock().unwrap());
    assert!(tags.contains(&b'D'), "missing streamed DataRow: {tags:?}");
    assert!(
        tags.contains(&b'Z'),
        "missing streamed ReadyForQuery: {tags:?}"
    );

    assert_broker_cancel_reuses_helper(&db, 13);

    let archive = block_on(db.backup(BackupRequest::physical_archive())).unwrap();
    assert_physical_archive(&archive, "broker");

    assert_close_waits_for_active_query(&db);
}

#[test]
fn native_broker_existing_only_rejects_unbootstrapped_roots_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker existing-only smoke: no native library env var is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker existing-only smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-existing-only");
    let error = expect_open_error(block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    ));
    assert!(
        error.to_string().contains("has not been bootstrapped"),
        "unexpected broker existing-only error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_rejects_incompatible_root_manifest_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker root-manifest smoke: no native library env var is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker root-manifest smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-root-manifest");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    block_on(db.close()).unwrap();

    std::fs::write(
        root.join("manifest.properties"),
        b"layout=oliphaunt-root-v1\nproduct=oliphaunt\npostgresMajor=17\npgdata=pgdata\npgdataVersion=18\n",
    )
    .unwrap();
    let error = expect_open_error(block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    ));
    let message = error.to_string();
    assert!(
        message.contains("native root manifest")
            && message.contains("postgresMajor='17', expected '18'"),
        "unexpected broker root-manifest error: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_rejects_pgdata_version_manifest_mismatch_and_recovers_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!(
            "skipping native broker PGDATA manifest-version smoke: no native library env var is set"
        );
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker PGDATA manifest-version smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-pgdata-version-manifest");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    let seed = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE TABLE metadata_recovery(value integer); INSERT INTO metadata_recovery VALUES (88)",
    )))
    .unwrap();
    assert!(
        raw_message_tags(seed.as_bytes()).contains(&b'C'),
        "missing metadata-recovery seed command"
    );
    block_on(db.close()).unwrap();

    let manifest_path = root.join("manifest.properties");
    let valid_manifest = std::fs::read_to_string(&manifest_path).unwrap();
    assert!(
        valid_manifest.contains("pgdataVersion=18\n"),
        "expected bootstrapped root manifest to record PGDATA 18:\n{valid_manifest}"
    );
    std::fs::write(
        &manifest_path,
        valid_manifest.replace("pgdataVersion=18\n", "pgdataVersion=17\n"),
    )
    .unwrap();

    let error = expect_open_error(block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    ));
    let message = error.to_string();
    assert!(
        message.contains("native root manifest")
            && message.contains("declares PGDATA version '17'")
            && message.contains("contains PostgreSQL 18"),
        "unexpected broker PGDATA manifest-version error: {error}"
    );

    std::fs::write(&manifest_path, valid_manifest).unwrap();
    let recovered = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    )
    .unwrap();
    let response = block_on(recovered.exec_protocol_raw(raw_query_message(
        "SELECT value::text FROM metadata_recovery",
    )))
    .unwrap();
    assert_eq!(first_data_row_text_values(response.as_bytes()), vec!["88"]);
    block_on(recovered.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_reopens_persistent_root_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker restart smoke: no native library env var is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!("skipping native broker restart smoke: cargo did not provide broker binary path");
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-restart");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    let seed = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE TABLE restart_smoke(value integer); INSERT INTO restart_smoke VALUES (91)",
    )))
    .unwrap();
    let tags = raw_message_tags(seed.as_bytes());
    assert!(
        tags.contains(&b'C'),
        "missing restart seed command: {tags:?}"
    );
    block_on(db.close()).unwrap();

    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .existing_only()
            .open(),
    )
    .unwrap();
    let response = block_on(
        reopened.exec_protocol_raw(raw_query_message("SELECT value::text FROM restart_smoke")),
    )
    .unwrap();
    assert_eq!(first_data_row_text_values(response.as_bytes()), vec!["91"]);
    block_on(reopened.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn native_broker_relaunches_helper_after_crash_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker crash-recovery smoke: no native library env var is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker crash-recovery smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let root = unique_temp_root("oliphaunt-broker-crash-recovery");
    let db = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_broker()
            .broker_executable(broker)
            .open(),
    )
    .unwrap();
    let seed = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE TABLE crash_recovery(value integer); \
         INSERT INTO crash_recovery VALUES (97); \
         SELECT pg_backend_pid()::text",
    )))
    .unwrap();
    let values = first_data_row_text_values(seed.as_bytes());
    let helper_pid = values
        .last()
        .expect("pg_backend_pid result was not returned")
        .clone();
    let status = Command::new("kill")
        .arg("-KILL")
        .arg(&helper_pid)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to kill broker helper {helper_pid}"
    );
    thread::sleep(Duration::from_millis(200));

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match block_on(
            db.exec_protocol_raw(raw_query_message("SELECT value::text FROM crash_recovery")),
        ) {
            Ok(response) => {
                assert_eq!(first_data_row_text_values(response.as_bytes()), vec!["97"]);
                break;
            }
            Err(error) if Instant::now() < deadline => {
                eprintln!("waiting for broker relaunch after helper crash: {error}");
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => panic!("broker did not recover after helper crash: {error}"),
        }
    }

    let pid_response =
        block_on(db.exec_protocol_raw(raw_query_message("SELECT pg_backend_pid()::text"))).unwrap();
    let helper_pid = first_data_row_text_values(pid_response.as_bytes())
        .last()
        .expect("restarted pg_backend_pid result was not returned")
        .clone();
    let in_flight = db.clone();
    let worker = thread::spawn(move || {
        block_on(in_flight.exec_protocol_raw(raw_query_message(
            "SELECT pg_sleep(5) AS should_fail_with_helper",
        )))
    });
    thread::sleep(Duration::from_millis(200));
    let status = Command::new("kill")
        .arg("-KILL")
        .arg(&helper_pid)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to kill restarted broker helper {helper_pid}"
    );
    match worker.join().unwrap() {
        Ok(response) => panic!(
            "in-flight broker request unexpectedly succeeded after helper kill: {:?}",
            raw_message_tags(response.as_bytes())
        ),
        Err(error) => assert!(
            error.to_string().contains("broker"),
            "unexpected in-flight crash error: {error}"
        ),
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match block_on(
            db.exec_protocol_raw(raw_query_message("SELECT value::text FROM crash_recovery")),
        ) {
            Ok(response) => {
                assert_eq!(first_data_row_text_values(response.as_bytes()), vec!["97"]);
                break;
            }
            Err(error) if Instant::now() < deadline => {
                eprintln!("waiting for broker relaunch after in-flight helper crash: {error}");
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => panic!("broker did not recover after in-flight helper crash: {error}"),
        }
    }

    block_on(db.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_broker_shared_runtime_admits_multiple_roots_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native broker multi-root smoke: no native library env var is set");
        return;
    }
    let Some(broker) = native_broker_executable() else {
        eprintln!(
            "skipping native broker multi-root smoke: cargo did not provide broker binary path"
        );
        return;
    };

    let runtime: Arc<dyn NativeRuntime> =
        Arc::new(NativeBrokerRuntime::from_executable(broker).with_max_roots(2));
    let root_a = unique_temp_root("oliphaunt-broker-multi-a");
    let root_b = unique_temp_root("oliphaunt-broker-multi-b");
    let root_c = unique_temp_root("oliphaunt-broker-multi-c");

    let db_a = block_on(
        Oliphaunt::builder()
            .path(&root_a)
            .native_broker()
            .broker_max_roots(2)
            .runtime_arc(Arc::clone(&runtime))
            .open(),
    )
    .unwrap();
    let db_b = block_on(
        Oliphaunt::builder()
            .path(&root_b)
            .native_broker()
            .broker_max_roots(2)
            .runtime_arc(Arc::clone(&runtime))
            .open(),
    )
    .unwrap();

    assert!(db_a.capabilities().multi_root);
    assert!(db_b.capabilities().multi_root);
    assert_eq!(
        first_data_row_text_values(
            block_on(db_a.exec_protocol_raw(raw_query_message("SELECT 21::text")))
                .unwrap()
                .as_bytes()
        ),
        vec!["21"]
    );
    assert_eq!(
        first_data_row_text_values(
            block_on(db_b.exec_protocol_raw(raw_query_message("SELECT 22::text")))
                .unwrap()
                .as_bytes()
        ),
        vec!["22"]
    );

    let capacity_error = expect_open_error(block_on(
        Oliphaunt::builder()
            .path(&root_c)
            .native_broker()
            .broker_max_roots(2)
            .runtime_arc(Arc::clone(&runtime))
            .open(),
    ));
    assert!(
        capacity_error.to_string().contains("configured capacity 2"),
        "unexpected broker capacity error: {capacity_error}"
    );

    block_on(db_a.close()).unwrap();
    let db_c = block_on(
        Oliphaunt::builder()
            .path(&root_c)
            .native_broker()
            .broker_max_roots(2)
            .runtime_arc(runtime)
            .open(),
    )
    .unwrap();
    assert_eq!(
        first_data_row_text_values(
            block_on(db_c.exec_protocol_raw(raw_query_message("SELECT 23::text")))
                .unwrap()
                .as_bytes()
        ),
        vec!["23"]
    );

    block_on(db_b.close()).unwrap();
    block_on(db_c.close()).unwrap();
    let _ = std::fs::remove_dir_all(root_a);
    let _ = std::fs::remove_dir_all(root_b);
    let _ = std::fs::remove_dir_all(root_c);
}

#[test]
fn native_server_runtime_select_one_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server smoke: no native library env var is set");
        return;
    }

    let db = block_on(
        Oliphaunt::builder()
            .temporary()
            .native_server()
            .extension(Extension::Vector)
            .open(),
    )
    .unwrap();
    assert!(db.capabilities().connection_strings);
    assert!(db.capabilities().query_cancel);
    assert!(db.capabilities().backup_restore);
    assert!(db.capabilities().simple_query);
    let connection_string = db.connection_string().unwrap();
    assert_eq!(
        db.capabilities().connection_string.as_deref(),
        Some(connection_string.as_str())
    );
    let response = block_on(db.exec_protocol_raw(raw_query_message("SELECT 1 AS value"))).unwrap();
    let tags = raw_message_tags(response.as_bytes());
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let error_response = block_on(db.exec_protocol_raw(raw_query_message(
        "SELECT * FROM liboliphaunt_server_missing_table",
    )))
    .unwrap();
    let tags = raw_message_tags(error_response.as_bytes());
    assert!(tags.contains(&b'E'), "missing ErrorResponse: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let absent_extension =
        block_on(db.exec_protocol_raw(raw_query_message("CREATE EXTENSION hstore"))).unwrap();
    let tags = raw_message_tags(absent_extension.as_bytes());
    assert!(
        tags.contains(&b'E'),
        "server allowed an unselected extension: {tags:?}"
    );
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let vector_response = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE EXTENSION vector; SELECT '[7,8,9]'::vector",
    )))
    .unwrap();
    let tags = raw_message_tags(vector_response.as_bytes());
    assert!(tags.contains(&b'D'), "missing vector DataRow: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    // liboliphaunt-doc-example:rust-backup-restore
    let backup_seed = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE TABLE backup_smoke(value integer); \
         INSERT INTO backup_smoke VALUES (42); \
         CREATE TABLE backup_vector(value vector(3)); \
         INSERT INTO backup_vector VALUES ('[1,2,3]')",
    )))
    .unwrap();
    let tags = raw_message_tags(backup_seed.as_bytes());
    assert!(
        tags.contains(&b'C'),
        "missing backup seed CommandComplete: {tags:?}"
    );
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    block_on(db.exec_protocol_raw_stream(
        raw_query_message("SELECT repeat('z', 65536) AS value"),
        move |chunk| {
            streamed_for_callback
                .lock()
                .unwrap()
                .extend_from_slice(chunk);
            Ok(())
        },
    ))
    .unwrap();
    let tags = raw_message_tags(&streamed.lock().unwrap());
    assert!(tags.contains(&b'D'), "missing streamed DataRow: {tags:?}");
    assert!(
        tags.contains(&b'Z'),
        "missing streamed ReadyForQuery: {tags:?}"
    );

    assert_large_server_raw_pipeline_recovers(&db);

    assert_repeated_cancel_recovers(&db, 14);
    assert_eq!(
        db.connection_string().as_deref(),
        Some(connection_string.as_str()),
        "server connection string changed after protocol, streaming, and cancel work"
    );

    let sql = block_on(db.backup(BackupRequest::sql())).unwrap();
    assert_eq!(sql.format, BackupFormat::Sql);
    let sql = String::from_utf8(sql.bytes).unwrap();
    assert!(
        sql.contains("PostgreSQL database dump"),
        "server SQL backup did not look like pg_dump output"
    );

    let archive = block_on(db.backup(BackupRequest::physical_archive())).unwrap();
    assert_physical_archive(&archive, "server");
    let restored_root = unique_temp_root("oliphaunt-restore");
    block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        &restored_root,
        archive,
    )))
    .unwrap();

    assert_close_waits_for_active_query(&db);

    let restored = block_on(
        Oliphaunt::builder()
            .path(&restored_root)
            .native_server()
            .extension(Extension::Vector)
            .existing_only()
            .open(),
    )
    .unwrap();
    let restored_response =
        block_on(restored.exec_protocol_raw(raw_query_message("SELECT value FROM backup_smoke")))
            .unwrap();
    let tags = raw_message_tags(restored_response.as_bytes());
    assert!(tags.contains(&b'D'), "missing restored DataRow: {tags:?}");
    assert!(
        tags.contains(&b'Z'),
        "missing restored ReadyForQuery: {tags:?}"
    );
    let restored_vector_response = block_on(
        restored.exec_protocol_raw(raw_query_message("SELECT value::text FROM backup_vector")),
    )
    .unwrap();
    let tags = raw_message_tags(restored_vector_response.as_bytes());
    assert!(
        tags.contains(&b'D'),
        "missing restored vector DataRow: {tags:?}"
    );
    assert!(
        tags.contains(&b'Z'),
        "missing restored vector ReadyForQuery: {tags:?}"
    );
    block_on(restored.close()).unwrap();
    let _ = std::fs::remove_dir_all(restored_root);
}

#[test]
fn native_server_reopens_persistent_root_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server restart smoke: no native library env var is set");
        return;
    }

    let root = unique_temp_root("oliphaunt-server-restart");
    let db = block_on(Oliphaunt::builder().path(&root).native_server().open()).unwrap();
    let seed = block_on(db.exec_protocol_raw(raw_query_message(
        "CREATE TABLE restart_smoke(value integer); INSERT INTO restart_smoke VALUES (92)",
    )))
    .unwrap();
    let tags = raw_message_tags(seed.as_bytes());
    assert!(
        tags.contains(&b'C'),
        "missing restart seed command: {tags:?}"
    );
    block_on(db.close()).unwrap();

    let reopened = block_on(
        Oliphaunt::builder()
            .path(&root)
            .native_server()
            .existing_only()
            .open(),
    )
    .unwrap();
    let response = block_on(
        reopened.exec_protocol_raw(raw_query_message("SELECT value::text FROM restart_smoke")),
    )
    .unwrap();
    assert_eq!(first_data_row_text_values(response.as_bytes()), vec!["92"]);
    block_on(reopened.close()).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_server_accepts_independent_tokio_postgres_clients_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server client smoke: no native library env var is set");
        return;
    }

    let db = block_on(
        Oliphaunt::builder()
            .temporary()
            .native_server()
            .max_client_sessions(4)
            .open(),
    )
    .unwrap();
    let connection_string = db.connection_string().unwrap();
    assert_eq!(
        db.capabilities().connection_string.as_deref(),
        Some(connection_string.as_str())
    );

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (client_a, connection_a) =
            tokio_postgres::connect(&connection_string, tokio_postgres::NoTls)
                .await
                .unwrap();
        let (client_b, connection_b) =
            tokio_postgres::connect(&connection_string, tokio_postgres::NoTls)
                .await
                .unwrap();
        let connection_a = tokio::spawn(connection_a);
        let connection_b = tokio::spawn(connection_b);

        client_a
            .batch_execute(
                "CREATE TABLE independent_clients(value integer); \
                     INSERT INTO independent_clients VALUES (7)",
            )
            .await
            .unwrap();
        let row = client_b
            .query_one("SELECT value FROM independent_clients", &[])
            .await
            .unwrap();
        let value: i32 = row.get(0);
        assert_eq!(value, 7);

        let cancel_token = client_b.cancel_token();
        let mut sleep = Box::pin(client_b.batch_execute("SELECT pg_sleep(5)"));
        match tokio::time::timeout(Duration::from_millis(100), sleep.as_mut()).await {
            Err(_) => {}
            Ok(Ok(())) => panic!("external server client sleep query finished before cancel"),
            Ok(Err(error)) => panic!("external server client failed before cancel: {error}"),
        }
        cancel_token
            .cancel_query(tokio_postgres::NoTls)
            .await
            .unwrap();
        let cancelled = sleep.await.unwrap_err();
        assert_eq!(
            cancelled.code(),
            Some(&tokio_postgres::error::SqlState::QUERY_CANCELED),
            "external server client did not receive PostgreSQL query-canceled SQLSTATE: {cancelled}"
        );
        let row = client_b.query_one("SELECT 8", &[]).await.unwrap();
        let value: i32 = row.get(0);
        assert_eq!(value, 8);

        drop(client_a);
        drop(client_b);
        connection_a.await.unwrap().unwrap();
        connection_b.await.unwrap().unwrap();
    });
    assert_eq!(
        db.connection_string().as_deref(),
        Some(connection_string.as_str()),
        "server connection string changed after independent client use"
    );

    block_on(db.close()).unwrap();
}

#[test]
fn native_server_close_stops_active_external_clients_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!(
            "skipping native server active-client shutdown smoke: no native library env var is set"
        );
        return;
    }

    let db = block_on(Oliphaunt::builder().temporary().native_server().open()).unwrap();
    let connection_string = db.connection_string().unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (client, connection) =
            tokio_postgres::connect(&connection_string, tokio_postgres::NoTls)
                .await
                .unwrap();
        let connection = tokio::spawn(connection);

        let mut sleep = Box::pin(client.batch_execute("SELECT pg_sleep(30)"));
        match tokio::time::timeout(Duration::from_millis(100), sleep.as_mut()).await {
            Err(_) => {}
            Ok(Ok(())) => panic!("external server client sleep query finished before close"),
            Ok(Err(error)) => panic!("external server client failed before close: {error}"),
        }

        db.close().await.unwrap();
        let stopped = sleep.await.unwrap_err();
        assert!(
            stopped.is_closed()
                || stopped
                    .code()
                    .is_some_and(|code| code == &tokio_postgres::error::SqlState::ADMIN_SHUTDOWN),
            "active external client saw unexpected shutdown error: {stopped}"
        );
        assert!(
            client.simple_query("SELECT 1").await.is_err(),
            "external client query succeeded after owned server close"
        );
        drop(client);
        let _ = connection.await;
    });
}

#[test]
fn native_server_accepts_sqlx_pool_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server sqlx smoke: no native library env var is set");
        return;
    }

    let db = block_on(
        Oliphaunt::builder()
            .temporary()
            .native_server()
            .max_client_sessions(4)
            .open(),
    )
    .unwrap();
    let connection_string = db.connection_string().unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&connection_string)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sqlx_pool_smoke(value integer)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sqlx_pool_smoke VALUES ($1)")
            .bind(93_i32)
            .execute(&pool)
            .await
            .unwrap();
        let (value,): (i32,) = sqlx::query_as("SELECT value FROM sqlx_pool_smoke")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, 93);
        db.close().await.unwrap();
        let rejected = sqlx::query("SELECT 1").execute(&pool).await.unwrap_err();
        assert!(
            rejected.to_string().contains("closed")
                || rejected.to_string().contains("terminat")
                || rejected.to_string().contains("connection")
                || rejected.to_string().contains("pool"),
            "SQLx pool returned unexpected error after server close: {rejected}"
        );
        pool.close().await;
    });
}

#[test]
fn native_server_accepts_tokio_postgres_prepared_and_pipelined_clients_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server tokio-postgres smoke: no native library env var is set");
        return;
    }

    let db = block_on(
        Oliphaunt::builder()
            .temporary()
            .native_server()
            .max_client_sessions(4)
            .open(),
    )
    .unwrap();
    let connection_string = db.connection_string().unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (client, connection) =
            tokio_postgres::connect(&connection_string, tokio_postgres::NoTls)
                .await
                .unwrap();
        let connection = tokio::spawn(connection);

        client
            .batch_execute("CREATE TABLE tokio_client_smoke(id integer PRIMARY KEY, value integer)")
            .await
            .unwrap();
        let insert = client
            .prepare("INSERT INTO tokio_client_smoke VALUES ($1, $2)")
            .await
            .unwrap();
        let pending = (1_i32..=16)
            .map(|value| {
                let client = &client;
                let insert = &insert;
                async move {
                    let doubled = value * 10;
                    client.execute(insert, &[&value, &doubled]).await
                }
            })
            .collect::<Vec<_>>();
        let inserted = futures_util::future::try_join_all(pending).await.unwrap();
        assert_eq!(inserted, vec![1_u64; 16]);

        let select = client
            .prepare(
                "SELECT count(*)::int4, sum(value)::int4 FROM tokio_client_smoke WHERE id >= $1",
            )
            .await
            .unwrap();
        let row = client.query_one(&select, &[&4_i32]).await.unwrap();
        assert_eq!(row.get::<_, i32>(0), 13);
        assert_eq!(row.get::<_, i32>(1), 1300);

        db.close().await.unwrap();
        let _ = connection.await;
    });
}

#[test]
fn native_server_accepts_psql_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server psql smoke: no native library env var is set");
        return;
    }
    let Some(psql) = native_tool_path("psql") else {
        eprintln!("skipping native server psql smoke: matching psql binary was not found");
        return;
    };

    let db = block_on(Oliphaunt::builder().temporary().native_server().open()).unwrap();
    let connection_string = db.connection_string().unwrap();
    let output = Command::new(&psql)
        .arg(&connection_string)
        .arg("--no-psqlrc")
        .arg("--tuples-only")
        .arg("--no-align")
        .arg("--set")
        .arg("ON_ERROR_STOP=1")
        .arg("--command")
        .arg("SELECT 11")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "psql failed with status {} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "11");
    block_on(db.close()).unwrap();
}

#[test]
fn native_server_accepts_pg_dump_when_env_is_available() {
    if native_runtime_env_is_unavailable() {
        eprintln!("skipping native server pg_dump smoke: no native library env var is set");
        return;
    }
    let Some(pg_dump) = native_tool_path("pg_dump") else {
        eprintln!("skipping native server pg_dump smoke: matching pg_dump binary was not found");
        return;
    };

    let db = block_on(Oliphaunt::builder().temporary().native_server().open()).unwrap();
    let connection_string = db.connection_string().unwrap();
    block_on(db.execute(
        "CREATE TABLE dump_client_smoke(id integer PRIMARY KEY, value text); \
         INSERT INTO dump_client_smoke VALUES (1, 'dumped')",
    ))
    .unwrap();

    let output = Command::new(&pg_dump)
        .arg(&connection_string)
        .arg("--no-owner")
        .arg("--no-privileges")
        .arg("--data-only")
        .arg("--table")
        .arg("dump_client_smoke")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "pg_dump failed with status {} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("dumped") && stdout.contains("dump_client_smoke"),
        "pg_dump output did not include expected table data:\n{stdout}"
    );
    block_on(db.close()).unwrap();
}

fn raw_query_message(sql: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(sql.as_bytes());
    body.push(0);

    let mut packet = Vec::with_capacity(body.len() + 5);
    packet.push(b'Q');
    packet.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    packet.extend_from_slice(&body);
    packet
}

fn assert_large_server_raw_pipeline_recovers(db: &Oliphaunt) {
    let rows = 6_000;
    block_on(db.execute(&format!(
        "CREATE TEMP TABLE server_duplex_updates(id integer PRIMARY KEY, value integer); \
         INSERT INTO server_duplex_updates SELECT i, 0 FROM generate_series(1, {rows}) AS i",
    )))
    .unwrap();

    let statement_name = "server_duplex_update";
    let mut prepare = Vec::new();
    prepare.extend(extended_parse(
        Some(statement_name),
        "UPDATE server_duplex_updates SET value = $1 WHERE id = $2",
        &[23, 23],
    ));
    prepare.extend(extended_sync());
    let prepared = block_on(db.exec_protocol_raw(prepare)).unwrap();
    assert_raw_response_ok(prepared.as_bytes(), "large raw pipeline prepare");

    let mut batch = Vec::new();
    for row in 1..=rows {
        let portal = format!("server_duplex_portal_{row}");
        let value = row.to_string();
        let id = row.to_string();
        batch.extend(extended_bind(
            Some(&portal),
            statement_name,
            &[value.as_str(), id.as_str()],
        ));
        batch.extend(extended_execute(Some(&portal)));
        batch.extend(extended_close(b'P', Some(&portal)));
    }
    batch.extend(extended_sync());
    assert!(
        batch.len() > 300 * 1024,
        "large raw server pipeline request was too small to exercise duplex write/read: {} bytes",
        batch.len()
    );

    let response = block_on(db.exec_protocol_raw(batch)).unwrap();
    assert_raw_response_ok(response.as_bytes(), "large raw server pipeline");
    let tags = raw_message_tags(response.as_bytes());
    assert!(
        tags.iter().filter(|tag| **tag == b'C').count() >= rows,
        "large raw server pipeline did not return expected CommandComplete frames"
    );

    let sum = block_on(db.query(
        "SELECT count(*)::text AS count, sum(value)::text AS sum FROM server_duplex_updates",
    ))
    .unwrap();
    let expected_count = rows.to_string();
    let expected_sum = ((rows * (rows + 1)) / 2).to_string();
    assert_eq!(
        sum.get_text(0, "count").unwrap(),
        Some(expected_count.as_str())
    );
    assert_eq!(sum.get_text(0, "sum").unwrap(), Some(expected_sum.as_str()));
}

fn assert_raw_response_ok(bytes: &[u8], context: &str) {
    let tags = raw_message_tags(bytes);
    assert!(
        !tags.contains(&b'E'),
        "{context} returned ErrorResponse: {tags:?}"
    );
    assert!(
        tags.contains(&b'Z'),
        "{context} did not return ReadyForQuery: {tags:?}"
    );
}

fn extended_parse(name: Option<&str>, sql: &str, type_oids: &[i32]) -> Vec<u8> {
    let mut body = Vec::new();
    push_protocol_cstr(&mut body, name.unwrap_or(""));
    push_protocol_cstr(&mut body, sql);
    push_protocol_i16(&mut body, type_oids.len() as i16);
    for oid in type_oids {
        push_protocol_i32(&mut body, *oid);
    }
    protocol_frame(b'P', &body)
}

fn extended_bind(portal: Option<&str>, statement: &str, values: &[&str]) -> Vec<u8> {
    let mut body = Vec::new();
    push_protocol_cstr(&mut body, portal.unwrap_or(""));
    push_protocol_cstr(&mut body, statement);
    push_protocol_i16(&mut body, values.len() as i16);
    for _ in values {
        push_protocol_i16(&mut body, 0);
    }
    push_protocol_i16(&mut body, values.len() as i16);
    for value in values {
        push_protocol_i32(&mut body, value.len() as i32);
        body.extend_from_slice(value.as_bytes());
    }
    push_protocol_i16(&mut body, 0);
    protocol_frame(b'B', &body)
}

fn extended_execute(portal: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    push_protocol_cstr(&mut body, portal.unwrap_or(""));
    push_protocol_i32(&mut body, 0);
    protocol_frame(b'E', &body)
}

fn extended_close(target_type: u8, name: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    body.push(target_type);
    push_protocol_cstr(&mut body, name.unwrap_or(""));
    protocol_frame(b'C', &body)
}

fn extended_sync() -> Vec<u8> {
    protocol_frame(b'S', &[])
}

fn protocol_frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 4 + body.len());
    frame.push(tag);
    frame.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    frame.extend_from_slice(body);
    frame
}

fn push_protocol_cstr(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn push_protocol_i16(out: &mut Vec<u8>, value: i16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_protocol_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_be_bytes());
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectCrashAction {
    CommittedWait,
    VerifyCommitted,
    UncommittedWait,
    VerifyUncommitted,
}

#[cfg(unix)]
impl DirectCrashAction {
    fn as_env(self) -> &'static str {
        match self {
            Self::CommittedWait => "committed-wait",
            Self::VerifyCommitted => "verify-committed",
            Self::UncommittedWait => "uncommitted-wait",
            Self::VerifyUncommitted => "verify-uncommitted",
        }
    }

    fn from_env(value: &str) -> Option<Self> {
        match value {
            "committed-wait" => Some(Self::CommittedWait),
            "verify-committed" => Some(Self::VerifyCommitted),
            "uncommitted-wait" => Some(Self::UncommittedWait),
            "verify-uncommitted" => Some(Self::VerifyUncommitted),
            _ => None,
        }
    }
}

#[cfg(unix)]
fn run_direct_crash_child_from_env() -> Option<std::result::Result<(), String>> {
    let action = std::env::var(DIRECT_CRASH_ACTION_ENV).ok()?;
    let action = DirectCrashAction::from_env(&action)
        .ok_or_else(|| format!("unknown direct crash action '{action}'"));
    let root = std::env::var_os(DIRECT_CRASH_ROOT_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{DIRECT_CRASH_ROOT_ENV} is required"));
    let marker = std::env::var_os(DIRECT_CRASH_MARKER_ENV).map(PathBuf::from);
    Some((|| {
        run_direct_crash_child_action(action?, &root?, marker.as_deref())
            .map_err(|error| error.to_string())?;
        Ok(())
    })())
}

#[cfg(unix)]
fn run_direct_crash_child_until_marker(action: DirectCrashAction, root: &Path, marker: &Path) {
    let mut child = spawn_direct_crash_child(action, root, Some(marker));
    let deadline = Instant::now() + Duration::from_secs(15);
    while !marker.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            let output = child.wait_with_output().unwrap();
            panic!(
                "direct crash child exited before marker for {action:?}: status={status} stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(
            Instant::now() < deadline,
            "direct crash child did not create marker {marker:?} for {action:?}"
        );
        thread::sleep(Duration::from_millis(50));
    }

    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        !output.status.success(),
        "direct crash child unexpectedly exited cleanly for {action:?}: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn run_direct_crash_child(action: DirectCrashAction, root: &Path) {
    let output = spawn_direct_crash_child(action, root, None)
        .wait_with_output()
        .unwrap();
    assert!(
        output.status.success(),
        "direct crash child failed for {action:?}: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn spawn_direct_crash_child(
    action: DirectCrashAction,
    root: &Path,
    marker: Option<&Path>,
) -> std::process::Child {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("native_direct_crash_consistency_survives_process_death_when_env_is_available")
        .arg("--exact")
        .arg("--nocapture")
        .env(DIRECT_CRASH_ACTION_ENV, action.as_env())
        .env(DIRECT_CRASH_ROOT_ENV, root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(marker) = marker {
        command.env(DIRECT_CRASH_MARKER_ENV, marker);
    }
    command.spawn().unwrap()
}

#[cfg(unix)]
fn run_direct_crash_child_action(
    action: DirectCrashAction,
    root: &Path,
    marker: Option<&Path>,
) -> Result<()> {
    match action {
        DirectCrashAction::CommittedWait => {
            let db = block_on(
                Oliphaunt::builder()
                    .path(root)
                    .native_direct()
                    .runtime(OliphauntRuntime::from_env())
                    .open(),
            )?;
            block_on(db.exec_protocol_raw(raw_query_message(
                "CREATE TABLE crash_consistency(value integer); \
                 INSERT INTO crash_consistency VALUES (1)",
            )))?;
            write_direct_crash_marker(marker);
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }
        DirectCrashAction::VerifyCommitted => {
            assert_direct_crash_values(root, &["1", "1"])?;
            Ok(())
        }
        DirectCrashAction::UncommittedWait => {
            let db = block_on(
                Oliphaunt::builder()
                    .path(root)
                    .native_direct()
                    .runtime(OliphauntRuntime::from_env())
                    .existing_only()
                    .open(),
            )?;
            block_on(db.exec_protocol_raw(raw_query_message(
                "BEGIN; INSERT INTO crash_consistency VALUES (2)",
            )))?;
            write_direct_crash_marker(marker);
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }
        DirectCrashAction::VerifyUncommitted => {
            assert_direct_crash_values(root, &["1", "1"])?;
            Ok(())
        }
    }
}

#[cfg(unix)]
fn write_direct_crash_marker(marker: Option<&Path>) {
    if let Some(marker) = marker {
        std::fs::write(marker, b"ready").unwrap();
    }
}

#[cfg(unix)]
fn assert_direct_crash_values(root: &Path, expected: &[&str]) -> Result<()> {
    let db = block_on(
        Oliphaunt::builder()
            .path(root)
            .native_direct()
            .runtime(OliphauntRuntime::from_env())
            .existing_only()
            .open(),
    )?;
    let response = block_on(db.exec_protocol_raw(raw_query_message(
        "SELECT count(*)::text, COALESCE(sum(value), 0)::text FROM crash_consistency",
    )))?;
    let values = first_data_row_text_values(response.as_bytes());
    let expected = expected
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    assert_eq!(values, expected);
    block_on(db.close())?;
    Ok(())
}

fn native_runtime_env_is_unavailable() -> bool {
    std::env::var_os("LIBOLIPHAUNT_PATH").is_none()
        || native_extension_is_unavailable(Extension::Vector)
}

fn native_extension_is_unavailable(extension: Extension) -> bool {
    let Some(install_dir) = native_install_dir() else {
        return true;
    };
    !install_dir
        .join("share/postgresql/extension")
        .join(format!("{}.control", extension.sql_name()))
        .is_file()
}

fn native_install_dir() -> Option<PathBuf> {
    if let Some(install_dir) = std::env::var_os("OLIPHAUNT_INSTALL_DIR").map(PathBuf::from) {
        return Some(install_dir);
    }
    if let Some(postgres) = std::env::var_os("OLIPHAUNT_POSTGRES").map(PathBuf::from)
        && let Some(bin_dir) = postgres.parent()
        && let Some(install_dir) = bin_dir.parent()
    {
        return Some(install_dir.to_path_buf());
    }
    let cwd = std::env::current_dir().ok()?;
    [
        cwd.join("target/liboliphaunt-pg18/install"),
        cwd.join("target/native-liboliphaunt-pg18/install"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

fn native_tool_path(tool: &str) -> Option<PathBuf> {
    for env_name in ["OLIPHAUNT_POSTGRES"] {
        if let Some(postgres) = std::env::var_os(env_name).map(PathBuf::from)
            && let Some(bin_dir) = postgres.parent()
        {
            let candidate = bin_dir.join(tool);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let cwd = std::env::current_dir().ok()?;
    [
        cwd.join("target/liboliphaunt-pg18/install/bin").join(tool),
        cwd.join("target/native-liboliphaunt-pg18/install/bin")
            .join(tool),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn native_broker_executable() -> Option<&'static str> {
    option_env!("CARGO_BIN_EXE_oliphaunt-broker")
}

fn assert_physical_archive(artifact: &oliphaunt::BackupArtifact, mode: &str) {
    assert_eq!(artifact.format, BackupFormat::PhysicalArchive);
    let mut archive = tar::Archive::new(Cursor::new(artifact.bytes.as_slice()));
    let mut names = archive
        .entries()
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    names.sort();
    assert!(
        names.iter().any(|name| name == "pgdata/PG_VERSION"),
        "{mode} physical archive is missing PG_VERSION"
    );
    assert!(
        names.iter().any(|name| name == "pgdata/backup_label"),
        "{mode} physical archive is missing backup_label"
    );
    assert!(
        names.iter().any(|name| name == "manifest.properties"),
        "{mode} physical archive is missing root manifest"
    );
    assert!(
        names
            .iter()
            .any(|name| name == ".oliphaunt/backup-manifest.properties"),
        "{mode} physical archive is missing backup manifest"
    );
    assert!(
        names.iter().any(|name| name.starts_with("pgdata/base/")),
        "{mode} physical archive is missing relation storage"
    );
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

fn raw_message_contains(bytes: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && bytes.windows(needle.len()).any(|window| window == needle)
}

fn assert_cancel_recovers(db: &Oliphaunt, recovered_value: i32) {
    let cancellable = db.clone();
    let cancel_worker = thread::spawn(move || {
        block_on(
            cancellable.exec_protocol_raw(raw_query_message("SELECT pg_sleep(5) AS should_cancel")),
        )
        .unwrap()
    });
    thread::sleep(Duration::from_millis(100));
    db.cancel().unwrap();
    let cancelled = cancel_worker.join().unwrap();
    let tags = raw_message_tags(cancelled.as_bytes());
    assert!(tags.contains(&b'E'), "missing ErrorResponse: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");
    assert!(
        raw_message_contains(
            cancelled.as_bytes(),
            b"canceling statement due to user request"
        ),
        "cancel response did not include the PostgreSQL cancellation message"
    );

    let sql = format!("SELECT {recovered_value}::text AS recovered_after_cancel");
    let recovered = block_on(db.exec_protocol_raw(raw_query_message(&sql))).unwrap();
    assert_eq!(
        first_data_row_text_values(recovered.as_bytes()),
        vec![recovered_value.to_string()]
    );
}

fn assert_repeated_cancel_recovers(db: &Oliphaunt, first_recovered_value: i32) {
    for offset in 0..3 {
        assert_cancel_recovers(db, first_recovered_value + offset);
    }
}

fn assert_broker_cancel_reuses_helper(db: &Oliphaunt, first_recovered_value: i32) {
    let helper_pid_before = first_data_row_text_values(
        block_on(db.exec_protocol_raw(raw_query_message("SELECT pg_backend_pid()::text")))
            .unwrap()
            .as_bytes(),
    );
    assert_eq!(
        helper_pid_before.len(),
        1,
        "broker backend pid probe returned unexpected rows"
    );

    assert_repeated_cancel_recovers(db, first_recovered_value);

    let helper_pid_after = first_data_row_text_values(
        block_on(db.exec_protocol_raw(raw_query_message("SELECT pg_backend_pid()::text")))
            .unwrap()
            .as_bytes(),
    );
    assert_eq!(
        helper_pid_after, helper_pid_before,
        "broker helper/backend identity changed after cancellation"
    );
}

fn assert_streaming_cancel_recovers(db: &Oliphaunt, recovered_value: i32) {
    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_for_callback = Arc::clone(&streamed);
    let active = db.clone();
    let worker = thread::spawn(move || {
        block_on(active.exec_protocol_raw_stream(
            raw_query_message("SELECT pg_sleep(5), repeat('x', 1048576) AS should_cancel_stream"),
            move |chunk| {
                streamed_for_callback
                    .lock()
                    .unwrap()
                    .extend_from_slice(chunk);
                Ok(())
            },
        ))
    });

    thread::sleep(Duration::from_millis(100));
    db.cancel().unwrap();
    worker.join().unwrap().unwrap();

    let bytes = streamed.lock().unwrap();
    let tags = raw_message_tags(&bytes);
    assert!(
        tags.contains(&b'E'),
        "missing streaming ErrorResponse: {tags:?}"
    );
    assert!(
        tags.contains(&b'Z'),
        "missing streaming ReadyForQuery: {tags:?}"
    );
    assert!(
        raw_message_contains(&bytes, b"canceling statement due to user request"),
        "streaming cancel response did not include the PostgreSQL cancellation message"
    );
    drop(bytes);

    let sql = format!("SELECT {recovered_value}::text AS recovered_after_stream_cancel");
    let recovered = block_on(db.exec_protocol_raw(raw_query_message(&sql))).unwrap();
    assert_eq!(
        first_data_row_text_values(recovered.as_bytes()),
        vec![recovered_value.to_string()]
    );
}

fn assert_close_waits_for_active_query(db: &Oliphaunt) {
    let active = db.clone();
    let worker = thread::spawn(move || {
        block_on(active.exec_protocol_raw(raw_query_message(
            "SELECT pg_sleep(0.1) AS should_finish_before_close",
        )))
    });
    thread::sleep(Duration::from_millis(25));
    block_on(db.close()).unwrap();

    let finished = worker.join().unwrap().unwrap();
    let tags = raw_message_tags(finished.as_bytes());
    assert!(
        tags.contains(&b'D'),
        "close must wait for active query success, got tags: {tags:?}"
    );
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");
    assert_eq!(
        block_on(db.execute("SELECT after close")).unwrap_err(),
        Error::EngineStopped
    );
}

fn first_data_row_text_values(mut bytes: &[u8]) -> Vec<String> {
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
        if tag == b'D' {
            return parse_data_row_text_values(&bytes[5..total]);
        }
        bytes = &bytes[total..];
    }
    Vec::new()
}

fn parse_data_row_text_values(payload: &[u8]) -> Vec<String> {
    if payload.len() < 2 {
        return Vec::new();
    }
    let columns = i16::from_be_bytes([payload[0], payload[1]]);
    if columns < 0 {
        return Vec::new();
    }
    let mut offset = 2;
    let mut values = Vec::with_capacity(columns as usize);
    for _ in 0..columns {
        if payload.len().saturating_sub(offset) < 4 {
            return Vec::new();
        }
        let len = i32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]);
        offset += 4;
        if len == -1 {
            values.push("NULL".to_owned());
            continue;
        }
        if len < 0 {
            return Vec::new();
        }
        let len = len as usize;
        if payload.len().saturating_sub(offset) < len {
            return Vec::new();
        }
        values.push(String::from_utf8_lossy(&payload[offset..offset + len]).into_owned());
        offset += len;
    }
    values
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

fn expect_open_error(result: Result<Oliphaunt>) -> Error {
    match result {
        Ok(_) => panic!("expected open to fail"),
        Err(error) => error,
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
