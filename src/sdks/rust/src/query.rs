use std::str;

use crate::error::{Error, Result, parse_postgres_error_response};
use crate::protocol::{ProtocolRequest, ProtocolResponse};

/// Parameter value for a PostgreSQL extended-query execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryParam {
    /// SQL `NULL`.
    Null,
    /// Text-format parameter value.
    Text(String),
    /// Binary-format parameter value.
    Binary(Vec<u8>),
}

impl QueryParam {
    /// Construct a text parameter.
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    /// Construct a binary parameter.
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

impl From<i16> for QueryParam {
    fn from(value: i16) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<i32> for QueryParam {
    fn from(value: i32) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<i64> for QueryParam {
    fn from(value: i64) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<f32> for QueryParam {
    fn from(value: f32) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<f64> for QueryParam {
    fn from(value: f64) -> Self {
        Self::Text(value.to_string())
    }
}

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

/// Result of a PostgreSQL simple-query execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryResult {
    fields: Vec<QueryField>,
    rows: Vec<QueryRow>,
    command_tag: Option<String>,
}

impl QueryResult {
    /// Field metadata in result-column order.
    pub fn fields(&self) -> &[QueryField] {
        &self.fields
    }

    /// Rows returned by the query.
    pub fn rows(&self) -> &[QueryRow] {
        &self.rows
    }

    /// PostgreSQL command tag returned by the last command in the query.
    pub fn command_tag(&self) -> Option<&str> {
        self.command_tag.as_deref()
    }

    /// Number of rows returned by the query.
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Return the index for a column name.
    pub fn field_index(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|field| field.name == name)
    }

    /// Read a text-format value by row index and column name.
    pub fn get_text(&self, row: usize, column: &str) -> Result<Option<&str>> {
        let column = self
            .field_index(column)
            .ok_or_else(|| Error::Engine(format!("query result has no column named {column:?}")))?;
        let row = self
            .rows
            .get(row)
            .ok_or_else(|| Error::Engine(format!("query result has no row at index {row}")))?;
        row.text(column)
    }
}

/// Metadata for one PostgreSQL result column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryField {
    /// Column name.
    pub name: String,
    /// Table OID reported by PostgreSQL, or `0` when not tied to a table.
    pub table_oid: u32,
    /// Table attribute number reported by PostgreSQL.
    pub table_attribute: i16,
    /// PostgreSQL type OID.
    pub type_oid: u32,
    /// PostgreSQL type size.
    pub type_size: i16,
    /// PostgreSQL type modifier.
    pub type_modifier: i32,
    /// Format used for values in this column.
    pub format: QueryFormat,
}

/// PostgreSQL result-column value format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryFormat {
    /// Text format.
    Text,
    /// Binary format.
    Binary,
    /// Unknown or extension format code.
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

/// One PostgreSQL query row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryRow {
    values: Vec<Option<Vec<u8>>>,
}

impl QueryRow {
    /// Raw column values in result-column order.
    pub fn values(&self) -> &[Option<Vec<u8>>] {
        &self.values
    }

    /// Read a text-format value by column index.
    pub fn text(&self, column: usize) -> Result<Option<&str>> {
        let value = self
            .values
            .get(column)
            .ok_or_else(|| Error::Engine(format!("query row has no column at index {column}")))?;
        value
            .as_deref()
            .map(|bytes| {
                str::from_utf8(bytes)
                    .map_err(|err| Error::Engine(format!("query value is not valid UTF-8: {err}")))
            })
            .transpose()
    }
}

/// Parse a simple-query backend response into a single result set.
///
/// This parser intentionally supports the normal simple-query shape used by
/// the Rust SDK `query()` API: zero or one row-producing statement followed by
/// `ReadyForQuery`. Multi-result-set and COPY responses should use
/// `exec_protocol_raw` or streaming APIs instead.
pub fn parse_query_response(response: &ProtocolResponse) -> Result<QueryResult> {
    parse_query_response_bytes(response.as_bytes())
}

pub(crate) fn extended_query_request<I, P>(sql: &str, params: I) -> Result<ProtocolRequest>
where
    I: IntoIterator<Item = P>,
    P: Into<QueryParam>,
{
    if sql.as_bytes().contains(&0) {
        return Err(Error::Engine(
            "extended query SQL must not contain NUL bytes".to_owned(),
        ));
    }
    let params = params.into_iter().map(Into::into).collect::<Vec<_>>();
    if params.len() > i16::MAX as usize {
        return Err(Error::Engine(format!(
            "extended query supports at most {} parameters, got {}",
            i16::MAX,
            params.len()
        )));
    }

    let mut packet = Vec::new();
    push_parse(&mut packet, sql)?;
    push_bind(&mut packet, &params)?;
    push_describe_portal(&mut packet)?;
    push_execute(&mut packet)?;
    push_sync(&mut packet)?;
    Ok(ProtocolRequest::new(packet))
}

pub(crate) fn parse_query_response_bytes(bytes: &[u8]) -> Result<QueryResult> {
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
                if fields.is_some() {
                    return Err(Error::Engine(
                        "query() received multiple result sets; use exec_protocol_raw for multi-statement row results"
                            .to_owned(),
                    ));
                }
                fields = Some(parse_row_description(body)?);
            }
            b'D' => {
                let field_count = fields
                    .as_ref()
                    .ok_or_else(|| {
                        Error::Engine("DataRow arrived before RowDescription".to_owned())
                    })?
                    .len();
                rows.push(parse_data_row(body, field_count)?);
            }
            b'C' => {
                command_tag = Some(parse_command_complete(body)?);
            }
            b'E' => return Err(Error::Postgres(parse_postgres_error_response(body))),
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                return Err(Error::Engine(
                    "query() does not support COPY protocol responses; use exec_protocol_raw_stream"
                        .to_owned(),
                ));
            }
            b'Z' => {
                validate_ready_for_query(body)?;
                saw_ready = true;
                if !input.is_empty() {
                    return Err(Error::Engine(
                        "backend returned bytes after ReadyForQuery".to_owned(),
                    ));
                }
            }
            b'1' => require_empty_backend_message(body, "ParseComplete")?,
            b'2' => require_empty_backend_message(body, "BindComplete")?,
            b'3' => require_empty_backend_message(body, "CloseComplete")?,
            b'I' => require_empty_backend_message(body, "EmptyQueryResponse")?,
            b'n' => require_empty_backend_message(body, "NoData")?,
            b'S' => validate_parameter_status(body)?,
            b'N' => validate_field_response(body, "NoticeResponse")?,
            b'A' => validate_notification_response(body)?,
            _ => {
                return Err(Error::Engine(format!(
                    "query() received unexpected backend message tag 0x{tag:02x}"
                )));
            }
        }
    }

    if !saw_ready {
        return Err(Error::Engine(
            "query response ended before ReadyForQuery".to_owned(),
        ));
    }

    Ok(QueryResult {
        fields: fields.unwrap_or_default(),
        rows,
        command_tag,
    })
}

fn push_parse(out: &mut Vec<u8>, sql: &str) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    push_cstring(&mut body, sql)?;
    body.extend_from_slice(&0_i16.to_be_bytes());
    push_frontend_message(out, b'P', &body)
}

fn push_bind(out: &mut Vec<u8>, params: &[QueryParam]) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    push_cstring(&mut body, "")?;

    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for param in params {
        let format = match param {
            QueryParam::Binary(_) => 1_i16,
            QueryParam::Null | QueryParam::Text(_) => 0_i16,
        };
        body.extend_from_slice(&format.to_be_bytes());
    }

    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for param in params {
        match param {
            QueryParam::Null => body.extend_from_slice(&(-1_i32).to_be_bytes()),
            QueryParam::Text(value) => {
                push_sized_value(&mut body, value.as_bytes())?;
            }
            QueryParam::Binary(value) => {
                push_sized_value(&mut body, value)?;
            }
        }
    }

    body.extend_from_slice(&1_i16.to_be_bytes());
    body.extend_from_slice(&0_i16.to_be_bytes());
    push_frontend_message(out, b'B', &body)
}

fn push_describe_portal(out: &mut Vec<u8>) -> Result<()> {
    let mut body = Vec::new();
    body.push(b'P');
    push_cstring(&mut body, "")?;
    push_frontend_message(out, b'D', &body)
}

fn push_execute(out: &mut Vec<u8>) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    body.extend_from_slice(&0_i32.to_be_bytes());
    push_frontend_message(out, b'E', &body)
}

fn push_sync(out: &mut Vec<u8>) -> Result<()> {
    push_frontend_message(out, b'S', &[])
}

fn push_frontend_message(out: &mut Vec<u8>, tag: u8, body: &[u8]) -> Result<()> {
    let len = i32::try_from(body.len() + 4)
        .map_err(|_| Error::Engine("frontend protocol message is too large".to_owned()))?;
    out.push(tag);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(body);
    Ok(())
}

fn push_cstring(out: &mut Vec<u8>, value: &str) -> Result<()> {
    if value.as_bytes().contains(&0) {
        return Err(Error::Engine(
            "frontend protocol string must not contain NUL bytes".to_owned(),
        ));
    }
    out.extend_from_slice(value.as_bytes());
    out.push(0);
    Ok(())
}

fn push_sized_value(out: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let len = i32::try_from(value.len())
        .map_err(|_| Error::Engine("query parameter is too large".to_owned()))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

fn read_backend_message(bytes: &[u8]) -> Result<(u8, &[u8], &[u8])> {
    if bytes.len() < 5 {
        return Err(Error::Engine("truncated backend message header".to_owned()));
    }
    let tag = bytes[0];
    let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    if len < 4 {
        return Err(Error::Engine(format!(
            "invalid backend message length {len}"
        )));
    }
    let total = 1usize
        .checked_add(len as usize)
        .ok_or_else(|| Error::Engine("backend message length overflow".to_owned()))?;
    if bytes.len() < total {
        return Err(Error::Engine("truncated backend message body".to_owned()));
    }
    Ok((tag, &bytes[5..total], &bytes[total..]))
}

fn parse_row_description(mut body: &[u8]) -> Result<Vec<QueryField>> {
    let count = read_i16(&mut body, "RowDescription field count")?;
    if count < 0 {
        return Err(Error::Engine(format!(
            "invalid RowDescription field count {count}"
        )));
    }
    let mut fields = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let name = read_cstring(&mut body, "field name")?.to_owned();
        fields.push(QueryField {
            name,
            table_oid: read_u32(&mut body, "field table oid")?,
            table_attribute: read_i16(&mut body, "field table attribute")?,
            type_oid: read_u32(&mut body, "field type oid")?,
            type_size: read_i16(&mut body, "field type size")?,
            type_modifier: read_i32(&mut body, "field type modifier")?,
            format: QueryFormat::from(read_i16(&mut body, "field format")?),
        });
    }
    if !body.is_empty() {
        return Err(Error::Engine(
            "RowDescription contained trailing bytes".to_owned(),
        ));
    }
    Ok(fields)
}

fn parse_data_row(mut body: &[u8], expected_columns: usize) -> Result<QueryRow> {
    let count = read_i16(&mut body, "DataRow column count")?;
    if count < 0 {
        return Err(Error::Engine(format!(
            "invalid DataRow column count {count}"
        )));
    }
    if count as usize != expected_columns {
        return Err(Error::Engine(format!(
            "DataRow column count {count} does not match RowDescription count {expected_columns}"
        )));
    }
    let mut values = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let len = read_i32(&mut body, "DataRow value length")?;
        if len == -1 {
            values.push(None);
            continue;
        }
        if len < 0 {
            return Err(Error::Engine(format!("invalid DataRow value length {len}")));
        }
        let len = len as usize;
        if body.len() < len {
            return Err(Error::Engine("truncated DataRow value".to_owned()));
        }
        values.push(Some(body[..len].to_vec()));
        body = &body[len..];
    }
    if !body.is_empty() {
        return Err(Error::Engine("DataRow contained trailing bytes".to_owned()));
    }
    Ok(QueryRow { values })
}

fn parse_command_complete(body: &[u8]) -> Result<String> {
    let mut body = body;
    let tag = read_cstring(&mut body, "CommandComplete tag")?.to_owned();
    if !body.is_empty() {
        return Err(Error::Engine(
            "CommandComplete contained trailing bytes".to_owned(),
        ));
    }
    Ok(tag)
}

fn require_empty_backend_message(body: &[u8], label: &str) -> Result<()> {
    if body.is_empty() {
        return Ok(());
    }
    Err(Error::Engine(format!("{label} contained trailing bytes")))
}

fn validate_ready_for_query(body: &[u8]) -> Result<()> {
    match body {
        [b'I' | b'T' | b'E'] => Ok(()),
        [status] => Err(Error::Engine(format!(
            "ReadyForQuery contained invalid transaction status 0x{status:02x}"
        ))),
        _ => Err(Error::Engine(format!(
            "ReadyForQuery contained {} bytes, expected 1",
            body.len()
        ))),
    }
}

fn validate_parameter_status(mut body: &[u8]) -> Result<()> {
    read_cstring(&mut body, "ParameterStatus name")?;
    read_cstring(&mut body, "ParameterStatus value")?;
    if !body.is_empty() {
        return Err(Error::Engine(
            "ParameterStatus contained trailing bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_notification_response(mut body: &[u8]) -> Result<()> {
    read_i32(&mut body, "NotificationResponse process id")?;
    read_cstring(&mut body, "NotificationResponse channel")?;
    read_cstring(&mut body, "NotificationResponse payload")?;
    if !body.is_empty() {
        return Err(Error::Engine(
            "NotificationResponse contained trailing bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_field_response(mut body: &[u8], label: &str) -> Result<()> {
    loop {
        let Some((&code, rest)) = body.split_first() else {
            return Err(Error::Engine(format!("{label} is missing terminator")));
        };
        body = rest;
        if code == 0 {
            if !body.is_empty() {
                return Err(Error::Engine(format!("{label} contained trailing bytes")));
            }
            return Ok(());
        }
        read_cstring(&mut body, &format!("{label} field"))?;
    }
}

fn read_u32(input: &mut &[u8], label: &str) -> Result<u32> {
    let bytes = take(input, 4, label)?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i32(input: &mut &[u8], label: &str) -> Result<i32> {
    let bytes = take(input, 4, label)?;
    Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i16(input: &mut &[u8], label: &str) -> Result<i16> {
    let bytes = take(input, 2, label)?;
    Ok(i16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_cstring<'a>(input: &mut &'a [u8], label: &str) -> Result<&'a str> {
    let nul = input
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| Error::Engine(format!("{label} is missing null terminator")))?;
    let raw = &input[..nul];
    let value = str::from_utf8(raw)
        .map_err(|err| Error::Engine(format!("{label} is not valid UTF-8: {err}")))?;
    *input = &input[nul + 1..];
    Ok(value)
}

fn take<'a>(input: &mut &'a [u8], len: usize, label: &str) -> Result<&'a [u8]> {
    if input.len() < len {
        return Err(Error::Engine(format!("truncated {label}")));
    }
    let (head, tail) = input.split_at(len);
    *input = tail;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_query_result() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("value", 23), ("empty", 25)]);
        push_data_row(&mut bytes, &[Some("1"), None]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert_eq!(result.fields()[0].name, "value");
        assert_eq!(result.fields()[0].type_oid, 23);
        assert_eq!(result.row_count(), 1);
        assert_eq!(result.command_tag(), Some("SELECT 1"));
        assert_eq!(result.get_text(0, "value").unwrap(), Some("1"));
        assert_eq!(result.get_text(0, "empty").unwrap(), None);
    }

    #[test]
    fn returns_sql_errors_as_errors() {
        let mut bytes = Vec::new();
        push_error_response(&mut bytes, "ERROR", "42P01", "relation does not exist");
        push_ready_for_query(&mut bytes);

        let error = parse_query_response_bytes(&bytes).unwrap_err();
        let Error::Postgres(postgres) = error else {
            panic!("expected structured PostgreSQL error, got {error:?}");
        };
        assert_eq!(postgres.severity.as_deref(), Some("ERROR"));
        assert_eq!(postgres.sqlstate.as_deref(), Some("42P01"));
        assert_eq!(postgres.message, "relation does not exist");
    }

    #[test]
    fn returns_query_cancellation_as_structured_postgres_error() {
        let mut bytes = Vec::new();
        push_error_response(
            &mut bytes,
            "ERROR",
            "57014",
            "canceling statement due to user request",
        );
        push_ready_for_query(&mut bytes);

        let error = parse_query_response_bytes(&bytes).unwrap_err();
        let Error::Postgres(postgres) = error else {
            panic!("expected structured PostgreSQL cancellation error, got {error:?}");
        };
        assert_eq!(postgres.severity.as_deref(), Some("ERROR"));
        assert_eq!(postgres.sqlstate.as_deref(), Some("57014"));
        assert_eq!(postgres.message, "canceling statement due to user request");
    }

    #[test]
    fn rejects_invalid_utf8_in_backend_cstrings() {
        let mut bytes = Vec::new();
        push_raw_row_description(&mut bytes, &[(&[0xff], 25)]);
        push_ready_for_query(&mut bytes);

        assert!(matches!(
            parse_query_response_bytes(&bytes),
            Err(Error::Engine(message))
                if message.contains("field name is not valid UTF-8")
        ));
    }

    #[test]
    fn text_accessors_reject_invalid_utf8_values() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("value", 25)]);
        push_data_row_raw(&mut bytes, &[Some(&[0xff])]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert!(matches!(
            result.get_text(0, "value"),
            Err(Error::Engine(message)) if message.contains("query value is not valid UTF-8")
        ));
    }

    #[test]
    fn rejects_multiple_result_sets() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("one", 23)]);
        push_data_row(&mut bytes, &[Some("1")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_row_description(&mut bytes, &[("two", 23)]);
        push_data_row(&mut bytes, &[Some("2")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        assert!(matches!(
            parse_query_response_bytes(&bytes),
            Err(Error::Engine(message)) if message.contains("multiple result sets")
        ));
    }

    #[test]
    fn accepts_extended_query_control_messages() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'1', &[]);
        push_backend_message(&mut bytes, b'2', &[]);
        push_backend_message(&mut bytes, b'n', &[]);
        push_command_complete(&mut bytes, "INSERT 0 0");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert!(result.fields().is_empty());
        assert!(result.rows().is_empty());
        assert_eq!(result.command_tag(), Some("INSERT 0 0"));
    }

    #[test]
    fn accepts_backend_async_control_messages() {
        let mut bytes = Vec::new();
        push_parameter_status(&mut bytes, "client_encoding", "UTF8");
        push_notice_response(&mut bytes, "NOTICE", "hello");
        push_notification_response(&mut bytes, 123, "channel", "payload");
        push_command_complete(&mut bytes, "SELECT 0");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert_eq!(result.command_tag(), Some("SELECT 0"));
    }

    #[test]
    fn rejects_malformed_empty_control_messages() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'1', &[0]);
        push_ready_for_query(&mut bytes);

        assert!(matches!(
            parse_query_response_bytes(&bytes),
            Err(Error::Engine(message)) if message.contains("ParseComplete contained trailing bytes")
        ));
    }

    #[test]
    fn rejects_malformed_async_control_messages() {
        let mut malformed_parameter = Vec::new();
        push_backend_message(&mut malformed_parameter, b'S', b"client_encoding\0");
        push_ready_for_query(&mut malformed_parameter);
        assert!(matches!(
            parse_query_response_bytes(&malformed_parameter),
            Err(Error::Engine(message))
                if message.contains("ParameterStatus value is missing null terminator")
        ));

        let mut malformed_notice = Vec::new();
        push_backend_message(&mut malformed_notice, b'N', b"SNOTICE\0");
        push_ready_for_query(&mut malformed_notice);
        assert!(matches!(
            parse_query_response_bytes(&malformed_notice),
            Err(Error::Engine(message)) if message.contains("NoticeResponse is missing terminator")
        ));

        let mut malformed_notification = Vec::new();
        let mut body = 123_i32.to_be_bytes().to_vec();
        body.extend_from_slice(b"channel");
        push_backend_message(&mut malformed_notification, b'A', &body);
        push_ready_for_query(&mut malformed_notification);
        assert!(matches!(
            parse_query_response_bytes(&malformed_notification),
            Err(Error::Engine(message))
                if message.contains("NotificationResponse channel is missing null terminator")
        ));
    }

    #[test]
    fn rejects_unexpected_backend_message_tags() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'R', &[0, 0, 0, 0]);
        push_ready_for_query(&mut bytes);

        assert!(matches!(
            parse_query_response_bytes(&bytes),
            Err(Error::Engine(message)) if message.contains("unexpected backend message tag 0x52")
        ));
    }

    #[test]
    fn accepts_ready_for_query_transaction_states() {
        for status in [b'I', b'T', b'E'] {
            let mut bytes = Vec::new();
            push_command_complete(&mut bytes, "SELECT 0");
            push_backend_message(&mut bytes, b'Z', &[status]);

            let result = parse_query_response_bytes(&bytes).unwrap();
            assert_eq!(result.command_tag(), Some("SELECT 0"));
        }
    }

    #[test]
    fn rejects_malformed_ready_for_query_status() {
        let mut missing = Vec::new();
        push_backend_message(&mut missing, b'Z', &[]);
        assert!(matches!(
            parse_query_response_bytes(&missing),
            Err(Error::Engine(message))
                if message.contains("ReadyForQuery contained 0 bytes, expected 1")
        ));

        let mut invalid = Vec::new();
        push_backend_message(&mut invalid, b'Z', &[0]);
        assert!(matches!(
            parse_query_response_bytes(&invalid),
            Err(Error::Engine(message))
                if message.contains("ReadyForQuery contained invalid transaction status 0x00")
        ));
    }

    #[test]
    fn builds_extended_query_protocol_request() {
        let request = extended_query_request(
            "SELECT $1::int4, $2::text, $3::bytea, $4::text",
            [
                QueryParam::from(7_i32),
                QueryParam::from(Some("hello")),
                QueryParam::binary([0_u8, 1, 2]),
                QueryParam::from(None::<&str>),
            ],
        )
        .unwrap();

        assert_eq!(
            frontend_message_tags(request.as_bytes()),
            vec![b'P', b'B', b'D', b'E', b'S']
        );
        assert!(
            request
                .as_bytes()
                .windows(b"hello".len())
                .any(|window| window == b"hello")
        );
        assert!(
            request
                .as_bytes()
                .windows([0_u8, 1, 2].len())
                .any(|window| window == [0_u8, 1, 2])
        );
    }

    #[test]
    fn rejects_nul_in_extended_query_sql() {
        assert_eq!(
            extended_query_request("SELECT '\0'", [QueryParam::Null]).unwrap_err(),
            Error::Engine("extended query SQL must not contain NUL bytes".to_owned())
        );
    }

    #[test]
    fn rejects_too_many_extended_query_parameters() {
        let params = std::iter::repeat(QueryParam::Null).take(i16::MAX as usize + 1);

        assert_eq!(
            extended_query_request("SELECT 1", params).unwrap_err(),
            Error::Engine(format!(
                "extended query supports at most {} parameters, got {}",
                i16::MAX,
                i16::MAX as usize + 1
            ))
        );
    }

    fn frontend_message_tags(mut bytes: &[u8]) -> Vec<u8> {
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

    fn push_backend_message(bytes: &mut Vec<u8>, tag: u8, body: &[u8]) {
        bytes.push(tag);
        bytes.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        bytes.extend_from_slice(body);
    }

    fn push_row_description(bytes: &mut Vec<u8>, fields: &[(&str, u32)]) {
        let fields = fields
            .iter()
            .map(|(name, type_oid)| (name.as_bytes(), *type_oid))
            .collect::<Vec<_>>();
        push_raw_row_description(bytes, &fields);
    }

    fn push_raw_row_description(bytes: &mut Vec<u8>, fields: &[(&[u8], u32)]) {
        let mut body = Vec::new();
        body.extend_from_slice(&(fields.len() as i16).to_be_bytes());
        for (name, type_oid) in fields {
            body.extend_from_slice(name);
            body.push(0);
            body.extend_from_slice(&0_u32.to_be_bytes());
            body.extend_from_slice(&0_i16.to_be_bytes());
            body.extend_from_slice(&type_oid.to_be_bytes());
            body.extend_from_slice(&(-1_i16).to_be_bytes());
            body.extend_from_slice(&(-1_i32).to_be_bytes());
            body.extend_from_slice(&0_i16.to_be_bytes());
        }
        push_backend_message(bytes, b'T', &body);
    }

    fn push_data_row(bytes: &mut Vec<u8>, values: &[Option<&str>]) {
        let values = values
            .iter()
            .map(|value| value.map(str::as_bytes))
            .collect::<Vec<_>>();
        push_data_row_raw(bytes, &values);
    }

    fn push_data_row_raw(bytes: &mut Vec<u8>, values: &[Option<&[u8]>]) {
        let mut body = Vec::new();
        body.extend_from_slice(&(values.len() as i16).to_be_bytes());
        for value in values {
            match value {
                Some(value) => {
                    body.extend_from_slice(&(value.len() as i32).to_be_bytes());
                    body.extend_from_slice(value);
                }
                None => body.extend_from_slice(&(-1_i32).to_be_bytes()),
            }
        }
        push_backend_message(bytes, b'D', &body);
    }

    fn push_command_complete(bytes: &mut Vec<u8>, tag: &str) {
        let mut body = Vec::new();
        body.extend_from_slice(tag.as_bytes());
        body.push(0);
        push_backend_message(bytes, b'C', &body);
    }

    fn push_error_response(bytes: &mut Vec<u8>, severity: &str, sqlstate: &str, message: &str) {
        let mut body = Vec::new();
        body.push(b'S');
        body.extend_from_slice(severity.as_bytes());
        body.push(0);
        body.push(b'C');
        body.extend_from_slice(sqlstate.as_bytes());
        body.push(0);
        body.push(b'M');
        body.extend_from_slice(message.as_bytes());
        body.push(0);
        body.push(0);
        push_backend_message(bytes, b'E', &body);
    }

    fn push_notice_response(bytes: &mut Vec<u8>, severity: &str, message: &str) {
        let mut body = Vec::new();
        body.push(b'S');
        body.extend_from_slice(severity.as_bytes());
        body.push(0);
        body.push(b'M');
        body.extend_from_slice(message.as_bytes());
        body.push(0);
        body.push(0);
        push_backend_message(bytes, b'N', &body);
    }

    fn push_parameter_status(bytes: &mut Vec<u8>, name: &str, value: &str) {
        let mut body = Vec::new();
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
        push_backend_message(bytes, b'S', &body);
    }

    fn push_notification_response(bytes: &mut Vec<u8>, pid: i32, channel: &str, payload: &str) {
        let mut body = Vec::new();
        body.extend_from_slice(&pid.to_be_bytes());
        body.extend_from_slice(channel.as_bytes());
        body.push(0);
        body.extend_from_slice(payload.as_bytes());
        body.push(0);
        push_backend_message(bytes, b'A', &body);
    }

    fn push_ready_for_query(bytes: &mut Vec<u8>) {
        push_backend_message(bytes, b'Z', b"I");
    }
}
