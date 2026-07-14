#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PREFIX = "stage-ios-app.mjs";
const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
const OUTPUT_SCHEMA = "oliphaunt-react-native-ios-selection-v1";
const PORTABLE_RE = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STABLE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const EXTRACTED_CACHE_SCHEMA = "oliphaunt-extracted-carrier-tree-v1";

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  console.error(
    `usage: ${PREFIX} --carrier <manifest.json> [--carrier <manifest.json>]... ` +
      `--output-dir <ios/oliphaunt> [--extensions <sql,csv>] [--icu] ` +
      `[--cache-dir <directory>] [--allow-file-urls]`,
  );
}

function parseArgs(argv) {
  const args = {
    allowFileUrls: false,
    cacheDir: path.join(os.homedir(), ".cache", "oliphaunt", "react-native-ios"),
    carriers: [],
    extensions: [],
    icu: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-file-urls") {
      args.allowFileUrls = true;
      continue;
    }
    if (arg === "--icu") {
      args.icu = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (
      ![
        "--carrier",
        "--base-carrier",
        "--cache-dir",
        "--extension-carrier",
        "--extensions",
        "--output-dir",
      ].includes(arg)
    ) {
      usage();
      fail(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--carrier" || arg === "--base-carrier") args.carriers.push(path.resolve(value));
    if (arg === "--cache-dir") args.cacheDir = path.resolve(value);
    if (arg === "--extension-carrier") args.carriers.push(path.resolve(value));
    if (arg === "--output-dir") args.outputDir = path.resolve(value);
    if (arg === "--extensions") {
      args.extensions.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  if (args.carriers.length === 0 || !args.outputDir) {
    usage();
    fail("at least one --carrier and --output-dir are required");
  }
  args.extensions = uniquePortable(args.extensions, "selected extension");
  return args;
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extras.length > 0) fail(`${label} contains unsupported field(s): ${extras.join(",")}`);
}

function portable(value, label) {
  if (typeof value !== "string" || !PORTABLE_RE.test(value)) {
    fail(`${label} must be a portable identifier`);
  }
  return value;
}

function stableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_SEMVER_RE.test(value)) {
    fail(`${label} must be a stable SemVer X.Y.Z version`);
  }
  return value;
}

function cIdentifier(value, label) {
  if (typeof value !== "string" || !C_IDENTIFIER_RE.test(value)) {
    fail(`${label} must be a C identifier`);
  }
  return value;
}

function uniquePortable(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const result = value.map((item, index) => portable(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  return result.sort();
}

function safeRelative(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) || /^[A-Za-z]:/u.test(value)
  ) {
    fail(`${label} must be a non-empty archive-relative path`);
  }
  if (value === ".") return value;
  const normalized = value.replace(/^\.\//u, "");
  const parts = normalized.split("/");
  if (path.isAbsolute(value) || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${label} is not a safe archive-relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function validateAsset(value, label, allowFileUrls) {
  const asset = object(value, label);
  exactKeys(asset, ["bytes", "format", "member", "name", "role", "sha256", "url"], label);
  const role = portable(asset.role, `${label}.role`);
  if (
    typeof asset.name !== "string" || path.basename(asset.name) !== asset.name ||
    asset.name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(asset.name)
  ) {
    fail(`${label}.name must be a plain file name`);
  }
  if (!["tar.gz", "zip"].includes(asset.format)) {
    fail(`${label}.format must be tar.gz or zip`);
  }
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    fail(`${label}.bytes must be a positive safe integer`);
  }
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    fail(`${label}.url must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) {
    fail(`${label}.url must use HTTPS${allowFileUrls ? " or an explicitly enabled file URL" : ""}`);
  }
  let urlName;
  try {
    urlName = decodeURIComponent(path.basename(url.pathname));
  } catch {
    fail(`${label}.url contains invalid escaping`);
  }
  if (urlName !== asset.name) {
    fail(`${label}.url must end with ${asset.name}`);
  }
  if (
    (asset.format === "zip" && !asset.name.endsWith(".zip")) ||
    (asset.format === "tar.gz" && !asset.name.endsWith(".tar.gz"))
  ) {
    fail(`${label}.name does not match format ${asset.format}`);
  }
  return {
    bytes: asset.bytes,
    format: asset.format,
    member: safeRelative(asset.member, `${label}.member`),
    name: asset.name,
    role,
    sha256: asset.sha256,
    url: url.href,
  };
}

function validateRegistration(value, label) {
  const registration = object(value, label);
  exactKeys(registration, ["initSymbol", "magicSymbol", "symbols"], label);
  const initSymbol = registration.initSymbol === null
    ? null
    : cIdentifier(registration.initSymbol, `${label}.initSymbol`);
  const magicSymbol = cIdentifier(registration.magicSymbol, `${label}.magicSymbol`);
  if (!Array.isArray(registration.symbols)) fail(`${label}.symbols must be an array`);
  const symbols = registration.symbols.map((raw, index) => {
    const row = object(raw, `${label}.symbols[${index}]`);
    exactKeys(row, ["address", "name"], `${label}.symbols[${index}]`);
    return {
      address: cIdentifier(row.address, `${label}.symbols[${index}].address`),
      name: cIdentifier(row.name, `${label}.symbols[${index}].name`),
    };
  }).sort((left, right) => `${left.name}\0${left.address}`.localeCompare(`${right.name}\0${right.address}`));
  if (new Set(symbols.map(({ name }) => name)).size !== symbols.length) {
    fail(`${label}.symbols repeats a SQL symbol`);
  }
  return { initSymbol, magicSymbol, symbols };
}

function validateAssetList(value, label, allowFileUrls) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const assets = value.map((asset, index) =>
    validateAsset(asset, `${label}[${index}]`, allowFileUrls));
  const identities = assets.map(({ role, member }) => `${role}\0${member}`);
  if (new Set(identities).size !== identities.length) {
    fail(`${label} repeats an asset role/member identity`);
  }
  if (new Set(assets.map(({ name }) => name)).size !== assets.length) {
    fail(`${label} repeats an asset name`);
  }
  return assets.sort((left, right) =>
    `${left.role}\0${left.member}`.localeCompare(`${right.role}\0${right.member}`));
}

function exactlyOneRole(assets, role, label) {
  const matches = assets.filter((asset) => asset.role === role);
  if (matches.length !== 1) fail(`${label} must contain exactly one ${role} asset`);
  return matches[0];
}

function noOtherRoles(assets, roles, label) {
  const extras = assets.filter((asset) => !roles.includes(asset.role));
  if (extras.length > 0) {
    fail(`${label} contains unsupported asset role(s): ${[...new Set(extras.map(({ role }) => role))].sort().join(",")}`);
  }
}

function validateBase(value, label, allowFileUrls) {
  const base = object(value, label);
  exactKeys(base, ["assets", "product", "tag", "version"], label);
  if (base.product !== "liboliphaunt-native") fail(`${label}.product must be liboliphaunt-native`);
  const assets = validateAssetList(base.assets, `${label}.assets`, allowFileUrls);
  noOtherRoles(assets, ["base-xcframework", "icu-data", "runtime-resources"], `${label}.assets`);
  const framework = exactlyOneRole(assets, "base-xcframework", `${label}.assets`);
  const runtime = exactlyOneRole(assets, "runtime-resources", `${label}.assets`);
  const icu = exactlyOneRole(assets, "icu-data", `${label}.assets`);
  if (!path.posix.basename(framework.member).endsWith(".xcframework")) {
    fail(`${label} base-xcframework member must be an XCFramework directory`);
  }
  const version = stableVersion(base.version, `${label}.version`);
  const expectedTag = `${base.product}-v${version}`;
  if (base.tag !== expectedTag) fail(`${label}.tag must be ${expectedTag}`);
  return {
    assets: { framework, icu, runtime },
    kind: "base",
    product: base.product,
    tag: base.tag,
    version,
  };
}

function validateExtension(value, label, allowFileUrls) {
  const root = object(value, label);
  exactKeys(
    root,
    [
      "assets", "createsExtension", "dependencies", "nativeDependencies",
      "nativeModuleStem", "product", "registration", "sharedPreloadLibraries",
      "sqlName", "tag", "version",
    ],
    label,
  );
  const sqlName = portable(root.sqlName, `${label}.sqlName`);
  const expectedProduct = `oliphaunt-extension-${sqlName.replaceAll("_", "-")}`;
  if (root.product !== expectedProduct) fail(`${label}.product must be ${expectedProduct}`);
  const version = stableVersion(root.version, `${label}.version`);
  const expectedTag = `${expectedProduct}-v${version}`;
  if (root.tag !== expectedTag) fail(`${label}.tag must be ${expectedTag}`);
  if (typeof root.createsExtension !== "boolean") fail(`${label}.createsExtension must be boolean`);
  const dependencies = uniquePortable(root.dependencies, `${label}.dependencies`);
  const nativeDependencies = uniquePortable(root.nativeDependencies, `${label}.nativeDependencies`);
  const nativeModuleStem = root.nativeModuleStem === null
    ? null
    : portable(root.nativeModuleStem, `${label}.nativeModuleStem`);
  const sharedPreloadLibraries = uniquePortable(
    root.sharedPreloadLibraries,
    `${label}.sharedPreloadLibraries`,
  );
  const assets = validateAssetList(root.assets, `${label}.assets`, allowFileUrls);
  noOtherRoles(
    assets,
    ["dependency-xcframework", "extension-xcframework", "runtime-resources"],
    `${label}.assets`,
  );
  const runtime = exactlyOneRole(assets, "runtime-resources", `${label}.assets`);
  let extension = null;
  let dependencyFrameworks = [];
  let registration = null;
  if (nativeModuleStem === null) {
    if (assets.some(({ role }) => role !== "runtime-resources") || root.registration !== null || nativeDependencies.length > 0) {
      fail(`${label} SQL-only carrier must not fabricate frameworks, registration, or native dependencies`);
    }
  } else {
    extension = exactlyOneRole(assets, "extension-xcframework", `${label}.assets`);
    const expectedExtension = `liboliphaunt_extension_${nativeModuleStem}.xcframework`;
    if (path.posix.basename(extension.member) !== expectedExtension) {
      fail(`${label} extension-xcframework member must end with ${expectedExtension}`);
    }
    dependencyFrameworks = assets
      .filter(({ role }) => role === "dependency-xcframework")
      .map((asset) => {
        const basename = path.posix.basename(asset.member);
        const match = /^liboliphaunt_dependency_(.+)\.xcframework$/u.exec(basename);
        if (!match || !PORTABLE_RE.test(match[1])) {
          fail(`${label} dependency-xcframework member has invalid canonical name ${basename}`);
        }
        return { asset, dependency: match[1] };
      })
      .sort((left, right) => left.dependency.localeCompare(right.dependency));
    if (new Set(dependencyFrameworks.map(({ dependency }) => dependency)).size !== dependencyFrameworks.length) {
      fail(`${label} repeats a dependency carrier identity`);
    }
    if (
      JSON.stringify(dependencyFrameworks.map(({ dependency }) => dependency)) !==
      JSON.stringify(nativeDependencies)
    ) {
      fail(`${label} dependency-xcframework roles do not exactly match nativeDependencies`);
    }
    if (root.registration === null) fail(`${label} native carrier requires registration metadata`);
    registration = validateRegistration(root.registration, `${label}.registration`);
    const prefix = `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
    if (registration.magicSymbol !== `${prefix}_Pg_magic_func`) {
      fail(`${label}.registration.magicSymbol does not match nativeModuleStem`);
    }
    if (![null, `${prefix}__PG_init`].includes(registration.initSymbol)) {
      fail(`${label}.registration.initSymbol does not match nativeModuleStem`);
    }
  }
  return {
    assets: { dependencyFrameworks, extension, runtime },
    createsExtension: root.createsExtension,
    dependencies,
    kind: "extension",
    nativeDependencies,
    nativeModuleStem,
    product: root.product,
    registration,
    sharedPreloadLibraries,
    sqlName,
    tag: root.tag,
    version,
  };
}

async function readCarrierDocument(file, allowFileUrls) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail(`could not read carrier ${file}: ${error.message}`);
  }
  const root = object(value, file);
  if (root.schema !== SCHEMA) fail(`${file} schema must be ${SCHEMA}`);
  exactKeys(root, ["base", "extensions", "schema"], file);
  if (!Array.isArray(root.extensions)) fail(`${file}.extensions must be an array`);
  const base = validateBase(root.base, `${file}.base`, allowFileUrls);
  const extensions = root.extensions.map((extension, index) =>
    validateExtension(extension, `${file}.extensions[${index}]`, allowFileUrls));
  const names = extensions.map(({ sqlName }) => sqlName);
  if (new Set(names).size !== names.length) fail(`${file}.extensions repeats an exact extension row`);
  return { base, extensions, source: file };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function statOrUndefined(file) {
  return fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
}

async function requirePayloadDirectory(file, label) {
  if ((await statOrUndefined(file))?.isDirectory() !== true) {
    fail(`${label} is missing: ${file}`);
  }
}

async function materializeAsset(asset, cacheDir) {
  const objects = path.join(cacheDir, "objects");
  await fs.mkdir(objects, { recursive: true });
  const cached = path.join(objects, `${asset.sha256}-${asset.name}`);
  if ((await statOrUndefined(cached))?.isFile() === true) {
    const stat = await fs.stat(cached);
    if (stat.size === asset.bytes && (await sha256File(cached)) === asset.sha256) return cached;
  }
  await fs.rm(cached, { force: true, recursive: true });
  const temporary = `${cached}.tmp-${process.pid}-${Date.now()}`;
  const url = new URL(asset.url);
  try {
    if (url.protocol === "file:") {
      await fs.copyFile(fileURLToPath(url), temporary);
    } else {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || response.body === null) {
        fail(`download ${asset.url} failed with HTTP ${response.status}`);
      }
      if (new URL(response.url).protocol !== "https:") {
        fail(`download ${asset.url} redirected outside HTTPS`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    }
    const actualBytes = (await fs.stat(temporary)).size;
    if (actualBytes !== asset.bytes) {
      fail(`size mismatch for ${asset.name}; expected ${asset.bytes}, got ${actualBytes}`);
    }
    const actual = await sha256File(temporary);
    if (actual !== asset.sha256) {
      fail(`checksum mismatch for ${asset.name}; expected ${asset.sha256}, got ${actual}`);
    }
    await fs.rename(temporary, cached).catch(async (error) => {
      if ((await statOrUndefined(cached))?.isFile() !== true) throw error;
    });
    if ((await sha256File(cached)) !== asset.sha256) {
      fail(`cached object failed checksum verification after materialization: ${cached}`);
    }
    return cached;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function archiveMembers(archive, format) {
  const output = format === "zip"
    ? run("unzip", ["-Z1", archive], `list ${archive}`)
    : run("tar", ["-tzf", archive], `list ${archive}`);
  const rawMembers = output.split(/\r?\n/u).filter((line) => line.length > 0);
  const typeOutput = format === "zip"
    ? run("zipinfo", ["-l", archive], `inspect ${archive}`)
    : run("tar", ["-tvzf", archive], `inspect ${archive}`);
  const typeLines = typeOutput.split(/\r?\n/u).filter((line) => /^[bcdlps-][rwxStTs-]{9}\s/u.test(line));
  if (rawMembers.length === 0 || typeLines.length !== rawMembers.length) {
    fail(`${archive} archive metadata does not establish one type for every member`);
  }
  const entries = rawMembers.map((raw, index) => {
    const type = typeLines[index][0];
    if (!["-", "d"].includes(type)) fail(`${archive} contains a link or special entry: ${raw}`);
    const directoryMarker = raw.endsWith("/");
    if ((type === "d") !== directoryMarker && raw !== "." && raw !== "./") {
      fail(`${archive} member type/path marker mismatch: ${raw}`);
    }
    return {
      name: safeRelative(raw.replace(/\/$/u, "") || ".", `${archive} member`),
      type: type === "d" ? "directory" : "file",
    };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail(`${archive} repeats a normalized archive member`);
  const folded = names.map((name) => name.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) fail(`${archive} has case-colliding archive members`);
  for (const entry of entries) {
    if (entry.type === "file" && entries.some(({ name }) => name.startsWith(`${entry.name}/`))) {
      fail(`${archive} uses file ${entry.name} as an archive directory`);
    }
  }
  return new Set(names);
}

function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function extractedTree(root) {
  const result = [];
  const pending = [{ directory: root, relative: "" }];
  while (pending.length > 0) {
    const { directory, relative } = pending.pop();
    for (const name of (await fs.readdir(directory)).sort().reverse()) {
      const file = path.join(directory, name);
      const fileRelative = relative ? `${relative}/${name}` : name;
      safeRelative(fileRelative, `${root} extracted member`);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail(`extracted carrier contains symlink: ${file}`);
      if (stat.isDirectory()) {
        result.push({ path: fileRelative, type: "directory" });
        pending.push({ directory: file, relative: fileRelative });
      } else if (stat.isFile()) {
        result.push({
          bytes: stat.size,
          executable: (stat.mode & 0o111) !== 0,
          path: fileRelative,
          sha256: await sha256File(file),
          type: "file",
        });
      } else {
        fail(`extracted carrier contains unsupported entry: ${file}`);
      }
    }
  }
  result.sort((left, right) => left.path.localeCompare(right.path));
  return result;
}

async function extractedCacheValid(root, manifestFile, archiveSha256) {
  if ((await statOrUndefined(root))?.isDirectory() !== true || (await statOrUndefined(manifestFile))?.isFile() !== true) return false;
  try {
    const manifest = object(JSON.parse(await fs.readFile(manifestFile, "utf8")), manifestFile);
    exactKeys(manifest, ["archiveSha256", "entries", "schema", "treeSha256"], manifestFile);
    if (manifest.schema !== EXTRACTED_CACHE_SCHEMA || manifest.archiveSha256 !== archiveSha256 || !Array.isArray(manifest.entries)) return false;
    if (manifest.treeSha256 !== jsonDigest(manifest.entries)) return false;
    const actual = await extractedTree(root);
    return manifest.treeSha256 === jsonDigest(actual) && JSON.stringify(manifest.entries) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

async function extractedAsset(asset, archive, cacheDir) {
  const root = path.join(cacheDir, "extracted", asset.sha256);
  const cacheManifest = `${root}.tree.json`;
  if (await extractedCacheValid(root, cacheManifest, asset.sha256)) return root;
  await fs.rm(root, { force: true, recursive: true });
  await fs.rm(cacheManifest, { force: true });
  const members = archiveMembers(archive, asset.format);
  if (asset.member !== "." && !members.has(asset.member) && ![...members].some((entry) => entry.startsWith(`${asset.member}/`))) {
    fail(`${asset.name} is missing declared member ${asset.member}`);
  }
  const parent = path.dirname(root);
  const temporary = path.join(parent, `.${asset.sha256}.tmp-${process.pid}-${Date.now()}`);
  const temporaryManifest = `${cacheManifest}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(parent, { recursive: true });
  await fs.rm(temporary, { force: true, recursive: true });
  await fs.mkdir(temporary, { recursive: true });
  try {
    if (asset.format === "zip") run("unzip", ["-q", archive, "-d", temporary], `extract ${asset.name}`);
    else run("tar", ["-xzf", archive, "-C", temporary], `extract ${asset.name}`);
    const tree = await extractedTree(temporary);
    const manifest = {
      archiveSha256: asset.sha256,
      entries: tree,
      schema: EXTRACTED_CACHE_SCHEMA,
      treeSha256: jsonDigest(tree),
    };
    const selected = asset.member === "." ? temporary : path.join(temporary, ...asset.member.split("/"));
    if ((await statOrUndefined(selected))?.isDirectory() !== true) {
      fail(`${asset.name} member is not a directory: ${asset.member}`);
    }
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, root);
    await fs.rename(temporaryManifest, cacheManifest);
    return root;
  } catch (error) {
    await fs.rm(temporary, { force: true, recursive: true });
    await fs.rm(temporaryManifest, { force: true });
    await fs.rm(root, { force: true, recursive: true });
    await fs.rm(cacheManifest, { force: true });
    throw error;
  }
}

async function resolveAsset(asset, cacheDir) {
  const archive = await materializeAsset(asset, cacheDir);
  const extracted = await extractedAsset(asset, archive, cacheDir);
  const member = asset.member === "."
    ? extracted
    : path.join(extracted, ...asset.member.split("/"));
  const stat = await statOrUndefined(member);
  if (stat?.isDirectory() !== true) fail(`${asset.name} member is not a directory: ${asset.member}`);
  return member;
}

async function copyTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`refusing to copy carrier symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = (await fs.readdir(source)).sort();
    for (const name of entries) {
      await copyTree(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
  } else {
    fail(`unsupported carrier entry: ${source}`);
  }
}

async function mergeTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`refusing to merge carrier symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) {
      await mergeTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) fail(`unsupported carrier entry: ${source}`);
  const existing = await statOrUndefined(destination);
  if (existing !== undefined) {
    if (!existing.isFile() || (await sha256File(source)) !== (await sha256File(destination))) {
      fail(`selected carrier resources conflict at ${destination}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
}

function parseProperties(text, source) {
  const values = new Map();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail(`${source}:${index + 1} is not key=value`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) fail(`${source}:${index + 1} repeats ${key}`);
    values.set(key, value);
  }
  return values;
}

function csv(value, label) {
  return value ? uniquePortable(value.split(","), label) : [];
}

function requireProperty(values, key, expected, source) {
  if (values.get(key) !== expected) {
    fail(`${source} must declare ${key}=${expected}; got ${values.get(key) ?? "<missing>"}`);
  }
}

async function validateBaseResources(root) {
  const manifestFile = path.join(root, "runtime", "manifest.properties");
  const manifest = parseProperties(await fs.readFile(manifestFile, "utf8"), manifestFile);
  requireProperty(manifest, "schema", "oliphaunt-runtime-resources-v1", manifestFile);
  requireProperty(manifest, "layout", "postgres-runtime-files-v1", manifestFile);
  if (csv(manifest.get("extensions"), `${manifestFile} extensions`).length > 0) {
    fail("base React Native iOS carrier is not extension-free");
  }
  if (csv(manifest.get("nativeModuleStems"), `${manifestFile} stems`).length > 0) {
    fail("base React Native iOS carrier contains native extension stems");
  }
  requireProperty(manifest, "mobileStaticRegistryState", "not-required", manifestFile);
  const template = path.join(root, "template-pgdata", "manifest.properties");
  const templateManifest = parseProperties(await fs.readFile(template, "utf8"), template);
  requireProperty(templateManifest, "schema", "oliphaunt-runtime-resources-v1", template);
  requireProperty(templateManifest, "layout", "postgres-template-pgdata-v1", template);
  return manifest;
}

async function extensionResourceRoot(carrier, cacheDir) {
  const root = await resolveAsset(carrier.assets.runtime, cacheDir);
  const manifestFile = path.join(root, "manifest.properties");
  const manifest = parseProperties(await fs.readFile(manifestFile, "utf8"), manifestFile);
  requireProperty(manifest, "packageLayout", "oliphaunt-extension-artifact-v1", manifestFile);
  requireProperty(manifest, "pgMajor", "18", manifestFile);
  requireProperty(manifest, "sqlName", carrier.sqlName, manifestFile);
  requireProperty(manifest, "createsExtension", carrier.createsExtension ? "yes" : "no", manifestFile);
  requireProperty(manifest, "dependencies", carrier.dependencies.join(","), manifestFile);
  requireProperty(manifest, "nativeModuleStem", carrier.nativeModuleStem ?? "", manifestFile);
  requireProperty(
    manifest,
    "sharedPreloadLibraries",
    carrier.sharedPreloadLibraries.join(","),
    manifestFile,
  );
  requireProperty(manifest, "mobilePrebuilt", "yes", manifestFile);
  requireProperty(manifest, "files", "files", manifestFile);
  const share = path.join(root, "files", "share", "postgresql");
  if ((await statOrUndefined(share))?.isDirectory() !== true) {
    fail(`${carrier.sqlName} runtime carrier is missing files/share/postgresql`);
  }
  if (carrier.createsExtension) {
    const directory = path.join(share, "extension");
    const names = await fs.readdir(directory);
    if (!names.includes(`${carrier.sqlName}.control`)) {
      fail(`${carrier.sqlName} carrier is missing its control file`);
    }
    if (!names.some((name) => name.startsWith(`${carrier.sqlName}--`) && name.endsWith(".sql"))) {
      fail(`${carrier.sqlName} carrier is missing an install SQL file`);
    }
  }
  return { root, share };
}

function selectedClosure(requested, bySqlName) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(sqlName, requiredBy) {
    if (visited.has(sqlName)) return;
    if (visiting.has(sqlName)) fail(`extension dependency cycle includes ${sqlName}`);
    const carrier = bySqlName.get(sqlName);
    if (!carrier) fail(`missing iOS carrier for ${sqlName}${requiredBy ? ` required by ${requiredBy}` : ""}`);
    visiting.add(sqlName);
    for (const dependency of carrier.dependencies) visit(dependency, sqlName);
    visiting.delete(sqlName);
    visited.add(sqlName);
    ordered.push(carrier);
  }
  for (const sqlName of requested) visit(sqlName, undefined);
  return ordered;
}

function writeProperties(values) {
  const preferred = [
    "schema", "layout", "cacheKey", "source", "extensions", "runtimeFeatures",
    "sharedPreloadLibraries", "mobileStaticRegistryState", "mobileStaticRegistryRegistered",
    "mobileStaticRegistryPending", "nativeModuleStems", "mobileStaticRegistrySource",
  ];
  const keys = [
    ...preferred.filter((key) => values.has(key)),
    ...[...values.keys()].filter((key) => !preferred.includes(key)).sort(),
  ];
  return `${keys.map((key) => `${key}=${values.get(key)}`).join("\n")}\n`;
}

function renderRegistrySource(nativeCarriers) {
  const declarations = [];
  const arrays = [];
  const descriptors = [];
  for (const carrier of nativeCarriers) {
    const suffix = carrier.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_");
    const array = `oliphaunt_${suffix}_symbols`;
    declarations.push(`extern const void *${carrier.registration.magicSymbol}(void);`);
    if (carrier.registration.initSymbol) declarations.push(`extern void ${carrier.registration.initSymbol}(void);`);
    for (const symbol of carrier.registration.symbols) declarations.push(`extern void ${symbol.address}(void);`);
    if (carrier.registration.symbols.length > 0) {
      arrays.push(
        `static const OliphauntStaticExtensionSymbol ${array}[] = {\n` +
          carrier.registration.symbols
            .map(({ name, address }) => `    { .name = ${JSON.stringify(name)}, .address = (void *)${address} },`)
            .join("\n") +
          `\n};`,
      );
    }
    descriptors.push(
      `    {\n` +
        `        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n` +
        `        .name = ${JSON.stringify(carrier.nativeModuleStem)},\n` +
        `        .magic = ${carrier.registration.magicSymbol},\n` +
        `        .init = ${carrier.registration.initSymbol ?? "NULL"},\n` +
        `        .symbols = ${carrier.registration.symbols.length > 0 ? array : "NULL"},\n` +
        `        .symbol_count = ${carrier.registration.symbols.length > 0 ? `sizeof(${array}) / sizeof(${array}[0])` : "0"},\n` +
        `        .reserved_flags = 0,\n` +
        `    },`,
    );
  }
  return `/* Generated by ${PREFIX}. Do not edit. */\n` +
    `#include <stddef.h>\n#include "oliphaunt.h"\n\n` +
    `${[...new Set(declarations)].sort().join("\n")}\n\n` +
    `${arrays.join("\n\n")}\n\n` +
    `static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n` +
    `${descriptors.join("\n")}\n};\n\n` +
    `const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {\n` +
    `    if (count != NULL) *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);\n` +
    `    return liboliphaunt_static_extensions;\n}\n`;
}

async function treeSize(root) {
  if ((await statOrUndefined(root)) === undefined) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const name of await fs.readdir(current)) {
      const file = path.join(current, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) pending.push(file);
      else if (stat.isFile()) { bytes += stat.size; files += 1; }
      else fail(`generated payload contains unsupported entry: ${file}`);
    }
  }
  return { bytes, files };
}

function renderPayloadPodspec(version, hasNative) {
  return `Pod::Spec.new do |s|\n` +
    `  s.name = "OliphauntReactNativePayload"\n` +
    `  s.version = ${JSON.stringify(version)}\n` +
    `  s.summary = "Generated app-owned Oliphaunt iOS runtime payload."\n` +
    `  s.license = { :type => "MIT AND Apache-2.0 AND PostgreSQL" }\n` +
    `  s.homepage = "https://oliphaunt.dev"\n` +
    `  s.authors = { "Oliphaunt" => "opensource@oliphaunt.dev" }\n` +
    `  s.source = { :git => "https://github.com/f0rr0/oliphaunt.git", :tag => "app-owned-payload" }\n` +
    `  s.platforms = { :ios => "17.0" }\n` +
    `  s.resources = "resources/OliphauntReactNativeResources.bundle"\n` +
    `  s.vendored_frameworks = "frameworks/base/**/*.{framework,xcframework}", "frameworks/extensions/**/*.xcframework"\n` +
    (hasNative
      ? `  s.source_files = "generated/static-registry/*.c"\n  s.user_target_xcconfig = { "OTHER_LDFLAGS" => "$(inherited) -u _liboliphaunt_selected_static_extensions" }\n`
      : "") +
    `  s.dependency "COliphaunt"\n` +
    `end\n`;
}

async function stage(args, base, selected) {
  const selectionHash = createHash("sha256")
    .update(JSON.stringify({ base, icu: args.icu, selected }))
    .digest("hex");
  const outputParent = path.dirname(args.outputDir);
  const temporary = path.join(outputParent, `.${path.basename(args.outputDir)}.tmp-${process.pid}-${Date.now()}`);
  await fs.mkdir(outputParent, { recursive: true });
  await fs.rm(temporary, { force: true, recursive: true });
  try {
    const baseResources = await resolveAsset(base.assets.runtime, args.cacheDir);
    const baseManifest = await validateBaseResources(baseResources);
    const resourceRoot = path.join(
      temporary,
      "resources",
      "OliphauntReactNativeResources.bundle",
      "oliphaunt",
    );
    await copyTree(baseResources, resourceRoot);
    if (args.icu) {
      const icuData = await resolveAsset(base.assets.icu, args.cacheDir);
      await requirePayloadDirectory(icuData, "ICU data carrier member");
      await mergeTree(icuData, path.join(resourceRoot, "runtime", "files", "share", "icu"));
    }
    const baseFramework = await resolveAsset(base.assets.framework, args.cacheDir);
    if (!baseFramework.endsWith(".xcframework") && !baseFramework.endsWith(".framework")) {
      fail("base framework carrier member must be a .xcframework or .framework directory");
    }
    await copyTree(baseFramework, path.join(temporary, "frameworks", "base", path.basename(baseFramework)));

    const extensionRows = [];
    const nativeCarriers = selected.filter(({ nativeModuleStem }) => nativeModuleStem !== null);
    for (const carrier of selected) {
      const extensionResources = await extensionResourceRoot(carrier, args.cacheDir);
      await mergeTree(
        extensionResources.share,
        path.join(resourceRoot, "runtime", "files", "share", "postgresql"),
      );
      extensionRows.push({
        ...(await treeSize(extensionResources.share)),
        sqlName: carrier.sqlName,
      });
      if (carrier.assets.extension) {
        const frameworkAssets = [
          { asset: carrier.assets.extension, expected: `liboliphaunt_extension_${carrier.nativeModuleStem}.xcframework` },
          ...carrier.assets.dependencyFrameworks.map(({ asset, dependency }) => ({
            asset,
            expected: `liboliphaunt_dependency_${dependency}.xcframework`,
          })),
        ];
        for (const { asset, expected } of frameworkAssets) {
          const source = await resolveAsset(asset, args.cacheDir);
          if (path.basename(source) !== expected) {
            fail(`${carrier.sqlName} framework asset resolved to ${path.basename(source)}, expected ${expected}`);
          }
          await mergeTree(
            source,
            path.join(temporary, "frameworks", "extensions", expected),
          );
        }
      }
    }

    const createExtensions = selected.filter(({ createsExtension }) => createsExtension).map(({ sqlName }) => sqlName).sort();
    const nativeStems = nativeCarriers.map(({ nativeModuleStem }) => nativeModuleStem).sort();
    const nativeExtensions = nativeCarriers.map(({ sqlName }) => sqlName).sort();
    const nativeDependencies = [...new Set(nativeCarriers.flatMap(({ nativeDependencies }) => nativeDependencies))].sort();
    const sharedPreload = [...new Set(selected.flatMap(({ sharedPreloadLibraries }) => sharedPreloadLibraries))].sort();
    baseManifest.set("cacheKey", `react-native-ios-${selectionHash.slice(0, 32)}`);
    baseManifest.set("extensions", createExtensions.join(","));
    const runtimeFeatures = new Set(csv(baseManifest.get("runtimeFeatures"), "base runtime features"));
    if (args.icu) runtimeFeatures.add("icu");
    else runtimeFeatures.delete("icu");
    baseManifest.set("runtimeFeatures", [...runtimeFeatures].sort().join(","));
    baseManifest.set("sharedPreloadLibraries", sharedPreload.join(","));
    baseManifest.set("mobileStaticRegistryState", nativeStems.length > 0 ? "complete" : "not-required");
    baseManifest.set("mobileStaticRegistryRegistered", nativeExtensions.join(","));
    baseManifest.set("mobileStaticRegistryPending", "");
    baseManifest.set("nativeModuleStems", nativeStems.join(","));
    baseManifest.set("mobileStaticRegistrySource", nativeStems.length > 0 ? "oliphaunt_static_registry.c" : "");
    await fs.writeFile(path.join(resourceRoot, "runtime", "manifest.properties"), writeProperties(baseManifest));

    const registryRoot = path.join(resourceRoot, "static-registry");
    await fs.rm(registryRoot, { force: true, recursive: true });
    await fs.mkdir(registryRoot, { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "manifest.properties"),
      [
        "packageLayout=oliphaunt-static-registry-v1",
        "abiVersion=1",
        `state=${nativeStems.length > 0 ? "complete" : "not-required"}`,
        `source=${nativeStems.length > 0 ? "oliphaunt_static_registry.c" : ""}`,
        `registeredExtensions=${nativeExtensions.join(",")}`,
        "pendingExtensions=",
        `nativeModuleStems=${nativeStems.join(",")}`,
        `modules=${nativeStems.join(",")}`,
        `archiveTargets=${nativeStems.length > 0 ? "ios-device,ios-simulator" : ""}`,
        `dependencyArchiveTargets=${nativeDependencies.length > 0 ? "ios-device,ios-simulator" : ""}`,
        `dependencyArchives=${nativeDependencies.join(",")}`,
        "",
      ].join("\n"),
    );
    if (nativeCarriers.length > 0) {
      const generated = path.join(temporary, "generated", "static-registry");
      await fs.mkdir(generated, { recursive: true });
      await fs.writeFile(
        path.join(generated, "oliphaunt_static_registry.c"),
        renderRegistrySource(nativeCarriers),
      );
    }

    const runtimeSize = await treeSize(path.join(resourceRoot, "runtime"));
    const templateSize = await treeSize(path.join(resourceRoot, "template-pgdata"));
    const registrySize = await treeSize(registryRoot);
    const selectedBytes = extensionRows.reduce((total, row) => total + row.bytes, 0);
    const selectedFiles = extensionRows.reduce((total, row) => total + row.files, 0);
    const extensionNames = createExtensions.length > 0 ? createExtensions.join(",") : "-";
    await fs.writeFile(
      path.join(resourceRoot, "package-size.tsv"),
      [
        "kind\tid\textensions\tfiles\tbytes",
        `package\ttotal\t${extensionNames}\t${runtimeSize.files + templateSize.files + registrySize.files}\t${runtimeSize.bytes + templateSize.bytes + registrySize.bytes}`,
        `package\truntime\t${extensionNames}\t${runtimeSize.files}\t${runtimeSize.bytes}`,
        `package\ttemplate-pgdata\t-\t${templateSize.files}\t${templateSize.bytes}`,
        `package\tstatic-registry\t${extensionNames}\t${registrySize.files}\t${registrySize.bytes}`,
        `extensions\tselected\t${extensionNames}\t${selectedFiles}\t${selectedBytes}`,
        ...extensionRows.sort((left, right) => left.sqlName.localeCompare(right.sqlName))
          .map((row) => `extension\t${row.sqlName}\t-\t${row.files}\t${row.bytes}`),
        "",
      ].join("\n"),
    );

    const frozen = {
      base: { product: base.product, version: base.version, assets: base.assets },
      cacheKey: `react-native-ios-${selectionHash.slice(0, 32)}`,
      extensions: selected.map((carrier) => ({
        assets: carrier.assets,
        dependencies: carrier.dependencies,
        nativeDependencies: carrier.nativeDependencies,
        nativeModuleStem: carrier.nativeModuleStem,
        product: carrier.product,
        sqlName: carrier.sqlName,
        version: carrier.version,
      })),
      requestedExtensions: args.extensions,
      icu: args.icu,
      schema: OUTPUT_SCHEMA,
    };
    await fs.writeFile(path.join(temporary, "selection.json"), `${JSON.stringify(frozen, null, 2)}\n`);
    await fs.writeFile(
      path.join(temporary, "OliphauntReactNativePayload.podspec"),
      renderPayloadPodspec(base.version, nativeCarriers.length > 0),
    );
    await fs.rm(args.outputDir, { force: true, recursive: true });
    await fs.rename(temporary, args.outputDir);
  } catch (error) {
    await fs.rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

export async function stageIosApp(options) {
  const carriers = options.carriers ?? [
    ...(options.baseCarrier ? [options.baseCarrier] : []),
    ...(options.extensionCarriers ?? []),
  ];
  const args = {
    allowFileUrls: options.allowFileUrls === true,
    carriers: carriers.map((file) => path.resolve(file)),
    cacheDir: path.resolve(options.cacheDir ?? path.join(os.homedir(), ".cache", "oliphaunt", "react-native-ios")),
    extensions: uniquePortable(options.extensions ?? [], "selected extension"),
    icu: options.icu === true,
    outputDir: path.resolve(options.outputDir),
  };
  if (args.carriers.length === 0) fail("at least one carrier manifest is required");
  let base;
  const bySqlName = new Map();
  for (const file of args.carriers) {
    const document = await readCarrierDocument(file, args.allowFileUrls);
    if (base === undefined) {
      base = document.base;
    } else if (JSON.stringify(base) !== JSON.stringify(document.base)) {
      fail(`${file} pins a different base carrier than the other selected manifests`);
    }
    for (const carrier of document.extensions) {
      const existing = bySqlName.get(carrier.sqlName);
      if (existing && JSON.stringify(existing) !== JSON.stringify(carrier)) {
        fail(`carrier manifests disagree for exact extension ${carrier.sqlName}`);
      }
      bySqlName.set(carrier.sqlName, carrier);
    }
  }
  const selected = selectedClosure(args.extensions, bySqlName);
  await stage(args, base, selected);
  return { outputDir: args.outputDir, selected: selected.map(({ sqlName }) => sqlName) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await stageIosApp(args);
  console.log(
    `${PREFIX}: staged ${result.outputDir} (extensions=${result.selected.join(",") || "none"})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
