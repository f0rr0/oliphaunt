use pglite_oxide::{EngineKind, ExecProtocolOptions, Pglite};

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

#[test]
fn native_libpglite_raw_protocol_select_one() -> anyhow::Result<()> {
    if std::env::var_os("PGLITE_OXIDE_NATIVE_LIBPGLITE").is_none() {
        eprintln!("skipping native libpglite smoke: PGLITE_OXIDE_NATIVE_LIBPGLITE is not set");
        return Ok(());
    }

    let root = tempfile::tempdir()?;
    let mut db = Pglite::builder()
        .path(root.path())
        .engine(EngineKind::NativeLibPglite)
        .open()?;

    let capabilities = db.engine_capabilities();
    assert_eq!(capabilities.kind, EngineKind::NativeLibPglite);
    assert!(capabilities.protocol_raw);
    assert!(!capabilities.multi_instance);

    let response = db.exec_protocol_raw(
        &raw_query_message("SELECT 1 AS value"),
        ExecProtocolOptions::no_sync(),
    )?;
    let tags = raw_message_tags(&response);
    assert!(tags.contains(&b'T'), "missing RowDescription: {tags:?}");
    assert!(tags.contains(&b'D'), "missing DataRow: {tags:?}");
    assert!(tags.contains(&b'C'), "missing CommandComplete: {tags:?}");
    assert!(tags.contains(&b'Z'), "missing ReadyForQuery: {tags:?}");
    db.close()?;

    let reopen_result = Pglite::builder()
        .path(root.path())
        .engine(EngineKind::NativeLibPglite)
        .open();
    let reopen_error = match reopen_result {
        Ok(_) => anyhow::bail!("native libpglite should reject same-process reopen"),
        Err(error) => error,
    };
    assert!(
        reopen_error
            .to_string()
            .contains("process lifetime has already been used"),
        "unexpected reopen error: {reopen_error:#}"
    );
    Ok(())
}
