#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  BUILDER_JOBS,
  CI_JOB_TARGETS,
  nativeTargetSubsetForJobs,
  planJobsForAffected,
} from "../graph/ci_plan.mjs";
import {
  loadGraph,
  releaseProductProjectId,
} from "../release/release-graph.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { runMoon } from "./moon.mjs";

const TOOL = "check-moon-product-graph.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const GLOBAL_INPUTS = new Set([".moon/*.{yml,yaml,jsonc,json,pkl,hcl,toml}"]);
const IOS_CARRIER_VALIDATION_INPUTS = [
  "tools/release/portable-archive.mjs",
  "tools/release/validate-ios-carrier-zips.mjs",
];
const IOS_CARRIER_VALIDATION_TRIGGER = "release-tools:ios-carrier-validation-trigger";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function query(name) {
  let value;
  try {
    value = JSON.parse(runMoon(["query", name]));
  } catch (error) {
    fail(`moon query ${name} failed: ${error.message}`);
  }
  return object(value, `moon query ${name}`);
}

function sorted(values) {
  return [...values].sort();
}

function equalSets(left, right) {
  const actual = sorted(new Set(left));
  const expected = sorted(new Set(right));
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function taskCommand(task) {
  return [task.command, ...(task.args ?? [])].filter(Boolean).join(" ");
}

function taskInputs(task) {
  return (task.inputs ?? [])
    .map((input) => (typeof input === "string" ? input : input?.glob ?? input?.file))
    .filter((input) => typeof input === "string")
    .map((input) => input.replace(/^\//u, ""));
}

function taskInputGlobs(task) {
  return (task.inputs ?? [])
    .map((input) => (typeof input === "object" && input !== null ? input.glob : undefined))
    .filter((input) => typeof input === "string")
    .map((input) => input.replace(/^(!?)\//u, "$1"));
}

function assertIosCarrierValidationPlanning(tasks) {
  const trigger = tasks["release-tools"]?.["ios-carrier-validation-trigger"];
  assert(trigger !== undefined, `${IOS_CARRIER_VALIDATION_TRIGGER} must exist`);
  assert(taskCommand(trigger) === "true", `${IOS_CARRIER_VALIDATION_TRIGGER} must remain planner-only`);
  const releaseConfig = object(
    Bun.YAML.parse(readFileSync(path.join(ROOT, "tools/release/moon.yml"), "utf8")),
    "tools/release/moon.yml",
  );
  const rawTrigger = object(
    releaseConfig.tasks?.["ios-carrier-validation-trigger"],
    `${IOS_CARRIER_VALIDATION_TRIGGER} raw task`,
  );
  assert(
    equalSets(taskInputs(rawTrigger), IOS_CARRIER_VALIDATION_INPUTS),
    `${IOS_CARRIER_VALIDATION_TRIGGER} must own exactly the portable parser and producer validator`,
  );

  const directTasks = new Set([IOS_CARRIER_VALIDATION_TRIGGER]);
  const jobs = planJobsForAffected(new Set(), directTasks);
  assert(
    equalSets(jobs, ["affected", "extension-artifacts-native", "liboliphaunt-native-ios"]),
    `${IOS_CARRIER_VALIDATION_TRIGGER} must select only the two iOS carrier producers`,
  );
  assert(
    equalSets(nativeTargetSubsetForJobs(jobs, directTasks) ?? [], ["ios-xcframework"]),
    `${IOS_CARRIER_VALIDATION_TRIGGER} must focus both producer matrices on ios-xcframework`,
  );

  const mixedTasks = new Set([
    IOS_CARRIER_VALIDATION_TRIGGER,
    "liboliphaunt-native:release-runtime",
  ]);
  const mixedJobs = planJobsForAffected(new Set(), mixedTasks);
  for (const job of [
    "extension-artifacts-native",
    "liboliphaunt-native-android",
    "liboliphaunt-native-desktop",
    "liboliphaunt-native-ios",
    "liboliphaunt-native-release-assets",
  ]) {
    assert(mixedJobs.has(job), `mixed iOS validation/native-runtime impact must retain ${job}`);
  }
  assert(
    nativeTargetSubsetForJobs(mixedJobs, mixedTasks) === null,
    "full native-runtime impact must win over focused iOS carrier validation",
  );
}

function taskOutputs(task) {
  return (task.outputs ?? [])
    .map((output) => (typeof output === "string" ? output : output?.glob ?? output?.file))
    .filter((output) => typeof output === "string")
    .map((output) => output.replace(/^\//u, ""));
}

function dependencyTarget(dependency) {
  return typeof dependency === "string" ? dependency : dependency?.target;
}

function isAggregateTask(task) {
  return taskCommand(task) === "true" && (task.deps ?? []).length > 0;
}

function assertProjectMetadata(project) {
  const config = object(project.config, `${project.id}.config`);
  assert(config.id === project.id, `${project.id} config id must match its queried id`);
  assert(typeof project.source === "string" && project.source.length > 0, `${project.id} must own a source root`);
  assert(Array.isArray(config.tags) && config.tags.length > 0, `${project.id} must declare project tags`);
  if (config.project?.title !== undefined) {
    assert(typeof config.project.title === "string" && config.project.title.length > 0, `${project.id} title must be non-empty`);
  }
  if (config.project?.description !== undefined) {
    assert(typeof config.project.description === "string" && config.project.description.length > 0, `${project.id} description must be non-empty`);
  }
  if (config.owners?.defaultOwner !== undefined) {
    assert(typeof config.owners.defaultOwner === "string" && config.owners.defaultOwner.length > 0, `${project.id} default owner must be non-empty`);
  }
}

function assertTaskSemantics(projectId, taskId, task, allTargets) {
  const target = `${projectId}:${taskId}`;
  assert(task.target === target, `${target} returned inconsistent target ${task.target}`);
  assert(Array.isArray(task.tags) && task.tags.length > 0, `${target} must declare intent tags`);
  assert(new Set(task.tags).size === task.tags.length, `${target} must not repeat tags`);
  assert(task.options?.inferInputs === false, `${target} must use explicit inputs`);

  const inputs = taskInputs(task).filter((input) => !GLOBAL_INPUTS.has(input));
  assert(inputs.length > 0 || isAggregateTask(task), `${target} must declare owned inputs or be a dependency-only aggregate`);

  const outputs = taskOutputs(task);
  for (const output of outputs) {
    const generatedSource = output.startsWith("src/") && output.includes("/generated/");
    assert(
      output === "target" || output.startsWith("target/") || (generatedSource && task.options?.cache === false),
      `${target} output must live under target/, or be uncached generated source: ${output}`,
    );
  }
  if (task.tags.includes("artifact") && task.options?.cache !== false) {
    assert(outputs.length > 0, `${target} is an artifact producer and must declare outputs`);
  }
  if (task.tags.includes("measured") || task.tags.includes("device") || task.tags.includes("drill")) {
    assert(task.options?.cache === false, `${target} proves live state and must disable caching`);
  }

  if (taskId === "check") {
    assert(task.tags.includes("quality") && task.tags.includes("static"), `${target} must carry quality/static intent`);
  }
  if (taskId === "test") {
    assert(task.tags.includes("quality") && task.tags.includes("unit"), `${target} must carry quality/unit intent`);
  }

  const command = taskCommand(task);
  if (/(^|\s)[^\s]+[.]sh(?:\s|$)/u.test(command)) {
    assert(
      task.command === "bash" || String(task.command).endsWith(".sh"),
      `${target} shell payloads must run through bash or an executable shebang entrypoint`,
    );
  }
  if (/(^|\s)cargo(?:\s|$)/u.test(command)) {
    const cargoTarget = task.env?.CARGO_TARGET_DIR;
    assert(
      cargoTarget === `target/moon/${projectId}/${taskId}`,
      `${target} must isolate Cargo output at target/moon/${projectId}/${taskId}`,
    );
  }

  for (const dependency of task.deps ?? []) {
    const dependencyId = dependencyTarget(dependency);
    assert(typeof dependencyId === "string" && dependencyId.length > 0, `${target} has an invalid dependency`);
    assert(allTargets.has(dependencyId), `${target} depends on missing task ${dependencyId}`);
  }
}

function assertTaskGraphAcyclic(tasks) {
  const edges = new Map();
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      edges.set(`${projectId}:${taskId}`, (task.deps ?? []).map(dependencyTarget));
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (target) => {
    if (visited.has(target)) return;
    assert(!visiting.has(target), `Moon task graph contains a dependency cycle through ${target}`);
    visiting.add(target);
    for (const dependency of edges.get(target) ?? []) visit(dependency);
    visiting.delete(target);
    visited.add(target);
  };
  for (const target of edges.keys()) visit(target);
}

function trackedPackageRoots() {
  const result = captureCommandOutput(
    "git",
    ["ls-files", "-z", "package.json", "**/package.json"],
    {
      allowEmptyOutput: true,
      cwd: ROOT,
      label: "git ls-files package manifests",
      stdoutTerminator: "\0",
    },
  );
  assert(
    result.error === undefined && result.status === 0,
    `git ls-files package manifests failed: ${result.error?.message ?? result.stderr.trim()}`,
  );
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((manifest) => path.posix.dirname(manifest))
    .map((directory) => (directory === "." ? "" : `${directory}/`));
}

function assertInstalledDependenciesExcluded(tasks) {
  const packageRoots = trackedPackageRoots();
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      const globs = taskInputGlobs(task);
      const positive = globs.filter((glob) => !glob.startsWith("!")).map((glob) => new Bun.Glob(glob));
      const negative = globs.filter((glob) => glob.startsWith("!")).map((glob) => new Bun.Glob(glob.slice(1)));
      const captured = [];
      for (const packageRoot of packageRoots) {
        const nodeModules = `${packageRoot}node_modules`;
        const probes = [
          nodeModules,
          `${nodeModules}/__moon_dependency__`,
          `${nodeModules}/__moon_dependency__/package.json`,
        ];
        const isCaptured = probes.some(
          (probe) => positive.some((glob) => glob.match(probe)) && !negative.some((glob) => glob.match(probe)),
        );
        if (isCaptured) {
          captured.push(nodeModules);
        }
      }
      assert(
        captured.length === 0,
        `${projectId}:${taskId} input globs capture installed dependency trees: ${captured.join(", ")}; ` +
          "exclude node_modules and node_modules/** and invalidate from tracked manifests/lockfiles",
      );
    }
  }
}

function assertLiteralInputsAreFiles(tasks) {
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      for (const input of task.inputs ?? []) {
        if (typeof input !== "object" || input === null || typeof input.file !== "string") continue;
        const relative = input.file.replace(/^\//u, "");
        const absolute = path.join(ROOT, relative);
        assert(
          !relative.split("/").includes("node_modules"),
          `${projectId}:${taskId} declares installed dependency path ${relative} as a file input`,
        );
        assert(
          !existsSync(absolute) || statSync(absolute).isFile(),
          `${projectId}:${taskId} declares directory ${relative} as a file input; use a recursive glob`,
        );
      }
    }
  }
}

function ciTargetsFromTasks(tasks) {
  const jobs = new Map();
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      for (const tag of task.tags ?? []) {
        if (!tag.startsWith("ci-")) continue;
        const job = tag.slice(3);
        assert(job.length > 0, `${projectId}:${taskId} has an empty CI job tag`);
        if (!jobs.has(job)) jobs.set(job, new Set());
        jobs.get(job).add(`${projectId}:${taskId}`);
      }
    }
  }
  return Object.fromEntries(sorted(jobs.keys()).map((job) => [job, sorted(jobs.get(job))]));
}

function assertCiContract(tasks) {
  const actual = ciTargetsFromTasks(tasks);
  assert(
    JSON.stringify(actual) === JSON.stringify(CI_JOB_TARGETS),
    "CI planner targets must be derived exactly from Moon ci-* task tags",
  );
  const missingBuilders = [...BUILDER_JOBS].filter((job) => (actual[job] ?? []).length === 0).sort();
  assert(missingBuilders.length === 0, `builder jobs without an owning Moon target: ${missingBuilders.join(", ")}`);
}

function assertReleaseOwnership(projectsById, tasks) {
  const graph = loadGraph(TOOL);
  for (const [product, config] of Object.entries(graph.products)) {
    const projectId = releaseProductProjectId(product, graph.products, graph.moon_projects, TOOL);
    const project = projectsById.get(projectId);
    assert(project !== undefined, `release product ${product} maps to missing Moon project ${projectId}`);
    const productPath = config.path;
    const source = project.source;
    assert(
      source === "." || productPath === source || productPath.startsWith(`${source}/`),
      `release product ${product} path ${productPath} is outside owning project ${projectId}:${source}`,
    );

    if (config.kind === "sdk") {
      for (const taskId of ["check", "test", "package", "package-artifacts"]) {
        assert(tasks[projectId]?.[taskId] !== undefined, `SDK product ${product} requires ${projectId}:${taskId}`);
      }
      const packageDependencyTargets = new Set((tasks[projectId]["package-artifacts"].deps ?? []).map(dependencyTarget));
      assert(
        packageDependencyTargets.has(`${projectId}:package`),
        `${projectId}:package-artifacts must consume its package proof`,
      );
    }
  }
}

function assertWorkspaceDiscovery(projects) {
  const workspace = Bun.YAML.parse(readFileSync(path.join(ROOT, ".moon/workspace.yml"), "utf8"));
  object(workspace, ".moon/workspace.yml");
  const sources = new Set(projects.map((project) => project.source));
  assert(sources.size === projects.length, "Moon project source roots must be unique");
  assert(workspace.projects?.sources?.["ci-workflows"] === ".github", "Moon must model .github as the CI workflow project");
}

function assertRawTaskInputsUnique(projects) {
  for (const project of projects) {
    const configPath = path.join(
      ROOT,
      project.source === "." ? "moon.yml" : path.join(project.source, "moon.yml"),
    );
    const config = object(Bun.YAML.parse(readFileSync(configPath, "utf8")), configPath);
    for (const [taskId, task] of Object.entries(config.tasks ?? {})) {
      const seen = new Set();
      for (const input of task.inputs ?? []) {
        const identity = typeof input === "string" ? input : JSON.stringify(input);
        assert(
          !seen.has(identity),
          `${project.id}:${taskId} repeats Moon input ${identity}`,
        );
        seen.add(identity);
      }
    }
  }
}

function main() {
  assert(Bun.argv.length === 2, `usage: ${TOOL}`);
  const projectsResult = query("projects");
  const tasksResult = query("tasks");
  assert(Array.isArray(projectsResult.projects) && projectsResult.projects.length > 0, "Moon returned no projects");
  const tasks = object(tasksResult.tasks, "Moon tasks");
  const projectIds = projectsResult.projects.map((project) => project.id);
  assert(equalSets(projectIds, Object.keys(tasks)), "Moon project and task query project sets must match");
  assert(new Set(projectIds).size === projectIds.length, "Moon project ids must be unique");

  const projectsById = new Map(projectsResult.projects.map((project) => [project.id, project]));
  const allTargets = new Set();
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    object(projectTasks, `${projectId} tasks`);
    for (const taskId of Object.keys(projectTasks)) allTargets.add(`${projectId}:${taskId}`);
  }

  for (const project of projectsResult.projects) assertProjectMetadata(project);
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks)) {
      assertTaskSemantics(projectId, taskId, object(task, `${projectId}:${taskId}`), allTargets);
    }
  }
  assertTaskGraphAcyclic(tasks);
  assertLiteralInputsAreFiles(tasks);
  assertInstalledDependenciesExcluded(tasks);
  assertIosCarrierValidationPlanning(tasks);
  assertWorkspaceDiscovery(projectsResult.projects);
  assertRawTaskInputsUnique(projectsResult.projects);
  assertCiContract(tasks);
  assertReleaseOwnership(projectsById, tasks);
  console.log("Moon graph semantic checks passed");
}

try {
  main();
} catch (error) {
  console.error(error.message ?? String(error));
  process.exit(1);
}
