#!/usr/bin/env bun
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, expect, test } from "bun:test";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { CORE_RUNTIME_ARCHIVE_FILES } from "./wasix-cargo-artifact-contract.mjs";
import {
  packWasixRuntimeNpmCarrier,
  renderWasixRuntimeDescriptorModule,
} from "./wasix-runtime-npm-carrier.mjs";
import { packWasixToolsNpmCarrier } from "./wasix-tools-npm-carrier.mjs";
import {
  WASIX_PORTABLE_RELEASE_MEMBERS,
  WASIX_RUNTIME_NPM_PACKAGE,
} from "./wasix-runtime-npm-contract.mjs";

const directories = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), name));
  directories.push(root);
  return root;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicTar(stage, archiveRoot) {
  return createDeterministicTar(stage, archiveRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  });
}

function writeMember(stage, member, bytes) {
  const output = path.join(stage, ...member.split("/"));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, bytes);
}

function portableReleaseFixture(root, { transformManifest = (manifest) => manifest } = {}) {
  const runtimeStage = path.join(root, "runtime-stage");
  for (const member of CORE_RUNTIME_ARCHIVE_FILES) {
    expect(member.startsWith("oliphaunt/")).toBe(true);
    writeMember(runtimeStage, member.slice("oliphaunt/".length), `fixture:${member}\n`);
  }
  const runtimeBytes = zstdCompressSync(deterministicTar(runtimeStage, "oliphaunt"));

  const seedStage = path.join(root, "seed-stage");
  writeMember(seedStage, "PG_VERSION", "18\n");
  const seedBytes = zstdCompressSync(deterministicTar(seedStage, "."));

  const sourceFingerprint = "fixture-postgres-source-fingerprint";
  const runtimeModuleSha256 = sha256(Buffer.from("fixture:oliphaunt/bin/postgres\n"));
  const manifest = transformManifest({
    "format-version": 2,
    "source-fingerprint": sourceFingerprint,
    runtime: {
      archive: "oliphaunt.wasix.tar.zst",
      sha256: sha256(runtimeBytes),
      size: runtimeBytes.length,
      "module-sha256": runtimeModuleSha256,
      "postgres-version": "18.4",
      link: { exports: [] },
    },
    "runtime-support": [],
    "cluster-seeds": {
      standard: {
        "artifact-role": "cluster-seed-standard",
        "catalog-profile": "standard",
        archive: "cluster-seeds/standard.tar.zst",
        manifest: "cluster-seeds/standard.json",
        sha256: sha256(seedBytes),
        size: seedBytes.length,
        "runtime-module-sha256": runtimeModuleSha256,
        "source-fingerprint": sourceFingerprint,
        "postgres-version": "18",
        "physical-format": "wasix-pg18-v1",
        "compatibility-key": "wasix-pg18-datum32-v1",
      },
      icu: {
        "artifact-role": "cluster-seed-icu",
        "catalog-profile": "icu",
        archive: "cluster-seeds/icu.tar.zst",
        manifest: "cluster-seeds/icu.json",
        sha256: "c".repeat(64),
        size: 1,
        "runtime-module-sha256": runtimeModuleSha256,
        "source-fingerprint": sourceFingerprint,
        "postgres-version": "18",
        "physical-format": "wasix-pg18-v1",
        "compatibility-key": "wasix-pg18-datum32-v1",
        "icu-data-tree-sha256": "d".repeat(64),
      },
    },
    extensions: [],
  });
  const seedManifestBytes = Buffer.from(`${JSON.stringify({
    schema: "oliphaunt-cluster-seed-v1",
    artifactRole: "cluster-seed-standard",
    catalogProfile: "standard",
    runtime: {
      product: "liboliphaunt-wasix",
      version: "7.8.9",
      engineFamily: "wasix",
      physicalFormat: "wasix-pg18-v1",
      postgresMajor: 18,
      compatibilityKey: "wasix-pg18-datum32-v1",
      consumerSha256: runtimeModuleSha256,
      producerSha256: runtimeModuleSha256,
      initdbSha256: "e".repeat(64),
    },
    source: { fingerprint: sourceFingerprint, catalogVersion: "202505281", lane: "stable", producer: "wasix-initdb" },
    initProfile: "encoding=UTF8,locale=C.UTF-8,locale-provider=libc,auth=trust,no-sync",
    archive: {
      path: "cluster-seeds/standard.tar.zst",
      sha256: sha256(seedBytes),
      compressedBytes: seedBytes.length,
      expandedBytes: 3,
      regularFiles: 1,
      directories: 1,
    },
    requiredRuntimeFeatures: [],
    extensions: { selected: [], startupConfiguration: [] },
    icu: null,
  }, null, 2)}\n`);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const releaseStage = path.join(root, "release-stage");
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive, runtimeBytes);
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.standardSeedArchive, seedBytes);
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.standardSeedManifest, seedManifestBytes);
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, manifestBytes);
  writeMember(releaseStage, "target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm", "pg_dump");
  writeMember(releaseStage, "target/oliphaunt-wasix/assets/bin/psql.wasix.wasm", "psql");
  stageReleaseNotices(releaseStage, { profile: "wasix-runtime" });
  const archive = path.join(root, "liboliphaunt-wasix-7.8.9-runtime-portable.tar.zst");
  writeFileSync(archive, zstdCompressSync(deterministicTar(releaseStage, ".")));
  return { archive, manifestBytes };
}

test("renders the package-authored runtime identity without consumer asset URLs", () => {
  const digest = "a".repeat(64);
  const module = renderWasixRuntimeDescriptorModule({
    version: "7.8.9",
    runtimeArchive: {
      archive: "oliphaunt.wasix.tar.zst",
      sha256: digest,
      size: 1,
    },
    standardSeedArchive: {
      archive: "cluster-seeds/standard.tar.zst",
      sha256: digest,
      size: 2,
    },
    standardSeedManifest: { sha256: digest, size: 4 },
    manifest: { sha256: digest, size: 3 },
  });
  expect(module).toContain('product: "liboliphaunt-wasix"');
  expect(module).toContain('source: new URL("./assets/oliphaunt.wasix.tar.zst", import.meta.url)');
  expect(module).not.toContain('new URL("/assets/');
});

test("rejects a core manifest that omits host-required identity metadata", () => {
  const root = temporaryRoot("oliphaunt-wasix-runtime-invalid-manifest-");
  const fixture = portableReleaseFixture(root, {
    transformManifest(manifest) {
      delete manifest.runtime.link;
      return manifest;
    },
  });
  expect(() =>
    packWasixRuntimeNpmCarrier({
      version: "7.8.9",
      portableReleaseArchive: fixture.archive,
      packageDir: path.join(root, "package"),
      tarballRoot: path.join(root, "tarballs"),
    })).toThrow(/runtime[.]link must be an object/u);
});

test("rejects a core manifest whose optional runtime size differs from its bytes", () => {
  const root = temporaryRoot("oliphaunt-wasix-runtime-invalid-size-");
  const fixture = portableReleaseFixture(root, {
    transformManifest(manifest) {
      manifest.runtime.size += 1;
      return manifest;
    },
  });
  expect(() =>
    packWasixRuntimeNpmCarrier({
      version: "7.8.9",
      portableReleaseArchive: fixture.archive,
      packageDir: path.join(root, "package"),
      tarballRoot: path.join(root, "tarballs"),
    })).toThrow(/runtime archive does not match manifest[.]runtime[.]size/u);
});

test("packs the exact qualified core projection as one host-neutral npm carrier", () => {
  const root = temporaryRoot("oliphaunt-wasix-runtime-npm-");
  const fixture = portableReleaseFixture(root);
  const packed = packWasixRuntimeNpmCarrier({
    version: "7.8.9",
    portableReleaseArchive: fixture.archive,
    packageDir: path.join(root, "package"),
    tarballRoot: path.join(root, "tarballs"),
  });
  const packageJson = JSON.parse(readFileSync(path.join(packed.packageDir, "package.json"), "utf8"));
  expect(packageJson.name).toBe(WASIX_RUNTIME_NPM_PACKAGE);
  expect(packageJson.version).toBe("7.8.9");
  expect(packageJson.oliphaunt.manifestProjection).toBe("core");
  expect(readFileSync(path.join(packed.packageDir, "README.md"), "utf8")).toContain(
    "public binding declares this carrier as an exact release-staged dependency",
  );
  expect(readFileSync(path.join(packed.packageDir, "assets/manifest.json"))).toEqual(
    fixture.manifestBytes,
  );

  const script = `
import { pathToFileURL } from "node:url";
const descriptor = (await import(pathToFileURL(process.env.ENTRYPOINT).href)).default;
if (!Object.isFrozen(descriptor)) throw new Error("descriptor is mutable");
for (const value of [descriptor.runtimeArchive, descriptor.standardSeedArchive, descriptor.standardSeedManifest, descriptor.manifest]) {
  if (!Object.isFrozen(value)) throw new Error("asset descriptor is mutable");
}
console.log(JSON.stringify({
  product: descriptor.product,
  runtime: descriptor.runtime,
  runtimeSource: descriptor.runtimeArchive.source.href,
  seedSource: descriptor.standardSeedArchive.source.href,
  manifestSource: descriptor.manifest.source.href,
}));
`;
  const imported = spawnSync("node", ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ENTRYPOINT: path.join(packed.packageDir, "index.js") },
  });
  expect(imported.status, `${imported.stdout}\n${imported.stderr}`).toBe(0);
  expect(JSON.parse(imported.stdout)).toMatchObject({
    product: "liboliphaunt-wasix",
    runtime: "wasix",
  });
});

test("packs split pg_dump and psql bytes from the same qualified release archive", () => {
  const root = temporaryRoot("oliphaunt-wasix-tools-npm-");
  const fixture = portableReleaseFixture(root);
  const packed = packWasixToolsNpmCarrier({
    version: "7.8.9",
    portableReleaseArchive: fixture.archive,
    packageDir: path.join(root, "package"),
    tarballRoot: path.join(root, "tarballs"),
  });
  const packageJson = JSON.parse(readFileSync(path.join(packed.packageDir, "package.json"), "utf8"));
  expect(packageJson.name).toBe("@oliphaunt/liboliphaunt-wasix-tools");
  expect(packageJson.version).toBe("7.8.9");
  expect(readFileSync(path.join(packed.packageDir, "assets/pg_dump.wasix.wasm"), "utf8")).toBe("pg_dump");
  expect(readFileSync(path.join(packed.packageDir, "assets/psql.wasix.wasm"), "utf8")).toBe("psql");
  expect(packed.descriptor.pgDump.sha256).toBe(sha256(Buffer.from("pg_dump")));
  expect(packed.descriptor.psql.sha256).toBe(sha256(Buffer.from("psql")));
});
