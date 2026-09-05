#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
