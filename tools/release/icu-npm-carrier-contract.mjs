#!/usr/bin/env bun

import { createHash } from "node:crypto";
import vm from "node:vm";

export const ICU_BUNDLE_DIRECTORY = "OliphauntICU.bundle";
export const ICU_DATA_RELATIVE_PATH = `${ICU_BUNDLE_DIRECTORY}/share/icu`;
export const ICU_REACT_NATIVE_CONFIG = "react-native.config.js";
export const ICU_PODSPEC = "OliphauntICU.podspec";

const PACKED_ROOT = "package";
const PACKED_DATA_ROOT = `${PACKED_ROOT}/${ICU_DATA_RELATIVE_PATH}`;
const LEGACY_PACKED_DATA_ROOT = `${PACKED_ROOT}/share/icu`;

function contractError(label, message) {
  throw new Error(`${label}: ${message}`);
}

function asUtf8(bytes, label) {
  if (!(typeof bytes === "string" || bytes instanceof Uint8Array)) {
    contractError(label, "must be UTF-8 text bytes");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    contractError(label, "must be canonical UTF-8 text");
  }
  return { buffer, text };
}

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    contractError(label, "must be an object");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    contractError(label, `keys must be ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIcuReactNativeConfig(bytes, label = ICU_REACT_NATIVE_CONFIG) {
  const { text } = asUtf8(bytes, label);
  const moduleRecord = { exports: {} };
  try {
    vm.runInNewContext(
      text,
      { exports: moduleRecord.exports, module: moduleRecord },
      {
        codeGeneration: { strings: false, wasm: false },
        filename: label,
        timeout: 100,
      },
    );
  } catch (error) {
    contractError(label, `must be a self-contained CommonJS config: ${error.message}`);
  }

  const config = moduleRecord.exports;
  exactObjectKeys(config, ["dependency"], `${label} export`);
  exactObjectKeys(config.dependency, ["platforms"], `${label} dependency`);
  exactObjectKeys(config.dependency.platforms, ["android", "ios"], `${label} platforms`);
  for (const platform of ["android", "ios"]) {
    if (config.dependency.platforms[platform] !== null) {
      contractError(label, `dependency.platforms.${platform} must be null`);
    }
  }
}

export function assertIcuPodspec(bytes, label = ICU_PODSPEC) {
  const { text } = asUtf8(bytes, label);
  const resourceAssignments = [...text.matchAll(/^\s*s\.(resources|resource_bundles?)\s*=/gmu)];
  if (resourceAssignments.length !== 1) {
    contractError(label, `must declare exactly one resources assignment, got ${resourceAssignments.length}`);
  }
  if (!/^\s*s\.resources\s*=\s*(['"])OliphauntICU\.bundle\1\s*$/mu.test(text)) {
    contractError(label, "must copy the preassembled OliphauntICU.bundle as one resource");
  }
  if (/\bs\.resource_bundles?\s*=/u.test(text) || /share\/icu(?:\/|['"])/u.test(text)) {
    contractError(label, "must not rebuild or directly glob the ICU data tree");
  }
}

export function assertIcuPackageManifest(packageJson, label = "@oliphaunt/icu package.json") {
  if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    contractError(label, "must be an object");
  }
  if (packageJson.type !== "commonjs") {
    contractError(label, `type must be "commonjs", got ${JSON.stringify(packageJson.type)}`);
  }
  const metadata = packageJson.oliphaunt;
  if (
    metadata?.product !== "oliphaunt-icu"
    || metadata?.kind !== "icu-data"
    || metadata?.target !== "portable"
    || metadata?.dataRelativePath !== ICU_DATA_RELATIVE_PATH
  ) {
    contractError(
      label,
      `must declare portable oliphaunt-icu metadata with dataRelativePath ${ICU_DATA_RELATIVE_PATH}`,
    );
  }
  if (!Array.isArray(packageJson.files)) {
    contractError(label, "files must be an array");
  }
  if (new Set(packageJson.files).size !== packageJson.files.length) {
    contractError(label, "files must not contain duplicate entries");
  }
  for (const member of [ICU_BUNDLE_DIRECTORY, ICU_PODSPEC, ICU_REACT_NATIVE_CONFIG]) {
    if (!packageJson.files.includes(member)) {
      contractError(label, `files must include ${member}`);
    }
  }
  const legacyEntries = packageJson.files.filter((member) =>
    typeof member === "string" && (member === "share" || member.startsWith("share/")),
  );
  if (legacyEntries.length > 0) {
    contractError(label, `files must not include the legacy ICU tree: ${legacyEntries.join(", ")}`);
  }
}

function normalizeEntries(entries, label) {
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry?.name;
    const isFile = typeof entry === "string" ? !entry.endsWith("/") : entry?.isFile === true;
    if (typeof name !== "string" || name.length === 0) {
      contractError(label, "archive inventory contains an invalid member name");
    }
    const normalizedName = name.replace(/\/$/u, "");
    if (seen.has(normalizedName)) {
      contractError(label, `archive inventory repeats member ${normalizedName}`);
    }
    seen.add(normalizedName);
    normalized.push({ name: normalizedName, isFile });
  }
  return normalized;
}

function isAtOrBelow(member, root) {
  return member === root || member.startsWith(`${root}/`);
}

function archiveFileManifest(entries, root, label) {
  const rows = entries instanceof Map
    ? [...entries].map(([name, entry]) => ({ ...entry, name }))
    : [...entries];
  const manifest = [];
  const seen = new Set();
  for (const entry of rows) {
    const name = entry?.name;
    if (typeof name !== "string" || !isAtOrBelow(name.replace(/\/$/u, ""), root)) {
      continue;
    }
    const normalizedName = name.replace(/\/$/u, "");
    if (normalizedName === root || entry?.isFile !== true) {
      continue;
    }
    const relative = normalizedName.slice(`${root}/`.length);
    if (!relative || seen.has(relative)) {
      contractError(label, `contains an invalid or repeated ICU data file ${relative || normalizedName}`);
    }
    seen.add(relative);
    const value = typeof entry.data === "function" ? entry.data() : entry.data;
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
      contractError(label, `cannot read ICU data file ${normalizedName}`);
    }
    const bytes = Buffer.from(value);
    if (entry.size !== undefined && entry.size !== bytes.length) {
      contractError(
        label,
        `ICU data file ${normalizedName} declares ${entry.size} bytes but contains ${bytes.length}`,
      );
    }
    manifest.push({
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      type: "file",
    });
  }
  if (manifest.length === 0) {
    contractError(label, `contains no readable ICU data files below ${root}`);
  }
  return manifest.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

export function assertIcuPackedDataMatchesSource({
  packedEntries,
  sourceEntries,
  label = "@oliphaunt/icu npm tarball",
  sourceLabel = "liboliphaunt ICU data release asset",
}) {
  const packed = archiveFileManifest(packedEntries, PACKED_DATA_ROOT, label);
  const source = archiveFileManifest(sourceEntries, "share/icu", sourceLabel);
  if (JSON.stringify(packed) === JSON.stringify(source)) {
    return;
  }

  const packedByPath = new Map(packed.map((entry) => [entry.path, entry]));
  const sourceByPath = new Map(source.map((entry) => [entry.path, entry]));
  const missing = source.filter((entry) => !packedByPath.has(entry.path)).map((entry) => entry.path);
  const unexpected = packed.filter((entry) => !sourceByPath.has(entry.path)).map((entry) => entry.path);
  const changed = source
    .filter((entry) => {
      const candidate = packedByPath.get(entry.path);
      return candidate !== undefined
        && (candidate.size !== entry.size || candidate.sha256 !== entry.sha256);
    })
    .map((entry) => entry.path);
  contractError(
    label,
    `ICU data differs from ${sourceLabel}`
      + ` (missing=${JSON.stringify(missing.slice(0, 5))}`
      + `, unexpected=${JSON.stringify(unexpected.slice(0, 5))}`
      + `, changed=${JSON.stringify(changed.slice(0, 5))})`,
  );
}

function icuTreeRoots(member) {
  const segments = member.split("/").filter(Boolean);
  const roots = [];
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === "share" && segments[index + 1] === "icu") {
      roots.push(segments.slice(0, index + 2).join("/"));
    }
  }
  return roots;
}

export function assertIcuPackedInventory(entries, label = "@oliphaunt/icu npm tarball") {
  const inventory = normalizeEntries(entries, label);
  const byName = new Map(inventory.map((entry) => [entry.name, entry]));
  for (const member of [
    `${PACKED_ROOT}/package.json`,
    `${PACKED_ROOT}/${ICU_PODSPEC}`,
    `${PACKED_ROOT}/${ICU_REACT_NATIVE_CONFIG}`,
  ]) {
    if (byName.get(member)?.isFile !== true) {
      contractError(label, `is missing file ${member}`);
    }
  }

  for (const { name } of inventory) {
    if (isAtOrBelow(name, LEGACY_PACKED_DATA_ROOT)) {
      contractError(label, `contains forbidden legacy ICU data member ${name}`);
    }
    for (const root of icuTreeRoots(name)) {
      if (root !== PACKED_DATA_ROOT) {
        contractError(label, `contains unexpected additional ICU data tree ${root}`);
      }
    }
  }

  const dataFiles = inventory.filter(({ name, isFile }) =>
    isFile && name.startsWith(`${PACKED_DATA_ROOT}/`),
  );
  if (dataFiles.length === 0) {
    contractError(label, `is missing ICU data files under ${PACKED_DATA_ROOT}`);
  }
  if (!dataFiles.some(({ name }) => {
    const relative = name.slice(`${PACKED_DATA_ROOT}/`.length).split("/").filter(Boolean);
    return relative.length > 0 && relative[0].startsWith("icudt");
  })) {
    contractError(label, `is missing ${PACKED_DATA_ROOT}/icudt* data files`);
  }
}

function assertSameBytes(actual, expected, label) {
  const actualBytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  if (!actualBytes.equals(expectedBytes)) {
    contractError(label, "packed bytes differ from the reviewed source descriptor");
  }
}

export function assertPackedIcuCarrier({
  entries,
  packageJson,
  packedConfig,
  packedPodspec,
  sourceConfig,
  sourcePodspec,
  label = "@oliphaunt/icu npm tarball",
}) {
  assertIcuPackageManifest(packageJson, `${label} package/package.json`);
  assertIcuPackedInventory(entries, label);
  assertIcuReactNativeConfig(sourceConfig, `source ${ICU_REACT_NATIVE_CONFIG}`);
  assertIcuPodspec(sourcePodspec, `source ${ICU_PODSPEC}`);
  assertSameBytes(packedConfig, sourceConfig, `${label} package/${ICU_REACT_NATIVE_CONFIG}`);
  assertSameBytes(packedPodspec, sourcePodspec, `${label} package/${ICU_PODSPEC}`);
  assertIcuReactNativeConfig(packedConfig, `${label} package/${ICU_REACT_NATIVE_CONFIG}`);
  assertIcuPodspec(packedPodspec, `${label} package/${ICU_PODSPEC}`);
}
