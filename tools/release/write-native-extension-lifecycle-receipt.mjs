#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { compareText, exactExtensionProducts, extensionSqlNames } from "./release-artifact-targets.mjs";

function fail(message) {
  throw new Error(`write-native-extension-lifecycle-receipt.mjs: ${message}`);
}

function flags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail(`invalid argument ${name ?? ""}`);
    values[name.slice(2)] = value;
  }
  for (const name of ["inputs", "log", "output", "shard-index", "shard-count"]) {
    if (values[name] === undefined) fail(`--${name} is required`);
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalExtensions() {
  const names = exactExtensionProducts("write-native-extension-lifecycle-receipt.mjs")
    .flatMap((product) => extensionSqlNames(product, "write-native-extension-lifecycle-receipt.mjs"))
    .sort(compareText);
  if (names.length === 0 || new Set(names).size !== names.length) {
    fail("canonical release graph must resolve to a nonempty unique extension set");
  }
  return names;
}

function verifyInputEnvelope(inputs) {
  const { inputEnvelopeSha256, ...core } = inputs;
  if (inputEnvelopeSha256 !== sha256(JSON.stringify(core))) fail("input envelope digest mismatch");
  if (inputs.schema !== "oliphaunt-native-extension-lifecycle-inputs-v1") fail("unknown input envelope schema");
  if (!/^[0-9a-f]{40}$/u.test(inputs.candidateSha) || !/^[0-9a-f]{40}$/u.test(inputs.candidateTree)) {
    fail("input candidate SHA and tree must be full Git object IDs");
  }
  if (inputs.target !== "linux-x64-gnu") fail("input envelope must target canonical linux-x64-gnu");
  const canonical = canonicalExtensions();
  const selected = Array.isArray(inputs.extensions) ? inputs.extensions : [];
  const canonicalSet = new Set(canonical);
  if (
    selected.length === 0
      || inputs.extensionCount !== selected.length
      || new Set(selected).size !== selected.length
      || selected.some((name) => !canonicalSet.has(name))
      || selected.join("\0") !== [...selected].sort(compareText).join("\0")
  ) fail("input envelope extensions must be a nonempty unique sorted subset of the canonical release graph set");
  if (inputs.modes?.join(",") !== "direct,broker,server") fail("input envelope has incomplete modes");
  if (inputs.lifecycle?.join(",") !== "install,load,restart,backup,restore") {
    fail("input envelope has incomplete lifecycle");
  }
  const expectedIdentities = [
    "broker",
    "broker-checksum",
    "native-extension-index",
    "native-extension-legacy-index",
    "native-extension-proof-runner",
    "native-runtime",
    "native-tools",
    ...inputs.extensions.map((name) => `native-extension:${name}`),
  ].sort();
  if (!Array.isArray(inputs.consumedArtifacts) || inputs.consumedArtifacts.length !== expectedIdentities.length) {
    fail(`input envelope must enumerate all ${expectedIdentities.length} consumed artifacts`);
  }
  const actualIdentities = inputs.consumedArtifacts.map((artifact) => artifact?.identity);
  if (actualIdentities.join("\0") !== expectedIdentities.join("\0")) {
    fail("input envelope consumed artifact identities are incomplete or unsorted");
  }
  for (const artifact of inputs.consumedArtifacts) {
    if (
      typeof artifact.file !== "string"
        || artifact.file.length === 0
        || artifact.file.includes("/")
        || artifact.file.includes("\\")
        || !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes <= 0
        || !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) fail(`consumed artifact ${String(artifact.identity)} lacks canonical file, byte, or SHA-256 evidence`);
  }
}

export function writeReceipt(options) {
  const inputs = JSON.parse(readFileSync(options.inputs, "utf8"));
  verifyInputEnvelope(inputs);
  const plannedCount = inputs.extensions.length;
  const log = readFileSync(options.log, "utf8");
  const shardIndex = Number(options["shard-index"]);
  const shardCount = Number(options["shard-count"]);
  if (
    !Number.isInteger(shardIndex)
      || !Number.isInteger(shardCount)
      || shardCount < 1
      || shardCount > plannedCount
      || shardIndex < 0
      || shardIndex >= shardCount
  ) {
    fail(`receipt requires a shard index in [0, ${Math.max(0, shardCount - 1)}] and no more shards than planned extensions`);
  }
  const expected = inputs.extensions.filter((_, index) => index % shardCount === shardIndex);
  const passPattern = /OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_PASS shard=(\d+)\/(\d+) extension=([^ ]+) modes=([^ ]+) lifecycle=([^\s]+)/gu;
  const passRecords = [...log.matchAll(passPattern)].map((match) => ({
    shardIndex: Number(match[1]),
    shardCount: Number(match[2]),
    extension: match[3],
    modes: match[4].split(","),
    lifecycle: match[5].split("-"),
  }));
  if (passRecords.length !== expected.length || new Set(passRecords.map((row) => row.extension)).size !== passRecords.length) {
    fail(`shard ${shardIndex} must contain ${expected.length} unique extension PASS records`);
  }
  for (const record of passRecords) {
    if (record.shardIndex !== shardIndex || record.shardCount !== shardCount) fail("extension PASS record has wrong shard identity");
    if (record.modes.join(",") !== "direct,broker,server") fail(`${record.extension} PASS record has incomplete modes`);
    if (record.lifecycle.join(",") !== "install,load,restart,backup,restore") fail(`${record.extension} PASS record has incomplete lifecycle`);
  }
  const actual = passRecords.map((row) => row.extension).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) {
    fail(`shard ${shardIndex} extension set drift: expected=${expected.join(",")}; actual=${actual.join(",")}`);
  }
  const finalMarker = `OLIPHAUNT_NATIVE_EXTENSION_PROOF_PASS shard=${shardIndex}/${shardCount} planned=${plannedCount} modes=direct,broker,server`;
  if (log.split(finalMarker).length !== 2) fail(`shard ${shardIndex} must contain exactly one final PASS marker`);

  const receiptCore = {
    schema: "oliphaunt-native-extension-lifecycle-shard-receipt-v1",
    candidateSha: inputs.candidateSha,
    candidateTree: inputs.candidateTree,
    target: inputs.target,
    shardIndex,
    shardCount,
    plannedExtensionCount: plannedCount,
    extensionCount: expected.length,
    extensions: expected,
    modes: inputs.modes,
    lifecycle: inputs.lifecycle,
    inputEnvelopeSha256: inputs.inputEnvelopeSha256,
    consumedArtifacts: inputs.consumedArtifacts,
    proofLogSha256: sha256(log),
    passRecords,
  };
  const receipt = { ...receiptCore, receiptSha256: sha256(JSON.stringify(receiptCore)) };
  writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`native extension lifecycle shard receipt written: ${options.output}`);
}

if (import.meta.main) {
  try {
    writeReceipt(flags(Bun.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
