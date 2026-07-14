#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  PUBLICATION_CATALOG_SCHEMA,
  loadPublicationCatalog,
  publicationCatalogDigest,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import {
  allArtifactTargets,
  extensionArtifactTargets,
  extensionSqlName,
} from "./release-artifact-targets.mjs";
import { ROOT, compareText } from "./release-graph.mjs";
import { validateNpmTrustedPublishingManifest } from "./npm-trusted-publishing.mjs";

export const PUBLICATION_CANDIDATE_SCHEMA = "oliphaunt-publication-candidate-v1";
export const PUBLICATION_LOCK_SCHEMA = "oliphaunt-publication-lock-v1";
export const DEFAULT_PUBLICATION_LOCK = path.join(ROOT, "target/release/publication-lock.json");

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const ECOSYSTEM_ORDER = new Map([["cargo", 0], ["maven", 1], ["npm", 2], ["jsr", 3]]);
const ROLE_ORDER = new Map([
  ["payload-part", 0],
  ["resource", 1],
  ["platform-leaf", 2],
  ["aot-leaf", 2],
  ["portable-leaf", 2],
  ["tool-leaf", 2],
  ["plugin", 3],
  ["tool-facade", 4],
  ["facade", 5],
]);

function error(message) {
  return new Error(`publication-lock: ${message}`);
}

function requireObject(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestValue(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? path.resolve(file).split(path.sep).join("/")
    : relative.split(path.sep).join("/");
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

function walkFiles(root, { ignoreBuildDirectories = false } = {}) {
  if (isFile(root)) {
    return [root];
  }
  if (!isDirectory(root)) {
    throw error(`artifact root does not exist or is not a file/directory: ${rel(root)}`);
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw error(`artifact roots must not contain symlinks: ${rel(fullPath)}`);
      }
      if (entry.isDirectory()) {
        if (ignoreBuildDirectories && IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function commandOutput(args, context) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`${context} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function archiveMemberText(file, suffix) {
  const listing = commandOutput(["tar", "-tzf", file], `list ${rel(file)}`)
    .split(/\r?\n/u)
    .filter(Boolean);
  const members = listing.filter((name) => name.endsWith(suffix));
  if (members.length !== 1) {
    throw error(`${rel(file)} must contain exactly one ${suffix}, found ${members.length}`);
  }
  return commandOutput(["tar", "-xOzf", file, members[0]], `read ${suffix} from ${rel(file)}`);
}

function dependencyRows(ecosystem, tables) {
  const rows = [];
  for (const [scope, table] of tables) {
    if (table === null || Array.isArray(table) || typeof table !== "object") {
      continue;
    }
    for (const [name, raw] of Object.entries(table)) {
      const requirement = typeof raw === "string"
        ? raw
        : raw !== null && !Array.isArray(raw) && typeof raw === "object"
          ? String(raw.version ?? "*")
          : "*";
      rows.push({ ecosystem, name, requirement, scope });
    }
  }
  return rows.sort((left, right) => compareText(`${left.ecosystem}:${left.name}:${left.scope}`, `${right.ecosystem}:${right.name}:${right.scope}`));
}

function npmArtifact(file) {
  let manifest;
  try {
    manifest = JSON.parse(archiveMemberText(file, "/package.json"));
  } catch (cause) {
    throw error(`invalid npm tarball ${rel(file)}: ${cause.message}`);
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw error(`${rel(file)} npm package manifest must define name and version`);
  }
  try {
    validateNpmTrustedPublishingManifest(manifest, `${rel(file)} package/package.json`);
  } catch (cause) {
    throw error(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    ecosystem: "npm",
    name: manifest.name,
    version: manifest.version,
    dependencies: dependencyRows("npm", [
      ["runtime", manifest.dependencies],
      ["optional", manifest.optionalDependencies],
      ["peer", manifest.peerDependencies],
    ]),
    artifacts: [{ path: rel(file), sha256: sha256File(file), size: statSync(file).size }],
  };
}

function cargoDependencyTables(manifest) {
  const tables = [["runtime", manifest.dependencies], ["build", manifest["build-dependencies"]], ["development", manifest["dev-dependencies"]]];
  for (const target of Object.values(manifest.target ?? {})) {
    if (target !== null && !Array.isArray(target) && typeof target === "object") {
      tables.push(["runtime", target.dependencies], ["build", target["build-dependencies"]]);
    }
  }
  return tables;
}

function cargoArtifact(file) {
  let manifest;
  try {
    manifest = Bun.TOML.parse(archiveMemberText(file, "/Cargo.toml"));
  } catch (cause) {
    throw error(`invalid Cargo crate ${rel(file)}: ${cause.message}`);
  }
  if (typeof manifest.package?.name !== "string" || typeof manifest.package?.version !== "string") {
    throw error(`${rel(file)} Cargo package manifest must define package.name and package.version`);
  }
  return {
    ecosystem: "cargo",
    name: manifest.package.name,
    version: manifest.package.version,
    dependencies: dependencyRows("cargo", cargoDependencyTables(manifest)),
    artifacts: [{ path: rel(file), sha256: sha256File(file), size: statSync(file).size }],
  };
}

function xmlText(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "u"));
  return match?.[1]?.trim() ?? null;
}

function mavenArtifact(file) {
  const text = readFileSync(file, "utf8");
  const group = xmlText(text, "groupId");
  const name = xmlText(text, "artifactId");
  const version = xmlText(text, "version");
  if ([group, name, version].some((value) => value === null)) {
    throw error(`${rel(file)} Maven POM must define groupId, artifactId, and version`);
  }
  const dependencies = [];
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gu)) {
    const dependencyGroup = xmlText(match[1], "groupId");
    const dependencyName = xmlText(match[1], "artifactId");
    if (dependencyGroup === null || dependencyName === null) {
      continue;
    }
    dependencies.push({
      ecosystem: "maven",
      name: `${dependencyGroup}:${dependencyName}`,
      requirement: xmlText(match[1], "version") ?? "*",
      scope: xmlText(match[1], "scope") ?? "runtime",
    });
  }
  const prefix = path.basename(file, ".pom");
  const artifacts = readdirSync(path.dirname(file))
    .filter((entry) => entry === `${prefix}.pom` || entry.startsWith(`${prefix}.` ) || entry.startsWith(`${prefix}-`))
    .map((entry) => path.join(path.dirname(file), entry))
    .filter(isFile)
    .sort(compareText)
    .map((artifact) => ({ path: rel(artifact), sha256: sha256File(artifact), size: statSync(artifact).size }));
  return {
    ecosystem: "maven",
    name: `${group}:${name}`,
    version,
    dependencies: dependencies.sort((left, right) => compareText(left.name, right.name)),
    artifacts,
  };
}

function mavenManifestArtifacts(file) {
  if (!rel(file).includes("/maven-artifacts/")) {
    return [];
  }
  const records = [];
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).entries()) {
    const values = line.split("\t");
    if (values.length !== 6) {
      throw error(`${rel(file)} line ${index + 1} must contain six Maven publication fields`);
    }
    const [group, name, version, artifactPath] = values;
    const artifact = path.resolve(ROOT, artifactPath);
    if (!isFile(artifact)) {
      throw error(`${rel(file)} line ${index + 1} references missing Maven artifact ${artifactPath}`);
    }
    records.push({
      ecosystem: "maven",
      name: `${group}:${name}`,
      version,
      dependencies: [],
      artifacts: [{ path: rel(artifact), sha256: sha256File(artifact), size: statSync(artifact).size }],
    });
  }
  return records;
}

function directoryEnvelope(directory) {
  const files = walkFiles(directory, { ignoreBuildDirectories: true });
  const hash = createHash("sha256");
  let size = 0;
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
    size += bytes.length;
  }
  return { path: rel(directory), sha256: hash.digest("hex"), size };
}

function jsrArtifact(file) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || !manifest.name.startsWith("@")) {
    return null;
  }
  const imports = manifest.imports;
  const dependencies = imports !== null && !Array.isArray(imports) && typeof imports === "object"
    ? Object.entries(imports).map(([name, requirement]) => ({
      ecosystem: String(requirement).startsWith("jsr:") ? "jsr" : "npm",
      name,
      requirement: String(requirement),
      scope: "runtime",
    }))
    : [];
  return {
    ecosystem: "jsr",
    name: manifest.name,
    version: manifest.version,
    dependencies,
    artifacts: [directoryEnvelope(path.dirname(file))],
  };
}

function mergeArtifactRecord(records, record) {
  const id = `${record.ecosystem}:${record.name}@${record.version}`;
  const existing = records.get(id);
  if (existing === undefined) {
    records.set(id, record);
    return;
  }
  if (stableJson(existing.dependencies) !== stableJson(record.dependencies)) {
    throw error(`duplicate artifact identity ${id} has conflicting dependency metadata`);
  }
  const byHash = new Map(existing.artifacts.map((artifact) => [artifact.sha256, artifact]));
  for (const artifact of record.artifacts) {
    const previous = byHash.get(artifact.sha256);
    if (previous !== undefined && previous.size !== artifact.size) {
      throw error(`duplicate artifact hash ${artifact.sha256} has conflicting sizes`);
    }
    byHash.set(artifact.sha256, artifact);
  }
  existing.artifacts = [...byHash.values()].sort((left, right) => compareText(left.path, right.path));
}

export function discoverPublicationArtifacts(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw error("at least one artifact root is required");
  }
  const files = [...new Set(roots.flatMap((root) => walkFiles(path.resolve(ROOT, root))))].sort(compareText);
  const records = new Map();
  const mavenPoms = new Set();
  for (const file of files) {
    if (file.endsWith(".tgz")) {
      mergeArtifactRecord(records, npmArtifact(file));
    } else if (file.endsWith(".crate")) {
      mergeArtifactRecord(records, cargoArtifact(file));
    } else if (file.endsWith(".pom") && !file.endsWith("-sources.pom") && !file.endsWith("-javadoc.pom")) {
      const record = mavenArtifact(file);
      const key = `${record.name}@${record.version}`;
      if (!mavenPoms.has(key)) {
        mavenPoms.add(key);
        mergeArtifactRecord(records, record);
      }
    } else if (file.endsWith(".tsv")) {
      for (const record of mavenManifestArtifacts(file)) {
        mergeArtifactRecord(records, record);
      }
    } else if (path.basename(file) === "jsr.json" || path.basename(file) === "jsr.jsonc") {
      if (file.endsWith(".jsonc")) {
        throw error(`${rel(file)} must be strict JSON for a reproducible JSR publication lock`);
      }
      const record = jsrArtifact(file);
      if (record !== null) {
        mergeArtifactRecord(records, record);
      }
    }
  }
  return [...records.values()].sort((left, right) => compareText(`${left.ecosystem}:${left.name}`, `${right.ecosystem}:${right.name}`));
}

function productArtifact({ product, id, role, kind, target = null, identity = null, name, file }) {
  return {
    id,
    product,
    role,
    kind,
    target,
    identity,
    name,
    path: rel(file),
    sha256: sha256File(file),
    size: statSync(file).size,
  };
}

function productDirectoryArtifact({ product, id, role, kind, target = null, identity = null, name, directory }) {
  const envelope = directoryEnvelope(directory);
  return {
    id,
    product,
    role,
    kind,
    target,
    identity,
    name,
    path: envelope.path,
    sha256: envelope.sha256,
    size: envelope.size,
  };
}

function exactDirectFileSet(directory, expectedNames, context) {
  if (!isDirectory(directory)) {
    throw error(`${context} release asset directory does not exist: ${rel(directory)}`);
  }
  const actual = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareText);
  const expected = [...expectedNames].sort(compareText);
  if (stableJson(actual) !== stableJson(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((name) => !actualSet.has(name));
    const extra = actual.filter((name) => !expectedSet.has(name));
    throw error(`${context} public release asset set mismatch: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
  }
}

function validateChecksumManifest(file, payloadFiles, context) {
  const declared = new Map();
  for (const [index, rawLine] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
    if (rawLine.length === 0) {
      continue;
    }
    const match = rawLine.match(/^([0-9a-f]{64})  \.\/([^/\0]+)$/u);
    if (match === null) {
      throw error(`${context} checksum line ${index + 1} must be '<sha256>  ./<basename>'`);
    }
    const [, digest, name] = match;
    if (declared.has(name)) {
      throw error(`${context} checksum manifest declares ${name} more than once`);
    }
    declared.set(name, digest);
  }
  const expected = new Map(payloadFiles.map((payload) => [path.basename(payload), sha256File(payload)]));
  const declaredNames = [...declared.keys()].sort(compareText);
  const expectedNames = [...expected.keys()].sort(compareText);
  if (stableJson(declaredNames) !== stableJson(expectedNames)) {
    throw error(`${context} checksum entries do not exactly cover public payloads: expected=${JSON.stringify(expectedNames)}, actual=${JSON.stringify(declaredNames)}`);
  }
  for (const [name, digest] of expected) {
    if (declared.get(name) !== digest) {
      throw error(`${context} checksum for ${name} does not match its frozen bytes`);
    }
  }
}

function fixedGithubReleaseArtifacts(files, product) {
  const targets = allArtifactTargets({
    product: product.id,
    surface: "github-release",
    publishedOnly: true,
  }, "publication-lock");
  if (targets.length === 0) {
    return [];
  }
  const expected = targets.map((target) => ({
    target,
    name: target.asset.replaceAll("{version}", product.version),
  }));
  const matches = new Map();
  for (const row of expected) {
    const found = files.filter((file) => path.basename(file) === row.name);
    if (found.length !== 1) {
      throw error(`${product.id} requires exactly one public GitHub asset ${row.name}, found ${found.length}`);
    }
    matches.set(row.name, found[0]);
  }
  const directories = new Set([...matches.values()].map((file) => path.dirname(file)));
  if (directories.size !== 1) {
    throw error(`${product.id} public GitHub assets must share one release-assets directory`);
  }
  const directory = [...directories][0];
  if (path.basename(directory) !== "release-assets") {
    throw error(`${product.id} public GitHub assets must be staged directly in a release-assets directory, got ${rel(directory)}`);
  }
  exactDirectFileSet(directory, expected.map((row) => row.name), product.id);
  const checksumRows = expected.filter((row) => row.target.kind === "checksums");
  if (checksumRows.length !== 1) {
    throw error(`${product.id} must declare exactly one canonical GitHub checksum asset, found ${checksumRows.length}`);
  }
  const checksum = matches.get(checksumRows[0].name);
  validateChecksumManifest(
    checksum,
    expected.filter((row) => row.name !== checksumRows[0].name).map((row) => matches.get(row.name)),
    `${product.id}/${checksumRows[0].name}`,
  );
  return expected.map(({ target, name }) => productArtifact({
    product: product.id,
    id: `github-release:${name}`,
    role: "github-release-asset",
    kind: target.kind,
    target: target.target,
    name,
    file: matches.get(name),
  }));
}

function extensionAssetKindAllowed(family, target, kind) {
  if (family === "wasix") {
    return target === "wasix-portable" && kind === "wasix-runtime";
  }
  if (family !== "native") {
    return false;
  }
  if (target === "ios-xcframework") {
    return kind === "runtime" || kind === "ios-xcframework" || kind === "ios-dependency-xcframework";
  }
  if (target.startsWith("android-")) {
    return kind === "runtime";
  }
  return kind === "runtime";
}

function parseTsv(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("#"));
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""]));
  });
}

function exactExtensionIosContract(product) {
  const sqlName = extensionSqlName(product, "publication-lock");
  const generated = JSON.parse(readFileSync(path.join(ROOT, "src/extensions/generated/sdk/react-native.json"), "utf8"));
  const row = generated.extensions?.find((item) => item?.["sql-name"] === sqlName);
  if (row === undefined) {
    throw error(`${product} is absent from generated React Native extension metadata`);
  }
  const nativeModuleStem = typeof row["native-module-stem"] === "string" && row["native-module-stem"].length > 0
    ? row["native-module-stem"]
    : null;
  if (nativeModuleStem === null) {
    return { sqlName, nativeModuleStem, dependencies: [], metadata: row };
  }
  const staticRows = parseTsv(path.join(ROOT, "src/extensions/generated/mobile/static-extensions.tsv"));
  const staticRow = staticRows.find((item) => item["sql-name"] === sqlName);
  if (staticRow === undefined || staticRow["native-module-stem"] !== nativeModuleStem) {
    throw error(`${product} native module ${nativeModuleStem} is absent from generated mobile static metadata`);
  }
  const dependencies = (staticRow["ios-static-dependencies"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort(compareText);
  if (new Set(dependencies).size !== dependencies.length) {
    throw error(`${product} generated iOS dependency closure contains duplicates`);
  }
  return { sqlName, nativeModuleStem, dependencies, metadata: row };
}

function extensionRequiredAssetKeys(product) {
  const ios = exactExtensionIosContract(product);
  const keys = [];
  for (const target of extensionArtifactTargets({ product, publishedOnly: true }, "publication-lock")) {
    if (target.family === "wasix") {
      keys.push(`${target.family}:${target.target}:wasix-runtime`);
    } else if (target.target === "ios-xcframework") {
      keys.push(`${target.family}:${target.target}:runtime`);
      if (ios.nativeModuleStem !== null) {
        keys.push(`${target.family}:${target.target}:ios-xcframework:${ios.nativeModuleStem}`);
        for (const dependency of ios.dependencies) {
          keys.push(`${target.family}:${target.target}:ios-dependency-xcframework:${dependency}`);
        }
      }
    } else if (target.target.startsWith("android-")) {
      keys.push(`${target.family}:${target.target}:runtime`);
    } else {
      keys.push(`${target.family}:${target.target}:runtime`);
    }
  }
  return keys.sort(compareText);
}

function canonicalExtensionAssetName(product, row) {
  if (row.family === "wasix") {
    return `${product.id}-${product.version}-wasix-portable.tar.zst`;
  }
  if (row.kind === "ios-xcframework") {
    return `${product.id}-${product.version}-native-ios-xcframework.zip`;
  }
  if (row.kind === "ios-dependency-xcframework") {
    return `${product.id}-${product.version}-native-ios-dependency-${row.identity}-xcframework.zip`;
  }
  if (row.target === "ios-xcframework") {
    return `${product.id}-${product.version}-native-ios-runtime.tar.gz`;
  }
  return `${product.id}-${product.version}-native-${row.target}-runtime.tar.gz`;
}

function extensionGithubReleaseArtifacts(files, product) {
  const candidates = files.filter((file) => path.basename(file) === "extension-artifacts.json");
  const manifests = [];
  for (const file of candidates) {
    let value;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (cause) {
      throw error(`invalid extension artifact manifest ${rel(file)}: ${cause.message}`);
    }
    if (value?.product === product.id) {
      manifests.push([file, value]);
    }
  }
  if (manifests.length !== 1) {
    throw error(`${product.id} requires exactly one extension-artifacts.json in the staged roots, found ${manifests.length}`);
  }
  const [manifestPath, manifest] = manifests[0];
  if (manifest.schema !== "oliphaunt-extension-ci-artifacts-v1" || manifest.version !== product.version || !Array.isArray(manifest.assets)) {
    throw error(`${rel(manifestPath)} does not describe ${product.id}@${product.version} extension CI artifacts`);
  }
  const iosContract = exactExtensionIosContract(product.id);
  const sortedStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    ? [...value].sort(compareText)
    : null;
  if (
    manifest.sqlName !== iosContract.sqlName
    || manifest.nativeModuleStem !== iosContract.nativeModuleStem
    || manifest.createsExtension !== (iosContract.metadata["creates-extension"] !== false)
    || stableJson(sortedStrings(manifest.dependencies)) !== stableJson([...(iosContract.metadata["selected-extension-dependencies"] ?? [])].sort(compareText))
    || stableJson(sortedStrings(manifest.nativeDependencies)) !== stableJson([...(iosContract.metadata["native-dependencies"] ?? [])].sort(compareText))
    || stableJson(sortedStrings(manifest.sharedPreloadLibraries)) !== stableJson([...(iosContract.metadata["shared-preload-libraries"] ?? [])].sort(compareText))
    || stableJson(sortedStrings(manifest.iosNativeDependencies)) !== stableJson(iosContract.dependencies)
  ) {
    throw error(`${rel(manifestPath)} semantic extension metadata is not canonical generated metadata`);
  }
  if (iosContract.nativeModuleStem === null) {
    if (manifest.iosRegistration !== null) {
      throw error(`${rel(manifestPath)} SQL-only extension must not carry iOS registration`);
    }
  } else if (
    manifest.iosRegistration === null
    || Array.isArray(manifest.iosRegistration)
    || typeof manifest.iosRegistration !== "object"
    || manifest.iosRegistration.schema !== "oliphaunt-ios-extension-registration-v1"
    || manifest.iosRegistration.sqlName !== iosContract.sqlName
    || manifest.iosRegistration.nativeModuleStem !== iosContract.nativeModuleStem
  ) {
    throw error(`${rel(manifestPath)} native extension lacks matching build-derived iOS registration`);
  }
  const directory = path.join(path.dirname(manifestPath), "release-assets");
  const rows = new Map();
  for (const row of manifest.assets) {
    if (
      row === null
      || Array.isArray(row)
      || typeof row !== "object"
      || ![row.family, row.target, row.kind, row.name, row.path, row.sha256].every((value) => typeof value === "string" && value.length > 0)
      || !(row.identity === null || typeof row.identity === "string" && row.identity.length > 0)
      || !Number.isSafeInteger(row.bytes)
      || row.bytes <= 0
      || !/^[0-9a-f]{64}$/u.test(row.sha256)
      || path.basename(row.name) !== row.name
    ) {
      throw error(`${rel(manifestPath)} contains an invalid public extension asset row`);
    }
    if (row.kind === "ios-dependency-xcframework" && row.identity === null) {
      throw error(`${rel(manifestPath)} iOS dependency XCFramework ${row.name} lacks identity`);
    }
    if (row.kind === "ios-xcframework" && row.identity !== iosContract.nativeModuleStem) {
      throw error(`${rel(manifestPath)} primary iOS XCFramework identity must be ${iosContract.nativeModuleStem}`);
    }
    if (row.kind !== "ios-dependency-xcframework" && row.kind !== "ios-xcframework" && row.identity !== null) {
      throw error(`${rel(manifestPath)} asset ${row.name} must not carry identity for ${row.kind}`);
    }
    const key = `${row.family}:${row.target}:${row.kind}${row.identity === null ? "" : `:${row.identity}`}`;
    if (rows.has(key)) {
      throw error(`${rel(manifestPath)} contains duplicate extension asset role ${key}`);
    }
    if (!extensionAssetKindAllowed(row.family, row.target, row.kind)) {
      throw error(`${rel(manifestPath)} contains invalid extension asset role ${key}`);
    }
    const canonicalName = canonicalExtensionAssetName(product, row);
    if (row.name !== canonicalName) {
      throw error(`${rel(manifestPath)} asset ${row.name} is not the canonical name ${canonicalName}`);
    }
    const file = path.resolve(ROOT, row.path);
    if (file !== path.join(directory, row.name) || !isFile(file)) {
      throw error(`${rel(manifestPath)} asset ${row.name} must exist directly under ${rel(directory)}`);
    }
    if (statSync(file).size !== row.bytes || sha256File(file) !== row.sha256) {
      throw error(`${rel(manifestPath)} asset metadata does not match ${rel(file)}`);
    }
    rows.set(key, { row, file });
  }
  const expectedKeys = extensionRequiredAssetKeys(product.id);
  const actualKeys = [...rows.keys()].sort(compareText);
  if (stableJson(expectedKeys) !== stableJson(actualKeys)) {
    throw error(`${product.id} extension asset roles do not exactly cover declared published targets: expected=${JSON.stringify(expectedKeys)}, actual=${JSON.stringify(actualKeys)}`);
  }
  const metadata = [
    ["manifest-json", `${product.id}-${product.version}-manifest.json`],
    ["manifest-properties", `${product.id}-${product.version}-manifest.properties`],
    ["checksums", `${product.id}-${product.version}-release-assets.sha256`],
  ];
  const expectedNames = [
    ...[...rows.values()].map(({ row }) => row.name),
    ...metadata.map(([, name]) => name),
  ];
  if (new Set(expectedNames).size !== expectedNames.length) {
    throw error(`${product.id} extension release assets contain duplicate public basenames`);
  }
  exactDirectFileSet(directory, expectedNames, product.id);
  const checksumName = metadata.find(([kind]) => kind === "checksums")[1];
  const checksum = path.join(directory, checksumName);
  validateChecksumManifest(
    checksum,
    expectedNames.filter((name) => name !== checksumName).map((name) => path.join(directory, name)),
    `${product.id}/${checksumName}`,
  );
  return [
    ...[...rows.values()].map(({ row, file }) => productArtifact({
      product: product.id,
      id: `github-release:${row.name}`,
      role: "github-release-asset",
      kind: row.kind,
      target: row.target,
      identity: row.identity,
      name: row.name,
      file,
    })),
    ...metadata.map(([kind, name]) => productArtifact({
      product: product.id,
      id: `github-release:${name}`,
      role: "github-release-metadata",
      kind,
      target: "portable",
      name,
      file: path.join(directory, name),
    })),
  ];
}

function swiftReleaseInputs(files, product) {
  const expectedFiles = [
    ["Oliphaunt-source.zip", "swiftpm-source-archive"],
    ["Package.swift.release", "swiftpm-release-manifest"],
    ["render-extension-products.mjs", "swiftpm-extension-generator"],
    ["swift-carrier-resolver.mjs", "swiftpm-carrier-resolver"],
    ["swiftpm-extension-input.schema.json", "swiftpm-extension-input-schema"],
  ];
  const artifacts = expectedFiles.map(([name, kind]) => {
    const matches = files.filter((file) => path.basename(file) === name && (
      !name.startsWith("swift") && name !== "render-extension-products.mjs"
        ? true
        : rel(file).includes("/extension-generator/")
    ));
    if (matches.length !== 1) {
      throw error(`${product.id} requires exactly one ${name} in the staged artifact roots, found ${matches.length}`);
    }
    return productArtifact({
      product: product.id,
      id: `release-input:${name}`,
      role: "release-input",
      kind,
      target: "portable",
      name,
      file: matches[0],
    });
  });
  const carrierName = "oliphaunt-react-native-ios-carriers.json";
  const carrierMatches = files.filter((file) =>
    path.basename(file) === carrierName
    && rel(file).includes("/release-tree/src/sdks/swift/Carriers/"));
  if (carrierMatches.length !== 1) {
    throw error(`${product.id} requires exactly one source-tag carrier ${carrierName}, found ${carrierMatches.length}`);
  }
  const carrierFile = carrierMatches[0];
  artifacts.push(productArtifact({
    product: product.id,
    id: `release-input:${carrierName}`,
    role: "release-input",
    kind: "swiftpm-ios-carrier-manifest",
    target: "portable",
    name: carrierName,
    file: carrierFile,
  }));
  const releaseTree = path.join(path.dirname(carrierFile), "../../../..");
  artifacts.push(productDirectoryArtifact({
    product: product.id,
    id: "release-input:swiftpm-release-tree",
    role: "release-input",
    kind: "swiftpm-release-tree",
    target: "portable",
    name: "release-tree",
    directory: path.resolve(releaseTree),
  }));
  let carrier;
  try {
    carrier = JSON.parse(readFileSync(carrierFile, "utf8"));
  } catch (cause) {
    throw error(`${rel(carrierFile)} is not valid JSON: ${cause.message}`);
  }
  if (carrier?.schema !== "oliphaunt-react-native-ios-carrier-v1" || !Array.isArray(carrier.extensions)) {
    throw error(`${rel(carrierFile)} is not a canonical iOS carrier manifest`);
  }
  const fixtureManifests = files.filter((file) =>
    path.basename(file) === "extension-products.json"
    && (rel(file).startsWith("target/release/swiftpm-extension-consumer-fixture/")
      || rel(file).includes("/release/swiftpm-extension-consumer-fixture/")));
  if (carrier.extensions.length > 0) {
    if (fixtureManifests.length !== 1) {
      throw error(`${product.id} carrier selects extensions but requires exactly one frozen Swift consumer fixture, found ${fixtureManifests.length}`);
    }
    const fixture = path.dirname(fixtureManifests[0]);
    if (!isFile(path.join(fixture, "Package.swift"))) {
      throw error(`${rel(fixture)} is missing generated Package.swift`);
    }
    artifacts.push(productDirectoryArtifact({
      product: product.id,
      id: "release-input:swiftpm-extension-consumer-fixture",
      role: "release-input",
      kind: "swiftpm-extension-consumer-fixture",
      target: "portable",
      name: "swiftpm-extension-consumer-fixture",
      directory: fixture,
    }));
  } else if (fixtureManifests.length > 0) {
    throw error(`${product.id} has a generated Swift consumer fixture but its carrier selects no extensions`);
  }
  return artifacts;
}

function reactNativeReleaseInputs(files, product) {
  const name = "oliphaunt-react-native-ios-carriers.json";
  const matches = files.filter((file) =>
    path.basename(file) === name
    && (rel(file).startsWith("target/release/ios-carriers/")
      || rel(file).includes("/release/ios-carriers/")));
  if (matches.length !== 1) {
    throw error(`${product.id} requires exactly one canonical aggregate iOS carrier manifest, found ${matches.length}`);
  }
  return [productArtifact({
    product: product.id,
    id: `release-input:${name}`,
    role: "release-input",
    kind: "react-native-ios-carrier-manifest",
    target: "portable",
    name,
    file: matches[0],
  })];
}

export function discoverProductArtifacts(roots, products) {
  const files = [...new Set(roots.flatMap((root) => walkFiles(path.resolve(ROOT, root))))].sort(compareText);
  const artifacts = [];
  for (const product of products) {
    if (typeof product?.id !== "string" || typeof product?.version !== "string") {
      throw error("product artifact discovery requires canonical product rows with id and version");
    }
    if (product.kind === "exact-extension-artifact") {
      artifacts.push(...extensionGithubReleaseArtifacts(files, product));
    } else {
      artifacts.push(...fixedGithubReleaseArtifacts(files, product));
    }
    if (product.id === "oliphaunt-swift") {
      artifacts.push(...swiftReleaseInputs(files, product));
    } else if (product.id === "oliphaunt-react-native") {
      artifacts.push(...reactNativeReleaseInputs(files, product));
    }
  }
  const ids = artifacts.map((artifact) => `${artifact.product}:${artifact.id}`);
  if (new Set(ids).size !== ids.length) {
    throw error("product artifact discovery produced duplicate identities");
  }
  return artifacts.sort((left, right) => compareText(`${left.product}:${left.id}`, `${right.product}:${right.id}`));
}

function sourceIdentity(headRef) {
  const commit = commandOutput(["git", "rev-parse", `${headRef}^{commit}`], `resolve ${headRef}`).trim();
  const tree = commandOutput(["git", "show", "-s", "--format=%T", commit], `resolve tree for ${commit}`).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw error(`git returned invalid source identity for ${headRef}`);
  }
  return { commit, tree };
}

function internalDependencyIds(carriers, dependencies) {
  const ids = new Set(carriers.map((carrier) => carrier.id));
  return dependencies
    .map((dependency) => `${dependency.ecosystem}:${dependency.name}`)
    .filter((id) => ids.has(id))
    .sort(compareText);
}

function assignPublishOrder(carriers, products) {
  const productOrder = new Map(products.map((product, index) => [product.id, index]));
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const remaining = new Set(byId.keys());
  const ordered = [];
  const fallbackCompare = (leftId, rightId) => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    return (productOrder.get(left.product) ?? 9999) - (productOrder.get(right.product) ?? 9999)
      || (ECOSYSTEM_ORDER.get(left.ecosystem) ?? 99) - (ECOSYSTEM_ORDER.get(right.ecosystem) ?? 99)
      || (ROLE_ORDER.get(left.role) ?? 99) - (ROLE_ORDER.get(right.role) ?? 99)
      || compareText(left.id, right.id);
  };
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => byId.get(id).dependencies.every((dependency) => !remaining.has(dependency)))
      .sort(fallbackCompare);
    if (ready.length === 0) {
      throw error(`carrier dependency cycle: ${[...remaining].sort(compareText).join(", ")}`);
    }
    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
    }
  }
  for (const [index, id] of ordered.entries()) {
    byId.get(id).publishOrder = index;
  }
  return carriers.sort((left, right) => left.publishOrder - right.publishOrder);
}

function carrierEnvelope(carrier) {
  return {
    id: carrier.id,
    product: carrier.product,
    version: carrier.version,
    ecosystem: carrier.ecosystem,
    name: carrier.name,
    role: carrier.role,
    target: carrier.target,
    declared: carrier.declared,
    parentCarrier: carrier.parentCarrier ?? null,
    part: carrier.part ?? null,
    publishOrder: carrier.publishOrder,
    dependencies: carrier.dependencies,
    packageDependencies: carrier.packageDependencies,
    artifacts: carrier.artifacts.map(({ path: artifactPath, sha256, size }) => ({
      path: artifactPath,
      sha256,
      size,
    })),
  };
}

function productArtifactEnvelope(artifact) {
  return {
    id: artifact.id,
    product: artifact.product,
    role: artifact.role,
    kind: artifact.kind,
    target: artifact.target,
    identity: artifact.identity,
    name: artifact.name,
    path: artifact.path,
    sha256: artifact.sha256,
    size: artifact.size,
  };
}

export function buildPublicationCandidate({
  products,
  artifactRoots,
  headRef = "HEAD",
  allowMissing = false,
} = {}) {
  const catalog = loadPublicationCatalog("publication-lock", { products });
  const artifacts = discoverPublicationArtifacts(artifactRoots);
  const productArtifacts = discoverProductArtifacts(artifactRoots, catalog.products);
  const carriers = [];
  const seenStableIds = new Set();
  for (const artifact of artifacts) {
    const resolved = resolveActualCarrier(catalog, artifact.ecosystem, artifact.name, "publication-lock");
    if (artifact.version !== resolved.version) {
      throw error(`${artifact.ecosystem}:${artifact.name} artifact version ${artifact.version} does not match ${resolved.product} version ${resolved.version}`);
    }
    if (resolved.declared) {
      seenStableIds.add(resolved.id);
    }
    carriers.push({
      ...resolved,
      dependencies: [],
      packageDependencies: artifact.dependencies,
      artifacts: artifact.artifacts,
    });
  }
  const missing = catalog.carriers
    .filter((carrier) => !seenStableIds.has(carrier.id))
    .map((carrier) => carrier.id)
    .sort(compareText);
  if (!allowMissing && missing.length > 0) {
    throw error(`artifact set is missing ${missing.length} declared carrier(s): ${missing.join(", ")}`);
  }
  for (const carrier of carriers) {
    carrier.dependencies = internalDependencyIds(carriers, carrier.packageDependencies);
  }
  assignPublishOrder(carriers, catalog.products);
  const packageEnvelopeDigest = digestValue({
    carriers: carriers.map(carrierEnvelope),
    productArtifacts: productArtifacts.map(productArtifactEnvelope),
  });
  return {
    schema: PUBLICATION_CANDIDATE_SCHEMA,
    catalogSchema: PUBLICATION_CATALOG_SCHEMA,
    catalogDigest: publicationCatalogDigest(catalog),
    source: sourceIdentity(headRef),
    products: catalog.products,
    carriers,
    productArtifacts,
    missing,
    packageEnvelopeDigest,
  };
}

function withoutDigest(value) {
  const copy = structuredClone(value);
  delete copy.lockDigest;
  return copy;
}

export function freezePublicationCandidate(candidate) {
  validatePublicationCandidate(candidate);
  if (candidate.missing.length > 0) {
    throw error(`cannot freeze candidate with missing carriers: ${candidate.missing.join(", ")}`);
  }
  const frozen = {
    ...structuredClone(candidate),
    schema: PUBLICATION_LOCK_SCHEMA,
  };
  delete frozen.missing;
  frozen.lockDigest = digestValue(withoutDigest(frozen));
  return frozen;
}

function assertHash(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw error(`${context} must be a lowercase SHA-256 digest`);
  }
}

function assertNonEmptyString(value, context) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw error(`${context} must be a non-empty single-line string`);
  }
}

function assertSortedUniqueStrings(value, context) {
  if (!Array.isArray(value)) {
    throw error(`${context} must be a list`);
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${context}[${index}]`);
  }
  const canonical = [...new Set(value)].sort(compareText);
  if (stableJson(value) !== stableJson(canonical)) {
    throw error(`${context} must be sorted and contain no duplicates`);
  }
}

function validateCandidateCatalog(candidate) {
  const requestedProducts = candidate.products.map((product) => product.id);
  const catalog = loadPublicationCatalog("publication-lock validation", { products: requestedProducts });
  const expectedDigest = publicationCatalogDigest(catalog);
  if (candidate.catalogDigest !== expectedDigest) {
    throw error(`candidate catalogDigest mismatch: expected ${expectedDigest}, got ${candidate.catalogDigest}`);
  }
  if (stableJson(candidate.products) !== stableJson(catalog.products)) {
    throw error("candidate products do not exactly match the checked-out publication catalog");
  }

  const presentDeclared = new Set();
  for (const carrier of candidate.carriers) {
    const expected = resolveActualCarrier(catalog, carrier.ecosystem, carrier.name, "publication-lock validation");
    const actualIdentity = {
      id: carrier.id,
      product: carrier.product,
      version: carrier.version,
      ecosystem: carrier.ecosystem,
      name: carrier.name,
      role: carrier.role,
      target: carrier.target,
      declared: carrier.declared,
      parentCarrier: carrier.parentCarrier ?? null,
      part: carrier.part ?? null,
    };
    const expectedIdentity = {
      id: expected.id,
      product: expected.product,
      version: expected.version,
      ecosystem: expected.ecosystem,
      name: expected.name,
      role: expected.role,
      target: expected.target,
      declared: expected.declared,
      parentCarrier: expected.parentCarrier ?? null,
      part: expected.part ?? null,
    };
    if (stableJson(actualIdentity) !== stableJson(expectedIdentity)) {
      throw error(`carrier ${carrier.id} identity metadata does not match the publication catalog`);
    }
    if (carrier.declared) {
      presentDeclared.add(carrier.id);
    }
  }
  const expectedMissing = catalog.carriers
    .map((carrier) => carrier.id)
    .filter((id) => !presentDeclared.has(id))
    .sort(compareText);
  if (stableJson(candidate.missing) !== stableJson(expectedMissing)) {
    throw error(`candidate missing carrier set mismatch: expected=${JSON.stringify(expectedMissing)}, actual=${JSON.stringify(candidate.missing)}`);
  }
}

function validateProductArtifactInventory(product, artifacts) {
  if (product.kind === "exact-extension-artifact") {
    const expectedMetadata = [
      `${product.id}-${product.version}-manifest.json`,
      `${product.id}-${product.version}-manifest.properties`,
      `${product.id}-${product.version}-release-assets.sha256`,
    ].sort(compareText);
    const metadata = artifacts
      .filter((artifact) => artifact.role === "github-release-metadata")
      .map((artifact) => artifact.name)
      .sort(compareText);
    if (stableJson(expectedMetadata) !== stableJson(metadata)) {
      throw error(`${product.id} frozen release metadata set is incomplete or contains extras`);
    }
    const declaredTargets = extensionArtifactTargets({ product: product.id, publishedOnly: true }, "publication-lock")
      .map((target) => [`${target.family}:${target.target}`, target])
      .sort(([left], [right]) => compareText(left, right));
    const familyByTarget = new Map(declaredTargets.map(([, target]) => [target.target, target.family]));
    const publicAssets = artifacts.filter((artifact) => artifact.role === "github-release-asset");
    const actualKeys = publicAssets.map((artifact) => {
      const family = familyByTarget.get(artifact.target);
      if (family === undefined || !extensionAssetKindAllowed(family, artifact.target, artifact.kind)) {
        throw error(`${product.id} frozen release asset ${artifact.name} has an undeclared target or kind`);
      }
      const canonicalName = canonicalExtensionAssetName(product, {
        family,
        target: artifact.target,
        kind: artifact.kind,
        identity: artifact.identity,
      });
      if (artifact.name !== canonicalName) {
        throw error(`${product.id} frozen release asset ${artifact.name} is not canonical ${canonicalName}`);
      }
      return `${family}:${artifact.target}:${artifact.kind}${artifact.identity === null ? "" : `:${artifact.identity}`}`;
    }).sort(compareText);
    const expectedKeys = extensionRequiredAssetKeys(product.id);
    if (stableJson(expectedKeys) !== stableJson(actualKeys)) {
      throw error(`${product.id} frozen release assets do not cover every declared target role exactly`);
    }
    if (artifacts.length !== metadata.length + publicAssets.length) {
      throw error(`${product.id} frozen product artifact inventory contains an unsupported role`);
    }
    return;
  }

  const targets = allArtifactTargets({
    product: product.id,
    surface: "github-release",
    publishedOnly: true,
  }, "publication-lock");
  const expected = targets.map((target) => `github-release:${target.asset.replaceAll("{version}", product.version)}`);
  if (product.id === "oliphaunt-swift") {
    expected.push(
      "release-input:Oliphaunt-source.zip",
      "release-input:Package.swift.release",
      "release-input:oliphaunt-react-native-ios-carriers.json",
      "release-input:render-extension-products.mjs",
      "release-input:swift-carrier-resolver.mjs",
      "release-input:swiftpm-extension-input.schema.json",
      "release-input:swiftpm-release-tree",
    );
    if (artifacts.some((artifact) => artifact.id === "release-input:swiftpm-extension-consumer-fixture")) {
      expected.push("release-input:swiftpm-extension-consumer-fixture");
    }
  }
  if (product.id === "oliphaunt-react-native") {
    expected.push("release-input:oliphaunt-react-native-ios-carriers.json");
  }
  expected.sort(compareText);
  const actual = artifacts.map((artifact) => artifact.id).sort(compareText);
  if (stableJson(expected) !== stableJson(actual)) {
    throw error(`${product.id} frozen product artifact inventory mismatch: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
  }
}

export function validatePublicationCandidate(candidate) {
  requireObject(candidate, "candidate");
  if (candidate.schema !== PUBLICATION_CANDIDATE_SCHEMA) {
    throw error(`candidate schema must be ${PUBLICATION_CANDIDATE_SCHEMA}`);
  }
  if (candidate.catalogSchema !== PUBLICATION_CATALOG_SCHEMA) {
    throw error(`candidate catalogSchema must be ${PUBLICATION_CATALOG_SCHEMA}`);
  }
  assertHash(candidate.catalogDigest, "candidate.catalogDigest");
  assertHash(candidate.packageEnvelopeDigest, "candidate.packageEnvelopeDigest");
  requireObject(candidate.source, "candidate.source");
  if (!/^[0-9a-f]{40}$/u.test(candidate.source.commit) || !/^[0-9a-f]{40}$/u.test(candidate.source.tree)) {
    throw error("candidate source must contain full commit and tree SHAs");
  }
  if (!Array.isArray(candidate.products) || !Array.isArray(candidate.carriers) || !Array.isArray(candidate.productArtifacts) || !Array.isArray(candidate.missing)) {
    throw error("candidate products, carriers, productArtifacts, and missing must be lists");
  }
  const products = new Map();
  for (const [index, product] of candidate.products.entries()) {
    requireObject(product, `candidate product ${index}`);
    assertNonEmptyString(product.id, `candidate product ${index}.id`);
    assertNonEmptyString(product.kind, `${product.id}.kind`);
    assertNonEmptyString(product.path, `${product.id}.path`);
    assertNonEmptyString(product.version, `${product.id}.version`);
    assertSortedUniqueStrings(product.publishTargets, `${product.id}.publishTargets`);
    assertSortedUniqueStrings(product.dependencies, `${product.id}.dependencies`);
    if (products.has(product.id)) {
      throw error(`candidate contains duplicate product ${product.id}`);
    }
    products.set(product.id, product);
  }
  assertSortedUniqueStrings(candidate.missing, "candidate.missing");
  const identities = new Set();
  for (const carrier of candidate.carriers) {
    requireObject(carrier, "candidate carrier");
    assertNonEmptyString(carrier.id, "candidate carrier.id");
    assertNonEmptyString(carrier.product, `${carrier.id}.product`);
    assertNonEmptyString(carrier.version, `${carrier.id}.version`);
    assertNonEmptyString(carrier.ecosystem, `${carrier.id}.ecosystem`);
    assertNonEmptyString(carrier.name, `${carrier.id}.name`);
    assertNonEmptyString(carrier.role, `${carrier.id}.role`);
    if (!ECOSYSTEM_ORDER.has(carrier.ecosystem)) {
      throw error(`${carrier.id} has unsupported ecosystem ${carrier.ecosystem}`);
    }
    if (!ROLE_ORDER.has(carrier.role)) {
      throw error(`${carrier.id} has unsupported role ${carrier.role}`);
    }
    if (carrier.id !== `${carrier.ecosystem}:${carrier.name}`) {
      throw error(`${carrier.id} is not the canonical ${carrier.ecosystem}:${carrier.name} identity`);
    }
    if (!(carrier.target === null || typeof carrier.target === "string" && carrier.target.length > 0)) {
      throw error(`${carrier.id}.target must be null or a non-empty string`);
    }
    if (typeof carrier.declared !== "boolean") {
      throw error(`${carrier.id}.declared must be boolean`);
    }
    if (!Number.isSafeInteger(carrier.publishOrder) || carrier.publishOrder < 0) {
      throw error(`${carrier.id}.publishOrder must be a non-negative safe integer`);
    }
    if (identities.has(carrier.id)) {
      throw error(`candidate contains duplicate carrier ${carrier.id}`);
    }
    identities.add(carrier.id);
    if (!products.has(carrier.product)) {
      throw error(`carrier ${carrier.id} refers to unknown product ${carrier.product}`);
    }
    if (carrier.version !== products.get(carrier.product).version) {
      throw error(`carrier ${carrier.id} version does not match product ${carrier.product}`);
    }
    if (!Array.isArray(carrier.dependencies) || !Array.isArray(carrier.packageDependencies) || !Array.isArray(carrier.artifacts) || carrier.artifacts.length === 0) {
      throw error(`carrier ${carrier.id} must contain dependency and artifact lists`);
    }
    assertSortedUniqueStrings(carrier.dependencies, `${carrier.id}.dependencies`);
    for (const [index, dependency] of carrier.packageDependencies.entries()) {
      requireObject(dependency, `${carrier.id}.packageDependencies[${index}]`);
      assertNonEmptyString(dependency.ecosystem, `${carrier.id}.packageDependencies[${index}].ecosystem`);
      assertNonEmptyString(dependency.name, `${carrier.id}.packageDependencies[${index}].name`);
      assertNonEmptyString(dependency.requirement, `${carrier.id}.packageDependencies[${index}].requirement`);
      assertNonEmptyString(dependency.scope, `${carrier.id}.packageDependencies[${index}].scope`);
      if (!ECOSYSTEM_ORDER.has(dependency.ecosystem)) {
        throw error(`${carrier.id}.packageDependencies[${index}] has unsupported ecosystem ${dependency.ecosystem}`);
      }
    }
    const artifactPaths = new Set();
    for (const artifact of carrier.artifacts) {
      requireObject(artifact, `${carrier.id} artifact`);
      assertHash(artifact.sha256, `${carrier.id} artifact sha256`);
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || typeof artifact.path !== "string" || artifact.path.length === 0) {
        throw error(`${carrier.id} contains invalid artifact metadata`);
      }
      if (artifactPaths.has(artifact.path)) {
        throw error(`${carrier.id} contains duplicate artifact path ${artifact.path}`);
      }
      artifactPaths.add(artifact.path);
    }
  }
  const publishOrders = candidate.carriers.map((carrier) => carrier.publishOrder);
  const expectedPublishOrders = candidate.carriers.map((_, index) => index);
  if (stableJson(publishOrders) !== stableJson(expectedPublishOrders)) {
    throw error("candidate carriers must be stored in one contiguous, unique publishOrder sequence");
  }
  const carrierPosition = new Map(candidate.carriers.map((carrier, index) => [carrier.id, index]));
  for (const [index, carrier] of candidate.carriers.entries()) {
    const expectedDependencies = internalDependencyIds(candidate.carriers, carrier.packageDependencies);
    if (stableJson(carrier.dependencies) !== stableJson(expectedDependencies)) {
      throw error(`${carrier.id}.dependencies do not match its internal package dependency identities`);
    }
    for (const dependency of carrier.dependencies) {
      const position = carrierPosition.get(dependency);
      if (position === undefined) {
        throw error(`${carrier.id} refers to unknown carrier dependency ${dependency}`);
      }
      if (position >= index) {
        throw error(`${carrier.id} publishOrder precedes dependency ${dependency}`);
      }
    }
  }
  validateCandidateCatalog(candidate);
  const productArtifactIds = new Set();
  for (const artifact of candidate.productArtifacts) {
    const id = `${artifact.product}:${artifact.id}`;
    if (productArtifactIds.has(id) || !products.has(artifact.product)) {
      throw error(`candidate contains duplicate or unknown product artifact ${id}`);
    }
    productArtifactIds.add(id);
    if (
      typeof artifact.id !== "string"
      || artifact.id.length === 0
      || typeof artifact.role !== "string"
      || artifact.role.length === 0
      || typeof artifact.kind !== "string"
      || artifact.kind.length === 0
      || !((typeof artifact.target === "string" && artifact.target.length > 0) || artifact.target === null)
      || !(artifact.identity === null || typeof artifact.identity === "string" && artifact.identity.length > 0)
      || typeof artifact.name !== "string"
      || artifact.name.length === 0
      || path.basename(artifact.name) !== artifact.name
    ) {
      throw error(`${id} contains invalid canonical product artifact metadata`);
    }
    assertHash(artifact.sha256, `${id} sha256`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw error(`${id} contains invalid artifact metadata`);
    }
  }
  for (const product of candidate.products) {
    validateProductArtifactInventory(
      product,
      candidate.productArtifacts.filter((artifact) => artifact.product === product.id),
    );
  }
  const expectedEnvelope = digestValue({
    carriers: candidate.carriers.map(carrierEnvelope),
    productArtifacts: candidate.productArtifacts.map(productArtifactEnvelope),
  });
  if (candidate.packageEnvelopeDigest !== expectedEnvelope) {
    throw error(`candidate packageEnvelopeDigest mismatch: expected ${expectedEnvelope}, got ${candidate.packageEnvelopeDigest}`);
  }
  return candidate;
}

export function validatePublicationLock(lock) {
  requireObject(lock, "publication lock");
  if (lock.schema !== PUBLICATION_LOCK_SCHEMA) {
    throw error(`publication lock schema must be ${PUBLICATION_LOCK_SCHEMA}`);
  }
  const candidate = { ...structuredClone(lock), schema: PUBLICATION_CANDIDATE_SCHEMA, missing: [] };
  delete candidate.lockDigest;
  validatePublicationCandidate(candidate);
  assertHash(lock.lockDigest, "publication lock lockDigest");
  const expected = digestValue(withoutDigest(lock));
  if (lock.lockDigest !== expected) {
    throw error(`publication lock digest mismatch: expected ${expected}, got ${lock.lockDigest}`);
  }
  return lock;
}

export function loadPublicationLock(file = DEFAULT_PUBLICATION_LOCK) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw error(`cannot read publication lock ${rel(file)}: ${cause.message}`);
  }
  return validatePublicationLock(lock);
}

export function assertPublicationLockSource(lock, headRef = "HEAD") {
  const source = sourceIdentity(headRef);
  if (lock.source.commit !== source.commit || lock.source.tree !== source.tree) {
    throw error(`publication lock source ${lock.source.commit}/${lock.source.tree} does not match ${headRef} ${source.commit}/${source.tree}`);
  }
  return source;
}

export function lockedCarriers(lock, { product = undefined, products = undefined, ecosystem = undefined } = {}) {
  const productSet = products === undefined ? undefined : new Set(products);
  return lock.carriers.filter((carrier) =>
    (product === undefined || carrier.product === product)
    && (productSet === undefined || productSet.has(carrier.product))
    && (ecosystem === undefined || carrier.ecosystem === ecosystem));
}

function lockedWorkspaceFile(artifact, context) {
  const file = path.resolve(ROOT, artifact.path);
  const relative = path.relative(ROOT, file);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw error(`${context} artifact path must remain inside the repository: ${artifact.path}`);
  }
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    throw error(`${context} frozen artifact is missing: ${artifact.path}: ${cause.message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw error(`${context} frozen artifact must be a regular non-symlink file: ${artifact.path}`);
  }
  if (metadata.size !== artifact.size || sha256File(file) !== artifact.sha256) {
    throw error(`${context} frozen artifact bytes do not match the publication lock: ${artifact.path}`);
  }
  return file;
}

export function lockedCarrierFiles(lock, ecosystem, name) {
  const matches = lockedCarriers(lock, { ecosystem }).filter((carrier) => carrier.name === name);
  if (matches.length !== 1) {
    throw error(`expected exactly one frozen ${ecosystem}:${name} carrier, found ${matches.length}`);
  }
  const carrier = matches[0];
  return {
    carrier,
    files: carrier.artifacts.map((artifact) => ({
      artifact,
      file: lockedWorkspaceFile(artifact, carrier.id),
    })),
  };
}

export function lockedCarrierFile(lock, ecosystem, name, suppliedPath = undefined) {
  const { carrier, files } = lockedCarrierFiles(lock, ecosystem, name);
  if (carrier.artifacts.length !== 1) {
    throw error(`${carrier.id} must have exactly one publishable file, found ${carrier.artifacts.length}`);
  }
  const file = files[0].file;
  if (suppliedPath !== undefined && path.resolve(ROOT, suppliedPath) !== file) {
    throw error(
      `${carrier.id} publisher attempted to substitute ${rel(path.resolve(ROOT, suppliedPath))} for frozen ${carrier.artifacts[0].path}`,
    );
  }
  return { carrier, file };
}

export function lockedCarrierDirectory(lock, ecosystem, name, suppliedPath = undefined) {
  const matches = lockedCarriers(lock, { ecosystem }).filter((carrier) => carrier.name === name);
  if (matches.length !== 1) {
    throw error(`expected exactly one frozen ${ecosystem}:${name} carrier, found ${matches.length}`);
  }
  const carrier = matches[0];
  if (carrier.artifacts.length !== 1) {
    throw error(`${carrier.id} must have exactly one publishable directory, found ${carrier.artifacts.length}`);
  }
  const artifact = carrier.artifacts[0];
  const directory = path.resolve(ROOT, artifact.path);
  const relative = path.relative(ROOT, directory);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw error(`${carrier.id} artifact path must remain inside the repository: ${artifact.path}`);
  }
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    throw error(`${carrier.id} frozen directory is missing: ${artifact.path}: ${cause.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw error(`${carrier.id} frozen artifact must be a regular non-symlink directory: ${artifact.path}`);
  }
  const observed = directoryEnvelope(directory);
  if (observed.sha256 !== artifact.sha256 || observed.size !== artifact.size) {
    throw error(`${carrier.id} frozen directory bytes do not match the publication lock: ${artifact.path}`);
  }
  if (suppliedPath !== undefined && path.resolve(ROOT, suppliedPath) !== directory) {
    throw error(`${carrier.id} publisher attempted to substitute ${rel(path.resolve(ROOT, suppliedPath))} for frozen ${artifact.path}`);
  }
  return { carrier, directory };
}

export function assertLockedIdentitySet(lock, actual, { product, products, ecosystem } = {}) {
  const expected = lockedCarriers(lock, { product, products, ecosystem }).map((carrier) => `${carrier.ecosystem}:${carrier.name}@${carrier.version}`).sort(compareText);
  const observed = actual.map((item) => `${item.ecosystem ?? ecosystem}:${item.name}@${item.version}`).sort(compareText);
  if (stableJson(expected) !== stableJson(observed)) {
    throw error(`frozen carrier set mismatch for ${product ?? products?.join(",") ?? "all products"}/${ecosystem ?? "all ecosystems"}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(observed)}`);
  }
}

export function assertLockedArtifactSet(lock, actual, { product, products, ecosystem } = {}) {
  assertLockedIdentitySet(lock, actual, { product, products, ecosystem });
  const expected = new Map(lockedCarriers(lock, { product, products, ecosystem }).map((carrier) => [carrier.id, carrier]));
  for (const record of actual) {
    const id = `${record.ecosystem}:${record.name}`;
    const frozen = expected.get(id);
    if (frozen === undefined || !Array.isArray(record.artifacts)) {
      throw error(`actual artifact record ${id} is absent from the frozen lock or has no byte envelope`);
    }
    const frozenBytes = frozen.artifacts.map(({ sha256, size }) => `${sha256}:${size}`).sort(compareText);
    const actualBytes = record.artifacts.map(({ sha256, size }) => `${sha256}:${size}`).sort(compareText);
    if (stableJson(frozenBytes) !== stableJson(actualBytes)) {
      throw error(`frozen artifact bytes mismatch for ${id}: expected=${JSON.stringify(frozenBytes)}, actual=${JSON.stringify(actualBytes)}`);
    }
  }
}

export function assertLockedProductArtifacts(lock, product, roots) {
  const expected = lock.productArtifacts.filter((artifact) => artifact.product === product);
  const productRow = lock.products.find((row) => row.id === product);
  if (productRow === undefined) {
    throw error(`publication lock does not select product ${product}`);
  }
  const actual = discoverProductArtifacts(roots, [productRow]);
  const envelope = (artifacts) => artifacts
    .map(({ product: owner, id, role, kind, target, identity, name, sha256, size }) =>
      `${owner}:${id}:${role}:${kind}:${target ?? ""}:${identity ?? ""}:${name}:${sha256}:${size}`)
    .sort(compareText);
  if (stableJson(envelope(expected)) !== stableJson(envelope(actual))) {
    throw error(`frozen product artifact bytes mismatch for ${product}: expected=${JSON.stringify(envelope(expected))}, actual=${JSON.stringify(envelope(actual))}`);
  }
}

export function lockedProductArtifactPaths(lock, product, { role = undefined, kind = undefined } = {}) {
  const selected = lock.productArtifacts.filter((artifact) =>
    artifact.product === product
    && (role === undefined || artifact.role === role)
    && (kind === undefined || artifact.kind === kind));
  return selected.map((artifact) => {
    const value = path.resolve(ROOT, artifact.path);
    const relative = path.relative(ROOT, value);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw error(`${product}:${artifact.id} path must remain inside the repository: ${artifact.path}`);
    }
    let stat;
    try {
      stat = lstatSync(value);
    } catch (cause) {
      throw error(`${product}:${artifact.id} is missing: ${artifact.path}: ${cause.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw error(`${product}:${artifact.id} must not be a symlink: ${artifact.path}`);
    }
    const observed = stat.isFile()
      ? { sha256: sha256File(value), size: stat.size }
      : stat.isDirectory()
        ? directoryEnvelope(value)
        : null;
    if (observed === null || observed.sha256 !== artifact.sha256 || observed.size !== artifact.size) {
      throw error(`${product}:${artifact.id} bytes do not match the publication lock: ${artifact.path}`);
    }
    return { artifact, path: value, type: stat.isFile() ? "file" : "directory" };
  });
}

function parseArgs(argv) {
  const command = argv.shift();
  const values = new Map();
  const repeated = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-missing") {
      booleans.add("allow-missing");
      continue;
    }
    if (!arg.startsWith("--")) {
      throw error(`unexpected positional argument ${arg}`);
    }
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    const value = separator === -1 ? argv[++index] : arg.slice(separator + 1);
    if (value === undefined) {
      throw error(`--${key} requires a value`);
    }
    if (key === "artifact-root") {
      repeated.set(key, [...(repeated.get(key) ?? []), value]);
    } else {
      values.set(key, value);
    }
  }
  return { command, values, repeated, booleans };
}

function productsFlag(values) {
  const raw = values.get("products-json");
  if (raw === undefined) {
    return undefined;
  }
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw error("--products-json must be a non-empty JSON string list");
  }
  return value;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv) {
  const { command, values, repeated, booleans } = parseArgs([...argv]);
  if (command === "candidate" || command === "create") {
    const candidate = buildPublicationCandidate({
      products: productsFlag(values),
      artifactRoots: repeated.get("artifact-root") ?? [],
      headRef: values.get("head-ref") ?? "HEAD",
      allowMissing: command === "candidate" && booleans.has("allow-missing"),
    });
    const output = path.resolve(ROOT, values.get("output") ?? (command === "create" ? DEFAULT_PUBLICATION_LOCK : "target/release/publication-candidate.json"));
    const value = command === "create" ? freezePublicationCandidate(candidate) : candidate;
    writeJson(output, value);
    console.log(`${rel(output)}\t${value.packageEnvelopeDigest}\t${value.lockDigest ?? "candidate"}`);
    return;
  }
  if (command === "freeze") {
    const input = path.resolve(ROOT, values.get("candidate") ?? "target/release/publication-candidate.json");
    const candidate = JSON.parse(readFileSync(input, "utf8"));
    const lock = freezePublicationCandidate(candidate);
    const output = path.resolve(ROOT, values.get("output") ?? DEFAULT_PUBLICATION_LOCK);
    writeJson(output, lock);
    console.log(`${rel(output)}\t${lock.packageEnvelopeDigest}\t${lock.lockDigest}`);
    return;
  }
  if (command === "verify") {
    const file = path.resolve(ROOT, values.get("lock") ?? DEFAULT_PUBLICATION_LOCK);
    const lock = loadPublicationLock(file);
    assertPublicationLockSource(lock, values.get("head-ref") ?? "HEAD");
    console.log(`${rel(file)} publication lock verified (${lock.carriers.length} carriers, envelope ${lock.packageEnvelopeDigest})`);
    return;
  }
  console.log("usage: tools/release/publication-lock.mjs <candidate|create|freeze|verify> [--products-json JSON] [--artifact-root PATH ...] [--head-ref REF] [--output PATH] [--allow-missing]");
  process.exit(command === "-h" || command === "--help" ? 0 : 2);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
