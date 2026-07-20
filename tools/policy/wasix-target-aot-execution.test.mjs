#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");

test("every target AOT builder executes runtime, extension, and tool machine code", () => {
  const script = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh"),
    "utf8",
  );

  const coreSmoke = script.indexOf("cargo run -p xtask -- assets smoke --core-only");
  const targetSmoke = script.indexOf("cargo test -p oliphaunt-wasix --locked --no-default-features");
  assert.ok(coreSmoke >= 0, "target AOT build must retain the core runtime smoke");
  assert.ok(targetSmoke > coreSmoke, "target-specific lifecycle execution must follow AOT generation and core smoke");
  assert.match(script, /if \[ "\$target" != "\$host" \]/u);
  assert.match(script, /OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT=/u);
  assert.match(script, /OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT=/u);
  assert.match(script, /build-extension-ci-artifacts[.]mjs/u);
  assert.match(script, /--require-wasix/u);
  assert.match(script, /oliphaunt-extension-contrib-pg18/u);
  assert.match(script, /OLIPHAUNT_WASM_AOT_VERIFY=full/u);
  assert.match(script, /OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT=/u);
  assert.match(script, /--features extension-uuid-ossp,tools/u);
  assert.match(script, /--lib candidate_tests::uuid_ossp_candidate/u);
  assert.match(script, /--nocapture --test-threads=1/u);
});

test("WASIX extension lifecycle tests fail when requested archives are absent", () => {
  const source = readFileSync(
    path.join(
      ROOT,
      "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/extensions.rs",
    ),
    "utf8",
  );

  assert.match(source, /fn embedded_extension_archives\(extensions: &\[Extension\]\) -> Result<Vec<Extension>>/u);
  assert.match(source, /required WASIX extension archives are not embedded/u);
  assert.doesNotMatch(source, /skipping extension smoke/u);
  assert.equal(
    (source.match(/embedded_extension_archives\(extensions\)\?/gu) ?? []).length,
    4,
    "direct, server, materialization, and dump/restore paths must all propagate missing-archive failures",
  );
});

test("portable WASIX tools invalidate source-only Cargo cache entries when payloads appear", () => {
  const source = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/tools/build.rs"),
    "utf8",
  );

  assert.match(source, /emit_expected_asset_inputs\(\);/u);
  assert.match(source, /target\/oliphaunt-wasix\/assets/u);
  assert.match(source, /bin\/pg_dump[.]wasix[.]wasm/u);
  assert.match(source, /bin\/psql[.]wasix[.]wasm/u);
});
