#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  compareText,
  currentProductVersionSync,
  expectedAssetRows,
} from "./release-artifact-targets.mjs";
import {
  assertReleaseNoticesInEntries,
  releaseNoticeRows,
} from "./release-notices.mjs";
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  decompressSingleZstdFrame,
  portableMemberName,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from "./portable-archive.mjs";
import { AOT_TARGET_TRIPLES } from "./wasix-cargo-artifact-contract.mjs";
import { assertCanonicalWasixAotManifest } from "./wasix-aot-manifest.mjs";

const TOOL = "check-liboliphaunt-wasix-release-assets.mjs";
const PRODUCT = "liboliphaunt-wasix";
const DEFAULT_ASSET_DIR = "target/oliphaunt-wasix/release-assets";
const PORTABLE_RUNTIME_ARCHIVE_MEMBER = "target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst";
const PORTABLE_MANIFEST_MEMBER = "target/oliphaunt-wasix/assets/manifest.json";
const SPLIT_TOOL_PAYLOAD_MEMBERS = new Set([
  "target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm",
  "target/oliphaunt-wasix/assets/bin/psql.wasix.wasm",
]);
const FORBIDDEN_PORTABLE_ASSET_MEMBERS = new Set([
  "target/oliphaunt-wasix/assets/bin/pg_ctl.wasix.wasm",
]);
const CORE_RUNTIME_MEMBERS = new Set([
  "oliphaunt/bin/initdb",
  "oliphaunt/bin/postgres",
]);
const FORBIDDEN_RUNTIME_MEMBERS = new Set([
  "oliphaunt/bin/pg_ctl",
  "oliphaunt/bin/pg_dump",
  "oliphaunt/bin/psql",
]);
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function isFile(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readArchiveJsonEntry(entries, member, archive) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${rel(archive)} must contain ${member} as one non-empty regular file`);
  }
  let data;
  try {
    data = UTF8.decode(entry.data());
  } catch {
    fail(`${rel(archive)} ${member} is not valid UTF-8`);
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    fail(`${rel(archive)} ${member} is not valid JSON: ${error.message}`);
  }
}

function checkedSha256(value, context) {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function checkedAotArtifactName(value, context) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > 255
    || /[\u0000-\u001f\u007f/\\]/u.test(value)
  ) {
    throw new Error(`${context} name must be a normalized portable non-empty string`);
  }
  return value;
}

export function assertWasixAotArtifactPayloads(
  manifest,
  {
    context = "WASIX AOT manifest",
    readArtifact,
    maxRawBytes = DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes,
  } = {},
) {
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`${context} must contain a non-empty artifacts array`);
  }
  if (typeof readArtifact !== "function") {
    throw new Error(`${context} requires an artifact byte reader`);
  }
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0) {
    throw new Error(`${context} maxRawBytes must be a positive safe integer`);
  }

  const expectedKeys = [
    "compressed",
    "module-sha256",
    "name",
    "path",
    "raw-sha256",
    "raw-size",
    "sha256",
  ];
  const names = new Set();
  const portableNames = new Map();
  const paths = new Set();
  const portablePaths = new Map();
  const rows = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const artifactContext = `${context} artifact[${index}]`;
    if (artifact === null || Array.isArray(artifact) || typeof artifact !== "object") {
      throw new Error(`${artifactContext} must be an object`);
    }
    const actualKeys = Object.keys(artifact).sort(compareText);
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(
        `${artifactContext} metadata fields must be exactly ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`,
      );
    }
    const name = checkedAotArtifactName(artifact.name, artifactContext);
    if (names.has(name)) throw new Error(`${context} repeats AOT artifact name ${name}`);
    names.add(name);
    const portableName = name.toLowerCase();
    const priorName = portableNames.get(portableName);
    if (priorName !== undefined) {
      throw new Error(`${context} has case-colliding AOT artifact names ${priorName} and ${name}`);
    }
    portableNames.set(portableName, name);

    if (typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw new Error(`${artifactContext} path must be a non-empty string`);
    }
    let artifactPath;
    try {
      artifactPath = portableMemberName(artifact.path, "file", artifactContext);
    } catch (error) {
      throw new Error(error.message);
    }
    if (artifactPath !== artifact.path) {
      throw new Error(`${artifactContext} path must already be normalized, got ${JSON.stringify(artifact.path)}`);
    }
    if (paths.has(artifactPath)) throw new Error(`${context} repeats AOT artifact path ${artifactPath}`);
    paths.add(artifactPath);
    const portablePath = artifactPath.toLowerCase();
    const priorPath = portablePaths.get(portablePath);
    if (priorPath !== undefined) {
      throw new Error(`${context} has case-colliding AOT artifact paths ${priorPath} and ${artifactPath}`);
    }
    portablePaths.set(portablePath, artifactPath);

    const sha256 = checkedSha256(artifact.sha256, `${artifactContext} sha256`);
    const rawSha256 = checkedSha256(artifact["raw-sha256"], `${artifactContext} raw-sha256`);
    checkedSha256(artifact["module-sha256"], `${artifactContext} module-sha256`);
    const rawSize = artifact["raw-size"];
    if (!Number.isSafeInteger(rawSize) || rawSize <= 0 || rawSize > maxRawBytes) {
      throw new Error(`${artifactContext} raw-size must be an integer in 1..${maxRawBytes}`);
    }
    if (typeof artifact.compressed !== "boolean") {
      throw new Error(`${artifactContext} compressed must be a Boolean`);
    }
    if (artifact.compressed !== artifactPath.endsWith(".zst")) {
      throw new Error(`${artifactContext} compressed metadata must match the .zst path suffix`);
    }

    const value = readArtifact(artifactPath, artifact);
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new Error(`${artifactContext} byte reader did not return a Buffer or Uint8Array`);
    }
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length <= 0 || bytes.length > DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes) {
      throw new Error(`${artifactContext} must reference a non-empty bounded regular file`);
    }
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== sha256) {
      throw new Error(`${artifactContext} compressed SHA-256 mismatch: expected ${sha256}, got ${actualSha256}`);
    }
    const raw = artifact.compressed
      ? decompressSingleZstdFrame(bytes, {
          label: `${artifactContext} ${artifactPath}`,
          maxInputBytes: DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes,
          maxOutputBytes: rawSize,
        })
      : bytes;
    if (raw.length !== rawSize) {
      throw new Error(`${artifactContext} raw-size mismatch: expected ${rawSize}, got ${raw.length}`);
    }
    const actualRawSha256 = sha256Bytes(raw);
    if (actualRawSha256 !== rawSha256) {
      throw new Error(
        `${artifactContext} raw SHA-256 mismatch: expected ${rawSha256}, got ${actualRawSha256}`,
      );
    }
    rows.push(Object.freeze({ artifact, bytes, name, path: artifactPath, raw }));
  }
  return Object.freeze(rows);
}

function expectedParentDirs(paths) {
  const parents = new Set();
  for (const item of paths) {
    const parts = item.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      parents.add(parts.slice(0, index).join("/"));
    }
  }
  return parents;
}

export function expectedReleaseNoticeFiles(profile, prefix = "") {
  const marker = prefix ? `${prefix}/` : "";
  return new Set(releaseNoticeRows({ profile }).map((row) => `${marker}${row.member}`));
}

export function unexpectedTreeMembers(members, expectedMembers) {
  const expected = new Set(expectedMembers);
  for (const parent of expectedParentDirs(expected)) expected.add(parent);
  return [...members]
    .filter((member) => !expected.has(member))
    .sort(compareText);
}

export function assertWasixReleaseNoticeEntries(entries, profile, prefix = "") {
  return assertReleaseNoticesInEntries(entries, { prefix, profile });
}

function checkedWasixArchiveEntries(archive, profile, prefix = "") {
  const entries = readPortableArchiveEntries(archive);
  assertWasixReleaseNoticeEntries(entries, profile, prefix);
  return entries;
}

function parseChecksumManifest(file) {
  const checksums = new Map();
  for (const [index, rawLine] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^([0-9a-f]{64})  \.\/([^/]+)$/u);
    if (match === null) {
      fail(`${rel(file)}:${index + 1} must use '<sha256>  ./<asset-name>' entries`);
    }
    const [, sha256, assetName] = match;
    if (checksums.has(assetName)) {
      fail(`${rel(file)}:${index + 1} declares duplicate checksum for ${assetName}`);
    }
    checksums.set(assetName, sha256);
  }
  return checksums;
}

function expectedAssetNames(version) {
  return expectedAssetRows({ product: PRODUCT, version }, TOOL)
    .map((row) => row.assetName)
    .sort(compareText);
}

export function exactRegularAssetDirectoryNames(assetDir) {
  const entries = readdirSync(assetDir, { withFileTypes: true });
  const invalid = entries
    .filter((entry) => !entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareText);
  if (invalid.length > 0) {
    fail(
      `${PRODUCT} staged release asset directory must contain only regular non-symlink files: ${invalid.join(", ")}`,
    );
  }
  return entries.map((entry) => entry.name).sort(compareText);
}

function validateAssetSet(assetDir, version) {
  const expected = new Set(expectedAssetNames(version));
  const actual = new Set(exactRegularAssetDirectoryNames(assetDir));
  if (JSON.stringify([...actual].sort(compareText)) !== JSON.stringify([...expected].sort(compareText))) {
    fail(
      `${PRODUCT} staged release assets must match release metadata exactly: ` +
        `expected=${JSON.stringify([...expected].sort(compareText))}, actual=${JSON.stringify([...actual].sort(compareText))}`,
    );
  }

  const checksumName = `${PRODUCT}-${version}-release-assets.sha256`;
  const checksumPath = path.join(assetDir, checksumName);
  if (!isFile(checksumPath)) {
    fail(`${PRODUCT} staged release assets are missing checksum manifest ${checksumName}`);
  }
  const checksums = parseChecksumManifest(checksumPath);
  const expectedChecksumAssets = new Set([...expected].filter((name) => name !== checksumName));
  const actualChecksumAssets = new Set(checksums.keys());
  if (
    JSON.stringify([...actualChecksumAssets].sort(compareText)) !==
    JSON.stringify([...expectedChecksumAssets].sort(compareText))
  ) {
    fail(
      `${PRODUCT} checksum manifest must cover release assets exactly: ` +
        `expected=${JSON.stringify([...expectedChecksumAssets].sort(compareText))}, ` +
        `actual=${JSON.stringify([...actualChecksumAssets].sort(compareText))}`,
    );
  }
  for (const [assetName, expectedSha] of checksums) {
    const actualSha = sha256File(path.join(assetDir, assetName));
    if (actualSha !== expectedSha) {
      fail(`${PRODUCT} release asset ${assetName} checksum mismatch`);
    }
  }
}

export function validatePortableReleaseAsset(archive) {
  const entries = checkedWasixArchiveEntries(archive, "wasix-runtime");
  const members = new Set(entries.keys());
  const extensionMembers = [...members]
    .filter((member) => member.startsWith("target/oliphaunt-wasix/assets/extensions/"))
    .sort(compareText);
  if (extensionMembers.length > 0) {
    fail(`${rel(archive)} must not contain extension payloads: ${extensionMembers.slice(0, 5).join(", ")}`);
  }
  const missingToolPayloads = [...SPLIT_TOOL_PAYLOAD_MEMBERS]
    .filter((member) => {
      const entry = entries.get(member);
      return entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0;
    })
    .sort(compareText);
  if (missingToolPayloads.length > 0) {
    fail(`${rel(archive)} must include split WASIX tool payloads for registry tools crates: ${missingToolPayloads.join(", ")}`);
  }
  const forbiddenPortableMembers = [...members]
    .filter((member) => FORBIDDEN_PORTABLE_ASSET_MEMBERS.has(member))
    .sort(compareText);
  if (forbiddenPortableMembers.length > 0) {
    fail(`${rel(archive)} must not contain WASIX pg_ctl payloads: ${forbiddenPortableMembers.join(", ")}`);
  }

  const manifest = readArchiveJsonEntry(entries, PORTABLE_MANIFEST_MEMBER, archive);
  if (JSON.stringify(manifest.extensions) !== "[]") {
    fail(`${rel(archive)} asset manifest must contain an empty extensions array`);
  }
  for (const key of ["pg-dump", "psql"]) {
    if (Object.hasOwn(manifest, key)) {
      fail(`${rel(archive)} asset manifest must not contain split WASIX tool entry ${key}`);
    }
  }

  const icuSidecarMembers = [...members]
    .filter((member) => member === "target/oliphaunt-wasix/icu" || member.startsWith("target/oliphaunt-wasix/icu/"))
    .sort(compareText);
  if (icuSidecarMembers.length > 0) {
    fail(`${rel(archive)} must not contain ICU data sidecar files: ${icuSidecarMembers.slice(0, 5).join(", ")}`);
  }

  if (manifest.runtime === null || Array.isArray(manifest.runtime) || typeof manifest.runtime !== "object") {
    fail(`${rel(archive)} asset manifest must contain runtime metadata`);
  }
  if (manifest.runtime.archive !== path.basename(PORTABLE_RUNTIME_ARCHIVE_MEMBER)) {
    fail(
      `${rel(archive)} asset manifest runtime.archive must be ${path.basename(PORTABLE_RUNTIME_ARCHIVE_MEMBER)}`,
    );
  }
  if (typeof manifest.runtime.sha256 !== "string" || !LOWER_SHA256.test(manifest.runtime.sha256)) {
    fail(`${rel(archive)} asset manifest runtime.sha256 must be a lowercase SHA-256 digest`);
  }
  const runtimeEntry = entries.get(PORTABLE_RUNTIME_ARCHIVE_MEMBER);
  if (
    runtimeEntry === undefined
    || !runtimeEntry.isFile
    || runtimeEntry.isSymbolicLink
    || runtimeEntry.size <= 0
  ) {
    fail(`${rel(archive)} must contain ${PORTABLE_RUNTIME_ARCHIVE_MEMBER} as one non-empty regular file`);
  }
  const runtimeArchive = runtimeEntry.data();
  const runtimeSha256 = sha256Bytes(runtimeArchive);
  if (runtimeSha256 !== manifest.runtime.sha256) {
    fail(
      `${rel(archive)} asset manifest runtime.sha256 mismatch: ` +
        `expected ${manifest.runtime.sha256}, got ${runtimeSha256}`,
    );
  }
  let runtimeEntries;
  try {
    runtimeEntries = readPortableTarZstdBufferEntries(runtimeArchive, {
      label: `${rel(archive)} ${PORTABLE_RUNTIME_ARCHIVE_MEMBER}`,
    });
  } catch (error) {
    fail(error.message);
  }
  const runtimeMembers = new Set(runtimeEntries.keys());
  const missing = [...CORE_RUNTIME_MEMBERS]
    .filter((member) => {
      const entry = runtimeEntries.get(member);
      return entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0;
    })
    .sort(compareText);
  if (missing.length > 0) {
    fail(`${rel(archive)} must bundle core WASIX runtime binaries inside ${PORTABLE_RUNTIME_ARCHIVE_MEMBER}: ${missing.join(", ")}`);
  }
  const bundledIcu = [...runtimeMembers]
    .filter((member) => member === "oliphaunt/share/icu" || member.startsWith("oliphaunt/share/icu/"))
    .sort(compareText);
  if (bundledIcu.length > 0) {
    fail(`${rel(archive)} must not bundle ICU data inside ${PORTABLE_RUNTIME_ARCHIVE_MEMBER}: ${bundledIcu.slice(0, 5).join(", ")}`);
  }
  const bundledTools = [...runtimeMembers]
    .filter((member) => FORBIDDEN_RUNTIME_MEMBERS.has(member))
    .sort(compareText);
  if (bundledTools.length > 0) {
    fail(`${rel(archive)} must not bundle standalone tools inside ${PORTABLE_RUNTIME_ARCHIVE_MEMBER}: ${bundledTools.join(", ")}`);
  }
}

export function validateIcuReleaseAsset(archive) {
  const members = new Set(checkedWasixArchiveEntries(archive, "wasix-icu-data").keys());
  const icuRoot = "target/oliphaunt-wasix/icu/share/icu";
  const icuEntries = [...members]
    .filter((member) => {
      if (!member.startsWith(`${icuRoot}/`)) {
        return false;
      }
      const relative = member.slice(`${icuRoot}/`.length).split("/").filter(Boolean);
      return relative.length > 0 && relative[0].startsWith("icudt");
    })
    .sort(compareText);
  if (icuEntries.length === 0) {
    fail(`${rel(archive)} must contain ICU data files under ${icuRoot}`);
  }
  const expectedMembers = new Set([
    ...icuEntries,
    ...expectedReleaseNoticeFiles("wasix-icu-data"),
  ]);
  const unexpected = unexpectedTreeMembers(members, expectedMembers);
  if (unexpected.length > 0) {
    fail(`${rel(archive)} contains unexpected non-ICU files: ${unexpected.slice(0, 5).join(", ")}`);
  }
}

export function validateAotReleaseAsset(archive, expectedTarget) {
  const entries = checkedWasixArchiveEntries(archive, "wasix-aot", `target/oliphaunt-wasix/aot/${expectedTarget}`);
  const members = new Set(entries.keys());
  const manifestMembers = [...members]
    .filter((member) => member.startsWith("target/oliphaunt-wasix/aot/") && member.endsWith("/manifest.json"))
    .sort(compareText);
  if (manifestMembers.length !== 1) {
    fail(`${rel(archive)} must contain exactly one AOT manifest, got ${JSON.stringify(manifestMembers)}`);
  }
  const manifestPath = manifestMembers[0];
  const aotRoot = manifestPath.slice(0, -"/manifest.json".length);
  if (aotRoot !== `target/oliphaunt-wasix/aot/${expectedTarget}`) {
    fail(`${rel(archive)} AOT archive root ${aotRoot} does not match target ${expectedTarget}`);
  }
  const manifest = readArchiveJsonEntry(entries, manifestPath, archive);
  try {
    assertCanonicalWasixAotManifest(manifest, {
      context: `${rel(archive)} ${manifestPath}`,
      expectedTarget,
    });
  } catch (error) {
    fail(error.message);
  }
  const expectedFiles = new Set([
    manifestPath,
    ...expectedReleaseNoticeFiles("wasix-aot", aotRoot),
  ]);
  let artifactRows;
  try {
    artifactRows = assertWasixAotArtifactPayloads(manifest, {
      context: `${rel(archive)} ${manifestPath}`,
      readArtifact(artifactPath) {
        const member = `${aotRoot}/${artifactPath}`;
        const entry = entries.get(member);
        if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
          throw new Error(`${rel(archive)} AOT artifact ${artifactPath} must be a non-empty regular file`);
        }
        return entry.data();
      },
    });
  } catch (error) {
    fail(error.message);
  }
  for (const row of artifactRows) {
    if (row.name.startsWith("extension:")) {
      fail(`${rel(archive)} must not contain extension AOT artifact ${row.name}`);
    }
    expectedFiles.add(`${aotRoot}/${row.path}`);
  }

  const unexpected = unexpectedTreeMembers(members, expectedFiles);
  if (unexpected.length > 0 || [...expectedFiles].some((member) => !members.has(member))) {
    fail(
      `${rel(archive)} AOT file set mismatch: ` +
        `expected ${JSON.stringify([...expectedFiles].sort(compareText))}, got ${JSON.stringify([...members].sort(compareText))}`,
    );
  }
}

function validateAssetContents(assetDir, version) {
  validatePortableReleaseAsset(path.join(assetDir, `${PRODUCT}-${version}-runtime-portable.tar.zst`));
  validateIcuReleaseAsset(path.join(assetDir, `${PRODUCT}-${version}-icu-data.tar.zst`));
  const aotArchives = readdirSync(assetDir)
    .filter((name) => name.startsWith(`${PRODUCT}-${version}-runtime-aot-`) && name.endsWith(".tar.zst"))
    .map((name) => path.join(assetDir, name))
    .sort(compareText);
  if (aotArchives.length === 0) {
    fail(`${PRODUCT} release assets are missing target AOT archives`);
  }
  for (const archive of aotArchives) {
    const name = path.basename(archive);
    const prefix = `${PRODUCT}-${version}-runtime-aot-`;
    const targetId = name.slice(prefix.length, -".tar.zst".length);
    const expectedTarget = AOT_TARGET_TRIPLES[targetId];
    if (expectedTarget === undefined) {
      fail(`${PRODUCT} release asset ${name} has unknown AOT target id ${targetId}`);
    }
    validateAotReleaseAsset(archive, expectedTarget);
  }
}

function usage() {
  console.log(`usage: tools/release/check-liboliphaunt-wasix-release-assets.mjs [--asset-dir DIR] [--version VERSION]

Validates staged liboliphaunt-wasix GitHub release assets, their checksum
manifest, and runtime/ICU/AOT archive boundaries.
`);
}

function optionValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
    fail(`${argv[index]} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    assetDir: DEFAULT_ASSET_DIR,
    version: null,
  };
  for (let index = 0; index < argv.length;) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      args.assetDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--version") {
      args.version = optionValue(argv, index);
      index += 2;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`unknown argument ${arg}`);
    }
  }
  return {
    assetDir: path.isAbsolute(args.assetDir) ? args.assetDir : path.join(ROOT, args.assetDir),
    version: args.version ?? currentProductVersionSync(PRODUCT, TOOL),
  };
}

export function main(argv = Bun.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!existsSync(args.assetDir) || !isDirectory(args.assetDir)) {
    fail(`${PRODUCT} release asset directory does not exist: ${rel(args.assetDir)}`);
  }
  validateAssetSet(args.assetDir, args.version);
  validateAssetContents(args.assetDir, args.version);
  console.log(`validated ${PRODUCT} staged release assets under ${rel(args.assetDir)}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith(`${TOOL}:`) ? message : `${TOOL}: ${message}`);
    process.exitCode = 1;
  }
}
