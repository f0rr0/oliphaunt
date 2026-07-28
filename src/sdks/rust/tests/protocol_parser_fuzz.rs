use std::panic::{AssertUnwindSafe, catch_unwind};

use oliphaunt::{Error, ProtocolRequest, ProtocolResponse, parse_query_response};

#[test]
fn backend_query_parser_is_panic_free_for_deterministic_fuzz_corpus() {
    let mut rng = DeterministicRng::new(0x6f6c_6970_6861_756e);
    for case in 0..1_000 {
        let len = rng.usize(384);
        let mut bytes = vec![0_u8; len];
        rng.fill(&mut bytes);
        if len >= 5 && case % 4 == 0 {
            bytes[0] = *[
                b'T', b'D', b'C', b'E', b'Z', b'S', b'N', b'A', b'G', b'H', b'd',
            ]
            .get(case % 11)
            .unwrap();
            let declared = rng.usize(256) as i32 - 32;
            bytes[1..5].copy_from_slice(&declared.to_be_bytes());
        }

        let parsed = catch_unwind(AssertUnwindSafe(|| {
            parse_query_response(&ProtocolResponse::new(bytes))
        }));
        assert!(
            parsed.is_ok(),
            "backend parser panicked for fuzz case {case}"
        );
    }
}

#[test]
fn backend_query_parser_rejects_mutated_valid_frames_without_panicking() {
    let valid = valid_select_one_response();
    assert!(parse_query_response(&ProtocolResponse::new(valid.clone())).is_ok());

    for mutation in mutated_frames(&valid) {
        let parsed = catch_unwind(AssertUnwindSafe(|| {
            parse_query_response(&ProtocolResponse::new(mutation.bytes))
        }));
        assert!(
            parsed.is_ok(),
            "backend parser panicked for mutation {}",
            mutation.label
        );
        match parsed.unwrap() {
            Ok(result) => {
                assert!(
                    mutation.allow_success,
                    "mutation {} unexpectedly parsed successfully: {result:?}",
                    mutation.label
                );
            }
            Err(Error::Engine(_) | Error::Postgres(_)) => {}
            Err(other) => panic!(
                "mutation {} returned non-parser error variant: {other:?}",
                mutation.label
            ),
        }
    }
}

#[test]
fn frontend_simple_query_builder_is_panic_free_for_deterministic_fuzz_corpus() {
    let mut rng = DeterministicRng::new(0x7072_6f74_6f63_6f6c);
    for case in 0..1_000 {
        let len = rng.usize(512);
        let mut bytes = vec![0_u8; len];
        rng.fill(&mut bytes);
        let sql = String::from_utf8_lossy(&bytes);
        let built = catch_unwind(AssertUnwindSafe(|| ProtocolRequest::simple_query(&sql)));
        assert!(
            built.is_ok(),
            "frontend simple-query builder panicked for fuzz case {case}"
        );
        if sql.as_bytes().contains(&0) {
            assert!(
                built.unwrap().is_err(),
                "simple-query builder accepted NUL-containing SQL in case {case}"
            );
        }
    }
}

struct Mutation {
    label: &'static str,
    bytes: Vec<u8>,
    allow_success: bool,
}

fn mutated_frames(valid: &[u8]) -> Vec<Mutation> {
    let mut cases = Vec::new();
    cases.push(Mutation {
        label: "empty",
        bytes: Vec::new(),
        allow_success: false,
    });
    cases.push(Mutation {
        label: "single trailing byte",
        bytes: vec![b'Z'],
        allow_success: false,
    });
    cases.push(Mutation {
        label: "invalid length below header",
        bytes: {
            let mut bytes = valid.to_vec();
            bytes[1..5].copy_from_slice(&3_i32.to_be_bytes());
            bytes
        },
        allow_success: false,
    });
    cases.push(Mutation {
        label: "truncated declared body",
        bytes: valid[..valid.len() - 2].to_vec(),
        allow_success: false,
    });
    cases.push(Mutation {
        label: "unexpected backend tag",
        bytes: {
            let mut bytes = valid.to_vec();
            bytes[0] = b'R';
            bytes
        },
        allow_success: false,
    });
    cases.push(Mutation {
        label: "ready before row data",
        bytes: {
            let mut bytes = valid_select_one_response();
            let ready_offset = bytes.len() - 6;
            bytes.swap(0, ready_offset);
            bytes
        },
        allow_success: false,
    });
    cases.push(Mutation {
        label: "valid notice before result",
        bytes: {
            let mut bytes = Vec::new();
            push_notice_response(&mut bytes, "NOTICE", "deterministic fuzz notice");
            bytes.extend_from_slice(valid);
            bytes
        },
        allow_success: true,
    });
    cases
}

fn valid_select_one_response() -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut row_description = Vec::new();
    row_description.extend_from_slice(&1_i16.to_be_bytes());
    row_description.extend_from_slice(b"value\0");
    row_description.extend_from_slice(&0_u32.to_be_bytes());
    row_description.extend_from_slice(&0_i16.to_be_bytes());
    row_description.extend_from_slice(&23_u32.to_be_bytes());
    row_description.extend_from_slice(&4_i16.to_be_bytes());
    row_description.extend_from_slice(&(-1_i32).to_be_bytes());
    row_description.extend_from_slice(&0_i16.to_be_bytes());
    push_backend_message(&mut bytes, b'T', &row_description);

    let mut row = Vec::new();
    row.extend_from_slice(&1_i16.to_be_bytes());
    row.extend_from_slice(&1_i32.to_be_bytes());
    row.extend_from_slice(b"1");
    push_backend_message(&mut bytes, b'D', &row);

    push_backend_message(&mut bytes, b'C', b"SELECT 1\0");
    push_backend_message(&mut bytes, b'Z', b"I");
    bytes
}

fn push_notice_response(out: &mut Vec<u8>, severity: &str, message: &str) {
    let mut body = Vec::new();
    body.push(b'S');
    body.extend_from_slice(severity.as_bytes());
    body.push(0);
    body.push(b'M');
    body.extend_from_slice(message.as_bytes());
    body.push(0);
    body.push(0);
    push_backend_message(out, b'N', &body);
}

fn push_backend_message(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    out.extend_from_slice(body);
}

struct DeterministicRng(u64);

impl DeterministicRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0
    }

    fn usize(&mut self, upper: usize) -> usize {
        if upper == 0 {
            0
        } else {
            (self.next() as usize) % upper
        }
    }

    fn fill(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            *byte = (self.next() >> 56) as u8;
        }
    }
}
