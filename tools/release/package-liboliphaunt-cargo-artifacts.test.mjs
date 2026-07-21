#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  nativePayloadPlatformCommand,
  renderUnsupportedToolsTargetGuard,
} from "./package-liboliphaunt-cargo-artifacts.mjs";
import { assertLockedArtifactSet, discoverPublicationArtifacts } from "./publication-lock.mjs";
import { elfFixture } from "../test/release-fixture-utils.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function run(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function writeExecutable(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function archiveFixture(source, archive) {
  run("tar", ["-czf", archive, "-C", source, "."]);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("requires the exact Windows runtime import library when packaging the runtime carrier", () => {
  const runtime = nativePayloadPlatformCommand("C:/fixture/runtime", "windows-x64-msvc", {
    toolSet: "runtime",
  });
  assert.deepEqual(runtime.slice(-3), [
    "--require-windows-runtime-import-library",
    "--windows-vc-runtime-profile",
    "provider",
  ]);

  const tools = nativePayloadPlatformCommand("C:/fixture/tools", "windows-x64-msvc", {
    toolSet: "tools",
  });
  assert.ok(!tools.includes("--require-windows-runtime-import-library"));
  assert.ok(!tools.includes("--windows-vc-runtime-profile"));
});

test("freezes .crate bytes for native parts, aggregators, and facade and rejects substituted bytes", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "native-cargo-freeze-test-"));
  try {
    const assets = path.join(root, "assets");
    const runtime = path.join(root, "runtime-fixture");
    const tools = path.join(root, "tools-fixture");
    const output = path.join(root, "output");
    const work = path.join(root, "work");
    const forbiddenStrip = path.join(root, "forbidden-strip");
    writeExecutable(forbiddenStrip, "#!/bin/sh\necho carrier assembly must not strip frozen release assets >&2\nexit 99\n");
    const fixtureElf = elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] });
    mkdirSync(path.join(runtime, "runtime/lib"), { recursive: true });
    writeFileSync(path.join(runtime, "runtime/lib/liboliphaunt.so"), fixtureElf);
    for (const name of ["initdb", "pg_ctl", "postgres"]) {
      writeExecutable(path.join(runtime, "runtime/bin", name), fixtureElf);
    }
    for (const name of ["pg_dump", "psql"]) {
      writeExecutable(path.join(tools, "runtime/bin", name), fixtureElf);
    }
    mkdirSync(assets, { recursive: true });
    archiveFixture(runtime, path.join(assets, "liboliphaunt-9.8.7-linux-x64-gnu.tar.gz"));
    archiveFixture(tools, path.join(assets, "oliphaunt-tools-9.8.7-linux-x64-gnu.tar.gz"));

    const packageArgs = [
      "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
      "--asset-dir", assets,
      "--output-dir", output,
      "--work-dir", work,
      "--version", "9.8.7",
      "--target", "linux-x64-gnu",
      "--part-bytes", "1024",
    ];
    run(process.execPath, packageArgs, {
      env: {
        ...process.env,
        OLIPHAUNT_ELF_STRIP: forbiddenStrip,
        OLIPHAUNT_STRIP: forbiddenStrip,
      },
    });

    const manifest = JSON.parse(readFileSync(path.join(output, "packages.json"), "utf8"));
    assert.ok(manifest.packages.length >= 5);
    assert.deepEqual(new Set(manifest.packages.map(({ role }) => role)), new Set(["part", "aggregator", "facade"]));
    assert.ok(manifest.packages.every(({ cratePath }) => typeof cratePath === "string" && cratePath.endsWith(".crate")));
    assert.equal(readdirSync(output).filter((name) => name.endsWith(".crate")).length, manifest.packages.length);

    const records = discoverPublicationArtifacts([output]);
    assert.equal(records.length, manifest.packages.length);
    assert.ok(records.every((record) => record.artifacts.length === 1 && record.artifacts[0].path.endsWith(".crate")));
    const lock = {
      carriers: records.map((record, publishOrder) => ({
        ...record,
        id: `cargo:${record.name}`,
        product: "fixture",
        publishOrder,
      })),
    };
    assert.doesNotThrow(() => assertLockedArtifactSet(lock, records, { product: "fixture", ecosystem: "cargo" }));

    const packedAggregator = manifest.packages.find(({ role }) => role === "aggregator");
    const packedManifest = commandOutput("tar", [
      "-xOzf",
      path.resolve(ROOT, packedAggregator.cratePath),
      `${packedAggregator.name}-9.8.7/Cargo.toml`,
    ]);
    assert.doesNotMatch(packedManifest, /oliphaunt-package-deps|registry\s*=/u);
    assert.doesNotMatch(
      packedManifest,
      /\[build-dependencies[.]liboliphaunt-native-linux-x64-gnu-part-001\][\s\S]*?path\s*=/u,
    );
    assert.match(packedManifest, /version\s*=\s*"=9[.]8[.]7"/u);

    const facade = manifest.packages.find(({ role }) => role === "facade");
    assert.ok(facade);
    const facadeSource = path.join(path.dirname(path.resolve(ROOT, facade.manifestPath)), "src/lib.rs");
    const facadeText = readFileSync(facadeSource, "utf8");
    assert.match(facadeText, /Generated release-only native target guard[.]/u);
    assert.match(facadeText, /compile_error!/u);
    assert.match(facadeText, /linux-x64-gnu/u);
    const packedFacadeSource = commandOutput("tar", [
      "-xOzf",
      path.resolve(ROOT, facade.cratePath),
      `${facade.name}-9.8.7/src/lib.rs`,
    ]);
    assert.equal(packedFacadeSource, facadeText);
    assert.doesNotMatch(
      readFileSync(path.join(ROOT, "src/runtimes/liboliphaunt/native/crates/tools/src/lib.rs"), "utf8"),
      /Generated release-only native target guard|compile_error!/u,
    );

    const forcedUnsupported = path.join(root, "forced-unsupported-tools.rs");
    writeFileSync(forcedUnsupported, `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(["fixture-unsupported"], ["any()"])}
pub const FIXTURE: bool = true;
`);
    const unsupported = spawnSync("rustc", [
      "--crate-name", "oliphaunt_tools",
      "--crate-type", "lib",
      "--edition", "2024",
      forcedUnsupported,
    ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /has no portable fallback/u);

    const forcedSupported = path.join(root, "forced-supported-tools.rs");
    writeFileSync(forcedSupported, `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(["fixture-supported"], ["all()"])}
pub const FIXTURE: bool = true;
`);
    const supported = spawnSync("rustc", [
      "--crate-name", "oliphaunt_tools",
      "--crate-type", "lib",
      "--edition", "2024",
      "--emit", "metadata",
      "-o", path.join(root, "forced-supported-tools.rmeta"),
      forcedSupported,
    ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(supported.status, 0, supported.stderr);

    const firstDigests = new Map(records.map((record) => [record.name, record.artifacts[0].sha256]));
    run(process.execPath, packageArgs);
    const regenerated = discoverPublicationArtifacts([output]);
    assert.deepEqual(new Map(regenerated.map((record) => [record.name, record.artifacts[0].sha256])), firstDigests);

    const aggregator = manifest.packages.find(({ role }) => role === "aggregator");
    const frozenDigest = records.find((record) => record.name === aggregator.name).artifacts[0].sha256;
    const substituted = path.resolve(ROOT, aggregator.cratePath);
    const substitutedBytes = readFileSync(substituted);
    assert.equal(substitutedBytes[0], 0x1f);
    assert.equal(substitutedBytes[1], 0x8b);
    substitutedBytes[4] ^= 1; // Change only the gzip mtime header; the packaged Cargo contents and identity remain valid.
    writeFileSync(substituted, substitutedBytes);
    const changed = discoverPublicationArtifacts([output]);
    const changedDigest = changed.find((record) => record.name === aggregator.name).artifacts[0].sha256;
    assert.notEqual(changedDigest, frozenDigest);
    assert.equal(changedDigest, sha256(substituted));
    assert.throws(
      () => assertLockedArtifactSet(lock, changed, { product: "fixture", ecosystem: "cargo" }),
      /frozen artifact bytes mismatch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
