#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { currentVersion } from "./product-version.mjs";
import {
  ROOT,
  assertStringList as graphAssertStringList,
  commandJson,
  compareVersion,
  formatVersion,
  loadGraph,
  parseStableVersion as graphParseStableVersion,
  releaseProductProjectId as graphReleaseProductProjectId,
  runtimeTiedContribProducts,
  tagMatchPattern,
  tagPrefixes as graphTagPrefixes,
} from "./release-graph.mjs";

const TOOL = "check_release_versions.mjs";
const REGISTRY_TARGETS = new Set(["crates-io", "npm", "jsr", "maven-central"]);

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function readText(relativePath) {
  return readFileSync(`${ROOT}/${relativePath}`, "utf8");
}

function gitOutput(args) {
  const result = captureCommandOutput("git", args, {
    cwd: ROOT,
    label: `git ${args.join(" ")}`,
    stdoutTerminator: "\n",
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(result.error?.message || result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    fail(`failed to run ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseStableVersion(version) {
  return graphParseStableVersion(version, TOOL);
}

function assertStringList(value, context) {
  return graphAssertStringList(value, context, TOOL);
}

function parseProducts(raw, graph) {
  const products = graph.products;
  if (products === null || Array.isArray(products) || typeof products !== "object") {
    fail("release metadata must define [products.<id>] entries");
  }
  if (raw === undefined) {
    return Object.keys(products).sort();
  }
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("--products-json must be a JSON string list");
  }
  const unknown = value.filter((product) => !(product in products)).sort();
  if (unknown.length > 0) {
    fail(`unknown release products: ${unknown.join(", ")}`);
  }
  return value;
}

function registryCommand(args) {
  return [process.execPath, "tools/release/check_registry_publication.mjs", ...args];
}

function registryRun(args) {
  run(registryCommand(args));
}

function registryJson(args) {
  return commandJson(registryCommand(args), TOOL);
}

function registryAssertProductPublication(product, { requirePublished, versionOverride } = {}) {
  const args = ["--product", product, requirePublished ? "--require-published" : "--require-unpublished"];
  if (versionOverride !== undefined) {
    args.push("--version", versionOverride);
  }
  registryRun(args);
}

function registryQueryProductPublication(product) {
  const data = registryJson(["query-product-publication", "--product", product]);
  if (!Array.isArray(data.packages) || !Array.isArray(data.missing) || !Array.isArray(data.published)) {
    fail("registry publication helper returned malformed publication status");
  }
  return data;
}

function verifyGithubReleaseAssets(product, version) {
  run([
    process.execPath,
    "tools/release/check_github_release_assets.mjs",
    product,
    "--version",
    version,
    "--default-assets",
  ]);
}

function tagPrefixes(config) {
  return graphTagPrefixes(config, TOOL);
}

function productTags(prefix) {
  const args = ["tag", "--list", tagMatchPattern(prefix)];
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput: true,
    cwd: ROOT,
    label: `git ${args.join(" ")}`,
    stdoutTerminator: "\n",
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(result.error?.message || result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tagVersion(prefix, tag) {
  if (!tag.startsWith(prefix)) {
    return undefined;
  }
  const version = tag.slice(prefix.length);
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) {
    return undefined;
  }
  return parseStableVersion(version);
}

function tagCommit(tag) {
  return gitOutput(["rev-list", "-n", "1", tag]);
}

function commitParents(commit) {
  return gitOutput(["rev-list", "--parents", "-n", "1", commit])
    .split(/\s+/u)
    .filter(Boolean)
    .slice(1);
}

function tagExists(tag) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return result.status === 0;
}

function commitForRef(ref) {
  return gitOutput(["rev-parse", `${ref}^{commit}`]);
}

function validateSwiftpmVersionTag(product, version, headCommit) {
  if (product !== "oliphaunt-swift") {
    return;
  }
  const existing = tagExists(version) ? tagCommit(version) : null;
  if (existing === null) {
    return;
  }
  const parents = commitParents(existing);
  const sourceCommit = parents.length === 1 ? parents[0] : existing;
  if (sourceCommit === headCommit) {
    console.log(`SwiftPM version tag ${version} is bound to release commit ${headCommit}`);
    return;
  }
  fail(
    `SwiftPM version tag ${version} already exists at ${existing}, whose source parent is ${sourceCommit}, not exact release commit ${headCommit}`,
  );
}

function reactNativeCompatibilityVersions() {
  const packageJson = JSON.parse(readText("src/sdks/react-native/package.json"));
  const metadata = packageJson.oliphaunt;
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail("React Native package.json must declare oliphaunt compatibility metadata");
  }
  if (typeof metadata.swiftSdkVersion !== "string" || typeof metadata.kotlinSdkVersion !== "string") {
    fail("React Native compatibility metadata must include Swift and Kotlin SDK versions");
  }
  return [metadata.swiftSdkVersion, metadata.kotlinSdkVersion];
}

function typescriptCompatibilityVersions() {
  const packageJson = JSON.parse(readText("src/sdks/js/package.json"));
  const metadata = packageJson.oliphaunt;
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail("TypeScript package.json must declare oliphaunt compatibility metadata");
  }
  if (
    typeof metadata.liboliphauntVersion !== "string" ||
    typeof metadata.brokerVersion !== "string" ||
    typeof metadata.nodeDirectAddonVersion !== "string"
  ) {
    fail("TypeScript compatibility metadata must include liboliphaunt, broker, and Node direct versions");
  }
  return [metadata.liboliphauntVersion, metadata.brokerVersion, metadata.nodeDirectAddonVersion];
}

async function dependencyVersionFor(consumer, dependency) {
  if (consumer === "oliphaunt-swift" && dependency === "liboliphaunt-native") {
    return readText("src/sdks/swift/LIBOLIPHAUNT_VERSION").trim();
  }
  if (consumer === "oliphaunt-react-native" && dependency === "oliphaunt-swift") {
    return reactNativeCompatibilityVersions()[0];
  }
  if (consumer === "oliphaunt-react-native" && dependency === "oliphaunt-kotlin") {
    return reactNativeCompatibilityVersions()[1];
  }
  if (consumer === "oliphaunt-js" && dependency === "liboliphaunt-native") {
    return typescriptCompatibilityVersions()[0];
  }
  if (consumer === "oliphaunt-js" && dependency === "oliphaunt-broker") {
    return typescriptCompatibilityVersions()[1];
  }
  if (consumer === "oliphaunt-js" && dependency === "oliphaunt-node-direct") {
    return typescriptCompatibilityVersions()[2];
  }
  return currentVersion(dependency);
}

async function validateProduct(product, config, headRef) {
  if (typeof config.tag_prefix !== "string" || config.tag_prefix.length === 0) {
    fail(`${product} must declare tag_prefix`);
  }
  const version = await currentVersion(product);
  const current = parseStableVersion(version);
  const currentTag = `${config.tag_prefix}${version}`;
  const headCommit = commitForRef(headRef);
  const tags = productTags(config.tag_prefix);
  if (tags.includes(currentTag)) {
    const currentTagCommit = tagCommit(currentTag);
    if (currentTagCommit !== headCommit) {
      fail(
        `${product} version ${version} is already tagged as ${currentTag} at ${currentTagCommit}, not exact release commit ${headCommit}; every different commit requires a new version`,
      );
    }
    validateSwiftpmVersionTag(product, version, headCommit);
    return true;
  }
  validateSwiftpmVersionTag(product, version, headCommit);
  const previousVersions = [];
  for (const candidatePrefix of tagPrefixes(config)) {
    for (const tag of productTags(candidatePrefix)) {
      const parsed = tagVersion(candidatePrefix, tag);
      if (parsed !== undefined) {
        previousVersions.push(parsed);
      }
    }
  }
  if (previousVersions.length > 0) {
    const latest = previousVersions.reduce((max, candidate) =>
      compareVersion(candidate, max) > 0 ? candidate : max,
    );
    if (compareVersion(current, latest) <= 0) {
      fail(
        `${product} version ${version} is not newer than latest tagged version ${formatVersion(
          latest,
        )}; merge the release-please release PR before publishing`,
      );
    }
  }
  return false;
}

async function validateRegistryPublication(products, graph, currentTagAtHead, headRef) {
  const graphProducts = graph.products;
  const headCommit = commitForRef(headRef);
  for (const product of products) {
    const config = graphProducts[product];
    const targets = assertStringList(config.publish_targets ?? [], `${product}.publish_targets`);
    const registryTargets = targets.filter((target) => REGISTRY_TARGETS.has(target));
    if (registryTargets.length === 0) {
      continue;
    }
    if (currentTagAtHead[product] === true) {
      const { packages, missing, published } = registryQueryProductPublication(product);
      if (packages.length === 0) {
        console.log(`${product} has no external registry packages to check`);
        continue;
      }
      console.log(
        `${product} registry completion check: ${published.length} published, ${missing.length} missing`,
      );
      continue;
    }
    const { packages, published } = registryQueryProductPublication(product);
    if (packages.length === 0) {
      console.log(`${product} has no external registry packages to check`);
      continue;
    }
    if (published.length > 0) {
      if (typeof config.tag_prefix !== "string" || config.tag_prefix.length === 0) {
        fail(`${product} must declare tag_prefix`);
      }
      const version = await currentVersion(product);
      const currentTag = `${config.tag_prefix}${version}`;
      console.log(
        `${product} has registry versions awaiting workflow finalization: ${published
          .map((item) => String(item.label))
          .join(", ")}; ${currentTag} is not yet exact at ${headCommit}. The protected publish workflow must prove these versions with the immutable bootstrap ledger before it stages exact-SHA tags; never create product tags manually.`,
      );
      continue;
    }
    console.log(
      `${product} registry unpublished check passed: ${packages.map((item) => String(item.label)).join(", ")}`,
    );
  }
}

function releaseProductProjectId(product, products, projects) {
  return graphReleaseProductProjectId(product, products, projects, TOOL);
}

function validateReleasedDependencyArtifacts(consumer, dependency, dependencyVersion, graph) {
  const dependencyConfig = graph.products[dependency];
  if (dependencyConfig === null || Array.isArray(dependencyConfig) || typeof dependencyConfig !== "object") {
    fail(`${consumer} declares unknown release dependency ${dependency}`);
  }
  const targets = assertStringList(dependencyConfig.publish_targets ?? [], `${dependency}.publish_targets`);
  const registryTargets = targets.filter((target) => REGISTRY_TARGETS.has(target));
  if (registryTargets.length > 0) {
    registryAssertProductPublication(dependency, {
      requirePublished: true,
      versionOverride: dependencyVersion,
    });
  }
  if (targets.includes("github-release-assets")) {
    verifyGithubReleaseAssets(dependency, dependencyVersion);
  }
}

function validateDependencyTag(consumer, dependency, dependencyVersion, graph, selected) {
  parseStableVersion(dependencyVersion);
  if (selected.has(dependency)) {
    return;
  }
  const dependencyConfig = graph.products[dependency];
  if (dependencyConfig === null || Array.isArray(dependencyConfig) || typeof dependencyConfig !== "object") {
    fail(`${consumer} declares unknown release dependency ${dependency}`);
  }
  if (typeof dependencyConfig.tag_prefix !== "string" || dependencyConfig.tag_prefix.length === 0) {
    fail(`${dependency} must declare tag_prefix`);
  }
  const tag = `${dependencyConfig.tag_prefix}${dependencyVersion}`;
  if (!tagExists(tag)) {
    fail(
      `${consumer} depends on ${dependency} ${dependencyVersion}, but release tag ${tag} does not exist and ${dependency} is not selected for this release`,
    );
  }
  validateReleasedDependencyArtifacts(consumer, dependency, dependencyVersion, graph);
}

async function validateReleaseDependencies(products, graph) {
  const selected = new Set(products);
  const graphProducts = graph.products;
  const moonProjects = graph.moon_projects;
  if (moonProjects === null || Array.isArray(moonProjects) || typeof moonProjects !== "object") {
    fail("Moon project graph is missing from release metadata");
  }
  const productProject = Object.fromEntries(
    Object.keys(graphProducts).map((product) => [
      product,
      releaseProductProjectId(product, graphProducts, moonProjects),
    ]),
  );
  const projectProduct = Object.fromEntries(
    Object.entries(productProject).map(([product, project]) => [project, product]),
  );
  for (const product of products) {
    const config = graphProducts[product];
    if (config === null || Array.isArray(config) || typeof config !== "object") {
      fail(`selected product ${product} is missing from release metadata`);
    }
    const project = moonProjects[productProject[product]] ?? {};
    const dependencies = (Array.isArray(project.dependsOn) ? project.dependsOn : [])
      .filter((dependency) => dependency in projectProduct)
      .map((dependency) => projectProduct[dependency]);
    for (const dependency of dependencies) {
      validateDependencyTag(
        product,
        dependency,
        await dependencyVersionFor(product, dependency),
        graph,
        selected,
      );
    }
  }
}

async function validateRuntimeTiedContribRelease(products, graph) {
  const selected = new Set(products);
  const tiedProducts = runtimeTiedContribProducts(graph.products, TOOL);
  const selectedTied = tiedProducts.filter((product) => selected.has(product));
  if (selectedTied.length === 0) {
    return;
  }

  const missing = tiedProducts.filter((product) => !selected.has(product));
  if (missing.length > 0) {
    fail(
      `liboliphaunt-native, liboliphaunt-wasix, and contrib extensions are versioned together; selected ${selectedTied.join(
        ", ",
      )} but missing ${missing.join(", ")}`,
    );
  }

  const versions = new Map();
  for (const product of tiedProducts) {
    versions.set(product, await currentVersion(product));
  }
  const distinctVersions = [...new Set(versions.values())].sort();
  if (distinctVersions.length > 1) {
    fail(
      `runtime-tied products must share one release version: ${[...versions.entries()]
        .map(([product, version]) => `${product}=${version}`)
        .join(", ")}`,
    );
  }
}

function parseArgs(argv) {
  const args = {
    productsJson: undefined,
    headRef: "HEAD",
    checkRegistries: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--products-json") {
      if (index + 1 >= argv.length) {
        fail("--products-json requires a value");
      }
      args.productsJson = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--products-json=")) {
      args.productsJson = value.slice("--products-json=".length);
    } else if (value === "--head-ref") {
      if (index + 1 >= argv.length) {
        fail("--head-ref requires a value");
      }
      args.headRef = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--head-ref=")) {
      args.headRef = value.slice("--head-ref=".length);
    } else if (value === "--check-registries") {
      args.checkRegistries = true;
    } else if (value === "-h" || value === "--help") {
      console.log("usage: tools/release/check_release_versions.mjs [--products-json JSON] [--head-ref REF] [--check-registries]");
      process.exit(0);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const graph = loadGraph();
  const selected = parseProducts(args.productsJson, graph);
  const currentTagAtHead = {};
  for (const product of selected) {
    currentTagAtHead[product] = await validateProduct(product, graph.products[product], args.headRef);
  }
  await validateRuntimeTiedContribRelease(selected, graph);
  await validateReleaseDependencies(selected, graph);
  if (args.checkRegistries) {
    await validateRegistryPublication(selected, graph, currentTagAtHead, args.headRef);
  }
  console.log("release version checks passed");
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
