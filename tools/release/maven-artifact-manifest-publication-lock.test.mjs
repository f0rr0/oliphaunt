import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { execFileSync, spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import { stageExtensionUpstreamLicenses } from "./extension-upstream-licenses.mjs";
import { discoverPublicationArtifacts } from "./publication-lock.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { ROOT } from "./release-graph.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";

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

function contribAndroidBundle(root, target, { archiveRoot } = {}) {
  const product = "oliphaunt-extension-contrib-pg18";
  const version = currentProductVersionSync(product);
  const canonicalRoot = `${product}-${version}-native-${target}-bundle`;
  const stage = path.join(root, "bundle-stage", target);
  const output = path.join(root, product, "release-assets", `${canonicalRoot}.tar.gz`);
  mkdirSync(stage, { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  stageReleaseNotices(stage, { profile: "contrib-native-openssl" });
  writeFileSync(path.join(stage, "bundle-manifest.json"), "{}\n");
  writeFileSync(output, gzipSync(createDeterministicTar(stage, archiveRoot ?? canonicalRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  }), { mtime: 0 }));
  return output;
}

function singletonAndroidRuntime(root, target, { mutateUpstream = false, upstreamRoot = "files" } = {}) {
  const product = "oliphaunt-extension-pg-hashids";
  const version = currentProductVersionSync(product);
  const name = `${product}-${version}-native-${target}-runtime.tar.gz`;
  const stage = path.join(root, "singleton-stage", target);
  const output = path.join(root, product, "release-assets", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  chmodSync(stage, 0o755);
  mkdirSync(path.dirname(output), { recursive: true });
  stageReleaseNotices(stage, { profile: "external-native" });
  if (upstreamRoot !== null) {
    const staged = stageExtensionUpstreamLicenses("pg_hashids", path.join(stage, upstreamRoot));
    for (const directory of [
      upstreamRoot,
      `${upstreamRoot}/share`,
      `${upstreamRoot}/share/licenses`,
      `${upstreamRoot}/share/licenses/pg_hashids`,
    ]) chmodSync(path.join(stage, directory), 0o755);
    if (mutateUpstream) {
      writeFileSync(path.join(stage, upstreamRoot, staged[0]), "substituted upstream license\n");
    }
  }
  writeFileSync(path.join(stage, "manifest.properties"), "packageLayout=fixture\n");
  execFileSync("tar", ["--format=ustar", "-czf", output, "-C", stage, "."]);
  return output;
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

test("the Maven manifest builder validates notices beneath an exact bundle archive root", {
  timeout: 30_000,
}, () => {
  const root = temporaryDirectory();
  const manifest = path.join(root, "maven-artifacts", "contrib.tsv");
  for (const target of ["android-arm64-v8a", "android-x86_64"]) {
    contribAndroidBundle(root, target);
  }

  run("tools/release/build_maven_artifact_manifest.mjs", [
    "--output",
    manifest,
    "--extensions",
    "--extension-product",
    "oliphaunt-extension-contrib-pg18",
    "--extension-artifact-root",
    root,
  ]);
  expect(readFileSync(manifest, "utf8").trimEnd().split("\n")).toHaveLength(2);

  contribAndroidBundle(root, "android-arm64-v8a", { archiveRoot: "substituted-root" });
  const result = spawnSync(process.execPath, [
    "tools/release/build_maven_artifact_manifest.mjs",
    "--output",
    manifest,
    "--extensions",
    "--extension-product",
    "oliphaunt-extension-contrib-pg18",
    "--extension-artifact-root",
    root,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/canonical single archive root/u);
});

test("the Maven manifest builder validates singleton upstream licenses in the runtime files namespace", {
  timeout: 30_000,
}, () => {
  const root = temporaryDirectory();
  const manifest = path.join(root, "maven-artifacts", "pg-hashids.tsv");
  for (const target of ["android-arm64-v8a", "android-x86_64"]) {
    singletonAndroidRuntime(root, target);
  }

  run("tools/release/build_maven_artifact_manifest.mjs", [
    "--output",
    manifest,
    "--extensions",
    "--extension-product",
    "oliphaunt-extension-pg-hashids",
    "--extension-artifact-root",
    root,
  ]);
  expect(readFileSync(manifest, "utf8").trimEnd().split("\n")).toHaveLength(2);

  for (const [label, options, pattern] of [
    ["missing files namespace", { upstreamRoot: null }, /packed upstream license members differ/u],
    ["substituted files namespace", { upstreamRoot: "substituted-files" }, /packed upstream license members differ/u],
    ["substituted upstream bytes", { mutateUpstream: true }, /packed upstream license bytes changed/u],
  ]) {
    singletonAndroidRuntime(root, "android-arm64-v8a", options);
    const result = spawnSync(process.execPath, [
      "tools/release/build_maven_artifact_manifest.mjs",
      "--output",
      manifest,
      "--extensions",
      "--extension-product",
      "oliphaunt-extension-pg-hashids",
      "--extension-artifact-root",
      root,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status, label).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`, label).toMatch(pattern);
  }
});
