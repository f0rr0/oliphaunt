#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  compareText,
  exactExtensionProducts,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import { ROOT } from "./release-cli-utils.mjs";
import { runBunProductDryRun } from "./release-product-dry-run.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import { validateCargoPayloadPartSets } from "./publication-lock.mjs";
import { validateMavenCentralPublication } from "./maven-central-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";

// The normal release dry-run and this offline aggregate gate deliberately use
// the same carrier materialization entry point. Keeping the function identity
// public makes accidental forked staging paths directly regression-testable.
export const offlineRegistryCarrierRunner = runBunProductDryRun;

const TOOL = "offline-registry-carrier-qualification.mjs";
const NATIVE_PRODUCT = "liboliphaunt-native";
const SCOPES = new Set(["native", "extensions"]);
const DEFAULT_EVIDENCE_ROOT = path.join(
  ROOT,
  "target/release-work/offline-registry-carrier-qualification",
);
const FORBIDDEN_CREDENTIAL_VARIABLES = Object.freeze([
  "CARGO_REGISTRY_TOKEN",
  "CARGO_REGISTRIES_CRATES_IO_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "MAVEN_CENTRAL_USERNAME",
  "MAVEN_CENTRAL_PASSWORD",
  "ORG_GRADLE_PROJECT_mavenCentralUsername",
  "ORG_GRADLE_PROJECT_mavenCentralPassword",
]);

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function repositoryRelative(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file.split(path.sep).join("/")
    : relative.split(path.sep).join("/");
}

function parseJsonList(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw error(`${label} must be valid JSON: ${cause.message}`);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw error(`${label} must be a JSON array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw error(`${label} must not contain duplicate products`);
  }
  return value;
}

export function qualificationProducts(scope, rawProducts = undefined) {
  if (!SCOPES.has(scope)) {
    throw error(`scope must be one of ${[...SCOPES].join(", ")}, got ${JSON.stringify(scope)}`);
  }
  if (scope === "native") {
    if (rawProducts !== undefined) {
      const requested = parseJsonList(rawProducts, "products");
      if (requested.length !== 1 || requested[0] !== NATIVE_PRODUCT) {
        throw error(`native scope accepts only ${JSON.stringify([NATIVE_PRODUCT])}`);
      }
    }
    return [NATIVE_PRODUCT];
  }

  if (rawProducts === undefined) {
    throw error("extensions scope requires --products-json or OLIPHAUNT_REGISTRY_CARRIER_PRODUCTS_JSON");
  }
  const requested = parseJsonList(rawProducts, "products");
  if (requested.length === 0) {
    throw error("extensions scope requires at least one exact-extension product");
  }
  const canonical = exactExtensionProducts(TOOL);
  const known = new Set(canonical);
  const unknown = requested.filter((product) => !known.has(product)).sort(compareText);
  if (unknown.length > 0) {
    throw error(
      `extensions scope contains non-public or unknown exact-extension products: ${unknown.join(", ")}`,
    );
  }
  const selected = new Set(requested);
  return canonical.filter((product) => selected.has(product));
}

function outputRoots(product) {
  if (product === NATIVE_PRODUCT) {
    return Object.freeze({
      cargo: path.join(ROOT, "target/liboliphaunt/cargo-artifacts"),
      npm: path.join(ROOT, "target/release/npm-packages"),
      maven: path.join(ROOT, "target/release/maven-staging/liboliphaunt-native-maven-dry-run"),
    });
  }
  return Object.freeze({
    cargo: path.join(ROOT, "target/release/extension-dry-run/cargo", product),
    npm: path.join(ROOT, "target/release/extension-dry-run/npm", product),
    maven: path.join(ROOT, "target/release/maven-staging", `${product}-maven-dry-run`),
  });
}

function cleanProductOutputs(roots) {
  for (const root of Object.values(roots)) {
    rmSync(root, { recursive: true, force: true });
  }
}

function rejectRegistryCredentials(environment) {
  const present = FORBIDDEN_CREDENTIAL_VARIABLES.filter((name) => environment[name]?.trim());
  if (present.length > 0) {
    throw error(`registry credentials are forbidden during local carrier qualification: ${present.join(", ")}`);
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

export function inventoryOutputRoot(root) {
  if (!existsSync(root)) {
    throw error(`canonical carrier materializer did not create ${repositoryRelative(root)}`);
  }
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw error(`carrier output root must be a real directory: ${repositoryRelative(root)}`);
  }
  let files = 0;
  let bytes = 0;
  const emptyFiles = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        throw error(`carrier output must not contain symlink ${repositoryRelative(candidate)}`);
      }
      if (metadata.isDirectory()) {
        pending.push(candidate);
      } else if (metadata.isFile()) {
        if (metadata.size === 0) {
          emptyFiles.push(path.relative(root, candidate).split(path.sep).join("/"));
        }
        files += 1;
        bytes += metadata.size;
      } else {
        throw error(`carrier output contains a non-portable special entry: ${repositoryRelative(candidate)}`);
      }
    }
  }
  if (files === 0) {
    throw error(`carrier output root is empty: ${repositoryRelative(root)}`);
  }
  if (bytes === 0) {
    throw error(`carrier output root contains no non-empty files: ${repositoryRelative(root)}`);
  }
  return {
    bytes,
    emptyFiles: emptyFiles.sort(compareText),
    files,
    root: repositoryRelative(root),
  };
}

function expectedRegistryIdentities(product) {
  return registryPackageRows({ product }, TOOL)
    .map(({ packageKind, packageName }) => `${packageKind}:${packageName}`)
    .sort(compareText);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function pathIsUnder(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkRegularFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const candidate = path.join(directory, entry.name);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        throw error(`carrier output must not contain symlink ${repositoryRelative(candidate)}`);
      }
      if (metadata.isDirectory()) {
        pending.push(candidate);
      } else if (metadata.isFile()) {
        files.push(candidate);
      } else {
        throw error(`carrier output contains a non-portable special entry: ${repositoryRelative(candidate)}`);
      }
    }
  }
  return files.sort(compareText);
}

function requiredPackageIdentity(packageData, label) {
  if (
    packageData === null
    || Array.isArray(packageData)
    || typeof packageData !== "object"
    || typeof packageData.name !== "string"
    || packageData.name.length === 0
    || typeof packageData.version !== "string"
    || packageData.version.length === 0
  ) {
    throw error(`${label} must declare non-empty name and version strings`);
  }
  return { name: packageData.name, version: packageData.version };
}

function cargoDependencyNames(manifest) {
  const names = new Set();
  const addTable = (table) => {
    if (table === null || Array.isArray(table) || typeof table !== "object") return;
    for (const [alias, dependency] of Object.entries(table)) {
      const name = dependency !== null
        && !Array.isArray(dependency)
        && typeof dependency === "object"
        && typeof dependency.package === "string"
        && dependency.package.length > 0
        ? dependency.package
        : alias;
      if (name.length > 0) names.add(name);
    }
  };
  for (const key of ["dependencies", "build-dependencies", "dev-dependencies"]) {
    addTable(manifest[key]);
  }
  if (manifest.target !== null && !Array.isArray(manifest.target) && typeof manifest.target === "object") {
    for (const target of Object.values(manifest.target)) {
      if (target === null || Array.isArray(target) || typeof target !== "object") continue;
      for (const key of ["dependencies", "build-dependencies", "dev-dependencies"]) {
        addTable(target[key]);
      }
    }
  }
  return [...names].sort(compareText);
}

function cargoArchiveIdentity(file) {
  const entries = readPortableArchiveEntries(file);
  const manifests = [...entries.entries()].filter(([name, entry]) =>
    entry.isFile && /^[^/]+\/Cargo[.]toml$/u.test(name));
  if (manifests.length !== 1) {
    throw error(`${repositoryRelative(file)} must contain exactly one top-level Cargo.toml, found ${manifests.length}`);
  }
  const [member, entry] = manifests[0];
  let manifest;
  try {
    manifest = Bun.TOML.parse(entry.data().toString("utf8"));
  } catch (cause) {
    throw error(`${repositoryRelative(file)} ${member} is not valid TOML: ${cause.message}`);
  }
  const identity = requiredPackageIdentity(manifest?.package, `${repositoryRelative(file)} ${member} [package]`);
  const expectedRoot = `${identity.name}-${identity.version}`;
  if (member !== `${expectedRoot}/Cargo.toml`) {
    throw error(`${repositoryRelative(file)} Cargo archive root must be ${expectedRoot}`);
  }
  if (path.basename(file) !== `${expectedRoot}.crate`) {
    throw error(`${repositoryRelative(file)} filename does not match its Cargo identity ${identity.name}@${identity.version}`);
  }
  return {
    ...identity,
    dependencies: cargoDependencyNames(manifest),
  };
}

function npmArchiveIdentity(file) {
  const entries = readPortableArchiveEntries(file);
  const packageJson = entries.get("package/package.json");
  if (packageJson === undefined || !packageJson.isFile) {
    throw error(`${repositoryRelative(file)} is missing its regular package/package.json`);
  }
  let manifest;
  try {
    manifest = JSON.parse(packageJson.data().toString("utf8"));
  } catch (cause) {
    throw error(`${repositoryRelative(file)} package/package.json is not valid JSON: ${cause.message}`);
  }
  const identity = requiredPackageIdentity(manifest, `${repositoryRelative(file)} package/package.json`);
  const prefix = identity.name.replace(/^@/u, "").replace("/", "-");
  if (path.basename(file) !== `${prefix}-${identity.version}.tgz`) {
    throw error(`${repositoryRelative(file)} filename does not match its npm identity ${identity.name}@${identity.version}`);
  }
  return identity;
}

function assertIdentityVersion(carrier, observed, file) {
  if (observed.version !== carrier.version) {
    throw error(
      `${repositoryRelative(file)} contains ${observed.name}@${observed.version}; expected ${carrier.name}@${carrier.version}`,
    );
  }
}

function manifestCratePath(raw, manifestPath) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw error(`${repositoryRelative(manifestPath)} package rows must declare cratePath`);
  }
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
}

function validateCargoPackageManifests(root, files, archives) {
  const manifestPaths = files.filter((file) => path.basename(file) === "packages.json");
  const bound = new Set();
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      throw error(`${repositoryRelative(manifestPath)} is not valid JSON: ${cause.message}`);
    }
    if (
      !new Set([
        "oliphaunt-liboliphaunt-cargo-artifacts-v1",
        "oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2",
      ]).has(manifest?.schema)
      || !Array.isArray(manifest.packages)
      || manifest.packages.length === 0
    ) {
      throw error(`${repositoryRelative(manifestPath)} has an unsupported or empty Cargo carrier manifest`);
    }
    const manifestRoot = path.dirname(manifestPath);
    const rowNames = new Set();
    const rowPaths = new Set();
    for (const [index, row] of manifest.packages.entries()) {
      if (row === null || Array.isArray(row) || typeof row !== "object" || typeof row.name !== "string" || row.name.length === 0) {
        throw error(`${repositoryRelative(manifestPath)} package row ${index + 1} is invalid`);
      }
      const cratePath = manifestCratePath(row.cratePath, manifestPath);
      if (!pathIsUnder(cratePath, manifestRoot)) {
        throw error(`${repositoryRelative(manifestPath)} package ${row.name} escapes its manifest root`);
      }
      if (rowNames.has(row.name) || rowPaths.has(cratePath)) {
        throw error(`${repositoryRelative(manifestPath)} repeats Cargo package or archive binding ${row.name}`);
      }
      rowNames.add(row.name);
      rowPaths.add(cratePath);
      const archive = archives.get(cratePath);
      if (archive === undefined) {
        throw error(`${repositoryRelative(manifestPath)} references missing physical Cargo archive ${repositoryRelative(cratePath)}`);
      }
      if (archive.name !== row.name) {
        throw error(`${repositoryRelative(manifestPath)} names ${row.name} but ${repositoryRelative(cratePath)} contains ${archive.name}`);
      }
      if (Object.hasOwn(row, "size")) {
        if (!Number.isSafeInteger(row.size) || row.size <= 0 || row.size !== lstatSync(cratePath).size) {
          throw error(`${repositoryRelative(manifestPath)} has a size mismatch for ${row.name}`);
        }
      }
      if (Object.hasOwn(row, "sha256")) {
        if (!/^[0-9a-f]{64}$/u.test(row.sha256) || row.sha256 !== sha256File(cratePath)) {
          throw error(`${repositoryRelative(manifestPath)} has a SHA-256 mismatch for ${row.name}`);
        }
      }
      if (bound.has(cratePath)) {
        throw error(`${repositoryRelative(cratePath)} is bound by more than one Cargo carrier manifest`);
      }
      bound.add(cratePath);
    }
    const physicalPaths = [...archives.keys()].filter((file) => pathIsUnder(file, manifestRoot));
    const missingRows = physicalPaths.filter((file) => !rowPaths.has(file));
    const missingFiles = [...rowPaths].filter((file) => !physicalPaths.includes(file));
    if (missingRows.length > 0 || missingFiles.length > 0) {
      throw error(
        `${repositoryRelative(manifestPath)} Cargo archive closure differs: unbound=${JSON.stringify(missingRows.map(repositoryRelative))}, missing=${JSON.stringify(missingFiles.map(repositoryRelative))}`,
      );
    }
  }
}

function observeCargoIdentities(root, catalog) {
  const files = walkRegularFiles(root);
  const crateFiles = files.filter((file) => file.endsWith(".crate"));
  const archives = new Map();
  const byName = new Map();
  const carrierRows = [];
  for (const file of crateFiles) {
    const identity = cargoArchiveIdentity(file);
    const carrier = resolveActualCarrier(catalog, "cargo", identity.name, TOOL);
    assertIdentityVersion(carrier, identity, file);
    if (byName.has(identity.name)) {
      throw error(`duplicate physical Cargo identity ${identity.name}@${identity.version}: ${repositoryRelative(byName.get(identity.name).file)} and ${repositoryRelative(file)}`);
    }
    const observed = { ...identity, file };
    byName.set(identity.name, observed);
    archives.set(path.resolve(file), observed);
    carrierRows.push({
      ...carrier,
      packageDependencies: identity.dependencies.map((name) => ({ ecosystem: "cargo", name })),
    });
  }
  validateCargoPackageManifests(root, files, archives);
  validateCargoPayloadPartSets(carrierRows);
  return byName;
}

function observeNpmIdentities(root, catalog) {
  const byName = new Map();
  for (const file of walkRegularFiles(root).filter((candidate) => candidate.endsWith(".tgz"))) {
    const identity = npmArchiveIdentity(file);
    const carrier = resolveActualCarrier(catalog, "npm", identity.name, TOOL);
    assertIdentityVersion(carrier, identity, file);
    const sha256 = sha256File(file);
    const previous = byName.get(identity.name);
    if (previous !== undefined) {
      if (carrier.role !== "facade" || carrier.target !== null || previous.sha256 !== sha256) {
        throw error(`duplicate or conflicting physical npm identity ${identity.name}@${identity.version}: ${repositoryRelative(previous.file)} and ${repositoryRelative(file)}`);
      }
      continue;
    }
    byName.set(identity.name, { ...identity, file, sha256 });
  }
  return byName;
}

function observeMavenIdentities(root, catalog) {
  const files = walkRegularFiles(root);
  const pomFiles = files.filter((file) => file.endsWith(".pom"));
  const byName = new Map();
  const coordinateDirectories = new Set();
  for (const pom of pomFiles) {
    const directory = path.dirname(pom);
    const members = readdirSync(directory, { withFileTypes: true });
    if (members.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw error(`${repositoryRelative(directory)} Maven coordinate must contain only regular files`);
    }
    const publication = validateMavenCentralPublication({
      context: repositoryRelative(pom),
      files: members.map((entry) => ({
        name: entry.name,
        size: lstatSync(path.join(directory, entry.name)).size,
      })),
      pomText: readFileSync(pom, "utf8"),
    });
    const identity = {
      name: `${publication.groupId}:${publication.artifactId}`,
      version: publication.version,
    };
    const prefix = `${publication.artifactId}-${publication.version}`;
    const expectedRelativePom = path.join(
      ...publication.groupId.split("."),
      publication.artifactId,
      publication.version,
      `${prefix}.pom`,
    );
    if (path.relative(root, pom) !== expectedRelativePom) {
      throw error(`${repositoryRelative(pom)} path does not match Maven identity ${identity.name}:${identity.version}`);
    }
    const expectedFiles = [
      `${prefix}-javadoc.jar`,
      `${prefix}-sources.jar`,
      `${prefix}.pom`,
      `${prefix}.${publication.packaging}`,
    ].sort(compareText);
    const actualFiles = members.map((entry) => entry.name).sort(compareText);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw error(`${identity.name}:${identity.version} Maven companion closure differs: expected=${JSON.stringify(expectedFiles)}, actual=${JSON.stringify(actualFiles)}`);
    }
    const carrier = resolveActualCarrier(catalog, "maven", identity.name, TOOL);
    assertIdentityVersion(carrier, identity, pom);
    if (byName.has(identity.name)) {
      throw error(`duplicate physical Maven identity ${identity.name}:${identity.version}`);
    }
    byName.set(identity.name, { ...identity, file: pom });
    coordinateDirectories.add(path.resolve(directory));
  }
  const stray = files.filter((file) => !coordinateDirectories.has(path.resolve(path.dirname(file))));
  if (stray.length > 0) {
    throw error(`Maven carrier output contains files outside a POM-bound coordinate: ${stray.map(repositoryRelative).join(", ")}`);
  }
  return byName;
}

function assertStaticIdentityClosure(catalog, observedByEcosystem) {
  for (const ecosystem of ["cargo", "npm", "maven"]) {
    const expected = catalog.carriers
      .filter((carrier) => carrier.ecosystem === ecosystem)
      .map((carrier) => carrier.name)
      .sort(compareText);
    const observed = observedByEcosystem[ecosystem];
    const missing = expected.filter((name) => !observed.has(name));
    if (missing.length > 0) {
      throw error(`physical ${ecosystem} carrier closure is missing declared base identities: ${missing.join(", ")}`);
    }
  }
}

export function observeRegistryIdentities(product, roots = outputRoots(product)) {
  const catalog = loadPublicationCatalog(TOOL, { products: [product] });
  const outputs = [roots.cargo, roots.npm, roots.maven].map(inventoryOutputRoot);
  const observedByEcosystem = {
    cargo: observeCargoIdentities(roots.cargo, catalog),
    npm: observeNpmIdentities(roots.npm, catalog),
    maven: observeMavenIdentities(roots.maven, catalog),
  };
  assertStaticIdentityClosure(catalog, observedByEcosystem);
  const observedRegistryIdentities = [
    ...[...observedByEcosystem.cargo.keys()].map((name) => `crates:${name}`),
    ...[...observedByEcosystem.npm.keys()].map((name) => `npm:${name}`),
    ...[...observedByEcosystem.maven.keys()].map((name) => `maven:${name}`),
  ].sort(compareText);
  return { observedRegistryIdentities, outputs };
}

export async function qualifyOfflineRegistryCarriers({
  scope,
  productsJson = undefined,
  evidenceRoot = DEFAULT_EVIDENCE_ROOT,
  runProductDryRun = offlineRegistryCarrierRunner,
  outputRootsForProduct = outputRoots,
} = {}) {
  const products = qualificationProducts(scope, productsJson);
  const rootsByProduct = new Map(products.map((product) => [product, outputRootsForProduct(product)]));
  rejectRegistryCredentials(process.env);
  const previousCargoOffline = process.env.CARGO_NET_OFFLINE;
  const previousCargoHome = process.env.CARGO_HOME;
  const previousNpmOffline = process.env.npm_config_offline;
  const cargoHomesRoot = path.join(evidenceRoot, "isolated-cargo-homes");
  try {
    for (const product of products) {
      cleanProductOutputs(rootsByProduct.get(product));
      const cargoHome = path.join(cargoHomesRoot, product);
      rmSync(cargoHome, { recursive: true, force: true });
      mkdirSync(cargoHome, { recursive: true });
      process.env.CARGO_HOME = cargoHome;
      process.env.CARGO_NET_OFFLINE = "true";
      process.env.npm_config_offline = "true";
      await runProductDryRun(product, { allowDirty: true });
      rmSync(cargoHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(cargoHomesRoot, { recursive: true, force: true });
    restoreEnvironment("CARGO_HOME", previousCargoHome);
    restoreEnvironment("CARGO_NET_OFFLINE", previousCargoOffline);
    restoreEnvironment("npm_config_offline", previousNpmOffline);
  }

  const productEvidence = products.map((product) => {
    const observed = observeRegistryIdentities(product, rootsByProduct.get(product));
    return {
      expectedRegistryIdentities: expectedRegistryIdentities(product),
      observedRegistryIdentities: observed.observedRegistryIdentities,
      outputs: observed.outputs,
      product,
    };
  });
  const evidence = {
    schema: "oliphaunt-offline-registry-carrier-qualification-v1",
    networkPolicy: {
      cargo: "offline-with-a-fresh-empty-per-product-CARGO_HOME",
      gradle: "not-invoked",
      maven: "deterministic-local-staging",
      npm: "offline-local-pack-only",
      registryCredentials: "forbidden",
      registryMutation: "forbidden",
    },
    products: productEvidence,
    scope,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  const evidencePath = path.join(evidenceRoot, `${scope}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `Qualified offline ${scope} registry carriers for ${products.length} product(s): ${products.join(", ")}`,
  );
  console.log(`Qualification evidence: ${repositoryRelative(evidencePath)}`);
  return evidence;
}

function usage() {
  console.log(`usage: ${TOOL} --scope native|extensions [--products-json JSON]

Materializes and validates registry carriers from already-qualified same-run
release assets. Cargo uses a fresh empty offline cache for every product;
Maven staging is local and deterministic. This command never invokes Gradle,
publishes, requests OIDC, or consumes registry credentials.
`);
}

export function parseArgs(argv, environment = process.env) {
  let scope = null;
  let productsJson = environment.OLIPHAUNT_REGISTRY_CARRIER_PRODUCTS_JSON;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      scope = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else if (arg === "--products-json") {
      productsJson = argv[index + 1];
      if (productsJson === undefined) throw error("--products-json requires a value");
      index += 1;
    } else if (arg.startsWith("--products-json=")) {
      productsJson = arg.slice("--products-json=".length);
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else {
      throw error(`unknown argument ${arg}`);
    }
  }
  if (scope === null) throw error("--scope is required");
  return { help: false, productsJson, scope };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.help) {
      usage();
    } else {
      await qualifyOfflineRegistryCarriers(args);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
