#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  compareText,
  currentProductVersionSync,
  expectedAssetRows,
} from "./release-artifact-targets.mjs";

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

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
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
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function runCapture(command, args, { input = undefined, label = `${command} ${args.join(" ")}` } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    input,
    encoding: "buffer",
    maxBuffer: 200 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    fail(`${label} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return result.stdout;
}

function normalizeTarMember(member, context) {
  const normalized = String(member).replaceAll("\\", "/").replace(/\/+$/u, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || normalized.startsWith("/") || parts.includes("..")) {
    fail(`${context} contains unsafe archive member ${JSON.stringify(member)}`);
  }
  return parts.join("/");
}

function tarZstdMembers(archive) {
  const output = runCapture("tar", ["--zstd", "-tf", archive], {
    label: `list ${rel(archive)}`,
  }).toString("utf8");
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((member) => normalizeTarMember(member, rel(archive)));
}

function tarZstdBufferMembers(data, context) {
  const output = runCapture("tar", ["--zstd", "-tf", "-"], {
    input: data,
    label: `list nested zstd tar for ${context}`,
  }).toString("utf8");
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((member) => normalizeTarMember(member, context));
}

function findTarZstdMember(archive, expected) {
  for (const member of tarZstdMembers(archive)) {
    if (member === expected) {
      return member;
    }
  }
  return null;
}

function readTarZstdMember(archive, expected) {
  const member = findTarZstdMember(archive, expected);
  if (member === null) {
    fail(`${rel(archive)} is missing ${expected}`);
  }
  return runCapture("tar", ["--zstd", "-xOf", archive, member], {
    label: `read ${expected} from ${rel(archive)}`,
  });
}

function readTarZstdJsonMember(archive, expected) {
  const data = readTarZstdMember(archive, expected).toString("utf8");
  try {
    return JSON.parse(data);
  } catch (error) {
    fail(`${rel(archive)} ${expected} is not valid JSON: ${error.message}`);
  }
}

function simpleRelativePath(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${context} path must be a simple relative path, got ${JSON.stringify(value)}`);
  }
  return normalized;
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

function validateAssetSet(assetDir, version) {
  const expected = new Set(expectedAssetNames(version));
  const actual = new Set(
    readdirSync(assetDir)
      .map((name) => path.join(assetDir, name))
      .filter(isFile)
      .map((file) => path.basename(file))
      .sort(compareText),
  );
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

function validatePortableReleaseAsset(archive) {
  const members = new Set(tarZstdMembers(archive));
  const extensionMembers = [...members]
    .filter((member) => member.startsWith("target/oliphaunt-wasix/assets/extensions/"))
    .sort(compareText);
  if (extensionMembers.length > 0) {
    fail(`${rel(archive)} must not contain extension payloads: ${extensionMembers.slice(0, 5).join(", ")}`);
  }
  const missingToolPayloads = [...SPLIT_TOOL_PAYLOAD_MEMBERS]
    .filter((member) => !members.has(member))
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

  const manifest = readTarZstdJsonMember(archive, PORTABLE_MANIFEST_MEMBER);
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

  const runtimeArchive = readTarZstdMember(archive, PORTABLE_RUNTIME_ARCHIVE_MEMBER);
  const runtimeMembers = new Set(tarZstdBufferMembers(runtimeArchive, "WASIX runtime archive"));
  const missing = [...CORE_RUNTIME_MEMBERS]
    .filter((member) => !runtimeMembers.has(member))
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

function validateIcuReleaseAsset(archive) {
  const members = new Set(tarZstdMembers(archive));
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
  const parentDirs = expectedParentDirs(new Set(icuEntries));
  const unexpected = [...members]
    .filter((member) => !parentDirs.has(member) && !member.startsWith(`${icuRoot}/`))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`${rel(archive)} contains unexpected non-ICU files: ${unexpected.slice(0, 5).join(", ")}`);
  }
}

function validateAotReleaseAsset(archive) {
  const members = new Set(tarZstdMembers(archive));
  const manifestMembers = [...members]
    .filter((member) => member.startsWith("target/oliphaunt-wasix/aot/") && member.endsWith("/manifest.json"))
    .sort(compareText);
  if (manifestMembers.length !== 1) {
    fail(`${rel(archive)} must contain exactly one AOT manifest, got ${JSON.stringify(manifestMembers)}`);
  }
  const manifestPath = manifestMembers[0];
  const aotRoot = manifestPath.slice(0, -"/manifest.json".length);
  const manifest = readTarZstdJsonMember(archive, manifestPath);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail(`${rel(archive)} AOT manifest must contain artifacts`);
  }

  const expectedFiles = new Set([manifestPath]);
  for (const artifact of manifest.artifacts) {
    if (artifact === null || Array.isArray(artifact) || typeof artifact !== "object") {
      fail(`${rel(archive)} AOT manifest contains a non-object artifact`);
    }
    const name = artifact.name;
    if (typeof name !== "string" || name.length === 0) {
      fail(`${rel(archive)} AOT manifest contains an artifact without a name`);
    }
    if (name.startsWith("extension:")) {
      fail(`${rel(archive)} must not contain extension AOT artifact ${name}`);
    }
    expectedFiles.add(`${aotRoot}/${simpleRelativePath(artifact.path, `${rel(archive)} AOT artifact ${name}`)}`);
  }

  const parentDirs = expectedParentDirs(expectedFiles);
  const actualFiles = new Set([...members].filter((member) => !parentDirs.has(member)));
  if (
    JSON.stringify([...actualFiles].sort(compareText)) !==
    JSON.stringify([...expectedFiles].sort(compareText))
  ) {
    fail(
      `${rel(archive)} AOT file set mismatch: ` +
        `expected ${JSON.stringify([...expectedFiles].sort(compareText))}, got ${JSON.stringify([...actualFiles].sort(compareText))}`,
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
    validateAotReleaseAsset(archive);
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

const args = parseArgs(Bun.argv.slice(2));
if (!existsSync(args.assetDir) || !isDirectory(args.assetDir)) {
  fail(`${PRODUCT} release asset directory does not exist: ${rel(args.assetDir)}`);
}
validateAssetSet(args.assetDir, args.version);
validateAssetContents(args.assetDir, args.version);
console.log(`validated ${PRODUCT} staged release assets under ${rel(args.assetDir)}`);
