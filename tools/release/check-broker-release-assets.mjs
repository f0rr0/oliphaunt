#!/usr/bin/env bun
import { createHash } from "node:crypto";
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
import {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_RECEIPT,
  inspectPortableExecutable,
  windowsVcRuntimeImports,
} from "./windows-vc-runtime-closure.mjs";

const PREFIX = "check-broker-release-assets.mjs";
const PRODUCT = "oliphaunt-broker";
const KIND = "broker-helper";

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, "target/oliphaunt-broker/release-assets"),
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
  const entries = await readArchiveEntries(file, fail, PREFIX, "broker");
  const executable = target.executableRelativePath;
  if (!entries.has(executable)) {
    fail(PREFIX, `${path.basename(file)} is missing ${executable}`);
  }
  if (!entries.has("manifest.properties")) {
    fail(PREFIX, `${path.basename(file)} is missing manifest.properties`);
  }
  const broker = entries.get(executable);
  if (!broker.isFile) {
    fail(PREFIX, `${path.basename(file)} ${executable} is not a regular file`);
  }
  if (file.endsWith(".tar.gz") && (broker.mode & 0o111) === 0) {
    fail(PREFIX, `${path.basename(file)} ${executable} is not executable`);
  }
  if (path.extname(file) === ".zip" && broker.size === 0) {
    fail(PREFIX, `${path.basename(file)} ${executable} is empty`);
  }
  if (target.target === "windows-x64-msvc") {
    const allowed = new Set(WINDOWS_VC_RUNTIME_DLLS);
    const required = new Set();
    const pending = windowsVcRuntimeImports(Buffer.from(broker.data()), `${path.basename(file)}:${executable}`)
      .map((name) => name.toLowerCase());
    while (pending.length > 0) {
      const name = pending.shift();
      if (!allowed.has(name)) {
        fail(PREFIX, `${path.basename(file)} imports undeclared or debug VC runtime ${name}`);
      }
      if (required.has(name)) continue;
      const member = `bin/${name}`;
      const entry = entries.get(member);
      if (!entry?.isFile || entry.size <= 0) {
        fail(PREFIX, `${path.basename(file)} is missing import-derived app-local ${member}`);
      }
      let inspected;
      try {
        inspected = inspectPortableExecutable(Buffer.from(entry.data()), `${path.basename(file)}:${member}`);
      } catch (error) {
        fail(PREFIX, error instanceof Error ? error.message : String(error));
      }
      if (inspected.machine !== 0x8664 || inspected.magic !== 0x20b) {
        fail(PREFIX, `${path.basename(file)} ${member} is not an x64 PE32+ image`);
      }
      required.add(name);
      pending.push(...windowsVcRuntimeImports(Buffer.from(entry.data()), `${path.basename(file)}:${member}`).map((value) => value.toLowerCase()));
      pending.sort(compareText);
    }
    const actual = WINDOWS_VC_RUNTIME_DLLS.filter((name) => entries.has(`bin/${name}`));
    if (actual.join("\0") !== [...required].sort(compareText).join("\0")) {
      fail(PREFIX, `${path.basename(file)} app-local VC runtime members must exactly match its PE import closure`);
    }
    const receiptMember = `bin/${WINDOWS_VC_RUNTIME_RECEIPT}`;
    const receiptEntry = entries.get(receiptMember);
    if (!receiptEntry?.isFile) {
      fail(PREFIX, `${path.basename(file)} is missing ${receiptMember}`);
    }
    const receipt = Buffer.from(receiptEntry.data()).toString("utf8");
    const expectedReceipt = [...required].sort(compareText).map((name) => {
      const digest = createHash("sha256").update(Buffer.from(entries.get(`bin/${name}`).data())).digest("hex");
      return `${digest}  ${name}\n`;
    }).join("");
    if (receipt !== expectedReceipt) {
      fail(PREFIX, `${path.basename(file)} ${receiptMember} does not exactly bind its app-local VC runtime bytes`);
    }
    const manifest = Buffer.from(entries.get("manifest.properties").data()).toString("utf8");
    const expectedLine = `windowsVcRuntimeDlls=${[...required].sort(compareText).join(",")}`;
    if (!manifest.split(/\r?\n/u).includes(expectedLine)) {
      fail(PREFIX, `${path.basename(file)} manifest.properties must declare ${expectedLine}`);
    }
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
      fail(PREFIX, `missing oliphaunt-broker release asset(s): ${missing.join(", ")}`);
    }
    let presentBrokerAssets = 0;
    for (const target of targets) {
      if (await assertFileExists(path.join(args.assetDir, target.asset.replaceAll("{version}", version)))) {
        presentBrokerAssets += 1;
      }
    }
    if (presentBrokerAssets === 0) {
      fail(PREFIX, "partial oliphaunt-broker release asset validation requires at least one broker asset");
    }
  }

  const checksumAsset = `oliphaunt-broker-${version}-release-assets.sha256`;
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
  console.log(`oliphaunt-broker release assets validated: ${args.assetDir}`);
}

await main();
