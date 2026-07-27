use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use serde::Deserialize;

use super::{messages::BackendMessage, parser::Parser};

#[test]
fn parser_matches_shared_protocol_wire_fixtures() -> Result<()> {
    let Some(path) = shared_fixture_path() else {
        eprintln!("skipping shared protocol fixtures outside the monorepo package");
        return Ok(());
    };
    let corpus: ProtocolFixtureCorpus = serde_json::from_str(&fs::read_to_string(path)?)?;
    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.kind, "postgres-backend-query-response");

    let mut names = HashSet::new();
    let mut matched = 0usize;
    for fixture in corpus.cases {
        assert!(
            names.insert(fixture.name.clone()),
            "duplicate shared protocol fixture {}",
            fixture.name
        );
        let Some(wire) = fixture.wire_expectation else {
            continue;
        };
        matched += 1;
        let messages = parse_vec_chunks(vec![decode_hex(&fixture.response_hex)])?;
        let actual = messages
            .iter()
            .map(|message| message.name().to_string())
            .collect::<Vec<_>>();
        assert_eq!(actual, wire.message_names, "fixture {}", fixture.name);
    }
    assert!(matched > 0, "shared protocol corpus had no wire fixtures");
    Ok(())
}

fn parse_vec_chunks(chunks: Vec<Vec<u8>>) -> Result<Vec<BackendMessage>> {
    let mut parser = Parser::new();
    let mut messages = Vec::new();
    for chunk in chunks {
        parser.parse(chunk.as_slice(), |message| {
            messages.push(message);
            Ok(())
        })?;
    }
    Ok(messages)
}

fn shared_fixture_path() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("OLIPHAUNT_SHARED_FIXTURES") {
        let path = PathBuf::from(root).join("protocol/query-response-cases.json");
        if path.is_file() {
            return Some(path);
        }
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/shared/fixtures/protocol/query-response-cases.json");
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
    wire_expectation: Option<WireExpectation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireExpectation {
    message_names: Vec<String>,
}
