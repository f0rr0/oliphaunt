#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  BASE_JOBS,
  BUILDER_JOBS,
  CI_JOB_TARGETS,
  NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT,
  assertJsExactCandidatePlanClosure,
  extensionProductDependencyClosure,
  extensionArtifactsNativeMatrixForPlan,
  extensionArtifactsWasixMatrixForPlan,
  liboliphauntNativeIosRuntimeMatrixForPlan,
  mobileE2eJobsForPlan,
  mobileExtensionPackageNativeTargets,
  nativeExtensionLifecycleShardPlan,
  nativeTargetSubsetForJobs,
  planForFullRun,
  planJobsForAffected,
  renderPlanForFullRun,
  renderPlanWithSelection,
  selectedExtensionProductsForPlan,
} from "../graph/ci_plan.mjs";
import {
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
} from "../release/artifact_target_matrix.mjs";
import {
  allArtifactTargets,
  extensionMemberPath,
} from "../release/release-artifact-targets.mjs";
import {
  PUBLICATION_CATALOG_SCHEMA,
  REGISTRY_KIND_TO_ECOSYSTEM,
  loadPublicationCatalog,
} from "../release/publication-catalog.mjs";
import {
  buildPlan,
  loadGraph,
  releaseProductProjectId,
  runtimeTiedContribProducts,
} from "../release/release-graph.mjs";
import { parseWorkflow } from "./assertions/workflow-semantics.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const CORE_PRODUCTS = new Set([
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
const EXTENSION_VERSIONING = Object.freeze({
  contrib: "runtime-bound",
  external: "upstream-bound",
  "first-party": "repo-bound",
});
const WASIX_ICU_VERSION_FILE = "src/runtimes/liboliphaunt/icu/Cargo.toml";
const WASIX_ICU_VERSION_LINK = "liboliphaunt-wasix-icu";
const CONTRIB_BUNDLE_PRODUCT = "oliphaunt-extension-contrib-pg18";
const STABLE_CI_JOBS = new Set([
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
  "js-sdk-exact-candidate-consumer",
  "native-extension-lifecycle",
  "native-extension-lifecycle-aggregate",
  "rust-sdk-exact-candidate-consumer",
  "wasix-rust-exact-candidate-consumer",
  "wasix-release-regression",
  "e2e",
  "required",
  "qualified",
]);

export class ReleasePolicyError extends Error {
  constructor(message) {
    super(`release policy: ${message}`);
    this.name = "ReleasePolicyError";
  }
}

function invariant(condition, message) {
  if (!condition) throw new ReleasePolicyError(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort();
}

function set(values) {
  return values instanceof Set ? values : new Set(values);
}

function union(...values) {
  return new Set(values.flatMap((items) => [...items]));
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function formatSet(values) {
  return JSON.stringify(sorted(values));
}

function assertSet(actual, expected, context) {
  actual = set(actual);
  expected = set(expected);
  invariant(
    sameSet(actual, expected),
    `${context}: expected ${formatSet(expected)}, got ${formatSet(actual)}`,
  );
}

function assertIncludes(actual, expected, context) {
  actual = set(actual);
  expected = set(expected);
  const missing = difference(expected, actual);
  invariant(missing.size === 0, `${context}: missing ${formatSet(missing)}`);
}

function readJson(repoPath) {
  const value = JSON.parse(readFileSync(path.join(ROOT, repoPath), "utf8"));
  invariant(object(value), `${repoPath} must contain a JSON object`);
  return value;
}

function readToml(repoPath) {
  const value = Bun.TOML.parse(readFileSync(path.join(ROOT, repoPath), "utf8"));
  invariant(object(value), `${repoPath} must contain a TOML table`);
  return value;
}

function readYaml(repoPath) {
  const value = Bun.YAML.parse(readFileSync(path.join(ROOT, repoPath), "utf8"));
  invariant(object(value), `${repoPath} must contain a YAML mapping`);
  return value;
}

function repositoryFilesUnder(repoPath) {
  const result = [];
  const visit = (relative) => {
    const absolute = path.join(ROOT, relative);
    invariant(existsSync(absolute), `${relative} must exist`);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result.push(child);
    }
  };
  visit(repoPath);
  return result;
}

function productId(sqlName) {
  return `oliphaunt-extension-${sqlName.replaceAll("_", "-").toLowerCase()}`;
}

function extensionSqlNamesFromRows(rows, context) {
  invariant(Array.isArray(rows) && rows.length > 0, `${context} must define extensions`);
  const sqlNames = rows.map((row) => {
    invariant(object(row), `${context} extension rows must be objects`);
    const sqlName = row["sql-name"];
    invariant(typeof sqlName === "string" && sqlName.length > 0, `${context} extension rows must declare sql-name`);
    return sqlName;
  });
  invariant(new Set(sqlNames).size === sqlNames.length, `${context} must not contain duplicate extensions`);
  return new Set(sqlNames);
}

export function releasePolicyExpectations() {
  const extensionSqlNames = extensionSqlNamesFromRows(
    readJson("src/extensions/generated/sdk/rust.json").extensions,
    "generated Rust extension catalog",
  );
  const contribSqlNames = extensionSqlNamesFromRows(
    readToml("src/extensions/contrib/postgres18.toml").extensions,
    "PostgreSQL contrib extension manifest",
  );
  invariant(
    difference(contribSqlNames, extensionSqlNames).size === 0,
    "contrib extension members must be present in the public extension catalog",
  );
  const externalProducts = new Set([...difference(extensionSqlNames, contribSqlNames)].map(productId));
  const extensionProducts = union(externalProducts, new Set([CONTRIB_BUNDLE_PRODUCT]));
  const contribProducts = new Set([CONTRIB_BUNDLE_PRODUCT]);
  return {
    extensionSqlNames,
    contribSqlNames,
    extensionProducts,
    contribProducts,
    products: union(CORE_PRODUCTS, extensionProducts),
  };
}

function validateExtensionProduct(product, config, project, expectations) {
  const extension = config.extension;
  invariant(object(extension), `${product} must declare structured extension metadata`);
  if (config.kind === "exact-extension-bundle") {
    invariant(product === CONTRIB_BUNDLE_PRODUCT, `only ${CONTRIB_BUNDLE_PRODUCT} may be the PostgreSQL 18 contrib bundle`);
    invariant(extension.sql_name === undefined && config.extension_sql_name === undefined, `${product} bundle must not declare a singleton SQL name`);
    assertSet(config.extension_sql_names, expectations.contribSqlNames, `${product} member set`);
    invariant(extension.member_manifest === "src/extensions/contrib/postgres18.toml", `${product} must bind the canonical PostgreSQL 18 contrib manifest`);
  } else {
    const sqlName = extension.sql_name;
    invariant(product === productId(sqlName), `${product} must match extension sql_name ${JSON.stringify(sqlName)}`);
    invariant(config.extension_sql_name === sqlName, `${product}.extension_sql_name must match extension.sql_name`);
    invariant(expectations.extensionSqlNames.has(sqlName) && !expectations.contribSqlNames.has(sqlName), `${product} must be an independently versioned external extension`);
  }
  const expectedVersioning = EXTENSION_VERSIONING[extension.class];
  invariant(expectedVersioning !== undefined, `${product} uses unknown extension class ${JSON.stringify(extension.class)}`);
  invariant(extension.versioning === expectedVersioning, `${product} must use ${expectedVersioning} versioning`);
  invariant(
    expectations.contribProducts.has(product) === (extension.class === "contrib"),
    `${product} class must agree with the contrib manifest`,
  );
  if (extension.class === "contrib") {
    invariant(extension.source?.path === "src/postgres/versions/18/source.toml", `${product} must use the PostgreSQL 18 source identity`);
  } else if (extension.class === "external") {
    invariant(extension.source?.path === `${config.path}/source.toml`, `${product} must own its external source identity`);
  } else {
    invariant(
      extension.source?.path === config.path || extension.source?.path?.startsWith(`${config.path}/`),
      `${product} first-party source identity must remain in its package`,
    );
  }

  invariant(project.layer === "library", `${product} must be a library project`);
  const scopes = project.dependencyScopes ?? {};
  invariant(scopes["extension-runtime-contract"] === "production", `${product} must depend on the extension runtime contract in production`);
  const runtimeScope = extension.class === "external" ? "build" : "production";
  for (const runtime of ["liboliphaunt-native", "liboliphaunt-wasix"]) {
    invariant(scopes[runtime] === runtimeScope, `${product} must depend on ${runtime} with ${runtimeScope} scope`);
  }
}

export function validateReleasePolicyModel(graph, expectations = releasePolicyExpectations()) {
  invariant(object(graph), "release graph must be an object");
  invariant(object(graph.policy), "release graph must declare policy");
  invariant(graph.policy.repository === "f0rr0/oliphaunt", "repository must be f0rr0/oliphaunt");
  invariant(graph.policy.default_branch === "main", "default branch must be main");
  invariant(graph.policy.versioning === "independent", "products must use independent versioning");
  invariant(object(graph.products) && object(graph.moon_projects), "release graph must declare products and Moon projects");

  assertSet(Object.keys(graph.products), expectations.products, "release product set");
  const extensionProducts = new Set(
    Object.entries(graph.products)
      .filter(([, config]) => ["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind))
      .map(([product]) => product),
  );
  assertSet(extensionProducts, expectations.extensionProducts, "exact extension product set");

  for (const [product, config] of Object.entries(graph.products)) {
    invariant(config.id === product, `${product}.id must match its product id`);
    invariant(typeof config.path === "string" && config.path.length > 0, `${product}.path must be non-empty`);
    invariant(typeof config.tag_prefix === "string" && config.tag_prefix.length > 0, `${product}.tag_prefix must be non-empty`);
    invariant(Array.isArray(config.version_files) && config.version_files.length > 0, `${product}.version_files must be non-empty`);
    invariant(Array.isArray(config.publish_targets) && config.publish_targets.length > 0, `${product}.publish_targets must be non-empty`);
    invariant(Array.isArray(config.release_artifacts) && config.release_artifacts.length > 0, `${product}.release_artifacts must be non-empty`);

    const raw = readToml(`${config.path}/release.toml`);
    for (const duplicatedGraphField of ["depends_on", "source_globs", "package_visible_globs"]) {
      invariant(
        !Object.hasOwn(raw, duplicatedGraphField),
        `${config.path}/release.toml must not duplicate Moon's ${duplicatedGraphField} graph`,
      );
    }

    const projectId = releaseProductProjectId(product, graph.products, graph.moon_projects, "release-policy");
    const project = graph.moon_projects[projectId];
    invariant(object(project), `${product} must have an owning Moon project`);
    invariant((project.tags ?? []).includes("release-product"), `${projectId} must be tagged release-product`);
    const release = project.project?.metadata?.release;
    invariant(object(release), `${projectId} must declare project.metadata.release`);
    invariant(release.component === product, `${projectId} release component must be ${product}`);
    invariant(release.packagePath === config.path, `${projectId} release packagePath must be ${config.path}`);
    if (extensionProducts.has(product)) validateExtensionProduct(product, config, project, expectations);
  }

  const wasix = graph.products["liboliphaunt-wasix"];
  invariant(
    wasix.derived_version_files?.includes(WASIX_ICU_VERSION_FILE),
    `liboliphaunt-wasix must own ${WASIX_ICU_VERSION_FILE} as a derived version file`,
  );
  const icuVersionLink = wasix.compatibility_versions?.[WASIX_ICU_VERSION_LINK];
  invariant(
    object(icuVersionLink)
      && icuVersionLink.source_product === "liboliphaunt-wasix"
      && icuVersionLink.path === WASIX_ICU_VERSION_FILE
      && icuVersionLink.parser === "toml:package.version",
    `liboliphaunt-wasix must synchronize ${WASIX_ICU_VERSION_FILE} from its release version`,
  );

  const extensionModel = graph.moon_projects["extension-model"];
  invariant(object(extensionModel), "extension-model Moon project is required");
  invariant(
    !Object.hasOwn(extensionModel.dependencyScopes ?? {}, "extensions"),
    "extension-model must not depend on the aggregate extensions project",
  );
  return graph;
}

function registryIdentity(raw, product) {
  invariant(typeof raw === "string", `${product}.registry_packages entries must be strings`);
  const separator = raw.indexOf(":");
  invariant(separator > 0 && separator < raw.length - 1, `${product} registry identity must use kind:name`);
  const kind = raw.slice(0, separator);
  const ecosystem = REGISTRY_KIND_TO_ECOSYSTEM[kind];
  invariant(ecosystem !== undefined, `${product} registry identity uses unknown kind ${kind}`);
  return `${ecosystem}:${raw.slice(separator + 1)}`;
}

export function validatePublicationModel(graph, catalog) {
  invariant(catalog?.schema === PUBLICATION_CATALOG_SCHEMA, `publication catalog must use ${PUBLICATION_CATALOG_SCHEMA}`);
  invariant(Array.isArray(catalog.products) && Array.isArray(catalog.carriers), "publication catalog must declare product and carrier lists");
  assertSet(catalog.products.map((row) => row.id), Object.keys(graph.products), "publication catalog product set");

  const productOrder = new Map(catalog.products.map((row, index) => [row.id, index]));
  invariant(productOrder.size === catalog.products.length, "publication catalog product ids must be unique");
  for (const row of catalog.products) {
    const config = graph.products[row.id];
    invariant(row.kind === config.kind && row.path === config.path && row.version === config.version, `${row.id} publication product metadata must match the release graph`);
    for (const dependency of row.dependencies) {
      invariant(productOrder.has(dependency), `${row.id} publication dependency ${dependency} must be a release product`);
      invariant(dependency !== row.id, `${row.id} must not depend on itself in the publication catalog`);
    }
  }

  const expectedCarriers = new Set();
  for (const [product, config] of Object.entries(graph.products)) {
    for (const raw of config.registry_packages ?? []) expectedCarriers.add(registryIdentity(raw, product));
  }
  const actualCarriers = new Set();
  for (const carrier of catalog.carriers) {
    invariant(!actualCarriers.has(carrier.id), `publication carrier ${carrier.id} must be unique`);
    actualCarriers.add(carrier.id);
    const product = graph.products[carrier.product];
    invariant(object(product), `publication carrier ${carrier.id} references unknown product ${carrier.product}`);
    invariant(carrier.version === product.version, `publication carrier ${carrier.id} version must match ${carrier.product}`);
    invariant(carrier.id === `${carrier.ecosystem}:${carrier.name}`, `publication carrier ${carrier.id} identity is malformed`);
    invariant(carrier.declared === true, `catalog carrier ${carrier.id} must be explicitly declared`);
  }
  assertSet(actualCarriers, expectedCarriers, "publication carrier set");
  return catalog;
}

function checkReleasePlanning(graph, expectations) {
  const runtimeTied = new Set(runtimeTiedContribProducts(graph.products, "release-policy"));
  assertSet(
    runtimeTied,
    union(new Set(["liboliphaunt-native", "liboliphaunt-wasix"]), expectations.contribProducts),
    "runtime-tied release group",
  );
  const minimumCases = new Map([
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
        expectations.contribProducts,
      ),
    ],
    ["src/extensions/contrib/postgres18.toml", runtimeTied],
    [
      "src/shared/extension-runtime-contract/contract.toml",
      union(new Set(["liboliphaunt-native", "liboliphaunt-wasix"]), expectations.extensionProducts),
    ],
    ["src/runtimes/liboliphaunt/native/VERSION", runtimeTied],
    ["src/runtimes/liboliphaunt/wasix/VERSION", runtimeTied],
  ]);
  const exactCases = new Map([
    ["src/extensions/contrib/amcheck/targets/artifacts.toml", runtimeTied],
    ["src/extensions/external/vector/source.toml", new Set(["oliphaunt-extension-vector"])],
    ["src/shared/fixtures/protocol/query-response-cases.json", new Set()],
    ["docs/maintainers/release.md", new Set()],
  ]);
  for (const [repoPath, expected] of minimumCases) {
    assertIncludes(buildPlan(graph, [repoPath], "release-policy").releaseProducts, expected, `${repoPath} release plan`);
  }
  for (const [repoPath, expected] of exactCases) {
    assertSet(buildPlan(graph, [repoPath], "release-policy").releaseProducts, expected, `${repoPath} release plan`);
  }

  const releasePlease = readJson("release-please-config.json");
  const contribReleasePlease = releasePlease.packages?.["src/extensions/contrib"];
  invariant(
    object(contribReleasePlease) && contribReleasePlease.component === CONTRIB_BUNDLE_PRODUCT,
    `Release Please must own every nested contrib path through src/extensions/contrib => ${CONTRIB_BUNDLE_PRODUCT}`,
  );
  for (const sqlName of [...expectations.contribSqlNames].sort()) {
    const memberRoot = extensionMemberPath(CONTRIB_BUNDLE_PRODUCT, sqlName, "release-policy");
    const existingPaths = repositoryFilesUnder(memberRoot);
    invariant(existingPaths.length > 0, `${memberRoot} must contain release-affecting member metadata`);
    invariant(existingPaths.includes(`${memberRoot}/moon.yml`), `${memberRoot} must contain moon.yml`);
    invariant(existingPaths.includes(`${memberRoot}/targets/artifacts.toml`), `${memberRoot} must contain target evidence`);
    for (const repoPath of [...existingPaths, `${memberRoot}/future-release-input.toml`]) {
      const plan = buildPlan(graph, [repoPath], "release-policy");
      assertSet(plan.directProducts, new Set([CONTRIB_BUNDLE_PRODUCT]), `${repoPath} direct release owner`);
      assertSet(plan.releaseProducts, runtimeTied, `${repoPath} runtime-tied bundle release closure`);
    }
  }
}

function checkCiWorkflowPolicy() {
  for (const legacyGraph of ["tools/graph/jobs.toml", "tools/release/release-inputs.toml"]) {
    invariant(!existsSync(path.join(ROOT, legacyGraph)), `${legacyGraph} must not exist; Moon is the dependency graph`);
  }
  const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
  const modeledJobs = new Set(Object.keys(CI_JOB_TARGETS));
  invariant(modeledJobs.size > 0, "CI planner must expose Moon-tagged jobs");
  assertSet(
    new Set(CI_JOB_TARGETS["liboliphaunt-native-release-assets"] ?? []),
    new Set([
      "liboliphaunt-native:registry-carrier-qualification",
      "liboliphaunt-native:release-assets",
    ]),
    "native aggregate artifact and local registry-carrier targets",
  );
  assertSet(
    new Set(CI_JOB_TARGETS["extension-packages"] ?? []),
    new Set([
      "extension-packages:assemble-release",
      "extension-packages:registry-carrier-qualification",
    ]),
    "extension aggregate artifact and local registry-carrier targets",
  );
  for (const [repoPath, dependency, command, evidence] of [
    [
      "src/runtimes/liboliphaunt/native/moon.yml",
      "liboliphaunt-native:release-assets",
      "tools/dev/bun.sh tools/release/offline-registry-carrier-qualification.mjs --scope native",
      "/target/release-work/offline-registry-carrier-qualification/native.json",
    ],
    [
      "src/extensions/artifacts/packages/moon.yml",
      "extension-packages:assemble-release",
      "tools/dev/bun.sh tools/release/offline-registry-carrier-qualification.mjs --scope extensions",
      "/target/release-work/offline-registry-carrier-qualification/extensions.json",
    ],
  ]) {
    const task = readYaml(repoPath).tasks?.["registry-carrier-qualification"];
    invariant(object(task), `${repoPath} must define registry-carrier-qualification`);
    assertSet(task.deps ?? [], new Set([dependency]), `${repoPath} carrier qualification dependency`);
    invariant(task.command === command, `${repoPath} must invoke only the canonical offline carrier qualification`);
    invariant(
      Array.isArray(task.outputs) && task.outputs.includes(evidence),
      `${repoPath} carrier qualification must declare its evidence output`,
    );
    invariant(
      Array.isArray(task.inputs) && task.inputs.includes("/tools/release/rust-build-script-sha256.mjs"),
      `${repoPath} carrier qualification must track its generated Rust SHA-256 import closure`,
    );
    invariant(
      task.options?.cache === false && task.options?.runFromWorkspaceRoot === true && task.options?.runInCI === true,
      `${repoPath} carrier qualification must run uncached from the workspace root in CI`,
    );
  }
  const wasixExactCandidateTrigger = readYaml("tools/release/moon.yml")
    .tasks?.["wasix-rust-exact-candidate-trigger"];
  invariant(object(wasixExactCandidateTrigger), "release-tools must define wasix-rust-exact-candidate-trigger");
  invariant(
    Array.isArray(wasixExactCandidateTrigger.inputs)
      && wasixExactCandidateTrigger.inputs.includes("/tools/release/rust-build-script-sha256.mjs"),
    "WASIX Rust exact-candidate trigger must track its generated Rust SHA-256 import closure",
  );
  invariant(!BUILDER_JOBS.has("liboliphaunt-wasix-aot-targets"), "WASIX AOT target planning must not be a builder job");

  const workflowJobs = new Set(Object.keys(ci.jobs));
  assertIncludes(workflowJobs, BUILDER_JOBS, "CI workflow builder jobs");
  const unmodeled = difference(workflowJobs, union(intersection(modeledJobs, BUILDER_JOBS), STABLE_CI_JOBS));
  invariant(unmodeled.size === 0, `CI workflow has unmodeled jobs ${formatSet(unmodeled)}`);
  const nonBuilderJobs = intersection(difference(modeledJobs, BUILDER_JOBS), workflowJobs);
  invariant(nonBuilderJobs.size === 0, `non-builder Moon jobs became workflow artifact jobs ${formatSet(nonBuilderJobs)}`);
}

function extensionNativeTargets(jobs, tasks) {
  const selectedTargets = nativeTargetSubsetForJobs(jobs, tasks);
  const matrix = extensionArtifactsNativeMatrix("all", selectedTargets ?? undefined);
  invariant(Array.isArray(matrix.include), "native extension artifact matrix must declare include rows");
  return new Set(matrix.include.map((row) => row.target));
}

function matrixProducts(matrix) {
  return new Set(
    (matrix.include ?? []).flatMap((row) => String(row.extensions_csv ?? "").split(",").filter(Boolean)),
  );
}

function assertExtensionSelection(product, allExtensionProducts) {
  const directProjects = new Set([product]);
  const directTasks = new Set([`${product}:assemble-release`]);
  const directJobs = planJobsForAffected(directProjects, directTasks);
  invariant(
    !directJobs.has("js-sdk-exact-candidate-consumer")
      && !directJobs.has("rust-sdk-exact-candidate-consumer"),
    `${product} focused extension plan must not expand into unrelated SDK exact-candidate consumers`,
  );
  const directSelection = selectedExtensionProductsForPlan(directProjects, directTasks, directJobs);
  assertSet(directSelection ?? new Set(), new Set([product]), `${product} direct extension selection`);
  assertSet(
    matrixProducts(extensionArtifactsNativeMatrix("all", undefined, directSelection)),
    new Set([product]),
    `${product} native matrix selection`,
  );
  const lifecycleLinux = extensionArtifactsNativeMatrixForPlan(
    directJobs,
    undefined,
    directSelection,
  ).include.find((row) => row.target === "linux-x64-gnu");
  const lifecycleProducts = extensionProductDependencyClosure(new Set([product]));
  assertSet(
    matrixProducts({ include: lifecycleLinux === undefined ? [] : [lifecycleLinux] }),
    lifecycleProducts,
    `${product} native lifecycle Linux matrix selection`,
  );
  const focusedShards = nativeExtensionLifecycleShardPlan(lifecycleProducts);
  invariant(
    focusedShards.shardCount === 1
      && focusedShards.matrix.include.length === 1
      && focusedShards.matrix.include[0].shard_count === 1,
    `${product} focused native lifecycle must use one nonempty planner-owned shard`,
  );
  assertSet(
    matrixProducts(extensionArtifactsWasixMatrixForPlan(directJobs, directSelection)),
    allExtensionProducts,
    `${product} single-extension PR regression WASIX matrix`,
  );
  assertSet(
    matrixProducts(
      extensionArtifactsWasixMatrixForPlan(
        new Set(["extension-artifacts-wasix"]),
        directSelection,
      ),
    ),
    new Set([product]),
    `${product} non-regression focused WASIX matrix`,
  );

  const aggregateTasks = new Set([
    `${product}:assemble-release`,
    "extension-artifacts-native:build-target",
    "extension-artifacts-wasix:build-target",
    "extension-packages:assemble-release",
  ]);
  const aggregateJobs = planJobsForAffected(directProjects, aggregateTasks);
  const aggregateSelection = selectedExtensionProductsForPlan(directProjects, aggregateTasks, aggregateJobs);
  assertSet(aggregateSelection ?? new Set(), new Set([product]), `${product} aggregate extension selection`);
  assertSet(matrixProducts(extensionArtifactsNativeMatrix("all", undefined, aggregateSelection)), new Set([product]), `${product} aggregate native matrix`);
  assertSet(matrixProducts(extensionArtifactsWasixMatrix("all", aggregateSelection)), new Set([product]), `${product} aggregate WASIX matrix`);
}

function expectPlanError(options, message) {
  let error;
  try {
    planForFullRun(options);
  } catch (cause) {
    error = cause;
  }
  invariant(error instanceof Error && error.message.includes(message), `invalid focused CI plan must fail with ${JSON.stringify(message)}`);
}

function checkCiBuilderPlanning(expectations) {
  const fullPlan = planForFullRun();
  assertSet(
    fullPlan.jobs,
    union(BASE_JOBS, BUILDER_JOBS, new Set([
      "native-extension-lifecycle",
      "rust-sdk-exact-candidate-consumer",
      "wasix-rust-exact-candidate-consumer",
    ])),
    "full CI builder and native lifecycle plan",
  );
  const fullSelection = selectedExtensionProductsForPlan(
    fullPlan.projects,
    fullPlan.tasks,
    fullPlan.jobs,
  );
  const fullLifecycleProducts = extensionProductDependencyClosure(fullSelection ?? new Set());
  assertSet(
    fullLifecycleProducts,
    expectations.extensionProducts,
    "main, manual, and release-qualification native lifecycle exhaustive catalog",
  );
  const fullShards = nativeExtensionLifecycleShardPlan(fullLifecycleProducts);
  invariant(
    fullShards.shardCount === NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT
      && fullShards.matrix.include.length === NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT
      && fullShards.matrix.include.every(
        (row) => row.shard_count === NATIVE_EXTENSION_LIFECYCLE_EXHAUSTIVE_SHARD_COUNT,
      ),
    "main, manual, and release qualification must use the exhaustive three-shard plan",
  );
  assertSet(
    planForFullRun({ wasmTarget: "linux-x64-gnu" }).jobs,
    new Set([
      "affected",
      "extension-artifacts-wasix",
      "liboliphaunt-wasix-runtime",
      "liboliphaunt-wasix-aot",
    ]),
    "focused WASIX CI plan",
  );
  assertSet(
    planJobsForAffected(
      new Set(["liboliphaunt-wasix"]),
      new Set(["liboliphaunt-wasix:runtime-portable"]),
    ),
    new Set([
      "affected",
      "extension-artifacts-wasix",
      "liboliphaunt-wasix-aot",
      "liboliphaunt-wasix-release-assets",
      "liboliphaunt-wasix-runtime",
      "wasix-rust-exact-candidate-consumer",
      "wasix-rust-package",
    ]),
    "affected WASIX release-regression producer plan",
  );

  const mobilePlans = {
    android: [
      "affected",
      "extension-artifacts-native",
      "kotlin-maven-staging",
      "kotlin-sdk-package",
      "liboliphaunt-native-android",
      "liboliphaunt-native-ios",
      "mobile-build-android",
      "mobile-extension-packages",
      "react-native-sdk-package",
    ],
    ios: [
      "affected",
      "extension-artifacts-native",
      "liboliphaunt-native-ios",
      "mobile-build-ios",
      "mobile-extension-packages",
      "react-native-sdk-package",
      "swift-sdk-package",
    ],
  };
  for (const [mobileTarget, expectedJobs] of Object.entries(mobilePlans)) {
    const focused = planForFullRun({ mobileTarget });
    assertSet(focused.jobs, new Set(expectedJobs), `focused ${mobileTarget} CI plan`);
    assertSet(
      mobileE2eJobsForPlan(focused.jobs),
      new Set([`mobile-e2e-${mobileTarget}`]),
      `focused ${mobileTarget} E2E plan`,
    );
  }

  for (const [mobileTarget, nativeTarget] of [["android", "android-arm64-v8a"], ["ios", "ios-xcframework"]]) {
    const plan = planForFullRun({ mobileTarget, nativeTarget });
    assertSet(plan.selectedTargets ?? new Set(), new Set([nativeTarget]), `${mobileTarget} focused native targets`);
    assertSet(mobileExtensionPackageNativeTargets(plan.jobs, plan.selectedTargets), new Set([nativeTarget]), `${mobileTarget} mobile extension targets`);
  }
  expectPlanError({ nativeTarget: "ios-xcframework", mobileTarget: "android" }, "not valid for mobile_target=android");
  expectPlanError({ nativeTarget: "android-arm64-v8a", mobileTarget: "both" }, "mobile_target=both requires native_target=all");
  for (const options of [
    { wasmTarget: "linux-x64-gnu", nativeTarget: "linux-x64-gnu" },
    { wasmTarget: "linux-x64-gnu", mobileTarget: "android" },
    { wasmTarget: "linux-x64-gnu", nativeTarget: "ios-xcframework", mobileTarget: "ios" },
  ]) {
    expectPlanError(options, "wasm_target focus cannot be combined");
  }

  const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
  const assertBuilderClosure = (jobs, selectedTargets, label, nativeTarget = "all") => {
    for (const job of jobs) {
      if (!BUILDER_JOBS.has(job)) continue;
      const needs = Array.isArray(ci.jobs[job]?.needs) ? ci.jobs[job].needs : [ci.jobs[job]?.needs].filter(Boolean);
      for (const dependency of needs) {
        invariant(
          !BUILDER_JOBS.has(dependency) || jobs.has(dependency),
          `${label} selects ${job} without required builder ${dependency}`,
        );
      }
    }
    if (jobs.has("liboliphaunt-native-ios")) {
      invariant(
        (liboliphauntNativeIosRuntimeMatrixForPlan(jobs, selectedTargets, nativeTarget).include ?? []).length > 0,
        `${label} selects the iOS runtime producer with an empty target matrix`,
      );
    }
  };
  for (const targets of Object.values(CI_JOB_TARGETS)) {
    for (const target of targets) {
      const tasks = new Set([target]);
      const jobs = planJobsForAffected(new Set(), tasks);
      assertBuilderClosure(jobs, nativeTargetSubsetForJobs(jobs, tasks), `singleton affected task ${target}`);
    }
  }
  for (const [label, options] of [
    ["full dispatch", {}],
    ...["macos-arm64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64-msvc"]
      .map((wasmTarget) => [`focused WASIX ${wasmTarget}`, { wasmTarget }]),
    ...["macos-arm64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64-msvc", "android-arm64-v8a", "android-x86_64", "ios-xcframework"]
      .map((nativeTarget) => [`focused native ${nativeTarget}`, { nativeTarget }]),
    ["focused mobile android", { mobileTarget: "android" }],
    ["focused mobile ios", { mobileTarget: "ios" }],
    ["focused mobile both", { mobileTarget: "both" }],
    ["focused mobile android arm64", { mobileTarget: "android", nativeTarget: "android-arm64-v8a" }],
    ["focused mobile android x86_64", { mobileTarget: "android", nativeTarget: "android-x86_64" }],
    ["focused mobile ios target", { mobileTarget: "ios", nativeTarget: "ios-xcframework" }],
  ]) {
    const plan = planForFullRun(options);
    assertBuilderClosure(plan.jobs, plan.selectedTargets, label, options.nativeTarget ?? "all");
  }

  for (const nativeTarget of ["macos-arm64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64-msvc", "all"]) {
    const rendered = renderPlanForFullRun({ nativeTarget });
    assertJsExactCandidatePlanClosure(rendered);
    const expectedTargets = nativeTarget === "all"
      ? new Set(["macos-arm64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64-msvc"])
      : new Set([nativeTarget]);
    assertSet(
      new Set(rendered.js_exact_candidate_consumer_matrix.include.map(({ target }) => target)),
      expectedTargets,
      `focused ${nativeTarget} JavaScript exact-candidate targets`,
    );
  }

  const brokerAffectedProjects = new Set(["oliphaunt-broker"]);
  const brokerAffectedTasks = new Set(["oliphaunt-broker:release-assets"]);
  const brokerAffectedJobs = planJobsForAffected(brokerAffectedProjects, brokerAffectedTasks);
  const brokerAffectedTargets = nativeTargetSubsetForJobs(brokerAffectedJobs, brokerAffectedTasks);
  const brokerAffectedPlan = renderPlanWithSelection({
    jobs: brokerAffectedJobs,
    projects: brokerAffectedProjects,
    tasks: brokerAffectedTasks,
    reason: "broker affected policy fixture",
    selectedTargets: brokerAffectedTargets,
    selectedExtensionProducts: selectedExtensionProductsForPlan(
      brokerAffectedProjects,
      brokerAffectedTasks,
      brokerAffectedJobs,
    ),
    nativeTarget: "all",
  });
  assertJsExactCandidatePlanClosure(brokerAffectedPlan);

  const taskCases = [
    {
      label: "React Native SDK",
      task: "oliphaunt-react-native:package-artifacts",
      jobs: union(BASE_JOBS, new Set([...mobilePlans.android.slice(1), ...mobilePlans.ios.slice(1)])),
      targets: new Set(["android-arm64-v8a", "android-x86_64", "ios-xcframework"]),
    },
    {
      label: "Swift SDK",
      task: "oliphaunt-swift:package-artifacts",
      jobs: union(BASE_JOBS, new Set(["liboliphaunt-native-ios", "swift-sdk-package"])),
      targets: new Set(["ios-xcframework"]),
    },
    {
      label: "Kotlin SDK",
      task: "oliphaunt-kotlin:package-artifacts",
      jobs: union(BASE_JOBS, new Set(["kotlin-maven-staging", "kotlin-sdk-package"])),
    },
    {
      label: "Rust SDK",
      task: "oliphaunt-rust:package-artifacts",
      jobs: union(BASE_JOBS, new Set([
        "broker-runtime",
        "extension-artifacts-native",
        "liboliphaunt-native-desktop",
        "native-extension-lifecycle",
        "rust-sdk-exact-candidate-consumer",
        "rust-sdk-package",
      ])),
      targets: new Set(["linux-x64-gnu"]),
    },
    {
      label: "TypeScript SDK",
      task: "oliphaunt-js:package-artifacts",
      jobs: union(BASE_JOBS, new Set([
        "broker-runtime",
        "extension-artifacts-native",
        "js-sdk-exact-candidate-consumer",
        "js-sdk-package",
        "liboliphaunt-native-desktop",
        "liboliphaunt-native-ios",
        "node-direct",
      ])),
    },
    {
      label: "WASIX Rust SDK",
      task: "oliphaunt-wasix-rust:package-artifacts",
      jobs: union(BASE_JOBS, new Set([
        "extension-artifacts-wasix",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-release-assets",
        "liboliphaunt-wasix-runtime",
        "wasix-rust-exact-candidate-consumer",
        "wasix-rust-package",
      ])),
    },
    {
      label: "JavaScript exact-candidate helpers",
      task: "release-tools:js-exact-candidate-trigger",
      jobs: union(BASE_JOBS, new Set([
        "broker-runtime",
        "extension-artifacts-native",
        "js-sdk-exact-candidate-consumer",
        "js-sdk-package",
        "liboliphaunt-native-desktop",
        "liboliphaunt-native-ios",
        "node-direct",
      ])),
      jsTargets: new Set([
        "linux-arm64-gnu",
        "linux-x64-gnu",
        "macos-arm64",
        "windows-x64-msvc",
      ]),
    },
    {
      label: "WASIX Rust exact-candidate helper",
      task: "release-tools:wasix-rust-exact-candidate-trigger",
      jobs: union(BASE_JOBS, new Set([
        "extension-artifacts-wasix",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-release-assets",
        "liboliphaunt-wasix-runtime",
        "wasix-rust-exact-candidate-consumer",
        "wasix-rust-package",
      ])),
    },
  ];
  for (const entry of taskCases) {
    const tasks = new Set([entry.task]);
    const jobs = planJobsForAffected(new Set(), tasks);
    assertSet(jobs, entry.jobs, `${entry.label} affected plan`);
    if (entry.targets !== undefined) {
      assertSet(nativeTargetSubsetForJobs(jobs, tasks) ?? new Set(), entry.targets, `${entry.label} native targets`);
    }
    if (entry.jsTargets !== undefined) {
      const rendered = renderPlanWithSelection({
        jobs,
        projects: new Set(),
        tasks,
        reason: `${entry.label} policy fixture`,
        selectedTargets: nativeTargetSubsetForJobs(jobs, tasks),
        selectedExtensionProducts: selectedExtensionProductsForPlan(new Set(), tasks, jobs),
        nativeTarget: "all",
      });
      assertJsExactCandidatePlanClosure(rendered);
      assertSet(
        new Set(rendered.js_exact_candidate_consumer_matrix.include.map(({ target }) => target)),
        entry.jsTargets,
        `${entry.label} consumer targets`,
      );
    }
  }

  assertExtensionSelection("oliphaunt-extension-vector", expectations.extensionProducts);
  assertExtensionSelection(CONTRIB_BUNDLE_PRODUCT, expectations.extensionProducts);
  assertSet(
    extensionProductDependencyClosure(new Set([CONTRIB_BUNDLE_PRODUCT])),
    new Set([CONTRIB_BUNDLE_PRODUCT]),
    "focused native lifecycle keeps contrib dependency closure within its linked bundle",
  );
  assertSet(
    selectedExtensionProductsForPlan(
      new Set(["extensions"]),
      new Set(["extension-packages:assemble-release"]),
      new Set(["extension-packages", "extension-artifacts-native", "extension-artifacts-wasix"]),
    ) ?? new Set(),
    expectations.extensionProducts,
    "broad extension catalog selection",
  );
  assertSet(
    selectedExtensionProductsForPlan(
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
    ) ?? new Set(),
    expectations.extensionProducts,
    "full extension builder selection",
  );
  assertSet(
    selectedExtensionProductsForPlan(
      new Set(),
      new Set(["oliphaunt-react-native:mobile-build-android"]),
      new Set(["mobile-build-android", "mobile-extension-packages", "extension-artifacts-native"]),
    ) ?? new Set(),
    expectations.extensionProducts,
    "mobile installed-app all-extension selection",
  );

  for (const [platform, task, expectedTargets] of [
    ["Android", "oliphaunt-react-native:mobile-build-android", new Set(["android-arm64-v8a", "android-x86_64"])],
    ["iOS", "oliphaunt-react-native:mobile-build-ios", new Set(["ios-xcframework"])],
  ]) {
    const tasks = new Set([task]);
    const jobs = planJobsForAffected(new Set(), tasks);
    invariant(jobs.has("extension-artifacts-native"), `${platform} app builds must include extension artifacts`);
    assertSet(extensionNativeTargets(jobs, tasks), expectedTargets, `${platform} extension artifact targets`);
  }
  for (const platform of ["android", "ios"]) {
    assertSet(
      planJobsForAffected(new Set(), new Set([`oliphaunt-react-native:mobile-e2e-${platform}`])),
      BASE_JOBS,
      `${platform} E2E affected plan`,
    );
  }

  const releaseTargets = new Set(
    allArtifactTargets(
      { product: "liboliphaunt-native", kind: "native-runtime", publishedOnly: true },
      "release-policy",
    )
      .filter((target) => target.extensionArtifacts)
      .map((target) => target.target),
  );
  const extensionTasks = new Set(["extension-packages:assemble-release"]);
  assertSet(
    extensionNativeTargets(planJobsForAffected(new Set(), extensionTasks), extensionTasks),
    releaseTargets,
    "full extension package native targets",
  );
}

export function runReleasePolicyChecks() {
  const expectations = releasePolicyExpectations();
  const graph = validateReleasePolicyModel(loadGraph("release-policy"), expectations);
  validatePublicationModel(graph, loadPublicationCatalog("release-policy"));
  checkReleasePlanning(graph, expectations);
  checkCiWorkflowPolicy();
  checkCiBuilderPlanning(expectations);
}

function main() {
  try {
    runReleasePolicyChecks();
    console.log("release policy checks passed");
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}

if (import.meta.main) main();
