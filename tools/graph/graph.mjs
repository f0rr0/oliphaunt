#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { moonCommand } from "../dev/moon-command.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { triggeringProjectNames } from "./affected.mjs";

const TOOL = "graph.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const GRAPH_ROOT = path.join(ROOT, "target/graph");
const COVERAGE_BASELINE_PATH = path.join(ROOT, "coverage/baseline.toml");
const SYNTHETIC_ROOT = path.join(ROOT, "tools/graph/synthetic");

const GENERATED_PATH_PARTS = new Set([
  ".build",
  ".cxx",
  ".expo",
  ".gradle",
  ".kotlin",
  ".moon",
  ".next",
  ".source",
  "DerivedData",
  "Pods",
  "__pycache__",
  "dist",
  "lib",
  "node_modules",
  "out",
  "target",
]);

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function posix(value) {
  return String(value).split(path.sep).join("/");
}

function rel(file) {
  const resolved = path.resolve(String(file));
  const relative = path.relative(ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return posix(resolved);
  }
  return posix(relative);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(items) {
  return [...items].sort(compareText);
}

function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
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

function jsonText(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

function readToml(file) {
  if (!existsSync(file)) {
    fail(`missing TOML input: ${rel(file)}`);
  }
  const value = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${rel(file)} must contain a TOML table`);
  }
  return value;
}

function commandJson(command, args, { input = undefined } = {}) {
  const result = captureCommandOutput(command, args, {
    cwd: ROOT,
    env: process.env,
    input,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    fail(`${command} failed: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

function runMoon(args, { input = undefined } = {}) {
  const value = commandJson(moonCommand(), args, { input });
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("moon query did not return a JSON object");
  }
  return value;
}

function bunJson(args) {
  return commandJson(process.execPath, args);
}

function ciPlanQuery(command, ...args) {
  return bunJson(["tools/graph/ci_plan.mjs", command, ...args]);
}

const CI_PLAN_CONFIG = ciPlanQuery("config");
const CI_JOB_TARGETS = CI_PLAN_CONFIG.ciJobTargets;
const CI_JOBS_CONFIG = CI_PLAN_CONFIG.ciJobsConfig;
const CI_BUILDER_JOBS = new Set(CI_PLAN_CONFIG.builderJobs ?? []);

function planJobsForAffected(directProjects, tasks) {
  const jobs = ciPlanQuery(
    "jobs-for-affected",
    "--direct-projects-json",
    JSON.stringify(sorted(directProjects)),
    "--tasks-json",
    JSON.stringify(sorted(tasks)),
  );
  if (!Array.isArray(jobs) || !jobs.every((job) => typeof job === "string")) {
    fail("CI planner jobs-for-affected query did not return a string list");
  }
  return new Set(jobs);
}

function nativeTargetSubsetForJobs(jobs, tasks) {
  const targets = ciPlanQuery(
    "native-target-subset",
    "--jobs-json",
    JSON.stringify(sorted(jobs)),
    "--tasks-json",
    JSON.stringify(sorted(tasks)),
  );
  if (targets === null) return null;
  if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string")) {
    fail("CI planner native-target-subset query did not return null or a string list");
  }
  return new Set(targets);
}

function releaseGraph() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "graph"]);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("release graph query did not return an object");
  }
  return value;
}

function releaseProductProjects() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "product-projects"]);
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string")
  ) {
    fail("release graph product-project query did not return a string map");
  }
  return value;
}

function releaseOrder(products) {
  const value = bunJson([
    "tools/release/release_graph_query.mjs",
    "release-order",
    "--products-json",
    JSON.stringify(products),
  ]);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("release graph order query did not return a string list");
  }
  return value;
}

function releasePlanForPaths(paths) {
  const args = ["tools/release/release_graph_query.mjs", "plan"];
  for (const item of paths) {
    args.push("--changed-file", item);
  }
  const value = bunJson(args);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("release graph plan query did not return an object");
  }
  return value;
}

function releasePlansForSinglePaths(paths) {
  const value = bunJson([
    "tools/release/release_graph_query.mjs",
    "plans-for-paths",
    "--paths-json",
    JSON.stringify(paths),
  ]);
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !Object.entries(value).every(([key, item]) => typeof key === "string" && item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    fail("release graph plans-for-paths query did not return a plan map");
  }
  return value;
}

function affectedNames(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return new Set(Object.keys(value).map(String));
  }
  if (Array.isArray(value)) {
    const result = new Set();
    for (const item of value) {
      if (typeof item === "string") {
        result.add(item);
      } else if (item !== null && typeof item === "object") {
        const identifier = item.id ?? item.target;
        if (identifier) {
          result.add(String(identifier));
        }
      }
    }
    return result;
  }
  return new Set();
}

function moonProjects() {
  const projects = runMoon(["query", "projects"]).projects;
  if (!Array.isArray(projects)) {
    fail("moon query projects did not return a projects array");
  }
  return projects;
}

function moonTasks() {
  const tasks = runMoon(["query", "tasks"]).tasks;
  if (tasks === null || Array.isArray(tasks) || typeof tasks !== "object") {
    fail("moon query tasks did not return a tasks object");
  }
  return tasks;
}

function objectKeys(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function normalizeProject(project) {
  const config = project.config !== null && typeof project.config === "object" ? project.config : {};
  const rawDeps = project.dependencies ?? config.dependsOn ?? [];
  if (!Array.isArray(rawDeps)) {
    fail(`Moon project ${project.id} has non-list dependsOn`);
  }
  const deps = {};
  for (const dependency of rawDeps) {
    if (typeof dependency === "string") {
      deps[dependency] = "production";
    } else if (dependency !== null && typeof dependency === "object" && typeof dependency.id === "string") {
      deps[dependency.id] = String(dependency.scope ?? "production");
    } else {
      fail(`Moon project ${project.id} has unsupported dependency entry ${JSON.stringify(dependency)}`);
    }
  }
  return {
    id: project.id,
    source: project.source ?? config.source ?? "",
    language: project.language ?? config.language,
    layer: project.layer ?? config.layer,
    stack: project.stack ?? config.stack,
    tags: sorted(config.tags ?? []),
    dependsOn: sorted(Object.keys(deps)),
    dependencyScopes: Object.fromEntries(Object.entries(deps).sort(([left], [right]) => compareText(left, right))),
    project: config.project !== null && typeof config.project === "object" ? config.project : {},
    tasks: sorted(Object.keys(project.tasks ?? {})),
  };
}

function normalizeTask(task) {
  const inputs = new Set([
    ...objectKeys(task.inputFiles),
    ...objectKeys(task.inputGlobs),
  ]);
  for (const item of task.inputs ?? []) {
    if (item !== null && typeof item === "object" && (item.file || item.glob)) {
      inputs.add(item.file ?? item.glob);
    }
  }

  const outputs = new Set([
    ...objectKeys(task.outputFiles),
    ...objectKeys(task.outputGlobs),
  ]);
  for (const item of task.outputs ?? []) {
    if (typeof item === "string") {
      outputs.add(item);
    } else if (item !== null && typeof item === "object" && (item.file || item.glob)) {
      outputs.add(item.file ?? item.glob);
    }
  }

  const deps = (task.deps ?? [])
    .map((dep) =>
      dep !== null && typeof dep === "object"
        ? { target: dep.target, cacheStrategy: dep.cacheStrategy ?? null }
        : { target: dep, cacheStrategy: null },
    )
    .sort((left, right) => compareText(left.target ?? "", right.target ?? "") || compareText(left.cacheStrategy ?? "", right.cacheStrategy ?? ""));

  return {
    command: [task.command ?? "", ...(task.args ?? [])].join(" ").trim(),
    deps,
    tags: sorted(task.tags ?? []),
    inputs: sorted(inputs),
    outputs: sorted(outputs),
    cache: task.options?.cache,
    runInCI: task.options?.runInCI ?? true,
  };
}

function releaseProducts(releaseMetadata) {
  const products = releaseMetadata.products;
  if (products === null || Array.isArray(products) || typeof products !== "object") {
    fail("release metadata must define [products.<id>] tables");
  }
  return products;
}

function dependentsByProject(projects) {
  const dependents = Object.fromEntries(Object.keys(projects).map((project) => [project, new Set()]));
  for (const [project, config] of Object.entries(projects)) {
    for (const dependency of config.dependsOn) {
      if (!dependents[dependency]) {
        dependents[dependency] = new Set();
      }
      dependents[dependency].add(project);
    }
  }
  return Object.fromEntries(
    Object.keys(dependents)
      .sort(compareText)
      .map((project) => [project, sorted(dependents[project])]),
  );
}

function downstreamClosure(project, dependents) {
  const seen = new Set([project]);
  const queue = [project];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of dependents[current] ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return sorted(seen);
}

function ownerProjectForPath(projects, filePath) {
  if (isGeneratedLocalState(filePath)) {
    return null;
  }
  const matches = Object.values(projects).filter(
    (project) =>
      project.source === "." ||
      filePath === project.source ||
      filePath.startsWith(`${project.source}/`),
  );
  matches.sort((left, right) => right.source.length - left.source.length);
  return matches[0]?.id ?? null;
}

function isGeneratedLocalState(filePath) {
  if (filePath.startsWith("target/")) {
    return true;
  }
  return filePath.split("/").some((part) => GENERATED_PATH_PARTS.has(part));
}

function coverageExpectations(coverageBaseline, tasks) {
  const products = coverageBaseline.products;
  if (products === null || Array.isArray(products) || typeof products !== "object") {
    fail("coverage baseline must define [products.<id>] tables");
  }
  const expectations = {};
  for (const [product, config] of Object.entries(products).sort(([left], [right]) => compareText(left, right))) {
    const productTasks = tasks[product] ?? {};
    expectations[product] = {
      tool: config.tool,
      lineThreshold: config.line_threshold,
      measuredLineCoverage: config.measured_line_coverage,
      summary: config.summary,
      reports: config.reports ?? [],
      includeGlobs: config.source_globs ?? config.include_globs ?? [],
      excludeGlobs: config.exclude_globs ?? [],
      moonCoverageTask: Object.hasOwn(productTasks, "coverage"),
    };
  }
  return expectations;
}

function ciMatrix(tasks) {
  const jobs = {};
  const missing = {};
  for (const [job, targets] of Object.entries(CI_JOB_TARGETS)) {
    const missingTargets = [];
    for (const target of targets) {
      const [project, taskId] = target.split(":", 2);
      if (!Object.hasOwn(tasks[project] ?? {}, taskId)) {
        missingTargets.push(target);
      }
    }
    jobs[job] = {
      targets,
      allTargetsExist: missingTargets.length === 0,
    };
    if (missingTargets.length > 0) {
      missing[job] = missingTargets;
    }
  }
  return {
    metadata: {
      alwaysJobs: sorted(CI_JOBS_CONFIG.always_jobs),
      coverageJobProducts: Object.fromEntries(Object.entries(CI_JOBS_CONFIG.coverage_job_products).sort(([left], [right]) => compareText(left, right))),
      wasmRuntimeJobs: sorted(CI_JOBS_CONFIG.wasm_runtime_jobs),
      source: "Moon task tags ci-<job>",
    },
    jobs,
    requiredJobs: sorted(Object.keys(CI_JOB_TARGETS)),
    missingTargets: missing,
  };
}

function buildGraph() {
  const releaseMetadata = releaseGraph();
  const coverageBaseline = readToml(COVERAGE_BASELINE_PATH);
  const projects = Object.fromEntries(moonProjects().map((project) => [project.id, normalizeProject(project)]));
  const tasksRaw = moonTasks();
  const tasks = Object.fromEntries(
    Object.entries(tasksRaw)
      .sort(([left], [right]) => compareText(left, right))
      .map(([project, projectTasks]) => [
        project,
        Object.fromEntries(
          Object.entries(projectTasks)
            .sort(([left], [right]) => compareText(left, right))
            .map(([taskId, task]) => [taskId, normalizeTask(task)]),
        ),
      ]),
  );
  const products = releaseProducts(releaseMetadata);
  const productIds = Object.keys(products);
  const productProjects = releaseProductProjects();
  const dependents = dependentsByProject(projects);
  return {
    moonProjects: projects,
    moonTasks: tasks,
    moonDependents: dependents,
    releaseProducts: Object.fromEntries(
      Object.entries(products).map(([product, config]) => [
        product,
        {
          owner: config.owner,
          kind: config.kind,
          moonProject: productProjects[product],
          tagPrefix: config.tag_prefix,
          publishTargets: config.publish_targets ?? [],
          releaseArtifacts: config.release_artifacts ?? [],
          moonProjectExists: Object.hasOwn(projects, productProjects[product]),
        },
      ]),
    ),
    releaseOrder: releaseOrder(productIds),
    coverageExpectations: coverageExpectations(coverageBaseline, tasksRaw),
    ciMatrix: ciMatrix(tasksRaw),
    productIds,
    policy: releaseMetadata.policy ?? {},
  };
}

function normalizeExplainPaths(paths) {
  const normalized = new Set();
  for (const item of paths) {
    let value = String(item).trim().replaceAll("\\", "/");
    if (value.startsWith("./")) {
      value = value.slice(2);
    }
    if (value) {
      normalized.add(value);
    }
  }
  return sorted(normalized);
}

function explainPaths(paths, graph) {
  const projects = graph.moonProjects;
  const dependents = graph.moonDependents;
  const normalizedPaths = normalizeExplainPaths(paths);
  const releaseImpact = releasePlanForPaths(normalizedPaths);
  return {
    paths: normalizedPaths.map((filePath) => {
      const owner = ownerProjectForPath(projects, filePath);
      return {
        path: filePath,
        ownerProject: owner,
        moonAffectedProjects: owner ? downstreamClosure(owner, dependents) : [],
        coverageProducts: coverageProductsForPath(filePath, graph),
      };
    }),
    releasePlan: releaseImpact,
  };
}

function coverageProductsForPath(filePath, graph) {
  if (isGeneratedLocalState(filePath)) {
    return [];
  }
  const products = [];
  for (const [product, config] of Object.entries(graph.coverageExpectations)) {
    const includes = config.includeGlobs ?? [];
    const excludes = config.excludeGlobs ?? [];
    if (productMatches(filePath, includes) && !productMatches(filePath, excludes)) {
      products.push(product);
    }
  }
  return sorted(products);
}

function escapeRegex(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function globPatternToRegex(pattern) {
  return new RegExp(`^${[...pattern].map((char) => (char === "*" ? ".*" : escapeRegex(char))).join("")}$`);
}

function productMatches(filePath, patterns) {
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return includes.some((pattern) => globPatternToRegex(pattern).test(filePath)) &&
    !excludes.some((pattern) => globPatternToRegex(pattern).test(filePath));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, jsonText(value), "utf8");
}

function writeGraph(graph) {
  mkdirSync(GRAPH_ROOT, { recursive: true });
  writeJson(path.join(GRAPH_ROOT, "products.json"), {
    moonProjects: graph.moonProjects,
    moonDependents: graph.moonDependents,
    releaseProducts: graph.releaseProducts,
    releaseOrder: graph.releaseOrder,
    productIds: graph.productIds,
  });
  writeJson(path.join(GRAPH_ROOT, "tasks.json"), graph.moonTasks);
  writeJson(path.join(GRAPH_ROOT, "ci-matrix.json"), graph.ciMatrix);
  writeJson(path.join(GRAPH_ROOT, "coverage-expectations.json"), graph.coverageExpectations);
  writeJson(path.join(GRAPH_ROOT, "explain.json"), {
    usage: "tools/graph/graph.mjs explain --path <repo-relative-path>",
    syntheticCases: Object.fromEntries(
      ["affected", "release", "coverage"].map((contract) => [
        contract,
        syntheticContractCases(contract).cases ?? {},
      ]),
    ),
  });
}

function syntheticContractCases(contract) {
  const file = path.join(SYNTHETIC_ROOT, `${contract}.toml`);
  if (!existsSync(file)) {
    fail(`missing synthetic graph fixture: ${rel(file)}`);
  }
  return readToml(file);
}

function assertEqualList(label, actual, expected) {
  const left = sorted(actual ?? []);
  const right = sorted(expected ?? []);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label}: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`);
  }
}

function assertDocsEvidencePathsDoNotSelectBuilderJobs() {
  const forbiddenJobs = new Set([
    ...CI_BUILDER_JOBS,
    "native-extension-lifecycle",
    "native-extension-lifecycle-aggregate",
    "rust-sdk-exact-candidate-consumer",
    "wasix-rust-exact-candidate-consumer",
  ]);
  const paths = [
    "src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json",
    "src/extensions/generated/docs/extension-evidence.json",
    "src/extensions/generated/docs/extensions.json",
  ];
  for (const filePath of paths) {
    const affected = runMoon(["query", "affected", "--upstream", "none", "--downstream", "none"], {
      input: `${filePath}\n`,
    });
    const jobs = planJobsForAffected(
      new Set(triggeringProjectNames(affected.projects)),
      affectedNames(affected.tasks),
    );
    const unexpected = sorted([...jobs].filter((job) => forbiddenJobs.has(job)));
    if (unexpected.length > 0) {
      fail(`${filePath} must not select CI builder jobs, got ${JSON.stringify(unexpected)}`);
    }
  }
}

function assertAffectedProjectTriggerNormalization() {
  const actual = triggeringProjectNames({
    "config-change": { files: ["moon.yml"], tasks: [], other: true },
    "owned-only": { files: ["generated.json"], other: false },
    "task-change": { files: ["source.toml"], tasks: ["task-change:check"], other: false },
  });
  assertEqualList("affected project trigger normalization", actual, ["config-change", "task-change"]);
}

function assertSyntheticCiAffectedCases() {
  const cases = syntheticContractCases("ci-affected").cases;
  if (cases === null || Array.isArray(cases) || typeof cases !== "object") {
    fail("tools/graph/synthetic/ci-affected.toml must define [cases.<id>] tables");
  }
  for (const [caseId, graphCase] of Object.entries(cases)) {
    const filePaths = Array.isArray(graphCase.paths)
      ? graphCase.paths
      : [graphCase.path];
    if (
      filePaths.length === 0
      || filePaths.some((filePath) => typeof filePath !== "string" || filePath.length === 0)
    ) {
      fail(`synthetic CI affected case ${caseId} must define path or non-empty paths`);
    }
    const affected = runMoon(["query", "affected", "--upstream", "none", "--downstream", "none"], {
      input: `${filePaths.join("\n")}\n`,
    });
    const tasks = affectedNames(affected.tasks);
    const jobs = planJobsForAffected(
      new Set(triggeringProjectNames(affected.projects)),
      tasks,
    );
    const required = new Set(graphCase.required_jobs ?? []);
    const forbidden = new Set(graphCase.forbidden_jobs ?? []);
    if (graphCase.forbid_builders === true) {
      for (const job of CI_BUILDER_JOBS) forbidden.add(job);
    }
    const missing = sorted([...required].filter((job) => !jobs.has(job)));
    const unexpected = sorted([...forbidden].filter((job) => jobs.has(job)));
    if (missing.length > 0 || unexpected.length > 0) {
      fail(
        `synthetic CI affected case ${caseId}: missing ${JSON.stringify(missing)}, ` +
          `unexpected ${JSON.stringify(unexpected)}, got ${JSON.stringify(sorted(jobs))}`,
      );
    }
    const nativeTargets = nativeTargetSubsetForJobs(jobs, tasks);
    if (graphCase.expect_all_native_targets === true && nativeTargets !== null) {
      fail(
        `synthetic CI affected case ${caseId}: expected the complete native matrix, `
          + `got ${JSON.stringify(sorted(nativeTargets))}`,
      );
    }
    if (Array.isArray(graphCase.expected_native_targets)) {
      assertEqualList(
        `synthetic CI affected case ${caseId} native targets`,
        nativeTargets === null ? [] : sorted(nativeTargets),
        graphCase.expected_native_targets,
      );
    }
  }
}

function taskConfig(graph, project, taskId) {
  const value = graph.moonTasks?.[project]?.[taskId];
  if (!value) {
    fail(`missing Moon task ${project}:${taskId}`);
  }
  return value;
}

function assertTaskTags(graph, project, taskId, expected) {
  const actual = taskConfig(graph, project, taskId).tags ?? [];
  const missing = expected.filter((tag) => !actual.includes(tag));
  if (missing.length > 0) {
    fail(`${project}:${taskId} tags: missing ${JSON.stringify(sorted(missing))}, got ${JSON.stringify(sorted(actual))}`);
  }
}

function assertDepCacheStrategy(graph, project, taskId, target, expected) {
  const deps = taskConfig(graph, project, taskId).deps ?? [];
  for (const dep of deps) {
    if (dep.target === target) {
      if (dep.cacheStrategy !== expected) {
        fail(`${project}:${taskId} dependency ${target}: expected cacheStrategy=${expected}, got ${dep.cacheStrategy}`);
      }
      return;
    }
  }
  fail(`${project}:${taskId} is missing dependency ${target}`);
}

function checkGraph(graph) {
  const projects = graph.moonProjects;
  const releaseProductsConfig = releaseProducts(releaseGraph());
  const productProjects = releaseProductProjects();

  for (const taskId of ["check", "generate"]) {
    const config = taskConfig(graph, "graph-tools", taskId);
    if (config.cache !== false) {
      fail(
        `graph-tools:${taskId} must remain uncached because it recursively queries Moon `
          + "and validates dynamically declared repository paths",
      );
    }
    const inputs = config.inputs ?? [];
    const normalizedInputs = new Set(inputs.map((input) => input.replace(/^\/+/, "")));
    for (const required of [
      ".gitignore",
      ".moon/tasks/**/*",
      ".prototools",
      "tools/dev/bun.sh",
      "tools/dev/capture-command-output.mjs",
      "tools/dev/moon-command.mjs",
      "tools/release/**/*",
    ]) {
      if (!normalizedInputs.has(required)) {
        fail(`graph-tools:${taskId} must track ${required} as interpreted graph policy`);
      }
    }
  }

  const graphCheckConfig = taskConfig(graph, "graph-tools", "check");
  if (graphCheckConfig.runInCI !== false) {
    fail(
      "graph-tools:check must remain excluded from hosted selection; "
        + "release-tools:check owns that validation",
    );
  }
  if ((graphCheckConfig.outputs ?? []).length !== 0) {
    fail(
      "graph-tools:check must remain read-only; graph-tools:generate is the sole "
        + "graph-output owner",
    );
  }
  const graphGenerateConfig = taskConfig(graph, "graph-tools", "generate");
  if (!(graphGenerateConfig.outputs ?? []).includes("/target/graph/**/*")) {
    fail("graph-tools:generate must own /target/graph/**/*");
  }
  const releaseCheckConfig = taskConfig(graph, "release-tools", "check");
  if (releaseCheckConfig.cache !== false) {
    fail(
      "release-tools:check must remain uncached because it invokes live "
        + "repository-graph validation",
    );
  }

  for (const [product, config] of Object.entries(releaseProductsConfig)) {
    const projectId = productProjects[product];
    const project = projects[projectId];
    if (!project) {
      fail(`release product ${product} does not have an owning Moon project`);
    }
    if (!(project.tags ?? []).includes("release-product")) {
      fail(`release product ${product} Moon project ${projectId} must be tagged release-product`);
    }
    let release = project.project?.metadata?.release;
    if (release === null || Array.isArray(release) || typeof release !== "object") {
      release = project.project?.release;
    }
    if (release === null || Array.isArray(release) || typeof release !== "object") {
      fail(`release product ${product} Moon project ${projectId} must declare project.release metadata`);
    }
    if (release.component !== product) {
      fail(`release product ${product} Moon metadata component mismatch: ${release.component}`);
    }
    if (release.packagePath !== config.path) {
      fail(`release product ${product} Moon metadata packagePath mismatch: ${release.packagePath}`);
    }
  }

  const missingCiTargets = graph.ciMatrix.missingTargets;
  if (Object.keys(missingCiTargets).length > 0) {
    fail(`CI matrix references missing Moon targets: ${JSON.stringify(missingCiTargets)}`);
  }

  assertAffectedProjectTriggerNormalization();
  assertDocsEvidencePathsDoNotSelectBuilderJobs();
  assertSyntheticCiAffectedCases();

  for (const [project, projectTasks] of Object.entries(graph.moonTasks)) {
    for (const [taskId, config] of Object.entries(projectTasks)) {
      if (!config.tags || config.tags.length === 0) {
        fail(`${project}:${taskId} must declare Moon task tags`);
      }
    }
  }

  for (const project of Object.keys(graph.moonProjects)) {
    for (const taskId of ["check", "test"]) {
      if (Object.hasOwn(graph.moonTasks[project] ?? {}, taskId)) {
        let expectedTags;
        if (taskId === "check") {
          expectedTags = ["quality", "static"];
        } else if (project === "liboliphaunt-native") {
          expectedTags = ["quality", "runtime"];
        } else {
          expectedTags = ["quality", "unit"];
        }
        assertTaskTags(graph, project, taskId, expectedTags);
      }
    }
  }

  for (const project of [
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-kotlin",
    "oliphaunt-react-native",
    "oliphaunt-js",
    "oliphaunt-wasix-rust",
  ]) {
    assertTaskTags(graph, project, "coverage", ["coverage", "quality"]);
    assertTaskTags(graph, project, "bench-run", ["bench", "measured"]);
  }

  for (const target of [
    "oliphaunt-rust:coverage",
    "oliphaunt-swift:coverage",
    "oliphaunt-kotlin:coverage",
    "oliphaunt-js:coverage",
    "oliphaunt-react-native:coverage",
    "oliphaunt-wasix-rust:coverage",
  ]) {
    assertDepCacheStrategy(graph, "repo", "coverage", target, "outputs");
  }
  assertDepCacheStrategy(graph, "docs", "smoke", "docs:build", "outputs");
  assertDepCacheStrategy(graph, "docs", "release-check", "docs:build", "outputs");

  for (const [product, config] of Object.entries(graph.coverageExpectations)) {
    if (!config.moonCoverageTask) {
      fail(`coverage baseline product ${product} has no Moon coverage task`);
    }
    if (config.lineThreshold === undefined || config.measuredLineCoverage === undefined) {
      fail(`coverage baseline product ${product} is missing measured threshold data`);
    }
  }

  const affectedCases = syntheticContractCases("affected").cases;
  if (affectedCases === null || Array.isArray(affectedCases) || typeof affectedCases !== "object") {
    fail("tools/graph/synthetic/affected.toml must define [cases.<id>] tables");
  }
  for (const [caseId, graphCase] of Object.entries(affectedCases)) {
    const filePath = graphCase.path;
    if (typeof filePath !== "string") {
      fail(`synthetic affected case ${caseId} is missing path`);
    }
    const explanation = explainPaths([filePath], graph);
    assertEqualList(`${caseId} Moon affected projects`, explanation.paths[0].moonAffectedProjects, graphCase.moon_projects ?? []);
  }

  const releaseCases = syntheticContractCases("release").cases;
  if (releaseCases === null || Array.isArray(releaseCases) || typeof releaseCases !== "object") {
    fail("tools/graph/synthetic/release.toml must define [cases.<id>] tables");
  }
  for (const [caseId, graphCase] of Object.entries(releaseCases)) {
    if (typeof graphCase.path !== "string") {
      fail(`synthetic release case ${caseId} is missing path`);
    }
  }
  const releaseCasePaths = Object.values(releaseCases).map((graphCase) => graphCase.path).filter((item) => typeof item === "string");
  const releaseCasePlans = releasePlansForSinglePaths(releaseCasePaths);
  for (const [caseId, graphCase] of Object.entries(releaseCases)) {
    const filePath = graphCase.path;
    const releaseImpact = releaseCasePlans[filePath];
    assertEqualList(`${caseId} direct release products`, releaseImpact.directProducts, graphCase.direct_products ?? []);
    assertEqualList(`${caseId} release products`, releaseImpact.releaseProducts, graphCase.release_products ?? []);
    if (Object.hasOwn(graphCase, "docs_only") && releaseImpact.docsOnly !== graphCase.docs_only) {
      fail(`${caseId} docsOnly: expected ${graphCase.docs_only}, got ${releaseImpact.docsOnly}`);
    }
  }

  const coverageCases = syntheticContractCases("coverage").cases;
  if (coverageCases === null || Array.isArray(coverageCases) || typeof coverageCases !== "object") {
    fail("tools/graph/synthetic/coverage.toml must define [cases.<id>] tables");
  }
  for (const [caseId, graphCase] of Object.entries(coverageCases)) {
    const filePath = graphCase.path;
    if (typeof filePath !== "string") {
      fail(`synthetic coverage case ${caseId} is missing path`);
    }
    const explanation = explainPaths([filePath], graph);
    assertEqualList(`${caseId} coverage products`, explanation.paths[0].coverageProducts, graphCase.coverage_products ?? []);
  }

  for (const [project, taskId, expectedCache, expectedOutput] of [
    ["graph-tools", "cache-witness", false, null],
    ["graph-tools", "cache-witness-fixture", true, "/target/graph/cache-witness/output.txt"],
  ]) {
    const config = taskConfig(graph, project, taskId);
    if (config.cache !== expectedCache) {
      fail(`${project}:${taskId} cache: expected ${expectedCache}, got ${config.cache}`);
    }
    if (expectedOutput !== null && !(config.outputs ?? []).includes(expectedOutput)) {
      fail(`${project}:${taskId} must declare output ${expectedOutput}`);
    }
  }
}

function printExplanation(explanation, format) {
  if (format === "json") {
    console.log(JSON.stringify(sortedValue(explanation), null, 2));
    return;
  }
  for (const item of explanation.paths) {
    console.log(item.path);
    console.log(`  owner project: ${item.ownerProject ?? "(none)"}`);
    console.log(`  Moon affected: ${item.moonAffectedProjects.join(", ") || "(none)"}`);
    console.log(`  coverage: ${item.coverageProducts.join(", ") || "(none)"}`);
  }
  const plan = explanation.releasePlan;
  console.log(`Release direct products: ${plan.directProducts.join(", ") || "(none)"}`);
  console.log(`Release products: ${plan.releaseProducts.join(", ") || "(none)"}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["generate", "check", "explain"].includes(command)) {
    fail("usage: tools/graph/graph.mjs generate|check|explain [--path <repo-relative-path>] [--format text|json]");
  }
  if (command !== "explain") {
    if (rest.length > 0) {
      fail(`${command} does not accept arguments: ${rest.join(" ")}`);
    }
    return { command };
  }

  const paths = [];
  let format = "text";
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--path") {
      if (index + 1 >= rest.length) {
        fail("--path requires a value");
      }
      paths.push(rest[index + 1]);
      index += 1;
    } else if (value.startsWith("--path=")) {
      paths.push(value.slice("--path=".length));
    } else if (value === "--format") {
      if (index + 1 >= rest.length) {
        fail("--format requires a value");
      }
      format = rest[index + 1];
      index += 1;
    } else if (value.startsWith("--format=")) {
      format = value.slice("--format=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (paths.length === 0) {
    fail("explain requires at least one --path");
  }
  if (!["text", "json"].includes(format)) {
    fail("--format must be text or json");
  }
  return { command, paths, format };
}

function main(argv) {
  const args = parseArgs(argv);
  const graph = buildGraph();
  if (args.command === "generate") {
    writeGraph(graph);
    console.log(`generated graph data in ${rel(GRAPH_ROOT)}`);
  } else if (args.command === "check") {
    checkGraph(graph);
    console.log(`graph checks passed (${Object.keys(graph.moonProjects).length} Moon projects, ${graph.productIds.length} release products)`);
  } else if (args.command === "explain") {
    printExplanation(explainPaths(args.paths, graph), args.format);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
