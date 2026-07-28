use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::Duration;

use oliphaunt::{
    BackupArtifact, BackupFormat, BenchmarkMetric, BenchmarkTarget, EngineCapabilities, EngineMode,
    EngineSession, Error, Extension, NativeBrokerRuntime, NativeRuntime, NativeServerRuntime,
    Oliphaunt, OliphauntRuntime, PerformanceGateSet, RestoreRequest, Result,
    RuntimeFootprintProfile, SessionConcurrency, SessionPin, Transaction,
};
use serde::Deserialize;

#[test]
fn config_is_native_only_and_extensions_are_explicit() {
    let config = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .username("app_user")
        .database("app_db")
        .extension(Extension::Vector)
        .build_config()
        .unwrap();

    assert_eq!(config.mode, EngineMode::NativeDirect);
    assert_eq!(config.username, "app_user");
    assert_eq!(config.database, "app_db");
    assert_eq!(config.extensions, vec![Extension::Vector]);
    assert_eq!(
        config.durability.postgres_gucs(),
        &[
            ("fsync", "on"),
            ("full_page_writes", "on"),
            ("synchronous_commit", "on"),
        ]
    );
}

#[test]
fn open_config_validation_resolves_extension_dependencies_before_runtime_selection() {
    let config = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .extension(Extension::Earthdistance)
        .build_config()
        .unwrap();

    assert_eq!(
        config.resolved_extensions().unwrap(),
        vec![Extension::Cube, Extension::Earthdistance]
    );
}

#[test]
fn config_rejects_invalid_connection_identity() {
    let username_error = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .username(" \n")
        .build_config()
        .unwrap_err();
    assert_eq!(
        username_error,
        Error::InvalidConfig("username must not be empty".to_owned())
    );

    let database_error = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .database("app\0db")
        .build_config()
        .unwrap_err();
    assert_eq!(
        database_error,
        Error::InvalidConfig("database must not contain NUL bytes".to_owned())
    );
}

#[test]
fn rust_handle_types_are_thread_safe_shared_executor_handles() {
    fn assert_clone_send_sync_static<T: Clone + Send + Sync + 'static>() {}
    fn assert_send_static<T: Send + 'static>() {}

    assert_clone_send_sync_static::<Oliphaunt>();
    assert_send_static::<SessionPin>();
    assert_send_static::<Transaction>();
}

#[test]
fn runtime_footprint_profiles_define_the_mobile_pg18_startup_contract() {
    assert_eq!(
        RuntimeFootprintProfile::Throughput.postgres_gucs(),
        &[
            ("shared_buffers", "128MB"),
            ("wal_buffers", "4MB"),
            ("min_wal_size", "80MB"),
        ]
    );
    assert_eq!(
        RuntimeFootprintProfile::BalancedMobile.postgres_gucs(),
        &[
            ("max_connections", "1"),
            ("superuser_reserved_connections", "0"),
            ("reserved_connections", "0"),
            ("autovacuum_worker_slots", "1"),
            ("max_wal_senders", "0"),
            ("max_replication_slots", "0"),
            ("shared_buffers", "32MB"),
            ("wal_buffers", "-1"),
            ("min_wal_size", "32MB"),
            ("max_wal_size", "64MB"),
            ("io_method", "sync"),
            ("io_max_concurrency", "1"),
        ]
    );
    assert_eq!(
        RuntimeFootprintProfile::SmallMobile.postgres_gucs(),
        &[
            ("max_connections", "1"),
            ("superuser_reserved_connections", "0"),
            ("reserved_connections", "0"),
            ("autovacuum_worker_slots", "1"),
            ("max_wal_senders", "0"),
            ("max_replication_slots", "0"),
            ("shared_buffers", "8MB"),
            ("wal_buffers", "256kB"),
            ("min_wal_size", "32MB"),
            ("max_wal_size", "64MB"),
            ("work_mem", "1MB"),
            ("maintenance_work_mem", "16MB"),
            ("io_method", "sync"),
            ("io_max_concurrency", "1"),
        ]
    );
}

#[test]
fn open_config_rejects_empty_persistent_root_before_runtime_selection() {
    let error = Oliphaunt::builder().path("").build_config().unwrap_err();
    assert_eq!(
        error,
        Error::InvalidConfig("database root must not be empty".to_owned())
    );
}

#[test]
fn open_config_rejects_nul_persistent_root_before_runtime_selection() {
    let error = Oliphaunt::builder()
        .path("target/test-roots/native\0direct")
        .build_config()
        .unwrap_err();
    assert_eq!(
        error,
        Error::InvalidConfig("database root must not contain NUL bytes".to_owned())
    );
}

#[test]
fn restore_rejects_nul_target_root_before_archive_unpack() {
    let error = block_on(Oliphaunt::restore(RestoreRequest::physical_archive(
        "target/test-roots/native\0restore",
        BackupArtifact {
            format: BackupFormat::PhysicalArchive,
            bytes: Vec::new(),
        },
    )))
    .unwrap_err();
    assert_eq!(
        error,
        Error::Engine("restore target root must not contain NUL bytes".to_owned())
    );
}

#[test]
fn tooling_and_runtime_executable_paths_are_validated_before_startup() {
    let initdb_empty = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .initdb_tooling_only("")
        .build_config()
        .unwrap_err();
    assert_eq!(
        initdb_empty,
        Error::InvalidConfig("initdb path must not be empty".to_owned())
    );

    let initdb_nul = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .initdb_tooling_only("target/native\0initdb")
        .build_config()
        .unwrap_err();
    assert_eq!(
        initdb_nul,
        Error::InvalidConfig("initdb path must not contain NUL bytes".to_owned())
    );

    let broker_empty = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .broker_executable("")
        .build_config()
        .unwrap_err();
    assert_eq!(
        broker_empty,
        Error::InvalidConfig("native broker executable path must not be empty".to_owned())
    );

    let broker_nul = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .broker_executable("target/native\0broker")
        .build_config()
        .unwrap_err();
    assert_eq!(
        broker_nul,
        Error::InvalidConfig("native broker executable path must not contain NUL bytes".to_owned())
    );

    let server_empty = Oliphaunt::builder()
        .path("target/test-roots/native-server")
        .native_server()
        .server_executable("")
        .build_config()
        .unwrap_err();
    assert_eq!(
        server_empty,
        Error::InvalidConfig("native server executable path must not be empty".to_owned())
    );

    let server_nul = Oliphaunt::builder()
        .path("target/test-roots/native-server")
        .native_server()
        .server_executable("target/native\0postgres")
        .build_config()
        .unwrap_err();
    assert_eq!(
        server_nul,
        Error::InvalidConfig("native server executable path must not contain NUL bytes".to_owned())
    );
}

#[test]
fn direct_mode_rejects_fake_multi_session_pools() {
    let zero = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .native_direct()
        .max_client_sessions(0)
        .build_config()
        .unwrap_err();
    assert_eq!(
        zero,
        Error::InvalidConfig("native direct max_client_sessions must be exactly 1".to_owned())
    );

    let error = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .native_direct()
        .max_client_sessions(2)
        .build_config()
        .unwrap_err();

    assert_eq!(
        error,
        Error::UnsupportedClientSessions {
            mode: EngineMode::NativeDirect,
            requested: 2,
            supported: 1,
        }
    );
}

#[test]
fn broker_mode_rejects_fake_multi_session_pools() {
    let zero = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .max_client_sessions(0)
        .build_config()
        .unwrap_err();
    assert_eq!(
        zero,
        Error::InvalidConfig("native broker max_client_sessions must be exactly 1".to_owned())
    );

    let error = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .max_client_sessions(2)
        .build_config()
        .unwrap_err();

    assert_eq!(
        error,
        Error::UnsupportedClientSessions {
            mode: EngineMode::NativeBroker,
            requested: 2,
            supported: 1,
        }
    );
}

#[test]
fn server_mode_advertises_true_independent_sessions() {
    assert!(!EngineCapabilities::for_mode(EngineMode::NativeDirect).connection_strings);
    assert!(!EngineCapabilities::for_mode(EngineMode::NativeBroker).connection_strings);

    let config = Oliphaunt::builder()
        .path("target/test-roots/native-server")
        .native_server()
        .max_client_sessions(16)
        .build_config()
        .unwrap();

    let capabilities = EngineCapabilities::for_mode(config.mode);
    assert_eq!(
        capabilities.session_concurrency,
        SessionConcurrency::IndependentSessions
    );
    assert!(capabilities.connection_strings);
    assert_eq!(capabilities.connection_string, None);
    assert_eq!(config.server.max_client_sessions, 16);
}

#[test]
fn direct_broker_server_lifecycle_capabilities_are_honest() {
    let direct = EngineCapabilities::for_mode(EngineMode::NativeDirect);
    assert_eq!(direct.mode, EngineMode::NativeDirect);
    assert_eq!(
        direct.session_concurrency,
        SessionConcurrency::SerializedSingleSession
    );
    assert!(!direct.process_isolated);
    assert!(!direct.multi_root);
    assert!(direct.reopenable);
    assert!(direct.same_root_logical_reopen);
    assert!(!direct.root_switchable);
    assert!(!direct.crash_restartable);
    assert_eq!(direct.max_client_sessions, 1);
    assert!(!direct.connection_strings);
    assert_eq!(direct.connection_string, None);

    let broker = EngineCapabilities::for_mode(EngineMode::NativeBroker);
    assert_eq!(broker.mode, EngineMode::NativeBroker);
    assert_eq!(
        broker.session_concurrency,
        SessionConcurrency::SerializedSingleSession
    );
    assert!(broker.process_isolated);
    assert!(broker.multi_root);
    assert!(broker.reopenable);
    assert!(!broker.same_root_logical_reopen);
    assert!(broker.root_switchable);
    assert!(broker.crash_restartable);
    assert_eq!(broker.max_client_sessions, 1);
    assert!(!broker.connection_strings);
    assert_eq!(broker.connection_string, None);

    let server = EngineCapabilities::for_mode(EngineMode::NativeServer);
    assert_eq!(server.mode, EngineMode::NativeServer);
    assert_eq!(
        server.session_concurrency,
        SessionConcurrency::IndependentSessions
    );
    assert!(server.process_isolated);
    assert!(!server.multi_root);
    assert!(server.reopenable);
    assert!(!server.same_root_logical_reopen);
    assert!(server.root_switchable);
    assert!(!server.crash_restartable);
    assert_eq!(server.max_client_sessions, 32);
    assert!(server.connection_strings);
    assert_eq!(server.connection_string, None);
}

#[test]
fn broker_and_server_modes_select_process_isolated_defaults() {
    let broker_config = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .build_config()
        .unwrap();
    assert_eq!(broker_config.mode, EngineMode::NativeBroker);
    assert_eq!(broker_config.broker.max_client_sessions, 1);
    assert_eq!(broker_config.broker.max_roots, 1);
    let broker_capabilities = EngineCapabilities::for_mode(EngineMode::NativeBroker);
    assert!(broker_capabilities.multi_root);
    assert!(broker_capabilities.root_switchable);
    assert!(broker_capabilities.crash_restartable);

    let server_config = Oliphaunt::builder()
        .path("target/test-roots/native-server")
        .native_server()
        .server_port(55432)
        .build_config()
        .unwrap();
    assert_eq!(server_config.mode, EngineMode::NativeServer);
    assert_eq!(server_config.server.port, Some(55432));
    let server_capabilities = EngineCapabilities::for_mode(EngineMode::NativeServer);
    assert!(server_capabilities.root_switchable);
    assert!(!server_capabilities.crash_restartable);
}

#[test]
fn direct_mode_advertises_resident_single_root_lifecycle() {
    let capabilities = EngineCapabilities::for_mode(EngineMode::NativeDirect);

    assert!(capabilities.reopenable);
    assert!(capabilities.same_root_logical_reopen);
    assert!(!capabilities.root_switchable);
    assert!(!capabilities.crash_restartable);
    assert!(!capabilities.process_isolated);
    assert_eq!(capabilities.max_client_sessions, 1);
    assert_eq!(
        capabilities.session_concurrency,
        SessionConcurrency::SerializedSingleSession
    );
}

#[test]
fn broker_accepts_supervised_multi_root_configuration() {
    let config = Oliphaunt::builder()
        .path("target/test-roots/native-broker")
        .native_broker()
        .broker_max_roots(2)
        .build_config()
        .unwrap();

    assert_eq!(config.broker.max_roots, 2);
    let runtime = NativeBrokerRuntime::from_config(&config.broker);
    assert_eq!(runtime.max_roots(), 2);
}

#[test]
fn broker_and_server_runtimes_are_mode_specific() {
    let broker_error = expect_open_error(block_on(
        Oliphaunt::builder()
            .native_direct()
            .path("target/test-roots/wrong-broker-mode")
            .runtime(NativeBrokerRuntime::from_package())
            .open(),
    ));
    assert!(matches!(
        broker_error,
        Error::UnsupportedEngineMode {
            mode: EngineMode::NativeDirect,
            ..
        }
    ));

    let server_error = expect_open_error(block_on(
        Oliphaunt::builder()
            .native_broker()
            .path("target/test-roots/wrong-server-mode")
            .runtime(NativeServerRuntime::from_package())
            .open(),
    ));
    assert!(matches!(
        server_error,
        Error::UnsupportedEngineMode {
            mode: EngineMode::NativeBroker,
            ..
        }
    ));
}

#[test]
fn concrete_runtimes_validate_configs_before_external_startup() {
    let mut direct_config =
        oliphaunt::OpenConfig::native_direct("target/test-roots/direct-runtime-validation");
    direct_config.direct.max_client_sessions = 2;
    let direct_error = expect_runtime_open_error(OliphauntRuntime::from_env().open(direct_config));
    assert_eq!(
        direct_error,
        Error::UnsupportedClientSessions {
            mode: EngineMode::NativeDirect,
            requested: 2,
            supported: 1,
        }
    );

    let mut broker_config =
        oliphaunt::OpenConfig::native_direct("target/test-roots/broker-runtime-mode-validation");
    broker_config.direct.max_client_sessions = 2;
    let broker_error =
        expect_runtime_open_error(NativeBrokerRuntime::from_package().open(broker_config));
    assert!(matches!(
        broker_error,
        Error::UnsupportedEngineMode {
            mode: EngineMode::NativeDirect,
            ..
        }
    ));

    let mut server_config =
        oliphaunt::OpenConfig::native_direct("target/test-roots/server-runtime-validation");
    server_config.mode = EngineMode::NativeServer;
    server_config.server.port = Some(0);
    let server_error =
        expect_runtime_open_error(NativeServerRuntime::from_package().open(server_config));
    assert_eq!(
        server_error,
        Error::InvalidConfig(
            "native server port must be greater than zero; omit the port to allocate one"
                .to_owned()
        )
    );
}

#[test]
fn performance_contract_is_native_direct_first() {
    let gates = PerformanceGateSet::native_direct_release_baseline();
    assert!(gates.gates.iter().any(|gate| {
        gate.target == BenchmarkTarget::NativeDirect && gate.metric == BenchmarkMetric::WarmOpen
    }));
    assert!(gates.gates.iter().any(|gate| {
        gate.target == BenchmarkTarget::NativeDirect
            && gate.metric == BenchmarkMetric::SimpleQueryRtt
    }));
}

#[test]
fn native_modes_advertise_core_sdk_capabilities() {
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).protocol_stream);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeBroker).protocol_stream);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeServer).protocol_stream);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).query_cancel);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeBroker).query_cancel);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeServer).query_cancel);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).backup_restore);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeBroker).backup_restore);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeServer).backup_restore);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).simple_query);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeBroker).simple_query);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeServer).simple_query);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).reopenable);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeBroker).reopenable);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeServer).reopenable);
    assert!(EngineCapabilities::for_mode(EngineMode::NativeDirect).same_root_logical_reopen);
    assert!(!EngineCapabilities::for_mode(EngineMode::NativeBroker).same_root_logical_reopen);
    assert!(!EngineCapabilities::for_mode(EngineMode::NativeServer).same_root_logical_reopen);
    assert_eq!(
        EngineCapabilities::for_mode(EngineMode::NativeDirect).backup_formats,
        vec![BackupFormat::PhysicalArchive]
    );
    assert_eq!(
        EngineCapabilities::for_mode(EngineMode::NativeBroker).backup_formats,
        vec![BackupFormat::PhysicalArchive]
    );
    assert_eq!(
        EngineCapabilities::for_mode(EngineMode::NativeServer).backup_formats,
        vec![BackupFormat::Sql, BackupFormat::PhysicalArchive]
    );
    assert_eq!(
        EngineCapabilities::for_mode(EngineMode::NativeServer).restore_formats,
        vec![BackupFormat::PhysicalArchive]
    );
    assert!(
        EngineCapabilities::for_mode(EngineMode::NativeDirect)
            .supports_backup_format(BackupFormat::PhysicalArchive)
    );
    assert!(
        !EngineCapabilities::for_mode(EngineMode::NativeDirect)
            .supports_backup_format(BackupFormat::Sql)
    );
    assert!(
        EngineCapabilities::for_mode(EngineMode::NativeServer)
            .supports_backup_format(BackupFormat::Sql)
    );
    assert!(
        EngineCapabilities::for_mode(EngineMode::NativeServer)
            .supports_restore_format(BackupFormat::PhysicalArchive)
    );
    assert!(
        !EngineCapabilities::for_mode(EngineMode::NativeServer)
            .supports_restore_format(BackupFormat::Sql)
    );
}

#[test]
fn rust_sdk_mode_support_is_explicit_and_complete() {
    let support = EngineCapabilities::rust_sdk_support();
    assert_eq!(support.len(), EngineMode::all().len());
    assert_eq!(
        support.iter().map(|entry| entry.mode).collect::<Vec<_>>(),
        EngineMode::all().to_vec()
    );
    assert!(support.iter().all(|entry| entry.available));
    assert!(
        support
            .iter()
            .all(|entry| entry.unavailable_reason.is_none())
    );
    assert_eq!(
        support
            .iter()
            .map(|entry| entry.capabilities.mode)
            .collect::<Vec<_>>(),
        EngineMode::all().to_vec()
    );
}

#[test]
fn shared_sdk_capability_fixture_matches_rust_support() {
    // Staged from src/shared/fixtures/sdk-capabilities/mode-support.json so the
    // published-source test remains hermetic while proving the shared contract.
    let fixture: SharedCapabilityFixture =
        serde_json::from_str(include_str!("fixtures/sdk-mode-support.json"))
            .expect("parse shared SDK capability fixture");
    let support = EngineCapabilities::rust_sdk_support();

    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.kind, "oliphaunt-sdk-capability-expectations");
    assert_eq!(fixture.modes.len(), support.len());

    for expected in fixture.modes {
        let mode = parse_engine_mode(&expected.engine);
        let actual = support
            .iter()
            .find(|entry| entry.mode == mode)
            .unwrap_or_else(|| panic!("missing Rust mode support for {}", expected.engine));

        assert_eq!(
            actual.available, expected.available_by_default.rust,
            "{} Rust availability",
            expected.engine
        );
        assert_eq!(
            actual.capabilities.session_concurrency == SessionConcurrency::IndependentSessions,
            expected.capabilities.independent_sessions,
            "{} independent session support",
            expected.engine
        );
        assert_eq!(
            actual.capabilities.process_isolated, expected.capabilities.process_isolated,
            "{} process isolation",
            expected.engine
        );
        if let Some(max_client_sessions) = expected.capabilities.max_client_sessions {
            assert_eq!(
                actual.capabilities.max_client_sessions, max_client_sessions as usize,
                "{} max client sessions",
                expected.engine
            );
        }
        assert_eq!(
            actual.capabilities.backup_formats,
            parse_backup_formats(&expected.capabilities.backup_formats),
            "{} backup formats",
            expected.engine
        );
        assert_eq!(
            actual.capabilities.restore_formats,
            parse_backup_formats(&expected.capabilities.restore_formats),
            "{} restore formats",
            expected.engine
        );
    }
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

fn expect_runtime_open_error(result: Result<Box<dyn EngineSession>>) -> Error {
    match result {
        Ok(_) => panic!("expected runtime open to fail"),
        Err(error) => error,
    }
}

struct ThreadWaker(thread::Thread);

#[derive(Deserialize)]
struct SharedCapabilityFixture {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    kind: String,
    modes: Vec<SharedModeExpectation>,
}

#[derive(Deserialize)]
struct SharedModeExpectation {
    engine: String,
    #[serde(rename = "availableByDefault")]
    available_by_default: SharedModeAvailability,
    capabilities: SharedModeCapabilities,
}

#[derive(Deserialize)]
struct SharedModeAvailability {
    rust: bool,
}

#[derive(Deserialize)]
struct SharedModeCapabilities {
    #[serde(rename = "maxClientSessions")]
    max_client_sessions: Option<u32>,
    #[serde(rename = "independentSessions")]
    independent_sessions: bool,
    #[serde(rename = "processIsolated")]
    process_isolated: bool,
    #[serde(rename = "backupFormats")]
    backup_formats: Vec<String>,
    #[serde(rename = "restoreFormats")]
    restore_formats: Vec<String>,
}

fn parse_engine_mode(mode: &str) -> EngineMode {
    match mode {
        "nativeDirect" => EngineMode::NativeDirect,
        "nativeBroker" => EngineMode::NativeBroker,
        "nativeServer" => EngineMode::NativeServer,
        other => panic!("unknown shared SDK capability mode {other}"),
    }
}

fn parse_backup_formats(formats: &[String]) -> Vec<BackupFormat> {
    formats
        .iter()
        .map(|format| match format.as_str() {
            "sql" => BackupFormat::Sql,
            "physicalArchive" => BackupFormat::PhysicalArchive,
            "oliphauntArchive" => BackupFormat::OliphauntArchive,
            other => panic!("unknown shared backup format {other}"),
        })
        .collect()
}

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
