#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareText, exactExtensionProducts, extensionSqlNames } from "./release-artifact-targets.mjs";

function fail(message) {
  throw new Error(`verify-native-extension-lifecycle-receipts.mjs: ${message}`);
}

function flags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail(`invalid argument ${name ?? ""}`);
    values[name.slice(2)] = value;
  }
  for (const name of [
    "receipts",
    "candidate-sha",
    "candidate-tree",
    "expected-extensions-csv",
    "expected-shard-count",
    "output",
  ]) {
    if (values[name] === undefined) fail(`--${name} is required`);
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertConsumedArtifacts(artifacts, extensions, shardIndex) {
  const expectedIdentities = [
    "broker",
    "broker-checksum",
    "native-extension-index",
    "native-extension-legacy-index",
    "native-extension-proof-runner",
    "native-runtime",
    "native-tools",
    ...extensions.map((name) => `native-extension:${name}`),
  ].sort(compareText);
  if (!Array.isArray(artifacts) || artifacts.length !== expectedIdentities.length) {
    fail(`shard ${shardIndex} consumed artifact count drift`);
  }
  if (artifacts.map((artifact) => artifact?.identity).join("\0") !== expectedIdentities.join("\0")) {
    fail(`shard ${shardIndex} consumed artifact identities are incomplete or unsorted`);
  }
  for (const artifact of artifacts) {
    if (
      typeof artifact.file !== "string"
        || artifact.file.length === 0
        || artifact.file.includes("/")
        || artifact.file.includes("\\")
        || !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes <= 0
        || !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) fail(`shard ${shardIndex} consumed artifact ${String(artifact.identity)} lacks SHA-256 and byte evidence`);
  }
}

function receiptFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (lstatSync(file).isSymbolicLink()) fail(`receipt input contains symbolic link ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /^receipt-shard-\d+\.json$/u.test(entry.name)) files.push(file);
    }
  };
  visit(root);
  return files.sort(compareText);
}

export function verifyReceipts(options) {
  if (!/^[0-9a-f]{40}$/u.test(options["candidate-sha"]) || !/^[0-9a-f]{40}$/u.test(options["candidate-tree"])) {
    fail("candidate SHA and tree must be full 40-character Git object IDs");
  }
  const canonical = exactExtensionProducts("native-extension-lifecycle-receipts")
    .flatMap((product) => extensionSqlNames(product, "native-extension-lifecycle-receipts"))
    .sort(compareText);
  if (canonical.length === 0 || new Set(canonical).size !== canonical.length) {
    fail("canonical release graph must resolve to a nonempty unique extension set");
  }
  const expected = options["expected-extensions-csv"].split(",").filter(Boolean).sort(compareText);
  const canonicalSet = new Set(canonical);
  if (
    expected.length === 0
      || new Set(expected).size !== expected.length
      || expected.some((name) => !canonicalSet.has(name))
  ) fail("expected extension set must be a nonempty unique canonical release-graph subset");
  const expectedShardCount = Number(options["expected-shard-count"]);
  if (!Number.isInteger(expectedShardCount) || expectedShardCount < 1 || expectedShardCount > expected.length) {
    fail("expected shard count must be a positive integer no greater than the planned extension count");
  }
  const files = receiptFiles(options.receipts);
  if (files.length !== expectedShardCount) {
    fail(`expected exactly ${expectedShardCount} shard receipts, found ${files.length}`);
  }
  const receipts = files.map((file) => ({ file, receipt: JSON.parse(readFileSync(file, "utf8")) }));

  const seenShards = new Set();
  const seenExtensions = new Set();
  const inputDigests = new Set();
  let consumedArtifacts;
  for (const { file, receipt } of receipts) {
    const { receiptSha256, ...core } = receipt;
    if (receiptSha256 !== sha256(JSON.stringify(core))) fail(`shard ${receipt.shardIndex} receipt digest mismatch`);
    if (receipt.schema !== "oliphaunt-native-extension-lifecycle-shard-receipt-v1") fail("unknown shard receipt schema");
    if (receipt.candidateSha !== options["candidate-sha"] || receipt.candidateTree !== options["candidate-tree"]) {
      fail(`shard ${receipt.shardIndex} candidate identity mismatch`);
    }
    if (
      receipt.target !== "linux-x64-gnu"
        || receipt.shardCount !== expectedShardCount
        || !Number.isInteger(receipt.shardIndex)
        || receipt.shardIndex < 0
        || receipt.shardIndex >= expectedShardCount
    ) {
      fail("receipt has non-canonical target or shard identity");
    }
    if (path.basename(file) !== `receipt-shard-${receipt.shardIndex}.json`) {
      fail(`receipt filename does not match shard identity ${receipt.shardIndex}`);
    }
    if (seenShards.has(receipt.shardIndex)) fail(`duplicate shard receipt ${receipt.shardIndex}`);
    seenShards.add(receipt.shardIndex);
    if (!/^[0-9a-f]{64}$/u.test(receipt.inputEnvelopeSha256) || !/^[0-9a-f]{64}$/u.test(receipt.proofLogSha256)) {
      fail(`shard ${receipt.shardIndex} lacks input-envelope or proof-log SHA-256 evidence`);
    }
    inputDigests.add(receipt.inputEnvelopeSha256);
    assertConsumedArtifacts(receipt.consumedArtifacts, expected, receipt.shardIndex);
    const artifactJson = JSON.stringify(receipt.consumedArtifacts);
    if (consumedArtifacts === undefined) consumedArtifacts = artifactJson;
    else if (consumedArtifacts !== artifactJson) fail("shard receipts consumed different artifact envelopes");
    if (receipt.modes.join(",") !== "direct,broker,server" || receipt.lifecycle.join(",") !== "install,load,restart,backup,restore") {
      fail(`shard ${receipt.shardIndex} has incomplete modes or lifecycle`);
    }
    const expectedShardExtensions = expected.filter((_, index) => index % expectedShardCount === receipt.shardIndex);
    if (
      receipt.plannedExtensionCount !== expected.length
        || receipt.extensionCount !== expectedShardExtensions.length
        || !Array.isArray(receipt.extensions)
        || receipt.extensions.join("\0") !== expectedShardExtensions.join("\0")
        || !Array.isArray(receipt.passRecords)
        || receipt.passRecords.length !== expectedShardExtensions.length
    ) {
      fail(`shard ${receipt.shardIndex} PASS record count drift`);
    }
    for (const [index, record] of receipt.passRecords.entries()) {
      if (
        record.shardIndex !== receipt.shardIndex
          || record.shardCount !== expectedShardCount
          || record.extension !== expectedShardExtensions[index]
          || record.modes?.join(",") !== "direct,broker,server"
          || record.lifecycle?.join(",") !== "install,load,restart,backup,restore"
      ) fail(`shard ${receipt.shardIndex} has a malformed or misordered extension PASS record`);
    }
    for (const extension of receipt.extensions) {
      if (seenExtensions.has(extension)) fail(`extension ${extension} appears in multiple shard receipts`);
      seenExtensions.add(extension);
    }
  }
  if (seenShards.size !== expectedShardCount || inputDigests.size !== 1) {
    fail("shard receipts do not form one complete artifact-bound run");
  }
  const actual = [...seenExtensions].sort(compareText);
  if (actual.length !== expected.length || actual.join("\0") !== expected.join("\0")) {
    fail(`aggregate extension coverage drift: expected=${expected.join(",")}; actual=${actual.join(",")}`);
  }
  const aggregateCore = {
    schema: "oliphaunt-native-extension-lifecycle-aggregate-v1",
    candidateSha: options["candidate-sha"],
    candidateTree: options["candidate-tree"],
    target: "linux-x64-gnu",
    shardCount: expectedShardCount,
    extensionCount: expected.length,
    extensions: expected,
    modes: ["direct", "broker", "server"],
    lifecycle: ["install", "load", "restart", "backup", "restore"],
    inputEnvelopeSha256: [...inputDigests][0],
    consumedArtifacts: JSON.parse(consumedArtifacts),
    shardReceipts: receipts
      .map(({ receipt }) => ({ shardIndex: receipt.shardIndex, receiptSha256: receipt.receiptSha256 }))
      .sort((left, right) => left.shardIndex - right.shardIndex),
  };
  const aggregate = { ...aggregateCore, aggregateSha256: sha256(JSON.stringify(aggregateCore)) };
  writeFileSync(options.output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`native extension lifecycle aggregate verified: ${options.output}`);
}

if (import.meta.main) {
  try {
    verifyReceipts(flags(Bun.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
