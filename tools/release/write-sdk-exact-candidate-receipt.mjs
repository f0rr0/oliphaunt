#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const TOOL = "write-sdk-exact-candidate-receipt.mjs";
const SHA1 = /^[0-9a-f]{40}$/u;

const PROOF_CONTRACTS = Object.freeze({
  rust: Object.freeze({
    finalMarker: "OLIPHAUNT_RUST_RELEASE_CONSUMER_PASS",
    modes: Object.freeze([
      Object.freeze({
        mode: "nativeServer",
        checks: Object.freeze(["open", "select", "vector", "backup", "restore", "close"]),
      }),
      Object.freeze({
        mode: "nativeBroker",
        checks: Object.freeze(["open", "select", "vector", "backup", "close"]),
      }),
      Object.freeze({
        mode: "nativeDirect",
        checks: Object.freeze(["open", "select", "vector", "backup", "close"]),
      }),
    ]),
    stages: Object.freeze(["package-envelope"]),
  }),
  swift: Object.freeze({
    finalMarker: "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_PASS",
    modes: Object.freeze([
      Object.freeze({
        mode: "nativeDirect",
        checks: Object.freeze([
          "generatedManifest",
          "xcframework",
          "runtimeResources",
          "icu",
          "open",
          "select",
          "close",
        ]),
      }),
    ]),
    stages: Object.freeze(["manifest-localization", "package-build"]),
  }),
  "wasix-rust": Object.freeze({
    finalMarker: "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_CONSUMER_PASS",
    modes: Object.freeze([]),
    stages: Object.freeze([
      "sdk-frozen-crate",
      "runtime-cargo-candidates",
      "local-registry",
      "clean-fetch",
    ]),
    markerPrefix: "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE",
  }),
});

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countExactLines(log, marker) {
  return log.split(/\r?\n/u).filter((line) => line === marker).length;
}

function resultObject(names, passed) {
  return Object.fromEntries(names.map((name) => [name, passed]));
}

export function proofResults(sdk, log) {
  const contract = PROOF_CONTRACTS[sdk];
  if (contract === undefined) fail(`unknown SDK ${sdk}`);
  const stages = contract.stages.map((stage) => {
    const prefix = contract.markerPrefix ?? `OLIPHAUNT_${sdk.toUpperCase()}_RELEASE_CONSUMER`;
    const marker = `${prefix}_STAGE_PASS stage=${stage}`;
    const markerCount = countExactLines(log, marker);
    return { stage, markerCount, passed: markerCount === 1 };
  });
  const modes = contract.modes.map(({ mode, checks }) => {
    const marker = `OLIPHAUNT_${sdk.toUpperCase()}_RELEASE_CONSUMER_MODE_PASS mode=${mode} checks=${checks.join(",")}`;
    const markerCount = countExactLines(log, marker);
    const passed = markerCount === 1;
    return { mode, markerCount, passed, results: resultObject(checks, passed) };
  });
  const finalMarkerCount = countExactLines(log, contract.finalMarker);
  return {
    finalMarker: contract.finalMarker,
    finalMarkerCount,
    modes,
    passed:
      finalMarkerCount === 1
      && stages.every((stage) => stage.passed)
      && modes.every((mode) => mode.passed),
    stages,
  };
}

async function visitInput(directory, relativeRoot, files, errors) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      errors.push(`${relative}: symbolic links are forbidden`);
    } else if (metadata.isDirectory()) {
      await visitInput(absolute, relative, files, errors);
    } else if (metadata.isFile()) {
      files.push({ path: relative, bytes: metadata.size, sha256: await sha256File(absolute) });
    } else {
      errors.push(`${relative}: only regular files and directories are allowed`);
    }
  }
}

export async function inventoryInput(label, root) {
  const files = [];
  const errors = [];
  if (!existsSync(root)) {
    errors.push("input root does not exist");
  } else {
    const metadata = lstatSync(root);
    if (metadata.isSymbolicLink()) errors.push("input root must not be a symbolic link");
    else if (!metadata.isDirectory()) errors.push("input root is not a directory");
    else await visitInput(root, "", files, errors);
  }
  if (files.length === 0) errors.push("input root contains no regular files");
  return { label, files, errors };
}

function normalizedInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) fail("at least one --input label=directory is required");
  const seen = new Set();
  return inputs.map(({ label, root }) => {
    if (!/^[a-z][a-z0-9-]*$/u.test(label)) fail(`invalid input label ${label}`);
    if (seen.has(label)) fail(`duplicate input label ${label}`);
    seen.add(label);
    return { label, root: path.resolve(root) };
  }).sort((left, right) => compareText(left.label, right.label));
}

function readProofLog(file) {
  if (!existsSync(file)) return { bytes: Buffer.alloc(0), missing: true };
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { bytes: Buffer.alloc(0), invalid: true };
  }
  return { bytes: readFileSync(file), invalid: false, missing: false };
}

function writeAtomic(output, value) {
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, output);
}

export async function writeReceipt(options) {
  const {
    candidateSha,
    candidateTree,
    checkoutSha,
    checkoutTree,
    logFile,
    outputFile,
    proofOutcome,
    sdk,
    workflowSha,
  } = options;
  for (const [name, value] of Object.entries({ candidateSha, candidateTree, checkoutSha, checkoutTree, workflowSha })) {
    if (!SHA1.test(value)) fail(`${name} must be a full lowercase Git object ID`);
  }
  if (!["cancelled", "failure", "skipped", "success"].includes(proofOutcome)) {
    fail("proof outcome must be cancelled, failure, skipped, or success");
  }
  if (PROOF_CONTRACTS[sdk] === undefined) fail(`unknown SDK ${sdk}`);

  const inputs = [];
  for (const input of normalizedInputs(options.inputs)) {
    inputs.push(await inventoryInput(input.label, input.root));
  }
  const inputEnvelopeSha256 = sha256Bytes(JSON.stringify(inputs));
  const log = readProofLog(logFile);
  const logText = log.bytes.toString("utf8");
  const proof = proofResults(sdk, logText);
  const diagnostics = [];
  if (candidateSha !== checkoutSha) diagnostics.push("candidate SHA does not match checkout HEAD");
  if (candidateTree !== checkoutTree) diagnostics.push("candidate tree does not match checkout HEAD tree");
  if (log.missing) diagnostics.push("proof log is missing");
  if (log.invalid) diagnostics.push("proof log is not a regular non-symlink file");
  for (const input of inputs) {
    diagnostics.push(...input.errors.map((message) => `${input.label}: ${message}`));
  }
  if (!proof.passed) diagnostics.push("proof log does not contain the exact complete PASS marker set");
  if (proofOutcome !== "success") diagnostics.push(`functional proof outcome was ${proofOutcome}`);
  const passed = diagnostics.length === 0;

  const receiptCore = {
    schema: "oliphaunt-sdk-exact-candidate-consumer-receipt-v1",
    sdk,
    candidateSha,
    candidateTree,
    workflowSha,
    observedCheckout: { sha: checkoutSha, tree: checkoutTree },
    runner: { platform: process.platform, architecture: process.arch, release: os.release() },
    inputEnvelopeSha256,
    inputArtifacts: inputs,
    proofLog: {
      bytes: log.bytes.byteLength,
      sha256: sha256Bytes(log.bytes),
    },
    proofOutcome,
    proof,
    passed,
    diagnostics,
  };
  const receipt = { ...receiptCore, receiptSha256: sha256Bytes(JSON.stringify(receiptCore)) };
  writeAtomic(outputFile, receipt);
  console.log(`${sdk} exact-candidate consumer receipt written: ${outputFile} (passed=${passed})`);
  return receipt;
}

function parseArgs(argv) {
  const values = new Map();
  const inputs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag ?? "argument"} requires a value`);
    if (flag === "--input") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) fail("--input must be label=directory");
      inputs.push({ label: value.slice(0, separator), root: value.slice(separator + 1) });
    } else {
      if (!["--candidate-sha", "--candidate-tree", "--log", "--output", "--proof-outcome", "--sdk", "--workflow-sha"].includes(flag)) {
        fail(`unknown argument ${flag}`);
      }
      if (values.has(flag)) fail(`${flag} may be specified only once`);
      values.set(flag, value);
    }
    index += 1;
  }
  for (const flag of ["--candidate-sha", "--candidate-tree", "--log", "--output", "--proof-outcome", "--sdk", "--workflow-sha"]) {
    if (!values.has(flag)) fail(`${flag} is required`);
  }
  return {
    candidateSha: values.get("--candidate-sha"),
    candidateTree: values.get("--candidate-tree"),
    inputs,
    logFile: path.resolve(values.get("--log")),
    outputFile: path.resolve(values.get("--output")),
    proofOutcome: values.get("--proof-outcome"),
    sdk: values.get("--sdk"),
    workflowSha: values.get("--workflow-sha"),
  };
}

function gitObject(expression) {
  const result = captureCommandOutput("git", ["rev-parse", expression], {
    label: `git rev-parse ${expression}`,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git rev-parse ${expression} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout.trim();
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const receipt = await writeReceipt({
      ...options,
      checkoutSha: gitObject("HEAD"),
      checkoutTree: gitObject("HEAD^{tree}"),
    });
    if (!receipt.passed && options.proofOutcome === "success") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
