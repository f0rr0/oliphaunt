#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./release-graph.mjs";

const IOS_BUILD_SCRIPTS = [
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
];

const REQUIRED_GENERATED_HEADERS = [
  "src/include/catalog/pg_proc_d.h",
  "src/include/catalog/schemapg.h",
  "src/include/nodes/nodetags.h",
  "src/include/storage/lwlocknames.h",
  "src/include/utils/errcodes.h",
  "src/include/utils/fmgroids.h",
  "src/include/utils/fmgrprotos.h",
  "src/include/utils/wait_event_types.h",
];

const REQUIRED_GENERATOR_STAMPS = [
  "src/include/catalog/bki-stamp",
  "src/include/nodes/header-stamp",
  "src/include/utils/header-stamp",
];

const INVALIDATED_GENERATOR_OUTPUTS = [
  "src/backend/nodes/node-support-stamp",
  "src/backend/storage/lmgr/lwlocknames.h",
  "src/backend/utils/errcodes.h",
  "src/backend/utils/fmgr-stamp",
  "src/include/catalog/bki-stamp",
  "src/include/nodes/header-stamp",
  "src/include/utils/header-stamp",
];

function buildBranch(source, script) {
  const match = source.match(/case "\$script_mode" in\s+build\)([\s\S]*?)\n\s*;;/u);
  assert.ok(match, `${script} must retain an explicit build branch`);
  return match[1];
}

function functionBody(source, script, name) {
  const match = source.match(new RegExp(`(?:^|\\n)${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(match, `${script} must retain ${name}`);
  return match[1];
}

function arrayBody(source, script, name) {
  const match = source.match(new RegExp(`(?:^|\\n)${name}=\\(([\\s\\S]*?)\\n\\)`, "u"));
  assert.ok(match, `${script} must retain ${name}`);
  return match[1];
}

for (const script of IOS_BUILD_SCRIPTS) {
  test(`${script} enforces generated headers before PostgreSQL compilation`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const branch = buildBranch(source, script);
    const resetIndex = branch.indexOf(': > "$make_log"');
    const configureIndex = branch.indexOf("configure_source");
    const generatedIndex = branch.indexOf("build_generated_headers");
    const supportIndex = branch.indexOf("build_support_libraries");
    const backendIndex = branch.indexOf("build_backend_objects");

    for (const [label, index] of [
      ["configure PostgreSQL", configureIndex],
      ["initialize the native build log", resetIndex],
      ["generate PostgreSQL headers", generatedIndex],
      ["build PostgreSQL support libraries", supportIndex],
      ["build PostgreSQL backend objects", backendIndex],
    ]) {
      assert.notEqual(index, -1, `${script} must ${label}`);
    }
    assert.ok(
      configureIndex < resetIndex &&
        resetIndex < generatedIndex &&
        generatedIndex < supportIndex &&
        supportIndex < backendIndex,
      `${script} must configure, initialize diagnostics, generate headers, build support libraries, then build backend objects`,
    );

    const ready = functionBody(source, script, "generated_headers_ready");
    const headerFiles = arrayBody(source, script, "generated_header_files");
    const headerStamps = arrayBody(source, script, "generated_header_stamps");
    for (const required of REQUIRED_GENERATED_HEADERS) {
      assert.ok(headerFiles.includes(required), `${script} must prove generated header ${required}`);
    }
    for (const required of REQUIRED_GENERATOR_STAMPS) {
      assert.ok(headerStamps.includes(required), `${script} must prove generator stamp ${required}`);
    }
    assert.match(ready, /generated_header_stamps/u);
    assert.match(ready, /generated_header_files/u);
    assert.match(ready, /\[ -s "\$required" \]/u);

    const generate = functionBody(source, script, "build_generated_headers");
    const makeIndex = generate.indexOf("make -C src/backend generated-headers");
    assert.notEqual(makeIndex, -1, `${script} must use PostgreSQL's canonical generated-headers target`);
    for (const invalidated of INVALIDATED_GENERATOR_OUTPUTS) {
      const invalidateIndex = generate.indexOf(invalidated);
      assert.notEqual(invalidateIndex, -1, `${script} must invalidate ${invalidated}`);
      assert.ok(invalidateIndex < makeIndex, `${script} must invalidate ${invalidated} before regeneration`);
    }
    assert.match(generate, /if ! generated_headers_ready;/u);

    const support = functionBody(source, script, "build_support_libraries");
    assert.match(support, /if ! generated_headers_ready;/u);
    assert.match(support, /libpgcommon_srv[.]a/u);
    assert.match(support, /libpgport_srv[.]a/u);

    const backend = functionBody(source, script, "build_backend_objects");
    assert.match(backend, /if ! generated_headers_ready;/u);
    assert.match(backend, /oliphaunt-backend-objects/u);
    assert.doesNotMatch(
      backend,
      /make -C src\/backend generated-headers/u,
      `${script} backend compilation must not own or defer generated-header preparation`,
    );
  });

  test(`${script} emits phase-aware configure and make diagnostics`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const diagnostics = functionBody(source, script, "report_failure");
    const branch = buildBranch(source, script);
    assert.ok(branch.includes("trap 'report_failure \"$?\" \"$LINENO\"' EXIT"));
    assert.ok(!source.includes("trap 'report_failure \"$?\" \"$LINENO\"' ERR"));
    assert.match(diagnostics, /failure_phase/u);
    assert.match(diagnostics, /"\$configure_log" "\$make_log"/u);
    assert.match(diagnostics, /tail -160/u);
    assert.match(diagnostics, /if \[ "\$status" -eq 0 \]; then/u);
    assert.match(diagnostics, /trap - EXIT/u);
    assert.match(branch, /failure_phase="generate PostgreSQL headers"/u);
  });

  test(`${script} reports one nested build failure with retained log tails`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const diagnostics = functionBody(source, script, "report_failure");
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-ios-failure-report-"));
    try {
      writeFileSync(path.join(temporaryRoot, "configure.log"), "configure-evidence\n");
      writeFileSync(path.join(temporaryRoot, "make.log"), "make-evidence\n");
      const harness = `
set -euo pipefail
configure_log="$1/configure.log"
make_log="$1/make.log"
failure_phase="nested generated-header phase"
report_failure() {${diagnostics}
}
trap 'report_failure "$?" "$LINENO"' EXIT
nested_build_phase() {
  ( false )
}
nested_build_phase
`;
      const result = spawnSync("bash", ["-c", harness, "ios-failure-harness", temporaryRoot], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.equal(
        result.stderr.match(/build failed during nested generated-header phase/gu)?.length,
        1,
        result.stderr,
      );
      assert.match(result.stderr, /configure-evidence/u);
      assert.match(result.stderr, /make-evidence/u);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
}

test("CI preserves nested iOS clean-build diagnostics on failure", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const extensionJob = workflow.match(
    /\n  extension-artifacts-native:\n([\s\S]*?)\n  extension-artifacts-wasix:/u,
  )?.[1];
  assert.ok(extensionJob, "CI must retain the native exact-extension job");
  assert.ok(
    extensionJob.includes("target/liboliphaunt-mobile-extension-release/ios-xcframework/ios-simulator/*.log"),
  );
  assert.ok(
    extensionJob.includes("target/liboliphaunt-mobile-extension-release/ios-xcframework/ios-device/*.log"),
  );

  const nativeIosJob = workflow.match(
    /\n  liboliphaunt-native-ios:\n([\s\S]*?)\n  liboliphaunt-native-release-assets:/u,
  )?.[1];
  assert.ok(nativeIosJob, "CI must retain the native iOS runtime job");
  for (const logPath of [
    "${{ matrix.build-root }}/logs/*.log",
    "${{ matrix.build-root }}/**/*.log",
    "target/liboliphaunt-ios-simulator/*.log",
    "target/liboliphaunt-ios-simulator/**/*.log",
    "target/liboliphaunt-ios-device/*.log",
    "target/liboliphaunt-ios-device/**/*.log",
  ]) {
    assert.ok(nativeIosJob.includes(logPath), `native iOS failure evidence must include ${logPath}`);
  }
});
