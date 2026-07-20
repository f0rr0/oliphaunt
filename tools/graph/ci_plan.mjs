#!/usr/bin/env bun
// Map Moon affected tasks onto stable GitHub Actions jobs.
//
// Moon is the only project/task graph. Stable GitHub job names are selected
// from Moon task tags named `ci-<job-id>`. GitHub Actions still owns platform
// matrix fan-out because runner OS, native target triples, and simulator/device
// targets are CI execution details, not source projects.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { moonCommand } from "../dev/moon-command.mjs";

import {
  brokerRuntimeMatrix,
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
  jsExactCandidateConsumerMatrix,
  liboliphauntNativeAndroidRuntimeMatrix,
  liboliphauntNativeDesktopRuntimeMatrix,
  liboliphauntNativeIosRuntimeMatrix,
  liboliphauntNativeRuntimeTargetsForSurface,
  liboliphauntWasixAotRuntimeMatrix,
  nodeDirectRuntimeMatrix,
  reactNativeAndroidMobileAppMatrix,
} from "../release/artifact_target_matrix.mjs";
import {
  compareText,
  exactExtensionProducts,
  extensionSqlNames,
} from "../release/release-artifact-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "ci_plan.mjs";

export const BASE_JOBS = new Set(["affected"]);
export const ALWAYS_JOBS = new Set(BASE_JOBS);
export const BUILDER_JOBS = new Set([
  "broker-runtime",
  "extension-artifacts-native",
  "extension-artifacts-wasix",
  "extension-packages",
  "js-sdk-package",
  "js-sdk-exact-candidate-consumer",
  "kotlin-sdk-package",
  "liboliphaunt-native-android",
  "liboliphaunt-native-desktop",
  "liboliphaunt-native-ios",
  "liboliphaunt-native-release-assets",
  "liboliphaunt-wasix-aot",
  "liboliphaunt-wasix-release-assets",
  "liboliphaunt-wasix-runtime",
  "mobile-build-android",
  "mobile-build-ios",
  "mobile-extension-packages",
  "node-direct",
  "react-native-sdk-package",
  "rust-sdk-package",
  "swift-sdk-package",
  "wasix-rust-package",
]);
const NATIVE_RUNTIME_JOBS = new Set([
  "liboliphaunt-native-android",
  "liboliphaunt-native-desktop",
  "liboliphaunt-native-ios",
]);
const NATIVE_RUNTIME_TASKS = new Set([
  "liboliphaunt-native:release-runtime",
  "liboliphaunt-native:release-runtime-desktop",
  "liboliphaunt-native:release-runtime-mobile-target",
]);
export const WASM_RUNTIME_JOBS = new Set([
  "liboliphaunt-wasix-runtime",
  "liboliphaunt-wasix-aot",
  "liboliphaunt-wasix-release-assets",
]);
const AGGREGATE_ARTIFACT_JOBS = new Set(["liboliphaunt-native-release-assets"]);
const WASM_RUNTIME_PORTABLE_TASK = "liboliphaunt-wasix:runtime-portable";
const WASM_RUNTIME_AOT_TASK = "liboliphaunt-wasix:runtime-aot";
const MOBILE_JOB_SURFACES = {
  "mobile-build-android": "react-native-android",
  "mobile-build-ios": "react-native-ios",
};
const MOBILE_E2E_JOBS = {
  "mobile-build-android": "mobile-e2e-android",
  "mobile-build-ios": "mobile-e2e-ios",
};
export const NATIVE_EXTENSION_LIFECYCLE_JOB = "native-extension-lifecycle";
export const NATIVE_EXTENSION_LIFECYCLE_AGGREGATE_JOB =
  "native-extension-lifecycle-aggregate";
export const RUST_EXACT_CANDIDATE_CONSUMER_JOB =
  "rust-sdk-exact-candidate-consumer";
export const WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB =
  "wasix-rust-exact-candidate-consumer";
const WASIX_RUST_EXACT_CANDIDATE_TRIGGER_TASKS = new Set([
  "release-tools:wasix-rust-exact-candidate-trigger",
]);
const JS_EXACT_CANDIDATE_TRIGGER_TASKS = new Set([
  "release-tools:js-exact-candidate-trigger",
]);
export const NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT = 3;
const NATIVE_EXTENSION_LIFECYCLE_TRIGGER_PROJECTS = new Set([
  "ci-workflows",
  "extension-artifacts-native",
  "extension-contrib-postgres18",
  "extension-model",
  "extensions",
  "liboliphaunt-native",
  "oliphaunt-broker",
  "oliphaunt-rust",
  "postgres18",
  "source-inputs",
  "third-party-native",
  "third-party-shared",
]);
const ANDROID_MOBILE_JOBS = new Set(["mobile-build-android"]);
const IOS_MOBILE_JOBS = new Set(["mobile-build-ios"]);
const EXTENSION_ARTIFACT_CONSUMER_JOBS = new Set(["extension-packages", "mobile-extension-packages"]);
const WASIX_EXTENSION_ARTIFACT_PORTABLE_CONSUMER_JOBS = new Set([
  "extension-packages",
  "extension-artifacts-wasix",
]);
const JS_EXACT_CANDIDATE_TRIGGER_JOBS = new Set([
  "broker-runtime",
  "js-sdk-package",
  "liboliphaunt-native-desktop",
  "liboliphaunt-native-release-assets",
  "node-direct",
]);

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function commandJson(command, args) {
  const output = execFileSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function moon(args) {
  return commandJson(moonCommand(), args);
}

function affectedProjectsAndTasks() {
  const summary = commandJson(process.execPath, ["tools/graph/affected.mjs", "summary"]);
  return {
    directProjects: new Set(stringList(summary.directProjects ?? [])),
    projects: new Set(stringList(summary.projects ?? [])),
    directTasks: new Set(stringList(summary.directTasks ?? [])),
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

function difference(left, right) {
  return new Set([...left].filter((item) => !right.has(item)));
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

export function moonCiJobTargets() {
  const queried = moon(["query", "tasks"]);
  const tasksByProject = queried.tasks;
  if (tasksByProject === null || Array.isArray(tasksByProject) || typeof tasksByProject !== "object") {
    fail("moon query tasks did not return a tasks object");
  }

  const jobs = new Map();
  for (const [projectId, projectTasks] of Object.entries(tasksByProject)) {
    if (projectTasks === null || Array.isArray(projectTasks) || typeof projectTasks !== "object") {
      continue;
    }
    for (const [taskId, task] of Object.entries(projectTasks)) {
      if (task === null || Array.isArray(task) || typeof task !== "object") {
        continue;
      }
      const target = String(task.target || `${projectId}:${taskId}`);
      const tags = Array.isArray(task.tags) ? task.tags : [];
      for (const tag of tags) {
        if (typeof tag === "string" && tag.startsWith("ci-")) {
          const job = tag.slice("ci-".length);
          if (!jobs.has(job)) {
            jobs.set(job, new Set());
          }
          jobs.get(job).add(target);
        }
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
export const ALL_BUILDER_JOBS = difference(
  setUnion(BUILDER_JOBS, WASM_RUNTIME_JOBS, AGGREGATE_ARTIFACT_JOBS),
  ALWAYS_JOBS,
);
export const COVERAGE_JOB_PRODUCTS = Object.fromEntries(
  Object.entries(CI_JOB_TARGETS)
    .filter(([, targets]) => targets.some((target) => target.endsWith(":coverage")))
    .map(([job, targets]) => [job, targets[0].split(":", 1)[0]])
    .sort(([left], [right]) => compareText(left, right)),
);
export const CI_JOBS_CONFIG = {
  always_jobs: sorted(ALWAYS_JOBS),
  ci_job_targets: CI_JOB_TARGETS,
  coverage_job_products: COVERAGE_JOB_PRODUCTS,
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

export function addImpliedJobs(jobs, tasks) {
  if (
    intersects(
      jobs,
      new Set(["liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot", "liboliphaunt-wasix-release-assets"]),
    ) ||
    intersects(new Set([WASM_RUNTIME_PORTABLE_TASK, WASM_RUNTIME_AOT_TASK]), tasks)
  ) {
    for (const job of WASM_RUNTIME_JOBS) {
      jobs.add(job);
    }
  }

  if (intersects(jobs, new Set(Object.keys(MOBILE_JOB_SURFACES)))) {
    jobs.add("mobile-extension-packages");
    jobs.add("react-native-sdk-package");
  }

  // The published React Native package embeds a checksum-bound base iOS
  // carrier manifest even when an Android app is the only mobile consumer in
  // this plan. Keep that producer prerequisite explicit without broadening the
  // Android extension-target selection to iOS.
  if (jobs.has("react-native-sdk-package")) {
    jobs.add("liboliphaunt-native-ios");
  }

  if (intersects(jobs, ANDROID_MOBILE_JOBS)) {
    jobs.add("liboliphaunt-native-android");
    jobs.add("kotlin-sdk-package");
  }

  if (intersects(jobs, IOS_MOBILE_JOBS)) {
    jobs.add("liboliphaunt-native-ios");
    jobs.add("swift-sdk-package");
  }

  if (jobs.has("swift-sdk-package")) {
    jobs.add("liboliphaunt-native-ios");
  }

  if (jobs.has("js-sdk-exact-candidate-consumer")) {
    jobs.add("js-sdk-package");
    jobs.add("liboliphaunt-native-desktop");
    // Extension npm meta packages embed the checksum-bound iOS carrier
    // manifest for every host target. Exact-candidate materialization must
    // therefore receive the same-run base XCFramework even on Linux/Windows.
    jobs.add("liboliphaunt-native-ios");
    jobs.add("broker-runtime");
    jobs.add("node-direct");
  }

  if (jobs.has(WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB)) {
    jobs.add("wasix-rust-package");
    for (const job of WASM_RUNTIME_JOBS) jobs.add(job);
  }

  if (jobs.has("liboliphaunt-native-release-assets")) {
    for (const job of NATIVE_RUNTIME_JOBS) {
      jobs.add(job);
    }
  }

  if (intersects(jobs, new Set(["extension-artifacts-native", "extension-artifacts-wasix"]))) {
    jobs.add("extension-packages");
  }

  if (intersects(jobs, EXTENSION_ARTIFACT_CONSUMER_JOBS)) {
    jobs.add("extension-artifacts-native");
  }

  if (intersects(jobs, WASIX_EXTENSION_ARTIFACT_PORTABLE_CONSUMER_JOBS)) {
    jobs.add("extension-artifacts-wasix");
    jobs.add("liboliphaunt-wasix-runtime");
    jobs.add("liboliphaunt-wasix-aot");
  }

  // Add lifecycle proof producers last. This keeps a focused Linux proof from
  // recursively selecting every release-package target while preserving exact
  // same-run producer edges for the proof consumer.
  if (
    jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)
      || jobs.has(RUST_EXACT_CANDIDATE_CONSUMER_JOB)
  ) {
    jobs.add("extension-artifacts-native");
    jobs.add("liboliphaunt-native-desktop");
    jobs.add("broker-runtime");
    jobs.add("rust-sdk-package");
  }
  if (jobs.has("js-sdk-exact-candidate-consumer")) {
    jobs.add("extension-artifacts-native");
  }
}

export function planJobsForAffected(directProjects, tasks) {
  const jobs = new Set(ALWAYS_JOBS);
  for (const job of jobsForTargets(tasks, { allowedJobs: ALL_BUILDER_JOBS })) {
    jobs.add(job);
  }
  if (intersects(directProjects, new Set(exactExtensionProducts()))) {
    jobs.add("extension-artifacts-native");
    jobs.add("extension-artifacts-wasix");
    jobs.add("extension-packages");
  }
  if (jobs.has("react-native-sdk-package")) {
    for (const job of ANDROID_MOBILE_JOBS) {
      jobs.add(job);
    }
    for (const job of IOS_MOBILE_JOBS) {
      jobs.add(job);
    }
  }
  const directTaskProjects = new Set([...tasks].map((target) => target.split(":", 1)[0]));
  if (
    intersects(directProjects, NATIVE_EXTENSION_LIFECYCLE_TRIGGER_PROJECTS) ||
    intersects(directTaskProjects, NATIVE_EXTENSION_LIFECYCLE_TRIGGER_PROJECTS) ||
    intersects(directProjects, new Set(exactExtensionProducts()))
  ) {
    jobs.add(NATIVE_EXTENSION_LIFECYCLE_JOB);
  }
  if (directProjects.has("oliphaunt-rust") || directTaskProjects.has("oliphaunt-rust")) {
    jobs.add(RUST_EXACT_CANDIDATE_CONSUMER_JOB);
  }
  if (directProjects.has("ci-workflows")) {
    for (const job of ALL_BUILDER_JOBS) {
      jobs.add(job);
    }
  }
  if (
    intersects(jobs, JS_EXACT_CANDIDATE_TRIGGER_JOBS)
      || intersects(tasks, JS_EXACT_CANDIDATE_TRIGGER_TASKS)
  ) {
    jobs.add("js-sdk-exact-candidate-consumer");
  }
  if (
    jobs.has("wasix-rust-package")
      || intersects(jobs, WASM_RUNTIME_JOBS)
      || intersects(tasks, WASIX_RUST_EXACT_CANDIDATE_TRIGGER_TASKS)
  ) {
    jobs.add(WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB);
  }
  addImpliedJobs(jobs, tasks);
  if (jobs.has("liboliphaunt-wasix-runtime")) {
    // Pull-request and push CI always run the Linux-host release regression
    // when the portable runtime is affected. Select its exact-extension
    // producer without broadening the plan to native or aggregate packages.
    jobs.add("extension-artifacts-wasix");
  }
  if (intersects(tasks, NATIVE_RUNTIME_TASKS)) {
    jobs.add("liboliphaunt-native-release-assets");
    for (const job of NATIVE_RUNTIME_JOBS) {
      jobs.add(job);
    }
  }
  return jobs;
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
    || jobs.has(RUST_EXACT_CANDIDATE_CONSUMER_JOB)
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
  if (jobs.has(RUST_EXACT_CANDIDATE_CONSUMER_JOB)) {
    selected.push(RUST_EXACT_CANDIDATE_CONSUMER_JOB);
  }
  if (jobs.has(WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB)) {
    selected.push(WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB);
  }
  return selected.sort(compareText);
}

export function liboliphauntNativeIosRuntimeMatrixForPlan(
  jobs,
  selectedTargets,
  nativeTarget = process.env.NATIVE_TARGET || "all",
) {
  if (!jobs.has("liboliphaunt-native-ios")) return emptyMatrix();
  if (jobs.has("react-native-sdk-package") || jobs.has("js-sdk-exact-candidate-consumer")) {
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
  if (!jobs.has("js-sdk-exact-candidate-consumer")) {
    return liboliphauntNativeDesktopRuntimeMatrix(nativeTarget, selectedTargets ?? undefined);
  }

  // Every JavaScript exact-candidate row needs its same-target runtime, while
  // the target-independent @oliphaunt/icu candidate has one canonical producer
  // in the macOS row. A focused dispatch therefore keeps only its requested JS
  // target plus macOS when macOS is not already that target.
  const requiredTargets = new Set(
    jsExactCandidateConsumerMatrix(nativeTarget).include.map(({ target }) => target),
  );
  for (const target of selectedTargets ?? []) {
    if (/^(?:linux|macos|windows)-/u.test(target)) requiredTargets.add(target);
  }
  requiredTargets.add("macos-arm64");
  return liboliphauntNativeDesktopRuntimeMatrix("all", requiredTargets);
}

function focusedMobileNativeTargets(mobileTarget, nativeTarget, focusedMobileJobs) {
  const targets = mobileNativeTargetsForJobs(focusedMobileJobs);
  if (nativeTarget === "all") {
    return targets;
  }
  if (mobileTarget === "both") {
    throw new Error("focused mobile_target=both requires native_target=all");
  }
  if (!targets.has(nativeTarget)) {
    throw new Error(
      `native_target=${nativeTarget} is not valid for mobile_target=${mobileTarget}; expected one of: all, ${sorted(targets).join(", ")}`,
    );
  }
  return new Set([nativeTarget]);
}

export function planForPullRequest() {
  const base = process.env.MOON_BASE;
  const head = process.env.MOON_HEAD;
  if (!base || !head) {
    throw new Error("MOON_BASE and MOON_HEAD are required for pull_request CI planning");
  }

  const { directProjects, projects, directTasks } = affectedProjectsAndTasks();
  const jobs = planJobsForAffected(directProjects, directTasks);
  const selectedNativeTargets = nativeTargetSubsetForJobs(jobs, directTasks);
  const reason =
    `direct affected projects: ${sorted(directProjects).join(", ") || "(none)"}; ` +
    `downstream affected projects: ${sorted(projects).join(", ") || "(none)"}; ` +
    `direct affected tasks: ${sorted(directTasks).join(", ") || "(none)"}`;
  return { jobs, projects, tasks: directTasks, reason, selectedTargets: selectedNativeTargets };
}

export function selectedExtensionProductsForPlan(directProjects, tasks, jobs) {
  const extensionJobs = new Set([
    "extension-artifacts-native",
    "extension-artifacts-wasix",
    "extension-packages",
    NATIVE_EXTENSION_LIFECYCLE_JOB,
    "js-sdk-exact-candidate-consumer",
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
  const broadExtensionInputs = new Set([
    "extension-artifacts-native",
    "extension-artifacts-wasix",
    "extension-contrib-postgres18",
    "extension-model",
    "extension-packages",
    "extensions",
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "postgres18",
    "source-inputs",
    "third-party-native",
    "third-party-shared",
    "third-party-wasix",
  ]);
  if (intersects(directProjects, broadExtensionInputs)) {
    return exactProducts;
  }
  if (tasks.has("extension-packages:assemble-release") && selected.size === 0) {
    return exactProducts;
  }
  if (jobs.has("extension-packages") && selected.size === 0) {
    return exactProducts;
  }
  if (intersects(jobs, new Set(["extension-artifacts-native", "extension-artifacts-wasix"])) && selected.size === 0) {
    return exactProducts;
  }
  if (tasks.has("extension-packages:assemble-mobile") && selected.size === 0) {
    return exactProducts;
  }
  return selected.size > 0 ? selected : null;
}

export function extensionProductDependencyClosure(products) {
  const exactProducts = new Set(exactExtensionProducts());
  const productBySqlName = new Map(
    [...exactProducts].flatMap((product) => extensionSqlNames(product, PREFIX).map((sqlName) => [sqlName, product])),
  );
  const metadata = JSON.parse(
    readFileSync(path.join(ROOT, "src/extensions/generated/sdk/rust.json"), "utf8"),
  );
  const metadataBySqlName = new Map(
    (metadata.extensions ?? []).map((row) => [row["sql-name"], row]),
  );
  const closure = new Set();
  const pending = [...products];
  while (pending.length > 0) {
    const product = pending.pop();
    if (!exactProducts.has(product)) throw new Error(`unknown exact extension product ${product}`);
    if (closure.has(product)) continue;
    closure.add(product);
    for (const sqlName of extensionSqlNames(product, PREFIX)) {
      const row = metadataBySqlName.get(sqlName);
      if (!row) throw new Error(`generated Rust metadata is missing exact extension ${sqlName}`);
      for (const dependencySqlName of row["selected-extension-dependencies"] ?? []) {
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
    addImpliedJobs(focusedJobs, new Set());
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
        "broker-runtime",
        "node-direct",
        "js-sdk-exact-candidate-consumer",
      ]));
      focusedProjects = new Set(["liboliphaunt-native", "oliphaunt-broker", "oliphaunt-node-direct"]);
      if (nativeTarget === "linux-x64-gnu") {
        focusedJobs.add(NATIVE_EXTENSION_LIFECYCLE_JOB);
      }
    }
    addImpliedJobs(focusedJobs, new Set());
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
    new Set([
      NATIVE_EXTENSION_LIFECYCLE_JOB,
      RUST_EXACT_CANDIDATE_CONSUMER_JOB,
      WASIX_RUST_EXACT_CANDIDATE_CONSUMER_JOB,
    ]),
  );
  addImpliedJobs(jobs, targetsForJobs(jobs));
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
  { jobs, projects, tasks, reason, selectedTargets },
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
    { nativeTarget, wasmTarget },
  );
}

export function extensionArtifactsWasixMatrixForPlan(jobs, selectedExtensionProducts) {
  // Release regression exercises every promoted extension. Its portable
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
  const jsCandidateTargets = jobs.has("js-sdk-exact-candidate-consumer")
    ? new Set(jsExactCandidateConsumerMatrix(nativeTarget).include.map((row) => row.target))
    : null;
  const matrixTargets = jsCandidateTargets !== null && !jobs.has("extension-packages")
    ? jsCandidateTargets
    : selectedTargets ?? undefined;
  const matrix = extensionArtifactsNativeMatrix(
    nativeTarget,
    jobs.has("extension-packages") ? undefined : matrixTargets,
    selectedExtensionProducts ?? undefined,
  );
  if (!jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB) && jsCandidateTargets === null) {
    return matrix;
  }

  const exactProducts = new Set(exactExtensionProducts());
  const requiredTargets = new Set(jsCandidateTargets ?? []);
  if (jsCandidateTargets !== null) {
    // Every extension npm meta package embeds both its same-host carrier and
    // its Apple carrier. Keep the independently downloaded iOS extension
    // payload in the exact-consumer producer closure for every desktop row.
    requiredTargets.add("ios-xcframework");
  }
  if (jobs.has(NATIVE_EXTENSION_LIFECYCLE_JOB)) {
    requiredTargets.add("linux-x64-gnu");
  }
  const proofProducts = jsCandidateTargets !== null
    ? exactProducts
    : extensionProductDependencyClosure(selectedExtensionProducts ?? exactProducts);
  const proofRows = extensionArtifactsNativeMatrix(
    "all",
    requiredTargets,
    proofProducts,
  ).include;
  if (proofRows.length !== requiredTargets.size) {
    throw new Error("exact-candidate extension consumers do not have one complete producer row per required target");
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
  return {
    matrix: {
      include: Array.from({ length: shardCount }, (_, shard) => ({
        shard,
        shard_count: shardCount,
      })),
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
      ? reactNativeAndroidMobileAppMatrix(nativeTarget, selectedTargets ?? undefined)
      : emptyMatrix(),
    broker_runtime_matrix: jobs.has("broker-runtime")
      ? brokerRuntimeMatrix(
          !jobs.has("js-sdk-exact-candidate-consumer")
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
    js_exact_candidate_consumer_matrix: jobs.has("js-sdk-exact-candidate-consumer")
      ? jsExactCandidateConsumerMatrix(nativeTarget)
      : emptyMatrix(),
    reason,
  };
  assertJsExactCandidatePlanClosure(plan);
  return plan;
}

export function assertJsExactCandidatePlanClosure(plan) {
  if (!plan.jobs.includes("js-sdk-exact-candidate-consumer")) return;
  const rows = plan.js_exact_candidate_consumer_matrix?.include ?? [];
  if (rows.length === 0) {
    throw new Error("JavaScript exact-candidate plan selected no consumer targets");
  }
  const consumerTargets = rows.map(({ target }) => target);
  if (new Set(consumerTargets).size !== consumerTargets.length) {
    throw new Error("JavaScript exact-candidate plan repeats a consumer target");
  }
  const producerTargets = {
    native: new Set((plan.liboliphaunt_native_desktop_runtime_matrix?.include ?? []).map(({ target }) => target)),
    iosBase: new Set((plan.liboliphaunt_native_ios_runtime_matrix?.include ?? []).map(({ target }) => target)),
    extension: new Set((plan.extension_artifacts_native_matrix?.include ?? []).map(({ target }) => target)),
    broker: new Set((plan.broker_runtime_matrix?.include ?? []).map(({ target }) => target)),
    node: new Set((plan.node_direct_runtime_matrix?.include ?? []).map(({ target }) => target)),
  };
  if (!producerTargets.native.has("macos-arm64")) {
    throw new Error("JavaScript exact-candidate plan omits the canonical macOS portable ICU producer");
  }
  if (!producerTargets.iosBase.has("ios-xcframework")) {
    throw new Error("JavaScript exact-candidate plan omits the checksum-bound iOS base carrier producer");
  }
  if (!producerTargets.extension.has("ios-xcframework")) {
    throw new Error("JavaScript exact-candidate plan omits the checksum-bound iOS extension carrier producer");
  }
  for (const row of rows) {
    for (const [label, targets] of Object.entries(producerTargets).filter(([label]) => label !== "iosBase")) {
      if (!targets.has(row.target)) {
        throw new Error(`JavaScript exact-candidate ${row.target} has no same-run ${label} producer`);
      }
    }
    for (const [field, expected] of [
      ["native_artifact", `liboliphaunt-native-release-assets-${row.target}`],
      ["extension_artifact", `liboliphaunt-native-extension-artifacts-${row.target}`],
      ["broker_artifact", `oliphaunt-broker-release-assets-${row.target}`],
      ["node_artifact", `oliphaunt-node-direct-npm-package-${row.target}`],
    ]) {
      if (row[field] !== expected) {
        throw new Error(`JavaScript exact-candidate ${row.target} has invalid ${field} ${row[field]}`);
      }
    }
  }
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
      let directProjects = new Set();
      try {
        directProjects = affectedProjectsAndTasks().directProjects;
      } catch {
        directProjects = new Set();
      }
      const selectedExtensionProducts = selectedExtensionProductsForPlan(
        directProjects,
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
  jobs-for-affected --direct-projects-json JSON --tasks-json JSON
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
    printJson(sorted(planJobsForAffected(setFlag(rest, "direct-projects-json"), setFlag(rest, "tasks-json"))));
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
