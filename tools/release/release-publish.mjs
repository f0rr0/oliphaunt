#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT, run } from "./release-cli-utils.mjs";
import {
  DEFAULT_PUBLICATION_LOCK,
  assertLockedArtifactSet,
  assertLockedProductArtifacts,
  assertPublicationLockSource,
  discoverPublicationArtifacts,
  loadPublicationLock,
  lockedCarrierDirectory,
  lockedCarrierFile,
  lockedCarriers,
  lockedProductArtifactPaths,
} from "./publication-lock.mjs";
import {
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
} from "./crates-io-bootstrap-capacity.mjs";
import { publishFrozenCargoCrate } from "./frozen-cargo-publish.mjs";
import {
  createGpgSigner,
  prepareFrozenMavenBundle,
  publishFrozenMavenBundle,
} from "./frozen-maven-publish.mjs";
import {
  SUPPORTED_BUN_PRODUCT_DRY_RUNS,
  runBunProductDryRun,
} from "./release-product-dry-run.mjs";
import {
  stagedKotlinMavenRepo,
  stagedJsrSourceDir,
} from "./release-sdk-product-dry-run.mjs";
import {
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
} from "./release-artifact-targets.mjs";
import { releaseToolingLagStatus } from "./release-graph.mjs";
import { executeNormalPublicationPlan } from "./normal-publication-executor.mjs";
import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import { verifyLockedCarrierIntegrity } from "./registry-integrity.mjs";

const TOOL = "release-publish.mjs";
const COMMANDS = new Set(["publish", "publish-dry-run"]);
const REGISTRY_PUBLICATION_CHECK = [
  "tools/dev/bun.sh",
  "tools/release/check_registry_publication.mjs",
];

function usage() {
  console.log(`usage: tools/release/release-publish.mjs <publish|publish-dry-run> [publish args] [--publication-lock FILE]

Runs protected release publish and publish dry-run operations through the Bun
release command surface. The public no-product publish dry-run and product
dry-runs are handled in Bun, including the legacy --wasm shortcut for the WASIX
Rust SDK dry-run. Protected publish steps and no-product publish validation are
handled in Bun.

Every real publish requires an exact-SHA frozen publication lock. The one-time
identity bootstrap uses:
  publish --bootstrap-identities --carrier-id cargo:NAME|npm:NAME \\
    --head-ref SHA --publication-lock FILE [--bootstrap-ledger FILE]
Bootstrap mode cannot publish GitHub releases/assets, Maven, or JSR.

Normal registry publication uses one lock-derived global topology:
  publish --registry-plan --products-json JSON --head-ref SHA \
    --publication-lock FILE
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function removeValueFlag(args, name) {
  const output = [];
  let selected = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      if (index + 1 >= args.length) {
        throw new Error(`${name} requires a value`);
      }
      selected = args[index + 1];
      index += 1;
    } else if (value.startsWith(`${name}=`)) {
      selected = value.slice(name.length + 1);
    } else {
      output.push(value);
    }
  }
  return { args: output, value: selected };
}

const lockArgs = removeValueFlag(Bun.argv.slice(2), "--publication-lock");
const ledgerArgs = removeValueFlag(lockArgs.args, "--bootstrap-ledger");
const argv = ledgerArgs.args.filter((arg) => arg !== "--bootstrap-identities");
const command = argv[0];
const BOOTSTRAP_IDENTITIES = ledgerArgs.args.includes("--bootstrap-identities");
const PUBLICATION_LOCK_PATH = path.resolve(
  ROOT,
  lockArgs.value ?? process.env.OLIPHAUNT_PUBLICATION_LOCK ?? DEFAULT_PUBLICATION_LOCK,
);
const BOOTSTRAP_LEDGER_PATH = path.resolve(
  ROOT,
  ledgerArgs.value ?? process.env.OLIPHAUNT_BOOTSTRAP_LEDGER ?? "target/release/bootstrap-ledger",
);
let ACTIVE_PUBLICATION_LOCK = null;
const LEGACY_WASM_DRY_RUN_PRODUCT = "oliphaunt-wasix-rust";
const EXTENSION_PRODUCTS = new Set(exactExtensionProducts(TOOL));
const GITHUB_RELEASE_ASSET_PRODUCTS = new Set([
  "liboliphaunt-native",
  "liboliphaunt-wasix",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
]);

if (command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

if (!COMMANDS.has(command)) {
  usage();
  fail(`expected publish or publish-dry-run, got ${command ?? "<missing>"}`);
}

if (BOOTSTRAP_IDENTITIES && command !== "publish") {
  fail("--bootstrap-identities is valid only for publish");
}
if (command === "publish") {
  try {
    ACTIVE_PUBLICATION_LOCK = loadPublicationLock(PUBLICATION_LOCK_PATH);
    assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, "HEAD");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.env.OLIPHAUNT_PUBLICATION_LOCK = PUBLICATION_LOCK_PATH;
}

function isNoProductPublishDryRun(command, args) {
  return command === "publish-dry-run" && noProductPublishDryRunPassthrough(args) !== null;
}

function selectsProducts(args) {
  return args.some((arg) => arg === "--products-json" || arg.startsWith("--products-json="));
}

function flagValue(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      if (index + 1 >= args.length) {
        fail(`${flag} requires a value`);
      }
      return args[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return null;
}

function unexpectedValueFlagArguments(args, allowed) {
  const unexpected = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const exact = allowed.has(value);
    const inline = [...allowed].some((flag) => value.startsWith(`${flag}=`));
    if (inline) continue;
    if (!exact) {
      unexpected.push(value);
      continue;
    }
    if (index + 1 >= args.length) {
      unexpected.push(value);
      continue;
    }
    index += 1;
  }
  return unexpected;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function noProductPublishDryRunPassthrough(args) {
  if (args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return args.filter((arg) => arg !== "--allow-dirty");
}

function legacyWasmPublishDryRunPlan(args) {
  if (!args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    product: LEGACY_WASM_DRY_RUN_PRODUCT,
  };
}

function parseProductsJson(args) {
  const productsJson = flagValue(args, "--products-json");
  if (productsJson === null) {
    return null;
  }
  let requested;
  try {
    requested = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((item) => typeof item === "string")) {
    fail("--products-json must be a non-empty JSON string array");
  }
  return requested;
}

function releaseOrderedProducts(requested) {
  const ordered = jsonOutput([
    "tools/release/release_graph_query.mjs",
    "release-order",
    "--products-json",
    JSON.stringify(requested),
  ]);
  if (!Array.isArray(ordered) || ordered.length === 0 || !ordered.every((item) => typeof item === "string")) {
    fail("release graph could not resolve the selected publish products");
  }
  return ordered;
}

function publishProductStepPlan(args) {
  const product = flagValue(args, "--product");
  const step = flagValue(args, "--step");
  if (product === null && step === null) {
    return null;
  }
  if (product === null || step === null) {
    return null;
  }
  return {
    headRef: flagValue(args, "--head-ref") ?? "HEAD",
    product,
    step,
  };
}

function verifyReleaseTag(product, headRef) {
  if (BOOTSTRAP_IDENTITIES) {
    assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
    return;
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/verify_product_tag.mjs", product, "--target", headRef]);
}

function requireFrozenArtifacts(roots, { products, ecosystem }) {
  let actual;
  try {
    actual = discoverPublicationArtifacts(roots)
      .filter((artifact) => artifact.ecosystem === ecosystem);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    assertLockedArtifactSet(ACTIVE_PUBLICATION_LOCK, actual, { products, ecosystem });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function frozenCarrierPackages(ecosystem, { product = undefined, products = undefined } = {}) {
  const carriers = lockedCarriers(ACTIVE_PUBLICATION_LOCK, { product, products, ecosystem })
    .sort((left, right) => left.publishOrder - right.publishOrder);
  if (carriers.length === 0) {
    fail(`publication lock contains no ${ecosystem} carriers for ${product ?? products?.join(",") ?? "selection"}`);
  }
  return carriers.map((carrier) => {
    try {
      return { ...carrier, file: lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, ecosystem, carrier.name).file };
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
}

function requireFrozenProductArtifacts(product, roots) {
  try {
    assertLockedProductArtifacts(ACTIVE_PUBLICATION_LOCK, product, roots);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function uploadGithubReleaseAssets(product, assets) {
  const command = ["tools/dev/bun.sh", "tools/release/upload_github_release_assets.mjs", product];
  for (const asset of assets) {
    command.push("--asset", asset);
  }
  run(TOOL, command);
}

function publishGithubReleaseAssets(product, headRef) {
  verifyReleaseTag(product, headRef);
  const assets = lockedProductArtifactPaths(ACTIVE_PUBLICATION_LOCK, product)
    .filter(({ artifact }) => artifact.role === "github-release-asset" || artifact.role === "github-release-metadata");
  if (assets.length === 0 || assets.some(({ type }) => type !== "file")) {
    fail(`${product} publication lock contains no regular frozen GitHub release assets`);
  }
  uploadGithubReleaseAssets(product, assets.map(({ path: file }) => rel(file)));
}

function publishExtensionGithubReleaseAssets(product, headRef) {
  publishGithubReleaseAssets(product, headRef);
}

function publishSelectedExtensionGithubReleaseAssets(products, headRef) {
  const extensions = products
    .filter((product) => EXTENSION_PRODUCTS.has(product))
    .sort(compareText);
  if (extensions.length === 0) {
    fail("no extension products selected");
  }
  for (const product of extensions) {
    publishExtensionGithubReleaseAssets(product, headRef);
  }
}

function selectedExtensionProducts(products) {
  const extensions = products
    .filter((product) => EXTENSION_PRODUCTS.has(product))
    .sort(compareText);
  if (extensions.length === 0) {
    fail("no extension products selected");
  }
  return extensions;
}

function registryPublicationCheck(args) {
  run(TOOL, [...REGISTRY_PUBLICATION_CHECK, ...args]);
}

function registryPublicationCheckSucceeds(args) {
  const result = spawnSync(REGISTRY_PUBLICATION_CHECK[0], [...REGISTRY_PUBLICATION_CHECK.slice(1), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    fail(`registry publication check failed to start: ${result.error.message}`);
  }
  return result.status === 0;
}

function gitCommit(ref) {
  const result = spawnSync("git", ["rev-parse", `${ref}^{commit}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function productTagReady(product, headRef) {
  const version = currentProductVersionSync(product, TOOL);
  const tagCommit = gitCommit(`${product}-v${version}`);
  const headCommit = gitCommit(headRef);
  return tagCommit !== null && headCommit !== null && releaseToolingLagStatus(tagCommit, headCommit, TOOL).allowed;
}

function publishedRerun(product, headRef) {
  return productTagReady(product, headRef) && productRegistryPublished(product, null);
}

function extensionMavenArtifactsPublished(products) {
  return registryPublicationCheckSucceeds([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    "maven",
    "--require-published",
  ]);
}

function requireExtensionMavenArtifactsPublished(products) {
  registryPublicationCheck([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    "maven",
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ]);
}

function requireExtensionRegistryArtifactsPublished(products, registryKind) {
  registryPublicationCheck([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    registryKind,
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ]);
}

function productRegistryPublished(product, registryKind) {
  return registryPublicationCheckSucceeds([
    "--product",
    product,
    "--registry-kind",
    registryKind,
    "--require-published",
  ]);
}

function requireProductRegistryPublished(product, registryKind) {
  const args = [
    "--product",
    product,
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ];
  if (registryKind !== null) {
    args.splice(2, 0, "--registry-kind", registryKind);
  }
  registryPublicationCheck(args);
}

function requireProductRegistryVersionPublished(product, registryKind, version) {
  registryPublicationCheck([
    "--product",
    product,
    "--registry-kind",
    registryKind,
    "--require-published",
    "--version",
    version,
  ]);
}

function requireLockedCarrierIntegrity(ecosystem, name) {
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/registry-integrity.mjs",
    "--lock",
    PUBLICATION_LOCK_PATH,
    "--carrier-id",
    `${ecosystem}:${name}`,
  ]);
}

function requireLockedProductIntegrity(products, ecosystems) {
  const command = [
    "tools/dev/bun.sh",
    "tools/release/registry-integrity.mjs",
    "--lock",
    PUBLICATION_LOCK_PATH,
    "--products-json",
    JSON.stringify(products),
  ];
  for (const ecosystem of ecosystems) {
    command.push("--ecosystem", ecosystem);
  }
  run(TOOL, command);
}

function releaseEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

async function publishLockedMavenProducts(products, slug) {
  const outputRoot = path.join(ROOT, "target/release/maven-central", slug);
  const gpgHome = path.join(process.env.RUNNER_TEMP ?? "/tmp", `oliphaunt-maven-gpg-${process.pid}-${slug}`);
  try {
    const signFile = createGpgSigner({
      privateKey: releaseEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKey"),
      keyId: releaseEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKeyId"),
      passphrase: releaseEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKeyPassword"),
      home: gpgHome,
    });
    const prepared = prepareFrozenMavenBundle({
      lock: ACTIVE_PUBLICATION_LOCK,
      products,
      outputRoot,
      signFile,
    });
    const result = await publishFrozenMavenBundle({
      bundle: prepared.bundle,
      lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
      deploymentScope: products.slice().sort(compareText).join(","),
      namespace: releaseEnvironment("MAVEN_CENTRAL_NAMESPACE"),
      username: releaseEnvironment("ORG_GRADLE_PROJECT_mavenCentralUsername"),
      password: releaseEnvironment("ORG_GRADLE_PROJECT_mavenCentralPassword"),
    });
    console.log(`Maven Central deployment ${result.deploymentId} published exact frozen payloads for ${products.join(", ")}.`);
  } finally {
    rmSync(gpgHome, { recursive: true, force: true });
  }
}

function npmPackagePublished(packageName, version) {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    fail(`npm view failed to start: ${result.error.message}`);
  }
  return result.status === 0;
}

function cratesioCrateVersionPublished(crateName, version) {
  const result = jsonOutput([
    "tools/release/check_registry_publication.mjs",
    "crate-version-exists",
    "--crate",
    crateName,
    "--version",
    version,
  ]);
  if (result === null || typeof result.exists !== "boolean") {
    fail(`crate-version-exists returned invalid JSON for ${crateName} ${version}`);
  }
  return result.exists;
}

async function waitForCratesioCrate(crateName, version) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (cratesioCrateVersionPublished(crateName, version)) {
      return;
    }
    await Bun.sleep(10_000);
  }
  fail(`${crateName} ${version} did not appear on crates.io after publish`);
}

function registryMutationDeadlineSeconds() {
  const raw = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH?.trim();
  if (!raw) {
    throw new Error("REGISTRY_MUTATION_DEADLINE_EPOCH is required for protected registry mutation");
  }
  return parseRegistryMutationDeadline(raw);
}

async function exactCargoVersionPublished(crateName, version, { allowMissingIdentity = false } = {}) {
  const inventory = await inspectCratesIoVersionState({
    plan: [{ ecosystem: "cargo", name: crateName, version }],
    deadlineEpochSeconds: registryMutationDeadlineSeconds(),
  });
  if (inventory.missingNames.length > 0) {
    if (allowMissingIdentity) return false;
    throw new Error(
      `normal trusted publication cannot create missing Cargo identity ${crateName}; run the protected identity bootstrap first`,
    );
  }
  return inventory.publishedIdentities.length === 1;
}

async function waitForExactCargoVersion(crateName, version, { allowMissingIdentity = false } = {}) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await exactCargoVersionPublished(crateName, version, { allowMissingIdentity })) return;
    await Bun.sleep(10_000);
  }
  throw new Error(`${crateName} ${version} did not appear on crates.io after publish`);
}

async function cargoPublishLockedCrateExact(crateName, version, suppliedCratePath = undefined, {
  alreadyPublished = undefined,
  allowMissingIdentity = false,
  token = process.env.CARGO_REGISTRY_TOKEN,
  tokenDeadlineEpochMs = undefined,
} = {}) {
  let locked;
  locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "cargo", crateName, suppliedCratePath);
  if (locked.carrier.version !== version) {
    throw new Error(`frozen cargo:${crateName} version ${locked.carrier.version} does not match requested ${version}`);
  }
  const present = alreadyPublished ?? await exactCargoVersionPublished(crateName, version, { allowMissingIdentity });
  if (present) {
    await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
    console.log(`${crateName} ${version} is already published on crates.io with lock-matching bytes; skipping frozen upload.`);
    return;
  }
  try {
    const globalDeadlineEpochMs = registryMutationDeadlineSeconds() * 1000;
    const deadlineEpochMs = tokenDeadlineEpochMs === undefined
      ? globalDeadlineEpochMs
      : Math.min(globalDeadlineEpochMs, tokenDeadlineEpochMs);
    await publishFrozenCargoCrate({
      cratePath: locked.file,
      expectedName: crateName,
      expectedVersion: version,
      token,
      deadlineEpochMs,
    });
  } catch (cause) {
    // A transport failure can occur after crates.io accepted the immutable
    // upload. Never retry the mutation here: resolve the only safe outcome by
    // checking the registry, then prove its checksum against the lock.
    if (await exactCargoVersionPublished(crateName, version, { allowMissingIdentity })) {
      await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
      console.log(`${crateName} ${version} became available after an ambiguous upload response; registry bytes match the lock.`);
      return;
    }
    throw cause;
  }
  await waitForExactCargoVersion(crateName, version, { allowMissingIdentity });
  await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
}

async function cargoPublishLockedCrate(crateName, version, suppliedCratePath = undefined) {
  try {
    await cargoPublishLockedCrateExact(crateName, version, suppliedCratePath, {
      allowMissingIdentity: BOOTSTRAP_IDENTITIES,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function npmPublishTarball(packageName, tarball, version) {
  let locked;
  try {
    locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "npm", packageName, tarball);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (locked.carrier.version !== version) {
    fail(`frozen npm:${packageName} version ${locked.carrier.version} does not match requested ${version}`);
  }
  if (npmPackagePublished(packageName, version)) {
    requireLockedCarrierIntegrity("npm", packageName);
    console.log(`${packageName} ${version} is already published on npm with lock-matching bytes; skipping npm publish.`);
    return;
  }
  run(TOOL, ["npm", "publish", locked.file, "--access", "public", "--provenance"]);
}

async function publishBootstrapCarrier(carrierId, headRef) {
  assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
  const matches = lockedCarriers(ACTIVE_PUBLICATION_LOCK).filter(({ id }) => id === carrierId);
  if (matches.length !== 1) {
    fail(`publication lock contains ${matches.length} carriers for bootstrap identity ${carrierId}`);
  }
  const carrier = matches[0];
  if (!["cargo", "npm"].includes(carrier.ecosystem)) {
    fail(`bootstrap identity ${carrierId} is ${carrier.ecosystem}; only Cargo and npm are allowed`);
  }
  let locked;
  try {
    locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, carrier.ecosystem, carrier.name);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (carrier.ecosystem === "cargo") {
    await cargoPublishLockedCrate(carrier.name, carrier.version, locked.file);
    return;
  }
  npmPublishTarball(carrier.name, locked.file, carrier.version);
  await waitForNpmPackage(carrier.name, carrier.version);
  requireLockedCarrierIntegrity("npm", carrier.name);
}

async function publishNodeDirectNpmOptionalPackages(headRef) {
  const product = "oliphaunt-node-direct";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  requireProductRegistryPublished(product, null);
  requireLockedProductIntegrity([product], ["npm"]);
}

function publishBrokerNpmPackages(headRef) {
  const product = "oliphaunt-broker";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  requireProductRegistryPublished(product, "npm");
  requireLockedProductIntegrity([product], ["npm"]);
}

async function publishBrokerCargoArtifacts(headRef) {
  const product = "oliphaunt-broker";
  verifyReleaseTag(product, headRef);
  const carriers = frozenCarrierPackages("cargo", { product });
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  requireProductRegistryPublished(product, "crates");
}

async function publishLiboliphauntWasixCargoArtifacts(headRef) {
  const product = "liboliphaunt-wasix";
  verifyReleaseTag(product, headRef);
  const carriers = frozenCarrierPackages("cargo", { product });
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  requireProductRegistryPublished(product, "crates");
}

async function publishLiboliphauntNativeCargoArtifacts(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  const carriers = frozenCarrierPackages("cargo", { product });
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  requireProductRegistryPublished(product, "crates");
}

function publishLiboliphauntNpmPackages(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  requireProductRegistryPublished(product, "npm");
  requireLockedProductIntegrity([product], ["npm"]);
}

function publishReactNativeNpm(headRef) {
  const product = "oliphaunt-react-native";
  verifyReleaseTag(product, headRef);
  requireFrozenProductArtifacts(product, [
    path.join(ROOT, "target/sdk-artifacts", product),
    path.join(ROOT, "target/release/ios-carriers"),
  ]);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  requireProductRegistryPublished(product, null);
  requireLockedProductIntegrity([product], ["npm"]);
  uploadGithubReleaseAssets(product, []);
}

function publishSwiftGithubRelease(headRef) {
  const product = "oliphaunt-swift";
  verifyReleaseTag(product, headRef);
  const roots = [path.join(ROOT, "target/sdk-artifacts", product)];
  const fixture = path.join(ROOT, "target/release/swiftpm-extension-consumer-fixture");
  if (isDirectory(fixture)) {
    roots.push(fixture);
  }
  requireFrozenProductArtifacts(product, roots);
  const inputs = lockedProductArtifactPaths(ACTIVE_PUBLICATION_LOCK, product);
  const manifest = inputs.find(({ artifact }) => artifact.kind === "swiftpm-release-manifest");
  const releaseTree = inputs.find(({ artifact }) => artifact.kind === "swiftpm-release-tree");
  if (manifest?.type !== "file" || releaseTree?.type !== "directory") {
    fail("oliphaunt-swift publication lock lacks its exact manifest or generated release tree");
  }
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/publish_swiftpm_source_tag.mjs",
    "--target",
    headRef,
    "--manifest",
    manifest.path,
    "--include-tree",
    releaseTree.path,
    "--push",
  ]);
  uploadGithubReleaseAssets(product, []);
}

async function publishKotlinMaven(headRef) {
  const product = "oliphaunt-kotlin";
  verifyReleaseTag(product, headRef);
  const stagedRepo = stagedKotlinMavenRepo();
  requireFrozenArtifacts([stagedRepo], { products: [product], ecosystem: "maven" });
  const version = currentProductVersionSync(product, TOOL);
  const wasPublished = productRegistryPublished(product, "maven");
  if (wasPublished) {
    requireLockedProductIntegrity([product], ["maven"]);
    console.log(`dev.oliphaunt Android artifacts ${version} are already published on Maven Central with lock-matching bytes; skipping frozen Maven publication.`);
  } else {
    await publishLockedMavenProducts([product], product);
  }
  requireProductRegistryPublished(product, "maven");
  if (!wasPublished) requireLockedProductIntegrity([product], ["maven"]);
  uploadGithubReleaseAssets(product, []);
}

function publishTypescriptNpmBootstrap(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  if (!BOOTSTRAP_IDENTITIES) {
    fail("the separate oliphaunt-js npm step is reserved for --bootstrap-identities");
  }
  verifyReleaseTag(product, headRef);
  const carrier = frozenCarrierPackages("npm", { product }).find(({ name }) => name === packageName);
  npmPublishTarball(carrier.name, carrier.file, carrier.version);
  requireProductRegistryPublished(product, "npm");
  requireLockedProductIntegrity([product], ["npm"]);
}

function publishTypescriptNpm(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  verifyReleaseTag(product, headRef);
  const carrier = frozenCarrierPackages("npm", { product }).find(({ name }) => name === packageName);
  npmPublishTarball(carrier.name, carrier.file, carrier.version);
  requireProductRegistryPublished(product, "npm");
  requireLockedProductIntegrity([product], ["npm"]);
}

function publishTypescriptJsr(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  if (BOOTSTRAP_IDENTITIES) {
    fail("JSR publication is forbidden during identity bootstrap");
  }
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  const source = stagedJsrSourceDir(product);
  let frozenSource;
  try {
    frozenSource = lockedCarrierDirectory(ACTIVE_PUBLICATION_LOCK, "jsr", packageName, source);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const wasPublished = productRegistryPublished(product, "jsr");
  if (wasPublished) {
    requireLockedProductIntegrity([product], ["jsr"]);
    console.log(`jsr:${packageName} ${version} is already published with a lock-matching file manifest; skipping jsr publish.`);
  } else {
    run(TOOL, ["pnpm", "exec", "jsr", "publish"], { cwd: frozenSource.directory });
  }
  requireProductRegistryPublished(product, "jsr");
  if (!wasPublished) requireLockedProductIntegrity([product], ["jsr"]);
}

async function publishRustCratesIo(headRef) {
  const product = "oliphaunt-rust";
  if (publishedRerun(product, headRef)) {
    requireLockedProductIntegrity([product], ["cargo"]);
    console.log("oliphaunt-rust is already published at this commit with lock-matching bytes; skipping crates.io publish.");
    return;
  }
  verifyReleaseTag(product, headRef);
  const nativeVersion = currentProductVersionSync("liboliphaunt-native", TOOL);
  const brokerVersion = currentProductVersionSync("oliphaunt-broker", TOOL);
  requireProductRegistryVersionPublished("liboliphaunt-native", "crates", nativeVersion);
  requireProductRegistryVersionPublished("oliphaunt-broker", "crates", brokerVersion);
  const carriers = frozenCarrierPackages("cargo", { product });
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  requireProductRegistryPublished(product, null);
}

async function publishWasixRustCratesIo(headRef) {
  const product = "oliphaunt-wasix-rust";
  if (publishedRerun(product, headRef)) {
    requireLockedProductIntegrity([product], ["cargo"]);
    console.log("oliphaunt-wasix-rust is already published at this commit with lock-matching bytes; skipping crates.io publish.");
    return;
  }
  verifyReleaseTag(product, headRef);
  const runtimeVersion = currentProductVersionSync("liboliphaunt-wasix", TOOL);
  requireProductRegistryVersionPublished("liboliphaunt-wasix", "crates", runtimeVersion);
  const carriers = frozenCarrierPackages("cargo", { product });
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  requireProductRegistryPublished(product, null);
}

async function publishLiboliphauntRuntimeMaven(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  const wasPublished = productRegistryPublished(product, "maven");
  if (wasPublished) {
    requireLockedProductIntegrity([product], ["maven"]);
    console.log(`dev.oliphaunt.runtime artifacts ${version} are already published on Maven Central with lock-matching bytes; skipping frozen Maven publication.`);
  } else {
    await publishLockedMavenProducts([product], product);
  }
  requireProductRegistryPublished(product, "maven");
  if (!wasPublished) requireLockedProductIntegrity([product], ["maven"]);
}

async function publishSelectedExtensionMaven(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  for (const product of extensions) {
    verifyReleaseTag(product, headRef);
  }
  const werePublished = extensionMavenArtifactsPublished(extensions);
  if (werePublished) {
    requireLockedProductIntegrity(extensions, ["maven"]);
    console.log("selected Oliphaunt extension Android artifacts are already published on Maven Central with lock-matching bytes; skipping frozen Maven publication.");
  } else {
    await publishLockedMavenProducts(extensions, "selected-extensions");
  }
  requireExtensionMavenArtifactsPublished(extensions);
  if (!werePublished) requireLockedProductIntegrity(extensions, ["maven"]);
}

function packageIdentityLabel(identity) {
  return `${identity.name}@${identity.version}`;
}

function uniquePackages(packages) {
  const seen = new Set();
  const unique = [];
  for (const pkg of packages) {
    const key = packageIdentityLabel(pkg);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(pkg);
  }
  return unique;
}

function allNpmPackagesPublished(packages) {
  return uniquePackages(packages).every((pkg) => npmPackagePublished(pkg.name, pkg.version));
}

async function waitForNpmPackage(packageName, version) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (npmPackagePublished(packageName, version)) {
      return;
    }
    await Bun.sleep(10_000);
  }
  fail(`${packageName} ${version} did not appear on npm after publish`);
}

async function requireNpmPackagesPublished(packages) {
  for (const pkg of uniquePackages(packages).sort((left, right) => compareText(packageIdentityLabel(left), packageIdentityLabel(right)))) {
    await waitForNpmPackage(pkg.name, pkg.version);
  }
}

function allCargoPackagesPublished(packages) {
  return uniquePackages(packages).every((pkg) => cratesioCrateVersionPublished(pkg.name, pkg.version));
}

async function requireCargoPackagesPublished(packages) {
  for (const pkg of uniquePackages(packages).sort((left, right) => compareText(packageIdentityLabel(left), packageIdentityLabel(right)))) {
    await waitForCratesioCrate(pkg.name, pkg.version);
  }
}

async function publishSelectedExtensionNpm(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  for (const product of extensions) {
    verifyReleaseTag(product, headRef);
  }
  const carriers = frozenCarrierPackages("npm", { products: extensions });
  const packages = carriers.map(({ name, version }) => ({ name, version }));
  if (allNpmPackagesPublished(packages)) {
    requireLockedProductIntegrity(extensions, ["npm"]);
    console.log("selected Oliphaunt extension npm packages are already published with lock-matching bytes; skipping npm publish.");
    return;
  }
  for (const carrier of carriers) {
    npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  await requireNpmPackagesPublished(packages);
  requireExtensionRegistryArtifactsPublished(extensions, "npm");
  requireLockedProductIntegrity(extensions, ["npm"]);
}

async function publishSelectedExtensionCargo(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  for (const product of extensions) {
    verifyReleaseTag(product, headRef);
  }
  const carriers = frozenCarrierPackages("cargo", { products: extensions });
  const packages = carriers.map(({ name, version }) => ({ name, version }));
  if (allCargoPackagesPublished(packages)) {
    requireLockedProductIntegrity(extensions, ["cargo"]);
    console.log("selected Oliphaunt extension Cargo artifact crates, including generated part crates, are already published with lock-matching bytes; skipping cargo publish.");
    return;
  }
  for (const carrier of carriers) {
    await cargoPublishLockedCrate(carrier.name, carrier.version, carrier.file);
  }
  await requireCargoPackagesPublished(packages);
  requireExtensionRegistryArtifactsPublished(extensions, "crates");
  requireLockedProductIntegrity(extensions, ["cargo"]);
}

function lockedCarrierById(carrierId) {
  const matches = lockedCarriers(ACTIVE_PUBLICATION_LOCK).filter(({ id }) => id === carrierId);
  if (matches.length !== 1) {
    throw new Error(`publication lock contains ${matches.length} carriers for ${carrierId}`);
  }
  return matches[0];
}

function mavenProductPublicationState(product) {
  const result = jsonOutput([
    "tools/release/check_registry_publication.mjs",
    "query-product-publication",
    "--product",
    product,
    "--registry-kind",
    "maven",
  ]);
  if (
    result === null
    || !Array.isArray(result.packages)
    || result.packages.length === 0
    || !Array.isArray(result.missing)
    || !Array.isArray(result.published)
    || result.missing.length + result.published.length !== result.packages.length
  ) {
    throw new Error(`could not classify exact Maven publication state for ${product}`);
  }
  if (result.missing.length > 0 && result.published.length > 0) {
    throw new Error(
      `${product} has a partial Maven Central publication; refusing to upload a bundle that would overwrite immutable coordinates`,
    );
  }
  return result.missing.length === 0 ? "published" : "pending";
}

async function publishNormalMavenOperation(operation, headRef) {
  const expected = new Set(operation.carrierIds);
  const actual = lockedCarriers(ACTIVE_PUBLICATION_LOCK, { products: operation.products, ecosystem: "maven" });
  if (actual.length !== expected.size || actual.some(({ id }) => !expected.has(id))) {
    throw new Error("normal Maven operation does not contain every selected frozen Maven carrier");
  }
  const states = new Map();
  for (const product of operation.products) {
    verifyReleaseTag(product, headRef);
    states.set(product, mavenProductPublicationState(product));
  }
  const pendingProducts = operation.products.filter((product) => states.get(product) === "pending");
  if (pendingProducts.length === 0) {
    requireLockedProductIntegrity(operation.products, ["maven"]);
    console.log("Every selected Maven coordinate is already published with lock-matching bytes; skipping Maven Central upload.");
    return;
  }
  if (pendingProducts.length !== operation.products.length) {
    const published = operation.products.filter((product) => states.get(product) === "published");
    throw new Error(
      `selected Maven topology is partially public across products (published: ${published.join(", ")}; pending: ${pendingProducts.join(", ")}); `
        + "refusing to replace the one atomic exact-lock deployment with product-specific phases",
    );
  }
  await publishLockedMavenProducts(operation.products, "normal-registry-plan");
  for (const product of operation.products) {
    requireProductRegistryPublished(product, "maven");
  }
  requireLockedProductIntegrity(operation.products, ["maven"]);
}

async function publishNormalCarrier(operation, headRef, context) {
  const carrier = lockedCarrierById(operation.carrierId);
  if (carrier.product !== operation.product || carrier.ecosystem !== operation.ecosystem) {
    throw new Error(`${operation.id} no longer matches its exact frozen carrier`);
  }
  if (carrier.ecosystem === "cargo") {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "cargo", carrier.name);
    await cargoPublishLockedCrateExact(carrier.name, carrier.version, locked.file, {
      alreadyPublished: context.alreadyPublished,
      token: context.cargoToken,
      tokenDeadlineEpochMs: context.tokenDeadlineEpochMs,
    });
    return;
  }
  if (carrier.ecosystem === "npm") {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "npm", carrier.name);
    npmPublishTarball(carrier.name, locked.file, carrier.version);
    await waitForNpmPackage(carrier.name, carrier.version);
    requireLockedCarrierIntegrity("npm", carrier.name);
    return;
  }
  if (carrier.ecosystem === "jsr") {
    if (carrier.product !== "oliphaunt-js" || carrier.name !== "@oliphaunt/ts") {
      throw new Error(`unsupported JSR carrier ${carrier.id}; add an exact frozen JSR publisher before selecting it`);
    }
    publishTypescriptJsr(headRef);
    return;
  }
  throw new Error(`normal registry plan cannot publish unsupported carrier ${carrier.id}`);
}

function requireNormalRegistryProductInputs(products) {
  if (products.includes("oliphaunt-react-native")) {
    requireFrozenProductArtifacts("oliphaunt-react-native", [
      path.join(ROOT, "target/sdk-artifacts/oliphaunt-react-native"),
      path.join(ROOT, "target/release/ios-carriers"),
    ]);
  }
  if (products.includes("oliphaunt-kotlin")) {
    requireFrozenArtifacts([stagedKotlinMavenRepo()], {
      products: ["oliphaunt-kotlin"],
      ecosystem: "maven",
    });
  }
}

async function publishNormalRegistryPlan(products, headRef) {
  assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
  const plan = normalPublicationPlan(ACTIVE_PUBLICATION_LOCK, products);
  if (plan.carrierCount === 0) {
    throw new Error("selected normal release contains no frozen registry carriers");
  }
  requireNormalRegistryProductInputs(products);
  const carrierProducts = [...new Set(
    plan.operations.flatMap((operation) => operation.products),
  )].sort(compareText);
  for (const product of carrierProducts) verifyReleaseTag(product, headRef);
  console.log(
    `Executing ${plan.operations.length} dependency-ordered registry operations for ${plan.carrierCount} exact frozen carriers.`,
  );
  await executeNormalPublicationPlan({
    plan,
    batchSize: process.env.CRATES_IO_TRUSTED_PUBLISH_BATCH_SIZE,
    cargoVersionPublished: async (operation) => {
      const carrier = lockedCarrierById(operation.carrierId);
      return exactCargoVersionPublished(carrier.name, carrier.version);
    },
    publishCarrier: (operation, context) => publishNormalCarrier(operation, headRef, context),
    publishMaven: (operation) => publishNormalMavenOperation(operation, headRef),
  });
  requireLockedProductIntegrity(carrierProducts, ["cargo", "npm", "maven", "jsr"]);
  for (const product of ["oliphaunt-kotlin", "oliphaunt-react-native"]) {
    if (carrierProducts.includes(product)) uploadGithubReleaseAssets(product, []);
  }
}

function jsonOutput(args) {
  const result = spawnSync("tools/dev/bun.sh", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error !== undefined) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function productPublishDryRunPlan(args) {
  const requested = parseProductsJson(args);
  if (requested === null) {
    return null;
  }
  const unsupportedRequested = requested.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedRequested.length > 0) {
    fail(`unsupported Bun product publish dry-run selection: ${unsupportedRequested.join(", ")}`);
  }
  const ordered = releaseOrderedProducts(requested);
  const unsupportedOrdered = ordered.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedOrdered.length > 0) {
    fail(`release graph selected unsupported Bun product publish dry-run dependencies: ${unsupportedOrdered.join(", ")}`);
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    products: ordered,
  };
}

async function runProductDryRunPlan(productDryRunPlan) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...productDryRunPlan.passthrough]);
  for (const product of productDryRunPlan.products) {
    await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });
  }
}

async function publishNoProduct(args) {
  const productsJson = flagValue(args, "--products-json");
  const productDryRunPlan = productPublishDryRunPlan(args);
  if (productsJson !== null) {
    run(TOOL, ["tools/release/check_publish_environment.mjs", "--products-json", productsJson]);
  }
  if (productDryRunPlan !== null) {
    await runProductDryRunPlan(productDryRunPlan);
    console.log("publish environment and dry-run checks passed; package-native publish steps run in the Release workflow");
    return;
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  const passthrough = args.filter((arg) => arg !== "--allow-dirty");
  if (passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  console.log("No release products selected; publish environment and package publish steps skipped.");
}

if (isNoProductPublishDryRun(command, argv.slice(1))) {
  const passthrough = noProductPublishDryRunPassthrough(argv.slice(1));
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  process.exit(0);
}

const productDryRunPlan = command === "publish-dry-run" ? productPublishDryRunPlan(argv.slice(1)) : null;
if (productDryRunPlan !== null) {
  await runProductDryRunPlan(productDryRunPlan);
  process.exit(0);
}

const legacyWasmDryRunPlan = command === "publish-dry-run" ? legacyWasmPublishDryRunPlan(argv.slice(1)) : null;
if (legacyWasmDryRunPlan !== null) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (legacyWasmDryRunPlan.passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...legacyWasmDryRunPlan.passthrough]);
  }
  await runBunProductDryRun(legacyWasmDryRunPlan.product, { allowDirty: legacyWasmDryRunPlan.allowDirty });
  process.exit(0);
}

if (command === "publish-dry-run") {
  fail("publish-dry-run is Bun-owned; unsupported arguments must fail before any protected publication route");
}

const publishProductStep = command === "publish" ? publishProductStepPlan(argv.slice(1)) : null;
const bootstrapCarrierId = flagValue(argv.slice(1), "--carrier-id");
const normalRegistryPlanSelected = argv.slice(1).includes("--registry-plan");
if (BOOTSTRAP_IDENTITIES) {
  const carrierSelection = bootstrapCarrierId !== null;
  if (!carrierSelection || publishProductStep !== null) {
    fail("--bootstrap-identities requires exactly one dependency-ordered --carrier-id; product-level bootstrap is forbidden");
  }
  if (carrierSelection) {
    const unexpected = unexpectedValueFlagArguments(argv.slice(1), new Set(["--carrier-id", "--head-ref"]));
    if (unexpected.length > 0) {
      fail(`unsupported carrier bootstrap arguments: ${unexpected.join(" ")}`);
    }
  }
  try {
    assertPublicationLockSource(
      ACTIVE_PUBLICATION_LOCK,
      bootstrapCarrierId !== null
        ? (flagValue(argv.slice(1), "--head-ref") ?? "HEAD")
        : publishProductStep.headRef,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
} else if (bootstrapCarrierId !== null) {
  fail("--carrier-id is valid only with --bootstrap-identities");
}
if (BOOTSTRAP_IDENTITIES && normalRegistryPlanSelected) {
  fail("--registry-plan is forbidden during one-time identity bootstrap");
}
if (BOOTSTRAP_IDENTITIES && bootstrapCarrierId !== null) {
  await publishBootstrapCarrier(
    bootstrapCarrierId,
    flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
  );
  process.exit(0);
}
if (normalRegistryPlanSelected) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested === null || publishProductStep !== null) {
    fail("--registry-plan requires --products-json and cannot be combined with --product/--step");
  }
  const withoutMode = argv.slice(1).filter((value) => value !== "--registry-plan");
  const unexpected = unexpectedValueFlagArguments(withoutMode, new Set(["--products-json", "--head-ref"]));
  if (unexpected.length > 0) {
    fail(`unsupported normal registry-plan arguments: ${unexpected.join(" ")}`);
  }
  try {
    await publishNormalRegistryPlan(
      requested,
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}
if (new Set(["crates-io", "npm", "maven-central", "jsr"]).has(flagValue(argv.slice(1), "--step"))) {
  fail("normal product/ecosystem registry steps are disabled; use the exact-lock --registry-plan executor");
}
if (publishProductStep?.step === "github-release-assets") {
  if (GITHUB_RELEASE_ASSET_PRODUCTS.has(publishProductStep.product)) {
    publishGithubReleaseAssets(publishProductStep.product, publishProductStep.headRef);
    process.exit(0);
  }
  if (EXTENSION_PRODUCTS.has(publishProductStep.product)) {
    publishExtensionGithubReleaseAssets(publishProductStep.product, publishProductStep.headRef);
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "github-release-assets" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    publishSelectedExtensionGithubReleaseAssets(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "maven-central") {
  await publishLiboliphauntRuntimeMaven(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "npm") {
  publishLiboliphauntNpmPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "crates-io") {
  await publishLiboliphauntNativeCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-wasix" && publishProductStep.step === "crates-io") {
  await publishLiboliphauntWasixCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-node-direct" && publishProductStep.step === "npm") {
  await publishNodeDirectNpmOptionalPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-broker" && publishProductStep.step === "npm") {
  publishBrokerNpmPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-broker" && publishProductStep.step === "crates-io") {
  await publishBrokerCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-react-native" && publishProductStep.step === "npm") {
  publishReactNativeNpm(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-swift" && publishProductStep.step === "github-release") {
  publishSwiftGithubRelease(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-kotlin" && publishProductStep.step === "maven-central") {
  await publishKotlinMaven(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-js" && publishProductStep.step === "npm") {
  if (BOOTSTRAP_IDENTITIES) {
    publishTypescriptNpmBootstrap(publishProductStep.headRef);
  } else {
    publishTypescriptNpm(publishProductStep.headRef);
  }
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-js" && publishProductStep.step === "jsr") {
  publishTypescriptJsr(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-rust" && publishProductStep.step === "crates-io") {
  await publishRustCratesIo(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-wasix-rust" && publishProductStep.step === "crates-io") {
  await publishWasixRustCratesIo(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "maven-central" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  await publishSelectedExtensionMaven([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "npm" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  await publishSelectedExtensionNpm([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "crates-io" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  await publishSelectedExtensionCargo([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "maven-central" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    await publishSelectedExtensionMaven(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "npm" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    await publishSelectedExtensionNpm(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "crates-io" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    await publishSelectedExtensionCargo(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && publishProductStep === null && flagValue(argv.slice(1), "--product") === null && flagValue(argv.slice(1), "--step") === null) {
  await publishNoProduct(argv.slice(1));
  process.exit(0);
}

fail(`unsupported publish arguments: ${argv.slice(1).join(" ") || "<none>"}`);
