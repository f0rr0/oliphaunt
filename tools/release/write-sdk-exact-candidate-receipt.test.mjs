#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  inventoryInput,
  proofResults,
  writeReceipt,
} from "./write-sdk-exact-candidate-receipt.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const roots = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sdk-exact-candidate-receipt-test-"));
  roots.push(root);
  return root;
}

function rustLog() {
  return [
    "OLIPHAUNT_RUST_RELEASE_CONSUMER_STAGE_PASS stage=package-envelope",
    "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeServer checks=open,select,vector,backup,restore,close",
    "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeBroker checks=open,select,vector,backup,close",
    "OLIPHAUNT_RUST_RELEASE_CONSUMER_MODE_PASS mode=nativeDirect checks=open,select,vector,backup,close",
    "OLIPHAUNT_RUST_RELEASE_CONSUMER_PASS",
    "",
  ].join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SDK exact-candidate consumer receipts", () => {
  test("hashes every regular input file and writes a candidate-bound passing receipt", async () => {
    const root = temporaryRoot();
    const input = path.join(root, "input");
    mkdirSync(path.join(input, "nested"), { recursive: true });
    writeFileSync(path.join(input, "one.crate"), "one");
    writeFileSync(path.join(input, "nested", "two.tar.gz"), "two-two");
    const logFile = path.join(root, "proof.log");
    const outputFile = path.join(root, "receipt.json");
    writeFileSync(logFile, rustLog());

    const receipt = await writeReceipt({
      candidateSha: SHA,
      candidateTree: TREE,
      checkoutSha: SHA,
      checkoutTree: TREE,
      inputs: [{ label: "rust-sdk", root: input }],
      logFile,
      outputFile,
      proofOutcome: "success",
      sdk: "rust",
      workflowSha: WORKFLOW_SHA,
    });

    expect(receipt.passed).toBe(true);
    expect(receipt.candidateSha).toBe(SHA);
    expect(receipt.candidateTree).toBe(TREE);
    expect(receipt.workflowSha).toBe(WORKFLOW_SHA);
    expect(receipt.inputArtifacts[0].files).toEqual([
      {
        path: "nested/two.tar.gz",
        bytes: 7,
        sha256: createHash("sha256").update("two-two").digest("hex"),
      },
      {
        path: "one.crate",
        bytes: 3,
        sha256: createHash("sha256").update("one").digest("hex"),
      },
    ]);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual(receipt);
    expect(receipt.proof.modes.every((mode) => mode.passed)).toBe(true);
  });

  test("records failed and incomplete functional proof without claiming success", async () => {
    const root = temporaryRoot();
    const input = path.join(root, "input");
    mkdirSync(input);
    writeFileSync(path.join(input, "candidate.zip"), "bytes");
    const logFile = path.join(root, "proof.log");
    const outputFile = path.join(root, "receipt.json");
    writeFileSync(logFile, "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_STAGE_PASS stage=manifest-localization\n");
    const receipt = await writeReceipt({
      candidateSha: SHA,
      candidateTree: TREE,
      checkoutSha: SHA,
      checkoutTree: TREE,
      inputs: [{ label: "swift-sdk", root: input }],
      logFile,
      outputFile,
      proofOutcome: "failure",
      sdk: "swift",
      workflowSha: WORKFLOW_SHA,
    });
    expect(receipt.passed).toBe(false);
    expect(receipt.proofOutcome).toBe("failure");
    expect(receipt.proof.modes[0].results.select).toBe(false);
    expect(receipt.diagnostics).toContain("functional proof outcome was failure");
  });

  test("preserves skipped-proof evidence when packaging produced no log or input tree", async () => {
    const root = temporaryRoot();
    const outputFile = path.join(root, "evidence", "receipt.json");
    const receipt = await writeReceipt({
      candidateSha: SHA,
      candidateTree: TREE,
      checkoutSha: SHA,
      checkoutTree: TREE,
      inputs: [{ label: "swift-sdk", root: path.join(root, "missing-sdk") }],
      logFile: path.join(root, "missing-proof.log"),
      outputFile,
      proofOutcome: "skipped",
      sdk: "swift",
      workflowSha: WORKFLOW_SHA,
    });
    expect(receipt.passed).toBe(false);
    expect(receipt.proofOutcome).toBe("skipped");
    expect(receipt.proofLog.bytes).toBe(0);
    expect(receipt.inputArtifacts[0].errors).toContain("input root does not exist");
    expect(receipt.diagnostics).toContain("proof log is missing");
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual(receipt);
  });

  test("rejects duplicate PASS markers and records symlink inputs", async () => {
    expect(proofResults("rust", `${rustLog()}${rustLog()}`).passed).toBe(false);
    const root = temporaryRoot();
    const input = path.join(root, "input");
    mkdirSync(input);
    writeFileSync(path.join(root, "outside"), "outside");
    symlinkSync(path.join(root, "outside"), path.join(input, "link"));
    const inventory = await inventoryInput("sdk", input);
    expect(inventory.files).toEqual([]);
    expect(inventory.errors).toContain("link: symbolic links are forbidden");
    expect(inventory.errors).toContain("input root contains no regular files");
  });

  test("requires the complete staged WASIX Rust registry-consumer marker set", () => {
    const log = [
      "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=sdk-frozen-crate",
      "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=runtime-cargo-candidates",
      "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=local-registry",
      "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=clean-fetch",
      "OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_CONSUMER_PASS",
      "",
    ].join("\n");
    expect(proofResults("wasix-rust", log).passed).toBe(true);
    expect(proofResults("wasix-rust", log.replace("stage=clean-fetch\n", "")).passed).toBe(false);
  });
});
