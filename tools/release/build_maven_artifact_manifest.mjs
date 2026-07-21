#!/usr/bin/env bun
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { runMoon } from "../policy/moon.mjs";
import { currentVersion } from "./product-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "build_maven_artifact_manifest.mjs";
const EXTENSION_ARTIFACT_SCHEMA = "oliphaunt-extension-artifact-targets-v1";
const EXTENSION_FAMILIES = new Set(["native", "wasix"]);
const EXTENSION_KINDS = new Set(["native-dynamic", "native-static-registry", "wasix-runtime"]);
const EXTENSION_STATUSES = new Set(["supported", "planned", "unsupported"]);
const NATIVE_RUNTIME_TARGETS = new Set([
  "android-arm64-v8a",
  "android-x86_64",
  "ios-xcframework",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "macos-x64",
  "windows-x64-msvc",
]);
const WASIX_TARGETS = new Set(["portable", "linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

async function readToml(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    fail(`missing ${rel(file)}: ${error.message}`);
  }
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    fail(`${rel(file)} is invalid TOML: ${error.message}`);
  }
}

async function readReleaseToml(product) {
  const metadata = moonReleaseMetadata(product);
  return readToml(path.join(ROOT, metadata.packagePath, "release.toml"));
}

let releaseProducts;

function moonReleaseProducts() {
  if (releaseProducts !== undefined) {
    return releaseProducts;
  }
  const value = JSON.parse(runMoon(["query", "projects"]));
  if (!Array.isArray(value.projects)) {
    fail("moon query projects did not return a projects array");
  }
  releaseProducts = new Map();
  for (const project of value.projects) {
    const id = project?.id;
    const release = project?.config?.project?.metadata?.release;
    if (release === undefined) {
      continue;
    }
    if (typeof id !== "string" || release === null || typeof release !== "object" || Array.isArray(release)) {
      fail("Moon release metadata returned an invalid product row");
    }
    if (release.component !== id) {
      fail(`Moon release metadata for ${id} must use matching component`);
    }
    if (typeof release.packagePath !== "string" || release.packagePath.length === 0) {
      fail(`Moon release metadata for ${id} must declare packagePath`);
    }
    releaseProducts.set(id, release);
  }
  if (releaseProducts.size === 0) {
    fail("Moon project graph does not contain release products");
  }
  return releaseProducts;
}

function moonReleaseMetadata(product) {
  const release = moonReleaseProducts().get(product);
  if (release === undefined) {
    fail(`unknown release product ${product}`);
  }
  return release;
}

function stringList(config, key, product) {
  const value = config[key] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${product}.${key} must be a string list`);
  }
  return value;
}

async function registryPackageNames(product, packageKind) {
  const config = await readReleaseToml(product);
  const names = [];
  for (const raw of stringList(config, "registry_packages", product)) {
    const separator = raw.indexOf(":");
    if (separator <= 0 || separator === raw.length - 1) {
      fail(`${product}.registry_packages entry ${JSON.stringify(raw)} must use kind:name`);
    }
    const kind = raw.slice(0, separator);
    const name = raw.slice(separator + 1);
    if (kind === packageKind) {
      names.push(name);
    }
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    fail(`${product} declares duplicate ${packageKind} registry packages: ${[...new Set(duplicates)].join(", ")}`);
  }
  return names;
}

function publishedTargets(product, expectedPreset) {
  const release = moonReleaseMetadata(product);
  const config = release.artifactTargets;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail(`Moon release metadata for ${product} must declare artifactTargets`);
  }
  if (config.preset !== expectedPreset) {
    fail(`Moon release metadata for ${product} artifactTargets.preset must be ${JSON.stringify(expectedPreset)}`);
  }
  const targets = config.publishedTargets;
  if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string" && target.length > 0)) {
    fail(`Moon release metadata for ${product} artifactTargets.publishedTargets must be a string list`);
  }
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target)) {
      fail(`Moon release metadata for ${product} artifactTargets.publishedTargets contains duplicate target ${target}`);
    }
    seen.add(target);
  }
  return [...targets].sort();
}

function checkedPublishedTargets(product, expectedPreset, knownTargets) {
  const targets = publishedTargets(product, expectedPreset);
  const unknown = targets.filter((target) => !knownTargets.has(target));
  if (unknown.length > 0) {
    fail(`Moon release metadata for ${product} declares unknown artifact target(s): ${unknown.join(", ")}`);
  }
  return targets;
}

function nativeRuntimeArtifactTargets(version) {
  const rows = [
    {
      id: "liboliphaunt-native.runtime-resources",
      kind: "runtime-resources",
      target: "portable",
      asset: `liboliphaunt-${version}-runtime-resources.tar.gz`,
    },
    {
      id: "liboliphaunt-native.icu-data",
      kind: "icu-data",
      target: "portable",
      asset: `liboliphaunt-${version}-icu-data.tar.gz`,
    },
  ];
  for (const target of checkedPublishedTargets("liboliphaunt-native", "liboliphaunt-native", NATIVE_RUNTIME_TARGETS)) {
    if (!target.startsWith("android-")) {
      continue;
    }
    rows.push({
      id: `liboliphaunt-native.${target}`,
      kind: "native-runtime",
      target,
      asset: `liboliphaunt-${version}-${target}.tar.gz`,
    });
  }
  return rows.sort((left, right) => compareText(left.id, right.id));
}

function runtimeMavenArtifactId(target) {
  if (target.kind === "runtime-resources") {
    return "liboliphaunt-runtime-resources";
  }
  if (target.kind === "icu-data") {
    return "oliphaunt-icu";
  }
  if (target.kind === "native-runtime" && target.target.startsWith("android-")) {
    return `liboliphaunt-${target.target}`;
  }
  return undefined;
}

function runtimeMavenArtifactMetadata(target) {
  if (target.kind === "runtime-resources") {
    return {
      name: "Oliphaunt runtime resources",
      description: "Package-managed Oliphaunt PostgreSQL runtime resources for Android app builds.",
    };
  }
  if (target.kind === "icu-data") {
    return {
      name: "Oliphaunt ICU data",
      description: "Package-managed optional ICU data files for Oliphaunt app builds.",
    };
  }
  if (target.kind === "native-runtime" && target.target.startsWith("android-")) {
    const abi = target.target.slice("android-".length);
    return {
      name: `Oliphaunt Android runtime ${abi}`,
      description: `Package-managed liboliphaunt Android runtime for ${abi} app builds.`,
    };
  }
  fail(`unsupported liboliphaunt-native Maven artifact target ${target.id}`);
}

function runtimeMavenArtifacts(version) {
  const artifacts = new Map();
  for (const target of nativeRuntimeArtifactTargets(version)) {
    const artifactId = runtimeMavenArtifactId(target);
    if (artifactId === undefined) {
      continue;
    }
    if (artifacts.has(artifactId)) {
      fail(`duplicate liboliphaunt-native Maven artifact mapping for ${artifactId}`);
    }
    artifacts.set(artifactId, {
      filename: target.asset,
      ...runtimeMavenArtifactMetadata(target),
    });
  }
  if (artifacts.size === 0) {
    fail("liboliphaunt-native artifact targets did not produce any Maven runtime artifacts");
  }
  return artifacts;
}

function splitMavenCoordinate(coordinate) {
  const separator = coordinate.indexOf(":");
  if (separator <= 0 || separator === coordinate.length - 1) {
    fail(`invalid Maven coordinate ${JSON.stringify(coordinate)}; expected group:artifact`);
  }
  return [coordinate.slice(0, separator), coordinate.slice(separator + 1)];
}

async function requireFile(file, label) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) {
      return file;
    }
  } catch {
    // Fall through to the shared diagnostic below.
  }
  fail(`missing ${label}: ${rel(file)}`);
}

function tsvRow({
  groupId,
  artifactId,
  version,
  file,
  name,
  description,
  runtimeProduct = "",
  runtimeVersion = "",
}) {
  const values = [groupId, artifactId, version, rel(file), name, description, runtimeProduct, runtimeVersion];
  if (values.some((value) => value.includes("\t") || value.includes("\n"))) {
    fail(`Maven artifact manifest value contains a tab or newline: ${JSON.stringify(values)}`);
  }
  return values.join("\t");
}

async function runtimeRows(assetRoot) {
  const version = await currentVersion("liboliphaunt-native");
  const artifacts = runtimeMavenArtifacts(version);
  const rows = [];
  for (const coordinate of await registryPackageNames("liboliphaunt-native", "maven")) {
    const [groupId, artifactId] = splitMavenCoordinate(coordinate);
    if (groupId !== "dev.oliphaunt.runtime") {
      fail(`liboliphaunt-native Maven artifact ${coordinate} must use dev.oliphaunt.runtime`);
    }
    const artifact = artifacts.get(artifactId);
    if (artifact === undefined) {
      fail(`liboliphaunt-native Maven artifact ${coordinate} has no release asset mapping`);
    }
    rows.push(
      tsvRow({
        groupId,
        artifactId,
        version,
        file: await requireFile(path.join(assetRoot, artifact.filename), artifactId),
        name: artifact.name,
        description: artifact.description,
      }),
    );
  }
  return rows;
}

function defaultNativeExtensionKind(target) {
  if (target === "ios-xcframework" || target.startsWith("android-")) {
    return "native-static-registry";
  }
  return "native-dynamic";
}

function wasixExtensionTargetId(runtimeTarget) {
  return runtimeTarget === "portable" ? "wasix-portable" : runtimeTarget;
}

function defaultExtensionTargetRows(product) {
  const rows = [];
  for (const target of checkedPublishedTargets("liboliphaunt-native", "liboliphaunt-native", NATIVE_RUNTIME_TARGETS)) {
    rows.push({
      target,
      family: "native",
      kind: defaultNativeExtensionKind(target),
      status: "supported",
      published: true,
      sourceFile: `${moonReleaseMetadata(product).packagePath}/release.toml`,
    });
  }
  for (const target of checkedPublishedTargets("liboliphaunt-wasix", "liboliphaunt-wasix", WASIX_TARGETS)) {
    if (target === "portable") {
      rows.push({
        target: wasixExtensionTargetId(target),
        family: "wasix",
        kind: "wasix-runtime",
        status: "supported",
        published: true,
        sourceFile: `${moonReleaseMetadata(product).packagePath}/release.toml`,
      });
    }
  }
  if (rows.length === 0) {
    fail(`${product} could not derive any exact-extension artifact targets`);
  }
  return rows;
}

function boolValue(value, label) {
  if (typeof value === "boolean") {
    return value;
  }
  fail(`${label} must be true or false`);
}

function stringValue(value, label) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  fail(`${label} must be a non-empty string`);
}

async function extensionArtifactTargets(product) {
  const productPath = moonReleaseMetadata(product).packagePath;
  const overridePath = path.join(ROOT, productPath, "targets", "artifacts.toml");
  const defaultRows = defaultExtensionTargetRows(product);
  let rows;
  let sourceLabel;
  const hasOverride = existsSync(overridePath);
  if (hasOverride) {
    const data = await readToml(overridePath);
    if (data.schema !== EXTENSION_ARTIFACT_SCHEMA) {
      fail(`${rel(overridePath)} must use schema = ${JSON.stringify(EXTENSION_ARTIFACT_SCHEMA)}`);
    }
    if (!Array.isArray(data.targets) || data.targets.length === 0) {
      fail(`${rel(overridePath)} must define [[targets]] rows`);
    }
    rows = data.targets;
    sourceLabel = rel(overridePath);
  } else {
    rows = defaultRows;
    sourceLabel = `${productPath}/release.toml`;
  }

  const allowedOverrideKeys = new Set(
    defaultRows.map((row) => JSON.stringify([row.target, row.family, row.kind])),
  );
  const seen = new Set();
  return rows.map((row, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      fail(`${sourceLabel} targets[${index}] must be a table`);
    }
    const target = stringValue(row.target, `${sourceLabel} targets[${index}].target`);
    const family = stringValue(row.family, `${sourceLabel} targets[${index}].family`);
    const kind = stringValue(row.kind, `${sourceLabel} targets[${index}].kind`);
    const status = stringValue(row.status, `${sourceLabel} targets[${index}].status`);
    const published = boolValue(row.published, `${sourceLabel} targets[${index}].published`);
    if (!EXTENSION_FAMILIES.has(family)) {
      fail(`${sourceLabel} target ${target} has invalid family ${JSON.stringify(family)}`);
    }
    if (!EXTENSION_KINDS.has(kind)) {
      fail(`${sourceLabel} target ${target} has invalid kind ${JSON.stringify(kind)}`);
    }
    if (!EXTENSION_STATUSES.has(status)) {
      fail(`${sourceLabel} target ${target} has invalid status ${JSON.stringify(status)}`);
    }
    if (family === "wasix" && kind !== "wasix-runtime") {
      fail(`${sourceLabel} target ${target} must use kind wasix-runtime for wasix family`);
    }
    if (family === "native" && kind === "wasix-runtime") {
      fail(`${sourceLabel} target ${target} cannot use wasix-runtime for native family`);
    }
    if (published && status !== "supported") {
      fail(`${sourceLabel} target ${target} cannot be published with status ${status}`);
    }
    if (!published && (typeof row.unsupported_reason !== "string" || row.unsupported_reason.length === 0)) {
      fail(`${sourceLabel} unpublished target ${target} must explain unsupported_reason`);
    }
    const key = JSON.stringify([target, family, kind]);
    if (seen.has(key)) {
      fail(`${sourceLabel} has duplicate target row ${key}`);
    }
    if (hasOverride && !allowedOverrideKeys.has(key)) {
      fail(`${sourceLabel} target row ${key} is not backed by runtime artifact metadata`);
    }
    seen.add(key);
    return { target, family, kind, status, published };
  });
}

async function publishedAndroidMavenTargets(product) {
  return (await extensionArtifactTargets(product))
    .filter(
      (target) =>
        target.family === "native" &&
        target.published &&
        target.kind === "native-static-registry" &&
        target.target.startsWith("android-"),
    )
    .sort((left, right) => compareText(left.target, right.target));
}

async function exactExtensionProducts() {
  const products = [];
  for (const product of [...moonReleaseProducts().keys()].sort()) {
    const config = await readReleaseToml(product);
    if (["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind)) {
      products.push(product);
    }
  }
  return products;
}

async function extensionRows(extensionRoot, selectedProducts) {
  const products = selectedProducts.length > 0 ? selectedProducts : await exactExtensionProducts();
  const rows = [];
  for (const product of [...products].sort()) {
    const config = await readReleaseToml(product);
    if (!["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind)) {
      fail(`${product} is not an exact extension product`);
    }
    const sqlNames = config.kind === "exact-extension-bundle"
      ? config.extension_sql_names
      : [config.extension_sql_name];
    if (
      !Array.isArray(sqlNames)
      || sqlNames.length === 0
      || sqlNames.some((sqlName) => typeof sqlName !== "string" || !sqlName)
      || new Set(sqlNames).size !== sqlNames.length
      || JSON.stringify(sqlNames) !== JSON.stringify([...sqlNames].sort())
    ) {
      fail(`${product} release metadata must declare a sorted, unique exact extension member set`);
    }
    const version = await currentVersion(product);
    const compatibility = config.extension?.compatibility;
    const runtimeProduct = compatibility?.native_runtime_product;
    const runtimeVersion = compatibility?.native_runtime_version;
    if (runtimeProduct !== "liboliphaunt-native" || typeof runtimeVersion !== "string" || !runtimeVersion) {
      fail(`${product} must declare exact native runtime compatibility for Maven carriers`);
    }
    const currentRuntimeVersion = await currentVersion(runtimeProduct);
    if (runtimeVersion !== currentRuntimeVersion) {
      fail(`${product} native runtime compatibility ${runtimeVersion} does not match ${runtimeProduct}@${currentRuntimeVersion}`);
    }
    const productRoot = path.join(extensionRoot, product, "release-assets");
    const targets = await publishedAndroidMavenTargets(product);
    if (targets.length === 0) {
      fail(`${product} has no published Android Maven extension targets`);
    }
    const declaredCoordinates = new Set(await registryPackageNames(product, "maven"));
    for (const target of targets) {
      const coordinate = `dev.oliphaunt.extensions:${product}-${target.target}`;
      if (!declaredCoordinates.delete(coordinate)) {
        fail(`${product} release metadata is missing Maven carrier ${coordinate}`);
      }
      const filename = config.kind === "exact-extension-bundle"
        ? `${product}-${version}-native-${target.target}-bundle.tar.gz`
        : `${product}-${version}-native-${target.target}-runtime.tar.gz`;
      const memberLabel = sqlNames.length === 1
        ? `the ${sqlNames[0]} PostgreSQL extension`
        : `the PostgreSQL 18 contrib bundle (${sqlNames.length} exact extension members)`;
      rows.push(
        tsvRow({
          groupId: "dev.oliphaunt.extensions",
          artifactId: `${product}-${target.target}`,
          version,
          file: await requireFile(path.join(productRoot, filename), `${product} ${target.target} Maven artifact`),
          name: `Oliphaunt ${sqlNames.length === 1 ? `extension ${sqlNames[0]}` : "PostgreSQL 18 contrib extensions"} ${target.target}`,
          description: `Package-managed Oliphaunt Android runtime and static-link artifacts for ${memberLabel} on ${target.target}.`,
          runtimeProduct,
          runtimeVersion,
        }),
      );
    }
    if (declaredCoordinates.size > 0) {
      fail(`${product} declares unexpected Maven carrier(s): ${[...declaredCoordinates].sort().join(", ")}`);
    }
  }
  return rows;
}

function valueArg(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    output: undefined,
    runtimeAssetRoot: "target/liboliphaunt/release-assets",
    extensionArtifactRoot: "target/extension-artifacts",
    runtime: false,
    extensions: false,
    extensionProducts: [],
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--runtime-asset-root") {
      args.runtimeAssetRoot = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--extension-artifact-root") {
      args.extensionArtifactRoot = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--runtime") {
      args.runtime = true;
      index += 1;
    } else if (arg === "--extensions") {
      args.extensions = true;
      index += 1;
    } else if (arg === "--extension-product") {
      args.extensionProducts.push(valueArg(argv, index, arg));
      index += 2;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!args.output) {
    fail("--output is required");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const includeRuntime = args.runtime || !args.extensions;
  const includeExtensions = args.extensions || args.extensionProducts.length > 0;
  const rows = [];
  if (includeRuntime) {
    rows.push(...(await runtimeRows(repoPath(args.runtimeAssetRoot))));
  }
  if (includeExtensions) {
    rows.push(...(await extensionRows(repoPath(args.extensionArtifactRoot), args.extensionProducts)));
  }
  if (rows.length === 0) {
    fail("manifest would be empty");
  }
  const output = repoPath(args.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${rows.join("\n")}\n`, "utf8");
  console.log(`Wrote ${rows.length} Maven artifact publication row(s) to ${rel(output)}`);
}

await main(Bun.argv.slice(2));
