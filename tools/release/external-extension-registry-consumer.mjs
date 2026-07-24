import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  DESKTOP_TARGETS,
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionMetadata,
  extensionRegistryPackageTargetSets,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import {
  extensionNpmPackageForProduct,
  extensionNpmTargetPackageForProduct,
} from "./extension-registry-packages.mjs";
import { expectedExtensionAotTargets } from "./wasix-cargo-artifact-contract.mjs";
import { consumeExactCargoCandidates } from "./exact-cargo-candidate-consumer.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "external-extension-registry-consumer.mjs";
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "target/release-work/external-extension-registry-consumer");
const DEFAULT_VERDACCIO_PORT = "4887";
const VERIFIED_NODE_ENV = "OLIPHAUNT_VERIFIED_NODE_EXECUTABLE";
const VERIFIED_NPM_CLI_ENV = "OLIPHAUNT_VERIFIED_NPM_CLI";
const NPM_TREE_DIGEST_DOMAIN = "oliphaunt-bootstrap-tree-v2\0";
const MAX_VERIFIED_NPM_TREE_FILES = 4096;
const MAX_VERIFIED_NPM_TREE_BYTES = 750 * 1024 * 1024;
const NODE_TARGET_BY_HOST = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
});

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function sha256File(file) {
  const digest = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw error(`${label} must be an object`);
  }
  return value;
}

function exactSemver(value, label) {
  if (typeof value !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(value)) {
    throw error(`${label} must be an exact stable semantic version`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw error(`${label} must be a quoted positive integer`);
  }
  return Number.parseInt(value, 10);
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw error(`${label} must be an exact lowercase SHA-256`);
  }
  return value;
}

function exactPortablePathList(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw error(`${label} must be a non-empty comma-separated path list`);
  }
  const paths = value.split(",");
  if (new Set(paths).size !== paths.length) {
    throw error(`${label} must not contain duplicate paths`);
  }
  for (const entry of paths) {
    if (
      entry.length === 0
      || entry.includes("\\")
      || entry.startsWith("/")
      || entry.split("/").some((component) => component === "" || component === "." || component === "..")
      || /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw error(`${label} contains a non-portable path: ${JSON.stringify(entry)}`);
    }
  }
  return Object.freeze([...paths]);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameFileRevision(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function frozenFileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function exactFileIdentity(value, label) {
  const identity = object(value, label);
  for (const key of ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"]) {
    if (typeof identity[key] !== "bigint") {
      throw error(`${label}.${key} must be a bigint`);
    }
  }
  return identity;
}

function regularAbsoluteFile(value, label) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw error(`${label} must be a non-empty absolute path exported by setup-npm-publisher`);
  }
  let initial;
  try {
    initial = lstatSync(value, { bigint: true });
  } catch (cause) {
    throw error(`${label} is unavailable: ${value}: ${cause.message}`);
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw error(`${label} must be a regular non-symbolic-link file: ${value}`);
  }
  let canonical;
  let canonicalMetadata;
  let completed;
  try {
    canonical = realpathSync(value);
    canonicalMetadata = lstatSync(canonical, { bigint: true });
    completed = lstatSync(value, { bigint: true });
  } catch (cause) {
    throw error(`${label} changed while its canonical path was being resolved: ${value}: ${cause.message}`);
  }
  if (
    canonicalMetadata.isSymbolicLink()
    || !canonicalMetadata.isFile()
    || completed.isSymbolicLink()
    || !completed.isFile()
    || !sameFileRevision(initial, canonicalMetadata)
    || !sameFileRevision(initial, completed)
  ) {
    throw error(`${label} changed while its canonical path was being resolved: ${value}`);
  }
  return Object.freeze({ path: canonical, metadata: canonicalMetadata });
}

function requireFileIdentity(file, { bytes, sha256 }, label, priorIdentity = undefined) {
  const expectedIdentity = priorIdentity === undefined
    ? undefined
    : exactFileIdentity(priorIdentity, `${label} filesystem identity`);
  if (expectedIdentity !== undefined && !sameFileRevision(file.metadata, expectedIdentity)) {
    throw error(`${label} filesystem identity changed after setup: ${file.path}`);
  }
  if (file.metadata.size !== BigInt(bytes)) {
    throw error(`${label} byte count differs: expected ${bytes}, got ${file.metadata.size}: ${file.path}`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(file.path, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    throw error(`${label} cannot be opened without following symbolic links: ${file.path}: ${cause.message}`);
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let actualBytes = 0;
  let opened;
  let completed;
  try {
    opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(file.metadata, opened)) {
      throw error(`${label} changed between path inspection and descriptor open: ${file.path}`);
    }
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      actualBytes += count;
      digest.update(buffer.subarray(0, count));
    }
    completed = fstatSync(descriptor, { bigint: true });
    if (
      !completed.isFile()
      || BigInt(actualBytes) !== file.metadata.size
      || !sameFileIdentity(file.metadata, completed)
      || !sameFileRevision(opened, completed)
    ) {
      throw error(`${label} changed while it was being hashed: ${file.path}`);
    }
  } finally {
    closeSync(descriptor);
  }

  let finalMetadata;
  let finalCanonical;
  try {
    finalMetadata = lstatSync(file.path, { bigint: true });
    finalCanonical = realpathSync(file.path);
  } catch (cause) {
    throw error(`${label} path changed after it was hashed: ${file.path}: ${cause.message}`);
  }
  if (
    finalMetadata.isSymbolicLink()
    || !finalMetadata.isFile()
    || finalCanonical !== file.path
    || !sameFileRevision(completed, finalMetadata)
  ) {
    throw error(`${label} path changed after it was hashed: ${file.path}`);
  }

  const actualSha256 = digest.digest("hex");
  if (actualSha256 !== sha256) {
    throw error(`${label} SHA-256 differs: expected ${sha256}, got ${actualSha256}: ${file.path}`);
  }
  return frozenFileIdentity(completed);
}

function collectVerifiedTreeFiles(root, expectedFileCount) {
  const files = [];
  const portablePaths = new Map();
  const visit = (directory, relativeDirectory) => {
    const directoryMetadata = lstatSync(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw error(`verified npm tree contains a non-directory or symbolic-link ancestor: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw error(`verified npm tree contains a symbolic link: ${absolute}`);
      }
      if (metadata.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!metadata.isFile()) {
        throw error(`verified npm tree contains a non-regular file: ${absolute}`);
      }
      if (files.length >= expectedFileCount || files.length >= MAX_VERIFIED_NPM_TREE_FILES) {
        throw error(`verified npm tree exceeds its ${expectedFileCount}-file manifest bound`);
      }
      const portableKey = relative.normalize("NFC").toLowerCase();
      const prior = portablePaths.get(portableKey);
      if (prior !== undefined && prior !== relative) {
        throw error(`verified npm tree paths collide portably: ${prior}, ${relative}`);
      }
      portablePaths.set(portableKey, relative);
      files.push({ absolute, relative, metadata });
    }
  };
  visit(root, "");
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
  return files;
}

function updateDigestFromOpenFile(digest, file) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(file.absolute, fsConstants.O_RDONLY | noFollow);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size !== file.metadata.size
      || opened.dev !== file.metadata.dev
      || opened.ino !== file.metadata.ino
    ) {
      throw error(`verified npm tree file changed while it was being inspected: ${file.absolute}`);
    }
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
    const completed = fstatSync(descriptor);
    if (completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) {
      throw error(`verified npm tree file changed while it was being hashed: ${file.absolute}`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function verifiedNpmTreeIdentity({ root, expectedExecutables, platform, expectedFileCount }) {
  const executableSet = new Set(expectedExecutables);
  const files = collectVerifiedTreeFiles(root, expectedFileCount);
  const actualPaths = new Set(files.map(({ relative }) => relative));
  const missingExecutables = expectedExecutables.filter((relative) => !actualPaths.has(relative));
  if (missingExecutables.length > 0) {
    throw error(`verified npm tree is missing executable paths: ${missingExecutables.join(", ")}`);
  }
  const digest = createHash("sha256").update(NPM_TREE_DIGEST_DOMAIN);
  let expandedBytes = 0;
  for (const file of files) {
    const executable = executableSet.has(file.relative);
    if (platform !== "win32" && Boolean(file.metadata.mode & 0o111) !== executable) {
      throw error(`verified npm tree executable mode differs for ${file.relative}`);
    }
    expandedBytes += file.metadata.size;
    if (expandedBytes > MAX_VERIFIED_NPM_TREE_BYTES) {
      throw error("verified npm tree exceeds its expanded-byte safety bound");
    }
    digest.update(file.relative);
    digest.update("\0");
    digest.update(String(file.metadata.size));
    digest.update("\0");
    digest.update(executable ? "x" : "-");
    digest.update("\0");
    updateDigestFromOpenFile(digest, file);
    digest.update("\0");
  }
  return Object.freeze({
    fileCount: files.length,
    expandedBytes,
    sha256: digest.digest("hex"),
  });
}

export function assertVerifiedNpmPublisherTree(runtime) {
  const npmTree = object(runtime?.npmTree, "verified npm tree contract");
  const actual = verifiedNpmTreeIdentity({
    root: npmTree.root,
    expectedExecutables: npmTree.executablePaths,
    platform: npmTree.platform,
    expectedFileCount: npmTree.fileCount,
  });
  if (
    actual.fileCount !== npmTree.fileCount
    || actual.expandedBytes !== npmTree.expandedBytes
    || actual.sha256 !== npmTree.sha256
  ) {
    throw error(
      `verified npm tree identity differs: expected ${npmTree.fileCount} files/${npmTree.expandedBytes} bytes/${npmTree.sha256}, `
        + `got ${actual.fileCount} files/${actual.expandedBytes} bytes/${actual.sha256}`,
    );
  }
  return actual;
}

function assertVerifiedNpmRuntimeFiles(runtime) {
  const nodeIdentity = object(runtime?.nodeIdentity, "verified Node.js identity contract");
  const npmCliIdentity = object(runtime?.npmCliIdentity, "verified npm CLI identity contract");
  const nodeFileIdentity = exactFileIdentity(
    runtime?.nodeFileIdentity,
    "verified Node.js executable filesystem identity",
  );
  const npmCliFileIdentity = exactFileIdentity(
    runtime?.npmCliFileIdentity,
    "verified npm CLI filesystem identity",
  );
  const nodeFile = regularAbsoluteFile(runtime?.nodeExecutable, VERIFIED_NODE_ENV);
  if (nodeFile.path !== runtime.nodeExecutable) {
    throw error(`${VERIFIED_NODE_ENV} canonical path changed after setup: ${runtime.nodeExecutable}`);
  }
  const npmCliFile = regularAbsoluteFile(runtime?.npmCli, VERIFIED_NPM_CLI_ENV);
  if (npmCliFile.path !== runtime.npmCli) {
    throw error(`${VERIFIED_NPM_CLI_ENV} canonical path changed after setup: ${runtime.npmCli}`);
  }
  requireFileIdentity(
    nodeFile,
    nodeIdentity,
    "verified Node.js executable",
    nodeFileIdentity,
  );
  requireFileIdentity(
    npmCliFile,
    npmCliIdentity,
    "verified npm CLI",
    npmCliFileIdentity,
  );
  return Object.freeze({
    nodeExecutable: nodeFile.path,
    npmCli: npmCliFile.path,
  });
}

export function assertVerifiedNpmPublisherRuntime(runtime) {
  const npmTree = assertVerifiedNpmPublisherTree(runtime);
  return Object.freeze({
    ...assertVerifiedNpmRuntimeFiles(runtime),
    npmTree,
  });
}

function runtimeProbe(spawnImpl, command, args, cwd) {
  const spawnOptions = {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  };
  const result = spawnImpl === undefined
    ? captureCommandOutput(command, args, {
        cwd,
        env: process.env,
        label: `${command} ${args.join(" ")}`,
        maxOutputBytes: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      })
    : spawnImpl(command, args, spawnOptions);
  if (result.error !== undefined) {
    throw error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

/**
 * Resolve the immutable npm runtime exported by setup-npm-publisher.
 *
 * The workflow output binding proves setup dominance. Rechecking Node and the
 * complete npm tree against the repository manifests here makes a missing,
 * ambient, stale, or post-setup-modified runtime fail before local registry
 * work starts. The complete tree is checked again immediately before use.
 */
export function resolveVerifiedNpmPublisherRuntime({
  environment = process.env,
  root = ROOT,
  platform = process.platform,
  arch = process.arch,
  spawnImpl = undefined,
} = {}) {
  const target = NODE_TARGET_BY_HOST[`${platform}-${arch}`];
  if (target === undefined) {
    throw error(`unsupported verified Node.js host ${platform}-${arch}`);
  }
  const nodeManifestFile = path.join(root, "src/sources/toolchains/node-runtime.toml");
  const npmManifestFile = path.join(root, "src/sources/toolchains/npm-publisher.toml");
  let nodeManifest;
  let npmManifest;
  try {
    nodeManifest = object(Bun.TOML.parse(readFileSync(nodeManifestFile, "utf8")), nodeManifestFile);
    npmManifest = object(Bun.TOML.parse(readFileSync(npmManifestFile, "utf8")), npmManifestFile);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith(`${TOOL}:`)) throw cause;
    throw error(`cannot parse pinned npm runtime manifests: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const nodeVersion = exactSemver(
    object(nodeManifest.toolchain, `${nodeManifestFile} toolchain`).version,
    `${nodeManifestFile} toolchain.version`,
  );
  const nodeAsset = object(
    object(nodeManifest.assets, `${nodeManifestFile} assets`)[target],
    `${nodeManifestFile} assets.${target}`,
  );
  const npmVersion = exactSemver(
    object(npmManifest.toolchain, `${npmManifestFile} toolchain`).version,
    `${npmManifestFile} toolchain.version`,
  );
  const npmPackage = object(npmManifest.package, `${npmManifestFile} package`);
  if (npmPackage.binary_path !== "bin/npm-cli.js") {
    throw error(`${npmManifestFile} package.binary_path must be bin/npm-cli.js`);
  }
  const executablePaths = exactPortablePathList(
    npmPackage.executable_paths,
    `${npmManifestFile} package.executable_paths`,
  );

  const nodeFile = regularAbsoluteFile(environment[VERIFIED_NODE_ENV], VERIFIED_NODE_ENV);
  const npmCliFile = regularAbsoluteFile(environment[VERIFIED_NPM_CLI_ENV], VERIFIED_NPM_CLI_ENV);
  const nodeExecutable = nodeFile.path;
  const npmCli = npmCliFile.path;
  const npmCliSuffix = path.join("npm", npmPackage.binary_path).split(path.sep);
  const npmCliParts = path.normalize(npmCli).split(path.sep);
  if (JSON.stringify(npmCliParts.slice(-npmCliSuffix.length)) !== JSON.stringify(npmCliSuffix)) {
    throw error(`${VERIFIED_NPM_CLI_ENV} does not identify the canonical verified npm CLI layout: ${npmCli}`);
  }
  const npmRoot = path.dirname(path.dirname(npmCli));
  if (path.join(npmRoot, ...npmPackage.binary_path.split("/")) !== npmCli) {
    throw error(`${VERIFIED_NPM_CLI_ENV} is outside its canonical verified npm tree: ${npmCli}`);
  }

  const nodeIdentity = Object.freeze({
    bytes: positiveInteger(nodeAsset.binary_bytes, `${nodeManifestFile} assets.${target}.binary_bytes`),
    sha256: exactSha256(nodeAsset.binary_sha256, `${nodeManifestFile} assets.${target}.binary_sha256`),
  });
  const npmCliIdentity = Object.freeze({
    bytes: positiveInteger(npmPackage.binary_bytes, `${npmManifestFile} package.binary_bytes`),
    sha256: exactSha256(npmPackage.binary_sha256, `${npmManifestFile} package.binary_sha256`),
  });
  const nodeFileIdentity = requireFileIdentity(nodeFile, nodeIdentity, "verified Node.js executable");
  const npmCliFileIdentity = requireFileIdentity(npmCliFile, npmCliIdentity, "verified npm CLI");
  const npmTree = Object.freeze({
    root: npmRoot,
    fileCount: positiveInteger(npmPackage.file_count, `${npmManifestFile} package.file_count`),
    expandedBytes: positiveInteger(npmPackage.expanded_bytes, `${npmManifestFile} package.expanded_bytes`),
    sha256: exactSha256(npmPackage.tree_sha256, `${npmManifestFile} package.tree_sha256`),
    executablePaths,
    platform,
  });
  assertVerifiedNpmPublisherTree({ npmTree });

  const runtime = Object.freeze({
    nodeExecutable,
    npmCli,
    nodeVersion,
    npmVersion,
    nodeIdentity,
    npmCliIdentity,
    nodeFileIdentity,
    npmCliFileIdentity,
    npmTree,
  });
  let checkedRuntime = assertVerifiedNpmRuntimeFiles(runtime);
  const observedNodeVersion = runtimeProbe(spawnImpl, checkedRuntime.nodeExecutable, ["--version"], root);
  if (observedNodeVersion !== `v${nodeVersion}`) {
    throw error(`verified Node.js version differs: expected v${nodeVersion}, got ${JSON.stringify(observedNodeVersion)}`);
  }
  checkedRuntime = assertVerifiedNpmRuntimeFiles(runtime);
  const observedNpmVersion = runtimeProbe(
    spawnImpl,
    checkedRuntime.nodeExecutable,
    [checkedRuntime.npmCli, "--version"],
    root,
  );
  if (observedNpmVersion !== npmVersion) {
    throw error(`verified npm version differs: expected ${npmVersion}, got ${JSON.stringify(observedNpmVersion)}`);
  }
  return runtime;
}

function run(command, args, { cwd = ROOT, env = process.env, timeout = 30 * 60_000 } = {}) {
  const result = captureCommandOutput(command, args, {
    cwd,
    env,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
    timeout,
  });
  if (result.error !== undefined) {
    throw error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

function externalProducts(products) {
  if (!Array.isArray(products) || products.some((product) => typeof product !== "string" || product.length === 0)) {
    throw error("products must be a string list");
  }
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length !== products.length) throw error("products must not contain duplicates");
  const exact = new Set(exactExtensionProducts(TOOL));
  return selected.filter((product) => {
    if (!exact.has(product)) return false;
    return extensionMetadata(product, TOOL).class === "external";
  });
}

function packageNames(product, packageKind) {
  return registryPackageRows({ product, packageKind }, TOOL)
    .map(({ packageName }) => packageName)
    .sort(compareText);
}

export function externalExtensionConsumerPlan(products) {
  const selected = externalProducts(products);
  const npmTargetsByProduct = new Map(selected.map((product) => [
    product,
    [...extensionRegistryPackageTargetSets(product, TOOL).npmTargets].sort(compareText),
  ]));
  const npmTargets = [...new Set([...npmTargetsByProduct.values()].flat())].sort(compareText);
  const npmProductsByTarget = Object.fromEntries(npmTargets.map((target) => [
    target,
    selected.filter((product) => npmTargetsByProduct.get(product).includes(target)),
  ]));
  return {
    products: selected,
    cargo: {
      dependencies: selected.map((product) => ({
        name: product,
        version: currentProductVersionSync(product, TOOL),
        defaultFeatures: false,
        features: [
          "native",
          "wasix",
          ...(extensionRegistryPackageTargetSets(product, TOOL).includeWasixAot
            ? expectedExtensionAotTargets().map((target) => `wasix-aot-${target}`)
            : []),
        ].sort(compareText),
      })),
      expectedPackages: selected.flatMap((product) => packageNames(product, "crates")).sort(compareText),
    },
    npm: {
      targets: npmTargets,
      productsByTarget: npmProductsByTarget,
      expectedPackages: selected.flatMap((product) => packageNames(product, "npm")).sort(compareText),
    },
    maven: {
      expectedCoordinates: selected.flatMap((product) => packageNames(product, "maven")
        .map((coordinate) => `${coordinate}:${currentProductVersionSync(product, TOOL)}`)).sort(compareText),
    },
  };
}

function publishExactCargoRegistry(plan, outputRoot) {
  const registryRoot = path.join(outputRoot, "cargo-registry");
  const roots = plan.products.map((product) =>
    path.join(ROOT, "target/release/extension-dry-run/cargo", product));
  const missingRoots = roots.filter((root) => !existsSync(root) || !statSync(root).isDirectory());
  if (missingRoots.length > 0) {
    throw error(`missing staged external-extension Cargo roots: ${missingRoots.join(", ")}`);
  }
  run(process.execPath, [
    "tools/release/local-registry-publish.mjs",
    "publish",
    "--surface", "cargo",
    "--strict",
    "--exact-artifacts",
    "--products-json", JSON.stringify(plan.products),
    ...roots.flatMap((root) => ["--artifact-root", root]),
    "--registry-root", registryRoot,
  ]);
  const evidence = consumeExactCargoCandidates({
    indexDirectory: path.join(registryRoot, "cargo/index"),
    outputRoot: path.join(outputRoot, "cargo-consumer"),
    packageName: "oliphaunt-external-extension-candidate-consumer",
    dependencies: plan.cargo.dependencies,
  });
  const actual = evidence.installed.map(({ name }) => name).sort(compareText);
  const expected = new Set(plan.cargo.expectedPackages);
  const missing = plan.cargo.expectedPackages.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) =>
    !expected.has(name)
    && !plan.cargo.expectedPackages.some((parent) =>
      name.startsWith(`${parent}-part-`) && /^\d{3}$/u.test(name.slice(`${parent}-part-`.length))));
  if (missing.length > 0 || unexpected.length > 0) {
    throw error(
      `Cargo consumer carrier coverage mismatch: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  return evidence;
}

function stopVerdaccio(registryRoot) {
  const pidFile = path.join(registryRoot, "verdaccio/verdaccio.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The registry already stopped with its parent process.
    }
  }
  rmSync(pidFile, { force: true });
}

export function externalExtensionNpmConsumerSpec(plan, target) {
  const targetContract = DESKTOP_TARGETS[target];
  if (
    !Object.hasOwn(DESKTOP_TARGETS, target)
    || targetContract === undefined
    || !Object.hasOwn(targetContract, "npmOs")
    || !Object.hasOwn(targetContract, "npmCpu")
    || typeof targetContract.npmOs !== "string"
    || targetContract.npmOs.length === 0
    || typeof targetContract.npmCpu !== "string"
    || targetContract.npmCpu.length === 0
    || (targetContract.npmLibc !== undefined
      && (typeof targetContract.npmLibc !== "string" || targetContract.npmLibc.length === 0))
  ) {
    throw error(`no npm consumer configuration for ${target}`);
  }
  const platform = {
    os: targetContract.npmOs,
    cpu: targetContract.npmCpu,
    ...(targetContract.npmLibc === undefined ? {} : { libc: targetContract.npmLibc }),
  };
  if (
    !Array.isArray(plan?.npm?.targets)
    || !plan.npm.targets.includes(target)
    || new Set(plan.npm.targets).size !== plan.npm.targets.length
  ) {
    throw error(`npm consumer target ${target} must appear exactly once in the plan`);
  }
  const productsByTarget = plan.npm.productsByTarget;
  if (
    productsByTarget === null
    || typeof productsByTarget !== "object"
    || Array.isArray(productsByTarget)
    || !Object.hasOwn(productsByTarget, target)
  ) {
    throw error(`npm consumer plan has no product selection for ${target}`);
  }
  const products = productsByTarget[target];
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error(`npm consumer products for ${target} must be a non-empty unique string list`);
  }
  const entries = products.map((product) => {
    const version = currentProductVersionSync(product, TOOL);
    const targetPackages = Object.fromEntries(
      extensionRegistryPackageTargetSets(product, TOOL).npmTargets
        .map((item) => [item, extensionNpmTargetPackageForProduct(product, item)])
        .sort(([left], [right]) => compareText(left, right)),
    );
    const targetPackage = targetPackages[target];
    if (targetPackage === undefined) {
      throw error(`${product} has no npm target package for selected target ${target}`);
    }
    return {
      product,
      version,
      facade: extensionNpmPackageForProduct(product),
      targetPackage,
      targetPackages,
    };
  }).sort((left, right) => compareText(left.product, right.product));
  const dependencies = Object.fromEntries(
    entries.map(({ facade, version }) => [facade, version])
      .sort(([left], [right]) => compareText(left, right)),
  );
  const expectedPackages = Object.fromEntries(
    entries.flatMap(({ facade, targetPackage, version }) => [
      [facade, version],
      [targetPackage, version],
    ]).sort(([left], [right]) => compareText(left, right)),
  );
  if (
    Object.keys(dependencies).length !== entries.length
    || Object.keys(expectedPackages).length !== entries.length * 2
    || new Set(entries.flatMap(({ facade, targetPackages }) => [
      facade,
      ...Object.values(targetPackages),
    ])).size !== entries.reduce(
      (count, { targetPackages }) => count + 1 + Object.keys(targetPackages).length,
      0,
    )
  ) {
    throw error(`npm consumer package identities collide for ${target}`);
  }
  return {
    target,
    platform,
    products: entries.map(({ product }) => product),
    dependencies,
    expectedPackages,
    entries,
  };
}

function installedOliphauntPackages(consumerRoot) {
  const scope = path.join(consumerRoot, "node_modules/@oliphaunt");
  if (!existsSync(scope)) return [];
  const entries = readdirSync(scope, { withFileTypes: true });
  const invalid = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort(compareText);
  if (invalid.length > 0) {
    throw error(`installed npm @oliphaunt scope contains non-directory entries: ${invalid.join(", ")}`);
  }
  const packages = entries.map((entry) => `@oliphaunt/${entry.name}`).sort(compareText);
  for (const name of packages) {
    const nestedScope = path.join(consumerRoot, "node_modules", ...name.split("/"), "node_modules/@oliphaunt");
    if (existsSync(nestedScope)) {
      throw error(`installed npm carrier ${name} contains an unexpected nested @oliphaunt scope`);
    }
  }
  return packages;
}

function exactStringMap(value, label) {
  const entries = Object.entries(object(value, label));
  if (entries.some(([key, item]) =>
    key.length === 0 || typeof item !== "string" || item.length === 0)) {
    throw error(`${label} must map non-empty strings to non-empty strings`);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareText(left, right)));
}

function assertExactStringMap(value, expected, label) {
  const actual = exactStringMap(value, label);
  const canonicalExpected = exactStringMap(expected, `${label} expected value`);
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw error(`${label} differs: expected=${JSON.stringify(canonicalExpected)}, actual=${JSON.stringify(actual)}`);
  }
  return actual;
}

function assertExactStringList(value, expected, label) {
  const actual = value === undefined ? [] : value;
  if (
    !Array.isArray(actual)
    || actual.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(actual).size !== actual.length
    || JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw error(`${label} differs: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
  }
}

function exactNpmLockEntry(lock, name, version, registryUrl, { optional }) {
  const entry = lock.packages[`node_modules/${name}`];
  if (
    entry?.version !== version
    || typeof entry.resolved !== "string"
    || !entry.resolved.startsWith(`${registryUrl}/`)
    || typeof entry.integrity !== "string"
    || !entry.integrity.startsWith("sha512-")
    || (optional ? entry.optional !== true : entry.optional === true)
  ) {
    throw error(`${name}@${version} does not have an exact isolated-registry lock entry`);
  }
  return entry;
}

export function validateExactNpmConsumer({ consumerRoot, registryUrl, consumer }) {
  const spec = object(consumer, "npm consumer specification");
  const dependencies = exactStringMap(spec.dependencies, "npm consumer dependencies");
  const expectedPackages = exactStringMap(spec.expectedPackages, "npm consumer expected packages");
  const platform = object(spec.platform, "npm consumer platform");
  if (
    typeof spec.target !== "string"
    || spec.target.length === 0
    || typeof platform.os !== "string"
    || platform.os.length === 0
    || typeof platform.cpu !== "string"
    || platform.cpu.length === 0
    || (platform.libc !== undefined && (typeof platform.libc !== "string" || platform.libc.length === 0))
  ) {
    throw error("npm consumer platform must declare exact os/cpu and optional libc strings");
  }
  if (!Array.isArray(spec.entries) || spec.entries.length === 0) {
    throw error("npm consumer specification must contain package entries");
  }
  const lockFile = path.join(consumerRoot, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  if (lock.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== "object") {
    throw error(`${lockFile} must be an npm lockfile v3`);
  }
  const rootManifest = JSON.parse(readFileSync(path.join(consumerRoot, "package.json"), "utf8"));
  assertExactStringMap(rootManifest.dependencies, dependencies, "npm consumer root dependencies");
  assertExactStringMap(rootManifest.optionalDependencies ?? {}, {}, "npm consumer root optional dependencies");
  assertExactStringMap(lock.packages[""]?.dependencies, dependencies, "npm consumer lock root dependencies");
  assertExactStringMap(lock.packages[""]?.optionalDependencies ?? {}, {}, "npm consumer lock root optional dependencies");
  const actual = installedOliphauntPackages(consumerRoot);
  const expectedNames = Object.keys(expectedPackages).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    throw error(`installed npm carrier set differs: expected=${JSON.stringify(expectedNames)}, actual=${JSON.stringify(actual)}`);
  }
  const installed = expectedNames.map((name) => {
    const facade = dependencies[name] !== undefined;
    const entry = exactNpmLockEntry(lock, name, expectedPackages[name], registryUrl, {
      optional: !facade,
    });
    const manifestFile = path.join(consumerRoot, "node_modules", ...name.split("/"), "package.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (
      manifest.name !== name
      || manifest.version !== expectedPackages[name]
    ) {
      throw error(`${name}@${expectedPackages[name]} was not installed exactly from the isolated npm registry`);
    }
    return {
      name,
      version: manifest.version,
      integrity: entry.integrity,
      resolved: entry.resolved,
      manifestSha256: sha256File(manifestFile),
    };
  });
  for (const [index, rawEntry] of spec.entries.entries()) {
    const packageSpec = object(rawEntry, `npm consumer entries[${index}]`);
    const {
      product,
      version,
      facade,
      targetPackage,
    } = packageSpec;
    if (
      typeof product !== "string"
      || product.length === 0
      || typeof version !== "string"
      || expectedPackages[facade] !== version
      || dependencies[facade] !== version
      || expectedPackages[targetPackage] !== version
      || dependencies[targetPackage] !== undefined
    ) {
      throw error(`npm consumer entries[${index}] does not match the exact facade/leaf dependency topology`);
    }
    const targetPackages = exactStringMap(
      packageSpec.targetPackages,
      `npm consumer entries[${index}].targetPackages`,
    );
    if (targetPackages[spec.target] !== targetPackage) {
      throw error(`npm consumer entries[${index}] selected target package differs for ${spec.target}`);
    }
    const optionalDependencies = Object.fromEntries(
      Object.values(targetPackages).map((name) => [name, version])
        .sort(([left], [right]) => compareText(left, right)),
    );
    for (const name of Object.keys(optionalDependencies)) {
      exactNpmLockEntry(lock, name, version, registryUrl, { optional: true });
    }
    const facadeManifest = JSON.parse(readFileSync(
      path.join(consumerRoot, "node_modules", ...facade.split("/"), "package.json"),
      "utf8",
    ));
    assertExactStringMap(
      facadeManifest.optionalDependencies,
      optionalDependencies,
      `${facade} optionalDependencies`,
    );
    if (facadeManifest.oliphaunt?.product !== product) {
      throw error(`${facade} does not identify Oliphaunt product ${product}`);
    }
    assertExactStringMap(
      facadeManifest.oliphaunt?.targetPackageNames,
      targetPackages,
      `${facade} Oliphaunt target package map`,
    );
    const targetManifest = JSON.parse(readFileSync(
      path.join(consumerRoot, "node_modules", ...targetPackage.split("/"), "package.json"),
      "utf8",
    ));
    assertExactStringList(targetManifest.os, [platform.os], `${targetPackage} os selector`);
    assertExactStringList(targetManifest.cpu, [platform.cpu], `${targetPackage} cpu selector`);
    assertExactStringList(
      targetManifest.libc,
      platform.libc === undefined ? [] : [platform.libc],
      `${targetPackage} libc selector`,
    );
    if (
      targetManifest.optional !== true
      || targetManifest.oliphaunt?.product !== product
      || targetManifest.oliphaunt?.target !== spec.target
    ) {
      throw error(`${targetPackage} does not identify the exact optional Oliphaunt target ${product}/${spec.target}`);
    }
  }
  return installed;
}

function publishAndConsumeNpm(plan, outputRoot, port, npmRuntime) {
  const registryRoot = path.join(outputRoot, "npm-registry");
  const roots = plan.npm.targets.flatMap((target) => plan.npm.productsByTarget[target].map((product) =>
    path.join(ROOT, "target/release/extension-dry-run/npm", product, target)));
  const missingRoots = roots.filter((root) => !existsSync(root));
  if (missingRoots.length > 0) {
    throw error(`missing staged external-extension npm roots: ${missingRoots.join(", ")}`);
  }
  try {
    run(process.execPath, [
      "tools/release/local-registry-publish.mjs",
      "publish",
      "--surface", "npm",
      "--strict",
      "--verdaccio-port", port,
      "--registry-root", registryRoot,
      ...roots.flatMap((root) => ["--artifact-root", root]),
    ]);
    const registryUrl = readFileSync(path.join(registryRoot, "verdaccio/registry-url.txt"), "utf8").trim().replace(/\/$/u, "");
    const npmrc = path.join(registryRoot, "verdaccio/npmrc");
    const targetEvidence = [];
    const installedUnion = new Set();
    for (const target of plan.npm.targets) {
      const consumerRoot = path.join(outputRoot, "npm-consumers", target);
      rmSync(consumerRoot, { recursive: true, force: true });
      mkdirSync(consumerRoot, { recursive: true });
      const consumer = externalExtensionNpmConsumerSpec(plan, target);
      writeFileSync(path.join(consumerRoot, "package.json"), `${JSON.stringify({
        name: `oliphaunt-external-extension-consumer-${target}`,
        version: "0.0.0",
        private: true,
        // npm applies --os/--cpu/--libc when selecting optional native
        // dependencies, but checks non-optional packages against the actual
        // host. Depending only on the neutral facades exercises the public
        // install path and lets their exact optional maps select one leaf.
        dependencies: consumer.dependencies,
      }, null, 2)}\n`);
      const checkedRuntime = assertVerifiedNpmPublisherRuntime(npmRuntime);
      run(checkedRuntime.nodeExecutable, [
        checkedRuntime.npmCli,
        "install",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--fetch-retries=0",
        `--registry=${registryUrl}`,
        `--userconfig=${npmrc}`,
        `--os=${consumer.platform.os}`,
        `--cpu=${consumer.platform.cpu}`,
        ...(consumer.platform.libc === undefined ? [] : [`--libc=${consumer.platform.libc}`]),
      ], { cwd: consumerRoot, timeout: 15 * 60_000 });
      const installed = validateExactNpmConsumer({
        consumerRoot,
        registryUrl,
        consumer,
      });
      for (const entry of installed) installedUnion.add(entry.name);
      targetEvidence.push({
        target,
        platform: consumer.platform,
        products: consumer.products,
        packageLockSha256: sha256File(path.join(consumerRoot, "package-lock.json")),
        installed,
      });
    }
    const actual = [...installedUnion].sort(compareText);
    if (JSON.stringify(actual) !== JSON.stringify(plan.npm.expectedPackages)) {
      throw error(`npm consumer carrier coverage mismatch: expected=${JSON.stringify(plan.npm.expectedPackages)}, actual=${JSON.stringify(actual)}`);
    }
    return { registryUrl, targets: targetEvidence };
  } finally {
    stopVerdaccio(registryRoot);
  }
}

function mavenParts(coordinate) {
  const parts = coordinate.split(":");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw error(`invalid exact Maven coordinate ${coordinate}`);
  }
  return { group: parts[0], artifact: parts[1], version: parts[2] };
}

export function renderExactMavenConsumer({ repositories, coordinates, outputFile }) {
  const expected = [...coordinates].sort(compareText);
  return [
    "plugins { id 'base' }",
    "",
    "repositories {",
    ...repositories.map((repository) => `  maven { url = uri(${JSON.stringify(repository)}); metadataSources { mavenPom(); artifact() } }`),
    "}",
    "",
    "configurations { exactCandidates { canBeConsumed = false; canBeResolved = true } }",
    "dependencies {",
    ...expected.map((coordinate) => `  exactCandidates ${JSON.stringify(`${coordinate}@tar.gz`)}`),
    "}",
    "",
    "tasks.register('resolveExactCandidates') {",
    "  doLast {",
    "    def actual = configurations.exactCandidates.resolvedConfiguration.resolvedArtifacts.collect { artifact ->",
    "      \"${artifact.moduleVersion.id.group}:${artifact.name}:${artifact.moduleVersion.id.version}\\t${artifact.file.absolutePath}\"",
    "    }.sort()",
    `    def expected = ${JSON.stringify(expected)}`,
    "    def identities = actual.collect { it.split('\\t', 2)[0] }",
    "    if (identities != expected) { throw new GradleException(\"exact Maven carrier set differs: expected=${expected}, actual=${identities}\") }",
    `    file(${JSON.stringify(outputFile)}).parentFile.mkdirs()`,
    `    file(${JSON.stringify(outputFile)}).text = actual.join('\\n') + '\\n'`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function consumeMaven(plan, outputRoot) {
  const consumerRoot = path.join(outputRoot, "maven-consumer");
  const repositories = plan.products.map((product) =>
    path.join(ROOT, "target/release/maven-staging", `${product}-maven-dry-run`));
  for (const repository of repositories) {
    if (!existsSync(repository) || !statSync(repository).isDirectory()) {
      throw error(`missing exact extension Maven staging repository ${repository}`);
    }
  }
  const sourceArtifacts = new Map();
  for (const coordinate of plan.maven.expectedCoordinates) {
    const { group, artifact, version } = mavenParts(coordinate);
    const product = plan.products.find((candidate) => artifact.startsWith(`${candidate}-`));
    if (product === undefined) throw error(`cannot map Maven coordinate ${coordinate} to its selected product`);
    const file = path.join(
      ROOT,
      "target/release/maven-staging",
      `${product}-maven-dry-run`,
      ...group.split("."),
      artifact,
      version,
      `${artifact}-${version}.tar.gz`,
    );
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw error(`missing exact Maven carrier ${coordinate}: ${file}`);
    }
    sourceArtifacts.set(coordinate, file);
  }
  rmSync(consumerRoot, { recursive: true, force: true });
  mkdirSync(consumerRoot, { recursive: true });
  const resolutionFile = path.join(consumerRoot, "resolved.tsv");
  writeFileSync(path.join(consumerRoot, "settings.gradle"), "rootProject.name = 'oliphaunt-external-extension-consumer'\n");
  writeFileSync(path.join(consumerRoot, "build.gradle"), renderExactMavenConsumer({
    repositories,
    coordinates: plan.maven.expectedCoordinates,
    outputFile: resolutionFile,
  }));
  run("src/sdks/kotlin/gradlew", [
    "-p", consumerRoot,
    "resolveExactCandidates",
    "--refresh-dependencies",
    "--no-configuration-cache",
    "--no-daemon",
    "--project-cache-dir", path.join(consumerRoot, ".gradle-project"),
  ], { timeout: 30 * 60_000 });
  const rows = readFileSync(resolutionFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [coordinate, file] = line.split("\t");
    const source = sourceArtifacts.get(coordinate);
    if (source === undefined || !existsSync(file) || sha256File(file) !== sha256File(source)) {
      throw error(`${coordinate} resolved Maven bytes differ from its exact local staging carrier`);
    }
    return { coordinate, sha256: sha256File(file), bytes: statSync(file).size };
  });
  const actual = rows.map(({ coordinate }) => coordinate).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(plan.maven.expectedCoordinates)) {
    throw error(`Maven consumer carrier coverage mismatch: expected=${JSON.stringify(plan.maven.expectedCoordinates)}, actual=${JSON.stringify(actual)}`);
  }
  return rows.sort((left, right) => compareText(left.coordinate, right.coordinate));
}

export async function runExternalExtensionRegistryConsumerProof(products, {
  outputRoot = DEFAULT_OUTPUT_ROOT,
  verdaccioPort = process.env.OLIPHAUNT_EXTENSION_CONSUMER_VERDACCIO_PORT ?? DEFAULT_VERDACCIO_PORT,
} = {}) {
  const plan = externalExtensionConsumerPlan(products);
  const output = path.resolve(outputRoot);
  if (plan.products.length === 0) {
    rmSync(output, { recursive: true, force: true });
    return null;
  }
  const npmRuntime = resolveVerifiedNpmPublisherRuntime();
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const cargo = publishExactCargoRegistry(plan, output);
  const npm = publishAndConsumeNpm(plan, output, verdaccioPort, npmRuntime);
  const maven = consumeMaven(plan, output);
  const evidence = {
    schema: "oliphaunt-external-extension-registry-consumer-v1",
    products: plan.products,
    cargo,
    npm,
    maven,
  };
  writeFileSync(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `Exact external-extension consumers resolved ${cargo.installed.length} Cargo, `
      + `${plan.npm.expectedPackages.length} npm, and ${maven.length} Maven carriers for ${plan.products.length} products.`,
  );
  return evidence;
}
