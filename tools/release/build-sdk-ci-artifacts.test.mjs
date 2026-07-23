import assert from "node:assert/strict";
import test from "node:test";

import { parsePnpmPackOutput } from "./sdk-artifacts/npm.mjs";

test("parses object and single-entry array pnpm pack envelopes", () => {
  const object = parsePnpmPackOutput('{"filename":"oliphaunt.tgz","name":"@oliphaunt/sdk"}');
  assert.equal(object.manifest.filename, "oliphaunt.tgz");
  assert.equal(Array.isArray(object.envelope), false);

  const array = parsePnpmPackOutput('[{"filename":"oliphaunt.tgz"}]');
  assert.equal(array.manifest.filename, "oliphaunt.tgz");
  assert.equal(Array.isArray(array.envelope), true);
});

test("accepts lifecycle output before the final pnpm JSON envelope", () => {
  const parsed = parsePnpmPackOutput(
    'verify-ios-package.mjs: verified selection-neutral package contract\n[\n  {"filename":"oliphaunt-react-native.tgz"}\n]\n',
  );
  assert.equal(parsed.manifest.filename, "oliphaunt-react-native.tgz");
});

test("rejects missing, malformed, and non-package JSON output", () => {
  assert.throws(() => parsePnpmPackOutput(""), /produced no output/u);
  assert.throws(() => parsePnpmPackOutput("prepack complete\n{not json}"), /found 0/u);
  assert.throws(() => parsePnpmPackOutput('{"name":"missing-filename"}'), /found 0/u);
  assert.throws(
    () => parsePnpmPackOutput('[{"filename":"one.tgz"},{"filename":"two.tgz"}]'),
    /found 0/u,
  );
});

test("rejects multiple package envelopes instead of selecting the last filename", () => {
  assert.throws(
    () => parsePnpmPackOutput('{"filename":"stale.tgz"}\n{"filename":"selected.tgz"}'),
    /more than one JSON package envelope/u,
  );
});
