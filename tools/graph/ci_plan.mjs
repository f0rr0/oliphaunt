#!/usr/bin/env bun
// Map Moon affected tasks onto stable GitHub Actions jobs.
//
// Moon is the only project/task graph. Stable GitHub job names are selected
// from Moon task tags named `ci-<job-id>`. GitHub Actions still owns platform
// matrix fan-out because runner OS, native target triples, and simulator/device
// targets are CI execution details, not source projects.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";

import {
  brokerRuntimeMatrix,
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
  liboliphauntNativeAndroidRuntimeMatrix,
  liboliphauntNativeDesktopRuntimeMatrix,
  liboliphauntNativeIosRuntimeMatrix,
  liboliphauntNativeRuntimeTargetsForSurface,
  liboliphauntWasixAotRuntimeMatrix,
  liboliphauntWasixPostmasterRuntimeMatrix,
  nodeDirectRuntimeMatrix,
  reactNativeAndroidMobileAppMatrix,
  wasixNapiRuntimeMatrix,
} from "../release/artifact_target_matrix.mjs";
import {
  compareText,
  exactExtensionProducts,
  extensionPublicDependencySqlNames,
  extensionSqlNames,
} from "../release/release-artifact-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "ci_plan.mjs";

export const BASE_JOBS = new Set(["affected"]);
export const ALWAYS_JOBS = new Set(BASE_JOBS);
export const FULL_PAYLOAD_QUALIFICATION_MODE = "full-payload";
const NATIVE_RUNTIME_JOBS = new Set([
  "liboliphaunt-native-android",
  "liboliphaunt-native-desktop",
  "liboliphaunt-native-ios",
]);
const NATIVE_RUNTIME_TASKS = new Set([
  "liboliphaunt-native:release-runtime",
  "liboliphaunt-native:release-runtime-android-target",
  "liboliphaunt-native:release-runtime-ios-target",
]);
export const WASM_RUNTIME_JOBS = new Set([
  "liboliphaunt-wasix-runtime",
  "liboliphaunt-wasix-aot",
  "liboliphaunt-wasix-release-assets",
]);
const MOBILE_JOB_SURFACES = {
  "mobile-build-android": "react-native-android",
  "mobile-build-ios": "react-native-ios",
};
const MOBILE_E2E_JOBS = {
  "mobile-build-android": "mobile-e2e-android",
  "mobile-build-ios": "mobile-e2e-ios",
};
const REACT_NATIVE_ANDROID_REPRESENTATIVE_TARGETS = new Set(["android-x86_64"]);
export const NATIVE_EXTENSION_LIFECYCLE_JOB = "native-extension-lifecycle";
export const NATIVE_EXTENSION_LIFECYCLE_AGGREGATE_JOB =
  "native-extension-lifecycle-aggregate";
export const NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT = 3;
export const BROAD_EXTENSION_INPUT_PROJECTS = new Set([
  "extension-artifacts-native",
  "extension-artifacts-wasix",
  "oliphaunt-extension-contrib-pg18",
  "extension-packages",
  "liboliphaunt-native",
  "liboliphaunt-wasix",
  "postgres18",
  "third-party-native",
  "third-party-shared",
]);
function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function commandJson(command, args, options = {}) {
  const result = captureCommandOutput(command, args, {
    cwd: ROOT,
    env: process.env,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    fail(`${command} failed: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

function moon(args) {
  return commandJson(moonCommand(), args, { env: moonEnvironment() });
}

function affectedProjectsAndTasks() {
  const summary = commandJson(process.execPath, ["tools/graph/affected.mjs", "summary"]);
  return {
    directProjects: new Set(stringList(summary.directProjects ?? [])),
    projects: new Set(stringList(summary.projects ?? [])),
    directTasks: new Set(stringList(summary.tasks ?? [])),
  };
}

function stringList(value) {
  if (!Array.isArray(value)) {
    fail("expected a JSON string list");
  }
  return value.map((item) => String(item)).sort(compareText);
}

function setUnion(...sets) {
  const result = new Set();
  for (const set of sets) {
    for (const item of set) {
      result.add(item);
    }
  }
  return result;
}

function intersects(left, right) {
  for (const item of left) {
    if (right.has(item)) {
      return true;
    }
  }
  return false;
}

function sorted(set) {
  return [...set].sort(compareText);
}

function names(value) {
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    return Object.keys(value).sort(compareText);
  }
  if (Array.isArray(value)) {
    const result = new Set();
    for (const item of value) {
      if (typeof item === "string") {
        result.add(item);
      } else if (item !== null && typeof item === "object") {
        const identifier = item.id ?? item.target;
        if (identifier !== undefined && identifier !== null && identifier !== "") {
          result.add(String(identifier));
        }
      }
    }
    return sorted(result);
  }
  return [];
}

const TASKS_BY_TARGET = (() => {
  const graph = moon(["task-graph", "--json"]);
  if (graph.data === null || Array.isArray(graph.data) || typeof graph.data !== "object") {
    fail("moon task-graph did not return task data");
  }
  return new Map(Object.values(graph.data).map((task) => [task.target, task]));
})();

export function moonCiJobTargets() {
  const jobs = new Map();
  for (const task of TASKS_BY_TARGET.values()) {
    for (const tag of task.tags ?? []) {
      if (typeof tag === "string" && tag.startsWith("ci-")) {
        const job = tag.slice("ci-".length);
        if (!jobs.has(job)) {
          jobs.set(job, new Set());
        }
        jobs.get(job).add(task.target);
      }
    }
  }
  return Object.fromEntries(
    [...jobs.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([job, targets]) => [job, sorted(targets)]),
  );
}

export const CI_JOB_TARGETS = moonCiJobTargets();
export const BUILDER_JOBS = new Set(
  Object.keys(CI_JOB_TARGETS).filter((job) => job !== NATIVE_EXTENSION_LIFECYCLE_JOB),
);
const JOBS_BY_TARGET = (() => {
  const jobs = new Map();
  for (const [job, targets] of Object.entries(CI_JOB_TARGETS)) {
    for (const target of targets) jobs.set(target, [...(jobs.get(target) ?? []), job]);
  }
  return jobs;
})();
const DEPENDENTS_BY_TARGET = (() => {
  const dependents = new Map();
  for (const task of TASKS_BY_TARGET.values()) {
    for (const dependency of task.deps ?? []) {
      const target = typeof dependency === "string" ? dependency : dependency.target;
      if (typeof target === "string") {
        dependents.set(target, [...(dependents.get(target) ?? []), task.target]);
      }
    }
  }
  return dependents;
})();
export const ALL_BUILDER_JOBS = new Set(Object.keys(CI_JOB_TARGETS));
export const CI_JOBS_CONFIG = {
  always_jobs: sorted(ALWAYS_JOBS),
  ci_job_targets: CI_JOB_TARGETS,
  wasm_runtime_jobs: sorted(WASM_RUNTIME_JOBS),
};

export function jobTargetsForJobs(jobs) {
  return Object.fromEntries(
    sorted(jobs)
      .filter((job) => CI_JOB_TARGETS[job] !== undefined)
      .map((job) => [job, CI_JOB_TARGETS[job]]),
  );
}

function emptyMatrix() {
  return { include: [] };
}

export function jobsForTargets(targets, { allowedJobs = undefined } = {}) {
  const jobs = new Set();
  for (const [job, jobTargets] of Object.entries(CI_JOB_TARGETS)) {
    if (allowedJobs !== undefined && !allowedJobs.has(job)) {
      continue;
    }
    if (intersects(targets, new Set(jobTargets))) {
      jobs.add(job);
    }
  }
  return jobs;
}

function taskDependencyTargets(task) {
  return (task?.deps ?? [])
    .map((dependency) => typeof dependency === "string" ? dependency : dependency.target)
    .filter((target) => typeof target === "string");
}

function downstreamTaskClosure(tasks) {
  const closure = new Set(tasks);
  const pending = [...closure];
  while (pending.length > 0) {
    for (const dependent of DEPENDENTS_BY_TARGET.get(pending.pop()) ?? []) {
      if (!closure.has(dependent)) {
        closure.add(dependent);
        pending.push(dependent);
      }
    }
  }
  return closure;
}

export function addRequiredJobs(jobs) {
  const pendingJobs = [...jobs];
  const visitedTasks = new Set();
  while (pendingJobs.length > 0) {
    const job = pendingJobs.pop();
    const pendingTasks = [...(CI_JOB_TARGETS[job] ?? [])];
    while (pendingTasks.length > 0) {
      const target = pendingTasks.pop();
      if (visitedTasks.has(target)) continue;
      visitedTasks.add(target);
      const task = TASKS_BY_TARGET.get(target);
      if (!task) fail(`CI job ${job} references missing Moon target ${target}`);
      for (const dependency of taskDependencyTargets(task)) {
        pendingTasks.push(dependency);
        for (const dependencyJob of JOBS_BY_TARGET.get(dependency) ?? []) {
          if (!jobs.has(dependencyJob)) {
            jobs.add(dependencyJob);
            pendingJobs.push(dependencyJob);
          }
        }
      }
    }
  }
  return jobs;
}

export function planJobsForAffected(tasks) {
  const jobs = new Set(ALWAYS_JOBS);
  const directlySelectedJobs = jobsForTargets(
    downstreamTaskClosure(tasks),
    { allowedJobs: ALL_BUILDER_JOBS },
  );
  for (const job of directlySelectedJobs) {
    jobs.add(job);
  }
  return addRequiredJobs(jobs);
}

export function nativeTargetSubsetForJobs(jobs, tasks) {
  if (!intersects(jobs, NATIVE_RUNTIME_JOBS)) {
    return null;
  }
  if (jobs.has("liboliphaunt-native-release-assets")) {
    return null;
  }
  if (intersects(tasks, NATIVE_RUNTIME_TASKS)) {
    return null;
  }

  const targets = mobileNativeTargetsForJobs(jobs);
  if (
    jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)
  ) {
    targets.add("linux-x64-gnu");
  }
  if (jobs.has("swift-sdk-package")) {
    targets.add("ios-xcframework");
  }
  if (jobs.has("kotlin-sdk-package")) {
    for (const target of liboliphauntNativeRuntimeTargetsForSurface("maven")) {
      targets.add(target);
    }
  }
  return targets.size > 0 ? targets : null;
}

export function mobileNativeTargetsForJobs(jobs) {
  const targets = new Set();
  for (const [job, surface] of Object.entries(MOBILE_JOB_SURFACES)) {
    if (jobs.has(job)) {
      for (const target of liboliphauntNativeRuntimeTargetsForSurface(surface)) {
        targets.add(target);
      }
    }
  }
  return targets;
}

export function mobileExtensionPackageNativeTargets(jobs, selectedTargets) {
  if (!jobs.has("mobile-extension-packages")) {
    return [];
  }
  if (selectedTargets !== null && selectedTargets !== undefined) {
    return sorted(selectedTargets);
  }
  return sorted(mobileNativeTargetsForJobs(jobs));
}

export function mobileE2eJobsForPlan(jobs) {
  const selected = Object.entries(MOBILE_E2E_JOBS)
    .filter(([builder]) => jobs.has(builder))
    .map(([, e2e]) => e2e)
  if (jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)) {
    selected.push(NATIVE_EXTENSION_LIFECYCLE_AGGREGATE_JOB);
  }
  return selected.sort(compareText);
}

export function liboliphauntNativeIosRuntimeMatrixForPlan(
  jobs,
  selectedTargets,
  nativeTarget = process.env.NATIVE_TARGET || "all",
) {
  if (!jobs.has("liboliphaunt-native-ios")) return emptyMatrix();
  if (jobs.has("react-native-sdk-package")) {
    return liboliphauntNativeIosRuntimeMatrix("all", new Set(["ios-xcframework"]));
  }
  return liboliphauntNativeIosRuntimeMatrix(nativeTarget, selectedTargets ?? undefined);
}

export function liboliphauntNativeDesktopRuntimeMatrixForPlan(
  jobs,
  selectedTargets,
  nativeTarget = process.env.NATIVE_TARGET || "all",
) {
  if (!jobs.has("liboliphaunt-native-desktop")) return emptyMatrix();
  return liboliphauntNativeDesktopRuntimeMatrix(nativeTarget, selectedTargets ?? undefined);
}

function focusedMobileNativeTargets(mobileTarget, nativeTarget, focusedMobileJobs) {
  const targets = mobileNativeTargetsForJobs(focusedMobileJobs);
  if (nativeTarget !== "all") {
    if (mobileTarget === "both") {
      throw new Error("focused mobile_target=both requires native_target=all");
    }
    if (!targets.has(nativeTarget)) {
      throw new Error(
        `native_target=${nativeTarget} is not valid for mobile_target=${mobileTarget}; expected one of: all, ${sorted(targets).join(", ")}`,
      );
    }
  }
  // Mobile qualification admits one physical compatibility domain. A focused
  // target may select that domain, but must not silently omit one of its ABI
  // receipts or the representative emulator app that consumes the closure.
  return targets;
}

export function planForPullRequest() {
  const base = process.env.MOON_BASE;
  const head = process.env.MOON_HEAD;
  if (!base || !head) {
    throw new Error("MOON_BASE and MOON_HEAD are required for pull_request CI planning");
  }

  const { directProjects, projects, directTasks } = affectedProjectsAndTasks();
  const jobs = planJobsForAffected(directTasks);
  const selectedNativeTargets = nativeTargetSubsetForJobs(jobs, directTasks);
  const reason =
    `direct affected projects: ${sorted(directProjects).join(", ") || "(none)"}; ` +
    `downstream affected projects: ${sorted(projects).join(", ") || "(none)"}; ` +
    `direct affected tasks: ${sorted(directTasks).join(", ") || "(none)"}`;
  return {
    jobs,
    directProjects,
    projects,
    tasks: directTasks,
    reason,
    selectedTargets: selectedNativeTargets,
  };
}

export function selectedExtensionProductsForPlan(directProjects, tasks, jobs) {
  const extensionJobs = new Set([
    "extension-artifacts-native",
    "extension-artifacts-wasix",
    "extension-packages",
    NATIVE_EXTENSION_LIFECYCLE_JOB,
    ...Object.keys(MOBILE_JOB_SURFACES),
  ]);
  if (!intersects(jobs, extensionJobs)) {
    return null;
  }

  const exactProducts = new Set(exactExtensionProducts());
  if (intersects(jobs, new Set(Object.keys(MOBILE_JOB_SURFACES)))) {
    return exactProducts;
  }
  const selected = new Set([...directProjects].filter((project) => exactProducts.has(project)));
  for (const target of tasks) {
    const project = target.split(":", 1)[0];
    if (exactProducts.has(project)) {
      selected.add(project);
    }
  }
  if (intersects(directProjects, BROAD_EXTENSION_INPUT_PROJECTS)) {
    return exactProducts;
  }
  if (tasks.has("extension-packages:package") && selected.size === 0) {
    return exactProducts;
  }
  if (jobs.has("extension-packages") && selected.size === 0) {
    return exactProducts;
  }
  if (intersects(jobs, new Set(["extension-artifacts-native", "extension-artifacts-wasix"])) && selected.size === 0) {
    return exactProducts;
  }
  if (tasks.has("extension-packages:package-mobile") && selected.size === 0) {
    return exactProducts;
  }
  return selected.size > 0 ? selected : null;
}

export function extensionProductDependencyClosure(products) {
  const exactProducts = new Set(exactExtensionProducts());
  const productBySqlName = new Map(
    [...exactProducts].flatMap((product) => extensionSqlNames(product, PREFIX).map((sqlName) => [sqlName, product])),
  );
  const closure = new Set();
  const pending = [...products];
  while (pending.length > 0) {
    const product = pending.pop();
    if (!exactProducts.has(product)) throw new Error(`unknown exact extension product ${product}`);
    if (closure.has(product)) continue;
    closure.add(product);
    for (const sqlName of extensionSqlNames(product, PREFIX)) {
      for (const dependencySqlName of extensionPublicDependencySqlNames(sqlName, PREFIX)) {
        const dependencyProduct = productBySqlName.get(dependencySqlName);
        if (!dependencyProduct) {
          throw new Error(`${sqlName} has unknown public extension dependency ${dependencySqlName}`);
        }
        pending.push(dependencyProduct);
      }
    }
  }
  return closure;
}

export function planForFullRun({
  wasmTarget = "all",
  nativeTarget = "all",
  mobileTarget = "all",
} = {}) {
  if (wasmTarget !== "all" && (nativeTarget !== "all" || mobileTarget !== "all")) {
    throw new Error(
      "wasm_target focus cannot be combined with native_target or mobile_target focus; run the WASIX and native/mobile diagnostics separately",
    );
  }
  if (mobileTarget !== "all") {
    const mobileJobsByTarget = {
      android: new Set(["mobile-build-android"]),
      ios: new Set(["mobile-build-ios"]),
      both: new Set(["mobile-build-android", "mobile-build-ios"]),
    };
    const focusedMobileJobs = mobileJobsByTarget[mobileTarget];
    if (focusedMobileJobs === undefined) {
      throw new Error(`unknown mobile target ${mobileTarget}; expected one of: all, android, ios, both`);
    }
    const focusedJobs = setUnion(BASE_JOBS, focusedMobileJobs);
    addRequiredJobs(focusedJobs);
    const focusedNativeTargets = focusedMobileNativeTargets(mobileTarget, nativeTarget, focusedMobileJobs);
    return {
      jobs: focusedJobs,
      projects: new Set(["liboliphaunt-native", "oliphaunt-react-native"]),
      tasks: targetsForJobs(focusedMobileJobs),
      reason: `manual focused mobile CI run for ${mobileTarget}`,
      selectedTargets: focusedNativeTargets,
    };
  }

  if (nativeTarget !== "all") {
    let focusedJobs;
    let focusedProjects;
    if (nativeTarget.startsWith("android-") || nativeTarget === "ios-xcframework") {
      focusedJobs = setUnion(
        BASE_JOBS,
        new Set([nativeTarget.startsWith("android-") ? "liboliphaunt-native-android" : "liboliphaunt-native-ios"]),
      );
      focusedProjects = new Set(["liboliphaunt-native"]);
    } else {
      focusedJobs = setUnion(BASE_JOBS, new Set([
        "liboliphaunt-native-desktop",
      ]));
      focusedProjects = new Set(["liboliphaunt-native"]);
      if (nativeTarget === "linux-x64-gnu") {
        focusedJobs.add(NATIVE_EXTENSION_LIFECYCLE_JOB);
      }
    }
    addRequiredJobs(focusedJobs);
    return {
      jobs: focusedJobs,
      projects: focusedProjects,
      tasks: targetsForJobs(focusedJobs),
      reason: `manual focused native runtime CI run for ${nativeTarget}`,
      selectedTargets: focusedJobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)
        ? new Set(["linux-x64-gnu"])
        : null,
    };
  }

  if (wasmTarget !== "all") {
    const focusedJobs = setUnion(BASE_JOBS, new Set(["liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"]));
    if (wasmTarget === "linux-x64-gnu") {
      // The workflow selects release regression for the Linux host target.
      focusedJobs.add("extension-artifacts-wasix");
    }
    return {
      jobs: focusedJobs,
      projects: new Set(["liboliphaunt-wasix"]),
      tasks: targetsForJobs(focusedJobs),
      reason: `manual focused WASIX runtime CI run for ${wasmTarget}`,
      selectedTargets: null,
    };
  }

  const jobs = setUnion(
    BASE_JOBS,
    BUILDER_JOBS,
    WASM_RUNTIME_JOBS,
    new Set([NATIVE_EXTENSION_LIFECYCLE_JOB]),
  );
  addRequiredJobs(jobs);
  return {
    jobs,
    projects: new Set(),
    tasks: targetsForJobs(jobs),
    reason: "non-PR full CI/runtime run",
    selectedTargets: null,
  };
}

function targetsForJobs(jobs) {
  const targets = new Set();
  for (const job of jobs) {
    for (const target of CI_JOB_TARGETS[job] ?? []) {
      targets.add(target);
    }
  }
  return targets;
}

function renderPlan(
  {
    jobs,
    projects,
    tasks,
    reason,
    selectedTargets,
  },
  {
    nativeTarget = process.env.NATIVE_TARGET || "all",
    wasmTarget = process.env.WASM_TARGET || "all",
  } = {},
) {
  const selectedExtensionProducts = selectedExtensionProductsForPlan(new Set(), tasks, jobs);
  return renderPlanWithSelection({
    jobs,
    projects,
    tasks,
    reason,
    selectedTargets,
    selectedExtensionProducts,
    nativeTarget,
    wasmTarget,
  });
}

export function renderPlanForFullRun({
  wasmTarget = "all",
  nativeTarget = "all",
  mobileTarget = "all",
} = {}) {
  return renderPlan(
    planForFullRun({ wasmTarget, nativeTarget, mobileTarget }),
    { nativeTarget: mobileTarget === "all" ? nativeTarget : "all", wasmTarget },
  );
}

export function extensionArtifactsWasixMatrixForPlan(jobs, selectedExtensionProducts) {
  // Release regression exercises every public extension. Its portable
  // carrier producer must therefore be complete even when the release/package
  // selection is intentionally narrowed to one independently versioned
  // extension. Non-regression callers retain that focused selection.
  const products = jobs.has("liboliphaunt-wasix-runtime")
    ? undefined
    : selectedExtensionProducts ?? undefined;
  return extensionArtifactsWasixMatrix("all", products);
}

export function extensionArtifactsNativeMatrixForPlan(
  jobs,
  selectedTargets,
  selectedExtensionProducts,
  nativeTarget = process.env.NATIVE_TARGET || "all",
) {
  const matrix = extensionArtifactsNativeMatrix(
    nativeTarget,
    jobs.has("extension-packages") ? undefined : selectedTargets ?? undefined,
    selectedExtensionProducts ?? undefined,
  );
  if (!jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)) {
    return matrix;
  }

  const exactProducts = new Set(exactExtensionProducts());
  const requiredTargets = new Set(["linux-x64-gnu"]);
  const proofProducts = extensionProductDependencyClosure(selectedExtensionProducts ?? exactProducts);
  const proofRows = extensionArtifactsNativeMatrix(
    "all",
    requiredTargets,
    proofProducts,
  ).include;
  if (proofRows.length !== requiredTargets.size) {
    throw new Error("native extension lifecycle does not have a complete Linux producer row");
  }
  const include = matrix.include.filter((row) => !requiredTargets.has(row.target));
  include.push(...proofRows);
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function extensionSqlNamesForProducts(products) {
  const rows = [...products].flatMap((product) => extensionSqlNames(product, PREFIX).map((sqlName) => ({ product, sqlName })));
  const productsBySqlName = new Map();
  for (const { product, sqlName } of rows) {
    const existing = productsBySqlName.get(sqlName);
    if (existing !== undefined) {
      throw new Error(
        `exact extension products ${existing} and ${product} share SQL name ${sqlName}`,
      );
    }
    productsBySqlName.set(sqlName, product);
  }
  return rows.map(({ sqlName }) => sqlName).sort(compareText);
}

export function nativeExtensionLifecycleShardPlan(products) {
  const selected = new Set(products);
  if (selected.size === 0) return { matrix: emptyMatrix(), shardCount: 0 };
  const exact = new Set(exactExtensionProducts());
  const exhaustive = selected.size === exact.size && [...selected].every((product) => exact.has(product));
  const shardCount = exhaustive ? NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT : 1;
  const sqlNames = extensionSqlNamesForProducts(selected);
  return {
    matrix: {
      include: Array.from({ length: shardCount }, (_, shard) => {
        const names = sqlNames.filter((_, index) => index % shardCount === shard);
        const shown = names.slice(0, 4).join(", ");
        return {
          shard,
          shard_count: shardCount,
          label: `${names.length} Extensions (${shown}${names.length > 4 ? ` + ${names.length - 4} More` : ""})`,
        };
      }),
    },
    shardCount,
  };
}

export function renderPlanWithSelection({
  jobs,
  projects,
  tasks,
  reason,
  selectedTargets,
  selectedExtensionProducts,
  nativeTarget = process.env.NATIVE_TARGET || "all",
  wasmTarget = process.env.WASM_TARGET || "all",
}) {
  const extensionProducts = sorted(selectedExtensionProducts ?? new Set());
  const extensionSqlNames = extensionSqlNamesForProducts(extensionProducts);
  const nativeLifecycleProducts = jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)
    ? extensionProductDependencyClosure(
        selectedExtensionProducts ?? new Set(exactExtensionProducts()),
      )
    : new Set();
  const nativeLifecycleSqlNames = extensionSqlNamesForProducts(nativeLifecycleProducts);
  const nativeLifecycleShards = nativeExtensionLifecycleShardPlan(nativeLifecycleProducts);
  const plan = {
    qualification_mode: FULL_PAYLOAD_QUALIFICATION_MODE,
    qualification_base_sha: null,
    qualification_head_sha: null,
    jobs: sorted(jobs),
    builder_jobs: sorted(new Set([...jobs].filter((job) => BUILDER_JOBS.has(job)))),
    e2e_jobs: mobileE2eJobsForPlan(jobs),
    job_targets: jobTargetsForJobs(jobs),
    projects: sorted(projects),
    tasks: sorted(tasks),
    liboliphaunt_native_desktop_runtime_matrix: liboliphauntNativeDesktopRuntimeMatrixForPlan(
      jobs,
      selectedTargets,
      nativeTarget,
    ),
    liboliphaunt_native_android_runtime_matrix: jobs.has("liboliphaunt-native-android")
      ? liboliphauntNativeAndroidRuntimeMatrix(nativeTarget, selectedTargets ?? undefined)
      : emptyMatrix(),
    liboliphaunt_native_ios_runtime_matrix: liboliphauntNativeIosRuntimeMatrixForPlan(
      jobs,
      selectedTargets,
      nativeTarget,
    ),
    extension_artifacts_native_matrix: jobs.has("extension-artifacts-native")
      ? extensionArtifactsNativeMatrixForPlan(
          jobs,
          selectedTargets,
          selectedExtensionProducts,
          nativeTarget,
        )
      : emptyMatrix(),
    extension_artifacts_wasix_matrix: jobs.has("extension-artifacts-wasix")
      ? extensionArtifactsWasixMatrixForPlan(jobs, selectedExtensionProducts)
      : emptyMatrix(),
    liboliphaunt_wasix_aot_runtime_matrix: jobs.has("liboliphaunt-wasix-aot")
      ? liboliphauntWasixAotRuntimeMatrix(wasmTarget)
      : emptyMatrix(),
    liboliphaunt_wasix_postmaster_runtime_matrix: jobs.has("wasix-postmaster")
      ? liboliphauntWasixPostmasterRuntimeMatrix()
      : emptyMatrix(),
    extension_package_products: extensionProducts,
    extension_package_products_csv: extensionProducts.join(","),
    extension_package_sql_names: extensionSqlNames,
    extension_package_sql_names_csv: extensionSqlNames.join(","),
    native_extension_lifecycle_sql_names: nativeLifecycleSqlNames,
    native_extension_lifecycle_sql_names_csv: nativeLifecycleSqlNames.join(","),
    native_extension_lifecycle_matrix: nativeLifecycleShards.matrix,
    native_extension_lifecycle_shard_count: nativeLifecycleShards.shardCount,
    mobile_extension_package_native_targets: mobileExtensionPackageNativeTargets(jobs, selectedTargets),
    mobile_extension_package_native_targets_csv: mobileExtensionPackageNativeTargets(jobs, selectedTargets).join(","),
    react_native_android_mobile_app_matrix: jobs.has("mobile-build-android")
      ? reactNativeAndroidMobileAppMatrix("all", REACT_NATIVE_ANDROID_REPRESENTATIVE_TARGETS)
      : emptyMatrix(),
    broker_runtime_matrix: jobs.has("broker-runtime")
      ? brokerRuntimeMatrix(
          !jobs.has("broker-release-assets")
            && jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)
            && selectedTargets?.size === 1
            && selectedTargets.has("linux-x64-gnu")
            ? "linux-x64-gnu"
            : nativeTarget,
        )
      : emptyMatrix(),
    node_direct_runtime_matrix: jobs.has("node-direct")
      ? nodeDirectRuntimeMatrix(nativeTarget)
      : emptyMatrix(),
    wasix_napi_runtime_matrix: jobs.has("wasix-napi")
      ? wasixNapiRuntimeMatrix(
          jobs.has("wasix-napi-release-assets") ? nativeTarget : "linux-x64-gnu",
        )
      : emptyMatrix(),
    reason,
  };
  return plan;
}

function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value instanceof Set) {
    return sorted(value);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

function output(name, value) {
  const rendered = typeof value === "string" ? value : JSON.stringify(sortedValue(value));
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${rendered}\n`, "utf8");
  }
  console.log(`${name}=${rendered}`);
}

function writePlanArtifact(plan) {
  const file = path.join(ROOT, "target/graph/ci-plan.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sortedValue(plan), null, 2)}\n`, "utf8");
}

export function emitGithubOutputs() {
  let planned;
  try {
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const pullRequestPlan = planForPullRequest();
      const selectedExtensionProducts = selectedExtensionProductsForPlan(
        pullRequestPlan.directProjects,
        pullRequestPlan.tasks,
        pullRequestPlan.jobs,
      );
      planned = renderPlanWithSelection({ ...pullRequestPlan, selectedExtensionProducts });
    } else {
      planned = renderPlanForFullRun({
        wasmTarget: process.env.WASM_TARGET || "all",
        nativeTarget: process.env.NATIVE_TARGET || "all",
        mobileTarget: process.env.MOBILE_TARGET || "all",
      });
    }
  } catch (error) {
    console.error(`affected planning failed: ${error.message}`);
    return 2;
  }
  writePlanArtifact(planned);
  for (const [name, value] of Object.entries(planned)) {
    output(name, value);
  }
  return 0;
}

function parseJsonFlag(argv, name, { defaultValue = undefined } = {}) {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === flag) {
      if (index + 1 >= argv.length) {
        fail(`${flag} requires a value`);
      }
      return JSON.parse(argv[index + 1]);
    }
    if (value.startsWith(`${flag}=`)) {
      return JSON.parse(value.slice(flag.length + 1));
    }
  }
  return defaultValue;
}

function stringFlag(argv, name, defaultValue = "all") {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === flag) {
      if (index + 1 >= argv.length) {
        fail(`${flag} requires a value`);
      }
      return argv[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return defaultValue;
}

function setFlag(argv, name) {
  const value = parseJsonFlag(argv, name, { defaultValue: [] });
  return new Set(stringList(value));
}

function nullableSetFlag(argv, name) {
  const value = parseJsonFlag(argv, name, { defaultValue: null });
  if (value === null) {
    return null;
  }
  return new Set(stringList(value));
}

function printJson(value) {
  console.log(JSON.stringify(sortedValue(value), null, 2));
}

function printPlanForFullRun(argv) {
  const plan = planForFullRun({
    wasmTarget: stringFlag(argv, "wasm-target"),
    nativeTarget: stringFlag(argv, "native-target"),
    mobileTarget: stringFlag(argv, "mobile-target"),
  });
  printJson({
    jobs: sorted(plan.jobs),
    projects: sorted(plan.projects),
    tasks: sorted(plan.tasks),
    reason: plan.reason,
    selectedTargets: plan.selectedTargets === null ? null : sorted(plan.selectedTargets),
  });
}

function printMatrix(argv, matrix) {
  const nativeTarget = stringFlag(argv, "native-target");
  const wasmTarget = stringFlag(argv, "wasm-target");
  const selectedTargets = nullableSetFlag(argv, "selected-targets-json");
  const selectedProducts = nullableSetFlag(argv, "selected-products-json");
  if (matrix === "extension-artifacts-native") {
    printJson(extensionArtifactsNativeMatrix(nativeTarget, selectedTargets ?? undefined, selectedProducts ?? undefined));
  } else if (matrix === "extension-artifacts-wasix") {
    printJson(extensionArtifactsWasixMatrix(wasmTarget, selectedProducts ?? undefined));
  } else {
    fail(`unsupported matrix query ${matrix}`);
  }
}

function usage() {
  return `usage: tools/graph/ci_plan.mjs [command]

Default command emits GitHub Actions outputs and target/graph/ci-plan.json.

Commands:
  config
  jobs-for-affected --tasks-json JSON
  native-target-subset --jobs-json JSON --tasks-json JSON
  selected-extension-products --direct-projects-json JSON --tasks-json JSON --jobs-json JSON
  plan-full [--wasm-target TARGET] [--native-target TARGET] [--mobile-target TARGET]
  mobile-extension-package-native-targets --jobs-json JSON --selected-targets-json JSON|null
  matrix extension-artifacts-native|extension-artifacts-wasix [selection flags]
`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.exit(emitGithubOutputs());
  }
  if (command === "--help" || command === "-h") {
    console.log(usage());
  } else if (command === "config") {
    printJson({
      baseJobs: sorted(BASE_JOBS),
      builderJobs: sorted(BUILDER_JOBS),
      ciJobTargets: CI_JOB_TARGETS,
      ciJobsConfig: CI_JOBS_CONFIG,
    });
  } else if (command === "jobs-for-affected") {
    printJson(sorted(planJobsForAffected(setFlag(rest, "tasks-json"))));
  } else if (command === "native-target-subset") {
    const targets = nativeTargetSubsetForJobs(setFlag(rest, "jobs-json"), setFlag(rest, "tasks-json"));
    printJson(targets === null ? null : sorted(targets));
  } else if (command === "selected-extension-products") {
    const selected = selectedExtensionProductsForPlan(
      setFlag(rest, "direct-projects-json"),
      setFlag(rest, "tasks-json"),
      setFlag(rest, "jobs-json"),
    );
    printJson(selected === null ? null : sorted(selected));
  } else if (command === "plan-full") {
    printPlanForFullRun(rest);
  } else if (command === "mobile-extension-package-native-targets") {
    printJson(mobileExtensionPackageNativeTargets(setFlag(rest, "jobs-json"), nullableSetFlag(rest, "selected-targets-json")));
  } else if (command === "matrix") {
    const [matrix, ...matrixRest] = rest;
    printMatrix(matrixRest, matrix);
  } else {
    fail(`unknown command ${command}`);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
