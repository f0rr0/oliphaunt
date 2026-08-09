#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync, spawnSync } from "../test/fd-backed-spawn-sync.mjs";

import { affectedPlanBinding } from "../../.github/scripts/release-candidate-lib.mjs";
import {
  BASE_JOBS,
  BUILDER_JOBS,
  recoveryControlPlanForAffected,
  renderPlanForFullRun,
  renderPlanWithSelection,
} from "../graph/ci_plan.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

test("recovery-control plans bind the exact affected range and omit every payload lane", () => {
  const releaseSha = "1".repeat(40);
  const controllerSha = "2".repeat(40);
  const selected = recoveryControlPlanForAffected({
    directProjects: new Set(["ci-workflows", "release-tools"]),
    projects: new Set(["ci-workflows", "release-tools"]),
    directTasks: new Set(["release-tools:check", "release-tools:test"]),
  }, { releaseSha, controllerSha });
  const plan = renderPlanWithSelection({
    ...selected,
    selectedExtensionProducts: null,
  });

  assert.deepEqual(plan.jobs, [...BASE_JOBS].sort());
  assert.deepEqual(plan.builder_jobs, []);
  assert.deepEqual(plan.e2e_jobs, []);
  assert.equal([...BUILDER_JOBS].some((job) => plan.jobs.includes(job)), false);
  assert.equal(plan.qualification_mode, "recovery-control");
  assert.equal(plan.qualification_base_sha, releaseSha);
  assert.equal(plan.qualification_head_sha, controllerSha);
  assert.match(plan.reason, new RegExp(`${releaseSha} to ${controllerSha}`, "u"));
  for (const matrix of [
    "broker_runtime_matrix",
    "extension_artifacts_native_matrix",
    "extension_artifacts_wasix_matrix",
    "js_exact_candidate_consumer_matrix",
    "liboliphaunt_native_android_runtime_matrix",
    "liboliphaunt_native_desktop_runtime_matrix",
    "liboliphaunt_native_ios_runtime_matrix",
    "liboliphaunt_wasix_aot_runtime_matrix",
    "node_direct_runtime_matrix",
    "react_native_android_mobile_app_matrix",
  ]) {
    assert.deepEqual(plan[matrix], { include: [] }, `${matrix} must be empty`);
  }
});

test("CI obtains recovery-control mode only after release-intent lineage verification", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  );
  const intent = readFileSync(
    path.join(ROOT, ".github/scripts/check-release-intent.sh"),
    "utf8",
  );
  const verifier = intent.indexOf("tools/release/verify-publication-candidate.mjs");
  const modeOutput = intent.indexOf('qualification_mode="recovery-control"');
  assert(verifier >= 0 && verifier < modeOutput);

  const releaseIntent = workflow.jobs["release-intent"];
  assert.equal(
    releaseIntent.outputs.qualification_mode,
    "${{ steps.release_intent.outputs.qualification_mode }}",
  );
  const affected = workflow.jobs.affected;
  const plan = affected.steps.find((step) => step.id === "plan");
  const matrices = affected.steps.find((step) => step.id === "target-matrices");
  for (const step of [plan, matrices]) {
    assert.match(step.env.MOON_BASE, /recovery_release_sha/u);
    assert.match(step.env.MOON_HEAD, /github[.]sha/u);
  }
  assert.match(plan.env.CI_QUALIFICATION_MODE, /release-intent/u);

  const macMetadata = workflow.jobs["release-metadata-portability"];
  assert.equal(macMetadata["runs-on"], "macos-26");
  assert.equal(macMetadata.if, undefined);
  assert.deepEqual(workflow.jobs.required.needs, [
    "affected",
    "release-intent",
    "checks",
    "tests",
    "builds",
    "e2e",
  ]);
  assert.deepEqual(workflow.jobs.qualified.needs, ["affected", "required"]);
  const writer = workflow.jobs.qualified.steps.find((step) => step.id === "qualification_record");
  assert.match(writer.env.CI_QUALIFICATION_MODE, /needs[.]affected[.]outputs[.]qualification_mode/u);
});

test("ordinary non-PR planning remains full-payload", () => {
  const full = renderPlanForFullRun();
  assert.equal(full.qualification_mode, "full-payload");
  assert.equal(full.qualification_base_sha, null);
  assert.equal(full.qualification_head_sha, null);
  assert(full.builder_jobs.length > 0);
  assert(full.e2e_jobs.length > 0);

  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  );
  const plan = workflow.jobs.affected.steps.find((step) => step.id === "plan");
  assert.match(plan.env.CI_QUALIFICATION_MODE, /needs[.]release-intent[.]outputs[.]qualification_mode/u);
  const script = readFileSync(
    path.join(ROOT, ".github/scripts/check-release-intent.sh"),
    "utf8",
  );
  assert.match(script, /qualification_mode="full-payload"/u);
});

test("publication must explicitly request a recovery-control candidate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-recovery-control-candidate-"));
  try {
    const releaseSha = "1".repeat(40);
    const controllerSha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const planPath = path.join(root, "ci-plan.json");
    const candidatePath = path.join(root, "candidate.json");
    writeFileSync(planPath, `${JSON.stringify({
      qualification_mode: "recovery-control",
      qualification_base_sha: releaseSha,
      qualification_head_sha: controllerSha,
      jobs: ["affected"],
      projects: ["release-tools"],
      extension_package_products: [],
    }, null, 2)}\n`);
    writeFileSync(candidatePath, `${JSON.stringify({
      schemaVersion: 2,
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      workflowRef: "f0rr0/oliphaunt/.github/workflows/ci.yml@refs/heads/main",
      runId: "123456",
      runAttempt: 1,
      eventName: "push",
      ref: "refs/heads/main",
      sha: controllerSha,
      tree,
      affectedPlan: affectedPlanBinding(planPath, false),
      evidenceRequirements: {
        wasixReleaseRegression: false,
        artifacts: [],
      },
      evidence: { wasixReleaseRegression: null },
    }, null, 2)}\n`);
    const baseArgs = [
      ".github/scripts/verify-release-candidate.mjs",
      candidatePath,
      "--plan",
      planPath,
      "--wasix-evidence-required",
      "false",
    ];
    const environment = {
      ...process.env,
      CI_RUN_ID: "123456",
      GITHUB_REPOSITORY: "f0rr0/oliphaunt",
      RELEASE_HEAD_SHA: controllerSha,
    };
    const accepted = spawnSync(process.execPath, [
      ...baseArgs,
      "--qualification-mode",
      "recovery-control",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    const defaulted = spawnSync(process.execPath, baseArgs, {
      cwd: ROOT,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(defaulted.status, 1);
    assert.match(defaulted.stderr, /expected full-payload, got recovery-control/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
