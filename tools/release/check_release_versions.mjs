#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentVersion } from "./product-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOL = "check_release_versions.mjs";
const REGISTRY_TARGETS = new Set(["crates-io", "npm", "jsr", "maven-central"]);

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
}

function readText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  const value = JSON.parse(readText(relativePath));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${relativePath} must contain a JSON object`);
  }
  return value;
}

function readToml(relativePath) {
  const file = path.join(ROOT, relativePath);
  if (!existsSync(file)) {
    fail(`missing ${relativePath}`);
  }
  const value = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${relativePath} must contain a TOML table`);
  }
  return value;
}

function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }
  const protoMoon = path.join(process.env.HOME ?? "", ".proto/bin/moon");
  return existsSync(protoMoon) ? protoMoon : "moon";
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
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

function commandJson(args) {
  const output = execFileSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const value = JSON.parse(output);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${args[0]} did not return a JSON object`);
  }
  return value;
}

function parseStableVersion(version) {
  const match = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/.exec(version);
  if (!match) {
    fail(`release version must be stable x.y.z for automated publish, got ${JSON.stringify(version)}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function formatVersion(version) {
  return version.join(".");
}

function assertStringList(value, context) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${context} must be a string list`);
  }
  return value;
}

function releasePleasePackagesByComponent() {
  const config = readJson("release-please-config.json");
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    fail("release-please-config.json must define packages");
  }
  const byComponent = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      fail(`${packagePath} release-please config must be an object`);
    }
    const component = packageConfig.component;
    if (typeof component !== "string" || component.length === 0) {
      fail(`${packagePath}.component must be a non-empty string`);
    }
    if (byComponent.has(component)) {
      fail(`duplicate release-please component ${component}`);
    }
    byComponent.set(component, { packagePath, packageConfig });
  }
  return { config, byComponent };
}

function moonProjectsById() {
  const data = commandJson([moonBin(), "query", "projects"]);
  const projects = data.projects;
  if (!Array.isArray(projects)) {
    fail("moon query projects did not return a projects array");
  }
  const parsed = new Map();
  for (const project of projects) {
    if (project === null || Array.isArray(project) || typeof project !== "object" || typeof project.id !== "string") {
      continue;
    }
    const config = project.config && typeof project.config === "object" && !Array.isArray(project.config) ? project.config : {};
    const rawDeps = project.dependencies ?? config.dependsOn ?? [];
    const dependencyScopes = {};
    if (Array.isArray(rawDeps)) {
      for (const dependency of rawDeps) {
        if (typeof dependency === "string") {
          dependencyScopes[dependency] = "production";
        } else if (
          dependency !== null &&
          typeof dependency === "object" &&
          !Array.isArray(dependency) &&
          typeof dependency.id === "string"
        ) {
          dependencyScopes[dependency.id] = String(dependency.scope || "production");
        }
      }
    }
    parsed.set(project.id, {
      id: project.id,
      source: project.source || config.source || "",
      dependsOn: Object.keys(dependencyScopes).sort(),
      dependencyScopes,
      tags: Array.isArray(config.tags) ? [...config.tags].sort() : [],
      project: config.project && typeof config.project === "object" && !Array.isArray(config.project) ? config.project : {},
    });
  }
  return parsed;
}

function moonReleaseProjectsByComponent(projects) {
  const products = new Map();
  for (const project of projects.values()) {
    const metadata =
      project.project &&
      typeof project.project === "object" &&
      !Array.isArray(project.project) &&
      project.project.metadata &&
      typeof project.project.metadata === "object" &&
      !Array.isArray(project.project.metadata)
        ? project.project.metadata
        : {};
    const release =
      metadata.release && typeof metadata.release === "object" && !Array.isArray(metadata.release)
        ? metadata.release
        : undefined;
    if (!project.tags.includes("release-product")) {
      if (release !== undefined) {
        fail(`Moon project ${project.id} declares release metadata but is not tagged release-product`);
      }
      continue;
    }
    if (release === undefined) {
      fail(`Moon release product ${project.id} must declare project.metadata.release`);
    }
    if (release.component !== project.id) {
      fail(`Moon release product ${project.id} release.component must match the project id`);
    }
    if (typeof release.packagePath !== "string" || release.packagePath.length === 0) {
      fail(`Moon release product ${project.id} must declare release.packagePath`);
    }
    if (products.has(release.component)) {
      fail(`duplicate Moon release component ${release.component}`);
    }
    products.set(release.component, {
      projectId: project.id,
      projectSource: project.source,
      path: release.packagePath,
      release,
    });
  }
  if (products.size === 0) {
    fail("Moon project graph does not contain any release-product projects");
  }
  return products;
}

function releasePackagePaths(projects) {
  const { byComponent } = releasePleasePackagesByComponent();
  const moonProducts = moonReleaseProjectsByComponent(projects);
  const moonComponents = [...moonProducts.keys()].sort();
  const releaseComponents = [...byComponent.keys()].sort();
  if (JSON.stringify(moonComponents) !== JSON.stringify(releaseComponents)) {
    fail(
      `Moon release-product components must match release-please components: moon=${JSON.stringify(
        moonComponents,
      )}, release-please=${JSON.stringify(releaseComponents)}`,
    );
  }
  const paths = new Map();
  for (const component of moonComponents) {
    const moonPath = moonProducts.get(component).path;
    const releasePath = byComponent.get(component).packagePath;
    if (moonPath !== releasePath) {
      fail(
        `${component} Moon release.packagePath ${JSON.stringify(moonPath)} must match release-please package path ${JSON.stringify(
          releasePath,
        )}`,
      );
    }
    paths.set(component, moonPath);
  }
  return paths;
}

function tagPrefix(product) {
  const { config, byComponent } = releasePleasePackagesByComponent();
  const packageConfig = byComponent.get(product)?.packageConfig;
  if (!packageConfig) {
    fail(`unknown release-please component ${product}`);
  }
  if (packageConfig.component !== product) {
    fail(`${product} release-please component must match product id`);
  }
  if (config["include-v-in-tag"] !== true) {
    fail("release-please must include v in product tags");
  }
  if (config["tag-separator"] !== "-") {
    fail("release-please tag-separator must be '-'");
  }
  return `${product}-v`;
}

function graphProducts(projects) {
  const paths = releasePackagePaths(projects);
  const manifest = readJson(".release-please-manifest.json");
  const products = {};
  for (const [product, packagePath] of [...paths.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const metadata = readToml(path.join(packagePath, "release.toml"));
    if (metadata.id !== product) {
      fail(`${packagePath}/release.toml must declare id = ${JSON.stringify(product)}`);
    }
    if (!(packagePath in manifest)) {
      fail(`.release-please-manifest.json is missing ${packagePath}`);
    }
    products[product] = {
      ...metadata,
      path: packagePath,
      tag_prefix: tagPrefix(product),
    };
  }
  return products;
}

function loadGraph() {
  const moonProjects = moonProjectsById();
  return {
    policy: {
      repository: "f0rr0/oliphaunt",
      default_branch: "main",
      versioning: "independent",
    },
    products: graphProducts(moonProjects),
    moon_projects: Object.fromEntries(moonProjects),
  };
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
  return ["tools/dev/bun.sh", "tools/release/check_registry_publication.mjs", ...args];
}

function registryRun(args) {
  run(registryCommand(args));
}

function registryJson(args) {
  return commandJson(registryCommand(args));
}

function registryAssertProductPublication(product, { requirePublished, versionOverride } = {}) {
  const args = ["--product", product, requirePublished ? "--require-published" : "--require-unpublished"];
  if (versionOverride !== undefined) {
    args.push("--version", versionOverride);
  }
  registryRun(args);
}

function registryReportProductPublication(product) {
  registryRun(["--product", product, "--report"]);
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
    "tools/dev/bun.sh",
    "tools/release/check_github_release_assets.mjs",
    product,
    "--version",
    version,
    "--default-assets",
  ]);
}

function tagMatchPattern(prefix) {
  return prefix ? `${prefix}[0-9]*` : "[0-9]*";
}

function tagPrefixes(config) {
  if (typeof config.tag_prefix !== "string" || config.tag_prefix.length === 0) {
    fail("release products must declare tag_prefix");
  }
  const legacyPrefixes = config.legacy_tag_prefixes ?? [];
  assertStringList(legacyPrefixes, "legacy_tag_prefixes");
  return [config.tag_prefix, ...legacyPrefixes];
}

function productTags(prefix) {
  const output = execFileSync("git", ["tag", "--list", tagMatchPattern(prefix)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output
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
        `${product} version ${version} is already tagged as ${currentTag} at ${currentTagCommit}, not release commit ${headCommit}; merge the release-please release PR before publishing`,
      );
    }
    return true;
  }
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
      if (registryTargets.includes("crates-io")) {
        registryAssertProductPublication(product, { requirePublished: true });
      } else {
        registryReportProductPublication(product);
      }
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
      fail(
        `${product} version ${version} is already published in public registries: ${published
          .map((item) => String(item.label))
          .join(
            ", ",
          )}; the matching product tag ${currentTag} is missing or does not point at release commit ${headCommit}. If this was an intentional first package identity bootstrap, create and push that product tag at the same release commit, then rerun the release workflow as a completion run. Otherwise merge the release-please release PR before publishing.`,
      );
    }
    console.log(
      `${product} registry unpublished check passed: ${packages.map((item) => String(item.label)).join(", ")}`,
    );
  }
}

function releaseProductProjectId(product, products, projects) {
  if (product in projects) {
    return product;
  }
  const packagePath = products[product]?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    fail(`release product ${product} is missing package path metadata`);
  }
  const matches = Object.values(projects)
    .filter((project) => packagePath === project.source || packagePath.startsWith(`${project.source}/`))
    .sort((left, right) => right.source.length - left.source.length);
  if (matches.length === 0) {
    fail(`release product ${product} has no owning Moon project for ${packagePath}`);
  }
  return matches[0].id;
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
  await validateReleaseDependencies(selected, graph);
  if (args.checkRegistries) {
    await validateRegistryPublication(selected, graph, currentTagAtHead, args.headRef);
  }
  console.log("release version checks passed");
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
