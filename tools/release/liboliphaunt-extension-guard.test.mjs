#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  chmodSync,
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
  assert.match(windows, /"dict_snowball\.dll", "plpgsql\.dll"/u);
  assert.match(windows, /Compare-Object -ReferenceObject \$ExpectedEmbeddedModuleNames/u);
  assert.match(windows, /FileAttributes\]::ReparsePoint/u);
});

test("both npm release paths require every embedded core module member", () => {
  for (const script of ["local-registry-publish.mjs", "release-product-dry-run.mjs"]) {
    const source = readFileSync(path.join(ROOT, "tools/release", script), "utf8");
    assert.match(
      source,
      /return \["dict_snowball", "plpgsql"\]\.map\(\(stem\) => `\$\{normalizedPrefix\}\/\$\{stem\}\$\{suffix\}`\)/u,
    );
    assert.match(
      source,
      /\.\.\.embeddedCoreModuleMembers\(target\.target, "package\/lib\/modules"\)/u,
    );
    assert.match(source, /requiredCoreRuntimePaths\(target\.target\)/u);
    assert.match(source, /\.\.\.coreRuntimeMembers/u);
  }
});

test("desktop producers remove non-release embedded-module build outputs", () => {
  const linux = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh"),
    "utf8",
  );
  assert.match(linux, /! -name dict_snowball\.so ! -name plpgsql\.so -exec rm -rf \{\} \+/u);
  assert.match(linux, /build_embedded_dict_snowball_module/u);
  assert.match(linux, /base_embedded_module_closure_ready/u);

  const macos = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"),
    "utf8",
  );
  assert.match(macos, /! -name dict_snowball\.dylib ! -name plpgsql\.dylib -exec rm -rf \{\} \+/u);
  assert.match(macos, /build_embedded_dict_snowball_module/u);
  assert.match(macos, /base_embedded_module_closure_ready/u);

  const windows = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1"),
    "utf8",
  );
  assert.match(windows, /function Remove-EmbeddedModuleStage/u);
  assert.match(windows, /Remove-EmbeddedModuleStage\s+New-Item -ItemType Directory/u);
  assert.match(windows, /\$EmbeddedCoreModuleStems = @\("dict_snowball", "plpgsql"\)/u);
  assert.match(
    windows,
    /foreach \(\$module in \$selectedModules\)[\s\S]*?Join-Path \$EmbeddedModulesDir "\$\(\$module\.Stem\)\.dll"/u,
  );
  assert.doesNotMatch(windows, /IMPLIB:\$\(Join-Path \$EmbeddedModulesDir "plpgsql\.lib"\)/u);
  assert.doesNotMatch(windows, /PDB:\$\(Join-Path \$EmbeddedModulesDir "plpgsql\.pdb"\)/u);
});

test("desktop runtime readiness requires the complete canonical Snowball payload", () => {
  const stopwords = [
    "danish.stop",
    "dutch.stop",
    "english.stop",
    "finnish.stop",
    "french.stop",
    "german.stop",
    "hungarian.stop",
    "italian.stop",
    "nepali.stop",
    "norwegian.stop",
    "portuguese.stop",
    "russian.stop",
    "spanish.stop",
    "swedish.stop",
    "turkish.stop",
  ];
  const producers = [
    ["build-postgres18-linux.sh", "dict_snowball.so", "snowball_runtime_ready"],
    ["build-postgres18-macos.sh", "dict_snowball.dylib", "snowball_runtime_ready"],
    ["build-postgres18-windows.ps1", "dict_snowball.dll", "Test-SnowballRuntimeClosure"],
  ];

  for (const [script, module, readiness] of producers) {
    const source = readFileSync(
      path.join(ROOT, "src/runtimes/liboliphaunt/native/bin", script),
      "utf8",
    );
    assert.ok(source.includes(module), `${script} must require ${module}`);
    assert.ok(source.includes("snowball_create.sql"), `${script} must require snowball_create.sql`);
    assert.ok(source.includes(readiness), `${script} must expose and invoke ${readiness}`);
    for (const stopword of stopwords) {
      assert.ok(source.includes(stopword), `${script} must require ${stopword}`);
    }
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
