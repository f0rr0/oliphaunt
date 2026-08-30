#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { validatePortableReleaseAsset } from "./check-liboliphaunt-wasix-release-assets.mjs";
import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from "./npm-trusted-publishing.mjs";
import {
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from "./portable-archive.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  WASIX_STANDARD_SEED_ARCHIVE_PATH,
  WASIX_STANDARD_SEED_MANIFEST_PATH,
  WASIX_PORTABLE_RELEASE_MEMBERS,
  WASIX_RUNTIME_ARCHIVE_PATH,
  WASIX_RUNTIME_NPM_ASSET_PATHS,
  WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA,
  WASIX_RUNTIME_NPM_PACKAGE,
  WASIX_RUNTIME_NPM_TARGET,
  WASIX_RUNTIME_PRODUCT,
} from "./wasix-runtime-npm-contract.mjs";
import {
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from "./wasix-runtime-npm-descriptor.mjs";

export {
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from "./wasix-runtime-npm-descriptor.mjs";

const TOOL = "wasix-runtime-npm-carrier.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const RUNTIME_MODULE_MEMBER = "oliphaunt/bin/postgres";
const NPM_PACKAGE_SAFETY_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_COMMAND_CAPTURE_BYTES = 32 * 1024 * 1024;
const NOTICE_OPTIONS = Object.freeze({ profile: "wasix-runtime" });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function rel(file) {
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  return relative && !relative.startsWith("../") ? relative : String(file);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail(`${label} must be a non-empty regular non-symlink file: ${rel(file)}`);
  }
  return metadata;
}

function parseJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (cause) {
    fail(`${label} must contain UTF-8 JSON: ${cause.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must contain a JSON object`);
  }
  return value;
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function checkedSha256(value, label) {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function safeRelativePath(value, label) {
  const result = nonEmptyString(value, label);
  const segments = result.split("/");
  if (
    result.startsWith("/")
    || result.includes("\\")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a canonical safe relative path`);
  }
  return result;
}

function postgresMajor(value, label) {
  return nonEmptyString(value, label).split(".")[0];
}

function requireRegularEntry(entries, member, label) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${label} must contain ${member} as one non-empty regular file`);
  }
  return entry;
}

/**
 * Validate the complete core-manifest projection consumed by WASIX hosts.
 * Keep this producer-side gate in lockstep with the binding's parser so a
 * package cannot be publishable but unusable by every consumer.
 */
function assertCoreManifestContract(manifest, runtimeEntries, standardSeedEntries, seedManifest) {
  if (manifest["format-version"] !== 2) {
    fail("frozen WASIX core manifest must use format-version 2");
  }
  const sourceFingerprint = nonEmptyString(
    manifest["source-fingerprint"],
    "frozen WASIX core manifest source-fingerprint",
  );
  const runtime = object(manifest.runtime, "frozen WASIX core manifest runtime");
  safeRelativePath(runtime.archive, "frozen WASIX core manifest runtime.archive");
  checkedSha256(runtime.sha256, "frozen WASIX core manifest runtime.sha256");
  if (
    runtime.size !== undefined
    && (!Number.isSafeInteger(runtime.size) || runtime.size <= 0)
  ) {
    fail("frozen WASIX core manifest runtime.size must be a positive safe integer when present");
  }
  const runtimeModuleSha256 = checkedSha256(
    runtime["module-sha256"],
    "frozen WASIX core manifest runtime.module-sha256",
  );
  const runtimePostgresMajor = postgresMajor(
    runtime["postgres-version"],
    "frozen WASIX core manifest runtime.postgres-version",
  );
  const link = object(runtime.link, "frozen WASIX core manifest runtime.link");
  if (!Array.isArray(link.exports)) {
    fail("frozen WASIX core manifest runtime.link.exports must be an array");
  }
  for (const [index, value] of link.exports.entries()) {
    const entry = object(value, `frozen WASIX core manifest runtime.link.exports[${index}]`);
    nonEmptyString(entry.name, `frozen WASIX core manifest runtime.link.exports[${index}].name`);
    nonEmptyString(entry.kind, `frozen WASIX core manifest runtime.link.exports[${index}].kind`);
  }

  if (!Array.isArray(manifest["runtime-support"])) {
    fail("frozen WASIX core manifest runtime-support must be an array");
  }
  const supportNames = new Set();
  const supportPaths = new Set();
  for (const [index, value] of manifest["runtime-support"].entries()) {
    const entry = object(value, `frozen WASIX core manifest runtime-support[${index}]`);
    const name = nonEmptyString(
      entry.name,
      `frozen WASIX core manifest runtime-support[${index}].name`,
    );
    if (!SQL_NAME.test(name) || supportNames.has(name)) {
      fail(`frozen WASIX core manifest runtime-support[${index}].name must be unique and portable`);
    }
    supportNames.add(name);
    const supportPath = safeRelativePath(
      entry.path,
      `frozen WASIX core manifest runtime-support[${index}].path`,
    );
    if (!supportPath.startsWith("lib/postgresql/") || supportPaths.has(supportPath)) {
      fail(`frozen WASIX core manifest runtime-support[${index}].path must be unique under lib/postgresql/`);
    }
    supportPaths.add(supportPath);
    checkedSha256(
      entry.sha256,
      `frozen WASIX core manifest runtime-support[${index}].sha256`,
    );
  }

  const seeds = object(manifest["cluster-seeds"], "frozen WASIX core manifest cluster-seeds");
  if (Object.keys(seeds).sort().join(",") !== "icu,standard") {
    fail("frozen WASIX core manifest must contain exactly standard and icu cluster seeds");
  }
  const standardSeed = object(seeds.standard, "frozen WASIX standard cluster seed");
  if (
    standardSeed["artifact-role"] !== "cluster-seed-standard"
    || standardSeed["catalog-profile"] !== "standard"
    || standardSeed["physical-format"] !== "wasix-pg18-v1"
    || standardSeed["compatibility-key"] !== "wasix-pg18-datum32-v1"
    || standardSeed.manifest !== WASIX_STANDARD_SEED_MANIFEST_PATH
  ) {
    fail("frozen WASIX standard cluster seed has an incompatible identity");
  }
  safeRelativePath(standardSeed.archive, "frozen WASIX standard cluster seed archive");
  checkedSha256(standardSeed.sha256, "frozen WASIX standard cluster seed archive SHA-256");
  if (!Number.isSafeInteger(standardSeed.size) || standardSeed.size <= 0) {
    fail("frozen WASIX standard cluster seed size must be a positive safe integer");
  }
  const standardSeedRuntimeModuleSha256 = checkedSha256(
    standardSeed["runtime-module-sha256"],
    "frozen WASIX standard cluster seed runtime-module-sha256",
  );
  const standardSeedFingerprint = nonEmptyString(
    standardSeed["source-fingerprint"],
    "frozen WASIX standard cluster seed source-fingerprint",
  );
  const standardSeedPostgresMajor = postgresMajor(
    standardSeed["postgres-version"],
    "frozen WASIX standard cluster seed postgres-version",
  );
  if (runtimeModuleSha256 !== standardSeedRuntimeModuleSha256) {
    fail("frozen WASIX core manifest runtime and standard cluster seed identify different runtime modules");
  }
  if (sourceFingerprint !== standardSeedFingerprint) {
    fail("frozen WASIX core manifest runtime and standard cluster seed identify different source fingerprints");
  }
  if (runtimePostgresMajor !== standardSeedPostgresMajor) {
    fail("frozen WASIX core manifest runtime and standard cluster seed identify different PostgreSQL majors");
  }

  const runtimeModule = requireRegularEntry(
    runtimeEntries,
    RUNTIME_MODULE_MEMBER,
    "frozen WASIX runtime archive",
  );
  if (sha256Bytes(runtimeModule.data()) !== runtimeModuleSha256) {
    fail("frozen WASIX runtime module does not match manifest runtime.module-sha256");
  }
  const pgVersion = Buffer.from(
    requireRegularEntry(standardSeedEntries, "PG_VERSION", "frozen WASIX standard cluster seed archive").data(),
  ).toString("utf8").trim();
  if (pgVersion !== runtimePostgresMajor || pgVersion !== standardSeedPostgresMajor) {
    fail("frozen WASIX cluster seed PG_VERSION does not match the manifest PostgreSQL major");
  }
  if (
    seedManifest.schema !== "oliphaunt-cluster-seed-v1"
    || seedManifest.artifactRole !== "cluster-seed-standard"
    || seedManifest.catalogProfile !== "standard"
    || seedManifest.archive?.path !== WASIX_STANDARD_SEED_ARCHIVE_PATH
    || seedManifest.archive?.sha256 !== standardSeed.sha256
    || seedManifest.archive?.compressedBytes !== standardSeed.size
    || seedManifest.runtime?.consumerSha256 !== runtimeModuleSha256
    || seedManifest.runtime?.producerSha256 !== runtimeModuleSha256
    || seedManifest.source?.fingerprint !== sourceFingerprint
    || JSON.stringify(seedManifest.requiredRuntimeFeatures) !== "[]"
    || seedManifest.icu !== null
  ) {
    fail("frozen WASIX standard cluster seed manifest does not match the runtime closure");
  }
}

function checkedAssetMetadata(value, expectedArchive, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  if (value.archive !== expectedArchive) {
    fail(`${label}.archive must be ${expectedArchive}, got ${JSON.stringify(value.archive)}`);
  }
  if (typeof value.sha256 !== "string" || !LOWER_SHA256.test(value.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireArchiveEntry(entries, member, archive) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${rel(archive)} must contain ${member} as one non-empty regular file`);
  }
  return Buffer.from(entry.data());
}

function checkedInputArchive(bytes, label) {
  try {
    return readPortableTarZstdBufferEntries(bytes, { label });
  } catch (cause) {
    fail(cause.message);
  }
}

export function wasixRuntimeNpmInputs({
  portableReleaseArchive,
}) {
  const releaseArchive = path.resolve(portableReleaseArchive);
  regularFile(releaseArchive, "portable WASIX release archive");
  validatePortableReleaseAsset(releaseArchive);

  const releaseEntries = readPortableArchiveEntries(releaseArchive);
  const manifestBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.manifest,
    releaseArchive,
  );
  const runtimeBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive,
    releaseArchive,
  );
  const standardSeedBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.standardSeedArchive,
    releaseArchive,
  );
  const standardSeedManifestBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.standardSeedManifest,
    releaseArchive,
  );
  const manifest = parseJsonBytes(
    manifestBytes,
    `${rel(releaseArchive)} ${WASIX_PORTABLE_RELEASE_MEMBERS.manifest}`,
  );
  const standardSeedManifest = parseJsonBytes(
    standardSeedManifestBytes,
    `${rel(releaseArchive)} ${WASIX_PORTABLE_RELEASE_MEMBERS.standardSeedManifest}`,
  );
  if (!Array.isArray(manifest.extensions) || manifest.extensions.length !== 0) {
    fail("frozen WASIX core manifest must contain an empty extensions array");
  }
  if (Object.hasOwn(manifest, "pg-dump") || Object.hasOwn(manifest, "psql")) {
    fail("frozen WASIX core manifest must not claim split tool payloads");
  }
  const runtime = checkedAssetMetadata(
    manifest.runtime,
    WASIX_RUNTIME_ARCHIVE_PATH,
    "frozen WASIX core manifest runtime",
  );
  const standardSeed = checkedAssetMetadata(
    object(manifest["cluster-seeds"], "frozen WASIX core manifest cluster-seeds").standard,
    WASIX_STANDARD_SEED_ARCHIVE_PATH,
    "frozen WASIX standard cluster seed",
  );
  if (!Number.isSafeInteger(standardSeed.size) || standardSeed.size <= 0) {
    fail("frozen WASIX standard cluster seed size must be a positive safe integer");
  }
  if (sha256Bytes(runtimeBytes) !== runtime.sha256) {
    fail("frozen WASIX runtime archive does not match manifest.runtime.sha256");
  }
  if (runtime.size !== undefined && runtimeBytes.length !== runtime.size) {
    fail("frozen WASIX runtime archive does not match manifest.runtime.size");
  }
  if (standardSeedBytes.length !== standardSeed.size || sha256Bytes(standardSeedBytes) !== standardSeed.sha256) {
    fail("frozen WASIX standard cluster seed archive does not match the manifest size/digest");
  }
  const runtimeEntries = checkedInputArchive(
    runtimeBytes,
    `${rel(releaseArchive)} runtime archive`,
  );
  const standardSeedEntries = checkedInputArchive(
    standardSeedBytes,
    `${rel(releaseArchive)} standard cluster seed archive`,
  );
  assertCoreManifestContract(manifest, runtimeEntries, standardSeedEntries, standardSeedManifest);

  return Object.freeze({
    manifest: Object.freeze({
      bytes: manifestBytes,
      sha256: sha256Bytes(manifestBytes),
      size: manifestBytes.length,
    }),
    runtimeArchive: Object.freeze({
      archive: runtime.archive,
      bytes: runtimeBytes,
      sha256: runtime.sha256,
      size: runtimeBytes.length,
    }),
    standardSeedArchive: Object.freeze({
      archive: standardSeed.archive,
      bytes: standardSeedBytes,
      sha256: standardSeed.sha256,
      size: standardSeedBytes.length,
    }),
    standardSeedManifest: Object.freeze({
      bytes: standardSeedManifestBytes,
      sha256: sha256Bytes(standardSeedManifestBytes),
      size: standardSeedManifestBytes.length,
    }),
  });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
}

function writeReadme(packageDir) {
  writeFileSync(path.join(packageDir, "README.md"), `# ${WASIX_RUNTIME_NPM_PACKAGE}

Internal host-neutral portable runtime carrier for \`@oliphaunt/wasix-ts\`.
Application code should depend on the binding, which selects this matching
carrier automatically. The descriptor and assets can be consumed by browser
or Node/Bun/Deno/Electron WASIX hosts; importing them alone is not a host-support claim.
The public binding declares this carrier as an exact release-staged dependency;
applications do not configure its package-relative assets.

The carried manifest retains the exact qualified core identity projection and
an empty extension inventory. Extension metadata and bytes remain in their
independently versioned \`@oliphaunt/extension-*-wasix\` packages, so an
extension release never mutates this runtime carrier.
`);
}

export function stageWasixRuntimeNpmCarrier({
  version,
  portableReleaseArchive,
  packageDir,
}) {
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError(`${TOOL}: version must be a non-empty string`);
  }
  const output = path.resolve(packageDir);
  const inputs = wasixRuntimeNpmInputs({ portableReleaseArchive });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, "assets"), { recursive: true });
  for (const [name, input] of Object.entries({
    runtimeArchive: inputs.runtimeArchive,
    standardSeedArchive: inputs.standardSeedArchive,
    standardSeedManifest: inputs.standardSeedManifest,
    manifest: inputs.manifest,
  })) {
    const destination = path.join(output, ...WASIX_RUNTIME_NPM_ASSET_PATHS[name].split("/"));
    writeFileSync(destination, input.bytes, { flag: "wx", mode: 0o644 });
    chmodSync(destination, 0o644);
  }

  const descriptorInput = { version, ...inputs };
  writeFileSync(path.join(output, "index.js"), renderWasixRuntimeDescriptorModule(descriptorInput));
  writeFileSync(path.join(output, "index.d.ts"), renderWasixRuntimeDescriptorTypes());
  chmodSync(path.join(output, "index.js"), 0o644);
  chmodSync(path.join(output, "index.d.ts"), 0o644);
  writeReadme(output);
  chmodSync(path.join(output, "README.md"), 0o644);
  stageReleaseNotices(output, NOTICE_OPTIONS);

  const noticeFiles = releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => member);
  const packageJson = {
    name: WASIX_RUNTIME_NPM_PACKAGE,
    version,
    description: "Portable liboliphaunt WASIX runtime assets for Oliphaunt hosts.",
    license: releaseProfilePackageLicense("wasix-runtime").spdx,
    type: "module",
    sideEffects: false,
    repository: { type: "git", url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    oliphaunt: {
      product: WASIX_RUNTIME_PRODUCT,
      kind: "wasix-runtime",
      runtime: "wasix",
      target: WASIX_RUNTIME_NPM_TARGET,
      descriptorSchema: WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA,
      manifestProjection: "core",
    },
    publishConfig: { access: "public", provenance: true },
    files: ["README.md", "index.js", "index.d.ts", "assets", ...noticeFiles],
    exports: {
      ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
      "./package.json": "./package.json",
    },
  };
  validateNpmTrustedPublishingManifest(packageJson, `${WASIX_RUNTIME_NPM_PACKAGE} generated package`);
  writeJson(path.join(output, "package.json"), packageJson);
  assertReleaseNoticesInDirectory(output, NOTICE_OPTIONS);
  return Object.freeze({ descriptor: descriptorInput, packageDir: output, packageName: WASIX_RUNTIME_NPM_PACKAGE });
}

function safeNpmFilename(name) {
  return name.replace(/^@/u, "").replaceAll("/", "-");
}

function packedFileEntries(entries) {
  return [...entries]
    .filter(([, entry]) => entry.isFile)
    .map(([member]) => member)
    .sort();
}

export function assertWasixRuntimeNpmArchive(archive, { version, descriptor }) {
  const file = path.resolve(archive);
  regularFile(file, "WASIX runtime npm carrier");
  if (statSync(file).size > NPM_PACKAGE_SAFETY_LIMIT_BYTES) {
    fail(`${rel(file)} exceeds the ${NPM_PACKAGE_SAFETY_LIMIT_BYTES}-byte npm carrier safety limit`);
  }
  assertReleaseNoticesInArchive(file, { ...NOTICE_OPTIONS, prefix: "package" });
  const entries = readPortableArchiveEntries(file);
  const expectedFiles = [
    "package/package.json",
    "package/README.md",
    "package/index.js",
    "package/index.d.ts",
    ...Object.values(WASIX_RUNTIME_NPM_ASSET_PATHS).map((member) => `package/${member}`),
    ...releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => `package/${member}`),
  ].sort();
  const actualFiles = packedFileEntries(entries);
  if (!isDeepStrictEqual(actualFiles, expectedFiles)) {
    fail(`${rel(file)} regular file inventory differs from the generated package allowlist`);
  }
  for (const [member, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${rel(file)} must not contain symbolic link ${member}`);
  }

  const packageJson = parseJsonBytes(
    requireArchiveEntry(entries, "package/package.json", file),
    `${rel(file)} package/package.json`,
  );
  validateNpmTrustedPublishingManifest(packageJson, `${rel(file)} package/package.json`);
  if (packageJson.name !== WASIX_RUNTIME_NPM_PACKAGE || packageJson.version !== version) {
    fail(`${rel(file)} must identify ${WASIX_RUNTIME_NPM_PACKAGE}@${version}`);
  }
  for (const name of ["runtimeArchive", "standardSeedArchive", "standardSeedManifest", "manifest"]) {
    const bytes = requireArchiveEntry(entries, `package/${WASIX_RUNTIME_NPM_ASSET_PATHS[name]}`, file);
    if (bytes.length !== descriptor[name].size || sha256Bytes(bytes) !== descriptor[name].sha256) {
      fail(`${rel(file)} ${name} bytes differ from the generated descriptor`);
    }
  }
  return packageJson;
}

export function packWasixRuntimeNpmCarrier({
  version,
  portableReleaseArchive,
  packageDir = path.join(ROOT, "target/release/npm-package-sources/liboliphaunt-wasix"),
  tarballRoot = path.join(ROOT, "target/release/npm-packages/liboliphaunt-wasix"),
}) {
  const staged = stageWasixRuntimeNpmCarrier({
    version,
    portableReleaseArchive,
    packageDir,
  });
  const outputRoot = path.resolve(tarballRoot);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = captureCommandOutput(
    command,
    ["pack", "--pack-destination", outputRoot, "--json"],
    {
      cwd: staged.packageDir,
      label: `pnpm pack for ${WASIX_RUNTIME_NPM_PACKAGE}`,
      maxOutputBytes: MAX_COMMAND_CAPTURE_BYTES,
      shell: process.platform === "win32",
    },
  );
  if (result.error !== undefined) {
    fail(`pnpm pack failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    fail(`pnpm pack failed${detail ? `: ${detail}` : ""}`);
  }
  let packed;
  try {
    packed = JSON.parse(result.stdout);
  } catch (cause) {
    fail(`pnpm pack did not emit JSON: ${cause.message}`);
  }
  const filename = Array.isArray(packed) ? packed[0]?.filename : packed?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    fail("pnpm pack did not report a .tgz filename");
  }
  const tarball = path.isAbsolute(filename) ? filename : path.join(outputRoot, filename);
  assertWasixRuntimeNpmArchive(tarball, { version, descriptor: staged.descriptor });
  const expectedName = `${safeNpmFilename(WASIX_RUNTIME_NPM_PACKAGE)}-${version}.tgz`;
  if (path.basename(tarball) !== expectedName) {
    fail(`pnpm pack emitted ${path.basename(tarball)} instead of ${expectedName}`);
  }
  return Object.freeze({ ...staged, tarball });
}
