use super::*;

pub(super) fn parse_native_durability(value: &str) -> Result<NativeDurabilityProfile> {
    match value {
        "safe" => Ok(NativeDurabilityProfile::Safe),
        "balanced" => Ok(NativeDurabilityProfile::Balanced),
        "fast-dev" | "fast_dev" | "fast" => Ok(NativeDurabilityProfile::FastDev),
        other => bail!("unknown durability profile {other:?}; use safe, balanced, or fast-dev"),
    }
}

pub(super) fn parse_runtime_footprint(value: &str) -> Result<RuntimeFootprintProfile> {
    match value {
        "throughput" => Ok(RuntimeFootprintProfile::Throughput),
        "balanced-mobile" | "balanced_mobile" | "balancedMobile" => {
            Ok(RuntimeFootprintProfile::BalancedMobile)
        }
        "small-mobile" | "small_mobile" | "smallMobile" => Ok(RuntimeFootprintProfile::SmallMobile),
        other => bail!(
            "unknown runtime footprint profile {other:?}; use throughput, balanced-mobile, or small-mobile"
        ),
    }
}

pub(super) fn parse_startup_guc(value: &str) -> Result<PostgresStartupGuc> {
    let (name, guc_value) = value
        .split_once('=')
        .ok_or_else(|| anyhow!("startup GUC must be formatted as name=value"))?;
    let name = name.trim();
    ensure!(!name.is_empty(), "startup GUC name must not be empty");
    ensure!(
        name.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.')),
        "startup GUC name {name:?} must contain only ASCII letters, digits, '_' or '.'"
    );
    ensure!(
        !guc_value.trim().is_empty(),
        "startup GUC {name:?} value must not be empty"
    );
    ensure!(
        !name.as_bytes().contains(&0) && !guc_value.as_bytes().contains(&0),
        "startup GUC must not contain NUL bytes"
    );
    Ok(PostgresStartupGuc::new(name, guc_value))
}

pub(super) fn native_durability_arg(durability: NativeDurabilityProfile) -> &'static str {
    match durability {
        NativeDurabilityProfile::Safe => "safe",
        NativeDurabilityProfile::Balanced => "balanced",
        NativeDurabilityProfile::FastDev => "fast-dev",
    }
}

pub(super) const BACKUP_RESTORE_EXPECTED_ROWS: usize = 5_000;
pub(super) const NATIVE_POSTGRES_PHYSICAL_BACKUP_LABEL: &str =
    "oliphaunt native postgres physical control";
pub(super) const NATIVE_POSTGRES_PHYSICAL_TRANSIENT_CONTENT_DIRS: &[&str] = &[
    "pg_dynshmem",
    "pg_notify",
    "pg_serial",
    "pg_snapshots",
    "pg_stat_tmp",
    "pg_subtrans",
];

pub(super) fn backup_restore_setup_sql() -> String {
    format!(
        "DROP TABLE IF EXISTS backup_restore_items;\
         CREATE TABLE backup_restore_items(id integer PRIMARY KEY, payload text NOT NULL);\
         INSERT INTO backup_restore_items \
         SELECT i, repeat(md5(i::text), 8) FROM generate_series(1, {BACKUP_RESTORE_EXPECTED_ROWS}) AS i"
    )
}

pub(super) fn sqlite_backup_restore_setup_sql() -> String {
    let mut sql = String::from(
        "DROP TABLE IF EXISTS backup_restore_items;\
         CREATE TABLE backup_restore_items(id integer PRIMARY KEY, payload text NOT NULL);\
         BEGIN;",
    );
    for id in 1..=BACKUP_RESTORE_EXPECTED_ROWS {
        sql.push_str("INSERT INTO backup_restore_items(id, payload) VALUES (");
        sql.push_str(&id.to_string());
        sql.push_str(", '");
        sql.push_str(&format!("{id:032x}").repeat(8));
        sql.push_str("');");
    }
    sql.push_str("COMMIT;");
    sql
}

pub(super) fn fmt_bytes_label(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.2} MiB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.2} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

pub(super) fn ensure_protocol_response_ok(response: &[u8]) -> Result<()> {
    let mut off = 0usize;
    let mut ready = false;
    while off + 5 <= response.len() {
        let tag = response[off];
        let len = u32::from_be_bytes([
            response[off + 1],
            response[off + 2],
            response[off + 3],
            response[off + 4],
        ]) as usize;
        ensure!(len >= 4, "invalid backend message length {len}");
        let frame_len = 1 + len;
        ensure!(
            frame_len <= response.len() - off,
            "truncated backend message tag {} length {len}",
            tag as char
        );
        ensure!(tag != b'E', "backend returned ErrorResponse");
        ready |= tag == b'Z';
        off += frame_len;
    }
    ensure!(off == response.len(), "trailing bytes in backend response");
    ensure!(ready, "backend response did not include ReadyForQuery");
    Ok(())
}

pub(super) fn pg_query(sql: &str) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, sql);
    pg_frame(b'Q', &body)
}

pub(super) fn pg_parse(name: Option<&str>, sql: &str, types: &[i32]) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, name.unwrap_or(""));
    push_cstr(&mut body, sql);
    push_i16(&mut body, types.len() as i16);
    for oid in types {
        push_i32(&mut body, *oid);
    }
    pg_frame(b'P', &body)
}

pub(super) fn pg_bind(portal: Option<&str>, statement: &str, values: &[String; 2]) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, portal.unwrap_or(""));
    push_cstr(&mut body, statement);
    push_i16(&mut body, values.len() as i16);
    for _ in values {
        push_i16(&mut body, 0);
    }
    push_i16(&mut body, values.len() as i16);
    for value in values {
        push_i32(&mut body, value.len() as i32);
        body.extend_from_slice(value.as_bytes());
    }
    push_i16(&mut body, 0);
    pg_frame(b'B', &body)
}

pub(super) fn pg_execute(portal: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    push_cstr(&mut body, portal.unwrap_or(""));
    push_i32(&mut body, 0);
    pg_frame(b'E', &body)
}

pub(super) fn pg_describe(target_type: u8, name: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    body.push(target_type);
    push_cstr(&mut body, name.unwrap_or(""));
    pg_frame(b'D', &body)
}

pub(super) fn pg_close(target_type: u8, name: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    body.push(target_type);
    push_cstr(&mut body, name.unwrap_or(""));
    pg_frame(b'C', &body)
}

pub(super) fn pg_sync() -> Vec<u8> {
    pg_frame(b'S', &[])
}

fn pg_frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 4 + body.len());
    out.push(tag);
    out.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

pub(super) fn push_cstr(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn push_i16(out: &mut Vec<u8>, value: i16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_be_bytes());
}
