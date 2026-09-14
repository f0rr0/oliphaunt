use std::str;

use crate::error::{Error, PostgresError, Result};
use crate::protocol::{ProtocolRequest, ProtocolResponse};
use crate::query_core as core;

pub(crate) use crate::query_core::ReadyStatus;
pub use crate::query_core::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresNotice,
    QueryField, QueryFormat, QueryResult, QueryRow, RowIndex, StatementDescription,
    StatementResult, TypeOid, ValueFormat, ValueRef,
};

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

pub(crate) fn error_from_core(error: core::Error) -> Error {
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
        let source = crate::test_fixtures::text("protocol/query-response-cases.json");
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
        let source = crate::test_fixtures::text("protocol/structured-sql-cases.json");
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

    fn push_backend_message(bytes: &mut Vec<u8>, tag: u8, body: &[u8]) {
        bytes.push(tag);
        bytes.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        bytes.extend_from_slice(body);
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

    fn push_ready_for_query(bytes: &mut Vec<u8>) {
        push_backend_message(bytes, b'Z', b"I");
    }
}
