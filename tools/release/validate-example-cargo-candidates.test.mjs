import assert from "node:assert/strict";
import test from "node:test";

import { EXAMPLE_CARGO_REGISTRY_SOURCE } from "./example-cargo-registry.mjs";
import { validateCandidateMetadata } from "./validate-example-cargo-candidates.mjs";

const candidates = [
  "oliphaunt-wasix",
  "oliphaunt-wasix-tools",
  "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
  "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
].map((name, index) => ({
  name,
  vers: "0.1.0",
  cksum: `${index + 1}`.repeat(64),
}));

function metadataFor(rows) {
  return {
    packages: rows.map((row) => ({
      id: `${row.name}@${row.vers}`,
      name: row.name,
      version: row.vers,
      source: EXAMPLE_CARGO_REGISTRY_SOURCE,
      checksum: row.cksum,
    })),
    resolve: {
      nodes: rows.map((row) => ({ id: `${row.name}@${row.vers}`, dependencies: [], deps: [], features: [] })),
    },
  };
}

test("full metadata validation accepts exact resolved candidates", () => {
  const metadata = metadataFor(candidates);
  // Cargo reports null checksums for source-replaced registries; Cargo.lock is
  // the authoritative checksum carrier and is validated separately.
  metadata.packages[0].checksum = null;
  assert.deepEqual(
    validateCandidateMetadata("wasix-tauri-sqlx", metadata, candidates),
    { packages: 4, resolvedNodes: 4, resolvedCandidates: 4 },
  );
});

test("full metadata validation rejects silent crates.io fallback", () => {
  const metadata = metadataFor(candidates);
  metadata.packages[0].source = "registry+https://github.com/rust-lang/crates.io-index";
  assert.throws(
    () => validateCandidateMetadata("wasix-tauri-sqlx", metadata, candidates),
    /resolved selected candidate oliphaunt-wasix@0[.]1[.]0 from registry\+https/u,
  );
});

test("full metadata validation fails closed when a required resolved package is absent", () => {
  assert.throws(
    () => validateCandidateMetadata("wasix-tauri-sqlx", metadataFor(candidates.slice(1)), candidates),
    /expected exactly one resolved oliphaunt-wasix package, found 0/u,
  );
});
