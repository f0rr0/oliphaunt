#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";

function gate(mode, { needs = {}, selected, required } = {}) {
  const result = spawnSync(
    process.execPath,
    [".github/scripts/check-ci-gate.mjs", mode],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NEEDS_JSON: JSON.stringify(needs),
        ...(selected === undefined ? {} : { SELECTED_JOBS_JSON: JSON.stringify(selected) }),
        ...(required === undefined ? {} : { REQUIRED_JOBS_JSON: JSON.stringify(required) }),
        GATE_LABEL: "test gate",
      },
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("selected mode accepts success and an empty selection", () => {
  assert.equal(gate("selected", { selected: [] }).status, 0);
  assert.equal(gate("selected", {
    selected: ["ios", "android", "ios"],
    needs: { android: { result: "success" }, ios: { result: "success" } },
  }).status, 0);
});

for (const result of ["skipped", "failure", "cancelled"]) {
  test(`selected mode rejects a ${result} selected job`, () => {
    const checked = gate("selected", {
      selected: ["ios"],
      needs: { ios: { result } },
    });
    assert.equal(checked.status, 1);
    assert.match(checked.output, new RegExp(`ios=${result}`));
  });
}

test("selected mode rejects a missing selected job", () => {
  const checked = gate("selected", { selected: ["ios"], needs: {} });
  assert.equal(checked.status, 1);
  assert.match(checked.output, /ios=missing/u);
});

test("selected mode rejects malformed selection input", () => {
  const checked = gate("selected", { selected: "ios" });
  assert.equal(checked.status, 1);
  assert.match(checked.output, /must be a JSON string array/u);
});

test("required mode rejects a skipped resolver", () => {
  const checked = gate("required", {
    required: ["resolve"],
    needs: { resolve: { result: "skipped" } },
  });
  assert.equal(checked.status, 1);
  assert.match(checked.output, /resolve=skipped/u);
});

test("permissive allow-skipped mode is not available", () => {
  const checked = gate("allow-skipped", {
    required: ["ios"],
    needs: { ios: { result: "skipped" } },
  });
  assert.equal(checked.status, 1);
  assert.match(checked.output, /usage: check-ci-gate\.mjs \[selected\|required\]/u);
});
