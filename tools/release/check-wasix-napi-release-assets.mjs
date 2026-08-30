#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFileExists,
  checksumManifest,
  readArchiveEntries,
  sha256,
} from "./release-asset-validation.mjs";
import {
  ROOT,
  artifactTargets,
  compareText,
  currentProductVersion,
  exactExtensionProducts,
  expectedAssets,
  extensionSqlNames,
  extensionWasixAotMemberSqlNames,
  fail,
} from "./release-artifact-targets.mjs";
import { inspectPlatformBinaryEntries } from "./platform-binary-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  assertReleaseNoticesInEntries,
  releaseProfilePackageLicense,
} from "./release-notices.mjs";
import {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from "./windows-vc-runtime-closure.mjs";

const PREFIX = "check-wasix-napi-release-assets.mjs";
const PRODUCT = "oliphaunt-wasix-napi";
const KIND = "wasix-napi-addon";
const PROFILE = "wasix-napi-addon";
const PACKAGE_LICENSE = releaseProfilePackageLicense(PROFILE).spdx;
const BINARY = "oliphaunt_wasix_napi.node";
const PRODUCT_MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "src/runtimes/wasix-napi/package.json"), "utf8"),
);
const SHA256 = /^[0-9a-f]{64}$/u;

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, "target/oliphaunt-wasix-napi/release-assets"),
    allowPartial: false,
    npmPackages: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      const value = argv[index + 1];
      if (!value) fail(PREFIX, "--asset-dir requires a value");
      args.assetDir = path.resolve(value);
      index += 1;
    } else if (arg === "--allow-partial") {
      args.allowPartial = true;
    } else if (arg === "--npm-package") {
      const value = argv[index + 1];
      if (!value) fail(PREFIX, "--npm-package requires a value");
      args.npmPackages.push(path.resolve(value));
      index += 1;
    } else {
      fail(PREFIX, `unknown argument ${arg}`);
    }
  }
  return args;
}

function archiveJson(entries, member, label) {
  const entry = entries.get(member);
  if (!entry?.isFile || entry.isSymbolicLink) {
    throw new Error(`${label} is missing regular member ${member}`);
  }
  try {
    return JSON.parse(Buffer.from(entry.data()).toString("utf8"));
  } catch (cause) {
    throw new Error(`${label} member ${member} must contain valid JSON: ${cause.message}`);
  }
}

function entrySha256(entry) {
  return createHash("sha256").update(Buffer.from(entry.data())).digest("hex");
}

function assertSameStrings(actual, expected, label) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (
    actualSorted.length !== new Set(actualSorted).size
    || JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)
  ) {
    throw new Error(
      `${label} must be exactly ${expectedSorted.join(", ")}; got ${actualSorted.join(", ")}`,
    );
  }
}

function canonicalRepoPath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

function digestRecord(value, label, { expectedPath, pathPrefix, pathSuffix } = {}) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const recordPath = canonicalRepoPath(value.path, `${label} path`);
  if (
    (expectedPath !== undefined && recordPath !== expectedPath)
    || (pathPrefix !== undefined && !recordPath.startsWith(pathPrefix))
    || (pathSuffix !== undefined && !recordPath.endsWith(pathSuffix))
  ) {
    throw new Error(`${label} has incompatible path ${recordPath}`);
  }
  if (!SHA256.test(value.sha256 ?? "")) {
    throw new Error(`${label} must record a lowercase SHA-256 digest`);
  }
  return recordPath;
}

function assertBuildInputs(buildInputs, target, label) {
  if (
    buildInputs?.schema !== "oliphaunt-wasix-napi-build-inputs-v1"
    || buildInputs.target !== target.target
    || buildInputs.targetTriple !== target.triple
    || buildInputs.inputs === null
    || Array.isArray(buildInputs.inputs)
    || typeof buildInputs.inputs !== "object"
  ) {
    throw new Error(`${label} has incompatible embedded build-input provenance`);
  }
  const inputs = buildInputs.inputs;
  digestRecord(inputs.portableManifest, `${label} portable WASIX manifest`, {
    expectedPath: "target/oliphaunt-wasix/assets/manifest.json",
  });
  if (!Array.isArray(inputs.portableTools)) {
    throw new Error(`${label} portable tool inventory must be an array`);
  }
  assertSameStrings(
    inputs.portableTools.map((row) => row?.name),
    ["pg_dump", "psql"],
    `${label} portable tool inventory`,
  );
  for (const tool of inputs.portableTools) {
    digestRecord(tool, `${label} portable tool ${tool.name}`, {
      expectedPath: `target/oliphaunt-wasix/assets/bin/${tool.name}.wasix.wasm`,
    });
  }
  if (inputs.runtimeAotManifest?.targetTriple !== target.triple) {
    throw new Error(`${label} runtime AOT manifest must target ${target.triple}`);
  }
  digestRecord(inputs.runtimeAotManifest, `${label} runtime AOT manifest`, {
    expectedPath: `target/oliphaunt-wasix/aot/${target.triple}/manifest.json`,
  });
  if (!Array.isArray(inputs.extensionArtifacts)) {
    throw new Error(`${label} extension artifact inventory must be an array`);
  }
  const expectedProducts = exactExtensionProducts(PREFIX);
  assertSameStrings(
    inputs.extensionArtifacts.map((row) => row?.product),
    expectedProducts,
    `${label} extension product inventory`,
  );
  for (const extension of inputs.extensionArtifacts) {
    const product = extension.product;
    digestRecord(extension.manifest, `${label} ${product} extension manifest`, {
      pathPrefix: "target/extension-artifacts/",
      pathSuffix: "/extension-artifacts.json",
    });
    if (!Array.isArray(extension.portableArchives)) {
      throw new Error(`${label} ${product} portable extension inventory must be an array`);
    }
    assertSameStrings(
      extension.portableArchives.map((row) => row?.sqlName),
      extensionSqlNames(product, PREFIX),
      `${label} ${product} portable extension inventory`,
    );
    for (const archive of extension.portableArchives) {
      digestRecord(archive, `${label} ${product}/${archive.sqlName} portable extension`, {
        pathPrefix: "target/extension-artifacts/",
        pathSuffix: "-wasix-portable.tar.zst",
      });
    }
    if (!Array.isArray(extension.aotManifests)) {
      throw new Error(`${label} ${product} extension AOT inventory must be an array`);
    }
    assertSameStrings(
      extension.aotManifests.map((row) => row?.sqlName),
      extensionWasixAotMemberSqlNames(product, PREFIX),
      `${label} ${product} extension AOT inventory`,
    );
    for (const aot of extension.aotManifests) {
      if (aot?.targetTriple !== target.triple) {
        throw new Error(`${label} ${product}/${aot?.sqlName} AOT manifest must target ${target.triple}`);
      }
      digestRecord(aot, `${label} ${product}/${aot.sqlName} AOT manifest`, {
        pathPrefix: "target/extension-artifacts/",
        pathSuffix: "/manifest.json",
      });
    }
  }
  digestRecord(inputs.icuData, `${label} ICU data inventory`, {
    expectedPath: "target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu",
  });
  if (!Number.isSafeInteger(inputs.icuData.fileCount) || inputs.icuData.fileCount < 1) {
    throw new Error(`${label} ICU data inventory must record at least one regular file`);
  }
}

export function assertWasixNapiCarrierManifest(manifest, target, version, label = "carrier") {
  if (manifest.name !== target.npmPackage || manifest.version !== version) {
    throw new Error(`${label} must identify ${target.npmPackage}@${version}`);
  }
  if (manifest.license !== PACKAGE_LICENSE) {
    throw new Error(`${label} package license must be ${PACKAGE_LICENSE}, got ${JSON.stringify(manifest.license)}`);
  }
  if (
    manifest.oliphaunt?.target !== target.target
    || manifest.oliphaunt?.runtimeProduct !== PRODUCT_MANIFEST.oliphaunt.runtimeProduct
    || manifest.oliphaunt?.runtimeVersion !== PRODUCT_MANIFEST.oliphaunt.runtimeVersion
    || manifest.oliphaunt?.addonAbiVersion !== PRODUCT_MANIFEST.oliphaunt.addonAbiVersion
    || manifest.oliphaunt?.nodeApiVersion !== PRODUCT_MANIFEST.oliphaunt.nodeApiVersion
    || JSON.stringify(manifest.oliphaunt?.profiles) !== JSON.stringify(["standard", "icu"])
  ) {
    throw new Error(`${label} has incompatible WASIX Node-API target/runtime/ABI/profile metadata`);
  }
  if (
    JSON.stringify(manifest.os) !== JSON.stringify([target.npmOs])
    || JSON.stringify(manifest.cpu) !== JSON.stringify([target.npmCpu])
    || (target.npmLibc === undefined
      ? Object.hasOwn(manifest, "libc")
      : JSON.stringify(manifest.libc) !== JSON.stringify([target.npmLibc]))
    || manifest.optional !== true
    || manifest.type !== "commonjs"
    || Object.hasOwn(manifest, "scripts")
  ) {
    throw new Error(`${label} has incompatible npm platform or lifecycle metadata`);
  }
  const expectedFiles = [
    "prebuilds",
    "artifact-provenance.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
    "THIRD_PARTY_LICENSES",
  ];
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${label} must declare the exact one-addon package file surface`);
  }
  if (
    manifest.exports?.[`./${BINARY}`] !== `./prebuilds/${BINARY}`
    || JSON.stringify(Object.keys(manifest.exports ?? {}))
      !== JSON.stringify([`./${BINARY}`, "./artifact-provenance.json", "./package.json"])
  ) {
    throw new Error(`${label} must expose exactly one stable addon binary subpath`);
  }
  return manifest;
}

export function assertSingleWasixNapiAddonMember(entries, binaryMember, label = "carrier") {
  const nativeMembers = [...entries.keys()].filter((name) => name.endsWith(".node"));
  if (JSON.stringify(nativeMembers) !== JSON.stringify([binaryMember])) {
    throw new Error(
      `${label} must contain exactly one native addon member ${binaryMember}; got ${nativeMembers.join(", ")}`,
    );
  }
}

export function assertWasixNapiPlatformEntries(
  entries,
  { target, label = "carrier", prefix = "", binaryDirectory = "" },
) {
  inspectPlatformBinaryEntries(
    [...entries].map(([name, entry]) => ({ name, ...entry })),
    { target, rootLabel: label },
  );
  if (target !== "windows-x64-msvc") return;

  const sibling = (name) => [prefix, binaryDirectory, name].filter(Boolean).join("/");
  const runtimeNames = new Set(WINDOWS_VC_RUNTIME_DLLS);
  const actualRuntimeMembers = [...entries]
    .filter(([name, entry]) => entry?.isFile && runtimeNames.has(path.posix.basename(name).toLowerCase()))
    .map(([name]) => name)
    .sort(compareText);
  const expectedRuntimeMembers = WINDOWS_VC_RUNTIME_DLLS
    .filter((name) => entries.has(sibling(name)))
    .map((name) => sibling(name))
    .sort(compareText);
  if (JSON.stringify(actualRuntimeMembers) !== JSON.stringify(expectedRuntimeMembers)) {
    throw new Error(
      `${label} must place its exact app-local VC runtime closure beside ${sibling(BINARY)}`,
    );
  }

  const expectedReceiptMember = sibling(WINDOWS_VC_RUNTIME_RECEIPT);
  const actualReceiptMembers = [...entries.keys()]
    .filter((name) => path.posix.basename(name).toLowerCase() === WINDOWS_VC_RUNTIME_RECEIPT)
    .sort(compareText);
  const expectedReceiptMembers = expectedRuntimeMembers.length > 0 ? [expectedReceiptMember] : [];
  if (JSON.stringify(actualReceiptMembers) !== JSON.stringify(expectedReceiptMembers)) {
    throw new Error(`${label} must carry one VC runtime receipt beside its app-local closure`);
  }
  if (expectedRuntimeMembers.length === 0) return;

  const receipt = entries.get(expectedReceiptMember);
  if (!receipt?.isFile || receipt.isSymbolicLink) {
    throw new Error(`${label} is missing regular member ${expectedReceiptMember}`);
  }
  const expectedReceipt = expectedRuntimeMembers
    .map((member) => `${entrySha256(entries.get(member))}  ${path.posix.basename(member)}\n`)
    .join("");
  if (Buffer.from(receipt.data()).toString("utf8") !== expectedReceipt) {
    throw new Error(`${label} ${expectedReceiptMember} does not bind its exact VC runtime bytes`);
  }
}

function assertPayload(entries, { prefix = "", label, target, version, npm = false }) {
  assertReleaseNoticesInEntries(entries, { profile: PROFILE, prefix, label });
  const member = (name) => prefix ? `${prefix}/${name}` : name;
  const provenance = archiveJson(entries, member("artifact-provenance.json"), label);
  if (
    provenance.schema !== "oliphaunt-wasix-napi-provenance-v1"
    || provenance.product !== PRODUCT
    || provenance.target !== target.target
    || !/^[0-9a-f]{40}$/u.test(provenance.sourceSha ?? "")
    || !/^[0-9a-f]{40}$/u.test(provenance.artifactSourceSha ?? "")
  ) {
    throw new Error(`${label} has incompatible WASIX Node-API provenance`);
  }
  if (provenance.sourceSha !== provenance.artifactSourceSha) {
    throw new Error(`${label} provenance must bind addon source and embedded artifacts to one commit`);
  }
  const expectedBuild = {
    cargoProfile: "release",
    incremental: false,
    codegenUnits: 1,
    lto: "thin",
    strip: "symbols",
    features: ["release"],
    targetTriple: target.triple,
  };
  if (JSON.stringify(provenance.build) !== JSON.stringify(expectedBuild)) {
    throw new Error(
      `${label} provenance must record the exact optimized addon build: ${JSON.stringify(expectedBuild)}`,
    );
  }
  assertBuildInputs(provenance.buildInputs, target, label);
  const binaryMember = member(npm ? `prebuilds/${BINARY}` : BINARY);
  const entry = entries.get(binaryMember);
  if (!entry?.isFile || entry.isSymbolicLink || entry.size <= 0) {
    throw new Error(`${label} is missing non-empty regular ${binaryMember}`);
  }
  const actual = entrySha256(entry);
  if (
    provenance.binary?.filename !== BINARY
    || provenance.binary?.sha256 !== actual
    || Object.hasOwn(provenance, "binaries")
  ) {
    throw new Error(`${label} provenance must bind its sole ${BINARY} subject to ${actual}`);
  }
  if (!npm) return;
  assertSingleWasixNapiAddonMember(entries, binaryMember, label);
  const manifest = archiveJson(entries, member("package.json"), label);
  assertWasixNapiCarrierManifest(manifest, target, version, label);
}

export function assertWasixNapiNpmArchive(file, targets, version) {
  const label = path.basename(file);
  let entries;
  try {
    entries = readPortableArchiveEntries(file);
  } catch (error) {
    throw new Error(`${label} is not a valid portable archive: ${error.message}`);
  }
  const manifest = archiveJson(entries, "package/package.json", label);
  const target = targets.find((candidate) => candidate.npmPackage === manifest.name);
  if (!target) {
    throw new Error(`${label} package name is not a published WASIX Node-API carrier: ${JSON.stringify(manifest.name)}`);
  }
  assertPayload(entries, { prefix: "package", label, target, version, npm: true });
  assertWasixNapiPlatformEntries(entries, {
    target: target.target,
    label,
    prefix: "package",
    binaryDirectory: "prebuilds",
  });
  return manifest;
}

async function validateArchive(file, target, version) {
  const entries = await readArchiveEntries(file, fail, PREFIX, "WASIX Node-API");
  try {
    assertPayload(entries, { label: path.basename(file), target, version });
  } catch (error) {
    fail(PREFIX, error.message);
  }
  assertWasixNapiPlatformEntries(entries, {
    target: target.target,
    label: path.basename(file),
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  const version = await currentProductVersion(PRODUCT, PREFIX);
  const requiredAssets = expectedAssets(PRODUCT, KIND, version, PREFIX);
  const targets = artifactTargets(PRODUCT, KIND, PREFIX);
  const targetsByAsset = new Map(
    targets.map((target) => [target.asset.replaceAll("{version}", version), target]),
  );
  const missing = [];
  for (const asset of requiredAssets) {
    if (!(await assertFileExists(path.join(args.assetDir, asset)))) missing.push(asset);
  }
  if (missing.length > 0) {
    if (!args.allowPartial) {
      fail(PREFIX, `missing WASIX Node-API release asset(s): ${missing.join(", ")}`);
    }
    let present = 0;
    for (const asset of targetsByAsset.keys()) {
      if (await assertFileExists(path.join(args.assetDir, asset))) present += 1;
    }
    if (present === 0) {
      fail(PREFIX, "partial WASIX Node-API validation requires at least one addon asset");
    }
  }

  const checksumAsset = `${PRODUCT}-${version}-release-assets.sha256`;
  const checksumPath = path.join(args.assetDir, checksumAsset);
  if (!(await assertFileExists(checksumPath))) {
    fail(PREFIX, `missing checksum manifest: ${checksumAsset}`);
  }
  const checksums = await checksumManifest(checksumPath, fail, PREFIX);
  for (const asset of requiredAssets.sort(compareText)) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) continue;
    if (asset === checksumAsset) continue;
    const expected = checksums.get(asset);
    if (!expected) fail(PREFIX, `${checksumAsset} does not cover ${asset}`);
    const actual = await sha256(assetPath);
    if (actual !== expected) {
      fail(PREFIX, `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [asset, target] of targetsByAsset) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) continue;
    await validateArchive(assetPath, target, version);
  }
  for (const npmPackage of args.npmPackages) {
    try {
      assertWasixNapiNpmArchive(npmPackage, targets, version);
    } catch (error) {
      fail(PREFIX, error.message);
    }
  }
  console.log(`WASIX Node-API release assets validated: ${args.assetDir}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  await main(Bun.argv.slice(2));
}
