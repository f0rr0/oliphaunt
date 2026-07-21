use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use oliphaunt::{Error, ProtocolResponse, QueryFormat, parse_query_response};
use serde::Deserialize;

#[test]
fn query_parser_matches_shared_protocol_fixtures() {
    let Some(path) = shared_fixture_path() else {
        eprintln!("skipping shared protocol fixtures outside the monorepo package");
        return;
    };
    let corpus: ProtocolFixtureCorpus =
        serde_json::from_str(&fs::read_to_string(&path).expect("read shared protocol fixtures"))
            .expect("parse shared protocol fixtures");

    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.kind, "postgres-backend-query-response");
    assert!(!corpus.cases.is_empty(), "shared protocol corpus is empty");

    let mut names = HashSet::new();
    for fixture in &corpus.cases {
        assert!(
            names.insert(fixture.name.clone()),
            "duplicate shared protocol fixture {}",
            fixture.name
        );
        let Some(expectation) = &fixture.query_expectation else {
            continue;
        };
        let bytes = decode_hex(&fixture.response_hex);
        match expectation {
            QueryExpectation {
                ok: Some(expected), ..
            } => assert_ok_fixture(fixture, expected, &bytes),
            QueryExpectation {
                postgres_error: Some(expected),
                ..
            } => assert_postgres_error_fixture(fixture, expected, &bytes),
            QueryExpectation {
                engine_error_contains: Some(expected),
                ..
            } => assert_engine_error_fixture(fixture, expected, &bytes),
            _ => panic!(
                "shared protocol fixture {} has no query expectation",
                fixture.name
            ),
        }
    }
}

fn assert_ok_fixture(fixture: &ProtocolFixtureCase, expected: &OkExpectation, bytes: &[u8]) {
    let result = parse_query_response(&ProtocolResponse::new(bytes.to_vec()))
        .unwrap_or_else(|err| panic!("fixture {} failed to parse: {err:?}", fixture.name));

    assert_eq!(
        result.row_count(),
        expected.row_count,
        "fixture {} row count",
        fixture.name
    );
    assert_eq!(
        result.command_tag(),
        expected.command_tag.as_deref(),
        "fixture {} command tag",
        fixture.name
    );
    assert_eq!(
        result.fields().len(),
        expected.fields.len(),
        "fixture {} field count",
        fixture.name
    );
    assert_eq!(
        result.rows().len(),
        expected.rows.len(),
        "fixture {} row vector length",
        fixture.name
    );

    for (index, expected_field) in expected.fields.iter().enumerate() {
        let actual = &result.fields()[index];
        assert_eq!(
            actual.name, expected_field.name,
            "fixture {} field name",
            fixture.name
        );
        assert_eq!(
            actual.type_oid, expected_field.type_oid,
            "fixture {} field type OID",
            fixture.name
        );
        if expected_field.format.as_deref() == Some("text") {
            assert_eq!(
                actual.format,
                QueryFormat::Text,
                "fixture {} field format",
                fixture.name
            );
        }
    }

    for (row_index, expected_row) in expected.rows.iter().enumerate() {
        assert_eq!(
            expected_row.len(),
            expected.fields.len(),
            "fixture {} expected row width",
            fixture.name
        );
        for (column_index, expected_value) in expected_row.iter().enumerate() {
            let field = &expected.fields[column_index];
            assert_eq!(
                result.get_text(row_index, &field.name).unwrap(),
                expected_value.as_deref(),
                "fixture {} row {row_index} column {}",
                fixture.name,
                field.name
            );
        }
    }
}

fn assert_postgres_error_fixture(
    fixture: &ProtocolFixtureCase,
    expected: &PostgresErrorExpectation,
    bytes: &[u8],
) {
    match parse_query_response(&ProtocolResponse::new(bytes.to_vec())) {
        Err(Error::Postgres(error)) => {
            assert_eq!(
                error.severity.as_deref(),
                Some(expected.severity.as_str()),
                "fixture {} severity",
                fixture.name
            );
            assert_eq!(
                error.sqlstate.as_deref(),
                Some(expected.sqlstate.as_str()),
                "fixture {} SQLSTATE",
                fixture.name
            );
            assert_eq!(
                error.message, expected.message,
                "fixture {} message",
                fixture.name
            );
        }
        other => panic!(
            "fixture {} expected PostgreSQL error, got {other:?}",
            fixture.name
        ),
    }
}

fn assert_engine_error_fixture(fixture: &ProtocolFixtureCase, expected: &str, bytes: &[u8]) {
    match parse_query_response(&ProtocolResponse::new(bytes.to_vec())) {
        Err(Error::Engine(message)) => assert!(
            message.contains(expected),
            "fixture {} engine error {message:?} did not contain {expected:?}",
            fixture.name
        ),
        other => panic!(
            "fixture {} expected engine error, got {other:?}",
            fixture.name
        ),
    }
}

fn shared_fixture_path() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("OLIPHAUNT_SHARED_FIXTURES") {
        let path = PathBuf::from(root).join("protocol/query-response-cases.json");
        if path.is_file() {
            return Some(path);
        }
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../shared/fixtures/protocol/query-response-cases.json");
    path.is_file().then_some(path)
}

fn decode_hex(hex: &str) -> Vec<u8> {
    let compact = hex
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    assert!(
        compact.len() % 2 == 0,
        "hex fixture must have an even digit count"
    );
    (0..compact.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&compact[index..index + 2], 16)
                .expect("hex fixture contains invalid byte")
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFixtureCorpus {
    schema_version: u32,
    kind: String,
    cases: Vec<ProtocolFixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFixtureCase {
    name: String,
    response_hex: String,
    query_expectation: Option<QueryExpectation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryExpectation {
    ok: Option<OkExpectation>,
    postgres_error: Option<PostgresErrorExpectation>,
    engine_error_contains: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OkExpectation {
    fields: Vec<FieldExpectation>,
    rows: Vec<Vec<Option<String>>>,
    command_tag: Option<String>,
    row_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldExpectation {
    name: String,
    type_oid: u32,
    format: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PostgresErrorExpectation {
    severity: String,
    sqlstate: String,
    message: String,
}
