#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  GITHUB_CONTENT_WRITE_COLD_START_MS,
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
  GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR,
  GITHUB_CONTENT_WRITES_PER_ROLLING_MINUTE,
  reserveGitHubContentWriteSync,
} from "./github-content-write-pacer.mjs";
import { runGitHubMutationSync } from "./github-release-mutations.mjs";
import { loadGraph } from "./release-graph.mjs";
import {
  allArtifactTargets,
  exactExtensionProducts,
} from "./release-artifact-targets.mjs";
import { expectedExtensionGithubReleaseAssetCount } from "./publication-lock.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";
import {
  NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS,
  NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER,
  NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS,
  NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
} from "./crates-io-bootstrap-capacity.mjs";
import {
  FIRST_RELEASE_NOMINAL_CORE_REQUESTS,
  FIRST_RELEASE_TRANSFER_REQUEST_TOTAL,
  assertReleaseRequestWindow,
  conservativeCoreRequestCount,
  contentWriteBudgetFromCounts,
  releasePageUpperBound,
  sourceTagWriteCount,
} from "./github-release-request-budget.mjs";
import {
  RELEASE_CURRENT_MAIN_REVALIDATION_TIMEOUT_SECONDS,
  RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS,
  RELEASE_FINALIZATION_RESERVE_SECONDS,
  RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS,
  RELEASE_JOB_HARD_WINDOW_SECONDS,
  RELEASE_MINIMUM_FINALIZATION_SECONDS,
} from "./release-finalization-budget.mjs";

const SHA = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-pacer-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const environment = {
    GH_TOKEN: "test-token",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1000",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: path.join(root, "pacer.json"),
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, "core-requests.json"),
  };
  let nowMs = 1_010_000;
  const sleeps = [];
  return {
    environment,
    now: () => nowMs,
    setNow: (value) => { nowMs = value; },
    sleep: (milliseconds) => { sleeps.push(milliseconds); nowMs += milliseconds; },
    sleeps,
  };
}

test("a new runner waits out the remaining rolling hour and persists before each request slot", (t) => {
  const f = fixture(t);
  const first = reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "first",
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(first.waitedMs, GITHUB_CONTENT_WRITE_COLD_START_MS - 10_000);
  assert.equal(first.sequence, 1);
  const second = reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "second",
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(second.waitedMs, GITHUB_CONTENT_WRITE_INTERVAL_MS);
  assert.equal(second.sequence, 2);
  const state = JSON.parse(readFileSync(f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH, "utf8"));
  assert.equal(state.sequence, 2);
  assert.equal(state.lastLabel, "second");
  assert.deepEqual(state.reservations, [
    { label: "first", reservedAtMs: 4_600_000, sequence: 1 },
    { label: "second", reservedAtMs: 4_610_000, sequence: 2 },
  ]);
});

test("a malformed or identity-replaced durable journal fails closed", (t) => {
  const f = fixture(t);
  reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "first",
    now: f.now,
    sleep: f.sleep,
  });
  const file = f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH;
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.reservations[0].reservedAtMs += 1;
  writeFileSync(file, `${JSON.stringify(state)}\n`);
  assert.throws(
    () => reserveGitHubContentWriteSync({
      environment: f.environment,
      label: "second",
      now: f.now,
      sleep: f.sleep,
    }),
    /summary does not match.*journal/u,
  );
});

test("a continuation preserves pacing through the verified root run lineage", (t) => {
  const f = fixture(t);
  reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "root stage",
    now: f.now,
    sleep: f.sleep,
  });
  const childEnvironment = {
    ...f.environment,
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_RUN_ID: "456",
    OLIPHAUNT_RELEASE_ROOT_RUN_ID: "123",
  };
  const child = reserveGitHubContentWriteSync({
    environment: childEnvironment,
    label: "child finalization",
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(child.sequence, 2);
  assert.equal(child.waitedMs, GITHUB_CONTENT_WRITE_INTERVAL_MS);
  assert.throws(
    () => reserveGitHubContentWriteSync({
      environment: { ...childEnvironment, OLIPHAUNT_RELEASE_ROOT_RUN_ID: "122" },
      label: "wrong lineage",
      now: f.now,
      sleep: f.sleep,
    }),
    /rootRunId does not match the current release lineage/u,
  );
});

test("five concurrent product lanes serialize repeated shared pacer and core-request reservations without loss", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-journal-processes-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pacer = path.join(root, "pacer.json");
  const core = path.join(root, "core.json");
  const worker = path.join(root, "reserve-worker.mjs");
  writeFileSync(worker, `
import { reserveGitHubContentWriteSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-content-write-pacer.mjs")).href)};
import { reserveGitHubCoreRequestSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-core-request-journal.mjs")).href)};
for (let attempt = 0; attempt < 4; attempt += 1) {
  const label = \`asset-\${process.argv[2]}-\${attempt}\`;
  reserveGitHubContentWriteSync({
    environment: process.env,
    label,
    timing: { coldStartMs: 0, intervalMs: 5, maxLockWaitMs: 1_000 },
  });
  reserveGitHubCoreRequestSync({ environment: process.env, label });
}
`);
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: "false",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "456",
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: pacer,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true",
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: core,
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
  };
  const run = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, String(index)], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`journal worker ${index} failed (${code}/${signal}): ${stderr}`));
    });
  });
  await Promise.all(Array.from({ length: 5 }, (_, index) => run(index)));
  const pacerState = JSON.parse(readFileSync(pacer, "utf8"));
  const coreState = JSON.parse(readFileSync(core, "utf8"));
  assert.equal(pacerState.sequence, 20);
  assert.equal(pacerState.reservations.length, 20);
  assert.deepEqual(pacerState.reservations.map(({ sequence }) => sequence),
    Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(coreState.sequence, 20);
  assert.equal(coreState.attempts.length, 20);
  assert.deepEqual(
    new Set(coreState.attempts.map(({ label }) => label)),
    new Set(Array.from(
      { length: 5 },
      (_, index) => Array.from({ length: 4 }, (__, attempt) => `asset-${index}-${attempt}`),
    ).flat()),
  );
});

test("GitHub Actions cannot weaken production pacer timing", (t) => {
  const f = fixture(t);
  assert.throws(
    () => reserveGitHubContentWriteSync({
      environment: { ...f.environment, OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true" },
      label: "forbidden-override",
      timing: { coldStartMs: 0, intervalMs: 1, maxLockWaitMs: 1 },
    }),
    /custom timing is test-only/u,
  );
});

test("cold-start pacing occurs outside a complete 60-second request timeout", (t) => {
  const f = fixture(t);
  let observedTimeout = 0;
  const output = runGitHubMutationSync(
    ["api", "repos/f0rr0/oliphaunt/git/refs", "-X", "POST", "--input", "-"],
    {
      environment: f.environment,
      input: `${JSON.stringify({ ref: "refs/tags/test-v1.0.0", sha: SHA })}\n`,
      pacerOptions: { now: f.now, sleep: f.sleep },
      spawn: (_command, _args, options) => {
        observedTimeout = options.timeout;
        return { status: 0, stdout: "{}", stderr: "" };
      },
      timeoutMs: 60_000,
    },
  );
  assert.equal(output, "{}");
  assert.equal(observedTimeout, 60_000);
  assert.equal(f.sleeps[0], GITHUB_CONTENT_WRITE_COLD_START_MS - 10_000);
});

test("pacing that crosses the absolute deadline issues no transport attempt", (t) => {
  const f = fixture(t);
  let spawnCalls = 0;
  assert.throws(
    () => runGitHubMutationSync(
      ["api", "repos/f0rr0/oliphaunt/git/refs", "-X", "POST", "--input", "-"],
      {
        deadlineMs: 4_659_999,
        environment: f.environment,
        input: `${JSON.stringify({ ref: "refs/tags/test-v1.0.0", sha: SHA })}\n`,
        now: f.now,
        pacerOptions: { now: f.now, sleep: f.sleep },
        spawn: () => {
          spawnCalls += 1;
          return { status: 0, stdout: "{}", stderr: "" };
        },
        timeoutMs: 60_000,
      },
    ),
    /requires its complete 60000ms transport timeout after pacing/u,
  );
  assert.equal(spawnCalls, 0);
});

test("the live-derived 18-product/141-asset first release fits both GitHub hourly ceilings", () => {
  const graph = loadGraph("github-content-write-pacer.test");
  const extensionAssetCount = exactExtensionProducts("github-content-write-pacer.test")
    .reduce((total, product) => total + expectedExtensionGithubReleaseAssetCount(product), 0);
  const binaryAssetCount = [
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
  ].reduce((total, product) => total + allArtifactTargets(
    { product, publishedOnly: true, surface: "github-release" },
    "github-content-write-pacer.test",
  ).length, 0);
  assert.equal(extensionAssetCount, 108);
  assert.equal(binaryAssetCount, 33);
  const assetCount = extensionAssetCount + binaryAssetCount;
  const extensionProducts = new Set(exactExtensionProducts("github-content-write-pacer.test"));
  const binaryProducts = new Set([
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
  ]);
  const assetCounts = new Map(Object.keys(graph.products).map((product) => [
    product,
    extensionProducts.has(product)
      ? expectedExtensionGithubReleaseAssetCount(product)
      : binaryProducts.has(product)
        ? allArtifactTargets(
          { product, publishedOnly: true, surface: "github-release" },
          "github-content-write-pacer.test",
        ).length
        : 0,
  ]));
  const budget = contentWriteBudgetFromCounts({
    assetCount,
    assetCounts,
    attestationWrites: 6,
    productCount: 18,
    rollingCoreRequestCount: 60,
    sourceTagWrites: sourceTagWriteCount(graph, Object.keys(graph.products)),
  });
  assert.equal(sourceTagWriteCount(graph, ["oliphaunt-swift"]), 1);
  assert.equal(sourceTagWriteCount(graph, ["oliphaunt-rust"]), 0);
  assert.equal(budget.preRegistryContentWrites, 184);
  assert.equal(budget.totalContentWrites, 202);
  assert.equal(FIRST_RELEASE_TRANSFER_REQUEST_TOTAL, 86);
  assert.equal(FIRST_RELEASE_NOMINAL_CORE_REQUESTS, 391);
  assert.equal(budget.conservativeCoreRequests, 391);
  assert.equal(conservativeCoreRequestCount({
    assetCount: 141,
    assetCounts,
    attestationWrites: 6,
    productCount: 18,
  }), 391);
  assert.equal(GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR, 361);
  assert.equal(GITHUB_CONTENT_WRITES_PER_ROLLING_MINUTE, 7);

  // Put every non-content request at the busiest possible instant. Even this
  // conservative concentration plus a full rolling hour of paced writes is
  // well inside the 1,000-request primary limit.
  // The SwiftPM git push is a paced content write but not a REST request, so
  // subtract only REST-backed writes from the nominal core request count.
  assert.equal(budget.futureNonContentRequests, 132);
  assert.equal(budget.projectedRollingCoreRequests, 653);
  assert.ok(budget.projectedRollingCoreRequests < 900);
  assert.ok(500 - GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR >= 130);
  assert.equal(budget.totalPacingMs, GITHUB_CONTENT_WRITE_COLD_START_MS + (202 * 10_000));
  assert.ok((36 * GITHUB_CONTENT_WRITE_INTERVAL_MS) < (30 * 60_000), "draft staging fits its operation budget");
  assert.ok((19 * GITHUB_CONTENT_WRITE_INTERVAL_MS) < (20 * 60_000), "largest product pacing fits its count-derived upload budget");
  assert.ok((18 * GITHUB_CONTENT_WRITE_INTERVAL_MS) < (12 * 60_000), "draft promotion fits finalization timeout");
  assert.ok(
    budget.assetUploadPlan.productCount === 12
      && budget.assetUploadPlan.waves.length === 3
      && budget.assetUploadPlan.totalWindowMs === 82.5 * 60_000,
    "the exact asset topology uses three bounded five-lane shared-pacer waves",
  );
  const admitted = assertReleaseRequestWindow(budget, {
    finalizationReserveSeconds: RELEASE_FINALIZATION_RESERVE_SECONDS,
    hardDeadlineEpochSeconds: RELEASE_JOB_HARD_WINDOW_SECONDS,
    nowMs: 0,
  });
  const catalog = loadPublicationCatalog("github-content-write-pacer.test");
  const carrierCounts = Object.groupBy(catalog.carriers, ({ ecosystem }) => ecosystem);
  assert.equal(carrierCounts.cargo.length, 103);
  assert.equal(carrierCounts.npm.length, 59);
  assert.equal(carrierCounts.maven.length, 23);
  assert.equal(carrierCounts.jsr.length, 1);
  const independentLaneUpperBoundSeconds = Math.max(
    carrierCounts.cargo.length * REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
    carrierCounts.npm.length * NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER,
    NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS,
    carrierCounts.jsr.length * NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER,
  ) + NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS;
  assert.equal(independentLaneUpperBoundSeconds, 18_300);
  assert.equal(RELEASE_CURRENT_MAIN_REVALIDATION_TIMEOUT_SECONDS, 120);
  assert.equal(admitted.preRegistryOperationSeconds, 14_370);
  assert.equal(admitted.finalizationStepTimeoutSeconds, RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS);
  assert.equal(admitted.cleanupMarginSeconds, RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS);
  assert.equal(admitted.minimumFinalizationSeconds, RELEASE_MINIMUM_FINALIZATION_SECONDS);
  assert.equal(admitted.simulatedRegistryDeadlineEpochSeconds, 3_810);
  assert.ok(
    admitted.simulatedRegistryDeadlineEpochSeconds < independentLaneUpperBoundSeconds,
    "the staging simulation honestly exercises dependency-closed subset admission instead of pretending every npm carrier fits",
  );
  assert.ok(
    admitted.simulatedRegistryDeadlineEpochSeconds
      >= NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS + NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS,
    "the staging simulation still retains enough time for one intrinsic atomic registry operation",
  );
});

test("release-list admission scales at exact 100-row page boundaries", () => {
  assert.deepEqual(
    [0, 49, 99, 100, 149, 200].map((count) => releasePageUpperBound(count, 49)),
    [1, 1, 2, 2, 2, 3],
  );
});

test("admission rejects a job that cannot fit bounded pre-registry operations plus mandatory finalization", () => {
  const budget = contentWriteBudgetFromCounts({
    assetCount: 1,
    attestationWrites: 1,
    productCount: 1,
    rollingCoreRequestCount: 0,
    sourceTagWrites: 0,
  });
  const boundaryMs = budget.preRegistryOperationMs + (RELEASE_FINALIZATION_RESERVE_SECONDS * 1_000);
  assert.throws(
    () => assertReleaseRequestWindow(budget, {
      finalizationReserveSeconds: RELEASE_FINALIZATION_RESERVE_SECONDS,
      hardDeadlineEpochSeconds: 30_000,
      nowMs: 30_000_000 - boundaryMs,
    }),
    /cannot fit/u,
  );
  assert.doesNotThrow(() => assertReleaseRequestWindow(budget, {
    finalizationReserveSeconds: RELEASE_FINALIZATION_RESERVE_SECONDS,
    hardDeadlineEpochSeconds: 30_000,
    nowMs: 30_000_000 - boundaryMs - 1,
  }));
  const admitted = assertReleaseRequestWindow(budget, {
    finalizationReserveSeconds: RELEASE_FINALIZATION_RESERVE_SECONDS,
    hardDeadlineEpochSeconds: 30_000,
    nowMs: 10_000_000,
  });
  assert.equal(
    admitted.simulatedRegistryDeadlineEpochSeconds,
    Math.floor(
      (30_000_000 - budget.preRegistryOperationMs - (RELEASE_FINALIZATION_RESERVE_SECONDS * 1_000)) / 1_000,
    ),
  );
});

test("admission rejects under-provisioned finalization step, cleanup, and reserve envelopes", () => {
  const budget = contentWriteBudgetFromCounts({
    assetCount: 1,
    attestationWrites: 1,
    productCount: 1,
    rollingCoreRequestCount: 0,
    sourceTagWrites: 0,
  });
  const common = {
    finalizationReserveSeconds: RELEASE_FINALIZATION_RESERVE_SECONDS,
    hardDeadlineEpochSeconds: 30_000,
    nowMs: 0,
  };
  assert.throws(
    () => assertReleaseRequestWindow(budget, {
      ...common,
      minimumFinalizationSeconds: RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS,
    }),
    /bounded finalization steps.*cleanup margin/u,
  );
  assert.throws(
    () => assertReleaseRequestWindow(budget, {
      ...common,
      finalizationReserveSeconds: RELEASE_MINIMUM_FINALIZATION_SECONDS - 1,
    }),
    /reserve must be at least/u,
  );
});
