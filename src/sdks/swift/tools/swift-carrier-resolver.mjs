import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import {
  createPortablePathCollisionTracker,
  loadSwiftExtensionInventoryCatalog,
  validateSwiftExtensionResourceArtifact,
} from "./extension-resource-inventory.mjs";

const PREFIX = "swift-carrier-resolver";
const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
const EXTENSION_CARRIER_SCHEMA = "oliphaunt-swift-extension-carrier-v1";
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const C_ID = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const EXTRACTED_CACHE_SCHEMA = "oliphaunt-extracted-carrier-tree-v1";

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function fail(message) { throw new Error(`${PREFIX}: ${message}`); }
function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields must be exactly ${expected.join(",")}; got ${actual.join(",")}`);
  }
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
  const rows = value.map((row, index) => identifier(row, `${label}[${index}]`)).sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} repeats an identifier`);
  return rows;
}
function canonicalIds(value, label) {
  const rows = ids(value, label);
  if (JSON.stringify(value) !== JSON.stringify(rows)) fail(`${label} must be sorted in ordinal order`);
  return rows;
}
function canonicalRelativeFiles(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => {
    const relative = safeMember(row, `${label}[${index}]`);
    if (relative === ".") fail(`${label}[${index}] must name a file`);
    return relative;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} repeats a path`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) fail(`${label} must be sorted in ordinal order`);
  return rows;
}
function canonicalSqlFileNames(value, label) {
  const rows = canonicalIds(value, label);
  if (rows.some((name) => !name.endsWith(".sql"))) fail(`${label} must contain SQL basenames`);
  return rows;
}
function canonicalSqlFilePrefixes(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => {
    if (typeof row !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row)) {
      fail(`${label}[${index}] must be a dot-free portable SQL basename prefix`);
    }
    return row;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} repeats a prefix`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) fail(`${label} must be sorted in ordinal order`);
  return rows;
}
async function loadCanonicalOwners(ownerCatalogFile) {
  return loadSwiftExtensionInventoryCatalog(ownerCatalogFile);
}
function assertCanonicalOwner(extension, owners, label) {
  const owner = owners.get(extension.sqlName);
  if (owner === undefined) fail(`${label} has no generated canonical release owner for ${extension.sqlName}`);
  if (extension.product !== owner.product) {
    fail(`${label}.product must be canonical owner ${owner.product} for ${extension.sqlName}`);
  }
}
function assertOwnerReleaseConsistency(extensions, label) {
  const releases = new Map();
  for (const extension of extensions) {
    const identity = `${extension.version}\0${extension.tag}`;
    const existing = releases.get(extension.product);
    if (existing !== undefined && existing !== identity) {
      fail(`${label} assigns inconsistent version/tag identities to release owner ${extension.product}`);
    }
    releases.set(extension.product, identity);
  }
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
function runWithCwd(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${label}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  return result.stdout;
}
export function localTarArchiveBinding(archive, pathImplementation = path) {
  if (typeof archive !== "string" || archive.length === 0) fail("tar archive path must be non-empty");
  const archiveName = pathImplementation.basename(archive);
  const cwd = pathImplementation.dirname(archive);
  if (!archiveName || archiveName === "." || archiveName === pathImplementation.sep) {
    fail("tar archive path must identify a file");
  }
  return { archiveName, cwd };
}
function safeMember(value, label) {
  if (value === ".") return value;
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(`${label} is unsafe`);
  const parts = value.replace(/^\.\//u, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} is unsafe`);
  const relative = parts.join("/");
  if (relative !== relative.normalize("NFC")) fail(`${label} must be canonical NFC`);
  return relative;
}
function portableAssetName(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || path.posix.basename(value) !== value ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) || /[ .]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) fail(`${label} must be a portable release asset file name`);
  return value;
}
function asset(value, label, allowFileUrls) {
  const row = object(value, label);
  exactKeys(row, ["bytes", "format", "member", "name", "role", "sha256", "url"], label);
  const role = identifier(row.role, `${label}.role`);
  portableAssetName(row.name, `${label}.name`);
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
  return rows.sort((left, right) => compareText(`${left.role}\0${left.member}`, `${right.role}\0${right.member}`));
}
function carrierEnvelope(value, label, allowFileUrls) {
  const row = object(value, label);
  exactKeys(row, ["bytes", "format", "name", "sha256", "url"], label);
  portableAssetName(row.name, `${label}.name`);
  if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
    fail(`${label} has invalid size/checksum`);
  }
  if (!["zip", "tar.gz"].includes(row.format)) fail(`${label} has unsupported format`);
  if ((row.format === "zip" && !row.name.endsWith(".zip")) || (row.format === "tar.gz" && !row.name.endsWith(".tar.gz"))) {
    fail(`${label}.name does not match format ${row.format}`);
  }
  let url;
  try { url = new URL(row.url); } catch { fail(`${label}.url must be an absolute URL`); }
  if (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) fail(`${label}.url must use HTTPS`);
  let urlName;
  try { urlName = decodeURIComponent(path.posix.basename(url.pathname)); } catch { fail(`${label}.url contains invalid escaping`); }
  if (urlName !== row.name) fail(`${label}.url must end with ${row.name}`);
  return { bytes: row.bytes, format: row.format, name: row.name, sha256: row.sha256, url: url.href };
}
function carrierEnvelopes(value, label, allowFileUrls) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => carrierEnvelope(row, `${label}[${index}]`, allowFileUrls));
  if (new Set(rows.map(({ name }) => name)).size !== rows.length) fail(`${label} repeats a carrier name`);
  rows.sort((left, right) => compareText(left.name, right.name));
  return new Map(rows.map((row) => [row.name, row]));
}
function assetLocator(value, label, carriers) {
  const row = object(value, label);
  exactKeys(row, ["bytes", "carrier", "format", "member", "path", "role", "sha256"], label);
  const role = identifier(row.role, `${label}.role`);
  const carrier = portableAssetName(row.carrier, `${label}.carrier`);
  const envelope = carriers.get(carrier);
  if (envelope === undefined) fail(`${label}.carrier references undeclared envelope ${carrier}`);
  const memberPath = safeMember(row.path, `${label}.path`);
  const member = safeMember(row.member, `${label}.member`);
  if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
    fail(`${label} has invalid logical payload size/checksum`);
  }
  if (!["zip", "tar.gz"].includes(row.format)) fail(`${label} has unsupported logical payload format`);
  if (memberPath === ".") {
    if (row.bytes !== envelope.bytes || row.sha256 !== envelope.sha256 || row.format !== envelope.format) {
      fail(`${label} direct payload metadata must exactly match carrier ${carrier}`);
    }
  } else {
    if (envelope.format !== "tar.gz") fail(`${label} nested payload carrier must be a tar.gz archive`);
    const nestedName = path.posix.basename(memberPath);
    portableAssetName(nestedName, `${label}.path basename`);
    if ((row.format === "zip" && !nestedName.endsWith(".zip")) || (row.format === "tar.gz" && !nestedName.endsWith(".tar.gz"))) {
      fail(`${label}.path does not match logical payload format ${row.format}`);
    }
  }
  return { bytes: row.bytes, carrier, envelope, format: row.format, member, path: memberPath, role, sha256: row.sha256 };
}
function assetLocators(value, label, carriers) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) => assetLocator(row, `${label}[${index}]`, carriers));
  const identities = rows.map(({ carrier, member, path: memberPath, role }) => `${role}\0${member}\0${carrier}\0${memberPath}`);
  if (new Set(identities).size !== rows.length) fail(`${label} repeats an asset locator identity`);
  return rows.sort((left, right) => compareText(
    `${left.role}\0${left.member}\0${left.carrier}\0${left.path}`,
    `${right.role}\0${right.member}\0${right.carrier}\0${right.path}`,
  ));
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
  }).sort((left, right) => compareText(`${left.name}\0${left.address}`, `${right.name}\0${right.address}`));
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
  const unsupported = [...new Set(rows.filter(({ role }) => !allowed.has(role)).map(({ role }) => role))].sort(compareText);
  if (unsupported.length) fail(`${label}.assets has unsupported roles: ${unsupported.join(",")}`);
  const framework = oneRole(rows, "base-xcframework", `${label}.assets`);
  oneRole(rows, "runtime-resources", `${label}.assets`);
  oneRole(rows, "icu-data", `${label}.assets`);
  if (!path.posix.basename(framework.member).endsWith(".xcframework")) fail(`${label} base framework member must be an XCFramework`);
  return { assets: rows, product: row.product, tag: row.tag, version };
}
function validateBaseReference(value, label) {
  const row = object(value, label);
  exactKeys(row, ["product", "tag", "version"], label);
  if (row.product !== "liboliphaunt-native") fail(`${label}.product must be liboliphaunt-native`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${row.product}-v${version}`) fail(`${label}.tag must be ${row.product}-v${version}`);
  return { product: row.product, tag: row.tag, version };
}
function validateDependencyCarrierReference(value, label) {
  const row = object(value, label);
  exactKeys(row, ["product", "sqlName", "tag", "version"], label);
  const sqlName = identifier(row.sqlName, `${label}.sqlName`);
  const product = identifier(row.product, `${label}.product`);
  if (!product.startsWith("oliphaunt-extension-")) fail(`${label}.product must be an extension release product`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${product}-v${version}`) fail(`${label}.tag must be ${product}-v${version}`);
  return { product, sqlName, tag: row.tag, version };
}
function validateExtensionReleaseReference(value, label) {
  const row = object(value, label);
  exactKeys(row, ["product", "tag", "version"], label);
  const product = identifier(row.product, `${label}.product`);
  if (!product.startsWith("oliphaunt-extension-")) fail(`${label}.product must be an extension release product`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${product}-v${version}`) fail(`${label}.tag must be ${product}-v${version}`);
  return { product, tag: row.tag, version };
}
function validateExtension(value, label, carriers) {
  const row = object(value, label);
  exactKeys(row, [
    "assets", "createsExtension", "dataFiles", "dependencies", "extensionSqlFileNames",
    "extensionSqlFilePrefixes", "nativeDependencies", "nativeModuleStem", "product",
    "registration", "sharedPreloadLibraries", "sqlName", "tag", "version",
  ], label);
  const sqlName = identifier(row.sqlName, `${label}.sqlName`);
  const product = identifier(row.product, `${label}.product`);
  if (!product.startsWith("oliphaunt-extension-")) fail(`${label}.product must be an extension release product`);
  const version = stableVersion(row.version, `${label}.version`);
  if (row.tag !== `${product}-v${version}`) fail(`${label}.tag must be ${product}-v${version}`);
  if (typeof row.createsExtension !== "boolean") fail(`${label}.createsExtension must be boolean`);
  const nativeModuleStem = row.nativeModuleStem === null ? null : identifier(row.nativeModuleStem, `${label}.nativeModuleStem`);
  const dependencies = canonicalIds(row.dependencies, `${label}.dependencies`);
  if (dependencies.includes(sqlName)) fail(`${label}.dependencies must not include ${sqlName} itself`);
  return {
    assets: assetLocators(row.assets, `${label}.assets`, carriers),
    createsExtension: row.createsExtension,
    dataFiles: canonicalRelativeFiles(row.dataFiles, `${label}.dataFiles`),
    dependencies,
    extensionSqlFileNames: canonicalSqlFileNames(
      row.extensionSqlFileNames,
      `${label}.extensionSqlFileNames`,
    ),
    extensionSqlFilePrefixes: canonicalSqlFilePrefixes(
      row.extensionSqlFilePrefixes,
      `${label}.extensionSqlFilePrefixes`,
    ),
    nativeDependencies: canonicalIds(row.nativeDependencies, `${label}.nativeDependencies`),
    nativeModuleStem,
    product,
    registration: row.registration === null ? null : registration(row.registration, `${label}.registration`),
    sharedPreloadLibraries: canonicalIds(
      row.sharedPreloadLibraries,
      `${label}.sharedPreloadLibraries`,
    ),
    sqlName,
    tag: row.tag,
    version,
  };
}
function assertExactCarrierCoverage(carriers, extensions, label) {
  const referenced = new Set(extensions.flatMap((extension) => extension.assets.map(({ carrier }) => carrier)));
  const declared = [...carriers.keys()].sort(compareText);
  const used = [...referenced].sort(compareText);
  if (JSON.stringify(declared) !== JSON.stringify(used)) {
    fail(`${label} carrier envelopes must exactly cover referenced logical payloads; declared=${declared.join(",")}, used=${used.join(",")}`);
  }
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

async function materializeLogicalPayload(locator, carrierFile, cacheDir, carrierMemberCache) {
  if (locator.path === ".") return carrierFile;
  const directory = path.join(cacheDir, "payloads");
  const output = path.join(directory, `${locator.sha256}-${path.posix.basename(locator.path)}`);
  await fs.mkdir(directory, { recursive: true });
  const existing = await stat(output);
  if (
    existing?.isFile()
    && !existing.isSymbolicLink()
    && existing.size === locator.bytes
    && await digest(output) === locator.sha256
  ) return output;
  await fs.rm(output, { force: true, recursive: true });

  let members = carrierMemberCache.get(locator.envelope.sha256);
  if (members === undefined) {
    members = await archiveMembers(carrierFile, locator.envelope.format);
    carrierMemberCache.set(locator.envelope.sha256, members);
  }
  if (!members.has(locator.path)) {
    fail(`${locator.envelope.name} lacks nested logical payload ${locator.path}`);
  }
  const temporaryRoot = path.join(directory, `.tmp-${process.pid}-${Date.now()}-${locator.sha256}`);
  await fs.rm(temporaryRoot, { force: true, recursive: true });
  await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    const outerBinding = localTarArchiveBinding(carrierFile);
    runWithCwd(
      "tar",
      ["-xzf", outerBinding.archiveName, "-C", temporaryRoot, locator.path],
      outerBinding.cwd,
      `extract ${locator.path} from ${locator.envelope.name}`,
    );
    const selected = path.join(temporaryRoot, ...locator.path.split("/"));
    const selectedStat = await stat(selected);
    if (selectedStat?.isFile() !== true || selectedStat.isSymbolicLink()) {
      fail(`${locator.envelope.name} nested payload ${locator.path} is not a regular file`);
    }
    if (selectedStat.size !== locator.bytes || await digest(selected) !== locator.sha256) {
      fail(`${locator.envelope.name} nested payload ${locator.path} does not match its frozen size/checksum`);
    }
    await fs.rename(selected, output);
    return output;
  } finally {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
}
function tarString(header, offset, length, file) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field.subarray(0, end < 0 ? field.length : end));
  } catch {
    fail(`${file} contains a non-UTF-8 ustar header field`);
  }
}
function tarOctal(header, offset, length, label, file) {
  const value = header.subarray(offset, offset + length).toString("ascii").replaceAll("\0", "").trim();
  if (value !== "" && !/^[0-7]+$/u.test(value)) fail(`${file} has invalid ustar ${label}`);
  const parsed = value === "" ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${file} has unsafe ustar ${label}`);
  return parsed;
}
async function tarEntries(file) {
  const entries = [];
  let currentEntry = "archive header";
  let pending = Buffer.alloc(0);
  let remainingPayload = 0;
  let terminated = false;
  let zeroBlocks = 0;
  try {
    const stream = createReadStream(file).pipe(createGunzip());
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        if (terminated) {
          if (!chunk.subarray(offset).every((value) => value === 0)) {
            fail(`${file} has data after its ustar end marker`);
          }
          break;
        }
        if (remainingPayload > 0) {
          const consumed = Math.min(remainingPayload, chunk.length - offset);
          remainingPayload -= consumed;
          offset += consumed;
          continue;
        }
        const consumed = Math.min(512 - pending.length, chunk.length - offset);
        pending = pending.length === 0
          ? Buffer.from(chunk.subarray(offset, offset + consumed))
          : Buffer.concat([pending, chunk.subarray(offset, offset + consumed)]);
        offset += consumed;
        if (pending.length < 512) continue;

        const header = pending;
        pending = Buffer.alloc(0);
        if (header.every((value) => value === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) terminated = true;
          continue;
        }
        if (zeroBlocks > 0) fail(`${file} has an incomplete ustar end marker`);

        const posixUstar = header.subarray(257, 263).equals(Buffer.from("ustar\0"))
          && header.subarray(263, 265).equals(Buffer.from("00"));
        const gnuUstar = header.subarray(257, 263).equals(Buffer.from("ustar "))
          && header[263] === 0x20 && header[264] === 0;
        if (!posixUstar && !gnuUstar) fail(`${file} contains a non-ustar header`);

        const expectedChecksum = tarOctal(header, 148, 8, "checksum", file);
        let actualChecksum = 0;
        for (let index = 0; index < 512; index += 1) {
          actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
        }
        if (expectedChecksum !== actualChecksum) fail(`${file} has an invalid ustar header checksum`);

        const name = tarString(header, 0, 100, file);
        const prefix = tarString(header, 345, 155, file);
        const raw = prefix ? `${prefix}/${name}` : name;
        currentEntry = JSON.stringify(raw);
        const size = tarOctal(header, 124, 12, `size for ${currentEntry}`, file);
        const typeFlag = header[156];
        const type = typeFlag === 0 || typeFlag === 0x30 ? "-" : typeFlag === 0x35 ? "d" : null;
        if (type === null) fail(`${file} contains a link or special entry: ${raw}`);
        if (type === "d" && size !== 0) fail(`${file} has a non-empty directory entry: ${raw}`);
        remainingPayload = Math.ceil(size / 512) * 512;
        if (!Number.isSafeInteger(remainingPayload)) fail(`${file} has unsafe padded size for ${currentEntry}`);
        entries.push({ raw, type });
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${PREFIX}:`)) throw error;
    fail(`${file} is not a readable gzip tar archive: ${error.message}`);
  }
  if (remainingPayload > 0) fail(`${file} has a truncated entry: ${currentEntry}`);
  if (pending.length > 0) fail(`${file} has a truncated ustar header`);
  if (!terminated) fail(`${file} is missing its two-block ustar end marker`);
  return entries;
}
async function archiveMembers(file, format) {
  let entries;
  if (format === "tar.gz") {
    entries = await tarEntries(file);
  } else {
    const rawNames = run("unzip", ["-Z1", file], `inspect ${file}`)
      .split(/\r?\n/u)
      .filter((value) => value.length > 0);
    const typeLines = run("zipinfo", ["-l", file], `inspect ${file} types`)
      .split(/\r?\n/u)
      .filter((line) => /^[bcdlps-][rwxStTs-]{9}\s/u.test(line));
    if (rawNames.length === 0 || typeLines.length !== rawNames.length) {
      fail(`${file} archive metadata does not establish one type for every member`);
    }
    entries = rawNames.map((raw, index) => ({ raw, type: typeLines[index][0] }));
  }
  if (entries.length === 0) fail(`${file} has no archive members`);
  const normalizedEntries = entries.map(({ raw, type }) => {
    if (!["-", "d"].includes(type)) fail(`${file} contains a link or special entry: ${raw}`);
    const directoryMarker = raw.endsWith("/");
    // A POSIX tar typeflag 5 is sufficient to identify a directory; the slash
    // is a canonical producer convention, not a tar-format requirement. ZIP
    // still requires its path marker and metadata type to agree.
    const markerMismatch = format === "zip"
      ? (type === "d") !== directoryMarker
      : type !== "d" && directoryMarker;
    if (markerMismatch && raw !== "." && raw !== "./") {
      fail(`${file} member type/path marker mismatch: ${raw}`);
    }
    return {
      name: safeMember(raw.replace(/\/$/u, "") || ".", `${file} member`),
      type: type === "d" ? "directory" : "file",
    };
  });
  const names = normalizedEntries.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail(`${file} repeats a normalized archive member`);
  const trackPortablePath = createPortablePathCollisionTracker(`${PREFIX}: ${file}`);
  for (const name of names) trackPortablePath(name);
  const files = new Set(normalizedEntries.filter(({ type }) => type === "file").map(({ name }) => name));
  for (const entry of normalizedEntries) {
    let separator = entry.name.indexOf("/");
    while (separator >= 0) {
      const parent = entry.name.slice(0, separator);
      if (files.has(parent)) fail(`${file} uses file ${parent} as an archive directory`);
      separator = entry.name.indexOf("/", separator + 1);
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
    for (const name of (await fs.readdir(directory)).sort(compareText).reverse()) {
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
  entries.sort((left, right) => compareText(left.path, right.path));
  return entries;
}

export async function extractVerifiedZipArchive({ archive, destination }) {
  const archivePath = path.resolve(archive);
  const destinationPath = path.resolve(destination);
  const archiveStat = await stat(archivePath);
  if (archiveStat?.isFile() !== true || archiveStat.isSymbolicLink()) {
    fail(`ZIP archive is not a regular file: ${archivePath}`);
  }
  if (await stat(destinationPath) !== undefined) {
    fail(`verified ZIP destination already exists: ${destinationPath}`);
  }
  await archiveMembers(archivePath, "zip");
  const parent = path.dirname(destinationPath);
  await fs.mkdir(parent, { recursive: true });
  const parentStat = await stat(parent);
  if (parentStat?.isDirectory() !== true || parentStat.isSymbolicLink()) {
    fail(`verified ZIP destination parent is unsafe: ${parent}`);
  }
  const temporary = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { force: true, recursive: true });
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    run("unzip", ["-q", archivePath, "-d", temporary], `extract ${archivePath}`);
    const tree = await extractedTree(temporary);
    if (!tree.some(({ type }) => type === "file")) {
      fail(`${archivePath} contains no regular files`);
    }
    await fs.rename(temporary, destinationPath);
    return tree;
  } finally {
    await fs.rm(temporary, { force: true, recursive: true });
  }
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
  const members = await archiveMembers(archive, row.format);
  if (row.member !== "." && !members.has(row.member) && ![...members].some((entry) => entry.startsWith(`${row.member}/`))) fail(`${row.name} lacks ${row.member}`);
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  const temporaryManifest = `${cacheManifest}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  try {
    if (row.format === "zip") run("unzip", ["-q", archive, "-d", temporary], `extract ${row.name}`);
    else {
      const innerBinding = localTarArchiveBinding(archive);
      runWithCwd(
        "tar",
        ["-xzf", innerBinding.archiveName, "-C", temporary],
        innerBinding.cwd,
        `extract ${row.envelope.name}`,
      );
    }
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
  extensionCarrierFiles = [],
  extensions,
  cacheDir = path.join(os.homedir(), ".cache", "oliphaunt", "swift-extensions"),
  allowFileUrls = false,
  offline = false,
  localBinaryTargets = false,
  basePackageUrl = "https://github.com/f0rr0/oliphaunt.git",
  basePackageVersion,
  ownerCatalogFile = undefined,
}) {
  const canonicalOwners = await loadCanonicalOwners(ownerCatalogFile);
  let document;
  try { document = JSON.parse(await fs.readFile(carrierFile, "utf8")); } catch (error) { fail(`could not read carrier ${carrierFile}: ${error.message}`); }
  const root = object(document, carrierFile);
  exactKeys(root, ["base", "carriers", "extensions", "schema"], carrierFile);
  if (root.schema !== SCHEMA) fail(`${carrierFile} has unsupported schema`);
  const base = validateBase(root.base, `${carrierFile}.base`, allowFileUrls);
  const rootCarriers = carrierEnvelopes(root.carriers, `${carrierFile}.carriers`, allowFileUrls);
  if (!Array.isArray(root.extensions)) fail(`${carrierFile}.extensions must be an array`);
  const validatedExtensions = root.extensions.map((row, index) =>
    validateExtension(row, `${carrierFile}.extensions[${index}]`, rootCarriers));
  for (const [index, extension] of validatedExtensions.entries()) {
    assertCanonicalOwner(extension, canonicalOwners, `${carrierFile}.extensions[${index}]`);
  }
  assertOwnerReleaseConsistency(validatedExtensions, `${carrierFile}.extensions`);
  assertExactCarrierCoverage(rootCarriers, validatedExtensions, carrierFile);
  const byName = new Map(validatedExtensions.map((row) => [row.sqlName, row]));
  if (byName.size !== root.extensions.length) fail("carrier repeats an extension row");
  if (!Array.isArray(extensionCarrierFiles) || extensionCarrierFiles.some((file) => typeof file !== "string" || file.length === 0)) {
    fail("extensionCarrierFiles must be an array of carrier paths");
  }
  const explicitNames = new Set();
  const membersByCarrier = new Map();
  const dependencyRequirements = new Map();
  for (const carrier of extensionCarrierFiles) {
    let overlayDocument;
    try {
      overlayDocument = JSON.parse(await fs.readFile(carrier, "utf8"));
    } catch (error) {
      fail(`could not read extension carrier ${carrier}: ${error.message}`);
    }
    const overlay = object(overlayDocument, carrier);
    exactKeys(overlay, ["base", "carriers", "entries", "release", "schema"], carrier);
    if (overlay.schema !== EXTENSION_CARRIER_SCHEMA) fail(`${carrier} has unsupported extension carrier schema`);
    const overlayBase = validateBaseReference(overlay.base, `${carrier}.base`);
    if (
      overlayBase.product !== base.product
      || overlayBase.version !== base.version
      || overlayBase.tag !== base.tag
    ) {
      fail(`${carrier} requires ${overlayBase.tag}, but the base carrier provides ${base.tag}`);
    }
    const release = validateExtensionReleaseReference(overlay.release, `${carrier}.release`);
    const overlayCarriers = carrierEnvelopes(overlay.carriers, `${carrier}.carriers`, allowFileUrls);
    if (!Array.isArray(overlay.entries) || overlay.entries.length === 0) {
      fail(`${carrier}.entries must be a non-empty array`);
    }
    const carrierMembers = new Set();
    const carrierExtensions = [];
    for (const [index, rawEntry] of overlay.entries.entries()) {
      const entry = object(rawEntry, `${carrier}.entries[${index}]`);
      exactKeys(entry, ["dependencyCarriers", "extension"], `${carrier}.entries[${index}]`);
      const extension = validateExtension(entry.extension, `${carrier}.entries[${index}].extension`, overlayCarriers);
      assertCanonicalOwner(extension, canonicalOwners, `${carrier}.entries[${index}].extension`);
      if (
        extension.product !== release.product
        || extension.version !== release.version
        || extension.tag !== release.tag
      ) {
        fail(`${carrier}.entries[${index}].extension must be owned by ${release.tag}`);
      }
      if (explicitNames.has(extension.sqlName)) {
        fail(`extension carriers repeat explicit row ${extension.sqlName}`);
      }
      if (!Array.isArray(entry.dependencyCarriers)) {
        fail(`${carrier}.entries[${index}].dependencyCarriers must be an array`);
      }
      const requirements = entry.dependencyCarriers.map((row, dependencyIndex) =>
        validateDependencyCarrierReference(
          row,
          `${carrier}.entries[${index}].dependencyCarriers[${dependencyIndex}]`,
        ));
      for (const [dependencyIndex, requirement] of requirements.entries()) {
        const canonicalOwner = canonicalOwners.get(requirement.sqlName);
        if (canonicalOwner === undefined || requirement.product !== canonicalOwner.product) {
          fail(
            `${carrier}.entries[${index}].dependencyCarriers[${dependencyIndex}].product must be canonical owner `
              + `${canonicalOwner?.product ?? "<missing>"} for ${requirement.sqlName}`,
          );
        }
      }
      if (new Set(requirements.map(({ sqlName }) => sqlName)).size !== requirements.length) {
        fail(`${carrier}.entries[${index}].dependencyCarriers repeats an extension dependency`);
      }
      const requiredNames = requirements.map(({ sqlName }) => sqlName).sort(compareText);
      if (JSON.stringify(requiredNames) !== JSON.stringify(extension.dependencies)) {
        fail(`${carrier}.entries[${index}].dependencyCarriers must exactly pin ${extension.sqlName} dependencies`);
      }
      explicitNames.add(extension.sqlName);
      carrierMembers.add(extension.sqlName);
      carrierExtensions.push(extension);
      dependencyRequirements.set(extension.sqlName, requirements);
      byName.set(extension.sqlName, extension);
    }
    assertOwnerReleaseConsistency(carrierExtensions, `${carrier}.entries`);
    assertExactCarrierCoverage(overlayCarriers, carrierExtensions, carrier);
    membersByCarrier.set(carrier, carrierMembers);
  }
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
  assertOwnerReleaseConsistency(ordered, "resolved selected extensions");
  const unusedCarriers = [...membersByCarrier]
    .filter(([, members]) => ![...members].some((name) => visited.has(name)))
    .map(([carrier]) => carrier)
    .sort(compareText);
  if (unusedCarriers.length > 0) {
    fail(`extension carrier file(s) supplied no selected or required row: ${unusedCarriers.join(",")}`);
  }
  for (const [sqlName, requirements] of dependencyRequirements) {
    for (const requirement of requirements) {
      const selected = byName.get(requirement.sqlName);
      if (
        selected === undefined
        || selected.product !== requirement.product
        || selected.version !== requirement.version
        || selected.tag !== requirement.tag
      ) {
        fail(
          `${sqlName} requires dependency carrier ${requirement.tag}, but resolved ` +
            `${selected?.tag ?? "no carrier"}`,
        );
      }
    }
  }
  const output = [];
  const materializedCarriers = new Map();
  const carrierMemberCache = new Map();
  for (const row of ordered) {
    const nativeDependencies = row.nativeDependencies;
    const rows = row.assets;
    const allowedRoles = new Set(["runtime-resources", "extension-xcframework", "dependency-xcframework"]);
    const unsupportedRoles = [...new Set(rows.filter(({ role }) => !allowedRoles.has(role)).map(({ role }) => role))].sort(compareText);
    if (unsupportedRoles.length) fail(`${row.sqlName} has unsupported asset roles: ${unsupportedRoles.join(",")}`);
    const runtimeRows = rows.filter(({ role }) => role === "runtime-resources");
    if (runtimeRows.length !== 1) fail(`${row.sqlName} must have one runtime-resources asset`);
    const materialized = new Map();
    for (const rowAsset of rows) {
      const carrierKey = `${rowAsset.envelope.sha256}\0${rowAsset.envelope.name}`;
      let carrierFile = materializedCarriers.get(carrierKey);
      if (carrierFile === undefined) {
        carrierFile = await materialize(rowAsset.envelope, cacheDir, { offline });
        materializedCarriers.set(carrierKey, carrierFile);
      }
      materialized.set(
        rowAsset,
        await materializeLogicalPayload(rowAsset, carrierFile, cacheDir, carrierMemberCache),
      );
    }
    const runtimeArchive = materialized.get(runtimeRows[0]);
    const resourceRoot = await extract(runtimeRows[0], runtimeArchive, cacheDir);
    const stem = row.nativeModuleStem === null ? null : row.nativeModuleStem;
    const extensionAssets = rows.filter(({ role }) => role === "extension-xcframework");
    const dependencyAssets = rows.filter(({ role }) => role === "dependency-xcframework").map((rowAsset) => {
      const match = /^liboliphaunt_dependency_(.+)\.xcframework$/u.exec(path.posix.basename(rowAsset.member));
      if (!match || !ID.test(match[1])) fail(`${row.sqlName} has malformed dependency framework member`);
      return { name: match[1], rowAsset };
    }).sort((left, right) => compareText(left.name, right.name));
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
    const binaryAsset = async (rowAsset) => {
      const requiresLocalPath = localBinaryTargets || rowAsset.path !== ".";
      return {
        name: rowAsset.envelope.name,
        url: rowAsset.envelope.url,
        checksum: rowAsset.envelope.sha256,
        ...(requiresLocalPath
          ? { localPath: await extract(rowAsset, materialized.get(rowAsset), cacheDir) }
          : {}),
      };
    };
    const resolvedNativeDependencies = [];
    for (const { name, rowAsset } of dependencyAssets) {
      resolvedNativeDependencies.push({
        name,
        asset: await binaryAsset(rowAsset),
      });
    }
    const primaryAsset = stem === null ? null : await binaryAsset(extensionAssets[0]);
    const resolvedExtension = {
      product: row.product,
      version: row.version,
      sqlName: row.sqlName,
      createsExtension: row.createsExtension,
      dataFiles: row.dataFiles,
      dependencies: row.dependencies,
      extensionSqlFileNames: row.extensionSqlFileNames,
      extensionSqlFilePrefixes: row.extensionSqlFilePrefixes,
      nativeModuleStem: stem,
      nativeDependencies: resolvedNativeDependencies,
      resourceRoot,
      sharedPreloadLibraries: row.sharedPreloadLibraries,
      asset: primaryAsset,
      registration: stem === null ? null : { hasInit: row.registration.initSymbol !== null, symbols: row.registration.symbols },
    };
    await validateSwiftExtensionResourceArtifact({
      extension: resolvedExtension,
      canonical: canonicalOwners.get(row.sqlName),
      nativeRuntime: { product: base.product, version: base.version },
      label: `${row.sqlName} resolved runtime resource artifact`,
      allowMobileCarrierArchives: true,
    });
    output.push(resolvedExtension);
  }
  stableVersion(basePackageVersion, "basePackageVersion");
  let packageUrl;
  try { packageUrl = new URL(basePackageUrl); } catch { fail("basePackageUrl must be an HTTPS Git URL"); }
  if (packageUrl.protocol !== "https:" || !packageUrl.pathname.endsWith(".git")) fail("basePackageUrl must be an HTTPS Git URL ending in .git");
  return {
    schema: "oliphaunt-swiftpm-extension-input-v1",
    basePackage: { name: "Oliphaunt", url: packageUrl.href, version: basePackageVersion },
    nativeRuntime: { product: base.product, version: base.version },
    extensions: output,
  };
}
