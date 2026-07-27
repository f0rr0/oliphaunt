#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOL = path.join(ROOT, "tools/release/validate-ios-carrier-zips.mjs");
const ARCHIVER = path.join(ROOT, "tools/release/archive_dir.mjs");

function run(command, args, { expectFailure = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${command} unexpectedly succeeded:\n${result.stdout}`);
  } else {
    assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function makeCarrier(root, relativeArchive, frameworkName) {
  const framework = path.join(root, "source", relativeArchive.replaceAll("/", "-"), frameworkName);
  mkdirSync(path.join(framework, "ios-arm64", "libFixture.framework"), { recursive: true });
  writeFileSync(path.join(framework, "Info.plist"), "<plist><dict/></plist>\n");
  writeFileSync(
    path.join(framework, "ios-arm64", "libFixture.framework", "libFixture"),
    "fixture-binary\n",
  );
  const archive = path.join(root, "carriers", relativeArchive);
  mkdirSync(path.dirname(archive), { recursive: true });
  run("bash", ["tools/dev/bun.sh", ARCHIVER, "--keep-parent", framework, archive]);
  return archive;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-ios-carrier-gate-test-"));
  const temp = path.join(root, "tmp");
  mkdirSync(temp, { recursive: true });
  return {
    root,
    temp,
    env: { ...process.env, TMPDIR: temp },
  };
}

test("keeps the producer gate on the narrow in-process archive verifier", () => {
  const source = readFileSync(TOOL, "utf8");
  assert.match(source, /from "[.]\/portable-archive[.]mjs"/u);
  assert.doesNotMatch(source, /node:child_process|swift-carrier-resolver|\b(?:unzip|zipinfo)\b/u);
});

test("validates every recursively produced XCFramework ZIP under Node without archive subprocesses", () => {
  const { env, root, temp } = fixture();
  try {
    makeCarrier(root, "nested/base.zip", "liboliphaunt.xcframework");
    makeCarrier(root, "extensions/vector.zip", "liboliphaunt_extension_vector.xcframework");
    const result = run(process.execPath, [TOOL, "--root", path.join(root, "carriers")], { env });
    assert.match(result.stdout, /validated 2 iOS XCFramework ZIP carrier\(s\)/u);
    assert.deepEqual(readdirSync(temp), [], "isolated extraction root must be removed after success");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("fails closed when a producer emits no ZIP carrier", () => {
  const { env, root, temp } = fixture();
  try {
    const carriers = path.join(root, "carriers");
    mkdirSync(carriers, { recursive: true });
    const result = run(process.execPath, [TOOL, "--root", carriers], { env, expectFailure: true });
    assert.match(result.stderr, /found no ZIP carriers/u);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("fails the complete producer set on a structurally valid non-XCFramework ZIP without temp state", () => {
  const { env, root, temp } = fixture();
  try {
    makeCarrier(root, "a-valid.zip", "liboliphaunt.xcframework");
    makeCarrier(root, "z-invalid.zip", "not-a-framework");
    const result = run(process.execPath, [TOOL, "--root", path.join(root, "carriers")], {
      env,
      expectFailure: true,
    });
    assert.match(result.stderr, /z-invalid[.]zip has unsafe or non-XCFramework top-level root/u);
    assert.deepEqual(readdirSync(temp), [], "isolated extraction root must be removed after failure");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects an ambiguous producer tree instead of following carrier-root symlinks", () => {
  const { env, root, temp } = fixture();
  try {
    makeCarrier(root, "valid.zip", "liboliphaunt.xcframework");
    const outside = path.join(root, "outside.zip");
    writeFileSync(outside, "not a carrier\n");
    const link = path.join(root, "carriers", "linked.zip");
    const result = spawnSync("ln", ["-s", outside, link], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const validation = run(process.execPath, [TOOL, "--root", path.join(root, "carriers")], {
      env,
      expectFailure: true,
    });
    assert.match(validation.stderr, /carrier root contains a symbolic link: linked[.]zip/u);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
