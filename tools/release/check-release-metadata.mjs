#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { extensionRegistryPackageStrings } from "./extension-registry-packages.mjs";
import {
  allArtifactTargets,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionRegistryPackageTargetSets,
  extensionSourceIdentity,
  registryPackageRows,
  releaseMetadata,
  sdkPackageProducts,
} from "./release-artifact-targets.mjs";
import {
  ROOT,
  compareText,
  compatibilityVersionEntries,
  loadGraph,
  moonReleaseMetadataRows,
  parseStableVersion,
  releaseOrder,
  runtimeTiedContribProducts,
  versionFiles,
} from "./release-graph.mjs";
import {
  PUBLICATION_CATALOG_SCHEMA,
  REGISTRY_KIND_TO_ECOSYSTEM,
  declaredCarrierMap,
  loadPublicationCatalog,
  publicationCatalogDigest,
} from "./publication-catalog.mjs";
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  ICU_PACKAGE,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  publicAotCargoDependencies,
  publicCargoPackageNames,
  publicToolsAotCargoDependencies,
  publicToolsFeatureDependencies,
} from "./wasix-cargo-artifact-contract.mjs";

const TOOL = "check-release-metadata.mjs";
const STABLE_VERSION = /^[0-9]+[.][0-9]+[.][0-9]+$/u;
const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall"]);
const REGISTRY_TARGET_ECOSYSTEM = Object.freeze({
  "crates-io": "cargo",
  jsr: "jsr",
  "maven-central": "maven",
  npm: "npm",
});
const KNOWN_PUBLISH_TARGETS = new Set([
  ...Object.keys(REGISTRY_TARGET_ECOSYSTEM),
  "github-release",
  "github-release-assets",
  "swift-package-source-tag",
]);

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

function stringList(value, label, { nonEmpty = false } = {}) {
  assert(
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0),
    `${label} must be a list of non-empty strings`,
  );
  assert(!nonEmpty || value.length > 0, `${label} must not be empty`);
  assert(new Set(value).size === value.length, `${label} must not contain duplicates`);
  return value;
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function readJson(relativePath) {
  try {
    return object(JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function readToml(relativePath) {
  try {
    return object(Bun.TOML.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid TOML: ${error.message}`);
  }
}

function requireFile(relativePath, label = relativePath) {
  const absolute = path.join(ROOT, relativePath);
  assert(existsSync(absolute) && statSync(absolute).isFile(), `${label} does not exist: ${relativePath}`);
}

function requireDirectory(relativePath, label = relativePath) {
  const absolute = path.join(ROOT, relativePath);
  assert(existsSync(absolute) && statSync(absolute).isDirectory(), `${label} is not a directory: ${relativePath}`);
}

function stableVersion(value, label) {
  assert(typeof value === "string" && STABLE_VERSION.test(value), `${label} must be stable x.y.z, got ${JSON.stringify(value)}`);
  parseStableVersion(value, TOOL);
  return value;
}

function dottedValue(value, expression, label) {
  assert(typeof expression === "string" && expression.startsWith("$.") && expression.length > 2, `${label} must use $.path syntax`);
  let cursor = value;
  for (const key of expression.slice(2).split(".")) {
    assert(cursor !== null && typeof cursor === "object" && !Array.isArray(cursor) && key in cursor, `${label} does not resolve ${expression}`);
    cursor = cursor[key];
  }
  return cursor;
}

function genericMarkedVersion(relativePath) {
  const text = readFileSync(path.join(ROOT, relativePath), "utf8");
  const singleLines = text
    .split(/\r?\n/u)
    .filter((line) => line.includes("x-release-please-version"));
  if (singleLines.length === 1) {
    const matches = singleLines[0].match(/[0-9]+[.][0-9]+[.][0-9]+/gu) ?? [];
    assert(matches.length === 1, `${relativePath} release-please version marker must own exactly one stable version`);
    return matches[0];
  }
  const block = /x-release-please-start-version(?<body>[\s\S]*?)x-release-please-end/u.exec(text)?.groups?.body;
  assert(singleLines.length === 0 && block !== undefined, `${relativePath} must have one release-please version marker or marker block`);
  const matches = block.match(/[0-9]+[.][0-9]+[.][0-9]+/gu) ?? [];
  assert(matches.length === 1, `${relativePath} release-please version block must own exactly one stable version`);
  return matches[0];
}

function conventionalVersion(relativePath) {
  const basename = path.basename(relativePath);
  const text = readFileSync(path.join(ROOT, relativePath), "utf8");
  if (basename === "Cargo.toml") {
    const manifest = readToml(relativePath);
    return object(manifest.package, `${relativePath}.package`).version;
  }
  if (basename === "package.json" || basename === "jsr.json") {
    return readJson(relativePath).version;
  }
  if (basename === "VERSION" || basename === "LIBOLIPHAUNT_VERSION") {
    return text.trim();
  }
  if (basename === "gradle.properties") {
    const matches = [...text.matchAll(/^VERSION_NAME=(.+)$/gmu)].map((match) => match[1].trim());
    assert(matches.length === 1, `${relativePath} must declare VERSION_NAME exactly once`);
    return matches[0];
  }
  return genericMarkedVersion(relativePath);
}

function releasePleaseVersion(relativePath, entry) {
  if (typeof entry === "string") {
    return conventionalVersion(relativePath);
  }
  const type = entry.type ?? "generic";
  if (type === "generic") {
    return conventionalVersion(relativePath);
  }
  const parsers = {
    json: readJson,
    toml: readToml,
    yaml: (file) => object(Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf8")), file),
  };
  const parser = parsers[type];
  assert(parser !== undefined, `${relativePath} uses unsupported structured release-please type ${JSON.stringify(type)}`);
  const value = parser(relativePath);
  return dottedValue(value, entry.jsonpath, `${relativePath}.jsonpath`);
}

function resolveDerivedPath(config, candidate) {
  if (existsSync(path.join(ROOT, candidate))) {
    return candidate;
  }
  return path.posix.join(config.path, candidate);
}

function validateReleasePleaseVersions(graph) {
  const config = readJson("release-please-config.json");
  const manifest = readJson(".release-please-manifest.json");
  const packages = object(config.packages, "release-please-config.json.packages");
  const productsByPath = new Map(Object.entries(graph.products).map(([product, productConfig]) => [productConfig.path, product]));
  assert(sameStrings(Object.keys(packages), productsByPath.keys()), "release-please package paths must exactly match release graph products");
  assert(sameStrings(Object.keys(manifest), productsByPath.keys()), "release-please manifest paths must exactly match release graph products");

  for (const [packagePath, packageConfigValue] of Object.entries(packages)) {
    const packageConfig = object(packageConfigValue, `release-please packages.${packagePath}`);
    const product = productsByPath.get(packagePath);
    const productConfig = graph.products[product];
    assert(packageConfig.component === product, `${packagePath}.component must be ${product}`);
    assert(manifest[packagePath] === productConfig.version, `${packagePath} release-please manifest version must match ${product}`);
    const changelog = packageConfig["changelog-path"] ?? "CHANGELOG.md";
    assert(typeof changelog === "string" && changelog.length > 0, `${packagePath}.changelog-path must be a non-empty string`);
    requireFile(path.posix.join(packagePath, changelog), `${product} changelog`);
    assert(productConfig.changelog_path === path.posix.join(packagePath, changelog), `${product} graph changelog must match release-please`);

    const releaseType = packageConfig["release-type"];
    const canonical = packageConfig["version-file"]
      ?? (releaseType === "rust" ? "Cargo.toml" : ["node", "expo"].includes(releaseType) ? "package.json" : undefined);
    assert(typeof canonical === "string" && canonical.length > 0, `${packagePath} must declare a canonical version file`);
    const extraFiles = packageConfig["extra-files"] ?? [];
    assert(Array.isArray(extraFiles), `${packagePath}.extra-files must be a list`);
    const entries = [canonical, ...extraFiles]
      .map((entry) => ({ entry, relative: typeof entry === "string" ? entry : entry.path }));
    for (const { entry, relative } of entries) {
      assert(typeof relative === "string" && relative.length > 0, `${packagePath} version-file entry must declare a path`);
      const file = path.posix.join(packagePath, relative);
      requireFile(file, `${product} version file`);
      const value = releasePleaseVersion(file, entry);
      assert(value === productConfig.version, `${file} version ${JSON.stringify(value)} must match ${product} ${productConfig.version}`);
    }
    const files = entries.map(({ relative }) => path.posix.join(packagePath, relative));
    assert(sameStrings(files, versionFiles(product, TOOL)), `${product} release graph version files must match release-please`);
  }
}

function validateGraph(graph) {
  const productIds = sorted(Object.keys(graph.products));
  assert(productIds.length > 0, "release graph must contain products");
  const moonRows = moonReleaseMetadataRows({}, TOOL);
  assert(sameStrings(moonRows.map((row) => row.product), productIds), "Moon release products must exactly match the release graph");
  const packagePaths = new Set();
  for (const product of productIds) {
    const config = object(graph.products[product], `${product} config`);
    assert(config.id === product, `${product}.id must match its graph key`);
    assert(typeof config.owner === "string" && config.owner.length > 0, `${product}.owner must be non-empty`);
    assert(typeof config.kind === "string" && config.kind.length > 0, `${product}.kind must be non-empty`);
    assert(typeof config.path === "string" && config.path.length > 0, `${product}.path must be non-empty`);
    assert(!packagePaths.has(config.path), `release package path is shared by more than one product: ${config.path}`);
    packagePaths.add(config.path);
    requireDirectory(config.path, `${product} package path`);
    requireFile(`${config.path}/release.toml`, `${product} metadata`);
    stableVersion(config.version, `${product}.version`);
    assert(currentProductVersionSync(product, TOOL) === config.version, `${product} canonical version must match the release manifest`);
    stringList(config.publish_targets, `${product}.publish_targets`, { nonEmpty: true });
    stringList(config.release_artifacts, `${product}.release_artifacts`, { nonEmpty: true });
    stringList(config.registry_packages ?? [], `${product}.registry_packages`);
    for (const target of config.publish_targets) {
      assert(KNOWN_PUBLISH_TARGETS.has(target), `${product} declares unsupported publish target ${target}`);
    }
    assert(config.tag_prefix === `${product}-v`, `${product}.tag_prefix must be ${product}-v`);
    for (const file of config.version_files) {
      requireFile(file, `${product} version file`);
    }
    for (const candidate of config.derived_version_files ?? []) {
      requireFile(resolveDerivedPath(config, candidate), `${product} derived version file`);
    }
    const moon = moonRows.find((row) => row.product === product);
    assert(moon.component === product, `${product} Moon release component must match`);
    assert(moon.packagePath === config.path, `${product} Moon package path must match release.toml`);
    releaseMetadata(product, TOOL);
  }
  assert(sameStrings(releaseOrder(graph.products, graph.moon_projects, new Set(productIds), TOOL), productIds), "release order must cover every product exactly once");
  const tied = runtimeTiedContribProducts(graph.products, TOOL);
  assert(new Set(tied.map((product) => graph.products[product].version)).size === 1, "native, WASIX, and contrib products must share one version");
  validateReleasePleaseVersions(graph);
}

function compatibilityValue(entry) {
  const text = readFileSync(path.join(ROOT, entry.path), "utf8");
  if (entry.parser === "raw") {
    return text.trim();
  }
  if (entry.parser.startsWith("json:")) {
    return dottedValue(readJson(entry.path), `$.${entry.parser.slice(5)}`, `${entry.id}.parser`);
  }
  if (entry.parser.startsWith("toml:")) {
    return dottedValue(readToml(entry.path), `$.${entry.parser.slice(5)}`, `${entry.id}.parser`);
  }
  if (entry.parser.startsWith("rust-const:")) {
    const name = entry.parser.slice("rust-const:".length);
    assert(/^[A-Z][A-Z0-9_]*$/u.test(name), `${entry.id} has invalid Rust const parser`);
    const expression = new RegExp(`(?:pub\\s+)?const\\s+${name}\\s*:[^=]+?=\\s*\"([^\"]+)\"\\s*;`, "gu");
    const values = [...text.matchAll(expression)].map((match) => match[1]);
    assert(values.length === 1, `${entry.path} must declare ${name} exactly once`);
    return values[0];
  }
  fail(`${entry.id} uses unsupported compatibility parser ${entry.parser}`);
}

function validateCompatibility(graph) {
  const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true, prefix: TOOL });
  assert(new Set(entries.map((entry) => entry.id)).size === entries.length, "compatibility field ids must be globally unique");
  for (const entry of entries) {
    const value = compatibilityValue(entry);
    const expected = graph.products[entry.sourceProduct].version;
    assert(value === expected, `${entry.id} compatibility value ${JSON.stringify(value)} must match ${entry.sourceProduct} ${expected}`);
  }
  return entries.length;
}

function validateNpmManifest(relativePath, product, catalogCarriers) {
  const manifest = readJson(relativePath);
  assert(typeof manifest.name === "string" && manifest.name.length > 0, `${relativePath}.name must be non-empty`);
  assert(manifest.version === product.version, `${relativePath}.version must match ${product.id} ${product.version}`);
  const scripts = object(manifest.scripts ?? {}, `${relativePath}.scripts`);
  for (const [name, command] of Object.entries(scripts)) {
    assert(typeof command === "string", `${relativePath}.scripts.${name} must be a string`);
    assert(!INSTALL_SCRIPTS.has(name), `${relativePath} must not run ${name} during consumer installation`);
  }
  if (manifest.private !== true) {
    const carrier = catalogCarriers.get(`npm:${manifest.name}`);
    assert(carrier?.product === product.id, `${relativePath} public npm identity ${manifest.name} must belong to ${product.id} in the publication catalog`);
    assert(manifest.publishConfig?.access === "public", `${relativePath}.publishConfig.access must be public`);
    assert(manifest.publishConfig?.provenance === true, `${relativePath}.publishConfig.provenance must be true`);
  }
}

function validateCargoManifest(relativePath, product, catalogCarriers) {
  const manifest = readToml(relativePath);
  const packageConfig = object(manifest.package, `${relativePath}.package`);
  assert(typeof packageConfig.name === "string" && packageConfig.name.length > 0, `${relativePath}.package.name must be non-empty`);
  assert(packageConfig.version === product.version, `${relativePath}.package.version must match ${product.id} ${product.version}`);
  if (packageConfig.publish !== false) {
    const carrier = catalogCarriers.get(`cargo:${packageConfig.name}`);
    assert(carrier?.product === product.id, `${relativePath} publishable Cargo identity ${packageConfig.name} must belong to ${product.id}`);
  }
}

function validateSourcePackageManifests(graph, catalog) {
  const carriers = declaredCarrierMap(catalog);
  let npm = 0;
  let cargo = 0;
  for (const [id, config] of Object.entries(graph.products)) {
    const product = { id, ...config };
    for (const file of config.version_files) {
      if (path.basename(file) === "package.json") {
        validateNpmManifest(file, product, carriers);
        npm += 1;
      } else if (path.basename(file) === "Cargo.toml") {
        validateCargoManifest(file, product, carriers);
        cargo += 1;
      }
    }
  }
  const jsr = readJson("src/sdks/js/jsr.json");
  const jsProduct = graph.products["oliphaunt-js"];
  assert(jsr.name === "@oliphaunt/ts", "JSR SDK identity must match the TypeScript package identity");
  assert(jsr.version === jsProduct.version, "JSR SDK version must match oliphaunt-js");
  assert(carriers.get(`jsr:${jsr.name}`)?.product === "oliphaunt-js", "JSR SDK identity must be declared by oliphaunt-js");
  return { npm, cargo };
}

function validateCatalogAndTargets(graph) {
  const catalog = loadPublicationCatalog(TOOL);
  assert(catalog.schema === PUBLICATION_CATALOG_SCHEMA, `publication catalog must use ${PUBLICATION_CATALOG_SCHEMA}`);
  const productRows = new Map(catalog.products.map((product) => [product.id, product]));
  assert(sameStrings(productRows.keys(), Object.keys(graph.products)), "publication catalog products must exactly match the release graph");
  for (const [product, config] of Object.entries(graph.products)) {
    const row = productRows.get(product);
    assert(row.version === config.version, `${product} publication version must match the release graph`);
    assert(sameStrings(row.publishTargets, config.publish_targets), `${product} publication targets must match release.toml`);
    const declared = registryPackageRows({ product }, TOOL).map((entry) => {
      const ecosystem = REGISTRY_KIND_TO_ECOSYSTEM[entry.packageKind];
      assert(ecosystem !== undefined, `${product} uses unsupported registry package kind ${entry.packageKind}`);
      return `${ecosystem}:${entry.packageName}`;
    });
    const generated = config.kind === "exact-extension-artifact" ? [`cargo:${product}`] : [];
    const catalogDeclared = catalog.carriers
      .filter((carrier) => carrier.product === product && carrier.declared)
      .map((carrier) => carrier.id);
    assert(
      sameStrings([...declared, ...generated], catalogDeclared),
      `${product} declared and generated registry packages must exactly match the publication catalog`,
    );
    for (const [target, ecosystem] of Object.entries(REGISTRY_TARGET_ECOSYSTEM)) {
      const count = catalog.carriers.filter((carrier) => carrier.product === product && carrier.ecosystem === ecosystem).length;
      assert(config.publish_targets.includes(target) === (count > 0), `${product} ${target} target and ${ecosystem} carrier declarations must agree`);
    }
  }

  const runtimeTargets = allArtifactTargets({}, TOOL);
  assert(runtimeTargets.length > 0, "runtime artifact target catalog must not be empty");
  const carriers = declaredCarrierMap(catalog);
  for (const target of runtimeTargets.filter((row) => row.published && row.npmPackage !== undefined)) {
    assert(carriers.get(`npm:${target.npmPackage}`)?.product === target.product, `${target.id} npm package must be declared by ${target.product}`);
  }

  const extensionProducts = exactExtensionProducts(TOOL);
  assert(
    sameStrings(extensionProducts, Object.entries(graph.products).filter(([, config]) => config.kind === "exact-extension-artifact").map(([product]) => product)),
    "exact-extension products must match the release graph",
  );
  let extensionTargets = 0;
  for (const product of extensionProducts) {
    const metadata = extensionMetadata(product, TOOL);
    extensionSourceIdentity(product, TOOL);
    const targets = extensionArtifactTargets({ product }, TOOL);
    assert(targets.some((target) => target.family === "native" && target.published), `${product} must publish at least one native target`);
    assert(targets.some((target) => target.family === "wasix" && target.published), `${product} must publish at least one WASIX target`);
    const targetSets = extensionRegistryPackageTargetSets(product, TOOL);
    const expected = extensionRegistryPackageStrings({
      product,
      sqlName: metadata.sqlName,
      ...targetSets,
    });
    assert(
      sameStrings(expected, graph.products[product].registry_packages),
      `${product} registry packages must be derived exactly from its published extension targets`,
    );
    extensionTargets += targets.length;
  }

  return {
    catalog,
    runtimeTargets: runtimeTargets.length,
    extensionProducts: extensionProducts.length,
    extensionTargets,
  };
}

function exactDependency(table, name, version, { optional = false } = {}) {
  const dependency = object(table?.[name], `oliphaunt-wasix dependency ${name}`);
  assert(dependency.version === `=${version}`, `${name} must use exact runtime version =${version}`);
  assert(optional ? dependency.optional === true : dependency.optional !== true, `${name} optional dependency contract is wrong`);
}

function validateWasixContract(graph, catalog) {
  const runtimeVersion = graph.products["liboliphaunt-wasix"].version;
  const runtimeCargo = catalog.carriers
    .filter((carrier) => carrier.product === "liboliphaunt-wasix" && carrier.ecosystem === "cargo")
    .map((carrier) => carrier.name);
  assert(sameStrings(runtimeCargo, publicCargoPackageNames()), "liboliphaunt-wasix Cargo carriers must exactly match the WASIX artifact contract");

  const manifests = new Map([
    [ICU_PACKAGE, "src/runtimes/liboliphaunt/icu/Cargo.toml"],
    [RUNTIME_PACKAGE, "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml"],
    [TOOLS_PACKAGE, "src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml"],
    ...Object.entries(AOT_PACKAGES).map(([target, name]) => [name, `src/runtimes/liboliphaunt/wasix/crates/aot/${AOT_TARGET_TRIPLES[target]}/Cargo.toml`]),
    ...Object.entries(TOOLS_AOT_PACKAGES).map(([target, name]) => [name, `src/runtimes/liboliphaunt/wasix/crates/tools-aot/${AOT_TARGET_TRIPLES[target]}/Cargo.toml`]),
  ]);
  for (const [name, file] of manifests) {
    const packageConfig = object(readToml(file).package, `${file}.package`);
    assert(packageConfig.name === name, `${file} package name must be ${name}`);
    assert(packageConfig.version === runtimeVersion, `${file} version must match liboliphaunt-wasix`);
  }

  const sdk = readToml("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml");
  const dependencies = object(sdk.dependencies, "oliphaunt-wasix dependencies");
  exactDependency(dependencies, RUNTIME_PACKAGE, runtimeVersion);
  exactDependency(dependencies, TOOLS_PACKAGE, runtimeVersion, { optional: true });
  exactDependency(dependencies, ICU_PACKAGE, runtimeVersion, { optional: true });
  const targetTables = object(sdk.target, "oliphaunt-wasix target dependencies");
  for (const [cfg, name] of Object.entries(publicAotCargoDependencies())) {
    exactDependency(object(targetTables[cfg], `oliphaunt-wasix target ${cfg}`).dependencies, name, runtimeVersion);
  }
  for (const [cfg, name] of Object.entries(publicToolsAotCargoDependencies())) {
    exactDependency(object(targetTables[cfg], `oliphaunt-wasix target ${cfg}`).dependencies, name, runtimeVersion, { optional: true });
  }
  assert(sameStrings(sdk.features?.tools ?? [], publicToolsFeatureDependencies()), "oliphaunt-wasix tools feature must select exactly the split tool carriers");
  assert(!("bundled" in object(sdk.features, "oliphaunt-wasix features")), "oliphaunt-wasix must not expose an inert bundled feature");
  const extensionFeatures = exactExtensionProducts(TOOL).map((product) => `extension-${extensionMetadata(product, TOOL).sqlName.replaceAll("_", "-")}`);
  const sdkExtensionFeatures = Object.keys(sdk.features).filter((feature) => feature.startsWith("extension-"));
  assert(sameStrings(extensionFeatures, sdkExtensionFeatures), "oliphaunt-wasix extension features must exactly match modeled extensions");
  const runtimeFeatures = Object.keys(readToml("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml").features ?? {});
  assert(sameStrings(extensionFeatures, runtimeFeatures), "portable WASIX runtime features must exactly match modeled extensions");
  const dump = (sdk.bin ?? []).find((entry) => entry.name === "oliphaunt-wasix-dump");
  assert(Array.isArray(dump?.["required-features"]) && dump["required-features"].includes("tools"), "oliphaunt-wasix-dump must require the tools feature");
}

function validateNativeContract(graph, catalog) {
  const targets = allArtifactTargets({ product: "liboliphaunt-native", publishedOnly: true }, TOOL);
  assert(targets.some((target) => target.kind === "native-runtime"), "liboliphaunt-native must publish runtime targets");
  assert(targets.some((target) => target.kind === "native-tools"), "liboliphaunt-native must publish split tool targets");
  const expectedNpm = new Set([
    "@oliphaunt/icu",
    ...targets.map((target) => target.npmPackage).filter(Boolean),
  ]);
  const actualNpm = catalog.carriers
    .filter((carrier) => carrier.product === "liboliphaunt-native" && carrier.ecosystem === "npm")
    .map((carrier) => carrier.name);
  assert(sameStrings(expectedNpm, actualNpm), "liboliphaunt-native npm carriers must exactly cover runtime, split tools, and ICU packages");
  const androidTargets = targets
    .filter((target) => target.kind === "native-runtime" && target.target.startsWith("android-"))
    .map((target) => `dev.oliphaunt.runtime:liboliphaunt-${target.target}`);
  const expectedMaven = [
    "dev.oliphaunt.runtime:liboliphaunt-runtime-resources",
    "dev.oliphaunt.runtime:oliphaunt-icu",
    ...androidTargets,
  ];
  const actualMaven = catalog.carriers
    .filter((carrier) => carrier.product === "liboliphaunt-native" && carrier.ecosystem === "maven")
    .map((carrier) => carrier.name);
  assert(sameStrings(expectedMaven, actualMaven), "liboliphaunt-native Maven carriers must exactly cover Android ABIs and shared resources");
  assert(currentProductVersionSync("liboliphaunt-native", TOOL) === graph.products["liboliphaunt-native"].version, "native C product version must match the release graph");
}

function validateSdkSet(graph) {
  const expected = Object.entries(graph.products)
    .filter(([, config]) => config.kind === "sdk")
    .map(([product]) => product);
  const actual = sdkPackageProducts(TOOL).map((row) => row.product);
  assert(sameStrings(expected, actual), "SDK package artifact products must exactly match SDK release products");
}

function parseArgs(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log("usage: tools/release/check-release-metadata.mjs [--json]");
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return { json };
}

function main(argv) {
  const args = parseArgs(argv);
  const graph = loadGraph(TOOL);
  validateGraph(graph);
  const compatibilityFields = validateCompatibility(graph);
  const targetReport = validateCatalogAndTargets(graph);
  const manifests = validateSourcePackageManifests(graph, targetReport.catalog);
  validateNativeContract(graph, targetReport.catalog);
  validateWasixContract(graph, targetReport.catalog);
  validateSdkSet(graph);
  const report = {
    schema: "oliphaunt-release-metadata-validation-v1",
    products: Object.keys(graph.products).length,
    carriers: targetReport.catalog.carriers.length,
    catalogDigest: publicationCatalogDigest(targetReport.catalog),
    runtimeTargets: targetReport.runtimeTargets,
    extensionProducts: targetReport.extensionProducts,
    extensionTargets: targetReport.extensionTargets,
    compatibilityFields,
    sourceNpmManifests: manifests.npm,
    sourceCargoManifests: manifests.cargo,
  };
  if (args.json) {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `release metadata checks passed (${report.products} products, ${report.carriers} registry carriers, ${report.runtimeTargets + report.extensionTargets} artifact targets, ${report.compatibilityFields} compatibility fields)`,
    );
  }
}

try {
  main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
