#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  fullEvidenceFeatures,
  promotedExtensionFeatures,
} from "./wasix-extension-features.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("the live WASIX public surface includes the PostGIS product", () => {
  const manifest = JSON.parse(readFileSync(
    path.join(ROOT, "src/extensions/generated/wasix/extensions.json"),
    "utf8",
  ));
  assert.equal(manifest.extensions.some((row) => row["sql-name"] === "postgis"), true);

  for (const relative of [
    "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
    "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
  ]) {
    const cargo = Bun.TOML.parse(readFileSync(path.join(ROOT, relative), "utf8"));
    assert.equal(Object.hasOwn(cargo.features ?? {}, "extension-postgis"), true, relative);
  }
});

test("full WASIX evidence enables every and only promoted extension feature", () => {
  const manifest = {
    extensions: [
      { "sql-name": "vector", "smoke-status": { promoted: true } },
      { "sql-name": "pg_trgm", "smoke-status": { promoted: true } },
      { "sql-name": "candidate_only", "smoke-status": { promoted: false } },
    ],
  };

  assert.deepEqual(promotedExtensionFeatures(manifest), ["extension-pg-trgm", "extension-vector"]);
  assert.equal(
    fullEvidenceFeatures(manifest),
    "extensions,tools,extension-pg-trgm,extension-vector",
  );
});

test("full WASIX evidence rejects empty or ambiguous promoted extension identities", () => {
  assert.throws(
    () => promotedExtensionFeatures({ extensions: [] }),
    /at least one promoted extension/u,
  );
  assert.throws(
    () => promotedExtensionFeatures({
      extensions: [
        { "sql-name": "vector", "smoke-status": { promoted: true } },
        { "sql-name": "vector", "smoke-status": { promoted: true } },
      ],
    }),
    /repeats promoted extension vector/u,
  );
  assert.throws(
    () => promotedExtensionFeatures({
      extensions: [{ "sql-name": "bad/name", "smoke-status": { promoted: true } }],
    }),
    /portable sql-name/u,
  );
});
