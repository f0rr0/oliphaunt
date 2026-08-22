use std::collections::HashSet;

use anyhow::{Error, Result};
use serde::Deserialize;

use super::{PostgresError, QueryFormat, parse_command_response, parse_query_response};

#[test]
fn typed_parsers_match_shared_query_fixtures() -> Result<()> {
    let fixture = crate::oliphaunt::test_fixtures::text(
        "protocol/query-response-cases.json",
        "protocol-query-response-cases.json",
    );
    let corpus: ProtocolFixtureCorpus = serde_json::from_str(&fixture)?;
    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.kind, "postgres-backend-query-response");

    let mut names = HashSet::new();
    for fixture in corpus.cases {
        assert!(
            names.insert(fixture.name.clone()),
            "duplicate shared protocol fixture {}",
            fixture.name
        );
        let bytes = decode_hex(&fixture.response_hex);
        if let Some(expected) = fixture.query_expectation.ok {
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

            if expected.fields.is_empty() && expected.rows.is_empty() {
                let result = parse_command_response(&bytes)?;
                assert_eq!(result.command_tag(), expected.command_tag.as_deref());
                assert_eq!(result.row_count(), Some(expected.row_count));
            } else {
                let error = parse_command_response(&bytes).expect_err("rows require query()");
                assert!(error.to_string().contains("execute() received rows"));
            }
        } else if let Some(expected) = fixture.query_expectation.postgres_error {
            assert_postgres_error(parse_query_response(&bytes).unwrap_err(), &expected);
            assert_postgres_error(parse_command_response(&bytes).unwrap_err(), &expected);
        } else if let Some(expected) = fixture.query_expectation.engine_error_contains {
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

fn assert_postgres_error(error: Error, expected: &PostgresErrorExpectation) {
    let error = error
        .downcast_ref::<PostgresError>()
        .expect("query parser must preserve PostgresError identity");
    assert_eq!(error.severity.as_deref(), Some(expected.severity.as_str()));
    assert_eq!(error.sqlstate.as_deref(), Some(expected.sqlstate.as_str()));
    assert_eq!(error.message, expected.message);
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
    cases: Vec<ProtocolFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFixture {
    name: String,
    response_hex: String,
    query_expectation: QueryExpectation,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldExpectation {
    name: String,
    type_oid: u32,
    format: Option<String>,
}

#[derive(Deserialize)]
struct PostgresErrorExpectation {
    severity: String,
    sqlstate: String,
    message: String,
}
