#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, expect, test } from "bun:test";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { stageWasixIcuNpmCarrier } from "./wasix-icu-npm-carrier.mjs";
import { WASIX_PORTABLE_RELEASE_MEMBERS } from "./wasix-runtime-npm-contract.mjs";

const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function write(root, member, bytes) {
  const file = path.join(root, ...member.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function archive(root) {
  return zstdCompressSync(createDeterministicTar(root, ".", {
    fail(message) { throw new Error(message); },
    fixedFileMode: 0o644,
  }));
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-wasix-icu-carrier-"));
  roots.push(root);
  const dataPath = "icudt76l/coll/en.res";
  const dataBytes = Buffer.from("fixture ICU data\n");
  const tree = createHash("sha256")
    .update(dataPath).update(Buffer.of(0)).update(String(dataBytes.length)).update(Buffer.of(0))
    .update(dataBytes).update("\n").digest("hex");
  const seedBytes = Buffer.from("seed\n");
  const moduleSha = "1".repeat(64);
  const source = "fixture-source";
  const seedManifest = {
    schema: "oliphaunt-cluster-seed-v1",
    artifactRole: "cluster-seed-icu",
    catalogProfile: "icu",
    runtime: {
      product: "liboliphaunt-wasix", version: "7.8.9", engineFamily: "wasix",
      physicalFormat: "wasix-pg18-v1", postgresMajor: 18,
      compatibilityKey: "wasix-pg18-datum32-v1", consumerSha256: moduleSha,
      producerSha256: moduleSha, initdbSha256: "2".repeat(64),
    },
    source: { fingerprint: source, catalogVersion: "1", lane: "stable", producer: "wasix-initdb" },
    initProfile: "fixture", archive: { path: "cluster-seeds/icu.tar.zst", sha256: digest(seedBytes), compressedBytes: seedBytes.length, expandedBytes: 1, regularFiles: 1, directories: 1 },
    requiredRuntimeFeatures: ["icu"], extensions: { selected: [], startupConfiguration: [] },
    icu: { artifactRole: "icu-data", upstreamVersion: "76.1", sourceCommit: "3".repeat(40), dataTreeSha256: tree, dataVersion: "76.1", dataForm: "files-le" },
  };
  const runtimeManifest = {
    "format-version": 2,
    "cluster-seeds": { icu: { archive: "cluster-seeds/icu.tar.zst", sha256: digest(seedBytes), size: seedBytes.length, "icu-data-tree-sha256": tree } },
  };
  const portableStage = path.join(root, "portable");
  write(portableStage, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, `${JSON.stringify(runtimeManifest)}\n`);
  write(portableStage, "target/oliphaunt-wasix/assets/cluster-seeds/icu.tar.zst", seedBytes);
  write(portableStage, "target/oliphaunt-wasix/assets/cluster-seeds/icu.json", `${JSON.stringify(seedManifest)}\n`);
  const portableReleaseArchive = path.join(root, "runtime.tar.zst");
  writeFileSync(portableReleaseArchive, archive(portableStage));

  const icuStage = path.join(root, "icu");
  write(icuStage, `target/oliphaunt-wasix/icu/share/icu/${dataPath}`, dataBytes);
  const icuDataReleaseArchive = path.join(root, "icu.tar.zst");
  writeFileSync(icuDataReleaseArchive, archive(icuStage));
  return { root, portableReleaseArchive, icuDataReleaseArchive, tree };
}

test("stages one exact ICU data and ICU cluster-seed closure", () => {
  const value = fixture();
  const staged = stageWasixIcuNpmCarrier({
    version: "7.8.9",
    portableReleaseArchive: value.portableReleaseArchive,
    icuDataReleaseArchive: value.icuDataReleaseArchive,
    packageDir: path.join(value.root, "package"),
  });
  const packageJson = JSON.parse(readFileSync(path.join(staged.packageDir, "package.json"), "utf8"));
  expect(packageJson.name).toBe("@oliphaunt/wasix-icu");
  expect(staged.descriptor.compatibility.dataTreeSha256).toBe(value.tree);
  expect(readFileSync(path.join(staged.packageDir, "index.js"), "utf8")).toContain("oliphaunt-wasix-icu-v1");
  expect(readFileSync(path.join(staged.packageDir, "assets/cluster-seed-icu.tar.zst"))).toEqual(Buffer.from("seed\n"));
});

test("rejects ICU data that does not match the ICU seed catalog identity", () => {
  const value = fixture();
  const wrong = path.join(value.root, "wrong-icu");
  write(wrong, "target/oliphaunt-wasix/icu/share/icu/icudt76l/coll/en.res", "wrong\n");
  writeFileSync(value.icuDataReleaseArchive, archive(wrong));
  expect(() => stageWasixIcuNpmCarrier({
    version: "7.8.9",
    portableReleaseArchive: value.portableReleaseArchive,
    icuDataReleaseArchive: value.icuDataReleaseArchive,
    packageDir: path.join(value.root, "bad-package"),
  })).toThrow(/no icudt files-data tree|compatible closure/u);
});
