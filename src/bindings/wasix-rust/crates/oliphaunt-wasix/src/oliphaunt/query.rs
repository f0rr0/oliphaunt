use std::{fmt, str};

use anyhow::{Context, Result, anyhow, bail, ensure};

/// Structured PostgreSQL `ErrorResponse` decoded from backend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresError {
    /// Backend severity, such as `ERROR` or `FATAL`.
    pub severity: Option<String>,
    /// SQLSTATE code, such as `23505` for unique violations.
    pub sqlstate: Option<String>,
    /// Primary human-readable PostgreSQL error message.
    pub message: String,
    /// Optional detailed explanation from PostgreSQL.
    pub detail: Option<String>,
    /// Optional hint from PostgreSQL.
    pub hint: Option<String>,
    /// Optional source statement position.
    pub position: Option<String>,
    /// Optional context stack, exposed as `where` by PostgreSQL.
    pub where_: Option<String>,
    /// Optional schema name reported by PostgreSQL.
    pub schema_name: Option<String>,
    /// Optional table name reported by PostgreSQL.
    pub table_name: Option<String>,
    /// Optional column name reported by PostgreSQL.
    pub column_name: Option<String>,
    /// Optional data type name reported by PostgreSQL.
    pub data_type_name: Option<String>,
    /// Optional constraint name reported by PostgreSQL.
    pub constraint_name: Option<String>,
    /// Raw ErrorResponse fields in backend order.
    pub fields: Vec<PostgresErrorField>,
}

impl PostgresError {
    fn from_fields(fields: Vec<PostgresErrorField>) -> Self {
        Self {
            severity: error_field_value(&fields, b'V').or_else(|| error_field_value(&fields, b'S')),
            sqlstate: error_field_value(&fields, b'C'),
            message: error_field_value(&fields, b'M')
                .unwrap_or_else(|| "PostgreSQL ErrorResponse".to_owned()),
            detail: error_field_value(&fields, b'D'),
            hint: error_field_value(&fields, b'H'),
            position: error_field_value(&fields, b'P'),
            where_: error_field_value(&fields, b'W'),
            schema_name: error_field_value(&fields, b's'),
            table_name: error_field_value(&fields, b't'),
            column_name: error_field_value(&fields, b'c'),
            data_type_name: error_field_value(&fields, b'd'),
            constraint_name: error_field_value(&fields, b'n'),
            fields,
        }
    }
}

impl fmt::Display for PostgresError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.severity, &self.sqlstate) {
            (Some(severity), Some(sqlstate)) => {
                write!(f, "{severity} [{sqlstate}]: {}", self.message)
            }
            (Some(severity), None) => write!(f, "{severity}: {}", self.message),
            (None, Some(sqlstate)) => write!(f, "[{sqlstate}]: {}", self.message),
            (None, None) => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for PostgresError {}

/// One raw field from a PostgreSQL `ErrorResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresErrorField {
    /// Single-byte PostgreSQL field code.
    pub code: u8,
    /// Field value decoded as UTF-8.
    pub value: String,
}

fn error_field_value(fields: &[PostgresErrorField], code: u8) -> Option<String> {
    fields
        .iter()
        .find(|field| field.code == code)
        .map(|field| field.value.clone())
}

pub(crate) fn simple_query(sql: &str) -> Result<Vec<u8>> {
    ensure!(
        !sql.as_bytes().contains(&0),
        "simple query SQL must not contain NUL bytes"
    );
    let length = i32::try_from(
        sql.len()
            .checked_add(5)
            .context("protocol message length overflow")?,
    )
    .map_err(|_| anyhow!("protocol message too large"))?;
    let mut message = Vec::with_capacity(length as usize + 1);
    message.push(b'Q');
    message.extend_from_slice(&length.to_be_bytes());
    message.extend_from_slice(sql.as_bytes());
    message.push(0);
    Ok(message)
}

/// Parameter value for PostgreSQL extended-query execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryParam {
    Null,
    Text(String),
    Binary(Vec<u8>),
}

impl QueryParam {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    pub fn binary(value: impl Into<Vec<u8>>) -> Self {
        Self::Binary(value.into())
    }
}

impl From<&str> for QueryParam {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for QueryParam {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&String> for QueryParam {
    fn from(value: &String) -> Self {
        Self::Text(value.clone())
    }
}

macro_rules! text_param {
    ($($type:ty),* $(,)?) => {$(
        impl From<$type> for QueryParam {
            fn from(value: $type) -> Self {
                Self::Text(value.to_string())
            }
        }
    )*};
}

text_param!(i16, i32, i64, f32, f64);

impl From<bool> for QueryParam {
    fn from(value: bool) -> Self {
        Self::Text(if value { "true" } else { "false" }.to_owned())
    }
}

impl From<&[u8]> for QueryParam {
    fn from(value: &[u8]) -> Self {
        Self::Binary(value.to_vec())
    }
}

impl From<Vec<u8>> for QueryParam {
    fn from(value: Vec<u8>) -> Self {
        Self::Binary(value)
    }
}

impl<T> From<Option<T>> for QueryParam
where
    T: Into<QueryParam>,
{
    fn from(value: Option<T>) -> Self {
        value.map(Into::into).unwrap_or(Self::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    command_tag: Option<String>,
    row_count: Option<u64>,
}

impl CommandResult {
    pub fn command_tag(&self) -> Option<&str> {
        self.command_tag.as_deref()
    }

    pub fn row_count(&self) -> Option<u64> {
        self.row_count
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryResult {
    fields: Vec<QueryField>,
    rows: Vec<QueryRow>,
    command_tag: Option<String>,
    row_count: Option<u64>,
}

impl QueryResult {
    pub fn fields(&self) -> &[QueryField] {
        &self.fields
    }

    pub fn rows(&self) -> &[QueryRow] {
        &self.rows
    }

    pub fn command_tag(&self) -> Option<&str> {
        self.command_tag.as_deref()
    }

    pub fn row_count(&self) -> Option<u64> {
        self.row_count
    }

    pub fn field_index(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|field| field.name == name)
    }

    pub fn get_text(&self, row: usize, column: &str) -> crate::Result<Option<&str>> {
        crate::error::public_result(self.get_text_inner(row, column))
    }

    fn get_text_inner(&self, row: usize, column: &str) -> Result<Option<&str>> {
        let column = self
            .field_index(column)
            .ok_or_else(|| anyhow!("query result has no column named {column:?}"))?;
        let row = self
            .rows
            .get(row)
            .ok_or_else(|| anyhow!("query result has no row at index {row}"))?;
        row.text_inner(column)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryField {
    pub name: String,
    pub table_oid: u32,
    pub table_attribute: i16,
    pub type_oid: u32,
    pub type_size: i16,
    pub type_modifier: i32,
    pub format: QueryFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryFormat {
    Text,
    Binary,
    Other(i16),
}

impl From<i16> for QueryFormat {
    fn from(value: i16) -> Self {
        match value {
            0 => Self::Text,
            1 => Self::Binary,
            other => Self::Other(other),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryRow {
    values: Vec<Option<Vec<u8>>>,
}

impl QueryRow {
    pub fn values(&self) -> &[Option<Vec<u8>>] {
        &self.values
    }

    pub fn text(&self, column: usize) -> crate::Result<Option<&str>> {
        crate::error::public_result(self.text_inner(column))
    }

    pub(crate) fn text_inner(&self, column: usize) -> Result<Option<&str>> {
        let value = self
            .values
            .get(column)
            .ok_or_else(|| anyhow!("query row has no column at index {column}"))?;
        value
            .as_deref()
            .map(|bytes| str::from_utf8(bytes).map_err(anyhow::Error::from))
            .transpose()
    }
}

pub fn parse_command_response(bytes: &[u8]) -> Result<CommandResult> {
    let mut input = bytes;
    let mut command_tag = None;
    let mut saw_ready = false;
    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        match tag {
            b'E' => return Err(parse_postgres_error(body)?.into()),
            b'C' => command_tag = Some(parse_command_complete(body)?),
            b'Z' => {
                validate_ready_for_query(body)?;
                saw_ready = true;
                ensure!(
                    input.is_empty(),
                    "backend returned bytes after ReadyForQuery"
                );
            }
            b'1' => require_empty(body, "ParseComplete")?,
            b'2' => require_empty(body, "BindComplete")?,
            b'3' => require_empty(body, "CloseComplete")?,
            b'I' => require_empty(body, "EmptyQueryResponse")?,
            b'n' => require_empty(body, "NoData")?,
            b'S' => validate_parameter_status(body)?,
            b'N' => validate_field_response(body, "NoticeResponse")?,
            b'A' => validate_notification_response(body)?,
            b'T' | b'D' => bail!("execute() received rows; use query() for row results"),
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                bail!(
                    "execute() does not support COPY protocol responses; use exec_protocol_raw for COPY traffic"
                )
            }
            _ => bail!("execute() received unexpected backend message tag 0x{tag:02x}"),
        }
    }
    ensure!(saw_ready, "query response ended before ReadyForQuery");
    let row_count = command_tag.as_deref().and_then(command_tag_row_count);
    Ok(CommandResult {
        command_tag,
        row_count,
    })
}

pub fn parse_query_response(bytes: &[u8]) -> Result<QueryResult> {
    let mut input = bytes;
    let mut fields: Option<Vec<QueryField>> = None;
    let mut rows = Vec::new();
    let mut command_tag = None;
    let mut saw_ready = false;
    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        match tag {
            b'T' => {
                ensure!(
                    fields.is_none(),
                    "query() received multiple result sets; use exec_protocol_raw"
                );
                fields = Some(parse_row_description(body)?);
            }
            b'D' => {
                let count = fields
                    .as_ref()
                    .context("DataRow arrived before RowDescription")?
                    .len();
                rows.push(parse_data_row(body, count)?);
            }
            b'C' => command_tag = Some(parse_command_complete(body)?),
            b'E' => return Err(parse_postgres_error(body)?.into()),
            b'Z' => {
                validate_ready_for_query(body)?;
                saw_ready = true;
                ensure!(
                    input.is_empty(),
                    "backend returned bytes after ReadyForQuery"
                );
            }
            b'1' => require_empty(body, "ParseComplete")?,
            b'2' => require_empty(body, "BindComplete")?,
            b'3' => require_empty(body, "CloseComplete")?,
            b'I' => require_empty(body, "EmptyQueryResponse")?,
            b'n' => require_empty(body, "NoData")?,
            b'S' => validate_parameter_status(body)?,
            b'N' => validate_field_response(body, "NoticeResponse")?,
            b'A' => validate_notification_response(body)?,
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                bail!(
                    "query() does not support COPY protocol responses; use exec_protocol_raw for COPY traffic"
                )
            }
            _ => bail!("query() received unexpected backend message tag 0x{tag:02x}"),
        }
    }
    ensure!(saw_ready, "query response ended before ReadyForQuery");
    let row_count = command_tag.as_deref().and_then(command_tag_row_count);
    Ok(QueryResult {
        fields: fields.unwrap_or_default(),
        rows,
        command_tag,
        row_count,
    })
}

pub(crate) fn extended_query(sql: &str, params: &[QueryParam]) -> Result<Vec<u8>> {
    ensure!(
        !sql.as_bytes().contains(&0),
        "extended query SQL must not contain NUL bytes"
    );
    ensure!(
        params.len() <= i16::MAX as usize,
        "extended query supports at most {} parameters",
        i16::MAX
    );
    let mut packet = Vec::new();
    push_parse(&mut packet, sql)?;
    push_bind(&mut packet, params)?;
    push_describe_portal(&mut packet)?;
    push_execute(&mut packet)?;
    push_frontend_message(&mut packet, b'S', &[])?;
    Ok(packet)
}

fn command_tag_row_count(tag: &str) -> Option<u64> {
    let mut parts = tag.split_ascii_whitespace();
    let command = parts.next()?;
    if !matches!(
        command,
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "MOVE" | "FETCH" | "COPY"
    ) {
        return None;
    }
    parts.last()?.parse().ok()
}

fn push_parse(out: &mut Vec<u8>, sql: &str) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    push_cstring(&mut body, sql)?;
    body.extend_from_slice(&0_i16.to_be_bytes());
    push_frontend_message(out, b'P', &body)
}

fn push_bind(out: &mut Vec<u8>, params: &[QueryParam]) -> Result<()> {
    let mut body = vec![0, 0];
    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for param in params {
        body.extend_from_slice(
            &(if matches!(param, QueryParam::Binary(_)) {
                1_i16
            } else {
                0_i16
            })
            .to_be_bytes(),
        );
    }
    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for param in params {
        match param {
            QueryParam::Null => body.extend_from_slice(&(-1_i32).to_be_bytes()),
            QueryParam::Text(value) => push_sized(&mut body, value.as_bytes())?,
            QueryParam::Binary(value) => push_sized(&mut body, value)?,
        }
    }
    body.extend_from_slice(&1_i16.to_be_bytes());
    body.extend_from_slice(&0_i16.to_be_bytes());
    push_frontend_message(out, b'B', &body)
}

fn push_describe_portal(out: &mut Vec<u8>) -> Result<()> {
    push_frontend_message(out, b'D', &[b'P', 0])
}

fn push_execute(out: &mut Vec<u8>) -> Result<()> {
    push_frontend_message(out, b'E', &[0, 0, 0, 0, 0])
}

fn push_frontend_message(out: &mut Vec<u8>, tag: u8, body: &[u8]) -> Result<()> {
    let length =
        i32::try_from(body.len() + 4).map_err(|_| anyhow!("protocol message too large"))?;
    out.push(tag);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(body);
    Ok(())
}

fn push_cstring(out: &mut Vec<u8>, value: &str) -> Result<()> {
    ensure!(
        !value.as_bytes().contains(&0),
        "protocol string contains NUL"
    );
    out.extend_from_slice(value.as_bytes());
    out.push(0);
    Ok(())
}

fn push_sized(out: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let length = i32::try_from(value.len()).map_err(|_| anyhow!("query parameter too large"))?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

fn read_backend_message(bytes: &[u8]) -> Result<(u8, &[u8], &[u8])> {
    ensure!(bytes.len() >= 5, "truncated backend message header");
    let length = i32::from_be_bytes(bytes[1..5].try_into().expect("four bytes"));
    ensure!(length >= 4, "invalid backend message length {length}");
    let total = 1usize
        .checked_add(length as usize)
        .context("backend message length overflow")?;
    ensure!(bytes.len() >= total, "truncated backend message body");
    Ok((bytes[0], &bytes[5..total], &bytes[total..]))
}

fn parse_row_description(mut body: &[u8]) -> Result<Vec<QueryField>> {
    let count = read_i16(&mut body, "RowDescription field count")?;
    ensure!(count >= 0, "invalid RowDescription field count {count}");
    let mut fields = Vec::with_capacity(count as usize);
    for _ in 0..count {
        fields.push(QueryField {
            name: read_cstring(&mut body, "field name")?.to_owned(),
            table_oid: read_u32(&mut body, "field table oid")?,
            table_attribute: read_i16(&mut body, "field table attribute")?,
            type_oid: read_u32(&mut body, "field type oid")?,
            type_size: read_i16(&mut body, "field type size")?,
            type_modifier: read_i32(&mut body, "field type modifier")?,
            format: read_i16(&mut body, "field format")?.into(),
        });
    }
    ensure!(body.is_empty(), "RowDescription contained trailing bytes");
    Ok(fields)
}

fn parse_data_row(mut body: &[u8], expected: usize) -> Result<QueryRow> {
    let count = read_i16(&mut body, "DataRow column count")?;
    ensure!(count >= 0, "invalid DataRow column count {count}");
    ensure!(
        count as usize == expected,
        "DataRow column count does not match RowDescription"
    );
    let mut values = Vec::with_capacity(expected);
    for _ in 0..count {
        let length = read_i32(&mut body, "DataRow value length")?;
        if length == -1 {
            values.push(None);
        } else {
            ensure!(length >= 0, "invalid DataRow value length {length}");
            values.push(Some(
                take(&mut body, length as usize, "DataRow value")?.to_vec(),
            ));
        }
    }
    ensure!(body.is_empty(), "DataRow contained trailing bytes");
    Ok(QueryRow { values })
}

fn parse_command_complete(mut body: &[u8]) -> Result<String> {
    let command = read_cstring(&mut body, "CommandComplete tag")?.to_owned();
    ensure!(body.is_empty(), "CommandComplete contained trailing bytes");
    Ok(command)
}

fn parse_postgres_error(mut body: &[u8]) -> Result<PostgresError> {
    let mut fields = Vec::new();
    loop {
        let (&code, rest) = body
            .split_first()
            .context("ErrorResponse is missing terminator")?;
        body = rest;
        if code == 0 {
            ensure!(body.is_empty(), "ErrorResponse contained trailing bytes");
            break;
        }
        fields.push(PostgresErrorField {
            code,
            value: read_cstring(&mut body, "ErrorResponse field")?.to_owned(),
        });
    }
    Ok(PostgresError::from_fields(fields))
}

fn validate_ready_for_query(body: &[u8]) -> Result<()> {
    ensure!(
        matches!(body, [b'I' | b'T' | b'E']),
        "invalid ReadyForQuery"
    );
    Ok(())
}

fn require_empty(body: &[u8], label: &str) -> Result<()> {
    ensure!(body.is_empty(), "{label} contained trailing bytes");
    Ok(())
}

fn validate_parameter_status(mut body: &[u8]) -> Result<()> {
    read_cstring(&mut body, "ParameterStatus name")?;
    read_cstring(&mut body, "ParameterStatus value")?;
    ensure!(body.is_empty(), "ParameterStatus contained trailing bytes");
    Ok(())
}

fn validate_notification_response(mut body: &[u8]) -> Result<()> {
    read_i32(&mut body, "NotificationResponse process id")?;
    read_cstring(&mut body, "NotificationResponse channel")?;
    read_cstring(&mut body, "NotificationResponse payload")?;
    ensure!(
        body.is_empty(),
        "NotificationResponse contained trailing bytes"
    );
    Ok(())
}

fn validate_field_response(mut body: &[u8], label: &str) -> Result<()> {
    loop {
        let (&code, rest) = body
            .split_first()
            .with_context(|| format!("{label} is missing terminator"))?;
        body = rest;
        if code == 0 {
            ensure!(body.is_empty(), "{label} contained trailing bytes");
            return Ok(());
        }
        read_cstring(&mut body, &format!("{label} field"))?;
    }
}

fn read_u32(input: &mut &[u8], label: &str) -> Result<u32> {
    Ok(u32::from_be_bytes(
        take(input, 4, label)?.try_into().expect("four bytes"),
    ))
}

fn read_i32(input: &mut &[u8], label: &str) -> Result<i32> {
    Ok(i32::from_be_bytes(
        take(input, 4, label)?.try_into().expect("four bytes"),
    ))
}

fn read_i16(input: &mut &[u8], label: &str) -> Result<i16> {
    Ok(i16::from_be_bytes(
        take(input, 2, label)?.try_into().expect("two bytes"),
    ))
}

fn read_cstring<'a>(input: &mut &'a [u8], label: &str) -> Result<&'a str> {
    let nul = input
        .iter()
        .position(|byte| *byte == 0)
        .with_context(|| format!("{label} is missing null terminator"))?;
    let value = str::from_utf8(&input[..nul]).with_context(|| format!("{label} is not UTF-8"))?;
    *input = &input[nul + 1..];
    Ok(value)
}

fn take<'a>(input: &mut &'a [u8], length: usize, label: &str) -> Result<&'a [u8]> {
    ensure!(input.len() >= length, "truncated {label}");
    let (head, tail) = input.split_at(length);
    *input = tail;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_query_encodes_one_postgres_message() {
        assert_eq!(
            simple_query("SELECT 1").expect("valid simple query"),
            b"Q\0\0\0\rSELECT 1\0".as_slice()
        );
    }

    #[test]
    fn simple_query_rejects_embedded_nul() {
        assert_eq!(
            simple_query("SELECT\0 1")
                .expect_err("embedded NUL must be rejected")
                .to_string(),
            "simple query SQL must not contain NUL bytes"
        );
    }

    #[test]
    fn postgres_error_preserves_ordered_fields() {
        let error = parse_postgres_error(
            b"SERREUR\0VERROR\0C23505\0Mduplicate key\0DKey already exists\0titems\0\0",
        )
        .expect("valid ErrorResponse");

        assert_eq!(error.severity.as_deref(), Some("ERROR"));
        assert_eq!(error.sqlstate.as_deref(), Some("23505"));
        assert_eq!(error.message, "duplicate key");
        assert_eq!(error.detail.as_deref(), Some("Key already exists"));
        assert_eq!(error.table_name.as_deref(), Some("items"));
        assert_eq!(
            error
                .fields
                .iter()
                .map(|field| field.code)
                .collect::<Vec<_>>(),
            [b'S', b'V', b'C', b'M', b'D', b't']
        );
        assert_eq!(error.to_string(), "ERROR [23505]: duplicate key");
    }

    #[test]
    fn postgres_error_display_handles_partial_identity() {
        let error = |severity: Option<&str>, sqlstate: Option<&str>| PostgresError {
            severity: severity.map(str::to_owned),
            sqlstate: sqlstate.map(str::to_owned),
            message: "failed".to_owned(),
            detail: None,
            hint: None,
            position: None,
            where_: None,
            schema_name: None,
            table_name: None,
            column_name: None,
            data_type_name: None,
            constraint_name: None,
            fields: Vec::new(),
        };

        assert_eq!(error(Some("ERROR"), None).to_string(), "ERROR: failed");
        assert_eq!(error(None, Some("XX000")).to_string(), "[XX000]: failed");
        assert_eq!(error(None, None).to_string(), "failed");
    }

    #[test]
    fn query_parameter_conversions_feed_the_extended_protocol() {
        let owned = "owned".to_owned();
        let params = vec![
            QueryParam::text("text"),
            QueryParam::binary([1_u8, 2]),
            QueryParam::from("borrowed"),
            QueryParam::from(owned.clone()),
            QueryParam::from(&owned),
            QueryParam::from(1_i16),
            QueryParam::from(2_i32),
            QueryParam::from(3_i64),
            QueryParam::from(4.5_f32),
            QueryParam::from(6.25_f64),
            QueryParam::from(true),
            QueryParam::from(&[7_u8, 8][..]),
            QueryParam::from(vec![9_u8]),
            QueryParam::from(Some("optional")),
            QueryParam::from(None::<&str>),
        ];

        let packet = extended_query("SELECT $1", &params).expect("valid extended query");
        assert_eq!(packet.first(), Some(&b'P'));
        assert!(packet.contains(&b'B'));
        assert!(extended_query("SELECT\0$1", &[]).is_err());
        assert!(
            extended_query("SELECT 1", &vec![QueryParam::Null; i16::MAX as usize + 1]).is_err()
        );
    }

    #[test]
    fn query_result_accessors_report_postgres_shapes() {
        let result = QueryResult {
            fields: vec![QueryField {
                name: "value".to_owned(),
                table_oid: 0,
                table_attribute: 0,
                type_oid: 25,
                type_size: -1,
                type_modifier: -1,
                format: QueryFormat::Text,
            }],
            rows: vec![QueryRow {
                values: vec![Some(b"ok".to_vec())],
            }],
            command_tag: Some("SELECT 1".to_owned()),
            row_count: Some(1),
        };

        assert_eq!(result.field_index("value"), Some(0));
        assert_eq!(result.get_text(0, "value").expect("text value"), Some("ok"));
        assert!(result.get_text(0, "missing").is_err());
        assert!(result.get_text(1, "value").is_err());
        assert_eq!(result.rows()[0].values(), &[Some(b"ok".to_vec())]);
        assert_eq!(result.rows()[0].text(0).expect("row text"), Some("ok"));
        assert!(result.rows()[0].text(1).is_err());
        assert!(
            QueryRow {
                values: vec![Some(vec![0xff])],
            }
            .text(0)
            .is_err()
        );
        assert_eq!(QueryFormat::from(0), QueryFormat::Text);
        assert_eq!(QueryFormat::from(1), QueryFormat::Binary);
        assert_eq!(QueryFormat::from(7), QueryFormat::Other(7));
    }
}

#[cfg(test)]
mod query_fixture_tests;
