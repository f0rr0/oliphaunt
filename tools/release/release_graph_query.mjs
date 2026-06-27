#!/usr/bin/env bun
import {
  allArtifactTargets,
  ciNpmPackageArtifactRows,
  ciReleaseAssetArtifactRows,
  currentProductVersionSync,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  exactExtensionProducts,
  expectedAssetRows,
  localPublishArtifactRows,
  rawArtifactTargetRows,
  registryPackageRows,
  sdkPackageProducts,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import {
  buildPlan,
  compatibilityVersionEntries,
  compareText,
  loadGraph,
  moonProjectRows,
  moonReleaseMetadataRows,
  normalizeFiles,
  productConfigRows,
  releaseOrder,
  releaseProductProjectId,
} from "./release-graph.mjs";
import {
  wasixCargoArtifactContract,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

const TOOL = "release_graph_query.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(2);
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

function printJson(value) {
  console.log(JSON.stringify(sortedValue(value), null, 2));
}

function parseJsonFlag(argv, name, { required = false } = {}) {
  const raw = stringFlag(argv, name, { required });
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`--${name} must be valid JSON: ${error.message}`);
  }
}

function stringFlag(argv, name, { required = false } = {}) {
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
  if (required) {
    fail(`${flag} is required`);
  }
  return undefined;
}

function changedFiles(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--changed-file") {
      if (index + 1 >= argv.length) {
        fail("--changed-file requires a value");
      }
      files.push(argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--changed-file=")) {
      files.push(value.slice("--changed-file=".length));
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return files;
}

function assertStringList(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${label} must be a JSON string list`);
  }
  return value;
}

function graphProductProjects(graph) {
  const products = graph.products;
  const projects = graph.moon_projects;
  return Object.fromEntries(
    Object.keys(products)
      .sort(compareText)
      .map((product) => [
        product,
        releaseProductProjectId(product, products, projects, TOOL),
      ]),
  );
}

function runGraph() {
  printJson(loadGraph(TOOL));
}

function runProductProjects() {
  printJson(graphProductProjects(loadGraph(TOOL)));
}

function runProductConfigs(argv) {
  let product;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (product !== undefined && product.length === 0) {
    fail("--product values must be non-empty");
  }
  printJson(productConfigRows({ product }, TOOL));
}

function runMoonReleaseMetadata(argv) {
  let product;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (product !== undefined && product.length === 0) {
    fail("--product values must be non-empty");
  }
  printJson(moonReleaseMetadataRows({ product }, TOOL));
}

function runMoonProjects(argv) {
  let project;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") {
      if (index + 1 >= argv.length) {
        fail("--project requires a value");
      }
      project = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--project=")) {
      project = value.slice("--project=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (project !== undefined && project.length === 0) {
    fail("--project values must be non-empty");
  }
  printJson(moonProjectRows({ project }, TOOL));
}

function runReleaseOrder(argv) {
  const graph = loadGraph(TOOL);
  const selected = assertStringList(
    parseJsonFlag(argv, "products-json", { required: true }),
    "--products-json",
  );
  const known = new Set(Object.keys(graph.products));
  const unknown = [...new Set(selected)].filter((product) => !known.has(product)).sort(compareText);
  if (unknown.length > 0) {
    fail(`unknown release products: ${unknown.join(", ")}`);
  }
  printJson(releaseOrder(graph.products, graph.moon_projects, selected, TOOL));
}

function runPlan(argv) {
  const graph = loadGraph(TOOL);
  printJson(buildPlan(graph, normalizeFiles(changedFiles(argv)), TOOL));
}

function runPlansForPaths(argv) {
  const paths = assertStringList(
    parseJsonFlag(argv, "paths-json", { required: true }),
    "--paths-json",
  );
  const graph = loadGraph(TOOL);
  printJson(
    Object.fromEntries(
      paths
        .map((file) => [file, buildPlan(graph, normalizeFiles([file]), TOOL)])
        .sort(([left], [right]) => compareText(left, right)),
    ),
  );
}

function parseArtifactTargetOptions(argv) {
  let product;
  let kind;
  let surface;
  let publishedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      product = argv[++index];
      if (!product) {
        fail("--product requires a value");
      }
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--kind") {
      kind = argv[++index];
      if (!kind) {
        fail("--kind requires a value");
      }
    } else if (value.startsWith("--kind=")) {
      kind = value.slice("--kind=".length);
    } else if (value === "--surface") {
      surface = argv[++index];
      if (!surface) {
        fail("--surface requires a value");
      }
    } else if (value.startsWith("--surface=")) {
      surface = value.slice("--surface=".length);
    } else if (value === "--published-only") {
      publishedOnly = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return { product, kind, surface, publishedOnly };
}

function runArtifactTargets(argv) {
  printJson(allArtifactTargets(parseArtifactTargetOptions(argv), TOOL));
}

function runRawArtifactTargets(argv) {
  const { product, kind, surface, publishedOnly } = parseArtifactTargetOptions(argv);
  printJson(
    rawArtifactTargetRows(TOOL).filter((target) => {
      if (product !== undefined && target.product !== product) {
        return false;
      }
      if (kind !== undefined && target.kind !== kind) {
        return false;
      }
      if (surface !== undefined && !target.surfaces?.includes(surface)) {
        return false;
      }
      if (publishedOnly && target.published !== true) {
        return false;
      }
      return true;
    }),
  );
}

function runExtensionTargets(argv) {
  let product;
  let family;
  let publishedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--family") {
      if (index + 1 >= argv.length) {
        fail("--family requires a value");
      }
      family = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--family=")) {
      family = value.slice("--family=".length);
    } else if (value === "--published-only") {
      publishedOnly = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (family !== undefined && !["native", "wasix"].includes(family)) {
    fail("--family must be native or wasix");
  }
  printJson(extensionArtifactTargets({ product, family, publishedOnly }, TOOL));
}

function runWasixCargoArtifactContract() {
  printJson(wasixCargoArtifactContract());
}

function runWasixExtensionPackageNames(argv) {
  let product;
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--target") {
      if (index + 1 >= argv.length) {
        fail("--target requires a value");
      }
      targets.push(argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--target=")) {
      targets.push(value.slice("--target=".length));
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (product === undefined || product.length === 0) {
    fail("--product is required");
  }
  for (const target of targets) {
    if (target.length === 0) {
      fail("--target values must be non-empty");
    }
  }
  printJson({
    product,
    packageName: wasixExtensionPackageName(product),
    aotPackages: targets.map((target) => ({
      target,
      packageName: wasixExtensionAotPackageName(product, target),
    })),
  });
}

function runCompatibilityVersionEntries(argv) {
  let requireSourceProduct = false;
  for (const value of argv) {
    if (value === "--require-source-product") {
      requireSourceProduct = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  printJson(compatibilityVersionEntries(loadGraph(TOOL).products, { requireSourceProduct, prefix: TOOL }));
}

function runProductVersions(argv) {
  let product;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  const products = product === undefined ? Object.keys(loadGraph(TOOL).products).sort(compareText) : [product];
  printJson(
    products.map((productId) => ({
      product: productId,
      version: currentProductVersionSync(productId, TOOL),
    })),
  );
}

function runTypescriptOptionalRuntimePackageVersions(argv) {
  for (const value of argv) {
    fail(`unknown argument ${value}`);
  }
  printJson(
    typescriptOptionalRuntimePackageProducts(TOOL).map((row) => ({
      ...row,
      version: currentProductVersionSync(row.product, TOOL),
    })),
  );
}

function runSdkPackageProducts(argv) {
  let product;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  const rows = sdkPackageProducts(TOOL);
  if (product === undefined) {
    printJson(rows);
    return;
  }
  const matches = rows.filter((row) => row.product === product);
  if (matches.length !== 1) {
    fail(`${product} is not an SDK release product`);
  }
  printJson(matches);
}

function runCiArtifactNames(argv) {
  let family;
  let product;
  let kind;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--family") {
      if (index + 1 >= argv.length) {
        fail("--family requires a value");
      }
      family = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--family=")) {
      family = value.slice("--family=".length);
    } else if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--kind") {
      if (index + 1 >= argv.length) {
        fail("--kind requires a value");
      }
      kind = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--kind=")) {
      kind = value.slice("--kind=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (family === undefined) {
    fail("--family is required");
  }
  if (product === undefined) {
    fail("--product is required");
  }
  if (kind === undefined) {
    fail("--kind is required");
  }
  if (family === "release-assets") {
    printJson(ciReleaseAssetArtifactRows(product, kind, TOOL));
  } else if (family === "npm-package") {
    printJson(ciNpmPackageArtifactRows(product, kind, TOOL));
  } else {
    fail("--family must be release-assets or npm-package");
  }
}

function runLocalPublishArtifacts(argv) {
  let aggregateOnly = false;
  for (const value of argv) {
    if (value === "--aggregate-only") {
      aggregateOnly = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  printJson(localPublishArtifactRows({ aggregateOnly }, TOOL));
}

function runExpectedAssets(argv) {
  let product;
  let version;
  let surface = "github-release";
  let publishedOnly = true;
  const kinds = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--version") {
      if (index + 1 >= argv.length) {
        fail("--version requires a value");
      }
      version = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--version=")) {
      version = value.slice("--version=".length);
    } else if (value === "--surface") {
      if (index + 1 >= argv.length) {
        fail("--surface requires a value");
      }
      surface = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--surface=")) {
      surface = value.slice("--surface=".length);
    } else if (value === "--kind") {
      if (index + 1 >= argv.length) {
        fail("--kind requires a value");
      }
      kinds.push(argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--kind=")) {
      kinds.push(value.slice("--kind=".length));
    } else if (value === "--include-unpublished") {
      publishedOnly = false;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (product === undefined) {
    fail("--product is required");
  }
  if (version === undefined) {
    fail("--version is required");
  }
  printJson(expectedAssetRows({
    product,
    version,
    surface,
    publishedOnly,
    kinds: kinds.length === 0 ? undefined : kinds,
  }, TOOL));
}

function runRegistryPackages(argv) {
  let product;
  let packageKind;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--kind") {
      if (index + 1 >= argv.length) {
        fail("--kind requires a value");
      }
      packageKind = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--kind=")) {
      packageKind = value.slice("--kind=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (product === undefined) {
    fail("--product is required");
  }
  printJson(registryPackageRows({ product, packageKind }, TOOL));
}

function runExtensionMetadata(argv) {
  let product;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  const products = product === undefined ? exactExtensionProducts(TOOL) : [product];
  printJson(
    products.map((productId) => ({
      product: productId,
      ...extensionMetadata(productId, TOOL),
      sourceIdentity: extensionSourceIdentity(productId, TOOL),
    })),
  );
}

function usage() {
  return `usage: tools/release/release_graph_query.mjs <command> [options]

Commands:
  graph
  product-projects
  product-configs [--product PRODUCT]
  moon-release-metadata [--product PRODUCT]
  moon-projects [--project PROJECT]
  release-order --products-json JSON
  plan [--changed-file PATH...]
  plans-for-paths --paths-json JSON
  artifact-targets [--product PRODUCT] [--kind KIND] [--surface SURFACE] [--published-only]
  raw-artifact-targets [--product PRODUCT] [--kind KIND] [--surface SURFACE] [--published-only]
  extension-targets [--product PRODUCT] [--family native|wasix] [--published-only]
  extension-metadata [--product PRODUCT]
  product-versions [--product PRODUCT]
  typescript-optional-runtime-package-versions
  sdk-package-products [--product PRODUCT]
  ci-artifact-names --family release-assets|npm-package --product PRODUCT --kind KIND
  local-publish-artifacts [--aggregate-only]
  expected-assets --product PRODUCT --version VERSION [--surface SURFACE] [--kind KIND...] [--include-unpublished]
  registry-packages --product PRODUCT [--kind KIND]
  wasix-extension-package-names --product PRODUCT [--target TARGET...]
  compatibility-version-entries [--require-source-product]
  wasix-cargo-artifact-contract
`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "graph") {
    runGraph();
  } else if (command === "product-projects") {
    runProductProjects();
  } else if (command === "product-configs") {
    runProductConfigs(rest);
  } else if (command === "moon-release-metadata") {
    runMoonReleaseMetadata(rest);
  } else if (command === "moon-projects") {
    runMoonProjects(rest);
  } else if (command === "release-order") {
    runReleaseOrder(rest);
  } else if (command === "plan") {
    runPlan(rest);
  } else if (command === "plans-for-paths") {
    runPlansForPaths(rest);
  } else if (command === "artifact-targets") {
    runArtifactTargets(rest);
  } else if (command === "raw-artifact-targets") {
    runRawArtifactTargets(rest);
  } else if (command === "extension-targets") {
    runExtensionTargets(rest);
  } else if (command === "extension-metadata") {
    runExtensionMetadata(rest);
  } else if (command === "product-versions") {
    runProductVersions(rest);
  } else if (command === "typescript-optional-runtime-package-versions") {
    runTypescriptOptionalRuntimePackageVersions(rest);
  } else if (command === "sdk-package-products") {
    runSdkPackageProducts(rest);
  } else if (command === "ci-artifact-names") {
    runCiArtifactNames(rest);
  } else if (command === "local-publish-artifacts") {
    runLocalPublishArtifacts(rest);
  } else if (command === "expected-assets") {
    runExpectedAssets(rest);
  } else if (command === "registry-packages") {
    runRegistryPackages(rest);
  } else if (command === "compatibility-version-entries") {
    runCompatibilityVersionEntries(rest);
  } else if (command === "wasix-extension-package-names") {
    runWasixExtensionPackageNames(rest);
  } else if (command === "wasix-cargo-artifact-contract") {
    runWasixCargoArtifactContract();
  } else if (command === "--help" || command === "-h") {
    console.log(usage());
  } else {
    fail(command ? `unknown command ${command}` : "missing command");
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
