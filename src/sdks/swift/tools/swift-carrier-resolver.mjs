import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PREFIX = "swift-carrier-resolver";
const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const C_ID = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const EXTRACTED_CACHE_SCHEMA = "oliphaunt-extracted-carrier-tree-v1";

function fail(message) { throw new Error(`${PREFIX}: ${message}`); }
function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extras.length) fail(`${label} contains unsupported field(s): ${extras.join(",")}`);
}
function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be a portable identifier`);
  return value;
}
function cIdentifier(value, label) {
  if (typeof value !== "string" || !C_ID.test(value)) fail(`${label} must be a C identifier`);
  return value;
}
function stableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_SEMVER.test(value)) fail(`${label} must be a stable SemVer X.Y.Z version`);
  return value;
}
function ids(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => identifier(row, `${label}[${index}]`)).sort();
  if (new Set(rows).size !== rows.length) fail(`${label} repeats an identifier`);
  return rows;
}
async function digest(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
async function stat(file) { return fs.lstat(file).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error)); }
function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${label}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  return result.stdout;
}
function safeMember(value, label) {
  if (value === ".") return value;
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(`${label} is unsafe`);
  const parts = value.replace(/^\.\//u, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} is unsafe`);
  return parts.join("/");
}
function asset(value, label, allowFileUrls) {
  const row = object(value, label);
  exactKeys(row, ["bytes", "format", "member", "name", "role", "sha256", "url"], label);
  const role = identifier(row.role, `${label}.role`);
  if (typeof row.name !== "string" || path.basename(row.name) !== row.name || /[\u0000-\u001f\u007f]/u.test(row.name)) fail(`${label} has invalid name`);
  if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail(`${label} has invalid size/checksum`);
  if (!["zip", "tar.gz"].includes(row.format)) fail(`${label} has unsupported format`);
  if ((row.format === "zip" && !row.name.endsWith(".zip")) || (row.format === "tar.gz" && !row.name.endsWith(".tar.gz"))) {
    fail(`${label}.name does not match format ${row.format}`);
  }
  let url;
  try { url = new URL(row.url); } catch { fail(`${label}.url must be an absolute URL`); }
  if (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) fail(`${label}.url must use HTTPS`);
  let urlName;
  try { urlName = decodeURIComponent(path.basename(url.pathname)); } catch { fail(`${label}.url contains invalid escaping`); }
  if (urlName !== row.name) fail(`${label}.url must end with ${row.name}`);
  return { bytes: row.bytes, format: row.format, member: safeMember(row.member, `${label}.member`), name: row.name, role, sha256: row.sha256, url: url.href };
}
function assets(value, label, allowFileUrls) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => asset(row, `${label}[${index}]`, allowFileUrls));
  for (const [description, keys] of [
    ["asset name", rows.map(({ name }) => name)],
    ["asset role/member identity", rows.map(({ role, member }) => `${role}\0${member}`)],
  ]) {
    if (new Set(keys).size !== keys.length) fail(`${label} repeats an ${description}`);
  }
  return rows.sort((left, right) => `${left.role}\0${left.member}`.localeCompare(`${right.role}\0${right.member}`));
}
function oneRole(rows, role, label) {
  const matches = rows.filter((row) => row.role === role);
  if (matches.length !== 1) fail(`${label} must have exactly one ${role} asset`);
  return matches[0];
}
function registration(value, label) {
  const row = object(value, label);
  exactKeys(row, ["initSymbol", "magicSymbol", "symbols"], label);
  const initSymbol = row.initSymbol === null ? null : cIdentifier(row.initSymbol, `${label}.initSymbol`);
  const magicSymbol = cIdentifier(row.magicSymbol, `${label}.magicSymbol`);
  if (!Array.isArray(row.symbols)) fail(`${label}.symbols must be an array`);
  const symbols = row.symbols.map((raw, index) => {
    const symbol = object(raw, `${label}.symbols[${index}]`);
    exactKeys(symbol, ["address", "name"], `${label}.symbols[${index}]`);
    return {
      address: cIdentifier(symbol.address, `${label}.symbols[${index}].address`),
      name: cIdentifier(symbol.name, `${label}.symbols[${index}].name`),
    };
  }).sort((left, right) => `${left.name}\0${left.address}`.localeCompare(`${right.name}\0${right.address}`));
  if (new Set(symbols.map(({ name }) => name)).size !== symbols.length) fail(`${label}.symbols repeats a SQL symbol`);
  return { initSymbol, magicSymbol, symbols };
}
function validateBase(value, label, allowFileUrls) {
  const row = object(value, label);
  exactKeys(row, ["assets", "product", "tag", "version"], label);
  if (row.product !== "liboliphaunt-native") fail(`${label}.product must be liboliphaunt-native`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${row.product}-v${version}`) fail(`${label}.tag must be ${row.product}-v${version}`);
  const rows = assets(row.assets, `${label}.assets`, allowFileUrls);
  const allowed = new Set(["base-xcframework", "icu-data", "runtime-resources"]);
  const unsupported = [...new Set(rows.filter(({ role }) => !allowed.has(role)).map(({ role }) => role))].sort();
  if (unsupported.length) fail(`${label}.assets has unsupported roles: ${unsupported.join(",")}`);
  const framework = oneRole(rows, "base-xcframework", `${label}.assets`);
  oneRole(rows, "runtime-resources", `${label}.assets`);
  oneRole(rows, "icu-data", `${label}.assets`);
  if (!path.posix.basename(framework.member).endsWith(".xcframework")) fail(`${label} base framework member must be an XCFramework`);
  return { assets: rows, product: row.product, tag: row.tag, version };
}
function validateExtension(value, label, allowFileUrls) {
  const row = object(value, label);
  exactKeys(row, [
    "assets", "createsExtension", "dependencies", "nativeDependencies", "nativeModuleStem",
    "product", "registration", "sharedPreloadLibraries", "sqlName", "tag", "version",
  ], label);
  const sqlName = identifier(row.sqlName, `${label}.sqlName`);
  const product = `oliphaunt-extension-${sqlName.replaceAll("_", "-")}`;
  if (row.product !== product) fail(`${label}.product must be ${product}`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${product}-v${version}`) fail(`${label}.tag must be ${product}-v${version}`);
  if (typeof row.createsExtension !== "boolean") fail(`${label}.createsExtension must be boolean`);
  const nativeModuleStem = row.nativeModuleStem === null ? null : identifier(row.nativeModuleStem, `${label}.nativeModuleStem`);
  return {
    assets: assets(row.assets, `${label}.assets`, allowFileUrls),
    createsExtension: row.createsExtension,
    dependencies: ids(row.dependencies, `${label}.dependencies`),
    nativeDependencies: ids(row.nativeDependencies, `${label}.nativeDependencies`),
    nativeModuleStem,
    product,
    registration: row.registration === null ? null : registration(row.registration, `${label}.registration`),
    sharedPreloadLibraries: ids(row.sharedPreloadLibraries, `${label}.sharedPreloadLibraries`),
    sqlName,
    tag: row.tag,
    version,
  };
}
async function materialize(row, cacheDir, { offline }) {
  const directory = path.join(cacheDir, "objects");
  const output = path.join(directory, `${row.sha256}-${row.name}`);
  await fs.mkdir(directory, { recursive: true });
  const existing = await stat(output);
  if (existing?.isFile() && existing.size === row.bytes && await digest(output) === row.sha256) return output;
  await fs.rm(output, { force: true, recursive: true });
  if (offline) fail(`offline cache miss for ${row.name}`);
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  try {
    const url = new URL(row.url);
    if (url.protocol === "file:") await fs.copyFile(fileURLToPath(url), temporary);
    else {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body || new URL(response.url).protocol !== "https:") fail(`download failed for ${row.url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    }
    const actual = await stat(temporary);
    if (actual?.size !== row.bytes) fail(`size mismatch for ${row.name}`);
    const actualDigest = await digest(temporary);
    if (actualDigest !== row.sha256) fail(`checksum mismatch for ${row.name}; got ${actualDigest}`);
    await fs.rename(temporary, output);
    return output;
  } finally { await fs.rm(temporary, { force: true }); }
}
function archiveMembers(file, format) {
  const namesOutput = format === "zip"
    ? run("unzip", ["-Z1", file], `inspect ${file}`)
    : run("tar", ["-tzf", file], `inspect ${file}`);
  const rawNames = namesOutput.split(/\r?\n/u).filter((value) => value.length > 0);
  const typeOutput = format === "zip"
    ? run("zipinfo", ["-l", file], `inspect ${file} types`)
    : run("tar", ["-tvzf", file], `inspect ${file} types`);
  const typeLines = typeOutput.split(/\r?\n/u).filter((line) => /^[bcdlps-][rwxStTs-]{9}\s/u.test(line));
  if (rawNames.length === 0 || typeLines.length !== rawNames.length) {
    fail(`${file} archive metadata does not establish one type for every member`);
  }
  const entries = rawNames.map((raw, index) => {
    const type = typeLines[index][0];
    if (!["-", "d"].includes(type)) fail(`${file} contains a link or special entry: ${raw}`);
    const directoryMarker = raw.endsWith("/");
    if ((type === "d") !== directoryMarker && raw !== "." && raw !== "./") {
      fail(`${file} member type/path marker mismatch: ${raw}`);
    }
    return {
      name: safeMember(raw.replace(/\/$/u, "") || ".", `${file} member`),
      type: type === "d" ? "directory" : "file",
    };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail(`${file} repeats a normalized archive member`);
  const folded = names.map((name) => name.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) fail(`${file} has case-colliding archive members`);
  for (const entry of entries) {
    if (entry.type === "file" && entries.some(({ name }) => name.startsWith(`${entry.name}/`))) {
      fail(`${file} uses file ${entry.name} as an archive directory`);
    }
  }
  return new Set(names);
}
function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function extractedTree(root) {
  const entries = [];
  const pending = [{ directory: root, relative: "" }];
  while (pending.length) {
    const { directory, relative } = pending.pop();
    for (const name of (await fs.readdir(directory)).sort().reverse()) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      safeMember(childRelative, `${root} extracted member`);
      const info = await fs.lstat(child);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail(`unsafe extracted entry ${child}`);
      if (info.isDirectory()) {
        entries.push({ path: childRelative, type: "directory" });
        pending.push({ directory: child, relative: childRelative });
      } else {
        entries.push({
          bytes: info.size,
          executable: (info.mode & 0o111) !== 0,
          path: childRelative,
          sha256: await digest(child),
          type: "file",
        });
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}
async function extractedCacheValid(root, manifestFile, archiveSha256) {
  if ((await stat(root))?.isDirectory() !== true || (await stat(manifestFile))?.isFile() !== true) return false;
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
async function extract(row, archive, cacheDir) {
  const output = path.join(cacheDir, "extracted", row.sha256);
  const cacheManifest = `${output}.tree.json`;
  if (await extractedCacheValid(output, cacheManifest, row.sha256)) {
    return row.member === "." ? output : path.join(output, row.member);
  }
  await fs.rm(output, { recursive: true, force: true });
  await fs.rm(cacheManifest, { force: true });
  const members = archiveMembers(archive, row.format);
  if (row.member !== "." && !members.has(row.member) && ![...members].some((entry) => entry.startsWith(`${row.member}/`))) fail(`${row.name} lacks ${row.member}`);
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  const temporaryManifest = `${cacheManifest}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  try {
    if (row.format === "zip") run("unzip", ["-q", archive, "-d", temporary], `extract ${row.name}`);
    else run("tar", ["-xzf", archive, "-C", temporary], `extract ${row.name}`);
    const tree = await extractedTree(temporary);
    const manifest = {
      archiveSha256: row.sha256,
      entries: tree,
      schema: EXTRACTED_CACHE_SCHEMA,
      treeSha256: jsonDigest(tree),
    };
    const selected = row.member === "." ? temporary : path.join(temporary, row.member);
    if ((await stat(selected))?.isDirectory() !== true) fail(`${row.name} member is not a directory: ${row.member}`);
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.rename(temporary, output);
    await fs.rename(temporaryManifest, cacheManifest);
    return row.member === "." ? output : path.join(output, row.member);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(temporaryManifest, { force: true });
    await fs.rm(output, { recursive: true, force: true });
    await fs.rm(cacheManifest, { force: true });
    throw error;
  }
}

export async function resolveSwiftCarrierSelection({
  carrierFile,
  extensions,
  cacheDir = path.join(os.homedir(), ".cache", "oliphaunt", "swift-extensions"),
  allowFileUrls = false,
  offline = false,
  basePackageUrl = "https://github.com/f0rr0/oliphaunt.git",
  basePackageVersion,
}) {
  let document;
  try { document = JSON.parse(await fs.readFile(carrierFile, "utf8")); } catch (error) { fail(`could not read carrier ${carrierFile}: ${error.message}`); }
  const root = object(document, carrierFile);
  exactKeys(root, ["base", "extensions", "schema"], carrierFile);
  if (root.schema !== SCHEMA) fail(`${carrierFile} has unsupported schema`);
  validateBase(root.base, `${carrierFile}.base`, allowFileUrls);
  if (!Array.isArray(root.extensions)) fail(`${carrierFile}.extensions must be an array`);
  const validatedExtensions = root.extensions.map((row, index) =>
    validateExtension(row, `${carrierFile}.extensions[${index}]`, allowFileUrls));
  const byName = new Map(validatedExtensions.map((row) => [row.sqlName, row]));
  if (byName.size !== root.extensions.length) fail("carrier repeats an extension row");
  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(name, parent) {
    if (visited.has(name)) return;
    if (visiting.has(name)) fail(`dependency cycle includes ${name}`);
    const row = byName.get(name);
    if (!row) fail(`missing carrier for ${name}${parent ? ` required by ${parent}` : ""}`);
    visiting.add(name);
    for (const dependency of ids(row.dependencies, `${name}.dependencies`)) visit(dependency, name);
    visiting.delete(name); visited.add(name); ordered.push(row);
  }
  for (const name of ids(extensions, "selected extensions")) visit(name);
  const output = [];
  for (const row of ordered) {
    const nativeDependencies = row.nativeDependencies;
    const rows = row.assets;
    const allowedRoles = new Set(["runtime-resources", "extension-xcframework", "dependency-xcframework"]);
    const unsupportedRoles = [...new Set(rows.filter(({ role }) => !allowedRoles.has(role)).map(({ role }) => role))].sort();
    if (unsupportedRoles.length) fail(`${row.sqlName} has unsupported asset roles: ${unsupportedRoles.join(",")}`);
    const runtimeRows = rows.filter(({ role }) => role === "runtime-resources");
    if (runtimeRows.length !== 1) fail(`${row.sqlName} must have one runtime-resources asset`);
    for (const rowAsset of rows) await materialize(rowAsset, cacheDir, { offline });
    const runtimeArchive = await materialize(runtimeRows[0], cacheDir, { offline });
    const resourceRoot = await extract(runtimeRows[0], runtimeArchive, cacheDir);
    const stem = row.nativeModuleStem === null ? null : row.nativeModuleStem;
    const extensionAssets = rows.filter(({ role }) => role === "extension-xcframework");
    const dependencyAssets = rows.filter(({ role }) => role === "dependency-xcframework").map((rowAsset) => {
      const match = /^liboliphaunt_dependency_(.+)\.xcframework$/u.exec(path.posix.basename(rowAsset.member));
      if (!match || !ID.test(match[1])) fail(`${row.sqlName} has malformed dependency framework member`);
      return { name: match[1], rowAsset };
    }).sort((left, right) => left.name.localeCompare(right.name));
    if (new Set(dependencyAssets.map(({ name }) => name)).size !== dependencyAssets.length) {
      fail(`${row.sqlName} repeats a dependency carrier identity`);
    }
    if (stem === null) {
      if (extensionAssets.length || dependencyAssets.length || nativeDependencies.length || row.registration !== null) fail(`${row.sqlName} SQL-only carrier fabricates native roles`);
    } else {
      if (!ID.test(stem) || extensionAssets.length !== 1 || path.posix.basename(extensionAssets[0].member) !== `liboliphaunt_extension_${stem}.xcframework`) fail(`${row.sqlName} lacks its exact extension XCFramework`);
      if (JSON.stringify(dependencyAssets.map(({ name }) => name)) !== JSON.stringify(nativeDependencies)) fail(`${row.sqlName} native dependency inventory mismatch`);
      const prefix = `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
      if (row.registration?.magicSymbol !== `${prefix}_Pg_magic_func` || ![null, `${prefix}__PG_init`].includes(row.registration?.initSymbol)) fail(`${row.sqlName} registration symbols do not match its native stem`);
    }
    output.push({
      product: row.product,
      version: row.version,
      sqlName: row.sqlName,
      dependencies: row.dependencies,
      nativeModuleStem: stem,
      nativeDependencies: dependencyAssets.map(({ name, rowAsset }) => ({ name, asset: { name: rowAsset.name, url: rowAsset.url, checksum: rowAsset.sha256 } })),
      resourceRoot,
      sharedPreloadLibraries: row.sharedPreloadLibraries,
      asset: stem === null ? null : { name: extensionAssets[0].name, url: extensionAssets[0].url, checksum: extensionAssets[0].sha256 },
      registration: stem === null ? null : { hasInit: row.registration.initSymbol !== null, symbols: row.registration.symbols },
    });
  }
  stableVersion(basePackageVersion, "basePackageVersion");
  let packageUrl;
  try { packageUrl = new URL(basePackageUrl); } catch { fail("basePackageUrl must be an HTTPS Git URL"); }
  if (packageUrl.protocol !== "https:" || !packageUrl.pathname.endsWith(".git")) fail("basePackageUrl must be an HTTPS Git URL ending in .git");
  return {
    schema: "oliphaunt-swiftpm-extension-input-v1",
    basePackage: { name: "Oliphaunt", url: packageUrl.href, version: basePackageVersion },
    extensions: output,
  };
}
