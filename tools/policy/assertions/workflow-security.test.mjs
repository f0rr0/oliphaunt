#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPinnedRemoteUses,
  assertWorkflowSecurity,
  executableShell,
} from "./workflow-security.mjs";

const SHA = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";

function workflow(steps = [], extra = {}) {
  return {
    on: { workflow_dispatch: {} },
    permissions: { contents: "read" },
    jobs: {
      check: {
        "runs-on": "ubuntu-24.04",
        steps,
      },
    },
    ...extra,
  };
}

test("remote actions require immutable revisions", () => {
  assert.doesNotThrow(() => assertPinnedRemoteUses({
    steps: [
      { uses: `actions/checkout@${SHA}` },
      { uses: "./.github/actions/setup-bun" },
      { uses: `docker://example/image@sha256:${"a".repeat(64)}` },
    ],
  }, "fixture"));

  for (const uses of ["actions/checkout@v4", "docker://example/image:latest"]) {
    assert.throws(
      () => assertPinnedRemoteUses({ steps: [{ uses }] }, "fixture"),
      /must pin/u,
    );
  }
});

test("workflow-wide permissions stay read-only", () => {
  const candidate = workflow();
  candidate.permissions.contents = "write";
  assert.throws(() => assertWorkflowSecurity(candidate), /top-level contents permission/u);
});

test("OIDC tokens require a protected environment", () => {
  const candidate = workflow();
  candidate.jobs.check.permissions = { contents: "read", "id-token": "write" };
  assert.throws(() => assertWorkflowSecurity(candidate), /protected environment/u);
  candidate.jobs.check.environment = "release";
  assert.doesNotThrow(() => assertWorkflowSecurity(candidate));
});

test("checkouts do not retain credentials or use mutable literal refs", () => {
  const candidate = workflow([{
    uses: `actions/checkout@${SHA}`,
    with: { ref: "main", "persist-credentials": false },
  }]);
  assert.throws(() => assertWorkflowSecurity(candidate), /explicit SHA expression/u);
  candidate.jobs.check.steps[0].with.ref = "${{ github.sha }}";
  assert.doesNotThrow(() => assertWorkflowSecurity(candidate));
  candidate.jobs.check.steps[0].with["persist-credentials"] = true;
  assert.throws(() => assertWorkflowSecurity(candidate), /disable persisted credentials/u);
});

test("artifact downloads are explicit and stay in the current run", () => {
  const candidate = workflow([{
    uses: `actions/download-artifact@${SHA}`,
    with: { name: "candidate", path: "target/candidate" },
  }]);
  assert.doesNotThrow(() => assertWorkflowSecurity(candidate));

  candidate.jobs.check.steps[0].with["run-id"] = "123";
  assert.throws(() => assertWorkflowSecurity(candidate), /another run or repository/u);
  delete candidate.jobs.check.steps[0].with["run-id"];
  delete candidate.jobs.check.steps[0].with.name;
  assert.throws(() => assertWorkflowSecurity(candidate), /must select artifacts/u);
  candidate.jobs.check.steps[0].with = { name: "candidate" };
  assert.throws(() => assertWorkflowSecurity(candidate), /explicit destination/u);
});

test("write-capable jobs consume artifacts only by exact ID", () => {
  const candidate = workflow([{
    uses: `actions/download-artifact@${SHA}`,
    with: { name: "candidate", path: "target/candidate" },
  }]);
  candidate.jobs.check.permissions = { contents: "write" };
  assert.throws(() => assertWorkflowSecurity(candidate), /exact artifact ID/u);
  candidate.jobs.check.steps[0].with = {
    "artifact-ids": "${{ needs.build.outputs.artifact_id }}",
    path: "target/candidate",
  };
  assert.doesNotThrow(() => assertWorkflowSecurity(candidate));
});

test("artifact uploads have an identity and source", () => {
  const candidate = workflow([{
    uses: `actions/upload-artifact@${SHA}`,
    with: { name: "proof", path: "target/proof" },
  }]);
  assert.doesNotThrow(() => assertWorkflowSecurity(candidate));
  delete candidate.jobs.check.steps[0].with.path;
  assert.throws(() => assertWorkflowSecurity(candidate), /source path/u);
});

test("dead comments and heredoc bodies are not executable workflow commands", () => {
  const shell = executableShell([
    "# node dead.mjs",
    "cat <<'BODY'",
    "node also-dead.mjs",
    "BODY",
    "node live.mjs # node ignored.mjs",
  ].join("\n"));
  assert.doesNotMatch(shell, /dead[.]mjs/u);
  assert.match(shell, /node live[.]mjs/u);
});
