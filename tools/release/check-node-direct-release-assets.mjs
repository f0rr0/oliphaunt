#!/usr/bin/env bun
import path from "node:path";

import {
  assertFileExists,
  checksumManifest,
  readArchiveEntries,
  sha256,
} from "./release-asset-validation.mjs";
import {
  ROOT,
  artifactTargets,
  compareText,
  currentProductVersion,
  expectedAssets,
  fail,
} from "./release-artifact-targets.mjs";
import { inspectPlatformBinaryEntries } from "./platform-binary-contract.mjs";

const PREFIX = "check-node-direct-release-assets.mjs";
const PRODUCT = "oliphaunt-node-direct";
const KIND = "node-direct-addon";

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, "target/oliphaunt-node-direct/release-assets"),
    allowPartial: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      const value = argv[index + 1];
      if (!value) {
        fail(PREFIX, "--asset-dir requires a value");
      }
      args.assetDir = path.resolve(value);
      index += 1;
    } else if (arg === "--allow-partial") {
      args.allowPartial = true;
    } else {
      fail(PREFIX, `unknown argument ${arg}`);
    }
  }
  return args;
}

async function validateArchive(file, target) {
  const entries = await readArchiveEntries(file, fail, PREFIX, "Node direct");
  const memberName = target.libraryRelativePath;
  if (!entries.has(memberName)) {
    fail(PREFIX, `${path.basename(file)} is missing ${memberName}`);
  }
  const member = entries.get(memberName);
  if (!member.isFile) {
    fail(PREFIX, `${path.basename(file)} ${memberName} is not a regular file`);
  }
  if (member.size === 0) {
    fail(PREFIX, `${path.basename(file)} ${memberName} is empty`);
  }
  inspectPlatformBinaryEntries(
    [...entries].map(([name, entry]) => ({ name, ...entry })),
    { target: target.target, rootLabel: path.basename(file) },
  );
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const version = await currentProductVersion(PRODUCT, PREFIX);
  const requiredAssets = expectedAssets(PRODUCT, KIND, version, PREFIX);
  const targets = artifactTargets(PRODUCT, KIND, PREFIX);
  const targetsByAsset = new Map(targets.map((target) => [target.asset.replaceAll("{version}", version), target]));
  const missing = [];
  for (const asset of requiredAssets) {
    if (!(await assertFileExists(path.join(args.assetDir, asset)))) {
      missing.push(asset);
    }
  }
  if (missing.length > 0) {
    if (!args.allowPartial) {
      fail(PREFIX, `missing oliphaunt-node-direct release asset(s): ${missing.join(", ")}`);
    }
    let presentAddons = 0;
    for (const target of targets) {
      if (await assertFileExists(path.join(args.assetDir, target.asset.replaceAll("{version}", version)))) {
        presentAddons += 1;
      }
    }
    if (presentAddons === 0) {
      fail(PREFIX, "partial oliphaunt-node-direct release asset validation requires at least one addon asset");
    }
  }

  const checksumAsset = `oliphaunt-node-direct-${version}-release-assets.sha256`;
  const checksumPath = path.join(args.assetDir, checksumAsset);
  if (!(await assertFileExists(checksumPath))) {
    fail(PREFIX, `missing checksum manifest: ${checksumAsset}`);
  }
  const checksums = await checksumManifest(checksumPath, fail, PREFIX);
  for (const asset of requiredAssets.sort(compareText)) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) {
      continue;
    }
    if (asset === checksumAsset) {
      continue;
    }
    const expected = checksums.get(asset);
    if (!expected) {
      fail(PREFIX, `${checksumAsset} does not cover ${asset}`);
    }
    const actual = await sha256(assetPath);
    if (actual !== expected) {
      fail(PREFIX, `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [asset, target] of targetsByAsset) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) {
      continue;
    }
    await validateArchive(assetPath, target);
  }
  console.log(`oliphaunt-node-direct release assets validated: ${args.assetDir}`);
}

await main();
