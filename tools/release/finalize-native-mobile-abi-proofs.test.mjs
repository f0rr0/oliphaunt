import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeEntriesArchive } from "../test/release-fixture-utils.mjs";
import { finalizeNativeMobileAbiProofs } from "./finalize-native-mobile-abi-proofs.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";

function receipt(target, blockSize = 8192) {
  return [
    "schema=oliphaunt-native-mobile-abi-v1",
    `target=${target}`,
    "byteOrder=little",
    "datumBytes=8",
    "maximumAlignof=8",
    "float8ByVal=1",
    `blockSize=${blockSize}`,
    "walBlockSize=8192",
    "relationSegmentSize=131072",
    "nameDataLength=64",
    "indexMaxKeys=32",
    "catalogVersion=202506291",
    "pgControlVersion=1800",
    "",
  ].join("\n");
}

function writeReceipt(root, directory, name, text) {
  const target = path.join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, name), text);
}

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-proof-test-"));
  const assetDir = path.join(root, "assets");
  const receiptRoot = path.join(root, "receipts");
  mkdirSync(assetDir);
  mkdirSync(receiptRoot);
  const archive = path.join(
    assetDir,
    "liboliphaunt-1.2.3-runtime-resources-android-datum64.tar.gz",
  );
  await writeEntriesArchive(archive, { "oliphaunt/runtime/files/value": "value\n" });
  writeReceipt(
    receiptRoot,
    "arm",
    "native-mobile-abi.properties",
    receipt("android-arm64-v8a"),
  );
  writeReceipt(
    receiptRoot,
    "x86",
    "native-mobile-abi.properties",
    receipt("android-x86_64"),
  );
  const producer = receipt("linux-x64-gnu");
  writeReceipt(receiptRoot, "arm", "native-mobile-abi-producer.properties", producer);
  writeReceipt(receiptRoot, "x86", "native-mobile-abi-producer.properties", producer);
  return { root, assetDir, receiptRoot, archive };
}

test("finalizes one domain with exact deterministic proof members", async () => {
  const current = await fixture();
  try {
    finalizeNativeMobileAbiProofs({
      domain: "android-datum64",
      assetDir: current.assetDir,
      receiptRoot: current.receiptRoot,
    });
    const first = readFileSync(current.archive);
    const proofPrefix = "oliphaunt/provenance/native-mobile-abi/";
    const proofMembers = [...readPortableArchiveEntries(current.archive).keys()]
      .filter((name) => name.startsWith(proofPrefix) && name.endsWith(".properties"))
      .sort();
    expect(proofMembers).toEqual([
      `${proofPrefix}android-arm64-v8a.properties`,
      `${proofPrefix}android-x86_64.properties`,
      `${proofPrefix}linux-x64-gnu.properties`,
    ]);

    finalizeNativeMobileAbiProofs({
      domain: "android-datum64",
      assetDir: current.assetDir,
      receiptRoot: current.receiptRoot,
    });
    expect(readFileSync(current.archive)).toEqual(first);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("rejects divergent duplicate producer receipts", async () => {
  const current = await fixture();
  try {
    writeReceipt(
      current.receiptRoot,
      "x86",
      "native-mobile-abi-producer.properties",
      receipt("linux-x64-gnu", 4096),
    );
    expect(() => finalizeNativeMobileAbiProofs({
      domain: "android-datum64",
      assetDir: current.assetDir,
      receiptRoot: current.receiptRoot,
    })).toThrow(/divergent duplicate receipts/u);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});
