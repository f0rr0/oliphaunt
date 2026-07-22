import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { archiveTreeDigest } from "../policy/source-fetch-core.mjs";
import {
  extensionQualificationCandidates,
  qualificationCandidateTargets,
} from "./extension-qualification-candidates.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  releaseMavenLicenses,
  releaseProfilePackageLicense,
} from "./release-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXTERNAL_ROOT = path.join(ROOT, "src/extensions/external");
const PRODUCT_DATA_FILE = "upstream-license-data.json";
const CHECKOUT_ROOT = path.resolve(
  process.env.OLIPHAUNT_EXTENSION_SOURCE_CHECKOUT_ROOT
    ?? path.join(ROOT, "target/oliphaunt-sources/checkouts"),
);
const SCHEMA = "oliphaunt-extension-upstream-license-data-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const FILE_ROLES = new Set(["license", "notice"]);
const SPDX_ORDER = Object.freeze([
  "MIT",
  "Apache-2.0",
  "PostgreSQL",
  "Unicode-3.0",
  "MPL-2.0",
  "GPL-2.0-or-later",
  "LGPL-2.1-or-later",
  "blessing",
]);
const SUPPORTED_SPDX_IDS = new Set(SPDX_ORDER);
const CONTRIB_LICENSE = Object.freeze({
  product: "oliphaunt-extension-contrib-pg18",
  upstreamSpdx: "PostgreSQL",
  packageSpdx: "MIT AND PostgreSQL",
});
const OPENSSL_EMBEDDED_NATIVE_TARGETS = new Set([
  "android-arm64-v8a",
  "android-x86_64",
  "ios-xcframework",
  "macos-arm64",
  "macos-x64",
  "windows-x64-msvc",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`extension-upstream-licenses: ${message}`);
}

function simpleRelative(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    fail(`${label} must be a non-empty portable relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${label} must not contain empty, '.' or '..' components`);
  }
  return parts.join("/");
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    fail(`${label} must be an absolute URL: ${cause.message}`);
  }
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.includes("\\")
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) {
    fail(`${label} must be one canonical credential-free HTTPS URL without a fragment`);
  }
  return value;
}

function spdxExpression(ids) {
  const selected = new Set(ids);
  const known = SPDX_ORDER.filter((id) => selected.delete(id));
  return [...known, ...[...selected].sort(compareText)].join(" AND ");
}

export function assertSupportedExtensionUpstreamSpdxId(value, label = "extension upstream license") {
  if (typeof value !== "string" || !SUPPORTED_SPDX_IDS.has(value)) {
    fail(
      `${label} must declare one supported SPDX identifier (${SPDX_ORDER.join(", ")}); got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseSource(raw) {
  const id = raw?.id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) fail(`invalid source id ${JSON.stringify(id)}`);
  const manifest = simpleRelative(raw.manifest, `${id} source manifest`);
  if (!manifest.startsWith("src/extensions/external/")) {
    fail(`${id} source manifest must be under src/extensions/external/`);
  }
  const kind = raw.kind;
  if (!new Set(["git", "archive"]).has(kind)) fail(`${id} source kind must be git or archive`);
  const url = httpsUrl(raw.url, `${id} source URL`);
  const branch = raw.branch;
  const commit = raw.commit;
  if (typeof branch !== "string" || !branch || /[\u0000-\u001f\u007f]/u.test(branch)) {
    fail(`${id} source branch must be a non-empty printable string`);
  }
  if (kind === "git" ? !GIT_COMMIT.test(commit) : !SHA256.test(commit)) {
    fail(`${id} source commit is not an exact ${kind} identity`);
  }
  const manifestFile = path.join(ROOT, ...manifest.split("/"));
  let manifestData;
  let stat;
  try {
    stat = lstatSync(manifestFile);
    manifestData = Bun.TOML.parse(readFileSync(manifestFile, "utf8"));
  } catch (cause) {
    fail(`${manifest} cannot be inspected and parsed: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${manifest} must be a regular non-symlink file`);
  const manifestKind = manifestData.kind ?? "git";
  if (
    manifestData.name !== id
    || manifestKind !== kind
    || manifestData.url !== url
    || manifestData.branch !== branch
    || manifestData.commit !== commit
    || (kind === "archive" && manifestData.sha256 !== commit)
  ) {
    fail(`${id} source identity does not match ${manifest}`);
  }
  return Object.freeze({ id, manifest, kind, url, branch, commit });
}

function canonicalSource(source) {
  return {
    id: source.id,
    manifest: source.manifest,
    kind: source.kind,
    url: source.url,
    branch: source.branch,
    commit: source.commit,
  };
}

function canonicalFile(file) {
  return {
    source: file.source.id,
    path: file.path,
    destination: file.destination,
    role: file.role,
    spdx: file.spdx,
    license_url: file.licenseUrl,
    sha256: file.sha256,
  };
}

function decodeProductBlobs(rawBlobs, expectedDigests, label) {
  if (rawBlobs === null || typeof rawBlobs !== "object" || Array.isArray(rawBlobs)) {
    fail(`${label} must declare a blobs object`);
  }
  const digests = Object.keys(rawBlobs);
  if (JSON.stringify(digests) !== JSON.stringify([...digests].sort(compareText))) {
    fail(`${label} blob digests must be sorted`);
  }
  const expected = [...new Set(expectedDigests)].sort(compareText);
  if (JSON.stringify(digests) !== JSON.stringify(expected)) {
    fail(`${label} blob set differs: expected ${expected.join(", ")}, got ${digests.join(", ")}`);
  }
  const decoded = new Map();
  for (const digest of digests) {
    const encoded = rawBlobs[digest];
    if (
      !SHA256.test(digest)
      || typeof encoded !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    ) {
      fail(`${label} contains a malformed digest or base64 payload`);
    }
    const payload = Buffer.from(encoded, "base64");
    if (
      payload.toString("base64") !== encoded
      || createHash("sha256").update(payload).digest("hex") !== digest
    ) {
      fail(`${label} payload does not match digest ${digest}`);
    }
    decoded.set(digest, payload);
  }
  return decoded;
}

function parseProductContract(contractFile) {
  const label = path.relative(ROOT, contractFile);
  let bytes;
  let data;
  let stat;
  try {
    stat = lstatSync(contractFile);
    bytes = readFileSync(contractFile, "utf8");
    data = JSON.parse(bytes);
  } catch (cause) {
    fail(`${label} cannot be inspected and parsed: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (
    data?.schema !== SCHEMA
    || !Array.isArray(data.sources)
    || data.extension === null
    || typeof data.extension !== "object"
    || Array.isArray(data.extension)
    || data.blobs === null
    || typeof data.blobs !== "object"
    || Array.isArray(data.blobs)
    || Object.keys(data).join("\0") !== "schema\0sources\0extension\0blobs"
  ) {
    fail(`${label} must declare only schema ${SCHEMA}, sources, extension, and blobs`);
  }

  const sources = data.sources.map(parseSource);
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    fail(`${label} source ids must be unique`);
  }
  const sortedSources = [...sources].sort((left, right) => compareText(left.id, right.id));
  if (JSON.stringify(sources) !== JSON.stringify(sortedSources)) fail(`${label} source rows must be sorted by id`);
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const sqlName = data.extension.sql_name;
  const owner = path.basename(path.dirname(contractFile));
  if (typeof sqlName !== "string" || !SAFE_ID.test(sqlName) || sqlName !== owner) {
    fail(`${label} must be owned by its exact extension_sql_name directory`);
  }
  if (!Array.isArray(data.extension.files) || data.extension.files.length === 0) {
    fail(`${sqlName} must declare at least one upstream license or notice file`);
  }
  const files = [];
  const destinations = new Set();
  const usedSources = new Set();
  for (const rawFile of data.extension.files) {
    const source = sourceById.get(rawFile?.source);
    if (!source) fail(`${sqlName} file references unknown source ${JSON.stringify(rawFile?.source)}`);
    usedSources.add(source.id);
    const sourcePath = simpleRelative(rawFile.path, `${sqlName} license path`);
    const destination = simpleRelative(rawFile.destination, `${sqlName} license destination`);
    if (!destination.startsWith("share/licenses/")) {
      fail(`${sqlName} license destination must be under share/licenses/: ${destination}`);
    }
    if (destinations.has(destination)) fail(`${sqlName} repeats license destination ${destination}`);
    destinations.add(destination);
    if (!FILE_ROLES.has(rawFile.role)) fail(`${sqlName} ${destination} must have role license or notice`);
    const spdx = assertSupportedExtensionUpstreamSpdxId(rawFile.spdx, `${sqlName} ${destination}`);
    if (typeof rawFile.sha256 !== "string" || !SHA256.test(rawFile.sha256)) {
      fail(`${sqlName} ${destination} must declare a lowercase SHA-256 digest`);
    }
    files.push(Object.freeze({
      checkout: source.id,
      source,
      path: sourcePath,
      destination,
      role: rawFile.role,
      spdx,
      licenseUrl: httpsUrl(rawFile.license_url, `${sqlName} ${destination} license URL`),
      sha256: rawFile.sha256,
    }));
  }
  const sortedFiles = [...files].sort((left, right) => compareText(left.destination, right.destination));
  if (JSON.stringify(files) !== JSON.stringify(sortedFiles)) {
    fail(`${sqlName} license files must be sorted by destination`);
  }
  const unusedSources = sources.map((source) => source.id).filter((id) => !usedSources.has(id));
  if (unusedSources.length > 0) fail(`${label} has unused source identities: ${unusedSources.join(", ")}`);
  const blobs = decodeProductBlobs(data.blobs, files.map((file) => file.sha256), label);
  const canonical = `${JSON.stringify({
    schema: SCHEMA,
    sources: sources.map(canonicalSource),
    extension: {
      sql_name: sqlName,
      files: files.map(canonicalFile),
    },
    blobs: Object.fromEntries([...blobs.keys()].map((digest) => [digest, data.blobs[digest]])),
  }, null, 2)}\n`;
  if (bytes !== canonical) fail(`${label} must be canonical two-space JSON with one trailing newline`);
  return Object.freeze({
    row: Object.freeze({
      sqlName,
      upstreamSpdx: spdxExpression(files.map((file) => file.spdx)),
      packageSpdx: spdxExpression(["MIT", ...files.map((file) => file.spdx)]),
      files: Object.freeze(files),
    }),
    sources: Object.freeze(sources),
    blobs,
  });
}

const cachedProductContracts = new Map();

function productContractFile(sqlName) {
  if (typeof sqlName !== "string" || !SAFE_ID.test(sqlName)) {
    fail(`invalid extension SQL name ${JSON.stringify(sqlName)}`);
  }
  return path.join(EXTERNAL_ROOT, sqlName, PRODUCT_DATA_FILE);
}

function productContract(sqlName) {
  let parsed = cachedProductContracts.get(sqlName);
  if (parsed === undefined) {
    parsed = parseProductContract(productContractFile(sqlName));
    cachedProductContracts.set(sqlName, parsed);
  }
  return parsed;
}

function productContractSqlNames() {
  return readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(EXTERNAL_ROOT, entry.name, PRODUCT_DATA_FILE)))
    .map((entry) => entry.name)
    .sort(compareText);
}

function parseContract() {
  const productContracts = productContractSqlNames().map(productContract);
  const rows = productContracts.map((entry) => entry.row);
  const sortedRows = [...rows].sort((left, right) => compareText(left.sqlName, right.sqlName));
  if (JSON.stringify(rows) !== JSON.stringify(sortedRows)) fail("extension license rows must be sorted by sql_name");
  const sourceById = new Map();
  for (const source of productContracts.flatMap((entry) => entry.sources)) {
    const prior = sourceById.get(source.id);
    if (prior !== undefined && JSON.stringify(canonicalSource(prior)) !== JSON.stringify(canonicalSource(source))) {
      fail(`source id ${source.id} has conflicting identities across product-owned upstream license data`);
    }
    sourceById.set(source.id, source);
  }
  const sortedSources = [...sourceById.values()].sort((left, right) => compareText(left.id, right.id));
  const blobs = new Map();
  for (const productContract of productContracts) {
    for (const [digest, payload] of productContract.blobs) {
      const prior = blobs.get(digest);
      if (prior !== undefined && !prior.equals(payload)) fail(`committed upstream license blob conflicts at ${digest}`);
      blobs.set(digest, payload);
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    sources: Object.freeze(sortedSources),
    blobs,
  });
}

let cachedContract;

function contract() {
  cachedContract ??= parseContract();
  return cachedContract;
}

export function extensionUpstreamLicenseRows() {
  return contract().rows;
}

export function extensionUpstreamLicenseSources() {
  return contract().sources;
}

export function extensionUpstreamLicenseRow(sqlName) {
  return productContract(sqlName).row;
}

export function externalReleaseExtensionSqlNames() {
  const qualificationCandidates = new Map(
    extensionQualificationCandidates().map((candidate) => [candidate.extensionId, candidate]),
  );
  const sqlNames = [];
  for (const entry of readdirSync(path.join(ROOT, "src/extensions/external"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const releaseFile = path.join(ROOT, "src/extensions/external", entry.name, "release.toml");
    if (existsSync(releaseFile)) {
      let release;
      try {
        release = Bun.TOML.parse(readFileSync(releaseFile, "utf8"));
      } catch (cause) {
        fail(`${path.relative(ROOT, releaseFile)} cannot be read: ${cause.message}`);
      }
      if (typeof release?.extension_sql_name !== "string" || !SAFE_ID.test(release.extension_sql_name)) {
        fail(`${path.relative(ROOT, releaseFile)} must declare a safe extension_sql_name`);
      }
      sqlNames.push(release.extension_sql_name);
      continue;
    }
    const candidate = qualificationCandidates.get(entry.name);
    if (candidate !== undefined) sqlNames.push(candidate.sqlName);
  }
  const canonical = [...new Set(sqlNames)].sort(compareText);
  if (canonical.length !== sqlNames.length) fail("external release and qualification SQL names must be unique");
  return Object.freeze(canonical);
}

export function validateExtensionUpstreamLicenseContract() {
  const rows = extensionUpstreamLicenseRows();
  const expected = externalReleaseExtensionSqlNames();
  const actual = rows.map((row) => row.sqlName);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`contract extension set mismatch: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
  committedLicenseBlobs(rows.flatMap((row) => row.files.map((file) => file.sha256)));
  return rows;
}

function externalLicenseRow(product, members) {
  if (members.length !== 1) {
    fail(`${product} is not the explicit contrib bundle and must have exactly one external extension member`);
  }
  const row = extensionUpstreamLicenseRow(members[0]);
  const releaseToml = path.join(ROOT, "src/extensions/external", row.sqlName, "release.toml");
  let release;
  try {
    release = Bun.TOML.parse(readFileSync(releaseToml, "utf8"));
  } catch (cause) {
    fail(`${path.relative(ROOT, releaseToml)} cannot be read: ${cause.message}`);
  }
  if (release?.id !== product || release?.extension_sql_name !== row.sqlName) {
    fail(`${product} does not match ${row.sqlName}'s release identity`);
  }
  return row;
}

export function extensionRegistryLicense(product, members) {
  if (
    typeof product !== "string"
    || !Array.isArray(members)
    || members.length === 0
    || members.some((member) => typeof member !== "string" || !member)
  ) {
    fail("registry license lookup requires a product and non-empty member list");
  }
  if (product === CONTRIB_LICENSE.product) return CONTRIB_LICENSE;
  const row = externalLicenseRow(product, members);
  return Object.freeze({
    product,
    upstreamSpdx: row.upstreamSpdx,
    packageSpdx: row.packageSpdx,
  });
}

export function extensionMavenLicenses(product, members, { version } = {}) {
  if (product === CONTRIB_LICENSE.product) {
    return releaseMavenLicenses({ product, version, components: ["postgresql"] });
  }
  const row = externalLicenseRow(product, members);
  const entries = [...releaseMavenLicenses({ product, version })];
  const seen = new Set(entries.map((entry) => JSON.stringify(entry)));
  for (const file of row.files.filter((candidate) => candidate.role === "license")) {
    const entry = Object.freeze({
      name: `${file.spdx} (${file.source.id})`,
      url: file.licenseUrl,
      distribution: "repo",
    });
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      entries.push(entry);
      seen.add(key);
    }
  }
  return Object.freeze(entries);
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function committedLicenseBlobs(expectedDigests) {
  const blobs = contract().blobs;
  const actual = [...blobs.keys()].sort(compareText);
  const expected = [...new Set(expectedDigests)].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`committed upstream license blob set differs: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
  return blobs;
}

function productLicenseBlobs(sqlName, expectedDigests) {
  const blobs = productContract(sqlName).blobs;
  const actual = [...blobs.keys()].sort(compareText);
  const expected = [...new Set(expectedDigests)].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${sqlName} committed upstream license blob set differs: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
  return blobs;
}

function requireRealDirectory(directory, label, { create = false } = {}) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    if (cause?.code !== "ENOENT" || !create) fail(`${label} cannot be inspected: ${cause.message}`);
    mkdirSync(directory, { mode: 0o755 });
    stat = lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${directory}`);
}

function requireSafeDirectoryChain(directory, { create = true, label = "license staging" } = {}) {
  const resolved = path.resolve(directory);
  const filesystemRoot = path.parse(resolved).root;
  let cursor = filesystemRoot;
  requireRealDirectory(cursor, `${label} ancestor`);
  const relative = path.relative(filesystemRoot, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    requireRealDirectory(cursor, `${label} directory`, { create });
  }
  return resolved;
}

function safeDestination(root, relative) {
  const destination = path.join(root, ...relative.split("/"));
  let cursor = root;
  for (const part of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    requireRealDirectory(cursor, "license staging parent", { create: true });
  }
  let stat;
  try {
    stat = lstatSync(destination);
  } catch (cause) {
    if (cause?.code !== "ENOENT") fail(`license destination cannot be inspected: ${destination} (${cause.message})`);
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    fail(`license destination must be absent or a regular non-symlink file: ${destination}`);
  }
  return destination;
}

const validatedCheckouts = new Set();

function validateCheckout(source) {
  const sourceIdentity = JSON.stringify(canonicalSource(source));
  if (validatedCheckouts.has(sourceIdentity)) return path.join(CHECKOUT_ROOT, source.id);
  const checkout = path.join(CHECKOUT_ROOT, source.id);
  requireRealDirectory(checkout, `${source.id} checkout`);
  if (source.kind === "git") {
    const gitDirectory = path.join(checkout, ".git");
    requireRealDirectory(gitDirectory, `${source.id} Git metadata`);
    const git = (args, label) => {
      const result = captureCommandOutput("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd: checkout,
        label,
        maxOutputBytes: 1024 * 1024,
      });
      if (result.error || result.signal || result.status !== 0) {
        fail(`${label} failed: ${result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`}`);
      }
      return result.stdout.trim();
    };
    const head = git(["rev-parse", "--verify", "HEAD"], `read ${source.id} source HEAD`);
    const remote = git(["remote", "get-url", "origin"], `read ${source.id} source origin`);
    const status = git(["status", "--porcelain=v1", "--untracked-files=all"], `read ${source.id} source status`);
    if (head !== source.commit || remote !== source.url || status !== "") {
      fail(`${source.id} checkout does not exactly match clean pinned source ${source.url}@${source.commit}`);
    }
  } else {
    const marker = path.join(checkout, ".oliphaunt-source-pin");
    let markerStat;
    let fields;
    try {
      markerStat = lstatSync(marker);
      fields = new Map(readFileSync(marker, "utf8").trimEnd().split("\n").map((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) fail(`${source.id} archive source marker is malformed`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    } catch (cause) {
      fail(`${source.id} archive source marker cannot be inspected: ${cause.message}`);
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) fail(`${source.id} archive marker must be a regular file`);
    if (
      fields.size !== 9
      || fields.get("safety") !== "source-archive-v2"
      || fields.get("name") !== source.id
      || fields.get("kind") !== "archive"
      || fields.get("url") !== source.url
      || fields.get("branch") !== source.branch
      || fields.get("commit") !== source.commit
      || fields.get("sha256") !== source.commit
      || !SHA256.test(fields.get("tree-sha256") ?? "")
      || archiveTreeDigest(checkout) !== fields.get("tree-sha256")
    ) {
      fail(`${source.id} archive checkout does not exactly match its pinned source marker and tree digest`);
    }
  }
  validatedCheckouts.add(sourceIdentity);
  return checkout;
}

export function stageExtensionUpstreamLicenses(sqlName, filesRoot) {
  const externalRoot = path.join(ROOT, "src/extensions/external", sqlName);
  if (
    !existsSync(path.join(externalRoot, "release.toml"))
    && !existsSync(path.join(externalRoot, "publication-blocker.toml"))
  ) return Object.freeze([]);
  const row = extensionUpstreamLicenseRow(sqlName);
  const blobs = productLicenseBlobs(sqlName, row.files.map((file) => file.sha256));
  const stagingRoot = requireSafeDirectoryChain(filesRoot);
  const staged = [];
  for (const file of row.files) {
    const source = blobs.get(file.sha256);
    if (source === undefined) fail(`${sqlName} has no committed legal bytes for ${file.destination}`);
    const destination = safeDestination(stagingRoot, file.destination);
    writeFileSync(destination, source);
    chmodSync(destination, 0o644);
    const destinationStat = lstatSync(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || (destinationStat.mode & 0o777) !== 0o644) {
      fail(`${sqlName} staged license is not a regular mode-0644 file: ${file.destination}`);
    }
    if (hashFile(destination) !== file.sha256) fail(`${sqlName} staged license bytes changed for ${file.destination}`);
    staged.push(file.destination);
  }
  return Object.freeze(staged);
}

export function auditExtensionUpstreamLicenseSources() {
  const blobs = committedLicenseBlobs(extensionUpstreamLicenseRows().flatMap((row) => row.files.map((file) => file.sha256)));
  let checked = 0;
  for (const row of extensionUpstreamLicenseRows()) {
    for (const file of row.files) {
      const sourceRoot = validateCheckout(file.source);
      const source = path.join(sourceRoot, ...file.path.split("/"));
      let sourceStat;
      try {
        sourceStat = lstatSync(source);
      } catch (cause) {
        fail(`${row.sqlName} license source is missing: ${path.relative(ROOT, source)} (${cause.message})`);
      }
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        fail(`${row.sqlName} license source must be a regular non-symlink file: ${path.relative(ROOT, source)}`);
      }
      const realRoot = realpathSync(sourceRoot);
      const realSource = realpathSync(source);
      if (!realSource.startsWith(`${realRoot}${path.sep}`)) {
        fail(`${row.sqlName} license source escapes checkout ${file.source.id}: ${file.path}`);
      }
      const sourceBytes = readFileSync(source);
      const actualSha256 = createHash("sha256").update(sourceBytes).digest("hex");
      if (actualSha256 !== file.sha256 || !sourceBytes.equals(blobs.get(file.sha256))) {
        fail(
          `${row.sqlName} legal bytes changed for ${file.source.id}/${file.path}: expected committed digest ${file.sha256}, got ${actualSha256}`,
        );
      }
      checked += 1;
    }
  }
  return checked;
}

function checkedLicenseRows(sqlNames) {
  if (
    !Array.isArray(sqlNames)
    || sqlNames.length === 0
    || sqlNames.some((sqlName) => typeof sqlName !== "string" || !SAFE_ID.test(sqlName))
    || new Set(sqlNames).size !== sqlNames.length
  ) {
    fail("upstream license assertion requires a non-empty unique extension member list");
  }
  return sqlNames.map(extensionUpstreamLicenseRow);
}

function expectedLicenseFiles(sqlNames) {
  const expected = new Map();
  for (const row of checkedLicenseRows(sqlNames)) {
    for (const file of row.files) {
      const prior = expected.get(file.destination);
      if (prior && prior.sha256 !== file.sha256) {
        fail(`upstream license destination collision at ${file.destination}`);
      }
      expected.set(file.destination, file);
    }
  }
  return expected;
}

export function extensionCarrierLegalContract(
  product,
  sqlNames,
  { family, target, carriesPayload = true } = {},
) {
  if (
    typeof product !== "string"
    || !product
    || !Array.isArray(sqlNames)
    || sqlNames.length === 0
    || sqlNames.some((sqlName) => typeof sqlName !== "string" || !SAFE_ID.test(sqlName))
    || new Set(sqlNames).size !== sqlNames.length
    || typeof carriesPayload !== "boolean"
  ) {
    fail("carrier legal lookup requires a product, a unique non-empty extension member list, and carriesPayload");
  }
  if (!carriesPayload) {
    return Object.freeze({
      profile: "code-facade",
      packageSpdx: releaseProfilePackageLicense("code-facade").spdx,
      upstreamMembers: Object.freeze([]),
      licenseFiles: Object.freeze([]),
    });
  }
  if (!new Set(["native", "wasix"]).has(family) || typeof target !== "string" || !target) {
    fail("payload-bearing carrier legal lookup requires family=native|wasix and an exact target");
  }
  if (product === CONTRIB_LICENSE.product) {
    const embedsOpenSsl = sqlNames.includes("pgcrypto")
      && (family === "wasix" || OPENSSL_EMBEDDED_NATIVE_TARGETS.has(target));
    const profile = `${family === "native" ? "contrib-native" : "contrib-wasix"}${embedsOpenSsl ? "-openssl" : ""}`;
    return Object.freeze({
      profile,
      packageSpdx: releaseProfilePackageLicense(profile).spdx,
      upstreamMembers: Object.freeze([]),
      licenseFiles: Object.freeze([]),
    });
  }
  const registry = extensionRegistryLicense(product, sqlNames);
  const licenseFiles = [...expectedLicenseFiles(sqlNames).keys()].sort(compareText);
  return Object.freeze({
    profile: `external-${family}`,
    packageSpdx: registry.packageSpdx,
    upstreamMembers: Object.freeze([...sqlNames]),
    licenseFiles: Object.freeze(licenseFiles),
  });
}

export function extensionQualificationLegalContract(
  sqlName,
  { family, target } = {},
) {
  const candidate = extensionQualificationCandidates().find((row) => row.sqlName === sqlName);
  if (candidate === undefined) {
    fail(`${sqlName} is not a canonical publication-deferred qualification candidate`);
  }
  if (!new Set(["native", "wasix"]).has(family) || typeof target !== "string" || !target) {
    fail("qualification legal lookup requires family=native|wasix and an exact target");
  }
  if (!qualificationCandidateTargets(candidate).some((row) => row.family === family && row.target === target)) {
    fail(`${sqlName} is not declared for qualification target ${family}:${target}`);
  }
  const row = checkedLicenseRows([sqlName])[0];
  return Object.freeze({
    profile: `external-${family}`,
    packageSpdx: row.packageSpdx,
    upstreamMembers: Object.freeze([sqlName]),
    licenseFiles: Object.freeze([...expectedLicenseFiles([sqlName]).keys()].sort(compareText)),
    qualificationOnly: true,
  });
}

function checkedArchivePrefix(value = "") {
  if (value === "") return "";
  return simpleRelative(String(value).replace(/\/$/u, ""), "upstream license archive prefix");
}

function prefixed(prefix, member) {
  return prefix ? `${prefix}/${member}` : member;
}

export function assertExtensionUpstreamLicensesInDirectory(sqlNames, filesRoot) {
  const root = requireSafeDirectoryChain(filesRoot, {
    create: false,
    label: "upstream license assertion",
  });
  const expected = expectedLicenseFiles(sqlNames);
  const actualFiles = [];
  const actualDirectories = [];
  const licensesRoot = path.join(root, "share/licenses");
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) fail(`staged upstream license must not be a symlink: ${candidate}`);
      if (stat.isDirectory()) {
        actualDirectories.push(path.relative(root, candidate).split(path.sep).join("/"));
        visit(candidate);
      } else if (stat.isFile()) {
        actualFiles.push(path.relative(root, candidate).split(path.sep).join("/"));
      } else {
        fail(`staged upstream license tree contains a special entry: ${candidate}`);
      }
    }
  };
  if (!existsSync(licensesRoot)) fail(`staged upstream license directory is missing: ${licensesRoot}`);
  const licensesRootStat = lstatSync(licensesRoot);
  if (!licensesRootStat.isDirectory() || licensesRootStat.isSymbolicLink()) {
    fail(`staged upstream license root must be a real directory: ${licensesRoot}`);
  }
  visit(licensesRoot);
  const expectedNames = [...expected.keys()].sort(compareText);
  const expectedDirectories = expectedLicenseDirectories(expectedNames);
  if (JSON.stringify(actualFiles.sort(compareText)) !== JSON.stringify(expectedNames)) {
    fail(`staged upstream license members differ: expected ${expectedNames.join(", ")}, got ${actualFiles.sort(compareText).join(", ")}`);
  }
  if (JSON.stringify(actualDirectories.sort(compareText)) !== JSON.stringify(expectedDirectories)) {
    fail(
      `staged upstream license directories differ: expected ${expectedDirectories.join(", ")}, `
      + `got ${actualDirectories.sort(compareText).join(", ")}`,
    );
  }
  for (const [destination, file] of expected) {
    const staged = path.join(root, ...destination.split("/"));
    const stat = lstatSync(staged);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o644) {
      fail(`staged upstream license must be a regular mode-0644 file: ${destination}`);
    }
    if (hashFile(staged) !== file.sha256) fail(`staged upstream license bytes changed for ${destination}`);
  }
  return Object.freeze(expectedNames);
}

function expectedLicenseDirectories(expectedNames, prefix = "") {
  const namespaceRoot = prefixed(prefix, "share/licenses");
  const directories = new Set();
  for (const member of expectedNames) {
    let directory = path.posix.dirname(member);
    while (directory !== namespaceRoot) {
      if (!directory.startsWith(`${namespaceRoot}/`)) {
        fail(`upstream license member escapes its namespace: ${member}`);
      }
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort(compareText);
}

function archiveEntryKind(entry) {
  if (entry?.isSymbolicLink) return "symlink";
  if (entry?.isFile && !entry?.isDirectory) return "file";
  if (entry?.isDirectory && !entry?.isFile) return "directory";
  return "special";
}

export function assertExtensionUpstreamLicensesInEntries(sqlNames, entries, { prefix = "" } = {}) {
  if (!(entries instanceof Map)) fail("upstream license archive entries must be a Map");
  const normalizedPrefix = checkedArchivePrefix(prefix);
  const expected = expectedLicenseFiles(sqlNames);
  const expectedNames = [...expected.keys()].map((member) => prefixed(normalizedPrefix, member)).sort(compareText);
  const namespaceRoot = prefixed(normalizedPrefix, "share/licenses");
  const expectedDirectories = new Set(expectedLicenseDirectories(expectedNames, normalizedPrefix));
  expectedDirectories.add(namespaceRoot);
  const actualNames = [];
  for (const [member, entry] of entries) {
    if (member !== namespaceRoot && !member.startsWith(`${namespaceRoot}/`)) continue;
    const kind = archiveEntryKind(entry);
    if (expectedNames.includes(member)) {
      if (kind !== "file" || (entry.mode & 0o777) !== 0o644) {
        fail(`packed upstream license must be a regular non-symlink mode-0644 file: ${member}`);
      }
      actualNames.push(member);
      continue;
    }
    if (expectedDirectories.has(member)) {
      if (kind !== "directory" || (entry.mode & 0o777) !== 0o755) {
        fail(`packed upstream license directory must be a real mode-0755 directory: ${member}`);
      }
      continue;
    }
    fail(`packed upstream license namespace contains unexpected ${kind} member: ${member}`);
  }
  actualNames.sort(compareText);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(`packed upstream license members differ: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`);
  }
  for (const [destination, file] of expected) {
    const member = prefixed(normalizedPrefix, destination);
    const entry = entries.get(member);
    if (archiveEntryKind(entry) !== "file" || (entry.mode & 0o777) !== 0o644) {
      fail(`packed upstream license must be a regular non-symlink mode-0644 file: ${member}`);
    }
    const actual = createHash("sha256").update(entry.data()).digest("hex");
    if (actual !== file.sha256) fail(`packed upstream license bytes changed for ${member}`);
  }
  return Object.freeze(expectedNames);
}

export function assertExtensionUpstreamLicensesInArchive(sqlNames, archive, options = {}) {
  return assertExtensionUpstreamLicensesInEntries(
    sqlNames,
    readPortableArchiveEntries(archive),
    options,
  );
}
