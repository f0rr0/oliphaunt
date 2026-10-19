use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use liboliphaunt_native_bindings::{NativeConfig, NativeSession, ProtocolStreamOutcome};

fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}

#[test]
#[ignore = "requires a prepared native runtime via LIBOLIPHAUNT_PATH and OLIPHAUNT_INSTALL_DIR"]
fn incremental_sync_copy_and_stale_input() {
    std::env::var_os("LIBOLIPHAUNT_PATH").expect("LIBOLIPHAUNT_PATH is required");
    std::env::var_os("OLIPHAUNT_INSTALL_DIR").expect("OLIPHAUNT_INSTALL_DIR is required");
    let mut session = NativeSession::open(NativeConfig::default()).unwrap();
    let input = session.protocol_input().unwrap();
    assert_eq!(input.active_token().unwrap(), None);

    let mut request = frame(b'P', b"\0SELECT 42\0\0\0");
    request.extend(frame(b'B', b"\0\0\0\0\0\0\0\0"));
    request.extend(frame(b'E', b"\0\0\0\0\0"));
    request.extend(frame(b'H', b""));
    let mut response = Vec::new();
    let old_token = thread::scope(|scope| {
        let feeder = scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let token = loop {
                if let Some(token) = input.active_token().unwrap() {
                    break token;
                }
                assert!(Instant::now() < deadline, "stream did not start");
                thread::sleep(Duration::from_millis(1));
            };
            assert!(input.feed(token, b"malformed").is_err());
            while !input.feed(token, &frame(b'S', b"")).unwrap() {
                assert!(Instant::now() < deadline, "native input remained full");
                thread::sleep(Duration::from_millis(1));
            }
            token
        });
        assert!(matches!(
            session.exec_protocol_raw_stream::<liboliphaunt_native_bindings::Error>(
                &request,
                &mut |chunk| {
                    response.extend_from_slice(chunk);
                    Ok(())
                },
            ),
            ProtocolStreamOutcome::ReadyForQuery(Ok(()))
        ));
        feeder.join().unwrap()
    });
    assert!(response.windows(2).any(|bytes| bytes == b"42"));
    assert!(input.feed(old_token, &frame(b'S', b"")).is_err());

    session
        .exec_simple_query("CREATE TABLE input_copy(value integer)")
        .unwrap();
    let (copy_ready, ready) = mpsc::sync_channel(1);
    let copy = frame(b'Q', b"COPY input_copy FROM STDIN\0");
    thread::scope(|scope| {
        let input = &input;
        let feeder = scope.spawn(move || {
            ready
                .recv_timeout(Duration::from_secs(5))
                .expect("COPY input response");
            let token = input.active_token().unwrap().expect("active COPY stream");
            assert_ne!(token, old_token);
            assert!(input.feed(old_token, &frame(b'c', b"")).is_err());
            let mut data = frame(b'd', b"7\n8\n");
            data.extend(frame(b'c', b""));
            assert!(input.feed(token, &data).unwrap());
        });
        let mut notified = false;
        assert!(matches!(
            session.exec_protocol_raw_stream::<liboliphaunt_native_bindings::Error>(
                &copy,
                &mut |_| {
                    if !notified {
                        copy_ready.send(()).unwrap();
                        notified = true;
                    }
                    Ok(())
                },
            ),
            ProtocolStreamOutcome::ReadyForQuery(Ok(()))
        ));
        feeder.join().unwrap();
    });
    let rows = session
        .exec_simple_query("SELECT sum(value) FROM input_copy")
        .unwrap();
    assert!(String::from_utf8_lossy(&rows).contains("15"));
    session.close().unwrap();
    assert!(input.active_token().is_err());
    assert!(input.feed(old_token, &frame(b'S', b"")).is_err());
    session.close_terminal().unwrap();
}
