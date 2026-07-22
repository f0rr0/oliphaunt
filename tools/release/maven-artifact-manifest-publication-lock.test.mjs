import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { discoverPublicationArtifacts } from "./publication-lock.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { ROOT } from "./release-graph.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-maven-manifest-lock-"));
  temporaryRoots.push(directory);
  return directory;
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  expect(
    result.status,
    `${script} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

test("the real Maven manifest builder feeds the canonical ten-field schema into publication locking", {
  timeout: 30_000,
}, () => {
  const root = temporaryDirectory();
  const assets = path.join(root, "assets");
  const manifestDirectory = path.join(root, "maven-artifacts");
  const manifest = path.join(manifestDirectory, "runtime.tsv");
  const version = currentProductVersionSync("liboliphaunt-native");
  mkdirSync(manifestDirectory, { recursive: true });

  run("tools/test/create-liboliphaunt-release-fixture.mjs", [
    "--asset-dir",
    assets,
    "--version",
    version,
  ]);
  run("tools/release/build_maven_artifact_manifest.mjs", [
    "--output",
    manifest,
    "--runtime",
    "--runtime-asset-root",
    assets,
  ]);

  const original = readFileSync(manifest, "utf8");
  const rows = original.trimEnd().split("\n");
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.split("\t").length === 10)).toBe(true);

  const records = discoverPublicationArtifacts([manifest]);
  expect(records.map(({ name }) => name).sort()).toEqual([
    "dev.oliphaunt.runtime:liboliphaunt-android-arm64-v8a",
    "dev.oliphaunt.runtime:liboliphaunt-android-x86_64",
    "dev.oliphaunt.runtime:liboliphaunt-runtime-resources",
    "dev.oliphaunt.runtime:oliphaunt-icu",
  ]);
  expect(records.every((record) =>
    record.version === version
    && record.artifacts.length === 1
    && record.artifacts[0].path.endsWith(".tar.gz")
    && record.artifacts[0].sha256.length === 64)).toBe(true);

  const first = rows[0].split("\t");
  const mutations = [
    ["legacy field count", first.slice(0, 8), /ten Maven publication fields/u],
    ["missing display name", first.with(4, ""), /display name/u],
    ["half runtime binding", first.with(6, "liboliphaunt-native"), /both runtime product and version/u],
    ["missing SPDX expression", first.with(8, ""), /SPDX expression/u],
    ["non-array licenses", first.with(9, "{}"), /non-empty JSON array/u],
    [
      "non-canonical license entry",
      first.with(9, JSON.stringify([{ name: "MIT", url: "https://example.invalid/MIT", distribution: "repo", extra: true }])),
      /must contain exactly name, url, distribution/u,
    ],
    [
      "insecure license URL",
      first.with(9, JSON.stringify([{ name: "MIT", url: "http://example.invalid/MIT", distribution: "repo" }])),
      /must use HTTPS/u,
    ],
  ];
  for (const [label, mutated, pattern] of mutations) {
    writeFileSync(manifest, `${mutated.join("\t")}\n${rows.slice(1).join("\n")}\n`);
    expect(() => discoverPublicationArtifacts([manifest]), label).toThrow(pattern);
  }
});
