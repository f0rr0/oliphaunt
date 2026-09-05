#!/usr/bin/env bun

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";
import { CI_JOB_TARGETS } from "../graph/ci_plan.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const workflow = Bun.YAML.parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
const graphResult = captureCommandOutput(moonCommand(), ["task-graph", "--json"], {
  cwd: ROOT,
  env: moonEnvironment(),
  label: "Moon task graph",
});
assert.equal(graphResult.status, 0, graphResult.stderr);
const tasks = new Map(
  Object.values(JSON.parse(graphResult.stdout).data).map((task) => [task.target, task]),
);

function dependencies(target) {
  const task = tasks.get(target);
  assert.ok(task, `workflow root ${target} must exist in Moon`);
  return (task.deps ?? []).map((dependency) =>
    typeof dependency === "string" ? dependency : dependency.target);
}

test("downloaded Moon dependencies are explicit direct handoffs", () => {
  let handoffs = 0;
  for (const [workflowJob, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      const run = String(step.run ?? "");
      assert.doesNotMatch(run, /OLIPHAUNT_MOON_UPSTREAM=none|run-moon-targets[.]sh --upstream none/u);

      const rawTransfers = step.env?.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON;
      if (rawTransfers === undefined) continue;
      handoffs += 1;
      const plannedJob = run.match(/run-planned-moon-job[.]sh ([a-z0-9-]+)/u)?.[1];
      assert.ok(plannedJob, `${workflowJob} transferred handoff must use the planned-job runner`);
      const transfers = JSON.parse(rawTransfers);
      assert.ok(Array.isArray(transfers) && transfers.length > 0);

      let roots = CI_JOB_TARGETS[plannedJob];
      const inlinePlan = step.env?.OLIPHAUNT_CI_JOB_TARGETS_JSON;
      if (typeof inlinePlan === "string" && inlinePlan.startsWith("{")) {
        roots = JSON.parse(inlinePlan)[plannedJob];
      }
      assert.ok(Array.isArray(roots) && roots.length > 0, `${plannedJob} must resolve Moon roots`);
      const direct = new Set(roots.flatMap(dependencies));
      for (const transfer of transfers) {
        assert.ok(direct.has(transfer), `${workflowJob} transfers non-direct dependency ${transfer}`);
      }
      for (const dependency of direct) {
        if (!transfers.includes(dependency)) {
          assert.notEqual(
            tasks.get(dependency)?.options?.internal,
            true,
            `${workflowJob} cannot directly run internal dependency ${dependency}`,
          );
        }
      }

      assert.ok(
        steps.slice(0, index).some(({ uses }) => String(uses ?? "").startsWith("actions/download-artifact@")),
        `${workflowJob} declares transferred dependencies without downloading artifacts`,
      );
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      assert.ok(needs.some((need) => need && need !== "affected"), `${workflowJob} has no producer job`);
    }
  }
  assert.ok(handoffs > 0, "CI must exercise at least one cross-runner Moon handoff");
});

test("mobile artifact downloads materialize under the ABI finalizer inputs", () => {
  const cases = [
    {
      artifact: "liboliphaunt-native-target-android-arm64-v8a",
      job: "liboliphaunt-native-android-abi",
      path: "target/liboliphaunt-native-ci/android-arm64-v8a",
      target: "liboliphaunt-native:finalize-runtime-android-abi",
    },
    {
      artifact: "liboliphaunt-native-target-android-x86_64",
      job: "liboliphaunt-native-android-abi",
      path: "target/liboliphaunt-native-ci/android-x86_64",
      target: "liboliphaunt-native:finalize-runtime-android-abi",
    },
    {
      artifact: "liboliphaunt-native-target-ios-xcframework",
      job: "liboliphaunt-native-ios-abi",
      path: "target/liboliphaunt-native-ci/ios-xcframework",
      target: "liboliphaunt-native:finalize-runtime-ios-abi",
    },
    {
      artifact: "liboliphaunt-native-release-assets-android-x86_64",
      job: "liboliphaunt-native-android-abi",
      path: "target/liboliphaunt/mobile-release-assets/android-x86_64",
      target: "liboliphaunt-native:finalize-runtime-android-abi",
    },
    {
      artifact: "liboliphaunt-native-release-assets-ios-xcframework",
      job: "liboliphaunt-native-ios-abi",
      path: "target/liboliphaunt/mobile-release-assets/ios-xcframework",
      target: "liboliphaunt-native:finalize-runtime-ios-abi",
    },
  ];
  const scratch = mkdtempSync(path.join(tmpdir(), "oliphaunt-handoff-"));
  try {
    for (const entry of cases) {
      const step = workflow.jobs[entry.job].steps.find(({ with: options }) => options?.name === entry.artifact);
      assert.equal(step?.with?.path, entry.path);
      const inputs = tasks.get(entry.target)?.inputs ?? [];
      assert.ok(inputs.some((input) =>
        Object.values(input).some((value) => String(value).includes(entry.path.replace(/\/[^/]+$/u, "/")))));

      const uploaded = path.join(scratch, "uploaded");
      const downloaded = path.join(scratch, entry.path);
      rmSync(uploaded, { recursive: true, force: true });
      mkdirSync(uploaded, { recursive: true });
      writeFileSync(path.join(uploaded, "abi-receipt.json"), "{}\n");
      mkdirSync(downloaded, { recursive: true });
      cpSync(uploaded, downloaded, { recursive: true });
      assert.ok(existsSync(path.join(downloaded, "abi-receipt.json")));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
