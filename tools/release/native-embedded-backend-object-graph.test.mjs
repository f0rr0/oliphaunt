#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./release-graph.mjs";

const BACKEND_OBJECT_MAKEFILE =
  "src/runtimes/liboliphaunt/native/bin/postgres-backend-objects.mk";
const FUNCTION_BUILD_SCRIPTS = [
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
];
const ALL_EMBEDDED_BUILD_SCRIPTS = [
  ...FUNCTION_BUILD_SCRIPTS,
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
];

function functionBody(source, script, name) {
  const match = source.match(new RegExp(`(?:^|\\n)${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(match, `${script} must retain ${name}`);
  return match[1];
}

function buildBranch(source, script) {
  const match = source.match(/case "\$script_mode" in\s+build\)([\s\S]*?)\n\s*;;/u);
  assert.ok(match, `${script} must retain an explicit build branch`);
  return match[1];
}

test("the embedded backend makefile excludes tool and support-library subgraphs", () => {
  const source = readFileSync(path.join(ROOT, BACKEND_OBJECT_MAKEFILE), "utf8");

  assert.ok(source.includes("$(filter-out $(top_builddir)/src/timezone,$(SUBDIRS))"));
  assert.match(
    source,
    /OLIPHAUNT_BACKEND_RECURSIVE_TARGETS\s*=\s*\$\(OLIPHAUNT_BACKEND_SUBDIRS:%=%-recursive\)/u,
  );
  assert.match(
    source,
    /oliphaunt-backend-objects:\s*\$\(OLIPHAUNT_BACKEND_RECURSIVE_TARGETS\) \$\(LOCALOBJS\)/u,
  );
  assert.doesNotMatch(
    source,
    /oliphaunt-backend-objects:\s*\$\(OBJS\)/u,
    "the embedded target must not restore PostgreSQL's executable/tool prerequisites",
  );
});

for (const script of ALL_EMBEDDED_BUILD_SCRIPTS) {
  test(`${script} uses the shared object-only PostgreSQL backend graph`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const invocation = /make -j"\$jobs" -C src\/backend \\\n+\s+-f "\$script_dir\/postgres-backend-objects[.]mk"[\s\S]*?\n\s+oliphaunt-backend-objects/u;

    assert.match(source, invocation);
    assert.ok(
      source.includes('shasum -a 256 "$script_dir/postgres-backend-objects.mk"'),
      `${script} must invalidate its build stamp when the shared backend graph changes`,
    );
    assert.doesNotMatch(
      source,
      /make -j"\$jobs" -C src\/backend \\\n+(?:[^\n]*\n){0,8}\s+postgres(?:\s|$)/u,
      `${script} must not cross-link a PostgreSQL executable while collecting embedded objects`,
    );
  });
}

for (const script of FUNCTION_BUILD_SCRIPTS) {
  test(`${script} builds timezone objects only after backend objects`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const branch = buildBranch(source, script);
    const backendIndex = branch.indexOf("build_backend_objects");
    const timezoneIndex = branch.indexOf("build_timezone_objects");
    assert.notEqual(backendIndex, -1, `${script} must build backend objects`);
    assert.notEqual(timezoneIndex, -1, `${script} must build timezone objects`);
    assert.ok(
      backendIndex < timezoneIndex,
      `${script} must complete the parallel backend graph before the isolated timezone phase`,
    );

    const timezone = functionBody(source, script, "build_timezone_objects");
    for (const object of ["localtime.o", "pgtz.o", "strftime.o"]) {
      assert.ok(timezone.includes(object), `${script} must build timezone object ${object}`);
    }
    assert.doesNotMatch(timezone, /\bzic\b/u);
    assert.doesNotMatch(timezone, /\ball\b/u);
  });
}

test("the macOS embedded build isolates timezone objects after the backend graph", () => {
  const script = "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh";
  const source = readFileSync(path.join(ROOT, script), "utf8");
  const backendIndex = source.lastIndexOf("oliphaunt-backend-objects");
  const timezoneIndex = source.lastIndexOf("make -C src/timezone");
  assert.notEqual(backendIndex, -1);
  assert.notEqual(timezoneIndex, -1);
  assert.ok(backendIndex < timezoneIndex);

  const timezoneCommand = source.slice(timezoneIndex, source.indexOf("\n\n", timezoneIndex));
  for (const object of ["localtime.o", "pgtz.o", "strftime.o"]) {
    assert.ok(timezoneCommand.includes(object), `${script} must build timezone object ${object}`);
  }
  assert.doesNotMatch(timezoneCommand, /\bzic\b/u);
  assert.doesNotMatch(timezoneCommand, /\ball\b/u);
});
