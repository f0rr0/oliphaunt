import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { checkCrossFamilyIcuData } from "./check-cross-family-icu-data.mjs";
import { nativeIcuDataManifestFromRows } from "./native-icu-data-contract.mjs";
import { canonicalGzipSync, releaseZstdCompressSync } from "./portable-archive.mjs";
import { WASIX_PORTABLE_RELEASE_MEMBERS } from "./wasix-runtime-npm-contract.mjs";

const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-cross-family-icu-"));
  scratch.push(root);
  return root;
}

function writeMember(root, member, bytes) {
  const file = path.join(root, ...member.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function archive(root, output, compression) {
  const tar = createDeterministicTar(root, ".", {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  });
  writeFileSync(output, compression(tar));
}

function fixture({ wasixTreeSha256 } = {}) {
  const root = temporaryRoot();
  const nativeAssets = path.join(root, "native-assets");
  const wasixAssets = path.join(root, "wasix-assets");
  const nativeStage = path.join(root, "native-stage");
  const wasixStage = path.join(root, "wasix-stage");
  mkdirSync(nativeAssets);
  mkdirSync(wasixAssets);

  const nativeManifest = nativeIcuDataManifestFromRows([
    { path: "icudt76l/root.res", bytes: Buffer.from("same logical ICU tree\n") },
  ]);
  const nativeTreeSha256 = /^icuDataTreeSha256=([0-9a-f]{64})$/mu.exec(nativeManifest.toString("utf8"))[1];
  const tree = wasixTreeSha256 ?? nativeTreeSha256;
  writeMember(nativeStage, "manifest.properties", nativeManifest);
  archive(
    nativeStage,
    path.join(nativeAssets, "liboliphaunt-1.2.3-icu-data.tar.gz"),
    canonicalGzipSync,
  );

  writeMember(wasixStage, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, `${JSON.stringify({
    "format-version": 2,
    "cluster-seeds": {
      icu: {
        manifest: "cluster-seeds/icu.json",
        "icu-data-tree-sha256": tree,
      },
    },
  })}\n`);
  writeMember(wasixStage, WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedManifest, `${JSON.stringify({
    schema: "oliphaunt-cluster-seed-v1",
    artifactRole: "cluster-seed-icu",
    catalogProfile: "icu",
    icu: {
      artifactRole: "icu-data",
      dataVersion: "76.1",
      dataForm: "files-le",
      dataTreeSha256: tree,
    },
  })}\n`);
  archive(
    wasixStage,
    path.join(wasixAssets, "liboliphaunt-wasix-4.5.6-runtime-portable.tar.zst"),
    releaseZstdCompressSync,
  );
  return { nativeAssets, wasixAssets, nativeTreeSha256 };
}

test("accepts one canonical logical ICU identity across native and WASIX releases", () => {
  const value = fixture();
  expect(checkCrossFamilyIcuData(value.nativeAssets, value.wasixAssets)).toEqual({
    dataVersion: "76.1",
    dataForm: "files-le",
    dataTreeSha256: value.nativeTreeSha256,
  });
});

test("rejects internally valid native and WASIX releases with different ICU trees", () => {
  const value = fixture({ wasixTreeSha256: "f".repeat(64) });
  expect(() => checkCrossFamilyIcuData(value.nativeAssets, value.wasixAssets)).toThrow(
    /native and WASIX ICU dataTreeSha256 differ/u,
  );
});
