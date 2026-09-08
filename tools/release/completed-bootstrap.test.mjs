import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreCompletedBootstrap, isCompletedMainRelease } from "../../.github/scripts/download-completed-bootstrap.mjs";
import { appendBootstrapCheckpoint, buildBootstrapLedger, loadBootstrapLedger } from "./bootstrap-ledger.mjs";

const repo = "f0rr0/oliphaunt";
const lock = {
  lockDigest: "a".repeat(64), catalogDigest: "b".repeat(64), packageEnvelopeDigest: "c".repeat(64),
  source: { commit: "1".repeat(40), tree: "2".repeat(40) }, products: [{ id: "alpha" }],
  carriers: [{ id: "cargo:alpha", product: "alpha", ecosystem: "cargo", name: "alpha", version: "1.0.0",
    role: "platform-leaf", target: "linux", publishOrder: 0,
    artifacts: [{ path: "target/alpha.crate", sha256: "d".repeat(64), size: 42 }] }],
};
const run = {
  id: 123, status: "completed", conclusion: "success", event: "workflow_dispatch", head_branch: "main",
  path: ".github/workflows/release.yml", repository: { full_name: repo }, head_repository: { full_name: repo },
  head_sha: "3".repeat(40),
};

test("completed bootstrap discovery requires canonical successful main workflow origin", () => {
  assert.equal(isCompletedMainRelease(run, repo), true);
  for (const change of [
    { conclusion: "failure" }, { status: "in_progress" }, { event: "pull_request" },
    { head_branch: "other" }, { path: ".github/workflows/other.yml" },
    { repository: { full_name: "fork/oliphaunt" } }, { head_repository: { full_name: "fork/oliphaunt" } },
    { head_sha: "main" }, { id: -1 },
  ]) assert.equal(isCompletedMainRelease({ ...run, ...change }, repo), false);
});

test("new publisher reuses a completed older bootstrap, rejecting incomplete, corrupt, and wrong evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "completed-bootstrap-"));
  const destination = path.join(root, "ledger");
  let mode = "complete";
  let sourceChecks = 0;
  const artifact = { id: 456, name: "oliphaunt-bootstrap-ledger", expired: false, digest: "sha256:" + "e".repeat(64), size_in_bytes: 42 };
  const dependencies = {
    list: (endpoint) => endpoint.includes("/artifacts") ? [artifact] : [run],
    assertSource: (observed) => {
      assert.equal(observed.head_sha, run.head_sha);
      sourceChecks++;
      if (mode === "source") throw new Error("non-publication changes");
    },
    download: (observed, envelope, directory) => {
      assert.equal(observed.id, run.id);
      assert.equal(envelope.id, artifact.id);
      const input = structuredClone(lock);
      if (mode === "wrong-lock") input.lockDigest = "f".repeat(64);
      if (mode === "wrong-source") input.source.commit = "9".repeat(40);
      appendBootstrapCheckpoint(directory, input, ["alpha"], []);
      if (mode !== "incomplete") {
        const publication = buildBootstrapLedger(input, ["alpha"]).publications[0];
        appendBootstrapCheckpoint(directory, input, ["alpha"], [{
          id: publication.id, product: publication.product, ecosystem: publication.ecosystem,
          name: publication.name, version: publication.version, lockedArtifacts: publication.artifacts,
          registryProof: { ...publication.registryExpectation, url: "https://crates.io/api/v1/crates/alpha/1.0.0" },
        }]);
      }
      if (mode === "corrupt") {
        const file = path.join(directory, readdirSync(directory).sort()[1]);
        const checkpoint = JSON.parse(readFileSync(file, "utf8"));
        checkpoint.receipts[0].registryProof.digest = "f".repeat(64);
        writeFileSync(file, JSON.stringify(checkpoint));
      }
      if (mode === "extra") writeFileSync(path.join(directory, "unexpected"), "bytes");
    },
  };
  try {
    assert.equal(restoreCompletedBootstrap({ repo, lock, destination }, dependencies), run.id);
    assert.equal(sourceChecks, 1);
    const before = loadBootstrapLedger(destination, lock, ["alpha"], { requireComplete: true }).checkpointDigest;
    for (const [value, pattern] of [
      ["incomplete", /incomplete/u], ["corrupt", /digest mismatch/u], ["wrong-lock", /no completed main bootstrap/u],
      ["wrong-source", /not bound/u], ["source", /non-publication changes/u], ["extra", /only checkpoint/u],
    ]) {
      mode = value;
      assert.throws(() => restoreCompletedBootstrap({ repo, lock, destination }, dependencies), pattern);
      assert.equal(loadBootstrapLedger(destination, lock, ["alpha"], { requireComplete: true }).checkpointDigest, before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release workflow scopes and refreshes tag tokens, and requires complete bootstrap evidence", () => {
  const workflow = Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8"));
  for (const [jobName, consumers] of [
    ["publish", { ensure_release_transport_ref: "release_tag_token", stage_github_releases: "release_tag_token", publish_swift_source_tag: "swift_tag_token" }],
    ["publish-bootstrap", { ensure_bootstrap_transport_ref: "bootstrap_tag_token" }],
  ]) {
    const steps = workflow.jobs[jobName].steps;
    for (const [consumerId, tokenId] of Object.entries(consumers)) {
      const index = steps.findIndex(({ id }) => id === consumerId);
      const tokenIndex = steps.findIndex(({ id }) => id === tokenId);
      assert.ok(tokenIndex >= 0 && tokenIndex < index);
      assert.match(steps[index].env.GH_TOKEN, new RegExp(`steps[.]${tokenId}[.]outputs[.]token`, "u"));
      const token = steps[tokenIndex];
      assert.match(token.uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/u);
      assert.equal(token.with["permission-contents"], "write");
      assert.equal(token.with["permission-workflows"], "write");
      assert.equal(token.with.owner, "f0rr0");
      assert.equal(token.with.repositories, "oliphaunt");
      assert.equal(token.with["skip-token-revoke"], undefined);
    }
  }
  const steps = workflow.jobs.publish.steps;
  assert.ok(steps.findIndex(({ id }) => id === "check_release_tag_app") < steps.findIndex(({ name }) => name === "Require the explicitly approved dry-run candidate"));
  assert.match(steps.find(({ name }) => name === "Download immutable registry bootstrap ledger").run, /download-completed-bootstrap/u);
  assert.match(steps.find(({ name }) => name === "Verify immutable bootstrap ledger and registry existence").run, /--require-complete/u);
});
