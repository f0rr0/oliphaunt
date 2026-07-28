#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT,
} from "../graph/ci_plan.mjs";
import {
  compareText,
  exactExtensionProducts,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import {
  assertExactFiles,
  selectedExtensionDependencies,
  stageExtensionCarrier,
} from "./stage-native-extension-lifecycle.mjs";
import { verifyReceipts } from "./verify-native-extension-lifecycle-receipts.mjs";
import { writeReceipt } from "./write-native-extension-lifecycle-receipt.mjs";

const CANDIDATE_SHA = "a".repeat(40);
const CANDIDATE_TREE = "b".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalExtensions() {
  return exactExtensionProducts("native-extension-lifecycle-receipts.test")
    .flatMap((product) => extensionSqlNames(product, "native-extension-lifecycle-receipts.test"))
    .sort(compareText);
}

function inputEnvelope(extensions = canonicalExtensions()) {
  const identities = [
    "broker",
    "broker-checksum",
    "native-extension-index",
    "native-extension-legacy-index",
    "native-extension-proof-runner",
    "native-runtime",
    "native-tools",
    ...extensions.map((name) => `native-extension:${name}`),
  ].sort(compareText);
  const core = {
    schema: "oliphaunt-native-extension-lifecycle-inputs-v1",
    candidateSha: CANDIDATE_SHA,
    candidateTree: CANDIDATE_TREE,
    target: "linux-x64-gnu",
    extensionCount: extensions.length,
    extensions,
    modes: ["direct", "broker", "server"],
    lifecycle: ["install", "load", "restart", "backup", "restore"],
    consumedArtifacts: identities.map((identity, index) => ({
      identity,
      file: `artifact-${index}.tar.gz`,
      bytes: index + 1,
      sha256: sha256(identity),
    })),
  };
  return { ...core, inputEnvelopeSha256: sha256(JSON.stringify(core)) };
}

function proofLog(inputs, shardIndex, shardCount) {
  const selected = inputs.extensions.filter((_, index) => index % shardCount === shardIndex);
  const lines = [
    `OLIPHAUNT_NATIVE_EXTENSION_PROOF_START shard=${shardIndex}/${shardCount} selected=${selected.length} planned=${inputs.extensions.length} modes=direct,broker,server`,
  ];
  for (const extension of selected) {
    lines.push(
      `OLIPHAUNT_NATIVE_EXTENSION_PROOF_EXTENSION_PASS shard=${shardIndex}/${shardCount} extension=${extension} modes=direct,broker,server lifecycle=install-load-restart-backup-restore`,
    );
  }
  lines.push(
    `OLIPHAUNT_NATIVE_EXTENSION_PROOF_PASS shard=${shardIndex}/${shardCount} planned=${inputs.extensions.length} modes=direct,broker,server`,
  );
  return `${lines.join("\n")}\n`;
}

function fixture(extensions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-extension-receipts-"));
  const input = path.join(root, "inputs.json");
  const inputs = inputEnvelope(extensions);
  writeFileSync(input, `${JSON.stringify(inputs, null, 2)}\n`);
  return { input, inputs, root };
}

function carrierEntries(files) {
  return new Map([
    [
      "manifest.properties",
      { data: Buffer.from("packageLayout=oliphaunt-extension-artifact-v1\n"), isDirectory: false, mode: 0o644 },
    ],
    ...files.map(([name, data, mode = 0o644]) => [
      `files/${name}`,
      { data: Buffer.from(data), isDirectory: false, mode },
    ]),
  ]);
}

function writeShard(value, shardIndex, {
  shardCount = NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT,
  logOverride,
} = {}) {
  const log = path.join(value.root, `proof-shard-${shardIndex}.log`);
  const output = path.join(value.root, `receipt-shard-${shardIndex}.json`);
  writeFileSync(log, logOverride ?? proofLog(value.inputs, shardIndex, shardCount));
  writeReceipt({
    inputs: value.input,
    log,
    output,
    "shard-index": String(shardIndex),
    "shard-count": String(shardCount),
  });
  return output;
}

test("the current first-release extension catalog contains 39 products", () => {
  assert.equal(canonicalExtensions().length, 39);
});

test("native staging excludes built-in dependencies from packaged extension dependency edges", () => {
  assert.equal(selectedExtensionDependencies({
    dependencies: ["plpgsql"],
    "selected-extension-dependencies": [],
  }), "");
  assert.equal(selectedExtensionDependencies({
    dependencies: ["plpgsql", "postgis"],
    "selected-extension-dependencies": ["postgis"],
  }), "postgis");
});

test("exact lifecycle input diagnostics report basenames without masking inventory drift", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-extension-inputs-"));
  try {
    writeFileSync(path.join(root, "unexpected.tar.gz"), "unexpected");
    assert.throws(
      () => assertExactFiles(root, [path.join(root, "expected.tar.gz")], "lifecycle input"),
      /expected=expected\.tar\.gz; actual=unexpected\.tar\.gz/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("native lifecycle staging flattens carrier envelopes and merges members by release product", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-extension-staging-"));
  try {
    const contrib = { "release-product": "oliphaunt-extension-contrib-pg18" };
    stageExtensionCarrier(carrierEntries([
      ["share/postgresql/extension/amcheck.control", "default_version = '1.5'\n"],
      ["share/postgresql/extension/amcheck--1.4.sql", "SELECT 1;\n"],
      ["share/postgresql/extension/amcheck--1.4--1.5.sql", "SELECT 2;\n"],
      ["lib/postgresql/amcheck.so", "amcheck-module", 0o755],
    ]), root, contrib, "amcheck carrier");
    stageExtensionCarrier(carrierEntries([
      ["lib/postgresql/auto_explain.so", "auto-explain-module", 0o755],
    ]), root, contrib, "auto_explain carrier");
    stageExtensionCarrier(carrierEntries([
      ["share/postgresql/extension/vector.control", "default_version = '0.8.0'\n"],
      ["lib/postgresql/vector.so", "vector-module", 0o755],
    ]), root, { "release-product": "oliphaunt-extension-vector" }, "vector carrier");

    const extensionRoot = path.join(root, "resources/extension");
    const contribRoot = path.join(extensionRoot, "oliphaunt-extension-contrib-pg18");
    assert.equal(
      readFileSync(path.join(contribRoot, "share/postgresql/extension/amcheck.control"), "utf8"),
      "default_version = '1.5'\n",
    );
    assert.equal(
      readFileSync(
        path.join(contribRoot, "share/postgresql/extension/amcheck--1.4--1.5.sql"),
        "utf8",
      ),
      "SELECT 2;\n",
    );
    assert.equal(
      readFileSync(path.join(contribRoot, "lib/postgresql/auto_explain.so"), "utf8"),
      "auto-explain-module",
    );
    assert.ok((statSync(path.join(contribRoot, "lib/postgresql/auto_explain.so")).mode & 0o111) !== 0);
    assert.equal(
      readFileSync(
        path.join(extensionRoot, "oliphaunt-extension-vector/lib/postgresql/vector.so"),
        "utf8",
      ),
      "vector-module",
    );
    assert.equal(existsSync(path.join(contribRoot, "manifest.properties")), false);
    assert.equal(existsSync(path.join(contribRoot, "files")), false);
    assert.equal(existsSync(path.join(extensionRoot, "amcheck")), false);
    assert.equal(existsSync(path.join(extensionRoot, "auto_explain")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("native lifecycle product merges accept identical files and reject differing bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-extension-merge-"));
  const product = { "release-product": "oliphaunt-extension-contrib-pg18" };
  const relative = "share/postgresql/extension/shared--1.0.sql";
  try {
    stageExtensionCarrier(carrierEntries([[relative, "same\n"]]), root, product, "first carrier");
    stageExtensionCarrier(carrierEntries([[relative, "same\n"]]), root, product, "identical carrier");
    assert.throws(
      () => stageExtensionCarrier(carrierEntries([[relative, "different\n"]]), root, product, "conflicting carrier"),
      /payload conflicts .* with different bytes/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("three machine shard receipts aggregate to the exact artifact-bound release-ready catalog", () => {
  const value = fixture();
  try {
    for (
      let shardIndex = 0;
      shardIndex < NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT;
      shardIndex += 1
    ) writeShard(value, shardIndex);
    const output = path.join(value.root, "aggregate-receipt.json");
    verifyReceipts({
      receipts: value.root,
      "candidate-sha": CANDIDATE_SHA,
      "candidate-tree": CANDIDATE_TREE,
      "expected-extensions-csv": value.inputs.extensions.join(","),
      "expected-shard-count": String(NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT),
      output,
    });
    const aggregate = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(aggregate.extensionCount, value.inputs.extensions.length);
    assert.deepEqual(aggregate.extensions, value.inputs.extensions);
    assert.deepEqual(
      aggregate.shardReceipts.map((receipt) => receipt.shardIndex),
      Array.from(
        { length: NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT },
        (_, shardIndex) => shardIndex,
      ),
    );
    assert.match(aggregate.aggregateSha256, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});

test("focused dependency-closure proof uses one nonempty shard and aggregates exactly the selected subset", () => {
  const value = fixture(["cube", "earthdistance"]);
  try {
    writeShard(value, 0, { shardCount: 1 });
    const output = path.join(value.root, "aggregate-receipt.json");
    verifyReceipts({
      receipts: value.root,
      "candidate-sha": CANDIDATE_SHA,
      "candidate-tree": CANDIDATE_TREE,
      "expected-extensions-csv": value.inputs.extensions.join(","),
      "expected-shard-count": "1",
      output,
    });
    const aggregate = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(aggregate.extensions, ["cube", "earthdistance"]);
    assert.equal(aggregate.extensionCount, 2);
    assert.equal(aggregate.shardCount, 1);
    assert.deepEqual(aggregate.shardReceipts.map((receipt) => receipt.shardIndex), [0]);
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});

test("shard receipt generation rejects omitted extension PASS records and incomplete artifact evidence", () => {
  const value = fixture();
  try {
    const incompleteLog = proofLog(value.inputs, 0, NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT)
      .split("\n")
      .filter((line) => !line.includes(`extension=${value.inputs.extensions[0]} `))
      .join("\n");
    assert.throws(() => writeShard(value, 0, { logOverride: incompleteLog }), /unique extension PASS records/u);

    const { inputEnvelopeSha256: ignored, ...core } = value.inputs;
    core.consumedArtifacts = core.consumedArtifacts.slice(1);
    const incomplete = { ...core, inputEnvelopeSha256: sha256(JSON.stringify(core)) };
    writeFileSync(value.input, `${JSON.stringify(incomplete, null, 2)}\n`);
    assert.throws(() => writeShard(value, 0), /enumerate all \d+ consumed artifacts/u);
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});

test("aggregate verification rejects candidate, shard, and PASS-record drift even with recomputed receipts", () => {
  const mutations = [
    (receipt) => { receipt.candidateSha = "c".repeat(40); },
    (receipt) => { receipt.extensions = receipt.extensions.slice(1); receipt.extensionCount -= 1; },
    (receipt) => { receipt.passRecords[0].modes = ["direct", "broker"]; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    try {
      const files = Array.from(
        { length: NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT },
        (_, shardIndex) => writeShard(value, shardIndex),
      );
      const receipt = JSON.parse(readFileSync(files[0], "utf8"));
      mutate(receipt);
      const { receiptSha256: ignored, ...core } = receipt;
      receipt.receiptSha256 = sha256(JSON.stringify(core));
      writeFileSync(files[0], `${JSON.stringify(receipt, null, 2)}\n`);
      assert.throws(
        () => verifyReceipts({
          receipts: value.root,
          "candidate-sha": CANDIDATE_SHA,
          "candidate-tree": CANDIDATE_TREE,
          "expected-extensions-csv": value.inputs.extensions.join(","),
          "expected-shard-count": String(NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT),
          output: path.join(value.root, "aggregate-receipt.json"),
        }),
        /candidate identity mismatch|PASS record count drift|malformed or misordered/u,
      );
    } finally {
      rmSync(value.root, { force: true, recursive: true });
    }
  }
});
