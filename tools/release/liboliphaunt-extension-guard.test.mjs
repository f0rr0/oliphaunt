#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";

import {
  requiredCoreRuntimePaths,
  requiredRuntimeTools,
} from "./optimize_native_runtime_payload.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const GUARD = path.join(ROOT, "tools/release/liboliphaunt-extension-guard.sh");

function runEmbeddedInventoryGuard(moduleDirectory, suffix) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; oliphaunt_assert_base_embedded_modules_exact "$2" "$3"',
      "oliphaunt-embedded-inventory-test",
      GUARD,
      moduleDirectory,
      suffix,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
}

test("base embedded-module guard accepts exactly the two regular core carriers", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-embedded-modules-"));
  const modules = path.join(fixture, "modules");
  try {
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);

    mkdirSync(modules);
    const dictSnowball = path.join(modules, "dict_snowball.so");
    const plpgsql = path.join(modules, "plpgsql.so");
    writeFileSync(dictSnowball, "dict_snowball\n");
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);
    writeFileSync(plpgsql, "plpgsql\n");
    assert.equal(runEmbeddedInventoryGuard(modules, "so").status, 0);

    const stale = path.join(modules, ".stale-extension.so");
    writeFileSync(stale, "stale\n");
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);
    unlinkSync(stale);

    unlinkSync(plpgsql);
    const target = path.join(fixture, "plpgsql-target.so");
    writeFileSync(target, "linked\n");
    symlinkSync(target, plpgsql);
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);

    unlinkSync(plpgsql);
    writeFileSync(plpgsql, "plpgsql\n");
    unlinkSync(dictSnowball);
    const dictTarget = path.join(fixture, "dict-snowball-target.so");
    writeFileSync(dictTarget, "linked\n");
    symlinkSync(dictTarget, dictSnowball);
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("native runtime optimization executes and validates the complete core Snowball closure", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-runtime-optimizer-"));
  const runtime = path.join(fixture, "runtime");
  const target = "linux-x64-gnu";
  try {
    for (const tool of requiredRuntimeTools(target)) {
      const toolPath = path.join(runtime, "bin", tool);
      mkdirSync(path.dirname(toolPath), { recursive: true });
      writeFileSync(toolPath, "#!/bin/sh\nexit 0\n");
      chmodSync(toolPath, 0o755);
    }
    for (const relativePath of requiredCoreRuntimePaths(target, runtime)) {
      const file = path.join(runtime, ...relativePath.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${relativePath}\n`);
    }

    const optimize = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/release/optimize_native_runtime_payload.mjs"),
        fixture,
        "--target",
        target,
        "--tool-set",
        "runtime",
        "--no-strip",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(optimize.status, 0, optimize.stderr);

    unlinkSync(path.join(runtime, "share/postgresql/tsearch_data/english.stop"));
    const incomplete = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/release/optimize_native_runtime_payload.mjs"),
        fixture,
        "--target",
        target,
        "--tool-set",
        "runtime",
        "--check",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /missing required core runtime file .*english\.stop/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
