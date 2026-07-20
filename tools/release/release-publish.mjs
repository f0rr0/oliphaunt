#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ROOT, run, runOrThrow } from "./release-cli-utils.mjs";
import { resolvePinnedJsrInvocation } from "./jsr-cli.mjs";
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
  NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER,
  NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS,
  parseRegistryMutationDeadline,
} from "./crates-io-bootstrap-capacity.mjs";
import { uploadCargoOnceAndReconcileExactVersion } from "./cargo-upload-reconciliation.mjs";
import { mutateOnceAndRequireExactState } from "./immutable-mutation-reconciliation.mjs";
import { publishFrozenCargoCrate } from "./frozen-cargo-publish.mjs";
import {
  encodeRegistryPublicationDeferral,
  isRegistryPublicationDeferredError,
  requirePreMutationRegistryWindow,
  REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE,
} from "./registry-publication-deferral.mjs";
import { publishFrozenNpmPackage } from "./frozen-npm-publish.mjs";
import {
  createGpgSigner,
  prepareFrozenMavenBundle,
  publishFrozenMavenBundle,
} from "./frozen-maven-publish.mjs";
import {
  SUPPORTED_BUN_PRODUCT_DRY_RUNS,
  runBunProductDryRun,
} from "./release-product-dry-run.mjs";
import { runExternalExtensionRegistryConsumerProof } from "./external-extension-registry-consumer.mjs";
import {
  stagedKotlinMavenRepo,
  stagedJsrSourceDir,
} from "./release-sdk-product-dry-run.mjs";
import {
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
} from "./release-artifact-targets.mjs";
import {
  collectNormalPublicationReceipts,
  executeNormalPublicationPlan,
} from "./normal-publication-executor.mjs";
import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import {
  loadNormalPublicationAdmission,
} from "./normal-publication-admission.mjs";
import {
  DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  openNormalPublicationCheckpoint,
} from "./normal-publication-checkpoint.mjs";
import { loadBootstrapLedger } from "./bootstrap-ledger.mjs";
import {
  verifyLockedCarrierIntegrity,
  verifyLockedRegistryIntegrity,
  writeRegistryReceiptEvidence,
} from "./registry-integrity.mjs";
import { assertQualifiedReplaySourceState } from "./qualified-release-replay.mjs";
import { concurrentGithubReleaseAssetUploadPlan } from "./github-release-asset-upload-plan.mjs";
import {
  executeConcurrentGithubReleaseAssetUploadPlan,
  githubReleaseAssetUploadChildEnvironment,
  writeConcurrentGithubReleaseAssetUploadReport,
} from "./concurrent-github-release-asset-upload.mjs";
import { loadGraph } from "./release-graph.mjs";
import { readSelectedRemoteTagMapSync } from "../../.github/scripts/manage-release-drafts.mjs";
import { validateReleaseExecutionResult } from "./release-continuation-contract.mjs";

const TOOL = "release-publish.mjs";
const COMMANDS = new Set(["publish", "publish-dry-run"]);
const REGISTRY_PUBLICATION_CHECK = [
  process.execPath,
  "tools/release/check_registry_publication.mjs",
];
const REGISTRY_DEADLINE_RESERVE_MS = 5_000;
const JSR_PUBLISH_TIMEOUT_MS = 5 * 60_000;
const NORMAL_EXECUTION_RESULT_PATH = path.resolve(
  ROOT,
  process.env.OLIPHAUNT_NORMAL_PUBLICATION_EXECUTION_RESULT
    ?? "target/release/normal-publication-execution-result.json",
);

function usage() {
  console.log(`usage: tools/release/release-publish.mjs <publish|publish-dry-run> [publish args] [--publication-lock FILE]

Runs protected release publish and publish dry-run operations through the Bun
release command surface. The public no-product publish dry-run and product
dry-runs are handled in Bun, including the legacy --wasm shortcut for the WASIX
Rust SDK dry-run. Protected publish steps and no-product publish validation are
handled in Bun.

Product dry-runs normally run the full release gate. The protected workflow may
pass --qualified-ci after downloading the exact-SHA Qualified record. That mode
reverifies the fixed candidate/plan/evidence paths, binds a clean checkout to
RELEASE_HEAD_SHA, and then runs every live metadata check without replaying the
already-proved mutation unit tests. --qualified-ci is incompatible with
--allow-dirty and is rejected outside GitHub Actions.

Every real publish requires an exact-SHA frozen publication lock. Repeatable
identity bootstrap for newly generated Cargo/npm identities uses:
  publish --bootstrap-identities --carrier-id cargo:NAME|npm:NAME \\
    --head-ref SHA --publication-lock FILE [--bootstrap-ledger FILE]
Bootstrap mode cannot publish GitHub releases/assets, Maven, or JSR.

Normal registry publication uses one lock-derived global topology:
  publish --registry-plan --products-json JSON --head-ref SHA \
    --publication-lock FILE --registry-admission FILE
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function exitTypedRegistryDeferral(cause) {
  console.error(encodeRegistryPublicationDeferral(cause));
  process.exit(REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE);
}

function writeNormalExecutionResult(value) {
  const normalized = validateReleaseExecutionResult(value, {
    operation: "publish",
    releaseCommit: value.source.commit,
    releaseTree: value.source.tree,
    lock: value.lock,
    products: value.products,
  });
  mkdirSync(path.dirname(NORMAL_EXECUTION_RESULT_PATH), { recursive: true });
  const temporary = `${NORMAL_EXECUTION_RESULT_PATH}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, NORMAL_EXECUTION_RESULT_PATH);
  if (process.env.GITHUB_OUTPUT?.trim()) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `complete=${normalized.decision === "complete" ? "true" : "false"}\n`
        + `deferred=${normalized.decision === "deferred" ? "true" : "false"}\n`
        + `deferral_mode=${normalized.deferralMode ?? ""}\n`
        + `progress_count=${normalized.newlyCompletedIds.length}\n`
        + `completed_count=${normalized.completedIds.length}\n`
        + `remaining_count=${normalized.remainingIds.length}\n`
        + `not_before_epoch=${normalized.notBeforeEpochSeconds ?? 0}\n`,
    );
  }
  return normalized;
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
const admissionArgs = removeValueFlag(ledgerArgs.args, "--registry-admission");
const argv = admissionArgs.args.filter((arg) => arg !== "--bootstrap-identities");
const command = argv[0];
const BOOTSTRAP_IDENTITIES = admissionArgs.args.includes("--bootstrap-identities");
const PUBLICATION_LOCK_PATH = path.resolve(
  ROOT,
  lockArgs.value ?? process.env.OLIPHAUNT_PUBLICATION_LOCK ?? DEFAULT_PUBLICATION_LOCK,
);
const BOOTSTRAP_LEDGER_PATH = path.resolve(
  ROOT,
  ledgerArgs.value ?? process.env.OLIPHAUNT_BOOTSTRAP_LEDGER ?? "target/release/bootstrap-ledger",
);
const REGISTRY_RECEIPT_EVIDENCE_PATH = path.resolve(
  ROOT,
  process.env.OLIPHAUNT_REGISTRY_RECEIPTS ?? "target/release/registry-integrity-receipts.json",
);
const NORMAL_PUBLICATION_CHECKPOINT_PATH = path.resolve(
  ROOT,
  process.env.OLIPHAUNT_NORMAL_PUBLICATION_CHECKPOINT ?? DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
);
const NORMAL_PUBLICATION_ADMISSION_PATH = admissionArgs.value === null
  ? null
  : path.resolve(ROOT, admissionArgs.value);
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
  run(TOOL, [process.execPath, "tools/release/verify_product_tag.mjs", product, "--target", headRef]);
}

function verifyReleaseTagOrThrow(product, headRef) {
  if (BOOTSTRAP_IDENTITIES) {
    assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
    return;
  }
  runOrThrow(TOOL, [process.execPath, "tools/release/verify_product_tag.mjs", product, "--target", headRef]);
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

function githubReleaseAssetUploadCommand(product, assets) {
  const command = [
    process.execPath,
    "tools/release/upload_github_release_assets.mjs",
    product,
    "--publication-lock",
    PUBLICATION_LOCK_PATH,
  ];
  for (const asset of assets) {
    command.push("--asset", asset);
  }
  return command;
}

function uploadGithubReleaseAssets(product, assets) {
  const command = githubReleaseAssetUploadCommand(product, assets);
  run(TOOL, command);
}

function uploadGithubReleaseAssetsAsync(product, assets, windowMs, abortPath) {
  return new Promise((resolve, reject) => {
    const command = githubReleaseAssetUploadCommand(product, assets);
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: githubReleaseAssetUploadChildEnvironment(process.env, { abortPath, windowMs }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let spawnError = null;
    let stderr = "";
    const appendStderr = (chunk) => {
      process.stderr.write(chunk);
      stderr = `${stderr}${String(chunk)}`;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-(64 * 1024));
    };
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", appendStderr);
    child.once("error", (cause) => {
      spawnError = cause;
    });
    child.once("close", (code, signal) => {
      if (spawnError !== null || code !== 0 || signal !== null) {
        const detail = stderr.trim().split(/\r?\n/u).at(-1)
          ?? spawnError?.message
          ?? (signal === null ? `exit ${code ?? 1}` : `signal ${signal}`);
        reject(new Error(detail));
        return;
      }
      resolve({ code: 0, product });
    });
  });
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

async function publishSelectedGithubReleaseAssetSets(products, headRef) {
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length === 0 || selected.length !== products.length) {
    fail("concurrent GitHub release asset publication requires a non-empty unique product selection");
  }
  const repo = process.env.GITHUB_REPOSITORY?.trim() ?? "";
  const graph = loadGraph("release-publish-github-release-assets");
  const lockedProducts = new Map(ACTIVE_PUBLICATION_LOCK.products.map((row) => [row.id, row]));
  const selectedTags = selected.map((product) => {
    const config = graph.products[product];
    const locked = lockedProducts.get(product);
    if (config === undefined || locked === undefined || config.version !== locked.version) {
      fail(`${product} cannot derive an exact frozen remote tag identity`);
    }
    return { product, tag: `${config.tag_prefix}${locked.version}` };
  });
  let remoteTags;
  try {
    remoteTags = readSelectedRemoteTagMapSync(repo, selectedTags, { environment: process.env });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  for (const { product, tag } of selectedTags) {
    const remote = remoteTags.get(tag);
    if (remote?.type !== "commit" || remote.sha !== headRef) {
      fail(`${product} tag ${tag} is not bound to exact release commit ${headRef}`);
    }
  }
  const rows = new Map();
  const assetsByProduct = new Map();
  for (const product of selected) {
    const assets = lockedProductArtifactPaths(ACTIVE_PUBLICATION_LOCK, product)
      .filter(({ artifact }) => artifact.role === "github-release-asset" || artifact.role === "github-release-metadata");
    if (assets.some(({ type }) => type !== "file")) {
      fail(`${product} publication lock contains a non-file GitHub release asset`);
    }
    rows.set(product, assets.length);
    assetsByProduct.set(product, assets.map(({ path: file }) => rel(file)));
  }
  let plan;
  try {
    plan = concurrentGithubReleaseAssetUploadPlan(rows);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  console.log(
    `Publishing ${plan.assetCount} exact frozen GitHub release assets for ${plan.productCount} `
      + `asset-backed products in ${plan.waves.length} bounded concurrent wave(s); `
      + `${selected.length - plan.productCount} exact empty product asset sets are receipt-proven.`,
  );
  const coordinationRoot = mkdtempSync(path.join(tmpdir(), "oliphaunt-github-release-asset-wave-"));
  const abortPath = path.join(coordinationRoot, "abort.json");
  const reportPath = process.env.GITHUB_RELEASE_ASSET_UPLOAD_REPORT_PATH
    ?? path.join(coordinationRoot, "report.json");
  try {
    let execution;
    try {
      execution = await executeConcurrentGithubReleaseAssetUploadPlan(plan, {
        abort: (outcome) => {
          writeFileSync(abortPath, `${JSON.stringify({
            product: outcome.product,
            reason: "peer product lane failed",
          })}\n`, { flag: "wx", mode: 0o600 });
        },
        uploadProduct: ({ product }, { wave, waveIndex }) => {
          console.log(
            `Starting ${product} in GitHub release asset wave ${waveIndex + 1}/${plan.waves.length} `
              + `(${wave.assetCount} assets, ${wave.windowMs}ms bound).`,
          );
          return uploadGithubReleaseAssetsAsync(
            product,
            assetsByProduct.get(product),
            wave.windowMs,
            abortPath,
          );
        },
      });
    } catch (cause) {
      if (cause?.report !== undefined) {
        writeConcurrentGithubReleaseAssetUploadReport(reportPath, {
          execution: cause.report,
          plan,
          sourceCommit: ACTIVE_PUBLICATION_LOCK.source.commit,
        });
      }
      throw cause;
    }
    writeConcurrentGithubReleaseAssetUploadReport(reportPath, {
      execution,
      plan,
      sourceCommit: ACTIVE_PUBLICATION_LOCK.source.commit,
    });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  } finally {
    rmSync(coordinationRoot, { force: true, recursive: true });
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

function registryPublicationCheckOrThrow(args) {
  runOrThrow(TOOL, [...REGISTRY_PUBLICATION_CHECK, ...args]);
}

function registryPublicationCheckSucceeds(args) {
  const result = spawnSync(REGISTRY_PUBLICATION_CHECK[0], [...REGISTRY_PUBLICATION_CHECK.slice(1), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    throw new Error(`registry publication check failed to start: ${result.error.message}`);
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
  return tagCommit !== null && headCommit !== null && tagCommit === headCommit;
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

function requireProductRegistryPublishedOrThrow(product, registryKind) {
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
  registryPublicationCheckOrThrow(args);
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

function requireLockedProductIntegrity(products, ecosystems) {
  const command = [
    process.execPath,
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
    throw new Error(`${name} is required`);
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
    const deadlineEpochSeconds = registryMutationDeadlineSeconds();
    requirePreMutationRegistryWindow({
      deadlineEpochSeconds,
      minimumMilliseconds: NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS * 1000,
      reserveMilliseconds: REGISTRY_DEADLINE_RESERVE_MS,
      context: `Maven Central atomic deployment for ${products.slice().sort(compareText).join(",")}`,
    });
    const result = await publishFrozenMavenBundle({
      bundle: prepared.bundle,
      lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
      deploymentScope: products.slice().sort(compareText).join(","),
      namespace: releaseEnvironment("MAVEN_CENTRAL_NAMESPACE"),
      username: releaseEnvironment("ORG_GRADLE_PROJECT_mavenCentralUsername"),
      password: releaseEnvironment("ORG_GRADLE_PROJECT_mavenCentralPassword"),
      deadlineEpochSeconds,
    });
    console.log(`Maven Central deployment ${result.deploymentId} published exact frozen payloads for ${products.join(", ")}.`);
  } finally {
    rmSync(gpgHome, { recursive: true, force: true });
  }
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
    if (attempt + 1 < 12) {
      await boundedRegistrySleep(10_000, `crates.io visibility wait for ${crateName}@${version}`);
    }
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

function normalRegistryAuthoritativeWindowSeconds() {
  const raw = releaseEnvironment("NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS");
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS must be a positive safe integer");
  }
  return Number(raw);
}

function loadBoundNormalPublicationAdmission({ lock, products, plan, checkpoint }) {
  if (NORMAL_PUBLICATION_ADMISSION_PATH === null) {
    throw new Error("--registry-admission is required for exact normal registry publication");
  }
  const expectedDigest = releaseEnvironment("NORMAL_PUBLICATION_ADMISSION_DIGEST");
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) {
    throw new Error("NORMAL_PUBLICATION_ADMISSION_DIGEST must be a lowercase SHA-256 digest");
  }
  const admission = loadNormalPublicationAdmission(NORMAL_PUBLICATION_ADMISSION_PATH, {
    authoritativeWindowSeconds: normalRegistryAuthoritativeWindowSeconds(),
    checkpoint,
    lock,
    plan,
    products,
  });
  if (admission.admissionDigest !== expectedDigest) {
    throw new Error(
      `normal publication admission digest ${admission.admissionDigest} differs from the capacity-step output ${expectedDigest}`,
    );
  }
  return admission;
}

function registryMutationRemainingMilliseconds(context, minimum = 1) {
  const remaining = (registryMutationDeadlineSeconds() * 1000) - Date.now() - REGISTRY_DEADLINE_RESERVE_MS;
  if (remaining < minimum) {
    throw new Error(
      `${context} refused with ${Math.max(0, Math.floor(remaining / 1000))}s remaining before the shared registry mutation deadline`,
    );
  }
  return remaining;
}

async function boundedRegistrySleep(milliseconds, context) {
  const remaining = registryMutationRemainingMilliseconds(context);
  if (milliseconds >= remaining) {
    throw new Error(`${context} cannot wait ${Math.ceil(milliseconds / 1000)}s before the shared registry mutation deadline`);
  }
  await Bun.sleep(milliseconds);
}

async function exactCargoVersionPublished(crateName, version, {
  allowMissingIdentity = false,
  identityCreationOnly = false,
} = {}) {
  const inventory = await inspectCratesIoVersionState({
    plan: [{ ecosystem: "cargo", name: crateName, version }],
    deadlineEpochSeconds: registryMutationDeadlineSeconds(),
  });
  if (inventory.publishedIdentities.length === 1) return true;
  if (identityCreationOnly && inventory.pendingVersions.length > 0) {
    throw new Error(
      `identity bootstrap cannot publish ${crateName} ${version}: Cargo name ${crateName} already exists while the locked exact version is absent`,
    );
  }
  if (inventory.missingNames.length > 0) {
    if (allowMissingIdentity) return false;
    throw new Error(
      `normal trusted publication cannot create missing Cargo identity ${crateName}; run the protected identity bootstrap first`,
    );
  }
  return false;
}

async function cargoPublishLockedCrateExact(crateName, version, suppliedCratePath = undefined, {
  alreadyPublished = undefined,
  allowMissingIdentity = false,
  identityCreationOnly = false,
  token = process.env.CARGO_REGISTRY_TOKEN,
  tokenDeadlineEpochMs = undefined,
} = {}) {
  let locked;
  locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "cargo", crateName, suppliedCratePath);
  if (locked.carrier.version !== version) {
    throw new Error(`frozen cargo:${crateName} version ${locked.carrier.version} does not match requested ${version}`);
  }
  const present = alreadyPublished ?? await exactCargoVersionPublished(crateName, version, {
    allowMissingIdentity,
    identityCreationOnly,
  });
  if (present) {
    const receipt = await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
    console.log(`${crateName} ${version} is already published on crates.io with lock-matching bytes; skipping frozen upload.`);
    return receipt;
  }
  const globalDeadlineEpochMs = registryMutationDeadlineSeconds() * 1000;
  const deadlineEpochMs = tokenDeadlineEpochMs === undefined
    ? globalDeadlineEpochMs
    : Math.min(globalDeadlineEpochMs, tokenDeadlineEpochMs);
  const result = await uploadCargoOnceAndReconcileExactVersion({
    crateName,
    version,
    upload: () => publishFrozenCargoCrate({
      cratePath: locked.file,
      expectedName: crateName,
      expectedVersion: version,
      token,
      deadlineEpochMs,
    }),
    // identityCreationOnly protects the pre-mutation TOCTOU check above. Once
    // crates.io has received the immutable upload, the name can legitimately
    // precede its exact version in registry views while indexing converges.
    exactVersionPublished: () => exactCargoVersionPublished(crateName, version, {
      allowMissingIdentity,
      identityCreationOnly: false,
    }),
    waitBeforeNextProbe: () => boundedRegistrySleep(
      10_000,
      `crates.io exact-version visibility wait for ${crateName}@${version}`,
    ),
  });
  const receipt = await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `cargo:${crateName}`);
  if (result.reconciledMutationFailure) {
    console.log(`${crateName} ${version} became available after an ambiguous upload response; registry bytes match the lock.`);
  }
  return receipt;
}

async function cargoPublishLockedCrate(crateName, version, suppliedCratePath = undefined) {
  try {
    await cargoPublishLockedCrateExact(crateName, version, suppliedCratePath, {
      allowMissingIdentity: BOOTSTRAP_IDENTITIES,
      identityCreationOnly: BOOTSTRAP_IDENTITIES,
    });
  } catch (error) {
    if (isRegistryPublicationDeferredError(error)) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function npmPublishTarball(packageName, tarball, version) {
  const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "npm", packageName, tarball);
  if (locked.carrier.version !== version) {
    throw new Error(`frozen npm:${packageName} version ${locked.carrier.version} does not match requested ${version}`);
  }
  const result = await publishFrozenNpmPackage({
    packageName,
    version,
    tarball: locked.file,
    cwd: ROOT,
    deadlineEpochSeconds: registryMutationDeadlineSeconds(),
    identityCreationOnly: BOOTSTRAP_IDENTITIES,
  });
  if (result.skipped) {
    console.log(`${packageName} ${version} is already published on npm with lock-matching bytes; skipping npm publish.`);
  } else if (result.reconciledMutationFailure) {
    console.log(`${packageName} ${version} became available after an ambiguous npm publish failure; registry SRI matches the lock.`);
  } else {
    console.log(`${packageName} ${version} is public on npm with registry SRI matching the frozen tarball.`);
  }
  return await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, locked.carrier.id);
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
  await npmPublishTarball(carrier.name, locked.file, carrier.version);
}

async function publishNodeDirectNpmOptionalPackages(headRef) {
  const product = "oliphaunt-node-direct";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    await npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
}

async function publishBrokerNpmPackages(headRef) {
  const product = "oliphaunt-broker";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    await npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
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

async function publishLiboliphauntNpmPackages(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    await npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
}

async function publishReactNativeNpm(headRef) {
  const product = "oliphaunt-react-native";
  verifyReleaseTag(product, headRef);
  requireFrozenProductArtifacts(product, [
    path.join(ROOT, "target/sdk-artifacts", product),
    path.join(ROOT, "target/release/ios-carriers"),
  ]);
  for (const carrier of frozenCarrierPackages("npm", { product })) {
    await npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
  uploadGithubReleaseAssets(product, []);
}

function lockedSwiftSourceInputs(headRef) {
  const product = "oliphaunt-swift";
  assertPublicationLockSource(ACTIVE_PUBLICATION_LOCK, headRef);
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
  return { manifest, product, releaseTree };
}

function publishSwiftGithubRelease(headRef) {
  verifyReleaseTag("oliphaunt-swift", headRef);
  const { manifest, releaseTree } = lockedSwiftSourceInputs(headRef);
  run(TOOL, [
    process.execPath,
    "tools/release/publish_swiftpm_source_tag.mjs",
    "--target",
    headRef,
    "--manifest",
    manifest.path,
    "--include-tree",
    releaseTree.path,
    "--push",
  ]);
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

async function publishTypescriptNpmBootstrap(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  if (!BOOTSTRAP_IDENTITIES) {
    fail("the separate oliphaunt-js npm step is reserved for --bootstrap-identities");
  }
  verifyReleaseTag(product, headRef);
  const carrier = frozenCarrierPackages("npm", { product }).find(({ name }) => name === packageName);
  await npmPublishTarball(carrier.name, carrier.file, carrier.version);
}

async function publishTypescriptNpm(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  verifyReleaseTag(product, headRef);
  const carrier = frozenCarrierPackages("npm", { product }).find(({ name }) => name === packageName);
  await npmPublishTarball(carrier.name, carrier.file, carrier.version);
}

async function publishTypescriptJsr(headRef, { version: versionOverride, source: sourceOverride } = {}) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  if (BOOTSTRAP_IDENTITIES) {
    throw new Error("JSR publication is forbidden during identity bootstrap");
  }
  verifyReleaseTagOrThrow(product, headRef);
  const version = versionOverride ?? currentProductVersionSync(product, TOOL);
  const source = sourceOverride ?? stagedJsrSourceDir(product);
  let frozenSource;
  try {
    frozenSource = lockedCarrierDirectory(ACTIVE_PUBLICATION_LOCK, "jsr", packageName, source);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  const wasPublished = productRegistryPublished(product, "jsr");
  let reconciledMutationFailure = false;
  if (wasPublished) {
    console.log(`jsr:${packageName} ${version} is already published with a lock-matching file manifest; skipping jsr publish.`);
    requireProductRegistryPublishedOrThrow(product, "jsr");
  } else {
    const timeout = Math.min(
      JSR_PUBLISH_TIMEOUT_MS,
      requirePreMutationRegistryWindow({
        deadlineEpochSeconds: registryMutationDeadlineSeconds(),
        minimumMilliseconds: NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER * 1000,
        reserveMilliseconds: REGISTRY_DEADLINE_RESERVE_MS,
        context: `JSR publish for ${packageName}@${version}`,
      }),
    );
    const result = await mutateOnceAndRequireExactState({
      label: `JSR publish for ${packageName}@${version}`,
      mutate: () => runOrThrow(TOOL, resolvePinnedJsrInvocation(["publish"]), {
        cwd: frozenSource.directory,
        timeout,
      }),
      reconcile: () => requireProductRegistryPublishedOrThrow(product, "jsr"),
    });
    reconciledMutationFailure = result.reconciledMutationFailure;
  }
  const receipt = await verifyLockedCarrierIntegrity(ACTIVE_PUBLICATION_LOCK, `jsr:${packageName}`);
  if (reconciledMutationFailure) {
    console.log(`jsr:${packageName} ${version} became available after an ambiguous publish failure; registry files match the lock.`);
  }
  return receipt;
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
  for (const carrier of carriers) {
    await npmPublishTarball(carrier.name, carrier.file, carrier.version);
  }
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
    verifyReleaseTagOrThrow(product, headRef);
    states.set(product, mavenProductPublicationState(product));
  }
  const pendingProducts = operation.products.filter((product) => states.get(product) === "pending");
  if (pendingProducts.length === 0) {
    const receipts = await verifyLockedRegistryIntegrity(ACTIVE_PUBLICATION_LOCK, {
      carrierIds: operation.carrierIds,
    });
    console.log("Every selected Maven coordinate is already published with lock-matching bytes; skipping Maven Central upload.");
    return receipts;
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
    requireProductRegistryPublishedOrThrow(product, "maven");
  }
  return await verifyLockedRegistryIntegrity(ACTIVE_PUBLICATION_LOCK, {
    carrierIds: operation.carrierIds,
  });
}

async function publishNormalCarrier(operation, headRef, context, provenReceipts) {
  const carrier = lockedCarrierById(operation.carrierId);
  if (carrier.product !== operation.product || carrier.ecosystem !== operation.ecosystem) {
    throw new Error(`${operation.id} no longer matches its exact frozen carrier`);
  }
  if (provenReceipts.has(carrier.id)) {
    console.log(`${carrier.id}@${carrier.version} is covered by the complete immutable bootstrap ledger; skipping redundant registry reconciliation.`);
    return;
  }
  if (carrier.ecosystem === "cargo") {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "cargo", carrier.name);
    return await cargoPublishLockedCrateExact(carrier.name, carrier.version, locked.file, {
      alreadyPublished: context.alreadyPublished,
      token: context.cargoToken,
      tokenDeadlineEpochMs: context.tokenDeadlineEpochMs,
    });
  }
  if (carrier.ecosystem === "npm") {
    const locked = lockedCarrierFile(ACTIVE_PUBLICATION_LOCK, "npm", carrier.name);
    return await npmPublishTarball(carrier.name, locked.file, carrier.version);
  }
  if (carrier.ecosystem === "jsr") {
    if (carrier.product !== "oliphaunt-js" || carrier.name !== "@oliphaunt/ts") {
      throw new Error(`unsupported JSR carrier ${carrier.id}; add an exact frozen JSR publisher before selecting it`);
    }
    return await publishTypescriptJsr(headRef, {
      version: carrier.version,
      source: path.join(ROOT, "target", "sdk-artifacts", carrier.product, "jsr-source"),
    });
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
  rmSync(NORMAL_EXECUTION_RESULT_PATH, { force: true });
  const canonicalProducts = [...products].sort(compareText);
  const plan = normalPublicationPlan(ACTIVE_PUBLICATION_LOCK, products);
  if (plan.carrierCount === 0) {
    const checkpoint = openNormalPublicationCheckpoint({
      file: NORMAL_PUBLICATION_CHECKPOINT_PATH,
      lock: ACTIVE_PUBLICATION_LOCK,
      products,
      plan,
    });
    const admission = loadBoundNormalPublicationAdmission({
      checkpoint: checkpoint.checkpoint,
      lock: ACTIVE_PUBLICATION_LOCK,
      plan,
      products,
    });
    if (
      admission.completedOperationIds.length !== 0
      || admission.admittedOperationIds.length !== 0
      || admission.unadmittedOperationIds.length !== 0
    ) {
      throw new Error("empty registry topology received a nonempty normal-publication admission partition");
    }
    writeRegistryReceiptEvidence(REGISTRY_RECEIPT_EVIDENCE_PATH, ACTIVE_PUBLICATION_LOCK, {
      products,
      ecosystems: ["cargo", "npm", "maven", "jsr"],
      receipts: [],
    });
    writeNormalExecutionResult({
      schema: "oliphaunt-normal-publication-execution-result-v1",
      operation: "publish",
      decision: "complete",
      deferralMode: null,
      source: { commit: ACTIVE_PUBLICATION_LOCK.source.commit, tree: ACTIVE_PUBLICATION_LOCK.source.tree },
      lock: {
        lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
        catalogDigest: ACTIVE_PUBLICATION_LOCK.catalogDigest,
        packageEnvelopeDigest: ACTIVE_PUBLICATION_LOCK.packageEnvelopeDigest,
      },
      products: canonicalProducts,
      admittedIds: [],
      completedIds: [],
      newlyCompletedIds: [],
      remainingIds: [],
      notBeforeEpochSeconds: null,
    });
    console.log("Selected release contains no registry carriers; preserved exact empty registry receipt evidence and skipped registry mutation.");
    return;
  }
  requireNormalRegistryProductInputs(products);
  const carrierProducts = [...new Set(
    plan.operations.flatMap((operation) => operation.products),
  )].sort(compareText);
  for (const product of carrierProducts) verifyReleaseTag(product, headRef);
  const bootstrapLedger = loadBootstrapLedger(BOOTSTRAP_LEDGER_PATH, ACTIVE_PUBLICATION_LOCK, products, {
    allowEmpty: true,
    requireComplete: true,
  });
  const provenReceipts = new Map(
    (bootstrapLedger?.receipts ?? []).map((receipt) => [receipt.id, receipt]),
  );
  const selectedCarrierIds = new Set(plan.operations.flatMap((operation) =>
    operation.kind === "carrier" ? [operation.carrierId] : operation.carrierIds));
  for (const id of provenReceipts.keys()) {
    if (!selectedCarrierIds.has(id)) {
      throw new Error(`complete bootstrap ledger contains ${id}, which is absent from the exact normal publication plan`);
    }
  }
  const checkpoint = openNormalPublicationCheckpoint({
    file: NORMAL_PUBLICATION_CHECKPOINT_PATH,
    lock: ACTIVE_PUBLICATION_LOCK,
    products,
    plan,
    initialReceipts: [...provenReceipts.values()],
  });
  const admission = loadBoundNormalPublicationAdmission({
    checkpoint: checkpoint.checkpoint,
    lock: ACTIVE_PUBLICATION_LOCK,
    plan,
    products,
  });
  const completedOperationResults = await checkpoint.reconcileCompleted();
  const startingCompletedOperationIds = new Set(completedOperationResults.keys());
  const canonicalStartingCompletedIds = plan.operations
    .filter(({ id }) => startingCompletedOperationIds.has(id))
    .map(({ id }) => id);
  if (
    JSON.stringify(canonicalStartingCompletedIds)
      !== JSON.stringify(admission.completedOperationIds)
  ) {
    throw new Error("live reconciled checkpoint operations differ from the immutable capacity admission");
  }
  const admittedIds = admission.admittedOperationIds;
  console.log(
    `Executing exactly ${admittedIds.length}/${plan.operations.length - canonicalStartingCompletedIds.length} `
      + `remaining dependency-ordered registry operations for ${plan.carrierCount} exact frozen carriers.`,
  );
  if (provenReceipts.size > 0) {
    console.log(`Reusing ${provenReceipts.size} lock-bound Cargo/npm receipts from the complete, preverified bootstrap ledger.`);
  }
  if (completedOperationResults.size > 0) {
    console.log(
      `Reconciled and resumed ${completedOperationResults.size} atomically checkpointed registry operations from ` +
      `${path.relative(ROOT, NORMAL_PUBLICATION_CHECKPOINT_PATH)}.`,
    );
  }
  const execution = await executeNormalPublicationPlan({
    plan,
    completedOperationResults,
    admittedOperationIds: admittedIds,
    onOperationComplete: checkpoint.recordOperation,
    batchSize: process.env.CRATES_IO_TRUSTED_PUBLISH_BATCH_SIZE,
    cargoVersionPublished: async (operation) => {
      if (provenReceipts.has(operation.carrierId)) return true;
      const carrier = lockedCarrierById(operation.carrierId);
      return exactCargoVersionPublished(carrier.name, carrier.version);
    },
    publishCarrier: (operation, context) => publishNormalCarrier(operation, headRef, context, provenReceipts),
    publishMaven: (operation) => publishNormalMavenOperation(operation, headRef),
  });
  if (JSON.stringify(execution.admittedOperationIds) !== JSON.stringify(admittedIds)) {
    throw new Error("normal registry executor substituted the immutable admitted operation subset");
  }
  const deferralMode = execution.decision === "complete"
    ? null
    : execution.newlyCompletedOperationIds.length > 0
      ? "progress"
      : execution.deferReason === "rate-limit"
        ? "rate-limit"
        : execution.deferReason === "deadline"
          ? "pre-mutation-deadline"
          : (() => {
              throw new Error(
                `zero-progress normal-publication deferral requires an explicit rate-limit or deadline reason; got `
                  + `${execution.deferReason ?? "none"}`,
              );
            })();
  const executionResultValue = {
    schema: "oliphaunt-normal-publication-execution-result-v1",
    operation: "publish",
    decision: execution.decision,
    deferralMode,
    source: { commit: ACTIVE_PUBLICATION_LOCK.source.commit, tree: ACTIVE_PUBLICATION_LOCK.source.tree },
    lock: {
      lockDigest: ACTIVE_PUBLICATION_LOCK.lockDigest,
      catalogDigest: ACTIVE_PUBLICATION_LOCK.catalogDigest,
      packageEnvelopeDigest: ACTIVE_PUBLICATION_LOCK.packageEnvelopeDigest,
    },
    products: canonicalProducts,
    admittedIds: admission.admittedOperationIds,
    completedIds: execution.completedOperationIds,
    newlyCompletedIds: execution.newlyCompletedOperationIds,
    remainingIds: execution.remainingOperationIds,
    notBeforeEpochSeconds: execution.notBeforeEpochSeconds,
  };
  if (executionResultValue.decision === "deferred") {
    const executionResult = writeNormalExecutionResult(executionResultValue);
    console.log(
      `Checkpointed ${executionResult.newlyCompletedIds.length} new registry operation(s); `
        + `${executionResult.remainingIds.length} operation(s) remain for a continuation no earlier than `
        + `${executionResult.notBeforeEpochSeconds}.`,
    );
    return;
  }
  const completeReceipts = collectNormalPublicationReceipts({
    plan,
    initialReceipts: [...provenReceipts.values()],
    operationResults: execution.operationResults,
  });
  writeRegistryReceiptEvidence(REGISTRY_RECEIPT_EVIDENCE_PATH, ACTIVE_PUBLICATION_LOCK, {
    products,
    ecosystems: ["cargo", "npm", "maven", "jsr"],
    receipts: [...completeReceipts.values()],
  });
  writeNormalExecutionResult(executionResultValue);
  console.log(`Preserved ${completeReceipts.size} exact-lock registry receipts at ${path.relative(ROOT, REGISTRY_RECEIPT_EVIDENCE_PATH)}.`);
}

function jsonOutput(args) {
  const result = spawnSync(process.execPath, args, {
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
  const qualifiedCi = args.includes("--qualified-ci");
  const allowDirty = args.includes("--allow-dirty");
  if (qualifiedCi && allowDirty) {
    fail("--qualified-ci cannot be combined with --allow-dirty");
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
    allowDirty,
    qualifiedCi,
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--qualified-ci" && arg !== "--wasm"),
    products: ordered,
  };
}

function verifyQualifiedCiReplay(productDryRunPlan) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    fail("--qualified-ci is valid only inside the protected GitHub Actions release workflow");
  }
  for (const name of ["CI_RUN_ID", "GITHUB_REPOSITORY", "RELEASE_HEAD_SHA", "WASIX_EVIDENCE_REQUIRED"]) {
    if (!process.env[name]?.trim()) {
      fail(`--qualified-ci requires ${name}`);
    }
  }
  if (!["true", "false"].includes(process.env.WASIX_EVIDENCE_REQUIRED)) {
    fail("--qualified-ci requires WASIX_EVIDENCE_REQUIRED to be true or false");
  }
  const headRef = flagValue(productDryRunPlan.passthrough, "--head-ref") ?? "HEAD";
  try {
    assertQualifiedReplaySourceState({
      repo: ROOT,
      headRef,
      expectedSha: process.env.RELEASE_HEAD_SHA,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  run(TOOL, [
    "node",
    ".github/scripts/verify-release-candidate.mjs",
    "target/release-candidate/oliphaunt-release-candidate.json",
    "--plan",
    "target/release-candidate/affected-plan/ci-plan.json",
    "--wasix-evidence-required",
    process.env.WASIX_EVIDENCE_REQUIRED,
    "--wasix-evidence-root",
    "target/release-candidate/wasix-evidence",
  ]);
}

async function runProductDryRunPlan(productDryRunPlan) {
  if (productDryRunPlan.qualifiedCi) {
    verifyQualifiedCiReplay(productDryRunPlan);
    run(TOOL, [process.execPath, "tools/release/release-metadata-check.mjs"]);
  } else {
    run(TOOL, [process.execPath, "tools/release/release-check.mjs"]);
  }
  run(TOOL, [process.execPath, "tools/release/release-check-registries.mjs", ...productDryRunPlan.passthrough]);
  for (const product of productDryRunPlan.products) {
    await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });
  }
  await runExternalExtensionRegistryConsumerProof(productDryRunPlan.products);
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
  run(TOOL, [process.execPath, "tools/release/release-check.mjs"]);
  const passthrough = args.filter((arg) => arg !== "--allow-dirty");
  if (passthrough.length > 0) {
    run(TOOL, [process.execPath, "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  console.log("No release products selected; publish environment and package publish steps skipped.");
}

if (isNoProductPublishDryRun(command, argv.slice(1))) {
  const passthrough = noProductPublishDryRunPassthrough(argv.slice(1));
  run(TOOL, [process.execPath, "tools/release/release-check.mjs"]);
  if (passthrough.length > 0) {
    run(TOOL, [process.execPath, "tools/release/release-check-registries.mjs", ...passthrough]);
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
  run(TOOL, [process.execPath, "tools/release/release-check.mjs"]);
  if (legacyWasmDryRunPlan.passthrough.length > 0) {
    run(TOOL, [process.execPath, "tools/release/release-check-registries.mjs", ...legacyWasmDryRunPlan.passthrough]);
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
  fail("--registry-plan is forbidden during identity bootstrap");
}
if (BOOTSTRAP_IDENTITIES && NORMAL_PUBLICATION_ADMISSION_PATH !== null) {
  fail("--registry-admission is forbidden during identity bootstrap");
}
if (!normalRegistryPlanSelected && NORMAL_PUBLICATION_ADMISSION_PATH !== null) {
  fail("--registry-admission is valid only with --registry-plan");
}
if (BOOTSTRAP_IDENTITIES && bootstrapCarrierId !== null) {
  try {
    await publishBootstrapCarrier(
      bootstrapCarrierId,
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
  } catch (cause) {
    if (isRegistryPublicationDeferredError(cause)) exitTypedRegistryDeferral(cause);
    throw cause;
  }
  process.exit(0);
}
if (normalRegistryPlanSelected) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested === null || publishProductStep !== null) {
    fail("--registry-plan requires --products-json and cannot be combined with --product/--step");
  }
  if (NORMAL_PUBLICATION_ADMISSION_PATH === null) {
    fail("--registry-plan requires the immutable --registry-admission emitted by capacity preflight");
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
    await publishSelectedGithubReleaseAssetSets(
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
  await publishLiboliphauntNpmPackages(publishProductStep.headRef);
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
  await publishBrokerNpmPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-broker" && publishProductStep.step === "crates-io") {
  await publishBrokerCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-react-native" && publishProductStep.step === "npm") {
  await publishReactNativeNpm(publishProductStep.headRef);
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
    await publishTypescriptNpmBootstrap(publishProductStep.headRef);
  } else {
    await publishTypescriptNpm(publishProductStep.headRef);
  }
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-js" && publishProductStep.step === "jsr") {
  await publishTypescriptJsr(publishProductStep.headRef);
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
