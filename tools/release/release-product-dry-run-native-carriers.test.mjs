#!/usr/bin/env bun
import path from "node:path";
import { expect, test } from "bun:test";

import { nativePayloadOptimizerArgs } from "./release-product-dry-run.mjs";

test("aggregate npm carriers validate and preserve already-qualified cross-OS payload bytes", () => {
  const stage = path.resolve("target/fixture-cross-target-stage");
  for (const [target, toolSet] of [
    ["linux-arm64-gnu", "runtime"],
    ["macos-arm64", "runtime"],
    ["windows-x64-msvc", "tools"],
  ]) {
    expect(nativePayloadOptimizerArgs(stage, target, toolSet)).toEqual([
      process.execPath,
      "tools/release/optimize_native_runtime_payload.mjs",
      "target/fixture-cross-target-stage",
      "--target",
      target,
      "--tool-set",
      toolSet,
      "--check",
    ]);
  }
});
