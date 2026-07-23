#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../../tools/test/fd-backed-spawn-sync.mjs";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WRITER = path.join(ROOT, ".github/scripts/write-affected-moon-target-matrices.mjs");

function moonStub(root, body) {
  const file = path.join(root, "moon-stub.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function invoke(stub, output) {
  const env = {
    ...process.env,
    GITHUB_OUTPUT: output,
    MOON_BASE: "",
    MOON_BIN: stub,
    MOON_HEAD: "",
  };
  return spawnSync(process.execPath, [WRITER, "check", "test"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("Node planner captures Moon JSON written at the successful child's final event-loop turn", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-affected-matrices-"));
  try {
    const document = JSON.stringify({
      tasks: {
        alpha: {
          check: { args: [], command: "node check.mjs", deps: [], id: "check", options: {}, tags: [], target: "alpha:check" },
          test: { args: [], command: "node test.mjs", deps: [], id: "test", options: {}, tags: [], target: "alpha:test" },
        },
      },
    });
    const midpoint = Math.floor(document.length / 2);
    const stub = moonStub(root, [
      `const first = ${JSON.stringify(document.slice(0, midpoint))};`,
      `const last = ${JSON.stringify(document.slice(midpoint))};`,
      "process.stdout.write(first);",
      "setImmediate(() => process.stdout.write(last));",
      "",
    ].join("\n"));
    const output = path.join(root, "github-output");
    const result = invoke(stub, output);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const values = new Map(
      readFileSync(output, "utf8").trimEnd().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    assert.equal(values.get("check_count"), "1");
    assert.equal(values.get("test_count"), "1");
    const checkRows = JSON.parse(values.get("check_matrix")).include;
    assert.equal(checkRows.length, 1);
    assert.deepEqual(JSON.parse(checkRows[0].targets_json).include.map(({ target }) => target), [
      "alpha:check",
    ]);
    assert.deepEqual(JSON.parse(values.get("test_matrix")).include.map(({ target }) => target), [
      "alpha:test",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Node planner fails closed when a successful Moon child returns partial JSON", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-affected-matrices-partial-"));
  try {
    const stub = moonStub(root, "process.stdout.write('{\"tasks\":');\n");
    const result = invoke(stub, path.join(root, "github-output"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned invalid JSON/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
