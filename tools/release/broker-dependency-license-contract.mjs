#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { requireSafeDirectoryChain as requireReleaseDirectoryChain } from "./release-directory-safety.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import { assertReleaseNoticesInEntries } from "./release-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "broker-dependency-license-contract.mjs";
const CONTRACT_PATH = path.join(ROOT, "src/runtimes/broker/dependency-licenses.json");
const BLOB_ROOT = path.join(ROOT, "src/runtimes/broker/dependency-license-blobs");
const CARGO_LOCK_PATH = path.join(ROOT, "Cargo.lock");
const CARGO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const CONTRACT_SCHEMA = "oliphaunt-broker-dependency-license-contract-v1";
const INDEX_SCHEMA = "oliphaunt-broker-target-dependency-license-index-v1";

export const BROKER_DEPENDENCY_LICENSE_ROOT = "THIRD_PARTY_LICENSES/rust";
export const BROKER_PAYLOAD_LICENSE =
  "MIT AND Apache-2.0 AND BSD-3-Clause AND CC-BY-3.0 AND ISC AND Unicode-3.0";
// Cargo fetches every target's locked dependency closure when --target is
// omitted. Keep this exact command centralized: using the host target here
// would leave the Windows/macOS/Linux conditional graph only partly cached.
export const BROKER_DEPENDENCY_LICENSE_FETCH_ARGS = Object.freeze(["fetch", "--locked"]);

const TARGET_ROWS = Object.freeze([
  Object.freeze({ id: "linux-x64-gnu", cargoTarget: "x86_64-unknown-linux-gnu" }),
  Object.freeze({ id: "linux-arm64-gnu", cargoTarget: "aarch64-unknown-linux-gnu" }),
  Object.freeze({ id: "macos-arm64", cargoTarget: "aarch64-apple-darwin" }),
  Object.freeze({ id: "windows-x64-msvc", cargoTarget: "x86_64-pc-windows-msvc" }),
]);
const TARGET_IDS = Object.freeze(TARGET_ROWS.map(({ id }) => id));
const TARGET_BY_ID = new Map(TARGET_ROWS.map((row) => [row.id, row]));
const PAYLOAD_LICENSE_ATOMS = Object.freeze([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "CC-BY-3.0",
  "ISC",
  "Unicode-3.0",
]);
const PATH_PACKAGE_MANIFESTS = new Map([
  ["oliphaunt", path.join(ROOT, "src/sdks/rust/Cargo.toml")],
  ["oliphaunt-broker", path.join(ROOT, "src/runtimes/broker/Cargo.toml")],
]);
const LEGAL_BASENAME_PREFIXES = Object.freeze([
  "acknowledg",
  "authors",
  "copying",
  "copyright",
  "credits",
  "legal",
  "license",
  "notice",
  "patents",
  "unlicense",
]);
const LEGAL_BASENAME_FRAGMENTS = Object.freeze(["third-party", "third_party", "thirdparty"]);
const HEX_64 = /^[0-9a-f]{64}$/u;
const PACKAGE_KEY = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[^\s/\\]+$/u;
const SAFE_MEMBER = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f])[^/]+(?:\/[^/]+)*$/u;

let validatedDefaultContract;
let auditedDefaultContract;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderBase64(bytes) {
  return `${bytes.toString("base64").match(/.{1,76}/gu)?.join("\n") ?? ""}\n`;
}

function canonicalBlobBytes(digest, expectedBytes) {
  const file = path.join(BLOB_ROOT, `${digest}.base64`);
  requireRealFile(file, "canonical broker dependency license blob");
  const encoded = readFileSync(file, "utf8");
  if (!/^(?:[A-Za-z0-9+/=]{1,76}\n)+$/u.test(encoded)) {
    fail(`canonical broker dependency license blob is not wrapped base64 text: ${file}`);
  }
  const content = Buffer.from(encoded.replaceAll("\n", ""), "base64");
  if (
    content.length !== expectedBytes
    || sha256(content) !== digest
    || encoded !== renderBase64(content)
  ) {
    fail(`canonical broker dependency license blob does not match ${digest}/${expectedBytes}: ${file}`);
  }
  return content;
}

function packageKey(row) {
  return `${row.name}@${row.version}`;
}

export function isAllowedBrokerPathPackageMetadataRow(row) {
  if (
    !row
    || typeof row !== "object"
    || row.source !== null
    || typeof row.name !== "string"
    || typeof row.version !== "string"
    || row.version.length === 0
    || typeof row.manifest_path !== "string"
  ) {
    return false;
  }
  const expectedManifest = PATH_PACKAGE_MANIFESTS.get(row.name);
  return expectedManifest !== undefined && path.resolve(row.manifest_path) === expectedManifest;
}

function sameStrings(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (!sameStrings(actual, expected)) {
    fail(`${label} keys must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function hasCanonicalBrokerFilesystemMode(mode, expectedMode, platform = process.platform) {
  // Windows exposes synthetic Unix permission bits through stat(2). chmod can
  // toggle the read-only attribute, but it cannot establish meaningful 0644
  // or 0755 filesystem metadata. Published archives still carry and validate
  // their explicit portable modes in assertBrokerDependencyLicensesInEntries.
  return platform === "win32" || (mode & 0o777) === expectedMode;
}

function requireRealFile(file, label, expectedMode = 0o644) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${file}: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file: ${file}`);
  }
  if (!hasCanonicalBrokerFilesystemMode(stat.mode, expectedMode)) {
    fail(`${label} must have mode 0${expectedMode.toString(8)}: ${file}`);
  }
  return stat;
}

function requireRealDirectory(directory, label) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${directory}: ${cause.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real non-symlink directory: ${directory}`);
  }
  return stat;
}

function ensureSafeDirectoryChain(directory, label) {
  try {
    return requireReleaseDirectoryChain(directory, { create: true, label });
  } catch (cause) {
    fail(cause.message);
  }
}

function requireSafeDirectoryChain(directory, label) {
  try {
    return requireReleaseDirectoryChain(directory, { label });
  } catch (cause) {
    fail(cause.message);
  }
}

function safeMember(value, label) {
  if (typeof value !== "string" || !SAFE_MEMBER.test(value)) {
    fail(`${label} is not a safe portable member path: ${JSON.stringify(value)}`);
  }
  return value;
}

function targetRow(target) {
  const row = TARGET_BY_ID.get(target);
  if (!row) {
    fail(`unsupported broker target ${JSON.stringify(target)}; expected ${TARGET_IDS.join(", ")}`);
  }
  return row;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function legalSourceFile(relative) {
  const basename = path.posix.basename(relative).toLowerCase();
  return LEGAL_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))
    || LEGAL_BASENAME_FRAGMENTS.some((fragment) => basename.includes(fragment));
}

function walkRegularFiles(root, relative = "") {
  const files = [];
  for (const name of readdirSync(path.join(root, ...relative.split("/").filter(Boolean))).sort(compareText)) {
    const member = relative ? `${relative}/${name}` : name;
    const file = path.join(root, ...member.split("/"));
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      fail(`source dependency legal inventory contains a symlink: ${file}`);
    }
    if (stat.isDirectory()) {
      files.push(...walkRegularFiles(root, member));
    } else if (stat.isFile()) {
      files.push(member);
    }
  }
  return files;
}

function runCargo(args, label, {
  cargoHome,
  offline = true,
  captureCargoCommand = captureCommandOutput,
} = {}) {
  const checkedCargoHome = cargoHome === undefined
    ? undefined
    : requireSafeDirectoryChain(cargoHome, "broker dependency audit Cargo home");
  const result = captureCargoCommand("cargo", args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(checkedCargoHome === undefined ? {} : { CARGO_HOME: checkedCargoHome }),
      CARGO_NET_OFFLINE: offline ? "true" : "false",
    },
    label,
    maxOutputBytes: 128 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function cargoMetadata({ cargoHome } = {}) {
  let metadata;
  try {
    metadata = JSON.parse(runCargo([
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
    ], "cargo metadata", { cargoHome }));
  } catch (cause) {
    fail(`cargo metadata output is invalid: ${cause.message}`);
  }
  return metadata;
}

function cargoTreePackageKeys(cargoTarget, metadataPackages, { cargoHome } = {}) {
  const output = runCargo([
    "tree",
    "-p",
    "oliphaunt-broker",
    "--locked",
    "--offline",
    "-e",
    "normal",
    "--target",
    cargoTarget,
    "--prefix",
    "none",
    "--format",
    "{p}",
  ], `cargo tree for ${cargoTarget}`, { cargoHome });
  const keys = new Set();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(/ \(\*\)$/u, "").trim();
    if (!line) continue;
    const match = /^([^\s]+) v([^\s]+)/u.exec(line);
    if (!match) {
      fail(`cannot parse cargo tree package line for ${cargoTarget}: ${JSON.stringify(rawLine)}`);
    }
    const key = `${match[1]}@${match[2]}`;
    const candidates = metadataPackages.get(key) ?? [];
    if (candidates.length === 0) {
      fail(`cargo tree package ${key} is absent from cargo metadata`);
    }
    const registry = candidates.filter((row) => row.source === CARGO_SOURCE);
    if (registry.length === 1) {
      keys.add(key);
      continue;
    }
    if (registry.length > 1) {
      fail(`cargo metadata has duplicate crates.io identities for ${key}`);
    }
    const pathPackages = candidates.filter(isAllowedBrokerPathPackageMetadataRow);
    if (pathPackages.length !== 1) {
      fail(`broker graph contains unsupported non-crates.io dependency ${key}`);
    }
  }
  return [...keys].sort(compareText);
}

function payloadLicenseAtoms(selectedLicense) {
  const atoms = selectedLicense.split(" AND ");
  if (atoms.length === 0 || atoms.some((atom) => !PAYLOAD_LICENSE_ATOMS.includes(atom))) {
    fail(`unsupported selected license expression ${JSON.stringify(selectedLicense)}`);
  }
  return atoms;
}

function selectedLicenseIsCompatible(row) {
  for (const atom of payloadLicenseAtoms(row.selectedLicense)) {
    if (atom === "CC-BY-3.0") {
      if (!row.licenseFiles.some(({ name }) => LEGAL_BASENAME_FRAGMENTS.some((fragment) => name.toLowerCase().includes(fragment)))) {
        fail(`${packageKey(row)} selects CC-BY-3.0 without an exact third-party attribution file`);
      }
    } else if (atom === "BSD-3-Clause") {
      if (!row.licenseFiles.some(({ name }) => name.toLowerCase().includes("bsd") || name === "zstd/LICENSE")) {
        fail(`${packageKey(row)} selects BSD-3-Clause without an exact BSD license file`);
      }
    } else if (atom === "Unicode-3.0") {
      if (!row.declaredLicense.includes("Unicode-3.0")) {
        fail(`${packageKey(row)} selects Unicode-3.0 but its declared license does not`);
      }
    } else if (!row.declaredLicense.includes(atom)) {
      fail(`${packageKey(row)} selects ${atom} but declares ${row.declaredLicense}`);
    }
  }
}

function validateContractShape(contract, contractBytes) {
  exactObjectKeys(contract, [
    "schema",
    "product",
    "cargoSource",
    "payloadLicense",
    "targets",
    "packages",
  ], "broker dependency license contract");
  if (contract.schema !== CONTRACT_SCHEMA) fail(`contract schema must be ${CONTRACT_SCHEMA}`);
  if (contract.product !== "oliphaunt-broker") fail("contract product must be oliphaunt-broker");
  if (contract.cargoSource !== CARGO_SOURCE) fail(`contract cargoSource must be ${CARGO_SOURCE}`);
  if (contract.payloadLicense !== BROKER_PAYLOAD_LICENSE) {
    fail(`contract payloadLicense must be ${BROKER_PAYLOAD_LICENSE}`);
  }
  if (!Array.isArray(contract.packages) || contract.packages.length === 0) {
    fail("contract packages must be a non-empty array");
  }
  exactObjectKeys(contract.targets, TARGET_IDS, "contract targets");

  const packages = new Map();
  const actualPackageOrder = [];
  const selectedAtoms = new Set();
  for (const row of contract.packages) {
    exactObjectKeys(row, [
      "name",
      "version",
      "checksum",
      "declaredLicense",
      "selectedLicense",
      "targets",
      "licenseFiles",
    ], "contract package");
    const key = packageKey(row);
    if (!PACKAGE_KEY.test(key)) fail(`invalid contract package identity ${JSON.stringify(key)}`);
    if (packages.has(key)) fail(`duplicate contract package ${key}`);
    if (!HEX_64.test(row.checksum)) fail(`${key} has invalid Cargo checksum`);
    if (typeof row.declaredLicense !== "string" || !row.declaredLicense) fail(`${key} has no declaredLicense`);
    if (typeof row.selectedLicense !== "string" || !row.selectedLicense) fail(`${key} has no selectedLicense`);
    selectedLicenseIsCompatible(row);
    for (const atom of payloadLicenseAtoms(row.selectedLicense)) selectedAtoms.add(atom);
    if (
      !Array.isArray(row.targets)
      || row.targets.length === 0
      || !sameStrings(row.targets, [...new Set(row.targets)].sort(compareText))
      || row.targets.some((target) => !TARGET_BY_ID.has(target))
    ) {
      fail(`${key} targets must be a sorted, unique, non-empty supported-target list`);
    }
    if (!Array.isArray(row.licenseFiles) || row.licenseFiles.length === 0) {
      fail(`${key} must pin at least one legal source file`);
    }
    const legalNames = [];
    for (const file of row.licenseFiles) {
      exactObjectKeys(file, ["name", "sha256", "bytes"], `${key} legal file`);
      safeMember(file.name, `${key} legal file name`);
      if (!legalSourceFile(file.name)) {
        fail(`${key} legal file does not match the fail-closed legal-file classifier: ${file.name}`);
      }
      if (!HEX_64.test(file.sha256)) fail(`${key} ${file.name} has invalid sha256`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) fail(`${key} ${file.name} has invalid byte count`);
      legalNames.push(file.name);
    }
    if (!sameStrings(legalNames, [...new Set(legalNames)].sort(compareText))) {
      fail(`${key} legal files must be sorted and unique by source member`);
    }
    packages.set(key, row);
    actualPackageOrder.push(key);
  }
  if (!sameStrings(actualPackageOrder, [...actualPackageOrder].sort(compareText))) {
    fail("contract packages must be sorted by name@version");
  }
  if (!sameStrings([...selectedAtoms].sort(compareText), [...PAYLOAD_LICENSE_ATOMS].sort(compareText))) {
    fail(
      `contract selected-license closure must be ${PAYLOAD_LICENSE_ATOMS.join(", ")}, got ${[...selectedAtoms].sort(compareText).join(", ")}`,
    );
  }

  for (const target of TARGET_IDS) {
    const row = contract.targets[target];
    exactObjectKeys(row, ["cargoTarget", "packages"], `contract target ${target}`);
    if (row.cargoTarget !== targetRow(target).cargoTarget) {
      fail(`${target} cargoTarget must be ${targetRow(target).cargoTarget}`);
    }
    if (
      !Array.isArray(row.packages)
      || row.packages.length === 0
      || !sameStrings(row.packages, [...new Set(row.packages)].sort(compareText))
    ) {
      fail(`${target} packages must be a sorted, unique, non-empty list`);
    }
    for (const key of row.packages) {
      if (!packages.has(key)) fail(`${target} references unknown package ${key}`);
      if (!packages.get(key).targets.includes(target)) fail(`${key} does not claim target ${target}`);
    }
    const reverse = contract.packages.filter((pkg) => pkg.targets.includes(target)).map(packageKey);
    if (!sameStrings(row.packages, reverse)) {
      fail(`${target} package graph and package target claims disagree`);
    }
  }

  const canonical = Buffer.from(canonicalJson(contract));
  if (!contractBytes.equals(canonical)) {
    fail("dependency-licenses.json must be canonical two-space JSON with one trailing newline");
  }
  return packages;
}

function validateCanonicalBlobs(contract) {
  requireRealDirectory(BLOB_ROOT, "broker dependency license blob root");
  const expected = new Map();
  for (const row of contract.packages) {
    for (const legal of row.licenseFiles) {
      const prior = expected.get(legal.sha256);
      if (prior !== undefined && prior !== legal.bytes) {
        fail(`license digest ${legal.sha256} has inconsistent byte counts`);
      }
      expected.set(legal.sha256, legal.bytes);
    }
  }
  const actualNames = readdirSync(BLOB_ROOT).sort(compareText);
  const expectedNames = [...expected.keys()].sort(compareText).map((digest) => `${digest}.base64`);
  if (!sameStrings(actualNames, expectedNames)) {
    fail(`canonical broker dependency license blobs differ: expected=${JSON.stringify(expectedNames)}, actual=${JSON.stringify(actualNames)}`);
  }
  for (const [digest, bytes] of expected) {
    canonicalBlobBytes(digest, bytes);
  }
}

function validateLockIdentity(packages) {
  let lock;
  try {
    lock = Bun.TOML.parse(readFileSync(CARGO_LOCK_PATH, "utf8"));
  } catch (cause) {
    fail(`cannot parse Cargo.lock: ${cause.message}`);
  }
  const lockRows = new Map();
  for (const row of lock?.package ?? []) {
    const key = packageKey(row);
    if (!row.source) continue;
    if (lockRows.has(key)) fail(`Cargo.lock contains ambiguous package identity ${key}`);
    lockRows.set(key, row);
  }
  for (const [key, row] of packages) {
    const locked = lockRows.get(key);
    if (!locked) fail(`Cargo.lock is missing contracted broker dependency ${key}`);
    if (locked.source !== CARGO_SOURCE || locked.checksum !== row.checksum) {
      fail(
        `Cargo.lock identity changed for ${key}: expected ${CARGO_SOURCE}/${row.checksum}, got ${locked.source}/${locked.checksum}`,
      );
    }
  }
}

function validateGraph(contract, packages, { cargoHome } = {}) {
  const metadata = cargoMetadata({ cargoHome });
  const metadataPackages = new Map();
  for (const row of metadata.packages ?? []) {
    const key = packageKey(row);
    const values = metadataPackages.get(key) ?? [];
    values.push(row);
    metadataPackages.set(key, values);
  }
  for (const [key, row] of packages) {
    const matches = (metadataPackages.get(key) ?? []).filter((candidate) => candidate.source === CARGO_SOURCE);
    if (matches.length !== 1) {
      fail(`cargo metadata must contain exactly one crates.io package for ${key}, got ${matches.length}`);
    }
    const metadataRow = matches[0];
    if (metadataRow.license !== row.declaredLicense) {
      fail(`${key} declared license changed: expected ${row.declaredLicense}, got ${metadataRow.license}`);
    }
    const sourceRoot = path.dirname(metadataRow.manifest_path);
    requireRealDirectory(sourceRoot, `${key} Cargo source directory`);
    const legalFiles = walkRegularFiles(sourceRoot).filter(legalSourceFile).sort(compareText);
    const contracted = row.licenseFiles.map(({ name }) => name);
    if (!sameStrings(legalFiles, contracted)) {
      fail(
        `${key} legal source inventory changed: expected=${JSON.stringify(contracted)}, actual=${JSON.stringify(legalFiles)}`,
      );
    }
    for (const legal of row.licenseFiles) {
      const file = path.join(sourceRoot, ...legal.name.split("/"));
      const content = readFileSync(file);
      if (content.length !== legal.bytes || sha256(content) !== legal.sha256) {
        fail(`${key} legal source file changed: ${legal.name}`);
      }
    }
  }

  for (const target of TARGET_IDS) {
    const actual = cargoTreePackageKeys(
      contract.targets[target].cargoTarget,
      metadataPackages,
      { cargoHome },
    );
    const expected = contract.targets[target].packages;
    if (!sameStrings(actual, expected)) {
      fail(
        `${target} exact normal dependency graph changed: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
      );
    }
  }
}

export function loadBrokerDependencyLicenseContract({
  contractPath = CONTRACT_PATH,
  auditLock = false,
  auditGraph = false,
  cargoHome,
} = {}) {
  const resolvedContractPath = path.resolve(contractPath);
  const cacheable = resolvedContractPath === CONTRACT_PATH && cargoHome === undefined;
  if (cacheable) {
    if (auditGraph && auditedDefaultContract !== undefined) return auditedDefaultContract;
    if (!auditGraph && !auditLock && validatedDefaultContract !== undefined) return validatedDefaultContract;
  }
  requireRealFile(resolvedContractPath, "broker dependency license contract");
  const bytes = readFileSync(resolvedContractPath);
  let contract;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    fail(`cannot parse ${resolvedContractPath}: ${cause.message}`);
  }
  const packages = validateContractShape(contract, bytes);
  validateCanonicalBlobs(contract);
  if (auditLock || auditGraph) validateLockIdentity(packages);
  if (auditGraph) validateGraph(contract, packages, { cargoHome });
  const result = Object.freeze({ contract, packages, contractPath: resolvedContractPath });
  if (cacheable) {
    validatedDefaultContract = result;
    if (auditGraph) auditedDefaultContract = result;
  }
  return result;
}

/**
 * Run the connected production audit in a brand-new Cargo home. The fetch is
 * deliberately online and target-neutral; every subsequent graph/source read
 * is locked and offline in that same home. This proves the audit is complete
 * without borrowing registry sources from a developer or runner cache.
 */
export function auditBrokerDependencyLicenseContract({
  contractPath = CONTRACT_PATH,
  temporaryRoot = tmpdir(),
  captureCargoCommand = captureCommandOutput,
  verifyContract,
} = {}) {
  const checkedTemporaryRoot = requireSafeDirectoryChain(
    temporaryRoot,
    "broker dependency audit temporary root",
  );
  const cargoHome = mkdtempSync(path.join(checkedTemporaryRoot, "oliphaunt-broker-cargo-home-"));
  chmodSync(cargoHome, 0o700);
  try {
    runCargo(
      BROKER_DEPENDENCY_LICENSE_FETCH_ARGS,
      "locked all-target Cargo dependency prefetch",
      { cargoHome, offline: false, captureCargoCommand },
    );
    const verify = verifyContract ?? ((options) => loadBrokerDependencyLicenseContract(options));
    return verify({
      contractPath,
      auditGraph: true,
      cargoHome,
    });
  } finally {
    rmSync(cargoHome, { recursive: true, force: true });
  }
}

function targetPackages(contractState, target) {
  const targetContract = contractState.contract.targets[target];
  return targetContract.packages.map((key) => contractState.packages.get(key));
}

function targetBlobMembers(contractState, target) {
  const digests = [...new Set(
    targetPackages(contractState, target)
      .flatMap((row) => row.licenseFiles.map(({ sha256: digest }) => digest)),
  )].sort(compareText);
  return new Map(digests.map((digest, index) => [digest, `licenses/${String(index).padStart(3, "0")}.txt`]));
}

function renderedTargetIndex(contractState, target) {
  const targetContract = contractState.contract.targets[target];
  const blobMembers = targetBlobMembers(contractState, target);
  return {
    schema: INDEX_SCHEMA,
    product: "oliphaunt-broker",
    target,
    cargoTarget: targetContract.cargoTarget,
    payloadLicense: BROKER_PAYLOAD_LICENSE,
    packages: targetPackages(contractState, target).map((row) => ({
      name: row.name,
      version: row.version,
      checksum: row.checksum,
      declaredLicense: row.declaredLicense,
      selectedLicense: row.selectedLicense,
      licenseFiles: row.licenseFiles.map((legal) => ({
        name: legal.name,
        sha256: legal.sha256,
        bytes: legal.bytes,
        member: blobMembers.get(legal.sha256),
      })),
    })),
  };
}

function targetExpectedFiles(contractState, target) {
  const files = new Map();
  const blobMembers = targetBlobMembers(contractState, target);
  files.set(`${BROKER_DEPENDENCY_LICENSE_ROOT}/DEPENDENCIES.json`, Buffer.from(canonicalJson(renderedTargetIndex(contractState, target))));
  for (const row of targetPackages(contractState, target)) {
    for (const legal of row.licenseFiles) {
      files.set(
        `${BROKER_DEPENDENCY_LICENSE_ROOT}/${blobMembers.get(legal.sha256)}`,
        canonicalBlobBytes(legal.sha256, legal.bytes),
      );
    }
  }
  return new Map([...files].sort(([left], [right]) => compareText(left, right)));
}

export function brokerDependencyLicenseMembers(target, { prefix = "" } = {}) {
  targetRow(target);
  const state = loadBrokerDependencyLicenseContract();
  const checkedPrefix = prefix ? safeMember(prefix.replace(/\/$/u, ""), "broker dependency archive prefix") : "";
  return [...targetExpectedFiles(state, target).keys()].map((member) => checkedPrefix ? `${checkedPrefix}/${member}` : member);
}

function expectedDirectories(expectedFiles) {
  const directories = new Set();
  for (const member of expectedFiles.keys()) {
    const parts = member.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return directories;
}

export function normalizeBrokerDependencyLicenseModes(destination, target) {
  targetRow(target);
  const state = loadBrokerDependencyLicenseContract();
  const root = requireSafeDirectoryChain(destination, "broker dependency license carrier root");
  const expected = targetExpectedFiles(state, target);
  for (const member of expectedDirectories(expected)) {
    const directory = path.join(root, ...member.split("/"));
    requireRealDirectory(directory, `broker dependency license directory ${member}`);
    chmodSync(directory, 0o755);
  }
  for (const member of expected.keys()) {
    const file = path.join(root, ...member.split("/"));
    let stat;
    try {
      stat = lstatSync(file);
    } catch (cause) {
      fail(`broker dependency license member cannot be inspected: ${member}: ${cause.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`broker dependency license member must be a regular non-symlink file: ${member}`);
    }
    chmodSync(file, 0o644);
  }
}

export function stageBrokerDependencyLicenses(destination, target) {
  targetRow(target);
  const state = loadBrokerDependencyLicenseContract();
  const root = ensureSafeDirectoryChain(destination, "broker dependency license staging root");
  const dependencyRoot = path.join(root, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"));
  // Validate the namespace ancestor before even inspecting the owned leaf.
  // rmSync on a leaf beneath a symlinked THIRD_PARTY_LICENSES directory could
  // otherwise remove data outside the carrier stage.
  ensureSafeDirectoryChain(path.dirname(dependencyRoot), "broker dependency license namespace parent");
  let prior;
  try {
    prior = lstatSync(dependencyRoot);
  } catch (cause) {
    if (cause?.code !== "ENOENT") fail(`cannot inspect prior broker dependency license root: ${cause.message}`);
  }
  if (prior) {
    if (!prior.isDirectory() || prior.isSymbolicLink()) {
      fail(`prior broker dependency license root must be a real directory: ${dependencyRoot}`);
    }
    rmSync(dependencyRoot, { recursive: true });
  }
  ensureSafeDirectoryChain(path.join(dependencyRoot, "licenses"), "broker dependency license staging root");
  for (const [member, bytes] of targetExpectedFiles(state, target)) {
    const file = path.join(root, ...member.split("/"));
    ensureSafeDirectoryChain(path.dirname(file), "broker dependency license staging parent");
    writeFileSync(file, bytes);
    chmodSync(file, 0o644);
  }
  normalizeBrokerDependencyLicenseModes(root, target);
  assertBrokerDependencyLicensesInDirectory(root, { target });
  return brokerDependencyLicenseMembers(target);
}

function directoryNamespaceEntries(root) {
  const namespace = path.join(root, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"));
  requireSafeDirectoryChain(namespace, "broker dependency license namespace");
  const entries = new Map();
  function walk(directory, relative) {
    for (const name of readdirSync(directory).sort(compareText)) {
      const file = path.join(directory, name);
      const member = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(file);
      entries.set(`${BROKER_DEPENDENCY_LICENSE_ROOT}/${member}`, { file, stat });
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file, member);
    }
  }
  walk(namespace, "");
  return entries;
}

export function assertBrokerDependencyLicensesInDirectory(directory, { target } = {}) {
  targetRow(target);
  const state = loadBrokerDependencyLicenseContract();
  const root = requireSafeDirectoryChain(directory, "broker dependency license carrier root");
  const expected = targetExpectedFiles(state, target);
  const expectedDirs = expectedDirectories(expected);
  const actual = directoryNamespaceEntries(root);
  const expectedMembers = new Set([...expected.keys(), ...expectedDirs]);
  for (const member of expectedMembers) {
    if (member === "THIRD_PARTY_LICENSES" || member === BROKER_DEPENDENCY_LICENSE_ROOT) continue;
    const entry = actual.get(member);
    if (!entry) fail(`broker dependency license carrier is missing ${member}`);
    if (expected.has(member)) {
      if (!entry.stat.isFile() || entry.stat.isSymbolicLink()) fail(`${member} must be a regular non-symlink file`);
      if (!hasCanonicalBrokerFilesystemMode(entry.stat.mode, 0o644)) fail(`${member} must have mode 0644`);
      if (!readFileSync(entry.file).equals(expected.get(member))) fail(`${member} differs from the canonical dependency license bytes`);
    } else {
      if (!entry.stat.isDirectory() || entry.stat.isSymbolicLink()) fail(`${member} must be a real non-symlink directory`);
      if (!hasCanonicalBrokerFilesystemMode(entry.stat.mode, 0o755)) fail(`${member} must have mode 0755`);
    }
  }
  for (const member of actual.keys()) {
    if (!expectedMembers.has(member)) fail(`broker dependency license carrier has unexpected member ${member}`);
  }
  return [...expected.keys()];
}

function checkedArchivePrefix(prefix) {
  if (prefix === "") return "";
  return safeMember(String(prefix).replace(/^\.\//u, "").replace(/\/$/u, ""), "broker dependency archive prefix");
}

export function assertBrokerDependencyLicensesInEntries(entries, { target, prefix = "", label = "archive" } = {}) {
  targetRow(target);
  if (!(entries instanceof Map)) fail("broker dependency archive entries must be a Map");
  const state = loadBrokerDependencyLicenseContract();
  const archivePrefix = checkedArchivePrefix(prefix);
  const localExpected = targetExpectedFiles(state, target);
  const localDirs = expectedDirectories(localExpected);
  const prefixed = (member) => archivePrefix ? `${archivePrefix}/${member}` : member;
  const expectedFiles = new Map([...localExpected].map(([member, bytes]) => [prefixed(member), bytes]));
  const expectedDirs = new Set([...localDirs].map(prefixed));
  const namespace = `${prefixed(BROKER_DEPENDENCY_LICENSE_ROOT)}/`;
  for (const [member, bytes] of expectedFiles) {
    const entry = entries.get(member);
    if (!entry?.isFile || entry.isSymbolicLink) fail(`${label} is missing regular dependency license member ${member}`);
    if ((entry.mode & 0o777) !== 0o644) fail(`${label} dependency license member ${member} must have mode 0644`);
    if (!Buffer.from(entry.data()).equals(bytes)) fail(`${label} dependency license member ${member} differs from canonical bytes`);
  }
  for (const [member, entry] of entries) {
    if (expectedFiles.has(member)) continue;
    if (expectedDirs.has(member)) {
      if (!entry.isDirectory || entry.isSymbolicLink) fail(`${label} dependency license directory ${member} must be a real directory`);
      if ((entry.mode & 0o777) !== 0o755) fail(`${label} dependency license directory ${member} must have mode 0755`);
      continue;
    }
    if (member !== prefixed(BROKER_DEPENDENCY_LICENSE_ROOT) && !member.startsWith(namespace)) continue;
    fail(`${label} contains unexpected dependency license member ${member}`);
  }
  assertReleaseNoticesInEntries(entries, {
    profile: "broker",
    prefix: archivePrefix,
    exact: false,
    label,
  });
  return [...expectedFiles.keys()];
}

export function assertBrokerDependencyLicensesInArchive(file, options = {}) {
  const archive = path.resolve(file);
  return assertBrokerDependencyLicensesInEntries(readPortableArchiveEntries(archive), {
    ...options,
    label: options.label ?? path.basename(archive),
  });
}

function usage() {
  return [
    "usage:",
    `  ${TOOL} check-contract`,
    `  ${TOOL} audit-contract`,
    `  ${TOOL} stage <directory> --target <${TARGET_IDS.join("|")}>`,
    `  ${TOOL} check-directory <directory> --target <${TARGET_IDS.join("|")}>`,
    `  ${TOOL} check-archive <archive> --target <${TARGET_IDS.join("|")}> [--prefix <member-prefix>]`,
  ].join("\n");
}

function parseCli(argv) {
  const values = [...argv];
  const command = values.shift();
  if (["check-contract", "audit-contract"].includes(command)) {
    if (values.length > 0) fail(usage());
    return { command };
  }
  if (!["stage", "check-directory", "check-archive"].includes(command)) fail(usage());
  const subject = values.shift();
  if (!subject) fail(usage());
  let target;
  let prefix = "";
  while (values.length > 0) {
    const flag = values.shift();
    if (flag === "--target") {
      if (target !== undefined) fail("--target may be supplied only once");
      target = values.shift();
      if (!target) fail("--target requires a value");
    } else if (flag === "--prefix" && command === "check-archive") {
      if (prefix) fail("--prefix may be supplied only once");
      prefix = values.shift();
      if (prefix === undefined) fail("--prefix requires a value");
    } else {
      fail(`unsupported argument ${JSON.stringify(flag)}\n${usage()}`);
    }
  }
  targetRow(target);
  return { command, subject, target, prefix };
}

function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.command === "check-contract") {
      const state = loadBrokerDependencyLicenseContract();
      console.log(`${TOOL}: canonical self-contained license contract passed (${state.contract.packages.length} packages)`);
    } else if (args.command === "audit-contract") {
      const state = auditBrokerDependencyLicenseContract();
      console.log(`${TOOL}: clean-cache exact graph/source audit passed (${state.contract.packages.length} packages)`);
    } else if (args.command === "stage") {
      stageBrokerDependencyLicenses(args.subject, args.target);
      console.log(`${TOOL}: staged ${args.target} dependency licenses in ${args.subject}`);
    } else if (args.command === "check-directory") {
      assertBrokerDependencyLicensesInDirectory(args.subject, { target: args.target });
      console.log(`${TOOL}: checked ${args.target} dependency licenses in ${args.subject}`);
    } else {
      assertBrokerDependencyLicensesInArchive(args.subject, { target: args.target, prefix: args.prefix });
      console.log(`${TOOL}: checked ${args.target} dependency licenses in ${args.subject}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();
