#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  loadGraph,
  releaseProductProjectId,
} from "../release/release-graph.mjs";
import { runMoon } from "./moon.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const TOOL = "check-test-strategy.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function moonTasks() {
  let result;
  try {
    result = JSON.parse(runMoon(["query", "tasks"]));
  } catch (error) {
    fail(`moon query tasks failed: ${error.message}`);
  }
  return object(result.tasks, "Moon tasks");
}

function command(task) {
  return [task.command, ...(task.args ?? [])].filter(Boolean).join(" ");
}

function dependencyTargets(task) {
  return new Set((task.deps ?? []).map((dependency) =>
    typeof dependency === "string" ? dependency : dependency?.target));
}

function inputPaths(task) {
  return (task.inputs ?? [])
    .map((input) => (typeof input === "string" ? input : input?.glob ?? input?.file))
    .filter((input) => typeof input === "string")
    .map((input) => input.replace(/^\//u, ""));
}

function outputPaths(task) {
  return (task.outputs ?? [])
    .map((output) => (typeof output === "string" ? output : output?.glob ?? output?.file))
    .filter((output) => typeof output === "string")
    .map((output) => output.replace(/^\//u, ""));
}

function requireTask(tasks, projectId, taskId, product) {
  const task = tasks[projectId]?.[taskId];
  assert(task !== undefined, `${product} requires Moon task ${projectId}:${taskId}`);
  return task;
}

function assertSdkTestLifecycle(tasks, graph, product, config) {
  const projectId = releaseProductProjectId(product, graph.products, graph.moon_projects, TOOL);
  const check = requireTask(tasks, projectId, "check", product);
  const test = requireTask(tasks, projectId, "test", product);
  const packageTask = requireTask(tasks, projectId, "package", product);
  const packageArtifacts = requireTask(tasks, projectId, "package-artifacts", product);

  const commands = [command(check), command(test), command(packageTask)];
  assert(new Set(commands).size === commands.length, `${product} check, test, and package lanes must execute distinct proofs`);
  assert(!commands[1].includes("--no-run"), `${product} test lane must execute tests, not only compile them`);
  assert(test.options?.cache === true, `${product} deterministic unit tests must be cacheable`);
  assert(test.tags?.includes("quality") && test.tags?.includes("unit"), `${product} tests must carry quality/unit intent`);

  const projectSource = graph.moon_projects[projectId]?.source;
  assert(
    inputPaths(test).some((input) => input === projectSource || input.startsWith(`${projectSource}/`)),
    `${product} test inputs must include its owning source tree`,
  );

  const packageDeps = dependencyTargets(packageTask);
  assert(packageDeps.has(`${projectId}:check`), `${product} package proof must depend on static checks`);
  assert(packageDeps.has(`${projectId}:test`), `${product} package proof must depend on unit tests`);
  assert(
    dependencyTargets(packageArtifacts).has(`${projectId}:package`),
    `${product} package artifact staging must consume the package proof`,
  );
  assert(
    outputPaths(packageArtifacts).some((output) => output.startsWith(`target/sdk-artifacts/${projectId}/`)),
    `${product} package artifact staging must declare its SDK artifact envelope`,
  );

  const smoke = tasks[projectId]?.smoke;
  if (smoke !== undefined) {
    assert(command(smoke) !== command(test), `${product} smoke must be distinct from unit tests`);
    assert(["local", false].includes(smoke.options?.cache), `${product} runtime smoke must be local-only or uncached`);
  }
  const regression = tasks[projectId]?.regression;
  if (regression !== undefined) {
    assert(command(regression) !== command(test), `${product} regression must be distinct from unit tests`);
  }

  const coverage = tasks[projectId]?.coverage;
  if (coverage !== undefined) {
    assert(coverage.options?.cache === true, `${product} deterministic coverage collection must be cacheable`);
    assert(coverage.tags?.includes("coverage") && coverage.tags?.includes("quality"), `${product} coverage must carry coverage/quality intent`);
    assert(
      outputPaths(coverage).some((output) => output.startsWith(`target/coverage/${projectId}/`)),
      `${product} coverage must declare a target/coverage output`,
    );
  }

  assert(typeof config.owner === "string" && config.owner.length > 0, `${product} must declare its test/release owner`);
}

function assertNoPretendTests(tasks) {
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      if (taskId !== "test") continue;
      const value = command(task);
      assert(value !== "true", `${projectId}:test must not be a no-op aggregate`);
      assert(!value.includes("--no-run"), `${projectId}:test must execute tests`);
    }
  }
}

function assertJavaScriptTestContracts() {
  for (const packagePath of ["src/sdks/js/package.json", "src/sdks/react-native/package.json"]) {
    const pkg = object(JSON.parse(readFileSync(path.join(ROOT, packagePath), "utf8")), packagePath);
    const test = pkg.scripts?.test;
    assert(typeof test === "string" && test.includes("tools/test/run-js-tests.mjs"), `${packagePath} tests must use the shared Vitest runner`);
    assert(!test.includes("--no-run"), `${packagePath} test script must execute discovered tests`);
  }

  const nativeSpec = readFileSync(path.join(ROOT, "src/sdks/react-native/src/specs/NativeOliphaunt.ts"), "utf8");
  assert(!/base64/iu.test(nativeSpec), "React Native binary transport must not regress to base64 across the TurboModule boundary");
}

function assertSharedFixtureContracts() {
  const result = captureCommandOutput(
    "bun",
    ["src/shared/contracts/tools/check-test-matrix.mjs", "--fixtures"],
    { cwd: ROOT, label: "shared fixture contract" },
  );
  if (result.status !== 0 || result.error !== undefined) {
    const output = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").trim();
    fail(`shared fixture contract failed:\n${output}`);
  }
}

function main() {
  assert(Bun.argv.length === 2, `usage: ${TOOL}`);
  const tasks = moonTasks();
  const graph = loadGraph(TOOL);
  const sdkProducts = Object.entries(graph.products)
    .filter(([, config]) => config.kind === "sdk")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  assert(sdkProducts.length > 0, "release graph contains no SDK products");

  assertNoPretendTests(tasks);
  for (const [product, config] of sdkProducts) {
    assertSdkTestLifecycle(tasks, graph, product, config);
  }
  assertJavaScriptTestContracts();
  assertSharedFixtureContracts();
  console.log("SDK and shared test strategy semantic checks passed");
}

try {
  main();
} catch (error) {
  console.error(error.message ?? String(error));
  process.exit(1);
}
