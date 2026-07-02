#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

const BASE_PRODUCTS = new Set([
  "liboliphaunt-native",
  "liboliphaunt-wasix",
  "oliphaunt-rust",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
  "oliphaunt-swift",
  "oliphaunt-kotlin",
  "oliphaunt-react-native",
  "oliphaunt-js",
  "oliphaunt-wasix-rust",
]);
const CONSUMER_SHAPE_PRODUCTS_FIXTURE = "src/shared/fixtures/consumer-shape/products.json";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort();
}

function formatList(values) {
  return JSON.stringify(sorted(values));
}

function union(...sets) {
  const result = new Set();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function isSubset(left, right) {
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function setEquals(left, right) {
  return left.size === right.size && isSubset(left, right);
}

function bunJson(args) {
  const result = spawnSync("tools/dev/bun.sh", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `tools/dev/bun.sh ${args.join(" ")} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`tools/dev/bun.sh ${args.join(" ")} did not return JSON: ${error.message}`);
  }
}

function stringSet(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${label} must be a JSON string list`);
  }
  return new Set(value);
}

function optionalStringSet(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  return stringSet(value, label);
}

function jsonFlag(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  return JSON.stringify(sorted(value));
}

class CiPlanClient {
  constructor() {
    const config = bunJson(["tools/graph/ci_plan.mjs", "config"]);
    if (!isObject(config)) {
      fail("CI planner config query must return an object");
    }
    this.BASE_JOBS = stringSet(config.baseJobs, "baseJobs");
    this.BUILDER_JOBS = stringSet(config.builderJobs, "builderJobs");
    const targets = config.ciJobTargets;
    if (!isObject(targets)) {
      fail("ciJobTargets must be an object");
    }
    this.CI_JOB_TARGETS = {};
    for (const [job, jobTargets] of Object.entries(targets)) {
      this.CI_JOB_TARGETS[job] = sorted(stringSet(jobTargets, `ciJobTargets.${job}`));
    }
  }

  query(...args) {
    return bunJson(["tools/graph/ci_plan.mjs", ...args]);
  }

  planJobsForAffected(directProjects, tasks) {
    return stringSet(
      this.query(
        "jobs-for-affected",
        "--direct-projects-json",
        jsonFlag(directProjects),
        "--tasks-json",
        jsonFlag(tasks),
      ),
      "jobs-for-affected",
    );
  }

  nativeTargetSubsetForJobs(jobs, tasks) {
    return optionalStringSet(
      this.query(
        "native-target-subset",
        "--jobs-json",
        jsonFlag(jobs),
        "--tasks-json",
        jsonFlag(tasks),
      ),
      "native-target-subset",
    );
  }

  selectedExtensionProductsForPlan(directProjects, tasks, jobs) {
    return optionalStringSet(
      this.query(
        "selected-extension-products",
        "--direct-projects-json",
        jsonFlag(directProjects),
        "--tasks-json",
        jsonFlag(tasks),
        "--jobs-json",
        jsonFlag(jobs),
      ),
      "selected-extension-products",
    );
  }

  planForFullRun({ wasmTarget = "all", nativeTarget = "all", mobileTarget = "all" } = {}) {
    const value = this.query(
      "plan-full",
      "--wasm-target",
      wasmTarget,
      "--native-target",
      nativeTarget,
      "--mobile-target",
      mobileTarget,
    );
    if (!isObject(value)) {
      fail("plan-full must return an object");
    }
    if (typeof value.reason !== "string") {
      fail("plan-full reason must be a string");
    }
    return {
      jobs: stringSet(value.jobs, "plan-full.jobs"),
      projects: stringSet(value.projects, "plan-full.projects"),
      tasks: stringSet(value.tasks, "plan-full.tasks"),
      reason: value.reason,
      selectedTargets: optionalStringSet(value.selectedTargets, "plan-full.selectedTargets"),
    };
  }

  mobileExtensionPackageNativeTargets(jobs, selectedTargets) {
    return sorted(
      stringSet(
        this.query(
          "mobile-extension-package-native-targets",
          "--jobs-json",
          jsonFlag(jobs),
          "--selected-targets-json",
          jsonFlag(selectedTargets),
        ),
        "mobile-extension-package-native-targets",
      ),
    );
  }

  extensionArtifactsNativeMatrix(nativeTarget, selectedTargets, selectedProducts = null) {
    const value = this.query(
      "matrix",
      "extension-artifacts-native",
      "--native-target",
      nativeTarget,
      "--selected-targets-json",
      jsonFlag(selectedTargets),
      "--selected-products-json",
      jsonFlag(selectedProducts),
    );
    if (!isObject(value)) {
      fail("extension-artifacts-native matrix must be an object");
    }
    return value;
  }

  extensionArtifactsWasixMatrix(wasmTarget, selectedProducts = null) {
    const value = this.query(
      "matrix",
      "extension-artifacts-wasix",
      "--wasm-target",
      wasmTarget,
      "--selected-products-json",
      jsonFlag(selectedProducts),
    );
    if (!isObject(value)) {
      fail("extension-artifacts-wasix matrix must be an object");
    }
    return value;
  }
}

const ciPlan = new CiPlanClient();

function readText(repoPath) {
  return readFileSync(path.join(ROOT, repoPath), "utf8");
}

function assertDirectReleasePythonToolsAreExecutable(releaseScript) {
  const directInvocations = new Set();
  for (const match of releaseScript.matchAll(/\[\s*"([^"]+\.py)"/gm)) {
    if (match[1].startsWith("tools/release/")) {
      directInvocations.add(match[1]);
    }
  }
  for (const tool of sorted(directInvocations)) {
    const file = path.join(ROOT, tool);
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`directly invoked release tool does not exist: ${tool}`);
    }
    if ((statSync(file).mode & 0o111) === 0) {
      fail(`directly invoked release tool must be executable or called through python3: ${tool}`);
    }
  }
}

function readToml(repoPath) {
  const file = path.isAbsolute(repoPath) ? repoPath : path.join(ROOT, repoPath);
  const value = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (!isObject(value)) {
    fail(`${path.relative(ROOT, file)} must contain a TOML table`);
  }
  return value;
}

function releaseGraph() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "graph"]);
  if (!isObject(value)) {
    fail("release graph query did not return an object");
  }
  return value;
}

function releaseProductProjects() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "product-projects"]);
  if (!isObject(value) || !Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string")) {
    fail("release graph product-project query did not return a string map");
  }
  return value;
}

function releaseProductConfigs() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "product-configs"]);
  if (!Array.isArray(value) || !value.every(isObject)) {
    fail("release graph product-configs query did not return an object list");
  }
  const rows = {};
  for (const row of value) {
    const product = row.product;
    const configId = row.id;
    if (typeof product !== "string" || product.length === 0) {
      fail("release graph product-configs rows must declare non-empty products");
    }
    if (rows[product] !== undefined) {
      fail(`release graph product-configs query returned duplicate product ${product}`);
    }
    if (configId !== product) {
      fail(`release graph product-configs ${product}.id must match the product id`);
    }
    for (const key of ["kind", "owner", "path", "changelog_path", "tag_prefix"]) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        fail(`release graph product-configs ${product}.${key} must be a non-empty string`);
      }
    }
    for (const key of ["publish_targets", "release_artifacts", "version_files"]) {
      if (!Array.isArray(row[key]) || row[key].length === 0 || !row[key].every((item) => typeof item === "string" && item.length > 0)) {
        fail(`release graph product-configs ${product}.${key} must be a non-empty string list`);
      }
    }
    rows[product] = row;
  }
  if (Object.keys(rows).length === 0) {
    fail("release graph returned no product configs");
  }
  return rows;
}

function moonProjectRows() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "moon-projects"]);
  if (!Array.isArray(value) || !value.every(isObject)) {
    fail("release graph moon-projects query did not return an object list");
  }
  const rows = {};
  for (const row of value) {
    const projectId = row.id;
    if (typeof projectId !== "string" || projectId.length === 0) {
      fail("release graph moon-projects rows must declare non-empty ids");
    }
    if (rows[projectId] !== undefined) {
      fail(`release graph moon-projects query returned duplicate project ${projectId}`);
    }
    const tags = row.tags;
    const dependencyScopes = row.dependencyScopes;
    if (!Array.isArray(tags) || !tags.every((item) => typeof item === "string")) {
      fail(`release graph moon-projects ${projectId}.tags must be a string list`);
    }
    if (!isObject(dependencyScopes) || !Object.entries(dependencyScopes).every(([key, item]) => typeof key === "string" && typeof item === "string")) {
      fail(`release graph moon-projects ${projectId}.dependencyScopes must be a string map`);
    }
    rows[projectId] = row;
  }
  return rows;
}

function extensionMetadataRows() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "extension-metadata"]);
  if (!Array.isArray(value) || !value.every(isObject)) {
    fail("release graph extension-metadata query did not return an object list");
  }
  const rows = {};
  for (const row of value) {
    const product = row.product;
    if (typeof product !== "string" || product.length === 0) {
      fail("release graph extension-metadata rows must declare non-empty products");
    }
    if (rows[product] !== undefined) {
      fail(`release graph extension-metadata query returned duplicate product ${product}`);
    }
    for (const key of ["sqlName", "class", "versioning", "sourcePath"]) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        fail(`release graph extension-metadata ${product}.${key} must be a non-empty string`);
      }
    }
    if (!isObject(row.compatibility)) {
      fail(`release graph extension-metadata ${product}.compatibility must be an object`);
    }
    rows[product] = row;
  }
  if (Object.keys(rows).length === 0) {
    fail("release graph returned no extension metadata rows");
  }
  return rows;
}

function extensionProductIds() {
  return Object.keys(extensionMetadataRows()).sort();
}

function runtimeTiedProducts() {
  const value = bunJson(["tools/release/release_graph_query.mjs", "runtime-tied-products"]);
  if (!Array.isArray(value) || !value.every(isObject)) {
    fail("release graph runtime-tied-products query did not return an object list");
  }
  const products = new Set();
  for (const row of value) {
    if (row.group !== "liboliphaunt-runtime" || typeof row.product !== "string" || row.product.length === 0) {
      fail(`release graph runtime-tied-products returned invalid row ${JSON.stringify(row)}`);
    }
    products.add(row.product);
  }
  if (!products.has("liboliphaunt-native") || !products.has("liboliphaunt-wasix")) {
    fail("runtime-tied products must include both liboliphaunt runtimes");
  }
  return products;
}

function artifactTargetRows({ product, kind, publishedOnly }) {
  const args = [
    "tools/release/release_graph_query.mjs",
    "artifact-targets",
    "--product",
    product,
    "--kind",
    kind,
  ];
  if (publishedOnly) {
    args.push("--published-only");
  }
  const value = bunJson(args);
  if (!Array.isArray(value) || !value.every(isObject)) {
    fail("release graph artifact-targets query did not return an object list");
  }
  for (const row of value) {
    const targetId = row.id;
    if (typeof targetId !== "string" || targetId.length === 0) {
      fail("release graph artifact-targets rows must declare non-empty ids");
    }
    if (row.product !== product || row.kind !== kind) {
      fail(`release graph artifact-targets returned unexpected row ${targetId}`);
    }
    if (typeof row.target !== "string" || row.target.length === 0) {
      fail(`release graph artifact-targets ${targetId}.target must be a non-empty string`);
    }
    if (typeof (row.extension_artifacts ?? true) !== "boolean") {
      fail(`release graph artifact-targets ${targetId}.extension_artifacts must be true or false`);
    }
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
  if (!isObject(value) || !Object.entries(value).every(([key, item]) => typeof key === "string" && isObject(item))) {
    fail("release graph plans-for-paths query did not return a plan map");
  }
  return value;
}

function extensionProductId(sqlName) {
  return `oliphaunt-extension-${sqlName.replaceAll("_", "-").toLowerCase()}`;
}

function expectedExtensionProductsFromSdkCatalog() {
  const data = JSON.parse(readText("src/extensions/generated/sdk/rust.json"));
  const rows = data.extensions;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail("generated Rust extension catalog must define public extensions");
  }
  const products = new Set();
  for (const row of rows) {
    if (!isObject(row)) {
      fail("generated Rust extension catalog rows must be objects");
    }
    const sqlName = row["sql-name"];
    if (typeof sqlName !== "string" || sqlName.length === 0) {
      fail("generated Rust extension catalog rows must declare sql-name");
    }
    products.add(extensionProductId(sqlName));
  }
  return products;
}

function expectedContribExtensionProductsFromManifest() {
  const data = readToml("src/extensions/contrib/postgres18.toml");
  const rows = data.extensions;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail("PostgreSQL contrib extension manifest must define extension rows");
  }
  const products = new Set();
  for (const row of rows) {
    if (!isObject(row)) {
      fail("PostgreSQL contrib extension manifest rows must be tables");
    }
    const sqlName = row["sql-name"];
    if (typeof sqlName !== "string" || sqlName.length === 0) {
      fail("PostgreSQL contrib extension manifest rows must declare sql-name");
    }
    products.add(extensionProductId(sqlName));
  }
  return products;
}

function expectedProducts() {
  return union(BASE_PRODUCTS, expectedExtensionProductsFromSdkCatalog());
}

function projectReleaseMetadata(project) {
  return isObject(project.release) ? project.release : null;
}

function projectDependencyScopes(project) {
  return isObject(project.dependencyScopes) ? { ...project.dependencyScopes } : {};
}

function assertNoFile(repoPath) {
  if (existsSync(path.join(ROOT, repoPath))) {
    fail(`${repoPath} must not exist; Moon is the only dependency/affectedness graph`);
  }
}

function assertContains(repoPath, snippet, message) {
  if (!readText(repoPath).includes(snippet)) {
    fail(message);
  }
}

function assertNotContains(repoPath, snippet, message) {
  if (readText(repoPath).includes(snippet)) {
    fail(message);
  }
}

function workflowJobBlocks(repoPath) {
  const text = readText(repoPath);
  const jobsSection = text.includes("\njobs:\n") ? text.split("\njobs:\n", 2)[1] : "";
  if (!jobsSection) {
    fail(`${repoPath} must declare a jobs section`);
  }
  const matches = [...jobsSection.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];
  if (matches.length === 0) {
    fail(`${repoPath} parser found no jobs`);
  }
  const blocks = {};
  for (const [index, match] of matches.entries()) {
    const end = index + 1 < matches.length ? matches[index + 1].index : jobsSection.length;
    blocks[match[1]] = jobsSection.slice(match.index, end);
  }
  return blocks;
}

function workflowStepBlocks(jobBlock) {
  const matches = [...jobBlock.matchAll(/^      - name: (.+)\n/gm)];
  const blocks = {};
  for (const [index, match] of matches.entries()) {
    const end = index + 1 < matches.length ? matches[index + 1].index : jobBlock.length;
    blocks[match[1].trim()] = jobBlock.slice(match.index, end);
  }
  return blocks;
}

function workflowJobNeeds(blocks, job) {
  const block = blocks[job];
  if (block === undefined) {
    fail(`CI workflow is missing job ${job}`);
  }
  const match = block.match(/^    needs:\n(?<body>(?:      - [A-Za-z0-9_-]+\n)+)/ms);
  if (match === null) {
    return new Set();
  }
  return new Set(
    match.groups.body
      .split(/\r?\n/u)
      .map((line) => line.replace(/^      - /u, "").trim())
      .filter(Boolean),
  );
}

function assertJobContains(blocks, job, snippet, message) {
  const block = blocks[job];
  if (block === undefined) {
    fail(`CI workflow is missing job ${job}`);
  }
  if (!block.includes(snippet)) {
    fail(message);
  }
}

function assertStepContains(steps, step, snippet, message) {
  const block = steps[step];
  if (block === undefined) {
    fail(`workflow is missing step ${JSON.stringify(step)}`);
  }
  if (!block.includes(snippet)) {
    fail(message);
  }
}

function assertStepIfContainsPublishGuard(steps, step) {
  const block = steps[step];
  if (block === undefined) {
    fail(`workflow is missing step ${JSON.stringify(step)}`);
  }
  if (!block.includes("inputs.operation == 'publish'")) {
    fail(`${JSON.stringify(step)} must be guarded by inputs.operation == 'publish'`);
  }
}

function normalizedShell(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function assertTextOrder(text, snippets, message) {
  let index = -1;
  for (const snippet of snippets) {
    const nextIndex = text.indexOf(snippet, index + 1);
    if (nextIndex === -1) {
      fail(`${message}: missing ${JSON.stringify(snippet)}`);
    }
    index = nextIndex;
  }
}

function checkReleaseMetadata() {
  const products = releaseProductConfigs();
  if (!setEquals(new Set(Object.keys(products)), expectedProducts())) {
    fail(`release product set mismatch: expected ${formatList(expectedProducts())}, got ${formatList(Object.keys(products))}`);
  }
  const extensionMetadata = extensionMetadataRows();
  const modeledExtensionProducts = new Set(extensionProductIds());
  const expectedExtensionProducts = expectedExtensionProductsFromSdkCatalog();
  if (!setEquals(modeledExtensionProducts, expectedExtensionProducts)) {
    fail(
      "exact-extension release products must match the public generated extension catalog: " +
        `expected ${formatList(expectedExtensionProducts)}, got ${formatList(modeledExtensionProducts)}`,
    );
  }

  const projects = moonProjectRows();
  const productProjects = releaseProductProjects();
  for (const [product, config] of Object.entries(products)) {
    const releasePath = path.join(ROOT, config.path, "release.toml");
    const raw = readToml(releasePath);
    for (const forbidden of ["depends_on", "source_globs", "package_visible_globs"]) {
      if (Object.prototype.hasOwnProperty.call(raw, forbidden)) {
        fail(`${path.relative(ROOT, releasePath)} must not declare ${forbidden}; Moon owns graph shape`);
      }
    }
    for (const key of ["id", "owner", "kind", "publish_targets", "release_artifacts"]) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) {
        fail(`${path.relative(ROOT, releasePath)} must declare ${key}`);
      }
    }
    if (!config.tag_prefix || !config.version_files || !config.changelog_path) {
      fail(`${product} must have release-please tag/version/changelog metadata`);
    }

    const projectId = productProjects[product];
    const project = projects[projectId];
    if (project === undefined) {
      fail(`${product} has no owning Moon project`);
    }
    const tags = new Set(project.tags ?? []);
    if (!tags.has("release-product")) {
      fail(`${projectId} must be tagged release-product`);
    }
    const release = projectReleaseMetadata(project);
    if (release === null) {
      fail(`${projectId} must declare project.release metadata`);
    }
    if (release.component !== product) {
      fail(`${projectId} release component expected ${product}, got ${release.component}`);
    }
    if (release.packagePath !== config.path) {
      fail(`${projectId} packagePath expected ${config.path}, got ${release.packagePath}`);
    }
    if (config.kind === "exact-extension-artifact") {
      const extension = extensionMetadata[product];
      if (extension === undefined) {
        fail(`${product} exact-extension product is missing release graph extension metadata`);
      }
      if (project.layer !== "library") {
        fail(`${projectId} must be a library layer project; exact extension artifacts are publishable runtime-compatible products`);
      }
      const scopes = projectDependencyScopes(project);
      if (scopes["extension-runtime-contract"] !== "production") {
        fail(`${projectId} must declare a production Moon dependency on extension-runtime-contract`);
      }
      const expectedRuntimeScope = extension.class === "external" ? "build" : "production";
      for (const dependency of ["liboliphaunt-native", "liboliphaunt-wasix"]) {
        if (scopes[dependency] !== expectedRuntimeScope) {
          fail(`${projectId} must declare a ${expectedRuntimeScope} Moon dependency on ${dependency}`);
        }
      }
    }
  }

  const extensionModel = projects["extension-model"];
  if (extensionModel === undefined) {
    fail("extension-model project is missing");
  }
  if (Object.prototype.hasOwnProperty.call(projectDependencyScopes(extensionModel), "extensions")) {
    fail("extension-model must not depend on the aggregate extensions project; exact extension runtime deps must remain acyclic");
  }
}

function checkReleasePlanning() {
  const allExtensionProducts = expectedExtensionProductsFromSdkCatalog();
  const contribExtensionProducts = expectedContribExtensionProductsFromManifest();
  const runtimeTiedReleaseProducts = runtimeTiedProducts();
  const containsCases = new Map([
    ["src/shared/js-core/src/query.ts", new Set(["oliphaunt-js", "oliphaunt-react-native"])],
    [
      "src/postgres/versions/18/source.toml",
      union(
        new Set([
          "liboliphaunt-native",
          "liboliphaunt-wasix",
          "oliphaunt-rust",
          "oliphaunt-swift",
          "oliphaunt-kotlin",
          "oliphaunt-react-native",
          "oliphaunt-js",
          "oliphaunt-wasix-rust",
        ]),
        contribExtensionProducts,
      ),
    ],
    ["src/extensions/contrib/postgres18.toml", runtimeTiedReleaseProducts],
    [
      "src/shared/extension-runtime-contract/contract.toml",
      union(new Set(["liboliphaunt-native", "liboliphaunt-wasix"]), allExtensionProducts),
    ],
    ["src/runtimes/liboliphaunt/native/VERSION", runtimeTiedReleaseProducts],
    ["src/runtimes/liboliphaunt/wasix/VERSION", runtimeTiedReleaseProducts],
  ]);
  const exactCases = new Map([
    ["src/extensions/contrib/amcheck/release.toml", runtimeTiedReleaseProducts],
    ["src/extensions/external/vector/source.toml", new Set(["oliphaunt-extension-vector"])],
    ["src/shared/fixtures/protocol/query-response-cases.json", new Set()],
    ["docs/maintainers/release.md", new Set()],
  ]);
  const plans = releasePlansForSinglePaths(sorted(new Set([...containsCases.keys(), ...exactCases.keys()])));
  for (const [repoPath, expected] of containsCases.entries()) {
    const actual = new Set(plans[repoPath]?.releaseProducts ?? []);
    if (!isSubset(expected, actual)) {
      fail(`${repoPath} release plan expected at least ${formatList(expected)}, got ${formatList(actual)}`);
    }
  }
  for (const [repoPath, expected] of exactCases.entries()) {
    const actual = new Set(plans[repoPath]?.releaseProducts ?? []);
    if (!setEquals(actual, expected)) {
      fail(`${repoPath} release plan expected exactly ${formatList(expected)}, got ${formatList(actual)}`);
    }
  }
}

function checkCiPolicy() {
  assertNoFile("tools/graph/jobs.toml");
  assertNoFile("tools/release/release-inputs.toml");
  const ci = readText(".github/workflows/ci.yml");
  for (const forbidden of ["targets=(", "tools/graph/jobs.toml", "tools/release/release-inputs.toml"]) {
    if (ci.includes(forbidden)) {
      fail(`CI workflow must not contain ${forbidden}`);
    }
  }
  assertContains("tools/graph/ci_plan.mjs", "moon([\"query\", \"tasks\"])", "CI planner must read Moon task tags");
  assertContains("tools/graph/ci_plan.mjs", "ci-<job-id>", "CI planner must document ci-* task tags");
  assertContains(
    "tools/graph/ci_plan.mjs",
    "extension_package_products_csv",
    "CI planner must emit selected exact-extension products for artifact package builders",
  );
  assertContains(
    ".github/workflows/ci.yml",
    "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS",
    "CI extension package builders must consume selected exact-extension products from the affected plan",
  );
  assertContains(
    "tools/release/build-extension-ci-artifacts.mjs",
    "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS",
    "exact-extension package builder must support selected product subsets",
  );
  assertContains(
    ".github/scripts/select-planned-moon-targets.mjs",
    "OLIPHAUNT_CI_JOB_TARGETS_JSON",
    "CI product jobs must consume planned Moon targets through the Bun selector",
  );
  if (Object.keys(ciPlan.CI_JOB_TARGETS).length === 0) {
    fail("CI planner found no Moon ci-* task tags");
  }
  if (ciPlan.BUILDER_JOBS.has("liboliphaunt-wasix-aot-targets")) {
    fail("builder_jobs must contain artifact-producing jobs, not the WASIX AOT target planner");
  }

  const workflowBlocks = workflowJobBlocks(".github/workflows/ci.yml");
  const workflowJobs = new Set(Object.keys(workflowBlocks));
  if (workflowJobs.size === 0) {
    fail("CI workflow parser found no jobs");
  }
  const moonJobs = new Set(Object.keys(ciPlan.CI_JOB_TARGETS));
  const builderMoonJobs = intersection(moonJobs, ciPlan.BUILDER_JOBS);
  const noMoonTargetJobs = new Set([
    "affected",
    "check-targets",
    "policy-targets",
    "release-intent",
    "checks",
    "test-targets",
    "tests",
    "builds",
    "mobile-e2e-android",
    "mobile-e2e-ios",
    "e2e",
    "required",
  ]);
  const allowedWorkflowJobs = union(builderMoonJobs, noMoonTargetJobs);
  const missingWorkflowJobs = sorted(difference(ciPlan.BUILDER_JOBS, workflowJobs));
  if (missingWorkflowJobs.length > 0) {
    fail(`builder Moon ci-* tags have no CI workflow job: ${JSON.stringify(missingWorkflowJobs)}`);
  }
  const untaggedWorkflowJobs = sorted(difference(workflowJobs, allowedWorkflowJobs));
  if (untaggedWorkflowJobs.length > 0) {
    fail(`CI workflow must only define phase gates, builder jobs, and aggregate exceptions: ${JSON.stringify(untaggedWorkflowJobs)}`);
  }
  const nonBuilderWorkflowJobs = sorted(intersection(difference(moonJobs, ciPlan.BUILDER_JOBS), workflowJobs));
  if (nonBuilderWorkflowJobs.length > 0) {
    fail(`CI workflow must not define non-builder Moon jobs as dedicated artifact build jobs: ${JSON.stringify(nonBuilderWorkflowJobs)}`);
  }

  const requiredMatch = ci.match(/^  required:\n.*?^    needs:\n(?<body>(?:      - [A-Za-z0-9_-]+\n)+)/ms);
  if (requiredMatch === null) {
    fail("CI workflow required job must declare a static needs list");
  }
  const requiredNeeds = new Set(
    requiredMatch.groups.body
      .split(/\r?\n/u)
      .map((line) => line.replace(/^      - /u, "").trim())
      .filter(Boolean),
  );
  const expectedRequiredNeeds = new Set(["affected", "release-intent", "checks", "tests", "builds", "e2e"]);
  if (!setEquals(requiredNeeds, expectedRequiredNeeds)) {
    fail(
      "required.needs must be the CI phase gates only: " +
        "['affected', 'release-intent', 'checks', 'tests', 'builds', 'e2e']; " +
        `got ${formatList(requiredNeeds)}`,
    );
  }

  const buildsMatch = ci.match(/^  builds:\n.*?^    needs:\n(?<body>(?:      - [A-Za-z0-9_-]+\n)+)/ms);
  if (buildsMatch === null) {
    fail("CI workflow builds job must declare a static needs list");
  }
  const buildsNeeds = new Set(
    buildsMatch.groups.body
      .split(/\r?\n/u)
      .map((line) => line.replace(/^      - /u, "").trim())
      .filter(Boolean),
  );
  const missingBuilders = sorted(difference(ciPlan.BUILDER_JOBS, buildsNeeds));
  if (missingBuilders.length > 0) {
    fail(`builds.needs is missing builder jobs: ${JSON.stringify(missingBuilders)}`);
  }
  if (buildsNeeds.has("tests")) {
    fail("builds.needs must not include the global Tests job; artifact builders must only wait on real artifact producers");
  }

  const plannedJobInvocations = new Set([...ci.matchAll(/run-planned-moon-job[.]sh ([A-Za-z0-9_-]+)/g)].map((match) => match[1]));
  const missingPlannedInvocations = sorted(difference(builderMoonJobs, plannedJobInvocations));
  if (missingPlannedInvocations.length > 0) {
    fail(`builder workflow jobs do not consume planned Moon targets: ${JSON.stringify(missingPlannedInvocations)}`);
  }
  for (const [index, line] of ci.split(/\r?\n/u).entries()) {
    const match = line.match(/run-planned-moon-job[.]sh ([A-Za-z0-9_-]+)/);
    if (match === null) {
      continue;
    }
    const job = match[1];
    if (ciPlan.BUILDER_JOBS.has(job) && !line.includes("MOON_CACHE=off")) {
      fail(`builder job ${job} must disable Moon cache in CI at .github/workflows/ci.yml:${index + 1}`);
    }
    const artifactConsumerJobs = new Set([
      "extension-artifacts-wasix",
      "extension-packages",
      "mobile-extension-packages",
      "liboliphaunt-native-release-assets",
      "liboliphaunt-wasix-aot",
      "liboliphaunt-wasix-release-assets",
      "mobile-build-android",
      "mobile-build-ios",
    ]);
    if (artifactConsumerJobs.has(job) && !line.includes("OLIPHAUNT_MOON_UPSTREAM=none")) {
      fail(
        `artifact consumer job ${job} must not re-run upstream Moon artifact producers in CI at .github/workflows/ci.yml:${index + 1}`,
      );
    }
    if (difference(ciPlan.BUILDER_JOBS, artifactConsumerJobs).has(job) && line.includes("OLIPHAUNT_MOON_UPSTREAM=none")) {
      fail(`builder job ${job} must allow Moon upstream task inheritance in CI at .github/workflows/ci.yml:${index + 1}`);
    }
  }

  const expectedMobileBuildNeeds = {
    "mobile-build-android": new Set([
      "affected",
      "mobile-extension-packages",
      "liboliphaunt-native-android",
      "kotlin-sdk-package",
      "react-native-sdk-package",
    ]),
    "mobile-build-ios": new Set([
      "affected",
      "mobile-extension-packages",
      "liboliphaunt-native-ios",
      "react-native-sdk-package",
      "swift-sdk-package",
    ]),
  };
  for (const [job, expected] of Object.entries(expectedMobileBuildNeeds)) {
    const actual = workflowJobNeeds(workflowBlocks, job);
    if (!setEquals(actual, expected)) {
      fail(`${job}.needs must consume staged runtime, SDK, and exact-extension builders: expected ${formatList(expected)}, got ${formatList(actual)}`);
    }
    for (const snippet of [
      'OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS: "0"',
      'OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS: "1"',
      'OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS: "1"',
      "OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT:",
      "oliphaunt-mobile-extension-package-artifacts",
      "--require-mobile-prebuilt-extensions",
    ]) {
      assertJobContains(workflowBlocks, job, snippet, `${job} must use staged SDK/runtime/exact-extension artifacts and reject source-build fallbacks`);
    }
  }
  assertJobContains(
    workflowBlocks,
    "mobile-build-android",
    "OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE: release",
    "Android mobile app builder must publish the same release-mode artifact that installed-app E2E consumes",
  );
  assertJobContains(
    workflowBlocks,
    "mobile-build-ios",
    "OLIPHAUNT_EXPO_IOS_CONFIGURATION: Release",
    "iOS mobile app builder must publish the same release-mode artifact that installed-app E2E consumes",
  );
  assertJobContains(
    workflowBlocks,
    "mobile-build-ios",
    "OLIPHAUNT_EXPO_IOS_SDK: iphonesimulator",
    "iOS mobile app builder must publish a simulator artifact for free installed-app E2E",
  );
  assertJobContains(
    workflowBlocks,
    "mobile-e2e-ios",
    'MAESTRO_DRIVER_STARTUP_TIMEOUT: "300000"',
    "iOS installed-app E2E must give Maestro's XCTest driver enough startup time on macOS runners",
  );

  const androidBuild = workflowBlocks["mobile-build-android"];
  for (const snippet of [
    "matrix: ${{ fromJson(needs.affected.outputs.react_native_android_mobile_app_matrix) }}",
    "liboliphaunt-native-target-${{ matrix.target }}",
    "OLIPHAUNT_EXPO_ANDROID_ABI: ${{ matrix.abi }}",
    "oliphaunt-kotlin-sdk-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
    "react-native-mobile-android-app-${{ matrix.target }}",
  ]) {
    if (!androidBuild.includes(snippet)) {
      fail(`mobile-build-android must download/upload ${snippet}`);
    }
  }
  for (const [repoPath, snippet, message] of [
    [
      "src/sdks/react-native/android/build.gradle",
      "OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE",
      "React Native Android Gradle packaging must pass static-extension link evidence into CMake",
    ],
    [
      "src/sdks/react-native/android/src/main/cpp/CMakeLists.txt",
      "oliphaunt-android-static-extension-link-v1",
      "React Native Android CMake packaging must emit deterministic static-extension link evidence",
    ],
    [
      "src/sdks/react-native/tools/expo-android-runner.sh",
      "androidLinkEvidence",
      "React Native Android mobile build reports must include static-extension link evidence",
    ],
    [
      "tools/release/check-staged-artifacts.mjs",
      "checkAndroidPrebuiltExtensionLinkage",
      "staged mobile artifact checks must validate Android static-extension link evidence",
    ],
  ]) {
    if (!readText(repoPath).includes(snippet)) {
      fail(message);
    }
  }

  const iosBuild = workflowBlocks["mobile-build-ios"];
  for (const snippet of [
    "liboliphaunt-native-target-ios-xcframework",
    "oliphaunt-swift-sdk-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
    "react-native-mobile-ios-app",
  ]) {
    if (!iosBuild.includes(snippet)) {
      fail(`mobile-build-ios must download/upload ${snippet}`);
    }
  }

  const wasixExtensionPackager = readText("src/extensions/artifacts/wasix/tools/package-release-assets.sh");
  if (wasixExtensionPackager.includes("--strict-generated")) {
    fail("WASIX exact-extension packaging must consume portable runtime outputs; strict generation checks belong to the portable runtime builder");
  }
  const wasixCargoPackager = readText("tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs");
  for (const forbidden of [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "--use-compress-program",
  ]) {
    if (wasixCargoPackager.includes(forbidden)) {
      fail(`WASIX Cargo artifact packager must not depend on GNU tar-only option ${forbidden}`);
    }
  }
  assertContains(
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
    'printf \'%s\\n\' "BE_DLLLIBS=$be_dllibs"',
    "macOS embedded extension link helper must override Darwin's default backend bundle loader",
  );
  assertContains(
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
    'macos_embedded_module_link_args "$embedded_pg_ldflags" "$embedded_module_be_dllibs"',
    "macOS embedded contrib extension builds must not fall back to src/backend/postgres as bundle loader",
  );
  assertContains(
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
    'macos_embedded_module_link_args "$link_flags" "$be_dllibs"',
    "macOS embedded PGXS extension builds must share the embedded module link helper",
  );

  const mobileE2e = readText(".github/workflows/mobile-e2e.yml");
  for (const snippet of [
    "name: E2E",
    'workflows: ["CI"]',
    "BUILD_GATE_JOB: Builds",
    'bun .github/scripts/resolve-mobile-e2e.mjs',
    'bun .github/scripts/check-ci-gate.mjs allow-skipped',
    "react-native-mobile-android-app-android-x86_64",
    "react-native-mobile-ios-app",
    "uses: ./.github/actions/setup-maestro",
    "tools/dev/start-android-emulator-ci.sh",
    "bash src/sdks/react-native/tools/mobile-e2e.sh android",
    "bash src/sdks/react-native/tools/mobile-e2e.sh ios",
    "OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE: release",
    "OLIPHAUNT_EXPO_IOS_CONFIGURATION: Release",
    "OLIPHAUNT_EXPO_IOS_SDK: iphonesimulator",
    'MAESTRO_DRIVER_STARTUP_TIMEOUT: "300000"',
  ]) {
    if (!mobileE2e.includes(snippet)) {
      fail(`E2E workflow must consume built app artifacts with pinned installed-app tooling: missing ${snippet}`);
    }
  }
  for (const forbidden of [
    "run-planned-moon-job.sh",
    "mobile-build:android",
    "mobile-build:ios",
    "tools/mobile-build.sh",
    "OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS",
  ]) {
    if (mobileE2e.includes(forbidden)) {
      fail(`E2E workflow must not rebuild source artifacts or invoke builder tasks: ${forbidden}`);
    }
  }

  const releaseWorkflowBlocks = workflowJobBlocks(".github/workflows/release.yml");
  const releaseToolPatterns = [
    "tools/release/release.py",
    "tools/release/release-check.mjs",
    "tools/release/release-check-registries.mjs",
    "tools/release/release-consumer-shape.mjs",
    "tools/release/release-verify.mjs",
    "tools/release/artifact_target_matrix.mjs",
  ];
  const missingMoonSetup = sorted(
    Object.entries(releaseWorkflowBlocks)
      .filter(([, block]) => releaseToolPatterns.some((pattern) => block.includes(pattern)) && !block.includes("./.github/actions/setup-moon"))
      .map(([job]) => job),
  );
  if (missingMoonSetup.length > 0) {
    fail(`release workflow jobs invoke release metadata without setup-moon: ${JSON.stringify(missingMoonSetup)}`);
  }

  if (!existsSync(path.join(ROOT, CONSUMER_SHAPE_PRODUCTS_FIXTURE))) {
    fail(`missing consumer shape fixture: ${CONSUMER_SHAPE_PRODUCTS_FIXTURE}`);
  }
  assertContains(
    "tools/release/release-check.mjs",
    "check_release_pr_coverage.mjs",
    "release checks must verify release-please version bumps cover Moon-selected products through the Bun release-check orchestrator",
  );
  assertContains(
    ".github/scripts/check-release-intent.sh",
    "src/sdks/swift=0.0.0 -> 0.5.0",
    "release intent checks must allow only the documented SwiftPM bootstrap manifest seed",
  );
  for (const repoPath of [
    ".github/workflows/release.yml",
    "tools/release/release.py",
    "tools/release/upload_github_release_assets.mjs",
  ]) {
    assertNotContains(
      repoPath,
      "replace_conflicting_assets",
      "GitHub release asset replacement must stay a manual repair, not a release workflow switch",
    );
    assertNotContains(
      repoPath,
      "replace-conflicting-assets",
      "GitHub release asset replacement must stay a manual repair, not a release CLI switch",
    );
  }
  assertNotContains("tools/release/upload_github_release_assets.mjs", "--clobber", "GitHub release asset upload must not overwrite existing assets");
  assertContains(
    "tools/release/upload_github_release_assets.mjs",
    "delete the conflicting GitHub release asset manually",
    "GitHub release asset byte conflicts must fail with manual repair guidance",
  );
}

function checkReleaseWorkflowPolicy() {
  const releaseBlocks = workflowJobBlocks(".github/workflows/release.yml");
  const publishBlock = releaseBlocks.publish;
  if (publishBlock === undefined) {
    fail("Release workflow must define a publish job");
  }
  const publishSteps = workflowStepBlocks(publishBlock);

  for (const permission of ["actions: read", "attestations: write", "contents: write", "id-token: write", "issues: write", "pull-requests: write"]) {
    if (!publishBlock.includes(permission)) {
      fail(`Release publish job must declare ${permission}`);
    }
  }
  const releaseWorkflow = readText(".github/workflows/release.yml");
  for (const snippet of [
    "release_commit:",
    ".github/scripts/resolve-release-head.sh",
    "id: release_head",
    "RELEASE_HEAD_SHA",
    "Create release-please target branch",
    "target-branch: ${{ steps.release_head.outputs.target_branch }}",
    "Remove release-please target branch",
    "release_plan_args=(",
    "--from-product-tags",
    "--include-current-tags",
    '--head-ref "$RELEASE_HEAD_SHA"',
    "--format github-output",
    "--include-current-version-tags",
    'tools/dev/bun.sh tools/release/release_plan.mjs "${release_plan_args[@]}"',
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      fail(`Release workflow must resolve and publish from an explicit release commit: missing ${JSON.stringify(snippet)}`);
    }
  }
  if (releaseWorkflow.includes("tools/release/release.py plan")) {
    fail("Release workflow must call the Bun release plan entrypoint directly");
  }
  for (const legacyReleaseQuery of ["tools/release/release.py ci-products", "tools/release/release.py ci-artifacts"]) {
    if (releaseWorkflow.includes(legacyReleaseQuery)) {
      fail("Release workflow must call Bun release graph queries for CI artifact handoffs");
    }
  }

  assertTextOrder(
    publishBlock,
    [
      "Resolve release commit",
      "Plan product releases",
      "Require release-commit CI build gate",
      "Download WASIX runtime build artifacts",
      "Download WASIX release assets",
      "Download exact-extension package artifacts",
      "Download SDK package artifacts",
      "Download liboliphaunt release assets",
      "Install TypeScript release tooling",
      "Download native helper release assets",
      "Download Node direct optional npm packages",
      "Validate selected release product dry-runs",
      "Create release-please target branch",
      "Create release-please GitHub releases",
      "Verify release-please product tags",
      "Remove release-please target branch",
      "Publish liboliphaunt GitHub release assets",
    ],
    "Release publish must validate release-commit builder outputs before creating release tags",
  );

  for (const snippet of [
    "id: ci_build_gate",
    'require-workflow-success.sh CI "$RELEASE_HEAD_SHA" 7200 --job Builds',
    "CI_RUN_ID: ${{ steps.ci_build_gate.outputs.run_id }}",
    '--run-id "$CI_RUN_ID"',
    '--run-id "${CI_RUN_ID}"',
    "--job Builds",
    "--artifact liboliphaunt-wasix-release-assets",
    "--artifact oliphaunt-extension-package-artifacts",
    "--artifact liboliphaunt-native-release-assets",
    '--artifact "$artifact"',
    "PRODUCTS_JSON: ${{ steps.release_plan.outputs.products_json }}",
    "Verify release-please product tags",
    'tools/dev/bun.sh tools/release/verify_product_tags.mjs --products-json "${PRODUCTS_JSON}" --target "$RELEASE_HEAD_SHA"',
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-products --family sdk-package --products-json "$PRODUCTS_JSON" --format lines',
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product "$product" --family sdk-package --format lines',
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product "$product" --kind "$kind" --family release-assets --format lines',
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product oliphaunt-node-direct --kind node-direct-addon --family npm-package --format lines',
    "pnpm install --frozen-lockfile",
    "target/oliphaunt-broker/release-assets",
    "target/oliphaunt-node-direct/release-assets",
    "tools/dev/bun.sh tools/release/release-publish.mjs publish-dry-run --products-json",
    '--head-ref "$RELEASE_HEAD_SHA"',
  ]) {
    if (!publishBlock.includes(snippet)) {
      fail(`Release workflow dry-run handoff is missing ${JSON.stringify(snippet)}`);
    }
  }
  for (const legacyEnv of [
    "PRODUCT_OLIPHAUNT_RUST",
    "PRODUCT_OLIPHAUNT_SWIFT",
    "PRODUCT_OLIPHAUNT_KOTLIN",
    "PRODUCT_OLIPHAUNT_REACT_NATIVE",
    "PRODUCT_OLIPHAUNT_JS",
    "PRODUCT_OLIPHAUNT_WASIX_RUST",
  ]) {
    if (publishBlock.includes(legacyEnv)) {
      fail(`Release workflow must not hard-code SDK product selection with ${legacyEnv}`);
    }
  }
  if (publishBlock.includes("target/release-assets/native")) {
    fail("Release workflow must download native helper artifacts into product-owned release asset roots");
  }

  const downloadCalls = [...publishBlock.matchAll(/bun [.]github\/scripts\/download-build-artifacts[.]mjs/g)];
  if (downloadCalls.length === 0) {
    fail("Release workflow must download staged builder artifacts from the CI workflow");
  }
  for (const [index, call] of downloadCalls.entries()) {
    const nextCall = index + 1 < downloadCalls.length ? downloadCalls[index + 1].index : -1;
    const nextStep = publishBlock.indexOf("\n      - name:", call.index + call[0].length);
    const endCandidates = [nextCall, nextStep].filter((candidate) => candidate !== -1);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : publishBlock.length;
    const callText = normalizedShell(publishBlock.slice(call.index, end));
    for (const required of ["CI", '"$RELEASE_HEAD_SHA"', "--run-id", "--job Builds"]) {
      if (!callText.includes(required)) {
        fail(`Release artifact download must require ${required}: ${callText.slice(0, 240)}`);
      }
    }
    if (!callText.includes("--artifact") && !callText.includes("artifact_args")) {
      fail(`Release artifact download must require explicit artifact arguments: ${callText.slice(0, 240)}`);
    }
  }

  const buildArtifactScript = readText(".github/scripts/download-build-artifacts.mjs");
  for (const snippet of [
    "--run-id",
    "selectedRunId",
    "requiredJobSuccess(repo, runId",
    "artifactPresent(repo, runId, artifact)",
    "actions/runs/${runId}/artifacts?per_page=100",
    '"run", "view", runId, "--repo", repo, "--json", "jobs"',
    "Bun.argv",
    "mergeDownloadedArtifact",
    "mergeChecksumManifest",
    '-release-assets.sha256"',
    "would overwrite",
  ]) {
    if (!buildArtifactScript.includes(snippet)) {
      fail(`shared CI artifact downloader must support and verify pinned run ids: missing ${JSON.stringify(snippet)}`);
    }
  }
  if (buildArtifactScript.includes("GH_RUN_JSON=")) {
    fail("shared CI artifact downloader must not pass full workflow job JSON through the environment");
  }

  const requireWorkflowScript = readText(".github/scripts/require-workflow-success.sh");
  for (const snippet of [
    "--run-id",
    "GITHUB_OUTPUT",
    "run_id=",
    'emit_run_id "$run_id"',
    "actions/runs/$run_id/artifacts?per_page=100",
    'gh run view "$run_id" --repo "$GH_REPO" --json jobs > "$jobs_file"',
    "Bun.argv",
  ]) {
    if (!requireWorkflowScript.includes(snippet)) {
      fail(`CI build gate must emit and validate selected run ids: missing ${JSON.stringify(snippet)}`);
    }
  }
  if (requireWorkflowScript.includes("GH_RUN_JSON=")) {
    fail("CI build gate must not pass full workflow job JSON through the environment");
  }

  const releaseScript = readText("tools/release/release.py");
  const releasePublishScript = readText("tools/release/release-publish.mjs");
  const releaseSdkProductDryRunScript = readText("tools/release/release-sdk-product-dry-run.mjs");
  assertDirectReleasePythonToolsAreExecutable(releaseScript);
  for (const forbidden of [
    "validate_wasix_runtime_inputs",
    "materialized_wasix_runtime_crate_payloads",
    "materialize_core_wasix_asset_payload",
    "materialize_core_wasix_aot_payload",
    "wasm_aot_target_triples",
    'xtask(["assets", "check"])',
    'xtask(["assets", "check-aot"',
    '"assets", "aot-targets"',
  ]) {
    if (releaseScript.includes(forbidden)) {
      fail(
        "release CLI must validate staged liboliphaunt-wasix release archives, " +
          `not raw WASIX build inputs or private crate payloads: found ${JSON.stringify(forbidden)}`,
      );
    }
  }
  for (const snippet of [
    "validate_wasix_release_assets",
    'expected_assets(product, version, surface="github-release")',
    "parse_local_checksum_manifest",
    "target/oliphaunt-wasix/release-assets",
    "validate_wasix_release_asset_contents",
  ]) {
    if (!releaseScript.includes(snippet)) {
      fail(`release-staged WASIX assets must validate staged GitHub release assets: missing ${JSON.stringify(snippet)}`);
    }
  }
  for (const forbidden of [
    "liboliphaunt-wasix:crates-io",
    "publish_wasix_runtime_staged_crates",
    "publish_wasix_runtime_crates_io",
    'package_check.extend(["--package", package])',
  ]) {
    if (releaseScript.includes(forbidden)) {
      fail(`liboliphaunt-wasix must not publish private WASIX runtime crates to crates.io: found ${JSON.stringify(forbidden)}`);
    }
  }
  for (const snippet of [
    '["pnpm", "exec", "jsr", "publish", "--dry-run"]',
    'command.push("--allow-dirty")',
    "run(TOOL, command, { cwd: stagedJsrSourceDir(product) });",
  ]) {
    if (!releaseSdkProductDryRunScript.includes(snippet)) {
      fail(`release dry-runs must cover TypeScript JSR registry-native checks in Bun: missing ${JSON.stringify(snippet)}`);
    }
  }
  for (const snippet of [
    "publishNodeDirectNpmOptionalPackages",
    "nodeDirectOptionalNpmTarballs(version)",
    "requireProductRegistryPublished(product, null)",
  ]) {
    if (!releasePublishScript.includes(snippet)) {
      fail(`release package publishes must cover Node direct registry-native checks in Bun: missing ${JSON.stringify(snippet)}`);
    }
  }

  const cratePackageScript = readText("tools/policy/check-crate-package.sh");
  const cratePackageHelper = readText("tools/policy/list-publishable-cargo-packages.mjs");
  for (const snippet of [
    "bun tools/policy/list-publishable-cargo-packages.mjs",
    "package_oliphaunt_wasix",
    "bun tools/release/package_oliphaunt_wasix_sdk_crate.mjs",
    'if [ "$package" = "oliphaunt-wasix" ]; then',
  ]) {
    if (!cratePackageScript.includes(snippet)) {
      fail(
        "crate package policy must package oliphaunt-wasix through the " +
          `release-shaped local helper instead of crates.io resolution: missing ${JSON.stringify(snippet)}`,
      );
    }
  }
  for (const snippet of [
    "'cargo', ['metadata', '--no-deps', '--format-version', '1']",
    "Array.isArray(cargoPackage.publish) && cargoPackage.publish.length === 0",
    "cargoPackage.name === 'oliphaunt-wasix'",
  ]) {
    if (!cratePackageHelper.includes(snippet)) {
      fail(
        "crate package policy must derive default publishable crates from cargo metadata " +
          `with oliphaunt-wasix handled by the release-shaped helper: missing ${JSON.stringify(snippet)}`,
      );
    }
  }

  const releaseHeadScript = readText(".github/scripts/resolve-release-head.sh");
  for (const snippet of [
    "INPUT_RELEASE_COMMIT",
    "40-character commit SHA",
    "git merge-base --is-ancestor",
    "release-target/",
    "release-tooling changes",
    ".github/workflows/*",
    "tools/release/*",
    "tools/xtask/*",
    "RELEASE_HEAD_SHA",
  ]) {
    if (!releaseHeadScript.includes(snippet)) {
      fail(`release commit resolver must pin safe publish-from-commit behavior: missing ${JSON.stringify(snippet)}`);
    }
  }

  const wasixDownloadScript = readText(".github/scripts/download-wasix-runtime-build-artifacts.mjs");
  for (const snippet of ["RELEASE_HEAD_SHA", "CI_RUN_ID", 'args.push("--run-id", process.env.CI_RUN_ID)', "--required-job", "Builds"]) {
    if (!wasixDownloadScript.includes(snippet)) {
      fail(`WASIX runtime artifact handoff must consume the selected CI run id: missing ${JSON.stringify(snippet)}`);
    }
  }
  if (!publishBlock.includes("bun .github/scripts/download-wasix-runtime-build-artifacts.mjs")) {
    fail("Release workflow must run WASIX runtime artifact handoff through the Bun wrapper");
  }

  const guardedPublishSteps = new Set([
    "Create release-please target branch",
    "Create release-please GitHub releases",
    "Verify release-please product tags",
    "Remove release-please target branch",
    "Publish liboliphaunt GitHub release assets",
    "Publish selected extension GitHub release assets",
    "Attest selected extension release assets",
    "Attest liboliphaunt release assets",
    "Publish Swift SDK GitHub release and SwiftPM tags",
    "Publish Kotlin SDK to Maven Central",
    "Publish React Native package to npm",
    "Publish WASIX Rust binding to crates.io",
    "Publish Rust SDK to crates.io",
    "Publish broker GitHub release assets",
    "Attest broker release assets",
    "Publish Node direct GitHub release assets",
    "Attest Node direct release assets",
    "Publish Node direct optional packages to npm",
    "Publish TypeScript packages to npm and JSR",
    "Upload WASIX GitHub release assets",
    "Attest WASIX release assets",
    "Verify published release",
    "Run consumer shape gates",
  ]);
  for (const step of guardedPublishSteps) {
    assertStepIfContainsPublishGuard(publishSteps, step);
  }

  const attestationRequirements = {
    "Attest selected extension release assets": [
      "actions/attest-build-provenance@",
      "target/extension-artifacts/*/release-assets/*.tar.gz",
      "target/extension-artifacts/*/release-assets/*.tar.zst",
      "target/extension-artifacts/*/release-assets/*.zip",
      "target/extension-artifacts/*/release-assets/*.json",
      "target/extension-artifacts/*/release-assets/*.properties",
      "target/extension-artifacts/*/release-assets/*.sha256",
    ],
    "Attest liboliphaunt release assets": [
      "actions/attest-build-provenance@",
      "target/liboliphaunt/release-assets/*.tar.gz",
      "target/liboliphaunt/release-assets/*.tar.zst",
      "target/liboliphaunt/release-assets/*.zip",
      "target/liboliphaunt/release-assets/*.tsv",
      "target/liboliphaunt/release-assets/*.sha256",
    ],
    "Attest broker release assets": [
      "actions/attest-build-provenance@",
      "target/oliphaunt-broker/release-assets/*.tar.gz",
      "target/oliphaunt-broker/release-assets/*.zip",
      "target/oliphaunt-broker/release-assets/*.sha256",
    ],
    "Attest Node direct release assets": [
      "actions/attest-build-provenance@",
      "target/oliphaunt-node-direct/release-assets/*.tar.gz",
      "target/oliphaunt-node-direct/release-assets/*.zip",
      "target/oliphaunt-node-direct/release-assets/*.sha256",
    ],
    "Attest WASIX release assets": [
      "actions/attest-build-provenance@",
      "target/oliphaunt-wasix/release-assets/*.tar.zst",
      "target/oliphaunt-wasix/release-assets/*.sha256",
    ],
  };
  for (const [step, snippets] of Object.entries(attestationRequirements)) {
    for (const snippet of snippets) {
      assertStepContains(publishSteps, step, snippet, `${step} must attest ${snippet}`);
    }
  }

  assertStepContains(
    publishSteps,
    "Verify published release",
    "tools/dev/bun.sh tools/release/release-verify.mjs --products-json",
    "Release workflow must verify published products through the Bun release verifier",
  );
  assertContains(
    "tools/release/release-verify.mjs",
    "tools/release/verify_github_release_attestations.mjs",
    "release-verify.mjs must verify GitHub artifact attestations",
  );
  for (const snippet of ["--signer-workflow", ".github/workflows/release.yml", "--source-ref", "refs/heads/main", "--deny-self-hosted-runners"]) {
    assertContains(
      "tools/release/verify_github_release_attestations.mjs",
      snippet,
      "Release attestation verification must pin signer workflow, source ref, and runner trust",
    );
  }
}

function extensionNativeTargets(jobs, tasks) {
  const selectedTargets = ciPlan.nativeTargetSubsetForJobs(jobs, tasks);
  const matrix = ciPlan.extensionArtifactsNativeMatrix("all", selectedTargets);
  const include = matrix.include;
  if (!Array.isArray(include)) {
    fail("native extension artifact matrix must declare include rows");
  }
  const targets = new Set(include.filter(isObject).map((row) => row.target));
  if (![...targets].every((target) => typeof target === "string")) {
    fail("native extension artifact matrix rows must declare string target");
  }
  return targets;
}

function csvProductsFromMatrix(matrix) {
  const products = new Set();
  for (const row of matrix.include ?? []) {
    if (!isObject(row)) {
      continue;
    }
    for (const item of String(row.extensions_csv ?? "").split(",")) {
      if (item) {
        products.add(item);
      }
    }
  }
  return products;
}

function assertSingleExtensionMatrixSelection(product) {
  const jobs = ciPlan.planJobsForAffected(new Set([product]), new Set([`${product}:assemble-release`]));
  const selection = ciPlan.selectedExtensionProductsForPlan(new Set([product]), new Set([`${product}:assemble-release`]), jobs);
  if (!setEquals(selection ?? new Set(), new Set([product]))) {
    fail(`single exact-extension changes must narrow extension artifact matrices, got ${formatList(selection ?? new Set())}`);
  }
  const nativeMatrix = ciPlan.extensionArtifactsNativeMatrix("all", null, selection);
  const matrixProducts = csvProductsFromMatrix(nativeMatrix);
  if (!setEquals(matrixProducts, new Set([product]))) {
    fail(`single exact-extension native matrix must include only ${product}, got ${formatList(matrixProducts)}`);
  }

  const aggregateTasks = new Set([
    `${product}:assemble-release`,
    "extension-artifacts-native:build-target",
    "extension-artifacts-wasix:build-target",
    "extension-packages:assemble-release",
  ]);
  const aggregateJobs = ciPlan.planJobsForAffected(new Set([product]), aggregateTasks);
  const aggregateSelection = ciPlan.selectedExtensionProductsForPlan(new Set([product]), aggregateTasks, aggregateJobs);
  if (!setEquals(aggregateSelection ?? new Set(), new Set([product]))) {
    fail(
      "single exact-extension changes must stay product-scoped even when aggregate artifact/package tasks are selected, " +
        `got ${formatList(aggregateSelection ?? new Set())}`,
    );
  }
  const aggregateNativeProducts = csvProductsFromMatrix(ciPlan.extensionArtifactsNativeMatrix("all", null, aggregateSelection));
  if (!setEquals(aggregateNativeProducts, new Set([product]))) {
    fail(`single exact-extension aggregate native matrix must include only ${product}, got ${formatList(aggregateNativeProducts)}`);
  }
  const aggregateWasixProducts = csvProductsFromMatrix(ciPlan.extensionArtifactsWasixMatrix("all", aggregateSelection));
  if (!setEquals(aggregateWasixProducts, new Set([product]))) {
    fail(`single exact-extension aggregate WASIX matrix must include only ${product}, got ${formatList(aggregateWasixProducts)}`);
  }
}

function checkCiBuilderPlanning() {
  const fullPlan = ciPlan.planForFullRun();
  const fullJobs = fullPlan.jobs;
  const allowedFullNonBuilders = ciPlan.BASE_JOBS;
  const unexpectedFullJobs = sorted(difference(difference(fullJobs, ciPlan.BUILDER_JOBS), allowedFullNonBuilders));
  if (unexpectedFullJobs.length > 0) {
    fail(`full non-PR CI runs must select artifact-producing builder jobs only; unexpected jobs: ${JSON.stringify(unexpectedFullJobs)}`);
  }
  const forbiddenFullJobs = sorted(
    intersection(
      fullJobs,
      new Set([
        "coverage-summary",
        "docs",
        "js-regression",
        "mobile-e2e-android",
        "mobile-e2e-ios",
        "release-intent",
        "release-readiness",
        "repo",
        "rust-regression",
        "wasm-regression",
      ]),
    ),
  );
  if (forbiddenFullJobs.length > 0) {
    fail(`full non-PR CI runs must not select check/regression/policy jobs: ${JSON.stringify(forbiddenFullJobs)}`);
  }

  const focusedWasixJobs = ciPlan.planForFullRun({ wasmTarget: "linux-x64-gnu" }).jobs;
  const expectedFocusedWasixJobs = new Set(["affected", "liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"]);
  if (!setEquals(focusedWasixJobs, expectedFocusedWasixJobs)) {
    fail(`focused WASIX target CI runs must build only the portable runtime and requested AOT target, got ${formatList(focusedWasixJobs)}`);
  }

  const focusedMobileExpectations = {
    android: new Set([
      "affected",
      "extension-artifacts-native",
      "kotlin-sdk-package",
      "liboliphaunt-native-android",
      "mobile-build-android",
      "mobile-extension-packages",
      "react-native-sdk-package",
    ]),
    ios: new Set([
      "affected",
      "extension-artifacts-native",
      "liboliphaunt-native-ios",
      "mobile-build-ios",
      "mobile-extension-packages",
      "react-native-sdk-package",
      "swift-sdk-package",
    ]),
  };
  for (const [target, expectedJobs] of Object.entries(focusedMobileExpectations)) {
    const focusedJobs = ciPlan.planForFullRun({ mobileTarget: target }).jobs;
    if (!isSubset(expectedJobs, focusedJobs)) {
      fail(`focused ${target} CI run is missing builder jobs: expected at least ${formatList(expectedJobs)}, got ${formatList(focusedJobs)}`);
    }
    const focusedForbidden = intersection(focusedJobs, new Set(["mobile-e2e-android", "mobile-e2e-ios"]));
    if (focusedForbidden.size > 0) {
      fail(`focused ${target} CI run must build app artifacts only, not E2E jobs: ${formatList(focusedForbidden)}`);
    }
  }

  const androidArmPlan = ciPlan.planForFullRun({ nativeTarget: "android-arm64-v8a", mobileTarget: "android" });
  if (!setEquals(androidArmPlan.selectedTargets ?? new Set(), new Set(["android-arm64-v8a"]))) {
    fail(
      "focused Android mobile CI run with native_target=android-arm64-v8a must narrow every " +
        `target-scoped builder to android-arm64-v8a, got ${formatList(androidArmPlan.selectedTargets ?? new Set())}`,
    );
  }
  if (JSON.stringify(ciPlan.mobileExtensionPackageNativeTargets(androidArmPlan.jobs, androidArmPlan.selectedTargets)) !== JSON.stringify(["android-arm64-v8a"])) {
    fail("focused Android mobile extension package targets must match the selected Android native target");
  }

  const iosFocusedPlan = ciPlan.planForFullRun({ nativeTarget: "ios-xcframework", mobileTarget: "ios" });
  if (!setEquals(iosFocusedPlan.selectedTargets ?? new Set(), new Set(["ios-xcframework"]))) {
    fail(
      "focused iOS mobile CI run with native_target=ios-xcframework must narrow every " +
        `target-scoped builder to ios-xcframework, got ${formatList(iosFocusedPlan.selectedTargets ?? new Set())}`,
    );
  }
  if (JSON.stringify(ciPlan.mobileExtensionPackageNativeTargets(iosFocusedPlan.jobs, iosFocusedPlan.selectedTargets)) !== JSON.stringify(["ios-xcframework"])) {
    fail("focused iOS mobile extension package targets must match the selected iOS native target");
  }

  try {
    ciPlan.planForFullRun({ nativeTarget: "ios-xcframework", mobileTarget: "android" });
    fail("focused Android mobile CI run must reject native_target=ios-xcframework");
  } catch (error) {
    if (!String(error.message).includes("not valid for mobile_target=android")) {
      fail(`focused Android/iOS target mismatch failed with an unclear error: ${error.message}`);
    }
  }

  try {
    ciPlan.planForFullRun({ nativeTarget: "android-arm64-v8a", mobileTarget: "both" });
    fail("focused mobile_target=both must reject a single native target");
  } catch (error) {
    if (!String(error.message).includes("mobile_target=both requires native_target=all")) {
      fail(`focused mobile_target=both mismatch failed with an unclear error: ${error.message}`);
    }
  }

  const reactNativeJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-react-native:package-artifacts"]));
  const reactNativeExpectedJobs = new Set([
    "extension-artifacts-native",
    "kotlin-sdk-package",
    "liboliphaunt-native-android",
    "liboliphaunt-native-ios",
    "mobile-build-android",
    "mobile-build-ios",
    "mobile-extension-packages",
    "react-native-sdk-package",
    "swift-sdk-package",
  ]);
  if (!isSubset(reactNativeExpectedJobs, reactNativeJobs)) {
    fail(
      "React Native SDK package changes must build both mobile app artifacts from staged SDK/runtime/extension inputs; " +
        `missing ${formatList(difference(reactNativeExpectedJobs, reactNativeJobs))} from ${formatList(reactNativeJobs)}`,
    );
  }
  const reactNativeTargets = ciPlan.nativeTargetSubsetForJobs(reactNativeJobs, new Set(["oliphaunt-react-native:package-artifacts"]));
  const expectedReactNativeTargets = new Set(["android-arm64-v8a", "android-x86_64", "ios-xcframework"]);
  if (!setEquals(reactNativeTargets ?? new Set(), expectedReactNativeTargets)) {
    fail(`React Native SDK package changes must request Android and iOS native runtime targets, got ${formatList(reactNativeTargets ?? new Set())}`);
  }

  assertSingleExtensionMatrixSelection("oliphaunt-extension-vector");
  assertSingleExtensionMatrixSelection("oliphaunt-extension-amcheck");
  const broadSelection = ciPlan.selectedExtensionProductsForPlan(
    new Set(["extensions"]),
    new Set(["extension-packages:assemble-release"]),
    new Set(["extension-packages", "extension-artifacts-native", "extension-artifacts-wasix"]),
  );
  const allExtensionProducts = expectedExtensionProductsFromSdkCatalog();
  if (!setEquals(broadSelection ?? new Set(), allExtensionProducts)) {
    fail(`broad extension catalog changes must select the full exact-extension product set, got ${formatList(broadSelection ?? new Set())}`);
  }

  const fullBuilderSelection = ciPlan.selectedExtensionProductsForPlan(
    new Set(),
    new Set([
      "extension-packages:assemble-release",
      "extension-packages:assemble-mobile",
      "oliphaunt-react-native:mobile-build-android",
      "oliphaunt-react-native:mobile-build-ios",
    ]),
    new Set([
      "extension-artifacts-native",
      "extension-artifacts-wasix",
      "extension-packages",
      "mobile-build-android",
      "mobile-build-ios",
      "mobile-extension-packages",
    ]),
  );
  if (!setEquals(fullBuilderSelection ?? new Set(), allExtensionProducts)) {
    fail(`full builder runs must select the full exact-extension product set, got ${formatList(fullBuilderSelection ?? new Set())}`);
  }

  const mobileFocusedSelection = ciPlan.selectedExtensionProductsForPlan(
    new Set(),
    new Set(["oliphaunt-react-native:mobile-build-android"]),
    new Set(["mobile-build-android", "mobile-extension-packages", "extension-artifacts-native"]),
  );
  if (!setEquals(mobileFocusedSelection ?? new Set(), new Set(["oliphaunt-extension-vector"]))) {
    fail(`focused mobile builder runs must build only the selected smoke extension, got ${formatList(mobileFocusedSelection ?? new Set())}`);
  }

  const androidTasks = new Set(["oliphaunt-react-native:mobile-build-android"]);
  const androidJobs = ciPlan.planJobsForAffected(new Set(), androidTasks);
  if (!androidJobs.has("extension-artifacts-native")) {
    fail("Android mobile build must build selected native extension artifacts");
  }
  const androidTargets = extensionNativeTargets(androidJobs, androidTasks);
  if (!setEquals(androidTargets, new Set(["android-arm64-v8a", "android-x86_64"]))) {
    fail(`Android mobile build must only request Android extension artifacts, got ${formatList(androidTargets)}`);
  }

  const androidE2eJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-react-native:mobile-e2e-android"]));
  if (!setEquals(androidE2eJobs, ciPlan.BASE_JOBS)) {
    fail(`CI must not select Android E2E jobs; got ${formatList(androidE2eJobs)}`);
  }

  const iosTasks = new Set(["oliphaunt-react-native:mobile-build-ios"]);
  const iosJobs = ciPlan.planJobsForAffected(new Set(), iosTasks);
  if (!iosJobs.has("extension-artifacts-native")) {
    fail("iOS mobile build must build selected native extension artifacts");
  }
  const iosTargets = extensionNativeTargets(iosJobs, iosTasks);
  if (!setEquals(iosTargets, new Set(["ios-xcframework"]))) {
    fail(`iOS mobile build must only request iOS extension artifacts, got ${formatList(iosTargets)}`);
  }

  const iosE2eJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-react-native:mobile-e2e-ios"]));
  if (!setEquals(iosE2eJobs, ciPlan.BASE_JOBS)) {
    fail(`CI must not select iOS E2E jobs; got ${formatList(iosE2eJobs)}`);
  }

  const extensionTasks = new Set(["extension-packages:assemble-release"]);
  const extensionJobs = ciPlan.planJobsForAffected(new Set(), extensionTasks);
  const fullTargets = extensionNativeTargets(extensionJobs, extensionTasks);
  const expectedFullTargets = new Set(
    artifactTargetRows({ product: "liboliphaunt-native", kind: "native-runtime", publishedOnly: true })
      .filter((target) => target.extension_artifacts ?? true)
      .map((target) => target.target),
  );
  if (!setEquals(fullTargets, expectedFullTargets)) {
    fail(`extension package build must request all supported native extension artifacts, got ${formatList(fullTargets)}`);
  }

  const swiftJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-swift:package-artifacts"]));
  if (!swiftJobs.has("liboliphaunt-native-ios")) {
    fail("Swift SDK package build must build the Apple liboliphaunt XCFramework");
  }
  const swiftTargets = ciPlan.nativeTargetSubsetForJobs(swiftJobs, new Set(["oliphaunt-swift:package-artifacts"]));
  if (!setEquals(swiftTargets ?? new Set(), new Set(["ios-xcframework"]))) {
    fail(`Swift SDK package build must only request the Apple XCFramework runtime target, got ${formatList(swiftTargets ?? new Set())}`);
  }

  const kotlinJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-kotlin:package-artifacts"]));
  if (!setEquals(kotlinJobs, union(ciPlan.BASE_JOBS, new Set(["kotlin-sdk-package"])))) {
    fail(`Kotlin SDK package build must only package the Kotlin SDK, got ${formatList(kotlinJobs)}`);
  }

  const rustJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-rust:package-artifacts"]));
  if (!setEquals(rustJobs, union(ciPlan.BASE_JOBS, new Set(["rust-sdk-package"])))) {
    fail(`Rust SDK package build must only package the Rust SDK, got ${formatList(rustJobs)}`);
  }

  const jsJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-js:package-artifacts"]));
  if (!setEquals(jsJobs, union(ciPlan.BASE_JOBS, new Set(["js-sdk-package"])))) {
    fail(`TypeScript SDK package build must only package the TypeScript SDK, got ${formatList(jsJobs)}`);
  }

  const wasixRustJobs = ciPlan.planJobsForAffected(new Set(), new Set(["oliphaunt-wasix-rust:package-artifacts"]));
  if (!setEquals(wasixRustJobs, union(ciPlan.BASE_JOBS, new Set(["wasix-rust-package"])))) {
    fail(`WASIX Rust binding package build must only package the binding crate, got ${formatList(wasixRustJobs)}`);
  }
}

function main() {
  const graph = releaseGraph();
  const policy = graph.policy;
  if (!isObject(policy)) {
    fail("release metadata must define policy");
  }
  if (policy.repository !== "f0rr0/oliphaunt") {
    fail("release policy repository must be f0rr0/oliphaunt");
  }
  if (policy.versioning !== "independent") {
    fail("release policy must use independent versioning");
  }

  checkReleaseMetadata();
  checkReleasePlanning();
  checkCiPolicy();
  checkReleaseWorkflowPolicy();
  checkCiBuilderPlanning();
  console.log("release policy checks passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  fail(error?.message ?? String(error));
}
