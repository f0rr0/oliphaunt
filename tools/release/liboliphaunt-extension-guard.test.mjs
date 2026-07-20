#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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

test("base embedded-module guard accepts only one regular plpgsql carrier", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-embedded-modules-"));
  const modules = path.join(fixture, "modules");
  try {
    assert.notEqual(runEmbeddedInventoryGuard(modules, "so").status, 0);

    mkdirSync(modules);
    const plpgsql = path.join(modules, "plpgsql.so");
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
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("all desktop packagers enforce the exact base embedded-module inventory", () => {
  for (const [script, suffix] of [
    ["package-liboliphaunt-linux-assets.sh", "so"],
    ["package-liboliphaunt-macos-assets.sh", "dylib"],
  ]) {
    const source = readFileSync(path.join(ROOT, "tools/release", script), "utf8");
    assert.ok(
      source.includes(`oliphaunt_assert_base_embedded_modules_exact "$embedded_modules" ${suffix}`),
      `${script} must enforce the exact ${suffix} embedded-module inventory`,
    );
  }

  const windows = readFileSync(
    path.join(ROOT, "tools/release/package-liboliphaunt-windows-assets.ps1"),
    "utf8",
  );
  assert.match(windows, /Get-ChildItem -LiteralPath \$EmbeddedModules -Force/u);
  assert.match(windows, /\$EmbeddedModuleEntries\.Count -ne 1/u);
  assert.match(windows, /Name -cne "plpgsql\.dll"/u);
  assert.match(windows, /FileAttributes\]::ReparsePoint/u);
});

test("desktop producers remove non-release embedded-module build outputs", () => {
  const linux = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh"),
    "utf8",
  );
  assert.match(linux, /! -name plpgsql\.so -exec rm -rf \{\} \+/u);
  assert.match(linux, /base_embedded_module_closure_ready/u);

  const macos = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"),
    "utf8",
  );
  assert.match(macos, /! -name plpgsql\.dylib -exec rm -rf \{\} \+/u);
  assert.match(macos, /base_embedded_module_closure_ready/u);

  const windows = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1"),
    "utf8",
  );
  assert.match(windows, /function Remove-EmbeddedModuleStage/u);
  assert.match(windows, /Remove-EmbeddedModuleStage\s+New-Item -ItemType Directory/u);
  assert.match(
    windows,
    /foreach \(\$module in \$selectedModules\)[\s\S]*?Join-Path \$EmbeddedModulesDir "\$\(\$module\.Stem\)\.dll"/u,
  );
  assert.doesNotMatch(windows, /IMPLIB:\$\(Join-Path \$EmbeddedModulesDir "plpgsql\.lib"\)/u);
  assert.doesNotMatch(windows, /PDB:\$\(Join-Path \$EmbeddedModulesDir "plpgsql\.pdb"\)/u);
});
