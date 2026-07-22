#!/usr/bin/env node

import { createHash } from "node:crypto";

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPortableArchiveEntries } from "./portable-archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREFIX = "release-notices.mjs";

export const RELEASE_NOTICE_PRODUCTS = Object.freeze(["native", "wasix"]);
export const RELEASE_LICENSE_COMPONENTS = Object.freeze(["postgresql", "icu", "openssl"]);
export const RELEASE_CARRIER_PROFILES = Object.freeze({
  "source-sdk": Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
  "code-facade": Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
  "node-direct-addon": Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
  broker: Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
  "native-runtime": Object.freeze({ products: Object.freeze(["native"]), components: Object.freeze(["postgresql", "icu"]) }),
  "native-tools": Object.freeze({ products: Object.freeze(["native"]), components: Object.freeze(["postgresql"]) }),
  "native-runtime-resources": Object.freeze({ products: Object.freeze(["native"]), components: Object.freeze(["postgresql"]) }),
  "native-icu-data": Object.freeze({ products: Object.freeze(["native"]), components: Object.freeze(["icu"]) }),
  "wasix-runtime": Object.freeze({ products: Object.freeze(["wasix"]), components: Object.freeze(["postgresql", "icu"]) }),
  "wasix-tools": Object.freeze({ products: Object.freeze(["wasix"]), components: Object.freeze(["postgresql", "icu"]) }),
  "wasix-aot": Object.freeze({ products: Object.freeze(["wasix"]), components: Object.freeze(["postgresql", "icu"]) }),
  "wasix-icu-data": Object.freeze({ products: Object.freeze(["wasix"]), components: Object.freeze(["icu"]) }),
  "contrib-native": Object.freeze({ products: Object.freeze([]), components: Object.freeze(["postgresql"]) }),
  "contrib-native-openssl": Object.freeze({ products: Object.freeze([]), components: Object.freeze(["postgresql", "openssl"]) }),
  "contrib-wasix": Object.freeze({ products: Object.freeze([]), components: Object.freeze(["postgresql"]) }),
  "contrib-wasix-openssl": Object.freeze({ products: Object.freeze([]), components: Object.freeze(["postgresql", "openssl"]) }),
  "external-native": Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
  "external-wasix": Object.freeze({ products: Object.freeze([]), components: Object.freeze([]) }),
});

const BASE_ROWS = Object.freeze([
  Object.freeze({
    member: "LICENSE",
    source: path.join(ROOT, "LICENSE"),
  }),
  Object.freeze({
    member: "THIRD_PARTY_NOTICES.md",
    source: path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
  }),
]);

const PRODUCT_NOTICE_ROWS = Object.freeze({
  native: Object.freeze({
    member: "THIRD_PARTY_NOTICES.liboliphaunt-native.md",
    source: path.join(ROOT, "src/runtimes/liboliphaunt/native/THIRD_PARTY_NOTICES.md"),
  }),
  wasix: Object.freeze({
    member: "THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
    source: path.join(ROOT, "src/bindings/wasix-rust/THIRD_PARTY_NOTICES.md"),
  }),
});

const LICENSE_COMPONENT_ROWS = Object.freeze({
  postgresql: Object.freeze({
    id: "postgresql",
    spdx: "PostgreSQL",
    name: "PostgreSQL License",
    member: "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    source: path.join(ROOT, "src/runtimes/liboliphaunt/licenses/postgresql-18.4-COPYRIGHT"),
    sourceManifest: path.join(ROOT, "src/postgres/versions/18/source.toml"),
    sourceVersion: "18.4",
    sha256: "3d6af92ff8a4c2cdf69afb1cf44edea727922f5cd0cf8b5f72b11cdecac8fdfd",
    sourceUrl: "https://ftp.postgresql.org/pub/source/v18.4/postgresql-18.4.tar.bz2",
    sourceIdentity: "sha256:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094",
    licenseUrl: "https://github.com/postgres/postgres/blob/REL_18_4/COPYRIGHT",
  }),
  icu: Object.freeze({
    id: "icu",
    spdx: "Unicode-3.0",
    name: "Unicode License v3",
    member: "THIRD_PARTY_LICENSES/ICU-LICENSE",
    source: path.join(ROOT, "src/runtimes/liboliphaunt/licenses/icu-76.1-LICENSE"),
    sourceManifest: path.join(ROOT, "src/sources/third-party/shared/icu.toml"),
    sourceVersion: "76.1",
    sourceBranch: "release-76-1",
    sourceCommit: "8eca245c7484ac6cc179e3e5f7c1ea7680810f39",
    sha256: "01edac20612b1e590c1c1cfb02b7218c6adc7b0a944eda7a1e03aeee10725aed",
    sourceUrl: "https://github.com/unicode-org/icu.git",
    sourceIdentity: "git:8eca245c7484ac6cc179e3e5f7c1ea7680810f39",
    licenseUrl: "https://github.com/unicode-org/icu/blob/8eca245c7484ac6cc179e3e5f7c1ea7680810f39/LICENSE",
  }),
  openssl: Object.freeze({
    id: "openssl",
    spdx: "Apache-2.0",
    name: "Apache License 2.0 (OpenSSL)",
    member: "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
    source: path.join(ROOT, "src/runtimes/liboliphaunt/licenses/openssl-3.5.6-LICENSE.txt"),
    sourceManifest: path.join(ROOT, "src/sources/third-party/shared/openssl.toml"),
    sourceVersion: "3.5.6",
    sourceBranch: "openssl-3.5.6",
    sourceCommit: "286ddeaac037533bbdce65b3c689e3f7ffebf0f6",
    sha256: "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
    sourceUrl: "https://github.com/openssl/openssl.git",
    sourceIdentity: "git:286ddeaac037533bbdce65b3c689e3f7ffebf0f6",
    licenseUrl: "https://github.com/openssl/openssl/blob/286ddeaac037533bbdce65b3c689e3f7ffebf0f6/LICENSE.txt",
  }),
});

const PRODUCT_NOTICE_NAMESPACE_PATTERN = /^THIRD_PARTY_NOTICES\.[^/]+\.md$/u;
const LICENSE_NAMESPACE_ROOT = "THIRD_PARTY_LICENSES";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkedProducts(values = []) {
  if (!Array.isArray(values)) {
    throw new Error("release notices products must be an array");
  }
  const result = [...new Set(values.map((value) => String(value)))].sort(compareText);
  for (const product of result) {
    if (!RELEASE_NOTICE_PRODUCTS.includes(product)) {
      throw new Error(
        `unsupported release notice product ${JSON.stringify(product)}; expected ${RELEASE_NOTICE_PRODUCTS.join(", ")}`,
      );
    }
  }
  return result;
}

function checkedComponents(values = []) {
  const candidates = values;
  if (!Array.isArray(candidates)) {
    throw new Error("release license components must be an array");
  }
  const selected = new Set(candidates.map((value) => String(value)));
  for (const component of selected) {
    if (!RELEASE_LICENSE_COMPONENTS.includes(component)) {
      throw new Error(
        `unsupported release license component ${JSON.stringify(component)}; expected ${RELEASE_LICENSE_COMPONENTS.join(", ")}`,
      );
    }
  }
  return RELEASE_LICENSE_COMPONENTS.filter((component) => selected.has(component));
}

export function releaseCarrierProfile(name) {
  const profile = RELEASE_CARRIER_PROFILES[name];
  if (!profile) {
    throw new Error(
      `unsupported release carrier profile ${JSON.stringify(name)}; expected ${Object.keys(RELEASE_CARRIER_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

function checkedSelection({ profile, products, components } = {}) {
  if (profile !== undefined) {
    if (products !== undefined || components !== undefined) {
      throw new Error("release carrier profile cannot be combined with explicit products or components");
    }
    return releaseCarrierProfile(profile);
  }
  return Object.freeze({
    products: Object.freeze(checkedProducts(products ?? [])),
    components: Object.freeze(checkedComponents(components ?? [])),
  });
}

function requireRealDirectory(directory, label) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    throw new Error(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function requireCanonicalSource(row) {
  let stat;
  try {
    stat = lstatSync(row.source);
  } catch (cause) {
    throw new Error(`canonical release notice ${row.source} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`canonical release notice must be a regular non-symlink file: ${row.source}`);
  }
  const bytes = readFileSync(row.source);
  if (bytes.length === 0) {
    throw new Error(`canonical release notice must be non-empty: ${row.source}`);
  }
  if (row.sha256) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.sha256) {
      throw new Error(`canonical release license digest changed for ${row.source}: expected ${row.sha256}, got ${actual}`);
    }
  }
  return bytes;
}

function validateRuntimeLicenseSource(row) {
  let manifest;
  try {
    manifest = Bun.TOML.parse(readFileSync(row.sourceManifest, "utf8"));
  } catch (cause) {
    throw new Error(`runtime license source manifest ${row.sourceManifest} cannot be parsed: ${cause.message}`);
  }
  if (row.id === "postgresql") {
    const source = manifest?.postgresql;
    if (
      source?.version !== row.sourceVersion
      || source?.url !== row.sourceUrl
      || `sha256:${source?.sha256}` !== row.sourceIdentity
    ) {
      throw new Error(`PostgreSQL runtime license snapshot no longer matches ${row.sourceManifest}`);
    }
    if (!path.basename(row.source).startsWith(`postgresql-${source.version}-`)) {
      throw new Error(`PostgreSQL runtime license snapshot name does not carry pinned version ${source.version}`);
    }
  } else {
    if (
      manifest?.name !== row.id
      || manifest?.url !== row.sourceUrl
      || manifest?.branch !== row.sourceBranch
      || manifest?.commit !== row.sourceCommit
      || row.sourceIdentity !== `git:${manifest.commit}`
    ) {
      throw new Error(`${row.id} runtime license snapshot no longer matches ${row.sourceManifest}`);
    }
    if (!path.basename(row.source).includes(row.sourceVersion)) {
      throw new Error(`${row.id} runtime license snapshot name does not carry pinned version ${row.sourceVersion}`);
    }
  }
  requireCanonicalSource(row);
  return row;
}

function checkedPrefix(value = "") {
  const raw = String(value);
  if (
    raw.startsWith("/")
    || raw.includes("\\")
    || /^[A-Za-z]:/u.test(raw)
    || /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new Error(`unsafe release notice archive prefix: ${JSON.stringify(value)}`);
  }
  const prefix = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    prefix.startsWith("/")
    || /^[A-Za-z]:/u.test(prefix)
    || prefix.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    if (prefix !== "") {
      throw new Error(`unsafe release notice archive prefix: ${JSON.stringify(value)}`);
    }
  }
  return prefix;
}

function requireSafeDirectoryChain(directory, label) {
  const resolved = path.resolve(directory);
  const filesystemRoot = path.parse(resolved).root;
  let cursor = filesystemRoot;
  requireRealDirectory(cursor, label);
  const relative = path.relative(filesystemRoot, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        throw new Error(`${label} cannot be inspected: ${cursor}: ${cause.message}`);
      }
      mkdirSync(cursor, { mode: 0o755 });
      stat = lstatSync(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must not have a symlink or non-directory ancestor: ${cursor}`);
    }
  }
  return resolved;
}

function requireSafeParent(root, destination, { create = false } = {}) {
  const relative = path.relative(root, path.dirname(destination));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`release notice destination escapes staging root: ${destination}`);
  }
  let cursor = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        throw new Error(`release notice parent ${cursor} cannot be inspected: ${cause.message}`);
      }
      if (!create) {
        throw new Error(`release notice parent is missing: ${cursor}`);
      }
      mkdirSync(cursor, { mode: 0o755 });
      stat = lstatSync(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`release notice parent must be a real directory: ${cursor}`);
    }
  }
}

function prefixedMember(prefix, member) {
  return prefix ? `${prefix}/${member}` : member;
}

function isExpectedNamespaceDirectory(member, expectedMembers) {
  if (member === LICENSE_NAMESPACE_ROOT) return true;
  return [...expectedMembers].some((expected) => expected.startsWith(`${member}/`));
}

function directoryNoticeNamespaceEntries(root) {
  const entries = [];
  for (const name of readdirSync(root).sort(compareText)) {
    if (!PRODUCT_NOTICE_NAMESPACE_PATTERN.test(name)) continue;
    const file = path.join(root, name);
    entries.push({ member: name, file, stat: lstatSync(file), namespace: "product notice" });
  }

  const licenses = path.join(root, LICENSE_NAMESPACE_ROOT);
  let rootStat;
  try {
    rootStat = lstatSync(licenses);
  } catch (cause) {
    if (cause?.code === "ENOENT") return entries;
    throw new Error(`release license namespace ${licenses} cannot be inspected: ${cause.message}`);
  }
  entries.push({
    member: LICENSE_NAMESPACE_ROOT,
    file: licenses,
    stat: rootStat,
    namespace: "release license",
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return entries;

  function walk(directory, memberPrefix) {
    for (const name of readdirSync(directory).sort(compareText)) {
      const file = path.join(directory, name);
      const member = `${memberPrefix}/${name}`;
      const stat = lstatSync(file);
      entries.push({ member, file, stat, namespace: "release license" });
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file, member);
    }
  }
  walk(licenses, LICENSE_NAMESPACE_ROOT);
  return entries;
}

function archiveNoticeNamespaceEntries(entries, prefix) {
  const namespaceEntries = [];
  const prefixMarker = prefix ? `${prefix}/` : "";
  for (const [archiveMember, entry] of entries) {
    if (prefixMarker && !archiveMember.startsWith(prefixMarker)) continue;
    const member = prefixMarker ? archiveMember.slice(prefixMarker.length) : archiveMember;
    if (PRODUCT_NOTICE_NAMESPACE_PATTERN.test(member)) {
      namespaceEntries.push({ archiveMember, entry, member, namespace: "product notice" });
    } else if (member === LICENSE_NAMESPACE_ROOT || member.startsWith(`${LICENSE_NAMESPACE_ROOT}/`)) {
      namespaceEntries.push({ archiveMember, entry, member, namespace: "release license" });
    }
  }
  return namespaceEntries.sort((left, right) => compareText(left.archiveMember, right.archiveMember));
}

function unexpectedNamespaceEntry(namespaceEntry, expectedMembers) {
  if (expectedMembers.has(namespaceEntry.member)) return false;
  if (
    namespaceEntry.namespace === "release license"
    && isExpectedNamespaceDirectory(namespaceEntry.member, expectedMembers)
  ) {
    if (namespaceEntry.stat) {
      return !namespaceEntry.stat.isDirectory() || namespaceEntry.stat.isSymbolicLink();
    }
    return namespaceEntry.entry?.isDirectory !== true || namespaceEntry.entry?.isSymbolicLink === true;
  }
  return true;
}

export function releaseNoticeRows(options = {}) {
  const selection = checkedSelection(options);
  const rows = [
    ...BASE_ROWS,
    ...selection.products.map((product) => PRODUCT_NOTICE_ROWS[product]),
    ...selection.components.map((component) => validateRuntimeLicenseSource(LICENSE_COMPONENT_ROWS[component])),
  ];
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

export function releaseNoticeInputPaths(options = { products: RELEASE_NOTICE_PRODUCTS, components: RELEASE_LICENSE_COMPONENTS }) {
  return Object.freeze(releaseNoticeRows(options).map((row) => row.source));
}

export function releaseLicenseComponents(ids) {
  return Object.freeze(checkedComponents(ids).map((id) => validateRuntimeLicenseSource(LICENSE_COMPONENT_ROWS[id])));
}

export function releasePackageLicense({ components = [], includeOliphaunt = true } = {}) {
  const entries = [];
  if (includeOliphaunt) {
    entries.push(Object.freeze({
      id: "oliphaunt",
      spdx: "MIT",
      name: "MIT License (Oliphaunt)",
      member: "LICENSE",
      source: path.join(ROOT, "LICENSE"),
      licenseUrl: "https://github.com/f0rr0/oliphaunt/blob/main/LICENSE",
    }));
  }
  entries.push(...releaseLicenseComponents(components));
  return Object.freeze({
    spdx: entries.map((entry) => entry.spdx).join(" AND "),
    entries: Object.freeze(entries),
  });
}

export function releaseProfilePackageLicense(profile, options = {}) {
  const selection = releaseCarrierProfile(profile);
  return releasePackageLicense({
    components: selection.components,
    includeOliphaunt: options.includeOliphaunt ?? true,
  });
}

export function releaseMavenLicenses({ product, version, components = [], includeOliphaunt = true } = {}) {
  if (typeof product !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(product)) {
    throw new Error("release Maven licenses require a canonical product id");
  }
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(version)) {
    throw new Error("release Maven licenses require a portable package version");
  }
  return Object.freeze(releasePackageLicense({ components, includeOliphaunt }).entries.map((entry) => Object.freeze({
    name: entry.name,
    url: entry.id === "oliphaunt"
      ? `https://github.com/f0rr0/oliphaunt/blob/${product}-v${version}/LICENSE`
      : entry.licenseUrl,
    distribution: "repo",
  })));
}

export function releaseProfileMavenLicenses(profile, { product, version, includeOliphaunt = true } = {}) {
  const selection = releaseCarrierProfile(profile);
  return releaseMavenLicenses({
    product,
    version,
    components: selection.components,
    includeOliphaunt,
  });
}

export function stageReleaseNotices(destination, options = {}) {
  const directory = requireSafeDirectoryChain(destination, "release notice destination");
  const rows = releaseNoticeRows(options);
  const expectedMembers = new Set(rows.map((row) => row.member));

  // A reused package stage must not retain any unselected or unrecognized
  // member in the canonical legal namespaces. Only regular files are safe to
  // remove automatically; links, special files, and unexpected directory
  // topology fail closed.
  for (const entry of directoryNoticeNamespaceEntries(directory)) {
    if (!unexpectedNamespaceEntry(entry, expectedMembers)) continue;
    if (!entry.stat.isFile() || entry.stat.isSymbolicLink()) {
      throw new Error(
        `stale ${entry.namespace} path is not a regular non-symlink file: ${entry.file}`,
      );
    }
    rmSync(entry.file);
  }

  for (const row of rows) {
    requireCanonicalSource(row);
    const destinationFile = path.join(directory, row.member);
    requireSafeParent(directory, destinationFile, { create: true });
    let prior;
    try {
      prior = lstatSync(destinationFile);
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        throw new Error(`release notice destination ${destinationFile} cannot be inspected: ${cause.message}`);
      }
    }
    if (prior && (!prior.isFile() || prior.isSymbolicLink())) {
      throw new Error(`release notice destination is not a regular file: ${destinationFile}`);
    }
    copyFileSync(row.source, destinationFile);
    chmodSync(destinationFile, 0o644);
  }
  assertReleaseNoticesInDirectory(directory, options);
  return rows.map((row) => path.join(directory, row.member));
}

export function hasCanonicalReleaseStagingMode(mode, platform = process.platform) {
  // Windows exposes synthetic Unix permission bits through stat(2). chmod can
  // toggle the read-only attribute, but it cannot establish a meaningful 0644
  // filesystem contract. Portable archives still carry and validate their
  // explicit modes in assertReleaseNoticesInEntries.
  return platform === "win32" || (mode & 0o777) === 0o644;
}

export function assertReleaseNoticesInDirectory(directory, options = {}) {
  const { exact = true } = options;
  const root = path.resolve(directory);
  requireRealDirectory(root, "release notice directory");
  const rows = releaseNoticeRows(options);
  const expected = new Set(rows.map((row) => row.member));
  for (const row of rows) {
    const file = path.join(root, row.member);
    requireSafeParent(root, file);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (cause) {
      throw new Error(`missing release notice ${file}: ${cause.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release notice must be a regular non-symlink file: ${file}`);
    }
    if (!hasCanonicalReleaseStagingMode(stat.mode)) {
      throw new Error(`release notice must have mode 0644: ${file}`);
    }
    const canonical = requireCanonicalSource(row);
    const actual = readFileSync(file);
    if (!actual.equals(canonical)) {
      throw new Error(`release notice differs byte-for-byte from ${row.source}: ${file}`);
    }
  }
  if (exact) {
    for (const entry of directoryNoticeNamespaceEntries(root)) {
      if (!unexpectedNamespaceEntry(entry, expected)) continue;
      throw new Error(
        `release notice directory contains unexpected ${entry.namespace} member ${entry.member}`,
      );
    }
  }
  return rows.map((row) => row.member);
}

export function assertReleaseNoticesInEntries(entries, options = {}) {
  const {
    prefix = "",
    exact = true,
    label = "archive",
  } = options;
  if (!(entries instanceof Map)) {
    throw new Error("release notice archive entries must be a Map");
  }
  const checkedArchivePrefix = checkedPrefix(prefix);
  const rows = releaseNoticeRows(options);
  const expected = new Set(rows.map((row) => row.member));
  for (const row of rows) {
    const member = prefixedMember(checkedArchivePrefix, row.member);
    const entry = entries.get(member);
    if (!entry?.isFile || entry.isSymbolicLink) {
      throw new Error(`${label} is missing regular release notice member ${member}`);
    }
    if ((entry.mode & 0o777) !== 0o644) {
      throw new Error(`${label} release notice member ${member} must have mode 0644`);
    }
    const canonical = requireCanonicalSource(row);
    const actual = Buffer.from(entry.data());
    if (!actual.equals(canonical)) {
      throw new Error(`${label} release notice member ${member} differs byte-for-byte from ${row.source}`);
    }
  }
  if (exact) {
    for (const entry of archiveNoticeNamespaceEntries(entries, checkedArchivePrefix)) {
      if (!unexpectedNamespaceEntry(entry, expected)) continue;
      throw new Error(`${label} contains unexpected ${entry.namespace} member ${entry.archiveMember}`);
    }
  }
  return rows.map((row) => prefixedMember(checkedArchivePrefix, row.member));
}

export function assertReleaseNoticesInArchive(file, options = {}) {
  const archive = path.resolve(file);
  return assertReleaseNoticesInEntries(readPortableArchiveEntries(archive), {
    ...options,
    label: options.label ?? path.basename(archive),
  });
}

function usage() {
  return [
    "usage:",
    "  tools/release/release-notices.mjs stage <directory> --profile <carrier-profile>",
    "  tools/release/release-notices.mjs check-directory <directory> --profile <carrier-profile>",
    "  tools/release/release-notices.mjs check-archive <archive> --profile <carrier-profile> [--prefix <member-prefix>]",
    "  advanced: replace --profile with explicit --product and --component flags",
  ].join("\n");
}

function parseCli(argv) {
  const values = [...argv];
  const command = values.shift();
  const target = values.shift();
  if (!command || !target || !["stage", "check-directory", "check-archive"].includes(command)) {
    throw new Error(usage());
  }
  const products = [];
  const components = [];
  let componentsSupplied = false;
  let prefix = "";
  let profile;
  while (values.length > 0) {
    const flag = values.shift();
    if (flag === "--profile") {
      if (profile !== undefined) throw new Error("--profile may be supplied only once");
      profile = values.shift();
      if (!profile) throw new Error("--profile requires a value");
      releaseCarrierProfile(profile);
    } else if (flag === "--product") {
      const product = values.shift();
      if (!product) throw new Error("--product requires a value");
      products.push(product);
    } else if (flag === "--component") {
      const component = values.shift();
      if (!component) throw new Error("--component requires a value");
      components.push(component);
      componentsSupplied = true;
    } else if (flag === "--prefix" && command === "check-archive") {
      const value = values.shift();
      if (value === undefined) throw new Error("--prefix requires a value");
      prefix = value;
    } else {
      throw new Error(`unsupported release notice argument ${JSON.stringify(flag)}\n${usage()}`);
    }
  }
  if (profile !== undefined && (products.length > 0 || componentsSupplied)) {
    throw new Error("--profile cannot be combined with --product or --component");
  }
  const checkedProductValues = checkedProducts(products);
  return {
    command,
    prefix,
    noticeOptions: profile === undefined
      ? { products: checkedProductValues, components: checkedComponents(componentsSupplied ? components : []) }
      : { profile },
    target,
  };
}

function main() {
  let args;
  try {
    args = parseCli(process.argv.slice(2));
    if (args.command === "stage") {
      stageReleaseNotices(args.target, args.noticeOptions);
    } else if (args.command === "check-directory") {
      assertReleaseNoticesInDirectory(args.target, args.noticeOptions);
    } else {
      assertReleaseNoticesInArchive(args.target, {
        prefix: args.prefix,
        ...args.noticeOptions,
      });
    }
  } catch (error) {
    console.error(`${PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${PREFIX}: ${args.command} passed for ${args.target}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main();
}
