use std::str;
#[cfg(test)]
use std::sync::Arc;

use crate::error::{Error, PostgresError, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query_core as core;

pub(crate) use crate::query_core::ReadyStatus;
pub use crate::query_core::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresNotice,
    QueryField, QueryFormat, QueryResult, QueryRow, RowIndex, StatementDescription,
    StatementResult, TypeOid, ValueFormat, ValueRef,
};

impl QueryResult {
    /// Read a text-format value by row index and column name.
    pub fn get_text(&self, row: usize, column: &str) -> Result<Option<&str>> {
        let column = column
            .resolve(self.fields())
            .map_err(|error| Error::Engine(error.to_string()))?;
        let row = self
            .row(row)
            .ok_or_else(|| Error::Engine(format!("query result has no row at index {row}")))?;
        row.text(column)
    }
}

impl QueryRow {
    /// Read a text-format value by column index.
    pub fn text(&self, column: usize) -> Result<Option<&str>> {
        let value = self
            .value(column)
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

#[cfg(test)]
pub(crate) fn parse_query_response(response: &ProtocolResponse) -> Result<QueryResult> {
    parse_query_response_with_protocol(response.as_bytes(), core::ExpectedProtocol::Either)
}

#[cfg(test)]
pub(crate) fn parse_command_response(response: &ProtocolResponse) -> Result<CommandResult> {
    parse_command_response_with_protocol(response.as_bytes(), core::ExpectedProtocol::Either)
}

pub(crate) fn parse_extended_command_response(
    response: &ProtocolResponse,
) -> Result<CommandResult> {
    parse_command_response_with_protocol(response.as_bytes(), core::ExpectedProtocol::Extended)
}

pub(crate) fn parse_simple_command_response(response: &ProtocolResponse) -> Result<CommandResult> {
    parse_command_response_with_protocol(response.as_bytes(), core::ExpectedProtocol::Simple)
}

fn parse_command_response_with_protocol(
    bytes: &[u8],
    expected_protocol: core::ExpectedProtocol,
) -> Result<CommandResult> {
    core::parse_command_response(bytes, expected_protocol).map_err(error_from_core)
}

pub(crate) fn extended_statement_request(
    sql: &str,
    params: &[Parameter],
    result_format: ValueFormat,
) -> Result<ProtocolRequest> {
    core::extended_statement(sql, params, result_format.code())
        .map(ProtocolRequest::new)
        .map_err(error_from_core)
}

pub(crate) fn reject_copy_statements(sql: &str) -> Result<()> {
    core::reject_copy_statements(sql).map_err(error_from_core)
}

pub(crate) fn reject_transaction_chain(sql: &str) -> Result<()> {
    core::reject_transaction_chain(sql).map_err(error_from_core)
}

#[cfg(test)]
pub(crate) fn parse_query_response_bytes(bytes: &[u8]) -> Result<QueryResult> {
    parse_query_response_with_protocol(bytes, core::ExpectedProtocol::Either)
}

pub(crate) fn parse_extended_query_response(response: &ProtocolResponse) -> Result<QueryResult> {
    parse_query_response_with_protocol(response.as_bytes(), core::ExpectedProtocol::Extended)
}

fn parse_query_response_with_protocol(
    bytes: &[u8],
    expected_protocol: core::ExpectedProtocol,
) -> Result<QueryResult> {
    core::parse_query_response(bytes, expected_protocol).map_err(error_from_core)
}

pub(crate) fn parse_exec_response(response: &ProtocolResponse) -> Result<ExecResult> {
    core::parse_exec_response(response.as_bytes()).map_err(error_from_core)
}

pub(crate) fn parse_statement_description(
    response: &ProtocolResponse,
) -> Result<StatementDescription> {
    core::parse_statement_description(response.as_bytes()).map_err(error_from_core)
}

pub(crate) fn describe_statement_request(
    sql: &str,
    params: &[Parameter],
) -> Result<ProtocolRequest> {
    core::describe_statement(sql, params)
        .map(ProtocolRequest::new)
        .map_err(error_from_core)
}

pub(crate) fn response_ready_status(response: &ProtocolResponse) -> Result<ReadyStatus> {
    core::response_ready_status(response.as_bytes()).map_err(error_from_core)
}

pub(crate) fn validate_managed_transaction_response(
    response: &ProtocolResponse,
) -> Result<ReadyStatus> {
    core::validate_managed_transaction_response(response.as_bytes()).map_err(error_from_core)
}

fn error_from_core(error: core::Error) -> Error {
    match error {
        core::Error::Protocol(message) => Error::Engine(message),
        core::Error::Postgres {
            diagnostic,
            notices,
        } => {
            let mut error = PostgresError::from_core(*diagnostic);
            error.notices = notices.into_iter().map(PostgresNotice::from_core).collect();
            Error::Postgres(Box::new(error))
        }
    }
}

#[cfg(test)]
fn parse_notice_response(body: &[u8]) -> Result<PostgresNotice> {
    core::parse_diagnostic_fields(body, "NoticeResponse")
        .map(|fields| core::diagnostic(fields, "PostgreSQL NoticeResponse"))
        .map(PostgresNotice::from_core)
        .map_err(error_from_core)
}

#[cfg(test)]
fn read_u32(input: &mut &[u8], label: &str) -> Result<u32> {
    let bytes = take(input, 4, label)?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
fn read_i32(input: &mut &[u8], label: &str) -> Result<i32> {
    let bytes = take(input, 4, label)?;
    Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
fn read_i16(input: &mut &[u8], label: &str) -> Result<i16> {
    let bytes = take(input, 2, label)?;
    Ok(i16::from_be_bytes([bytes[0], bytes[1]]))
}

#[cfg(test)]
fn read_cstring<'a>(input: &mut &'a [u8], label: &str) -> Result<&'a str> {
    let nul = input
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| Error::Engine(format!("{label} is missing null terminator")))?;
    let value = str::from_utf8(&input[..nul])
        .map_err(|error| Error::Engine(format!("{label} is not valid UTF-8: {error}")))?;
    *input = &input[nul + 1..];
    Ok(value)
}

#[cfg(test)]
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

    fn assert_other_error_contains<T>(actual: Result<T>, expected: &str) {
        let error = match actual {
            Ok(_) => panic!("expected error containing {expected:?}"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), crate::error::ErrorKind::Other);
        assert!(
            error.to_string().contains(expected),
            "{error:?} omitted {expected:?}"
        );
    }

    #[test]
    fn consumes_shared_query_response_contract() {
        let source = crate::test_fixtures::text(
            "protocol/query-response-cases.json",
            "testdata/query-response-cases.json",
        );
        let fixture: serde_json::Value =
            serde_json::from_str(&source).expect("shared query response fixture is valid JSON");
        assert_eq!(fixture["schemaVersion"], 1);
        let type_oids = &fixture["typeOids"];
        for (name, actual) in [
            ("xmlArray", TypeOid::XML_ARRAY),
            ("charArray", TypeOid::CHAR_ARRAY),
            ("nameArray", TypeOid::NAME_ARRAY),
            ("timetz", TypeOid::TIMETZ),
            ("timetzArray", TypeOid::TIMETZ_ARRAY),
        ] {
            assert_eq!(
                u64::from(actual.get()),
                type_oids[name].as_u64().expect("shared type OID"),
                "shared PostgreSQL type OID {name}"
            );
        }
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let name = case["name"].as_str().expect("case name");
            let bytes = decode_hex(case["responseHex"].as_str().expect("response hex"));
            if let Some(expected_modes) = case["protocolModeExpectation"].as_object() {
                let response = ProtocolResponse::new(bytes.clone());
                assert_protocol_mode_result(
                    name,
                    "simpleCommand",
                    parse_simple_command_response(&response)
                        .map(|result| result.command_tag().map(str::to_owned)),
                    &expected_modes["simpleCommand"],
                );
                assert_protocol_mode_result(
                    name,
                    "extendedCommand",
                    parse_extended_command_response(&response)
                        .map(|result| result.command_tag().map(str::to_owned)),
                    &expected_modes["extendedCommand"],
                );
                assert_protocol_mode_result(
                    name,
                    "extendedQuery",
                    parse_extended_query_response(&response)
                        .map(|result| result.command_tag().map(str::to_owned)),
                    &expected_modes["extendedQuery"],
                );
            }
            let Some(expectation) = case["queryExpectation"].as_object() else {
                continue;
            };
            match parse_query_response(&ProtocolResponse::new(bytes)) {
                Ok(result) => {
                    let expected = expectation["ok"]
                        .as_object()
                        .unwrap_or_else(|| panic!("{name}: expected parser error"));
                    assert_eq!(
                        result.command_tag(),
                        expected["commandTag"].as_str(),
                        "{name}"
                    );
                    assert_eq!(result.row_count(), expected["rowCount"].as_u64(), "{name}");
                    let fields = expected["fields"].as_array().expect("expected fields");
                    assert_eq!(result.fields().len(), fields.len(), "{name}");
                    for (actual, expected) in result.fields().iter().zip(fields) {
                        assert_eq!(actual.name, expected["name"].as_str().unwrap(), "{name}");
                        assert_eq!(
                            u64::from(actual.type_oid),
                            expected["typeOid"].as_u64().unwrap(),
                            "{name}"
                        );
                        assert_eq!(actual.format, QueryFormat::Text, "{name}");
                    }
                    let rows = expected["rows"].as_array().expect("expected rows");
                    assert_eq!(result.rows().len(), rows.len(), "{name}");
                    for (actual, expected) in result.rows().iter().zip(rows) {
                        let expected = expected.as_array().expect("expected row values");
                        assert_eq!(actual.values().len(), expected.len(), "{name}");
                        for (column, expected) in expected.iter().enumerate() {
                            assert_eq!(actual.text(column).unwrap(), expected.as_str(), "{name}");
                        }
                    }
                    if let Some(expected_notices) = expected
                        .get("notices")
                        .and_then(serde_json::Value::as_array)
                    {
                        assert_eq!(result.notices().len(), expected_notices.len(), "{name}");
                        for (actual, expected) in result.notices().iter().zip(expected_notices) {
                            assert_notice_diagnostic(name, actual, expected);
                        }
                    }
                }
                Err(error) if error.postgres_error().is_some() => {
                    let error = error
                        .postgres_error()
                        .expect("guard established PostgreSQL error identity");
                    let expected = expectation["postgresError"]
                        .as_object()
                        .unwrap_or_else(|| panic!("{name}: unexpected PostgreSQL error {error:?}"));
                    assert_eq!(
                        error.severity.as_deref(),
                        expected["severity"].as_str(),
                        "{name}"
                    );
                    assert_eq!(
                        error.sqlstate.as_deref(),
                        expected["sqlstate"].as_str(),
                        "{name}"
                    );
                    assert_eq!(
                        error.message,
                        expected["message"].as_str().unwrap(),
                        "{name}"
                    );
                    assert_optional_diagnostic_field(
                        name,
                        "localizedSeverity",
                        error.localized_severity.as_deref(),
                        expected,
                    );
                    assert_optional_diagnostic_field(
                        name,
                        "nonlocalizedSeverity",
                        error.nonlocalized_severity.as_deref(),
                        expected,
                    );
                    assert_optional_diagnostic_field(
                        name,
                        "internalPosition",
                        error.internal_position.as_deref(),
                        expected,
                    );
                    assert_optional_diagnostic_field(
                        name,
                        "internalQuery",
                        error.internal_query.as_deref(),
                        expected,
                    );
                    assert_optional_diagnostic_field(name, "file", error.file.as_deref(), expected);
                    assert_optional_diagnostic_field(name, "line", error.line.as_deref(), expected);
                    assert_optional_diagnostic_field(
                        name,
                        "routine",
                        error.routine.as_deref(),
                        expected,
                    );
                }
                Err(error) => {
                    assert_eq!(error.kind(), crate::error::ErrorKind::Other, "{name}");
                    let message = error.to_string();
                    let expected = expectation["engineErrorContains"]
                        .as_str()
                        .unwrap_or_else(|| panic!("{name}: unexpected engine error {message}"));
                    assert!(
                        message.contains(expected),
                        "{name}: {message:?} omitted {expected:?}"
                    );
                }
            }
        }
    }

    fn assert_protocol_mode_result(
        case: &str,
        mode: &str,
        actual: Result<Option<String>>,
        expected: &serde_json::Value,
    ) {
        match expected["outcome"].as_str().expect("mode outcome") {
            "ok" => assert_eq!(
                actual.unwrap_or_else(|error| panic!("{case} {mode}: {error}")),
                expected["commandTag"].as_str().map(str::to_owned),
                "{case} {mode} command tag"
            ),
            "engineError" => {
                let error = actual.expect_err(&format!("{case} {mode} must fail"));
                assert_eq!(error.kind(), crate::error::ErrorKind::Other);
                let message = error.to_string();
                let expected = expected["contains"].as_str().expect("error substring");
                assert!(
                    message.contains(expected),
                    "{case} {mode}: {message:?} omitted {expected:?}"
                );
            }
            outcome => panic!("{case} {mode}: unknown outcome {outcome:?}"),
        }
    }

    fn assert_notice_diagnostic(case: &str, actual: &PostgresNotice, expected: &serde_json::Value) {
        let expected = expected.as_object().expect("notice diagnostic expectation");
        assert_optional_diagnostic_field(case, "severity", actual.severity.as_deref(), expected);
        assert_optional_diagnostic_field(
            case,
            "localizedSeverity",
            actual.localized_severity.as_deref(),
            expected,
        );
        assert_optional_diagnostic_field(
            case,
            "nonlocalizedSeverity",
            actual.nonlocalized_severity.as_deref(),
            expected,
        );
        assert_optional_diagnostic_field(case, "message", Some(&actual.message), expected);
        assert_optional_diagnostic_field(
            case,
            "internalPosition",
            actual.internal_position.as_deref(),
            expected,
        );
        assert_optional_diagnostic_field(
            case,
            "internalQuery",
            actual.internal_query.as_deref(),
            expected,
        );
        assert_optional_diagnostic_field(case, "file", actual.file.as_deref(), expected);
        assert_optional_diagnostic_field(case, "line", actual.line.as_deref(), expected);
        assert_optional_diagnostic_field(case, "routine", actual.routine.as_deref(), expected);
    }

    fn assert_optional_diagnostic_field(
        case: &str,
        field: &str,
        actual: Option<&str>,
        expected: &serde_json::Map<String, serde_json::Value>,
    ) {
        if let Some(expected) = expected.get(field) {
            assert_eq!(actual, expected.as_str(), "{case} diagnostic {field}");
        }
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0, "hex fixture has even length");
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("hex pair is ASCII");
                u8::from_str_radix(pair, 16).expect("hex pair is valid")
            })
            .collect()
    }

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
        assert_eq!(result.row_count(), Some(1));
        assert_eq!(result.command_tag(), Some("SELECT 1"));
        assert_eq!(result.get_text(0, "value").unwrap(), Some("1"));
        assert_eq!(result.get_text(0, "empty").unwrap(), None);
    }

    #[test]
    fn typed_rows_decode_strict_text_binary_and_null_values() {
        let fields: Arc<[QueryField]> = vec![
            test_field("text_int", TypeOid::INT4, QueryFormat::Text),
            test_field("binary_int", TypeOid::INT8, QueryFormat::Binary),
            test_field("flag", TypeOid::BOOL, QueryFormat::Binary),
            test_field("text_bytes", TypeOid::BYTEA, QueryFormat::Text),
            test_field("binary_bytes", TypeOid::BYTEA, QueryFormat::Binary),
            test_field("nullable_int", TypeOid::INT4, QueryFormat::Text),
            test_field("label", TypeOid::TEXT, QueryFormat::Text),
        ]
        .into();
        let row = QueryRow {
            fields: Arc::clone(&fields),
            values: vec![
                Some(b"42".to_vec()),
                Some(9_i64.to_be_bytes().to_vec()),
                Some(vec![1]),
                Some(br"\x00ff".to_vec()),
                Some(vec![0, 255]),
                None,
                Some(b"hello".to_vec()),
            ],
        };

        assert_eq!(row.try_get::<i32, _>("text_int").unwrap(), 42);
        assert_eq!(row.try_get::<i64, _>("binary_int").unwrap(), 9);
        assert!(row.try_get::<bool, _>("flag").unwrap());
        assert_eq!(
            row.try_get::<Vec<u8>, _>("text_bytes").unwrap(),
            vec![0, 255]
        );
        assert_eq!(row.try_get::<&[u8], _>("binary_bytes").unwrap(), &[0, 255]);
        assert_eq!(row.try_get::<Option<i32>, _>("nullable_int").unwrap(), None);
        assert_eq!(row.try_get::<&str, _>("label").unwrap(), "hello");
        assert!(matches!(
            row.try_get::<Option<String>, _>("nullable_int"),
            Err(DecodeError::TypeMismatch { type_oid, .. }) if type_oid == TypeOid::INT4
        ));
        assert!(matches!(
            row.try_get::<String, _>("text_int"),
            Err(DecodeError::TypeMismatch { type_oid, .. }) if type_oid == TypeOid::INT4
        ));
    }

    #[test]
    fn every_name_lookup_rejects_duplicate_columns() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("same", 25), ("same", 25)]);
        push_data_row(&mut bytes, &[Some("first"), Some("second")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert!(
            result
                .get_text(0, "same")
                .unwrap_err()
                .to_string()
                .contains("more than one column")
        );
        assert!(matches!(
            result.rows()[0].try_get::<String, _>("same"),
            Err(DecodeError::AmbiguousColumn(name)) if name == "same"
        ));
        assert!(matches!(
            result.rows()[0].try_get_raw("same"),
            Err(DecodeError::AmbiguousColumn(name)) if name == "same"
        ));
    }

    #[test]
    fn returns_sql_errors_as_errors() {
        let mut bytes = Vec::new();
        push_error_response(&mut bytes, "ERROR", "42P01", "relation does not exist");
        push_ready_for_query(&mut bytes);

        let error = parse_query_response_bytes(&bytes).unwrap_err();
        assert_eq!(error.kind(), crate::error::ErrorKind::Postgres);
        let postgres = error
            .postgres_error()
            .expect("Postgres errors expose structured diagnostics");
        assert_eq!(postgres.severity.as_deref(), Some("ERROR"));
        assert_eq!(postgres.sqlstate.as_deref(), Some("42P01"));
        assert_eq!(postgres.message, "relation does not exist");
    }

    #[test]
    fn execute_rejects_rows_and_directs_callers_to_query() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("one", 23)]);
        push_data_row(&mut bytes, &[Some("1")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_row_description(&mut bytes, &[("two", 23)]);
        push_data_row(&mut bytes, &[Some("2")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(bytes)),
            "execute() received rows; use query()",
        );
    }

    #[test]
    fn execute_validation_returns_structured_postgres_errors() {
        let mut bytes = Vec::new();
        push_notice_response(&mut bytes, "NOTICE", "before failure");
        push_error_response(&mut bytes, "ERROR", "23505", "duplicate key value");
        push_ready_for_query(&mut bytes);

        let error = parse_command_response(&ProtocolResponse::new(bytes)).unwrap_err();
        assert_eq!(error.kind(), crate::error::ErrorKind::Postgres);
        let postgres = error
            .postgres_error()
            .expect("Postgres errors expose structured diagnostics");
        assert_eq!(postgres.sqlstate.as_deref(), Some("23505"));
        assert_eq!(postgres.message, "duplicate key value");
        assert_eq!(postgres.notices.len(), 1);
        assert_eq!(postgres.notices[0].message, "before failure");
    }

    #[test]
    fn postgres_notice_exposes_finite_standard_diagnostic_fields() {
        let notice = parse_notice_response(
            b"SAVERTISSEMENT\0VWARNING\0Mcheck value\0p12\0qSELECT broken\0Fparse_expr.c\0L123\0RtransformExpr\0\0",
        )
        .expect("valid NoticeResponse");

        assert_eq!(notice.severity.as_deref(), Some("AVERTISSEMENT"));
        assert_eq!(notice.localized_severity.as_deref(), Some("AVERTISSEMENT"));
        assert_eq!(notice.nonlocalized_severity.as_deref(), Some("WARNING"));
        assert_eq!(notice.internal_position.as_deref(), Some("12"));
        assert_eq!(notice.internal_query.as_deref(), Some("SELECT broken"));
        assert_eq!(notice.file.as_deref(), Some("parse_expr.c"));
        assert_eq!(notice.line.as_deref(), Some("123"));
        assert_eq!(notice.routine.as_deref(), Some("transformExpr"));
        assert_eq!(
            notice
                .fields
                .iter()
                .map(|field| field.code)
                .collect::<Vec<_>>(),
            [b'S', b'V', b'M', b'p', b'q', b'F', b'L', b'R']
        );
    }

    #[test]
    fn error_response_requires_one_terminal_ready_boundary() {
        let mut missing_ready = Vec::new();
        push_error_response(&mut missing_ready, "ERROR", "42601", "syntax error");
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(missing_ready)),
            "before ReadyForQuery",
        );

        let mut trailing = Vec::new();
        push_error_response(&mut trailing, "ERROR", "42601", "syntax error");
        push_ready_for_query(&mut trailing);
        push_notice_response(&mut trailing, "NOTICE", "too late");
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(trailing)),
            "bytes after ReadyForQuery",
        );
    }

    #[test]
    fn malformed_error_response_is_a_protocol_error() {
        let mut malformed = Vec::new();
        push_backend_message(&mut malformed, b'E', b"SERROR\0Mmissing terminator");
        push_ready_for_query(&mut malformed);
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(malformed)),
            "ErrorResponse field is missing null terminator",
        );

        let mut valid_without_message = Vec::new();
        push_backend_message(&mut valid_without_message, b'E', b"CXX000\0\0");
        push_ready_for_query(&mut valid_without_message);
        let sdk_error =
            parse_command_response(&ProtocolResponse::new(valid_without_message)).unwrap_err();
        assert_eq!(sdk_error.kind(), crate::error::ErrorKind::Postgres);
        let error = sdk_error
            .postgres_error()
            .expect("a valid ErrorResponse must retain PostgreSQL error identity");
        assert_eq!(error.sqlstate.as_deref(), Some("XX000"));
        assert_eq!(error.message, "PostgreSQL ErrorResponse");
    }

    #[test]
    fn exec_preserves_ordered_command_and_row_results_with_notices() {
        let mut bytes = Vec::new();
        push_notice_response(&mut bytes, "NOTICE", "table ready");
        push_command_complete(&mut bytes, "CREATE TABLE");
        push_notice_response(&mut bytes, "NOTICE", "select ready");
        push_row_description(&mut bytes, &[("answer", 23)]);
        push_data_row(&mut bytes, &[Some("42")]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        let result = parse_exec_response(&ProtocolResponse::new(bytes)).unwrap();
        assert_eq!(result.statements().len(), 2);
        let StatementResult::Command(command) = &result.statements()[0] else {
            panic!("first statement should be a command");
        };
        assert_eq!(command.command_tag(), Some("CREATE TABLE"));
        assert_eq!(command.notices()[0].message, "table ready");
        let StatementResult::Rows(rows) = &result.statements()[1] else {
            panic!("second statement should return rows");
        };
        assert_eq!(rows.rows()[0].try_get::<i32, _>("answer").unwrap(), 42);
        assert_eq!(rows.notices()[0].message, "select ready");
        assert_eq!(result.notices()[0].message, "table ready");
        assert_eq!(result.notices()[1].message, "select ready");
    }

    #[test]
    fn single_statement_parsers_require_exactly_one_completion() {
        let mut ready_only = Vec::new();
        push_ready_for_query(&mut ready_only);
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(ready_only.clone())),
            "before CommandComplete or EmptyQueryResponse",
        );
        assert_other_error_contains(
            parse_query_response_bytes(&ready_only),
            "before CommandComplete or EmptyQueryResponse",
        );

        let mut empty = Vec::new();
        push_backend_message(&mut empty, b'I', &[]);
        push_ready_for_query(&mut empty);
        let command = parse_command_response(&ProtocolResponse::new(empty.clone())).unwrap();
        assert_eq!(command.command_tag(), None);
        let query = parse_query_response_bytes(&empty).unwrap();
        assert_eq!(query.command_tag(), None);
        assert!(query.fields().is_empty());
        assert!(query.rows().is_empty());

        let mut command_then_empty = Vec::new();
        push_command_complete(&mut command_then_empty, "UPDATE 1");
        push_backend_message(&mut command_then_empty, b'I', &[]);
        push_ready_for_query(&mut command_then_empty);
        assert_other_error_contains(
            parse_query_response_bytes(&command_then_empty),
            "EmptyQueryResponse after CommandComplete",
        );

        let mut empty_then_command = Vec::new();
        push_backend_message(&mut empty_then_command, b'I', &[]);
        push_command_complete(&mut empty_then_command, "UPDATE 1");
        push_ready_for_query(&mut empty_then_command);
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(empty_then_command)),
            "CommandComplete after EmptyQueryResponse",
        );

        let mut duplicate_empty = Vec::new();
        push_backend_message(&mut duplicate_empty, b'I', &[]);
        push_backend_message(&mut duplicate_empty, b'I', &[]);
        push_ready_for_query(&mut duplicate_empty);
        assert_other_error_contains(
            parse_query_response_bytes(&duplicate_empty),
            "multiple EmptyQueryResponse",
        );
    }

    #[test]
    fn query_rejects_messages_after_completion_and_invalid_extended_order() {
        let mut row_after_completion = Vec::new();
        push_row_description(
            &mut row_after_completion,
            &[("answer", TypeOid::INT4.get())],
        );
        push_command_complete(&mut row_after_completion, "SELECT 0");
        push_data_row(&mut row_after_completion, &[Some("42")]);
        push_ready_for_query(&mut row_after_completion);
        assert_other_error_contains(
            parse_query_response_bytes(&row_after_completion),
            "DataRow after statement completion",
        );

        let mut parse_after_completion = Vec::new();
        push_command_complete(&mut parse_after_completion, "UPDATE 1");
        push_backend_message(&mut parse_after_completion, b'1', &[]);
        push_ready_for_query(&mut parse_after_completion);
        assert_other_error_contains(
            parse_query_response_bytes(&parse_after_completion),
            "ParseComplete out of order",
        );

        let mut bind_before_parse = Vec::new();
        push_backend_message(&mut bind_before_parse, b'2', &[]);
        push_backend_message(&mut bind_before_parse, b'n', &[]);
        push_command_complete(&mut bind_before_parse, "UPDATE 1");
        push_ready_for_query(&mut bind_before_parse);
        assert_other_error_contains(
            parse_query_response_bytes(&bind_before_parse),
            "BindComplete out of order",
        );

        let mut error_after_command = Vec::new();
        push_command_complete(&mut error_after_command, "UPDATE 1");
        push_error_response(&mut error_after_command, "ERROR", "XX000", "too late");
        push_ready_for_query(&mut error_after_command);
        assert_other_error_contains(
            parse_query_response_bytes(&error_after_command),
            "ErrorResponse after statement completion",
        );

        let mut error_after_empty = Vec::new();
        push_backend_message(&mut error_after_empty, b'I', &[]);
        push_error_response(&mut error_after_empty, "ERROR", "XX000", "too late");
        push_ready_for_query(&mut error_after_empty);
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(error_after_empty)),
            "ErrorResponse after statement completion",
        );

        let mut close_complete = Vec::new();
        push_backend_message(&mut close_complete, b'3', &[]);
        push_command_complete(&mut close_complete, "UPDATE 1");
        push_ready_for_query(&mut close_complete);
        assert_other_error_contains(
            parse_query_response_bytes(&close_complete),
            "unexpected backend message tag 0x33",
        );
        assert_other_error_contains(
            parse_command_response(&ProtocolResponse::new(close_complete)),
            "unexpected backend message tag 0x33",
        );
    }

    #[test]
    fn exec_accepts_but_omits_empty_statements_and_requires_a_completion() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'I', &[]);
        push_command_complete(&mut bytes, "UPDATE 1");
        push_backend_message(&mut bytes, b'I', &[]);
        push_ready_for_query(&mut bytes);

        let result = parse_exec_response(&ProtocolResponse::new(bytes)).unwrap();
        assert_eq!(result.statements().len(), 1);
        assert!(matches!(
            &result.statements()[0],
            StatementResult::Command(command) if command.command_tag() == Some("UPDATE 1")
        ));

        let mut empty = Vec::new();
        push_backend_message(&mut empty, b'I', &[]);
        push_ready_for_query(&mut empty);
        assert!(
            parse_exec_response(&ProtocolResponse::new(empty))
                .unwrap()
                .statements()
                .is_empty()
        );

        let mut ready_only = Vec::new();
        push_ready_for_query(&mut ready_only);
        assert_other_error_contains(
            parse_exec_response(&ProtocolResponse::new(ready_only)),
            "before CommandComplete or EmptyQueryResponse",
        );

        for tag in [b'1', b'2', b'3', b't', b'n'] {
            let mut extended_control = Vec::new();
            push_backend_message(&mut extended_control, tag, &[]);
            push_command_complete(&mut extended_control, "UPDATE 1");
            push_ready_for_query(&mut extended_control);
            assert_other_error_contains(
                parse_exec_response(&ProtocolResponse::new(extended_control)),
                "unexpected backend message tag",
            );
        }
    }

    #[test]
    fn describe_returns_parameter_oids_fields_and_notices() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'1', &[]);
        push_parameter_description(&mut bytes, &[TypeOid::INT4, TypeOid::TEXT]);
        push_notice_response(&mut bytes, "NOTICE", "described");
        push_row_description(&mut bytes, &[("answer", TypeOid::INT8.get())]);
        push_ready_for_query(&mut bytes);

        let description = parse_statement_description(&ProtocolResponse::new(bytes)).unwrap();
        assert_eq!(
            description.parameter_types(),
            &[TypeOid::INT4, TypeOid::TEXT]
        );
        assert_eq!(
            description.fields().unwrap()[0].type_oid_value(),
            TypeOid::INT8
        );
        assert_eq!(description.notices()[0].message, "described");
    }

    #[test]
    fn describe_requires_parse_complete_and_protocol_order() {
        let mut ready_only = Vec::new();
        push_ready_for_query(&mut ready_only);
        assert_other_error_contains(
            parse_statement_description(&ProtocolResponse::new(ready_only)),
            "omitted ParseComplete",
        );

        let mut parameter_before_parse = Vec::new();
        push_parameter_description(&mut parameter_before_parse, &[]);
        push_backend_message(&mut parameter_before_parse, b'1', &[]);
        push_backend_message(&mut parameter_before_parse, b'n', &[]);
        push_ready_for_query(&mut parameter_before_parse);
        assert_other_error_contains(
            parse_statement_description(&ProtocolResponse::new(parameter_before_parse)),
            "ParameterDescription out of order",
        );

        let mut duplicate_parse = Vec::new();
        push_backend_message(&mut duplicate_parse, b'1', &[]);
        push_backend_message(&mut duplicate_parse, b'1', &[]);
        push_parameter_description(&mut duplicate_parse, &[]);
        push_backend_message(&mut duplicate_parse, b'n', &[]);
        push_ready_for_query(&mut duplicate_parse);
        assert_other_error_contains(
            parse_statement_description(&ProtocolResponse::new(duplicate_parse)),
            "ParseComplete out of order",
        );

        let mut result_before_parameters = Vec::new();
        push_backend_message(&mut result_before_parameters, b'1', &[]);
        push_row_description(
            &mut result_before_parameters,
            &[("answer", TypeOid::INT4.get())],
        );
        push_parameter_description(&mut result_before_parameters, &[]);
        push_ready_for_query(&mut result_before_parameters);
        assert_other_error_contains(
            parse_statement_description(&ProtocolResponse::new(result_before_parameters)),
            "RowDescription out of order",
        );

        let mut error_after_result = Vec::new();
        push_backend_message(&mut error_after_result, b'1', &[]);
        push_parameter_description(&mut error_after_result, &[]);
        push_backend_message(&mut error_after_result, b'n', &[]);
        push_error_response(&mut error_after_result, "ERROR", "XX000", "too late");
        push_ready_for_query(&mut error_after_result);
        assert_other_error_contains(
            parse_statement_description(&ProtocolResponse::new(error_after_result)),
            "ErrorResponse after result description",
        );
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
        assert_eq!(error.kind(), crate::error::ErrorKind::Postgres);
        let postgres = error
            .postgres_error()
            .expect("Postgres errors expose structured cancellation diagnostics");
        assert_eq!(postgres.severity.as_deref(), Some("ERROR"));
        assert_eq!(postgres.sqlstate.as_deref(), Some("57014"));
        assert_eq!(postgres.message, "canceling statement due to user request");
    }

    #[test]
    fn rejects_invalid_utf8_in_backend_cstrings() {
        let mut bytes = Vec::new();
        push_raw_row_description(&mut bytes, &[(&[0xff], 25)]);
        push_ready_for_query(&mut bytes);

        assert_other_error_contains(
            parse_query_response_bytes(&bytes),
            "field name is not valid UTF-8",
        );
    }

    #[test]
    fn text_accessors_reject_invalid_utf8_values() {
        let mut bytes = Vec::new();
        push_row_description(&mut bytes, &[("value", 25)]);
        push_data_row_raw(&mut bytes, &[Some(&[0xff])]);
        push_command_complete(&mut bytes, "SELECT 1");
        push_ready_for_query(&mut bytes);

        let result = parse_query_response_bytes(&bytes).unwrap();
        assert_other_error_contains(
            result.get_text(0, "value"),
            "query value is not valid UTF-8",
        );
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

        assert_other_error_contains(parse_query_response_bytes(&bytes), "multiple result sets");
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

        assert_other_error_contains(
            parse_query_response_bytes(&bytes),
            "ParseComplete contained trailing bytes",
        );
    }

    #[test]
    fn rejects_malformed_async_control_messages() {
        let mut malformed_parameter = Vec::new();
        push_backend_message(&mut malformed_parameter, b'S', b"client_encoding\0");
        push_ready_for_query(&mut malformed_parameter);
        assert_other_error_contains(
            parse_query_response_bytes(&malformed_parameter),
            "ParameterStatus value is missing null terminator",
        );

        let mut malformed_notice = Vec::new();
        push_backend_message(&mut malformed_notice, b'N', b"SNOTICE\0");
        push_ready_for_query(&mut malformed_notice);
        assert_other_error_contains(
            parse_query_response_bytes(&malformed_notice),
            "NoticeResponse is missing terminator",
        );

        let mut malformed_notification = Vec::new();
        let mut body = 123_i32.to_be_bytes().to_vec();
        body.extend_from_slice(b"channel");
        push_backend_message(&mut malformed_notification, b'A', &body);
        push_ready_for_query(&mut malformed_notification);
        assert_other_error_contains(
            parse_query_response_bytes(&malformed_notification),
            "NotificationResponse channel is missing null terminator",
        );
    }

    #[test]
    fn rejects_unexpected_backend_message_tags() {
        let mut bytes = Vec::new();
        push_backend_message(&mut bytes, b'R', &[0, 0, 0, 0]);
        push_ready_for_query(&mut bytes);

        assert_other_error_contains(
            parse_query_response_bytes(&bytes),
            "unexpected backend message tag 0x52",
        );
    }

    #[test]
    fn backend_parser_is_panic_free_for_deterministic_malformed_input() {
        use std::panic::{AssertUnwindSafe, catch_unwind};

        let mut state = 0x6f6c_6970_6861_756e_u64;
        for case in 0..1_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let len = (state as usize) % 384;
            let mut bytes = Vec::with_capacity(len);
            for _ in 0..len {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                bytes.push((state >> 56) as u8);
            }
            if bytes.len() >= 5 && case % 4 == 0 {
                bytes[0] = [b'T', b'D', b'C', b'E', b'Z', b'S', b'N', b'A'][case % 8];
                let declared = ((state as usize % 256) as i32) - 32;
                bytes[1..5].copy_from_slice(&declared.to_be_bytes());
            }

            assert!(
                catch_unwind(AssertUnwindSafe(|| parse_query_response_bytes(&bytes))).is_ok(),
                "backend parser panicked for deterministic case {case}"
            );
        }
    }

    #[test]
    fn rejects_copy_and_bytes_after_ready_for_query() {
        let mut copy = Vec::new();
        push_backend_message(&mut copy, b'G', &[0, 0, 0]);
        assert_other_error_contains(parse_query_response_bytes(&copy), "does not support COPY");

        let mut trailing = Vec::new();
        push_command_complete(&mut trailing, "SELECT 0");
        push_ready_for_query(&mut trailing);
        trailing.push(0);
        assert_other_error_contains(
            parse_query_response_bytes(&trailing),
            "bytes after ReadyForQuery",
        );
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
        assert_other_error_contains(
            parse_query_response_bytes(&missing),
            "ReadyForQuery contained 0 bytes, expected 1",
        );

        let mut invalid = Vec::new();
        push_backend_message(&mut invalid, b'Z', &[0]);
        assert_other_error_contains(
            parse_query_response_bytes(&invalid),
            "ReadyForQuery contained invalid transaction status 0x00",
        );
    }

    #[test]
    fn builds_extended_query_protocol_request() {
        let params = [
            7_i32.into_parameter(),
            Some("hello").into_parameter(),
            Parameter::binary([0_u8, 1, 2]),
            None::<&str>.into_parameter(),
        ];
        let request = extended_statement_request(
            "SELECT $1::int4, $2::text, $3::bytea, $4::text",
            &params,
            ValueFormat::Text,
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
    fn typed_parameters_encode_parse_oids_formats_nulls_and_result_format() {
        let params = [
            Parameter::typed_null(TypeOid::INT4),
            7_i32.into_parameter(),
            Parameter::text("hello"),
        ];
        let request =
            extended_statement_request("SELECT $1, $2, $3", &params, ValueFormat::Binary).unwrap();
        let messages = frontend_messages(request.as_bytes());
        assert_eq!(
            messages.iter().map(|(tag, _)| *tag).collect::<Vec<_>>(),
            vec![b'P', b'B', b'D', b'E', b'S']
        );

        let mut parse = messages[0].1;
        assert_eq!(read_cstring(&mut parse, "statement").unwrap(), "");
        assert_eq!(
            read_cstring(&mut parse, "SQL").unwrap(),
            "SELECT $1, $2, $3"
        );
        assert_eq!(read_i16(&mut parse, "OID count").unwrap(), 3);
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), TypeOid::INT4.get());
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), TypeOid::INT4.get());
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), 0);
        assert!(parse.is_empty());

        let mut bind = messages[1].1;
        assert_eq!(read_cstring(&mut bind, "portal").unwrap(), "");
        assert_eq!(read_cstring(&mut bind, "statement").unwrap(), "");
        assert_eq!(read_i16(&mut bind, "format count").unwrap(), 3);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 0);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 1);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 0);
        assert_eq!(read_i16(&mut bind, "value count").unwrap(), 3);
        assert_eq!(read_i32(&mut bind, "null length").unwrap(), -1);
        assert_eq!(read_i32(&mut bind, "int length").unwrap(), 4);
        assert_eq!(take(&mut bind, 4, "int").unwrap(), &7_i32.to_be_bytes());
        assert_eq!(read_i32(&mut bind, "text length").unwrap(), 5);
        assert_eq!(take(&mut bind, 5, "text").unwrap(), b"hello");
        assert_eq!(read_i16(&mut bind, "result format count").unwrap(), 1);
        assert_eq!(read_i16(&mut bind, "result format").unwrap(), 1);
        assert!(bind.is_empty());
    }

    #[test]
    fn explicit_oid_zero_is_describe_only() {
        let parameter = Parameter::typed_text(TypeOid::new(0), "infer me");
        assert_other_error_contains(
            extended_statement_request(
                "SELECT $1",
                std::slice::from_ref(&parameter),
                ValueFormat::Text,
            ),
            "explicitly declares PostgreSQL type OID 0",
        );

        let request = describe_statement_request("SELECT $1", &[parameter])
            .expect("describe permits OID 0 as PostgreSQL inference");
        let messages = frontend_messages(request.as_bytes());
        let mut parse = messages[0].1;
        assert_eq!(read_cstring(&mut parse, "statement").unwrap(), "");
        assert_eq!(read_cstring(&mut parse, "SQL").unwrap(), "SELECT $1");
        assert_eq!(read_i16(&mut parse, "OID count").unwrap(), 1);
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), 0);
    }

    #[test]
    fn structured_sql_preflight_matches_shared_corpus() {
        let source = crate::test_fixtures::text(
            "protocol/structured-sql-cases.json",
            "testdata/structured-sql-cases.json",
        );
        let fixture: serde_json::Value =
            serde_json::from_str(&source).expect("structured SQL fixture is valid JSON");
        assert_eq!(fixture["schemaVersion"], 2);
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let name = case["name"].as_str().expect("case name");
            let sql = case["sql"].as_str().expect("case SQL");
            let expected = case["containsTopLevelCopy"]
                .as_bool()
                .expect("COPY expectation");
            assert_eq!(reject_copy_statements(sql).is_err(), expected, "{name}");
            let expected = case["containsTransactionChain"]
                .as_bool()
                .expect("transaction-chain expectation");
            assert_eq!(reject_transaction_chain(sql).is_err(), expected, "{name}");
        }
    }

    #[test]
    fn managed_transaction_wire_classifier_uses_command_tags_and_final_readiness() {
        fn response(tags: &[&str], ready: u8) -> ProtocolResponse {
            let mut bytes = Vec::new();
            for tag in tags {
                push_command_complete(&mut bytes, tag);
            }
            push_backend_message(&mut bytes, b'Z', &[ready]);
            ProtocolResponse::new(bytes)
        }

        for tag in [
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "PREPARE TRANSACTION",
            "COMMIT PREPARED",
            "ROLLBACK PREPARED",
        ] {
            assert!(
                validate_managed_transaction_response(&response(&[tag], b'T')).is_err(),
                "{tag} changes transaction ownership"
            );
        }
        assert!(validate_managed_transaction_response(&response(&["ROLLBACK"], b'I')).is_err());
        assert!(
            validate_managed_transaction_response(&response(&["COMMIT", "BEGIN"], b'T')).is_err()
        );
        for tags in [
            &["ROLLBACK"][..],
            &["SAVEPOINT"][..],
            &["RELEASE"][..],
            &["SET"][..],
            &["PREPARE"][..],
            &["CREATE FUNCTION"][..],
            &["CALL"][..],
            &["DO"][..],
        ] {
            validate_managed_transaction_response(&response(tags, b'T'))
                .expect("ordinary or savepoint-preserving command remains managed");
        }

        let mut malformed = Vec::new();
        push_backend_message(&mut malformed, b'C', b"COMMIT");
        push_backend_message(&mut malformed, b'Z', b"T");
        assert!(validate_managed_transaction_response(&ProtocolResponse::new(malformed)).is_err());
    }

    #[test]
    fn describe_allows_copy_because_it_does_not_execute() {
        describe_statement_request("COPY public.items TO STDOUT", &[])
            .expect("Parse + Describe + Sync cannot enter COPY mode");
    }

    #[test]
    fn rejects_nul_in_extended_query_sql() {
        let params = [Parameter::null()];
        assert_other_error_contains(
            extended_statement_request("SELECT '\0'", &params, ValueFormat::Text),
            "extended query SQL must not contain NUL bytes",
        );
    }

    #[test]
    fn rejects_too_many_extended_query_parameters() {
        let params = vec![Parameter::null(); i16::MAX as usize + 1];

        assert_other_error_contains(
            extended_statement_request("SELECT 1", &params, ValueFormat::Text),
            &format!(
                "extended query supports at most {} parameters, got {}",
                i16::MAX,
                i16::MAX as usize + 1,
            ),
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

    fn frontend_messages(mut bytes: &[u8]) -> Vec<(u8, &[u8])> {
        let mut messages = Vec::new();
        while !bytes.is_empty() {
            assert!(bytes.len() >= 5, "complete frontend message header");
            let tag = bytes[0];
            let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
            assert!(len >= 4, "valid frontend message length");
            let total = 1 + len as usize;
            assert!(bytes.len() >= total, "complete frontend message body");
            messages.push((tag, &bytes[5..total]));
            bytes = &bytes[total..];
        }
        messages
    }

    fn test_field(name: &str, type_oid: TypeOid, format: QueryFormat) -> QueryField {
        QueryField {
            name: name.to_owned(),
            table_oid: 0,
            table_attribute: 0,
            type_oid: type_oid.get(),
            type_size: -1,
            type_modifier: -1,
            format,
        }
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

    fn push_parameter_description(bytes: &mut Vec<u8>, types: &[TypeOid]) {
        let mut body = Vec::new();
        body.extend_from_slice(&(types.len() as i16).to_be_bytes());
        for type_oid in types {
            body.extend_from_slice(&type_oid.get().to_be_bytes());
        }
        push_backend_message(bytes, b't', &body);
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
