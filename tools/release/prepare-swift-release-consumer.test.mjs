import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { localizeSwiftReleaseManifest } from "./prepare-swift-release-consumer.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-swift-release-consumer-"));
  const version = "1.2.3";
  const asset = path.join(root, `liboliphaunt-${version}-apple-spm-xcframework.zip`);
  writeFileSync(asset, "exact candidate xcframework bytes\n");
  const checksum = createHash("sha256").update(readFileSync(asset)).digest("hex");
  const url =
    `https://github.com/f0rr0/oliphaunt/releases/download/` +
    `liboliphaunt-native-v${version}/${path.basename(asset)}`;
  const binaryTarget = `.binaryTarget(\n` +
    `            name: "liboliphaunt",\n` +
    `            url: "${url}",\n` +
    `            checksum: "${checksum}"\n` +
    `        )`;
  const manifest = path.join(root, "Package.swift.release");
  const output = path.join(root, "consumer", "Package.swift");
  writeFileSync(manifest, `// swift-tools-version: 6.0\nlet target = ${binaryTarget}\n`);
  return { asset, binaryTarget, checksum, manifest, output, url };
}

test("localizes only the exact checksum-bound canonical Apple binary target", () => {
  const value = fixture();
  const result = localizeSwiftReleaseManifest({
    manifestFile: value.manifest,
    assetFile: value.asset,
    outputFile: value.output,
  });
  assert.deepEqual(result, {
    asset: path.basename(value.asset),
    checksum: value.checksum,
    publicUrl: value.url,
    xcframeworkPath: "Artifacts/liboliphaunt.xcframework",
  });
  const output = readFileSync(value.output, "utf8");
  assert.match(output, /path: "Artifacts\/liboliphaunt\.xcframework"/u);
  assert.doesNotMatch(output, /url:|checksum:|file:\/\//u);
});

test("rejects checksum drift instead of projecting substituted bytes", () => {
  const value = fixture();
  writeFileSync(value.asset, "substituted bytes\n");
  assert.throws(
    () => localizeSwiftReleaseManifest({
      manifestFile: value.manifest,
      assetFile: value.asset,
      outputFile: value.output,
    }),
    /does not match .* SHA-256/u,
  );
});

test("rejects noncanonical and duplicate binary target identities", () => {
  const value = fixture();
  writeFileSync(value.manifest, readFileSync(value.manifest, "utf8").replace(value.url, "https://example.invalid/runtime.zip"));
  assert.throws(
    () => localizeSwiftReleaseManifest({
      manifestFile: value.manifest,
      assetFile: value.asset,
      outputFile: value.output,
    }),
    /is not the canonical/u,
  );

  const duplicate = fixture();
  writeFileSync(duplicate.manifest, `${readFileSync(duplicate.manifest, "utf8")}\n${duplicate.binaryTarget}\n`);
  assert.throws(
    () => localizeSwiftReleaseManifest({
      manifestFile: duplicate.manifest,
      assetFile: duplicate.asset,
      outputFile: duplicate.output,
    }),
    /exactly one .* found 2/u,
  );
});
