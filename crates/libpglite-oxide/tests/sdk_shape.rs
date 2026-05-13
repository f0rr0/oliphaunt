use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::Duration;

use libpglite_oxide::{
    BenchmarkMetric, BenchmarkTarget, EngineCapabilities, EngineMode, EngineSession, Error,
    ExtensionPack, LibPgliteRuntime, NativeBrokerRuntime, NativeRuntime, NativeServerRuntime,
    PerformanceGateSet, Pglite, ProtocolRequest, ProtocolResponse, Result, SessionConcurrency,
};

#[test]
fn config_is_native_only_and_extension_packs_are_explicit() {
    let config = Pglite::builder()
        .path("target/test-roots/native-direct")
        .extension_pack(ExtensionPack::vector())
        .build_config()
        .unwrap();

    assert_eq!(config.mode, EngineMode::NativeDirect);
    assert_eq!(config.extension_packs.len(), 1);
    assert_eq!(config.extension_packs[0].id.as_str(), "vector");
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
fn direct_mode_rejects_fake_multi_session_pools() {
    let error = Pglite::builder()
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
fn server_mode_advertises_true_independent_sessions() {
    let config = Pglite::builder()
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
}

#[test]
fn broker_and_server_runtimes_are_mode_specific() {
    let broker_error = expect_open_error(block_on(
        Pglite::builder()
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
        Pglite::builder()
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
fn cloned_handles_share_one_serial_owner_executor() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let db = block_on(
        Pglite::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::clone(&calls),
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
}

#[test]
fn raw_streaming_uses_the_same_owner_executor() {
    let db = block_on(
        Pglite::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
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
fn session_pin_prevents_unpinned_interleaving() {
    let db = block_on(
        Pglite::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
            })
            .open(),
    )
    .unwrap();

    let pin = block_on(db.pin_session()).unwrap();
    let error = block_on(db.exec_protocol_raw(vec![b'x'])).unwrap_err();
    assert_eq!(error, Error::SessionPinned);

    let pinned_response = block_on(pin.exec_protocol_raw(vec![b'p'])).unwrap();
    assert_eq!(pinned_response.into_bytes(), vec![1, b'p']);

    block_on(pin.release()).unwrap();
    let unpinned_response = block_on(db.exec_protocol_raw(vec![b'u'])).unwrap();
    assert_eq!(unpinned_response.into_bytes(), vec![2, b'u']);
}

#[test]
fn transaction_pins_and_releases_the_direct_session() {
    let db = block_on(
        Pglite::builder()
            .path("target/test-roots/native-direct")
            .runtime(MockRuntime {
                calls: Arc::new(Mutex::new(Vec::new())),
            })
            .open(),
    )
    .unwrap();

    let tx = block_on(db.transaction()).unwrap();
    let error = block_on(db.execute("SELECT outside")).unwrap_err();
    assert_eq!(error, Error::SessionPinned);
    block_on(tx.execute("SELECT inside")).unwrap();
    block_on(tx.commit()).unwrap();
    block_on(db.execute("SELECT after")).unwrap();
}

#[test]
fn native_libpglite_runtime_select_one_when_env_is_available() {
    if std::env::var_os("LIBPGLITE_OXIDE_LIBPGLITE")
        .or_else(|| std::env::var_os("PGLITE_NATIVE_LIBPGLITE"))
        .or_else(|| std::env::var_os("PGLITE_OXIDE_NATIVE_LIBPGLITE"))
        .is_none()
    {
        eprintln!("skipping native libpglite runtime smoke: no native library env var is set");
        return;
    }

    let db = block_on(
        Pglite::builder()
            .temporary()
            .runtime(LibPgliteRuntime::from_env())
            .open(),
    )
    .unwrap();
    let response = block_on(db.exec_protocol_raw(raw_query_message("SELECT 1 AS value"))).unwrap();
    let tags = raw_message_tags(response.as_bytes());
    assert!(tags.contains(&b'T'), "missing RowDescription: {tags:?}");
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'C'), "missing CommandComplete: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");
    block_on(db.close()).unwrap();
}

struct MockRuntime {
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl NativeRuntime for MockRuntime {
    fn open(&self, config: libpglite_oxide::OpenConfig) -> Result<Box<dyn EngineSession>> {
        Ok(Box::new(MockSession {
            mode: config.mode,
            calls: Arc::clone(&self.calls),
            count: 0,
        }))
    }
}

struct MockSession {
    mode: EngineMode,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    count: u8,
}

impl EngineSession for MockSession {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities::for_mode(self.mode)
    }

    fn exec_protocol_raw(&mut self, request: ProtocolRequest) -> Result<ProtocolResponse> {
        self.count += 1;
        let mut response = vec![self.count];
        response.extend_from_slice(request.as_bytes());
        self.calls.lock().unwrap().push(response.clone());
        Ok(ProtocolResponse::new(response))
    }
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

fn expect_open_error(result: Result<Pglite>) -> Error {
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
