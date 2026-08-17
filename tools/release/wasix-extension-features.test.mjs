#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  extensionFeatures,
  fullEvidenceFeatures,
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

test("full WASIX evidence enables every extension feature", () => {
  const manifest = {
    extensions: [
      { "sql-name": "vector" },
      { "sql-name": "pg_trgm" },
    ],
  };

  assert.deepEqual(extensionFeatures(manifest), ["extension-pg-trgm", "extension-vector"]);
  assert.equal(
    fullEvidenceFeatures(manifest),
    "extensions,tools,extension-pg-trgm,extension-vector",
  );
});

test("full WASIX evidence rejects empty or ambiguous extension identities", () => {
  assert.throws(
    () => extensionFeatures({ extensions: [] }),
    /at least one extension/u,
  );
  assert.throws(
    () => extensionFeatures({
      extensions: [
        { "sql-name": "vector" },
        { "sql-name": "vector" },
      ],
    }),
    /repeats extension vector/u,
  );
  assert.throws(
    () => extensionFeatures({
      extensions: [{ "sql-name": "bad/name" }],
    }),
    /portable sql-name/u,
  );
});
