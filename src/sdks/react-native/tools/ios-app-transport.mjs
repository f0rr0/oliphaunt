#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const PREFIX = "ios-app-transport.mjs";
export const TRANSPORT_SCHEMA = "oliphaunt-react-native-ios-app-transport-v1";
export const ARCHIVE_NAME = "react-native-mobile-ios-app.zip";
export const MANIFEST_NAME = "react-native-mobile-ios-app.manifest.json";
export const BUILD_REPORT_NAME = "build-report.json";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_EOCD_MAX_BYTES = 22 + 0xffff;
const ZIP_MAX_CENTRAL_BYTES = 256 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 1_000_000;
const ZIP_MAX_MEMBER_NAME_BYTES = 4096;
const ZIP_MAX_SYMLINK_TARGET_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  return `usage:
  ${PREFIX} pack --app-dir DIR --transport-dir DIR [--build-report FILE]
  ${PREFIX} verify-extract --transport-dir DIR --output-dir DIR`;
}

function parseFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || flag === "--help") {
      fail(`unknown argument ${JSON.stringify(flag)}\n${usage()}`);
    }
    if (values.has(flag)) {
      fail(`argument ${flag} must not be repeated`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${flag} requires a value`);
    }
    values.set(flag, value);
    index += 1;
  }
  return values;
}

function requireOnlyFlags(values, allowed) {
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) {
      fail(`unknown argument ${flag}\n${usage()}`);
    }
  }
}

function requiredFlag(values, flag) {
  const value = values.get(flag);
  if (!value) {
    fail(`${flag} is required\n${usage()}`);
  }
  return path.resolve(value);
}

function parseArgs(argv) {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!new Set(["pack", "verify-extract"]).has(command)) {
    fail(`expected pack or verify-extract\n${usage()}`);
  }
  const values = parseFlags(argv.slice(1));
  if (command === "pack") {
    requireOnlyFlags(values, new Set(["--app-dir", "--transport-dir", "--build-report"]));
    return {
      command,
      appDir: requiredFlag(values, "--app-dir"),
      transportDir: requiredFlag(values, "--transport-dir"),
      buildReport: values.has("--build-report")
        ? path.resolve(values.get("--build-report"))
        : undefined,
    };
  }
  requireOnlyFlags(values, new Set(["--transport-dir", "--output-dir"]));
  return {
    command,
    transportDir: requiredFlag(values, "--transport-dir"),
    outputDir: requiredFlag(values, "--output-dir"),
  };
}

async function statOrUndefined(file, { follow = true } = {}) {
  try {
    return follow ? await fs.stat(file) : await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireDirectory(directory, label) {
  if ((await statOrUndefined(directory, { follow: false }))?.isDirectory() !== true) {
    fail(`${label} is not a directory: ${directory}`);
  }
}

async function requireRegularFile(file, label) {
  const stat = await statOrUndefined(file, { follow: false });
  if (stat?.isFile() !== true || stat.size === 0) {
    fail(`${label} is missing, empty, or not a regular file: ${file}`);
  }
  return stat;
}

async function findCommand(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  fail(
    `required Apple command ${name} was not found; ` +
      "run this operation on macOS with ditto and plutil available",
  );
}

async function appleTools() {
  return {
    ditto: await findCommand("ditto"),
    plutil: await findCommand("plutil"),
  };
}

function run(command, args, { cwd = undefined, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    fail(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function safeLeaf(value, label, suffix = undefined) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.basename(value) !== value
  ) {
    fail(`${label} must be a safe filename; got ${JSON.stringify(value)}`);
  }
  if (suffix !== undefined && !value.endsWith(suffix)) {
    fail(`${label} must end in ${suffix}; got ${JSON.stringify(value)}`);
  }
  return value;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function payloadIdentity(app) {
  const hash = createHash("sha256");
  let entries = 0;

  async function visit(file, relative) {
    const stat = await fs.lstat(file);
    const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
    let row;
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file);
      if (path.isAbsolute(target) || !inside(app, path.resolve(path.dirname(file), target))) {
        fail(`app bundle contains unsafe symlink ${relative} -> ${target}`);
      }
      row = { mode, path: relative, target, type: "symlink" };
    } else if (stat.isDirectory()) {
      row = { mode, path: relative, type: "directory" };
    } else if (stat.isFile()) {
      row = {
        bytes: stat.size,
        mode,
        path: relative,
        sha256: await sha256File(file),
        type: "file",
      };
    } else {
      fail(`app bundle contains unsupported special entry: ${relative}`);
    }
    hash.update(`${JSON.stringify(row)}\n`);
    entries += 1;

    if (stat.isDirectory()) {
      const children = await fs.readdir(file);
      children.sort(compareNames);
      for (const child of children) {
        const childRelative = relative === "." ? child : `${relative}/${child}`;
        await visit(path.join(file, child), childRelative);
      }
    }
  }

  await visit(app, ".");
  return { entries, sha256: hash.digest("hex") };
}

async function directApps(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
    .sort((left, right) => compareNames(left.name, right.name));
}

async function exactlyOneApp(directory, expectedName = undefined) {
  const apps = await directApps(directory);
  if (apps.length !== 1) {
    fail(
      `${directory} must contain exactly one direct .app directory; ` +
        `found ${apps.length}${apps.length > 0 ? `: ${apps.map(({ name }) => name).join(", ")}` : ""}`,
    );
  }
  if (expectedName !== undefined && apps[0].name !== expectedName) {
    fail(`${directory} contains ${apps[0].name}, but the manifest requires ${expectedName}`);
  }
  return apps[0];
}

async function requireExactDirectEntries(directory, expected, label) {
  const actual = (await fs.readdir(directory)).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} entries must be ${JSON.stringify(wanted)}; got ${JSON.stringify(actual)}`);
  }
}

async function appIdentity(app, plutil) {
  const appName = safeLeaf(path.basename(app), "app bundle name", ".app");
  const infoPlist = path.join(app, "Info.plist");
  await requireRegularFile(infoPlist, `${appName} Info.plist`);
  const executable = safeLeaf(
    run(
      plutil,
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlist],
      { label: `${appName} CFBundleExecutable lookup` },
    ).trim(),
    `${appName} CFBundleExecutable`,
  );
  const executableFile = path.join(app, executable);
  const executableStat = await requireRegularFile(executableFile, `${appName} executable`);
  try {
    await fs.access(executableFile, fs.constants.X_OK);
  } catch {
    fail(`${appName} executable is not executable: ${executableFile}`);
  }
  return {
    executable,
    executableMode: (executableStat.mode & 0o7777).toString(8).padStart(4, "0"),
    infoPlistSha256: await sha256File(infoPlist),
    name: appName,
    payload: await payloadIdentity(app),
  };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!object(value)) fail(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be ${JSON.stringify(wanted)}; got ${JSON.stringify(actual)}`);
  }
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(`${label} must be a ${positive ? "positive " : "non-negative "}safe integer`);
  }
  return value;
}

async function readJson(file, label) {
  await requireRegularFile(file, label);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function reportIdentity(data, { appName, bytes, sha256 }) {
  if (!object(data)) fail(`${BUILD_REPORT_NAME} must contain a JSON object`);
  if (data.schema !== "oliphaunt-react-native-mobile-build-v1") {
    fail(`${BUILD_REPORT_NAME} has invalid schema ${JSON.stringify(data.schema)}`);
  }
  if (data.platform !== "ios") {
    fail(`${BUILD_REPORT_NAME} must declare platform=ios`);
  }
  if (typeof data.appArtifact !== "string" || path.basename(data.appArtifact) !== appName) {
    fail(`${BUILD_REPORT_NAME} appArtifact must identify ${appName}`);
  }
  safeInteger(data.appArtifactBytes, `${BUILD_REPORT_NAME} appArtifactBytes`);
  for (const key of ["configuration", "sdk"]) {
    if (data[key] !== undefined && typeof data[key] !== "string") {
      fail(`${BUILD_REPORT_NAME} ${key} must be a string when present`);
    }
  }
  return {
    appArtifactBytes: data.appArtifactBytes,
    appArtifactName: appName,
    bytes,
    configuration: data.configuration ?? null,
    name: BUILD_REPORT_NAME,
    platform: data.platform,
    schema: data.schema,
    sdk: data.sdk ?? null,
    sha256,
  };
}

async function loadBuildReport(file, appName) {
  const stat = await requireRegularFile(file, "iOS mobile build report");
  const sha256 = await sha256File(file);
  const data = await readJson(file, "iOS mobile build report");
  return { identity: reportIdentity(data, { appName, bytes: stat.size, sha256 }) };
}

function validateReportIdentity(value) {
  exactKeys(
    value,
    [
      "appArtifactBytes",
      "appArtifactName",
      "bytes",
      "configuration",
      "name",
      "platform",
      "schema",
      "sdk",
      "sha256",
    ],
    "transport manifest buildReport",
  );
  if (value.name !== BUILD_REPORT_NAME) fail(`transport build report name must be ${BUILD_REPORT_NAME}`);
  if (value.schema !== "oliphaunt-react-native-mobile-build-v1" || value.platform !== "ios") {
    fail("transport build report identity must describe an iOS mobile build report");
  }
  safeLeaf(value.appArtifactName, "transport build report appArtifactName", ".app");
  safeInteger(value.appArtifactBytes, "transport build report appArtifactBytes");
  safeInteger(value.bytes, "transport build report bytes", { positive: true });
  sha256Value(value.sha256, "transport build report sha256");
  for (const key of ["configuration", "sdk"]) {
    if (value[key] !== null && typeof value[key] !== "string") {
      fail(`transport build report ${key} must be a string or null`);
    }
  }
}

function validateManifest(data) {
  exactKeys(data, ["app", "archive", "buildReport", "schema"], "transport manifest");
  if (data.schema !== TRANSPORT_SCHEMA) {
    fail(`transport manifest schema must be ${TRANSPORT_SCHEMA}; got ${JSON.stringify(data.schema)}`);
  }
  exactKeys(data.archive, ["bytes", "format", "name", "sha256"], "transport manifest archive");
  if (data.archive.name !== ARCHIVE_NAME || data.archive.format !== "ditto-zip") {
    fail(`transport archive must be ${ARCHIVE_NAME} in ditto-zip format`);
  }
  safeInteger(data.archive.bytes, "transport archive bytes", { positive: true });
  sha256Value(data.archive.sha256, "transport archive sha256");

  exactKeys(
    data.app,
    ["executable", "executableMode", "infoPlistSha256", "name", "payload"],
    "transport manifest app",
  );
  safeLeaf(data.app.name, "transport app name", ".app");
  safeLeaf(data.app.executable, "transport app executable");
  if (typeof data.app.executableMode !== "string" || !/^[0-7]{4}$/u.test(data.app.executableMode)) {
    fail("transport app executableMode must be a four-digit octal mode");
  }
  if ((Number.parseInt(data.app.executableMode, 8) & 0o111) === 0) {
    fail("transport app executableMode must include an executable bit");
  }
  sha256Value(data.app.infoPlistSha256, "transport app Info.plist sha256");
  exactKeys(data.app.payload, ["entries", "sha256"], "transport manifest app payload");
  safeInteger(data.app.payload.entries, "transport app payload entries", { positive: true });
  sha256Value(data.app.payload.sha256, "transport app payload sha256");

  if (data.buildReport !== null) {
    validateReportIdentity(data.buildReport);
    if (data.buildReport.appArtifactName !== data.app.name) {
      fail("transport build report and app names do not match");
    }
  }
  return data;
}

async function readAt(handle, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    fail(`${label} has an invalid byte range`);
  }
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      length - consumed,
      offset + consumed,
    );
    if (bytesRead === 0) {
      fail(`${label} is truncated at byte ${offset + consumed}`);
    }
    consumed += bytesRead;
  }
  return buffer;
}

function safeZipNumber(value, label) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(`${label} exceeds the JavaScript safe-integer range`);
    }
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function extraFields(buffer, label) {
  const fields = new Map();
  let cursor = 0;
  while (cursor < buffer.length) {
    if (cursor + 4 > buffer.length) fail(`${label} has a truncated extra-field header`);
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > buffer.length) fail(`${label} has a truncated 0x${id.toString(16)} extra field`);
    if (fields.has(id)) fail(`${label} repeats extra field 0x${id.toString(16)}`);
    fields.set(id, buffer.subarray(cursor, cursor + size));
    cursor += size;
  }
  return fields;
}

function zip64EntryValues({
  compressedSize,
  diskStart,
  extra,
  localOffset,
  uncompressedSize,
  label,
}) {
  const needed =
    uncompressedSize === 0xffffffff ||
    compressedSize === 0xffffffff ||
    localOffset === 0xffffffff ||
    diskStart === 0xffff;
  if (!needed) {
    return { compressedSize, diskStart, localOffset, uncompressedSize };
  }
  const zip64 = extraFields(extra, label).get(ZIP64_EXTRA_ID);
  if (zip64 === undefined) fail(`${label} requires a ZIP64 extra field`);
  let cursor = 0;
  const read64 = (field) => {
    if (cursor + 8 > zip64.length) fail(`${label} ZIP64 ${field} is truncated`);
    const value = safeZipNumber(zip64.readBigUInt64LE(cursor), `${label} ZIP64 ${field}`);
    cursor += 8;
    return value;
  };
  const read32 = (field) => {
    if (cursor + 4 > zip64.length) fail(`${label} ZIP64 ${field} is truncated`);
    const value = zip64.readUInt32LE(cursor);
    cursor += 4;
    return value;
  };
  if (uncompressedSize === 0xffffffff) uncompressedSize = read64("uncompressed size");
  if (compressedSize === 0xffffffff) compressedSize = read64("compressed size");
  if (localOffset === 0xffffffff) localOffset = read64("local-header offset");
  if (diskStart === 0xffff) diskStart = read32("disk start");
  return { compressedSize, diskStart, localOffset, uncompressedSize };
}

async function zipDirectory(handle, archiveSize) {
  if (archiveSize < 22) fail("iOS app ZIP is too short to contain an end-of-central-directory record");
  const tailSize = Math.min(archiveSize, ZIP_EOCD_MAX_BYTES);
  const tailOffset = archiveSize - tailSize;
  const tail = await readAt(handle, tailOffset, tailSize, "iOS app ZIP tail");
  let eocdIndex = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue;
    const commentBytes = tail.readUInt16LE(index + 20);
    if (index + 22 + commentBytes === tail.length) {
      eocdIndex = index;
      break;
    }
  }
  if (eocdIndex < 0) fail("iOS app ZIP has no well-formed end-of-central-directory record");

  const eocdOffset = tailOffset + eocdIndex;
  const disk = tail.readUInt16LE(eocdIndex + 4);
  const centralDisk = tail.readUInt16LE(eocdIndex + 6);
  let diskEntries = tail.readUInt16LE(eocdIndex + 8);
  let entries = tail.readUInt16LE(eocdIndex + 10);
  let centralSize = tail.readUInt32LE(eocdIndex + 12);
  let centralOffset = tail.readUInt32LE(eocdIndex + 16);
  let centralBoundary = eocdOffset;
  const zip64 =
    disk === 0xffff ||
    centralDisk === 0xffff ||
    diskEntries === 0xffff ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff;

  if (zip64) {
    if (eocdOffset < 20) fail("iOS app ZIP64 locator is missing");
    const locator = await readAt(handle, eocdOffset - 20, 20, "iOS app ZIP64 locator");
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
      fail("iOS app ZIP64 locator has an invalid signature");
    }
    const zip64Disk = locator.readUInt32LE(4);
    const zip64Offset = safeZipNumber(locator.readBigUInt64LE(8), "iOS app ZIP64 record offset");
    const totalDisks = locator.readUInt32LE(16);
    if (zip64Disk !== 0 || totalDisks !== 1) fail("multi-disk iOS app ZIP64 archives are not supported");
    const record = await readAt(handle, zip64Offset, 56, "iOS app ZIP64 end record");
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      fail("iOS app ZIP64 end record has an invalid signature");
    }
    const recordBytes = safeZipNumber(record.readBigUInt64LE(4), "iOS app ZIP64 record size");
    const locatorOffset = eocdOffset - 20;
    if (
      recordBytes < 44 ||
      zip64Offset > locatorOffset ||
      locatorOffset - zip64Offset < 12 ||
      recordBytes !== locatorOffset - zip64Offset - 12
    ) {
      fail("iOS app ZIP64 end record has an invalid extent");
    }
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
      fail("multi-disk iOS app ZIP64 archives are not supported");
    }
    diskEntries = safeZipNumber(record.readBigUInt64LE(24), "iOS app ZIP64 disk entry count");
    entries = safeZipNumber(record.readBigUInt64LE(32), "iOS app ZIP64 entry count");
    centralSize = safeZipNumber(record.readBigUInt64LE(40), "iOS app ZIP64 central size");
    centralOffset = safeZipNumber(record.readBigUInt64LE(48), "iOS app ZIP64 central offset");
    centralBoundary = zip64Offset;
  } else if (disk !== 0 || centralDisk !== 0) {
    fail("multi-disk iOS app ZIP archives are not supported");
  }

  if (diskEntries !== entries) fail("iOS app ZIP central-directory entry counts do not match");
  if (entries === 0 || entries > ZIP_MAX_ENTRIES) {
    fail(`iOS app ZIP entry count must be between 1 and ${ZIP_MAX_ENTRIES}`);
  }
  if (centralSize === 0 || centralSize > ZIP_MAX_CENTRAL_BYTES) {
    fail(`iOS app ZIP central directory must be between 1 and ${ZIP_MAX_CENTRAL_BYTES} bytes`);
  }
  if (
    centralBoundary > archiveSize ||
    centralOffset > centralBoundary ||
    centralSize !== centralBoundary - centralOffset
  ) {
    fail("iOS app ZIP central directory has an invalid or ambiguous extent");
  }
  return { centralOffset, centralSize, entries, zip64 };
}

function decodeZipName(buffer, label) {
  if (buffer.length === 0 || buffer.length > ZIP_MAX_MEMBER_NAME_BYTES) {
    fail(`${label} must contain between 1 and ${ZIP_MAX_MEMBER_NAME_BYTES} filename bytes`);
  }
  try {
    return UTF8.decode(buffer);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function zipMemberPath(name, appName) {
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/u.test(name) ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    fail(`iOS app ZIP contains unsafe member path ${JSON.stringify(name)}`);
  }
  const directory = name.endsWith("/");
  const components = name.split("/");
  if (directory) components.pop();
  if (
    components.length === 0 ||
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        Buffer.byteLength(component, "utf8") > 255,
    )
  ) {
    fail(`iOS app ZIP contains unsafe member path ${JSON.stringify(name)}`);
  }
  const metadata = components[0] === "__MACOSX";
  if (!metadata && components[0] !== appName) {
    fail(`iOS app ZIP member is outside ${appName}: ${JSON.stringify(name)}`);
  }
  if (metadata) {
    if (components.length === 1 && !directory) {
      fail("iOS app ZIP __MACOSX root must be a directory");
    }
    if (
      components.length > 1 &&
      components[1] !== appName &&
      components[1] !== `._${appName}`
    ) {
      fail(`iOS app ZIP metadata member is unrelated to ${appName}: ${JSON.stringify(name)}`);
    }
  }
  return {
    canonical: components.join("/"),
    directory,
    metadata,
    normalized: components.join("/").normalize("NFC"),
  };
}

function portableCaseFold(value) {
  // NFKC expands compatibility characters and the upper/lower round-trip
  // catches multi-code-point folds such as sharp-s. This is deliberately
  // conservative across the case-insensitive filesystems a macOS runner may
  // use during extraction.
  return value.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

function zipMemberType(versionMadeBy, externalAttributes, directoryHint, name) {
  const host = versionMadeBy >>> 8;
  const mode = externalAttributes >>> 16;
  const unixType = mode & 0o170000;
  let type;
  if (unixType !== 0) {
    type = new Map([
      [0o040000, "directory"],
      [0o100000, "file"],
      [0o120000, "symlink"],
    ]).get(unixType);
    if (type === undefined) {
      fail(
        `iOS app ZIP member ${JSON.stringify(name)} uses unsupported special mode ` +
          `0${unixType.toString(8)} from host ${host}`,
      );
    }
  } else {
    type = (externalAttributes & 0x10) !== 0 || directoryHint ? "directory" : "file";
  }
  if ((type === "directory") !== directoryHint) {
    fail(`iOS app ZIP member ${JSON.stringify(name)} has inconsistent directory metadata`);
  }
  return type;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function validateZipLocalEntry(handle, entry, centralOffset) {
  if (entry.localOffset > centralOffset || centralOffset - entry.localOffset < 30) {
    fail(`iOS app ZIP local header for ${JSON.stringify(entry.name)} is outside the payload region`);
  }
  const header = await readAt(
    handle,
    entry.localOffset,
    30,
    `iOS app ZIP local header for ${entry.name}`,
  );
  if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
    fail(`iOS app ZIP local header for ${JSON.stringify(entry.name)} has an invalid signature`);
  }
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const checksum = header.readUInt32LE(14);
  const compressed32 = header.readUInt32LE(18);
  const uncompressed32 = header.readUInt32LE(22);
  const nameBytes = header.readUInt16LE(26);
  const extraBytes = header.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method) {
    fail(`iOS app ZIP local header metadata does not match ${JSON.stringify(entry.name)}`);
  }
  const localName = await readAt(
    handle,
    entry.localOffset + 30,
    nameBytes,
    `iOS app ZIP local filename for ${entry.name}`,
  );
  if (!localName.equals(entry.rawName)) {
    fail(`iOS app ZIP local header filename does not match central member ${JSON.stringify(entry.name)}`);
  }
  const localExtra = await readAt(
    handle,
    entry.localOffset + 30 + nameBytes,
    extraBytes,
    `iOS app ZIP local extra fields for ${entry.name}`,
  );
  const localSizes = zip64EntryValues({
    compressedSize: compressed32,
    diskStart: 0,
    extra: localExtra,
    label: `iOS app ZIP local header ${JSON.stringify(entry.name)}`,
    localOffset: 0,
    uncompressedSize: uncompressed32,
  });
  const descriptor = (flags & 0x0008) !== 0;
  if (descriptor) {
    if (checksum !== 0 && checksum !== entry.crc32) {
      fail(`iOS app ZIP local CRC disagrees with central member ${JSON.stringify(entry.name)}`);
    }
    for (const [label, raw, resolved, expected] of [
      ["compressed size", compressed32, localSizes.compressedSize, entry.compressedSize],
      ["uncompressed size", uncompressed32, localSizes.uncompressedSize, entry.uncompressedSize],
    ]) {
      if (raw !== 0 && resolved !== 0 && resolved !== expected) {
        fail(`iOS app ZIP local ${label} disagrees with central member ${JSON.stringify(entry.name)}`);
      }
    }
  } else if (
    checksum !== entry.crc32 ||
    localSizes.compressedSize !== entry.compressedSize ||
    localSizes.uncompressedSize !== entry.uncompressedSize
  ) {
    fail(`iOS app ZIP local CRC or sizes disagree with central member ${JSON.stringify(entry.name)}`);
  }
  const headerBytes = 30 + nameBytes + extraBytes;
  if (entry.localOffset > centralOffset || headerBytes > centralOffset - entry.localOffset) {
    fail(`iOS app ZIP local header for ${JSON.stringify(entry.name)} overlaps the central directory`);
  }
  const dataOffset = entry.localOffset + headerBytes;
  if (dataOffset > centralOffset || entry.compressedSize > centralOffset - dataOffset) {
    fail(`iOS app ZIP data for ${JSON.stringify(entry.name)} overlaps the central directory`);
  }
  const dataEnd = dataOffset + entry.compressedSize;
  entry.dataOffset = dataOffset;
  entry.dataEnd = dataEnd;
  entry.usesDataDescriptor = descriptor;
}

async function validateZipDataDescriptor(handle, entry, offset, length) {
  const zip64Sizes = entry.zip64Sizes;
  const unsignedBytes = zip64Sizes ? 20 : 12;
  const signedBytes = unsignedBytes + 4;
  if (length !== unsignedBytes && length !== signedBytes) {
    fail(
      `iOS app ZIP has an unreferenced or ambiguous ${length}-byte gap after ` +
        JSON.stringify(entry.name),
    );
  }
  const descriptor = await readAt(
    handle,
    offset,
    length,
    `iOS app ZIP data descriptor for ${entry.name}`,
  );
  let cursor = 0;
  if (length === signedBytes) {
    if (descriptor.readUInt32LE(0) !== 0x08074b50) {
      fail(`iOS app ZIP data descriptor for ${JSON.stringify(entry.name)} has an invalid signature`);
    }
    cursor = 4;
  }
  const checksum = descriptor.readUInt32LE(cursor);
  cursor += 4;
  const compressedSize = zip64Sizes
    ? safeZipNumber(descriptor.readBigUInt64LE(cursor), `ZIP64 descriptor compressed size for ${entry.name}`)
    : descriptor.readUInt32LE(cursor);
  cursor += zip64Sizes ? 8 : 4;
  const uncompressedSize = zip64Sizes
    ? safeZipNumber(descriptor.readBigUInt64LE(cursor), `ZIP64 descriptor uncompressed size for ${entry.name}`)
    : descriptor.readUInt32LE(cursor);
  if (
    checksum !== entry.crc32 ||
    compressedSize !== entry.compressedSize ||
    uncompressedSize !== entry.uncompressedSize
  ) {
    fail(`iOS app ZIP data descriptor disagrees with central member ${JSON.stringify(entry.name)}`);
  }
}

async function validateZipSymlink(handle, entry, appName) {
  if (entry.metadata) fail(`iOS app ZIP metadata member ${JSON.stringify(entry.name)} must not be a symlink`);
  if (
    entry.uncompressedSize === 0 ||
    entry.uncompressedSize > ZIP_MAX_SYMLINK_TARGET_BYTES ||
    entry.compressedSize > ZIP_MAX_SYMLINK_TARGET_BYTES
  ) {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} has an invalid target size`);
  }
  const compressed = await readAt(
    handle,
    entry.dataOffset,
    entry.compressedSize,
    `iOS app ZIP symlink data for ${entry.name}`,
  );
  let payload;
  try {
    payload = entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: ZIP_MAX_SYMLINK_TARGET_BYTES });
  } catch (error) {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} could not be decompressed: ${error.message}`);
  }
  if (payload.length !== entry.uncompressedSize || crc32(payload) !== entry.crc32) {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} fails size or CRC validation`);
  }
  let target;
  try {
    target = UTF8.decode(payload);
  } catch {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} target is not valid UTF-8`);
  }
  if (
    target.length === 0 ||
    path.posix.isAbsolute(target) ||
    target.includes("\\") ||
    /^[A-Za-z]:/u.test(target) ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} has unsafe target ${JSON.stringify(target)}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.canonical), target));
  if (resolved !== appName && !resolved.startsWith(`${appName}/`)) {
    fail(`iOS app ZIP symlink ${JSON.stringify(entry.name)} escapes ${appName}: ${JSON.stringify(target)}`);
  }
}

export async function validateIosAppZipArchive(archive, expectedAppName) {
  const appName = safeLeaf(expectedAppName, "ZIP app bundle name", ".app");
  const stat = await requireRegularFile(archive, "iOS app ZIP archive");
  const handle = await fs.open(archive, "r");
  try {
    const directory = await zipDirectory(handle, stat.size);
    const central = await readAt(
      handle,
      directory.centralOffset,
      directory.centralSize,
      "iOS app ZIP central directory",
    );
    const entries = [];
    const paths = new Map();
    const normalizedPaths = new Map();
    const foldedPaths = new Map();
    let cursor = 0;
    for (let index = 0; index < directory.entries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
        fail(`iOS app ZIP central entry ${index + 1} is missing or malformed`);
      }
      const versionMadeBy = central.readUInt16LE(cursor + 4);
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const checksum = central.readUInt32LE(cursor + 16);
      const compressed32 = central.readUInt32LE(cursor + 20);
      const uncompressed32 = central.readUInt32LE(cursor + 24);
      const nameBytes = central.readUInt16LE(cursor + 28);
      const extraBytes = central.readUInt16LE(cursor + 30);
      const commentBytes = central.readUInt16LE(cursor + 32);
      const diskStart16 = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset32 = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameBytes + extraBytes + commentBytes;
      if (end > central.length) fail(`iOS app ZIP central entry ${index + 1} is truncated`);
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
        fail(`iOS app ZIP central entry ${index + 1} is encrypted`);
      }
      if (method !== 0 && method !== 8) {
        fail(`iOS app ZIP central entry ${index + 1} uses unsupported compression method ${method}`);
      }
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameBytes);
      const name = decodeZipName(rawName, `iOS app ZIP central entry ${index + 1}`);
      const member = zipMemberPath(name, appName);
      const extra = central.subarray(
        cursor + 46 + nameBytes,
        cursor + 46 + nameBytes + extraBytes,
      );
      const sizes = zip64EntryValues({
        compressedSize: compressed32,
        diskStart: diskStart16,
        extra,
        label: `iOS app ZIP central entry ${JSON.stringify(name)}`,
        localOffset: localOffset32,
        uncompressedSize: uncompressed32,
      });
      if (sizes.diskStart !== 0) fail("multi-disk iOS app ZIP entries are not supported");
      const type = zipMemberType(versionMadeBy, externalAttributes, member.directory, name);
      if (type === "directory" && (sizes.compressedSize !== 0 || sizes.uncompressedSize !== 0)) {
        fail(`iOS app ZIP directory ${JSON.stringify(name)} must have an empty payload`);
      }
      const prior = paths.get(member.canonical);
      if (prior !== undefined) {
        fail(`iOS app ZIP repeats member path ${JSON.stringify(member.canonical)}`);
      }
      const normalizedPrior = normalizedPaths.get(member.normalized);
      if (normalizedPrior !== undefined) {
        fail(
          `iOS app ZIP has Unicode-normalization-colliding members ` +
            `${JSON.stringify(normalizedPrior)} and ${JSON.stringify(name)}`,
        );
      }
      const entry = {
        ...member,
        compressedSize: sizes.compressedSize,
        crc32: checksum,
        flags,
        localOffset: sizes.localOffset,
        method,
        name,
        rawName: Buffer.from(rawName),
        type,
        uncompressedSize: sizes.uncompressedSize,
        zip64Sizes: compressed32 === 0xffffffff || uncompressed32 === 0xffffffff,
      };
      paths.set(member.canonical, entry);
      normalizedPaths.set(member.normalized, name);
      const folded = portableCaseFold(member.normalized);
      const foldedEntries = foldedPaths.get(folded) ?? [];
      foldedEntries.push(entry);
      foldedPaths.set(folded, foldedEntries);
      entries.push(entry);
      cursor = end;
    }
    if (cursor !== central.length) fail("iOS app ZIP central directory contains trailing records");

    const root = paths.get(appName);
    if (root?.type !== "directory") {
      fail(`iOS app ZIP must contain the direct app root ${appName}/`);
    }
    for (const entry of entries) {
      await validateZipLocalEntry(handle, entry, directory.centralOffset);
    }
    const extents = entries
      .map((entry) => ({ end: entry.dataEnd, entry, name: entry.name, start: entry.localOffset }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (extents[0].start !== 0) {
      fail("iOS app ZIP must not contain an executable prefix or unreferenced bytes before its first local record");
    }
    for (let index = 1; index < extents.length; index += 1) {
      if (extents[index].start < extents[index - 1].end) {
        fail(
          `iOS app ZIP local records overlap: ${JSON.stringify(extents[index - 1].name)} and ` +
            JSON.stringify(extents[index].name),
        );
      }
    }
    // A ditto ZIP may place the standard data descriptor after a local
    // payload. No other local-record gaps are accepted: that prevents an
    // extractor that scans local records from seeing content omitted from the
    // manifest-bound central directory.
    for (let index = 0; index < extents.length; index += 1) {
      const extent = extents[index];
      const nextStart = extents[index + 1]?.start ?? directory.centralOffset;
      const gap = nextStart - extent.end;
      if (extent.entry.usesDataDescriptor) {
        await validateZipDataDescriptor(handle, extent.entry, extent.end, gap);
      } else if (gap !== 0) {
        fail(
          `iOS app ZIP has an unreferenced or ambiguous ${gap}-byte gap after ` +
            JSON.stringify(extent.name),
        );
      }
    }
    for (const foldedEntries of foldedPaths.values()) {
      if (
        foldedEntries.length > 1 &&
        foldedEntries.some(({ type }) => type !== "file")
      ) {
        fail(
          `iOS app ZIP has case-ambiguous non-file members: ` +
            foldedEntries.map(({ name }) => JSON.stringify(name)).join(", "),
        );
      }
    }
    for (const entry of entries) {
      let parent = path.posix.dirname(entry.canonical);
      while (parent !== ".") {
        const declaredParent = paths.get(parent);
        if (declaredParent !== undefined && declaredParent.type !== "directory") {
          fail(
            `iOS app ZIP member ${JSON.stringify(entry.name)} descends through non-directory ` +
              JSON.stringify(declaredParent.name),
          );
        }
        const foldedParents = foldedPaths.get(portableCaseFold(parent)) ?? [];
        const foldedNonDirectory = foldedParents.find(({ type }) => type !== "directory");
        if (foldedNonDirectory !== undefined) {
          fail(
            `iOS app ZIP member ${JSON.stringify(entry.name)} has a case-ambiguous ` +
              `non-directory ancestor ${JSON.stringify(foldedNonDirectory.name)}`,
          );
        }
        parent = path.posix.dirname(parent);
      }
      if (entry.type === "symlink") await validateZipSymlink(handle, entry, appName);
    }
    return { entries: entries.length, zip64: directory.zip64 };
  } finally {
    await handle.close();
  }
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const OWNED_TEMPORARY_NAMES = [
  new RegExp(
    `^\\.${regexEscape(ARCHIVE_NAME)}\\.[0-9]+(?:\\.[0-9a-f-]+)?\\.tmp\\.zip$`,
    "u",
  ),
  new RegExp(
    `^\\.?${regexEscape(MANIFEST_NAME)}\\.[0-9]+(?:\\.[0-9a-f-]+)?\\.tmp$`,
    "u",
  ),
];

async function removeOwnedStaleTransportTemps(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!OWNED_TEMPORARY_NAMES.some((pattern) => pattern.test(entry.name))) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    await fs.rm(path.join(directory, entry.name), { force: true });
  }
}

async function ensureTransportDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) fail(`transport output is not a directory: ${directory}`);
  await removeOwnedStaleTransportTemps(directory);
  const allowed = new Set([ARCHIVE_NAME, MANIFEST_NAME, BUILD_REPORT_NAME]);
  const unexpected = (await fs.readdir(directory)).filter((name) => !allowed.has(name)).sort(compareNames);
  if (unexpected.length > 0) {
    fail(`transport directory contains unexpected entries: ${unexpected.join(", ")}`);
  }
}

async function validateTransportFiles(directory, manifest) {
  const expected = new Set([ARCHIVE_NAME, MANIFEST_NAME]);
  if (manifest.buildReport !== null) expected.add(BUILD_REPORT_NAME);
  const actual = (await fs.readdir(directory)).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`transport directory entries must be ${JSON.stringify(wanted)}; got ${JSON.stringify(actual)}`);
  }
  for (const name of wanted) {
    await requireRegularFile(path.join(directory, name), `transport ${name}`);
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function packIosAppTransport({ appDir, transportDir, buildReport = undefined }) {
  const tools = await appleTools();
  await requireDirectory(appDir, "iOS app artifact directory");
  if (path.resolve(appDir) === path.resolve(transportDir)) {
    fail("--app-dir and --transport-dir must be different directories");
  }
  const app = await exactlyOneApp(appDir);
  const appData = await appIdentity(app.path, tools.plutil);

  let report;
  const automaticReport = path.join(appDir, BUILD_REPORT_NAME);
  const reportFile = buildReport ?? ((await statOrUndefined(automaticReport)) !== undefined ? automaticReport : undefined);
  if (reportFile !== undefined) report = await loadBuildReport(reportFile, appData.name);

  await ensureTransportDirectory(transportDir);
  const archive = path.join(transportDir, ARCHIVE_NAME);
  const manifestFile = path.join(transportDir, MANIFEST_NAME);
  const copiedReport = path.join(transportDir, BUILD_REPORT_NAME);
  for (const file of [archive, manifestFile, copiedReport]) await fs.rm(file, { force: true });

  const temporaryArchive = path.join(
    transportDir,
    `.${ARCHIVE_NAME}.${process.pid}.${randomUUID()}.tmp.zip`,
  );
  try {
    run(
      tools.ditto,
      ["-c", "-k", "--sequesterRsrc", "--keepParent", appData.name, temporaryArchive],
      { cwd: appDir, label: "iOS app ditto archive" },
    );
    await requireRegularFile(temporaryArchive, "iOS app ditto archive");
    await fs.rename(temporaryArchive, archive);
    const archiveStat = await requireRegularFile(archive, "iOS app transport archive");
    const archiveSha256 = await sha256File(archive);
    await validateIosAppZipArchive(archive, appData.name);

    if (report !== undefined) {
      await fs.copyFile(reportFile, copiedReport);
      const copied = await loadBuildReport(copiedReport, appData.name);
      if (JSON.stringify(copied.identity) !== JSON.stringify(report.identity)) {
        fail("copied iOS mobile build report does not match its manifest identity");
      }
    }
    const manifest = {
      schema: TRANSPORT_SCHEMA,
      archive: {
        bytes: archiveStat.size,
        format: "ditto-zip",
        name: ARCHIVE_NAME,
        sha256: archiveSha256,
      },
      app: appData,
      buildReport: report?.identity ?? null,
    };
    await writeJsonAtomic(manifestFile, manifest);
    process.stdout.write(
      `${JSON.stringify({ archive, buildReport: report === undefined ? null : copiedReport, manifest: manifestFile })}\n`,
    );
    return { archive, buildReport: report === undefined ? null : copiedReport, manifest: manifestFile };
  } catch (error) {
    await fs.rm(temporaryArchive, { force: true });
    throw error;
  }
}

export async function verifyExtractIosAppTransport({ transportDir, outputDir }) {
  const tools = await appleTools();
  await requireDirectory(transportDir, "iOS app transport directory");
  if (inside(transportDir, outputDir)) {
    fail("--output-dir must not be inside --transport-dir");
  }
  if ((await statOrUndefined(outputDir, { follow: false })) !== undefined) {
    fail(`iOS app extraction output already exists: ${outputDir}`);
  }

  const manifestFile = path.join(transportDir, MANIFEST_NAME);
  const manifest = validateManifest(await readJson(manifestFile, "iOS app transport manifest"));
  await validateTransportFiles(transportDir, manifest);

  const archive = path.join(transportDir, ARCHIVE_NAME);
  const archiveStat = await requireRegularFile(archive, "iOS app transport archive");
  if (archiveStat.size !== manifest.archive.bytes) {
    fail(`transport archive byte count mismatch: expected ${manifest.archive.bytes}, got ${archiveStat.size}`);
  }
  const archiveSha256 = await sha256File(archive);
  if (archiveSha256 !== manifest.archive.sha256) {
    fail(`transport archive checksum mismatch: expected ${manifest.archive.sha256}, got ${archiveSha256}`);
  }
  await validateIosAppZipArchive(archive, manifest.app.name);

  let reportFile;
  if (manifest.buildReport !== null) {
    reportFile = path.join(transportDir, BUILD_REPORT_NAME);
    const report = await loadBuildReport(reportFile, manifest.app.name);
    if (JSON.stringify(report.identity) !== JSON.stringify(manifest.buildReport)) {
      fail("transport build report identity does not match its manifest binding");
    }
  }

  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputDir), ".ios-app-extract-"));
  try {
    run(tools.ditto, ["-x", "-k", archive, temporary], { label: "iOS app ditto extraction" });
    await requireExactDirectEntries(
      temporary,
      [manifest.app.name],
      "extracted iOS app transport root",
    );
    const app = await exactlyOneApp(temporary, manifest.app.name);
    const extracted = await appIdentity(app.path, tools.plutil);
    for (const key of ["name", "executable", "executableMode", "infoPlistSha256"]) {
      if (extracted[key] !== manifest.app[key]) {
        fail(
          `extracted app ${key} mismatch: expected ${JSON.stringify(manifest.app[key])}, ` +
            `got ${JSON.stringify(extracted[key])}`,
        );
      }
    }
    if (
      extracted.payload.entries !== manifest.app.payload.entries ||
      extracted.payload.sha256 !== manifest.app.payload.sha256
    ) {
      fail(
        `extracted app payload mismatch: expected ${JSON.stringify(manifest.app.payload)}, ` +
        `got ${JSON.stringify(extracted.payload)}`,
      );
    }
    if (reportFile !== undefined) {
      const copiedReport = path.join(temporary, BUILD_REPORT_NAME);
      await fs.copyFile(reportFile, copiedReport);
      const copied = await loadBuildReport(copiedReport, manifest.app.name);
      if (JSON.stringify(copied.identity) !== JSON.stringify(manifest.buildReport)) {
        fail("extracted build report does not match its manifest binding");
      }
    }
    await fs.rename(temporary, outputDir);
    const extractedApp = path.join(outputDir, manifest.app.name);
    const extractedReport = reportFile === undefined ? null : path.join(outputDir, BUILD_REPORT_NAME);
    const result = {
      app: extractedApp,
      buildReport: extractedReport,
      executable: manifest.app.executable,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    await fs.rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "pack") {
    await packIosAppTransport(args);
  } else {
    await verifyExtractIosAppTransport(args);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : `${PREFIX}: ${String(error)}`);
    process.exit(1);
  }
}
