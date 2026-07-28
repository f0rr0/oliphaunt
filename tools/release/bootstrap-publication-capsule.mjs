#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedCarriers,
} from "./publication-lock.mjs";
import { ROOT, compareText } from "./release-graph.mjs";

export const BOOTSTRAP_CAPSULE_SCHEMA = "oliphaunt-bootstrap-publication-capsule-v1";
export const BOOTSTRAP_CAPSULE_MANIFEST_PATH = "target/release/bootstrap-capsule-manifest.json";
export const BOOTSTRAP_CAPSULE_LOCK_PATH = "target/release/publication-lock.json";

const BLOCK_SIZE = 512;
const END_MARKER_SIZE = BLOCK_SIZE * 2;
const COPY_BUFFER_SIZE = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function error(message) {
  return new Error(`bootstrap-publication-capsule: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeProducts(raw) {
  let products = raw;
  if (typeof raw === "string") {
    try {
      products = JSON.parse(raw);
    } catch (cause) {
      throw error(`products JSON is invalid: ${cause.message}`);
    }
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("products must be a non-empty unique string list");
  }
  return products.slice().sort(compareText);
}

function safeArchivePath(value, context) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.normalize("NFC") !== value
    || value.startsWith("/")
    || value.endsWith("/")
  ) {
    throw error(`${context} is not a canonical relative POSIX file path: ${JSON.stringify(value)}`);
  }
  const components = value.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw error(`${context} contains an unsafe path component: ${value}`);
  }
  if (components[0] !== "target") {
    throw error(`${context} must remain under target/: ${value}`);
  }
  return value;
}

function workspaceFile(root, relative, context) {
  const safe = safeArchivePath(relative, context);
  const file = path.resolve(root, ...safe.split("/"));
  const resolvedRoot = path.resolve(root);
  const within = path.relative(resolvedRoot, file);
  if (within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw error(`${context} escapes its workspace: ${relative}`);
  }
  return file;
}

function regularFileStat(file, context, maximum = Number.MAX_SAFE_INTEGER) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    throw error(`${context} is unavailable: ${cause.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw error(`${context} must be a regular non-symlink file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) {
    throw error(`${context} has an unsupported size ${stat.size}`);
  }
  return stat;
}

function openRegularNoFollow(file, context) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw error(`cannot open ${context} safely: ${cause.message}`);
  }
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) {
    closeSync(descriptor);
    throw error(`${context} must remain a regular file while it is read`);
  }
  return { descriptor, stat };
}

function readMetadataFile(file, context) {
  const stat = regularFileStat(file, context, MAX_METADATA_BYTES);
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) throw error(`${context} changed while it was read`);
  return bytes;
}

function hashRegularFile(file, context, expectedSize = undefined) {
  const { descriptor, stat } = openRegularNoFollow(file, context);
  try {
    if (expectedSize !== undefined && stat.size !== expectedSize) {
      throw error(`${context} size ${stat.size} does not match the frozen size ${expectedSize}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let position = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const finalStat = fstatSync(descriptor);
    if (position !== stat.size || finalStat.size !== stat.size) {
      throw error(`${context} changed while it was hashed`);
    }
    return { size: stat.size, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function sameStrings(left, right) {
  return stableJson(left.slice().sort(compareText)) === stableJson(right.slice().sort(compareText));
}

function selectedBootstrapCarriers(lock, products) {
  const selectedProducts = safeProducts(products);
  const lockedProducts = lock.products.map(({ id }) => id).sort(compareText);
  if (!sameStrings(selectedProducts, lockedProducts)) {
    throw error(
      `selected products do not exactly match the approved lock: selected=${JSON.stringify(selectedProducts)}, lock=${JSON.stringify(lockedProducts)}`,
    );
  }
  const selected = new Set(selectedProducts);
  const carriers = lockedCarriers(lock)
    .filter((carrier) => selected.has(carrier.product) && ["cargo", "npm"].includes(carrier.ecosystem))
    .slice()
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  const seenPaths = new Set();
  const caseFoldedPaths = new Map();
  return carriers.map((carrier) => {
    if (carrier.artifacts.length !== 1) {
      throw error(`${carrier.id} must freeze exactly one bootstrap artifact`);
    }
    const artifact = carrier.artifacts[0];
    const artifactPath = safeArchivePath(artifact.path, `${carrier.id} artifact path`);
    const expectedExtension = carrier.ecosystem === "cargo" ? ".crate" : ".tgz";
    if (!artifactPath.endsWith(expectedExtension)) {
      throw error(`${carrier.id} bootstrap artifact must end in ${expectedExtension}: ${artifactPath}`);
    }
    if (seenPaths.has(artifactPath)) {
      throw error(`bootstrap carriers reuse artifact path ${artifactPath}`);
    }
    seenPaths.add(artifactPath);
    const folded = artifactPath.toLocaleLowerCase("en-US");
    const prior = caseFoldedPaths.get(folded);
    if (prior !== undefined) {
      throw error(`bootstrap artifact paths collide by case: ${prior} and ${artifactPath}`);
    }
    caseFoldedPaths.set(folded, artifactPath);
    return {
      id: carrier.id,
      product: carrier.product,
      ecosystem: carrier.ecosystem,
      name: carrier.name,
      version: carrier.version,
      publishOrder: carrier.publishOrder,
      dependencies: carrier.dependencies.slice().sort(compareText),
      artifact: {
        path: artifactPath,
        size: artifact.size,
        sha256: artifact.sha256,
      },
    };
  });
}

function expectedManifest(lock, products, lockBytes) {
  const selectedProducts = safeProducts(products);
  const lockFile = {
    path: BOOTSTRAP_CAPSULE_LOCK_PATH,
    size: lockBytes.length,
    sha256: sha256(lockBytes),
  };
  return {
    schema: BOOTSTRAP_CAPSULE_SCHEMA,
    source: {
      commit: lock.source.commit,
      tree: lock.source.tree,
    },
    lockDigest: lock.lockDigest,
    packageEnvelopeDigest: lock.packageEnvelopeDigest,
    catalogDigest: lock.catalogDigest,
    products: selectedProducts,
    publicationLock: lockFile,
    carriers: selectedBootstrapCarriers(lock, selectedProducts),
  };
}

function verifyCarrierFiles(manifest, workspaceRoot) {
  for (const carrier of manifest.carriers) {
    const file = workspaceFile(workspaceRoot, carrier.artifact.path, `${carrier.id} artifact path`);
    const observed = hashRegularFile(file, carrier.id, carrier.artifact.size);
    if (observed.sha256 !== carrier.artifact.sha256) {
      throw error(`${carrier.id} bytes do not match the approved publication lock`);
    }
  }
}

function tarPathParts(relative) {
  const bytes = Buffer.byteLength(relative);
  if (bytes <= 100) return { name: relative, prefix: "" };
  const components = relative.split("/");
  for (let index = 1; index < components.length; index += 1) {
    const prefix = components.slice(0, index).join("/");
    const name = components.slice(index).join("/");
    if (name.length > 0 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw error(`archive path is too long for canonical ustar: ${relative}`);
}

function writeString(buffer, offset, length, value, context) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw error(`${context} exceeds its ustar field`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value, context) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(`${context} is not a safe non-negative integer`);
  const text = value.toString(8);
  if (text.length > length - 1) throw error(`${context} exceeds its ustar field`);
  writeString(buffer, offset, length, `${text.padStart(length - 1, "0")}\0`, context);
}

function tarHeader(relative, size) {
  const safe = safeArchivePath(relative, "archive member path");
  const { name, prefix } = tarPathParts(safe);
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeString(header, 0, 100, name, `${safe} name`);
  writeOctal(header, 100, 8, 0o644, `${safe} mode`);
  writeOctal(header, 108, 8, 0, `${safe} uid`);
  writeOctal(header, 116, 8, 0, `${safe} gid`);
  writeOctal(header, 124, 12, size, `${safe} size`);
  writeOctal(header, 136, 12, 0, `${safe} mtime`);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0", `${safe} type`);
  writeString(header, 257, 6, "ustar\0", `${safe} magic`);
  writeString(header, 263, 2, "00", `${safe} version`);
  writeString(header, 345, 155, prefix, `${safe} prefix`);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) throw error(`${safe} ustar checksum exceeds its field`);
  writeString(header, 148, 8, `${checksumText.padStart(6, "0")}\0 `, `${safe} checksum`);
  return header;
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function copyFileIntoTar(output, source, expected) {
  const { descriptor, stat } = openRegularNoFollow(source, expected.path);
  try {
    if (stat.size !== expected.size) {
      throw error(`${expected.path} size changed before capsule creation`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let position = 0;
    while (position < expected.size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, expected.size - position),
        position,
      );
      if (count === 0) throw error(`${expected.path} was truncated during capsule creation`);
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      writeAll(output, bytes);
      position += count;
    }
    const finalStat = fstatSync(descriptor);
    if (finalStat.size !== stat.size || hash.digest("hex") !== expected.sha256) {
      throw error(`${expected.path} changed or differs from the approved publication lock`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function atomicTar(output, entries) {
  const destination = path.resolve(output);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) throw error(`refusing to overwrite existing capsule ${destination}`);
  const temporaryRoot = mkdtempSync(path.join(path.dirname(destination), ".bootstrap-capsule-pack-"));
  const temporary = path.join(temporaryRoot, "capsule.tar");
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    for (const entry of entries) {
      writeAll(descriptor, tarHeader(entry.path, entry.size));
      if (entry.bytes !== undefined) {
        writeAll(descriptor, entry.bytes);
      } else {
        copyFileIntoTar(descriptor, entry.source, entry);
      }
      const remainder = entry.size % BLOCK_SIZE;
      if (remainder !== 0) writeAll(descriptor, Buffer.alloc(BLOCK_SIZE - remainder, 0));
    }
    writeAll(descriptor, Buffer.alloc(END_MARKER_SIZE, 0));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function capsuleEntries(lock, products, lockBytes, workspaceRoot) {
  const manifest = expectedManifest(lock, products, lockBytes);
  verifyCarrierFiles(manifest, workspaceRoot);
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const entries = [
    {
      path: BOOTSTRAP_CAPSULE_MANIFEST_PATH,
      size: manifestBytes.length,
      sha256: sha256(manifestBytes),
      bytes: manifestBytes,
    },
    {
      path: BOOTSTRAP_CAPSULE_LOCK_PATH,
      size: lockBytes.length,
      sha256: sha256(lockBytes),
      bytes: lockBytes,
    },
    ...manifest.carriers.map(({ artifact }) => ({
      path: artifact.path,
      size: artifact.size,
      sha256: artifact.sha256,
      source: workspaceFile(workspaceRoot, artifact.path, "locked carrier artifact"),
    })),
  ].sort((left, right) => compareText(left.path, right.path));
  const folded = new Map();
  for (const entry of entries) {
    const key = entry.path.toLocaleLowerCase("en-US");
    const prior = folded.get(key);
    if (prior !== undefined) throw error(`capsule paths collide by case: ${prior} and ${entry.path}`);
    folded.set(key, entry.path);
  }
  return { entries, manifest };
}

export function packBootstrapCapsule({
  lockFile,
  products,
  headRef = "HEAD",
  output,
  workspaceRoot = ROOT,
}) {
  const lockPath = path.resolve(lockFile);
  const lockBytes = readMetadataFile(lockPath, "approved publication lock");
  const lock = loadPublicationLock(lockPath);
  assertPublicationLockSource(lock, headRef);
  const { entries, manifest } = capsuleEntries(lock, products, lockBytes, workspaceRoot);
  atomicTar(output, entries);
  return manifest;
}

function readExact(descriptor, buffer, position, context) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0) throw error(`${context} is truncated`);
    offset += count;
  }
}

function tarString(header, offset, length, context) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    throw error(`${context} contains bytes after its NUL terminator`);
  }
  try {
    return UTF8.decode(field.subarray(0, end));
  } catch {
    throw error(`${context} is not valid UTF-8`);
  }
}

function tarOctal(header, offset, length, context) {
  const value = tarString(header, offset, length, context).trim();
  if (!/^[0-7]+$/u.test(value)) throw error(`${context} is not canonical octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw error(`${context} is outside the safe integer range`);
  return parsed;
}

function parseCanonicalHeader(header) {
  const name = tarString(header, 0, 100, "ustar name");
  const prefix = tarString(header, 345, 155, "ustar prefix");
  const relative = safeArchivePath(prefix ? `${prefix}/${name}` : name, "ustar member path");
  const size = tarOctal(header, 124, 12, `${relative} size`);
  const expected = tarHeader(relative, size);
  if (!header.equals(expected)) throw error(`${relative} has a non-canonical ustar header`);
  return { path: relative, size };
}

function ensureParentDirectories(root, relative) {
  const components = relative.split("/");
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      mkdirSync(current, { mode: 0o755 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw error(`capsule extraction parent is not a regular directory: ${current}`);
    }
  }
}

function extractCanonicalTar(transport, stage) {
  const archiveStat = regularFileStat(transport, "bootstrap capsule transport");
  const { descriptor } = openRegularNoFollow(transport, "bootstrap capsule transport");
  const observed = [];
  const names = new Set();
  const folded = new Map();
  let position = 0;
  let zeroBlocks = 0;
  try {
    while (position < archiveStat.size) {
      const header = Buffer.alloc(BLOCK_SIZE);
      readExact(descriptor, header, position, "bootstrap capsule transport");
      position += BLOCK_SIZE;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      if (zeroBlocks > 0) throw error("bootstrap capsule has an incomplete ustar end marker");
      if (observed.length >= MAX_ARCHIVE_ENTRIES) throw error(`bootstrap capsule exceeds ${MAX_ARCHIVE_ENTRIES} entries`);
      const entry = parseCanonicalHeader(header);
      if (names.has(entry.path)) throw error(`bootstrap capsule repeats ${entry.path}`);
      names.add(entry.path);
      const caseKey = entry.path.toLocaleLowerCase("en-US");
      const prior = folded.get(caseKey);
      if (prior !== undefined) throw error(`bootstrap capsule paths collide by case: ${prior} and ${entry.path}`);
      folded.set(caseKey, entry.path);
      const target = workspaceFile(stage, entry.path, "capsule member path");
      ensureParentDirectories(stage, entry.path);
      const output = openSync(target, "wx", 0o644);
      const hash = createHash("sha256");
      try {
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
        let remaining = entry.size;
        while (remaining > 0) {
          const count = Math.min(buffer.length, remaining);
          readExact(descriptor, buffer.subarray(0, count), position, `${entry.path} payload`);
          const bytes = buffer.subarray(0, count);
          hash.update(bytes);
          writeAll(output, bytes);
          position += count;
          remaining -= count;
        }
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      const remainder = entry.size % BLOCK_SIZE;
      if (remainder !== 0) {
        const padding = Buffer.alloc(BLOCK_SIZE - remainder);
        readExact(descriptor, padding, position, `${entry.path} padding`);
        if (padding.some((byte) => byte !== 0)) throw error(`${entry.path} has nonzero ustar padding`);
        position += padding.length;
      }
      observed.push({ ...entry, sha256: hash.digest("hex") });
    }
    if (zeroBlocks !== 2) throw error("bootstrap capsule is missing its two-block ustar end marker");
    if (position !== archiveStat.size) throw error("bootstrap capsule contains bytes after its ustar end marker");
    if (observed.map(({ path: member }) => member).join("\n") !== observed.map(({ path: member }) => member).sort(compareText).join("\n")) {
      throw error("bootstrap capsule members are not in canonical path order");
    }
    return observed;
  } finally {
    closeSync(descriptor);
  }
}

function parseManifest(file) {
  const bytes = readMetadataFile(file, "bootstrap capsule manifest");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw error(`bootstrap capsule manifest is invalid JSON: ${cause.message}`);
  }
  return { bytes, manifest };
}

function verifyObservedEntries(observed, expectedEntries) {
  const actual = observed.map(({ path: member, size, sha256: digest }) => ({ path: member, size, sha256: digest }));
  const expected = expectedEntries.map(({ path: member, size, sha256: digest }) => ({ path: member, size, sha256: digest }));
  if (stableJson(actual) !== stableJson(expected)) {
    throw error(`capsule file set or bytes differ from the approved lock: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
  }
}

export function verifyExtractBootstrapCapsule({
  transport,
  approvedLock,
  products,
  headRef = "HEAD",
  workspaceRoot,
}) {
  const root = path.resolve(workspaceRoot);
  const rootStat = statSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw error(`workspace root must be an existing regular directory: ${root}`);
  }
  const destination = path.join(root, "target");
  if (existsSync(destination)) {
    throw error(`atomic capsule installation requires an absent destination: ${destination}`);
  }
  const approvedLockBytes = readMetadataFile(path.resolve(approvedLock), "separately downloaded approved publication lock");
  const stage = mkdtempSync(path.join(root, ".bootstrap-capsule-extract-"));
  try {
    const observed = extractCanonicalTar(path.resolve(transport), stage);
    const embeddedLockFile = workspaceFile(stage, BOOTSTRAP_CAPSULE_LOCK_PATH, "embedded publication lock path");
    const embeddedLockBytes = readMetadataFile(embeddedLockFile, "embedded publication lock");
    if (!embeddedLockBytes.equals(approvedLockBytes)) {
      throw error("embedded publication lock is not byte-identical to the separately downloaded approved lock");
    }
    const lock = loadPublicationLock(embeddedLockFile);
    assertPublicationLockSource(lock, headRef);
    const expected = capsuleEntries(lock, products, embeddedLockBytes, stage);
    const manifestFile = workspaceFile(stage, BOOTSTRAP_CAPSULE_MANIFEST_PATH, "capsule manifest path");
    const parsed = parseManifest(manifestFile);
    const expectedManifestBytes = Buffer.from(canonicalJson(expected.manifest));
    if (!parsed.bytes.equals(expectedManifestBytes) || stableJson(parsed.manifest) !== stableJson(expected.manifest)) {
      throw error("bootstrap capsule manifest does not exactly describe the approved lock and selected products");
    }
    verifyObservedEntries(observed, expected.entries);
    renameSync(path.join(stage, "target"), destination);
    return expected.manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["pack", "verify-extract"]).has(command)) {
    throw error(
      "usage: bootstrap-publication-capsule.mjs <pack|verify-extract> --products-json JSON --head-ref SHA "
        + "[--lock FILE --output FILE | --transport FILE --approved-lock FILE --workspace-root DIR]",
    );
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw error(`invalid or missing value for ${flag ?? "argument"}`);
    }
    const name = flag.slice(2);
    if (values.has(name)) throw error(`duplicate --${name}`);
    values.set(name, value);
  }
  const allowed = command === "pack"
    ? new Set(["lock", "products-json", "head-ref", "output"])
    : new Set(["transport", "approved-lock", "products-json", "head-ref", "workspace-root"]);
  const unknown = [...values.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw error(`unsupported ${command} arguments: ${unknown.map((name) => `--${name}`).join(" ")}`);
  const missing = [...allowed].filter((name) => !values.get(name));
  if (missing.length > 0) throw error(`${command} requires ${missing.map((name) => `--${name}`).join(" ")}`);
  return { command, values };
}

function main(argv) {
  const { command, values } = parseArgs(argv);
  if (command === "pack") {
    const manifest = packBootstrapCapsule({
      lockFile: values.get("lock"),
      products: values.get("products-json"),
      headRef: values.get("head-ref"),
      output: values.get("output"),
    });
    console.log(
      `packed ${manifest.carriers.length} Cargo/npm carriers from approved lock ${manifest.lockDigest} into ${values.get("output")}`,
    );
    return;
  }
  const manifest = verifyExtractBootstrapCapsule({
    transport: values.get("transport"),
    approvedLock: values.get("approved-lock"),
    products: values.get("products-json"),
    headRef: values.get("head-ref"),
    workspaceRoot: values.get("workspace-root"),
  });
  console.log(
    `verified and atomically installed ${manifest.carriers.length} Cargo/npm carriers from approved lock ${manifest.lockDigest}`,
  );
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
