use std::collections::HashSet;

use anyhow::{Error, Result};
use serde::Deserialize;

use super::{
    PostgresError, PostgresNotice, QueryFormat, TypeOid, parse_command_response,
    parse_extended_command_response, parse_extended_query_response, parse_query_response,
    parse_simple_command_response,
};

#[test]
fn typed_parsers_match_shared_query_fixtures() -> Result<()> {
    let fixture = crate::oliphaunt::test_fixtures::text(
        "protocol/query-response-cases.json",
        "protocol-query-response-cases.json",
    );
    let corpus: ProtocolFixtureCorpus = serde_json::from_str(&fixture)?;
    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.kind, "postgres-backend-query-response");
    assert_eq!(corpus.type_oids.xml_array, TypeOid::XML_ARRAY.get());
    assert_eq!(corpus.type_oids.char_array, TypeOid::CHAR_ARRAY.get());
    assert_eq!(corpus.type_oids.name_array, TypeOid::NAME_ARRAY.get());
    assert_eq!(corpus.type_oids.timetz, TypeOid::TIMETZ.get());
    assert_eq!(corpus.type_oids.timetz_array, TypeOid::TIMETZ_ARRAY.get());

    let mut names = HashSet::new();
    for fixture in corpus.cases {
        assert!(
            names.insert(fixture.name.clone()),
            "duplicate shared protocol fixture {}",
            fixture.name
        );
        let bytes = decode_hex(&fixture.response_hex);
        if let Some(expected) = &fixture.protocol_mode_expectation {
            assert_protocol_mode_result(
                &fixture.name,
                "simpleCommand",
                parse_simple_command_response(&bytes)
                    .map(|result| result.command_tag().map(str::to_owned)),
                &expected.simple_command,
            );
            assert_protocol_mode_result(
                &fixture.name,
                "extendedCommand",
                parse_extended_command_response(&bytes)
                    .map(|result| result.command_tag().map(str::to_owned)),
                &expected.extended_command,
            );
            assert_protocol_mode_result(
                &fixture.name,
                "extendedQuery",
                parse_extended_query_response(&bytes)
                    .map(|result| result.command_tag().map(str::to_owned)),
                &expected.extended_query,
            );
        }
        let Some(query_expectation) = fixture.query_expectation else {
            continue;
        };
        if let Some(expected) = query_expectation.ok {
            let result = parse_query_response(&bytes)?;
            assert_eq!(result.command_tag(), expected.command_tag.as_deref());
            assert_eq!(result.row_count(), Some(expected.row_count));
            assert_eq!(result.fields().len(), expected.fields.len());
            assert_eq!(result.rows().len(), expected.rows.len());
            for (actual, expected) in result.fields().iter().zip(&expected.fields) {
                assert_eq!(actual.name, expected.name);
                assert_eq!(actual.type_oid, expected.type_oid);
                if expected.format.as_deref() == Some("text") {
                    assert_eq!(actual.format, QueryFormat::Text);
                }
            }
            for (actual, expected) in result.rows().iter().zip(&expected.rows) {
                for (column, expected) in expected.iter().enumerate() {
                    assert_eq!(actual.text(column)?, expected.as_deref());
                }
            }
            if let Some(expected_notices) = &expected.notices {
                assert_eq!(result.notices().len(), expected_notices.len());
                for (actual, expected) in result.notices().iter().zip(expected_notices) {
                    assert_notice_diagnostic(&fixture.name, actual, expected);
                }
            }

            if expected.fields.is_empty() && expected.rows.is_empty() {
                let result = parse_command_response(&bytes)?;
                assert_eq!(result.command_tag(), expected.command_tag.as_deref());
                assert_eq!(result.row_count(), Some(expected.row_count));
            } else {
                let error = parse_command_response(&bytes).expect_err("rows require query()");
                assert!(error.to_string().contains("execute() received rows"));
            }
        } else if let Some(expected) = query_expectation.postgres_error {
            assert_postgres_error(parse_query_response(&bytes).unwrap_err(), &expected);
            assert_postgres_error(parse_command_response(&bytes).unwrap_err(), &expected);
        } else if let Some(expected) = query_expectation.engine_error_contains {
            let query_error = parse_query_response(&bytes).expect_err("query must fail");
            assert!(
                query_error.to_string().contains(&expected),
                "fixture {} query error {:?} did not contain {:?}",
                fixture.name,
                query_error,
                expected
            );
            let command_error = parse_command_response(&bytes).expect_err("command must fail");
            assert!(
                command_error.to_string().contains(&expected),
                "fixture {} command error {:?} did not contain {:?}",
                fixture.name,
                command_error,
                expected
            );
        } else {
            panic!("fixture {} has no query expectation", fixture.name);
        }
    }
    assert!(!names.is_empty(), "shared protocol corpus is empty");
    Ok(())
}

fn assert_protocol_mode_result(
    case: &str,
    mode: &str,
    actual: Result<Option<String>>,
    expected: &ProtocolModeResultExpectation,
) {
    match expected.outcome.as_str() {
        "ok" => assert_eq!(
            actual.unwrap_or_else(|error| panic!("{case} {mode}: {error}")),
            expected.command_tag.clone(),
            "{case} {mode} command tag"
        ),
        "engineError" => {
            let error = actual.expect_err(&format!("{case} {mode} must fail"));
            let expected = expected.contains.as_deref().expect("error substring");
            assert!(
                error.to_string().contains(expected),
                "{case} {mode}: {error:?} omitted {expected:?}"
            );
        }
        outcome => panic!("{case} {mode}: unknown outcome {outcome:?}"),
    }
}

fn assert_postgres_error(error: Error, expected: &PostgresErrorExpectation) {
    let error = error
        .downcast_ref::<PostgresError>()
        .expect("query parser must preserve PostgresError identity");
    assert_eq!(error.severity.as_deref(), Some(expected.severity.as_str()));
    assert_eq!(
        error.localized_severity.as_deref(),
        expected.localized_severity.as_deref()
    );
    assert_eq!(
        error.nonlocalized_severity.as_deref(),
        expected.nonlocalized_severity.as_deref()
    );
    assert_eq!(error.sqlstate.as_deref(), Some(expected.sqlstate.as_str()));
    assert_eq!(error.message, expected.message);
    assert_eq!(
        error.internal_position.as_deref(),
        expected.internal_position.as_deref()
    );
    assert_eq!(
        error.internal_query.as_deref(),
        expected.internal_query.as_deref()
    );
    assert_eq!(error.file.as_deref(), expected.file.as_deref());
    assert_eq!(error.line.as_deref(), expected.line.as_deref());
    assert_eq!(error.routine.as_deref(), expected.routine.as_deref());
}

fn assert_notice_diagnostic(case: &str, actual: &PostgresNotice, expected: &NoticeExpectation) {
    assert_eq!(
        actual.severity.as_deref(),
        Some(expected.severity.as_str()),
        "{case}"
    );
    assert_eq!(
        actual.localized_severity.as_deref(),
        expected.localized_severity.as_deref(),
        "{case}"
    );
    assert_eq!(
        actual.nonlocalized_severity.as_deref(),
        expected.nonlocalized_severity.as_deref(),
        "{case}"
    );
    assert_eq!(actual.message, expected.message, "{case}");
    assert_eq!(
        actual.internal_position.as_deref(),
        expected.internal_position.as_deref(),
        "{case}"
    );
    assert_eq!(
        actual.internal_query.as_deref(),
        expected.internal_query.as_deref(),
        "{case}"
    );
    assert_eq!(actual.file.as_deref(), expected.file.as_deref(), "{case}");
    assert_eq!(actual.line.as_deref(), expected.line.as_deref(), "{case}");
    assert_eq!(
        actual.routine.as_deref(),
        expected.routine.as_deref(),
        "{case}"
    );
}

fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(
        hex.len() % 2,
        0,
        "hex fixture must have an even digit count"
    );
    (0..hex.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .expect("hex fixture contains invalid byte")
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFixtureCorpus {
    schema_version: u32,
    kind: String,
    type_oids: TypeOidExpectations,
    cases: Vec<ProtocolFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeOidExpectations {
    xml_array: u32,
    char_array: u32,
    name_array: u32,
    timetz: u32,
    timetz_array: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFixture {
    name: String,
    response_hex: String,
    query_expectation: Option<QueryExpectation>,
    protocol_mode_expectation: Option<ProtocolModeExpectation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolModeExpectation {
    simple_command: ProtocolModeResultExpectation,
    extended_command: ProtocolModeResultExpectation,
    extended_query: ProtocolModeResultExpectation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolModeResultExpectation {
    outcome: String,
    command_tag: Option<String>,
    contains: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryExpectation {
    ok: Option<OkExpectation>,
    postgres_error: Option<PostgresErrorExpectation>,
    engine_error_contains: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OkExpectation {
    fields: Vec<FieldExpectation>,
    rows: Vec<Vec<Option<String>>>,
    command_tag: Option<String>,
    row_count: u64,
    notices: Option<Vec<NoticeExpectation>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldExpectation {
    name: String,
    type_oid: u32,
    format: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostgresErrorExpectation {
    severity: String,
    localized_severity: Option<String>,
    nonlocalized_severity: Option<String>,
    sqlstate: String,
    message: String,
    internal_position: Option<String>,
    internal_query: Option<String>,
    file: Option<String>,
    line: Option<String>,
    routine: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeExpectation {
    severity: String,
    localized_severity: Option<String>,
    nonlocalized_severity: Option<String>,
    message: String,
    internal_position: Option<String>,
    internal_query: Option<String>,
    file: Option<String>,
    line: Option<String>,
    routine: Option<String>,
}
